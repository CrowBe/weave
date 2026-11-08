import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvaluationRequest, InferenceGateway } from '@weave/gateway';
import {
  DECIDE1_SHADOW_JUDGMENTS,
  DECIDE1_SHADOW_QUESTIONS,
  askShadow,
  transitionShadow,
  type RecordedShadowAnswer,
  type ShadowAsk,
  type ShadowReason,
} from '../src/sites/decide1-shadow.js';

const current = { state_revision: 1, state_updated_at: 10, observed_at: 10 };
function ask(): ShadowAsk {
  return {
    ...current,
    request_id: 'decision-1',
    state: { request: 'CANARY-msg', context: 'CANARY-ctx CANARY-summary' },
    terms: {
      quality: 'baseline',
      tier: 'strong',
      destinations: ['local'],
      max_context_tokens: 100,
      deadline: 100,
      cost_ceiling: 10,
      max_attempts: 2,
    },
  };
}
function answer(request_id = 'decision-1:shadow.clarify', site = 'decide1.clarify') {
  return {
    status: 'accepted' as const,
    kind: 'boolean' as const,
    request_id,
    site,
    answers: { decision: { type: 'boolean' as const, probability: 0.7 } },
    confidence: { decision: 0.8 },
    provider_response_id: 'response-1',
    routed_unit_id: 'fixture',
    attempts: [],
    spent: 0,
    uncertainty: ['CANARY-provider'],
  };
}
function port(
  fn: (request: EvaluationRequest, signal?: AbortSignal) => Promise<unknown>,
): Pick<InferenceGateway, 'evaluate'> {
  return { evaluate: fn as InferenceGateway['evaluate'] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('P4b-4 shadow requests start together, isolate one fixed boolean question, and capture caller state', async () => {
  const input = ask();
  const before = structuredClone(input);
  const requests: EvaluationRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const pending = DECIDE1_SHADOW_JUDGMENTS.map(() => deferred<unknown>());
  const controller = new AbortController();
  const result = askShadow(
    input,
    port(async (request, signal) => {
      requests.push(request);
      signals.push(signal);
      return pending[requests.length - 1]!.promise;
    }),
    () => current,
    controller.signal,
  );
  assert.equal(requests.length, 4, 'all four calls start before any resolves');
  for (const [i, judgment] of DECIDE1_SHADOW_JUDGMENTS.entries()) {
    const request = requests[i]!;
    assert.deepEqual(request, {
      request_id: `${before.request_id}:shadow.${judgment}`,
      site: `decide1.${judgment}`,
      role: 'working',
      kind: 'boolean',
      state: before.state,
      questions: { decision: { type: 'boolean', instructions: DECIDE1_SHADOW_QUESTIONS[judgment] } },
      terms: { ...before.terms, destinations: [...before.terms.destinations], tier: 'decision' },
    });
    for (const other of DECIDE1_SHADOW_JUDGMENTS.filter((value) => value !== judgment)) {
      assert.ok(!String(request.questions['decision']!.instructions).includes(DECIDE1_SHADOW_QUESTIONS[other]));
    }
    assert.equal(signals[i], controller.signal);
  }
  const mutable = input as unknown as {
    request_id: string;
    state: { request: string; context: string };
    terms: { destinations: string[]; deadline: number };
  };
  mutable.request_id = 'changed';
  mutable.state.request = 'changed';
  mutable.state.context = 'changed';
  mutable.terms.destinations.push('changed');
  mutable.terms.deadline = 0;
  assert.ok(requests.every((request) => JSON.stringify(request.state) === JSON.stringify(before.state)));
  assert.ok(
    requests.every(
      (request) => JSON.stringify(request.terms) === JSON.stringify({ ...before.terms, tier: 'decision' }),
    ),
  );
  for (const i of [3, 1, 2, 0]) pending[i]!.resolve(answer(requests[i]!.request_id, requests[i]!.site));
  const observations = await result;
  assert.deepEqual(
    observations.map((value) => value.site),
    DECIDE1_SHADOW_JUDGMENTS.map((value) => `decide1.${value}`),
  );
  assert.ok(observations.every((value) => value.reason === 'answered'));
  assert.deepEqual(DECIDE1_SHADOW_JUDGMENTS, ['clarify', 'multi_deliverable', 'reads_before_gen', 'veto_bare_gen']);
  assert.deepEqual(DECIDE1_SHADOW_QUESTIONS, {
    clarify: 'Does this request need clarification that only the requester can give before work starts?',
    multi_deliverable: 'Does this request ask for more than one separate deliverable?',
    reads_before_gen: 'Must existing files or artifacts be read before anything can be generated for this request?',
    veto_bare_gen: 'Would one generation call, without prior reads or decomposition, likely fail this request?',
  });
  assert.ok(Object.isFrozen(DECIDE1_SHADOW_JUDGMENTS));
  assert.ok(Object.isFrozen(DECIDE1_SHADOW_QUESTIONS));
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await askShadow(
    ask(),
    port(async () => assert.fail('already aborted calls no port')),
    () => current,
    aborted.signal,
  );
  assert.deepEqual(
    cancelled.map((value) => value.reason),
    Array(4).fill('cancelled'),
  );
});

test('P4b-5 admission keeps p(true) only for answered observations and isolates every failure', async () => {
  const good = answer();
  const base = { state_revision: 1, observed_at: 10, outcome: good };
  const cases: {
    label: string;
    recorded: unknown;
    now?: typeof current;
    reason: ShadowReason;
    confidence?: number | null;
  }[] = [
    { label: 'answer', recorded: base, reason: 'answered', confidence: 0.8 },
    {
      label: 'missing confidence',
      recorded: { ...base, outcome: { ...good, confidence: undefined } },
      reason: 'answered',
      confidence: null,
    },
    ...[-1, 2, NaN, Infinity].map((confidence) => ({
      label: `confidence ${confidence}`,
      recorded: { ...base, outcome: { ...good, confidence: { decision: confidence } } },
      reason: 'answered' as const,
      confidence: null,
    })),
    { label: 'foreign kind', recorded: { ...base, outcome: { ...good, kind: 'choice' } }, reason: 'invalid_answer' },
    { label: 'missing key', recorded: { ...base, outcome: { ...good, answers: {} } }, reason: 'invalid_answer' },
    {
      label: 'foreign answer kind',
      recorded: { ...base, outcome: { ...good, answers: { decision: { type: 'choice', choice: 'yes' } } } },
      reason: 'invalid_answer',
    },
    ...[-1, 2, NaN, Infinity].map((probability) => ({
      label: `probability ${probability}`,
      recorded: { ...base, outcome: { ...good, answers: { decision: { type: 'boolean', probability } } } },
      reason: 'invalid_answer' as const,
    })),
    {
      label: 'refusal',
      recorded: { ...base, outcome: { ...good, status: 'blocked', reason: 'invalid_request' } },
      reason: 'no_answer',
    },
    { label: 'null', recorded: { ...base, outcome: null }, reason: 'decision_unavailable' },
    { label: 'paused', recorded: { ...base, outcome: { ...good, paused: {} } }, reason: 'decision_unavailable' },
    ...['provider_unavailable', 'no_route', 'no_budget', 'quota_unknown', 'weekly_budget_cap'].map((reason) => ({
      label: reason,
      recorded: { ...base, outcome: { ...good, status: 'blocked', reason } },
      reason: 'decision_unavailable' as const,
    })),
    {
      label: 'budget',
      recorded: { ...base, outcome: { ...good, status: 'unaccepted', reason: 'budget_exhausted' } },
      reason: 'decision_unavailable',
    },
    {
      label: 'foreign request',
      recorded: { ...base, outcome: { ...good, request_id: 'other' } },
      reason: 'mismatched_answer',
    },
    { label: 'foreign site', recorded: { ...base, outcome: { ...good, site: 'other' } }, reason: 'mismatched_answer' },
    { label: 'moved revision', recorded: base, now: { ...current, state_revision: 2 }, reason: 'stale_answer' },
    { label: 'old observation', recorded: { ...base, observed_at: 9 }, reason: 'stale_answer' },
    {
      label: 'cancelled first',
      recorded: { ...base, cancelled: true, outcome: null },
      now: { ...current, state_revision: 2 },
      reason: 'cancelled',
    },
  ];
  for (const item of cases) {
    const observation = transitionShadow('clarify', ask(), item.recorded as RecordedShadowAnswer, item.now ?? current);
    assert.equal(observation.reason, item.reason, item.label);
    assert.equal(observation.probability, item.reason === 'answered' ? 0.7 : null, item.label);
    assert.equal(observation.confidence, item.reason === 'answered' ? item.confidence : null, item.label);
  }
  for (const probability of [0, 1]) {
    assert.equal(
      transitionShadow(
        'clarify',
        ask(),
        { ...base, outcome: { ...good, answers: { decision: { type: 'boolean', probability } } } },
        current,
      ).probability,
      probability,
    );
  }
  const isolated = await askShadow(
    ask(),
    port(async (request) => {
      if (request.site === 'decide1.multi_deliverable') throw new Error('CANARY-error');
      return answer(request.request_id, request.site);
    }),
    () => current,
  );
  assert.deepEqual(
    isolated.map((value) => value.reason),
    ['answered', 'decision_unavailable', 'answered', 'answered'],
  );
  const controller = new AbortController();
  const aborted = await askShadow(
    ask(),
    port(async (request) => {
      controller.abort();
      return answer(request.request_id, request.site);
    }),
    () => current,
    controller.signal,
  );
  assert.ok(aborted.every((value) => value.reason === 'cancelled'));
});

test('P4b-6 observations have the exact non-authoritative record shape and copy no disclosed or provider text', () => {
  const outcome = {
    ...answer(),
    answers: { ...answer().answers, unknown: { type: 'boolean' as const, probability: 1, text: 'CANARY-provider' } },
    provider_response_id: 'Bearer CANARY-provider',
  };
  const record = transitionShadow('clarify', ask(), { state_revision: 1, observed_at: 10, outcome }, current);
  assert.deepEqual(Object.keys(record), [
    'schema',
    'site',
    'question',
    'request_id',
    'state_revision',
    'probability',
    'confidence',
    'reason',
    'provider_request_id',
  ]);
  assert.deepEqual(record, {
    schema: 'decide1-shadow@1',
    site: 'decide1.clarify',
    question: DECIDE1_SHADOW_QUESTIONS.clarify,
    request_id: 'decision-1:shadow.clarify',
    state_revision: 1,
    probability: 0.7,
    confidence: 0.8,
    reason: 'answered',
    provider_request_id: null,
  });
  for (const forbidden of ['status', 'accepted', 'fallback_used', 'grant', 'scope', 'approval', 'provider'])
    assert.ok(!Object.hasOwn(record, forbidden));
  assert.ok(!JSON.stringify(record).includes('CANARY'));
  const invalidId = transitionShadow(
    'clarify',
    { ...ask(), request_id: 'Bearer CANARY-msg' },
    { state_revision: 1, observed_at: 10, outcome: null },
    current,
  );
  assert.equal(invalidId.request_id, null);
});
