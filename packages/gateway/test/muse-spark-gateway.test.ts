/** Provider + gateway composition, with an injected endpoint only. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInferenceGateway, type GenerationRequest, type RoutedUnit, type Timer } from '@weave/gateway';
import { museSparkAdapter, MUSE_SPARK_ADAPTER, MUSE_SPARK_DESTINATION,
  MUSE_SPARK_PRIMARY_MODEL, MUSE_SPARK_FALLBACK_MODEL,
  MUSE_SPARK_DOCUMENTED_CONTRIBUTOR_LIMITS } from '@weave/gateway/muse-spark';

const KEY = 'sk-test-SENTINEL-gateway-credential';
const primary: RoutedUnit = {
  routed_unit_id: 'muse.primary', operation: 'generate', kind: 'transform', tier: 'flash',
  context_profile: 'test', context_profile_version: 1, prompt_template: 'test', prompt_template_version: 1,
  adapter: MUSE_SPARK_ADAPTER, model: MUSE_SPARK_PRIMARY_MODEL, settings: { max_output_tokens: 10 },
  destination: MUSE_SPARK_DESTINATION, destination_training_allowed: true,
  quality: 'baseline', context_limit_tokens: 100, price: { input_per_mtok: 0, output_per_mtok: 0 },
  rate_limits: MUSE_SPARK_DOCUMENTED_CONTRIBUTOR_LIMITS,
};
const fallback: RoutedUnit = { ...primary, routed_unit_id: 'muse.fallback', model: MUSE_SPARK_FALLBACK_MODEL };
function request(id = 'test', prompt = 'ok'): GenerationRequest {
  return { request_id: id, site: 'implement.generate', role: 'working', kind: 'transform',
    input: { instructions: '', prompt }, terms: { quality: 'baseline', tier: 'flash', content_class: 'non_sensitive',
      destinations: [MUSE_SPARK_DESTINATION], max_context_tokens: 10, deadline: 100_000,
      cost_ceiling: 0, max_attempts: 2, max_attempts_per_route: 1 } };
}
function completion(text = 'ok'): Response {
  return new Response(JSON.stringify({ id: 'test', choices: [{ index: 0,
    message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
    { headers: { 'content-type': 'application/json' } });
}
function refused(status: number): Response {
  return new Response(JSON.stringify({ error: { message: KEY, type: 'provider_error' } }),
    { status, headers: { 'content-type': 'application/json' } });
}
function gateway(fetch: typeof globalThis.fetch, options: { timer?: Timer; now?: () => number; key?: string } = {}) {
  return createInferenceGateway({ routes: [primary, fallback],
    adapters: [museSparkAdapter({ apiKey: options.key ?? KEY, fetch })],
    clock: { now: options.now ?? (() => 0) }, ...(options.timer ? { timer: options.timer } : {}) });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('Muse Spark routed attempts', () => {
  for (const status of [429, 503, 404]) {
    it(`escalates a ${status} primary refusal to the explicit 1.2 routed unit`, async () => {
      const models: string[] = [];
      const outcome = await gateway(async (_url, init) => {
        const model = JSON.parse(String(init?.body)).model as string;
        models.push(model);
        return model === MUSE_SPARK_PRIMARY_MODEL ? refused(status) : completion();
      }).generate(request());
      assert.equal(outcome.status, 'accepted');
      assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : '', 'muse.fallback');
      assert.deepEqual(models, [MUSE_SPARK_PRIMARY_MODEL, MUSE_SPARK_FALLBACK_MODEL]);
      assert.equal(outcome.attempts.length, 2);
      assert.ok(!JSON.stringify(outcome).includes(KEY));
    });
  }

  it('records both refusals and stops at max_attempts without a third HTTP request', async () => {
    let calls = 0;
    const outcome = await gateway(async () => { calls += 1; return refused(503); }).generate(request());
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(calls, 2);
    assert.equal(outcome.attempts.length, 2);
    assert.ok(outcome.attempts.every(attempt => attempt.disposition.status === 'failed'));
    assert.ok(!JSON.stringify(outcome).includes(KEY));
  });

  it('cancels a mid-request fetch without retry or fallback and keeps traces credential-free', async () => {
    const entered = deferred();
    const controller = new AbortController();
    let calls = 0;
    let observed: AbortSignal | null | undefined;
    let watcherCancelled = false;
    const timer: Timer = { sleep(_ms, signal) {
      return new Promise(resolve => signal?.addEventListener('abort', () => {
        watcherCancelled = true;
        resolve();
      }, { once: true }));
    } };
    const instance = gateway(async (_url, init) => {
      calls += 1;
      observed = init?.signal;
      entered.resolve();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(KEY)), { once: true });
      });
    }, { timer });
    const pending = instance.generate(request(), controller.signal);
    await entered.promise;
    controller.abort(KEY);
    const outcome = await pending;
    assert.equal(observed?.aborted, true);
    assert.equal(calls, 1);
    assert.equal(outcome.attempts.length, 1);
    assert.equal(watcherCancelled, true);
    assert.equal(outcome.attempts[0]?.disposition.status === 'failed' ? outcome.attempts[0].disposition.failure.code : '', 'cancelled');
    assert.ok(!JSON.stringify(outcome).includes(KEY));
  });

  it('the gateway deadline aborts the actual SDK fetch and records timeout', async () => {
    const entered = deferred();
    let now = 0;
    let fire!: () => void;
    let observed: AbortSignal | null | undefined;
    let calls = 0;
    const timer: Timer = { sleep(ms, signal) {
      return new Promise(resolve => {
        fire = () => { now += ms; resolve(); };
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    } };
    const instance = gateway(async (_url, init) => {
      calls += 1;
      observed = init?.signal;
      entered.resolve();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(KEY)), { once: true });
      });
    }, { timer, now: () => now });
    const pending = instance.generate(request());
    await entered.promise;
    fire();
    const outcome = await pending;
    assert.equal(observed?.aborted, true);
    assert.equal(calls, 1);
    assert.equal(outcome.attempts[0]?.disposition.status === 'failed' ? outcome.attempts[0].disposition.failure.code : '', 'timeout');
    assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'deadline_reached');
    assert.ok(!JSON.stringify(outcome).includes(KEY));
  });

  it('isolates concurrent keys and request bodies across adapter instances', async () => {
    const sent: { key: string | null; prompt: string }[] = [];
    const outcomes = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const key = `${KEY}-${i}`;
      return gateway(async (_url, init) => {
        await Promise.resolve();
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        sent.push({ key: new Headers(init?.headers).get('authorization'), prompt: body.messages[0]!.content });
        return completion(key);
      }, { key }).generate(request(`concurrent-${i}`, `public-${i}`));
    }));
    assert.equal(sent.length, 8);
    for (let i = 0; i < 8; i += 1) {
      assert.ok(sent.some(item => item.key === `Bearer ${KEY}-${i}` && item.prompt === `public-${i}`));
      assert.equal(outcomes[i]?.status, 'accepted');
    }
    assert.ok(!JSON.stringify(outcomes).includes(KEY));
  });

  it('one concurrent call backs off 400ms without delaying or changing another call', async () => {
    const waiting = deferred();
    const release = deferred();
    const counts = new Map<string, number>();
    const waits: number[] = [];
    const timer: Timer = { sleep(ms, signal) {
      if (signal) return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      waits.push(ms);
      waiting.resolve();
      return release.promise;
    } };
    const instance = gateway(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const prompt = body.messages[0]!.content;
      const count = (counts.get(prompt) ?? 0) + 1;
      counts.set(prompt, count);
      return prompt === 'alpha' && count === 1 ? refused(429) : completion(prompt);
    }, { timer });
    const alphaRequest = request('alpha', 'alpha');
    const alpha = instance.generate({ ...alphaRequest, terms: { ...alphaRequest.terms, max_attempts_per_route: 2 } });
    await waiting.promise;
    const beta = await instance.generate(request('beta', 'beta'));
    assert.equal(beta.status, 'accepted');
    assert.deepEqual(waits, [400]);
    assert.equal(counts.get('alpha'), 1);
    release.resolve();
    const outcome = await alpha;
    assert.equal(outcome.status, 'accepted');
    assert.equal(outcome.attempts[1]?.waited_ms, 400);
    assert.equal(beta.attempts.length, 1);
    assert.equal(beta.attempts[0]?.waited_ms, undefined);
    assert.equal(counts.get('alpha'), 2);
    assert.equal(counts.get('beta'), 1);
  });

  it('redacts credential-shaped content in the body actually sent to the training destination', async () => {
    const secret = 'sk-' + 'A'.repeat(40);
    let body = '';
    const outcome = await gateway(async (_url, init) => { body = String(init?.body); return completion(); })
      .generate(request('redaction', `harmless example with ${secret}`));
    assert.equal(outcome.status, 'accepted');
    assert.ok(!body.includes(secret));
    assert.ok(body.includes('[REDACTED]'));
  });
});
