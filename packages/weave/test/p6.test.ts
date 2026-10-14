import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationOutcome, InferenceGateway } from '@weave/gateway';
import { grantCovers } from '@weave/agentsop';
import { transitionBooleanSite, evaluateBooleanSite, INPUT_RULES } from '../src/sites/boolean.js';
const current = { state_revision: 1, state_updated_at: 10 };
const input = { ...current, request_id: 'r1', state: { text: 'CANARY_SECRET' }, needs_dispatch: true,
  terms: { quality: 'baseline' as const, destinations: ['local'], max_context_tokens: 100,
    deadline: 100, cost_ceiling: 10, max_attempts: 1 },
  catalogue_index: Array.from({ length: 12 }, (_, n) => ({ id: `op${n}`, purpose: 'disclosed', input: { secret: 'SCHEMA_SECRET' } })) };
function recorded(site: string, keys: readonly string[], p = .29, confidence: number | undefined = 1) {
  const outcome: EvaluationOutcome<'boolean'> = { status: 'accepted', kind: 'boolean', site, request_id: 'r1',
    answers: Object.fromEntries(keys.map(key => [key, { type: 'boolean' as const, probability: p }])),
    confidence: confidence === undefined ? undefined : Object.fromEntries(keys.map(key => [key, confidence])),
    provider_response_id: 'provider-1', routed_unit_id: 'fixture', attempts: [], spent: 0, uncertainty: [] };
  return { state_revision: 1, observed_at: 10, outcome };
}
const entries = input.catalogue_index.map((_, i) => `entry_${i}`);
test('D3 narrows only the disclosed index, caps eight with stable ties, ignores and records unknown answers', () => {
  const r = recorded('loop.preselect', [...entries, 'CANARY_UNKNOWN'], .5);
  const result = transitionBooleanSite('loop.preselect', input, r, current);
  assert.deepEqual(result.catalogue_index.map(x => x.id), input.catalogue_index.slice(0, 8).map(x => x.id));
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
    assert.equal(transitionBooleanSite(site, input, recorded(site, keys, .30), current).status, 'needs_human');
    assert.equal(grantCovers(null, 'write', '1', [{ resource: 'file', mode: 'write' }]).ok, false);
    assert.equal('grant' in pass, false);
  });
  test(`${site} rejects uncertainty, malformed, stale, mismatched, refusal and outage`, () => {
    const good = recorded(site, keys);
    const failures = [recorded(site, keys, .1, .89), recorded(site, keys, .1, undefined),
      { ...good, observed_at: 9 }, { ...good, state_revision: 0 },
      { ...good, outcome: { ...good.outcome, site: 'other' } },
      { ...good, outcome: { ...good.outcome, answers: {} } },
      { ...good, outcome: { ...good.outcome, answers: Object.fromEntries(keys.map(k => [k, { type: 'boolean', probability: NaN }])) } },
      { ...good, outcome: null },
      { ...good, outcome: { status: 'blocked', site, request_id: 'r1', reason: 'provider_unavailable', attempts: [], spent: 0, uncertainty: [] } },
      { ...good, outcome: { status: 'unaccepted', site, request_id: 'r1', reason: 'provider_failed', attempts: [], spent: 0, uncertainty: [] } }];
    for (const failure of failures) {
      const result = transitionBooleanSite(site, input, failure as typeof good, current);
      assert.equal(result.status, 'needs_human');
      assert.ok(result.approval_requests.length > 0);
      assert.ok(!JSON.stringify(result.observations).includes('CANARY_SECRET'));
    }
    const result = transitionBooleanSite(site, input, good, current);
    assert.deepEqual(Object.keys(result.observations[0]!), ['schema', 'site', 'question', 'request_id', 'state_revision',
      'answer', 'confidence', 'top_p', 'accepted', 'fallback_used', 'reason', 'provider_request_id']);
    assert.equal(result.observations[0]?.provider_request_id, 'provider-1');
    assert.deepEqual(result, transitionBooleanSite(site, input, JSON.parse(JSON.stringify(good)), current));
  });
}
test('D3 all failure modes return full index without schemas', () => {
  const good = recorded('loop.preselect', entries, 1);
  for (const r of [recorded('loop.preselect', entries, 1, .74), recorded('loop.preselect', entries, 1, undefined),
    { ...good, observed_at: 9 }, { ...good, outcome: null }, { ...good, outcome: { ...good.outcome, answers: {} } }]) {
    const result = transitionBooleanSite('loop.preselect', input, r, current);
    assert.deepEqual(result.catalogue_index, input.catalogue_index.map(({ id, purpose }) => ({ id, purpose })));
  }
});
test('evaluate uses site semantics once, handles thrown secrets and in-flight revision changes', async () => {
  for (const site of ['loop.preselect', 'guard.input', 'guard.output'] as const) {
    let calls = 0;
    const port = { evaluate: async (request: { site: string; state: unknown; kind: string }) => {
      calls++;
      assert.equal(request.site, site); assert.equal(request.kind, 'boolean');
      if (site === 'loop.preselect') assert.ok(!JSON.stringify(request).includes('SCHEMA_SECRET'));
      throw new Error('CANARY_SECRET');
    } } as unknown as Pick<InferenceGateway, 'evaluate'>;
    const result = await evaluateBooleanSite(site, input, port, () => ({ ...current, observed_at: 10 }));
    assert.equal(calls, 1);
    assert.equal(result.status, site === 'loop.preselect' ? 'transition' : 'needs_human');
    assert.ok(!JSON.stringify(result.observations).includes('CANARY'));
  }
});
