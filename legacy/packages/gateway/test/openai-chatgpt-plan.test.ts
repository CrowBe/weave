import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openaiChatgptPlanAdapter, OPENAI_CHATGPT_PLAN_DESTINATION } from '@weave/gateway/openai-chatgpt-plan';
import type { GenerationCall } from '@weave/gateway';

const TOKEN = 'secret-access-canary';
const CALL: GenerationCall = {
  model: 'available-model',
  instructions: 'Be brief.',
  prompt: 'Hello',
  settings: { max_output_tokens: 100, temperature: 0.2 },
  signal: undefined,
};
function event(type: string, rest: Record<string, unknown> = {}) {
  return `event: ${type}\r\ndata: ${JSON.stringify({ type, ...rest })}\r\n\r\n`;
}
const completed = event('response.completed', {
  response: {
    id: 'resp_1',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello, world!' }] }],
    usage: { input_tokens: 4, output_tokens: 3 },
  },
});
function fake(body: string, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return async () => new Response(body, { status, headers });
}
async function failure(body: string, status = 200) {
  const result = await openaiChatgptPlanAdapter({ accessToken: TOKEN, fetch: fake(body, status) }).execute(CALL);
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') throw Error('expected failure');
  return result.failure;
}
describe('ChatGPT plan Responses adapter', () => {
  it('sends only supported fields and accepts a completed stream across arbitrary byte boundaries', async () => {
    let request: RequestInit | undefined;
    let url = '';
    const fetcher: typeof fetch = async (input, init) => {
      url = String(input);
      request = init;
      const bytes = new TextEncoder().encode(
        event('response.output_text.delta', { delta: 'ignored partial' }) + completed,
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      );
    };
    const result = await openaiChatgptPlanAdapter({ accessToken: async () => TOKEN, fetch: fetcher }).execute(CALL);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(request?.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(String(request?.body)), {
      model: CALL.model,
      input: [{ role: 'user', content: CALL.prompt }],
      instructions: CALL.instructions,
      store: false,
      stream: true,
    });
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') {
      assert.equal(result.text, 'Hello, world!');
      assert.equal(result.provider_response_id, 'resp_1');
      assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 3 });
    }
    assert.equal(OPENAI_CHATGPT_PLAN_DESTINATION, 'openai.chatgpt-plan');
  });
  for (const [code, expected, retryable] of [
    ['subscription_sharing_usage_limit_exceeded', 'quota_exhausted', false],
    ['subscription_sharing_usage_unavailable', 'unavailable', true],
    ['subscription_sharing_user_not_eligible', 'unauthorized', false],
    ['subscription_sharing_unsupported_capability', 'invalid_request', false],
  ] as const) {
    it(`maps ${code} without accepting prior deltas`, async () => {
      const result = await failure(
        event('response.output_text.delta', { delta: 'partial' }) +
          event('response.failed', { response: { error: { code, param: 'model', message: TOKEN } } }),
      );
      assert.equal(result.code, expected);
      assert.equal(result.retryable, retryable);
      assert.ok(result.message.includes(code));
      assert.ok(!JSON.stringify(result).includes(TOKEN));
    });
  }
  it('rejects incomplete, interrupted, explicit error and malformed streams', async () => {
    assert.equal(
      (
        await failure(
          event('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } }),
        )
      ).code,
      'malformed_response',
    );
    assert.equal((await failure(event('response.output_text.delta', { delta: 'partial' }))).code, 'unavailable');
    assert.equal(
      (await failure(event('error', { code: 'subscription_sharing_usage_limit_exceeded' }))).code,
      'quota_exhausted',
    );
    assert.equal((await failure('data: {bad json}\n\n')).code, 'malformed_response');
  });
  it('maps undocumented stream failure codes to retryable unavailable', async () => {
    for (const body of [
      event('response.failed', { response: { error: { code: 'server_error', message: 'internal' } } }),
      event('response.failed', { response: { status: 'failed' } }),
      event('error', { code: 'future_unlisted_code' }),
    ]) {
      const result = await failure(body);
      assert.equal(result.code, 'unavailable');
      assert.equal(result.retryable, true);
    }
  });
  for (const [status, code] of [
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'invalid_request'],
  ] as const) {
    it(`maps HTTP ${status} and redacts body diagnostics`, async () => {
      const result = await failure(JSON.stringify({ detail: TOKEN }), status);
      assert.equal(result.code, code);
      assert.ok(result.message.includes(String(status)));
      assert.ok(!JSON.stringify(result).includes(TOKEN));
    });
  }
  it('redacts escaped and URL-encoded credential echoes', async () => {
    const token = 'secret-"slash\\-end';
    const variants = [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)];
    const result = await openaiChatgptPlanAdapter({
      accessToken: token,
      fetch: fake(JSON.stringify({ detail: token, encoded: encodeURIComponent(token) }), 401),
    }).execute(CALL);
    for (const variant of variants) assert.ok(!JSON.stringify(result).includes(variant));
    const streamResult = await openaiChatgptPlanAdapter({
      accessToken: token,
      fetch: fake(
        event('response.failed', {
          response: {
            error: {
              code: 'subscription_sharing_usage_limit_exceeded',
              message: token,
              param: encodeURIComponent(token),
            },
          },
        }),
      ),
    }).execute(CALL);
    for (const variant of variants) assert.ok(!JSON.stringify(streamResult).includes(variant));
  });
  it('classifies stream read failures and token-provider errors without leaking exceptions', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(TOKEN));
          },
        }),
      );
    const result = await openaiChatgptPlanAdapter({ accessToken: TOKEN, fetch: fetcher }).execute(CALL);
    assert.equal(result.status, 'failed');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    const auth = await openaiChatgptPlanAdapter({
      accessToken: () => {
        throw Error(TOKEN);
      },
      fetch: fake(completed),
    }).execute(CALL);
    assert.equal(auth.status, 'failed');
    assert.ok(!JSON.stringify(auth).includes(TOKEN));
  });
  it('cancels a pending stream read and preserves the injected signal', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    let entered!: () => void;
    const opened = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let cancelled = false;
    const fetcher: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream({
          pull() {
            entered();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    };
    const pending = openaiChatgptPlanAdapter({ accessToken: TOKEN, fetch: fetcher }).execute({
      ...CALL,
      signal: controller.signal,
    });
    await opened;
    controller.abort();
    const result = await pending;
    assert.equal(signal, controller.signal);
    assert.equal(cancelled, true);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.failure.code, 'cancelled');
  });
  it('forwards cancellation and never dispatches an already cancelled call', async () => {
    const controller = new AbortController();
    controller.abort();
    let dispatched = false;
    const result = await openaiChatgptPlanAdapter({
      accessToken: TOKEN,
      fetch: async () => {
        dispatched = true;
        return new Response(completed);
      },
    }).execute({ ...CALL, signal: controller.signal });
    assert.equal(dispatched, false);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.failure.code, 'cancelled');
  });
});
