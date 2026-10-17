/**
 * Placeholder for G1 (#189). It accepts every value so the contract fixtures
 * demonstrate red. G2 (#190) replaces it with the validator GAUGE-CONTRACT.md
 * describes.
 */
export type Rejection =
  | 'envelope'
  | 'ref'
  | 'binding'
  | 'governance'
  | 'holdout'
  | 'mode'
  | 'measure'
  | 'constraint'
  | 'verdict'
  | 'attribution';

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: Rejection };

/** Known criteria sets, case sets and results, keyed by `criteria`, `caseset` and `result`. */
export interface Context {
  readonly criteria: Readonly<Record<string, unknown>>;
  readonly casesets: Readonly<Record<string, unknown>>;
  readonly results: Readonly<Record<string, unknown>>;
}

export function validate(_value: unknown, _context: Context): Verdict {
  return { ok: true };
}
