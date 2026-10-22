/**
 * Process shell-out effects. A closed vocabulary beside resource modes.
 * Adding a name is a revision. Tokens are matched exactly; wildcards do not exist.
 *
 * `process.spawn` allows one direct spawn (no shell). `fs.write` is scoped to
 * the resource reference carried by a named input: the token is `fs.write:<ref>`.
 */
import type { FailureCode } from './failures.js';
import { isWellFormedRef } from './refs.js';

export const PROCESS_EFFECT_VOCABULARY_REVISION = 1;

export const PROCESS_EFFECTS = ['process.spawn', 'fs.write'] as const;
export type ProcessEffectName = (typeof PROCESS_EFFECTS)[number];

export type ProcessEffectSelector =
  | { readonly name: 'process.spawn' }
  | { readonly name: 'fs.write'; readonly input: string };

export function processEffectToken(selector: ProcessEffectSelector, resource?: string): string {
  if (selector.name === 'process.spawn') {
    return 'process.spawn';
  }
  return `fs.write:${resource ?? ''}`;
}

export type ProcessBindResult =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly code: FailureCode; readonly reason: string };

/** Bind declared process effects against concrete inputs. Fails closed. */
export function bindProcessEffects(selectors: readonly ProcessEffectSelector[], inputs: unknown): ProcessBindResult {
  if (typeof inputs !== 'object' || inputs === null) {
    return { ok: false, code: 'INVALID_INPUT', reason: 'inputs must be a record' };
  }
  const record = inputs as Record<string, unknown>;
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    if (selector.name === 'process.spawn') {
      if (seen.has('process.spawn')) {
        return { ok: false, code: 'INVALID_INPUT', reason: 'duplicate process.spawn effect' };
      }
      seen.add('process.spawn');
      tokens.push('process.spawn');
      continue;
    }
    if (selector.name !== 'fs.write') {
      return { ok: false, code: 'INVALID_INPUT', reason: 'unknown process effect' };
    }
    const value = record[selector.input];
    if (typeof value !== 'string') {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        reason: `input '${selector.input}' must carry a resource reference`,
      };
    }
    if (!isWellFormedRef(value)) {
      return {
        ok: false,
        code: 'INVALID_REF',
        reason: `input '${selector.input}' is not a well-formed resource reference`,
      };
    }
    const token = `fs.write:${value}`;
    if (seen.has(token)) {
      return { ok: false, code: 'INVALID_INPUT', reason: 'duplicate fs.write effect' };
    }
    seen.add(token);
    tokens.push(token);
  }
  return { ok: true, tokens };
}

/**
 * Contract-document check. Selectors name fields, not concrete refs.
 * Returns a reason string, or null when the declaration is absent or valid.
 */
export function validateProcessEffectSelectors(
  id: string,
  input: Readonly<Record<string, string>>,
  selectors: readonly ProcessEffectSelector[] | undefined,
): string | null {
  if (selectors === undefined) {
    return null;
  }
  if (selectors.length === 0) {
    return `${id}: process_effects must be non-empty when declared`;
  }
  const seen = new Set<string>();
  for (const selector of selectors) {
    if (selector.name === 'process.spawn') {
      if ('input' in selector) {
        return `${id}: process.spawn takes no input`;
      }
      if (seen.has('process.spawn')) {
        return `${id}: duplicate process.spawn`;
      }
      seen.add('process.spawn');
      continue;
    }
    if (selector.name !== 'fs.write') {
      return `${id}: unknown process effect`;
    }
    if (typeof selector.input !== 'string' || selector.input.length === 0 || !Object.hasOwn(input, selector.input)) {
      return `${id}: fs.write input is not a contract field`;
    }
    const typeName = input[selector.input] ?? '';
    if (!typeName.includes('Ref')) {
      return `${id}: fs.write must bind a resource reference field`;
    }
    const key = `fs.write:${selector.input}`;
    if (seen.has(key)) {
      return `${id}: duplicate fs.write selector`;
    }
    seen.add(key);
  }
  return null;
}
