/**
 * Candidate formation (§7 step 1) using the single established procedure
 * `inspect_and_report@1`, followed by eligibility (§7 step 2). Formation is a
 * pure function of state and the host's contract catalogue; it grants nothing.
 */
import { bindSelectors, type CapabilityContract, type ResourceEffect } from '@weave/agentsop';
import { candidateId } from './digest.js';
import { readSetMatches } from './state.js';
import type { ActionId, Candidate, Eligibility, InspectionResult, ResourceId, ResourceReadSetEntry, State } from './types.js';

export const PROCEDURE = 'inspect_and_report@1' as const;

export type Describe = (operation: string) => CapabilityContract | null;

export interface Formation {
  readonly candidates: readonly Candidate[];
  /** Operations the procedure needs that the host does not describe. */
  readonly unavailable: readonly string[];
}

const ONE_ACTION = { actions: 1, judgments: 0 } as const;

export function formCandidates(state: State, describe: Describe): Formation {
  const goal = state.goal;
  if (!goal || goal.status !== 'active') {
    return { candidates: [], unavailable: [] };
  }
  const inFlight = new Set(
    Object.values(state.actions)
      .filter((a) => a.state === 'pending' || a.state === 'running')
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
    const effects: ResourceEffect[] = bound.ok ? bound.bound : [];
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
    return { candidates, unavailable };
  }

  const readSet: ResourceReadSetEntry[] = goal.sources.map((source) => ({
    resource: source,
    revision: (state.sources[source] as { revision: number }).revision,
  }));
  const report = state.report;
  if (!report || !readSetMatches(report.report.read_set, state) || !coversSources(report.report, goal.sources)) {
    const contract = describe('report.assemble');
    if (!contract) {
      return { candidates, unavailable: [...unavailable, 'report.assemble'] };
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
    return { candidates, unavailable };
  }

  const producer = actionFinishedAt(state, report.evidence[report.evidence.length - 1] as number);
  const inputs = { goal_id: goal.goal_id };
  push({
    candidate_id: candidateId('goal.complete', null, inputs),
    operation: 'goal.complete',
    contract_rev: null,
    inputs,
    evidence: [...report.evidence],
    read_set: readSet,
    dependencies: producer ? [producer] : [],
    effects: [],
    resources: ONE_ACTION,
    eligibility: { status: 'allowed' },
    weight: null,
  });
  return { candidates, unavailable };
}

function inspectEligibility(source: ResourceId, read: readonly ResourceId[]): Eligibility {
  return read.includes(source) ? { status: 'allowed' } : { status: 'prohibited', reason: `no read authority for ${source}` };
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

/** Success evidence for `goal.complete` (§2): a report covering every goal source at its current revision. */
export function successEvidencePresent(state: State): boolean {
  const goal = state.goal;
  const report = state.report;
  if (!goal || !report) {
    return false;
  }
  return coversSources(report.report, goal.sources) && readSetMatches(report.report.read_set, state);
}
