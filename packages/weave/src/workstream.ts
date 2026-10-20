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
import { correlation } from './sites/index.js';
import type { Seq } from './types.js';

export const WORKSTREAM_SCHEMA = 'workstream@1' as const;
export type WorkstreamOrigin = 'operator' | 'route';
export interface WorkstreamGoal {
  readonly goal_id: string;
  readonly attached_at: Seq;
  readonly ended_at: Seq | null;
}
export interface WorkstreamInput {
  readonly seq: Seq;
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
  | { readonly type: 'process.transition'; readonly event: ProcessEvent };
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
      return replaceWorkstream(index, next(workstream, { inputs: [...workstream.inputs, { seq: event.seq }] }));
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
    default:
      return refuse('invalid_event');
  }
}
