/**
 * Dispatch authority for intake, D1 triage and D2 route (WV-S1 P3a).
 *
 * Pure transitions return observations and dispatch nothing. This composition
 * is the only holder of the dispatch port: it journals the intent before the
 * call, maps the receipt to a closed decision record, and emits the existing
 * `judgment` kind for every fresh site observation, followed by `dispatch.decided`
 * carrying the versioned Decide-1 trace for each decision it appended.
 */
import {
  QUALITY_BARS,
  qualityClears,
  type EvaluationOutcome,
  type GenerationOutcome,
  type InferenceGateway,
  type InferenceTerms,
} from '@weave/gateway';
import {
  INTAKE_EXTRACT_SITE,
  decideIntake,
  intakeExtractSchema,
  transitionIntake,
  type IntakeDecision,
  type RecordedExtract,
} from './intake.js';
import {
  decideLoopRoute,
  decideTriage,
  LOOP_DECISION_REQUESTS,
  transitionLoopDecision,
  type LoopDecision,
  type LoopDecisionAsk,
  type LoopDecisionSite,
} from './sites/loop-decide.js';
import { validExtractObservation, type ExtractObservation, type ExtractSchema } from './sites/extract.js';
import { stableStringify } from './stable-json.js';
import { modelExtractSchema } from './sites/model-extract.js';
import {
  SITE_POLICY,
  correlation,
  unit,
  type IntakeSiteInput,
  type IntakeState,
  type RecordedSiteAnswer,
  type SiteChoice,
  type SiteObservation,
  type SiteReason,
  type SiteState,
} from './sites/index.js';
import {
  DECIDE1_RULE_TABLE,
  decideBand,
  type Decide1Inputs,
  type Decide1Trace,
  type Decide1Fact,
  type Decide1Judgment,
} from './decide1.js';
import {
  DECIDE1_SHADOW_JUDGMENTS,
  DECIDE1_SHADOW_QUESTIONS,
  askShadow,
  type ShadowAsk,
  type ShadowObservation,
} from './sites/decide1-shadow.js';
import { digest } from './digest.js';
import { TARGET_ROLES, preflightPlan, validatePlan, type ChildBrief, type SpawnPlan } from './spawn.js';
import {
  askRoles,
  maximalTopP,
  rolesAdmitted,
  SPAWN_ROLES_QUESTION,
  type RoleAsk,
  type RoleObservation,
} from './sites/spawn-roles.js';
import type { ImplementTier } from './implement-step.js';
import {
  DECIDE2_ARGS_SCHEMA,
  DECIDE2_ARGS_SITE,
  DECIDE2_SITE,
  decide2ArgsCall,
  decide2ArgsOriginal,
  decide2ArgsSchema,
  decide2Pick,
  decideTool,
  needsSecondExtract,
  plausibleTop,
  transitionDecide2,
  type CatalogueEntry,
  type Decide2Ask,
  type ToolDecision,
} from './sites/decide2.js';
import { modelHints } from './sites/model-extract.js';
import { deliver, type WeftPort, type WeftRecordShape } from './weft.js';

export interface DispatchRequest extends SiteState {
  readonly request_id: string;
  readonly terms: InferenceTerms;
  readonly intake: IntakeState;
  /** Already filtered for disclosure; never copied into a record. */
  readonly triage_context: string;
  readonly route_context: string;
  readonly resume?: boolean;
  /** Closed, already disclosed candidate set. Summaries are never recorded. */
  readonly targets?: readonly { readonly ref: string; readonly summary: string }[];
  /** P4c: the disclosed M6 catalogue index Decide-2 picks from (at most 8 entries). Purposes are never recorded. */
  readonly catalogue?: readonly CatalogueEntry[];
  /**
   * P5c1 re-entry: one exact sealed brief of a journaled root spawn. Then `request_id` is its
   * `child_ref`, `intake.message` is the only goal input, and threads, contexts and targets are empty.
   */
  readonly child?: { readonly brief: ChildBrief };
}

/** One sealed `depends_on` edge as the journal held it when the join froze; nulls where absent. */
export interface DispatchDependency {
  readonly decision_ref: string;
  readonly entry: number | null;
  readonly decision_digest: string | null;
  readonly dispatch_ref: string | null;
  readonly receipt: DispatchReceipt | null;
}

/** `dispatch.child@1`: the verified lineage, terms binding and joined evidence of one child decision. */
export interface DispatchChild {
  readonly schema: 'dispatch.child@1';
  readonly parent_ref: string;
  readonly parent_entry: number;
  readonly plan_digest: string;
  readonly brief: ChildBrief;
  readonly terms_digest: string;
  /** Reads: `[]`. A generator: null until its join is satisfied or terminally unmet. */
  readonly dependencies: readonly DispatchDependency[] | null;
  readonly dependencies_digest: string | null;
}

/** Explicit historical evidence for a child: its root parent's journal and each frozen read snapshot. */
export interface ChildEvidence {
  readonly parent: { readonly checkpoint: DispatchCheckpoint | null; readonly decisions: readonly DispatchDecision[] };
  /** In sealed `depends_on` order, the decision each frozen edge names; null for a null edge. */
  readonly reads: readonly (DispatchDecision | null)[];
}

/** A completed, immutable read: `revision` is opaque, `digest` hashes the bytes, `bytes` is port-measured. */
export interface ReadResult {
  readonly target_ref: string;
  readonly revision: string;
  readonly digest: string;
  readonly bytes: number;
}

export type DispatchIntent =
  | {
      readonly kind: 'implement';
      readonly dispatch_id: string;
      readonly tier: ImplementTier;
      readonly ceiling: ImplementTier;
      readonly tier_source: 'route' | 'route_fallback' | 'triage_fallback';
    }
  | {
      readonly kind: 'implement';
      readonly dispatch_id: string;
      readonly tier: ImplementTier;
      readonly ceiling: ImplementTier;
      readonly tier_source: 'child_route' | 'child_route_fallback';
      /**
       * P5c3: the child's share remainder (`custodyOf(checkpoint).remainder`) at claim. Every gateway
       * request the implement step makes for this intent draws on it; it is never refilled.
       */
      readonly budget: number;
      /** Equal to the claimed `checkpoint.child`: the adapter resolves only its joined reads. */
      readonly child: DispatchChild;
    }
  | {
      /** P4c `gen.no_tool_margin`: generation over the full disclosed index named by `catalogue_digest`. */
      readonly kind: 'implement';
      readonly dispatch_id: string;
      readonly tier: ImplementTier;
      readonly ceiling: ImplementTier;
      readonly tier_source: 'no_tool_margin';
      readonly catalogue_digest: string;
    }
  | {
      readonly kind: 'read';
      readonly dispatch_id: string;
      readonly target_ref: string;
      readonly child: DispatchChild;
    }
  | {
      /** P4c `act.tool`: the one entry Decide-2 picked, from the catalogue bound at its ask. */
      readonly kind: 'capability';
      readonly dispatch_id: string;
      readonly entry_ref: string;
      readonly catalogue_digest: string;
      /** Digest of the args record (the original's digest and the final extract@1); null for a zero-arg entry. */
      readonly args_ref: string | null;
    }
  | { readonly kind: 'done_check'; readonly dispatch_id: string }
  | { readonly kind: 'decline'; readonly dispatch_id: string }
  | {
      readonly kind: 'thread';
      readonly dispatch_id: string;
      readonly relation: 'continue_thread' | 'steer' | 'queue' | 'interrupt';
      readonly thread_ref: string;
    }
  | {
      readonly kind: 'spawn';
      readonly dispatch_id: string;
      /** Disclosed refs in request order; summaries are never carried. */
      readonly targets: readonly string[];
      /** `validatePlan(plan, targets)` holds: refs, codes, numbers and digests only. */
      readonly plan: SpawnPlan;
      /** Digest of the admitted role observation, so the claim binds every role field, not only the roles. */
      readonly roles_digest: string;
    };
export type SpawnIntent = Extract<DispatchIntent, { readonly kind: 'spawn' }>;
export type DispatchChoice = SiteChoice | 'spawn' | 'read';

export type DispatchReceipt =
  | { readonly status: 'dispatched'; readonly dispatch_id: string; readonly ref: string }
  /** The only confirmation of a read intent; queue admission is not completion. */
  | { readonly status: 'dispatched'; readonly dispatch_id: string; readonly ref: string; readonly read: ReadResult }
  | {
      readonly status: 'refused';
      readonly dispatch_id: string;
      readonly reason: 'approval_required' | 'budget' | 'no_grant' | 'unknown_target' | 'conflict';
    };

export type DispatchReason =
  | SiteReason
  | 'ambiguous_reference'
  | 'no_target'
  | 'irreversible'
  | 'approval_required'
  | 'budget'
  | 'refused'
  | 'dispatch_unconfirmed'
  /** P4c: Decide-2 had no clear margin; generation runs over the full disclosed index. */
  | 'no_tool_margin'
  /** P4c: the picked entry has a required arg the targeted extract did not ground. */
  | 'missing_args'
  /** Transient: never journaled or emitted. */
  | 'dependency_pending'
  | 'unmet_dependency'
  /** P5c3: a generate child's share cannot cover the D2 ask it would have to take. Terminal. */
  | 'share_exhausted';

export interface DispatchCheckpoint {
  readonly schema: 'dispatch.checkpoint@6';
  readonly decision_id: string;
  readonly state_revision: number;
  readonly state_updated_at: number;
  readonly asks: {
    readonly intake: number;
    readonly triage: number;
    readonly route: number;
    readonly tool: number;
    readonly shadow: 0 | 1;
    readonly preflight: 0 | 1;
  };
  readonly intake: IntakeDecision | null;
  readonly triage: LoopDecision | null;
  readonly route: LoopDecision | null;
  /** P4c Decide-2 pick and targeted args extract; null until the tool stage is asked. */
  readonly tool: ToolDecision | null;
  /** Digest of the catalogue the tool ask disclosed, bound with `asks.tool`; drift on replay is refused. */
  readonly catalogue_digest: string | null;
  readonly shadow: readonly ShadowObservation[] | null;
  readonly preflight: RoleObservation | null;
  /** The asking request's `terms.cost_ceiling` when a safe natural, bound with `asks.preflight = 1`. */
  readonly preflight_budget: number | null;
  /** Whether this call's composition injected `ports.spawn`; frozen by claim. */
  readonly spawn_port: boolean;
  /** A root's detached request terms, fixed with `asks.preflight = 1`; null otherwise. */
  readonly preflight_terms: InferenceTerms | null;
  /** A child's admitted narrowed terms; frozen by its claim. Null on a root. */
  readonly child_terms: InferenceTerms | null;
  readonly child: DispatchChild | null;
  readonly intent: DispatchIntent | null;
}

export interface DispatchDecision {
  readonly schema: 'dispatch.decision@7';
  readonly decision_id: string;
  readonly entry: number;
  readonly state_revision: number;
  readonly decided_by: 'intake' | 'triage' | 'route' | 'rule';
  readonly choice: DispatchChoice;
  readonly status: 'dispatched' | 'needs_human' | 'paused' | 'refused';
  readonly reason: DispatchReason;
  readonly rule_table: typeof DECIDE1_RULE_TABLE;
  readonly decide1: Omit<Decide1Trace, 'table'>;
  readonly child: DispatchChild | null;
  readonly intent: DispatchIntent | null;
  readonly receipt: DispatchReceipt | null;
  readonly intake: IntakeDecision | null;
  readonly triage: LoopDecision | null;
  readonly route: LoopDecision | null;
  readonly tool: ToolDecision | null;
  readonly shadow: readonly ShadowObservation[] | null;
  readonly preflight: RoleObservation | null;
}

/** The stage an in-flight ask belongs to; `window` is the shadow and preflight round. */
export type DispatchAskStage = 'intake' | 'triage' | 'route' | 'tool' | 'window';
export interface DispatchAsk {
  readonly stage: DispatchAskStage;
  /** The checkpoint's ask counter for the stage once taken; the window counts its shadow and preflight asks together. */
  readonly ask: number;
}

/**
 * The single phase of one decision id, stored in the same record as its checkpoint and decisions:
 * - `open`: no intent claimed. `ask` is the one stage ask in flight, if any; only `record` ends it.
 * - `claimed`: the intent is bound and nothing is presented since its last receipt.
 * - `presented`: an attempt presented the intent and no receipt has been journaled since.
 * - `terminal`: a non-resumable decision is journaled; `intent` is the claimed intent it closed, if any.
 * `attempt` is the live attempt on a claimed or presented intent.
 */
export type DispatchSlot =
  | { readonly phase: 'open'; readonly ask: DispatchAsk | null }
  | { readonly phase: 'claimed'; readonly intent: DispatchIntent; readonly attempt: string | null }
  | { readonly phase: 'presented'; readonly intent: DispatchIntent; readonly attempt: string | null }
  | { readonly phase: 'terminal'; readonly intent: DispatchIntent | null };

/** What one `ask` did: took the next ask, joined the one already in flight, or was refused. */
export type DispatchAskResult = 'taken' | 'joined' | null;

/**
 * Each decision id is one single-writer slot (see `DispatchSlot`): open → claimed(intent) | terminal,
 * claimed → presented → claimed (a receipt) | terminal (a decision owning that intent). A resumable
 * pause keeps the phase. `ask`, `record`, `claim`, `acquire`, `present` and `append` are each one
 * atomic compare-and-set on that slot: they return false or null and write nothing when another
 * writer already moved it, and the loser fails closed.
 *
 * At most one stage ask is in flight per decision id. Elapsed time cannot tell a crashed or
 * cancelled asker from a live one, so any caller that would ask that stage joins the in-flight ask
 * id instead of minting the next one, and the first `record` of it wins. Joining does not stop a
 * second site call under the same stage request id; it stops a second ask number.
 *
 * Intent identity is not writer ownership. A claimed intent is presented and settled only by the
 * dispatch attempt that holds it: `acquire` issues that attempt, and while it is live no other
 * caller can acquire, and no decision naming the intent appends except the holder's.
 *
 * Attempt ids are single-use. An attempt ends only when its holder appends or releases it, or when
 * recovery supersedes it on the port's own settlement; elapsed time never ends one. An ended id is
 * retired: it never appends, releases or supersedes again, and is never reissued.
 *
 * A holder records `present` before it calls the port. Until a decision with a receipt is appended
 * the slot stays presented, so recovery reconciles it through the settlement and never pauses it
 * stale, and a presented intent is never journaled as `cancelled`.
 */
export interface DispatchJournal {
  /** The slot, its checkpoint (carrying a claimed intent) and its decisions, read from one record. */
  load(decision_id: string): {
    readonly checkpoint: DispatchCheckpoint | null;
    readonly decisions: readonly DispatchDecision[];
    readonly slot: DispatchSlot;
  };
  /**
   * open → open(ask): `taken` writes `entry`, whose counter for the stage is `ask.ask`, only when no
   * ask is in flight and the stored counter is one below it. `joined`, writing nothing, when that
   * exact ask is already in flight. Otherwise null.
   */
  ask(decision_id: string, ask: DispatchAsk, entry: DispatchCheckpoint): DispatchAskResult;
  /** open(ask) → open: records the asked stage in `entry`, only while that exact ask is in flight. */
  record(decision_id: string, ask: DispatchAsk, entry: DispatchCheckpoint): boolean;
  /** open → claimed, with no ask in flight: bind the intent to the exact stage snapshot the plan was derived from. */
  claim(decision_id: string, intent: DispatchIntent, checkpoint?: DispatchCheckpoint): boolean;
  /**
   * A fresh attempt on a claimed or presented intent; null while another attempt is live. With
   * `supersedes`, only while that attempt is still the live one: it is retired and replaced. Only
   * recovery holding the port's settlement of the decision supersedes.
   */
  acquire(decision_id: string, supersedes?: string): string | null;
  /** Retires the attempt if it is still the live one; any other attempt is left alone. */
  release(decision_id: string, attempt: string): void;
  /** claimed | presented → presented, only while `attempt` is the live one; false writes nothing. */
  present(decision_id: string, attempt: string): boolean;
  /**
   * Appends `decision` as the next entry (`decision.entry` must be one past the stored count).
   * open → open | terminal for an intent-less decision, writing `checkpoint` with it when no ask is
   * in flight and leaving an in-flight ask in place; claimed | presented → claimed (a receipt) |
   * presented (none) | terminal for its owner: the live attempt's own id, or a tokenless caller when
   * none is live. A successful append retires the live attempt. Appending `cancelled` to a presented
   * slot is a defect and throws.
   */
  append(
    decision: DispatchDecision,
    options?: { readonly attempt?: string; readonly checkpoint?: DispatchCheckpoint },
  ): boolean;
}

/** Never receives a spawn intent. */
export type DispatchPort = (
  intent: Exclude<DispatchIntent, SpawnIntent>,
  signal?: AbortSignal,
) => DispatchReceipt | Promise<DispatchReceipt>;

/** Opens every child of the plan or none, idempotently by dispatch_id; never runs a child in P5b. */
export type SpawnPort = (intent: SpawnIntent, signal?: AbortSignal) => DispatchReceipt | Promise<DispatchReceipt>;

/** The idempotent port's own record for a decision id: its receipt once settled, else null. */
export type DispatchSettlementPort = (
  decision_id: string,
  signal?: AbortSignal,
) => DispatchReceipt | null | Promise<DispatchReceipt | null>;

export interface DispatchPorts {
  readonly generate: InferenceGateway['generate'];
  readonly evaluate: InferenceGateway['evaluate'];
  readonly now: () => SiteState & { readonly observed_at: number };
  readonly dispatch: DispatchPort;
  /** Without it, recovery of an attempt in flight stays paused / `dispatch_unconfirmed`. */
  readonly settlement?: DispatchSettlementPort;
  readonly weft?: WeftPort;
  /** Absent: `spawn.port = false`, and `spawn.preflight` cannot match. `settlement` must also cover spawn decisions. */
  readonly spawn?: SpawnPort;
}

export type ThreadTarget =
  | { readonly ok: true; readonly thread_ref: string }
  | { readonly ok: false; readonly reason: 'no_target' | 'ambiguous_reference' };

type Decider = DispatchDecision['decided_by'];
type Plan = { readonly trace: Decide1Trace } & (
  | {
      readonly kind: 'dispatch';
      readonly decided_by: Decider;
      readonly choice: DispatchChoice;
      readonly reason: DispatchReason;
      readonly intent: DispatchIntent;
    }
  | {
      readonly kind: 'final';
      readonly decided_by: Decider;
      readonly choice: DispatchChoice;
      readonly status: 'needs_human' | 'paused' | 'refused';
      readonly reason: DispatchReason;
    }
);

const THREAD_RELATIONS = ['continue_thread', 'steer', 'queue', 'interrupt'] as const;

function isThreadRelation(choice: SiteChoice): choice is (typeof THREAD_RELATIONS)[number] {
  return (THREAD_RELATIONS as readonly string[]).includes(choice);
}
function isTier(choice: SiteChoice): choice is ImplementTier {
  return choice === 'flash' || choice === 'standard' || choice === 'strong';
}
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The stage counter an ask advances; the window counts its shadow and preflight asks together. */
function askCount(checkpoint: DispatchCheckpoint | null, stage: DispatchAskStage): number {
  if (checkpoint === null) return 0;
  return stage === 'window' ? checkpoint.asks.shadow + checkpoint.asks.preflight : checkpoint.asks[stage];
}

function sameAsk(left: DispatchAsk | null, right: DispatchAsk): boolean {
  return left !== null && left.stage === right.stage && left.ask === right.ask;
}

const OPEN: DispatchSlot = { phase: 'open', ask: null };

interface SlotRecord {
  slot: DispatchSlot;
  checkpoint: DispatchCheckpoint | null;
  decisions: DispatchDecision[];
  /** Attempts issued so far; ids are `${decision_id}:attempt:${n}`, so an ended id is never live again. */
  issued: number;
}

/** The slot after `decision` appends: a receipt ends presentation, and any append retires the attempt. */
function nextSlot(slot: DispatchSlot, decision: DispatchDecision): DispatchSlot {
  if (!resumable(decision)) return { phase: 'terminal', intent: intentOf(slot) };
  switch (slot.phase) {
    case 'open':
    case 'terminal':
      return slot;
    case 'claimed':
    case 'presented':
      return { phase: decision.receipt === null ? slot.phase : 'claimed', intent: slot.intent, attempt: null };
    default: {
      const never: never = slot;
      return never;
    }
  }
}

function intentOf(slot: DispatchSlot): DispatchIntent | null {
  return slot.phase === 'open' ? null : slot.intent;
}

function attemptOf(slot: DispatchSlot): string | null {
  return slot.phase === 'claimed' || slot.phase === 'presented' ? slot.attempt : null;
}

export class MemoryDispatchJournal implements DispatchJournal {
  private readonly records = new Map<string, SlotRecord>();

  private open(decision_id: string): SlotRecord {
    let record = this.records.get(decision_id);
    if (record === undefined) {
      record = { slot: OPEN, checkpoint: null, decisions: [], issued: 0 };
      this.records.set(decision_id, record);
    }
    return record;
  }
  load(decision_id: string) {
    const record = this.records.get(decision_id);
    if (record === undefined) return { checkpoint: null, decisions: [], slot: OPEN };
    const { checkpoint, slot } = record;
    const intent = intentOf(slot);
    return {
      checkpoint: checkpoint === null ? null : clone(intent === null ? checkpoint : { ...checkpoint, intent }),
      decisions: clone(record.decisions),
      slot: clone(slot),
    };
  }
  /**
   * Seeds the stage evidence of an open slot with no ask in flight, e.g. a fixture or an import.
   * Not part of `DispatchJournal`: dispatch writes a checkpoint only through `ask`, `record`,
   * `claim` and `append`.
   */
  checkpoint(entry: DispatchCheckpoint): void {
    const record = this.open(entry.decision_id);
    if (record.slot.phase === 'open' && record.slot.ask === null) record.checkpoint = clone({ ...entry, intent: null });
  }
  ask(decision_id: string, ask: DispatchAsk, entry: DispatchCheckpoint): DispatchAskResult {
    if (entry.decision_id !== decision_id) throw new Error('checkpoint belongs to another decision');
    const record = this.open(decision_id);
    const { slot } = record;
    if (slot.phase !== 'open') return null;
    if (slot.ask !== null) return sameAsk(slot.ask, ask) ? 'joined' : null;
    if (askCount(entry, ask.stage) !== ask.ask || askCount(record.checkpoint, ask.stage) >= ask.ask) return null;
    record.checkpoint = clone({ ...entry, intent: null });
    record.slot = { phase: 'open', ask: { stage: ask.stage, ask: ask.ask } };
    return 'taken';
  }
  record(decision_id: string, ask: DispatchAsk, entry: DispatchCheckpoint): boolean {
    if (entry.decision_id !== decision_id) throw new Error('checkpoint belongs to another decision');
    const record = this.records.get(decision_id);
    if (record === undefined || record.slot.phase !== 'open' || !sameAsk(record.slot.ask, ask)) return false;
    if (askCount(entry, ask.stage) !== ask.ask) return false;
    record.checkpoint = clone({ ...entry, intent: null });
    record.slot = OPEN;
    return true;
  }
  claim(decision_id: string, intent: DispatchIntent, snapshot?: DispatchCheckpoint): boolean {
    const record = this.open(decision_id);
    if (record.slot.phase !== 'open' || record.slot.ask !== null) return false;
    const bound = snapshot ?? record.checkpoint;
    if (bound !== null && bound.decision_id !== decision_id)
      throw new Error('claimed intent belongs to another decision');
    if (bound !== null) record.checkpoint = clone({ ...bound, intent: null });
    record.slot = { phase: 'claimed', intent: clone(intent), attempt: null };
    return true;
  }
  /** True only for the live attempt itself; an ended id never matches again. */
  private live(record: SlotRecord | undefined, attempt: string | undefined): boolean {
    return record !== undefined && attempt !== undefined && attemptOf(record.slot) === attempt;
  }
  private holding(record: SlotRecord, attempt: string | null): void {
    const { slot } = record;
    if (slot.phase === 'claimed' || slot.phase === 'presented')
      record.slot = { phase: slot.phase, intent: slot.intent, attempt };
  }
  acquire(decision_id: string, supersedes?: string): string | null {
    const record = this.records.get(decision_id);
    if (record === undefined) return null;
    const { slot } = record;
    if (slot.phase !== 'claimed' && slot.phase !== 'presented') return null;
    if (supersedes === undefined ? slot.attempt !== null : !this.live(record, supersedes)) return null;
    record.issued += 1;
    const attempt = `${decision_id}:attempt:${record.issued}`;
    this.holding(record, attempt);
    return attempt;
  }
  release(decision_id: string, attempt: string): void {
    const record = this.records.get(decision_id);
    if (this.live(record, attempt)) this.holding(record!, null);
  }
  present(decision_id: string, attempt: string): boolean {
    const record = this.records.get(decision_id);
    if (record === undefined || !this.live(record, attempt)) return false;
    const slot = record.slot as Extract<DispatchSlot, { readonly phase: 'claimed' | 'presented' }>;
    record.slot = { phase: 'presented', intent: slot.intent, attempt };
    return true;
  }
  append(
    decision: DispatchDecision,
    options: { readonly attempt?: string; readonly checkpoint?: DispatchCheckpoint } = {},
  ): boolean {
    const { attempt, checkpoint } = options;
    const id = decision.decision_id;
    if (checkpoint !== undefined && checkpoint.decision_id !== id)
      throw new Error('checkpoint belongs to another decision');
    const record = this.open(id);
    const { slot } = record;
    if (slot.phase === 'terminal') return false;
    if (decision.entry !== record.decisions.length + 1) return false;
    if (attempt !== undefined && !this.live(record, attempt)) return false;
    if (slot.phase === 'open') {
      if (decision.intent !== null) throw new Error('appended decision names an intent that was never claimed');
      if (checkpoint !== undefined && slot.ask === null) record.checkpoint = clone({ ...checkpoint, intent: null });
    } else {
      if (decision.intent === null || !sameRecord(decision.intent, slot.intent)) return false;
      if (attempt === undefined && slot.attempt !== null) return false;
      if (slot.phase === 'presented' && decision.reason === 'cancelled')
        throw new Error('a presented intent is never journaled as cancelled');
    }
    record.decisions.push(clone(decision));
    record.slot = nextSlot(slot, decision);
    return true;
  }
}

/** The last grounded thread hint, else the only disclosed thread, else a rule refusal. */
export function resolveThreadTarget(
  intake: IntakeDecision,
  threads: readonly { readonly thread_id: string }[],
): ThreadTarget {
  const disclosed: string[] = [];
  for (const thread of threads) {
    const id = correlation(thread.thread_id);
    if (id !== null && !disclosed.includes(id)) disclosed.push(id);
  }
  const final = intake.extract[intake.extract.length - 1];
  const slot = final?.slots.find((candidate) => candidate.slot === 'thread_ref');
  const hinted =
    final?.verdict === 'use_hints' && slot?.status === 'grounded' && slot.value !== null && slot.value !== 'none'
      ? slot.value
      : null;
  if (hinted !== null && disclosed.includes(hinted)) return { ok: true, thread_ref: hinted };
  if (disclosed.length === 1) return { ok: true, thread_ref: disclosed[0] as string };
  if (disclosed.length === 0) return { ok: false, reason: 'no_target' };
  return { ok: false, reason: 'ambiguous_reference' };
}

function initialCheckpoint(
  request: DispatchRequest,
  ports: DispatchPorts,
  child: DispatchChild | null = null,
): DispatchCheckpoint {
  return {
    schema: 'dispatch.checkpoint@6',
    decision_id: request.request_id,
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    asks: { intake: 0, triage: 0, route: 0, tool: 0, shadow: 0, preflight: 0 },
    intake: null,
    triage: null,
    route: null,
    tool: null,
    catalogue_digest: null,
    shadow: null,
    preflight: null,
    preflight_budget: null,
    spawn_port: ports.spawn !== undefined,
    preflight_terms: null,
    child_terms: child === null ? null : detachTerms(request.terms),
    child,
    intent: null,
  };
}

/** The checkpoint with `patch` applied, rebuilt in the closed key order. */
function makeCheckpoint(checkpoint: DispatchCheckpoint, patch: Partial<DispatchCheckpoint> = {}): DispatchCheckpoint {
  const next = { ...checkpoint, ...patch };
  return {
    schema: 'dispatch.checkpoint@6',
    decision_id: next.decision_id,
    state_revision: next.state_revision,
    state_updated_at: next.state_updated_at,
    asks: {
      intake: next.asks.intake,
      triage: next.asks.triage,
      route: next.asks.route,
      tool: next.asks.tool,
      shadow: next.asks.shadow,
      preflight: next.asks.preflight,
    },
    intake: next.intake,
    triage: next.triage,
    route: next.route,
    tool: next.tool,
    catalogue_digest: next.catalogue_digest,
    shadow: next.shadow,
    preflight: next.preflight,
    preflight_budget: next.preflight_budget,
    spawn_port: next.spawn_port,
    preflight_terms: next.preflight_terms,
    child_terms: next.child_terms,
    child: next.child,
    intent: next.intent,
  };
}

/** A detached copy without undefined-valued keys, so it survives any JSON journal unchanged. */
function detachTerms(terms: InferenceTerms): InferenceTerms {
  return Object.fromEntries(
    Object.entries(clone(terms)).filter(([, value]) => value !== undefined),
  ) as unknown as InferenceTerms;
}

function makeDecision(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  entry: number,
  plan: Plan,
  intent: DispatchIntent | null,
  receipt: DispatchReceipt | null,
  status: DispatchDecision['status'],
  reason: DispatchReason,
): DispatchDecision {
  return {
    schema: 'dispatch.decision@7',
    decision_id: checkpoint.decision_id,
    entry,
    state_revision: checkpoint.state_revision,
    decided_by: plan.decided_by,
    choice: plan.choice,
    status,
    reason,
    rule_table: plan.trace.table,
    decide1: traceFields(plan.trace),
    child: checkpoint.child,
    intent,
    receipt,
    intake: checkpoint.intake,
    triage: checkpoint.triage,
    route: checkpoint.route,
    tool: checkpoint.tool,
    shadow: recordedShadow(checkpoint),
    preflight: trustedRoles(checkpoint, request),
  };
}

function sameState(checkpoint: DispatchCheckpoint, current: SiteState): boolean {
  return (
    checkpoint.state_revision === current.state_revision && checkpoint.state_updated_at === current.state_updated_at
  );
}

function traceFields({ judgments, facts, rule, band }: Decide1Trace): DispatchDecision['decide1'] {
  return clone({ judgments, facts, rule, band });
}

function final(
  trace: Decide1Trace,
  decided_by: Decider,
  choice: DispatchChoice,
  status: 'needs_human' | 'paused',
  reason: DispatchReason,
): Plan {
  return { kind: 'final', trace, decided_by, choice, status, reason };
}

function dispatchPlan(
  trace: Decide1Trace,
  decided_by: Decider,
  choice: DispatchChoice,
  reason: DispatchReason,
  intent: DispatchIntent,
): Plan {
  return { kind: 'dispatch', trace, decided_by, choice, reason, intent };
}

function lastDecider(checkpoint: DispatchCheckpoint): { readonly decided_by: Decider; readonly choice: SiteChoice } {
  // Decide-2 is not a decided_by of its own: its rows are rule outcomes over the tool stage (P4c).
  if (checkpoint.tool !== null) return { decided_by: 'rule', choice: 'capability' };
  if (checkpoint.route !== null) return { decided_by: 'route', choice: checkpoint.route.site.choice };
  if (checkpoint.triage !== null) return { decided_by: 'triage', choice: checkpoint.triage.site.choice };
  if (checkpoint.intake !== null) return { decided_by: 'intake', choice: checkpoint.intake.choice };
  return { decided_by: 'rule', choice: 'ask_user' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality over journaled records: same keys and values, key order ignored, no coercion. */
function sameRecord(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameRecord(item, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameRecord(left[key], right[key]))
  );
}

type Stage = 'intake' | 'triage' | 'route' | 'tool';

function stageAsk(checkpoint: DispatchCheckpoint, stage: Stage): number {
  const ask = isRecord(checkpoint.asks) ? checkpoint.asks[stage] : undefined;
  if (typeof ask !== 'number' || !Number.isSafeInteger(ask) || ask < 1)
    throw new Error(`recorded ${stage} stage has no matching ask`);
  return ask;
}

function notLive(stage: Stage): Error {
  return new Error(`recorded ${stage} stage is not the live outcome of its recorded observations`);
}

/** A candidate the live function refuses to replay is no witness for the record. */
function derive<T>(replay: () => T): T | null {
  try {
    return replay();
  } catch {
    return null;
  }
}

/** The request as it stood when the checkpoint's asks were made. */
function askedRequest(request: DispatchRequest, checkpoint: DispatchCheckpoint): DispatchRequest {
  return { ...request, state_revision: checkpoint.state_revision, state_updated_at: checkpoint.state_updated_at };
}

function checkpointState(checkpoint: DispatchCheckpoint): SiteState {
  return { state_revision: checkpoint.state_revision, state_updated_at: checkpoint.state_updated_at };
}

const REPLAY_UNIT = 'dispatch.replay';
/** Never a policy option, so a raw answer naming it re-derives as `invalid_answer`. */
const NO_OPTION = '';

/** A gateway pause makes even an accepted answer an outage, which still keeps its content. */
function budgetPause(request_id: string, site: string) {
  return {
    type: 'loop.paused',
    policy: 'budget.policy@1',
    request_id,
    site,
    reason: 'quota_unknown',
    until: null,
  } as const;
}

/**
 * Raw `choice` answers the live site could have received, with content fixed by the recorded
 * observation. The record does not show whether the answer was fresh, stale, cancelled, foreign
 * or an outage, so each is offered and the live transition decides which, if any, reproduces it.
 */
function siteWitnesses(
  site: 'intake.classify' | LoopDecisionSite,
  request_id: string,
  state: SiteState,
  observation: unknown,
): RecordedSiteAnswer[] {
  const recorded = isRecord(observation) ? observation : {};
  const answer = typeof recorded['answer'] === 'string' ? recorded['answer'] : null;
  const confidence = typeof recorded['confidence'] === 'number' ? recorded['confidence'] : null;
  const top_p = typeof recorded['top_p'] === 'number' ? recorded['top_p'] : null;
  const provider = typeof recorded['provider_request_id'] === 'string' ? recorded['provider_request_id'] : undefined;
  const other = (SITE_POLICY[site].options as readonly string[]).find((option) => option !== answer);
  const distributions: (Readonly<Record<string, number>> | undefined)[] =
    answer === null || top_p === null
      ? [undefined]
      : [
          // An admissible distribution, then one naming a non-option, which the top-p gate refuses.
          top_p < 1 && other !== undefined ? { [answer]: top_p, [other]: 1 - top_p } : { [answer]: top_p },
          { [answer]: top_p, [NO_OPTION]: 0 },
        ];
  const base = { site, attempts: [], spent: 0, uncertainty: [] };
  const accepted = (id: string, probabilities: Readonly<Record<string, number>> | undefined) =>
    ({
      ...base,
      request_id: id,
      status: 'accepted',
      kind: 'choice',
      answers: {
        decision: { type: 'choice', choice: answer ?? NO_OPTION, ...(probabilities ? { probabilities } : {}) },
      },
      confidence: confidence === null ? undefined : { decision: confidence },
      routed_unit_id: REPLAY_UNIT,
      provider_response_id: provider,
    }) satisfies EvaluationOutcome<'choice'>;
  const outcomes: (EvaluationOutcome<'choice'> | null)[] = [
    ...distributions.map((probabilities) => accepted(request_id, probabilities)),
    accepted(`${request_id}:foreign`, distributions[0]),
    { ...accepted(request_id, distributions[0]), paused: budgetPause(request_id, site) },
    { ...base, request_id, status: 'blocked', reason: 'invalid_request' },
    null,
  ];
  return outcomes.flatMap((outcome): RecordedSiteAnswer[] => [
    { state_revision: state.state_revision, observed_at: state.state_updated_at, outcome },
    { state_revision: state.state_revision + 1, observed_at: state.state_updated_at, outcome },
    { state_revision: state.state_revision, observed_at: state.state_updated_at, outcome, cancelled: true },
  ]);
}

/** The verbatim answer text that gates to the recorded slots; any slot left unread means no answer. */
function extractText(schema: ExtractSchema, original: string, slots: readonly unknown[]): string {
  // Longer than the original, so it can never be grounded in it.
  const absent = `${original}#`;
  const answer: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema.slots)) {
    const slot = slots.find((candidate) => isRecord(candidate) && candidate['slot'] === name);
    if (!isRecord(slot) || slot['status'] === 'unread') return 'null';
    const span = slot['span'];
    const text =
      Array.isArray(span) && typeof span[0] === 'number' && typeof span[1] === 'number'
        ? original.slice(span[0], span[1])
        : null;
    const status = slot['status'];
    if (spec.kind === 'span') {
      answer[name] = { value: status === 'grounded' ? text : status === 'ungrounded' ? absent : null };
      continue;
    }
    const value = typeof slot['value'] === 'string' ? slot['value'] : null;
    answer[name] =
      status === 'grounded'
        ? { value, cue: text }
        : status === 'unresolved'
          ? { value: null, cue: text }
          : status === 'ungrounded'
            ? { value: null, cue: absent }
            : status === 'out_of_set'
              ? { value: `#${spec.options.join('#')}`, cue: null }
              : { value: null, cue: null };
  }
  return JSON.stringify(answer);
}

/** The raw generation the live extract call would have recorded for this observation. */
function extractWitness(
  ask: IntakeSiteInput,
  schema: ExtractSchema,
  observation: unknown,
  index: number,
): RecordedExtract {
  if (!isRecord(observation) || !Array.isArray(observation['slots'])) throw notLive('intake');
  const attempt = index === 0 ? 1 : 2;
  const request_id = `${ask.request_id}:x${attempt}`;
  const provider = observation['provider_request_id'];
  const text = extractText(schema, ask.state.message, observation['slots'] as readonly unknown[]);
  const generated = (id: string): GenerationOutcome => ({
    status: 'accepted',
    request_id: id,
    site: INTAKE_EXTRACT_SITE,
    text,
    routed_unit_id: REPLAY_UNIT,
    provider_response_id: typeof provider === 'string' ? provider : undefined,
    attempts: [],
    spent: 0,
    uncertainty: [],
  });
  const fresh = { attempt, state_revision: ask.state_revision, state_updated_at: ask.state_updated_at } as const;
  switch (observation['reason']) {
    case 'cancelled':
      return { ...fresh, outcome: generated(request_id), cancelled: true };
    case 'stale_answer':
      return { ...fresh, state_revision: ask.state_revision + 1, outcome: generated(request_id) };
    case 'mismatched_answer':
      return { ...fresh, outcome: generated(`${request_id}:foreign`) };
    case 'decision_unavailable':
      return { ...fresh, outcome: { ...generated(request_id), paused: budgetPause(request_id, INTAKE_EXTRACT_SITE) } };
    default:
      return { ...fresh, outcome: generated(request_id) };
  }
}

/** Intake: the extraction gate, the operator-ambiguity stop and the classify site, through `transitionIntake`. */
function replayIntake(request: DispatchRequest, checkpoint: DispatchCheckpoint): void {
  const recorded: unknown = checkpoint.intake;
  if (!isRecord(recorded) || !Array.isArray(recorded['extract'])) throw notLive('intake');
  const ask = askIntake(askedRequest(request, checkpoint), stageAsk(checkpoint, 'intake'));
  const current = checkpointState(checkpoint);
  const schema = intakeExtractSchema(ask.state);
  const extracts = (recorded['extract'] as readonly unknown[]).map((observation, index) =>
    extractWitness(ask, schema, observation, index),
  );
  const site = recorded['site'];
  const answers = site === null ? [null] : siteWitnesses('intake.classify', ask.request_id, current, site);
  for (const answer of answers) {
    const derived = derive(() => transitionIntake(ask, { extracts, site: answer }, current));
    if (derived !== null && sameRecord(derived, recorded)) return;
  }
  throw notLive('intake');
}

/** D1 and D2 replay the complete stored extract-composed record, not a synthetic origin. */
function replayLoop(request: DispatchRequest, checkpoint: DispatchCheckpoint, stage: 'triage' | 'route'): void {
  const site: LoopDecisionSite = stage === 'triage' ? 'loop.triage' : 'loop.route';
  const recorded: unknown = checkpoint[stage];
  if (!isRecord(recorded) || !Array.isArray(recorded['extracts']) || !isRecord(recorded['site'])) throw notLive(stage);
  const ask = loopAsk(askedRequest(request, checkpoint), stage, stageAsk(checkpoint, stage), checkpoint.child);
  const current = checkpointState(checkpoint);
  const extracts = recorded['extracts'] as ExtractObservation[];
  const schema = modelExtractSchema(site, ask.state);
  // The residual count is consequential evidence too: bind it to the schema's required slots.
  for (const [index, extract] of extracts.entries()) {
    if (
      !validExtractObservation(extract, schema, stableStringify(ask.state)) ||
      extract.schema !== 'extract@1' ||
      extract.site !== site ||
      extract.extract_schema !== schema.id ||
      extract.request_id !== `${ask.request_id}:x${index + 1}` ||
      extract.state_revision !== ask.state_revision
    )
      throw notLive(stage);
    const residual = Object.entries(schema.slots)
      .filter(
        ([slot, spec]) => spec.required && extract.slots.find((item) => item?.slot === slot)?.status !== 'grounded',
      )
      .map(([slot]) => slot);
    if (!sameRecord(extract.residual_ambiguity, { count: residual.length, slots: residual })) throw notLive(stage);
  }
  const answers = siteWitnesses(site, ask.request_id, current, recorded['site']['observation']);
  for (const answer of answers) {
    const derived = derive(() => transitionLoopDecision(site, ask, { extracts, site: answer }, current));
    if (derived !== null && sameRecord(derived, recorded)) return;
  }
  throw notLive(stage);
}

/** The catalogue a tool ask disclosed, in order; every field steers the pick or the row. */
function catalogueDigest(request: DispatchRequest): string {
  return digest(request.catalogue ?? []);
}

/** The Decide-2 ask for the tool stage; D1's grounded intent is the prior slot the args extract may read. */
function toolAsk(request: DispatchRequest, checkpoint: DispatchCheckpoint, ask: number): Decide2Ask {
  const state = { request: request.intake.message, context: request.triage_context };
  const final = checkpoint.triage?.extracts.at(-1);
  return {
    request_id: stageId(request.request_id, 'tool', ask),
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    state,
    catalogue: clone(request.catalogue ?? []),
    intent: final === undefined ? null : modelHints(final, stableStringify(state)).intent,
    terms: { ...request.terms, destinations: [...request.terms.destinations] },
  };
}

/** Raw boolean answers the live pick could have received, with content fixed by the recorded observation. */
function pickWitnesses(request_id: string, state: SiteState, observation: unknown) {
  const recorded = isRecord(observation) ? observation : {};
  const entries = Array.isArray(recorded['entries']) ? (recorded['entries'] as unknown[]) : [];
  const provider = typeof recorded['provider_request_id'] === 'string' ? recorded['provider_request_id'] : undefined;
  const answers: Record<string, { type: 'boolean'; probability: number }> = {};
  const confidence: Record<string, number> = {};
  for (const [i, entry] of entries.entries()) {
    if (!isRecord(entry)) continue;
    if (typeof entry['p'] === 'number') answers[`entry_${i}`] = { type: 'boolean', probability: entry['p'] };
    if (typeof entry['confidence'] === 'number') confidence[`entry_${i}`] = entry['confidence'];
  }
  const base = { site: DECIDE2_SITE, attempts: [], spent: 0, uncertainty: [] };
  const accepted = (id: string) =>
    ({
      ...base,
      request_id: id,
      status: 'accepted',
      kind: 'boolean',
      answers,
      confidence,
      routed_unit_id: REPLAY_UNIT,
      provider_response_id: provider,
    }) satisfies EvaluationOutcome<'boolean'>;
  const outcomes: (EvaluationOutcome<'boolean'> | null)[] = [
    accepted(request_id),
    accepted(`${request_id}:foreign`),
    { ...accepted(request_id), paused: budgetPause(request_id, DECIDE2_SITE) },
    { ...base, request_id, status: 'blocked', reason: 'invalid_request' },
    null,
  ];
  return outcomes.flatMap((outcome) => [
    { state_revision: state.state_revision, observed_at: state.state_updated_at, outcome },
    { state_revision: state.state_revision + 1, observed_at: state.state_updated_at, outcome },
    { state_revision: state.state_revision, observed_at: state.state_updated_at, outcome, cancelled: true },
  ]);
}

/**
 * The tool stage replays as a fixed point too: the catalogue must be the one bound at the ask, the
 * pick must re-derive through `transitionDecide2`, and args extracts exist exactly when the pure
 * margin rule picks an entry with args, each gated against that entry's own schema.
 */
function replayTool(request: DispatchRequest, checkpoint: DispatchCheckpoint): void {
  const recorded: unknown = checkpoint.tool;
  if (!orderedKeys(recorded, ['schema', 'request_id', 'pick', 'extracts']) || !Array.isArray(recorded['extracts']))
    throw notLive('tool');
  if (checkpoint.catalogue_digest !== catalogueDigest(request))
    throw new Error('the disclosed catalogue differs from the one bound at the tool ask');
  const ask = toolAsk(askedRequest(request, checkpoint), checkpoint, stageAsk(checkpoint, 'tool'));
  if (recorded['schema'] !== 'decide2.decision@1' || recorded['request_id'] !== ask.request_id) throw notLive('tool');
  const current = checkpointState(checkpoint);
  const pick = pickWitnesses(`${ask.request_id}:decide2`, current, recorded['pick'])
    .map((answer) => derive(() => transitionDecide2(ask, answer, current)))
    .find((derived) => derived !== null && sameRecord(derived, recorded['pick']));
  if (pick === undefined || pick === null) throw notLive('tool');
  const picked = decide2Pick(pick).pick;
  const entry = picked === null ? undefined : ask.catalogue[picked];
  const extracts = recorded['extracts'] as unknown[];
  if (entry === undefined || entry.args.length === 0) {
    if (extracts.length !== 0) throw notLive('tool');
    return;
  }
  const schema = decide2ArgsSchema(entry);
  const original = decide2ArgsOriginal(ask);
  if (extracts.length < 1 || extracts.length > 2) throw notLive('tool');
  for (const [index, extract] of extracts.entries()) {
    const call = decide2ArgsCall(ask, entry, index === 0 ? 1 : 2);
    if (
      !validExtractObservation(extract, schema, original) ||
      extract.site !== DECIDE2_ARGS_SITE ||
      extract.extract_schema !== DECIDE2_ARGS_SCHEMA ||
      extract.request_id !== call.request_id ||
      extract.attempt !== index + 1 ||
      extract.state_revision !== ask.state_revision
    )
      throw notLive('tool');
  }
  if (extracts.length === 2 && !needsSecondExtract(extracts[0] as ExtractObservation)) throw notLive('tool');
}

/** The tool stage's own status and reason: the pick's, else a held args extract's, else answered. */
function toolStage(tool: ToolDecision): { readonly status: 'transition' | 'paused'; readonly reason: string } {
  const held = ['cancelled', 'stale_answer', 'decision_unavailable'];
  const final = tool.extracts.at(-1);
  const reason =
    tool.pick.reason !== 'answered'
      ? tool.pick.reason
      : final !== undefined && held.includes(final.reason)
        ? final.reason
        : 'answered';
  return { status: reason === 'cancelled' || reason === 'decision_unavailable' ? 'paused' : 'transition', reason };
}

/** Required args of the picked entry the final extract did not ground; null without a pick. */
function missingArgs(entry: CatalogueEntry | undefined, tool: ToolDecision): number | null {
  if (entry === undefined) return null;
  const final = tool.extracts.at(-1);
  return entry.args.filter(
    (arg) => arg.required && final?.slots.find((slot) => slot.slot === arg.name)?.status !== 'grounded',
  ).length;
}

function replayStage(request: DispatchRequest, checkpoint: DispatchCheckpoint, stage: Stage): void {
  if (request.request_id !== checkpoint.decision_id) throw new Error('checkpoint belongs to another decision');
  if (stage === 'intake') replayIntake(request, checkpoint);
  else if (stage === 'tool') replayTool(request, checkpoint);
  else replayLoop(request, checkpoint, stage);
}

/**
 * Recorded stages are accepted only as a fixed point of the live path. Each one is re-derived by the
 * pure function its live call used, from raw answers rebuilt out of its own observations and the
 * disclosed request, and must come back identical. A shape the live path stops on, or never
 * produces, cannot come back, so no derived field is trusted on its own.
 */
function replayStages(request: DispatchRequest, checkpoint: DispatchCheckpoint): void {
  if (request.request_id !== checkpoint.decision_id) throw new Error('checkpoint belongs to another decision');
  const { intake, triage, route } = checkpoint;
  if (route !== null && triage === null) throw new Error('a recorded route needs a recorded triage');
  if (triage !== null && (intake === null || intake.status !== 'transition' || intake.choice !== 'new_thread'))
    throw new Error('a recorded triage needs intake new_thread');
  if (route !== null && triage?.site.observation?.accepted !== true)
    throw new Error('a recorded route cannot follow a triage fallback');
  if (route !== null && (triage?.site.status !== 'transition' || triage.site.choice !== 'implement'))
    throw new Error('a recorded route needs triage implement');
  const tool = checkpoint.tool;
  if (
    tool !== null &&
    (triage?.site.status !== 'transition' ||
      triage.site.observation?.accepted !== true ||
      triage.site.choice !== 'capability' ||
      (request.catalogue?.length ?? 0) === 0)
  )
    throw new Error('a recorded tool stage needs triage capability over a disclosed catalogue');
  if (intake !== null) replayStage(request, checkpoint, 'intake');
  if (triage !== null) replayStage(request, checkpoint, 'triage');
  if (route !== null) replayStage(request, checkpoint, 'route');
  if (tool !== null) replayStage(request, checkpoint, 'tool');
}

const SHADOW_REASONS = [
  'answered',
  'no_answer',
  'invalid_answer',
  'stale_answer',
  'mismatched_answer',
  'decision_unavailable',
  'cancelled',
] as const;
const SHADOW_KEYS = [
  'schema',
  'site',
  'question',
  'request_id',
  'state_revision',
  'probability',
  'confidence',
  'reason',
  'provider_request_id',
] as const;
const SHADOW_RULES: ReadonlySet<Decide1Trace['rule']> = new Set([
  'act.tool',
  'gen.no_tool_margin',
  'act.done_check',
  'act.decline',
  'gen.triage_fallback',
  'gen.route',
  'gen.route_fallback',
]);

/** Untrusted shadow data is absent evidence, never a reason to stop dispatch. */
function trustedShadow(checkpoint: DispatchCheckpoint, index: number): ShadowObservation | null {
  const records: unknown = checkpoint.shadow;
  if (!Array.isArray(records) || records.length !== 4) return null;
  const observation: unknown = records[index];
  if (
    !isRecord(observation) ||
    Object.keys(observation).length !== SHADOW_KEYS.length ||
    !SHADOW_KEYS.every((key) => Object.hasOwn(observation, key))
  )
    return null;
  const judgment = DECIDE1_SHADOW_JUDGMENTS[index]!;
  if (
    observation['schema'] !== 'decide1-shadow@1' ||
    observation['site'] !== `decide1.${judgment}` ||
    observation['question'] !== DECIDE1_SHADOW_QUESTIONS[judgment] ||
    observation['request_id'] !== `${checkpoint.decision_id}:shadow.${judgment}` ||
    observation['state_revision'] !== checkpoint.state_revision ||
    !(SHADOW_REASONS as readonly unknown[]).includes(observation['reason'])
  )
    return null;
  if (observation['reason'] === 'answered') {
    if (!unit(observation['probability']) || (observation['confidence'] !== null && !unit(observation['confidence'])))
      return null;
  } else if (observation['probability'] !== null || observation['confidence'] !== null) return null;
  if (
    observation['provider_request_id'] !== null &&
    (typeof observation['provider_request_id'] !== 'string' ||
      correlation(observation['provider_request_id']) !== observation['provider_request_id'])
  )
    return null;
  return observation as unknown as ShadowObservation;
}

/** Copy only structurally trusted observations; the trace still records each dropped reason. */
function recordedShadow(checkpoint: DispatchCheckpoint): readonly ShadowObservation[] | null {
  if (checkpoint.shadow === null) return null;
  return DECIDE1_SHADOW_JUDGMENTS.flatMap((_, index) => {
    const observation = checkpoint.asks.shadow === 1 ? trustedShadow(checkpoint, index) : null;
    return observation === null ? [] : [clone(observation)];
  });
}

const PREFLIGHT_RULES: ReadonlySet<Decide1Trace['rule']> = new Set(['gen.route']);
const ROLE_KEYS = [
  'schema',
  'site',
  'question',
  'request_id',
  'state_revision',
  'targets',
  'reason',
  'provider_request_id',
];
const ROLE_TARGET_KEYS = ['ref', 'role', 'top_p', 'confidence'];
function orderedKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key, i) => key === keys[i])
  );
}
/** A role round is optional shadow evidence. Drop a malformed round in its entirety. */
function trustedRoles(checkpoint: DispatchCheckpoint, request: DispatchRequest): RoleObservation | null {
  const record: unknown = checkpoint.preflight;
  if (
    checkpoint.asks.preflight !== 1 ||
    !orderedKeys(record, ROLE_KEYS) ||
    record['schema'] !== 'spawn-roles@1' ||
    record['site'] !== 'spawn.roles' ||
    record['question'] !== SPAWN_ROLES_QUESTION ||
    record['request_id'] !== `${checkpoint.decision_id}:roles` ||
    record['state_revision'] !== checkpoint.state_revision ||
    !(SHADOW_REASONS as readonly unknown[]).includes(record['reason'])
  )
    return null;
  const targets = request.targets ?? [];
  const observed = record['targets'];
  if (!Array.isArray(observed) || observed.length !== targets.length || observed.length < 1 || observed.length > 8)
    return null;
  for (const [i, item] of observed.entries()) {
    if (!orderedKeys(item, ROLE_TARGET_KEYS) || item['ref'] !== targets[i]!.ref) return null;
    if (record['reason'] === 'answered') {
      if (
        !(TARGET_ROLES as readonly unknown[]).includes(item['role']) ||
        (item['top_p'] !== null && !maximalTopP(item['top_p'])) ||
        (item['confidence'] !== null && !unit(item['confidence']))
      )
        return null;
    } else if (item['role'] !== null || item['top_p'] !== null || item['confidence'] !== null) return null;
  }
  if (
    record['provider_request_id'] !== null &&
    (typeof record['provider_request_id'] !== 'string' ||
      correlation(record['provider_request_id']) !== record['provider_request_id'])
  )
    return null;
  return clone(record) as unknown as RoleObservation;
}
function roleAsk(request: DispatchRequest, checkpoint: DispatchCheckpoint): RoleAsk {
  return {
    ...shadowAsk(request, checkpoint),
    state: {
      request: request.intake.message,
      context: request.triage_context,
      targets: (request.targets ?? []).map((target) => ({ ref: target.ref, summary: target.summary })),
    },
  };
}

function shadowAsk(request: DispatchRequest, checkpoint: DispatchCheckpoint): ShadowAsk {
  return {
    request_id: checkpoint.decision_id,
    ...checkpointState(checkpoint),
    state: { request: request.intake.message, context: request.triage_context },
    terms: { ...request.terms, destinations: [...request.terms.destinations] },
  };
}

/** Fixed, bounded code facts and stage probabilities; no disclosed text is copied. */
export function decide1Inputs(request: DispatchRequest, checkpoint: DispatchCheckpoint): Decide1Inputs {
  const { intake, triage, route } = checkpoint;
  const target =
    intake !== null && isThreadRelation(intake.choice)
      ? resolveThreadTarget(intake, request.intake.running_threads)
      : null;
  const facts: Decide1Fact[] = [
    { name: 'intake.decided_by', value: intake?.decided_by ?? null },
    { name: 'intake.choice', value: intake?.choice ?? null },
    { name: 'intake.status', value: intake?.status ?? null },
    { name: 'intake.reason', value: intake?.reason ?? null },
    { name: 'intake.accepted', value: intake?.site?.accepted ?? false },
    { name: 'thread_target', value: target === null ? null : target.ok ? 'resolved' : target.reason },
  ];
  for (const [stage, transition] of [
    ['triage', triage?.site],
    ['route', route?.site],
  ] as const) {
    facts.push(
      { name: `${stage}.choice`, value: transition?.choice ?? null },
      { name: `${stage}.status`, value: transition?.status ?? null },
      { name: `${stage}.reason`, value: transition?.observation.reason ?? null },
      { name: `${stage}.accepted`, value: transition?.observation.accepted ?? null },
    );
  }
  const judgments: Decide1Judgment[] = [];
  for (const [stage, observation] of [
    ['intake', intake?.site],
    ['triage', triage?.site.observation],
    ['route', route?.site.observation],
  ] as const) {
    if (observation == null) continue;
    if (observation.confidence !== null)
      judgments.push({ name: `${stage}.confidence`, probability: observation.confidence });
    if (observation.top_p !== null) judgments.push({ name: `${stage}.top_p`, probability: observation.top_p });
  }
  const ambiguity = triage?.extracts.at(-1)?.residual_ambiguity.count;
  const shadowFacts: Decide1Fact[] = [{ name: 'residual_ambiguity', value: natural(ambiguity) ? ambiguity : null }];
  const shadowJudgments: Decide1Judgment[] = [];
  for (const [index, judgment] of DECIDE1_SHADOW_JUDGMENTS.entries()) {
    const observation = checkpoint.asks.shadow === 1 ? trustedShadow(checkpoint, index) : null;
    const reason =
      checkpoint.asks.shadow !== 1
        ? null
        : checkpoint.shadow === null
          ? 'unrecorded'
          : (observation?.reason ?? 'untrusted');
    shadowFacts.push({ name: `${judgment}.reason`, value: reason });
    if (observation?.probability != null)
      shadowJudgments.push({ name: judgment, probability: observation.probability });
    if (observation?.confidence != null)
      shadowJudgments.push({ name: `${judgment}.confidence`, probability: observation.confidence });
  }
  // P5b: preflight roles, admission, plan and port are read inputs to the spawn row.
  const roles = trustedRoles(checkpoint, request);
  const reason =
    checkpoint.asks.preflight !== 1
      ? null
      : checkpoint.preflight === null
        ? 'unrecorded'
        : (roles?.reason ?? 'untrusted');
  facts.push(
    { name: 'preflight.reason', value: reason },
    { name: 'preflight.targets', value: request.targets?.length ?? 0 },
  );
  for (let i = 0; i < 8; i++) {
    const target = roles?.targets[i];
    facts.push({ name: `preflight.t${i}.role`, value: target?.role ?? null });
    if (target?.top_p != null) judgments.push({ name: `preflight.t${i}.top_p`, probability: target.top_p });
    if (target?.confidence != null)
      judgments.push({ name: `preflight.t${i}.confidence`, probability: target.confidence });
  }
  const spawn = preflightFor(request, checkpoint);
  const admitted = checkpoint.asks.preflight !== 1 ? null : roles !== null && rolesAdmitted(roles);
  facts.push(
    { name: 'preflight.admitted', value: admitted },
    { name: 'spawn.gain', value: spawn?.gain ?? null },
    { name: 'spawn.children', value: spawn?.plan?.children.length ?? null },
    { name: 'spawn.plan', value: spawn?.plan?.digest ?? null },
    { name: 'spawn.port', value: checkpoint.spawn_port },
  );
  // P5c1: entry and child facts are read inputs; a boundary is set only at its gate (`childBoundaryTrace`).
  const child = checkpoint.child ?? null;
  facts.push(
    { name: 'entry.kind', value: child === null ? 'root' : 'child' },
    { name: 'child.kind', value: child?.brief.kind ?? null },
    { name: 'child.parent', value: child?.parent_ref ?? null },
    { name: 'child.plan', value: child?.plan_digest ?? null },
    { name: 'child.dependencies', value: child === null ? null : witnessJoin(child) },
    { name: 'child.read_bytes', value: child === null ? null : readBytes(child) },
    { name: 'child.share', value: child?.brief.share ?? null },
    { name: 'child.boundary', value: null },
  );
  // P4c: the tool stage and its derived pick; never trusted from storage, recomputed from the observation.
  const tool = checkpoint.tool;
  if (tool !== null && checkpoint.catalogue_digest !== catalogueDigest(request))
    throw new Error('the disclosed catalogue differs from the one bound at the tool ask');
  const catalogue = request.catalogue ?? [];
  const derived = tool === null ? null : decide2Pick(tool.pick);
  const top = derived?.top == null ? undefined : catalogue[derived.top];
  const pickEntry = derived?.pick == null ? undefined : catalogue[derived.pick];
  const stageOf = tool === null ? null : toolStage(tool);
  facts.push(
    { name: 'tool.status', value: stageOf?.status ?? null },
    { name: 'tool.reason', value: stageOf?.reason ?? null },
    { name: 'decide2.entries', value: catalogue.length },
    { name: 'decide2.top', value: top?.ref ?? null },
    { name: 'decide2.pick', value: pickEntry?.ref ?? null },
    { name: 'decide2.margin', value: derived?.margin ?? null },
    { name: 'decide2.top_reversible', value: top?.reversible ?? null },
    { name: 'decide2.top_plausible', value: tool === null ? null : plausibleTop(tool.pick, derived?.top ?? null) },
    { name: 'args.missing', value: tool === null ? null : missingArgs(pickEntry, tool) },
  );
  for (const [i, entry] of (tool?.pick.entries ?? []).entries()) {
    if (entry.p !== null) judgments.push({ name: `decide2.e${i}.p`, probability: entry.p });
    if (entry.confidence !== null) judgments.push({ name: `decide2.e${i}.confidence`, probability: entry.confidence });
  }
  return { judgments, facts, shadow: { judgments: shadowJudgments, facts: shadowFacts } };
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The preflight plan as a pure function of the checkpoint and the disclosed request. Untrusted
 * inputs are absent evidence (null); a builder/validator mismatch surfaces as a defect (D-ENG-052).
 */
function preflightFor(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
): { readonly gain: boolean; readonly plan: SpawnPlan | null } | null {
  const roles = trustedRoles(checkpoint, request);
  const targets = roles?.targets.map((target) => target.ref) ?? [];
  const route = checkpoint.route;
  const ambiguity = checkpoint.triage?.extracts.at(-1)?.residual_ambiguity.count;
  const budget = checkpoint.preflight_budget;
  if (
    roles?.reason !== 'answered' ||
    !natural(ambiguity) ||
    correlation(checkpoint.decision_id) === null ||
    targets.some((target) => correlation(target) === null) ||
    new Set(targets).size !== targets.length ||
    route === null ||
    !isTier(route.site.choice) ||
    !natural(budget)
  )
    return null;
  return preflightPlan({
    decision_id: checkpoint.decision_id,
    root_ref: checkpoint.decision_id,
    goal_digest: digest({ message: request.intake.message }),
    budget,
    tier: route.site.choice,
    targets,
    roles: roles.targets.map((t) => t.role!),
    ambiguity,
  });
}

/** The asking request's ceiling, bound when roles are asked (D-P5b-5); anything else is no budget. */
function preflightBudget(request: DispatchRequest): number | null {
  return natural(request.terms.cost_ceiling) ? request.terms.cost_ceiling : null;
}

/** Rule ids fix the outcome. The request is needed only to bind the already-resolved thread id. */
function planFor(trace: Decide1Trace, checkpoint: DispatchCheckpoint, request: DispatchRequest): Plan {
  const unplanned = () => new Error('spawn_subtasks needs a validated preflight plan (D-ENG-044)');
  if (trace.band === 'spawn_subtasks' && trace.rule !== 'spawn.preflight') throw unplanned();
  const dispatch_id = `${checkpoint.decision_id}:dispatch`;
  const facts = new Map(trace.facts.map((fact) => [fact.name, fact.value]));
  const choice = (stage: Stage) => facts.get(`${stage}.choice`) as SiteChoice;
  const reason = (stage: Stage) => facts.get(`${stage}.reason`) as DispatchReason;
  switch (trace.rule) {
    case 'hold.admission':
    case 'hold.outage':
    case 'hold.paused': {
      const stage = (['intake', 'triage', 'route', 'tool'] as const).find((stage) =>
        trace.rule === 'hold.admission'
          ? reason(stage) === 'stale_answer' || reason(stage) === 'mismatched_answer'
          : trace.rule === 'hold.outage'
            ? reason(stage) === 'decision_unavailable'
            : facts.get(`${stage}.status`) === 'paused',
      );
      if (stage === undefined) {
        // A child boundary is a gate code fact over the child's real stages, never a projected stage.
        const boundary = facts.get('child.boundary');
        if (
          checkpoint.child === null ||
          !(
            (trace.rule === 'hold.admission' && boundary === 'stale_answer') ||
            (trace.rule === 'hold.paused' && boundary === 'cancelled')
          )
        )
          throw new Error('decide1: no withheld stage');
        const decider = childDecider(checkpoint);
        return final(trace, decider.decided_by, decider.choice, 'paused', boundary as DispatchReason);
      }
      // The tool stage holds the capability call it would have made; its rows are rule outcomes.
      if (stage === 'tool') return final(trace, 'rule', 'capability', 'paused', reason(stage));
      const decided_by = checkpoint.child !== null ? 'route' : checkpoint.intake === null ? 'rule' : stage;
      return final(trace, decided_by, choice(stage), 'paused', reason(stage));
    }
    case 'hold.dependency_pending':
    case 'hold.unmet_dependency': {
      const tier = checkpoint.child?.brief.tier;
      if (tier == null) throw new Error('decide1: a dependency gate needs a generate child');
      const pending = trace.rule === 'hold.dependency_pending';
      return final(trace, 'rule', tier, 'paused', pending ? 'dependency_pending' : 'unmet_dependency');
    }
    case 'hold.share_exhausted': {
      // Set only at its gate, and only when the next D2 ask cannot be covered (`assertExhausted`).
      if (facts.get('child.boundary') !== 'share_exhausted') throw new Error('decide1: no share gate');
      assertExhausted(checkpoint);
      const decider = childDecider(checkpoint);
      return final(trace, decider.decided_by, decider.choice, 'paused', 'share_exhausted');
    }
    case 'act.read': {
      const child = checkpoint.child;
      if (child === null || child.brief.kind !== 'read' || child.brief.target_ref === null)
        throw new Error('decide1: act.read needs a verified read child');
      return dispatchPlan(trace, 'rule', 'read', 'accepted', {
        kind: 'read',
        dispatch_id,
        target_ref: child.brief.target_ref,
        child,
      });
    }
    case 'gen.child':
    case 'gen.child_fallback': {
      const child = checkpoint.child;
      const routed = choice('route');
      const inherited = child?.brief.tier;
      if (child === null || inherited == null || !isTier(routed)) throw new Error('decide1: invalid child route');
      // An accepted tier may rise above the parent's; a fallback can never raise the inherited tier.
      const accepted = trace.rule === 'gen.child';
      const tier = accepted ? routed : lowerTier('standard', inherited);
      return dispatchPlan(trace, 'route', tier, accepted ? 'accepted' : reason('route'), {
        kind: 'implement',
        dispatch_id,
        tier,
        ceiling: tier,
        tier_source: accepted ? 'child_route' : 'child_route_fallback',
        budget: custodyOf(checkpoint)!.remainder,
        child,
      });
    }
    case 'ask.intake':
      return final(trace, 'intake', choice('intake'), 'needs_human', reason('intake'));
    case 'ask.irreversible':
      return final(trace, 'rule', 'stop', 'needs_human', 'irreversible');
    case 'ask.thread_target':
      return final(
        trace,
        'rule',
        choice('intake'),
        'needs_human',
        facts.get('thread_target') as 'no_target' | 'ambiguous_reference',
      );
    case 'act.thread': {
      const target = resolveThreadTarget(checkpoint.intake!, request.intake.running_threads);
      const relation = choice('intake');
      if (!target.ok || !isThreadRelation(relation)) throw new Error('decide1: unresolved thread');
      return dispatchPlan(trace, 'intake', relation, reason('intake'), {
        kind: 'thread',
        dispatch_id,
        relation,
        thread_ref: target.thread_ref,
      });
    }
    case 'ask.triage':
      return final(trace, 'triage', choice('triage'), 'needs_human', reason('triage'));
    case 'ask.tool_irreversible':
      return final(trace, 'rule', 'capability', 'needs_human', 'irreversible');
    case 'gen.no_tool_margin':
      // Provisional tier (route-fallback precedent); Gauge measures how often this row fires.
      return dispatchPlan(trace, 'rule', 'standard', 'no_tool_margin', {
        kind: 'implement',
        dispatch_id,
        tier: 'standard',
        ceiling: 'standard',
        tier_source: 'no_tool_margin',
        catalogue_digest: catalogueDigest(request),
      });
    case 'ask.tool_args':
      return final(trace, 'rule', 'capability', 'needs_human', 'missing_args');
    case 'act.tool': {
      const tool = checkpoint.tool;
      const entry = (request.catalogue ?? []).find((candidate) => candidate.ref === facts.get('decide2.pick'));
      if (tool === null || entry === undefined || checkpoint.catalogue_digest === null)
        throw new Error('decide1: act.tool needs a recorded Decide-2 pick');
      const final = tool.extracts.at(-1);
      const args_ref =
        entry.args.length === 0 || final === undefined
          ? null
          : digest({
              original: digest(
                decide2ArgsOriginal({ state: { request: request.intake.message, context: request.triage_context } }),
              ),
              extract: final,
            });
      if (entry.args.length > 0 && args_ref === null) throw new Error('decide1: act.tool needs its args record');
      return dispatchPlan(trace, 'rule', 'capability', 'accepted', {
        kind: 'capability',
        dispatch_id,
        entry_ref: entry.ref,
        catalogue_digest: checkpoint.catalogue_digest,
        args_ref,
      });
    }
    case 'act.done_check':
      return dispatchPlan(trace, 'triage', 'done_check', 'accepted', { kind: 'done_check', dispatch_id });
    case 'act.decline':
      return dispatchPlan(trace, 'triage', 'out_of_scope', 'accepted', { kind: 'decline', dispatch_id });
    case 'gen.triage_fallback':
      return dispatchPlan(trace, 'triage', 'implement', reason('triage'), {
        kind: 'implement',
        dispatch_id,
        tier: 'strong',
        ceiling: 'strong',
        tier_source: 'triage_fallback',
      });
    case 'spawn.preflight': {
      const spawn = preflightFor(request, checkpoint);
      const roles = trustedRoles(checkpoint, request);
      if (
        spawn === null ||
        spawn.gain !== true ||
        spawn.plan === null ||
        spawn.plan.digest !== facts.get('spawn.plan') ||
        roles === null
      )
        throw unplanned();
      return dispatchPlan(trace, 'rule', 'spawn', 'accepted', {
        kind: 'spawn',
        dispatch_id,
        targets: (request.targets ?? []).map((target) => target.ref),
        plan: spawn.plan,
        // The plan reads only the roles; the claim must also fix their confidence, top_p and provenance.
        roles_digest: digest(roles),
      });
    }
    case 'gen.route': {
      const tier = choice('route');
      if (!isTier(tier)) throw new Error('decide1: invalid route tier');
      return dispatchPlan(trace, 'route', tier, 'accepted', {
        kind: 'implement',
        dispatch_id,
        tier,
        ceiling: tier,
        tier_source: 'route',
      });
    }
    case 'ask.route':
      return final(trace, 'route', choice('route'), 'needs_human', reason('route'));
    case 'gen.route_fallback':
      return dispatchPlan(trace, 'route', 'standard', reason('route'), {
        kind: 'implement',
        dispatch_id,
        tier: 'standard',
        ceiling: 'standard',
        tier_source: 'route_fallback',
      });
    default: {
      const exhaustive: never = trace.rule;
      throw new Error(`decide1: unknown rule ${exhaustive}`);
    }
  }
}

function assertCheckpoint(checkpoint: DispatchCheckpoint): void {
  if (checkpoint.schema !== 'dispatch.checkpoint@6')
    throw new Error('recorded dispatch checkpoint schema differs from dispatch.checkpoint@6');
  if (typeof checkpoint.spawn_port !== 'boolean') throw new Error('recorded dispatch spawn_port is not a boolean');
  if (checkpoint.preflight_budget !== null && !natural(checkpoint.preflight_budget))
    throw new Error('recorded dispatch preflight_budget is not a safe natural');
  for (const key of ['preflight_terms', 'child_terms', 'child'] as const)
    if (checkpoint[key] === undefined) throw new Error(`recorded dispatch checkpoint has no ${key}`);
  const terms: unknown = checkpoint.preflight_terms;
  if (terms !== null) {
    if (!isRecord(terms)) throw new Error('recorded dispatch preflight_terms are not a record');
    // The budget is the asking request's ceiling bound with the ask; drift either way is tampering.
    const ceiling = terms['cost_ceiling'];
    if (checkpoint.preflight_budget !== (natural(ceiling) ? ceiling : null))
      throw new Error('recorded dispatch preflight_budget differs from its preflight_terms');
  }
  if (checkpoint.tool === undefined || checkpoint.catalogue_digest === undefined)
    throw new Error('recorded dispatch checkpoint has no tool stage');
  if ((natural(checkpoint.asks?.tool) && checkpoint.asks.tool > 0) !== (checkpoint.catalogue_digest !== null))
    throw new Error('recorded dispatch catalogue_digest is bound only with the tool ask');
  if (checkpoint.child === null && (checkpoint.asks?.preflight === 1) !== (terms !== null))
    throw new Error('recorded dispatch preflight_terms are bound only with the role ask');
}

function assertDecision(decision: DispatchDecision): void {
  assertRuleTable(decision);
  if (decision.child === undefined) throw new Error('recorded dispatch decision has no child');
  if (decision.reason === 'dependency_pending')
    throw new Error('a transient dependency_pending decision is never journaled');
}

/** A root and a child never share an id: neither can be re-entered as the other. */
function assertEntry(request: DispatchRequest, loaded: ReturnType<DispatchJournal['load']>): void {
  const child = request.child !== undefined;
  for (const decision of loaded.decisions) {
    assertDecision(decision);
    if ((decision.child !== null) !== child) throw new Error(entrySwap(child));
  }
  if (loaded.checkpoint !== null) {
    assertCheckpoint(loaded.checkpoint);
    if ((loaded.checkpoint.child !== null) !== child) throw new Error(entrySwap(child));
  }
}
function entrySwap(child: boolean): string {
  return child
    ? 'a root decision cannot be re-entered as a child'
    : 'a stored child decision cannot be resumed as a root';
}

function resolveOutcome(request: DispatchRequest, checkpoint: DispatchCheckpoint, evidence?: ChildEvidence): Plan {
  assertCheckpoint(checkpoint);
  if (request.child !== undefined || checkpoint.child !== null) return resolveChild(request, checkpoint, evidence);
  if (checkpoint.intake === null) throw new Error('a dispatch decision needs an intake record');
  replayStages(request, checkpoint);
  return planFor(decideBand(decide1Inputs(request, checkpoint)), checkpoint, request);
}

const CHILD_KEYS = [
  'schema',
  'parent_ref',
  'parent_entry',
  'plan_digest',
  'brief',
  'terms_digest',
  'dependencies',
  'dependencies_digest',
];
const EDGE_KEYS = ['decision_ref', 'entry', 'decision_digest', 'dispatch_ref', 'receipt'];
const TERM_KEYS: readonly string[] = [
  'audit',
  'tier',
  'quality',
  'destinations',
  'content_class',
  'max_context_tokens',
  'deadline',
  'cost_ceiling',
  'max_attempts',
  'prefix_digest',
  'prefix_cache',
  'max_attempts_per_route',
];
const TIER_ORDER: readonly ImplementTier[] = ['flash', 'standard', 'strong'];
function lowerTier(left: ImplementTier, right: ImplementTier): ImplementTier {
  return TIER_ORDER.indexOf(left) <= TIER_ORDER.indexOf(right) ? left : right;
}

/** What exact membership in a successful root spawn authenticates (D-P5c1-1). */
export interface VerifiedChild {
  readonly brief: ChildBrief;
  readonly parent_entry: number;
  readonly plan: SpawnPlan;
  /** The parent's captured `preflight_terms`: the superset a child's terms must narrow. */
  readonly terms: InferenceTerms;
}

/**
 * Pure: the brief must be an exact member of the plan its root parent appended as a successful spawn.
 * The plan is recomputed from the parent's claimed evidence, so a self-consistent reseal authenticates
 * nothing. Live entry passes `journal.load(parent_ref)`; replay passes the historical snapshot.
 */
export function verifyChild(request: DispatchRequest, parent: ChildEvidence['parent']): VerifiedChild {
  const brief: unknown = request.child?.brief;
  if (!isRecord(brief) || !isRecord(brief['frame'])) throw new Error('a child request needs a sealed brief');
  const frame = brief['frame'];
  if (request.request_id !== brief['child_ref']) throw new Error('a child request id must be its child_ref');
  if (digest({ message: request.intake.message }) !== frame['goal_digest'])
    throw new Error('child goal differs from its sealed goal digest');
  const parent_ref = frame['parent_ref'];
  const { checkpoint, decisions } = parent;
  if (checkpoint === null || checkpoint.decision_id !== parent_ref || frame['root_ref'] !== parent_ref)
    throw new Error('child parent has no journaled root spawn');
  assertCheckpoint(checkpoint);
  for (const decision of decisions) assertDecision(decision);
  // Depth 1 without a depth constant: a child never spawns, and chained lineage waits for P5d.
  if (checkpoint.child !== null) throw new Error('a child parent must be a root');
  const spawned = decisions.at(-1);
  const intent = spawned?.intent;
  const receipt: unknown = spawned?.receipt;
  if (
    spawned === undefined ||
    spawned.decision_id !== parent_ref ||
    spawned.entry !== decisions.length ||
    spawned.child !== null ||
    spawned.status !== 'dispatched' ||
    spawned.decide1.rule !== 'spawn.preflight' ||
    intent?.kind !== 'spawn' ||
    intent.dispatch_id !== `${parent_ref}:dispatch` ||
    !orderedKeys(receipt, ['status', 'dispatch_id', 'ref']) ||
    receipt['dispatch_id'] !== intent.dispatch_id ||
    receipt['ref'] !== intent.plan.digest
  )
    throw new Error('child parent has no successful spawn decision');
  if (!sameRecord(checkpoint.intent, intent)) throw new Error('child parent decision differs from its claimed intent');
  const asked: DispatchRequest = {
    request_id: parent_ref,
    ...checkpointState(checkpoint),
    terms: checkpoint.preflight_terms ?? request.terms,
    intake: { message: request.intake.message, running_threads: [] },
    triage_context: '',
    route_context: '',
    targets: intent.targets.map((ref) => ({ ref, summary: '' })),
  };
  const roles = trustedRoles(checkpoint, asked);
  const recomputed = preflightFor(asked, checkpoint);
  if (
    checkpoint.preflight_terms === null ||
    roles === null ||
    digest(roles) !== intent.roles_digest ||
    recomputed?.gain !== true ||
    recomputed.plan === null ||
    !sameRecord(recomputed.plan, intent.plan)
  )
    throw new Error('child parent plan does not re-derive from its claimed evidence');
  const plan = validatePlan(intent.plan, intent.targets);
  const member = plan.children.find((candidate) => candidate.child_ref === brief['child_ref']);
  if (member === undefined || !sameRecord(member, brief))
    throw new Error('child brief is not an exact member of its parent plan');
  return { brief: clone(member), parent_entry: spawned.entry, plan, terms: clone(checkpoint.preflight_terms) };
}

/**
 * Child terms narrow the root's captured terms (D-P5c1-4): ceiling within the sealed share, no wider
 * destinations, no later deadline, no larger limits, no weaker quality, audit only strengthens and
 * every other setting is retained exactly. Prefix fields price a view; never the parent's.
 */
function admitChildTerms(value: unknown, root: InferenceTerms, share: number, kind: ChildBrief['kind']): void {
  const refuse = (why: string) => new Error(`child terms ${why}`);
  if (!isRecord(value) || Object.keys(value).some((key) => !TERM_KEYS.includes(key)))
    throw refuse('carry an unknown field');
  const terms = value as Record<string, unknown>;
  const parent = root as unknown as Record<string, unknown>;
  if (!natural(terms['cost_ceiling']) || terms['cost_ceiling'] > share) throw refuse('exceed the sealed share');
  // P5c3: a generator's first D2 ask is charged LOOP_DECISION_REQUESTS ceilings, which must fit.
  if (kind === 'generate' && LOOP_DECISION_REQUESTS * terms['cost_ceiling'] > share)
    throw refuse('cannot cover a D2 ask within the sealed share');
  const destinations = terms['destinations'];
  if (
    !Array.isArray(destinations) ||
    !destinations.every((d) => typeof d === 'string' && root.destinations.includes(d))
  )
    throw refuse('widen destinations');
  for (const key of ['deadline', 'max_context_tokens', 'max_attempts'] as const) {
    const limit = terms[key];
    if (typeof limit !== 'number' || Number.isNaN(limit) || limit > root[key]) throw refuse(`raise ${key}`);
  }
  if (
    !(QUALITY_BARS as readonly unknown[]).includes(terms['quality']) ||
    !qualityClears(terms['quality'] as InferenceTerms['quality'], root.quality)
  )
    throw refuse('weaken quality');
  if (terms['audit'] !== undefined && typeof terms['audit'] !== 'boolean') throw refuse('carry a malformed audit');
  if (root.audit === true && terms['audit'] !== true) throw refuse('drop audit');
  for (const key of ['content_class', 'tier', 'max_attempts_per_route'])
    if (!sameRecord(terms[key], parent[key])) throw refuse(`change ${key}`);
  const prefix = terms['prefix_digest'];
  if (prefix !== undefined && (typeof prefix !== 'string' || prefix === root.prefix_digest))
    throw refuse("copy the parent's prefix");
  const cache = terms['prefix_cache'];
  if (
    cache !== undefined &&
    (!isRecord(cache) ||
      (root.prefix_cache !== undefined && sameRecord(cache, root.prefix_cache)) ||
      (root.prefix_digest !== undefined && cache['prefix_digest'] === root.prefix_digest))
  )
    throw refuse("copy the parent's prefix");
}

/**
 * `dispatch.custody@1` (P5c3): what a child holds of its sealed share. The plan carves each share
 * out of the root's budget once (they sum to `plan.budget`); the child's own D2 asks are charged
 * at their worst case, `LOOP_DECISION_REQUESTS × terms.cost_ceiling` per ask taken, including a
 * cancelled, crashed or lost one. Nothing is refunded or refilled, so `charged` only grows, and
 * `remainder` is what a claimed implement intent may still spend.
 */
export interface ChildCustody {
  readonly schema: 'dispatch.custody@1';
  readonly share: number;
  /** The worst case of one D2 ask under the child's admitted terms. */
  readonly per_ask: number;
  readonly charged: number;
  readonly remainder: number;
}

/**
 * Pure: the custody of a child checkpoint, derived from its sealed share, admitted ceiling and
 * journaled D2 ask counter, so it is written atomically with every ask and replays exactly. A
 * root holds no share (null). Charges beyond the share are a defect: the gate never takes one.
 */
export function custodyOf(checkpoint: DispatchCheckpoint): ChildCustody | null {
  const child = checkpoint.child;
  if (child === null) return null;
  const share = child.brief.share;
  const ceiling = checkpoint.child_terms?.cost_ceiling;
  if (!natural(share) || !natural(ceiling) || !natural(checkpoint.asks.route))
    throw new Error('child custody needs a natural share, ceiling and ask count');
  const per_ask = LOOP_DECISION_REQUESTS * ceiling;
  const charged = checkpoint.asks.route * per_ask;
  if (!Number.isSafeInteger(per_ask) || !Number.isSafeInteger(charged) || charged > share)
    throw new Error('child custody charges exceed the sealed share');
  return { schema: 'dispatch.custody@1', share, per_ask, charged, remainder: share - charged };
}

/** Whether the child could take one more D2 ask inside its share. */
function covers(checkpoint: DispatchCheckpoint): boolean {
  const custody = custodyOf(checkpoint)!;
  return custody.per_ask <= custody.remainder;
}

/** A journaled share gate stands only where the next D2 ask really is uncovered. */
function assertExhausted(checkpoint: DispatchCheckpoint): void {
  // Admission covers the first ask, so a gate only ever stops a re-ask of a paused D2 answer.
  const reason = checkpoint.route?.site.observation.reason;
  if (
    checkpoint.child?.brief.kind !== 'generate' ||
    witnessJoin(checkpoint.child) !== 'satisfied' ||
    (reason !== 'decision_unavailable' && reason !== 'cancelled') ||
    covers(checkpoint)
  )
    throw new Error('a share gate needs a joined generator re-asking D2 beyond its share');
}

function completedRead(receipt: unknown): receipt is Extract<DispatchReceipt, { readonly read: ReadResult }> {
  return isRecord(receipt) && receipt['status'] === 'dispatched' && isRecord(receipt['read']);
}

/** The join a frozen witness records; a generator without one is still pending. */
function witnessJoin(child: DispatchChild): 'pending' | 'satisfied' | 'unmet' {
  const dependencies = child.dependencies;
  if (dependencies === null) return 'pending';
  return dependencies.every((edge) => completedRead(edge.receipt)) ? 'satisfied' : 'unmet';
}

/** The safe sum of a satisfied generator's measured reads; otherwise null. */
function readBytes(child: DispatchChild): number | null {
  if (child.brief.kind !== 'generate' || witnessJoin(child) !== 'satisfied') return null;
  let sum = 0;
  for (const edge of child.dependencies!) sum += (edge.receipt as { readonly read: ReadResult }).read.bytes;
  return Number.isSafeInteger(sum) ? sum : null;
}

/** The same resumability that governs dispatch terminality governs an edge (D-P5c1-3). */
function edgeStatus(decision: DispatchDecision | null): 'pending' | 'satisfied' | 'unmet' {
  if (decision === null || resumable(decision)) return 'pending';
  return decision.status === 'dispatched' ? 'satisfied' : 'unmet';
}
function joinOf(statuses: readonly ('pending' | 'satisfied' | 'unmet')[]): 'pending' | 'satisfied' | 'unmet' {
  if (statuses.includes('unmet')) return 'unmet';
  return statuses.includes('pending') ? 'pending' : 'satisfied';
}

function edgeOf(decision_ref: string, decision: DispatchDecision | null): DispatchDependency {
  return {
    decision_ref,
    entry: decision?.entry ?? null,
    decision_digest: decision === null ? null : digest(decision),
    dispatch_ref: decision?.intent?.dispatch_id ?? null,
    receipt: decision === null ? null : clone(decision.receipt),
  };
}

/** A sibling read's decision must be a same-plan member whose success is a normalized completed read. */
function verifyRead(decision: DispatchDecision, verified: VerifiedChild, sibling: ChildBrief): void {
  assertDecision(decision);
  const witness: unknown = decision.child;
  const intent = decision.intent;
  if (
    decision.decision_id !== sibling.child_ref ||
    !natural(decision.entry) ||
    decision.entry < 1 ||
    !orderedKeys(witness, CHILD_KEYS) ||
    witness['parent_ref'] !== sibling.frame.parent_ref ||
    witness['parent_entry'] !== verified.parent_entry ||
    witness['plan_digest'] !== verified.plan.digest ||
    !sameRecord(witness['brief'], sibling) ||
    !sameRecord(witness['dependencies'], []) ||
    witness['dependencies_digest'] !== digest([]) ||
    (intent !== null &&
      (intent.kind !== 'read' ||
        intent.dispatch_id !== `${sibling.child_ref}:dispatch` ||
        intent.target_ref !== sibling.target_ref ||
        !sameRecord(intent.child, witness)))
  )
    throw new Error('dependency evidence is not a read of the same parent plan');
  if (
    decision.status === 'dispatched' &&
    (intent === null ||
      !completedRead(decision.receipt) ||
      !sameRecord(normalizeReceipt(decision.receipt, intent), decision.receipt))
  )
    throw new Error('a dispatched dependency has no completed read');
}

function siblingOf(verified: VerifiedChild, ref: string): ChildBrief {
  const sibling = verified.plan.children.find((candidate) => candidate.child_ref === ref);
  if (sibling === undefined || sibling.kind !== 'read') throw new Error('a dependency is not a sibling read');
  return sibling;
}

/** The witness must restate verified lineage, its own terms and exactly the supplied read snapshots. */
function verifyWitness(
  value: unknown,
  verified: VerifiedChild,
  terms: InferenceTerms,
  reads: readonly (DispatchDecision | null)[],
): void {
  const refuse = (why: string) => new Error(`recorded child witness ${why}`);
  if (!orderedKeys(value, CHILD_KEYS) || value['schema'] !== 'dispatch.child@1') throw refuse('is malformed');
  const witness = value as unknown as DispatchChild;
  if (
    witness.parent_ref !== verified.brief.frame.parent_ref ||
    witness.parent_entry !== verified.parent_entry ||
    witness.plan_digest !== verified.plan.digest ||
    !sameRecord(witness.brief, verified.brief)
  )
    throw refuse('differs from its verified parent plan');
  if (witness.terms_digest !== digest(terms)) throw refuse('binds other terms');
  const dependencies: unknown = witness.dependencies;
  if (verified.brief.kind === 'read') {
    if (!sameRecord(dependencies, []) || witness.dependencies_digest !== digest([]) || reads.length !== 0)
      throw refuse('gives a read dependencies');
    return;
  }
  if (dependencies === null) {
    if (witness.dependencies_digest !== null || reads.length !== 0) throw refuse('has unfrozen evidence');
    return;
  }
  const edges = verified.brief.frame.depends_on;
  if (
    !Array.isArray(dependencies) ||
    dependencies.length !== edges.length ||
    reads.length !== edges.length ||
    witness.dependencies_digest !== digest(dependencies)
  )
    throw refuse('does not freeze the sealed edges');
  const statuses = edges.map((ref, index) => {
    const edge: unknown = dependencies[index];
    const decision = reads[index] ?? null;
    if (!orderedKeys(edge, EDGE_KEYS) || edge['decision_ref'] !== ref) throw refuse('reorders its edges');
    if (decision !== null) verifyRead(decision, verified, siblingOf(verified, ref));
    if (!sameRecord(edge, edgeOf(ref, decision))) throw refuse('differs from its read snapshot');
    return edgeStatus(decision);
  });
  const join = joinOf(statuses);
  if (join === 'pending' || join !== witnessJoin(witness)) throw refuse('freezes a join that is not settled');
}

/**
 * A child replays only with explicit evidence: verified membership, admitted retained terms, its
 * witness against the supplied snapshots, and only the stages its kind may record.
 */
function resolveChild(request: DispatchRequest, checkpoint: DispatchCheckpoint, evidence?: ChildEvidence): Plan {
  replayChild(request, checkpoint, evidence);
  return planFor(decideBand(decide1Inputs(request, checkpoint)), checkpoint, request);
}

/** Validation and stage replay only: a reused child checkpoint may still be waiting for its D2 answer. */
function replayChild(request: DispatchRequest, checkpoint: DispatchCheckpoint, evidence?: ChildEvidence): void {
  if (evidence === undefined) throw new Error('a child decision replays only with explicit parent and read evidence');
  if (request.child === undefined || checkpoint.child === null) throw new Error(entrySwap(request.child !== undefined));
  if (request.request_id !== checkpoint.decision_id) throw new Error('checkpoint belongs to another decision');
  const verified = verifyChild(request, evidence.parent);
  if (!sameRecord(request.terms, checkpoint.child_terms))
    throw new Error('child terms differ from the retained child evidence');
  admitChildTerms(checkpoint.child_terms, verified.terms, verified.brief.share, verified.brief.kind);
  verifyWitness(checkpoint.child, verified, checkpoint.child_terms!, evidence.reads);
  const { asks } = checkpoint;
  if (
    checkpoint.intake !== null ||
    checkpoint.triage !== null ||
    checkpoint.shadow !== null ||
    checkpoint.preflight !== null ||
    checkpoint.preflight_terms !== null ||
    checkpoint.preflight_budget !== null ||
    asks.intake !== 0 ||
    asks.triage !== 0 ||
    asks.shadow !== 0 ||
    asks.preflight !== 0
  )
    throw new Error('a child records no intake, triage, shadow or preflight stage');
  if (verified.brief.kind === 'read' && (checkpoint.route !== null || asks.route !== 0))
    throw new Error('a read child records no D2');
  if (checkpoint.route !== null) {
    if (witnessJoin(checkpoint.child) !== 'satisfied') throw new Error('only a satisfied join records D2');
    replayStage(request, checkpoint, 'route');
  }
}

/** The child's decider: D2 once it ran, else the rule with the sealed kind's withheld choice. */
function childDecider(checkpoint: DispatchCheckpoint): {
  readonly decided_by: Decider;
  readonly choice: DispatchChoice;
} {
  const child = checkpoint.child!;
  if (checkpoint.route !== null) return { decided_by: 'route', choice: checkpoint.route.site.choice };
  return { decided_by: 'rule', choice: child.brief.kind === 'read' ? 'read' : child.brief.tier! };
}

/** D2's canonical child context: sealed scope, coupling, measured sizes and digests; never a body. */
function childRouteContext(child: DispatchChild): string {
  const reads = (child.dependencies ?? []).map((edge) => {
    const read = completedRead(edge.receipt) ? edge.receipt.read : null;
    return { target_ref: read?.target_ref ?? null, bytes: read?.bytes ?? null, digest: read?.digest ?? null };
  });
  return stableStringify({
    child_ref: child.brief.child_ref,
    edit: child.brief.edit,
    read: child.brief.read,
    coupling: child.brief.edit.length,
    forbid: child.brief.forbid.length,
    reads,
    read_bytes: readBytes(child),
    dependencies_digest: child.dependencies_digest,
  });
}

/**
 * A composition admission/cancellation gate can stop between stages, before a site can record it.
 * Project that code fact onto the last deciding stage; keep its stored observation untouched.
 */
function boundaryTrace(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  reason: 'stale_answer' | 'cancelled',
): Decide1Trace {
  const inputs = decide1Inputs(request, checkpoint);
  const decider = lastDecider(checkpoint);
  // A recorded tool stage is the last stage asked, so the gate withholds it (P4c).
  const stage = checkpoint.tool !== null ? 'tool' : decider.decided_by === 'rule' ? 'intake' : decider.decided_by;
  const overrides: Record<string, Decide1Fact['value']> = {
    ...(stage === 'tool' ? {} : { [`${stage}.choice`]: decider.choice }),
    [`${stage}.status`]: 'paused',
    [`${stage}.reason`]: reason,
  };
  return decideBand({
    judgments: inputs.judgments,
    ...(inputs.shadow === undefined ? {} : { shadow: inputs.shadow }),
    facts: inputs.facts.map((fact) => ({
      name: fact.name,
      value: Object.hasOwn(overrides, fact.name) ? overrides[fact.name]! : fact.value,
    })),
  });
}

/** A child's gate sets only `child.boundary` over its real facts; no stage is projected or forged. */
function childBoundaryTrace(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  reason: 'stale_answer' | 'cancelled' | 'share_exhausted',
): Decide1Trace {
  const inputs = decide1Inputs(request, checkpoint);
  return decideBand({
    ...inputs,
    facts: inputs.facts.map((fact) => (fact.name === 'child.boundary' ? { name: fact.name, value: reason } : fact)),
  });
}

function gateTrace(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  reason: 'stale_answer' | 'cancelled',
): Decide1Trace {
  return checkpoint.child === null
    ? boundaryTrace(request, checkpoint, reason)
    : childBoundaryTrace(request, checkpoint, reason);
}

function receiptResult(
  plan: Plan,
  receipt: DispatchReceipt | null,
): { readonly status: DispatchDecision['status']; readonly reason: DispatchReason } {
  if (plan.kind !== 'dispatch') throw new Error('only a dispatch plan takes a receipt');
  if (receipt === null) return { status: 'paused', reason: 'dispatch_unconfirmed' };
  if (receipt.status === 'dispatched') return { status: 'dispatched', reason: plan.reason };
  switch (receipt.reason) {
    case 'approval_required':
      return { status: 'needs_human', reason: 'approval_required' };
    case 'budget':
      return { status: 'paused', reason: 'budget' };
    case 'no_grant':
    case 'unknown_target':
    case 'conflict':
      return { status: 'refused', reason: 'refused' };
  }
}

/** A spawn is confirmed only by a receipt naming its plan digest: exactly this child set was opened. */
function normalizeReceipt(value: unknown, intent: DispatchIntent): DispatchReceipt | null {
  const dispatch_id = intent.dispatch_id;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (raw['status'] === 'dispatched') {
    const read = intent.kind === 'read';
    if (keys.length !== (read ? 4 : 3) || !keys.includes('dispatch_id') || !keys.includes('ref')) return null;
    if (raw['dispatch_id'] !== dispatch_id) return null;
    const ref = correlation(raw['ref']);
    if (ref === null) return null;
    if (intent.kind === 'spawn' && ref !== intent.plan.digest) return null;
    if (intent.kind !== 'read') return { status: 'dispatched', dispatch_id, ref };
    // A read is confirmed only as a completed immutable read of its own target.
    const result = raw['read'];
    if (
      !isRecord(result) ||
      Object.keys(result).length !== 4 ||
      result['target_ref'] !== intent.target_ref ||
      typeof result['revision'] !== 'string' ||
      correlation(result['revision']) !== result['revision'] ||
      typeof result['digest'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result['digest']) ||
      !natural(result['bytes'])
    )
      return null;
    const { target_ref, revision, digest: hash, bytes } = result as unknown as ReadResult;
    return { status: 'dispatched', dispatch_id, ref, read: { target_ref, revision, digest: hash, bytes } };
  }
  if (raw['status'] === 'refused') {
    if (keys.length !== 3 || !keys.includes('dispatch_id') || !keys.includes('reason')) return null;
    if (raw['dispatch_id'] !== dispatch_id) return null;
    const reason = raw['reason'];
    if (
      reason !== 'approval_required' &&
      reason !== 'budget' &&
      reason !== 'no_grant' &&
      reason !== 'unknown_target' &&
      reason !== 'conflict'
    )
      return null;
    return { status: 'refused', dispatch_id, reason };
  }
  return null;
}

function validateTargets(targets: DispatchRequest['targets']): void {
  if (targets === undefined) return;
  if (
    !Array.isArray(targets) ||
    targets.length > 8 ||
    Array.from(targets).some(
      (target) =>
        !isRecord(target) ||
        Object.keys(target).length !== 2 ||
        !Object.hasOwn(target, 'ref') ||
        !Object.hasOwn(target, 'summary') ||
        typeof target['ref'] !== 'string' ||
        correlation(target['ref']) !== target['ref'] ||
        typeof target['summary'] !== 'string',
    ) ||
    new Set(targets.map((target) => target.ref)).size !== targets.length
  )
    throw new Error('Invalid dispatch targets');
}

/** The disclosed catalogue's closed shape: refs and arg names pass the id screen; flags are booleans. */
function validateCatalogue(catalogue: DispatchRequest['catalogue']): void {
  if (catalogue === undefined) return;
  const entryOk = (entry: unknown): boolean => {
    if (!orderedKeys(entry, ['ref', 'purpose', 'reversible', 'args'])) return false;
    const args = entry['args'];
    return (
      typeof entry['ref'] === 'string' &&
      correlation(entry['ref']) === entry['ref'] &&
      typeof entry['purpose'] === 'string' &&
      typeof entry['reversible'] === 'boolean' &&
      Array.isArray(args) &&
      args.length <= 8 &&
      args.every(
        (arg) =>
          orderedKeys(arg, ['name', 'required']) &&
          typeof arg['name'] === 'string' &&
          correlation(arg['name']) === arg['name'] &&
          typeof arg['required'] === 'boolean',
      ) &&
      new Set(args.map((arg) => (arg as { name: string }).name)).size === args.length
    );
  };
  if (
    !Array.isArray(catalogue) ||
    catalogue.length > 8 ||
    !Array.from(catalogue).every(entryOk) ||
    new Set(catalogue.map((entry) => entry.ref)).size !== catalogue.length
  )
    throw new Error('Invalid dispatch catalogue');
}

/** The closed child request shape (R5), checked before anything is loaded or asked. */
function validateChild(request: DispatchRequest): void {
  if (request.child === undefined) return;
  const child: unknown = request.child;
  if (!isRecord(child) || Object.keys(child).length !== 1 || !isRecord(child['brief']))
    throw new Error('Invalid dispatch child: only { brief } is accepted');
  const frame = child['brief']['frame'];
  if (
    !isRecord(frame) ||
    typeof frame['parent_ref'] !== 'string' ||
    correlation(frame['parent_ref']) === null ||
    request.request_id !== child['brief']['child_ref']
  )
    throw new Error('Invalid dispatch child: the request id must be its sealed child_ref');
  if (
    !Array.isArray(request.intake.running_threads) ||
    request.intake.running_threads.length !== 0 ||
    request.triage_context !== '' ||
    request.route_context !== '' ||
    request.targets !== undefined ||
    request.catalogue !== undefined
  )
    throw new Error('Invalid dispatch child: threads, contexts, targets and catalogue must be empty');
  if (
    typeof request.intake.message !== 'string' ||
    digest({ message: request.intake.message }) !== frame['goal_digest']
  )
    throw new Error('Invalid dispatch child: intake.message differs from the sealed goal digest');
}

function captureRequest(request: DispatchRequest): DispatchRequest {
  if (request.child !== undefined)
    return {
      request_id: request.request_id,
      state_revision: request.state_revision,
      state_updated_at: request.state_updated_at,
      terms: detachTerms(request.terms),
      intake: { message: request.intake.message, running_threads: [] },
      triage_context: '',
      route_context: '',
      ...(request.resume === true ? { resume: true } : {}),
      child: { brief: clone(request.child.brief) },
    };
  return {
    request_id: request.request_id,
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    terms: { ...request.terms, destinations: [...request.terms.destinations] },
    intake: {
      message: request.intake.message,
      running_threads: request.intake.running_threads.map((thread) => ({
        thread_id: thread.thread_id,
        summary: thread.summary,
      })),
    },
    triage_context: request.triage_context,
    route_context: request.route_context,
    ...(request.resume === true ? { resume: true } : {}),
    ...(request.targets === undefined
      ? {}
      : { targets: request.targets.map((target) => ({ ref: target.ref, summary: target.summary })) }),
    ...(request.catalogue === undefined
      ? {}
      : {
          catalogue: request.catalogue.map((entry) => ({
            ref: entry.ref,
            purpose: entry.purpose,
            reversible: entry.reversible,
            args: entry.args.map((arg) => ({ name: arg.name, required: arg.required })),
          })),
        }),
  };
}

function stageId(request_id: string, stage: Stage, ask: number): string {
  return ask === 1 ? `${request_id}:${stage}` : `${request_id}:${stage}:e${ask}`;
}

function askIntake(request: DispatchRequest, ask: number): IntakeSiteInput {
  return {
    request_id: stageId(request.request_id, 'intake', ask),
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    state: {
      message: request.intake.message,
      running_threads: request.intake.running_threads.map((thread) => ({
        thread_id: thread.thread_id,
        summary: thread.summary,
      })),
    },
    terms: { ...request.terms, destinations: [...request.terms.destinations] },
    needs_dispatch: true,
  };
}

/**
 * D1 discloses `{request, context}` and D2 `{unit_of_work, context}`: the benchmark row shapes. A
 * child's D2 context is canonical data from its witness, never caller route context.
 */
function loopAsk(
  request: DispatchRequest,
  stage: 'triage' | 'route',
  ask: number,
  child: DispatchChild | null = null,
): LoopDecisionAsk {
  return {
    request_id: stageId(request.request_id, stage, ask),
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    state:
      stage === 'triage'
        ? { request: request.intake.message, context: request.triage_context }
        : {
            unit_of_work: request.intake.message,
            context: child === null ? request.route_context : childRouteContext(child),
          },
    terms: { ...request.terms, destinations: [...request.terms.destinations] },
    needs_dispatch: true,
  };
}

/**
 * How an explicit resume moves a paused decision with this reason. `reask`: the stage that
 * paused is asked again. `represent`: the claimed intent is presented again (a pre-present cancel,
 * or a budget refusal receipt). `settle`: the presented intent resolves only through its
 * settlement. `closed`: the decision is terminal.
 */
type Resume = 'reask' | 'represent' | 'settle' | 'closed';

function resumeOf(reason: DispatchReason): Resume {
  switch (reason) {
    case 'decision_unavailable':
      return 'reask';
    case 'cancelled':
    case 'budget':
      return 'represent';
    case 'dispatch_unconfirmed':
      return 'settle';
    case 'accepted':
    case 'stale_answer':
    case 'mismatched_answer':
    case 'invalid_answer':
    case 'missing_confidence':
    case 'low_confidence':
    case 'low_top_p':
    case 'no_answer':
    case 'no_tool_margin':
    case 'missing_args':
    case 'extract_missing':
    case 'invalid_extract':
    case 'structural_origin_missing':
    case 'ambiguous_reference':
    case 'no_target':
    case 'irreversible':
    case 'approval_required':
    case 'refused':
    case 'dependency_pending':
    case 'unmet_dependency':
    case 'share_exhausted':
      return 'closed';
    default: {
      const never: never = reason;
      return never;
    }
  }
}

/** A paused decision whose reason an explicit resume can move; every other decision is terminal. */
function resumable(decision: DispatchDecision): boolean {
  return decision.status === 'paused' && resumeOf(decision.reason) !== 'closed';
}

/**
 * Whether this call asks a stage. An in-flight ask for it is always joined, whatever `resume` says.
 * Unrecorded, it is asked; recorded, only an explicit resume re-asks a stage whose own
 * observation paused (an outage, or a site that saw the cancellation).
 */
function asksStage(slot: DispatchSlot, stage: DispatchAskStage, reason: string | null, resume: boolean): boolean {
  if (slot.phase === 'open' && slot.ask?.stage === stage) return true;
  if (reason === null) return true;
  return resume && (reason === 'decision_unavailable' || reason === 'cancelled');
}

function assertRuleTable(decision: DispatchDecision): void {
  if (decision.schema !== 'dispatch.decision@7')
    throw new Error('recorded dispatch decision schema differs from dispatch.decision@7');
  if (decision.rule_table !== DECIDE1_RULE_TABLE)
    throw new Error(`recorded dispatch rule table differs from ${DECIDE1_RULE_TABLE}`);
}

const sequences = new WeakMap<WeftPort, number>();

/** Pure builder: one `judgment` for each site observation, at an explicit starting sequence. */
export function dispatchJudgments(
  observations: readonly SiteObservation[],
  target: { readonly trace_id: string; readonly emitter_id: string },
  start: number,
): WeftRecordShape[] {
  const records: WeftRecordShape[] = [];
  let sequence = start;
  for (const observation of observations) {
    const request_ref = observation.request_id;
    if (request_ref === null) continue;
    const fields: Record<string, unknown> = {
      site: observation.site,
      request_ref,
      accepted: observation.accepted,
    };
    if (observation.confidence !== null) fields['confidence'] = observation.confidence;
    records.push({
      schema: 'weft.record@1',
      trace_id: target.trace_id,
      record_id: `${target.emitter_id}:judgment:${request_ref}`,
      emitter: { kind: 'loom', id: target.emitter_id },
      sequence,
      kind: 'judgment',
      thread_id: null,
      parent_id: null,
      links: [],
      evidence: [
        { source: 'observation', ref: request_ref },
        { source: 'inference_request', ref: request_ref },
      ],
      fields,
    });
    sequence += 1;
  }
  return records;
}

/** Pure projection of an appended decision; never shorten or invent a correlation id. */
export function dispatchDecided(
  decision: DispatchDecision,
  judgmentIds: readonly string[],
  target: { readonly trace_id: string; readonly emitter_id: string },
  sequence: number,
): WeftRecordShape | null {
  const record_id = `${target.emitter_id}:dispatch:${decision.decision_id}:${decision.entry}`;
  const requests = [
    decision.intake?.request_id,
    decision.triage?.site.observation.request_id,
    decision.route?.site.observation.request_id,
    ...(Array.isArray(decision.shadow)
      ? decision.shadow.flatMap((observation) => (observation?.request_id == null ? [] : [observation.request_id]))
      : []),
    decision.preflight?.request_id,
    decision.tool?.pick.request_id,
    ...(decision.tool?.extracts.map((extract) => extract.request_id) ?? []),
  ].filter((id): id is string => id != null);
  const ids = [target.trace_id, target.emitter_id, record_id, decision.decision_id, ...judgmentIds, ...requests];
  if (decision.intent !== null) ids.push(decision.intent.dispatch_id);
  if (ids.some((id) => correlation(id) === null)) return null;
  const fields: Record<string, unknown> = {
    decision_ref: decision.decision_id,
    decided_by: decision.decided_by,
    choice: decision.choice,
    status: decision.status,
  };
  if (decision.intent?.kind === 'implement') fields['tier'] = decision.intent.tier;
  if (decision.intent !== null) fields['dispatch_ref'] = decision.intent.dispatch_id;
  Object.assign(fields, clone(decision.decide1));
  return {
    schema: 'weft.record@1',
    trace_id: target.trace_id,
    record_id,
    emitter: { kind: 'loom', id: target.emitter_id },
    sequence,
    kind: 'dispatch.decided',
    thread_id: null,
    parent_id: null,
    links: judgmentIds.map((record_id) => ({ rel: 'caused_by', record_id })),
    evidence: [
      { source: 'observation', ref: decision.decision_id },
      ...requests.map((ref) => ({ source: 'inference_request', ref })),
    ],
    fields,
  };
}

function emit(port: WeftPort | undefined, observations: readonly SiteObservation[], decision: DispatchDecision): void {
  if (port === undefined) return;
  const start = (sequences.get(port) ?? 0) + 1;
  const records = dispatchJudgments(observations, port, start);
  const decided = dispatchDecided(
    decision,
    records.map((record) => record.record_id),
    port,
    start + records.length,
  );
  if (decided !== null) records.push(decided);
  // Reserve synchronously before the sink can call back into the composition.
  if (records.length > 0) sequences.set(port, start + records.length - 1);
  for (const record of records) deliver(port, record);
}

/** The pre-present cancel record: `paused / cancelled`, no receipt; pure in the checkpoint. */
function cancellation(request: DispatchRequest, checkpoint: DispatchCheckpoint, entry: number): DispatchDecision {
  const decider = checkpoint.child === null ? lastDecider(checkpoint) : childDecider(checkpoint);
  return {
    schema: 'dispatch.decision@7',
    decision_id: checkpoint.decision_id,
    entry,
    state_revision: checkpoint.state_revision,
    decided_by: decider.decided_by,
    choice: decider.choice,
    status: 'paused',
    reason: 'cancelled',
    rule_table: DECIDE1_RULE_TABLE,
    decide1: traceFields(gateTrace(request, checkpoint, 'cancelled')),
    child: checkpoint.child,
    intent: checkpoint.intent,
    receipt: null,
    intake: checkpoint.intake,
    triage: checkpoint.triage,
    route: checkpoint.route,
    tool: checkpoint.tool,
    shadow: recordedShadow(checkpoint),
    preflight: trustedRoles(checkpoint, request),
  };
}

/**
 * A local abort is a transition on the stored slot, journaled like any other decision. Before
 * present (open or claimed) it appends `paused / cancelled`; an open slot keeps its in-flight ask,
 * which a resume joins. Once presented it appends `paused / dispatch_unconfirmed`, so the abort
 * never reads as "the effect did not happen" and resolves only through the settlement. When the
 * record the abort would append equals the latest stored one, nothing is appended and the stored
 * decision is returned. A caller that cannot append (another attempt is live, or another writer
 * moved the slot) reports what the journal holds instead.
 */
function cancel(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  ports: DispatchPorts,
  journal: DispatchJournal,
  fresh: readonly SiteObservation[],
  claimed: Plan | null,
  attempt?: string,
): DispatchDecision {
  const loaded = journal.load(request.request_id);
  const entry = loaded.decisions.length + 1;
  const latest = loaded.decisions.at(-1) ?? null;
  let decision: DispatchDecision;
  switch (loaded.slot.phase) {
    case 'terminal':
      return yielded(request, journal);
    case 'open':
    case 'claimed':
      decision = cancellation(request, checkpoint, entry);
      break;
    case 'presented':
      if (claimed === null || checkpoint.intent === null) return yielded(request, journal);
      decision = makeDecision(
        request,
        checkpoint,
        entry,
        claimed,
        checkpoint.intent,
        null,
        'paused',
        'dispatch_unconfirmed',
      );
      break;
    default: {
      const never: never = loaded.slot;
      return never;
    }
  }
  if (latest !== null && sameRecord({ ...decision, entry: latest.entry }, latest)) return clone(latest);
  return settle(request, decision, ports, journal, fresh, attempt, checkpoint);
}

function stalePlan(request: DispatchRequest, checkpoint: DispatchCheckpoint): Plan {
  return planFor(gateTrace(request, checkpoint, 'stale_answer'), checkpoint, request);
}

function finishFinal(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  entry: number,
  plan: Plan,
  ports: DispatchPorts,
  journal: DispatchJournal,
  fresh: readonly SiteObservation[],
  attempt?: string,
): DispatchDecision {
  if (plan.kind !== 'final') throw new Error('finishFinal needs a final plan');
  const intent = plan.reason === 'stale_answer' ? checkpoint.intent : null;
  const decision = makeDecision(request, checkpoint, entry, plan, intent, null, plan.status, plan.reason);
  return settle(request, decision, ports, journal, fresh, attempt, checkpoint);
}

/**
 * Append is the compare-and-set that ends this call; only its winner emits. Before claim the
 * checkpoint the decision was built from is written in the same record.
 */
function settle(
  request: DispatchRequest,
  decision: DispatchDecision,
  ports: DispatchPorts,
  journal: DispatchJournal,
  fresh: readonly SiteObservation[],
  attempt?: string,
  checkpoint?: DispatchCheckpoint,
): DispatchDecision {
  const options = {
    ...(attempt === undefined ? {} : { attempt }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
  if (!journal.append(decision, options)) return yielded(request, journal);
  emit(ports.weft, fresh, decision);
  return clone(decision);
}

/**
 * What a reader observes of one decision id, from a single `load`, by an exhaustive switch on the
 * slot. Every stored decision is observed as stored. A claimed or presented slot with no decision
 * appended since its claim has nothing stored to report; an intent-less pause predates the claim.
 * An open slot with nothing stored is open, or awaiting the ask in flight. Impossible slot and
 * decision pairs throw.
 */
type Observed =
  | { readonly phase: 'stored'; readonly decision: DispatchDecision }
  | { readonly phase: 'claimed'; readonly checkpoint: DispatchCheckpoint }
  | { readonly phase: 'awaiting'; readonly ask: DispatchAsk }
  | { readonly phase: 'open' };

function observe(loaded: ReturnType<DispatchJournal['load']>): Observed {
  const latest = loaded.decisions.at(-1);
  const { slot, checkpoint } = loaded;
  switch (slot.phase) {
    case 'terminal':
      if (latest === undefined || resumable(latest))
        throw new Error('a terminal dispatch slot needs a terminal decision');
      return { phase: 'stored', decision: latest };
    case 'open':
      if (latest !== undefined && (latest.intent !== null || !resumable(latest)))
        throw new Error('an open dispatch slot holds only resumable intent-less decisions');
      if (latest !== undefined) return { phase: 'stored', decision: latest };
      return slot.ask === null ? { phase: 'open' } : { phase: 'awaiting', ask: slot.ask };
    case 'claimed':
    case 'presented':
      if (checkpoint === null || checkpoint.intent === null)
        throw new Error('a claimed dispatch slot needs its checkpoint');
      if (latest !== undefined && !resumable(latest))
        throw new Error('a claimed dispatch slot holds a terminal decision');
      if (latest !== undefined && latest.intent !== null) return { phase: 'stored', decision: latest };
      return { phase: 'claimed', checkpoint };
    default: {
      const never: never = slot;
      return never;
    }
  }
}

/**
 * Another writer won the decision's compare-and-set, or holds its claimed intent's live attempt.
 * Fail closed on our own plan and report what the journal holds: a stored decision, else the pure
 * unconfirmed projection of an intent claimed after any stored pause. `cancelled` is never a
 * projection. Nothing is written. Once a post-claim decision is stored, the returned entry never
 * runs ahead of the journal: a live attempt appends its own next entry.
 */
function yielded(request: DispatchRequest, journal: DispatchJournal): DispatchDecision {
  const loaded = journal.load(request.request_id);
  assertEntry(request, loaded);
  // A losing child validates the winner under the winner's frozen terms, not its own snapshot.
  const owner =
    request.child === undefined || loaded.checkpoint?.child_terms == null
      ? request
      : { ...request, terms: loaded.checkpoint.child_terms };
  if (request.child !== undefined) verifySaved(owner, loaded.decisions, journal);
  const observed = observe(loaded);
  switch (observed.phase) {
    case 'stored':
      return clone(observed.decision);
    case 'claimed': {
      const { checkpoint } = observed;
      const evidence = request.child === undefined ? undefined : liveEvidence(journal, owner, checkpoint.child);
      return transitionDispatch(owner, checkpoint, null, loaded.decisions.length + 1, evidence);
    }
    case 'awaiting':
    case 'open':
      throw new Error('the journal refused this decision without recording its owner');
    default: {
      const never: never = observed;
      return never;
    }
  }
}

/** Live evidence: the parent's journal and, for frozen edges, the exact entries they name. */
function liveEvidence(journal: DispatchJournal, request: DispatchRequest, child: DispatchChild | null): ChildEvidence {
  const parent = journal.load(request.child!.brief.frame.parent_ref);
  const dependencies: unknown = child?.dependencies;
  const edges = Array.isArray(dependencies) ? (dependencies as unknown[]) : [];
  return {
    parent: { checkpoint: parent.checkpoint, decisions: parent.decisions },
    reads: edges.map((edge) => {
      if (!isRecord(edge) || typeof edge['decision_ref'] !== 'string')
        throw new Error('recorded child witness is malformed');
      const entry = edge['entry'];
      return entry === null ? null : (journal.load(edge['decision_ref']).decisions[(entry as number) - 1] ?? null);
    }),
  };
}

/** Saved child decisions are verified before any is returned, so a terminal return never skips evidence. */
function verifySaved(request: DispatchRequest, decisions: readonly DispatchDecision[], journal: DispatchJournal): void {
  if (decisions.length === 0) return;
  const parent = journal.load(request.child!.brief.frame.parent_ref);
  const verified = verifyChild(request, { checkpoint: parent.checkpoint, decisions: parent.decisions });
  admitChildTerms(request.terms, verified.terms, verified.brief.share, verified.brief.kind);
  for (const decision of decisions) {
    const digested = isRecord(decision.child) ? decision.child['terms_digest'] : undefined;
    if (digested !== digest(request.terms)) throw new Error('child terms differ from the retained child evidence');
    verifyWitness(decision.child, verified, request.terms, liveEvidence(journal, request, decision.child).reads);
  }
}

/** Present the intent under the attempt this call holds; every exit ends that attempt. */
async function attemptIntent(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  entry: number,
  plan: Plan,
  intent: DispatchIntent,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal: AbortSignal | undefined,
  fresh: readonly SiteObservation[],
): Promise<DispatchDecision> {
  // A claimed spawn is never re-planned: without its port it stops before any attempt (D-P5b-4).
  if (intent.kind === 'spawn' && ports.spawn === undefined) throw new Error('a claimed spawn intent needs ports.spawn');
  const attempt = journal.acquire(request.request_id);
  if (attempt === null) return recoverAttempt(request, checkpoint, plan, intent, ports, journal, signal, fresh);
  try {
    return await dispatchIntent(request, checkpoint, entry, plan, intent, ports, journal, signal, fresh, attempt);
  } finally {
    journal.release(request.request_id, attempt);
  }
}

/**
 * Another attempt is live, so this call presents nothing. Only the port's own settlement of the
 * decision lets recovery end that attempt: it supersedes it and journals the settled receipt.
 * Unsettled, unreadable or cancelled, the attempt stays live and nothing is written.
 */
async function recoverAttempt(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  plan: Plan,
  intent: DispatchIntent,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal: AbortSignal | undefined,
  fresh: readonly SiteObservation[],
): Promise<DispatchDecision> {
  const loaded = journal.load(request.request_id);
  const live = attemptOf(loaded.slot);
  const entry = loaded.decisions.length + 1;
  if (live === null || ports.settlement === undefined) return yielded(request, journal);
  if (signal?.aborted) return cancel(request, checkpoint, ports, journal, fresh, plan);
  const receipt = await readSettlement(request, intent, ports, signal);
  if (signal?.aborted) return cancel(request, checkpoint, ports, journal, fresh, plan);
  if (receipt === null) return yielded(request, journal);
  const attempt = journal.acquire(request.request_id, live);
  if (attempt === null) return yielded(request, journal);
  try {
    return settleReceipt(request, checkpoint, entry, plan, intent, receipt, ports, journal, fresh, attempt);
  } finally {
    journal.release(request.request_id, attempt);
  }
}

async function dispatchIntent(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  entry: number,
  plan: Plan,
  intent: DispatchIntent,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal: AbortSignal | undefined,
  fresh: readonly SiteObservation[],
  attempt: string,
): Promise<DispatchDecision> {
  if (signal?.aborted) return cancel(request, checkpoint, ports, journal, fresh, plan, attempt);
  if (journal.load(request.request_id).slot.phase === 'presented') {
    // An earlier attempt may have carried the intent out, so its settlement decides before any stale gate.
    // Unsettled with the state unmoved, it is presented again: the port's idempotence by dispatch_id
    // is then the settlement (#397).
    const settled = await readSettlement(request, intent, ports, signal);
    if (signal?.aborted) return cancel(request, checkpoint, ports, journal, fresh, plan, attempt);
    if (settled !== null || !sameState(checkpoint, ports.now()))
      return settleReceipt(request, checkpoint, entry, plan, intent, settled, ports, journal, fresh, attempt);
  } else if (!sameState(checkpoint, ports.now()))
    return finishFinal(request, checkpoint, entry, stalePlan(request, checkpoint), ports, journal, fresh, attempt);
  if (signal?.aborted) return cancel(request, checkpoint, ports, journal, fresh, plan, attempt);
  if (!journal.present(request.request_id, attempt)) return yielded(request, journal);
  let raw: unknown = null;
  try {
    // The spawn port and child intents get a detached copy, so nothing a port does can reach a record.
    raw =
      intent.kind === 'spawn'
        ? await ports.spawn!(clone(intent), signal)
        : await ports.dispatch('child' in intent ? clone(intent) : intent, signal);
  } catch {
    // Never put an injected exception in evidence; the receipt is null.
    raw = null;
  }
  // Presented: an abort now journals the unconfirmed record and the port's answer is not trusted.
  if (signal?.aborted) return cancel(request, checkpoint, ports, journal, fresh, plan, attempt);
  const receipt = normalizeReceipt(raw, intent);
  return settleReceipt(request, checkpoint, entry, plan, intent, receipt, ports, journal, fresh, attempt);
}

/** The port's own settled receipt for the decision id; unreadable, unsettled or foreign reads are null. */
async function readSettlement(
  request: DispatchRequest,
  intent: DispatchIntent,
  ports: DispatchPorts,
  signal: AbortSignal | undefined,
): Promise<DispatchReceipt | null> {
  if (ports.settlement === undefined) return null;
  let raw: unknown = null;
  try {
    raw = await ports.settlement(request.request_id, signal);
  } catch {
    raw = null;
  }
  return normalizeReceipt(raw, intent);
}

/** A null receipt leaves the presented intent paused / `dispatch_unconfirmed`, never terminal. */
function settleReceipt(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  entry: number,
  plan: Plan,
  intent: DispatchIntent,
  receipt: DispatchReceipt | null,
  ports: DispatchPorts,
  journal: DispatchJournal,
  fresh: readonly SiteObservation[],
  attempt: string,
): DispatchDecision {
  const outcome = receiptResult(plan, receipt);
  const decision = makeDecision(request, checkpoint, entry, plan, intent, receipt, outcome.status, outcome.reason);
  return settle(request, decision, ports, journal, fresh, attempt);
}

/** A claimed intent stands only while its recorded stages re-derive it exactly; otherwise nothing may act on it. */
function claimedPlan(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  intent: DispatchIntent,
  evidence?: ChildEvidence,
): { readonly plan: Plan; readonly intent: DispatchIntent } {
  const plan = resolveOutcome(request, checkpoint, evidence);
  if (plan.kind !== 'dispatch') throw new Error('a recorded intent needs a dispatch plan');
  if (!sameRecord(intent, plan.intent)) throw new Error('recorded intent does not match the recorded stages');
  return { plan, intent };
}

/** Each sealed edge's latest journal decision, verified as a same-plan read, then joined. */
function joinReads(
  journal: DispatchJournal,
  verified: VerifiedChild,
): {
  readonly status: 'pending' | 'satisfied' | 'unmet';
  readonly edges: DispatchDependency[];
  readonly reads: (DispatchDecision | null)[];
} {
  const edges: DispatchDependency[] = [];
  const reads: (DispatchDecision | null)[] = [];
  const statuses: ('pending' | 'satisfied' | 'unmet')[] = [];
  for (const ref of verified.brief.frame.depends_on) {
    const sibling = siblingOf(verified, ref);
    const decisions = journal.load(ref).decisions;
    const latest = decisions.at(-1) ?? null;
    if (latest !== null) {
      verifyRead(latest, verified, sibling);
      if (latest.entry !== decisions.length) throw new Error('dependency evidence is out of journal order');
    }
    reads.push(latest === null ? null : clone(latest));
    edges.push(edgeOf(ref, latest));
    statuses.push(edgeStatus(latest));
  }
  return { status: joinOf(statuses), edges, reads };
}

type Round =
  | { readonly kind: 'asked' | 'adopted'; readonly checkpoint: DispatchCheckpoint }
  | { readonly kind: 'stopped'; readonly decision: DispatchDecision }
  /** P5c3: taking the next ask would exceed the child's share; nothing was taken or written. */
  | { readonly kind: 'uncovered' };

/**
 * One stage ask under the slot's compare-and-set: join the ask in flight for `stage`, else take
 * the next one (`bump` advances the counter), ask it, then record the answer. A caller that loses
 * either compare-and-set adopts the stage another caller recorded and contributes no fresh
 * observation; it never mints another ask for it. An abort journals the pre-answer checkpoint's
 * cancel, keeping the ask in flight for a resume to join.
 */
async function askRound(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  stage: DispatchAskStage,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal: AbortSignal | undefined,
  fresh: SiteObservation[],
  bump: (checkpoint: DispatchCheckpoint) => DispatchCheckpoint,
  run: (asked: DispatchCheckpoint) => Promise<{
    readonly checkpoint: DispatchCheckpoint;
    readonly observations: readonly SiteObservation[];
  }>,
  recorded: (checkpoint: DispatchCheckpoint) => boolean,
  covers?: (checkpoint: DispatchCheckpoint) => boolean,
): Promise<Round> {
  const decision_id = request.request_id;
  const loaded = journal.load(decision_id);
  const flight = loaded.slot.phase === 'open' ? loaded.slot.ask : null;
  // A joiner asks exactly what the stored ask bound: its counter, budget and terms are never re-carved.
  const asked =
    flight?.stage === stage && loaded.checkpoint !== null
      ? makeCheckpoint(loaded.checkpoint, { spawn_port: checkpoint.spawn_port })
      : bump(checkpoint);
  const ask: DispatchAsk = { stage, ask: askCount(asked, stage) };
  const adopt = (): Round => {
    const now = journal.load(decision_id);
    if (
      now.slot.phase === 'open' &&
      !sameAsk(now.slot.ask, ask) &&
      now.decisions.length === loaded.decisions.length &&
      now.checkpoint !== null &&
      askCount(now.checkpoint, stage) >= ask.ask &&
      recorded(now.checkpoint)
    )
      return { kind: 'adopted', checkpoint: makeCheckpoint(now.checkpoint, { spawn_port: checkpoint.spawn_port }) };
    return { kind: 'stopped', decision: yielded(request, journal) };
  };
  // Joining is free: the joined ask was charged when it was taken. Only taking one is gated, and
  // a caller whose snapshot another writer has already moved past adopts that writer's stage.
  if (flight?.stage !== stage && covers !== undefined && !covers(checkpoint)) {
    if (loaded.checkpoint !== null && askCount(loaded.checkpoint, stage) > askCount(checkpoint, stage)) return adopt();
    return { kind: 'uncovered' };
  }
  if (journal.ask(decision_id, ask, asked) === null) return adopt();
  if (signal?.aborted) return { kind: 'stopped', decision: cancel(request, asked, ports, journal, fresh, null) };
  const answer = await run(asked);
  if (signal?.aborted) return { kind: 'stopped', decision: cancel(request, asked, ports, journal, fresh, null) };
  if (!journal.record(decision_id, ask, answer.checkpoint)) return adopt();
  fresh.push(...answer.observations);
  return { kind: 'asked', checkpoint: answer.checkpoint };
}

/**
 * Re-entry of one verified child (P5c1). A read dispatches directly; a generator joins its sealed
 * reads, then uses D2 for its tier. Both share the claim, attempt, settlement and append path.
 */
async function decideChild(
  captured: DispatchRequest,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal: AbortSignal | undefined,
): Promise<DispatchDecision> {
  const decision_id = captured.request_id;
  const loaded = journal.load(decision_id);
  assertEntry(captured, loaded);
  const parent = journal.load(captured.child!.brief.frame.parent_ref);
  const verified = verifyChild(captured, { checkpoint: parent.checkpoint, decisions: parent.decisions });
  admitChildTerms(captured.terms, verified.terms, verified.brief.share, verified.brief.kind);
  if (loaded.checkpoint !== null && !sameRecord(captured.terms, loaded.checkpoint.child_terms))
    throw new Error('child terms differ from the retained child evidence');
  verifySaved(captured, loaded.decisions, journal);
  const resume = captured.resume === true;
  const observed = observe(loaded);
  if (observed.phase === 'stored' && (!resumable(observed.decision) || !resume)) return clone(observed.decision);
  const entry = loaded.decisions.length + 1;

  let checkpoint =
    loaded.checkpoint ??
    initialCheckpoint(captured, ports, {
      schema: 'dispatch.child@1',
      parent_ref: verified.brief.frame.parent_ref,
      parent_entry: verified.parent_entry,
      plan_digest: verified.plan.digest,
      brief: verified.brief,
      terms_digest: digest(captured.terms),
      dependencies: verified.brief.kind === 'read' ? [] : null,
      dependencies_digest: verified.brief.kind === 'read' ? digest([]) : null,
    });
  if (checkpoint.intent === null) checkpoint = makeCheckpoint(checkpoint, { spawn_port: ports.spawn !== undefined });
  let evidence = liveEvidence(journal, captured, checkpoint.child);
  // A claimed or reused child is re-derived before the abort check and before any reuse.
  const claimed = checkpoint.intent === null ? null : claimedPlan(captured, checkpoint, checkpoint.intent, evidence);
  if (claimed === null && loaded.checkpoint !== null) replayChild(captured, checkpoint, evidence);
  if (signal?.aborted) return cancel(captured, checkpoint, ports, journal, [], claimed?.plan ?? null);

  if (claimed !== null) {
    // Never rejoined, re-routed or re-planned: the identical intent goes through recovery.
    const { plan, intent } = claimed;
    if (!resume) {
      const decision = makeDecision(captured, checkpoint, entry, plan, intent, null, 'paused', 'dispatch_unconfirmed');
      return settle(captured, decision, ports, journal, []);
    }
    return attemptIntent(captured, checkpoint, entry, plan, intent, ports, journal, signal, []);
  }

  if (loaded.checkpoint !== null && !sameState(checkpoint, ports.now()))
    return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, []);

  const fresh: SiteObservation[] = [];
  if (verified.brief.kind === 'generate') {
    if (checkpoint.child!.dependencies === null) {
      const join = joinReads(journal, verified);
      // Pending is an unappended transient: no checkpoint, D2, effect, append or emission.
      if (join.status === 'pending') {
        const plan = resolveChild(captured, checkpoint, evidence);
        if (plan.kind !== 'final' || plan.reason !== 'dependency_pending')
          throw new Error('decide1: pending join moved');
        return makeDecision(captured, checkpoint, entry, plan, null, null, plan.status, plan.reason);
      }
      const child = { ...checkpoint.child!, dependencies: join.edges, dependencies_digest: digest(join.edges) };
      checkpoint = makeCheckpoint(checkpoint, { child });
      evidence = { parent: evidence.parent, reads: join.reads };
      if (join.status === 'unmet') {
        // Frozen once, in the record its terminal decision appends to; later polls return it.
        const plan = resolveChild(captured, checkpoint, evidence);
        return finishFinal(captured, checkpoint, entry, plan, ports, journal, fresh);
      }
    }
    if (asksStage(journal.load(decision_id).slot, 'route', checkpoint.route?.site.observation.reason ?? null, resume)) {
      const round = await askRound(
        captured,
        checkpoint,
        'route',
        ports,
        journal,
        signal,
        fresh,
        (base) => makeCheckpoint(base, { asks: { ...base.asks, route: base.asks.route + 1 } }),
        async (asked) => {
          const decision = await decideLoopRoute(
            loopAsk(captured, 'route', asked.asks.route, asked.child),
            ports,
            ports.now,
            signal,
          );
          return { checkpoint: makeCheckpoint(asked, { route: decision }), observations: [decision.site.observation] };
        },
        (stored) => stored.route !== null,
        covers,
      );
      if (round.kind === 'stopped') return round.decision;
      if (round.kind === 'uncovered') {
        // Terminal and journaled once: no later resume can afford the ask, since nothing refills a share.
        const plan = planFor(childBoundaryTrace(captured, checkpoint, 'share_exhausted'), checkpoint, captured);
        return finishFinal(captured, checkpoint, entry, plan, ports, journal, fresh);
      }
      checkpoint = round.checkpoint;
      if (round.kind === 'adopted') {
        evidence = liveEvidence(journal, captured, checkpoint.child);
        replayChild(captured, checkpoint, evidence);
      }
    }
  }

  if (signal?.aborted) return cancel(captured, checkpoint, ports, journal, fresh, null);
  const plan = resolveChild(captured, checkpoint, evidence);
  if (plan.kind === 'final') {
    if (plan.reason === 'cancelled') return cancel(captured, checkpoint, ports, journal, fresh, null);
    return finishFinal(captured, checkpoint, entry, plan, ports, journal, fresh);
  }
  if (!sameState(checkpoint, ports.now()))
    return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, fresh);
  if (signal?.aborted) return cancel(captured, checkpoint, ports, journal, fresh, null);
  if (!journal.claim(decision_id, plan.intent, checkpoint)) return yielded(captured, journal);
  checkpoint = makeCheckpoint(checkpoint, { intent: plan.intent });
  return attemptIntent(captured, checkpoint, entry, plan, plan.intent, ports, journal, signal, fresh);
}

/** Asks one root loop stage, or reuses and replays its recorded answer; null continues, a decision stops. */
async function rootStage(
  captured: DispatchRequest,
  state: { checkpoint: DispatchCheckpoint },
  stage: Stage,
  resume: boolean,
  entry: number,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal: AbortSignal | undefined,
  fresh: SiteObservation[],
): Promise<DispatchDecision | null> {
  const { checkpoint } = state;
  const reason =
    stage === 'intake'
      ? (checkpoint.intake?.reason ?? null)
      : stage === 'tool'
        ? checkpoint.tool === null
          ? null
          : toolStage(checkpoint.tool).reason
        : (checkpoint[stage]?.site.observation.reason ?? null);
  if (asksStage(journal.load(captured.request_id).slot, stage, reason, resume)) {
    const round = await askRound(
      captured,
      checkpoint,
      stage,
      ports,
      journal,
      signal,
      fresh,
      (base) =>
        makeCheckpoint(base, {
          asks: { ...base.asks, [stage]: base.asks[stage] + 1 },
          // The catalogue the ask discloses is bound with it; a resume never re-carves it.
          ...(stage === 'tool' ? { catalogue_digest: catalogueDigest(captured) } : {}),
        }),
      async (asked) => {
        const ask = asked.asks[stage];
        if (stage === 'tool') {
          const tool = await decideTool(toolAsk(captured, asked, ask), ports, ports.now, signal);
          return { checkpoint: makeCheckpoint(asked, { tool }), observations: [] };
        }
        if (stage === 'intake') {
          const intake = await decideIntake(askIntake(captured, ask), ports, ports.now, signal);
          return {
            checkpoint: makeCheckpoint(asked, { intake }),
            observations: intake.site === null ? [] : [intake.site],
          };
        }
        const decide = stage === 'triage' ? decideTriage : decideLoopRoute;
        const decision = await decide(loopAsk(captured, stage, ask), ports, ports.now, signal);
        return { checkpoint: makeCheckpoint(asked, { [stage]: decision }), observations: [decision.site.observation] };
      },
      (stored) => stored[stage] !== null,
    );
    if (round.kind === 'stopped') return round.decision;
    if (round.kind === 'uncovered') throw new Error('a root ask holds no share to gate');
    state.checkpoint = round.checkpoint;
    if (round.kind === 'asked') return null;
  }
  // A reused or adopted stage steers which stage is asked next, so it must replay before it is trusted.
  replayStage(captured, state.checkpoint, stage);
  if (!sameState(state.checkpoint, ports.now()))
    return finishFinal(captured, state.checkpoint, entry, stalePlan(captured, state.checkpoint), ports, journal, fresh);
  return null;
}

export async function decideDispatch(
  request: DispatchRequest,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal?: AbortSignal,
): Promise<DispatchDecision> {
  if (correlation(request.request_id) === null || request.request_id.length > 96)
    throw new Error('Invalid dispatch request id');
  validateTargets(request.targets);
  validateCatalogue(request.catalogue);
  validateChild(request);
  // Captured before the first await: deferred caller mutation cannot reach admitted evidence.
  const captured = captureRequest(request);
  if (captured.child !== undefined) return decideChild(captured, ports, journal, signal);
  const decision_id = captured.request_id;
  const loaded = journal.load(decision_id);
  assertEntry(captured, loaded);
  let checkpoint = loaded.checkpoint ?? initialCheckpoint(captured, ports);
  // Until claim the snapshot follows this call's composition; the claim freezes it.
  if (checkpoint.intent === null) checkpoint = makeCheckpoint(checkpoint, { spawn_port: ports.spawn !== undefined });
  const entry = loaded.decisions.length + 1;
  const resume = captured.resume === true;
  const observed = observe(loaded);
  if (observed.phase === 'stored' && (!resumable(observed.decision) || !resume)) return clone(observed.decision);

  // A claimed intent is re-derived before the abort check, so even a cancelled call never reports tampered evidence.
  const claimed = checkpoint.intent === null ? null : claimedPlan(captured, checkpoint, checkpoint.intent);
  if (signal?.aborted) return cancel(captured, checkpoint, ports, journal, [], claimed?.plan ?? null);

  if (claimed !== null) {
    const { plan, intent } = claimed;
    if (!resume) {
      const decision = makeDecision(captured, checkpoint, entry, plan, intent, null, 'paused', 'dispatch_unconfirmed');
      return settle(captured, decision, ports, journal, []);
    }
    return attemptIntent(captured, checkpoint, entry, plan, intent, ports, journal, signal, []);
  }

  if (loaded.checkpoint !== null && !sameState(checkpoint, ports.now()))
    return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, []);

  const fresh: SiteObservation[] = [];
  const state = { checkpoint };
  const stopped = await rootStage(captured, state, 'intake', resume, entry, ports, journal, signal, fresh);
  if (stopped !== null) return stopped;

  const intake = state.checkpoint.intake;
  if (intake === null) throw new Error('intake was not recorded');
  if (intake.status === 'transition' && intake.choice === 'new_thread') {
    const stoppedTriage = await rootStage(captured, state, 'triage', resume, entry, ports, journal, signal, fresh);
    if (stoppedTriage !== null) return stoppedTriage;
    const triage = state.checkpoint.triage;
    if (triage === null) throw new Error('triage was not recorded');
    if (triage.site.status === 'transition' && triage.site.observation.accepted && triage.site.choice === 'implement') {
      const stoppedRoute = await rootStage(captured, state, 'route', resume, entry, ports, journal, signal, fresh);
      if (stoppedRoute !== null) return stoppedRoute;
    }
    // P4c: an accepted capability asks Decide-2 over the disclosed catalogue before any row reads it.
    if (
      triage.site.status === 'transition' &&
      triage.site.observation.accepted &&
      triage.site.choice === 'capability' &&
      (captured.catalogue?.length ?? 0) > 0
    ) {
      const stoppedTool = await rootStage(captured, state, 'tool', resume, entry, ports, journal, signal, fresh);
      if (stoppedTool !== null) return stoppedTool;
    }
  }
  checkpoint = state.checkpoint;

  if (signal?.aborted) return cancel(captured, checkpoint, ports, journal, fresh, null);
  let plan = resolveOutcome(captured, checkpoint);
  if (plan.kind === 'final') {
    if (plan.reason === 'cancelled') return cancel(captured, checkpoint, ports, journal, fresh, null);
    return finishFinal(captured, checkpoint, entry, plan, ports, journal, fresh);
  }

  // A window round is asked at most once, and lost results are never re-asked (P4b). A round already
  // in flight when this call loaded belongs to a crashed, cancelled or concurrent caller, which look
  // the same, so it is recorded as lost and that caller's own record then adopts it. A round taken
  // while this call ran is joined exactly as its stored ask bound it, never re-carved.
  const flight = journal.load(decision_id);
  const windowAsk = flight.slot.phase === 'open' && flight.slot.ask?.stage === 'window' ? flight.slot.ask : null;
  const inherited = windowAsk !== null && sameAsk(loaded.slot.phase === 'open' ? loaded.slot.ask : null, windowAsk);
  if (inherited && flight.checkpoint !== null) {
    const lost = makeCheckpoint(flight.checkpoint, { spawn_port: checkpoint.spawn_port });
    if (!journal.record(decision_id, windowAsk, lost)) return yielded(captured, journal);
    checkpoint = lost;
    const unasked = resolveOutcome(captured, checkpoint);
    if (unasked.kind === 'final') return finishFinal(captured, checkpoint, entry, unasked, ports, journal, fresh);
    plan = unasked;
  }
  const bound = windowAsk !== null && !inherited ? flight.checkpoint : null;
  const shadowDue =
    bound !== null
      ? bound.asks.shadow === 1 && bound.shadow === null
      : checkpoint.asks.shadow === 0 && SHADOW_RULES.has(plan.trace.rule);
  const rolesDue =
    bound !== null
      ? bound.asks.preflight === 1 && bound.preflight === null
      : checkpoint.asks.preflight === 0 && PREFLIGHT_RULES.has(plan.trace.rule) && (captured.targets?.length ?? 0) > 0;
  if (shadowDue || rolesDue) {
    const round = await askRound(
      captured,
      checkpoint,
      'window',
      ports,
      journal,
      signal,
      fresh,
      (base) => ({
        ...base,
        asks: {
          ...base.asks,
          shadow: shadowDue ? 1 : base.asks.shadow,
          preflight: rolesDue ? 1 : base.asks.preflight,
        },
        // The plan budget and the terms children narrow are bound with the ask; a resume never re-carves them.
        preflight_budget: rolesDue ? preflightBudget(captured) : base.preflight_budget,
        preflight_terms: rolesDue ? detachTerms(captured.terms) : base.preflight_terms,
      }),
      async (asked) => {
        const [shadow, preflight] = await Promise.all([
          shadowDue ? askShadow(shadowAsk(captured, asked), ports, ports.now, signal) : asked.shadow,
          rolesDue ? askRoles(roleAsk(captured, asked), ports, ports.now, signal) : asked.preflight,
        ]);
        return { checkpoint: { ...asked, shadow, preflight }, observations: [] };
      },
      // The record that won spent the round; its results are adopted, even lost ones.
      () => true,
    );
    if (round.kind === 'stopped') return round.decision;
    if (round.kind === 'uncovered') throw new Error('a root ask holds no share to gate');
    checkpoint = round.checkpoint;
    const next = resolveOutcome(captured, checkpoint);
    // The only move a window may make is a role round admitting gen.route into a spawn.
    const spawned = rolesDue && plan.trace.rule === 'gen.route' && next.trace.rule === 'spawn.preflight';
    if (
      next.kind !== 'dispatch' ||
      (!spawned &&
        (next.trace.rule !== plan.trace.rule ||
          next.trace.band !== plan.trace.band ||
          !sameRecord(next.intent, plan.intent)))
    )
      throw new Error('decide1: shadow input moved the plan');
    plan = next;
  }

  if (!sameState(checkpoint, ports.now()))
    return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, fresh);
  if (signal?.aborted) return cancel(captured, checkpoint, ports, journal, fresh, null);

  let intent = checkpoint.intent;
  if (intent === null) {
    if (!journal.claim(decision_id, plan.intent, checkpoint)) return yielded(captured, journal);
    intent = plan.intent;
    checkpoint = makeCheckpoint(checkpoint, { intent });
  }
  return attemptIntent(captured, checkpoint, entry, plan, intent, ports, journal, signal, fresh);
}

/**
 * Pure replay: re-derive every recorded stage through the live pure functions (see `replayStages`),
 * then rebuild the decision from the outcome table and the receipt. `'cancelled'` in place of a
 * receipt rebuilds a journaled pre-present cancel; a post-present cancel is journaled unconfirmed
 * and replays from a null receipt. A child replays only from the
 * explicit historical `evidence` (its root parent and frozen read snapshots), never a journal lookup.
 */
export function transitionDispatch(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  receipt: DispatchReceipt | null | 'cancelled' | 'share_exhausted',
  entry = 1,
  evidence?: ChildEvidence,
): DispatchDecision {
  // Targets steer a consequential outcome, so replay screens them as `decideDispatch` does.
  validateTargets(request.targets);
  validateCatalogue(request.catalogue);
  validateChild(request);
  if (receipt === 'cancelled') {
    // The journaled pre-present cancel: a claimed intent is re-derived first, as decide does.
    assertCheckpoint(checkpoint);
    if (checkpoint.intent !== null) claimedPlan(request, checkpoint, checkpoint.intent, evidence);
    return cancellation(request, checkpoint, entry);
  }
  if (receipt === 'share_exhausted') {
    // The journaled share gate: replayed over the same evidence, and only where it really held.
    assertCheckpoint(checkpoint);
    if (checkpoint.child === null || checkpoint.intent !== null)
      throw new Error('a share gate needs an unclaimed child');
    replayChild(request, checkpoint, evidence);
    const plan = planFor(childBoundaryTrace(request, checkpoint, 'share_exhausted'), checkpoint, request);
    if (plan.kind !== 'final' || plan.reason !== 'share_exhausted') throw new Error('decide1: share gate moved');
    return makeDecision(request, checkpoint, entry, plan, null, null, plan.status, plan.reason);
  }
  const plan = resolveOutcome(request, checkpoint, evidence);
  const intent = plan.kind === 'dispatch' ? (checkpoint.intent ?? plan.intent) : null;
  if (plan.kind === 'dispatch' && checkpoint.intent !== null && !sameRecord(checkpoint.intent, plan.intent))
    throw new Error('recorded intent does not match the recorded stages');
  if (plan.kind === 'final')
    return makeDecision(request, checkpoint, entry, plan, null, null, plan.status, plan.reason);
  const normalized = receipt === null ? null : normalizeReceipt(receipt, plan.intent);
  const outcome = receiptResult(plan, normalized);
  return makeDecision(request, checkpoint, entry, plan, intent, normalized, outcome.status, outcome.reason);
}
