/**
 * M5 contract checks (docs/m5-improve-an-operating-strategy.md).
 *
 * The candidate is a profile record. The protocol is recorded before the
 * comparison. Promotion is an operator observation. A core patch is refused.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority, type GrantAuthority } from '@weave/agentsop';
import { AgentFabricHost } from '@weave/agentfabric';
import {
  CACHE_MISS_DELTA_MICROS,
  CATALOGUE_SLOT_MICROS,
  DEFAULT_FRAME_PROFILE,
  FRAME_QUALITY_OPERATIONS,
  NARROW_FRAME_PROFILE,
  NORMALIZE_CONTRACT,
  PROCEDURE_IDS,
  MemoryJournal,
  Runtime,
  ScriptedDecisionLayer,
  fixtureGateway,
  normalizeSource,
  renderFrameView,
  replay,
  stablePrefixBytes,
  viewBodyBytes,
  type ExperimentComparedPayload,
  type Goal,
  type InferenceRequestedPayload,
  type Observation,
} from '@weave/weave';
import { CONTENT, FailingDecisionLayer } from './fixture.js';
import { actionIdFor, assembleReport, candidatesFor, lastCycle, pendingApproval, release } from './m1-fixture.js';
import { bindingJson, completedText } from './m2-fixture.js';

const WORKLOAD = 'repeated normalized-report goals, including a failing case';
const QUALITY_BAR = 'a report covering every goal source with whitespace collapsed and trimmed';
const PROMOTION_RULE =
  'quality holds AND human_corrections do not increase AND (latency_ticks or cost_micros improves) AND an empty view is a quality miss';
const CASES = ['g-normalize-1', 'g-normalize-2', 'g-normalize-blank'] as const;
const PROCEDURES = [
  'inspect_and_report@1',
  'inspect_report_publish@1',
  'frame_and_report@1',
  'crystallize_and_report@1',
] as const;

interface Lab {
  readonly authority: GrantAuthority;
  readonly host: AgentFabricHost;
  readonly runtime: Runtime;
  readonly alpha: string;
  readonly beta: string;
  readonly dest: string;
  readonly generateCalls: () => number;
  releaseFirst(): void;
}

function lab(options: { holdFirstFrame?: boolean } = {}): Lab {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({ authority });
  host.noteAdmission(NORMALIZE_CONTRACT, 'direct', normalizeSource('direct'));
  const alpha = host.registerSource('mem:alpha', CONTENT['source:alpha'] as string);
  const beta = host.registerSource('mem:beta', CONTENT['source:beta'] as string);
  const dest = host.registerDestination('mem:outbox');
  let calls = 0;
  let releaseFirst = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const generate = {
    id: 'fixture.generate',
    async execute(): Promise<ReturnType<typeof completedText>> {
      calls += 1;
      if (options.holdFirstFrame && calls === 1) {
        await gate;
      }
      return completedText(bindingJson([alpha, beta]));
    },
  };
  let runtime!: Runtime;
  const gateway = fixtureGateway({ clock: { now: () => runtime.state().clock.tick }, generate });
  runtime = new Runtime({
    host,
    decisionLayer: new ScriptedDecisionLayer(),
    grantAuthority: authority,
    gateway,
  });
  const built: Lab = {
    authority,
    host,
    runtime,
    alpha,
    beta,
    dest,
    generateCalls: () => calls,
    releaseFirst,
  };
  register(built, alpha, CONTENT['source:alpha'] as string, 'alpha');
  register(built, beta, CONTENT['source:beta'] as string, 'beta');
  register(built, dest, '', 'dest');
  return built;
}

function register(world: Lab, resource: string, content: string, name: string): void {
  world.runtime.observe({
    observation_id: `test:source.registered:${name}`,
    source: { kind: 'test', id: 'm5' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource, revision: 1, content },
  });
}

function submit(runtime: Runtime, id: string, payload_type: string, payload: unknown): Observation {
  return runtime.operator.submit({
    observation_id: id,
    caused_by: null,
    payload_type,
    payload_version: 1,
    payload,
  });
}

function recordWorkload(runtime: Runtime): void {
  submit(runtime, 'operator:workload:g-normalize-1', 'workload.recorded', { goal_id: 'g-normalize-1', quality: 'held' });
  submit(runtime, 'operator:workload:g-normalize-2', 'workload.recorded', { goal_id: 'g-normalize-2', quality: 'held' });
  submit(runtime, 'operator:workload:g-normalize-blank', 'workload.recorded', { goal_id: 'g-normalize-blank', quality: 'missed' });
}

function protocol(candidate: string, deadline = 4) {
  return {
    experiment_id: `exp.${candidate}`,
    weakness: 'framing discloses more catalogue than the composition uses',
    baseline: 'profile.frame@1',
    candidate,
    workload: WORKLOAD,
    protected_cases: [...CASES],
    quality_bar: QUALITY_BAR,
    measures: ['quality', 'human_corrections', 'latency_ticks', 'cost_micros', 'prefix_stable'],
    promotion: PROMOTION_RULE,
    budget: { judgments: 4, cost: 100_000 },
    rollback: 'profile.frame@1',
    deadline_tick: deadline,
  };
}

function tick(runtime: Runtime, n: number): void {
  const observation = runtime.clock.submit({
    observation_id: `clock:tick:${n}`,
    caused_by: null,
    payload_type: 'clock.tick',
    payload_version: 1,
    payload: { tick: n },
  });
  assert.equal(observation.validation.status, 'accepted', JSON.stringify(observation.validation));
}

function prepare(world: Lab, candidate = NARROW_FRAME_PROFILE.id, deadline = 4): Observation {
  recordWorkload(world.runtime);
  tick(world.runtime, deadline);
  const requested = submit(world.runtime, 'operator:baseline.requested', 'baseline.requested', {});
  assert.equal(requested.validation.status, 'accepted', JSON.stringify(requested.validation));
  assert.ok(world.runtime.state().baseline, 'the M4 baseline is recorded before the comparison');
  const recorded = submit(world.runtime, `operator:experiment.recorded:${candidate}`, 'experiment.recorded', protocol(candidate, deadline));
  assert.equal(recorded.validation.status, 'accepted', JSON.stringify(recorded.validation));
  return recorded;
}

function compare(world: Lab, candidate = NARROW_FRAME_PROFILE.id): ExperimentComparedPayload {
  const requested = submit(world.runtime, `operator:experiment.requested:${candidate}`, 'experiment.requested', {
    experiment_id: `exp.${candidate}`,
  });
  assert.equal(requested.validation.status, 'accepted', JSON.stringify(requested.validation));
  const compared = world.runtime
    .trace()
    .observations.find((observation) => observation.payload_type === 'experiment.compared' && observation.validation.status === 'accepted');
  assert.ok(compared);
  return compared.payload as ExperimentComparedPayload;
}

function promote(world: Lab, candidate = NARROW_FRAME_PROFILE.id): Observation {
  return submit(world.runtime, `operator:strategy.promoted:${candidate}`, 'strategy.promoted', {
    experiment_id: `exp.${candidate}`,
    workload: WORKLOAD,
  });
}

function frameGoal(world: Lab, goal_id: string, evidence = QUALITY_BAR): Goal {
  return {
    goal_id,
    purpose: 'Produce a checked report whose source text is normalized',
    sources: [world.alpha, world.beta],
    authority: { read: [world.alpha, world.beta] },
    framing: true,
    budget: { actions: 8, judgments: 8, cost: 1_000_000 },
    success_evidence: evidence,
  };
}

function openGoal(world: Lab, goal: Goal): Observation {
  return submit(world.runtime, `operator:goal.opened:${goal.goal_id}`, 'goal.opened', goal);
}

function frameViews(runtime: Runtime): InferenceRequestedPayload[] {
  return runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'inference.requested' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as InferenceRequestedPayload)
    .filter((payload) => payload.site === 'goal.frame');
}

function comparedSeqs(runtime: Runtime): number[] {
  return runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'experiment.compared')
    .map((observation) => observation.seq);
}

async function publishReport(world: Lab): Promise<void> {
  const goal: Goal = {
    goal_id: 'g-report',
    purpose: 'Produce and publish a checked report over the listed sources',
    sources: [world.alpha, world.beta],
    destination: world.dest,
    authority: { read: [world.alpha, world.beta] },
    budget: { actions: 8, judgments: 8, recovery: 4 },
    success_evidence: 'a publication receipt for the current report at the authorized destination',
  };
  openGoal(world, goal);
  const adapter = {
    host: world.host,
    runtime: world.runtime,
    alpha: world.alpha,
    beta: world.beta,
    gamma: world.alpha,
    dest: world.dest,
    destAlias: world.dest,
    authority: world.authority,
    journal: new MemoryJournal(),
    observe: (input: Parameters<Runtime['observe']>[0]) => world.runtime.observe(input),
  };
  await assembleReport(adapter as Parameters<typeof assembleReport>[0]);
  const request_id = pendingApproval(adapter as Parameters<typeof pendingApproval>[0]);
  world.runtime.decide({ request_id, principal: 'operator', decision: 'approved', authority_revision: 1 });
  const dispatched = lastCycle(adapter as Parameters<typeof lastCycle>[0]);
  const selected = candidatesFor(dispatched, 'report.publish')[0];
  assert.ok(selected);
  await release(adapter as Parameters<typeof release>[0], actionIdFor(dispatched, selected.candidate_id));
  assert.equal(world.runtime.state().goal?.status, 'complete');
  assert.ok(world.host.publication(world.dest));
}

describe('M5 improve one operating strategy', () => {
  it('M5-T01 the protocol is recorded before the narrow profile is compared', () => {
    const world = lab();
    const recorded = prepare(world);
    const measurement = compare(world);
    const protocolSeq = recorded.seq;
    for (const seq of comparedSeqs(world.runtime)) {
      assert.ok(protocolSeq < seq, 'the protocol observation is earlier than every comparative result');
    }
    assert.equal(measurement.candidate, 'profile.frame.narrow@1');
    const body = recorded.payload as Record<string, unknown>;
    assert.equal(body['candidate'], 'profile.frame.narrow@1');
    assert.equal(body['patch'], undefined);
    assert.equal(body['target'], undefined);
    assert.equal(JSON.stringify(body).includes('scheduler'), false);
    assert.deepEqual([...PROCEDURE_IDS], [...PROCEDURES]);
  });

  it('M5-T02 operator promotion activates the narrow profile for later goals', () => {
    const world = lab();
    prepare(world);
    const measurement = compare(world);
    assert.equal(measurement.quality, 'held', measurement.misses.join(','));
    for (const operation of FRAME_QUALITY_OPERATIONS) {
      assert.equal(measurement.misses.includes(`dropped:${operation}`), false, operation);
    }
    const judged = world.runtime.feed({
      observation_id: 'judgment:strategy.promoted',
      source: { kind: 'judgment', id: 'model' },
      caused_by: null,
      payload_type: 'strategy.promoted',
      payload_version: 1,
      payload: { experiment_id: `exp.${NARROW_FRAME_PROFILE.id}`, workload: WORKLOAD },
    });
    assert.equal(judged.validation.status, 'rejected');
    const beforeGrants = grantCount(world.runtime);
    const beforeAdmission = admissionCount(world.runtime);
    const promoted = promote(world);
    assert.equal(promoted.validation.status, 'accepted', JSON.stringify(promoted.validation));
    assert.equal((promoted.payload as { grant?: unknown }).grant, undefined);
    assert.equal(grantCount(world.runtime), beforeGrants);
    assert.equal(admissionCount(world.runtime), beforeAdmission);
    assert.equal(world.runtime.state().strategy.profile_id, 'profile.frame.narrow@1');
    const goal = frameGoal(world, 'g-frame-later');
    openGoal(world, goal);
    assert.equal(world.runtime.state().goal?.success_evidence, QUALITY_BAR);
    const view = frameViews(world.runtime).at(-1);
    assert.ok(view);
    assert.equal(view.view.profile, 'profile.frame.narrow@1');
    const catalogue = (view.view.content as { catalogue: { id: string }[] }).catalogue.map((op) => op.id);
    assert.ok(catalogue.includes('source.inspect'));
    assert.ok(catalogue.includes('text.normalize'));
    assert.equal(view.view.profile_version, 1);
  });

  it('M5-T03 a cheaper miss or more human corrections is not promoted', () => {
    const empty = lab();
    const emptyProfile = submit(empty.runtime, 'operator:profile.recorded:empty', 'profile.recorded', {
      id: 'profile.frame.empty@1',
      version: 1,
      catalogue_budget: 0,
    });
    assert.equal(emptyProfile.validation.status, 'accepted', JSON.stringify(emptyProfile.validation));
    prepare(empty, 'profile.frame.empty@1');
    const emptyMeasurement = compare(empty, 'profile.frame.empty@1');
    assert.ok(emptyMeasurement.cost_micros < emptyMeasurement.baseline_cost_micros);
    assert.equal(emptyMeasurement.quality, 'missed');
    assert.ok(emptyMeasurement.misses.includes('empty'));
    const emptyView = renderFrameView(empty.runtime.state(), [], { id: 'profile.frame.empty@1', version: 1, catalogue_budget: 0 });
    assert.deepEqual(emptyView.content, {});
    const emptyPromotion = promote(empty, 'profile.frame.empty@1');
    assert.equal(emptyPromotion.validation.status, 'rejected');
    assert.match(JSON.stringify(emptyPromotion.validation), /quality bar missed/);
    assert.equal(empty.runtime.state().strategy.profile_id, 'profile.frame@1');

    const dropped = lab();
    submit(dropped.runtime, 'operator:profile.recorded:drop', 'profile.recorded', {
      id: 'profile.frame.drop@1',
      version: 1,
      catalogue_budget: 1,
    });
    prepare(dropped, 'profile.frame.drop@1');
    const droppedMeasurement = compare(dropped, 'profile.frame.drop@1');
    assert.ok(droppedMeasurement.cost_micros < droppedMeasurement.baseline_cost_micros);
    assert.equal(droppedMeasurement.quality, 'missed');
    assert.ok(droppedMeasurement.misses.includes('dropped:source.inspect'));
    assert.ok(droppedMeasurement.misses.includes('dropped:text.normalize'));
    assert.equal(droppedMeasurement.misses.includes('empty'), false);
    const droppedPromotion = promote(dropped, 'profile.frame.drop@1');
    assert.equal(droppedPromotion.validation.status, 'rejected');
    assert.equal(dropped.runtime.state().strategy.profile_id, 'profile.frame@1');

    const corrected = lab();
    prepare(corrected);
    submit(corrected.runtime, 'operator:output.rejected:trial', 'output.rejected', {
      action_id: 'a:trial',
      reason: 'correct the normalized line',
    });
    const correctedMeasurement = compare(corrected);
    assert.equal(correctedMeasurement.quality, 'held');
    assert.ok(correctedMeasurement.cost_micros < correctedMeasurement.baseline_cost_micros);
    assert.ok(correctedMeasurement.human_corrections > (corrected.runtime.state().baseline?.human_corrections ?? 0));
    const correctedPromotion = promote(corrected);
    assert.equal(correctedPromotion.validation.status, 'rejected');
    assert.match(JSON.stringify(correctedPromotion.validation), /human corrections increased/);
    assert.equal(corrected.runtime.state().strategy.profile_id, 'profile.frame@1');
  });

  it('M5-T04 editing protected cases or the quality bar after results invalidates promotion', () => {
    const removed = lab();
    prepare(removed);
    compare(removed);
    const amendment = submit(removed.runtime, 'operator:experiment.amended:cases', 'experiment.amended', {
      experiment_id: `exp.${NARROW_FRAME_PROFILE.id}`,
      protected_cases: ['g-normalize-1', 'g-normalize-2'],
    });
    assert.equal(amendment.validation.status, 'rejected');
    assert.match(JSON.stringify(amendment.validation), /comparison invalidated/);
    assert.deepEqual(removed.runtime.state().experiment?.protected_cases, [...CASES]);
    assert.equal(removed.runtime.state().experiment?.invalidated, true);
    const removedPromotion = promote(removed);
    assert.equal(removedPromotion.validation.status, 'rejected');
    assert.equal(removed.runtime.state().strategy.profile_id, 'profile.frame@1');

    const lowered = lab();
    prepare(lowered);
    compare(lowered);
    const bar = submit(lowered.runtime, 'operator:experiment.amended:bar', 'experiment.amended', {
      experiment_id: `exp.${NARROW_FRAME_PROFILE.id}`,
      quality_bar: 'a shorter bar',
    });
    assert.equal(bar.validation.status, 'rejected');
    assert.equal(lowered.runtime.state().experiment?.quality_bar, QUALITY_BAR);
    assert.equal(lowered.runtime.state().experiment?.invalidated, true);
    const loweredPromotion = promote(lowered);
    assert.equal(loweredPromotion.validation.status, 'rejected');
    assert.match(JSON.stringify(loweredPromotion.validation), /comparison invalidated/);
  });

  it('M5-T05 a protected-case regression restores the baseline for future goals', async () => {
    const world = lab({ holdFirstFrame: true });
    prepare(world);
    compare(world);
    const promoted = promote(world);
    assert.equal(promoted.validation.status, 'accepted', JSON.stringify(promoted.validation));
    await publishReport(world);
    const receipt = world.host.publication(world.dest);
    assert.ok(receipt);
    const published = world.runtime.trace().observations.find(
      (observation) =>
        observation.payload_type === 'action.result' &&
        observation.validation.status === 'accepted' &&
        JSON.stringify(observation.payload).includes(receipt.invocation_id),
    );
    assert.ok(published);
    const goal = frameGoal(world, 'g-frame-inflight');
    openGoal(world, goal);
    const inflight = frameViews(world.runtime).at(-1);
    assert.ok(inflight);
    assert.equal(inflight.view.profile, 'profile.frame.narrow@1');
    const recordedView = JSON.stringify(inflight);
    const regressed = submit(world.runtime, 'operator:experiment.regressed:blank', 'experiment.regressed', {
      experiment_id: `exp.${NARROW_FRAME_PROFILE.id}`,
      case_id: 'g-normalize-blank',
    });
    assert.equal(regressed.validation.status, 'accepted', JSON.stringify(regressed.validation));
    assert.equal(world.runtime.state().strategy.profile_id, 'profile.frame@1');
    assert.equal(world.runtime.state().strategy.rolled_back, true);
    assert.equal(JSON.stringify(frameViews(world.runtime)[0]), recordedView);
    assert.deepEqual(world.host.publication(world.dest), receipt);
    assert.equal(
      world.runtime.trace().observations.find((observation) => observation.seq === published.seq)?.validation.status,
      'accepted',
    );
    const missed = submit(world.runtime, 'operator:goal.missed:inflight', 'goal.missed', {
      goal_id: 'g-frame-inflight',
      reason: 'stop the in-flight goal',
    });
    assert.equal(missed.validation.status, 'accepted', JSON.stringify(missed.validation));
    openGoal(world, frameGoal(world, 'g-frame-later'));
    const later = frameViews(world.runtime).at(-1);
    assert.ok(later);
    assert.equal(later.view.profile, 'profile.frame@1');
    const stopLater = submit(world.runtime, 'operator:goal.missed:later', 'goal.missed', {
      goal_id: 'g-frame-later',
      reason: 'stop before the missing profile',
    });
    assert.equal(stopLater.validation.status, 'accepted', JSON.stringify(stopLater.validation));
    const retired = submit(world.runtime, 'operator:profile.retired:baseline', 'profile.retired', {
      profile_id: 'profile.frame@1',
    });
    assert.equal(retired.validation.status, 'accepted', JSON.stringify(retired.validation));
    assert.equal(world.runtime.state().strategy.profile_id, 'profile.frame@1');
    assert.equal(world.runtime.state().strategy.paused, true);
    const before = frameViews(world.runtime).length;
    const pausedGoal = openGoal(world, frameGoal(world, 'g-frame-paused'));
    assert.equal(pausedGoal.validation.status, 'accepted', JSON.stringify(pausedGoal.validation));
    assert.equal(frameViews(world.runtime).length, before);
    const paused = world.runtime.trace().cycles.at(-1);
    assert.equal(paused?.outcome.status, 'blocked');
    if (paused?.outcome.status === 'blocked') {
      assert.match(paused.outcome.reason, /profile record missing/);
    }
    assert.equal(world.runtime.state().profiles['profile.frame@1'], undefined);
    world.releaseFirst();
  });

  it('M5-T06 a patch to admission or the procedure union is not evaluated', () => {
    for (const target of ['admission', 'procedure_union'] as const) {
      const world = lab();
      recordWorkload(world.runtime);
      tick(world.runtime, 4);
      submit(world.runtime, 'operator:baseline.requested', 'baseline.requested', {});
      const before = world.host.store.admitted().length;
      const recorded = submit(world.runtime, `operator:experiment.recorded:${target}`, 'experiment.recorded', {
        ...protocol(NARROW_FRAME_PROFILE.id),
        candidate: { target, patch: 'weaken the check' },
      });
      assert.equal(recorded.validation.status, 'rejected', JSON.stringify(recorded.validation));
      assert.match(JSON.stringify(recorded.validation), /evaluation does not start/);
      const requested = submit(world.runtime, `operator:experiment.requested:${target}`, 'experiment.requested', {
        experiment_id: `exp.${NARROW_FRAME_PROFILE.id}`,
      });
      assert.equal(requested.validation.status, 'rejected');
      assert.equal(
        world.runtime.trace().observations.some((observation) => observation.payload_type === 'experiment.compared'),
        false,
      );
      assert.deepEqual([...PROCEDURE_IDS], [...PROCEDURES]);
      assert.equal(world.host.store.admitted().length, before);
    }
  });

  it('M5-T07 replay uses the profile recorded on the view', async () => {
    const world = lab();
    prepare(world);
    compare(world);
    assert.equal(promote(world).validation.status, 'accepted');
    openGoal(world, frameGoal(world, 'g-frame-replay'));
    const liveView = frameViews(world.runtime).at(-1);
    assert.equal(liveView?.view.profile, 'profile.frame.narrow@1');
    const frameId = world.runtime
      .trace()
      .observations.find(
        (observation) =>
          observation.payload_type === 'action.started' &&
          (observation.payload as { operation?: string }).operation === 'goal.frame',
      );
    assert.ok(frameId);
    await world.runtime.settle((frameId.payload as { action_id: string }).action_id);
    const adapter = {
      host: world.host,
      runtime: world.runtime,
      alpha: world.alpha,
      beta: world.beta,
    };
    const inspects = lastCycle(adapter as Parameters<typeof lastCycle>[0]).selected;
    for (const selected of inspects) {
      world.host.release(selected.action_id);
      await world.runtime.settle(selected.action_id);
    }
    const assemble = candidatesFor(lastCycle(adapter as Parameters<typeof lastCycle>[0]), 'report.assemble')[0];
    assert.ok(assemble);
    const assembleId = actionIdFor(lastCycle(adapter as Parameters<typeof lastCycle>[0]), assemble.candidate_id);
    world.host.release(assembleId);
    await world.runtime.settle(assembleId);
    assert.equal(world.runtime.state().goal?.status, 'complete');

    let gatewayCalls = 0;
    const generate = {
      id: 'replay.generate',
      async execute(): Promise<ReturnType<typeof completedText>> {
        gatewayCalls += 1;
        throw new Error('gateway must not be invoked');
      },
    };
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    let replayRuntime!: Runtime;
    const result = replay(world.runtime.trace().observations, {
      host,
      decisionLayer: new FailingDecisionLayer(),
      grantAuthority: authority,
      frameProfile: DEFAULT_FRAME_PROFILE,
      gateway: fixtureGateway({ clock: { now: () => replayRuntime.state().clock.tick }, generate }),
    });
    assert.equal(result.ok, true, result.ok ? '' : result.failure.reason);
    assert.equal(host.invocations.length, 0);
    assert.equal(gatewayCalls, 0);
    if (result.ok) {
      const replayed = result.trace.observations
        .filter((observation) => observation.payload_type === 'inference.requested')
        .map((observation) => observation.payload as InferenceRequestedPayload)
        .filter((payload) => payload.site === 'goal.frame');
      assert.equal(replayed.at(-1)?.view.profile, 'profile.frame.narrow@1');
    }
  });

  it('M5-T08 a stable-prefix change is one cache-miss delta and the deadline stays put', () => {
    const world = lab();
    const prefixProfile = {
      id: 'profile.frame.prefix@1',
      version: 1,
      catalogue_budget: 32,
      prefix: 'changed-stable-prefix',
    };
    assert.equal(
      submit(world.runtime, 'operator:profile.recorded:prefix', 'profile.recorded', prefixProfile).validation.status,
      'accepted',
    );
    prepare(world, prefixProfile.id, 4);
    const keepalive = world.runtime.gatewayIngress.submit({
      observation_id: 'gateway:keepalive',
      caused_by: null,
      payload_type: 'provider.keepalive',
      payload_version: 1,
      payload: { alive: true, tick: 99 },
    });
    assert.equal(keepalive.validation.status, 'accepted', JSON.stringify(keepalive.validation));
    assert.equal(world.runtime.state().clock.tick, 4);
    const measurement = compare(world, prefixProfile.id);
    assert.equal(measurement.prefix_stable, false);
    assert.equal(measurement.deadline_tick, 4);
    assert.equal(measurement.token_micros, 32 * CATALOGUE_SLOT_MICROS);
    assert.equal(measurement.cache_miss_delta, CACHE_MISS_DELTA_MICROS);
    assert.equal(measurement.cost_micros, measurement.token_micros + CACHE_MISS_DELTA_MICROS);
    const catalogue = world.host.operations().map((operation) => {
      const described = world.host.describe(operation);
      assert.equal(described.kind, 'contract');
      if (described.kind !== 'contract') {
        throw new Error('missing contract');
      }
      return { id: described.contract.id, input: described.contract.input };
    });
    const baselineView = renderFrameView(world.runtime.state(), catalogue, DEFAULT_FRAME_PROFILE);
    const candidateView = renderFrameView(world.runtime.state(), catalogue, prefixProfile);
    assert.equal(viewBodyBytes(baselineView), viewBodyBytes(candidateView));
    const prefixBytes = stablePrefixBytes(prefixProfile, candidateView).length;
    assert.ok(prefixBytes > 0);
    assert.notEqual(measurement.cost_micros, measurement.token_micros + prefixBytes + CACHE_MISS_DELTA_MICROS);
    assert.notEqual(measurement.cost_micros, measurement.token_micros + measurement.token_micros + CACHE_MISS_DELTA_MICROS);
  });
});

function grantCount(runtime: Runtime): number {
  return runtime.trace().observations.filter((observation) => {
    if (observation.validation.status !== 'accepted' || typeof observation.payload !== 'object' || observation.payload === null) {
      return false;
    }
    return (observation.payload as { grant?: unknown }).grant != null;
  }).length;
}

function admissionCount(runtime: Runtime): number {
  return runtime.trace().observations.filter(
    (observation) => observation.payload_type === 'admission.decided' && observation.validation.status === 'accepted',
  ).length;
}
