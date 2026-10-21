/** Offline contract: promo membership is opt-in, time bounded, and never bypasses price guards. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as nous from '@weave/gateway/nous-portal';
import type { GenerationCall, GenerationProviderResult } from '@weave/gateway';
import { catalogueWith, completionBody, deferred, json, nousEndpoint } from './nous-portal-fixtures.js';

const KEY = 'offline-promo-credential';
const EXPIRES_AT = Date.parse('2026-10-23T10:30:00+11:00');
const PROMOS = {
  longcat25: { id: 'meituan/longcat-2.5-preview:free', expires_at: EXPIRES_AT },
  beam: { id: 'reflection/beam-1.0-501b-a23b:free', expires_at: EXPIRES_AT },
} as const;
const NOT_ALLOWLISTED = 'nous-portal: model is not on the free-model allowlist; no request sent';
const PRICE_REFUSED = 'nous-portal: model refused: a non-zero or unreadable price was observed';
const CALL: GenerationCall = {
  model: '', instructions: 'Be brief.', prompt: 'Reply with ok.',
  settings: { max_output_tokens: 64 }, signal: undefined,
};

function refused(result: GenerationProviderResult, message = NOT_ALLOWLISTED) {
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.deepEqual(result.failure, { code: 'invalid_request', message, retryable: false });
  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
  assert.ok(!JSON.stringify(result).includes(KEY));
}

it('exports the exact promo map separately from the default free-model allowlist', () => {
  assert.deepEqual(nous.NOUS_PORTAL_PROMO_MODELS, PROMOS);
  for (const { id } of Object.values(PROMOS)) {
    assert.equal(nous.isNousPortalFreeModel(id), false);
    assert.ok(!Object.values(nous.NOUS_PORTAL_FREE_MODELS).some(model => String(model) === id));
  }
});

for (const [name, { id: model }] of Object.entries(PROMOS)) {
  describe(`Nous promo ${name}`, () => {
    const call = { ...CALL, model };

    it('refuses without explicit opt-in, before any request', async () => {
      for (const promoModels of [undefined, false]) {
        const endpoint = nousEndpoint();
        const options = { apiKey: KEY, fetch: endpoint.fetch,
          ...(promoModels === undefined ? {} : { promoModels }), now: () => EXPIRES_AT - 1 };
        refused(await nous.nousPortalAdapter(options).execute(call));
        assert.equal(endpoint.sent.length, 0);
      }
    });

    it('opts in before expiry, checks decimal-zero catalogue pricing, and sends chat', async () => {
      const endpoint = nousEndpoint({ chat: () => json(completionBody('ok', { cost: 0 }, model)) });
      const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true, now: () => EXPIRES_AT - 1 };
      assert.equal((await nous.nousPortalAdapter(options).execute(call)).status, 'completed');
      assert.equal(endpoint.catalogueRequests.length, 1);
      assert.equal(endpoint.chatRequests.length, 1);
      assert.equal(endpoint.chatRequests[0]?.body?.['model'], model);
    });

    it('refuses priced catalogue evidence permanently without sending chat', async () => {
      const endpoint = nousEndpoint({ catalogue: () => json(catalogueWith(model, {
        prompt: '0.0000000000', completion: '0.0000000001',
      })) });
      const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true, now: () => EXPIRES_AT - 1 };
      const adapter = nous.nousPortalAdapter(options);
      refused(await adapter.execute(call), PRICE_REFUSED);
      refused(await adapter.execute(call), PRICE_REFUSED);
      assert.equal(endpoint.catalogueRequests.length, 1);
      assert.equal(endpoint.chatRequests.length, 0);
    });

    for (const offset of [0, 1, 86_400_000]) {
      it(`refuses at expiry + ${offset} ms, stays refused even if time regresses, and sends nothing`, async () => {
        let now = EXPIRES_AT + offset;
        const endpoint = nousEndpoint();
        const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true, now: () => now };
        const adapter = nous.nousPortalAdapter(options);
        refused(await adapter.execute(call));
        now = EXPIRES_AT - 1;
        refused(await adapter.execute(call));
        assert.equal(endpoint.sent.length, 0);
      });
    }

    it('fails closed with missing, invalid, or throwing injected time', async () => {
      for (const now of [undefined, () => NaN, () => Infinity, () => -Infinity,
        () => { throw new Error('clock unavailable'); }]) {
        const endpoint = nousEndpoint();
        const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true,
          ...(now === undefined ? {} : { now }) };
        refused(await nous.nousPortalAdapter(options).execute(call));
        assert.equal(endpoint.sent.length, 0);
      }
    });

    it('shares one in-flight catalogue check for concurrent first calls before expiry', async () => {
      const release = deferred();
      const endpoint = nousEndpoint({ catalogue: async () => {
        await release.promise;
        return json(catalogueWith(model, { prompt: '0.0000000000', completion: '0.0000000000' }));
      } });
      const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true, now: () => EXPIRES_AT - 1 };
      const adapter = nous.nousPortalAdapter(options);
      const pending = [adapter.execute(call), adapter.execute(call)];
      const checksBeforeRelease = endpoint.catalogueRequests.length;
      const chatsBeforeRelease = endpoint.chatRequests.length;
      release.resolve();
      const results = await Promise.all(pending);
      assert.equal(checksBeforeRelease, 1);
      assert.equal(chatsBeforeRelease, 0);
      assert.deepEqual(results.map(result => result.status), ['completed', 'completed']);
      assert.equal(endpoint.catalogueRequests.length, 1);
      assert.equal(endpoint.chatRequests.length, 2);
    });

    it('refuses the second call when expiry crosses despite a cached catalogue pass', async () => {
      let now = EXPIRES_AT - 1;
      const endpoint = nousEndpoint();
      const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true, now: () => now };
      const adapter = nous.nousPortalAdapter(options);
      assert.equal((await adapter.execute(call)).status, 'completed');
      now = EXPIRES_AT;
      refused(await adapter.execute(call));
      now += 1;
      refused(await adapter.execute(call));
      assert.equal(endpoint.catalogueRequests.length, 1);
      assert.equal(endpoint.chatRequests.length, 1);
    });

    it('rechecks expiry after catalogue resolution and refuses chat if the check crossed it', async () => {
      let now = EXPIRES_AT - 1;
      const endpoint = nousEndpoint({ catalogue: () => {
        now = EXPIRES_AT;
        return json(catalogueWith(model, { prompt: '0', completion: '0' }));
      } });
      const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true, now: () => now };
      const adapter = nous.nousPortalAdapter(options);
      refused(await adapter.execute(call));
      refused(await adapter.execute(call));
      assert.equal(endpoint.catalogueRequests.length, 1);
      assert.equal(endpoint.chatRequests.length, 0);
    });

    it('keeps the response usage.cost guard and refuses subsequent calls after a charge', async () => {
      const endpoint = nousEndpoint({ chat: () => json(completionBody('ok', {
        prompt_tokens: 12, completion_tokens: 1, cost: 0.01,
      }, model)) });
      const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true, now: () => EXPIRES_AT - 1 };
      const adapter = nous.nousPortalAdapter(options);
      const result = await adapter.execute(call);
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') {
        assert.match(result.failure.message, /response reported a non-zero or non-numeric usage.cost/);
        assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 1 });
      }
      refused(await adapter.execute(call), PRICE_REFUSED);
      assert.equal(endpoint.catalogueRequests.length, 1);
      assert.equal(endpoint.chatRequests.length, 1);
    });

    it('never opts in a paid twin or an unknown model', async () => {
      const endpoint = nousEndpoint();
      const options = { apiKey: KEY, fetch: endpoint.fetch, promoModels: true, now: () => EXPIRES_AT - 1 };
      const adapter = nous.nousPortalAdapter(options);
      for (const id of [model.replace(/:free$/, ''), ` ${model}`, 'unknown:free', 'toString']) {
        refused(await adapter.execute({ ...call, model: id }));
      }
      assert.equal(endpoint.sent.length, 0);
    });
  });
}
