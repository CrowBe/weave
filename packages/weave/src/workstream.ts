/**
 * Workstreams (#26), per WORKSTREAM-CONTRACT.md: independently addressable streams of conversation and work
 * within one project. Pure transitions over versioned records. A workstream holds ids and sequence numbers,
 * never a resource, a grant, a slice or a payload.
 */
import {
  isLive,
  openProcess,
  transitionProcess,
  type OperatingProcess,
  type ProcessEvent,
  type ProcessRefusal,
} from './operating-process.js';
import { SITE_POLICY, correlation, type RouteOutcome } from './sites/index.js';
import type { Seq } from './types.js';

export const WORKSTREAM_SCHEMA = 'workstream@1' as const;
export type WorkstreamOrigin = 'operator' | 'route';
export interface WorkstreamGoal {
  readonly goal_id: string;
  readonly attached_at: Seq;
  readonly ended_at: Seq | null;
}
/** An operator input addressed here, and where routing placed it (WORKSTREAM-CONTRACT.md `input.route@1`). */
export interface WorkstreamInput {
  readonly seq: Seq;
  /** Null from arrival until a routing record with status `transition` is applied. */
  readonly route: RouteOutcome | null;
  readonly decided_by: 'operator' | 'rule' | 'site' | null;
  /** The routing record's observation. */
  readonly routed_at: Seq | null;
  /** For `parallel`: the workstream opened for this input. */
  readonly target: string | null;
  /** For `queue`: true until released. */
  readonly held: boolean;
}
export interface WorkstreamArtifact {
  readonly artifact_id: string;
  readonly revision: number;
  readonly goal_id: string;
  readonly evidence: Seq;
}
export interface Workstream {
  readonly schema: typeof WORKSTREAM_SCHEMA;
  readonly workstream_id: string;
  readonly project_id: string;
  readonly origin: WorkstreamOrigin;
  readonly opened_at: Seq;
  readonly revision: number;
  readonly goals: readonly WorkstreamGoal[];
  readonly inputs: readonly WorkstreamInput[];
  readonly artifacts: readonly WorkstreamArtifact[];
  readonly process: OperatingProcess | null;
}
/** One project's workstreams. The project record and its availability index stay where they are. */
export interface WorkstreamIndex {
  readonly project_id: string;
  readonly workstreams: readonly Workstream[];
}
export type WorkstreamEvent =
  | { readonly type: 'goal.attached'; readonly goal_id: string; readonly evidence: Seq }
  | { readonly type: 'goal.ended'; readonly goal_id: string; readonly evidence: Seq }
  | { readonly type: 'input.recorded'; readonly seq: Seq }
  | {
      readonly type: 'artifact.recorded';
      readonly artifact_id: string;
      readonly revision: number;
      readonly evidence: Seq;
    }
  | { readonly type: 'process.opened'; readonly process_id: string; readonly evidence: Seq }
  | { readonly type: 'process.transition'; readonly event: ProcessEvent }
  | {
      readonly type: 'input.routed';
      readonly seq: Seq;
      readonly route: RouteOutcome;
      readonly decided_by: 'operator' | 'rule' | 'site';
      readonly evidence: Seq;
      readonly target: string | null;
    }
  | { readonly type: 'input.released'; readonly seq: Seq; readonly evidence: Seq };
export type WorkstreamRefusal =
  | 'invalid_id'
  | 'invalid_origin'
  | 'invalid_evidence'
  | 'duplicate_workstream'
  | 'unknown_workstream'
  | 'goal_active'
  | 'goal_attached'
  | 'goal_not_active'
  | 'input_out_of_order'
  | 'no_active_goal'
  | 'stale_revision'
  | 'invalid_event'
  | 'work_in_flight'
  | 'process_live'
  | 'duplicate_process'
  | 'no_process'
  | 'unknown_input'
  | 'not_next'
  | ProcessRefusal;
export type WorkstreamResult =
  | { readonly ok: true; readonly index: WorkstreamIndex; readonly workstream: Workstream }
  | { readonly ok: false; readonly reason: WorkstreamRefusal };

/** A bounded identifier: never a locator, never credential-shaped. */
export function boundedId(value: unknown): value is string {
  return typeof value === 'string' && correlation(value) === value;
}
export function validSeq(value: unknown): value is Seq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function refuse(reason: WorkstreamRefusal): WorkstreamResult {
  return { ok: false, reason };
}
const ROUTES: readonly string[] = SITE_POLICY['input.route'].options;
/** Outcomes that act on the active goal's work. */
const ACTIVE_ONLY: readonly string[] = ['steer', 'interrupt', 'queue'];

export function emptyWorkstreamIndex(project_id: string): WorkstreamIndex {
  return { project_id, workstreams: [] };
}
export function activeGoal(workstream: Workstream): string | null {
  const last = workstream.goals.at(-1);
  return last !== undefined && last.ended_at === null ? last.goal_id : null;
}

/** Opening grants nothing, attaches no goal and starts no work. Unknown request fields are not copied. */
export function openWorkstream(
  index: WorkstreamIndex,
  request: {
    readonly workstream_id: string;
    readonly origin: WorkstreamOrigin;
    readonly evidence: Seq;
  },
): WorkstreamResult {
  if (!boundedId(index.project_id) || !boundedId(request.workstream_id)) return refuse('invalid_id');
  if (request.origin !== 'operator' && request.origin !== 'route') return refuse('invalid_origin');
  if (!validSeq(request.evidence)) return refuse('invalid_evidence');
  if (index.workstreams.some((item) => item.workstream_id === request.workstream_id))
    return refuse('duplicate_workstream');
  const workstream: Workstream = {
    schema: WORKSTREAM_SCHEMA,
    workstream_id: request.workstream_id,
    project_id: index.project_id,
    origin: request.origin,
    opened_at: request.evidence,
    revision: 0,
    goals: [],
    inputs: [],
    artifacts: [],
    process: null,
  };
  return {
    ok: true,
    index: { project_id: index.project_id, workstreams: [...index.workstreams, workstream] },
    workstream,
  };
}

/** Replaces one workstream in the index; every other workstream is the same object. */
export function replaceWorkstream(index: WorkstreamIndex, next: Workstream): WorkstreamResult {
  return {
    ok: true,
    index: {
      project_id: index.project_id,
      workstreams: index.workstreams.map((item) => (item.workstream_id === next.workstream_id ? next : item)),
    },
    workstream: next,
  };
}

function next(
  workstream: Workstream,
  change: Partial<Pick<Workstream, 'goals' | 'inputs' | 'artifacts' | 'process'>>,
): Workstream {
  return {
    schema: WORKSTREAM_SCHEMA,
    workstream_id: workstream.workstream_id,
    project_id: workstream.project_id,
    origin: workstream.origin,
    opened_at: workstream.opened_at,
    revision: workstream.revision + 1,
    goals: change.goals ?? workstream.goals,
    inputs: change.inputs ?? workstream.inputs,
    artifacts: change.artifacts ?? workstream.artifacts,
    process: change.process === undefined ? workstream.process : change.process,
  };
}

export function transitionWorkstream(
  index: WorkstreamIndex,
  workstream_id: string,
  event: WorkstreamEvent,
): WorkstreamResult {
  const workstream = index.workstreams.find((item) => item.workstream_id === workstream_id);
  if (!workstream) return refuse('unknown_workstream');
  const active = activeGoal(workstream);
  switch (event.type) {
    case 'goal.attached': {
      if (!boundedId(event.goal_id)) return refuse('invalid_id');
      if (!validSeq(event.evidence)) return refuse('invalid_evidence');
      if (active !== null) return refuse('goal_active');
      if (index.workstreams.some((item) => item.goals.some((goal) => goal.goal_id === event.goal_id)))
        return refuse('goal_attached');
      return replaceWorkstream(
        index,
        next(workstream, {
          goals: [...workstream.goals, { goal_id: event.goal_id, attached_at: event.evidence, ended_at: null }],
        }),
      );
    }
    case 'goal.ended': {
      if (!boundedId(event.goal_id)) return refuse('invalid_id');
      if (!validSeq(event.evidence)) return refuse('invalid_evidence');
      if (active !== event.goal_id) return refuse('goal_not_active');
      if (workstream.process?.state === 'running' || workstream.process?.state === 'waiting')
        return refuse('work_in_flight');
      return replaceWorkstream(
        index,
        next(workstream, {
          goals: workstream.goals.map((goal) =>
            goal.goal_id === event.goal_id && goal.ended_at === null
              ? { goal_id: goal.goal_id, attached_at: goal.attached_at, ended_at: event.evidence }
              : goal,
          ),
        }),
      );
    }
    case 'input.recorded': {
      if (!validSeq(event.seq)) return refuse('invalid_evidence');
      const last = workstream.inputs.at(-1);
      if (last !== undefined && event.seq <= last.seq) return refuse('input_out_of_order');
      return replaceWorkstream(
        index,
        next(workstream, {
          inputs: [
            ...workstream.inputs,
            { seq: event.seq, route: null, decided_by: null, routed_at: null, target: null, held: false },
          ],
        }),
      );
    }
    case 'artifact.recorded': {
      if (!boundedId(event.artifact_id)) return refuse('invalid_id');
      if (!validSeq(event.evidence)) return refuse('invalid_evidence');
      if (active === null) return refuse('no_active_goal');
      const previous = workstream.artifacts.filter((item) => item.artifact_id === event.artifact_id).at(-1);
      if (
        !Number.isSafeInteger(event.revision) ||
        event.revision < 0 ||
        (previous !== undefined && event.revision <= previous.revision)
      )
        return refuse('stale_revision');
      return replaceWorkstream(
        index,
        next(workstream, {
          artifacts: [
            ...workstream.artifacts,
            { artifact_id: event.artifact_id, revision: event.revision, goal_id: active, evidence: event.evidence },
          ],
        }),
      );
    }
    case 'process.opened': {
      if (workstream.process !== null && isLive(workstream.process)) return refuse('process_live');
      if (workstream.process?.process_id === event.process_id) return refuse('duplicate_process');
      const opened = openProcess(event.process_id, workstream.workstream_id, event.evidence);
      if (!opened.ok) return refuse(opened.reason);
      return replaceWorkstream(index, next(workstream, { process: opened.process }));
    }
    case 'process.transition': {
      const process = workstream.process;
      if (process === null) return refuse('no_process');
      const result = transitionProcess(process, event.event);
      if (!result.ok) return refuse(result.reason);
      // Work runs only under the workstream's active goal; idle and paused hold none in flight.
      const working = result.process.state === 'running' || result.process.state === 'waiting';
      const entered = event.event.type === 'started' || event.event.type === 'resumed';
      if (working && entered && active === null) return refuse('no_active_goal');
      return replaceWorkstream(index, next(workstream, { process: result.process }));
    }
    case 'input.routed': {
      if (!validSeq(event.seq) || !validSeq(event.evidence)) return refuse('invalid_evidence');
      if (!ROUTES.includes(event.route) || !['operator', 'rule', 'site'].includes(event.decided_by))
        return refuse('invalid_event');
      if (!workstream.inputs.some((input) => input.seq === event.seq)) return refuse('unknown_input');
      if (ACTIVE_ONLY.includes(event.route) && active === null) return refuse('no_active_goal');
      if (event.route === 'parallel') {
        if (!boundedId(event.target)) return refuse('invalid_id');
        if (event.target === workstream_id || !index.workstreams.some((item) => item.workstream_id === event.target)) {
          return refuse('unknown_workstream');
        }
      } else if (event.target !== null) return refuse('invalid_event');
      const placed: WorkstreamInput = {
        seq: event.seq,
        route: event.route,
        decided_by: event.decided_by,
        routed_at: event.evidence,
        target: event.target,
        held: event.route === 'queue',
      };
      return replaceWorkstream(
        index,
        next(workstream, {
          inputs: workstream.inputs.map((input) => (input.seq === event.seq ? placed : input)),
        }),
      );
    }
    case 'input.released': {
      if (!validSeq(event.seq) || !validSeq(event.evidence)) return refuse('invalid_evidence');
      if (active !== null) return refuse('goal_active');
      if (!workstream.inputs.some((input) => input.seq === event.seq)) return refuse('unknown_input');
      if (workstream.inputs.find((input) => input.held)?.seq !== event.seq) return refuse('not_next');
      return replaceWorkstream(
        index,
        next(workstream, {
          inputs: workstream.inputs.map((input) => (input.seq === event.seq ? { ...input, held: false } : input)),
        }),
      );
    }
    default:
      return refuse('invalid_event');
  }
}
