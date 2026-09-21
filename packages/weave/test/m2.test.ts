/**
 * M2 — handle a novel request. Trace assertions M2-T01..T11 from
 * docs/m2-handle-a-novel-request.md §7.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority, type CapabilityContract } from '@weave/agentsop';
import { AgentFabricHost } from '@weave/agentfabric';
import {
  HOSTED_DESTINATION,
  LOCAL_DESTINATION,
  replay,
  traceCompletenessViolations,
  type InferenceRecordedPayload,
  type InferenceRequestedPayload,
  type Proposal,
  type StateView,
  type WeightsRecordedPayload,
} from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import {
  actionIdFor,
  candidatesFor,
  FailingDecisionLayer,
  inspectCandidate,
  lastCycle,
  observationsOfType,
  release,
} from './fixture.js';
import {
  ALPHA,
  BETA,
  bindingJson,
  completedText,
  deferredEvaluate,
  evaluateAdapter,
  failedEval,
  generateAdapter,
  GAMMA,
  malformedEval,
  novelScenario,
  scoreAnswers,
  variantGoal,
} from './m2-fixture.js';

async function flush(times = 15): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function frameThenInspect(s: ReturnType<typeof novelScenario>): Promise<void> {
  const c1 = lastCycle(s);
  const frame = candidatesFor(c1, 'goal.frame')[0];
  assert.ok(frame);
  await s.runtime.settle(actionIdFor(c1, frame.candidate_id));
}

describe('M2 novel request', () => {
  it('M2-T01 novel goal frames then reports', async () => {
    const s = novelScenario();
    const c1 = lastCycle(s);
    assert.equal(c1.procedure, 'frame_and_report@1');
    assert.equal(candidatesFor(c1, 'goal.frame').length, 1);
    assert.equal(candidatesFor(c1, 'source.inspect').length, 0);
    await frameThenInspect(s);
    const proposal = s.runtime.state().proposal?.proposal;
    assert.ok(proposal);
    assert.equal(proposal.bindings.length, 2);
    const inspectCycle = lastCycle(s);
    assert.ok(inspectCandidate(inspectCycle, ALPHA));
    assert.ok(inspectCandidate(inspectCycle, BETA));
    await release(s, actionIdFor(inspectCycle, inspectCandidate(inspectCycle, ALPHA)!.candidate_id));
    await release(s, actionIdFor(inspectCycle, inspectCandidate(inspectCycle, BETA)!.candidate_id));
    const assembleCycle = lastCycle(s);
    const assemble = candidatesFor(assembleCycle, 'report.assemble')[0];
    assert.ok(assemble);
    await release(s, actionIdFor(assembleCycle, assemble.candidate_id));
    assert.equal(s.runtime.state().goal?.status, 'complete');
    assert.deepEqual(lastCycle(s).outcome, { status: 'complete' });
    assert.deepEqual(traceCompletenessViolations(s.runtime.trace()), []);
  });

  it('M2-T02 unauthorized and unknown bindings are rejected', async () => {
    const text = JSON.stringify({
      bindings: [
        { operation: 'source.inspect', inputs: { source: ALPHA } },
        { operation: 'source.inspect', inputs: { source: BETA } },
        { operation: 'source.inspect', inputs: { source: GAMMA } },
        { operation: 'source.invent', inputs: { source: ALPHA } },
      ],
    });
    const s = novelScenario({ generate: generateAdapter('fixture.generate', [completedText(text)]) });
    await frameThenInspect(s);
    const proposal = s.runtime.state().proposal?.proposal as Proposal;
    assert.ok(proposal.rejected.some((r) => r.reason.includes('source:gamma')));
    assert.ok(proposal.rejected.some((r) => r.reason === 'unknown_operation'));
    const inspects = lastCycle(s).candidates.filter((c) => c.operation === 'source.inspect');
    assert.equal(inspects.length, 2);
    assert.ok(inspects.every((c) => c.eligibility.status === 'allowed'));
    const started = observationsOfType(s.runtime.trace(), 'action.started');
    assert.ok(
      started.every((o) => {
        const payload = o.payload as { operation: string; inputs: { source?: string } };
        return payload.operation !== 'source.inspect' || payload.inputs.source !== GAMMA;
      }),
    );
  });

  it('M2-T03 scripted and gateway weighing share ordinal dispatch', async () => {
    const scripted = novelScenario();
    await frameThenInspect(scripted);
    const scriptedInspect = lastCycle(scripted);
    const scriptedOrder = scriptedInspect.selected.map((s) => s.candidate_id);

    const evaluate = evaluateAdapter('fixture.evaluate', (call) => {
      const scores: Record<string, number> = {};
      for (const id of Object.keys(call.questions)) {
        scores[id] = 1.6;
      }
      return scoreAnswers(scores);
    });
    const gatewayRun = novelScenario({ evaluate });
    await frameThenInspect(gatewayRun);
    await flush();
    const weigh = observationsOfType(gatewayRun.runtime.trace(), 'weights.recorded').find(
      (o) => (o.payload as WeightsRecordedPayload).implementation !== 'scripted@1',
    );
    assert.ok(weigh);
    assert.notEqual((weigh.payload as WeightsRecordedPayload).implementation, 'scripted@1');
    const gatewayInspect = lastCycle(gatewayRun);
    assert.deepEqual(
      gatewayInspect.selected.map((s) => s.candidate_id),
      scriptedOrder,
    );
    assert.deepEqual(
      gatewayInspect.selected.map((s) => {
        const candidate = gatewayInspect.candidates.find((c) => c.candidate_id === s.candidate_id);
        return candidate?.operation;
      }),
      scriptedInspect.selected.map((s) => {
        const candidate = scriptedInspect.candidates.find((c) => c.candidate_id === s.candidate_id);
        return candidate?.operation;
      }),
    );
  });

  it('M2-T04 framing view discloses omissions and truncation', async () => {
    const s = novelScenario();
    await frameThenInspect(s);
    const requested = observationsOfType(s.runtime.trace(), 'inference.requested')[0];
    assert.ok(requested);
    const payload = requested.payload as InferenceRequestedPayload;
    assert.equal(payload.view.profile, 'profile.frame@1');
    const view = payload.view as StateView;
    const encoded = JSON.stringify(view.content);
    assert.equal(encoded.includes('gamma one'), false);
    const authority = view.manifest.slices.find((slice) => slice.name === 'authority');
    assert.ok(authority?.omitted.some((item) => item.name === GAMMA && item.reason === 'authority'));
    const catalogue = view.manifest.slices.find((slice) => slice.name === 'catalogue');
    assert.equal(catalogue?.truncated, true);
    assert.ok(catalogue?.omitted.some((item) => item.reason === 'budget'));
    assert.ok(view.manifest.slices.some((slice) => slice.revisions.length > 0));
  });

  it('M2-T05 hosted routes are excluded unless permitted', async () => {
    const hostedCalls = { n: 0 };
    const hosted = evaluateAdapter('fixture.hosted', () => {
      hostedCalls.n += 1;
      return scoreAnswers({});
    });
    const local = evaluateAdapter('fixture.evaluate', (call) => {
      const scores: Record<string, number> = {};
      for (const id of Object.keys(call.questions)) {
        scores[id] = 1.6;
      }
      return scoreAnswers(scores);
    });
    const permitted = novelScenario({ evaluate: local, includeHosted: true, hosted, destinations: [LOCAL_DESTINATION] });
    await frameThenInspect(permitted);
    await flush();
    const recorded = observationsOfType(permitted.runtime.trace(), 'inference.recorded').filter(
      (o) =>
        permitted.runtime.state().inferences[(o.payload as InferenceRecordedPayload).request_id]?.request.site ===
        'frontier.weigh',
    );
    const weighRecord = recorded.at(-1)?.payload as InferenceRecordedPayload;
    assert.ok(weighRecord);
    assert.ok(weighRecord.attempts.every((a) => a.routed_unit_id !== 'weigh.hosted'));
    assert.equal(hostedCalls.n, 0);

    const none = novelScenario({
      evaluate: local,
      includeHosted: true,
      hosted,
      destinations: ['nowhere'],
    });
    await frameThenInspect(none);
    await flush();
    const blocked = observationsOfType(none.runtime.trace(), 'inference.recorded')
      .map((o) => o.payload as InferenceRecordedPayload)
      .find((p) => p.status === 'blocked');
    assert.ok(blocked);
    assert.equal(blocked.reason, 'no_route');
    assert.equal(blocked.attempts.length, 0);
  });

  it('M2-T06 malformed and failed attempts are reserved then spent', async () => {
    const evaluate = evaluateAdapter('fixture.evaluate', [
      { status: 'failed', failure: { code: 'malformed_response', message: 'bad json', retryable: true } },
      failedEval(),
    ]);
    const s = novelScenario({ evaluate });
    await frameThenInspect(s);
    await flush();
    const requested = observationsOfType(s.runtime.trace(), 'inference.requested').filter(
      (o) => (o.payload as InferenceRequestedPayload).site === 'frontier.weigh',
    );
    const recorded = observationsOfType(s.runtime.trace(), 'inference.recorded')
      .map((o) => o.payload as InferenceRecordedPayload)
      .find((p) => p.attempts.length >= 2);
    assert.ok(requested[0]);
    assert.ok(recorded);
    assert.ok(requested[0]!.seq < observationsOfType(s.runtime.trace(), 'inference.recorded').find((o) => (o.payload as InferenceRecordedPayload).request_id === recorded.request_id)!.seq);
    assert.ok(recorded.spent > 0);
    assert.equal(recorded.attempts.length >= 2, true);
    assert.equal(s.runtime.state().budget.judgments.spent >= 1, true);
    const acceptedWeights = observationsOfType(s.runtime.trace(), 'weights.recorded').filter((o) => o.validation.status === 'accepted' && (o.payload as WeightsRecordedPayload).request_id);
    assert.equal(acceptedWeights.length, 0);
  });

  it('M2-T07 slow weighing does not block control', async () => {
    const held = deferredEvaluate('fixture.evaluate', scoreAnswers({}));
    const s = novelScenario({ evaluate: held });
    await frameThenInspect(s);
    await flush();
    const before = s.runtime.trace().observations.length;
    const waiting = lastCycle(s);
    assert.deepEqual(waiting.outcome, { status: 'waiting' });
    s.runtime.clock.submit({
      observation_id: 'clock:tick:1',
      caused_by: null,
      payload_type: 'clock.tick',
      payload_version: 1,
      payload: { tick: 1 },
    });
    assert.ok(s.runtime.trace().observations.length > before);
    assert.deepEqual(lastCycle(s).outcome, { status: 'waiting' });
    assert.equal(held.calls, 1);
  });

  it('M2-T08 a late judgment cannot authorize dispatch', async () => {
    const held = deferredEvaluate('fixture.evaluate', scoreAnswers({}));
    const s = novelScenario({ evaluate: held });
    await frameThenInspect(s);
    await flush();
    s.runtime.clock.submit({
      observation_id: 'clock:tick:2',
      caused_by: null,
      payload_type: 'clock.tick',
      payload_version: 1,
      payload: { tick: 2 },
    });
    held.release();
    await Promise.resolve();
    await Promise.resolve();
    const weights = observationsOfType(s.runtime.trace(), 'weights.recorded');
    assert.ok(weights.some((o) => o.validation.status === 'rejected'));
    const recorded = observationsOfType(s.runtime.trace(), 'inference.recorded')
      .map((o) => o.payload as InferenceRecordedPayload)
      .find((p) => s.runtime.state().inferences[p.request_id]?.request.site === 'frontier.weigh');
    assert.ok(recorded);
    assert.equal(s.runtime.state().inferences[recorded.request_id]?.recorded?.status, 'accepted');
    assert.ok(s.runtime.state().budget.judgments.spent >= 1);
    const inspectStarts = observationsOfType(s.runtime.trace(), 'action.started').filter(
      (o) => (o.payload as { operation: string }).operation === 'source.inspect',
    );
    assert.equal(inspectStarts.length, 0);
  });

  it('M2-T09 unaccepted weighing does not recurse', async () => {
    const evaluate = evaluateAdapter('fixture.evaluate', [malformedEval()]);
    const s = novelScenario({ evaluate });
    await frameThenInspect(s);
    await flush();
    const weighRequests = observationsOfType(s.runtime.trace(), 'inference.requested').filter(
      (o) => (o.payload as InferenceRequestedPayload).site === 'frontier.weigh',
    );
    assert.equal(weighRequests.length, 1);
    assert.equal(lastCycle(s).outcome.status, 'blocked');
    assert.equal(s.runtime.state().goal?.status, 'active');
  });

  it('M2-T10 replay does not invoke the gateway', async () => {
    const s = novelScenario();
    await frameThenInspect(s);
    const inspectCycle = lastCycle(s);
    await release(s, actionIdFor(inspectCycle, inspectCandidate(inspectCycle, ALPHA)!.candidate_id));
    await release(s, actionIdFor(inspectCycle, inspectCandidate(inspectCycle, BETA)!.candidate_id));
    const assemble = candidatesFor(lastCycle(s), 'report.assemble')[0];
    assert.ok(assemble);
    await release(s, actionIdFor(lastCycle(s), assemble.candidate_id));
    const host = new FakeHost(new FixtureEnvironment());
    const result = replay(s.runtime.trace().observations, {
      host,
      decisionLayer: new FailingDecisionLayer(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(host.invocations.length, 0);
    assert.equal(JSON.stringify(result.trace.cycles), JSON.stringify(s.runtime.trace().cycles));
  });
});

describe('M2 resolver inference port', () => {
  it('M2-T11 contract inference limits are enforced', async () => {
    const authority = createGrantAuthority();
    const generate = generateAdapter('fixture.generate', [completedText('ok')]);
    const gateway = (await import('./m2-fixture.js')).createInferenceGateway({
      clock: { now: () => 0 },
      routes: [
        {
          routed_unit_id: 'probe.local',
          operation: 'generate',
          kind: 'transform',
          context_profile: 'profile.frame@1',
          context_profile_version: 1,
          prompt_template: 't',
          prompt_template_version: 1,
          adapter: generate.id,
          model: 'fixture/framer',
          settings: { max_output_tokens: 32 },
          destination: LOCAL_DESTINATION,
          quality: 'baseline',
          context_limit_tokens: 8_000,
          price: { input_per_mtok: 1, output_per_mtok: 1 },
        },
      ],
      adapters: [generate],
    });
    const contract: CapabilityContract = {
      id: 'probe.infer',
      revision: 'r1',
      purpose: 'Probe bounded inference',
      input: { prompt: 'string' },
      output: { text: 'string' },
      effects: [],
      permissions: [],
      failures: [],
      depends_on: [],
      inference: {
        kind: 'transform',
        role: 'working',
        max_cost: 100,
        destinations: [LOCAL_DESTINATION],
        max_attempts: 2,
      },
    };
    const host = new AgentFabricHost({ authority, contracts: [contract], gateway });
    const ctx = host.resolverContext(contract);
    assert.equal(typeof ctx.infer, 'function');
    const ok = await ctx.infer!({
      kind: 'transform',
      role: 'working',
      input: { prompt: 'hello' },
      terms: { cost_ceiling: 50, destinations: [LOCAL_DESTINATION], max_attempts: 1 },
    });
    assert.equal(ok.status, 'accepted');
    assert.equal(generate.calls, 1);

    const overCost = await ctx.infer!({
      kind: 'transform',
      role: 'working',
      input: { prompt: 'hello' },
      terms: { cost_ceiling: 5_000, destinations: [LOCAL_DESTINATION], max_attempts: 1 },
    });
    assert.equal(overCost.status, 'refused');

    const badDest = await ctx.infer!({
      kind: 'transform',
      role: 'working',
      input: { prompt: 'hello' },
      terms: { cost_ceiling: 50, destinations: [HOSTED_DESTINATION], max_attempts: 1 },
    });
    assert.equal(badDest.status, 'refused');

    const badKind = await ctx.infer!({
      kind: 'judge',
      role: 'working',
      input: { prompt: 'hello' },
      terms: { cost_ceiling: 50, destinations: [LOCAL_DESTINATION], max_attempts: 1 },
    });
    assert.equal(badKind.status, 'refused');

    const badRole = await ctx.infer!({
      kind: 'transform',
      role: 'framing',
      input: { prompt: 'hello' },
      terms: { cost_ceiling: 50, destinations: [LOCAL_DESTINATION], max_attempts: 1 },
    });
    assert.equal(badRole.status, 'refused');

    const overAttempts = await ctx.infer!({
      kind: 'transform',
      role: 'working',
      input: { prompt: 'hello' },
      terms: { cost_ceiling: 50, destinations: [LOCAL_DESTINATION], max_attempts: 9 },
    });
    assert.equal(overAttempts.status, 'refused');

    const noGateway = new AgentFabricHost({ authority, contracts: [contract] });
    const unavailable = await noGateway.resolverContext(contract).infer!({
      kind: 'transform',
      role: 'working',
      input: { prompt: 'hello' },
      terms: { cost_ceiling: 50, destinations: [LOCAL_DESTINATION], max_attempts: 1 },
    });
    assert.equal(unavailable.status, 'refused');
    if (unavailable.status === 'refused') {
      assert.equal(unavailable.code, 'RESOLVER_UNAVAILABLE');
    }
  });
});
