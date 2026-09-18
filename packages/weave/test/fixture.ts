/**
 * The M0 fixture (docs/m0-inspect-and-report.md §2) and scenario helpers.
 */
import {
  Runtime,
  ScriptedDecisionLayer,
  type Candidate,
  type CycleRecord,
  type DecisionLayer,
  type Goal,
  type Observation,
  type ObservationInput,
  type Trace,
} from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';

export const ALPHA = 'source:alpha';
export const BETA = 'source:beta';
export const GAMMA = 'source:gamma';

export const CONTENT: Readonly<Record<string, string>> = {
  [ALPHA]: 'alpha one\nalpha two\nalpha three',
  [BETA]: 'beta one\nbeta two\nbeta three\nbeta four\nbeta five',
  [GAMMA]: 'gamma one',
};

export function baseGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: 'g-report',
    purpose: 'Produce a checked report over the listed sources',
    sources: [ALPHA, BETA],
    authority: { read: [ALPHA, BETA] },
    budget: { actions: 6, judgments: 6 },
    success_evidence:
      'a Report artifact covering every goal source whose read set matches the current revision of each source',
    ...overrides,
  };
}

export function registered(resource: string, content: string): ObservationInput {
  return {
    observation_id: `test:source.registered:${resource}`,
    source: { kind: 'test', id: 'm0-fixture' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource, revision: 1, content },
  };
}

export function changed(resource: string, revision: number, content: string): ObservationInput {
  return {
    observation_id: `test:source.changed:${resource}:${revision}`,
    source: { kind: 'test', id: 'm0-fixture' },
    caused_by: null,
    payload_type: 'source.changed',
    payload_version: 1,
    payload: { resource, revision, content },
  };
}

export function goalOpened(goal: Goal): ObservationInput {
  return {
    observation_id: `operator:goal.opened:${goal.goal_id}`,
    source: { kind: 'operator', id: 'operator' },
    caused_by: null,
    payload_type: 'goal.opened',
    payload_version: 1,
    payload: goal,
  };
}

export function tick(n: number): ObservationInput {
  return {
    observation_id: `clock:tick:${n}`,
    source: { kind: 'clock', id: 'clock' },
    caused_by: null,
    payload_type: 'clock.tick',
    payload_version: 1,
    payload: { tick: n },
  };
}

export class FailingDecisionLayer implements DecisionLayer {
  readonly implementation = 'failing@1';
  weigh(): never {
    throw new Error('decision layer must not be invoked');
  }
}

export interface Scenario {
  readonly environment: FixtureEnvironment;
  readonly host: FakeHost;
  readonly decisionLayer: DecisionLayer;
  readonly runtime: Runtime;
  /** Observations appended by the test, in order, as the runtime recorded them. */
  readonly appended: Observation[];
  observe(input: ObservationInput): Observation;
}

export interface ScenarioOptions {
  readonly goal?: Goal;
  readonly decisionLayer?: DecisionLayer;
  /** Register sources and open the goal immediately. Default true. */
  readonly open?: boolean;
}

/** Register alpha, beta, gamma at revision 1, then open the goal. Host completions are held. */
export function scenario(options: ScenarioOptions = {}): Scenario {
  const environment = new FixtureEnvironment();
  const host = new FakeHost(environment);
  const decisionLayer = options.decisionLayer ?? new ScriptedDecisionLayer();
  const runtime = new Runtime({ host, decisionLayer });
  const appended: Observation[] = [];
  const s: Scenario = {
    environment,
    host,
    decisionLayer,
    runtime,
    appended,
    observe(input) {
      const observation = runtime.observe(input);
      appended.push(observation);
      return observation;
    },
  };
  if (options.open !== false) {
    registerAll(s);
    s.observe(goalOpened(options.goal ?? baseGoal()));
  }
  return s;
}

export function registerAll(s: Scenario): void {
  for (const resource of [ALPHA, BETA, GAMMA]) {
    const content = CONTENT[resource] as string;
    s.environment.register(resource, content);
    s.observe(registered(resource, content));
  }
}

/** Release a held invocation and wait until its result is in the log. */
export async function release(s: Scenario, action_id: string): Promise<void> {
  s.host.release(action_id);
  await s.runtime.settle(action_id);
}

export function cycles(s: Scenario): readonly CycleRecord[] {
  return s.runtime.trace().cycles;
}

export function lastCycle(s: Scenario): CycleRecord {
  const all = cycles(s);
  const last = all[all.length - 1];
  if (!last) {
    throw new Error('no cycle recorded');
  }
  return last;
}

export function candidatesFor(cycle: CycleRecord, operation: string): Candidate[] {
  return cycle.candidates.filter((c) => c.operation === operation);
}

export function inspectCandidate(cycle: CycleRecord, source: string): Candidate | undefined {
  return cycle.candidates.find(
    (c) => c.operation === 'source.inspect' && (c.inputs as { source: string }).source === source,
  );
}

export function actionIdFor(cycle: CycleRecord, candidate_id: string): string {
  const selected = cycle.selected.find((sel) => sel.candidate_id === candidate_id);
  if (!selected) {
    throw new Error(`candidate ${candidate_id} not selected in cycle ${cycle.cycle_no}`);
  }
  return selected.action_id;
}

export function observationsOfType(trace: Trace, payload_type: string): Observation[] {
  return trace.observations.filter((o) => o.payload_type === payload_type);
}

/**
 * Drive the base scenario to completion: release beta, then alpha, then the
 * assemble invocation. Returns the final trace.
 */
export async function runBaseToCompletion(s: Scenario): Promise<Trace> {
  const c1 = cycles(s)[0];
  if (!c1) {
    throw new Error('cycle 1 missing');
  }
  const alpha = inspectCandidate(c1, ALPHA);
  const beta = inspectCandidate(c1, BETA);
  if (!alpha || !beta) {
    throw new Error('inspection candidates missing');
  }
  await release(s, actionIdFor(c1, beta.candidate_id));
  await release(s, actionIdFor(c1, alpha.candidate_id));
  const assembleCycle = lastCycle(s);
  const assemble = candidatesFor(assembleCycle, 'report.assemble')[0];
  if (!assemble) {
    throw new Error('report.assemble candidate missing');
  }
  await release(s, actionIdFor(assembleCycle, assemble.candidate_id));
  return s.runtime.trace();
}
