/**
 * Dispatch authority for intake, D1 triage and D2 route (WV-S1 P3a).
 *
 * Pure transitions return observations and dispatch nothing. This composition
 * is the only holder of the dispatch port: it journals the intent before the
 * call, maps the receipt to a closed decision record, and emits the existing
 * `judgment` kind for every site observation it made.
 */
import type { InferenceGateway, InferenceTerms } from '@weave/gateway';
import { decideIntake, type IntakeDecision } from './intake.js';
import { decideLoopRoute, decideTriage, type LoopDecisionAsk } from './sites/loop-decide.js';
import {
  correlation,
  type IntakeSiteInput,
  type IntakeState,
  type SiteChoice,
  type SiteObservation,
  type SiteReason,
  type SiteState,
  type SiteTransition,
} from './sites/index.js';
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
  readonly schema: 'dispatch.checkpoint@1';
  readonly decision_id: string;
  readonly state_revision: number;
  readonly state_updated_at: number;
  readonly asks: {
    readonly intake: number;
    readonly triage: number;
    readonly route: number;
  };
  readonly intake: IntakeDecision | null;
  readonly triage: SiteTransition | null;
  readonly route: SiteTransition | null;
  readonly intent: DispatchIntent | null;
}

export interface DispatchDecision {
  readonly schema: 'dispatch.decision@1';
  readonly decision_id: string;
  readonly entry: number;
  readonly state_revision: number;
  readonly decided_by: 'intake' | 'triage' | 'route' | 'rule';
  readonly choice: SiteChoice;
  readonly status: 'dispatched' | 'needs_human' | 'paused' | 'refused';
  readonly reason: DispatchReason;
  readonly intent: DispatchIntent | null;
  readonly receipt: DispatchReceipt | null;
  readonly intake: IntakeDecision | null;
  readonly triage: SiteTransition | null;
  readonly route: SiteTransition | null;
}

export interface DispatchJournal {
  load(decision_id: string): {
    readonly checkpoint: DispatchCheckpoint | null;
    readonly decisions: readonly DispatchDecision[];
  };
  checkpoint(entry: DispatchCheckpoint): void;
  claim(decision_id: string, intent: DispatchIntent): boolean;
  append(decision: DispatchDecision): void;
}

export type DispatchPort = (intent: DispatchIntent, signal?: AbortSignal) => DispatchReceipt | Promise<DispatchReceipt>;

export interface DispatchPorts {
  readonly generate: InferenceGateway['generate'];
  readonly evaluate: InferenceGateway['evaluate'];
  readonly now: () => SiteState & { readonly observed_at: number };
  readonly dispatch: DispatchPort;
  readonly weft?: WeftPort;
}

export type ThreadTarget =
  | { readonly ok: true; readonly thread_ref: string }
  | { readonly ok: false; readonly reason: 'no_target' | 'ambiguous_reference' };

type Decider = DispatchDecision['decided_by'];
type Plan =
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
    };

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
  private entries: DispatchDecision[] = [];

  load(decision_id: string) {
    const checkpoint = this.checkpoints.get(decision_id);
    const intent = this.intents.get(decision_id);
    return {
      checkpoint:
        checkpoint === undefined ? null : clone(intent === undefined ? checkpoint : { ...checkpoint, intent }),
      decisions: clone(this.entries.filter((entry) => entry.decision_id === decision_id)),
    };
  }
  checkpoint(entry: DispatchCheckpoint): void {
    const intent = this.intents.get(entry.decision_id);
    this.checkpoints.set(entry.decision_id, clone(intent === undefined ? entry : { ...entry, intent }));
  }
  claim(decision_id: string, intent: DispatchIntent): boolean {
    if (this.intents.has(decision_id)) return false;
    const checkpoint = this.checkpoints.get(decision_id);
    if (checkpoint !== undefined && checkpoint.intent !== null) return false;
    this.intents.set(decision_id, clone(intent));
    if (checkpoint !== undefined) this.checkpoints.set(decision_id, { ...checkpoint, intent: clone(intent) });
    return true;
  }
  append(decision: DispatchDecision): void {
    this.entries.push(clone(decision));
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
    schema: 'dispatch.checkpoint@1',
    decision_id: request.request_id,
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    asks: { intake: 0, triage: 0, route: 0 },
    intake: null,
    triage: null,
    route: null,
    intent: null,
  };
}

function makeCheckpoint(
  decision_id: string,
  state_revision: number,
  state_updated_at: number,
  asks: DispatchCheckpoint['asks'],
  intake: IntakeDecision | null,
  triage: SiteTransition | null,
  route: SiteTransition | null,
  intent: DispatchIntent | null,
): DispatchCheckpoint {
  return {
    schema: 'dispatch.checkpoint@1',
    decision_id,
    state_revision,
    state_updated_at,
    asks: { intake: asks.intake, triage: asks.triage, route: asks.route },
    intake,
    triage,
    route,
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
    schema: 'dispatch.decision@1',
    decision_id: checkpoint.decision_id,
    entry,
    state_revision: checkpoint.state_revision,
    decided_by: plan.decided_by,
    choice: plan.choice,
    status,
    reason,
    intent,
    receipt,
    intake: checkpoint.intake,
    triage: checkpoint.triage,
    route: checkpoint.route,
  };
}

function sameState(checkpoint: DispatchCheckpoint, current: SiteState): boolean {
  return (
    checkpoint.state_revision === current.state_revision && checkpoint.state_updated_at === current.state_updated_at
  );
}

function final(
  decided_by: Decider,
  choice: SiteChoice,
  status: 'needs_human' | 'paused',
  reason: DispatchReason,
): Plan {
  return { kind: 'final', decided_by, choice, status, reason };
}

function dispatchPlan(decided_by: Decider, choice: SiteChoice, reason: DispatchReason, intent: DispatchIntent): Plan {
  return { kind: 'dispatch', decided_by, choice, reason, intent };
}

function lastDecider(checkpoint: DispatchCheckpoint): { readonly decided_by: Decider; readonly choice: SiteChoice } {
  if (checkpoint.route !== null) return { decided_by: 'route', choice: checkpoint.route.choice };
  if (checkpoint.triage !== null) return { decided_by: 'triage', choice: checkpoint.triage.choice };
  if (checkpoint.intake !== null) return { decided_by: 'intake', choice: checkpoint.intake.choice };
  return { decided_by: 'rule', choice: 'ask_user' };
}

/** Pure outcome table over recorded stage records. The first ending stage decides. */
function resolveOutcome(request: DispatchRequest, checkpoint: DispatchCheckpoint): Plan {
  const intake = checkpoint.intake;
  if (intake === null) throw new Error('a dispatch decision needs an intake record');
  const dispatch_id = `${checkpoint.decision_id}:dispatch`;

  if (intake.reason === 'stale_answer' || intake.reason === 'mismatched_answer')
    return final('intake', intake.choice, 'paused', intake.reason);
  if (intake.reason === 'decision_unavailable') return final('intake', intake.choice, 'paused', intake.reason);
  if (intake.reason === 'cancelled') return final('intake', intake.choice, 'paused', 'cancelled');
  if (intake.status === 'needs_human') return final('intake', intake.choice, 'needs_human', intake.reason);
  if (intake.status === 'paused') return final('intake', intake.choice, 'paused', intake.reason);

  if (intake.choice === 'stop') return final('rule', 'stop', 'needs_human', 'irreversible');
  if (isThreadRelation(intake.choice)) {
    const target = resolveThreadTarget(intake, request.intake.running_threads);
    if (!target.ok) return final('rule', intake.choice, 'needs_human', target.reason);
    return dispatchPlan('intake', intake.choice, intake.reason, {
      kind: 'thread',
      dispatch_id,
      relation: intake.choice,
      thread_ref: target.thread_ref,
    });
  }
  if (intake.choice !== 'new_thread') return final('intake', intake.choice, 'needs_human', intake.reason);

  const triage = checkpoint.triage;
  if (triage === null) throw new Error('a new thread needs a recorded triage');
  const triageReason = triage.observation.reason;
  if (triageReason === 'stale_answer' || triageReason === 'mismatched_answer')
    return final('triage', triage.choice, 'paused', triageReason);
  if (triageReason === 'decision_unavailable') return final('triage', triage.choice, 'paused', triageReason);
  if (triageReason === 'cancelled') return final('triage', triage.choice, 'paused', 'cancelled');
  if (triage.status === 'needs_human') return final('triage', triage.choice, 'needs_human', triageReason);
  if (triage.status === 'paused') return final('triage', triage.choice, 'paused', triageReason);

  if (triage.observation.accepted) {
    switch (triage.choice) {
      case 'capability':
        return dispatchPlan('triage', 'capability', 'accepted', { kind: 'capability', dispatch_id });
      case 'done_check':
        return dispatchPlan('triage', 'done_check', 'accepted', { kind: 'done_check', dispatch_id });
      case 'out_of_scope':
        return dispatchPlan('triage', 'out_of_scope', 'accepted', { kind: 'decline', dispatch_id });
      case 'implement':
        break;
      default:
        return final('triage', triage.choice, 'needs_human', 'invalid_answer');
    }
  } else {
    if (triage.choice !== 'implement') return final('triage', triage.choice, 'needs_human', 'invalid_answer');
    return dispatchPlan('triage', 'implement', triageReason, {
      kind: 'implement',
      dispatch_id,
      tier: 'strong',
      ceiling: 'strong',
      tier_source: 'triage_fallback',
    });
  }

  const route = checkpoint.route;
  if (route === null) throw new Error('triage implement needs a recorded route');
  const routeReason = route.observation.reason;
  if (routeReason === 'stale_answer' || routeReason === 'mismatched_answer')
    return final('route', route.choice, 'paused', routeReason);
  if (routeReason === 'decision_unavailable') return final('route', route.choice, 'paused', routeReason);
  if (routeReason === 'cancelled') return final('route', route.choice, 'paused', 'cancelled');
  if (route.status === 'needs_human') return final('route', route.choice, 'needs_human', routeReason);
  if (route.status === 'paused') return final('route', route.choice, 'paused', routeReason);
  if (route.observation.accepted && isTier(route.choice))
    return dispatchPlan('route', route.choice, 'accepted', {
      kind: 'implement',
      dispatch_id,
      tier: route.choice,
      ceiling: route.choice,
      tier_source: 'route',
    });
  return dispatchPlan('route', 'standard', routeReason, {
    kind: 'implement',
    dispatch_id,
    tier: 'standard',
    ceiling: 'standard',
    tier_source: 'route_fallback',
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

function askLoop(
  request: DispatchRequest,
  stage: 'triage' | 'route',
  ask: number,
  state:
    | { readonly request: string; readonly context: string }
    | { readonly unit_of_work: string; readonly context: string },
): LoopDecisionAsk {
  return {
    request_id: stageId(request.request_id, stage, ask),
    state_revision: request.state_revision,
    state_updated_at: request.state_updated_at,
    state,
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

function emit(port: WeftPort | undefined, observations: readonly SiteObservation[]): void {
  if (port === undefined || observations.length === 0) return;
  const start = (sequences.get(port) ?? 0) + 1;
  const records = dispatchJudgments(observations, port, start);
  for (const record of records) deliver(port, record);
  if (records.length > 0) sequences.set(port, start + records.length - 1);
}

function cancellation(
  checkpoint: DispatchCheckpoint,
  entry: number,
  decider: { readonly decided_by: Decider; readonly choice: SiteChoice },
): DispatchDecision {
  return {
    schema: 'dispatch.decision@1',
    decision_id: checkpoint.decision_id,
    entry,
    state_revision: checkpoint.state_revision,
    decided_by: decider.decided_by,
    choice: decider.choice,
    status: 'paused',
    reason: 'cancelled',
    intent: checkpoint.intent,
    receipt: null,
    intake: checkpoint.intake,
    triage: checkpoint.triage,
    route: checkpoint.route,
  };
}

function stalePlan(checkpoint: DispatchCheckpoint): Plan {
  const decider = lastDecider(checkpoint);
  return final(decider.decided_by, decider.choice, 'paused', 'stale_answer');
}

function finishFinal(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  entry: number,
  plan: Plan,
  ports: DispatchPorts,
  journal: DispatchJournal,
  fresh: readonly SiteObservation[],
): DispatchDecision {
  if (plan.kind !== 'final') throw new Error('finishFinal needs a final plan');
  const decision = makeDecision(request, checkpoint, entry, plan, null, null, plan.status, plan.reason);
  journal.append(decision);
  emit(ports.weft, fresh);
  return clone(decision);
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
): Promise<DispatchDecision> {
  if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
  if (!sameState(checkpoint, ports.now()))
    return finishFinal(request, checkpoint, entry, stalePlan(checkpoint), ports, journal, fresh);
  if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
  let raw: unknown = null;
  try {
    raw = await ports.dispatch(intent, signal);
  } catch {
    raw = null;
  }
  if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
  const receipt = normalizeReceipt(raw, intent.dispatch_id);
  const outcome = receiptResult(plan, receipt);
  const decision = makeDecision(request, checkpoint, entry, plan, intent, receipt, outcome.status, outcome.reason);
  journal.append(decision);
  emit(ports.weft, fresh);
  return clone(decision);
}

export async function decideDispatch(
  request: DispatchRequest,
  ports: DispatchPorts,
  journal: DispatchJournal,
  signal?: AbortSignal,
): Promise<DispatchDecision> {
  if (correlation(request.request_id) === null || request.request_id.length > 96)
    throw new Error('Invalid dispatch request id');
  const captured = captureRequest(request);
  const decision_id = captured.request_id;
  const loaded = journal.load(decision_id);
  let checkpoint = loaded.checkpoint ?? initialCheckpoint(captured);
  const latest = loaded.decisions.at(-1) ?? null;
  const entry = loaded.decisions.length + 1;

  if (latest !== null) {
    if (!isResumable(latest)) return clone(latest);
    if (captured.resume !== true) return clone(latest);
  }

  const resume = captured.resume === true;
  if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));

  if (checkpoint.intent !== null) {
    const plan = resolveOutcome(captured, checkpoint);
    if (plan.kind !== 'dispatch') throw new Error('a recorded intent needs a dispatch plan');
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
      journal.append(decision);
      return clone(decision);
    }
    return dispatchIntent(captured, checkpoint, entry, plan, checkpoint.intent, ports, journal, signal, []);
  }

  if (loaded.checkpoint !== null && !sameState(checkpoint, ports.now()))
    return finishFinal(captured, checkpoint, entry, stalePlan(checkpoint), ports, journal, []);

  const fresh: SiteObservation[] = [];

  if (shouldAsk(checkpoint.intake?.reason ?? null, resume)) {
    const ask = checkpoint.asks.intake + 1;
    checkpoint = makeCheckpoint(
      checkpoint.decision_id,
      checkpoint.state_revision,
      checkpoint.state_updated_at,
      { intake: ask, triage: checkpoint.asks.triage, route: checkpoint.asks.route },
      checkpoint.intake,
      checkpoint.triage,
      checkpoint.route,
      checkpoint.intent,
    );
    journal.checkpoint(checkpoint);
    if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
    const intake = await decideIntake(askIntake(captured, ask), ports, ports.now, signal);
    checkpoint = makeCheckpoint(
      checkpoint.decision_id,
      checkpoint.state_revision,
      checkpoint.state_updated_at,
      checkpoint.asks,
      intake,
      checkpoint.triage,
      checkpoint.route,
      checkpoint.intent,
    );
    if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
    journal.checkpoint(checkpoint);
    if (intake.site !== null) fresh.push(intake.site);
  } else if (!sameState(checkpoint, ports.now())) {
    return finishFinal(captured, checkpoint, entry, stalePlan(checkpoint), ports, journal, fresh);
  }

  const intake = checkpoint.intake;
  if (intake === null) throw new Error('intake was not recorded');
  if (intake.status === 'transition' && intake.choice === 'new_thread') {
    if (shouldAsk(checkpoint.triage?.observation.reason ?? null, resume)) {
      const ask = checkpoint.asks.triage + 1;
      checkpoint = makeCheckpoint(
        checkpoint.decision_id,
        checkpoint.state_revision,
        checkpoint.state_updated_at,
        { intake: checkpoint.asks.intake, triage: ask, route: checkpoint.asks.route },
        checkpoint.intake,
        checkpoint.triage,
        checkpoint.route,
        checkpoint.intent,
      );
      journal.checkpoint(checkpoint);
      if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
      const decision = await decideTriage(
        askLoop(captured, 'triage', ask, { request: captured.intake.message, context: captured.triage_context }),
        ports,
        ports.now,
        signal,
      );
      checkpoint = makeCheckpoint(
        checkpoint.decision_id,
        checkpoint.state_revision,
        checkpoint.state_updated_at,
        checkpoint.asks,
        checkpoint.intake,
        decision.site,
        checkpoint.route,
        checkpoint.intent,
      );
      if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
      journal.checkpoint(checkpoint);
      fresh.push(decision.site.observation);
    } else if (!sameState(checkpoint, ports.now())) {
      return finishFinal(captured, checkpoint, entry, stalePlan(checkpoint), ports, journal, fresh);
    }

    const triage = checkpoint.triage;
    if (triage === null) throw new Error('triage was not recorded');
    if (triage.status === 'transition' && triage.observation.accepted && triage.choice === 'implement') {
      if (shouldAsk(checkpoint.route?.observation.reason ?? null, resume)) {
        const ask = checkpoint.asks.route + 1;
        checkpoint = makeCheckpoint(
          checkpoint.decision_id,
          checkpoint.state_revision,
          checkpoint.state_updated_at,
          { intake: checkpoint.asks.intake, triage: checkpoint.asks.triage, route: ask },
          checkpoint.intake,
          checkpoint.triage,
          checkpoint.route,
          checkpoint.intent,
        );
        journal.checkpoint(checkpoint);
        if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
        const decision = await decideLoopRoute(
          askLoop(captured, 'route', ask, {
            unit_of_work: captured.intake.message,
            context: captured.route_context,
          }),
          ports,
          ports.now,
          signal,
        );
        checkpoint = makeCheckpoint(
          checkpoint.decision_id,
          checkpoint.state_revision,
          checkpoint.state_updated_at,
          checkpoint.asks,
          checkpoint.intake,
          checkpoint.triage,
          decision.site,
          checkpoint.intent,
        );
        if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
        journal.checkpoint(checkpoint);
        fresh.push(decision.site.observation);
      } else if (!sameState(checkpoint, ports.now())) {
        return finishFinal(captured, checkpoint, entry, stalePlan(checkpoint), ports, journal, fresh);
      }
    }
  }

  if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));
  const plan = resolveOutcome(captured, checkpoint);
  if (plan.kind === 'final') {
    if (plan.reason === 'cancelled') return cancellation(checkpoint, entry, lastDecider(checkpoint));
    return finishFinal(captured, checkpoint, entry, plan, ports, journal, fresh);
  }

  if (!sameState(checkpoint, ports.now()))
    return finishFinal(captured, checkpoint, entry, stalePlan(checkpoint), ports, journal, fresh);
  if (signal?.aborted) return cancellation(checkpoint, entry, lastDecider(checkpoint));

  let intent = checkpoint.intent;
  if (intent === null) {
    if (!journal.claim(decision_id, plan.intent))
      return makeDecision(captured, checkpoint, entry, plan, plan.intent, null, 'paused', 'dispatch_unconfirmed');
    intent = plan.intent;
    checkpoint = makeCheckpoint(
      checkpoint.decision_id,
      checkpoint.state_revision,
      checkpoint.state_updated_at,
      checkpoint.asks,
      checkpoint.intake,
      checkpoint.triage,
      checkpoint.route,
      intent,
    );
  }
  return dispatchIntent(captured, checkpoint, entry, plan, intent, ports, journal, signal, fresh);
}

function sameIntent(left: DispatchIntent, right: DispatchIntent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Pure replay: rebuild the decision from the recorded stages and receipt. */
export function transitionDispatch(
  request: DispatchRequest,
  checkpoint: DispatchCheckpoint,
  receipt: DispatchReceipt | null,
  entry = 1,
): DispatchDecision {
  if (request.request_id !== checkpoint.decision_id) throw new Error('checkpoint belongs to another decision');
  if (checkpoint.route !== null && checkpoint.triage === null)
    throw new Error('a recorded route needs a recorded triage');
  if (checkpoint.route !== null && checkpoint.triage !== null && !checkpoint.triage.observation.accepted)
    throw new Error('a recorded route cannot follow a triage fallback');
  if (
    checkpoint.triage !== null &&
    (checkpoint.intake === null ||
      checkpoint.intake.status !== 'transition' ||
      checkpoint.intake.choice !== 'new_thread')
  )
    throw new Error('a recorded triage needs intake new_thread');
  const plan = resolveOutcome(request, checkpoint);
  const intent = plan.kind === 'dispatch' ? (checkpoint.intent ?? plan.intent) : null;
  if (plan.kind === 'dispatch' && checkpoint.intent !== null && !sameIntent(checkpoint.intent, plan.intent))
    throw new Error('recorded intent does not match the recorded stages');
  if (plan.kind === 'final')
    return makeDecision(request, checkpoint, entry, plan, null, null, plan.status, plan.reason);
  const normalized = receipt === null ? null : normalizeReceipt(receipt, plan.intent.dispatch_id);
  const outcome = receiptResult(plan, normalized);
  return makeDecision(request, checkpoint, entry, plan, intent, normalized, outcome.status, outcome.reason);
}
