/**
 * Local Kev adapter and lifecycle tests.
 *
 * Confirmed seams:
 * - `EvaluationAdapter.evaluate`: local execution must not cross the HTTP seam
 *   until the externally managed runtime is ready.
 * - `KevRuntime.ensureReady`: service discovery/startup, identity verification,
 *   cancellation and concurrent warmup are hidden behind one operation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createSystemdKevRuntime,
  KEV_LOCAL_ADAPTER,
  kevLocalEvaluator,
  type KevRuntime,
} from '../src/adapters/kev-local.js';
import type { Clock, EvaluationCall, ProviderFailure, Timer } from '../src/types.js';

const CALL: EvaluationCall = {
  model: 'kev-4b',
  kind: 'boolean',
  state: 'The change has deterministic tests.',
  questions: {
    ready: { type: 'boolean', instructions: 'Is the change ready for review?' },
  },
  signal: undefined,
};

function failed(message: string): ProviderFailure {
  return { code: 'unavailable', message, retryable: true };
}

describe('local Kev evaluator', () => {
  it('preserves criteria order when shuffle is false', async (t) => {
    t.mock.method(Math, 'random', () => 0);
    const criteria = { auth: 'authentication', payments: 'payments', ui: 'interface' };
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: { area: { criteria: Record<string, string> } };
      };
      assert.deepEqual(Object.keys(body.questions.area.criteria), ['auth', 'payments', 'ui']);
      return new Response(
        JSON.stringify({
          answers: { area: { type: 'choice', choice: 'auth' } },
        }),
      );
    };
    const evaluator = kevLocalEvaluator({
      runtime: { ensureReady: async () => ({ status: 'ready' }) },
      fetch,
      shuffle: false,
    });

    const result = await evaluator.evaluate({
      ...CALL,
      kind: 'choice',
      questions: { area: { type: 'choice', instructions: 'Which area?', criteria } },
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(Object.keys(criteria), ['auth', 'payments', 'ui']);
  });

  it('shuffles choice criteria per call by default, keeping every key', async (t) => {
    t.mock.method(Math, 'random', () => 0);
    const criteria = { auth: 'authentication', payments: 'payments', ui: 'interface' };
    let sent: string[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: { area: { criteria: Record<string, string> } };
      };
      sent = Object.keys(body.questions.area.criteria);
      return new Response(JSON.stringify({ answers: { area: { type: 'choice', choice: 'ui' } } }));
    };

    const result = await kevLocalEvaluator({
      runtime: { ensureReady: async () => ({ status: 'ready' }) },
      fetch,
    }).evaluate({
      ...CALL,
      kind: 'choice',
      questions: { area: { type: 'choice', instructions: 'Which area?', criteria } },
    });

    // Fisher-Yates with a constant 0 draw moves the last key to the front, then swaps the first two.
    assert.deepEqual(sent, ['payments', 'ui', 'auth']);
    assert.deepEqual(result.status === 'completed' && result.answers['area'], { type: 'choice', choice: 'ui' });
  });

  it('warms the external runtime before crossing the HTTP seam', async () => {
    const events: string[] = [];
    const runtime: KevRuntime = {
      async ensureReady() {
        events.push('ready');
        return { status: 'ready' };
      },
    };
    const fetch: typeof globalThis.fetch = async () => {
      events.push('fetch');
      return new Response(
        JSON.stringify({
          model: 'kev-latest',
          answers: { ready: { type: 'noul', noul: 0.81 } },
          usage: { input_tokens: 20, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const evaluator = kevLocalEvaluator({ runtime, fetch });
    const result = await evaluator.evaluate(CALL);

    assert.equal(evaluator.id, KEV_LOCAL_ADAPTER);
    assert.deepEqual(events, ['ready', 'fetch']);
    assert.equal(result.status, 'completed');
  });

  it('keeps failure messages intact: the placeholder bearer value is not a secret', async () => {
    const runtime: KevRuntime = { ensureReady: async () => ({ status: 'ready' }) };
    const thrown: typeof globalThis.fetch = async () => {
      throw new TypeError('getaddrinfo ENOTFOUND localhost');
    };
    const transport = await kevLocalEvaluator({ runtime, fetch: thrown }).evaluate(CALL);
    assert.equal(transport.status, 'failed');
    if (transport.status !== 'failed') return;
    assert.equal(transport.failure.message, 'getaddrinfo ENOTFOUND localhost');

    let authorization: string | null = null;
    const status: typeof globalThis.fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response('local model not loaded', { status: 503, headers: { 'x-typesafe-request-id': 'local-1' } });
    };
    const failed = await kevLocalEvaluator({ runtime, fetch: status }).evaluate(CALL);
    assert.equal(failed.status, 'failed');
    if (failed.status !== 'failed') return;
    assert.equal(failed.failure.code, 'unavailable');
    assert.match(failed.failure.message, /local model not loaded \(request local-1\)$/);
    assert.doesNotMatch(failed.failure.message, /\[redacted\]/);
    // The wire is unchanged: Kev still receives the placeholder it was recorded with.
    assert.equal(authorization, 'Bearer local');
  });

  it('returns the runtime failure without attempting HTTP', async () => {
    let fetched = false;
    const runtime: KevRuntime = {
      async ensureReady() {
        return { status: 'failed', failure: failed('Kev is not installed') };
      },
    };
    const fetch: typeof globalThis.fetch = async () => {
      fetched = true;
      throw new Error('must not fetch');
    };

    const result = await kevLocalEvaluator({ runtime, fetch }).evaluate(CALL);

    assert.equal(fetched, false);
    assert.deepEqual(result, { status: 'failed', failure: failed('Kev is not installed') });
  });
});

describe('systemd Kev runtime', () => {
  it('starts an absent external service and verifies its checkpoint identity', async () => {
    const events: string[] = [];
    let now = 0;
    let probes = 0;
    const clock: Clock = { now: () => now };
    const timer: Timer = {
      async sleep(ms) {
        events.push(`sleep:${ms}`);
        now += ms;
      },
    };
    const fetch: typeof globalThis.fetch = async () => {
      probes += 1;
      events.push(`probe:${probes}`);
      if (probes === 1) throw new TypeError('connection refused');
      return new Response(
        JSON.stringify({ run: '/opt/weave/kev/models/kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const runtime = createSystemdKevRuntime({
      clock,
      timer,
      fetch,
      expected: {
        run: '/opt/weave/kev/models/kev-4b',
        base: 'Qwen/Qwen3-4B-Base',
        lora: 16,
      },
      async start(unit, signal) {
        assert.equal(unit, 'weave-kev.service');
        assert.equal(signal, undefined);
        events.push('start');
      },
    });

    const result = await runtime.ensureReady();

    assert.deepEqual(result, { status: 'ready' });
    assert.deepEqual(events, ['probe:1', 'start', 'sleep:250', 'probe:2']);
  });

  it('reuses a healthy service without starting it', async () => {
    let starts = 0;
    const runtime = createSystemdKevRuntime({
      clock: { now: () => 0 },
      timer: { async sleep() {} },
      expected: { run: 'kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 },
      fetch: async () =>
        new Response(JSON.stringify({ run: 'kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 }), {
          status: 200,
        }),
      async start() {
        starts += 1;
      },
    });

    assert.deepEqual(await runtime.ensureReady(), { status: 'ready' });
    assert.equal(starts, 0);
  });

  it('refuses a running service with a different checkpoint', async () => {
    let starts = 0;
    const runtime = createSystemdKevRuntime({
      clock: { now: () => 0 },
      timer: { async sleep() {} },
      expected: { run: 'kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 },
      fetch: async () =>
        new Response(JSON.stringify({ run: 'kev-0.6b', base: 'Qwen/Qwen3-0.6B-Base', lora: 16 }), {
          status: 200,
        }),
      async start() {
        starts += 1;
      },
    });

    const result = await runtime.ensureReady();

    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' ? result.failure.code : '', 'malformed_response');
    assert.match(result.status === 'failed' ? result.failure.message : '', /checkpoint mismatch/);
    assert.equal(starts, 0, 'a mismatched live process must not be replaced implicitly');
  });

  it('coalesces concurrent warmup into one service start', async () => {
    let starts = 0;
    let resolveStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let available = false;
    const runtime = createSystemdKevRuntime({
      clock: { now: () => 0 },
      timer: { async sleep() {} },
      expected: { run: 'kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 },
      fetch: async () => {
        if (!available) throw new TypeError('connection refused');
        return new Response(JSON.stringify({ run: 'kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 }));
      },
      async start() {
        starts += 1;
        await started;
        available = true;
      },
    });

    const first = runtime.ensureReady();
    const second = runtime.ensureReady();
    resolveStart?.();

    assert.deepEqual(await Promise.all([first, second]), [{ status: 'ready' }, { status: 'ready' }]);
    assert.equal(starts, 1);
  });

  it('lets one caller cancel without cancelling a shared warmup', async () => {
    let releaseStart: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    let available = false;
    const runtime = createSystemdKevRuntime({
      clock: { now: () => 0 },
      timer: { async sleep() {} },
      expected: { run: 'kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 },
      fetch: async () => {
        if (!available) throw new TypeError('connection refused');
        return new Response(JSON.stringify({ run: 'kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 }));
      },
      async start() {
        startEntered?.();
        await released;
        available = true;
      },
    });
    const controller = new AbortController();
    const first = runtime.ensureReady(controller.signal);
    await entered;
    const second = runtime.ensureReady();

    controller.abort();
    releaseStart?.();

    const cancelledResult = await first;
    assert.equal(cancelledResult.status === 'failed' ? cancelledResult.failure.code : '', 'cancelled');
    assert.deepEqual(await second, { status: 'ready' });
  });

  it('does not start when the caller has already cancelled', async () => {
    let starts = 0;
    const controller = new AbortController();
    controller.abort();
    const runtime = createSystemdKevRuntime({
      clock: { now: () => 0 },
      timer: { async sleep() {} },
      expected: { run: 'kev-4b', base: 'Qwen/Qwen3-4B-Base', lora: 16 },
      fetch: async () => {
        throw new Error('must not probe');
      },
      async start() {
        starts += 1;
      },
    });

    const result = await runtime.ensureReady(controller.signal);

    assert.equal(result.status === 'failed' ? result.failure.code : '', 'cancelled');
    assert.equal(starts, 0);
  });
});
