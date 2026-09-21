/**
 * Test-case shape and contract revision rules (M3).
 *
 * A corpus is evidence derived from a contract. Visible cases and held-out
 * cases are the same shape; access to the held-out split is not decided here.
 */
import { isEffect, type Effect } from './effects.js';
import { selectorsEqual, type EffectSelector } from './refs.js';
import type { CapabilityContract, InferenceLimits } from './contracts.js';

export type TestSplit = 'visible' | 'held_out';

export type TestExpectation =
  | { readonly kind: 'output'; readonly output: unknown }
  | { readonly kind: 'failure'; readonly code: string };

export interface TestCase {
  readonly id: string;
  readonly split: TestSplit;
  readonly input: unknown;
  readonly expected: TestExpectation;
}

export type CorpusCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function validateTestCases(cases: readonly TestCase[], contract: CapabilityContract): CorpusCheck {
  const ids = new Set<string>();
  const byInput = new Map<string, string>();
  for (const testCase of cases) {
    if (testCase.split !== 'visible' && testCase.split !== 'held_out') {
      return fail(`case ${testCase.id || '(missing id)'} has an unknown split`);
    }
    if (!isNonEmpty(testCase.id)) {
      return fail('a test case requires an id');
    }
    if (ids.has(testCase.id)) {
      return fail(`duplicate test case id ${testCase.id}`);
    }
    ids.add(testCase.id);
    if (typeof testCase.input !== 'object' || testCase.input === null) {
      return fail(`case ${testCase.id} input must be a record`);
    }
    const expected = testCase.expected;
    if (!expected || (expected.kind !== 'output' && expected.kind !== 'failure')) {
      return fail(`case ${testCase.id} has no expectation`);
    }
    if (expected.kind === 'failure') {
      if (!isNonEmpty(expected.code)) {
        return fail(`case ${testCase.id} failure expectation requires a code`);
      }
      if (!contract.failures.includes(expected.code)) {
        return fail(`case ${testCase.id} failure ${expected.code} is not declared by the contract`);
      }
    }
    const marker = canonical(expected);
    const previous = byInput.get(canonical(testCase.input));
    if (previous !== undefined && previous !== marker) {
      return fail(`case ${testCase.id} contradicts another case with the same input`);
    }
    byInput.set(canonical(testCase.input), marker);
  }
  return { ok: true };
}

/**
 * Semantic contract changes require a new revision. An unchanged document may
 * keep its revision. The id is stable across revisions.
 */
export function checkRevision(previous: CapabilityContract | null, next: CapabilityContract): CorpusCheck {
  const document = validateContractDocument(next);
  if (!document.ok) {
    return document;
  }
  if (!previous) {
    return { ok: true };
  }
  if (previous.id !== next.id) {
    return fail('contract id is stable across revisions');
  }
  const changed = canonical(semanticBody(previous)) !== canonical(semanticBody(next));
  if (changed && previous.revision === next.revision) {
    return fail('a semantic contract change requires a new revision');
  }
  return { ok: true };
}

export function validateContractDocument(contract: CapabilityContract): CorpusCheck {
  if (!isNonEmpty(contract.id) || !isNonEmpty(contract.revision) || !isNonEmpty(contract.purpose)) {
    return fail('contract requires id, revision, and purpose');
  }
  if (!isTypeMap(contract.input) || !isTypeMap(contract.output)) {
    return fail(`${contract.id}: input and output must be closed type maps`);
  }
  if (!isSelectorList(contract.effects) || !isSelectorList(contract.permissions)) {
    return fail(`${contract.id}: effects and permissions must be selectors`);
  }
  if (!selectorsEqual(contract.effects, contract.permissions)) {
    return fail(`${contract.id}: declared effects must equal authorized effects`);
  }
  if (!Array.isArray(contract.failures) || contract.failures.some((code) => !isNonEmpty(code))) {
    return fail(`${contract.id}: failures must be a list of codes`);
  }
  if (!Array.isArray(contract.depends_on) || contract.depends_on.some((id) => !isNonEmpty(id))) {
    return fail(`${contract.id}: depends_on must be a list of capability ids`);
  }
  if (contract.inference) {
    const inference = invalidInference(contract.inference);
    if (inference) {
      return fail(inference);
    }
  }
  return { ok: true };
}

/**
 * A later corpus may add cases. It may not drop or rewrite a held-out case:
 * deleting the case that failed is not a revision.
 */
export function checkHeldOutRetained(previous: readonly TestCase[], next: readonly TestCase[]): CorpusCheck {
  for (const prior of previous) {
    if (prior.split !== 'held_out') {
      continue;
    }
    const found = next.find((testCase) => testCase.id === prior.id);
    if (!found) {
      return fail(`held-out case ${prior.id} cannot be dropped`);
    }
    if (canonical(found) !== canonical(prior)) {
      return fail(`held-out case ${prior.id} cannot be rewritten`);
    }
  }
  return { ok: true };
}

function semanticBody(contract: CapabilityContract): {
  purpose: string;
  input: CapabilityContract['input'];
  output: CapabilityContract['output'];
  effects: readonly EffectSelector[];
  permissions: readonly EffectSelector[];
  failures: readonly string[];
  depends_on: readonly string[];
  inference: InferenceLimits | null;
} {
  return {
    purpose: contract.purpose,
    input: contract.input,
    output: contract.output,
    effects: contract.effects,
    permissions: contract.permissions,
    failures: contract.failures,
    depends_on: contract.depends_on,
    inference: contract.inference ?? null,
  };
}

function invalidInference(inference: InferenceLimits): string | null {
  if (!isNonEmpty(inference.kind)) {
    return 'inference.kind must be a non-empty string';
  }
  if (inference.role !== 'framing' && inference.role !== 'working' && inference.role !== 'extension') {
    return 'inference.role must be framing, working, or extension';
  }
  if (!Number.isInteger(inference.max_cost) || inference.max_cost < 0) {
    return 'inference.max_cost must be a non-negative integer';
  }
  if (!Array.isArray(inference.destinations) || inference.destinations.length === 0) {
    return 'inference.destinations must be a non-empty list';
  }
  if (!Number.isInteger(inference.max_attempts) || inference.max_attempts < 1) {
    return 'inference.max_attempts must be a positive integer';
  }
  return null;
}

function isSelectorList(value: readonly EffectSelector[]): boolean {
  return value.every((selector) => isNonEmpty(selector.input) && isEffect(selector.mode as Effect));
}

function isTypeMap(value: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => isNonEmpty(key) && isNonEmpty(value[key]));
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function fail(reason: string): CorpusCheck {
  return { ok: false, reason };
}

function canonical(value: unknown): string {
  return JSON.stringify(order(value));
}

function order(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(order);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const nested = record[key];
      if (nested !== undefined) {
        out[key] = order(nested);
      }
    }
    return out;
  }
  return value;
}
