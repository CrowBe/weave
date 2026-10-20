/** WV-018 contract: one accounted native SDK call, with fail-closed free evidence. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createInferenceGateway } from '../src/gateway.js';
import {
  vercelAiGatewayFreeAdapter, VERCEL_AI_GATEWAY_FREE_ADAPTER,
  VERCEL_AI_GATEWAY_FREE_DESTINATION, VERCEL_AI_GATEWAY_FREE_MODELS,
} from '../src/adapters/vercel-ai-gateway.js';
import type { GenerationCall, GenerationRequest, RoutedUnit } from '../src/types.js';

// Synthetic sentinel only; no live credential or network is used.
const KEY = 'synthetic-wv018-credential';
let unexpectedCalls = 0;
function unexpected(message: string): never { unexpectedCalls++; assert.fail(message); }
beforeEach(() => { unexpectedCalls = 0; });
afterEach(() => { assert.equal(unexpectedCalls, 0, 'no forbidden catalogue lookup or HTTP dispatch'); });
const PRIMARY = 'nvidia/nemotron-3.5-lightning-free';
const FALLBACK = 'reflection/beam-free';
const NOW = 1_792_454_400_000;
const EXPIRY = 1_793_404_800_000;
const IDS = [PRIMARY, 'poolside/laguna-s-2.1-free', FALLBACK,
  'minimax/minimax-m3.1-flash', 'stealth/glyph-cluster'];
const model = (id = PRIMARY, pricing: unknown = { input: '0', output: '0' }) =>
  ({ id, pricing, zdr: 'none', no_training: 'none' });
const catalogue = () => ({ data: IDS.map(id => model(id)) });
const call: GenerationCall = { model: PRIMARY, instructions: '', prompt: 'ok',
  settings: { max_output_tokens: 32 }, signal: undefined };

/** createGateway uses the native language-model wire shape, not chat completions. */
function completion(cost: unknown = '0'): Response {
  return Response.json({ content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 2 }, outputTokens: { total: 1 } },
    providerMetadata: { gateway: { cost, marketCost: '0', gatewayCost: '0' } } });
}
function refused(status: number): Response {
  return Response.json({ error: { message: `echo Bearer ${KEY}` } }, { status });
}
function adapter(fetch: typeof globalThis.fetch, source: unknown = catalogue(), now = () => NOW) {
  return vercelAiGatewayFreeAdapter({ apiKey: KEY, fetch, catalogue: source, now });
}
const primary: RoutedUnit = {
  routed_unit_id: 'free.primary', operation: 'generate', kind: 'transform', tier: 'flash',
  context_profile: 'test', context_profile_version: 1, prompt_template: 'test', prompt_template_version: 1,
  adapter: 'vercel-ai-gateway-free', model: PRIMARY, settings: call.settings,
  destination: 'vercel-ai-gateway-free', destination_training_allowed: true,
  quality: 'baseline', context_limit_tokens: 100, price: { input_per_mtok: 0, output_per_mtok: 0 },
};
const fallback: RoutedUnit = { ...primary, routed_unit_id: 'free.fallback', model: FALLBACK };
function request(id = 'test'): GenerationRequest {
  return { request_id: id, site: 'example.free', role: 'working', kind: 'transform',
    input: { instructions: '', prompt: id }, terms: { quality: 'baseline', tier: 'flash',
      content_class: 'non_sensitive', destinations: ['vercel-ai-gateway-free'],
      max_context_tokens: 10, deadline: NOW + 10_000, cost_ceiling: 0,
      max_attempts: 4, max_attempts_per_route: 1 } };
}
function gateway(fetch: typeof globalThis.fetch, source: unknown = catalogue()) {
  return createInferenceGateway({ routes: [primary, fallback], adapters: [adapter(fetch, source)],
    clock: { now: () => NOW } });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('Vercel promotional free contract', () => {
  it('exports only the five verified IDs and a distinct training destination', () => {
    assert.deepEqual(Object.values(VERCEL_AI_GATEWAY_FREE_MODELS).sort(), [...IDS].sort());
    assert.equal(VERCEL_AI_GATEWAY_FREE_ADAPTER, primary.adapter);
    assert.equal(VERCEL_AI_GATEWAY_FREE_DESTINATION, primary.destination);
  });

  it('dispatches every allowlisted ID via createGateway native transport with injected auth', async () => {
    const sent: string[] = [];
    const instance = adapter(async (url, init) => {
      assert.ok(String(url).endsWith('/language-model'));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
      sent.push(headers.get('ai-language-model-id')!);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.maxOutputTokens, 32);
      return completion();
    });
    for (const id of IDS) assert.equal((await instance.execute({ ...call, model: id })).status, 'completed');
    assert.deepEqual(sent, IDS);
  });

  for (const id of ['reflection/beam', 'paid/model', `${PRIMARY}-extra`]) {
    it(`refuses non-allowlisted ${id} before catalogue lookup or dispatch`, async () => {
      const result = await adapter(async () => { unexpected('dispatch'); }, () => {
        unexpected('catalogue lookup');
      }).execute({ ...call, model: id });
      assert.equal(result.status, 'failed');
      assert.ok(result.status === 'failed');
      assert.equal(result.failure.retryable, false);
      assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
    });
  }

  const unsafe: unknown[] = [undefined, null, '{', {}, { data: null },
    { data: [model(PRIMARY, null)] }, { data: [model(PRIMARY, { input: '0' })] },
    ...['0.001', '-1', 'NaN', '', '1e-999', null, false].map(input =>
      ({ data: [model(PRIMARY, { input, output: '0' })] })),
    { data: [model(PRIMARY, { input: '0', output: '1' })] },
    { data: [model(PRIMARY, { input: '0', output: '0', input_cache_read: '0.1' })] },
    { data: [model(PRIMARY, { input: '0', output: '0', fast: { input: '1' } })] },
    { data: [model(PRIMARY, { input: '0', output: '0', varies_by_provider: true })] },
    { data: [{ ...model(), varies_by_provider: true }] },
    { data: [{ ...model(), deprecated_at: NOW }] },
    { data: [{ ...model(), deprecated_at: 'unparseable' }] },
    { data: [model(), model()] },
  ];
  unsafe.forEach((source, index) => it(`fails closed on unsafe catalogue ${index}`, async () => {
    // Construct explicitly so undefined is tested, rather than the helper default.
    const instance = vercelAiGatewayFreeAdapter({ apiKey: KEY, now: () => NOW,
      catalogue: source, fetch: async () => { unexpected('dispatch'); } });
    const result = await instance.execute(call);
    assert.equal(result.status, 'failed');
    assert.ok(result.status === 'failed');
    assert.equal(result.failure.retryable, false);
  }));

  it('uses caller time and the known Laguna expiry even if the catalogue omits it', async () => {
    let now = EXPIRY - 1;
    let calls = 0;
    const instance = adapter(async () => { calls++; return completion(); }, catalogue(), () => now);
    const laguna = { ...call, model: 'poolside/laguna-s-2.1-free' };
    assert.equal((await instance.execute(laguna)).status, 'completed');
    now = EXPIRY;
    assert.equal((await instance.execute(laguna)).status, 'failed');
    assert.equal(calls, 1);
    assert.equal((await adapter(async () => { unexpected('dispatch'); }, catalogue(), () => NaN).execute(call)).status, 'failed');
  });

  it('accepts caller-fetched JSON text and exact numeric zeros', async () => {
    const result = await adapter(async () => completion(0),
      JSON.stringify({ data: [model(PRIMARY, { input: 0, output: 0 })] })).execute(call);
    assert.equal(result.status, 'completed');
  });

  it('passes cancellation into a fresh catalogue lookup on each call', async () => {
    const controller = new AbortController();
    const source = async (signal: AbortSignal | undefined) => {
      assert.equal(signal, controller.signal);
      return catalogue();
    };
    const result = await adapter(async () => completion(), source).execute({ ...call, signal: controller.signal });
    assert.equal(result.status, 'completed');
  });

  it('rechecks catalogue on every repeated request and a fresh adapter after recovery', async () => {
    let source: unknown = catalogue();
    let reads = 0;
    let calls = 0;
    const getCatalogue = async () => { reads++; return source; };
    const fetch: typeof globalThis.fetch = async () => { calls++; return completion(); };
    const instance = adapter(fetch, getCatalogue);
    assert.equal((await instance.execute(call)).status, 'completed');
    source = { data: [model(PRIMARY, { input: '1', output: '0' })] };
    assert.equal((await instance.execute(call)).status, 'failed');
    assert.equal((await adapter(fetch, getCatalogue).execute(call)).status, 'failed');
    assert.equal(reads, 3);
    assert.equal(calls, 1);
  });

  for (const cost of ['0.01', '-1', '', null, false, '1e-999']) {
    it(`records nonzero or invalid post-call cost ${JSON.stringify(cost)} and never retries that route`, async () => {
      const models: string[] = [];
      const instance = gateway(async (_url, init) => {
        const id = new Headers(init?.headers).get('ai-language-model-id')!;
        models.push(id);
        return completion(id === PRIMARY ? cost : '0');
      });
      const input = request();
      const result = await instance.generate({ ...input, terms: { ...input.terms, max_attempts_per_route: 3 } });
      assert.equal(result.status, 'accepted');
      assert.deepEqual(models, [PRIMARY, FALLBACK]);
      const failure = result.attempts[0]?.disposition;
      assert.ok(failure?.status === 'failed');
      assert.equal(failure.failure.retryable, false);
      assert.match(failure.failure.message, /cost/);
    });
  }

  it('fails closed when cost metadata is absent', async () => {
    const result = await adapter(async () => {
      const body = await completion().json() as { providerMetadata?: unknown };
      delete body.providerMetadata;
      return Response.json(body);
    }).execute(call);
    assert.equal(result.status, 'failed');
  });

  for (const field of ['cost', 'marketCost', 'gatewayCost']) {
    it(`refuses nonzero reported ${field} despite other zero cost fields`, async () => {
      const result = await adapter(async () => {
        const body = await completion().json() as Record<string, unknown>;
        return Response.json({ ...body, providerMetadata: {
          gateway: { cost: '0', marketCost: '0', gatewayCost: '0', [field]: '0.01' },
        } });
      }).execute(call);
      assert.ok(result.status === 'failed' && !result.failure.retryable);
    });
  }

  it('keeps a cost refusal local to one invocation and checks again on resubmission', async () => {
    let calls = 0;
    let reads = 0;
    const instance = adapter(async () => completion(++calls === 1 ? '0.01' : '0'), async () => {
      reads++; return catalogue();
    });
    assert.equal((await instance.execute(call)).status, 'failed');
    assert.equal((await instance.execute(call)).status, 'completed');
    assert.equal(reads, 2);
    assert.equal(calls, 2);
  });

  for (const status of [429, 404]) {
    it(`falls back on HTTP ${status} without hidden SDK retries or credential leakage`, async () => {
      let calls = 0;
      const result = await gateway(async () => ++calls === 1 ? refused(status) : completion()).generate(request());
      assert.equal(result.status, 'accepted');
      assert.equal(calls, 2);
      const failure = result.attempts[0]?.disposition;
      assert.ok(failure?.status === 'failed');
      assert.equal(failure.failure.code, status === 429 ? 'rate_limited' : 'unavailable');
      assert.equal(failure.failure.retryable, status === 429);
      assert.ok(!JSON.stringify(result).includes(KEY));
    });
  }

  it('handles a 429 while consuming the native response body', async () => {
    let calls = 0;
    const result = await gateway(async () => {
      if (++calls > 1) return completion();
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"content":'));
        controller.error(Object.assign(new Error(KEY), { statusCode: 429 }));
      } }), { headers: { 'content-type': 'application/json' } });
    }).generate(request());
    assert.equal(result.status, 'accepted');
    assert.equal(calls, 2);
    const failure = result.attempts[0]?.disposition;
    assert.ok(failure?.status === 'failed');
    assert.equal(failure.failure.code, 'rate_limited');
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it('falls back when the primary is removed from the supplied catalogue', async () => {
    let calls = 0;
    const result = await gateway(async () => { calls++; return completion(); },
      { data: [model(FALLBACK)] }).generate(request());
    assert.equal(result.status, 'accepted');
    assert.equal(calls, 1);
    assert.equal(result.attempts.length, 2);
  });

  it('isolates two concurrent fallback sequences', async () => {
    const seen: string[] = [];
    const entered = deferred();
    const release = deferred();
    let primaryCalls = 0;
    const instance = gateway(async (_url, init) => {
      const id = new Headers(init?.headers).get('ai-language-model-id')!;
      seen.push(id);
      if (id === PRIMARY) {
        if (++primaryCalls === 2) entered.resolve();
        await release.promise;
        return refused(429);
      }
      return completion();
    });
    const pending = Promise.all([instance.generate(request('a')), instance.generate(request('b'))]);
    await entered.promise;
    release.resolve();
    const results = await pending;
    assert.ok(results.every(result => result.status === 'accepted' && result.attempts.length === 2));
    assert.equal(seen.filter(id => id === PRIMARY).length, 2);
    assert.equal(seen.filter(id => id === FALLBACK).length, 2);
  });

  it('cancels an in-flight call with no retry or fallback storm', async () => {
    const entered = deferred();
    const controller = new AbortController();
    let calls = 0;
    const pending = gateway(async (_url, init) => {
      calls++;
      entered.resolve();
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort',
        () => reject(new Error(KEY)), { once: true }));
    }).generate(request(), controller.signal);
    await entered.promise;
    controller.abort(KEY);
    const result = await pending;
    assert.equal(calls, 1);
    assert.equal(result.attempts.length, 1);
    const failure = result.attempts[0]?.disposition;
    assert.ok(failure?.status === 'failed');
    assert.equal(failure.failure.code, 'cancelled');
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it('does not dispatch an already aborted call or one cancelled during catalogue lookup', async () => {
    const controller = new AbortController();
    controller.abort();
    const instance = adapter(async () => { unexpected('dispatch'); });
    const result = await instance.execute({ ...call, signal: controller.signal });
    assert.ok(result.status === 'failed' && result.failure.code === 'cancelled');
    const next = new AbortController();
    const result2 = await adapter(async () => { unexpected('dispatch'); }, async () => {
      next.abort(KEY); return catalogue();
    }).execute({ ...call, signal: next.signal });
    assert.ok(result2.status === 'failed' && result2.failure.code === 'cancelled');
  });

  it('records catalogue exceptions without disclosing the key', async () => {
    const result = await adapter(async () => { unexpected('dispatch'); }, async () => {
      throw new Error(KEY);
    }).execute(call);
    assert.equal(result.status, 'failed');
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it('keeps provider warnings and successful response metadata credential-free', async t => {
    const warnings: unknown[] = [];
    t.mock.method(process, 'emitWarning', (...args: unknown[]) => { warnings.push(args); });
    const result = await adapter(async () => {
      const body = await completion().json() as Record<string, unknown>;
      return Response.json({ ...body, content: [{ type: 'text', text: KEY }],
        finishReason: { unified: KEY, raw: KEY }, warnings: [{ type: 'other', message: KEY }] });
    }).execute(call);
    assert.equal(result.status, 'completed');
    assert.ok(!JSON.stringify(warnings).includes(KEY), 'SDK warnings must not echo the key');
    assert.ok(!JSON.stringify(result).includes(KEY), 'response metadata must not echo the key');
  });

  for (const cost of ['0', '0.01']) it(`normalizes untrusted usage before publishing cost ${cost}`, async () => {
    const result = await adapter(async () => {
      const body = await completion(cost).json() as Record<string, unknown>;
      return Response.json({ ...body,
        usage: { inputTokens: { total: KEY }, outputTokens: { total: KEY } } });
    }).execute(call);
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.deepEqual(result.usage, { input_tokens: undefined, output_tokens: undefined });
  });

  for (const contentClass of [undefined, 'sensitive', 'private', 'public', 'non_sensitive'] as const) {
    it(`applies existing training-allowed routing for ${contentClass ?? 'absent'} content_class`, async () => {
      let calls = 0;
      const input = request();
      const { content_class: _class, ...terms } = input.terms;
      const result = await gateway(async () => { calls++; return completion(); }).generate({ ...input,
        terms: { ...terms, ...(contentClass === undefined ? {} : { content_class: contentClass }) } });
      const allowed = contentClass === 'public' || contentClass === 'non_sensitive';
      assert.equal(calls, allowed ? 1 : 0);
      assert.equal(result.status, allowed ? 'accepted' : 'blocked');
    });
  }
});
