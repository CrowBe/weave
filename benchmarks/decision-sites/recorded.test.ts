/**
 * The recorded run `live-20261015`, scored again from its journal without any
 * provider call, journal write or clock. Its committed summary and report are
 * the reference: re-rendering reproduces them, and Gauge, reading the run's
 * calls as Weft records and score@2 as info-only criteria sets, reproduces
 * every number of every report row (G4, #192).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '@weave/gauge';
import { Journal, type JournalRecord } from './journal.ts';
import { SITES } from './questions.ts';
import { loadSets } from './sets.ts';
import { buildProviders } from './providers.ts';
import { buildCompetitors } from './competitors.ts';
import { bindObservations } from './observations.ts';
import { makeReport } from './report.ts';
import type { Metrics } from './tune.ts';
import { attemptRecords } from './weft.ts';
import {
  PROBABILITY_SITES,
  gaugeContext,
  reported,
  reportedProbabilityOnly,
  scoreReport,
  type ScoredRow,
} from './gauge.ts';

const root = new URL('./', import.meta.url).pathname;
const RUN = 'live-20261015';
const dir = join(root, 'results', RUN);
const journalPath = join(dir, 'journal.jsonl');
/** The README's render-only provider set for this run. */
const PROVIDERS = ['typesafe-jev', 'amos-small', 'openai-decisions', 'pi', 'fx-ask'];

const recordedSummary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
const recordedMarkdown = readFileSync(join(dir, 'REPORT.md'), 'utf8');
const journalBytes = readFileSync(journalPath);
const sets = loadSets(join(root, 'sets'), SITES, 'all');
// Constructing providers makes no call; rendering reads only their ids, models and serializers.
const providers = [
  ...buildProviders({ now: () => 0, sleep: async () => {} }),
  ...buildCompetitors({
    run: async () => {
      throw new Error('unexpected dispatch');
    },
    cwd: root,
    quotaAllowed: true,
  }),
].filter((p) => PROVIDERS.includes(p.id));
const context = gaugeContext(sets);

/** What run.ts renders for a journal in render-only mode, plus Gauge's scoring of the same observations. */
async function score(records: readonly JournalRecord[]) {
  const { bound, statuses } = await bindObservations(records, providers, sets.entries, true);
  const calls = records.filter((r) => r.type === 'call');
  const spent = new Journal(journalPath, true).spent();
  const report = makeReport(
    {
      run_id: RUN,
      node_version: recordedSummary.node_version,
      max_spend_usd: 2,
      set_digests: sets.digests,
      providers: PROVIDERS,
      sites: [...SITES],
      statuses,
      spent_usd: spent,
      input_tokens: calls.reduce((sum, r) => sum + (r.result.input_tokens ?? 0), 0),
      output_tokens: calls.reduce((sum, r) => sum + (r.result.output_tokens ?? 0), 0),
    },
    bound,
  );
  const scored = scoreReport({
    run_id: RUN,
    rows: report.summary,
    observations: bound,
    attempts: attemptRecords(RUN, records),
    context,
  });
  return { bound, report, scored };
}

type Row = {
  site: string;
  provider: string;
  holdout: Metrics;
  production: Metrics;
  holdout_items: number;
  probability_only?: Record<string, unknown>;
};
/** Every report row Gauge must reproduce, in the order scoreReport returns them. */
function reportRows(summary: { decision_providers: Row[]; competitors: Row[] }) {
  return [
    ...summary.decision_providers.flatMap((r) => [
      { site: r.site, provider: r.provider, label: 'tuned', metrics: r.holdout },
      { site: r.site, provider: r.provider, label: 'production', metrics: r.production },
    ]),
    ...summary.competitors.map((r) => ({ site: r.site, provider: r.provider, label: 'ungated', metrics: r.holdout })),
  ];
}

/** Gauge reproduces every number of a summary, row by row. */
function assertParity(summary: { decision_providers: Row[]; competitors: Row[] }, scored: readonly ScoredRow[]) {
  const rows = reportRows(summary);
  const metricRows = scored.filter((s) => s.label !== 'probability_only');
  assert.deepEqual(
    metricRows.map((s) => [s.site, s.provider, s.label]),
    rows.map((r) => [r.site, r.provider, r.label]),
  );
  for (const [i, row] of rows.entries()) {
    const label = `${row.site} ${row.provider} ${row.label}`;
    assert.deepEqual(reported(metricRows[i]!.result), row.metrics, label);
  }
  for (const r of summary.decision_providers) {
    const tuned = metricRows.find((s) => s.site === r.site && s.provider === r.provider && s.label === 'tuned')!;
    assert.equal(reported(tuned.result).attempted, r.holdout_items, `${r.site} ${r.provider} holdout n`);
    const diagnostic = scored.find(
      (s) => s.site === r.site && s.provider === r.provider && s.label === 'probability_only',
    );
    assert.equal(diagnostic !== undefined, PROBABILITY_SITES.includes(r.site));
    if (diagnostic) {
      const { label: _label, block_probability: _block, ...numbers } = r.probability_only!;
      assert.deepEqual(reportedProbabilityOnly(diagnostic.result), numbers, `${r.site} ${r.provider} probability-only`);
    }
  }
}

const original = await score(new Journal(journalPath, true).read());

test('re-rendering the recorded journal reproduces the committed summary and report', () => {
  assert.equal(original.bound.length, 851);
  const { metered_call_cost_usd: _metered, reserved_usd: _reserved, ...rendered } = recordedSummary;
  assert.deepEqual(original.report.summary, rendered);
  const spent = new Journal(journalPath, true).spent();
  assert.equal(
    `${original.report.markdown}\n\nLedger spend (including pending reservations): $${spent.toFixed(8)}\n`,
    recordedMarkdown,
  );
});

test('Gauge reproduces every number of every row of the recorded report exactly', () => {
  // 27 decision rows each scored under tuned and production thresholds, 18 competitor rows,
  // and the probability-only diagnostics of the 9 guard and D5 rows.
  assert.equal(original.scored.length, 27 * 2 + 18 + 9);
  assertParity(recordedSummary, original.scored);
  for (const { result } of original.scored) {
    assert.deepEqual(validate(result, context), { ok: true }, result.result);
    assert.equal(result.schema, 'gauge.result@2');
    assert.equal(result.verdict, 'info_only');
    assert.equal(result.mode, 'replay');
    assert.equal(result.split, 'holdout');
    assert.deepEqual(result.evidence, [{ source: 'held_out_report', ref: RUN }]);
  }
  // The headline is measured, not reproduced from empty results.
  const headline = original.scored.find(
    (s) => s.site === 'intake.classify' && s.provider === 'typesafe-jev' && s.label === 'tuned',
  )!;
  assert.deepEqual(
    ['attempted', 'input_tokens'].map((m) => headline.result.measures.find((x) => x.measure === m)!.n),
    [60, 60],
  );
});

test('every number in a report row is a Gauge measure', () => {
  const metrics: Metrics = recordedSummary.decision_providers[0].holdout;
  const tuned = original.scored[0]!.result;
  assert.deepEqual(Object.keys(reported(tuned)).sort(), Object.keys(metrics).sort());
  // Latency's two quantiles are each a measure.
  assert.equal(tuned.measures.length, Object.keys(metrics).length + 1);
});

test('an empty population is coverage 0 and accuracy null, as the report prints it', () => {
  const empty = original.scored.filter((s) => s.label === 'ungated' && reported(s.result).attempted === 0);
  assert.equal(empty.length, 18, 'pi and fx-ask were skipped before any holdout call');
  for (const { result } of empty) {
    assert.ok(result.measures.every((m) => m.n === 0));
    const m = reported(result);
    assert.deepEqual(
      [m.coverage, m.accuracy, m.confidence_coverage, m.parse_failure_rate, m.cost_usd, m.latency_ms.p50],
      [0, null, 0, 0, 0, null],
    );
  }
});

test('scoring the same run again gives identical numbers, with no call and no journal write', async () => {
  const again = await score(new Journal(journalPath, true).read());
  assert.deepEqual(again.scored, original.scored);
  assert.deepEqual(readFileSync(journalPath), journalBytes);
});

test('two concurrent scorings of the same run share no state', async () => {
  const records = new Journal(journalPath, true).read();
  const frozen = <T>(x: T): T => {
    if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
      Object.freeze(x);
      Object.values(x).forEach(frozen);
    }
    return x;
  };
  frozen(records);
  const [a, b] = await Promise.all([score(records), score(records)]);
  assert.deepEqual(a.scored, b.scored);
  assert.deepEqual(a.scored, original.scored);
  (a.scored[0]!.result.measures[0] as { value: number | null }).value = -1;
  assert.notEqual(b.scored[0]!.result.measures[0]!.value, -1);
});

test('a torn final line, read-only or repaired, does not change a number', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wv039-torn-'));
  try {
    const path = join(tmp, 'journal.jsonl');
    copyFileSync(journalPath, path);
    appendFileSync(path, '{"type":"call","provider":"typesafe-jev","site":"loop.route","resu');
    const torn = readFileSync(path);
    const readOnly = await score(new Journal(path, true).read());
    assert.deepEqual(readFileSync(path), torn, 'a read-only journal stays byte for byte');
    assert.deepEqual(readOnly.scored, original.scored);
    const repaired = await score(new Journal(path).read());
    assert.deepEqual(readFileSync(path), journalBytes, 'a writable journal truncates only the torn tail');
    assert.deepEqual(repaired.scored, original.scored);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a crash between an intent and its receipt is scored as the report scores it', async () => {
  // Drop the last holdout receipt: its reservation stays and the item is an unacknowledged failure, never an answer.
  const records = new Journal(journalPath, true).read();
  const last = records
    .map((r) => r.type === 'call' && r.split === 'holdout' && r.provider === 'typesafe-jev')
    .lastIndexOf(true);
  const crashed = records.filter((_, i) => i !== last);
  const tmp = mkdtempSync(join(tmpdir(), 'wv039-crash-'));
  try {
    writeFileSync(join(tmp, 'journal.jsonl'), crashed.map((r) => JSON.stringify(r) + '\n').join(''));
    const { report, scored } = await score(new Journal(join(tmp, 'journal.jsonl'), true).read());
    const site = records[last]!.site as string;
    const row = (summary: { decision_providers: Row[] }) =>
      summary.decision_providers.find((r) => r.site === site && r.provider === 'typesafe-jev')!;
    assert.equal(row(report.summary).holdout.failures, row(recordedSummary).holdout.failures + 1);
    assertParity(report.summary as never, scored);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
