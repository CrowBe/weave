/**
 * The direct TypeSafe AI adapter: wire translation and failure classification.
 *
 * Offline. `fetch` is injected, so these assert what the adapter sends and how
 * it reads what comes back — including the `noul` name that TypeSafe uses for a
 * boolean question and this adapter translates away.
 *
 * The response fixtures are copied from a live call, not invented.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TYPESAFE_AI_ADAPTER,
  typesafeAiEvaluator,
  type TypesafeAiOptions,
} from '@weave/gateway/typesafe-ai';
import type { EvaluationCall } from '@weave/gateway';

const REQUEST_ID = 'req_01a0b95c113778e992a3fa92749b2dbf';

/** A live response, trimmed to the fields the adapter reads. */
const LIVE_BODY = {
  model: 'jev-1.13.0',
  answers: {
    urgent: { type: 'noul', noul: 0.96 },
    severity: {
      type: 'score',
      score: 2.85,
      confidence: 0.85,
      legend: { '0': 'trivial', '1': 'minor', '2': 'serious', '3': 'critical' },
      probabilities: { '0': 0.0, '1': 0.0, '2': 0.15, '3': 0.85 },
    },
    area: {
      type: 'choice',
      choice: 'payments',
      confidence: 1.0,
      probabilities: { auth: 0.0, payments: 1.0, ui: 0.0 },
    },
  },
  usage: { input_tokens: 408, output_tokens: 67 },
};

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; raw?: string } = {},
): { fetch: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(init.raw ?? JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function options(fetch: typeof globalThis.fetch): TypesafeAiOptions {
  return { apiKey: 'test-key', fetch };
}

const CALL: EvaluationCall = {
  model: 'jev-latest',
  kind: 'boolean',
  state: 'payouts failing for three days',
  questions: {
    urgent: {
      type: 'boolean',
      instructions: 'Does this convey urgency?',
      criteria: { true: 'time-sensitive', false: 'no urgency' },
    },
  },
  signal: undefined,
};

function sentBody(calls: readonly Captured[]): Record<string, unknown> {
  const first = calls[0];
  assert.ok(first, 'expected a request');
  return JSON.parse(String(first.init.body)) as Record<string, unknown>;
}

describe('typesafe-ai adapter: request', () => {
  it('posts to the System One endpoint with a bearer credential', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY, { headers: { 'x-typesafe-request-id': REQUEST_ID } });
    await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    const first = calls[0];
    assert.ok(first);
    assert.equal(first.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(first.init.method, 'POST');
    assert.equal((first.init.headers as Record<string, string>)['authorization'], 'Bearer test-key');
  });

  it('sends a boolean question as a noul question', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    const body = sentBody(calls);
    assert.equal(body['model'], 'jev-latest');
    assert.deepEqual(body['questions'], {
      urgent: {
        type: 'noul',
        instructions: 'Does this convey urgency?',
        criteria: { true: 'time-sensitive', false: 'no urgency' },
      },
    });
  });

  it('omits boolean criteria entirely when the caller gave none', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await typesafeAiEvaluator(options(fetch)).evaluate({
      ...CALL,
      questions: { urgent: { type: 'boolean', instructions: 'urgent?' } },
    });

    const questions = sentBody(calls)['questions'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(questions['urgent'], { type: 'noul', instructions: 'urgent?' });
  });

  it('passes choice and score questions through unchanged', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await typesafeAiEvaluator(options(fetch)).evaluate({
      ...CALL,
      kind: 'score',
      questions: { severity: { type: 'score', instructions: 'how bad?', criteria: ['ok', 'bad'] } },
    });

    const questions = sentBody(calls)['questions'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(questions['severity'], {
      type: 'score',
      instructions: 'how bad?',
      criteria: ['ok', 'bad'],
    });
  });
});

describe('typesafe-ai adapter: response', () => {
  it('translates a noul answer back to a boolean probability', async () => {
    const { fetch } = stubFetch(LIVE_BODY, { headers: { 'x-typesafe-request-id': REQUEST_ID } });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.deepEqual(result.answers['urgent'], { type: 'boolean', probability: 0.96 });
    assert.deepEqual(result.usage, { input_tokens: 408, output_tokens: 67 });
    assert.equal(result.provider_response_id, REQUEST_ID);
  });

  it('carries score and choice answers with their probabilities', async () => {
    const { fetch } = stubFetch(LIVE_BODY);
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.deepEqual(result.answers['severity'], {
      type: 'score',
      score: 2.85,
      probabilities: { '0': 0, '1': 0, '2': 0.15, '3': 0.85 },
    });
    assert.deepEqual(result.answers['area'], {
      type: 'choice',
      choice: 'payments',
      probabilities: { auth: 0, payments: 1, ui: 0 },
    });
  });

  it('collects per-answer confidence, and reports none for a noul answer', async () => {
    const { fetch } = stubFetch(LIVE_BODY);
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    // `urgent` is absent: TypeSafe publishes no confidence for a noul answer.
    assert.deepEqual(result.confidence, { severity: 0.85, area: 1.0 });
  });

  it('reports a malformed response rather than inventing an answer', async () => {
    const { fetch } = stubFetch({ answers: { urgent: { type: 'noul' } }, usage: {} });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure.code, 'malformed_response');
    assert.equal(result.failure.retryable, false);
    assert.match(result.failure.message, /answer 'urgent' was not a recognised shape/);
  });

  it('reports a body that is not JSON as malformed', async () => {
    const { fetch } = stubFetch(undefined, { raw: '<html>gateway error</html>' });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    assert.equal(result.status === 'failed' && result.failure.code, 'malformed_response');
  });
});

describe('typesafe-ai adapter: failures', () => {
  const cases = [
    { status: 401, code: 'unauthorized', retryable: false },
    { status: 422, code: 'invalid_request', retryable: false },
    { status: 429, code: 'rate_limited', retryable: true },
    { status: 529, code: 'unavailable', retryable: true },
  ] as const;

  for (const expected of cases) {
    it(`maps ${expected.status} to ${expected.code}`, async () => {
      const { fetch } = stubFetch(
        { error: 'nope' },
        { status: expected.status, headers: { 'x-typesafe-request-id': REQUEST_ID } },
      );
      const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure.code, expected.code);
      assert.equal(result.failure.retryable, expected.retryable);
      // The request id is the only handle on a call that already happened.
      assert.match(result.failure.message, new RegExp(REQUEST_ID));
    });
  }

  it('treats a transport fault as retryable and does not throw', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;

    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure.code, 'unavailable');
    assert.equal(result.failure.retryable, true);
  });

  it('reports cancellation as cancelled, not as a fault', async () => {
    const fetch = (async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof globalThis.fetch;

    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status === 'failed' && result.failure.code, 'cancelled');
  });

  it('refuses to construct without a credential', () => {
    assert.throws(() => typesafeAiEvaluator({ apiKey: '  ' }), /requires an apiKey/);
  });

  it('identifies itself so a routed unit can name it', () => {
    const { fetch } = stubFetch(LIVE_BODY);
    assert.equal(typesafeAiEvaluator(options(fetch)).id, TYPESAFE_AI_ADAPTER);
  });
});
