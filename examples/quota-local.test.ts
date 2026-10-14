import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuotaPort, normalizeQuotaSnapshot } from './quota-local.ts';
import { budgetRoute, type RoutedUnit } from '@weave/gateway';
import { localBudgetGate } from './quota-local.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const at = '2026-10-14T00:00:00.000Z';
const snapshot = { generatedAt: at, providers: [{ provider: 'claude', status: 'fresh', windows: [{ id: 'seven_day', percentRemaining: 21, resetsAt: '2026-10-15T00:00:00.000Z', pace: { status: 'ahead' } }] }] };

test('quota normalization preserves account totals and source timestamps', () => {
  assert.deepEqual(normalizeQuotaSnapshot(snapshot), { observed_at: Date.parse(at), providers: [{ provider: 'claude', status: 'fresh', windows: [{ id: 'seven_day', percentRemaining: 21, resetsAt: Date.parse('2026-10-15T00:00:00.000Z'), pace: { status: 'ahead' } }] }] });
  assert.equal(normalizeQuotaSnapshot({ ...snapshot, generatedAt: 'unknown' }), undefined);
  assert.equal(normalizeQuotaSnapshot({ providers: [] }), undefined);
  assert.equal(normalizeQuotaSnapshot({ generatedAt: at }), undefined);
  const duplicate = { ...snapshot.providers[0], windows: [{ ...snapshot.providers[0]!.windows[0], percentRemaining: 20 }] };
  const ambiguous = normalizeQuotaSnapshot({ ...snapshot, providers: [...snapshot.providers, duplicate] });
  assert.equal(ambiguous?.providers.length, 2);
  assert.equal(ambiguous?.providers[1]?.windows[0]?.percentRemaining, 20);
});

const strong: RoutedUnit = {
  routed_unit_id: 'strong', tier: 'strong', quota_provider: 'claude',
  operation: 'generate', kind: 'transform', adapter: 'fake', model: 'fake',
  context_profile: 'none', context_profile_version: 1, prompt_template: 'none', prompt_template_version: 1,
  settings: { max_output_tokens: 1 }, destination: 'test', quality: 'high', context_limit_tokens: 100,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
};
function routeSnapshot(data: unknown, provider = 'claude') {
  return budgetRoute([{ ...strong, quota_provider: provider }], { operation: 'generate', kind: 'transform', tier: 'strong' },
    { tier: 'strong', quality: 'high', destinations: ['test'], max_context_tokens: 10,
      deadline: Date.parse(at) + 1000, cost_ceiling: 0, max_attempts: 1 },
    0, undefined, normalizeQuotaSnapshot(data), Date.parse(at));
}

test('quota normalization keeps named malformed entries and leaves healthy providers unaffected', () => {
  const healthy = snapshot.providers[0]!;
  for (const malformed of [null, { provider: '' }, { provider: '   ' }, { provider: 7 }]) {
    assert.deepEqual(normalizeQuotaSnapshot({ generatedAt: at, providers: [malformed, healthy] }), normalizeQuotaSnapshot(snapshot));
  }
  for (const windows of [undefined, {}, [], [null, {}]]) {
    const data = { generatedAt: at, providers: [{ provider: 'grok', status: 'fresh', windows }, healthy] };
    const result = normalizeQuotaSnapshot(data)!;
    assert.equal(result.providers.length, 2);
    assert.deepEqual(result.providers[0], { provider: 'grok', status: 'unknown', windows: [] });
    assert.deepEqual(result.providers[1], normalizeQuotaSnapshot(snapshot)!.providers[0]);
    assert.equal(routeSnapshot(data, 'grok').pause?.reason, 'quota_unknown');
  }
});

test('duplicate provider with malformed evidence fails closed for strong routes', () => {
  for (const windows of [undefined, [null], [{}]]) {
    const data = { generatedAt: at, providers: [{ provider: 'claude', windows },
      { ...snapshot.providers[0], windows: [{ ...snapshot.providers[0]!.windows[0], percentRemaining: 50, pace: { status: 'on_pace' } }] }] };
    const decision = routeSnapshot(data);
    assert.equal(decision.order.length, 0);
    assert.equal(decision.pause?.reason, 'quota_unknown');
  }
});

test('malformed windows make fresh evidence unknown while parsed weekly caps still veto', () => {
  for (const remaining of [50, 20, 10]) {
    const data = { generatedAt: at, providers: [{ ...snapshot.providers[0], windows: [
      { id: 7, percentRemaining: 3 },
      { ...snapshot.providers[0]!.windows[0], percentRemaining: remaining, pace: { status: 'on_pace' } },
    ] }] };
    const provider = normalizeQuotaSnapshot(data)!.providers[0]!;
    assert.equal(provider.status, 'unknown');
    assert.equal(provider.windows[0]?.percentRemaining, remaining);
    assert.equal(routeSnapshot(data).pause?.reason, remaining <= 20 ? 'weekly_budget_cap' : 'quota_unknown');
  }
});

test('a healthy second provider retains its weekly cap veto', () => {
  const data = { generatedAt: at, providers: [{ provider: 'grok', windows: [{}] },
    { ...snapshot.providers[0], windows: [{ ...snapshot.providers[0]!.windows[0], percentRemaining: 10 }] }] };
  assert.equal(routeSnapshot(data).order.length, 0);
  assert.equal(routeSnapshot(data).pause?.reason, 'weekly_budget_cap');
});

test('quota normalization keeps incomplete window evidence unknown', () => {
  const result = normalizeQuotaSnapshot({ generatedAt: at, providers: [{ provider: 'codex', status: 'stale', windows: [{ id: 'seven_day', percentRemaining: 101, resetsAt: 'unknown' }] }] });
  assert.deepEqual(result?.providers[0], { provider: 'codex', status: 'unknown', windows: [{ id: 'seven_day', percentRemaining: null, resetsAt: null }] });
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
