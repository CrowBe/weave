/**
 * The recorded run `live-20261015`, re-rendered from its journal without any
 * provider call, write or clock. Its committed summary and report are the
 * reference: rendering is a replay of recorded answers, so it reproduces them.
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
