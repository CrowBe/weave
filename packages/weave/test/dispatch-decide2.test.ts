/** WV-S1 P4c: Decide-2 picks one disclosed catalogue entry, extracts only its args, and retires D3. */
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
  dispatchDecided,
  transitionDispatch,
  type DispatchCheckpoint,
  type DispatchDecision,
  type DispatchIntent,
  type DispatchPorts,
  type DispatchRequest,
} from '../src/dispatch.js';
import { digest } from '../src/digest.js';
import { stableStringify } from '../src/stable-json.js';
import {
  DECIDE2_POLICY,
  decide2Pick,
  plausibleTop,
  transitionDecide2,
  type CatalogueEntry,
  type Decide2Observation,
} from '../src/sites/decide2.js';
import { assertRecordCopiesNoText } from './record-canary.js';

const MESSAGE = 'rename the file notes.txt to todo.txt';
const CONTEXT = 'CANARY-ctx';
const REVISION = { state_revision: 1, state_updated_at: 10 };
const terms: InferenceTerms = {
  quality: 'baseline',
  destinations: ['local'],
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const CATALOGUE: readonly CatalogueEntry[] = [
  {
    ref: 'fs.rename',
    purpose: 'CANARY-purpose rename a file',
    reversible: true,
    args: [
      { name: 'from', required: true },
      { name: 'to', required: true },
    ],
  },
  {
    ref: 'fs.delete',
    purpose: 'CANARY-purpose delete a file',
    reversible: false,
    args: [{ name: 'path', required: true }],
  },
  { ref: 'clock.now', purpose: 'CANARY-purpose read the time', reversible: true, args: [] },
];

type Mode = 'ok' | 'outage' | 'no_answer' | 'partial' | 'stale';
interface Plan {
  /** p(relevant) per catalogue entry, in order. */
  readonly p?: readonly number[];
  readonly confidence?: number | null;
  readonly mode?: Mode;
  /** Args extract answer per arg name; null leaves it ungrounded. */
  readonly args?: Readonly<Record<string, string | null>>;
  readonly argsMode?: 'ok' | 'outage';
}

function observation(p: readonly (number | null)[], confidence: number | null = 1): Decide2Observation {
  return {
    schema: 'decide2-pick@1',
    site: 'decide2.pick',
    question: 'q',
    request_id: 'd1:tool:decide2',
    state_revision: 1,
    entries: p.map((value, i) => ({ ref: `e${i}`, p: value, confidence: value === null ? null : confidence })),
    reason: p.some((value) => value === null) ? 'invalid_answer' : 'answered',
    provider_request_id: null,
  };
}

test('P4c-2 the margin rule: absolute floor, runner-up ceiling, margin and confidence, compared exactly', () => {
  assert.deepEqual(DECIDE2_POLICY, {
    confidence: 0.75,
    min_top: 0.7,
    min_margin: 0.3,
    max_runner_up: 0.4,
    entries: 8,
    args: 8,
  });
  assert.ok(Object.isFrozen(DECIDE2_POLICY));
  // The IEEE edge: .7 - .4 is a .3 margin as written.
  assert.deepEqual(decide2Pick(observation([0.7, 0.4])), { top: 0, pick: 0, margin: 0.3 });
  assert.equal(decide2Pick(observation([0.9, 0.41])).pick, null, 'runner-up above the ceiling');
  assert.equal(decide2Pick(observation([0.69, 0.1])).pick, null, 'below the absolute floor');
  // A lone weak entry is not a pick, though its margin over nothing is large.
  assert.equal(decide2Pick(observation([0.3])).pick, null);
  assert.deepEqual(decide2Pick(observation([0.95])), { top: 0, pick: 0, margin: 0.95 });
  assert.equal(decide2Pick(observation([0.9, 0.1], 0.74)).pick, null, 'low confidence');
  assert.equal(decide2Pick(observation([0.9, 0.1], null)).pick, null, 'a missing confidence is no margin');
  // Ties resolve to the lowest ordinal, and a tie never clears.
  assert.deepEqual(decide2Pick(observation([0.8, 0.8])), { top: 0, pick: null, margin: 0 });
  assert.deepEqual(decide2Pick(observation([0.1, 0.9, 0.2])), { top: 1, pick: 1, margin: 0.7 });
  // No top is ever computed from a partial answer.
  assert.deepEqual(decide2Pick(observation([0.9, null])), { top: null, pick: null, margin: null });
  assert.equal(plausibleTop(observation([0.41, 0.4]), 0), true);
  assert.equal(plausibleTop(observation([0.4, 0.1]), 0), false);
  assert.equal(plausibleTop(observation([0.9]), null), false);
});

test('P4c-3 a partial or malformed answer is invalid_answer for the whole observation', () => {
  const ask = {
    request_id: 'd1:tool',
    ...REVISION,
    state: { request: MESSAGE, context: CONTEXT },
    catalogue: CATALOGUE,
    intent: null,
    terms,
  };
  const outcome = (answers: Record<string, unknown>) =>
    ({
      status: 'accepted',
      kind: 'boolean',
      request_id: 'd1:tool:decide2',
      site: 'decide2.pick',
      answers,
      confidence: {},
      routed_unit_id: 'u',
      attempts: [],
      spent: 0,
      uncertainty: [],
    }) as unknown as EvaluationOutcome<'boolean'>;
  const recorded = (answers: Record<string, unknown>) => ({ ...REVISION, observed_at: 10, outcome: outcome(answers) });
  const good = { type: 'boolean', probability: 0.5 };
  for (const answers of [
    { entry_0: good, entry_1: good },
    { entry_0: good, entry_1: good, entry_2: { type: 'boolean', probability: 2 } },
    { entry_0: good, entry_1: good, entry_2: { type: 'choice', choice: 'x' } },
  ]) {
    const observed = transitionDecide2(ask, recorded(answers), REVISION);
    assert.equal(observed.reason, 'invalid_answer');
    assert.ok(observed.entries.every((entry) => entry.p === null && entry.confidence === null));
  }
  const answered = transitionDecide2(ask, recorded({ entry_0: good, entry_1: good, entry_2: good }), REVISION);
  assert.equal(answered.reason, 'answered');
  assert.deepEqual(
    answered.entries.map((entry) => entry.ref),
    CATALOGUE.map((entry) => entry.ref),
  );
  // Purposes and request text never reach the record.
  assertRecordCopiesNoText(answered, ['CANARY-purpose', 'CANARY-ctx', MESSAGE]);
});

function accepted<T>(request: { request_id: string; site: string }, body: T) {
  return {
    status: 'accepted',
    request_id: request.request_id,
    site: request.site,
    routed_unit_id: 'fake',
    provider_response_id: 'provider-1',
    attempts: [],
    spent: 0,
    uncertainty: [],
    ...body,
  };
}

function harness(plan: Plan = {}, request: Partial<DispatchRequest> = {}) {
  const clock = { ...REVISION };
  const now = () => ({ ...clock, observed_at: clock.state_updated_at });
  const evaluateCalls: EvaluationRequest[] = [];
  const generateCalls: GenerationRequest[] = [];
  const dispatchCalls: DispatchIntent[] = [];
  const gateway = {
    async generate(req: GenerationRequest): Promise<GenerationOutcome> {
      generateCalls.push(req);
      const payload =
        req.site === 'intake.extract'
          ? { thread_ref: { value: null, cue: null }, request: { value: null } }
          : req.site === 'decide2.args.extract'
            ? Object.fromEntries(
                // Answer exactly the slots the targeted prompt names.
                (JSON.parse((req.input as { prompt: string }).prompt).tool.args as string[]).map((name) => [
                  name,
                  { value: { from: 'notes.txt', to: 'todo.txt', path: 'notes.txt', ...plan.args }[name] ?? null },
                ]),
              )
            : { intent: { value: MESSAGE } };
      if (req.site === 'decide2.args.extract' && plan.argsMode === 'outage') throw new Error('CANARY-error');
      return accepted(req, { text: JSON.stringify(payload) }) as unknown as GenerationOutcome;
    },
    async evaluate(req: EvaluationRequest): Promise<EvaluationOutcome> {
      evaluateCalls.push(req);
      if (req.site === 'decide2.pick') {
        const mode = plan.mode ?? 'ok';
        if (mode === 'outage') throw new Error('CANARY-error');
        if (mode === 'stale') {
          clock.state_revision += 1;
          clock.state_updated_at += 10;
        }
        if (mode === 'no_answer')
          return {
            status: 'blocked',
            reason: 'policy_denied',
            request_id: req.request_id,
            site: req.site,
            attempts: [],
            spent: 0,
            uncertainty: [],
          } as unknown as EvaluationOutcome;
        const keys = Object.keys(req.questions);
        const p = plan.p ?? [0.95, 0.1, 0.05];
        const confidence = plan.confidence === undefined ? 1 : plan.confidence;
        return accepted(req, {
          kind: 'boolean',
          answers: Object.fromEntries(
            keys
              .filter((_, i) => mode !== 'partial' || i > 0)
              .map((key, i) => [key, { type: 'boolean', probability: p[keys.indexOf(key)] ?? p[i] }]),
          ),
          confidence: confidence === null ? {} : Object.fromEntries(keys.map((key) => [key, confidence])),
        }) as unknown as EvaluationOutcome;
      }
      if (req.site.startsWith('decide1.'))
        return accepted(req, {
          kind: 'boolean',
          answers: { decision: { type: 'boolean', probability: 0 } },
          confidence: { decision: 1 },
        }) as unknown as EvaluationOutcome;
      const choice =
        req.site === 'intake.classify' ? 'new_thread' : req.site === 'loop.triage' ? 'capability' : 'flash';
      return accepted(req, {
        kind: 'choice',
        answers: { decision: { type: 'choice', choice, probabilities: { [choice]: 1 } } },
        confidence: { decision: 1 },
      }) as unknown as EvaluationOutcome;
    },
  } as unknown as Pick<InferenceGateway, 'generate' | 'evaluate'>;
  const ports: DispatchPorts = {
    generate: gateway.generate,
    evaluate: gateway.evaluate,
    now,
    dispatch: async (intent) => {
      dispatchCalls.push(structuredClone(intent));
      return { status: 'dispatched', dispatch_id: intent.dispatch_id, ref: `action:${intent.kind}` };
    },
  };
  const full: DispatchRequest = {
    request_id: 'd1',
    ...REVISION,
    terms,
    intake: { message: MESSAGE, running_threads: [] },
    triage_context: CONTEXT,
    route_context: 'route ctx',
    catalogue: CATALOGUE,
    ...request,
  };
  const journal = new MemoryDispatchJournal();
  return {
    clock,
    ports,
    journal,
    request: full,
    evaluateCalls,
    generateCalls,
    dispatchCalls,
    run: (resume = false) => decideDispatch(resume ? { ...full, resume: true } : full, ports, journal),
  };
}

function fact(decision: DispatchDecision, name: string) {
  return decision.decide1.facts.find((item) => item.name === name)?.value;
}
function replay(h: ReturnType<typeof harness>, decision: DispatchDecision, request = h.request) {
  const checkpoint = h.journal.load('d1').checkpoint as DispatchCheckpoint;
  return transitionDispatch(request, checkpoint, decision.receipt, decision.entry);
}

test('P4c-4 a clear reversible pick extracts only its args and dispatches one capability intent', async () => {
  const h = harness();
  const decision = await h.run();
  assert.equal(decision.decide1.rule, 'act.tool');
  assert.equal(decision.decide1.band, 'tool_call');
  assert.equal(decision.status, 'dispatched');
  assert.equal(decision.decided_by, 'rule');
  const pick = h.evaluateCalls.filter((call) => call.site === 'decide2.pick');
  assert.equal(pick.length, 1);
  assert.equal(pick[0]!.kind, 'boolean');
  assert.equal(pick[0]!.terms.tier, 'decision');
  assert.deepEqual(Object.keys(pick[0]!.questions), ['entry_0', 'entry_1', 'entry_2']);
  // The targeted extract asks for exactly the picked entry's args.
  const args = h.generateCalls.filter((call) => call.site === 'decide2.args.extract');
  assert.equal(args.length, 1);
  assert.match(JSON.stringify(args[0]!.input), /from/);
  assert.doesNotMatch(JSON.stringify(args[0]!.input), /"path"/);
  const final = decision.tool!.extracts.at(-1)!;
  const original = stableStringify({ request: MESSAGE, context: CONTEXT });
  assert.deepEqual(h.dispatchCalls, [
    {
      kind: 'capability',
      dispatch_id: 'd1:dispatch',
      entry_ref: 'fs.rename',
      catalogue_digest: digest(CATALOGUE),
      args_ref: digest({ original: digest(original), extract: final }),
    },
  ]);
  assert.deepEqual(
    final.slots.map((slot) => [slot.slot, slot.status]),
    [
      ['from', 'grounded'],
      ['to', 'grounded'],
    ],
  );
  assert.equal(fact(decision, 'decide2.pick'), 'fs.rename');
  assert.equal(fact(decision, 'args.missing'), 0);
  assert.equal(decision.decide1.judgments.find((judgment) => judgment.name === 'decide2.e0.p')?.probability, 0.95);
  assert.deepEqual(replay(h, decision), decision);
  // Records copy no purpose, context or provider error text.
  assertRecordCopiesNoText(decision, ['CANARY-purpose', 'CANARY-ctx', 'CANARY-error']);
  const record = dispatchDecided(decision, [], { trace_id: 'trace-1', emitter_id: 'loom.dispatch' }, 1)!;
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.equal(record.fields['rule'], 'act.tool');
});

test('P4c-5 a zero-arg pick has no extract and a null args_ref; an irreversible clear pick still dispatches', async () => {
  const zero = harness({ p: [0.1, 0.05, 0.9] });
  const decision = await zero.run();
  assert.equal(decision.decide1.rule, 'act.tool');
  assert.equal(zero.generateCalls.filter((call) => call.site === 'decide2.args.extract').length, 0);
  assert.equal((decision.intent as Extract<DispatchIntent, { kind: 'capability' }>).args_ref, null);
  assert.equal((decision.intent as Extract<DispatchIntent, { kind: 'capability' }>).entry_ref, 'clock.now');
  // High confidence on irreversible work does not ask (D-ENG-030); the grant's approval path still applies.
  const irreversible = harness({ p: [0.1, 0.95, 0.1] });
  const deleted = await irreversible.run();
  assert.equal(deleted.decide1.rule, 'act.tool');
  assert.equal((deleted.intent as Extract<DispatchIntent, { kind: 'capability' }>).entry_ref, 'fs.delete');
});

test('P4c-6 Open question 2: no margin on reversible work escalates to generation over the full index', async () => {
  for (const plan of [
    { p: [0.6, 0.55, 0.1] },
    { p: [0.95, 0.1, 0.05], confidence: 0.5 },
    { p: [0.95, 0.1, 0.05], confidence: null },
    { mode: 'no_answer' as const },
    { mode: 'partial' as const },
    // An implausible irreversible top is not ambiguity the operator must resolve.
    { p: [0.1, 0.3, 0.05] },
  ]) {
    const h = harness(plan);
    const decision = await h.run();
    const label = JSON.stringify(plan);
    assert.equal(decision.decide1.rule, 'gen.no_tool_margin', label);
    assert.equal(decision.decide1.band, 'escalate_gen', label);
    assert.equal(decision.reason, 'no_tool_margin', label);
    assert.deepEqual(
      h.dispatchCalls,
      [
        {
          kind: 'implement',
          dispatch_id: 'd1:dispatch',
          tier: 'standard',
          ceiling: 'standard',
          tier_source: 'no_tool_margin',
          catalogue_digest: digest(CATALOGUE),
        },
      ],
      label,
    );
    // No args are extracted without a pick, and no route (D2) question is asked.
    assert.equal(h.generateCalls.filter((call) => call.site === 'decide2.args.extract').length, 0, label);
    assert.equal(h.evaluateCalls.filter((call) => call.site === 'loop.route').length, 0, label);
    assert.deepEqual(replay(h, decision), decision, label);
  }
});

test('P4c-7 a plausible irreversible top without margin asks; a missing required arg asks', async () => {
  const h = harness({ p: [0.3, 0.6, 0.1] });
  const decision = await h.run();
  assert.equal(decision.decide1.rule, 'ask.tool_irreversible');
  assert.equal(decision.status, 'needs_human');
  assert.equal(decision.reason, 'irreversible');
  assert.equal(fact(decision, 'decide2.top'), 'fs.delete');
  assert.equal(h.dispatchCalls.length, 0);
  assert.deepEqual(replay(h, decision), decision);

  const args = harness({ args: { from: 'notes.txt', to: null } });
  const missing = await args.run();
  assert.equal(missing.decide1.rule, 'ask.tool_args');
  assert.equal(missing.status, 'needs_human');
  assert.equal(missing.reason, 'missing_args');
  assert.equal(fact(missing, 'args.missing'), 1);
  assert.equal(args.dispatchCalls.length, 0);
  // An ungrounded value (not in the original) is not an arg either; the second attempt runs once.
  const invented = harness({ args: { from: 'notes.txt', to: 'secret.txt' } });
  const ungrounded = await invented.run();
  assert.equal(ungrounded.decide1.rule, 'ask.tool_args');
  assert.equal(invented.generateCalls.filter((call) => call.site === 'decide2.args.extract').length, 2);
  assert.deepEqual(replay(invented, ungrounded), ungrounded);
});

test('P4c-8 Decide-2 and args outages hold and resume; a stale pick is a terminal admission hold', async () => {
  const h = harness({ mode: 'outage' });
  const paused = await h.run();
  assert.equal(paused.decide1.rule, 'hold.outage');
  assert.equal(paused.decide1.band, 'tool_call');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.reason, 'decision_unavailable');
  assert.equal(paused.choice, 'capability');
  assert.equal(h.dispatchCalls.length, 0);
  // A resume re-asks only the tool stage, never intake or triage.
  const before = h.evaluateCalls.filter((call) => call.site !== 'decide2.pick').length;
  const resumed = await decideDispatch(
    { ...h.request, resume: true },
    { ...h.ports, evaluate: harness().ports.evaluate },
    h.journal,
  );
  assert.equal(resumed.decide1.rule, 'act.tool');
  assert.equal(resumed.entry, 2);
  assert.equal(h.journal.load('d1').checkpoint!.asks.tool, 2);
  assert.equal(h.evaluateCalls.filter((call) => call.site !== 'decide2.pick').length, before);

  const args = harness({ argsMode: 'outage' });
  const held = await args.run();
  assert.equal(held.decide1.rule, 'hold.outage');
  assert.equal(fact(held, 'tool.reason'), 'decision_unavailable');

  const stale = harness({ mode: 'stale' });
  const admitted = await stale.run();
  assert.equal(admitted.status, 'paused');
  assert.equal(admitted.reason, 'stale_answer');
  assert.equal(stale.dispatchCalls.length, 0);
});

test('P4c-9 replay refuses catalogue drift, a tampered pick and args attached without a pick', async () => {
  const h = harness();
  const decision = await h.run();
  const checkpoint = h.journal.load('d1').checkpoint as DispatchCheckpoint;
  assert.equal(checkpoint.catalogue_digest, digest(CATALOGUE));
  for (const catalogue of [
    [...CATALOGUE].reverse(),
    CATALOGUE.map((entry, i) => (i === 0 ? { ...entry, reversible: false } : entry)),
    CATALOGUE.slice(0, 2),
  ])
    assert.throws(
      () => transitionDispatch({ ...h.request, catalogue }, checkpoint, decision.receipt, decision.entry),
      /catalogue differs/,
    );
  const tool = checkpoint.tool!;
  const tampered = (patch: Partial<NonNullable<DispatchCheckpoint['tool']>>) =>
    ({ ...checkpoint, tool: { ...tool, ...patch } }) as DispatchCheckpoint;
  const lowered = {
    ...tool.pick,
    entries: tool.pick.entries.map((entry, i) => (i === 0 ? { ...entry, p: 0.2 } : entry)),
  };
  // A lowered p re-derives (it is a valid answer) but no longer matches the claimed capability intent.
  assert.throws(() => transitionDispatch(h.request, tampered({ pick: lowered }), decision.receipt, decision.entry));
  assert.throws(
    () =>
      transitionDispatch(
        h.request,
        tampered({
          pick: { ...tool.pick, reason: 'answered', entries: tool.pick.entries.map((e) => ({ ...e, p: 7 })) },
        }),
        decision.receipt,
        decision.entry,
      ),
    /not the live outcome/,
  );
  // Args extracted for a pick that never cleared cannot ride on a no-margin record.
  const g = harness({ p: [0.6, 0.55, 0.1] });
  const gen = await g.run();
  const genCheckpoint = g.journal.load('d1').checkpoint as DispatchCheckpoint;
  assert.throws(
    () =>
      transitionDispatch(
        g.request,
        { ...genCheckpoint, tool: { ...genCheckpoint.tool!, extracts: tool.extracts } },
        gen.receipt,
        gen.entry,
      ),
    /not the live outcome/,
  );
});

test('P4c-10 the catalogue shape is closed and bounded; a child carries none', async () => {
  const entry = CATALOGUE[0]!;
  for (const catalogue of [
    Array.from({ length: 9 }, (_, i) => ({ ...entry, ref: `op${i}` })),
    [entry, entry],
    [{ ...entry, ref: 'bad ref' }],
    [{ ...entry, reversible: 'yes' }],
    [
      {
        ...entry,
        args: [
          { name: 'a', required: true },
          { name: 'a', required: false },
        ],
      },
    ],
    [{ ...entry, args: Array.from({ length: 9 }, (_, i) => ({ name: `a${i}`, required: true })) }],
    [{ ...entry, extra: 1 }],
  ]) {
    const h = harness({}, { catalogue: catalogue as unknown as CatalogueEntry[] });
    await assert.rejects(h.run(), /Invalid dispatch catalogue/);
    assert.equal(h.evaluateCalls.length, 0);
  }
  // An empty catalogue asks no Decide-2 question and has no tool margin.
  const empty = harness({}, { catalogue: [] });
  const decision = await empty.run();
  assert.equal(decision.decide1.rule, 'gen.no_tool_margin');
  assert.equal(empty.evaluateCalls.filter((call) => call.site === 'decide2.pick').length, 0);
  assert.equal(decision.tool, null);
});
