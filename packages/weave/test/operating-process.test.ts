import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROCESS_STATES,
  openProcess,
  transitionProcess,
  type OperatingProcess,
  type ProcessEvent,
  type ProcessResult,
  type ProcessState,
} from '../src/operating-process.js';
import {
  emptyWorkstreamIndex,
  openWorkstream,
  transitionWorkstream,
  type Workstream,
  type WorkstreamIndex,
  type WorkstreamResult,
} from '../src/workstream.js';

const KEYS = [
  'schema',
  'process_id',
  'workstream_id',
  'state',
  'revision',
  'waiting_on',
  'pause_requested',
  'stop_requested',
  'paused_from',
  'resume_point',
  'stop_reason',
  'evidence',
];
const POINT = { ref: 'snap-1', digest: 'a'.repeat(64) };

function ok(result: ProcessResult): OperatingProcess {
  if (!result.ok) assert.fail(`refused: ${result.reason}`);
  return result.process;
}
function refused(result: ProcessResult | WorkstreamResult, reason: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, reason);
}
function opened(): OperatingProcess {
  return ok(openProcess('proc-1', 'ws-a', 1));
}
/** Drives a fresh process into each state through legal events only. */
function inState(state: ProcessState): OperatingProcess {
  let process = opened();
  const apply = (event: ProcessEvent) => {
    process = ok(transitionProcess(process, event));
  };
  if (state === 'idle') return process;
  if (state === 'complete') {
    apply({ type: 'completed', evidence: 2 });
    return process;
  }
  if (state === 'stopped') {
    apply({ type: 'stop_requested', evidence: 2 });
    apply({ type: 'stopped', reason: 'requested', evidence: 3 });
    return process;
  }
  apply({ type: 'started', evidence: 2 });
  if (state === 'running') return process;
  if (state === 'waiting') {
    apply({ type: 'waiting', on: 'approval', evidence: 3 });
    return process;
  }
  apply({ type: 'pause_requested', evidence: 3 });
  apply({ type: 'paused', resume_point: POINT, evidence: 4 });
  return process;
}

test('a process opens idle with fixed keys and no authority fields', () => {
  const process = opened();
  assert.deepEqual(Object.keys(process), KEYS);
  assert.deepEqual(process, {
    schema: 'operating.process@1',
    process_id: 'proc-1',
    workstream_id: 'ws-a',
    state: 'idle',
    revision: 0,
    waiting_on: null,
    pause_requested: null,
    stop_requested: null,
    paused_from: null,
    resume_point: null,
    stop_reason: null,
    evidence: 1,
  });
  assert.deepEqual([...PROCESS_STATES], ['idle', 'running', 'waiting', 'paused', 'complete', 'stopped']);
  for (const key of KEYS) assert.doesNotMatch(key, /grant|approval|budget|reservation|scope|authority/);
  refused(openProcess('a/b', 'ws-a', 1), 'invalid_id');
  refused(openProcess('proc-1', 'ws-a', -1), 'invalid_evidence');
});

test('plain lifecycle events are legal only from the states the contract lists', () => {
  const legal: Record<string, readonly ProcessState[]> = {
    started: ['idle'],
    waiting: ['running'],
    woke: ['waiting'],
    yielded: ['running'],
    completed: ['idle', 'running'],
  };
  const target: Record<string, ProcessState> = {
    started: 'running',
    waiting: 'waiting',
    woke: 'running',
    yielded: 'idle',
    completed: 'complete',
  };
  for (const state of PROCESS_STATES) {
    for (const type of Object.keys(legal)) {
      const event = (
        type === 'waiting' ? { type, on: 'capability', evidence: 9 } : { type, evidence: 9 }
      ) as ProcessEvent;
      const before = inState(state);
      const result = transitionProcess(before, event);
      if (legal[type]!.includes(state)) {
        assert.equal(result.ok, true, `${type} from ${state}`);
        if (result.ok) {
          assert.equal(result.process.state, target[type]);
          assert.equal(result.process.revision, before.revision + 1);
          assert.equal(result.process.evidence, 9);
        }
      } else {
        refused(result, state === 'complete' || state === 'stopped' ? 'terminal' : 'illegal_transition');
      }
    }
  }
  const waiting = inState('waiting');
  assert.equal(waiting.waiting_on, 'approval');
  assert.equal(ok(transitionProcess(waiting, { type: 'woke', evidence: 9 })).waiting_on, null);
  refused(
    transitionProcess(inState('running'), { type: 'waiting', on: 'operator' as 'approval', evidence: 9 }),
    'invalid_event',
  );
  refused(
    transitionProcess(inState('idle'), { type: 'teleport', evidence: 9 } as unknown as ProcessEvent),
    'invalid_event',
  );
});

test('a pause is requested, honoured at a boundary with a resume point, and resumed by digest', () => {
  let process = inState('running');
  refused(transitionProcess(process, { type: 'paused', resume_point: POINT, evidence: 3 }), 'no_pause_request');
  process = ok(transitionProcess(process, { type: 'pause_requested', evidence: 3 }));
  assert.equal(process.state, 'running', 'a request does not tear down work in flight');
  assert.equal(process.pause_requested, 3);
  refused(transitionProcess(process, { type: 'pause_requested', evidence: 4 }), 'already_requested');
  refused(
    transitionProcess(process, { type: 'paused', resume_point: { ref: 'a/b', digest: POINT.digest }, evidence: 4 }),
    'invalid_resume_point',
  );
  refused(
    transitionProcess(process, { type: 'paused', resume_point: { ref: 'snap-1', digest: 'ABC' }, evidence: 4 }),
    'invalid_resume_point',
  );
  process = ok(transitionProcess(process, { type: 'paused', resume_point: POINT, evidence: 4 }));
  assert.equal(process.state, 'paused');
  assert.equal(process.paused_from, 'running');
  assert.equal(process.pause_requested, null, 'the request was honoured');
  assert.deepEqual(process.resume_point, POINT);
  refused(transitionProcess(process, { type: 'pause_requested', evidence: 5 }), 'illegal_transition');
  const edited = transitionProcess(process, { type: 'resumed', digest: 'b'.repeat(64), evidence: 5 });
  refused(edited, 'resume_point_mismatch');
  assert.equal(process.state, 'paused');
  process = ok(transitionProcess(process, { type: 'resumed', digest: POINT.digest, evidence: 6 }));
  assert.equal(process.state, 'running');
  assert.equal(process.resume_point, null);
  assert.equal(process.paused_from, null);
  assert.deepEqual(Object.keys(process), KEYS, 'resuming adds no grant, approval or budget');
});

test('a process paused while waiting resumes to waiting; an idle one to idle', () => {
  let waiting = inState('waiting');
  waiting = ok(transitionProcess(waiting, { type: 'pause_requested', evidence: 4 }));
  waiting = ok(transitionProcess(waiting, { type: 'paused', resume_point: POINT, evidence: 5 }));
  assert.equal(waiting.waiting_on, 'approval');
  const back = ok(transitionProcess(waiting, { type: 'resumed', digest: POINT.digest, evidence: 6 }));
  assert.equal(back.state, 'waiting');
  assert.equal(back.waiting_on, 'approval');
  let idle = ok(transitionProcess(inState('idle'), { type: 'pause_requested', evidence: 2 }));
  refused(transitionProcess(idle, { type: 'started', evidence: 3 }), 'request_pending');
  idle = ok(transitionProcess(idle, { type: 'paused', resume_point: POINT, evidence: 3 }));
  assert.equal(ok(transitionProcess(idle, { type: 'resumed', digest: POINT.digest, evidence: 4 })).state, 'idle');
  // A unit of work may finish before the boundary; the pause request stays pending.
  let running = ok(transitionProcess(inState('running'), { type: 'pause_requested', evidence: 3 }));
  running = ok(transitionProcess(running, { type: 'yielded', evidence: 4 }));
  assert.equal(running.pause_requested, 3);
  assert.equal(
    ok(transitionProcess(running, { type: 'paused', resume_point: POINT, evidence: 5 })).paused_from,
    'idle',
  );
});

test('only the matching pending pause request can be withdrawn', () => {
  let process = ok(transitionProcess(inState('running'), { type: 'pause_requested', evidence: 3 }));
  refused(transitionProcess(process, { type: 'pause_withdrawn', request: 2, evidence: 4 }), 'request_mismatch');
  process = ok(transitionProcess(process, { type: 'pause_withdrawn', request: 3, evidence: 4 }));
  assert.equal(process.pause_requested, null);
  refused(transitionProcess(process, { type: 'pause_withdrawn', request: 3, evidence: 5 }), 'no_pause_request');
});

test('no process stops itself without a request; only failure ends work unrequested', () => {
  for (const state of ['idle', 'running', 'waiting', 'paused'] as const) {
    refused(
      transitionProcess(inState(state), { type: 'stopped', reason: 'requested', evidence: 9 }),
      'no_stop_request',
    );
    let process = ok(transitionProcess(inState(state), { type: 'stop_requested', evidence: 8 }));
    assert.equal(process.state, state, 'a stop request does not end work in flight');
    refused(transitionProcess(process, { type: 'stop_requested', evidence: 9 }), 'already_requested');
    if (state === 'idle') refused(transitionProcess(process, { type: 'started', evidence: 9 }), 'request_pending');
    if (state === 'paused')
      refused(transitionProcess(process, { type: 'resumed', digest: POINT.digest, evidence: 9 }), 'request_pending');
    process = ok(transitionProcess(process, { type: 'stopped', reason: 'requested', evidence: 9 }));
    assert.equal(process.state, 'stopped');
    assert.equal(process.stop_reason, 'requested');
    if (state === 'paused')
      assert.deepEqual(process.resume_point, POINT, 'a stopped process keeps its resume point for inspection');
    const failed = transitionProcess(inState(state), { type: 'stopped', reason: 'failed', evidence: 9 });
    if (state === 'running' || state === 'waiting') assert.equal(ok(failed).stop_reason, 'failed');
    else refused(failed, 'illegal_transition');
  }
  for (const state of ['complete', 'stopped'] as const) {
    for (const event of [
      { type: 'pause_requested', evidence: 9 },
      { type: 'stop_requested', evidence: 9 },
      { type: 'resumed', digest: POINT.digest, evidence: 9 },
      { type: 'completed', evidence: 9 },
    ] as ProcessEvent[])
      refused(transitionProcess(inState(state), event), 'terminal');
  }
});

function withGoal(): WorkstreamIndex {
  let index = emptyWorkstreamIndex('proj-1');
  for (const [id, seq] of [
    ['ws-a', 1],
    ['ws-b', 2],
  ] as const) {
    const opened = openWorkstream(index, { workstream_id: id, origin: 'operator', evidence: seq });
    assert.ok(opened.ok);
    if (opened.ok) index = opened.index;
  }
  return step(index, 'ws-a', { type: 'goal.attached', goal_id: 'g-1', evidence: 3 });
}
function step(index: WorkstreamIndex, id: string, event: Parameters<typeof transitionWorkstream>[2]): WorkstreamIndex {
  const result = transitionWorkstream(index, id, event);
  if (!result.ok) assert.fail(`refused: ${result.reason}`);
  return result.index;
}
function stream(index: WorkstreamIndex, id: string): Workstream {
  return index.workstreams.find((item) => item.workstream_id === id)!;
}

test('a workstream outlives its processes and holds at most one live process', () => {
  let index = withGoal();
  assert.equal(stream(index, 'ws-a').process, null);
  refused(
    transitionWorkstream(index, 'ws-a', { type: 'process.transition', event: { type: 'started', evidence: 4 } }),
    'no_process',
  );
  index = step(index, 'ws-a', { type: 'process.opened', process_id: 'proc-1', evidence: 4 });
  assert.equal(stream(index, 'ws-a').process?.workstream_id, 'ws-a');
  refused(
    transitionWorkstream(index, 'ws-a', { type: 'process.opened', process_id: 'proc-2', evidence: 5 }),
    'process_live',
  );
  index = step(index, 'ws-a', { type: 'input.recorded', seq: 5 });
  index = step(index, 'ws-a', { type: 'process.transition', event: { type: 'started', evidence: 6 } });
  index = step(index, 'ws-a', { type: 'artifact.recorded', artifact_id: 'doc-1', revision: 1, evidence: 7 });
  index = step(index, 'ws-a', { type: 'process.transition', event: { type: 'completed', evidence: 8 } });
  refused(
    transitionWorkstream(index, 'ws-a', { type: 'process.opened', process_id: 'proc-1', evidence: 9 }),
    'duplicate_process',
  );
  index = step(index, 'ws-a', { type: 'process.opened', process_id: 'proc-2', evidence: 9 });
  const after = stream(index, 'ws-a');
  assert.equal(after.process?.process_id, 'proc-2');
  assert.equal(after.process?.state, 'idle');
  assert.deepEqual(after.goals, [{ goal_id: 'g-1', attached_at: 3, ended_at: null }]);
  assert.deepEqual(after.inputs, [{ seq: 5 }]);
  assert.equal(after.artifacts.length, 1);
});

test('work runs only under an active goal, and a goal cannot end while work is in flight', () => {
  let index = withGoal();
  index = step(index, 'ws-b', { type: 'process.opened', process_id: 'proc-b', evidence: 4 });
  refused(
    transitionWorkstream(index, 'ws-b', { type: 'process.transition', event: { type: 'started', evidence: 5 } }),
    'no_active_goal',
  );
  index = step(index, 'ws-a', { type: 'process.opened', process_id: 'proc-a', evidence: 5 });
  index = step(index, 'ws-a', { type: 'process.transition', event: { type: 'started', evidence: 6 } });
  refused(transitionWorkstream(index, 'ws-a', { type: 'goal.ended', goal_id: 'g-1', evidence: 7 }), 'work_in_flight');
  index = step(index, 'ws-a', {
    type: 'process.transition',
    event: { type: 'waiting', on: 'dependency', evidence: 7 },
  });
  refused(transitionWorkstream(index, 'ws-a', { type: 'goal.ended', goal_id: 'g-1', evidence: 8 }), 'work_in_flight');
  index = step(index, 'ws-a', { type: 'process.transition', event: { type: 'pause_requested', evidence: 8 } });
  index = step(index, 'ws-a', {
    type: 'process.transition',
    event: { type: 'paused', resume_point: POINT, evidence: 9 },
  });
  index = step(index, 'ws-a', { type: 'goal.ended', goal_id: 'g-1', evidence: 10 });
  refused(
    transitionWorkstream(index, 'ws-a', {
      type: 'process.transition',
      event: { type: 'resumed', digest: POINT.digest, evidence: 11 },
    }),
    'no_active_goal',
  );
  // Process refusals pass through unchanged.
  refused(
    transitionWorkstream(index, 'ws-a', {
      type: 'process.transition',
      event: { type: 'resumed', digest: 'c'.repeat(64), evidence: 11 },
    }),
    'resume_point_mismatch',
  );
});

test('operator input stays available in every process state and leaves the process unchanged', () => {
  const drive: Record<ProcessState, readonly ProcessEvent[]> = {
    idle: [],
    running: [{ type: 'started', evidence: 5 }],
    waiting: [
      { type: 'started', evidence: 5 },
      { type: 'waiting', on: 'capability', evidence: 6 },
    ],
    paused: [
      { type: 'started', evidence: 5 },
      { type: 'pause_requested', evidence: 6 },
      { type: 'paused', resume_point: POINT, evidence: 7 },
    ],
    complete: [{ type: 'completed', evidence: 5 }],
    stopped: [
      { type: 'started', evidence: 5 },
      { type: 'stopped', reason: 'failed', evidence: 6 },
    ],
  };
  for (const state of PROCESS_STATES) {
    let index = step(withGoal(), 'ws-a', { type: 'process.opened', process_id: 'proc-1', evidence: 4 });
    for (const event of drive[state]) index = step(index, 'ws-a', { type: 'process.transition', event });
    const process = stream(index, 'ws-a').process;
    assert.equal(process?.state, state);
    index = step(index, 'ws-a', { type: 'input.recorded', seq: 20 });
    assert.deepEqual(stream(index, 'ws-a').process, process, `input while ${state}`);
    assert.deepEqual(stream(index, 'ws-a').inputs, [{ seq: 20 }]);
  }
});

test('processes of different workstreams are independent', () => {
  let index = withGoal();
  index = step(index, 'ws-b', { type: 'goal.attached', goal_id: 'g-2', evidence: 4 });
  index = step(index, 'ws-a', { type: 'process.opened', process_id: 'proc-a', evidence: 5 });
  index = step(index, 'ws-b', { type: 'process.opened', process_id: 'proc-b', evidence: 6 });
  index = step(index, 'ws-a', { type: 'process.transition', event: { type: 'started', evidence: 7 } });
  index = step(index, 'ws-b', { type: 'process.transition', event: { type: 'started', evidence: 8 } });
  const b = stream(index, 'ws-b');
  index = step(index, 'ws-a', { type: 'process.transition', event: { type: 'pause_requested', evidence: 9 } });
  index = step(index, 'ws-a', {
    type: 'process.transition',
    event: { type: 'paused', resume_point: POINT, evidence: 10 },
  });
  assert.equal(stream(index, 'ws-a').process?.state, 'paused');
  assert.equal(stream(index, 'ws-b'), b, 'the other workstream is the same record');
  assert.equal(stream(index, 'ws-b').process?.state, 'running');
});
