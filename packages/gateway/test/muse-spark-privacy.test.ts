/** The privacy boundary is verified on the actual SDK HTTP body, with no live endpoint. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInferenceGateway } from '../src/gateway.js';
import { museSparkAdapter, MUSE_SPARK_ADAPTER, MUSE_SPARK_PRIMARY_MODEL, MUSE_SPARK_DESTINATION } from '../src/adapters/muse-spark.js';
import type { InferenceTerms, RoutedUnit } from '../src/types.js';

const TERMS: InferenceTerms = {
  quality: 'baseline', destinations: [MUSE_SPARK_DESTINATION], max_context_tokens: 100,
  deadline: 1000, cost_ceiling: 1, max_attempts: 1,
};
const ROUTE: RoutedUnit = {
  routed_unit_id: 'muse-writer', context_profile: 'public', context_profile_version: 1,
  prompt_template: 'writer', prompt_template_version: 1, adapter: MUSE_SPARK_ADAPTER,
  model: MUSE_SPARK_PRIMARY_MODEL, settings: { max_output_tokens: 10 },
  destination: MUSE_SPARK_DESTINATION, destination_training_allowed: true,
  quality: 'baseline', context_limit_tokens: 100,
  price: { input_per_mtok: 0, output_per_mtok: 0 }, operation: 'generate', kind: 'transform',
};

test('training disclosure redacts credentials from the SDK HTTP body and preserves ordinary destination content', async () => {
  const bodies: string[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://mock.invalid/v1/chat/completions');
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({
      id: 'fake', model: MUSE_SPARK_PRIMARY_MODEL,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { headers: { 'content-type': 'application/json' } });
  };
  const adapter = museSparkAdapter({ apiKey: 'injected-test-key', baseURL: 'http://mock.invalid/v1', fetch });
  const credentials = ['sk-test-secret', 'Bearer secret', 'eyJsecret', 'ghp_secret', 'github_pat_secret', 'AKIAsecret'];
  const input = { instructions: 'Use public material', prompt: credentials.join(' ') };
  const request = { request_id: 'privacy-http', site: 'test', role: 'working' as const,
    kind: 'transform' as const, input, terms: { ...TERMS, content_class: 'non_sensitive' as const } };
  const training = createInferenceGateway({ routes: [ROUTE], adapters: [adapter], clock: { now: () => 1 } });
  assert.equal((await training.generate(request)).status, 'accepted');
  assert.equal(bodies.length, 1);
  for (const credential of credentials) assert.ok(!bodies[0]!.includes(credential), 'HTTP body must redact credentials before training disclosure');
  assert.ok(bodies[0]!.includes('Use public material'));
  assert.ok(bodies[0]!.includes('[REDACTED]'));

  const ordinary = createInferenceGateway({ routes: [{ ...ROUTE, destination_training_allowed: false }],
    adapters: [adapter], clock: { now: () => 1 } });
  assert.equal((await ordinary.generate({ ...request, terms: { ...TERMS, content_class: 'private' } })).status, 'accepted');
  assert.equal(bodies.length, 2);
  for (const credential of credentials) assert.ok(bodies[1]!.includes(credential), 'ordinary destination keeps caller content unchanged');
});
