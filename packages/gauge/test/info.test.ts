import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compare, costed, evaluate, evaluateInfo, recordDigest, track, validate, type Context, type EvaluationResult, type Run } from '@weave/gauge';

/**
 * G4 (#192): info-only criteria sets and results. Every measure in a
 * `gauge.criteria@2` set is recorded to reproduce a report, never weighed, so
 * no gate, comparison, track, cost, attribution or routing preference may use
 * one, and a set with no bar never reads as having met one.
 */

interface Fixtures {
  readonly context: Context;
  readonly valid: readonly { readonly name: string; readonly record: unknown }[];
}
const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as Fixtures;
const base = fixtures.context;

const INFO = 'decision-sites.report@1';
const CASES = 'decision-sites.cases@1';
const TUNE = 'sha256:' + 'a'.repeat(64);
const check = { evidence: 'check' } as const;
const info = {
  schema: 'gauge.criteria@2',
  criteria: INFO,
  workload: 'decision-sites',
  governed_by: { kind: 'policy', ref: 'eval-policy-3' },
  measures: [
    { measure: 'attempted', source: check, aggregate: 'sum', empty: 0 },
    { measure: 'coverage', source: check, aggregate: 'rate', empty: 0 },
    { measure: 'accuracy', source: check, aggregate: 'rate', empty: null },
    { measure: 'confidence', source: check, aggregate: 'mean', empty: null },
    { measure: 'latency_p50', source: { weft_kind: 'inference.attempt', field: 'latency_ms' }, aggregate: 'p50_floor', empty: null },
    { measure: 'latency_p90', source: { weft_kind: 'inference.attempt', field: 'latency_ms' }, aggregate: 'p90_floor', empty: null },
    { measure: 'latency_p95', source: { weft_kind: 'inference.attempt', field: 'latency_ms' }, aggregate: 'p95', empty: null },
    { measure: 'ece', source: check, aggregate: 'ece10', empty: null },
    { measure: 'auc', source: check, aggregate: 'auc', empty: null },
  ],
};
const revision = {
  schema: 'gauge.revision@1', revision: INFO, record: 'criteria', digest: recordDigest(info), supersedes: null,
  issued_by: { kind: 'policy', ref: 'eval-policy-3' }, justification: 'initial', evidence: [],
};
const context: Context = {
  ...base,
  criteria: { ...base.criteria, [INFO]: info },
  revisions: { ...base.revisions, [INFO]: revision },
};

const latencies = [480, 300, 553, 612, 300, 497, 401, 999, 350, 482, 470];
const calibration: [number, number][] = [[0.95, 1], [0.05, 0], [0.62, 1], [0.66, 0], [0.1, 1], [1, 1], [0.35, 0], [0.35, 1]];
const scores: [number, number][] = [[0.9, 1], [0.3, 1], [0.3, 0], [0.1, 0], [0.7, 0]];
const run = (samples: Record<string, unknown[]>, overrides: Record<string, unknown> = {}): Run => ({
  result: 'res-info',
  subject: { kind: 'policy', ref: 'typesafe-jev.tuned' },
  workload: 'decision-sites',
  criteria: INFO,
  caseset: CASES,
  split: 'tune',
  mode: 'replay',
  evidence: [{ source: 'check', ref: 'decision-sites.score' }],
  samples: {
    attempted: [1, 1, 1, 1], coverage: [1, 0, 1, 1], accuracy: [1, 0, 1], confidence: [0.9, 0.75, 0.8],
    latency_p50: latencies, latency_p90: latencies, latency_p95: latencies, ece: calibration, auc: scores,
    ...samples,
  },
  ...overrides,
} as unknown as Run);
const refusal = (out: { ok: boolean; reason?: string }) => (out.ok ? 'ok' : out.reason);
const produced = (r: Run, ctx: Context = context) => {
  const out = evaluateInfo(r, ctx);
  assert.ok(out.ok, `evaluate refused: ${out.ok ? '' : out.reason}`);
  return out.record as unknown as { schema: string; result: string; measures: { measure: string; value: number | null; n: number }[]; verdict: string };
};
const entry = (r: { measures: { measure: string; value: number | null; n: number }[] }, name: string) =>
  r.measures.find(m => m.measure === name)!;

// Independent reference arithmetic for the expected values.
function expectedEce(points: readonly [number, number][]): number {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const [p, y] of points) { const b = bins[Math.min(9, Math.floor(p * 10))]!; b.n++; b.p += p; b.y += y; }
  return bins.reduce((s, b) => s + (b.n ? Math.abs(b.p - b.y) / points.length : 0), 0);
}

test('an info-only set and its revision validate, and v1 fixtures still validate unchanged', () => {
  assert.deepEqual(validate(info, context), { ok: true });
  assert.deepEqual(validate(revision, context), { ok: true });
  for (const { name, record } of fixtures.valid) assert.deepEqual(validate(record, context), { ok: true }, name);
});

test('evaluate reproduces every info aggregate exactly, in sample order, with no interval', () => {
  const r = produced(run({}));
  assert.equal(r.schema, 'gauge.result@2');
  assert.deepEqual(validate(r, context), { ok: true });
  assert.deepEqual(r.measures.map(m => Object.keys(m)), r.measures.map(() => ['measure', 'value', 'n']));
  assert.deepEqual([entry(r, 'attempted').value, entry(r, 'attempted').n], [4, 4]);
  assert.deepEqual([entry(r, 'coverage').value, entry(r, 'coverage').n], [3 / 4, 4]);
  assert.deepEqual([entry(r, 'accuracy').value, entry(r, 'accuracy').n], [2 / 3, 3]);
  assert.equal(entry(r, 'confidence').value, (0 + 0.9 + 0.75 + 0.8) / 3);
  const sorted = [...latencies].sort((a, b) => a - b);
  assert.equal(entry(r, 'latency_p50').value, sorted[Math.floor(0.5 * (sorted.length - 1))]);
  assert.equal(entry(r, 'latency_p90').value, sorted[Math.floor(0.9 * (sorted.length - 1))]);
  assert.equal(entry(r, 'latency_p95').value, sorted[Math.ceil(0.95 * sorted.length) - 1]);
  assert.deepEqual([entry(r, 'ece').value, entry(r, 'ece').n], [expectedEce(calibration), calibration.length]);
  // Positives 0.9, 0.3 against negatives 0.3, 0.1, 0.7: wins 3 + 1.5 over 6 pairs.
  assert.deepEqual([entry(r, 'auc').value, entry(r, 'auc').n], [4.5 / 6, 6]);
  assert.deepEqual(produced(run({})), r, 'the same samples give the same result');
});

test('an empty population takes the declared empty value: 0 for a count or coverage, null otherwise', () => {
  const r = produced(run(Object.fromEntries(info.measures.map(m => [m.measure, []]))));
  assert.deepEqual(r.measures.map(m => [m.measure, m.value, m.n]), [
    ['attempted', 0, 0], ['coverage', 0, 0], ['accuracy', null, 0], ['confidence', null, 0], ['latency_p50', null, 0],
    ['latency_p90', null, 0], ['latency_p95', null, 0], ['ece', null, 0], ['auc', null, 0],
  ]);
  // One class has no pair to order, so AUC is empty however many samples there are.
  assert.deepEqual([entry(produced(run({ auc: [[0.9, 1], [0.2, 1]] })), 'auc').value, entry(produced(run({ auc: [[0.9, 1]] })), 'auc').n], [null, 0]);
});

test('an info-only result never reads as meeting a bar', () => {
  const r = produced(run({}));
  assert.equal(r.verdict, 'info_only');
  assert.equal(refusal(validate({ ...r, verdict: 'meets_bar' }, context)), 'verdict');
  assert.equal(refusal(validate({ ...r, verdict: 'insufficient_evidence' }, context)), 'verdict');
  // A v1 result cannot borrow an info-only set to claim a vacuous meets_bar.
  const v1 = {
    ...(Object.values(base.results)[0] as EvaluationResult), result: 'res-borrow', criteria: INFO,
    measures: info.measures.map(m => ({ measure: m.measure, value: null, n: 0, interval: null })), constraints: [], verdict: 'meets_bar',
  };
  assert.equal(refusal(validate(v1, context)), 'info_only');
});

test('comparison, track, cost, costed, attribution and routing preference refuse info-only results', () => {
  const a = produced(run({}));
  const b = produced(run({}, { result: 'res-info-b', subject: { kind: 'policy', ref: 'typesafe-jev.production' } }));
  const ctx: Context = { ...context, results: { ...context.results, [a.result]: a, [b.result]: b } };
  assert.equal(refusal(compare({ comparison: 'cmp-info', experiment: null, baseline: a.result, candidate: b.result }, ctx)), 'info_only');
  assert.equal(refusal(track([a.result, b.result], ctx)), 'info_only');
  const comparison = { schema: 'gauge.comparison@1', comparison: 'cmp-info', experiment: null, baseline: a.result, candidate: b.result,
    deltas: info.measures.map(m => ({ measure: m.measure, delta: null, interval: null })), verdict: 'insufficient_evidence' };
  assert.equal(refusal(validate(comparison, ctx)), 'info_only');
  const line = { basis: 'measured', micros: 0 };
  const cost = { schema: 'gauge.cost@1', cost: 'cost-info', result: a.result, trials: 4, failed_trials: 0, trial: line, evaluation: line, review: line, total: line };
  assert.equal(refusal(validate(cost, ctx)), 'info_only');
  assert.equal(refusal(costed(comparison, [cost], ctx)), 'info_only');
  const attribution = { schema: 'gauge.attribution@1', attribution: 'attr-info', result: a.result, case: 'case-1',
    category: 'unattributed', basis: 'none', signal: null, confidence: null, evidence: [] };
  assert.equal(refusal(validate(attribution, ctx)), 'info_only');
  const preference = {
    schema: 'gauge.preference@1', preference: 'decision-sites.routing@1', workload: 'decision-sites', criteria: INFO, caseset: CASES,
    split: 'tune', mode: 'replay', accept: 'coverage',
    entries: [{ routed_unit: 'typesafe-jev', result: a.result, verdict: 'meets_bar', measures: a.measures.map(m => ({ ...m, interval: null })) }],
  };
  assert.equal(refusal(validate(preference, ctx)), 'info_only');
  // Under a weighable criteria set, an entry still cannot cite an info-only result.
  const v1Preference = { ...preference, criteria: 'decision-sites.criteria@1', accept: 'accuracy' };
  assert.equal(refusal(validate(v1Preference, ctx)), 'info_only');
});

test('info-only records keep the binding, holdout and replay rules and reject malformed measures', () => {
  assert.equal(refusal(evaluateInfo(run({}, { workload: 'other-workload' }), context)), 'binding');
  // The gated producer never judges an info-only set against a bar.
  assert.equal(refusal(evaluate(run({}), context)), 'info_only');
  const holdout = run({}, { split: 'holdout' });
  assert.equal(refusal(evaluateInfo(holdout, context)), 'holdout');
  assert.equal(refusal(evaluateInfo(run({}, { split: 'holdout', evidence: [{ source: 'held_out_report', ref: 'report-1' }] }), context)), 'ok');
  const outcome = { ...info, criteria: 'decision-sites.outcome@1', measures: [{ measure: 'done', source: { weft_kind: 'outcome', field: 'status' }, aggregate: 'rate', empty: null }] };
  const outcomeCtx: Context = { ...context, criteria: { ...context.criteria, [outcome.criteria]: outcome },
    revisions: { ...context.revisions, [outcome.criteria]: { ...revision, revision: outcome.criteria, digest: recordDigest(outcome) } } };
  assert.equal(refusal(evaluateInfo(run({}, { criteria: outcome.criteria, samples: { done: [1] } }), outcomeCtx)), 'mode');
  assert.equal(refusal(evaluateInfo(run({}, { criteria: outcome.criteria, samples: { done: [] } }), outcomeCtx)), 'ok');
  assert.equal(refusal(evaluateInfo(run({ coverage: [0.5] }), context)), 'measure');
  assert.equal(refusal(evaluateInfo(run({ ece: [0.5] }), context)), 'envelope');
  assert.equal(refusal(evaluateInfo(run({ ece: [[1.5, 1]] }), context)), 'envelope');
  assert.equal(refusal(evaluateInfo(run({ auc: [[0.5, 2]] }), context)), 'envelope');
  assert.equal(refusal(evaluateInfo(run({ attempted: [[1, 1]] }), context)), 'envelope');

  const r = produced(run({}));
  const edit = (name: string, change: object) => ({ ...r, measures: r.measures.map(m => (m.measure === name ? { ...m, ...change } : m)) });
  assert.equal(refusal(validate(edit('attempted', { value: null, n: 0 }), context)), 'measure', 'an empty count is 0, not null');
  assert.equal(refusal(validate(edit('accuracy', { value: 0, n: 0 }), context)), 'measure', 'an empty accuracy is null, not 0');
  assert.equal(refusal(validate(edit('accuracy', { value: null }), context)), 'measure');
  assert.equal(refusal(validate(edit('coverage', { value: 1.25 }), context)), 'measure');
  assert.equal(refusal(validate(edit('coverage', { interval: [0, 1] }), context)), 'envelope');

  for (const [change, reason] of [
    [{ method: { interval: 'bootstrap@1', level: 0.95, seed: 0, min_samples: 1 } }, 'envelope'],
    [{ constraints: [] }, 'envelope'],
    [{ measures: [{ measure: 'x', source: check, aggregate: 'median', empty: null }] }, 'envelope'],
    [{ measures: [{ measure: 'x', source: check, aggregate: 'rate', empty: null, better: 'higher' }] }, 'envelope'],
    [{ measures: [{ measure: 'x', source: check, aggregate: 'rate', empty: 2 }] }, 'measure'],
    [{ measures: [{ measure: 'x', source: check, aggregate: 'sum', empty: 0 }, { measure: 'x', source: check, aggregate: 'sum', empty: 0 }] }, 'measure'],
  ] as const) {
    assert.equal(refusal(validate({ ...info, ...change }, context)), reason, JSON.stringify(change));
  }
  // A weighable criteria set keeps v1's aggregates only.
  const v1 = base.criteria['decision-sites.criteria@1'] as { measures: object[] };
  assert.equal(refusal(validate({ ...v1, measures: v1.measures.map(m => ({ ...m, aggregate: 'p50_floor' })) }, context)), 'envelope');
});

test('evaluation is pure: it reads no shared state and leaves its inputs unchanged', () => {
  const frozen = <T>(x: T): T => { if (typeof x === 'object' && x !== null) { Object.values(x).forEach(frozen); Object.freeze(x); } return x; };
  const input = frozen(structuredClone(run({})));
  const ctx = frozen(structuredClone(context));
  const [one, two] = [produced(input, ctx), produced(input, ctx)];
  assert.deepEqual(one, two);
  assert.notEqual(one.measures, two.measures);
});
