/**
 * Dispatch authority for intake, D1 triage and D2 route (WV-S1 P3a).
 *
 * Pure transitions return observations and dispatch nothing. This composition
 * is the only holder of the dispatch port: it journals the intent before the
 * call, maps the receipt to a closed decision record, and emits the existing
 * `judgment` kind for every fresh site observation, followed by `dispatch.decided`
 * carrying the versioned Decide-1 trace for each decision it appended.
 */
import type { EvaluationOutcome, GenerationOutcome, InferenceGateway, InferenceTerms } from '@weave/gateway';
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
import { TARGET_ROLES, preflightPlan } from './spawn.js';
import { askRoles, SPAWN_ROLES_QUESTION, type RoleAsk, type RoleObservation } from './sites/spawn-roles.js';
import type { ImplementTier } from './implement-step.js';
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
}

export type DispatchIntent =
  | {
      readonly kind: 'implement';
      readonly dispatch_id: string;
      readonly tier: ImplementTier;
      readonly ceiling: ImplementTier;
      readonly tier_source: 'route' | 'route_fallback' | 'triage_fallback';
    }
  | { readonly kind: 'capability'; readonly dispatch_id: string }
  | { readonly kind: 'done_check'; readonly dispatch_id: string }
  | { readonly kind: 'decline'; readonly dispatch_id: string }
  | {
      readonly kind: 'thread';
      readonly dispatch_id: string;
      readonly relation: 'continue_thread' | 'steer' | 'queue' | 'interrupt';
      readonly thread_ref: string;
    };

export type DispatchReceipt =
  | { readonly status: 'dispatched'; readonly dispatch_id: string; readonly ref: string }
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
  | 'dispatch_unconfirmed';

export interface DispatchCheckpoint {
  readonly schema: 'dispatch.checkpoint@3';
  readonly decision_id: string;
  readonly state_revision: number;
  readonly state_updated_at: number;
  readonly asks: {
    readonly intake: number;
    readonly triage: number;
    readonly route: number;
    readonly shadow: 0 | 1;
    readonly preflight: 0 | 1;
  };
  readonly intake: IntakeDecision | null;
  readonly triage: LoopDecision | null;
  readonly route: LoopDecision | null;
  readonly shadow: readonly ShadowObservation[] | null;
  readonly preflight: RoleObservation | null;
  readonly intent: DispatchIntent | null;
}

export interface DispatchDecision {
  readonly schema: 'dispatch.decision@4';
  readonly decision_id: string;
  readonly entry: number;
  readonly state_revision: number;
  readonly decided_by: 'intake' | 'triage' | 'route' | 'rule';
  readonly choice: SiteChoice;
  readonly status: 'dispatched' | 'needs_human' | 'paused' | 'refused';
  readonly reason: DispatchReason;
  readonly rule_table: typeof DECIDE1_RULE_TABLE;
  readonly decide1: Omit<Decide1Trace, 'table'>;
  readonly intent: DispatchIntent | null;
  readonly receipt: DispatchReceipt | null;
  readonly intake: IntakeDecision | null;
  readonly triage: LoopDecision | null;
  readonly route: LoopDecision | null;
  readonly shadow: readonly ShadowObservation[] | null;
  readonly preflight: RoleObservation | null;
}

/**
 * Each decision id is a single-writer state machine: open → claimed(intent) | terminal(decision),
 * then claimed(intent) → terminal(a decision owning that intent). A resumable pause keeps the state.
 * `claim`, `acquire` and `append` are each one atomic compare-and-set on that state: they return
 * false or null and write nothing when another writer already moved it, and the loser fails closed.
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
 * the intent stays presented, so recovery reconciles it through the settlement and never pauses it stale.
 */
export interface DispatchJournal {
  load(decision_id: string): {
    readonly checkpoint: DispatchCheckpoint | null;
    readonly decisions: readonly DispatchDecision[];
    /** The live attempt on the claimed intent, if any. */
    readonly attempt: string | null;
    /** An attempt presented the claimed intent and no receipt has been appended since. */
    readonly presented: boolean;
  };
  /** Ignored once the decision is claimed or terminal: its owner's stage evidence stands. */
  checkpoint(entry: DispatchCheckpoint): void;
  /** open → claimed: bind the intent to the exact stage snapshot the plan was derived from. */
  claim(decision_id: string, intent: DispatchIntent, checkpoint?: DispatchCheckpoint): boolean;
  /**
   * A fresh attempt on a claimed, non-terminal intent; null while another attempt is live. With
   * `supersedes`, only while that attempt is still the live one: it is retired and replaced. Only
   * recovery holding the port's settlement of the decision supersedes.
   */
  acquire(decision_id: string, supersedes?: string): string | null;
  /** Retires the attempt if it is still the live one; any other attempt is left alone. */
  release(decision_id: string, attempt: string): void;
  /** Marks the claimed intent presented, only while `attempt` is the live one; false writes nothing. */
  present(decision_id: string, attempt: string): boolean;
  /**
   * open → open | terminal for an intent-less decision; claimed → claimed | terminal for its owner:
   * the live attempt's own id, or a tokenless caller when none is live. A successful append retires
   * the live attempt.
   */
  append(decision: DispatchDecision, attempt?: string): boolean;
}

export type DispatchPort = (intent: DispatchIntent, signal?: AbortSignal) => DispatchReceipt | Promise<DispatchReceipt>;

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
}

export type ThreadTarget =
  | { readonly ok: true; readonly thread_ref: string }
  | { readonly ok: false; readonly reason: 'no_target' | 'ambiguous_reference' };

type Decider = DispatchDecision['decided_by'];
type Plan = { readonly trace: Decide1Trace } & (
  | {
      readonly kind: 'dispatch';
      readonly decided_by: Decider;
      readonly choice: SiteChoice;
      readonly reason: DispatchReason;
      readonly intent: DispatchIntent;
    }
  | {
      readonly kind: 'final';
      readonly decided_by: Decider;
      readonly choice: SiteChoice;
      readonly status: 'needs_human' | 'paused' | 'refused';
      readonly reason: DispatchReason;
    }
);

const RESUMABLE = new Set<DispatchReason>(['decision_unavailable', 'budget', 'dispatch_unconfirmed']);
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

export class MemoryDispatchJournal implements DispatchJournal {
  private readonly checkpoints = new Map<string, DispatchCheckpoint>();
  /** Claimed intents are monotonic: a later stage checkpoint never erases one. */
  private readonly intents = new Map<string, DispatchIntent>();
  /** The live attempt per decision. */
  private readonly attempts = new Map<string, string>();
  private readonly retired = new Set<string>();
  private readonly issued = new Map<string, number>();
  /** Presented intents awaiting a journaled receipt. */
  private readonly presented = new Set<string>();
  private entries: DispatchDecision[] = [];

  load(decision_id: string) {
    const checkpoint = this.checkpoints.get(decision_id);
    const intent = this.intents.get(decision_id);
    return {
      checkpoint:
        checkpoint === undefined ? null : clone(intent === undefined ? checkpoint : { ...checkpoint, intent }),
      decisions: clone(this.entries.filter((entry) => entry.decision_id === decision_id)),
      attempt: this.attempts.get(decision_id) ?? null,
      presented: this.presented.has(decision_id),
    };
  }
  private terminal(decision_id: string): boolean {
    const latest = this.entries.filter((entry) => entry.decision_id === decision_id).at(-1);
    return latest !== undefined && !isResumable(latest);
  }
  checkpoint(entry: DispatchCheckpoint): void {
    if (this.intents.has(entry.decision_id) || this.terminal(entry.decision_id)) return;
    this.checkpoints.set(entry.decision_id, clone(entry));
  }
  claim(decision_id: string, intent: DispatchIntent, snapshot?: DispatchCheckpoint): boolean {
    if (this.intents.has(decision_id) || this.terminal(decision_id)) return false;
    const current = this.checkpoints.get(decision_id);
    if (current !== undefined && current.intent !== null) return false;
    const bound = snapshot ?? current;
    if (bound !== undefined && bound.decision_id !== decision_id)
      throw new Error('claimed intent belongs to another decision');
    this.intents.set(decision_id, clone(intent));
    if (bound !== undefined) this.checkpoints.set(decision_id, clone({ ...bound, intent }));
    return true;
  }
  /** True only for the live attempt itself; a retired id never matches again. */
  private live(decision_id: string, attempt: string | undefined): boolean {
    return attempt !== undefined && !this.retired.has(attempt) && this.attempts.get(decision_id) === attempt;
  }
  private retire(decision_id: string): void {
    const live = this.attempts.get(decision_id);
    if (live === undefined) return;
    this.retired.add(live);
    this.attempts.delete(decision_id);
  }
  acquire(decision_id: string, supersedes?: string): string | null {
    if (!this.intents.has(decision_id) || this.terminal(decision_id)) return null;
    if (supersedes === undefined ? this.attempts.has(decision_id) : !this.live(decision_id, supersedes)) return null;
    this.retire(decision_id);
    const count = (this.issued.get(decision_id) ?? 0) + 1;
    this.issued.set(decision_id, count);
    const attempt = `${decision_id}:attempt:${count}`;
    if (this.retired.has(attempt)) throw new Error('an attempt id was reissued');
    this.attempts.set(decision_id, attempt);
    return attempt;
  }
  release(decision_id: string, attempt: string): void {
    if (this.live(decision_id, attempt)) this.retire(decision_id);
  }
  present(decision_id: string, attempt: string): boolean {
    if (!this.live(decision_id, attempt)) return false;
    this.presented.add(decision_id);
    return true;
  }
  append(decision: DispatchDecision, attempt?: string): boolean {
    const id = decision.decision_id;
    if (this.terminal(id)) return false;
    if (attempt !== undefined && !this.live(id, attempt)) return false;
    const claimed = this.intents.get(id);
    if (claimed === undefined) {
      if (decision.intent !== null) throw new Error('appended decision names an intent that was never claimed');
    } else if (decision.intent === null || !sameRecord(decision.intent, claimed)) {
      return false;
    } else if (attempt === undefined && this.attempts.has(id)) {
      return false;
    }
    this.entries.push(clone(decision));
    if (decision.receipt !== null) this.presented.delete(id);
    this.retire(id);
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

function initialCheckpoint(request: DispatchRequest): DispatchCheckpoint {
  return {
    schema: 'dispatch.checkpoint@3',
    decision_id: request.request_id,
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    asks: { intake: 0, triage: 0, route: 0, shadow: 0, preflight: 0 },
    intake: null,
    triage: null,
    route: null,
    shadow: null,
    preflight: null,
    intent: null,
  };
}

function makeCheckpoint(
  decision_id: string,
  state_revision: number,
  state_updated_at: number,
  asks: DispatchCheckpoint['asks'],
  intake: IntakeDecision | null,
  triage: LoopDecision | null,
  route: LoopDecision | null,
  shadow: readonly ShadowObservation[] | null,
  preflight: RoleObservation | null,
  intent: DispatchIntent | null,
): DispatchCheckpoint {
  return {
    schema: 'dispatch.checkpoint@3',
    decision_id,
    state_revision,
    state_updated_at,
    asks: {
      intake: asks.intake,
      triage: asks.triage,
      route: asks.route,
      shadow: asks.shadow,
      preflight: asks.preflight,
    },
    intake,
    triage,
    route,
    shadow,
    preflight,
    intent,
  };
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
    schema: 'dispatch.decision@4',
    decision_id: checkpoint.decision_id,
    entry,
    state_revision: checkpoint.state_revision,
    decided_by: plan.decided_by,
    choice: plan.choice,
    status,
    reason,
    rule_table: plan.trace.table,
    decide1: traceFields(plan.trace),
    intent,
    receipt,
    intake: checkpoint.intake,
    triage: checkpoint.triage,
    route: checkpoint.route,
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
  choice: SiteChoice,
  status: 'needs_human' | 'paused',
  reason: DispatchReason,
): Plan {
  return { kind: 'final', trace, decided_by, choice, status, reason };
}

function dispatchPlan(
  trace: Decide1Trace,
  decided_by: Decider,
  choice: SiteChoice,
  reason: DispatchReason,
  intent: DispatchIntent,
): Plan {
  return { kind: 'dispatch', trace, decided_by, choice, reason, intent };
}

function lastDecider(checkpoint: DispatchCheckpoint): { readonly decided_by: Decider; readonly choice: SiteChoice } {
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

type Stage = 'intake' | 'triage' | 'route';

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
  const ask = loopAsk(askedRequest(request, checkpoint), stage, stageAsk(checkpoint, stage));
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

function replayStage(request: DispatchRequest, checkpoint: DispatchCheckpoint, stage: Stage): void {
  if (request.request_id !== checkpoint.decision_id) throw new Error('checkpoint belongs to another decision');
  if (stage === 'intake') replayIntake(request, checkpoint);
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
  if (intake !== null) replayStage(request, checkpoint, 'intake');
  if (triage !== null) replayStage(request, checkpoint, 'triage');
  if (route !== null) replayStage(request, checkpoint, 'route');
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
  'act.capability',
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
        (item['top_p'] !== null && !unit(item['top_p'])) ||
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
  const shadowFacts: Decide1Fact[] = [
    { name: 'residual_ambiguity', value: triage?.extracts.at(-1)?.residual_ambiguity.count ?? null },
  ];
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
  const roles = trustedRoles(checkpoint, request);
  const reason =
    checkpoint.asks.preflight !== 1
      ? null
      : checkpoint.preflight === null
        ? 'unrecorded'
        : (roles?.reason ?? 'untrusted');
  shadowFacts.push(
    { name: 'preflight.reason', value: reason },
    { name: 'preflight.targets', value: request.targets?.length ?? 0 },
  );
  for (let i = 0; i < 8; i++) {
    const target = roles?.targets[i];
    shadowFacts.push({ name: `preflight.t${i}.role`, value: target?.role ?? null });
    if (target?.top_p != null) shadowJudgments.push({ name: `preflight.t${i}.top_p`, probability: target.top_p });
    if (target?.confidence != null)
      shadowJudgments.push({ name: `preflight.t${i}.confidence`, probability: target.confidence });
  }
  const ambiguity = triage?.extracts.at(-1)?.residual_ambiguity.count;
  const spawn =
    roles?.reason === 'answered' && ambiguity != null && route !== null && isTier(route.site.choice)
      ? preflightPlan({
          decision_id: checkpoint.decision_id,
          root_ref: checkpoint.decision_id,
          goal_digest: digest({ message: request.intake.message }),
          budget: request.terms.cost_ceiling,
          tier: route.site.choice,
          targets: (request.targets ?? []).map((t) => t.ref),
          roles: roles.targets.map((t) => t.role!),
          ambiguity,
        })
      : null;
  shadowFacts.push(
    { name: 'spawn.gain', value: spawn?.gain ?? null },
    { name: 'spawn.children', value: spawn?.plan?.children.length ?? null },
    { name: 'spawn.plan', value: spawn?.plan?.digest ?? null },
  );
  return { judgments, facts, shadow: { judgments: shadowJudgments, facts: shadowFacts } };
}

/** Rule ids fix the outcome. The request is needed only to bind the already-resolved thread id. */
function planFor(trace: Decide1Trace, checkpoint: DispatchCheckpoint, request: DispatchRequest): Plan {
  if (trace.band === 'spawn_subtasks') throw new Error('spawn_subtasks needs a sealed parent frame (D-ENG-044, P5)');
  const dispatch_id = `${checkpoint.decision_id}:dispatch`;
  const facts = new Map(trace.facts.map((fact) => [fact.name, fact.value]));
  const choice = (stage: Stage) => facts.get(`${stage}.choice`) as SiteChoice;
  const reason = (stage: Stage) => facts.get(`${stage}.reason`) as DispatchReason;
  switch (trace.rule) {
    case 'hold.admission':
    case 'hold.outage':
    case 'hold.paused': {
      const stage = (['intake', 'triage', 'route'] as const).find((stage) =>
        trace.rule === 'hold.admission'
          ? reason(stage) === 'stale_answer' || reason(stage) === 'mismatched_answer'
          : trace.rule === 'hold.outage'
            ? reason(stage) === 'decision_unavailable'
            : facts.get(`${stage}.status`) === 'paused',
      );
      if (stage === undefined) throw new Error('decide1: no withheld stage');
      return final(trace, checkpoint.intake === null ? 'rule' : stage, choice(stage), 'paused', reason(stage));
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
    case 'act.capability':
      return dispatchPlan(trace, 'triage', 'capability', 'accepted', { kind: 'capability', dispatch_id });
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
  if (checkpoint.schema !== 'dispatch.checkpoint@3')
    throw new Error('recorded dispatch checkpoint schema differs from dispatch.checkpoint@3');
}

function resolveOutcome(request: DispatchRequest, checkpoint: DispatchCheckpoint): Plan {
  assertCheckpoint(checkpoint);
  if (checkpoint.intake === null) throw new Error('a dispatch decision needs an intake record');
  replayStages(request, checkpoint);
  return planFor(decideBand(decide1Inputs(request, checkpoint)), checkpoint, request);
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
  const stage = decider.decided_by === 'rule' ? 'intake' : decider.decided_by;
  const overrides: Record<string, Decide1Fact['value']> = {
    [`${stage}.choice`]: decider.choice,
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

function normalizeReceipt(value: unknown, dispatch_id: string): DispatchReceipt | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (raw['status'] === 'dispatched') {
    if (keys.length !== 3 || !keys.includes('dispatch_id') || !keys.includes('ref')) return null;
    if (raw['dispatch_id'] !== dispatch_id) return null;
    const ref = correlation(raw['ref']);
    if (ref === null) return null;
    return { status: 'dispatched', dispatch_id, ref };
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

function captureRequest(request: DispatchRequest): DispatchRequest {
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
  };
}

function stageId(request_id: string, stage: 'intake' | 'triage' | 'route', ask: number): string {
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

/** D1 discloses `{request, context}` and D2 `{unit_of_work, context}`: the benchmark row shapes. */
function loopAsk(request: DispatchRequest, stage: 'triage' | 'route', ask: number): LoopDecisionAsk {
  return {
    request_id: stageId(request.request_id, stage, ask),
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    state:
      stage === 'triage'
        ? { request: request.intake.message, context: request.triage_context }
        : { unit_of_work: request.intake.message, context: request.route_context },
    terms: { ...request.terms, destinations: [...request.terms.destinations] },
    needs_dispatch: true,
  };
}

function shouldAsk(reason: SiteReason | 'ambiguous_reference' | null, resume: boolean): boolean {
  if (reason === null) return true;
  return resume && (reason === 'decision_unavailable' || reason === 'cancelled');
}

function isResumable(decision: DispatchDecision): boolean {
  return decision.status === 'paused' && RESUMABLE.has(decision.reason);
}

function assertRuleTable(decision: DispatchDecision): void {
  if (decision.schema !== 'dispatch.decision@4')
    throw new Error('recorded dispatch decision schema differs from dispatch.decision@4');
  if (decision.rule_table !== DECIDE1_RULE_TABLE)
    throw new Error('recorded dispatch rule table differs from decide1.rules@1');
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

function cancellation(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  entry: number,
  decider: { readonly decided_by: Decider; readonly choice: SiteChoice },
): DispatchDecision {
  return {
    schema: 'dispatch.decision@4',
    decision_id: checkpoint.decision_id,
    entry,
    state_revision: checkpoint.state_revision,
    decided_by: decider.decided_by,
    choice: decider.choice,
    status: 'paused',
    reason: 'cancelled',
    rule_table: DECIDE1_RULE_TABLE,
    decide1: traceFields(boundaryTrace(request, checkpoint, 'cancelled')),
    intent: checkpoint.intent,
    receipt: null,
    intake: checkpoint.intake,
    triage: checkpoint.triage,
    route: checkpoint.route,
    shadow: recordedShadow(checkpoint),
    preflight: trustedRoles(checkpoint, request),
  };
}

function stalePlan(request: DispatchRequest, checkpoint: DispatchCheckpoint): Plan {
  return planFor(boundaryTrace(request, checkpoint, 'stale_answer'), checkpoint, request);
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
  return settle(request, decision, ports, journal, fresh, attempt);
}

/** Append is the compare-and-set that ends this call; only its winner emits. */
function settle(
  request: DispatchRequest,
  decision: DispatchDecision,
  ports: DispatchPorts,
  journal: DispatchJournal,
  fresh: readonly SiteObservation[],
  attempt?: string,
): DispatchDecision {
  if (!journal.append(decision, attempt)) return yielded(request, journal);
  emit(ports.weft, fresh, decision);
  return clone(decision);
}

/**
 * Another writer won the decision's compare-and-set, or holds its claimed intent's live attempt.
 * Fail closed on our own plan and report what the journal holds: a terminal decision, else the
 * unconfirmed replay of a claimed intent, else the latest resumable pause. Nothing is written.
 */
function yielded(request: DispatchRequest, journal: DispatchJournal): DispatchDecision {
  const loaded = journal.load(request.request_id);
  for (const decision of loaded.decisions) assertRuleTable(decision);
  if (loaded.checkpoint !== null) assertCheckpoint(loaded.checkpoint);
  const latest = loaded.decisions.at(-1);
  const claimed = loaded.checkpoint !== null && loaded.checkpoint.intent !== null;
  if (latest !== undefined && (!isResumable(latest) || !claimed)) return clone(latest);
  if (loaded.checkpoint === null || !claimed)
    throw new Error('the journal refused this decision without recording its owner');
  return transitionDispatch(request, loaded.checkpoint, null, loaded.decisions.length + 1);
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
  const live = loaded.attempt;
  const entry = loaded.decisions.length + 1;
  if (live === null || ports.settlement === undefined) return yielded(request, journal);
  if (signal?.aborted) return cancellation(request, checkpoint, entry, lastDecider(checkpoint));
  const receipt = await readSettlement(request, intent, ports, signal);
  if (signal?.aborted) return cancellation(request, checkpoint, entry, lastDecider(checkpoint));
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
  if (signal?.aborted) return cancellation(request, checkpoint, entry, lastDecider(checkpoint));
  if (journal.load(request.request_id).presented) {
    // An earlier attempt may have carried the intent out, so its settlement decides before any stale gate.
    const settled = await readSettlement(request, intent, ports, signal);
    if (signal?.aborted) return cancellation(request, checkpoint, entry, lastDecider(checkpoint));
    if (settled !== null || !sameState(checkpoint, ports.now()))
      return settleReceipt(request, checkpoint, entry, plan, intent, settled, ports, journal, fresh, attempt);
  } else if (!sameState(checkpoint, ports.now()))
    return finishFinal(request, checkpoint, entry, stalePlan(request, checkpoint), ports, journal, fresh, attempt);
  if (signal?.aborted) return cancellation(request, checkpoint, entry, lastDecider(checkpoint));
  if (!journal.present(request.request_id, attempt)) return yielded(request, journal);
  let raw: unknown = null;
  try {
    raw = await ports.dispatch(intent, signal);
  } catch {
    raw = null;
  }
  if (signal?.aborted) return cancellation(request, checkpoint, entry, lastDecider(checkpoint));
  const receipt = normalizeReceipt(raw, intent.dispatch_id);
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
  return normalizeReceipt(raw, intent.dispatch_id);
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

export async function decideDispatch(
  request: DispatchRequest,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal?: AbortSignal,
): Promise<DispatchDecision> {
  if (correlation(request.request_id) === null || request.request_id.length > 96)
    throw new Error('Invalid dispatch request id');
  validateTargets(request.targets);
  const captured = captureRequest(request);
  const decision_id = captured.request_id;
  const loaded = journal.load(decision_id);
  for (const decision of loaded.decisions) assertRuleTable(decision);
  if (loaded.checkpoint !== null) assertCheckpoint(loaded.checkpoint);
  let checkpoint = loaded.checkpoint ?? initialCheckpoint(captured);
  const latest = loaded.decisions.at(-1) ?? null;
  const entry = loaded.decisions.length + 1;

  if (latest !== null) {
    if (!isResumable(latest)) return clone(latest);
    if (captured.resume !== true) return clone(latest);
  }

  const resume = captured.resume === true;
  if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));

  if (checkpoint.intent !== null) {
    const plan = resolveOutcome(captured, checkpoint);
    if (plan.kind !== 'dispatch') throw new Error('a recorded intent needs a dispatch plan');
    if (!sameRecord(checkpoint.intent, plan.intent))
      throw new Error('recorded intent does not match the recorded stages');
    if (!resume) {
      const decision = makeDecision(
        captured,
        checkpoint,
        entry,
        plan,
        checkpoint.intent,
        null,
        'paused',
        'dispatch_unconfirmed',
      );
      return settle(captured, decision, ports, journal, []);
    }
    return attemptIntent(captured, checkpoint, entry, plan, checkpoint.intent, ports, journal, signal, []);
  }

  if (loaded.checkpoint !== null && !sameState(checkpoint, ports.now()))
    return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, []);

  const fresh: SiteObservation[] = [];

  if (shouldAsk(checkpoint.intake?.reason ?? null, resume)) {
    const ask = checkpoint.asks.intake + 1;
    checkpoint = makeCheckpoint(
      checkpoint.decision_id,
      checkpoint.state_revision,
      checkpoint.state_updated_at,
      {
        intake: ask,
        triage: checkpoint.asks.triage,
        route: checkpoint.asks.route,
        shadow: checkpoint.asks.shadow,
        preflight: checkpoint.asks.preflight,
      },
      checkpoint.intake,
      checkpoint.triage,
      checkpoint.route,
      checkpoint.shadow,
      checkpoint.preflight,
      checkpoint.intent,
    );
    journal.checkpoint(checkpoint);
    if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
    const intake = await decideIntake(askIntake(captured, ask), ports, ports.now, signal);
    checkpoint = makeCheckpoint(
      checkpoint.decision_id,
      checkpoint.state_revision,
      checkpoint.state_updated_at,
      checkpoint.asks,
      intake,
      checkpoint.triage,
      checkpoint.route,
      checkpoint.shadow,
      checkpoint.preflight,
      checkpoint.intent,
    );
    if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
    journal.checkpoint(checkpoint);
    if (intake.site !== null) fresh.push(intake.site);
  } else {
    // A reused stage steers which stage is asked next, so it must replay before it is trusted.
    replayStage(captured, checkpoint, 'intake');
    if (!sameState(checkpoint, ports.now()))
      return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, fresh);
  }

  const intake = checkpoint.intake;
  if (intake === null) throw new Error('intake was not recorded');
  if (intake.status === 'transition' && intake.choice === 'new_thread') {
    if (shouldAsk(checkpoint.triage?.site.observation.reason ?? null, resume)) {
      const ask = checkpoint.asks.triage + 1;
      checkpoint = makeCheckpoint(
        checkpoint.decision_id,
        checkpoint.state_revision,
        checkpoint.state_updated_at,
        {
          intake: checkpoint.asks.intake,
          triage: ask,
          route: checkpoint.asks.route,
          shadow: checkpoint.asks.shadow,
          preflight: checkpoint.asks.preflight,
        },
        checkpoint.intake,
        checkpoint.triage,
        checkpoint.route,
        checkpoint.shadow,
        checkpoint.preflight,
        checkpoint.intent,
      );
      journal.checkpoint(checkpoint);
      if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
      const decision = await decideTriage(loopAsk(captured, 'triage', ask), ports, ports.now, signal);
      checkpoint = makeCheckpoint(
        checkpoint.decision_id,
        checkpoint.state_revision,
        checkpoint.state_updated_at,
        checkpoint.asks,
        checkpoint.intake,
        decision,
        checkpoint.route,
        checkpoint.shadow,
        checkpoint.preflight,
        checkpoint.intent,
      );
      if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
      journal.checkpoint(checkpoint);
      fresh.push(decision.site.observation);
    } else {
      replayStage(captured, checkpoint, 'triage');
      if (!sameState(checkpoint, ports.now()))
        return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, fresh);
    }

    const triage = checkpoint.triage;
    if (triage === null) throw new Error('triage was not recorded');
    if (triage.site.status === 'transition' && triage.site.observation.accepted && triage.site.choice === 'implement') {
      if (shouldAsk(checkpoint.route?.site.observation.reason ?? null, resume)) {
        const ask = checkpoint.asks.route + 1;
        checkpoint = makeCheckpoint(
          checkpoint.decision_id,
          checkpoint.state_revision,
          checkpoint.state_updated_at,
          {
            intake: checkpoint.asks.intake,
            triage: checkpoint.asks.triage,
            route: ask,
            shadow: checkpoint.asks.shadow,
            preflight: checkpoint.asks.preflight,
          },
          checkpoint.intake,
          checkpoint.triage,
          checkpoint.route,
          checkpoint.shadow,
          checkpoint.preflight,
          checkpoint.intent,
        );
        journal.checkpoint(checkpoint);
        if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
        const decision = await decideLoopRoute(loopAsk(captured, 'route', ask), ports, ports.now, signal);
        checkpoint = makeCheckpoint(
          checkpoint.decision_id,
          checkpoint.state_revision,
          checkpoint.state_updated_at,
          checkpoint.asks,
          checkpoint.intake,
          checkpoint.triage,
          decision,
          checkpoint.shadow,
          checkpoint.preflight,
          checkpoint.intent,
        );
        if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
        journal.checkpoint(checkpoint);
        fresh.push(decision.site.observation);
      } else {
        replayStage(captured, checkpoint, 'route');
        if (!sameState(checkpoint, ports.now()))
          return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, fresh);
      }
    }
  }

  if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
  let plan = resolveOutcome(captured, checkpoint);
  if (plan.kind === 'final') {
    if (plan.reason === 'cancelled') return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
    return finishFinal(captured, checkpoint, entry, plan, ports, journal, fresh);
  }

  const shadowDue = checkpoint.asks.shadow === 0 && SHADOW_RULES.has(plan.trace.rule);
  const rolesDue =
    checkpoint.asks.preflight === 0 && PREFLIGHT_RULES.has(plan.trace.rule) && (captured.targets?.length ?? 0) > 0;
  if (shadowDue || rolesDue) {
    checkpoint = {
      ...checkpoint,
      asks: {
        ...checkpoint.asks,
        shadow: shadowDue ? 1 : checkpoint.asks.shadow,
        preflight: rolesDue ? 1 : checkpoint.asks.preflight,
      },
    };
    journal.checkpoint(checkpoint);
    if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
    const [shadow, preflight] = await Promise.all([
      shadowDue ? askShadow(shadowAsk(captured, checkpoint), ports, ports.now, signal) : checkpoint.shadow,
      rolesDue ? askRoles(roleAsk(captured, checkpoint), ports, ports.now, signal) : checkpoint.preflight,
    ]);
    if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));
    checkpoint = { ...checkpoint, shadow, preflight };
    journal.checkpoint(checkpoint);
    const next = resolveOutcome(captured, checkpoint);
    if (
      next.trace.rule !== plan.trace.rule ||
      next.trace.band !== plan.trace.band ||
      next.kind !== 'dispatch' ||
      !sameRecord(next.intent, plan.intent)
    )
      throw new Error('decide1: shadow input moved the plan');
    plan = next;
  }

  if (!sameState(checkpoint, ports.now()))
    return finishFinal(captured, checkpoint, entry, stalePlan(captured, checkpoint), ports, journal, fresh);
  if (signal?.aborted) return cancellation(captured, checkpoint, entry, lastDecider(checkpoint));

  let intent = checkpoint.intent;
  if (intent === null) {
    if (!journal.claim(decision_id, plan.intent, checkpoint)) return yielded(captured, journal);
    intent = plan.intent;
    checkpoint = makeCheckpoint(
      checkpoint.decision_id,
      checkpoint.state_revision,
      checkpoint.state_updated_at,
      checkpoint.asks,
      checkpoint.intake,
      checkpoint.triage,
      checkpoint.route,
      checkpoint.shadow,
      checkpoint.preflight,
      intent,
    );
  }
  return attemptIntent(captured, checkpoint, entry, plan, intent, ports, journal, signal, fresh);
}

/**
 * Pure replay: re-derive every recorded stage through the live pure functions (see `replayStages`),
 * then rebuild the decision from the outcome table and the receipt.
 */
export function transitionDispatch(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  receipt: DispatchReceipt | null,
  entry = 1,
): DispatchDecision {
  const plan = resolveOutcome(request, checkpoint);
  const intent = plan.kind === 'dispatch' ? (checkpoint.intent ?? plan.intent) : null;
  if (plan.kind === 'dispatch' && checkpoint.intent !== null && !sameRecord(checkpoint.intent, plan.intent))
    throw new Error('recorded intent does not match the recorded stages');
  if (plan.kind === 'final')
    return makeDecision(request, checkpoint, entry, plan, null, null, plan.status, plan.reason);
  const normalized = receipt === null ? null : normalizeReceipt(receipt, plan.intent.dispatch_id);
  const outcome = receiptResult(plan, normalized);
  return makeDecision(request, checkpoint, entry, plan, intent, normalized, outcome.status, outcome.reason);
}
