/** Offline contract for the Muse Spark contributor adapter; all endpoints are injected. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MUSE_SPARK_ADAPTER,
  MUSE_SPARK_BASE_URL,
  MUSE_SPARK_DESTINATION,
  MUSE_SPARK_DOCUMENTED_CONTRIBUTOR_LIMITS,
  MUSE_SPARK_DEFAULT_SETTINGS,
  MUSE_SPARK_MIN_OUTPUT_TOKENS,
  MUSE_SPARK_FALLBACK_MODEL,
  MUSE_SPARK_PRIMARY_MODEL,
  museSparkAdapter,
} from '@weave/gateway/muse-spark';
import type { GenerationCall, GenerationProviderResult } from '@weave/gateway';

const KEY = 'sk-test-SENTINEL-muse-spark-credential';
const CALL: GenerationCall = {
  model: MUSE_SPARK_PRIMARY_MODEL,
  instructions: 'Be brief.',
  prompt: 'Reply with the single word: ok',
  settings: MUSE_SPARK_DEFAULT_SETTINGS,
  signal: undefined,
};
const BODY = {
  id: 'completion-1',
  model: MUSE_SPARK_PRIMARY_MODEL,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};
interface Captured { url: string; init: RequestInit }
function mockFetch(body: unknown = BODY, options: { status?: number; headers?: Record<string, string>; raw?: string } = {}) {
  const calls: Captured[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(options.raw ?? JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json', ...options.headers },
    });
  };
  return { calls, fetch };
}
function failureOf(result: GenerationProviderResult) {
  assert.equal(result.status, 'failed');
  assert.ok(result.status === 'failed');
  assert.ok(!JSON.stringify(result).includes(KEY), 'failure must not disclose the injected credential');
  return result.failure;
}

describe('muse-spark adapter contract', () => {
  it('exports a 1024-token minimum and default settings with room for default reasoning', () => {
    assert.equal(MUSE_SPARK_MIN_OUTPUT_TOKENS, 1024);
    assert.deepEqual(MUSE_SPARK_DEFAULT_SETTINGS, { max_output_tokens: MUSE_SPARK_MIN_OUTPUT_TOKENS });
  });

  it('rejects an insufficient or invalid output budget without sending', async () => {
    for (const max_output_tokens of [16, 1023, 0, -1, 1024.5, NaN, Infinity]) {
      const mock = mockFetch();
      const result = await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch }).execute({
        ...CALL, settings: { max_output_tokens },
      });
      const failure = failureOf(result);
      assert.equal(failure.code, 'invalid_request');
      assert.equal(failure.retryable, false);
      assert.equal(failure.message, 'muse-spark: settings.max_output_tokens must be an integer at least 1024 to leave room for default reasoning and text');
      assert.equal(mock.calls.length, 0);
    }
  });

  it('posts one SDK chat completion with the key only in its Bearer header and no reasoning parameter', async () => {
    const mock = mockFetch();
    const result = await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch }).execute(CALL);
    assert.equal(result.status, 'completed');
    assert.equal(mock.calls.length, 1);
    const sent = mock.calls[0]!;
    assert.equal(sent.url, `${MUSE_SPARK_BASE_URL}/chat/completions`);
    assert.equal(sent.init.method, 'POST');
    assert.equal(new Headers(sent.init.headers).get('authorization'), `Bearer ${KEY}`);
    assert.ok(!sent.url.includes(KEY));
    assert.ok(!String(sent.init.body).includes(KEY));
    const body = JSON.parse(String(sent.init.body)) as Record<string, unknown>;
    assert.equal(body['model'], 'muse-spark-1.3-contributor');
    assert.equal(body['max_tokens'], CALL.settings.max_output_tokens);
    assert.deepEqual(body['messages'], [
      { role: 'system', content: CALL.instructions },
      { role: 'user', content: CALL.prompt },
    ]);
    assert.ok(!('reasoning' in body));
    assert.ok(!('reasoning_effort' in body));
    assert.ok(!('temperature' in body));
    assert.deepEqual(result, {
      status: 'completed', text: 'ok', usage: { input_tokens: 12, output_tokens: 1 },
      finish_reason: 'stop', provider_response_id: 'completion-1',
    });
  });

  it('honours an injected base URL, temperature, and explicitly selected fallback model', async () => {
    const mock = mockFetch();
    await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch, baseURL: 'http://mock.invalid/v1/' }).execute({
      ...CALL, model: MUSE_SPARK_FALLBACK_MODEL, settings: { ...CALL.settings, temperature: 0.2 },
    });
    assert.equal(mock.calls[0]!.url, 'http://mock.invalid/v1/chat/completions');
    const body = JSON.parse(String(mock.calls[0]!.init.body)) as Record<string, unknown>;
    assert.equal(body['model'], 'muse-spark-1.2-contributor');
    assert.equal(body['temperature'], 0.2);
  });

  it('rejects missing, blank and invalid header credentials at construction without disclosing them', () => {
    for (const apiKey of ['', '   ', undefined, `${KEY}\r\nheader: value`]) {
      assert.throws(() => museSparkAdapter({ apiKey: apiKey as string }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /apiKey/);
        assert.ok(!error.message.includes(KEY));
        return true;
      });
    }
  });

  it('publishes provider identity and declared refusal-backoff limits', () => {
    assert.equal(museSparkAdapter({ apiKey: KEY }).id, MUSE_SPARK_ADAPTER);
    assert.equal(MUSE_SPARK_ADAPTER, 'muse-spark');
    assert.equal(MUSE_SPARK_DESTINATION, 'muse-spark-contributor');
    assert.equal(MUSE_SPARK_BASE_URL, 'https://api.meta.ai/v1');
    assert.deepEqual(MUSE_SPARK_DOCUMENTED_CONTRIBUTOR_LIMITS, [
      { requests: 150, tokens: 3_000_000, window_ms: 60_000 },
    ]);
  });

  for (const [status, code, retryable] of [
    [401, 'unauthorized', false], [403, 'unauthorized', false],
    [429, 'rate_limited', true], [500, 'unavailable', true], [503, 'unavailable', true],
    [404, 'invalid_request', false], [408, 'timeout', false],
  ] as const) {
    it(`maps HTTP ${status} to ${code} with no hidden retries or credential disclosure`, async () => {
      const mock = mockFetch({ error: { message: `rejected ${KEY}` } }, { status });
      const failure = failureOf(await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch }).execute(CALL));
      assert.equal(failure.code, code);
      assert.equal(failure.retryable, retryable);
      assert.equal(mock.calls.length, 1, 'maxRetries: 0 means one request per gateway attempt');
      assert.equal(failure.retry_after_ms, undefined, 'the gateway supplies declared-limit backoff');
    });
  }

  it('honours relative Retry-After exactly, including zero and fractional seconds', async () => {
    for (const [header, delay] of [['7', 7_000], ['0', 0], ['0.1255', 126]] as const) {
      const mock = mockFetch({}, { status: 429, headers: { 'retry-after': header } });
      const failure = failureOf(await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch }).execute(CALL));
      assert.equal(failure.retry_after_ms, delay, header);
    }
  });

  it('leaves absolute, negative and malformed Retry-After absent without consulting a clock', async () => {
    for (const header of ['Wed, 21 Oct 2026 07:28:00 GMT', '-1', 'NaN']) {
      const mock = mockFetch({}, { status: 429, headers: { 'retry-after': header } });
      assert.equal(failureOf(await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch }).execute(CALL)).retry_after_ms, undefined);
    }
  });

  it('fails closed on malformed JSON, empty choices, and absent text', async () => {
    for (const mock of [
      mockFetch(undefined, { raw: `<html>${KEY}</html>` }),
      mockFetch({ ...BODY, choices: [] }),
      mockFetch({ ...BODY, choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'length' }] }),
    ]) {
      const failure = failureOf(await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch }).execute(CALL));
      assert.equal(failure.code, 'malformed_response');
      assert.equal(failure.retryable, false);
    }
  });

  it('reports network faults without throwing, logging or returning the echoed key', async (t) => {
    const logs: unknown[][] = [];
    for (const method of ['log', 'warn', 'error', 'debug', 'info'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
    }
    let requests = 0;
    const fetch: typeof globalThis.fetch = async () => { requests++; throw new TypeError(`network failed ${KEY}`); };
    const result = await museSparkAdapter({ apiKey: KEY, fetch }).execute(CALL);
    const failure = failureOf(result);
    assert.equal(failure.code, 'unavailable');
    assert.equal(failure.retryable, true);
    assert.equal(requests, 1);
    assert.ok(!JSON.stringify(logs).includes(KEY));
  });

  it('redacts a credential maliciously echoed in successful response fields', async () => {
    const mock = mockFetch({ ...BODY, id: `echo-${KEY}`, choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `echo ${KEY}` } },
    ] });
    const result = await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch }).execute(CALL);
    assert.equal(result.status, 'completed');
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it('keeps omitted usage unknown rather than inventing zero', async () => {
    const mock = mockFetch({ ...BODY, usage: undefined });
    const result = await museSparkAdapter({ apiKey: KEY, fetch: mock.fetch }).execute(CALL);
    assert.ok(result.status === 'completed');
    assert.equal(result.usage.input_tokens, undefined);
    assert.equal(result.usage.output_tokens, undefined);
  });

  for (const [name, code] of [['AbortError', 'cancelled'], ['TimeoutError', 'timeout']] as const) {
    it(`propagates ${name} from the supplied signal to fetch without another request`, async () => {
      const controller = new AbortController();
      let started!: () => void;
      const start = new Promise<void>((resolve) => { started = resolve; });
      let requests = 0;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        requests++;
        assert.ok(init?.signal);
        started();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      };
      const pending = museSparkAdapter({ apiKey: KEY, fetch }).execute({ ...CALL, signal: controller.signal });
      assert.equal(await Promise.race([start.then(() => 'started'), pending.then(() => 'completed')]), 'started', 'the request must reach the injected fetch');
      controller.abort(new DOMException(`stop ${KEY}`, name));
      const failure = failureOf(await pending);
      assert.equal(failure.code, code);
      assert.equal(failure.retryable, false);
      assert.equal(requests, 1);
    });
  }

  it('isolates concurrent requests, credentials, and rate-limit failures', async () => {
    const mocks = Array.from({ length: 8 }, (_, i) => mockFetch(i === 0 ? {} : BODY, { status: i === 0 ? 429 : 200 }));
    const results = await Promise.all(mocks.map((mock, i) => museSparkAdapter({ apiKey: `${KEY}-${i}`, fetch: mock.fetch }).execute({ ...CALL, prompt: `public ${i}` })));
    assert.equal(results[0]!.status, 'failed');
    for (const [i, mock] of mocks.entries()) {
      assert.equal(mock.calls.length, 1);
      assert.equal(new Headers(mock.calls[0]!.init.headers).get('authorization'), `Bearer ${KEY}-${i}`);
      assert.ok(String(mock.calls[0]!.init.body).includes(`public ${i}`));
      if (i > 0) assert.equal(results[i]!.status, 'completed');
    }
    const shared = mockFetch();
    const adapter = museSparkAdapter({ apiKey: KEY, fetch: shared.fetch });
    await Promise.all(Array.from({ length: 8 }, (_, i) => adapter.execute({ ...CALL, prompt: `shared ${i}` })));
    assert.equal(shared.calls.length, 8);
    assert.equal(new Set(shared.calls.map((sent) => String(sent.init.body))).size, 8);
  });
});
