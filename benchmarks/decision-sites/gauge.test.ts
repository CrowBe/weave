import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { compare, costed, evaluate, track, validate, type Context } from '@weave/gauge';
import { loadPreferenceSet } from '@weave/gateway';
import { SITES } from './questions.ts';
import { loadSets } from './sets.ts';
import { makeReport, type BoundCall } from './report.ts';
import { metrics, productionThresholds } from './tune.ts';
import type { Result } from './types.ts';
import { attemptRecords } from './weft.ts';
import { caseSetName, gaugeContext, reportCriteria, reported, scoreReport, type ScoredRow } from './gauge.ts';

const root = new URL('./', import.meta.url).pathname;
const sets = loadSets(join(root, 'sets'), SITES, 'all');
const context = gaugeContext(sets);
const holdout = (site: string) => sets.entries.filter((e) => e.item.site === site && e.split === 'holdout');

let ids = 0;
function call(site: string, n: number, provider: string, result: Result, extra: Partial<BoundCall> = {}): BoundCall {
  const entry = holdout(site)[n]!;
  return {
    type: 'call',
    provider,
    model: 'm',
    site,
    item_id: entry.item.id,
    set_digest: entry.set_digest,
    question_digest: 'q'.repeat(64),
    call_id: `c${(ids++).toString().padStart(4, '0')}`,
    split: 'holdout',
    item: entry.item,
    result,
    latency_ms: 100 + n,
    cost_usd: n * 1.1e-7,
    terminal: true,
    ...extra,
  };
}
const answers = (site: string, n: number, confidence: number) =>
  Object.fromEntries(
    Object.entries(holdout(site)[n]!.item.gold).map(([key, gold]) => [
      key,
      typeof gold === 'boolean'
        ? { probability: gold ? 0.8 : 0.35, confidence }
        : { choice: gold, confidence, probabilities: { [gold]: 1 } },
    ]),
  );
/** The journal records the observations came from, for the Weft projection: only dispatched calls are attempts. */
const journalOf = (calls: readonly BoundCall[]) =>
  calls.filter((c) => c.result.reason !== 'unacknowledged_call').map(({ item: _item, ...r }) => r);

function scoreAll(calls: readonly BoundCall[], providers: readonly string[], sites: readonly string[]) {
  const report = makeReport(
    { run_id: 'unit', node_version: 'v22', max_spend_usd: 2, set_digests: {}, providers, sites },
    calls,
  );
  const scored = scoreReport({
    run_id: 'unit',
    rows: report.summary,
    observations: calls,
    attempts: attemptRecords('unit', journalOf(calls)),
    context,
  });
  return { report, scored };
}
const rowsOf = (scored: readonly ScoredRow[], label: string) => scored.filter((s) => s.label === label);

test('the scoring rule is one info-only criteria set per site, bound to its frozen cases by a governed revision', () => {
  for (const site of SITES) {
    const name = reportCriteria(site),
      cases = caseSetName(site);
    for (const record of [
      context.criteria[name],
      context.casesets[cases],
      context.revisions[name],
      context.revisions[cases],
    ]) {
      assert.deepEqual(validate(record, context), { ok: true }, site);
    }
    assert.equal((context.criteria[name] as { schema: string }).schema, 'gauge.criteria@2');
    assert.deepEqual(
      (context.casesets[cases] as { splits: unknown }).splits,
      (['tune', 'holdout'] as const).map((split) => ({
        split,
        digest: `sha256:${sets.digests[`${site}/${split}`]}`,
        size: sets.entries.filter((e) => e.item.site === site && e.split === split).length,
      })),
    );
  }
});

test('an empty population reproduces the report: attempted 0, coverage 0, accuracy null', () => {
  const { report, scored } = scoreAll([], ['typesafe-jev', 'pi'], SITES);
  for (const site of SITES) {
    const expected = metrics(site, [], productionThresholds(site, 'typesafe-jev'));
    for (const s of scored.filter((x) => x.site === site && x.label !== 'probability_only')) {
      assert.deepEqual(reported(s.result), expected, `${site} ${s.label}`);
      assert.ok(s.result.measures.every((m) => m.n === 0));
    }
  }
  assert.equal(report.summary.competitors.length, SITES.length);
});

test('calls that never reached a provider are scored as the report scores them', () => {
  const site = 'guard.input';
  const ok = (n: number, extra: Partial<BoundCall> = {}) =>
    call(
      site,
      n,
      'typesafe-jev',
      { status: 'ok', model: 'm', answers: answers(site, n, 0.95), input_tokens: 400 + n, output_tokens: 3 },
      extra,
    );
  const calls = [
    ok(0),
    ok(1),
    ok(2, { latency_ms: 999 }),
    // No usage reported: zero tokens, as the report sums them.
    call(site, 3, 'typesafe-jev', { status: 'ok', model: 'm', answers: answers(site, 3, 0.5) }),
    // An unacknowledged call: a failed observation with zero latency, and no Weft attempt.
    call(site, 4, 'typesafe-jev', { status: 'failed', reason: 'unacknowledged_call' }, { latency_ms: 0, cost_usd: 0 }),
    // A provider-level skip of a decision provider stays in its denominators, but is no attempt.
    call(site, 5, 'amos-small', { status: 'skipped', reason: 'no_credential' }, { latency_ms: 7, cost_usd: 0 }),
    call(site, 6, 'amos-small', { status: 'failed', reason: 'timeout', parse_failure: true }),
    call(site, 1, 'pi', {
      status: 'ok',
      answers: answers(site, 1, 0.7),
      input_tokens: 9,
      output_tokens: 9,
      parse_failure: false,
    }),
    call(site, 2, 'pi', { status: 'skipped', reason: 'quota_unavailable_or_weekly_cap' }),
  ];
  assert.equal(attemptRecords('unit', journalOf(calls)).length, 6);
  const { report, scored } = scoreAll(calls, ['typesafe-jev', 'amos-small', 'pi'], [site]);
  const expected = [
    ...report.summary.decision_providers.flatMap((r) => [r.holdout, r.production]),
    ...report.summary.competitors.map((r) => r.holdout),
  ];
  const got = [...scored.filter((s) => s.label === 'tuned' || s.label === 'production'), ...rowsOf(scored, 'ungated')];
  assert.deepEqual(
    got.map((s) => reported(s.result)),
    expected,
  );
  const jev = report.summary.decision_providers.find((r) => r.provider === 'typesafe-jev')!.holdout;
  assert.deepEqual([jev.attempted, jev.failures, jev.latency_ms.p50, jev.input_tokens], [5, 1, 101, 1203]);
});

test("an observation outside its site's frozen holdout, or an edited criteria set, is refused rather than scored", () => {
  const site = 'loop.route';
  const good = call(site, 0, 'typesafe-jev', { status: 'ok', answers: answers(site, 0, 0.9) });
  assert.equal(scoreAll([good], ['typesafe-jev'], [site]).scored.length, 2);
  const tune = sets.entries.find((e) => e.item.site === site && e.split === 'tune')!;
  assert.throws(
    () => scoreAll([{ ...good, set_digest: tune.set_digest }], ['typesafe-jev'], [site]),
    /outside decision-sites\.loop\.route\.cases@1 holdout/,
  );
  const name = reportCriteria(site);
  const edited: Context = {
    ...context,
    criteria: { ...context.criteria, [name]: { ...(context.criteria[name] as object), measures: [] } },
  };
  const report = makeReport(
    {
      run_id: 'unit',
      node_version: 'v22',
      max_spend_usd: 2,
      set_digests: {},
      providers: ['typesafe-jev'],
      sites: [site],
    },
    [good],
  );
  assert.throws(
    () => scoreReport({ run_id: 'unit', rows: report.summary, observations: [good], attempts: [], context: edited }),
    /Gauge refused .*: binding/,
  );
});

test('no comparison, track, cost gate, gated evaluation or routing preference accepts a scored report row', () => {
  const site = 'loop.route';
  const calls = [0, 1, 2].flatMap((n) =>
    ['typesafe-jev', 'amos-small'].map((p) => call(site, n, p, { status: 'ok', answers: answers(site, n, 0.9) })),
  );
  const { scored } = scoreAll(calls, ['typesafe-jev', 'amos-small'], [site]);
  const [a, b] = rowsOf(scored, 'tuned').map((s) => s.result);
  const ctx: Context = { ...context, results: { [a!.result]: a, [b!.result]: b } };
  const refusal = (out: { ok: boolean; reason?: string }) => (out.ok ? 'ok' : out.reason);
  assert.equal(
    refusal(compare({ comparison: 'cmp', experiment: null, baseline: a!.result, candidate: b!.result }, ctx)),
    'info_only',
  );
  assert.equal(refusal(track([a!.result, b!.result], ctx)), 'info_only');
  const comparison = {
    schema: 'gauge.comparison@1',
    comparison: 'cmp',
    experiment: null,
    baseline: a!.result,
    candidate: b!.result,
    deltas: [],
    verdict: 'insufficient_evidence',
  };
  const line = { basis: 'measured', micros: 0 };
  const costs = [a, b].map((r) => ({
    schema: 'gauge.cost@1',
    cost: `cost-${r!.result}`,
    result: r!.result,
    trials: 3,
    failed_trials: 0,
    trial: line,
    evaluation: line,
    review: line,
    total: line,
  }));
  assert.equal(refusal(costed(comparison, costs, ctx)), 'info_only');
  assert.equal(
    refusal(
      evaluate(
        {
          result: 'gated',
          subject: a!.subject,
          workload: `decision-sites.${site}`,
          criteria: reportCriteria(site),
          caseset: caseSetName(site),
          split: 'holdout',
          mode: 'replay',
          evidence: a!.evidence,
          samples: {},
        },
        ctx,
      ),
    ),
    'info_only',
  );
  // Copied verbatim into a routing preference set, a row has no bar verdict and no interval to offer, so neither Gauge nor the gateway loader reads it.
  const preference = {
    schema: 'gauge.preference@1',
    preference: 'decision-sites.routing@1',
    workload: `decision-sites.${site}`,
    criteria: reportCriteria(site),
    caseset: caseSetName(site),
    split: 'holdout',
    mode: 'replay',
    accept: 'accuracy',
    entries: [a, b].map((r) => ({
      routed_unit: r!.subject.ref,
      result: r!.result,
      verdict: r!.verdict,
      measures: r!.measures,
    })),
  };
  assert.equal(refusal(validate(preference, ctx)), 'envelope');
  assert.equal(loadPreferenceSet(preference).ok, false);
  // Relabelled as a bar verdict with intervals, the copy is still refused: Gauge's binding check is the gate, not the shape.
  const relabelled = {
    ...preference,
    entries: preference.entries.map((e) => ({
      ...e,
      verdict: 'meets_bar',
      measures: e.measures.map((m) => ({ ...m, interval: [0, 1] })),
    })),
  };
  assert.equal(refusal(validate(relabelled, ctx)), 'info_only');
});
