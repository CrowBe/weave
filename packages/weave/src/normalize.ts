/**
 * Candidate formation for a recorded `text.normalize` composition.
 *
 * The procedure id stays whatever the goal already selected. This module does
 * not add an arm to the procedure union.
 */
import { bindSelectors, type CapabilityContract, type ResourceEffect } from '@weave/agentsop';
import { candidateId } from './digest.js';
import { collapseWhitespace } from './normalize-author.js';
import type { ActionId, Candidate, ResourceId, State } from './types.js';

type Describe = (operation: string) => CapabilityContract | null;
type Canonical = (ref: string) => string;

const ONE_ACTION = { actions: 1, judgments: 0 } as const;

export interface NormalizeFormation {
  readonly kind: 'ready' | 'pending';
  readonly candidates: readonly Candidate[];
  readonly unavailable: readonly string[];
}

export function formNormalizeCandidates(state: State, describe: Describe, canonical: Canonical): NormalizeFormation {
  const goal = state.goal;
  const composition = goal?.composition;
  if (!goal || !composition) {
    return { kind: 'ready', candidates: [], unavailable: [] };
  }
  const crystal = state.crystallization;
  if (crystal.revoked) {
    return { kind: 'pending', candidates: [], unavailable: [] };
  }
  const admitted = describe('text.normalize');
  if (!admitted && crystal.admission?.status !== 'admitted' && crystal.search?.status !== 'reusable') {
    return { kind: 'pending', candidates: gapCandidates(state), unavailable: [] };
  }
  if (crystal.search?.status === 'composed') {
    return { kind: 'pending', candidates: [], unavailable: [] };
  }
  const contract = admitted ?? describe('text.normalize');
  if (!contract) {
    return { kind: 'pending', candidates: [], unavailable: ['text.normalize'] };
  }
  const candidates: Candidate[] = [];
  for (const source of goal.sources) {
    const current = state.sources[source];
    const normalized = state.normalized[source];
    if (!current || (normalized && normalized.revision === current.revision)) {
      continue;
    }
    const text = current.content;
    const inputs = { text };
    const id = candidateId(contract.id, contract.revision, { source, text });
    const failed = Object.values(state.actions).some((action) => action.candidate_id === id && action.state === 'failed');
    if (failed) {
      continue;
    }
    const bound = bindSelectors(contract.effects, inputs);
    const effects: ResourceEffect[] = bound.ok
      ? bound.bound.map((effect) => ({ resource: canonical(effect.resource), mode: effect.mode }))
      : [];
    const inspect = succeededInspect(state, source);
    candidates.push({
      candidate_id: id,
      operation: contract.id,
      contract_rev: contract.revision,
      inputs,
      evidence: [goal.evidence, current.evidence],
      read_set: [{ resource: source, revision: current.revision }],
      dependencies: inspect ? [inspect] : [],
      effects,
      resources: ONE_ACTION,
      eligibility: goal.authority.read.includes(source)
        ? { status: 'allowed' }
        : { status: 'prohibited', reason: `no read authority for ${source}` },
      weight: null,
    });
  }
  if (candidates.length > 0) {
    return { kind: 'pending', candidates, unavailable: [] };
  }
  const blocked = goal.sources.some((source) => {
    const current = state.sources[source];
    const normalized = state.normalized[source];
    if (!current || (normalized && normalized.revision === current.revision)) {
      return false;
    }
    const id = candidateId(contract.id, contract.revision, { source, text: current.content });
    return Object.values(state.actions).some((action) => action.candidate_id === id && action.state === 'failed');
  });
  if (blocked) {
    return { kind: 'pending', candidates: [], unavailable: [] };
  }
  return { kind: 'ready', candidates: [], unavailable: [] };
}

export function normalizedReportReady(state: State): boolean {
  const goal = state.goal;
  if (!goal?.composition) {
    return true;
  }
  return goal.sources.every((source) => {
    const current = state.sources[source];
    const normalized = state.normalized[source];
    return (
      current &&
      normalized &&
      normalized.revision === current.revision &&
      normalized.text === collapseWhitespace(current.content) &&
      collapseWhitespace(current.content).length > 0
    );
  });
}

function gapCandidates(state: State): Candidate[] {
  const goal = state.goal;
  const composition = goal?.composition;
  if (!goal || !composition) {
    return [];
  }
  const crystal = state.crystallization;
  const evidence = [goal.evidence];
  if (!crystal.search) {
    return [runtimeCandidate('gap.search', { operation: composition.operation, match: 'exact' }, evidence)];
  }
  if (crystal.search.status !== 'gap') {
    return [];
  }
  if (!crystal.contract) {
    return [runtimeCandidate('contract.establish', { operation: composition.operation }, evidence)];
  }
  if (!crystal.corpus_validated) {
    const candidates: Candidate[] = [];
    if (crystal.visible_ids.length === 0) {
      candidates.push(runtimeCandidate('corpus.propose', { split: 'visible' }, evidence));
    }
    if (crystal.held_out_ids.length === 0) {
      candidates.push(runtimeCandidate('corpus.propose', { split: 'held_out' }, evidence));
    }
    if (crystal.visible_ids.length > 0 && crystal.held_out_ids.length > 0) {
      const dependencies = [succeeded(state, 'corpus.propose', 'visible'), succeeded(state, 'corpus.propose', 'held_out')].filter(
        (id): id is ActionId => id !== null,
      );
      candidates.push(
        runtimeCandidate('corpus.validate', { contract_revision: crystal.contract.revision }, evidence, dependencies),
      );
    }
    return candidates;
  }
  if (!crystal.red?.demonstrated) {
    const validate = succeeded(state, 'corpus.validate');
    return [
      runtimeCandidate(
        'red.demonstrate',
        { contract_revision: crystal.contract.revision, corpus_revision: crystal.corpus_revision },
        evidence,
        validate ? [validate] : [],
      ),
    ];
  }
  const variants = composition.variants ?? ['direct', 'aliased'];
  const candidates: Candidate[] = [];
  for (const variant of variants) {
    const existing = crystal.implementations.find((item) => item.id === variant);
    if (!existing) {
      if (!crystal.held_out_spent) {
        const red = succeeded(state, 'red.demonstrate');
        candidates.push(
          runtimeCandidate(
            'implementation.generate',
            { variant, contract_revision: crystal.contract.revision, corpus_revision: crystal.corpus_revision },
            evidence,
            red ? [red] : [],
          ),
        );
      }
      continue;
    }
    if (!crystal.green.some((item) => item.id === variant)) {
      const generated = succeeded(state, 'implementation.generate', variant);
      candidates.push(
        runtimeCandidate(
          'green.prove',
          { implementation_id: variant, source_digest: existing.source_digest },
          evidence,
          generated ? [generated] : [],
        ),
      );
    }
  }
  const proven = crystal.green.find((item) => item.proven && item.id === 'direct') ?? crystal.green.find((item) => item.proven);
  if (proven && !crystal.admission) {
    const green = succeeded(state, 'green.prove', proven.id);
    candidates.push(
      runtimeCandidate(
        'admission.request',
        { implementation_id: proven.id, evidence_digest: proven.evidence_digest },
        evidence,
        green ? [green] : [],
      ),
    );
  }
  return candidates;
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

function succeededInspect(state: State, source: ResourceId): ActionId | null {
  for (const action of Object.values(state.actions)) {
    if (action.state === 'succeeded' && action.operation === 'source.inspect' && (action.inputs as { source?: string }).source === source) {
      return action.action_id;
    }
  }
  return null;
}
