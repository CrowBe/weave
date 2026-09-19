/**
 * The OpenAI-compatible protocol, exercised through the OpenRouter adapter:
 * request shape, response parsing, and the failure classification that decides
 * whether the gateway waits or escalates. `nous-portal.test.ts` covers what
 * the other provider over the same protocol does differently.
 *
 * Offline. `fetch` is injected. The success fixture is copied from a live call
 * to `nvidia/nemotron-3-ultra-550b-a55b:free`, not invented, so the reasoning
 * fields a reasoning model actually returns are represented.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OPEN_ROUTER_ADAPTER,
  OPEN_ROUTER_DOCUMENTED_FREE_LIMITS,
  openRouterAdapter,
} from '@weave/gateway/open-router';
import type { GenerationCall } from '@weave/gateway';

/** A live response, trimmed to the fields the adapter reads. */
const LIVE_BODY = {
  id: 'gen-1789816676-GVMQdP1MhzdGlshYtPjZ',
  model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  provider: 'Nvidia',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      native_finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '**Fish and chips**',
        refusal: null,
        reasoning: 'The user wants one traditional food named in three words or less.',
      },
    },
  ],
  usage: {
    prompt_tokens: 25,
    completion_tokens: 20,
    total_tokens: 45,
    cost: 0,
    completion_tokens_details: { reasoning_tokens: 17 },
  },
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

function throwingFetch(error: Error): typeof globalThis.fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof globalThis.fetch;
}

const CALL: GenerationCall = {
  model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  instructions: 'Be brief.',
  prompt: 'Name one traditional food.',
  settings: { max_output_tokens: 400 },
  signal: undefined,
};

function bodyOf(captured: Captured): Record<string, unknown> {
  return JSON.parse(String(captured.init.body)) as Record<string, unknown>;
}

async function failureOf(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; raw?: string } = {},
) {
  const { fetch } = stubFetch(body, init);
  const result = await openRouterAdapter({ apiKey: 'k', fetch }).execute(CALL);
  assert.equal(result.status, 'failed');
  assert.ok(result.status === 'failed');
  return result.failure;
}

// ---------------------------------------------------------------------------

describe('open-router adapter: request', () => {
  it('posts an OpenAI-shaped completion to /chat/completions with a bearer token', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await openRouterAdapter({ apiKey: 'test-key', fetch }).execute(CALL);

    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(call.init.method, 'POST');
    assert.equal(
      (call.init.headers as Record<string, string>)['authorization'],
      'Bearer test-key',
    );

    const body = bodyOf(call);
    assert.equal(body['model'], 'nvidia/nemotron-3-ultra-550b-a55b:free');
    assert.equal(body['max_tokens'], 400);
    assert.deepEqual(body['messages'], [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Name one traditional food.' },
    ]);
  });

  it('sends no system message when there are no instructions', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await openRouterAdapter({ apiKey: 'k', fetch }).execute({ ...CALL, instructions: '   ' });

    const call = calls[0];
    assert.ok(call);
    assert.deepEqual(bodyOf(call)['messages'], [
      { role: 'user', content: 'Name one traditional food.' },
    ]);
  });

  it('sends temperature only when the settings name one', async () => {
    const bare = stubFetch(LIVE_BODY);
    await openRouterAdapter({ apiKey: 'k', fetch: bare.fetch }).execute(CALL);
    const first = bare.calls[0];
    assert.ok(first);
    assert.ok(!('temperature' in bodyOf(first)));

    const warm = stubFetch(LIVE_BODY);
    await openRouterAdapter({ apiKey: 'k', fetch: warm.fetch }).execute({
      ...CALL,
      settings: { max_output_tokens: 400, temperature: 0.2 },
    });
    const second = warm.calls[0];
    assert.ok(second);
    assert.equal(bodyOf(second)['temperature'], 0.2);
  });

  it('honours a custom base URL without doubling the slash', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await openRouterAdapter({ apiKey: 'k', fetch, baseURL: 'http://localhost:9/v1/' }).execute(CALL);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'http://localhost:9/v1/chat/completions');
  });
});

describe('open-router adapter: response', () => {
  it('reads text, usage, finish reason and generation id from a live response', async () => {
    const { fetch } = stubFetch(LIVE_BODY);
    const result = await openRouterAdapter({ apiKey: 'k', fetch }).execute(CALL);

    assert.ok(result.status === 'completed');
    assert.equal(result.text, '**Fish and chips**');
    assert.equal(result.finish_reason, 'stop');
    assert.equal(result.provider_response_id, 'gen-1789816676-GVMQdP1MhzdGlshYtPjZ');
    assert.equal(result.usage.input_tokens, 25);
    // 20 completion tokens, of which 17 were reasoning. The reasoning tokens
    // are billed and consume the output cap, so they belong in the charge.
    assert.equal(result.usage.output_tokens, 20);
  });

  it('reports usage as unknown rather than zero when the provider omits it', async () => {
    const { fetch } = stubFetch({ ...LIVE_BODY, usage: undefined });
    const result = await openRouterAdapter({ apiKey: 'k', fetch }).execute(CALL);

    assert.ok(result.status === 'completed');
    assert.equal(result.usage.input_tokens, undefined);
    assert.equal(result.usage.output_tokens, undefined);
  });

  it('treats an error carried in a 200 body as a failure', async () => {
    const failure = await failureOf({
      error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } },
    });
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.retryable, true);
  });

  it('fails when a reasoning model returns no content', async () => {
    const failure = await failureOf({
      id: 'gen-1',
      choices: [{ finish_reason: 'length', message: { role: 'assistant', reasoning: 'thinking...' } }],
    });
    assert.equal(failure.code, 'malformed_response');
    assert.match(failure.message, /no text content/);
  });

  it('fails when the response carries no choices', async () => {
    const failure = await failureOf({ id: 'gen-1', choices: [] });
    assert.equal(failure.code, 'malformed_response');
    assert.match(failure.message, /no choices/);
  });

  it('fails when the body is not JSON', async () => {
    const failure = await failureOf(null, { raw: '<html>502</html>' });
    assert.equal(failure.code, 'malformed_response');
    assert.match(failure.message, /not JSON/);
  });
});

describe('open-router adapter: failure classification', () => {
  it('maps a 429 with Retry-After to a retryable rate limit carrying the delay', async () => {
    const failure = await failureOf(
      { error: { message: 'Rate limit exceeded', code: 429 } },
      { status: 429, headers: { 'retry-after': '7' } },
    );
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.retryable, true);
    // Seconds on the wire, milliseconds in the port.
    assert.equal(failure.retry_after_ms, 7_000);
  });

  it('leaves the delay absent when a 429 states none', async () => {
    const failure = await failureOf({ error: { message: 'slow down', code: 429 } }, { status: 429 });
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.retryable, true);
    assert.equal(failure.retry_after_ms, undefined);
  });

  it('ignores an unparseable Retry-After rather than waiting a NaN', async () => {
    const failure = await failureOf({}, { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    assert.equal(failure.retry_after_ms, undefined);
  });

  it('maps credential and credit refusals to a non-retryable unauthorized', async () => {
    for (const status of [401, 402, 403]) {
      const failure = await failureOf({ error: { message: 'nope', code: status } }, { status });
      assert.equal(failure.code, 'unauthorized', `status ${status}`);
      assert.equal(failure.retryable, false, `status ${status}`);
    }
  });

  it('maps 5xx to a retryable unavailable and 4xx to a non-retryable invalid request', async () => {
    const server = await failureOf({}, { status: 503 });
    assert.equal(server.code, 'unavailable');
    assert.equal(server.retryable, true);

    const client = await failureOf({ error: { message: 'bad model', code: 400 } }, { status: 400 });
    assert.equal(client.code, 'invalid_request');
    assert.equal(client.retryable, false);
  });

  it('reports a transport fault as retryable and a cancellation as not', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const cancelled = await openRouterAdapter({ apiKey: 'k', fetch: throwingFetch(abort) }).execute(CALL);
    assert.ok(cancelled.status === 'failed');
    assert.equal(cancelled.failure.code, 'cancelled');
    assert.equal(cancelled.failure.retryable, false);

    const down = await openRouterAdapter({
      apiKey: 'k',
      fetch: throwingFetch(new TypeError('fetch failed')),
    }).execute(CALL);
    assert.ok(down.status === 'failed');
    assert.equal(down.failure.code, 'unavailable');
    assert.equal(down.failure.retryable, true);
  });
});

describe('open-router adapter: construction', () => {
  it('refuses to build without a credential rather than failing at call time', () => {
    assert.throws(() => openRouterAdapter({ apiKey: '  ' }), /requires an apiKey/);
  });

  it('identifies itself by the id a routed unit names', () => {
    assert.equal(openRouterAdapter({ apiKey: 'k' }).id, OPEN_ROUTER_ADAPTER);
    assert.equal(OPEN_ROUTER_ADAPTER, 'open-router');
  });

  it('publishes the documented free-tier limits for a route to declare', () => {
    // A minute window of 20 implies 3s spacing, which is what the gateway
    // waits when a refusal states no delay of its own. Documented, not
    // measured: 25 concurrent requests were not refused.
    assert.deepEqual([...OPEN_ROUTER_DOCUMENTED_FREE_LIMITS], [
      { requests: 20, window_ms: 60_000 },
      { requests: 50, window_ms: 86_400_000 },
    ]);
  });
});
