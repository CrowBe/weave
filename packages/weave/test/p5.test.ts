import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetRoute, createInferenceGateway, type EvaluationAdapter, type EvaluationOutcome, type InferenceGateway, type RoutedUnit } from '@weave/gateway';
import { evaluateSite, transitionSite, stopForNoProgress } from '../src/sites/index.js';

type Site = 'loop.triage' | 'loop.route' | 'loop.continue' | 'intake.classify';
const current = { state_revision: 1, state_updated_at: 10 };
const input = {
  request_id: 'r1', ...current, state: { message: 'disclosed', running_threads: [] },
  terms: { quality: 'baseline' as const, destinations: ['local'], max_context_tokens: 100,
    deadline: 100, cost_ceiling: 10, max_attempts: 1 },
  needs_dispatch: false,
};
function answer(site: Site, choice: string, confidence: number | undefined, probabilities?: Record<string, number>) {
  const outcome: EvaluationOutcome<'choice'> = {
    status: 'accepted', kind: 'choice', request_id: 'r1', site,
    answers: { decision: { type: 'choice', choice, ...(probabilities ? { probabilities } : {}) } },
    confidence: confidence === undefined ? undefined : { decision: confidence },
    routed_unit_id: 'fixture', provider_response_id: 'provider-1', attempts: [], spent: 0, uncertainty: [],
  };
  return { state_revision: 1, observed_at: 10, outcome };
}
const cases = [
  ['loop.triage', 'done_check', .80, 'implement'],
  ['loop.route', 'strong', .75, 'standard'],
  ['loop.continue', 'progressing', .70, 'stalled'],
  ['intake.classify', 'steer', .80, 'ask_user'],
] as const;
for (const [site, choice, threshold, fallback] of cases) {
  test(`${site} accepts threshold inclusively and rejects below or missing confidence`, () => {
    const accepted = transitionSite(site, input, answer(site, choice, threshold, { [choice]: 1 }), current);
    assert.equal(accepted.choice, choice);
    assert.equal(accepted.observation.accepted, true);
    assert.equal(accepted.observation.provider_request_id, 'provider-1');
    for (const confidence of [threshold - .001, undefined]) {
      const result = transitionSite(site, input, answer(site, choice, confidence, { [choice]: 1 }), current);
      assert.equal(result.choice, fallback);
      assert.equal(result.observation.fallback_used, true);
      assert.equal(result.observation.accepted, false);
      assert.ok(result.observation.reason);
      if (site === 'loop.triage') assert.equal(result.tier, 'strong');
      if (site === 'intake.classify') assert.equal(result.status, 'needs_human');
    }
  });
  test(`${site} rejects stale revisions, old answers, and invalid choices`, () => {
    const recorded = answer(site, choice, 1, { [choice]: 1 });
    for (const stale of [
      { ...recorded, state_revision: 0 },
      { ...recorded, observed_at: 9 },
      answer(site, 'secret-invalid-option', 1, { 'secret-invalid-option': 1 }),
    ]) {
      const result = transitionSite(site, input, stale, current);
      assert.equal(result.choice, fallback);
      assert.equal(result.observation.accepted, false);
      assert.ok(!JSON.stringify(result.observation).includes('secret-invalid-option'));
    }
  });
  test(`${site} replay preserves the transition and fixed observation field order`, () => {
    const recorded = answer(site, choice, 1, { [choice]: 1 });
    const first = transitionSite(site, input, recorded, current);
    const second = transitionSite(site, input, JSON.parse(JSON.stringify(recorded)), current);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first.observation), JSON.stringify(second.observation));
    assert.deepEqual(Object.keys(first.observation), [
      'schema', 'site', 'question', 'request_id', 'state_revision', 'answer', 'confidence',
      'top_p', 'accepted', 'fallback_used', 'reason', 'provider_request_id',
    ]);
  });
}

test('D1 requires selected top probability at least .6 and a valid distribution', () => {
  assert.equal(transitionSite('loop.triage', input,
    answer('loop.triage', 'done_check', .80, { done_check: .6, implement: .4 }), current).choice, 'done_check');
  for (const probabilities of [undefined, { done_check: .59, implement: .41 },
    { done_check: .6, implement: .7 }, { done_check: NaN }, { done_check: -1 }]) {
    const result = transitionSite('loop.triage', input, answer('loop.triage', 'done_check', 1, probabilities), current);
    assert.equal(result.choice, 'implement');
    assert.equal(result.observation.accepted, false);
  }
});

test('intake state is typed as a disclosed message plus running-thread summaries', async () => {
  const typed = transitionSite('intake.classify', input, answer('intake.classify', 'queue', 1), current);
  assert.equal(typed.choice, 'queue');
  const untyped = { ...input, state: 'raw channel text' };
  // @ts-expect-error intake requires IntakeState, not arbitrary evaluation content (#90)
  transitionSite('intake.classify', untyped, answer('intake.classify', 'queue', 1), current);
  // @ts-expect-error the evaluate entry point applies the same input type
  await evaluateSite('intake.classify', untyped, port(async () => answer('intake.classify', 'queue', 1).outcome),
    () => ({ ...current, observed_at: 10 }));
  // Other sites keep accepting any disclosed evaluation content.
  assert.equal(transitionSite('loop.route', untyped, answer('loop.route', 'strong', 1), current).choice, 'strong');
});

test('all intake choices are available without channel-specific input', () => {
  for (const choice of ['new_thread', 'continue_thread', 'queue', 'steer', 'interrupt', 'stop']) {
    assert.equal(transitionSite('intake.classify', input, answer('intake.classify', choice, 1), current).choice, choice);
  }
});

test('refusal and unavailable answers use deterministic fallbacks; outage pauses dispatch', () => {
  for (const [site, , , fallback] of cases) {
    const refused = { state_revision: 1, observed_at: 10,
      outcome: { status: 'unaccepted' as const, request_id: 'r1', site,
        reason: 'provider_failed' as const, attempts: [], spent: 0, uncertainty: [] } };
    assert.equal(transitionSite(site, input, refused, current).choice, fallback);
    const unavailable = { ...refused, outcome: { ...refused.outcome,
      status: 'blocked' as const, reason: 'provider_unavailable' as const } };
    for (const recorded of [unavailable, { state_revision: 1, observed_at: 10, outcome: null }]) {
      const readOnly = transitionSite(site, input, recorded, current);
      assert.equal(readOnly.choice, fallback);
      assert.notEqual(readOnly.status, 'paused');
      assert.equal(transitionSite(site, { ...input, needs_dispatch: true }, recorded, current).status, 'paused');
    }
  }
});

test('stop function counts consecutive nonprogress, resets with progress, and checks issue attempts', () => {
  for (const pair of [['stalled', 'stalled'], ['regressing', 'regressing'], ['stalled', 'regressing'], ['regressing', 'stalled']] as const) {
    assert.equal(stopForNoProgress(pair, []), 'no_progress');
  }
  for (const history of [[], ['stalled'], ['stalled', 'progressing'], ['stalled', 'progressing', 'stalled']] as const) {
    assert.equal(stopForNoProgress(history, []), null);
  }
  assert.equal(stopForNoProgress([], [{ issue_id: 'issue1', fix_attempts: 2, reappeared: true }]), 'repeated_issue');
  assert.equal(stopForNoProgress([], [{ issue_id: 'issue1', fix_attempts: 1, reappeared: true }]), null);
  assert.equal(stopForNoProgress([], [{ issue_id: 'issue1', fix_attempts: 2, reappeared: false }]), null);
});

function port(fn: (...args: unknown[]) => Promise<unknown>) {
  return { evaluate: fn } as Pick<InferenceGateway, 'evaluate'>;
}
test('evaluate port emits one choice question and rejects a revision change during await', async () => {
  let revision = current;
  let calls = 0;
  const fake = port(async (...args) => {
    calls++;
    const request = args[0] as { site: string; kind: string; questions: Record<string, unknown>; state: unknown };
    assert.equal(request.site, 'loop.route');
    assert.equal(request.kind, 'choice');
    assert.deepEqual(Object.keys(request.questions), ['decision']);
    assert.deepEqual(request.state, input.state);
    revision = { state_revision: 2, state_updated_at: 11 };
    return answer('loop.route', 'strong', 1).outcome;
  });
  const result = await evaluateSite('loop.route', input, fake, () => ({ ...revision, observed_at: 11 }));
  assert.equal(calls, 1);
  assert.equal(result.choice, 'standard');
  assert.equal(result.observation.accepted, false);
});

test('port exceptions cannot leak diagnostics and pause dispatch-dependent work', async () => {
  const fake = port(async () => { throw new Error('secret-provider-diagnostic'); });
  const result = await evaluateSite('loop.route', { ...input, needs_dispatch: true }, fake, () => ({ ...current, observed_at: 10 }));
  assert.equal(result.status, 'paused');
  assert.ok(!JSON.stringify(result).includes('secret-provider-diagnostic'));
});

test('cancellation always pauses even if the port returns an accepted answer', async () => {
  const controller = new AbortController();
  const fake = port(async () => {
    controller.abort();
    return answer('loop.route', 'strong', 1).outcome;
  });
  const result = await evaluateSite('loop.route', input, fake, () => ({ ...current, observed_at: 10 }), controller.signal);
  assert.equal(result.status, 'paused');
  assert.equal(result.observation.accepted, false);
});

const routed: RoutedUnit = {
  operation: 'evaluate', kind: 'choice', tier: 'decision', routed_unit_id: 'decision.fixture',
  adapter: 'fake', model: 'fixture', context_profile: 'none', context_profile_version: 1,
  prompt_template: 'none', prompt_template_version: 1, settings: { max_output_tokens: 1 },
  destination: 'local', quality: 'baseline', context_limit_tokens: 1000,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
};
for (const mode of ['normal', 'refusal', 'unavailable'] as const) {
  test(`real gateway with fake evaluator: ${mode}`, async () => {
    let calls = 0;
    const evaluator: EvaluationAdapter = {
      id: 'fake', async evaluate(call) {
        calls++;
        assert.equal(call.kind, 'choice');
        assert.equal(call.questions['decision']?.type, 'choice');
        if (mode === 'refusal') return { status: 'failed', failure: {
          code: 'invalid_request', retryable: false, message: 'refused',
        } };
        return { status: 'completed', answers: { decision: { type: 'choice', choice: 'strong' } },
          confidence: { decision: .75 }, usage: { input_tokens: 0, output_tokens: 0 },
          provider_response_id: 'fake-provider' };
      },
    };
    const gateway = createInferenceGateway({ routes: [routed], evaluators: [evaluator],
      clock: { now: () => 10 }, ...(mode === 'unavailable' ? { availability: { fake: 'unavailable' as const } } : {}) });
    const result = await evaluateSite('loop.route', { ...input, needs_dispatch: true }, gateway,
      () => ({ ...current, observed_at: 10 }));
    assert.equal(calls, mode === 'unavailable' ? 0 : 1);
    assert.equal(result.choice, mode === 'normal' ? 'strong' : 'standard');
    assert.equal(result.status, mode === 'unavailable' ? 'paused' : 'transition');
    assert.equal(result.observation.accepted, mode === 'normal');
  });
}

// #91: the gateway reports a refusal as attempts_exhausted at max_attempts 1 and as provider_failed above it.
// Outage classification reads the failure codes, so max_attempts cannot change the site outcome.
for (const [code, retryable, outage] of [['invalid_request', false, false], ['malformed_response', false, false],
  ['unavailable', true, true], ['unauthorized', false, true], ['rate_limited', true, true]] as const) {
  test(`${code} classifies the same at every max_attempts`, async () => {
    const reasons = new Set<string>();
    for (const max_attempts of [1, 2, 3]) {
      const gateway = createInferenceGateway({ routes: [routed], clock: { now: () => 10 }, evaluators: [{
        id: 'fake', async evaluate() { return { status: 'failed', failure: { code, retryable, message: 'sk-secret-detail' } }; },
      }] });
      const outcome = await gateway.evaluate({ request_id: 'r1', site: 'loop.route', role: 'working', kind: 'choice',
        state: 'disclosed', questions: { decision: { type: 'choice', instructions: 'q', criteria: { flash: null, strong: null } } },
        terms: { ...input.terms, max_attempts } });
      if (outcome.status === 'unaccepted') reasons.add(outcome.reason);
      const dispatch = transitionSite('loop.route', { ...input, needs_dispatch: true, terms: { ...input.terms, max_attempts } },
        { state_revision: 1, observed_at: 10, outcome: outcome as EvaluationOutcome<'choice'> }, current);
      assert.equal(dispatch.choice, 'standard');
      assert.equal(dispatch.status, outage ? 'paused' : 'transition');
      assert.equal(dispatch.observation.reason, outage ? 'decision_unavailable' : 'no_answer');
      assert.ok(!JSON.stringify(dispatch).includes('sk-secret'));
    }
    if (!retryable) assert.deepEqual([...reasons].sort(), ['attempts_exhausted', 'provider_failed']);
  });
}

test('provider_failed without any failed attempt is an abort before dispatch and stays an outage', () => {
  const outcome: EvaluationOutcome<'choice'> = { status: 'unaccepted', reason: 'provider_failed', request_id: 'r1',
    site: 'loop.route', attempts: [], spent: 0, uncertainty: [] };
  const result = transitionSite('loop.route', { ...input, needs_dispatch: true }, { state_revision: 1, observed_at: 10, outcome }, current);
  assert.equal(result.status, 'paused');
  assert.equal(result.observation.reason, 'decision_unavailable');
});

test('D2 ceiling composes with P4 downgrade and never upgrades unavailable lower tiers', () => {
  const routes: RoutedUnit[] = ['flash', 'standard', 'strong'].map(tier => ({
    ...routed, operation: 'generate', kind: 'transform', tier: tier as 'flash' | 'standard' | 'strong',
    routed_unit_id: tier, quota_provider: 'account',
  }));
  const snapshot = { observed_at: 10, providers: [{ provider: 'account', status: 'fresh', windows: [
    { id: 'seven_day', percentRemaining: 90, resetsAt: 1000, pace: { status: 'ahead' } },
  ] }] };
  for (const selected of ['flash', 'standard', 'strong'] as const) {
    const transition = transitionSite('loop.route', input, answer('loop.route', selected, 1), current);
    assert.equal(transition.choice, selected);
    const target = { operation: 'generate' as const, kind: 'transform' as const, tier: selected };
    const decision = budgetRoute(routes, target, { ...input.terms, tier: selected }, 0, undefined, snapshot, 10);
    assert.equal(decision.order[0]?.tier, selected === 'strong' ? 'standard' : selected);
    assert.equal(decision.downgraded, selected === 'strong');
    const onlyStrong = budgetRoute(routes.filter(unit => unit.tier === 'strong'), target,
      { ...input.terms, tier: selected }, 0, undefined, snapshot, 10);
    assert.equal(onlyStrong.order.length, 0);
  }
});

test('exhausted attempts retain outage evidence and cannot permit dispatch', async () => {
  const gateway = createInferenceGateway({ routes: [routed], clock: { now: () => 10 }, evaluators: [{
    id: 'fake', async evaluate() { return { status: 'failed', failure: {
      code: 'unavailable', retryable: true, message: 'sk-secret-outage-detail',
    } }; },
  }] });
  const result = await evaluateSite('loop.route', { ...input, needs_dispatch: true }, gateway,
    () => ({ ...current, observed_at: 10 }));
  assert.equal(result.status, 'paused');
  assert.equal(result.observation.reason, 'decision_unavailable');
  assert.ok(!JSON.stringify(result).includes('sk-secret'));
});

test('mismatched request/site and invalid confidence fail closed for every site', () => {
  for (const [site, choice, , fallback] of cases) {
    for (const confidence of [NaN, Infinity, -1, 1.1]) {
      const result = transitionSite(site, input, answer(site, choice, confidence, { [choice]: 1 }), current);
      assert.equal(result.choice, fallback);
      assert.equal(result.observation.confidence, null);
    }
    const recorded = answer(site, choice, 1, { [choice]: 1 });
    assert.equal(recorded.outcome.status, 'accepted');
    for (const mismatch of [{ request_id: 'other' }, { site: 'other' }]) {
      const result = transitionSite(site, input, { ...recorded, outcome: { ...recorded.outcome, ...mismatch } }, current);
      assert.equal(result.choice, fallback);
      assert.equal(result.observation.reason, 'mismatched_answer');
    }
  }
});

test('trace omits undisclosed state, diagnostics and recognizable credential correlation ids', () => {
  const recorded = answer('loop.route', 'strong', 1);
  const result = transitionSite('loop.route', { ...input, request_id: 'sk-secret', state: { token: 'state-secret' } },
    { ...recorded, outcome: { ...recorded.outcome, request_id: 'sk-secret', provider_response_id: 'Bearer-secret' } }, current);
  assert.equal(result.observation.request_id, null);
  assert.equal(result.observation.provider_request_id, null);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('pre-cancelled evaluation does not call the port', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await evaluateSite('loop.route', input, port(async () => { assert.fail('must not call'); }),
    () => ({ ...current, observed_at: 10 }), controller.signal);
  assert.equal(result.status, 'paused');
  assert.equal(result.observation.reason, 'cancelled');
});

for (const failure of [
  { status: 'blocked', reason: 'no_budget' },
  { status: 'blocked', reason: 'quota_unknown' },
  { status: 'blocked', reason: 'weekly_budget_cap' },
  { status: 'blocked', reason: 'deadline_passed' },
  { status: 'unaccepted', reason: 'budget_exhausted' },
  { status: 'unaccepted', reason: 'deadline_reached' },
] as const) {
  test(`decision ${failure.status} with ${failure.reason} pauses dispatch and preserves read-only fallback`, () => {
    for (const [site, , , fallback] of cases) {
      const outcome: EvaluationOutcome<'choice'> = { ...failure, request_id: 'r1', site,
        attempts: [], spent: 0, uncertainty: [] };
      const recorded = { state_revision: 1, observed_at: 10, outcome };
      const readOnly = transitionSite(site, input, recorded, current);
      assert.equal(readOnly.choice, fallback);
      assert.equal(readOnly.status, site === 'intake.classify' ? 'needs_human' : 'transition');
      assert.equal(readOnly.observation.reason, 'decision_unavailable');
      assert.equal(readOnly.observation.accepted, false);
      assert.equal(transitionSite(site, { ...input, needs_dispatch: true }, recorded, current).status, 'paused');
    }
  });
}

test('explicit gateway pause makes the decision unavailable independently of outcome reason', () => {
  for (const [site, , , fallback] of cases) {
    const outcome: EvaluationOutcome<'choice'> = { status: 'unaccepted', reason: 'attempts_exhausted',
      request_id: 'r1', site, attempts: [], spent: 0, uncertainty: [],
      paused: { type: 'loop.paused', policy: 'budget.policy@1', request_id: 'r1', site,
        reason: 'five_hour_budget_low', until: 1000 } };
    const recorded = { state_revision: 1, observed_at: 10, outcome };
    const readOnly = transitionSite(site, input, recorded, current);
    assert.equal(readOnly.choice, fallback);
    assert.notEqual(readOnly.status, 'paused');
    assert.equal(readOnly.observation.reason, 'decision_unavailable');
    assert.equal(transitionSite(site, { ...input, needs_dispatch: true }, recorded, current).status, 'paused');
  }
});

test('Amos unavailable makes intake ask_user without calling TypeSafe', async () => {
  const { amosEvaluator } = await import('@weave/gateway/amos');
  const unit: RoutedUnit = {
    routed_unit_id: 'amos.choice', adapter: 'amos', model: 'amos-1-2b', operation: 'evaluate', kind: 'choice',
    destination: 'local', quality: 'baseline', context_profile: 'decision', context_profile_version: 1,
    prompt_template: 'decision.choice', prompt_template_version: 1, settings: { max_output_tokens: 256 },
    context_limit_tokens: 1000, price: { input_per_mtok: 0, output_per_mtok: 0 },
  };
  let typesafeCalls = 0;
  const gateway = createInferenceGateway({
    clock: { now: () => 10 }, routes: [unit, { ...unit, routed_unit_id: 'typesafe.choice', adapter: 'typesafe-ai', model: 'jev-preview' }],
    decision: { provider: 'typesafe-jev', fallback: null, sites: { 'intake.classify': 'amos' }, providers: {
      amos: { base_url: 'http://127.0.0.1:8766', model: 'amos-1-2b' },
      'typesafe-jev': { base_url: 'https://api.typesafe.ai', model: 'jev-preview' },
    } },
    evaluators: [amosEvaluator({ fetch: async () => new Response('private provider text', { status: 503 }) }),
      { id: 'typesafe-ai', evaluate: async () => { typesafeCalls++; throw new Error('must not call'); } }],
  });
  const outcome = await gateway.evaluate({ request_id: 'availability', site: 'intake.classify', role: 'working', kind: 'choice', state: 'disclosed', questions: { decision: { type: 'choice', instructions: 'classify', criteria: { new_thread: null, queue: null } } }, terms: input.terms });
  assert.equal(outcome.status, 'blocked');
  if (outcome.status === 'blocked') assert.equal(outcome.reason, 'provider_unavailable');
  const result = await evaluateSite('intake.classify', input, gateway, () => ({ ...current, observed_at: 10 }));
  assert.equal(result.choice, 'ask_user');
  assert.equal(result.status, 'needs_human');
  assert.equal(result.observation.reason, 'decision_unavailable');
  assert.equal(typesafeCalls, 0);
  assert.ok(!JSON.stringify(result).includes('private provider text'));
});
