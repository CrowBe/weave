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
  const found = fixtures.valid.find((v) => v.name === name);
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
  assert.equal(
    reason(record('a comparison where a cheaper candidate misses the bar'), { ...context, results }),
    'binding',
  );
});

test('a null delta carries a null interval', () => {
  const replay = {
    ...(context.results['res-replay'] as object),
    result: 'res-replay-b',
    subject: { kind: 'routed_unit', ref: 'boolean.task@jev-1.13.0' },
  };
  const ctx = { ...context, results: { ...context.results, 'res-replay-b': replay } };
  const comparison = {
    ...better,
    baseline: 'res-replay-b',
    candidate: 'res-replay',
    deltas: [
      { measure: 'accuracy', delta: 0, interval: [-0.05, 0.05] },
      { measure: 'cost', delta: 0, interval: [-10, 10] },
      { measure: 'completion', delta: null, interval: null },
    ],
    verdict: 'no_difference',
  };
  assert.equal(reason(comparison, ctx), 'ok');
  const claimed = {
    ...comparison,
    deltas: [...comparison.deltas.slice(0, 2), { measure: 'completion', delta: null, interval: [0, 0] }],
  };
  assert.equal(reason(claimed, ctx), 'measure');
});

test('envelope rejects mistyped scalars and a reversed interval', () => {
  assert.equal(
    reason({ ...base, measures: [{ measure: 'accuracy', value: 0.85, n: 120, interval: [0.9, 0.8] }] }),
    'envelope',
  );
  assert.equal(reason({ ...routing, confidence: 1.5 }), 'envelope');
  assert.equal(reason({ ...better, deltas: 'none' }), 'envelope');
  assert.equal(reason([]), 'envelope');
});

test('unattributed with a judgment basis is rejected', () => {
  assert.equal(
    reason({ ...routing, category: 'unattributed', basis: 'judgment', signal: null, confidence: 0.5 }),
    'attribution',
  );
});

test('a zero-width delta interval is insufficient evidence, never no difference', () => {
  const unchanged = {
    ...record('an unchanged higher-is-better measure at a zero threshold'),
    deltas: [{ measure: 'accuracy', delta: 0, interval: [0, 0] }],
  };
  assert.equal(reason({ ...unchanged, verdict: 'no_difference' }), 'verdict');
  assert.equal(reason({ ...unchanged, verdict: 'insufficient_evidence' }), 'ok');
});

test('a zero-width measure interval in either result is insufficient evidence', () => {
  const pinned = {
    ...(context.results['res-lo-a'] as object),
    measures: [{ measure: 'cost', value: 150, n: 120, interval: [150, 150] }],
  };
  const ctx = { ...context, results: { ...context.results, 'res-lo-a': pinned } };
  assert.equal(reason(pinned, ctx), 'ok');
  const improvement = record('a strict improvement at a zero threshold');
  assert.equal(reason(improvement), 'ok');
  assert.equal(reason(improvement, ctx), 'verdict');
  assert.equal(reason({ ...improvement, verdict: 'insufficient_evidence' }, ctx), 'ok');
});

test('a preference entry cannot carry a meets_bar result with a zero-width accept interval', () => {
  const preference = record('a routing preference set over recorded results') as {
    entries: readonly Record<string, unknown>[];
  };
  const cand = context.results['res-cand'] as { measures: readonly { measure: string }[] };
  const pin = <T extends { measure: string }>(m: T) =>
    m.measure === 'accuracy' ? { ...m, value: 0.91, interval: [0.91, 0.91] } : m;
  const pinned = { ...cand, measures: cand.measures.map(pin) };
  const ctx = { ...context, results: { ...context.results, 'res-cand': pinned } };
  assert.equal(reason(pinned, ctx), 'ok', 'the result itself is valid');
  const entries = preference.entries.map((e) =>
    e.result === 'res-cand' ? { ...e, measures: (e.measures as readonly { measure: string }[]).map(pin) } : e,
  );
  assert.equal(reason({ ...preference, entries }, ctx), 'measure');
});

test('an unconstrained measure below min_samples makes a comparison insufficient evidence', () => {
  const cand = context.results['res-cand'] as { measures: readonly { measure: string }[] };
  const thin = { ...cand, measures: cand.measures.map((m) => (m.measure === 'completion' ? { ...m, n: 12 } : m)) };
  const ctx = { ...context, results: { ...context.results, 'res-cand': thin } };
  assert.equal(reason(thin, ctx), 'ok');
  assert.equal(reason(better, ctx), 'verdict');
  assert.equal(reason({ ...better, verdict: 'insufficient_evidence' }, ctx), 'ok');
});

test('a comparison cannot claim a verdict over a measure with no samples on either side', () => {
  const cand = context.results['res-cand'] as { mode: string; measures: readonly { measure: string }[] };
  assert.equal(cand.mode, 'trial');
  const unmeasured = {
    ...cand,
    measures: cand.measures.map((m) => (m.measure === 'completion' ? { ...m, value: null, n: 0, interval: null } : m)),
  };
  const ctx = { ...context, results: { ...context.results, 'res-cand': unmeasured } };
  assert.equal(reason(unmeasured, ctx), 'ok');
  const deltas = (better.deltas as readonly { measure: string }[]).map((d) =>
    d.measure === 'completion' ? { measure: 'completion', delta: null, interval: null } : d,
  );
  assert.equal(reason({ ...better, deltas }, ctx), 'verdict');
  assert.equal(reason({ ...better, deltas, verdict: 'no_difference' }, ctx), 'verdict');
  assert.equal(reason({ ...better, deltas, verdict: 'insufficient_evidence' }, ctx), 'ok');
});

test('a replay comparison skips its empty outcome measures and decides from the rest', () => {
  const replayB = {
    ...(context.results['res-replay'] as object),
    result: 'res-replay-b',
    subject: { kind: 'routed_unit', ref: 'boolean.task@jev-1.13.0' },
  };
  const ctx = { ...context, results: { ...context.results, 'res-replay-b': replayB } };
  const comparison = {
    ...better,
    baseline: 'res-replay-b',
    candidate: 'res-replay',
    deltas: [
      { measure: 'accuracy', delta: 0, interval: [-0.05, 0.05] },
      { measure: 'cost', delta: 0, interval: [-10, 10] },
      { measure: 'completion', delta: null, interval: null },
    ],
    verdict: 'no_difference',
  };
  assert.equal(reason(comparison, ctx), 'ok');
  assert.equal(reason({ ...comparison, verdict: 'insufficient_evidence' }, ctx), 'verdict');
});
