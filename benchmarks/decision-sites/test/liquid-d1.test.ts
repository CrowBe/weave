import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviders } from '../providers.ts';
import { flags } from '../run.ts';
const request = {
  state: { text: 'test' },
  questions: { q: { type: 'choice' as const, instructions: 'Select.', criteria: { b: 'Bee', a: 'Aye' } } },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const listed = json({ models: [{ name: 'd1-2b' }] });
const d1 = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  buildProviders({ fetch, ...extra }).find((p) => p.id === 'liquid-d1')!;

test('liquid-d1 sends the TypeSafe wire body to loopback d1 with no credential', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const p = d1(async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).endsWith('/v1/models')) return listed.clone();
    return json({
      model: 'd1-2b',
      answers: { q: { type: 'choice', choice: 'a', probabilities: { b: 0.1, a: 0.9 }, confidence: 0.9 } },
      usage: { input_tokens: 75, output_tokens: 0 },
    });
  });
  assert.equal(p.model, 'd1-2b');
  assert.equal(p.price, 0);
  const result = await p.request(request, new AbortController().signal);
  assert.equal(result.status, 'ok');
  assert.equal(result.answers?.q?.choice, 'a');
  assert.equal(result.input_tokens, 75);
  const post = calls.find((c) => c.url === 'http://127.0.0.1:8082/v1/systemone')!;
  assert.ok(post, 'posts to the default local d1 endpoint');
  assert.equal(String(post.init?.body), p.serialize(request), 'replay hashes the dispatched body');
  assert.deepEqual(JSON.parse(String(post.init?.body)), {
    model: 'd1-2b',
    state: request.state,
    questions: request.questions,
  });
  for (const c of calls) assert.equal(new Headers(c.init?.headers).get('authorization'), null);
});

test('liquid-d1 skips when the server does not list d1-2b and fails when it is unreachable', async () => {
  let posted = false;
  const unlisted = d1(async (url) => {
    if (String(url).endsWith('/v1/models')) return json({ models: [{ name: 'lfm3-1.7b' }] });
    posted = true;
    return json({});
  });
  assert.deepEqual(await unlisted.request(request, new AbortController().signal), {
    status: 'skipped',
    reason: 'model_not_listed',
  });
  assert.equal(posted, false);
  const down = d1(async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal((await down.request(request, new AbortController().signal)).reason, 'models_unavailable');
});

test('liquid-d1 rejects a non-loopback base URL before any fetch', async () => {
  for (const d1BaseURL of ['https://remote.example', 'http://192.0.2.1:8082']) {
    let fetched = false;
    const p = d1(
      async () => {
        fetched = true;
        return listed.clone();
      },
      { d1BaseURL },
    );
    const result = await p.request(request, new AbortController().signal);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'non_loopback_base_url');
    assert.equal(fetched, false);
  }
});

test('liquid-d1 is selectable with --providers but never a default', () => {
  assert.deepEqual(flags(['--providers', 'liquid-d1']).providers, ['liquid-d1']);
  assert.ok(!flags([]).providers.includes('liquid-d1'));
});
