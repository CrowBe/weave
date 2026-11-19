/**
 * G6: a routing preference set is data the gateway loads without importing
 * Gauge. The fixture is a copy of Gauge's valid `gauge.preference@1` record
 * (packages/gauge/fixtures/records.json, "a routing preference set over
 * recorded results"). A preference orders what deterministic policy admits;
 * it cannot route around privacy, training-allowed destinations, credential
 * screening, quality, the cost ceiling or budget policy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { budgetRoute } from '../src/budget.js';
import { createInferenceGateway } from '../src/gateway.js';
import { applyPreferences, loadPreferenceSet, type PreferenceSet } from '../src/preferences.js';
import { route } from '../src/routing.js';
import type {
  EvaluationAdapter,
  EvaluationRequest,
  InferenceTerms,
  QuotaSnapshot,
  RoutedUnit,
  RouteTable,
} from '../src/types.js';

const fixture: unknown = JSON.parse(
  readFileSync(new URL('../../test/fixtures/gauge-preference.json', import.meta.url), 'utf8'),
);
const loaded = loadPreferenceSet(fixture);
assert.ok(loaded.ok, loaded.ok ? '' : loaded.reason);
const SET: PreferenceSet = loaded.set;

/** Best accept-rate low end in the set (0.87 of 120). */
const PREFERRED = 'boolean.task@jev-1.14.0';
/** Meets its bar with a lower low end (0.80 of 120). */
const SECOND = 'boolean.task@jev-1.13.0';
/** Misses its bar in the set; configured with a stale perfect record. */
const MISSES = 'boolean.task@amos-small';
/** Not named by the set; keeps its configured evidence. */
const LOCAL = 'boolean.task@kev-local';

const unit = (
  id: string,
  destination: string,
  billing: RoutedUnit['billing'],
  extra: Partial<RoutedUnit> = {},
): RoutedUnit =>
  ({
    routed_unit_id: id,
    operation: 'evaluate',
    kind: 'boolean',
    adapter: 'fake',
    model: id,
    context_profile: 'decision',
    context_profile_version: 1,
    prompt_template: 'boolean',
    prompt_template_version: 1,
    settings: { max_output_tokens: 10 },
    destination,
    billing,
    quality: 'high',
    context_limit_tokens: 1000,
    price: { input_per_mtok: 1000, output_per_mtok: 1000 },
    ...extra,
  }) as RoutedUnit;

const TABLE: RouteTable = [
  unit(MISSES, 'vendor', 'metered', { evidence: { attempts: 100, accepted: 100 } }),
  unit(SECOND, 'vendor', 'metered'),
  unit(LOCAL, 'local', 'local', { evidence: { attempts: 50, accepted: 25 } }),
  unit(PREFERRED, 'contrib', 'metered', { destination_training_allowed: true }),
];
const TARGET = { operation: 'evaluate', kind: 'boolean' } as const;
const terms = (overrides: Partial<InferenceTerms> = {}): InferenceTerms => ({
  quality: 'high',
  destinations: ['vendor', 'local', 'contrib'],
  content_class: 'public',
  max_context_tokens: 100,
  deadline: 1_000_000,
  cost_ceiling: 1_000,
  max_attempts: 3,
  ...overrides,
});
const ids = (units: readonly RoutedUnit[]) => units.map((u) => u.routed_unit_id);
const applied = (table: RouteTable = TABLE) => applyPreferences(table, SET);
const reasonFor = (excluded: readonly { routed_unit_id: string; reason: string }[], id: string) =>
  excluded.find((e) => e.routed_unit_id === id)?.reason;

function harness(routes: RouteTable, quota?: QuotaSnapshot) {
  const models: string[] = [];
  const evaluator: EvaluationAdapter = {
    id: 'fake',
    async evaluate(call) {
      models.push(call.model);
      return {
        status: 'completed',
        answers: { holds: { type: 'boolean', probability: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 1 },
        provider_response_id: undefined,
        confidence: undefined,
      };
    },
  };
  const gateway = createInferenceGateway({
    routes,
    evaluators: [evaluator],
    clock: { now: () => 100 },
    ...(quota === undefined
      ? {}
      : {
          quota: {
            async read() {
              return quota;
            },
          },
          async persist_pause() {},
        }),
  });
  return { gateway, models };
}
const request = (t: InferenceTerms, state = 'the change is ready'): EvaluationRequest<'boolean'> => ({
  request_id: 'pref',
  site: 'decision.test',
  role: 'working',
  kind: 'boolean',
  state,
  questions: { holds: { type: 'boolean', instructions: 'Does it hold?' } },
  terms: t,
});

test('the gateway loads the Gauge preference fixture as data', () => {
  assert.equal(SET.schema, 'gauge.preference@1');
  assert.equal(SET.preference, 'decision-sites.routing@1');
  assert.equal(SET.accept, 'accuracy');
  assert.deepEqual(
    SET.entries.map((e) => [e.routed_unit, e.verdict]),
    [
      [PREFERRED, 'meets_bar'],
      [SECOND, 'meets_bar'],
      [MISSES, 'misses_bar'],
      ['boolean.task@jev-1.15.0', 'insufficient_evidence'],
    ],
  );
});

test('a preference set cannot carry route fields, and malformed sets fail closed', () => {
  const set = fixture as PreferenceSet;
  const entry = set.entries[0]!;
  const withEntry = (patch: object) => ({ ...set, entries: [{ ...entry, ...patch }, ...set.entries.slice(1)] });
  const accuracy = (patch: object) =>
    withEntry({ measures: entry.measures.map((m) => (m.measure === 'accuracy' ? { ...m, ...patch } : m)) });
  const refused: [string, unknown][] = [
    ['not an object', null],
    ['another schema', { ...set, schema: 'gauge.preference@2' }],
    ['a route table', { ...set, routes: [] }],
    ['a training mark', withEntry({ destination_training_allowed: false })],
    ['a destination', withEntry({ destination: 'contrib' })],
    ['a price', withEntry({ price: { input_per_mtok: 0, output_per_mtok: 0 } })],
    ['no entries', { ...set, entries: [] }],
    ['a unit twice', { ...set, entries: [entry, entry] }],
    ['no accept measure', withEntry({ measures: entry.measures.filter((m) => m.measure !== 'accuracy') })],
    ['a value outside its interval', accuracy({ value: 0.99 })],
    ['a value without samples', accuracy({ n: 0 })],
    ['an accept rate above one', accuracy({ value: 1.2, interval: [1.1, 1.3] })],
    ['an unknown verdict', withEntry({ verdict: 'preferred' })],
  ];
  for (const [label, value] of refused) assert.equal(loadPreferenceSet(value).ok, false, label);
});

test('applying a set replaces evidence on the units it names and changes nothing else', () => {
  const after = applied();
  assert.deepEqual(ids(after), ids(TABLE), 'a set cannot add, drop or reorder units');
  const byId = new Map(after.map((u) => [u.routed_unit_id, u]));
  assert.deepEqual(byId.get(PREFERRED)!.evidence, { attempts: 120, accepted: 104 });
  assert.deepEqual(byId.get(SECOND)!.evidence, { attempts: 120, accepted: 96 });
  assert.equal(byId.get(MISSES)!.evidence, undefined, 'a unit that missed its bar earns no preference');
  assert.deepEqual(byId.get(LOCAL)!.evidence, { attempts: 50, accepted: 25 });
  for (const [before, now] of TABLE.map((u, i) => [u, after[i]!] as const)) {
    const { evidence: _a, ...rest } = before;
    const { evidence: _b, ...restNow } = now;
    assert.deepEqual(restNow, rest, `${before.routed_unit_id}: only evidence may change`);
  }
  // An entry for a unit the table lacks is ignored.
  assert.deepEqual(
    ids(
      applyPreferences(
        TABLE.filter((u) => u.routed_unit_id !== PREFERRED),
        SET,
      ),
    ),
    [MISSES, SECOND, LOCAL],
  );
});

test('an entry without a decided verdict earns no preference, whatever its interval', () => {
  // The insufficient_evidence entry has an accept interval whose low end (0.6 of 12) would otherwise earn 7.
  const UNDECIDED = 'boolean.task@jev-1.15.0';
  const entry = SET.entries.find((e) => e.routed_unit === UNDECIDED)!;
  assert.equal(entry.verdict, 'insufficient_evidence');
  const table: RouteTable = [
    unit(UNDECIDED, 'vendor', 'metered', { evidence: { attempts: 100, accepted: 100 } }),
    unit(SECOND, 'vendor', 'metered'),
  ];
  const [undecided] = applyPreferences(table, SET);
  assert.equal(undecided!.evidence, undefined, 'insufficient_evidence never becomes routing evidence');
  assert.deepEqual(ids(route(applyPreferences(table, SET), TARGET, terms(), 20).order), [SECOND, UNDECIDED]);
});

test('a meets_bar entry with a zero-width accept interval is refused, never credited', () => {
  // As in Gauge's G5 rule, an interval with lo = hi (one sample, or all-equal samples) is insufficient evidence.
  const set = fixture as PreferenceSet;
  const pinned = (e: PreferenceSet['entries'][number], interval: readonly [number, number]) => ({
    ...e,
    measures: e.measures.map((m) => (m.measure === 'accuracy' ? { ...m, interval } : m)),
  });
  const zeroWidth = { ...set, entries: [pinned(set.entries[0]!, [0.91, 0.91]), ...set.entries.slice(1)] };
  const refused = loadPreferenceSet(zeroWidth);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.reason, /zero-width/);
  // Other measures, and entries that earn nothing anyway, may still carry a zero-width interval.
  const cost = {
    ...set,
    entries: [
      {
        ...set.entries[0]!,
        measures: set.entries[0]!.measures.map((m) => (m.measure === 'cost' ? { ...m, interval: [120, 120] } : m)),
      },
      ...set.entries.slice(1),
    ],
  };
  assert.equal(loadPreferenceSet(cost).ok, true, 'a zero-width non-accept measure');
  const misses = set.entries.findIndex((e) => e.verdict === 'misses_bar');
  const missed = { ...set, entries: set.entries.map((e, i) => (i === misses ? pinned(e, [0.7, 0.7]) : e)) };
  assert.equal(loadPreferenceSet(missed).ok, true, 'a zero-width accept interval on a misses_bar entry');
  // A set built without the loader still earns no evidence from it.
  const table: RouteTable = [unit(PREFERRED, 'vendor', 'metered', { evidence: { attempts: 100, accepted: 100 } })];
  assert.equal(applyPreferences(table, zeroWidth as PreferenceSet)[0]!.evidence, undefined);
});

test('among admitted units, a preference orders by expected cost', () => {
  // Configured evidence alone: the stale perfect record leads, unevidenced units follow in table order.
  assert.deepEqual(ids(route(TABLE, TARGET, terms(), 20).order), [MISSES, LOCAL, SECOND, PREFERRED]);
  const after = route(applied(), TARGET, terms(), 20);
  assert.deepEqual(ids(after.order), [PREFERRED, SECOND, LOCAL, MISSES]);
  assert.deepEqual(after.excluded, []);
  assert.ok(
    after.uncertainty.some((note) => note.includes(MISSES)),
    'the unit without evidence is noted',
  );
});

test('a preference cannot route sensitive content to a training-allowed destination', async () => {
  for (const content_class of ['sensitive', 'private', undefined] as const) {
    const t =
      content_class === undefined ? (({ content_class: _c, ...rest }) => rest)(terms()) : terms({ content_class });
    const decision = route(applied(), TARGET, t, 20);
    assert.equal(reasonFor(decision.excluded, PREFERRED), 'destination_not_permitted', String(content_class));
    assert.deepEqual(ids(decision.order), [SECOND, LOCAL, MISSES]);
    const { gateway, models } = harness(applied());
    const outcome = await gateway.evaluate(request(t));
    assert.equal(outcome.status, 'accepted');
    assert.deepEqual(models, [SECOND], 'the preferred training destination received nothing');
  }
});

test('a preference cannot route around permitted destinations or credential screening', async () => {
  const narrow = route(applied(), TARGET, terms({ destinations: ['vendor', 'local'] }), 20);
  assert.equal(reasonFor(narrow.excluded, PREFERRED), 'destination_not_permitted');
  assert.deepEqual(ids(narrow.order), [SECOND, LOCAL, MISSES]);

  const credential = route(applied(), TARGET, terms(), 20, undefined, true);
  assert.equal(reasonFor(credential.excluded, PREFERRED), 'credential_content');
  const { gateway, models } = harness(applied());
  const outcome = await gateway.evaluate(request(terms(), 'deploy with sk-live-0123456789abcdef'));
  assert.equal(outcome.status, 'accepted');
  assert.deepEqual(models, [SECOND]);
});

test('a preference cannot route around the quality bar or the cost ceiling', () => {
  const weak = TABLE.map((u) => (u.routed_unit_id === PREFERRED ? { ...u, quality: 'baseline' as const } : u));
  assert.equal(
    reasonFor(route(applyPreferences(weak, SET), TARGET, terms(), 20).excluded, PREFERRED),
    'quality_below_bar',
  );
  const dear = TABLE.map((u) =>
    u.routed_unit_id === PREFERRED ? { ...u, price: { input_per_mtok: 1e9, output_per_mtok: 1e9 } } : u,
  );
  assert.equal(reasonFor(route(applyPreferences(dear, SET), TARGET, terms(), 20).excluded, PREFERRED), 'unaffordable');
});

test('a preference cannot route around budget policy', async () => {
  const capped: QuotaSnapshot = {
    observed_at: 100,
    providers: [
      {
        provider: 'contrib-account',
        status: 'fresh',
        windows: [{ id: 'seven_day', percentRemaining: 10, resetsAt: 500_000, pace: { status: 'on_pace' } }],
      },
    ],
  };
  const table = TABLE.map((u) =>
    u.routed_unit_id === PREFERRED ? { ...u, billing: 'subscription' as const, quota_provider: 'contrib-account' } : u,
  );
  const decision = budgetRoute(applyPreferences(table, SET), TARGET, terms(), 20, undefined, capped, 100);
  assert.equal(reasonFor(decision.excluded, PREFERRED), 'weekly_budget_cap');
  assert.deepEqual(ids(decision.order), [SECOND, LOCAL, MISSES]);
  const { gateway, models } = harness(applyPreferences(table, SET), capped);
  const outcome = await gateway.evaluate(request(terms()));
  assert.equal(outcome.status, 'accepted');
  assert.deepEqual(models, [SECOND]);
});
