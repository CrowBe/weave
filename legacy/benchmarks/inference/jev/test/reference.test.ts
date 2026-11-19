import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { createInferenceGateway, type Clock, type Timer } from '@weave/gateway';
import { typesafeAiEvaluator } from '@weave/gateway/typesafe-ai';
import { CORPUS } from '../corpus.ts';
import { jevRouteTable, readCredentials, runCase, probeTerms, realTimer, type RouteOptions } from '../run.ts';
import { runSuiteRecord, type SuiteRecord } from '../transfer.ts';

const PIN = 'jev-1.14.0';
const credentials = { vercel: 'fake-vercel', typesafe: 'fake-typesafe' };
const options: RouteOptions = { preferFree: false, reference: true };
const clock: Clock = { now: () => 1_000 };
const decision = CORPUS[0]!;
const suite: SuiteRecord = {
  id: 'reference-choice',
  source: 'fake',
  group: 'g',
  variant: 'v',
  state: 'state',
  questionId: 'q',
  question: { type: 'choice', instructions: 'Choose.', criteria: { a: 'A', b: 'B' }, label: 'a', src: 'fake' },
};

function gateway(model: string | undefined, calls: Record<string, unknown>[], throttle = false) {
  const timer: Timer = {
    sleep: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (_ms < 120_000) resolve();
        else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  };
  return createInferenceGateway({
    clock,
    timer,
    routes: jevRouteTable(credentials, options),
    evaluators: [
      {
        id: 'vercel-ai-gateway',
        evaluate: async () => {
          throw new Error('Vercel fallback attempted');
        },
      },
      typesafeAiEvaluator({
        apiKey: credentials.typesafe,
        shuffle: false,
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          calls.push(body);
          if (throttle)
            return new Response('{}', {
              status: 429,
              headers: { 'retry-after': '0.001', 'x-typesafe-request-id': 'throttle-response' },
            });
          const questions = body['questions'] as Record<string, { criteria: Record<string, unknown> }>;
          return new Response(
            JSON.stringify({
              ...(model === undefined ? {} : { model }),
              answers: Object.fromEntries(
                Object.entries(questions).map(([id, q]) => [
                  id,
                  { type: 'choice', choice: Object.keys(q.criteria)[0] },
                ]),
              ),
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { headers: { 'x-typesafe-request-id': 'response-123' } },
          );
        },
      }),
    ],
  });
}

test('reference has exactly one TypeSafe routed unit per kind even with both keys', () => {
  const routes = jevRouteTable(credentials, options);
  assert.equal(routes.length, 3);
  for (const route of routes) {
    assert.equal(route.adapter, 'typesafe-ai');
    assert.equal(route.model, PIN);
  }
  assert.deepEqual(probeTerms(credentials, clock, options).destinations, ['typesafe-ai']);
  assert.ok(probeTerms(credentials, clock, options).max_attempts_per_route! > 1);
});

test('reference refuses a missing TypeSafe key and conflicting model without echoing input', () => {
  assert.throws(() => jevRouteTable({ vercel: 'fake', typesafe: undefined }, options), /TypeSafe/);
  assert.throws(() => jevRouteTable(credentials, { ...options, model: 'secret-as-model' }), /reference.*jev-1\.14\.0/);
  assert.throws(() => jevRouteTable(credentials, { ...options, local: true }), /reference/);
  assert.deepEqual(readCredentials({ TYPESAFE_API_KEY: 'direct-only' }, options), {
    vercel: '',
    typesafe: 'direct-only',
  });
  assert.ok('error' in readCredentials({ AI_GATEWAY_API_KEY: 'fake' }, options));
});

test('reference throttle exhaustion records failure with bounded attempts and no fallback', async () => {
  const calls: Record<string, unknown>[] = [];
  const record = await runCase(gateway(PIN, calls, true), clock, credentials, decision, 'choice', 0, options);
  assert.equal(record.reason, 'throttle_exhausted');
  assert.equal(record.provider_response_id, 'throttle-response');
  assert.equal(record.attempts.length, probeTerms(credentials, clock, options).max_attempts_per_route);
  assert.equal(calls.length, record.attempts.length);
  assert.ok(record.attempts.every((a) => a.routed_unit_id === 'choice@typesafe' && a.detail === 'rate_limited'));
  assert.equal(record.routed_unit_id, 'choice@typesafe');
  assert.ok(record.attempts.slice(1).every((a) => a.waited_ms === 1));
  assert.equal(record.pin_mismatch, true);
});

test('reference 429 without Retry-After waits before every retry then records throttle_exhausted', async () => {
  let now = 1_000;
  const fakeClock = { now: () => now };
  const started: number[] = [];
  const waits: number[] = [];
  const gw = createInferenceGateway({
    clock: fakeClock,
    routes: jevRouteTable(credentials, options),
    timer: {
      sleep: async (ms, signal) => {
        // Deadline timers remain pending until their attempt finishes.
        if (ms >= 100_000)
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        waits.push(ms);
        now += ms;
      },
    },
    evaluators: [
      typesafeAiEvaluator({
        apiKey: credentials.typesafe,
        shuffle: false,
        fetch: async () => {
          started.push(now);
          return new Response('{}', { status: 429 });
        },
      }),
    ],
  });
  const record = await runCase(gw, fakeClock, credentials, decision, 'choice', 0, options);
  assert.equal(started.length, 4);
  assert.deepEqual(
    started.slice(1).map((time, i) => time - started[i]!),
    [1_000, 1_000, 1_000],
  );
  assert.ok(waits.every((ms) => ms === 1_000));
  assert.deepEqual(
    record.attempts.slice(1).map((a) => a.waited_ms),
    [1_000, 1_000, 1_000],
  );
  assert.equal(record.reason, 'throttle_exhausted');
});

for (const model of [PIN, 'jev-1.15.0', 'jev-preview', undefined]) {
  test(`reference records resolved model ${String(model)} and flags pin mismatch on both corpora`, async () => {
    const calls: Record<string, unknown>[] = [];
    const gw = gateway(model, calls);
    const record = await runCase(gw, clock, credentials, decision, 'choice', 0, options);
    const transfer = await runSuiteRecord(gw, clock, credentials, suite, options);
    for (const row of [record, transfer]) {
      assert.equal(row.status, 'accepted');
      assert.equal(row.resolved_model_id, model ?? null);
      assert.equal(row.provider_response_id, 'response-123');
      assert.equal(row.pin_mismatch, model !== PIN);
      assert.equal(row.request_params?.max_output_tokens, null);
      assert.equal(row.request_params?.shuffle, false);
    }
    assert.deepEqual(
      record.request_params?.presentation_order,
      decision.candidates.map((c) => c.candidate_id),
    );
    assert.deepEqual(transfer.request_params?.presentation_order, ['a', 'b']);
    assert.ok(calls.every((c) => c['model'] === PIN && !Object.hasOwn(c, 'max_output_tokens')));
    assert.ok(calls.every((c) => Object.keys(c).sort().join(',') === 'model,questions,state'));
  });
}

test('reference gateway factory sends the pin and corpus order with no guardrail or shuffle fields', async () => {
  const { createJevGateway } = await import('../run.ts');
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return new Response(
      JSON.stringify({
        model: PIN,
        answers: { best: { type: 'choice', choice: decision.label } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  };
  try {
    const record = await runCase(
      createJevGateway(credentials, clock, options),
      clock,
      credentials,
      decision,
      'choice',
      0,
      options,
    );
    assert.equal(record.pin_mismatch, false);
    assert.deepEqual(Object.keys(bodies[0]!).sort(), ['model', 'questions', 'state']);
    assert.equal(bodies[0]!['model'], PIN);
    assert.equal(record.request_params?.max_output_tokens, bodies[0]!['max_output_tokens'] ?? null);
    assert.equal(record.request_params?.shuffle, false);
    const questions = bodies[0]!['questions'] as { best: { criteria: Record<string, unknown> } };
    assert.deepEqual(
      Object.keys(questions.best.criteria),
      decision.candidates.map((c) => c.candidate_id),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('reference retry waits release abort listeners after success and cancellation', async () => {
  const controller = new AbortController();
  await realTimer.sleep(0, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const pending = realTimer.sleep(60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
