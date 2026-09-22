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
  'weights.recorded': ['judgment', 'gateway'],
  'action.started': ['runtime'],
  'action.queued': ['runtime'],
  'action.result': ['host', 'runtime', 'gateway'],
  'action.reconciled': ['host', 'runtime'],
  'action.cancel_requested': ['operator', 'runtime'],
  'approval.requested': ['runtime'],
  'approval.decided': ['operator', 'runtime'],
  'capability.described': ['runtime'],
  'recovery.attempted': ['runtime'],
  'recovery.exhausted': ['runtime'],
  'inference.requested': ['runtime'],
  'inference.recorded': ['gateway'],
  'admission.decided': ['operator'],
  'implementation.revoked': ['operator'],
  'evidence.invalidated': ['operator'],
  'composition.recorded': ['operator'],
  'conclusion.cached': ['runtime'],
  'policy.recorded': ['operator'],
  'goal.missed': ['operator'],
  'binding.corrected': ['operator'],
  'output.rejected': ['operator'],
  'baseline.recorded': ['runtime'],
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
    case 'inference.requested':
      return validateInferenceRequested(payload, state);
    case 'inference.recorded':
      return validateInferenceRecorded(payload, state);
    case 'admission.decided':
      return validateAdmission(payload, state);
    case 'implementation.revoked':
      return isNonEmptyString(payload['operation']) && isNonEmptyString(payload['implementation_id']) && isNonEmptyString(payload['reason'])
        ? ACCEPTED
        : rejected('implementation.revoked requires operation, implementation_id, and reason');
    case 'evidence.invalidated':
      return isNonEmptyString(payload['reason']) && isNonEmptyString(payload['contract_revision'])
        ? ACCEPTED
        : rejected('evidence.invalidated requires reason and contract_revision');
    case 'composition.recorded':
      return validateComposition(payload);
    case 'conclusion.cached':
      return validateConclusion(payload);
    case 'policy.recorded':
      return validatePolicy(payload);
    case 'goal.missed':
      return validateMissed(payload, state);
    case 'binding.corrected':
      return validateCorrection(payload);
    case 'output.rejected':
      return validateCorrection(payload);
    case 'baseline.recorded':
      return validateBaseline(payload);
  }
}

function validateGoal(payload: Record<string, unknown>, state: State): Validation {
  if (state.goal && state.goal.status === 'active') {
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
  if (payload['framing'] !== undefined && payload['framing'] !== true && payload['framing'] !== false) {
    return rejected('goal.framing must be a boolean');
  }
  if (payload['composition_id'] !== undefined && !isNonEmptyString(payload['composition_id'])) {
    return rejected('goal.composition_id must be a non-empty string');
  }
  if (payload['gap'] !== undefined) {
    const gap = payload['gap'];
    if (!isRecord(gap) || !isNonEmptyString(gap['operation']) || typeof gap['purpose'] !== 'string') {
      return rejected('goal.gap requires operation and purpose');
    }
    if (!isTypeMap(gap['input']) || !isTypeMap(gap['output'])) {
      return rejected('goal.gap requires input and output type maps');
    }
    if (gap['variants'] !== undefined && !isStringArray(gap['variants'])) {
      return rejected('goal.gap.variants must be a list of ids');
    }
  }
  if (payload['retained_procedure'] !== undefined && typeof payload['retained_procedure'] !== 'string') {
    return rejected('goal.retained_procedure must be a string');
  }
  if (!isReservation(payload['budget'])) {
    return rejected('goal.budget must give non-negative integer actions and judgments');
  }
  const budget = payload['budget'] as Record<string, unknown>;
  if (budget['recovery'] !== undefined && !isNonNegativeInteger(budget['recovery'])) {
    return rejected('goal.budget.recovery must be a non-negative integer');
  }
  if (budget['cost'] !== undefined && !isNonNegativeInteger(budget['cost'])) {
    return rejected('goal.budget.cost must be a non-negative integer');
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
    case 'goal.frame': {
      if (!isRecord(output) || !Array.isArray(output['bindings']) || !Array.isArray(output['rejected'])) {
        return rejected('goal.frame output is not a Proposal');
      }
      return ACCEPTED;
    }
    case 'report.fold': {
      return isRecord(output) && isNonEmptyString(output['fold']) ? ACCEPTED : rejected('report.fold output requires a fold string');
    }
    case 'gap.search': {
      return outputStatus(output, ['reusable', 'composed', 'gap']) ? ACCEPTED : rejected('gap.search output is not a search result');
    }
    case 'contract.establish': {
      return isRecord(output) && isNonEmptyString(output['contract_id']) && isNonEmptyString(output['contract_revision'])
        ? ACCEPTED
        : rejected('contract.establish output requires a contract id and revision');
    }
    case 'corpus.propose': {
      return isRecord(output) && (output['split'] === 'visible' || output['split'] === 'held_out') && isStringArray(output['case_ids'])
        ? ACCEPTED
        : rejected('corpus.propose output requires a split and case ids');
    }
    case 'corpus.validate': {
      return isRecord(output) && output['validated'] === true && isNonEmptyString(output['corpus_revision'])
        ? ACCEPTED
        : rejected('corpus.validate output requires a validated corpus revision');
    }
    case 'red.demonstrate': {
      return isRecord(output) && output['demonstrated'] === true && isRecord(output['isolation'])
        ? ACCEPTED
        : rejected('red.demonstrate output requires demonstrated red and an isolation report');
    }
    case 'implementation.generate': {
      return isRecord(output) && isNonEmptyString(output['implementation_id']) && isNonEmptyString(output['source_digest']) && isRecord(output['view'])
        ? ACCEPTED
        : rejected('implementation.generate output requires an id, digest, and implementer view');
    }
    case 'green.prove': {
      if (!isRecord(output) || !isNonEmptyString(output['implementation_id']) || typeof output['proven'] !== 'boolean') {
        return rejected('green.prove output requires an implementation id and proven flag');
      }
      if (!isCount(output['held_out']) || !isCount(output['visible'])) {
        return rejected('green.prove output requires visible and held-out counts');
      }
      return ACCEPTED;
    }
    case 'admission.request': {
      return isRecord(output) && isNonEmptyString(output['request_id']) && isNonEmptyString(output['evidence_digest'])
        ? ACCEPTED
        : rejected('admission.request output requires a request id and evidence digest');
    }
    default:
      return ACCEPTED;
  }
}

function outputStatus(output: unknown, allowed: readonly string[]): boolean {
  return isRecord(output) && typeof output['status'] === 'string' && allowed.includes(output['status']);
}

function isCount(value: unknown): boolean {
  return isRecord(value) && isNonNegativeInteger(value['passed']) && isNonNegativeInteger(value['failed']) && !('cases' in value);
}

function isTypeMap(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => isNonEmptyString(key) && isNonEmptyString(value[key]));
}

function validateAdmission(payload: Record<string, unknown>, state: State): Validation {
  const request_id = payload['request_id'];
  if (!isNonEmptyString(request_id)) {
    return rejected('admission.decided requires request_id');
  }
  const admission = state.crystallization.admission;
  if (!admission || admission.request_id !== request_id || admission.status !== 'requested') {
    return rejected('admission.decided names a request that is not pending');
  }
  if (payload['implementation_id'] !== admission.implementation_id || payload['evidence_digest'] !== admission.evidence_digest) {
    return rejected('admission.decided does not match the recorded evidence');
  }
  if (payload['decision'] !== 'admitted' && payload['decision'] !== 'denied') {
    return rejected('unknown admission decision');
  }
  return isNonEmptyString(payload['approver']) && isNonNegativeInteger(payload['authority_revision'])
    ? ACCEPTED
    : rejected('admission.decided requires approver and authority_revision');
}

function validateInferenceRequested(payload: Record<string, unknown>, state: State): Validation {
  if (!isNonEmptyString(payload['request_id'])) {
    return rejected('inference.requested requires request_id');
  }
  if (state.inferences[payload['request_id'] as string]?.recorded === null && state.inferences[payload['request_id'] as string]) {
    return rejected('inference request is already pending');
  }
  const site = payload['site'];
  if (site !== 'frontier.weigh' && site !== 'goal.frame') {
    return rejected('unknown inference site');
  }
  if (payload['role'] !== 'framing' && payload['role'] !== 'working') {
    return rejected('inference.requested requires a role');
  }
  if (!isNonEmptyString(payload['kind'])) {
    return rejected('inference.requested requires a kind');
  }
  if (!isRecord(payload['view']) || !isNonEmptyString(payload['view']['profile'])) {
    return rejected('inference.requested requires a state view');
  }
  if (!isNonNegativeInteger(payload['state_revision'])) {
    return rejected('inference.requested requires state_revision');
  }
  const reservation = payload['reservation'];
  if (!isRecord(reservation) || !isNonNegativeInteger(reservation['judgments']) || !isNonNegativeInteger(reservation['cost'])) {
    return rejected('inference.requested requires a reservation');
  }
  const { judgments, cost } = state.budget;
  if (
    (reservation['judgments'] as number) > judgments.limit - judgments.reserved - judgments.spent ||
    (reservation['cost'] as number) > cost.limit - cost.reserved - cost.spent
  ) {
    return rejected('inference reservation exceeds the available budget');
  }
  return ACCEPTED;
}

function validateInferenceRecorded(payload: Record<string, unknown>, state: State): Validation {
  if (!isNonEmptyString(payload['request_id'])) {
    return rejected('inference.recorded requires request_id');
  }
  const existing = state.inferences[payload['request_id'] as string];
  if (!existing) {
    return rejected('inference.recorded names an unknown request');
  }
  if (existing.recorded) {
    return rejected('inference request is already recorded');
  }
  if (!Array.isArray(payload['attempts'])) {
    return rejected('inference.recorded requires attempts');
  }
  if (!isNonNegativeInteger(payload['spent'])) {
    return rejected('inference.recorded requires spent');
  }
  const status = payload['status'];
  if (status !== 'accepted' && status !== 'unaccepted' && status !== 'blocked') {
    return rejected('unknown inference status');
  }
  return ACCEPTED;
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

function validateComposition(payload: Record<string, unknown>): Validation {
  if (!isNonEmptyString(payload['composition_id']) || !Array.isArray(payload['steps']) || payload['steps'].length === 0) {
    return rejected('composition.recorded requires composition_id and steps');
  }
  const steps = payload['steps'];
  if (!steps.every((step) => isRecord(step) && isNonEmptyString(step['operation']))) {
    return rejected('composition steps require an operation');
  }
  return ACCEPTED;
}

function validateConclusion(payload: Record<string, unknown>): Validation {
  if (
    !isNonEmptyString(payload['conclusion_id']) ||
    !isNonEmptyString(payload['operation']) ||
    !isNonEmptyString(payload['contract_rev']) ||
    !isNonEmptyString(payload['implementation_id']) ||
    !isNonEmptyString(payload['input_digest']) ||
    !('output' in payload)
  ) {
    return rejected('conclusion.cached requires identity, digest, and output');
  }
  if (!Array.isArray(payload['evidence']) || payload['evidence'].length === 0 || !payload['evidence'].every(isNonNegativeInteger)) {
    return rejected('conclusion.cached requires evidence seqs');
  }
  if (!isReadSet(payload['read_set'])) {
    return rejected('conclusion.cached requires a read set');
  }
  const scope = payload['authority_scope'];
  if (!isRecord(scope) || isNonEmptyString(scope['goal_id']) === isNonEmptyString(scope['policy_id'])) {
    return rejected('conclusion.cached requires an authority scope');
  }
  const invalidation = payload['invalidation'];
  const allowed = new Set(['read_set', 'contract_rev', 'admission']);
  if (!Array.isArray(invalidation) || invalidation.length === 0 || !invalidation.every((item) => typeof item === 'string' && allowed.has(item))) {
    return rejected('conclusion.cached requires invalidation conditions');
  }
  return ACCEPTED;
}

function validatePolicy(payload: Record<string, unknown>): Validation {
  if (!isNonEmptyString(payload['policy_id']) || !isStringArray(payload['goals']) || new Set(payload['goals']).size !== payload['goals'].length) {
    return rejected('policy.recorded requires a policy_id and distinct goals');
  }
  if (payload['goals'].length < 2) {
    return rejected('policy.recorded must name both goals');
  }
  return ACCEPTED;
}

function validateMissed(payload: Record<string, unknown>, state: State): Validation {
  if (!isNonEmptyString(payload['goal_id']) || !isNonEmptyString(payload['reason'])) {
    return rejected('goal.missed requires goal_id and reason');
  }
  if (!state.goal || state.goal.goal_id !== payload['goal_id'] || state.goal.status !== 'active') {
    return rejected('goal.missed names a goal that is not active');
  }
  return ACCEPTED;
}

function validateCorrection(payload: Record<string, unknown>): Validation {
  if (!isNonEmptyString(payload['goal_id']) || !isNonEmptyString(payload['action_id']) || !isNonEmptyString(payload['reason'])) {
    return rejected('a human correction requires goal_id, action_id, and reason');
  }
  return ACCEPTED;
}

function validateBaseline(payload: Record<string, unknown>): Validation {
  if (payload['strategy'] !== 'profile.frame@1') {
    return rejected('baseline strategy must be profile.frame@1');
  }
  if (typeof payload['workload'] !== 'string' || payload['workload'].length === 0) {
    return rejected('baseline requires a workload');
  }
  const quality = payload['quality'];
  if (!isRecord(quality) || !isNonNegativeInteger(quality['held']) || !isNonNegativeInteger(quality['missed'])) {
    return rejected('baseline quality requires held and missed counts');
  }
  if ((quality['missed'] as number) < 1 || (quality['held'] as number) < 1) {
    return rejected('baseline requires a failing case and a success');
  }
  if (
    !isNonNegativeInteger(payload['inference_requests']) ||
    !isNonNegativeInteger(payload['latency_ticks']) ||
    !isNonNegativeInteger(payload['cost_micros']) ||
    !isNonNegativeInteger(payload['human_corrections'])
  ) {
    return rejected('baseline requires inference count, tick latency, cost, and human corrections');
  }
  return ACCEPTED;
}
