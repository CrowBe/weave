/**
 * Nous Portal through the gateway with an injected endpoint: fallback is
 * routed units in escalation order, privacy routing gates the training-allowed
 * destination, and nothing in an outcome carries the credential.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createInferenceGateway,
  type ContentClass,
  type GenerationRequest,
  type RoutedUnit,
  type Timer,
} from '@weave/gateway';
import {
  NOUS_PORTAL_ADAPTER,
  NOUS_PORTAL_DESTINATION,
  NOUS_PORTAL_FREE_LIMITS,
  NOUS_PORTAL_FREE_MODELS,
  nousPortalAdapter,
} from '@weave/gateway/nous-portal';
import {
  LIVE_CATALOGUE_ENTRIES,
  catalogueWith,
  catalogueWithout,
  completionBody,
  deferred,
  json,
  nousEndpoint,
} from './nous-portal-fixtures.js';

const KEY = 'sk-test-SENTINEL-nous-gateway-credential';
const unit = (id: string, model: string, max_output_tokens = 256): RoutedUnit => ({
  routed_unit_id: id,
  operation: 'generate',
  kind: 'transform',
  tier: 'flash',
  context_profile: 'test',
  context_profile_version: 1,
  prompt_template: 'test',
  prompt_template_version: 1,
  adapter: NOUS_PORTAL_ADAPTER,
  model,
  settings: { max_output_tokens },
  destination: NOUS_PORTAL_DESTINATION,
  billing: 'metered',
  destination_training_allowed: true,
  quality: 'baseline',
  context_limit_tokens: 1000,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  rate_limits: NOUS_PORTAL_FREE_LIMITS,
});
const PRIMARY = unit('nous.solar', NOUS_PORTAL_FREE_MODELS.solarMini);
const FALLBACK = unit('nous.longcat', NOUS_PORTAL_FREE_MODELS.longcat);
const REASONING = unit('nous.step', NOUS_PORTAL_FREE_MODELS.stepFlash, 1024);

function request(
  id = 'nous',
  prompt = 'Reply with the single word: ok',
  content_class: ContentClass | 'absent' = 'public',
): GenerationRequest {
  return {
    request_id: id,
    site: 'implement.generate',
    role: 'working',
    kind: 'transform',
    input: { instructions: '', prompt },
    terms: {
      quality: 'baseline',
      tier: 'flash',
      ...(content_class === 'absent' ? {} : { content_class }),
      destinations: [NOUS_PORTAL_DESTINATION],
      max_context_tokens: 100,
      deadline: 100_000,
      cost_ceiling: 0,
      max_attempts: 3,
      max_attempts_per_route: 1,
    },
  };
}
function gateway(
  fetch: typeof globalThis.fetch,
  options: { routes?: readonly RoutedUnit[]; timer?: Timer; now?: () => number } = {},
) {
  return createInferenceGateway({
    routes: options.routes ?? [PRIMARY, FALLBACK, REASONING],
    adapters: [nousPortalAdapter({ apiKey: KEY, fetch })],
    clock: { now: options.now ?? (() => 0) },
    ...(options.timer ? { timer: options.timer } : {}),
  });
}
const chatModels = (endpoint: ReturnType<typeof nousEndpoint>) => endpoint.chatRequests.map((s) => s.body!['model']);

describe('Nous Portal fallback through the gateway', () => {
  it('accepts on the primary with one catalogue check and one chat request', async () => {
    const endpoint = nousEndpoint({ chat: () => json(completionBody()) });
    const outcome = await gateway(endpoint.fetch).generate(request());
    assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : outcome.status, 'nous.solar');
    assert.equal(endpoint.sent.length, 2);
    assert.equal(outcome.spent, 0);
    assert.deepEqual(outcome.attempts[0]?.usage, { input_tokens: 12, output_tokens: 1 });
    assert.ok(!JSON.stringify(outcome).includes(KEY));
  });

  for (const [label, options] of [
    [
      'a removed model (404)',
      {
        chat: (body: Record<string, unknown>) =>
          body['model'] === PRIMARY.model ? json({ error: { message: 'not found' } }, 404) : json(completionBody()),
      },
    ],
    ['a model missing from the catalogue', { catalogue: () => json(catalogueWithout(PRIMARY.model)) }],
    [
      'a priced catalogue entry',
      { catalogue: () => json(catalogueWith(PRIMARY.model, { prompt: '0.00000005', completion: '0.0000002' })) },
    ],
    [
      'a 402 refusal',
      {
        chat: (body: Record<string, unknown>) =>
          body['model'] === PRIMARY.model
            ? json({ error: { message: 'Payment required' } }, 402)
            : json(completionBody()),
      },
    ],
    [
      'a "requires available credits" refusal',
      {
        chat: (body: Record<string, unknown>) =>
          body['model'] === PRIMARY.model
            ? json({ error: { message: 'requires available credits' } }, 403)
            : json(completionBody()),
      },
    ],
    [
      'a reported cost',
      {
        chat: (body: Record<string, unknown>) =>
          json(
            completionBody(
              'ok',
              body['model'] === PRIMARY.model ? { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 } : undefined,
            ),
          ),
      },
    ],
  ] as const) {
    it(`escalates ${label} to the next Nous routed unit`, async () => {
      const endpoint = nousEndpoint(options);
      const outcome = await gateway(endpoint.fetch).generate(request());
      assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : outcome.status, 'nous.longcat');
      assert.deepEqual(
        outcome.attempts.map((a) => a.routed_unit_id),
        ['nous.solar', 'nous.longcat'],
      );
      assert.equal(outcome.attempts[0]?.disposition.status, 'failed');
      assert.equal(chatModels(endpoint).at(-1), FALLBACK.model);
      assert.ok(!JSON.stringify(outcome).includes(KEY));
    });
  }

  it('escalates a paid twin configured by hand without sending anything for it', async () => {
    const endpoint = nousEndpoint();
    const twin = { ...PRIMARY, routed_unit_id: 'nous.twin', model: 'upstage/solar-mini4' };
    const outcome = await gateway(endpoint.fetch, { routes: [twin, FALLBACK] }).generate(request());
    assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : outcome.status, 'nous.longcat');
    assert.ok(endpoint.sent.every((s) => s.body?.['model'] !== 'upstage/solar-mini4'));
    assert.deepEqual(chatModels(endpoint), [FALLBACK.model]);
  });

  it('records every refusal and stops at max_attempts with no further request', async () => {
    const endpoint = nousEndpoint({ chat: () => json({ error: { message: 'not found' } }, 404) });
    const outcome = await gateway(endpoint.fetch).generate({
      ...request(),
      terms: { ...request().terms, max_attempts: 2 },
    });
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.attempts.length, 2);
    assert.equal(endpoint.chatRequests.length, 2);
    assert.ok(
      outcome.attempts.every((a) => a.disposition.status === 'failed' && a.disposition.failure.code === 'unavailable'),
    );
  });

  it('records a failure for every unit when all are refused, within max_attempts', async () => {
    const endpoint = nousEndpoint({
      catalogue: () => json({ data: LIVE_CATALOGUE_ENTRIES.filter((e) => !e.id.endsWith(':free')) }),
    });
    const outcome = await gateway(endpoint.fetch).generate({
      ...request(),
      terms: { ...request().terms, max_attempts: 5 },
    });
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'provider_failed');
    assert.deepEqual(
      outcome.attempts.map((a) => a.routed_unit_id),
      ['nous.solar', 'nous.longcat', 'nous.step'],
    );
    assert.equal(endpoint.chatRequests.length, 0);
    assert.equal(outcome.spent, 0);
  });
});

describe('Nous Portal rate limits through the gateway', () => {
  for (const [label, headers, wait] of [
    [
      'the larger relative reset header',
      { 'x-ratelimit-reset-requests': '1.5', 'x-ratelimit-reset-tokens': '4' },
      4_000,
    ],
    ['Retry-After', { 'retry-after': '2', 'x-ratelimit-reset-tokens': '4' }, 2_000],
    ['the declared free limits when no header is sent', {}, 6_000],
  ] as const) {
    it(`waits ${label} and retries the same unit`, async () => {
      const waits: number[] = [];
      const timer: Timer = {
        sleep: async (ms, signal) => {
          if (!signal) waits.push(ms);
          else await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        },
      };
      let chats = 0;
      const endpoint = nousEndpoint({ chat: () => (++chats === 1 ? json({}, 429, headers) : json(completionBody())) });
      const input = request();
      const outcome = await gateway(endpoint.fetch, { timer }).generate({
        ...input,
        terms: { ...input.terms, max_attempts_per_route: 2 },
      });
      assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : outcome.status, 'nous.solar');
      assert.deepEqual(waits, [wait]);
      assert.equal(outcome.attempts[1]?.waited_ms, wait);
      assert.equal(endpoint.catalogueRequests.length, 1);
    });
  }

  it('escalates a throttle to the next unit when no timer is configured', async () => {
    const endpoint = nousEndpoint({
      chat: (body) =>
        body['model'] === PRIMARY.model
          ? json({}, 429, { 'x-ratelimit-reset-requests': '30' })
          : json(completionBody()),
    });
    const input = request();
    const outcome = await gateway(endpoint.fetch).generate({
      ...input,
      terms: { ...input.terms, max_attempts_per_route: 2 },
    });
    assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : outcome.status, 'nous.longcat');
  });

  it("one call's backoff does not delay or change a concurrent call", async () => {
    const waiting = deferred();
    const release = deferred();
    const timer: Timer = {
      sleep(ms, signal) {
        if (signal) return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        assert.equal(ms, 9_000);
        waiting.resolve();
        return release.promise;
      },
    };
    const counts = new Map<string, number>();
    const endpoint = nousEndpoint({
      chat: (body) => {
        const prompt = (body['messages'] as { content: string }[]).at(-1)!.content;
        const count = (counts.get(prompt) ?? 0) + 1;
        counts.set(prompt, count);
        return prompt === 'alpha' && count === 1
          ? json({}, 429, { 'x-ratelimit-reset-tokens': '9' })
          : json(completionBody(prompt));
      },
    });
    const instance = gateway(endpoint.fetch, { timer });
    const alphaRequest = request('alpha', 'alpha');
    const alpha = instance.generate({ ...alphaRequest, terms: { ...alphaRequest.terms, max_attempts_per_route: 2 } });
    await waiting.promise;
    const beta = await instance.generate(request('beta', 'beta'));
    assert.equal(beta.status, 'accepted');
    assert.equal(beta.attempts.length, 1);
    assert.equal(beta.attempts[0]?.waited_ms, undefined);
    release.resolve();
    const outcome = await alpha;
    assert.equal(outcome.status === 'accepted' ? outcome.text : '', 'alpha');
    assert.equal(outcome.attempts[1]?.waited_ms, 9_000);
  });
});

describe('Nous Portal cancellation and deadline through the gateway', () => {
  it('a caller abort mid-request cancels without retry or fallback', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const endpoint = nousEndpoint({
      chat: (_body, sent) => {
        void sent;
        entered.resolve();
        return new Promise<Response>((_r, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true }),
        );
      },
    });
    const timer: Timer = {
      sleep: (_ms, signal) =>
        new Promise((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true })),
    };
    const pending = gateway(endpoint.fetch, { timer }).generate(request(), controller.signal);
    await entered.promise;
    controller.abort(KEY);
    const outcome = await pending;
    assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'provider_failed');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(endpoint.chatRequests.length, 1);
    assert.equal(
      outcome.attempts[0]?.disposition.status === 'failed' ? outcome.attempts[0].disposition.failure.code : '',
      'cancelled',
    );
    assert.ok(!JSON.stringify(outcome).includes(KEY));
  });

  it('a caller abort during the catalogue check sends no chat request and does not fall back', async () => {
    const entered = deferred();
    const release = deferred<Response>();
    const controller = new AbortController();
    const endpoint = nousEndpoint({
      catalogue: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const pending = gateway(endpoint.fetch).generate(request(), controller.signal);
    await entered.promise;
    controller.abort();
    const outcome = await pending;
    release.resolve(json({ data: LIVE_CATALOGUE_ENTRIES }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(endpoint.chatRequests.length, 0);
    assert.equal(endpoint.catalogueRequests.length, 1);
  });

  it('the gateway deadline aborts the in-flight request and records timeout', async () => {
    const entered = deferred();
    let now = 0;
    let fire!: () => void;
    const timer: Timer = {
      sleep(ms, signal) {
        return new Promise((resolve) => {
          fire = () => {
            now += ms;
            resolve();
          };
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    let observed: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/models')) return json({ data: LIVE_CATALOGUE_ENTRIES });
      observed = init?.signal ?? undefined;
      entered.resolve();
      return new Promise((_r, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
      );
    };
    const pending = gateway(fetch, { timer, now: () => now }).generate(request());
    await entered.promise;
    fire();
    const outcome = await pending;
    assert.equal(observed?.aborted, true);
    assert.equal(
      outcome.attempts[0]?.disposition.status === 'failed' ? outcome.attempts[0].disposition.failure.code : '',
      'timeout',
    );
    assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'deadline_reached');
  });
});

describe('Nous Portal concurrency through the gateway', () => {
  it('concurrent fallbacks keep their own attempts and share no mutable state', async () => {
    const endpoint = nousEndpoint({
      chat: (body) =>
        body['model'] === PRIMARY.model
          ? json({ error: { message: 'gone' } }, 404)
          : json(completionBody((body['messages'] as { content: string }[]).at(-1)!.content)),
    });
    const instance = gateway(endpoint.fetch);
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => instance.generate(request(`c${i}`, `public ${i}`))),
    );
    for (const [i, outcome] of outcomes.entries()) {
      assert.equal(outcome.status === 'accepted' ? outcome.text : outcome.status, `public ${i}`);
      assert.deepEqual(
        outcome.attempts.map((a) => [a.attempt, a.routed_unit_id]),
        [
          [1, 'nous.solar'],
          [2, 'nous.longcat'],
        ],
      );
    }
    assert.ok(chatModels(endpoint).filter((model) => model === FALLBACK.model).length === 6);
    assert.ok(endpoint.chatRequests.length <= 12);
  });
});

describe('Nous Portal privacy routing', () => {
  for (const content_class of ['absent', 'sensitive', 'private'] as const) {
    it(`excludes Nous for ${content_class} content even when the destination is permitted`, async () => {
      const endpoint = nousEndpoint();
      const outcome = await gateway(endpoint.fetch).generate(request('p', 'ok', content_class));
      assert.equal(outcome.status === 'blocked' ? outcome.reason : outcome.status, 'no_route');
      assert.equal(endpoint.sent.length, 0);
    });
  }

  for (const content_class of ['public', 'non_sensitive'] as const) {
    it(`admits ${content_class} content`, async () => {
      const endpoint = nousEndpoint();
      assert.equal((await gateway(endpoint.fetch).generate(request('p', 'ok', content_class))).status, 'accepted');
    });
  }

  it('applies the destination-wide training mark to an unmarked Nous unit', async () => {
    const endpoint = nousEndpoint();
    const unmarked = { ...FALLBACK, destination_training_allowed: false };
    const outcome = await gateway(endpoint.fetch, { routes: [PRIMARY, unmarked] }).generate(
      request('p', 'ok', 'private'),
    );
    assert.equal(outcome.status, 'blocked');
    assert.equal(endpoint.sent.length, 0);
  });

  it('excludes credential-shaped content from Nous before anything is sent', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const endpoint = nousEndpoint();
    const outcome = await gateway(endpoint.fetch).generate(request('p', `public text ${secret}`));
    assert.equal(outcome.status === 'blocked' ? outcome.reason : outcome.status, 'no_route');
    assert.equal(endpoint.sent.length, 0);
    assert.ok(outcome.uncertainty.includes('nous.solar: excluded (credential_content)'));
    assert.ok(!JSON.stringify(outcome).includes(secret));
  });
});
