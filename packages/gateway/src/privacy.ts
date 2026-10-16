/** Pure disclosure policy and conservative credential screening at provider dispatch. */
import type { DataDestination, RouteTable } from './types.js';

/** A destination's training permission cannot be bypassed through an unmarked unit. */
export function trainingAllowedDestinations(table: RouteTable): ReadonlySet<DataDestination> {
  return new Set(table.filter(unit => unit.destination_training_allowed === true).map(unit => unit.destination));
}

// Match token starts, as in the repository's trace and audit screens. Keep
// every credential family and keep this package independent of Loom.
const CREDENTIAL = /(?<![A-Za-z0-9])(?:sk[-_]|Bearer |eyJ|gh[pousr]_|github_pat_|AKIA)/i;

/**
 * Screen all JSON content, including keys, without changing caller-owned state.
 * A match prevents disclosure to a training-allowed destination; replacing it
 * would silently change the work. This safeguard does not claim to detect
 * arbitrary secrets or make sensitive work public.
 */
export function containsCredentialContent(value: unknown): boolean {
  if (typeof value === 'string') return CREDENTIAL.test(value);
  if (Array.isArray(value)) return value.some(item => containsCredentialContent(item));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) =>
      CREDENTIAL.test(key) || containsCredentialContent(item));
  }
  return false;
}
