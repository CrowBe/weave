import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import {
  applyRouteOverlay,
  bindDecisionProvider,
  parseRouteConfig,
  route,
  createInferenceGateway,
  type InferenceTerms,
} from '@weave/gateway';
import { typesafeAiEvaluator } from '@weave/gateway/typesafe-ai';

const example = () => JSON.parse(readFileSync(new URL('../../../../weave.routes.example.json', import.meta.url), 'utf8'));
const terms: InferenceTerms = { quality: 'baseline', destinations: ['xai.grok-build', 'openai.codex', 'anthropic.claude-code'], max_context_tokens: 100, deadline: 1000, cost_ceiling: 100, max_attempts: 2 };
const target = { operation: 'generate', kind: 'transform' } as const;
function table() {
  const result = parseRouteConfig(example());
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.table;
}
/** Decision evaluate units are not candidates for a generate target. */
function operationMismatch(units: readonly { routed_unit_id: string; operation: string }[]) {
  return units
    .filter((unit) => unit.operation !== 'generate')
    .map((unit) => ({ routed_unit_id: unit.routed_unit_id, reason: 'operation_mismatch' as const }));
}
it('parses the example without changing its units or decision config', () => {
  const input = example();
  const result = parseRouteConfig(input);
  assert.deepEqual(result, { ok: true, table: input.units, decision: input.decision });
});
it('uses TypeSafe Jev as the sole default decision provider without fallback', () => {
  const result = parseRouteConfig(example());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.provider, 'typesafe-jev');
  assert.equal(result.decision.fallback, null);
  assert.equal(result.decision.providers['typesafe-jev']?.model, 'jev-latest');
});
it('filters tiers independently of quality and preserves order', () => {
  const units = table();
  const generate = units.filter((unit) => unit.operation === 'generate');
  const flash = route(units, target, { ...terms, tier: 'flash' }, 20);
  assert.deepEqual(flash.order.map(u => u.adapter), ['grok-build', 'codex']);
  assert.deepEqual(flash.excluded, [
    { routed_unit_id: 'claude-code.strong', reason: 'tier_mismatch' },
    ...operationMismatch(units),
  ]);
  const decisionTier = route(units, { ...target, tier: 'decision' }, terms, 20);
  assert.deepEqual(decisionTier.order, []);
  assert.deepEqual(decisionTier.excluded, [
    ...generate.map((unit) => ({ routed_unit_id: unit.routed_unit_id, reason: 'tier_mismatch' as const })),
    ...operationMismatch(units),
  ]);
  const strong = route(units, { ...target, tier: 'strong' }, terms, 20);
  assert.deepEqual(strong.order.map(unit => unit.routed_unit_id), ['claude-code.strong']);
  assert.deepEqual(strong.excluded, [
    { routed_unit_id: 'grok-build.flash', reason: 'tier_mismatch' },
    { routed_unit_id: 'codex.flash', reason: 'tier_mismatch' },
    ...operationMismatch(units),
  ]);
  const unclassified = units.map(({ tier, ...unit }) => unit);
  assert.deepEqual(route(unclassified, target, { ...terms, tier: 'flash' }, 20).excluded, [
    ...generate.map((unit) => ({ routed_unit_id: unit.routed_unit_id, reason: 'tier_mismatch' as const })),
    ...operationMismatch(units),
  ]);
});
it('reports no_budget when the requested tier is unaffordable and another tier stays affordable', async () => {
  const units = table().map(unit => unit.tier === 'flash'
    ? { ...unit, price: { ...unit.price, output_per_mtok: 1_000_000 } }
    : unit);
  const open = route(units, target, terms, 20);
  assert.deepEqual(open.order.map(u => u.routed_unit_id), ['claude-code.strong']);
  assert.deepEqual(open.excluded, [
    { routed_unit_id: 'grok-build.flash', reason: 'unaffordable' },
    { routed_unit_id: 'codex.flash', reason: 'unaffordable' },
    ...operationMismatch(units),
  ]);
  let calls = 0;
  const gateway = createInferenceGateway({
    routes: units,
    clock: { now: () => 0 },
    adapters: units.filter((unit) => unit.operation === 'generate').map(unit => ({ id: unit.adapter, async execute() { calls++; throw new Error('must not call'); } })),
    evaluators: [...new Set(units.filter((unit) => unit.operation === 'evaluate').map((unit) => unit.adapter))].map((id) => ({
      id, async evaluate() { calls++; throw new Error('must not call'); },
    })),
  });
  const outcome = await gateway.generate({
    request_id: 'flash-budget', site: 'test', role: 'working', kind: 'transform',
    input: { instructions: '', prompt: 'work' }, terms: { ...terms, tier: 'flash' },
  });
  assert.equal(outcome.status, 'blocked');
  if (outcome.status === 'blocked') assert.equal(outcome.reason, 'no_budget');
  assert.deepEqual(outcome.attempts, []);
  assert.equal(calls, 0);
});
it('excludes unavailable adapters with stable order; absent availability is a no-op', () => {
  const units = table();
  const baseline = route(units, target, terms, 20);
  assert.deepEqual(route(units, target, terms, 20, {}), baseline);
  for (const status of ['exhausted', 'auth_required', 'unavailable'] as const) {
    const result = route(units, target, terms, 20, { codex: status, 'grok-build': { status, recheck_after: 0 } });
    assert.deepEqual(result.order.map(u => u.adapter), ['claude-code']);
    assert.deepEqual(result.excluded.map(u => u.reason), [
      'provider_unavailable', 'provider_unavailable',
      ...operationMismatch(units).map((entry) => entry.reason),
    ]);
  }
  assert.deepEqual(route(units, target, terms, 20, { local: 'unavailable' }), baseline);
  const collision = units.map((unit, i) => i === 0 ? { ...unit, adapter: 'local', destination: 'remote' } : unit);
  const result = route(collision, target, { ...terms, destinations: [...terms.destinations, 'remote'] }, 20, { local: 'unavailable' });
  assert.deepEqual(result.excluded, [
    { routed_unit_id: units[0]!.routed_unit_id, reason: 'provider_unavailable' },
    ...operationMismatch(units),
  ]);
  assert.deepEqual(result.order.map(u => u.adapter), ['codex', 'claude-code']);
  assert.deepEqual(route(units, target, terms, 20, { codex: 'available' }), baseline);
});
it('treats a malformed own availability entry as unavailable', () => {
  const units = table();
  for (const availability of [{ codex: null }, { codex: {} }, { codex: { status: undefined } }]) {
    const result = route(units, target, terms, 20, availability as never);
    assert.deepEqual(result.order.map(u => u.adapter), ['grok-build', 'claude-code']);
    assert.deepEqual(result.excluded, [
      { routed_unit_id: 'codex.flash', reason: 'provider_unavailable' },
      ...operationMismatch(units),
    ]);
  }
});
it('an empty table still blocks without attempting a provider', async () => {
  const gateway = createInferenceGateway({ routes: [], clock: { now: () => 0 } });
  const outcome = await gateway.generate({ request_id: 'empty', site: 'test', role: 'working', kind: 'transform', input: { instructions: '', prompt: 'work' }, terms });
  assert.equal(outcome.status, 'blocked');
  if (outcome.status === 'blocked') assert.equal(outcome.reason, 'no_route');
  assert.deepEqual(outcome.attempts, []);
});
const cases: [string, (config: any) => void, string][] = [
  ['duplicate id', c => c.units.push(c.units[0]), 'units[7].routed_unit_id: duplicate'],
  ['unsupported decision provider', c => c.decision.provider = 'openai-decisions', 'decision.provider: only typesafe-jev is supported'],
  ['unknown operation', c => c.units[0].operation = 'other', 'units[0].operation'],
  ['unknown kind', c => c.units[0].kind = 'other', 'units[0].kind: operation/kind pair'],
  ['wrong kind pair', c => c.units[0].kind = 'boolean', 'units[0].kind: operation/kind pair'],
  ['unknown tier', c => c.units[0].tier = 'fast', 'units[0].tier'],
  ['decision tier on generate', c => c.units[0].tier = 'decision', 'units[0].tier: decision tier requires evaluate'],
  ['missing operation', c => delete c.units[0].operation, 'units[0].operation'],
  ['missing units', c => delete c.units, 'units: expected array'],
  ['negative output price', c => c.units[0].price.output_per_mtok = -1, 'units[0].price.output_per_mtok'],
  ['nonnumeric input price', c => c.units[0].price.input_per_mtok = '0', 'units[0].price.input_per_mtok'],
  ['missing price', c => delete c.units[0].price, 'units[0].price'],
  ['negative input price', c => c.units[0].price.input_per_mtok = -1, 'units[0].price.input_per_mtok'],
  ['nonnumeric output price', c => c.units[0].price.output_per_mtok = '0', 'units[0].price.output_per_mtok'],
  ['nonfinite price', c => c.units[0].price.output_per_mtok = Infinity, 'units[0].price.output_per_mtok'],
  ['same fallback', c => c.decision.fallback = c.decision.provider, 'decision.fallback: must differ'],
  ['missing primary', c => c.decision.provider = 'absent', 'decision.provider: must exist'],
  ['missing fallback', c => c.decision.fallback = 'absent', 'decision.fallback: must exist'],
  ['absent fallback', c => delete c.decision.fallback, 'decision.fallback'],
  ['invalid URL scheme', c => c.decision.providers['typesafe-jev'].base_url = 'file:///tmp/x', 'decision.providers.typesafe-jev.base_url'],
  ['invalid URL', c => c.decision.providers['typesafe-jev'].base_url = 'https://', 'decision.providers.typesafe-jev.base_url'],
  ['missing settings', c => delete c.units[0].settings, 'units[0].settings'],
  ['invalid quality', c => c.units[0].quality = 'strong', 'units[0].quality'],
  ['missing model', c => delete c.decision.providers['typesafe-jev'].model, 'decision.providers.typesafe-jev.model'],
  ['missing providers', c => delete c.decision.providers, 'decision.providers'],
  ['invalid provider record', c => c.decision.providers['typesafe-jev'] = null, 'decision.providers.typesafe-jev'],
  ['invalid key env', c => c.decision.providers['typesafe-jev'].key_env = 12, 'decision.providers.typesafe-jev.key_env'],
  ['oauth with key env', c => c.decision.providers['openai-decisions'].key_env = 'OPENAI_API_KEY', 'decision.providers.openai-decisions.key_env: not allowed with chatgpt-oauth'],
  ['api-key without key env', c => c.decision.providers['openai-decisions'].auth = 'api-key', 'decision.providers.openai-decisions.key_env: required with api-key'],
  ['key env without auth', c => delete c.decision.providers['typesafe-jev'].auth, 'decision.providers.typesafe-jev.auth: required api-key with key_env'],
  ['remote provider without credentials', c => { delete c.decision.providers['typesafe-jev'].auth; delete c.decision.providers['typesafe-jev'].key_env; }, 'decision.providers.typesafe-jev: expected auth or key_env'],
  ['invalid unit', c => c.units[0] = null, 'units[0]'],
  ['missing adapter', c => delete c.units[0].adapter, 'units[0].adapter'],
  ['invalid profile version', c => c.units[0].context_profile_version = 0, 'units[0].context_profile_version'],
  ['invalid context limit', c => c.units[0].context_limit_tokens = 1.5, 'units[0].context_limit_tokens'],
  ['invalid output bound', c => c.units[0].settings.max_output_tokens = 0, 'units[0].settings.max_output_tokens'],
  ['invalid temperature', c => c.units[0].settings.temperature = Infinity, 'units[0].settings.temperature'],
  ['invalid evidence', c => c.units[0].evidence = { attempts: 2, accepted: 3 }, 'units[0].evidence.accepted'],
  ['invalid rate limits', c => c.units[0].rate_limits = [{ requests: 0, window_ms: 1 }], 'units[0].rate_limits[0]'],
  ['invalid auth', c => c.decision.providers['typesafe-jev'].auth = 12, 'decision.providers.typesafe-jev.auth'],
];
for (const [name, mutate, expected] of cases) it(`rejects ${name}`, () => {
  const input = example(); mutate(input);
  const result = parseRouteConfig(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some(e => e.includes(expected)), result.errors.join('; '));
});
it('accepts a decision tier on an evaluate unit', () => {
  const input = example();
  Object.assign(input.units[0], { tier: 'decision', operation: 'evaluate', kind: 'boolean' });
  const result = parseRouteConfig(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.table[0]?.tier, 'decision');
  assert.equal(result.table[0]?.operation, 'evaluate');
});
it('rejects malformed roots and permits null fallback and an omitted tier', () => {
  for (const input of [null, [], {}, { units: [], decision: null }]) assert.equal(parseRouteConfig(input).ok, false);
  const input = example(); input.decision.fallback = null; delete input.units[0].tier;
  assert.equal(parseRouteConfig(input).ok, true);
});
it('rejects a configured decision provider with no matching evaluate unit', () => {
  const empty = example();
  empty.units = [];
  const emptied = parseRouteConfig(empty);
  assert.equal(emptied.ok, false);
  if (!emptied.ok) assert.ok(emptied.errors.some((error) => error.includes('decision.provider: no matching evaluate unit')), emptied.errors.join('; '));

  const generateOnly = example();
  generateOnly.units = generateOnly.units.filter((unit: { operation: string }) => unit.operation !== 'evaluate');
  const generated = parseRouteConfig(generateOnly);
  assert.equal(generated.ok, false);
  if (!generated.ok) assert.ok(generated.errors.some((error) => error.includes('decision.provider: no matching evaluate unit')), generated.errors.join('; '));

  const wrongModel = example();
  for (const unit of wrongModel.units) if (unit.operation === 'evaluate') unit.model = 'other-model';
  const mismatchedModel = parseRouteConfig(wrongModel);
  assert.equal(mismatchedModel.ok, false);
  if (!mismatchedModel.ok) assert.ok(mismatchedModel.errors.some((error) => error.includes('decision.provider: no matching evaluate unit')));

  const wrongAdapter = example();
  for (const unit of wrongAdapter.units) if (unit.operation === 'evaluate') unit.adapter = 'not-typesafe';
  const mismatchedAdapter = parseRouteConfig(wrongAdapter);
  assert.equal(mismatchedAdapter.ok, false);
  if (!mismatchedAdapter.ok) assert.ok(mismatchedAdapter.errors.some((error) => error.includes('decision.provider: no matching evaluate unit')));

  const kept = example();
  kept.units = kept.units.filter((unit: { routed_unit_id: string }) => unit.routed_unit_id !== 'typesafe-jev.choice' && unit.routed_unit_id !== 'typesafe-jev.score');
  const oneKind = parseRouteConfig(kept);
  assert.equal(oneKind.ok, true);
});

it('tier never relaxes quality', () => {
  const units = table();
  const result = route(units, target, { ...terms, tier: 'flash', quality: 'high' }, 20);
  assert.deepEqual(result.order, []);
  assert.equal(result.excluded[0]?.reason, 'quality_below_bar');
  assert.equal(route(units, { ...target, tier: 'strong' }, { ...terms, tier: 'flash' }, 20).order.length, 0);
});
it('availability retains evidence tie order and exclusion declaration order', () => {
  const units = table().map(unit => ({ ...unit, evidence: { attempts: 20, accepted: 20 } }));
  const result = route(units, target, terms, 20, { codex: 'exhausted' });
  assert.deepEqual(result.order.map(u => u.adapter), ['claude-code', 'grok-build']);
  assert.deepEqual(result.excluded, [
    { routed_unit_id: 'codex.flash', reason: 'provider_unavailable' },
    ...operationMismatch(units),
  ]);
});
it('gateway passes availability into generation and evaluation routing', async () => {
  const units = table();
  const evaluateUnit = { ...units[0]!, operation: 'evaluate', kind: 'boolean', adapter: 'decision', routed_unit_id: 'decision', tier: 'decision' } as const;
  let calls = 0;
  const evaluatorIds = [...new Set([...units.filter((unit) => unit.operation === 'evaluate').map((unit) => unit.adapter), evaluateUnit.adapter])];
  const gateway = createInferenceGateway({
    routes: [...units, evaluateUnit], clock: { now: () => 0 }, availability: { 'grok-build': 'auth_required', codex: 'auth_required', 'claude-code': 'auth_required', decision: 'auth_required', ...Object.fromEntries(evaluatorIds.map(id => [id, 'auth_required' as const])) },
    adapters: units.filter((unit) => unit.operation === 'generate').map(unit => ({ id: unit.adapter, async execute() { calls++; throw new Error('must not call'); } })),
    evaluators: evaluatorIds.map((id) => ({ id, async evaluate() { calls++; throw new Error('must not call'); } })),
  });
  const generate = await gateway.generate({ request_id: 'unavailable', site: 'test', role: 'working', kind: 'transform', input: { instructions: '', prompt: 'work' }, terms });
  const evaluate = await gateway.evaluate({ request_id: 'unavailable', site: 'test', role: 'working', kind: 'boolean', state: 'work', questions: { q: { type: 'boolean', instructions: 'pass?' } }, terms });
  for (const result of [generate, evaluate]) {
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.equal(result.reason, 'provider_unavailable');
    assert.deepEqual(result.attempts, []);
  }
  assert.equal(calls, 0);
});

for (const [name, mutate, expected] of [
  ['root', (c: any) => c.extra = true, 'extra'],
  ['decision', (c: any) => c.decision.extra = true, 'decision.extra'],
  ['unit', (c: any) => c.units[0].teir = 'flash', 'units[0].teir'],
  ['settings', (c: any) => c.units[0].settings.extra = true, 'units[0].settings.extra'],
  ['price', (c: any) => c.units[0].price.extra = true, 'units[0].price.extra'],
  ['evidence', (c: any) => c.units[0].evidence = { attempts: 1, accepted: 1, extra: true }, 'units[0].evidence.extra'],
  ['rate limit', (c: any) => c.units[0].rate_limits = [{ requests: 1, window_ms: 1, extra: true }], 'units[0].rate_limits[0].extra'],
  ['provider', (c: any) => c.decision.providers['typesafe-jev'].extra = true, 'decision.providers.typesafe-jev.extra'],
] as const) it(`rejects unknown keys: ${name}`, () => {
  const input = example(); mutate(input);
  const result = parseRouteConfig(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some(e => e.includes(expected)), result.errors.join('; '));
});
it('rejects non-env-name key_env values', () => {
  for (const keyEnv of ['sk-example-not-a-real-key', 'lower_case', '1KEY']) {
    const input = example();
    input.decision.providers['typesafe-jev'].key_env = keyEnv;
    const result = parseRouteConfig(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some(e => e.includes('decision.providers.typesafe-jev.key_env')), result.errors.join('; '));
  }
});
it('accepts a loopback provider that omits auth and key_env', () => {
  const input = example();
  const provider = input.decision.providers['typesafe-jev'];
  delete provider.auth;
  delete provider.key_env;
  provider.base_url = 'http://127.0.0.1:8080';
  assert.equal(parseRouteConfig(input).ok, true);
});
it('rejects auth values outside chatgpt-oauth and api-key', () => {
  for (const auth of ['sk-example-not-a-real-key', 'chatgpt_oauth', 'bearer']) {
    const input = example();
    input.decision.providers['typesafe-jev'].auth = auth;
    const result = parseRouteConfig(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some(e => e.includes('decision.providers.typesafe-jev.auth')), result.errors.join('; '));
  }
  const accepted = example();
  accepted.decision.providers['typesafe-jev'].auth = 'api-key';
  assert.equal(parseRouteConfig(accepted).ok, true);
});
it('rejects whitespace-padded identifiers', () => {
  const cases: [(config: any) => void, (errors: string[]) => boolean][] = [
    [c => { c.units[0].routed_unit_id = ' grok-build.flash'; }, errors => errors.includes('invalid units[0].routed_unit_id')],
    [c => { c.units[0].adapter = ' grok-build'; }, errors => errors.includes('invalid units[0].adapter')],
    [c => { c.units[0].destination = ' xai.grok-build'; }, errors => errors.includes('invalid units[0].destination')],
    [c => { c.decision.provider = ' openai-decisions'; }, errors => errors.includes('invalid decision.provider')],
    [c => { c.decision.fallback = ' typesafe-jev'; }, errors => errors.includes('invalid decision.fallback')],
    [c => { c.decision.providers[' typesafe-jev'] = c.decision.providers['typesafe-jev']; }, errors => errors.some(e => e.includes('decision.providers: expected unpadded identifier'))],
    [c => { c.units[0].model = ' opus'; }, errors => errors.includes('invalid units[0].model')],
    [c => { c.units[0].context_profile = ' implementation'; }, errors => errors.includes('invalid units[0].context_profile')],
    [c => { c.units[0].prompt_template = ' implementation'; }, errors => errors.includes('invalid units[0].prompt_template')],
    [c => { c.decision.providers['typesafe-jev'].model = ' jev-latest'; }, errors => errors.includes('invalid decision.providers.typesafe-jev.model')],
  ];
  for (const [mutate, matches] of cases) {
    const input = example();
    mutate(input);
    const result = parseRouteConfig(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(matches(result.errors), result.errors.join('; '));
  }
});
it('returns config copies detached from all caller-owned nested data', () => {
  const input = example();
  input.units[0].evidence = { attempts: 2, accepted: 1 };
  input.units[0].rate_limits = [{ requests: 1, window_ms: 100 }];
  const result = parseRouteConfig(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const snapshot = structuredClone(result);
  input.units[0].settings.max_output_tokens = 1;
  input.units[0].price.input_per_mtok = 99;
  input.units[0].evidence.accepted = 0;
  input.units[0].rate_limits[0].requests = 9;
  input.units[0].adapter = 'changed';
  input.units.push(input.units[0]);
  input.decision.providers['typesafe-jev'].model = 'changed';
  assert.deepEqual(result, snapshot);
  result.decision.providers['typesafe-jev']!.model = 'output-change';
  assert.equal(input.decision.providers['typesafe-jev'].model, 'changed');
});

it('excludes remote CLI units from local-only requests', () => {
  const units = table();
  const generate = units.filter((unit) => unit.operation === 'generate');
  assert.deepEqual(generate.map(u => u.destination), ['xai.grok-build', 'openai.codex', 'anthropic.claude-code']);
  const result = route(units, target, { ...terms, destinations: ['local'] }, 20);
  assert.deepEqual(result.order, []);
  assert.deepEqual(result.excluded, [
    ...generate.map((unit) => ({ routed_unit_id: unit.routed_unit_id, reason: 'destination_not_permitted' as const })),
    ...operationMismatch(units),
  ]);
});
it('ignores inherited availability and quota-provider or destination keys', () => {
  const units = table();
  const baseline = route(units, target, terms, 20);
  assert.deepEqual(route(units, target, terms, 20, Object.create({ codex: 'exhausted' })), baseline);
  assert.deepEqual(route(units, target, terms, 20, { claude: 'exhausted', 'openai.codex': 'unavailable' }), baseline);
});
for (const [url, ok] of [
  ['http://127.0.0.1:8080', true],
  ['http://[::1]:8080', true],
  ['http://localhost:8080', true],
  ['https://api.openai.com', true],
  ['http://api.openai.com', false],
  ['http://192.168.1.1', false],
  ['http://localhost.example.com', false],
  ['http://[::2]', false],
  ['http://user:password@localhost', false],
  ['https://api.typesafe.ai/?api_key=sk-example', false],
  ['https://api.typesafe.ai/#fragment', false],
  ['https://api.typesafe.ai/?', false],
  ['https://api.typesafe.ai/#', false],
  ['https://api.typesafe.ai?', false],
  ['https://api.typesafe.ai#', false],
] as const) it(`validates provider transport security: ${url}`, () => {
  const input = example();
  input.decision.providers['typesafe-jev'].base_url = url;
  const result = parseRouteConfig(input);
  assert.equal(result.ok, ok);
  if (!result.ok) assert.ok(result.errors.some(e => e.includes('decision.providers.typesafe-jev.base_url')));
});

it('chooses the TypeSafe provider from config and honours a local base URL', async () => {
  const input = example();
  const snapshot = structuredClone(input);
  const overlaid = applyRouteOverlay(input, {
    decision: { providers: { 'typesafe-jev': { base_url: 'http://127.0.0.1:9/' } } },
  });
  assert.deepEqual(input, snapshot);
  const parsed = parseRouteConfig(overlaid);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const binding = bindDecisionProvider(parsed.decision);
  assert.equal(binding.provider, 'typesafe-jev');
  assert.equal(binding.adapter, 'typesafe-ai');
  assert.equal(binding.model, 'jev-latest');
  assert.equal(parsed.decision.providers['typesafe-jev']?.auth, 'api-key');
  assert.equal(binding.baseURL, 'http://127.0.0.1:9/');

  let sent: { url: string; body: Record<string, unknown>; authorization: string } | undefined;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, authorization: headers['authorization'] ?? '' };
    return new Response(JSON.stringify({
      answers: { q: { type: 'noul', noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'x-typesafe-request-id': 'req_local' } });
  }) as typeof globalThis.fetch;
  const evaluator = typesafeAiEvaluator({ apiKey: 'test-key', baseURL: binding.baseURL, fetch });
  assert.equal(evaluator.id, binding.adapter);
  const result = await evaluator.evaluate({
    model: binding.model,
    kind: 'boolean',
    state: 'local jev',
    questions: { q: { type: 'boolean', instructions: 'ready?' } },
    signal: undefined,
  });
  assert.equal(sent?.url, 'http://127.0.0.1:9/v1/systemone');
  assert.equal(sent?.authorization, 'Bearer test-key');
  assert.equal(sent?.body['model'], 'jev-latest');
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.provider_response_id, 'req_local');
  assert.throws(
    () => bindDecisionProvider({ provider: 'openai-decisions', fallback: null, providers: {} }),
    /only typesafe-jev is supported/,
  );
});

it('binds Amos only for the configured intake site and rejects unknown overrides', () => {
  const input = example();
  input.decision.providers.amos = { base_url: 'http://127.0.0.1:8766', model: 'amos-1-2b' };
  input.decision.sites = { 'intake.classify': 'amos' };
  input.units = input.units.filter((u: any) => u.adapter !== 'amos');
  input.units.push({ ...input.units.find((u: any) => u.kind === 'choice'), routed_unit_id: 'amos.choice', adapter: 'amos', model: 'amos-1-2b', destination: 'amos' });
  const parsed = parseRouteConfig(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(bindDecisionProvider(parsed.decision, 'intake.classify').adapter, 'amos');
  assert.equal(bindDecisionProvider(parsed.decision, 'loop.triage').model, 'jev-latest');
  for (const sites of [{ typo: 'amos' }, { 'intake.classify': 'unknown' }, { 'loop.triage': 'amos' }]) {
    assert.equal(parseRouteConfig({ ...input, decision: { ...input.decision, sites } }).ok, false);
  }
  assert.equal(parseRouteConfig({ ...input, decision: { ...input.decision, providers: { ...input.decision.providers, unknown: input.decision.providers.amos } } }).ok, false);
});
