import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvaluationRequest, InferenceGateway } from '@weave/gateway';
const roles = () => import('../src/sites/' + 'spawn-roles.js');
const current = { state_revision: 1, state_updated_at: 10, observed_at: 10 };
const ask = () => ({
  ...current,
  request_id: 'd'.repeat(96),
  state: {
    request: 'CANARY-msg',
    context: 'CANARY-ctx',
    targets: [
      { ref: 'a', summary: 'CANARY-target CANARY-summary' },
      { ref: 'b', summary: 'CANARY-target' },
    ],
  },
  terms: {
    quality: 'baseline',
    destinations: ['local'],
    max_context_tokens: 100,
    deadline: 100,
    cost_ceiling: 10,
    max_attempts: 1,
  },
});
function answer(): any {
  return {
    status: 'accepted',
    kind: 'choice',
    request_id: `${ask().request_id}:roles`,
    site: 'spawn.roles',
    answers: {
      target_0: { type: 'choice', choice: 'edit', probabilities: { edit: 0.8, read: 0.2 } },
      target_1: { type: 'choice', choice: 'read', probabilities: { read: 1 } },
    },
    confidence: { target_0: 0.9, target_1: 1 },
    provider_response_id: 'r1',
    routed_unit_id: 'CANARY-provider',
    attempts: [],
    spent: 0,
    uncertainty: ['CANARY-provider'],
  };
}
function port(fn: (r: EvaluationRequest, signal?: AbortSignal) => Promise<unknown>) {
  return { evaluate: fn as InferenceGateway['evaluate'] };
}

test('P5a-7 one keyed request, captured state, frozen criteria and aborted signal', async () => {
  const { askRoles, SPAWN_ROLES_SITE, SPAWN_ROLES_QUESTION, SPAWN_ROLE_CRITERIA } = await roles();
  assert.equal(SPAWN_ROLES_SITE, 'spawn.roles');
  assert.equal(
    SPAWN_ROLES_QUESTION,
    'For this request, what must happen to the named target before or during the work?',
  );
  assert.deepEqual(SPAWN_ROLE_CRITERIA, {
    edit: 'The request requires changing this target.',
    read: 'This target must be read before anything is generated, and must not change.',
    forbid: 'This target must not change, and does not need to be read.',
    skip: 'This target is not relevant to the request.',
  });
  assert.ok(Object.isFrozen(SPAWN_ROLE_CRITERIA));
  const input = ask();
  const before = structuredClone(input);
  const calls: EvaluationRequest[] = [];
  let resolve!: (v: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const controller = new AbortController();
  const result = askRoles(
    input,
    port(async (r, signal) => {
      calls.push(r);
      assert.equal(signal, controller.signal);
      return pending;
    }),
    () => current,
    controller.signal,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    request_id: `${before.request_id}:roles`,
    site: 'spawn.roles',
    role: 'working',
    kind: 'choice',
    state: before.state,
    questions: Object.fromEntries(
      before.state.targets.map((t, i) => [
        `target_${i}`,
        {
          type: 'choice',
          instructions: { question: SPAWN_ROLES_QUESTION, target: t.ref },
          criteria: SPAWN_ROLE_CRITERIA,
        },
      ]),
    ),
    terms: { ...before.terms, tier: 'decision' },
  });
  input.state.targets[0]!.ref = 'changed';
  input.state.request = 'changed';
  input.terms.destinations.push('changed');
  assert.deepEqual(calls[0]!.state, before.state);
  assert.deepEqual(calls[0]!.terms, { ...before.terms, tier: 'decision' });
  resolve(answer());
  assert.equal((await result).reason, 'answered');
  controller.abort();
  const aborted = await askRoles(
    ask(),
    port(async () => assert.fail('aborted')),
    () => current,
    controller.signal,
  );
  assert.equal(aborted.reason, 'cancelled');
});

test('P5a-8 ordered admission, whole-round failure, statistics and outages', async () => {
  const { transitionRoles, askRoles } = await roles();
  const cases: {
    mutate?: (o: any) => void;
    reason: string;
    top?: number | null;
    confidence?: number | null;
    now?: any;
    cancelled?: boolean;
    outcome?: null;
  }[] = [
    { reason: 'answered', top: 0.8, confidence: 0.9 },
    ...[{ edit: 0.1, read: 0.9 }, { edit: 2 }, { edit: 0.8, unknown: 0.2 }, { edit: 0.8 }, null, []].map(
      (probabilities) => ({
        mutate: (o: any) => {
          o.answers.target_0.probabilities = probabilities;
        },
        reason: 'answered',
        top: null,
        confidence: 0.9,
      }),
    ),
    ...[-1, 2, NaN, Infinity].map((c) => ({
      mutate: (o: any) => {
        o.confidence.target_0 = c;
      },
      reason: 'answered',
      top: 0.8,
      confidence: null,
    })),
    {
      mutate: (o) => {
        o.answers.target_0.choice = 'other';
      },
      reason: 'invalid_answer',
    },
    {
      mutate: (o) => {
        delete o.answers.target_1;
      },
      reason: 'invalid_answer',
    },
    {
      mutate: (o) => {
        o.kind = 'boolean';
      },
      reason: 'invalid_answer',
    },
    {
      mutate: (o) => {
        o.answers.target_0.type = 'boolean';
      },
      reason: 'invalid_answer',
    },
    {
      mutate: (o) => {
        o.status = 'blocked';
        o.reason = 'policy_denied';
      },
      reason: 'no_answer',
    },
    { outcome: null, reason: 'decision_unavailable' },
    {
      mutate: (o) => {
        o.paused = {};
      },
      reason: 'decision_unavailable',
    },
    ...['provider_unavailable', 'no_route', 'no_budget', 'quota_unknown', 'budget_exhausted'].map((reason) => ({
      mutate: (o: any) => {
        o.status = reason === 'budget_exhausted' ? 'unaccepted' : 'blocked';
        o.reason = reason;
      },
      reason: 'decision_unavailable',
    })),
    {
      mutate: (o) => {
        o.request_id = 'foreign';
      },
      reason: 'mismatched_answer',
    },
    {
      mutate: (o) => {
        o.site = 'foreign';
      },
      reason: 'mismatched_answer',
    },
    { now: { ...current, state_revision: 2 }, reason: 'stale_answer' },
    { now: { ...current, state_revision: 2 }, cancelled: true, outcome: null, reason: 'cancelled' },
  ];
  for (const c of cases) {
    const outcome = answer();
    c.mutate?.(outcome);
    const result = transitionRoles(
      ask(),
      { ...current, outcome: c.outcome === null ? null : outcome, cancelled: c.cancelled },
      c.now ?? current,
    );
    assert.equal(result.reason, c.reason);
    assert.deepEqual(
      result.targets.map((t: any) => t.role),
      c.reason === 'answered' ? ['edit', 'read'] : [null, null],
    );
    assert.equal(result.targets[0].top_p, c.reason === 'answered' ? c.top : null);
    assert.equal(result.targets[0].confidence, c.reason === 'answered' ? c.confidence : null);
  }
  const thrown = await askRoles(
    ask(),
    port(async () => {
      throw new Error('CANARY-error');
    }),
    () => current,
  );
  assert.equal(thrown.reason, 'decision_unavailable');
  const controller = new AbortController();
  assert.equal(
    (
      await askRoles(
        ask(),
        port(async () => {
          controller.abort();
          return answer();
        }),
        () => current,
        controller.signal,
      )
    ).reason,
    'cancelled',
  );
});

test('P5a-9 exact observation shape, ignored unknown keys and no authority or text', async () => {
  const { transitionRoles } = await roles();
  const outcome = answer();
  outcome.answers['CANARY-provider'] = { choice: 'CANARY-provider' };
  outcome.provider_response_id = 'Bearer CANARY-provider';
  const record = transitionRoles(ask(), { ...current, outcome }, current);
  assert.equal(record.schema, 'spawn-roles@1');
  assert.deepEqual(Object.keys(record), [
    'schema',
    'site',
    'question',
    'request_id',
    'state_revision',
    'targets',
    'reason',
    'provider_request_id',
  ]);
  for (const t of record.targets) assert.deepEqual(Object.keys(t), ['ref', 'role', 'top_p', 'confidence']);
  for (const k of ['status', 'accepted', 'fallback_used', 'grant', 'scope', 'approval', 'provider'])
    assert.ok(!Object.hasOwn(record, k));
  assert.ok(!JSON.stringify(record).includes('CANARY'));
});

test('P5b-4 role admission at the provisional floor; every target needs a role, confidence and top_p', async () => {
  const mod: any = await roles();
  const { SITE_POLICY } = await import('../src/sites/index.js');
  const { digest } = await import('../src/digest.js');
  assert.ok(Object.isFrozen(mod.SPAWN_ROLES_POLICY));
  assert.deepEqual(mod.SPAWN_ROLES_POLICY, { confidence: 0.75 });
  const target = (i: number, patch: object = {}) => ({
    ref: `t${i}`,
    role: 'edit',
    top_p: 0.9,
    confidence: 0.9,
    ...patch,
  });
  const observation = (targets: object[], reason = 'answered') => ({
    schema: 'spawn-roles@1',
    site: 'spawn.roles',
    question: mod.SPAWN_ROLES_QUESTION,
    request_id: 'd1:roles',
    state_revision: 1,
    targets,
    reason,
    provider_request_id: null,
  });
  const reasons = [
    'no_answer',
    'invalid_answer',
    'stale_answer',
    'mismatched_answer',
    'decision_unavailable',
    'cancelled',
  ];
  const table: [string, object, boolean][] = [
    ['all above the floor with top_p', observation([target(0), target(1, { role: 'read' }), target(2)]), true],
    ['exactly the floor', observation([target(0, { confidence: 0.75 }), target(1)]), true],
    ['one target just below', observation([target(0), target(1, { confidence: 0.7499 })]), false],
    ['one null top_p', observation([target(0), target(1, { top_p: null })]), false],
    ['one null confidence', observation([target(0, { confidence: null }), target(1)]), false],
    ['one null role', observation([target(0, { role: null }), target(1)]), false],
    ['no targets', observation([]), false],
    ...reasons.map((reason): [string, object, boolean] => [reason, observation([target(0), target(1)], reason), false]),
  ];
  for (const [name, value, expected] of table) {
    const before = structuredClone(value);
    assert.equal(mod.rolesAdmitted(value), expected, name);
    assert.deepEqual(value, before, name);
  }
  // Pre-P5b snapshot (stableStringify sha256): the floor is not a SITE_POLICY entry.
  assert.equal(digest(SITE_POLICY), 'd374d97156a6863ebfe998487bc4c341c89db9f67f0ecd35c18f1809e7e4cb49');
});
