/**
 * Criterion proof admission (#199).
 *
 * Decomposition proposes how a success criterion is proven. Code admits `check`
 * only when every bound check takes its verdict from an oracle that the check's
 * grant may read and that the implementation step's generation cannot write,
 * compared by the host's canonical resource identity. Anything else stays
 * `judgment` and keeps D5. Admission performs no IO or inference and grants
 * nothing.
 *
 * Assumptions the repository cannot verify:
 * - The host-configured argv takes its verdict from the declared oracle. That is
 *   operator configuration, like the argv itself.
 * - Canonical identity is atomic, as it is for effect locks. Nested resources
 *   would need containment before this rule could admit them.
 */
import { isWellFormedRef, type ResourceEffect, type ResourceRef } from '@weave/agentsop';

export const CRITERION_PROOFS = ['check', 'judgment'] as const;
export type CriterionProof = (typeof CRITERION_PROOFS)[number];
export const PROOF_DOWNGRADES = ['unbound_check', 'write_scope_unknown', 'no_oracle', 'oracle_not_granted', 'oracle_writable'] as const;
export type ProofDowngrade = (typeof PROOF_DOWNGRADES)[number];

export function isCriterionProof(value: unknown): value is CriterionProof {
  return value === 'check' || value === 'judgment';
}

export interface ProofCriterion {
  readonly criterion_id: string;
  /** Proposed by decomposition. Absent means `judgment`. */
  readonly proof?: CriterionProof;
  readonly check_ids?: readonly string[];
}
export interface ProofCheck {
  readonly check_id: string;
  /** Resources the verdict comes from (held-out tests, fixtures), not the subject under test. */
  readonly oracle_refs?: readonly ResourceRef[];
  /** The check's held grant permissions. Null means the check is denied. */
  readonly permissions: readonly ResourceEffect[] | null;
}
export interface ProofScope {
  /** Resources the step's generate backend may write. Undefined is unknown. */
  readonly generation_writes: readonly ResourceRef[] | undefined;
  /** Host canonical identity: aliases share one id. Undefined is unknown. */
  readonly canonical: ((ref: ResourceRef) => string) | undefined;
}
export interface ProofAdmission {
  readonly criterion_id: string;
  readonly proposed: CriterionProof;
  readonly proof: CriterionProof;
  readonly reason: ProofDowngrade | null;
}

export function admitCriterionProof(criterion: ProofCriterion, checks: readonly ProofCheck[], scope: ProofScope): ProofAdmission {
  const criterion_id = criterion.criterion_id;
  if (criterion.proof !== 'check') return { criterion_id, proposed: 'judgment', proof: 'judgment', reason: null };
  const downgrade = (reason: ProofDowngrade): ProofAdmission => ({ criterion_id, proposed: 'check', proof: 'judgment', reason });
  const ids = criterion.check_ids;
  if (!Array.isArray(ids) || ids.length === 0) return downgrade('unbound_check');
  const bound: ProofCheck[] = [];
  for (const id of ids) {
    const matches = checks.filter(check => check.check_id === id);
    if (matches.length === 0) return downgrade('unbound_check');
    bound.push(...matches);
  }
  const { generation_writes, canonical } = scope;
  if (!Array.isArray(generation_writes) || typeof canonical !== 'function') return downgrade('write_scope_unknown');
  let written: Set<string>;
  try {
    written = new Set(generation_writes.map(ref => canonical(ref)));
  } catch {
    return downgrade('write_scope_unknown');
  }
  for (const check of bound) {
    const oracle = check.oracle_refs;
    if (!Array.isArray(oracle) || oracle.length === 0 || !oracle.every(ref => isWellFormedRef(ref))) return downgrade('no_oracle');
    for (const ref of oracle) {
      let id: string;
      let readable: boolean;
      try {
        id = canonical(ref);
        readable = check.permissions !== null &&
          check.permissions.some(permission => permission.mode === 'read' && canonical(permission.resource) === id);
      } catch {
        return downgrade('write_scope_unknown');
      }
      if (!readable) return downgrade('oracle_not_granted');
      if (written.has(id)) return downgrade('oracle_writable');
    }
  }
  return { criterion_id, proposed: 'check', proof: 'check', reason: null };
}
