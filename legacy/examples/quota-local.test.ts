import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuotaPort, normalizeQuotaSnapshot } from './quota-local.ts';
import { budgetRoute, type RoutedUnit } from '@weave/gateway';
import { localBudgetGate } from './quota-local.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const at = '2026-10-14T00:00:00.000Z';
// quota-axi schemaVersion 5 shape: provider freshness lives under `state` (see the #78 fixtures below).
const fresh = { status: 'fresh', stale: false };
const snapshot = {
  generatedAt: at,
  providers: [
    {
      provider: 'claude',
      state: fresh,
      windows: [
        { id: 'seven_day', percentRemaining: 21, resetsAt: '2026-10-15T00:00:00.000Z', pace: { status: 'ahead' } },
      ],
    },
  ],
};

test('quota normalization preserves account totals and source timestamps', () => {
  assert.deepEqual(normalizeQuotaSnapshot(snapshot), {
    observed_at: Date.parse(at),
    providers: [
      {
        provider: 'claude',
        status: 'fresh',
        windows: [
          {
            id: 'seven_day',
            percentRemaining: 21,
            resetsAt: Date.parse('2026-10-15T00:00:00.000Z'),
            pace: { status: 'ahead' },
          },
        ],
      },
    ],
  });
  assert.equal(normalizeQuotaSnapshot({ ...snapshot, generatedAt: 'unknown' }), undefined);
  assert.equal(normalizeQuotaSnapshot({ providers: [] }), undefined);
  assert.equal(normalizeQuotaSnapshot({ generatedAt: at }), undefined);
  const duplicate = {
    ...snapshot.providers[0],
    windows: [{ ...snapshot.providers[0]!.windows[0], percentRemaining: 20 }],
  };
  const ambiguous = normalizeQuotaSnapshot({ ...snapshot, providers: [...snapshot.providers, duplicate] });
  assert.equal(ambiguous?.providers.length, 2);
  assert.equal(ambiguous?.providers[1]?.windows[0]?.percentRemaining, 20);
});

const strong: RoutedUnit = {
  routed_unit_id: 'strong',
  tier: 'strong',
  billing: 'subscription',
  quota_provider: 'claude',
  operation: 'generate',
  kind: 'transform',
  adapter: 'fake',
  model: 'fake',
  context_profile: 'none',
  context_profile_version: 1,
  prompt_template: 'none',
  prompt_template_version: 1,
  settings: { max_output_tokens: 1 },
  destination: 'test',
  quality: 'high',
  context_limit_tokens: 100,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
};
function routeSnapshot(data: unknown, provider = 'claude', now = Date.parse(at), tier: 'strong' | 'flash' = 'strong') {
  return budgetRoute(
    [{ ...strong, tier, quota_provider: provider }],
    { operation: 'generate', kind: 'transform', tier },
    {
      tier,
      quality: 'high',
      destinations: ['test'],
      max_context_tokens: 10,
      deadline: now + 1000,
      cost_ceiling: 0,
      max_attempts: 1,
    },
    0,
    undefined,
    normalizeQuotaSnapshot(data),
    now,
  );
}

test('quota normalization keeps named malformed entries and leaves healthy providers unaffected', () => {
  const healthy = snapshot.providers[0]!;
  for (const malformed of [null, { provider: '' }, { provider: '   ' }, { provider: 7 }]) {
    assert.deepEqual(
      normalizeQuotaSnapshot({ generatedAt: at, providers: [malformed, healthy] }),
      normalizeQuotaSnapshot(snapshot),
    );
  }
  for (const windows of [undefined, {}, [], [null, {}]]) {
    const data = { generatedAt: at, providers: [{ provider: 'grok', state: fresh, windows }, healthy] };
    const result = normalizeQuotaSnapshot(data)!;
    assert.equal(result.providers.length, 2);
    assert.deepEqual(result.providers[0], { provider: 'grok', status: 'unknown', windows: [] });
    assert.deepEqual(result.providers[1], normalizeQuotaSnapshot(snapshot)!.providers[0]);
    assert.equal(routeSnapshot(data, 'grok').pause?.reason, 'quota_unknown');
  }
});

test('duplicate provider with malformed evidence fails closed for strong routes', () => {
  for (const windows of [undefined, [null], [{}]]) {
    const data = {
      generatedAt: at,
      providers: [
        { provider: 'claude', windows },
        {
          ...snapshot.providers[0],
          windows: [{ ...snapshot.providers[0]!.windows[0], percentRemaining: 50, pace: { status: 'on_pace' } }],
        },
      ],
    };
    const decision = routeSnapshot(data);
    assert.equal(decision.order.length, 0);
    assert.equal(decision.pause?.reason, 'quota_unknown');
  }
});

test('malformed windows make fresh evidence unknown while parsed weekly caps still veto', () => {
  for (const remaining of [50, 20, 10]) {
    const data = {
      generatedAt: at,
      providers: [
        {
          ...snapshot.providers[0],
          windows: [
            { id: 7, percentRemaining: 3 },
            { ...snapshot.providers[0]!.windows[0], percentRemaining: remaining, pace: { status: 'on_pace' } },
          ],
        },
      ],
    };
    const provider = normalizeQuotaSnapshot(data)!.providers[0]!;
    assert.equal(provider.status, 'unknown');
    assert.equal(provider.windows[0]?.percentRemaining, remaining);
    assert.equal(routeSnapshot(data).pause?.reason, remaining <= 20 ? 'weekly_budget_cap' : 'quota_unknown');
  }
});

test('a healthy second provider retains its weekly cap veto', () => {
  const data = {
    generatedAt: at,
    providers: [
      { provider: 'grok', windows: [{}] },
      { ...snapshot.providers[0], windows: [{ ...snapshot.providers[0]!.windows[0], percentRemaining: 10 }] },
    ],
  };
  assert.equal(routeSnapshot(data).order.length, 0);
  assert.equal(routeSnapshot(data).pause?.reason, 'weekly_budget_cap');
});

test('quota normalization keeps incomplete window evidence unknown', () => {
  const window = { id: 'seven_day', percentRemaining: 101, resetsAt: 'unknown' };
  const result = normalizeQuotaSnapshot({
    generatedAt: at,
    providers: [{ provider: 'codex', state: fresh, windows: [window] }],
  });
  assert.deepEqual(result?.providers[0], {
    provider: 'codex',
    status: 'unknown',
    windows: [{ id: 'seven_day', percentRemaining: null, resetsAt: null }],
  });
  // #92: a status quota-axi already reports as not fresh is kept, not hidden by
  // `unknown`; the malformed fields stay visible as nulls.
  const stale = normalizeQuotaSnapshot({
    generatedAt: at,
    providers: [{ provider: 'codex', state: { status: 'stale', stale: true }, windows: [window] }],
  });
  assert.deepEqual(stale?.providers[0], {
    provider: 'codex',
    status: 'stale',
    windows: [{ id: 'seven_day', percentRemaining: null, resetsAt: null }],
  });
  for (const state of [undefined, {}, { status: 7 }]) {
    assert.equal(
      normalizeQuotaSnapshot({ ...snapshot, providers: [{ ...snapshot.providers[0], state }] })?.providers[0]?.status,
      'unknown',
    );
  }
  // `stale: true` beside a `fresh` status is not fresh.
  assert.equal(
    normalizeQuotaSnapshot({
      ...snapshot,
      providers: [{ ...snapshot.providers[0], state: { status: 'fresh', stale: true } }],
    })?.providers[0]?.status,
    'stale',
  );
});

test('a reused source cannot become fresh merely through a new report timestamp', () => {
  const refreshedAt = '2026-10-13T00:00:00.000Z';
  const data = {
    ...snapshot,
    providers: [{ ...snapshot.providers[0], state: { ...fresh, reused: true, refreshedAt } }],
  };
  assert.equal(normalizeQuotaSnapshot(data)?.providers[0]?.observed_at, Date.parse(refreshedAt));
  assert.equal(routeSnapshot(data).pause?.reason, 'quota_unknown');
  // A reused reading whose refresh time is unknown or after the report is stale.
  for (const bad of [undefined, 'unknown', '2026-10-14T00:00:01.000Z']) {
    const state = { ...fresh, reused: true, ...(bad === undefined ? {} : { refreshedAt: bad }) };
    assert.equal(
      normalizeQuotaSnapshot({ ...snapshot, providers: [{ ...snapshot.providers[0], state }] })?.providers[0]?.status,
      'stale',
    );
  }
});

test('freshness is measured from when a reused reading was taken, not from generatedAt (#76)', () => {
  const generated = Date.parse(at);
  const healthy = {
    ...snapshot.providers[0],
    windows: [{ ...snapshot.providers[0]!.windows[0], percentRemaining: 90, pace: { status: 'on_pace' } }],
  };
  const reused = {
    ...snapshot,
    providers: [
      { ...healthy, state: { ...fresh, reused: true, refreshedAt: new Date(generated - 59_000).toISOString() } },
    ],
  };
  const provider = normalizeQuotaSnapshot(reused)!.providers[0]!;
  assert.deepEqual([provider.status, provider.observed_at], ['fresh', generated - 59_000]);
  assert.equal(routeSnapshot(reused, 'claude', generated).order.length, 1);
  // Two seconds later the reading is 61s old, although the report is only 2s old.
  assert.equal(routeSnapshot(reused, 'claude', generated + 2_000).pause?.reason, 'quota_unknown');
  assert.equal(routeSnapshot({ ...snapshot, providers: [healthy] }, 'claude', generated + 2_000).order.length, 1);
});

test('only windows the policy reads decide whether a provider is known (#92)', () => {
  const generated = Date.parse(at);
  const weekly = { ...snapshot.providers[0]!.windows[0], percentRemaining: 90, pace: { status: 'on_pace' } };
  const known = (windows: unknown[], state: unknown = fresh) => {
    const data = { ...snapshot, providers: [{ provider: 'claude', state, windows: [weekly, ...windows] }] };
    return {
      status: normalizeQuotaSnapshot(data)!.providers[0]!.status,
      order: routeSnapshot(data, 'claude', generated).order.length,
    };
  };
  // Schema-valid secondary windows may omit optional fields: a workspace credit
  // cap without a reset, a used-share without its own remaining percentage, a
  // model window, a Codex code-review window.
  assert.deepEqual(
    known([
      { id: 'spend_control', kind: 'credits', percentRemaining: 40 },
      { id: 'month_code', kind: 'monthly', shareOf: 'month_total', percentUsed: 10 },
      { id: 'model:fable', kind: 'model', percentRemaining: 71 },
      { id: 'code_review_weekly', kind: 'weekly', percentRemaining: 50, resetsAt: '2026-10-20T00:00:00.000Z' },
    ]),
    { status: 'fresh', order: 1 },
  );
  // A five-hour window is read by the policy, so it must be complete.
  assert.deepEqual(known([{ id: 'five_hour', kind: 'session', percentRemaining: 50 }]), {
    status: 'unknown',
    order: 0,
  });
  assert.deepEqual(known([{ id: 'five_hour', kind: 'session', resetsAt: '2026-10-14T04:00:00.000Z' }]), {
    status: 'unknown',
    order: 0,
  });
  // A value that contradicts the published schema fails closed wherever it is.
  for (const bad of [
    { id: 'model:x', percentRemaining: 'many' },
    { id: 'model:x', resetsAt: 'soon' },
    { id: 'model:x', pace: {} },
  ]) {
    assert.deepEqual(known([bad]), { status: 'unknown', order: 0 });
  }
  // Reused and malformed together keep both: unknown status, old observation time.
  const refreshedAt = new Date(generated - 120_000).toISOString();
  const data = {
    ...snapshot,
    providers: [{ provider: 'claude', state: { ...fresh, reused: true, refreshedAt }, windows: [weekly, { id: 7 }] }],
  };
  const both = normalizeQuotaSnapshot(data)!.providers[0]!;
  assert.deepEqual([both.status, both.observed_at], ['unknown', generated - 120_000]);
});

test('composition root persists pause evidence outside gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weave-quota-'));
  try {
    const path = join(dir, 'state', 'paused.jsonl');
    const gate = localBudgetGate({ pausePath: path });
    const record = {
      type: 'loop.paused',
      policy: 'budget.policy@1',
      request_id: 'req',
      site: 'example',
      reason: 'weekly_budget_cap',
      until: 123,
    } as const;
    await gate.persist_pause(record);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('quota reads deduplicate, cache sixty seconds, and fail closed without diagnostics', async () => {
  let now = 0;
  let calls = 0;
  const port = createQuotaPort({
    now: () => now,
    run: async () => {
      calls++;
      if (calls === 2) throw new Error('secret diagnostic');
      return JSON.stringify(snapshot);
    },
  });
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

// ---------------------------------------------------------------------------
// #78 contract: real quota-axi `--json` output, schemaVersion 5.
//
// codex-capture-2026-10-15.json is the verbatim `quota-axi --provider codex
// --json` capture recorded during the P10 live run (committed in 536d400 as
// benchmarks/decision-sites/test/fixtures/quota-codex-sample.json), with the
// account `plan` redacted. It holds no credential, email or account id;
// `codex-home` is quota-axi's fixed lane key for the native Codex login.
// claude-readme-0.1.64.json is the documented `--provider claude --json`
// example from the quota-axi 0.1.64 README (npm tarball sha1
// 3fcfcd7db214233d151b6ca5e6526c7a577dd1fe): documentation, not a capture.
// ---------------------------------------------------------------------------
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/quota-axi/${name}`, import.meta.url), 'utf8'));
const codexCapture = fixture('codex-capture-2026-10-15.json');
const claudeDocumented = fixture('claude-readme-0.1.64.json');
/** quota-axi 0.1.64 `PROVIDER_IDS` and `QuotaPaceStatus` (dist/src/types.d.ts). */
const QUOTA_AXI_PROVIDER_IDS = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'grok',
  'kimi',
  'zai',
  'agy',
  'alibaba',
  'opencode-go',
  'commandcode',
  'minimax',
  'mimo',
  'deepseek',
  'openrouter',
  'elevenlabs',
  'devin',
  'muse',
  'higgsfield',
];
const QUOTA_AXI_PACE_STATUSES = ['ahead', 'on_pace', 'behind', 'unknown'];

test('quota-axi output carries the fields the budget gate reads (#78)', () => {
  for (const [data, provider, weekly] of [
    [codexCapture, 'codex', 'weekly'],
    [claudeDocumented, 'claude', 'seven_day'],
  ] as const) {
    assert.equal(data.schemaVersion, 5);
    assert.equal(Number.isFinite(Date.parse(data.generatedAt)), true);
    const row = data.providers.find((p: { provider: string }) => p.provider === provider);
    // Freshness lives under `state`; there is no top-level provider status.
    assert.deepEqual([row.state.status, row.state.stale, Object.hasOwn(row, 'status')], ['fresh', false, false]);
    for (const id of ['five_hour', weekly]) {
      const window = row.windows.find((w: { id: string }) => w.id === id);
      assert.equal(typeof window.percentRemaining, 'number', id);
      assert.equal(Number.isFinite(Date.parse(window.resetsAt)), true, id);
      assert.ok(QUOTA_AXI_PACE_STATUSES.includes(window.pace.status), id);
    }
    assert.equal(row.windows.find((w: { id: string }) => w.id === weekly).kind, 'weekly');
  }
  // Every pace value the gate accepts is one quota-axi documents.
  for (const pace of ['ahead', 'on_pace', 'behind']) assert.ok(QUOTA_AXI_PACE_STATUSES.includes(pace));
  const example = JSON.parse(readFileSync(new URL('../weave.routes.example.json', import.meta.url), 'utf8'));
  const providers = [...new Set(example.units.flatMap((u: { quota_provider?: string }) => u.quota_provider ?? []))];
  assert.deepEqual(providers.sort(), ['claude', 'codex', 'grok']);
  for (const id of providers) assert.ok(QUOTA_AXI_PROVIDER_IDS.includes(id as string), String(id));
});

test('the codex capture normalizes to a fresh weekly observation the gate can apply (#78)', () => {
  const observed = Date.parse(codexCapture.generatedAt);
  const normalized = normalizeQuotaSnapshot(codexCapture)!;
  assert.equal(normalized.observed_at, observed);
  const codex = normalized.providers[0]!;
  assert.equal(codex.status, 'fresh');
  assert.deepEqual(
    codex.windows.find((w) => w.id === 'seven_day'),
    {
      id: 'seven_day',
      percentRemaining: 100,
      resetsAt: Date.parse('2026-10-22T06:14:00.000Z'),
      pace: { status: 'on_pace' },
    },
  );
  assert.deepEqual(
    codex.windows.find((w) => w.id === 'five_hour'),
    {
      id: 'five_hour',
      percentRemaining: 98,
      resetsAt: Date.parse('2026-10-15T11:14:00.000Z'),
      pace: { status: 'ahead' },
    },
  );
  const strongDecision = routeSnapshot(codexCapture, 'codex', observed);
  assert.equal(strongDecision.order.length, 1);
  assert.equal(strongDecision.pause, undefined);
  // The weekly cap applies to the real window, for flash too.
  const capped = structuredClone(codexCapture);
  capped.providers[0].windows.find((w: { id: string }) => w.id === 'weekly').percentRemaining = 20;
  assert.equal(routeSnapshot(capped, 'codex', observed).pause?.reason, 'weekly_budget_cap');
  assert.equal(routeSnapshot(capped, 'codex', observed, 'flash').pause?.reason, 'weekly_budget_cap');
  assert.equal(routeSnapshot(codexCapture, 'codex', observed + 60_001).pause?.reason, 'quota_unknown');
});

test('the documented claude example normalizes without its model window affecting the gate (#78)', () => {
  const observed = Date.parse(claudeDocumented.generatedAt);
  const claude = normalizeQuotaSnapshot(claudeDocumented)!.providers[0]!;
  assert.equal(claude.status, 'fresh');
  assert.deepEqual(
    claude.windows.map((w) => w.id),
    ['five_hour', 'seven_day', 'model:fable'],
  );
  const decision = routeSnapshot(claudeDocumented, 'claude', observed);
  assert.equal(decision.order.length, 0);
  assert.deepEqual(decision.pause, { reason: 'budget_pace_ahead', until: Date.parse('2026-03-20T17:59:45.600Z') });
});
