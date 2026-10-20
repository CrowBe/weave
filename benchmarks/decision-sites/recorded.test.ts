/**
 * The recorded run `live-20261015`, re-rendered from its journal without any
 * provider call, write or clock. Its committed summary and report are the
 * reference: rendering is a replay of recorded answers, so it reproduces them.
 * Gauge, reading the run as Weft records and the scoring rule as governed
 * criteria sets, reproduces every number those criteria measure (G4, #192).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, ledger } from './journal.ts';
import { SITES } from './questions.ts';
import { loadSets } from './sets.ts';
import { buildProviders } from './providers.ts';
import { buildCompetitors } from './competitors.ts';
import { bindObservations } from './observations.ts';
import { makeReport } from './report.ts';
import type { Metrics } from './tune.ts';
import { validate, type EvaluationResult } from '@weave/gauge';
import { attemptRecords } from './weft.ts';
import { DIAGNOSTICS, gaugeContext, scoreReport } from './gauge.ts';

const root = new URL('./', import.meta.url).pathname;
const RUN = 'live-20261015';
const dir = join(root, 'results', RUN);
/** The README's render-only provider set for this run, in run.ts's builder order. */
const PROVIDERS = ['typesafe-jev', 'amos-small', 'openai-decisions', 'pi', 'fx-ask'];

const records = new Journal(join(dir, 'journal.jsonl'), true).read();
const recordedSummary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
const recordedMarkdown = readFileSync(join(dir, 'REPORT.md'), 'utf8');
const { entries, digests } = loadSets(join(root, 'sets'), SITES, 'all');
// Constructing providers makes no call: rendering reads only their ids, models and serializers.
const providers = [
  ...buildProviders({ now: () => 0 }),
  ...buildCompetitors({ run: async () => { throw new Error('unexpected dispatch'); }, cwd: root, quotaAllowed: true }),
].filter(p => PROVIDERS.includes(p.id));
const { bound, statuses, complete } = await bindObservations(records, providers, entries, true);
const calls = records.filter(r => r.type === 'call');
const report = makeReport({
  run_id: RUN, node_version: recordedSummary.node_version, max_spend_usd: records.find(r => r.type === 'run')!.max_spend_usd,
  set_digests: digests, providers: PROVIDERS, sites: [...SITES], statuses, spent_usd: ledger(records).spent_usd,
  input_tokens: calls.reduce((sum, r) => sum + (r.result.input_tokens ?? 0), 0),
  output_tokens: calls.reduce((sum, r) => sum + (r.result.output_tokens ?? 0), 0),
}, bound);

test('the recorded run binds every entry it attempted, from legacy records, without dispatch', () => {
  assert.equal(complete, true);
  assert.equal(bound.length, 851);
  assert.ok(bound.every(r => r.type === 'call' && !Object.hasOwn(r, 'request_digest')));
});

test('re-rendering the recorded journal reproduces the committed summary number for number', () => {
  // run.ts appends the ledger split after rendering; this run predates observed/pending lines.
  const { metered_call_cost_usd, reserved_usd, ...rendered } = recordedSummary;
  assert.deepEqual(report.summary, rendered);
  assert.equal(calls.reduce((sum, r) => sum + r.cost_usd, 0), metered_call_cost_usd);
  assert.equal(ledger(records).reserved_usd, reserved_usd);
});

test('re-rendering the recorded journal reproduces the committed report line for line', () => {
  assert.equal(`${report.markdown}\n\nLedger spend (including pending reservations): $${ledger(records).spent_usd.toFixed(8)}\n`, recordedMarkdown);
});

const attempts = attemptRecords(RUN, records);
const context = gaugeContext({ entries, digests });
const scored = scoreReport({ run_id: RUN, rows: recordedSummary, observations: bound, attempts, context });
const D3 = 'loop.preselect';
const GUARDS = ['guard.input', 'guard.output'];

test('the scoring rule is one governed criteria set per site, bound to its frozen cases', () => {
  for (const site of SITES) {
    const criteria = `decision-sites.${site}.criteria@1`, caseset = `decision-sites.${site}.cases@1`;
    for (const record of [context.criteria[criteria], context.casesets[caseset], context.revisions[criteria], context.revisions[caseset]]) {
      assert.deepEqual(validate(record, context), { ok: true }, `${site}`);
    }
    assert.deepEqual((context.casesets[caseset] as { splits: unknown }).splits, ['tune', 'holdout'].map(split => ({
      split, digest: `sha256:${digests[`${site}/${split}`]}`, size: entries.filter(e => e.item.site === site && e.split === split).length,
    })));
    assert.deepEqual((context.criteria[criteria] as { measures: { measure: string }[] }).measures.map(m => m.measure), [
      'coverage', 'accuracy', ...(site === D3 ? ['exact_set_accuracy', 'needed_recall'] : []),
      ...(GUARDS.includes(site) ? ['violation_recall'] : []), 'brier', 'parse_failure_rate', 'input_tokens', 'output_tokens',
    ]);
  }
});

/** A report row's numbers as Gauge measured them. The report prints 0 where a count or rate has no samples; Gauge says n = 0. */
function reported(site: string, result: EvaluationResult): Partial<Metrics> {
  const entry = (name: string) => result.measures.find(m => m.measure === name)!;
  const value = (name: string) => entry(name).value;
  return {
    attempted: entry('coverage').n, covered: entry('accuracy').n, coverage: value('coverage') ?? 0, accuracy: value('accuracy'),
    // Outside D3, exact-set agreement is the accuracy rule itself, and the report prints it only for D3.
    exact_set_accuracy: site === D3 ? value('exact_set_accuracy') : value('accuracy'),
    needed_recall: site === D3 ? value('needed_recall') : null, all_needed_recall: site === D3 ? value('accuracy') : null,
    violation_recall: GUARDS.includes(site) ? value('violation_recall') : null,
    brier: value('brier'), calibration_n: entry('brier').n, parse_failure_rate: value('parse_failure_rate') ?? 0,
    input_tokens: value('input_tokens') ?? 0, output_tokens: value('output_tokens') ?? 0,
  };
}
const pick = (metrics: Metrics, keys: readonly string[]) => Object.fromEntries(keys.map(k => [k, metrics[k as keyof Metrics]]));

test('Gauge reproduces every number of the recorded report that its criteria measure', () => {
  const rows: [string, string, string, Metrics][] = [
    ...recordedSummary.decision_providers.flatMap((r: { site: string; provider: string; holdout: Metrics; production: Metrics }) =>
      [[r.site, r.provider, 'tuned', r.holdout], [r.site, r.provider, 'production', r.production]]),
    ...recordedSummary.competitors.map((r: { site: string; provider: string; holdout: Metrics }) => [r.site, r.provider, 'ungated', r.holdout]),
  ];
  assert.equal(rows.length, 9 * 3 * 2 + 9 * 2);
  assert.deepEqual(scored.map(s => [s.site, s.provider, s.thresholds]), rows.map(([site, provider, thresholds]) => [site, provider, thresholds]));
  for (const [i, [site, provider, thresholds, metrics]] of rows.entries()) {
    const { result } = scored[i]!;
    const label = `${site} ${provider} ${thresholds}`;
    assert.deepEqual(validate(result, context), { ok: true }, label);
    const expected = reported(site, result);
    assert.deepEqual(expected, pick(metrics, Object.keys(expected)), label);
    assert.equal(result.mode, 'replay');
    assert.equal(result.split, 'holdout');
    assert.deepEqual(result.evidence, [{ source: 'held_out_report', ref: RUN }]);
    // Non-gating: no constraint, so the verdict says only that no declared bar was missed.
    assert.deepEqual([result.constraints, result.verdict], [[], 'meets_bar']);
  }
  for (const r of recordedSummary.decision_providers) {
    assert.equal(r.holdout_items, scored.find(s => s.site === r.site && s.provider === r.provider)!.result.measures[0]!.n);
  }
  // The recorded run measured something: the headline is not reproduced from empty results.
  assert.equal(scored.find(s => s.site === 'intake.classify' && s.provider === 'typesafe-jev' && s.thresholds === 'tuned')!
    .result.measures.find(m => m.measure === 'input_tokens')!.n, 60);
});

test('every report number is a Gauge measure or a named benchmark diagnostic', () => {
  const metrics: Metrics = recordedSummary.decision_providers[0].holdout;
  const measured = Object.keys(reported(D3, scored.find(s => s.site === D3)!.result));
  assert.deepEqual([...measured, ...Object.keys(DIAGNOSTICS)].sort(), Object.keys(metrics).sort());
  assert.equal(measured.some(k => Object.hasOwn(DIAGNOSTICS, k)), false);
});

test('an edited criteria set or an observation outside its case set is refused, never scored', () => {
  const row = recordedSummary.decision_providers.find((r: { site: string }) => r.site === 'loop.route');
  const rows = { decision_providers: [row], competitors: [] };
  const name = 'decision-sites.loop.route.criteria@1';
  // Adding a bar in place changes the set's digest, so its @1 revision no longer records it.
  const edited = { ...context, criteria: { ...context.criteria, [name]: { ...(context.criteria[name] as object), constraints: [
    { constraint: 'accuracy_bar', measure: 'accuracy', op: 'ge', bound: 0.9, role: 'quality_bar' }] } } };
  assert.throws(() => scoreReport({ run_id: RUN, rows, observations: bound, attempts, context: edited }), /Gauge refused .*: binding/);
  const moved = bound.map(r => r.site === 'loop.route' && r.split === 'holdout' ? { ...r, set_digest: digests['loop.route/tune']! } : r);
  assert.throws(() => scoreReport({ run_id: RUN, rows, observations: moved, attempts, context }), /outside decision-sites.loop.route.cases@1 holdout/);
  assert.equal(scoreReport({ run_id: RUN, rows, observations: bound, attempts, context }).length, 2);
});
