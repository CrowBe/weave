/**
 * Derived state (§4): a deterministic fold over accepted observations in seq
 * order. `state_revision` is the seq of the last accepted observation.
 */
import type {
  ActionRecord,
  ActionResultPayload,
  ActionStartedPayload,
  BudgetLine,
  Goal,
  InspectionResult,
  Observation,
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
  budget: { actions: Mutable<BudgetLine>; judgments: Mutable<BudgetLine> };
}

export function initialState(): MutableState {
  return {
    state_revision: 0,
    goal: null,
    sources: {},
    actions: {},
    inspections: {},
    report: null,
    budget: {
      actions: { limit: 0, reserved: 0, spent: 0 },
      judgments: { limit: 0, reserved: 0, spent: 0 },
    },
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
      return;
    }
    case 'source.registered':
    case 'source.changed': {
      const { resource, revision, content } = observation.payload as SourcePayload;
      state.sources[resource] = { revision, content, evidence: observation.seq };
      return;
    }
    case 'clock.tick':
      return;
    case 'weights.recorded':
      // The judgments unit reserved by policy for frontier.weigh is spent by the recorded result.
      state.budget.judgments.spent += 1;
      return;
    case 'action.started': {
      const p = observation.payload as ActionStartedPayload;
      state.actions[p.action_id] = {
        action_id: p.action_id,
        candidate_id: p.candidate_id,
        operation: p.operation,
        contract_rev: p.contract_rev,
        inputs: p.inputs,
        read_set: p.read_set,
        effects: p.effects,
        reservation: p.reservation,
        state: 'running',
        cancel_requested: false,
        started_at: observation.seq,
        finished_at: null,
        grant: p.grant,
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
      }
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
    default:
      return;
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
