/**
 * Muse Spark contributor competitor, on a stubbed fetch only. No live call is
 * possible or attempted here; nothing in this file is benchmark evidence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MUSE_SPARK_FALLBACK_MODEL,
  MUSE_SPARK_MIN_OUTPUT_TOKENS,
  MUSE_SPARK_PRIMARY_MODEL,
} from '@weave/gateway/muse-spark';
import { competitorPrompt, museSparkCompetitor } from '../competitors.ts';
import { flags } from '../run.ts';
import type { Request } from '../types.ts';

const KEY = 'sk-test-MUSE-CANARY';
const request: Request = {
  state: { text: 'Alphabetize pear, apple.' },
  questions: { q: { type: 'choice', instructions: 'Which tier?', criteria: { flash: 'Flash', strong: 'Strong' } } },
};
const answers = { q: { choice: 'flash', confidence: 0.8 } };

function completion(text: string, usage = { prompt_tokens: 40, completion_tokens: 300 }): Response {
  return new Response(
    JSON.stringify({
      id: 'stub',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function refused(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message: KEY } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
interface Seen {
  url: string;
  authorization: string | null;
  body: Record<string, any>;
}
function stub(respond: (body: Record<string, any>, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    seen.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body });
    return respond(body, seen.length);
  };
  return { seen, fetch };
}
const make = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof museSparkCompetitor>[0]> = {}) =>
  museSparkCompetitor({ apiKey: KEY, contentClass: 'non_sensitive', fetch, now: () => 0, ...extra });

test('Muse Spark is a zero-price competitor that sends the shared competitor prompt with the reasoning budget', async () => {
  const { seen, fetch } = stub(() => completion(JSON.stringify({ answers })));
  const p = make(fetch);
  assert.equal(p.id, 'muse-spark');
  assert.equal(p.model, MUSE_SPARK_PRIMARY_MODEL);
  assert.equal(p.competitor, true);
  assert.equal(p.price, 0);
  assert.equal(p.serialize(request), competitorPrompt(request));
  const result = await p.request(request, new AbortController().signal);
  assert.deepEqual(result, {
    status: 'ok',
    model: MUSE_SPARK_PRIMARY_MODEL,
    answers,
    input_tokens: 40,
    output_tokens: 300,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(seen[0]!.authorization, `Bearer ${KEY}`);
  assert.equal(seen[0]!.body['model'], MUSE_SPARK_PRIMARY_MODEL);
  assert.ok(seen[0]!.body['max_tokens'] >= MUSE_SPARK_MIN_OUTPUT_TOKENS);
  assert.equal(seen[0]!.body['reasoning'], undefined);
  assert.equal(seen[0]!.body['reasoning_effort'], undefined);
  assert.equal(seen[0]!.body['messages'].at(-1).content, competitorPrompt(request));
});

test('only public or non_sensitive content may reach the training-allowed contributor destination', () => {
  const { fetch } = stub(() => completion('{}'));
  for (const contentClass of [undefined, 'sensitive', 'private', 'secret'])
    assert.throws(
      () => museSparkCompetitor({ apiKey: KEY, contentClass: contentClass as never, fetch, now: () => 0 }),
      /public or non_sensitive/,
    );
  for (const contentClass of ['public', 'non_sensitive'] as const)
    assert.equal(make(fetch, { contentClass }).id, 'muse-spark');
  // The live CLI requires the operator's classification before it builds the competitor.
  assert.throws(() => flags(['--providers', 'muse-spark']), /content-class/);
  assert.throws(() => flags(['--providers', 'muse-spark', '--content-class', 'private']), /content-class/);
  assert.equal(flags(['--providers', 'muse-spark', '--content-class', 'non_sensitive']).contentClass, 'non_sensitive');
  assert.equal(
    flags([]).providers.includes('muse-spark'),
    false,
    'opt-in only: never part of the default provider set',
  );
});

test('credential-shaped content is never sent to the contributor destination', async () => {
  const { seen, fetch } = stub(() => completion(JSON.stringify({ answers })));
  const leaky: Request = { ...request, state: { text: 'deploy with Bearer abc123' } };
  const result = await make(fetch).request(leaky, new AbortController().signal);
  assert.deepEqual(result, { status: 'failed', reason: 'credential_content' });
  assert.equal(seen.length, 0);
});

test('a primary refusal escalates once to the declared 1.2 fallback, which is recorded as the served model', async () => {
  const { seen, fetch } = stub((body) =>
    body['model'] === MUSE_SPARK_PRIMARY_MODEL
      ? refused(503)
      : completion(JSON.stringify({ answers }), { prompt_tokens: 41, completion_tokens: 260 }),
  );
  const result = await make(fetch).request(request, new AbortController().signal);
  assert.deepEqual(
    seen.map((s) => s.body['model']),
    [MUSE_SPARK_PRIMARY_MODEL, MUSE_SPARK_FALLBACK_MODEL],
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.model, MUSE_SPARK_FALLBACK_MODEL);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('a refused credential skips the provider without trying the fallback, and stays skipped', async () => {
  for (const status of [401, 403]) {
    const { seen, fetch } = stub(() => refused(status));
    const p = make(fetch);
    const first = await p.request(request, new AbortController().signal);
    assert.deepEqual(first, { status: 'skipped', reason: 'unauthorized' });
    assert.deepEqual(await p.request(request, new AbortController().signal), first);
    assert.equal(seen.length, 1);
  }
  const { seen, fetch } = stub(() => completion('{}'));
  for (const apiKey of [undefined, '', '   ']) {
    assert.deepEqual(await make(fetch, { apiKey }).request(request, new AbortController().signal), {
      status: 'skipped',
      reason: 'no_credential',
    });
  }
  assert.equal(seen.length, 0);
});

test('rate limits on both models surface as HTTP 429 with the delay so the engine bounds retries', async () => {
  const { seen, fetch } = stub(() => refused(429, { 'retry-after': '2' }));
  const result = await make(fetch).request(request, new AbortController().signal);
  assert.deepEqual(result, { status: 'failed', reason: 'rate_limited', http_status: 429, retry_after_ms: 2000 });
  assert.equal(seen.length, 2);
});

test('unparseable output is a parse failure, not an answer', async () => {
  const { fetch } = stub(() => completion('I think flash.'));
  assert.deepEqual(await make(fetch).request(request, new AbortController().signal), {
    status: 'failed',
    reason: 'non_json_output',
    parse_failure: true,
    model: MUSE_SPARK_PRIMARY_MODEL,
    input_tokens: 40,
    output_tokens: 300,
  });
});

test('cancellation before dispatch is retryable; after dispatch it is terminal; a timeout is its own failure', async () => {
  const before = new AbortController();
  before.abort();
  const idle = stub(() => completion('{}'));
  assert.deepEqual(await make(idle.fetch).request(request, before.signal), { status: 'failed', reason: 'cancelled' });
  assert.equal(idle.seen.length, 0);
  const during = new AbortController();
  const hanging = (signal: AbortSignal | null | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const dispatched: typeof globalThis.fetch = async (_url, init) => {
    setImmediate(() => during.abort());
    return hanging(init?.signal);
  };
  assert.deepEqual(await make(dispatched).request(request, during.signal), {
    status: 'failed',
    reason: 'cancelled_after_dispatch',
  });
  const slow: typeof globalThis.fetch = async (_url, init) => hanging(init?.signal);
  // Keep a fake transport handle alive, like a real socket; AbortSignal timeout alone is unref'ed.
  const keeper = setTimeout(() => {}, 1000);
  try {
    assert.deepEqual(await make(slow, { timeoutMs: 5 }).request(request, new AbortController().signal), {
      status: 'failed',
      reason: 'timeout',
    });
  } finally {
    clearTimeout(keeper);
  }
});
