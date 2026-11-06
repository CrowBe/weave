import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  EvaluationOutcome,
  EvaluationRequest,
  GenerationOutcome,
  GenerationRequest,
  InferenceGateway,
  InferenceTerms,
} from '@weave/gateway';
import {
  decideIntake,
  intakeExtractSchema,
  transitionIntake,
  type RecordedExtract,
  type RecordedIntake,
} from '../src/intake.js';
import {
  evaluateSite,
  type IntakeSiteInput,
  type RecordedSiteAnswer,
  type SiteState,
} from '../src/sites/index.js';

const MESSAGE_CANARY = 'CANARY-7f3a';
const PROVIDER_CANARY = 'PROVIDER-CANARY-9c2d';
const terms: InferenceTerms = {
  quality: 'baseline',
  destinations: ['local'],
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const revision = { state_revision: 1, state_updated_at: 10 };
const threads = [
  { thread_id: 'T1', summary: 'Weave intake evaluation' },
  { thread_id: 'T2', summary: 'Bakery invoice reconciliation' },
];
const MESSAGE = `${MESSAGE_CANARY} Please continue thread T2 with the invoice reconciliation.`;
const ask: IntakeSiteInput = {
  request_id: 'intake-1',
  ...revision,
  state: { message: MESSAGE, running_threads: threads },
  terms,
  needs_dispatch: false,
};
const now = () => ({ ...revision, observed_at: 10 });

type Generate = (request: GenerationRequest, signal?: AbortSignal) => Promise<GenerationOutcome>;
type Evaluate = (
  request: EvaluationRequest<'choice'>,
  signal?: AbortSignal,
) => Promise<EvaluationOutcome<'choice'>>;

function acceptedGeneration(
  request: GenerationRequest,
  payload: unknown,
  extra: Record<string, unknown> = {},
): GenerationOutcome {
  return {
    status: 'accepted',
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    request_id: request.request_id,
    site: request.site,
    routed_unit_id: 'extract.fake',
    provider_response_id: 'provider-1',
    attempts: [],
    spent: 0,
    uncertainty: [],
    ...extra,
  } as GenerationOutcome;
}
function acceptedChoice(
  request: EvaluationRequest<'choice'>,
  choice = 'queue',
  extra: Record<string, unknown> = {},
): EvaluationOutcome<'choice'> {
  return {
    status: 'accepted',
    kind: 'choice',
    request_id: request.request_id,
    site: request.site,
    answers: { decision: { type: 'choice', choice, probabilities: { [choice]: 1 } } },
    confidence: { decision: 1 },
    routed_unit_id: 'site.fake',
    provider_response_id: 'provider-site',
    attempts: [],
    spent: 0,
    uncertainty: [],
    ...extra,
  } as EvaluationOutcome<'choice'>;
}
function port(options: { generate?: Generate; evaluate?: Evaluate } = {}) {
  const generateCalls: GenerationRequest[] = [];
  const evaluateCalls: EvaluationRequest<'choice'>[] = [];
  const fake = {
    async generate(request: GenerationRequest, signal?: AbortSignal) {
      generateCalls.push(request);
      if (!options.generate) throw new Error('unexpected generate');
      return options.generate(request, signal);
    },
    async evaluate(request: EvaluationRequest<'choice'>, signal?: AbortSignal) {
      evaluateCalls.push(request);
      if (!options.evaluate) throw new Error('unexpected evaluate');
      return options.evaluate(request, signal);
    },
  } as Pick<InferenceGateway, 'generate' | 'evaluate'>;
  return { fake, generateCalls, evaluateCalls };
}
function payload(thread: string | null, cue: string | null, request: string | null = null) {
  return { thread_ref: { value: thread, cue }, request: { value: request } };
}
function extractOf(record: { extract: readonly unknown[] }, attempt = 1) {
  return record.extract[attempt - 1] as {
    verdict: string;
    reason: string;
    slots: { slot: string; status: string; value: string | null; span: [number, number] | null }[];
    provider_request_id: string | null;
    request_id: string | null;
    attempt: number;
    residual_ambiguity: { count: number; slots: string[] };
  };
}
function recordedSite(
  outcome: EvaluationOutcome<'choice'> | null,
  observed_at = 10,
  cancelled = false,
): RecordedSiteAnswer {
  return {
    state_revision: revision.state_revision,
    observed_at,
    outcome,
    ...(cancelled ? { cancelled: true } : {}),
  };
}

test('the site always receives the original message; hints appear only on use_hints', async () => {
  const faithful = port({
    generate: async (request) => acceptedGeneration(request, payload('T2', 'T2')),
    evaluate: async (request) => acceptedChoice(request),
  });
  const record = await decideIntake(ask, faithful.fake, now);
  assert.equal(record.decided_by, 'site');
  assert.equal(faithful.evaluateCalls.length, 1);
  const state = faithful.evaluateCalls[0]!.state as Record<string, unknown>;
  assert.equal(state['message'], MESSAGE);
  assert.deepEqual(Object.keys(state), ['message', 'running_threads', 'hints']);
  assert.deepEqual(state['hints'], {
    schema: 'intake.message@1',
    thread_ref: { value: 'T2', cue: 'T2' },
    request: null,
  });

  const unfaithful = port({
    generate: async (request) => acceptedGeneration(request, payload('T2', 'not in the message')),
    evaluate: async (request) => acceptedChoice(request),
  });
  const fallback = await decideIntake(ask, unfaithful.fake, now);
  assert.equal(fallback.decided_by, 'site');
  assert.equal(extractOf(fallback, 1).verdict, 're_extract');
  assert.equal(extractOf(fallback, 2).verdict, 'original_only');
  const fallbackState = unfaithful.evaluateCalls[0]!.state as Record<string, unknown>;
  assert.equal(fallbackState['message'], MESSAGE);
  assert.deepEqual(Object.keys(fallbackState), ['message', 'running_threads']);

  const direct = port({ evaluate: async (request) => acceptedChoice(request) });
  await evaluateSite('intake.classify', ask, direct.fake, now);
  assert.deepEqual(fallbackState, direct.evaluateCalls[0]!.state);
});

test('an unfaithful first attempt re-extracts with fixed feedback and never echoes provider text', async () => {
  const calls: GenerationRequest[] = [];
  const fake = port({
    generate: async (request) => {
      calls.push(request);
      if (request.request_id.endsWith(':x1'))
        return acceptedGeneration(request, payload('T2', PROVIDER_CANARY));
      return acceptedGeneration(request, payload('T2', 'T2'));
    },
    evaluate: async (request) => acceptedChoice(request),
  });
  const record = await decideIntake(ask, fake.fake, now);
  assert.equal(fake.generateCalls.length, 2);
  const second = fake.generateCalls[1]!;
  assert.equal(second.request_id, 'intake-1:x2');
  assert.ok(second.input.instructions.includes('thread_ref: ungrounded'));
  assert.ok(!JSON.stringify(second).includes(PROVIDER_CANARY));
  assert.ok(!JSON.stringify(record).includes(PROVIDER_CANARY));
  assert.equal(extractOf(record, 1).reason, 'unfaithful');
  assert.deepEqual([extractOf(record, 2).verdict, extractOf(record, 2).reason], ['use_hints', 'faithful']);
});

test('a still-unfaithful second attempt falls back to the original and asks the site', async () => {
  const fake = port({
    generate: async (request) => acceptedGeneration(request, payload('T2', 'missing')),
    evaluate: async (request) => acceptedChoice(request),
  });
  const record = await decideIntake(ask, fake.fake, now);
  assert.equal(fake.generateCalls.length, 2);
  assert.equal(fake.evaluateCalls.length, 1);
  assert.deepEqual([extractOf(record, 2).verdict, extractOf(record, 2).reason], ['original_only', 'unfaithful']);
  assert.deepEqual(Object.keys(fake.evaluateCalls[0]!.state as object).sort(), ['message', 'running_threads']);
});

test('an extract outage degrades to the original, never pauses, and keeps diagnostics out', async () => {
  const blocked = {
    status: 'blocked',
    reason: 'no_route',
    request_id: 'intake-1:x1',
    site: 'intake.extract',
    attempts: [],
    spent: 0,
    uncertainty: [],
  } as GenerationOutcome;
  const failed = {
    status: 'unaccepted',
    reason: 'provider_failed',
    request_id: 'intake-1:x1',
    site: 'intake.extract',
    attempts: [
      {
        attempt: 1,
        routed_unit_id: 'r',
        model: 'm',
        started_at: 1,
        ended_at: 2,
        usage: { input_tokens: 1, output_tokens: 1 },
        cost: 0,
        cost_is_upper_bound: false,
        disposition: { status: 'failed', failure: { code: 'unavailable', retryable: true, message: PROVIDER_CANARY } },
      },
    ],
    spent: 0,
    uncertainty: [],
  } as GenerationOutcome;
  for (const needs_dispatch of [false, true]) {
    for (const reply of [blocked, failed, null]) {
      const fake = port({
        generate: async (request) => {
          if (reply === null) throw new Error(PROVIDER_CANARY);
          return { ...reply, request_id: request.request_id } as GenerationOutcome;
        },
        evaluate: async (request) => acceptedChoice(request),
      });
      const record = await decideIntake({ ...ask, needs_dispatch }, fake.fake, now);
      assert.equal(fake.generateCalls.length, 1);
      assert.equal(fake.evaluateCalls.length, 1);
      assert.deepEqual([extractOf(record).verdict, extractOf(record).reason], [
        'original_only',
        'decision_unavailable',
      ]);
      assert.ok(!JSON.stringify(record).includes(PROVIDER_CANARY));
    }
  }
});

test('unresolved required ambiguity asks the operator only when several threads are running', async () => {
  const ambiguous = 'Please continue the second thread with the invoice reconciliation.';
  const two = port({
    generate: async (request) => acceptedGeneration(request, payload(null, 'the second thread')),
    evaluate: async (request) => acceptedChoice(request),
  });
  const asked = await decideIntake(
    { ...ask, state: { message: ambiguous, running_threads: threads } },
    two.fake,
    now,
  );
  assert.equal(two.evaluateCalls.length, 0);
  assert.deepEqual([asked.decided_by, asked.choice, asked.status, asked.reason], [
    'extract',
    'ask_user',
    'needs_human',
    'ambiguous_reference',
  ]);
  assert.deepEqual(extractOf(asked).residual_ambiguity, { count: 1, slots: ['thread_ref'] });

  const one = port({
    generate: async (request) => acceptedGeneration(request, payload(null, 'the second thread')),
    evaluate: async (request) => acceptedChoice(request),
  });
  const decided = await decideIntake(
    { ...ask, state: { message: ambiguous, running_threads: [threads[0]!] } },
    one.fake,
    now,
  );
  assert.equal(one.evaluateCalls.length, 1);
  assert.equal(decided.decided_by, 'site');
  assert.deepEqual(extractOf(decided).residual_ambiguity, { count: 1, slots: ['thread_ref'] });

  const ungrounded = port({
    generate: async (request) => acceptedGeneration(request, payload(null, 'not in the message')),
    evaluate: async (request) => acceptedChoice(request),
  });
  const reExtracted = await decideIntake(
    { ...ask, state: { message: ambiguous, running_threads: threads } },
    ungrounded.fake,
    now,
  );
  assert.equal(ungrounded.generateCalls.length, 2);
  assert.equal(ungrounded.evaluateCalls.length, 1);
  assert.notEqual(reExtracted.reason, 'ambiguous_reference');
});

test('cancellation makes no further calls and records a paused decision', async () => {
  const before = new AbortController();
  before.abort();
  const none = port();
  const pre = await decideIntake(ask, { ...none.fake, generate: async () => assert.fail('must not generate') }, now, before.signal);
  assert.deepEqual([pre.status, pre.reason], ['paused', 'cancelled']);
  assert.equal(pre.extract.length, 1);
  assert.equal(extractOf(pre).reason, 'cancelled');

  const duringExtract = new AbortController();
  const extracting = port({
    generate: async (request) => {
      duringExtract.abort();
      return acceptedGeneration(request, payload('T2', 'T2'));
    },
    evaluate: async (request) => acceptedChoice(request),
  });
  const mid = await decideIntake(ask, extracting.fake, now, duringExtract.signal);
  assert.equal(extracting.generateCalls.length, 1);
  assert.equal(extracting.evaluateCalls.length, 0);
  assert.deepEqual([mid.status, mid.reason], ['paused', 'cancelled']);

  const duringSite = new AbortController();
  const site = port({
    generate: async (request) => acceptedGeneration(request, payload('T2', 'T2')),
    evaluate: async (request) => {
      duringSite.abort();
      return acceptedChoice(request);
    },
  });
  const paused = await decideIntake(ask, site.fake, now, duringSite.signal);
  assert.deepEqual([paused.decided_by, paused.status, paused.reason], ['site', 'paused', 'cancelled']);
});

test('a revision change after extraction stops before the site and marks the answer stale', async () => {
  let reads = 0;
  let current: SiteState & { observed_at: number } = { ...revision, observed_at: 10 };
  const clock = () => {
    reads++;
    return current;
  };
  const fake = port({
    generate: async (request) => {
      current = { state_revision: 2, state_updated_at: 11, observed_at: 11 };
      return acceptedGeneration(request, payload('T2', 'T2'));
    },
    evaluate: async (request) => acceptedChoice(request),
  });
  const record = await decideIntake(ask, fake.fake, clock);
  assert.equal(reads, 1);
  assert.equal(fake.evaluateCalls.length, 0);
  assert.equal(fake.generateCalls.length, 1);
  assert.deepEqual([record.status, record.reason], ['needs_human', 'stale_answer']);
  assert.deepEqual([extractOf(record).verdict, extractOf(record).reason], ['original_only', 'stale_answer']);

  const mismatched = port({
    generate: async (request) =>
      acceptedGeneration(request, payload('T2', 'T2'), { request_id: 'other:x1' }),
    evaluate: async (request) => acceptedChoice(request),
  });
  const retried = await decideIntake(ask, mismatched.fake, now);
  assert.equal(mismatched.generateCalls.length, 2);
  assert.equal(extractOf(retried, 1).reason, 'mismatched_answer');
  assert.equal(mismatched.evaluateCalls.length, 1);
});

test('concurrent decisions bind to their own request ids and captured input', async () => {
  const deferred: { request: GenerationRequest; resolve: (value: GenerationOutcome) => void }[] = [];
  const fake = port({
    generate: (request) =>
      new Promise<GenerationOutcome>((resolve) => {
        deferred.push({ request, resolve });
      }),
    evaluate: async (request) => acceptedChoice(request),
  });
  const first: IntakeSiteInput = { ...ask, request_id: 'first' };
  const second: IntakeSiteInput = { ...ask, request_id: 'second' };
  const p1 = decideIntake(first, fake.fake, now);
  const p2 = decideIntake(second, fake.fake, now);
  assert.equal(deferred.length, 2);
  deferred[1]!.resolve(acceptedGeneration(deferred[1]!.request, payload('T2', 'T2')));
  deferred[0]!.resolve(acceptedGeneration(deferred[0]!.request, payload('T2', 'T2')));
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual([r1.request_id, r2.request_id], ['first', 'second']);
  assert.deepEqual(r1.extract.map((item) => item.request_id), ['first:x1']);
  assert.deepEqual(r2.extract.map((item) => item.request_id), ['second:x1']);
  assert.deepEqual(
    fake.evaluateCalls.map((item) => item.request_id).sort(),
    ['first', 'second'],
  );

  const mutationDeferred: { request: GenerationRequest; resolve: (value: GenerationOutcome) => void }[] = [];
  const mutablePort = port({
    generate: (request) =>
      new Promise<GenerationOutcome>((resolve) => {
        mutationDeferred.push({ request, resolve });
      }),
    evaluate: async (request) => acceptedChoice(request),
  });
  const mutable: IntakeSiteInput = {
    ...ask,
    state: { message: MESSAGE, running_threads: [...threads] },
  };
  const pending = decideIntake(mutable, mutablePort.fake, now);
  (mutable as unknown as { state: { message: string; running_threads: unknown[] } }).state = {
    message: 'MUTATED',
    running_threads: [],
  };
  mutationDeferred[0]!.resolve(
    acceptedGeneration(mutationDeferred[0]!.request, payload('T2', 'T2')),
  );
  const record = await pending;
  assert.equal(mutationDeferred[0]!.request.input.prompt.includes(MESSAGE), true);
  assert.equal((mutablePort.evaluateCalls[0]!.state as { message: string }).message, MESSAGE);
  assert.equal(record.decided_by, 'site');
});

test('replay rebuilds the same record from recorded outcomes without a port', async () => {
  const generateOutcome = (request: GenerationRequest) =>
    acceptedGeneration(request, payload('T2', 'T2'));
  let generated: GenerationOutcome | null = null;
  let evaluated: EvaluationOutcome<'choice'> | null = null;
  const fake = port({
    generate: async (request) => (generated = generateOutcome(request)),
    evaluate: async (request) => (evaluated = acceptedChoice(request)),
  });
  const live = await decideIntake(ask, fake.fake, now);
  const recorded: RecordedIntake = {
    extracts: [
      {
        attempt: 1,
        state_revision: revision.state_revision,
        state_updated_at: revision.state_updated_at,
        outcome: generated,
      } as RecordedExtract,
    ],
    site: recordedSite(evaluated),
  };
  const replayed = transitionIntake(ask, recorded, revision);
  assert.deepEqual(replayed, live);
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error('replay must not call a port');
      },
    },
  ) as Pick<InferenceGateway, 'generate' | 'evaluate'>;
  assert.deepEqual(transitionIntake(ask, recorded, revision), live);
  void throwing;

  assert.throws(() =>
    transitionIntake(
      ask,
      {
        extracts: [recorded.extracts[0]!, recorded.extracts[0]!, recorded.extracts[0]!],
        site: recorded.site,
      },
      revision,
    ),
  );
  assert.throws(() =>
    transitionIntake(
      ask,
      {
        extracts: [
          { ...recorded.extracts[0]!, attempt: 2 },
          { ...recorded.extracts[0]!, attempt: 2 },
        ],
        site: recorded.site,
      },
      revision,
    ),
  );
});

test('replay rejects a second extract after a recorded stop', () => {
  const generationFor = (request_id: string, body: unknown): GenerationOutcome =>
    acceptedGeneration({ request_id, site: 'intake.extract' } as GenerationRequest, body);
  const first = generationFor('intake-1:x1', payload('T2', 'T2'));
  const second = generationFor('intake-1:x2', payload('T2', 'T2'));
  const recordedFirst = {
    attempt: 1,
    state_revision: revision.state_revision,
    state_updated_at: revision.state_updated_at,
    outcome: first,
  } as RecordedExtract;
  const recordedSecond = {
    attempt: 2,
    state_revision: revision.state_revision,
    state_updated_at: revision.state_updated_at,
    outcome: second,
  } as RecordedExtract;
  const site = recordedSite(
    acceptedChoice(
      { request_id: 'intake-1', site: 'intake.classify' } as EvaluationRequest<'choice'>,
    ),
  );

  assert.throws(
    () =>
      transitionIntake(
        ask,
        { extracts: [{ ...recordedFirst, cancelled: true }, recordedSecond], site },
        revision,
      ),
    /recorded stop cannot be followed by a second extraction/,
  );
  assert.throws(
    () =>
      transitionIntake(
        ask,
        {
          extracts: [{ ...recordedFirst, state_revision: 2, state_updated_at: 11 }, recordedSecond],
          site,
        },
        revision,
      ),
    /recorded stop cannot be followed by a second extraction/,
  );

  const retryFirst = {
    ...recordedFirst,
    outcome: generationFor('intake-1:x1', payload('T2', 'not in the message')),
  };
  const replayed = transitionIntake(
    ask,
    { extracts: [retryFirst, recordedSecond], site },
    revision,
  );
  assert.equal(replayed.decided_by, 'site');
  assert.equal(replayed.extract.length, 2);
  assert.equal(replayed.extract[0]!.verdict, 're_extract');
  assert.equal(replayed.extract[1]!.verdict, 'use_hints');
});

test('records carry no message, summary, provider text or credential id and no grant', async () => {
  const fake = port({
    generate: async (request) =>
      acceptedGeneration(request, payload('T2', 'T2'), { provider_response_id: 'sk-secret-provider' }),
    evaluate: async (request) =>
      acceptedChoice(request, 'queue', { provider_response_id: 'ghp_secret', request_id: request.request_id }),
  });
  const record = await decideIntake(ask, fake.fake, now);
  const text = JSON.stringify(record);
  assert.ok(!text.includes(MESSAGE_CANARY));
  assert.ok(!text.includes('Bakery invoice reconciliation'));
  assert.ok(!text.includes(PROVIDER_CANARY));
  assert.ok(!text.includes('sk-secret'));
  assert.ok(!text.includes('ghp_secret'));
  assert.equal(extractOf(record).provider_request_id, null);
  assert.equal(record.site?.provider_request_id, null);
  assert.deepEqual(Object.keys(record), [
    'schema',
    'request_id',
    'decided_by',
    'choice',
    'status',
    'reason',
    'extract',
    'site',
  ]);
  assert.deepEqual(Object.keys(extractOf(record)), [
    'schema',
    'site',
    'extract_schema',
    'request_id',
    'attempt',
    'state_revision',
    'verdict',
    'reason',
    'slots',
    'residual_ambiguity',
    'provider_request_id',
  ]);
  assert.deepEqual(Object.keys(extractOf(record).slots[0]!), ['slot', 'kind', 'status', 'value', 'span']);
  for (const key of ['grant', 'scope', 'dispatch', 'authority']) assert.ok(!(key in record));
});

test('a direct site call still receives a state with no hints key', async () => {
  const fake = port({ evaluate: async (request) => acceptedChoice(request) });
  await evaluateSite('intake.classify', ask, fake.fake, now);
  assert.deepEqual(Object.keys(fake.evaluateCalls[0]!.state as object), ['message', 'running_threads']);
  const schema = intakeExtractSchema(ask.state);
  assert.deepEqual(Object.keys(schema.slots), ['thread_ref', 'request']);
  assert.deepEqual(schema.slots.thread_ref, {
    kind: 'choice',
    required: true,
    instructions: schema.slots.thread_ref?.instructions,
    options: ['T1', 'T2', 'none'],
    none: 'none',
  });
});
