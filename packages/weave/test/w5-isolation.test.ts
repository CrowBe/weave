/**
 * W5 acceptance 2 (#187): emitting never changes state or scheduling. Every
 * run below is compared with the same run composed with no sink at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stableStringify, type ObservationInput } from '@weave/weave';
import {
  collector,
  fingerprint,
  runW5,
  settleAsync,
  w5World,
  type Rec,
  type Sink,
  type W5Sinks,
  type W5World,
} from './w5-fixture.js';

interface RunPrint {
  readonly state: string;
  readonly trace: string;
  readonly invocations: string;
  readonly weighCalls: number;
  readonly fabric: string;
  readonly run: string;
}

async function runPrint(sinks: W5Sinks): Promise<RunPrint> {
  const world: W5World = w5World(sinks);
  const run = await runW5(world);
  return {
    ...fingerprint(world),
    invocations: stableStringify(world.host.invocations),
    weighCalls: world.weigher.calls.length,
    fabric: stableStringify(world.host.snapshot()),
    run: stableStringify(run),
  };
}

function everywhere(sink: Sink): W5Sinks {
  return { loom: sink, gateway: sink, fabric: sink };
}

let baseline: Promise<RunPrint> | null = null;
function unobserved(): Promise<RunPrint> {
  baseline ??= runPrint({});
  return baseline;
}

async function assertUnchanged(sinks: W5Sinks): Promise<void> {
  const expected = await unobserved();
  const actual = await runPrint(sinks);
  assert.equal(actual.state, expected.state, 'state differs');
  assert.equal(actual.trace, expected.trace, 'Loom trace (observations and cycles) differs');
  assert.equal(actual.invocations, expected.invocations, 'host invocations differ');
  assert.equal(actual.weighCalls, expected.weighCalls, 'provider calls differ');
  assert.equal(actual.fabric, expected.fabric, 'host store differs');
  assert.equal(actual.run, expected.run);
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('W5 emission is one-way', () => {
  it('W5-T10 no sink is the default and the reference for every comparison', async () => {
    const first = await unobserved();
    const again = await runPrint({});
    assert.deepEqual(again, first);
  });

  it('W5-T11 a sink that collects everything changes nothing', async () => {
    const seen = collector();
    await assertUnchanged(everywhere(seen.sink));
    assert.ok(seen.records.length > 0);
  });

  it('W5-T12 a sink that throws on every record changes nothing', async () => {
    let calls = 0;
    await assertUnchanged(
      everywhere(() => {
        calls += 1;
        throw new Error('sink down');
      }),
    );
    assert.ok(calls > 0);
  });

  it('W5-T13 a sink that throws only on some kinds changes nothing', async () => {
    await assertUnchanged(
      everywhere((record) => {
        if (
          record.kind === 'thread.transition' ||
          record.kind === 'inference.attempt' ||
          record.kind === 'capability.invoked'
        ) {
          throw new TypeError('unsupported kind');
        }
      }),
    );
  });

  it('W5-T14 a slow synchronous sink changes nothing', async () => {
    await assertUnchanged(
      everywhere(() => {
        let spin = 0;
        for (let i = 0; i < 20_000; i += 1) {
          spin += i % 7;
        }
        return spin;
      }),
    );
  });

  it('W5-T15 an async sink that never settles changes nothing and is never awaited', async () => {
    let pending = 0;
    await assertUnchanged(
      everywhere(() => {
        pending += 1;
        return new Promise<never>(() => {});
      }),
    );
    assert.ok(pending > 0);
  });

  it('W5-T16 an async sink that settles late, or rejects, changes nothing and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await assertUnchanged(everywhere(() => new Promise((resolve) => setTimeout(resolve, 5))));
      await assertUnchanged(everywhere(() => Promise.reject(new Error('sink rejected'))));
      // A thenable whose then() itself throws.
      await assertUnchanged(
        everywhere(() => ({
          then(): never {
            throw new Error('broken thenable');
          },
        })),
      );
      await macrotask();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  it('W5-T17 a sink that mutates every record it receives, now and later, changes nothing', async () => {
    const kept: Rec[] = [];
    const vandal = (value: unknown, depth = 0): void => {
      if (value === null || typeof value !== 'object' || depth > 6) {
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) vandal(item, depth + 1);
        value.push({ rel: 'caused_by', record_id: 'forged' });
        return;
      }
      for (const key of Object.keys(value)) {
        const inner = (value as Record<string, unknown>)[key];
        vandal(inner, depth + 1);
        if (typeof inner !== 'object' || inner === null) {
          (value as Record<string, unknown>)[key] = 'tampered';
        }
      }
      (value as Record<string, unknown>)['injected'] = { grant: 'forged' };
    };
    const expected = await unobserved();
    const world = w5World(
      everywhere((record) => {
        kept.push(record);
        vandal(record);
      }),
    );
    const run = await runW5(world);
    // Later mutation of everything the sink kept.
    for (const record of kept) vandal(record);
    assert.equal(fingerprint(world).state, expected.state);
    assert.equal(fingerprint(world).trace, expected.trace);
    assert.equal(stableStringify(world.host.invocations), expected.invocations);
    assert.equal(stableStringify(world.host.snapshot()), expected.fabric);
    assert.equal(stableStringify(run), expected.run);
  });

  it('W5-T18 records stay intact for a well-behaved sink when another emitter shares it with a vandal', async () => {
    // Emitters build each record afresh: a vandal on one emitter cannot reach another's records.
    const clean = collector();
    const reference = collector();
    await runW5(w5World(everywhere(reference.sink)));
    await runW5(
      w5World({
        loom: clean.sink,
        gateway: (record) => {
          (record.fields as Record<string, unknown>)['request_ref'] = 'tampered';
        },
        fabric: (record) => {
          (record.links as unknown[]).push('x');
        },
      }),
    );
    const loomOnly = reference.records.filter((r) => r.emitter.kind === 'loom');
    assert.equal(stableStringify(clean.records), stableStringify(loomOnly));
  });
  it('W5-T19 a sink that calls back into the Runtime is served after the transition, never inside it', async () => {
    const changed = (world: W5World): ObservationInput => ({
      observation_id: 'test:source.changed:beta',
      source: { kind: 'test', id: 'w5-reentrant' },
      caused_by: null,
      payload_type: 'source.changed',
      payload_version: 1,
      payload: { resource: world.beta, revision: 2, content: 'beta changed' },
    });
    const tick = {
      observation_id: 'clock:tick:reentrant',
      caused_by: null,
      payload_type: 'clock.tick',
      payload_version: 1,
      payload: { tick: 7 },
    } as const;
    const firstRunning = (world: W5World): string =>
      Object.values(world.runtime.state().actions)
        .filter((a) => a.state === 'running')
        .map((a) => a.action_id)
        .sort()[0] as string;
    const print = (world: W5World) => ({
      ...fingerprint(world),
      invocations: stableStringify(world.host.invocations),
      fabric: stableStringify(world.host.snapshot()),
    });

    // Reference: the same calls, made once the action's result has been recorded.
    const reference = w5World({ loom: () => {} });
    await settleAsync(reference);
    const referenceId = firstRunning(reference);
    reference.host.release(referenceId);
    await reference.runtime.settle(referenceId);
    const afterTransition = stableStringify(reference.runtime.state());
    assert.equal(reference.runtime.observe(changed(reference)).validation.status, 'accepted');
    assert.equal(reference.runtime.clock.submit(tick).validation.status, 'accepted');
    await settleAsync(reference);

    let armed = false;
    let seen: string | null = null;
    const world: W5World = w5World({
      loom: (record) => {
        // The action's result is reported while Loom records it, before the queue drains.
        if (!armed || record.kind !== 'action.transition' || record.fields['state'] !== 'succeeded') return;
        armed = false;
        seen = stableStringify(world.runtime.state());
        assert.equal(world.runtime.observe(changed(world)).validation.status, 'accepted');
        assert.equal(world.runtime.clock.submit(tick).validation.status, 'accepted');
      },
    });
    await settleAsync(world);
    const id = firstRunning(world);
    assert.equal(id, referenceId);
    armed = true;
    world.host.release(id);
    await world.runtime.settle(id);
    assert.ok(seen !== null, 'the sink never ran');
    // The sink saw the state the transition left, not a half-applied one.
    assert.equal(seen, afterTransition, 'nested call ran mid-transition');
    await settleAsync(world);
    const actual = print(world);
    const expected = print(reference);
    assert.equal(actual.state, expected.state, 'state differs');
    assert.equal(actual.trace, expected.trace, 'Loom trace differs');
    assert.equal(actual.invocations, expected.invocations, 'host invocations differ');
    assert.equal(actual.fabric, expected.fabric, 'host store differs');
    // No grant is presented twice: every host invocation is its own action.
    const ids = world.host.invocations.map((i) => i.invocation_id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
