/**
 * The direct TypeSafe AI adapter: wire translation and failure classification.
 *
 * Offline. `fetch` is injected, so these assert what the adapter sends and how
 * it reads what comes back — including the `noul` name that TypeSafe uses for a
 * boolean question and this adapter translates away.
 *
 * The response fixtures are copied from a live call, not invented: `LIVE_BODY`
 * from hosted TypeSafe, `KEV_BODY` from a local `kev.serve` on the same
 * endpoint. Kev is a separate implementation of this contract, so it is
 * evidence the adapter is not overfitted to one vendor's serialisation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TYPESAFE_AI_ADAPTER,
  typesafeAiEvaluator,
  typesafeWire,
  type TypesafeAiOptions,
} from '@weave/gateway/typesafe-ai';
import type { EvaluationCall } from '@weave/gateway';
import { evaluationTransport, type DecisionWireProfile } from '../src/adapters/decision-transport.js';

const REQUEST_ID = 'req_01a0b95c113778e992a3fa92749b2dbf';

/** A live response, trimmed to the fields the adapter reads. */
const LIVE_BODY = {
  model: 'jev-1.13.0',
  answers: {
    urgent: { type: 'noul', noul: 0.96 },
    severity: {
      type: 'score',
      score: 2.85,
      confidence: 0.85,
      legend: { '0': 'trivial', '1': 'minor', '2': 'serious', '3': 'critical' },
      probabilities: { '0': 0.0, '1': 0.0, '2': 0.15, '3': 0.85 },
    },
    area: {
      type: 'choice',
      choice: 'payments',
      confidence: 1.0,
      probabilities: { auth: 0.0, payments: 1.0, ui: 0.0 },
    },
  },
  usage: { input_tokens: 408, output_tokens: 67 },
};

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; raw?: string } = {},
): { fetch: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(init.raw ?? JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function options(fetch: typeof globalThis.fetch): TypesafeAiOptions {
  return { apiKey: 'test-key', fetch };
}

const CALL: EvaluationCall = {
  model: 'jev-preview',
  kind: 'boolean',
  state: 'payouts failing for three days',
  questions: {
    urgent: {
      type: 'boolean',
      instructions: 'Does this convey urgency?',
      criteria: { true: 'time-sensitive', false: 'no urgency' },
    },
  },
  signal: undefined,
};

function sentBody(calls: readonly Captured[]): Record<string, unknown> {
  const first = calls[0];
  assert.ok(first, 'expected a request');
  return JSON.parse(String(first.init.body)) as Record<string, unknown>;
}

describe('TypeSafe danger zone headers', () => {
  for (const flags of [{}, { longContext: false, images: false },
    { longContext: true }, { images: true }, { longContext: true, images: true }]) {
    it(`sends only enabled headers on every request: ${JSON.stringify(flags)}`, async () => {
      const { fetch, calls } = stubFetch(LIVE_BODY);
      const adapter = typesafeAiEvaluator({ ...options(fetch), ...flags });
      for (const model of ['jev-1.13.0', 'jev-1.14.0']) {
        await adapter.evaluate({ ...CALL, model });
      }
      assert.equal(calls.length, 2);
      for (const call of calls) {
        const headers = new Headers(call.init.headers);
        assert.equal(headers.get('TypeSafe-Danger-Zone-Long-Context'), flags.longContext ? 'true' : null);
        assert.equal(headers.get('TypeSafe-Danger-Zone-Images'), flags.images ? 'true' : null);
        assert.equal(headers.get('authorization'), 'Bearer test-key');
        assert.equal(headers.get('content-type'), 'application/json');
        assert.deepEqual(Object.keys(JSON.parse(String(call.init.body))).sort(), ['model', 'questions', 'state']);
      }
    });
  }

  it('merges profile headers without overriding credentials or JSON content type in any casing', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    const profile: DecisionWireProfile = {
      ...typesafeWire,
      headers: {
        authorization: 'lowercase credential', Authorization: 'uppercase credential',
        AUTHORIZATION: 'all caps credential', 'content-type': 'text/plain',
        'Content-Type': 'text/html', 'CONTENT-TYPE': 'application/xml',
        'X-Profile-Header': 'allowed',
      },
    };
    await evaluationTransport(profile, {
      credential: 'test-key', defaultBaseURL: 'https://example.test', fetch,
    }).evaluate(CALL);
    const headers = new Headers(calls[0]!.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-key');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-profile-header'), 'allowed');
  });
});

describe('TypeSafe preview hardening', () => {
  it('ignores box and future answer types on unasked ids', async () => {
    const { fetch } = stubFetch({ answers: {
      urgent: { type: 'noul', noul: 0.9 },
      extra: { type: 'box', box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0.8 },
      later: { type: 'future', confidence: 0.7 },
    } });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.deepEqual(result.answers, { urgent: { type: 'boolean', probability: 0.9 } });
    assert.equal(result.confidence, undefined);
  });

  it('reports an unsupported answer type on an asked id as malformed, not unanswered', async () => {
    for (const [id, answers] of [
      ['extra', { urgent: { type: 'noul', noul: 0.9 }, extra: { type: 'box', box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0.8 } }],
      ['urgent', { urgent: { type: 'future' } }],
      ['urgent', { urgent: { type: { toString: null } } }],
    ] as const) {
      const { fetch } = stubFetch({ answers });
      const result = await typesafeAiEvaluator(options(fetch)).evaluate({ ...CALL, questions: { ...CALL.questions, extra: { type: 'boolean', instructions: 'extra?' } } });
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') continue;
      assert.equal(result.failure.code, 'malformed_response');
      assert.equal(result.failure.retryable, false);
      assert.equal(result.failure.message, `answer '${id}' had an unsupported answer type`);
    }
  });

  it('ignores even malformed answers for unasked questions', async () => {
    const { fetch } = stubFetch({ answers: { urgent: { type: 'noul', noul: 0.9 }, extra: { type: 'noul' } } });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.status === 'completed' && result.answers, { urgent: { type: 'boolean', probability: 0.9 } });
  });

  for (const enabled of [false, true]) {
    it(`preserves choice keys with shuffle ${enabled ? 'seeded' : 'disabled'}`, async () => {
      let seed = 0;
      const shuffle = enabled ? () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      } : false;
      const criteria = { auth: 'authentication', payments: 'payments', ui: 'interface' };
      const { fetch, calls } = stubFetch({ answers: { area: {
        type: 'choice', choice: 'payments', probabilities: { ui: 0.1, payments: 0.8, auth: 0.1, unknown: 0.5 },
      } } });
      const result = await typesafeAiEvaluator({ ...options(fetch), shuffle, dataSharing: false }).evaluate({
        ...CALL, kind: 'choice', questions: { area: { type: 'choice', instructions: 'area?', criteria } },
      });
      const body = sentBody(calls);
      assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
      const questions = body['questions'] as Record<string, { criteria: object }>;
      assert.deepEqual(Object.keys(questions['area']!.criteria), shuffle === false ? ['auth', 'payments', 'ui'] : ['payments', 'ui', 'auth']);
      assert.deepEqual(Object.keys(criteria), ['auth', 'payments', 'ui']);
      assert.deepEqual(result.status === 'completed' && result.answers['area'], {
        type: 'choice', choice: 'payments', probabilities: { auth: 0.1, payments: 0.8, ui: 0.1 },
      });
    });
  }

  it('rejects supported answers whose type differs from the asked question', async () => {
    for (const answer of [{ type: 'noul', noul: 0.9 }, { type: 'score', score: 1 }]) {
      const { fetch } = stubFetch({ answers: { area: answer } });
      const result = await typesafeAiEvaluator(options(fetch)).evaluate({
        ...CALL, kind: 'choice', questions: { area: { type: 'choice', instructions: 'area?', criteria: { auth: 'auth' } } },
      });
      assert.equal(result.status === 'failed' && result.failure.code, 'malformed_response');
    }
  });

  it('keeps exported wire choice ordering deterministic', () => {
    const call: EvaluationCall = { ...CALL, questions: {
      area: { type: 'choice', instructions: 'area?', criteria: { auth: 'auth', payments: 'payments', ui: 'ui' } },
    } };
    for (let i = 0; i < 20; i++) {
      const body = typesafeWire.toBody(call) as { questions: { area: { criteria: object } } };
      assert.deepEqual(Object.keys(body.questions.area.criteria), ['auth', 'payments', 'ui']);
    }
  });

  it('clamps invalid injected RNG values without losing choice keys', async () => {
    for (const value of [1, 2, -1, NaN, Infinity, -Infinity]) {
      const { fetch, calls } = stubFetch({ answers: {} });
      await typesafeAiEvaluator({ ...options(fetch), shuffle: () => value }).evaluate({
        ...CALL, questions: { area: { type: 'choice', instructions: 'area?', criteria: { a: 'A', b: 'B', c: 'C' } } },
      });
      const body = sentBody(calls) as { questions: { area: { criteria: object } } };
      assert.deepEqual(Object.entries(body.questions.area.criteria).sort(), [['a', 'A'], ['b', 'B'], ['c', 'C']]);
    }
  });

  it('keeps interleaved calls bound to their own questions', async () => {
    let finishFirst: (() => void) | undefined;
    const firstReady = new Promise<void>(resolve => { finishFirst = resolve; });
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: string };
      if (body.state === 'first') await firstReady;
      else finishFirst!();
      return new Response(JSON.stringify({ answers: {
        area: { type: 'choice', choice: body.state, probabilities: { first: 0.5, second: 0.5 } },
      } }));
    }) as typeof globalThis.fetch;
    const adapter = typesafeAiEvaluator({ ...options(fetch), shuffle: false });
    const results = await Promise.all(['first', 'second'].map(state => adapter.evaluate({
      ...CALL, state, kind: 'choice',
      questions: { area: { type: 'choice', instructions: 'which?', criteria: { [state]: state } } },
    })));
    for (const [index, result] of results.entries()) {
      const key = index === 0 ? 'first' : 'second';
      assert.deepEqual(result.status === 'completed' && result.answers['area'], {
        type: 'choice', choice: key, probabilities: { [key]: 0.5 },
      });
    }
  });

  it('rejects a choice outside the asked keys', async () => {
    const { fetch } = stubFetch({ answers: { area: { type: 'choice', choice: 'unknown' } } });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate({
      ...CALL, kind: 'choice', questions: { area: { type: 'choice', instructions: 'area?', criteria: { auth: 'auth' } } },
    });
    assert.equal(result.status === 'failed' && result.failure.code, 'malformed_response');
  });
});

const ALL_CALL: EvaluationCall = {
  ...CALL,
  questions: {
    ...CALL.questions,
    area: { type: 'choice', instructions: 'area?', criteria: { auth: 'auth', payments: 'payments', ui: 'ui', billing: 'billing', technical: 'technical' } },
    severity: { type: 'score', instructions: 'severity?', criteria: ['trivial', 'minor', 'serious', 'critical'] },
    frustration: { type: 'score', instructions: 'frustration?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
  },
};

describe('typesafe-ai adapter: request', () => {
  it('posts to the System One endpoint with a bearer credential', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY, { headers: { 'x-typesafe-request-id': REQUEST_ID } });
    await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    const first = calls[0];
    assert.ok(first);
    assert.equal(first.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(first.init.method, 'POST');
    assert.equal((first.init.headers as Record<string, string>)['authorization'], 'Bearer test-key');
  });

  it('sends a boolean question as a noul question', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

    const body = sentBody(calls);
    assert.equal(body['model'], 'jev-preview');
    assert.deepEqual(body['questions'], {
      urgent: {
        type: 'noul',
        instructions: 'Does this convey urgency?',
        criteria: { true: 'time-sensitive', false: 'no urgency' },
      },
    });
  });

  it('omits boolean criteria entirely when the caller gave none', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await typesafeAiEvaluator(options(fetch)).evaluate({
      ...CALL,
      questions: { urgent: { type: 'boolean', instructions: 'urgent?' } },
    });

    const questions = sentBody(calls)['questions'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(questions['urgent'], { type: 'noul', instructions: 'urgent?' });
  });

  it('passes choice and score questions through unchanged', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await typesafeAiEvaluator(options(fetch)).evaluate({
      ...CALL,
      kind: 'score',
      questions: { severity: { type: 'score', instructions: 'how bad?', criteria: ['ok', 'bad'] } },
    });

    const questions = sentBody(calls)['questions'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(questions['severity'], {
      type: 'score',
      instructions: 'how bad?',
      criteria: ['ok', 'bad'],
    });
  });
});

describe('typesafe-ai adapter: response', () => {
  it('translates a noul answer back to a boolean probability', async () => {
    const { fetch } = stubFetch(LIVE_BODY, { headers: { 'x-typesafe-request-id': REQUEST_ID } });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.deepEqual(result.answers['urgent'], { type: 'boolean', probability: 0.96 });
    assert.deepEqual(result.usage, { input_tokens: 408, output_tokens: 67 });
    assert.equal(result.provider_response_id, REQUEST_ID);
  });

  it('carries score and choice answers with their probabilities', async () => {
    const { fetch } = stubFetch(LIVE_BODY);
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.deepEqual(result.answers['severity'], {
      type: 'score',
      score: 2.85,
      probabilities: { '0': 0, '1': 0, '2': 0.15, '3': 0.85 },
    });
    assert.deepEqual(result.answers['area'], {
      type: 'choice',
      choice: 'payments',
      probabilities: { auth: 0, payments: 1, ui: 0 },
    });
  });

  it('collects per-answer confidence, and reports none for a noul answer', async () => {
    const { fetch } = stubFetch(LIVE_BODY);
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    // `urgent` is absent: TypeSafe publishes no confidence for a noul answer.
    assert.deepEqual(result.confidence, { severity: 0.85, area: 1.0 });
  });

  it('forwards a published non-number confidence as NaN so a site reads it as invalid, not absent', async () => {
    const { fetch } = stubFetch({ ...LIVE_BODY, answers: {
      ...LIVE_BODY.answers,
      severity: { ...LIVE_BODY.answers.severity, confidence: 'high' },
      area: { ...LIVE_BODY.answers.area, confidence: null },
    } });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    // `urgent` publishes no confidence and stays absent; the published values are kept as invalid.
    assert.deepEqual(result.confidence, { severity: NaN, area: NaN });
    assert.equal(JSON.stringify(result).includes('high'), false);
  });

  it('reports a malformed response rather than inventing an answer', async () => {
    const { fetch } = stubFetch({ answers: { urgent: { type: 'noul' } }, usage: {} });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure.code, 'malformed_response');
    assert.equal(result.failure.retryable, false);
    assert.match(result.failure.message, /answer 'urgent' was not a recognised shape/);
  });

  it('reports a body that is not JSON as malformed', async () => {
    const { fetch } = stubFetch(undefined, { raw: '<html>gateway error</html>' });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);

    assert.equal(result.status === 'failed' && result.failure.code, 'malformed_response');
  });
});

describe('typesafe-ai adapter: failures', () => {
  const cases = [
    { status: 401, code: 'unauthorized', retryable: false },
    { status: 402, code: 'quota_exhausted', retryable: false },
    { status: 422, code: 'invalid_request', retryable: false },
    { status: 429, code: 'rate_limited', retryable: true },
    { status: 529, code: 'unavailable', retryable: true },
  ] as const;

  for (const expected of cases) {
    it(`maps ${expected.status} to ${expected.code}`, async () => {
      const { fetch } = stubFetch(
        { error: 'nope' },
        { status: expected.status, headers: { 'x-typesafe-request-id': REQUEST_ID } },
      );
      const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);

      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure.code, expected.code);
      assert.equal(result.failure.retryable, expected.retryable);
      // The request id is the only handle on a call that already happened.
      assert.match(result.failure.message, new RegExp(REQUEST_ID));
    });
  }

  it('treats a transport fault as retryable and does not throw', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;

    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure.code, 'unavailable');
    assert.equal(result.failure.retryable, true);
  });

  it('reports cancellation as cancelled, not as a fault', async () => {
    const fetch = (async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof globalThis.fetch;

    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status === 'failed' && result.failure.code, 'cancelled');
  });

  it('classifies a 200 body that cannot be read as retryable unavailable, not malformed', async () => {
    const fetch = (async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('terminated')); },
    }), { status: 200, headers: { 'x-typesafe-request-id': REQUEST_ID } })) as unknown as typeof globalThis.fetch;

    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure.code, 'unavailable');
    assert.equal(result.failure.retryable, true);
    assert.match(result.failure.message, new RegExp(REQUEST_ID));
  });

  it('refuses to construct without a credential', () => {
    assert.throws(() => typesafeAiEvaluator({ apiKey: '  ' }), /requires an apiKey/);
  });

  it('identifies itself so a routed unit can name it', () => {
    const { fetch } = stubFetch(LIVE_BODY);
    assert.equal(typesafeAiEvaluator(options(fetch)).id, TYPESAFE_AI_ADAPTER);
  });
});

// Recorded from `python -m kev.serve --run $WEAVE_KEV_HOME/models/kev-4b` on
// 2026-09-20 via `benchmarks/inference/kev/capture_fixture.py`. Kev serves the same
// /v1/systemone contract; see benchmarks/inference/kev/README.md.
const KEV_BODY = {
  model: 'kev-latest',
  answers: {
    urgent: { type: 'noul', noul: 0.95 },
    area: {
      type: 'choice',
      choice: 'payments',
      confidence: 0.95,
      probabilities: { auth: 0.01, payments: 0.96, ui: 0.02 },
    },
    severity: {
      type: 'score',
      score: 2.15,
      legend: { '0': 'trivial', '1': 'minor', '2': 'serious', '3': 'critical' },
      probabilities: { '0': 0.01, '1': 0.11, '2': 0.62, '3': 0.27 },
      confidence: 0.87,
    },
  },
  usage: { input_tokens: 102, output_tokens: 170 },
  // Kev adds this; hosted TypeSafe does not send it and the adapter ignores it.
  latency_ms: 4955.2,
};

describe('typesafe-ai adapter: a second implementation of the same contract', () => {
  it('reads a local Kev response with no adapter change', async () => {
    const { fetch } = stubFetch(KEV_BODY);
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.status === 'completed' ? result.answers : undefined, {
      urgent: { type: 'boolean', probability: 0.95 },
      area: { type: 'choice', choice: 'payments', probabilities: { auth: 0.01, payments: 0.96, ui: 0.02 } },
      severity: { type: 'score', score: 2.15, probabilities: { '0': 0.01, '1': 0.11, '2': 0.62, '3': 0.27 } },
    });
    assert.deepEqual(result.status === 'completed' ? result.usage : undefined, {
      input_tokens: 102,
      output_tokens: 170,
    });
  });

  it('collects confidence for choice and score, which Kev omits for a noul', async () => {
    const { fetch } = stubFetch(KEV_BODY);
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);
    assert.deepEqual(result.status === 'completed' ? result.confidence : undefined, {
      area: 0.95,
      severity: 0.87,
    });
  });

  it('reports no provider response id, because Kev sends no request-id header', async () => {
    // Hosted TypeSafe returns x-typesafe-request-id and the adapter surfaces it.
    // A local Kev server sends no such header, so a call served locally has no
    // handle for after-the-fact correlation. Recorded, not a defect to fix here.
    const { fetch } = stubFetch(KEV_BODY);
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);
    assert.equal(result.status === 'completed' ? result.provider_response_id : 'unset', undefined);
  });

  it('classifies an over-budget state as a non-retryable invalid request', async () => {
    // Recorded live: a 9000-word state returns 422 with this body. The message
    // blames the question branch even though the state consumed the budget.
    const { fetch } = stubFetch(undefined, {
      status: 422,
      raw: JSON.stringify({ detail: 'branch too long: 12' }),
    });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);
    assert.equal(result.status === 'failed' && result.failure.code, 'invalid_request');
    assert.equal(result.status === 'failed' && result.failure.retryable, false);
  });
});

describe('TypeSafe decision contract', () => {
  const secret = 'ts-live-secret-key';

  it('posts state, model, and a non-empty questions map using criteria', async () => {
    const { fetch, calls } = stubFetch(LIVE_BODY);
    await typesafeAiEvaluator({ apiKey: secret, fetch, baseURL: 'http://127.0.0.1:9/' }).evaluate({
      model: 'jev-preview',
      kind: 'choice',
      state: { ticket: 'payouts failing' },
      questions: {
        urgent: { type: 'boolean', instructions: 'Does this convey urgency?', criteria: { true: 'time-sensitive', false: 'no urgency' } },
        area: { type: 'choice', instructions: 'Which area?', criteria: { billing: 'invoices', technical: null } },
        frustration: { type: 'score', instructions: { ask: 'how frustrated?' }, criteria: ['Calm', 'Frustrated', 'Very angry'] },
      },
      signal: undefined,
    });

    const first = calls[0];
    assert.ok(first);
    assert.equal(first.url, 'http://127.0.0.1:9/v1/systemone');
    assert.equal(first.init.method, 'POST');
    assert.equal((first.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal((first.init.headers as Record<string, string>)['authorization'], `Bearer ${secret}`);
    const body = sentBody(calls);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.deepEqual(body['state'], { ticket: 'payouts failing' });
    assert.equal(body['model'], 'jev-preview');
    const questions = body['questions'];
    assert.equal(Array.isArray(questions), false);
    assert.ok(questions && typeof questions === 'object');
    assert.ok(Object.keys(questions as object).length > 0);
    assert.deepEqual(questions, {
      urgent: { type: 'noul', instructions: 'Does this convey urgency?', criteria: { true: 'time-sensitive', false: 'no urgency' } },
      area: { type: 'choice', instructions: 'Which area?', criteria: { billing: 'invoices', technical: null } },
      frustration: { type: 'score', instructions: { ask: 'how frustrated?' }, criteria: ['Calm', 'Frustrated', 'Very angry'] },
    });
    const encoded = JSON.stringify(questions);
    assert.equal(encoded.includes('"choices"'), false);
    assert.equal(encoded.includes('"levels"'), false);
    assert.equal(encoded.includes('"predicate"'), false);
  });

  it('reads noul, choice, and score, and does not invent missing confidence', async () => {
    const { fetch } = stubFetch({
      model: 'jev-1.13.0',
      answers: {
        urgent: { type: 'noul', noul: 0.95 },
        area: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 } },
        frustration: {
          type: 'score',
          score: 1.05,
          legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
          probabilities: { '0': 0, '1': 0.95, '2': 0.05 },
        },
      },
      usage: { input_tokens: 388, output_tokens: 73 },
    }, { headers: { 'x-typesafe-request-id': REQUEST_ID } });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(ALL_CALL);
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.deepEqual(result.answers['urgent'], { type: 'boolean', probability: 0.95 });
    assert.deepEqual(result.answers['area'], {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
    });
    assert.deepEqual(result.answers['frustration'], {
      type: 'score',
      score: 1.05,
      probabilities: { '0': 0, '1': 0.95, '2': 0.05 },
    });
    assert.equal(result.confidence, undefined);
    assert.equal(result.provider_response_id, REQUEST_ID);
  });

  const statuses = [
    { status: 400, code: 'invalid_request', retryable: false },
    { status: 401, code: 'unauthorized', retryable: false },
    { status: 422, code: 'invalid_request', retryable: false },
    { status: 429, code: 'rate_limited', retryable: true },
    { status: 500, code: 'unavailable', retryable: true },
    { status: 529, code: 'unavailable', retryable: true },
  ] as const;

  for (const expected of statuses) {
    it(`maps HTTP ${expected.status} to ${expected.code}`, async () => {
      const { fetch } = stubFetch(undefined, {
        status: expected.status,
        raw: JSON.stringify({ error: { code: 'api_usage_error', message: 'Invalid request.' } }),
        headers: { 'x-typesafe-request-id': REQUEST_ID },
      });
      const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure.code, expected.code);
      assert.equal(result.failure.retryable, expected.retryable);
      assert.match(result.failure.message, new RegExp(REQUEST_ID));
    });
  }

  it('reports a malformed body without inventing an answer', async () => {
    for (const raw of ['not-json', 'null', '[]', JSON.stringify({ model: 'jev-preview' }), JSON.stringify({ answers: { urgent: { type: 'noul' } } })]) {
      const { fetch } = stubFetch(undefined, { raw, headers: { 'x-typesafe-request-id': REQUEST_ID } });
      const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure.code, 'malformed_response');
      assert.equal(result.failure.retryable, false);
      assert.equal(result.failure.message.includes('test-key'), false);
    }
  });

  it('keeps the credential out of failures and logs', async () => {
    const logs: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = new Map(methods.map((name) => [name, console[name].bind(console)]));
    for (const name of methods) {
      console[name] = ((...args: unknown[]) => {
        logs.push(args.map((arg) => String(arg)).join(' '));
      }) as typeof console.log;
    }
    try {
      const echoed = stubFetch(undefined, {
        status: 400,
        raw: JSON.stringify({ error: `rejected ${secret}`, authorization: `Bearer ${secret}` }),
        headers: { 'x-typesafe-request-id': `req_${secret}` },
      });
      const failed = await typesafeAiEvaluator({ apiKey: secret, fetch: echoed.fetch }).evaluate(CALL);
      assert.equal(failed.status, 'failed');
      if (failed.status !== 'failed') return;
      assert.equal(JSON.stringify(failed).includes(secret), false);
      assert.match(failed.failure.message, /\[redacted\]/);

      const thrown = (async () => {
        throw new Error(`connect ${secret} failed`);
      }) as unknown as typeof globalThis.fetch;
      const transport = await typesafeAiEvaluator({ apiKey: secret, fetch: thrown }).evaluate(CALL);
      assert.equal(transport.status, 'failed');
      if (transport.status !== 'failed') return;
      assert.equal(JSON.stringify(transport).includes(secret), false);

      const succeeded = await typesafeAiEvaluator({
        apiKey: secret,
        fetch: stubFetch(LIVE_BODY, { headers: { 'x-typesafe-request-id': `req_${secret}` } }).fetch,
      }).evaluate(CALL);
      assert.equal(succeeded.status, 'completed');
      if (succeeded.status !== 'completed') return;
      assert.equal(succeeded.provider_response_id, 'req_[redacted]');
      assert.equal(JSON.stringify(succeeded).includes(secret), false);
      assert.equal(logs.some((line) => line.includes(secret)), false);
    } finally {
      for (const name of methods) console[name] = originals.get(name) as typeof console.log;
    }
  });
});

describe('reference provenance and throttling', () => {
  it('surfaces the response model without substituting the requested alias', async () => {
    const { fetch } = stubFetch(LIVE_BODY);
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') assert.equal(result.resolved_model_id, 'jev-1.13.0');
  });
  it('keeps a missing response model absent and redacts credentials from model metadata', async () => {
    for (const model of [undefined, 'model-test-key']) {
      const { fetch } = stubFetch({ ...LIVE_BODY, model });
      const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
      assert.equal(result.status, 'completed');
      if (result.status === 'completed') assert.equal(result.resolved_model_id, model === undefined ? undefined : 'model-[redacted]');
    }
  });
  it('honours numeric retry-after on a TypeSafe throttle', async () => {
    const { fetch } = stubFetch({}, { status: 429, headers: { 'retry-after': '1.5' } });
    const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.failure.retry_after_ms, 1500);
  });
});

it('preserves a redacted provider response id on throttle failures', async () => {
  const { fetch } = stubFetch({}, { status: 429, headers: { 'x-typesafe-request-id': 'req-test-key' } });
  const result = await typesafeAiEvaluator(options(fetch)).evaluate(CALL);
  assert.equal(result.status, 'failed');
  assert.equal(result.provider_response_id, 'req-[redacted]');
});
