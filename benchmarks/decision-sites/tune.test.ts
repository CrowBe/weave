import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics, productionThresholds, tune, type Observed } from './tune.ts';
import { makeReport } from './report.ts';

function row(site: string, split: 'tune'|'holdout' = 'tune', overrides: Partial<Observed> = {}): Observed {
  return { item: { id: 'x', scenario_id: 's', site, state: {}, gold: { decision: true } }, split,
    result: { status: 'ok', answers: { decision: { probability: .8, confidence: .95 } } }, latency_ms: 10, cost_usd: .001, ...overrides };
}
test('tuning never reads holdout answers or labels', () => {
  const hidden = { split: 'holdout', get item() { throw Error('holdout leak'); }, get result() { throw Error('holdout leak'); } } as unknown as Observed;
  assert.deepEqual(tune('guard.output', [row('guard.output'), hidden]), tune('guard.output', [row('guard.output')]));
});
test('failures remain in coverage denominator and missing confidence is below zero floor', () => {
  const good = row('guard.output');
  const failed = row('guard.output', 'holdout', { result: { status: 'failed', reason: 'timeout' } });
  const missing = row('guard.output', 'holdout', { result: { status: 'ok', answers: { decision: { probability: .8 } } } });
  const score = metrics('guard.output', [good, failed, missing], { ...productionThresholds('guard.output'), confidence: 0 });
  assert.equal(score.coverage, 1/3); assert.equal(score.missing_confidence, 2); assert.equal(score.violation_recall, 1/3);
});
test('guard loosening is marked for captain and guards maximise recall', () => {
  const low = row('guard.output', 'tune', { result: { status: 'ok', answers: { decision: { probability: .2, confidence: .8 } } } });
  const tuned = tune('guard.output', [low]);
  assert.equal(tuned.not_applied, 'needs captain (#142)');
  assert.equal(metrics('guard.output', [low], tuned).violation_recall, 1);
});
test('D3 reports kth versus excluded gap and multi-entry recall', () => {
  const observed = row('loop.preselect', 'holdout', {
    item: { id: 'multi', scenario_id: 's', site: 'loop.preselect', state: {}, gold: { entry_0: true, entry_1: true, entry_2: false } },
    result: { status: 'ok', answers: { entry_0: { probability: .95, confidence: .9 }, entry_1: { probability: .51, confidence: .9 }, entry_2: { probability: .4, confidence: .9 } } },
  });
  const base = { ...productionThresholds('loop.preselect'), k: 2 };
  const best = metrics('loop.preselect', [observed], base);
  assert.equal(best.coverage, 1); assert.equal(best.needed_recall, 1); assert.equal(best.multi_entry_steps, 1);
  assert.equal(best.mean_kth_gap, .11); assert.equal(best.mean_best_gap, .55);
  assert.equal(metrics('loop.preselect', [observed], { ...base, margin_reference: 'kth_kept' }).coverage, 0);
});
test('D3 production allows absent confidence but tuning does not', () => {
  const observed = row('loop.preselect', 'tune', {
    item: { id: 'x', scenario_id: 's', site: 'loop.preselect', state: {}, gold: { entry_0: true, entry_1: false } },
    result: { status: 'ok', answers: { entry_0: { probability: .9 }, entry_1: { probability: .1 } } },
  });
  assert.equal(metrics('loop.preselect', [observed], { ...productionThresholds('loop.preselect'), k: 1 }).coverage, 1);
  assert.equal(metrics('loop.preselect', [observed], { ...productionThresholds('loop.preselect'), k: 1, allow_missing_confidence: false }).coverage, 0);
});
test('report is deterministic and excludes holdout from tuning', () => {
  const observed = row('guard.output', 'holdout');
  const call = { ...observed, type: 'call' as const, provider: 'fake', model: 'fake', site: 'guard.output', item_id: 'x', set_digest: 'abc', question_digest: 'def', call_id: 'one' };
  const metadata = { run_id: 'offline', node_version: 'v22.0.0', max_spend_usd: 2, set_digests: { 'guard.output': 'abc' } };
  const a = makeReport(metadata, [call]);
  assert.deepEqual(a, makeReport(metadata, [call])); assert.match(a.markdown, /no_tune_data/); assert.match(a.markdown, /0.001000/);
});
