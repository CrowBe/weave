/** The privacy boundary is verified on the actual SDK HTTP body, with no live endpoint. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInferenceGateway } from '../src/gateway.js';
import {
  museSparkAdapter,
  MUSE_SPARK_ADAPTER,
  MUSE_SPARK_PRIMARY_MODEL,
  MUSE_SPARK_FALLBACK_MODEL,
  MUSE_SPARK_DESTINATION,
  MUSE_SPARK_DEFAULT_SETTINGS,
} from '../src/adapters/muse-spark.js';
import type { GenerationAdapter, GenerationCall, GenerationRequest, InferenceTerms, RoutedUnit } from '../src/types.js';

const TERMS: InferenceTerms = {
  quality: 'baseline',
  destinations: [MUSE_SPARK_DESTINATION],
  max_context_tokens: 100,
  deadline: 1000,
  cost_ceiling: 1,
  max_attempts: 2,
};
const ROUTE: RoutedUnit = {
  routed_unit_id: 'muse-writer',
  context_profile: 'public',
  context_profile_version: 1,
  prompt_template: 'writer',
  prompt_template_version: 1,
  adapter: MUSE_SPARK_ADAPTER,
  model: MUSE_SPARK_PRIMARY_MODEL,
  settings: MUSE_SPARK_DEFAULT_SETTINGS,
  destination: MUSE_SPARK_DESTINATION,
  billing: 'metered',
  destination_training_allowed: true,
  quality: 'baseline',
  context_limit_tokens: 100,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  operation: 'generate',
  kind: 'transform',
};
const FALLBACK: RoutedUnit = {
  ...ROUTE,
  routed_unit_id: 'muse-fallback',
  model: MUSE_SPARK_FALLBACK_MODEL,
  destination_training_allowed: false,
}; // The destination-wide mark must still apply.

function harness(routes: readonly RoutedUnit[] = [ROUTE, FALLBACK], apiKey = 'injected-test-key') {
  const bodies: { model: string; messages: { role: string; content: string }[] }[] = [];
  const ordinaryCalls: GenerationCall[] = [];
  const ordinary: GenerationAdapter = {
    id: 'ordinary',
    async execute(call) {
      ordinaryCalls.push(call);
      return {
        status: 'completed',
        text: 'ok',
        usage: { input_tokens: 2, output_tokens: 1 },
        finish_reason: 'stop',
        provider_response_id: undefined,
      };
    },
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://mock.invalid/v1/chat/completions');
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        id: 'fake',
        model: MUSE_SPARK_PRIMARY_MODEL,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const adapter = museSparkAdapter({ apiKey, baseURL: 'http://mock.invalid/v1', fetch });
  return {
    bodies,
    ordinaryCalls,
    gateway: createInferenceGateway({ routes, adapters: [adapter, ordinary], clock: { now: () => 1 } }),
  };
}
function request(input: GenerationRequest['input']): GenerationRequest {
  return {
    request_id: 'privacy-http',
    site: 'test',
    role: 'working',
    kind: 'transform',
    input,
    terms: { ...TERMS, content_class: 'non_sensitive' },
  };
}

for (const field of ['prompt', 'instructions'] as const) {
  for (const padded of [false, true]) {
    test(`adapter key in ${field} fails closed before HTTP dispatch (${padded ? 'trimmed' : 'exact'})`, async () => {
      const credential = 'MUSEKEY0123456789abcdef';
      const apiKey = padded ? ` ${credential} ` : credential;
      const priced = [ROUTE, FALLBACK].map((route) => ({ ...route, price: { input_per_mtok: 1, output_per_mtok: 1 } }));
      const { gateway, bodies } = harness(priced, apiKey);
      const input = { instructions: 'Use public material', prompt: 'Reply ok', [field]: `Example(${credential})` };
      const outcome = await gateway.generate(request(input));
      assert.equal(bodies.length, 0, 'primary and 1.2 fallback must receive no HTTP requests');
      assert.equal(outcome.status, 'unaccepted');
      assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'attempts_exhausted');
      assert.deepEqual(
        outcome.attempts.map((attempt) => attempt.routed_unit_id),
        ['muse-writer', 'muse-fallback'],
      );
      for (const attempt of outcome.attempts) {
        assert.equal(attempt.disposition.status, 'failed');
        if (attempt.disposition.status === 'failed') {
          assert.equal(attempt.disposition.failure.code, 'invalid_request');
          assert.equal(attempt.disposition.failure.retryable, false);
        }
        assert.deepEqual(attempt.usage, { input_tokens: 0, output_tokens: 0 });
        assert.equal(attempt.cost_is_upper_bound, false);
      }
      assert.equal(outcome.spent, 0);
      assert.ok(!JSON.stringify(outcome).includes(credential), 'result, error and trace must not contain the key');
      assert.ok(input[field].includes(credential));
    });
  }

  test(`ordinary ${field} reaches the training destination unchanged`, async () => {
    const { gateway, bodies } = harness();
    const content = 'task-123 risk-high desk_lamp Slovakia';
    const input = { instructions: 'Use public material', prompt: 'Reply ok', [field]: content };
    const outcome = await gateway.generate(request(input));
    assert.equal(outcome.status, 'accepted');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.model, MUSE_SPARK_PRIMARY_MODEL);
    assert.ok(
      bodies[0]?.messages.some(
        (message) => message.role === (field === 'prompt' ? 'user' : 'system') && message.content === content,
      ),
    );
  });

  const markers = [
    'sk-',
    'sk_',
    'Bearer ',
    'eyJ',
    'ghp_',
    'gho_',
    'ghu_',
    'ghs_',
    'ghr_',
    'github_pat_',
    'AKIA',
    'Bearer\t',
    'Bearer\n',
    'AIza',
    'xoxa-',
    'xoxb-',
    'xoxp-',
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
  ];
  for (const [index, marker] of markers.entries()) {
    test(`credential family ${index + 1} in ${field} fails closed before primary or 1.2 HTTP dispatch`, async () => {
      const { gateway, bodies } = harness();
      const credential = marker + 'test-SENTINEL' + 'A'.repeat(40);
      const input = { instructions: 'Use public material', prompt: 'Reply ok', [field]: `Example (${credential})` };
      const outcome = await gateway.generate(request(input));
      assert.equal(bodies.length, 0, 'training destination must receive no HTTP requests, including fallback');
      assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'no_route');
      assert.deepEqual(outcome.attempts, [], 'routing exclusions must not consume attempts');
      assert.equal(outcome.spent, 0);
      for (const id of ['muse-writer', 'muse-fallback']) {
        assert.ok(outcome.uncertainty.includes(`${id}: excluded (credential_content)`));
      }
      assert.ok(
        !JSON.stringify(outcome).includes(credential),
        'result, failure and attempt trace must not contain the credential',
      );
      assert.ok(input[field].includes(credential), 'caller content is not mutated');
    });
  }

  test(`one attempt reaches a permitted non-training destination with original ${field}`, async () => {
    const ordinary: RoutedUnit = {
      ...ROUTE,
      routed_unit_id: 'ordinary',
      adapter: 'ordinary',
      destination: 'ordinary',
      destination_training_allowed: false,
    };
    const { gateway, bodies, ordinaryCalls } = harness([ROUTE, FALLBACK, ordinary]);
    const credential = 'sk-' + 'test-SENTINEL' + 'A'.repeat(40);
    const input = { instructions: 'Use public material', prompt: 'Reply ok', [field]: credential };
    const req = request(input);
    const outcome = await gateway.generate({
      ...req,
      terms: { ...req.terms, destinations: [MUSE_SPARK_DESTINATION, 'ordinary'], max_attempts: 1 },
    });
    assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : '', 'ordinary');
    assert.deepEqual(
      outcome.attempts.map((attempt) => attempt.routed_unit_id),
      ['ordinary'],
    );
    for (const id of ['muse-writer', 'muse-fallback']) {
      assert.ok(outcome.uncertainty.includes(`${id}: excluded (credential_content)`));
    }
    assert.equal(bodies.length, 0, 'Muse Spark must receive no HTTP requests even when escalation succeeds elsewhere');
    assert.equal(ordinaryCalls.length, 1);
    assert.equal(ordinaryCalls[0]?.instructions, input.instructions);
    assert.equal(ordinaryCalls[0]?.prompt, input.prompt);
    assert.ok(!JSON.stringify(outcome).includes(credential));
  });
}

test('a non-training destination keeps private caller content unchanged', async () => {
  const { gateway, bodies } = harness([{ ...ROUTE, destination_training_allowed: false }]);
  const input = { instructions: 'Bearer ' + 'test-SENTINEL', prompt: 'sk-' + 'test-SENTINEL' };
  const req = request(input);
  assert.equal(
    (await gateway.generate({ ...req, terms: { ...req.terms, content_class: 'private' } })).status,
    'accepted',
  );
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0]?.messages.some((message) => message.content === input.instructions));
  assert.ok(bodies[0]?.messages.some((message) => message.content === input.prompt));
});
