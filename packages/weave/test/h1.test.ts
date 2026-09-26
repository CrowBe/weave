/**
 * H1 bounds the observation log (docs/h1-bound-the-log.md).
 * Oversize payloads are rejected before they are durable. Recovery does not
 * dispatch a candidate whose identical failure is already recorded.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, FabricStore } from '@weave/agentfabric';
import {
  MemoryJournal,
  Runtime,
  ScriptedDecisionLayer,
  TraceRetention,
  recover,
  replay,
} from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import { ALPHA, FailingDecisionLayer, baseGoal, changed, goalOpened, registered, release, tick } from './fixture.js';

const MARKER = 'OVERSIZE-MARKER';

function runtimeWith(options: { journal?: MemoryJournal; logBound?: { max_observation_bytes: number }; traceRetention?: TraceRetention } = {}) {
  const environment = new FixtureEnvironment();
  const host = new FakeHost(environment);
  const journal = options.journal ?? new MemoryJournal();
  const runtime = new Runtime({
    host,
    decisionLayer: new ScriptedDecisionLayer(),
    journal,
    ...(options.logBound ? { logBound: options.logBound } : {}),
    ...(options.traceRetention ? { traceRetention: options.traceRetention } : {}),
  });
  return { environment, host, journal, runtime };
}

describe('H1 bound the log', () => {
  it('H1-T01 rejects an oversize observation before it is durable', () => {
    const journal = new MemoryJournal();
    const { runtime } = runtimeWith({ journal, logBound: { max_observation_bytes: 64 } });
    const rejected = runtime.observe({
      ...registered(ALPHA, MARKER.repeat(8)),
    });
    assert.equal(rejected.validation.status, 'rejected');
    if (rejected.validation.status === 'rejected') {
      assert.equal(rejected.validation.reason, 'budget');
    }
    assert.equal(runtime.state().sources[ALPHA], undefined);
    assert.equal(JSON.stringify(runtime.trace()).includes(MARKER), false);
    assert.equal(JSON.stringify(journal.snapshot()).includes(MARKER), false);
    assert.equal(runtime.diagnosticRejections().length, 1);
    const replayed = replay(runtime.trace().observations, {
      host: new FakeHost(new FixtureEnvironment()),
      decisionLayer: new FailingDecisionLayer(),
    });
    assert.equal(replayed.ok, true);
    if (replayed.ok) {
      assert.equal(JSON.stringify(replayed.trace).includes(MARKER), false);
    }
    const restored = recover(journal.snapshot(), {
      host: new FakeHost(new FixtureEnvironment()),
      decisionLayer: new ScriptedDecisionLayer(),
    });
    assert.equal(JSON.stringify(restored.trace()).includes(MARKER), false);
    assert.equal(restored.state().sources[ALPHA], undefined);
  });

  it('H1-T01 rejects an oversize mid-value or duplicate as budget', () => {
    const { runtime } = runtimeWith({ logBound: { max_observation_bytes: 64 } });
    const cut = runtime.observe(registered(ALPHA, `${MARKER.repeat(8)}\uD800`));
    assert.equal(cut.validation.status, 'rejected');
    if (cut.validation.status === 'rejected') {
      assert.equal(cut.validation.reason, 'budget');
    }
    assert.equal(JSON.stringify(runtime.trace()).includes(MARKER), false);
    assert.equal(JSON.stringify(cut.payload).includes(MARKER), false);

    const { runtime: again } = runtimeWith({ logBound: { max_observation_bytes: 64 } });
    const first = again.observe(registered(ALPHA, 'alpha one'));
    assert.equal(first.validation.status, 'accepted');
    const reused = again.observe({
      ...registered(ALPHA, MARKER.repeat(8)),
      observation_id: first.observation_id,
    });
    assert.equal(reused.validation.status, 'rejected');
    if (reused.validation.status === 'rejected') {
      assert.equal(reused.validation.reason, 'budget');
    }
    assert.equal(JSON.stringify(again.trace()).includes(MARKER), false);
    assert.equal(JSON.stringify(reused.payload).includes(MARKER), false);
    assert.equal(again.diagnosticRejections().length, 1);
  });

  it('H1-T02 rejects a payload cut mid-value', () => {
    const { runtime } = runtimeWith();
    const rejected = runtime.observe(registered(ALPHA, 'cut\uD800'));
    assert.equal(rejected.validation.status, 'rejected');
    if (rejected.validation.status === 'rejected') {
      assert.equal(rejected.validation.reason, 'mid_value');
    }
    assert.equal(runtime.state().sources[ALPHA], undefined);
    const stored = runtime.trace().observations.find((observation) => observation.observation_id === rejected.observation_id);
    assert.equal(stored?.validation.status, 'rejected');
  });

  it('H1-T03 does not dispatch a candidate that already failed', async () => {
    const { host, journal, runtime } = runtimeWith();
    runtime.observe(registered(ALPHA, 'alpha one'));
    runtime.operator.submit(goalOpened(baseGoal({ sources: [ALPHA], authority: { read: [ALPHA] }, budget: { actions: 4, judgments: 2, recovery: 2 } })));
    const first = Object.values(runtime.state().actions).find((action) => action.operation === 'source.inspect');
    assert.ok(first);
    await release({ host, runtime } as Parameters<typeof release>[0], first.action_id);
    assert.equal(runtime.state().actions[first.action_id]?.state, 'failed');
    assert.equal(runtime.state().actions[first.action_id]?.failure, 'not_found');
    runtime.clock.submit(tick(1));
    const starts = runtime
      .trace()
      .observations.filter(
        (observation) =>
          observation.payload_type === 'action.started' &&
          (observation.payload as { operation: string }).operation === 'source.inspect',
      );
    assert.equal(starts.length, 1);
    const restored = recover(journal.snapshot(), {
      host: new FakeHost(new FixtureEnvironment()),
      decisionLayer: new ScriptedDecisionLayer(),
      journal: new MemoryJournal(),
    });
    restored.clock.submit(tick(2));
    const restoredStarts = restored
      .trace()
      .observations.filter(
        (observation) =>
          observation.payload_type === 'action.started' &&
          (observation.payload as { operation: string }).operation === 'source.inspect',
      );
    assert.equal(restoredStarts.length, 1);
    assert.equal(restored.state().recovery.spent, 0);
  });

  it('H1-T04 rejects a reused observation id and keeps a distinct one', () => {
    const { runtime, journal } = runtimeWith();
    const first = runtime.observe(registered(ALPHA, 'alpha one'));
    assert.equal(first.validation.status, 'accepted');
    const reused = runtime.observe(registered(ALPHA, 'alpha two'));
    assert.equal(reused.validation.status, 'rejected');
    if (reused.validation.status === 'rejected') {
      assert.equal(reused.validation.reason, 'duplicate');
    }
    const distinct = runtime.observe({
      ...changed(ALPHA, 2, 'alpha three'),
      observation_id: `${first.observation_id}x`,
    });
    assert.equal(distinct.validation.status, 'accepted');
    const copies = runtime.trace().observations.filter((observation) => observation.observation_id === first.observation_id);
    assert.equal(copies.length, 2);
    const rejectedCopy = copies.find((observation) => observation.validation.status === 'rejected');
    assert.equal(rejectedCopy?.validation.status, 'rejected');
    if (rejectedCopy?.validation.status === 'rejected') {
      assert.equal(rejectedCopy.validation.reason, 'duplicate');
    }
    assert.ok(runtime.trace().observations.some((observation) => observation.observation_id === distinct.observation_id));
    const durable = journal.snapshot();
    assert.equal(durable.filter((observation) => observation.observation_id === first.observation_id).length, 1);
    assert.equal(durable.some((observation) => observation.observation_id === distinct.observation_id), true);
    assert.equal(JSON.stringify(durable).includes('alpha two'), false);
  });

  it('H1-T05 refuses a second runtime on the same host store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-h1-'));
    const path = join(dir, 'fabric.json');
    const authority = createGrantAuthority();
    const store = FabricStore.open(path);
    const host = new AgentFabricHost({ authority, store });
    const source = host.registerSource('mem:alpha', 'alpha one');
    assert.throws(() => FabricStore.open(path), /already open/);
    assert.equal(host.canonicalResource(source).length > 0, true);
    const again = new AgentFabricHost({ authority: createGrantAuthority(), store });
    assert.equal(again.canonicalResource(source).length > 0, true);
    store.close();
    const restarted = FabricStore.open(path);
    assert.equal(restarted.snapshot().resources.length > 0, true);
    restarted.close();
  });

  it('H1-T06 evicts trace records outside the state-transition lock', async () => {
    const retention = new TraceRetention(24);
    retention.retain('attempt-1', 'token '.repeat(20), false);
    retention.retain('attempt-2', 'token '.repeat(20), false);
    retention.retain('attempt-3', 'token '.repeat(20), false);
    assert.equal(retention.records.length, 1);
    assert.equal(retention.records[0]?.attempt_id, 'attempt-3');
    assert.equal(retention.omissions, 2);
    assert.equal(retention.evictionUnderLock, false);

    const runtimeRetention = new TraceRetention(10_000);
    const { host, runtime } = runtimeWith({ traceRetention: runtimeRetention });
    const before = runtime.trace().observations.length;
    runtime.observe(registered(ALPHA, 'alpha one'));
    runtime.operator.submit(goalOpened(baseGoal({ sources: [ALPHA], authority: { read: [ALPHA] } })));
    const action = Object.values(runtime.state().actions).find((item) => item.operation === 'source.inspect');
    assert.ok(action);
    await release({ host, runtime } as Parameters<typeof release>[0], action.action_id);
    assert.equal(runtimeRetention.evictionUnderLock, false);
    assert.equal(runtimeRetention.records.length, 1);
    assert.equal(runtimeRetention.records[0]?.attempt_id.startsWith('result:'), true);
    assert.ok(runtime.trace().observations.length > before);
    assert.equal(runtime.trace().observations.some((observation) => observation.payload_type === 'action.result'), true);
  });
});
