/** In-flight deadlines use only the injected clock and cancellable timer. */
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { it } from 'node:test';
import { createInferenceGateway, type EvaluationAdapter, type GenerationAdapter, type RoutedUnit, type Timer } from '@weave/gateway';

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

for (const operation of ['generate', 'evaluate'] as const) {
  for (const interruption of ['deadline', 'caller cancel'] as const) {
    it(`${operation} observes a late adapter rejection after ${interruption} without changing the interrupt outcome`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        let now = 0;
        let fire!: () => void;
        let observed: AbortSignal | undefined;
        let rejectLate!: () => void;
        let entered!: () => void;
        let calls = 0;
        const called = new Promise<void>(resolve => { entered = resolve; });
        const timer: Timer = {
          sleep(ms, signal) {
            return new Promise(resolve => {
              fire = () => { now += ms; resolve(); };
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        };
        const execute = (call: { signal: AbortSignal | undefined }): Promise<never> => {
          calls += 1;
          observed = call.signal;
          entered();
          return new Promise((_, reject) => {
            call.signal?.addEventListener('abort', () => {
              // Keep the provider pending until the interrupt has returned to
              // the caller, then simulate an adapter throwing during cleanup.
              rejectLate = () => reject(new Error('late adapter rejection'));
            }, { once: true });
          });
        };
        const evaluator: EvaluationAdapter = { id: 'waiting', evaluate: execute };
        const evaluationUnit: RoutedUnit = { ...unit, operation: 'evaluate', kind: 'boolean' };
        const gateway = createInferenceGateway({
          routes: operation === 'generate' ? [unit] : [evaluationUnit],
          adapters: [{ id: 'waiting', execute }], evaluators: [evaluator],
          clock: { now: () => now }, timer,
        });
        const caller = new AbortController();
        const common = {
          request_id: 'late-rejection', site: 'test', role: 'working' as const,
          terms: { quality: 'baseline' as const, destinations: ['test'], max_context_tokens: 10,
            deadline: 100, cost_ceiling: 0, max_attempts: 2, max_attempts_per_route: 1 },
        };
        const pending = operation === 'generate'
          ? gateway.generate({ ...common, kind: 'transform', input: { instructions: '', prompt: 'ok' } }, caller.signal)
          : gateway.evaluate({ ...common, kind: 'boolean', state: 'ok',
              questions: { ok: { type: 'boolean', instructions: 'Is this ok?' } } }, caller.signal);
        await called;
        assert.ok(observed);
        if (interruption === 'deadline') fire();
        else caller.abort();
        const outcome = await pending;
        assert.equal(observed.aborted, true);
        assert.equal(outcome.status, 'unaccepted');
        assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '',
          interruption === 'deadline' ? 'deadline_reached' : 'provider_failed');
        const snapshot = structuredClone(outcome);
        rejectLate();
        // Allow promise reactions and Node's unhandled-rejection reporting to
        // run before checking both the process event and the settled outcome.
        await setImmediate();
        assert.deepEqual(unhandled, []);
        assert.deepEqual(outcome, snapshot);
        assert.equal(calls, 1);
        assert.equal(outcome.attempts.length, 1);
        assert.deepEqual(outcome.attempts[0]?.disposition, { status: 'failed', failure: {
          code: interruption === 'deadline' ? 'timeout' : 'cancelled',
          message: interruption === 'deadline'
            ? 'provider attempt exceeded the request deadline' : 'provider attempt cancelled',
          retryable: false,
        } });
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });
  }
}
