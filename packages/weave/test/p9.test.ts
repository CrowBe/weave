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
import { MemoryAuditJournal, runAuditLoop, replayAuditLoop, type AuditPorts, type AuditLoopInput, type AuditReport } from '../src/audit-loop.js';
import { evaluateAuditDispose, transitionAuditDispose } from '../src/sites/audit-dispose.js';
import { correlation } from '../src/sites/index.js';
import { createInferenceGateway, type EvaluationOutcome, type InferenceTerms, type RoutedUnit } from '@weave/gateway';
const terms: InferenceTerms = { quality: 'baseline', destinations: ['local'], max_context_tokens: 100,
  deadline: 100, cost_ceiling: 10, max_attempts: 1 };
const revision = { state_revision: 1, state_updated_at: 10 };
const decisionUnit: RoutedUnit = { routed_unit_id: 'decision.fake', tier: 'decision', operation: 'evaluate',
  kind: 'choice', adapter: 'fake', model: 'fake', context_profile: 'none', context_profile_version: 1,
  prompt_template: 'none', prompt_template_version: 1, settings: { max_output_tokens: 1 }, destination: 'local',
  quality: 'baseline', context_limit_tokens: 1_000_000, price: { input_per_mtok: 0, output_per_mtok: 0 } };
function replayGateway() {
  const calls = { prompts: [] as string[], states: [] as unknown[], report: {
    findings: [{ criterion_id: 'c1', kind: 'gap', evidence_ref: 'ref_test', proposed_fix: 'Fix original' }],
    goal_met_claim: true,
  } as AuditReport, choice: 'defer' as 'defer' | 'needs_human' };
  const strong: RoutedUnit = { ...decisionUnit, routed_unit_id: 'strong.fake', tier: 'strong',
    quota_provider: 'fake', operation: 'generate', kind: 'judge',
    price: { input_per_mtok: 1000, output_per_mtok: 1000 } };
  const gateway = createInferenceGateway({ routes: [strong, decisionUnit], clock: { now: () => 10 },
    quota: { async read() { return { observed_at: 10, providers: [{ provider: 'fake', status: 'fresh', windows: [
      { id: 'seven_day', percentRemaining: 90, resetsAt: 1000, pace: { status: 'on_pace' } }] }] }; } },
    adapters: [{ id: 'fake', async execute(request) {
      calls.prompts.push(request.prompt);
      return { status: 'completed', text: JSON.stringify(calls.report), usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: 'stop', provider_response_id: undefined };
    } }],
    evaluators: [{ id: 'fake', async evaluate(request) {
      calls.states.push(structuredClone(request.state));
      return { status: 'completed', answers: { finding_0: { type: 'choice', choice: calls.choice,
        probabilities: { [calls.choice]: 1 } } }, confidence: { finding_0: 1 },
        usage: { input_tokens: 1, output_tokens: 1 }, provider_response_id: undefined };
    } }],
  });
  return { gateway, calls };
}
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
test('long execution request ids are bounded, deterministic and distinct across concurrent loops', async () => {
  const prefix = 'execution'.padEnd(127, 'x');
  const run = async (execution_id: string) => {
    const f = fixture({ gaps: 1 });
    const ids: string[] = [];
    const result = await runAuditLoop({ ...f.input, execution_id }, { ...f.ports,
      generate: (request, signal) => {
        ids.push(request.request_id);
        assert.equal(correlation(request.request_id), request.request_id, 'generate id must be a valid correlation');
        return f.ports.generate(request, signal);
      },
      evaluate: (request, signal) => {
        ids.push(request.request_id);
        assert.equal(correlation(request.request_id), request.request_id, 'D6 id must be a valid correlation');
        return f.ports.evaluate(request, signal);
      },
    }, f.journal);
    assert.equal(result.outcome, 'done');
    assert.equal(ids.length, 3); // generate and D6 in round 1, generate in round 2
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every(id => id.length <= 128));
    return ids;
  };
  const executions = [prefix.slice(0, 120), `${prefix}a`, `${prefix}b`];
  const ids = await Promise.all(executions.map(run));
  assert.equal(new Set(ids.flat()).size, 9);
  assert.deepEqual(await Promise.all(executions.map(run)), ids);
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
test('D6 strips audit purpose while preserving other terms and strong audit generation', async () => {
  const f = fixture({ gaps: 1, max: 1 });
  const supplied: InferenceTerms = { ...terms, audit: true, tier: 'strong', max_attempts_per_route: 1,
    prefix_digest: 'prefix1', prefix_cache: { prefix_digest: 'prefix1', routed_unit_id: 'decision.fake', cached_tokens: 1 } };
  let received: InferenceTerms | undefined;
  let calls = 0;
  const gateway = createInferenceGateway({ routes: [decisionUnit], clock: { now: () => 10 }, evaluators: [{
    id: 'fake', async evaluate() { calls++; return { status: 'completed',
      answers: { finding_0: { type: 'choice', choice: 'defer', probabilities: { defer: 1 } } },
      confidence: { finding_0: 1 }, usage: { input_tokens: 0, output_tokens: 0 }, provider_response_id: undefined }; },
  }] });
  const result = await runAuditLoop({ ...f.input, terms: supplied }, { ...f.ports,
    evaluate: (request, signal) => { received = request.terms; return gateway.evaluate(request, signal); },
  }, f.journal);
  assert.equal(result.outcome, 'done');
  assert.deepEqual(result.disposal?.choices, ['defer']);
  const { audit: _audit, ...otherTerms } = supplied;
  assert.deepEqual(received, { ...otherTerms, tier: 'decision' });
  assert.equal(calls, 1);
  assert.equal(supplied.audit, true);
  assert.equal(f.generates(), 1);
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
test('state budget pause re-observes on resume and proceeds once the ceiling is raised', async () => {
  const f = fixture({ ceilings: [100, 200] });
  const paused = await runAuditLoop(f.input, f.ports, f.journal);
  assert.equal(paused.outcome, 'budget'); assert.equal(f.generates(), 0);
  const resumed = await runAuditLoop({ ...f.input, resume: true }, f.ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(resumed.round, 1);
  assert.equal(f.observes(), 2); assert.equal(f.generates(), 1);
});
test('gateway repeated request ids with changed prefix and findings receive fresh outcomes', async () => {
  const { gateway, calls } = replayGateway();
  const original = await fixture().ports.observe([]);
  const changed = await fixture({ red: true }).ports.observe([]);
  const generate = (state: typeof original.state) => gateway.generate({ request_id: 'audit1:r1:audit',
    site: 'audit.generate', role: 'working', kind: 'judge', terms: { ...terms, tier: 'strong', audit: true, prefix_digest: state.digest },
    input: { instructions: 'Audit', prompt: JSON.stringify(state) } });
  const dispose = (report: AuditReport) => evaluateAuditDispose({ ...revision, request_id: 'audit1:r1:dispose',
    findings: report.findings, state: { audit: report }, terms, needs_dispatch: false }, gateway,
  () => ({ ...revision, observed_at: 10 }));
  const first = await generate(original.state);
  assert.equal(first.status, 'accepted');
  assert.ok(first.spent > 0);
  const firstReport = structuredClone(calls.report);
  assert.deepEqual((await dispose(firstReport)).choices, ['defer']);
  calls.report = { ...firstReport, findings: [{ ...firstReport.findings[0]!, proposed_fix: 'Fix changed' }] };
  calls.choice = 'needs_human';
  const second = await generate(changed.state);
  assert.equal(second.status, 'accepted');
  assert.ok(second.spent > 0);
  assert.deepEqual(parseAuditReport(second.text), calls.report);
  assert.deepEqual((await dispose(calls.report)).choices, ['needs_human']);
  assert.notEqual(original.state.digest, changed.state.digest);
  assert.deepEqual(calls.prompts, [JSON.stringify(original.state), JSON.stringify(changed.state)]);
  assert.deepEqual(calls.states, [{ audit: firstReport }, { audit: calls.report }]);
});
test('budget resume with changed state receives a fresh outcome through the real gateway', async () => {
  const f = fixture({ ceilings: [100, 200], max: 1 });
  const { gateway, calls } = replayGateway();
  const ports: AuditPorts = { ...f.ports, generate: gateway.generate, evaluate: gateway.evaluate };
  const paused = await runAuditLoop(f.input, ports, f.journal);
  assert.equal(paused.outcome, 'budget');
  assert.equal(f.journal.loadCheckpoint(f.input.execution_id, 1), null);
  assert.equal(calls.prompts.length, 0);
  const resumed = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(resumed.round, paused.round);
  assert.notEqual(resumed.state_digest, paused.state_digest);
  assert.equal(JSON.parse(calls.prompts[0]!).digest, resumed.state_digest);
  assert.deepEqual(resumed.report, calls.report);
  assert.deepEqual(resumed.disposal?.choices, ['defer']);
  assert.equal(calls.prompts.length, 1); assert.equal(calls.states.length, 1);
});
test('crash after generate before D6 reuses the paid report and gets a fresh disposal', async () => {
  const f = fixture({ max: 1 });
  const { gateway, calls } = replayGateway();
  const ports: AuditPorts = { ...f.ports, generate: gateway.generate, evaluate: gateway.evaluate };
  const checkpoint = f.journal.checkpoint.bind(f.journal);
  let crash = true;
  f.journal.checkpoint = entry => {
    checkpoint(entry);
    if (entry.report && crash) { crash = false; throw new Error('crash after durable report checkpoint'); }
  };
  await assert.rejects(runAuditLoop(f.input, ports, f.journal), /crash after durable report checkpoint/);
  assert.equal(calls.prompts.length, 1); assert.equal(calls.states.length, 0);
  const saved = structuredClone(calls.report);
  calls.report = { ...saved, findings: [{ ...saved.findings[0]!, proposed_fix: 'Different finding' }] };
  // A prior independent evaluation with the same id must not seed a cached D6 answer.
  calls.choice = 'needs_human';
  await evaluateAuditDispose({ ...revision, request_id: 'audit1:r1:dispose', findings: calls.report.findings,
    state: { audit: calls.report }, terms, needs_dispatch: false }, gateway, ports.current);
  calls.choice = 'defer';
  const recovered = await runAuditLoop(f.input, { ...ports, observe: async () => { throw new Error('must reuse checkpoint'); } }, f.journal);
  assert.equal(recovered.outcome, 'done');
  assert.deepEqual(recovered.report, saved);
  assert.deepEqual(recovered.disposal?.choices, ['defer']);
  assert.equal(calls.prompts.length, 1, 'recovery must not re-spend generation');
  assert.equal(calls.states.length, 2);
  assert.deepEqual(calls.states.at(-1), { audit: saved });
  assert.deepEqual(await runAuditLoop(f.input, ports, f.journal), recovered);
  assert.equal(calls.prompts.length, 1); assert.equal(calls.states.length, 2);
});
test('resume retains checkpoint evidence and rejects a changed live revision before D6', async () => {
  const f = fixture({ gaps: 1 });
  let budgets = 0;
  const paused = await runAuditLoop(f.input, { ...f.ports,
    budget: () => (++budgets === 2 ? 'pause' : 'allow'),
  }, f.journal);
  assert.equal(paused.outcome, 'budget'); assert.ok(paused.report);
  let evaluates = 0;
  const resumed = await runAuditLoop({ ...f.input, resume: true }, { ...f.ports,
    current: () => ({ state_revision: 2, state_updated_at: 20, observed_at: 20 }),
    evaluate: (request, signal) => { evaluates++; return f.ports.evaluate(request, signal); },
  }, f.journal);
  assert.equal(resumed.outcome, 'needs_human'); assert.equal(resumed.goal_done, false);
  assert.equal(evaluates, 0); assert.equal(f.generates(), 1);
  assert.deepEqual(resumed.report, paused.report);
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
  const f = fixture({ max: 1 });
  const paused = await runAuditLoop(f.input, { ...f.ports, generate: async request => ({ status: 'blocked', reason: 'no_route',
    request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [],
    paused: { type: 'loop.paused', policy: 'budget.policy@1', request_id: request.request_id, site: request.site,
      reason: 'cancelled' as 'quota_unknown', until: null } }) }, f.journal);
  assert.equal(paused.outcome, 'cancelled');
  assert.deepEqual(await runAuditLoop(f.input, f.ports, f.journal), paused);
  const resumed = await runAuditLoop({ ...f.input, resume: true }, f.ports, f.journal);
  assert.equal(resumed.outcome, 'done'); assert.equal(resumed.round, 1);
});
for (const phase of ['observe', 'generate', 'D6'] as const) {
  test(`abort during ${phase} returns cancelled without journal writes after abort and resume works`, async () => {
    const f = fixture({ gaps: phase === 'D6' ? 1 : 0, max: 1 });
    const controller = new AbortController();
    const writes: string[] = [];
    const checkpoint = f.journal.checkpoint.bind(f.journal);
    const append = f.journal.append.bind(f.journal);
    f.journal.checkpoint = entry => { if (controller.signal.aborted) writes.push('checkpoint'); checkpoint(entry); };
    f.journal.append = entry => { if (controller.signal.aborted) writes.push('append'); append(entry); };
    let evaluates = 0;
    const ports: AuditPorts = { ...f.ports,
      observe: async issues => {
        const observed = await f.ports.observe(issues);
        if (phase === 'observe') controller.abort();
        return observed;
      },
      generate: async (request, signal) => {
        assert.equal(signal, controller.signal);
        const generated = await f.ports.generate(request, signal);
        if (phase === 'generate') controller.abort();
        return generated;
      },
      evaluate: async (request, signal) => {
        evaluates++;
        assert.equal(signal, controller.signal);
        const evaluated = await f.ports.evaluate(request, signal);
        controller.abort();
        return evaluated;
      },
    };
    const cancelled = await runAuditLoop(f.input, ports, f.journal, controller.signal);
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.goal_done, false);
    assert.deepEqual(writes, []);
    assert.equal(evaluates, phase === 'D6' ? 1 : 0);
    assert.equal(f.journal.load(f.input.execution_id).length, 0);
    // Return a fresh defer disposition on recovery, rather than the aborted fix_now.
    const resumed = await runAuditLoop({ ...f.input, resume: true }, { ...f.ports,
      observe: async () => (await fixture().ports.observe([])),
      evaluate: async (request, signal) => {
        const result = await f.ports.evaluate(request, signal);
        assert.equal(result.status, 'accepted');
        return { ...result, answers: { finding_0: { type: 'choice', choice: 'defer', probabilities: { defer: 1 } } } } as unknown as typeof result;
      },
    }, f.journal);
    assert.equal(resumed.outcome, 'done');
    assert.equal(resumed.round, 1);
    if (phase === 'D6') assert.equal(f.generates(), 1, 'checkpointed generation must not be re-spent');
  });
}
test('already aborted audit performs no dispatch or journal write and can resume', async () => {
  const f = fixture({ max: 1 });
  const controller = new AbortController(); controller.abort();
  const cancelled = await runAuditLoop(f.input, f.ports, f.journal, controller.signal);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.deepEqual(f.journal.load(f.input.execution_id), []);
  assert.equal(f.journal.loadCheckpoint(f.input.execution_id, 1), null);
  assert.equal(f.observes(), 0); assert.equal(f.generates(), 0);
  assert.equal((await runAuditLoop({ ...f.input, resume: true }, f.ports, f.journal)).outcome, 'done');
});
