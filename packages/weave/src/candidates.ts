/**
 * Candidate formation (§7 step 1) using the established procedure, followed by
 * eligibility (§7 step 2). Formation is a pure function of state and the host's
 * contract catalogue; it grants nothing. M1 adds `inspect_report_publish@1`
 * when the goal names a destination.
 */
import { bindSelectors, type CapabilityContract, type ResourceEffect } from '@weave/agentsop';
import { candidateId, digest } from './digest.js';
import { readSetMatches } from './state.js';
import type {
  ActionId,
  ApprovalRecord,
  Candidate,
  Eligibility,
  InspectionResult,
  ProcedureId,
  Proposal,
  RecordedComposition,
  ResourceId,
  ResourceReadSetEntry,
  State,
} from './types.js';
import { formCrystallizeCandidates } from './crystallize.js';
import { proposalCoversSources } from './proposals.js';

export const PROCEDURE = 'inspect_and_report@1' as const;
export const PROCEDURE_PUBLISH = 'inspect_report_publish@1' as const;
export const PROCEDURE_FRAME = 'frame_and_report@1' as const;
export const PROCEDURE_CRYSTALLIZE = 'crystallize_and_report@1' as const;

/** The control-core procedure union. A recorded composition is not a member. */
export const PROCEDURE_IDS = [PROCEDURE, PROCEDURE_PUBLISH, PROCEDURE_FRAME, PROCEDURE_CRYSTALLIZE] as const satisfies readonly ProcedureId[];

const PROCEDURE_UNION: Record<ProcedureId, true> = {
  'inspect_and_report@1': true,
  'inspect_report_publish@1': true,
  'frame_and_report@1': true,
  'crystallize_and_report@1': true,
};
void PROCEDURE_UNION;

export type Describe = (operation: string) => CapabilityContract | null;
export type Canonical = (ref: string) => string;

export interface Formation {
  readonly candidates: readonly Candidate[];
  /** Operations the procedure needs that the host does not describe. */
  readonly unavailable: readonly string[];
  readonly procedure: ProcedureId;
}

const ONE_ACTION = { actions: 1, judgments: 0 } as const;

export function procedureFor(state: State): ProcedureId {
  if (state.goal?.gap) {
    return PROCEDURE_CRYSTALLIZE;
  }
  if (state.goal?.framing) {
    return PROCEDURE_FRAME;
  }
  return state.goal?.destination ? PROCEDURE_PUBLISH : PROCEDURE;
}

export function formCandidates(state: State, describe: Describe, canonical: Canonical = (ref) => ref): Formation {
  const goal = state.goal;
  const procedure = procedureFor(state);
  if (!goal || goal.status !== 'active') {
    return { candidates: [], unavailable: [], procedure };
  }
  if (procedure === PROCEDURE_CRYSTALLIZE) {
    return formCrystallizeCandidates(state, describe, canonical);
  }
  const inFlight = new Set(
    Object.values(state.actions)
      .filter((a) => a.state === 'pending' || a.state === 'running' || (a.state === 'uncertain' && !a.reconciled))
      .map((a) => a.candidate_id),
  );
  const candidates: Candidate[] = [];
  const unavailable: string[] = [];
  const push = (candidate: Candidate): void => {
    if (!inFlight.has(candidate.candidate_id)) {
      candidates.push(candidate);
    }
  };

  let allInspected = true;
  if (procedure === PROCEDURE_FRAME) {
    const proposal = state.proposal?.proposal;
    if (!proposal || !proposalCoversSources(proposal, goal.sources)) {
      const inFlightFrame = Object.values(state.actions).some(
        (a) => a.operation === 'goal.frame' && (a.state === 'pending' || a.state === 'running'),
      );
      if (!inFlightFrame) {
        push(frameCandidate(goal.goal_id, goal.evidence));
      }
      return { candidates, unavailable, procedure };
    }
    formProposedInspects(state, proposal, describe, canonical, push, unavailable);
    if (unavailable.includes('source.inspect') || !goal.sources.every((s) => state.inspections[s] && state.inspections[s]!.result.revision === state.sources[s]?.revision)) {
      return { candidates, unavailable, procedure };
    }
    allInspected = true;
  } else {
  for (const source of goal.sources) {
    const current = state.sources[source];
    const inspection = state.inspections[source];
    if (current && inspection && inspection.result.revision === current.revision) {
      continue;
    }
    allInspected = false;
    if (!current) {
      continue; // an unregistered source has no revision to bind a read set to
    }
    const contract = describe('source.inspect');
    if (!contract) {
      unavailable.push('source.inspect');
      continue;
    }
    const inputs = { source };
    const bound = bindSelectors(contract.effects, inputs);
    const effects: ResourceEffect[] = bound.ok
      ? bound.bound.map((e) => ({ resource: canonical(e.resource), mode: e.mode }))
      : [];
    push({
      candidate_id: candidateId(contract.id, contract.revision, inputs),
      operation: contract.id,
      contract_rev: contract.revision,
      inputs,
      evidence: [goal.evidence, current.evidence],
      read_set: [{ resource: source, revision: current.revision }],
      dependencies: [],
      effects,
      resources: ONE_ACTION,
      eligibility: inspectEligibility(source, goal.authority.read),
      weight: null,
    });
  }
  if (!allInspected) {
    return { candidates, unavailable, procedure };
  }
  }

  const composition = activeComposition(state);
  if (goal.composition_id && !composition) {
    return { candidates, unavailable: [...unavailable, goal.composition_id], procedure };
  }
  if (composition && !formNormalizations(state, composition, describe, push, unavailable)) {
    return { candidates, unavailable, procedure };
  }

  const readSet: ResourceReadSetEntry[] = goal.sources.map((source) => ({
    resource: source,
    revision: (state.sources[source] as { revision: number }).revision,
  }));
  const report = state.report;
  if (!report || !readSetMatches(report.report.read_set, state) || !coversSources(report.report, goal.sources)) {
    const contract = describe('report.assemble');
    if (!contract) {
      return { candidates, unavailable: [...unavailable, 'report.assemble'], procedure };
    }
    const inspections: InspectionResult[] = [];
    const evidence: number[] = [];
    const dependencies: ActionId[] = [];
    for (const source of goal.sources) {
      const inspection = state.inspections[source] as { result: InspectionResult; evidence: number };
      inspections.push(inspection.result);
      evidence.push(inspection.evidence);
      const producer = actionFinishedAt(state, inspection.evidence);
      if (producer) {
        dependencies.push(producer);
      }
    }
    const inputs = { inspections };
    push({
      candidate_id: candidateId(contract.id, contract.revision, inputs),
      operation: contract.id,
      contract_rev: contract.revision,
      inputs,
      evidence,
      read_set: readSet,
      dependencies,
      effects: [],
      resources: ONE_ACTION,
      eligibility: { status: 'allowed' },
      weight: null,
    });
    return { candidates, unavailable, procedure };
  }

  if (goal.destination) {
    if (publicationSatisfies(state, report.report, goal.destination)) {
      push(completeCandidate(goal.goal_id, report.evidence, readSet, state));
      return { candidates, unavailable, procedure };
    }
    const contract = describe('report.publish');
    if (!contract) {
      return { candidates, unavailable: [...unavailable, 'report.publish'], procedure };
    }
    const destination = goal.destination;
    const destState = state.sources[destination];
    if (!destState) {
      return { candidates, unavailable, procedure };
    }
    const sources = [...goal.sources];
    const inputs = {
      report: report.report,
      read_set: readSet,
      sources,
      destination,
      expected_revision: destState.revision,
    };
    const bound = bindSelectors(contract.effects, inputs);
    const effects: ResourceEffect[] = bound.ok
      ? bound.bound.map((e) => ({ resource: canonical(e.resource), mode: e.mode }))
      : [];
    const producer = actionFinishedAt(state, report.evidence[report.evidence.length - 1] as number);
    push({
      candidate_id: candidateId(contract.id, contract.revision, inputs),
      operation: contract.id,
      contract_rev: contract.revision,
      inputs,
      evidence: [...report.evidence, destState.evidence],
      read_set: [...readSet, { resource: destination, revision: destState.revision }],
      dependencies: producer ? [producer] : [],
      effects,
      resources: ONE_ACTION,
      eligibility: publishEligibility(state, sources, destination, effects, inputs),
      weight: null,
    });
    return { candidates, unavailable, procedure };
  }

  push(completeCandidate(goal.goal_id, report.evidence, readSet, state));
  return { candidates, unavailable, procedure };
}

function activeComposition(state: State): RecordedComposition | null {
  const id = state.goal?.composition_id;
  if (!id || state.composition?.composition_id !== id) {
    return null;
  }
  return state.composition;
}

/** Form text.normalize candidates named by the composition. Returns false when any are still pending. */
function formNormalizations(
  state: State,
  composition: RecordedComposition,
  describe: Describe,
  push: (candidate: Candidate) => void,
  unavailable: string[],
): boolean {
  if (!composition.steps.some((step) => step.operation === 'text.normalize')) {
    return true;
  }
  const goal = state.goal;
  if (!goal) {
    return true;
  }
  const contract = describe('text.normalize');
  if (!contract) {
    unavailable.push('text.normalize');
    return false;
  }
  let pending = false;
  for (const source of goal.sources) {
    const current = state.sources[source];
    const inspection = state.inspections[source];
    if (!current || !inspection) {
      continue;
    }
    const normalization = state.normalizations[source];
    if (normalization && normalization.revision === current.revision) {
      continue;
    }
    pending = true;
    const inputs = { text: current.content };
    const producer = actionFinishedAt(state, inspection.evidence);
    push({
      candidate_id: candidateId(contract.id, contract.revision, inputs),
      operation: contract.id,
      contract_rev: contract.revision,
      inputs,
      evidence: [goal.evidence, current.evidence, composition.evidence, inspection.evidence],
      read_set: [{ resource: source, revision: current.revision }],
      dependencies: producer ? [producer] : [],
      effects: [],
      resources: ONE_ACTION,
      eligibility: inspectEligibility(source, goal.authority.read),
      weight: null,
    });
  }
  return !pending;
}

function frameCandidate(goal_id: string, evidence: number): Candidate {
  const inputs = { goal_id };
  return {
    candidate_id: candidateId('goal.frame', null, inputs),
    operation: 'goal.frame',
    contract_rev: null,
    inputs,
    evidence: [evidence],
    read_set: [],
    dependencies: [],
    effects: [],
    resources: ONE_ACTION,
    eligibility: { status: 'allowed' },
    weight: null,
  };
}

function formProposedInspects(
  state: State,
  proposal: Proposal,
  describe: Describe,
  canonical: Canonical,
  push: (candidate: Candidate) => void,
  unavailable: string[],
): void {
  const goal = state.goal;
  if (!goal) {
    return;
  }
  const contract = describe('source.inspect');
  if (!contract) {
    unavailable.push('source.inspect');
    return;
  }
  for (const binding of proposal.bindings) {
    if (binding.operation !== 'source.inspect') {
      continue;
    }
    const source = (binding.inputs as { source: string }).source;
    const current = state.sources[source];
    const inspection = state.inspections[source];
    if (!current) {
      continue;
    }
    if (inspection && inspection.result.revision === current.revision) {
      continue;
    }
    const inputs = { source };
    const bound = bindSelectors(contract.effects, inputs);
    const effects: ResourceEffect[] = bound.ok
      ? bound.bound.map((e) => ({ resource: canonical(e.resource), mode: e.mode }))
      : [];
    push({
      candidate_id: candidateId(contract.id, contract.revision, inputs),
      operation: contract.id,
      contract_rev: contract.revision,
      inputs,
      evidence: [goal.evidence, current.evidence, state.proposal!.evidence],
      read_set: [{ resource: source, revision: current.revision }],
      dependencies: [],
      effects,
      resources: ONE_ACTION,
      eligibility: inspectEligibility(source, goal.authority.read),
      weight: null,
    });
  }
}

function completeCandidate(
  goal_id: string,
  evidence: readonly number[],
  readSet: readonly ResourceReadSetEntry[],
  state: State,
): Candidate {
  const producer = actionFinishedAt(state, evidence[evidence.length - 1] as number);
  const inputs = { goal_id };
  return {
    candidate_id: candidateId('goal.complete', null, inputs),
    operation: 'goal.complete',
    contract_rev: null,
    inputs,
    evidence: [...evidence],
    read_set: readSet,
    dependencies: producer ? [producer] : [],
    effects: [],
    resources: ONE_ACTION,
    eligibility: { status: 'allowed' },
    weight: null,
  };
}

function inspectEligibility(source: ResourceId, read: readonly ResourceId[]): Eligibility {
  return read.includes(source) ? { status: 'allowed' } : { status: 'prohibited', reason: `no read authority for ${source}` };
}

function publishEligibility(
  state: State,
  sources: readonly ResourceId[],
  destination: ResourceId,
  effects: readonly ResourceEffect[],
  inputs: unknown,
): Eligibility {
  for (const source of sources) {
    if (!state.goal?.authority.read.includes(source)) {
      return { status: 'prohibited', reason: `no read authority for ${source}` };
    }
  }
  const standingWrite = state.goal?.authority.write?.includes(destination) ?? false;
  const binding = bindingDigest(inputs, effects);
  const approval = matchingApproval(state, binding, destination);
  if (standingWrite || (approval && approvalStillValid(approval, state))) {
    return { status: 'allowed' };
  }
  return { status: 'approval_required', policy: 'publication' };
}

export function bindingDigest(inputs: unknown, effects: readonly ResourceEffect[]): string {
  return digest({ inputs, effects });
}

export function matchingApproval(state: State, binding_digest: string, destination: ResourceId): ApprovalRecord | undefined {
  return Object.values(state.approvals).find(
    (record) => record.request.binding_digest === binding_digest && record.request.destination === destination,
  );
}

export function approvalStillValid(record: ApprovalRecord, state: State): boolean {
  if (record.status !== 'approved') {
    return false;
  }
  return state.clock.tick <= record.request.valid_until_tick;
}

function publicationSatisfies(
  state: State,
  report: { entries: readonly InspectionResult[]; read_set: readonly ResourceReadSetEntry[] },
  destination: ResourceId,
): boolean {
  const publication = state.publication;
  if (!publication) {
    return false;
  }
  return (
    publication.receipt.destination === destination &&
    publication.receipt.report_digest === digest(report) &&
    readSetMatches(report.read_set, state)
  );
}

function coversSources(report: { entries: readonly InspectionResult[] }, sources: readonly ResourceId[]): boolean {
  const covered = new Set(report.entries.map((e) => e.source));
  return sources.every((s) => covered.has(s));
}

function actionFinishedAt(state: State, seq: number): ActionId | null {
  for (const action of Object.values(state.actions)) {
    if (action.finished_at === seq) {
      return action.action_id;
    }
  }
  return null;
}

/** Success evidence for `goal.complete`. M1 additionally requires a matching publication receipt. */
export function successEvidencePresent(state: State): boolean {
  const goal = state.goal;
  const report = state.report;
  if (!goal || !report) {
    return false;
  }
  if (!coversSources(report.report, goal.sources) || !readSetMatches(report.report.read_set, state)) {
    return false;
  }
  if (goal.composition_id) {
    const composition = state.composition;
    if (!composition || composition.composition_id !== goal.composition_id) {
      return false;
    }
    if (composition.steps.some((step) => step.operation === 'text.normalize')) {
      const normalized = goal.sources.every((source) => {
        const normalization = state.normalizations[source];
        return normalization !== undefined && normalization.revision === state.sources[source]?.revision;
      });
      if (!normalized) {
        return false;
      }
    }
  }
  if (goal.gap) {
    const fold = state.crystallization.fold;
    if (!fold) {
      return false;
    }
    const bound = goal.sources.every((source) => {
      const inspection = state.inspections[source];
      return (
        inspection &&
        fold.bound.some(
          (entry) =>
            entry.source === source && entry.revision === inspection.result.revision && entry.digest === inspection.result.digest,
        )
      );
    });
    if (!bound) {
      return false;
    }
  }
  if (!goal.destination) {
    return true;
  }
  return publicationSatisfies(state, report.report, goal.destination);
}
