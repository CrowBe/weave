/**
 * M4 contract checks (docs/m4-measure-reuse.md).
 *
 * The repeated report dispatches admitted `text.normalize` from
 * `composition.normalize-report@1`. Reuse, cross-goal policy, replacement
 * admission, and the baseline are required evidence.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority, type CapabilityLifecycle } from '@weave/agentsop';
import { AgentFabricHost, FabricLifecycle, FabricStore } from '@weave/agentfabric';
import {
  NORMALIZE_COMPOSITION,
  NORMALIZE_CONTRACT,
  RETAINED_NORMALIZE_PROCEDURE,
  ScriptedNormalizeAuthor,
  collapseWhitespace,
  normalizeSource,
  Runtime,
  ScriptedDecisionLayer,
  type ActionResultPayload,
  type ActionStartedPayload,
  type ExtensionAuthor,
  type Goal,
  type Observation,
  type ObservationInput,
} from '@weave/weave';
import { CONTENT } from './fixture.js';

const HOST_MICROS = 1_000;
const BLANK = '   ';
const SHORT_REVISION = 'z  z';

interface World {
  readonly authority: ReturnType<typeof createGrantAuthority>;
  readonly host: AgentFabricHost;
  readonly lifecycle: FabricLifecycle;
  readonly author: ScriptedNormalizeAuthor;
  readonly runtime: Runtime;
  readonly alpha: string;
  readonly beta: string;
  readonly gamma: string;
}

function world(): World {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({ authority });
  const lifecycle = new FabricLifecycle(host, 'enforcing');
  const author = new ScriptedNormalizeAuthor();
  const alpha = host.registerSource('mem:alpha', CONTENT['source:alpha'] as string);
  const beta = host.registerSource('mem:beta', CONTENT['source:beta'] as string);
  const gamma = host.registerSource('mem:gamma', CONTENT['source:gamma'] as string);
  const runtime = new Runtime({
    host,
    decisionLayer: new ScriptedDecisionLayer(),
    grantAuthority: authority,
    lifecycle,
    author,
  });
  const built: World = { authority, host, lifecycle, author, runtime, alpha, beta, gamma };
  register(built.runtime, alpha, CONTENT['source:alpha'] as string, 'alpha');
  register(built.runtime, beta, CONTENT['source:beta'] as string, 'beta');
  register(built.runtime, gamma, CONTENT['source:gamma'] as string, 'gamma');
  return built;
}

function register(runtime: Runtime, resource: string, content: string, name: string, revision = 1): void {
  runtime.observe({
    observation_id: `test:source.registered:${name}:${revision}:${resource}`,
    source: { kind: 'test', id: 'm4' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource, revision, content },
  });
}

function goalFor(world: World, goal_id: string, sources: readonly string[]): Goal {
  return {
    goal_id,
    purpose: 'Produce a checked report whose source text is normalized',
    sources: [...sources],
    authority: { read: [...sources] },
    composition: { ...NORMALIZE_COMPOSITION, variants: world.author.variants },
    retained_procedure: RETAINED_NORMALIZE_PROCEDURE,
    budget: { actions: 48, judgments: 48 },
    success_evidence: 'a report covering every goal source with whitespace collapsed and trimmed',
  };
}

function open(runtime: Runtime, goal: Goal): void {
  runtime.operator.submit({
    observation_id: `operator:goal.opened:${goal.goal_id}:${runtime.state().state_revision}`,
    caused_by: null,
    payload_type: 'goal.opened',
    payload_version: 1,
    payload: goal,
  });
}

function started(runtime: Runtime, operation: string): ActionStartedPayload[] {
  return runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'action.started' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as ActionStartedPayload)
    .filter((payload) => payload.operation === operation);
}

function results(runtime: Runtime, operation: string): ActionResultPayload[] {
  const ids = new Set(started(runtime, operation).map((payload) => payload.action_id));
  return runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'action.result' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as ActionResultPayload)
    .filter((payload) => ids.has(payload.action_id));
}

function normalizeInvocations(host: AgentFabricHost): number {
  return host.invocations.filter((invocation) => invocation.operation === 'text.normalize').length;
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function drive(world: { runtime: Runtime; host: AgentFabricHost }): Promise<void> {
  for (let step = 0; step < 60; step += 1) {
    await flush(6);
    const state = world.runtime.state();
    if (state.goal?.status === 'complete') {
      return;
    }
    const openIds = [...world.host.openActionIds()].sort();
    for (const action_id of openIds) {
      world.host.release(action_id);
    }
    const running = Object.values(world.runtime.state().actions).filter((action) => action.state === 'running' || action.state === 'pending');
    if (running.length > 0) {
      await Promise.all(
        running.map(async (action) => {
          try {
            await world.runtime.settle(action.action_id);
          } catch {
            await flush(4);
          }
        }),
      );
      continue;
    }
    if (openIds.length === 0) {
      await flush(8);
      const after = world.runtime.state();
      const still = Object.values(after.actions).some((action) => action.state === 'running' || action.state === 'pending');
      if (!still && world.host.openActionIds().length === 0) {
        return;
      }
    }
  }
  const stuck = world.runtime.state();
  throw new Error(`drive stopped at ${stuck.goal?.status ?? 'no goal'}`);
}

/** A host that still has the admitted implementation and resources, with no invocation records. */
function continuedHost(fixture: World): { host: AgentFabricHost; authority: ReturnType<typeof createGrantAuthority> } {
  const authority = createGrantAuthority();
  const snapshot = fixture.host.store.snapshot();
  const host = new AgentFabricHost({
    authority,
    store: FabricStore.restore({ ...snapshot, invocations: [] }),
  });
  return { host, authority };
}

function repeatRuntime(host: AgentFabricHost, authority: ReturnType<typeof createGrantAuthority>): Runtime {
  return new Runtime({
    host,
    decisionLayer: new ScriptedDecisionLayer(),
    grantAuthority: authority,
    lifecycle: throwingLifecycle(),
    author: throwingAuthor(),
  });
}

function citesConclusion(runtime: Runtime): boolean {
  return runtime.trace().observations.some((observation) => {
    if (observation.validation.status !== 'accepted') {
      return false;
    }
    if (observation.payload_type.startsWith('conclusion.')) {
      return true;
    }
    return isRecord(observation.payload) && typeof observation.payload['conclusion_id'] === 'string';
  });
}

function baselinePayload(observations: readonly Observation[]): Record<string, unknown> | undefined {
  for (const observation of observations) {
    if (observation.validation.status !== 'accepted' || !isRecord(observation.payload)) {
      continue;
    }
    const payload = observation.payload;
    if (
      payload['strategy'] === 'profile.frame@1' &&
      'quality' in payload &&
      typeof payload['inference_requests'] === 'number' &&
      typeof payload['latency_ticks'] === 'number' &&
      typeof payload['cost_micros'] === 'number' &&
      typeof payload['human_corrections'] === 'number'
    ) {
      return payload;
    }
  }
  return undefined;
}

function tick(runtime: Runtime, n: number): void {
  runtime.clock.submit({
    observation_id: `clock:tick:${n}:${runtime.state().state_revision}`,
    caused_by: null,
    payload_type: 'clock.tick',
    payload_version: 1,
    payload: { tick: n },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwingLifecycle(): CapabilityLifecycle {
  const fail = (): never => {
    throw new Error('lifecycle must not be invoked');
  };
  return {
    search: fail,
    searchExact: fail,
    proposeContract: fail,
    submitCases: fail,
    reviseCases: fail,
    validateCorpus: fail,
    demonstrateRed: fail,
    implementerView: fail,
    attachImplementation: fail,
    proveGreen: fail,
    heldOutReport: fail,
    requestAdmission: fail,
    admit: fail,
    revoke: fail,
    reviseContract: fail,
    audit: fail,
  };
}

function throwingAuthor(): ExtensionAuthor {
  const fail = (): never => {
    throw new Error('author must not be invoked');
  };
  return {
    implementation: 'm4-throw',
    variants: [],
    proposeContract: fail,
    proposeCases: fail,
    proposeImplementation: fail,
  };
}

describe('M4 measure reuse', () => {
  it('M4-T01 the repeated report dispatches text.normalize from the recorded composition', async () => {
    const fixture = world();
    fixture.lifecycle.installEstablished(NORMALIZE_CONTRACT, normalizeSource('direct'));
    open(fixture.runtime, goalFor(fixture, 'g-normalize-1', [fixture.alpha, fixture.beta]));
    await drive(fixture);
    assert.equal(fixture.runtime.state().goal?.status, 'complete');

    const repeat = repeatRuntime(fixture.host, fixture.authority);
    register(repeat, fixture.alpha, CONTENT['source:alpha'] as string, 'repeat-alpha');
    register(repeat, fixture.beta, CONTENT['source:beta'] as string, 'repeat-beta');
    open(repeat, goalFor(fixture, 'g-normalize-2', [fixture.alpha, fixture.beta]));
    await drive({ runtime: repeat, host: fixture.host });

    assert.equal(repeat.state().goal?.status, 'complete');
    assert.equal(repeat.state().goal?.framing, undefined);
    assert.equal(started(repeat, 'text.normalize').length, 2);
    assert.equal(repeat.trace().observations.some((observation) => observation.payload_type === 'inference.requested'), false);
    assert.ok(repeat.trace().cycles.length > 0);
    assert.equal(repeat.trace().cycles.every((cycle) => cycle.procedure === 'inspect_and_report@1'), true);
  });

  it('M4-T02 the same input, read set, and goal reuse the cached conclusion', async () => {
    const fixture = world();
    fixture.host.noteAdmission(NORMALIZE_CONTRACT, 'direct', normalizeSource('direct'));
    open(fixture.runtime, goalFor(fixture, 'g-normalize-1', [fixture.alpha, fixture.beta]));
    await drive(fixture);
    const next = continuedHost(fixture);
    const repeat = repeatRuntime(next.host, next.authority);
    register(repeat, fixture.alpha, CONTENT['source:alpha'] as string, 'same-alpha');
    register(repeat, fixture.beta, CONTENT['source:beta'] as string, 'same-beta');
    open(repeat, goalFor(fixture, 'g-normalize-1', [fixture.alpha, fixture.beta]));
    await drive({ runtime: repeat, host: next.host });

    const added = normalizeInvocations(next.host);
    assert.equal(added, 0, 'a current read set reuses the cached conclusion and does not invoke the host again');
    assert.equal(citesConclusion(repeat), true, 'the trace cites the conclusion evidence');
  });

  it('M4-T03 a source revision keeps the short conclusion and does not return it as current', async () => {
    const fixture = world();
    fixture.host.noteAdmission(NORMALIZE_CONTRACT, 'direct', normalizeSource('direct'));
    open(fixture.runtime, goalFor(fixture, 'g-normalize-1', [fixture.alpha, fixture.beta]));
    await drive(fixture);
    const firstText = fixture.runtime.state().normalized[fixture.alpha]?.text;
    assert.equal(firstText, collapseWhitespace(CONTENT['source:alpha'] as string));
    assert.ok(firstText && Buffer.byteLength(firstText, 'utf8') <= 64);

    const written = fixture.host.tryWriteSource(fixture.alpha, SHORT_REVISION);
    assert.equal(written.ok, true);
    const changed: ObservationInput = {
      observation_id: 'test:source.changed:alpha:2',
      source: { kind: 'test', id: 'm4' },
      caused_by: null,
      payload_type: 'source.changed',
      payload_version: 1,
      payload: { resource: fixture.alpha, revision: 2, content: SHORT_REVISION },
    };
    fixture.runtime.observe(changed);

    const next = continuedHost(fixture);
    const repeat = repeatRuntime(next.host, next.authority);
    register(repeat, fixture.alpha, SHORT_REVISION, 'revised-alpha', 2);
    register(repeat, fixture.beta, CONTENT['source:beta'] as string, 'revised-beta');
    open(repeat, goalFor(fixture, 'g-normalize-1', [fixture.alpha, fixture.beta]));
    await drive({ runtime: repeat, host: next.host });

    assert.equal(repeat.state().normalized[fixture.alpha]?.text, collapseWhitespace(SHORT_REVISION));
    assert.notEqual(repeat.state().normalized[fixture.alpha]?.text, firstText);
    const retained = fixture.runtime.trace().observations.filter((observation) => {
      return observation.validation.status === 'accepted' && observation.payload_type.startsWith('conclusion.');
    });
    assert.ok(retained.length > 0, 'the old conclusion remains in the log after the source revision changes');
    assert.equal(JSON.stringify(retained).includes(firstText), true, 'the retained conclusion still holds the short output');
  });

  it('M4-T04 cross-goal reuse requires conclusion.policy', async () => {
    const fixture = world();
    fixture.host.noteAdmission(NORMALIZE_CONTRACT, 'direct', normalizeSource('direct'));
    open(fixture.runtime, goalFor(fixture, 'g-normalize-1', [fixture.alpha, fixture.beta]));
    await drive(fixture);

    const denied = continuedHost(fixture);
    const second = repeatRuntime(denied.host, denied.authority);
    register(second, fixture.alpha, CONTENT['source:alpha'] as string, 'goal2-alpha');
    register(second, fixture.beta, CONTENT['source:beta'] as string, 'goal2-beta');
    open(second, goalFor(fixture, 'g-normalize-2', [fixture.alpha, fixture.beta]));
    await drive({ runtime: second, host: denied.host });
    assert.ok(
      normalizeInvocations(denied.host) > 0,
      'registry presence of both goals does not permit reuse',
    );

    const allowed = continuedHost(fixture);
    const shared = repeatRuntime(allowed.host, allowed.authority);
    const policy = shared.operator.submit({
      observation_id: 'operator:conclusion.policy:share',
      caused_by: null,
      payload_type: 'conclusion.policy',
      payload_version: 1,
      payload: { policy_id: 'policy.conclusion.share@1', goals: ['g-normalize-1', 'g-normalize-2'] },
    });
    assert.equal(policy.validation.status, 'accepted', JSON.stringify(policy.validation));
    register(shared, fixture.alpha, CONTENT['source:alpha'] as string, 'shared-alpha');
    register(shared, fixture.beta, CONTENT['source:beta'] as string, 'shared-beta');
    open(shared, goalFor(fixture, 'g-normalize-2', [fixture.alpha, fixture.beta]));
    await drive({ runtime: shared, host: allowed.host });
    assert.equal(
      normalizeInvocations(allowed.host),
      0,
      'policy.conclusion.share@1 permits reuse without a second host invocation',
    );
  });

  it('M4-T05 a second admission keeps empty reliability and the host names who ran', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    host.noteAdmission(NORMALIZE_CONTRACT, 'direct', normalizeSource('direct'));
    host.noteAdmission(NORMALIZE_CONTRACT, 'aliased', normalizeSource('aliased'));
    const grant = authority.issue({
      action_id: 'a-select',
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
    host.release(handle.action_id);
    await handle.result;
    const kept = host.store.admitted().filter((admission) => admission.operation === 'text.normalize');
    assert.deepEqual(
      kept.map((admission) => admission.implementation_id),
      ['direct', 'aliased'],
      'the host retains every admitted implementation; empty reliability and cost do not replace the earlier one',
    );
    const record = host.store.getInvocation(handle.invocation_id) as { implementation_id?: string } | undefined;
    assert.equal(record?.implementation_id, 'direct', 'an omitted binding runs the earliest admitted implementation and records that id');
  });

  it('M4-T06 the baseline counts the failing goal before any M5 candidate', async () => {
    const fixture = world();
    fixture.host.noteAdmission(NORMALIZE_CONTRACT, 'direct', normalizeSource('direct'));
    const blank = fixture.host.registerSource('mem:blank', BLANK);
    tick(fixture.runtime, 1);
    open(fixture.runtime, goalFor(fixture, 'g-normalize-1', [fixture.alpha, fixture.beta]));
    await drive(fixture);
    assert.equal(fixture.runtime.state().goal?.status, 'complete');

    const repeated = continuedHost(fixture);
    const second = repeatRuntime(repeated.host, repeated.authority);
    tick(second, 2);
    register(second, fixture.alpha, CONTENT['source:alpha'] as string, 'base-alpha');
    register(second, fixture.beta, CONTENT['source:beta'] as string, 'base-beta');
    const shared = second.operator.submit({
      observation_id: 'operator:conclusion.policy:baseline',
      caused_by: null,
      payload_type: 'conclusion.policy',
      payload_version: 1,
      payload: { policy_id: 'policy.conclusion.share@1', goals: ['g-normalize-1', 'g-normalize-2'] },
    });
    assert.equal(shared.validation.status, 'accepted', JSON.stringify(shared.validation));
    open(second, goalFor(fixture, 'g-normalize-2', [fixture.alpha, fixture.beta]));
    await drive({ runtime: second, host: repeated.host });
    const repeatedNormalize = normalizeInvocations(repeated.host);
    assert.equal(second.state().goal?.status, 'complete');

    const missed = continuedHost(fixture);
    const failing = repeatRuntime(missed.host, missed.authority);
    tick(failing, 3);
    register(failing, blank, BLANK, 'blank');
    register(failing, fixture.beta, CONTENT['source:beta'] as string, 'blank-beta');
    open(failing, goalFor(fixture, 'g-normalize-blank', [blank, fixture.beta]));
    await drive({ runtime: failing, host: missed.host });
    tick(failing, 8);
    assert.notEqual(failing.state().goal?.status, 'complete');
    const failed = results(failing, 'text.normalize').find((result) => result.outcome.outcome === 'failed');
    assert.equal(failed?.outcome.outcome, 'failed');
    if (failed?.outcome.outcome === 'failed') {
      assert.equal(failed.outcome.failure, 'empty_output');
    }
    const rejected = failing.operator.submit({
      observation_id: 'operator:output.rejected:blank',
      caused_by: null,
      payload_type: 'output.rejected',
      payload_version: 1,
      payload: { action_id: started(failing, 'text.normalize')[0]?.action_id, reason: 'empty output on a non-empty source' },
    });

    const observations = [fixture.runtime, second, failing].flatMap((runtime) => runtime.trace().observations);
    const laterCandidate = observations.find((observation) => observation.payload_type.startsWith('experiment.') || JSON.stringify(observation.payload).includes('profile.frame.narrow@1'));
    const baseline = baselinePayload(observations);
    assert.ok(baseline, 'the baseline is recorded before any M5 candidate');
    assert.equal(laterCandidate, undefined);
    const body = JSON.stringify(baseline.quality);
    assert.equal(body.includes('g-normalize-blank'), true);
    assert.equal(body.includes('missed'), true);
    assert.equal(body.includes('held'), true);
    assert.equal(rejected.validation.status, 'accepted', JSON.stringify(rejected.validation));
    assert.equal(baseline.human_corrections, 1);
    assert.equal(repeatedNormalize, 0, 'the repeated goal reuses its conclusions');
    const inferenceMicros = observations
      .filter((observation) => observation.payload_type === 'inference.recorded' && observation.validation.status === 'accepted')
      .reduce((sum, observation) => sum + ((observation.payload as { spent?: number }).spent ?? 0), 0);
    assert.equal(
      baseline.cost_micros,
      (fixture.host.invocations.length + repeated.host.invocations.length + missed.host.invocations.length) * HOST_MICROS + inferenceMicros,
      'reuse adds neither a second 1000 host micros nor a second inference reservation',
    );
    assert.equal(typeof baseline.latency_ticks, 'number');
    assert.ok((baseline.latency_ticks as number) >= 0);
  });
});
