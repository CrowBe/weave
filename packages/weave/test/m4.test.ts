/**
 * M4 — measure reuse (docs/m4-measure-reuse.md).
 * Checks are written against that contract. M0–M3 tests stay in their files.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, TEXT_NORMALIZE, selectAdmittedImplementation } from '@weave/agentfabric';
import {
  FRAME_PROFILE,
  HOST_INVOCATION_MICROS,
  PROCEDURE_IDS,
  replay,
  renderFrameView,
  renderWeighView,
  reuseVerdict,
  type ActionResultPayload,
  type ActionStartedPayload,
  type BaselineRecord,
  type CachedConclusion,
  type InferenceRequestedPayload,
} from '@weave/weave';
import { FailingDecisionLayer } from './fixture.js';
import { drain, m4World, normalizeOutcome, normalizedGoal, openGoal, tick, type M4World } from './m4-fixture.js';

function started(world: M4World, operation: string): ActionStartedPayload[] {
  return world.runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'action.started' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as ActionStartedPayload)
    .filter((payload) => payload.operation === operation);
}

function normalizeResults(world: M4World): { source: string; payload: ActionResultPayload }[] {
  const ids = new Map(started(world, 'text.normalize').map((payload) => [payload.action_id, payload]));
  return world.runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'action.result' && observation.validation.status === 'accepted')
    .filter((observation) => ids.has((observation.payload as ActionResultPayload).action_id))
    .map((observation) => ({
      source: observation.source.kind,
      payload: observation.payload as ActionResultPayload,
    }));
}

function conclusions(world: M4World): CachedConclusion[] {
  return world.runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'conclusion.cached' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as CachedConclusion);
}

describe('M4 measure reuse', () => {
  it('M4-T01 repeats the normalized report from the recorded composition', async () => {
    assert.deepEqual([...PROCEDURE_IDS], [
      'inspect_and_report@1',
      'inspect_report_publish@1',
      'frame_and_report@1',
      'crystallize_and_report@1',
    ]);
    const world = m4World();
    openGoal(world, normalizedGoal(world, 'g-report'), '1');
    await drain(world);
    assert.equal(world.runtime.state().goal?.status, 'complete');
    const compositionSeq = world.runtime.trace().observations.find((observation) => observation.payload_type === 'composition.recorded')?.seq;
    assert.equal(typeof compositionSeq, 'number');
    const normalizes = world.runtime.trace().cycles.flatMap((cycle) => cycle.candidates.filter((candidate) => candidate.operation === 'text.normalize'));
    assert.equal(started(world, 'text.normalize').length, 2);
    assert.ok(normalizes.length >= 2);
    for (const candidate of normalizes) {
      assert.ok(candidate.evidence.includes(compositionSeq as number));
    }
    for (const cycle of world.runtime.trace().cycles) {
      assert.ok((PROCEDURE_IDS as readonly string[]).includes(cycle.procedure));
    }
    assert.equal(
      world.runtime.trace().cycles.some((cycle) => cycle.procedure === 'inspect_and_report@1' && cycle.selected.length > 0),
      true,
    );
    const framing = world.runtime
      .trace()
      .observations.filter((observation) => observation.payload_type === 'inference.requested')
      .map((observation) => observation.payload as InferenceRequestedPayload);
    assert.equal(framing.some((payload) => payload.role === 'framing'), false);
    assert.equal(world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length, 2);
  });

  it('M4-T02 reuses a cached conclusion for the same input, read set, and goal', async () => {
    const world = m4World();
    const goal = normalizedGoal(world, 'g-report');
    openGoal(world, goal, '1');
    await drain(world);
    const first = conclusions(world);
    assert.equal(first.length, 2);
    const before = world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length;
    openGoal(world, goal, '2');
    await drain(world);
    assert.equal(world.runtime.state().goal?.status, 'complete');
    assert.equal(world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length, before);
    assert.equal(conclusions(world).length, first.length);
    const reused = normalizeResults(world).filter((result) => result.payload.conclusion_id);
    assert.equal(reused.length, 2);
    for (const result of reused) {
      const conclusion = first.find((item) => item.conclusion_id === result.payload.conclusion_id);
      assert.ok(conclusion);
      assert.deepEqual(result.payload.cited_evidence, conclusion?.evidence);
      assert.equal(result.source, 'runtime');
    }
    const catalogue = world.host.operations().flatMap((id) => {
      const described = world.host.describe(id);
      return described.kind === 'contract' ? [{ id, input: described.contract.input }] : [];
    });
    const plain = renderFrameView(world.runtime.state(), catalogue);
    assert.equal(plain.manifest.slices.some((item) => item.name === 'conclusion'), false);
    assert.equal(JSON.stringify(plain.content).includes('conclusion_id'), false);
    const selected = renderFrameView(world.runtime.state(), catalogue, {
      id: FRAME_PROFILE,
      version: 1,
      catalogue_budget: 32,
      slices: ['conclusion'],
    });
    const conclusionSlices = selected.manifest.slices.filter((item) => item.name === 'conclusion');
    assert.equal(conclusionSlices.length, 1);
    const weigh = renderWeighView(world.runtime.state(), []);
    assert.deepEqual(
      weigh.manifest.slices.map((item) => item.name),
      ['goal', 'candidates'],
    );
  });

  it('M4-T03 does not return a stale conclusion, including a short output', async () => {
    const world = m4World({ alpha: 'a', beta: 'b' });
    const goal = normalizedGoal(world, 'g-short');
    openGoal(world, goal, '1');
    await drain(world);
    const cached = conclusions(world).find((conclusion) => (conclusion.output as { text: string }).text === 'a');
    assert.ok(cached);
    assert.ok((cached.output as { text: string }).text.length < 64);
    const stale = reuseVerdict(
      [cached],
      {
        operation: 'text.normalize',
        contract_rev: 'r1',
        inputs: { text: 'a' },
        read_set: [{ resource: world.alpha, revision: cached.read_set[0]?.revision ?? 1 }],
      },
      { sources: {}, goal_id: 'g-short' },
      [],
      () => true,
    );
    assert.equal(stale.kind, 'uncertain');
    assert.equal('conclusion' in stale, false);
    const revised = reuseVerdict(
      [cached],
      {
        operation: 'text.normalize',
        contract_rev: 'r1',
        inputs: { text: 'a' },
        read_set: [{ resource: world.alpha, revision: 1 }],
      },
      { sources: { [world.alpha]: { revision: 2 } }, goal_id: 'g-short' },
      [],
      () => true,
    );
    assert.equal(revised.kind, 'rerun');
    assert.equal('conclusion' in revised, false);

    const written = world.host.tryWriteSource(world.alpha, 'c');
    assert.equal(written.ok, true);
    if (!written.ok) {
      return;
    }
    world.observe({
      observation_id: `test:source.changed:${world.alpha}:2`,
      source: { kind: 'test', id: 'm4-fixture' },
      caused_by: null,
      payload_type: 'source.changed',
      payload_version: 1,
      payload: { resource: world.alpha, revision: written.revision, content: 'c' },
    });
    const before = world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length;
    openGoal(world, goal, '2');
    await drain(world);
    assert.equal(world.runtime.state().goal?.status, 'complete');
    assert.ok(world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length > before);
    const fresh = normalizeResults(world).filter((result) => !result.payload.conclusion_id);
    const rerun = fresh.find((result) => result.payload.outcome.outcome === 'succeeded' && (result.payload.outcome.output as { text: string }).text === 'c');
    assert.ok(rerun);
    assert.notEqual((rerun.payload.outcome as { output: { text: string } }).output.text, 'a');
    assert.ok(conclusions(world).some((conclusion) => (conclusion.output as { text: string }).text === 'a'));
  });

  it('M4-T04 denies cross-goal reuse unless a policy names both goals', async () => {
    const world = m4World();
    openGoal(world, normalizedGoal(world, 'g-one'), '1');
    await drain(world);
    for (const conclusion of conclusions(world)) {
      world.host.retainConclusion(conclusion);
    }
    assert.ok(world.host.retainedConclusions.length >= 1);
    const afterFirst = world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length;
    openGoal(world, normalizedGoal(world, 'g-two'), '1');
    await drain(world);
    const afterSecond = world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length;
    assert.ok(afterSecond > afterFirst);
    world.runtime.operator.submit({
      observation_id: 'operator:policy:share-one-three',
      caused_by: null,
      payload_type: 'policy.recorded',
      payload_version: 1,
      payload: { policy_id: 'policy.share', goals: ['g-one', 'g-three'] },
    });
    openGoal(world, normalizedGoal(world, 'g-three'), '1');
    await drain(world);
    assert.equal(world.runtime.state().goal?.status, 'complete');
    assert.equal(world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length, afterSecond);
    const reused = normalizeResults(world).filter((result) => result.payload.conclusion_id);
    assert.ok(reused.length >= 2);
  });

  it('M4-T05 admits a second implementation with empty reliability and cost', () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    host.installAdmitted(TEXT_NORMALIZE, normalizeOutcome, 'normalize.a');
    host.recordMeasurement('text.normalize', 'normalize.a', { successes: 0, failures: 9 }, 9_000);
    host.installAdmitted(TEXT_NORMALIZE, normalizeOutcome, 'normalize.b');
    const second = host.implementationRecords('text.normalize').find((record) => record.id === 'normalize.b');
    assert.ok(second);
    assert.equal(second?.reliability, null);
    assert.equal(second?.cost_micros, null);
    host.recordMeasurement('text.normalize', 'normalize.b', { successes: 100, failures: 0 }, 1);
    assert.equal(host.selectedImplementation('text.normalize'), 'normalize.a');
    assert.equal(selectAdmittedImplementation(host.implementationRecords('text.normalize')), 'normalize.a');
    const measured = [...host.implementationRecords('text.normalize')].sort(
      (left, right) => (left.cost_micros ?? Number.MAX_SAFE_INTEGER) - (right.cost_micros ?? Number.MAX_SAFE_INTEGER),
    )[0];
    assert.equal(measured?.id, 'normalize.b');
    assert.notEqual(host.selectedImplementation('text.normalize'), measured?.id);
    const grant = authority.issue({
      action_id: 'a-norm',
      operation: 'text.normalize',
      contract_rev: 'r1',
      permissions: [],
      effects: [],
      issued_at: 1,
    });
    const handle = host.invoke(grant, 'text.normalize', { text: 'a  b' });
    assert.equal(handle.kind, 'handle');
    if (handle.kind !== 'handle') {
      return;
    }
    assert.equal(handle.implementation_id, 'normalize.a');
    assert.equal(host.invocations[0]?.implementation_id, 'normalize.a');
    assert.equal(host.invocations[0]?.operation, 'text.normalize');
  });

  it('M4-T06 records a baseline that includes a failure and does not bill reuse twice', async () => {
    const world = m4World();
    tick(world, 2);
    openGoal(world, normalizedGoal(world, 'g-report'), '1');
    await drain(world);
    openGoal(world, normalizedGoal(world, 'g-report'), '2');
    await drain(world);
    const normalizeHost = world.host.invocations.filter((invocation) => invocation.operation === 'text.normalize');
    assert.equal(normalizeHost.length, 2);
    const actionId = started(world, 'text.normalize')[0]?.action_id;
    assert.ok(actionId);
    world.runtime.operator.submit({
      observation_id: 'operator:output.rejected:1',
      caused_by: null,
      payload_type: 'output.rejected',
      payload_version: 1,
      payload: { goal_id: 'g-report', action_id: actionId, reason: 'normalized form rejected' },
    });
    openGoal(
      world,
      {
        goal_id: 'g-fail',
        purpose: 'Frame a report the gateway cannot run',
        sources: [world.alpha, world.beta],
        authority: { read: [world.alpha, world.beta] },
        framing: true,
        budget: { actions: 4, judgments: 4, cost: 4_000 },
        success_evidence: 'a Report artifact covering every goal source',
      },
      '1',
    );
    const frameView = world.runtime
      .trace()
      .observations.find((observation) => observation.payload_type === 'inference.requested');
    assert.ok(frameView);
    const view = (frameView.payload as InferenceRequestedPayload).view;
    assert.equal(view.profile, FRAME_PROFILE);
    assert.equal(view.manifest.slices.some((item) => item.name === 'conclusion'), false);
    world.runtime.operator.submit({
      observation_id: 'operator:goal.missed:g-fail',
      caused_by: null,
      payload_type: 'goal.missed',
      payload_version: 1,
      payload: { goal_id: 'g-fail', reason: 'success evidence missed' },
    });
    tick(world, 9);
    const recorded = world.runtime.recordBaseline();
    assert.equal(recorded.validation.status, 'accepted');
    const baseline = recorded.payload as BaselineRecord;
    assert.equal(baseline.strategy, 'profile.frame@1');
    assert.equal(baseline.workload, 'repeated normalized-report goals, including a failing case');
    assert.equal(baseline.quality.held, 2);
    assert.equal(baseline.quality.missed, 1);
    assert.equal(baseline.inference_requests, 1);
    assert.equal(baseline.latency_ticks, 7);
    assert.equal(baseline.human_corrections, 1);
    const inferenceCost = world.runtime
      .trace()
      .observations.filter((observation) => observation.payload_type === 'inference.requested' && observation.validation.status === 'accepted')
      .reduce((sum, observation) => sum + (observation.payload as InferenceRequestedPayload).reservation.cost, 0);
    const hostCost = world.runtime
      .trace()
      .observations.filter(
        (observation) =>
          observation.payload_type === 'action.result' &&
          observation.validation.status === 'accepted' &&
          observation.source.kind === 'host',
      )
      .reduce((sum, observation) => sum + ((observation.payload as ActionResultPayload).cost_micros ?? 0), 0);
    assert.equal(baseline.cost_micros, inferenceCost + hostCost);
    assert.equal(hostCost, world.host.invocations.length * HOST_INVOCATION_MICROS);
    assert.equal(
      world.runtime.trace().observations.some((observation) => JSON.stringify(observation.payload).includes('profile.frame.narrow')),
      false,
    );
    assert.ok(world.runtime.trace().observations.some((observation) => observation.payload_type === 'baseline.recorded'));
    const operatorCount = world.runtime.trace().observations.filter((observation) => observation.source.kind === 'operator').length;
    assert.ok(operatorCount > baseline.human_corrections);

    const trace = world.runtime.trace();
    const fresh = new AgentFabricHost({ authority: createGrantAuthority() });
    const result = replay(trace.observations, { host: fresh, decisionLayer: new FailingDecisionLayer() });
    assert.equal(result.ok, true, result.ok ? '' : result.failure.reason);
    assert.equal(fresh.invocations.length, 0);
    if (result.ok) {
      assert.equal(result.state.baseline?.cost_micros, baseline.cost_micros);
      assert.equal(result.state.goal?.status, 'missed');
    }
  });
});
