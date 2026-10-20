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
  assert.ok(state.omissions.includes('artifact:authority'));
  assert.equal(state.source_revisions.checks, undefined);
});

test('unauthorized artifacts disclose only one identity-free authority marker', () => {
  const input = fixture();
  const baseline = assembleAuditState(input);
  assert.deepEqual(baseline.omissions, []);
  const ids = ['hidden', 'hidden:summary_cap', 'sk-FAKE-NOT-A-CREDENTIAL'];
  for (const count of [1, ids.length]) {
    const artifacts = ids.slice(0, count).map((artifact_id, index) => ({ ...input.artifacts![0]!,
      artifact_id, ref: `ref_hidden_${index}`, summary: '界'.repeat(100), body: 'x'.repeat(5000) }));
    const state = assembleAuditState({ ...input, artifacts: [...input.artifacts!, ...artifacts],
      source_revisions: { ...input.source_revisions, ...Object.fromEntries(artifacts.map(artifact => [artifact.ref, 99])) } });
    assert.deepEqual(state.omissions, ['artifact:authority']);
    assert.deepEqual(state.artifacts, baseline.artifacts);
    assert.deepEqual(state.source_revisions, baseline.source_revisions);
    assert.deepEqual(state, assembleAuditState({ ...input, artifacts: [...input.artifacts!, ...artifacts].reverse() }));
  }
  const restricted = assembleAuditState({ ...input, authorized_slices: ['goal', 'iteration'] });
  assert.ok(!restricted.omissions.includes('artifact:authority'));
  assert.ok(restricted.omissions.includes('artifacts:authority'));
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

function checkFixture(tail: string): AuditStateInput {
  return { ...fixture(), checks: [{ check_id: 'test', argv_digest: 'abc', exit: 0, passed: true, tail }] };
}

const isWellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;

test('check tail byte cut preserves the end without splitting an astral character', () => {
  const state = assembleAuditState(checkFixture('prefix😀' + 'x'.repeat(239)));
  assert.ok(isWellFormed(state.checks[0]!.tail), 'tail must not contain a lone surrogate');
  assert.equal(state.checks[0]!.tail, 'x'.repeat(239));
  assert.deepEqual(state.omissions, ['check:test:tail_cap']);
});

test('check tails use UTF-8 suffix caps at empty, exact and over-cap boundaries', () => {
  for (const [tail, expected] of [
    ['', ''], ['x'.repeat(240), 'x'.repeat(240)], ['😀'.repeat(60), '😀'.repeat(60)],
    ['界'.repeat(80), '界'.repeat(80)], ['x'.repeat(241), 'x'.repeat(240)],
    ['😀'.repeat(100), '😀'.repeat(60)], ['界'.repeat(81), '界'.repeat(80)],
    ['prefix\n' + '界'.repeat(79) + 'end', '界'.repeat(79) + 'end'],
  ]) {
    const state = assembleAuditState(checkFixture(tail!));
    assert.equal(state.checks[0]!.tail, expected);
    assert.ok(Buffer.byteLength(state.checks[0]!.tail) <= 240);
    assert.ok(isWellFormed(state.checks[0]!.tail));
    assert.deepEqual(state.omissions, tail === expected ? [] : ['check:test:tail_cap']);
    const { digest: stateDigest, ...content } = state;
    assert.equal(stateDigest, digest(content));
  }
});

test('check tails repair existing lone surrogates without crashing or exceeding the cap', () => {
  for (const [tail, expected] of [
    ['a\ud800b\udc00😀', 'a\ufffdb\ufffd😀'],
    ['😀'.repeat(100) + '\ud800', '😀'.repeat(59) + '\ufffd'],
    ['\udc00' + 'x'.repeat(237), '\ufffd' + 'x'.repeat(237)],
    ['\ud800' + 'x'.repeat(238), 'x'.repeat(238)],
  ]) {
    const state = assembleAuditState(checkFixture(tail!));
    assert.equal(state.checks[0]!.tail, expected);
    assert.ok(isWellFormed(state.checks[0]!.tail));
    assert.ok(Buffer.byteLength(state.checks[0]!.tail) <= 240);
    assert.deepEqual(state.omissions, ['check:test:tail_cap']);
  }
});

test('audit eval iteration provenance is preserved, detached and canonically digested', () => {
  const legacy = { criterion_id: 'c1', passed: true, verdict_probability: .8, confidence: .9 };
  const evals = [{ ...legacy, iteration: 0, passed: false }, { ...legacy, iteration: 1 },
    { ...legacy, iteration: null }, legacy];
  const input = { ...fixture(), iteration: 1, evals };
  const state = assembleAuditState(input);
  assert.deepEqual(state.evals, evals, 'assembly preserves historical and unknown evidence without relabeling');
  const reordered = { ...legacy, iteration: 1 };
  const canonical = assembleAuditState({ ...input, evals: [evals[0]!,
    { iteration: 1, confidence: .9, verdict_probability: .8, passed: true, criterion_id: 'c1' }, evals[2]!, legacy] });
  assert.deepEqual(state, canonical);
  assert.notEqual(assembleAuditState({ ...input, evals: [evals[0]!, { ...reordered, iteration: 0 }, evals[2]!, legacy] }).digest, state.digest);
  const { digest: _digest, ...content } = state;
  assert.equal(state.digest, digest(content));
  evals[0]!.passed = true;
  assert.equal(state.evals[0]?.passed, false);
  const old = assembleAuditState({ ...fixture(), evals: [legacy] });
  assert.deepEqual(old.evals, [legacy]);
  assert.equal(Object.hasOwn(old.evals[0]!, 'iteration'), false, 'old states acquire no invented iteration');
});

test('prefix bounds repair lone surrogates like check tails and record the field cap marker (#162)', () => {
  for (const [statement, expectedStatement, decisionText, expectedDecision] of [
    ['a\ud800b\udc00😀', 'a�b�😀', 'x\udbff', 'x�'],
    ['x'.repeat(4094) + '\ud800', 'x'.repeat(4094), 'x'.repeat(238) + '\udc00', 'x'.repeat(238)],
    ['x'.repeat(4093) + '\ud800', 'x'.repeat(4093) + '�', 'x'.repeat(237) + '\udc00', 'x'.repeat(237) + '�'],
  ]) {
    const input = textFixture(statement!, decisionText!);
    const state = assembleAuditState({ ...input, artifacts: [{ ...input.artifacts![0]!, summary: decisionText! }] });
    for (const text of [state.goal.statement, state.goal.success_criteria[0]!.statement, state.plan[0]!.intent, state.open_issues[0]!.text]) {
      assert.equal(text, expectedStatement);
      assert.ok(isWellFormed(text), 'prefix must not contain a lone surrogate');
      assert.ok(Buffer.byteLength(text) <= 4096);
    }
    for (const field of ['site', 'question_id', 'choice'] as const) assert.equal(state.decisions[0]![field], expectedDecision, field);
    assert.equal(state.artifacts[0]!.summary, expectedDecision);
    assert.deepEqual(state.omissions, ['artifact:a1:summary_cap', 'criterion:c1:statement_cap', 'decision:0:choice_cap',
      'decision:0:question_id_cap', 'decision:0:site_cap', 'goal:statement_cap', 'issue:i1:text_cap', 'plan:s1:intent_cap']);
  }
});

test('cap markers name an item by position when its id is not a bounded identifier (#162)', () => {
  const longId = 'id'.repeat(100);
  const input = textFixture('x'.repeat(4097), 'x');
  const criterion = input.goal.success_criteria[0]!;
  const state = assembleAuditState({ ...input,
    goal: { ...input.goal, success_criteria: [criterion, { ...criterion, criterion_id: longId },
      { ...criterion, criterion_id: 'sk-NOT-A-REAL-KEY' }] },
    plan: [{ ...input.plan![0]!, step_id: longId }],
    open_issues: [{ ...input.open_issues![0]!, issue_id: 'bad id with spaces' }],
    artifacts: [{ ...input.artifacts![0]!, artifact_id: longId, summary: 'y'.repeat(241), body: 'z'.repeat(5000) }],
    checks: [{ check_id: longId, argv_digest: 'abc', exit: 0, passed: true, tail: 't'.repeat(241) }],
  });
  assert.deepEqual(state.omissions, ['artifact:@0:size_cap', 'artifact:@0:summary_cap', 'check:@0:tail_cap',
    'criterion:@1:statement_cap', 'criterion:@2:statement_cap', 'criterion:c1:statement_cap', 'goal:statement_cap',
    'issue:@0:text_cap', 'plan:@0:intent_cap']);
  assert.equal(state.goal.success_criteria[1]!.criterion_id, longId, 'item ids are retained unchanged');
  assert.equal(state.omissions.some(marker => marker.includes('sk-') || marker.includes(longId)), false);
});
