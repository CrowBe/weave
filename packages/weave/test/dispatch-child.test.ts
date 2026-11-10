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
  decide1Inputs,
  decideDispatch,
  transitionDispatch,
  type ChildEvidence,
  type DispatchCheckpoint,
  type DispatchChild,
  type DispatchDecision,
  type DispatchIntent,
  type DispatchJournal,
  type DispatchPorts,
  type DispatchReceipt,
  type DispatchRequest,
  type DispatchSettlementPort,
  type SpawnIntent,
  type SpawnPort,
} from '../src/dispatch.js';
import * as dispatchModule from '../src/dispatch.js';
import { DECIDE1_RULE_TABLE, DECIDE1_RULES, decideBand, type Decide1Fact } from '../src/decide1.js';
import { childRef, sealFrame, type ChildBrief } from '../src/spawn.js';
import { decideLoopRoute, type LoopDecisionAsk } from '../src/sites/loop-decide.js';
import { SITE_POLICY } from '../src/sites/index.js';
import { digest } from '../src/digest.js';
import type { WeftPort, WeftRecordShape } from '../src/weft.js';
import { assertNoCopiedText } from './record-canary.js';

// WV-S1 P5c1: verified child re-entry, read join and D2 tier. Fixtures are fake ports only.

// Bound at use, so one missing export fails its own test rather than the whole module link.
const { verifyChild } = dispatchModule;
const MESSAGE = 'fix the parser';
const REVISION = { state_revision: 1, state_updated_at: 10 };
const PARENT_TERMS: InferenceTerms = {
  audit: false,
  quality: 'high',
  destinations: ['local', 'remote'],
  content_class: 'sensitive',
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 2,
  max_attempts_per_route: 1,
  prefix_digest: 'parent-prefix',
  prefix_cache: { routed_unit_id: 'unit.parent', prefix_digest: 'parent-prefix', cached_tokens: 5 },
};
const TARGETS = ['target0', 'target1', 'target2', 'target3'];
const MIXED4 = ['edit', 'read', 'forbid', 'skip'];
const EDIT4 = ['edit', 'edit', 'edit', 'edit'];
const CANARIES = ['CANARY-summary', 'CANARY-ctx', 'CANARY-provider', 'CANARY-error', 'CANARY-body'];
const TIER_ORDER = ['flash', 'standard', 'strong'];

type ChildMode = 'ok' | 'stale' | 'mismatch' | 'outage' | 'no_answer';
interface Fake {
  readonly roles?: readonly string[];
  readonly rootRoute?: string;
  readonly child?: {
    readonly choice?: string;
    readonly confidence?: number | null;
    readonly mode?: ChildMode;
    readonly extract?: 'ok' | 'garbage';
  };
  readonly gate?: { readonly match: (id: string) => boolean; readonly promise: Promise<void> };
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

function generation(request: GenerationRequest, text: string): GenerationOutcome {
  return {
    status: 'accepted',
    text,
    request_id: request.request_id,
    site: request.site,
    routed_unit_id: 'extract.fake',
    provider_response_id: 'provider-1',
    attempts: [],
    spent: 0,
    uncertainty: [],
  } as GenerationOutcome;
}

function choice(
  request: EvaluationRequest<'choice'>,
  answer: string,
  confidence: number | null,
  mode: ChildMode,
  clock: Clock,
): EvaluationOutcome<'choice'> {
  if (mode === 'outage') throw new Error('CANARY-error');
  if (mode === 'stale') clock.advance();
  if (mode === 'no_answer')
    return {
      status: 'blocked',
      reason: 'policy_denied',
      request_id: request.request_id,
      site: request.site,
      attempts: [],
      spent: 0,
      uncertainty: [],
    } as unknown as EvaluationOutcome<'choice'>;
  return {
    status: 'accepted',
    kind: 'choice',
    request_id: mode === 'mismatch' ? 'other-request' : request.request_id,
    site: request.site,
    answers: { decision: { type: 'choice', choice: answer, probabilities: { [answer]: 1 } } },
    confidence: confidence === null ? undefined : { decision: confidence },
    routed_unit_id: 'site.fake',
    provider_response_id: 'provider-site',
    attempts: [],
    spent: 0,
    uncertainty: [],
  } as unknown as EvaluationOutcome<'choice'>;
}

const isRoot = (id: string) => id.startsWith('d1') || id.startsWith('d2');

function makeGateway(fake: Fake, clock: Clock) {
  const generateCalls: GenerationRequest[] = [];
  const evaluateCalls: EvaluationRequest<'choice'>[] = [];
  const gateway = {
    async generate(request: GenerationRequest): Promise<GenerationOutcome> {
      // The acceptance check is a function: record only the request's data.
      const { accept: _accept, ...data } = request;
      generateCalls.push(structuredClone(data) as GenerationRequest);
      if (fake.gate?.match(request.request_id)) await fake.gate.promise;
      if (request.site === 'intake.extract')
        return generation(
          request,
          JSON.stringify({ thread_ref: { value: null, cue: null }, request: { value: null } }),
        );
      if (!isRoot(request.request_id) && fake.child?.extract === 'garbage') return generation(request, 'not json');
      return generation(request, JSON.stringify({ intent: { value: MESSAGE } }));
    },
    async evaluate(request: EvaluationRequest<'choice'>): Promise<EvaluationOutcome<'choice'>> {
      evaluateCalls.push(structuredClone(request));
      if (fake.gate?.match(request.request_id)) await fake.gate.promise;
      if (request.site.startsWith('decide1.'))
        return {
          status: 'accepted',
          kind: 'boolean',
          request_id: request.request_id,
          site: request.site,
          answers: { decision: { type: 'boolean', probability: 1 } },
          confidence: { decision: 1 },
          routed_unit_id: 'shadow.fake',
          provider_response_id: 'shadow-provider',
          attempts: [],
          spent: 0,
          uncertainty: [],
        } as unknown as EvaluationOutcome<'choice'>;
      if (request.site === 'spawn.roles') {
        const roles = fake.roles ?? MIXED4;
        const keys = Object.keys(request.questions);
        return {
          status: 'accepted',
          kind: 'choice',
          request_id: request.request_id,
          site: request.site,
          answers: Object.fromEntries(
            keys.map((key, i) => [key, { type: 'choice', choice: roles[i], probabilities: { [roles[i]!]: 1 } }]),
          ),
          confidence: Object.fromEntries(keys.map((key) => [key, 1])),
          routed_unit_id: 'fixture',
          provider_response_id: 'roles-provider',
          attempts: [],
          spent: 0,
          uncertainty: [],
        } as unknown as EvaluationOutcome<'choice'>;
      }
      switch (request.site) {
        case 'intake.classify':
          return choice(request, 'new_thread', 1, 'ok', clock);
        case 'loop.triage':
          return choice(request, 'implement', 1, 'ok', clock);
        case 'loop.route':
          if (isRoot(request.request_id)) return choice(request, fake.rootRoute ?? 'flash', 1, 'ok', clock);
          return choice(
            request,
            fake.child?.choice ?? 'flash',
            fake.child?.confidence === undefined ? 1 : fake.child.confidence,
            fake.child?.mode ?? 'ok',
            clock,
          );
        default:
          throw new Error(`unexpected site ${request.site}`);
      }
    },
  } as unknown as Pick<InferenceGateway, 'generate' | 'evaluate'>;
  return { gateway, generateCalls, evaluateCalls };
}

function completedRead(intent: DispatchIntent, bytes = 64): unknown {
  const target = (intent as unknown as { target_ref: string }).target_ref;
  return {
    status: 'dispatched',
    dispatch_id: intent.dispatch_id,
    ref: `read.${target}`,
    read: { target_ref: target, revision: `rev.${target}`, digest: digest({ body: target }), bytes },
  };
}
function defaultReceipt(intent: DispatchIntent): unknown {
  return intent.kind === 'read'
    ? completedRead(intent)
    : { status: 'dispatched', dispatch_id: intent.dispatch_id, ref: `action.${intent.kind}` };
}
const confirmingSpawn: SpawnPort = (intent) => ({
  status: 'dispatched',
  dispatch_id: intent.dispatch_id,
  ref: intent.plan.digest,
});

function harness(
  fake: Fake = {},
  options: {
    readonly journal?: DispatchJournal;
    readonly clock?: Clock;
    readonly weft?: WeftPort;
    readonly spawn?: SpawnPort;
    readonly settlement?: DispatchSettlementPort;
    readonly dispatch?: (intent: DispatchIntent, signal?: AbortSignal) => unknown;
  } = {},
) {
  const clock = options.clock ?? makeClock();
  const journal = options.journal ?? new MemoryDispatchJournal();
  const g = makeGateway(fake, clock);
  const dispatchCalls: DispatchIntent[] = [];
  const spawnCalls: SpawnIntent[] = [];
  const events: string[] = [];
  const ports: DispatchPorts = {
    generate: g.gateway.generate,
    evaluate: g.gateway.evaluate,
    now: clock.now,
    dispatch: async (intent, signal) => {
      dispatchCalls.push(structuredClone(intent));
      events.push(`dispatch:${intent.kind}:${intent.dispatch_id}`);
      return (options.dispatch ?? defaultReceipt)(intent, signal) as DispatchReceipt;
    },
    ...(options.settlement === undefined ? {} : { settlement: options.settlement }),
    ...(options.weft === undefined ? {} : { weft: options.weft }),
    ...(options.spawn === undefined
      ? {}
      : {
          spawn: (intent: SpawnIntent, signal?: AbortSignal) => {
            spawnCalls.push(structuredClone(intent));
            events.push(`spawn:${intent.dispatch_id}`);
            return options.spawn!(intent, signal);
          },
        }),
  };
  const effects = () => g.evaluateCalls.length + g.generateCalls.length + dispatchCalls.length + spawnCalls.length;
  return { clock, journal, ports, dispatchCalls, spawnCalls, events, effects, ...g };
}
type Harness = ReturnType<typeof harness>;

function rootRequest(terms: InferenceTerms = PARENT_TERMS, id = 'd1'): DispatchRequest {
  return {
    request_id: id,
    ...REVISION,
    terms: structuredClone(terms) as InferenceTerms,
    intake: { message: MESSAGE, running_threads: [] },
    triage_context: 'CANARY-ctx triage',
    route_context: 'CANARY-ctx route',
    targets: TARGETS.map((ref) => ({ ref, summary: 'CANARY-summary' })),
  };
}

function childTerms(brief: ChildBrief, patch: Record<string, unknown> = {}): InferenceTerms {
  const { prefix_digest: _d, prefix_cache: _c, ...rest } = structuredClone(PARENT_TERMS);
  return { ...rest, cost_ceiling: brief.share, ...patch } as InferenceTerms;
}

function childRequest(brief: ChildBrief, patch: Record<string, unknown> = {}): DispatchRequest {
  return {
    request_id: brief.child_ref,
    ...REVISION,
    terms: childTerms(brief),
    intake: { message: MESSAGE, running_threads: [] },
    triage_context: '',
    route_context: '',
    child: { brief: structuredClone(brief) as ChildBrief },
    ...patch,
  } as DispatchRequest;
}

async function parentSpawn(
  options: {
    readonly roles?: readonly string[];
    readonly rootRoute?: string;
    readonly terms?: InferenceTerms;
    readonly journal?: DispatchJournal;
    readonly clock?: Clock;
    readonly spawn?: SpawnPort;
    readonly id?: string;
  } = {},
) {
  const journal = options.journal ?? new MemoryDispatchJournal();
  const h = harness(
    { roles: options.roles ?? MIXED4, rootRoute: options.rootRoute ?? 'flash' },
    { journal, spawn: options.spawn ?? confirmingSpawn, ...(options.clock ? { clock: options.clock } : {}) },
  );
  const parent = await decideDispatch(rootRequest(options.terms, options.id), h.ports, journal);
  const plan = (parent.intent as SpawnIntent).plan;
  return { journal, parent, plan, reads: plan.children.slice(0, -1), gen: plan.children.at(-1)! };
}
type Spawned = Awaited<ReturnType<typeof parentSpawn>>;

function run(h: Harness, request: DispatchRequest, signal?: AbortSignal): Promise<DispatchDecision> {
  return decideDispatch(request, h.ports, h.journal, signal);
}

async function runReads(s: Spawned, fake: Fake = {}, options: Parameters<typeof harness>[1] = {}) {
  const decisions: DispatchDecision[] = [];
  for (const brief of s.reads)
    decisions.push(await run(harness(fake, { journal: s.journal, ...options }), childRequest(brief)));
  return decisions;
}

function fact(d: { readonly decide1: { readonly facts: readonly Decide1Fact[] } }, name: string) {
  return d.decide1.facts.find((f) => f.name === name)?.value;
}

function untouched(journal: DispatchJournal, id: string) {
  const loaded = journal.load(id);
  assert.deepEqual(
    [loaded.checkpoint, loaded.decisions.length, loaded.attempt, loaded.presented],
    [null, 0, null, false],
  );
}

function forged(journal: DispatchJournal, id: string, forge: (loaded: any) => any): DispatchJournal {
  return {
    load: (x) => (x === id ? forge(structuredClone(journal.load(x))) : journal.load(x)),
    checkpoint: (cp) => journal.checkpoint(cp),
    claim: (x, intent, cp) => journal.claim(x, intent, cp),
    acquire: (x, s) => journal.acquire(x, s),
    release: (x, a) => journal.release(x, a),
    present: (x, a) => journal.present(x, a),
    append: (d, a) => journal.append(d, a),
  };
}

function recording(storage: DispatchJournal) {
  const counts = { checkpoint: 0, claim: 0, acquire: 0, present: 0, append: 0 };
  const journal: DispatchJournal = {
    load: (x) => storage.load(x),
    checkpoint: (cp) => {
      counts.checkpoint++;
      storage.checkpoint(cp);
    },
    claim: (x, intent, cp) => {
      counts.claim++;
      return storage.claim(x, intent, cp);
    },
    acquire: (x, s) => {
      counts.acquire++;
      return storage.acquire(x, s);
    },
    release: (x, a) => storage.release(x, a),
    present: (x, a) => {
      counts.present++;
      return storage.present(x, a);
    },
    append: (d, a) => {
      counts.append++;
      return storage.append(d, a);
    },
  };
  return { journal, counts };
}

function collector(): { port: WeftPort; records: WeftRecordShape[] } {
  const records: WeftRecordShape[] = [];
  return {
    port: { trace_id: 'trace-1', emitter_id: 'loom.dispatch', emit: (record) => void records.push(record) },
    records,
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'condition never held');
}

/** The exact historical evidence a pure replay of this child checkpoint needs. */
function evidenceOf(journal: DispatchJournal, child: DispatchChild): ChildEvidence {
  const parent = journal.load(child.parent_ref);
  return {
    parent: { checkpoint: parent.checkpoint, decisions: parent.decisions },
    reads: (child.dependencies ?? []).map((edge) =>
      edge.entry === null ? null : journal.load(edge.decision_ref).decisions[edge.entry - 1]!,
    ),
  };
}

function reseal(brief: ChildBrief, patch: Partial<ChildBrief>, frame: Record<string, unknown> = {}): ChildBrief {
  const { schema: _s, seal: _seal, ...fields } = { ...brief.frame, ...frame } as any;
  return { ...structuredClone(brief), ...patch, frame: sealFrame(fields) } as ChildBrief;
}

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
  'preflight.reason',
  'preflight.targets',
  ...Array.from({ length: 8 }, (_, i) => `preflight.t${i}.role`),
  'preflight.admitted',
  'spawn.gain',
  'spawn.children',
  'spawn.plan',
  'spawn.port',
  'entry.kind',
  'child.kind',
  'child.parent',
  'child.plan',
  'child.dependencies',
  'child.read_bytes',
  'child.share',
  'child.boundary',
  'residual_ambiguity',
  'clarify.reason',
  'multi_deliverable.reason',
  'reads_before_gen.reason',
  'veto_bare_gen.reason',
];

// ---------------------------------------------------------------------------------------------
// 1. Production default-off: the behavioural half (the source scan is spawn-default-off.test.ts).
// ---------------------------------------------------------------------------------------------

test('P5c1-1 absent ports.spawn: eligible roles give spawn.port=false, gen.route and zero spawn calls', async () => {
  const h = harness({ roles: EDIT4 });
  assert.ok(!Object.hasOwn(h.ports, 'spawn'));
  const d = await run(h, rootRequest());
  assert.deepEqual(
    [fact(d, 'preflight.admitted'), fact(d, 'spawn.port'), d.decide1.rule, d.intent?.kind, h.spawnCalls.length],
    [true, false, 'gen.route', 'implement', 0],
  );
  assert.equal(h.dispatchCalls.length, 1);
});

// ---------------------------------------------------------------------------------------------
// 2. Parent admission (R1).
// ---------------------------------------------------------------------------------------------

test('P5c1-2 an exact member of a successful root spawn is admitted; verifyChild is pure', async () => {
  const s = await parentSpawn();
  const request = childRequest(s.reads[0]!);
  const parent = s.journal.load('d1');
  const verified = verifyChild(request, { checkpoint: parent.checkpoint, decisions: parent.decisions });
  assert.deepEqual(verified.brief, s.reads[0]);
  assert.equal(verified.parent_entry, s.parent.entry);
  assert.equal(verified.plan.digest, s.plan.digest);
  assert.deepEqual(verified.terms, PARENT_TERMS);
  const h = harness({}, { journal: s.journal });
  const d = await run(h, request);
  assert.deepEqual([d.status, d.decide1.rule, d.decide1.band], ['dispatched', 'act.read', 'tool_call']);
});

test('P5c1-2 missing, failed or mismatched parents and tampered members throw before any effect', async () => {
  const s = await parentSpawn();
  const read = s.reads[0]!;
  const gen = s.gen;
  const goal = digest({ message: MESSAGE });
  const foreignRead: ChildBrief = {
    schema: 'spawn.child@1',
    child_ref: childRef('d1', 'read', 'target2', 2),
    kind: 'read',
    target_ref: 'target2',
    edit: [],
    read: [],
    forbid: [],
    tier: null,
    share: 0,
    frame: sealFrame({
      root_ref: 'd1',
      parent_ref: 'd1',
      goal_digest: goal,
      why: 'preflight.read',
      siblings: read.frame.siblings,
      depends_on: [],
    }),
  };
  const refused = await parentSpawn({
    spawn: (intent) => ({ status: 'refused', dispatch_id: intent.dispatch_id, reason: 'conflict' }),
  });
  const cases: [string, DispatchJournal, DispatchRequest][] = [
    ['missing parent', new MemoryDispatchJournal(), childRequest(read)],
    ['failed parent', refused.journal, childRequest(refused.reads[0]!)],
    [
      'receipt names another plan',
      forged(s.journal, 'd1', (l) => {
        l.decisions.at(-1).receipt.ref = digest('other');
        return l;
      }),
      childRequest(read),
    ],
    [
      'claimed plan differs from the decision',
      forged(s.journal, 'd1', (l) => {
        l.checkpoint.intent.roles_digest = digest('other');
        return l;
      }),
      childRequest(read),
    ],
    [
      'plan no longer re-derives from the parent evidence',
      forged(s.journal, 'd1', (l) => {
        l.checkpoint.preflight_budget = 9;
        l.checkpoint.preflight_terms.cost_ceiling = 9;
        return l;
      }),
      childRequest(read),
    ],
    [
      'parent checkpoint is a child',
      forged(s.journal, 'd1', (l) => {
        l.checkpoint.child = { schema: 'dispatch.child@1' };
        return l;
      }),
      childRequest(read),
    ],
    ['goal tamper', s.journal, childRequest(read, { intake: { message: 'another goal', running_threads: [] } })],
    [
      'resealed goal digest',
      s.journal,
      childRequest(reseal(read, {}, { goal_digest: digest({ message: 'x' }) }), {
        intake: { message: 'x', running_threads: [] },
      }),
    ],
    ['id tamper', s.journal, { ...childRequest(read), request_id: s.reads[1]!.child_ref }],
    ['role tamper', s.journal, childRequest(reseal(gen, { forbid: [] }))],
    [
      'share tamper',
      s.journal,
      childRequest(reseal(gen, { share: 9 }), { terms: childTerms(gen, { cost_ceiling: 9 }) }),
    ],
    ['tier tamper', s.journal, childRequest(reseal(gen, { tier: 'strong' }))],
    ['edge tamper', s.journal, childRequest(reseal(gen, {}, { depends_on: [read.child_ref] }))],
    ['sibling tamper', s.journal, childRequest(reseal(read, {}, { siblings: [read.child_ref, gen.child_ref] }))],
    [
      'unsealed frame',
      s.journal,
      childRequest({ ...read, frame: { ...read.frame, depends_on: [], seal: digest('x') } }),
    ],
    ['resealed foreign child', s.journal, childRequest(foreignRead)],
  ];
  for (const [name, journal, request] of cases) {
    const sink = collector();
    const h = harness({}, { journal, weft: sink.port });
    await assert.rejects(run(h, request), Error, name);
    assert.equal(h.effects(), 0, name);
    assert.equal(sink.records.length, 0, name);
    untouched(s.journal, request.request_id);
  }
});

// ---------------------------------------------------------------------------------------------
// 3. Capture and terms (#7, R3, R5).
// ---------------------------------------------------------------------------------------------

test('P5c1-3 root/read/generate term fields and deferred caller mutation', async () => {
  const s = await parentSpawn();
  const root = s.journal.load('d1').checkpoint!;
  assert.deepEqual([root.preflight_terms, root.child_terms, root.child], [PARENT_TERMS, null, null]);
  assert.equal(root.preflight_budget, PARENT_TERMS.cost_ceiling);
  await runReads(s);
  const read = s.journal.load(s.reads[0]!.child_ref).checkpoint!;
  assert.deepEqual(
    [read.preflight_terms, read.child_terms, read.child!.dependencies],
    [null, childTerms(s.reads[0]!), []],
  );
  assert.equal(read.child_terms!.cost_ceiling, 0);
  // Deferred mutation of every caller-owned value cannot reach admitted evidence.
  const request = childRequest(s.gen) as any;
  const h = harness({}, { journal: s.journal });
  const pending = run(h, request);
  request.terms.cost_ceiling = 10_000;
  request.terms.destinations.push('elsewhere');
  request.child.brief.share = 10_000;
  request.child.brief.edit.push('target3');
  request.intake.message = 'mutated';
  const d = await pending;
  assert.equal(d.status, 'dispatched');
  const gen = s.journal.load(s.gen.child_ref).checkpoint!;
  assert.deepEqual([gen.preflight_terms, gen.child_terms], [null, childTerms(s.gen)]);
  assert.deepEqual(gen.child!.brief, s.gen);
  assert.equal(gen.child!.terms_digest, digest(childTerms(s.gen)));
  // The site sets its own decision tier; every admitted child term is passed through unchanged.
  const { tier: _tier, ...asked } = h.evaluateCalls.find((c) => c.site === 'loop.route')!.terms;
  assert.deepEqual(asked, childTerms(s.gen));
});

test('P5c1-3 child terms are a verified subset of the captured root terms', async () => {
  const accepted: [string, InferenceTerms | undefined, (b: ChildBrief) => Record<string, unknown>][] = [
    ['zero-cost read', undefined, () => ({})],
    ['narrower', undefined, () => ({ destinations: ['local'], deadline: 50, max_context_tokens: 50, max_attempts: 1 })],
    ['audit false -> true', undefined, () => ({ audit: true })],
    ['audit absent -> true', { ...PARENT_TERMS, audit: undefined } as any, () => ({ audit: true })],
    [
      'own prefix fields',
      undefined,
      () => ({
        prefix_digest: 'child-prefix',
        prefix_cache: { routed_unit_id: 'unit.child', prefix_digest: 'child-prefix', cached_tokens: 0 },
      }),
    ],
  ];
  for (const [name, parentTerms, patch] of accepted) {
    const terms = parentTerms === undefined ? PARENT_TERMS : JSON.parse(JSON.stringify(parentTerms));
    const s = await parentSpawn({ terms });
    for (const brief of [s.reads[0]!, s.gen]) {
      const base = { ...childTerms(brief), ...(terms.audit === undefined ? { audit: undefined } : {}) };
      const own = JSON.parse(JSON.stringify({ ...base, ...patch(brief) }));
      const h = harness({}, { journal: s.journal });
      // reads[0] already ran with its own narrowed terms; the remaining reads use the defaults.
      if (brief.kind === 'generate')
        for (const read of s.reads.slice(1)) await run(harness({}, { journal: s.journal }), childRequest(read));
      const d = await run(h, childRequest(brief, { terms: own }));
      assert.equal(d.status, 'dispatched', `${name} ${brief.kind}`);
      assert.deepEqual(s.journal.load(brief.child_ref).checkpoint!.child_terms, own, name);
    }
  }
  const rejected: [string, InferenceTerms | undefined, (b: ChildBrief) => Record<string, unknown>][] = [
    ['ceiling above share', undefined, (b) => ({ cost_ceiling: b.share + 1 })],
    ['non-natural ceiling', undefined, () => ({ cost_ceiling: 0.5 })],
    ['wider destinations', undefined, () => ({ destinations: ['local', 'other'] })],
    ['later deadline', undefined, () => ({ deadline: 101 })],
    ['wider context', undefined, () => ({ max_context_tokens: 101 })],
    ['more attempts', undefined, () => ({ max_attempts: 3 })],
    ['weaker quality', undefined, () => ({ quality: 'baseline' })],
    ['audit true -> false', { ...PARENT_TERMS, audit: true }, () => ({ audit: false })],
    ['audit true -> absent', { ...PARENT_TERMS, audit: true }, () => ({ audit: undefined })],
    ['relabelled content class', undefined, () => ({ content_class: 'public' })],
    ['absent content class', undefined, () => ({ content_class: undefined })],
    ['changed per-route attempts', undefined, () => ({ max_attempts_per_route: 2 })],
    ['added tier', undefined, () => ({ tier: 'strong' })],
    ['copied parent prefix_digest', undefined, () => ({ prefix_digest: 'parent-prefix' })],
    ['copied parent prefix_cache', undefined, () => ({ prefix_cache: PARENT_TERMS.prefix_cache })],
    ['unknown term field', undefined, () => ({ extra: 1 })],
  ];
  for (const [name, parentTerms, patch] of rejected) {
    const s = await parentSpawn({ terms: parentTerms ?? PARENT_TERMS });
    for (const brief of [s.reads[0]!, s.gen]) {
      const audited = parentTerms?.audit === true;
      if (brief.kind === 'generate')
        for (const read of s.reads) {
          const terms = audited ? { ...childTerms(read), audit: true } : childTerms(read);
          assert.equal(
            (await run(harness({}, { journal: s.journal }), childRequest(read, { terms }))).status,
            'dispatched',
          );
        }
      const base = audited ? { ...childTerms(brief), audit: true } : childTerms(brief);
      const own = JSON.parse(JSON.stringify({ ...base, ...patch(brief) }));
      const h = harness({}, { journal: s.journal });
      await assert.rejects(run(h, childRequest(brief, { terms: own })), Error, `${name} ${brief.kind}`);
      assert.equal(h.effects(), 0, name);
      untouched(s.journal, brief.child_ref);
    }
  }
});

test('P5c1-3 closed child request shape, same-id terms and root/child identity', async () => {
  const s = await parentSpawn();
  const read = s.reads[0]!;
  const shapes: [string, DispatchRequest][] = [
    ['extra child key', childRequest(read, { child: { brief: read, extra: 1 } })],
    [
      'running threads',
      childRequest(read, { intake: { message: MESSAGE, running_threads: [{ thread_id: 'T', summary: '' }] } }),
    ],
    ['triage context', childRequest(read, { triage_context: 'ctx' })],
    ['route context', childRequest(read, { route_context: 'ctx' })],
    ['targets', childRequest(read, { targets: [] })],
    ['message mismatch', childRequest(read, { intake: { message: `${MESSAGE}!`, running_threads: [] } })],
  ];
  for (const [name, request] of shapes) {
    const h = harness({}, { journal: s.journal });
    await assert.rejects(run(h, request), Error, name);
    assert.equal(h.effects(), 0, name);
    untouched(s.journal, read.child_ref);
  }
  // A saved terminal read: changed terms, a root request on the child id, and a child on a root id throw.
  const h = harness({}, { journal: s.journal });
  const d = await run(h, childRequest(read));
  assert.equal(d.status, 'dispatched');
  const again = harness({}, { journal: s.journal });
  assert.deepEqual(await run(again, childRequest(read)), d);
  await assert.rejects(
    run(again, childRequest(read, { terms: childTerms(read, { destinations: ['local'] }) })),
    /terms/,
  );
  const { child: _c, ...asRoot } = childRequest(read);
  await assert.rejects(run(again, { ...asRoot, triage_context: 'x', route_context: 'x' } as DispatchRequest), /child/);
  // A root's id cannot be re-entered as a child (its stored checkpoint has child null).
  const rootAsChild = forged(s.journal, read.child_ref, () => structuredClone(s.journal.load('d1')));
  await assert.rejects(run(harness({}, { journal: rootAsChild }), childRequest(read)), Error);
  assert.equal(again.effects(), 0);
  // Claimed but unappended: changed terms still throw before any presentation.
  const s2 = await parentSpawn();
  const crash: DispatchJournal = {
    ...forged(s2.journal, '', (l) => l),
    claim: (id, intent, cp) => {
      s2.journal.claim(id, intent, cp);
      throw new Error('crash at claim');
    },
  };
  await assert.rejects(run(harness({}, { journal: crash }), childRequest(s2.reads[0]!)), /crash at claim/);
  const resumed = harness({}, { journal: s2.journal });
  await assert.rejects(
    run(resumed, childRequest(s2.reads[0]!, { resume: true, terms: childTerms(s2.reads[0]!, { deadline: 1 }) })),
    /terms/,
  );
  assert.equal(resumed.effects(), 0);
});

// ---------------------------------------------------------------------------------------------
// 4. Read completion (R4).
// ---------------------------------------------------------------------------------------------

test('P5c1-4 a read presents one exact read intent through DispatchPort only', async () => {
  const s = await parentSpawn();
  const brief = s.reads[1]!;
  const h = harness({}, { journal: s.journal, spawn: () => assert.fail('no spawn') });
  const d = await run(h, childRequest(brief));
  const cp = s.journal.load(brief.child_ref).checkpoint!;
  const child = cp.child!;
  assert.deepEqual(Object.keys(child), [
    'schema',
    'parent_ref',
    'parent_entry',
    'plan_digest',
    'brief',
    'terms_digest',
    'dependencies',
    'dependencies_digest',
  ]);
  assert.deepEqual(child, {
    schema: 'dispatch.child@1',
    parent_ref: 'd1',
    parent_entry: s.parent.entry,
    plan_digest: s.plan.digest,
    brief,
    terms_digest: digest(childTerms(brief)),
    dependencies: [],
    dependencies_digest: digest([]),
  });
  const intent = { kind: 'read', dispatch_id: `${brief.child_ref}:dispatch`, target_ref: brief.target_ref, child };
  assert.deepEqual(h.dispatchCalls, [intent]);
  assert.deepEqual(Object.keys(h.dispatchCalls[0]!), ['kind', 'dispatch_id', 'target_ref', 'child']);
  assert.deepEqual([d.intent, cp.intent], [intent, intent]);
  assert.deepEqual([h.evaluateCalls.length, h.generateCalls.length, h.spawnCalls.length], [0, 0, 0]);
  assert.deepEqual(d.receipt, completedRead(intent as DispatchIntent));
  assert.deepEqual(
    [d.decided_by, d.choice, d.status, d.reason, d.decide1.rule, d.decide1.band, d.decide1.judgments],
    ['rule', 'read', 'dispatched', 'accepted', 'act.read', 'tool_call', []],
  );
});

test('P5c1-4 read receipts normalize: only completed immutable reads confirm', async () => {
  const s = await parentSpawn();
  const brief = s.reads[0]!;
  const read =
    (patch: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    (intent: DispatchIntent) => {
      const base = completedRead(intent) as any;
      return { ...base, ...top, read: { ...base.read, ...patch } };
    };
  const without = (key: string) => (intent: DispatchIntent) => {
    const base = completedRead(intent) as any;
    delete base.read[key];
    return base;
  };
  const cases: [string, (intent: DispatchIntent) => unknown, string, string][] = [
    ['complete', (i) => completedRead(i), 'dispatched', 'accepted'],
    ['empty read', (i) => completedRead(i, 0), 'dispatched', 'accepted'],
    [
      'queued ack',
      (i) => ({ status: 'dispatched', dispatch_id: i.dispatch_id, ref: 'queued' }),
      'paused',
      'dispatch_unconfirmed',
    ],
    ['extra top key', read({}, { queued: true }), 'paused', 'dispatch_unconfirmed'],
    ['extra read key', read({ body: 'CANARY-body' }), 'paused', 'dispatch_unconfirmed'],
    ['missing revision', without('revision'), 'paused', 'dispatch_unconfirmed'],
    ['missing bytes', without('bytes'), 'paused', 'dispatch_unconfirmed'],
    ['wrong id', read({}, { dispatch_id: 'other:dispatch' }), 'paused', 'dispatch_unconfirmed'],
    ['wrong target', read({ target_ref: 'target2' }), 'paused', 'dispatch_unconfirmed'],
    ['unscreened revision', read({ revision: 'sk-CANARY-secret' }), 'paused', 'dispatch_unconfirmed'],
    ['text revision', read({ revision: 'two words' }), 'paused', 'dispatch_unconfirmed'],
    ['wrong digest', read({ digest: 'CANARY-body' }), 'paused', 'dispatch_unconfirmed'],
    ['negative bytes', read({ bytes: -1 }), 'paused', 'dispatch_unconfirmed'],
    ['fractional bytes', read({ bytes: 1.5 }), 'paused', 'dispatch_unconfirmed'],
    ['overflow bytes', read({ bytes: Number.MAX_SAFE_INTEGER + 1 }), 'paused', 'dispatch_unconfirmed'],
    ['string bytes', read({ bytes: '1' }), 'paused', 'dispatch_unconfirmed'],
    ['null read', (i) => ({ ...(completedRead(i) as object), read: null }), 'paused', 'dispatch_unconfirmed'],
    [
      'throws',
      () => {
        throw new Error('CANARY-error');
      },
      'paused',
      'dispatch_unconfirmed',
    ],
    ['refused', (i) => ({ status: 'refused', dispatch_id: i.dispatch_id, reason: 'no_grant' }), 'refused', 'refused'],
    ['budget', (i) => ({ status: 'refused', dispatch_id: i.dispatch_id, reason: 'budget' }), 'paused', 'budget'],
  ];
  for (const [name, respond, status, reason] of cases) {
    const fresh = await parentSpawn();
    const h = harness({}, { journal: fresh.journal, dispatch: respond });
    const d = await run(h, childRequest(fresh.reads[0]!));
    assert.deepEqual([d.status, d.reason], [status, reason], name);
    if (status === 'paused' && reason === 'dispatch_unconfirmed') assert.equal(d.receipt, null, name);
    assertNoCopiedText([d, fresh.journal.load(brief.child_ref)], CANARIES);
  }
  // Settlement: a presented read is resolved only by a normalized completed read.
  for (const [name, settled, status] of [
    ['settled complete', (i: DispatchIntent) => completedRead(i), 'dispatched'],
    ['settled queued', (i: DispatchIntent) => ({ status: 'dispatched', dispatch_id: i.dispatch_id, ref: 'q' }), null],
  ] as const) {
    const fresh = await parentSpawn();
    const id = fresh.reads[0]!.child_ref;
    const first = harness(
      {},
      {
        journal: fresh.journal,
        dispatch: () => {
          throw new Error('lost');
        },
      },
    );
    assert.equal((await run(first, childRequest(fresh.reads[0]!))).reason, 'dispatch_unconfirmed');
    const intent = fresh.journal.load(id).checkpoint!.intent!;
    const reads: string[] = [];
    const resumed = harness(
      {},
      {
        journal: fresh.journal,
        settlement: (decision_id) => {
          reads.push(decision_id);
          return settled(intent) as DispatchReceipt;
        },
        dispatch: () => ({ status: 'dispatched', dispatch_id: intent.dispatch_id, ref: 'queued' }),
      },
    );
    const d = await run(resumed, childRequest(fresh.reads[0]!, { resume: true }));
    assert.deepEqual(reads, [id], name);
    if (status === 'dispatched') {
      assert.deepEqual([d.status, resumed.dispatchCalls.length], ['dispatched', 0], name);
      assert.deepEqual(d.receipt, completedRead(intent));
    } else assert.deepEqual([d.status, d.reason], ['paused', 'dispatch_unconfirmed'], name);
  }
});

test('P5c1-4 forbid and skip targets cannot be injected as reads', async () => {
  const s = await parentSpawn();
  for (const target of ['target2', 'target3']) {
    const index = s.reads.length;
    const injected = reseal(s.reads[0]!, {
      target_ref: target,
      child_ref: childRef('d1', 'read', target, index),
    });
    const h = harness({}, { journal: s.journal });
    await assert.rejects(run(h, childRequest(injected)), Error, target);
    assert.equal(h.effects(), 0);
  }
});

// ---------------------------------------------------------------------------------------------
// 5. Join semantics (#5/#6).
// ---------------------------------------------------------------------------------------------

test('P5c1-5 reads complete out of order; no D2 before all are satisfied; pending polls write nothing', async () => {
  const s = await parentSpawn({ roles: EDIT4 });
  const sink = collector();
  const gen = s.gen;
  const poll = async () => {
    const r = recording(s.journal);
    const h = harness({}, { journal: r.journal, weft: sink.port });
    const d = await run(h, childRequest(gen));
    return { d, h, r };
  };
  const order = [2, 0, 3, 1];
  for (const [step, index] of order.entries()) {
    const { d, h, r } = await poll();
    assert.deepEqual(
      [d.status, d.reason, d.decide1.rule, d.decide1.band, d.intent, d.child!.dependencies],
      ['paused', 'dependency_pending', 'hold.dependency_pending', 'escalate_gen', null, null],
      `step ${step}`,
    );
    assert.equal(fact(d, 'child.dependencies'), 'pending');
    assert.equal(h.effects(), 0);
    assert.deepEqual(r.counts, { checkpoint: 0, claim: 0, acquire: 0, present: 0, append: 0 });
    untouched(s.journal, gen.child_ref);
    await run(harness({}, { journal: s.journal, weft: sink.port }), childRequest(s.reads[index]!));
  }
  assert.equal(sink.records.filter((r) => r.kind === 'dispatch.decided').length, 4);
  const { d, h } = await poll();
  assert.deepEqual([d.status, d.decide1.rule, fact(d, 'child.dependencies')], ['dispatched', 'gen.child', 'satisfied']);
  assert.deepEqual(
    h.evaluateCalls.map((c) => c.site),
    ['loop.route'],
  );
  const edges = d.child!.dependencies!;
  assert.deepEqual(
    edges.map((e) => e.decision_ref),
    gen.frame.depends_on,
  );
  for (const [i, edge] of edges.entries()) {
    const decision = s.journal.load(edge.decision_ref).decisions[0]!;
    assert.deepEqual(Object.keys(edge), ['decision_ref', 'entry', 'decision_digest', 'dispatch_ref', 'receipt']);
    assert.deepEqual(edge, {
      decision_ref: s.reads[i]!.child_ref,
      entry: 1,
      decision_digest: digest(decision),
      dispatch_ref: `${s.reads[i]!.child_ref}:dispatch`,
      receipt: decision.receipt,
    });
  }
  assert.equal(d.child!.dependencies_digest, digest(edges));
  assert.equal(fact(d, 'child.read_bytes'), 64 * 4);
});

test('P5c1-5 resumable reasons stay pending at any revision; terminal outcomes without a read are unmet', async () => {
  // budget at an older revision: pending; a later success at that revision satisfies the join.
  {
    const clock = makeClock();
    const s = await parentSpawn({ clock });
    const budget = (i: DispatchIntent) => ({ status: 'refused', dispatch_id: i.dispatch_id, reason: 'budget' });
    const r0 = await run(harness({}, { journal: s.journal, clock, dispatch: budget }), childRequest(s.reads[0]!));
    assert.deepEqual([r0.status, r0.reason], ['paused', 'budget']);
    await run(harness({}, { journal: s.journal, clock }), childRequest(s.reads[1]!));
    clock.advance();
    const newer = { state_revision: 2, state_updated_at: 20 };
    const g = await run(harness({}, { journal: s.journal, clock }), childRequest(s.gen, newer));
    assert.deepEqual([g.reason, fact(g, 'child.dependencies')], ['dependency_pending', 'pending']);
    clock.set(1, 10);
    const again = await run(harness({}, { journal: s.journal, clock }), childRequest(s.reads[0]!, { resume: true }));
    assert.equal(again.status, 'dispatched');
    const joined = await run(harness({}, { journal: s.journal, clock }), childRequest(s.gen));
    assert.equal(joined.status, 'dispatched');
    assert.equal(joined.child!.dependencies![0]!.entry, 2);
  }
  // dispatch_unconfirmed survives a moved state; settlement later completes it.
  {
    const clock = makeClock();
    const s = await parentSpawn({ clock });
    const lost = harness(
      {},
      {
        journal: s.journal,
        clock,
        dispatch: () => {
          throw new Error('lost');
        },
      },
    );
    assert.equal((await run(lost, childRequest(s.reads[0]!))).reason, 'dispatch_unconfirmed');
    await run(harness({}, { journal: s.journal, clock }), childRequest(s.reads[1]!));
    clock.advance();
    const g = await run(
      harness({}, { journal: s.journal, clock }),
      childRequest(s.gen, { state_revision: 2, state_updated_at: 20 }),
    );
    assert.equal(g.reason, 'dependency_pending');
    const intent = s.journal.load(s.reads[0]!.child_ref).checkpoint!.intent!;
    const settled = harness(
      {},
      { journal: s.journal, clock, settlement: () => completedRead(intent) as DispatchReceipt },
    );
    assert.equal((await run(settled, childRequest(s.reads[0]!, { resume: true }))).status, 'dispatched');
    const joined = await run(
      harness({}, { journal: s.journal, clock }),
      childRequest(s.gen, { state_revision: 2, state_updated_at: 20 }),
    );
    assert.equal(joined.status, 'dispatched');
  }
  // Terminal stale_answer is unmet under today's predicate; unmet wins over pending; appends once.
  for (const terminal of ['stale', 'refused'] as const) {
    const clock = makeClock();
    const s = await parentSpawn({ clock });
    const storage = s.journal;
    const journal: DispatchJournal =
      terminal === 'stale'
        ? {
            ...forged(storage, '', (l) => l),
            claim: (id, intent, cp) => {
              const won = storage.claim(id, intent, cp);
              clock.advance();
              return won;
            },
          }
        : storage;
    const conflict = (i: DispatchIntent) => ({ status: 'refused', dispatch_id: i.dispatch_id, reason: 'conflict' });
    const r0 = await run(
      harness({}, { journal, clock, ...(terminal === 'refused' ? { dispatch: conflict } : {}) }),
      childRequest(s.reads[0]!),
    );
    assert.deepEqual(
      [r0.status, r0.reason],
      terminal === 'stale' ? ['paused', 'stale_answer'] : ['refused', 'refused'],
    );
    if (terminal === 'stale') {
      assert.deepEqual(
        [r0.decide1.rule, fact(r0, 'child.boundary'), r0.decide1.band],
        ['hold.admission', 'stale_answer', 'tool_call'],
      );
      clock.set(1, 10);
    }
    const sink = collector();
    const polls: DispatchDecision[] = [];
    for (let i = 0; i < 3; i++)
      polls.push(await run(harness({}, { journal: storage, clock, weft: sink.port }), childRequest(s.gen)));
    const [g] = polls;
    assert.deepEqual(
      [g!.status, g!.reason, g!.decide1.rule, g!.decide1.band, fact(g!, 'child.dependencies'), g!.intent],
      ['paused', 'unmet_dependency', 'hold.unmet_dependency', 'escalate_gen', 'unmet', null],
    );
    assert.deepEqual(polls[1], g);
    assert.deepEqual(polls[2], g);
    assert.equal(storage.load(s.gen.child_ref).decisions.length, 1);
    assert.equal(sink.records.filter((r) => r.kind === 'dispatch.decided').length, 1);
    const edges = g!.child!.dependencies!;
    assert.equal(edges[0]!.entry, 1);
    // r1 never ran: its edge is all nulls, and unmet still wins.
    assert.deepEqual(edges[1], {
      decision_ref: s.reads[1]!.child_ref,
      entry: null,
      decision_digest: null,
      dispatch_ref: null,
      receipt: null,
    });
    // A later read success cannot silently satisfy a frozen unmet join.
    await run(harness({}, { journal: storage, clock }), childRequest(s.reads[1]!));
    assert.deepEqual(await run(harness({}, { journal: storage, clock }), childRequest(s.gen)), g);
  }
});

test('P5c1-5 foreign, duplicate and reordered join evidence throws', async () => {
  const s = await parentSpawn({ roles: EDIT4 });
  await runReads(s);
  const [a, b] = [s.reads[0]!.child_ref, s.reads[1]!.child_ref];
  const swapped = forged(s.journal, b, () => structuredClone(s.journal.load(a)));
  const h = harness({}, { journal: swapped });
  await assert.rejects(run(h, childRequest(s.gen)), Error);
  assert.equal(h.effects(), 0);
  const unwitnessed = forged(s.journal, b, (l) => {
    l.decisions[0].child = null;
    return l;
  });
  await assert.rejects(run(harness({}, { journal: unwitnessed }), childRequest(s.gen)), Error);
  const dispatchedWithoutRead = forged(s.journal, b, (l) => {
    delete l.decisions[0].receipt.read;
    return l;
  });
  await assert.rejects(run(harness({}, { journal: dispatchedWithoutRead }), childRequest(s.gen)), Error);
  const d = await run(harness({}, { journal: s.journal }), childRequest(s.gen));
  const cp = s.journal.load(s.gen.child_ref).checkpoint!;
  const evidence = evidenceOf(s.journal, cp.child!);
  assert.deepEqual(transitionDispatch(childRequest(s.gen), cp, d.receipt, d.entry, evidence), d);
  for (const reads of [
    [evidence.reads[1], evidence.reads[0], ...evidence.reads.slice(2)],
    [evidence.reads[0], evidence.reads[0], ...evidence.reads.slice(2)],
    evidence.reads.slice(1),
    [...evidence.reads, evidence.reads[0]],
  ])
    assert.throws(() =>
      transitionDispatch(childRequest(s.gen), cp, d.receipt, d.entry, { ...evidence, reads: reads as any }),
    );
});

// ---------------------------------------------------------------------------------------------
// 6. Child D2.
// ---------------------------------------------------------------------------------------------

test('P5c1-6 child D2 is the existing loop.route site over intake.message and sealed scope', async () => {
  const s = await parentSpawn();
  await runReads(s);
  const h = harness({}, { journal: s.journal });
  const d = await run(h, childRequest(s.gen));
  assert.deepEqual(
    h.generateCalls.map((c) => [c.site, c.request_id]),
    [['loop.route.extract', `${s.gen.child_ref}:route:x1`]],
  );
  const evaluate = h.evaluateCalls;
  assert.deepEqual(
    evaluate.map((c) => [c.site, c.request_id]),
    [['loop.route', `${s.gen.child_ref}:route`]],
  );
  const cp = s.journal.load(s.gen.child_ref).checkpoint!;
  assert.deepEqual(
    [cp.asks, cp.intake, cp.triage, cp.shadow, cp.preflight],
    [{ intake: 0, triage: 0, route: 1, shadow: 0, preflight: 0 }, null, null, null, null],
  );
  // The ask is byte-identical to a direct decideLoopRoute over the recorded state.
  const state = JSON.parse(h.generateCalls[0]!.input.prompt) as { unit_of_work: string; context: string };
  assert.deepEqual(Object.keys(state).sort(), ['context', 'unit_of_work']);
  assert.equal(state.unit_of_work, MESSAGE);
  const context = JSON.parse(state.context);
  assert.equal(context.coupling, s.gen.edit.length);
  assert.equal(context.forbid, s.gen.forbid.length);
  assert.deepEqual(context.edit, s.gen.edit);
  assert.deepEqual(
    context.reads.map((r: any) => [r.target_ref, r.bytes]),
    s.reads.map((r) => [r.target_ref, 64]),
  );
  assert.equal(context.read_bytes, 64 * s.reads.length);
  // The sealed brief (in records) names the forbid target; the D2 disclosure carries only its count.
  assertNoCopiedText([h.generateCalls, h.evaluateCalls], [...CANARIES, 'target2']);
  assertNoCopiedText([cp, d], CANARIES);
  const direct = harness();
  const ask: LoopDecisionAsk = {
    request_id: `${s.gen.child_ref}:route`,
    ...REVISION,
    state,
    terms: childTerms(s.gen),
    needs_dispatch: true,
  };
  const expected = await decideLoopRoute(ask, direct.gateway, direct.clock.now);
  assert.deepEqual(direct.evaluateCalls, h.evaluateCalls);
  assert.deepEqual(direct.generateCalls, h.generateCalls);
  assert.deepEqual(cp.route, expected);
  assert.equal(h.evaluateCalls[0]!.questions && Object.keys(h.evaluateCalls[0]!.questions).length, 1);
  assert.equal(JSON.stringify(h.evaluateCalls[0]).includes(SITE_POLICY['loop.route'].question), true);
});

test('P5c1-6 D2 tier table: accepted tiers, bounded fallback, holds and ask.route', async () => {
  type Row = [string, string, NonNullable<Fake['child']>, string, string, string, string | null, string | null];
  const rows: Row[] = [];
  for (const parent of TIER_ORDER) {
    for (const tier of TIER_ORDER)
      rows.push([
        `accepted ${tier} from ${parent}`,
        parent,
        { choice: tier },
        'dispatched',
        'gen.child',
        'accepted',
        tier,
        'child_route',
      ]);
    const bounded = TIER_ORDER[Math.min(1, TIER_ORDER.indexOf(parent))]!;
    rows.push([
      `low confidence from ${parent}`,
      parent,
      { choice: 'strong', confidence: 0.5 },
      'dispatched',
      'gen.child_fallback',
      'low_confidence',
      bounded,
      'child_route_fallback',
    ]);
    rows.push([
      `missing confidence from ${parent}`,
      parent,
      { choice: 'strong', confidence: null },
      'dispatched',
      'gen.child_fallback',
      'missing_confidence',
      bounded,
      'child_route_fallback',
    ]);
  }
  rows.push(['outage', 'flash', { mode: 'outage' }, 'paused', 'hold.outage', 'decision_unavailable', null, null]);
  rows.push(['stale', 'flash', { mode: 'stale' }, 'paused', 'hold.admission', 'stale_answer', null, null]);
  rows.push(['mismatch', 'flash', { mode: 'mismatch' }, 'paused', 'hold.admission', 'mismatched_answer', null, null]);
  // Live, an unusable extraction is re-extracted once, then gated original-only (existing D2 rules);
  // the invalid/missing-origin stop maps to ask.route (pinned on decideBand below).
  rows.push([
    'unusable extraction',
    'flash',
    { extract: 'garbage' },
    'dispatched',
    'gen.child',
    'accepted',
    'flash',
    'child_route',
  ]);
  for (const [name, parent, child, status, rule, reason, tier, source] of rows) {
    const s = await parentSpawn({ rootRoute: parent });
    assert.equal(s.gen.tier, parent);
    await runReads(s);
    const h = harness({ child }, { journal: s.journal });
    const d = await run(h, childRequest(s.gen));
    assert.deepEqual([d.status, d.decide1.rule, d.reason], [status, rule, reason], name);
    assert.equal(d.decide1.judgments.length <= 2, true);
    assert.equal(h.generateCalls.length, child.extract === 'garbage' ? 2 : 1, name);
    assert.ok(
      d.decide1.judgments.every((j) => j.name.startsWith('route.')),
      name,
    );
    const implement = h.dispatchCalls.filter((i) => i.kind === 'implement');
    if (tier === null) {
      assert.equal(h.dispatchCalls.length, 0, name);
      assert.equal(d.intent, null, name);
      continue;
    }
    assert.equal(implement.length, 1, name);
    const cp = s.journal.load(s.gen.child_ref).checkpoint!;
    assert.deepEqual(implement[0], {
      kind: 'implement',
      dispatch_id: `${s.gen.child_ref}:dispatch`,
      tier,
      ceiling: tier,
      tier_source: source,
      child: cp.child,
    });
    assert.deepEqual(d.intent, implement[0]);
    assert.deepEqual([d.decided_by, d.choice, d.decide1.band], ['route', tier, 'escalate_gen'], name);
    // The inherited sealed tier stays as historical evidence.
    assert.equal(cp.child!.brief.tier, parent);
  }
  // An outage is resumable and resume re-asks only D2.
  const s = await parentSpawn();
  await runReads(s);
  const out = await run(harness({ child: { mode: 'outage' } }, { journal: s.journal }), childRequest(s.gen));
  assert.equal(out.reason, 'decision_unavailable');
  const h = harness({}, { journal: s.journal });
  const d = await run(h, childRequest(s.gen, { resume: true }));
  assert.deepEqual(
    [d.status, h.evaluateCalls.length, s.journal.load(s.gen.child_ref).checkpoint!.asks.route],
    ['dispatched', 1, 2],
  );
});

// ---------------------------------------------------------------------------------------------
// 7. Rules/root parity (R1, R2).
// ---------------------------------------------------------------------------------------------

test('P5c1-7 decide1.rules@3: 21 rows in order, 42 facts and bounded judgments', async () => {
  assert.equal(DECIDE1_RULE_TABLE, 'decide1.rules@3');
  assert.deepEqual(
    DECIDE1_RULES.map((row) => [row.id, row.band]),
    [
      ['hold.admission', 'withheld'],
      ['hold.outage', 'withheld'],
      ['hold.paused', 'withheld'],
      ['hold.dependency_pending', 'withheld'],
      ['hold.unmet_dependency', 'withheld'],
      ['act.read', 'tool_call'],
      ['gen.child', 'escalate_gen'],
      ['gen.child_fallback', 'escalate_gen'],
      ['ask.intake', 'ask_human'],
      ['ask.irreversible', 'ask_human'],
      ['ask.thread_target', 'ask_human'],
      ['act.thread', 'tool_call'],
      ['ask.triage', 'ask_human'],
      ['act.capability', 'tool_call'],
      ['act.done_check', 'tool_call'],
      ['act.decline', 'tool_call'],
      ['gen.triage_fallback', 'escalate_gen'],
      ['spawn.preflight', 'spawn_subtasks'],
      ['gen.route', 'escalate_gen'],
      ['ask.route', 'ask_human'],
      ['gen.route_fallback', 'escalate_gen'],
    ],
  );
  const s = await parentSpawn();
  const [read] = await runReads(s);
  const gen = await run(harness({}, { journal: s.journal }), childRequest(s.gen));
  for (const d of [s.parent, read!, gen]) {
    assert.deepEqual(
      d.decide1.facts.map((f) => f.name),
      FACT_NAMES,
    );
    assert.equal(d.decide1.facts.length, 42);
    assert.ok(!FACT_NAMES.includes('child.root'));
  }
  assert.ok(s.parent.decide1.judgments.length <= 30);
  assert.ok(read!.decide1.judgments.length === 0 && gen.decide1.judgments.length <= 2);
  const values = (d: DispatchDecision) => FACT_NAMES.slice(29, 37).map((name) => fact(d, name));
  assert.deepEqual(values(s.parent), ['root', null, null, null, null, null, null, null]);
  assert.deepEqual(values(read!), ['child', 'read', 'd1', s.plan.digest, 'satisfied', null, 0, null]);
  assert.deepEqual(values(gen), ['child', 'generate', 'd1', s.plan.digest, 'satisfied', 128, 10, null]);
  // Child facts never carry intake/triage/preflight evidence.
  for (const d of [read!, gen])
    for (const name of FACT_NAMES.slice(0, 10))
      assert.equal(fact(d, name), name === 'intake.accepted' ? false : null, name);
});

test('P5c1-7 impossible mixed stage sets fail closed', () => {
  const base = (patch: Record<string, Decide1Fact['value']>) => {
    const values: Record<string, Decide1Fact['value']> = Object.fromEntries(FACT_NAMES.map((n) => [n, null]));
    Object.assign(values, {
      'intake.accepted': false,
      'preflight.targets': 0,
      'spawn.port': false,
      'entry.kind': 'child',
      'child.kind': 'read',
      'child.parent': 'd1',
      'child.plan': digest('plan'),
      'child.dependencies': 'satisfied',
      'child.share': 0,
      ...patch,
    });
    return { judgments: [], facts: FACT_NAMES.map((name) => ({ name, value: values[name]! })) };
  };
  assert.equal(decideBand(base({})).rule, 'act.read');
  const generate = { 'child.kind': 'generate', 'child.share': 10 };
  const routed = {
    'route.choice': 'flash',
    'route.status': 'transition',
    'route.reason': 'accepted',
    'route.accepted': true,
  };
  assert.equal(decideBand(base({ ...generate, 'child.dependencies': 'pending' })).rule, 'hold.dependency_pending');
  assert.equal(decideBand(base({ ...generate, 'child.dependencies': 'unmet' })).rule, 'hold.unmet_dependency');
  assert.equal(decideBand(base({ ...generate, ...routed })).rule, 'gen.child');
  // Real D2 stops keep their existing rows: an origin failure asks, an outage holds.
  const stopped = { 'route.choice': 'standard', 'route.accepted': false };
  for (const [patch, rule] of [
    [{ 'route.status': 'needs_human', 'route.reason': 'invalid_extract' }, 'ask.route'],
    [{ 'route.status': 'needs_human', 'route.reason': 'extract_missing' }, 'ask.route'],
    [{ 'route.status': 'paused', 'route.reason': 'decision_unavailable' }, 'hold.outage'],
    [{ 'route.status': 'transition', 'route.reason': 'low_confidence' }, 'gen.child_fallback'],
  ] as const)
    assert.deepEqual(
      [
        decideBand(base({ ...generate, ...stopped, ...patch })).rule,
        decideBand(base({ ...generate, ...stopped, ...patch })).band,
      ],
      [rule, rule === 'ask.route' ? 'ask_human' : 'escalate_gen'],
    );
  for (const patch of [
    { 'intake.choice': 'new_thread', 'intake.status': 'transition' },
    { 'triage.choice': 'implement' },
    { ...routed },
    { 'child.dependencies': 'pending' },
    { 'child.kind': 'root' },
    { 'child.kind': null },
    { ...generate, 'child.dependencies': 'pending', ...routed },
    { ...generate, 'child.dependencies': 'unmet', ...routed },
    { ...generate, 'child.dependencies': null },
    { 'child.boundary': 'other' },
    { 'entry.kind': null },
    { 'entry.kind': 'root' },
    { 'preflight.reason': 'answered' },
  ])
    assert.throws(() => decideBand(base(patch)), /decide1: no rule matched/, JSON.stringify(patch));
});

test('P5c1-7 child boundaries extend hold.admission/hold.paused over real facts only', async () => {
  // Pre-D2: an aborted read and generator.
  const s = await parentSpawn();
  const controller = new AbortController();
  controller.abort();
  const read = await run(harness({}, { journal: s.journal }), childRequest(s.reads[0]!), controller.signal);
  assert.deepEqual(
    [
      read.status,
      read.reason,
      read.decide1.rule,
      read.decide1.band,
      fact(read, 'child.boundary'),
      read.decided_by,
      read.choice,
    ],
    ['paused', 'cancelled', 'hold.paused', 'tool_call', 'cancelled', 'rule', 'read'],
  );
  untouched(s.journal, s.reads[0]!.child_ref);
  await runReads(s);
  const gen = await run(harness({}, { journal: s.journal }), childRequest(s.gen), controller.signal);
  assert.deepEqual(
    [gen.reason, gen.decide1.rule, gen.decide1.band, fact(gen, 'child.boundary'), gen.choice],
    ['cancelled', 'hold.paused', 'escalate_gen', 'cancelled', 'flash'],
  );
  for (const d of [read, gen])
    for (const name of FACT_NAMES.slice(0, 14))
      assert.equal(fact(d, name), name === 'intake.accepted' ? false : null, name);
  // Post-D2: a stale gate after an accepted D2 keeps D2's facts and sets only child.boundary.
  const clock = makeClock();
  const t = await parentSpawn({ clock });
  await runReads(t, {}, { clock });
  // The answer lands fresh; the state moves right after its checkpoint, before the claim.
  const moving: DispatchJournal = {
    ...forged(t.journal, '', (l) => l),
    checkpoint: (cp) => {
      t.journal.checkpoint(cp);
      if (cp.decision_id === t.gen.child_ref && cp.route !== null) clock.advance();
    },
  };
  const stale = await run(harness({}, { journal: moving, clock }), childRequest(t.gen));
  assert.deepEqual(
    [stale.status, stale.reason, stale.decide1.rule, stale.decide1.band, fact(stale, 'child.boundary')],
    ['paused', 'stale_answer', 'hold.admission', 'escalate_gen', 'stale_answer'],
  );
  assert.deepEqual(
    ['route.status', 'route.reason', 'route.accepted'].map((n) => fact(stale, n)),
    ['transition', 'accepted', true],
  );
  for (const name of FACT_NAMES.slice(0, 10))
    assert.equal(fact(stale, name), name === 'intake.accepted' ? false : null);
  // Roots keep child.boundary null and their own hold rows.
  const root = await run(harness({ roles: MIXED4 }, { spawn: confirmingSpawn }), rootRequest(PARENT_TERMS, 'd2'));
  assert.equal(fact(root, 'child.boundary'), null);
  assert.equal(fact(root, 'entry.kind'), 'root');
});

// ---------------------------------------------------------------------------------------------
// 8. Abort, race and recovery.
// ---------------------------------------------------------------------------------------------

test('P5c1-8 abort around claim and presentation keeps D-ENG-048 semantics', async () => {
  // After claim, before present: nothing presented; resume presents once.
  {
    const s = await parentSpawn();
    const controller = new AbortController();
    const journal: DispatchJournal = {
      ...forged(s.journal, '', (l) => l),
      claim: (id, intent, cp) => {
        const won = s.journal.claim(id, intent, cp);
        controller.abort();
        return won;
      },
    };
    const h = harness({}, { journal });
    const d = await run(h, childRequest(s.reads[0]!), controller.signal);
    assert.deepEqual([d.reason, d.decide1.rule, h.dispatchCalls.length], ['cancelled', 'hold.paused', 0]);
    assert.equal(s.journal.load(s.reads[0]!.child_ref).decisions.length, 0);
    const resumed = harness({}, { journal: s.journal });
    assert.equal((await run(resumed, childRequest(s.reads[0]!, { resume: true }))).status, 'dispatched');
    assert.equal(resumed.dispatchCalls.length, 1);
  }
  // During presentation: the signal reaches the port; settlement decides on resume; no second presentation.
  {
    const s = await parentSpawn();
    const controller = new AbortController();
    let passed: AbortSignal | undefined;
    const h = harness(
      {},
      {
        journal: s.journal,
        dispatch: (intent, signal) => {
          passed = signal;
          controller.abort();
          return completedRead(intent);
        },
      },
    );
    const d = await run(h, childRequest(s.reads[0]!), controller.signal);
    assert.equal(passed, controller.signal);
    const loaded = s.journal.load(s.reads[0]!.child_ref);
    assert.deepEqual([d.reason, loaded.decisions.length, loaded.presented], ['cancelled', 0, true]);
    const intent = loaded.checkpoint!.intent!;
    const resumed = harness({}, { journal: s.journal, settlement: () => completedRead(intent) as DispatchReceipt });
    const r = await run(resumed, childRequest(s.reads[0]!, { resume: true }));
    assert.deepEqual([r.status, resumed.dispatchCalls.length], ['dispatched', 0]);
  }
  // Generator abort after claim: the identical intent is recovered without re-routing.
  {
    const s = await parentSpawn();
    await runReads(s);
    const controller = new AbortController();
    const journal: DispatchJournal = {
      ...forged(s.journal, '', (l) => l),
      claim: (id, intent, cp) => {
        const won = s.journal.claim(id, intent, cp);
        controller.abort();
        return won;
      },
    };
    const first = await run(harness({}, { journal }), childRequest(s.gen), controller.signal);
    assert.equal(first.reason, 'cancelled');
    const claimed = s.journal.load(s.gen.child_ref).checkpoint!.intent;
    const resumed = harness({ child: { choice: 'strong' } }, { journal: s.journal });
    const r = await run(resumed, childRequest(s.gen, { resume: true }));
    assert.deepEqual([r.status, resumed.evaluateCalls.length, resumed.generateCalls.length], ['dispatched', 0, 0]);
    assert.deepEqual(r.intent, claimed);
    assert.deepEqual(resumed.dispatchCalls, [claimed]);
  }
});

test('P5c1-8 same-child races have one winner; distinct reads overlap; retired tokens stay retired', async () => {
  const s = await parentSpawn({ roles: EDIT4 });
  const sink = collector();
  const gate = deferred();
  let started = 0;
  const slow = (intent: DispatchIntent) => {
    started++;
    return gate.promise.then(() => completedRead(intent));
  };
  const same = [0, 1, 2].map(() => harness({}, { journal: s.journal, weft: sink.port, dispatch: slow }));
  const distinct = s.reads.slice(1).map(() => harness({}, { journal: s.journal, weft: sink.port, dispatch: slow }));
  const races = same.map((h) => run(h, childRequest(s.reads[0]!)));
  const others = distinct.map((h, i) => run(h, childRequest(s.reads[i + 1]!)));
  // All four distinct reads are in flight together before any completes.
  await waitUntil(() => started === 4);
  gate.release();
  const results = await Promise.all(races);
  await Promise.all(others);
  assert.equal(
    same.reduce((n, h) => n + h.dispatchCalls.length, 0),
    1,
  );
  const winner = results.find((d) => d.status === 'dispatched')!;
  for (const d of results) assert.ok(d.status === 'dispatched' || d.reason === 'dispatch_unconfirmed');
  assert.equal(s.journal.load(s.reads[0]!.child_ref).decisions.length, 1);
  assert.equal(sink.records.filter((r) => r.kind === 'dispatch.decided').length, 4);
  const id = s.reads[0]!.child_ref;
  assert.equal(s.journal.present(id, `${id}:attempt:1`), false);
  assert.equal(s.journal.append(winner, `${id}:attempt:1`), false);
  // Concurrent generator calls on a satisfied join: one claim, one implement dispatch.
  const gens = [0, 1].map(() => harness({}, { journal: s.journal }));
  const decided = await Promise.all(gens.map((h) => run(h, childRequest(s.gen))));
  // The loser reports the winner or its uncertainty on the identical intent; it never re-presents.
  assert.deepEqual(decided[0]!.intent, decided[1]!.intent);
  assert.ok(decided.some((d) => d.status === 'dispatched'));
  for (const d of decided) assert.ok(d.status === 'dispatched' || d.reason === 'dispatch_unconfirmed');
  assert.equal(
    gens.reduce((n, h) => n + h.dispatchCalls.length, 0),
    1,
  );
  assert.equal(s.journal.load(s.gen.child_ref).decisions.length, 1);
});

test('P5c1-8 end to end: parent append, parallel reads, one generate dispatch; no child before append', async () => {
  const journal = new MemoryDispatchJournal();
  let early: unknown = null;
  const children: ChildBrief[] = [];
  const spawn: SpawnPort = async (intent) => {
    children.push(...intent.plan.children);
    // The opening port must not run a child before the parent's decision is appended.
    try {
      await run(harness({}, { journal }), childRequest(intent.plan.children[0]!));
    } catch (error) {
      early = error;
    }
    return confirmingSpawn(intent);
  };
  const s = await parentSpawn({ roles: EDIT4, journal, spawn });
  assert.ok(early instanceof Error);
  untouched(journal, children[0]!.child_ref);
  const reads = s.reads.map(() => harness({}, { journal }));
  const decisions = await Promise.all(s.reads.map((brief, i) => run(reads[i]!, childRequest(brief))));
  assert.ok(decisions.every((d) => d.status === 'dispatched'));
  const gen = harness({}, { journal });
  const d = await run(gen, childRequest(s.gen));
  assert.deepEqual([d.status, d.intent?.kind, gen.dispatchCalls.length], ['dispatched', 'implement', 1]);
  // A child outcome never rewrites the parent's spawn decision.
  assert.deepEqual(journal.load('d1').decisions, [s.parent]);
});

// ---------------------------------------------------------------------------------------------
// 9. Replay, evidence and disclosure (R6).
// ---------------------------------------------------------------------------------------------

test('P5c1-9 pure replay equals live for reads, joins, child D2 and receipts', async () => {
  const s = await parentSpawn();
  const reads = await runReads(s);
  for (const [i, d] of reads.entries()) {
    const cp = s.journal.load(s.reads[i]!.child_ref).checkpoint!;
    assert.deepEqual(
      transitionDispatch(childRequest(s.reads[i]!), cp, d.receipt, d.entry, evidenceOf(s.journal, cp.child!)),
      d,
    );
  }
  const gen = await run(harness({}, { journal: s.journal }), childRequest(s.gen));
  const cp = s.journal.load(s.gen.child_ref).checkpoint!;
  const evidence = evidenceOf(s.journal, cp.child!);
  assert.deepEqual(transitionDispatch(childRequest(s.gen), cp, gen.receipt, gen.entry, evidence), gen);
  // A child replay needs explicit evidence; current journal state is never consulted.
  assert.throws(() => transitionDispatch(childRequest(s.gen), cp, gen.receipt, gen.entry));
  // An unmet join replays from its frozen checkpoint.
  const u = await parentSpawn({ id: 'd2' });
  const conflict = (i: DispatchIntent) => ({ status: 'refused', dispatch_id: i.dispatch_id, reason: 'conflict' });
  await run(harness({}, { journal: u.journal, dispatch: conflict }), childRequest(u.reads[0]!));
  const unmet = await run(harness({}, { journal: u.journal }), childRequest(u.gen));
  const ucp = u.journal.load(u.gen.child_ref).checkpoint!;
  assert.equal(unmet.reason, 'unmet_dependency');
  assert.deepEqual(
    transitionDispatch(childRequest(u.gen), ucp, null, unmet.entry, evidenceOf(u.journal, ucp.child!)),
    unmet,
  );
});

test('P5c1-9 each evidence class is challenged independently, on live and pure paths', async () => {
  const s = await parentSpawn();
  await runReads(s);
  const d = await run(harness({}, { journal: s.journal }), childRequest(s.gen));
  const id = s.gen.child_ref;
  const cp = s.journal.load(id).checkpoint!;
  const evidence = evidenceOf(s.journal, cp.child!);
  const tamper = <T>(value: T, edit: (copy: any) => void): T => {
    const copy = structuredClone(value) as any;
    edit(copy);
    return copy;
  };
  const challenges: [string, DispatchCheckpoint, ChildEvidence][] = [
    ['parent receipt', cp, tamper(evidence, (e) => (e.parent.decisions.at(-1).receipt.ref = digest('x')))],
    ['parent decision missing', cp, tamper(evidence, (e) => (e.parent.decisions = []))],
    ['parent checkpoint child', cp, tamper(evidence, (e) => (e.parent.checkpoint.child = cp.child))],
    ['member', tamper(cp, (c) => (c.child.brief.share = 9)), evidence],
    ['plan digest', tamper(cp, (c) => (c.child.plan_digest = digest('x'))), evidence],
    ['parent entry', tamper(cp, (c) => (c.child.parent_entry = 2)), evidence],
    ['terms', tamper(cp, (c) => (c.child_terms.deadline = 50)), evidence],
    ['terms digest', tamper(cp, (c) => (c.child.terms_digest = digest('x'))), evidence],
    ['dependency digest', tamper(cp, (c) => (c.child.dependencies[0].decision_digest = digest('x'))), evidence],
    ['dependencies digest', tamper(cp, (c) => (c.child.dependencies_digest = digest('x'))), evidence],
    ['dependency receipt', tamper(cp, (c) => (c.child.dependencies[0].receipt.read.bytes = 1)), evidence],
    ['read snapshot', cp, tamper(evidence, (e) => (e.reads[0].receipt.read.bytes = 1))],
    ['intake stage', tamper(cp, (c) => (c.asks.intake = 1)), evidence],
    ['triage stage', tamper(cp, (c) => (c.asks.triage = 1)), evidence],
    ['shadow stage', tamper(cp, (c) => (c.asks.shadow = 1)), evidence],
    ['preflight terms', tamper(cp, (c) => (c.preflight_terms = PARENT_TERMS)), evidence],
    ['route stage', tamper(cp, (c) => (c.route.site.observation.confidence = 0.1)), evidence],
    ['intent child', tamper(cp, (c) => (c.intent.child.brief.tier = 'strong')), evidence],
  ];
  for (const [name, checkpoint, ev] of challenges) {
    assert.throws(() => transitionDispatch(childRequest(s.gen), checkpoint, d.receipt, d.entry, ev), Error, name);
  }
  // Live: a tampered claimed checkpoint throws on resume, abort and terminal-return paths.
  for (const [name, checkpoint] of challenges.filter(([, c, e]) => e === evidence && c !== cp)) {
    const live = forged(s.journal, id, () => ({ checkpoint, decisions: [], attempt: null, presented: false }));
    const h = harness({}, { journal: live });
    await assert.rejects(run(h, childRequest(s.gen, { resume: true })), Error, name);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(run(h, childRequest(s.gen, { resume: true }), aborted.signal), Error, name);
    assert.equal(h.effects(), 0, name);
  }
  const terminal = forged(s.journal, id, (l) => {
    l.decisions[0].child.brief.share = 9;
    return l;
  });
  await assert.rejects(run(harness({}, { journal: terminal }), childRequest(s.gen)), Error);
  const parentGone = forged(s.journal, 'd1', (l) => ({ ...l, decisions: [] }));
  await assert.rejects(run(harness({}, { journal: parentGone }), childRequest(s.gen)), Error);
});

test('P5c1-9 a cached terminal child validates its checkpoint and decision before returning', async () => {
  const s = await parentSpawn();
  await runReads(s);
  const gen = await run(harness({}, { journal: s.journal }), childRequest(s.gen));
  const id = s.gen.child_ref;
  const cached = (edit: (loaded: any) => void) =>
    forged(s.journal, id, (loaded) => {
      edit(loaded);
      return loaded;
    });
  const cases: [string, (loaded: any) => void][] = [
    ['checkpoint stage', (l) => (l.checkpoint.asks.triage = 1)],
    ['checkpoint intent', (l) => (l.checkpoint.intent.child.brief.tier = 'strong')],
    ['decision status', (l) => (l.decisions[0].status = 'paused')],
    ['decision intent', (l) => (l.decisions[0].intent.tier = 'strong')],
    ['decision receipt', (l) => (l.decisions[0].receipt.status = 'refused')],
    ['decision receipt ref', (l) => (l.decisions[0].receipt.ref = 'not a ref')],
    ['decision trace', (l) => (l.decisions[0].decide1.facts[0].value = 'tampered')],
  ];
  for (const [name, edit] of cases) {
    const h = harness({}, { journal: cached(edit) });
    await assert.rejects(run(h, childRequest(s.gen)), Error, name);
    assert.equal(h.effects(), 0, name);
  }
  assert.deepEqual(s.journal.load(id).decisions, [gen]);
  // A read's receipt is also frozen in its dependent generator's edge: a valid-looking ref change fails.
  const readId = s.reads[0]!.child_ref;
  const changedRef = forged(s.journal, readId, (loaded) => {
    loaded.decisions[0].receipt.ref = digest('other');
    return loaded;
  });
  const h = harness({}, { journal: changedRef });
  await assert.rejects(run(h, childRequest(s.reads[0]!)), Error, 'read receipt ref');
  assert.equal(h.effects(), 0);
});

test('P5c1-9 preflight_budget is bound to preflight_terms on validation and replay', async () => {
  const s = await parentSpawn();
  const loaded = s.journal.load('d1');
  const cp = loaded.checkpoint!;
  const request = rootRequest();
  assert.deepEqual(transitionDispatch(request, cp, s.parent.receipt, s.parent.entry), s.parent);
  for (const [name, patch] of [
    ['budget drift down', { preflight_budget: 9 }],
    ['budget drift up', { preflight_budget: 11 }],
    ['terms drift', { preflight_terms: { ...PARENT_TERMS, cost_ceiling: 9 } }],
    ['non-natural ceiling with a budget', { preflight_terms: { ...PARENT_TERMS, cost_ceiling: 2.5 } }],
    ['null budget with a natural ceiling', { preflight_budget: null }],
  ] as const) {
    const bad = { ...cp, ...patch } as DispatchCheckpoint;
    assert.throws(() => transitionDispatch(request, bad, s.parent.receipt, s.parent.entry), /preflight_budget/, name);
    const h = harness(
      {},
      { journal: forged(s.journal, 'd1', (l) => ({ ...l, checkpoint: bad, decisions: [] })), spawn: confirmingSpawn },
    );
    await assert.rejects(run(h, { ...request, resume: true }), /preflight_budget/, name);
    assert.equal(h.effects(), 0, name);
  }
  // A non-natural ceiling binds a null budget: consistent, no spawn, and it replays.
  const fractional = rootRequest({ ...PARENT_TERMS, cost_ceiling: 2.5 }, 'd2');
  const odd = harness({ roles: MIXED4 }, { spawn: confirmingSpawn });
  const od = await run(odd, fractional);
  const ocp = odd.journal.load('d2').checkpoint!;
  assert.deepEqual(
    [ocp.preflight_budget, ocp.preflight_terms?.cost_ceiling, od.decide1.rule, odd.spawnCalls.length],
    [null, 2.5, 'gen.route', 0],
  );
  assert.deepEqual(transitionDispatch(fractional, ocp, od.receipt, od.entry), od);
});

test('P5c1-9 record versions, key order, Weft validity, append-only emission and disclosure', async () => {
  const sink = collector();
  const journal = new MemoryDispatchJournal();
  const s = await parentSpawn({ journal });
  const root = journal.load('d1').checkpoint!;
  const CHECKPOINT_KEYS = [
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
    'preflight_budget',
    'spawn_port',
    'preflight_terms',
    'child_terms',
    'child',
    'intent',
  ];
  const DECISION_KEYS = [
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
    'child',
    'intent',
    'receipt',
    'intake',
    'triage',
    'route',
    'shadow',
    'preflight',
  ];
  assert.deepEqual(
    [root.schema, s.parent.schema, s.parent.rule_table],
    ['dispatch.checkpoint@5', 'dispatch.decision@6', 'decide1.rules@3'],
  );
  assert.deepEqual(Object.keys(root), CHECKPOINT_KEYS);
  assert.deepEqual(Object.keys(s.parent), DECISION_KEYS);
  assert.equal(s.parent.child, null);
  const mutating: WeftPort = {
    ...sink.port,
    emit: (record) => {
      sink.records.push(structuredClone(record));
      (record.fields as any).facts.push({ name: 'forged', value: 1 });
      throw new Error('CANARY-error');
    },
  };
  const reads: DispatchDecision[] = [];
  for (const brief of s.reads) reads.push(await run(harness({}, { journal, weft: mutating }), childRequest(brief)));
  const gen = await run(harness({}, { journal, weft: mutating }), childRequest(s.gen));
  for (const d of [...reads, gen]) {
    assert.deepEqual(Object.keys(d), DECISION_KEYS);
    assert.deepEqual(Object.keys(journal.load(d.decision_id).checkpoint!), CHECKPOINT_KEYS);
    assert.deepEqual(journal.load(d.decision_id).decisions, [d]);
    assert.ok(!d.decide1.facts.some((f) => f.name === 'forged'));
  }
  for (const record of sink.records) assert.equal(validateRecord(record).ok, true, record.kind);
  const decided = sink.records.filter((r) => r.kind === 'dispatch.decided');
  assert.equal(decided.length, s.reads.length + 1);
  const readFields = decided[0]!.fields as Record<string, any>;
  assert.deepEqual(
    ['decision_ref', 'decided_by', 'choice', 'status', 'dispatch_ref', 'rule', 'band'].map((k) => readFields[k]),
    [s.reads[0]!.child_ref, 'rule', 'read', 'dispatched', `${s.reads[0]!.child_ref}:dispatch`, 'act.read', 'tool_call'],
  );
  assert.ok(!Object.hasOwn(readFields, 'tier'));
  assert.deepEqual(readFields['judgments'], []);
  const genFields = decided.at(-1)!.fields as Record<string, any>;
  assert.deepEqual(
    ['decided_by', 'choice', 'tier', 'rule'].map((k) => genFields[k]),
    ['route', 'flash', 'flash', 'gen.child'],
  );
  assert.equal(genFields['facts'].length, 42);
  assert.ok(genFields['judgments'].every((j: any) => j.name.startsWith('route.')));
  const judgments = sink.records.filter((r) => r.kind === 'judgment');
  assert.deepEqual(
    judgments.map((r) => (r.fields as any).site),
    ['loop.route'],
  );
  assertNoCopiedText(
    [reads, gen, ...[...s.reads, s.gen].map((b) => journal.load(b.child_ref)), sink.records],
    CANARIES,
  );
  // An old checkpoint or decision schema is refused before any effect.
  for (const [patch, error] of [
    [{ schema: 'dispatch.checkpoint@4' }, /schema/],
    [{ child_terms: undefined }, /child_terms|schema|terms/],
  ] as const) {
    const h = harness(
      {},
      {
        journal: forged(journal, 'd1', (l) => ({ ...l, checkpoint: { ...l.checkpoint, ...patch }, decisions: [] })),
        spawn: confirmingSpawn,
      },
    );
    await assert.rejects(run(h, { ...rootRequest(), resume: true }), error);
    assert.equal(h.effects(), 0);
  }
  const old = forged(journal, s.reads[0]!.child_ref, (l) => {
    l.decisions[0].schema = 'dispatch.decision@5';
    return l;
  });
  await assert.rejects(run(harness({}, { journal: old }), childRequest(s.reads[0]!)), /schema/);
  // A transient pending decision can never be a saved decision.
  const saved = forged(journal, s.gen.child_ref, (l) => {
    l.decisions[0].reason = 'dependency_pending';
    return l;
  });
  await assert.rejects(run(harness({}, { journal: saved }), childRequest(s.gen)), /dependency_pending/);
  // Replay inputs are never mutated and need no port.
  const cp = journal.load(s.gen.child_ref).checkpoint!;
  const evidence = evidenceOf(journal, cp.child!);
  const before = structuredClone([cp, evidence]);
  transitionDispatch(childRequest(s.gen), cp, gen.receipt, gen.entry, evidence);
  assert.deepEqual([cp, evidence], before);
  // The stored trace is exactly the pure trace of the claimed checkpoint.
  const { table, ...trace } = decideBand(decide1Inputs(childRequest(s.gen), cp));
  assert.deepEqual([table, trace], [gen.rule_table, gen.decide1]);
});
