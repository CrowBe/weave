import type { WorkspaceView } from '@weave/tapestry';

const approval = {
  request_id: 'req-publish',
  sequence: 12,
  operation: 'report.publish',
  contract_revision: 'r1',
  destination: 'ref_3',
  effects: [{ mode: 'write', resource: 'ref_3' }],
  expected_revision: 1,
  reservation: { actions: 1, judgments: 0 },
  valid_from_tick: 0,
  valid_until_tick: 8,
  binding_digest: 'a'.repeat(64),
  report_digest: 'b'.repeat(64),
} as const;

const shared = {
  id: 'view.workspace@1',
  revision: 18,
  project_name: { status: 'disclosed', name: 'Field notes' },
  availability: {
    status: 'disclosed',
    truncated: false,
    items: [
      { label: 'Field repository', kind: 'repository' },
      { label: 'Brief', kind: 'document' },
    ],
  },
  approvals: { status: 'disclosed', truncated: false, items: [approval] },
} as const;

/** Pending approval, with the observations slice withheld. */
export const omittedFixture: WorkspaceView = {
  ...shared,
  observations: { status: 'omitted', reason: 'policy' },
};

/** The same project and approval, with recorded observations disclosed. */
export const recordedFixture: WorkspaceView = {
  ...shared,
  observations: {
    status: 'disclosed',
    truncated: false,
    items: [
      {
        sequence: 1,
        type: 'goal.opened',
        provenance: 'operator',
        validation: { status: 'accepted' },
        cause: null,
      },
      {
        sequence: 4,
        type: 'source.registered',
        provenance: 'untrusted',
        validation: { status: 'accepted' },
        cause: null,
      },
      {
        sequence: 9,
        type: 'action.started',
        provenance: 'runtime',
        validation: { status: 'accepted' },
        cause: 'a:1:1',
      },
    ],
  },
};

export const FIXTURES = {
  omitted: omittedFixture,
  recorded: recordedFixture,
} as const;

export type FixtureId = keyof typeof FIXTURES;
