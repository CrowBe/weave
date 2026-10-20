/**
 * Input routing (#27), per WORKSTREAM-CONTRACT.md `input.route@1`. Explicit operator direction decides first
 * and never reaches the site; with no active work a rule decides; otherwise the `input.route` choice site is
 * asked. A routing answer is an observation: applying it places the input and makes only the fixed changes
 * each outcome names. It never starts work, attaches a goal, opens a process or creates a grant.
 */
import type { InferenceGateway, InferenceTerms } from '@weave/gateway';
import { SITE_POLICY, evaluateSite, type RouteOutcome, type RouteState, type SiteChoice, type SiteObservation,
  type SiteReason, type SiteState, type SiteTransition } from './sites/index.js';
import type { Seq } from './types.js';
import {
  activeGoal, openWorkstream, transitionWorkstream, validSeq,
  type Workstream, type WorkstreamEvent, type WorkstreamIndex, type WorkstreamRefusal,
} from './workstream.js';

export type { RouteOutcome };
export const ROUTE_OUTCOMES = SITE_POLICY['input.route'].options;
/** Outcomes that act on the active goal's work, so a direction to one needs an active goal. */
const ACTIVE_ONLY: readonly RouteOutcome[] = ['steer', 'interrupt', 'queue'];
export type RouteReason = 'operator_direction' | 'invalid_direction' | 'no_active_work' | SiteReason;
export interface RouteRecord {
  readonly schema: 'input.route@1';
  readonly workstream_id: string;
  readonly input_seq: Seq;
  readonly decided_by: 'operator' | 'rule' | 'site';
  readonly outcome: RouteOutcome | null;
  readonly status: SiteTransition['status'];
  readonly reason: RouteReason;
  /** The decision-site@1 observation; null when the site was not asked. */
  readonly site: SiteObservation | null;
}
/** Evaluation evidence for `input.route`. Closed vocabulary, numbers and ids only. */
export interface RouteCorrection {
  readonly schema: 'input.route.correction@1';
  readonly workstream_id: string;
  readonly input_seq: Seq;
  readonly routed_by: RouteRecord['decided_by'];
  readonly routed: RouteOutcome | null;
  readonly corrected: RouteOutcome;
  readonly site_answer: SiteChoice | null;
  readonly site_confidence: number | null;
  readonly site_top_p: number | null;
  readonly evidence: Seq;
}
export interface RouteRequest {
  /** The workstream the input is addressed to. */
  readonly workstream: Workstream;
  readonly input_seq: Seq;
  /** Explicit operator direction from trusted ingress. Loom never reads one out of the input text. */
  readonly direction: RouteOutcome | null;
}
export interface RouteAsk extends SiteState {
  readonly request_id: string;
  readonly terms: InferenceTerms;
  /** Already filtered for disclosure. Never copied into a record. */
  readonly disclosed: { readonly input: string; readonly summary: string };
}
export interface RouteContext {
  /** The routing record's own observation; it supports every change the outcome makes. */
  readonly evidence: Seq;
  /** For `parallel`: a fresh id from an injected port. */
  readonly new_workstream_id?: string;
}
export type RouteRefusal = WorkstreamRefusal | 'no_route' | 'already_routed' | 'unchanged' | 'stale_record' |
  'invalid_direction';
export type RouteApplied = { readonly ok: true; readonly index: WorkstreamIndex } | { readonly ok: false; readonly reason: RouteRefusal };
export type RouteCorrected =
  | { readonly ok: true; readonly index: WorkstreamIndex; readonly record: RouteRecord; readonly correction: RouteCorrection }
  | { readonly ok: false; readonly reason: RouteRefusal };

function record(request: RouteRequest, decided_by: RouteRecord['decided_by'], outcome: RouteOutcome | null,
  status: RouteRecord['status'], reason: RouteReason, site: SiteObservation | null): RouteRecord {
  return { schema: 'input.route@1', workstream_id: request.workstream.workstream_id, input_seq: request.input_seq,
    decided_by, outcome, status, reason, site };
}
function outcome(value: unknown): value is RouteOutcome {
  return (ROUTE_OUTCOMES as readonly unknown[]).includes(value);
}

/** Direction, then the no-active-work rule. Null means the site must be asked. */
export function routeRule(request: RouteRequest): RouteRecord | null {
  const active = activeGoal(request.workstream) !== null;
  if (request.direction !== null) {
    return outcome(request.direction) && (active || !ACTIVE_ONLY.includes(request.direction))
      ? record(request, 'operator', request.direction, 'transition', 'operator_direction', null)
      : record(request, 'operator', null, 'needs_human', 'invalid_direction', null);
  }
  return active ? null : record(request, 'rule', 'conversation', 'transition', 'no_active_work', null);
}

/** Pure record construction, also the replay path from a recorded `input.route` site transition. */
export function transitionRoute(request: RouteRequest, site: SiteTransition | null): RouteRecord {
  const rule = routeRule(request);
  if (rule !== null) return rule;
  if (site === null || site.observation.site !== 'input.route') {
    throw new Error('Routing across active work needs a recorded input.route transition');
  }
  const chosen = site.status === 'transition' && outcome(site.choice) ? site.choice : null;
  const status = chosen === null && site.status === 'transition' ? 'needs_human' : site.status;
  return record(request, 'site', chosen, status, site.observation.reason, site.observation);
}

/** Applies the rules first; asks the site through the injected port only when they do not decide. */
export async function decideRoute(request: RouteRequest, ask: RouteAsk, port: Pick<InferenceGateway, 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number }, signal?: AbortSignal): Promise<RouteRecord> {
  const captured: RouteRequest = { workstream: request.workstream, input_seq: request.input_seq, direction: request.direction };
  if (routeRule(captured) !== null) return transitionRoute(captured, null);
  const state: RouteState = {
    input: ask.disclosed.input,
    active_work: { summary: ask.disclosed.summary, process: captured.workstream.process?.state ?? null },
  };
  const site = await evaluateSite('input.route', { request_id: ask.request_id, state_revision: ask.state_revision,
    state_updated_at: ask.state_updated_at, terms: ask.terms, state, needs_dispatch: false }, port, now, signal);
  return transitionRoute(captured, site);
}

/**
 * Places the input and makes the outcome's fixed changes, atomically. Only the operator may re-place an
 * input that is already placed; doing so first withdraws a pause request its earlier interrupt made that the
 * provider has not honoured. A pause that already happened stays.
 */
export function applyRoute(index: WorkstreamIndex, routed: RouteRecord, context: RouteContext): RouteApplied {
  if (routed.status !== 'transition' || routed.outcome === null) return { ok: false, reason: 'no_route' };
  if (!validSeq(context.evidence)) return { ok: false, reason: 'invalid_evidence' };
  const subject = index.workstreams.find(item => item.workstream_id === routed.workstream_id);
  if (!subject) return { ok: false, reason: 'unknown_workstream' };
  const entry = subject.inputs.find(input => input.seq === routed.input_seq);
  if (!entry) return { ok: false, reason: 'unknown_input' };
  if (entry.route !== null) {
    if (routed.decided_by !== 'operator') return { ok: false, reason: 'already_routed' };
    if (entry.route === routed.outcome) return { ok: false, reason: 'unchanged' };
  }
  let current = index;
  const apply = (workstream_id: string, event: WorkstreamEvent): WorkstreamRefusal | null => {
    const result = transitionWorkstream(current, workstream_id, event);
    if (!result.ok) return result.reason;
    current = result.index;
    return null;
  };
  const id = subject.workstream_id;
  const seq = routed.input_seq;
  const evidence = context.evidence;
  const process = subject.process;
  const steps: (() => WorkstreamRefusal | null)[] = [];
  if (entry.route === 'interrupt' && entry.routed_at !== null && process !== null &&
    process.state !== 'paused' && process.pause_requested === entry.routed_at) {
    steps.push(() => apply(id, { type: 'process.transition',
      event: { type: 'pause_withdrawn', request: entry.routed_at!, evidence } }));
  }
  if (routed.outcome === 'parallel') {
    const target = context.new_workstream_id;
    steps.push(() => {
      const opened = openWorkstream(current, { workstream_id: target as string, origin: 'route', evidence });
      if (!opened.ok) return opened.reason;
      current = opened.index;
      return null;
    });
    steps.push(() => apply(target as string, { type: 'input.recorded', seq }));
    steps.push(() => apply(target as string, { type: 'input.routed', seq, route: 'conversation', decided_by: 'rule',
      evidence, target: null }));
    steps.push(() => apply(id, { type: 'input.routed', seq, route: 'parallel', decided_by: routed.decided_by,
      evidence, target: target ?? null }));
  } else {
    steps.push(() => apply(id, { type: 'input.routed', seq, route: routed.outcome!, decided_by: routed.decided_by,
      evidence, target: null }));
  }
  if (routed.outcome === 'interrupt' && process !== null && process.pause_requested === null &&
    (process.state === 'idle' || process.state === 'running' || process.state === 'waiting')) {
    steps.push(() => apply(id, { type: 'process.transition', event: { type: 'pause_requested', evidence } }));
  }
  for (const step of steps) {
    const refused = step();
    if (refused !== null) return { ok: false, reason: refused };
  }
  return { ok: true, index: current };
}

/** Re-places an input on the operator's direction and records the correction as evaluation evidence. */
export function correctRoute(index: WorkstreamIndex, previous: RouteRecord, corrected: RouteOutcome,
  context: RouteContext): RouteCorrected {
  const subject = index.workstreams.find(item => item.workstream_id === previous.workstream_id);
  if (!subject) return { ok: false, reason: 'unknown_workstream' };
  const entry = subject.inputs.find(input => input.seq === previous.input_seq);
  if (!entry) return { ok: false, reason: 'unknown_input' };
  const placed = previous.status === 'transition' && previous.outcome !== null;
  const describes = placed ? entry.route === previous.outcome && entry.decided_by === previous.decided_by : entry.route === null;
  if (!describes) return { ok: false, reason: 'stale_record' };
  if (corrected === previous.outcome) return { ok: false, reason: 'unchanged' };
  const direction = routeRule({ workstream: subject, input_seq: previous.input_seq, direction: corrected })!;
  if (direction.status !== 'transition') return { ok: false, reason: 'invalid_direction' };
  const applied = applyRoute(index, direction, context);
  if (!applied.ok) return applied;
  return {
    ok: true,
    index: applied.index,
    record: direction,
    correction: {
      schema: 'input.route.correction@1',
      workstream_id: previous.workstream_id,
      input_seq: previous.input_seq,
      routed_by: previous.decided_by,
      routed: previous.outcome,
      corrected,
      site_answer: previous.site?.answer ?? null,
      site_confidence: previous.site?.confidence ?? null,
      site_top_p: previous.site?.top_p ?? null,
      evidence: context.evidence,
    },
  };
}

/** The oldest held input, offered only once the workstream has no active goal. */
export function nextQueued(workstream: Workstream): Seq | null {
  if (activeGoal(workstream) !== null) return null;
  return workstream.inputs.find(input => input.held)?.seq ?? null;
}
