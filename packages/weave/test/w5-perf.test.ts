/**
 * W5 acceptance 6 (#187): emission keeps WV-026's hot path. Without a port
 * nothing is built; with one, a cycle emits a bounded number of records and
 * adds no State clone, no canonical encoding and no read of the observation
 * log, at 32,768 ticks as at the start.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Runtime, ScriptedDecisionLayer, type Observation, type WeftRecordShape } from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import { ALPHA, BETA, CONTENT, GAMMA, baseGoal, goalOpened, registered, tick } from './fixture.js';
import { w5World } from './w5-fixture.js';

const TICKS = 32_768;

interface Work {
  stateClones: number;
  clones: number;
  stringifies: number;
  logReads: number;
}

function ticking(ticks: number, emit?: (record: WeftRecordShape) => unknown): { runtime: Runtime; perTick: Work[] } {
  const environment = new FixtureEnvironment();
  const host = new FakeHost(environment);
  const runtime = new Runtime({
    host,
    decisionLayer: new ScriptedDecisionLayer(),
    ...(emit ? { weft: { trace_id: 'g-report', emitter_id: 'loom.main', emit } } : {}),
  });
  for (const resource of [ALPHA, BETA, GAMMA]) {
    environment.register(resource, CONTENT[resource] as string);
    runtime.observe(registered(resource, CONTENT[resource] as string));
  }
  runtime.operator.submit(goalOpened(baseGoal({ budget: { actions: ticks + 20, judgments: ticks + 20 } })));

  const work: Work = { stateClones: 0, clones: 0, stringifies: 0, logReads: 0 };
  const internals = runtime as unknown as { log: Observation[] };
  const log = internals.log;
  internals.log = new Proxy(log, {
    get(target, property, receiver) {
      if (typeof property === 'string' && (property === 'length' || /^\d+$/.test(property))) {
        work.logReads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const originalClone = globalThis.structuredClone;
  const originalStringify = JSON.stringify;
  const perTick: Work[] = [];
  try {
    globalThis.structuredClone = function <T>(value: T, options?: Parameters<typeof originalClone>[1]): T {
      work.clones += 1;
      if (value !== null && typeof value === 'object' && 'state_revision' in value && 'actions' in value) {
        work.stateClones += 1;
      }
      return originalClone(value, options);
    };
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      work.stringifies += 1;
      return (originalStringify as (value: unknown, ...rest: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify;
    for (let i = 1; i <= ticks; i += 1) {
      const before = { ...work };
      runtime.clock.submit(tick(i));
      perTick.push({
        stateClones: work.stateClones - before.stateClones,
        clones: work.clones - before.clones,
        stringifies: work.stringifies - before.stringifies,
        logReads: work.logReads - before.logReads,
      });
    }
  } finally {
    globalThis.structuredClone = originalClone;
    JSON.stringify = originalStringify;
    internals.log = log;
  }
  return { runtime, perTick };
}

describe('W5 emission on the hot path', () => {
  it('W5-T60 without a port no emitter exists in Loom, the gateway or the host', () => {
    const world = w5World();
    assert.equal((world.runtime as unknown as { weft: unknown }).weft, null);
    assert.equal((world.host as unknown as { weft: unknown }).weft, null);
    // The gateway keeps its emitter in a closure: without a port, a request builds no record collector.
    assert.equal(Object.keys(world.gateway).sort().join(), 'evaluate,generate');
  });

  it(`W5-T61 over ${TICKS} ticks a sink adds no clone, encoding or log read to any cycle`, () => {
    const plain = ticking(TICKS);
    let records = 0;
    const traced = ticking(TICKS, () => {
      records += 1;
    });
    for (let i = 0; i < TICKS; i += 1) {
      const without = plain.perTick[i] as Work;
      const withSink = traced.perTick[i] as Work;
      if (withSink.stateClones !== 0 || withSink.clones !== without.clones || withSink.stringifies !== without.stringifies || withSink.logReads !== without.logReads) {
        assert.fail(`tick ${i + 1}: with a sink ${JSON.stringify(withSink)}, without ${JSON.stringify(without)}`);
      }
    }
    // Every tick is one cycle and one cycle.weighed record: O(1) per event.
    const setup = records - TICKS;
    assert.ok(setup >= 0 && setup < 16, `${records} records for ${TICKS} ticks`);
    assert.equal(traced.runtime.trace().cycles.length, plain.runtime.trace().cycles.length);
  });

  it('W5-T62 the records a cycle emits do not grow with the log', () => {
    const sizes: number[] = [];
    let current = 0;
    const { perTick } = ticking(4_096, (record) => {
      current += 1;
      sizes.push(JSON.stringify(record).length);
    });
    assert.ok(perTick.length === 4_096 && current >= 4_096);
    const early = sizes.slice(10, 20);
    const late = sizes.slice(-10);
    // Only the digits of growing counters may lengthen a record.
    assert.ok(Math.max(...late) - Math.min(...early) < 16, `record size grew from ${early} to ${late}`);
  });
});
