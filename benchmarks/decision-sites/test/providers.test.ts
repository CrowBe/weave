import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviders } from '../providers.ts';
const request = {
  state: { text: 'test' },
  questions: { q: { type: 'choice' as const, instructions: 'Select.', criteria: { b: 'Bee', a: 'Aye' } } },
};
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
test('Amos replay serialization is exactly the adapter wire body for every question type', async () => {
  const input = {
    state: { text: 'disclosed state' },
    questions: {
      p: {
        type: 'boolean' as const,
        instructions: { ask: 'Ready?' },
        criteria: { true: { meaning: 'yes' }, false: null },
      },
      c: request.questions.q,
      s: { type: 'score' as const, instructions: 'Score?', criteria: [null, { meaning: 'high' }] },
    },
  };
  let sent: string | undefined;
  const p = buildProviders({
    fetch: async (url, options) => {
      if (String(url).endsWith('/v1/models'))
        return json({ models: [{ name: 'amos-1-2b' }], question_types: ['noul', 'choice', 'score'] });
      sent = String(options?.body);
      return json({});
    },
  }).find((x) => x.id === 'amos-small')!;
  const serialized = p.serialize(input);
  await p.request(input, new AbortController().signal);
  assert.equal(serialized, sent, 'replay must hash the serialized body actually dispatched by amosEvaluator');
});
test('TypeSafe pins model, batches and preserves question order; missing confidence remains absent', async () => {
  const seen: unknown[] = [];
  const providers = buildProviders({
    typesafeKey: 'secret',
    fetch: async (_url, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return json({
        model: 'jev-1.14.0',
        answers: { q: { type: 'choice', choice: 'b', probabilities: { b: 0.8, a: 0.2 } } },
        usage: { input_tokens: 100, output_tokens: 2 },
      });
    },
  });
  const result = await providers[0]!.request(request, new AbortController().signal);
  assert.equal(result.status, 'ok');
  assert.equal(result.answers?.q?.confidence, undefined);
  assert.deepEqual(seen, [{ model: 'jev-1.14.0', state: request.state, questions: request.questions }]);
});
test('model mismatch, missing answers, unknown choice, refusal and malformed responses fail', async () => {
  for (const body of [
    { model: 'jev-preview', answers: { q: { type: 'choice', choice: 'b' } } },
    { model: 'jev-1.14.0', answers: {} },
    { model: 'jev-1.14.0', answers: { q: { type: 'choice', choice: 'unknown' } } },
    { model: 'jev-1.14.0', refusal: 'no' },
  ]) {
    const p = buildProviders({ typesafeKey: 'x', fetch: async () => json(body) })[0]!;
    assert.equal((await p.request(request, new AbortController().signal)).status, 'failed');
  }
});
test('OpenAI skips missing credential and makes auth failure sticky without leaking secrets', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return json({ error: { code: 'denied', message: 'CANARY' } }, 401, { 'x-request-id': 'request-123' });
  };
  const p = buildProviders({ openaiKey: 'CANARY', fetch }).find((x) => x.id === 'openai-decisions')!;
  const first = await p.request(request, new AbortController().signal);
  const next = await p.request(request, new AbortController().signal);
  assert.equal(first.status, 'skipped');
  assert.equal(first.http_status, 401);
  assert.equal(first.error_code, 'denied');
  assert.equal(first.request_id, 'request-123');
  assert.equal(next.status, 'skipped');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(first).includes('CANARY'));
  const missing = buildProviders({ fetch }).find((x) => x.id === 'openai-decisions')!;
  assert.equal((await missing.request(request, new AbortController().signal)).reason, 'no_credential');
  assert.equal(calls, 1);
});
test('rate limit carries bounded retry delay and cancellation produces no answer', async () => {
  const p = buildProviders({ typesafeKey: 'x', fetch: async () => json({}, 429, { 'retry-after': '2' }) })[0]!;
  const result = await p.request(request, new AbortController().signal);
  assert.equal(result.http_status, 429);
  assert.equal(result.retry_after_ms, 2000);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await p.request(request, controller.signal)).reason, 'cancelled');
});
test('Amos requires advertised question types and calls amosEvaluator without shell or credentials', async () => {
  const paths: string[] = [];
  const p = buildProviders({
    fetch: async (url) => {
      const path = String(url);
      paths.push(path);
      return path.endsWith('/v1/models')
        ? json({ models: [{ name: 'amos-1-2b' }], question_types: ['noul'] })
        : json({});
    },
  }).find((x) => x.id === 'amos-small')!;
  assert.equal((await p.request(request, new AbortController().signal)).reason, 'unsupported_question_type');
  assert.equal(paths.length, 1);
});
test('Amos rejects non-loopback configuration with a typed failure before any fetch', async () => {
  for (const amosBaseURL of ['https://remote.example', 'http://192.0.2.1:8766']) {
    let calls = 0;
    const p = buildProviders({
      amosBaseURL,
      fetch: async () => {
        calls++;
        return json({});
      },
    }).find((x) => x.id === 'amos-small')!;
    assert.deepEqual(await p.request(request, new AbortController().signal), {
      status: 'failed',
      reason: 'models_unavailable',
    });
    assert.equal(calls, 0);
  }
});
for (const id of ['typesafe-jev', 'openai-decisions'])
  test(`${id} reports a timeout during a 2xx body read with response metadata`, async (t) => {
    const deadline = new AbortController(),
      external = new AbortController();
    t.mock.method(AbortSignal, 'timeout', (ms: number) => {
      assert.equal(ms, 30_000);
      return deadline.signal;
    });
    const p = buildProviders({
      typesafeKey: 'key',
      openaiKey: 'key',
      fetch: async (_url, options) => {
        const body = new ReadableStream(
          {
            pull(controller) {
              deadline.abort(new DOMException('Body read timed out', 'TimeoutError'));
              assert.equal(options?.signal?.aborted, true);
              controller.error(deadline.signal.reason);
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          headers: { 'x-request-id': 'openai-request', 'x-typesafe-request-id': 'typesafe-request' },
        });
      },
    }).find((x) => x.id === id)!;
    assert.deepEqual(await p.request(request, external.signal), {
      status: 'failed',
      reason: 'timeout',
      http_status: 200,
      request_id: id === 'typesafe-jev' ? 'typesafe-request' : 'openai-request',
    });
    assert.equal(external.signal.aborted, false);
  });
test('non-JSON 401 still skips provider and non-JSON 429 preserves retry status', async () => {
  let calls = 0;
  const p = buildProviders({
    openaiKey: 'key',
    fetch: async () => {
      calls++;
      return new Response('denied', { status: 401, headers: { 'x-request-id': 'r' } });
    },
  }).find((x) => x.id === 'openai-decisions')!;
  assert.equal((await p.request(request, new AbortController().signal)).http_status, 401);
  assert.equal((await p.request(request, new AbortController().signal)).status, 'skipped');
  assert.equal(calls, 1);
  const rate = buildProviders({
    typesafeKey: 'key',
    fetch: async () => new Response('slow', { status: 429, headers: { 'retry-after': '2' } }),
  })[0]!;
  const limited = await rate.request(request, new AbortController().signal);
  assert.equal(limited.http_status, 429);
  assert.equal(limited.retry_after_ms, 2000);
});
test('OpenAI wire maps shared state, predicate, choices, ordered labels and array probabilities', async () => {
  let body: any;
  const input = {
    state: { data: 'state' },
    questions: {
      p: { type: 'boolean' as const, instructions: 'Predicate?' },
      c: request.questions.q,
      s: { type: 'score' as const, instructions: 'Score?', criteria: ['low', 'high'] },
    },
  };
  const p = buildProviders({
    openaiKey: 'key',
    fetch: async (_url, options) => {
      body = JSON.parse(String(options?.body));
      return json({
        model: 'gpt-6-luna',
        answers: [
          { name: 'p', type: 'predicate', probability: 0.8 },
          {
            name: 'c',
            type: 'choice',
            choice: 'b',
            probabilities: [
              { value: 'b', probability: 0.8 },
              { value: 'a', probability: 0.2 },
            ],
            confidence: 0.9,
          },
          {
            name: 's',
            type: 'score',
            score: 0.2,
            probabilities: [
              { value: '0', probability: 0.8 },
              { value: '1', probability: 0.2 },
            ],
            confidence: 0.9,
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      });
    },
  }).find((x) => x.id === 'openai-decisions')!;
  const result = await p.request(input, new AbortController().signal);
  assert.equal(result.status, 'ok');
  assert.equal(result.answers?.p?.confidence, undefined);
  assert.deepEqual(result.answers?.c?.probabilities, { b: 0.8, a: 0.2 });
  assert.equal(body.input, JSON.stringify(input.state));
  assert.equal(body.questions[0].type, 'predicate');
  assert.deepEqual(body.questions[2].levels, [
    { label: '0', description: 'low' },
    { label: '1', description: 'high' },
  ]);
});
test('5xx, timeout, network, malformed JSON and missing usage are recorded failures', async () => {
  for (const fetch of [
    async () => new Response('bad', { status: 503 }),
    async () => {
      throw new Error('CANARY_SECRET');
    },
    async () => new Response('{'),
    async () => json({ model: 'jev-1.14.0', answers: { q: { type: 'choice', choice: 'b' } } }),
  ]) {
    const p = buildProviders({ typesafeKey: 'CANARY_SECRET', fetch })[0]!;
    const r = await p.request(request, new AbortController().signal);
    assert.equal(r.status, 'failed');
    assert.ok(!JSON.stringify(r).includes('CANARY_SECRET'));
  }
  const p = buildProviders({
    typesafeKey: 'key',
    timeoutMs: 1,
    fetch: async (_url, options) => {
      await new Promise((resolve) => options?.signal?.addEventListener('abort', resolve, { once: true }));
      throw new Error('timeout');
    },
  })[0]!;
  // Keep a fake transport handle alive, like a real socket; AbortSignal timeout alone is unref'ed.
  const keeper = setTimeout(() => {}, 100);
  assert.equal((await p.request(request, new AbortController().signal)).reason, 'timeout');
  clearTimeout(keeper);
});
test('Amos reuses the adapter with advertised types and never attaches credentials', async () => {
  const paths: string[] = [];
  const p = buildProviders({
    typesafeKey: 'CANARY',
    openaiKey: 'CANARY',
    fetch: async (url, options) => {
      paths.push(String(url));
      assert.ok(!String(JSON.stringify(options?.headers)).includes('CANARY'));
      return String(url).endsWith('/v1/models')
        ? json({ models: [{ name: 'amos-1-2b', description: '1.2B parameters: noul, choice, score' }] })
        : json({
            model: 'amos-1-2b',
            answers: { q: { type: 'choice', choice: 'b', probabilities: { b: 0.8, a: 0.2 }, confidence: 0.9 } },
            usage: { input_tokens: 10, output_tokens: 1 },
          });
    },
  }).find((x) => x.id === 'amos-small')!;
  assert.equal((await p.request(request, new AbortController().signal)).status, 'ok');
  assert.deepEqual(paths, ['http://127.0.0.1:8766/v1/models', 'http://127.0.0.1:8766/v1/systemone']);
  paths.length = 0;
  const concurrent = await Promise.all([
    p.request(request, new AbortController().signal),
    p.request(request, new AbortController().signal),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.status),
    ['ok', 'ok'],
  );
  assert.equal(paths.filter((path) => path.endsWith('/v1/models')).length, 2);
  assert.equal(paths.filter((path) => path.endsWith('/v1/systemone')).length, 2);
  const unavailable = buildProviders({ fetch: async () => new Response('', { status: 503 }) }).find(
    (x) => x.id === 'amos-small',
  )!;
  assert.equal((await unavailable.request(request, new AbortController().signal)).reason, 'models_unavailable');
});
test('Amos records actual served model and rejects a response from a different model', async () => {
  const p = buildProviders({
    typesafeKey: 'CANARY',
    fetch: async (url) =>
      String(url).endsWith('/v1/models')
        ? json({ models: [{ name: 'amos-1-2b', question_types: ['choice'] }] })
        : json({
            model: 'other-CANARY-model',
            answers: { q: { type: 'choice', choice: 'b', probabilities: { b: 0.8, a: 0.2 } } },
            usage: { input_tokens: 21, output_tokens: 3 },
          }),
  }).find((x) => x.id === 'amos-small')!;
  const result = await p.request(request, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'wrong_model');
  assert.equal(result.model, 'other-[redacted]-model');
  assert.equal(result.input_tokens, 21);
  assert.equal(result.output_tokens, 3);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});
