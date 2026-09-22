/**
 * M3 contract: text.normalize is a recorded composition
 * (docs/m3-fill-a-capability-gap.md). The procedure union does not grow an arm.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority, type CapabilityContract, type CapabilityLifecycle } from '@weave/agentsop';
import { AgentFabricHost, FabricLifecycle, FabricStore } from '@weave/agentfabric';
import {
  NORMALIZE_COMPOSITION,
  NORMALIZE_CONTRACT,
  RETAINED_NORMALIZE_PROCEDURE,
  ScriptedNormalizeAuthor,
  collapseWhitespace,
  normalizeSource,
  replay,
  type ActionResultPayload,
  type ActionStartedPayload,
  type ExtensionAuthor,
} from '@weave/weave';
import { FailingDecisionLayer } from './fixture.js';
import { CONTENT } from './fixture.js';
import { Runtime, ScriptedDecisionLayer, type Goal, type ObservationInput } from '@weave/weave';

const OVERSIZE = 'x'.repeat(80);

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

function world(options: { isolation?: 'enforcing' | 'unsupported'; lifecycle?: CapabilityLifecycle; author?: ExtensionAuthor; host?: AgentFabricHost } = {}): World {
  const authority = createGrantAuthority();
  const host = options.host ?? new AgentFabricHost({ authority });
  const lifecycle = (options.lifecycle as FabricLifecycle | undefined) ?? new FabricLifecycle(host, options.isolation ?? 'enforcing');
  const author = (options.author as ScriptedNormalizeAuthor | undefined) ?? new ScriptedNormalizeAuthor();
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
  for (const [handle, key] of [
    [alpha, 'source:alpha'],
    [beta, 'source:beta'],
    [gamma, 'source:gamma'],
  ] as const) {
    observe(built, {
      observation_id: `test:source.registered:${handle}`,
      source: { kind: 'test', id: 'm3-normalize' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: handle, revision: 1, content: CONTENT[key] },
    });
  }
  return built;
}

function observe(world: World, input: ObservationInput): void {
  world.runtime.observe(input);
}

function normalizeGoal(world: World, overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: 'g-normalize-1',
    purpose: 'Produce a checked report whose source text is normalized',
    sources: [world.alpha, world.beta],
    authority: { read: [world.alpha, world.beta] },
    composition: { ...NORMALIZE_COMPOSITION, variants: world.author.variants },
    retained_procedure: RETAINED_NORMALIZE_PROCEDURE,
    budget: { actions: 48, judgments: 48 },
    success_evidence: 'a report covering every goal source with whitespace collapsed and trimmed',
    ...overrides,
  };
}

function openGoal(world: World, overrides: Partial<Goal> = {}): void {
  const goal = normalizeGoal(world, overrides);
  world.runtime.operator.submit({
    observation_id: `operator:goal.opened:${goal.goal_id}`,
    caused_by: null,
    payload_type: 'goal.opened',
    payload_version: 1,
    payload: goal,
  });
}

function started(world: World, operation: string): ActionStartedPayload[] {
  return world.runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'action.started' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as ActionStartedPayload)
    .filter((payload) => payload.operation === operation);
}

function results(world: World, operation: string): ActionResultPayload[] {
  const ids = new Set(started(world, operation).map((payload) => payload.action_id));
  return world.runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'action.result' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as ActionResultPayload)
    .filter((payload) => ids.has(payload.action_id));
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function drive(world: World, until: 'complete' | 'green' | 'settled' = 'complete'): Promise<void> {
  for (let step = 0; step < 60; step += 1) {
    await flush(6);
    const state = world.runtime.state();
    if (until === 'complete' && state.goal?.status === 'complete') {
      return;
    }
    if (until === 'green' && state.crystallization.green.some((item) => item.proven)) {
      return;
    }
    if (until === 'complete' && state.crystallization.admission?.status === 'requested') {
      const admission = state.crystallization.admission;
      world.runtime.admitCapability({
        request_id: admission.request_id,
        implementation_id: admission.implementation_id,
        evidence_digest: admission.evidence_digest,
        approver: 'operator',
        authority_revision: 1,
      });
      continue;
    }
    const open = [...world.host.openActionIds()].sort();
    for (const action_id of open) {
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
    if (open.length === 0) {
      await flush(8);
      const after = world.runtime.state();
      const still = Object.values(after.actions).some((action) => action.state === 'running' || action.state === 'pending');
      if (!still && world.host.openActionIds().length === 0) {
        if (until === 'settled' || after.goal?.status === 'complete' || after.crystallization.admission?.status !== 'requested') {
          return;
        }
      }
    }
  }
  const stuck = world.runtime.state();
  const running = Object.values(stuck.actions)
    .filter((action) => action.state === 'running' || action.state === 'pending')
    .map((action) => `${action.operation}:${action.state}`);
  throw new Error(`drive stopped at ${stuck.goal?.status ?? 'no goal'}; running ${running.join(',') || 'none'}; search ${stuck.crystallization.search?.status ?? 'none'}`);
}

function selectedOperations(world: World, cycle: { candidates: readonly { candidate_id: string; operation: string }[]; selected: readonly { candidate_id: string }[] }): string[] {
  return cycle.selected.map((selected) => cycle.candidates.find((candidate) => candidate.candidate_id === selected.candidate_id)?.operation ?? '');
}

function seqOf(world: World, operation: string, type: 'action.started' | 'action.result'): number {
  const match = world.runtime.trace().observations.find((observation) => {
    if (observation.payload_type !== type || observation.validation.status !== 'accepted') {
      return false;
    }
    if (type === 'action.started') {
      return (observation.payload as ActionStartedPayload).operation === operation;
    }
    const result = observation.payload as ActionResultPayload;
    return started(world, operation).some((payload) => payload.action_id === result.action_id);
  });
  return match?.seq ?? 0;
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

describe('M3 text.normalize composition', () => {
  it('M3-T01 an admitted text.normalize is used under a separate grant and does not crystallize', async () => {
    const fixture = world();
    fixture.lifecycle.installEstablished(NORMALIZE_CONTRACT, normalizeSource('direct'));
    openGoal(fixture);
    await drive(fixture);
    const state = fixture.runtime.state();
    assert.equal(
      state.goal?.status,
      'complete',
      JSON.stringify({
        search: state.crystallization.search?.status ?? null,
        actions: Object.values(state.actions).map((action) => [action.operation, action.state]),
        normalized: state.normalized,
      }),
    );
    assert.equal(state.crystallization.search, null);
    assert.equal(started(fixture, 'contract.establish').length, 0);
    assert.equal(started(fixture, 'implementation.generate').length, 0);
    assert.equal(fixture.runtime.trace().cycles[0]?.procedure, 'inspect_and_report@1');
    const normalize = started(fixture, 'text.normalize');
    assert.equal(normalize.length, 2);
    assert.equal(normalize[0]?.grant?.operation, 'text.normalize');
    assert.equal(normalize[0]?.grant?.contract_rev, 'r1');
    for (const source of [fixture.alpha, fixture.beta]) {
      const content = fixture.host.content(source) as string;
      assert.equal(state.normalized[source]?.text, collapseWhitespace(content));
    }
  });

  it('M3-T02 a gap is recorded only after exact search, and the contract precedes every later artifact', async () => {
    const fixture = world();
    fixture.lifecycle.installEstablished(
      { ...NORMALIZE_CONTRACT, id: 'text.squash', purpose: 'Squash a text value differently' },
      normalizeSource('direct'),
    );
    openGoal(fixture);
    await drive(fixture);
    const search = results(fixture, 'gap.search')[0];
    assert.equal(search?.outcome.outcome, 'succeeded');
    const output = search?.outcome.outcome === 'succeeded' ? (search.outcome.output as { status: string; compositions: string[] }) : undefined;
    assert.equal(output?.status, 'gap');
    assert.deepEqual(output?.compositions, []);
    const contractSeq = fixture.runtime.trace().observations.find((observation) => observation.payload_type === 'action.result' && started(fixture, 'contract.establish').some((item) => item.action_id === (observation.payload as ActionResultPayload).action_id))?.seq;
    const later = started(fixture, 'corpus.propose').map((payload) => fixture.runtime.trace().observations.find((observation) => observation.payload_type === 'action.started' && (observation.payload as ActionStartedPayload).action_id === payload.action_id)?.seq);
    assert.ok(contractSeq);
    assert.ok(later.every((seq) => seq !== undefined && seq > contractSeq));
    assert.equal(fixture.runtime.state().goal?.status, 'complete');
    assert.equal(fixture.runtime.trace().cycles.every((cycle) => cycle.procedure !== 'crystallize_and_report@1'), true);
    const corpusCycle = fixture.runtime.trace().cycles.find((cycle) => selectedOperations(fixture, cycle).filter((operation) => operation === 'corpus.propose').length >= 2);
    const generateCycle = fixture.runtime.trace().cycles.find((cycle) => selectedOperations(fixture, cycle).filter((operation) => operation === 'implementation.generate').length >= 2);
    assert.ok(corpusCycle, 'visible and held-out corpus proposals share a cycle');
    assert.ok(generateCycle, 'implementation proposals share a later cycle');
  });

  it('M3-T06 a contract revision invalidates green evidence', async () => {
    const fixture = world();
    openGoal(fixture);
    await drive(fixture, 'green');
    const revised: CapabilityContract = {
      ...NORMALIZE_CONTRACT,
      revision: 'r2',
      purpose: 'Collapse whitespace in one text value under a new revision',
    };
    assert.equal(fixture.lifecycle.reviseContract(revised).ok, true);
    const proven = fixture.runtime.state().crystallization.green.find((item) => item.proven);
    assert.ok(proven);
    assert.equal(fixture.lifecycle.requestAdmission(proven.id).ok, false);
  });

  it('M3-T09 corpus proposals and implementation proposals each share a cycle, and generation before red is rejected', async () => {
    const fixture = world();
    const early = fixture.lifecycle.attachImplementation('direct', normalizeSource('direct'));
    assert.equal(early.ok, false);
    openGoal(fixture);
    await drive(fixture, 'green');
    const corpusCycle = fixture.runtime.trace().cycles.find((cycle) => selectedOperations(fixture, cycle).filter((operation) => operation === 'corpus.propose').length >= 2);
    const generateCycle = fixture.runtime.trace().cycles.find((cycle) => selectedOperations(fixture, cycle).filter((operation) => operation === 'implementation.generate').length >= 2);
    assert.ok(corpusCycle);
    assert.ok(generateCycle);
    const redSeq = seqOf(fixture, 'red.demonstrate', 'action.result');
    const generateSeq = seqOf(fixture, 'implementation.generate', 'action.started');
    assert.ok(redSeq > 0 && generateSeq > redSeq);
  });

  it('M3-T03 a contradictory corpus is rejected and red is recorded before implementation generation', async () => {
    const host = new AgentFabricHost({ authority: createGrantAuthority() });
    const lifecycle = new FabricLifecycle(host);
    lifecycle.searchExact(
      { operation: 'text.normalize', purpose: NORMALIZE_CONTRACT.purpose, input: NORMALIZE_CONTRACT.input, output: NORMALIZE_CONTRACT.output },
      null,
    );
    assert.equal(lifecycle.proposeContract(NORMALIZE_CONTRACT).ok, true);
    const contradictory = lifecycle.submitCases('visible', [
      { id: 'a', split: 'visible', input: { text: 'a  b' }, expected: { kind: 'output', output: { text: 'a b' } } },
      { id: 'b', split: 'visible', input: { text: 'a  b' }, expected: { kind: 'output', output: { text: 'ab' } } },
    ]);
    assert.equal(contradictory.ok, false);
    const early = lifecycle.attachImplementation('direct', normalizeSource('direct'));
    assert.equal(early.ok, false);

    const fixture = world();
    openGoal(fixture);
    await drive(fixture);
    const redSeq = fixture.runtime.trace().observations.find((observation) => observation.payload_type === 'action.result' && started(fixture, 'red.demonstrate').some((item) => item.action_id === (observation.payload as ActionResultPayload).action_id))?.seq;
    const generateSeqs = started(fixture, 'implementation.generate').map((payload) => fixture.runtime.trace().observations.find((observation) => observation.payload_type === 'action.started' && (observation.payload as ActionStartedPayload).action_id === payload.action_id)?.seq);
    assert.ok(redSeq);
    assert.ok(generateSeqs.every((seq) => seq !== undefined && seq > redSeq));
  });

  it('M3-T04 a supplied function is never called, and missing isolation does not run generated code', async () => {
    const host = new AgentFabricHost({ authority: createGrantAuthority() });
    let calls = 0;
    const registered = host.registerImplementation('text.normalize', () => {
      calls += 1;
      return { outcome: 'succeeded', output: { text: 'x' } };
    });
    assert.equal(registered.admitted, false);
    assert.equal(calls, 0);
    assert.equal(host.resolution('text.normalize'), 'unresolved');

    const blocked = world({ isolation: 'unsupported' });
    openGoal(blocked);
    await drive(blocked, 'settled');
    assert.equal(blocked.lifecycle.audit().execute_runs, 0);
    assert.notEqual(blocked.runtime.state().goal?.status, 'complete');

    const fixture = world();
    openGoal(fixture);
    await drive(fixture, 'green');
    const red = results(fixture, 'red.demonstrate')[0];
    const isolation = red?.outcome.outcome === 'succeeded' ? (red.outcome.output as { isolation: { network: string; host_process: string; filesystem: string; held_out_mounted: boolean; broker: string } }).isolation : undefined;
    assert.equal(isolation?.network, 'none');
    assert.equal(isolation?.filesystem, 'blocked');
    assert.equal(isolation?.held_out_mounted, false);
    assert.equal(isolation?.host_process, 'unreachable');
    assert.equal(isolation?.broker, 'resolver-context');
    assert.ok(fixture.lifecycle.audit().execute_runs > 0);
  });

  it('M3-T05 the second held-out report spends the split and cannot support admission', async () => {
    const fixture = world();
    openGoal(fixture);
    await drive(fixture, 'green');
    const first = fixture.lifecycle.heldOutReport('direct');
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.deepEqual(Object.keys(first.output).sort(), ['codes', 'failed', 'passed']);
      assert.ok(Array.isArray(first.output['codes']));
      assert.equal(JSON.stringify(first.output).includes('held-tab'), false);
    }
    const second = fixture.lifecycle.heldOutReport('direct');
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.output['refused'], true);
      assert.equal(second.output['admission'], false);
      assert.equal('evidence_digest' in second.output, false);
    }
    const late = fixture.lifecycle.attachImplementation('late', normalizeSource('direct'));
    assert.equal(late.ok, false);
  });

  it('M3-T07 admission does not carry a grant, and revocation does not open a second gap', async () => {
    const fixture = world();
    openGoal(fixture);
    await drive(fixture);
    const decided = fixture.runtime.trace().observations.find((observation) => observation.payload_type === 'admission.decided');
    assert.ok(decided);
    assert.equal(JSON.stringify(decided?.payload).includes('grant'), false);
    const normalize = started(fixture, 'text.normalize')[0];
    assert.ok(normalize?.grant);
    const admission = fixture.runtime.state().crystallization.admission;
    assert.ok(admission);
    fixture.runtime.revokeCapability('text.normalize', admission.implementation_id, 'operator revoked normalize');
    assert.equal(fixture.host.resolution('text.normalize'), 'unavailable');
    assert.equal(fixture.host.historicalContract('text.normalize')?.id, 'text.normalize');
    assert.equal(started(fixture, 'gap.search').length, 1);
  });

  it('M3-T08 retained procedure text is not an implementation', async () => {
    const fixture = world();
    openGoal(fixture);
    await drive(fixture, 'settled');
    const beforeRed = fixture.runtime.trace().observations.findIndex((observation) => observation.payload_type === 'action.started' && (observation.payload as ActionStartedPayload).operation === 'red.demonstrate');
    assert.ok(beforeRed > 0);
    assert.equal(fixture.runtime.state().goal?.retained_procedure, RETAINED_NORMALIZE_PROCEDURE);
    assert.equal(fixture.host.invocations.some((invocation) => invocation.operation === 'text.normalize'), false);
    assert.notEqual(fixture.host.resolution('text.normalize'), 'resolved');
  });

  it('M3-T10 replay does not run generated code or the host', async () => {
    const fixture = world();
    openGoal(fixture);
    await drive(fixture);
    const runs = fixture.lifecycle.audit().execute_runs;
    const calls = fixture.author.calls.length;
    const recorded = fixture.runtime.trace().observations;
    const host = new AgentFabricHost({ authority: createGrantAuthority() });
    const result = replay(recorded, {
      host,
      decisionLayer: new FailingDecisionLayer(),
      lifecycle: throwingLifecycle(),
      author: { implementation: 'nope', variants: [], proposeContract: () => { throw new Error('author'); }, proposeCases: () => { throw new Error('author'); }, proposeImplementation: () => { throw new Error('author'); } },
    });
    assert.equal(result.ok, true, result.ok ? '' : result.failure.reason);
    assert.equal(result.state.goal?.status, 'complete');
    assert.equal(host.invocations.length, 0);
    assert.equal(fixture.lifecycle.audit().execute_runs, runs);
    assert.equal(fixture.author.calls.length, calls);
  });

  it('M3-T11 null, empty, and mid-value outputs are failed', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const cases: { source: string; text: string; failure: string }[] = [
      { source: 'return null;', text: 'hello', failure: 'empty_output' },
      { source: 'return { text: "" };', text: 'hello', failure: 'empty_output' },
      { source: 'return { text: "a\\uD800" };', text: 'hello', failure: 'mid_value' },
    ];
    for (const [index, item] of cases.entries()) {
      host.noteAdmission(NORMALIZE_CONTRACT, `bad-${index}`, item.source);
      const grant = authority.issue({
        action_id: `a-bad-${index}`,
        operation: 'text.normalize',
        contract_rev: 'r1',
        permissions: [],
        effects: [],
        issued_at: index + 1,
      });
      const handle = host.invoke(grant, 'text.normalize', { text: item.text });
      assert.equal(handle.kind, 'handle');
      if (handle.kind !== 'handle') {
        continue;
      }
      host.release(handle.action_id);
      const outcome = await handle.result;
      assert.equal(outcome.outcome, 'failed');
      if (outcome.outcome === 'failed') {
        assert.equal(outcome.failure, item.failure);
      }
      assert.equal(JSON.stringify(outcome).includes('hello'), false);
    }
  });

  it('M3-T12 an oversize output is refused and the raw bytes stay out of the log', async () => {
    const fixture = world();
    fixture.host.noteAdmission(NORMALIZE_CONTRACT, 'wide', `return { text: "${OVERSIZE}" };`);
    openGoal(fixture);
    await drive(fixture, 'settled');
    const outcome = results(fixture, 'text.normalize')[0]?.outcome;
    assert.equal(outcome?.outcome, 'failed');
    if (outcome?.outcome === 'failed') {
      assert.equal(outcome.failure, 'budget');
    }
    assert.equal(JSON.stringify(fixture.runtime.trace()).includes(OVERSIZE), false);
    const replayed = replay(fixture.runtime.trace().observations, {
      host: new AgentFabricHost({ authority: createGrantAuthority() }),
      decisionLayer: new FailingDecisionLayer(),
      lifecycle: throwingLifecycle(),
      author: { implementation: 'nope', variants: [], proposeContract: () => { throw new Error('author'); }, proposeCases: () => { throw new Error('author'); }, proposeImplementation: () => { throw new Error('author'); } },
    });
    assert.equal(replayed.ok, true, replayed.ok ? '' : replayed.failure.reason);
  });

  it('M3-T13 the broker has no sleep, and a child that ends without a result settles', async () => {
    const fixture = world();
    const slept = await fixture.lifecycle.runner.runCases('return broker.sleep();', [{ id: 'sleep', input: { text: 'a' } }]);
    assert.equal(typeof slept[0]?.error, 'string');
    const report = fixture.lifecycle.runner.currentReport();
    assert.equal(report?.host_process, 'unreachable');
    const ended = await fixture.lifecycle.runner.endedWithoutResult();
    assert.equal(ended.ok, false);
    assert.equal(typeof ended.failure, 'string');
  });

  it('M3-T14 restart follows the host store and does not crystallize again', async () => {
    const fixture = world();
    openGoal(fixture);
    await drive(fixture);
    const snapshot = fixture.host.store.snapshot();
    const authority = createGrantAuthority();
    const restored = new AgentFabricHost({ authority, store: FabricStore.restore(snapshot) });
    assert.equal(restored.resolution('text.normalize'), 'resolved');
    const runtime = new Runtime({
      host: restored,
      decisionLayer: new ScriptedDecisionLayer(),
      grantAuthority: authority,
      lifecycle: throwingLifecycle(),
      author: { implementation: 'nope', variants: [], proposeContract: () => { throw new Error('author'); }, proposeCases: () => { throw new Error('author'); }, proposeImplementation: () => { throw new Error('author'); } },
    });
    const alpha = fixture.alpha;
    const beta = fixture.beta;
    runtime.observe({
      observation_id: 'test:source.registered:restored-alpha',
      source: { kind: 'test', id: 'm3-normalize' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: alpha, revision: 1, content: CONTENT['source:alpha'] },
    });
    runtime.observe({
      observation_id: 'test:source.registered:restored-beta',
      source: { kind: 'test', id: 'm3-normalize' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: beta, revision: 1, content: CONTENT['source:beta'] },
    });
    const goal = normalizeGoal(fixture, { goal_id: 'g-normalize-2' });
    runtime.operator.submit({
      observation_id: 'operator:goal.opened:g-normalize-2',
      caused_by: null,
      payload_type: 'goal.opened',
      payload_version: 1,
      payload: goal,
    });
    const restarted: World = { ...fixture, authority, host: restored, runtime, lifecycle: fixture.lifecycle };
    await drive(restarted);
    assert.equal(runtime.state().goal?.status, 'complete');
    assert.equal(runtime.trace().observations.some((observation) => observation.payload_type === 'action.started' && (observation.payload as ActionStartedPayload).operation === 'gap.search'), false);
    assert.ok(restored.invocations.some((invocation) => invocation.operation === 'text.normalize'));
  });
});
