import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationOutcome, InferenceGateway } from '@weave/gateway';
import { createGrantAuthority, type Grant } from '@weave/agentsop';
import { AgentFabricHost, SOURCE_INSPECT } from '@weave/agentfabric';
import { renderFrameView } from '../src/views.js';
import { scenario } from './fixture.js';
import {
  transitionBooleanSite,
  evaluateBooleanSite,
  INPUT_RULES,
  type BooleanTransition,
} from '../src/sites/boolean.js';
import { transitionSite } from '../src/sites/index.js';
const current = { state_revision: 1, state_updated_at: 10 };
const input = {
  ...current,
  request_id: 'r1',
  state: { text: 'CANARY_SECRET' },
  needs_dispatch: true,
  terms: {
    quality: 'baseline' as const,
    destinations: ['local'],
    max_context_tokens: 100,
    deadline: 100,
    cost_ceiling: 10,
    max_attempts: 1,
  },
  catalogue_index: Array.from({ length: 12 }, (_, n) => ({
    id: `op${n}`,
    purpose: 'disclosed',
    input: { secret: 'SCHEMA_SECRET' },
  })),
};
function recorded(site: string, keys: readonly string[], p = 0.29, confidence?: number) {
  if (arguments.length < 4) confidence = 1;
  const outcome: EvaluationOutcome<'boolean'> = {
    status: 'accepted',
    kind: 'boolean',
    site,
    request_id: 'r1',
    answers: Object.fromEntries(keys.map((key) => [key, { type: 'boolean' as const, probability: p }])),
    confidence: confidence === undefined ? undefined : Object.fromEntries(keys.map((key) => [key, confidence])),
    provider_response_id: 'provider-1',
    routed_unit_id: 'fixture',
    attempts: [],
    spent: 0,
    uncertainty: [],
  };
  return { state_revision: 1, observed_at: 10, outcome };
}
const entries = input.catalogue_index.map((_, i) => `entry_${i}`);
test('D3 narrows only the disclosed index, keeps the default top three on ties, ignores and records unknown answers', () => {
  const r = recorded('loop.preselect', [...entries, 'CANARY_UNKNOWN'], 0.1);
  assert.equal(r.outcome.status, 'accepted');
  const answers = {
    ...r.outcome.answers,
    entry_0: { type: 'boolean' as const, probability: 0.9 },
    entry_1: { type: 'boolean' as const, probability: 0.9 },
    entry_2: { type: 'boolean' as const, probability: 0.9 },
  };
  r.outcome = { ...r.outcome, answers };
  const result = transitionBooleanSite('loop.preselect', input, r, current);
  assert.deepEqual(
    result.catalogue_index.map((x) => x.id),
    input.catalogue_index.slice(0, 3).map((x) => x.id),
  );
  assert.equal(result.observations.at(-1)?.reason, 'unknown_answer');
  assert.ok(!JSON.stringify(result).includes('SCHEMA_SECRET'));
  assert.ok(!JSON.stringify(result.observations).includes('CANARY'));
  assert.deepEqual(result, transitionBooleanSite('loop.preselect', input, JSON.parse(JSON.stringify(r)), current));
});
for (const site of ['guard.input', 'guard.output'] as const) {
  const keys = site === 'guard.input' ? INPUT_RULES : ['decision'];
  test(`${site} .29 passes, .30 requests approval, deterministic grants remain required`, () => {
    const pass = transitionBooleanSite(site, input, recorded(site, keys), current);
    assert.equal(pass.status, 'transition');
    const blocked = transitionBooleanSite(site, input, recorded(site, keys, 0.3), current);
    assert.equal(blocked.status, 'needs_human');
    // Approval requests name the rule, not the wire question id (#98).
    assert.deepEqual(
      blocked.approval_requests.map((request) => request.rule),
      site === 'guard.input' ? [...INPUT_RULES] : ['out_of_grant_effect'],
    );
    assert.ok(blocked.approval_requests.every((request) => request.reason === 'violation'));
    // A guard transition has a closed shape: nothing in it can serve as a grant.
    assert.deepEqual(Object.keys(pass), ['status', 'catalogue_index', 'approval_requests', 'observations']);
  });
  test(`${site} rejects uncertainty, malformed, stale, mismatched, refusal and outage`, () => {
    const good = recorded(site, keys);
    const failures = [
      recorded(site, keys, 0.1, 0.89),
      recorded(site, keys, 0.1, undefined),
      { ...good, observed_at: 9 },
      { ...good, state_revision: 0 },
      { ...good, outcome: { ...good.outcome, site: 'other' } },
      { ...good, outcome: { ...good.outcome, answers: {} } },
      {
        ...good,
        outcome: {
          ...good.outcome,
          answers: Object.fromEntries(keys.map((k) => [k, { type: 'boolean', probability: NaN }])),
        },
      },
      { ...good, outcome: null },
      {
        ...good,
        outcome: {
          status: 'blocked',
          site,
          request_id: 'r1',
          reason: 'provider_unavailable',
          attempts: [],
          spent: 0,
          uncertainty: [],
        },
      },
      {
        ...good,
        outcome: {
          status: 'unaccepted',
          site,
          request_id: 'r1',
          reason: 'provider_failed',
          attempts: [],
          spent: 0,
          uncertainty: [],
        },
      },
    ];
    for (const failure of failures) {
      const result = transitionBooleanSite(site, input, failure as typeof good, current);
      assert.equal(result.status, 'needs_human');
      assert.ok(result.approval_requests.length > 0);
      assert.ok(!JSON.stringify(result.observations).includes('CANARY_SECRET'));
    }
    const result = transitionBooleanSite(site, input, good, current);
    assert.deepEqual(Object.keys(result.observations[0]!), [
      'schema',
      'site',
      'question',
      'request_id',
      'state_revision',
      'answer',
      'confidence',
      'top_p',
      'accepted',
      'fallback_used',
      'reason',
      'provider_request_id',
    ]);
    assert.equal(result.observations[0]?.provider_request_id, 'provider-1');
    assert.deepEqual(result, transitionBooleanSite(site, input, JSON.parse(JSON.stringify(good)), current));
  });
}
// #100: P5 choice sites pause dispatch-dependent work on an outage; D4/D7 request approval. Intentional:
// a P5 outage is a missing observation with a deterministic fallback, a guard outage is an open authority question.
test('one decision outage: P5 pauses dispatch, guards request approval, D3 widens', () => {
  const outage = {
    status: 'blocked' as const,
    request_id: 'r1',
    reason: 'provider_unavailable' as const,
    attempts: [],
    spent: 0,
    uncertainty: [],
  };
  for (const needs_dispatch of [true, false]) {
    for (const [site, fallback] of [
      ['loop.triage', 'implement'],
      ['loop.route', 'standard'],
      ['loop.continue', 'stalled'],
      ['intake.classify', 'ask_user'],
    ] as const) {
      const choice = transitionSite(
        site,
        { ...input, needs_dispatch, state: { message: 'm', running_threads: [] } },
        { state_revision: 1, observed_at: 10, outcome: { ...outage, site } },
        current,
      );
      assert.equal(choice.choice, fallback);
      assert.equal(choice.observation.reason, 'decision_unavailable');
      assert.equal(
        choice.status,
        needs_dispatch ? 'paused' : site === 'intake.classify' ? 'needs_human' : 'transition',
      );
    }
    for (const site of ['guard.input', 'guard.output'] as const) {
      const guard = transitionBooleanSite(
        site,
        { ...input, needs_dispatch },
        { state_revision: 1, observed_at: 10, outcome: { ...outage, site } },
        current,
      );
      assert.equal(guard.status, 'needs_human');
      assert.deepEqual(
        guard.approval_requests.map((request) => request.reason),
        (site === 'guard.input' ? INPUT_RULES : ['out_of_grant_effect']).map(() => 'decision_unavailable'),
      );
    }
    const preselect = transitionBooleanSite(
      'loop.preselect',
      { ...input, needs_dispatch },
      { state_revision: 1, observed_at: 10, outcome: { ...outage, site: 'loop.preselect' } },
      current,
    );
    assert.equal(preselect.status, 'transition');
    assert.equal(preselect.preselect?.reason, 'admission');
    assert.equal(preselect.catalogue_index.length, input.catalogue_index.length);
  }
});

test('D3 admission failures return the full index without schemas', () => {
  const good = recorded('loop.preselect', entries, 0.1);
  assert.equal(good.outcome.status, 'accepted');
  const answers = {
    ...good.outcome.answers,
    entry_0: { type: 'boolean' as const, probability: 0.9 },
    entry_1: { type: 'boolean' as const, probability: 0.9 },
    entry_2: { type: 'boolean' as const, probability: 0.9 },
  };
  const healthy = { ...good, outcome: { ...good.outcome, answers } };
  assert.deepEqual(
    transitionBooleanSite('loop.preselect', input, healthy, current).catalogue_index.map((entry) => entry.id),
    ['op0', 'op1', 'op2'],
  );
  for (const r of [
    { ...healthy, observed_at: 9 },
    { ...healthy, outcome: null },
    { ...healthy, outcome: { ...healthy.outcome, answers: {} } },
  ]) {
    const result = transitionBooleanSite('loop.preselect', input, r, current);
    assert.deepEqual(
      result.catalogue_index,
      input.catalogue_index.map(({ id, purpose }) => ({ id, purpose })),
    );
    assert.equal(result.preselect?.reason, 'admission');
  }
});
test('evaluate uses site semantics once, handles thrown secrets and in-flight revision changes', async () => {
  for (const site of ['loop.preselect', 'guard.input', 'guard.output'] as const) {
    let calls = 0;
    const port = {
      evaluate: async (request: { site: string; state: unknown; kind: string; questions: Record<string, unknown> }) => {
        calls++;
        assert.equal(request.site, site);
        assert.equal(request.kind, 'boolean');
        if (site === 'loop.preselect') assert.ok(!JSON.stringify(request).includes('SCHEMA_SECRET'));
        // D4/D7 judge only the caller's disclosed state; the site injects no grant or scope (#99).
        else assert.deepEqual(request.state, input.state);
        // D7 keeps its wire question id; only the approval rule is named out_of_grant_effect (#98).
        if (site === 'guard.output') assert.deepEqual(Object.keys(request.questions), ['decision']);
        throw new Error('CANARY_SECRET');
      },
    } as unknown as Pick<InferenceGateway, 'evaluate'>;
    const result = await evaluateBooleanSite(site, input, port, () => ({ ...current, observed_at: 10 }));
    assert.equal(calls, 1);
    assert.equal(result.status, site === 'loop.preselect' ? 'transition' : 'needs_human');
    assert.ok(!JSON.stringify(result.observations).includes('CANARY'));
  }
});

// #97: the guards are not wired into the loop yet, so this feeds the clean D7 transition into the Fabric
// call the way a wired dispatch would: D7 gates whether to call, Fabric decides what the grant reaches.
test('D7 clean observation cannot bypass Fabric denial for a widened resource', async () => {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({ authority });
  const alpha = host.registerSource('mem:alpha', 'a');
  const gamma = host.registerSource('mem:gamma', 'g');
  const issue = (action_id: string): Grant =>
    authority.issue({
      action_id,
      operation: SOURCE_INSPECT.id,
      contract_rev: SOURCE_INSPECT.revision,
      permissions: [{ resource: alpha, mode: 'read' }],
      effects: [{ resource: alpha, mode: 'read' }],
      issued_at: 1,
    });
  const clean = transitionBooleanSite('guard.output', input, recorded('guard.output', ['decision']), current);
  assert.equal(clean.status, 'transition');
  const dispatch = (d7: BooleanTransition, grant: Grant | null, source: string) => {
    assert.equal(d7.status, 'transition', 'only a clean D7 reaches the Fabric call');
    return host.invoke(grant, SOURCE_INSPECT.id, { source });
  };
  const held = issue('a:1:1');
  const widened = {
    ...held,
    permissions: [{ resource: gamma, mode: 'read' as const }],
    effects: [{ resource: gamma, mode: 'read' as const }],
  };
  // Nothing D7 returns is a grant, and a widened copy of an issued grant was never issued.
  for (const [grant, source] of [
    [clean, gamma],
    [clean.observations[0], gamma],
    [null, gamma],
    [widened, gamma],
    [held, gamma],
  ] as const) {
    const denied = dispatch(clean, grant as unknown as Grant | null, source);
    assert.equal(denied.kind, 'rejected');
    assert.equal((denied as { code: string }).code, 'DENIED');
  }
  assert.equal(host.resourceAccesses.length, 0);
  // The same clean D7 with the issued grant on its own resource runs, so the denials above are Fabric's.
  const allowed = dispatch(clean, held, alpha);
  assert.equal(allowed.kind, 'handle');
  if (allowed.kind !== 'handle') return;
  host.release(allowed.action_id);
  assert.equal((await allowed.result).outcome, 'succeeded');
  assert.deepEqual(
    host.resourceAccesses.map((access) => access.handle),
    [alpha],
  );
});

test('D3 consumes the budgeted M6 index rather than the registry or schema slice', () => {
  const state = scenario().runtime.state();
  const frame = renderFrameView(
    state,
    input.catalogue_index.map((entry) => ({ ...entry, input: { token: 'SCHEMA_SECRET' } })),
    { id: 'p6-index', version: 1, catalogue_budget: 3, schema_for: ['op0'] },
  );
  const content = frame.content as { catalogue_index: { id: string; purpose: string }[] };
  const bounded = { ...input, catalogue_index: content.catalogue_index };
  const r = recorded('loop.preselect', ['entry_0', 'entry_1', 'entry_2', 'op9'], 1);
  const narrowed = transitionBooleanSite('loop.preselect', bounded, r, current);
  assert.deepEqual(narrowed.catalogue_index, content.catalogue_index);
  assert.equal(narrowed.observations.at(-1)?.reason, 'unknown_answer');
  const fallback = transitionBooleanSite('loop.preselect', bounded, { ...r, outcome: null }, current);
  assert.deepEqual(fallback.catalogue_index, content.catalogue_index);
  assert.ok(!JSON.stringify(fallback).includes('SCHEMA_SECRET'));
});

test('D3 ranks probabilities descending and keeps a .49 entry that falls inside the default top k', () => {
  const r = recorded('loop.preselect', entries, 0.1, 0.75);
  assert.equal(r.outcome.status, 'accepted');
  const answers = {
    ...r.outcome.answers,
    entry_0: { type: 'boolean' as const, probability: 0.49 },
    entry_2: { type: 'boolean' as const, probability: 0.5 },
    entry_4: { type: 'boolean' as const, probability: 0.9 },
  };
  r.outcome = { ...r.outcome, answers };
  // op0 is p .49 and is the third place after the two higher scores. The old .5 rule dropped it.
  assert.deepEqual(
    transitionBooleanSite('loop.preselect', input, r, current).catalogue_index.map((e) => e.id),
    ['op4', 'op2', 'op0'],
  );
});

test('all boolean sites capture revisions and reject changes in flight; cancellation never passes a guard', async () => {
  for (const site of ['loop.preselect', 'guard.input', 'guard.output'] as const) {
    const keys = site === 'loop.preselect' ? entries : site === 'guard.input' ? INPUT_RULES : ['decision'];
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let now = { ...current, observed_at: 10 };
      const mutable = { ...input };
      const port = {
        evaluate: async () => {
          mutable.state_revision = 2;
          if (cancel) controller.abort();
          else now = { state_revision: 2, state_updated_at: 11, observed_at: 11 };
          return recorded(site, keys).outcome;
        },
      } as Pick<InferenceGateway, 'evaluate'>;
      const result = await evaluateBooleanSite(site, mutable, port, () => now, controller.signal);
      assert.equal(result.observations[0]?.reason, cancel ? 'cancelled' : 'stale_answer');
      assert.equal(result.status, site === 'loop.preselect' ? (cancel ? 'paused' : 'transition') : 'needs_human');
    }
    const controller = new AbortController();
    controller.abort();
    const result = await evaluateBooleanSite(
      site,
      input,
      { evaluate: async () => assert.fail('cancelled call') },
      () => ({ ...current, observed_at: 10 }),
      controller.signal,
    );
    assert.ok(result.observations.every((o) => !o.accepted));
  }
});

test('empty disclosed index records evidence without calling evaluate', async () => {
  const result = await evaluateBooleanSite(
    'loop.preselect',
    { ...input, catalogue_index: [] },
    { evaluate: async () => assert.fail('empty index needs no decision') },
    () => ({ ...current, observed_at: 10 }),
  );
  assert.deepEqual(result.catalogue_index, []);
  assert.equal(result.observations[0]?.reason, 'empty_index');
});

test('guard confidence threshold is inclusive and malformed shapes/statistics never pass', () => {
  for (const site of ['guard.input', 'guard.output'] as const) {
    const keys = site === 'guard.input' ? INPUT_RULES : ['decision'];
    const r = recorded(site, keys, 0.29, 0.9);
    assert.equal(transitionBooleanSite(site, input, r, current).status, 'transition');
    assert.equal(r.outcome.status, 'accepted');
    for (const malformed of [
      { type: 'choice', choice: 'clean' },
      { type: 'boolean', probability: -1 },
      { type: 'boolean', probability: 1.1 },
      { type: 'boolean', probability: '0' },
    ]) {
      const bad = { ...r, outcome: { ...r.outcome, answers: { ...r.outcome.answers, [keys[0]!]: malformed } } };
      assert.equal(transitionBooleanSite(site, input, bad as typeof r, current).status, 'needs_human');
    }
    for (const conf of [-1, 1.1, NaN, Infinity]) {
      const result = transitionBooleanSite(site, input, recorded(site, keys, 0.1, conf), current);
      assert.equal(result.status, 'needs_human');
      assert.ok(
        result.observations.every(
          (observation) => observation.reason === 'missing_confidence' && observation.confidence === null,
        ),
      );
    }
  }
});

test('an evaluate port cannot widen the captured D3 index', async () => {
  const port = {
    evaluate: async (request: { state: { catalogue_index: unknown[] } }) => {
      request.state.catalogue_index.push({ id: 'outside', purpose: 'unauthorized' });
      return recorded('loop.preselect', entries, 1).outcome;
    },
  } as unknown as Pick<InferenceGateway, 'evaluate'>;
  const result = await evaluateBooleanSite('loop.preselect', input, port, () => ({ ...current, observed_at: 10 }));
  assert.deepEqual(
    result.catalogue_index,
    input.catalogue_index.map(({ id, purpose }) => ({ id, purpose })),
  );
  assert.equal(
    result.catalogue_index.some((e) => e.id === 'outside'),
    false,
  );
});
