/**
 * Deterministic validation at append time (§3). Only `accepted` observations
 * may participate in a transition. Validation consults current state so that
 * a structurally valid payload cannot reference work that does not exist.
 */
import { isEffect } from '@weave/agentsop';
import { candidateSetDigest } from './digest.js';
import { PAYLOAD_TYPES, type ObservationInput, type PayloadType, type ProvenanceKind, type State, type Validation } from './types.js';

const ACCEPTED: Validation = { status: 'accepted' };

const EXPECTED_SOURCE: Readonly<Record<PayloadType, readonly ProvenanceKind[]>> = {
  'goal.opened': ['operator'],
  'source.registered': ['test'],
  'source.changed': ['test'],
  'clock.tick': ['clock'],
  'weights.recorded': ['judgment'],
  'action.started': ['runtime'],
  'action.queued': ['runtime'],
  'action.result': ['host', 'runtime'],
  'action.reconciled': ['host', 'runtime'],
  'action.cancel_requested': ['operator', 'runtime'],
  'approval.requested': ['runtime'],
  'approval.decided': ['operator', 'runtime'],
  'capability.described': ['runtime'],
  'recovery.attempted': ['runtime'],
  'recovery.exhausted': ['runtime'],
};

function rejected(reason: string): Validation {
  return { status: 'rejected', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isReadSet(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isNonNegativeInteger(entry['revision']) &&
        (isNonEmptyString(entry['resource']) !== isNonEmptyString(entry['state_field'])),
    )
  );
}

function isEffectList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => isRecord(entry) && isNonEmptyString(entry['resource']) && isEffect(entry['mode']))
  );
}

function isReservation(value: unknown): value is { actions: number; judgments: number } {
  return isRecord(value) && isNonNegativeInteger(value['actions']) && isNonNegativeInteger(value['judgments']);
}

function isPayloadType(value: string): value is PayloadType {
  return (PAYLOAD_TYPES as readonly string[]).includes(value);
}

export function validate(input: ObservationInput, state: State): Validation {
  if (!isPayloadType(input.payload_type)) {
    return { status: 'unknown_type' };
  }
  if (input.payload_version !== 1) {
    return rejected(`unsupported payload_version ${input.payload_version}`);
  }
  if (!EXPECTED_SOURCE[input.payload_type].includes(input.source.kind)) {
    return rejected(`${input.payload_type} cannot come from source kind ${input.source.kind}`);
  }
  const payload = input.payload;
  if (!isRecord(payload)) {
    return rejected('payload must be a record');
  }

  switch (input.payload_type) {
    case 'goal.opened':
      return validateGoal(payload, state);
    case 'source.registered':
      return validateSource(payload, state, 'registered');
    case 'source.changed':
      return validateSource(payload, state, 'changed');
    case 'clock.tick':
      return isNonNegativeInteger(payload['tick']) ? ACCEPTED : rejected('tick must be a non-negative integer');
    case 'weights.recorded':
      return validateWeights(payload, state);
    case 'action.started':
      return validateStarted(payload, state, false);
    case 'action.queued':
      return validateStarted(payload, state, true);
    case 'action.result':
      return validateResult(payload, state);
    case 'action.reconciled':
      return validateReconciled(payload, state);
    case 'recovery.attempted':
      return validateRecoveryAttempt(payload, state);
    case 'recovery.exhausted':
      return isNonEmptyString(payload['reason']) ? ACCEPTED : rejected('recovery.exhausted requires a reason');
    case 'action.cancel_requested':
      if (!isNonEmptyString(payload['action_id']) || !state.actions[payload['action_id']]) {
        return rejected('cancel names an unknown action');
      }
      return isNonEmptyString(payload['reason']) ? ACCEPTED : rejected('cancel requires a reason');
    case 'approval.requested':
      return validateApprovalRequest(payload, state);
    case 'approval.decided':
      return validateApprovalDecision(payload, state);
    case 'capability.described':
      return isNonEmptyString(payload['operation']) && payload['contract'] !== undefined
        ? ACCEPTED
        : rejected('capability.described requires operation and contract');
  }
}

function validateGoal(payload: Record<string, unknown>, state: State): Validation {
  if (state.goal) {
    return rejected('a goal is already open');
  }
  if (!isNonEmptyString(payload['goal_id']) || typeof payload['purpose'] !== 'string') {
    return rejected('goal requires goal_id and purpose');
  }
  const sources = payload['sources'];
  if (!isStringArray(sources) || sources.length === 0 || new Set(sources).size !== sources.length) {
    return rejected('goal.sources must be a non-empty list of distinct resource ids');
  }
  const authority = payload['authority'];
  if (!isRecord(authority) || !isStringArray(authority['read'])) {
    return rejected('goal.authority.read must be a list of resource ids');
  }
  if (authority['write'] !== undefined && !isStringArray(authority['write'])) {
    return rejected('goal.authority.write must be a list of resource ids');
  }
  if (payload['destination'] !== undefined && !isNonEmptyString(payload['destination'])) {
    return rejected('goal.destination must be a resource id');
  }
  if (!isReservation(payload['budget'])) {
    return rejected('goal.budget must give non-negative integer actions and judgments');
  }
  const budget = payload['budget'] as Record<string, unknown>;
  if (budget['recovery'] !== undefined && !isNonNegativeInteger(budget['recovery'])) {
    return rejected('goal.budget.recovery must be a non-negative integer');
  }
  if (typeof payload['success_evidence'] !== 'string') {
    return rejected('goal requires success_evidence');
  }
  return ACCEPTED;
}

function validateSource(payload: Record<string, unknown>, state: State, kind: 'registered' | 'changed'): Validation {
  if (!isNonEmptyString(payload['resource'])) {
    return rejected('source requires a resource id');
  }
  if (!isNonNegativeInteger(payload['revision']) || payload['revision'] < 1) {
    return rejected('source requires a positive integer revision');
  }
  if (typeof payload['content'] !== 'string') {
    return rejected('source requires string content');
  }
  const current = state.sources[payload['resource']];
  if (kind === 'registered' && current) {
    return rejected(`resource ${payload['resource']} is already registered`);
  }
  if (kind === 'changed') {
    if (!current) {
      return rejected(`resource ${payload['resource']} is not registered`);
    }
    if (payload['revision'] <= current.revision) {
      return rejected(`revision ${payload['revision']} does not advance ${current.revision}`);
    }
  }
  return ACCEPTED;
}

function validateWeights(payload: Record<string, unknown>, state: State): Validation {
  if (payload['site'] !== 'frontier.weigh') {
    return rejected('unknown judgment site');
  }
  if (!isNonEmptyString(payload['implementation'])) {
    return rejected('weights require the implementation that produced them');
  }
  if (payload['state_revision'] !== state.state_revision) {
    return rejected(`weights evaluated state_revision ${String(payload['state_revision'])}, current is ${state.state_revision}`);
  }
  const weights = payload['weights'];
  if (
    !Array.isArray(weights) ||
    !weights.every(
      (w) => isRecord(w) && isNonEmptyString(w['candidate_id']) && typeof w['weight'] === 'number' && Number.isFinite(w['weight']),
    )
  ) {
    return rejected('weights must be a list of { candidate_id, finite weight }');
  }
  const ids = (weights as { candidate_id: string }[]).map((w) => w.candidate_id);
  if (new Set(ids).size !== ids.length) {
    return rejected('weights name a candidate more than once');
  }
  if (payload['candidate_set'] !== candidateSetDigest(ids)) {
    return rejected('weights do not cover exactly the weighed candidate set');
  }
  return ACCEPTED;
}

function validateStarted(payload: Record<string, unknown>, state: State, queued: boolean): Validation {
  const action_id = payload['action_id'];
  if (!isNonEmptyString(action_id) || !/^a:\d+:\d+$/.test(action_id)) {
    return rejected('action_id must have the form a:<cycle_no>:<index>');
  }
  const existing = state.actions[action_id];
  if (existing && (queued || existing.state !== 'pending')) {
    return rejected(`action ${action_id} already exists`);
  }
  if (!isNonEmptyString(payload['candidate_id']) || !isNonEmptyString(payload['operation'])) {
    return rejected('action.started requires candidate_id and operation');
  }
  if (payload['contract_rev'] !== null && !isNonEmptyString(payload['contract_rev'])) {
    return rejected('contract_rev must be a string or null');
  }
  if (!isReadSet(payload['read_set']) || !isEffectList(payload['effects'])) {
    return rejected('action.started requires a well-formed read_set and effects');
  }
  const reservation = payload['reservation'];
  if (!isReservation(reservation)) {
    return rejected('action.started requires a reservation');
  }
  if (!existing) {
    const { actions, judgments } = state.budget;
    if (
      reservation.actions > actions.limit - actions.reserved - actions.spent ||
      reservation.judgments > judgments.limit - judgments.reserved - judgments.spent
    ) {
      return rejected('reservation exceeds the available budget');
    }
  }
  const grant = payload['grant'];
  if (grant !== null) {
    if (!isRecord(grant) || grant['action_id'] !== action_id || grant['operation'] !== payload['operation']) {
      return rejected('grant must name this action and operation');
    }
  }
  return ACCEPTED;
}

function validateResult(payload: Record<string, unknown>, state: State): Validation {
  const action_id = payload['action_id'];
  if (!isNonEmptyString(action_id)) {
    return rejected('action.result requires an action_id');
  }
  const record = state.actions[action_id];
  if (!record) {
    return rejected(`no action ${action_id}`);
  }
  if (record.state !== 'running') {
    return rejected(`action ${action_id} is ${record.state}, not running`);
  }
  const outcome = payload['outcome'];
  if (!isRecord(outcome)) {
    return rejected('action.result requires an outcome');
  }
  switch (outcome['outcome']) {
    case 'succeeded':
      return validateOutput(record.operation, record.inputs, outcome['output']);
    case 'failed':
      return isNonEmptyString(outcome['failure']) ? ACCEPTED : rejected('failed outcome requires a failure code');
    case 'uncertain':
      return isNonEmptyString(outcome['reason']) ? ACCEPTED : rejected('uncertain outcome requires a reason');
    default:
      return rejected('outcome must be succeeded, failed, or uncertain');
  }
}

function validateReconciled(payload: Record<string, unknown>, state: State): Validation {
  const action_id = payload['action_id'];
  if (!isNonEmptyString(action_id)) {
    return rejected('action.reconciled requires an action_id');
  }
  const record = state.actions[action_id];
  if (!record) {
    return rejected(`no action ${action_id}`);
  }
  if (record.state !== 'uncertain') {
    return rejected(`action ${action_id} is ${record.state}, not uncertain`);
  }
  if (record.reconciled) {
    return rejected(`action ${action_id} is already reconciled`);
  }
  if (!isNonEmptyString(payload['invocation_id'])) {
    return rejected('action.reconciled requires an invocation_id');
  }
  const outcome = payload['outcome'];
  if (!isRecord(outcome)) {
    return rejected('action.reconciled requires an outcome');
  }
  switch (outcome['outcome']) {
    case 'succeeded':
      return validateOutput(record.operation, record.inputs, outcome['output']);
    case 'failed':
      return isNonEmptyString(outcome['failure']) ? ACCEPTED : rejected('failed outcome requires a failure code');
    case 'uncertain':
      return isNonEmptyString(outcome['reason']) ? ACCEPTED : rejected('uncertain outcome requires a reason');
    default:
      return rejected('outcome must be succeeded, failed, or uncertain');
  }
}

function validateRecoveryAttempt(payload: Record<string, unknown>, state: State): Validation {
  const action_id = payload['action_id'];
  if (!isNonEmptyString(action_id) || !isNonEmptyString(payload['invocation_id'])) {
    return rejected('recovery.attempted requires action_id and invocation_id');
  }
  const record = state.actions[action_id];
  if (!record) {
    return rejected(`no action ${action_id}`);
  }
  if (record.state !== 'running' && record.state !== 'uncertain') {
    return rejected(`action ${action_id} is ${record.state}, not awaiting recovery`);
  }
  if (state.recovery.limit === 0 || state.recovery.spent >= state.recovery.limit) {
    return rejected('recovery allowance exhausted');
  }
  return ACCEPTED;
}

/** Fixture contract outputs are checked for shape so a malformed result cannot become evidence. */
function validateOutput(operation: string, inputs: unknown, output: unknown): Validation {
  switch (operation) {
    case 'source.inspect': {
      const source = isRecord(inputs) ? inputs['source'] : undefined;
      if (
        !isRecord(output) ||
        output['source'] !== source ||
        !isNonNegativeInteger(output['revision']) ||
        !isNonNegativeInteger(output['line_count']) ||
        !isNonEmptyString(output['digest'])
      ) {
        return rejected('source.inspect output is not an InspectionResult for the requested source');
      }
      return ACCEPTED;
    }
    case 'report.assemble': {
      if (!isRecord(output) || !Array.isArray(output['entries']) || !isReadSet(output['read_set'])) {
        return rejected('report.assemble output is not a Report');
      }
      return ACCEPTED;
    }
    case 'report.publish': {
      if (
        !isRecord(output) ||
        !isNonEmptyString(output['invocation_id']) ||
        !isNonEmptyString(output['report_digest']) ||
        !isNonEmptyString(output['destination']) ||
        !isNonNegativeInteger(output['committed_revision'])
      ) {
        return rejected('report.publish output is not a publication receipt');
      }
      return ACCEPTED;
    }
    default:
      return ACCEPTED;
  }
}

function validateApprovalRequest(payload: Record<string, unknown>, state: State): Validation {
  if (!isNonEmptyString(payload['request_id']) || !isNonEmptyString(payload['operation'])) {
    return rejected('approval.requested requires request_id and operation');
  }
  if (state.approvals[payload['request_id'] as string]?.status === 'pending') {
    return rejected('approval request is already pending');
  }
  if (!isNonEmptyString(payload['binding_digest']) || !isNonEmptyString(payload['destination'])) {
    return rejected('approval.requested requires a binding and destination');
  }
  return ACCEPTED;
}

function validateApprovalDecision(payload: Record<string, unknown>, state: State): Validation {
  const request_id = payload['request_id'];
  if (!isNonEmptyString(request_id)) {
    return rejected('approval.decided requires request_id');
  }
  const record = state.approvals[request_id];
  if (!record) {
    return rejected('approval.decided names an unknown request');
  }
  const decision = payload['decision'];
  if (decision !== 'approved' && decision !== 'denied' && decision !== 'revoked' && decision !== 'expired') {
    return rejected('unknown approval decision');
  }
  if (record.status !== 'pending' && decision !== 'revoked' && decision !== 'expired') {
    return rejected('closed request cannot be answered as though it were still pending');
  }
  return isNonEmptyString(payload['principal']) && isNonNegativeInteger(payload['authority_revision'])
    ? ACCEPTED
    : rejected('approval.decided requires principal and authority_revision');
}
