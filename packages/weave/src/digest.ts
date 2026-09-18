import { createHash } from 'node:crypto';
import { stableStringify } from './stable-json.js';
import type { CandidateId } from './types.js';

export function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** A candidate's identity is a deterministic function of (operation, contract_rev, inputs). */
export function candidateId(operation: string, contract_rev: string | null, inputs: unknown): CandidateId {
  return `${operation}#${digest({ operation, contract_rev, inputs }).slice(0, 12)}`;
}

/** The set of candidates a judgment site was asked about, independent of order. */
export function candidateSetDigest(candidate_ids: readonly CandidateId[]): string {
  return digest([...candidate_ids].sort());
}
