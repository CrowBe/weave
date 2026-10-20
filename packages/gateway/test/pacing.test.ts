/** #175: a rate limit marked `pace` spaces requests before they are sent. */
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { it } from 'node:test';
import {
  createInferenceGateway, parseRouteConfig,
  type GenerationAdapter, type GenerationRequest, type RateLimit, type RoutedUnit, type Timer,
} from '@weave/gateway';
import { readFileSync } from 'node:fs';

const unit = (rate_limits: readonly RateLimit[], id = 'paced'): RoutedUnit => ({
  routed_unit_id: id, operation: 'generate', kind: 'transform',
  context_profile: 'test', context_profile_version: 1, prompt_template: 'test', prompt_template_version: 1,
  adapter: 'fake', model: 'fake', settings: { max_output_tokens: 10 }, destination: 'test',
  quality: 'baseline', context_limit_tokens: 100, price: { input_per_mtok: 0, output_per_mtok: 0 }, rate_limits,
});
const request = (id: string, deadline = 100_000): GenerationRequest => ({
  request_id: id, site: 'test', role: 'working', kind: 'transform', input: { instructions: '', prompt: 'ok' },
  terms: { quality: 'baseline', destinations: ['test'], max_context_tokens: 10, deadline, cost_ceiling: 0, max_attempts: 2 },
});

/** A clock the test moves, and sleeps that wake only when it passes their target. */
function manualTime() {
  let now = 0;
  const sleepers = new Set<{ at: number; wake: () => void }>();
  const timer: Timer = { sleep(ms, signal) {
    return new Promise(resolve => {
      const sleeper = { at: now + ms, wake: () => { sleepers.delete(sleeper); resolve(); } };
      sleepers.add(sleeper);
      if (signal?.aborted) sleeper.wake();
      else signal?.addEventListener('abort', sleeper.wake, { once: true });
    });
  } };
  return {
    clock: { now: () => now }, timer,
    async advance(to: number) {
      now = to;
      for (const sleeper of [...sleepers]) if (sleeper.at <= now) sleeper.wake();
      for (let i = 0; i < 5; i++) await setImmediate();
    },
  };
}

function recording(usage = { input_tokens: 5, output_tokens: 5 }, now: () => number) {
  const sent: number[] = [];
  const adapter: GenerationAdapter = { id: 'fake', async execute() {
    sent.push(now());
    return { status: 'completed', text: 'ok', usage, finish_reason: 'stop', provider_response_id: undefined };
  } };
  return { adapter, sent };
}

it('a paced request limit holds concurrent callers until the window has room', async () => {
  const time = manualTime();
  const provider = recording(undefined, time.clock.now);
  const gateway = createInferenceGateway({ routes: [unit([{ requests: 2, window_ms: 1_000, pace: true }])],
    adapters: [provider.adapter], clock: time.clock, timer: time.timer });
  const outcomes = ['a', 'b', 'c'].map(id => gateway.generate(request(id)));
  await time.advance(0);
  assert.deepEqual(provider.sent, [0, 0]);
  await time.advance(999);
  assert.deepEqual(provider.sent, [0, 0]);
  await time.advance(1_000);
  assert.deepEqual(provider.sent, [0, 0, 1_000]);
  const third = await outcomes[2]!;
  assert.equal(third.status, 'accepted');
  assert.equal(third.attempts[0]?.waited_ms, 1_000);
  assert.deepEqual((await Promise.all(outcomes)).map(o => o.status), ['accepted', 'accepted', 'accepted']);
});

it('a paced token budget reserves the worst case, then counts reported usage', async () => {
  // Worst case is max_context_tokens 10 + max_output_tokens 10 = 20; each call reports 10.
  const time = manualTime();
  const provider = recording({ input_tokens: 5, output_tokens: 5 }, time.clock.now);
  const gateway = createInferenceGateway({ routes: [unit([{ requests: 100, tokens: 50, window_ms: 1_000, pace: true }])],
    adapters: [provider.adapter], clock: time.clock, timer: time.timer });
  for (const id of ['a', 'b', 'c', 'd']) assert.equal((await gateway.generate(request(id))).status, 'accepted');
  assert.deepEqual(provider.sent, [0, 0, 0, 0]);
  // 40 reported + 20 reserved exceeds 50 until the first call leaves the window.
  const fifth = gateway.generate(request('e'));
  await time.advance(0);
  assert.equal(provider.sent.length, 4);
  await time.advance(1_000);
  assert.deepEqual(provider.sent, [0, 0, 0, 0, 1_000]);
  assert.equal((await fifth).status, 'accepted');
});

it('pacing never suppresses an attempt: without a timer, past the deadline, or beyond the budget it sends at once', async () => {
  const limit = { requests: 1, window_ms: 1_000, pace: true } as const;
  const cases = [
    { name: 'no timer', limits: [limit], timer: false, deadline: 100_000 },
    { name: 'deadline', limits: [limit], timer: true, deadline: 500 },
    { name: 'budget', limits: [{ requests: 10, tokens: 15, window_ms: 1_000, pace: true }], timer: true, deadline: 100_000 },
  ] as const;
  for (const c of cases) {
    const time = manualTime();
    const provider = recording(undefined, time.clock.now);
    const gateway = createInferenceGateway({ routes: [unit(c.limits)], adapters: [provider.adapter], clock: time.clock,
      ...(c.timer ? { timer: time.timer } : {}) });
    const first = await gateway.generate(request('a', c.deadline));
    const second = await gateway.generate(request('b', c.deadline));
    assert.deepEqual(provider.sent, [0, 0], c.name);
    assert.deepEqual([first.status, second.status], ['accepted', 'accepted'], c.name);
    assert.ok(second.uncertainty.some(note => note.startsWith('paced: pacing')), c.name);
  }
});

it('a declared limit without pace still never delays a request', async () => {
  const time = manualTime();
  const provider = recording(undefined, time.clock.now);
  const gateway = createInferenceGateway({ routes: [unit([{ requests: 1, tokens: 1, window_ms: 1_000 }])],
    adapters: [provider.adapter], clock: time.clock, timer: time.timer });
  const outcomes = await Promise.all(['a', 'b', 'c'].map(id => gateway.generate(request(id))));
  assert.deepEqual(provider.sent, [0, 0, 0]);
  assert.deepEqual(outcomes.map(o => o.uncertainty.some(note => note.includes('pacing'))), [false, false, false]);
});

it('a pacing wait is cancellable, spends no attempt, and the budget gate runs again after it', async () => {
  const time = manualTime();
  const provider = recording(undefined, time.clock.now);
  let reads = 0;
  const gateway = createInferenceGateway({ routes: [unit([{ requests: 1, window_ms: 1_000, pace: true }])],
    adapters: [provider.adapter], clock: time.clock, timer: time.timer,
    quota: { async read() { reads++; return undefined; } } });
  assert.equal((await gateway.generate(request('a'))).status, 'accepted');
  const controller = new AbortController();
  const cancelled = gateway.generate(request('b'), controller.signal);
  const waiting = gateway.generate(request('c'));
  await time.advance(0);
  controller.abort();
  const outcome = await cancelled;
  assert.equal(outcome.status, 'unaccepted');
  if (outcome.status === 'unaccepted') assert.equal(outcome.reason, 'provider_failed');
  assert.deepEqual(outcome.attempts, []);
  const before = reads;
  await time.advance(1_000);
  assert.equal((await waiting).status, 'accepted');
  assert.deepEqual(provider.sent, [0, 1_000]);
  assert.ok(reads > before, 'quota is read again after the wait');
});

it('route config accepts pace as a boolean only, and the Muse Spark units opt in', () => {
  const example = () => JSON.parse(readFileSync(new URL('../../../../weave.routes.example.json', import.meta.url), 'utf8'));
  for (const [pace, ok] of [[true, true], [false, true], ['true', false], [1, false]] as const) {
    const input = example();
    input.units[0].rate_limits = [{ requests: 150, window_ms: 60_000, pace }];
    assert.equal(parseRouteConfig(input).ok, ok, String(pace));
  }
  const parsed = parseRouteConfig(example());
  assert.ok(parsed.ok);
  for (const muse of parsed.table.filter(u => u.adapter === 'muse-spark')) {
    assert.deepEqual(muse.rate_limits, [{ requests: 150, tokens: 3_000_000, window_ms: 60_000, pace: true }]);
  }
});
