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
import { digest } from '../src/digest.js';
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
function iterationEval(criterion_id: string, iteration?: number | null, passed = true, confidence = .9, verdict_probability = .8) {
  return { criterion_id, ...(iteration === undefined ? {} : { iteration }), passed, confidence, verdict_probability };
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
        evals: [iterationEval('c1', observes, true, 1, 1)],
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
test('long resumed request ids are bounded, distinct and stable across checkpoint recovery', async () => {
  const prefix = 'execution'.padEnd(127, 'x');
  const run = async (execution_id: string) => {
    const f = fixture({ gaps: 1, ceilings: [1000], max: 1 });
    const ids: string[] = [];
    let calls = 0;
    const ports: AuditPorts = { ...f.ports,
      generate: async (request, signal) => {
        ids.push(request.request_id);
        assert.equal(correlation(request.request_id), request.request_id);
        if (++calls === 1) return { status: 'unaccepted', reason: 'budget_exhausted',
          request_id: request.request_id, site: request.site, attempts: [], spent: 0, uncertainty: [] };
        return f.ports.generate(request, signal);
      },
      evaluate: async (request, signal) => {
        ids.push(request.request_id);
        assert.equal(correlation(request.request_id), request.request_id);
        const result = await f.ports.evaluate(request, signal);
        assert.equal(result.status, 'accepted');
        return { ...result, answers: { finding_0: { type: 'choice', choice: 'defer', probabilities: { defer: 1 } } } } as unknown as typeof result;
      },
    };
    const input = { ...f.input, execution_id };
    assert.equal((await runAuditLoop(input, ports, f.journal)).outcome, 'budget');
    // Crash after the resumed observation is durable, before generation dispatch.
    const checkpoint = f.journal.checkpoint.bind(f.journal);
    f.journal.checkpoint = entry => { checkpoint(entry); throw new Error('crash before resumed generate'); };
    await assert.rejects(runAuditLoop({ ...input, resume: true }, ports, f.journal), /crash before resumed generate/);
    f.journal.checkpoint = checkpoint;
    const append = f.journal.append.bind(f.journal);
    f.journal.append = () => { throw new Error('crash after resumed D6'); };
    await assert.rejects(runAuditLoop({ ...input, resume: true }, ports, f.journal), /crash after resumed D6/);
    assert.equal(f.observes(), 2); assert.equal(f.generates(), 1);
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every(id => id.length <= 128));
    assert.ok(ids[1]!.endsWith(':r1:e2:audit'));
    assert.ok(ids[2]!.endsWith(':r1:e2:dispose'));
    f.journal.append = append;
    assert.equal((await runAuditLoop({ ...input, resume: true }, ports, f.journal)).outcome, 'done');
    assert.equal(f.observes(), 2); assert.equal(f.generates(), 1); assert.equal(ids.length, 3);
    return ids;
  };
  const executions = [`${prefix}a`, `${prefix}b`];
  const ids = await Promise.all(executions.map(run));
  assert.equal(new Set(ids.flat()).size, 6);
  assert.deepEqual(await Promise.all(executions.map(run)), ids);
});
test('bad generation response ids fail as audit_unavailable before D6', async () => {
  for (const request_id of ['wrong', 'x'.repeat(129), 'invalid id']) {
    const f = fixture({ gaps: 1 });
    const result = await runAuditLoop(f.input, { ...f.ports,
      generate: async (request, signal) => ({ ...await f.ports.generate(request, signal), request_id }),
      evaluate: async () => { assert.fail('D6 must not receive a mismatched generation'); },
    }, f.journal);
    assert.equal(result.outcome, 'audit_unavailable');
    assert.equal(result.report, null); assert.equal(result.disposal, null);
  }
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
test('crash after a paid generation but before its report checkpoint does not pay again without explicit resume (#165)', async () => {
  const f = fixture({ max: 1, ceilings: [1000, 1000] });
  const { gateway, calls } = replayGateway();
  const ports: AuditPorts = { ...f.ports, generate: gateway.generate, evaluate: gateway.evaluate };
  const checkpoint = f.journal.checkpoint.bind(f.journal);
  f.journal.checkpoint = entry => {
    if (entry.report) throw new Error('crash before durable report checkpoint');
    checkpoint(entry);
  };
  await assert.rejects(runAuditLoop(f.input, ports, f.journal), /crash before durable report checkpoint/);
  f.journal.checkpoint = checkpoint;
  assert.equal(calls.prompts.length, 1);
  const intent = f.journal.loadCheckpoint('audit1', 1);
  assert.equal(intent?.report, null);
  assert.equal(intent?.dispatched, 'audit1:r1:audit');
  const recovered = await runAuditLoop(f.input, { ...ports,
    observe: async () => { assert.fail('recovery reuses the checkpointed observation'); } }, f.journal);
  assert.equal(recovered.outcome, 'audit_unconfirmed');
  assert.equal(recovered.goal_done, false);
  assert.equal(recovered.report, null);
  assert.equal(calls.prompts.length, 1, 'recovery must not repeat a possibly paid generation implicitly');
  assert.deepEqual(await runAuditLoop(f.input, ports, f.journal), recovered);
  assert.deepEqual(replayAuditLoop(f.journal.load('audit1')), recovered);
  assert.equal(calls.prompts.length, 1);
  const resumed = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal);
  assert.equal(resumed.outcome, 'done');
  assert.equal(resumed.round, 1, 'the pause does not consume an audit round');
  assert.equal(calls.prompts.length, 2, 'explicit resume authorizes the new generation');
  assert.equal(f.observes(), 2, 'explicit resume captures fresh input');
});
test('crash recovery retains checkpoint evidence and rejects a changed live revision before D6', async () => {
  const f = fixture({ gaps: 1 });
  const checkpoint = f.journal.checkpoint.bind(f.journal);
  f.journal.checkpoint = entry => {
    checkpoint(entry);
    if (entry.report) throw new Error('crash after report checkpoint');
  };
  await assert.rejects(runAuditLoop(f.input, f.ports, f.journal), /crash after report checkpoint/);
  const saved = f.journal.loadCheckpoint('audit1', 1)!;
  assert.ok(saved.report);
  f.journal.checkpoint = checkpoint;
  let evaluates = 0;
  const resumed = await runAuditLoop({ ...f.input, resume: true }, { ...f.ports,
    observe: async () => { assert.fail('recovery must reuse checkpoint evidence'); },
    current: () => ({ state_revision: 2, state_updated_at: 20, observed_at: 20 }),
    evaluate: (request, signal) => { evaluates++; return f.ports.evaluate(request, signal); },
  }, f.journal);
  assert.equal(resumed.outcome, 'needs_human'); assert.equal(resumed.goal_done, false);
  assert.equal(evaluates, 0); assert.equal(f.generates(), 1);
  assert.deepEqual(resumed.report, saved.report);
  assert.equal(resumed.state_digest, saved.observation.state.digest);
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
  const f = fixture({ max: 1, ceilings: [1000] });
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
    const recover = () => runAuditLoop({ ...f.input, resume: true }, { ...f.ports,
      observe: async () => (await fixture().ports.observe([])),
      evaluate: async (request, signal) => {
        const result = await f.ports.evaluate(request, signal);
        assert.equal(result.status, 'accepted');
        return { ...result, answers: { finding_0: { type: 'choice', choice: 'defer', probabilities: { defer: 1 } } } } as unknown as typeof result;
      },
    }, f.journal);
    if (phase === 'generate') {
      // The aborted generation's outcome was never recorded, so it may have been paid (#165).
      const unconfirmed = await recover();
      assert.equal(unconfirmed.outcome, 'audit_unconfirmed');
      assert.equal(f.generates(), 1, 'recovery records the pause before any further spend');
    }
    const resumed = await recover();
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
test('abort during resume observation, generation or D6 preserves pre-abort evidence', async () => {
  for (const phase of ['observe', 'generate', 'D6'] as const) {
    const f = fixture({ ceilings: [1000], gaps: phase === 'D6' ? 1 : 0, max: 1 });
    const controller = new AbortController();
    const paused = await runAuditLoop(f.input, { ...f.ports, budget: () => 'pause' }, f.journal);
    const before = f.journal.load('audit1');
    let cancelled = false;
    const checkpoint = f.journal.checkpoint.bind(f.journal);
    f.journal.checkpoint = entry => { assert.equal(cancelled, false, 'no checkpoint after cancellation'); checkpoint(entry); };
    const append = f.journal.append.bind(f.journal);
    f.journal.append = entry => { assert.equal(cancelled, false, 'no append after cancellation'); append(entry); };
    const cancel = () => { cancelled = true; controller.abort(); };
    const ports: AuditPorts = { ...f.ports,
      observe: async issues => { const result = await f.ports.observe(issues); if (phase === 'observe') cancel(); return result; },
      generate: async (request, signal) => { const result = await f.ports.generate(request, signal); if (phase === 'generate') cancel(); return result; },
      evaluate: async (request, signal) => {
        assert.equal(phase, 'D6', 'D6 after cancellation');
        const result = await f.ports.evaluate(request, signal); cancel(); return result;
      },
    };
    const result = await runAuditLoop({ ...f.input, resume: true }, ports, f.journal, controller.signal);
    assert.equal(result.outcome, 'cancelled'); assert.equal(f.generates(), phase === 'observe' ? 0 : 1);
    assert.deepEqual(f.journal.load('audit1'), before);
    assert.deepEqual(await runAuditLoop(f.input, ports, f.journal), paused);
    assert.deepEqual(f.journal.load('audit1'), before);
    cancelled = false;
    const recover = () => runAuditLoop({ ...f.input, resume: true }, { ...f.ports,
      evaluate: async (request, signal) => {
        const result = await f.ports.evaluate(request, signal);
        assert.equal(result.status, 'accepted');
        return { ...result, answers: { finding_0: { type: 'choice', choice: 'defer', probabilities: { defer: 1 } } } } as unknown as typeof result;
      },
    }, f.journal);
    if (phase === 'generate') {
      const unconfirmed = await recover();
      assert.equal(unconfirmed.outcome, 'audit_unconfirmed'); assert.equal(unconfirmed.round, 1);
      assert.equal(f.generates(), 1, 'an unrecorded generation is not repeated implicitly (#165)');
    }
    const recovered = await recover();
    assert.equal(recovered.outcome, 'done'); assert.equal(recovered.round, 1);
    assert.equal(f.generates(), phase === 'generate' ? 2 : 1);
  }
});
test('aborted resume of a persisted pause writes nothing and does not observe or dispatch', async () => {
  const f = fixture({ budget: true });
  await runAuditLoop(f.input, f.ports, f.journal);
  const controller = new AbortController(); controller.abort();
  const result = await runAuditLoop({ ...f.input, resume: true }, f.ports, f.journal, controller.signal);
  assert.equal(result.outcome, 'cancelled'); assert.equal(f.observes(), 0); assert.equal(f.generates(), 0);
  assert.equal(f.journal.load('audit1').length, 1);
  assert.equal(f.journal.loadCheckpoint('audit1', 1), null);
  assert.equal((await runAuditLoop(f.input, f.ports, f.journal)).outcome, 'budget');
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

function iterationObservation(iteration: number, evals: readonly ReturnType<typeof iterationEval>[]) {
  return { revision, state: assembleAuditState({ authorized_slices: AUDIT_SLICES, iteration, evals,
    goal: { goal_id: 'goal1', statement: 'goal', revision: 1, authority_scope: [],
      success_criteria: ['c1', 'c2'].map(criterion_id => ({ criterion_id, statement: 'passes', check_ids: ['repo.test'] })) },
    source_revisions: { goal: 1 },
    checks: [{ check_id: 'repo.test', argv_digest: 'abc', passed: true, exit: 0, tail: '' }],
  }) };
}
const currentC2 = iterationEval('c2', 2);
for (const [name, evals, expected] of [
  ['historical failure then current pass completes', [iterationEval('c1', 1, false), iterationEval('c1', 2)], 'done'],
  ['current pass then current failure vetoes', [iterationEval('c1', 2), iterationEval('c1', 2, false)], 'evidence_missing'],
  ['current failure then current pass vetoes', [iterationEval('c1', 2, false), iterationEval('c1', 2)], 'evidence_missing'],
  ['historical pass cannot replace missing current evidence', [iterationEval('c1', 1)], 'evidence_missing'],
  ['untagged legacy pass cannot complete', [iterationEval('c1')], 'evidence_missing'],
  ['unknown iteration pass cannot complete', [iterationEval('c1', null)], 'evidence_missing'],
  ['future iteration pass cannot complete', [iterationEval('c1', 3)], 'evidence_missing'],
  ['current low confidence cannot complete', [iterationEval('c1', 2, true, .899)], 'evidence_missing'],
  ['current low probability cannot complete', [iterationEval('c1', 2, true, .9, .799)], 'evidence_missing'],
  ['historical high confidence cannot replace current low confidence', [iterationEval('c1', 1), iterationEval('c1', 2, true, .899)], 'evidence_missing'],
  ['current failure vetoes only its criterion', [iterationEval('c1', 2), iterationEval('c2', 2, false)], 'evidence_missing'],
] as const) {
  test(`D5 iteration scope: ${name}`, async () => {
    const f = fixture();
    const observed = iterationObservation(2, [...evals, currentC2]);
    const result = await runAuditLoop(f.input, { ...f.ports, observe: async () => observed }, f.journal);
    assert.equal(result.outcome, expected);
    assert.equal(result.goal_done, expected === 'done');
  });
}

test('D5 iteration scope: one criterion cannot borrow another criterion current pass', async () => {
  const f = fixture();
  const observed = iterationObservation(2, [iterationEval('c1', 2), iterationEval('c2', 1)]);
  assert.equal((await runAuditLoop(f.input, { ...f.ports, observe: async () => observed }, f.journal)).outcome, 'evidence_missing');
});

test('D5 iteration scope: zero is a valid producing iteration', async () => {
  const f = fixture();
  const observed = iterationObservation(0, [iterationEval('c1', 0), iterationEval('c2', 0)]);
  assert.equal((await runAuditLoop(f.input, { ...f.ports, observe: async () => observed }, f.journal)).outcome, 'done');
});

for (const phase of ['observe', 'D6'] as const) {
  test(`D5 iteration scope: abort during later ${phase} writes nothing after abort and recovery keeps current evidence`, async () => {
    const f = fixture({ gaps: 2 });
    const controller = new AbortController();
    const append = f.journal.append.bind(f.journal);
    const checkpoint = f.journal.checkpoint.bind(f.journal);
    f.journal.append = entry => { assert.equal(controller.signal.aborted, false, 'no append after abort'); append(entry); };
    f.journal.checkpoint = entry => { assert.equal(controller.signal.aborted, false, 'no checkpoint after abort'); checkpoint(entry); };
    let observes = 0;
    const observe: AuditPorts['observe'] = async () => {
      const iteration = ++observes === 1 ? 20 : 21;
      const result = iterationObservation(iteration, [iterationEval('c1', 20, false), iterationEval('c2', iteration),
        ...(iteration === 21 ? [iterationEval('c1', 21)] : [])]);
      if (phase === 'observe' && iteration === 21) controller.abort();
      return result;
    };
    const evaluate: AuditPorts['evaluate'] = async (request, signal) => {
      const result = await f.ports.evaluate(request, signal);
      if (observes === 1) return result;
      if (signal) controller.abort();
      assert.equal(result.status, 'accepted');
      return { ...result, answers: { finding_0: { type: 'choice', choice: 'defer', probabilities: { defer: 1 } } } } as unknown as typeof result;
    };
    const ports = { ...f.ports, observe, evaluate };
    const cancelled = await runAuditLoop(f.input, ports, f.journal, controller.signal);
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.round, 2);
    assert.deepEqual(f.journal.load('audit1').map(entry => entry.outcome), ['observe']);
    f.journal.append = append; f.journal.checkpoint = checkpoint;
    const recovered = await runAuditLoop({ ...f.input, resume: true }, { ...ports,
      observe: phase === 'D6' ? async () => { assert.fail('recover whole iteration 21 checkpoint'); } : observe,
    }, f.journal);
    assert.equal(recovered.outcome, 'done');
    assert.equal(recovered.round, 2);
    assert.equal(f.journal.loadCheckpoint('audit1', 2)?.observation.state.iteration, 21);
    assert.deepEqual(replayAuditLoop(f.journal.load('audit1')), recovered);
  });
}

test('D5 iteration scope: pause refresh and crash recovery use the checkpoint iteration, not the audit round', async () => {
  const f = fixture();
  let iteration = 10;
  let budgetReads = 0;
  let observes = 0;
  const ports: AuditPorts = { ...f.ports,
    budget: () => ++budgetReads === 2 ? 'pause' : 'allow',
    observe: async () => {
      observes++;
      return iterationObservation(iteration, [iterationEval('c1', 10), iterationEval('c2', 11)]);
    },
  };
  const paused = await runAuditLoop(f.input, ports, f.journal);
  assert.equal(paused.outcome, 'budget');
  iteration = 11;
  const append = f.journal.append.bind(f.journal);
  f.journal.append = () => { throw new Error('crash before refreshed round append'); };
  await assert.rejects(runAuditLoop({ ...f.input, resume: true }, ports, f.journal), /crash before refreshed round append/);
  const saved = f.journal.loadCheckpoint('audit1', 1)!;
  assert.equal(saved.observation.state.iteration, 11);
  assert.equal(saved.resume_from, paused.id);
  assert.equal(observes, 2);
  f.journal.append = append;
  const recovered = await runAuditLoop({ ...f.input, resume: true }, { ...ports,
    observe: async () => { assert.fail('crash recovery must retain checkpoint iteration and evals together'); },
  }, f.journal);
  assert.equal(recovered.outcome, 'evidence_missing');
  assert.equal(recovered.state_digest, saved.observation.state.digest);
  assert.equal(recovered.round, 1);
  assert.equal(f.generates(), 2);
});

test('D5 iteration scope: legacy checkpoint with untagged evals replays without completing', async () => {
  const f = fixture();
  const observation = JSON.parse(JSON.stringify(iterationObservation(2, [iterationEval('c1'), iterationEval('c2')])));
  f.journal.checkpoint({ execution_id: 'audit1', round: 1, observation,
    report: { findings: [], goal_met_claim: true } });
  const result = await runAuditLoop(f.input, { ...f.ports,
    observe: async () => { assert.fail('recover legacy observation'); },
    generate: async () => { assert.fail('recover legacy report'); },
  }, f.journal);
  assert.equal(result.outcome, 'evidence_missing');
  assert.deepEqual(replayAuditLoop(f.journal.load('audit1')), result);
});

test('D5 iteration scope: changed live revision cannot combine a saved observation with a new iteration', async () => {
  const f = fixture();
  const observed = iterationObservation(10, [iterationEval('c1', 10), iterationEval('c2', 10)]);
  const checkpoint = f.journal.checkpoint.bind(f.journal);
  f.journal.checkpoint = entry => { checkpoint(entry); throw new Error('crash after iteration 10 checkpoint'); };
  await assert.rejects(runAuditLoop(f.input, { ...f.ports, observe: async () => observed }, f.journal), /crash after iteration 10 checkpoint/);
  f.journal.checkpoint = checkpoint;
  const result = await runAuditLoop(f.input, { ...f.ports,
    observe: async () => { assert.fail('retain saved observation on crash recovery'); },
    current: () => ({ state_revision: 2, state_updated_at: 20, observed_at: 20 }),
    evaluate: async () => { assert.fail('no D6 for stale iteration 10'); },
  }, f.journal);
  assert.equal(result.outcome, 'needs_human');
  assert.equal(result.goal_done, false);
  assert.equal(result.state_digest, observed.state.digest);
});

// Criterion proof (#199): a check-proven criterion completes on its green bound checks.
function proofObservation(success_criteria: readonly { readonly criterion_id: string; readonly statement: string; readonly check_ids: readonly string[]; readonly proof?: 'check' | 'judgment' }[],
  evals: readonly ReturnType<typeof iterationEval>[], red = false, checkIteration: number | null | 'untagged' = 2) {
  return { revision, state: assembleAuditState({ authorized_slices: AUDIT_SLICES, iteration: 2, evals,
    goal: { goal_id: 'goal1', statement: 'goal', revision: 1, authority_scope: [], success_criteria: success_criteria.map(criterion => ({ ...criterion })) },
    source_revisions: { goal: 1 },
    checks: [{ check_id: 'repo.test', argv_digest: 'abc', passed: !red, exit: red ? 1 : 0, tail: '',
      ...(checkIteration === 'untagged' ? {} : { iteration: checkIteration }) }],
  }) };
}
const proven = { criterion_id: 'c1', statement: 'held-out suite passes', check_ids: ['repo.test'], proof: 'check' as const };
const judged = { criterion_id: 'c2', statement: 'passes', check_ids: ['repo.test'] };
for (const [name, criteria, evals, red, expected] of [
  ['check-proven criterion completes without a D5 eval', [proven], [], false, 'done'],
  ['check-proven plus a judged criterion with a current pass completes', [proven, judged], [iterationEval('c2', 2)], false, 'done'],
  ['explicit judgment still needs a current D5 pass', [{ ...proven, proof: 'judgment' as const }], [], false, 'evidence_missing'],
  ['the judged criterion still needs its own current pass', [proven, judged], [], false, 'evidence_missing'],
  ['a current failing eval still vetoes a check-proven criterion', [proven], [iterationEval('c1', 2, false)], false, 'evidence_missing'],
  ['a red bound check vetoes a check-proven criterion', [proven], [], true, 'evidence_missing'],
  ['a check-proven criterion with no bound checks cannot complete', [{ ...proven, check_ids: [] }], [], false, 'evidence_missing'],
] as const) {
  test(`criterion proof: ${name}`, async () => {
    const f = fixture();
    const observed = proofObservation(criteria, evals, red);
    const result = await runAuditLoop(f.input, { ...f.ports, observe: async () => observed }, f.journal);
    assert.equal(result.outcome, expected);
    assert.equal(result.goal_done, expected === 'done');
  });
}
for (const [name, checkIteration] of [
  ['a historical green check', 1], ['a future green check', 3], ['an untagged green check', 'untagged'],
  ['a null-iteration green check', null], ['an invalid-iteration green check', 1.5],
] as const) {
  test(`criterion proof: ${name} cannot settle a check-proven criterion`, async () => {
    const f = fixture();
    const observed = proofObservation([proven], [], false, checkIteration);
    const result = await runAuditLoop(f.input, { ...f.ports, observe: async () => observed }, f.journal);
    assert.equal(result.outcome, 'evidence_missing');
    assert.equal(result.goal_done, false);
  });
}

test('criterion proof: assembly keeps legacy criteria unchanged and rejects an unknown proof', () => {
  const legacy = proofObservation([judged], []).state;
  assert.equal('proof' in legacy.goal.success_criteria[0]!, false);
  assert.equal(proofObservation([proven], []).state.goal.success_criteria[0]?.proof, 'check');
  assert.throws(() => proofObservation([{ ...proven, proof: 'maybe' as never }], []), /Invalid criterion proof/);
});

// Review of #204: retained green checks from an earlier iteration must not settle a check-proven criterion.
function retainedObserve(proof: 'check' | 'judgment', tagCurrent: boolean) {
  let observes = 0;
  return async () => {
    observes++;
    const iteration = observes;
    // Round 2 advances the implementation iteration but retains round 1's check and D5 evidence.
    const evidenceIteration = tagCurrent ? iteration : 1;
    return { revision, issue_fix_attempts: {}, progress: [], state: assembleAuditState({ authorized_slices: AUDIT_SLICES, iteration,
      goal: { goal_id: 'goal1', statement: 'goal', revision: 1, authority_scope: [],
        success_criteria: [{ criterion_id: 'c1', statement: 'held-out suite passes', check_ids: ['repo.test'], proof }] },
      source_revisions: { goal: 1 },
      checks: [{ check_id: 'repo.test', argv_digest: 'abc', passed: true, exit: 0, tail: '', iteration: evidenceIteration }],
      evals: [iterationEval('c1', evidenceIteration, true, 1, 1)] }) };
  };
}
for (const proof of ['check', 'judgment'] as const) {
  test(`criterion proof: an audit fix followed by retained green checks cannot complete a ${proof} criterion`, async () => {
    const f = fixture({ gaps: 1 });
    const result = await runAuditLoop(f.input, { ...f.ports, observe: retainedObserve(proof, false) }, f.journal);
    assert.equal(f.journal.load('audit1')[0]?.outcome, 'observe');
    assert.equal(result.outcome, 'evidence_missing');
    assert.equal(result.goal_done, false);
  });
}
test('criterion proof: fresh green checks after an audit fix complete a check-proven criterion', async () => {
  const f = fixture({ gaps: 1 });
  const result = await runAuditLoop(f.input, { ...f.ports, observe: retainedObserve('check', true) }, f.journal);
  assert.equal(result.outcome, 'done');
  assert.equal(result.goal_done, true);
});

// #151: implementation-step open issues are disclosed audit context; completion reads the evidence behind them.
function implementationIssueObservation(red: boolean, evalPassed: boolean) {
  return { revision, state: assembleAuditState({ authorized_slices: AUDIT_SLICES, iteration: 2,
    goal: { goal_id: 'goal1', statement: 'goal', revision: 1, authority_scope: [],
      success_criteria: [{ criterion_id: 'c1', statement: 'passes', check_ids: ['repo.test'] }] },
    source_revisions: { goal: 1 },
    checks: [{ check_id: 'repo.test', argv_digest: 'abc', passed: !red, exit: red ? 1 : 0, tail: '' }],
    evals: [iterationEval('c1', 2, evalPassed)],
    open_issues: [
      { issue_id: 'exec-1:open', source: 'check', text: 'Deterministic checks failed.', severity: 'blocker' },
      { issue_id: 'exec-2:open', source: 'eval', text: 'Output evaluation failed for the listed criteria.', severity: 'blocker' },
    ],
  }) };
}
for (const [name, red, evalPassed, expected] of [
  ['current green evidence completes although an earlier step blocker is still listed', false, true, 'done'],
  ['a check blocker holds the goal open through its red check evidence', true, true, 'evidence_missing'],
  ['an eval blocker holds the goal open through its current failing D5 evidence', false, false, 'evidence_missing'],
] as const) {
  test(`implementation open issues are not completion predicates (#151): ${name}`, async () => {
    const f = fixture();
    const observed = implementationIssueObservation(red, evalPassed);
    assert.deepEqual(observed.state.open_issues.map(issue => issue.source), ['check', 'eval']);
    const result = await runAuditLoop(f.input, { ...f.ports, observe: async () => observed }, f.journal);
    assert.equal(result.outcome, expected);
    assert.equal(result.goal_done, expected === 'done');
    assert.deepEqual(result.open_issues, [], 'the loop carries only audit fix_now issues');
  });
}
