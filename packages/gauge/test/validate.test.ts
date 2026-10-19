import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, type Context } from '@weave/gauge';

/** Fail-closed paths the contract fixtures do not exercise. */

interface Fixtures {
  readonly context: Context;
  readonly valid: readonly { readonly name: string; readonly record: Record<string, unknown> }[];
}

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as Fixtures;
const { context } = fixtures;
const record = (name: string) => {
  const found = fixtures.valid.find(v => v.name === name);
  assert.ok(found, name);
  return found.record;
};
const base = record('a baseline that meets its bar');
const better = record('a comparison where the candidate is better');
const routing = record('a deterministic routing attribution');

const reason = (value: unknown, ctx: Context = context) => {
  const verdict = validate(value, ctx);
  return verdict.ok ? 'ok' : verdict.reason;
};

test('a malformed bound record is unknown, never a crash', () => {
  const name = base.criteria as string;
  const broken = (entry: unknown): Context => ({ ...context, criteria: { ...context.criteria, [name]: entry } });
  assert.equal(reason(base, broken(null)), 'binding');
  assert.equal(reason(base, broken({ schema: 'gauge.criteria@1' })), 'binding');
  assert.equal(reason(base, broken({ ...(context.criteria[name] as object), measures: 'x' })), 'binding');
  assert.equal(reason(better, broken(null)), 'binding');
  assert.equal(reason(routing, broken(null)), 'binding');
});

test('a context entry must carry the name it is filed under', () => {
  const name = base.criteria as string;
  const misfiled = { ...(context.criteria[name] as object), criteria: 'decision-sites.other@1' };
  assert.equal(reason(base, { ...context, criteria: { ...context.criteria, [name]: misfiled } }), 'binding');
  const results = { ...context.results, 'res-base': { ...(context.results['res-cand'] as object) } };
  assert.equal(reason(better, { ...context, results }), 'binding');
});

test('a bound result that fails its own recomputation cannot be compared', () => {
  const lying = { ...(context.results['res-cheap'] as object), verdict: 'meets_bar' };
  const results = { ...context.results, 'res-cheap': lying };
  assert.equal(reason(record('a comparison where a cheaper candidate misses the bar'), { ...context, results }), 'binding');
});

test('a null delta carries a null interval', () => {
  const replay = { ...(context.results['res-replay'] as object), result: 'res-replay-b',
    subject: { kind: 'routed_unit', ref: 'boolean.task@jev-1.13.0' } };
  const ctx = { ...context, results: { ...context.results, 'res-replay-b': replay } };
  const comparison = {
    ...better, baseline: 'res-replay-b', candidate: 'res-replay',
    deltas: [
      { measure: 'accuracy', delta: 0, interval: [-0.05, 0.05] },
      { measure: 'cost', delta: 0, interval: [-10, 10] },
      { measure: 'completion', delta: null, interval: null },
    ],
    verdict: 'no_difference',
  };
  assert.equal(reason(comparison, ctx), 'ok');
  const claimed = { ...comparison, deltas: [...comparison.deltas.slice(0, 2), { measure: 'completion', delta: null, interval: [0, 0] }] };
  assert.equal(reason(claimed, ctx), 'measure');
});

test('envelope rejects mistyped scalars and a reversed interval', () => {
  assert.equal(reason({ ...base, measures: [{ measure: 'accuracy', value: 0.85, n: 120, interval: [0.9, 0.8] }] }), 'envelope');
  assert.equal(reason({ ...routing, confidence: 1.5 }), 'envelope');
  assert.equal(reason({ ...better, deltas: 'none' }), 'envelope');
  assert.equal(reason([]), 'envelope');
});

test('unattributed with a judgment basis is rejected', () => {
  assert.equal(reason({ ...routing, category: 'unattributed', basis: 'judgment', signal: null, confidence: 0.5 }), 'attribution');
});
