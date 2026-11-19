/** WV-N274: lookup work is bounded by the result, not the observation prefix. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Runtime,
  ScriptedDecisionLayer,
  MemoryJournal,
  candidateSetDigest,
  DEFAULT_FRAME_PROFILE,
  NARROW_FRAME_PROFILE,
  renderFrameView,
  replay,
  recover,
  type Observation,
  type ObservationInput,
  type InferenceRequestedPayload,
  type WeightsRecordedPayload,
  type FrameProfile,
  type RuntimeOptions,
} from '@weave/weave';
import { FakeHost, FixtureEnvironment, SOURCE_INSPECT, REPORT_ASSEMBLE } from './fake-host.js';
import { ALPHA, baseGoal, goalOpened, registered, tick } from './fixture.js';

interface Lookups {
  log: Observation[];
  replayLog: readonly Observation[] | null;
  append(input: ObservationInput): Observation;
  frontierWeighStatus(set: string): { kind: string; reason?: string };
  profileBoundToCurrentGoal(): FrameProfile | null;
  recordedFrameProfile(): FrameProfile | null;
  replayCatalogueIds(): readonly string[];
  describeOperation(operation: string): unknown;
  recordRecoveryExhausted(reason: string): void;
  maybeRecordBaseline(): void;
}
const internals = (runtime: Runtime) => runtime as unknown as Lookups;
function options(extra: Partial<RuntimeOptions> = {}): RuntimeOptions {
  return {
    host: new FakeHost(new FixtureEnvironment()),
    decisionLayer: new ScriptedDecisionLayer(),
    shareAssemblies: true,
    ...extra,
  };
}
function append(
  runtime: Runtime,
  type: string,
  payload: unknown,
  id = `${type}:${internals(runtime).log.length}`,
): Observation {
  return internals(runtime).append({
    observation_id: id,
    source: {
      kind: type === 'weights.recorded' ? 'judgment' : type === 'inference.recorded' ? 'gateway' : 'runtime',
      id: 'weave',
    },
    caused_by: null,
    payload_type: type,
    payload_version: 1,
    payload,
  });
}
function accepted(observation: Observation): Observation {
  assert.equal(observation.validation.status, 'accepted', JSON.stringify(observation.validation));
  return observation;
}
function setup(extra: Partial<RuntimeOptions> = {}, size = 1024): Runtime {
  const runtime = new Runtime(options(extra));
  runtime.observe(registered(ALPHA, 'alpha'));
  for (let i = 1; i <= size; i++) runtime.clock.submit(tick(i));
  accepted(
    internals(runtime).append({
      ...goalOpened(baseGoal({ framing: true, budget: { actions: 100, judgments: 100, cost: 100_000 } })),
      source: { kind: 'operator', id: 'operator' },
    }),
  );
  return runtime;
}
function request(
  runtime: Runtime,
  id: string,
  site: 'goal.frame' | 'frontier.weigh',
  profile = DEFAULT_FRAME_PROFILE,
): Observation {
  return accepted(
    append(
      runtime,
      'inference.requested',
      {
        request_id: id,
        site,
        role: site === 'goal.frame' ? 'framing' : 'working',
        kind: 'transform',
        state_revision: runtime.state().state_revision,
        candidate_set: candidateSetDigest(['candidate']),
        view: renderFrameView(runtime.state(), [], profile),
        terms: {
          quality: 'baseline',
          destinations: ['local'],
          max_context_tokens: 8000,
          deadline: 100_000,
          cost_ceiling: 1,
          max_attempts: 1,
        },
        reservation: { judgments: 1, cost: 1 },
      } satisfies InferenceRequestedPayload,
      `request:${id}`,
    ),
  );
}
function weights(runtime: Runtime, id: string, weight = 0): Observation {
  return append(runtime, 'weights.recorded', {
    site: 'frontier.weigh',
    implementation: 'fixture',
    state_revision: runtime.state().state_revision,
    candidate_set: candidateSetDigest(['candidate']),
    weights: [{ candidate_id: 'candidate', weight }],
    request_id: id,
    contract: 'frontier.weigh@1',
  } satisfies WeightsRecordedPayload);
}
function recorded(runtime: Runtime, id: string): void {
  accepted(
    append(runtime, 'inference.recorded', { request_id: id, attempts: [], spent: 0, status: 'accepted', reason: null }),
  );
}
function reads(runtime: Runtime, run: () => void): number {
  const inner = internals(runtime);
  const log = inner.log,
    replayLog = inner.replayLog;
  let count = 0;
  const counted = (log: readonly Observation[]) =>
    new Proxy(log, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) count++;
        return Reflect.get(target, property, receiver);
      },
    });
  inner.log = counted(log) as Observation[];
  inner.replayLog = replayLog ? counted(replayLog) : null;
  try {
    run();
  } finally {
    inner.log = log;
    inner.replayLog = replayLog;
  }
  return count;
}
const baseline = {
  strategy: 'profile.frame@1',
  workload: 'fixture',
  quality: { held: 1, missed: 1, cases: [] },
  inference_requests: 0,
  latency_ticks: 0,
  cost_micros: 0,
  human_corrections: 0,
};

describe('WV-N274 observation lookup complexity', () => {
  it('weigh status does not scan the accepted prefix', () => {
    const runtime = setup();
    request(runtime, 'weigh', 'frontier.weigh');
    accepted(weights(runtime, 'weigh'));
    recorded(runtime, 'weigh');
    const count = reads(runtime, () =>
      assert.deepEqual(internals(runtime).frontierWeighStatus(candidateSetDigest(['candidate'])), { kind: 'deferred' }),
    );
    assert.ok(count <= 8, `weigh status read ${count} log entries; expected at most 8 tail entries`);
  });
  it('the current goal frame profile does not scan the accepted prefix', () => {
    const runtime = setup();
    request(runtime, 'frame', 'goal.frame');
    const count = reads(runtime, () =>
      assert.deepEqual(internals(runtime).profileBoundToCurrentGoal(), DEFAULT_FRAME_PROFILE),
    );
    assert.equal(count, 0, `frame profile read ${count} log entries; expected 0`);
  });
  it('replay frame profile does not scan either log', () => {
    const live = setup();
    request(live, 'frame', 'goal.frame');
    const log = live.trace().observations;
    const runtime = new Runtime(options(), log);
    runtime.load(log.slice(0, -1));
    const count = reads(runtime, () =>
      assert.deepEqual(internals(runtime).recordedFrameProfile(), DEFAULT_FRAME_PROFILE),
    );
    assert.equal(count, 0, `replay frame profile read ${count} log entries; expected 0`);
  });
  it('replay catalogue reads only indexed contract descriptions', () => {
    const live = setup();
    accepted(append(live, 'capability.described', { operation: SOURCE_INSPECT.id, contract: SOURCE_INSPECT }));
    request(live, 'frame', 'goal.frame');
    const log = live.trace().observations;
    const runtime = new Runtime(options(), log);
    runtime.load(log.slice(0, -2));
    const count = reads(runtime, () => assert.deepEqual(internals(runtime).replayCatalogueIds(), [SOURCE_INSPECT.id]));
    assert.equal(count, 0, `replay catalogue read ${count} log entries; expected 0`);
  });
  it('replay describe uses observation id and seq indexes', () => {
    const live = setup();
    accepted(
      append(
        live,
        'capability.described',
        { operation: SOURCE_INSPECT.id, contract: SOURCE_INSPECT },
        `contract:${SOURCE_INSPECT.id}:${SOURCE_INSPECT.revision}`,
      ),
    );
    const log = live.trace().observations;
    const runtime = new Runtime(options(), log);
    runtime.load(log.slice(0, -1));
    const count = reads(runtime, () =>
      assert.deepEqual(internals(runtime).describeOperation(SOURCE_INSPECT.id), SOURCE_INSPECT),
    );
    assert.equal(count, 0, `replay describe read ${count} log entries; expected 0`);
  });
  it('recovery exhaustion does not scan the accepted prefix', () => {
    const runtime = setup();
    internals(runtime).recordRecoveryExhausted('fixture');
    const count = reads(runtime, () => internals(runtime).recordRecoveryExhausted('again'));
    assert.equal(count, 0, `recovery exhaustion read ${count} log entries; expected 0`);
  });
  it('baseline presence does not scan the accepted prefix', () => {
    const runtime = setup();
    accepted(append(runtime, 'baseline.recorded', baseline));
    const count = reads(runtime, () => internals(runtime).maybeRecordBaseline());
    assert.equal(count, 0, `baseline presence read ${count} log entries; expected 0`);
  });
});

/** Reference the original scans at every prefix, including rejected requests. */
function checkPrefixLookups(runtime: Runtime, recordedLog: readonly Observation[]): void {
  const inner = internals(runtime),
    log = inner.log;
  const state = runtime.state();
  const emitted = new Set(log.map((o) => o.observation_id));
  const next = recordedLog.find((o) => o.payload_type === 'inference.requested' && !emitted.has(o.observation_id));
  const frame = recordedLog.find(
    (o) =>
      o.payload_type === 'inference.requested' &&
      !emitted.has(o.observation_id) &&
      (o.payload as InferenceRequestedPayload).site === 'goal.frame',
  );
  const profile = (observation: Observation | undefined): FrameProfile | null => {
    if (!observation) return null;
    const view = (observation.payload as InferenceRequestedPayload).view;
    const known = state.profiles[view.profile];
    return known?.version === view.profile_version ? known : null;
  };
  const bound = log
    .filter(
      (o) =>
        o.validation.status === 'accepted' &&
        o.seq > (state.goal?.evidence ?? Infinity) &&
        o.payload_type === 'inference.requested' &&
        (o.payload as InferenceRequestedPayload).site === 'goal.frame',
    )
    .at(-1);
  assert.deepEqual(inner.profileBoundToCurrentGoal(), profile(bound));
  assert.deepEqual(inner.recordedFrameProfile(), profile(frame));
  const catalogue = recordedLog
    .filter(
      (o) =>
        o.validation.status === 'accepted' &&
        o.payload_type === 'capability.described' &&
        o.seq < (next?.seq ?? Infinity),
    )
    .map((o) => (o.payload as { operation: string }).operation);
  assert.deepEqual(inner.replayCatalogueIds(), [...new Set(catalogue)]);
}

describe('WV-N274 lookup equivalence and accepted-prefix recovery', () => {
  it('matches the original lookups at every prefix and after repeated reads and reload', () => {
    const live = setup({}, 0);
    accepted(append(live, 'capability.described', { operation: SOURCE_INSPECT.id, contract: SOURCE_INSPECT }));
    request(live, 'frame1', 'goal.frame');
    recorded(live, 'frame1');
    request(live, 'weigh1', 'frontier.weigh');
    accepted(weights(live, 'weigh1'));
    recorded(live, 'weigh1');
    // A second accepted record still leaves the original first matching weights in force.
    accepted(weights(live, 'weigh1', 2));
    assert.deepEqual(internals(live).frontierWeighStatus(candidateSetDigest(['candidate'])), { kind: 'deferred' });
    accepted(append(live, 'capability.described', { operation: REPORT_ASSEMBLE.id, contract: REPORT_ASSEMBLE }));
    const frame = request(live, 'frame2', 'goal.frame', NARROW_FRAME_PROFILE);
    recorded(live, 'frame2');
    const rejected = append(live, 'inference.requested', {
      ...(frame.payload as InferenceRequestedPayload),
      request_id: 'rejected-frame',
      reservation: { judgments: 1000, cost: 0 },
    });
    assert.equal(rejected.validation.status, 'rejected');
    accepted(
      internals(live).append({
        observation_id: 'miss',
        source: { kind: 'operator', id: 'operator' },
        caused_by: null,
        payload_type: 'goal.missed',
        payload_version: 1,
        payload: { goal_id: 'g-report', reason: 'fixture' },
      }),
    );
    accepted(
      internals(live).append({
        ...goalOpened(baseGoal({ goal_id: 'second', budget: { actions: 100, judgments: 100, cost: 100_000 } })),
        observation_id: 'second',
        source: { kind: 'operator', id: 'operator' },
      }),
    );
    assert.equal(internals(live).profileBoundToCurrentGoal(), null);
    request(live, 'frame3', 'goal.frame');
    recorded(live, 'frame3');
    const log = live.trace().observations;
    const runtime = new Runtime(options(), log);
    for (let n = 0; n <= log.length; n++) {
      if (n > 0) runtime.load([log[n - 1]!]);
      checkPrefixLookups(runtime, log);
      checkPrefixLookups(runtime, log); // Cursors cannot consume an unseen request on a read.
      const loaded = new Runtime(options(), log);
      loaded.load(log.slice(0, n));
      checkPrefixLookups(loaded, log);
    }
    // The durable journal omits rejected records, leaving seq gaps.
    const durable = log.filter((o) => o.validation.status === 'accepted');
    const restored = new Runtime(options(), durable);
    restored.load(durable);
    checkPrefixLookups(restored, durable);
    assert.deepEqual(internals(restored).profileBoundToCurrentGoal(), internals(live).profileBoundToCurrentGoal());
    assert.deepEqual(
      internals(restored).frontierWeighStatus(candidateSetDigest(['candidate'])),
      internals(live).frontierWeighStatus(candidateSetDigest(['candidate'])),
    );
  });

  it('rejected and failed appends never change accepted lookup results; recovery retries them', () => {
    let fail: string | null = null;
    const journal = new MemoryJournal();
    const runtime = setup(
      {
        journal: {
          persist(observation) {
            if (observation.payload_type === fail) throw new Error('interrupted append');
            journal.persist(observation);
          },
          snapshot: () => journal.snapshot(),
        },
      },
      0,
    );
    request(runtime, 'frame', 'goal.frame');
    recorded(runtime, 'frame');
    fail = 'inference.requested';
    assert.throws(() => request(runtime, 'interrupted', 'goal.frame', NARROW_FRAME_PROFILE), /interrupted append/);
    assert.deepEqual(internals(runtime).profileBoundToCurrentGoal(), DEFAULT_FRAME_PROFILE);
    fail = null;
    const frame = request(runtime, 'retry', 'goal.frame', NARROW_FRAME_PROFILE);
    recorded(runtime, 'retry');
    const bad = append(runtime, 'inference.requested', {
      ...(frame.payload as InferenceRequestedPayload),
      request_id: 'over-budget',
      reservation: { judgments: 1000, cost: 0 },
      view: renderFrameView(runtime.state(), [], DEFAULT_FRAME_PROFILE),
    });
    assert.equal(bad.validation.status, 'rejected');
    assert.deepEqual(internals(runtime).profileBoundToCurrentGoal(), NARROW_FRAME_PROFILE);
    request(runtime, 'weigh', 'frontier.weigh');
    fail = 'weights.recorded';
    assert.throws(() => weights(runtime, 'weigh'), /interrupted append/);
    fail = null;
    const badWeights = weights(runtime, 'weigh', 3);
    assert.equal(badWeights.validation.status, 'rejected');
    recorded(runtime, 'weigh');
    assert.deepEqual(internals(runtime).frontierWeighStatus(candidateSetDigest(['candidate'])), {
      kind: 'finished',
      reason: 'stale judgment',
    });
    assert.equal(append(runtime, 'recovery.exhausted', { reason: '' }).validation.status, 'rejected');
    fail = 'recovery.exhausted';
    assert.throws(() => internals(runtime).recordRecoveryExhausted('fixture'), /interrupted append/);
    fail = null;
    const recovered = recover(journal.snapshot(), options());
    internals(recovered).recordRecoveryExhausted('fixture');
    internals(recovered).recordRecoveryExhausted('again');
    assert.equal(recovered.trace().observations.filter((o) => o.payload_type === 'recovery.exhausted').length, 1);
    assert.deepEqual(internals(recovered).profileBoundToCurrentGoal(), NARROW_FRAME_PROFILE);
    assert.equal(
      append(runtime, 'baseline.recorded', { ...baseline, quality: { held: 0, missed: 0 } }).validation.status,
      'rejected',
    );
    fail = 'baseline.recorded';
    assert.throws(() => append(runtime, 'baseline.recorded', baseline), /interrupted append/);
    fail = null;
    accepted(append(runtime, 'baseline.recorded', baseline));
    const loaded = new Runtime(options());
    loaded.load(journal.snapshot());
    const count = loaded.trace().observations.length;
    internals(loaded).maybeRecordBaseline();
    assert.equal(loaded.trace().observations.length, count);
  });

  it('replay describe preserves seq gaps, rejected emitted ids and defensive copies on load', () => {
    const live = setup({}, 0);
    const contractId = `contract:${SOURCE_INSPECT.id}:${SOURCE_INSPECT.revision}`;
    const rejected = internals(live).append({
      observation_id: contractId,
      source: { kind: 'test', id: 'fake' },
      caused_by: null,
      payload_type: 'capability.described',
      payload_version: 1,
      payload: { operation: SOURCE_INSPECT.id, contract: SOURCE_INSPECT },
    });
    assert.equal(rejected.validation.status, 'rejected');
    accepted(
      append(
        live,
        'capability.described',
        { operation: SOURCE_INSPECT.id, contract: SOURCE_INSPECT },
        'other-description',
      ),
    );
    const log = live.trace().observations;
    const runtime = new Runtime(options(), log);
    runtime.load(log.slice(0, -1));
    assert.deepEqual(internals(runtime).describeOperation(SOURCE_INSPECT.id), SOURCE_INSPECT);
    assert.equal(runtime.trace().observations.length, log.length - 1, 'a rejected emitted id still counts as emitted');
    const gapLog = log.filter((o) => o.validation.status === 'accepted');
    const fresh = new Runtime(options(), gapLog);
    fresh.load(gapLog.slice(0, -1));
    assert.equal(
      internals(fresh).describeOperation(SOURCE_INSPECT.id),
      null,
      'seq gaps must not be treated as array offsets',
    );
    const loaded = new Runtime(options());
    loaded.load(log);
    const before = loaded.trace();
    const detached = loaded.trace() as unknown as { observations: { observation_id: string }[] };
    detached.observations[0]!.observation_id = 'mutated';
    (log[0] as { observation_id: string }).observation_id = 'mutated-input';
    assert.deepEqual(loaded.trace(), before);
  });
});

describe('WV-N274 replay diagnostics', () => {
  it('an oversize diagnostic does not mark a replay request as emitted', () => {
    const live = setup({}, 0);
    const frame = request(live, 'future', 'goal.frame');
    const log = live.trace().observations;
    const runtime = new Runtime(options({ logBound: { max_observation_bytes: 10 } }), log);
    runtime.load(log.slice(0, -1));
    const diagnostic = runtime.observe({
      observation_id: frame.observation_id,
      source: { kind: 'test', id: 'fixture' },
      caused_by: null,
      payload_type: 'clock.tick',
      payload_version: 1,
      payload: { tick: 1, padding: 'x'.repeat(100) },
    });
    assert.equal(diagnostic.validation.status, 'rejected');
    assert.deepEqual(internals(runtime).recordedFrameProfile(), DEFAULT_FRAME_PROFILE);
  });
});

// Rejected observations can carry malformed payloads; indexing must stay inert.
it('replays a rejected inference with a null payload without reading it during construction', () => {
  const runtime = new Runtime(options());
  const input: ObservationInput = {
    observation_id: 'malformed',
    source: { kind: 'test', id: 'fixture' },
    caused_by: null,
    payload_type: 'inference.requested',
    payload_version: 1,
    payload: null,
  };
  assert.equal(runtime.observe(input).validation.status, 'rejected');
  const log = runtime.trace().observations;
  const result = replay(log, options());
  assert.equal(result.ok, true);
  assert.deepEqual(result.trace.observations, log);
});
