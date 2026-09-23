/**
 * Derived state (§4): a deterministic fold over accepted observations in seq
 * order. `state_revision` is the seq of the last accepted observation.
 */
import type {
  ActionRecord,
  ActionReconciledPayload,
  ActionResultPayload,
  ActionStartedPayload,
  ApprovalDecidedPayload,
  ApprovalRecord,
  ApprovalRequestedPayload,
  BudgetLine,
  AdmissionDecidedPayload,
  CapabilityDescribedPayload,
  ClockTickPayload,
  BaselineRecord,
  CachedConclusion,
  ComparisonRecord,
  ContextProfileRecord,
  CrystallizationState,
  ExperimentRecord,
  Goal,
  HumanCorrection,
  InferenceRecord,
  InferenceRecordedPayload,
  InferenceRequestedPayload,
  InspectionResult,
  Observation,
  PolicyRecord,
  Proposal,
  PublishReceipt,
  Report,
  ResourceReadSetEntry,
  Seq,
  SourcePayload,
  State,
  StrategySelection,
  WorkloadCase,
} from './types.js';
import { DEFAULT_FRAME_PROFILE, NARROW_FRAME_PROFILE } from './views.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface MutableState {
  state_revision: Seq;
  goal: (Goal & { status: 'active' | 'complete' | 'missed'; evidence: Seq }) | null;
  sources: Record<string, { revision: number; content: string; evidence: Seq }>;
  actions: Record<string, Mutable<ActionRecord>>;
  inspections: Record<string, { result: InspectionResult; evidence: Seq }>;
  report: { report: Report; evidence: Seq[] } | null;
  publication: { receipt: PublishReceipt; evidence: Seq } | null;
  budget: { actions: Mutable<BudgetLine>; judgments: Mutable<BudgetLine>; cost: Mutable<BudgetLine> };
  clock: { tick: number; evidence: Seq | null };
  approvals: Record<string, Mutable<ApprovalRecord> & { evidence: Seq[] }>;
  contracts: Record<string, unknown>;
  recovery: { limit: number; spent: number };
  proposal: { proposal: Proposal; evidence: Seq } | null;
  inferences: Record<string, Mutable<InferenceRecord> & { evidence: Seq[] }>;
  crystallization: Mutable<CrystallizationState>;
  conclusions: CachedConclusion[];
  policies: PolicyRecord[];
  normalized: Record<string, { text: string; revision: number; evidence: Seq }>;
  workload: WorkloadCase[];
  corrections: HumanCorrection[];
  baseline: BaselineRecord | null;
  profiles: Record<string, ContextProfileRecord>;
  experiment: ExperimentRecord | null;
  comparisons: ComparisonRecord[];
  strategy: StrategySelection;
}

export function initialState(): MutableState {
  return {
    state_revision: 0,
    goal: null,
    sources: {},
    actions: {},
    inspections: {},
    report: null,
    publication: null,
    budget: {
      actions: { limit: 0, reserved: 0, spent: 0 },
      judgments: { limit: 0, reserved: 0, spent: 0 },
      cost: { limit: 0, reserved: 0, spent: 0 },
    },
    clock: { tick: 0, evidence: null },
    approvals: {},
    contracts: {},
    recovery: { limit: 0, spent: 0 },
    proposal: null,
    inferences: {},
    crystallization: emptyCrystallization(),
    conclusions: [],
    policies: [],
    normalized: {},
    workload: [],
    corrections: [],
    baseline: null,
    profiles: {
      [DEFAULT_FRAME_PROFILE.id]: { ...DEFAULT_FRAME_PROFILE },
      [NARROW_FRAME_PROFILE.id]: { ...NARROW_FRAME_PROFILE },
    },
    experiment: null,
    comparisons: [],
    strategy: {
      profile_id: DEFAULT_FRAME_PROFILE.id,
      workload: null,
      experiment_id: null,
      promoted: false,
      rolled_back: false,
      paused: false,
    },
  };
}

export function emptyCrystallization(): Mutable<CrystallizationState> {
  return {
    search: null,
    contract: null,
    visible_ids: [],
    held_out_ids: [],
    corpus_revision: null,
    corpus_validated: false,
    red: null,
    implementations: [],
    held_out_spent: false,
    green: [],
    admission: null,
    revoked: false,
    fold: null,
  };
}

export type { MutableState };

/** Apply one accepted observation. Callers must not pass rejected or unknown-type observations. */
export function applyAccepted(state: MutableState, observation: Observation): void {
  if (observation.validation.status !== 'accepted') {
    throw new Error(`only accepted observations transition state (seq ${observation.seq})`);
  }
  state.state_revision = observation.seq;
  switch (observation.payload_type) {
    case 'goal.opened': {
      const goal = observation.payload as Goal;
      state.goal = { ...goal, status: 'active', evidence: observation.seq };
      state.actions = {};
      state.inspections = {};
      state.normalized = {};
      state.report = null;
      state.publication = null;
      state.proposal = null;
      state.crystallization = emptyCrystallization();
      state.budget = {
        actions: { limit: goal.budget.actions, reserved: 0, spent: 0 },
        judgments: { limit: goal.budget.judgments, reserved: 0, spent: 0 },
        cost: { limit: goal.budget.cost ?? 0, reserved: 0, spent: 0 },
      };
      state.recovery = { limit: goal.budget.recovery ?? 0, spent: 0 };
      return;
    }
    case 'composition.recorded':
      return;
    case 'conclusion.cached': {
      state.conclusions.push(observation.payload as CachedConclusion);
      return;
    }
    case 'conclusion.policy':
    case 'policy.recorded': {
      const payload = observation.payload as { policy_id: string; goals: string[] };
      state.policies.push({ policy_id: payload.policy_id, goals: [...payload.goals], evidence: observation.seq });
      return;
    }
    case 'goal.missed': {
      const payload = observation.payload as { goal_id: string };
      if (state.goal && state.goal.goal_id === payload.goal_id) {
        state.goal.status = 'missed';
        state.workload.push({ goal_id: payload.goal_id, quality: 'missed' });
      }
      return;
    }
    case 'binding.corrected':
    case 'output.rejected': {
      const payload = observation.payload as { goal_id?: string; action_id: string; reason: string };
      state.corrections.push({
        goal_id: payload.goal_id ?? state.goal?.goal_id ?? '',
        kind: observation.payload_type === 'binding.corrected' ? 'binding' : 'output',
        action_id: payload.action_id,
        reason: payload.reason,
        evidence: observation.seq,
      });
      return;
    }
    case 'baseline.recorded': {
      state.baseline = observation.payload as BaselineRecord;
      return;
    }
    case 'workload.recorded': {
      const payload = observation.payload as { goal_id: string; quality: 'held' | 'missed' };
      const existing = state.workload.findIndex((item) => item.goal_id === payload.goal_id);
      const next = { goal_id: payload.goal_id, quality: payload.quality };
      if (existing >= 0) {
        state.workload[existing] = next;
      } else {
        state.workload.push(next);
      }
      return;
    }
    case 'baseline.requested':
    case 'experiment.requested':
    case 'provider.keepalive':
      return;
    case 'profile.recorded': {
      const payload = observation.payload as ContextProfileRecord;
      const record: ContextProfileRecord = {
        id: payload.id,
        version: payload.version,
        catalogue_budget: payload.catalogue_budget,
        ...(payload.prefix !== undefined ? { prefix: payload.prefix } : {}),
        ...(payload.slices !== undefined ? { slices: [...payload.slices] } : {}),
      };
      state.profiles[payload.id] = record;
      return;
    }
    case 'profile.retired': {
      const payload = observation.payload as { profile_id: string };
      delete state.profiles[payload.profile_id];
      if (state.strategy.profile_id === payload.profile_id) {
        state.strategy = { ...state.strategy, paused: true };
      }
      return;
    }
    case 'experiment.recorded': {
      const payload = observation.payload as Omit<ExperimentRecord, 'evidence' | 'invalidated'>;
      state.experiment = { ...payload, evidence: observation.seq, invalidated: false };
      return;
    }
    case 'experiment.compared': {
      const payload = observation.payload as ComparisonRecord;
      state.comparisons.push({ ...payload, evidence: observation.seq });
      return;
    }
    case 'experiment.amended': {
      const payload = observation.payload as {
        experiment_id: string;
        protected_cases?: string[];
        quality_bar?: string;
      };
      const experiment = state.experiment;
      if (!experiment || experiment.experiment_id !== payload.experiment_id) {
        return;
      }
      state.experiment = {
        ...experiment,
        ...(payload.protected_cases ? { protected_cases: [...payload.protected_cases] } : {}),
        ...(payload.quality_bar ? { quality_bar: payload.quality_bar } : {}),
      };
      return;
    }
    case 'experiment.invalidated': {
      const payload = observation.payload as { experiment_id: string };
      if (state.experiment && state.experiment.experiment_id === payload.experiment_id) {
        state.experiment = { ...state.experiment, invalidated: true };
      }
      return;
    }
    case 'experiment.regressed':
      return;
    case 'strategy.promoted': {
      const experiment = state.experiment;
      if (!experiment) {
        return;
      }
      const record = state.profiles[experiment.candidate];
      state.strategy = {
        profile_id: experiment.candidate,
        workload: experiment.workload,
        experiment_id: experiment.experiment_id,
        promoted: true,
        rolled_back: false,
        paused: record === undefined,
      };
      return;
    }
    case 'strategy.rolled_back': {
      const payload = observation.payload as { profile_id: string; experiment_id: string };
      const record = state.profiles[payload.profile_id];
      state.strategy = {
        profile_id: payload.profile_id,
        workload: state.strategy.workload,
        experiment_id: payload.experiment_id,
        promoted: false,
        rolled_back: true,
        paused: record === undefined,
      };
      return;
    }
    case 'source.registered':
    case 'source.changed': {
      const { resource, revision, content } = observation.payload as SourcePayload;
      state.sources[resource] = { revision, content, evidence: observation.seq };
      return;
    }
    case 'clock.tick': {
      const { tick } = observation.payload as ClockTickPayload;
      state.clock = { tick, evidence: observation.seq };
      expireApprovals(state, tick, observation.seq);
      return;
    }
    case 'weights.recorded': {
      const payload = observation.payload as { request_id?: string };
      if (!payload.request_id) {
        // Scripted weighing: the judgments unit is spent by the recorded result.
        state.budget.judgments.spent += 1;
      }
      return;
    }
    case 'inference.requested': {
      const p = observation.payload as InferenceRequestedPayload;
      state.inferences[p.request_id] = {
        request_id: p.request_id,
        request: p,
        recorded: null,
        evidence: [observation.seq],
      };
      state.budget.judgments.reserved += p.reservation.judgments;
      state.budget.cost.reserved += p.reservation.cost;
      return;
    }
    case 'inference.recorded': {
      const p = observation.payload as InferenceRecordedPayload;
      const record = state.inferences[p.request_id];
      if (!record) {
        throw new Error(`inference.recorded for unknown request ${p.request_id} passed validation`);
      }
      record.recorded = p;
      record.evidence.push(observation.seq);
      const reserved = record.request.reservation;
      state.budget.judgments.reserved -= reserved.judgments;
      state.budget.judgments.spent += reserved.judgments;
      state.budget.cost.reserved -= reserved.cost;
      state.budget.cost.spent += p.spent;
      return;
    }
    case 'action.started':
    case 'action.queued': {
      const p = observation.payload as ActionStartedPayload;
      const existing = state.actions[p.action_id];
      if (existing && observation.payload_type === 'action.started') {
        existing.state = 'running';
        existing.started_at = observation.seq;
        existing.grant = p.grant;
        existing.invocation_id = p.invocation_id ?? p.action_id;
        return;
      }
      state.actions[p.action_id] = {
        action_id: p.action_id,
        candidate_id: p.candidate_id,
        operation: p.operation,
        contract_rev: p.contract_rev,
        inputs: p.inputs,
        read_set: p.read_set,
        effects: p.effects,
        reservation: p.reservation,
        state: observation.payload_type === 'action.queued' ? 'pending' : 'running',
        cancel_requested: false,
        started_at: observation.payload_type === 'action.started' ? observation.seq : null,
        finished_at: null,
        grant: p.grant,
        invocation_id: p.invocation_id ?? p.action_id,
        reconciled: false,
      };
      state.budget.actions.reserved += p.reservation.actions;
      state.budget.judgments.reserved += p.reservation.judgments;
      return;
    }
    case 'action.result': {
      const p = observation.payload as ActionResultPayload;
      const record = state.actions[p.action_id];
      if (!record) {
        throw new Error(`result for unknown action ${p.action_id} passed validation`);
      }
      record.state = p.outcome.outcome;
      record.finished_at = observation.seq;
      state.budget.actions.reserved -= record.reservation.actions;
      state.budget.actions.spent += record.reservation.actions;
      state.budget.judgments.reserved -= record.reservation.judgments;
      state.budget.judgments.spent += record.reservation.judgments;
      if (p.outcome.outcome === 'succeeded') {
        integrateSuccess(state, record, p.outcome.output, observation.seq);
      }
      return;
    }
    case 'action.reconciled': {
      const p = observation.payload as ActionReconciledPayload;
      const record = state.actions[p.action_id];
      if (!record) {
        throw new Error(`reconciliation for unknown action ${p.action_id} passed validation`);
      }
      record.reconciled = true;
      if (p.outcome.outcome === 'succeeded') {
        integrateSuccess(state, record, p.outcome.output, observation.seq);
      }
      return;
    }
    case 'recovery.attempted': {
      state.recovery.spent += 1;
      return;
    }
    case 'recovery.exhausted':
      return;
    case 'action.cancel_requested': {
      const { action_id } = observation.payload as { action_id: string };
      const record = state.actions[action_id];
      if (record) {
        record.cancel_requested = true;
        if (record.state === 'pending') {
          record.state = 'cancelled';
          record.finished_at = observation.seq;
          state.budget.actions.reserved -= record.reservation.actions;
          state.budget.judgments.reserved -= record.reservation.judgments;
        }
      }
      return;
    }
    case 'approval.requested': {
      const request = observation.payload as ApprovalRequestedPayload;
      state.approvals[request.request_id] = {
        request_id: request.request_id,
        request,
        status: 'pending',
        evidence: [observation.seq],
        principal: null,
        authority_revision: null,
      };
      return;
    }
    case 'approval.decided': {
      const decision = observation.payload as ApprovalDecidedPayload;
      const record = state.approvals[decision.request_id];
      if (!record) {
        return;
      }
      if (record.status !== 'pending' && decision.decision !== 'revoked' && decision.decision !== 'expired') {
        return;
      }
      record.status = decision.decision;
      record.principal = decision.principal;
      record.authority_revision = decision.authority_revision;
      record.evidence.push(observation.seq);
      if (decision.scope?.valid_until_tick !== undefined) {
        record.request = { ...record.request, valid_until_tick: decision.scope.valid_until_tick };
      }
      return;
    }
    case 'capability.described': {
      const p = observation.payload as CapabilityDescribedPayload;
      state.contracts[p.operation] = p.contract;
      return;
    }
    case 'admission.decided': {
      const p = observation.payload as AdmissionDecidedPayload;
      const admission = state.crystallization.admission;
      if (!admission) {
        return;
      }
      state.crystallization.admission = {
        ...admission,
        status: p.decision === 'admitted' ? 'admitted' : 'denied',
        approver: p.approver,
      };
      return;
    }
    case 'implementation.revoked': {
      state.crystallization.revoked = true;
      const admission = state.crystallization.admission;
      if (admission && admission.status !== 'denied') {
        state.crystallization.admission = { ...admission, status: 'denied' };
      }
      return;
    }
    case 'evidence.invalidated': {
      const search = state.crystallization.search;
      state.crystallization = emptyCrystallization();
      state.crystallization.search = search;
      return;
    }
    default:
      throw new Error(`unknown payload type ${observation.payload_type} passed validation`);
  }
}

function integrateSuccess(state: MutableState, record: ActionRecord, output: unknown, seq: Seq): void {
  switch (record.operation) {
    case 'source.inspect': {
      const result = output as InspectionResult;
      state.inspections[result.source] = { result, evidence: seq };
      return;
    }
    case 'report.assemble': {
      const report = output as Report;
      const evidence: Seq[] = [];
      for (const entry of report.entries) {
        const inspection = state.inspections[entry.source];
        if (inspection) {
          evidence.push(inspection.evidence);
        }
      }
      evidence.push(seq);
      state.report = { report, evidence };
      return;
    }
    case 'goal.complete': {
      if (state.goal && state.goal.status === 'active') {
        state.goal.status = 'complete';
        state.workload.push({ goal_id: state.goal.goal_id, quality: 'held' });
      }
      return;
    }
    case 'report.publish': {
      const receipt = output as PublishReceipt;
      state.publication = { receipt, evidence: seq };
      return;
    }
    case 'goal.frame': {
      const proposal = output as Proposal;
      state.proposal = { proposal, evidence: seq };
      return;
    }
    case 'gap.search': {
      state.crystallization.search = output as CrystallizationState['search'];
      return;
    }
    case 'contract.establish': {
      const body = output as { contract_id: string; contract_revision: string };
      state.crystallization.contract = { id: body.contract_id, revision: body.contract_revision };
      return;
    }
    case 'corpus.propose': {
      const body = output as { split: string; case_ids: string[] };
      if (body.split === 'visible') {
        state.crystallization.visible_ids = body.case_ids;
      } else {
        state.crystallization.held_out_ids = body.case_ids;
      }
      return;
    }
    case 'corpus.validate': {
      const body = output as { corpus_revision: string; validated: boolean };
      state.crystallization.corpus_revision = body.corpus_revision;
      state.crystallization.corpus_validated = body.validated;
      return;
    }
    case 'red.demonstrate': {
      const body = output as { demonstrated: boolean; corpus_revision: string; contract_revision: string };
      state.crystallization.red = {
        demonstrated: body.demonstrated,
        corpus_revision: body.corpus_revision,
        contract_revision: body.contract_revision,
      };
      return;
    }
    case 'implementation.generate': {
      const body = output as { implementation_id: string; source_digest: string };
      state.crystallization.implementations = [
        ...state.crystallization.implementations,
        { id: body.implementation_id, source_digest: body.source_digest },
      ];
      return;
    }
    case 'green.prove': {
      const body = output as {
        implementation_id: string;
        proven: boolean;
        evidence_digest: string;
        corpus_revision: string;
        contract_revision: string;
      };
      state.crystallization.held_out_spent = true;
      state.crystallization.green = [
        ...state.crystallization.green,
        {
          id: body.implementation_id,
          proven: body.proven,
          evidence_digest: body.evidence_digest,
          corpus_revision: body.corpus_revision,
          contract_revision: body.contract_revision,
        },
      ];
      return;
    }
    case 'admission.request': {
      const body = output as { request_id: string; implementation_id: string; evidence_digest: string };
      state.crystallization.admission = {
        request_id: body.request_id,
        implementation_id: body.implementation_id,
        evidence_digest: body.evidence_digest,
        status: 'requested',
        approver: null,
      };
      return;
    }
    case 'report.fold': {
      const fold = (output as { fold: string }).fold;
      const inspections = (record.inputs as { inspections?: InspectionResult[] }).inspections ?? [];
      state.crystallization.fold = { fold, bound: inspections };
      return;
    }
    case 'text.normalize': {
      const text = (output as { text?: unknown }).text;
      const entry = record.read_set.find((item) => 'resource' in item);
      if (typeof text !== 'string' || !entry || !('resource' in entry)) {
        return;
      }
      state.normalized[entry.resource] = { text, revision: entry.revision, evidence: seq };
      return;
    }
    default:
      return;
  }
}

function expireApprovals(state: MutableState, tick: number, seq: Seq): void {
  for (const record of Object.values(state.approvals)) {
    if (record.status === 'pending' || record.status === 'approved') {
      if (tick > record.request.valid_until_tick) {
        record.status = 'expired';
        record.evidence.push(seq);
      }
    }
  }
}

export function readSetMatches(read_set: readonly ResourceReadSetEntry[], state: State | MutableState): boolean {
  return read_set.every((entry) => state.sources[entry.resource]?.revision === entry.revision);
}

export function foldState(observations: readonly Observation[]): State {
  const state = initialState();
  for (const observation of [...observations].sort((a, b) => a.seq - b.seq)) {
    if (observation.validation.status === 'accepted') {
      applyAccepted(state, observation);
    }
  }
  return snapshot(state);
}

export function snapshot(state: MutableState): State {
  return structuredClone(state) as State;
}
