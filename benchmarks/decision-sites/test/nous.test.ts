/** Nous Portal as a P10 competitor: direct adapter route, free models only, journal-safe. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProviders } from '../providers.ts';
import { competitorPrompt } from '../competitors.ts';
import { execute } from '../engine.ts';
import { Journal } from '../journal.ts';
import { buildRequest } from '../questions.ts';
import { makeReport } from '../report.ts';
import { flags } from '../run.ts';
import { NOUS_PORTAL_FREE_MODELS } from '@weave/gateway/nous-portal';
import type { Item, Provider, Request } from '../types.ts';

const KEY = 'sk-test-SENTINEL-nous-p10-credential';
const MODEL = 'upstage/solar-mini4:free';
const MODELS_URL = 'https://inference-api.nousresearch.com/v1/models';
const CHAT_URL = 'https://inference-api.nousresearch.com/v1/chat/completions';
const CATALOGUE = { data: [
  { id: MODEL, pricing: { prompt: '0', completion: '0', input_cache_read: '0' } },
  { id: 'upstage/solar-mini4', pricing: { prompt: '0.0000000500', completion: '0.0000002000' } },
] };
const request: Request = { state: { text: 'test' }, questions: { q: { type: 'choice', instructions: 'Select.', criteria: { b: 'Bee', a: 'Aye' } } } };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const answerText = (req: Request) => JSON.stringify({ answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) =>
  [id, q.type === 'choice' ? { choice: Object.keys(q.criteria)[0], confidence: 0.9 } : q.type === 'boolean' ? { probability: 0.2, confidence: 0.9 } : { score: 0 }])) });
const completion = (text: string, usage: Record<string, unknown> = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52, cost: 0 }) =>
  json({ id: 'gen-p10', model: MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage });

interface Sent { url: string; method: string; headers: Headers; body: Record<string, any> | undefined }
function endpoint(options: { catalogue?: () => Response | Promise<Response>; chat?: (body: Record<string, any>) => Response | Promise<Response> } = {}) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body });
    init?.signal?.throwIfAborted();
    if (String(url).endsWith('/models')) return await (options.catalogue?.() ?? json(CATALOGUE));
    return await (options.chat?.(body) ?? completion(answerText(request)));
  };
  return { fetch, sent, chats: () => sent.filter(s => s.url === CHAT_URL), catalogues: () => sent.filter(s => s.url === MODELS_URL) };
}
const nous = (config: Parameters<typeof buildProviders>[0]): Provider => buildProviders(config).find(p => p.id === 'nous-portal')!;
const signal = () => new AbortController().signal;

test('Nous competitor posts the shared competitor prompt with the tag, key only as Bearer, and no shuffle or guardrail', async () => {
  const e = endpoint();
  const p = nous({ nousKey: KEY, fetch: e.fetch });
  assert.equal(p.model, MODEL);
  assert.equal(p.price, 0);
  assert.equal(p.competitor, true);
  assert.equal(p.serialize(request), competitorPrompt(request));
  const result = await p.request(request, signal());
  assert.deepEqual(result, { status: 'ok', model: MODEL, answers: { q: { choice: 'b', confidence: 0.9 } }, input_tokens: 40, output_tokens: 12 });
  assert.deepEqual(e.sent.map(s => [s.method, s.url]), [['GET', MODELS_URL], ['POST', CHAT_URL]]);
  for (const s of e.sent) assert.equal(s.headers.get('authorization'), `Bearer ${KEY}`);
  const body = e.chats()[0]!.body!;
  assert.equal(body.model, MODEL);
  assert.deepEqual(body.tags, ['user=weave']);
  // Exactly the production state and questions, criteria order unchanged: no guardrail or shuffle.
  assert.deepEqual(body.messages, [{ role: 'user', content: competitorPrompt(request) }]);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'tags']);
  assert.ok(!JSON.stringify(e.sent.map(s => s.body)).includes(KEY));
});

test('Nous competitor skips without a usable credential and sends nothing', async () => {
  for (const nousKey of [undefined, '', '   ', `${KEY}\r\nx: y`]) {
    const e = endpoint();
    const result = await nous({ ...(nousKey === undefined ? {} : { nousKey }), fetch: e.fetch }).request(request, signal());
    assert.deepEqual(result, { status: 'skipped', reason: 'no_credential' });
    assert.equal(e.sent.length, 0);
  }
});

test('Nous competitor fails closed on a priced catalogue entry with no chat request, and stays closed', async () => {
  const e = endpoint({ catalogue: () => json({ data: [{ id: MODEL, pricing: { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 1000, prompt: '0.0000001' }] } }] }) });
  const p = nous({ nousKey: KEY, fetch: e.fetch });
  for (let i = 0; i < 2; i++) {
    const result = await p.request(request, signal());
    assert.deepEqual(result, { status: 'failed', reason: 'price_not_free' });
  }
  assert.equal(e.chats().length, 0);
  assert.equal(e.catalogues().length, 1);
});

test('Nous competitor fails a reported non-zero cost and refuses the model afterwards', async () => {
  const e = endpoint({ chat: () => completion(answerText(request), { prompt_tokens: 40, completion_tokens: 12, cost: 0.0002 }) });
  const p = nous({ nousKey: KEY, fetch: e.fetch });
  assert.deepEqual(await p.request(request, signal()), { status: 'failed', reason: 'price_not_free', input_tokens: 40, output_tokens: 12 });
  assert.deepEqual(await p.request(request, signal()), { status: 'failed', reason: 'price_not_free' });
  assert.equal(e.chats().length, 1);
});

test('Nous competitor reports a 429 with the relative reset delay for the engine retry', async () => {
  const e = endpoint({ chat: () => json({ error: { message: KEY } }, 429, { 'x-ratelimit-reset-requests': '20', 'x-ratelimit-reset-tokens': '41.5' }) });
  const result = await nous({ nousKey: KEY, fetch: e.fetch }).request(request, signal());
  assert.deepEqual(result, { status: 'failed', reason: 'rate_limited', http_status: 429, retry_after_ms: 41_500 });
});

test('Nous competitor skips the provider when the model is missing or removed, without crashing', async () => {
  for (const options of [
    { catalogue: () => json({ data: [] }) },
    { chat: () => json({ error: { message: 'not found' } }, 404) },
  ]) {
    const e = endpoint(options);
    assert.deepEqual(await nous({ nousKey: KEY, fetch: e.fetch }).request(request, signal()), { status: 'skipped', reason: 'model_not_listed' });
  }
});

test('Nous competitor skips the provider on an auth refusal and keeps the skip', async () => {
  const e = endpoint({ catalogue: () => json({ error: KEY }, 401) });
  const p = nous({ nousKey: KEY, fetch: e.fetch });
  assert.deepEqual(await p.request(request, signal()), { status: 'skipped', reason: 'unauthorized' });
  assert.deepEqual(await p.request(request, signal()), { status: 'skipped', reason: 'unauthorized' });
  assert.equal(e.sent.length, 1);
});

test('Nous competitor records unparsable output as a parse failure without the key', async () => {
  const e = endpoint({ chat: () => completion(`not json ${KEY}`) });
  const result = await nous({ nousKey: KEY, fetch: e.fetch }).request(request, signal());
  assert.deepEqual(result, { status: 'failed', reason: 'non_json_output', parse_failure: true, input_tokens: 40, output_tokens: 12 });
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('Nous competitor spaces dispatches to the 10-per-minute free limit and never overlaps them', async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  let inFlight = 0, maxInFlight = 0;
  const e = endpoint({ chat: async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    now += 500;
    return completion(answerText(request));
  } });
  const p = nous({ nousKey: KEY, fetch: e.fetch, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  const results = await Promise.all([p.request(request, signal()), p.request(request, signal()), p.request(request, signal())]);
  assert.ok(results.every(r => r.status === 'ok'));
  assert.equal(maxInFlight, 1);
  assert.deepEqual(sleeps, [5_500, 5_500]);
});

test('Nous competitor refuses a second dispatch without an injected rate limiter', async () => {
  for (const limiter of [{}, { now: () => 1_000 }, { sleep: async () => {} }]) {
    const e = endpoint();
    const p = nous({ nousKey: KEY, fetch: e.fetch, ...limiter });
    assert.equal((await p.request(request, signal())).status, 'ok');
    assert.deepEqual(await p.request(request, signal()), { status: 'failed', reason: 'rate_limit_unavailable' });
    assert.equal(e.chats().length, 1);
  }
});

test('Nous competitor spaces actual chat dispatches after a slow catalogue check', async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const sentAt: number[] = [];
  const e = endpoint({
    catalogue: () => { now += 7_000; return json(CATALOGUE); },
    chat: () => { sentAt.push(now); return completion(answerText(request)); },
  });
  const p = nous({ nousKey: KEY, fetch: e.fetch, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  assert.equal((await p.request(request, signal())).status, 'ok');
  assert.equal((await p.request(request, signal())).status, 'ok');
  assert.deepEqual(sleeps, [6_000]);
  assert.deepEqual(sentAt, [8_000, 14_000]);
});

test('Nous competitor applies Retry-After to queued concurrent calls without exposing provider messages', async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  let chats = 0;
  const e = endpoint({ chat: () => ++chats === 1
    ? json({ error: { message: KEY } }, 429, { 'retry-after': '12', 'x-ratelimit-reset-tokens': '50' })
    : completion(answerText(request)) });
  const p = nous({ nousKey: KEY, fetch: e.fetch, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  const results = await Promise.all([p.request(request, signal()), p.request(request, signal())]);
  assert.deepEqual(results[0], { status: 'failed', reason: 'rate_limited', http_status: 429, retry_after_ms: 12_000 });
  assert.equal(results[1]!.status, 'ok');
  assert.deepEqual(sleeps, [12_000]);
  assert.ok(!JSON.stringify(results).includes(KEY));
});

for (const seconds of [0, 60, 61, 3600]) for (const phase of ['catalogue', 'chat']) {
  test(`Nous ${phase} 429 (${seconds}s) bounds queued concurrent dispatch and preserves the provider delay`, async () => {
    let now = 1_000, refusals = 0;
    const sleeps: number[] = [];
    const refuse = () => ++refusals === 1 ? json({ error: { message: KEY } }, 429, { 'retry-after': String(seconds) }) : undefined;
    const e = endpoint(phase === 'catalogue'
      ? { catalogue: () => refuse() ?? json(CATALOGUE) }
      : { chat: () => refuse() ?? completion(answerText(request)) });
    const p = nous({ nousKey: KEY, fetch: e.fetch, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
    const results = await Promise.all([p.request(request, signal()), p.request(request, signal()), p.request(request, signal())]);
    // A zero-delay catalogue refusal has not dispatched a chat to space yet.
    assert.deepEqual(sleeps, phase === 'catalogue' && seconds === 0 ? [6_000]
      : [Math.max(6_000, Math.min(60_000, seconds * 1000)), 6_000]);
    assert.deepEqual(results[0], { status: 'failed', reason: 'rate_limited', http_status: 429, retry_after_ms: seconds * 1000,
      ...(seconds > 60 ? { retry_after_applied_ms: 60_000 } : {}) });
    assert.ok(results.slice(1).every(r => r.status === 'ok'));
    assert.ok(!JSON.stringify(results).includes(KEY));
  });
}

test('Nous cancellation during bounded Retry-After sends no chat and leaves the cooldown for the next caller', async () => {
  let now = 1_000, chats = 0;
  const sleeps: number[] = [];
  const controller = new AbortController();
  const e = endpoint({ chat: () => ++chats === 1 ? json({}, 429, { 'retry-after': '3600' }) : completion(answerText(request)) });
  const p = nous({ nousKey: KEY, fetch: e.fetch, now: () => now, sleep: async (ms, waiting) => {
    sleeps.push(ms);
    if (sleeps.length === 1) { controller.abort(); waiting?.throwIfAborted(); }
    now += ms;
  } });
  await p.request(request, signal());
  assert.deepEqual(await p.request(request, controller.signal), { status: 'failed', reason: 'cancelled' });
  assert.equal(e.chats().length, 1);
  assert.equal((await p.request(request, signal())).status, 'ok');
  assert.deepEqual(sleeps, [60_000, 60_000]);
});

test('Nous competitor cancellation during limiter wait sends no chat and preserves the next slot', async () => {
  let now = 1_000;
  const controller = new AbortController();
  const sleeps: number[] = [];
  const e = endpoint();
  const p = nous({ nousKey: KEY, fetch: e.fetch, now: () => now, sleep: async (ms, waiting) => {
    sleeps.push(ms);
    if (sleeps.length === 1) { controller.abort(); waiting?.throwIfAborted(); }
    now += ms;
  } });
  assert.equal((await p.request(request, signal())).status, 'ok');
  assert.deepEqual(await p.request(request, controller.signal), { status: 'failed', reason: 'cancelled' });
  assert.equal(e.chats().length, 1);
  assert.equal((await p.request(request, signal())).status, 'ok');
  assert.equal(e.chats().length, 2);
  assert.deepEqual(sleeps, [6_000, 6_000]);
});

test('Nous key is redacted from every provider metadata field before journal admission', async () => {
  const p = buildProviders({ typesafeKey: 'typesafe-key', nousKey: KEY, fetch: async () =>
    json({ error: { code: encodeURIComponent(KEY) } }, 401, { 'x-typesafe-request-id': KEY }) })[0]!;
  const result = await p.request(request, signal());
  assert.equal(result.request_id, '[redacted]');
  assert.equal(result.error_code, '[redacted]');
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('Nous competitor: cancellation before dispatch is retryable; after chat dispatch it is unacknowledged', async () => {
  const before = endpoint();
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await nous({ nousKey: KEY, fetch: before.fetch }).request(request, aborted.signal), { status: 'failed', reason: 'cancelled' });
  assert.equal(before.sent.length, 0);
  const controller = new AbortController();
  const during = endpoint({ chat: () => { controller.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')); } });
  await assert.rejects(nous({ nousKey: KEY, fetch: during.fetch }).request(request, controller.signal), /unacknowledged_call/);
});

const item: Item = { id: 'i', scenario_id: 's', site: 'loop.route', state: { task: 'read' }, gold: { decision: 'flash' } };
const entry = { item, split: 'holdout' as const, set_digest: 's' };
const clock = { now: () => 100, sleep: async () => {} };
async function fixture(fn: (journal: Journal, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nous-p10-'));
  try { const path = join(dir, 'journal.jsonl'); await fn(new Journal(path), path); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('Nous journal retains the raw and bounded delay, ends the over-bound item, and replays both receipts without dispatch', () => fixture(async (journal, path) => {
  let now = 1_000, chats = 0;
  const sleeps: number[] = [];
  const production = await buildRequest(item);
  const e = endpoint({ chat: () => ++chats === 1 ? json({}, 429, { 'retry-after': '3600' }) : completion(answerText(production)) });
  const limiter = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
  const entries = [entry, { ...entry, item: { ...item, id: 'j' } }];
  await execute({ entries, providers: [nous({ nousKey: KEY, fetch: e.fetch, ...limiter })], journal, maxSpend: 0, ...limiter });
  assert.deepEqual(sleeps, [60_000]);
  const calls = journal.read().filter(r => r.type === 'call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.terminal, true);
  assert.equal(calls[0]!.result.retry_after_ms, 3_600_000);
  assert.equal(calls[0]!.result.retry_after_applied_ms, 60_000);
  assert.equal(calls[1]!.result.status, 'ok');
  await execute({ entries, providers: [nous({ nousKey: KEY, fetch: e.fetch, ...limiter })], journal: new Journal(path), maxSpend: 0, ...limiter });
  assert.equal(e.chats().length, 2);
  assert.deepEqual(sleeps, [60_000]);
  assert.ok(!readFileSync(path, 'utf8').includes(KEY));
}));

test('runnable inference probes reference only existing free-model allowlist entries', () => {
  const root = new URL('../../inference/', import.meta.url);
  for (const path of readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(path => path.endsWith('.mjs'))) {
    const source = readFileSync(new URL(path, root), 'utf8');
    for (const [, key] of source.matchAll(/NOUS_PORTAL_FREE_MODELS\.(\w+)/g)) {
      assert.ok(Object.hasOwn(NOUS_PORTAL_FREE_MODELS, key!), `${path}: unknown allowlist key ${key}`);
    }
  }
});

test('Nous journal: intent before dispatch, $0 metering, and replay does not re-send a completed call', () => fixture(async (journal, path) => {
  const production = await buildRequest(item);
  let intentsAtDispatch = -1;
  const e = endpoint({ chat: (body) => {
    intentsAtDispatch = journal.read().filter(r => r.type === 'intent').length;
    assert.equal(body.messages[0].content, competitorPrompt(production));
    return completion(answerText(production));
  } });
  const p = nous({ nousKey: KEY, fetch: e.fetch });
  await execute({ entries: [entry], providers: [p], journal, maxSpend: 0, ...clock });
  assert.equal(intentsAtDispatch, 1);
  const call = journal.read().find(r => r.type === 'call')!;
  assert.equal(call.result.status, 'ok');
  assert.equal(call.cost_usd, 0);
  assert.equal(journal.spent(), 0);
  await execute({ entries: [entry], providers: [nous({ nousKey: KEY, fetch: e.fetch })], journal, maxSpend: 0, ...clock });
  assert.equal(e.chats().length, 1);
  assert.ok(!readFileSync(path, 'utf8').includes(KEY));
}));

test('Nous journal: a crash after dispatch keeps the intent and resume neither re-sends nor loses it', () => fixture(async journal => {
  const controller = new AbortController();
  const e = endpoint({ chat: () => { controller.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')); } });
  await execute({ entries: [entry], providers: [nous({ nousKey: KEY, fetch: e.fetch })], journal, maxSpend: 0, signal: controller.signal, ...clock });
  assert.equal(journal.read().some(r => r.type === 'call'), false);
  assert.equal(journal.read().filter(r => r.type === 'intent').length, 1);
  const resumed = endpoint();
  await execute({ entries: [entry], providers: [nous({ nousKey: KEY, fetch: resumed.fetch })], journal, maxSpend: 0, ...clock });
  assert.equal(resumed.chats().length, 0);
  assert.equal(journal.read().some(r => r.type === 'uncertain'), true);
}));

test('Nous journal: a torn final line does not corrupt later appends', () => fixture(async (journal, path) => {
  const second: Item = { ...item, id: 'j' };
  const e = endpoint({ chat: async () => completion(answerText(await buildRequest(item))) });
  await execute({ entries: [entry], providers: [nous({ nousKey: KEY, fetch: e.fetch })], journal, maxSpend: 0, ...clock });
  appendFileSync(path, '{"type":"call","torn');
  const reopened = new Journal(path);
  await execute({ entries: [entry, { ...entry, item: second }], providers: [nous({ nousKey: KEY, fetch: e.fetch })], journal: reopened, maxSpend: 0, ...clock });
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  for (const line of lines) JSON.parse(line);
  assert.equal(reopened.read().filter(r => r.type === 'call' && r.result.status === 'ok').length, 2);
  assert.equal(e.chats().length, 2);
}));

test('Nous is reported as a competitor and is selectable but not a default live provider', () => {
  const report = makeReport({ run_id: 'r', node_version: 'v22', max_spend_usd: 0, set_digests: {}, providers: ['nous-portal'], sites: ['loop.route'] }, []);
  assert.deepEqual(report.summary.competitors.map(row => row.provider), ['nous-portal']);
  assert.equal(report.summary.decision_providers.length, 0);
  assert.deepEqual(flags(['--providers', 'nous-portal']).providers, ['nous-portal']);
  assert.ok(!flags([]).providers.includes('nous-portal'));
});

test('only the composition root reads NOUS_API_KEY', () => {
  const run = readFileSync(new URL('../run.ts', import.meta.url), 'utf8');
  const providers = readFileSync(new URL('../providers.ts', import.meta.url), 'utf8');
  assert.match(run, /process\.env\.NOUS_API_KEY/);
  assert.doesNotMatch(providers, /process\.env/);
});
