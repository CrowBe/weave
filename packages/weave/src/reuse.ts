/**
 * Cached-conclusion reuse (docs/m4-measure-reuse.md §2).
 *
 * Output length is not an input. A short output is reused only when the
 * input digest, read set, contract revision, admission, and authority scope
 * all still hold. Registry presence is not an input.
 */
import { digest } from './digest.js';
import type { AuthorityScope, CachedConclusion, PolicyRecord, ReadSetEntry, ResourceReadSetEntry } from './types.js';

/** Fixture cost of one host invocation, counted once. A reuse does not add another. */
export const HOST_INVOCATION_MICROS = 100;

export interface ReuseCandidate {
  readonly operation: string;
  readonly contract_rev: string | null;
  readonly inputs: unknown;
  readonly read_set: readonly ReadSetEntry[];
}

export interface ReuseState {
  readonly sources: Readonly<Record<string, { readonly revision: number } | undefined>>;
  readonly goal_id: string | null;
}

export type ReuseVerdict =
  | { readonly kind: 'reuse'; readonly conclusion: CachedConclusion }
  | { readonly kind: 'uncertain'; readonly reason: string }
  | { readonly kind: 'rerun' };

export function reuseVerdict(
  conclusions: readonly CachedConclusion[],
  candidate: ReuseCandidate,
  state: ReuseState,
  policies: readonly PolicyRecord[],
  admitted: (operation: string, implementationId: string) => boolean,
): ReuseVerdict {
  if (candidate.contract_rev === null) {
    return { kind: 'rerun' };
  }
  const input_digest = digest(candidate.inputs);
  const matches = conclusions.filter(
    (conclusion) =>
      conclusion.operation === candidate.operation &&
      conclusion.contract_rev === candidate.contract_rev &&
      conclusion.input_digest === input_digest &&
      admitted(conclusion.operation, conclusion.implementation_id) &&
      callerInScope(conclusion.authority_scope, state.goal_id, policies),
  );
  if (matches.length === 0) {
    return { kind: 'rerun' };
  }
  let unchecked = false;
  for (const conclusion of [...matches].reverse()) {
    const freshness = readSetFreshness(conclusion, candidate, state);
    if (freshness === 'current') {
      return { kind: 'reuse', conclusion };
    }
    if (freshness === 'unchecked') {
      unchecked = true;
    }
  }
  if (unchecked) {
    return { kind: 'uncertain', reason: 'read set revision cannot be checked' };
  }
  return { kind: 'rerun' };
}

function callerInScope(
  scope: AuthorityScope,
  goal_id: string | null,
  policies: readonly PolicyRecord[],
): boolean {
  if (!goal_id) {
    return false;
  }
  if ('goal_id' in scope) {
    if (scope.goal_id === goal_id) {
      return true;
    }
    return policies.some((policy) => policy.goals.includes(scope.goal_id) && policy.goals.includes(goal_id));
  }
  const policy = policies.find((item) => item.policy_id === scope.policy_id);
  return !!policy && policy.goals.includes(goal_id);
}

function readSetFreshness(
  conclusion: CachedConclusion,
  candidate: ReuseCandidate,
  state: ReuseState,
): 'current' | 'stale' | 'unchecked' {
  const recorded = resourceReads(conclusion.read_set);
  const requested = resourceReads(candidate.read_set);
  if (!sameReads(recorded, requested)) {
    return 'stale';
  }
  for (const entry of recorded) {
    const source = state.sources[entry.resource];
    if (!source) {
      return 'unchecked';
    }
    if (source.revision !== entry.revision) {
      return 'stale';
    }
  }
  return 'current';
}

function resourceReads(read_set: readonly ReadSetEntry[]): ResourceReadSetEntry[] {
  return read_set.filter((entry): entry is ResourceReadSetEntry => 'resource' in entry);
}

function sameReads(left: readonly ResourceReadSetEntry[], right: readonly ResourceReadSetEntry[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    return !!other && other.resource === entry.resource && other.revision === entry.revision;
  });
}
