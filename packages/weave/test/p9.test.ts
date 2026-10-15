import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditReport } from '../src/audit-loop.js';

test('audit report is typed observation and rejects malformed findings', () => {
  assert.equal(parseAuditReport('{"findings":[],"goal_met_claim":true}')?.goal_met_claim, true);
  assert.equal(parseAuditReport('{"findings":[{"kind":"grant"}],"goal_met_claim":true}'), null);
});
test('audit report secret screen matches token prefixes, not ordinary words', () => {
  const report = (fix: string) => parseAuditReport(JSON.stringify({ goal_met_claim: false,
    findings: [{ criterion_id: 'c1', kind: 'gap', evidence_ref: 'ref_test', proposed_fix: fix }] }));
  for (const fix of ['Check task_id', 'Lower risk-score', 'Free disk-space', 'Apply mask_bits', 'Tasks-list'])
    assert.equal(report(fix)?.findings[0]?.proposed_fix, fix);
  for (const fix of ['Use sk-abc123', 'key=sk_live_x', 'x_sk-abc', 'Bearer abc', 'eyJhbGci', 'ghp_abc', 'AKIAABC'])
    assert.equal(report(fix), null);
});
import { assembleAuditState, AUDIT_SLICES } from '../src/audit-view.js';
import { MemoryAuditJournal, runAuditLoop, replayAuditLoop, type AuditPorts, type AuditLoopInput } from '../src/audit-loop.js';
import { digest } from '../src/digest.js';
import { transitionAuditDispose } from '../src/sites/audit-dispose.js';
import { createInferenceGateway, type EvaluationOutcome, type InferenceTerms, type RoutedUnit } from '@weave/gateway';
const terms: InferenceTerms = { quality: 'baseline', destinations: ['local'], max_context_tokens: 100,
  deadline: 100, cost_ceiling: 10, max_attempts: 1 };
const revision = { state_revision: 1, state_updated_at: 10 };
function fixture(options: { gaps?: number; red?: boolean; progress?: ('stalled'|'regressing')[]; budget?: boolean; max?: number; ceilings?: number[] } = {}) {
  let generates = 0;
  let observes = 0;
  const journal = new MemoryAuditJournal();
  const input: AuditLoopInput = { execution_id: 'audit1', terms, max_iterations: options.max ?? 4 };
  const ports: AuditPorts = {
    current: () => ({ ...revision, observed_at: 10 }), budget: () => options.budget ? 'pause' : 'allow',
    observe: async issues => {
      observes++;
      if (observes > 1 && !options.ceilings) assert.ok(issues.length);
      return { revision, issue_fix_attempts: Object.fromEntries(issues.map(issue => [issue.issue_id, observes - 1])), progress: options.progress ?? [], state: assembleAuditState({ authorized_slices: AUDIT_SLICES,
        goal: { goal_id: 'goal1', statement: 'goal', revision: 1, authority_scope: [],
          success_criteria: [{ criterion_id: 'c1', statement: 'passes', check_ids: ['repo.test'] }] }, iteration: observes,
        source_revisions: { goal: 1 }, checks: [{ check_id: 'repo.test', argv_digest: 'abc', passed: !options.red, exit: options.red ? 1 : 0, tail: '' }],
        evals: [{ criterion_id: 'c1', passed: true, verdict_probability: 1, confidence: 1 }],
        budget: options.ceilings ? { spent_micros: 100, ceiling_micros: options.ceilings[observes - 1] ?? 1000, quota: [] } : null }) };
    },
    generate: async request => {
      generates++;
      assert.equal(request.terms.tier, 'strong'); assert.equal(request.terms.audit, true);
      const report = { findings: generates <= (options.gaps ?? 0) ? [{ criterion_id: 'c1', kind: 'gap', evidence_ref: 'ref_test', proposed_fix: 'Fix test' }] : [], goal_met_claim: true };
      return { status: 'accepted', request_id: request.request_id, site: request.site, text: JSON.stringify(report),
        routed_unit_id: 'fake', provider_response_id: 'fake1', attempts: [], spent: 0, uncertainty: [] };
    },
    evaluate: (async request => ({ status: 'accepted', kind: 'choice', request_id: request.request_id, site: request.site,
      answers: { finding_0: { type: 'choice', choice: 'fix_now', probabilities: { fix_now: 1 } } }, confidence: { finding_0: 1 },
      routed_unit_id: 'fake', provider_response_id: 'fake1', attempts: [], spent: 0, uncertainty: [] }) as EvaluationOutcome<'choice'>) as AuditPorts['evaluate'],
  };
  return { input, ports, journal, generates: () => generates, observes: () => observes };
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
    assert.ok(['authority', 'decision_unavailable'].includes(result.outcome));
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
test('state budget pause re-observes on resume and proceeds once the ceiling is raised', async () => {
  const f = fixture({ ceilings: [100, 200] });
  const paused = await runAuditLoop(f.input, f.ports, f.journal);
  assert.equal(paused.outcome, 'budget'); assert.equal(f.generates(), 0);
  const resumed = await runAuditLoop({ ...f.input, resume: true }, f.ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(resumed.round, 1);
  assert.equal(f.observes(), 2); assert.equal(f.generates(), 1);
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
  // budget_pace_ahead is only blocked for audit:true requests, so it is covered
  // through the real gateway below rather than with a faked blocked result.
  for (const reason of ['budget_exhausted', 'five_hour_budget_low'] as const) {
    const f = fixture();
    const ports: AuditPorts = { ...f.ports, generate: async request => reason === 'budget_exhausted' ? {
      status: 'unaccepted', reason, request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [],
    } : { status: 'blocked', reason, request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [] } };
    assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'budget');
  }
});
test('ahead pace through the real gateway pauses the audit instead of a standard-tier downgrade', async () => {
  const unit: RoutedUnit = { routed_unit_id: 'strong.codex', tier: 'strong', quota_provider: 'codex',
    operation: 'generate', kind: 'judge', adapter: 'fake', model: 'fake', context_profile: 'none', context_profile_version: 1,
    prompt_template: 'none', prompt_template_version: 1, settings: { max_output_tokens: 1 }, destination: 'local',
    quality: 'baseline', context_limit_tokens: 1_000_000, price: { input_per_mtok: 0, output_per_mtok: 0 } };
  const standard: RoutedUnit = { ...unit, routed_unit_id: 'standard.codex', tier: 'standard' };
  const pauses: unknown[] = [];
  let calls = 0;
  const gateway = createInferenceGateway({ routes: [unit, standard], clock: { now: () => 100 },
    quota: { async read() { return { observed_at: 100, providers: [{ provider: 'codex', status: 'fresh', windows: [
      { id: 'seven_day', percentRemaining: 90, resetsAt: 500_000, pace: { status: 'ahead' } }] }] }; } },
    async persist_pause(record) { pauses.push(record); },
    adapters: [{ id: 'fake', async execute() { calls++; return { status: 'completed' as const,
      text: JSON.stringify({ findings: [], goal_met_claim: true }), usage: { input_tokens: 0, output_tokens: 0 },
      finish_reason: 'stop', provider_response_id: undefined }; } }] });
  const f = fixture();
  const ports: AuditPorts = { ...f.ports, generate: (request, signal) => gateway.generate(request, signal) };
  const input = { ...f.input, terms: { ...terms, max_context_tokens: 1_000_000, deadline: 1_000_000 } };
  const paused = await runAuditLoop(input, ports, f.journal);
  assert.equal(paused.outcome, 'budget'); assert.equal(paused.report, null); assert.equal(paused.goal_done, false);
  assert.equal(calls, 0);
  assert.deepEqual(pauses, [{ type: 'loop.paused', policy: 'budget.policy@1', request_id: 'audit1:r1:audit',
    site: 'audit.generate', reason: 'budget_pace_ahead', until: 500_000 }]);
});
test('cancelled audit requires explicit resume and does not consume a round', async () => {
  const f = fixture({ max: 1 }); const controller = new AbortController(); controller.abort();
  const paused = await runAuditLoop(f.input, f.ports, f.journal, controller.signal);
  assert.equal(paused.outcome, 'cancelled');
  assert.deepEqual(await runAuditLoop(f.input, f.ports, f.journal), paused);
  const resumed = await runAuditLoop({ ...f.input, resume: true }, f.ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(resumed.round, 1);
});

test('audit issue identity survives reworded proposed fixes', async () => {
  const f = fixture({ gaps: 10 });
  const generate = f.ports.generate;
  let calls = 0;
  const ports: AuditPorts = { ...f.ports, generate: async (request, signal) => {
    const result = await generate(request, signal);
    if (result.status !== 'accepted') return result;
    const report = JSON.parse(result.text);
    report.findings[0].proposed_fix = `Fix wording ${++calls}`;
    return { ...result, text: JSON.stringify(report) };
  } };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'repeated_issue');
  const ids = f.journal.load('audit1').flatMap(entry => entry.open_issues.map(issue => issue.issue_id));
  assert.equal(new Set(ids).size, 1);
});
test('audit report keeps the first finding for each criterion, kind and evidence key', () => {
  const first = { criterion_id: 'c1', kind: 'gap', evidence_ref: 'ref_test', proposed_fix: 'First fix' };
  const findings = [first, { ...first, proposed_fix: 'Reworded fix' },
    { ...first, criterion_id: null }, { ...first, kind: 'defect' }, { ...first, evidence_ref: 'ref_other' }];
  assert.deepEqual(parseAuditReport(JSON.stringify({ findings, goal_met_claim: false }))?.findings,
    [first, ...findings.slice(2)]);
});
test('legacy audit issue ids replay unchanged and count fix attempts without summing aliases', async () => {
  const f = fixture({ gaps: 10, max: 1 });
  await runAuditLoop(f.input, f.ports, f.journal);
  const first = f.journal.load('audit1')[0]!;
  const finding = first.report!.findings[0]!;
  const oldId = `audit_${digest(finding).slice(0, 32)}`;
  const newId = `audit_${digest({ criterion_id: finding.criterion_id, kind: finding.kind, evidence_ref: finding.evidence_ref }).slice(0, 32)}`;
  const legacy = { ...first, open_issues: first.open_issues.map(issue => ({ ...issue, issue_id: oldId })) };
  const journal = new MemoryAuditJournal(); journal.append(legacy);
  assert.deepEqual(replayAuditLoop(journal.load('audit1')), legacy);
  const observe = f.ports.observe;
  const ports: AuditPorts = { ...f.ports, observe: async issues => ({ ...await observe(issues),
    issue_fix_attempts: { [oldId]: 2, [newId]: 1 } }) };
  const result = await runAuditLoop({ ...f.input, max_iterations: 2 }, ports, journal);
  assert.equal(result.outcome, 'repeated_issue');
  assert.equal(result.open_issues[0]?.issue_id, newId);
  const another = new MemoryAuditJournal(); another.append(legacy);
  const oneAttempt: AuditPorts = { ...ports, observe: async issues => ({ ...await ports.observe(issues),
    issue_fix_attempts: { [oldId]: 1, [newId]: 1 } }) };
  assert.equal((await runAuditLoop({ ...f.input, max_iterations: 2 }, oneAttempt, another)).outcome, 'iteration_cap');
});

test('decision outage before guarded dispatch pauses and resumes when decisions recover', async () => {
  const f = fixture({ ceilings: [1000] });
  let unavailable = true;
  const observe = f.ports.observe;
  const ports: AuditPorts = { ...f.ports, observe: async issues => ({ ...await observe(issues),
    needs_dispatch: true, decision_unavailable: unavailable }) };
  const paused = await runAuditLoop(f.input, ports, f.journal);
  assert.equal(paused.outcome, 'decision_unavailable');
  assert.equal(f.generates(), 0);
  const entries = f.journal.load('audit1');
  assert.deepEqual(await runAuditLoop(f.input, ports, f.journal), paused);
  assert.deepEqual(f.journal.load('audit1'), entries);
  unavailable = false;
  const resumed = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(resumed.round, 1);
  assert.equal(f.observes(), 2); assert.equal(f.generates(), 1);
  assert.deepEqual(await runAuditLoop({ ...f.input, resume: true }, ports, f.journal), resumed);
  assert.equal(f.generates(), 1); assert.equal(f.journal.load('audit1').length, 2);
});

test('gateway pause resume re-observes changed state instead of stopping as needs_human', async () => {
  const f = fixture({ ceilings: [1000] });
  let stateRevision = 1;
  let calls = 0;
  const observe = f.ports.observe;
  const ports: AuditPorts = { ...f.ports,
    current: () => ({ ...revision, state_revision: stateRevision, observed_at: 10 }),
    observe: async issues => ({ ...await observe(issues), revision: { ...revision, state_revision: stateRevision } }),
    generate: async (request, signal) => ++calls === 1 ? { status: 'unaccepted', reason: 'budget_exhausted',
      request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [] } : f.ports.generate(request, signal),
  };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'budget');
  stateRevision = 2;
  const resumed = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(f.observes(), 2);
});
test('post-report budget pause reads the live budget on every resume', async () => {
  const f = fixture({ ceilings: [1000, 100, 200] });
  let budgetReads = 0;
  const ports: AuditPorts = { ...f.ports, budget: () => ++budgetReads === 2 ? 'pause' : 'allow' };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'budget');
  assert.ok(f.journal.loadCheckpoint('audit1', 1)?.report);
  const stillPaused = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal);
  assert.equal(stillPaused.outcome, 'budget'); assert.equal(f.observes(), 2); assert.equal(f.generates(), 1);
  assert.equal((await runAuditLoop({ ...f.input, resume: true }, ports, f.journal)).outcome, 'done');
  assert.equal(f.observes(), 3); assert.equal(f.generates(), 2);
});
test('resume crash reuses its fresh checkpoint and accepted report without another spend', async () => {
  const f = fixture({ ceilings: [1000] });
  let budgetReads = 0;
  const requestIds: string[] = [];
  const ports: AuditPorts = { ...f.ports, budget: () => ++budgetReads === 2 ? 'pause' : 'allow',
    generate: async (request, signal) => { requestIds.push(request.request_id); return f.ports.generate(request, signal); } };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'budget');
  const append = f.journal.append.bind(f.journal);
  f.journal.append = () => { throw new Error('crash before resumed append'); };
  await assert.rejects(runAuditLoop({ ...f.input, resume: true }, ports, f.journal));
  assert.equal(f.observes(), 2); assert.equal(f.generates(), 2);
  assert.equal(new Set(requestIds).size, 2);
  f.journal.append = append;
  const resumed = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(f.observes(), 2); assert.equal(f.generates(), 2);
  const entries = f.journal.load('audit1');
  assert.deepEqual(await runAuditLoop({ ...f.input, resume: true }, ports, f.journal), resumed);
  assert.deepEqual(f.journal.load('audit1'), entries);
});
test('unchanged state on resume can reuse the accepted report after observing live state', async () => {
  const f = fixture();
  const observed = await f.ports.observe([]);
  let reads = 0; let budgetReads = 0;
  const ports: AuditPorts = { ...f.ports, observe: async () => { reads++; return structuredClone(observed); },
    budget: () => ++budgetReads === 2 ? 'pause' : 'allow' };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'budget');
  assert.equal((await runAuditLoop({ ...f.input, resume: true }, ports, f.journal)).outcome, 'done');
  assert.equal(reads, 2); assert.equal(f.generates(), 1);
});
test('cancellation during resume observation or generation writes only the cancelled round', async () => {
  for (const phase of ['observe', 'generate'] as const) {
    const f = fixture({ ceilings: [1000] });
    const controller = new AbortController();
    await runAuditLoop(f.input, { ...f.ports, budget: () => 'pause' }, f.journal);
    let cancelled = false;
    const checkpoint = f.journal.checkpoint.bind(f.journal);
    f.journal.checkpoint = entry => { assert.equal(cancelled, false, 'no checkpoint after cancellation'); checkpoint(entry); };
    const cancel = () => { cancelled = true; controller.abort(); };
    const ports: AuditPorts = { ...f.ports,
      observe: async issues => { const result = await f.ports.observe(issues); if (phase === 'observe') cancel(); return result; },
      generate: async (request, signal) => { const result = await f.ports.generate(request, signal); cancel(); return result; },
      evaluate: async () => { assert.fail('D6 after cancellation'); },
    };
    const result = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal, controller.signal);
    assert.equal(result.outcome, 'cancelled'); assert.equal(f.generates(), phase === 'observe' ? 0 : 1);
    const entries = f.journal.load('audit1');
    assert.deepEqual(await runAuditLoop(f.input, ports, f.journal), result);
    assert.deepEqual(f.journal.load('audit1'), entries);
  }
});
test('cancelling a persisted pause appends cancellation without observing or dispatching', async () => {
  const f = fixture({ budget: true });
  await runAuditLoop(f.input, f.ports, f.journal);
  const controller = new AbortController(); controller.abort();
  const result = await runAuditLoop({ ...f.input, resume: true }, f.ports, f.journal, controller.signal);
  assert.equal(result.outcome, 'cancelled'); assert.equal(f.observes(), 0); assert.equal(f.generates(), 0);
  assert.equal(f.journal.load('audit1').length, 2);
});

test('resume crash after D6 reuses its checkpointed decision instead of spending again', async () => {
  const f = fixture({ gaps: 1 });
  await runAuditLoop(f.input, { ...f.ports, budget: () => 'pause' }, f.journal);
  let evaluations = 0;
  const ports: AuditPorts = { ...f.ports, evaluate: async (request, signal) => {
    evaluations++; return f.ports.evaluate(request, signal);
  } };
  const append = f.journal.append.bind(f.journal);
  f.journal.append = () => { throw new Error('crash after D6'); };
  await assert.rejects(runAuditLoop({ ...f.input, resume: true }, ports, f.journal));
  assert.equal(evaluations, 1); assert.equal(f.generates(), 1);
  f.journal.append = append;
  assert.equal((await runAuditLoop({ ...f.input, resume: true }, ports, f.journal)).outcome, 'done');
  assert.equal(evaluations, 1); assert.equal(f.generates(), 2);
});

test('gateway budget pause wins over a coincident revision change and resumes fresh', async () => {
  for (const kind of ['paused', 'exhausted', 'blocked'] as const) {
    const f = fixture({ ceilings: [1000] });
    let stateRevision = 1; let calls = 0;
    const observe = f.ports.observe;
    const ports: AuditPorts = { ...f.ports,
      current: () => ({ ...revision, state_revision: stateRevision, observed_at: 10 }),
      observe: async issues => ({ ...await observe(issues), revision: { ...revision, state_revision: stateRevision } }),
      generate: async (request, signal) => {
        if (++calls > 1) return f.ports.generate(request, signal);
        stateRevision++;
        const common = { request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [] };
        if (kind === 'exhausted') return { ...common, status: 'unaccepted', reason: 'budget_exhausted' };
        return { ...common, status: 'blocked', reason: 'weekly_budget_cap', ...(kind === 'paused' ? {
          paused: { type: 'loop.paused', policy: 'budget.policy@1', request_id: request.request_id,
            site: request.site, reason: 'weekly_budget_cap', until: null },
        } : {}) };
      },
    };
    assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'budget', kind);
    assert.equal((await runAuditLoop({ ...f.input, resume: true }, ports, f.journal)).outcome, 'done', kind);
    assert.equal(f.observes(), 2);
  }
});
test('live budget pause wins over a coincident revision change after accepted generation', async () => {
  const f = fixture({ ceilings: [1000] });
  let stateRevision = 1; let reads = 0;
  const observe = f.ports.observe;
  const ports: AuditPorts = { ...f.ports,
    current: () => ({ ...revision, state_revision: stateRevision, observed_at: 10 }),
    observe: async issues => ({ ...await observe(issues), revision: { ...revision, state_revision: stateRevision } }),
    budget: () => ++reads === 2 ? 'pause' : 'allow',
    generate: async (request, signal) => { const result = await f.ports.generate(request, signal); stateRevision = 2; return result; },
  };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'budget');
  assert.equal((await runAuditLoop({ ...f.input, resume: true }, ports, f.journal)).outcome, 'done');
  assert.equal(f.observes(), 2);
});
test('revision change during generation without a pause still stops as needs_human', async () => {
  const f = fixture(); let stateRevision = 1;
  const ports: AuditPorts = { ...f.ports,
    current: () => ({ ...revision, state_revision: stateRevision, observed_at: 10 }),
    generate: async (request, signal) => { const result = await f.ports.generate(request, signal); stateRevision++; return result; },
    evaluate: async () => { assert.fail('D6 must not run with stale input'); },
  };
  assert.equal((await runAuditLoop(f.input, ports, f.journal)).outcome, 'needs_human');
});
