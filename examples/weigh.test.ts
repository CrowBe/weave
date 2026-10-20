/**
 * Composition tests for the weigh example. No request leaves the process:
 * the one gateway call below goes to a stubbed `fetch`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyRouteOverlay, createInferenceGateway } from '@weave/gateway';
import { composeWeigh } from './weigh.ts';

const example = JSON.parse(readFileSync(new URL('../weave.routes.example.json', import.meta.url), 'utf8')) as {
  units: Record<string, unknown>[];
};

/** Example config with the decision provider served from loopback under its own destination. */
const loopback = applyRouteOverlay(example, {
  decision: { providers: { 'typesafe-jev': { base_url: 'http://127.0.0.1:9123', model: 'jev-local', key_env: 'LOCAL_JEV_KEY' } } },
  units: example.units.map((unit) => unit['adapter'] === 'typesafe-ai' ? { ...unit, model: 'jev-local', destination: 'local-jev' } : unit),
});

test('direct TypeSafe is tried first when both keys are set', () => {
  const composed = composeWeigh(example, { TYPESAFE_API_KEY: 'ts', AI_GATEWAY_API_KEY: 'gw' });
  assert.ok(composed.ok);
  assert.deepEqual(composed.routes.map((unit) => unit.routed_unit_id), [
    'score.candidate@typesafe', 'score.candidate@vercel', 'boolean.candidate@typesafe', 'boolean.candidate@vercel',
  ]);
  assert.deepEqual(composed.destinations, ['typesafe-ai', 'vercel-ai-gateway']);
  assert.deepEqual(composed.evaluators.map((adapter) => adapter.id), ['typesafe-ai', 'vercel-ai-gateway']);
});

test('the default key_env keeps the legacy key name; a gateway key alone still works', () => {
  const legacy = composeWeigh(example, { TYPESAFE_AI_API_KEY: 'legacy' });
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.routes.map((unit) => unit.routed_unit_id), ['score.candidate@typesafe', 'boolean.candidate@typesafe']);
  const gateway = composeWeigh(example, { AI_GATEWAY_API_KEY: 'gw' });
  assert.ok(gateway.ok);
  assert.deepEqual(gateway.destinations, ['vercel-ai-gateway']);
});

test('no usable credential is an error naming the configured key_env', () => {
  const missing = composeWeigh(example, { TYPESAFE_API_KEY: '  ' });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error, /TYPESAFE_API_KEY/);
  // A provider that names its own key_env never borrows the hosted TypeSafe key.
  const other = composeWeigh(loopback, { TYPESAFE_API_KEY: 'hosted', TYPESAFE_AI_API_KEY: 'hosted' });
  assert.equal(other.ok, false);
  assert.match(other.ok ? '' : other.error, /LOCAL_JEV_KEY/);
});

test('the direct unit takes its destination, model, base URL and key from the config', async (t) => {
  const composed = composeWeigh(loopback, { LOCAL_JEV_KEY: ' local-key ', TYPESAFE_API_KEY: 'hosted-key' });
  assert.ok(composed.ok);
  assert.deepEqual(composed.routes.map((unit) => [unit.routed_unit_id, unit.model, unit.destination]), [
    ['score.candidate@typesafe', 'jev-local', 'local-jev'],
    ['boolean.candidate@typesafe', 'jev-local', 'local-jev'],
  ]);
  assert.deepEqual(composed.destinations, ['local-jev']);

  const seen: { url: string; authorization: string | null; model: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), model: JSON.parse(String(init?.body))['model'] });
    return new Response(JSON.stringify({ model: 'jev-local', answers: { a: { type: 'noul', noul: 0.25 } }, usage: { input_tokens: 4 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  // Rebuild after the stub: adapters capture `fetch` when they are constructed.
  const stubbed = composeWeigh(loopback, { LOCAL_JEV_KEY: ' local-key ' });
  assert.ok(stubbed.ok);
  const gateway = createInferenceGateway({ routes: stubbed.routes, evaluators: stubbed.evaluators, clock: { now: () => 0 } });
  const outcome = await gateway.evaluate({
    request_id: 'weigh-test', site: 'example.weigh.candidates', role: 'framing', kind: 'boolean',
    state: { goal: 'test' }, questions: { a: { type: 'boolean', instructions: 'Is a risky?' } },
    terms: { quality: 'baseline', destinations: stubbed.destinations, max_context_tokens: 4_000, deadline: 60_000, cost_ceiling: 1_000, max_attempts: 1 },
  });
  assert.equal(outcome.status, 'accepted');
  assert.deepEqual(seen, [{ url: 'http://127.0.0.1:9123/v1/systemone', authorization: 'Bearer local-key', model: 'jev-local' }]);
});
