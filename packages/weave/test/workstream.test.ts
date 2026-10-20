import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeGoal,
  emptyWorkstreamIndex,
  openWorkstream,
  transitionWorkstream,
  type WorkstreamIndex,
  type WorkstreamResult,
} from '../src/workstream.js';

const KEYS = [
  'schema',
  'workstream_id',
  'project_id',
  'origin',
  'opened_at',
  'revision',
  'goals',
  'inputs',
  'artifacts',
];

function ok(result: WorkstreamResult): WorkstreamIndex {
  if (!result.ok) assert.fail(`refused: ${result.reason}`);
  return result.index;
}
function refused(result: WorkstreamResult, reason: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, reason);
}
function two(): WorkstreamIndex {
  let index = emptyWorkstreamIndex('proj-1');
  index = ok(openWorkstream(index, { workstream_id: 'ws-a', origin: 'operator', evidence: 1 }));
  return ok(openWorkstream(index, { workstream_id: 'ws-b', origin: 'route', evidence: 2 }));
}

test('opening a workstream records only identity, origin and evidence', () => {
  const result = openWorkstream(emptyWorkstreamIndex('proj-1'), {
    workstream_id: 'ws-a',
    origin: 'operator',
    evidence: 4,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.workstream), KEYS);
  assert.deepEqual(result.workstream, {
    schema: 'workstream@1',
    workstream_id: 'ws-a',
    project_id: 'proj-1',
    origin: 'operator',
    opened_at: 4,
    revision: 0,
    goals: [],
    inputs: [],
    artifacts: [],
  });
  assert.deepEqual(result.index.workstreams, [result.workstream]);
  assert.equal(activeGoal(result.workstream), null);
});

test('ids are bounded identifiers, unique in the project, and evidence is a seq', () => {
  const index = two();
  for (const workstream_id of ['', 'a/b', 'https://x', '../up', 'sk-secret', `w${'x'.repeat(128)}`, ' ws']) {
    refused(openWorkstream(index, { workstream_id, origin: 'operator', evidence: 3 }), 'invalid_id');
  }
  refused(openWorkstream(index, { workstream_id: 'ws-a', origin: 'operator', evidence: 3 }), 'duplicate_workstream');
  for (const evidence of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    refused(openWorkstream(index, { workstream_id: 'ws-c', origin: 'operator', evidence }), 'invalid_evidence');
  }
  refused(
    openWorkstream(index, { workstream_id: 'ws-c', origin: 'model' as 'operator', evidence: 3 }),
    'invalid_origin',
  );
  refused(
    openWorkstream(emptyWorkstreamIndex('a/b'), { workstream_id: 'ws-c', origin: 'operator', evidence: 3 }),
    'invalid_id',
  );
});

test('project availability grants a workstream no context, access, disclosure or visibility', () => {
  const plain = openWorkstream(emptyWorkstreamIndex('proj-1'), {
    workstream_id: 'ws-a',
    origin: 'operator',
    evidence: 1,
  });
  // A caller cannot smuggle availability into the record: unknown request fields are ignored.
  const smuggled = openWorkstream(emptyWorkstreamIndex('proj-1'), {
    workstream_id: 'ws-a',
    origin: 'operator',
    evidence: 1,
    resources: ['repo:main'],
    attachments: [{ label: 'Repo', kind: 'repository' }],
    grants: [{ effects: ['write'] }],
    slices: ['availability'],
    disclosure: 'all',
    visible: true,
  } as unknown as Parameters<typeof openWorkstream>[1]);
  assert.deepEqual(smuggled, plain);
  assert.ok(plain.ok);
  const forbidden = /resource|availab|attachment|grant|slice|disclos|visib|context|authority|scope/;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        assert.doesNotMatch(key, forbidden, `workstream record key ${key}`);
        walk(inner);
      }
    }
  };
  // A goal is attached by id: its authority stays with the goal, never on the workstream.
  let index = ok(plain);
  index = ok(transitionWorkstream(index, 'ws-a', { type: 'goal.attached', goal_id: 'g-1', evidence: 2 }));
  index = ok(transitionWorkstream(index, 'ws-a', { type: 'input.recorded', seq: 3 }));
  index = ok(
    transitionWorkstream(index, 'ws-a', { type: 'artifact.recorded', artifact_id: 'doc-1', revision: 1, evidence: 4 }),
  );
  walk(index);
});

test('a workstream pursues one active goal at a time and keeps every goal with its evidence', () => {
  let index = two();
  index = ok(transitionWorkstream(index, 'ws-a', { type: 'goal.attached', goal_id: 'g-1', evidence: 3 }));
  refused(transitionWorkstream(index, 'ws-a', { type: 'goal.attached', goal_id: 'g-2', evidence: 4 }), 'goal_active');
  refused(transitionWorkstream(index, 'ws-a', { type: 'goal.ended', goal_id: 'g-2', evidence: 4 }), 'goal_not_active');
  index = ok(transitionWorkstream(index, 'ws-a', { type: 'goal.ended', goal_id: 'g-1', evidence: 5 }));
  refused(transitionWorkstream(index, 'ws-a', { type: 'goal.ended', goal_id: 'g-1', evidence: 6 }), 'goal_not_active');
  refused(transitionWorkstream(index, 'ws-a', { type: 'goal.attached', goal_id: 'g-1', evidence: 6 }), 'goal_attached');
  const result = transitionWorkstream(index, 'ws-a', { type: 'goal.attached', goal_id: 'g-2', evidence: 6 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.workstream.goals, [
    { goal_id: 'g-1', attached_at: 3, ended_at: 5 },
    { goal_id: 'g-2', attached_at: 6, ended_at: null },
  ]);
  assert.equal(activeGoal(result.workstream), 'g-2');
  assert.equal(result.workstream.revision, 3);
});

test('workstreams of one project progress independently, each with its own active goal', () => {
  const start = two();
  const before = JSON.stringify(start);
  let index = ok(transitionWorkstream(start, 'ws-a', { type: 'goal.attached', goal_id: 'g-1', evidence: 3 }));
  assert.equal(JSON.stringify(start), before, 'the input index is not mutated');
  refused(transitionWorkstream(index, 'ws-b', { type: 'goal.attached', goal_id: 'g-1', evidence: 4 }), 'goal_attached');
  const untouched = index.workstreams.find((item) => item.workstream_id === 'ws-b');
  index = ok(transitionWorkstream(index, 'ws-b', { type: 'goal.attached', goal_id: 'g-2', evidence: 4 }));
  index = ok(transitionWorkstream(index, 'ws-a', { type: 'input.recorded', seq: 5 }));
  const [a, b] = index.workstreams;
  assert.equal(activeGoal(a!), 'g-1');
  assert.equal(activeGoal(b!), 'g-2');
  assert.deepEqual(a!.inputs, [{ seq: 5 }]);
  assert.deepEqual(b!.inputs, [], 'input addressed to one workstream is not in another');
  assert.notDeepEqual(untouched, b);
  refused(transitionWorkstream(index, 'ws-z', { type: 'input.recorded', seq: 6 }), 'unknown_workstream');
});

test('inputs are recorded in log order without payloads', () => {
  let index = two();
  index = ok(transitionWorkstream(index, 'ws-a', { type: 'input.recorded', seq: 7 }));
  refused(transitionWorkstream(index, 'ws-a', { type: 'input.recorded', seq: 7 }), 'input_out_of_order');
  refused(transitionWorkstream(index, 'ws-a', { type: 'input.recorded', seq: 6 }), 'input_out_of_order');
  refused(transitionWorkstream(index, 'ws-a', { type: 'input.recorded', seq: -1 }), 'invalid_evidence');
  index = ok(transitionWorkstream(index, 'ws-a', { type: 'input.recorded', seq: 9 }));
  assert.deepEqual(index.workstreams[0]!.inputs, [{ seq: 7 }, { seq: 9 }]);
});

test('artifacts are recorded by reference under the active goal, with increasing revisions', () => {
  let index = two();
  refused(
    transitionWorkstream(index, 'ws-a', { type: 'artifact.recorded', artifact_id: 'doc-1', revision: 1, evidence: 3 }),
    'no_active_goal',
  );
  index = ok(transitionWorkstream(index, 'ws-a', { type: 'goal.attached', goal_id: 'g-1', evidence: 3 }));
  refused(
    transitionWorkstream(index, 'ws-a', {
      type: 'artifact.recorded',
      artifact_id: '/etc/passwd',
      revision: 1,
      evidence: 4,
    }),
    'invalid_id',
  );
  index = ok(
    transitionWorkstream(index, 'ws-a', { type: 'artifact.recorded', artifact_id: 'doc-1', revision: 1, evidence: 4 }),
  );
  refused(
    transitionWorkstream(index, 'ws-a', { type: 'artifact.recorded', artifact_id: 'doc-1', revision: 1, evidence: 5 }),
    'stale_revision',
  );
  refused(
    transitionWorkstream(index, 'ws-a', {
      type: 'artifact.recorded',
      artifact_id: 'doc-1',
      revision: 0.5,
      evidence: 5,
    }),
    'stale_revision',
  );
  index = ok(
    transitionWorkstream(index, 'ws-a', { type: 'artifact.recorded', artifact_id: 'doc-1', revision: 3, evidence: 5 }),
  );
  // Another workstream may record its own revisions of the same artifact; ownership is by production record.
  index = ok(transitionWorkstream(index, 'ws-b', { type: 'goal.attached', goal_id: 'g-2', evidence: 6 }));
  index = ok(
    transitionWorkstream(index, 'ws-b', { type: 'artifact.recorded', artifact_id: 'doc-1', revision: 2, evidence: 7 }),
  );
  assert.deepEqual(index.workstreams[0]!.artifacts, [
    { artifact_id: 'doc-1', revision: 1, goal_id: 'g-1', evidence: 4 },
    { artifact_id: 'doc-1', revision: 3, goal_id: 'g-1', evidence: 5 },
  ]);
  assert.deepEqual(index.workstreams[1]!.artifacts, [
    { artifact_id: 'doc-1', revision: 2, goal_id: 'g-2', evidence: 7 },
  ]);
});

test('refusals leave the index unchanged and replay is byte-identical', () => {
  const events = [
    ['ws-a', { type: 'goal.attached', goal_id: 'g-1', evidence: 3 }],
    ['ws-a', { type: 'input.recorded', seq: 4 }],
    ['ws-b', { type: 'input.recorded', seq: 5 }],
    ['ws-a', { type: 'artifact.recorded', artifact_id: 'doc-1', revision: 1, evidence: 6 }],
    ['ws-a', { type: 'goal.attached', goal_id: 'g-2', evidence: 7 }],
    ['ws-a', { type: 'goal.ended', goal_id: 'g-1', evidence: 8 }],
  ] as const;
  const run = (): string => {
    let index = two();
    for (const [id, event] of events) {
      const result = transitionWorkstream(index, id, event);
      if (result.ok) index = result.index;
      else assert.equal(JSON.stringify(transitionWorkstream(index, id, event)), JSON.stringify(result));
    }
    return JSON.stringify(index);
  };
  assert.equal(run(), run());
  const index = JSON.parse(run()) as WorkstreamIndex;
  assert.equal(index.workstreams[0]!.revision, 4);
  assert.equal(index.workstreams[1]!.revision, 1);
});
