/**
 * Inference gateway behaviour: routing, bounded attempts, accounting, and the
 * explicit outcomes that stand in for implicit permission (ARCHITECTURE.md §6).
 *
 * Deterministic and offline. Both provider ports are filled by scripted fakes;
 * the live Vercel AI Gateway adapters are exercised by `examples/`, not here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createInferenceGateway,
  route,
  type AttemptRecord,
  type Clock,
  type EvaluationAdapter,
  type EvaluationProviderResult,
  type EvaluationRequest,
  type GenerationAdapter,
  type GenerationProviderResult,
  type GenerationRequest,
  type RoutedUnit,
  type Timer,
} from '@weave/gateway';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type GenerateUnit = Extract<RoutedUnit, { operation: 'generate' }>;
type EvaluateUnit = Extract<RoutedUnit, { operation: 'evaluate' }>;

/** Ticks once per reading, so attempt timestamps are ordered and injected. */
function fakeClock(start = 100): Clock {
  let t = start;
  return { now: () => t++ };
}

/** The same, but time can also be pushed forward by something other than reading it. */
function advanceableClock(start = 100): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t++,
    advance(ms: number) {
      t += ms;
    },
  };
}

/**
 * Records what it was asked to wait and moves the clock by that much, so a
 * wait costs deadline in the tests exactly as it does in production.
 */
function fakeTimer(clock: { advance(ms: number): void }): Timer & { waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    async sleep(ms: number) {
      waits.push(ms);
      clock.advance(ms);
    },
  };
}

function scriptedAdapter(
  id: string,
  script: readonly GenerationProviderResult[],
): GenerationAdapter & { calls: number } {
  let calls = 0;
  const adapter = {
    id,
    get calls() {
      return calls;
    },
    async execute(): Promise<GenerationProviderResult> {
      const result = script[Math.min(calls, script.length - 1)];
      calls += 1;
      assert.ok(result, 'scripted adapter ran out of results');
      return result;
    },
  };
  return adapter as GenerationAdapter & { calls: number };
}

function scriptedEvaluator(
  id: string,
  script: readonly EvaluationProviderResult[],
): EvaluationAdapter & { calls: number } {
  let calls = 0;
  const adapter = {
    id,
    get calls() {
      return calls;
    },
    async evaluate(): Promise<EvaluationProviderResult> {
      const result = script[Math.min(calls, script.length - 1)];
      calls += 1;
      assert.ok(result, 'scripted evaluator ran out of results');
      return result;
    },
  };
  return adapter as EvaluationAdapter & { calls: number };
}

function completed(text: string, input = 1_000, output = 500): GenerationProviderResult {
  return {
    status: 'completed',
    text,
    usage: { input_tokens: input, output_tokens: output },
    finish_reason: 'stop',
    provider_response_id: 'resp_1',
  };
}

function scored(score: number, confidence?: Record<string, number>): EvaluationProviderResult {
  return {
    status: 'completed',
    answers: { priority: { type: 'score', score, probabilities: { '0': 0.1, '1': 0.6, '2': 0.3 } } },
    usage: { input_tokens: 300, output_tokens: 30 },
    provider_response_id: 'gen_1',
    confidence,
  };
}

function failed(
  code: 'rate_limited' | 'unauthorized' | 'unavailable',
  retryable: boolean,
  retryAfterMs?: number,
): GenerationProviderResult {
  return {
    status: 'failed',
    failure: {
      code,
      message: code,
      retryable,
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
    },
  };
}

const PERMITTED = 'test-destination';

const UNIT_DEFAULTS = {
  context_profile: 'profile.test',
  context_profile_version: 1,
  prompt_template: 'template.test',
  prompt_template_version: 1,
  adapter: 'fake',
  model: 'fake/model',
  settings: { max_output_tokens: 1_000 },
  destination: PERMITTED,
  quality: 'baseline',
  context_limit_tokens: 100_000,
  // 1 micro per Mtok in and out: a 1k/500 attempt costs 0.0015 micros.
  price: { input_per_mtok: 1, output_per_mtok: 1 },
} as const;

function unit(
  overrides: Partial<Omit<GenerateUnit, 'operation'>> & Pick<GenerateUnit, 'routed_unit_id'>,
): GenerateUnit {
  return { ...UNIT_DEFAULTS, kind: 'transform', ...overrides, operation: 'generate' };
}

function evalUnit(
  overrides: Partial<Omit<EvaluateUnit, 'operation'>> & Pick<EvaluateUnit, 'routed_unit_id'>,
): EvaluateUnit {
  return { ...UNIT_DEFAULTS, kind: 'score', adapter: 'jev', ...overrides, operation: 'evaluate' };
}

const TERMS = {
  quality: 'baseline',
  destinations: [PERMITTED],
  max_context_tokens: 10_000,
  deadline: 10_000,
  cost_ceiling: 1_000,
  max_attempts: 3,
} as const;

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    request_id: 'req_1',
    site: 'test.site',
    role: 'working',
    kind: 'transform',
    input: { instructions: 'be brief', prompt: 'a prompt' },
    terms: TERMS,
    ...overrides,
  };
}

function scoreRequest(overrides: Partial<EvaluationRequest<'score'>> = {}): EvaluationRequest<'score'> {
  return {
    request_id: 'req_eval_1',
    site: 'test.site',
    role: 'working',
    kind: 'score',
    state: { candidate: 'publish the draft' },
    questions: {
      priority: {
        type: 'score',
        instructions: 'How urgent is this candidate?',
        criteria: ['not urgent', 'soon', 'immediately'],
      },
    },
    terms: TERMS,
    ...overrides,
  };
}

function attemptAt(attempts: readonly AttemptRecord[], index: number): AttemptRecord {
  const record = attempts[index];
  assert.ok(record, `expected attempt ${index}`);
  return record;
}

// ---------------------------------------------------------------------------

describe('routing', () => {
  const table = [unit({ routed_unit_id: 'a' }), unit({ routed_unit_id: 'b' })];

  it('excludes routes by operation, kind, destination, quality, context limit and price', () => {
    const decision = route(
      [
        evalUnit({ routed_unit_id: 'wrong-operation' }),
        unit({ routed_unit_id: 'wrong-kind', kind: 'judge' }),
        unit({ routed_unit_id: 'wrong-destination', destination: 'elsewhere' }),
        unit({ routed_unit_id: 'too-cheap', quality: 'baseline' }),
        unit({ routed_unit_id: 'too-small', quality: 'high', context_limit_tokens: 10 }),
        unit({ routed_unit_id: 'too-dear', quality: 'high', price: { input_per_mtok: 1e9, output_per_mtok: 1e9 } }),
        unit({ routed_unit_id: 'ok', quality: 'high' }),
      ],
      { operation: 'generate', kind: 'transform' },
      { ...TERMS, quality: 'high' },
      20,
    );

    assert.deepEqual(
      decision.order.map((u) => u.routed_unit_id),
      ['ok'],
    );
    assert.deepEqual(decision.excluded, [
      { routed_unit_id: 'wrong-operation', reason: 'operation_mismatch' },
      { routed_unit_id: 'wrong-kind', reason: 'kind_mismatch' },
      { routed_unit_id: 'wrong-destination', reason: 'destination_not_permitted' },
      { routed_unit_id: 'too-cheap', reason: 'quality_below_bar' },
      { routed_unit_id: 'too-small', reason: 'context_limit_too_small' },
      { routed_unit_id: 'too-dear', reason: 'unaffordable' },
    ]);
  });

  it('separates evaluation routes by answer shape', () => {
    const table = [
      evalUnit({ routed_unit_id: 'scorer', kind: 'score' }),
      evalUnit({ routed_unit_id: 'chooser', kind: 'choice' }),
      evalUnit({ routed_unit_id: 'asker', kind: 'boolean' }),
    ];
    for (const kind of ['score', 'choice', 'boolean'] as const) {
      const decision = route(table, { operation: 'evaluate', kind }, TERMS, 20);
      assert.equal(decision.order.length, 1, `exactly one route serves ${kind}`);
      assert.equal(decision.order[0]?.kind, kind);
    }
  });

  it('keeps the configured order and records uncertainty without enough evidence', () => {
    const decision = route(table, { operation: 'generate', kind: 'transform' }, TERMS, 20);
    assert.deepEqual(
      decision.order.map((u) => u.routed_unit_id),
      ['a', 'b'],
    );
    assert.equal(decision.uncertainty.length, 1);
    assert.match(decision.uncertainty[0] ?? '', /no evaluation evidence for a, b/);
  });

  it('orders evidenced routes by expected total cost ahead of unevidenced ones', () => {
    const decision = route(
      [
        unit({ routed_unit_id: 'unevidenced' }),
        unit({ routed_unit_id: 'flaky', evidence: { attempts: 100, accepted: 20 } }),
        unit({ routed_unit_id: 'reliable', evidence: { attempts: 100, accepted: 95 } }),
      ],
      { operation: 'generate', kind: 'transform' },
      TERMS,
      20,
    );
    assert.deepEqual(
      decision.order.map((u) => u.routed_unit_id),
      ['reliable', 'flaky', 'unevidenced'],
    );
  });
});

describe('gateway attempts and accounting', () => {
  it('rejects a route table naming an unknown adapter at construction', () => {
    assert.throws(
      () =>
        createInferenceGateway({
          routes: [unit({ routed_unit_id: 'a', adapter: 'missing' })],
          adapters: [scriptedAdapter('fake', [completed('x')])],
          clock: fakeClock(),
        }),
      /unknown generate adapter 'missing'/,
    );
  });

  it('will not let an evaluation route name a text adapter', () => {
    assert.throws(
      () =>
        createInferenceGateway({
          routes: [evalUnit({ routed_unit_id: 'a', adapter: 'fake' })],
          adapters: [scriptedAdapter('fake', [completed('x')])],
          clock: fakeClock(),
        }),
      /unknown evaluate adapter 'fake'/,
    );
  });

  it('accepts the first response that clears the acceptance check', async () => {
    const adapter = scriptedAdapter('fake', [completed('a holiday')]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a' })],
      adapters: [adapter],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    assert.equal(outcome.status === 'accepted' ? outcome.text : '', 'a holiday');
    assert.equal(outcome.attempts.length, 1);
    assert.deepEqual(attemptAt(outcome.attempts, 0).disposition, { status: 'accepted' });
    // 1000 in + 500 out at 1 micro/Mtok.
    assert.equal(outcome.spent, 0.0015);
    assert.equal(outcome.attempts[0]?.cost_is_upper_bound, false);
  });

  it('charges every attempt, accepted or not, and escalates on an unaccepted response', async () => {
    const first = scriptedAdapter('one', [completed('  ')]);
    const second = scriptedAdapter('two', [completed('a real answer')]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' }), unit({ routed_unit_id: 'b', adapter: 'two' })],
      adapters: [first, second],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : '', 'b');
    assert.equal(outcome.attempts.length, 2);
    assert.deepEqual(attemptAt(outcome.attempts, 0).disposition, { status: 'unaccepted', reason: 'empty_text' });
    assert.equal(first.calls, 1, 'an unaccepted response escalates rather than retrying the same route');
    assert.equal(outcome.spent, 0.003);
  });

  it('retries the same routed unit on a retryable failure and escalates otherwise', async () => {
    const flaky = scriptedAdapter('one', [failed('rate_limited', true), completed('answer')]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' })],
      adapters: [flaky],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(request());
    assert.equal(outcome.status, 'accepted');
    assert.equal(outcome.attempts.length, 2);
    assert.equal(attemptAt(outcome.attempts, 0).disposition.status, 'failed');

    const hard = scriptedAdapter('one', [failed('unauthorized', false), completed('never reached')]);
    const escalating = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' })],
      adapters: [hard],
      clock: fakeClock(),
    });

    const blocked = await escalating.generate(request());
    assert.equal(blocked.status, 'unaccepted');
    assert.equal(blocked.status === 'unaccepted' ? blocked.reason : '', 'provider_failed');
    assert.equal(hard.calls, 1, 'a non-retryable failure does not retry the same route');
  });

  it('escalates once a routed unit has had its share, so a fallback is reachable', async () => {
    // A rate limit is retryable, and without a per-route bound the first route
    // would spend the whole budget retrying and the fallback would never run.
    const primary = scriptedAdapter('one', [failed('rate_limited', true)]);
    const fallback = scriptedAdapter('two', [completed('from the fallback')]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' }), unit({ routed_unit_id: 'b', adapter: 'two' })],
      adapters: [primary, fallback],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    assert.equal(outcome.status === 'accepted' ? outcome.routed_unit_id : '', 'b');
    assert.equal(primary.calls, 2, 'the default bound is one retry');
    assert.equal(fallback.calls, 1);
    assert.equal(outcome.attempts.length, 3, 'every attempt is still recorded');
  });

  it('honours a caller-set max_attempts_per_route', async () => {
    const primary = scriptedAdapter('one', [failed('rate_limited', true)]);
    const fallback = scriptedAdapter('two', [completed('from the fallback')]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' }), unit({ routed_unit_id: 'b', adapter: 'two' })],
      adapters: [primary, fallback],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(
      request({ terms: { ...TERMS, max_attempts_per_route: 1 } }),
    );

    assert.equal(outcome.status, 'accepted');
    assert.equal(primary.calls, 1, 'a bound of 1 escalates on the first fault');
    assert.equal(fallback.calls, 1);
  });

  it('blocks a max_attempts_per_route below one', async () => {
    const a = scriptedAdapter('one', [completed('x')]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' })],
      adapters: [a],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(
      request({ terms: { ...TERMS, max_attempts_per_route: 0 } }),
    );

    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'invalid_request');
    assert.equal(a.calls, 0);
  });

  it('stops at max_attempts', async () => {
    const adapter = scriptedAdapter('one', [failed('unavailable', true)]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' })],
      adapters: [adapter],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(request({ terms: { ...TERMS, max_attempts: 2 } }));

    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' ? outcome.reason : '', 'attempts_exhausted');
    assert.equal(outcome.attempts.length, 2);
    assert.equal(adapter.calls, 2);
  });

  it('charges the worst case and records uncertainty when usage is unreported', async () => {
    const adapter = scriptedAdapter('one', [
      {
        status: 'completed',
        text: 'answer',
        usage: { input_tokens: undefined, output_tokens: undefined },
        finish_reason: 'stop',
        provider_response_id: undefined,
      },
    ]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' })],
      adapters: [adapter],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    // 10_000 context + 1_000 output cap, at 1 micro/Mtok each.
    assert.equal(outcome.spent, 0.011);
    assert.equal(attemptAt(outcome.attempts, 0).cost_is_upper_bound, true);
    assert.ok(outcome.uncertainty.some((u) => /usage unreported/.test(u)));
  });

  it('records ordered, injected timestamps for each attempt', async () => {
    const adapter = scriptedAdapter('one', [failed('unavailable', true), completed('answer')]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' })],
      adapters: [adapter],
      clock: fakeClock(100),
    });

    const outcome = await gateway.generate(request());
    const first = attemptAt(outcome.attempts, 0);
    const second = attemptAt(outcome.attempts, 1);
    assert.ok(first.started_at < first.ended_at);
    assert.ok(first.ended_at <= second.started_at);
  });
});

describe('gateway evaluation', () => {
  const routes = [evalUnit({ routed_unit_id: 'jev.score' })];

  it('returns typed answers, provider confidence and metered cost', async () => {
    const evaluator = scriptedEvaluator('jev', [scored(0.68, { priority: 0.28 })]);
    const gateway = createInferenceGateway({ routes, evaluators: [evaluator], clock: fakeClock() });

    const outcome = await gateway.evaluate(scoreRequest());

    assert.equal(outcome.status, 'accepted');
    if (outcome.status !== 'accepted') return;
    assert.equal(outcome.kind, 'score');
    assert.equal(outcome.answers.priority?.score, 0.68);
    assert.deepEqual(outcome.confidence, { priority: 0.28 });
    assert.equal(outcome.routed_unit_id, 'jev.score');
    // 300 in + 30 out at 1 micro/Mtok, on the same accounting as generation.
    assert.equal(outcome.spent, 0.00033);
    assert.deepEqual(attemptAt(outcome.attempts, 0).disposition, { status: 'accepted' });
  });

  it('reports no confidence when the provider publishes none', async () => {
    const gateway = createInferenceGateway({
      routes,
      evaluators: [scriptedEvaluator('jev', [scored(1.2)])],
      clock: fakeClock(),
    });

    const outcome = await gateway.evaluate(scoreRequest());
    assert.equal(outcome.status === 'accepted' ? outcome.confidence : 'missing', undefined);
  });

  it('blocks a question set that does not match the declared shape', async () => {
    const evaluator = scriptedEvaluator('jev', [scored(1)]);
    const gateway = createInferenceGateway({ routes, evaluators: [evaluator], clock: fakeClock() });

    const outcome = await gateway.evaluate(
      scoreRequest({
        // A boolean question cannot ride along in a score request: the route
        // was selected for one shape and the answers must all be that shape.
        questions: {
          priority: { type: 'boolean', instructions: 'urgent?' },
        } as unknown as EvaluationRequest<'score'>['questions'],
      }),
    );

    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'invalid_request');
    assert.equal(evaluator.calls, 0, 'an invalid request never reaches a provider');
    assert.ok(outcome.uncertainty.some((u) => /boolean question in a score request/.test(u)));
  });

  it('blocks an empty state before paying to judge nothing', async () => {
    const evaluator = scriptedEvaluator('jev', [scored(0)]);
    const gateway = createInferenceGateway({ routes, evaluators: [evaluator], clock: fakeClock() });

    const outcome = await gateway.evaluate(scoreRequest({ state: '   ' }));

    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'invalid_request');
    assert.equal(evaluator.calls, 0);
    assert.equal(outcome.spent, 0);
  });

  it('blocks a score question with fewer than two levels', async () => {
    const evaluator = scriptedEvaluator('jev', [scored(0)]);
    const gateway = createInferenceGateway({ routes, evaluators: [evaluator], clock: fakeClock() });

    const outcome = await gateway.evaluate(
      scoreRequest({
        questions: { priority: { type: 'score', instructions: 'how urgent?', criteria: ['only one'] } },
      }),
    );

    assert.equal(outcome.status, 'blocked');
    assert.equal(evaluator.calls, 0);
  });

  it('treats an unanswered question as a malformed response, charged and recorded', async () => {
    const evaluator = scriptedEvaluator('jev', [
      {
        status: 'completed',
        answers: {},
        usage: { input_tokens: 300, output_tokens: 30 },
        provider_response_id: 'gen_1',
        confidence: undefined,
      },
    ]);
    const gateway = createInferenceGateway({ routes, evaluators: [evaluator], clock: fakeClock() });

    const outcome = await gateway.evaluate(scoreRequest());

    assert.notEqual(outcome.status, 'accepted');
    assert.deepEqual(attemptAt(outcome.attempts, 0).disposition, {
      status: 'unaccepted',
      reason: 'unanswered_question:priority',
    });
    assert.equal(outcome.spent, 0.00033, 'a malformed response is still charged');
  });

  it('will not route a boolean request to a score route', async () => {
    const evaluator = scriptedEvaluator('jev', [scored(1)]);
    const gateway = createInferenceGateway({ routes, evaluators: [evaluator], clock: fakeClock() });

    const outcome = await gateway.evaluate({
      request_id: 'req_eval_2',
      site: 'test.site',
      role: 'working',
      kind: 'boolean',
      state: { candidate: 'publish the draft' },
      questions: { advances: { type: 'boolean', instructions: 'Does this advance the goal?' } },
      terms: TERMS,
    });

    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'no_route');
    assert.equal(evaluator.calls, 0);
  });

  it('honours a caller acceptance check over the answers', async () => {
    const evaluator = scriptedEvaluator('jev', [scored(0.68, { priority: 0.28 })]);
    const gateway = createInferenceGateway({ routes, evaluators: [evaluator], clock: fakeClock() });

    const outcome = await gateway.evaluate(
      scoreRequest({
        // The decision layer may refuse a weight it cannot act on.
        accept: (answers) =>
          (answers.priority?.score ?? 0) >= 1
            ? { status: 'accepted' }
            : { status: 'rejected', reason: 'below_action_threshold' },
      }),
    );

    assert.notEqual(outcome.status, 'accepted');
    assert.deepEqual(attemptAt(outcome.attempts, 0).disposition, {
      status: 'unaccepted',
      reason: 'below_action_threshold',
    });
  });
});

describe('gateway explicit refusals', () => {
  const adapter = () => scriptedAdapter('one', [completed('answer')]);
  const routes = [unit({ routed_unit_id: 'a', adapter: 'one' })];

  it('blocks rather than downgrading when no route serves the terms', async () => {
    const gateway = createInferenceGateway({ routes, adapters: [adapter()], clock: fakeClock() });
    const outcome = await gateway.generate(request({ terms: { ...TERMS, quality: 'high' } }));

    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'no_route');
    assert.equal(outcome.attempts.length, 0);
    assert.equal(outcome.spent, 0);
  });

  it('blocks on no budget rather than executing a cheaper unapproved route', async () => {
    const gateway = createInferenceGateway({ routes, adapters: [adapter()], clock: fakeClock() });
    const outcome = await gateway.generate(request({ terms: { ...TERMS, cost_ceiling: 0 } }));

    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'no_budget');
    assert.equal(outcome.attempts.length, 0);
  });

  it('blocks a request whose deadline has already passed', async () => {
    const gateway = createInferenceGateway({ routes, adapters: [adapter()], clock: fakeClock(10_000) });
    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'deadline_passed');
  });

  it('blocks an invalid request before any provider call', async () => {
    const a = adapter();
    const gateway = createInferenceGateway({ routes, adapters: [a], clock: fakeClock() });
    const outcome = await gateway.generate(request({ terms: { ...TERMS, max_attempts: 0 } }));

    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' ? outcome.reason : '', 'invalid_request');
    assert.equal(a.calls, 0);
  });

  it('honours a caller acceptance check it may not relax', async () => {
    const a = scriptedAdapter('one', [completed('plain prose')]);
    const gateway = createInferenceGateway({
      routes: [unit({ routed_unit_id: 'a', adapter: 'one' })],
      adapters: [a],
      clock: fakeClock(),
    });

    const outcome = await gateway.generate(
      request({
        accept: (text) =>
          text.startsWith('{') ? { status: 'accepted' } : { status: 'rejected', reason: 'not_json' },
      }),
    );

    assert.notEqual(outcome.status, 'accepted');
    assert.equal(attemptAt(outcome.attempts, 0).disposition.status, 'unaccepted');
  });
});

// ---------------------------------------------------------------------------

describe('gateway waiting out a rate limit', () => {
  /** 20 requests a minute implies 3s of even spacing between them. */
  const PER_MINUTE = [{ requests: 20, window_ms: 60_000 }] as const;

  function throttled(routes: readonly RoutedUnit[], script: readonly GenerationProviderResult[]) {
    const clock = advanceableClock();
    const timer = fakeTimer(clock);
    const primary = scriptedAdapter('fake', script);
    const fallback = scriptedAdapter('fallback', [completed('from the fallback')]);
    return { clock, timer, primary, fallback, routes };
  }

  it('waits the spacing its declared limit implies, then succeeds on the same route', async () => {
    const f = throttled([unit({ routed_unit_id: 'primary', rate_limits: PER_MINUTE })], [
      failed('rate_limited', true),
      completed('answered after the wait'),
    ]);
    const gateway = createInferenceGateway({
      routes: f.routes,
      adapters: [f.primary],
      clock: f.clock,
      timer: f.timer,
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    assert.deepEqual(f.timer.waits, [3_000]);
    assert.equal(f.primary.calls, 2);
    // The wait belongs to the attempt it preceded, and only to that one.
    assert.equal(attemptAt(outcome.attempts, 0).waited_ms, undefined);
    assert.equal(attemptAt(outcome.attempts, 1).waited_ms, 3_000);
  });

  it('prefers the delay the provider stated over the one the route declares', async () => {
    const f = throttled([unit({ routed_unit_id: 'primary', rate_limits: PER_MINUTE })], [
      failed('rate_limited', true, 500),
      completed('answered after the stated wait'),
    ]);
    const gateway = createInferenceGateway({
      routes: f.routes,
      adapters: [f.primary],
      clock: f.clock,
      timer: f.timer,
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    assert.deepEqual(f.timer.waits, [500]);
  });

  it('escalates rather than waiting when no timer was configured', async () => {
    const f = throttled(
      [
        unit({ routed_unit_id: 'primary', rate_limits: PER_MINUTE }),
        unit({ routed_unit_id: 'fallback', adapter: 'fallback' }),
      ],
      [failed('rate_limited', true)],
    );
    const gateway = createInferenceGateway({
      routes: f.routes,
      adapters: [f.primary, f.fallback],
      clock: f.clock,
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    assert.ok(outcome.status === 'accepted');
    assert.equal(outcome.routed_unit_id, 'fallback');
    // One refusal, then away: without a timer a second immediate ask is waste.
    assert.equal(f.primary.calls, 1);
    assert.ok(outcome.uncertainty.some((u) => u.includes('no timer is configured')));
  });

  it('escalates rather than waiting past the caller\'s deadline', async () => {
    const f = throttled(
      [
        unit({ routed_unit_id: 'primary', rate_limits: PER_MINUTE }),
        unit({ routed_unit_id: 'fallback', adapter: 'fallback' }),
      ],
      [failed('rate_limited', true)],
    );
    const gateway = createInferenceGateway({
      routes: f.routes,
      adapters: [f.primary, f.fallback],
      clock: f.clock,
      timer: f.timer,
    });

    // The clock starts at 100 and a 3s wait would land well past this.
    const outcome = await gateway.generate(request({ terms: { ...TERMS, deadline: 1_000 } }));

    assert.equal(outcome.status, 'accepted');
    assert.ok(outcome.status === 'accepted');
    assert.equal(outcome.routed_unit_id, 'fallback');
    assert.deepEqual(f.timer.waits, []);
    assert.ok(outcome.uncertainty.some((u) => u.includes('would pass the deadline')));
  });

  it('retries a transient fault at once, since a rate limit is the only thing worth waiting on', async () => {
    const f = throttled([unit({ routed_unit_id: 'primary', rate_limits: PER_MINUTE })], [
      failed('unavailable', true),
      completed('recovered'),
    ]);
    const gateway = createInferenceGateway({
      routes: f.routes,
      adapters: [f.primary],
      clock: f.clock,
      timer: f.timer,
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    assert.equal(f.primary.calls, 2);
    // A request quota says nothing about how long a 503 lasts.
    assert.deepEqual(f.timer.waits, []);
  });

  it('retries a rate limit at once when neither the route nor the provider names a delay', async () => {
    const f = throttled([unit({ routed_unit_id: 'primary' })], [
      failed('rate_limited', true),
      completed('unthrottled'),
    ]);
    const gateway = createInferenceGateway({
      routes: f.routes,
      adapters: [f.primary],
      clock: f.clock,
      timer: f.timer,
    });

    const outcome = await gateway.generate(request());

    assert.equal(outcome.status, 'accepted');
    assert.equal(f.primary.calls, 2);
    assert.deepEqual(f.timer.waits, []);
  });

  it('counts a wait against the deadline rather than against the attempt budget', async () => {
    const f = throttled([unit({ routed_unit_id: 'primary', rate_limits: PER_MINUTE })], [
      failed('rate_limited', true, 4_000),
      failed('rate_limited', true, 4_000),
      completed('never reached'),
    ]);
    const gateway = createInferenceGateway({
      routes: f.routes,
      adapters: [f.primary],
      clock: f.clock,
      timer: f.timer,
    });

    // Room for three attempts, but the clock starts near 100 and the deadline
    // is 6s out: the first 4s wait fits, and the second cannot.
    const outcome = await gateway.generate(
      request({ terms: { ...TERMS, max_attempts: 3, deadline: 6_000 } }),
    );

    assert.equal(outcome.status, 'unaccepted');
    assert.deepEqual(f.timer.waits, [4_000]);
    assert.equal(f.primary.calls, 2);
    assert.equal(attemptAt(outcome.attempts, 1).waited_ms, 4_000);
    assert.ok(outcome.uncertainty.some((u) => u.includes('would pass the deadline')));
  });
});
