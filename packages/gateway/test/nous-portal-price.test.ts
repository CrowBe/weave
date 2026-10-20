/**
 * Offline contract for the Nous Portal adapter on the AI SDK: request shape,
 * key secrecy, the three price layers (free-model allowlist, catalogue price
 * check, response cost), refusals, cancellation and concurrency. Every
 * endpoint is injected; no live call is made.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NOUS_PORTAL_FREE_MODELS,
  NOUS_PORTAL_MIN_REASONING_OUTPUT_TOKENS,
  NOUS_PORTAL_REASONING_MODELS,
  isNousPortalFreeModel,
  nousPortalAdapter,
} from '@weave/gateway/nous-portal';
import type { GenerationCall, GenerationProviderResult, ProviderFailure } from '@weave/gateway';
import {
  CHAT_URL, MODELS_URL, LIVE_CATALOGUE_ENTRIES, catalogueWith, catalogueWithout, completionBody,
  deferred, json, nousEndpoint,
} from './nous-portal-fixtures.js';

const KEY = 'sk-test-SENTINEL-nous-portal-credential';
const SOLAR = NOUS_PORTAL_FREE_MODELS.solarMini;
const CALL: GenerationCall = {
  model: SOLAR,
  instructions: 'Be brief.',
  prompt: 'Reply with the single word: ok',
  settings: { max_output_tokens: 64 },
  signal: undefined,
};

function failureOf(result: GenerationProviderResult): ProviderFailure {
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.ok(result.status === 'failed');
  assert.ok(!JSON.stringify(result).includes(KEY), 'failure must not disclose the injected credential');
  return result.failure;
}

const PRICE_REFUSED = 'nous-portal: model refused: a non-zero or unreadable price was observed';
const NOT_ALLOWLISTED = 'nous-portal: model is not on the free-model allowlist; no request sent';
const NOT_LISTED = 'nous-portal: model is not listed in the live catalogue';
const CHECK_FAILED = 'nous-portal: catalogue price check failed; no request sent';
const NO_LONGER_FREE = 'nous-portal: provider no longer serves this model free';
const COST_REPORTED = 'nous-portal: response reported a non-zero or non-numeric usage.cost; model refused from now on';

describe('nous-portal request shape and credential', () => {
  it('checks the catalogue, then posts one non-streaming chat completion with the tag and no reasoning parameter', async () => {
    const endpoint = nousEndpoint({ chat: () => json(completionBody('ok')) });
    const result = await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL);
    assert.deepEqual(result, {
      status: 'completed', text: 'ok', usage: { input_tokens: 12, output_tokens: 1 },
      finish_reason: 'stop', provider_response_id: 'gen-1',
    });
    assert.deepEqual(endpoint.sent.map(s => [s.method, s.url]), [['GET', MODELS_URL], ['POST', CHAT_URL]]);
    for (const sent of endpoint.sent) {
      assert.equal(sent.headers.get('authorization'), `Bearer ${KEY}`);
      assert.ok(!sent.url.includes(KEY));
    }
    const body = endpoint.chatRequests[0]!.body!;
    assert.ok(!JSON.stringify(body).includes(KEY));
    assert.equal(body['model'], SOLAR);
    assert.deepEqual(body['tags'], ['user=weave']);
    assert.equal(body['max_tokens'], 64);
    assert.deepEqual(body['messages'], [
      { role: 'system', content: CALL.instructions },
      { role: 'user', content: CALL.prompt },
    ]);
    for (const key of ['reasoning', 'reasoning_effort', 'include_reasoning', 'stream', 'stream_options', 'temperature']) {
      assert.ok(!(key in body), `${key} must not be sent`);
    }
  });

  it('honours an injected base URL and temperature and omits an empty system message', async () => {
    const urls: string[] = [];
    let body: Record<string, unknown> = {};
    const fetch: typeof globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith('/models')) return json({ data: LIVE_CATALOGUE_ENTRIES });
      body = JSON.parse(String(init?.body));
      return json(completionBody());
    };
    const result = await nousPortalAdapter({ apiKey: KEY, fetch, baseURL: 'http://mock.invalid/v1/' })
      .execute({ ...CALL, instructions: '  ', settings: { max_output_tokens: 64, temperature: 0.2 } });
    assert.equal(result.status, 'completed');
    assert.deepEqual(urls, ['http://mock.invalid/v1/models', 'http://mock.invalid/v1/chat/completions']);
    assert.equal(body['temperature'], 0.2);
    assert.deepEqual(body['messages'], [{ role: 'user', content: CALL.prompt }]);
  });

  it('rejects missing, blank and header-breaking credentials at construction without disclosing them', () => {
    for (const apiKey of ['', '   ', undefined, `${KEY}\r\nx: y`, `${KEY}\n`, `${KEY}\r`]) {
      assert.throws(() => nousPortalAdapter({ apiKey: apiKey as string }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /nousPortalAdapter requires an apiKey/);
        assert.ok(!error.message.includes(KEY));
        return true;
      });
    }
  });

  it('refuses content carrying its own credential before any request', async () => {
    for (const field of ['prompt', 'instructions'] as const) {
      const endpoint = nousEndpoint();
      const failure = failureOf(await nousPortalAdapter({ apiKey: ` ${KEY} `, fetch: endpoint.fetch })
        .execute({ ...CALL, [field]: `echo ${KEY}` }));
      assert.deepEqual(failure, { code: 'invalid_request', message: 'nous-portal: request content contains the adapter credential', retryable: false });
      assert.equal(endpoint.sent.length, 0);
    }
  });

  it('redacts a credential echoed in successful response fields', async () => {
    const endpoint = nousEndpoint({ chat: () => json({ ...completionBody(`echo ${KEY}`), id: `id-${KEY}` }) });
    const result = await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL);
    assert.equal(result.status, 'completed');
    assert.ok(!JSON.stringify(result).includes(KEY));
  });
});

describe('nous-portal free-model allowlist', () => {
  it('lists exactly the verified free IDs and no paid twin', () => {
    for (const id of Object.values(NOUS_PORTAL_FREE_MODELS)) {
      assert.equal(isNousPortalFreeModel(id), true);
      assert.equal(isNousPortalFreeModel(id.replace(/:free$/, '')), false, `${id} paid twin`);
    }
    for (const id of ['', 'upstage/solar-mini4:FREE', ' upstage/solar-mini4:free', 'upstage/solar-pro4:free', 'stealth/space-bunny-alpha', 'toString', '__proto__', 7, null]) {
      assert.equal(isNousPortalFreeModel(id), false, String(id));
    }
  });

  it('refuses every paid twin and any non-allowlisted ID with no request sent', async () => {
    const models = [
      ...Object.values(NOUS_PORTAL_FREE_MODELS).map(id => id.replace(/:free$/, '')),
      'z-ai/glm-5.3-flash', 'inclusionai/ling-3.0-flash-fin:free', 'stealth/space-bunny-alpha', 'toString',
    ];
    for (const model of models) {
      const endpoint = nousEndpoint();
      const result = await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute({ ...CALL, model });
      assert.deepEqual(failureOf(result), { code: 'invalid_request', message: NOT_ALLOWLISTED, retryable: false }, model);
      assert.deepEqual(result.status === 'failed' ? result.usage : undefined, { input_tokens: 0, output_tokens: 0 });
      assert.equal(endpoint.sent.length, 0, model);
    }
  });
});

describe('nous-portal mandatory-reasoning output budget', () => {
  it('names the mandatory-reasoning free models and a 1024-token minimum', () => {
    assert.equal(NOUS_PORTAL_MIN_REASONING_OUTPUT_TOKENS, 1024);
    assert.deepEqual([...NOUS_PORTAL_REASONING_MODELS].sort(), [
      NOUS_PORTAL_FREE_MODELS.beam, NOUS_PORTAL_FREE_MODELS.stepFlash, NOUS_PORTAL_FREE_MODELS.stepPreview,
    ].sort());
  });

  it('rejects an insufficient budget for a reasoning model without sending, and allows it for a non-reasoning one', async () => {
    for (const model of NOUS_PORTAL_REASONING_MODELS) {
      for (const max_output_tokens of [64, 1023, 0, 1024.5, NaN]) {
        const endpoint = nousEndpoint();
        const failure = failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch })
          .execute({ ...CALL, model, settings: { max_output_tokens } }));
        assert.deepEqual(failure, { code: 'invalid_request', retryable: false,
          message: 'nous-portal: settings.max_output_tokens must be an integer at least 1024 for a mandatory-reasoning model' });
        assert.equal(endpoint.sent.length, 0);
      }
      const endpoint = nousEndpoint();
      const ok = await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch })
        .execute({ ...CALL, model, settings: { max_output_tokens: 1024 } });
      assert.equal(ok.status, 'completed');
    }
    const endpoint = nousEndpoint();
    assert.equal((await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL)).status, 'completed');
  });
});

describe('nous-portal catalogue price check', () => {
  const pricedVariants: readonly [string, unknown][] = [
    ['prompt', { prompt: '0.0000000500', completion: '0' }],
    ['completion', { prompt: '0', completion: '0.0000002' }],
    ['input_cache_read', { prompt: '0', completion: '0', input_cache_read: '0.000000005' }],
    ['input_cache_write', { prompt: '0', completion: '0', input_cache_write: '0.0000001' }],
    ['web_search', { prompt: '0', completion: '0', web_search: '0.01' }],
    ['image', { prompt: '0', completion: '0', image: '0.001' }],
    ['audio', { prompt: '0', completion: '0', audio: '0.001' }],
    ['internal_reasoning', { prompt: '0', completion: '0', internal_reasoning: '0.0000001' }],
    ['numeric field', { prompt: 0, completion: 0.0000001 }],
    ['nested original', { prompt: '0', completion: '0', original: { prompt: '0.0000001', completion: '0' } }],
    ['override tier prompt', { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 100000, prompt: '0.00000025', completion: '0' }] }],
    ['override tier other field', { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 0, prompt: '0', completion: '0', input_cache_write_1h: '0.0000005' }] }],
    ['negative price', { prompt: '-0.0000001', completion: '0' }],
  ];
  const unreadable: readonly [string, unknown][] = [
    ['empty string', { prompt: '', completion: '0' }],
    ['word', { prompt: 'free', completion: '0' }],
    ['null', { prompt: null, completion: '0' }],
    ['boolean', { prompt: false, completion: '0' }],
    ['NaN text', { prompt: 'NaN', completion: '0' }],
    ['Infinity', { prompt: 'Infinity', completion: '0' }],
    ['no completion', { prompt: '0' }],
    ['no prompt', { completion: '0' }],
    ['empty pricing', {}],
    ['pricing not object', '0'],
    ['pricing absent', undefined],
    ['overrides not array', { prompt: '0', completion: '0', overrides: { prompt: '0' } }],
    ['override not object', { prompt: '0', completion: '0', overrides: ['0'] }],
    ['override unreadable', { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 1, prompt: 'x' }] }],
  ];
  for (const [label, pricing] of [...pricedVariants, ...unreadable]) {
    it(`refuses with no chat request when the catalogue shows ${label}`, async () => {
      const endpoint = nousEndpoint({ catalogue: () => json(catalogueWith(SOLAR, pricing)) });
      const failure = failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL));
      assert.deepEqual(failure, { code: 'invalid_request', message: PRICE_REFUSED, retryable: false });
      assert.equal(endpoint.chatRequests.length, 0);
      assert.equal(endpoint.catalogueRequests.length, 1);
    });
  }

  it('accepts every free ID as listed in the live catalogue, including padded zero strings', async () => {
    for (const model of Object.values(NOUS_PORTAL_FREE_MODELS)) {
      const endpoint = nousEndpoint();
      const result = await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch })
        .execute({ ...CALL, model, settings: { max_output_tokens: 1024 } });
      assert.equal(result.status, 'completed', model);
    }
    const zeroes = { prompt: '0.0000000000', completion: 0, input_cache_read: ' 0 ', overrides: [{ min_prompt_tokens: 100000, utc_start: 1, utc_end: 2, prompt: '0', completion: '0' }] };
    const endpoint = nousEndpoint({ catalogue: () => json(catalogueWith(SOLAR, zeroes)) });
    assert.equal((await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL)).status, 'completed');
  });

  it('refuses when a duplicate catalogue entry for the same ID is priced', async () => {
    const endpoint = nousEndpoint({ catalogue: () => json({ data: [...LIVE_CATALOGUE_ENTRIES, { id: SOLAR, pricing: { prompt: '0.1', completion: '0' } }] }) });
    assert.equal(failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL)).message, PRICE_REFUSED);
    assert.equal(endpoint.chatRequests.length, 0);
  });

  it('keeps a priced model refused for the adapter instance, with no further requests', async () => {
    let priced = true;
    const endpoint = nousEndpoint({ catalogue: () => json(priced ? catalogueWith(SOLAR, { prompt: '1', completion: '1' }) : { data: LIVE_CATALOGUE_ENTRIES }) });
    const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
    assert.equal(failureOf(await adapter.execute(CALL)).message, PRICE_REFUSED);
    priced = false;
    assert.equal(failureOf(await adapter.execute(CALL)).message, PRICE_REFUSED);
    assert.equal(endpoint.sent.length, 1);
    // Another model on the same instance is unaffected.
    assert.equal((await adapter.execute({ ...CALL, model: NOUS_PORTAL_FREE_MODELS.longcat })).status, 'completed');
  });

  it('treats a model missing from the catalogue as unavailable for fallback, without caching the absence', async () => {
    let listed = false;
    const endpoint = nousEndpoint({ catalogue: () => json(listed ? { data: LIVE_CATALOGUE_ENTRIES } : catalogueWithout(SOLAR)) });
    const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
    assert.deepEqual(failureOf(await adapter.execute(CALL)), { code: 'unavailable', message: NOT_LISTED, retryable: false });
    assert.equal(endpoint.chatRequests.length, 0);
    listed = true;
    assert.equal((await adapter.execute(CALL)).status, 'completed');
    assert.equal(endpoint.catalogueRequests.length, 2);
  });

  const checkFailures: readonly [string, (sent: unknown) => Response | Promise<Response>][] = [
    ['network error', async () => { throw new TypeError(`fetch failed ${KEY}`); }],
    ['500', () => json({ error: KEY }, 500)],
    ['non-JSON body', () => new Response(`<html>${KEY}</html>`, { status: 200 })],
    ['body without a model list', () => json({ models: LIVE_CATALOGUE_ENTRIES })],
    ['data not an array', () => json({ data: {} })],
  ];
  for (const [label, catalogue] of checkFailures) {
    it(`fails closed and retryable with no chat request when the catalogue check meets ${label}, and does not cache it`, async () => {
      let broken = true;
      const endpoint = nousEndpoint({ catalogue: (sent) => broken ? catalogue(sent) : json({ data: LIVE_CATALOGUE_ENTRIES }) });
      const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
      assert.deepEqual(failureOf(await adapter.execute(CALL)), { code: 'unavailable', message: CHECK_FAILED, retryable: true });
      assert.equal(endpoint.chatRequests.length, 0);
      broken = false;
      assert.equal((await adapter.execute(CALL)).status, 'completed');
      assert.equal(endpoint.catalogueRequests.length, 2);
    });
  }

  it('maps a refused catalogue credential to unauthorized and a throttled catalogue to rate_limited', async () => {
    for (const [status, code, retryable] of [[401, 'unauthorized', false], [403, 'unauthorized', false], [429, 'rate_limited', true]] as const) {
      const endpoint = nousEndpoint({ catalogue: () => json({ error: KEY }, status, { 'x-ratelimit-reset-requests': '12.5' }) });
      const failure = failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL));
      assert.equal(failure.code, code);
      assert.equal(failure.retryable, retryable);
      if (status === 429) assert.equal(failure.retry_after_ms, 12_500);
      assert.equal(endpoint.chatRequests.length, 0);
    }
  });

  it('trusts a passed check for the adapter instance: one catalogue request for repeated calls', async () => {
    const endpoint = nousEndpoint();
    const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
    for (let i = 0; i < 3; i++) assert.equal((await adapter.execute(CALL)).status, 'completed');
    assert.equal(endpoint.catalogueRequests.length, 1);
    assert.equal(endpoint.chatRequests.length, 3);
  });

  const changedRefusals: readonly [string, number, unknown][] = [
    ['404 model removed', 404, { error: { message: 'model not found' } }],
    ['402', 402, { error: { message: 'payment required' } }],
    ['400 no longer free', 400, { error: { message: 'This model is no longer free' } }],
    ['403 requires available credits', 403, { error: { message: 'This request requires available credits' } }],
  ];
  for (const [label, status, body] of changedRefusals) {
    it(`re-checks the catalogue after a ${label} refusal and refuses the model once it is priced`, async () => {
      let paid = false;
      let chatStatus = 200;
      const endpoint = nousEndpoint({
        catalogue: () => json(paid ? catalogueWith(SOLAR, { prompt: '0.00000005', completion: '0.0000002' }) : { data: LIVE_CATALOGUE_ENTRIES }),
        chat: () => chatStatus === 200 ? json(completionBody()) : json(body, chatStatus),
      });
      const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
      assert.equal((await adapter.execute(CALL)).status, 'completed');
      chatStatus = status;
      assert.deepEqual(failureOf(await adapter.execute(CALL)), { code: 'unavailable', message: NO_LONGER_FREE, retryable: false });
      paid = true;
      chatStatus = 200;
      assert.equal(failureOf(await adapter.execute(CALL)).message, PRICE_REFUSED);
      assert.equal(failureOf(await adapter.execute(CALL)).message, PRICE_REFUSED);
      assert.equal(endpoint.catalogueRequests.length, 2);
      assert.equal(endpoint.chatRequests.length, 2);
    });
  }
});

describe('nous-portal response cost', () => {
  for (const [label, cost] of [['positive', 0.00001], ['string', '0'], ['null', null], ['negative', -1], ['object', { total: 0 }]] as const) {
    it(`fails a ${label} usage.cost, keeps the usage, and refuses the model from then on`, async () => {
      const endpoint = nousEndpoint({ chat: (body) => json(completionBody('ok', body['model'] === SOLAR
        ? { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost }
        : { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost: 0 })) });
      const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
      const result = await adapter.execute(CALL);
      assert.deepEqual(failureOf(result), { code: 'invalid_request', message: COST_REPORTED, retryable: false });
      assert.deepEqual(result.status === 'failed' ? result.usage : undefined, { input_tokens: 12, output_tokens: 1 });
      assert.equal(failureOf(await adapter.execute(CALL)).message, PRICE_REFUSED);
      assert.equal(endpoint.chatRequests.length, 1);
      assert.equal((await adapter.execute({ ...CALL, model: NOUS_PORTAL_FREE_MODELS.longcat })).status, 'completed');
    });
  }

  it('accepts a zero or absent usage.cost', async () => {
    for (const usage of [{ prompt_tokens: 3, completion_tokens: 1, cost: 0 }, { prompt_tokens: 3, completion_tokens: 1 }]) {
      const endpoint = nousEndpoint({ chat: () => json(completionBody('ok', usage)) });
      assert.equal((await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL)).status, 'completed');
    }
  });
});

describe('nous-portal refusals and faults', () => {
  for (const [status, code, retryable] of [
    [401, 'unauthorized', false], [403, 'unauthorized', false], [429, 'rate_limited', true],
    [500, 'unavailable', true], [503, 'unavailable', true], [400, 'invalid_request', false], [408, 'timeout', false],
  ] as const) {
    it(`maps HTTP ${status} to ${code} with one request and no credential disclosure`, async () => {
      const endpoint = nousEndpoint({ chat: () => json({ error: { message: `rejected ${KEY}` } }, status) });
      const failure = failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL));
      assert.equal(failure.code, code);
      assert.equal(failure.retryable, retryable);
      assert.ok(!failure.message.includes('rejected'), 'provider bodies are never echoed');
      assert.equal(endpoint.chatRequests.length, 1, 'maxRetries: 0 means one request per gateway attempt');
    });
  }

  for (const [label, headers, delay] of [
    ['the larger relative reset', { 'x-ratelimit-reset-requests': '2', 'x-ratelimit-reset-tokens': '45.5' }, 45_500],
    ['the requests reset when it is later', { 'x-ratelimit-reset-requests': '59.999', 'x-ratelimit-reset-tokens': '58.399' }, 59_999],
    ['Retry-After over vendor headers', { 'retry-after': '3', 'x-ratelimit-reset-requests': '59.999' }, 3_000],
    ['no delay without headers', {}, undefined],
    ['no delay from an absolute date', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, undefined],
  ] as const) {
    it(`reads a 429 delay: ${label}`, async () => {
      const endpoint = nousEndpoint({ chat: () => json({ error: { message: 'rate limited' } }, 429, headers) });
      const failure = failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL));
      assert.equal(failure.code, 'rate_limited');
      assert.equal(failure.retry_after_ms, delay);
    });
  }

  it('fails closed on malformed JSON, empty choices and absent text', async () => {
    for (const chat of [
      () => new Response(`<html>${KEY}</html>`, { status: 200, headers: { 'content-type': 'application/json' } }),
      () => json({ ...completionBody(), choices: [] }),
      () => json(completionBody(null)),
    ]) {
      const endpoint = nousEndpoint({ chat });
      const failure = failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL));
      assert.equal(failure.code, 'malformed_response');
      assert.equal(failure.retryable, false);
      assert.equal(endpoint.chatRequests.length, 1);
    }
  });

  it('keeps SDK usage on an empty completion', async () => {
    const endpoint = nousEndpoint({ chat: () => json({ ...completionBody(''), choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] }) });
    const result = await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL);
    assert.equal(failureOf(result).code, 'malformed_response');
    assert.deepEqual(result.status === 'failed' ? result.usage : undefined, { input_tokens: 12, output_tokens: 1 });
  });

  it('reports a chat network fault as retryable unavailable without throwing or logging the key', async (t) => {
    const logs: unknown[][] = [];
    for (const method of ['log', 'warn', 'error', 'debug', 'info'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
    }
    const endpoint = nousEndpoint({ chat: async () => { throw new TypeError(`network failed ${KEY}`); } });
    const failure = failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute(CALL));
    assert.equal(failure.code, 'unavailable');
    assert.equal(failure.retryable, true);
    assert.equal(endpoint.chatRequests.length, 1);
    assert.ok(!JSON.stringify(logs).includes(KEY));
  });
});

describe('nous-portal cancellation', () => {
  for (const [name, code] of [['AbortError', 'cancelled'], ['TimeoutError', 'timeout']] as const) {
    it(`propagates ${name} to the in-flight chat request without another request`, async () => {
      const controller = new AbortController();
      const started = deferred();
      const endpoint = nousEndpoint({ chat: (_body, sent) => {
        started.resolve();
        return new Promise<Response>((_resolve, reject) => {
          void sent;
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
      } });
      const pending = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute({ ...CALL, signal: controller.signal });
      await started.promise;
      controller.abort(new DOMException(`stop ${KEY}`, name));
      const failure = failureOf(await pending);
      assert.equal(failure.code, code);
      assert.equal(failure.retryable, false);
      assert.equal(endpoint.chatRequests.length, 1);
    });

    it(`stops on ${name} during the catalogue check with no chat request`, async () => {
      const controller = new AbortController();
      const started = deferred();
      const release = deferred<Response>();
      let first = true;
      const endpoint = nousEndpoint({ catalogue: () => {
        if (!first) return json({ data: LIVE_CATALOGUE_ENTRIES });
        first = false;
        started.resolve();
        return release.promise;
      } });
      const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
      const pending = adapter.execute({ ...CALL, signal: controller.signal });
      await started.promise;
      controller.abort(new DOMException('stop', name));
      const failure = failureOf(await pending);
      assert.equal(failure.code, code);
      release.resolve(json({ data: LIVE_CATALOGUE_ENTRIES }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(endpoint.chatRequests.length, 0);
      // An abandoned check is not a pass: the next call checks again.
      assert.equal((await adapter.execute(CALL)).status, 'completed');
      assert.equal(endpoint.catalogueRequests.length, 2);
    });
  }

  it('does not send when the caller signal is already aborted', async () => {
    const endpoint = nousEndpoint();
    const failure = failureOf(await nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch }).execute({ ...CALL, signal: AbortSignal.abort() }));
    assert.equal(failure.code, 'cancelled');
    assert.equal(endpoint.chatRequests.length, 0);
  });

  it('one waiter aborting a shared check does not cancel another waiter', async () => {
    const started = deferred();
    const release = deferred<Response>();
    const endpoint = nousEndpoint({ catalogue: () => { started.resolve(); return release.promise; } });
    const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
    const controller = new AbortController();
    const leaving = adapter.execute({ ...CALL, signal: controller.signal });
    const staying = adapter.execute({ ...CALL, prompt: 'stay' });
    await started.promise;
    controller.abort();
    assert.equal(failureOf(await leaving).code, 'cancelled');
    release.resolve(json({ data: LIVE_CATALOGUE_ENTRIES }));
    assert.equal((await staying).status, 'completed');
    assert.equal(endpoint.catalogueRequests.length, 1);
    assert.equal(endpoint.chatRequests.length, 1);
    assert.equal(endpoint.chatRequests[0]!.body!['messages'] instanceof Array, true);
  });
});

describe('nous-portal concurrency', () => {
  it('shares one in-flight catalogue check per model; every call sends its own chat request', async () => {
    const release = deferred();
    let catalogue = 0;
    const endpoint = nousEndpoint({ catalogue: async () => { catalogue++; await release.promise; return json({ data: LIVE_CATALOGUE_ENTRIES }); } });
    const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
    const models = [NOUS_PORTAL_FREE_MODELS.solarMini, NOUS_PORTAL_FREE_MODELS.longcat, NOUS_PORTAL_FREE_MODELS.lagunaS];
    const pending = Array.from({ length: 9 }, (_, i) => adapter.execute({ ...CALL, model: models[i % 3]!, prompt: `public ${i}` }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(endpoint.chatRequests.length, 0, 'no chat request may precede its model check');
    release.resolve();
    const results = await Promise.all(pending);
    assert.ok(results.every(result => result.status === 'completed'));
    assert.equal(catalogue, 3);
    assert.equal(endpoint.chatRequests.length, 9);
    assert.equal(new Set(endpoint.chatRequests.map(s => JSON.stringify(s.body))).size, 9);
    for (const model of models) assert.equal(endpoint.chatRequests.filter(s => s.body!['model'] === model).length, 3);
  });

  it('a failed shared check fails each waiter closed and is not cached as a pass', async () => {
    const release = deferred();
    let broken = true;
    const endpoint = nousEndpoint({ catalogue: async () => {
      await release.promise;
      if (broken) throw new TypeError('down');
      return json({ data: LIVE_CATALOGUE_ENTRIES });
    } });
    const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
    const pending = Array.from({ length: 4 }, () => adapter.execute(CALL));
    release.resolve();
    for (const result of await Promise.all(pending)) assert.equal(failureOf(result).message, CHECK_FAILED);
    assert.equal(endpoint.chatRequests.length, 0);
    assert.equal(endpoint.catalogueRequests.length, 1);
    broken = false;
    assert.equal((await adapter.execute(CALL)).status, 'completed');
    assert.equal(endpoint.catalogueRequests.length, 2);
  });

  it("one call's rate-limit refusal does not change another call's result or delay", async () => {
    const endpoint = nousEndpoint({ chat: (body) => {
      const prompt = (body['messages'] as { content: string }[]).at(-1)!.content;
      return prompt === 'throttled' ? json({}, 429, { 'x-ratelimit-reset-requests': '30' }) : json(completionBody(prompt));
    } });
    const adapter = nousPortalAdapter({ apiKey: KEY, fetch: endpoint.fetch });
    const [throttled, other] = await Promise.all([
      adapter.execute({ ...CALL, prompt: 'throttled' }), adapter.execute({ ...CALL, prompt: 'other' }),
    ]);
    assert.equal(failureOf(throttled).retry_after_ms, 30_000);
    assert.equal(other.status === 'completed' ? other.text : '', 'other');
  });

  it('isolates credentials across concurrent adapter instances', async () => {
    const endpoints = Array.from({ length: 4 }, () => nousEndpoint());
    await Promise.all(endpoints.map((endpoint, i) => nousPortalAdapter({ apiKey: `${KEY}-${i}`, fetch: endpoint.fetch }).execute(CALL)));
    for (const [i, endpoint] of endpoints.entries()) {
      assert.equal(endpoint.sent.length, 2);
      for (const sent of endpoint.sent) assert.equal(sent.headers.get('authorization'), `Bearer ${KEY}-${i}`);
    }
  });
});
