/**
 * Candidate formation for `crystallize_and_report@1`.
 *
 * Inspects stay concurrent with the gap search. Corpus splits and
 * implementation proposals are independent of each other. Later gates stay
 * sequential: no implementation is formed before demonstrated red, and the
 * fold is not formed before admission.
 */
import { bindSelectors, type CapabilityContract, type ResourceEffect } from '@weave/agentsop';
import type { Canonical, Describe, Formation } from './candidates.js';
import { candidateId } from './digest.js';
import type {
  ActionId,
  Candidate,
  InspectionResult,
  ResourceId,
  ResourceReadSetEntry,
  State,
} from './types.js';

const ONE_ACTION = { actions: 1, judgments: 0 } as const;
const DEFAULT_VARIANTS = ['direct', 'aliased'] as const;

export function formCrystallizeCandidates(state: State, describe: Describe, canonical: Canonical): Formation {
  const goal = state.goal;
  const procedure = 'crystallize_and_report@1' as const;
  if (!goal || goal.status !== 'active' || !goal.gap) {
    return { candidates: [], unavailable: [], procedure };
  }
  const inFlight = new Set(
    Object.values(state.actions)
      .filter((action) => action.state === 'pending' || action.state === 'running' || (action.state === 'uncertain' && !action.reconciled))
      .map((action) => action.candidate_id),
  );
  const candidates: Candidate[] = [];
  const unavailable: string[] = [];
  const push = (candidate: Candidate): void => {
    if (!inFlight.has(candidate.candidate_id)) {
      candidates.push(candidate);
    }
  };

  pushInspects(state, describe, canonical, push, unavailable);
  const crystal = state.crystallization;
  if (crystal.revoked) {
    return { candidates, unavailable, procedure };
  }
  if (!crystal.search) {
    push(runtimeCandidate('gap.search', { operation: goal.gap.operation }, [goal.evidence]));
    return { candidates, unavailable, procedure };
  }
  if (crystal.search.status === 'reusable' || crystal.admission?.status === 'admitted') {
    pushReportTail(state, describe, canonical, push, unavailable);
    return { candidates, unavailable, procedure };
  }
  if (crystal.search.status !== 'gap') {
    return { candidates, unavailable, procedure };
  }
  if (!crystal.contract) {
    push(runtimeCandidate('contract.establish', { operation: goal.gap.operation }, [goal.evidence]));
    return { candidates, unavailable, procedure };
  }
  if (!crystal.corpus_validated) {
    if (crystal.visible_ids.length === 0) {
      push(runtimeCandidate('corpus.propose', { split: 'visible' }, [goal.evidence]));
    }
    if (crystal.held_out_ids.length === 0) {
      push(runtimeCandidate('corpus.propose', { split: 'held_out' }, [goal.evidence]));
    }
    if (crystal.visible_ids.length > 0 && crystal.held_out_ids.length > 0) {
      const dependencies = [
        succeeded(state, 'corpus.propose', 'visible'),
        succeeded(state, 'corpus.propose', 'held_out'),
      ].filter((id): id is ActionId => id !== null);
      push(
        runtimeCandidate(
          'corpus.validate',
          { contract_revision: crystal.contract.revision },
          [goal.evidence],
          dependencies,
        ),
      );
    }
    return { candidates, unavailable, procedure };
  }
  if (!crystal.red?.demonstrated) {
    const validate = succeeded(state, 'corpus.validate');
    push(
      runtimeCandidate(
        'red.demonstrate',
        { contract_revision: crystal.contract.revision, corpus_revision: crystal.corpus_revision },
        [goal.evidence],
        validate ? [validate] : [],
      ),
    );
    return { candidates, unavailable, procedure };
  }
  const variants = goal.gap.variants ?? DEFAULT_VARIANTS;
  for (const variant of variants) {
    const existing = crystal.implementations.find((item) => item.id === variant);
    if (!existing) {
      if (!crystal.held_out_spent) {
        const red = succeeded(state, 'red.demonstrate');
        push(
          runtimeCandidate(
            'implementation.generate',
            { variant, contract_revision: crystal.contract.revision, corpus_revision: crystal.corpus_revision },
            [goal.evidence],
            red ? [red] : [],
          ),
        );
      }
      continue;
    }
    if (!crystal.green.some((item) => item.id === variant)) {
      const generated = succeeded(state, 'implementation.generate', variant);
      push(
        runtimeCandidate(
          'green.prove',
          { implementation_id: variant, source_digest: existing.source_digest },
          [goal.evidence],
          generated ? [generated] : [],
        ),
      );
    }
  }
  const proven = crystal.green.find((item) => item.proven && item.id === 'direct') ?? crystal.green.find((item) => item.proven);
  if (proven && !crystal.admission) {
    const green = succeeded(state, 'green.prove', proven.id);
    push(
      runtimeCandidate(
        'admission.request',
        { implementation_id: proven.id, evidence_digest: proven.evidence_digest },
        [goal.evidence],
        green ? [green] : [],
      ),
    );
  }
  return { candidates, unavailable, procedure };
}

function pushReportTail(
  state: State,
  describe: Describe,
  canonical: Canonical,
  push: (candidate: Candidate) => void,
  unavailable: string[],
): void {
  const goal = state.goal;
  if (!goal) {
    return;
  }
  const inspectionsReady = goal.sources.every((source) => {
    const current = state.sources[source];
    const inspection = state.inspections[source];
    return current && inspection && inspection.result.revision === current.revision;
  });
  if (!inspectionsReady) {
    return;
  }
  const readSet: ResourceReadSetEntry[] = goal.sources.map((source) => ({
    resource: source,
    revision: (state.sources[source] as { revision: number }).revision,
  }));
  if (!state.crystallization.fold) {
    const contract = describe('report.fold');
    if (!contract) {
      unavailable.push('report.fold');
      return;
    }
    const inspections = goal.sources.map((source) => (state.inspections[source] as { result: InspectionResult }).result);
    const inputs = { inspections };
    const dependencies = goal.sources
      .map((source) => succeededInspect(state, source))
      .filter((id): id is ActionId => id !== null);
    push({
      candidate_id: candidateId(contract.id, contract.revision, inputs),
      operation: contract.id,
      contract_rev: contract.revision,
      inputs,
      evidence: [goal.evidence],
      read_set: readSet,
      dependencies,
      effects: [],
      resources: ONE_ACTION,
      eligibility: { status: 'allowed' },
      weight: null,
    });
    return;
  }
  const report = state.report;
  if (!report || !covers(report.report, goal.sources) || !readSet.every((entry) => state.sources[entry.resource]?.revision === entry.revision)) {
    const contract = describe('report.assemble');
    if (!contract) {
      unavailable.push('report.assemble');
      return;
    }
    const inspections = goal.sources.map((source) => (state.inspections[source] as { result: InspectionResult }).result);
    const inputs = { inspections };
    const foldAction = succeeded(state, 'report.fold');
    push({
      candidate_id: candidateId(contract.id, contract.revision, inputs),
      operation: contract.id,
      contract_rev: contract.revision,
      inputs,
      evidence: [goal.evidence],
      read_set: readSet,
      dependencies: foldAction ? [foldAction] : [],
      effects: [],
      resources: ONE_ACTION,
      eligibility: { status: 'allowed' },
      weight: null,
    });
    return;
  }
  if (!successReady(state)) {
    return;
  }
  const inputs = { goal_id: goal.goal_id };
  const assemble = succeeded(state, 'report.assemble');
  push({
    candidate_id: candidateId('goal.complete', null, inputs),
    operation: 'goal.complete',
    contract_rev: null,
    inputs,
    evidence: [goal.evidence],
    read_set: readSet,
    dependencies: assemble ? [assemble] : [],
    effects: [],
    resources: ONE_ACTION,
    eligibility: { status: 'allowed' },
    weight: null,
  });
}

function successReady(state: State): boolean {
  const goal = state.goal;
  const report = state.report;
  const fold = state.crystallization.fold;
  if (!goal || !report || !fold) {
    return false;
  }
  return goal.sources.every((source) => {
    const inspection = state.inspections[source];
    return (
      inspection &&
      fold.bound.some(
        (entry) => entry.source === source && entry.revision === inspection.result.revision && entry.digest === inspection.result.digest,
      )
    );
  });
}

function pushInspects(
  state: State,
  describe: Describe,
  canonical: Canonical,
  push: (candidate: Candidate) => void,
  unavailable: string[],
): void {
  const goal = state.goal;
  if (!goal) {
    return;
  }
  for (const source of goal.sources) {
    const current = state.sources[source];
    const inspection = state.inspections[source];
    if (!current || (inspection && inspection.result.revision === current.revision)) {
      continue;
    }
    const contract = describe('source.inspect');
    if (!contract) {
      unavailable.push('source.inspect');
      continue;
    }
    push(inspectCandidate(goal.evidence, current.evidence, source, current.revision, goal.authority.read, contract, canonical));
  }
}

function inspectCandidate(
  goalEvidence: number,
  sourceEvidence: number,
  source: ResourceId,
  revision: number,
  read: readonly ResourceId[],
  contract: CapabilityContract,
  canonical: Canonical,
): Candidate {
  const inputs = { source };
  const bound = bindSelectors(contract.effects, inputs);
  const effects: ResourceEffect[] = bound.ok ? bound.bound.map((effect) => ({ resource: canonical(effect.resource), mode: effect.mode })) : [];
  return {
    candidate_id: candidateId(contract.id, contract.revision, inputs),
    operation: contract.id,
    contract_rev: contract.revision,
    inputs,
    evidence: [goalEvidence, sourceEvidence],
    read_set: [{ resource: source, revision }],
    dependencies: [],
    effects,
    resources: ONE_ACTION,
    eligibility: read.includes(source) ? { status: 'allowed' } : { status: 'prohibited', reason: `no read authority for ${source}` },
    weight: null,
  };
}

function runtimeCandidate(
  operation: string,
  inputs: unknown,
  evidence: readonly number[],
  dependencies: readonly ActionId[] = [],
): Candidate {
  return {
    candidate_id: candidateId(operation, null, inputs),
    operation,
    contract_rev: null,
    inputs,
    evidence,
    read_set: [],
    dependencies,
    effects: [],
    resources: ONE_ACTION,
    eligibility: { status: 'allowed' },
    weight: null,
  };
}

function succeeded(state: State, operation: string, marker?: string): ActionId | null {
  for (const action of Object.values(state.actions)) {
    if (action.state !== 'succeeded' || action.operation !== operation) {
      continue;
    }
    if (marker === undefined) {
      return action.action_id;
    }
    const inputs = action.inputs as { split?: string; variant?: string; implementation_id?: string };
    if (inputs.split === marker || inputs.variant === marker || inputs.implementation_id === marker) {
      return action.action_id;
    }
  }
  return null;
}

function succeededInspect(state: State, source: string): ActionId | null {
  for (const action of Object.values(state.actions)) {
    if (action.state === 'succeeded' && action.operation === 'source.inspect' && (action.inputs as { source?: string }).source === source) {
      return action.action_id;
    }
  }
  return null;
}

function covers(report: { entries: readonly { source: string }[] }, sources: readonly string[]): boolean {
  const covered = new Set(report.entries.map((entry) => entry.source));
  return sources.every((source) => covered.has(source));
}
