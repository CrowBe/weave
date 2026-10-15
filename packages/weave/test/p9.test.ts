import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditReport } from '../src/audit-loop.js';

test('audit report is typed observation and rejects malformed findings', () => {
  assert.equal(parseAuditReport('{"findings":[],"goal_met_claim":true}')?.goal_met_claim, true);
  assert.equal(parseAuditReport('{"findings":[{"kind":"grant"}],"goal_met_claim":true}'), null);
});
import { assembleAuditState, AUDIT_SLICES } from '../src/audit-view.js';
import { MemoryAuditJournal, runAuditLoop, replayAuditLoop, type AuditPorts, type AuditLoopInput } from '../src/audit-loop.js';
import { transitionAuditDispose } from '../src/sites/audit-dispose.js';
import type { EvaluationOutcome, InferenceTerms } from '@weave/gateway';
const terms: InferenceTerms = { quality: 'baseline', destinations: ['local'], max_context_tokens: 100,
  deadline: 100, cost_ceiling: 10, max_attempts: 1 };
const revision = { state_revision: 1, state_updated_at: 10 };
function fixture(options: { gaps?: number; red?: boolean; progress?: ('stalled'|'regressing')[]; budget?: boolean; max?: number } = {}) {
  let generates = 0;
  let observes = 0;
  const journal = new MemoryAuditJournal();
  const input: AuditLoopInput = { execution_id: 'audit1', terms, max_iterations: options.max ?? 4 };
  const ports: AuditPorts = {
    current: () => ({ ...revision, observed_at: 10 }), budget: () => options.budget ? 'pause' : 'allow',
    observe: async issues => {
      observes++;
      if (observes > 1) assert.ok(issues.length);
      return { revision, issue_fix_attempts: Object.fromEntries(issues.map(issue => [issue.issue_id, observes - 1])), progress: options.progress ?? [], state: assembleAuditState({ authorized_slices: AUDIT_SLICES,
        goal: { goal_id: 'goal1', statement: 'goal', revision: 1, authority_scope: [],
          success_criteria: [{ criterion_id: 'c1', statement: 'passes', check_ids: ['repo.test'] }] }, iteration: observes,
        source_revisions: { goal: 1 }, checks: [{ check_id: 'repo.test', argv_digest: 'abc', passed: !options.red, exit: options.red ? 1 : 0, tail: '' }],
        evals: [{ criterion_id: 'c1', passed: true, verdict_probability: 1, confidence: 1 }] }) };
    },
    generate: async request => {
      generates++;
      assert.equal(request.terms.tier, 'strong');
      const report = { findings: generates <= (options.gaps ?? 0) ? [{ criterion_id: 'c1', kind: 'gap', evidence_ref: 'ref_test', proposed_fix: 'Fix test' }] : [], goal_met_claim: true };
      return { status: 'accepted', request_id: request.request_id, site: request.site, text: JSON.stringify(report),
        routed_unit_id: 'fake', provider_response_id: 'fake1', attempts: [], spent: 0, uncertainty: [] };
    },
    evaluate: (async request => ({ status: 'accepted', kind: 'choice', request_id: request.request_id, site: request.site,
      answers: { finding_0: { type: 'choice', choice: 'fix_now', probabilities: { fix_now: 1 } } }, confidence: { finding_0: 1 },
      routed_unit_id: 'fake', provider_response_id: 'fake1', attempts: [], spent: 0, uncertainty: [] }) as EvaluationOutcome<'choice'>) as AuditPorts['evaluate'],
  };
  return { input, ports, journal, generates: () => generates };
}
test('audit gap loops through Observe, then deterministic evidence completes and replay has no calls', async () => {
  const f = fixture({ gaps: 1 });
  const result = await runAuditLoop(f.input, f.ports, f.journal);
  assert.equal(result.outcome, 'done'); assert.equal(f.generates(), 2);
  assert.equal(f.journal.load('audit1')[0]?.outcome, 'observe');
  assert.deepEqual(replayAuditLoop(f.journal.load('audit1')), result);
  assert.deepEqual(await runAuditLoop(f.input, f.ports, f.journal), result); assert.equal(f.generates(), 2);
});
test('audit claim with red check cannot complete', async () => {
  const f = fixture({ red: true }); const result = await runAuditLoop(f.input, f.ports, f.journal);
  assert.equal(result.outcome, 'evidence_missing'); assert.equal(result.goal_done, false);
});
test('audit cap, D8 no progress, repeated issue and budget stops persist', async () => {
  for (const [options, expected] of [
    [{ gaps: 10, max: 1 }, 'iteration_cap'], [{ progress: ['stalled', 'regressing'] }, 'no_progress'],
    [{ gaps: 10 }, 'repeated_issue'], [{ budget: true }, 'budget'],
  ] as const) {
    const f = fixture(options as Parameters<typeof fixture>[0]);
    const result = await runAuditLoop(f.input, f.ports, f.journal);
    assert.equal(result.outcome, expected); assert.equal(result.goal_done, false);
    assert.deepEqual(replayAuditLoop(f.journal.load('audit1')), result);
  }
});
test('D6 low confidence, stale and outage fall back to needs_human', () => {
  const input = { ...revision, request_id: 'r1', findings: [{}], state: {}, terms, needs_dispatch: false };
  const outcome: EvaluationOutcome<'choice'> = { status: 'accepted', kind: 'choice', site: 'audit.dispose', request_id: 'r1',
    answers: { finding_0: { type: 'choice', choice: 'fix_now', probabilities: { fix_now: 1 } } }, confidence: { finding_0: .74 },
    provider_response_id: 'p1', routed_unit_id: 'fake', attempts: [], spent: 0, uncertainty: [] };
  for (const recorded of [{ outcome, state_revision: 1, observed_at: 10 },
    { outcome, state_revision: 0, observed_at: 10 }, { outcome: null, state_revision: 1, observed_at: 10 }]) {
    const result = transitionAuditDispose(input, recorded, revision);
    assert.deepEqual(result.choices, ['needs_human']); assert.equal(result.observations[0]?.fallback_used, true);
  }
});
test('accepted audit is checkpointed before D6 and recovery reuses it', async () => {
  const f = fixture({ gaps: 1 });
  const original = f.journal.append.bind(f.journal);
  let crash = true;
  f.journal.append = entry => { if (crash) { crash = false; throw new Error('crash'); } original(entry); };
  await assert.rejects(runAuditLoop(f.input, f.ports, f.journal));
  assert.equal(f.generates(), 1);
  assert.ok(f.journal.loadCheckpoint('audit1', 1)?.report);
  const done = await runAuditLoop(f.input, f.ports, f.journal);
  assert.equal(done.outcome, 'done'); assert.equal(f.generates(), 2);
});
test('authority and unavailable dispatch stop before generation', async () => {
  for (const blocked of [{ authority_blocked: true }, { needs_dispatch: true, decision_unavailable: true }]) {
    const f = fixture(); const observe = f.ports.observe;
    const ports = { ...f.ports, observe: async (issues: Parameters<typeof observe>[0]) => ({ ...await observe(issues), ...blocked }) };
    const result = await runAuditLoop(f.input, ports, f.journal);
    assert.equal(result.goal_done, false); assert.equal(f.generates(), 0);
    assert.ok(['authority', 'needs_human'].includes(result.outcome));
  }
});
test('budget pause preserves loop issues and explicit resume reuses the audit round', async () => {
  const f = fixture({ gaps: 1 });
  let budgets = 0;
  const ports = { ...f.ports, budget: () => (++budgets === 3 ? 'pause' : 'allow') as 'pause'|'allow' };
  const paused = await runAuditLoop(f.input, ports, f.journal);
  assert.equal(paused.outcome, 'budget'); assert.equal(paused.open_issues.length, 1);
  assert.deepEqual(await runAuditLoop(f.input, ports, f.journal), paused);
  const done = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal);
  assert.equal(done.outcome, 'done'); assert.equal(done.round, 2);
});
test('revision change during empty D6 prevents completion', async () => {
  const f = fixture(); let reads = 0;
  const ports = { ...f.ports, current: () => ({ ...revision, state_revision: ++reads >= 2 ? 2 : 1, observed_at: 10 }) };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'needs_human');
});
test('generated cancellation remains a cancellation stop', async () => {
  const f = fixture();
  const ports: AuditPorts = { ...f.ports, generate: async request => ({ status: 'blocked', reason: 'no_route',
    request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [],
    paused: { type: 'loop.paused', policy: 'budget.policy@1', request_id: request.request_id, site: request.site, reason: 'cancelled' as 'quota_unknown', until: null } }) };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'cancelled');
});
test('gateway generation budget exhaustion pauses the audit', async () => {
  for (const reason of ['budget_exhausted', 'five_hour_budget_low', 'budget_pace_ahead'] as const) {
    const f = fixture();
    const ports: AuditPorts = { ...f.ports, generate: async request => reason === 'budget_exhausted' ? {
      status: 'unaccepted', reason, request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [],
    } : { status: 'blocked', reason, request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [] } };
    assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'budget');
  }
});
test('cancelled audit requires explicit resume and does not consume a round', async () => {
  const f = fixture({ max: 1 }); const controller = new AbortController(); controller.abort();
  const paused = await runAuditLoop(f.input, f.ports, f.journal, controller.signal);
  assert.equal(paused.outcome, 'cancelled');
  assert.deepEqual(await runAuditLoop(f.input, f.ports, f.journal), paused);
  const resumed = await runAuditLoop({ ...f.input, resume: true }, f.ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(resumed.round, 1);
});
