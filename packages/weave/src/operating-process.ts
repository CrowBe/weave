/**
 * Operating processes (#28), per WORKSTREAM-CONTRACT.md: the explicit execution state of one workstream's
 * work, separate from its conversation. Loom owns every transition; a provider reports boundaries and the
 * operator or policy requests. The record holds no grant, approval or budget, and no transition creates one.
 */
import { correlation } from './sites/index.js';
import type { Seq } from './types.js';

export const PROCESS_SCHEMA = 'operating.process@1' as const;
export const PROCESS_STATES = ['idle', 'running', 'waiting', 'paused', 'complete', 'stopped'] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];
export type WaitReason = 'approval' | 'capability' | 'dependency';
const WAIT_REASONS: readonly string[] = ['approval', 'capability', 'dependency'];
/** An opaque reference under Loom's custody and the SHA-256 digest of what it names. */
export interface ResumePoint {
  readonly ref: string;
  readonly digest: string;
}
export interface OperatingProcess {
  readonly schema: typeof PROCESS_SCHEMA;
  readonly process_id: string;
  readonly workstream_id: string;
  readonly state: ProcessState;
  readonly revision: number;
  readonly waiting_on: WaitReason | null;
  /** Evidence of a pending pause request. */
  readonly pause_requested: Seq | null;
  /** Evidence of a stop request. */
  readonly stop_requested: Seq | null;
  readonly paused_from: 'idle' | 'running' | 'waiting' | null;
  readonly resume_point: ResumePoint | null;
  readonly stop_reason: 'requested' | 'failed' | null;
  readonly evidence: Seq;
}
export type ProcessEvent =
  | {
      readonly type: 'started' | 'woke' | 'yielded' | 'completed' | 'pause_requested' | 'stop_requested';
      readonly evidence: Seq;
    }
  | { readonly type: 'waiting'; readonly on: WaitReason; readonly evidence: Seq }
  | { readonly type: 'pause_withdrawn'; readonly request: Seq; readonly evidence: Seq }
  | { readonly type: 'paused'; readonly resume_point: ResumePoint; readonly evidence: Seq }
  | { readonly type: 'resumed'; readonly digest: string; readonly evidence: Seq }
  | { readonly type: 'stopped'; readonly reason: 'requested' | 'failed'; readonly evidence: Seq };
export type ProcessRefusal =
  | 'illegal_transition'
  | 'terminal'
  | 'request_pending'
  | 'already_requested'
  | 'request_mismatch'
  | 'no_pause_request'
  | 'no_stop_request'
  | 'invalid_resume_point'
  | 'resume_point_mismatch'
  | 'invalid_id'
  | 'invalid_evidence'
  | 'invalid_event';
export type ProcessResult =
  | { readonly ok: true; readonly process: OperatingProcess }
  | { readonly ok: false; readonly reason: ProcessRefusal };

function seq(value: unknown): value is Seq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** A bounded opaque identifier; `correlation(null)` is null, so the type is checked first. */
function boundedRef(value: unknown): value is string {
  return typeof value === 'string' && correlation(value) === value;
}
function refuse(reason: ProcessRefusal): ProcessResult {
  return { ok: false, reason };
}
export function isLive(process: OperatingProcess): boolean {
  return process.state !== 'complete' && process.state !== 'stopped';
}

export function openProcess(process_id: string, workstream_id: string, evidence: Seq): ProcessResult {
  if (!boundedRef(process_id) || !boundedRef(workstream_id)) return refuse('invalid_id');
  if (!seq(evidence)) return refuse('invalid_evidence');
  return {
    ok: true,
    process: {
      schema: PROCESS_SCHEMA,
      process_id,
      workstream_id,
      state: 'idle',
      revision: 0,
      waiting_on: null,
      pause_requested: null,
      stop_requested: null,
      paused_from: null,
      resume_point: null,
      stop_reason: null,
      evidence,
    },
  };
}

type Change = Partial<Omit<OperatingProcess, 'schema' | 'process_id' | 'workstream_id' | 'revision' | 'evidence'>>;
function move(process: OperatingProcess, evidence: Seq, change: Change): ProcessResult {
  const field = <K extends keyof Change>(key: K): OperatingProcess[K] =>
    (change[key] === undefined ? process[key] : change[key]) as OperatingProcess[K];
  return {
    ok: true,
    process: {
      schema: PROCESS_SCHEMA,
      process_id: process.process_id,
      workstream_id: process.workstream_id,
      state: field('state'),
      revision: process.revision + 1,
      waiting_on: field('waiting_on'),
      pause_requested: field('pause_requested'),
      stop_requested: field('stop_requested'),
      paused_from: field('paused_from'),
      resume_point: field('resume_point'),
      stop_reason: field('stop_reason'),
      evidence,
    },
  };
}

/** Pure lifecycle rule. A refusal leaves the process as it was. */
export function transitionProcess(process: OperatingProcess, event: ProcessEvent): ProcessResult {
  if (!seq(event.evidence)) return refuse('invalid_evidence');
  if (!isLive(process)) return refuse('terminal');
  const state = process.state;
  const requested = process.pause_requested !== null || process.stop_requested !== null;
  switch (event.type) {
    case 'started':
      if (state !== 'idle') return refuse('illegal_transition');
      if (requested) return refuse('request_pending');
      return move(process, event.evidence, { state: 'running' });
    case 'waiting':
      if (!WAIT_REASONS.includes(event.on)) return refuse('invalid_event');
      if (state !== 'running') return refuse('illegal_transition');
      return move(process, event.evidence, { state: 'waiting', waiting_on: event.on });
    case 'woke':
      if (state !== 'waiting') return refuse('illegal_transition');
      return move(process, event.evidence, { state: 'running', waiting_on: null });
    case 'yielded':
      if (state !== 'running') return refuse('illegal_transition');
      return move(process, event.evidence, { state: 'idle' });
    case 'completed':
      if (state !== 'idle' && state !== 'running') return refuse('illegal_transition');
      return move(process, event.evidence, { state: 'complete' });
    case 'pause_requested':
      if (state === 'paused') return refuse('illegal_transition');
      if (process.pause_requested !== null) return refuse('already_requested');
      return move(process, event.evidence, { pause_requested: event.evidence });
    case 'pause_withdrawn':
      if (state === 'paused') return refuse('illegal_transition');
      if (process.pause_requested === null) return refuse('no_pause_request');
      if (event.request !== process.pause_requested) return refuse('request_mismatch');
      return move(process, event.evidence, { pause_requested: null });
    case 'paused': {
      if (state !== 'idle' && state !== 'running' && state !== 'waiting') return refuse('illegal_transition');
      if (process.pause_requested === null) return refuse('no_pause_request');
      const point = event.resume_point;
      if (
        point === null ||
        typeof point !== 'object' ||
        !boundedRef(point.ref) ||
        typeof point.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(point.digest)
      )
        return refuse('invalid_resume_point');
      return move(process, event.evidence, {
        state: 'paused',
        paused_from: state,
        pause_requested: null,
        resume_point: { ref: point.ref, digest: point.digest },
      });
    }
    case 'resumed':
      if (state !== 'paused' || process.paused_from === null || process.resume_point === null)
        return refuse('illegal_transition');
      if (process.stop_requested !== null) return refuse('request_pending');
      if (event.digest !== process.resume_point.digest) return refuse('resume_point_mismatch');
      return move(process, event.evidence, { state: process.paused_from, paused_from: null, resume_point: null });
    case 'stop_requested':
      if (process.stop_requested !== null) return refuse('already_requested');
      return move(process, event.evidence, { stop_requested: event.evidence });
    case 'stopped':
      if (event.reason === 'requested') {
        if (process.stop_requested === null) return refuse('no_stop_request');
      } else if (event.reason === 'failed') {
        if (state !== 'running' && state !== 'waiting') return refuse('illegal_transition');
      } else return refuse('invalid_event');
      return move(process, event.evidence, { state: 'stopped', stop_reason: event.reason });
    default:
      return refuse('invalid_event');
  }
}
