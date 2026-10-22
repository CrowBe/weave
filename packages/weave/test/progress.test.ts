import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationOutcome, InferenceGateway, InferenceTerms } from '@weave/gateway';
import {
  assembleAuditState,
  AUDIT_SLICES,
  type AuditCheck,
  type AuditCriterion,
  type AuditEval,
  type AuditState,
} from '../src/audit-view.js';
import { MemoryAuditJournal, runAuditLoop, type AuditPorts } from '../src/audit-loop.js';
import { stopForNoProgress } from '../src/sites/index.js';
import {
  decideProgress,
  progressDelta,
  progressRule,
  transitionProgress,
  type ProgressRecord,
} from '../src/progress.js';

const terms: InferenceTerms = {
  quality: 'baseline',
  destinations: ['local'],
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const revision = { state_revision: 1, state_updated_at: 10 };
const now = () => ({ ...revision, observed_at: 10 });
const d8Input = { ...revision, request_id: 'progress-r1', state: { round: 'disclosed' }, terms, needs_dispatch: false };
const c1: AuditCriterion = { criterion_id: 'c1', statement: 'tests pass', check_ids: ['repo.test'] };
const c2: AuditCriterion = { criterion_id: 'c2', statement: 'docs updated', check_ids: ['repo.lint'] };
function check(check_id: string, iteration: number, passed = true): AuditCheck {
  return { check_id, iteration, argv_digest: 'abc', exit: passed ? 0 : 1, passed, tail: '' };
}
function evaluation(criterion_id: string, iteration: number, passed = true): AuditEval {
  return { criterion_id, iteration, verdict_probability: passed ? 0.95 : 0.2, confidence: 0.95, passed };
}
function tidy(
  iteration: number,
  parts: {
    checks?: readonly AuditCheck[];
    evals?: readonly AuditEval[];
    criteria?: readonly AuditCriterion[];
    artifact?: string;
  },
): AuditState {
  return assembleAuditState({
    authorized_slices: AUDIT_SLICES,
    iteration,
    source_revisions: { goal: 1 },
    goal: {
      goal_id: 'g1',
      statement: 'goal',
      revision: 1,
      authority_scope: ['ref_a'],
      success_criteria: parts.criteria ?? [c1, c2],
    },
    checks: parts.checks ?? [],
    evals: parts.evals ?? [],
    artifacts: parts.artifact
      ? [{ artifact_id: 'a1', kind: 'diff', digest: parts.artifact, summary: 's', bytes: 1, ref: 'ref_a' }]
      : [],
  });
}
/** D8 answers through the injected port; the rule must decide without calling it. */
function d8(answer: 'progressing' | 'stalled' | 'regressing' | 'outage' | 'throw') {
  const calls: unknown[] = [];
  const port = {
    evaluate: async (request: { request_id: string; site: string }) => {
      calls.push(request);
      if (answer === 'throw') throw new Error('provider-secret');
      if (answer === 'outage')
        return {
          status: 'blocked',
          reason: 'provider_unavailable',
          request_id: request.request_id,
          site: request.site,
          attempts: [],
          spent: 0,
          uncertainty: [],
        };
      return {
        status: 'accepted',
        kind: 'choice',
        request_id: request.request_id,
        site: request.site,
        answers: { decision: { type: 'choice', choice: answer, probabilities: { [answer]: 1 } } },
        confidence: { decision: 0.9 },
        routed_unit_id: 'd8',
        provider_response_id: 'p1',
        attempts: [],
        spent: 0,
        uncertainty: [],
      } as EvaluationOutcome<'choice'>;
    },
  } as unknown as Pick<InferenceGateway, 'evaluate'>;
  return { port, calls };
}
// c1 settled by a green bound check and a current D5 pass; c2 not settled.
const base = tidy(1, { checks: [check('repo.test', 1), check('repo.lint', 1, false)], evals: [evaluation('c1', 1)] });

test('progress.delta@1 records per-criterion settlement and one digest over checks, evals and artifacts', () => {
  const next = tidy(2, {
    checks: [check('repo.test', 2), check('repo.lint', 2)],
    evals: [evaluation('c1', 2), evaluation('c2', 2)],
  });
  const delta = progressDelta(base, next);
  assert.deepEqual(Object.keys(delta), [
    'schema',
    'previous_digest',
    'current_digest',
    'criteria',
    'removed',
    'gained',
    'lost',
    'rule',
  ]);
  assert.equal(delta.schema, 'progress.delta@1');
  assert.match(delta.previous_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(delta.previous_digest, delta.current_digest);
  assert.deepEqual(delta.criteria, [
    { criterion_id: 'c1', before: true, after: true },
    { criterion_id: 'c2', before: false, after: true },
  ]);
  assert.equal(delta.gained, 1);
  assert.equal(delta.lost, 0);
  // The digest ignores everything but checks, evals and artifacts.
  const relabelled = assembleAuditState({
    authorized_slices: AUDIT_SLICES,
    iteration: 1,
    source_revisions: { goal: 2 },
    goal: {
      goal_id: 'g1',
      statement: 'reworded goal',
      revision: 2,
      authority_scope: ['ref_a'],
      success_criteria: [c1, c2],
    },
    checks: base.checks,
    evals: base.evals,
    plan: [{ step_id: 's1', intent: 'new plan', tier: 'flash', status: 'done' }],
  });
  assert.equal(progressDelta(base, relabelled).current_digest, progressDelta(base, base).current_digest);
  assert.notEqual(
    progressDelta(base, tidy(1, { checks: base.checks, evals: base.evals, artifact: 'd2' })).current_digest,
    progressDelta(base, base).current_digest,
  );
});

test('rule: unchanged evidence is stalled without asking D8, even across an iteration', async () => {
  const same = tidy(2, { checks: base.checks, evals: base.evals });
  const { port, calls } = d8('progressing');
  const record = await decideProgress(base, same, d8Input, port, now);
  assert.equal(record.delta?.rule, 'stalled');
  assert.equal(record.decided_by, 'rule');
  assert.equal(record.choice, 'stalled');
  assert.equal(record.site, null);
  assert.equal(calls.length, 0);
});

test('rule: a newly settled criterion with none lost is progressing', async () => {
  const next = tidy(2, {
    checks: [check('repo.test', 2), check('repo.lint', 2)],
    evals: [evaluation('c1', 2), evaluation('c2', 2)],
  });
  const { port, calls } = d8('regressing');
  const record = await decideProgress(base, next, d8Input, port, now);
  assert.deepEqual([record.decided_by, record.choice, calls.length], ['rule', 'progressing', 0]);
});

test('rule: a lost criterion with none gained is regressing', async () => {
  const next = tidy(2, { checks: [check('repo.test', 2, false), check('repo.lint', 2, false)], evals: [] });
  const { port, calls } = d8('progressing');
  const record = await decideProgress(base, next, d8Input, port, now);
  assert.deepEqual(record.delta?.criteria, [
    { criterion_id: 'c1', before: true, after: false },
    { criterion_id: 'c2', before: false, after: false },
  ]);
  assert.deepEqual([record.decided_by, record.choice, calls.length], ['rule', 'regressing', 0]);
});

test('mixed, unmoved, first-round and changed-criteria deltas ask D8 and record its observation', async () => {
  const mixed = tidy(2, {
    checks: [check('repo.test', 2, false), check('repo.lint', 2)],
    evals: [evaluation('c2', 2)],
  });
  const unmoved = tidy(2, {
    checks: [check('repo.test', 2), check('repo.lint', 2, false)],
    evals: [evaluation('c1', 2)],
  });
  const changed = tidy(1, { checks: base.checks, evals: base.evals, criteria: [c1] });
  for (const [previous, current, gained, lost] of [
    [base, mixed, 1, 1],
    [base, unmoved, 0, 0],
    [null, base, null, null],
    [base, changed, 0, 0],
  ] as const) {
    const { port, calls } = d8('progressing');
    const record = await decideProgress(previous, current, d8Input, port, now);
    assert.equal(record.decided_by, 'site');
    assert.equal(record.choice, 'progressing');
    assert.equal(calls.length, 1);
    assert.equal(record.site?.observation.site, 'loop.continue');
    assert.equal(record.site?.observation.reason, 'accepted');
    assert.equal(record.delta?.rule ?? null, null);
    assert.equal(record.delta?.gained ?? null, gained);
    assert.equal(record.delta?.lost ?? null, lost);
  }
  assert.equal(progressDelta(base, changed).removed, 1);
});

test('a decision outage cannot stop the rule; an undecided delta takes the recorded D8 fallback', async () => {
  const same = tidy(2, { checks: base.checks, evals: base.evals });
  const next = tidy(2, {
    checks: [check('repo.test', 2), check('repo.lint', 2)],
    evals: [evaluation('c1', 2), evaluation('c2', 2)],
  });
  for (const outage of ['outage', 'throw'] as const) {
    for (const [current, choice] of [
      [same, 'stalled'],
      [next, 'progressing'],
    ] as const) {
      const { port, calls } = d8(outage);
      const record = await decideProgress(base, current, { ...d8Input, needs_dispatch: true }, port, now);
      assert.deepEqual(
        [record.decided_by, record.choice, record.status, calls.length],
        ['rule', choice, 'transition', 0],
      );
    }
    const mixed = tidy(2, {
      checks: [check('repo.test', 2, false), check('repo.lint', 2)],
      evals: [evaluation('c2', 2)],
    });
    const { port, calls } = d8(outage);
    const fallback = await decideProgress(base, mixed, d8Input, port, now);
    assert.deepEqual([fallback.decided_by, fallback.choice, calls.length], ['site', 'stalled', 1]);
    assert.equal(fallback.site?.observation.reason, 'decision_unavailable');
    assert.equal(JSON.stringify(fallback).includes('provider-secret'), false);
  }
});

test('replay rebuilds the record from its delta and recorded D8 transition without a provider', async () => {
  const mixed = tidy(2, {
    checks: [check('repo.test', 2, false), check('repo.lint', 2)],
    evals: [evaluation('c2', 2)],
  });
  const same = tidy(2, { checks: base.checks, evals: base.evals });
  for (const current of [mixed, same]) {
    const record = await decideProgress(base, current, d8Input, d8('regressing').port, now);
    assert.deepEqual(Object.keys(record), ['schema', 'delta', 'decided_by', 'choice', 'status', 'site']);
    assert.equal(record.schema, 'progress.record@1');
    const stored: ProgressRecord = JSON.parse(JSON.stringify(record));
    assert.deepEqual(transitionProgress(stored.delta, stored.site), record);
    assert.equal(stored.delta === null ? null : progressRule(stored.delta), record.delta?.rule ?? null);
  }
  assert.throws(() => transitionProgress(progressDelta(base, mixed), null), /D8/);
});

test('a check-proven criterion settles on current green checks; retained checks and a current failing eval do not', () => {
  const proven: AuditCriterion = { ...c1, proof: 'check' };
  const settled = (state: AuditState) => progressDelta(state, state).criteria[0]?.after;
  assert.equal(settled(tidy(2, { criteria: [proven], checks: [check('repo.test', 2)] })), true);
  assert.equal(settled(tidy(2, { criteria: [proven], checks: [check('repo.test', 1)] })), false);
  assert.equal(
    settled(tidy(2, { criteria: [proven], checks: [check('repo.test', 2)], evals: [evaluation('c1', 2, false)] })),
    false,
  );
  // A judgment criterion needs a current confident pass: a historical pass or a live-shaped eval does not settle it.
  assert.equal(
    settled(tidy(2, { criteria: [c1], checks: [check('repo.test', 2)], evals: [evaluation('c1', 1)] })),
    false,
  );
  assert.equal(
    settled(
      tidy(2, {
        criteria: [c1],
        checks: [check('repo.test', 2)],
        evals: [{ criterion_id: 'c1', iteration: 2, verdict_probability: 0.98, confidence: null, passed: false }],
      }),
    ),
    false,
  );
  assert.equal(
    settled(
      tidy(2, {
        criteria: [c1],
        checks: [check('repo.test', 2), check('repo.test', 2, false)],
        evals: [evaluation('c1', 2)],
      }),
    ),
    false,
  );
});

test('with every check green, all criteria settled exactly when the audit loop completes', async () => {
  const proven: AuditCriterion = { ...c1, proof: 'check' };
  const cases: AuditState[] = [
    tidy(2, {
      checks: [check('repo.test', 2), check('repo.lint', 2)],
      evals: [evaluation('c1', 2), evaluation('c2', 2)],
    }),
    tidy(2, { checks: [check('repo.test', 2), check('repo.lint', 2)], evals: [evaluation('c1', 2)] }),
    tidy(2, {
      checks: [check('repo.test', 2), check('repo.lint', 2)],
      evals: [evaluation('c1', 1), evaluation('c2', 2)],
    }),
    tidy(2, {
      checks: [check('repo.test', 2), check('repo.lint', 2)],
      evals: [evaluation('c1', 2), evaluation('c2', 2), evaluation('c2', 2, false)],
    }),
    tidy(2, {
      criteria: [proven, c2],
      checks: [check('repo.test', 2), check('repo.lint', 2)],
      evals: [evaluation('c2', 2)],
    }),
    tidy(2, {
      criteria: [proven, c2],
      checks: [check('repo.test', 1), check('repo.lint', 2)],
      evals: [evaluation('c2', 2)],
    }),
  ];
  for (const [n, state] of cases.entries()) {
    const ports: AuditPorts = {
      current: now,
      budget: () => 'allow',
      observe: async () => ({ revision, state }),
      generate: async (request) => ({
        status: 'accepted',
        request_id: request.request_id,
        site: request.site,
        text: JSON.stringify({ findings: [], goal_met_claim: true }),
        routed_unit_id: 'strong',
        provider_response_id: 'a1',
        attempts: [],
        spent: 0,
        uncertainty: [],
      }),
      evaluate: async () => assert.fail('no finding needs D6'),
    };
    const round = await runAuditLoop({ execution_id: `progress-agree-${n}`, terms }, ports, new MemoryAuditJournal());
    const allSettled = progressDelta(state, state).criteria.every((item) => item.after);
    assert.equal(round.outcome, allSettled ? 'done' : 'evidence_missing', `case ${n}`);
  }
});

test('two consecutive rule-decided stalled rounds still stop the audit loop as no_progress', async () => {
  const states = [
    base,
    tidy(2, { checks: base.checks, evals: base.evals }),
    tidy(3, { checks: base.checks, evals: base.evals }),
  ];
  const records: ProgressRecord[] = [];
  for (let n = 1; n < states.length; n++) {
    const { port } = d8('progressing');
    records.push(await decideProgress(states[n - 1]!, states[n]!, d8Input, port, now));
  }
  assert.deepEqual(
    records.map((record) => [record.decided_by, record.choice]),
    [
      ['rule', 'stalled'],
      ['rule', 'stalled'],
    ],
  );
  const history = records.map((record) => record.choice);
  assert.equal(stopForNoProgress(history, []), 'no_progress');
  const ports: AuditPorts = {
    current: now,
    budget: () => 'allow',
    observe: async () => ({ revision, state: states[2]!, progress: history }),
    generate: async () => assert.fail('a no_progress stop precedes the audit call'),
    evaluate: async () => assert.fail('a no_progress stop precedes D6'),
  };
  const round = await runAuditLoop({ execution_id: 'progress-loop', terms }, ports, new MemoryAuditJournal());
  assert.equal(round.outcome, 'no_progress');
  assert.equal(round.goal_done, false);
});
