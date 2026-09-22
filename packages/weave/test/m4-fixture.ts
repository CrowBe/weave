/**
 * M4 fixture: an admitted text.normalize and the recorded normalized-report
 * composition (docs/m4-measure-reuse.md). The composition is data. It does
 * not add a procedure.
 */
import { createGrantAuthority, type GrantAuthority, type InvocationOutcome } from '@weave/agentsop';
import { AgentFabricHost, TEXT_NORMALIZE, collapseWhitespace } from '@weave/agentfabric';
import { Runtime, ScriptedDecisionLayer, type Goal, type Observation, type ObservationInput } from '@weave/weave';

export const COMPOSITION_ID = 'report.normalize@1';

export function normalizeOutcome(inputs: unknown): InvocationOutcome {
  const text = typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs) ? (inputs as { text?: unknown }).text : undefined;
  if (typeof text !== 'string') {
    return { outcome: 'failed', failure: 'invalid' };
  }
  const collapsed = collapseWhitespace(text);
  if (text.length > 0 && collapsed.length === 0) {
    return { outcome: 'failed', failure: 'empty output' };
  }
  return { outcome: 'succeeded', output: { text: collapsed } };
}

export interface M4World {
  readonly authority: GrantAuthority;
  readonly host: AgentFabricHost;
  readonly runtime: Runtime;
  readonly alpha: string;
  readonly beta: string;
  observe(input: ObservationInput): Observation;
}

export function m4World(contents: { alpha?: string; beta?: string } = {}): M4World {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({ authority });
  host.installAdmitted(TEXT_NORMALIZE, normalizeOutcome, 'normalize.v1');
  const alpha = host.registerSource('mem:alpha', contents.alpha ?? 'alpha  one');
  const beta = host.registerSource('mem:beta', contents.beta ?? 'beta\ttwo');
  const runtime = new Runtime({ host, decisionLayer: new ScriptedDecisionLayer(), grantAuthority: authority });
  const world: M4World = {
    authority,
    host,
    runtime,
    alpha,
    beta,
    observe(input) {
      return runtime.observe(input);
    },
  };
  world.observe({
    observation_id: `test:source.registered:${alpha}`,
    source: { kind: 'test', id: 'm4-fixture' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource: alpha, revision: 1, content: contents.alpha ?? 'alpha  one' },
  });
  world.observe({
    observation_id: `test:source.registered:${beta}`,
    source: { kind: 'test', id: 'm4-fixture' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource: beta, revision: 1, content: contents.beta ?? 'beta\ttwo' },
  });
  runtime.operator.submit({
    observation_id: `operator:composition:${COMPOSITION_ID}`,
    caused_by: null,
    payload_type: 'composition.recorded',
    payload_version: 1,
    payload: {
      composition_id: COMPOSITION_ID,
      steps: [{ operation: 'source.inspect' }, { operation: 'text.normalize' }, { operation: 'report.assemble' }],
    },
  });
  return world;
}

export function normalizedGoal(world: M4World, goal_id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id,
    purpose: 'Produce a normalized report over the listed sources',
    sources: [world.alpha, world.beta],
    authority: { read: [world.alpha, world.beta] },
    composition_id: COMPOSITION_ID,
    budget: { actions: 12, judgments: 12 },
    success_evidence:
      'a Report artifact covering every goal source whose read set matches the current revision of each source',
    ...overrides,
  };
}

export function openGoal(world: M4World, goal: Goal, suffix: string): Observation {
  return world.runtime.operator.submit({
    observation_id: `operator:goal.opened:${goal.goal_id}:${suffix}`,
    caused_by: null,
    payload_type: 'goal.opened',
    payload_version: 1,
    payload: goal,
  });
}

export async function drain(world: M4World): Promise<void> {
  for (let step = 0; step < 24; step += 1) {
    const goal = world.runtime.state().goal;
    if (!goal || goal.status !== 'active') {
      return;
    }
    const open = world.host.openActionIds();
    if (open.length === 0) {
      const running = Object.values(world.runtime.state().actions).filter(
        (action) => action.state === 'running' || action.state === 'pending',
      );
      if (running.length === 0) {
        return;
      }
      throw new Error(`running actions are not open on the host: ${running.map((action) => action.operation).join(',')}`);
    }
    for (const action_id of [...open]) {
      if (!world.host.openActionIds().includes(action_id)) {
        continue;
      }
      world.host.release(action_id);
      await world.runtime.settle(action_id);
    }
  }
  throw new Error(`goal still ${world.runtime.state().goal?.status ?? 'absent'}`);
}

export function tick(world: M4World, n: number): void {
  world.runtime.clock.submit({
    observation_id: `clock:tick:${n}`,
    caused_by: null,
    payload_type: 'clock.tick',
    payload_version: 1,
    payload: { tick: n },
  });
}
