/**
 * The Nous Portal adapter.
 *
 * The protocol it speaks is covered by `open-router.test.ts`; what is asserted
 * here is what Nous does differently — it states an exact reset on a refusal,
 * so the gateway waits a measured delay rather than an estimate — plus the
 * identity and catalogue strings a routed unit has to name correctly.
 *
 * Offline. `fetch` is injected. The success fixture and the header set are
 * copied from a live call to `meituan/longcat-2.0:free`, not invented.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NOUS_PORTAL_ADAPTER,
  NOUS_PORTAL_BASE_URL,
  NOUS_PORTAL_FREE_MODELS,
  NOUS_PORTAL_OBSERVED_FREE_LIMITS,
  nousPortalAdapter,
} from '@weave/gateway/nous-portal';
import type { GenerationCall } from '@weave/gateway';

/** A live response. Note `delta`, `matched_stop` and `lastOne`, which the
 *  adapter ignores, and the absence of OpenRouter's `cost` field. */
const LIVE_BODY = {
  id: 'f68d2947d59b42a6a9827beb5920f0cd',
  object: 'chat.completion',
  created: 1789817125,
  model: 'meituan/longcat-2.0:free',
  choices: [
    {
      delta: null,
      index: 0,
      finish_reason: 'stop',
      matched_stop: 2,
      message: { role: 'assistant', content: 'Sushi' },
      logprobs: null,
    },
  ],
  usage: { completion_tokens: 3, prompt_tokens: 23, total_tokens: 26 },
  lastOne: false,
};

/** The header set a live call returns, on success as well as on refusal. */
const LIVE_HEADERS = {
  'x-ratelimit-limit-requests': '400',
  'x-ratelimit-limit-requests-1h': '16800',
  'x-ratelimit-limit-tokens': '4000000',
  'x-ratelimit-remaining-requests': '399',
  'x-ratelimit-reset-requests': '59.999',
  'x-ratelimit-reset-tokens': '58.399',
};

function stubFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
}

const CALL: GenerationCall = {
  model: NOUS_PORTAL_FREE_MODELS.longcat,
  instructions: 'Be brief.',
  prompt: 'Name one traditional food.',
  settings: { max_output_tokens: 300 },
  signal: undefined,
};

async function refusalWith(headers: Record<string, string>) {
  const { fetch } = stubFetch({ error: { message: 'rate limited', code: 429 } }, { status: 429, headers });
  const result = await nousPortalAdapter({ apiKey: 'k', fetch }).execute(CALL);
  assert.ok(result.status === 'failed');
  return result.failure;
}

// ---------------------------------------------------------------------------

describe('nous-portal adapter', () => {
  it('reads a live response through the shared protocol', async () => {
    const { fetch, urls } = stubFetch(LIVE_BODY, { headers: LIVE_HEADERS });
    const result = await nousPortalAdapter({ apiKey: 'k', fetch }).execute(CALL);

    assert.equal(urls[0], 'https://inference-api.nousresearch.com/v1/chat/completions');
    assert.ok(result.status === 'completed');
    assert.equal(result.text, 'Sushi');
    assert.equal(result.finish_reason, 'stop');
    assert.equal(result.provider_response_id, 'f68d2947d59b42a6a9827beb5920f0cd');
    assert.equal(result.usage.input_tokens, 23);
    assert.equal(result.usage.output_tokens, 3);
  });

  it('turns the relative reset header into an exact retry delay', async () => {
    const failure = await refusalWith(LIVE_HEADERS);
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.retryable, true);
    // 59.999s of requests-reset against 58.399s of tokens-reset: the later
    // one, because returning while the other limit still bites earns a
    // second refusal.
    assert.equal(failure.retry_after_ms, 59_999);
  });

  it('waits for the token limit when that is the one further out', async () => {
    const failure = await refusalWith({
      'x-ratelimit-reset-requests': '2',
      'x-ratelimit-reset-tokens': '45.5',
    });
    assert.equal(failure.retry_after_ms, 45_500);
  });

  it('prefers a standard Retry-After over the vendor headers', async () => {
    const failure = await refusalWith({ ...LIVE_HEADERS, 'retry-after': '3' });
    assert.equal(failure.retry_after_ms, 3_000);
  });

  it('states no delay when the refusal carries no reset headers', async () => {
    const failure = await refusalWith({});
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.retry_after_ms, undefined);
  });

  it('is a distinct adapter from the one sharing its protocol', () => {
    assert.equal(nousPortalAdapter({ apiKey: 'k' }).id, NOUS_PORTAL_ADAPTER);
    assert.equal(NOUS_PORTAL_ADAPTER, 'nous-portal');
    assert.equal(NOUS_PORTAL_BASE_URL, 'https://inference-api.nousresearch.com/v1');
  });

  it('refuses to build without a credential rather than failing at call time', () => {
    assert.throws(() => nousPortalAdapter({ apiKey: '' }), /nousPortalAdapter requires an apiKey/);
  });

  it('names the seven zero-priced models with the :free suffix that makes them free', () => {
    const ids = Object.values(NOUS_PORTAL_FREE_MODELS);
    assert.equal(ids.length, 7);
    for (const id of ids) assert.ok(id.endsWith(':free'), `${id} must carry the :free suffix`);
    assert.deepEqual([...NOUS_PORTAL_OBSERVED_FREE_LIMITS], [
      { requests: 400, window_ms: 60_000 },
      { requests: 16_800, window_ms: 3_600_000 },
    ]);
  });
});
