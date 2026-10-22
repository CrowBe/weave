import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Runtime, recover, replay, type Observation, type WeighRequest } from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import { ALPHA, CONTENT, baseGoal, goalOpened, registered, tick } from './fixture.js';

const quiet = {
  implementation: 'quiet@1',
  weigh: (request: WeighRequest) => request.candidates.map((item) => ({ candidate_id: item.candidate_id, weight: 0 })),
};

function conclusion(id: string) {
  return {
    conclusion_id: id,
    operation: 'source.inspect',
    contract_rev: 'r1',
    implementation_id: 'builtin',
    input_digest: `sha256:${id}`,
    output: { text: id },
    evidence: [1],
    read_set: [{ resource: ALPHA, revision: 1 }],
    authority_scope: { goal_id: 'g-report' },
    invalidation: ['read_set'],
  };
}

class RetainedHost extends FakeHost {
  readonly retained: unknown[] = [];
  fullReads = 0;
  readonly cursors: number[] = [];

  conclusions(): readonly unknown[] {
    this.fullReads++;
    return this.retained.map((item) => structuredClone(item));
  }

  conclusionsSince(cursor: number): readonly unknown[] {
    this.cursors.push(cursor);
    return this.retained.slice(cursor).map((item) => structuredClone(item));
  }
}

class Journal {
  readonly observations: Observation[] = [];
  interrupt: string | null = null;
  snapshot(): Observation[] {
    return this.observations.map((item) => structuredClone(item));
  }
  persist(observation: Observation): void {
    if (
      observation.payload_type === 'conclusion.cached' &&
      (observation.payload as { conclusion_id: string }).conclusion_id === this.interrupt
    ) {
      this.interrupt = null;
      throw new Error('cycle cancelled');
    }
    this.observations.push(structuredClone(observation));
  }
}

function setup(
  incremental = true,
  journal?: Journal,
  retained: readonly unknown[] = [conclusion('a'), 'ignored', conclusion('a'), conclusion('b')],
) {
  const environment = new FixtureEnvironment();
  environment.register(ALPHA, CONTENT[ALPHA] as string);
  const host = new RetainedHost(environment);
  if (!incremental) Object.defineProperty(host, 'conclusionsSince', { value: undefined, writable: true });
  host.retained.push(...retained);
  const runtime = new Runtime({ host, decisionLayer: quiet, ...(journal ? { journal } : {}) });
  runtime.observe(registered(ALPHA, CONTENT[ALPHA] as string));
  runtime.operator.submit(
    goalOpened(
      baseGoal({
        sources: [ALPHA],
        authority: { read: [ALPHA] },
        budget: { actions: 0, judgments: 100 },
      }),
    ),
  );
  return { host, runtime };
}

function ids(runtime: Runtime) {
  return runtime.state().conclusions.map((item) => item.conclusion_id);
}

function attempts(runtime: Runtime, conclusion_id: string) {
  return runtime.trace().observations.filter((item) => item.observation_id === `conclusion:imported:${conclusion_id}`)
    .length;
}

describe('WV-N275 incremental conclusion import', () => {
  it('reads only the delta on repeated cycles and when another writer appends', () => {
    const { host, runtime } = setup();
    host.cursors.length = 0;
    host.fullReads = 0;
    runtime.clock.submit(tick(1));
    runtime.clock.submit(tick(2));
    assert.equal(host.fullReads, 0, 'cycles must not request full retained-conclusion copies');
    assert.deepEqual(host.cursors, [4, 4]);
    host.retained.push(conclusion('c'));
    runtime.clock.submit(tick(3));
    runtime.clock.submit(tick(4));
    assert.deepEqual(host.cursors, [4, 4, 4, 5]);
    assert.deepEqual(ids(runtime), ['a', 'b', 'c']);
  });

  it('preserves every observation and cycle compared with full reads, including rejected entries', () => {
    const incremental = setup();
    const full = setup(false);
    for (const { host, runtime } of [incremental, full]) {
      host.retained.push(conclusion('c'), { conclusion_id: 'invalid' }, conclusion('d'));
      runtime.clock.submit(tick(1));
      runtime.clock.submit(tick(2));
      host.retained.push(conclusion('e'));
      runtime.clock.submit(tick(3));
    }
    assert.deepEqual(incremental.runtime.trace(), full.runtime.trace());
    assert.deepEqual(incremental.runtime.state(), full.runtime.state());
    assert.deepEqual(ids(incremental.runtime), ['a', 'b', 'c', 'd', 'e']);
    // Host imports are skipped by historical replay today. Preserve its exact
    // result (including any divergence) rather than changing replay semantics.
    for (const { host } of [incremental, full]) {
      host.conclusions = () => {
        throw new Error('replay read host conclusions');
      };
      host.conclusionsSince = () => {
        throw new Error('replay read host delta');
      };
    }
    assert.deepEqual(
      replay(incremental.runtime.trace().observations, { host: incremental.host, decisionLayer: quiet }),
      replay(full.runtime.trace().observations, { host: full.host, decisionLayer: quiet }),
    );
  });

  it('rebuilds from accepted observations on recovery without assuming log count equals host position', () => {
    const { host, runtime } = setup();
    // This locally cached conclusion is already in State before host retention.
    runtime.load([
      {
        seq: 100,
        observation_id: 'conclusion:local',
        source: { kind: 'runtime', id: 'weave' },
        caused_by: null,
        payload_type: 'conclusion.cached',
        payload_version: 1,
        payload: conclusion('local'),
        validation: { status: 'accepted' },
      },
    ]);
    const prefix = runtime.trace().observations;
    host.retained.push(conclusion('c'), conclusion('local'));
    const restored = recover(prefix, { host, decisionLayer: quiet });
    host.cursors.length = 0;
    restored.clock.submit(tick(1));
    restored.clock.submit(tick(2));
    assert.deepEqual(host.cursors, [0, 6], 'recovery reconciles the host prefix once, then reads only the suffix');
    assert.deepEqual(ids(restored), ['a', 'b', 'local', 'c']);
    assert.equal(
      restored
        .trace()
        .observations.filter(
          (item) =>
            item.payload_type === 'conclusion.cached' &&
            (item.payload as { conclusion_id: string }).conclusion_id === 'local',
        ).length,
      1,
    );
  });

  it('does not consume an interrupted append; recovery and continuation import the remaining suffix identically', () => {
    const journal = new Journal();
    const { host, runtime } = setup(true, journal);
    host.retained.push(conclusion('c'), conclusion('d'), conclusion('e'));
    journal.interrupt = 'd';
    assert.throws(() => runtime.clock.submit(tick(1)), /cycle cancelled/);
    assert.deepEqual(ids(runtime), ['a', 'b', 'c']);
    const prefix = journal.snapshot();
    const restored = recover(prefix, { host, decisionLayer: quiet });
    host.cursors.length = 0;
    runtime.clock.submit(tick(2));
    assert.deepEqual(host.cursors, [5], 'continuation retries the first unaccepted position');
    restored.clock.submit(tick(2));
    assert.deepEqual(ids(runtime), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(runtime.state().conclusions, restored.state().conclusions);
    const cached = (run: Runtime) =>
      run.trace().observations.filter((item) => item.payload_type === 'conclusion.cached');
    assert.deepEqual(cached(runtime), cached(restored));

    // Recovery starts its cycle numbering afresh. Compare the complete recovered
    // run with the same accepted prefix using the original full-read contract.
    const legacyHost = new RetainedHost(new FixtureEnvironment());
    legacyHost.retained.push(...host.retained);
    Object.defineProperty(legacyHost, 'conclusionsSince', { value: undefined });
    const legacy = recover(prefix, { host: legacyHost, decisionLayer: quiet });
    legacy.clock.submit(tick(2));
    assert.deepEqual(restored.state(), legacy.state());
    assert.deepEqual(restored.trace(), legacy.trace());
  });

  it('attempts a retained item that fails validation once, then reads only new items', () => {
    for (const incremental of [false, true]) {
      const { host, runtime } = setup(incremental, undefined, [conclusion('a'), { conclusion_id: 'invalid' }]);
      host.retained.push(conclusion('b'));
      host.cursors.length = 0;
      runtime.clock.submit(tick(1));
      runtime.clock.submit(tick(2));
      host.retained.push(conclusion('c'));
      runtime.clock.submit(tick(3));
      runtime.clock.submit(tick(4));
      assert.equal(attempts(runtime, 'invalid'), 1, `incremental=${incremental}`);
      if (incremental) {
        assert.deepEqual(host.cursors, [2, 3, 3, 4], 'a terminal rejection is consumed like an accepted append');
      }
      assert.deepEqual(ids(runtime), ['a', 'b', 'c']);
    }
  });

  it('consumes a terminal rejection but retries a thrown persistence failure after it', () => {
    const journal = new Journal();
    const { host, runtime } = setup(true, journal);
    host.retained.push({ conclusion_id: 'invalid' }, conclusion('c'), conclusion('d'));
    journal.interrupt = 'c';
    assert.throws(() => runtime.clock.submit(tick(1)), /cycle cancelled/);
    assert.deepEqual(ids(runtime), ['a', 'b']);
    const restored = recover(journal.snapshot(), { host, decisionLayer: quiet });
    host.cursors.length = 0;
    runtime.clock.submit(tick(2));
    assert.deepEqual(host.cursors, [5], 'the thrown append is retried; the rejection before it is not');
    assert.deepEqual(ids(runtime), ['a', 'b', 'c', 'd']);
    assert.equal(attempts(runtime, 'invalid'), 1);

    // The journal holds only accepted observations, so recovery re-attempts the
    // rejection once from position 0 and must land on the same cursor.
    restored.clock.submit(tick(2));
    assert.deepEqual(ids(restored), ['a', 'b', 'c', 'd']);
    assert.equal(attempts(restored, 'invalid'), 1);
    host.retained.push(conclusion('e'));
    host.cursors.length = 0;
    runtime.clock.submit(tick(3));
    restored.clock.submit(tick(3));
    assert.deepEqual(host.cursors, [7, 7]);
    assert.deepEqual(runtime.state().conclusions, restored.state().conclusions);
  });

  it('replays identically without reading either host accessor', () => {
    const { host, runtime } = setup(true, undefined, []);
    runtime.clock.submit(tick(1));
    runtime.clock.submit(tick(2));
    host.retained.push(conclusion('c'));
    host.conclusions = () => {
      throw new Error('replay read host conclusions');
    };
    host.conclusionsSince = () => {
      throw new Error('replay read host delta');
    };
    const result = replay(runtime.trace().observations, { host, decisionLayer: quiet });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.state, runtime.state());
    assert.deepEqual(result.trace, runtime.trace());
  });
});
