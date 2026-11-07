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
import { validateRecord } from '@weave/weft';
import {
  MemoryDispatchJournal,
  decideDispatch,
  dispatchJudgments,
  resolveThreadTarget,
  transitionDispatch,
  type DispatchCheckpoint,
  type DispatchDecision,
  type DispatchIntent,
  type DispatchJournal,
  type DispatchPorts,
  type DispatchReceipt,
  type DispatchRequest,
} from '../src/dispatch.js';
import { gateExtract } from '../src/sites/extract.js';
import { evaluateSite, modelOrigin, SITE_POLICY, type SiteState } from '../src/sites/index.js';
import { loopRouteExtractSchema, loopTriageExtractSchema } from '../src/sites/model-extract.js';
import type { WeftPort, WeftRecordShape } from '../src/weft.js';
import { assertRecordCopiesNoText, assertNoCopiedText } from './record-canary.js';

const MESSAGE = 'fix the parser';
const TRIAGE_CONTEXT = 'disclosed triage context';
const ROUTE_CONTEXT = 'disclosed route context';
const REVISION: SiteState = { state_revision: 1, state_updated_at: 10 };
const terms: InferenceTerms = {
  quality: 'baseline',
  destinations: ['local'],
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const CANARIES = ['CANARY-msg', 'CANARY-summary', 'CANARY-ctx', 'CANARY-provider', 'CANARY-error'];

type Mode = 'ok' | 'stale' | 'mismatch' | 'outage' | 'no_answer';
interface StagePlan {
  readonly choice?: string;
  readonly mode?: Mode;
  readonly confidence?: number | null;
  readonly probabilities?: Readonly<Record<string, number>>;
}
interface Plan {
  readonly intake?: StagePlan;
  readonly triage?: StagePlan;
  readonly route?: StagePlan;
  readonly thread?: { readonly value: string | null; readonly cue: string | null };
  readonly triageIntent?: string;
  readonly routeIntent?: string;
  readonly onEvaluate?: (request: EvaluationRequest<'choice'>, signal?: AbortSignal) => void;
  readonly gate?: { readonly match: (requestId: string) => boolean; readonly promise: Promise<void> };
}

function makeClock() {
  const state = { ...REVISION };
  return {
    state,
    now: () => ({ ...state, observed_at: state.state_updated_at }),
    advance: () => {
      state.state_revision += 1;
      state.state_updated_at += 10;
    },
    set: (revision: number, updated: number) => {
      state.state_revision = revision;
      state.state_updated_at = updated;
    },
  };
}
type Clock = ReturnType<typeof makeClock>;

function acceptedGeneration(request: GenerationRequest, payload: unknown): GenerationOutcome {
  return {
    status: 'accepted',
    text: JSON.stringify(payload),
    request_id: request.request_id,
    site: request.site,
    routed_unit_id: 'extract.fake',
    provider_response_id: 'provider-1',
    attempts: [],
    spent: 0,
    uncertainty: [],
  } as GenerationOutcome;
}

function blockedChoice(request: EvaluationRequest<'choice'>): EvaluationOutcome<'choice'> {
  return {
    status: 'blocked',
    reason: 'policy_denied',
    request_id: request.request_id,
    site: request.site,
    attempts: [],
    spent: 0,
    uncertainty: [],
  } as unknown as EvaluationOutcome<'choice'>;
}

function choiceOutcome(
  request: EvaluationRequest<'choice'>,
  stage: StagePlan | undefined,
  fallback: string,
  clock: Clock,
): EvaluationOutcome<'choice'> {
  const mode = stage?.mode ?? 'ok';
  if (mode === 'outage') throw new Error('CANARY-error');
  if (mode === 'stale') clock.advance();
  if (mode === 'no_answer') return blockedChoice(request);
  const choice = stage?.choice ?? fallback;
  const confidence = stage?.confidence === undefined ? 1 : stage.confidence;
  const probabilities = stage?.probabilities ?? { [choice]: 1 };
  return {
    status: 'accepted',
    kind: 'choice',
    request_id: mode === 'mismatch' ? 'other-request' : request.request_id,
    site: request.site,
    answers: { decision: { type: 'choice', choice, probabilities } },
    confidence: confidence === null ? undefined : { decision: confidence },
    routed_unit_id: 'site.fake',
    provider_response_id: 'provider-site',
    attempts: [],
    spent: 0,
    uncertainty: [],
  } as unknown as EvaluationOutcome<'choice'>;
}

function makeGateway(plan: Plan, clock: Clock) {
  const generateCalls: GenerationRequest[] = [];
  const evaluateCalls: EvaluationRequest<'choice'>[] = [];
  const events: string[] = [];
  const fake = {
    async generate(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationOutcome> {
      generateCalls.push(request);
      events.push(`generate:${request.site}`);
      if (plan.gate?.match(request.request_id)) await plan.gate.promise;
      if (request.site === 'intake.extract') {
        return acceptedGeneration(request, {
          thread_ref: plan.thread ?? { value: null, cue: null },
          request: { value: null },
        });
      }
      const text =
        request.site === 'loop.triage.extract' ? (plan.triageIntent ?? MESSAGE) : (plan.routeIntent ?? MESSAGE);
      return acceptedGeneration(request, { intent: { value: text } });
    },
    async evaluate(request: EvaluationRequest<'choice'>, signal?: AbortSignal): Promise<EvaluationOutcome<'choice'>> {
      evaluateCalls.push(request);
      events.push(`evaluate:${request.site}`);
      if (plan.gate?.match(request.request_id)) await plan.gate.promise;
      plan.onEvaluate?.(request, signal);
      switch (request.site) {
        case 'intake.classify':
          return choiceOutcome(request, plan.intake, 'new_thread', clock);
        case 'loop.triage':
          return choiceOutcome(request, plan.triage, 'implement', clock);
        case 'loop.route':
          return choiceOutcome(request, plan.route, 'flash', clock);
        default:
          throw new Error(`unexpected evaluate site ${request.site}`);
      }
    },
  } as unknown as Pick<InferenceGateway, 'generate' | 'evaluate'>;
  return { fake, generateCalls, evaluateCalls, events };
}

function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    request_id: 'd1',
    ...REVISION,
    terms,
    intake: { message: MESSAGE, running_threads: [{ thread_id: 'T1', summary: 'alpha work' }] },
    triage_context: TRIAGE_CONTEXT,
    route_context: ROUTE_CONTEXT,
    ...overrides,
  };
}

function dispatched(intent: DispatchIntent): DispatchReceipt {
  return { status: 'dispatched', dispatch_id: intent.dispatch_id, ref: `action:${intent.kind}` };
}

function harness(
  plan: Plan = {},
  options: {
    readonly request?: DispatchRequest;
    readonly journal?: DispatchJournal;
    readonly clock?: Clock;
    readonly weft?: WeftPort;
    readonly receipt?: (intent: DispatchIntent) => DispatchReceipt;
    readonly dispatch?: (intent: DispatchIntent, signal?: AbortSignal) => Promise<DispatchReceipt>;
  } = {},
) {
  const clock = options.clock ?? makeClock();
  const journal = options.journal ?? new MemoryDispatchJournal();
  const gateway = makeGateway(plan, clock);
  const dispatchCalls: DispatchIntent[] = [];
  const dispatch = async (intent: DispatchIntent, signal?: AbortSignal): Promise<DispatchReceipt> => {
    dispatchCalls.push(intent);
    gateway.events.push(`dispatch:${intent.kind}`);
    if (options.dispatch) return options.dispatch(intent, signal);
    return options.receipt ? options.receipt(intent) : dispatched(intent);
  };
  const ports: DispatchPorts = {
    generate: gateway.fake.generate,
    evaluate: gateway.fake.evaluate,
    now: clock.now,
    dispatch,
    ...(options.weft === undefined ? {} : { weft: options.weft }),
  };
  const request = options.request ?? makeRequest();
  return { clock, journal, ports, request, dispatchCalls, ...gateway };
}

function run(h: ReturnType<typeof harness>, signal?: AbortSignal): Promise<DispatchDecision> {
  return decideDispatch(h.request, h.ports, h.journal, signal);
}

function assertNoAuthorityKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoAuthorityKeys(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!['grant', 'scope', 'approval', 'provider'].includes(key), `record has forbidden key ${key}`);
    assertNoAuthorityKeys(nested);
  }
}

function collector(): { port: WeftPort; records: WeftRecordShape[] } {
  const records: WeftRecordShape[] = [];
  return {
    port: { trace_id: 'trace-1', emitter_id: 'loom.dispatch', emit: (record) => void records.push(record) },
    records,
  };
}

test('1. chain: intake -> D1 -> D2 -> one implement dispatch, in dependency order', async () => {
  const h = harness({ route: { choice: 'flash' } });
  const decision = await run(h);
  assert.equal(decision.status, 'dispatched');
  assert.equal(decision.decided_by, 'route');
  assert.equal(decision.choice, 'flash');
  assert.deepEqual(h.dispatchCalls, [
    { kind: 'implement', dispatch_id: 'd1:dispatch', tier: 'flash', ceiling: 'flash', tier_source: 'route' },
  ]);
  assert.deepEqual(h.events, [
    'generate:intake.extract',
    'evaluate:intake.classify',
    'generate:loop.triage.extract',
    'evaluate:loop.triage',
    'generate:loop.route.extract',
    'evaluate:loop.route',
    'dispatch:implement',
  ]);
  assert.deepEqual(
    h.evaluateCalls.map((request) => request.request_id),
    ['d1:intake', 'd1:triage', 'd1:route'],
  );
  // needs_dispatch:true is what turns a stage outage into a pause rather than a fallback.
  const outage = harness({ route: { mode: 'outage' } });
  const paused = await run(outage);
  assert.deepEqual([paused.status, paused.reason], ['paused', 'decision_unavailable']);
  assert.equal(outage.dispatchCalls.length, 0);
});

test('2. D1 capability, done_check, out_of_scope and needs_human', async () => {
  const cases: readonly [StagePlan, DispatchIntent['kind'] | null, string][] = [
    [{ choice: 'capability' }, 'capability', 'dispatched'],
    [{ choice: 'done_check' }, 'done_check', 'dispatched'],
    [{ choice: 'out_of_scope' }, 'decline', 'dispatched'],
    [{ choice: 'needs_human' }, null, 'needs_human'],
  ];
  for (const [triage, kind, status] of cases) {
    const h = harness({ triage });
    const decision = await run(h);
    assert.equal(decision.status, status, triage.choice);
    assert.equal(decision.decided_by, 'triage', triage.choice);
    assert.equal(
      h.evaluateCalls.some((request) => request.site === 'loop.route'),
      false,
      triage.choice,
    );
    assert.equal(
      h.generateCalls.some((request) => request.site === 'loop.route.extract'),
      false,
      triage.choice,
    );
    if (kind === null) {
      assert.equal(h.dispatchCalls.length, 0, triage.choice);
      assert.equal(decision.intent, null, triage.choice);
    } else {
      assert.equal(h.dispatchCalls.length, 1, triage.choice);
      assert.deepEqual(h.dispatchCalls[0], { kind, dispatch_id: 'd1:dispatch' }, triage.choice);
    }
  }
});

test('3. D1 and D2 fallbacks dispatch with their existing tiers', async () => {
  const fallbacks: readonly [StagePlan, string][] = [
    [{ choice: 'implement', confidence: 0.5 }, 'low_confidence'],
    [{ choice: 'implement', confidence: null }, 'missing_confidence'],
    [{ choice: 'implement', confidence: 1, probabilities: { implement: 0.5, capability: 0.5 } }, 'low_top_p'],
    [{ choice: 'strong' }, 'invalid_answer'],
    [{ mode: 'no_answer' }, 'no_answer'],
  ];
  for (const [triage, reason] of fallbacks) {
    const h = harness({ triage });
    const decision = await run(h);
    assert.equal(decision.status, 'dispatched', reason);
    assert.equal(decision.triage?.observation.reason, reason, reason);
    assert.deepEqual(
      h.dispatchCalls[0],
      {
        kind: 'implement',
        dispatch_id: 'd1:dispatch',
        tier: 'strong',
        ceiling: 'strong',
        tier_source: 'triage_fallback',
      },
      reason,
    );
    assert.equal(
      h.evaluateCalls.some((request) => request.site === 'loop.route'),
      false,
      reason,
    );
  }

  const route = harness({ route: { choice: 'flash', confidence: 0.5 } });
  const decision = await run(route);
  assert.equal(decision.route?.observation.reason, 'low_confidence');
  assert.deepEqual(route.dispatchCalls[0], {
    kind: 'implement',
    dispatch_id: 'd1:dispatch',
    tier: 'standard',
    ceiling: 'standard',
    tier_source: 'route_fallback',
  });
});

test('4. no-dispatch table: stale, mismatch, outage and cancellation at every stage', async () => {
  const stages = ['intake', 'triage', 'route'] as const;
  for (const stage of stages) {
    for (const mode of ['stale', 'mismatch', 'outage'] as const) {
      const plan: Plan =
        stage === 'intake' ? { intake: { mode } } : stage === 'triage' ? { triage: { mode } } : { route: { mode } };
      const h = harness(plan);
      const decision = await run(h);
      assert.equal(h.dispatchCalls.length, 0, `${stage} ${mode}`);
      if (mode === 'outage')
        assert.deepEqual([decision.status, decision.reason], ['paused', 'decision_unavailable'], `${stage} ${mode}`);
      else
        assert.deepEqual(
          [decision.status, decision.reason],
          ['paused', mode === 'stale' ? 'stale_answer' : 'mismatched_answer'],
          `${stage} ${mode}`,
        );
      assert.equal(h.journal.load('d1').decisions.length, 1, `${stage} ${mode}`);
      if (stage === 'triage' && mode === 'stale') {
        // The trap: the pure transition is implement/strong/transition, yet it never dispatches.
        assert.deepEqual(
          [decision.triage?.choice, decision.triage?.tier, decision.triage?.status],
          ['implement', 'strong', 'transition'],
        );
      }
    }

    const controller = new AbortController();
    const h = harness(
      stage === 'intake'
        ? { onEvaluate: (request) => request.site === 'intake.classify' && controller.abort() }
        : stage === 'triage'
          ? { onEvaluate: (request) => request.site === 'loop.triage' && controller.abort() }
          : { onEvaluate: (request) => request.site === 'loop.route' && controller.abort() },
    );
    const decision = await run(h, controller.signal);
    assert.equal(h.dispatchCalls.length, 0, `${stage} cancelled`);
    assert.deepEqual([decision.status, decision.reason], ['paused', 'cancelled'], `${stage} cancelled`);
    assert.equal(h.journal.load('d1').decisions.length, 0, `${stage} cancelled`);
  }
});

test('5. thread intents resolve only to disclosed running thread ids', async () => {
  const threads = [
    { thread_id: 'T1', summary: 'first' },
    { thread_id: 'T2', summary: 'second' },
  ];
  const grounded = harness(
    {
      intake: { choice: 'continue_thread' },
      thread: { value: 'T1', cue: 'T1' },
    },
    { request: makeRequest({ intake: { message: 'continue T1 please', running_threads: threads } }) },
  );
  const groundedDecision = await run(grounded);
  assert.equal(groundedDecision.status, 'dispatched');
  assert.deepEqual(grounded.dispatchCalls[0], {
    kind: 'thread',
    dispatch_id: 'd1:dispatch',
    relation: 'continue_thread',
    thread_ref: 'T1',
  });

  const single = harness(
    { intake: { choice: 'steer' }, thread: { value: null, cue: null } },
    { request: makeRequest({ intake: { message: 'steer please', running_threads: [threads[0]!] } }) },
  );
  const singleDecision = await run(single);
  assert.equal(singleDecision.status, 'dispatched');
  assert.deepEqual(single.dispatchCalls[0], {
    kind: 'thread',
    dispatch_id: 'd1:dispatch',
    relation: 'steer',
    thread_ref: 'T1',
  });

  const ambiguous = harness(
    { intake: { choice: 'queue' }, thread: { value: null, cue: null } },
    { request: makeRequest({ intake: { message: 'queue please', running_threads: threads } }) },
  );
  const ambiguousDecision = await run(ambiguous);
  assert.deepEqual(
    [ambiguousDecision.status, ambiguousDecision.reason, ambiguousDecision.decided_by],
    ['needs_human', 'ambiguous_reference', 'rule'],
  );
  assert.equal(ambiguous.dispatchCalls.length, 0);

  const none = harness(
    { intake: { choice: 'interrupt' }, thread: { value: null, cue: null } },
    { request: makeRequest({ intake: { message: 'interrupt please', running_threads: [] } }) },
  );
  const noneDecision = await run(none);
  assert.deepEqual(
    [noneDecision.status, noneDecision.reason, noneDecision.decided_by],
    ['needs_human', 'no_target', 'rule'],
  );
  assert.equal(none.dispatchCalls.length, 0);

  // A grounded hint never names a thread the caller did not disclose.
  const final = groundedDecision.intake!.extract.at(-1)!;
  const target = resolveThreadTarget(groundedDecision.intake!, threads);
  assert.deepEqual(target, { ok: true, thread_ref: 'T1' });
  assert.ok(threads.some((thread) => thread.thread_id === target.thread_ref));
  assert.equal(final.slots.find((slot) => slot.slot === 'thread_ref')?.value, 'T1');
});

test('6. an accepted intake stop asks the operator and dispatches nothing', async () => {
  const h = harness({ intake: { choice: 'stop' } });
  const decision = await run(h);
  assert.deepEqual(
    [decision.status, decision.reason, decision.decided_by, decision.choice],
    ['needs_human', 'irreversible', 'rule', 'stop'],
  );
  assert.equal(h.dispatchCalls.length, 0);
  assert.equal(
    h.evaluateCalls.some((request) => request.site === 'loop.triage'),
    false,
  );
});

test('7. intake asks never reach D1', async () => {
  const low = harness({ intake: { choice: 'new_thread', confidence: 0.5 } });
  const lowDecision = await run(low);
  assert.deepEqual([lowDecision.status, lowDecision.decided_by], ['needs_human', 'intake']);
  assert.equal(lowDecision.reason, 'low_confidence');
  assert.equal(low.evaluateCalls.length, 1);
  assert.equal(low.generateCalls.length, 1);

  const ambiguous = harness(
    { intake: { choice: 'new_thread' }, thread: { value: null, cue: 'T1' } },
    {
      request: makeRequest({
        intake: {
          message: 'which one T1?',
          running_threads: [
            { thread_id: 'T1', summary: 'first' },
            { thread_id: 'T2', summary: 'second' },
          ],
        },
      }),
    },
  );
  const ambiguousDecision = await run(ambiguous);
  assert.deepEqual(
    [ambiguousDecision.status, ambiguousDecision.reason, ambiguousDecision.decided_by],
    ['needs_human', 'ambiguous_reference', 'intake'],
  );
  assert.equal(ambiguous.evaluateCalls.length, 0);
  assert.equal(ambiguous.generateCalls.length, 1);
});

test('8. receipts map to the policy table and never keep error text', async () => {
  const map: readonly [string, string, string | null][] = [
    ['dispatched', 'dispatched', null],
    ['refused-approval', 'needs_human', 'approval_required'],
    ['refused-budget', 'paused', 'budget'],
    ['refused-no_grant', 'refused', 'refused'],
    ['refused-unknown_target', 'refused', 'refused'],
    ['refused-conflict', 'refused', 'refused'],
    ['mismatch', 'paused', 'dispatch_unconfirmed'],
    ['unsafe', 'paused', 'dispatch_unconfirmed'],
    ['throw', 'paused', 'dispatch_unconfirmed'],
  ];
  for (const [kind, status, reason] of map) {
    const h = harness(
      {},
      {
        dispatch: async (intent) => {
          if (kind === 'throw') throw new Error('CANARY-error');
          if (kind === 'mismatch') return { status: 'dispatched', dispatch_id: 'other:dispatch', ref: 'action:1' };
          if (kind === 'unsafe')
            return { status: 'dispatched', dispatch_id: intent.dispatch_id, ref: 'sk-CANARY-error' };
          if (kind === 'refused-approval')
            return { status: 'refused', dispatch_id: intent.dispatch_id, reason: 'approval_required' };
          if (kind === 'refused-budget')
            return { status: 'refused', dispatch_id: intent.dispatch_id, reason: 'budget' };
          if (kind === 'refused-no_grant')
            return { status: 'refused', dispatch_id: intent.dispatch_id, reason: 'no_grant' };
          if (kind === 'refused-unknown_target')
            return { status: 'refused', dispatch_id: intent.dispatch_id, reason: 'unknown_target' };
          if (kind === 'refused-conflict')
            return { status: 'refused', dispatch_id: intent.dispatch_id, reason: 'conflict' };
          return dispatched(intent);
        },
      },
    );
    const decision = await run(h);
    assert.equal(decision.status, status, kind);
    if (reason !== null) assert.equal(decision.reason, reason, kind);
    assertRecordCopiesNoText(decision, ['CANARY-error', 'sk-CANARY']);
    assert.equal(JSON.stringify(decision).includes('CANARY-error'), false, kind);
  }
});

test('9. the intent is durable before dispatch and recovery never implicitly re-presents it', async () => {
  const storage = new MemoryDispatchJournal();
  const effects = new Set<string>();
  let crash = true;
  const crashing: DispatchJournal = {
    load: (id) => storage.load(id),
    checkpoint: (entry) => storage.checkpoint(entry),
    claim: (id, intent, entry) => storage.claim(id, intent, entry),
    append: (decision) => {
      if (crash) {
        crash = false;
        throw new Error('crash');
      }
      storage.append(decision);
    },
  };
  const first = harness(
    {},
    {
      journal: crashing,
      dispatch: async (intent) => {
        assert.deepEqual(storage.load('d1').checkpoint?.intent, intent);
        effects.add(intent.dispatch_id);
        return dispatched(intent);
      },
    },
  );
  await assert.rejects(run(first), /crash/);
  assert.deepEqual(storage.load('d1').decisions, []);
  assert.notEqual(storage.load('d1').checkpoint?.intent, null);

  const implicit = harness(
    {},
    {
      journal: storage,
      dispatch: async (intent) => {
        effects.add(intent.dispatch_id);
        return dispatched(intent);
      },
    },
  );
  const unconfirmed = await run(implicit);
  assert.deepEqual([unconfirmed.status, unconfirmed.reason], ['paused', 'dispatch_unconfirmed']);
  assert.equal(unconfirmed.intent?.dispatch_id, 'd1:dispatch');
  assert.equal(implicit.dispatchCalls.length, 0);
  assert.equal(implicit.generateCalls.length, 0);
  assert.equal(implicit.evaluateCalls.length, 0);

  const resumed = harness(
    {},
    {
      journal: storage,
      request: makeRequest({ resume: true }),
      dispatch: async (intent) => {
        effects.add(intent.dispatch_id);
        return dispatched(intent);
      },
    },
  );
  const confirmed = await run(resumed);
  assert.equal(confirmed.status, 'dispatched');
  assert.equal(resumed.dispatchCalls.length, 1);
  assert.equal(resumed.dispatchCalls[0]!.dispatch_id, 'd1:dispatch');
  assert.equal(effects.size, 1);
  assert.equal(resumed.generateCalls.length, 0);
  assert.equal(resumed.evaluateCalls.length, 0);
});

test('10. recovery reuses paid answers and never reuses a request id', async () => {
  const storage = new MemoryDispatchJournal();
  let crash = true;
  const crashing: DispatchJournal = {
    load: (id) => storage.load(id),
    checkpoint: (entry) => {
      storage.checkpoint(entry);
      if (crash && entry.triage !== null && entry.route === null) {
        crash = false;
        throw new Error('crash-after-d1');
      }
    },
    claim: (id, intent, entry) => storage.claim(id, intent, entry),
    append: (decision) => storage.append(decision),
  };
  const first = harness({}, { journal: crashing });
  await assert.rejects(run(first), /crash-after-d1/);
  const after = storage.load('d1');
  assert.notEqual(after.checkpoint?.intake, null);
  assert.notEqual(after.checkpoint?.triage, null);
  assert.equal(after.checkpoint?.route, null);

  const reused = harness({}, { journal: storage });
  const decision = await run(reused);
  assert.equal(decision.status, 'dispatched');
  assert.deepEqual(
    reused.evaluateCalls.map((request) => request.site),
    ['loop.route'],
  );
  assert.deepEqual(
    reused.generateCalls.map((request) => request.site),
    ['loop.route.extract'],
  );

  // A crash after recording the ask count, but before the answer, re-asks with :e2.
  const outage = harness({ route: { mode: 'outage' } });
  await run(outage);
  const checkpoint = outage.journal.load('d1').checkpoint!;
  assert.equal(checkpoint.asks.route, 1);
  outage.journal.checkpoint({ ...checkpoint, route: null });
  const retry = harness({}, { journal: outage.journal, request: makeRequest({ resume: true }) });
  const retried = await run(retry);
  assert.equal(retried.status, 'dispatched');
  assert.equal(retry.evaluateCalls.find((request) => request.site === 'loop.route')?.request_id, 'd1:route:e2');

  // A revision change before reuse pauses without any call.
  const moved = harness({ route: { mode: 'outage' } });
  await run(moved);
  moved.clock.set(2, 20);
  const stale = harness({}, { journal: moved.journal, clock: moved.clock, request: makeRequest({ resume: true }) });
  const staleDecision = await run(stale);
  assert.deepEqual([staleDecision.status, staleDecision.reason], ['paused', 'stale_answer']);
  assert.equal(stale.generateCalls.length, 0);
  assert.equal(stale.evaluateCalls.length, 0);
  assert.equal(stale.dispatchCalls.length, 0);
});

test('11. duplicate delivery returns the recorded decision and emits nothing', async () => {
  const seen = collector();
  const h = harness({}, { weft: seen.port });
  const first = await run(h);
  const emitted = seen.records.length;
  assert.ok(emitted > 0);

  const duplicate = harness({}, { journal: h.journal, weft: seen.port });
  const second = await run(duplicate);
  assert.deepEqual(second, first);
  assert.equal(duplicate.generateCalls.length, 0);
  assert.equal(duplicate.evaluateCalls.length, 0);
  assert.equal(duplicate.dispatchCalls.length, 0);
  assert.equal(duplicate.journal.load('d1').decisions.length, 1);
  assert.equal(seen.records.length, emitted);
});

test('12. concurrent decisions bind their own ids; one claim wins per id; the request is captured', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal = new MemoryDispatchJournal();
  const a = harness(
    { gate: { match: (id) => id.startsWith('a:'), promise: gate } },
    { journal, request: makeRequest({ request_id: 'a' }) },
  );
  const b = harness({}, { journal, request: makeRequest({ request_id: 'b' }) });
  const pa = run(a);
  const pb = run(b);
  release();
  const [da, db] = await Promise.all([pa, pb]);
  assert.equal(da.intent?.dispatch_id, 'a:dispatch');
  assert.equal(db.intent?.dispatch_id, 'b:dispatch');
  assert.deepEqual(
    a.dispatchCalls.map((intent) => intent.dispatch_id),
    ['a:dispatch'],
  );
  assert.deepEqual(
    b.dispatchCalls.map((intent) => intent.dispatch_id),
    ['b:dispatch'],
  );

  const shared = new MemoryDispatchJournal();
  const one = harness({}, { journal: shared });
  const two = harness({}, { journal: shared });
  const [d1, d2] = await Promise.all([run(one), run(two)]);
  assert.deepEqual([d1.status, d2.status].sort(), ['dispatched', 'paused']);
  assert.equal(one.dispatchCalls.length + two.dispatchCalls.length, 1);
  const loser = d1.status === 'paused' ? d1 : d2;
  assert.equal(loser.reason, 'dispatch_unconfirmed');

  const request = makeRequest();
  const mutable = request as unknown as {
    intake: { message: string };
    triage_context: string;
    route_context: string;
  };
  const mutating = harness(
    {
      onEvaluate: (incoming) => {
        if (incoming.site === 'intake.classify') {
          mutable.intake.message = 'CANARY-mutated';
          mutable.triage_context = 'CANARY-mutated';
          mutable.route_context = 'CANARY-mutated';
        }
      },
    },
    { request },
  );
  const decision = await run(mutating);
  const triage = mutating.evaluateCalls.find((incoming) => incoming.site === 'loop.triage')!;
  assert.deepEqual(triage.state, { request: MESSAGE, context: TRIAGE_CONTEXT });
  assert.equal(JSON.stringify(decision).includes('CANARY-mutated'), false);
});

test('13. cancellation writes nothing and leaves the intent observable', async () => {
  const before = harness();
  const controller = new AbortController();
  controller.abort();
  const early = await run(before, controller.signal);
  assert.deepEqual([early.status, early.reason], ['paused', 'cancelled']);
  assert.equal(before.generateCalls.length, 0);
  assert.equal(before.evaluateCalls.length, 0);
  assert.equal(before.journal.load('d1').decisions.length, 0);

  const during = new AbortController();
  const mid = harness({
    onEvaluate: (incoming) => incoming.site === 'loop.triage' && during.abort(),
  });
  const midDecision = await run(mid, during.signal);
  assert.deepEqual([midDecision.status, midDecision.reason], ['paused', 'cancelled']);
  assert.equal(
    mid.evaluateCalls.some((incoming) => incoming.site === 'loop.route'),
    false,
  );
  assert.equal(mid.dispatchCalls.length, 0);
  assert.equal(mid.journal.load('d1').decisions.length, 0);
  assert.equal(mid.journal.load('d1').checkpoint?.intent, null);

  const dispatchController = new AbortController();
  const crash = harness(
    {},
    {
      dispatch: async (intent) => {
        dispatchController.abort();
        return dispatched(intent);
      },
    },
  );
  const dispatchedThenCancelled = await run(crash, dispatchController.signal);
  assert.deepEqual([dispatchedThenCancelled.status, dispatchedThenCancelled.reason], ['paused', 'cancelled']);
  assert.equal(crash.journal.load('d1').decisions.length, 0);
  assert.equal(crash.journal.load('d1').checkpoint?.intent?.dispatch_id, 'd1:dispatch');

  const next = harness({}, { journal: crash.journal });
  const unconfirmed = await run(next);
  assert.deepEqual([unconfirmed.status, unconfirmed.reason], ['paused', 'dispatch_unconfirmed']);
  assert.equal(next.dispatchCalls.length, 0);
});

test('14. a stage outage pauses, and resume re-asks only that stage', async () => {
  const first = harness({ route: { mode: 'outage' } });
  const paused = await run(first);
  assert.deepEqual([paused.status, paused.reason], ['paused', 'decision_unavailable']);

  const withoutResume = harness({}, { journal: first.journal });
  const repeated = await run(withoutResume);
  assert.deepEqual([repeated.status, repeated.reason], ['paused', 'decision_unavailable']);
  assert.equal(withoutResume.generateCalls.length, 0);
  assert.equal(withoutResume.evaluateCalls.length, 0);
  assert.equal(withoutResume.dispatchCalls.length, 0);

  const resume = harness({}, { journal: first.journal, request: makeRequest({ resume: true }) });
  const recovered = await run(resume);
  assert.equal(recovered.status, 'dispatched');
  assert.deepEqual(
    resume.evaluateCalls.map((request) => [request.site, request.request_id]),
    [['loop.route', 'd1:route:e2']],
  );
  assert.deepEqual(
    resume.generateCalls.map((request) => request.site),
    ['loop.route.extract'],
  );
});

test('15. transitionDispatch replays the live decision and refuses impossible stages', async () => {
  const h = harness({ route: { choice: 'strong' } });
  const live = await run(h);
  const checkpoint = h.journal.load('d1').checkpoint!;
  const replayed = transitionDispatch(h.request, checkpoint, live.receipt, live.entry);
  assert.deepEqual(replayed, live);

  const noTriage: DispatchCheckpoint = { ...checkpoint, triage: null };
  assert.throws(() => transitionDispatch(h.request, noTriage, live.receipt), /triage/);

  const notNewThread: DispatchCheckpoint = {
    ...checkpoint,
    intake: { ...checkpoint.intake!, choice: 'continue_thread' },
  };
  assert.throws(() => transitionDispatch(h.request, notNewThread, live.receipt), /intake/);

  const fallbackTriage: DispatchCheckpoint = {
    ...checkpoint,
    triage: {
      ...checkpoint.triage!,
      choice: 'implement',
      tier: 'strong',
      status: 'transition',
      observation: {
        ...checkpoint.triage!.observation,
        accepted: false,
        fallback_used: true,
        reason: 'low_confidence',
      },
    },
  };
  assert.throws(() => transitionDispatch(h.request, fallbackTriage, live.receipt), /fallback/);
});

test('16. records keep their exact key order and carry no authority or copied text', async () => {
  const h = harness(
    { intake: { choice: 'continue_thread' }, thread: { value: 'T1', cue: 'T1' } },
    {
      request: makeRequest({
        intake: { message: 'continue T1', running_threads: [{ thread_id: 'T1', summary: 'alpha' }] },
      }),
    },
  );
  const decision = await run(h);
  assert.deepEqual(Object.keys(decision), [
    'schema',
    'decision_id',
    'entry',
    'state_revision',
    'decided_by',
    'choice',
    'status',
    'reason',
    'intent',
    'receipt',
    'intake',
    'triage',
    'route',
  ]);
  assert.deepEqual(Object.keys(decision.intent!), ['kind', 'dispatch_id', 'relation', 'thread_ref']);
  assert.deepEqual(Object.keys(decision.receipt!), ['status', 'dispatch_id', 'ref']);
  const checkpoint = h.journal.load('d1').checkpoint!;
  assert.deepEqual(Object.keys(checkpoint), [
    'schema',
    'decision_id',
    'state_revision',
    'state_updated_at',
    'asks',
    'intake',
    'triage',
    'route',
    'intent',
  ]);
  assert.deepEqual(Object.keys(checkpoint.asks), ['intake', 'triage', 'route']);
  assertNoAuthorityKeys(decision);
  assertNoAuthorityKeys(checkpoint);
  assertRecordCopiesNoText(decision, CANARIES);
  assertRecordCopiesNoText(checkpoint, CANARIES);
  assertNoCopiedText(h.journal.load('d1'), CANARIES);

  const implement = harness({});
  const implemented = await run(implement);
  assert.deepEqual(Object.keys(implemented.intent!), ['kind', 'dispatch_id', 'tier', 'ceiling', 'tier_source']);
  assert.deepEqual(Object.keys(implement.journal.load('d1').checkpoint!), Object.keys(checkpoint));
});

test('17. Weft judgment records are built once per fresh observation and delivered last', async () => {
  const seen = collector();
  const journal = new MemoryDispatchJournal();
  let appended = 0;
  const port: WeftPort = {
    trace_id: 'trace-1',
    emitter_id: 'loom.dispatch',
    emit: (record) => {
      assert.equal(journal.load('d1').decisions.length, 1);
      appended += 1;
      seen.records.push(record);
    },
  };
  const h = harness({}, { journal, weft: port });
  const decision = await run(h);
  assert.equal(decision.status, 'dispatched');
  assert.equal(appended, 3);
  assert.deepEqual(
    seen.records.map((record) => record.fields['site']),
    ['intake.classify', 'loop.triage', 'loop.route'],
  );
  assert.deepEqual(
    seen.records.map((record) => record.record_id),
    ['loom.dispatch:judgment:d1:intake', 'loom.dispatch:judgment:d1:triage', 'loom.dispatch:judgment:d1:route'],
  );
  assert.deepEqual(
    seen.records.map((record) => record.sequence),
    [1, 2, 3],
  );
  for (const record of seen.records) {
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.equal(record.kind, 'judgment');
    assert.deepEqual(Object.keys(record.fields), ['site', 'request_ref', 'accepted', 'confidence']);
  }

  const silent = harness();
  const silentDecision = await run(silent);
  assert.deepEqual(silentDecision, decision);

  const throwing = harness(
    {},
    {
      weft: {
        trace_id: 'trace-1',
        emitter_id: 'loom.dispatch',
        emit: () => {
          throw new Error('sink');
        },
      },
    },
  );
  assert.deepEqual(await run(throwing), decision);

  const rejecting = harness(
    {},
    {
      weft: { trace_id: 'trace-1', emitter_id: 'loom.dispatch', emit: () => Promise.reject(new Error('sink')) },
    },
  );
  assert.deepEqual(await run(rejecting), decision);
  await Promise.resolve();

  const built = dispatchJudgments(
    [
      {
        schema: 'decision-site@1',
        site: 'loop.triage',
        question: 'q',
        request_id: 'r',
        state_revision: 1,
        answer: 'implement',
        confidence: 0.9,
        top_p: 1,
        accepted: true,
        fallback_used: false,
        reason: 'accepted',
        provider_request_id: null,
      },
    ],
    { trace_id: 't', emitter_id: 'e' },
    7,
  );
  assert.equal(built[0]!.sequence, 7);
});

test('18. D1 and D2 requests are byte-identical to direct evaluateSite requests', async () => {
  const h = harness({ triageIntent: 'not in the state', routeIntent: 'not in the state' });
  const decision = await run(h);
  assert.equal(decision.status, 'dispatched');
  const triage = h.evaluateCalls.find((request) => request.site === 'loop.triage')!;
  const route = h.evaluateCalls.find((request) => request.site === 'loop.route')!;

  const triageState = { request: MESSAGE, context: TRIAGE_CONTEXT };
  const triageOrigin = gateExtract(
    loopTriageExtractSchema(),
    JSON.stringify(triageState),
    {
      intent: { value: MESSAGE },
    },
    { site: 'loop.triage', request_id: 'd1:triage:x1', state_revision: REVISION.state_revision },
  );
  const directTriage = harness();
  await evaluateSite(
    'loop.triage',
    {
      request_id: 'd1:triage',
      ...REVISION,
      state: triageState,
      terms,
      needs_dispatch: true,
      origin: modelOrigin(triageOrigin),
    },
    directTriage.ports,
    directTriage.clock.now,
  );
  assert.deepEqual(triage, directTriage.evaluateCalls[0]);

  const routeState = { unit_of_work: MESSAGE, context: ROUTE_CONTEXT };
  const routeOrigin = gateExtract(
    loopRouteExtractSchema(),
    JSON.stringify(routeState),
    {
      intent: { value: MESSAGE },
    },
    { site: 'loop.route', request_id: 'd1:route:x1', state_revision: REVISION.state_revision },
  );
  const directRoute = harness();
  await evaluateSite(
    'loop.route',
    {
      request_id: 'd1:route',
      ...REVISION,
      state: routeState,
      terms,
      needs_dispatch: true,
      origin: modelOrigin(routeOrigin),
    },
    directRoute.ports,
    directRoute.clock.now,
  );
  assert.deepEqual(route, directRoute.evaluateCalls[0]);

  assert.equal(SITE_POLICY['loop.triage'].confidence, 0.8);
  assert.equal(SITE_POLICY['loop.route'].confidence, 0.75);
  assert.ok(Object.isFrozen(SITE_POLICY));
});

test('19. an unsafe or over-96-character request id throws before any call', async () => {
  for (const request_id of ['sk-CANARY', 'a'.repeat(97)]) {
    const h = harness({}, { request: makeRequest({ request_id }) });
    await assert.rejects(run(h));
    assert.equal(h.generateCalls.length, 0);
    assert.equal(h.evaluateCalls.length, 0);
    assert.equal(h.dispatchCalls.length, 0);
    assert.deepEqual(h.journal.load(request_id).decisions, []);
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

function withRouteObservation(
  checkpoint: DispatchCheckpoint,
  patch: Partial<NonNullable<DispatchCheckpoint['route']>['observation']>,
): DispatchCheckpoint {
  const route = checkpoint.route!;
  return { ...checkpoint, route: { ...route, observation: { ...route.observation, ...patch } } };
}

test('20. a losing concurrent delivery cannot rewrite the winner stages', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal = new MemoryDispatchJournal();
  const loser = harness(
    { route: { choice: 'flash' }, gate: { match: (id) => id === 'd1:route', promise: gate } },
    { journal },
  );
  const pending = run(loser);
  await waitUntil(() => loser.evaluateCalls.some((request) => request.site === 'loop.route'));

  const winner = harness({ route: { choice: 'strong' } }, { journal });
  const won = await run(winner);
  assert.equal(won.status, 'dispatched');
  assert.equal(won.intent?.kind, 'implement');
  release();
  const lost = await pending;
  assert.deepEqual([lost.status, lost.reason], ['paused', 'dispatch_unconfirmed']);
  assert.equal(loser.dispatchCalls.length, 0);

  const checkpoint = journal.load('d1').checkpoint!;
  assert.equal(checkpoint.route?.observation.request_id, 'd1:route:e2');
  assert.equal(checkpoint.route?.choice, 'strong');
  assert.deepEqual(checkpoint.intent, won.intent);
  assert.deepEqual(transitionDispatch(winner.request, checkpoint, won.receipt, won.entry), won);
});

test('21. a losing concurrent final cannot append after the winner dispatches', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal = new MemoryDispatchJournal();
  const loser = harness(
    { route: { mode: 'stale' }, gate: { match: (id) => id === 'd1:route', promise: gate } },
    { journal },
  );
  const pending = run(loser);
  await waitUntil(() => loser.evaluateCalls.some((request) => request.site === 'loop.route'));

  const winner = harness({ route: { choice: 'strong' } }, { journal });
  const won = await run(winner);
  assert.equal(won.status, 'dispatched');
  release();
  const lost = await pending;
  assert.deepEqual([lost.status, lost.reason], ['paused', 'stale_answer']);

  const loaded = journal.load('d1');
  assert.equal(loaded.decisions.length, 1);
  assert.deepEqual(loaded.decisions[0], won);
  const duplicate = harness({}, { journal });
  assert.deepEqual(await run(duplicate), won);
  assert.equal(duplicate.dispatchCalls.length, 0);
});

test('22. replay rejects foreign and below-threshold stage records', async () => {
  const h = harness({ route: { choice: 'strong' } });
  const live = await run(h);
  const checkpoint = h.journal.load('d1').checkpoint!;
  assert.deepEqual(transitionDispatch(h.request, checkpoint, live.receipt, live.entry), live);

  const forged: readonly [string, DispatchCheckpoint, RegExp][] = [
    ['foreign request', withRouteObservation(checkpoint, { request_id: 'other:route' }), /request/],
    ['foreign site', withRouteObservation(checkpoint, { site: 'loop.triage' }), /site/],
    ['foreign revision', withRouteObservation(checkpoint, { state_revision: 2 }), /revision/],
    ['below threshold', withRouteObservation(checkpoint, { confidence: 0.5 }), /confidence/],
  ];
  for (const [label, value, reason] of forged)
    assert.throws(() => transitionDispatch(h.request, value, live.receipt), reason, label);
});

test('23. live recovery rejects foreign and below-threshold loaded stages before dispatch', async () => {
  const h = harness({ route: { choice: 'strong' } });
  const live = await run(h);
  const checkpoint = h.journal.load('d1').checkpoint!;
  const forged: readonly [string, DispatchCheckpoint, RegExp][] = [
    ['foreign request', withRouteObservation(checkpoint, { request_id: 'other:route' }), /request/],
    ['foreign site', withRouteObservation(checkpoint, { site: 'loop.triage' }), /site/],
    ['foreign revision', withRouteObservation(checkpoint, { state_revision: 2 }), /revision/],
    ['below threshold', withRouteObservation(checkpoint, { confidence: 0.5 }), /confidence/],
  ];
  for (const [label, value, reason] of forged) {
    const recovery = harness({}, { journal: forgedJournal(value), request: makeRequest({ resume: true }) });
    await assert.rejects(run(recovery), reason, label);
    assert.equal(recovery.generateCalls.length, 0, label);
    assert.equal(recovery.evaluateCalls.length, 0, label);
    assert.equal(recovery.dispatchCalls.length, 0, label);
  }
});

function forgedJournal(checkpoint: DispatchCheckpoint): DispatchJournal {
  return {
    load: () => ({ checkpoint, decisions: [] }),
    checkpoint: () => {},
    claim: () => false,
    append: () => {},
  };
}

test('24. recovery rejects a recorded intent that disagrees with the recorded stages', async () => {
  const h = harness({ route: { choice: 'strong' } });
  const live = await run(h);
  const checkpoint = h.journal.load('d1').checkpoint!;
  const recorded = checkpoint.intent as Extract<DispatchIntent, { kind: 'implement' }>;
  const mismatched: DispatchCheckpoint = {
    ...checkpoint,
    intent: { ...recorded, tier: 'flash', ceiling: 'flash' },
  };

  assert.throws(() => transitionDispatch(h.request, mismatched, live.receipt, live.entry), /intent/);
  for (const resume of [false, true]) {
    const recovery = harness({}, { journal: forgedJournal(mismatched), request: makeRequest({ resume }) });
    await assert.rejects(run(recovery), /intent/, String(resume));
    assert.equal(recovery.generateCalls.length, 0, String(resume));
    assert.equal(recovery.evaluateCalls.length, 0, String(resume));
    assert.equal(recovery.dispatchCalls.length, 0, String(resume));
  }
});

test('25. extract-only checkpoints must match the closed stopped-outcome table', async () => {
  const threadRequest = makeRequest({
    intake: { message: 'continue T1', running_threads: [{ thread_id: 'T1', summary: 'alpha' }] },
  });
  const threadLive = harness(
    { intake: { choice: 'continue_thread' }, thread: { value: 'T1', cue: 'T1' } },
    { request: threadRequest },
  );
  await run(threadLive);
  const threadBase = threadLive.journal.load('d1').checkpoint!;

  const routeRequest = makeRequest();
  const routeLive = harness({ route: { choice: 'strong' } }, { request: routeRequest });
  await run(routeLive);
  const routeBase = routeLive.journal.load('d1').checkpoint!;

  const twoThreadRequest = makeRequest({
    intake: {
      message: 'continue T1',
      running_threads: [
        { thread_id: 'T1', summary: 'first' },
        { thread_id: 'T2', summary: 'second' },
      ],
    },
  });
  const twoThreadLive = harness(
    { intake: { choice: 'continue_thread' }, thread: { value: 'T1', cue: 'T1' } },
    { request: twoThreadRequest },
  );
  await run(twoThreadLive);
  const twoThreadBase = twoThreadLive.journal.load('d1').checkpoint!;

  const extractOnly = (
    base: DispatchCheckpoint,
    patch: Partial<NonNullable<DispatchCheckpoint['intake']>>,
  ): DispatchCheckpoint => ({
    ...base,
    intake: { ...base.intake!, site: null, decided_by: 'extract', ...patch },
  });

  const cases: readonly [string, DispatchRequest, DispatchCheckpoint][] = [
    [
      'executable thread choice',
      threadRequest,
      extractOnly(threadBase, {
        choice: 'continue_thread',
        status: 'transition',
        reason: 'accepted',
      }),
    ],
    [
      'executable new thread',
      routeRequest,
      extractOnly(routeBase, {
        choice: 'new_thread',
        status: 'transition',
        reason: 'accepted',
      }),
    ],
    [
      'executable stop',
      threadRequest,
      extractOnly(threadBase, {
        choice: 'stop',
        status: 'transition',
        reason: 'accepted',
      }),
    ],
    [
      'ask_user transitioning',
      threadRequest,
      extractOnly(threadBase, {
        choice: 'ask_user',
        status: 'transition',
        reason: 'accepted',
      }),
    ],
    [
      'ask_user paused accepted',
      threadRequest,
      extractOnly(threadBase, {
        choice: 'ask_user',
        status: 'paused',
        reason: 'accepted',
      }),
    ],
    [
      'cancelled without evidence',
      threadRequest,
      extractOnly(threadBase, {
        choice: 'ask_user',
        status: 'paused',
        reason: 'cancelled',
      }),
    ],
    [
      'stale without evidence',
      threadRequest,
      extractOnly(threadBase, {
        choice: 'ask_user',
        status: 'needs_human',
        reason: 'stale_answer',
      }),
    ],
    [
      'ambiguous without evidence',
      threadRequest,
      extractOnly(threadBase, {
        choice: 'ask_user',
        status: 'needs_human',
        reason: 'ambiguous_reference',
      }),
    ],
    [
      'ambiguous with grounded evidence',
      twoThreadRequest,
      extractOnly(twoThreadBase, {
        choice: 'ask_user',
        status: 'needs_human',
        reason: 'ambiguous_reference',
      }),
    ],
  ];

  for (const [label, request, value] of cases) {
    assert.throws(() => transitionDispatch(request, value, null), /extract-only/, `${label} replay`);
    const recovery = harness({}, { journal: forgedJournal(value), request: makeRequest({ resume: true }) });
    await assert.rejects(run(recovery), /extract-only/, `${label} live`);
    assert.equal(recovery.generateCalls.length, 0, `${label} live`);
    assert.equal(recovery.evaluateCalls.length, 0, `${label} live`);
    assert.equal(recovery.dispatchCalls.length, 0, `${label} live`);
  }
});

test('26. legitimate extract-only stopped outcomes replay unchanged', async () => {
  const request = makeRequest({
    intake: {
      message: 'which one T1?',
      running_threads: [
        { thread_id: 'T1', summary: 'first' },
        { thread_id: 'T2', summary: 'second' },
      ],
    },
  });
  const h = harness({ intake: { choice: 'new_thread' }, thread: { value: null, cue: 'T1' } }, { request });
  const live = await run(h);
  assert.deepEqual([live.status, live.reason, live.intake?.site], ['needs_human', 'ambiguous_reference', null]);
  const checkpoint = h.journal.load('d1').checkpoint!;
  assert.deepEqual(transitionDispatch(request, checkpoint, null, live.entry), live);

  const final = checkpoint.intake!.extract.at(-1)!;
  for (const [status, reason] of [
    ['paused', 'cancelled'],
    ['needs_human', 'stale_answer'],
  ] as const) {
    const variant: DispatchCheckpoint = {
      ...checkpoint,
      intake: {
        ...checkpoint.intake!,
        status,
        reason,
        extract: [...checkpoint.intake!.extract.slice(0, -1), { ...final, verdict: 'original_only', reason }],
      },
    };
    const replayed = transitionDispatch(request, variant, null, live.entry);
    assert.deepEqual([replayed.status, replayed.reason, replayed.intake?.site], ['paused', reason, null]);
  }
});
