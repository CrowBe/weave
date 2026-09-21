/**
 * The M0 runtime (docs/m0-inspect-and-report.md §7–§10).
 *
 * `Runtime` owns the observation log, derived state, the cycle, dispatch, and
 * the trace. It reaches capabilities only through the `CapabilityHost`
 * interface and asks for weights only through the `DecisionLayer` judgment
 * site. In replay mode both are resolved from the recorded log instead, and
 * touching either is an error.
 */
import { bindSelectors, type CapabilityContract, type CapabilityHost, type Grant, type GrantAuthority, type InvocationOutcome } from '@weave/agentsop';
import type { InferenceGateway } from '@weave/gateway';
import {
  approvalStillValid,
  bindingDigest,
  formCandidates,
  matchingApproval,
  successEvidencePresent,
  type Describe,
} from './candidates.js';
import { candidateSetDigest, digest } from './digest.js';
import { PersistError, type ObservationJournal } from './journal.js';
import { parseProposalText, validateProposal } from './proposals.js';
import { select } from './scheduler.js';
import { stableStringify } from './stable-json.js';
import { applyAccepted, initialState, snapshot, type MutableState } from './state.js';
import { renderFrameView, renderWeighView } from './views.js';
import { toAttempts, toMicros } from './gateway-decision.js';
import type {
  ActionId,
  ActionOutcome,
  ActionReconciledPayload,
  ActionRecord,
  ActionResultPayload,
  ActionStartedPayload,
  ApprovalDecidedPayload,
  ApprovalRequestedPayload,
  Candidate,
  CycleOutcome,
  CycleRecord,
  DecisionLayer,
  InferenceRecordedPayload,
  InferenceRequestedPayload,
  NotSelectedReason,
  Observation,
  ObservationInput,
  Proposal,
  Provenance,
  ProvenanceKind,
  ReplayResult,
  Seq,
  State,
  StateView,
  Trace,
  WeighRequest,
  WeighResult,
  WeightEntry,
  WeightsRecordedPayload,
} from './types.js';
import { validate } from './validation.js';

export { ScriptedDecisionLayer } from './decision.js';
export { GatewayDecisionLayer, fixtureGateway, HOSTED_DESTINATION, LOCAL_DESTINATION } from './gateway-decision.js';
export { renderFrameView, renderWeighView, FRAME_PROFILE, WEIGH_PROFILE } from './views.js';
export { parseProposalText, validateProposal, proposalCoversSources } from './proposals.js';
export { foldState } from './state.js';
export { MemoryJournal, PersistError } from './journal.js';

export interface RuntimeOptions {
  readonly host: CapabilityHost;
  readonly decisionLayer: DecisionLayer;
  readonly grantAuthority?: GrantAuthority;
  readonly executionSlots?: number;
  readonly journal?: ObservationJournal;
  readonly gateway?: InferenceGateway;
}

const RUNTIME_SOURCE = { kind: 'runtime', id: 'weave' } as const;
const HOST_SOURCE = { kind: 'host', id: 'capability-host' } as const;
const OPERATOR_SOURCE = { kind: 'operator', id: 'operator' } as const;
const CLOCK_SOURCE = { kind: 'clock', id: 'clock' } as const;
const GATEWAY_SOURCE = { kind: 'gateway', id: 'inference-gateway' } as const;

/** Cost envelope reserved for one gateway weigh; framing must still have remaining budget. */
const GATEWAY_WEIGH_COST = 10_000;

const PRIVILEGED_KINDS: readonly ProvenanceKind[] = ['operator', 'host', 'runtime', 'judgment', 'clock', 'gateway'];

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

interface WeighResultSync {
  readonly implementation: string;
  readonly weights: readonly WeightEntry[];
}

/** How a cycle resolves judgment and execution: live against the host and decision layer, or from a recorded log. */
interface Environment {
  weigh(request: WeighRequest): WeighResultSync;
  /** Perform a dispatched action. Returns a synchronous outcome when the action completes within the cycle. */
  execute(started: ActionStartedPayload, contract: CapabilityContract | null): ActionOutcome | null;
}

export class IngressHandle {
  constructor(
    private readonly admit: (input: ObservationInput) => Observation,
    readonly provenance: Provenance,
  ) {}

  submit(input: Omit<ObservationInput, 'source'>): Observation {
    return this.admit({ ...input, source: this.provenance });
  }
}

export class Runtime {
  private readonly log: Observation[] = [];
  private readonly cycles: CycleRecord[] = [];
  private readonly current: MutableState = initialState();
  private readonly settled = new Map<ActionId, Promise<void>>();
  private readonly environment: Environment;
  private readonly describe: Describe;
  private readonly replayMode: boolean;
  private readonly slots: number;
  private readonly recordedContracts = new Map<string, CapabilityContract>();
  readonly operator: IngressHandle;
  readonly clock: IngressHandle;
  readonly hostIngress: IngressHandle;
  readonly gatewayIngress: IngressHandle;
  private readonly inferAbort = new Map<string, AbortController>();

  constructor(
    private readonly options: RuntimeOptions,
    recorded: readonly Observation[] | null = null,
  ) {
    this.replayMode = recorded !== null;
    this.slots = options.executionSlots ?? Number.POSITIVE_INFINITY;
    if (recorded) {
      for (const observation of recorded) {
        if (observation.payload_type === 'capability.described' && observation.validation.status === 'accepted') {
          const payload = observation.payload as { operation: string; contract: CapabilityContract };
          this.recordedContracts.set(payload.operation, payload.contract);
        }
      }
    }
    this.describe = (operation) => this.describeOperation(operation);
    this.environment = recorded ? this.replayEnvironment(recorded) : this.liveEnvironment();
    this.operator = new IngressHandle((input) => this.admit(input, true), OPERATOR_SOURCE);
    this.clock = new IngressHandle((input) => this.admit(input, true), CLOCK_SOURCE);
    this.hostIngress = new IngressHandle((input) => this.admit(input, true), HOST_SOURCE);
    this.gatewayIngress = new IngressHandle((input) => this.admit(input, true), GATEWAY_SOURCE);
  }

  /** Append an untrusted observation. Privileged origins cannot be claimed here. */
  observe(input: ObservationInput): Observation {
    if (PRIVILEGED_KINDS.includes(input.source.kind)) {
      return this.append({
        ...input,
        forced: { status: 'rejected', reason: 'untrusted ingress cannot claim this origin' },
      });
    }
    return this.admit(input, true);
  }

  decide(payload: ApprovalDecidedPayload): Observation {
    return this.operator.submit({
      observation_id: `operator:approval:${payload.request_id}:${payload.decision}`,
      caused_by: null,
      payload_type: 'approval.decided',
      payload_version: 1,
      payload,
    });
  }

  cancel(action_id: ActionId, reason: string): Observation {
    const record = this.current.actions[action_id];
    const invocation_id = record?.invocation_id ?? action_id;
    this.options.host.requestCancel(invocation_id);
    const infer = this.inferAbort.get(`inf:${action_id}`);
    infer?.abort();
    if (record?.grant && this.options.grantAuthority) {
      this.options.grantAuthority.revoke(record.grant);
    }
    return this.operator.submit({
      observation_id: `operator:cancel:${action_id}`,
      caused_by: null,
      payload_type: 'action.cancel_requested',
      payload_version: 1,
      payload: { action_id, reason },
    });
  }

  /** Trusted recorded arrivals used by replay. Live callers must use observe() or an ingress handle. */
  feed(input: ObservationInput): Observation {
    return this.admit(input, true);
  }
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

  private admit(input: ObservationInput, triggerCycle: boolean): Observation {
    const observation = this.append(input);
    if (
      triggerCycle &&
      observation.validation.status === 'accepted' &&
      !CYCLE_APPENDED.includes(observation.source.kind) &&
      this.current.goal?.status === 'active'
    ) {
      this.runCycle(observation.seq);
      this.drainQueue();
    }
    return observation;
  }

  private nextSeq(): Seq {
    return this.log.length + 1;
  }

  private append(
    input: ObservationInput & { forced?: Observation['validation'] },
  ): Observation {
    const { forced, ...envelope } = input;
    const observation: Observation = {
      ...envelope,
      seq: this.nextSeq(),
      validation: forced ?? validate(envelope, this.current),
    };
    const journal = this.options.journal;
    if (journal && observation.validation.status === 'accepted') {
      try {
        journal.persist(observation);
      } catch (error) {
        if (error instanceof PersistError && observation.payload_type === 'action.started') {
          return {
            ...observation,
            validation: { status: 'rejected', reason: error.message },
          };
        }
        if (
          error instanceof PersistError &&
          (observation.payload_type === 'action.result' || observation.payload_type === 'recovery.attempted')
        ) {
          return {
            ...observation,
            validation: { status: 'rejected', reason: error.message },
          };
        }
        throw error;
      }
    }
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
    this.prefetchContracts();
    const cycle_no = this.nextCycleNo();
    const state_revision = this.current.state_revision;
    const state = this.state();

    const formation = formCandidates(state, this.describe, (ref) =>
      this.replayMode ? ref : this.options.host.canonicalResource(ref),
    );
    const candidates: Candidate[] = [...formation.candidates];
    this.requestApprovals(candidates);
    const eligible = candidates.filter((c) => c.eligibility.status === 'allowed');

    let weights_ref: Seq | null = null;
    let outcome: CycleOutcome | null = null;
    let selection: ReturnType<typeof select> = { selected: [], not_selected: [] };

    if (eligible.length > 0) {
      const judged = this.weighAndSelect(cycle_no, trigger, state_revision, state, candidates, eligible);
      weights_ref = judged.weights_ref;
      outcome = judged.outcome;
      selection = judged.selection;
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
      procedure: formation.procedure,
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
    const running = Object.values(this.current.actions).some(
      (a) => a.state === 'running' || a.state === 'pending',
    );
    if (running) {
      return { status: 'waiting' };
    }
    const awaiting = candidates.some((c) => c.eligibility.status === 'approval_required');
    if (awaiting) {
      return { status: 'blocked', reason: 'awaiting approval for report.publish' };
    }
    return { status: 'blocked', reason: blockedReason(not_selected, candidates, unavailable) };
  }

  private asyncWeigh(): boolean {
    return this.options.decisionLayer.async === true;
  }

  private weighAndSelect(
    cycle_no: number,
    trigger: Seq,
    state_revision: Seq,
    state: State,
    candidates: Candidate[],
    eligible: readonly Candidate[],
  ): {
    weights_ref: Seq | null;
    outcome: CycleOutcome | null;
    selection: ReturnType<typeof select>;
  } {
    const candidate_set = candidateSetDigest(eligible.map((c) => c.candidate_id));
    const ready = this.readyWeights(candidate_set);
    if (ready) {
      this.applyWeights(candidates, ready.payload.weights);
      return {
        weights_ref: ready.seq,
        outcome: null,
        selection: select(
          candidates.filter((c) => c.eligibility.status === 'allowed' && c.weight !== null),
          this.state(),
        ),
      };
    }

    if (this.asyncWeigh()) {
      const status = this.frontierWeighStatus(candidate_set);
      if (status.kind === 'in_flight') {
        return { weights_ref: null, outcome: { status: 'waiting' }, selection: { selected: [], not_selected: [] } };
      }
      if (status.kind === 'finished') {
        return {
          weights_ref: null,
          outcome: { status: 'blocked', reason: status.reason },
          selection: { selected: [], not_selected: [] },
        };
      }
      const judgments = this.current.budget.judgments;
      if (judgments.limit - judgments.reserved - judgments.spent < 1) {
        return {
          weights_ref: null,
          outcome: { status: 'blocked', reason: 'judgments budget exhausted' },
          selection: { selected: [], not_selected: [] },
        };
      }
      const costRemaining =
        this.current.budget.cost.limit - this.current.budget.cost.reserved - this.current.budget.cost.spent;
      const cost_ceiling = Math.min(GATEWAY_WEIGH_COST, costRemaining);
      if (cost_ceiling < 1) {
        return {
          weights_ref: null,
          outcome: { status: 'blocked', reason: 'cost budget exhausted' },
          selection: { selected: [], not_selected: [] },
        };
      }
      const view = renderWeighView(state, eligible);
      const request_id = `inf:c${cycle_no}:weigh`;
      const requested = this.appendInferenceRequested({
        request_id,
        site: 'frontier.weigh',
        role: 'working',
        kind: 'score',
        view,
        state_revision: this.current.state_revision,
        candidate_set,
        terms: {
          quality: 'baseline',
          destinations: ['local'],
          max_context_tokens: 8_000,
          deadline: this.current.clock.tick + 100,
          cost_ceiling,
          max_attempts: 3,
        },
        reservation: { judgments: 1, cost: cost_ceiling },
      });
      if (requested.validation.status !== 'accepted') {
        const why = requested.validation.status === 'rejected' ? requested.validation.reason : 'unknown type';
        return {
          weights_ref: null,
          outcome: { status: 'blocked', reason: `inference reservation rejected: ${why}` },
          selection: { selected: [], not_selected: [] },
        };
      }
      if (!this.replayMode) {
        this.startGatewayWeigh(request_id, {
          site: 'frontier.weigh',
          state_revision: view.state_revision,
          candidate_set,
          candidates: eligible,
          view,
          cost_ceiling,
        });
      }
      return { weights_ref: null, outcome: { status: 'waiting' }, selection: { selected: [], not_selected: [] } };
    }

    const judgments = this.current.budget.judgments;
    if (judgments.limit - judgments.reserved - judgments.spent < 1) {
      return {
        weights_ref: null,
        outcome: { status: 'blocked', reason: 'judgments budget exhausted' },
        selection: { selected: [], not_selected: [] },
      };
    }
    const request: WeighRequest = {
      site: 'frontier.weigh',
      state_revision,
      candidate_set,
      candidates: eligible,
    };
    const result = this.environment.weigh(request);
    const recorded = this.recordScriptedWeights(cycle_no, trigger, request, result);
    if (recorded.validation.status !== 'accepted') {
      const why = recorded.validation.status === 'rejected' ? recorded.validation.reason : 'unknown type';
      return {
        weights_ref: null,
        outcome: { status: 'blocked', reason: `weights rejected: ${why}` },
        selection: { selected: [], not_selected: [] },
      };
    }
    this.applyWeights(candidates, result.weights);
    return {
      weights_ref: recorded.seq,
      outcome: null,
      selection: select(
        candidates.filter((c) => c.eligibility.status === 'allowed' && c.weight !== null),
        this.state(),
      ),
    };
  }

  private applyWeights(candidates: Candidate[], weights: readonly WeightEntry[]): void {
    const byId = new Map(weights.map((w) => [w.candidate_id, w.weight]));
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i] as Candidate;
      const weight = byId.get(candidate.candidate_id);
      if (candidate.eligibility.status === 'allowed' && weight !== undefined) {
        candidates[i] = { ...candidate, weight };
      }
    }
  }

  private recordScriptedWeights(
    cycle_no: number,
    trigger: Seq,
    request: WeighRequest,
    result: WeighResultSync,
  ): Observation {
    const payload: WeightsRecordedPayload = {
      site: request.site,
      implementation: result.implementation,
      state_revision: request.state_revision,
      candidate_set: request.candidate_set,
      weights: result.weights,
    };
    return this.append({
      observation_id: `weights:c${cycle_no}`,
      source: { kind: 'judgment', id: result.implementation },
      caused_by: trigger,
      payload_type: 'weights.recorded',
      payload_version: 1,
      payload,
    });
  }

  private readyWeights(candidate_set: string): { seq: Seq; payload: WeightsRecordedPayload } | null {
    for (let i = this.log.length - 1; i >= 0; i -= 1) {
      const observation = this.log[i];
      if (!observation || observation.validation.status !== 'accepted') {
        continue;
      }
      if (observation.payload_type !== 'weights.recorded') {
        return null;
      }
      const payload = observation.payload as WeightsRecordedPayload;
      return payload.candidate_set === candidate_set ? { seq: observation.seq, payload } : null;
    }
    return null;
  }

  private frontierWeighStatus(
    candidate_set: string,
  ): { kind: 'needed' } | { kind: 'in_flight' } | { kind: 'finished'; reason: string } {
    const records = Object.values(this.current.inferences).filter(
      (record) => record.request.site === 'frontier.weigh' && record.request.candidate_set === candidate_set,
    );
    const latest = records.at(-1);
    if (!latest) {
      return { kind: 'needed' };
    }
    if (!latest.recorded) {
      return { kind: 'in_flight' };
    }
    if (latest.recorded.status !== 'accepted') {
      return { kind: 'finished', reason: latest.recorded.reason ?? latest.recorded.status };
    }
    const weights = this.log.find(
      (o) =>
        o.payload_type === 'weights.recorded' &&
        o.validation.status === 'accepted' &&
        (o.payload as WeightsRecordedPayload).request_id === latest.request_id,
    );
    if (!weights) {
      return { kind: 'finished', reason: 'stale judgment' };
    }
    return { kind: 'needed' };
  }

  private appendInferenceRequested(payload: InferenceRequestedPayload): Observation {
    return this.append({
      observation_id: `inference:${payload.request_id}`,
      source: RUNTIME_SOURCE,
      caused_by: null,
      payload_type: 'inference.requested',
      payload_version: 1,
      payload,
    });
  }

  private startGatewayWeigh(request_id: string, request: WeighRequest): void {
    const controller = new AbortController();
    this.inferAbort.set(request_id, controller);
    const result = this.options.decisionLayer.weigh(request);
    void Promise.resolve(result).then(
      (weigh) => this.onGatewayWeigh(request_id, request, weigh as WeighResult),
      (error: unknown) =>
        this.onGatewayWeigh(request_id, request, {
          weights: [],
          attempts: [],
          spent: 0,
          status: 'unaccepted',
          reason: error instanceof Error ? error.message : 'weigh failed',
        }),
    );
  }

  private onGatewayWeigh(request_id: string, request: WeighRequest, result: WeighResult): void {
    this.inferAbort.delete(request_id);
    const recordedPayload: InferenceRecordedPayload = {
      request_id,
      attempts: result.attempts ?? [],
      spent: toMicros(result.spent ?? 0),
      status: result.status ?? (result.weights.length > 0 ? 'accepted' : 'unaccepted'),
      reason: result.reason ?? null,
    };
    if (recordedPayload.status === 'accepted' && result.weights.length > 0) {
      const bindRevision = this.current.inferences[request_id]?.evidence[0] ?? this.current.state_revision;
      this.gatewayIngress.submit({
        observation_id: `weights:${request_id}`,
        caused_by: null,
        payload_type: 'weights.recorded',
        payload_version: 1,
        payload: {
          site: 'frontier.weigh',
          implementation: result.implementation ?? this.options.decisionLayer.implementation,
          state_revision: bindRevision,
          candidate_set: request.candidate_set,
          weights: result.weights,
          request_id,
        } satisfies WeightsRecordedPayload,
      });
    }
    this.gatewayIngress.submit({
      observation_id: `inference:recorded:${request_id}`,
      caused_by: null,
      payload_type: 'inference.recorded',
      payload_version: 1,
      payload: recordedPayload,
    });
  }

  private catalogueOps(): { id: string; input: Readonly<Record<string, string>> }[] {
    const ops: { id: string; input: Readonly<Record<string, string>> }[] = [];
    for (const operation of ['source.inspect', 'report.assemble', 'report.publish']) {
      const contract = this.describe(operation);
      if (contract) {
        ops.push({ id: contract.id, input: contract.input });
      }
    }
    return ops;
  }

  private frameGoal(started: ActionStartedPayload): ActionOutcome | null {
    const view = renderFrameView(this.state(), this.catalogueOps());
    const request_id = `inf:${started.action_id}`;
    const costRemaining =
      this.current.budget.cost.limit - this.current.budget.cost.reserved - this.current.budget.cost.spent;
    const cost_ceiling = Math.min(1_000_000, Math.max(0, costRemaining));
    const requested = this.appendInferenceRequested({
      request_id,
      site: 'goal.frame',
      role: 'framing',
      kind: 'transform',
      view,
      state_revision: this.current.state_revision,
      candidate_set: null,
      terms: {
        quality: 'baseline',
        destinations: ['local'],
        max_context_tokens: 8_000,
        deadline: this.current.clock.tick + 100,
        cost_ceiling,
        max_attempts: 3,
      },
      reservation: { judgments: 0, cost: cost_ceiling },
    });
    if (requested.validation.status !== 'accepted') {
      const why = requested.validation.status === 'rejected' ? requested.validation.reason : 'unknown type';
      return { outcome: 'failed', failure: why };
    }
    if (this.replayMode) {
      return null;
    }
    const gateway = this.options.gateway;
    if (!gateway) {
      return { outcome: 'failed', failure: 'inference gateway is not configured' };
    }
    const controller = new AbortController();
    this.inferAbort.set(request_id, controller);
    this.settled.set(
      started.action_id,
      gateway
        .generate(
          {
            request_id,
            site: 'goal.frame',
            role: 'framing',
            kind: 'transform',
            input: {
              instructions:
                'Propose inspect bindings as JSON {"bindings":[{"operation":"source.inspect","inputs":{"source":"..."}}]}',
              prompt: stableStringify(view.content),
            },
            terms: {
              quality: 'baseline',
              destinations: ['local'],
              max_context_tokens: 8_000,
              deadline: this.current.clock.tick + 100,
              cost_ceiling,
              max_attempts: 3,
            },
          },
          controller.signal,
        )
        .then((outcome) => {
          this.inferAbort.delete(request_id);
          this.gatewayIngress.submit({
            observation_id: `inference:recorded:${request_id}`,
            caused_by: started.action_id,
            payload_type: 'inference.recorded',
            payload_version: 1,
            payload: {
              request_id,
              attempts: toAttempts(outcome.attempts),
              spent: toMicros(outcome.spent),
              status: outcome.status === 'accepted' ? 'accepted' : outcome.status,
              reason: outcome.status === 'accepted' ? null : outcome.reason,
            } satisfies InferenceRecordedPayload,
          });
          if (outcome.status !== 'accepted') {
            this.recordResult(started.action_id, { outcome: 'failed', failure: outcome.reason }, GATEWAY_SOURCE);
            return;
          }
          const parsed = parseProposalText(outcome.text);
          if (!parsed.ok) {
            this.recordResult(started.action_id, { outcome: 'failed', failure: parsed.reason }, GATEWAY_SOURCE);
            return;
          }
          const proposal = validateProposal(parsed.bindings, this.state(), this.describe);
          this.recordResult(started.action_id, { outcome: 'succeeded', output: proposal }, GATEWAY_SOURCE);
        }),
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // §7 step 5 Dispatch
  // -------------------------------------------------------------------------

  private dispatch(action_id: ActionId, candidate: Candidate, weights_ref: Seq | null): ActionOutcome | null {
    if (!this.stillAuthorized(candidate)) {
      return null;
    }
    const contract = candidate.contract_rev === null ? null : this.describe(candidate.operation);
    const grant = contract ? this.issueGrant(action_id, candidate, contract) : null;
    const invocation_id = action_id;
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
      invocation_id,
    };
    const running = Object.values(this.current.actions).filter((a) => a.state === 'running').length;
    const queued = running >= this.slots;
    const recorded = this.append({
      observation_id: `${queued ? 'queued' : 'started'}:${action_id}`,
      source: RUNTIME_SOURCE,
      caused_by: weights_ref,
      payload_type: queued ? 'action.queued' : 'action.started',
      payload_version: 1,
      payload: started,
    });
    if (recorded.validation.status !== 'accepted') {
      if (recorded.payload_type === 'action.started') {
        return null;
      }
      throw new Error(`dispatch of ${action_id} was rejected by validation: ${stableStringify(recorded.validation)}`);
    }
    if (queued) {
      return null;
    }
    return this.environment.execute(started, contract);
  }

  private stillAuthorized(candidate: Candidate): boolean {
    if (candidate.operation !== 'report.publish') {
      return candidate.eligibility.status === 'allowed';
    }
    const fresh = formCandidates(this.state(), this.describe, (ref) =>
      this.replayMode ? ref : this.options.host.canonicalResource(ref),
    );
    const match = fresh.candidates.find((c) => c.candidate_id === candidate.candidate_id);
    return match?.eligibility.status === 'allowed';
  }

  private issueGrant(action_id: ActionId, candidate: Candidate, contract: CapabilityContract): Grant {
    const bound = bindSelectors(contract.permissions, candidate.inputs);
    if (!bound.ok) {
      throw new Error(`cannot issue grant for ${action_id}: ${bound.reason}`);
    }
    const declared = bindSelectors(contract.effects, candidate.inputs);
    const fields: Grant = {
      action_id,
      operation: contract.id,
      contract_rev: contract.revision,
      permissions: bound.bound,
      effects: declared.ok ? declared.bound : candidate.effects,
      issued_at: this.nextSeq(),
    };
    return this.options.grantAuthority ? this.options.grantAuthority.issue(fields) : fields;
  }

  private recordResult(
    action_id: ActionId,
    outcome: ActionOutcome,
    source: typeof RUNTIME_SOURCE | typeof HOST_SOURCE | typeof GATEWAY_SOURCE,
  ): void {
    const payload: ActionResultPayload = { action_id, outcome };
    const rest = {
      observation_id: `result:${action_id}`,
      caused_by: action_id,
      payload_type: 'action.result' as const,
      payload_version: 1,
      payload,
    };
    if (source.kind === 'host') {
      this.hostIngress.submit(rest);
    } else if (source.kind === 'gateway') {
      this.gatewayIngress.submit(rest);
    } else {
      this.append({ ...rest, source });
    }
    this.drainQueue();
  }

  private recordReconciled(action: ActionRecord, outcome: ActionOutcome): void {
    const payload: ActionReconciledPayload = {
      action_id: action.action_id,
      invocation_id: action.invocation_id ?? action.action_id,
      outcome,
    };
    this.hostIngress.submit({
      observation_id: `reconciled:${action.action_id}`,
      caused_by: action.action_id,
      payload_type: 'action.reconciled',
      payload_version: 1,
      payload,
    });
    this.drainQueue();
  }

  private recordRecoveryExhausted(reason: string): void {
    const already = this.log.some((o) => o.payload_type === 'recovery.exhausted' && o.validation.status === 'accepted');
    if (already) {
      return;
    }
    this.append({
      observation_id: `recovery:exhausted:${this.nextSeq()}`,
      source: RUNTIME_SOURCE,
      caused_by: null,
      payload_type: 'recovery.exhausted',
      payload_version: 1,
      payload: { reason },
    });
  }

  private grantForLookup(action: ActionRecord): Grant | null {
    const authority = this.options.grantAuthority;
    if (!authority) {
      return action.grant;
    }
    if (!this.lookupAuthorized(action)) {
      return null;
    }
    return authority.issue({
      action_id: action.action_id,
      operation: action.operation,
      contract_rev: action.contract_rev ?? '',
      permissions: action.grant?.permissions ?? [...action.effects],
      effects: action.effects,
      issued_at: this.nextSeq(),
    });
  }

  private lookupAuthorized(action: ActionRecord): boolean {
    if (action.operation !== 'report.publish') {
      return this.describe(action.operation) !== null;
    }
    if (this.describe(action.operation) === null) {
      return false;
    }
    const inputs = action.inputs;
    const destination =
      typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs)
        ? (inputs as { destination?: unknown }).destination
        : undefined;
    if (typeof destination !== 'string') {
      return false;
    }
    const standingWrite = this.current.goal?.authority.write?.includes(destination) ?? false;
    if (standingWrite) {
      return true;
    }
    const approval = matchingApproval(this.state(), bindingDigest(action.inputs, action.effects), destination);
    return !!approval && approvalStillValid(approval, this.state());
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

  private requestApprovals(candidates: readonly Candidate[]): void {
    for (const candidate of candidates) {
      if (candidate.eligibility.status !== 'approval_required') {
        continue;
      }
      const inputs = candidate.inputs as {
        destination: string;
        expected_revision: number;
        read_set: { resource: string; revision: number }[];
        report: unknown;
      };
      const request_id = `apr:${candidate.candidate_id}`;
      if (this.current.approvals[request_id]) {
        continue;
      }
      const tick = this.current.clock.tick;
      const payload: ApprovalRequestedPayload = {
        request_id,
        goal_id: this.current.goal?.goal_id ?? '',
        candidate_id: candidate.candidate_id,
        operation: candidate.operation,
        contract_rev: candidate.contract_rev ?? '',
        binding_digest: bindingDigest(candidate.inputs, candidate.effects),
        report_digest: digest(inputs.report),
        read_set: inputs.read_set,
        destination: inputs.destination,
        expected_revision: inputs.expected_revision,
        effects: candidate.effects,
        budget: candidate.resources,
        valid_from_tick: tick,
        valid_until_tick: tick + 10,
      };
      this.append({
        observation_id: `approval:${request_id}`,
        source: RUNTIME_SOURCE,
        caused_by: null,
        payload_type: 'approval.requested',
        payload_version: 1,
        payload,
      });
    }
  }

  private nextCycleNo(): number {
    let max = this.cycles.length;
    for (const action of Object.values(this.current.actions)) {
      const match = /^a:(\d+):/.exec(action.action_id);
      if (match) {
        max = Math.max(max, Number(match[1]));
      }
    }
    return max + 1;
  }

  private prefetchContracts(): void {
    for (const operation of ['source.inspect', 'report.assemble', 'report.publish']) {
      this.describeOperation(operation);
    }
  }

  private invokeHost(started: ActionStartedPayload):
    | { kind: 'handle'; result: Promise<InvocationOutcome> }
    | { kind: 'rejected'; code: string; reason: string }
    | { kind: 'failed_closed'; outcome: ActionOutcome } {
    try {
      const handle = this.options.host.invoke(started.grant, started.operation, started.inputs, {
        invocation_id: started.invocation_id ?? started.action_id,
      });
      if (handle.kind === 'rejected') {
        return handle;
      }
      return { kind: 'handle', result: handle.result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'host threw';
      const effectful = started.effects.some((e) => e.mode !== 'read');
      return {
        kind: 'failed_closed',
        outcome: effectful ? { outcome: 'uncertain', reason } : { outcome: 'failed', failure: reason },
      };
    }
  }

  private describeOperation(operation: string): CapabilityContract | null {
    const recorded = this.current.contracts[operation];
    if (recorded) {
      return recorded as CapabilityContract;
    }
    if (this.replayMode) {
      const historical = this.recordedContracts.get(operation);
      if (!historical) {
        return null;
      }
      this.append({
        observation_id: `contract:${operation}:${historical.revision}`,
        source: RUNTIME_SOURCE,
        caused_by: null,
        payload_type: 'capability.described',
        payload_version: 1,
        payload: { operation, contract: historical },
      });
      return historical;
    }
    const described = this.options.host.describe(operation);
    if (described.kind !== 'contract') {
      return null;
    }
    this.append({
      observation_id: `contract:${operation}:${described.contract.revision}`,
      source: RUNTIME_SOURCE,
      caused_by: null,
      payload_type: 'capability.described',
      payload_version: 1,
      payload: { operation, contract: described.contract },
    });
    return described.contract;
  }

  private drainQueue(): void {
    if (this.replayMode) {
      return;
    }
    const pending = Object.values(this.current.actions)
      .filter((a) => a.state === 'pending' && !a.cancel_requested)
      .sort((a, b) => a.action_id.localeCompare(b.action_id));
    for (const record of pending) {
      const running = Object.values(this.current.actions).filter((a) => a.state === 'running').length;
      if (running >= this.slots) {
        return;
      }
      const candidate: Candidate = {
        candidate_id: record.candidate_id,
        operation: record.operation,
        contract_rev: record.contract_rev,
        inputs: record.inputs,
        evidence: [],
        read_set: record.read_set,
        dependencies: [],
        effects: record.effects,
        resources: record.reservation,
        eligibility: { status: 'allowed' },
        weight: 0,
      };
      if (!this.stillAuthorized(candidate)) {
        this.append({
          observation_id: `cancel:${record.action_id}:stale-authority`,
          source: RUNTIME_SOURCE,
          caused_by: null,
          payload_type: 'action.cancel_requested',
          payload_version: 1,
          payload: { action_id: record.action_id, reason: 'current authority does not cover queued work' },
        });
        continue;
      }
      const started: ActionStartedPayload = {
        action_id: record.action_id,
        candidate_id: record.candidate_id,
        operation: record.operation,
        contract_rev: record.contract_rev,
        inputs: record.inputs,
        read_set: record.read_set,
        effects: record.effects,
        reservation: record.reservation,
        grant: record.grant,
        invocation_id: record.invocation_id ?? record.action_id,
      };
      const recorded = this.append({
        observation_id: `started:${record.action_id}`,
        source: RUNTIME_SOURCE,
        caused_by: null,
        payload_type: 'action.started',
        payload_version: 1,
        payload: started,
      });
      if (recorded.validation.status !== 'accepted') {
        continue;
      }
      const contract = record.contract_rev === null ? null : this.describe(record.operation);
      this.environment.execute(started, contract);
    }
  }

  reconcile(): void {
    const unfinished = Object.values(this.current.actions).filter(
      (a) => a.state === 'running' || a.state === 'pending' || (a.state === 'uncertain' && !a.reconciled),
    );
    for (const action of unfinished) {
      if (action.state === 'pending') {
        continue;
      }
      if (this.current.recovery.limit === 0 || this.current.recovery.spent >= this.current.recovery.limit) {
        this.recordRecoveryExhausted('recovery allowance exhausted');
        return;
      }
      const invocation_id = action.invocation_id ?? action.action_id;
      const attempted = this.append({
        observation_id: `recovery:${action.action_id}:${this.current.recovery.spent + 1}`,
        source: RUNTIME_SOURCE,
        caused_by: action.action_id,
        payload_type: 'recovery.attempted',
        payload_version: 1,
        payload: { action_id: action.action_id, invocation_id },
      });
      if (attempted.validation.status !== 'accepted') {
        this.recordRecoveryExhausted(attempted.validation.status === 'rejected' ? attempted.validation.reason : 'recovery attempt was not recorded');
        return;
      }
      const grant = this.grantForLookup(action);
      const looked = this.options.host.lookup(invocation_id, grant);
      if ('kind' in looked) {
        if (action.state !== 'uncertain') {
          this.recordResult(action.action_id, { outcome: 'uncertain', reason: `${looked.code}: ${looked.reason}` }, RUNTIME_SOURCE);
        }
        continue;
      }
      if (looked.status === 'committed' || looked.status === 'stopped') {
        if (action.state === 'uncertain') {
          this.recordReconciled(action, looked.outcome);
        } else {
          this.recordResult(action.action_id, looked.outcome, HOST_SOURCE);
        }
      } else if (action.state !== 'uncertain') {
        this.recordResult(action.action_id, { outcome: 'uncertain', reason: looked.reason }, RUNTIME_SOURCE);
      }
    }
    this.drainQueue();
  }

  load(observations: readonly Observation[]): void {
    for (const observation of observations) {
      this.log.push(structuredClone(observation));
      if (observation.validation.status === 'accepted') {
        applyAccepted(this.current, observation);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Environments
  // -------------------------------------------------------------------------

  private liveEnvironment(): Environment {
    return {
      weigh: (request) => {
        const weights = this.options.decisionLayer.weigh(request);
        if (typeof (weights as { then?: unknown }).then === 'function') {
          throw new Error('async decision layer must be handled by the gateway weigh path');
        }
        return { implementation: this.options.decisionLayer.implementation, weights: weights as readonly WeightEntry[] };
      },
      execute: (started, contract) => {
        if (contract === null) {
          if (started.operation === 'goal.complete') {
            const outcome = this.completeGoal(started);
            this.recordResult(started.action_id, outcome, RUNTIME_SOURCE);
            return outcome;
          }
          if (started.operation === 'goal.frame') {
            const outcome = this.frameGoal(started);
            if (outcome) {
              this.recordResult(started.action_id, outcome, RUNTIME_SOURCE);
              return outcome;
            }
            return null;
          }
          throw new Error(`unknown runtime action ${started.operation}`);
        }
        const handle = this.invokeHost(started);
        if (handle.kind === 'rejected') {
          const outcome: ActionOutcome = { outcome: 'failed', failure: `${handle.code}: ${handle.reason}` };
          this.recordResult(started.action_id, outcome, RUNTIME_SOURCE);
          return outcome;
        }
        if (handle.kind === 'failed_closed') {
          this.recordResult(started.action_id, handle.outcome, RUNTIME_SOURCE);
          return handle.outcome;
        }
        this.settled.set(
          started.action_id,
          handle.result.then(
            (outcome: InvocationOutcome) => {
              this.recordResult(started.action_id, outcome, HOST_SOURCE);
            },
            (error: unknown) => {
              const reason = error instanceof Error ? error.message : 'invocation rejected';
              const effectful = started.effects.some((e) => e.mode !== 'read');
              this.recordResult(
                started.action_id,
                effectful ? { outcome: 'uncertain', reason } : { outcome: 'failed', failure: reason },
                RUNTIME_SOURCE,
              );
            },
          ),
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
        if (started.operation === 'goal.frame') {
          this.frameGoal(started);
        }
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
      runtime.feed(input);
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

export function recover(recorded: readonly Observation[], options: RuntimeOptions): Runtime {
  const runtime = new Runtime(options);
  runtime.load(recorded);
  runtime.reconcile();
  return runtime;
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
