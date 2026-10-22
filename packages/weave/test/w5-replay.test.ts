/**
 * W5 acceptance 3 (#187): crash and replay. replay() and recover() produce the
 * same state with or without a sink. Replay suppresses emission
 * (WEFT-CONTRACT.md, Emission: Replay); recovery emits only for observations
 * appended after the journal is loaded.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, type FabricSnapshot } from '@weave/agentfabric';
import { createInferenceGateway } from '@weave/gateway';
import {
  GatewayDecisionLayer,
  LOCAL_DESTINATION,
  MemoryJournal,
  recover,
  replay,
  stableStringify,
  type Observation,
  type RuntimeOptions,
} from '@weave/weave';
import { collector, flakyWeigher, port, runW5, settleAsync, w5World, WEIGH_UNIT, type Rec, type W5Sinks } from './w5-fixture.js';

/** A fresh stack for replay or recovery, optionally with sinks; `snapshot` restores the host store. */
function stack(sinks: W5Sinks, snapshot?: FabricSnapshot): RuntimeOptions & { readonly host: AgentFabricHost; readonly weigher: ReturnType<typeof flakyWeigher> } {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({
    authority,
    ...(snapshot ? { store: FabricStore.restore(snapshot) } : {}),
    ...(sinks.fabric ? { weft: port('fabric.host.2', sinks.fabric) } : {}),
  });
  const weigher = flakyWeigher();
  const gateway = createInferenceGateway({
    routes: [WEIGH_UNIT],
    evaluators: [weigher],
    clock: { now: () => 0 },
    ...(sinks.gateway ? { weft: port('gateway.2', sinks.gateway) } : {}),
  });
  return {
    host,
    weigher,
    decisionLayer: new GatewayDecisionLayer(gateway, [LOCAL_DESTINATION]),
    grantAuthority: authority,
    executionSlots: 2,
    ...(sinks.loom ? { weft: port('loom.main', sinks.loom) } : {}),
  };
}

async function completedLog(): Promise<readonly Observation[]> {
  const world = w5World();
  await runW5(world);
  return world.runtime.trace().observations;
}

function seqOf(record: Rec): number[] {
  return record.evidence.filter((e) => e.source === 'observation').map((e) => Number(e.ref.slice('seq:'.length)));
}

describe('W5 crash and replay', () => {
  it('W5-T20 replay() yields the same result with or without a sink', async () => {
    const recorded = await completedLog();
    const plain = replay(recorded, stack({}));
    const loom = collector();
    const gateway = collector();
    const fabric = collector();
    const observed = stack({ loom: loom.sink, gateway: gateway.sink, fabric: fabric.sink });
    const traced = replay(recorded, observed);
    assert.equal(plain.ok, true, plain.ok ? '' : plain.failure.reason);
    assert.equal(traced.ok, true, traced.ok ? '' : traced.failure.reason);
    assert.equal(stableStringify(traced.state), stableStringify(plain.state));
    assert.equal(stableStringify(traced.trace), stableStringify(plain.trace));
    assert.equal(observed.host.invocations.length, 0);
    assert.equal(observed.weigher.calls.length, 0);
  });

  it('W5-T21 replay suppresses emission: no emitter calls its port, even with one configured', async () => {
    const recorded = await completedLog();
    const loom = collector();
    const gateway = collector();
    const fabric = collector();
    const result = replay(recorded, stack({ loom: loom.sink, gateway: gateway.sink, fabric: fabric.sink }));
    assert.equal(result.ok, true);
    assert.deepEqual(loom.records, [], 'Loom emitted during replay');
    assert.deepEqual(gateway.records, []);
    assert.deepEqual(fabric.records, []);
  });

  it('W5-T22 a replay that fails closed emits nothing either', async () => {
    const recorded = await completedLog();
    const lastResult = [...recorded].reverse().find((o) => o.payload_type === 'action.result')!;
    const loom = collector();
    const result = replay(recorded.filter((o) => o.seq !== lastResult.seq), stack({ loom: loom.sink }));
    assert.equal(result.ok, false);
    assert.deepEqual(loom.records, []);
  });

  it('W5-T23 recover() after a crash yields the same state with or without a sink, and emits only for new observations', async () => {
    const live = collector();
    const journal = new MemoryJournal();
    const world = w5World({ loom: live.sink }, { journal });
    await settleAsync(world);
    // Crash with two inspections running and one queued.
    const running = Object.values(world.runtime.state().actions).filter((a) => a.state === 'running');
    assert.equal(running.length, 2);
    const journaled = journal.snapshot();
    const snapshot = world.host.snapshot();
    const loadedHigh = Math.max(...journaled.map((o) => o.seq));
    const liveHigh = Math.max(...live.records.map((r) => r.sequence));

    const plainStack = stack({}, snapshot);
    const plain = recover(journaled, plainStack);
    await settleAsync({ runtime: plain } as Parameters<typeof settleAsync>[0]);

    const after = collector();
    const fabric = collector();
    const tracedStack = stack({ loom: after.sink, fabric: fabric.sink }, snapshot);
    const traced = recover(journaled, tracedStack);
    await settleAsync({ runtime: traced } as Parameters<typeof settleAsync>[0]);

    assert.equal(stableStringify(traced.state()), stableStringify(plain.state()));
    assert.equal(stableStringify(traced.trace()), stableStringify(plain.trace()));
    assert.equal(stableStringify(tracedStack.host.snapshot()), stableStringify(plainStack.host.snapshot()));

    assert.ok(after.records.length > 0, 'recovery appended observations but emitted nothing');
    for (const record of after.records) {
      assert.ok(record.sequence > liveHigh, `${record.record_id} sequence ${record.sequence} does not continue past ${liveHigh}`);
      for (const seq of seqOf(record)) {
        assert.ok(seq > loadedHigh, `${record.record_id} re-reports loaded observation ${seq}`);
      }
    }
    // An identity emitted before the crash is never re-used for a different record.
    const before = new Map(live.records.map((r) => [r.record_id, stableStringify(r)]));
    for (const record of after.records) {
      const prior = before.get(record.record_id);
      assert.ok(prior === undefined || prior === stableStringify(record), `conflicting record ${record.record_id}`);
    }
    // Restored admissions are not reported again.
    assert.equal(fabric.records.some((r) => r.fields['event'] === 'admitted'), false);
  });
});
