/**
 * Loom's Weft emission (packages/weft/src/WEFT-CONTRACT.md, Emission).
 *
 * The port is declared here so Loom never imports Weft. Records are a
 * projection of what Loom already recorded: built after the transition they
 * report, from fresh values, and never read back. They reach the port only
 * once Loom's step has completed, so a sink that calls back into the Runtime
 * never sees, or changes, a half-applied transition.
 */
import { createHash } from 'node:crypto';
import type {
  ActionId,
  ActionRecord,
  ActionResultPayload,
  ActionStartedPayload,
  Candidate,
  CycleRecord,
  InferenceRecordedPayload,
  Observation,
  Seq,
  State,
} from './types.js';

/** A `weft.record@1` as Loom builds it. Weft's validator, not this type, decides whether it is valid. */
export interface WeftRecordShape {
  readonly schema: 'weft.record@1';
  readonly trace_id: string;
  readonly record_id: string;
  readonly emitter: { readonly kind: 'loom' | 'gateway' | 'fabric' | 'external'; readonly id: string };
  readonly sequence: number;
  readonly kind: string;
  readonly thread_id: string | null;
  readonly parent_id: string | null;
  readonly links: readonly { readonly rel: string; readonly record_id: string }[];
  readonly evidence: readonly { readonly source: string; readonly ref: string }[];
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Supplied at composition. Absent: Loom emits nothing and builds nothing. */
export interface WeftPort {
  readonly trace_id: string;
  readonly emitter_id: string;
  emit(record: WeftRecordShape): unknown;
}

type Link = { rel: string; record_id: string };

/** Loom's sequence is the log's highest seq times this, plus an offset, so it keeps rising across recovery. */
const SEQ_STRIDE = 1024;

export class LoomWeft {
  private sequence = 0;
  /** The candidate being dispatched, consumed by the action.queued/started record it produces. */
  private dispatching: Candidate | null = null;
  /** The running cycle's record id. Loom may reuse a cycle number after recovery, so the id adds the trigger. */
  private cycleRecord: string | null = null;
  /** The seq of the goal.opened that opened the current goal: a run may open several goals. */
  private goalSeq: Seq | null = null;
  /** Latest thread per operation and resources, revisions ignored: the thread a new dispatch supersedes. */
  private readonly latest = new Map<string, ActionId>();
  /** Records built during the running step, in order, delivered when it completes. */
  private readonly pending: WeftRecordShape[] = [];
  /** Nesting of Loom steps: an observation appended while a cycle runs is part of the cycle's step. */
  private depth = 0;
  /** Set while records are delivered: a step a sink starts is delivered by the same loop. */
  private flushing = false;

  constructor(private readonly port: WeftPort) {}

  /** A Loom step begins. Steps nest; records wait for the outermost to end. */
  enter(): void {
    this.depth += 1;
  }

  /** A Loom step ends. At the outermost, its records reach the port. */
  leave(): void {
    this.depth -= 1;
    if (this.depth === 0) {
      this.flush();
    }
  }

  /**
   * Deliver pending records. A sink may call back into the Runtime: that call
   * runs as its own step after the one being reported, and its records are
   * delivered here, after the ones already pending.
   */
  private flush(): void {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      for (let i = 0; i < this.pending.length; i += 1) {
        deliver(this.port, this.pending[i] as WeftRecordShape);
      }
    } finally {
      this.pending.length = 0;
      this.flushing = false;
    }
  }

  private id(suffix: string): string {
    return `${this.port.emitter_id}:${suffix}`;
  }

  private send(
    seqHigh: Seq,
    record_id: string,
    kind: string,
    thread_id: string | null,
    parent_id: string | null,
    links: Link[],
    evidence: { source: string; ref: string }[],
    fields: Record<string, unknown>,
  ): void {
    this.sequence = Math.max(this.sequence + 1, seqHigh * SEQ_STRIDE);
    this.pending.push({
      schema: 'weft.record@1',
      trace_id: this.port.trace_id,
      record_id,
      emitter: { kind: 'loom', id: this.port.emitter_id },
      sequence: this.sequence,
      kind,
      thread_id,
      parent_id,
      links,
      evidence,
      fields,
    });
    if (this.depth === 0) {
      this.flush();
    }
  }

  /** A cycle has started; threads it dispatches are its children. */
  cycleStarted(cycle_no: number, trigger: Seq): void {
    this.cycleRecord = this.id(`cycle:${cycle_no}:${trigger}`);
  }

  /** Called by dispatch around recording the action: only a dispatch opens a thread. */
  dispatch(candidate: Candidate | null): void {
    this.dispatching = candidate;
  }

  /** A journaled dispatch loaded at recovery: indexed for supersession, not reported again. */
  loaded(observation: Observation): void {
    if (observation.payload_type === 'goal.opened') {
      this.goalSeq = observation.seq;
    }
    if (observation.payload_type === 'action.started' || observation.payload_type === 'action.queued') {
      const started = observation.payload as ActionStartedPayload;
      this.latest.set(supersedeKey(started), started.action_id);
    }
  }

  /** An accepted observation, after `applyAccepted`. `goalBefore` is the goal status before it. */
  observed(observation: Observation, state: State, goalBefore: string | undefined): void {
    const seq = observation.seq;
    const cite = (): { source: string; ref: string }[] => [{ source: 'observation', ref: `seq:${seq}` }];
    switch (observation.payload_type) {
      case 'goal.opened': {
        const goal = state.goal;
        if (goal) {
          this.goalSeq = seq;
          this.send(seq, this.id(`goal:${seq}`), 'goal.intent', null, null, [], cite(), {
            goal_ref: goal.goal_id,
            statement: {
              content_class: 'private',
              digest: `sha256:${createHash('sha256').update(goal.purpose, 'utf8').digest('hex')}`,
            },
          });
        }
        break;
      }
      case 'action.queued':
      case 'action.started': {
        const started = observation.payload as ActionStartedPayload;
        const action_id = started.action_id;
        const candidate = this.dispatching;
        this.dispatching = null;
        // A queued action that starts later, here or after recovery, was opened when it was dispatched.
        if (candidate !== null && candidate.candidate_id === started.candidate_id) {
          this.openThread(seq, started, candidate);
        }
        const action = state.actions[action_id];
        if (action) {
          this.transition(seq, action, action.state);
        }
        break;
      }
      case 'action.cancel_requested': {
        const { action_id } = observation.payload as { action_id: ActionId };
        const action = state.actions[action_id];
        if (!action) {
          break;
        }
        // Each accepted cancel request is its own record: an operator may repeat one.
        this.send(seq, this.id(`thread:${action_id}:cancelled:${seq}`), 'thread.transition', action_id, null,
          [{ rel: 'cancels', record_id: this.id(`thread:${action_id}:opened`) }], cite(), { transition: 'cancelled' });
        if (action.state === 'cancelled' && action.finished_at === seq) {
          this.transition(seq, action, 'cancelled');
        }
        break;
      }
      case 'action.result': {
        const { action_id } = observation.payload as ActionResultPayload;
        const action = state.actions[action_id];
        if (!action) {
          break;
        }
        const transition = this.transition(seq, action, action.state);
        this.send(seq, this.id(`thread:${action_id}:closed`), 'thread.transition', action_id, null,
          [{ rel: 'caused_by', record_id: transition }], cite(), { transition: 'closed' });
        break;
      }
      case 'weights.recorded': {
        if (observation.source.kind !== 'judgment') {
          break; // a gateway weighing is reported with its inference.recorded
        }
        this.send(seq, this.id(`judgment:${observation.observation_id}`), 'judgment', null, null, [], cite(), {
          site: 'frontier.weigh',
          request_ref: observation.observation_id,
          accepted: true,
        });
        break;
      }
      case 'inference.recorded': {
        const recorded = observation.payload as InferenceRecordedPayload;
        const inference = state.inferences[recorded.request_id];
        const accepted = recorded.status === 'accepted';
        const last = recorded.attempts[recorded.attempts.length - 1];
        const fields: Record<string, unknown> = {
          site: inference?.request.site ?? 'frontier.weigh',
          request_ref: recorded.request_id,
          accepted,
        };
        if (accepted && last) {
          fields['routed_unit'] = last.routed_unit_id;
        }
        this.send(seq, this.id(`judgment:${recorded.request_id}`), 'judgment', null, null, [],
          [{ source: 'observation', ref: `seq:${seq}` }, { source: 'inference_request', ref: recorded.request_id }], fields);
        break;
      }
      default:
        break;
    }
    const goal = state.goal;
    if (goal && goalBefore === 'active' && goal.status !== 'active') {
      this.send(seq, this.id(`outcome:goal:${this.goalSeq ?? seq}`), 'outcome', null, null, [], cite(), {
        subject: 'goal',
        subject_ref: goal.goal_id,
        status: goal.status,
      });
    }
  }

  private openThread(seq: Seq, started: ActionStartedPayload, candidate: Candidate): void {
    const action_id = started.action_id;
    const opened = this.id(`thread:${action_id}:opened`);
    const evidence = [{ source: 'observation', ref: `seq:${seq}` }];
    this.send(seq, opened, 'thread.transition', action_id, this.cycleRecord, [],
      [...evidence], { transition: 'opened' });
    if (candidate.dependencies.length > 0) {
      this.send(seq, this.id(`thread:${action_id}:joined`), 'thread.transition', action_id, null,
        candidate.dependencies.map((dep) => ({ rel: 'joins', record_id: this.id(`thread:${dep}:closed`) })),
        [...evidence], { transition: 'joined' });
    }
    const key = supersedeKey(started);
    const previous = this.latest.get(key);
    if (previous !== undefined && previous !== action_id) {
      this.send(seq, this.id(`thread:${previous}:superseded`), 'thread.transition', previous, null,
        [{ rel: 'supersedes', record_id: opened }], [...evidence], { transition: 'superseded' });
    }
    this.latest.set(key, action_id);
  }

  private transition(seq: Seq, action: ActionRecord, state: string): string {
    const record_id = this.id(`action:${action.action_id}:${state}`);
    this.send(seq, record_id, 'action.transition', action.action_id, null, [],
      [{ source: 'observation', ref: `seq:${seq}` }, { source: 'invocation', ref: action.invocation_id ?? action.action_id }], {
        action_ref: action.action_id,
        operation: action.operation,
        state,
        contract_rev: action.contract_rev,
      });
    return record_id;
  }

  /** A cycle has been recorded. `trigger` is the observation that started it. */
  cycle(record: CycleRecord, trigger: Seq, seqHigh: Seq): void {
    const selected = new Set(record.selected.map((s) => s.candidate_id));
    const rejected = new Map(record.not_selected.map((n) => [n.candidate_id, n.reason]));
    const evidence = [{ source: 'observation', ref: `seq:${trigger}` }];
    if (record.weights_ref !== null && record.weights_ref !== trigger) {
      evidence.push({ source: 'observation', ref: `seq:${record.weights_ref}` });
    }
    this.send(seqHigh, this.id(`cycle:${record.cycle_no}:${trigger}`), 'cycle.weighed', null, null, [], evidence, {
      cycle_no: record.cycle_no,
      state_revision: record.state_revision,
      procedure: record.procedure,
      weights_ref: record.weights_ref === null ? null : `seq:${record.weights_ref}`,
      cost_micros: record.cost_micros,
      candidates: record.candidates.map((candidate) => {
        const allowed = candidate.eligibility.status === 'allowed';
        const reason = rejected.get(candidate.candidate_id);
        return {
          candidate_ref: candidate.candidate_id.replace('#', ':'),
          operation: candidate.operation,
          eligibility: candidate.eligibility.status,
          weight: allowed ? candidate.weight : null,
          disposition: !allowed
            ? 'policy_filtered'
            : selected.has(candidate.candidate_id)
              ? 'selected'
              : reason !== undefined && reason !== 'deferred'
                ? reason
                : 'not_reached',
        };
      }),
    });
  }
}

/** Operation plus the resources it reads and writes, revisions ignored. */
function supersedeKey(started: ActionStartedPayload): string {
  const resources: string[] = [];
  for (const entry of started.read_set) {
    resources.push('resource' in entry ? `r:${entry.resource}` : `s:${entry.state_field}`);
  }
  for (const effect of started.effects) {
    resources.push(`${effect.mode}:${effect.resource}`);
  }
  return `${started.operation}\u0000${resources.sort().join('\u0000')}`;
}

/**
 * Hand one record to the port. Emission is one-way: a throw is swallowed, a
 * returned promise is never awaited and its rejection is handled.
 */
function deliver(port: WeftPort, record: WeftRecordShape): void {
  try {
    const result: unknown = port.emit(record);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      const then = (result as { then?: unknown }).then;
      if (typeof then === 'function') {
        (then as (resolved: undefined, rejected: () => void) => unknown).call(result, undefined, ignore);
      }
    }
  } catch {
    // The sink's failure is the sink's: it never reaches state or scheduling.
  }
}

function ignore(): void {}
