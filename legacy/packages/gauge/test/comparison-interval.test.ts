import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compare,
  costed,
  recordDigest,
  validate,
  type Comparison,
  type Context,
  type CriteriaSet,
  type EvaluationResult,
  type Revision,
} from '@weave/gauge';

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as {
  context: Context;
  valid: { name: string; record: Record<string, unknown> }[];
};
const { context } = fixtures;
const request = { comparison: 'cmp-interval', experiment: null, baseline: 'res-base', candidate: 'res-cand' };
const honest = compare(request, context);
assert.ok(honest.ok);
const costs = fixtures.valid.filter((f) => f.record.schema === 'gauge.cost@1').map((f) => f.record);
const mutate = (index: number, interval: readonly [number, number]): Comparison => ({
  ...honest.record,
  deltas: honest.record.deltas.map((d, i) => (i === index ? { ...d, interval } : d)),
});

test('forged narrower and wider intervals fail validation and the cost gate before a winning verdict', () => {
  for (const [i, d] of honest.record.deltas.entries()) {
    assert.ok(d.interval !== null && d.delta !== null);
    for (const interval of [
      [d.delta - 1e-6, d.delta + 1e-6],
      [d.interval[0] - 1, d.interval[1] + 1],
    ] as const) {
      const forged = mutate(i, interval);
      assert.deepEqual(validate(forged, context), { ok: false, reason: 'measure' });
      assert.deepEqual(costed(forged, costs, context), { ok: false, reason: 'measure' });
    }
  }
});

test('each interval bound independently tolerates EPSILON but rejects errors beyond it in either direction', () => {
  const d = honest.record.deltas[0]!;
  assert.ok(d.interval !== null);
  for (const bound of [0, 1] as const) {
    for (const sign of [-1, 1]) {
      for (const [offset, expected] of [
        [0.999e-9, { ok: true }],
        [1.001e-9, { ok: false, reason: 'measure' }],
      ] as const) {
        const interval: [number, number] = [...d.interval];
        interval[bound] += sign * offset;
        assert.deepEqual(validate(mutate(0, interval), context), expected);
      }
    }
  }
});

test('produced fixture comparisons round-trip through recorded JSON and concurrent validation without state', async () => {
  for (const { record } of fixtures.valid.filter((f) => f.record.schema === 'gauge.comparison@1')) {
    const out = compare(
      { ...request, baseline: record.baseline as string, candidate: record.candidate as string },
      context,
    );
    assert.ok(out.ok);
    const recorded = JSON.stringify({ record: out.record, context });
    const replay = () => {
      const restored = JSON.parse(recorded) as { record: Comparison; context: Context };
      return validate(restored.record, restored.context);
    };
    assert.deepEqual(validate(out.record, context), { ok: true });
    assert.deepEqual(await Promise.all([Promise.resolve().then(replay), Promise.resolve().then(replay)]), [
      { ok: true },
      { ok: true },
    ]);
    assert.deepEqual(replay(), { ok: true });
  }
});

test('derivable intervals touching zero remain no_difference in both directions, including exact EPSILON', () => {
  for (const [baseId, candId] of [
    ['res-hi-a', 'res-hi-b'],
    ['res-lo-a', 'res-lo-b'],
  ] as const) {
    for (const reverse of [false, true]) {
      const result = (id: string, above: boolean) => {
        const r = context.results[id] as EvaluationResult;
        return {
          ...r,
          measures: r.measures.map((m) => {
            assert.ok(m.value !== null);
            return {
              ...m,
              interval: (above ? [m.value, m.value + 0.01] : [m.value - 0.01, m.value]) as [number, number],
            };
          }),
        };
      };
      const ctx = {
        ...context,
        results: { ...context.results, [baseId]: result(baseId, reverse), [candId]: result(candId, !reverse) },
      };
      const out = compare({ ...request, baseline: baseId, candidate: candId }, ctx);
      assert.ok(out.ok);
      assert.equal(out.record.verdict, 'no_difference');
      assert.deepEqual(validate(out.record, ctx), { ok: true });
      if (reverse) {
        assert.equal(out.record.deltas[0]!.interval![1], 0);
        const atEpsilon = {
          ...out.record,
          deltas: out.record.deltas.map((d) => ({ ...d, interval: [d.interval![0], 1e-9] })),
        };
        assert.deepEqual(validate(atEpsilon, ctx), { ok: true });
      }
    }
  }
});

test('a forged interval cannot turn an inconclusive effect into candidate_better or pass costed', () => {
  const base = context.results['res-hi-b'] as EvaluationResult;
  const cand = { ...base, measures: base.measures.map((m) => ({ ...m, value: m.value! + 0.01 })) };
  const ctx = { ...context, results: { ...context.results, [cand.result]: cand } };
  const uncertain = compare({ ...request, baseline: 'res-hi-a', candidate: 'res-hi-b' }, ctx);
  assert.ok(uncertain.ok);
  assert.equal(uncertain.record.verdict, 'no_difference');
  const forged = {
    ...uncertain.record,
    verdict: 'candidate_better',
    deltas: uncertain.record.deltas.map((d) => ({ ...d, interval: [0.001, 0.02] })),
  };
  assert.deepEqual(validate(forged, ctx), { ok: false, reason: 'measure' });
  assert.deepEqual(costed(forged, [], ctx), { ok: false, reason: 'measure' });
});

test('EPSILON-sized claims across zero or min_effect cannot change the validated verdict or cost gate', () => {
  for (const [baseId, candId] of [
    ['res-hi-a', 'res-hi-b'],
    ['res-lo-a', 'res-lo-b'],
  ] as const) {
    for (const sign of [-1, 1]) {
      for (const boundary of [0, 0.125]) {
        const base = context.results[baseId] as EvaluationResult;
        const cand = context.results[candId] as EvaluationResult;
        const criteria = context.criteria[base.criteria] as CriteriaSet;
        const candidateValue = 0.5 + sign * (0.125 + boundary);
        const set = {
          ...criteria,
          measures: criteria.measures.map((m) => ({ ...m, min_effect: boundary === 0 ? 0 : boundary + 0.5e-9 })),
        };
        const ctx: Context = {
          ...context,
          criteria: {
            ...context.criteria,
            [base.criteria]: set,
          },
          revisions: {
            ...context.revisions,
            [base.criteria]: { ...(context.revisions[base.criteria] as Revision), digest: recordDigest(set) },
          },
          results: {
            ...context.results,
            [baseId]: { ...base, measures: [{ ...base.measures[0]!, value: 0.5, interval: [0.375, 0.625] }] },
            [candId]: {
              ...cand,
              measures: [
                {
                  ...cand.measures[0]!,
                  value: candidateValue,
                  interval:
                    sign > 0 ? [candidateValue, candidateValue + 0.125] : [candidateValue - 0.125, candidateValue],
                },
              ],
            },
          },
        };
        const out = compare({ ...request, baseline: baseId, candidate: candId }, ctx);
        assert.ok(out.ok, JSON.stringify({ baseId, sign, boundary, out }));
        assert.equal(out.record.verdict, 'no_difference');
        assert.deepEqual(validate(out.record, ctx), { ok: true });
        const interval: [number, number] = [...out.record.deltas[0]!.interval!];
        const bound = sign > 0 ? 0 : 1;
        assert.equal(interval[bound], boundary === 0 ? 0 : sign * boundary);
        interval[bound] += sign * 0.75e-9;
        const shifted = { ...out.record, deltas: out.record.deltas.map((d) => ({ ...d, interval })) };
        const improving = sign > 0 === (criteria.measures[0]!.better === 'higher');
        const forged = { ...shifted, verdict: improving ? 'candidate_better' : 'candidate_worse' };
        assert.deepEqual(validate(forged, ctx), { ok: false, reason: 'verdict' });
        assert.deepEqual(costed(forged, [], ctx), { ok: false, reason: 'verdict' });
        assert.deepEqual(validate(shifted, ctx), { ok: true });
      }
    }
  }
});
