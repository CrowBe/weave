/**
 * Placeholder for W1 (#183). It accepts every value so the contract fixtures
 * demonstrate red. W2 (#184) replaces it with the validator WEFT-CONTRACT.md
 * describes.
 */
export type Rejection = 'envelope' | 'id' | 'sequence' | 'kind' | 'link' | 'evidence' | 'content' | 'field';

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: Rejection };

export function validateRecord(_value: unknown): Verdict {
  return { ok: true };
}
