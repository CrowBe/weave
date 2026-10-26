import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationOutcome, InferenceGateway } from '@weave/gateway';
import {
  ROUTE_OUTCOMES,
  applyRoute,
  correctRoute,
  decideRoute,
  nextQueued,
  routeRule,
  transitionRoute,
  type RouteOutcome,
  type RouteRecord,
  type RouteRequest,
} from '../src/input-route.js';
import { SITE_POLICY, transitionSite, type SiteTransition } from '../src/sites/index.js';
import {
  emptyWorkstreamIndex,
  openWorkstream,
  transitionWorkstream,
  type Workstream,
  type WorkstreamEvent,
  type WorkstreamIndex,
} from '../src/workstream.js';

const RECORD_KEYS = ['schema', 'workstream_id', 'input_seq', 'decided_by', 'outcome', 'status', 'reason', 'site'];
const CORRECTION_KEYS = [
  'schema',
  'workstream_id',
  'input_seq',
  'routed_by',
  'routed',
  'corrected',
  'site_answer',
  'site_confidence',
  'site_top_p',
  'evidence',
];
const INPUT = 'please also cover the archive folder';
const SUMMARY = 'drafting the migration notes';
const terms = {
  quality: 'baseline' as const,
  destinations: ['local'],
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const now = { state_revision: 7, state_updated_at: 10 };
const ask = { request_id: 'route-1', ...now, terms, disclosed: { input: INPUT, summary: SUMMARY } };
const clock = () => ({ ...now, observed_at: 11 });

function answer(
  choice: string,
  confidence: number | undefined,
  extra: Record<string, unknown> = {},
): EvaluationOutcome<'choice'> {
  return {
    status: 'accepted',
    kind: 'choice',
    request_id: 'route-1',
    site: 'input.route',
    answers: { decision: { type: 'choice', choice, probabilities: { [choice]: 0.9 } } },
    confidence: confidence === undefined ? undefined : { decision: confidence },
    routed_unit_id: 'fixture',
    provider_response_id: 'provider-1',
    attempts: [],
    spent: 0,
    uncertainty: [],
    ...extra,
  } as EvaluationOutcome<'choice'>;
}
function port(reply: () => Promise<EvaluationOutcome<'choice'> | never>) {
  const calls: unknown[] = [];
  const fake = {
    evaluate: async (request: unknown) => {
      calls.push(request);
      return reply();
    },
  } as unknown as Pick<InferenceGateway, 'evaluate'>;
  return { fake, calls };
}
function step(index: WorkstreamIndex, id: string, event: WorkstreamEvent): WorkstreamIndex {
  const result = transitionWorkstream(index, id, event);
  if (!result.ok) assert.fail(`refused: ${result.reason}`);
  return result.index;
}
function stream(index: WorkstreamIndex, id: string): Workstream {
  return index.workstreams.find((item) => item.workstream_id === id)!;
}
/** ws-a has goal g-1 and a running process; input 20 has arrived. ws-b is idle with no goal. */
function busy(): WorkstreamIndex {
  let index = emptyWorkstreamIndex('proj-1');
  for (const [id, seq] of [
    ['ws-a', 1],
    ['ws-b', 2],
  ] as const) {
    const opened = openWorkstream(index, { workstream_id: id, origin: 'operator', evidence: seq });
    assert.ok(opened.ok);
    if (opened.ok) index = opened.index;
  }
  index = step(index, 'ws-a', { type: 'goal.attached', goal_id: 'g-1', evidence: 3 });
  index = step(index, 'ws-a', { type: 'process.opened', process_id: 'proc-a', evidence: 4 });
  index = step(index, 'ws-a', { type: 'process.transition', event: { type: 'started', evidence: 5 } });
  index = step(index, 'ws-a', { type: 'input.recorded', seq: 20 });
  return step(index, 'ws-b', { type: 'input.recorded', seq: 21 });
}
function request(index: WorkstreamIndex, direction: RouteOutcome | null = null, id = 'ws-a'): RouteRequest {
  return { workstream: stream(index, id), input_seq: id === 'ws-a' ? 20 : 21, direction };
}
async function routed(index: WorkstreamIndex, choice: RouteOutcome): Promise<RouteRecord> {
  const { fake } = port(async () => answer(choice, 0.9));
  return decideRoute(request(index), ask, fake, clock);
}
function applied(
  index: WorkstreamIndex,
  record: RouteRecord,
  evidence = 30,
  new_workstream_id?: string,
): WorkstreamIndex {
  const result = applyRoute(index, record, { evidence, ...(new_workstream_id ? { new_workstream_id } : {}) });
  if (!result.ok) assert.fail(`refused: ${result.reason}`);
  return result.index;
}

test('input.route is a choice site over the five outcomes with an ask_user fallback', () => {
  assert.deepEqual([...ROUTE_OUTCOMES], ['conversation', 'steer', 'interrupt', 'parallel', 'queue']);
  assert.deepEqual([...SITE_POLICY['input.route'].options], [...ROUTE_OUTCOMES]);
  assert.equal(SITE_POLICY['input.route'].confidence, 0.8);
  assert.equal(SITE_POLICY['input.route'].fallback, 'ask_user');
  const input = {
    request_id: 'route-1',
    ...now,
    terms,
    needs_dispatch: false,
    state: { input: INPUT, active_work: { summary: SUMMARY, process: 'running' as const } },
  };
  for (const choice of ROUTE_OUTCOMES) {
    assert.equal(
      transitionSite('input.route', input, { state_revision: 7, observed_at: 11, outcome: answer(choice, 0.8) }, now)
        .choice,
      choice,
    );
  }
  const low = transitionSite(
    'input.route',
    input,
    { state_revision: 7, observed_at: 11, outcome: answer('steer', 0.79) },
    now,
  );
  assert.equal(low.choice, 'ask_user');
  assert.equal(low.status, 'needs_human');
  transitionSite(
    'input.route',
    // @ts-expect-error input.route takes RouteState, not arbitrary evaluation content
    { ...input, state: 'raw text' },
    { state_revision: 7, observed_at: 11, outcome: null },
    now,
  );
});

test('explicit operator direction wins over inference and never reaches the site', async () => {
  const index = busy();
  for (const direction of ROUTE_OUTCOMES) {
    const { fake, calls } = port(async () => answer('conversation', 1));
    const record = await decideRoute(request(index, direction), ask, fake, clock);
    assert.equal(calls.length, 0, `${direction} reached the site`);
    assert.deepEqual(Object.keys(record), RECORD_KEYS);
    assert.deepEqual(record, {
      schema: 'input.route@1',
      workstream_id: 'ws-a',
      input_seq: 20,
      decided_by: 'operator',
      outcome: direction,
      status: 'transition',
      reason: 'operator_direction',
      site: null,
    });
  }
  // A direction that cannot apply asks the operator again; it still never reaches the site.
  for (const [id, direction] of [
    ['ws-b', 'steer'],
    ['ws-b', 'interrupt'],
    ['ws-b', 'queue'],
    ['ws-a', 'stop'],
  ] as const) {
    const { fake, calls } = port(async () => answer('conversation', 1));
    const record = await decideRoute(request(index, direction as RouteOutcome, id), ask, fake, clock);
    assert.equal(calls.length, 0);
    assert.equal(record.status, 'needs_human');
    assert.equal(record.outcome, null);
    assert.equal(record.reason, 'invalid_direction');
  }
});

test('with no active work the rule decides conversation without asking', async () => {
  const { fake, calls } = port(async () => answer('interrupt', 1));
  const record = await decideRoute(request(busy(), null, 'ws-b'), ask, fake, clock);
  assert.equal(calls.length, 0);
  assert.deepEqual(record, {
    schema: 'input.route@1',
    workstream_id: 'ws-b',
    input_seq: 21,
    decided_by: 'rule',
    outcome: 'conversation',
    status: 'transition',
    reason: 'no_active_work',
    site: null,
  });
  assert.deepEqual(routeRule(request(busy(), null, 'ws-b')), record);
  assert.equal(routeRule(request(busy())), null, 'active work needs the site');
});

test('the site sees only the disclosed input, summary and process state; the record copies neither text', async () => {
  const { fake, calls } = port(async () => answer('steer', 0.9));
  const record = await decideRoute(request(busy()), ask, fake, clock);
  assert.equal(calls.length, 1);
  const sent = calls[0] as { site: string; state: unknown; questions: Record<string, unknown> };
  assert.equal(sent.site, 'input.route');
  assert.deepEqual(sent.state, { input: INPUT, active_work: { summary: SUMMARY, process: 'running' } });
  assert.deepEqual(Object.keys(sent.questions), ['decision']);
  assert.equal(record.decided_by, 'site');
  assert.equal(record.outcome, 'steer');
  assert.equal(record.status, 'transition');
  assert.equal(record.reason, 'accepted');
  assert.equal(record.site?.site, 'input.route');
  assert.deepEqual(Object.keys(record), RECORD_KEYS);
  const text = JSON.stringify(record);
  assert.ok(!text.includes('archive') && !text.includes('migration'));
});

test('fallback, outage and staleness ask the operator; cancellation pauses; none places the input', async () => {
  const cases: [string, () => Promise<EvaluationOutcome<'choice'>>, 'needs_human' | 'paused'][] = [
    ['low confidence', async () => answer('steer', 0.5), 'needs_human'],
    ['missing confidence', async () => answer('steer', undefined), 'needs_human'],
    ['invalid option', async () => answer('stop', 1), 'needs_human'],
    [
      'thrown port',
      async () => {
        throw new Error('sk-secret unavailable');
      },
      'needs_human',
    ],
    [
      'provider unavailable',
      async () =>
        ({
          status: 'blocked',
          request_id: 'route-1',
          site: 'input.route',
          reason: 'provider_unavailable',
          attempts: [],
          spent: 0,
          uncertainty: [],
        }) as unknown as EvaluationOutcome<'choice'>,
      'needs_human',
    ],
  ];
  for (const [name, reply, status] of cases) {
    const { fake } = port(reply);
    const record = await decideRoute(request(busy()), ask, fake, clock);
    assert.equal(record.status, status, name);
    assert.equal(record.outcome, null, name);
    assert.equal(record.decided_by, 'site', name);
    assert.ok(!JSON.stringify(record).includes('sk-secret'));
    const result = applyRoute(busy(), record, { evidence: 30 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'no_route');
  }
  const stale = await decideRoute(request(busy()), ask, port(async () => answer('steer', 1)).fake, () => ({
    state_revision: 8,
    state_updated_at: 12,
    observed_at: 13,
  }));
  assert.equal(stale.reason, 'stale_answer');
  assert.equal(stale.status, 'needs_human');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await decideRoute(
    request(busy()),
    ask,
    port(async () => answer('steer', 1)).fake,
    clock,
    controller.signal,
  );
  assert.equal(cancelled.status, 'paused');
  assert.equal(cancelled.outcome, null);
});

test('replay rebuilds the record from the recorded site transition without a provider', async () => {
  const { fake } = port(async () => answer('queue', 0.95));
  const live = await decideRoute(request(busy()), ask, fake, clock);
  const recorded = transitionSite(
    'input.route',
    {
      request_id: 'route-1',
      ...now,
      terms,
      needs_dispatch: false,
      state: { input: INPUT, active_work: { summary: SUMMARY, process: 'running' } },
    },
    { state_revision: 7, observed_at: 11, outcome: answer('queue', 0.95) },
    now,
  );
  const replayed = transitionRoute(request(busy()), JSON.parse(JSON.stringify(recorded)) as SiteTransition);
  assert.equal(JSON.stringify(replayed), JSON.stringify(live));
  assert.throws(() => transitionRoute(request(busy()), null), /input\.route/);
});

test('conversation and steer place the input and change no work', async () => {
  for (const choice of ['conversation', 'steer'] as const) {
    const before = busy();
    const index = applied(before, await routed(before, choice));
    const a = stream(index, 'ws-a');
    assert.deepEqual(a.inputs, [
      { seq: 20, route: choice, decided_by: 'site', routed_at: 30, target: null, held: false },
    ]);
    assert.deepEqual(a.process, stream(before, 'ws-a').process);
    assert.deepEqual(a.goals, stream(before, 'ws-a').goals);
    assert.equal(stream(index, 'ws-b'), stream(before, 'ws-b'));
  }
});

test('interrupt requests a pause at the next boundary and never stops work', async () => {
  const before = busy();
  const index = applied(before, await routed(before, 'interrupt'));
  const process = stream(index, 'ws-a').process!;
  assert.equal(process.state, 'running', 'work in flight reaches its boundary first');
  assert.equal(process.pause_requested, 30);
  assert.equal(process.stop_requested, null);
  // Already paused: the interrupt is placed and the process is left alone.
  let paused = step(before, 'ws-a', { type: 'process.transition', event: { type: 'pause_requested', evidence: 22 } });
  paused = step(paused, 'ws-a', {
    type: 'process.transition',
    event: { type: 'paused', resume_point: { ref: 'snap-1', digest: 'a'.repeat(64) }, evidence: 23 },
  });
  const again = applied(paused, await routed(paused, 'interrupt'));
  assert.deepEqual(stream(again, 'ws-a').process, stream(paused, 'ws-a').process);
  assert.equal(stream(again, 'ws-a').inputs[0]!.route, 'interrupt');
});

test('parallel opens an empty workstream for the input and dispatches nothing there', async () => {
  const before = busy();
  const record = await routed(before, 'parallel');
  const missing = applyRoute(before, record, { evidence: 30 });
  assert.equal(missing.ok, false);
  const index = applied(before, record, 30, 'ws-c');
  const opened = stream(index, 'ws-c');
  assert.equal(opened.origin, 'route');
  assert.equal(opened.opened_at, 30);
  assert.deepEqual(opened.goals, []);
  assert.equal(opened.process, null);
  assert.deepEqual(opened.inputs, [
    { seq: 20, route: 'conversation', decided_by: 'rule', routed_at: 30, target: null, held: false },
  ]);
  assert.deepEqual(stream(index, 'ws-a').inputs, [
    { seq: 20, route: 'parallel', decided_by: 'site', routed_at: 30, target: 'ws-c', held: false },
  ]);
  assert.deepEqual(stream(index, 'ws-a').process, stream(before, 'ws-a').process);
});

test('queue holds input until the current goal ends, then offers it oldest first', async () => {
  let index = busy();
  index = applied(index, await routed(index, 'queue'), 30);
  index = step(index, 'ws-a', { type: 'input.recorded', seq: 31 });
  index = applied(index, { ...(await routed(index, 'queue')), input_seq: 31 }, 32);
  assert.equal(nextQueued(stream(index, 'ws-a')), null, 'nothing is offered while the goal is active');
  index = step(index, 'ws-a', { type: 'process.transition', event: { type: 'yielded', evidence: 33 } });
  index = step(index, 'ws-a', { type: 'goal.ended', goal_id: 'g-1', evidence: 34 });
  assert.equal(nextQueued(stream(index, 'ws-a')), 20);
  const early = transitionWorkstream(index, 'ws-a', { type: 'input.released', seq: 31, evidence: 35 });
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.reason, 'not_next');
  index = step(index, 'ws-a', { type: 'input.released', seq: 20, evidence: 35 });
  assert.equal(nextQueued(stream(index, 'ws-a')), 31);
  assert.equal(stream(index, 'ws-a').process?.state, 'idle', 'releasing dispatches nothing');
});

test('a routing answer cannot dispatch work, create a grant, or widen disclosure', async () => {
  const forbidden = /grant|approval|scope|slice|disclos|authority|budget|reservation/;
  for (const choice of ROUTE_OUTCOMES) {
    // Start from an idle process so that any dispatch would show as a state change to running.
    const before = step(busy(), 'ws-a', { type: 'process.transition', event: { type: 'yielded', evidence: 6 } });
    const clean = await routed(before, choice);
    const junk = { grant: { effects: ['write', 'delete'] }, scope: 'everything', disclosure: 'all', approval: true };
    const { fake } = port(async () =>
      answer(choice, 0.9, {
        ...junk,
        answers: {
          decision: { type: 'choice', choice, probabilities: { [choice]: 0.9 }, ...junk },
          other: { type: 'choice', choice: 'grant' },
        },
      }),
    );
    const noisy = await decideRoute(request(before), ask, fake, clock);
    assert.deepEqual(noisy, clean, `${choice}: extra provider fields change nothing`);
    for (const key of Object.keys(noisy)) assert.doesNotMatch(key, forbidden);
    const index = applied(before, noisy, 30, 'ws-c');
    assert.deepEqual(index, applied(before, clean, 30, 'ws-c'));
    for (const workstream of index.workstreams) {
      const prior = before.workstreams.find((item) => item.workstream_id === workstream.workstream_id);
      assert.deepEqual(workstream.goals, prior?.goals ?? [], `${choice} attached no goal`);
      assert.notEqual(workstream.process?.state, 'running', `${choice} dispatched no work`);
      assert.equal(
        workstream.process?.process_id ?? null,
        prior?.process?.process_id ?? null,
        `${choice} opened no process`,
      );
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value !== null && typeof value === 'object') {
          for (const [key, inner] of Object.entries(value)) {
            assert.doesNotMatch(key, forbidden);
            walk(inner);
          }
        }
      };
      walk(workstream);
    }
  }
});

test('an operator correction is evaluation evidence and re-places the input', async () => {
  const before = busy();
  const record = await routed(before, 'interrupt');
  let index = applied(before, record, 30);
  const result = correctRoute(index, record, 'steer', { evidence: 40 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.correction), CORRECTION_KEYS);
  assert.deepEqual(result.correction, {
    schema: 'input.route.correction@1',
    workstream_id: 'ws-a',
    input_seq: 20,
    routed_by: 'site',
    routed: 'interrupt',
    corrected: 'steer',
    site_answer: 'interrupt',
    site_confidence: 0.9,
    site_top_p: 0.9,
    evidence: 40,
  });
  assert.equal(result.record.decided_by, 'operator');
  index = result.index;
  assert.equal(stream(index, 'ws-a').process?.pause_requested, null, 'the unhonoured pause request is withdrawn');
  assert.deepEqual(stream(index, 'ws-a').inputs[0], {
    seq: 20,
    route: 'steer',
    decided_by: 'operator',
    routed_at: 40,
    target: null,
    held: false,
  });
  const stale = correctRoute(index, record, 'queue', { evidence: 41 });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, 'stale_record');
  const same = correctRoute(index, result.record, 'steer', { evidence: 41 });
  assert.equal(same.ok, false);
  if (!same.ok) assert.equal(same.reason, 'unchanged');
});

test('correcting one of two pending interrupts keeps the pause the other still needs', async () => {
  const before = step(busy(), 'ws-a', { type: 'input.recorded', seq: 22 });
  const first = await routed(before, 'interrupt');
  let index = applied(before, first, 30);
  const second = routeRule({ workstream: stream(index, 'ws-a'), input_seq: 22, direction: 'interrupt' })!;
  index = applied(index, second, 31);
  assert.equal(stream(index, 'ws-a').process?.pause_requested, 30, 'one request serves both interrupts');
  const corrected = correctRoute(index, first, 'conversation', { evidence: 40 });
  assert.ok(corrected.ok);
  if (!corrected.ok) return;
  index = corrected.index;
  assert.equal(stream(index, 'ws-a').process?.pause_requested, 31, 'the request passes to the remaining interrupt');
  const last = correctRoute(index, second, 'conversation', { evidence: 41 });
  assert.ok(last.ok);
  if (last.ok) assert.equal(stream(last.index, 'ws-a').process?.pause_requested, null, 'no interrupt remains');
});

test('an interrupt can be corrected after the process completed or stopped before honouring it', async () => {
  const before = busy();
  const interrupt = await routed(before, 'interrupt');
  const pending = applied(before, interrupt, 30);
  const completed = step(pending, 'ws-a', { type: 'process.transition', event: { type: 'completed', evidence: 31 } });
  let stopped = step(pending, 'ws-a', { type: 'process.transition', event: { type: 'stop_requested', evidence: 31 } });
  stopped = step(stopped, 'ws-a', {
    type: 'process.transition',
    event: { type: 'stopped', reason: 'requested', evidence: 32 },
  });
  for (const [index, state] of [
    [completed, 'complete'],
    [stopped, 'stopped'],
  ] as const) {
    const corrected = correctRoute(index, interrupt, 'conversation', { evidence: 40 });
    assert.ok(corrected.ok, state);
    if (!corrected.ok) continue;
    assert.equal(stream(corrected.index, 'ws-a').process?.state, state, 'a terminal process is left alone');
    assert.equal(stream(corrected.index, 'ws-a').inputs[0]!.route, 'conversation');
  }
});

test('corrections keep honoured pauses and opened workstreams, drop holds, and label unrouted input', async () => {
  // A pause the provider already honoured stays paused.
  const before = busy();
  const interrupt = await routed(before, 'interrupt');
  let index = applied(before, interrupt, 30);
  index = step(index, 'ws-a', {
    type: 'process.transition',
    event: { type: 'paused', resume_point: { ref: 'snap-1', digest: 'a'.repeat(64) }, evidence: 31 },
  });
  const kept = correctRoute(index, interrupt, 'conversation', { evidence: 40 });
  assert.ok(kept.ok);
  if (kept.ok) assert.equal(stream(kept.index, 'ws-a').process?.state, 'paused');
  // A held queue placement stops being held.
  const queued = await routed(before, 'queue');
  const dropped = correctRoute(applied(before, queued, 30), queued, 'steer', { evidence: 40 });
  assert.ok(dropped.ok);
  if (dropped.ok) assert.equal(stream(dropped.index, 'ws-a').inputs[0]!.held, false);
  // The workstream parallel opened stays, inert.
  const parallel = await routed(before, 'parallel');
  const back = correctRoute(applied(before, parallel, 30, 'ws-c'), parallel, 'conversation', { evidence: 40 });
  assert.ok(back.ok);
  if (back.ok) {
    assert.equal(stream(back.index, 'ws-c').process, null);
    assert.deepEqual(stream(back.index, 'ws-c').goals, []);
    assert.equal(stream(back.index, 'ws-a').inputs[0]!.route, 'conversation');
  }
  // The operator answering a fallback is recorded with no routed outcome.
  const fallback = await decideRoute(request(before), ask, port(async () => answer('steer', 0.2)).fake, clock);
  const answered = correctRoute(before, fallback, 'queue', { evidence: 40 });
  assert.ok(answered.ok);
  if (answered.ok) {
    assert.equal(answered.correction.routed, null);
    assert.equal(answered.correction.site_answer, 'steer');
    assert.equal(answered.correction.site_confidence, 0.2);
    assert.equal(stream(answered.index, 'ws-a').inputs[0]!.route, 'queue');
  }
  const invalid = correctRoute(before, fallback, 'stop' as RouteOutcome, { evidence: 40 });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.reason, 'invalid_direction');
});
