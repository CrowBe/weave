import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInferenceGateway } from '../src/gateway.js';
import { route } from '../src/routing.js';
import type { EvaluationAdapter, EvaluationCall, GenerationAdapter, GenerationCall, GenerationRequest, InferenceTerms, RoutedUnit } from '../src/types.js';

const terms: InferenceTerms = {
  quality: 'baseline', destinations: ['contributor', 'ordinary'], max_context_tokens: 100,
  deadline: 1000, cost_ceiling: 1, max_attempts: 2,
};
function unit(training = true, overrides: Partial<RoutedUnit> = {}): RoutedUnit {
  return {
    routed_unit_id: 'writer', context_profile: 'public', context_profile_version: 1,
    prompt_template: 'writer', prompt_template_version: 1, adapter: 'fake', model: 'fake',
    settings: { max_output_tokens: 20 }, destination: 'contributor', quality: 'baseline',
    context_limit_tokens: 100, price: { input_per_mtok: 0, output_per_mtok: 0 },
    operation: 'generate', kind: 'transform', destination_training_allowed: training, ...overrides,
  } as unknown as RoutedUnit;
}
function classified(content_class?: string): InferenceTerms {
  return { ...terms, ...(content_class === undefined ? {} : { content_class }) } as InferenceTerms;
}
function request(input = { instructions: 'Use public material', prompt: 'Reply ok' }, content_class?: string): GenerationRequest {
  return { request_id: 'privacy', site: 'test', role: 'working', kind: 'transform', input, terms: classified(content_class) };
}
function generator(calls: GenerationCall[]): GenerationAdapter {
  return { id: 'fake', async execute(call) {
    calls.push(call);
    return { status: 'completed', text: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: 'stop', provider_response_id: undefined };
  } };
}

describe('training-allowed destination privacy', () => {
  for (const contentClass of [undefined, 'sensitive', 'private']) {
    it(`excludes permitted training destinations for ${contentClass ?? 'absent'} content class`, async () => {
      const calls: GenerationCall[] = [];
      const decision = route([unit()], { operation: 'generate', kind: 'transform' }, classified(contentClass), 20);
      assert.deepEqual(decision.order, [], 'training destination must be excluded');
      assert.deepEqual(decision.excluded, [{ routed_unit_id: 'writer', reason: 'destination_not_permitted' }]);
      const gateway = createInferenceGateway({ routes: [unit()], adapters: [generator(calls)], clock: { now: () => 1 } });
      const outcome = await gateway.generate(request(undefined, contentClass));
      assert.equal(outcome.status, 'blocked');
      assert.equal(calls.length, 0, 'excluded work never reaches the adapter');
    });
  }
  for (const contentClass of ['public', 'non_sensitive']) {
    it(`includes training destinations for explicit ${contentClass} content`, async () => {
      const calls: GenerationCall[] = [];
      const gateway = createInferenceGateway({ routes: [unit()], adapters: [generator(calls)], clock: { now: () => 1 } });
      assert.equal((await gateway.generate(request(undefined, contentClass))).status, 'accepted');
      assert.equal(calls.length, 1);
    });
  }
  it('routes sensitive content to the non-training destination in a mixed table', async () => {
    const calls: GenerationCall[] = [];
    const gateway = createInferenceGateway({
      routes: [unit(), unit(false, { routed_unit_id: 'ordinary', destination: 'ordinary' })],
      adapters: [generator(calls)], clock: { now: () => 1 },
    });
    const outcome = await gateway.generate(request(undefined, 'sensitive'));
    assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : '', 'ordinary');
    assert.equal(calls.length, 1);
  });
  it('applies a training mark to every routed unit at the same destination', () => {
    const decision = route([unit(), unit(false, { routed_unit_id: 'unmarked' })],
      { operation: 'generate', kind: 'transform' }, classified('private'), 20);
    assert.equal(decision.order.length, 0, 'an unmarked unit cannot bypass destination policy');
  });
  it('rejects an unknown content class without sending it to a provider', async () => {
    const calls: GenerationCall[] = [];
    const gateway = createInferenceGateway({ routes: [unit(false)], adapters: [generator(calls)], clock: { now: () => 1 } });
    const outcome = await gateway.generate(request(undefined, 'safe'));
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'invalid_request');
    assert.equal(calls.length, 0);
  });
  for (const credential of ['sk-test-secret', 'sk_secret', 'Bearer secret', 'eyJsecret', 'ghp_secret', 'gho_secret', 'ghu_secret', 'ghs_secret', 'ghr_secret', 'github_pat_secret', 'AKIAsecret']) {
    it(`redacts the existing credential family ${credential.split(/[-_ ]/)[0]} before training disclosure`, async () => {
      const calls: GenerationCall[] = [];
      const input = { instructions: `Instruction ${credential}`, prompt: `Public text with ${credential}` };
      const gateway = createInferenceGateway({ routes: [unit()], adapters: [generator(calls)], clock: { now: () => 1 } });
      await gateway.generate(request(input, 'non_sensitive'));
      assert.equal(calls.length, 1);
      assert.ok(!JSON.stringify(calls).includes(credential), 'credential must not cross the provider port');
      assert.deepEqual(input, { instructions: `Instruction ${credential}`, prompt: `Public text with ${credential}` }, 'caller input is not mutated');
    });
  }
  it('preserves content for non-training destinations', async () => {
    const calls: GenerationCall[] = [];
    const input = { instructions: 'Bearer secret', prompt: 'sk-test-secret' };
    const gateway = createInferenceGateway({ routes: [unit(false)], adapters: [generator(calls)], clock: { now: () => 1 } });
    await gateway.generate(request(input, 'private'));
    assert.equal(calls[0]?.instructions, input.instructions);
    assert.equal(calls[0]?.prompt, input.prompt);
  });
  it('redacts an unmarked routed unit sharing a training-allowed destination', async () => {
    const calls: GenerationCall[] = [];
    const gateway = createInferenceGateway({
      routes: [unit(false), unit(true, { routed_unit_id: 'marked' })],
      adapters: [generator(calls)], clock: { now: () => 1 },
    });
    await gateway.generate(request({ instructions: 'Read', prompt: 'sk-test-secret' }, 'public'));
    assert.ok(!JSON.stringify(calls).includes('sk-test-secret'));
  });
  it('enforces privacy for evaluation and redacts nested state and question content', async () => {
    const calls: EvaluationCall[] = [];
    const evaluator: EvaluationAdapter = { id: 'fake', async evaluate(call) {
      calls.push(call);
      return { status: 'completed', answers: { q: { type: 'boolean', probability: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 }, provider_response_id: undefined, confidence: undefined };
    } };
    const gateway = createInferenceGateway({ routes: [unit(true, { operation: 'evaluate', kind: 'boolean' })],
      evaluators: [evaluator], clock: { now: () => 1 } });
    const state = { nested: ['sk-test-secret', { 'github_pat_key': 'Bearer secret' }], safe: 'public data' };
    const questions = { q: { type: 'boolean' as const, instructions: 'eyJsecret', criteria: { true: { text: 'AKIAsecret' }, false: 'public' } } };
    const base = { request_id: 'eval', site: 'test', role: 'working' as const, kind: 'boolean' as const, state, questions };
    assert.equal((await gateway.evaluate({ ...base, terms })).status, 'blocked');
    assert.equal(calls.length, 0);
    assert.equal((await gateway.evaluate({ ...base, terms: classified('public') })).status, 'accepted');
    assert.equal(calls.length, 1);
    for (const secret of ['sk-test-secret', 'github_pat_key', 'Bearer secret', 'eyJsecret', 'AKIAsecret']) {
      assert.ok(!JSON.stringify(calls).includes(secret), 'evaluation content must be redacted');
    }
    assert.ok(JSON.stringify(calls).includes('public data'));
    assert.equal(state.nested[0], 'sk-test-secret');
  });
  it('retains destination training policy when a decision binding filters the marked unit out', async () => {
    let calls = 0;
    const evaluator: EvaluationAdapter = { id: 'typesafe-ai', async evaluate() {
      calls++;
      return { status: 'failed', failure: { code: 'unavailable', message: 'fake', retryable: false } };
    } };
    const gateway = createInferenceGateway({
      routes: [unit(), unit(false, { operation: 'evaluate', kind: 'boolean', routed_unit_id: 'judge', adapter: 'typesafe-ai', model: 'jev' })],
      adapters: [generator([])], evaluators: [evaluator], clock: { now: () => 1 },
      decision: { provider: 'typesafe-jev', fallback: null, providers: { 'typesafe-jev': { base_url: 'http://mock.invalid', model: 'jev' } } },
    });
    const outcome = await gateway.evaluate({ request_id: 'eval', site: 'test', role: 'working', kind: 'boolean',
      state: 'private material', questions: { q: { type: 'boolean', instructions: 'valid?' } }, terms });
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'no_route');
    assert.equal(calls, 0, 'binding cannot remove the destination privacy policy');
  });
});
