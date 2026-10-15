/** In-flight deadlines use only the injected clock and cancellable timer. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createInferenceGateway, type GenerationAdapter, type RoutedUnit, type Timer } from '@weave/gateway';

const unit: RoutedUnit = {
  routed_unit_id: 'deadline.primary', operation: 'generate', kind: 'transform',
  context_profile: 'test', context_profile_version: 1, prompt_template: 'test', prompt_template_version: 1,
  adapter: 'waiting', model: 'waiting', settings: { max_output_tokens: 10 }, destination: 'test',
  quality: 'baseline', context_limit_tokens: 100, price: { input_per_mtok: 0, output_per_mtok: 0 },
};

it('aborts an in-flight provider at the injected deadline and records timeout without fallback', async () => {
  let now = 0;
  let fire: (() => void) | undefined;
  let observed: AbortSignal | undefined;
  let entered!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const timer: Timer = {
    sleep(ms, signal) {
      assert.equal(ms, 100);
      return new Promise(resolve => {
        fire = () => { now += ms; resolve(); };
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
  let calls = 0;
  const adapter: GenerationAdapter = {
    id: 'waiting',
    execute(call) {
      calls += 1;
      observed = call.signal;
      entered();
      return new Promise(resolve => {
        call.signal?.addEventListener('abort', () => resolve({ status: 'failed', failure: {
          code: 'cancelled', message: 'aborted', retryable: false,
        } }), { once: true });
      });
    },
  };
  const gateway = createInferenceGateway({ routes: [unit, { ...unit, routed_unit_id: 'deadline.fallback' }],
    adapters: [adapter], clock: { now: () => now }, timer });
  const pending = gateway.generate({ request_id: 'deadline', site: 'test', role: 'working', kind: 'transform',
    input: { instructions: '', prompt: 'ok' }, terms: { quality: 'baseline', destinations: ['test'],
      max_context_tokens: 10, deadline: 100, cost_ceiling: 0, max_attempts: 2, max_attempts_per_route: 1 } });
  await called;
  assert.ok(observed, 'the gateway must provide a deadline AbortSignal to the provider');
  fire?.();
  const outcome = await pending;
  assert.equal(observed.aborted, true);
  assert.equal(outcome.status, 'unaccepted');
  assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'deadline_reached');
  assert.equal(calls, 1);
  assert.equal(outcome.attempts.length, 1);
  assert.deepEqual(outcome.attempts[0]?.disposition, { status: 'failed', failure: {
    code: 'timeout', message: 'provider attempt exceeded the request deadline', retryable: false,
  } });
});
