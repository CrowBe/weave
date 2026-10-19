import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGrantAuthority, type Grant } from '@weave/agentsop';
import { AgentFabricHost, FabricStore } from '@weave/agentfabric';
import type { EvaluationOutcome, EvaluationRequest, GenerationOutcome, GenerationRequest, InferenceTerms } from '@weave/gateway';
import { DECLARED_TASK_POLICY } from '../src/task-acceptance.js';
import { transitionOutputEval, OUTPUT_EVAL_POLICY, OUTPUT_EVAL_QUESTION } from '../src/sites/output-eval.js';
import {
  DEFAULT_IMPLEMENT_RETRIES, FileAttemptJournal, MemoryAttemptJournal, createEqualGrantIssuer,
  replayImplementationStep, runImplementationStep,
  type AttemptJournal, type ImplementBudgetDecision, type ImplementCheck, type ImplementPorts, type ImplementStepInput,
  type ImplementTier,
} from '../src/implement-step.js';

const terms: InferenceTerms = {
  quality: 'baseline', destinations: ['local'], max_context_tokens: 100, deadline: 100, cost_ceiling: 10, max_attempts: 1,
};
const grant = {
  action_id: 'act-1', operation: 'repo.test', contract_rev: 'r1', permissions: [{ resource: 'workspace-1', mode: 'write' }],
  effects: [{ resource: 'workspace-1', mode: 'write' }], process_effects: ['process.spawn', 'fs.write:workspace-1'], issued_at: 1,
} as Grant;
const state = { state_revision: 1, state_updated_at: 10 };
function issued(operation: ImplementCheck['operation']): Grant {
  return { ...grant, action_id: operation, operation };
}
function grantScope(token: Grant | null | undefined) {
  return {
    action_id: token?.action_id ?? null,
    operation: token?.operation ?? null,
    contract_rev: token?.contract_rev ?? null,
    permissions: token?.permissions ?? null,
    effects: token?.effects ?? null,
    process_effects: token?.process_effects ?? null,
    issued_at: token?.issued_at ?? null,
  };
}
function input(overrides: Partial<ImplementStepInput> = {}): ImplementStepInput {
  const check: ImplementCheck = {
    operation: 'repo.test', grant, cwd_ref: 'workspace-1', env_allow: ['PUBLIC_NAME'], timeout_ms: 1000, argv: ['node', 'stub'],
  };
  return {
    execution_id: 'exec-1', request_id: 'req-1', tier: 'flash', ceiling: 'strong', criteria: [
      { criterion_id: 'c1', statement: 'the toy change meets the criterion' },
    ], instructions: 'implement the toy goal', prompt: 'make the tests pass', kind: 'transform', terms,
    checks: [check], ...overrides,
  };
}
function booleanOutcome(site: string, requestId: string, scores: Record<string, { p: number; conf?: number | null }>,
  confidenceOmitted = false): EvaluationOutcome<'boolean'> {
  const confidence: Record<string, number> = {};
  let includeConfidence = !confidenceOmitted;
  for (const [key, score] of Object.entries(scores)) {
    if (score.conf === undefined) includeConfidence = false;
    else if (score.conf !== null) confidence[key] = score.conf;
  }
  return {
    status: 'accepted', kind: 'boolean', site, request_id: requestId,
    answers: Object.fromEntries(Object.entries(scores).map(([key, score]) => [key, { type: 'boolean' as const, probability: score.p }])),
    confidence: includeConfidence ? confidence : undefined,
    provider_response_id: 'provider-1', routed_unit_id: 'fixture', attempts: [], spent: 0, uncertainty: [],
  };
}
function recorded(scores: Record<string, { p: number; conf?: number | null }>, confidenceOmitted = false) {
  return { state_revision: 1, observed_at: 10, outcome: booleanOutcome('eval.output', 'r1', scores, confidenceOmitted) };
}
const d5Input = {
  ...state, request_id: 'r1', state: { note: 'CANARY_STATE' }, needs_dispatch: false, terms,
  criteria: [{ criterion_id: 'c1', statement: 'CANARY_STATEMENT' }, { criterion_id: 'c2', statement: 'second' }],
};

test('D5 passes only at p >= .8 and confidence >= .9, and keeps decision-site key order', () => {
  assert.equal(OUTPUT_EVAL_POLICY.confidence, DECLARED_TASK_POLICY.confidence_floor);
  assert.equal(OUTPUT_EVAL_POLICY.probability, DECLARED_TASK_POLICY.probability_threshold);
  const pass = transitionOutputEval(d5Input, recorded({ criterion_0: { p: .8, conf: .9 }, criterion_1: { p: .95, conf: 1 } }), state);
  assert.equal(pass.status, 'pass');
  assert.deepEqual(pass.failing_criterion_ids, []);
  assert.equal(pass.observations[0]?.answer, 'pass');
  assert.deepEqual(Object.keys(pass.observations[0]!), ['schema', 'site', 'question', 'request_id', 'state_revision',
    'answer', 'confidence', 'top_p', 'accepted', 'fallback_used', 'reason', 'provider_request_id']);
  assert.equal(pass.observations[0]?.question, OUTPUT_EVAL_QUESTION);
  assert.equal(pass.observations[0]?.provider_request_id, 'provider-1');
  assert.ok(!JSON.stringify(pass).includes('CANARY'));
  const lowP = transitionOutputEval(d5Input, recorded({ criterion_0: { p: .799, conf: 1 }, criterion_1: { p: 1, conf: 1 } }), state);
  assert.equal(lowP.status, 'fail');
  assert.deepEqual(lowP.failing_criterion_ids, ['c1']);
  assert.equal(lowP.observations[0]?.reason, 'below_probability');
  assert.equal(lowP.observations[0]?.answer, 'fail');
  assert.equal(lowP.evals[1]?.passed, true);
});

test('D5 low confidence, missing confidence, stale, unparseable and outage each fail that criterion', () => {
  const low = transitionOutputEval(d5Input, recorded({ criterion_0: { p: .95, conf: .899 }, criterion_1: { p: 1, conf: 1 } }), state);
  assert.equal(low.observations[0]?.reason, 'low_confidence');
  assert.equal(low.evals[0]?.passed, false);
  assert.equal(low.observations[0]?.answer, null);
  const missing = transitionOutputEval(d5Input, recorded({ criterion_0: { p: .95 }, criterion_1: { p: 1, conf: 1 } }, true), state);
  assert.equal(missing.observations[0]?.reason, 'missing_confidence');
  assert.equal(missing.evals[0]?.passed, false);
  const stale = transitionOutputEval(d5Input, { ...recorded({ criterion_0: { p: 1, conf: 1 }, criterion_1: { p: 1, conf: 1 } }), observed_at: 9 }, state);
  assert.equal(stale.status, 'fail');
  assert.ok(stale.observations.every(item => item.reason === 'stale_answer' && item.fallback_used && !item.accepted));
  const good = recorded({ criterion_0: { p: 1, conf: 1 }, criterion_1: { p: 1, conf: 1 } });
  assert.equal(good.outcome.status, 'accepted');
  const malformed = good.outcome.status === 'accepted' ? {
    ...good,
    outcome: { ...good.outcome, answers: { ...good.outcome.answers, criterion_0: { type: 'boolean' as const, probability: Number.NaN } } },
  } : good;
  assert.equal(transitionOutputEval(d5Input, malformed, state).observations[0]?.reason, 'invalid_answer');
  const outage = transitionOutputEval(d5Input, { state_revision: 1, observed_at: 10, outcome: null }, state);
  assert.equal(outage.status, 'fail');
  assert.ok(outage.observations.every(item => item.reason === 'decision_unavailable' && item.fallback_used));
  assert.deepEqual(outage.failing_criterion_ids, ['c1', 'c2']);
  assert.deepEqual(outage, transitionOutputEval(d5Input, JSON.parse(JSON.stringify({ state_revision: 1, observed_at: 10, outcome: null })), state));
});

test('D5 does not accept an answer from another semantic operation', () => {
  const foreign = booleanOutcome('guard.output', 'r1', { criterion_0: { p: 1, conf: 1 }, criterion_1: { p: 1, conf: 1 } });
  const result = transitionOutputEval(d5Input, { state_revision: 1, observed_at: 10, outcome: foreign }, state);
  assert.equal(result.status, 'fail');
  assert.ok(result.observations.every(item => item.reason === 'mismatched_answer'));
  assert.ok(result.evals.every(item => !item.passed));
  const replay = transitionOutputEval(d5Input, JSON.parse(JSON.stringify(recorded({
    criterion_0: { p: .8, conf: .9 }, criterion_1: { p: 1, conf: 1 }, CANARY_UNKNOWN: { p: 1, conf: 1 },
  }))), state);
  assert.equal(replay.status, 'pass');
  assert.equal(replay.observations.at(-1)?.reason, 'unknown_answer');
  assert.ok(!JSON.stringify(replay).includes('CANARY'));
});

interface Driver {
  readonly input: ImplementStepInput;
  readonly ports: ImplementPorts;
  readonly journal: AttemptJournal;
  readonly generateIds: string[];
  readonly tiers: ImplementTier[];
  readonly prompts: string[];
  readonly evalSites: string[];
  readonly evalStates: unknown[];
  readonly invokes: { grant: Grant | null; operation: string; inputs: unknown; invocation_id?: string }[];
  crashesAt?: number;
}
function driver(options: {
  readonly input?: ImplementStepInput;
  readonly exits?: readonly number[];
  readonly evaluations?: readonly (Record<string, { p: number; conf?: number | null }> | 'outage' | 'throw' | 'stale')[];
  readonly budget?: ImplementPorts['budget'];
  readonly journal?: AttemptJournal;
  readonly tail?: string;
  readonly artifacts?: readonly string[];
  readonly text?: string;
}): Driver {
  const work = options.input ?? input();
  const generateIds: string[] = [];
  const tiers: ImplementTier[] = [];
  const prompts: string[] = [];
  const evalSites: string[] = [];
  const evalStates: unknown[] = [];
  const invokes: Driver['invokes'] = [];
  let generates = 0;
  let checks = 0;
  let evals = 0;
  const usedGrants = new WeakSet<object>();
  const live = { ...state };
  const found: Driver = {
    input: work, generateIds, tiers, prompts, evalSites, evalStates, invokes,
    journal: options.journal ?? new MemoryAttemptJournal(),
    ports: {
      now: () => 10,
      readState: () => ({ ...live }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      async generate(request: GenerationRequest): Promise<GenerationOutcome> {
        generates += 1;
        generateIds.push(request.request_id);
        tiers.push(request.terms.tier as ImplementTier);
        prompts.push(request.input.prompt);
        assert.equal(request.site, 'impl.generate');
        if (found.crashesAt === generates) throw new Error('simulated-crash');
        return {
          status: 'accepted', text: options.text ?? `change-${generates}`, request_id: request.request_id, site: request.site,
          routed_unit_id: `unit-${request.terms.tier}`, provider_response_id: 'gen-provider', attempts: [], spent: 0, uncertainty: [],
        };
      },
      evaluate: (async (request: EvaluationRequest<'boolean'>): Promise<EvaluationOutcome<'boolean'>> => {
        evals += 1;
        evalSites.push(request.site);
        evalStates.push(request.state);
        assert.equal(request.kind, 'boolean');
        assert.equal(request.terms.tier, 'decision');
        const script = options.evaluations?.[evals - 1] ?? { criterion_0: { p: 1, conf: 1 }, criterion_1: { p: 1, conf: 1 } };
        if (script === 'throw') throw new Error('CANARY_PROVIDER');
        if (script === 'stale') {
          live.state_revision = 2;
          live.state_updated_at = 11;
        }
        if (script === 'outage') {
          return { status: 'blocked', site: request.site, request_id: request.request_id, reason: 'provider_unavailable', attempts: [], spent: 0, uncertainty: [] };
        }
        if (script === 'stale') return booleanOutcome(request.site, request.request_id, { criterion_0: { p: 1, conf: 1 } });
        const scores: Record<string, { p: number; conf?: number | null }> = {};
        for (const [key, question] of Object.entries(request.questions)) {
          const criterionId = (question.instructions as { criterion_id?: string }).criterion_id ?? key;
          scores[key] = script[criterionId] ?? script[key] ?? { p: 1, conf: 1 };
        }
        const omit = Object.values(scores).some(score => score.conf === undefined);
        return booleanOutcome(request.site, request.request_id, scores, omit);
      }) as ImplementPorts['evaluate'],
      issueCheckGrant(held) {
        const known = work.checks.some(check => check.grant === held);
        if (!known) return null;
        return {
          action_id: held.action_id,
          operation: held.operation,
          contract_rev: held.contract_rev,
          permissions: held.permissions.map(effect => ({ resource: effect.resource, mode: effect.mode })),
          effects: held.effects.map(effect => ({ resource: effect.resource, mode: effect.mode })),
          issued_at: held.issued_at,
          ...(held.process_effects === undefined ? {} : { process_effects: [...held.process_effects] }),
        };
      },
      invoke(token, operation, inputs, invokeOptions) {
        checks += 1;
        invokes.push({
          grant: token, operation, inputs,
          ...(invokeOptions?.invocation_id === undefined ? {} : { invocation_id: invokeOptions.invocation_id }),
        });
        if (token === null || token.operation !== operation) return { kind: 'rejected', code: 'DENIED', reason: 'no grant' };
        if (usedGrants.has(token)) return { kind: 'rejected', code: 'DENIED', reason: 'grant has already been used for an invocation' };
        usedGrants.add(token);
        const exit = options.exits?.[checks - 1] ?? 0;
        return {
          kind: 'handle', action_id: token.action_id, invocation_id: invokeOptions?.invocation_id ?? token.action_id,
          implementation_id: 'fake', requestCancel() {},
          result: Promise.resolve({
            outcome: 'succeeded',
            output: {
              exit, stdout_tail: options.tail ?? 'ok', stdout_truncated: false, stderr_tail: '', duration_ms: 1,
              artifacts: options.artifacts ?? ['ref_1'],
            },
          }),
        };
      },
    },
  };
  return found;
}

test('a passing toy goal records evidence and does not complete the goal', async () => {
  const world = driver({
    text: 'CANARY_OUTPUT',
    artifacts: ['ref_1', 'sk-SECRETVALUE', '/tmp/leak'],
    tail: 'sk-SECRETVALUE',
    input: input({
      criteria: [{ criterion_id: 'c1', statement: 'CANARY_STATEMENT' }],
      checks: (['repo.test', 'repo.lint', 'repo.build'] as const).map(operation => ({
        operation, grant: operation === 'repo.test' ? grant : issued(operation), cwd_ref: 'workspace-1',
        env_allow: ['PUBLIC_NAME'], timeout_ms: 1000, argv: ['node', operation],
      })),
    }),
  });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.status, 'passed');
  assert.equal(result.goal_done, false);
  assert.equal(result.open_issue, null);
  assert.equal(result.execution_id, 'exec-1');
  assert.deepEqual(Object.keys(result), ['schema', 'execution_id', 'status', 'goal_done', 'reason', 'tier', 'ceiling',
    'effective_tier', 'escalated', 'attempts', 'artifact_refs', 'checks', 'evals', 'observations', 'open_issue', 'proofs']);
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(Object.keys(result.attempts[0]!), ['schema', 'id', 'parentId', 'execution_id', 'attempt',
    'requested_tier', 'effective_tier', 'escalated', 'status', 'generate_request_id', 'artifact_refs', 'checks',
    'evals', 'observations', 'failing_criterion_ids', 'failing_check_ids', 'pause', 'proofs']);
  assert.deepEqual(world.invokes.map(call => call.operation), ['repo.test', 'repo.lint', 'repo.build']);
  assert.equal(result.attempts[0]?.execution_id, 'exec-1');
  assert.equal(result.checks[0]?.passed, true);
  assert.equal(result.checks[0]?.exit, 0);
  assert.equal(result.checks[0]?.tail, '');
  assert.deepEqual(result.checks[0]?.artifacts, ['ref_1']);
  assert.match(result.artifact_refs[0] ?? '', /^gen_[a-f0-9]{32}$/);
  assert.equal(result.evals[0]?.passed, true);
  assert.notEqual(world.invokes[0]?.grant, grant);
  assert.deepEqual(grantScope(world.invokes[0]?.grant), grantScope(grant));
  assert.equal(world.ports.invoke(grant, 'repo.test', {}, { invocation_id: 'template-still-open' }).kind, 'handle');
  assert.deepEqual(world.invokes[0]?.inputs, { cwd_ref: 'workspace-1', env_allow: ['PUBLIC_NAME'], timeout_ms: 1000 });
  assert.equal(JSON.stringify(world.invokes[0]?.inputs).includes('argv'), false);
  const saved = JSON.stringify(world.journal.load('exec-1'));
  assert.equal(saved.includes('CANARY_OUTPUT'), false);
  assert.equal(saved.includes('CANARY_STATEMENT'), false);
  assert.equal(saved.includes('SECRETVALUE'), false);
  assert.equal(JSON.stringify(result).includes('CANARY_OUTPUT'), false);
  assert.equal(JSON.stringify(world.evalStates).includes('CANARY_OUTPUT'), true);
  assert.equal(JSON.stringify(world.evalStates).includes('CANARY_STATEMENT'), true);
  const again = await runImplementationStep(world.input, world.ports, world.journal);
  assert.deepEqual(again, result);
  assert.equal(world.generateIds.length, 1);
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), result);
});

test('implementation requests preserve the caller content class for generation and evaluation', async () => {
  for (const content_class of ['public', 'non_sensitive', 'sensitive', 'private', undefined] as const) {
    const world = driver({ input: input({ terms: { ...terms, ...(content_class === undefined ? {} : { content_class }) } }) });
    const seen: (InferenceTerms['content_class'])[] = [];
    const result = await runImplementationStep(world.input, {
      ...world.ports,
      generate: async request => { seen.push(request.terms.content_class); return world.ports.generate(request); },
      evaluate: (async request => { seen.push(request.terms.content_class); return world.ports.evaluate(request); }) as ImplementPorts['evaluate'],
    }, world.journal);
    assert.equal(result.status, 'passed');
    assert.deepEqual(seen, [content_class, content_class], 'classification must survive terms reconstruction without being upgraded');
  }
});

test('a D5 failure retries with a fresh grant and passes when the checks stay green', async () => {
  const world = driver({ evaluations: [{ c1: { p: .2, conf: .95 } }, { c1: { p: .95, conf: .95 } }] });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.status, 'passed');
  assert.equal(result.goal_done, false);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.status, 'failed');
  assert.deepEqual(result.attempts[0]?.failing_criterion_ids, ['c1']);
  assert.equal(result.attempts[0]?.checks[0]?.passed, true);
  assert.equal(result.attempts[0]?.checks[0]?.exit, 0);
  assert.equal(result.attempts[1]?.status, 'passed');
  assert.equal(result.attempts[1]?.checks[0]?.passed, true);
  assert.equal(result.attempts[1]?.checks[0]?.exit, 0);
  assert.equal(world.invokes.length, 2);
  assert.notEqual(world.invokes[0]?.grant, world.invokes[1]?.grant);
  assert.notEqual(world.invokes[0]?.grant, grant);
  assert.notEqual(world.invokes[1]?.grant, grant);
  assert.deepEqual(grantScope(world.invokes[0]?.grant), grantScope(grant));
  assert.deepEqual(grantScope(world.invokes[1]?.grant), grantScope(grant));
  const reused = world.ports.invoke(world.invokes[0]?.grant ?? null, 'repo.test', {}, { invocation_id: 'reuse' });
  assert.equal(reused.kind, 'rejected');
  if (reused.kind === 'rejected') assert.equal(reused.reason, 'grant has already been used for an invocation');
});

test('the equal issuer refuses a wider grant and the step does not invoke one', async () => {
  const authority = createGrantAuthority();
  const held = authority.issue({
    action_id: 'act-1', operation: 'repo.test', contract_rev: 'r1',
    permissions: [{ resource: 'workspace-1', mode: 'write' }],
    effects: [{ resource: 'workspace-1', mode: 'write' }],
    process_effects: ['process.spawn', 'fs.write:workspace-1'], issued_at: 1,
  });
  const issuer = createEqualGrantIssuer(authority, [held]);
  (held.permissions as { resource: string; mode: string }[]).push({ resource: 'ref_late', mode: 'read' });
  const first = issuer.issue(held);
  assert.ok(first);
  assert.notEqual(first, held);
  assert.deepEqual(first?.permissions, [{ resource: 'workspace-1', mode: 'write' }]);
  (first?.permissions as { resource: string; mode: string }[]).push({ resource: 'ref_extra', mode: 'write' });
  const second = issuer.issue(held);
  assert.deepEqual(second?.permissions, [{ resource: 'workspace-1', mode: 'write' }]);
  assert.notEqual(first, second);
  assert.equal(authority.markInvoked(first), true);
  assert.equal(authority.markInvoked(first), false);
  assert.ok(second);
  assert.equal(authority.markInvoked(second), true);
  assert.equal(issuer.issue(second), null);
  assert.equal(issuer.issue(structuredClone(held)), null);
  const wider = authority.issue({
    action_id: 'wider', operation: 'repo.test', contract_rev: 'r1',
    permissions: [{ resource: 'workspace-1', mode: 'write' }, { resource: 'ref_other', mode: 'write' }],
    effects: [{ resource: 'workspace-1', mode: 'write' }],
    process_effects: ['process.spawn', 'fs.write:workspace-1'], issued_at: 1,
  });
  assert.equal(issuer.issue(wider), null);
  assert.equal(issuer.issue({ schema: 'decision-site@1', answer: 'pass' } as unknown as Grant), null);
  authority.revoke(held);
  assert.equal(issuer.issue(held), null);

  const world = driver({ input: input({ ceiling: 'flash', retries: 0 }) });
  const ports: ImplementPorts = {
    ...world.ports,
    issueCheckGrant(template) {
      return {
        ...template,
        permissions: [...template.permissions, { resource: 'ref_extra', mode: 'write' }],
      };
    },
  };
  const denied = await runImplementationStep(world.input, ports, world.journal);
  assert.equal(world.invokes[0]?.grant, null);
  assert.equal(denied.checks[0]?.passed, false);
  assert.equal(denied.checks[0]?.exit, null);
  assert.equal(denied.goal_done, false);
});

test('a real host accepts a fresh grant when a green check is retried after D5 fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-grant-'));
  try {
    const authority = createGrantAuthority();
    let now = 1_000;
    const stub = fileURLToPath(new URL('../../../agentfabric/test/fixtures/stub-cli.mjs', import.meta.url));
    const argv = [process.execPath, stub, '--exit', '0'];
    const host = new AgentFabricHost({
      authority,
      shell: {
        env: { lookup: () => undefined },
        clock: { now: () => now },
        timer: {
          sleep(ms: number, signal?: AbortSignal) {
            return new Promise((resolve, reject) => {
              if (signal?.aborted) {
                reject(new Error('aborted'));
                return;
              }
              const handle = setTimeout(() => {
                now += ms;
                resolve();
              }, ms);
              signal?.addEventListener('abort', () => {
                clearTimeout(handle);
                reject(new Error('aborted'));
              }, { once: true });
            });
          },
        },
        repo: { test: argv, lint: argv, build: argv },
      },
    });
    const cwd = host.registerWorkspace(dir);
    const template = authority.issue({
      action_id: 'repo-test', operation: 'repo.test', contract_rev: 'r1',
      permissions: [{ resource: cwd, mode: 'write' }],
      effects: [{ resource: cwd, mode: 'write' }],
      process_effects: ['process.spawn', `fs.write:${cwd}`], issued_at: 1,
    });
    const issuer = createEqualGrantIssuer(authority, [template]);
    const world = driver({ evaluations: [{ c1: { p: .2, conf: .95 } }, { c1: { p: .95, conf: .95 } }] });
    const used: Grant[] = [];
    const ports: ImplementPorts = {
      ...world.ports,
      issueCheckGrant: held => issuer.issue(held),
      invoke(token, operation, inputs, invokeOptions) {
        if (token) used.push(token);
        const handle = host.invoke(token, operation, inputs, invokeOptions);
        if (handle.kind === 'handle') host.release(handle.action_id);
        return handle;
      },
    };
    const work = input({
      checks: [{
        operation: 'repo.test', grant: template, cwd_ref: cwd, env_allow: [], timeout_ms: 5_000, argv: ['node', 'stub'],
      }],
    });
    const result = await runImplementationStep(work, ports, world.journal);
    assert.equal(result.status, 'passed');
    assert.equal(result.goal_done, false);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.checks[0]?.exit, 0);
    assert.equal(result.attempts[0]?.checks[0]?.passed, true);
    assert.equal(result.attempts[0]?.status, 'failed');
    assert.equal(result.attempts[1]?.checks[0]?.exit, 0);
    assert.equal(result.attempts[1]?.checks[0]?.passed, true);
    assert.equal(used.length, 2);
    assert.notEqual(used[0], used[1]);
    assert.notEqual(used[0], template);
    assert.deepEqual(grantScope(used[0]), grantScope(template));
    assert.deepEqual(grantScope(used[1]), grantScope(template));
    assert.equal(authority.markInvoked(template), true);
    const reused = host.invoke(used[0] ?? null, 'repo.test', { cwd_ref: cwd, env_allow: [], timeout_ms: 5_000 }, { invocation_id: 'reuse' });
    assert.equal(reused.kind, 'rejected');
    if (reused.kind === 'rejected') assert.equal(reused.reason, 'grant has already been used for an invocation');
    assert.equal(JSON.stringify(result).includes(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const sameText of [false, true]) {
test(`restart cannot replay green durable checks against a new generation (same text: ${sameText})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-restart-'));
  let store: FabricStore | undefined;
  try {
    const storePath = join(dir, 'fabric.json');
    const journalPath = join(dir, 'attempts.jsonl');
    const stub = join(dir, 'check.mjs');
    writeFileSync(stub, "import { readFileSync, appendFileSync } from 'node:fs'; appendFileSync('runs', 'check\\n'); process.exit(Number(readFileSync('exit', 'utf8')));\n");
    const authority = createGrantAuthority();
    const argv = [process.execPath, stub];
    const openHost = () => {
      store = FabricStore.open(storePath);
      return new AgentFabricHost({ store, authority, shell: {
        env: { lookup: () => undefined }, clock: { now: () => 10 },
        timer: { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
        repo: { test: argv, lint: argv, build: argv },
      } });
    };
    let host = openHost();
    const cwd = host.registerWorkspace(dir);
    const template = authority.issue({
      action_id: 'repo-test', operation: 'repo.test', contract_rev: 'r1',
      permissions: [{ resource: cwd, mode: 'write' }], effects: [{ resource: cwd, mode: 'write' }],
      process_effects: ['process.spawn', `fs.write:${cwd}`], issued_at: 1,
    });
    const issuer = createEqualGrantIssuer(authority, [template]);
    const work = input({ ceiling: 'flash', retries: 0, checks: [{
      operation: 'repo.test', grant: template, cwd_ref: cwd, env_allow: [], timeout_ms: 5_000,
    }] });
    const world = driver({});
    let generations = 0;
    const ports: ImplementPorts = { ...world.ports,
      generate: async request => {
        generations += 1;
        writeFileSync(join(dir, 'exit'), generations === 1 ? '0' : '1');
        return { status: 'accepted', text: sameText ? 'same-text' : `change-${generations}`, request_id: request.request_id,
          site: request.site, routed_unit_id: 'fake', provider_response_id: 'fake',
          attempts: [], spent: 0, uncertainty: [] };
      },
      issueCheckGrant: held => issuer.issue(held),
      invoke: (token, operation, inputs, options) => {
        const committed = options?.invocation_id === undefined ? false
          : store!.getInvocation(options.invocation_id)?.status === 'committed';
        const handle = host.invoke(token, operation, inputs, options);
        if (handle.kind === 'handle' && !committed) host.release(handle.action_id);
        return handle;
      },
    };
    const journal = new FileAttemptJournal(journalPath);
    const crashJournal: AttemptJournal = {
      load: id => journal.load(id),
      append: () => { throw new Error('crash before attempt append'); },
    };
    await assert.rejects(runImplementationStep(work, ports, crashJournal));
    assert.equal(journal.load(work.execution_id).length, 0);
    assert.equal(store!.snapshot().invocations[0]?.status, 'committed');
    assert.equal(readFileSync(join(dir, 'runs'), 'utf8'), 'check\n');
    store!.close();
    host = openHost();
    const result = await runImplementationStep(work, ports, journal);
    assert.equal(generations, 2);
    assert.equal(result.status, 'failed');
    assert.equal(result.checks[0]?.exit, 1);
    assert.equal(result.checks[0]?.passed, false);
    assert.equal(result.evals[0]?.passed, true);
    assert.equal(result.execution_id, work.execution_id);
    assert.equal(result.attempts[0]?.attempt, 1);
    assert.equal(readFileSync(join(dir, 'runs'), 'utf8'), 'check\ncheck\n');
    const finished = await runImplementationStep(work, ports, journal);
    assert.deepEqual(finished, result);
    assert.equal(generations, 2);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

}

test('a failed criterion is retried once and can pass on the same tier and execution', async () => {
  const world = driver({ evaluations: [{ c1: { p: .2, conf: .95 } }, { c1: { p: .95, conf: .95 } }] });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.status, 'passed');
  assert.equal(result.goal_done, false);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.status, 'failed');
  assert.equal(result.attempts[1]?.parentId, result.attempts[0]?.id);
  assert.ok(world.prompts[1]?.includes('criterion_id=c1 passed=false'));
  assert.equal(world.prompts[1]?.includes('change-1'), false);
  assert.deepEqual(world.tiers, ['flash', 'flash']);
  assert.ok(result.attempts.every(attempt => attempt.execution_id === 'exec-1'));
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), result);
});

test('two retries then one tier escalation can pass, and a failed escalation raises the criterion ids', async () => {
  assert.equal(DEFAULT_IMPLEMENT_RETRIES, 2);
  const pass = driver({
    input: input({ criteria: [
      { criterion_id: 'c1', statement: 'first' },
      { criterion_id: 'c2', statement: 'second' },
    ] }),
    evaluations: [
      { c1: { p: 1, conf: 1 }, c2: { p: .2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: .2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: .2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: 1, conf: 1 } },
    ],
  });
  const passed = await runImplementationStep(pass.input, pass.ports, pass.journal);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.goal_done, false);
  assert.equal(passed.escalated, true);
  assert.deepEqual(pass.tiers, ['flash', 'flash', 'flash', 'standard']);
  assert.equal(passed.attempts[3]?.escalated, true);
  assert.equal(passed.attempts[3]?.effective_tier, 'standard');
  assert.equal(passed.open_issue, null);
  const fail = driver({
    input: pass.input,
    evaluations: [
      { c1: { p: 1, conf: 1 }, c2: { p: .2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: .2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: .2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: .1, conf: 1 } },
    ],
  });
  const failed = await runImplementationStep(fail.input, fail.ports, fail.journal);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.goal_done, false);
  assert.deepEqual(fail.tiers, ['flash', 'flash', 'flash', 'standard']);
  assert.equal(fail.generateIds.length, 4);
  assert.deepEqual(failed.open_issue?.criterion_ids, ['c2']);
  assert.deepEqual(failed.open_issue?.check_ids, []);
  assert.equal(failed.open_issue?.source, 'eval');
  assert.equal(failed.open_issue?.severity, 'blocker');
  assert.equal(failed.open_issue?.blocked_by, null);
  assert.equal(failed.open_issue?.execution_id, 'exec-1');
  assert.deepEqual(Object.keys(failed.open_issue!), ['schema', 'issue_id', 'execution_id', 'source', 'criterion_ids',
    'check_ids', 'text', 'severity', 'blocked_by']);
  assert.deepEqual(replayImplementationStep(fail.journal.load('exec-1'), fail.input), failed);
});

test('escalation blocked by the ceiling or the budget gate raises an open issue without another generate', async () => {
  const ceiling = driver({ input: input({ ceiling: 'flash' }), evaluations: [{ c1: { p: .1, conf: 1 } }, { c1: { p: .1, conf: 1 } }, { c1: { p: .1, conf: 1 } }] });
  const capped = await runImplementationStep(ceiling.input, ceiling.ports, ceiling.journal);
  assert.equal(capped.status, 'failed');
  assert.deepEqual(ceiling.tiers, ['flash', 'flash', 'flash']);
  assert.equal(capped.open_issue?.blocked_by, 'ceiling');
  assert.deepEqual(capped.open_issue?.criterion_ids, ['c1']);
  assert.equal(capped.goal_done, false);
  for (const budget of [
    () => ({ status: 'pause', reason: 'weekly_budget_cap', until: 80 } as ImplementBudgetDecision),
    () => ({ status: 'allow', tier: 'flash' } as ImplementBudgetDecision),
  ]) {
    let escalations = 0;
    const world = driver({
      evaluations: [{ c1: { p: .1, conf: 1 } }, { c1: { p: .1, conf: 1 } }, { c1: { p: .1, conf: 1 } }],
      budget: request => {
        if (!request.escalation) return { status: 'allow', tier: request.requested };
        escalations += 1;
        return budget();
      },
    });
    const result = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(escalations, 1);
    assert.deepEqual(world.tiers, ['flash', 'flash', 'flash']);
    assert.equal(result.open_issue?.blocked_by, 'budget');
    assert.deepEqual(result.open_issue?.criterion_ids, ['c1']);
    assert.equal(result.goal_done, false);
    assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), result);
  }
});

test('D5 uncertainty fails the step, and red checks fail it even when D5 passes', async () => {
  const cases = [
    { name: 'low confidence', evaluation: { c1: { p: .95, conf: .89 } } as const, reason: 'low_confidence' },
    { name: 'missing confidence', evaluation: { c1: { p: .95 } } as const, reason: 'missing_confidence' },
    { name: 'stale', evaluation: 'stale' as const, reason: 'stale_answer' },
    { name: 'outage', evaluation: 'throw' as const, reason: 'decision_unavailable' },
    { name: 'provider outage', evaluation: 'outage' as const, reason: 'decision_unavailable' },
  ];
  for (const item of cases) {
    const world = driver({
      input: input({ ceiling: 'flash', retries: 0 }),
      evaluations: [item.evaluation === 'stale' || item.evaluation === 'throw' || item.evaluation === 'outage'
        ? item.evaluation
        : item.evaluation],
    });
    const result = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(result.status, 'failed', item.name);
    assert.equal(result.goal_done, false, item.name);
    assert.equal(result.observations[0]?.reason, item.reason, item.name);
    assert.equal(result.evals[0]?.passed, false, item.name);
    assert.deepEqual(world.evalSites, ['eval.output'], item.name);
    assert.equal(JSON.stringify(result).includes('CANARY_PROVIDER'), false, item.name);
    assert.deepEqual(result.open_issue?.criterion_ids, ['c1'], item.name);
  }
  const red = driver({ input: input({ ceiling: 'flash', retries: 0 }), exits: [1], evaluations: [{ c1: { p: 1, conf: 1 } }] });
  const failed = await runImplementationStep(red.input, red.ports, red.journal);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.goal_done, false);
  assert.equal(failed.evals[0]?.passed, true);
  assert.equal(failed.checks[0]?.passed, false);
  assert.equal(failed.checks[0]?.exit, 1);
  assert.equal(failed.open_issue?.source, 'check');
  assert.deepEqual(failed.open_issue?.check_ids, ['repo.test']);
  assert.deepEqual(failed.open_issue?.criterion_ids, []);
  assert.equal(red.evalSites.length, 1);
});

test('a budget downgrade cannot raise the tier, and a missing grant is a failed check', async () => {
  const upgraded = driver({
    input: input({ ceiling: 'flash' }),
    budget: () => ({ status: 'allow', tier: 'strong' }),
  });
  const capped = await runImplementationStep(upgraded.input, upgraded.ports, upgraded.journal);
  assert.equal(capped.status, 'passed');
  assert.deepEqual(upgraded.tiers, ['flash']);
  assert.equal(capped.attempts[0]?.requested_tier, 'flash');
  assert.equal(capped.attempts[0]?.effective_tier, 'flash');
  const lowered = driver({
    input: input({ tier: 'standard', ceiling: 'strong' }),
    budget: () => ({ status: 'allow', tier: 'flash' }),
  });
  const downgraded = await runImplementationStep(lowered.input, lowered.ports, lowered.journal);
  assert.equal(downgraded.attempts[0]?.requested_tier, 'standard');
  assert.equal(downgraded.attempts[0]?.effective_tier, 'flash');
  assert.equal(downgraded.escalated, false);
  assert.deepEqual(lowered.tiers, ['flash']);
  const denied = driver({ input: input({ checks: [{ ...input().checks[0]!, grant: null }] }) });
  const result = await runImplementationStep(denied.input, denied.ports, denied.journal);
  assert.equal(result.checks[0]?.passed, false);
  assert.equal(result.status, 'failed');
  assert.equal(denied.invokes[0]?.grant, null);
});

test('resume after a crash repeats no finished attempt and keeps the execution id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-'));
  try {
    const path = join(dir, 'attempts.jsonl');
    const work = input();
    const first = driver({ journal: new FileAttemptJournal(path), evaluations: [{ c1: { p: .2, conf: 1 } }, { c1: { p: 1, conf: 1 } }] });
    first.crashesAt = 2;
    await assert.rejects(() => runImplementationStep(work, first.ports, first.journal), /simulated-crash/);
    const saved = new FileAttemptJournal(path).load('exec-1');
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.schema, 'impl.attempt@1');
    assert.equal(saved[0] && 'execution_id' in saved[0] ? saved[0].execution_id : '', 'exec-1');
    const second = driver({ journal: new FileAttemptJournal(path), evaluations: [{ c1: { p: 1, conf: 1 } }] });
    const result = await runImplementationStep(work, second.ports, second.journal);
    assert.deepEqual(second.generateIds, ['exec-1:a2:gen']);
    assert.equal(result.execution_id, 'exec-1');
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.id, 'exec-1:a1');
    assert.equal(result.attempts[1]?.parentId, 'exec-1:a1');
    assert.equal(result.attempts[1]?.execution_id, 'exec-1');
    assert.equal(result.status, 'passed');
    assert.equal(result.goal_done, false);
    const replay = replayImplementationStep(new FileAttemptJournal(path).load('exec-1'), work);
    assert.deepEqual(replay, result);
    const quiet = driver({ journal: second.journal });
    const quietPorts: ImplementPorts = {
      ...quiet.ports,
      generate: async () => { throw new Error('repeated'); },
      evaluate: async () => { throw new Error('repeated'); },
    };
    assert.deepEqual(await runImplementationStep(work, quietPorts, quiet.journal), result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn final line is repaired so later attempts stay loadable and resume does not repeat one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-tear-'));
  try {
    const path = join(dir, 'attempts.jsonl');
    const work = input();
    const first = driver({
      journal: new FileAttemptJournal(path),
      evaluations: [{ c1: { p: .2, conf: 1 } }],
    });
    first.crashesAt = 2;
    await assert.rejects(() => runImplementationStep(work, first.ports, first.journal), /simulated-crash/);
    const before = readFileSync(path, 'utf8');
    assert.equal(before.endsWith('\n'), true);
    assert.equal(before.trim().split('\n').length, 1);
    appendFileSync(path, '{"schema":"impl.att');
    const second = driver({
      journal: new FileAttemptJournal(path),
      evaluations: [{ c1: { p: .2, conf: 1 } }, { c1: { p: 1, conf: 1 } }],
    });
    const result = await runImplementationStep(work, second.ports, second.journal);
    assert.deepEqual(second.generateIds, ['exec-1:a2:gen', 'exec-1:a3:gen']);
    assert.equal(result.status, 'passed');
    assert.equal(result.goal_done, false);
    assert.deepEqual(result.attempts.map(attempt => attempt.id), ['exec-1:a1', 'exec-1:a2', 'exec-1:a3']);
    assert.equal(result.attempts[0]?.status, 'failed');
    assert.equal(result.attempts[1]?.status, 'failed');
    assert.equal(result.attempts[1]?.parentId, 'exec-1:a1');
    assert.equal(result.attempts[2]?.status, 'passed');
    assert.equal(result.attempts[2]?.parentId, 'exec-1:a2');
    const raw = readFileSync(path, 'utf8');
    assert.equal(raw.endsWith('\n'), true);
    const lines = raw.split('\n').filter(line => line.length > 0);
    assert.equal(lines.length, 3);
    for (const line of lines) JSON.parse(line);
    const loaded = new FileAttemptJournal(path).load('exec-1');
    assert.deepEqual(loaded.map(entry => entry.id), ['exec-1:a1', 'exec-1:a2', 'exec-1:a3']);
    const quiet = driver({ journal: new FileAttemptJournal(path) });
    const quietPorts: ImplementPorts = {
      ...quiet.ports,
      generate: async () => { throw new Error('repeated'); },
      evaluate: async () => { throw new Error('repeated'); },
    };
    assert.deepEqual(await runImplementationStep(work, quietPorts, quiet.journal), result);
    assert.equal(quiet.generateIds.length, 0);
    const onlyTorn = join(dir, 'only.jsonl');
    writeFileSync(onlyTorn, '{"schema":"impl.att');
    assert.deepEqual(new FileAttemptJournal(onlyTorn).load('exec-1'), []);
    assert.equal(readFileSync(onlyTorn, 'utf8'), '');
    const corrupt = join(dir, 'corrupt.jsonl');
    const kept = lines[0];
    assert.ok(kept);
    writeFileSync(corrupt, `${kept}\n{not-json}\n${kept}\n`);
    assert.throws(() => new FileAttemptJournal(corrupt).load('exec-1'), /impl\.attempt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished attempt missing its newline is kept when the next attempt is appended', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-nl-'));
  try {
    const path = join(dir, 'attempts.jsonl');
    const work = input();
    const first = driver({
      journal: new FileAttemptJournal(path),
      evaluations: [{ c1: { p: .2, conf: 1 } }],
    });
    first.crashesAt = 2;
    await assert.rejects(() => runImplementationStep(work, first.ports, first.journal), /simulated-crash/);
    const text = readFileSync(path, 'utf8');
    assert.equal(text.endsWith('\n'), true);
    writeFileSync(path, text.slice(0, -1));
    const second = driver({
      journal: new FileAttemptJournal(path),
      evaluations: [{ c1: { p: 1, conf: 1 } }],
    });
    const result = await runImplementationStep(work, second.ports, second.journal);
    assert.deepEqual(second.generateIds, ['exec-1:a2:gen']);
    assert.equal(result.status, 'passed');
    assert.equal(result.goal_done, false);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.id, 'exec-1:a1');
    assert.equal(result.attempts[1]?.parentId, 'exec-1:a1');
    const loaded = new FileAttemptJournal(path).load('exec-1');
    assert.deepEqual(loaded.map(entry => entry.id), ['exec-1:a1', 'exec-1:a2']);
    const raw = readFileSync(path, 'utf8');
    assert.equal(raw.endsWith('\n'), true);
    for (const line of raw.split('\n').filter(line => line.length > 0)) JSON.parse(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid execution id is rejected without being copied or dispatched', async () => {
  const world = driver({ input: input({ execution_id: 'sk-CANARYSECRETVALUE' }) });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.reason, 'invalid_input');
  assert.equal(result.goal_done, false);
  assert.equal(result.execution_id, null);
  assert.equal(world.generateIds.length, 0);
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
});

test('failed generation records no D5 observations for an evaluation never asked (#127)', async () => {
  const d = driver({ input: input({ retries: 0, ceiling: 'flash' }) });
  const result = await runImplementationStep(d.input, {
    ...d.ports,
    generate: async () => ({ status: 'blocked', reason: 'no_route', request_id: 'req-1', site: 'impl.step', uncertainty: [], attempts: [], spent: 0 }),
  }, d.journal);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.evals, []);
  assert.deepEqual(result.open_issue?.criterion_ids, ['c1']);
});

// Criterion proof (#199): D5 is asked only about criteria that need judgment.
const heldOutGrant = {
  ...grant, permissions: [...grant.permissions, { resource: 'heldout-1', mode: 'read' }],
} as Grant;
const heldOutCheck: ImplementCheck = {
  operation: 'repo.test', grant: heldOutGrant, cwd_ref: 'workspace-1', env_allow: ['PUBLIC_NAME'], timeout_ms: 1000,
  argv: ['node', 'heldout'], oracle_refs: ['heldout-1'],
};
const checkProven = { criterion_id: 'c1', statement: 'the held-out suite passes', proof: 'check' as const, check_ids: ['repo.test'] };
function proofInput(overrides: Partial<ImplementStepInput> = {}): ImplementStepInput {
  return input({ criteria: [checkProven], checks: [heldOutCheck], generation_writes: ['workspace-1'], ...overrides });
}
const identity = (ref: string): string => ref;

test('criterion proof: a step whose criteria are all check-proven sends no D5 request', async () => {
  const world = driver({ input: proofInput() });
  const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
  assert.equal(result.status, 'passed');
  assert.equal(result.goal_done, false);
  assert.deepEqual(world.evalSites, []);
  assert.deepEqual(result.evals, []);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.proofs, [{ criterion_id: 'c1', proposed: 'check', proof: 'check', reason: null }]);
  assert.deepEqual(result.attempts[0]?.proofs, result.proofs);
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), result);
});

test('criterion proof: a mixed step asks D5 only about the judgment criterion and discloses only it', async () => {
  const world = driver({ input: proofInput({ criteria: [checkProven, { criterion_id: 'c2', statement: 'CANARY_JUDGED' }] }) });
  const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
  assert.equal(result.status, 'passed');
  assert.deepEqual(world.evalSites, ['eval.output']);
  const disclosed = world.evalStates[0] as { criteria: { criterion_id: string; statement: string }[] };
  assert.deepEqual(disclosed.criteria, [{ criterion_id: 'c2', statement: 'CANARY_JUDGED' }]);
  assert.deepEqual(result.evals.map(item => item.criterion_id), ['c2']);
  assert.deepEqual(result.proofs.map(item => item.proof), ['check', 'judgment']);
});

test('criterion proof: tests in the workspace generation writes cannot prove a criterion, so D5 is asked', async () => {
  const workspaceOracle: ImplementCheck = {
    ...heldOutCheck, oracle_refs: ['workspace-1'],
    grant: { ...grant, permissions: [...grant.permissions, { resource: 'workspace-1', mode: 'read' }] } as Grant,
  };
  const world = driver({ input: proofInput({ checks: [workspaceOracle] }) });
  const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
  assert.deepEqual(world.evalSites, ['eval.output']);
  assert.deepEqual(result.proofs, [{ criterion_id: 'c1', proposed: 'check', proof: 'judgment', reason: 'oracle_writable' }]);
  assert.deepEqual(result.evals.map(item => item.criterion_id), ['c1']);
});

test('criterion proof: without host canonical identity or declared generation writes the criterion keeps D5', async () => {
  const noPort = driver({ input: proofInput() });
  const unported = await runImplementationStep(noPort.input, noPort.ports, noPort.journal);
  assert.deepEqual(noPort.evalSites, ['eval.output']);
  assert.equal(unported.proofs[0]?.reason, 'write_scope_unknown');
  const { generation_writes: _omitted, ...undeclared } = proofInput();
  const noWrites = driver({ input: undeclared });
  const unscoped = await runImplementationStep(noWrites.input, { ...noWrites.ports, canonical: identity }, noWrites.journal);
  assert.deepEqual(noWrites.evalSites, ['eval.output']);
  assert.equal(unscoped.proofs[0]?.reason, 'write_scope_unknown');
});

test('criterion proof: a red bound check fails the check-proven criterion from check evidence, not a D5 eval', async () => {
  const world = driver({ input: proofInput({ retries: 0, ceiling: 'flash' }), exits: [1] });
  const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
  assert.equal(result.status, 'failed');
  assert.deepEqual(world.evalSites, []);
  assert.deepEqual(result.evals, []);
  assert.deepEqual(result.attempts[0]?.failing_criterion_ids, ['c1']);
  assert.deepEqual(result.attempts[0]?.failing_check_ids, ['repo.test']);
  assert.equal(result.open_issue?.source, 'check');
  assert.deepEqual(result.open_issue?.criterion_ids, ['c1']);
});

test('criterion proof: malformed proof fields are invalid input', async () => {
  for (const bad of [
    { criteria: [{ ...checkProven, proof: 'maybe' as never }] },
    { criteria: [{ ...checkProven, check_ids: 'repo.test' as never }] },
    { checks: [{ ...heldOutCheck, oracle_refs: ['/abs/path'] }] },
    { generation_writes: ['workspace-1', 7 as never] },
  ] satisfies Partial<ImplementStepInput>[]) {
    const world = driver({ input: proofInput(bad) });
    const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
    assert.equal(result.reason, 'invalid_input');
    assert.equal(world.generateIds.length, 0);
  }
});

test('criterion proof: a journal written before #199 replays with no proofs and the same outcome', async () => {
  const world = driver({});
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  const legacy = world.journal.load('exec-1').map(entry => {
    if (entry.schema !== 'impl.attempt@1') return entry;
    const { proofs: _dropped, ...rest } = entry;
    return rest;
  });
  const replayed = replayImplementationStep(legacy, world.input);
  assert.deepEqual(replayed.proofs, []);
  assert.deepEqual({ ...replayed, proofs: result.proofs, attempts: result.attempts }, result);
});

test('criterion proof: a bound check id is green only when every run of it passed', async () => {
  const second: ImplementCheck = { ...heldOutCheck, grant: { ...heldOutGrant, action_id: 'act-2' } as Grant };
  const world = driver({ input: proofInput({ checks: [heldOutCheck, second], retries: 0, ceiling: 'flash' }), exits: [0, 1] });
  const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
  assert.equal(result.status, 'failed');
  assert.deepEqual(world.evalSites, []);
  assert.deepEqual(result.attempts[0]?.failing_criterion_ids, ['c1']);
});
