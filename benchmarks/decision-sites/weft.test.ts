import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { validateRecord } from '@weave/weft';
import { Journal, type JournalRecord } from './journal.ts';
import { attemptRecords } from './weft.ts';

const binding = {
  provider: 'typesafe-jev',
  model: 'jev-1.14.0',
  site: 'loop.route',
  item_id: 'route-1',
  set_digest: 'a'.repeat(64),
  question_digest: 'b'.repeat(64),
};
const call = (call_id: string, result: JournalRecord, extra: JournalRecord = {}): JournalRecord => ({
  type: 'call',
  ...binding,
  split: 'holdout',
  call_id,
  result,
  terminal: true,
  latency_ms: 42,
  cost_usd: 20.58e-6,
  ...extra,
});
const ok = {
  status: 'ok',
  model: 'jev-1.14.0',
  answers: { decision: { choice: 'flash', confidence: 0.9 } },
  input_tokens: 490,
  output_tokens: 62,
};

test('a completed call is one inference.attempt carrying only what the journal recorded', () => {
  const records = [
    { type: 'run', run_id: 'r1' },
    { type: 'intent', ...binding, call_id: 'c1', projected_usd: 1e-4 },
    call('c1', ok),
  ];
  const [attempt, ...rest] = attemptRecords('r1', records);
  assert.equal(rest.length, 0);
  assert.deepEqual(validateRecord(attempt), { ok: true });
  assert.deepEqual(attempt, {
    schema: 'weft.record@1',
    trace_id: 'r1',
    record_id: 'c1',
    emitter: { kind: 'external', id: 'decision-sites' },
    sequence: 2,
    kind: 'inference.attempt',
    thread_id: null,
    parent_id: null,
    links: [],
    evidence: [],
    fields: {
      request_ref: 'b'.repeat(64),
      routed_unit: 'typesafe-jev',
      attempt_no: 1,
      disposition: 'accepted',
      input_tokens: 490,
      output_tokens: 62,
      latency_ms: 42,
    },
  });
  // Journal cost is fractional micro-USD; spent_micros is a count, so it is left out rather than rounded.
  assert.equal(Object.hasOwn(attempt!.fields, 'spent_micros'), false);
});

test('a retry numbers its attempt and links the attempt it repeats', () => {
  const limited = { status: 'failed', http_status: 429, retry_after_ms: 10 };
  const attempts = attemptRecords('r1', [call('c1', limited, { terminal: false }), call('c2', ok)]);
  assert.deepEqual(
    attempts.map((a) => [a.record_id, a.fields.attempt_no, a.fields.disposition, a.links]),
    [
      ['c1', 1, 'failed', []],
      ['c2', 2, 'accepted', [{ rel: 'retry_of', record_id: 'c1' }]],
    ],
  );
  const other = attemptRecords('r1', [call('c1', ok), call('c3', ok, { provider: 'amos-small', model: 'amos-1-2b' })]);
  assert.deepEqual(
    other.map((a) => [a.fields.routed_unit, a.fields.attempt_no]),
    [
      ['typesafe-jev', 1],
      ['amos-small', 1],
    ],
  );
});

test('records that never reached a provider project nothing', () => {
  const records = [
    { type: 'run', run_id: 'r1' },
    { type: 'intent', ...binding, call_id: 'c0', projected_usd: 1e-4 },
    call('c1', { status: 'skipped', reason: 'no_credential' }, { cost_usd: 0 }),
    call('c2', { status: 'failed', reason: 'cancelled' }, { terminal: false, cost_usd: 0 }),
    call('c3', { status: 'failed', reason: 'not_sent' }, { terminal: false, cost_usd: 0 }),
    { type: 'provider_status', provider: 'pi', result: { status: 'skipped', reason: 'auth_required' } },
    { type: 'uncertain', ...binding, reason: 'unacknowledged_call_no_automatic_retry' },
    { type: 'budget_stop', spent_usd: 1, projected_usd: 1, ceiling_usd: 1 },
    { type: 'cancelled' },
  ];
  assert.deepEqual(attemptRecords('r1', records), []);
  const failed = attemptRecords('r1', [
    ...records,
    call('c4', { status: 'failed', reason: 'cancelled_after_dispatch' }),
  ]);
  assert.deepEqual(
    failed.map((a) => [a.record_id, a.fields.attempt_no, a.fields.disposition]),
    [['c4', 1, 'failed']],
  );
});

test('a call Weft cannot hold fails closed instead of being dropped or repaired', () => {
  assert.throws(() => attemptRecords('r1', [call('c1', { ...ok, input_tokens: 1.5 })]), /Invalid Weft record: field/);
  assert.throws(() => attemptRecords('sk-live-0123456789abcdefghij', [call('c1', ok)]), /Invalid Weft record: id/);
});

test('every dispatched call of the recorded run is a valid attempt with its tokens and latency', () => {
  const records = new Journal(
    join(new URL('./', import.meta.url).pathname, 'results', 'live-20261015', 'journal.jsonl'),
    true,
  ).read();
  const attempts = attemptRecords('live-20261015', records);
  const dispatched = records.filter((r) => r.type === 'call' && r.result.status !== 'skipped');
  assert.ok(dispatched.length > 800);
  assert.deepEqual(
    attempts.map((a) => a.record_id),
    dispatched.map((r) => r.call_id),
  );
  const byId = new Map(dispatched.map((r) => [r.call_id, r] as const));
  for (const a of attempts) {
    assert.deepEqual(validateRecord(a), { ok: true });
    const r = byId.get(a.record_id)!;
    assert.equal(a.fields.request_ref, r.question_digest);
    assert.equal(a.fields.routed_unit, r.provider);
    assert.deepEqual(
      [a.fields.input_tokens, a.fields.output_tokens, a.fields.latency_ms],
      [r.result.input_tokens, r.result.output_tokens, r.latency_ms],
    );
  }
});
