/**
 * The M0 runtime (docs/m0-inspect-and-report.md §7–§10).
 *
 * `Runtime` owns the observation log, derived state, the cycle, dispatch, and
 * the trace. It reaches capabilities only through the `CapabilityHost`
 * interface and asks for weights only through the `DecisionLayer` judgment
 * site. In replay mode both are resolved from the recorded log instead, and
 * touching either is an error.
 */
import { bindSelectors, type CapabilityContract, type CapabilityHost, type Grant, type InvocationOutcome } from '@weave/agentsop';
import { PROCEDURE, formCandidates, successEvidencePresent, type Describe } from './candidates.js';
import { candidateSetDigest } from './digest.js';
import { select } from './scheduler.js';
import { stableStringify } from './stable-json.js';
import { applyAccepted, initialState, snapshot, type MutableState } from './state.js';
import type {
  ActionId,
  ActionOutcome,
  ActionResultPayload,
  ActionStartedPayload,
  Candidate,
  CycleOutcome,
  CycleRecord,
  DecisionLayer,
  NotSelectedReason,
  Observation,
  ObservationInput,
  ProvenanceKind,
  ReplayResult,
  Seq,
  State,
  Trace,
  WeighRequest,
  WeightEntry,
  WeightsRecordedPayload,
} from './types.js';
import { validate } from './validation.js';

export { ScriptedDecisionLayer } from './decision.js';
export { foldState } from './state.js';

export interface RuntimeOptions {
  readonly host: CapabilityHost;
  readonly decisionLayer: DecisionLayer;
}

const RUNTIME_SOURCE = { kind: 'runtime', id: 'weave' } as const;
const HOST_SOURCE = { kind: 'host', id: 'capability-host' } as const;

/** Observations the cycle appends itself; everything else is an external arrival that triggers a cycle. */
const CYCLE_APPENDED: readonly ProvenanceKind[] = ['runtime', 'judgment'];

export class ReplayFailureError extends Error {
  constructor(
    readonly at_seq: Seq | null,
    readonly action_id: ActionId | null,
    reason: string,
  ) {
    super(reason);
    this.name = 'ReplayFailureError';
  }
}

interface WeighResult {
  readonly implementation: string;
  readonly weights: readonly WeightEntry[];
}

/** How a cycle resolves judgment and execution: live against the host and decision layer, or from a recorded log. */
interface Environment {
  weigh(request: WeighRequest): WeighResult;
  /** Perform a dispatched action. Returns a synchronous outcome when the action completes within the cycle. */
  execute(started: ActionStartedPayload, contract: CapabilityContract | null): ActionOutcome | null;
}

export class Runtime {
  private readonly log: Observation[] = [];
  private readonly cycles: CycleRecord[] = [];
  private readonly current: MutableState = initialState();
  private readonly settled = new Map<ActionId, Promise<void>>();
  private readonly environment: Environment;
  private readonly describe: Describe;

  constructor(
    private readonly options: RuntimeOptions,
    recorded: readonly Observation[] | null = null,
  ) {
    this.describe = (operation) => {
      const described = options.host.describe(operation);
      return described.kind === 'contract' ? described.contract : null;
    };
    this.environment = recorded ? this.replayEnvironment(recorded) : this.liveEnvironment();
  }

  /** Append an observation. A cycle runs when it is accepted, external, and a goal is open. */
  observe(input: ObservationInput): Observation {
    const observation = this.append(input);
    if (
      observation.validation.status === 'accepted' &&
      !CYCLE_APPENDED.includes(observation.source.kind) &&
      this.current.goal?.status === 'active'
    ) {
      this.runCycle(observation.seq);
    }
    return observation;
  }

  /** Resolves once the named action's result has been integrated into the log. */
  settle(action_id: ActionId): Promise<void> {
    const pending = this.settled.get(action_id);
    if (pending) {
      return pending;
    }
    const record = this.current.actions[action_id];
    if (record && record.state !== 'running' && record.state !== 'pending') {
      return Promise.resolve();
    }
    return Promise.reject(new Error(`no dispatched action ${action_id}`));
  }

  state(): State {
    return snapshot(this.current);
  }

  trace(): Trace {
    return structuredClone({ observations: this.log, cycles: this.cycles });
  }

  // -------------------------------------------------------------------------
  // Log
  // -------------------------------------------------------------------------

  private nextSeq(): Seq {
    return this.log.length + 1;
  }

  private append(input: ObservationInput): Observation {
    const observation: Observation = {
      ...input,
      seq: this.nextSeq(),
      validation: validate(input, this.current),
    };
    this.log.push(observation);
    if (observation.validation.status === 'accepted') {
      applyAccepted(this.current, observation);
    }
    return observation;
  }

  // -------------------------------------------------------------------------
  // §7 The cycle
  // -------------------------------------------------------------------------

  private runCycle(trigger: Seq): void {
    const cycle_no = this.cycles.length + 1;
    const state_revision = this.current.state_revision;
    const state = this.state();

    const formation = formCandidates(state, this.describe);
    const candidates: Candidate[] = [...formation.candidates];
    const eligible = candidates.filter((c) => c.eligibility.status === 'allowed');

    let weights_ref: Seq | null = null;
    let outcome: CycleOutcome | null = null;
    let selection: ReturnType<typeof select> = { selected: [], not_selected: [] };

    if (eligible.length > 0) {
      const judgments = this.current.budget.judgments;
      if (judgments.limit - judgments.reserved - judgments.spent < 1) {
        outcome = { status: 'blocked', reason: 'judgments budget exhausted' };
      } else {
        const request: WeighRequest = {
          site: 'frontier.weigh',
          state_revision,
          candidate_set: candidateSetDigest(eligible.map((c) => c.candidate_id)),
          candidates: eligible,
        };
        const result = this.environment.weigh(request);
        const payload: WeightsRecordedPayload = {
          site: request.site,
          implementation: result.implementation,
          state_revision: request.state_revision,
          candidate_set: request.candidate_set,
          weights: result.weights,
        };
        const recorded = this.append({
          observation_id: `weights:c${cycle_no}`,
          source: { kind: 'judgment', id: result.implementation },
          caused_by: trigger,
          payload_type: 'weights.recorded',
          payload_version: 1,
          payload,
        });
        if (recorded.validation.status !== 'accepted') {
          const why = recorded.validation.status === 'rejected' ? recorded.validation.reason : 'unknown type';
          outcome = { status: 'blocked', reason: `weights rejected: ${why}` };
        } else {
          weights_ref = recorded.seq;
          const byId = new Map(result.weights.map((w) => [w.candidate_id, w.weight]));
          for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i] as Candidate;
            const weight = byId.get(candidate.candidate_id);
            if (candidate.eligibility.status === 'allowed' && weight !== undefined) {
              candidates[i] = { ...candidate, weight };
            }
          }
          selection = select(
            candidates.filter((c) => c.eligibility.status === 'allowed' && c.weight !== null),
            this.state(),
          );
        }
      }
    }

    const selected: { candidate_id: string; action_id: ActionId; reservation: Candidate['resources'] }[] = [];
    let completed = false;
    selection.selected.forEach((candidate, index) => {
      const action_id = `a:${cycle_no}:${index + 1}`;
      selected.push({ candidate_id: candidate.candidate_id, action_id, reservation: candidate.resources });
      const result = this.dispatch(action_id, candidate, weights_ref);
      if (candidate.operation === 'goal.complete' && result?.outcome === 'succeeded') {
        completed = true;
      }
    });

    if (outcome === null) {
      outcome = this.cycleOutcome(completed, selected.length, selection.not_selected, candidates, formation.unavailable);
    }

    this.cycles.push({
      cycle_no,
      state_revision,
      procedure: PROCEDURE,
      candidates,
      weights_ref,
      selected,
      not_selected: selection.not_selected,
      outcome,
    });
  }

  private cycleOutcome(
    completed: boolean,
    dispatched: number,
    not_selected: readonly { reason: NotSelectedReason }[],
    candidates: readonly Candidate[],
    unavailable: readonly string[],
  ): CycleOutcome {
    if (completed) {
      return { status: 'complete' };
    }
    if (dispatched > 0) {
      return { status: 'dispatched' };
    }
    const running = Object.values(this.current.actions).some((a) => a.state === 'running' || a.state === 'pending');
    if (running) {
      return { status: 'waiting' };
    }
    return { status: 'blocked', reason: blockedReason(not_selected, candidates, unavailable) };
  }

  // -------------------------------------------------------------------------
  // §7 step 5 Dispatch
  // -------------------------------------------------------------------------

  private dispatch(action_id: ActionId, candidate: Candidate, weights_ref: Seq | null): ActionOutcome | null {
    const contract = candidate.contract_rev === null ? null : this.describe(candidate.operation);
    const grant = contract ? this.issueGrant(action_id, candidate, contract) : null;
    const started: ActionStartedPayload = {
      action_id,
      candidate_id: candidate.candidate_id,
      operation: candidate.operation,
      contract_rev: candidate.contract_rev,
      inputs: candidate.inputs,
      read_set: candidate.read_set,
      effects: candidate.effects,
      reservation: candidate.resources,
      grant,
    };
    const recorded = this.append({
      observation_id: `started:${action_id}`,
      source: RUNTIME_SOURCE,
      caused_by: weights_ref,
      payload_type: 'action.started',
      payload_version: 1,
      payload: started,
    });
    if (recorded.validation.status !== 'accepted') {
      throw new Error(`dispatch of ${action_id} was rejected by validation: ${stableStringify(recorded.validation)}`);
    }
    return this.environment.execute(started, contract);
  }

  private issueGrant(action_id: ActionId, candidate: Candidate, contract: CapabilityContract): Grant {
    const bound = bindSelectors(contract.permissions, candidate.inputs);
    if (!bound.ok) {
      throw new Error(`cannot issue grant for ${action_id}: ${bound.reason}`);
    }
    return {
      action_id,
      operation: contract.id,
      contract_rev: contract.revision,
      permissions: bound.bound,
      effects: candidate.effects,
      issued_at: this.nextSeq(),
    };
  }

  private recordResult(action_id: ActionId, outcome: ActionOutcome, source: typeof RUNTIME_SOURCE | typeof HOST_SOURCE): void {
    const payload: ActionResultPayload = { action_id, outcome };
    const input: ObservationInput = {
      observation_id: `result:${action_id}`,
      source,
      caused_by: action_id,
      payload_type: 'action.result',
      payload_version: 1,
      payload,
    };
    if (source.kind === 'host') {
      this.observe(input);
    } else {
      this.append(input);
    }
  }

  /** `goal.complete` is a runtime action: it records completion only when the recorded success evidence is present. */
  private completeGoal(started: ActionStartedPayload): ActionOutcome {
    const state = this.state();
    if (successEvidencePresent(state)) {
      return {
        outcome: 'succeeded',
        output: { goal_id: state.goal?.goal_id, report_evidence: state.report?.evidence ?? [] },
      };
    }
    return { outcome: 'failed', failure: `success evidence missing for ${(started.inputs as { goal_id: string }).goal_id}` };
  }

  // -------------------------------------------------------------------------
  // Environments
  // -------------------------------------------------------------------------

  private liveEnvironment(): Environment {
    return {
      weigh: (request) => ({
        implementation: this.options.decisionLayer.implementation,
        weights: this.options.decisionLayer.weigh(request),
      }),
      execute: (started, contract) => {
        if (contract === null) {
          if (started.operation !== 'goal.complete') {
            throw new Error(`unknown runtime action ${started.operation}`);
          }
          const outcome = this.completeGoal(started);
          this.recordResult(started.action_id, outcome, RUNTIME_SOURCE);
          return outcome;
        }
        const handle = this.options.host.invoke(started.grant, started.operation, started.inputs);
        if (handle.kind === 'rejected') {
          const outcome: ActionOutcome = { outcome: 'failed', failure: `${handle.code}: ${handle.reason}` };
          this.recordResult(started.action_id, outcome, RUNTIME_SOURCE);
          return outcome;
        }
        this.settled.set(
          started.action_id,
          handle.result.then((outcome: InvocationOutcome) => {
            this.recordResult(started.action_id, outcome, HOST_SOURCE);
          }),
        );
        return null;
      },
    };
  }

  private replayEnvironment(recorded: readonly Observation[]): Environment {
    const accepted = recorded.filter((o) => o.validation.status === 'accepted');
    return {
      weigh: (request) => {
        const match = accepted.find((o) => {
          if (o.payload_type !== 'weights.recorded') {
            return false;
          }
          const p = o.payload as WeightsRecordedPayload;
          return p.site === request.site && p.state_revision === request.state_revision && p.candidate_set === request.candidate_set;
        });
        if (!match) {
          throw new ReplayFailureError(
            this.nextSeq(),
            null,
            `missing recorded weights.recorded for state_revision ${request.state_revision}`,
          );
        }
        const p = match.payload as WeightsRecordedPayload;
        return { implementation: p.implementation, weights: p.weights };
      },
      execute: (started) => {
        const match = accepted.find(
          (o) => o.payload_type === 'action.result' && (o.payload as ActionResultPayload).action_id === started.action_id,
        );
        if (!match) {
          throw new ReplayFailureError(this.nextSeq(), started.action_id, `missing recorded action.result for ${started.action_id}`);
        }
        const payload = match.payload as ActionResultPayload;
        if (match.source.kind === 'runtime') {
          // A synchronous runtime outcome is part of the cycle; reproduce it now.
          this.recordResult(started.action_id, payload.outcome, RUNTIME_SOURCE);
          return payload.outcome;
        }
        // A host result arrives later in the log and is fed by replay in order.
        return null;
      },
    };
  }
}

function blockedReason(
  not_selected: readonly { reason: NotSelectedReason }[],
  candidates: readonly Candidate[],
  unavailable: readonly string[],
): string {
  if (not_selected.length > 0) {
    const counts = new Map<NotSelectedReason, number>();
    for (const entry of not_selected) {
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    }
    const order: NotSelectedReason[] = ['budget', 'dependency', 'conflict', 'stale_read_set'];
    let dominant: NotSelectedReason = order[0] as NotSelectedReason;
    let best = -1;
    for (const reason of order) {
      const count = counts.get(reason) ?? 0;
      if (count > best) {
        dominant = reason;
        best = count;
      }
    }
    return REASON_TEXT[dominant];
  }
  const prohibited = candidates
    .map((c) => c.eligibility)
    .filter((e): e is { status: 'prohibited'; reason: string } => e.status === 'prohibited')
    .map((e) => e.reason);
  if (prohibited.length > 0) {
    return prohibited.join('; ');
  }
  if (unavailable.length > 0) {
    return `capability unavailable: ${unavailable.join(', ')}`;
  }
  return 'no candidates';
}

const REASON_TEXT: Readonly<Record<NotSelectedReason, string>> = {
  budget: 'actions budget exhausted',
  dependency: 'dependencies unsatisfied',
  conflict: 'effect conflict with running work',
  stale_read_set: 'read set is stale',
};

// ---------------------------------------------------------------------------
// §10 Replay
// ---------------------------------------------------------------------------

/**
 * Re-run the cycle over a recorded log. External arrivals are fed in seq
 * order; judgment and runtime observations are regenerated by the cycle and
 * must reproduce the record exactly. Neither the host nor the decision layer
 * is invoked; a missing recorded result is a failure, not a reason to execute.
 */
export function replay(recorded: readonly Observation[], options: RuntimeOptions): ReplayResult {
  const ordered = [...recorded].sort((a, b) => a.seq - b.seq);
  const runtime = new Runtime(options, ordered);
  const fail = (failure: ReplayFailureError): ReplayResult => ({
    ok: false,
    failure: { at_seq: failure.at_seq, action_id: failure.action_id, reason: failure.message },
    trace: runtime.trace(),
    state: runtime.state(),
  });

  try {
    for (const observation of ordered) {
      if (CYCLE_APPENDED.includes(observation.source.kind)) {
        continue;
      }
      const { seq: _seq, validation: _validation, ...input } = observation;
      runtime.observe(input);
      checkPrefix(runtime.trace().observations, ordered);
    }
    const replayed = runtime.trace().observations;
    if (replayed.length !== ordered.length) {
      throw new ReplayFailureError(replayed.length + 1, null, 'recorded log continues beyond what replay reproduced');
    }
    const running = Object.values(runtime.state().actions).find((a) => a.state === 'running' || a.state === 'pending');
    if (running) {
      throw new ReplayFailureError(null, running.action_id, `missing recorded action.result for ${running.action_id}`);
    }
  } catch (error) {
    if (error instanceof ReplayFailureError) {
      return fail(error);
    }
    throw error;
  }
  return { ok: true, trace: runtime.trace(), state: runtime.state() };
}

function checkPrefix(replayed: readonly Observation[], recorded: readonly Observation[]): void {
  for (let i = 0; i < replayed.length; i += 1) {
    const actual = replayed[i] as Observation;
    const expected = recorded[i];
    if (!expected) {
      throw new ReplayFailureError(actual.seq, null, `replay produced seq ${actual.seq} beyond the recorded log`);
    }
    if (stableStringify(actual) !== stableStringify(expected)) {
      throw new ReplayFailureError(actual.seq, null, `replay diverged from the record at seq ${actual.seq}`);
    }
  }
}

// ---------------------------------------------------------------------------
// M0-C3 Trace completeness
// ---------------------------------------------------------------------------

/** One message per violation: every `action.started` is explained by exactly one cycle record carrying its weighed, eligible candidate. */
export function traceCompletenessViolations(trace: Trace): string[] {
  const violations: string[] = [];
  const explained = new Set<ActionId>();
  for (const cycle of trace.cycles) {
    for (const sel of cycle.selected) {
      explained.add(sel.action_id);
    }
  }
  for (const observation of trace.observations) {
    if (observation.payload_type !== 'action.started' || observation.validation.status !== 'accepted') {
      continue;
    }
    const { action_id, candidate_id } = observation.payload as ActionStartedPayload;
    const cycles = trace.cycles.filter((c) => c.selected.some((s) => s.action_id === action_id));
    if (cycles.length !== 1) {
      violations.push(`action ${action_id} is explained by ${cycles.length} cycle records`);
      continue;
    }
    const cycle = cycles[0] as CycleRecord;
    const candidate = cycle.candidates.find((c) => c.candidate_id === candidate_id);
    if (!candidate) {
      violations.push(`cycle ${cycle.cycle_no} selected ${action_id} without recording its candidate`);
    } else if (candidate.eligibility.status !== 'allowed') {
      violations.push(`cycle ${cycle.cycle_no} dispatched ${action_id} from a non-eligible candidate`);
    } else if (candidate.weight === null) {
      violations.push(`cycle ${cycle.cycle_no} dispatched ${action_id} without a weight`);
    }
  }
  for (const action_id of explained) {
    const started = trace.observations.some(
      (o) => o.payload_type === 'action.started' && (o.payload as ActionStartedPayload).action_id === action_id,
    );
    if (!started) {
      violations.push(`cycle record selects ${action_id} but no action.started exists`);
    }
  }
  return violations;
}
