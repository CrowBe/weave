/** Pure disclosure policy and conservative credential redaction at provider dispatch. */
import type { DataDestination, RouteTable } from './types.js';

/** A destination's training permission cannot be bypassed through an unmarked unit. */
export function trainingAllowedDestinations(table: RouteTable): ReadonlySet<DataDestination> {
  return new Set(table.filter(unit => unit.destination_training_allowed === true).map(unit => unit.destination));
}

// The same credential families as implement-step.ts CREDENTIAL, without a word
// boundary that would weaken its screening. Keep this package independent of Loom.
const CREDENTIAL = /sk[-_]|Bearer |eyJ|gh[pousr]_|github_pat_|AKIA/i;

/**
 * Redact the whole string when a credential marker occurs. Credentials have
 * no uniform terminator; keeping suffixes would risk disclosing part of one.
 * This is a final safeguard after the caller classifies content, not a claim
 * that arbitrary secrets can be detected or sensitive work made public.
 */
export function redactCredentialText(value: string): string {
  return CREDENTIAL.test(value) ? '[REDACTED]' : value;
}

/** JSON content is copied, including its keys; caller-owned state is never mutated. */
export function redactCredentialContent<T>(value: T): T {
  if (typeof value === 'string') return redactCredentialText(value) as T;
  if (Array.isArray(value)) return value.map(item => redactCredentialContent(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [redactCredentialText(key), redactCredentialContent(item)])) as T;
  }
  return value;
}
