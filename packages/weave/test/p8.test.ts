import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGrantAuthority, type Grant } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, REPO_TEST } from '@weave/agentfabric';
import type {
  EvaluationOutcome,
  EvaluationRequest,
  GenerationOutcome,
  GenerationRequest,
  InferenceTerms,
} from '@weave/gateway';
import { DECLARED_TASK_POLICY } from '../src/task-acceptance.js';
import { transitionOutputEval, OUTPUT_EVAL_POLICY, OUTPUT_EVAL_QUESTION } from '../src/sites/output-eval.js';
import { correlation } from '../src/sites/index.js';
import { digest } from '../src/digest.js';
import {
  DEFAULT_IMPLEMENT_RETRIES,
  FileAttemptJournal,
  MemoryAttemptJournal,
  createEqualGrantIssuer,
  replayImplementationStep,
  runImplementationStep,
  type AttemptJournal,
  type ImplementBudgetDecision,
  type ImplementBudgetRequest,
  type ImplementCheck,
  type ImplementPorts,
  type ImplementStepInput,
  type ImplementTier,
  type JournalEntry,
} from '../src/implement-step.js';

const terms: InferenceTerms = {
  quality: 'baseline',
  destinations: ['local'],
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const grant = {
  action_id: 'act-1',
  operation: 'repo.test',
  contract_rev: 'r1',
  permissions: [{ resource: 'workspace-1', mode: 'write' }],
  effects: [{ resource: 'workspace-1', mode: 'write' }],
  process_effects: ['process.spawn', 'fs.write:workspace-1'],
  issued_at: 1,
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
    operation: 'repo.test',
    grant,
    cwd_ref: 'workspace-1',
    env_allow: ['PUBLIC_NAME'],
    timeout_ms: 1000,
    argv: ['node', 'stub'],
  };
  return {
    execution_id: 'exec-1',
    request_id: 'req-1',
    tier: 'flash',
    ceiling: 'strong',
    criteria: [{ criterion_id: 'c1', statement: 'the toy change meets the criterion' }],
    instructions: 'implement the toy goal',
    prompt: 'make the tests pass',
    kind: 'transform',
    terms,
    checks: [check],
    ...overrides,
  };
}
function booleanOutcome(
  site: string,
  requestId: string,
  scores: Record<string, { p: number; conf?: number | null }>,
  confidenceOmitted = false,
): EvaluationOutcome<'boolean'> {
  const confidence: Record<string, number> = {};
  let includeConfidence = !confidenceOmitted;
  for (const [key, score] of Object.entries(scores)) {
    if (score.conf === undefined) includeConfidence = false;
    else if (score.conf !== null) confidence[key] = score.conf;
  }
  return {
    status: 'accepted',
    kind: 'boolean',
    site,
    request_id: requestId,
    answers: Object.fromEntries(
      Object.entries(scores).map(([key, score]) => [key, { type: 'boolean' as const, probability: score.p }]),
    ),
    confidence: includeConfidence ? confidence : undefined,
    provider_response_id: 'provider-1',
    routed_unit_id: 'fixture',
    attempts: [],
    spent: 0,
    uncertainty: [],
  };
}
function recorded(scores: Record<string, { p: number; conf?: number | null }>, confidenceOmitted = false) {
  return {
    state_revision: 1,
    observed_at: 10,
    outcome: booleanOutcome('eval.output', 'r1', scores, confidenceOmitted),
  };
}
const d5Input = {
  ...state,
  request_id: 'r1',
  state: { note: 'CANARY_STATE' },
  needs_dispatch: false,
  terms,
  criteria: [
    { criterion_id: 'c1', statement: 'CANARY_STATEMENT' },
    { criterion_id: 'c2', statement: 'second' },
  ],
};

test('D5 passes only at p >= .8 and confidence >= .9, and keeps decision-site key order', () => {
  assert.equal(OUTPUT_EVAL_POLICY.confidence, DECLARED_TASK_POLICY.confidence_floor);
  assert.equal(OUTPUT_EVAL_POLICY.probability, DECLARED_TASK_POLICY.probability_threshold);
  const pass = transitionOutputEval(
    d5Input,
    recorded({ criterion_0: { p: 0.8, conf: 0.9 }, criterion_1: { p: 0.95, conf: 1 } }),
    state,
  );
  assert.equal(pass.status, 'pass');
  assert.deepEqual(pass.failing_criterion_ids, []);
  assert.equal(pass.observations[0]?.answer, 'pass');
  assert.deepEqual(Object.keys(pass.observations[0]!), [
    'schema',
    'site',
    'question',
    'request_id',
    'state_revision',
    'answer',
    'confidence',
    'top_p',
    'accepted',
    'fallback_used',
    'reason',
    'provider_request_id',
  ]);
  assert.equal(pass.observations[0]?.question, OUTPUT_EVAL_QUESTION);
  assert.equal(pass.observations[0]?.provider_request_id, 'provider-1');
  assert.ok(!JSON.stringify(pass).includes('CANARY'));
  const lowP = transitionOutputEval(
    d5Input,
    recorded({ criterion_0: { p: 0.799, conf: 1 }, criterion_1: { p: 1, conf: 1 } }),
    state,
  );
  assert.equal(lowP.status, 'fail');
  assert.deepEqual(lowP.failing_criterion_ids, ['c1']);
  assert.equal(lowP.observations[0]?.reason, 'below_probability');
  assert.equal(lowP.observations[0]?.answer, 'fail');
  assert.equal(lowP.evals[1]?.passed, true);
});

test('D5 low confidence, missing confidence, stale, unparseable and outage each fail that criterion', () => {
  const low = transitionOutputEval(
    d5Input,
    recorded({ criterion_0: { p: 0.95, conf: 0.899 }, criterion_1: { p: 1, conf: 1 } }),
    state,
  );
  assert.equal(low.observations[0]?.reason, 'low_confidence');
  assert.equal(low.evals[0]?.passed, false);
  assert.equal(low.observations[0]?.answer, null);
  const missing = transitionOutputEval(
    d5Input,
    recorded({ criterion_0: { p: 0.95 }, criterion_1: { p: 1, conf: 1 } }, true),
    state,
  );
  assert.equal(missing.observations[0]?.reason, 'missing_confidence');
  assert.equal(missing.evals[0]?.passed, false);
  const stale = transitionOutputEval(
    d5Input,
    { ...recorded({ criterion_0: { p: 1, conf: 1 }, criterion_1: { p: 1, conf: 1 } }), observed_at: 9 },
    state,
  );
  assert.equal(stale.status, 'fail');
  assert.ok(stale.observations.every((item) => item.reason === 'stale_answer' && item.fallback_used && !item.accepted));
  const good = recorded({ criterion_0: { p: 1, conf: 1 }, criterion_1: { p: 1, conf: 1 } });
  assert.equal(good.outcome.status, 'accepted');
  const malformed =
    good.outcome.status === 'accepted'
      ? {
          ...good,
          outcome: {
            ...good.outcome,
            answers: { ...good.outcome.answers, criterion_0: { type: 'boolean' as const, probability: Number.NaN } },
          },
        }
      : good;
  assert.equal(transitionOutputEval(d5Input, malformed, state).observations[0]?.reason, 'invalid_answer');
  const outage = transitionOutputEval(d5Input, { state_revision: 1, observed_at: 10, outcome: null }, state);
  assert.equal(outage.status, 'fail');
  assert.ok(outage.observations.every((item) => item.reason === 'decision_unavailable' && item.fallback_used));
  assert.deepEqual(outage.failing_criterion_ids, ['c1', 'c2']);
  assert.deepEqual(
    outage,
    transitionOutputEval(
      d5Input,
      JSON.parse(JSON.stringify({ state_revision: 1, observed_at: 10, outcome: null })),
      state,
    ),
  );
});

test('D5 does not accept an answer from another semantic operation', () => {
  const foreign = booleanOutcome('guard.output', 'r1', {
    criterion_0: { p: 1, conf: 1 },
    criterion_1: { p: 1, conf: 1 },
  });
  const result = transitionOutputEval(d5Input, { state_revision: 1, observed_at: 10, outcome: foreign }, state);
  assert.equal(result.status, 'fail');
  assert.ok(result.observations.every((item) => item.reason === 'mismatched_answer'));
  assert.ok(result.evals.every((item) => !item.passed));
  const replay = transitionOutputEval(
    d5Input,
    JSON.parse(
      JSON.stringify(
        recorded({
          criterion_0: { p: 0.8, conf: 0.9 },
          criterion_1: { p: 1, conf: 1 },
          CANARY_UNKNOWN: { p: 1, conf: 1 },
        }),
      ),
    ),
    state,
  );
  assert.equal(replay.status, 'pass');
  assert.equal(replay.observations.at(-1)?.reason, 'unknown_answer');
  assert.ok(!JSON.stringify(replay).includes('CANARY'));
});

interface Driver {
  readonly input: ImplementStepInput;
  readonly ports: ImplementPorts;
  readonly journal: AttemptJournal;
  readonly generateIds: string[];
  readonly evalIds: string[];
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
  readonly evaluations?: readonly (
    | Record<string, { p: number; conf?: number | null }>
    | 'outage'
    | 'throw'
    | 'stale'
  )[];
  readonly budget?: ImplementPorts['budget'];
  readonly journal?: AttemptJournal;
  readonly tail?: string;
  readonly artifacts?: readonly string[];
  readonly text?: string;
}): Driver {
  const work = options.input ?? input();
  const generateIds: string[] = [];
  const evalIds: string[] = [];
  const tiers: ImplementTier[] = [];
  const prompts: string[] = [];
  const evalSites: string[] = [];
  const evalStates: unknown[] = [];
  const invokes: Driver['invokes'] = [];
  let generates = 0;
  let runs = 0;
  let checks = 0;
  let evals = 0;
  const usedGrants = new WeakSet<object>();
  const live = { ...state };
  const found: Driver = {
    input: work,
    generateIds,
    evalIds,
    tiers,
    prompts,
    evalSites,
    evalStates,
    invokes,
    journal: options.journal ?? new MemoryAttemptJournal(),
    ports: {
      now: () => 10,
      runId: () => `run-${++runs}`,
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
          status: 'accepted',
          text: options.text ?? `change-${generates}`,
          request_id: request.request_id,
          site: request.site,
          routed_unit_id: `unit-${request.terms.tier}`,
          provider_response_id: 'gen-provider',
          attempts: [],
          spent: 0,
          uncertainty: [],
        };
      },
      evaluate: (async (request: EvaluationRequest<'boolean'>): Promise<EvaluationOutcome<'boolean'>> => {
        evals += 1;
        evalSites.push(request.site);
        evalIds.push(request.request_id);
        evalStates.push(request.state);
        assert.equal(request.kind, 'boolean');
        assert.equal(request.terms.tier, 'decision');
        const script = options.evaluations?.[evals - 1] ?? {
          criterion_0: { p: 1, conf: 1 },
          criterion_1: { p: 1, conf: 1 },
        };
        if (script === 'throw') throw new Error('CANARY_PROVIDER');
        if (script === 'stale') {
          live.state_revision = 2;
          live.state_updated_at = 11;
        }
        if (script === 'outage') {
          return {
            status: 'blocked',
            site: request.site,
            request_id: request.request_id,
            reason: 'provider_unavailable',
            attempts: [],
            spent: 0,
            uncertainty: [],
          };
        }
        if (script === 'stale')
          return booleanOutcome(request.site, request.request_id, { criterion_0: { p: 1, conf: 1 } });
        const scores: Record<string, { p: number; conf?: number | null }> = {};
        for (const [key, question] of Object.entries(request.questions)) {
          const criterionId = (question.instructions as { criterion_id?: string }).criterion_id ?? key;
          scores[key] = script[criterionId] ?? script[key] ?? { p: 1, conf: 1 };
        }
        const omit = Object.values(scores).some((score) => score.conf === undefined);
        return booleanOutcome(request.site, request.request_id, scores, omit);
      }) as ImplementPorts['evaluate'],
      issueCheckGrant(held) {
        const known = work.checks.some((check) => check.grant === held);
        if (!known) return null;
        return {
          action_id: held.action_id,
          operation: held.operation,
          contract_rev: held.contract_rev,
          permissions: held.permissions.map((effect) => ({ resource: effect.resource, mode: effect.mode })),
          effects: held.effects.map((effect) => ({ resource: effect.resource, mode: effect.mode })),
          issued_at: held.issued_at,
          ...(held.process_effects === undefined ? {} : { process_effects: [...held.process_effects] }),
        };
      },
      invoke(token, operation, inputs, invokeOptions) {
        checks += 1;
        invokes.push({
          grant: token,
          operation,
          inputs,
          ...(invokeOptions?.invocation_id === undefined ? {} : { invocation_id: invokeOptions.invocation_id }),
        });
        if (token === null || token.operation !== operation)
          return { kind: 'rejected', code: 'DENIED', reason: 'no grant' };
        if (usedGrants.has(token))
          return { kind: 'rejected', code: 'DENIED', reason: 'grant has already been used for an invocation' };
        usedGrants.add(token);
        const exit = options.exits?.[checks - 1] ?? 0;
        return {
          kind: 'handle',
          action_id: token.action_id,
          invocation_id: invokeOptions?.invocation_id ?? token.action_id,
          implementation_id: 'fake',
          requestCancel() {},
          result: Promise.resolve({
            outcome: 'succeeded',
            output: {
              exit,
              stdout_tail: options.tail ?? 'ok',
              stdout_truncated: false,
              stderr_tail: '',
              duration_ms: 1,
              artifacts: options.artifacts ?? ['ref_1'],
            },
          }),
        };
      },
    },
  };
  return found;
}

// #244: the check-tail screen uses the repository's shared credential markers (#158).
test('a check tail carrying any shared credential marker is dropped; an ordinary tail is kept', async () => {
  for (const tail of [
    'Authorization: Bearer\tabc123',
    'Authorization: Bearer\nabc123',
    'key=AIzaSyA1234567890',
    'token xoxb-123-456',
    '-----BEGIN RSA PRIVATE KEY-----',
    'export OPENAI=sk-SECRETVALUE',
  ]) {
    const world = driver({ tail });
    const result = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(result.checks[0]?.tail, '', JSON.stringify(tail));
    assert.equal(JSON.stringify(world.journal.load('exec-1')).includes(tail.slice(-6)), false, JSON.stringify(tail));
  }
  for (const tail of ['12 tests passed', 'bearer_token_id rotated']) {
    const world = driver({ tail });
    const result = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(result.checks[0]?.tail, tail);
  }
});

test('a passing toy goal records evidence and does not complete the goal', async () => {
  const world = driver({
    text: 'CANARY_OUTPUT',
    artifacts: ['ref_1', 'sk-SECRETVALUE', '/tmp/leak'],
    tail: 'sk-SECRETVALUE',
    input: input({
      criteria: [{ criterion_id: 'c1', statement: 'CANARY_STATEMENT' }],
      checks: (['repo.test', 'repo.lint', 'repo.build'] as const).map((operation) => ({
        operation,
        grant: operation === 'repo.test' ? grant : issued(operation),
        cwd_ref: 'workspace-1',
        env_allow: ['PUBLIC_NAME'],
        timeout_ms: 1000,
        argv: ['node', operation],
      })),
    }),
  });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.status, 'passed');
  assert.equal(result.goal_done, false);
  assert.equal(result.open_issue, null);
  assert.equal(result.execution_id, 'exec-1');
  assert.deepEqual(Object.keys(result), [
    'schema',
    'execution_id',
    'status',
    'goal_done',
    'reason',
    'tier',
    'ceiling',
    'effective_tier',
    'escalated',
    'attempts',
    'artifact_refs',
    'checks',
    'evals',
    'observations',
    'open_issue',
    'proofs',
  ]);
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(Object.keys(result.attempts[0]!), [
    'schema',
    'id',
    'parentId',
    'execution_id',
    'attempt',
    'requested_tier',
    'effective_tier',
    'escalated',
    'status',
    'generate_request_id',
    'artifact_refs',
    'checks',
    'evals',
    'observations',
    'failing_criterion_ids',
    'failing_check_ids',
    'pause',
    'proofs',
  ]);
  assert.deepEqual(
    world.invokes.map((call) => call.operation),
    ['repo.test', 'repo.lint', 'repo.build'],
  );
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
    const world = driver({
      input: input({ terms: { ...terms, ...(content_class === undefined ? {} : { content_class }) } }),
    });
    const seen: InferenceTerms['content_class'][] = [];
    const result = await runImplementationStep(
      world.input,
      {
        ...world.ports,
        generate: async (request) => {
          seen.push(request.terms.content_class);
          return world.ports.generate(request);
        },
        evaluate: (async (request) => {
          seen.push(request.terms.content_class);
          return world.ports.evaluate(request);
        }) as ImplementPorts['evaluate'],
      },
      world.journal,
    );
    assert.equal(result.status, 'passed');
    assert.deepEqual(
      seen,
      [content_class, content_class],
      'classification must survive terms reconstruction without being upgraded',
    );
  }
});

for (const storage of ['memory', 'file'] as const) {
  test(`a D5 failure retries with a fresh grant and passes when the checks stay green (${storage})`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-p8-grants-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const journal =
      storage === 'file' ? new FileAttemptJournal(join(dir, 'attempts.jsonl')) : new MemoryAttemptJournal();
    const world = driver({ journal, evaluations: [{ c1: { p: 0.2, conf: 0.95 } }, { c1: { p: 0.95, conf: 0.95 } }] });
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
}

test('the equal issuer refuses a wider grant and the step does not invoke one', async () => {
  const authority = createGrantAuthority();
  const held = authority.issue({
    action_id: 'act-1',
    operation: 'repo.test',
    contract_rev: 'r1',
    permissions: [{ resource: 'workspace-1', mode: 'write' }],
    effects: [{ resource: 'workspace-1', mode: 'write' }],
    process_effects: ['process.spawn', 'fs.write:workspace-1'],
    issued_at: 1,
  });
  const issuer = createEqualGrantIssuer(authority, [held], {});
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
    action_id: 'wider',
    operation: 'repo.test',
    contract_rev: 'r1',
    permissions: [
      { resource: 'workspace-1', mode: 'write' },
      { resource: 'ref_other', mode: 'write' },
    ],
    effects: [{ resource: 'workspace-1', mode: 'write' }],
    process_effects: ['process.spawn', 'fs.write:workspace-1'],
    issued_at: 1,
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
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(handle);
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            });
          },
        },
        repo: { test: argv, lint: argv, build: argv },
      },
    });
    const cwd = host.registerWorkspace(dir);
    const template = authority.issue({
      action_id: 'repo-test',
      operation: 'repo.test',
      contract_rev: REPO_TEST.revision,
      permissions: [{ resource: cwd, mode: 'write' }],
      effects: [{ resource: cwd, mode: 'write' }],
      process_effects: ['process.spawn', `fs.write:${cwd}`],
      issued_at: 1,
    });
    const issuer = createEqualGrantIssuer(authority, [template], {});
    const world = driver({ evaluations: [{ c1: { p: 0.2, conf: 0.95 } }, { c1: { p: 0.95, conf: 0.95 } }] });
    const used: Grant[] = [];
    const ports: ImplementPorts = {
      ...world.ports,
      issueCheckGrant: (held) => issuer.issue(held),
      invoke(token, operation, inputs, invokeOptions) {
        if (token) used.push(token);
        const handle = host.invoke(token, operation, inputs, invokeOptions);
        if (handle.kind === 'handle') host.release(handle.action_id);
        return handle;
      },
    };
    const work = input({
      checks: [
        {
          operation: 'repo.test',
          grant: template,
          cwd_ref: cwd,
          env_allow: [],
          timeout_ms: 5_000,
          argv: ['node', 'stub'],
        },
      ],
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
    // Equal scope; each fresh grant has its own action id (#125).
    assert.deepEqual({ ...grantScope(used[0]), action_id: null }, { ...grantScope(template), action_id: null });
    assert.deepEqual({ ...grantScope(used[1]), action_id: null }, { ...grantScope(template), action_id: null });
    assert.equal(new Set([template.action_id, used[0]?.action_id, used[1]?.action_id]).size, 3);
    assert.equal(authority.markInvoked(template), true);
    const reused = host.invoke(
      used[0] ?? null,
      'repo.test',
      { cwd_ref: cwd, env_allow: [], timeout_ms: 5_000 },
      { invocation_id: 'reuse' },
    );
    assert.equal(reused.kind, 'rejected');
    if (reused.kind === 'rejected') assert.equal(reused.reason, 'grant has already been used for an invocation');
    assert.equal(JSON.stringify(result).includes(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [sameText, repeatedRunId] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  test(`restart cannot replay green durable checks against a new generation (same text: ${sameText}, repeated run id: ${repeatedRunId})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-p8-restart-'));
    let store: FabricStore | undefined;
    try {
      const storePath = join(dir, 'fabric.json');
      const journalPath = join(dir, 'attempts.jsonl');
      const stub = join(dir, 'check.mjs');
      writeFileSync(
        stub,
        "import { readFileSync, appendFileSync } from 'node:fs'; appendFileSync('runs', 'check\\n'); process.exit(Number(readFileSync('exit', 'utf8')));\n",
      );
      const authority = createGrantAuthority();
      const argv = [process.execPath, stub];
      const openHost = () => {
        store = FabricStore.open(storePath);
        return new AgentFabricHost({
          store,
          authority,
          shell: {
            env: { lookup: () => undefined },
            clock: { now: () => 10 },
            timer: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
            repo: { test: argv, lint: argv, build: argv },
          },
        });
      };
      let host = openHost();
      const cwd = host.registerWorkspace(dir);
      const template = authority.issue({
        action_id: 'repo-test',
        operation: 'repo.test',
        contract_rev: REPO_TEST.revision,
        permissions: [{ resource: cwd, mode: 'write' }],
        effects: [{ resource: cwd, mode: 'write' }],
        process_effects: ['process.spawn', `fs.write:${cwd}`],
        issued_at: 1,
      });
      let issuer = createEqualGrantIssuer(authority, [template], { retries: 0 });
      const work = input({
        ceiling: 'flash',
        retries: 0,
        checks: [
          {
            operation: 'repo.test',
            grant: template,
            cwd_ref: cwd,
            env_allow: [],
            timeout_ms: 5_000,
          },
        ],
      });
      const world = driver({});
      let generations = 0;
      const ports: ImplementPorts = {
        ...world.ports,
        ...(repeatedRunId ? { runId: () => 'repeated' } : {}),
        generate: async (request) => {
          generations += 1;
          writeFileSync(join(dir, 'exit'), generations === 1 ? '0' : '1');
          return {
            status: 'accepted',
            text: sameText ? 'same-text' : `change-${generations}`,
            request_id: request.request_id,
            site: request.site,
            routed_unit_id: 'fake',
            provider_response_id: 'fake',
            attempts: [],
            spent: 0,
            uncertainty: [],
          };
        },
        issueCheckGrant: (held) => issuer.issue(held),
        invoke: (token, operation, inputs, options) => {
          const committed =
            options?.invocation_id === undefined
              ? false
              : store!.getInvocation(options.invocation_id)?.status === 'committed';
          const handle = host.invoke(token, operation, inputs, options);
          if (repeatedRunId && generations === 1 && handle.kind === 'handle' && token) {
            const duplicate = authority.issue({ ...token });
            const rejected = host.invoke(duplicate, operation, inputs, options);
            assert.equal(rejected.kind, 'rejected', 'an active check identity cannot be replayed');
            if (rejected.kind === 'rejected') assert.match(rejected.reason, /already exists/);
          }
          if (handle.kind === 'handle' && !committed) host.release(handle.action_id);
          return handle;
        },
      };
      const journal = new FileAttemptJournal(journalPath);
      const crashJournal: AttemptJournal = {
        load: (id) => journal.load(id),
        append: () => {
          throw new Error('crash before attempt append');
        },
      };
      await assert.rejects(runImplementationStep(work, ports, crashJournal));
      assert.equal(journal.load(work.execution_id).length, 0);
      assert.equal(store!.snapshot().invocations[0]?.status, 'committed');
      assert.equal(readFileSync(join(dir, 'runs'), 'utf8'), 'check\n');
      store!.close();
      host = openHost();
      issuer = createEqualGrantIssuer(authority, [template], { retries: 0 });
      const result = await runImplementationStep(work, ports, journal);
      assert.equal(generations, 2);
      assert.equal(result.status, 'failed');
      assert.equal(result.checks[0]?.exit, repeatedRunId ? null : 1);
      assert.equal(result.checks[0]?.passed, false);
      assert.deepEqual(result.evals, []);
      assert.equal(result.attempts[0]?.eval_skipped, 'check_failed');
      assert.equal(result.execution_id, work.execution_id);
      assert.equal(result.attempts[0]?.attempt, 1);
      assert.equal(readFileSync(join(dir, 'runs'), 'utf8'), repeatedRunId ? 'check\n' : 'check\ncheck\n');
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
  const world = driver({ evaluations: [{ c1: { p: 0.2, conf: 0.95 } }, { c1: { p: 0.95, conf: 0.95 } }] });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.status, 'passed');
  assert.equal(result.goal_done, false);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.status, 'failed');
  assert.equal(result.attempts[1]?.parentId, result.attempts[0]?.id);
  assert.ok(world.prompts[1]?.includes('criterion_id=c1 passed=false'));
  assert.equal(world.prompts[1]?.includes('change-1'), false);
  assert.deepEqual(world.tiers, ['flash', 'flash']);
  assert.ok(result.attempts.every((attempt) => attempt.execution_id === 'exec-1'));
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), result);
});

test('two retries then one tier escalation can pass, and a failed escalation raises the criterion ids', async () => {
  assert.equal(DEFAULT_IMPLEMENT_RETRIES, 2);
  const pass = driver({
    input: input({
      criteria: [
        { criterion_id: 'c1', statement: 'first' },
        { criterion_id: 'c2', statement: 'second' },
      ],
    }),
    evaluations: [
      { c1: { p: 1, conf: 1 }, c2: { p: 0.2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: 0.2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: 0.2, conf: 1 } },
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
      { c1: { p: 1, conf: 1 }, c2: { p: 0.2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: 0.2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: 0.2, conf: 1 } },
      { c1: { p: 1, conf: 1 }, c2: { p: 0.1, conf: 1 } },
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
  assert.deepEqual(Object.keys(failed.open_issue!), [
    'schema',
    'issue_id',
    'execution_id',
    'source',
    'criterion_ids',
    'check_ids',
    'text',
    'severity',
    'blocked_by',
  ]);
  assert.deepEqual(replayImplementationStep(fail.journal.load('exec-1'), fail.input), failed);
});

test('escalation blocked by the ceiling or a budget downgrade raises an open issue without another generate', async () => {
  const ceiling = driver({
    input: input({ ceiling: 'flash' }),
    evaluations: [{ c1: { p: 0.1, conf: 1 } }, { c1: { p: 0.1, conf: 1 } }, { c1: { p: 0.1, conf: 1 } }],
  });
  const capped = await runImplementationStep(ceiling.input, ceiling.ports, ceiling.journal);
  assert.equal(capped.status, 'failed');
  assert.deepEqual(ceiling.tiers, ['flash', 'flash', 'flash']);
  assert.equal(capped.open_issue?.blocked_by, 'ceiling');
  assert.deepEqual(capped.open_issue?.criterion_ids, ['c1']);
  assert.equal(capped.goal_done, false);
  // A pause at escalation is resumable instead (#128); a downgrade cannot be that tier.
  for (const budget of [() => ({ status: 'allow', tier: 'flash' }) as ImplementBudgetDecision]) {
    let escalations = 0;
    const world = driver({
      evaluations: [{ c1: { p: 0.1, conf: 1 } }, { c1: { p: 0.1, conf: 1 } }, { c1: { p: 0.1, conf: 1 } }],
      budget: (request) => {
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

test('D5 uncertainty fails the step, and red checks fail it without asking D5', async () => {
  // An outage pauses instead (#129); see the outage test below.
  const cases = [
    { name: 'low confidence', evaluation: { c1: { p: 0.95, conf: 0.89 } } as const, reason: 'low_confidence' },
    { name: 'missing confidence', evaluation: { c1: { p: 0.95 } } as const, reason: 'missing_confidence' },
    { name: 'stale', evaluation: 'stale' as const, reason: 'stale_answer' },
  ];
  for (const item of cases) {
    const world = driver({
      input: input({ ceiling: 'flash', retries: 0 }),
      evaluations: [item.evaluation],
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
  const red = driver({
    input: input({ ceiling: 'flash', retries: 0 }),
    exits: [1],
    evaluations: [{ c1: { p: 1, conf: 1 } }],
  });
  const failed = await runImplementationStep(red.input, red.ports, red.journal);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.goal_done, false);
  assert.deepEqual(failed.evals, []);
  assert.equal(failed.checks[0]?.passed, false);
  assert.equal(failed.checks[0]?.exit, 1);
  assert.equal(failed.open_issue?.source, 'check');
  assert.deepEqual(failed.open_issue?.check_ids, ['repo.test']);
  assert.deepEqual(failed.open_issue?.criterion_ids, []);
  assert.equal(red.evalSites.length, 0);
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
    const first = driver({
      journal: new FileAttemptJournal(path),
      evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }],
    });
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
      generate: async () => {
        throw new Error('repeated');
      },
      evaluate: async () => {
        throw new Error('repeated');
      },
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
      evaluations: [{ c1: { p: 0.2, conf: 1 } }],
    });
    first.crashesAt = 2;
    await assert.rejects(() => runImplementationStep(work, first.ports, first.journal), /simulated-crash/);
    const before = readFileSync(path, 'utf8');
    assert.equal(before.endsWith('\n'), true);
    assert.equal(before.trim().split('\n').length, 1);
    appendFileSync(path, '{"schema":"impl.att');
    const second = driver({
      journal: new FileAttemptJournal(path),
      evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }],
    });
    const result = await runImplementationStep(work, second.ports, second.journal);
    assert.deepEqual(second.generateIds, ['exec-1:a2:gen', 'exec-1:a3:gen']);
    assert.equal(result.status, 'passed');
    assert.equal(result.goal_done, false);
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.id),
      ['exec-1:a1', 'exec-1:a2', 'exec-1:a3'],
    );
    assert.equal(result.attempts[0]?.status, 'failed');
    assert.equal(result.attempts[1]?.status, 'failed');
    assert.equal(result.attempts[1]?.parentId, 'exec-1:a1');
    assert.equal(result.attempts[2]?.status, 'passed');
    assert.equal(result.attempts[2]?.parentId, 'exec-1:a2');
    const raw = readFileSync(path, 'utf8');
    assert.equal(raw.endsWith('\n'), true);
    const lines = raw.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 3);
    for (const line of lines) JSON.parse(line);
    const loaded = new FileAttemptJournal(path).load('exec-1');
    assert.deepEqual(
      loaded.map((entry) => entry.id),
      ['exec-1:a1', 'exec-1:a2', 'exec-1:a3'],
    );
    const quiet = driver({ journal: new FileAttemptJournal(path) });
    const quietPorts: ImplementPorts = {
      ...quiet.ports,
      generate: async () => {
        throw new Error('repeated');
      },
      evaluate: async () => {
        throw new Error('repeated');
      },
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
      evaluations: [{ c1: { p: 0.2, conf: 1 } }],
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
    assert.deepEqual(
      loaded.map((entry) => entry.id),
      ['exec-1:a1', 'exec-1:a2'],
    );
    const raw = readFileSync(path, 'utf8');
    assert.equal(raw.endsWith('\n'), true);
    for (const line of raw.split('\n').filter((line) => line.length > 0)) JSON.parse(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('step-built ids stay bounded, unique and deterministic for long execution ids', async () => {
  const run = async (execution_id: string) => {
    const world = driver({
      input: input({ execution_id, retries: 1 }),
      evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }],
    });
    const result = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(result.status, 'passed');
    assert.equal(result.attempts.length, 2);
    const ids = [...world.generateIds, ...world.evalIds, ...result.attempts.map((attempt) => attempt.id)];
    for (const id of ids) {
      assert.equal(correlation(id), id, 'step id must be a valid correlation');
      assert.ok(id.length <= 128, 'step id must be bounded');
    }
    assert.equal(new Set(world.generateIds).size, 2);
    assert.equal(new Set(world.evalIds).size, 2);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(world.generateIds.every((id) => id.endsWith(':gen')));
    assert.ok(world.evalIds.every((id) => id.endsWith(':eval')));
    assert.equal(result.observations[0]?.request_id, world.evalIds[1]);
    assert.deepEqual(replayImplementationStep(world.journal.load(execution_id), world.input), result);
    return { generate: world.generateIds, eval: world.evalIds, attempts: result.attempts.map((attempt) => attempt.id) };
  };
  const executions = ['x', 'e'.repeat(120), 'f'.repeat(128)];
  const runs = await Promise.all(executions.map(run));
  for (const item of runs) {
    assert.ok(item.generate[0]?.endsWith(':a1:gen'));
    assert.ok(item.generate[1]?.endsWith(':a2:gen'));
    assert.ok(item.eval[0]?.endsWith(':a1:eval'));
    assert.ok(item.eval[1]?.endsWith(':a2:eval'));
  }
  assert.deepEqual(await Promise.all(executions.map(run)), runs);
  const multibyte = driver({ input: input({ execution_id: 'é'.repeat(64) }) });
  const invalid = await runImplementationStep(multibyte.input, multibyte.ports, multibyte.journal);
  assert.equal(invalid.reason, 'invalid_input');
  assert.equal(invalid.execution_id, null);
  assert.equal(multibyte.generateIds.length, 0);
});

test('compressed step ids do not collide with readable ids across executions sharing a journal (#122)', async () => {
  const execution = 'f'.repeat(128);
  const readableCollision = `${execution.slice(0, 60)}:${digest(execution)}`;
  assert.equal(readableCollision.length, 125);
  assert.equal(correlation(readableCollision), readableCollision);
  const journal = new MemoryAttemptJournal();
  const first = driver({ input: input({ execution_id: execution }), journal });
  const firstResult = await runImplementationStep(first.input, first.ports, first.journal);
  const second = driver({ input: input({ execution_id: readableCollision }), journal });
  const secondResult = await runImplementationStep(second.input, second.ports, second.journal);
  assert.equal(firstResult.status, 'passed');
  assert.equal(secondResult.status, 'passed');
  assert.notEqual(firstResult.attempts[0]?.id, secondResult.attempts[0]?.id);
  assert.equal(journal.load(execution).length, 1);
  assert.equal(journal.load(readableCollision).length, 1);
  assert.deepEqual(replayImplementationStep(journal.load(execution), first.input), firstResult);
  assert.deepEqual(replayImplementationStep(journal.load(readableCollision), second.input), secondResult);
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
  const result = await runImplementationStep(
    d.input,
    {
      ...d.ports,
      generate: async () => ({
        status: 'blocked',
        reason: 'no_route',
        request_id: 'req-1',
        site: 'impl.step',
        uncertainty: [],
        attempts: [],
        spent: 0,
      }),
    },
    d.journal,
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.evals, []);
  assert.deepEqual(result.open_issue?.criterion_ids, ['c1']);
});

// Criterion proof (#199): D5 is asked only about criteria that need judgment.
const heldOutGrant = {
  ...grant,
  permissions: [...grant.permissions, { resource: 'heldout-1', mode: 'read' }],
} as Grant;
const heldOutCheck: ImplementCheck = {
  operation: 'repo.test',
  grant: heldOutGrant,
  cwd_ref: 'workspace-1',
  env_allow: ['PUBLIC_NAME'],
  timeout_ms: 1000,
  argv: ['node', 'heldout'],
  oracle_refs: ['heldout-1'],
};
const checkProven = {
  criterion_id: 'c1',
  statement: 'the held-out suite passes',
  proof: 'check' as const,
  check_ids: ['repo.test'],
};
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
  const world = driver({
    input: proofInput({ criteria: [checkProven, { criterion_id: 'c2', statement: 'CANARY_JUDGED' }] }),
  });
  const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
  assert.equal(result.status, 'passed');
  assert.deepEqual(world.evalSites, ['eval.output']);
  const disclosed = world.evalStates[0] as { criteria: { criterion_id: string; statement: string }[] };
  assert.deepEqual(disclosed.criteria, [{ criterion_id: 'c2', statement: 'CANARY_JUDGED' }]);
  assert.deepEqual(
    result.evals.map((item) => item.criterion_id),
    ['c2'],
  );
  assert.deepEqual(
    result.proofs.map((item) => item.proof),
    ['check', 'judgment'],
  );
});

test('criterion proof: tests in the workspace generation writes cannot prove a criterion, so D5 is asked', async () => {
  const workspaceOracle: ImplementCheck = {
    ...heldOutCheck,
    oracle_refs: ['workspace-1'],
    grant: { ...grant, permissions: [...grant.permissions, { resource: 'workspace-1', mode: 'read' }] } as Grant,
  };
  const world = driver({ input: proofInput({ checks: [workspaceOracle] }) });
  const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
  assert.deepEqual(world.evalSites, ['eval.output']);
  assert.deepEqual(result.proofs, [
    { criterion_id: 'c1', proposed: 'check', proof: 'judgment', reason: 'oracle_writable' },
  ]);
  assert.deepEqual(
    result.evals.map((item) => item.criterion_id),
    ['c1'],
  );
});

test('criterion proof: without host canonical identity or declared generation writes the criterion keeps D5', async () => {
  const noPort = driver({ input: proofInput() });
  const unported = await runImplementationStep(noPort.input, noPort.ports, noPort.journal);
  assert.deepEqual(noPort.evalSites, ['eval.output']);
  assert.equal(unported.proofs[0]?.reason, 'write_scope_unknown');
  const { generation_writes: _omitted, ...undeclared } = proofInput();
  const noWrites = driver({ input: undeclared });
  const unscoped = await runImplementationStep(
    noWrites.input,
    { ...noWrites.ports, canonical: identity },
    noWrites.journal,
  );
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
  const legacy = world.journal.load('exec-1').map((entry) => {
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
  const world = driver({
    input: proofInput({ checks: [heldOutCheck, second], retries: 0, ceiling: 'flash' }),
    exits: [0, 1],
  });
  const result = await runImplementationStep(world.input, { ...world.ports, canonical: identity }, world.journal);
  assert.equal(result.status, 'failed');
  assert.deepEqual(world.evalSites, []);
  assert.deepEqual(result.attempts[0]?.failing_criterion_ids, ['c1']);
});

// #200: a red check already fails the attempt, so D5 is not asked about it.
test('a red check skips D5 for that attempt and records why; a green attempt asks D5 as before', async () => {
  const world = driver({ input: input({ retries: 1, ceiling: 'flash' }), exits: [1, 0] });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.status, 'passed');
  assert.deepEqual(world.evalSites, ['eval.output']);
  const [red, green] = result.attempts;
  assert.equal(red?.status, 'failed');
  assert.equal(red?.eval_skipped, 'check_failed');
  assert.deepEqual(red?.evals, []);
  assert.deepEqual(red?.observations, []);
  assert.deepEqual(red?.failing_criterion_ids, []);
  assert.deepEqual(red?.failing_check_ids, ['repo.test']);
  assert.match(world.prompts[1] ?? '', /check_id=repo\.test passed=false exit=1/);
  assert.equal(world.prompts[1]?.includes('criterion_id='), false);
  // A skipped D5 is not an outage: the retry stays on the same tier.
  assert.equal(green?.escalated, false);
  assert.equal(green?.eval_skipped, undefined);
  assert.equal(Object.hasOwn(green ?? {}, 'eval_skipped'), false);
  assert.equal(green?.evals[0]?.passed, true);
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), result);
});

test('a red check on the last attempt raises a check-sourced open issue with no D5 evaluation', async () => {
  const world = driver({ input: input({ retries: 0, ceiling: 'flash' }), exits: [1] });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.status, 'failed');
  assert.deepEqual(world.evalSites, []);
  assert.deepEqual(result.evals, []);
  assert.deepEqual(result.observations, []);
  assert.equal(result.attempts[0]?.eval_skipped, 'check_failed');
  assert.equal(result.open_issue?.source, 'check');
  assert.deepEqual(result.open_issue?.check_ids, ['repo.test']);
  assert.deepEqual(result.open_issue?.criterion_ids, []);
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), result);
});

// #120: the check-run identity comes from an injected port, as time does through `now`.
test('check invocation ids come from the injected run-id port, not ambient entropy (#120)', async () => {
  const run = async (runIds: readonly string[]) => {
    const world = driver({ evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }] });
    const queue = [...runIds];
    const result = await runImplementationStep(
      world.input,
      { ...world.ports, runId: () => queue.shift() ?? 'unexpected' },
      world.journal,
    );
    assert.equal(result.status, 'passed');
    assert.deepEqual(queue, [], 'one run id per generation run');
    return world.invokes.map((call) => call.invocation_id);
  };
  const first = await run(['run-a', 'run-b']);
  assert.deepEqual(await run(['run-a', 'run-b']), first, 'the same run ids replay the same check identities');
  assert.equal(new Set(first).size, 2, 'each generation run gets its own check identity');
  const fresh = await run(['run-c', 'run-d']);
  assert.ok(
    fresh.every((id) => !first.includes(id)),
    'a fresh run id never reuses a committed check identity',
  );
  assert.ok(
    first.every((id) => !id?.includes('run-a') && !id?.includes('run-b')),
    'run ids are digested, not copied',
  );
  for (const bad of [() => '', () => 7 as unknown as string]) {
    const world = driver({});
    await assert.rejects(runImplementationStep(world.input, { ...world.ports, runId: bad }, world.journal), /run id/);
    assert.equal(world.generateIds.length, 0, 'an invalid run id is refused before generation spends');
  }
});

// #121: check evidence links the attempt journal to the host's invocation record.
test('check evidence records the host invocation id, or null when the host gave none (#121)', async () => {
  const world = driver({});
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  const recorded = result.checks[0]?.invocation_id;
  assert.ok(recorded);
  assert.equal(recorded, world.invokes[0]?.invocation_id);
  assert.equal(correlation(recorded), recorded);
  const saved = world.journal.load('exec-1')[0];
  assert.ok(saved?.schema === 'impl.attempt@1');
  assert.equal(saved.checks[0]?.invocation_id, recorded);
  const denied = driver({ input: input({ checks: [{ ...input().checks[0]!, grant: null }] }) });
  assert.equal(
    (await runImplementationStep(denied.input, denied.ports, denied.journal)).checks[0]?.invocation_id,
    null,
  );
  const unsafe = driver({});
  const leaky: ImplementPorts = {
    ...unsafe.ports,
    invoke: (token, operation, inputs, options) => {
      const handle = unsafe.ports.invoke(token, operation, inputs, options);
      return handle.kind === 'handle' ? { ...handle, invocation_id: 'sk-CANARYHOSTID' } : handle;
    },
  };
  const screened = await runImplementationStep(unsafe.input, leaky, unsafe.journal);
  assert.equal(screened.checks[0]?.invocation_id, null);
  assert.equal(JSON.stringify(unsafe.journal.load('exec-1')).includes('CANARY'), false);
});

// #122: ids the step builds stay valid correlation ids for any valid execution id.
test('step-built ids stay within the 128-character correlation limit and stay distinct (#122)', async () => {
  const prefix = 'e'.repeat(127);
  const failing = { c1: { p: 0.1, conf: 1 } };
  const ids = async (execution_id: string) => {
    const world = driver({
      input: input({ execution_id, ceiling: 'standard' }),
      evaluations: [failing, failing, failing, failing],
    });
    const result = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts.length, 4);
    const built = [
      ...world.generateIds,
      ...world.invokes.map((call) => call.invocation_id),
      ...world.journal.load(execution_id).map((entry) => entry.id),
      ...result.attempts.flatMap((attempt) => attempt.observations.map((observation) => observation.request_id)),
      ...result.attempts.flatMap((attempt) => attempt.checks.map((check) => check.invocation_id)),
      result.open_issue?.issue_id,
    ];
    assert.equal(built.length, 4 + 4 + 5 + 4 + 4 + 1);
    for (const id of built) assert.equal(correlation(id), id, `invalid step id ${String(id)}`);
    return built;
  };
  const a = await ids(`${prefix}a`);
  const b = await ids(`${prefix}b`);
  assert.equal(new Set([...a, ...b]).size, new Set(a).size + new Set(b).size, 'shared prefixes keep distinct ids');
  assert.deepEqual(await ids(`${prefix}a`), a, 'bounded ids are deterministic');
  const short = driver({});
  await runImplementationStep(short.input, short.ports, short.journal);
  assert.deepEqual(short.generateIds, ['exec-1:a1:gen'], 'short ids keep their readable form');
  assert.match(short.invokes[0]?.invocation_id ?? '', /^exec-1:a1:[a-f0-9]{32}:repo\.test$/);
});

// #123: cancelling the step cancels the check in flight instead of leaving it running.
for (const storage of ['memory', 'file'] as const) {
  test(`cancelling the step requests cancellation of the in-flight check and pauses (#123, ${storage})`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-p8-cancel-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'attempts.jsonl');
    const journal = storage === 'file' ? new FileAttemptJournal(path) : new MemoryAttemptJournal();
    type Outcome = { outcome: 'failed'; failure: string } | { outcome: 'succeeded'; output: unknown };
    const world = driver({ journal });
    const controller = new AbortController();
    let cancels = 0;
    const ports: ImplementPorts = {
      ...world.ports,
      invoke: (token, operation, inputs, options) => {
        const handle = world.ports.invoke(token, operation, inputs, options);
        if (handle.kind !== 'handle') return handle;
        let settle: (outcome: Outcome) => void = () => {};
        const result = new Promise<Outcome>((resolve) => {
          settle = resolve;
        });
        // A host that ends a long check only when asked to cancel; the fallback keeps a red run finite.
        const fallback = setTimeout(
          () => settle({ outcome: 'succeeded', output: { exit: 0, stdout_tail: '', artifacts: [] } }),
          500,
        );
        queueMicrotask(() => controller.abort());
        return {
          ...handle,
          result,
          requestCancel() {
            cancels += 1;
            clearTimeout(fallback);
            settle({ outcome: 'failed', failure: 'cancelled' });
          },
        };
      },
    };
    const result = await runImplementationStep(world.input, ports, world.journal, controller.signal);
    assert.equal(cancels, 1, 'the in-flight check is asked to cancel');
    assert.equal(result.status, 'paused');
    assert.equal(result.attempts[0]?.pause?.reason, 'cancelled');
    assert.equal(result.attempts[0]?.checks[0]?.passed, false);
    assert.equal(result.attempts[0]?.checks[0]?.exit, null);
    assert.deepEqual(world.evalSites, [], 'no D5 after cancellation');
    assert.equal(result.goal_done, false);
    if (storage === 'file') {
      const recovered = new FileAttemptJournal(path);
      assert.deepEqual(recovered.load('exec-1'), journal.load('exec-1'));
      assert.deepEqual(replayImplementationStep(recovered.load('exec-1'), world.input), result);
    }
  });
}

// #128: a budget pause is temporary at escalation too.
test('a budget pause at escalation pauses the step and resumes into the escalation (#128)', async () => {
  const fail = { c1: { p: 0.1, conf: 1 } };
  let pausing = true;
  const world = driver({
    evaluations: [fail, fail, fail, { c1: { p: 1, conf: 1 } }],
    budget: (request) =>
      request.escalation && pausing
        ? { status: 'pause', reason: 'weekly_budget_cap', until: 80 }
        : { status: 'allow', tier: request.requested },
  });
  const paused = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.open_issue, null, 'a pause raises no open issue');
  assert.equal(paused.goal_done, false);
  assert.equal(paused.escalated, false);
  assert.deepEqual(world.tiers, ['flash', 'flash', 'flash']);
  const held = paused.attempts.at(-1);
  assert.equal(held?.status, 'paused');
  assert.equal(held?.escalated, true);
  assert.equal(held?.requested_tier, 'standard');
  assert.equal(held?.effective_tier, null);
  assert.deepEqual(held?.pause, { reason: 'weekly_budget_cap', until: 80 });
  assert.equal(
    world.journal.load('exec-1').some((entry) => entry.schema === 'impl.stop@1'),
    false,
  );
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), paused);
  assert.deepEqual(
    await runImplementationStep(world.input, world.ports, world.journal).then((again) => again.status),
    'paused',
  );
  pausing = false;
  const resumed = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(resumed.status, 'passed');
  assert.equal(resumed.escalated, true);
  assert.deepEqual(
    world.tiers,
    ['flash', 'flash', 'flash', 'standard'],
    'the paused escalation runs once, at one tier up',
  );
  assert.equal(resumed.attempts.at(-1)?.escalated, true);
  assert.equal(resumed.attempts.at(-1)?.effective_tier, 'standard');
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), resumed);
});

// #129: a D5 outage pauses the step instead of spending its retries and escalation.
test('a D5 outage pauses the attempt without consuming a retry or the escalation (#129)', async () => {
  for (const outage of ['throw', 'outage'] as const) {
    const world = driver({
      input: input({ retries: 0, ceiling: 'standard' }),
      evaluations: [outage, { c1: { p: 1, conf: 1 } }],
    });
    const paused = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(paused.status, 'paused', outage);
    assert.equal(paused.open_issue, null, outage);
    assert.equal(paused.goal_done, false, outage);
    assert.deepEqual(paused.attempts[0]?.pause, { reason: 'decision_unavailable', until: null }, outage);
    assert.ok(
      paused.observations.every((item) => item.reason === 'decision_unavailable'),
      outage,
    );
    assert.deepEqual(world.tiers, ['flash'], 'no retry or escalation is spent during the outage');
    assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), paused);
    const resumed = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(resumed.status, 'passed', outage);
    assert.deepEqual(world.tiers, ['flash', 'flash'], 'the resumed attempt stays on the routed tier');
    assert.equal(resumed.escalated, false);
    assert.equal(JSON.stringify(resumed).includes('CANARY_PROVIDER'), false);
  }
  // #200: a skipped D5 is not an outage; the red check consumes its retry as a check failure.
  const red = driver({ input: input({ retries: 0, ceiling: 'flash' }), exits: [1] });
  const failed = await runImplementationStep(red.input, red.ports, red.journal);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts[0]?.status, 'failed');
  assert.equal(failed.attempts[0]?.eval_skipped, 'check_failed');
  assert.equal(failed.attempts[0]?.pause, null);
  assert.equal(failed.open_issue?.source, 'check');
});

// #131: FileAttemptJournal syncs each append, reads the file once, and fails closed on a second writer.
test('the file journal fsyncs each append and does not reread the file per append (#131)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-durable-'));
  const fsModule = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const original = { readFileSync: fsModule.readFileSync, fsyncSync: fsModule.fsyncSync };
  const path = join(dir, 'attempts.jsonl');
  const counts = { reads: 0, fsyncs: 0 };
  try {
    const journal = new FileAttemptJournal(path);
    fsModule.readFileSync = ((...args: Parameters<typeof original.readFileSync>) => {
      if (String(args[0]) === path) counts.reads += 1;
      return original.readFileSync(...args);
    }) as typeof original.readFileSync;
    fsModule.fsyncSync = (fd: number) => {
      counts.fsyncs += 1;
      original.fsyncSync(fd);
    };
    syncBuiltinESMExports();
    const fail = { c1: { p: 0.2, conf: 1 } };
    const world = driver({ journal, evaluations: [fail, fail, { c1: { p: 1, conf: 1 } }] });
    const result = await runImplementationStep(world.input, world.ports, world.journal);
    assert.equal(result.attempts.length, 3);
    assert.equal(journal.load('exec-1').length, 3);
    assert.equal(counts.fsyncs, 3, 'every append is synced before it returns');
    assert.ok(
      counts.reads <= 2,
      `the writer reads and repairs the file once, then appends without rereading (read ${counts.reads} times)`,
    );
  } finally {
    fsModule.readFileSync = original.readFileSync;
    fsModule.fsyncSync = original.fsyncSync;
    syncBuiltinESMExports();
  }
  try {
    assert.deepEqual(
      new FileAttemptJournal(path).load('exec-1').map((entry) => entry.id),
      ['exec-1:a1', 'exec-1:a2', 'exec-1:a3'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second writer on one attempt journal is detected and refused (#131)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-writer-'));
  try {
    const path = join(dir, 'attempts.jsonl');
    const source = driver({
      evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }],
    });
    await runImplementationStep(source.input, source.ports, source.journal);
    const [first, second, third] = source.journal.load('exec-1');
    assert.ok(first && second && third);
    const owner = new FileAttemptJournal(path);
    owner.append(first);
    const intruder = new FileAttemptJournal(path);
    assert.deepEqual(
      intruder.load('exec-1').map((entry) => entry.id),
      ['exec-1:a1'],
    );
    intruder.append(second);
    assert.throws(() => owner.append(third), /another writer/);
    assert.throws(() => owner.append(first), /another writer/, 'even a duplicate must check for another writer');
    assert.throws(() => owner.load('exec-1'), /another writer/);
    assert.deepEqual(
      new FileAttemptJournal(path).load('exec-1').map((entry) => entry.id),
      ['exec-1:a1', 'exec-1:a2'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #277: steady-state queries must not inspect entries belonging to other executions.
for (const operation of ['load', 'append'] as const) {
  test(`file journal ${operation} does not scan unrelated entries (#277)`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-p8-index-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = driver({});
    await runImplementationStep(source.input, source.ports, source.journal);
    const seed = source.journal.load('exec-1')[0]!;
    const path = join(dir, 'attempts.jsonl');
    const unrelated = Array.from({ length: 256 }, (_, i) => ({
      ...seed,
      id: `other-${i}`,
      execution_id: `other-${i}`,
    }));
    writeFileSync(path, [...unrelated, seed].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    const journal = new FileAttemptJournal(path);
    const parse = JSON.parse;
    let reads = 0;
    try {
      // Count property reads on parsed records, including scans through helpers.
      // Accessors still allow structuredClone; no timing or private fields needed.
      JSON.parse = (text: string) => {
        const value = parse(text) as JournalEntry;
        if (value.execution_id?.startsWith('other-')) {
          for (const key of ['id', 'execution_id'] as const) {
            const field = value[key];
            Object.defineProperty(value, key, {
              enumerable: true,
              get: () => {
                reads += 1;
                return field;
              },
            });
          }
        }
        return value;
      };
      journal.load('exec-1');
    } finally {
      JSON.parse = parse;
    }
    reads = 0;
    if (operation === 'load') assert.deepEqual(journal.load('exec-1'), [seed]);
    else journal.append({ ...seed, id: 'new-attempt' });
    assert.equal(reads, 0, `${operation} must not read unrelated journal entries`);
  });
}

test('file journal indexes preserve log order, duplicate records, replay and defensive copies after recovery (#277)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-index-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = driver({ evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }] });
  const second = driver({ input: input({ execution_id: 'exec-2', retries: 0, ceiling: 'flash' }), exits: [1] });
  const results = await Promise.all([
    runImplementationStep(first.input, first.ports, first.journal),
    runImplementationStep(second.input, second.ports, second.journal),
  ]);
  const a = first.journal.load('exec-1');
  const b = second.journal.load('exec-2');
  assert.equal(b.at(-1)?.schema, 'impl.stop@1');
  const log = [a[0]!, b[0]!, ...a.slice(1), ...b.slice(1)];
  const path = join(dir, 'attempts.jsonl');
  const journal = new FileAttemptJournal(path);
  for (const entry of log) journal.append(entry);
  const original = readFileSync(path, 'utf8');
  journal.append({ ...log[0]!, execution_id: 'exec-2' });
  assert.equal(readFileSync(path, 'utf8'), original, 'ids are unique across executions');
  for (const loaded of [journal, new FileAttemptJournal(path)]) {
    for (const [i, world] of [first, second].entries()) {
      const expected = log.filter((entry) => entry.execution_id === world.input.execution_id);
      assert.deepEqual(loaded.load(world.input.execution_id), expected);
      assert.deepEqual(replayImplementationStep(loaded.load(world.input.execution_id), world.input), results[i]);
    }
    assert.deepEqual(loaded.load('missing'), []);
    const copy = loaded.load('exec-1');
    const attempt = copy[0]!;
    assert.equal(attempt.schema, 'impl.attempt@1');
    if (attempt.schema === 'impl.attempt@1') (attempt.artifact_refs as string[]).push('mutated');
    copy.pop();
    assert.deepEqual(loaded.load('exec-1'), a, 'nested values and arrays are defensive copies');
  }
  const snapshot = structuredClone(a);
  if (a[0]!.schema === 'impl.attempt@1') (a[0]!.artifact_refs as string[]).push('caller-mutation');
  assert.deepEqual(journal.load('exec-1'), snapshot, 'append owns a defensive copy');

  // Historical logs can contain repeated ids: reconstruction must keep every record.
  appendFileSync(path, `${JSON.stringify(snapshot[0])}\n{"schema":"impl.att`);
  const recovered = new FileAttemptJournal(path);
  const expected = [...snapshot, snapshot[0]!];
  assert.deepEqual(recovered.load('exec-1'), expected);
  const repaired = readFileSync(path, 'utf8');
  recovered.append(snapshot[0]!);
  assert.equal(readFileSync(path, 'utf8'), repaired, 'recovery rebuilds duplicate detection');
  recovered.append({ ...snapshot[0]!, id: 'after-recovery' });
  assert.deepEqual(new FileAttemptJournal(path).load('exec-1'), recovered.load('exec-1'));
});

test('a rejected file journal write leaves indexes unchanged and can be retried (#277)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-index-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = driver({});
  await runImplementationStep(source.input, source.ports, source.journal);
  const entry = source.journal.load('exec-1')[0]!;
  const path = join(dir, 'attempts.jsonl');
  const journal = new FileAttemptJournal(path);
  journal.load('exec-1');
  const fsModule = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const write = fsModule.writeSync;
  try {
    fsModule.writeSync = () => {
      throw new Error('injected write failure');
    };
    syncBuiltinESMExports();
    assert.throws(() => journal.append(entry), /injected write failure/);
    assert.deepEqual(journal.load('exec-1'), []);
    assert.equal(readFileSync(path, 'utf8'), '');
  } finally {
    fsModule.writeSync = write;
    syncBuiltinESMExports();
  }
  journal.append(entry);
  journal.append(entry);
  assert.deepEqual(journal.load('exec-1'), [entry]);
  assert.deepEqual(new FileAttemptJournal(path).load('exec-1'), [entry]);
});

// #249: a write that fails part-way (ENOSPC) is reported as an incomplete
// append, not as another writer, and a fresh journal repairs its torn tail.
test('a part-written file journal append is reported as incomplete, not as another writer (#249)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-torn-append-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = driver({ evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }] });
  await runImplementationStep(source.input, source.ports, source.journal);
  const [first, second] = source.journal.load('exec-1');
  assert.ok(first && second);
  const path = join(dir, 'attempts.jsonl');
  const journal = new FileAttemptJournal(path);
  journal.append(first);
  const fsModule = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const write = fsModule.writeSync;
  try {
    fsModule.writeSync = ((fd: number, data: string | NodeJS.ArrayBufferView) => {
      const text = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      write(fd, text.slice(0, 10) as string);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }) as typeof write;
    syncBuiltinESMExports();
    assert.throws(() => journal.append(second), /ENOSPC/);
  } finally {
    fsModule.writeSync = write;
    syncBuiltinESMExports();
  }
  for (const call of [() => journal.load('exec-1'), () => journal.append(second)]) {
    assert.throws(call, (error: Error) => {
      assert.doesNotMatch(error.message, /another writer/);
      assert.match(error.message, /did not complete/);
      return true;
    });
  }
  const reopened = new FileAttemptJournal(path);
  assert.deepEqual(
    reopened.load('exec-1').map((entry) => entry.id),
    [first.id],
    'the torn tail is repaired on the next open',
  );
  reopened.append(second);
  assert.deepEqual(
    new FileAttemptJournal(path).load('exec-1').map((entry) => entry.id),
    [first.id, second.id],
  );
});

// #249: a writer that appends between this journal's check and its own write
// is detected after the write, not absorbed into the remembered size.
test('a file journal detects another writer appending during its own append (#249)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p8-interleave-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = driver({
    evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }],
  });
  await runImplementationStep(source.input, source.ports, source.journal);
  const [first, second, third] = source.journal.load('exec-1');
  assert.ok(first && second && third);
  const path = join(dir, 'attempts.jsonl');
  const owner = new FileAttemptJournal(path);
  owner.append(first);
  const fsModule = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const write = fsModule.writeSync;
  let intruded = false;
  try {
    fsModule.writeSync = ((...args: Parameters<typeof write>) => {
      if (!intruded) {
        intruded = true;
        appendFileSync(path, `${JSON.stringify(second)}\n`);
      }
      return (write as (...rest: unknown[]) => number)(...args);
    }) as typeof write;
    syncBuiltinESMExports();
    assert.throws(() => owner.append(third), /another writer/);
  } finally {
    fsModule.writeSync = write;
    syncBuiltinESMExports();
  }
  assert.ok(intruded);
  assert.throws(() => owner.load('exec-1'), /another writer/);
});

// #130: escalation is relative to the D2-routed tier; the budget gate re-checks it.
test('escalation steps up from the routed tier, not from a budget-lowered tier (#130)', async () => {
  const fail = { c1: { p: 0.1, conf: 1 } };
  const requests: [ImplementBudgetRequest['requested'], boolean][] = [];
  const world = driver({
    input: input({ tier: 'standard', ceiling: 'strong' }),
    evaluations: [fail, fail, fail, { c1: { p: 1, conf: 1 } }],
    budget: (request) => {
      requests.push([request.requested, request.escalation]);
      return { status: 'allow', tier: request.escalation ? request.requested : 'flash' };
    },
  });
  const result = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(result.status, 'passed');
  assert.deepEqual(requests, [
    ['standard', false],
    ['standard', false],
    ['standard', false],
    ['strong', true],
  ]);
  assert.deepEqual(world.tiers, ['flash', 'flash', 'flash', 'strong']);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.requested_tier),
    ['standard', 'standard', 'standard', 'strong'],
  );
  const lowered = driver({
    input: input({ tier: 'standard', ceiling: 'strong' }),
    evaluations: [fail, fail, fail],
    budget: () => ({ status: 'allow', tier: 'flash' }),
  });
  const stopped = await runImplementationStep(lowered.input, lowered.ports, lowered.journal);
  assert.equal(stopped.status, 'failed');
  assert.equal(
    stopped.open_issue?.blocked_by,
    'budget',
    'a budget that still lowers the escalated tier stops the step',
  );
  assert.deepEqual(lowered.tiers, ['flash', 'flash', 'flash']);
});

// #126: a journal the step has not finished does not read as a terminal failure.
test('replay of an unfinished journal reports unfinished, not failed (#126)', async () => {
  const world = driver({ evaluations: [{ c1: { p: 0.2, conf: 1 } }, { c1: { p: 1, conf: 1 } }] });
  world.crashesAt = 2;
  await assert.rejects(runImplementationStep(world.input, world.ports, world.journal), /simulated-crash/);
  const midway = replayImplementationStep(world.journal.load('exec-1'), world.input);
  assert.equal(midway.status, 'unfinished');
  assert.equal(midway.open_issue, null);
  assert.equal(midway.goal_done, false);
  assert.equal(midway.attempts.length, 1);
  assert.equal(midway.attempts[0]?.status, 'failed');
  assert.equal(replayImplementationStep([], world.input).status, 'unfinished', 'nothing has run yet');
  world.crashesAt = 0;
  const finished = await runImplementationStep(world.input, world.ports, world.journal);
  assert.equal(finished.status, 'passed');
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), finished);
});

// #124, #125: the issuer bounds fresh grants per held grant and names each one.
test('the equal issuer gives each fresh grant its own action id and stops at its limit (#124, #125)', () => {
  const authority = createGrantAuthority();
  const fields = {
    action_id: 'act-1',
    operation: 'repo.test',
    contract_rev: 'r1',
    permissions: [{ resource: 'workspace-1', mode: 'write' as const }],
    effects: [{ resource: 'workspace-1', mode: 'write' as const }],
    process_effects: ['process.spawn', 'fs.write:workspace-1'],
    issued_at: 1,
  };
  const held = authority.issue(fields);
  const other = authority.issue({ ...fields, action_id: 'act-2' });
  const issuer = createEqualGrantIssuer(authority, [held, other], { retries: 0 });
  const first = issuer.issue(held);
  const second = issuer.issue(held);
  assert.ok(first && second);
  assert.equal(
    new Set([held.action_id, first.action_id, second.action_id]).size,
    3,
    'release/proceed by action id stay unambiguous',
  );
  assert.ok(authority.isIssued(first) && authority.isIssued(second));
  assert.equal(issuer.issue(held), null, 'the limit bounds fresh grants per held grant');
  const third = issuer.issue(other);
  assert.ok(third, 'each held grant has its own count');
  assert.equal(new Set([first.action_id, second.action_id, third.action_id]).size, 3);
  const defaults = createEqualGrantIssuer(authority, [held], {});
  const minted = Array.from({ length: DEFAULT_IMPLEMENT_RETRIES + 3 }, () => defaults.issue(held));
  assert.equal(
    minted.filter((item) => item !== null).length,
    DEFAULT_IMPLEMENT_RETRIES + 2,
    'by default one fresh grant per generation run of a step: retries, the first attempt and the escalation',
  );
  assert.equal(minted.at(-1), null);
  for (const bad of [-1, 1.5, 9, Number.NaN, '2']) {
    assert.throws(() => createEqualGrantIssuer(authority, [held], { retries: bad as number }), /limit/, String(bad));
  }
});

// #249: the issuer is sized from the step's own retries, so a step configured
// with more retries than the default still gets a grant on every run.
test('an issuer sized from the step input grants every generation run its checks (#249)', async () => {
  const authority = createGrantAuthority();
  const template = authority.issue({
    action_id: 'act-1',
    operation: 'repo.test',
    contract_rev: 'r1',
    permissions: [{ resource: 'workspace-1', mode: 'write' }],
    effects: [{ resource: 'workspace-1', mode: 'write' }],
    process_effects: ['process.spawn', 'fs.write:workspace-1'],
    issued_at: 1,
  });
  const base = input();
  const work = input({ retries: 4, checks: base.checks.map((check) => ({ ...check, grant: template })) });
  const world = driver({ input: work, exits: Array.from({ length: 8 }, () => 1) });
  const issuer = createEqualGrantIssuer(authority, [template], work);
  const result = await runImplementationStep(
    work,
    { ...world.ports, issueCheckGrant: (held) => issuer.issue(held) },
    world.journal,
  );
  assert.equal(result.attempts.length, 6, 'the first attempt, four retries and the escalation');
  assert.equal(world.invokes.length, 6);
  assert.ok(
    world.invokes.every((call) => call.grant !== null),
    'no run is denied its check grant',
  );
  assert.ok(result.attempts.every((attempt) => attempt.checks[0]?.exit === 1));
  assert.equal(result.open_issue?.source, 'check');
  assert.equal(issuer.issue(template), null, 'the bound still holds past the last run');
});

test('uncertain generation records its invocation and stalls without checks, evaluation, or implicit retry', async () => {
  const world = driver({});
  let calls = 0;
  const ports: ImplementPorts = {
    ...world.ports,
    generate: async (request) => {
      calls += 1;
      return {
        status: 'uncertain',
        invocation_id: 'shell-cli:held',
        reason: 'cancelled',
        request_id: request.request_id,
        site: request.site,
        attempts: [],
        spent: 0,
        uncertainty: [],
      };
    },
  };
  const result = await runImplementationStep(world.input, ports, world.journal);
  assert.equal(result.status, 'paused');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.status, 'uncertain');
  assert.equal(Reflect.get(result.attempts[0]!, 'invocation_id'), 'shell-cli:held');
  assert.equal(world.invokes.length, 0);
  assert.equal(world.evalSites.length, 0);
  assert.equal(result.open_issue, null);
  assert.deepEqual(replayImplementationStep(world.journal.load('exec-1'), world.input), result);
  assert.deepEqual(await runImplementationStep(world.input, ports, world.journal), result);
  assert.equal(calls, 1);
});

async function uncertainStep(world: Driver) {
  return runImplementationStep(
    world.input,
    {
      ...world.ports,
      generate: async (request) => ({
        status: 'uncertain',
        invocation_id: 'shell-cli:held',
        reason: 'cancelled',
        request_id: request.request_id,
        site: request.site,
        attempts: [],
        spent: 0,
        uncertainty: [],
      }),
    },
    world.journal,
  );
}

test('uncertain attempts resume after not_committed without spending a retry or escalation, including after restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'impl-reconciled-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'attempts.jsonl');
  const world = driver({ input: input({ retries: 0, ceiling: 'flash' }), journal: new FileAttemptJournal(path) });
  await uncertainStep(world);
  const looked: string[] = [];
  const ports = {
    ...world.ports,
    lookupReconciliation: async (id: string) => {
      looked.push(id);
      return { status: 'not_committed' as const };
    },
  };
  const result = await runImplementationStep(world.input, ports, new FileAttemptJournal(path));
  assert.equal(result.status, 'passed');
  assert.deepEqual(looked, ['shell-cli:held']);
  assert.deepEqual(world.tiers, ['flash']);
  assert.equal(result.escalated, false);
  assert.equal(result.attempts[0]?.status, 'uncertain', 'original evidence is retained');
  const entries = new FileAttemptJournal(path).load(world.input.execution_id);
  assert.deepEqual(replayImplementationStep(entries, world.input), result);
  assert.deepEqual(await runImplementationStep(world.input, ports, new FileAttemptJournal(path)), result);
  assert.equal(looked.length, 1, 'durable resolution prevents another lookup');
  assert.equal(world.generateIds.length, 1);
});

test('unresolved or failed reconciliation lookup stays paused with uncertainty and does not execute', async () => {
  const world = driver({});
  const paused = await uncertainStep(world);
  for (const lookupReconciliation of [
    async (_id: string) => ({ status: 'unresolved' as const }),
    async (_id: string): Promise<never> => {
      throw new Error('lookup unavailable');
    },
  ]) {
    let calls = 0;
    const ports = {
      ...world.ports,
      lookupReconciliation: (id: string) => {
        assert.equal(id, 'shell-cli:held');
        calls++;
        return lookupReconciliation(id);
      },
    };
    assert.deepEqual(await runImplementationStep(world.input, ports, world.journal), paused);
    assert.equal(calls, 1);
    assert.deepEqual(world.generateIds, []);
    assert.deepEqual(world.invokes, []);
    assert.deepEqual(world.evalSites, []);
  }
});

test('uncertain attempt without an invocation identity stays paused without execution', async () => {
  const world = driver({});
  const first = await uncertainStep(world);
  const journal = new MemoryAttemptJournal();
  const legacy = { ...first.attempts[0]! };
  delete legacy.invocation_id;
  journal.append(legacy);
  const result = await runImplementationStep(world.input, world.ports, journal);
  assert.equal(result.status, 'paused');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.status, 'uncertain');
  assert.deepEqual(world.generateIds, []);
  assert.deepEqual(world.invokes, []);
});

for (const accepted of [true, false]) {
  test(`committed reconciliation uses its ${accepted ? 'accepted' : 'unaccepted'} result without repeating generation`, async () => {
    const world = driver({ input: input({ retries: 0, ceiling: 'flash' }) });
    await uncertainStep(world);
    const outcome: GenerationOutcome = accepted
      ? {
          status: 'accepted',
          text: 'reconciled change',
          request_id: 'exec-1:a1:gen',
          site: 'impl.generate',
          routed_unit_id: 'fixture',
          provider_response_id: 'reconciled',
          attempts: [],
          spent: 0,
          uncertainty: [],
        }
      : {
          status: 'unaccepted',
          reason: 'provider_failed',
          request_id: 'exec-1:a1:gen',
          site: 'impl.generate',
          attempts: [],
          spent: 0,
          uncertainty: [],
        };
    const ports = {
      ...world.ports,
      lookupReconciliation: async (id: string) => {
        assert.equal(id, 'shell-cli:held');
        return { status: 'committed' as const, outcome };
      },
    };
    const result = await runImplementationStep(world.input, ports, world.journal);
    assert.equal(result.status, accepted ? 'passed' : 'failed');
    assert.equal(world.generateIds.length, 0);
    assert.equal(world.invokes.length, accepted ? 1 : 0);
    assert.equal(world.evalSites.length, accepted ? 1 : 0);
    assert.deepEqual(replayImplementationStep(world.journal.load(world.input.execution_id), world.input), result);
    assert.deepEqual(await runImplementationStep(world.input, world.ports, world.journal), result);
  });
}
