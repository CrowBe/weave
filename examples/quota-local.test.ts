import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuotaPort, normalizeQuotaSnapshot } from './quota-local.ts';
import { localBudgetGate } from './quota-local.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const at = '2026-10-14T00:00:00.000Z';
const snapshot = { generatedAt: at, providers: [{ provider: 'claude', status: 'fresh', windows: [{ id: 'seven_day', percentRemaining: 21, resetsAt: '2026-10-15T00:00:00.000Z', pace: { status: 'ahead' } }] }] };

test('quota normalization preserves account totals and source timestamps', () => {
  assert.deepEqual(normalizeQuotaSnapshot(snapshot), { observed_at: Date.parse(at), providers: [{ provider: 'claude', status: 'fresh', windows: [{ id: 'seven_day', percentRemaining: 21, resetsAt: Date.parse('2026-10-15T00:00:00.000Z'), pace: { status: 'ahead' } }] }] });
  assert.equal(normalizeQuotaSnapshot({ ...snapshot, generatedAt: 'unknown' }), undefined);
  assert.equal(normalizeQuotaSnapshot({ ...snapshot, providers: [...snapshot.providers, ...snapshot.providers] }), undefined);
});

test('quota normalization keeps incomplete evidence unknown and stale status intact', () => {
  const result = normalizeQuotaSnapshot({ generatedAt: at, providers: [{ provider: 'codex', status: 'stale', windows: [{ id: 'seven_day', percentRemaining: 101, resetsAt: 'unknown' }] }] });
  assert.deepEqual(result?.providers[0], { provider: 'codex', status: 'stale', windows: [{ id: 'seven_day', percentRemaining: null, resetsAt: null }] });
});

test('a reused source cannot become fresh merely through a new report timestamp', () => {
  const result = normalizeQuotaSnapshot({ ...snapshot, providers: [{ ...snapshot.providers[0], state: { reused: true, refreshedAt: '2026-10-13T00:00:00.000Z' } }] });
  assert.equal(result?.providers[0]?.status, 'stale');
});

test('composition root persists pause evidence outside gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weave-quota-'));
  try {
    const path = join(dir, 'state', 'paused.jsonl');
    const gate = localBudgetGate({ pausePath: path });
    const record = { type: 'loop.paused', policy: 'budget.policy@1', request_id: 'req', site: 'example', reason: 'weekly_budget_cap', until: 123 } as const;
    await gate.persist_pause(record);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quota reads deduplicate, cache sixty seconds, and fail closed without diagnostics', async () => {
  let now = 0;
  let calls = 0;
  const port = createQuotaPort({ now: () => now, run: async () => { calls++; if (calls === 2) throw new Error('secret diagnostic'); return JSON.stringify(snapshot); } });
  const [a, b] = await Promise.all([port.read(), port.read()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  now = 59_999;
  assert.deepEqual(await port.read(), a);
  now = 60_000;
  assert.equal(await port.read(), undefined);
  assert.equal(calls, 2);
  now = 60_001;
  assert.equal(await port.read(), undefined);
  now = 120_000;
  assert.deepEqual(await port.read(), a);
  assert.equal(calls, 3);
});
