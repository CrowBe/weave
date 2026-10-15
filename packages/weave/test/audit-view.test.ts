import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleAuditState, AUDIT_SLICES, type AuditStateInput } from '../src/audit-view.js';
import { digest } from '../src/digest.js';

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

test('artifact summaries obey UTF-8 byte cap and assembled state detaches input', () => {
  const input = fixture();
  const artifacts = [{ ...input.artifacts![0]!, summary: '😀'.repeat(100) }];
  const state = assembleAuditState({ ...input, artifacts });
  assert.ok(Buffer.byteLength(state.artifacts[0]!.summary) <= 240);
  assert.ok(state.omissions.includes('artifact:a1:summary_cap'));
  artifacts[0]!.summary = 'changed';
  assert.notEqual(state.artifacts[0]!.summary, 'changed');
});

function textFixture(statement: string, decisionText: string): AuditStateInput {
  const input = fixture();
  return { ...input,
    goal: { ...input.goal, statement, success_criteria: [{ criterion_id: 'c1', statement, check_ids: ['test'] }] },
    plan: [{ step_id: 's1', intent: statement, tier: 'standard', status: 'done' }],
    decisions: [{ site: decisionText, question_id: decisionText, choice: decisionText,
      probabilities: { yes: 1 }, confidence: 1, fallback_used: false, obs_seq: 3 }],
    open_issues: [{ issue_id: 'i1', source: 'audit', text: statement, severity: 'gap' }],
  };
}

test('audit text caps preserve empty and exact-cap strings and null choices', () => {
  for (const [statement, decisionText] of [['', ''], ['x'.repeat(4096), 'x'.repeat(240)],
    ['😀'.repeat(1024), '界'.repeat(80)]]) {
    const input = textFixture(statement!, decisionText!);
    const state = assembleAuditState(input);
    assert.deepEqual(state.goal, input.goal);
    assert.deepEqual(state.plan, input.plan);
    assert.deepEqual(state.decisions, input.decisions);
    assert.deepEqual(state.open_issues, input.open_issues);
    assert.deepEqual(state.omissions, []);
  }
  const input = textFixture('', '');
  const state = assembleAuditState({ ...input, decisions: [{ ...input.decisions![0]!, choice: null }] });
  assert.equal(state.decisions[0]!.choice, null);
  assert.deepEqual(state.omissions, []);
});

test('audit text caps bound every field at one byte over and multibyte cuts before digesting', () => {
  for (const [statement, decisionText, expectedStatement, expectedDecision] of [
    ['x'.repeat(4097), 'x'.repeat(241), 'x'.repeat(4096), 'x'.repeat(240)],
    ['x'.repeat(4095) + '😀', 'x'.repeat(239) + '界', 'x'.repeat(4095), 'x'.repeat(239)],
    ['界'.repeat(1366), '😀'.repeat(61), '界'.repeat(1365), '😀'.repeat(60)],
  ]) {
    const input = textFixture(statement!, decisionText!);
    const state = assembleAuditState(input);
    assert.equal(Buffer.byteLength(state.goal.statement), Buffer.byteLength(expectedStatement!), 'goal statement UTF-8 cap');
    assert.equal(state.goal.statement, expectedStatement);
    assert.equal(state.goal.success_criteria[0]!.statement, expectedStatement);
    assert.equal(state.plan[0]!.intent, expectedStatement);
    assert.equal(state.open_issues[0]!.text, expectedStatement);
    for (const field of ['site', 'question_id', 'choice'] as const)
      assert.equal(state.decisions[0]![field], expectedDecision, field);
    assert.deepEqual(state.decisions[0]!.probabilities, { yes: 1 });
    assert.deepEqual(state.omissions, ['criterion:c1:statement_cap', 'decision:0:choice_cap',
      'decision:0:question_id_cap', 'decision:0:site_cap', 'goal:statement_cap', 'issue:i1:text_cap', 'plan:s1:intent_cap']);
    const { digest: stateDigest, ...content } = state;
    assert.equal(stateDigest, digest(content));
    assert.equal(assembleAuditState(textFixture(statement! + 'discarded', decisionText! + 'discarded')).digest, stateDigest);
    assert.equal(input.goal.statement, statement);
  }
});

test('audit text caps retain many items and only mark authorized fields', () => {
  const input = textFixture('x'.repeat(4097), 'x'.repeat(241));
  const count = 100;
  const many = { ...input,
    goal: { ...input.goal, success_criteria: Array.from({ length: count }, (_, i) => ({ ...input.goal.success_criteria[0]!, criterion_id: `c${i}` })) },
    plan: Array.from({ length: count }, (_, i) => ({ ...input.plan![0]!, step_id: `s${i}` })),
    decisions: Array.from({ length: count }, (_, i) => ({ ...input.decisions![0]!, obs_seq: i })),
    open_issues: Array.from({ length: count }, (_, i) => ({ ...input.open_issues![0]!, issue_id: `i${i}` })),
  };
  const state = assembleAuditState(many);
  assert.equal(state.goal.success_criteria.length, count);
  assert.equal(state.plan.length, count);
  assert.equal(state.decisions.length, count);
  assert.equal(state.open_issues.length, count);
  for (let i = 0; i < count; i++) {
    assert.equal(state.goal.success_criteria[i]!.criterion_id, `c${i}`);
    assert.equal(state.goal.success_criteria[i]!.statement.length, 4096);
    assert.equal(state.plan[i]!.step_id, `s${i}`);
    assert.equal(state.plan[i]!.intent.length, 4096);
    assert.equal(state.decisions[i]!.obs_seq, i);
    assert.equal(state.decisions[i]!.choice!.length, 240);
    assert.equal(state.open_issues[i]!.issue_id, `i${i}`);
    assert.equal(state.open_issues[i]!.text.length, 4096);
  }
  assert.equal(state.omissions.length, 1 + count * 6);
  const restricted = assembleAuditState({ ...many, authorized_slices: ['goal', 'iteration'] });
  assert.ok(!restricted.omissions.some(marker => /^(plan|decision|issue):.*_cap$/.test(marker)));
  for (const slice of ['plan', 'decisions', 'open_issues']) assert.ok(restricted.omissions.includes(`${slice}:authority`));
  assert.deepEqual(restricted.plan, []);
  assert.deepEqual(restricted.decisions, []);
  assert.deepEqual(restricted.open_issues, []);
});
