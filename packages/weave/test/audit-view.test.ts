import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleAuditState, AUDIT_SLICES, type AuditStateInput } from '../src/audit-view.js';

const fixture = (): AuditStateInput => ({
  authorized_slices: AUDIT_SLICES,
  goal: { goal_id: 'goal', statement: 'Build', success_criteria: [{ criterion_id: 'c1', statement: 'Works', check_ids: ['test'] }], authority_scope: ['ref_ok'], revision: 1 },
  iteration: 0,
  artifacts: [{ artifact_id: 'a1', kind: 'report', digest: 'abc', summary: 'report', bytes: 12, ref: 'ref_ok', body: '😀😀😀' }],
  source_revisions: { goal: 1, artifacts: 2 },
});

test('tidy state drops oversized bodies using UTF-8 bytes and records omission', () => {
  const state = assembleAuditState({ ...fixture(), max_body_bytes: 8 });
  assert.equal(state.view, 'view.audit@1');
  assert.equal(state.artifacts[0]?.body, undefined);
  assert.equal(state.artifacts[0]?.ref, 'ref_ok');
  assert.ok(state.omissions.includes('artifact:a1:size_cap'));
});

test('tidy state rejects unauthorized slices and artifact references', () => {
  const input = fixture();
  const state = assembleAuditState({ ...input, authorized_slices: ['goal', 'iteration', 'artifacts'], artifacts: [...input.artifacts!, { artifact_id: 'hidden', kind: 'file', digest: 'secret', summary: 'private', bytes: 1, ref: 'ref_hidden' }], source_revisions: { ...input.source_revisions, checks: 9 } });
  assert.equal(state.artifacts.length, 1);
  assert.ok(state.omissions.includes('checks:authority'));
  assert.ok(state.omissions.includes('artifact:hidden:authority'));
  assert.equal(state.source_revisions.checks, undefined);
});

test('tidy state canonical digest and bytes replay independent of object key order', () => {
  const first = assembleAuditState(fixture());
  const second = assembleAuditState({ ...fixture(), source_revisions: { artifacts: 2, goal: 1 } });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.digest.length, 64);
  assert.notEqual(assembleAuditState({ ...fixture(), iteration: 1 }).digest, first.digest);
});
