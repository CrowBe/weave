/**
 * Failure codes are contract; messages are not. Callers branch on codes.
 *
 * Precedence protects existence: well-formedness, then authority, then
 * existence and kind. An unauthorized caller sees DENIED for an issued handle
 * and an unknown handle alike.
 */
export const FAILURE_CODES = [
  'INVALID_REF',
  'INVALID_INPUT',
  'DENIED',
  'UNKNOWN_RESOURCE',
  'KIND_MISMATCH',
  'UNKNOWN_CAPABILITY',
  'UNRESOLVED',
  'RESOLVER_UNAVAILABLE',
  'DEPENDENCY_BLOCKED',
  'DEPENDENCY_FAILED',
  'UNDECLARED_DEPENDENCY',
  'RESOLVER_ERROR',
  'INVALID_CATALOGUE',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Lower index is checked first. */
export const FAILURE_PRECEDENCE: readonly FailureCode[] = [
  'INVALID_REF',
  'INVALID_INPUT',
  'DENIED',
  'UNKNOWN_RESOURCE',
  'KIND_MISMATCH',
  'UNKNOWN_CAPABILITY',
  'UNRESOLVED',
  'RESOLVER_UNAVAILABLE',
  'DEPENDENCY_BLOCKED',
  'DEPENDENCY_FAILED',
  'UNDECLARED_DEPENDENCY',
  'RESOLVER_ERROR',
  'INVALID_CATALOGUE',
];

export function failurePrecedes(a: FailureCode, b: FailureCode): boolean {
  return FAILURE_PRECEDENCE.indexOf(a) < FAILURE_PRECEDENCE.indexOf(b);
}
