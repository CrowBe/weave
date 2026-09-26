/**
 * M6 prefix-cache routing (docs/m6-route-a-reconstructed-view.md §2, §6).
 *
 * Fixture prices and token counts. No live provider. The caller supplies the
 * prefix digest and the cache record; the gateway does not read Weave state.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createInferenceGateway,
  priceAttempt,
  route,
  worstCaseCost,
  type Clock,
  type GenerationAdapter,
  type GenerationProviderResult,
  type GenerationRequest,
  type InferenceTerms,
  type RoutedUnit,
} from '@weave/gateway';

type GenerateUnit = Extract<RoutedUnit, { operation: 'generate' }>;

const LONG_DIGEST = 'digest-long';
const SHORT_DIGEST = 'digest-short';

const CACHE = {
  routed_unit_id: 'route.strong',
  prefix_digest: LONG_DIGEST,
  cached_tokens: 650_000,
} as const;

function fakeClock(): Clock {
  let t = 100;
  return { now: () => t++ };
}

function scripted(id: string, result: GenerationProviderResult): GenerationAdapter & { calls: number } {
  let calls = 0;
  return {
    id,
    get calls() {
      return calls;
    },
    async execute(): Promise<GenerationProviderResult> {
      calls += 1;
      return result;
    },
  };
}

function completed(input: number, output: number): GenerationProviderResult {
  return {
    status: 'completed',
    text: 'ok',
    usage: { input_tokens: input, output_tokens: output },
    finish_reason: 'stop',
    provider_response_id: 'resp_1',
  };
}

function unreported(): GenerationProviderResult {
  return {
    status: 'completed',
    text: 'ok',
    usage: { input_tokens: undefined, output_tokens: undefined },
    finish_reason: 'stop',
    provider_response_id: 'resp_1',
  };
}

function unit(overrides: Partial<GenerateUnit> & Pick<GenerateUnit, 'routed_unit_id' | 'destination' | 'price'>): GenerateUnit {
  return {
    operation: 'generate',
    kind: 'transform',
    context_profile: 'profile.frame',
    context_profile_version: 1,
    prompt_template: 'template.frame',
    prompt_template_version: 1,
    adapter: overrides.adapter ?? overrides.routed_unit_id,
    model: overrides.routed_unit_id,
    settings: overrides.settings ?? { max_output_tokens: 120_000 },
    quality: overrides.quality ?? 'high',
    context_limit_tokens: overrides.context_limit_tokens ?? 800_000,
    evidence: overrides.evidence ?? { attempts: 20, accepted: 20 },
    ...overrides,
  };
}

const strong = unit({
  routed_unit_id: 'route.strong',
  destination: 'local',
  price: { input_per_mtok: 5_000_000, output_per_mtok: 25_000_000 },
});

const cheap = unit({
  routed_unit_id: 'route.cheap',
  destination: 'hosted.cheap',
  price: { input_per_mtok: 3_000_000, output_per_mtok: 15_000_000 },
});

function terms(overrides: Partial<InferenceTerms> = {}): InferenceTerms {
  return {
    quality: 'high',
    destinations: ['local', 'hosted.cheap'],
    max_context_tokens: 770_000,
    deadline: 10_000,
    cost_ceiling: 20_000_000,
    max_attempts: 2,
    ...overrides,
  };
}

function request(unitTerms: InferenceTerms): GenerationRequest {
  return {
    request_id: 'req-m6',
    site: 'goal.frame',
    role: 'framing',
    kind: 'transform',
    input: { instructions: 'frame', prompt: 'view' },
    terms: unitTerms,
  };
}

describe('M6 prefix cache', () => {
  it('M6-T01 long view with a matching digest stays on route.strong', async () => {
    const warm = terms({ prefix_digest: LONG_DIGEST, prefix_cache: CACHE });
    const decision = route([cheap, strong], { operation: 'generate', kind: 'transform' }, warm, 20);
    assert.equal(decision.order[0]?.routed_unit_id, 'route.strong');
    assert.equal(decision.order[1]?.routed_unit_id, 'route.cheap');
    assert.equal(worstCaseCost(strong, warm), 6_850_000);
    const strongAdapter = scripted('route.strong', completed(770_000, 120_000));
    const cheapAdapter = scripted('route.cheap', completed(770_000, 120_000));
    const gateway = createInferenceGateway({
      routes: [
        { ...cheap, adapter: 'route.cheap' },
        { ...strong, adapter: 'route.strong' },
      ],
      adapters: [strongAdapter, cheapAdapter],
      clock: fakeClock(),
    });
    const outcome = await gateway.generate(request({ ...warm, cost_ceiling: 6_850_000 }));
    assert.equal(outcome.status, 'accepted');
    if (outcome.status === 'accepted') {
      assert.equal(outcome.routed_unit_id, 'route.strong');
      assert.equal(outcome.spent, 3_600_000);
      assert.equal(outcome.attempts[0]?.cost_is_upper_bound, false);
    }
    assert.equal(cheapAdapter.calls, 0);
    const belowCold = await gateway.generate(request({ ...warm, cost_ceiling: 3_600_000, request_id: 'req-below' } as InferenceTerms));
    assert.equal(belowCold.status, 'blocked');
  });

  it('M6-T02 short view with no matching digest selects route.cheap', () => {
    const short = terms({
      max_context_tokens: 1_100,
      prefix_digest: SHORT_DIGEST,
      prefix_cache: CACHE,
    });
    const shortStrong = unit({
      ...strong,
      settings: { max_output_tokens: 100 },
    });
    const shortCheap = unit({
      ...cheap,
      settings: { max_output_tokens: 100 },
    });
    const baseline = unit({
      routed_unit_id: 'route.baseline',
      destination: 'hosted.cheap',
      quality: 'baseline',
      price: { input_per_mtok: 1, output_per_mtok: 1 },
      settings: { max_output_tokens: 100 },
    });
    const decision = route(
      [baseline, shortStrong, shortCheap],
      { operation: 'generate', kind: 'transform' },
      short,
      20,
    );
    assert.equal(priceAttempt(shortCheap, short).cost, 4_800);
    assert.equal(priceAttempt(shortStrong, short).cost, 8_000);
    assert.equal(priceAttempt(shortStrong, short).cache_applied, false);
    const digestMiss = terms({
      max_context_tokens: 1_100,
      prefix_digest: SHORT_DIGEST,
      prefix_cache: { routed_unit_id: 'route.strong', prefix_digest: LONG_DIGEST, cached_tokens: 1_000 },
    });
    const isolated = route(
      [shortStrong, shortCheap],
      { operation: 'generate', kind: 'transform' },
      digestMiss,
      20,
    );
    assert.deepEqual(
      isolated.order.map((item) => item.routed_unit_id),
      ['route.cheap', 'route.strong'],
    );
    assert.equal(priceAttempt(shortStrong, digestMiss).cost, 8_000);
    assert.deepEqual(
      decision.order.map((item) => item.routed_unit_id),
      ['route.cheap', 'route.strong'],
    );
    assert.deepEqual(
      decision.excluded.find((item) => item.routed_unit_id === 'route.baseline'),
      { routed_unit_id: 'route.baseline', reason: 'quality_below_bar' },
    );
  });

  it('M6-T03 no prefix cache record prices the cold window', () => {
    const cold = terms();
    const decision = route([strong, cheap], { operation: 'generate', kind: 'transform' }, cold, 20);
    assert.deepEqual(
      decision.order.map((item) => item.routed_unit_id),
      ['route.cheap', 'route.strong'],
    );
    assert.equal(worstCaseCost(cheap, cold), 4_110_000);
    assert.equal(worstCaseCost(strong, cold), 6_850_000);
  });

  it('ignores a prefix cache whose cached tokens exceed the input', () => {
    const oversized = terms({
      prefix_digest: LONG_DIGEST,
      prefix_cache: { ...CACHE, cached_tokens: 800_000 },
    });
    const decision = route([strong, cheap], { operation: 'generate', kind: 'transform' }, oversized, 20);
    assert.deepEqual(
      decision.order.map((item) => item.routed_unit_id),
      ['route.cheap', 'route.strong'],
    );
    assert.match(decision.uncertainty.join('\n'), /prefix cache ignored for route.strong/);
    assert.equal(worstCaseCost(strong, oversized), 6_850_000);
  });

  it('M6-T04 a warm hit with no usage report stays at the cold ceiling', async () => {
    const warm = terms({ prefix_digest: LONG_DIGEST, prefix_cache: CACHE, cost_ceiling: 6_850_000 });
    const strongAdapter = scripted('route.strong', unreported());
    const gateway = createInferenceGateway({
      routes: [
        { ...cheap, adapter: 'route.cheap' },
        { ...strong, adapter: 'route.strong' },
      ],
      adapters: [strongAdapter, scripted('route.cheap', unreported())],
      clock: fakeClock(),
    });
    const outcome = await gateway.generate(request(warm));
    assert.equal(outcome.status, 'accepted');
    if (outcome.status === 'accepted') {
      assert.equal(outcome.routed_unit_id, 'route.strong');
      assert.equal(outcome.spent, 6_850_000);
      assert.equal(outcome.attempts[0]?.cost, 6_850_000);
      assert.equal(outcome.attempts[0]?.cost_is_upper_bound, true);
    }
  });
});
