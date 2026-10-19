import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import { createInferenceGateway, type GatewayConfig, type GenerationRequest, type QuotaSnapshot, type RoutedUnit, type Timer } from '@weave/gateway';

const unit: RoutedUnit = {
  routed_unit_id: 'strong.codex', tier: 'strong', quota_provider: 'codex',
  operation: 'generate', kind: 'transform', adapter: 'fake', model: 'fake',
  context_profile: 'none', context_profile_version: 1, prompt_template: 'none', prompt_template_version: 1,
  settings: { max_output_tokens: 1 }, destination: 'test', quality: 'high', context_limit_tokens: 100,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
};
const request: GenerationRequest = {
  request_id: 'budget', site: 'test', role: 'working', kind: 'transform', input: { instructions: '', prompt: 'work' },
  terms: { tier: 'strong', quality: 'high', destinations: ['test'], max_context_tokens: 10,
    deadline: 1_000_000, cost_ceiling: 0, max_attempts: 3 },
};
function snapshot(remaining: number, pace = 'on_pace', observed_at = 100) {
  return { observed_at, providers: [{ provider: 'codex', status: 'fresh', windows: [
    { id: 'seven_day', percentRemaining: remaining, resetsAt: 500_000, pace: { status: pace } },
  ] }] };
}
function fixture(data: QuotaSnapshot | undefined, routes = [unit]) {
  let calls = 0;
  const pauses: unknown[] = [];
  const config: GatewayConfig = {
    routes, clock: { now: () => 100 }, quota: { async read() { return data; } },
    async persist_pause(record: unknown) { pauses.push(record); },
    adapters: [{ id: 'fake', async execute() { calls++; return {
      status: 'completed' as const, text: 'ok', usage: { input_tokens: 0, output_tokens: 0 },
      finish_reason: 'stop', provider_response_id: undefined,
    }; } }],
  };
  return { gateway: createInferenceGateway(config), pauses, get calls() { return calls; } };
}
for (const [used, status] of [[79, 'accepted'], [80, 'blocked'], [95, 'blocked']] as const) {
  it(`whole-account weekly gate at ${used}% used`, async () => {
    const f = fixture(snapshot(100 - used));
    const outcome = await f.gateway.generate(request);
    assert.equal(outcome.status, status);
    assert.equal(f.calls, status === 'accepted' ? 1 : 0);
    if (outcome.status === 'blocked') {
      assert.equal(outcome.reason, 'weekly_budget_cap');
      assert.deepEqual(f.pauses, [{ type: 'loop.paused', policy: 'budget.policy@1', request_id: 'budget',
        site: 'test', reason: 'weekly_budget_cap', until: 500_000 }]);
    }
  });
}
for (const [name, data] of [['missing', undefined], ['stale', snapshot(90, 'on_pace', -60_001)],
  ['unknown pace', snapshot(90, 'unknown')]] as const) it(`${name} fails closed for strong`, async () => {
  const f = fixture(data);
  const outcome = await f.gateway.generate(request);
  assert.equal(outcome.status, 'blocked');
  assert.equal(f.calls, 0);
});
it('ahead downgrades strong to standard without relaxing quality', async () => {
  const standard = { ...unit, tier: 'standard' as const, routed_unit_id: 'standard.codex' };
  const f = fixture(snapshot(90, 'ahead'), [unit, standard]);
  const outcome = await f.gateway.generate(request);
  assert.equal(outcome.status, 'accepted');
  if (outcome.status === 'accepted') assert.equal(outcome.routed_unit_id, standard.routed_unit_id);
});
it('five-hour pressure prefers another provider and pauses when none remains', async () => {
  const data = snapshot(90);
  data.providers[0]!.windows.push({ id: 'five_hour', percentRemaining: 10, resetsAt: 1000, pace: { status: 'on_pace' } });
  const alternative = { ...unit, routed_unit_id: 'other', quota_provider: 'claude' };
  data.providers.push({ provider: 'claude', status: 'fresh', windows: [{ id: 'seven_day', percentRemaining: 90, resetsAt: 500_000, pace: { status: 'on_pace' } }] });
  const f = fixture(data, [unit, alternative]);
  const outcome = await f.gateway.generate(request);
  assert.equal(outcome.status, 'accepted');
  if (outcome.status === 'accepted') assert.equal(outcome.routed_unit_id, 'other');
  const alone = fixture(data);
  assert.equal((await alone.gateway.generate(request)).status, 'blocked');
  assert.equal(alone.calls, 0);
  assert.equal((alone.pauses[0] as { until: number }).until, 1000);
});

it('audit pauses on ahead pace instead of using an available standard route', async () => {
  const f = fixture(snapshot(90, 'ahead'), [unit, { ...unit, tier: 'standard', routed_unit_id: 'standard' }]);
  const outcome = await f.gateway.generate({ ...request, terms: { ...request.terms, audit: true } });
  assert.equal(outcome.status, 'blocked');
  if (outcome.status === 'blocked') assert.equal(outcome.reason, 'budget_pace_ahead');
  assert.equal(f.calls, 0);
});
it('downgrade still respects quality, destination, context and cost constraints', async () => {
  for (const changes of [{ quality: 'baseline' }, { destination: 'private' }, { context_limit_tokens: 1 },
    { price: { input_per_mtok: 1_000_000, output_per_mtok: 0 } }]) {
    const f = fixture(snapshot(90, 'ahead'), [unit, { ...unit, tier: 'standard', routed_unit_id: 'standard', ...changes } as RoutedUnit]);
    assert.equal((await f.gateway.generate(request)).status, 'blocked');
    assert.equal(f.calls, 0);
    assert.equal(f.pauses.length, 1);
  }
});
it('unknown quota allows flash within the cost ceiling, without waiving it', async () => {
  const flash = { ...unit, tier: 'flash' as const, price: { input_per_mtok: 1_000_000, output_per_mtok: 0 } };
  const f = fixture(undefined, [flash]);
  const low = { ...request, terms: { ...request.terms, tier: 'flash' as const } };
  assert.equal((await f.gateway.generate(low)).status, 'blocked');
  assert.equal(f.calls, 0);
  assert.equal((await f.gateway.generate({ ...low, terms: { ...low.terms, cost_ceiling: 10 } })).status, 'accepted');
});
it('checks quota again before a retry and persists pause before returning', async () => {
  let reads = 0, calls = 0, persisted = false;
  const gateway = createInferenceGateway({
    routes: [unit], clock: { now: () => 100 },
    quota: { async read() { return snapshot(++reads === 1 ? 21 : 20); } },
    async persist_pause() { await Promise.resolve(); persisted = true; },
    adapters: [{ id: 'fake', async execute() { calls++; return { status: 'failed',
      failure: { code: 'unavailable', message: 'unavailable', retryable: true } }; } }],
  });
  const outcome = await gateway.generate(request);
  assert.equal(outcome.status, 'blocked');
  if (outcome.status === 'blocked') assert.equal(outcome.reason, 'weekly_budget_cap');
  assert.equal(calls, 1);
  assert.equal(reads, 2);
  assert.equal(outcome.attempts.length, 1);
  assert.equal(outcome.paused?.until, 500_000);
  assert.equal(persisted, true);
});
it('evaluation dispatch shares the weekly cap and unknown decision-tier cost ceiling', async () => {
  let calls = 0;
  let data: ReturnType<typeof snapshot> | undefined = snapshot(20);
  const gateway = createInferenceGateway({
    routes: [{ ...unit, operation: 'evaluate', kind: 'boolean', tier: 'decision' }],
    clock: { now: () => 100 }, quota: { async read() { return data; } },
    evaluators: [{ id: 'fake', async evaluate() { calls++; return { status: 'completed',
      answers: { q: { type: 'boolean', probability: 1 } }, usage: { input_tokens: 0, output_tokens: 0 },
      provider_response_id: undefined, confidence: undefined }; } }],
  });
  const evaluation = { request_id: 'eval', site: 'test', role: 'working', kind: 'boolean', state: 'work',
    questions: { q: { type: 'boolean', instructions: 'pass?' } }, terms: { ...request.terms, tier: 'decision' } } as const;
  const capped = await gateway.evaluate(evaluation);
  assert.equal(capped.status, 'blocked');
  if (capped.status === 'blocked') assert.equal(capped.reason, 'weekly_budget_cap');
  assert.equal(calls, 0);
  data = undefined;
  assert.equal((await gateway.evaluate(evaluation)).status, 'accepted');
});
it('quota acquisition failure is sanitized and fails closed for strong', async () => {
  const gateway = createInferenceGateway({ routes: [unit], clock: { now: () => 100 },
    quota: { async read() { throw new Error('secret-canary'); } },
    adapters: [{ id: 'fake', async execute() { throw new Error('must not dispatch'); } }],
  });
  const outcome = await gateway.generate(request);
  assert.equal(outcome.status, 'blocked');
  assert.equal(JSON.stringify(outcome).includes('secret-canary'), false);
});
it('cancellation and deadline expiry during snapshot acquisition prevent dispatch', async () => {
  for (const cancel of [true, false]) {
    let now = 100, calls = 0;
    const controller = new AbortController();
    const gateway = createInferenceGateway({ routes: [unit], clock: { now: () => now },
      quota: { async read() { if (cancel) controller.abort(); else now = request.terms.deadline; return snapshot(90); } },
      adapters: [{ id: 'fake', async execute() { calls++; throw new Error('must not dispatch'); } }],
    });
    await gateway.generate(request, controller.signal);
    assert.equal(calls, 0);
  }
});
it('a reset timestamp alone never releases a known weekly cap', async () => {
  const data = snapshot(20);
  data.providers[0]!.windows[0]!.resetsAt = 99;
  const f = fixture(data);
  const outcome = await f.gateway.generate(request);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.paused?.until, null);
  assert.equal(f.calls, 0);
});
it('weekly caps apply to every unit drawing on the same account', async () => {
  const f = fixture(snapshot(20), [unit, { ...unit, routed_unit_id: 'second-model', model: 'other' }]);
  assert.equal((await f.gateway.generate(request)).status, 'blocked');
  assert.equal(f.calls, 0);
});
it('ambiguous provider or weekly windows retain every known cap veto for flash', async () => {
  for (const duplicateProvider of [true, false]) {
    const data = snapshot(90);
    if (duplicateProvider) data.providers.push(snapshot(5).providers[0]!);
    else data.providers[0]!.windows.push(snapshot(5).providers[0]!.windows[0]!);
    const f = fixture(data, [{ ...unit, tier: 'flash' }]);
    const outcome = await f.gateway.generate({ ...request, terms: { ...request.terms, tier: 'flash' } });
    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'weekly_budget_cap');
    assert.equal(f.calls, 0);
  }
});
it('known five-hour pressure with unknown reset pauses for a new observation', async () => {
  const data = snapshot(90);
  data.providers[0]!.windows.push({ id: 'five_hour', percentRemaining: 10, resetsAt: NaN, pace: { status: 'on_pace' } });
  const f = fixture(data);
  const outcome = await f.gateway.generate(request);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.paused?.until, null);
  assert.equal(f.calls, 0);
});
it('a deadline passing during the first quota read blocks with deadline_passed before any attempt (#79)', async () => {
  let now = 100, calls = 0;
  const gateway = createInferenceGateway({ routes: [unit], clock: { now: () => now },
    quota: { async read() { now = request.terms.deadline; return snapshot(90); } },
    adapters: [{ id: 'fake', async execute() { calls++; throw new Error('must not dispatch'); } }],
  });
  const outcome = await gateway.generate(request);
  assert.equal(outcome.status, 'blocked');
  if (outcome.status === 'blocked') assert.equal(outcome.reason, 'deadline_passed');
  assert.deepEqual(outcome.attempts, []);
  assert.equal(outcome.spent, 0);
  assert.equal(calls, 0);
});
it('a deadline passing during the quota recheck after an attempt is deadline_reached (#79)', async () => {
  let now = 100, reads = 0, calls = 0;
  const gateway = createInferenceGateway({ routes: [unit], clock: { now: () => now },
    quota: { async read() { if (++reads === 2) now = request.terms.deadline; return snapshot(90); } },
    adapters: [{ id: 'fake', async execute() { calls++; return { status: 'failed',
      failure: { code: 'unavailable', message: 'unavailable', retryable: true } }; } }],
  });
  const outcome = await gateway.generate(request);
  assert.equal(outcome.status, 'unaccepted');
  if (outcome.status === 'unaccepted') assert.equal(outcome.reason, 'deadline_reached');
  assert.equal(outcome.attempts.length, 1);
  assert.equal(calls, 1);
  assert.equal(reads, 2);
});

/** Settles with the outcome, or 'hung' when the gateway is still waiting. */
async function settles<T>(pending: Promise<T>): Promise<T | 'hung'> {
  return Promise.race([pending, delay(1_000).then(() => 'hung' as const)]);
}
const hangingRead = { read: () => new Promise<QuotaSnapshot | undefined>(() => {}) };
it('cancellation during a slow quota read ends the request without waiting for the read (#75)', async () => {
  for (const prior of [false, true]) {
    let reads = 0, calls = 0;
    const controller = new AbortController();
    const gateway = createInferenceGateway({ routes: [unit], clock: { now: () => 100 },
      quota: { read() { if (++reads === 1 && prior) return Promise.resolve(snapshot(90)); queueMicrotask(() => controller.abort()); return hangingRead.read(); } },
      adapters: [{ id: 'fake', async execute() { calls++; return { status: 'failed',
        failure: { code: 'unavailable', message: 'unavailable', retryable: true } }; } }],
    });
    const outcome = await settles(gateway.generate(request, controller.signal));
    assert.notEqual(outcome, 'hung');
    if (outcome === 'hung') return;
    assert.equal(outcome.status, 'unaccepted');
    if (outcome.status === 'unaccepted') assert.equal(outcome.reason, 'provider_failed');
    assert.equal(outcome.attempts.length, prior ? 1 : 0);
    assert.equal(calls, prior ? 1 : 0);
  }
});
it('the request deadline bounds a slow quota read when a timer is configured (#75)', async () => {
  for (const prior of [false, true]) {
    let now = 100, reads = 0, calls = 0, armed = false;
    // Sleeps advance the clock only once the slow read has started, so the
    // first attempt's own deadline watcher stays parked until it settles.
    const timer: Timer = { sleep(ms, signal) {
      if (armed) { now += ms; return Promise.resolve(); }
      return new Promise(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    } };
    const gateway = createInferenceGateway({ routes: [unit], clock: { now: () => now }, timer,
      quota: { read() { if (++reads === 1 && prior) return Promise.resolve(snapshot(90)); armed = true; return hangingRead.read(); } },
      adapters: [{ id: 'fake', async execute() { calls++; return { status: 'failed',
        failure: { code: 'unavailable', message: 'unavailable', retryable: true } }; } }],
    });
    const outcome = await settles(gateway.generate(request));
    assert.notEqual(outcome, 'hung');
    if (outcome === 'hung') return;
    assert.deepEqual([outcome.status, 'reason' in outcome ? outcome.reason : null],
      prior ? ['unaccepted', 'deadline_reached'] : ['blocked', 'deadline_passed']);
    assert.equal(outcome.attempts.length, prior ? 1 : 0);
    assert.equal(calls, prior ? 1 : 0);
    assert.equal(now, request.terms.deadline);
  }
});
it('a budget pause after a failed attempt is blocked yet carries that attempt and its spend (#73)', async () => {
  const priced = { ...unit, price: { input_per_mtok: 1_000_000, output_per_mtok: 1_000_000 } };
  let reads = 0;
  const gateway = createInferenceGateway({
    routes: [priced], clock: { now: () => 100 },
    quota: { async read() { return snapshot(++reads === 1 ? 21 : 20); } },
    async persist_pause() {},
    adapters: [{ id: 'fake', async execute() { return { status: 'failed', usage: { input_tokens: 5, output_tokens: 1 },
      failure: { code: 'unavailable', message: 'unavailable', retryable: true } }; } }],
  });
  const outcome = await gateway.generate({ ...request, terms: { ...request.terms, cost_ceiling: 100 } });
  assert.equal(outcome.status, 'blocked');
  if (outcome.status === 'blocked') assert.equal(outcome.reason, 'weekly_budget_cap');
  assert.equal(outcome.attempts.length, 1);
  assert.equal(outcome.attempts[0]?.cost, 6);
  assert.equal(outcome.spent, 6);
  assert.equal(outcome.paused?.reason, 'weekly_budget_cap');
});
it('a failed pause write rejects the call instead of returning an outcome, and dispatches nothing (#74)', async () => {
  let calls = 0;
  const failure = new Error('pause store unavailable');
  const gateway = createInferenceGateway({ routes: [unit], clock: { now: () => 100 },
    quota: { async read() { return snapshot(20); } },
    async persist_pause() { throw failure; },
    adapters: [{ id: 'fake', async execute() { calls++; throw new Error('must not dispatch'); } }],
  });
  await assert.rejects(gateway.generate(request), error => error === failure);
  assert.equal(calls, 0);
});
it('freshness is measured from the provider observation, not the snapshot time (#76)', async () => {
  // The snapshot was produced now (100); the provider's reading may be older.
  for (const [observed, status] of [[100 - 60_000, 'accepted'], [100 - 60_001, 'blocked'], [101, 'blocked']] as const) {
    const base = snapshot(90);
    const data: QuotaSnapshot = { ...base, providers: [{ ...base.providers[0]!, observed_at: observed }] };
    const f = fixture(data);
    const outcome = await f.gateway.generate(request);
    assert.equal(outcome.status, status, String(observed));
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'quota_unknown');
  }
});
