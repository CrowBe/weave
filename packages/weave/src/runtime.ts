/**
 * The M0 runtime (docs/m0-inspect-and-report.md §7–§10).
 *
 * `Runtime` owns the observation log, derived state, the cycle, dispatch, and
 * the trace. It reaches capabilities only through the `CapabilityHost`
 * interface and asks for weights only through the `DecisionLayer` judgment
 * site. In replay mode both are resolved from the recorded log instead, and
 * touching either is an error.
 */
import {
  bindSelectors,
  type AdmissionDecision,
  type CapabilityContract,
  type CapabilityHost,
  type CapabilityLifecycle,
  type Grant,
  type GrantAuthority,
  type InvocationOutcome,
} from '@weave/agentsop';
import type { InferenceGateway } from '@weave/gateway';
import {
  approvalStillValid,
  bindingDigest,
  formCandidates,
  matchingApproval,
  successEvidencePresent,
  type Describe,
} from './candidates.js';
import { isCrystallizeOperation, runCrystallizeAction, type ExtensionAuthor } from './crystallize-actions.js';
import { candidateSetDigest, digest } from './digest.js';
import { HOST_INVOCATION_MICROS, reuseVerdict } from './reuse.js';
import { PersistError, type ObservationJournal } from './journal.js';
import { parseProposalText, validateProposal } from './proposals.js';
import { select } from './scheduler.js';
import { stableStringify } from './stable-json.js';
import { applyAccepted, initialState, snapshot, type MutableState } from './state.js';
import { narrowDestinations } from './destinations.js';
import { measureCandidate, stablePrefixBytes } from './strategy.js';
import { DEFAULT_FRAME_PROFILE, renderFrameView, renderReviewView, SHARED_ASSEMBLY_MICROS, renderWeighView, type FrameProfile } from './views.js';
import { toAttempts, toMicros } from './gateway-decision.js';
import type {
  ActionId,
  ActionOutcome,
  ActionReconciledPayload,
  ActionRecord,
  ActionResultPayload,
  ActionStartedPayload,
  AdmissionDecidedPayload,
  BaselineRecord,
  ClockTickPayload,
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
import { hasMidValue, payloadBytes, type TraceRetention } from './log-bound.js';
import { validate } from './validation.js';

export { ScriptedDecisionLayer } from './decision.js';
export { GatewayDecisionLayer, fixtureGateway, HOSTED_DESTINATION, LOCAL_DESTINATION } from './gateway-decision.js';
export {
  renderFrameView,
  renderWeighView,
  FRAME_PROFILE,
  DEFAULT_FRAME_PROFILE,
  NARROW_FRAME_PROFILE,
  WEIGH_PROFILE,
  type FrameProfile,
} from './views.js';
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
  readonly lifecycle?: CapabilityLifecycle;
  readonly author?: ExtensionAuthor;
  /**
   * Frame profile for this run. Replay must receive the profile that produced
   * the recorded view; the active profile is not read from today's default.
   */
  readonly frameProfile?: FrameProfile;
  /**
   * Terms for a framing request. Absent keeps the local destination, a
   * baseline quality bar, and the historical context window.
   */
  readonly framingTerms?: {
    readonly quality: 'baseline' | 'high';
    readonly max_context_tokens: number;
    readonly cost_ceiling: number;
  };
  /** Caller-supplied prefix cache. The runtime passes it through; it does not discover one. */
  readonly prefixCache?: {
    readonly routed_unit_id: string;
    readonly prefix_digest: string;
    readonly cached_tokens: number;
  };
  /** Cite one slice assembly for read-only views of the same revision. */
  readonly shareAssemblies?: boolean;
  /** Canonical payload bound. An observation over it is rejected before it is durable. */
  readonly logBound?: { readonly max_observation_bytes: number };
  readonly traceRetention?: TraceRetention;
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
  private readonly lifecycleQueue: { action_id: ActionId; outcome: ActionOutcome }[] = [];
  private lifecyclePump = false;
  private readonly frameProfile: FrameProfile;
  private readonly replayLog: readonly Observation[] | null;
  /** A reused conclusion finished inside the cycle; form the next candidates before returning. */
  private reuseFollowUp = false;
  private readonly chargedAssemblies = new Set<string>();
  private cycleAssemblyCost = 0;
  private readonly reviews = new Map<ActionId, StateView>();
  private readonly preparedViews = new Map<string, StateView>();
  /** Views rendered at cycle start, kept for an action that starts after the cycle. */
  private readonly preparedForAction = new Map<string, StateView>();
  private readonly diagnostics: Observation[] = [];
  private transitionLock = false;

  constructor(
    private readonly options: RuntimeOptions,
    recorded: readonly Observation[] | null = null,
  ) {
    this.replayMode = recorded !== null;
    this.slots = options.executionSlots ?? Number.POSITIVE_INFINITY;
    this.frameProfile = options.frameProfile ?? DEFAULT_FRAME_PROFILE;
    this.replayLog = recorded;
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

  admitCapability(decision: AdmissionDecision): Observation {
    const payload: AdmissionDecidedPayload = {
      request_id: decision.request_id,
      implementation_id: decision.implementation_id,
      decision: 'admitted',
      approver: decision.approver,
      evidence_digest: decision.evidence_digest,
      authority_revision: decision.authority_revision,
    };
    const lifecycle = this.options.lifecycle;
    if (!lifecycle) {
      return this.append({
        observation_id: `operator:admission:${decision.request_id}:rejected`,
        source: OPERATOR_SOURCE,
        caused_by: null,
        payload_type: 'admission.decided',
        payload_version: 1,
        payload,
        forced: { status: 'rejected', reason: 'no capability lifecycle is configured' },
      });
    }
    const step = lifecycle.admit(decision);
    if (!step.ok) {
      return this.append({
        observation_id: `operator:admission:${decision.request_id}:rejected`,
        source: OPERATOR_SOURCE,
        caused_by: null,
        payload_type: 'admission.decided',
        payload_version: 1,
        payload,
        forced: { status: 'rejected', reason: step.reason },
      });
    }
    return this.operator.submit({
      observation_id: `operator:admission:${decision.request_id}:admitted`,
      caused_by: null,
      payload_type: 'admission.decided',
      payload_version: 1,
      payload,
    });
  }

  revokeCapability(operation: string, implementationId: string, reason: string): Observation {
    const payload = { operation, implementation_id: implementationId, reason };
    const lifecycle = this.options.lifecycle;
    if (lifecycle) {
      const step = lifecycle.revoke(operation, implementationId, reason);
      if (!step.ok) {
        return this.append({
          observation_id: `operator:revoked:${implementationId}:rejected`,
          source: OPERATOR_SOURCE,
          caused_by: null,
          payload_type: 'implementation.revoked',
          payload_version: 1,
          payload,
          forced: { status: 'rejected', reason: step.reason },
        });
      }
    }
    return this.operator.submit({
      observation_id: `operator:revoked:${implementationId}`,
      caused_by: null,
      payload_type: 'implementation.revoked',
      payload_version: 1,
      payload,
    });
  }

  invalidateEvidence(next: CapabilityContract): Observation {
    const payload = { reason: 'contract revision', contract_revision: next.revision };
    const lifecycle = this.options.lifecycle;
    if (!lifecycle) {
      return this.append({
        observation_id: `operator:invalidated:${next.revision}:rejected`,
        source: OPERATOR_SOURCE,
        caused_by: null,
        payload_type: 'evidence.invalidated',
        payload_version: 1,
        payload,
        forced: { status: 'rejected', reason: 'no capability lifecycle is configured' },
      });
    }
    const step = lifecycle.reviseContract(next);
    if (!step.ok) {
      return this.append({
        observation_id: `operator:invalidated:${next.revision}:rejected`,
        source: OPERATOR_SOURCE,
        caused_by: null,
        payload_type: 'evidence.invalidated',
        payload_version: 1,
        payload,
        forced: { status: 'rejected', reason: step.reason },
      });
    }
    return this.operator.submit({
      observation_id: `operator:invalidated:${next.revision}`,
      caused_by: null,
      payload_type: 'evidence.invalidated',
      payload_version: 1,
      payload,
    });
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

  /** Rejections kept for diagnosis. Oversize payloads are not copied into the log. */
  diagnosticRejections(): readonly Observation[] {
    return structuredClone(this.diagnostics);
  }

  /**
   * Record the M4 baseline from the log. Inference reservations and host
   * invocation costs are summed once each. A reused conclusion adds neither.
   */
  recordBaseline(): Observation {
    const payload = this.baselinePayload();
    if (!payload) {
      return this.append({
        observation_id: 'runtime:baseline:profile.frame@1:rejected',
        source: RUNTIME_SOURCE,
        caused_by: null,
        payload_type: 'baseline.recorded',
        payload_version: 1,
        payload: {
          strategy: 'profile.frame@1',
          workload: 'repeated normalized-report goals, including a failing case',
          quality: { held: 0, missed: 0, cases: [] },
          inference_requests: 0,
          latency_ticks: 0,
          cost_micros: 0,
          human_corrections: 0,
        },
        forced: { status: 'rejected', reason: 'baseline requires a failing case and a success' },
      });
    }
    return this.append({
      observation_id: 'runtime:baseline:profile.frame@1',
      source: RUNTIME_SOURCE,
      caused_by: null,
      payload_type: 'baseline.recorded',
      payload_version: 1,
      payload,
    });
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
    this.transitionLock = true;
    let observation: Observation;
    try {
      const { forced, ...envelope } = input;
      const bytes = payloadBytes(envelope.payload);
      const oversize = this.options.logBound !== undefined && bytes > this.options.logBound.max_observation_bytes;
      if (oversize) {
        const diagnostic: Observation = {
          ...envelope,
          seq: this.nextSeq(),
          validation: { status: 'rejected', reason: 'budget' },
          payload: { reason: 'budget', bytes },
        };
        this.diagnostics.push(diagnostic);
        return diagnostic;
      }
      const duplicate =
        this.log.some((item) => item.observation_id === envelope.observation_id) ||
        this.diagnostics.some((item) => item.observation_id === envelope.observation_id);
      const midValue = hasMidValue(envelope.payload);
      let validation = forced ?? validate(envelope, this.current);
      if (duplicate) {
        validation = { status: 'rejected', reason: 'duplicate' };
      } else if (midValue) {
        validation = { status: 'rejected', reason: 'mid_value' };
      }
      observation = {
        ...envelope,
        seq: this.nextSeq(),
        validation,
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
        this.followAccepted(observation);
      } else {
        this.noteRejectedAmendment(observation);
      }
    } finally {
      this.transitionLock = false;
    }
    this.retainTrace(observation);
    return observation;
  }

  private retainTrace(observation: Observation): void {
    const retention = this.options.traceRetention;
    if (!retention || observation.validation.status !== 'accepted') {
      return;
    }
    if (observation.payload_type === 'inference.recorded') {
      const attempts = (observation.payload as InferenceRecordedPayload).attempts;
      for (const attempt of attempts) {
        retention.retain(`${observation.observation_id}:${attempt.attempt}`, stableStringify(attempt), this.transitionLock);
      }
      return;
    }
    if (observation.payload_type === 'action.result') {
      const action_id = (observation.payload as { action_id: string }).action_id;
      retention.retain(`result:${action_id}`, stableStringify(observation.payload), this.transitionLock);
    }
  }

  // -------------------------------------------------------------------------
  // §7 The cycle
  // -------------------------------------------------------------------------

  private runCycle(trigger: Seq): void {
    this.runCycleOnce(trigger);
    while (this.reuseFollowUp) {
      this.reuseFollowUp = false;
      this.runCycleOnce(trigger);
    }
  }

  private runCycleOnce(trigger: Seq): void {
    this.importRetainedConclusions();
    this.prefetchContracts();
    const cycle_no = this.nextCycleNo();
    const state_revision = this.current.state_revision;
    const state = this.state();

    const formation = formCandidates(state, this.describe, (ref) =>
      this.replayMode ? ref : this.options.host.canonicalResource(ref),
    );
    const pausedFraming = this.framingPaused();
    const candidates: Candidate[] = pausedFraming
      ? formation.candidates.filter((candidate) => candidate.operation !== 'goal.frame')
      : [...formation.candidates];
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

    if (this.options.shareAssemblies) {
      this.prepareSharedViews(state, candidates);
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
    if (pausedFraming && selected.length === 0) {
      outcome = { status: 'blocked', reason: 'profile record missing' };
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
      cost_micros: this.cycleAssemblyCost,
    });
    this.cycleAssemblyCost = 0;
    this.preparedViews.clear();
  }

  private takePrepared(action_id: string, operation: string): StateView | undefined {
    const stashed = this.preparedForAction.get(action_id);
    if (stashed) {
      this.preparedForAction.delete(action_id);
      return stashed;
    }
    return this.preparedViews.get(operation);
  }

  private prepareSharedViews(state: State, candidates: readonly Candidate[]): void {
    const profile = this.profileForFrame();
    if (profile && candidates.some((candidate) => candidate.operation === 'goal.frame')) {
      const view = renderFrameView(state, this.catalogueOps(), profile, { assemblies: true });
      this.preparedViews.set('goal.frame', view);
      this.noteViewAssemblies(view);
    }
    if (candidates.some((candidate) => candidate.operation === 'report.review')) {
      const view = renderReviewView(state);
      this.preparedViews.set('report.review', view);
      this.noteViewAssemblies(view);
    }
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
    if (this.current.crystallization.admission?.status === 'requested') {
      return { status: 'blocked', reason: 'awaiting admission' };
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
    const ids = this.replayMode ? this.replayCatalogueIds() : [...this.options.host.operations()].sort();
    const ops: { id: string; input: Readonly<Record<string, string>> }[] = [];
    for (const operation of ids) {
      const contract = this.describe(operation);
      if (contract) {
        ops.push({ id: contract.id, input: contract.input });
      }
    }
    return ops;
  }

  /**
   * Catalogue ids whose contracts were recorded before the framing request
   * about to be regenerated. Replay does not consult the host's current catalogue.
   */
  private replayCatalogueIds(): readonly string[] {
    if (!this.replayLog) {
      return [];
    }
    const emitted = new Set(this.log.map((observation) => observation.observation_id));
    const nextRequest = this.replayLog.find(
      (observation) => observation.payload_type === 'inference.requested' && !emitted.has(observation.observation_id),
    );
    const horizon = nextRequest?.seq ?? Number.POSITIVE_INFINITY;
    const ids: string[] = [];
    for (const observation of this.replayLog) {
      if (observation.payload_type !== 'capability.described' || observation.validation.status !== 'accepted') {
        continue;
      }
      if (observation.seq >= horizon) {
        continue;
      }
      const operation = (observation.payload as { operation: string }).operation;
      if (!ids.includes(operation)) {
        ids.push(operation);
      }
    }
    return ids;
  }

  finishReview(action_id: ActionId): void {
    const host = this.options.host as { releaseReads?: (invocation_id: string) => void };
    host.releaseReads?.(action_id);
    const view = this.reviews.get(action_id);
    this.recordResult(
      action_id,
      {
        outcome: 'succeeded',
        output: {
          view,
          profile: 'profile.frame.narrow@1',
          grant: { grant_id: 'forged' },
        },
      },
      RUNTIME_SOURCE,
    );
  }

  private reviewGoal(started: ActionStartedPayload): ActionOutcome | null {
    const prepared = this.takePrepared(started.action_id, 'report.review');
    const view = prepared ?? renderReviewView(this.state());
    if (!prepared) {
      this.noteViewAssemblies(view);
    }
    this.reviews.set(started.action_id, view);
    const resources = started.read_set.flatMap((entry) => ('resource' in entry ? [entry.resource] : []));
    const host = this.options.host as { holdReads?: (invocation_id: string, resources: readonly string[]) => void };
    host.holdReads?.(started.invocation_id ?? started.action_id, resources);
    return null;
  }

  private noteViewAssemblies(view: StateView): void {
    for (const item of view.manifest.slices) {
      if (!item.assembly_id || this.chargedAssemblies.has(item.assembly_id)) {
        continue;
      }
      this.chargedAssemblies.add(item.assembly_id);
      if (item.assembly_id.endsWith(':goal+registered')) {
        this.cycleAssemblyCost += SHARED_ASSEMBLY_MICROS;
      }
    }
  }

  private frameGoal(started: ActionStartedPayload): ActionOutcome | null {
    const profile = this.profileForFrame();
    if (!profile) {
      return { outcome: 'failed', failure: 'profile record missing' };
    }
    const prepared = this.takePrepared(started.action_id, 'goal.frame');
    const view =
      prepared ??
      renderFrameView(this.state(), this.catalogueOps(), profile, this.options.shareAssemblies ? { assemblies: true } : undefined);
    if (!prepared) {
      this.noteViewAssemblies(view);
    }
    const request_id = `inf:${started.action_id}`;
    const costRemaining =
      this.current.budget.cost.limit - this.current.budget.cost.reserved - this.current.budget.cost.spent;
    const framing = this.options.framingTerms;
    const readResources = started.read_set.flatMap((entry) => ('resource' in entry ? [entry.resource] : []));
    const destinations = this.current.goal?.destinations
      ? narrowDestinations(this.current.goal.destinations, this.current.destination_policies, readResources)
      : ['local'];
    const cost_ceiling = Math.min(framing?.cost_ceiling ?? 1_000_000, Math.max(0, costRemaining));
    const prefix_digest = this.options.prefixCache ? digest(stablePrefixBytes(profile, view)) : undefined;
    const terms = {
      quality: framing?.quality ?? 'baseline',
      destinations,
      max_context_tokens: framing?.max_context_tokens ?? 8_000,
      deadline: this.current.clock.tick + 100,
      cost_ceiling,
      max_attempts: 3,
      ...(prefix_digest !== undefined && this.options.prefixCache
        ? { prefix_digest, prefix_cache: this.options.prefixCache }
        : {}),
    };
    const requested = this.appendInferenceRequested({
      request_id,
      site: 'goal.frame',
      role: 'framing',
      kind: 'transform',
      view,
      state_revision: view.state_revision,
      candidate_set: null,
      terms,
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
            terms,
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
    const prepared = this.preparedViews.get(candidate.operation);
    if (prepared) {
      this.preparedForAction.set(action_id, prepared);
    }
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
    extra?: {
      implementation_id?: string;
      cost_micros?: number;
      conclusion_id?: string;
      cited_evidence?: readonly Seq[];
    },
  ): void {
    const payload: {
      action_id: ActionId;
      outcome: ActionOutcome;
      implementation_id?: string;
      cost_micros?: number;
      conclusion_id?: string;
      cited_evidence?: readonly Seq[];
    } = { action_id, outcome };
    if (extra?.implementation_id) {
      payload.implementation_id = extra.implementation_id;
    }
    if (extra?.cost_micros !== undefined) {
      payload.cost_micros = extra.cost_micros;
    }
    if (extra?.conclusion_id) {
      payload.conclusion_id = extra.conclusion_id;
    }
    if (extra?.cited_evidence) {
      payload.cited_evidence = extra.cited_evidence;
    }
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
    const operations = ['source.inspect', 'report.assemble', 'report.publish'];
    const crystal = this.current.crystallization;
    if (crystal.admission?.status === 'admitted' || crystal.search?.status === 'reusable') {
      operations.push('report.fold');
    }
    if (this.current.goal?.composition) {
      operations.push('text.normalize');
    }
    for (const operation of operations) {
      this.describeOperation(operation);
    }
  }

  private invokeHost(started: ActionStartedPayload):
    | { kind: 'handle'; result: Promise<InvocationOutcome>; implementation_id: string }
    | { kind: 'rejected'; code: string; reason: string }
    | { kind: 'failed_closed'; outcome: ActionOutcome } {
    try {
      const handle = this.options.host.invoke(started.grant, started.operation, started.inputs, {
        invocation_id: started.invocation_id ?? started.action_id,
      });
      if (handle.kind === 'rejected') {
        return handle;
      }
      return { kind: 'handle', result: handle.result, implementation_id: handle.implementation_id };
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
      const observation_id = `contract:${operation}:${historical.revision}`;
      if (this.log.some((observation) => observation.observation_id === observation_id)) {
        return historical;
      }
      const upcoming = this.replayLog?.find((observation) => observation.seq === this.nextSeq());
      if (upcoming?.observation_id !== observation_id) {
        return null;
      }
      this.append({
        observation_id,
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

  private executeCrystallize(started: ActionStartedPayload): ActionOutcome | null {
    const goal = this.current.goal;
    const lifecycle = this.options.lifecycle;
    const author = this.options.author;
    const desired = goal?.gap
      ? {
          operation: goal.gap.operation,
          purpose: goal.gap.purpose,
          input: goal.gap.input,
          output: goal.gap.output,
        }
      : goal?.composition
        ? {
            operation: goal.composition.operation,
            purpose: goal.composition.purpose,
            input: goal.composition.input,
            output: goal.composition.output,
          }
        : null;
    if (!desired || !lifecycle || !author) {
      this.enqueueLifecycleResult(started.action_id, {
        outcome: 'failed',
        failure: 'crystallization requires a gap or a recorded composition, a lifecycle, and an extension author',
      });
      return null;
    }
    const outcome = runCrystallizeAction(
      started,
      lifecycle,
      author,
      desired,
      goal?.retained_procedure ?? null,
      Boolean(goal?.composition && !goal.gap),
    );
    if (typeof (outcome as { then?: unknown }).then === 'function') {
      this.settled.set(
        started.action_id,
        Promise.resolve(outcome).then(
          (result) => {
            this.recordResult(started.action_id, result, HOST_SOURCE);
          },
          (error: unknown) => {
            this.recordResult(started.action_id, {
              outcome: 'failed',
              failure: error instanceof Error ? error.message : 'crystallize failed',
            }, HOST_SOURCE);
          },
        ),
      );
      return null;
    }
    this.enqueueLifecycleResult(started.action_id, outcome as ActionOutcome);
    return null;
  }

  private enqueueLifecycleResult(action_id: ActionId, outcome: ActionOutcome): void {
    this.lifecycleQueue.push({ action_id, outcome });
    if (!this.lifecyclePump) {
      this.lifecyclePump = true;
      queueMicrotask(() => this.pumpLifecycle());
    }
  }

  private pumpLifecycle(): void {
    this.lifecyclePump = false;
    const item = this.lifecycleQueue.shift();
    if (!item) {
      return;
    }
    this.recordResult(item.action_id, item.outcome, HOST_SOURCE);
    if (this.lifecycleQueue.length > 0 && !this.lifecyclePump) {
      this.lifecyclePump = true;
      queueMicrotask(() => this.pumpLifecycle());
    }
  }

  private baselinePayload(): BaselineRecord | null {
    const cases = this.workloadCases();
    const held = cases.filter((item) => item.quality === 'held').length;
    const missed = cases.filter((item) => item.quality === 'missed').length;
    if (held < 1 || missed < 1) {
      return null;
    }
    let inference_requests = 0;
    let inference_cost = 0;
    const ticks: number[] = [];
    for (const observation of this.log) {
      if (observation.validation.status !== 'accepted') {
        continue;
      }
      if (observation.payload_type === 'inference.requested') {
        inference_requests += 1;
      }
      if (observation.payload_type === 'inference.recorded') {
        inference_cost += (observation.payload as { spent?: number }).spent ?? 0;
      }
      if (observation.payload_type === 'clock.tick') {
        ticks.push((observation.payload as ClockTickPayload).tick);
      }
    }
    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    const latency_ticks = first === undefined || last === undefined ? 0 : last - first;
    const measured = this.measuredCost();
    return {
      strategy: 'profile.frame@1',
      workload: 'repeated normalized-report goals, including a failing case',
      quality: { held, missed, cases },
      inference_requests,
      latency_ticks,
      cost_micros: inference_cost + measured,
      human_corrections: this.current.corrections.length,
    };
  }

  private workloadCases(): { goal_id: string; quality: 'held' | 'missed' }[] {
    const host = this.options.host as {
      workload?: () => readonly { goal_id: string; quality: 'held' | 'missed' }[];
    };
    const merged = new Map<string, { goal_id: string; quality: 'held' | 'missed' }>();
    for (const item of host.workload?.() ?? []) {
      merged.set(item.goal_id, { goal_id: item.goal_id, quality: item.quality });
    }
    for (const item of this.current.workload) {
      merged.set(item.goal_id, { goal_id: item.goal_id, quality: item.quality });
    }
    return [...merged.values()];
  }

  private measuredCost(): number {
    const host = this.options.host as { measuredCostMicros?: () => number };
    if (host.measuredCostMicros) {
      return host.measuredCostMicros();
    }
    let host_cost = 0;
    for (const observation of this.log) {
      if (observation.validation.status !== 'accepted' || observation.payload_type !== 'action.result') {
        continue;
      }
      if (observation.source.kind !== 'host') {
        continue;
      }
      const cost = (observation.payload as ActionResultPayload).cost_micros;
      if (cost !== undefined) {
        host_cost += cost;
      }
    }
    return host_cost;
  }

  private framingPaused(): boolean {
    const strategy = this.current.strategy;
    if (!strategy.promoted && !strategy.rolled_back) {
      return false;
    }
    if (strategy.paused) {
      return true;
    }
    return this.current.profiles[strategy.profile_id] === undefined;
  }

  private profileForNewWork(): FrameProfile | null {
    const strategy = this.current.strategy;
    if (strategy.promoted || strategy.rolled_back) {
      return this.current.profiles[strategy.profile_id] ?? null;
    }
    return this.frameProfile;
  }

  private profileForFrame(): FrameProfile | null {
    if (this.replayMode) {
      return this.recordedFrameProfile() ?? this.profileForNewWork();
    }
    return this.profileBoundToCurrentGoal() ?? this.profileForNewWork();
  }

  /** The profile id on the next recorded framing view, not today's active profile. */
  private recordedFrameProfile(): FrameProfile | null {
    if (!this.replayLog) {
      return null;
    }
    const emitted = new Set(this.log.map((observation) => observation.observation_id));
    const next = this.replayLog.find((observation) => {
      if (observation.payload_type !== 'inference.requested' || emitted.has(observation.observation_id)) {
        return false;
      }
      return (observation.payload as InferenceRequestedPayload).site === 'goal.frame';
    });
    if (!next) {
      return null;
    }
    const view = (next.payload as InferenceRequestedPayload).view;
    const option = this.options.frameProfile;
    if (option && option.id === view.profile && option.version === view.profile_version) {
      return option;
    }
    const known = this.current.profiles[view.profile];
    if (known && known.version === view.profile_version) {
      return known;
    }
    return null;
  }

  /** An in-flight goal keeps the profile already written on its framing view. */
  private profileBoundToCurrentGoal(): FrameProfile | null {
    const opened = this.current.goal?.evidence;
    if (!opened) {
      return null;
    }
    let profileId: string | null = null;
    let profileVersion = 0;
    for (const observation of this.log) {
      if (observation.validation.status !== 'accepted' || observation.seq <= opened) {
        continue;
      }
      if (observation.payload_type !== 'inference.requested') {
        continue;
      }
      const payload = observation.payload as InferenceRequestedPayload;
      if (payload.site !== 'goal.frame') {
        continue;
      }
      profileId = payload.view.profile;
      profileVersion = payload.view.profile_version;
    }
    if (!profileId) {
      return null;
    }
    const known = this.current.profiles[profileId];
    if (known && known.version === profileVersion) {
      return known;
    }
    if (this.frameProfile.id === profileId && this.frameProfile.version === profileVersion) {
      return this.frameProfile;
    }
    return null;
  }

  private recordComparison(experimentId: string): void {
    const experiment = this.current.experiment;
    if (!experiment || experiment.experiment_id !== experimentId || experiment.invalidated) {
      return;
    }
    const baselineProfile = this.current.profiles[experiment.baseline];
    const candidateProfile = this.current.profiles[experiment.candidate];
    if (!baselineProfile || !candidateProfile) {
      return;
    }
    const catalogue = this.catalogueOps();
    const rendered = this.state();
    const baselineView = renderFrameView(rendered, catalogue, baselineProfile);
    const candidateView = renderFrameView(rendered, catalogue, candidateProfile);
    const humanCorrections = this.current.corrections.filter((item) => item.evidence > experiment.evidence).length;
    const latencyTicks = Math.max(0, this.current.clock.tick - experiment.deadline_tick);
    this.append({
      observation_id: `runtime:experiment.compared:${experimentId}`,
      source: RUNTIME_SOURCE,
      caused_by: experiment.evidence,
      payload_type: 'experiment.compared',
      payload_version: 1,
      payload: measureCandidate({
        experimentId,
        deadlineTick: experiment.deadline_tick,
        baseline: baselineProfile,
        candidate: candidateProfile,
        baselineView,
        candidateView,
        humanCorrections,
        latencyTicks,
      }),
    });
  }

  private recordRollback(regression: Observation): void {
    const experiment = this.current.experiment;
    const payload = regression.payload as { experiment_id?: string; case_id?: string };
    if (!experiment || experiment.experiment_id !== payload.experiment_id || !payload.case_id) {
      return;
    }
    this.append({
      observation_id: `runtime:strategy.rolled_back:${payload.experiment_id}:${payload.case_id}`,
      source: RUNTIME_SOURCE,
      caused_by: regression.seq,
      payload_type: 'strategy.rolled_back',
      payload_version: 1,
      payload: {
        experiment_id: experiment.experiment_id,
        case_id: payload.case_id,
        profile_id: experiment.rollback,
        reason: 'protected case regressed',
      },
    });
  }

  private noteRejectedAmendment(observation: Observation): void {
    if (observation.payload_type !== 'experiment.amended' || observation.validation.status !== 'rejected') {
      return;
    }
    const experiment = this.current.experiment;
    if (!experiment || experiment.invalidated) {
      return;
    }
    const payload = observation.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return;
    }
    const body = payload as Record<string, unknown>;
    if (body['experiment_id'] !== experiment.experiment_id) {
      return;
    }
    const results = this.current.comparisons.some(
      (comparison) => comparison.experiment_id === experiment.experiment_id && comparison.evidence > experiment.evidence,
    );
    if (!results) {
      return;
    }
    this.append({
      observation_id: `runtime:experiment.invalidated:${experiment.experiment_id}`,
      source: RUNTIME_SOURCE,
      caused_by: observation.seq,
      payload_type: 'experiment.invalidated',
      payload_version: 1,
      payload: {
        experiment_id: experiment.experiment_id,
        reason: 'protected cases or quality bar changed after results',
      },
    });
  }

  private followAccepted(observation: Observation): void {
    if (observation.payload_type === 'action.result') {
      const payload = observation.payload as ActionResultPayload;
      this.maybeCacheConclusion(observation);
      const action = this.current.actions[payload.action_id];
      if (
        payload.outcome.outcome === 'failed' &&
        payload.outcome.failure === 'empty_output' &&
        action?.operation === 'text.normalize' &&
        this.current.goal?.status === 'active'
      ) {
        this.append({
          observation_id: `runtime:goal.missed:${this.current.goal.goal_id}`,
          source: RUNTIME_SOURCE,
          caused_by: payload.action_id,
          payload_type: 'goal.missed',
          payload_version: 1,
          payload: { goal_id: this.current.goal.goal_id, reason: 'empty_output' },
        });
      }
      if (payload.outcome.outcome === 'succeeded' && action?.operation === 'goal.complete' && this.current.goal) {
        this.noteWorkload(this.current.goal.goal_id, 'held');
      }
      return;
    }
    if (observation.payload_type === 'goal.missed') {
      const payload = observation.payload as { goal_id: string };
      this.noteWorkload(payload.goal_id, 'missed');
      return;
    }
    if (observation.payload_type === 'output.rejected') {
      this.maybeRecordBaseline();
      return;
    }
    if (observation.payload_type === 'baseline.requested') {
      this.maybeRecordBaseline();
      return;
    }
    if (observation.payload_type === 'experiment.requested') {
      const payload = observation.payload as { experiment_id: string };
      this.recordComparison(payload.experiment_id);
      return;
    }
    if (observation.payload_type === 'experiment.regressed') {
      this.recordRollback(observation);
    }
  }

  private noteWorkload(goal_id: string, quality: 'held' | 'missed'): void {
    const host = this.options.host as {
      noteWorkload?: (goal_id: string, quality: 'held' | 'missed') => void;
    };
    host.noteWorkload?.(goal_id, quality);
  }

  private maybeRecordBaseline(): void {
    if (this.log.some((item) => item.payload_type === 'baseline.recorded' && item.validation.status === 'accepted')) {
      return;
    }
    const payload = this.baselinePayload();
    if (!payload) {
      return;
    }
    this.append({
      observation_id: 'runtime:baseline:profile.frame@1',
      source: RUNTIME_SOURCE,
      caused_by: null,
      payload_type: 'baseline.recorded',
      payload_version: 1,
      payload,
    });
  }

  private importRetainedConclusions(): void {
    if (this.replayMode) {
      return;
    }
    const host = this.options.host as { conclusions?: () => readonly unknown[] };
    for (const item of host.conclusions?.() ?? []) {
      if (!isCachedConclusion(item)) {
        continue;
      }
      if (this.current.conclusions.some((conclusion) => conclusion.conclusion_id === item.conclusion_id)) {
        continue;
      }
      this.append({
        observation_id: `conclusion:imported:${item.conclusion_id}`,
        source: RUNTIME_SOURCE,
        caused_by: null,
        payload_type: 'conclusion.cached',
        payload_version: 1,
        payload: item,
      });
    }
  }

  private maybeCacheConclusion(result: Observation): void {
    if (result.payload_type !== 'action.result') {
      return;
    }
    const payload = result.payload as ActionResultPayload;
    if (payload.conclusion_id || payload.outcome.outcome !== 'succeeded' || !payload.implementation_id) {
      return;
    }
    const action = this.current.actions[payload.action_id];
    const goal_id = this.current.goal?.goal_id;
    if (!action || action.operation !== 'text.normalize' || !action.contract_rev || !goal_id) {
      return;
    }
    const evidence: number[] = [result.seq];
    for (const entry of action.read_set) {
      if (!('resource' in entry)) {
        continue;
      }
      const source = this.current.sources[entry.resource];
      if (source && !evidence.includes(source.evidence)) {
        evidence.push(source.evidence);
      }
    }
    this.append({
      observation_id: `conclusion:${payload.action_id}`,
      source: RUNTIME_SOURCE,
      caused_by: payload.action_id,
      payload_type: 'conclusion.cached',
      payload_version: 1,
      payload: {
        conclusion_id: `conc:${payload.action_id}`,
        operation: action.operation,
        contract_rev: action.contract_rev,
        implementation_id: payload.implementation_id,
        input_digest: digest(action.inputs),
        output: payload.outcome.output,
        evidence,
        read_set: action.read_set.filter((entry) => 'resource' in entry),
        authority_scope: { goal_id },
        invalidation: ['read_set', 'contract_rev', 'admission'],
      },
    });
    const cached = this.current.conclusions[this.current.conclusions.length - 1];
    if (cached) {
      const host = this.options.host as { retainConclusion?: (conclusion: unknown) => void };
      host.retainConclusion?.(cached);
    }
  }

  private reuseConclusion(started: ActionStartedPayload): ActionOutcome | null {
    if (started.operation !== 'text.normalize') {
      return null;
    }
    const verdict = reuseVerdict(
      this.current.conclusions,
      {
        operation: started.operation,
        contract_rev: started.contract_rev,
        inputs: started.inputs,
        read_set: started.read_set,
      },
      { sources: this.current.sources, goal_id: this.current.goal?.goal_id ?? null },
      this.current.policies,
      (operation, implementationId) => this.implementationAdmitted(operation, implementationId),
    );
    if (verdict.kind === 'rerun') {
      return null;
    }
    if (verdict.kind === 'uncertain') {
      const outcome: ActionOutcome = { outcome: 'uncertain', reason: verdict.reason };
      this.recordResult(started.action_id, outcome, RUNTIME_SOURCE);
      return outcome;
    }
    this.reuseFollowUp = true;
    const outcome: ActionOutcome = { outcome: 'succeeded', output: verdict.conclusion.output };
    this.recordResult(started.action_id, outcome, RUNTIME_SOURCE, {
      conclusion_id: verdict.conclusion.conclusion_id,
      cited_evidence: verdict.conclusion.evidence,
    });
    return outcome;
  }

  private implementationAdmitted(operation: string, implementationId: string): boolean {
    if (this.options.host.implementationAdmitted) {
      return this.options.host.implementationAdmitted(operation, implementationId);
    }
    return this.describe(operation) !== null;
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
          if (started.operation === 'report.review') {
            return this.reviewGoal(started);
          }
          if (started.operation === 'goal.frame') {
            const outcome = this.frameGoal(started);
            if (outcome) {
              this.recordResult(started.action_id, outcome, RUNTIME_SOURCE);
              return outcome;
            }
            return null;
          }
          if (isCrystallizeOperation(started.operation)) {
            return this.executeCrystallize(started);
          }
          throw new Error(`unknown runtime action ${started.operation}`);
        }
        const reused = this.reuseConclusion(started);
        if (reused) {
          return reused;
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
              this.recordResult(started.action_id, outcome, HOST_SOURCE, {
                implementation_id: handle.implementation_id,
                cost_micros: HOST_INVOCATION_MICROS,
              });
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
        if (started.operation === 'report.review') {
          return null;
        }
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
          if (payload.conclusion_id) {
            this.reuseFollowUp = true;
          }
          this.recordResult(started.action_id, payload.outcome, RUNTIME_SOURCE, resultExtra(payload));
          return payload.outcome;
        }
        // A host result arrives later in the log and is fed by replay in order.
        return null;
      },
    };
  }
}

function isCachedConclusion(value: unknown): value is {
  conclusion_id: string;
  operation: string;
  contract_rev: string;
  implementation_id: string;
  input_digest: string;
  output: unknown;
  evidence: readonly number[];
  read_set: readonly { resource: string; revision: number }[];
  authority_scope: { goal_id: string } | { policy_id: string };
  invalidation: readonly ('read_set' | 'contract_rev' | 'admission')[];
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as { conclusion_id?: unknown };
  return typeof record.conclusion_id === 'string';
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

function resultExtra(payload: ActionResultPayload): {
  implementation_id?: string;
  cost_micros?: number;
  conclusion_id?: string;
  cited_evidence?: readonly Seq[];
} {
  const extra: {
    implementation_id?: string;
    cost_micros?: number;
    conclusion_id?: string;
    cited_evidence?: readonly Seq[];
  } = {};
  if (payload.implementation_id) {
    extra.implementation_id = payload.implementation_id;
  }
  if (payload.cost_micros !== undefined) {
    extra.cost_micros = payload.cost_micros;
  }
  if (payload.conclusion_id) {
    extra.conclusion_id = payload.conclusion_id;
  }
  if (payload.cited_evidence) {
    extra.cited_evidence = payload.cited_evidence;
  }
  return extra;
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
    const reviewActions = new Set(
      ordered
        .filter(
          (observation) =>
            observation.payload_type === 'action.started' &&
            (observation.payload as { operation?: string }).operation === 'report.review',
        )
        .map((observation) => (observation.payload as { action_id: string }).action_id),
    );
    for (const observation of ordered) {
      const resultAction = observation.payload_type === 'action.result' ? (observation.payload as { action_id?: string }).action_id : undefined;
      const feedReviewResult = observation.source.kind === 'runtime' && resultAction !== undefined && reviewActions.has(resultAction);
      if (CYCLE_APPENDED.includes(observation.source.kind) && !feedReviewResult) {
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
