import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { costed, validate, type Context } from '@weave/gauge';

/**
 * G5 evaluation cost: every line says whether it was measured, estimated or is
 * unknown, an unknown line is never zero, and a comparison cannot be weighed
 * against cost (the path to promotion) while either side's cost is unknown.
 */

type Rec = Record<string, unknown>;
interface Fixtures {
  readonly context: Context;
  readonly valid: readonly { readonly name: string; readonly record: Rec }[];
}
const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as Fixtures;
const { context } = fixtures;
const record = (name: string): Rec => {
  const found = fixtures.valid.find(v => v.name === name);
  assert.ok(found, name);
  return structuredClone(found.record);
};
const reason = (verdict: { ok: boolean; reason?: string }) => (verdict.ok ? 'ok' : verdict.reason);

const better = record('a comparison where the candidate is better');
const baseCost = record('an evaluation cost with no review');
const candCost = record('an evaluation cost counting failed trials, evaluation and review');
const unknownLine = { basis: 'unknown', micros: null };
const measured = (micros: number) => ({ basis: 'measured', micros });

test('partial usage: a total over an unknown line is unknown, never the sum of the known lines', () => {
  const partial = { ...candCost, review: unknownLine, total: unknownLine };
  assert.equal(reason(validate(partial, context)), 'ok');
  assert.equal(reason(validate({ ...partial, total: measured(18000) }, context)), 'cost');
  assert.equal(reason(validate({ ...partial, total: { basis: 'unknown', micros: 18000 } }, context)), 'cost');
  assert.equal(reason(validate({ ...partial, total: { basis: 'estimated', micros: 18000 } }, context)), 'cost');
  const allUnknown = { ...candCost, trial: unknownLine, evaluation: unknownLine, review: unknownLine, total: unknownLine };
  assert.equal(reason(validate(allUnknown, context)), 'ok');
});

test('an estimated line makes the total estimated, and an estimate is not a measurement', () => {
  const estimated = { ...candCost, trial: { basis: 'estimated', micros: 15600 }, total: { basis: 'estimated', micros: 27000 } };
  assert.equal(reason(validate(estimated, context)), 'ok');
  assert.equal(reason(validate({ ...estimated, total: measured(27000) }, context)), 'cost');
});

test('a measured zero is valid and distinct from unknown', () => {
  const zero = { ...candCost, trial: measured(0), evaluation: measured(0), review: measured(0), total: measured(0) };
  assert.equal(reason(validate(zero, context)), 'ok');
  assert.equal(reason(validate({ ...zero, review: { basis: 'unknown', micros: 0 } }, context)), 'cost');
  assert.equal(reason(validate({ ...zero, review: unknownLine }, context)), 'cost');
  assert.equal(reason(validate({ ...zero, review: { basis: 'measured', micros: null } }, context)), 'cost');
  assert.equal(reason(validate({ ...zero, review: { micros: 0 } }, context)), 'envelope');
  assert.equal(reason(validate({ ...zero, review: 0 }, context)), 'envelope');

  const base = { ...baseCost, trial: measured(0), evaluation: measured(0), total: measured(0) };
  assert.equal(reason(costed(better, [base, zero], context)), 'ok');
  assert.equal(reason(costed(better, [base, { ...zero, review: unknownLine, total: unknownLine }], context)), 'cost_unknown');
});

test('the cost trial count must match the bound result\'s sample count', () => {
  // res-cand has 120 samples per measure: 130 trials of which 10 failed.
  assert.equal(reason(validate(candCost, context)), 'ok');
  assert.equal(reason(validate({ ...candCost, failed_trials: 0 }, context)), 'trial_count');
  assert.equal(reason(validate({ ...candCost, trials: 140 }, context)), 'trial_count');
  assert.equal(reason(validate({ ...candCost, trials: 120 }, context)), 'trial_count');
  assert.equal(reason(validate({ ...candCost, trials: 120, failed_trials: 0 }, context)), 'ok');
  // A replay leaves completion unmeasured; its sample count is that of the measures it has.
  assert.equal(reason(validate({ ...candCost, result: 'res-replay' }, context)), 'ok');
  // A mismatch fails closed with its reason, never a throw, whatever the counts.
  for (const [trials, failed] of [[0, 0], [1, 0], [2 ** 40, 0], [130, 130]] as const) {
    assert.equal(reason(validate({ ...candCost, trials, failed_trials: failed }, context)), 'trial_count', `${trials}/${failed}`);
  }
  assert.equal(reason(costed(better, [baseCost, { ...candCost, failed_trials: 0 }], context)), 'trial_count');
});

test('a comparison weighed against cost needs a known cost for both results', () => {
  assert.equal(reason(costed(better, [baseCost, candCost], context)), 'ok');
  assert.equal(reason(costed(better, [candCost, baseCost], context)), 'ok');
  const estimated = { ...candCost, review: { basis: 'estimated', micros: 9000 }, total: { basis: 'estimated', micros: 27000 } };
  assert.equal(reason(costed(better, [baseCost, estimated], context)), 'ok');
  const unknownReview = { ...candCost, review: unknownLine, total: unknownLine };
  assert.equal(reason(costed(better, [baseCost, unknownReview], context)), 'cost_unknown');
  assert.equal(reason(costed(better, [{ ...baseCost, trial: unknownLine, total: unknownLine }, candCost], context)), 'cost_unknown');
  // A missing cost is an unknown cost.
  assert.equal(reason(costed(better, [baseCost], context)), 'cost_unknown');
  assert.equal(reason(costed(better, [], context)), 'cost_unknown');
});

test('costed fails closed on what it cannot bind', () => {
  assert.equal(reason(costed(better, 'none' as unknown as unknown[], context)), 'envelope');
  assert.equal(reason(costed(candCost, [baseCost, candCost], context)), 'envelope');
  assert.equal(reason(costed({ ...better, verdict: 'candidate_worse' }, [baseCost, candCost], context)), 'verdict');
  assert.equal(reason(costed(better, [baseCost, { ...candCost, total: measured(1) }], context)), 'cost');
  // Two costs for one result are ambiguous, and a cost for another result is not this comparison's.
  assert.equal(reason(costed(better, [baseCost, candCost, { ...candCost, cost: 'cost-res-cand-2' }], context)), 'binding');
  const other = { ...candCost, cost: 'cost-res-worse', result: 'res-worse', trials: 120, failed_trials: 0 };
  assert.equal(reason(validate(other, context)), 'ok');
  assert.equal(reason(costed(better, [baseCost, candCost, other], context)), 'binding');
});
