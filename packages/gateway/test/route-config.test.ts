import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { parseRouteConfig, route, createInferenceGateway, type InferenceTerms } from '@weave/gateway';

const example = () => JSON.parse(readFileSync(new URL('../../../../weave.routes.example.json', import.meta.url), 'utf8'));
const terms: InferenceTerms = { quality: 'baseline', destinations: ['local'], max_context_tokens: 100, deadline: 1000, cost_ceiling: 100, max_attempts: 2 };
const target = { operation: 'generate', kind: 'transform' } as const;
function table() {
  const result = parseRouteConfig(example());
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.table;
}
it('parses the example without changing its units or decision config', () => {
  const input = example();
  const result = parseRouteConfig(input);
  assert.deepEqual(result, { ok: true, table: input.units, decision: input.decision });
});
it('filters tiers independently of quality and preserves order', () => {
  const units = table();
  assert.deepEqual(route(units, target, { ...terms, tier: 'flash' }, 20).order.map(u => u.adapter), ['grok-build', 'codex']);
  assert.equal(route(units, target, { ...terms, tier: 'flash' }, 20).excluded[0]?.reason, 'tier_mismatch');
  assert.equal(route(units, { ...target, tier: 'decision' }, terms, 20).order.length, 0);
});
it('excludes unavailable adapters or destinations with stable order; absent availability is a no-op', () => {
  const units = table();
  const baseline = route(units, target, terms, 20);
  assert.deepEqual(route(units, target, terms, 20, {}), baseline);
  for (const status of ['exhausted', 'auth_required', 'unavailable'] as const) {
    const result = route(units, target, terms, 20, { codex: status, 'grok-build': { status, recheck_after: 0 } });
    assert.deepEqual(result.order.map(u => u.adapter), ['claude-code']);
    assert.deepEqual(result.excluded.map(u => u.reason), ['provider_unavailable', 'provider_unavailable']);
  }
  assert.equal(route(units, target, terms, 20, { local: 'unavailable' }).order.length, 0);
  assert.deepEqual(route(units, target, terms, 20, { codex: 'available' }), baseline);
});
it('an empty table still blocks without attempting a provider', async () => {
  const gateway = createInferenceGateway({ routes: [], clock: { now: () => 0 } });
  const result = await gateway.generate({ request_id: 'empty', site: 'test', role: 'working', kind: 'transform', input: { instructions: '', prompt: 'work' }, terms });
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') assert.equal(result.reason, 'no_route');
  assert.deepEqual(result.attempts, []);
});
const cases: [string, (config: any) => void][] = [
  ['duplicate id', c => c.units.push(c.units[0])],
  ['unknown operation', c => c.units[0].operation = 'other'],
  ['unknown kind', c => c.units[0].kind = 'other'],
  ['wrong kind pair', c => c.units[0].kind = 'boolean'],
  ['unknown tier', c => c.units[0].tier = 'fast'],
  ['negative output price', c => c.units[0].price.output_per_mtok = -1],
  ['nonnumeric input price', c => c.units[0].price.input_per_mtok = '0'],
  ['missing price', c => delete c.units[0].price],
  ['negative input price', c => c.units[0].price.input_per_mtok = -1],
  ['nonnumeric output price', c => c.units[0].price.output_per_mtok = '0'],
  ['nonfinite price', c => c.units[0].price.output_per_mtok = Infinity],
  ['same fallback', c => c.decision.fallback = c.decision.provider],
  ['missing primary', c => c.decision.provider = 'absent'],
  ['missing fallback', c => c.decision.fallback = 'absent'],
  ['invalid URL scheme', c => c.decision.providers['typesafe-jev'].base_url = 'file:///tmp/x'],
  ['invalid URL', c => c.decision.providers['typesafe-jev'].base_url = 'https://'],
  ['missing settings', c => delete c.units[0].settings],
  ['invalid quality', c => c.units[0].quality = 'strong'],
  ['missing model', c => delete c.decision.providers['typesafe-jev'].model],
  ['missing providers', c => delete c.decision.providers],
  ['invalid provider record', c => c.decision.providers['typesafe-jev'] = null],
  ['invalid key env', c => c.decision.providers['typesafe-jev'].key_env = 12],
  ['invalid unit', c => c.units[0] = null],
  ['missing adapter', c => delete c.units[0].adapter],
  ['invalid profile version', c => c.units[0].context_profile_version = 0],
  ['invalid context limit', c => c.units[0].context_limit_tokens = 1.5],
  ['invalid output bound', c => c.units[0].settings.max_output_tokens = 0],
  ['invalid temperature', c => c.units[0].settings.temperature = Infinity],
  ['invalid evidence', c => c.units[0].evidence = { attempts: 2, accepted: 3 }],
  ['invalid rate limits', c => c.units[0].rate_limits = [{ requests: 0, window_ms: 1 }]],
  ['invalid auth', c => c.decision.providers['typesafe-jev'].auth = 12],
];
for (const [name, mutate] of cases) it(`rejects ${name}`, () => {
  const input = example(); mutate(input);
  const result = parseRouteConfig(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.length > 0);
});
it('rejects malformed roots and permits null fallback, no tier, and an empty table', () => {
  for (const input of [null, [], {}, { units: [], decision: null }]) assert.equal(parseRouteConfig(input).ok, false);
  const input = example(); input.decision.fallback = null; delete input.units[0].tier;
  assert.equal(parseRouteConfig(input).ok, true);
  input.units = []; assert.equal(parseRouteConfig(input).ok, true);
});

it('tier never relaxes quality or matches an unclassified unit', () => {
  const units = table();
  const result = route(units, target, { ...terms, tier: 'flash', quality: 'high' }, 20);
  assert.deepEqual(result.order, []);
  assert.equal(result.excluded[0]?.reason, 'quality_below_bar');
  const unclassified = units.map(({ tier, ...unit }) => unit);
  assert.deepEqual(route(unclassified, target, { ...terms, tier: 'flash' }, 20).order, []);
  assert.equal(route(units, { ...target, tier: 'strong' }, { ...terms, tier: 'flash' }, 20).order.length, 0);
});
it('availability retains evidence tie order and exclusion declaration order', () => {
  const units = table().map(unit => ({ ...unit, evidence: { attempts: 20, accepted: 20 } }));
  const result = route(units, target, terms, 20, { codex: 'exhausted' });
  assert.deepEqual(result.order.map(u => u.adapter), ['claude-code', 'grok-build']);
  assert.deepEqual(result.excluded, [{ routed_unit_id: 'codex.flash', reason: 'provider_unavailable' }]);
});
it('gateway passes availability into generation and evaluation routing', async () => {
  const units = table();
  const evaluateUnit = { ...units[0]!, operation: 'evaluate', kind: 'boolean', adapter: 'decision', routed_unit_id: 'decision', tier: 'decision' } as const;
  let calls = 0;
  const gateway = createInferenceGateway({
    routes: [...units, evaluateUnit], clock: { now: () => 0 }, availability: { local: 'auth_required' },
    adapters: units.map(unit => ({ id: unit.adapter, async execute() { calls++; throw new Error('must not call'); } })),
    evaluators: [{ id: 'decision', async evaluate() { calls++; throw new Error('must not call'); } }],
  });
  const generate = await gateway.generate({ request_id: 'unavailable', site: 'test', role: 'working', kind: 'transform', input: { instructions: '', prompt: 'work' }, terms });
  const evaluate = await gateway.evaluate({ request_id: 'unavailable', site: 'test', role: 'working', kind: 'boolean', state: 'work', questions: { q: { type: 'boolean', instructions: 'pass?' } }, terms });
  for (const result of [generate, evaluate]) {
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.equal(result.reason, 'no_route');
    assert.deepEqual(result.attempts, []);
  }
  assert.equal(calls, 0);
});
