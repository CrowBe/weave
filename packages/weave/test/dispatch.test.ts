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
  decide1Inputs,
  dispatchDecided,
  resolveThreadTarget,
  transitionDispatch,
  type DispatchCheckpoint,
  type DispatchDecision,
  type DispatchIntent,
  type DispatchJournal,
  type DispatchPorts,
  type DispatchReceipt,
  type DispatchRequest,
  type DispatchSettlementPort,
} from '../src/dispatch.js';
import { DECIDE1_RULE_TABLE, decideBand } from '../src/decide1.js';
import { decideIntake } from '../src/intake.js';
import { decideTriage, decideLoopRoute } from '../src/sites/loop-decide.js';
import { gateExtract } from '../src/sites/extract.js';
import { evaluateSite, modelOrigin, SITE_POLICY, transitionSite, type SiteState } from '../src/sites/index.js';
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

type ShadowMode = 'true' | 'false' | 'throw' | 'budget' | 'malformed' | 'foreign' | 'no_answer';
type Mode = 'ok' | 'stale' | 'mismatch' | 'outage' | 'no_answer' | 'paused';
interface StagePlan {
  readonly choice?: string;
  readonly mode?: Mode;
  readonly confidence?: number | null;
  readonly probabilities?: Readonly<Record<string, number>>;
}
interface Plan {
  readonly roles?: readonly string[] | 'invalid' | 'outage' | 'foreign' | 'stale' | 'budget';
  readonly shadow?: ShadowMode;
  readonly intake?: StagePlan;
  readonly triage?: StagePlan;
  readonly route?: StagePlan;
  readonly thread?: { readonly value: string | null; readonly cue: string | null };
  readonly intakeExtract?: 'outage' | 'mismatch' | 'garbage' | 'stale' | 'paused';
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

/** A gateway budget pause riding on an accepted answer: still an outage for every site and extract. */
function budgetPause(request_id: string, site: string) {
  return {
    type: 'loop.paused',
    policy: 'budget.policy@1',
    request_id,
    site,
    reason: 'quota_unknown',
    until: null,
  } as const;
}

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
    ...(mode === 'paused' ? { paused: budgetPause(request.request_id, request.site) } : {}),
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
        if (plan.intakeExtract === 'outage') throw new Error('CANARY-error');
        if (plan.intakeExtract === 'stale') clock.advance();
        if (plan.intakeExtract === 'mismatch')
          return { ...acceptedGeneration(request, null), request_id: 'other-request' } as GenerationOutcome;
        if (plan.intakeExtract === 'paused')
          return {
            ...acceptedGeneration(request, { thread_ref: { value: null, cue: null }, request: { value: null } }),
            paused: budgetPause(request.request_id, request.site),
          };
        if (plan.intakeExtract === 'garbage')
          return { ...acceptedGeneration(request, null), text: 'not json' } as GenerationOutcome;
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
      if (request.site.startsWith('decide1.')) {
        if (plan.shadow === 'throw') throw new Error('CANARY-error');
        const outcome = {
          status: 'accepted',
          kind: 'boolean',
          request_id: request.request_id,
          site: request.site,
          answers: {
            decision:
              plan.shadow === 'malformed'
                ? { type: 'boolean', probability: 2 }
                : { type: 'boolean', probability: plan.shadow === 'false' ? 0 : 1 },
          },
          confidence: { decision: 1 },
          routed_unit_id: 'shadow.fake',
          provider_response_id: 'shadow-provider',
          attempts: [],
          spent: 0,
          uncertainty: [],
          ...(plan.shadow === 'budget' ? { paused: budgetPause(request.request_id, request.site) } : {}),
        };
        if (plan.shadow === 'foreign') outcome.request_id = 'foreign';
        return (plan.shadow === 'no_answer'
          ? blockedChoice(request)
          : outcome) as unknown as EvaluationOutcome<'choice'>;
      }
      if (request.site === 'spawn.roles') {
        if (plan.roles === 'outage') throw new Error('CANARY-error');
        if (plan.roles === 'stale') clock.advance();
        const vector = Array.isArray(plan.roles) ? plan.roles : Object.keys(request.questions).map(() => 'edit');
        return {
          status: 'accepted',
          kind: 'choice',
          request_id: plan.roles === 'foreign' ? 'foreign' : request.request_id,
          site: request.site,
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key, i) => [
              key,
              {
                type: 'choice',
                choice: plan.roles === 'invalid' ? 'unknown' : vector[i],
                probabilities: { [vector[i]!]: 1 },
              },
            ]),
          ),
          confidence: Object.fromEntries(Object.keys(request.questions).map((key) => [key, 1])),
          routed_unit_id: 'fixture',
          provider_response_id: 'roles-provider',
          attempts: [],
          spent: 0,
          uncertainty: [],
          ...(plan.roles === 'budget' ? { paused: budgetPause(request.request_id, request.site) } : {}),
        } as unknown as EvaluationOutcome<'choice'>;
      }
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
    readonly settlement?: DispatchSettlementPort;
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
    ...(options.settlement === undefined ? {} : { settlement: options.settlement }),
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
  assert.deepEqual(
    h.events.filter((event) => !event.startsWith('evaluate:decide1.')),
    [
      'generate:intake.extract',
      'evaluate:intake.classify',
      'generate:loop.triage.extract',
      'evaluate:loop.triage',
      'generate:loop.route.extract',
      'evaluate:loop.route',
      'dispatch:implement',
    ],
  );
  assert.deepEqual(
    h.evaluateCalls.filter((request) => !request.site.startsWith('decide1.')).map((request) => request.request_id),
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
    assert.equal(decision.triage?.site.observation.reason, reason, reason);
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
  assert.equal(decision.route?.site.observation.reason, 'low_confidence');
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
          [decision.triage?.site.choice, decision.triage?.site.tier, decision.triage?.site.status],
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
    acquire: (id) => storage.acquire(id),
    release: (id, attempt) => storage.release(id, attempt),
    present: (id, attempt) => storage.present(id, attempt),
    append: (decision, attempt) => {
      if (crash) {
        crash = false;
        throw new Error('crash');
      }
      return storage.append(decision, attempt);
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
    acquire: (id) => storage.acquire(id),
    release: (id, attempt) => storage.release(id, attempt),
    present: (id, attempt) => storage.present(id, attempt),
    append: (decision, attempt) => storage.append(decision, attempt),
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
    reused.evaluateCalls.filter((request) => !request.site.startsWith('decide1.')).map((request) => request.site),
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
    resume.evaluateCalls
      .filter((request) => !request.site.startsWith('decide1.'))
      .map((request) => [request.site, request.request_id]),
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
      site: {
        ...checkpoint.triage!.site,
        choice: 'implement',
        tier: 'strong',
        status: 'transition',
        observation: {
          ...checkpoint.triage!.site.observation,
          accepted: false,
          fallback_used: true,
          reason: 'low_confidence',
        },
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
    'rule_table',
    'decide1',
    'intent',
    'receipt',
    'intake',
    'triage',
    'route',
    'shadow',
    'preflight',
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
    'shadow',
    'preflight',
    'intent',
  ]);
  assert.deepEqual(Object.keys(checkpoint.asks), ['intake', 'triage', 'route', 'shadow', 'preflight']);
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
      if (record.kind !== 'judgment') return;
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

/** Replay re-derives every stage through the live pure functions; any other record is rejected. */
const REDERIVED = /is not the live outcome of its recorded observations/;

function withRouteObservation(
  checkpoint: DispatchCheckpoint,
  patch: Partial<NonNullable<DispatchCheckpoint['route']>['site']['observation']>,
): DispatchCheckpoint {
  const route = checkpoint.route!;
  return {
    ...checkpoint,
    route: { ...route, site: { ...route.site, observation: { ...route.site.observation, ...patch } } },
  };
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
  // The loser's claim fails its compare-and-set, so it reports the winner's recorded decision.
  const lost = await pending;
  assert.deepEqual(lost, won);
  assert.equal(loser.dispatchCalls.length, 0);

  const checkpoint = journal.load('d1').checkpoint!;
  assert.equal(checkpoint.route?.site.observation.request_id, 'd1:route:e2');
  assert.equal(checkpoint.route?.site.choice, 'strong');
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
  // The loser's stale final fails its compare-and-set, so it reports the winner's recorded decision.
  const lost = await pending;
  assert.deepEqual(lost, won);

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
    ['foreign request', withRouteObservation(checkpoint, { request_id: 'other:route' }), REDERIVED],
    ['foreign site', withRouteObservation(checkpoint, { site: 'loop.triage' }), REDERIVED],
    ['foreign revision', withRouteObservation(checkpoint, { state_revision: 2 }), REDERIVED],
    ['below threshold', withRouteObservation(checkpoint, { confidence: 0.5 }), REDERIVED],
    ['unsafe provider id', withRouteObservation(checkpoint, { provider_request_id: 'sk-forged' }), REDERIVED],
    ['answer without its accepted choice', withRouteObservation(checkpoint, { answer: 'flash' }), REDERIVED],
  ];
  for (const [label, value, reason] of forged)
    assert.throws(() => transitionDispatch(h.request, value, live.receipt), reason, label);
});

test('23. live recovery rejects foreign and below-threshold loaded stages before dispatch', async () => {
  const h = harness({ route: { choice: 'strong' } });
  const live = await run(h);
  const checkpoint = h.journal.load('d1').checkpoint!;
  const forged: readonly [string, DispatchCheckpoint, RegExp][] = [
    ['foreign request', withRouteObservation(checkpoint, { request_id: 'other:route' }), REDERIVED],
    ['foreign site', withRouteObservation(checkpoint, { site: 'loop.triage' }), REDERIVED],
    ['foreign revision', withRouteObservation(checkpoint, { state_revision: 2 }), REDERIVED],
    ['below threshold', withRouteObservation(checkpoint, { confidence: 0.5 }), REDERIVED],
    ['unsafe provider id', withRouteObservation(checkpoint, { provider_request_id: 'sk-forged' }), REDERIVED],
    ['answer without its accepted choice', withRouteObservation(checkpoint, { answer: 'flash' }), REDERIVED],
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
    load: () => ({ checkpoint, decisions: [], attempt: null, presented: false }),
    checkpoint: () => {},
    claim: () => false,
    acquire: () => null,
    release: () => {},
    present: () => false,
    append: () => false,
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
    assert.throws(() => transitionDispatch(request, value, null), REDERIVED, `${label} replay`);
    const recovery = harness({}, { journal: forgedJournal(value), request: makeRequest({ resume: true }) });
    await assert.rejects(run(recovery), REDERIVED, `${label} live`);
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
  // A cancelled extraction reads no slots; a stale one keeps the answer it gated.
  const unread = final.slots.map((slot) => ({ ...slot, status: 'unread' as const, value: null, span: null }));
  for (const [status, reason, slots] of [
    ['paused', 'cancelled', unread],
    ['needs_human', 'stale_answer', final.slots],
  ] as const) {
    const variant: DispatchCheckpoint = {
      ...checkpoint,
      intake: {
        ...checkpoint.intake!,
        status,
        reason,
        extract: [...checkpoint.intake!.extract.slice(0, -1), { ...final, verdict: 'original_only', reason, slots }],
      },
    };
    const replayed = transitionDispatch(request, variant, null, live.entry);
    assert.deepEqual([replayed.status, replayed.reason, replayed.intake?.site], ['paused', reason, null]);
  }
});

type ExtractObservationRecord = NonNullable<DispatchCheckpoint['intake']>['extract'][number];
type ExtractForgery = (final: ExtractObservationRecord) => readonly ExtractObservationRecord[];

/** Each forgery rewrites the final intake extraction into a shape the live path stops on or never produces. */
const EXTRACT_FORGERIES: readonly (readonly [string, ExtractForgery])[] = [
  ['cancelled', (final) => [{ ...final, verdict: 'original_only', reason: 'cancelled' }]],
  ['stale_answer', (final) => [{ ...final, verdict: 'original_only', reason: 'stale_answer' }]],
  ['re_extract', (final) => [{ ...final, verdict: 're_extract', reason: 'no_answer' }]],
  [
    'use_hints over an ungrounded slot',
    (final) => [
      {
        ...final,
        slots: final.slots.map((slot) =>
          slot.slot === 'thread_ref' ? { ...slot, status: 'ungrounded' as const, value: null, span: null } : slot,
        ),
      },
    ],
  ],
  ['unknown verdict', (final) => [{ ...final, verdict: 'accept' as never }]],
  ['use_hints without an answer', (final) => [{ ...final, reason: 'no_answer' }]],
  [
    'unrequested second extraction',
    (final) => [final, { ...final, attempt: 2, request_id: final.request_id!.replace(/:x1$/, ':x2') }],
  ],
];

/** The Codex shape: use_hints, an unresolved thread_ref and two running threads is an operator-only ambiguity. */
const operatorAmbiguity: ExtractForgery = (final) => [
  {
    ...final,
    slots: final.slots.map((slot) =>
      slot.slot === 'thread_ref' ? { ...slot, status: 'unresolved' as const, value: null } : slot,
    ),
    residual_ambiguity: { count: 1, slots: ['thread_ref'] },
  },
];

function withForgedExtract(checkpoint: DispatchCheckpoint, forge: ExtractForgery): DispatchCheckpoint {
  const intake = checkpoint.intake!;
  const final = intake.extract.at(-1)!;
  return { ...checkpoint, intake: { ...intake, extract: [...intake.extract.slice(0, -1), ...forge(final)] } };
}

function mismatchedIntent(intent: DispatchIntent): DispatchIntent {
  if (intent.kind === 'implement')
    return { kind: 'thread', dispatch_id: intent.dispatch_id, relation: 'steer', thread_ref: 'T1' };
  return {
    kind: 'implement',
    dispatch_id: intent.dispatch_id,
    tier: 'flash',
    ceiling: 'flash',
    tier_source: 'route',
  };
}

test('27. forged extraction origins across stages never dispatch on replay or recovery', async () => {
  const threadRequest = makeRequest({
    intake: { message: 'continue T1', running_threads: [{ thread_id: 'T1', summary: 'alpha' }] },
  });
  const intakeLive = harness(
    { intake: { choice: 'continue_thread' }, thread: { value: 'T1', cue: 'T1' } },
    { request: threadRequest },
  );
  const intakeDecision = await run(intakeLive);

  const triageLive = harness({ triage: { choice: 'capability' } });
  const triageDecision = await run(triageLive);

  const routeLive = harness({ route: { choice: 'strong' } });
  const routeDecision = await run(routeLive);

  const twoThreadRequest = makeRequest({
    intake: {
      message: 'continue T1',
      running_threads: [
        { thread_id: 'T1', summary: 'first' },
        { thread_id: 'T2', summary: 'second' },
      ],
    },
  });
  const ambiguityLive = harness(
    { intake: { choice: 'new_thread' }, thread: { value: 'T1', cue: 'T1' } },
    { request: twoThreadRequest },
  );
  const ambiguityDecision = await run(ambiguityLive);

  const bases = [
    ['intake', threadRequest, intakeLive.journal.load('d1').checkpoint!, intakeDecision],
    ['triage', makeRequest(), triageLive.journal.load('d1').checkpoint!, triageDecision],
    ['route', makeRequest(), routeLive.journal.load('d1').checkpoint!, routeDecision],
    ['two threads', twoThreadRequest, ambiguityLive.journal.load('d1').checkpoint!, ambiguityDecision],
  ] as const;

  const forged: [string, DispatchRequest, DispatchCheckpoint][] = [];
  for (const [stage, request, base, live] of bases) {
    assert.notEqual(base.intent, null, `${stage} basis needs a claimed intent`);
    // The unforged basis replays, so every rejection below is caused by its forgery alone.
    assert.deepEqual(transitionDispatch(request, base, live.receipt, live.entry), live, `${stage} basis`);
    for (const [label, forge] of EXTRACT_FORGERIES)
      forged.push([`${stage} ${label}`, request, withForgedExtract(base, forge)]);
  }
  const twoThreadBase = bases[3][2];
  forged.push([
    'two threads operator ambiguity',
    twoThreadRequest,
    withForgedExtract(twoThreadBase, operatorAmbiguity),
  ]);

  for (const [label, request, stopped] of forged) {
    const intents: readonly [string, DispatchIntent | null][] = [
      ['unclaimed', null],
      ['matching', stopped.intent],
      ['mismatched', mismatchedIntent(stopped.intent!)],
    ];
    for (const [intentMode, intent] of intents) {
      const name = `${label} ${intentMode}`;
      const value: DispatchCheckpoint = { ...stopped, intent };
      assert.throws(() => transitionDispatch(request, value, null), REDERIVED, `${name} replay`);
      for (const resume of [false, true]) {
        const recovery = harness({}, { journal: forgedJournal(value), request: { ...request, resume } });
        await assert.rejects(run(recovery), REDERIVED, `${name} live resume=${resume}`);
        assert.equal(recovery.generateCalls.length, 0, `${name} live resume=${resume}`);
        assert.equal(recovery.evaluateCalls.length, 0, `${name} live resume=${resume}`);
        assert.equal(recovery.dispatchCalls.length, 0, `${name} live resume=${resume}`);
      }
    }
  }
});

test('28. a claimed intent survives a terminal stale pause and append surfaces foreign ownership', async () => {
  // Budget pause: the intent is claimed and recorded with the pause.
  const budgeted = harness(
    {},
    { receipt: () => ({ status: 'refused', dispatch_id: 'd1:dispatch', reason: 'budget' }) },
  );
  const paused = await run(budgeted);
  assert.deepEqual([paused.status, paused.reason], ['paused', 'budget']);
  const claimed = budgeted.journal.load('d1').checkpoint!.intent!;
  assert.notEqual(claimed, null);

  // Advancing the state before an explicit resume reaches the terminal stale pause.
  budgeted.clock.advance();
  const resumed = harness(
    {},
    { journal: budgeted.journal, clock: budgeted.clock, request: makeRequest({ resume: true }) },
  );
  const stale = await run(resumed);
  assert.deepEqual([stale.status, stale.reason], ['paused', 'stale_answer']);
  assert.deepEqual(stale.intent, claimed);
  const stored = budgeted.journal.load('d1');
  assert.deepEqual(stored.decisions.at(-1), stale);
  assert.equal(resumed.dispatchCalls.length, 0);

  // The terminal pause is durable: the next delivery returns it rather than the old budget pause.
  const next = harness({}, { journal: budgeted.journal, request: makeRequest() });
  const repeated = await run(next);
  assert.deepEqual(repeated, stale);
  assert.equal(next.dispatchCalls.length, 0);

  // A crash after the port call left the claim presented: it stays unconfirmed, never stale.
  const storage = new MemoryDispatchJournal();
  let crash = true;
  const crashing: DispatchJournal = {
    load: (id) => storage.load(id),
    checkpoint: (entry) => storage.checkpoint(entry),
    claim: (id, intent, entry) => storage.claim(id, intent, entry),
    acquire: (id) => storage.acquire(id),
    release: (id, attempt) => storage.release(id, attempt),
    present: (id, attempt) => storage.present(id, attempt),
    append: (decision, attempt) => {
      if (crash) {
        crash = false;
        throw new Error('crash');
      }
      return storage.append(decision, attempt);
    },
  };
  const unconfirmedRun = harness({}, { journal: crashing });
  await assert.rejects(run(unconfirmedRun), /crash/);
  const unconfirmedClaim = storage.load('d1').checkpoint!.intent!;
  unconfirmedRun.clock.advance();
  const recovered = harness(
    {},
    { journal: storage, clock: unconfirmedRun.clock, request: makeRequest({ resume: true }) },
  );
  const recoveredDecision = await run(recovered);
  assert.deepEqual([recoveredDecision.status, recoveredDecision.reason], ['paused', 'dispatch_unconfirmed']);
  assert.deepEqual(recoveredDecision.intent, unconfirmedClaim);
  assert.deepEqual(storage.load('d1').decisions.at(-1), recoveredDecision);
  assert.equal(recovered.dispatchCalls.length, 0);

  // Append loses its compare-and-set when a decision does not own the claimed intent.
  const journal = new MemoryDispatchJournal();
  const request = makeRequest();
  assert.equal(journal.claim('d1', claimed), true);
  const orphan: DispatchDecision = {
    schema: 'dispatch.decision@4',
    rule_table: DECIDE1_RULE_TABLE,
    decide1: { judgments: [], facts: [], rule: 'hold.outage', band: 'tool_call' },
    decision_id: 'd1',
    entry: 1,
    state_revision: request.state_revision,
    decided_by: 'rule',
    choice: 'ask_user',
    status: 'paused',
    reason: 'stale_answer',
    intent: null,
    receipt: null,
    intake: null,
    triage: null,
    route: null,
    shadow: null,
    preflight: null,
  };
  assert.equal(journal.append(orphan), false);
  assert.deepEqual(journal.load('d1').decisions, []);
});

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('29. a human-stop winner closes the decision to a delayed dispatch candidate', async () => {
  const gate = deferred();
  const journal = new MemoryDispatchJournal();
  const candidate = harness({ gate: { match: (id) => id === 'd1:intake', promise: gate.promise } }, { journal });
  const pending = run(candidate);
  await waitUntil(() => candidate.evaluateCalls.some((request) => request.site === 'intake.classify'));

  const stopper = harness({ intake: { choice: 'new_thread', confidence: 0.5 } }, { journal });
  const stopped = await run(stopper);
  assert.deepEqual([stopped.status, stopped.reason], ['needs_human', 'low_confidence']);
  assert.equal(stopper.evaluateCalls[0]?.request_id, 'd1:intake:e2');

  gate.release();
  const late = await pending;
  assert.equal(candidate.dispatchCalls.length, 0);
  assert.deepEqual(late, stopped);
  const loaded = journal.load('d1');
  assert.deepEqual(loaded.decisions, [stopped]);
  assert.equal(loaded.checkpoint?.intent, null);
  // The terminal stop owns the stage evidence: the candidate's later answers never replace it.
  assert.deepEqual(loaded.checkpoint?.intake, stopped.intake);

  const later = harness({}, { journal, request: makeRequest({ resume: true }) });
  assert.deepEqual(await run(later), stopped);
  assert.equal(later.generateCalls.length + later.evaluateCalls.length + later.dispatchCalls.length, 0);
});

test('30. a delayed human stop cannot finalize a decision another writer has claimed', async () => {
  const stopGate = deferred();
  const dispatchGate = deferred();
  const journal = new MemoryDispatchJournal();
  const stopper = harness(
    {
      intake: { choice: 'new_thread', confidence: 0.5 },
      gate: { match: (id) => id === 'd1:intake', promise: stopGate.promise },
    },
    { journal },
  );
  const pendingStop = run(stopper);
  await waitUntil(() => stopper.evaluateCalls.some((request) => request.site === 'intake.classify'));

  let entered = false;
  const claimer = harness(
    {},
    {
      journal,
      dispatch: async (intent) => {
        entered = true;
        await dispatchGate.promise;
        return dispatched(intent);
      },
    },
  );
  const pendingDispatch = run(claimer);
  await waitUntil(() => entered);
  const claimed = journal.load('d1').checkpoint!.intent!;
  assert.equal(claimed.dispatch_id, 'd1:dispatch');

  stopGate.release();
  const lost = await pendingStop;
  assert.deepEqual([lost.status, lost.reason], ['paused', 'dispatch_unconfirmed']);
  assert.deepEqual(lost.intent, claimed);
  assert.equal(stopper.dispatchCalls.length, 0);
  assert.deepEqual(journal.load('d1').decisions, []);

  dispatchGate.release();
  const won = await pendingDispatch;
  assert.equal(won.status, 'dispatched');
  assert.deepEqual(journal.load('d1').decisions, [won]);
  assert.equal(claimer.dispatchCalls.length, 1);
});

/** A journal holding one recorded checkpoint and no decision: the state a crash after the claim leaves. */
function recoveredJournal(checkpoint: DispatchCheckpoint): DispatchJournal {
  const storage = new MemoryDispatchJournal();
  storage.checkpoint({ ...checkpoint, intent: null });
  if (checkpoint.intent !== null)
    assert.equal(storage.claim(checkpoint.decision_id, checkpoint.intent, checkpoint), true);
  return storage;
}

test('31. property: every recorded checkpoint replays to the live decision on the same inputs', async () => {
  const one = [{ thread_id: 'T1', summary: 'first' }];
  const two = [...one, { thread_id: 'T2', summary: 'second' }];
  const threadSets = [[], one, two];
  const hints: readonly NonNullable<Plan['thread']>[] = [
    { value: 'T1', cue: 'T1' },
    { value: null, cue: 'T1' },
    { value: null, cue: null },
    { value: 'none', cue: null },
    { value: 'T1', cue: 'not in the message' },
    { value: 'T9', cue: 'T1' },
  ];
  const intakes: readonly StagePlan[] = [
    ...SITE_POLICY['intake.classify'].options.map((choice) => ({ choice })),
    { choice: 'new_thread', confidence: 0.5 },
    { choice: 'new_thread', confidence: null },
    { choice: 'flash' },
    { mode: 'no_answer' },
    { mode: 'stale' },
    { mode: 'mismatch' },
    { mode: 'outage' },
    { mode: 'paused' },
  ];
  const loopPlans = (site: 'loop.triage' | 'loop.route'): readonly StagePlan[] => {
    const first = SITE_POLICY[site].options[0];
    return [
      ...SITE_POLICY[site].options.map((choice) => ({ choice })),
      { choice: first, confidence: 0.5 },
      { choice: first, confidence: null },
      { choice: first, probabilities: { [first]: 0.5 } },
      { choice: 'ask_user' },
      { mode: 'no_answer' },
      { mode: 'stale' },
      { mode: 'mismatch' },
      { mode: 'outage' },
      { mode: 'paused' },
    ];
  };
  const receipts: readonly ((intent: DispatchIntent) => DispatchReceipt)[] = [
    dispatched,
    (intent) => ({ status: 'refused', dispatch_id: intent.dispatch_id, reason: 'approval_required' }),
    (intent) => ({ status: 'refused', dispatch_id: intent.dispatch_id, reason: 'budget' }),
    (intent) => ({ status: 'refused', dispatch_id: intent.dispatch_id, reason: 'conflict' }),
    () => ({ status: 'dispatched', dispatch_id: 'other:dispatch', ref: 'action:1' }),
  ];

  interface Scenario {
    readonly plan: Plan;
    readonly request: DispatchRequest;
    readonly receipt?: (intent: DispatchIntent) => DispatchReceipt;
  }
  const threadRequest = (running_threads: DispatchRequest['intake']['running_threads']) =>
    makeRequest({ intake: { message: 'continue T1 please', running_threads } });
  const scenarios: Scenario[] = [];
  for (const threads of threadSets)
    for (const thread of hints)
      for (const intake of intakes) scenarios.push({ plan: { intake, thread }, request: threadRequest(threads) });
  for (const intakeExtract of ['outage', 'mismatch', 'garbage', 'stale', 'paused'] as const)
    for (const threads of threadSets) scenarios.push({ plan: { intakeExtract }, request: threadRequest(threads) });
  for (const triage of loopPlans('loop.triage')) scenarios.push({ plan: { triage }, request: makeRequest() });
  for (const route of loopPlans('loop.route')) scenarios.push({ plan: { route }, request: makeRequest() });
  for (const receipt of receipts) scenarios.push({ plan: {}, request: makeRequest(), receipt });

  let replayed = 0;
  let recovered = 0;
  for (const [index, scenario] of scenarios.entries()) {
    const label = `scenario ${index}: ${JSON.stringify(scenario.plan)}`;
    const h = harness(scenario.plan, {
      request: scenario.request,
      ...(scenario.receipt === undefined ? {} : { receipt: scenario.receipt }),
    });
    const live = await run(h);
    const loaded = h.journal.load('d1');
    assert.deepEqual(loaded.decisions.at(-1), live, label);
    const checkpoint = loaded.checkpoint!;
    assert.deepEqual(transitionDispatch(scenario.request, checkpoint, live.receipt, live.entry), live, label);
    replayed += 1;
    if (checkpoint.intent === null) continue;
    // Live recovery accepts the same checkpoint and re-presents nothing without resume.
    const recovery = harness({}, { journal: recoveredJournal(checkpoint), request: scenario.request });
    const unconfirmed = await run(recovery);
    assert.deepEqual([unconfirmed.status, unconfirmed.reason], ['paused', 'dispatch_unconfirmed'], label);
    assert.deepEqual(unconfirmed.intent, checkpoint.intent, label);
    assert.equal(
      recovery.generateCalls.length + recovery.evaluateCalls.length + recovery.dispatchCalls.length,
      0,
      label,
    );
    recovered += 1;
  }
  assert.ok(replayed > 250, `replayed ${replayed}`);
  assert.ok(recovered > 50, `recovered ${recovered}`);
});

test('32. the journal is a single-writer state machine per decision id', () => {
  const intent: DispatchIntent = { kind: 'capability', dispatch_id: 'd1:dispatch' };
  const decision = (patch: Partial<DispatchDecision>): DispatchDecision => ({
    schema: 'dispatch.decision@4',
    rule_table: DECIDE1_RULE_TABLE,
    decide1: { judgments: [], facts: [], rule: 'hold.outage', band: 'tool_call' },
    decision_id: 'd1',
    entry: 1,
    state_revision: REVISION.state_revision,
    decided_by: 'triage',
    choice: 'capability',
    status: 'paused',
    reason: 'decision_unavailable',
    intent: null,
    receipt: null,
    intake: null,
    triage: null,
    route: null,
    shadow: null,
    preflight: null,
    ...patch,
  });

  // open: a resumable pause keeps the decision open to one claim.
  const open = new MemoryDispatchJournal();
  assert.equal(open.append(decision({})), true);
  assert.equal(open.claim('d1', intent), true);
  assert.equal(open.claim('d1', intent), false);

  // terminal: a recorded human stop refuses every later claim, append and checkpoint.
  const terminal = new MemoryDispatchJournal();
  assert.equal(terminal.append(decision({ status: 'needs_human', reason: 'accepted', choice: 'needs_human' })), true);
  assert.equal(terminal.claim('d1', intent), false);
  assert.equal(terminal.append(decision({ entry: 2, status: 'needs_human', reason: 'low_confidence' })), false);
  terminal.checkpoint({
    schema: 'dispatch.checkpoint@3',
    decision_id: 'd1',
    ...REVISION,
    asks: { intake: 9, triage: 0, route: 0, shadow: 0, preflight: 0 },
    intake: null,
    triage: null,
    route: null,
    shadow: null,
    preflight: null,
    intent: null,
  });
  assert.equal(terminal.load('d1').checkpoint, null);
  assert.equal(terminal.load('d1').decisions.length, 1);

  // claimed: only the owner of the intent appends; a dispatch makes it terminal.
  const claimed = new MemoryDispatchJournal();
  assert.equal(claimed.claim('d1', intent), true);
  assert.equal(claimed.append(decision({ status: 'needs_human', reason: 'accepted' })), false);
  assert.equal(claimed.append(decision({ intent, reason: 'dispatch_unconfirmed' })), true);
  const receipt: DispatchReceipt = { status: 'dispatched', dispatch_id: 'd1:dispatch', ref: 'action:1' };
  assert.equal(claimed.append(decision({ entry: 2, intent, receipt, status: 'dispatched', reason: 'accepted' })), true);
  assert.equal(
    claimed.append(decision({ entry: 3, intent, receipt, status: 'dispatched', reason: 'accepted' })),
    false,
  );
  assert.equal(claimed.load('d1').decisions.length, 2);

  // An intent that was never claimed cannot be appended at all.
  assert.throws(() => new MemoryDispatchJournal().append(decision({ intent })), /claim/);
});

/** A dispatch port that holds every presentation until released, counting the ones it entered. */
function heldDispatch(gate: Promise<void>) {
  const state = { entered: 0 };
  const dispatch = async (intent: DispatchIntent): Promise<DispatchReceipt> => {
    state.entered += 1;
    await gate;
    return dispatched(intent);
  };
  return { state, dispatch };
}

test('33. recovery never terminalizes or re-presents an attempt in flight; its receipt is journaled', async () => {
  const gate = deferred();
  const held = heldDispatch(gate.promise);
  const journal = new MemoryDispatchJournal();
  const a = harness({}, { journal, dispatch: held.dispatch });
  const pending = run(a);
  await waitUntil(() => held.state.entered === 1);
  const claimed = journal.load('d1').checkpoint!.intent!;

  // Same state: an explicit resume does not present the intent a second time.
  const same = harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }) });
  const sameDecision = await run(same);
  assert.deepEqual([sameDecision.status, sameDecision.reason], ['paused', 'dispatch_unconfirmed']);
  assert.deepEqual(sameDecision.intent, claimed);

  // The finding: the state advances, and a resume reaches the stale check while A is in flight.
  a.clock.advance();
  const b = harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }) });
  const inFlight = await run(b);
  assert.deepEqual([inFlight.status, inFlight.reason], ['paused', 'dispatch_unconfirmed']);
  assert.deepEqual(inFlight.intent, claimed);
  const implicit = harness({}, { journal, clock: a.clock });
  const unconfirmed = await run(implicit);
  assert.deepEqual([unconfirmed.status, unconfirmed.reason], ['paused', 'dispatch_unconfirmed']);
  // Recovery wrote nothing over the attempt in flight.
  assert.deepEqual(journal.load('d1').decisions, []);

  gate.release();
  const won = await pending;
  assert.equal(won.status, 'dispatched');
  assert.deepEqual(won.intent, claimed);
  assert.deepEqual(won.receipt, dispatched(claimed));
  assert.deepEqual(journal.load('d1').decisions, [won]);

  // B's next delivery sees A's decision.
  const again = harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }) });
  assert.deepEqual(await run(again), won);
  assert.equal(held.state.entered, 1);
  assert.equal(
    a.dispatchCalls.length +
      same.dispatchCalls.length +
      b.dispatchCalls.length +
      implicit.dispatchCalls.length +
      again.dispatchCalls.length,
    1,
  );
});

test('34. a crashed attempt ends only on the port settlement, never by time, without a second dispatch', async () => {
  const journal = new MemoryDispatchJournal();
  let entered = 0;
  // A crashes inside the port: it never returns, releases or appends.
  const a = harness(
    {},
    {
      journal,
      dispatch: () => {
        entered += 1;
        return new Promise<DispatchReceipt>(() => {});
      },
    },
  );
  void run(a);
  await waitUntil(() => entered === 1);
  const claimed = journal.load('d1').checkpoint!.intent!;
  const crashed = journal.load('d1').attempt!;
  a.clock.advance();

  // No settlement port, or a port that has not settled, cannot read, or answers for another
  // dispatch: the attempt stays live, recovery writes nothing and the state change does not matter.
  const unsettled: (DispatchSettlementPort | undefined)[] = [
    undefined,
    () => null,
    () => {
      throw new Error('CANARY-error');
    },
    () => ({ status: 'dispatched', dispatch_id: 'other:dispatch', ref: 'action:1' }),
  ];
  const reads: string[] = [];
  for (const settlement of unsettled) {
    const early = harness(
      {},
      {
        journal,
        clock: a.clock,
        request: makeRequest({ resume: true }),
        ...(settlement === undefined
          ? {}
          : {
              settlement: (id: string, signal?: AbortSignal) => {
                reads.push(id);
                return settlement(id, signal);
              },
            }),
      },
    );
    const inFlight = await run(early);
    assert.deepEqual([inFlight.status, inFlight.reason], ['paused', 'dispatch_unconfirmed']);
    assert.deepEqual(inFlight.intent, claimed);
    assert.equal(early.dispatchCalls.length, 0);
  }
  assert.deepEqual(reads, ['d1', 'd1', 'd1']);
  assert.deepEqual(journal.load('d1').decisions, []);
  assert.equal(journal.load('d1').attempt, crashed);

  // The port's own settlement for the decision id ends the attempt: its receipt is journaled.
  const recovery = harness(
    {},
    {
      journal,
      clock: a.clock,
      request: makeRequest({ resume: true }),
      settlement: (id) => (id === 'd1' ? dispatched(claimed) : null),
    },
  );
  const settled = await run(recovery);
  assert.deepEqual([settled.status, settled.reason], ['dispatched', 'accepted']);
  assert.deepEqual(settled.intent, claimed);
  assert.deepEqual(settled.receipt, dispatched(claimed));
  assert.deepEqual(journal.load('d1').decisions, [settled]);
  assert.equal(journal.load('d1').attempt, null);
  const repeated = harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }) });
  assert.deepEqual(await run(repeated), settled);
  assert.equal(entered, 1);
  assert.equal(a.dispatchCalls.length + recovery.dispatchCalls.length + repeated.dispatchCalls.length, 1);
  // The crashed holder's token is retired.
  assert.equal(journal.append({ ...settled, entry: 2 }, crashed), false);

  // The journal contract: one live attempt per claimed intent, single-use ids, no expiry.
  const intent: DispatchIntent = { kind: 'capability', dispatch_id: 'd1:dispatch' };
  const owned = (status: DispatchDecision['status'], reason: DispatchDecision['reason']): DispatchDecision => ({
    schema: 'dispatch.decision@4',
    rule_table: DECIDE1_RULE_TABLE,
    decide1: { judgments: [], facts: [], rule: 'hold.outage', band: 'tool_call' },
    decision_id: 'd1',
    entry: 1,
    state_revision: REVISION.state_revision,
    decided_by: 'triage',
    choice: 'capability',
    status,
    reason,
    intent,
    receipt: null,
    intake: null,
    triage: null,
    route: null,
    shadow: null,
    preflight: null,
  });
  const fenced = new MemoryDispatchJournal();
  assert.equal(fenced.acquire('d1'), null, 'an unclaimed decision has no attempt');
  assert.equal(fenced.claim('d1', intent), true);
  const first = fenced.acquire('d1')!;
  assert.equal(fenced.load('d1').attempt, first);
  assert.equal(fenced.acquire('d1'), null);
  assert.equal(fenced.append(owned('paused', 'dispatch_unconfirmed')), false, 'no tokenless append while live');
  fenced.release('d1', 'd1:attempt:other');
  assert.equal(fenced.acquire('d1'), null, 'only the holder ends its attempt');
  assert.equal(fenced.acquire('d1', 'd1:attempt:other'), null, 'only the live attempt is superseded');
  const second = fenced.acquire('d1', first)!;
  assert.notEqual(second, first);
  assert.equal(fenced.append(owned('paused', 'stale_answer'), first), false, 'a superseded attempt is fenced');
  fenced.release('d1', first);
  assert.equal(fenced.load('d1').attempt, second, 'a superseded attempt releases nothing');
  assert.equal(fenced.append(owned('paused', 'budget'), second), true);
  assert.equal(fenced.load('d1').attempt, null);
  assert.equal(fenced.append(owned('paused', 'budget'), second), false, 'an appended attempt is retired');
  const third = fenced.acquire('d1')!;
  assert.ok(![first, second].includes(third), 'attempt ids are never reissued');
  assert.equal(fenced.acquire('d1', second), null, 'a retired attempt supersedes nothing');
  fenced.release('d1', third);
  assert.equal(fenced.append(owned('refused', 'refused'), third), false, 'a released attempt is retired');
  assert.equal(fenced.append(owned('paused', 'stale_answer')), true);
  assert.equal(fenced.acquire('d1'), null, 'a terminal decision has no attempt');
});

test('35. cancelling an attempt in flight hands it to recovery without a second dispatch', async () => {
  const journal = new MemoryDispatchJournal();
  const controller = new AbortController();
  let entered = 0;
  const a = harness(
    {},
    {
      journal,
      dispatch: (_intent, signal) =>
        new Promise<DispatchReceipt>((_resolve, reject) => {
          entered += 1;
          signal?.addEventListener('abort', () => reject(new Error('CANARY-error')), { once: true });
        }),
    },
  );
  const pending = run(a, controller.signal);
  await waitUntil(() => entered === 1);
  const claimed = journal.load('d1').checkpoint!.intent!;
  a.clock.advance();

  const b = harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }) });
  const recovering = run(b);
  controller.abort();
  const [cancelled, inFlight] = await Promise.all([pending, recovering]);
  assert.deepEqual([cancelled.status, cancelled.reason], ['paused', 'cancelled']);
  assert.deepEqual([inFlight.status, inFlight.reason], ['paused', 'dispatch_unconfirmed']);
  assert.deepEqual(inFlight.intent, claimed);
  assert.deepEqual(journal.load('d1').decisions, []);

  // The cancelled attempt has ended, but it presented the intent: without a settlement it is never stale.
  const c = harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }) });
  const unconfirmed = await run(c);
  assert.deepEqual([unconfirmed.status, unconfirmed.reason], ['paused', 'dispatch_unconfirmed']);
  assert.deepEqual(unconfirmed.intent, claimed);
  assert.deepEqual(journal.load('d1').decisions, [unconfirmed]);
  const d = harness(
    {},
    { journal, clock: a.clock, request: makeRequest({ resume: true }), settlement: () => dispatched(claimed) },
  );
  const settled = await run(d);
  assert.deepEqual([settled.status, settled.receipt], ['dispatched', dispatched(claimed)]);
  assert.deepEqual(journal.load('d1').decisions, [unconfirmed, settled]);
  assert.equal(entered, 1);
  assert.equal(a.dispatchCalls.length + b.dispatchCalls.length + c.dispatchCalls.length + d.dispatchCalls.length, 1);
});

test('36. no amount of state change or recovery terminalizes an attempt in flight; its late success is journaled', async () => {
  const gate = deferred();
  const held = heldDispatch(gate.promise);
  const journal = new MemoryDispatchJournal();
  const a = harness({}, { journal, dispatch: held.dispatch });
  const pending = run(a);
  await waitUntil(() => held.state.entered === 1);
  const claimed = journal.load('d1').checkpoint!.intent!;
  const holder = journal.load('d1').attempt!;

  // The state moves on repeatedly and every recovery shape returns: none of them ends A's attempt.
  const recoveries: ReturnType<typeof harness>[] = [];
  for (let round = 0; round < 5; round += 1) {
    a.clock.advance();
    for (const recovery of [
      harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }) }),
      harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }), settlement: () => null }),
      harness({}, { journal, clock: a.clock }),
    ]) {
      recoveries.push(recovery);
      const inFlight = await run(recovery);
      assert.deepEqual([inFlight.status, inFlight.reason], ['paused', 'dispatch_unconfirmed']);
      assert.deepEqual(inFlight.intent, claimed);
    }
  }
  assert.deepEqual(journal.load('d1').decisions, []);
  assert.equal(journal.load('d1').attempt, holder);

  gate.release();
  const won = await pending;
  assert.deepEqual([won.status, won.reason], ['dispatched', 'accepted']);
  assert.deepEqual(won.receipt, dispatched(claimed));
  assert.deepEqual(journal.load('d1').decisions, [won]);
  assert.equal(held.state.entered, 1);
  assert.equal(
    recoveries.reduce((sum, recovery) => sum + recovery.dispatchCalls.length, 0),
    0,
  );
});

test('37. a superseded or retired attempt token never regains append authority', async () => {
  const gate = deferred();
  let entered = 0;
  const journal = new MemoryDispatchJournal();
  // A's port eventually answers a terminal refusal; the port's own record already says budget.
  const a = harness(
    {},
    {
      journal,
      dispatch: async (intent) => {
        entered += 1;
        await gate.promise;
        return { status: 'refused', dispatch_id: intent.dispatch_id, reason: 'conflict' };
      },
    },
  );
  const pending = run(a);
  await waitUntil(() => entered === 1);
  const superseded = journal.load('d1').attempt!;

  // B supersedes A on the port's settlement and appends a resumable budget pause, ending every attempt.
  const b = harness(
    {},
    {
      journal,
      clock: a.clock,
      request: makeRequest({ resume: true }),
      settlement: () => ({ status: 'refused', dispatch_id: 'd1:dispatch', reason: 'budget' }),
    },
  );
  const budget = await run(b);
  assert.deepEqual([budget.status, budget.reason], ['paused', 'budget']);
  assert.equal(journal.load('d1').attempt, null);

  // A returns with no other attempt live: its superseded token still cannot terminalize B's state.
  gate.release();
  const late = await pending;
  assert.deepEqual([late.status, late.reason], ['paused', 'dispatch_unconfirmed']);
  assert.deepEqual(journal.load('d1').decisions, [budget]);
  assert.equal(journal.append({ ...budget, entry: 2, status: 'refused', reason: 'refused' }, superseded), false);
  assert.equal(journal.acquire('d1', superseded), null);

  // A later resume presents under a fresh attempt, which A's release cannot end.
  const c = harness({}, { journal, clock: a.clock, request: makeRequest({ resume: true }) });
  const won = await run(c);
  assert.equal(won.status, 'dispatched');
  assert.deepEqual(journal.load('d1').decisions, [budget, won]);
  assert.equal(entered + c.dispatchCalls.length + b.dispatchCalls.length, 2);

  // Journal level: a token retired by its own append never appends again.
  const intent: DispatchIntent = { kind: 'capability', dispatch_id: 'd1:dispatch' };
  const plain = new MemoryDispatchJournal();
  assert.equal(plain.claim('d1', intent), true);
  const first = plain.acquire('d1')!;
  const base = { ...budget, intent, decided_by: 'triage', choice: 'capability' } as DispatchDecision;
  assert.equal(plain.append(base, first), true);
  assert.equal(plain.append({ ...base, entry: 2, status: 'refused', reason: 'refused' }, first), false);
  const next = plain.acquire('d1')!;
  plain.release('d1', first);
  assert.equal(plain.load('d1').attempt, next);
  assert.deepEqual(plain.load('d1').decisions, [base]);
});

test('38. cancelling recovery during its settlement read writes nothing and leaves the attempt live', async () => {
  const gate = deferred();
  const held = heldDispatch(gate.promise);
  const journal = new MemoryDispatchJournal();
  const a = harness({}, { journal, dispatch: held.dispatch });
  const pending = run(a);
  await waitUntil(() => held.state.entered === 1);
  const claimed = journal.load('d1').checkpoint!.intent!;
  const holder = journal.load('d1').attempt!;
  a.clock.advance();

  // The port has settled, but recovery is cancelled before it can supersede A.
  const controller = new AbortController();
  let read: AbortSignal | undefined;
  const b = harness(
    {},
    {
      journal,
      clock: a.clock,
      request: makeRequest({ resume: true }),
      settlement: async (_id, signal) => {
        read = signal;
        controller.abort();
        return dispatched(claimed);
      },
    },
  );
  const cancelled = await run(b, controller.signal);
  assert.deepEqual([cancelled.status, cancelled.reason], ['paused', 'cancelled']);
  assert.equal(read, controller.signal);
  assert.deepEqual(journal.load('d1').decisions, []);
  assert.equal(journal.load('d1').attempt, holder);

  // Cancelled before the read, recovery reads nothing.
  let reads = 0;
  const early = harness(
    {},
    {
      journal,
      clock: a.clock,
      request: makeRequest({ resume: true }),
      settlement: () => {
        reads += 1;
        return dispatched(claimed);
      },
    },
  );
  const stopped = new AbortController();
  stopped.abort();
  const none = await run(early, stopped.signal);
  assert.deepEqual([none.status, none.reason], ['paused', 'cancelled']);
  assert.equal(reads, 0);

  gate.release();
  const won = await pending;
  assert.equal(won.status, 'dispatched');
  assert.deepEqual(journal.load('d1').decisions, [won]);
  assert.equal(held.state.entered, 1);
  assert.equal(b.dispatchCalls.length + early.dispatchCalls.length, 0);
});

/** The intent's port commits its effect, then fails to confirm in the given way. */
function committed(effects: string[], confirm: 'throw' | 'invalid' | 'cancel', controller: AbortController) {
  return async (intent: DispatchIntent): Promise<DispatchReceipt> => {
    effects.push(intent.dispatch_id);
    if (confirm === 'throw') throw new Error('CANARY-error');
    if (confirm === 'invalid') return { status: 'dispatched', dispatch_id: intent.dispatch_id, ref: 'sk-CANARY-error' };
    controller.abort();
    return dispatched(intent);
  };
}

test('39. a presented intent is reconciled through its settlement before any stale gate', async () => {
  for (const confirm of ['throw', 'invalid', 'cancel'] as const) {
    const effects: string[] = [];
    const controller = new AbortController();
    const a = harness({}, { dispatch: committed(effects, confirm, controller) });
    const first = await run(a, controller.signal);
    assert.equal(first.status, 'paused', confirm);
    const claimed = a.journal.load('d1').checkpoint!.intent!;
    const before = a.journal.load('d1').decisions;
    assert.equal(a.journal.load('d1').attempt, null, confirm);
    a.clock.advance();

    // The state moved on, but the intent was presented: its settlement decides, never the stale gate.
    let reads = 0;
    const settlement = (id: string) => {
      reads += 1;
      return id === 'd1' ? dispatched(claimed) : null;
    };
    const b = harness({}, { journal: a.journal, clock: a.clock, request: makeRequest({ resume: true }), settlement });
    const settled = await run(b);
    assert.deepEqual([settled.status, settled.reason], ['dispatched', 'accepted'], confirm);
    assert.deepEqual(settled.receipt, dispatched(claimed), confirm);
    assert.deepEqual(a.journal.load('d1').decisions, [...before, settled], confirm);
    assert.equal(reads, 1, confirm);

    const again = harness(
      {},
      { journal: a.journal, clock: a.clock, request: makeRequest({ resume: true }), settlement },
    );
    assert.deepEqual(await run(again), settled, confirm);
    assert.deepEqual(a.journal.load('d1').decisions, [...before, settled], confirm);
    assert.deepEqual(effects, ['d1:dispatch'], confirm);
    assert.equal(b.dispatchCalls.length + again.dispatchCalls.length, 0, confirm);
  }
});

test('40. an unresolved presented intent stays dispatch_unconfirmed until its settlement is found', async () => {
  const effects: string[] = [];
  const a = harness({}, { dispatch: committed(effects, 'throw', new AbortController()) });
  await run(a);
  const claimed = a.journal.load('d1').checkpoint!.intent!;
  a.clock.advance();

  const unresolved: (DispatchSettlementPort | undefined)[] = [
    undefined,
    () => null,
    () => {
      throw new Error('CANARY-error');
    },
    () => ({ status: 'dispatched', dispatch_id: 'other:dispatch', ref: 'action:1' }),
  ];
  for (const settlement of unresolved) {
    const b = harness(
      {},
      {
        journal: a.journal,
        clock: a.clock,
        request: makeRequest({ resume: true }),
        ...(settlement === undefined ? {} : { settlement }),
      },
    );
    const pending = await run(b);
    assert.deepEqual([pending.status, pending.reason], ['paused', 'dispatch_unconfirmed']);
    assert.deepEqual(pending.intent, claimed);
    assert.equal(b.dispatchCalls.length, 0);
    assertRecordCopiesNoText(pending, ['CANARY-error']);
  }
  assert.ok(a.journal.load('d1').decisions.every((decision) => decision.reason === 'dispatch_unconfirmed'));

  const later = harness(
    {},
    {
      journal: a.journal,
      clock: a.clock,
      request: makeRequest({ resume: true }),
      settlement: () => dispatched(claimed),
    },
  );
  const settled = await run(later);
  assert.deepEqual([settled.status, settled.receipt], ['dispatched', dispatched(claimed)]);
  assert.equal(a.journal.load('d1').decisions.filter((decision) => decision.status === 'dispatched').length, 1);
  assert.deepEqual(effects, ['d1:dispatch']);
});

test('41. a crash after presenting replays without a second dispatch or a duplicate entry', async () => {
  const storage = new MemoryDispatchJournal();
  const effects: string[] = [];
  let crash = true;
  const crashing: DispatchJournal = {
    load: (id) => storage.load(id),
    checkpoint: (entry) => storage.checkpoint(entry),
    claim: (id, intent, entry) => storage.claim(id, intent, entry),
    acquire: (id, supersedes) => storage.acquire(id, supersedes),
    release: (id, attempt) => storage.release(id, attempt),
    present: (id, attempt) => storage.present(id, attempt),
    append: (decision, attempt) => {
      if (crash) {
        crash = false;
        throw new Error('crash');
      }
      return storage.append(decision, attempt);
    },
  };
  const a = harness(
    {},
    {
      journal: crashing,
      dispatch: async (intent) => {
        effects.push(intent.dispatch_id);
        return dispatched(intent);
      },
    },
  );
  await assert.rejects(run(a), /crash/);
  assert.deepEqual(storage.load('d1').decisions, []);
  assert.equal(storage.load('d1').presented, true);
  const claimed = storage.load('d1').checkpoint!.intent!;

  // Same state or not, a resume reads the settlement before it would present again.
  for (const advance of [false, true]) {
    if (advance) a.clock.advance();
    const replay = harness({}, { journal: storage, clock: a.clock });
    const unconfirmed = await run(replay);
    assert.deepEqual([unconfirmed.status, unconfirmed.reason], ['paused', 'dispatch_unconfirmed']);
    assert.equal(replay.dispatchCalls.length, 0);
  }
  const before = storage.load('d1').decisions;
  const resumed = harness(
    {},
    { journal: storage, clock: a.clock, request: makeRequest({ resume: true }), settlement: () => dispatched(claimed) },
  );
  const settled = await run(resumed);
  assert.equal(settled.status, 'dispatched');
  assert.deepEqual(storage.load('d1').decisions, [...before, settled]);
  assert.equal(storage.load('d1').presented, false);
  const again = harness({}, { journal: storage, clock: a.clock, request: makeRequest({ resume: true }) });
  assert.deepEqual(await run(again), settled);
  assert.deepEqual(storage.load('d1').decisions, [...before, settled]);
  assert.deepEqual(effects, ['d1:dispatch']);
  assert.equal(resumed.dispatchCalls.length + again.dispatchCalls.length, 0);

  // Same state with no settlement found: the idempotent port is presented the same intent again.
  const same = harness({}, { dispatch: committed([], 'throw', new AbortController()) });
  await run(same);
  const retry = harness(
    {},
    { journal: same.journal, clock: same.clock, request: makeRequest({ resume: true }), settlement: () => null },
  );
  const retried = await run(retry);
  assert.equal(retried.status, 'dispatched');
  assert.equal(retry.dispatchCalls.length, 1);

  // Never presented: a crash between the claim and the port call leaves today's stale pause.
  const unpresented = new MemoryDispatchJournal();
  let crashAcquire = true;
  const claimOnly: DispatchJournal = {
    load: (id) => unpresented.load(id),
    checkpoint: (entry) => unpresented.checkpoint(entry),
    claim: (id, intent, entry) => unpresented.claim(id, intent, entry),
    acquire: (id, supersedes) => {
      if (crashAcquire) {
        crashAcquire = false;
        throw new Error('crash');
      }
      return unpresented.acquire(id, supersedes);
    },
    release: (id, attempt) => unpresented.release(id, attempt),
    present: (id, attempt) => unpresented.present(id, attempt),
    append: (decision, attempt) => unpresented.append(decision, attempt),
  };
  const never = harness({}, { journal: claimOnly });
  await assert.rejects(run(never), /crash/);
  assert.equal(unpresented.load('d1').presented, false);
  never.clock.advance();
  let neverReads = 0;
  const stale = harness(
    {},
    {
      journal: unpresented,
      clock: never.clock,
      request: makeRequest({ resume: true }),
      settlement: () => {
        neverReads += 1;
        return null;
      },
    },
  );
  const staleDecision = await run(stale);
  assert.deepEqual([staleDecision.status, staleDecision.reason], ['paused', 'stale_answer']);
  assert.equal(neverReads, 0);
  assert.equal(never.dispatchCalls.length + stale.dispatchCalls.length, 0);
});

test('42. concurrent recovery of a presented intent yields one reconciliation result', async () => {
  const effects: string[] = [];
  const a = harness({}, { dispatch: committed(effects, 'throw', new AbortController()) });
  await run(a);
  const claimed = a.journal.load('d1').checkpoint!.intent!;
  const before = a.journal.load('d1').decisions;
  a.clock.advance();

  const gate = deferred();
  let reads = 0;
  const settlement = async () => {
    reads += 1;
    if (reads === 1) await gate.promise;
    return dispatched(claimed);
  };
  const callers = [0, 1, 2].map(() =>
    harness({}, { journal: a.journal, clock: a.clock, request: makeRequest({ resume: true }), settlement }),
  );
  const pending = callers.map((caller) => run(caller));
  await waitUntil(() => reads >= 2);
  gate.release();
  const results = await Promise.all(pending);
  const decisions = a.journal.load('d1').decisions;
  assert.equal(decisions.length, before.length + 1);
  const settled = decisions.at(-1)!;
  assert.deepEqual([settled.status, settled.receipt], ['dispatched', dispatched(claimed)]);
  for (const result of results) assert.deepEqual(result, settled);
  assert.deepEqual(effects, ['d1:dispatch']);
  assert.equal(
    callers.reduce((sum, caller) => sum + caller.dispatchCalls.length, 0),
    0,
  );
});

const FACT_NAMES = [
  'intake.decided_by',
  'intake.choice',
  'intake.status',
  'intake.reason',
  'intake.accepted',
  'thread_target',
  'triage.choice',
  'triage.status',
  'triage.reason',
  'triage.accepted',
  'route.choice',
  'route.status',
  'route.reason',
  'route.accepted',
  'residual_ambiguity',
  'clarify.reason',
  'multi_deliverable.reason',
  'reads_before_gen.reason',
  'veto_bare_gen.reason',
  'preflight.reason',
  'preflight.targets',
  ...Array.from({ length: 8 }, (_, i) => `preflight.t${i}.role`),
  'spawn.gain',
  'spawn.children',
  'spawn.plan',
];
const PARITY: readonly [Plan, string, string][] = [
  [{}, 'gen.route', 'escalate_gen'],
  [{ triage: { choice: 'capability' } }, 'act.capability', 'tool_call'],
  [{ triage: { choice: 'done_check' } }, 'act.done_check', 'tool_call'],
  [{ triage: { choice: 'out_of_scope' } }, 'act.decline', 'tool_call'],
  [{ triage: { choice: 'needs_human' } }, 'ask.triage', 'ask_human'],
  [{ triage: { confidence: 0.5 } }, 'gen.triage_fallback', 'escalate_gen'],
  [{ route: { confidence: 0.5 } }, 'gen.route_fallback', 'escalate_gen'],
  [{ intake: { confidence: 0.5 } }, 'ask.intake', 'ask_human'],
  [{ intake: { choice: 'stop' } }, 'ask.irreversible', 'ask_human'],
  [{ intake: { choice: 'steer' } }, 'act.thread', 'tool_call'],
  ...(['intake', 'triage', 'route'] as const).flatMap((stage) =>
    (['stale', 'mismatch', 'outage'] as const).map(
      (mode) =>
        [
          { [stage]: { mode } },
          mode === 'outage' ? 'hold.outage' : 'hold.admission',
          stage === 'intake' ? 'ask_human' : 'escalate_gen',
        ] as [Plan, string, string],
    ),
  ),
];

test('P4a-7 merged P3a parity cases use the named rule and band', async () => {
  for (const [plan, rule, band] of PARITY) {
    const h = harness(plan);
    const result = await run(h);
    assert.deepEqual([result.decide1.rule, result.decide1.band], [rule, band], JSON.stringify(plan));
  }
  for (const threads of [
    [],
    [
      { thread_id: 'T1', summary: 'a' },
      { thread_id: 'T2', summary: 'b' },
    ],
  ]) {
    const h = harness(
      { intake: { choice: 'queue' } },
      { request: makeRequest({ intake: { message: MESSAGE, running_threads: threads } }) },
    );
    const result = await run(h);
    assert.deepEqual([result.decide1.rule, result.decide1.band], ['ask.thread_target', 'ask_human']);
  }
});

test('D-ENG-049 origin failures select their ask row; untrusted stages still fail dispatch re-derivation', async () => {
  const base = harness();
  await run(base);
  const checkpoint = base.journal.load('d1').checkpoint!;
  for (const stage of ['triage', 'route'] as const)
    for (const reason of ['invalid_extract', 'extract_missing'] as const) {
      const site = stage === 'triage' ? 'loop.triage' : 'loop.route';
      const request_id = `d1:${stage}`;
      const state = { request: MESSAGE, context: stage === 'triage' ? TRIAGE_CONTEXT : ROUTE_CONTEXT };
      // Non-final second extracts can be supplied to transitionSite, but the live
      // gate finalizes attempt 2 and dispatch refuses stages it cannot re-derive.
      const origin = modelOrigin(
        gateExtract(
          stage === 'triage' ? loopTriageExtractSchema() : loopRouteExtractSchema(),
          JSON.stringify(state),
          null,
          { site, request_id: `${request_id}:x2`, state_revision: 1, attempt: 2, verdict: 're_extract' },
        ),
      );
      const stopped = transitionSite(
        site,
        {
          ...REVISION,
          request_id,
          state,
          terms,
          needs_dispatch: true,
          ...(reason === 'invalid_extract' ? { origin } : {}),
        },
        { ...REVISION, observed_at: 10, outcome: null },
        REVISION,
      );
      assert.deepEqual(
        [stopped.choice, stopped.status, stopped.observation.reason, stopped.observation.accepted],
        [stage === 'triage' ? 'implement' : 'standard', 'needs_human', reason, false],
      );
      const variant: DispatchCheckpoint = {
        ...checkpoint,
        intent: null,
        ...(stage === 'triage'
          ? { triage: { ...checkpoint.triage!, site: stopped }, route: null }
          : { route: { ...checkpoint.route!, site: stopped } }),
      };
      const trace = decideBand(decide1Inputs(base.request, variant));
      assert.deepEqual([trace.rule, trace.band], [`ask.${stage}`, 'ask_human']);
      const seen = collector();
      const h = harness({}, { journal: forgedJournal(variant), weft: seen.port });
      await assert.rejects(run(h), REDERIVED);
      assert.equal(h.generateCalls.length, 0);
      assert.equal(h.evaluateCalls.length, 0);
      assert.equal(h.dispatchCalls.length, 0);
      assert.deepEqual(seen.records, []);
    }
});

test('P4a-8 @3 stores exactly the pure trace, fixed facts and bounded judgments without text', async () => {
  const h = harness();
  const decision = await run(h);
  const checkpoint = h.journal.load('d1').checkpoint!;
  assert.equal(decision.schema, 'dispatch.decision@4');
  assert.equal(decision.rule_table, DECIDE1_RULE_TABLE);
  const { table, ...trace } = decideBand(decide1Inputs(h.request, checkpoint));
  assert.equal(table, decision.rule_table);
  assert.deepEqual(decision.decide1, trace);
  assert.deepEqual(
    decision.decide1.facts.map((fact) => fact.name),
    FACT_NAMES,
  );
  assert.deepEqual(
    decision.decide1.judgments
      .filter((judgment) => /^(intake|triage|route)\./.test(judgment.name))
      .map((judgment) => judgment.name),
    ['intake.confidence', 'intake.top_p', 'triage.confidence', 'triage.top_p', 'route.confidence', 'route.top_p'],
  );
  assertNoAuthorityKeys(decision);
  assertNoCopiedText(h.journal.load('d1'), CANARIES);
  const canary = harness(
    { triageIntent: 'CANARY-ctx', routeIntent: 'CANARY-ctx' },
    {
      request: makeRequest({
        intake: { message: 'CANARY-msg', running_threads: [{ thread_id: 'T1', summary: 'CANARY-summary' }] },
        triage_context: 'CANARY-ctx',
        route_context: 'CANARY-ctx',
      }),
    },
  );
  assertNoCopiedText(await run(canary), CANARIES);
  assertNoCopiedText(canary.journal.load('d1'), CANARIES);
});

test('P4a-9 receipts and resumed presentations preserve the deciding rule and band', async () => {
  for (const reason of ['approval_required', 'budget'] as const) {
    const h = harness({}, { receipt: (intent) => ({ status: 'refused', dispatch_id: intent.dispatch_id, reason }) });
    const decision = await run(h);
    assert.equal(decision.status, reason === 'budget' ? 'paused' : 'needs_human');
    assert.deepEqual([decision.decide1.rule, decision.decide1.band], ['gen.route', 'escalate_gen']);
    if (reason === 'budget') {
      const retry = harness({}, { journal: h.journal, request: makeRequest({ resume: true }) });
      const resumed = await run(retry);
      assert.equal(resumed.entry, 2);
      assert.deepEqual(resumed.decide1, decision.decide1);
    }
  }
});

test('P4a-10 one valid dispatch.decided after append and judgments; reused stages are evidence only', async () => {
  const seen = collector();
  const journal = new MemoryDispatchJournal();
  const port: WeftPort = {
    ...seen.port,
    emit: (record) => {
      assert.equal(journal.load('d1').decisions.length, 1);
      seen.records.push(record);
    },
  };
  const h = harness({}, { journal, weft: port });
  const decision = await run(h);
  assert.deepEqual(
    seen.records.map((record) => record.kind),
    ['judgment', 'judgment', 'judgment', 'dispatch.decided'],
  );
  const record = seen.records.at(-1)!;
  for (const item of seen.records) assert.deepEqual(validateRecord(item), { ok: true });
  assert.deepEqual(record.fields, {
    decision_ref: 'd1',
    decided_by: 'route',
    choice: 'flash',
    status: 'dispatched',
    tier: 'flash',
    dispatch_ref: 'd1:dispatch',
    ...decision.decide1,
  });
  assert.deepEqual(
    record.links,
    seen.records.slice(0, -1).map((item) => ({ rel: 'caused_by', record_id: item.record_id })),
  );
  assert.deepEqual(
    seen.records.map((item) => item.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(record.record_id, 'loom.dispatch:dispatch:d1:1');
  const before = seen.records.length;
  await run(h);
  transitionDispatch(h.request, journal.load('d1').checkpoint!, decision.receipt);
  assert.equal(seen.records.length, before);

  const resumedSeen = collector();
  const first = harness({ route: { mode: 'outage' } }, { weft: resumedSeen.port });
  await run(first);
  const prior = resumedSeen.records.length;
  const retry = harness({}, { journal: first.journal, request: makeRequest({ resume: true }), weft: resumedSeen.port });
  const resumed = await run(retry);
  const later = resumedSeen.records.slice(prior);
  assert.deepEqual(
    later.map((item) => item.kind),
    ['judgment', 'dispatch.decided'],
  );
  assert.equal(later[1]!.record_id, 'loom.dispatch:dispatch:d1:2');
  assert.deepEqual(later[1]!.links, [{ rel: 'caused_by', record_id: later[0]!.record_id }]);
  assert.deepEqual(later[1]!.evidence, [
    { source: 'observation', ref: 'd1' },
    ...[
      'd1:intake',
      'd1:triage',
      'd1:route:e2',
      ...['clarify', 'multi_deliverable', 'reads_before_gen', 'veto_bare_gen'].map(
        (judgment) => `d1:shadow.${judgment}`,
      ),
    ].map((ref) => ({ source: 'inference_request', ref })),
  ]);
  assert.deepEqual(validateRecord(later[1]), { ok: true });
  assert.equal(resumed.entry, 2);
  for (const emit of [
    () => {
      throw new Error('CANARY-error');
    },
    () => Promise.reject(new Error('CANARY-error')),
  ]) {
    assert.deepEqual(await run(harness({}, { weft: { ...seen.port, emit } })), decision);
  }
  const long = harness(
    {},
    { request: makeRequest({ request_id: 'd'.repeat(96) }), weft: { ...seen.port, emitter_id: 'e'.repeat(64) } },
  );
  const longDecision = await run(long);
  assert.equal(dispatchDecided(longDecision, [], { trace_id: 'trace-1', emitter_id: 'e'.repeat(64) }, 1), null);
  assert.equal(dispatchDecided(decision, ['sk-bad'], seen.port, 1), null);
  assert.deepEqual(longDecision.decide1, decision.decide1);
  const aborted = new AbortController();
  aborted.abort();
  const cancelledSeen = collector();
  const cancelled = harness({}, { weft: cancelledSeen.port });
  await run(cancelled, aborted.signal);
  assert.deepEqual(cancelledSeen.records, []);
});

test('P4a-11 asks and pauses emit, including extraction-only ambiguity with empty judgments', async () => {
  const scenarios: readonly [Plan, DispatchRequest, string, string, string][] = [
    [{ intake: { confidence: 0.5 } }, makeRequest(), 'ask.intake', 'ask_human', 'needs_human'],
    [
      { thread: { value: null, cue: 'T1' } },
      makeRequest({
        intake: {
          message: 'which T1?',
          running_threads: [
            { thread_id: 'T1', summary: 'a' },
            { thread_id: 'T2', summary: 'b' },
          ],
        },
      }),
      'ask.intake',
      'ask_human',
      'needs_human',
    ],
    [{ intake: { choice: 'stop' } }, makeRequest(), 'ask.irreversible', 'ask_human', 'needs_human'],
    [{ route: { mode: 'outage' } }, makeRequest(), 'hold.outage', 'escalate_gen', 'paused'],
  ];
  for (const [plan, request, rule, band, status] of scenarios) {
    const seen = collector();
    const h = harness(plan, { request, weft: seen.port });
    const decision = await run(h);
    const records = seen.records.filter((record) => record.kind === 'dispatch.decided');
    assert.equal(records.length, 1);
    assert.deepEqual(
      [records[0]!.fields['rule'], records[0]!.fields['band'], records[0]!.fields['status']],
      [rule, band, status],
    );
    assert.deepEqual(validateRecord(records[0]), { ok: true });
    if (decision.intake?.decided_by === 'extract') {
      assert.deepEqual(decision.decide1.judgments, []);
      assert.deepEqual(records[0]!.fields['judgments'], []);
    }
    assert.equal(Object.hasOwn(records[0]!.fields, 'dispatch_ref'), decision.intent !== null);
    assert.equal(Object.hasOwn(records[0]!.fields, 'tier'), decision.intent?.kind === 'implement');
  }
});

test('P4a-12 pure replay includes trace; recorded foreign table versions are refused before effects', async () => {
  const h = harness();
  const decision = await run(h);
  assert.deepEqual(transitionDispatch(h.request, h.journal.load('d1').checkpoint!, decision.receipt), decision);
  const load = h.journal.load.bind(h.journal);
  const journal: DispatchJournal = {
    ...forgedJournal(h.journal.load('d1').checkpoint!),
    load: (id) => ({
      ...load(id),
      decisions: [{ ...decision, rule_table: 'decide1.rules@0' } as unknown as DispatchDecision],
    }),
  };
  const replay = harness({}, { journal });
  await assert.rejects(run(replay), /rule table/);
  assert.equal(replay.generateCalls.length + replay.evaluateCalls.length + replay.dispatchCalls.length, 0);
});

test('P4a-13 concurrent decisions share monotonic Weft sequences; a losing writer emits nothing', async () => {
  const seen = collector();
  const gate = deferred();
  const journal = new MemoryDispatchJournal();
  const a = harness(
    { gate: { match: (id) => id === 'a:intake', promise: gate.promise } },
    { journal, request: makeRequest({ request_id: 'a' }), weft: seen.port },
  );
  const pending = run(a);
  await waitUntil(() => a.evaluateCalls.length > 0);
  const b = harness(
    { triage: { choice: 'done_check' } },
    { journal, request: makeRequest({ request_id: 'b' }), weft: seen.port },
  );
  await run(b);
  gate.release();
  await pending;
  assert.deepEqual(
    seen.records.map((item) => item.sequence),
    seen.records.map((_, index) => index + 1),
  );
  const decisions = seen.records.filter((item) => item.kind === 'dispatch.decided');
  assert.deepEqual(
    decisions.map((item) => [item.fields['decision_ref'], item.fields['rule']]),
    [
      ['b', 'act.done_check'],
      ['a', 'gen.route'],
    ],
  );
  const shared = new MemoryDispatchJournal();
  const sameSeen = collector();
  const held = deferred();
  let entered = false;
  const winner = harness(
    {},
    {
      journal: shared,
      weft: sameSeen.port,
      dispatch: async (intent) => {
        entered = true;
        await held.promise;
        return dispatched(intent);
      },
    },
  );
  const win = run(winner);
  await waitUntil(() => entered);
  const loser = harness({}, { journal: shared, weft: sameSeen.port });
  const lost = await run(loser);
  assert.equal(lost.reason, 'dispatch_unconfirmed');
  assert.equal(sameSeen.records.length, 0);
  assert.deepEqual(shared.load('d1').decisions, []);
  held.release();
  await win;
  assert.equal(sameSeen.records.filter((item) => item.kind === 'dispatch.decided').length, 1);
  assert.equal(winner.dispatchCalls.length + loser.dispatchCalls.length, 1);
});

test('P4a-14 consequential requests stay identical; only eligible decisions add four isolated shadow asks', async () => {
  const policy = JSON.stringify(SITE_POLICY);
  for (const [plan] of PARITY) {
    const h = harness(plan);
    const decision = await run(h);
    const stages = [decision.intake, decision.triage, decision.route].filter((stage) => stage !== null).length;
    const consequential = h.evaluateCalls.filter((call) => !call.site.startsWith('decide1.'));
    const shadow = h.evaluateCalls.filter((call) => call.site.startsWith('decide1.'));
    const eligible = [
      'act.capability',
      'act.done_check',
      'act.decline',
      'gen.triage_fallback',
      'gen.route',
      'gen.route_fallback',
    ].includes(decision.decide1.rule);
    assert.equal(consequential.length, stages);
    assert.equal(shadow.length, eligible ? 4 : 0);
    assert.ok(shadow.every((call) => (call as EvaluationRequest).kind === 'boolean'));
    assert.equal(h.generateCalls.length, stages);
    // P3a's unchanged primitives provide an independent request oracle, including
    // failed admissions and fallbacks. Compare full requests, not just site names.
    const direct = harness(plan);
    const request = direct.request;
    const intake = await decideIntake(
      {
        request_id: `${request.request_id}:intake`,
        ...REVISION,
        state: request.intake,
        terms: request.terms,
        needs_dispatch: true,
      },
      direct.ports,
      direct.clock.now,
    );
    if (intake.status === 'transition' && intake.choice === 'new_thread') {
      const triage = await decideTriage(
        {
          request_id: `${request.request_id}:triage`,
          ...REVISION,
          state: { request: request.intake.message, context: request.triage_context },
          terms: request.terms,
          needs_dispatch: true,
        },
        direct.ports,
        direct.clock.now,
      );
      if (
        triage.site.status === 'transition' &&
        triage.site.observation.accepted &&
        triage.site.choice === 'implement'
      ) {
        await decideLoopRoute(
          {
            request_id: `${request.request_id}:route`,
            ...REVISION,
            state: { unit_of_work: request.intake.message, context: request.route_context },
            terms: request.terms,
            needs_dispatch: true,
          },
          direct.ports,
          direct.clock.now,
        );
      }
    }
    // Each extract call creates a fresh admission closure. Compare its source
    // alongside every wire field instead of requiring function identity.
    const generationRequests = (calls: readonly GenerationRequest[]) =>
      calls.map(({ accept, ...wire }) => ({ ...wire, accept: accept?.toString() }));
    assert.deepEqual(generationRequests(h.generateCalls), generationRequests(direct.generateCalls));
    assert.deepEqual(consequential, direct.evaluateCalls);
  }
  assert.equal(JSON.stringify(SITE_POLICY), policy);
});

test('P4a admission between stages uses a hold row without changing stored observations', async () => {
  for (const stage of ['intake', 'triage', 'route'] as const) {
    const live = harness();
    await run(live);
    const checkpoint = live.journal.load('d1').checkpoint!;
    const partial: DispatchCheckpoint = {
      ...checkpoint,
      intent: null,
      ...(stage === 'intake' ? { triage: null, route: null } : stage === 'triage' ? { route: null } : {}),
    };
    const journal = recoveredJournal(partial);
    const clock = makeClock();
    clock.advance();
    const seen = collector();
    const resumed = harness({}, { journal, clock, weft: seen.port, request: makeRequest({ resume: true }) });
    const decision = await run(resumed);
    assert.deepEqual(
      [decision.status, decision.reason, decision.decide1.rule, decision.decide1.band],
      ['paused', 'stale_answer', 'hold.admission', 'escalate_gen'],
    );
    assert.deepEqual(
      [decision.intake, decision.triage, decision.route],
      [partial.intake, partial.triage, partial.route],
    );
    assert.equal(decision.decide1.facts.find((fact) => fact.name === `${stage}.reason`)?.value, 'stale_answer');
    assert.deepEqual(
      seen.records.map((record) => record.kind),
      ['dispatch.decided'],
    );
    assert.equal(resumed.generateCalls.length + resumed.evaluateCalls.length + resumed.dispatchCalls.length, 0);
  }
});

const SHADOW_NAMES = ['clarify', 'multi_deliverable', 'reads_before_gen', 'veto_bare_gen'] as const;
function shadowCalls(h: ReturnType<typeof harness>) {
  return h.evaluateCalls.filter((call) => call.site.startsWith('decide1.'));
}
function p4aProjection(decision: DispatchDecision) {
  const { shadow: _shadow, preflight: _preflight, ...value } = structuredClone(decision);
  return {
    ...value,
    schema: 'dispatch.decision@2',
    triage: value.triage?.site ?? null,
    route: value.route?.site ?? null,
    decide1: {
      ...value.decide1,
      facts: value.decide1.facts.slice(0, 14),
      judgments: value.decide1.judgments.filter((judgment) => /^(intake|triage|route)\./.test(judgment.name)),
    },
  };
}

function shadowReasons(decision: DispatchDecision) {
  return decision.decide1.facts.slice(15, 19).map((fact) => fact.value);
}

test('P4b-7/10. shadow modes preserve outcomes for every stage shape and receipt', async () => {
  const scenarios: Plan[] = [
    ...PARITY.map(([plan]) => plan),
    ...SITE_POLICY['intake.classify'].options.map((choice) => ({ intake: { choice } })),
    ...SITE_POLICY['loop.triage'].options.map((choice) => ({ triage: { choice } })),
    ...SITE_POLICY['loop.route'].options.map((choice) => ({ route: { choice } })),
    ...(['stale', 'mismatch', 'outage', 'paused', 'no_answer'] as const).flatMap((mode) => [
      { intake: { mode } },
      { triage: { mode } },
      { route: { mode } },
    ]),
    { triage: { confidence: 0.1 } },
    { route: { confidence: 0.1 } },
  ];
  for (const scenario of scenarios) {
    const baseline = await run(harness(scenario));
    for (const shadow of ['true', 'false', 'throw', 'budget', 'malformed', 'foreign', 'no_answer'] as const) {
      const h = harness({ ...scenario, shadow });
      const result = await run(h);
      assert.deepEqual(p4aProjection(result), p4aProjection(baseline));
      assert.equal(result.decide1.facts.length, 32);
      const eligible = [
        'act.capability',
        'act.done_check',
        'act.decline',
        'gen.triage_fallback',
        'gen.route',
        'gen.route_fallback',
      ].includes(result.decide1.rule);
      assert.equal(shadowCalls(h).length, eligible ? 4 : 0);
      if (eligible) {
        const reason = {
          true: 'answered',
          false: 'answered',
          throw: 'decision_unavailable',
          budget: 'decision_unavailable',
          malformed: 'invalid_answer',
          foreign: 'mismatched_answer',
          no_answer: 'no_answer',
        }[shadow];
        assert.deepEqual(shadowReasons(result), Array(4).fill(reason));
      }
    }
  }
  for (const reason of ['approval_required', 'budget', 'no_grant', 'unknown_target', 'conflict'] as const) {
    const options = {
      receipt: (intent: DispatchIntent): DispatchReceipt => ({
        status: 'refused',
        dispatch_id: intent.dispatch_id,
        reason,
      }),
    };
    assert.deepEqual(
      p4aProjection(await run(harness({ shadow: 'budget' }, options))),
      p4aProjection(await run(harness({}, options))),
    );
  }
});

test('P4b-8. stages and counter precede shadow, results precede claim', async () => {
  const storage = new MemoryDispatchJournal();
  const journal: DispatchJournal = {
    load: (id) => storage.load(id),
    checkpoint: (cp) => storage.checkpoint(cp),
    claim: (id, intent, cp) => {
      assert.equal(cp?.shadow?.length, 4);
      assert.deepEqual(storage.load(id).checkpoint?.shadow, cp?.shadow);
      return storage.claim(id, intent, cp);
    },
    acquire: (id, token) => storage.acquire(id, token),
    release: (id, token) => storage.release(id, token),
    present: (id, token) => storage.present(id, token),
    append: (d, token) => storage.append(d, token),
  };
  const h = harness(
    {
      onEvaluate: (call) => {
        if (!call.site.startsWith('decide1.')) return;
        const cp = storage.load('d1').checkpoint!;
        assert.equal(cp.asks.shadow, 1);
        assert.equal(cp.route?.schema, 'loop.decision@1');
        assert.equal(cp.triage?.schema, 'loop.decision@1');
      },
    },
    { journal },
  );
  await run(h);
  assert.deepEqual(
    shadowCalls(h).map((call) => call.site),
    SHADOW_NAMES.map((j) => `decide1.${j}`),
  );
});

test('P4b-9. lost results are unrecorded and never re-asked; replay is pure', async () => {
  const storage = new MemoryDispatchJournal();
  let fail = true;
  const journal: DispatchJournal = {
    load: (id) => storage.load(id),
    checkpoint: (cp) => {
      if (fail && cp.shadow !== null) {
        fail = false;
        throw new Error('shadow write');
      }
      storage.checkpoint(cp);
    },
    claim: (id, intent, cp) => storage.claim(id, intent, cp),
    acquire: (id, token) => storage.acquire(id, token),
    release: (id, token) => storage.release(id, token),
    present: (id, token) => storage.present(id, token),
    append: (d, token) => storage.append(d, token),
  };
  const first = harness({}, { journal });
  await assert.rejects(run(first), /shadow write/);
  assert.equal(first.dispatchCalls.length, 0);
  const next = harness({}, { journal });
  const live = await run(next);
  assert.equal(shadowCalls(next).length, 0);
  assert.deepEqual(shadowReasons(live), Array(4).fill('unrecorded'));
  assert.deepEqual(transitionDispatch(next.request, storage.load('d1').checkpoint!, live.receipt, live.entry), live);
  const duplicate = harness({}, { journal, request: makeRequest({ resume: true }) });
  assert.deepEqual(await run(duplicate), live);
  assert.equal(duplicate.evaluateCalls.length, 0);
});

test('P4b-11. cancellation and stale shadow windows preserve admission gates', async () => {
  for (const stale of [false, true]) {
    const gate = deferred();
    const controller = new AbortController();
    const sink = collector();
    const h = harness({ gate: { match: (id) => id.includes(':shadow.'), promise: gate.promise } }, { weft: sink.port });
    const pending = run(h, controller.signal);
    await waitUntil(() => shadowCalls(h).length === 4 || h.dispatchCalls.length > 0);
    assert.equal(shadowCalls(h).length, 4);
    if (stale) h.clock.advance();
    else controller.abort();
    gate.release();
    const result = await pending;
    assert.deepEqual([result.status, result.reason], ['paused', stale ? 'stale_answer' : 'cancelled']);
    assert.equal(h.dispatchCalls.length, 0);
    if (stale) {
      assert.deepEqual(shadowReasons(result), Array(4).fill('stale_answer'));
      assert.equal(result.decide1.rule, 'hold.admission');
    } else {
      assert.equal(sink.records.length, 0);
      assert.equal(h.journal.load('d1').decisions.length, 0);
      assert.equal(h.journal.load('d1').checkpoint?.shadow, null);
      const resume = harness({}, { journal: h.journal, request: makeRequest({ resume: true }) });
      const resumed = await run(resume);
      assert.equal(shadowCalls(resume).length, 0);
      assert.deepEqual(shadowReasons(resumed), Array(4).fill('unrecorded'));
    }
  }
});

test('P4b-12. shadow corruption drops evidence; consequential extract corruption throws', async () => {
  const h = harness();
  const live = await run(h);
  const cp = h.journal.load('d1').checkpoint as any;
  assert.equal(cp.shadow?.length, 4);
  const mutations = [
    (s: any[]) => {
      s[0].request_id = 'foreign';
    },
    (s: any[]) => {
      s[0].state_revision++;
    },
    (s: any[]) => {
      s[0].reason = 'no_answer';
    },
    (s: any[]) => {
      s[0].probability = 2;
    },
    (s: any[]) => {
      s[0].extra = true;
    },
    (s: any[]) => {
      s[0].question = 'different';
    },
    (s: any[]) => {
      s.pop();
    },
    (s: any[]) => {
      s.reverse();
    },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(cp);
    mutate(forged.shadow);
    const replay = transitionDispatch(h.request, forged, live.receipt, live.entry);
    assert.deepEqual(p4aProjection(replay), p4aProjection(live));
    assert.equal(shadowReasons(replay)[0], 'untrusted');
  }
  for (const mutate of [
    (t: any) => {
      t.extracts.at(-1).residual_ambiguity.count = 1;
    },
    (t: any) => {
      t.extracts.at(-1).residual_ambiguity = { count: 1, slots: ['intent'] };
    },
    (t: any) => {
      t.extracts[0].request_id = 'other:x1';
    },
    (t: any) => {
      t.extracts.push(t.extracts[0], t.extracts[0]);
    },
  ]) {
    const forged = structuredClone(cp);
    mutate(forged.triage);
    assert.throws(() => transitionDispatch(h.request, forged, live.receipt, live.entry), /recorded triage/);
    const sink = collector();
    const recovery = harness({}, { journal: forgedJournal(forged), weft: sink.port });
    await assert.rejects(run(recovery), /recorded triage/);
    assert.equal(recovery.dispatchCalls.length + sink.records.length, 0);
  }
});

test('P4b-12. tampered extracts reject replay before any effect or copied text', async (t) => {
  const h = harness();
  const live = await run(h);
  const cp = h.journal.load('d1').checkpoint!;
  const cases: readonly (readonly [string, 'intake' | 'triage' | 'route', (extract: any) => void])[] = [
    ...(['triage', 'route'] as const).flatMap((stage) =>
      (
        [
          [
            'extra key',
            (x: any) => {
              x.extra = 'CANARY-msg';
            },
          ],
          [
            'span value',
            (x: any) => {
              x.slots[0].value = 'CANARY-msg';
            },
          ],
          [
            'choice outside options',
            (x: any) => {
              x.slots[0].kind = 'choice';
              x.slots[0].value = 'outside';
            },
          ],
          [
            'extra slot before intent',
            (x: any) => {
              x.slots.unshift({ ...x.slots[0], slot: 'extra' });
            },
          ],
          [
            'extra slot key',
            (x: any) => {
              x.slots[0].extra = 'CANARY-msg';
            },
          ],
          [
            'invalid span',
            (x: any) => {
              x.slots[0].span = [-1, 2];
            },
          ],
          [
            'invalid verdict',
            (x: any) => {
              x.verdict = 'CANARY-msg';
            },
          ],
          [
            'invalid reason',
            (x: any) => {
              x.reason = 'CANARY-msg';
            },
          ],
        ] as const
      ).map(([name, mutate]) => [name, stage, mutate] as const),
    ),
    [
      'choice outside options',
      'intake',
      (x) => {
        x.slots[0].value = 'outside';
      },
    ],
    [
      'slot order swapped',
      'intake',
      (x) => {
        x.slots.reverse();
      },
    ],
  ];
  for (const [name, stage, mutate] of cases) {
    await t.test(`${stage}: ${name}`, async () => {
      const forged = structuredClone(cp);
      mutate(stage === 'intake' ? forged.intake!.extract[0] : forged[stage]!.extracts[0]);
      assert.throws(
        () => transitionDispatch(h.request, forged, live.receipt, live.entry),
        new RegExp(`recorded ${stage}`),
      );
      const writes: unknown[] = [];
      const journal: DispatchJournal = {
        ...forgedJournal(forged),
        checkpoint: (entry) => {
          writes.push(entry);
        },
        claim: (...args) => {
          writes.push(args);
          return false;
        },
        acquire: (...args) => {
          writes.push(args);
          return null;
        },
        release: (...args) => {
          writes.push(args);
        },
        present: (...args) => {
          writes.push(args);
          return false;
        },
        append: (...args) => {
          writes.push(args);
          return false;
        },
      };
      const sink = collector();
      const recovery = harness({}, { journal, weft: sink.port });
      for (let replay = 0; replay < 2; replay++) await assert.rejects(run(recovery), new RegExp(`recorded ${stage}`));
      assert.equal(recovery.generateCalls.length + recovery.evaluateCalls.length + recovery.dispatchCalls.length, 0);
      assert.deepEqual(writes, []);
      assert.deepEqual(sink.records, []);
      assertNoCopiedText([writes, ...sink.records], CANARIES);
      assert.deepEqual(journal.load('d1').checkpoint, forged);
    });
  }
});

test('P4b-13. residual ambiguity is the final D1 extract count, with fixed fact order', async () => {
  for (const [plan, residual] of [
    [{}, 0],
    [{ triageIntent: '' }, 1],
    [{ triageIntent: 'absent' }, 1],
    [{ intake: { choice: 'continue_thread' } }, null],
    [{ intake: { choice: 'ask_user' } }, null],
  ] as const) {
    const h = harness(plan);
    const live = await run(h);
    assert.equal(live.decide1.facts.length, 32);
    assert.deepEqual(
      live.decide1.facts.slice(14, 19).map((f) => f.name),
      ['residual_ambiguity', ...SHADOW_NAMES.map((j) => `${j}.reason`)],
    );
    assert.equal(live.decide1.facts[14]?.value, residual);
    assert.deepEqual(transitionDispatch(h.request, h.journal.load('d1').checkpoint!, live.receipt, live.entry), live);
  }
});

test('P4b-14. schemas, Weft shadow evidence and text exclusion', async () => {
  const sink = collector();
  const h = harness({}, { weft: sink.port });
  const live = await run(h);
  assert.equal(live.schema, 'dispatch.decision@4');
  assert.equal(h.journal.load('d1').checkpoint?.schema, 'dispatch.checkpoint@3');
  const decided = sink.records.find((r) => r.kind === 'dispatch.decided')!;
  assert.equal(decided.fields.facts && (decided.fields.facts as unknown[]).length, 32);
  assert.ok((decided.fields.judgments as unknown[]).length <= 14);
  for (const record of sink.records) assert.equal(validateRecord(record).ok, true);
  for (const j of SHADOW_NAMES) {
    assert.ok(decided.evidence.some((e) => e.source === 'inference_request' && e.ref === `d1:shadow.${j}`));
    assert.ok(!decided.links.some((link) => link.record_id.includes(':shadow.')));
  }
  assert.equal(sink.records.filter((r) => r.kind === 'judgment').length, 3);
  assertNoCopiedText([live, h.journal.load('d1'), ...sink.records], CANARIES);
  const oldCp = {
    ...h.journal.load('d1').checkpoint!,
    schema: 'dispatch.checkpoint@1',
  } as unknown as DispatchCheckpoint;
  assert.throws(() => transitionDispatch(h.request, oldCp, live.receipt), /schema/);
  await assert.rejects(run(harness({}, { journal: forgedJournal(oldCp) })), /schema/);
  const oldDecision = { ...live, schema: 'dispatch.decision@2' } as unknown as DispatchDecision;
  const journal = {
    ...forgedJournal(h.journal.load('d1').checkpoint!),
    load: () => ({ checkpoint: null, decisions: [oldDecision], attempt: null, presented: false }),
  };
  await assert.rejects(run(harness({}, { journal })), /schema/);
});

test('P4b-15. out-of-order shadow rounds bind their own snapshots and Weft sequences', async () => {
  const sink = collector();
  const gate = deferred();
  const a = harness(
    { shadow: 'false', gate: { match: (id) => id.includes(':shadow.'), promise: gate.promise } },
    { weft: sink.port, request: makeRequest({ request_id: 'a' }) },
  );
  const pending = run(a);
  await waitUntil(() => shadowCalls(a).length === 4 || a.dispatchCalls.length > 0);
  assert.equal(shadowCalls(a).length, 4);
  const b = harness({ shadow: 'true' }, { weft: sink.port, request: makeRequest({ request_id: 'b' }) });
  const second = await run(b);
  gate.release();
  const first = await pending;
  assert.equal(first.decide1.judgments.find((j) => j.name === 'clarify')?.probability, 0);
  assert.equal(second.decide1.judgments.find((j) => j.name === 'clarify')?.probability, 1);
  assert.deepEqual(
    sink.records.map((r) => r.sequence),
    sink.records.map((_, i) => i + 1),
  );
  const journal = new MemoryDispatchJournal();
  const sameGate = deferred();
  const intakeGate = deferred();
  const y = harness(
    { shadow: 'true', gate: { match: (id) => id === 'd1:intake', promise: intakeGate.promise } },
    { journal },
  );
  const yp = run(y);
  await waitUntil(() => y.evaluateCalls.length === 1);
  const x = harness(
    { shadow: 'false', gate: { match: (id) => id.includes(':shadow.'), promise: sameGate.promise } },
    { journal },
  );
  const xp = run(x);
  await waitUntil(() => shadowCalls(x).length === 4);
  intakeGate.release();
  const won = await yp;
  sameGate.release();
  const yielded = await xp;
  assert.deepEqual(yielded, won);
  assert.equal(x.dispatchCalls.length + y.dispatchCalls.length, 1);
  assert.deepEqual(transitionDispatch(y.request, journal.load('d1').checkpoint!, won.receipt, won.entry), won);
  assert.equal(shadowCalls(x).length, 4);
  assert.equal(shadowCalls(y).length, 4);
});

test('P4b-12/13. two-attempt D1 replay binds every extract and uses the second residual', async () => {
  const h = harness({ triageIntent: 'absent' });
  const generate = h.ports.generate;
  const ports: DispatchPorts = {
    ...h.ports,
    generate: async (request, signal) =>
      request.request_id === 'd1:triage:x2'
        ? acceptedGeneration(request, { intent: { value: MESSAGE } })
        : generate(request, signal),
  };
  const live = await decideDispatch(h.request, ports, h.journal);
  const cp = h.journal.load('d1').checkpoint!;
  assert.equal(cp.triage?.extracts.length, 2);
  assert.deepEqual(
    cp.triage?.extracts.map((x) => x.residual_ambiguity.count),
    [1, 0],
  );
  assert.equal(live.decide1.facts.find((f) => f.name === 'residual_ambiguity')?.value, 0);
  for (const patch of [
    { request_id: 'foreign:x1' },
    { site: 'loop.route' },
    { state_revision: 2 },
    { extract_schema: 'loop.route@1' },
  ]) {
    const forged = structuredClone(cp);
    Object.assign(forged.triage!.extracts[0]!, patch);
    assert.throws(() => transitionDispatch(h.request, forged, live.receipt), /recorded triage/);
  }
});

test('P4b-12/14. dropping untrusted shadows also screens returned evidence and copied text', async () => {
  const h = harness();
  const live = await run(h);
  const cp = structuredClone(h.journal.load('d1').checkpoint!);
  Object.assign(cp.shadow![0]!, { request_id: 'Bearer CANARY-error', extra: 'CANARY-provider' });
  const replay = transitionDispatch(h.request, cp, live.receipt);
  assert.equal(shadowReasons(replay)[0], 'untrusted');
  assertNoCopiedText(replay, CANARIES);
  const record = dispatchDecided(replay, [], { trace_id: 'trace-1', emitter_id: 'loom.dispatch' }, 1);
  assert.notEqual(record, null);
  assert.deepEqual(validateRecord(record), { ok: true });
});

test('P4b-9/11. counter-write failures and pre-shadow aborts make no shadow call or claim', async () => {
  for (const abort of [false, true]) {
    const storage = new MemoryDispatchJournal();
    const controller = new AbortController();
    let claims = 0;
    const journal: DispatchJournal = {
      ...forgedJournal(null as unknown as DispatchCheckpoint),
      load: (id) => storage.load(id),
      checkpoint: (cp) => {
        if (cp.asks.shadow === 1) {
          if (!abort) throw new Error('counter write');
          storage.checkpoint(cp);
          controller.abort();
          return;
        }
        storage.checkpoint(cp);
      },
      claim: () => {
        claims++;
        return false;
      },
    };
    const h = harness({}, { journal });
    if (abort) assert.equal((await run(h, controller.signal)).reason, 'cancelled');
    else await assert.rejects(run(h), /counter write/);
    assert.equal(shadowCalls(h).length + h.dispatchCalls.length + claims, 0);
    assert.equal(storage.load('d1').decisions.length, 0);
  }
});

test('P4b-9. D2 resumes before one shadow round, then a budget resume reuses it', async () => {
  const outage = harness({ route: { mode: 'outage' } });
  assert.equal((await run(outage)).decide1.rule, 'hold.outage');
  assert.equal(shadowCalls(outage).length, 0);
  const budget = harness(
    {},
    {
      journal: outage.journal,
      request: makeRequest({ resume: true }),
      receipt: (intent) => ({ status: 'refused', dispatch_id: intent.dispatch_id, reason: 'budget' }),
    },
  );
  const paused = await run(budget);
  assert.equal(paused.reason, 'budget');
  assert.equal(shadowCalls(budget).length, 4);
  const resumed = harness({}, { journal: outage.journal, request: makeRequest({ resume: true }) });
  const dispatchedAgain = await run(resumed);
  assert.equal(resumed.evaluateCalls.length + resumed.generateCalls.length, 0);
  assert.deepEqual(dispatchedAgain.shadow, paused.shadow);
  assert.deepEqual(dispatchedAgain.decide1, paused.decide1);
});

test('P4b-10. every shadow admission failure leaves the live dispatch projection unchanged', async () => {
  const baseline = await run(harness());
  const failures: readonly (readonly [string, (call: EvaluationRequest) => unknown])[] = [
    ['decision_unavailable', () => null],
    ...['provider_unavailable', 'no_route', 'no_budget', 'quota_unknown'].map(
      (reason) =>
        [
          'decision_unavailable',
          (call: EvaluationRequest) => ({ status: 'blocked', reason, request_id: call.request_id, site: call.site }),
        ] as const,
    ),
    [
      'invalid_answer',
      (call) => ({
        status: 'accepted',
        request_id: call.request_id,
        site: call.site,
        kind: 'choice',
        answers: { decision: { type: 'boolean', probability: 1 } },
      }),
    ],
    [
      'invalid_answer',
      (call) => ({ status: 'accepted', request_id: call.request_id, site: call.site, kind: 'boolean', answers: {} }),
    ],
    [
      'invalid_answer',
      (call) => ({
        status: 'accepted',
        request_id: call.request_id,
        site: call.site,
        kind: 'boolean',
        answers: { decision: { type: 'boolean', probability: -1 } },
      }),
    ],
    [
      'mismatched_answer',
      (call) => ({
        status: 'accepted',
        request_id: call.request_id,
        site: 'decide1.other',
        kind: 'boolean',
        answers: { decision: { type: 'boolean', probability: 1 } },
      }),
    ],
  ];
  for (const [reason, answer] of failures) {
    const h = harness();
    const evaluate = (async (call: EvaluationRequest, signal?: AbortSignal) =>
      call.site.startsWith('decide1.') ? answer(call) : h.ports.evaluate(call, signal)) as InferenceGateway['evaluate'];
    const decision = await decideDispatch(h.request, { ...h.ports, evaluate }, h.journal);
    assert.deepEqual(p4aProjection(decision), p4aProjection(baseline));
    assert.deepEqual(shadowReasons(decision), Array(4).fill(reason));
  }
  // A round lost before results is also a shadow-free runtime parity case.
  const cp = baseline;
  const source = harness();
  await run(source);
  const recorded = source.journal.load('d1').checkpoint!;
  const journal = new MemoryDispatchJournal();
  journal.checkpoint({ ...recorded, intent: null, shadow: null });
  const neverAsked = harness({}, { journal });
  const decision = await run(neverAsked);
  assert.deepEqual(p4aProjection(decision), p4aProjection(cp));
  assert.equal(shadowCalls(neverAsked).length, 0);
});

function delegate(journal: DispatchJournal): DispatchJournal {
  return {
    load: (id) => journal.load(id),
    checkpoint: (cp) => journal.checkpoint(cp),
    claim: (id, intent, cp) => journal.claim(id, intent, cp),
    acquire: (id, token) => journal.acquire(id, token),
    release: (id, token) => journal.release(id, token),
    present: (id, token) => journal.present(id, token),
    append: (decision, token) => journal.append(decision, token),
  };
}
// P5a contracts: targets are caller-disclosed, and all derived evidence remains shadow.
const ROLE_TARGETS = [
  { ref: 'target0', summary: 'CANARY-target CANARY-summary' },
  { ref: 'target1', summary: 'CANARY-target' },
  { ref: 'target2', summary: 'CANARY-target' },
  { ref: 'target3', summary: 'CANARY-target' },
];
function roleRequest(overrides: object = {}): DispatchRequest {
  return makeRequest({ targets: structuredClone(ROLE_TARGETS), ...overrides } as Partial<DispatchRequest>);
}
function roleCalls(h: ReturnType<typeof harness>) {
  return h.evaluateCalls.filter((c) => c.site === 'spawn.roles');
}
function preflight(value: DispatchDecision | DispatchCheckpoint): any {
  return (value as any).preflight;
}
function fact(d: DispatchDecision, name: string) {
  return d.decide1.facts.find((f) => f.name === name)?.value;
}
function p4bProjection(d: DispatchDecision) {
  const { preflight: _p, ...copy } = structuredClone(d) as any;
  copy.schema = 'dispatch.decision@3';
  copy.decide1.facts = copy.decide1.facts.slice(0, 19);
  copy.decide1.judgments = copy.decide1.judgments.filter((j: any) => !j.name.startsWith('preflight.'));
  return copy;
}
function dispatchProjection(d: DispatchDecision) {
  return {
    intent: d.intent,
    status: d.status,
    reason: d.reason,
    decided_by: d.decided_by,
    choice: d.choice,
    receipt: d.receipt,
    rule: d.decide1.rule,
    band: d.decide1.band,
  };
}

function assertNullSpawn(d: DispatchDecision) {
  assert.deepEqual(
    d.decide1.facts.filter((f) => f.name.startsWith('spawn.')),
    ['spawn.gain', 'spawn.children', 'spawn.plan'].map((name) => ({ name, value: null })),
  );
}

test('P5a-fix1 invalid ceilings cannot escape shadow computation at any dispatch boundary', async (t) => {
  for (const cost_ceiling of [2.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
    for (const path of ['live', 'receipt resume', 'crash resume', 'stale', 'cancel'] as const)
      await t.test(`${cost_ceiling}: ${path}`, async () => {
        async function exercise(targets: boolean) {
          const request = makeRequest({
            terms: { ...terms, cost_ceiling },
            ...(targets ? { targets: structuredClone(ROLE_TARGETS) } : {}),
          });
          const storage = new MemoryDispatchJournal();
          const clock = makeClock();
          const controller = new AbortController();
          const claims: DispatchIntent[] = [];
          let interrupted = false;
          const journal: DispatchJournal = {
            ...delegate(storage),
            checkpoint(cp) {
              storage.checkpoint(cp);
              // Results are durable and roles are answered before this boundary moves.
              if (cp.shadow !== null && !interrupted) {
                interrupted = true;
                if (path === 'stale') clock.advance();
                if (path === 'cancel') controller.abort();
                if (path === 'crash resume') throw new Error('crash after shadow results');
              }
            },
            claim(id, intent, cp) {
              claims.push(structuredClone(intent));
              return storage.claim(id, intent, cp);
            },
          };
          const h = harness(
            { roles: ['edit', 'read', 'forbid', 'skip'] },
            {
              request,
              journal,
              clock,
              ...(path === 'receipt resume'
                ? {
                    receipt: (intent: DispatchIntent) =>
                      ({ status: 'refused', dispatch_id: intent.dispatch_id, reason: 'budget' }) as const,
                  }
                : {}),
            },
          );
          if (path === 'crash resume') await assert.rejects(run(h), /crash after shadow results/);
          else {
            const first = await run(h, controller.signal);
            assertNullSpawn(first);
            if (path !== 'receipt resume') {
              if (targets) assert.equal(first.preflight?.reason, 'answered');
              return { decision: first, claims, h, storage };
            }
          }
          const resumed = harness({}, { request: { ...request, resume: true }, journal, clock });
          const decision = await run(resumed);
          assertNullSpawn(decision);
          assert.equal(resumed.generateCalls.length + resumed.evaluateCalls.length, 0);
          if (targets) assert.equal(decision.preflight?.reason, 'answered');
          return { decision, claims, h: resumed, storage };
        }
        const baseline = await exercise(false);
        const shadow = await exercise(true);
        assert.deepEqual(dispatchProjection(shadow.decision), dispatchProjection(baseline.decision));
        assert.deepEqual(shadow.claims, baseline.claims);
        if (path === 'stale' || path === 'cancel') {
          assert.equal(shadow.claims.length + shadow.h.dispatchCalls.length, 0);
          assert.equal(shadow.decision.reason, path === 'stale' ? 'stale_answer' : 'cancelled');
        } else {
          const replay = transitionDispatch(
            shadow.h.request,
            shadow.storage.load('d1').checkpoint!,
            shadow.decision.receipt,
            shadow.decision.entry,
          );
          assert.deepEqual(replay, shadow.decision);
          assertNullSpawn(replay);
        }
      });
});

test('P5a-fix2 invalid ambiguity on stale and cancellation boundaries is absent spawn evidence', async (t) => {
  const source = harness({}, { request: roleRequest() });
  await run(source);
  const recorded = source.journal.load('d1').checkpoint!;
  for (const ambiguity of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined])
    for (const path of ['stale', 'cancel'] as const)
      await t.test(`${ambiguity}: ${path}`, async () => {
        async function exercise(shadow: boolean) {
          const cp = structuredClone(recorded);
          Object.assign(cp, { intent: null, ...(shadow ? {} : { preflight: null, shadow: null }) });
          Object.assign(cp.triage!.extracts.at(-1)!.residual_ambiguity, { count: ambiguity });
          const storage = new MemoryDispatchJournal();
          storage.checkpoint(cp);
          let claims = 0;
          const journal: DispatchJournal = {
            ...delegate(storage),
            claim() {
              claims++;
              throw new Error('boundary must not claim');
            },
          };
          const clock = makeClock();
          const controller = new AbortController();
          if (path === 'stale') clock.advance();
          else controller.abort();
          const h = harness({}, { request: source.request, journal, clock });
          const decision = await run(h, controller.signal);
          assertNullSpawn(decision);
          assert.equal(fact(decision, 'residual_ambiguity'), null);
          assert.equal(decision.reason, path === 'stale' ? 'stale_answer' : 'cancelled');
          assert.equal(h.generateCalls.length + h.evaluateCalls.length + h.dispatchCalls.length + claims, 0);
          assert.equal(storage.load('d1').decisions.length, path === 'stale' ? 1 : 0);
          return decision;
        }
        const baseline = await exercise(false);
        const shadow = await exercise(true);
        assert.equal(shadow.preflight?.reason, 'answered');
        assert.deepEqual(dispatchProjection(shadow), dispatchProjection(baseline));
      });
});

test('P5a-fix2 well-formed answered edit rounds always expose validated spawn facts', async (t) => {
  // No edit means no plan by contract; P5a-12 separately covers those answered rounds.
  const mixes = [
    ['edit'],
    ['edit', 'edit', 'edit', 'edit'],
    ['edit', 'read', 'forbid', 'skip'],
    ['skip', 'forbid', 'read', 'edit'],
    ['forbid', 'edit', 'skip', 'edit'],
    ['read', 'read', 'edit', 'read'],
    ['edit', 'read', 'forbid', 'skip', 'edit', 'read', 'forbid', 'skip'],
    Array(8).fill('edit') as string[],
  ];
  for (const tier of ['flash', 'standard', 'strong'])
    for (const roles of mixes)
      for (const cost_ceiling of [0, Number.MAX_SAFE_INTEGER])
        await t.test(`${tier}: ${roles.join(',')}: ${cost_ceiling}`, async () => {
          const request = roleRequest({
            terms: { ...terms, cost_ceiling },
            targets: roles.map((_, i) => ({ ref: `target${i}`, summary: '' })),
          });
          const h = harness({ roles, route: { choice: tier } }, { request });
          const decision = await run(h);
          assert.equal(decision.preflight?.reason, 'answered');
          assert.equal(fact(decision, 'spawn.gain'), true);
          assert.equal(fact(decision, 'spawn.children'), roles.filter((r) => r === 'edit' || r === 'read').length + 1);
          assert.match(fact(decision, 'spawn.plan') as string, /^[a-f0-9]{64}$/);
          assert.deepEqual(transitionDispatch(request, h.journal.load('d1').checkpoint!, decision.receipt), decision);
        });
});

test('P5a-fix1 every untrusted preflight input fails to null facts without moving policy', async (t) => {
  const { preflightPlan } = await import('../src/spawn.js');
  const { digest } = await import('../src/digest.js');
  const h = harness({}, { request: roleRequest() });
  await run(h);
  const recorded = h.journal.load('d1').checkpoint!;
  const cases: readonly (readonly [string, (request: any, cp: any) => void, RegExp])[] = [
    ...[2.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1].map(
      (budget) =>
        [
          `budget ${budget}`,
          (r: any) => {
            r.terms.cost_ceiling = budget;
          },
          /invalid plan fields/,
        ] as const,
    ),
    [
      'lineage',
      (_r, cp) => {
        cp.decision_id = 'invalid/id';
        cp.preflight.request_id = 'invalid/id:roles';
      },
      /invalid plan fields/,
    ],
    [
      'target reference',
      (r, cp) => {
        r.targets[0].ref = cp.preflight.targets[0].ref = 'invalid/ref';
      },
      /invalid targets/,
    ],
    [
      'duplicate target',
      (r, cp) => {
        r.targets[0].ref = cp.preflight.targets[0].ref = r.targets[1].ref;
      },
      /invalid targets/,
    ],
    [
      'target count',
      (r, cp) => {
        for (let i = 4; i < 9; i++) {
          r.targets.push({ ref: `target${i}`, summary: '' });
          cp.preflight.targets.push({ ref: `target${i}`, role: 'edit', top_p: 1, confidence: 1 });
        }
      },
      /invalid targets/,
    ],
    [
      'role value',
      (_r, cp) => {
        cp.preflight.targets[0].role = 'foreign';
      },
      /invalid roles/,
    ],
    [
      'role count',
      (_r, cp) => {
        cp.preflight.targets.pop();
      },
      /invalid roles/,
    ],
    ...[-1, 0.5].map(
      (ambiguity) =>
        [
          `ambiguity ${ambiguity}`,
          (_r: any, cp: any) => {
            cp.triage.extracts.at(-1).residual_ambiguity.count = ambiguity;
          },
          /invalid ambiguity/,
        ] as const,
    ),
  ];
  for (const [name, mutate, error] of cases)
    await t.test(name, () => {
      const request = structuredClone(h.request);
      const cp = structuredClone(recorded);
      mutate(request, cp);
      // Prove each case reaches a real validator failure, rather than a no-edit plan.
      assert.throws(
        () =>
          preflightPlan({
            decision_id: cp.decision_id,
            root_ref: cp.decision_id,
            goal_digest: digest({ message: request.intake.message }),
            budget: request.terms.cost_ceiling,
            tier: 'flash',
            targets: request.targets!.map((target) => target.ref),
            roles: cp.preflight!.targets.map((target) => target.role!),
            ambiguity: cp.triage!.extracts.at(-1)!.residual_ambiguity.count,
          }),
        error,
      );
      // This adapter is also used by cancellation and stale boundaries, before replay.
      const inputs = decide1Inputs(request, cp);
      const baseline = decide1Inputs(request, { ...cp, preflight: null, shadow: null });
      assert.deepEqual(
        inputs.shadow!.facts.filter((f) => f.name.startsWith('spawn.')).map((f) => f.value),
        [null, null, null],
      );
      assert.deepEqual(inputs.facts, baseline.facts);
      assert.deepEqual(inputs.judgments, baseline.judgments);
      const actual = decideBand(inputs);
      const expected = decideBand(baseline);
      assert.deepEqual([actual.band, actual.rule], [expected.band, expected.rule]);
      // Pure replay does not run live target ingress validation; it must still be isolated.
      if (
        name.startsWith('target') ||
        name.startsWith('duplicate') ||
        name.startsWith('role') ||
        name.startsWith('budget')
      ) {
        const noShadow = { ...cp, preflight: null, shadow: null };
        const replay = transitionDispatch(request, cp, null);
        assertNullSpawn(replay);
        assert.deepEqual(dispatchProjection(replay), dispatchProjection(transitionDispatch(request, noShadow, null)));
      } else if (name.startsWith('ambiguity'))
        assert.throws(() => transitionDispatch(request, cp, null), /recorded triage/);
      else assert.throws(() => transitionDispatch(request, cp, null), /checkpoint belongs to another decision/);
    });
});

test('P5a-fix1 every shadow answer path screens validator failures before policy and replay', async () => {
  const h = harness(
    {},
    {
      request: roleRequest({ targets: Array.from({ length: 8 }, (_, i) => ({ ref: `target${i}`, summary: '' })) }),
    },
  );
  const live = await run(h);
  const cp = h.journal.load('d1').checkpoint!;
  const baseline = transitionDispatch(h.request, { ...cp, preflight: null, shadow: null }, live.receipt);
  // Cover every P4b judgment and every P5a target, including all emitted statistics.
  const paths: readonly (readonly [string, (cp: any, value: unknown) => void, string])[] = [
    ...cp.shadow!.flatMap((observation, i) => {
      const name = observation.site.slice('decide1.'.length);
      return ['probability', 'confidence'].map(
        (field) =>
          [
            `${name}.${field}`,
            (cp: any, value: unknown) => {
              cp.shadow[i][field] = value;
            },
            `${name}.reason`,
          ] as const,
      );
    }),
    ...cp.preflight!.targets.flatMap((_, i) =>
      ['role', 'top_p', 'confidence'].map(
        (field) =>
          [
            `preflight.t${i}.${field}`,
            (cp: any, value: unknown) => {
              cp.preflight.targets[i][field] = value;
            },
            'preflight.reason',
          ] as const,
      ),
    ),
  ];
  for (const [path, mutate, reasonFact] of paths)
    for (const value of [NaN, Infinity, -1, 2, 'foreign']) {
      const bad = structuredClone(cp);
      mutate(bad, value);
      const replay = transitionDispatch(h.request, bad, live.receipt);
      assert.deepEqual(dispatchProjection(replay), dispatchProjection(baseline), path);
      assert.equal(fact(replay, reasonFact), 'untrusted', path);
      const inputs = decide1Inputs(h.request, bad);
      const name = path.startsWith('preflight.') ? 'preflight.' : path.split('.')[0]!;
      assert.ok(
        inputs.shadow!.judgments.every((judgment) => !judgment.name.startsWith(name)),
        path,
      );
      if (path.startsWith('preflight.')) {
        assertNullSpawn(replay);
        assert.ok(
          replay.decide1.facts.filter((f) => /^preflight\.t\d\.role$/.test(f.name)).every((f) => f.value === null),
          path,
        );
      }
    }
});

test('P5a-10 parity for every P4b stage shape without targets or with an empty set', async () => {
  const scenarios: Plan[] = [
    ...PARITY.map(([p]) => p),
    ...SITE_POLICY['intake.classify'].options.map((choice) => ({ intake: { choice } })),
    ...SITE_POLICY['loop.triage'].options.map((choice) => ({ triage: { choice } })),
    ...SITE_POLICY['loop.route'].options.map((choice) => ({ route: { choice } })),
    ...(['stale', 'mismatch', 'outage', 'paused', 'no_answer'] as const).flatMap((mode) => [
      { intake: { mode } },
      { triage: { mode } },
      { route: { mode } },
    ]),
  ];
  for (const scenario of scenarios) {
    const absent = harness(scenario);
    const empty = harness(scenario, { request: roleRequest({ targets: [] }) });
    const [a, b] = await Promise.all([run(absent), run(empty)]);
    assert.equal(a.decide1.facts.length, 32);
    assert.deepEqual(p4bProjection(a), p4bProjection(b));
    assert.deepEqual(
      a.decide1.facts.slice(19).map((f) => f.value),
      [null, 0, ...Array(11).fill(null)],
    );
    assert.equal(roleCalls(absent).length + roleCalls(empty).length, 0);
  }
});

test('P5a-11 eligibility, concurrent shadow window and atomic evidence writes', async () => {
  for (const [p] of PARITY) {
    const h = harness(p, { request: roleRequest() });
    const d = await run(h);
    assert.equal(roleCalls(h).length, d.decide1.rule === 'gen.route' ? 1 : 0);
  }
  const storage = new MemoryDispatchJournal();
  const writes: DispatchCheckpoint[] = [];
  let claims = 0;
  const journal: DispatchJournal = {
    ...delegate(storage),
    checkpoint(cp) {
      writes.push(structuredClone(cp));
      storage.checkpoint(cp);
    },
    claim(id, intent, cp) {
      claims++;
      assert.ok(cp?.shadow);
      assert.ok(preflight(cp!));
      assert.deepEqual(storage.load(id).checkpoint, cp);
      return storage.claim(id, intent, cp);
    },
  };
  const gate = deferred();
  const h = harness(
    {
      gate: { match: (id) => id.includes(':shadow.') || id.endsWith(':roles'), promise: gate.promise },
      onEvaluate(r) {
        if (r.site === 'spawn.roles') {
          const cp = storage.load('d1').checkpoint!;
          assert.equal(cp.asks.shadow, 1);
          assert.equal((cp.asks as any).preflight, 1);
        }
      },
    },
    { request: roleRequest(), journal },
  );
  const pending = run(h);
  await waitUntil(() => roleCalls(h).length === 1 || h.dispatchCalls.length > 0);
  assert.equal(roleCalls(h).length, 1);
  assert.equal(shadowCalls(h).length, 4);
  assert.equal(claims, 0);
  const cp = writes.at(-1)!;
  assert.equal(cp.asks.shadow, 1);
  assert.equal((cp.asks as any).preflight, 1);
  assert.equal(preflight(cp), null);
  assert.equal(cp.shadow, null);
  gate.release();
  await pending;
  const window = writes.filter((cp) => cp.asks.shadow === 1);
  assert.equal(window.length, 2);
  assert.ok(window[1]!.shadow);
  assert.ok(preflight(window[1]!));
  assert.equal(claims, 1);
  const bare = harness();
  await run(bare);
  assert.deepEqual(JSON.parse(JSON.stringify(h.generateCalls)), JSON.parse(JSON.stringify(bare.generateCalls)));
  assert.deepEqual(
    h.evaluateCalls.filter((c) => c.site !== 'spawn.roles'),
    bare.evaluateCalls,
  );
});

test('P5a-12 roles never move dispatch; recomputed plan digest, gain and children', async () => {
  const { preflightPlan, validatePlan } = await import('../src/' + 'spawn.js');
  const { digest } = await import('../src/digest.js');
  for (const tier of ['flash', 'standard', 'strong'])
    for (const roles of [
      ['edit', 'edit', 'edit', 'edit'],
      ['edit', 'read', 'forbid', 'skip'],
      ['read', 'read', 'read', 'read'],
      ['skip', 'skip', 'skip', 'skip'],
      'invalid',
      'outage',
      'foreign',
      'budget',
    ] as const) {
      const baseline = await run(harness({ route: { choice: tier } }));
      const h = harness({ route: { choice: tier }, roles }, { request: roleRequest() });
      const d = await run(h);
      assert.deepEqual(dispatchProjection(d), dispatchProjection(baseline));
      if (Array.isArray(roles)) {
        const expected = preflightPlan({
          decision_id: 'd1',
          root_ref: 'd1',
          goal_digest: digest({ message: MESSAGE }),
          budget: terms.cost_ceiling,
          tier,
          targets: ROLE_TARGETS.map((t) => t.ref),
          roles,
          ambiguity: fact(d, 'residual_ambiguity'),
        });
        assert.equal(fact(d, 'spawn.gain'), expected.gain);
        assert.equal(fact(d, 'spawn.children'), expected.plan?.children.length ?? null);
        assert.equal(
          fact(d, 'spawn.plan'),
          expected.plan
            ? validatePlan(
                expected.plan,
                ROLE_TARGETS.map((t) => t.ref),
              ).digest
            : null,
        );
      } else assert.equal(fact(d, 'spawn.plan'), null);
      assert.equal(h.generateCalls.length, 3);
    }
});

test('P5a-13 crash, outage resume, receipt resume, unconfirmed recovery and pure replay', async () => {
  for (const abort of [false, true]) {
    const store = new MemoryDispatchJournal();
    const controller = new AbortController();
    let claimed = 0;
    const failing: DispatchJournal = {
      ...delegate(store),
      checkpoint(cp) {
        if (cp.asks.preflight === 1) {
          if (!abort) throw new Error('roles counter');
          controller.abort();
        }
        store.checkpoint(cp);
      },
      claim(id, intent, cp) {
        claimed++;
        return store.claim(id, intent, cp);
      },
    };
    const h = harness({}, { request: roleRequest(), journal: failing });
    if (abort) assert.equal((await run(h, controller.signal)).reason, 'cancelled');
    else await assert.rejects(run(h), /roles counter/);
    assert.equal(roleCalls(h).length + shadowCalls(h).length + h.dispatchCalls.length + claimed, 0);
  }
  const storage = new MemoryDispatchJournal();
  let fail = true;
  let claims = 0;
  const journal: DispatchJournal = {
    ...delegate(storage),
    checkpoint(cp) {
      if (preflight(cp) && fail) {
        fail = false;
        throw new Error('roles write');
      }
      storage.checkpoint(cp);
    },
    claim(id, intent, cp) {
      claims++;
      return storage.claim(id, intent, cp);
    },
  };
  const first = harness({}, { request: roleRequest(), journal });
  await assert.rejects(run(first), /roles write/);
  assert.equal(claims + first.dispatchCalls.length, 0);
  const next = harness({}, { request: roleRequest({ resume: true }), journal });
  const live = await run(next);
  assert.equal(roleCalls(next).length, 0);
  assert.equal(fact(live, 'preflight.reason'), 'unrecorded');
  assert.deepEqual(transitionDispatch(next.request, storage.load('d1').checkpoint!, live.receipt, live.entry), live);
  const outageStore = new MemoryDispatchJournal();
  const outage = harness({ route: { mode: 'outage' } }, { request: roleRequest(), journal: outageStore });
  assert.equal((await run(outage)).decide1.rule, 'hold.outage');
  assert.equal(roleCalls(outage).length, 0);
  const budget = harness(
    {},
    {
      request: roleRequest({ resume: true }),
      journal: outageStore,
      receipt: (intent) => ({ status: 'refused', dispatch_id: intent.dispatch_id, reason: 'budget' }),
    },
  );
  const paused = await run(budget);
  assert.equal(roleCalls(budget).length, 1);
  const resume = harness({}, { request: roleRequest({ resume: true }), journal: outageStore });
  const resumed = await run(resume);
  assert.equal(roleCalls(resume).length, 0);
  assert.deepEqual(preflight(resumed), preflight(paused));
  const cp = structuredClone(outageStore.load('d1').checkpoint!);
  const recovery = new MemoryDispatchJournal();
  recovery.checkpoint({ ...cp, intent: null });
  assert.equal(recovery.claim('d1', cp.intent!, cp), true);
  const unconfirmed = harness({}, { request: roleRequest(), journal: recovery });
  assert.equal((await run(unconfirmed)).reason, 'dispatch_unconfirmed');
  assert.equal(roleCalls(unconfirmed).length, 0);
});

test('P5a-14 cancellation and staleness during roles preserve the existing gates', async () => {
  for (const stale of [false, true]) {
    const gate = deferred();
    const controller = new AbortController();
    const sink = collector();
    let passedSignal: AbortSignal | undefined;
    const h = harness(
      {
        gate: { match: (id) => id.endsWith(':roles'), promise: gate.promise },
        onEvaluate(r, signal) {
          if (r.site === 'spawn.roles') passedSignal = signal;
        },
      },
      { request: roleRequest(), weft: sink.port },
    );
    const pending = run(h, controller.signal);
    await waitUntil(() => roleCalls(h).length === 1 || h.dispatchCalls.length > 0);
    assert.equal(roleCalls(h).length, 1);
    if (stale) h.clock.advance();
    else controller.abort();
    gate.release();
    const d = await pending;
    assert.equal(passedSignal, controller.signal);
    assert.equal(h.dispatchCalls.length, 0);
    if (stale) {
      assert.equal(preflight(d).reason, 'stale_answer');
      assert.equal(d.reason, 'stale_answer');
      assert.equal(d.decide1.rule, 'hold.admission');
    } else {
      assert.equal(d.reason, 'cancelled');
      assert.equal(h.journal.load('d1').decisions.length, 0);
      assert.deepEqual(sink.records, []);
      assert.equal((h.journal.load('d1').checkpoint!.asks as any).preflight, 1);
      assert.equal(preflight(h.journal.load('d1').checkpoint!), null);
      const resume = harness({}, { request: roleRequest({ resume: true }), journal: h.journal });
      assert.equal(fact(await run(resume), 'preflight.reason'), 'unrecorded');
      assert.equal(roleCalls(resume).length, 0);
    }
  }
});

test('P5a-15 tampered role records are dropped without changing dispatch', async () => {
  const h = harness({}, { request: roleRequest() });
  const live = await run(h);
  const cp = h.journal.load('d1').checkpoint!;
  assert.ok(preflight(cp));
  const mutations: ((r: any) => void)[] = [
    (r) => {
      r.schema = 'other';
    },
    (r) => {
      r.site = 'other';
    },
    (r) => {
      r.reason = 'other';
    },
    (r) => {
      r.targets = null;
    },
    (r) => {
      r.targets[0] = null;
    },
    (r) => {
      r.targets[0].confidence = -1;
    },
    (r) => {
      r.targets[0].role = 'other';
    },
    (r) => {
      r.request_id = 'foreign';
    },
    (r) => {
      r.state_revision++;
    },
    (r) => {
      r.question = 'CANARY-msg';
    },
    (r) => {
      r.reason = 'invalid_answer';
    },
    (r) => {
      r.extra = 'CANARY-provider';
    },
    (r) => {
      r.targets.reverse();
    },
    (r) => {
      r.targets.pop();
    },
    (r) => {
      r.targets[0].extra = 'CANARY-provider';
    },
    (r) => {
      r.targets[0].top_p = 2;
    },
    (r) => {
      r.provider_request_id = 'Bearer CANARY-provider';
    },
    (r) => {
      const keys = Object.keys(r).reverse();
      const copy = { ...r };
      for (const k of keys) delete r[k];
      for (const k of keys) r[k] = copy[k];
    },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(cp);
    mutate(preflight(bad));
    const d = transitionDispatch(h.request, bad, live.receipt);
    assert.equal(fact(d, 'preflight.reason'), 'untrusted');
    assert.equal(preflight(d), null);
    assert.deepEqual(dispatchProjection(d), dispatchProjection(live));
    assertNoCopiedText(d, [...CANARIES, 'CANARY-target']);
  }
  const changed = roleRequest({ targets: ROLE_TARGETS.map((t) => ({ ...t, ref: t.ref + 'changed' })) });
  const d = transitionDispatch(changed, cp, live.receipt);
  assert.equal(fact(d, 'preflight.reason'), 'untrusted');
});

test('P5a-16 versioned records, 32 facts, bounded judgments, Weft evidence, disclosure', async () => {
  const sink = collector();
  const request = roleRequest({
    intake: { message: 'CANARY-msg', running_threads: [] },
    triage_context: 'CANARY-ctx',
    route_context: 'CANARY-ctx',
  });
  const h = harness({}, { request, weft: sink.port });
  const d = await run(h);
  const cp = h.journal.load('d1').checkpoint!;
  assert.equal(d.schema, 'dispatch.decision@4');
  assert.equal(cp.schema, 'dispatch.checkpoint@3');
  assert.deepEqual(Object.keys(cp), [
    'schema',
    'decision_id',
    'state_revision',
    'state_updated_at',
    'asks',
    'intake',
    'triage',
    'route',
    'shadow',
    'preflight',
    'intent',
  ]);
  assert.deepEqual(Object.keys(cp.asks), ['intake', 'triage', 'route', 'shadow', 'preflight']);
  assert.deepEqual(Object.keys(d), [
    'schema',
    'decision_id',
    'entry',
    'state_revision',
    'decided_by',
    'choice',
    'status',
    'reason',
    'rule_table',
    'decide1',
    'intent',
    'receipt',
    'intake',
    'triage',
    'route',
    'shadow',
    'preflight',
  ]);
  const decided = sink.records.find((r) => r.kind === 'dispatch.decided')!;
  assert.equal((decided.fields.facts as any[]).length, 32);
  assert.ok((decided.fields.judgments as any[]).length <= 30);
  assert.ok(decided.evidence.some((e) => e.source === 'inference_request' && e.ref === 'd1:roles'));
  assert.ok(decided.links.every((l) => !l.record_id.includes(':roles')));
  assert.equal(sink.records.filter((r) => r.kind === 'judgment').length, 3);
  for (const r of sink.records) assert.equal(validateRecord(r).ok, true);
  assertNoCopiedText([d, h.journal.load('d1'), ...sink.records], [...CANARIES, 'CANARY-target']);
  assert.throws(
    () =>
      transitionDispatch(
        request,
        { ...cp, schema: 'dispatch.checkpoint@2' } as unknown as DispatchCheckpoint,
        d.receipt,
      ),
    /schema/,
  );
  const eightSink = collector();
  const eight = await run(
    harness(
      {},
      {
        request: roleRequest({
          targets: Array.from({ length: 8 }, (_, i) => ({ ref: `t${i}`, summary: 'CANARY-target' })),
        }),
        weft: eightSink.port,
      },
    ),
  );
  assert.equal(eight.decide1.judgments.length, 30);
  assert.equal(fact(eight, 'spawn.children'), 9);
  assert.deepEqual(
    eight.decide1.facts.map((f) => f.name),
    FACT_NAMES,
  );
  assert.deepEqual(
    eight.decide1.judgments.slice(14).map((j) => j.name),
    Array.from({ length: 8 }, (_, i) => [`preflight.t${i}.top_p`, `preflight.t${i}.confidence`]).flat(),
  );
  for (const record of eightSink.records) assert.equal(validateRecord(record).ok, true);
  const badJournal: DispatchJournal = {
    ...delegate(h.journal),
    load: () => ({
      checkpoint: cp,
      decisions: [{ ...d, schema: 'dispatch.decision@3' } as unknown as DispatchDecision],
      attempt: null,
      presented: false,
    }),
  };
  await assert.rejects(run(harness({}, { request, journal: badJournal })), /schema/);
});

test('P5a-17 validate closed targets before journal or ports; capture mutable caller', async () => {
  for (const targets of [
    Array(9).fill(ROLE_TARGETS[0]),
    [ROLE_TARGETS[0], ROLE_TARGETS[0]],
    [{ ref: 'Bearer secret', summary: '' }],
    [{ ...ROLE_TARGETS[0], extra: true }],
    [{ ref: 'a', summary: 3 }],
    null,
    {},
    [null],
    Array(1),
  ]) {
    let loads = 0;
    const storage = new MemoryDispatchJournal();
    const journal: DispatchJournal = {
      ...delegate(storage),
      load(id) {
        loads++;
        return storage.load(id);
      },
    };
    const h = harness({}, { request: roleRequest({ targets }), journal });
    await assert.rejects(run(h), /Invalid dispatch targets/);
    assert.equal(loads + h.generateCalls.length + h.evaluateCalls.length + h.dispatchCalls.length, 0);
  }
  const gate = deferred();
  const request = roleRequest();
  const h = harness({ gate: { match: (id) => id === 'd1:intake', promise: gate.promise } }, { request });
  const pending = run(h);
  await waitUntil(() => h.generateCalls.length > 0);
  (request as any).targets[0].ref = 'changed';
  (request as any).targets[0].summary = 'changed';
  (request as any).targets.push({ ref: 'extra', summary: '' });
  gate.release();
  const d = await pending;
  assert.deepEqual(
    preflight(d).targets.map((t: any) => t.ref),
    ROLE_TARGETS.map((t) => t.ref),
  );
  assert.deepEqual((roleCalls(h)[0]!.state as any).targets, ROLE_TARGETS);
});

test('P5a-18 out-of-order roles bind snapshots and sequences; same id has one claim winner', async () => {
  const sink = collector();
  const gate = deferred();
  const a = harness(
    {
      roles: ['edit', 'read', 'forbid', 'skip'],
      gate: { match: (id) => id.endsWith(':roles'), promise: gate.promise },
    },
    { request: roleRequest(), weft: sink.port },
  );
  const pa = run(a);
  await waitUntil(() => roleCalls(a).length === 1 || a.dispatchCalls.length > 0);
  assert.equal(roleCalls(a).length, 1);
  const b = harness(
    { roles: ['skip', 'skip', 'skip', 'skip'] },
    { request: roleRequest({ request_id: 'b' }), weft: sink.port },
  );
  const db = await run(b);
  gate.release();
  const da = await pa;
  assert.equal(fact(da, 'spawn.gain'), true);
  assert.equal(fact(db, 'spawn.gain'), false);
  const sequences = sink.records.map((r) => r.sequence);
  assert.deepEqual(
    sequences,
    [...new Set(sequences)].sort((x, y) => x - y),
  );
  const storage = new MemoryDispatchJournal();
  const same = deferred();
  const intake = deferred();
  const sameSink = collector();
  const y = harness(
    { roles: ['skip', 'skip', 'skip', 'skip'], gate: { match: (id) => id === 'd1:intake', promise: intake.promise } },
    { request: roleRequest(), journal: storage, weft: sameSink.port },
  );
  const py = run(y);
  await waitUntil(() => y.evaluateCalls.length === 1);
  const x = harness(
    { gate: { match: (id) => id.endsWith(':roles'), promise: same.promise } },
    { request: roleRequest(), journal: storage, weft: sameSink.port },
  );
  const px = run(x);
  await waitUntil(() => roleCalls(x).length === 1);
  intake.release();
  const dy = await py;
  same.release();
  const dx = await px;
  assert.equal(x.dispatchCalls.length + y.dispatchCalls.length, 1);
  assert.equal(roleCalls(x).length, 1);
  assert.equal(roleCalls(y).length, 1);
  assert.equal(storage.load('d1').decisions.length, 1);
  assert.deepEqual(dx, dy);
  assert.equal(fact(dy, 'spawn.gain'), false);
  const emitted = sameSink.records.filter((r) => r.kind === 'dispatch.decided');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.fields['dispatch_ref'], 'd1:dispatch');
  assert.equal((emitted[0]!.fields['facts'] as any[]).find((f) => f.name === 'spawn.gain').value, false);
});
