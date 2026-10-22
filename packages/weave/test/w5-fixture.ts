/**
 * W5 fixture (#187): Loom, the Fabric host and the inference gateway composed
 * the way the reference stack composes them, each optionally given a Weft
 * port. The run is concurrent (two execution slots), weighs through the
 * gateway with one retried attempt, cancels a queued inspection, supersedes it
 * with a fresh one and joins the inspections into the report.
 */
import { createGrantAuthority, type GrantAuthority } from '@weave/agentsop';
import { AgentFabricHost } from '@weave/agentfabric';
import {
  createInferenceGateway,
  type EvaluationAdapter,
  type EvaluationCall,
  type EvaluationProviderResult,
  type InferenceGateway,
  type RoutedUnit,
} from '@weave/gateway';
import {
  GatewayDecisionLayer,
  LOCAL_DESTINATION,
  MemoryJournal,
  Runtime,
  stableStringify,
  type ObservationInput,
  type Trace,
} from '@weave/weave';
import { CONTENT } from './fixture.js';
import { scoreAnswers } from './m2-fixture.js';

/** A record as a sink receives it. Only the shape the tests read. */
export interface Rec {
  readonly schema: string;
  readonly trace_id: string;
  readonly record_id: string;
  readonly emitter: { readonly kind: string; readonly id: string };
  readonly sequence: number;
  readonly kind: string;
  readonly thread_id: string | null;
  readonly parent_id: string | null;
  readonly links: readonly { readonly rel: string; readonly record_id: string }[];
  readonly evidence: readonly { readonly source: string; readonly ref: string }[];
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface Port {
  readonly trace_id: string;
  readonly emitter_id: string;
  emit(record: Rec): unknown;
}

export type Sink = (record: Rec) => unknown;

export const TRACE_ID = 'g-w5';

export function collector(): { readonly records: Rec[]; readonly sink: Sink } {
  const records: Rec[] = [];
  return { records, sink: (record) => void records.push(record) };
}

export function port(emitter_id: string, sink: Sink): Port {
  return { trace_id: TRACE_ID, emitter_id, emit: sink };
}

export const WEIGH_UNIT: RoutedUnit = {
  operation: 'evaluate',
  kind: 'score',
  context_profile: 'profile.frontier-weigh',
  context_profile_version: 2,
  prompt_template: 'template.weigh.score',
  prompt_template_version: 1,
  adapter: 'w5.evaluate',
  model: 'fixture/weigher',
  settings: { max_output_tokens: 256 },
  destination: LOCAL_DESTINATION,
  quality: 'baseline',
  context_limit_tokens: 8_000,
  price: { input_per_mtok: 1, output_per_mtok: 1 },
  routed_unit_id: 'weigh.local',
};

/** Fails the first call with a retryable fault, then weighs every candidate 2. */
export function flakyWeigher(canary = ''): EvaluationAdapter & { readonly calls: EvaluationCall[] } {
  const calls: EvaluationCall[] = [];
  return {
    id: 'w5.evaluate',
    calls,
    async evaluate(call): Promise<EvaluationProviderResult> {
      calls.push(call);
      if (calls.length === 1) {
        return {
          status: 'failed',
          failure: { code: 'unavailable', message: `provider overloaded ${canary}`, retryable: true },
        };
      }
      return scoreAnswers(Object.fromEntries(Object.keys(call.questions).map((id) => [id, 2])));
    },
  };
}

export interface W5World {
  readonly authority: GrantAuthority;
  readonly host: AgentFabricHost;
  readonly gateway: InferenceGateway;
  readonly runtime: Runtime;
  readonly weigher: ReturnType<typeof flakyWeigher>;
  readonly alpha: string;
  readonly beta: string;
  readonly gamma: string;
  /** Inputs the test appended, in order, as the runtime saw them. */
  readonly appended: ObservationInput[];
}

export interface W5Sinks {
  readonly loom?: Sink;
  readonly gateway?: Sink;
  readonly fabric?: Sink;
}

export interface W5Options {
  readonly journal?: MemoryJournal;
  /** Written into the goal purpose, every source's content and the provider's failure message: text no record may carry. */
  readonly canary?: string;
  readonly authority?: GrantAuthority;
}

export function w5World(sinks: W5Sinks = {}, options: W5Options = {}): W5World {
  const { journal, canary = '' } = options;
  const content = (key: string): string => `${CONTENT[key] as string}${canary ? `\n${canary}` : ''}`;
  const authority = options.authority ?? createGrantAuthority();
  const host = new AgentFabricHost({
    authority,
    ...(sinks.fabric ? { weft: port('fabric.host', sinks.fabric) } : {}),
  });
  const weigher = flakyWeigher(canary);
  const gateway = createInferenceGateway({
    routes: [WEIGH_UNIT],
    evaluators: [weigher],
    clock: { now: () => 0 },
    ...(sinks.gateway ? { weft: port('gateway.main', sinks.gateway) } : {}),
  });
  const runtime = new Runtime({
    host,
    decisionLayer: new GatewayDecisionLayer(gateway, [LOCAL_DESTINATION]),
    grantAuthority: authority,
    executionSlots: 2,
    ...(journal ? { journal } : {}),
    ...(sinks.loom ? { weft: port('loom.main', sinks.loom) } : {}),
  });
  const alpha = host.registerSource('mem:alpha', content('source:alpha'));
  const beta = host.registerSource('mem:beta', content('source:beta'));
  const gamma = host.registerSource('mem:gamma', content('source:gamma'));
  const world: W5World = { authority, host, gateway, runtime, weigher, alpha, beta, gamma, appended: [] };
  for (const [handle, key] of [
    [alpha, 'source:alpha'],
    [beta, 'source:beta'],
    [gamma, 'source:gamma'],
  ] as const) {
    const input: ObservationInput = {
      observation_id: `test:source.registered:${handle}`,
      source: { kind: 'test', id: 'w5-fixture' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: handle, revision: 1, content: content(key) },
    };
    world.appended.push(input);
    runtime.observe(input);
  }
  const opened: ObservationInput = {
    observation_id: `operator:goal.opened:${TRACE_ID}`,
    source: { kind: 'operator', id: 'operator' },
    caused_by: null,
    payload_type: 'goal.opened',
    payload_version: 1,
    payload: {
      goal_id: TRACE_ID,
      purpose: `Produce a checked report over three sources ${canary}`.trim(),
      sources: [alpha, beta, gamma],
      authority: { read: [alpha, beta, gamma] },
      budget: { actions: 12, judgments: 12, recovery: 4, cost: 1_000_000 },
      success_evidence: 'a Report artifact covering every goal source at its current revision',
    },
  };
  world.appended.push(opened);
  const { source: _source, ...rest } = opened;
  runtime.operator.submit(rest);
  return world;
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Let gateway promises land until the log stops growing. */
export async function settleAsync(world: W5World): Promise<void> {
  let last = -1;
  for (let i = 0; i < 50; i += 1) {
    await macrotask();
    const size = world.runtime.trace().observations.length;
    if (size === last) {
      return;
    }
    last = size;
  }
}

function running(world: W5World): string[] {
  return Object.values(world.runtime.state().actions)
    .filter((action) => action.state === 'running')
    .map((action) => action.action_id)
    .sort();
}

/**
 * The scripted run. Returns the action ids it cancelled and released, in
 * order, so a test can check the trace against them.
 */
export async function runW5(world: W5World): Promise<{ readonly cancelled: string; readonly superseding: string }> {
  await settleAsync(world);
  const queued = Object.values(world.runtime.state().actions).filter((action) => action.state === 'pending');
  if (queued.length !== 1 || running(world).length !== 2) {
    throw new Error(
      `expected two running inspections and one queued, got ${stableStringify(world.runtime.state().actions)}`,
    );
  }
  const cancelled = (queued[0] as { action_id: string }).action_id;
  world.runtime.cancel(cancelled, 'operator cancel');
  for (const id of running(world)) {
    world.host.release(id);
    await world.runtime.settle(id);
  }
  await settleAsync(world);
  let superseding = '';
  for (let guard = 0; guard < 10 && world.runtime.state().goal?.status === 'active'; guard += 1) {
    const open = running(world);
    for (const id of open) {
      const action = world.runtime.state().actions[id];
      if (action?.operation === 'source.inspect' && superseding === '') {
        superseding = id;
      }
      world.host.release(id);
      await world.runtime.settle(id);
    }
    await settleAsync(world);
  }
  if (world.runtime.state().goal?.status !== 'complete') {
    throw new Error(`W5 run did not complete: ${stableStringify(world.runtime.state().goal)}`);
  }
  return { cancelled, superseding };
}

/** State and Loom trace in canonical form, for equality across runs. */
export function fingerprint(world: W5World): { readonly state: string; readonly trace: string } {
  const trace: Trace = world.runtime.trace();
  return { state: stableStringify(world.runtime.state()), trace: stableStringify(trace) };
}
