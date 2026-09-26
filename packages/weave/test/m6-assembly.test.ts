/**
 * M6 shared slice assembly and replay (docs/m6-route-a-reconstructed-view.md §5–§6).
 *
 * Two read-only views of one revision cite one assembly. The review cannot
 * promote a profile or issue a grant, and replay does not compact the log.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost } from '@weave/agentfabric';
import { createInferenceGateway, type GenerationAdapter, type RoutedUnit } from '@weave/gateway';
import {
  Runtime,
  ScriptedDecisionLayer,
  replay,
  type FrameProfile,
  type Goal,
  type InferenceRequestedPayload,
  type StateView,
} from '@weave/weave';
import { FailingDecisionLayer } from './fixture.js';

const INDEX_PROFILE: FrameProfile = {
  id: 'profile.frame.index@1',
  version: 1,
  catalogue_budget: 32,
  schema_for: ['source.inspect', 'text.normalize'],
};

function adapter(id: string): GenerationAdapter & { calls: number } {
  let calls = 0;
  return {
    id,
    get calls() {
      return calls;
    },
    async execute() {
      calls += 1;
      return {
        status: 'completed' as const,
        text: '{"bindings":[]}',
        usage: { input_tokens: 1_100, output_tokens: 100 },
        finish_reason: 'stop',
        provider_response_id: 'resp_review',
      };
    },
  };
}

function unit(id: string, destination: string): RoutedUnit {
  return {
    operation: 'generate',
    kind: 'transform',
    routed_unit_id: id,
    context_profile: 'profile.frame.index@1',
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
      destination === 'local'
        ? { input_per_mtok: 5_000_000, output_per_mtok: 25_000_000 }
        : { input_per_mtok: 3_000_000, output_per_mtok: 15_000_000 },
    evidence: { attempts: 20, accepted: 20 },
  };
}

function assemblyId(view: StateView, sliceName: string): string | undefined {
  return view.manifest.slices.find((slice) => slice.name === sliceName)?.assembly_id;
}

describe('M6 slice assembly', () => {
  it('cites the cycle-start assembly when the review waits for a slot', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const alpha = host.registerSource('mem:alpha', 'alpha one');
    const beta = host.registerSource('mem:beta', 'beta one');
    const strong = adapter('route.strong');
    let now = 1;
    const gateway = createInferenceGateway({
      routes: [unit('route.strong', 'local')],
      adapters: [strong],
      clock: { now: () => now++ },
    });
    const runtime = new Runtime({
      host,
      decisionLayer: new ScriptedDecisionLayer(),
      grantAuthority: authority,
      gateway,
      frameProfile: INDEX_PROFILE,
      shareAssemblies: true,
      executionSlots: 1,
      framingTerms: { quality: 'high', max_context_tokens: 1_100, cost_ceiling: 20_000 },
      prefixCache: { routed_unit_id: 'route.strong', prefix_digest: 'digest-long', cached_tokens: 650_000 },
    });
    for (const resource of [alpha, beta]) {
      runtime.observe({
        observation_id: `test:source.registered:${resource}`,
        source: { kind: 'test', id: 'm6' },
        caused_by: null,
        payload_type: 'source.registered',
        payload_version: 1,
        payload: { resource, revision: 1, content: 'alpha one' },
      });
    }
    runtime.operator.submit({
      observation_id: 'operator:goal.opened:g-slot',
      caused_by: null,
      payload_type: 'goal.opened',
      payload_version: 1,
      payload: {
        goal_id: 'g-slot',
        purpose: 'Review the normalized report',
        sources: [alpha, beta],
        authority: { read: [alpha, beta] },
        framing: true,
        review: true,
        destinations: ['local'],
        budget: { actions: 2, judgments: 4, cost: 100_000 },
        success_evidence: 'a checked report',
      } satisfies Goal,
    });
    const review = Object.values(runtime.state().actions).find((action) => action.operation === 'report.review');
    const frame = Object.values(runtime.state().actions).find((action) => action.operation === 'goal.frame');
    assert.ok(review);
    assert.ok(frame);
    assert.equal(review.state, 'pending');
    assert.equal(frame.state, 'running');
    await runtime.settle(frame.action_id);
    assert.equal(runtime.state().actions[review.action_id]?.state, 'running');
    runtime.finishReview(review.action_id);
    const requested = runtime
      .trace()
      .observations.find((observation) => observation.payload_type === 'inference.requested');
    const reviewResult = runtime.trace().observations.find(
      (observation) =>
        observation.payload_type === 'action.result' &&
        (observation.payload as { action_id: string }).action_id === review.action_id,
    );
    assert.ok(requested);
    assert.ok(reviewResult);
    const frameView = (requested.payload as InferenceRequestedPayload).view;
    const reviewOutput = (reviewResult.payload as { outcome: { output: { view: StateView } } }).outcome.output;
    assert.equal(assemblyId(frameView, 'goal'), assemblyId(reviewOutput.view, 'goal'));
    assert.equal(assemblyId(frameView, 'registered'), assemblyId(reviewOutput.view, 'registered'));
  });

  it('M6-T07 shares one assembly and M6-T08 replays the routed run', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const alpha = host.registerSource('mem:alpha', 'alpha one');
    const beta = host.registerSource('mem:beta', 'beta one');
    const strong = adapter('route.strong');
    const cheap = adapter('route.cheap');
    let now = 1;
    const gateway = createInferenceGateway({
      routes: [unit('route.cheap', 'hosted.cheap'), unit('route.strong', 'local')],
      adapters: [cheap, strong],
      clock: { now: () => now++ },
    });
    const runtime = new Runtime({
      host,
      decisionLayer: new ScriptedDecisionLayer(),
      grantAuthority: authority,
      gateway,
      frameProfile: INDEX_PROFILE,
      shareAssemblies: true,
      framingTerms: { quality: 'high', max_context_tokens: 1_100, cost_ceiling: 20_000 },
      prefixCache: { routed_unit_id: 'route.strong', prefix_digest: 'digest-long', cached_tokens: 650_000 },
    });
    runtime.observe({
      observation_id: `test:source.registered:${alpha}`,
      source: { kind: 'test', id: 'm6' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: alpha, revision: 1, content: 'alpha one' },
    });
    runtime.observe({
      observation_id: `test:source.registered:${beta}`,
      source: { kind: 'test', id: 'm6' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: beta, revision: 1, content: 'beta one' },
    });
    const goal: Goal = {
      goal_id: 'g-review',
      purpose: 'Review the normalized report',
      sources: [alpha, beta],
      authority: { read: [alpha, beta] },
      framing: true,
      review: true,
      destinations: ['local', 'hosted.cheap'],
      budget: { actions: 8, judgments: 4, cost: 100_000 },
      success_evidence: 'a checked report',
    };
    runtime.operator.submit({
      observation_id: 'operator:goal.opened:g-review',
      caused_by: null,
      payload_type: 'goal.opened',
      payload_version: 1,
      payload: goal,
    });

    const review = Object.values(runtime.state().actions).find((action) => action.operation === 'report.review');
    const frame = Object.values(runtime.state().actions).find((action) => action.operation === 'goal.frame');
    assert.ok(review);
    assert.ok(frame);
    assert.equal(review.grant, null);
    const write = host.tryWriteSource(beta, 'beta changed');
    assert.equal(write.ok, false);
    if (!write.ok) {
      assert.equal(write.reason, 'conflict');
    }

    await runtime.settle(frame.action_id);
    runtime.finishReview(review.action_id);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const running = Object.values(runtime.state().actions).filter((action) => action.state === 'running' && action.operation === 'goal.frame');
      if (running.length === 0) {
        break;
      }
      for (const action of running) {
        await runtime.settle(action.action_id);
      }
    }

    const requested = runtime
      .trace()
      .observations.filter((observation) => observation.payload_type === 'inference.requested')
      .map((observation) => observation.payload as InferenceRequestedPayload);
    const frameView = requested.find((payload) => payload.site === 'goal.frame')?.view;
    const reviewResult = runtime
      .trace()
      .observations.find(
        (observation) =>
          observation.payload_type === 'action.result' &&
          (observation.payload as { action_id: string }).action_id === review.action_id,
      );
    assert.ok(frameView);
    assert.ok(reviewResult);
    const reviewOutput = (reviewResult.payload as { outcome: { output: { view: StateView; profile: string; grant: { grant_id: string } } } }).outcome.output;
    assert.equal(assemblyId(frameView, 'goal'), assemblyId(reviewOutput.view, 'goal'));
    assert.equal(assemblyId(frameView, 'registered'), assemblyId(reviewOutput.view, 'registered'));
    assert.notEqual(assemblyId(frameView, 'catalogue_schema'), assemblyId(frameView, 'goal'));
    const cycle = runtime.trace().cycles.find((item) => item.selected.some((selected) => selected.action_id === review.action_id));
    assert.equal(cycle?.cost_micros, 1_000);
    const shared = assemblyId(frameView, 'goal');
    assert.equal(
      requested.filter((payload) => assemblyId(payload.view, 'goal') === shared).length,
      1,
    );
    assert.equal(runtime.state().strategy.profile_id, 'profile.frame@1');
    assert.equal(reviewOutput.profile, 'profile.frame.narrow@1');
    assert.equal(reviewOutput.grant.grant_id, 'forged');
    assert.equal(runtime.state().actions[review.action_id]?.grant, null);
    assert.equal(runtime.trace().observations.filter((observation) => observation.payload_type === 'goal.opened').length, 1);

    const callsBefore = strong.calls + cheap.calls;
    const replayHost = new AgentFabricHost({ authority: createGrantAuthority() });
    let replayCalls = 0;
    const replayGateway = createInferenceGateway({
      routes: [unit('route.strong', 'local')],
      adapters: [
        {
          id: 'route.strong',
          async execute() {
            replayCalls += 1;
            throw new Error('gateway must not be invoked');
          },
        },
      ],
      clock: { now: () => 1 },
    });
    const recorded = runtime.trace().observations;
    const result = replay(recorded, {
      host: replayHost,
      decisionLayer: new FailingDecisionLayer(),
      gateway: replayGateway,
      frameProfile: INDEX_PROFILE,
      shareAssemblies: true,
      framingTerms: { quality: 'high', max_context_tokens: 1_100, cost_ceiling: 20_000 },
      prefixCache: { routed_unit_id: 'route.strong', prefix_digest: 'digest-long', cached_tokens: 650_000 },
    });
    assert.equal(result.ok, true, result.ok ? '' : result.failure.reason);
    if (result.ok) {
      assert.equal(result.trace.observations.length, recorded.length);
      assert.equal(JSON.stringify(result.trace.observations), JSON.stringify(recorded));
    }
    assert.equal(replayCalls, 0);
    assert.equal(strong.calls + cheap.calls, callsBefore);
    assert.ok(recorded.some((observation) => observation.payload_type === 'inference.recorded'));
  });
});
