/** Offline contract: exact free ids, live guard, SDK wire shape, secrecy and abort isolation. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  opencodeZenAdapter, OPENCODE_ZEN_ADAPTER, OPENCODE_ZEN_DESTINATION,
  OPENCODE_ZEN_BASE_URL, OPENCODE_ZEN_MODELS_URL, OPENCODE_ZEN_MODEL,
} from '@weave/gateway/opencode-zen';
import type { GenerationCall, GenerationProviderResult } from '@weave/gateway';

const KEY = 'sk-test-SENTINEL-WV011';
const CALL: GenerationCall = {
  model: 'deepseek-v4.1-flash-free', instructions: 'Be brief.', prompt: 'Reply with the single word: ok',
  settings: { max_output_tokens: 4096 }, signal: undefined,
};
const BODY = {
  id: 'zen-1', model: CALL.model, created: 1,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32, completion_tokens_details: { reasoning_tokens: 18 } },
};
const LIST = { data: [{ id: CALL.model }, { id: 'deepseek-v4.1-flash' }] };
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
interface Sent { url: string; init: RequestInit }
function mock(list: () => Response | Promise<Response> = () => json(LIST), generation: () => Response | Promise<Response> = () => json(BODY)) {
  const calls: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return String(url) === OPENCODE_ZEN_MODELS_URL ? list() : generation();
  };
  return { fetch, calls, adapter: () => opencodeZenAdapter({ apiKey: KEY, fetch }) };
}
function failure(result: GenerationProviderResult) {
  assert.equal(result.status, 'failed');
  assert.ok(result.status === 'failed');
  assert.ok(!JSON.stringify(result).includes(KEY));
  return result.failure;
}
function assertUnavailable(result: GenerationProviderResult) {
  const f = failure(result);
  assert.equal(f.code, 'unavailable');
  assert.equal(f.retryable, false);
  assert.equal(f.retry_after_ms, undefined);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('opencode-zen free-model contract', () => {
  it('publishes separate adapter, non-training destination and fixed endpoints', () => {
    assert.equal(OPENCODE_ZEN_ADAPTER, 'opencode-zen');
    assert.equal(OPENCODE_ZEN_DESTINATION, 'opencode-zen.deepseek-free');
    assert.equal(OPENCODE_ZEN_BASE_URL, 'https://opencode.ai/inference/openai/v1');
    assert.equal(OPENCODE_ZEN_MODELS_URL, 'https://opencode.ai/inference/v1/models');
    assert.equal(OPENCODE_ZEN_MODEL, CALL.model);
    assert.equal(opencodeZenAdapter({ apiKey: KEY }).id, OPENCODE_ZEN_ADAPTER);
  });
  it('gets the public live list without a key then posts exactly one authenticated SDK completion', async () => {
    const m = mock();
    const result = await m.adapter().execute(CALL);
    assert.equal(result.status, 'completed');
    assert.deepEqual(m.calls.map(c => [c.url, c.init.method]), [
      [OPENCODE_ZEN_MODELS_URL, 'GET'], [`${OPENCODE_ZEN_BASE_URL}/chat/completions`, 'POST'],
    ]);
    const list = m.calls[0]!;
    assert.equal(new Headers(list.init.headers).has('authorization'), false);
    assert.ok(!JSON.stringify(list).includes(KEY));
    const sent = m.calls[1]!;
    assert.equal(new Headers(sent.init.headers).get('authorization'), `Bearer ${KEY}`);
    const body = JSON.parse(String(sent.init.body));
    assert.equal(body.model, OPENCODE_ZEN_MODEL);
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: CALL.prompt }]);
    assert.equal(body.temperature, undefined);
    assert.ok(result.status === 'completed');
    assert.equal(result.text, 'ok');
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 20 });
    assert.equal(result.finish_reason, 'stop');
    assert.equal(result.provider_response_id, 'zen-1');
  });
  it('omits blank instructions, forwards temperature and keeps unknown usage unknown', async () => {
    const m = mock(undefined, () => json({ ...BODY, usage: undefined }));
    const result = await m.adapter().execute({ ...CALL, instructions: '  ', settings: { max_output_tokens: 4096, temperature: 0.2 } });
    assert.ok(result.status === 'completed');
    assert.deepEqual(result.usage, { input_tokens: undefined, output_tokens: undefined });
    const body = JSON.parse(String(m.calls[1]!.init.body));
    assert.deepEqual(body.messages, [{ role: 'user', content: CALL.prompt }]);
    assert.equal(body.temperature, 0.2);
  });
  for (const model of ['deepseek-v4.1-flash', 'Deepseek-v4.1-flash-free', ' deepseek-v4.1-flash-free', 'deepseek-v4.1-flash-free ', 'muse-spark-1.3-contributor-free', '', 'other-free']) {
    it(`rejects non-allowlisted id ${JSON.stringify(model)} before any request`, async () => {
      const m = mock();
      const f = failure(await m.adapter().execute({ ...CALL, model }));
      assert.equal(f.code, 'invalid_request');
      assert.equal(f.retryable, false);
      assert.equal(m.calls.length, 0);
    });
  }
  const badLists: [string, () => Response | Promise<Response>][] = [
    ['missing exact free id', () => json({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'Deepseek-v4.1-flash-free' }] })],
    ['HTTP 500', () => json({ error: KEY }, 500)], ['HTTP 401', () => json({ error: KEY }, 401)],
    ['network failure', () => { throw new Error(`network ${KEY}`); }],
    ['non-JSON', () => new Response(`<html>${KEY}</html>`)],
    ['wrong shape', () => json({ data: 'not an array' })],
    ['null shape', () => json(null)], ['bad entries', () => json({ data: [{ id: CALL.model }, null] })],
  ];
  for (const [name, list] of badLists) {
    it(`fails closed for list ${name} without generation`, async () => {
      const m = mock(list);
      assertUnavailable(await m.adapter().execute(CALL));
      assert.equal(m.calls.length, 1);
      assert.equal(m.calls[0]!.url, OPENCODE_ZEN_MODELS_URL);
    });
  }
  it('rechecks the live list after every completed call; a positive result never persists', async () => {
    let n = 0;
    const m = mock(() => json(n++ === 0 ? LIST : { data: [] }));
    const a = m.adapter();
    assert.equal((await a.execute(CALL)).status, 'completed');
    assertUnavailable(await a.execute(CALL));
    assert.equal(m.calls.filter(c => c.url === OPENCODE_ZEN_MODELS_URL).length, 2);
    assert.equal(m.calls.filter(c => c.init.method === 'POST').length, 1);
  });
  for (const [status, code] of [[401, 'unauthorized'], [403, 'unauthorized'], [408, 'timeout'], [429, 'unavailable'], [500, 'unavailable'], [503, 'unavailable'], [404, 'unavailable'], [400, 'invalid_request']] as const) {
    it(`maps generation HTTP ${status} to ${code} without SDK retries or leaking provider errors`, async () => {
      const m = mock(undefined, () => json({ error: { message: `Bearer ${KEY}`, headers: { Authorization: `Bearer ${KEY}` } } }, status, { 'retry-after': '3600' }));
      const f = failure(await m.adapter().execute(CALL));
      assert.equal(f.code, code);
      assert.equal(f.retryable, false);
      assert.equal(f.retry_after_ms, undefined);
      assert.equal(m.calls.length, 2);
    });
  }
  for (const header of [undefined, '3600']) {
    it(`maps 429 with Retry-After ${header} to immediate unavailability`, async () => {
      const m = mock(undefined, () => json({}, 429, header ? { 'retry-after': header } : {}));
      assertUnavailable(await m.adapter().execute(CALL));
      assert.equal(m.calls.length, 2);
    });
  }
  for (const [name, response] of [
    ['non-JSON', () => new Response(`<html>${KEY}</html>`, { headers: { 'content-type': 'application/json' } })],
    ['empty choices', () => json({ ...BODY, choices: [] })],
    ['null text', () => json({ ...BODY, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: null } }] })],
    ['empty text', () => json({ ...BODY, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] })],
  ] as const) {
    it(`rejects malformed generation ${name}`, async () => {
      const m = mock(undefined, response);
      assert.equal(failure(await m.adapter().execute(CALL)).code, 'malformed_response');
      assert.equal(m.calls.length, 2);
    });
  }
  it('returns a safe transport failure and never logs echoed credentials', async (t) => {
    const logs: unknown[] = [];
    for (const method of ['log', 'warn', 'error', 'debug', 'info'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
    const m = mock(undefined, () => { throw new TypeError(`failed ${KEY}`); });
    assertUnavailable(await m.adapter().execute(CALL));
    assert.equal(m.calls.length, 2);
    assert.ok(!JSON.stringify(logs).includes(KEY));
  });
  it('redacts the captured key even from successful provider-controlled fields', async () => {
    const m = mock(undefined, () => json({ ...BODY, id: KEY, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: KEY } }] }));
    const result = await m.adapter().execute(CALL);
    assert.equal(result.status, 'completed');
    assert.ok(!JSON.stringify(result).includes(KEY));
  });
  it('rejects missing, blank, CR and LF keys safely at construction', () => {
    for (const apiKey of [undefined, '', '   ', `${KEY}\r`, `${KEY}\n`]) {
      assert.throws(() => opencodeZenAdapter({ apiKey: apiKey as string }), (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /apiKey/);
        assert.ok(!e.message.includes(KEY));
        return true;
      });
    }
  });
  it('copies the key at construction', async () => {
    const m = mock();
    const options = { apiKey: KEY, fetch: m.fetch };
    const a = opencodeZenAdapter(options);
    options.apiKey = 'changed';
    await a.execute(CALL);
    assert.equal(new Headers(m.calls[1]!.init.headers).get('authorization'), `Bearer ${KEY}`);
  });
  for (const [name, code] of [['AbortError', 'cancelled'], ['TimeoutError', 'timeout']] as const) {
    it(`honours pre-start ${name} without requests`, async () => {
      const controller = new AbortController();
      controller.abort(new DOMException(KEY, name));
      const m = mock();
      const f = failure(await m.adapter().execute({ ...CALL, signal: controller.signal }));
      assert.equal(f.code, code);
      assert.equal(f.retryable, false);
      assert.equal(m.calls.length, 0);
    });
    for (const stage of ['list', 'generation'] as const) {
      it(`honours ${name} during ${stage} without another request`, async () => {
        const started = deferred<void>();
        const controller = new AbortController();
        const calls: Sent[] = [];
        const fetch: typeof globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          if (stage === 'generation' && String(url) === OPENCODE_ZEN_MODELS_URL) return json(LIST);
          assert.ok(init?.signal);
          assert.equal(init.signal.aborted, false);
          started.resolve();
          return new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          });
        };
        const pending = opencodeZenAdapter({ apiKey: KEY, fetch }).execute({ ...CALL, signal: controller.signal });
        assert.equal(await Promise.race([started.promise.then(() => 'started'), pending.then(() => 'finished')]), 'started');
        controller.abort(new DOMException(KEY, name));
        const f = failure(await pending);
        assert.equal(f.code, code);
        assert.equal(f.retryable, false);
        assert.equal(calls.length, stage === 'list' ? 1 : 2);
      });
    }
  }
  it('isolates concurrent calls and keys, with one generation each and no positive cache', async () => {
    const m = mock();
    const adapter = m.adapter();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => adapter.execute({ ...CALL, prompt: `public ${i}` })));
    assert.ok(results.every(r => r.status === 'completed'));
    const posts = m.calls.filter(c => c.init.method === 'POST');
    assert.equal(posts.length, 8);
    assert.equal(new Set(posts.map(c => String(c.init.body))).size, 8);
    for (const post of posts) assert.equal(new Headers(post.init.headers).get('authorization'), `Bearer ${KEY}`);
    for (const get of m.calls.filter(c => c.init.method === 'GET')) assert.equal(new Headers(get.init.headers).has('authorization'), false);
    const before = m.calls.length;
    await adapter.execute(CALL);
    assert.equal(m.calls.length, before + 2);
  });
  it('a failed list cannot poison a later call', async () => {
    let n = 0;
    const m = mock(() => { if (n++ === 0) throw new Error(KEY); return json(LIST); });
    const a = m.adapter();
    assertUnavailable(await a.execute(CALL));
    assert.equal((await a.execute(CALL)).status, 'completed');
    assert.equal(m.calls.length, 3);
  });
  it('one list abort cannot abort a concurrent or later call', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let n = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url) !== OPENCODE_ZEN_MODELS_URL) return json(BODY);
      if (n++ > 0) return json(LIST);
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    };
    const a = opencodeZenAdapter({ apiKey: KEY, fetch });
    const first = a.execute({ ...CALL, signal: controller.signal });
    assert.equal(await Promise.race([started.promise.then(() => 'started'), first.then(() => 'finished')]), 'started');
    const other = a.execute(CALL);
    controller.abort(new DOMException(KEY, 'AbortError'));
    assert.equal(failure(await first).code, 'cancelled');
    assert.equal((await other).status, 'completed');
    assert.equal((await a.execute(CALL)).status, 'completed');
  });
});
