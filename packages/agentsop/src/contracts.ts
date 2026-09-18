import { isWellFormedRef, type EffectSelector, type ResourceEffect } from './refs.js';
import type { FailureCode } from './failures.js';

/**
 * The capability document. The contract is durable; implementations are
 * disposable. It is named for the operation, never for an implementation.
 * Input and output are closed field -> type-name maps; unexpected keys are
 * rejected at the host, not here.
 */
export interface CapabilityContract {
  readonly id: string;
  readonly revision: string;
  readonly purpose: string;
  readonly input: Readonly<Record<string, string>>;
  readonly output: Readonly<Record<string, string>>;
  readonly effects: readonly EffectSelector[];
  readonly permissions: readonly EffectSelector[];
  readonly failures: readonly string[];
  /** Allow-list of capability ids this implementation may invoke. Empty is none. */
  readonly depends_on: readonly string[];
}

export type BindResult =
  | { readonly ok: true; readonly bound: ResourceEffect[] }
  | { readonly ok: false; readonly code: FailureCode; readonly reason: string };

/**
 * Bind a contract's selectors against concrete inputs. A selector whose input
 * field is a string names one reference; an array names several. Fails closed:
 * missing or mistyped fields are INVALID_INPUT; present but malformed refs are
 * INVALID_REF. Existence is not checked here.
 */
export function bindSelectors(selectors: readonly EffectSelector[], inputs: unknown): BindResult {
  if (typeof inputs !== 'object' || inputs === null) {
    return { ok: false, code: 'INVALID_INPUT', reason: 'inputs must be a record' };
  }
  const record = inputs as Record<string, unknown>;
  const bound: ResourceEffect[] = [];
  for (const selector of selectors) {
    const value = record[selector.input];
    if (typeof value === 'string') {
      if (!isWellFormedRef(value)) {
        return { ok: false, code: 'INVALID_REF', reason: `input '${selector.input}' is not a well-formed resource reference` };
      }
      bound.push({ resource: value, mode: selector.mode });
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          reason: `input '${selector.input}' must carry at least one resource reference`,
        };
      }
      for (const item of value) {
        if (typeof item !== 'string') {
          return {
            ok: false,
            code: 'INVALID_INPUT',
            reason: `input '${selector.input}' must carry resource references`,
          };
        }
        if (!isWellFormedRef(item)) {
          return { ok: false, code: 'INVALID_REF', reason: `input '${selector.input}' contains a malformed resource reference` };
        }
        bound.push({ resource: item, mode: selector.mode });
      }
      continue;
    }
    return {
      ok: false,
      code: 'INVALID_INPUT',
      reason: `input '${selector.input}' must carry a resource reference`,
    };
  }
  return { ok: true, bound };
}
