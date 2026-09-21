/**
 * M3 fixture: the inspect-and-report goal plus one missing fold.
 */
import { createGrantAuthority, type GrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, FabricLifecycle } from '@weave/agentfabric';
import {
  Runtime,
  ScriptedDecisionLayer,
  ScriptedFoldAuthor,
  type Goal,
  type Observation,
  type ObservationInput,
} from '@weave/weave';
import { CONTENT } from './fixture.js';

export interface M3World {
  readonly authority: GrantAuthority;
  readonly host: AgentFabricHost;
  readonly lifecycle: FabricLifecycle;
  readonly author: ScriptedFoldAuthor;
  readonly runtime: Runtime;
  readonly alpha: string;
  readonly beta: string;
  readonly gamma: string;
  observe(input: ObservationInput): Observation;
}

export function foldGoal(world: M3World, overrides: Partial<Goal> = {}): Goal {
  const goal: Goal = {
    goal_id: 'g-report-fold',
    purpose: 'Produce a checked report that includes a fold of the inspections',
    sources: [world.alpha, world.beta],
    authority: { read: [world.alpha, world.beta] },
    gap: {
      operation: 'report.fold',
      purpose: 'Fold inspection digests into one canonical digest',
      input: { inspections: '[InspectionResult]' },
      output: { fold: 'string' },
      variants: world.author.variants,
    },
    retained_procedure:
      'Sort inspection rows by source, join source=digest with a bar, and prefix the digest with fold. This text is not an implementation.',
    budget: { actions: 32, judgments: 32 },
    success_evidence: 'a report covering every goal source and a fold bound to those inspections',
  };
  const gap = overrides.gap ?? goal.gap;
  if (!gap) {
    throw new Error('fold goal requires a gap');
  }
  return { ...goal, ...overrides, gap, budget: overrides.budget ?? goal.budget };
}

export function m3World(options: { isolation?: 'enforcing' | 'unsupported'; variants?: readonly string[] } = {}): M3World {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({ authority });
  const lifecycle = new FabricLifecycle(host, options.isolation ?? 'enforcing');
  const author = new ScriptedFoldAuthor(options.variants ?? ['direct', 'aliased']);
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
  const world: M3World = {
    authority,
    host,
    lifecycle,
    author,
    runtime,
    alpha,
    beta,
    gamma,
    observe(input) {
      return runtime.observe(input);
    },
  };
  for (const [handle, key] of [
    [alpha, 'source:alpha'],
    [beta, 'source:beta'],
    [gamma, 'source:gamma'],
  ] as const) {
    world.observe({
      observation_id: `test:source.registered:${handle}`,
      source: { kind: 'test', id: 'm3-fixture' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: handle, revision: 1, content: CONTENT[key] as string },
    });
  }
  return world;
}

export function openFoldGoal(world: M3World, overrides: Partial<Goal> = {}): void {
  const goal = foldGoal(world, overrides);
  world.runtime.operator.submit({
    observation_id: `operator:goal.opened:${goal.goal_id}`,
    caused_by: null,
    payload_type: 'goal.opened',
    payload_version: 1,
    payload: goal,
  });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

export async function driveFold(world: M3World, until: 'complete' | 'admission-requested' | 'green' = 'complete'): Promise<void> {
  for (let step = 0; step < 50; step += 1) {
    await flush(6);
    const state = world.runtime.state();
    if (state.goal?.status === 'complete') {
      return;
    }
    if (until === 'admission-requested' && state.crystallization.admission?.status === 'requested') {
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
      if (!still && world.host.openActionIds().length === 0 && after.crystallization.admission?.status !== 'requested') {
        return;
      }
    }
  }
  const stuck = world.runtime.state();
  const running = Object.values(stuck.actions)
    .filter((action) => action.state === 'running' || action.state === 'pending')
    .map((action) => action.operation);
  throw new Error(`drive stopped at ${stuck.goal?.status ?? 'no goal'}; running ${running.join(',') || 'none'}; admission ${stuck.crystallization.admission?.status ?? 'none'}`);
}
