/**
 * WV-026d — imported retained conclusions are indexed by id. A cycle must not
 * rescan every conclusion already in State, and recovery must not import one
 * twice.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Runtime,
  recover,
  type DecisionLayer,
  type Observation,
  type WeighRequest,
  type WeightEntry,
} from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import { ALPHA, CONTENT, baseGoal, goalOpened, registered, tick } from './fixture.js';

const QUIET = 'quiet@1';

class QuietDecisionLayer implements DecisionLayer {
  readonly implementation = QUIET;

  weigh(_request: WeighRequest): readonly WeightEntry[] {
    return [];
  }
}

class ConclusionHost extends FakeHost {
  readonly retained: unknown[] = [];

  conclusions(): readonly unknown[] {
    return this.retained;
  }

  retainConclusion(conclusion: unknown): void {
    this.retained.push(structuredClone(conclusion));
  }
}

class InterruptingJournal {
  failConclusion = false;
  private readonly items: Observation[] = [];

  persist(observation: Observation): void {
    if (this.failConclusion && observation.payload_type === 'conclusion.cached') {
      this.failConclusion = false;
      throw new Error('cycle cancelled');
    }
    this.items.push(structuredClone(observation));
  }

  snapshot(): Observation[] {
    return this.items.map((observation) => structuredClone(observation));
  }
}

function cachedConclusion(conclusion_id: string): Record<string, unknown> {
  return {
    conclusion_id,
    operation: 'source.inspect',
    contract_rev: 'r1',
    implementation_id: 'builtin',
    input_digest: `sha256:${conclusion_id}`,
    output: { conclusion_id },
    evidence: [1],
    read_set: [{ resource: ALPHA, revision: 1 }],
    authority_scope: { goal_id: 'g-report' },
    invalidation: ['read_set'],
  };
}

function setup(
  options: {
    readonly retained?: readonly string[];
    readonly journal?: InterruptingJournal;
  } = {},
): { readonly host: ConclusionHost; readonly runtime: Runtime } {
  const environment = new FixtureEnvironment();
  const host = new ConclusionHost(environment);
  environment.register(ALPHA, CONTENT[ALPHA] as string);
  for (const id of options.retained ?? []) {
    host.retained.push(cachedConclusion(id));
  }
  const runtime = new Runtime({
    host,
    decisionLayer: new QuietDecisionLayer(),
    ...(options.journal ? { journal: options.journal } : {}),
  });
  runtime.observe(registered(ALPHA, CONTENT[ALPHA] as string));
  runtime.operator.submit(goalOpened(goal()));
  return { host, runtime };
}

function goal() {
  return baseGoal({
    sources: [ALPHA],
    authority: { read: [ALPHA] },
    budget: { actions: 100, judgments: 100 },
  });
}

function imported(runtime: Runtime): Observation[] {
  return runtime
    .trace()
    .observations.filter(
      (observation) =>
        observation.validation.status === 'accepted' &&
        observation.payload_type === 'conclusion.cached' &&
        observation.observation_id.startsWith('conclusion:imported:'),
    );
}

describe('WV-026d conclusion import index', () => {
  it('WV-026d-T01 a cycle does not scan the conclusions already in State', () => {
    const retained = Array.from({ length: 40 }, (_, index) => `conc:${index}`);
    const { runtime } = setup({ retained });
    assert.equal(runtime.state().conclusions.length, retained.length);

    const internals = runtime as unknown as { current: { conclusions: unknown[] } };
    const conclusions = internals.current.conclusions;
    let scans = 0;
    internals.current.conclusions = new Proxy(conclusions, {
      get(target, property, receiver) {
        if (property === 'some') {
          scans += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      runtime.clock.submit(tick(1));
      runtime.clock.submit(tick(2));
    } finally {
      internals.current.conclusions = conclusions;
    }

    assert.equal(runtime.state().conclusions.length, retained.length);
    assert.equal(scans, 0, `a cycle scanned retained conclusions ${scans} times`);
  });

  it('WV-026d-T02 imports each conclusion once across cycles and after recover, and picks up new ones', () => {
    const { host, runtime } = setup({ retained: ['conc:a'] });
    assert.deepEqual(
      imported(runtime).map((observation) => observation.observation_id),
      ['conclusion:imported:conc:a'],
    );

    runtime.clock.submit(tick(1));
    runtime.clock.submit(tick(2));
    assert.equal(imported(runtime).length, 1, 'an imported conclusion is not imported again');

    host.retained.push(cachedConclusion('conc:b'));
    runtime.clock.submit(tick(3));
    assert.deepEqual(
      imported(runtime).map((observation) => observation.observation_id),
      ['conclusion:imported:conc:a', 'conclusion:imported:conc:b'],
    );

    const restored = recover(runtime.trace().observations, { host, decisionLayer: new QuietDecisionLayer() });
    restored.clock.submit(tick(4));
    assert.equal(imported(restored).length, 2, 'recovery does not re-import recorded conclusions');
    assert.deepEqual(
      restored.state().conclusions.map((conclusion) => conclusion.conclusion_id),
      ['conc:a', 'conc:b'],
    );

    host.retained.push(cachedConclusion('conc:c'));
    restored.clock.submit(tick(5));
    assert.deepEqual(
      imported(restored).map((observation) => observation.observation_id),
      ['conclusion:imported:conc:a', 'conclusion:imported:conc:b', 'conclusion:imported:conc:c'],
    );
    assert.deepEqual(
      restored.state().conclusions.map((conclusion) => conclusion.conclusion_id),
      ['conc:a', 'conc:b', 'conc:c'],
    );
  });

  it('WV-026d-T03 a cancelled import is retried and marked only once accepted', () => {
    const journal = new InterruptingJournal();
    const { host, runtime } = setup({ retained: ['conc:a'], journal });
    assert.equal(imported(runtime).length, 1);

    host.retained.push(cachedConclusion('conc:b'));
    journal.failConclusion = true;
    assert.throws(() => runtime.clock.submit(tick(1)), /cycle cancelled/);
    assert.deepEqual(
      runtime.state().conclusions.map((conclusion) => conclusion.conclusion_id),
      ['conc:a'],
      'the cancelled import did not enter State',
    );

    runtime.clock.submit(tick(2));
    assert.deepEqual(
      runtime.state().conclusions.map((conclusion) => conclusion.conclusion_id),
      ['conc:a', 'conc:b'],
      'the retry imports the conclusion that was not recorded',
    );
    assert.deepEqual(
      imported(runtime).map((observation) => observation.observation_id),
      ['conclusion:imported:conc:a', 'conclusion:imported:conc:b'],
    );
  });
});
