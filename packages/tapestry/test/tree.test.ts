import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_TEXT,
  THEME_DAYLIGHT,
  THEME_DEFAULT,
  VOCABULARY,
  changeTheme,
  freshSession,
  present,
  resolveTree,
  selectAttachment,
  withheld,
  type DisclosedApproval,
  type SessionRecord,
  type WorkspaceView,
} from '@weave/tapestry';

function approval(request_id: string, sequence: number): DisclosedApproval {
  return {
    request_id,
    sequence,
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
  };
}

function view(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: 'view.workspace@1',
    revision: 7,
    project_name: { status: 'disclosed', name: 'Field notes' },
    availability: {
      status: 'disclosed',
      truncated: false,
      items: [
        { label: 'Field repository', kind: 'repository' },
        { label: 'Brief', kind: 'document' },
      ],
    },
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
      ],
    },
    approvals: { status: 'disclosed', truncated: false, items: [] },
    ...overrides,
  };
}

function withPins(session: SessionRecord, pins: SessionRecord['pins']): SessionRecord {
  return { ...session, pins };
}

function withPlacements(session: SessionRecord, placements: SessionRecord['placements']): SessionRecord {
  return { ...session, placements };
}

describe('default tree', () => {
  it('paints navigation and the conversational surface for a fresh session', () => {
    const session = freshSession('session-1');
    const tree = resolveTree(view(), session);
    assert.equal(tree.vocabulary, 'vocabulary.workspace@1');
    assert.equal(tree.revision, 7);
    assert.deepEqual(tree.regions.nav, { component: 'project.index@1' });
    assert.deepEqual(tree.regions['main.primary'], { component: 'conversation.thread@1' });
    assert.deepEqual(tree.regions['main.bottom'], { component: 'empty', text: EMPTY_TEXT['main.bottom'] });
    assert.deepEqual(tree.regions['right.drawer'], { component: 'collapsed' });
    assert.deepEqual(tree.regions['cut-through'], []);
  });

  it('returns the same tree for the same view and session', () => {
    const session = freshSession('session-1');
    const sample = view();
    assert.deepEqual(resolveTree(sample, session), resolveTree(sample, session));
  });

  it('keeps the conversational input unbound', () => {
    const session = freshSession('session-1');
    const sample = view();
    const shown = present(sample, session, { component: 'conversation.thread@1' });
    assert.equal(shown.kind, 'observations');
    if (shown.kind !== 'observations') {
      return;
    }
    assert.equal(shown.input, 'unavailable');
    assert.equal(shown.items.length, 1);
    const submit = VOCABULARY.components.find((component) => component.id === 'conversation.thread@1');
    assert.equal(submit?.submits[0]?.bound, false);
  });
});

describe('omitted slices', () => {
  it('withholds an omitted observations slice instead of showing an empty list', () => {
    const sample = view({ observations: { status: 'omitted', reason: 'policy' } });
    const session = freshSession('session-1');
    const tree = resolveTree(sample, session);
    assert.deepEqual(tree.regions['main.primary'], { component: 'conversation.thread@1' });
    const shown = present(sample, session, tree.regions['main.primary']);
    assert.deepEqual(shown, { kind: 'omitted', text: withheld('observations', 'policy') });
  });

  it('withholds an omitted availability slice on the project index', () => {
    const sample = view({
      project_name: { status: 'omitted', reason: 'policy' },
      availability: { status: 'omitted', reason: 'policy' },
    });
    const session = freshSession('session-1');
    const shown = present(sample, session, { component: 'project.index@1' });
    assert.deepEqual(shown, { kind: 'omitted', text: withheld('availability', 'policy') });
  });

  it('puts an omitted approvals slice in the cut-through as withheld', () => {
    const sample = view({ approvals: { status: 'omitted', reason: 'protected' } });
    const tree = resolveTree(sample, freshSession('session-1'));
    assert.deepEqual(tree.regions['cut-through'], [
      { component: 'approval.pending@1', withheld: 'protected' },
    ]);
    const shown = present(sample, freshSession('session-1'), tree.regions['cut-through'][0]!);
    assert.deepEqual(shown, { kind: 'omitted', text: withheld('approvals', 'protected') });
  });
});

describe('cut-through precedence', () => {
  it('keeps pending approvals in request order when the main surface is pinned', () => {
    const sample = view({
      approvals: {
        status: 'disclosed',
        truncated: false,
        items: [approval('req-b', 2), approval('req-a', 1)],
      },
    });
    const session = withPins(freshSession('session-1'), [
      { region: 'main.primary', node: { component: 'conversation.thread@1' } },
    ]);
    const tree = resolveTree(sample, session);
    assert.deepEqual(tree.regions['main.primary'], { component: 'conversation.thread@1' });
    assert.deepEqual(tree.regions['cut-through'], [
      { component: 'approval.pending@1', request_id: 'req-a' },
      { component: 'approval.pending@1', request_id: 'req-b' },
    ]);
  });

  it('moves a placed approval out of the cut-through without deciding it', () => {
    const sample = view({
      approvals: {
        status: 'disclosed',
        truncated: false,
        items: [approval('req-a', 1), approval('req-b', 2)],
      },
    });
    const session = withPlacements(freshSession('session-1'), [
      { region: 'main.primary', node: { component: 'approval.pending@1', request_id: 'req-a' } },
    ]);
    const tree = resolveTree(sample, session);
    assert.deepEqual(tree.regions['main.primary'], { component: 'approval.pending@1', request_id: 'req-a' });
    assert.deepEqual(tree.regions['cut-through'], [{ component: 'approval.pending@1', request_id: 'req-b' }]);
    const shown = present(sample, session, tree.regions['main.primary']);
    assert.equal(shown.kind, 'approval');
    if (shown.kind !== 'approval') {
      return;
    }
    assert.equal(shown.decision, 'unavailable');
    assert.equal(shown.approval.request_id, 'req-a');
    const submit = VOCABULARY.components.find((component) => component.id === 'approval.pending@1');
    assert.equal(submit?.submits[0]?.bound, false);
  });

  it('does not place one component in two regions', () => {
    const session = withPins(freshSession('session-1'), [
      { region: 'right.drawer', node: { component: 'conversation.thread@1' } },
      { region: 'main.primary', node: { component: 'conversation.thread@1' } },
    ]);
    const tree = resolveTree(view(), session);
    assert.deepEqual(tree.regions['right.drawer'], { component: 'conversation.thread@1' });
    assert.deepEqual(tree.regions['main.primary'], { component: 'empty', text: EMPTY_TEXT['main.primary'] });
    const serialized = JSON.stringify(tree);
    assert.equal(serialized.split('"conversation.thread@1"').length - 1, 1);
  });
});

describe('theme and selection', () => {
  it('repaints with another theme without changing the tree, the session, or the selection', () => {
    const sample = view();
    const session = selectAttachment(freshSession('session-1', THEME_DEFAULT.id), 'Brief');
    const before = resolveTree(sample, session);
    const next = changeTheme(session, THEME_DAYLIGHT.id);
    assert.equal(next.session_id, session.session_id);
    assert.equal(next.theme_id, THEME_DAYLIGHT.id);
    assert.equal(next.selection, 'Brief');
    assert.deepEqual(next.pins, session.pins);
    assert.deepEqual(next.placements, session.placements);
    assert.equal(next.ended, false);
    assert.deepEqual(resolveTree(sample, next), before);
    assert.equal(JSON.stringify(before).includes('theme'), false);
  });
});
