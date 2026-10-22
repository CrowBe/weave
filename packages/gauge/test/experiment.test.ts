import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compare, evaluate, recordDigest, track, validate, type Context, type EvaluationResult, type Run } from '@weave/gauge';
import { wilson } from '../src/stats.js';

/**
 * G5: baseline against candidate with uncertainty, regression tracking and
 * stated modes, over Gauge's own validated records. Statistics use the
 * criteria set's fixed seed, so every assertion here is exact on rerun.
 */

interface Fixtures {
  readonly context: Context;
}
const { context } = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as Fixtures;
const C1 = 'decision-sites.criteria@1';

const rates = (successes: number, n: number) => Array.from({ length: n }, (_, i) => (i < successes ? 1 : 0));
/** An even count of costs whose mean is exactly `centre`. */
const costs = (centre: number, n: number) => Array.from({ length: n }, (_, i) => centre + (i % 2 === 0 ? -5 : 5));

const run = (overrides: Partial<Run> = {}): Run => ({
  result: 'res-run-a',
  subject: { kind: 'routed_unit', ref: 'boolean.task@jev-1.13.0' },
  workload: 'decision-sites',
  criteria: C1,
  caseset: 'decision-sites.cases@1',
  split: 'tune',
  mode: 'trial',
  evidence: [{ source: 'weft_trace', ref: 'trace-run-a' }],
  samples: { accuracy: rates(102, 120), cost: costs(150, 120), completion: rates(84, 120) },
  ...overrides,
});

const produced = (r: Run, ctx: Context = context): EvaluationResult => {
  const out = evaluate(r, ctx);
  assert.ok(out.ok, `evaluate refused ${r.result}: ${out.ok ? '' : out.reason}`);
  return out.record;
};
const refusal = (out: { ok: boolean; reason?: string }) => (out.ok ? 'ok' : out.reason);
const withResults = (...results: EvaluationResult[]): Context =>
  ({ ...context, results: { ...context.results, ...Object.fromEntries(results.map(r => [r.result, r])) } });
const measure = (r: EvaluationResult, name: string) => r.measures.find(m => m.measure === name)!;

const baseline = produced(run({ samples: { accuracy: rates(108, 120), cost: costs(150, 120), completion: rates(84, 120) } }));
const candidate = produced(run({
  result: 'res-run-b', subject: { kind: 'routed_unit', ref: 'boolean.task@jev-1.14.0' },
  evidence: [{ source: 'weft_trace', ref: 'trace-run-b' }],
  samples: { accuracy: rates(116, 120), cost: costs(120, 120), completion: rates(86, 120) },
}));

test('evaluate builds a result that validates, the same on every run', () => {
  assert.deepEqual(validate(baseline, context), { ok: true });
  assert.equal(baseline.verdict, 'meets_bar');
  assert.equal(baseline.caseset_digest, (context.casesets['decision-sites.cases@1'] as { splits: { digest: string }[] }).splits[0]!.digest);
  assert.deepEqual(measure(baseline, 'accuracy').value, 0.9);
  assert.deepEqual(measure(baseline, 'cost').value, 150);
  assert.equal(measure(baseline, 'accuracy').n, 120);
  const again = produced(run({ samples: { accuracy: rates(108, 120), cost: costs(150, 120), completion: rates(84, 120) } }));
  assert.deepEqual(again, baseline);
  for (const m of baseline.measures) {
    assert.ok(m.interval !== null && m.interval[0] <= m.value! && m.value! <= m.interval[1], m.measure);
  }
});

test('empty samples are insufficient evidence, not a pass, a failure or a tie', () => {
  const empty = produced(run({ result: 'res-empty', samples: { accuracy: [], cost: [], completion: [] } }));
  assert.deepEqual(empty.measures.map(m => [m.value, m.n, m.interval]), [[null, 0, null], [null, 0, null], [null, 0, null]]);
  assert.deepEqual(empty.constraints.map(c => c.status), ['unknown', 'unknown']);
  assert.equal(empty.verdict, 'insufficient_evidence');
  const ctx = withResults(baseline, { ...empty, subject: { kind: 'routed_unit', ref: 'boolean.task@empty' } });
  const cmp = compare({ comparison: 'cmp-empty', experiment: null, baseline: baseline.result, candidate: 'res-empty' }, ctx);
  assert.ok(cmp.ok);
  assert.equal(cmp.record.verdict, 'insufficient_evidence');
  assert.deepEqual(cmp.record.deltas.map(d => d.delta), [null, null, null]);
});

test('too few samples are insufficient evidence even when the value clears the bar', () => {
  const small = produced(run({ result: 'res-few', samples: { accuracy: rates(12, 12), cost: costs(100, 12), completion: rates(9, 12) } }));
  assert.equal(measure(small, 'accuracy').value, 1);
  assert.deepEqual(small.constraints.map(c => c.status), ['unknown', 'unknown']);
  assert.equal(small.verdict, 'insufficient_evidence');
  const ctx = withResults(baseline, { ...small, subject: { kind: 'routed_unit', ref: 'boolean.task@few' } });
  const cmp = compare({ comparison: 'cmp-few', experiment: 'exp-12', baseline: baseline.result, candidate: 'res-few' }, ctx);
  assert.ok(cmp.ok);
  assert.equal(cmp.record.verdict, 'insufficient_evidence');
});

test('samples from another workload never become a result for this one', () => {
  assert.equal(refusal(evaluate(run({ workload: 'task-acceptance' }), context)), 'binding');
});

test('sample lists match the criteria measures one-to-one', () => {
  const { completion: _dropped, ...missing } = run().samples;
  assert.equal(refusal(evaluate(run({ samples: missing }), context)), 'binding');
  assert.equal(refusal(evaluate(run({ samples: { ...run().samples, latency: [1, 2] } }), context)), 'binding');
});

test('a run against an unknown or unrecorded criteria set or split is refused', () => {
  assert.equal(refusal(evaluate(run({ criteria: 'decision-sites.criteria@9' }), context)), 'binding');
  assert.equal(refusal(evaluate(run({ criteria: 'decision-sites.unrecorded@1' }), context)), 'binding');
  assert.equal(refusal(evaluate(run({ caseset: 'decision-sites.cases@2' }), context)), 'binding');
});

test('malformed samples are refused, and a rate sample is 0 or 1', () => {
  assert.equal(refusal(evaluate(run({ samples: { ...run().samples, cost: [1, Number.NaN] } }), context)), 'envelope');
  assert.equal(refusal(evaluate(run({ samples: { ...run().samples, cost: 'none' as unknown as number[] } }), context)), 'envelope');
  assert.equal(refusal(evaluate(run({ samples: { ...run().samples, accuracy: [1, 0.5, 0] } }), context)), 'measure');
});

test('a replay cannot claim outcomes for actions never taken, and says it is a replay', () => {
  assert.equal(refusal(evaluate(run({ mode: 'replay' }), context)), 'mode');
  const replay = produced(run({ mode: 'replay', samples: { ...run().samples, completion: [] } }));
  assert.equal(replay.mode, 'replay');
  assert.deepEqual(measure(replay, 'completion'), { measure: 'completion', value: null, n: 0, interval: null });
  // A replay and a trial answer different questions.
  const ctx = withResults(baseline, { ...replay, result: 'res-replay-b', subject: { kind: 'routed_unit', ref: 'boolean.task@jev-1.14.0' } });
  assert.equal(refusal(compare({ comparison: 'cmp-mode', experiment: null, baseline: baseline.result, candidate: 'res-replay-b' }, ctx)), 'binding');
});

test('a holdout run cites held-out reports only', () => {
  const holdout = run({ result: 'res-run-hold', split: 'holdout', samples: { accuracy: rates(36, 40), cost: costs(150, 40), completion: rates(28, 40) } });
  assert.equal(refusal(evaluate(holdout, context)), 'holdout');
  const ok = produced({ ...holdout, evidence: [{ source: 'held_out_report', ref: 'hor-run-a' }] });
  assert.equal(ok.caseset_digest, (context.casesets['decision-sites.cases@1'] as { splits: { digest: string }[] }).splits[1]!.digest);
});

test('wilson@1 criteria give each rate its wilson interval', () => {
  const set = {
    schema: 'gauge.criteria@1', criteria: 'decision-sites.wilson@1', workload: 'decision-sites',
    governed_by: { kind: 'policy', ref: 'eval-policy-3' },
    method: { interval: 'wilson@1', level: 0.9, seed: 0, min_samples: 30 },
    measures: [{ measure: 'accuracy', source: { weft_kind: 'judgment', field: 'accepted' }, aggregate: 'rate', better: 'higher', min_effect: 0.02 }],
    constraints: [{ constraint: 'accuracy_bar', measure: 'accuracy', op: 'ge', bound: 0.8, role: 'quality_bar' }],
  };
  const revision = {
    schema: 'gauge.revision@1', revision: set.criteria, record: 'criteria', digest: recordDigest(set), supersedes: null,
    issued_by: set.governed_by, justification: 'initial', evidence: [],
  };
  const ctx: Context = { ...context, criteria: { ...context.criteria, [set.criteria]: set },
    revisions: { ...context.revisions, [set.criteria]: revision } };
  const out = evaluate(run({ criteria: set.criteria, samples: { accuracy: rates(81, 100) } }), ctx);
  assert.ok(out.ok);
  assert.deepEqual(out.record.measures, [{ measure: 'accuracy', value: 0.81, n: 100, interval: wilson(81, 100, 0.9) }]);
});

test('compare reports effect size with uncertainty, the same on every run', () => {
  const ctx = withResults(baseline, candidate);
  const request = { comparison: 'cmp-run', experiment: 'exp-12', baseline: baseline.result, candidate: candidate.result };
  const out = compare(request, ctx);
  assert.ok(out.ok);
  assert.deepEqual(validate(out.record, ctx), { ok: true });
  assert.deepEqual(compare(request, ctx), out);
  for (const d of out.record.deltas) {
    const name = d.measure;
    assert.equal(d.delta, measure(candidate, name).value! - measure(baseline, name).value!, name);
    assert.ok(d.interval![0] <= d.delta! && d.delta! <= d.interval![1], name);
  }
  assert.equal(out.record.verdict, 'candidate_better');
});

test('compare recomputes the fixture verdicts from their intervals', () => {
  const verdict = (candidateId: string) => {
    const out = compare({ comparison: `cmp-${candidateId}`, experiment: null, baseline: 'res-base', candidate: candidateId }, context);
    return out.ok ? out.record.verdict : out.reason;
  };
  assert.equal(verdict('res-cand'), 'candidate_better');
  assert.equal(verdict('res-cheap'), 'bar_missed');
  assert.equal(verdict('res-worse'), 'candidate_worse');
  assert.equal(verdict('res-small'), 'insufficient_evidence');
});

test('compare refuses a question mismatch and a value without uncertainty', () => {
  const across = (candidateId: string, ctx: Context = context) =>
    refusal(compare({ comparison: 'cmp-x', experiment: null, baseline: 'res-base', candidate: candidateId }, ctx));
  assert.equal(across('res-hold'), 'binding');
  assert.equal(across('res-base'), 'binding');
  assert.equal(across('res-nowhere'), 'binding');
  const point = { ...(context.results['res-cand'] as EvaluationResult), result: 'res-point',
    measures: (context.results['res-cand'] as EvaluationResult).measures.map(m => ({ ...m, interval: null })) };
  const ctx = withResults(point);
  assert.deepEqual(validate(point, ctx), { ok: true });
  assert.equal(across('res-point', ctx), 'measure');
});

test('track makes a regression visible step by step', () => {
  const out = track(['res-base', 'res-cand', 'res-worse'], context);
  assert.ok(out.ok);
  assert.deepEqual(out.steps.map(s => [s.previous, s.next, s.verdict, s.regression]), [
    ['res-base', 'res-cand', 'candidate_better', false],
    ['res-cand', 'res-worse', 'candidate_worse', true],
  ]);
  const cheap = track(['res-cand', 'res-cheap', 'res-small'], context);
  assert.ok(cheap.ok);
  assert.deepEqual(cheap.steps.map(s => [s.verdict, s.regression]), [['bar_missed', true], ['insufficient_evidence', false]]);
});

test('track follows one subject across re-evaluations, which a comparison cannot', () => {
  const again = { ...(context.results['res-worse'] as EvaluationResult), result: 'res-cand-again',
    subject: { kind: 'routed_unit', ref: 'boolean.task@jev-1.14.0' } } as EvaluationResult;
  const ctx = withResults(again);
  assert.deepEqual(validate(again, ctx), { ok: true });
  assert.equal(refusal(compare({ comparison: 'cmp-same', experiment: null, baseline: 'res-cand', candidate: 'res-cand-again' }, ctx)), 'binding');
  const out = track(['res-cand', 'res-cand-again'], ctx);
  assert.ok(out.ok);
  assert.deepEqual(out.steps.map(s => [s.verdict, s.regression]), [['candidate_worse', true]]);
});

test('track refuses results that answer different questions', () => {
  assert.equal(refusal(track(['res-base', 'res-hold'], context)), 'binding');
  assert.equal(refusal(track(['res-cand', 'res-replay'], context)), 'binding');
  assert.equal(refusal(track(['res-base', 'res-base'], context)), 'binding');
  assert.equal(refusal(track(['res-base', 'res-nowhere'], context)), 'binding');
  assert.deepEqual(track([], context), { ok: true, steps: [] });
  assert.deepEqual(track(['res-base'], context), { ok: true, steps: [] });
});

/** A criteria set recorded by its first revision, so runs can bind to it. */
const withCriteria = (set: { readonly criteria: string; readonly governed_by: unknown; readonly [key: string]: unknown }): Context => ({
  ...context,
  criteria: { ...context.criteria, [set.criteria]: set },
  revisions: { ...context.revisions, [set.criteria]: {
    schema: 'gauge.revision@1', revision: set.criteria, record: 'criteria', digest: recordDigest(set), supersedes: null,
    issued_by: set.governed_by, justification: 'initial', evidence: [],
  } },
});
/** One unconstrained cost measure, a zero threshold and the smallest min_samples, so only the interval decides. */
const loose = withCriteria({
  schema: 'gauge.criteria@1', criteria: 'decision-sites.loose@1', workload: 'decision-sites',
  governed_by: { kind: 'policy', ref: 'eval-policy-3' },
  method: { interval: 'bootstrap@1', level: 0.95, seed: 7, min_samples: 1 },
  measures: [
    { measure: 'accuracy', source: { weft_kind: 'judgment', field: 'accepted' }, aggregate: 'rate', better: 'higher', min_effect: 0 },
    { measure: 'cost', source: { weft_kind: 'inference.attempt', field: 'spent_micros' }, aggregate: 'mean', better: 'lower', min_effect: 0 },
  ],
  constraints: [],
});
const pair = (ctx: Context, samples: readonly [Run['samples'], Run['samples']], criteriaName = C1) => {
  const a = produced(run({ result: 'res-pair-a', criteria: criteriaName, samples: samples[0] }), ctx);
  const b = produced(run({ result: 'res-pair-b', criteria: criteriaName, subject: { kind: 'routed_unit', ref: 'boolean.task@jev-1.14.0' },
    evidence: [{ source: 'weft_trace', ref: 'trace-pair-b' }], samples: samples[1] }), ctx);
  const both: Context = { ...ctx, results: { ...ctx.results, [a.result]: a, [b.result]: b } };
  return { a, b, both };
};
const verdicts = (ctx: Context) => {
  const cmp = compare({ comparison: 'cmp-pair', experiment: null, baseline: 'res-pair-a', candidate: 'res-pair-b' }, ctx);
  const back = track(['res-pair-b', 'res-pair-a'], ctx);
  assert.ok(cmp.ok && back.ok);
  return { compare: cmp.record.verdict, track: back.steps.map(s => [s.verdict, s.regression]) };
};

test('one sample has a zero-width interval, which is insufficient evidence for compare and track', () => {
  const { a, both } = pair(loose, [{ accuracy: [0], cost: [150] }, { accuracy: [1], cost: [100] }], 'decision-sites.loose@1');
  assert.deepEqual(measure(a, 'cost').interval, [150, 150]);
  assert.equal(a.verdict, 'meets_bar');
  assert.deepEqual(verdicts(both), { compare: 'insufficient_evidence', track: [['insufficient_evidence', false]] });
});

test('all-equal samples have a zero-width interval, which is insufficient evidence however many there are', () => {
  const same = (x: number) => Array.from({ length: 200 }, () => x);
  const { b, both } = pair(loose, [{ accuracy: same(0), cost: same(150) }, { accuracy: same(1), cost: same(100) }], 'decision-sites.loose@1');
  assert.deepEqual(measure(b, 'accuracy').interval, [1, 1]);
  assert.deepEqual(verdicts(both), { compare: 'insufficient_evidence', track: [['insufficient_evidence', false]] });
});

test('min_samples applies to an unconstrained measure too, on either side', () => {
  const full = { accuracy: rates(108, 120), cost: costs(150, 120) };
  const gain = { accuracy: rates(116, 120), cost: costs(120, 120) };
  for (const [completionA, completionB] of [[rates(8, 12), rates(9, 12)], [rates(84, 120), rates(9, 12)], [rates(8, 12), rates(86, 120)]] as const) {
    const { a, b, both } = pair(context, [{ ...full, completion: completionA }, { ...gain, completion: completionB }]);
    // completion carries no constraint, so each result still meets its bar.
    assert.deepEqual([a.verdict, b.verdict], ['meets_bar', 'meets_bar']);
    assert.deepEqual(verdicts(both), { compare: 'insufficient_evidence', track: [['insufficient_evidence', false]] });
  }
  // With every measure at min_samples the same gain is visible.
  const { both } = pair(context, [{ ...full, completion: rates(24, 30) }, { ...gain, completion: rates(25, 30) }]);
  assert.deepEqual(verdicts(both), { compare: 'candidate_better', track: [['candidate_worse', true]] });
});
