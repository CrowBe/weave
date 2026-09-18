/**
 * Derived state (§4): a deterministic fold over accepted observations in seq
 * order. `state_revision` is the seq of the last accepted observation.
 */
import type {
  ActionRecord,
  ActionResultPayload,
  ActionStartedPayload,
  ApprovalDecidedPayload,
  ApprovalRecord,
  ApprovalRequestedPayload,
  BudgetLine,
  CapabilityDescribedPayload,
  ClockTickPayload,
  Goal,
  InspectionResult,
  Observation,
  PublishReceipt,
  Report,
  ResourceReadSetEntry,
  Seq,
  SourcePayload,
  State,
} from './types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface MutableState {
  state_revision: Seq;
  goal: (Goal & { status: 'active' | 'complete'; evidence: Seq }) | null;
  sources: Record<string, { revision: number; content: string; evidence: Seq }>;
  actions: Record<string, Mutable<ActionRecord>>;
  inspections: Record<string, { result: InspectionResult; evidence: Seq }>;
  report: { report: Report; evidence: Seq[] } | null;
  publication: { receipt: PublishReceipt; evidence: Seq } | null;
  budget: { actions: Mutable<BudgetLine>; judgments: Mutable<BudgetLine> };
  clock: { tick: number; evidence: Seq | null };
  approvals: Record<string, Mutable<ApprovalRecord> & { evidence: Seq[] }>;
  contracts: Record<string, unknown>;
  recovery: { limit: number; spent: number };
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
    },
    clock: { tick: 0, evidence: null },
    approvals: {},
    contracts: {},
    recovery: { limit: 0, spent: 0 },
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
      state.budget = {
        actions: { limit: goal.budget.actions, reserved: 0, spent: 0 },
        judgments: { limit: goal.budget.judgments, reserved: 0, spent: 0 },
      };
      state.recovery = { limit: goal.budget.recovery ?? 0, spent: 0 };
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
    case 'weights.recorded':
      // The judgments unit reserved by policy for frontier.weigh is spent by the recorded result.
      state.budget.judgments.spent += 1;
      return;
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
      if (state.goal) {
        state.goal.status = 'complete';
      }
      return;
    }
    case 'report.publish': {
      const receipt = output as PublishReceipt;
      state.publication = { receipt, evidence: seq };
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
