/** In-flight deadlines use only the injected clock and cancellable timer. */
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { it } from 'node:test';
import {
  createInferenceGateway,
  type EvaluationAdapter,
  type GenerationAdapter,
  type RoutedUnit,
  type Timer,
} from '@weave/gateway';

const unit: RoutedUnit = {
  routed_unit_id: 'deadline.primary',
  operation: 'generate',
  kind: 'transform',
  context_profile: 'test',
  context_profile_version: 1,
  prompt_template: 'test',
  prompt_template_version: 1,
  adapter: 'waiting',
  model: 'waiting',
  settings: { max_output_tokens: 10 },
  destination: 'test',
  billing: 'metered',
  quality: 'baseline',
  context_limit_tokens: 100,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
};

for (const finish of ['provider settles', 'caller cancels'] as const) {
  it(`caps long deadline sleeps and ignores immediate early wakes until ${finish}`, async () => {
    const waits: number[] = [];
    let activeSleeps = 0;
    let observed: AbortSignal | undefined;
    let complete!: (result: Awaited<ReturnType<GenerationAdapter['execute']>>) => void;
    const timer: Timer = {
      async sleep(ms, signal) {
        waits.push(ms);
        if (waits.length <= 3) return; // Early wakes do not advance the clock.
        activeSleeps += 1;
        await new Promise<void>((resolve) => {
          const stop = () => {
            activeSleeps -= 1;
            resolve();
          };
          if (signal?.aborted) stop();
          else signal?.addEventListener('abort', stop, { once: true });
        });
      },
    };
    const adapter: GenerationAdapter = {
      id: 'waiting',
      execute(call) {
        observed = call.signal;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    };
    const gateway = createInferenceGateway({ routes: [unit], adapters: [adapter], clock: { now: () => 0 }, timer });
    const caller = new AbortController();
    const pending = gateway.generate(
      {
        request_id: 'long-deadline',
        site: 'test',
        role: 'working',
        kind: 'transform',
        input: { instructions: '', prompt: 'ok' },
        terms: {
          quality: 'baseline',
          destinations: ['test'],
          max_context_tokens: 10,
          deadline: Number.MAX_SAFE_INTEGER,
          cost_ceiling: 0,
          max_attempts: 1,
        },
      },
      caller.signal,
    );
    try {
      await setImmediate();
      assert.ok(observed);
      assert.equal(observed.aborted, false, 'early timer wakes must not abort a provider before the clock deadline');
      assert.deepEqual(waits, Array(4).fill(2 ** 31 - 1));
      assert.equal(activeSleeps, 1);
      if (finish === 'caller cancels') caller.abort();
      else
        complete({
          status: 'completed',
          text: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: 'stop',
          provider_response_id: undefined,
        });
      const outcome = await pending;
      assert.equal(outcome.status, finish === 'caller cancels' ? 'unaccepted' : 'accepted');
      assert.equal(outcome.attempts.length, 1);
      assert.equal(activeSleeps, 0, 'settlement and cancellation must clean up the pending sleep');
      await setImmediate();
      assert.equal(waits.length, 4, 'cleanup must stop the watcher loop');
    } finally {
      caller.abort();
      complete({ status: 'failed', failure: { code: 'cancelled', message: 'cleanup', retryable: false } });
      await pending;
    }
  });
}

it('rechecks the clock over several early wakes and records timeout exactly once at the deadline', async () => {
  let now = 0;
  let fire!: () => void;
  let observed: AbortSignal | undefined;
  let aborts = 0;
  let calls = 0;
  let activeSleeps = 0;
  const waits: number[] = [];
  const timer: Timer = {
    sleep(ms, signal) {
      waits.push(ms);
      activeSleeps += 1;
      return new Promise((resolve) => {
        const done = () => {
          signal?.removeEventListener('abort', done);
          activeSleeps -= 1;
          resolve();
        };
        fire = done;
        signal?.addEventListener('abort', done, { once: true });
      });
    },
  };
  const adapter: GenerationAdapter = {
    id: 'waiting',
    execute(call) {
      calls += 1;
      observed = call.signal;
      return new Promise((resolve) =>
        call.signal?.addEventListener(
          'abort',
          () => {
            aborts += 1;
            resolve({ status: 'failed', failure: { code: 'cancelled', message: 'aborted', retryable: false } });
          },
          { once: true },
        ),
      );
    },
  };
  const caller = new AbortController();
  const gateway = createInferenceGateway({
    routes: [unit, { ...unit, routed_unit_id: 'fallback' }],
    adapters: [adapter],
    clock: { now: () => now },
    timer,
  });
  const pending = gateway.generate(
    {
      request_id: 'early-wakes',
      site: 'test',
      role: 'working',
      kind: 'transform',
      input: { instructions: '', prompt: 'ok' },
      terms: {
        quality: 'baseline',
        destinations: ['test'],
        max_context_tokens: 10,
        deadline: 100,
        cost_ceiling: 0,
        max_attempts: 2,
      },
    },
    caller.signal,
  );
  try {
    await setImmediate();
    for (const time of [0, 40, 99]) {
      now = time;
      fire();
      await setImmediate();
      assert.equal(observed?.aborted, false, `clock ${time} is still before the deadline`);
      assert.equal(activeSleeps, 1);
    }
    assert.deepEqual(waits, [100, 100, 60, 1]);
    now = 100;
    fire();
    const outcome = await pending;
    assert.equal(aborts, 1);
    assert.equal(calls, 1);
    assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'deadline_reached');
    assert.equal(outcome.attempts.length, 1);
    assert.deepEqual(outcome.attempts[0]?.disposition, {
      status: 'failed',
      failure: {
        code: 'timeout',
        message: 'provider attempt exceeded the request deadline',
        retryable: false,
      },
    });
    assert.equal(activeSleeps, 0);
    await setImmediate();
    assert.equal(waits.length, 4);
  } finally {
    caller.abort();
    await pending;
  }
});

it('aborts an in-flight provider at the injected deadline and records timeout without fallback', async () => {
  let now = 0;
  let fire: (() => void) | undefined;
  let observed: AbortSignal | undefined;
  let entered!: () => void;
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const timer: Timer = {
    sleep(ms, signal) {
      assert.equal(ms, 100);
      return new Promise((resolve) => {
        fire = () => {
          now += ms;
          resolve();
        };
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
      return new Promise((resolve) => {
        call.signal?.addEventListener(
          'abort',
          () =>
            resolve({
              status: 'failed',
              failure: {
                code: 'cancelled',
                message: 'aborted',
                retryable: false,
              },
            }),
          { once: true },
        );
      });
    },
  };
  const gateway = createInferenceGateway({
    routes: [unit, { ...unit, routed_unit_id: 'deadline.fallback' }],
    adapters: [adapter],
    clock: { now: () => now },
    timer,
  });
  const pending = gateway.generate({
    request_id: 'deadline',
    site: 'test',
    role: 'working',
    kind: 'transform',
    input: { instructions: '', prompt: 'ok' },
    terms: {
      quality: 'baseline',
      destinations: ['test'],
      max_context_tokens: 10,
      deadline: 100,
      cost_ceiling: 0,
      max_attempts: 2,
      max_attempts_per_route: 1,
    },
  });
  await called;
  await setImmediate();
  assert.ok(observed, 'the gateway must provide a deadline AbortSignal to the provider');
  fire?.();
  const outcome = await pending;
  assert.equal(observed.aborted, true);
  assert.equal(outcome.status, 'unaccepted');
  assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'deadline_reached');
  assert.equal(calls, 1);
  assert.equal(outcome.attempts.length, 1);
  assert.deepEqual(outcome.attempts[0]?.disposition, {
    status: 'failed',
    failure: {
      code: 'timeout',
      message: 'provider attempt exceeded the request deadline',
      retryable: false,
    },
  });
});

for (const operation of ['generate', 'evaluate'] as const) {
  for (const interruption of ['deadline', 'caller cancel'] as const) {
    it(`${operation} observes a late adapter rejection after ${interruption} without changing the interrupt outcome`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        let now = 0;
        let fire!: () => void;
        let observed: AbortSignal | undefined;
        let rejectLate!: () => void;
        let entered!: () => void;
        let calls = 0;
        const called = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const timer: Timer = {
          sleep(ms, signal) {
            return new Promise((resolve) => {
              fire = () => {
                now += ms;
                resolve();
              };
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        };
        const execute = (call: { signal: AbortSignal | undefined }): Promise<never> => {
          calls += 1;
          observed = call.signal;
          entered();
          return new Promise((_, reject) => {
            call.signal?.addEventListener(
              'abort',
              () => {
                // Keep the provider pending until the interrupt has returned to
                // the caller, then simulate an adapter throwing during cleanup.
                rejectLate = () => reject(new Error('late adapter rejection'));
              },
              { once: true },
            );
          });
        };
        const evaluator: EvaluationAdapter = { id: 'waiting', evaluate: execute };
        const evaluationUnit: RoutedUnit = { ...unit, operation: 'evaluate', kind: 'boolean' };
        const gateway = createInferenceGateway({
          routes: operation === 'generate' ? [unit] : [evaluationUnit],
          adapters: [{ id: 'waiting', execute }],
          evaluators: [evaluator],
          clock: { now: () => now },
          timer,
        });
        const caller = new AbortController();
        const common = {
          request_id: 'late-rejection',
          site: 'test',
          role: 'working' as const,
          terms: {
            quality: 'baseline' as const,
            destinations: ['test'],
            max_context_tokens: 10,
            deadline: 100,
            cost_ceiling: 0,
            max_attempts: 2,
            max_attempts_per_route: 1,
          },
        };
        const pending =
          operation === 'generate'
            ? gateway.generate(
                { ...common, kind: 'transform', input: { instructions: '', prompt: 'ok' } },
                caller.signal,
              )
            : gateway.evaluate(
                {
                  ...common,
                  kind: 'boolean',
                  state: 'ok',
                  questions: { ok: { type: 'boolean', instructions: 'Is this ok?' } },
                },
                caller.signal,
              );
        await called;
        await setImmediate();
        assert.ok(observed);
        if (interruption === 'deadline') fire();
        else caller.abort();
        const outcome = await pending;
        assert.equal(observed.aborted, true);
        assert.equal(outcome.status, 'unaccepted');
        assert.equal(
          outcome.status === 'unaccepted' ? outcome.reason : '',
          interruption === 'deadline' ? 'deadline_reached' : 'provider_failed',
        );
        const snapshot = structuredClone(outcome);
        rejectLate();
        // Allow promise reactions and Node's unhandled-rejection reporting to
        // run before checking both the process event and the settled outcome.
        await setImmediate();
        assert.deepEqual(unhandled, []);
        assert.deepEqual(outcome, snapshot);
        assert.equal(calls, 1);
        assert.equal(outcome.attempts.length, 1);
        assert.deepEqual(outcome.attempts[0]?.disposition, {
          status: 'failed',
          failure: {
            code: interruption === 'deadline' ? 'timeout' : 'cancelled',
            message:
              interruption === 'deadline'
                ? 'provider attempt exceeded the request deadline'
                : 'provider attempt cancelled',
            retryable: false,
          },
        });
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });
  }
}

for (const interruption of ['deadline', 'cancel'] as const) {
  it(`returns a late accepted result as-is from an await_on_abort adapter after ${interruption}`, async () => {
    let now = 0;
    let fire!: () => void;
    let observed: AbortSignal | undefined;
    let complete!: (result: Awaited<ReturnType<GenerationAdapter['execute']>>) => void;
    let calls = 0;
    const result = {
      status: 'completed' as const,
      text: 'effects completed after abort',
      usage: { input_tokens: 3, output_tokens: 4 },
      finish_reason: 'stop',
      provider_response_id: 'late-response',
    };
    const adapter: GenerationAdapter = {
      id: 'waiting',
      await_on_abort: true,
      execute(call) {
        calls += 1;
        observed = call.signal;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    };
    const caller = new AbortController();
    const gateway = createInferenceGateway({
      routes: [unit, { ...unit, routed_unit_id: 'fallback' }],
      adapters: [adapter],
      clock: { now: () => now },
      timer: {
        sleep(ms, signal) {
          return new Promise((resolve) => {
            fire = () => {
              now += ms;
              resolve();
            };
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      },
    });
    const pending = gateway.generate(
      {
        request_id: 'accepted-after-abort',
        site: 'test',
        role: 'working',
        kind: 'transform',
        input: { instructions: '', prompt: 'ok' },
        terms: {
          quality: 'baseline',
          destinations: ['test'],
          max_context_tokens: 10,
          deadline: 100,
          cost_ceiling: 0,
          max_attempts: 2,
        },
      },
      caller.signal,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await setImmediate();
      if (interruption === 'deadline') fire();
      else caller.abort();
      await setImmediate();
      assert.equal(observed?.aborted, true);
      assert.equal(settled, false, 'the gateway must await the adapter after abort');
      now = 150;
      complete(result);
      const outcome = await pending;
      assert.equal(outcome.status, 'accepted');
      if (outcome.status === 'accepted') {
        assert.equal(outcome.text, result.text);
        assert.equal(outcome.provider_response_id, result.provider_response_id);
        assert.equal(outcome.routed_unit_id, unit.routed_unit_id);
      }
      assert.equal(calls, 1, 'no fallback starts while awaiting the final result');
      assert.equal(outcome.attempts.length, 1);
      assert.deepEqual(outcome.attempts[0]?.disposition, { status: 'accepted' });
      assert.deepEqual(outcome.attempts[0]?.usage, result.usage);
      assert.equal(outcome.attempts[0]?.ended_at, 150);
    } finally {
      caller.abort();
      complete(result);
      await pending;
    }
  });
}

for (const immediate of [false, true]) {
  for (const interruption of ['deadline', 'cancel'] as const) {
    it(`contains an await_on_abort adapter rejection ${immediate ? 'during' : 'after'} ${interruption}`, async () => {
      let now = 0;
      let fire!: () => void;
      let rejectPort!: (error: Error) => void;
      const caller = new AbortController();
      const adapter: GenerationAdapter = {
        id: 'waiting',
        await_on_abort: true,
        execute: (call) =>
          new Promise((_, reject) => {
            rejectPort = reject;
            if (immediate)
              call.signal?.addEventListener('abort', () => reject(new Error('adapter abort rejected')), { once: true });
          }),
      };
      const gateway = createInferenceGateway({
        routes: [unit],
        adapters: [adapter],
        clock: { now: () => now },
        timer: {
          sleep(ms, signal) {
            return new Promise((resolve) => {
              fire = () => {
                now += ms;
                resolve();
              };
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        },
      });
      const pending = gateway.generate(
        {
          request_id: 'reject-on-abort',
          site: 'test',
          role: 'working',
          kind: 'transform',
          input: { instructions: '', prompt: 'ok' },
          terms: {
            quality: 'baseline',
            destinations: ['test'],
            max_context_tokens: 10,
            deadline: 100,
            cost_ceiling: 0,
            max_attempts: 1,
          },
        },
        caller.signal,
      );
      await setImmediate();
      if (interruption === 'deadline') fire();
      else caller.abort();
      await setImmediate();
      if (!immediate) rejectPort(new Error('adapter cleanup rejected'));
      const outcome = await pending;
      assert.equal(outcome.status, 'unaccepted');
      assert.equal(outcome.attempts.length, 1);
      const disposition = outcome.attempts[0]!.disposition;
      assert.equal(disposition.status, 'failed');
      if (disposition.status === 'failed')
        assert.equal(disposition.failure.code, interruption === 'deadline' ? 'timeout' : 'cancelled');
    });
  }
}
