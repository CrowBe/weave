/**
 * Routing preference sets: eval-derived routing evidence the gateway reads as
 * data (GLOSSARY.md "Routing preference set"). The schema is Gauge's
 * `gauge.preference@1` (packages/gauge/src/GAUGE-CONTRACT.md); this package
 * does not import Gauge, and Gauge does not import it. The loader reads the
 * fields routing needs and fails closed on anything else.
 *
 * A preference only orders routes. `applyPreferences` replaces the `evidence`
 * of the routed units a set names and changes no other field, so
 * deterministic policy (destinations, training-allowed destinations,
 * credential screening, tier, quality, context, cost ceiling and
 * budget.policy@1) still filters every unit before evidence is read. Applying
 * a set is a governed promotion owned by the composition root, not by Gauge
 * or by the gateway.
 */
import type { RouteEvidence, RoutedUnitId, RouteTable } from './types.js';

export const PREFERENCE_SCHEMA = 'gauge.preference@1';

export type PreferenceVerdict = 'meets_bar' | 'misses_bar' | 'insufficient_evidence';

export interface PreferenceMeasure {
  readonly measure: string;
  readonly value: number | null;
  readonly n: number;
  readonly interval: readonly [lo: number, hi: number] | null;
}

export interface PreferenceEntry {
  readonly routed_unit: RoutedUnitId;
  /** The Gauge evaluation result this entry was copied from. */
  readonly result: string;
  readonly verdict: PreferenceVerdict;
  readonly measures: readonly PreferenceMeasure[];
}

export interface PreferenceSet {
  readonly schema: typeof PREFERENCE_SCHEMA;
  /** Name and revision, e.g. `decision-sites.routing@3`. */
  readonly preference: string;
  readonly workload: string;
  readonly criteria: string;
  readonly caseset: string;
  readonly split: 'tune' | 'holdout';
  readonly mode: 'replay' | 'trial' | 'live';
  /** The measure read as each routed unit's accept rate. */
  readonly accept: string;
  readonly entries: readonly PreferenceEntry[];
}

export type PreferenceLoad =
  | { readonly ok: true; readonly set: PreferenceSet }
  | { readonly ok: false; readonly reason: string };

type Obj = Readonly<Record<string, unknown>>;
const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const hasExactly = (o: Obj, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const isText = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const oneOf = (x: unknown, ...vocabulary: string[]) => typeof x === 'string' && vocabulary.includes(x);
/** An interval with width. A zero-width one (one sample, or all-equal samples) is insufficient evidence, as in Gauge. */
const hasWidth = (interval: readonly [number, number]): boolean => interval[0] < interval[1];

const SET_KEYS = ['schema', 'preference', 'workload', 'criteria', 'caseset', 'split', 'mode', 'accept', 'entries'];
const ENTRY_KEYS = ['routed_unit', 'result', 'verdict', 'measures'];
const MEASURE_KEYS = ['measure', 'value', 'n', 'interval'];
const MAX_ENTRIES = 64;
const MAX_MEASURES = 32;

/** A measure entry that is consistent with itself: no samples, no value, no interval. */
function measureShaped(m: unknown): m is PreferenceMeasure {
  if (!isObject(m) || !hasExactly(m, MEASURE_KEYS) || !isText(m.measure)) return false;
  if (!Number.isSafeInteger(m.n) || (m.n as number) < 0) return false;
  if (m.value === null) return m.n === 0 && m.interval === null;
  if (!isNumber(m.value) || m.n === 0) return false;
  if (m.interval === null) return true;
  const i = m.interval;
  return Array.isArray(i) && i.length === 2 && isNumber(i[0]) && isNumber(i[1]) && i[0] <= m.value && m.value <= i[1];
}

/**
 * Read a preference set as data. Closed keys at every level, so a set cannot
 * carry a route, price, destination or training mark. Bindings to Gauge's
 * results are Gauge's to check before the set is promoted; the gateway checks
 * what it reads.
 */
export function loadPreferenceSet(value: unknown): PreferenceLoad {
  const fail = (reason: string): PreferenceLoad => ({ ok: false, reason });
  if (!isObject(value) || value.schema !== PREFERENCE_SCHEMA) return fail(`not a ${PREFERENCE_SCHEMA} record`);
  if (!hasExactly(value, SET_KEYS)) return fail('unexpected or missing keys');
  if (
    !isText(value.preference) ||
    !isText(value.workload) ||
    !isText(value.criteria) ||
    !isText(value.caseset) ||
    !oneOf(value.split, 'tune', 'holdout') ||
    !oneOf(value.mode, 'replay', 'trial', 'live') ||
    !isText(value.accept)
  ) {
    return fail('malformed header');
  }
  const entries = value.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES)
    return fail('entries out of bounds');
  const seen = new Set<string>();
  for (const e of entries as unknown[]) {
    if (
      !isObject(e) ||
      !hasExactly(e, ENTRY_KEYS) ||
      !isText(e.routed_unit) ||
      !isText(e.result) ||
      !oneOf(e.verdict, 'meets_bar', 'misses_bar', 'insufficient_evidence')
    ) {
      return fail('malformed entry');
    }
    if (seen.has(e.routed_unit)) return fail(`routed unit ${e.routed_unit} named twice`);
    seen.add(e.routed_unit);
    const measures = e.measures;
    if (
      !Array.isArray(measures) ||
      measures.length > MAX_MEASURES ||
      !measures.every(measureShaped) ||
      new Set(measures.map((m) => m.measure)).size !== measures.length
    ) {
      return fail(`malformed measures for ${e.routed_unit}`);
    }
    const accept = measures.find((m) => m.measure === value.accept);
    if (accept === undefined) return fail(`no ${value.accept} measure for ${e.routed_unit}`);
    if ([accept.value, ...(accept.interval ?? [])].some((x) => x !== null && (x < 0 || x > 1))) {
      return fail(`accept rate out of range for ${e.routed_unit}`);
    }
    if (e.verdict === 'meets_bar' && accept.interval !== null && !hasWidth(accept.interval)) {
      return fail(`zero-width accept interval for ${e.routed_unit}`);
    }
  }
  return { ok: true, set: value as unknown as PreferenceSet };
}

/**
 * Evidence an entry supports. Only an entry whose result met its bar earns
 * any, and it is credited with the low end of its accept interval, so a thin
 * or uncertain sample earns little. No interval, a zero-width one, or a low
 * end of zero, earns none: routing then keeps its configured order and
 * records the uncertainty.
 */
function evidenceOf(entry: PreferenceEntry, accept: string): RouteEvidence | undefined {
  if (entry.verdict !== 'meets_bar') return undefined;
  const m = entry.measures.find((x) => x.measure === accept);
  if (m === undefined || m.interval === null || !hasWidth(m.interval) || m.n === 0) return undefined;
  const accepted = Math.floor(m.interval[0] * m.n);
  return accepted > 0 ? { attempts: m.n, accepted } : undefined;
}

/**
 * Replace `evidence` on the units a set names; leave every other field, and
 * every unit it does not name, as configured. A set cannot add a unit: an
 * entry for a unit absent from the table is ignored.
 */
export function applyPreferences(table: RouteTable, set: PreferenceSet): RouteTable {
  const entries = new Map(set.entries.map((e) => [e.routed_unit, e] as const));
  return table.map((unit) => {
    const entry = entries.get(unit.routed_unit_id);
    if (entry === undefined) return unit;
    const { evidence: _configured, ...rest } = unit;
    const evidence = evidenceOf(entry, set.accept);
    return evidence === undefined ? rest : { ...rest, evidence };
  });
}
