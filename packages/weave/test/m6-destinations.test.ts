/**
 * M6 destinations follow the read set (docs/m6-route-a-reconstructed-view.md §4).
 *
 * Narrowing happens before inference.requested. A weight cannot put a
 * destination back or take a permitted one away.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInferenceGateway, type GenerationAdapter, type GenerationProviderResult, type RoutedUnit } from '@weave/gateway';
import {
  Runtime,
  type DecisionLayer,
  type Goal,
  type InferenceRecordedPayload,
  type InferenceRequestedPayload,
  type WeighRequest,
  type WeightEntry,
} from '@weave/weave';
import { ALPHA, BETA, baseGoal, goalOpened, registered, scenario, tick } from './fixture.js';

function completed(): GenerationProviderResult {
  return {
    status: 'completed',
    text: '{"bindings":[]}',
    usage: { input_tokens: 1_100, output_tokens: 100 },
    finish_reason: 'stop',
    provider_response_id: 'resp_m6',
  };
}

function adapter(id: string): GenerationAdapter & { calls: number } {
  let calls = 0;
  return {
    id,
    get calls() {
      return calls;
    },
    async execute() {
      calls += 1;
      return completed();
    },
  };
}

function route(id: string, destination: string): RoutedUnit {
  return {
    operation: 'generate',
    kind: 'transform',
    routed_unit_id: id,
    context_profile: 'profile.frame',
    context_profile_version: 1,
    prompt_template: 'template.frame',
    prompt_template_version: 1,
    adapter: id,
    model: id,
    settings: { max_output_tokens: 100 },
    destination,
    quality: 'high',
    context_limit_tokens: 8_000,
    price:
      id === 'route.cheap'
        ? { input_per_mtok: 3_000_000, output_per_mtok: 15_000_000 }
        : { input_per_mtok: 5_000_000, output_per_mtok: 25_000_000 },
    evidence: { attempts: 20, accepted: 20 },
  };
}

const lowWeight: DecisionLayer = {
  implementation: 'low-weight@1',
  weigh(request: WeighRequest): WeightEntry[] {
    return request.candidates.map((candidate) => ({ candidate_id: candidate.candidate_id, weight: 0.01 }));
  },
};

function goal(source: string): Goal {
  return baseGoal({
    goal_id: `g-${source}`,
    framing: true,
    sources: [source],
    authority: { read: [source] },
    destinations: ['local', 'hosted.cheap'],
    budget: { actions: 4, judgments: 4, cost: 100_000 },
  });
}

async function frame(source: string): Promise<{ requested: InferenceRequestedPayload; recorded: InferenceRecordedPayload }> {
  const strong = adapter('route.strong');
  const cheap = adapter('route.cheap');
  let now = 1;
  const gateway = createInferenceGateway({
    routes: [route('route.cheap', 'hosted.cheap'), route('route.strong', 'local')],
    adapters: [strong, cheap],
    clock: { now: () => now++ },
  });
  const world = scenario({ open: false, decisionLayer: lowWeight });
  const runtime = new Runtime({
    host: world.host,
    decisionLayer: lowWeight,
    gateway,
    framingTerms: { quality: 'high', max_context_tokens: 1_100, cost_ceiling: 20_000 },
    prefixCache: { routed_unit_id: 'route.strong', prefix_digest: 'digest-long', cached_tokens: 1_000 },
  });
  const content = source === BETA ? 'beta one' : 'alpha one';
  runtime.observe({
    observation_id: `test:source.registered:${source}`,
    source: { kind: 'test', id: 'm6' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource: source, revision: 1, content },
  });
  runtime.operator.submit({
    observation_id: `operator:destination.policy:${source}`,
    caused_by: null,
    payload_type: 'destination.policy',
    payload_version: 1,
    payload: { resource: BETA, destinations: ['local'] },
  });
  runtime.operator.submit(goalOpened(goal(source)));
  runtime.clock.submit(tick(1));
  const frameAction = Object.values(runtime.state().actions).find((action) => action.operation === 'goal.frame');
  assert.ok(frameAction);
  await runtime.settle(frameAction.action_id);
  const requested = runtime
    .trace()
    .observations.find((observation) => observation.payload_type === 'inference.requested');
  const recorded = runtime
    .trace()
    .observations.find((observation) => observation.payload_type === 'inference.recorded');
  assert.ok(requested);
  assert.ok(recorded);
  return {
    requested: requested.payload as InferenceRequestedPayload,
    recorded: recorded.payload as InferenceRecordedPayload,
  };
}

describe('M6 destinations', () => {
  it('M6-T06 narrows a beta read to local and leaves an alpha read open', async () => {
    const beta = await frame(BETA);
    assert.deepEqual(beta.requested.terms.destinations, ['local']);
    assert.equal(beta.recorded.attempts[0]?.routed_unit_id, 'route.strong');
    const weights = beta.requested;
    assert.ok(weights);
    assert.equal(beta.requested.terms.destinations.includes('hosted.cheap'), false);

    const alpha = await frame(ALPHA);
    assert.deepEqual(alpha.requested.terms.destinations, ['local', 'hosted.cheap']);
    assert.equal(alpha.recorded.attempts[0]?.routed_unit_id, 'route.cheap');
  });

  it('keeps the goal destinations when the read set is empty', async () => {
    const strong = adapter('route.strong');
    const cheap = adapter('route.cheap');
    let now = 1;
    const gateway = createInferenceGateway({
      routes: [route('route.cheap', 'hosted.cheap'), route('route.strong', 'local')],
      adapters: [strong, cheap],
      clock: { now: () => now++ },
    });
    const world = scenario({ open: false, decisionLayer: lowWeight });
    const runtime = new Runtime({
      host: world.host,
      decisionLayer: lowWeight,
      gateway,
      framingTerms: { quality: 'high', max_context_tokens: 1_100, cost_ceiling: 20_000 },
    });
    runtime.operator.submit(
      goalOpened(
        baseGoal({
          framing: true,
          sources: [ALPHA],
          authority: { read: [ALPHA] },
          destinations: ['hosted.cheap'],
          budget: { actions: 4, judgments: 4, cost: 100_000 },
        }),
      ),
    );
    const frameAction = Object.values(runtime.state().actions).find((action) => action.operation === 'goal.frame');
    assert.ok(frameAction);
    assert.deepEqual(frameAction.read_set, []);
    await runtime.settle(frameAction.action_id);
    const requested = runtime
      .trace()
      .observations.find((observation) => observation.payload_type === 'inference.requested');
    assert.ok(requested);
    assert.deepEqual((requested.payload as InferenceRequestedPayload).terms.destinations, ['hosted.cheap']);
  });
});
