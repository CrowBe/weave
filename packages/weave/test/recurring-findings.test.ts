/**
 * #203 record only: recurring judgment findings become capability gap records
 * for a check capability. Nothing is generated, admitted, or granted here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHECK_GAP_SCHEMA,
  DECLARED_RECURRENCE_POLICY,
  RECURRENCE_KEY_SCHEMA,
  auditJudgmentFindings,
  checkCoverage,
  outputEvalJudgmentFindings,
  recordCheckGaps,
  recurrenceKey,
  ScriptedFoldAuthor,
  type AuditDisposition,
  type AuditFinding,
  type AuditRound,
  type CheckGapRecord,
  type ImplementEval,
  type JudgmentFinding,
} from '@weave/weave';
import type { CapabilityContract, DesiredOperation, TestCase } from '@weave/agentsop';
import { driveFold, m3World, openFoldGoal } from './m3-fixture.js';

/** Proposes a contract for the gap's operation and no corpus, so crystallization stops at its first unmet gate. */
class ContractOnlyAuthor extends ScriptedFoldAuthor {
  override proposeContract(desired: DesiredOperation): CapabilityContract {
    this.calls.push('contract');
    return {
      id: desired.operation,
      revision: 'r1',
      purpose: desired.purpose,
      input: desired.input,
      output: desired.output,
      effects: [],
      permissions: [],
      failures: [],
      depends_on: [],
    };
  }
  override proposeCases(): readonly TestCase[] {
    this.calls.push('cases');
    return [];
  }
}

const readmeDefect: AuditFinding = {
  criterion_id: 'c1',
  kind: 'defect',
  evidence_ref: 'ref_readme',
  proposed_fix: 'Add the missing Installation heading',
};

function round(
  execution_id: string,
  findings: readonly AuditFinding[],
  choices: readonly AuditDisposition[],
  n = 1,
): AuditRound {
  return {
    schema: 'audit.round@1',
    id: `${execution_id}:r${n}:e${n}`,
    parentId: null,
    execution_id,
    round: n,
    state_digest: 'digest',
    report: { findings, goal_met_claim: true },
    disposal: { choices, observations: [] },
    open_issues: [],
    outcome: 'observe',
    goal_done: false,
  };
}

const fail = (criterion_id: string): ImplementEval => ({
  criterion_id,
  verdict_probability: 0.1,
  confidence: 0.95,
  passed: false,
});

function keysIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysIn(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keysIn(item, into);
    }
  }
  return into;
}

describe('recurrence key', () => {
  it('keys a finding by kind, criterion and evidence, never by execution or proposed fix', () => {
    const first = auditJudgmentFindings(round('exec-1', [readmeDefect], ['fix_now']));
    const second = auditJudgmentFindings(
      round('exec-2', [{ ...readmeDefect, proposed_fix: 'Completely different wording' }], ['fix_now']),
    );
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    const [a] = first;
    const [b] = second;
    assert.ok(a && b);
    assert.equal(JSON.stringify(a).includes('Installation heading'), false);
    const key = recurrenceKey(a);
    assert.ok(key);
    assert.equal(recurrenceKey(b), key);
    assert.equal(key.includes('exec-1'), false);
    assert.notEqual(recurrenceKey({ ...a, evidence_ref: 'ref_other' }), key);
    assert.notEqual(recurrenceKey({ ...a, kind: 'regression' }), key);
    assert.notEqual(recurrenceKey({ ...a, criterion_id: null }), key);
    assert.equal(RECURRENCE_KEY_SCHEMA, 'judgment.recurrence@1');
  });

  it('gives no key to evidence that names its own execution or is not a safe reference', () => {
    const base: JudgmentFinding = {
      site: 'audit.generate',
      execution_id: 'exec-7',
      kind: 'gap',
      criterion_id: 'c1',
      evidence_ref: 'ref_readme',
    };
    assert.ok(recurrenceKey(base));
    assert.equal(recurrenceKey({ ...base, evidence_ref: 'ref_exec-7_log' }), null);
    assert.equal(recurrenceKey({ ...base, evidence_ref: 'the readme looks wrong' }), null);
    assert.equal(recurrenceKey({ ...base, evidence_ref: 'sk-live-secret' }), null);
    assert.equal(recurrenceKey({ ...base, criterion_id: 'c 1' }), null);
    assert.equal(recurrenceKey({ ...base, kind: 'criterion_failed' }), null);
    assert.equal(recurrenceKey({ ...base, site: 'eval.output' }), null);
  });
});

describe('capability gap records', () => {
  it('records one gap for the same finding in two executions and none for a different finding', () => {
    const findings = [
      ...auditJudgmentFindings(round('exec-1', [readmeDefect], ['fix_now'])),
      ...auditJudgmentFindings(round('exec-2', [{ ...readmeDefect, proposed_fix: 'Reworded fix' }], ['fix_now'])),
      ...auditJudgmentFindings(round('exec-3', [{ ...readmeDefect, evidence_ref: 'ref_changelog' }], ['fix_now'])),
    ];
    const gaps = recordCheckGaps(findings);
    assert.equal(gaps.length, 1);
    const [gap] = gaps;
    assert.ok(gap);
    assert.equal(gap.schema, CHECK_GAP_SCHEMA);
    assert.equal(gap.recurrence_key, recurrenceKey(findings[0] as JudgmentFinding));
    assert.deepEqual(gap.finding, {
      site: 'audit.generate',
      kind: 'defect',
      criterion_id: 'c1',
      evidence_ref: 'ref_readme',
    });
    assert.deepEqual(gap.cites, [{ execution_id: 'exec-1' }, { execution_id: 'exec-2' }]);
    assert.deepEqual(gap.policy, DECLARED_RECURRENCE_POLICY);
    assert.deepEqual(recordCheckGaps([...findings].reverse()), gaps);

    const different = recordCheckGaps([
      ...auditJudgmentFindings(round('exec-1', [readmeDefect], ['fix_now'])),
      ...auditJudgmentFindings(round('exec-2', [{ ...readmeDefect, evidence_ref: 'ref_changelog' }], ['fix_now'])),
    ]);
    assert.deepEqual(different, []);
  });

  it('counts executions, not rounds, and reads only findings the audit disposed as fix_now', () => {
    const sameExecution = recordCheckGaps([
      ...auditJudgmentFindings(round('exec-1', [readmeDefect], ['fix_now'], 1)),
      ...auditJudgmentFindings(round('exec-1', [readmeDefect], ['fix_now'], 2)),
    ]);
    assert.deepEqual(sameExecution, []);
    assert.deepEqual(auditJudgmentFindings(round('exec-1', [readmeDefect], ['defer'])), []);
    assert.deepEqual(auditJudgmentFindings(round('exec-1', [readmeDefect], ['needs_human'])), []);
    assert.deepEqual(auditJudgmentFindings({ ...round('exec-1', [readmeDefect], ['fix_now']), disposal: null }), []);
    const three = recordCheckGaps(
      ['exec-3', 'exec-1', 'exec-2'].flatMap((id) => auditJudgmentFindings(round(id, [readmeDefect], ['fix_now']))),
    );
    assert.equal(three.length, 1);
    assert.deepEqual(
      three[0]?.cites.map((cite) => cite.execution_id),
      ['exec-1', 'exec-2', 'exec-3'],
    );
  });

  it('reads a D5 failure only from a confident verdict below the threshold', () => {
    const evals: ImplementEval[] = [
      fail('c2'),
      { criterion_id: 'c3', verdict_probability: 0.1, confidence: 0.5, passed: false },
      { criterion_id: 'c4', verdict_probability: null, confidence: null, passed: false },
      { criterion_id: 'c5', verdict_probability: 0.95, confidence: 0.95, passed: true },
    ];
    const findings = outputEvalJudgmentFindings({ execution_id: 'exec-1', evals }, 'ref_app');
    assert.deepEqual(findings, [
      {
        site: 'eval.output',
        execution_id: 'exec-1',
        kind: 'criterion_failed',
        criterion_id: 'c2',
        evidence_ref: 'ref_app',
      },
    ]);
    const gaps = recordCheckGaps([
      ...findings,
      ...outputEvalJudgmentFindings({ execution_id: 'exec-2', evals: [fail('c2')] }, 'ref_app'),
    ]);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.finding.kind, 'criterion_failed');
  });

  it('uses N declared before the findings are read, and records it on the gap', () => {
    assert.deepEqual(DECLARED_RECURRENCE_POLICY, { schema: 'judgment.recurrence@1', executions: 2 });
    const findings = ['exec-1', 'exec-2'].flatMap((id) =>
      auditJudgmentFindings(round(id, [readmeDefect], ['fix_now'])),
    );
    const three = { schema: 'judgment.recurrence@1', executions: 3 } as const;
    assert.deepEqual(recordCheckGaps(findings, three), []);
    const third = auditJudgmentFindings(round('exec-3', [readmeDefect], ['fix_now']));
    assert.deepEqual(recordCheckGaps([...findings, ...third], three)[0]?.policy, three);
    for (const executions of [1, 0, 2.5, 101, Number.NaN]) {
      assert.throws(
        () => recordCheckGaps(findings, { schema: 'judgment.recurrence@1', executions }),
        String(executions),
      );
    }
  });

  it('does not record recurrence from malformed D5 statistics', () => {
    const malformed: readonly ImplementEval[] = [
      { ...fail('c2'), confidence: 1.01 },
      { ...fail('c2'), confidence: Number.POSITIVE_INFINITY },
      { ...fail('c2'), confidence: Number.NaN },
      { ...fail('c2'), confidence: -0.01 },
      { ...fail('c2'), verdict_probability: -0.01 },
      { ...fail('c2'), verdict_probability: Number.NEGATIVE_INFINITY },
      { ...fail('c2'), verdict_probability: Number.NaN },
      { ...fail('c2'), verdict_probability: 1.01 },
    ];
    for (const item of malformed) {
      const findings = ['exec-1', 'exec-2'].flatMap((execution_id) =>
        outputEvalJudgmentFindings({ execution_id, evals: [item] }, 'ref_app'),
      );
      assert.deepEqual(findings, [], 'invalid statistics are not judgment-caught failures');
      assert.deepEqual(recordCheckGaps(findings), []);
    }
    const boundary = { ...fail('c2'), confidence: 0.9, verdict_probability: 0 };
    const findings = ['exec-1', 'exec-2'].flatMap((execution_id) =>
      outputEvalJudgmentFindings({ execution_id, evals: [boundary] }, 'ref_app'),
    );
    assert.equal(recordCheckGaps(findings).length, 1);
    assert.deepEqual(
      outputEvalJudgmentFindings(
        { execution_id: 'exec-3', evals: [{ ...boundary, verdict_probability: 0.8 }] },
        'ref_app',
      ),
      [],
    );
  });
});

describe('a gap record grants nothing', () => {
  const findings = ['exec-1', 'exec-2'].flatMap((id) => auditJudgmentFindings(round(id, [readmeDefect], ['fix_now'])));
  const gap = recordCheckGaps(findings)[0] as CheckGapRecord;

  it('is plain data naming a desired check operation, with no grant, approval or admission', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(gap)), gap);
    assert.deepEqual(Object.keys(gap).sort(), [
      'cites',
      'desired',
      'finding',
      'gap_id',
      'policy',
      'recurrence_key',
      'schema',
    ]);
    const keys = keysIn(gap);
    for (const forbidden of [
      'grant',
      'grants',
      'authority',
      'approval',
      'admission',
      'implementation',
      'permissions',
      'effects',
    ]) {
      assert.equal(keys.has(forbidden), false, forbidden);
    }
    assert.deepEqual(Object.keys(gap.desired).sort(), ['input', 'operation', 'output', 'purpose']);
    assert.match(gap.desired.operation, /^check\./);
    assert.equal(JSON.stringify(gap).includes('Installation heading'), false);
  });

  it('reaches crystallization only as an operator goal, which starts at the gap search and stops at an unmet gate', async () => {
    const author = new ContractOnlyAuthor();
    const world = m3World({ author });
    const asObservation = world.observe({
      observation_id: 'test:gap-record',
      source: { kind: 'test', id: 'recurring-findings' },
      caused_by: null,
      payload_type: CHECK_GAP_SCHEMA,
      payload_version: 1,
      payload: gap,
    });
    assert.equal(asObservation.validation.status, 'unknown_type');
    const unauthorized = world.observe({
      observation_id: 'test:goal.opened:gap',
      source: { kind: 'test', id: 'recurring-findings' },
      caused_by: null,
      payload_type: 'goal.opened',
      payload_version: 1,
      payload: { goal_id: 'g-check', gap: gap.desired },
    });
    assert.deepEqual(unauthorized.validation, {
      status: 'rejected',
      reason: 'goal.opened cannot come from source kind test',
    });
    assert.equal(world.runtime.state().goal, null);
    assert.equal(world.runtime.trace().cycles.length, 0);

    openFoldGoal(world, { goal_id: 'g-check', gap: gap.desired });
    const first = world.runtime.trace().cycles[0];
    assert.ok(first);
    assert.equal(first.procedure, 'crystallize_and_report@1');
    const operations = new Set(first.candidates.map((candidate) => candidate.operation));
    assert.equal(operations.has('gap.search'), true);
    for (const later of [
      'contract.establish',
      'corpus.propose',
      'red.demonstrate',
      'implementation.generate',
      'green.prove',
      'admission.request',
    ]) {
      assert.equal(operations.has(later), false, later);
    }
    const search = first.candidates.find((candidate) => candidate.operation === 'gap.search');
    assert.deepEqual(search?.inputs, { operation: gap.desired.operation });

    await driveFold(world, 'complete');
    const state = world.runtime.state();
    assert.equal(state.crystallization.search?.status, 'gap');
    assert.equal(state.crystallization.contract?.id, gap.desired.operation);
    assert.equal(state.crystallization.corpus_validated, false);
    assert.notEqual(state.crystallization.red?.demonstrated, true);
    assert.deepEqual(state.crystallization.implementations, []);
    assert.deepEqual(state.crystallization.green, []);
    assert.equal(state.crystallization.admission, null);
    assert.notEqual(state.goal?.status, 'complete');
    assert.equal(
      author.calls.some((call) => call.startsWith('implementation')),
      false,
    );
  });
});

describe('check coverage', () => {
  it('reports the share of judgment-caught failures that an admitted check covers', () => {
    const repeated = ['exec-1', 'exec-2'].flatMap((id) =>
      auditJudgmentFindings(round(id, [readmeDefect], ['fix_now'])),
    );
    const twice = auditJudgmentFindings(round('exec-2', [readmeDefect], ['fix_now'], 2));
    const other = auditJudgmentFindings(
      round('exec-3', [{ ...readmeDefect, evidence_ref: 'ref_changelog' }], ['fix_now']),
    );
    const unkeyed = auditJudgmentFindings(
      round('exec-4', [{ ...readmeDefect, evidence_ref: 'ref_exec-4' }], ['fix_now']),
    );
    const findings = [...repeated, ...twice, ...other, ...unkeyed];
    const gaps = recordCheckGaps(findings);
    assert.equal(gaps.length, 1);
    const operation = gaps[0]?.desired.operation as string;

    assert.deepEqual(checkCoverage(findings, gaps, []), {
      schema: 'judgment.check_coverage@1',
      caught: 4,
      covered: 0,
      share: 0,
    });
    assert.deepEqual(checkCoverage(findings, gaps, ['text.normalize']).covered, 0);
    assert.deepEqual(checkCoverage(findings, gaps, [operation]), {
      schema: 'judgment.check_coverage@1',
      caught: 4,
      covered: 2,
      share: 0.5,
    });
    assert.deepEqual(checkCoverage(findings, [], [operation]).covered, 0);
    assert.deepEqual(checkCoverage([], gaps, [operation]), {
      schema: 'judgment.check_coverage@1',
      caught: 0,
      covered: 0,
      share: null,
    });
  });
});
