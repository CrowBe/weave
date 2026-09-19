/**
 * M1 fixture: the inspect-and-report goal plus a publication destination,
 * served by the enforcing AgentFabric host.
 */
import { createGrantAuthority, type GrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, type FabricSnapshot } from '@weave/agentfabric';
import {
  MemoryJournal,
  Runtime,
  ScriptedDecisionLayer,
  type Candidate,
  type CycleRecord,
  type Goal,
  type Observation,
  type ObservationInput,
} from '@weave/weave';
import { CONTENT as M0_CONTENT } from './fixture.js';

export const CONTENT = M0_CONTENT;

export interface M1World {
  readonly authority: GrantAuthority;
  readonly host: AgentFabricHost;
  readonly runtime: Runtime;
  readonly journal: MemoryJournal;
  readonly alpha: string;
  readonly beta: string;
  readonly gamma: string;
  readonly dest: string;
  readonly destAlias: string;
  observe(input: ObservationInput): Observation;
}

export function m1Goal(world: M1World, overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: 'g-report',
    purpose: 'Produce and publish a checked report over the listed sources',
    sources: [world.alpha, world.beta],
    destination: world.dest,
    authority: { read: [world.alpha, world.beta] },
    budget: { actions: 8, judgments: 8, recovery: 4 },
    success_evidence: 'a publication receipt for the current report at the authorized destination',
    ...overrides,
  };
}

export function m1World(options: { slots?: number; recovery?: number; includeGamma?: boolean } = {}): M1World {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({ authority });
  const journal = new MemoryJournal();
  const alpha = host.registerSource('mem:alpha', CONTENT['source:alpha'] as string);
  const beta = host.registerSource('mem:beta', CONTENT['source:beta'] as string);
  const gamma = host.registerSource('mem:gamma', CONTENT['source:gamma'] as string);
  const dest = host.registerDestination('mem:outbox');
  const destAlias = host.alias(dest);
  const runtime = new Runtime({
    host,
    decisionLayer: new ScriptedDecisionLayer(),
    grantAuthority: authority,
    journal,
    ...(options.slots !== undefined ? { executionSlots: options.slots } : {}),
  });
  const world: M1World = {
    authority,
    host,
    runtime,
    journal,
    alpha,
    beta,
    gamma,
    dest,
    destAlias,
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
      source: { kind: 'test', id: 'm1-fixture' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: handle, revision: 1, content: CONTENT[key] as string },
    });
  }
  world.observe({
    observation_id: `test:source.registered:${dest}`,
    source: { kind: 'test', id: 'm1-fixture' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource: dest, revision: 1, content: '' },
  });
  const goal = m1Goal(world, options.includeGamma ? { sources: [alpha, beta, gamma], authority: { read: [alpha, beta] } } : {});
  const budget = options.recovery !== undefined ? { ...goal.budget, recovery: options.recovery } : goal.budget;
  runtime.operator.submit({
    observation_id: 'operator:goal.opened:g-report',
    caused_by: null,
    payload_type: 'goal.opened',
    payload_version: 1,
    payload: { ...goal, budget },
  });
  return world;
}

export async function release(world: M1World, action_id: string): Promise<void> {
  world.host.release(action_id);
  await world.runtime.settle(action_id);
}

export function cycles(world: M1World): readonly CycleRecord[] {
  return world.runtime.trace().cycles;
}

export function lastCycle(world: M1World): CycleRecord {
  const all = cycles(world);
  const last = all[all.length - 1];
  if (!last) {
    throw new Error('no cycle recorded');
  }
  return last;
}

export function candidatesFor(cycle: CycleRecord, operation: string): Candidate[] {
  return cycle.candidates.filter((c) => c.operation === operation);
}

export function actionIdFor(cycle: CycleRecord, candidate_id: string): string {
  const selected = cycle.selected.find((sel) => sel.candidate_id === candidate_id);
  if (!selected) {
    throw new Error(`candidate ${candidate_id} not selected in cycle ${cycle.cycle_no}`);
  }
  return selected.action_id;
}

export function inspectCandidate(cycle: CycleRecord, source: string): Candidate | undefined {
  return cycle.candidates.find(
    (c) => c.operation === 'source.inspect' && (c.inputs as { source: string }).source === source,
  );
}

export async function assembleReport(world: M1World): Promise<void> {
  const c1 = cycles(world)[0];
  if (!c1) {
    throw new Error('cycle 1 missing');
  }
  const alpha = inspectCandidate(c1, world.alpha);
  const beta = inspectCandidate(c1, world.beta);
  if (!alpha || !beta) {
    throw new Error('inspection candidates missing');
  }
  await release(world, actionIdFor(c1, beta.candidate_id));
  await release(world, actionIdFor(c1, alpha.candidate_id));
  const assembleCycle = lastCycle(world);
  const assemble = candidatesFor(assembleCycle, 'report.assemble')[0];
  if (!assemble) {
    throw new Error('report.assemble candidate missing');
  }
  await release(world, actionIdFor(assembleCycle, assemble.candidate_id));
}

export function pendingApproval(world: M1World): string {
  const pending = Object.values(world.runtime.state().approvals).find((a) => a.status === 'pending');
  if (!pending) {
    throw new Error('no pending approval');
  }
  return pending.request_id;
}

export function restoreWorld(
  world: M1World,
  snapshot: FabricSnapshot,
  observations: readonly Observation[],
  options: { slots?: number; lookupUnavailable?: boolean } = {},
): M1World {
  const authority = createGrantAuthority();
  const faults = options.lookupUnavailable ? { lookupUnavailable: true } : undefined;
  const host = AgentFabricHost.restore(authority, snapshot, faults);
  const journal = new MemoryJournal();
  const runtime = new Runtime({
    host,
    decisionLayer: new ScriptedDecisionLayer(),
    grantAuthority: authority,
    journal,
    ...(options.slots !== undefined ? { executionSlots: options.slots } : {}),
  });
  runtime.load(observations);
  const restored: M1World = {
    authority,
    host,
    runtime,
    journal,
    alpha: world.alpha,
    beta: world.beta,
    gamma: world.gamma,
    dest: world.dest,
    destAlias: world.destAlias,
    observe(input) {
      return runtime.observe(input);
    },
  };
  runtime.reconcile();
  return restored;
}
