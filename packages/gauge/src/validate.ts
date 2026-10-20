/**
 * Validator for Gauge's evaluation records (GAUGE-CONTRACT.md). It returns the
 * first applicable rejection reason in the contract's order, and recomputes
 * every constraint status and verdict instead of trusting the record's claim.
 *
 * A record that binds a criteria set, case set or result is checked against
 * the bound record from `context`. That bound record must itself validate:
 * an unknown or malformed one is a `binding` failure, never a crash.
 */
import { KIND_FIELDS, isCode, isCount, isDigest, isId, isKind, isMetric, isRatio } from '@weave/weft';
import { recordDigest } from './digest.js';
import type {
  CaseSet,
  ComparisonVerdict,
  ConstraintDefinition,
  ConstraintStatus,
  Context,
  CriteriaSet,
  EvaluationCost,
  EvaluationResult,
  Interval,
  Rejection,
  ResultVerdict,
  Revision,
  Verdict,
} from './types.js';

type Obj = Readonly<Record<string, unknown>>;

const OK: Verdict = { ok: true };
const reject = (reason: Rejection): Verdict => ({ ok: false, reason });

const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const hasExactly = (o: Obj, keys: readonly string[]): boolean =>
  keys.every(k => Object.hasOwn(o, k)) && Object.keys(o).every(k => keys.includes(k));
const oneOf = (x: unknown, ...vocabulary: string[]): boolean => typeof x === 'string' && vocabulary.includes(x);
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInterval = (x: unknown): x is Interval =>
  Array.isArray(x) && x.length === 2 && isNumber(x[0]) && isNumber(x[1]) && x[0] <= x[1];
const objects = (x: unknown, min: number, max: number, keys: readonly string[]): x is readonly Obj[] =>
  Array.isArray(x) && x.length >= min && x.length <= max && x.every(e => isObject(e) && hasExactly(e, keys));
const unique = (items: readonly Obj[], key: (o: Obj) => string): boolean =>
  new Set(items.map(key)).size === items.length;

const REV = /^[A-Za-z0-9_.:-]{1,120}@[0-9]{1,9}$/;
const isRev = (x: unknown): x is string => typeof x === 'string' && REV.test(x);

const isGovernance = (x: unknown): boolean =>
  isObject(x) && hasExactly(x, ['kind', 'ref']) && oneOf(x.kind, 'policy', 'approval') && typeof x.ref === 'string';

const EVIDENCE_SOURCES = ['weft_trace', 'check', 'held_out_report', 'observation'];
const evidenceKey = (e: Obj): string => `${e.source as string}\u0000${e.ref as string}`;
const evidenceShaped = (x: unknown, min: number, max: number): x is readonly Obj[] =>
  objects(x, min, max, ['source', 'ref'])
  && x.every(e => oneOf(e.source, ...EVIDENCE_SOURCES) && typeof e.ref === 'string')
  && unique(x, evidenceKey);

/** Weft kinds a replay cannot measure: it never takes the actions they report. */
export const OUTCOME_KINDS: ReadonlySet<string> = new Set(['outcome', 'capability.invoked', 'action.transition']);
/** Recomputation tolerance for deltas. */
const EPSILON = 1e-9;

export function validate(value: unknown, context: Context): Verdict {
  if (!isObject(value)) return reject('envelope');
  switch (value.schema) {
    case 'gauge.criteria@1':
      return validateCriteria(value);
    case 'gauge.caseset@1':
      return validateCaseSet(value);
    case 'gauge.revision@1':
      return validateRevision(value, context);
    case 'gauge.result@1':
      return validateResult(value, context);
    case 'gauge.comparison@1':
      return validateComparison(value, context);
    case 'gauge.cost@1':
      return validateCost(value, context);
    case 'gauge.preference@1':
      return validatePreference(value, context);
    case 'gauge.attribution@1':
      return validateAttribution(value, context);
    default:
      return reject('envelope');
  }
}

// gauge.criteria@1

function validateCriteria(r: Obj): Verdict {
  if (!hasExactly(r, ['schema', 'criteria', 'workload', 'governed_by', 'method', 'measures', 'constraints'])) {
    return reject('envelope');
  }
  const m = r.method;
  if (typeof r.criteria !== 'string' || typeof r.workload !== 'string' || !isGovernance(r.governed_by)) return reject('envelope');
  if (!isObject(m) || !hasExactly(m, ['interval', 'level', 'seed', 'min_samples'])
    || !oneOf(m.interval, 'wilson@1', 'bootstrap@1')
    || !isNumber(m.level) || m.level <= 0 || m.level >= 1
    || !isCount(m.seed) || !isCount(m.min_samples) || m.min_samples < 1) {
    return reject('envelope');
  }
  const measures = r.measures;
  if (!objects(measures, 1, 32, ['measure', 'source', 'aggregate', 'better', 'min_effect'])) return reject('envelope');
  for (const d of measures) {
    const s = d.source;
    const sourceShaped = isObject(s) && (
      (hasExactly(s, ['weft_kind', 'field']) && isCode(s.weft_kind) && isCode(s.field))
      || (hasExactly(s, ['evidence']) && oneOf(s.evidence, 'check', 'held_out_report')));
    if (!isCode(d.measure) || !sourceShaped || !oneOf(d.aggregate, 'rate', 'mean', 'sum', 'p95')
      || !oneOf(d.better, 'higher', 'lower') || !isMetric(d.min_effect)) {
      return reject('envelope');
    }
  }
  const constraints = r.constraints;
  if (!objects(constraints, 0, 32, ['constraint', 'measure', 'op', 'bound', 'role'])) return reject('envelope');
  for (const c of constraints) {
    if (!isCode(c.constraint) || !isCode(c.measure) || !oneOf(c.op, 'ge', 'le') || !isNumber(c.bound)
      || !oneOf(c.role, 'quality_bar', 'protected')) {
      return reject('envelope');
    }
  }

  if (!isRev(r.criteria) || !isId(r.workload) || !isId((r.governed_by as Obj).ref)) return reject('ref');

  for (const d of measures) {
    const s = d.source as Obj;
    if (Object.hasOwn(s, 'weft_kind') && !(isKind(s.weft_kind) && KIND_FIELDS[s.weft_kind].includes(s.field as string))) {
      return reject('measure');
    }
  }
  if (!unique(measures, d => d.measure as string)) return reject('measure');
  if (m.interval === 'wilson@1' && !measures.every(d => d.aggregate === 'rate')) return reject('measure');

  if (!unique(constraints, c => c.constraint as string)) return reject('constraint');
  const names = new Set(measures.map(d => d.measure));
  if (!constraints.every(c => names.has(c.measure))) return reject('constraint');

  return OK;
}

// gauge.caseset@1

function validateCaseSet(r: Obj): Verdict {
  if (!hasExactly(r, ['schema', 'caseset', 'workload', 'governed_by', 'splits'])) return reject('envelope');
  if (typeof r.caseset !== 'string' || typeof r.workload !== 'string' || !isGovernance(r.governed_by)) return reject('envelope');
  const splits = r.splits;
  if (!objects(splits, 1, 2, ['split', 'digest', 'size'])) return reject('envelope');
  if (!splits.every(s => oneOf(s.split, 'tune', 'holdout') && typeof s.digest === 'string' && isCount(s.size) && s.size >= 1)) {
    return reject('envelope');
  }
  if (!unique(splits, s => s.split as string)) return reject('envelope');

  if (!isRev(r.caseset) || !isId(r.workload) || !isId((r.governed_by as Obj).ref)) return reject('ref');
  if (!splits.every(s => isDigest(s.digest))) return reject('ref');
  // A holdout that is the tune split is visible to whoever tunes.
  if (splits.length === 2 && splits[0]!.digest === splits[1]!.digest) return reject('holdout');
  return OK;
}

// gauge.revision@1

const REVISION_KEYS = ['schema', 'revision', 'record', 'digest', 'supersedes', 'issued_by', 'justification', 'evidence'];
type SetKind = Revision['record'];

/** An own entry of a context table, or undefined. A missing table holds nothing. */
const entryOf = (table: unknown, key: string): unknown =>
  isObject(table) && Object.hasOwn(table, key) ? table[key] : undefined;

/** A revision number a chain can hold: a positive integer without leading zeros. */
function revisionNumber(rev: string): number | null {
  const m = /@([1-9][0-9]*)$/.exec(rev);
  return m === null ? null : Number(m[1]);
}

function revisionShape(r: Obj): Verdict {
  if (!hasExactly(r, REVISION_KEYS)) return reject('envelope');
  if (typeof r.revision !== 'string' || !oneOf(r.record, 'criteria', 'caseset') || typeof r.digest !== 'string'
    || !(r.supersedes === null || typeof r.supersedes === 'string') || !isGovernance(r.issued_by)
    || !isCode(r.justification) || !evidenceShaped(r.evidence, 0, 16)) {
    return reject('envelope');
  }
  if (!isRev(r.revision) || !(r.supersedes === null || isRev(r.supersedes)) || !isDigest(r.digest)
    || !isId((r.issued_by as Obj).ref) || !r.evidence.every(e => isId(e.ref))) {
    return reject('ref');
  }
  return OK;
}

/** A criteria set or case set filed under its own name that validates. Recording is checked separately. */
function governedSet(context: Context, kind: SetKind, name: string): CriteriaSet | CaseSet | null {
  const set = entryOf(kind === 'criteria' ? context.criteria : context.casesets, name);
  if (!isObject(set)) return null;
  const filed = kind === 'criteria'
    ? set.schema === 'gauge.criteria@1' && set.criteria === name && validateCriteria(set).ok
    : set.schema === 'gauge.caseset@1' && set.caseset === name && validateCaseSet(set).ok;
  return filed ? set as unknown as CriteriaSet | CaseSet : null;
}

/** One link binds: its set is known with this digest, and it names the revision before it. */
function linkBinds(r: Revision, context: Context): boolean {
  const set = governedSet(context, r.record, r.revision);
  const n = revisionNumber(r.revision);
  if (set === null || n === null || recordDigest(set) !== r.digest) return false;
  if (n === 1) return r.supersedes === null;
  return r.supersedes === `${r.revision.slice(0, r.revision.lastIndexOf('@'))}@${n - 1}`
    && governedSet(context, r.record, r.supersedes) !== null;
}

/** Only the governor of the superseded set (for @1, of the set itself) issues a link, with evidence for a change. */
function linkGoverned(r: Revision, context: Context): boolean {
  const governor = governedSet(context, r.record, r.supersedes ?? r.revision)!.governed_by;
  return r.issued_by.kind === governor.kind && r.issued_by.ref === governor.ref
    && (r.supersedes === null || r.evidence.length > 0);
}

/**
 * Whether a revision in `context` records this set: every link back to @1
 * validates. Walked iteratively, so a long chain cannot exhaust the stack.
 */
function recorded(context: Context, kind: SetKind, name: string): boolean {
  let rev: string | null = name;
  while (rev !== null) {
    const r = entryOf(context.revisions, rev);
    if (!isObject(r) || r.schema !== 'gauge.revision@1' || r.revision !== rev || !revisionShape(r).ok || r.record !== kind) {
      return false;
    }
    const link = r as unknown as Revision;
    if (!linkBinds(link, context) || !linkGoverned(link, context)) return false;
    rev = link.supersedes;
  }
  return true;
}

function validateRevision(r: Obj, context: Context): Verdict {
  const shape = revisionShape(r);
  if (!shape.ok) return shape;
  const link = r as unknown as Revision;
  if (!linkBinds(link, context)) return reject('binding');
  if (link.supersedes !== null && !recorded(context, link.record, link.supersedes)) return reject('binding');
  if (!linkGoverned(link, context)) return reject('governance');
  return OK;
}

// gauge.result@1

/** A result's measure entries, as a result or a preference entry carries them. */
const measureEntriesShaped = (x: unknown): x is readonly Obj[] =>
  objects(x, 0, 32, ['measure', 'value', 'n', 'interval'])
  && x.every(e => isCode(e.measure) && (e.value === null || isNumber(e.value)) && isCount(e.n)
    && (e.interval === null || isInterval(e.interval)));

const RESULT_KEYS = [
  'schema', 'result', 'subject', 'criteria', 'caseset', 'split', 'caseset_digest',
  'mode', 'evidence', 'measures', 'constraints', 'verdict',
];

/** A criteria set is known only while a governed revision records it. */
export function boundCriteria(context: Context, name: unknown): CriteriaSet | null {
  if (typeof name !== 'string') return null;
  const set = governedSet(context, 'criteria', name);
  return set !== null && recorded(context, 'criteria', name) ? set as CriteriaSet : null;
}

/** A case set is known only while a governed revision records it. */
export function boundCaseSet(context: Context, name: unknown): CaseSet | null {
  if (typeof name !== 'string') return null;
  const set = governedSet(context, 'caseset', name);
  return set !== null && recorded(context, 'caseset', name) ? set as CaseSet : null;
}

export function boundResult(context: Context, id: unknown): EvaluationResult | null {
  if (typeof id !== 'string') return null;
  const result = entryOf(context.results, id);
  if (!isObject(result) || result.schema !== 'gauge.result@1' || result.result !== id || !validateResult(result, context).ok) {
    return null;
  }
  return result as unknown as EvaluationResult;
}

/** Entries match the criteria set one-to-one by name. */
function matchesOneToOne(entries: readonly Obj[], key: string, names: readonly string[]): boolean {
  const seen = new Set(entries.map(e => e[key]));
  return seen.size === entries.length && entries.length === names.length && names.every(n => seen.has(n));
}

export function constraintStatus(
  c: ConstraintDefinition,
  entry: EvaluationResult['measures'][number],
  minSamples: number,
): ConstraintStatus {
  if (entry.n < minSamples || entry.value === null) return 'unknown';
  const [lo, hi] = entry.interval ?? [entry.value, entry.value];
  if (c.op === 'ge') return lo >= c.bound ? 'held' : hi < c.bound ? 'violated' : 'unknown';
  return hi <= c.bound ? 'held' : lo > c.bound ? 'violated' : 'unknown';
}

export function resultVerdict(statuses: readonly ConstraintStatus[]): ResultVerdict {
  if (statuses.includes('violated')) return 'misses_bar';
  if (statuses.includes('unknown')) return 'insufficient_evidence';
  return 'meets_bar';
}

function validateResult(r: Obj, context: Context): Verdict {
  // 1. envelope
  if (!hasExactly(r, RESULT_KEYS)) return reject('envelope');
  const subject = r.subject;
  if (!isObject(subject) || !hasExactly(subject, ['kind', 'ref'])
    || !oneOf(subject.kind, 'implementation', 'routed_unit', 'policy', 'operating_strategy') || typeof subject.ref !== 'string') {
    return reject('envelope');
  }
  if (typeof r.result !== 'string' || typeof r.criteria !== 'string' || typeof r.caseset !== 'string'
    || typeof r.caseset_digest !== 'string' || !oneOf(r.split, 'tune', 'holdout')
    || !oneOf(r.mode, 'replay', 'trial', 'live')
    || !oneOf(r.verdict, 'meets_bar', 'misses_bar', 'insufficient_evidence')) {
    return reject('envelope');
  }
  if (!evidenceShaped(r.evidence, 1, 256)) return reject('envelope');
  const measures = r.measures;
  if (!measureEntriesShaped(measures)) return reject('envelope');
  const constraints = r.constraints;
  if (!objects(constraints, 0, 32, ['constraint', 'status'])
    || !constraints.every(c => isCode(c.constraint) && oneOf(c.status, 'held', 'violated', 'unknown'))) {
    return reject('envelope');
  }

  // 2. ref
  if (!isId(r.result) || !isId(subject.ref) || !isRev(r.criteria) || !isRev(r.caseset) || !isDigest(r.caseset_digest)) {
    return reject('ref');
  }
  if (!r.evidence.every(e => isId(e.ref))) return reject('ref');

  // 3. binding
  const criteria = boundCriteria(context, r.criteria);
  const caseset = boundCaseSet(context, r.caseset);
  if (criteria === null || caseset === null || criteria.workload !== caseset.workload) return reject('binding');
  const split = caseset.splits.find(s => s.split === r.split);
  if (split === undefined || split.digest !== r.caseset_digest) return reject('binding');
  if (!matchesOneToOne(measures, 'measure', criteria.measures.map(d => d.measure))) return reject('binding');
  if (!matchesOneToOne(constraints, 'constraint', criteria.constraints.map(c => c.constraint))) return reject('binding');

  // 4. governance
  if (subject.kind === 'policy'
    && [criteria.governed_by, caseset.governed_by].some(g => g.kind === 'policy' && g.ref === subject.ref)) {
    return reject('governance');
  }

  // 5. holdout
  if (r.split === 'holdout' && !r.evidence.every(e => e.source === 'held_out_report')) return reject('holdout');

  const entries = new Map(
    (measures as unknown as EvaluationResult['measures']).map(e => [e.measure, e] as const),
  );
  const entry = (name: string) => entries.get(name)!;

  // 6. mode
  if (r.mode === 'replay') {
    for (const d of criteria.measures) {
      if ('weft_kind' in d.source && OUTCOME_KINDS.has(d.source.weft_kind) && entry(d.measure).n !== 0) return reject('mode');
    }
  }

  // 7. measure
  for (const d of criteria.measures) {
    const { value, n, interval } = entry(d.measure);
    if ((n === 0) !== (value === null)) return reject('measure');
    if (value === null) {
      if (interval !== null) return reject('measure');
      continue;
    }
    if (interval !== null && (value < interval[0] || value > interval[1])) return reject('measure');
    if (d.aggregate === 'rate' && [value, ...(interval ?? [])].some(x => x < 0 || x > 1)) return reject('measure');
  }

  // 8. constraint
  const statuses = criteria.constraints.map(c => constraintStatus(c, entry(c.measure), criteria.method.min_samples));
  const claimed = new Map(constraints.map(c => [c.constraint, c.status]));
  if (!criteria.constraints.every((c, i) => claimed.get(c.constraint) === statuses[i])) return reject('constraint');

  // 9. verdict
  if (r.verdict !== resultVerdict(statuses)) return reject('verdict');
  return OK;
}

// gauge.comparison@1

/** Two results answer the same question: criteria set, case set, split, mode and subject kind. */
export const sameQuestion = (a: EvaluationResult, b: EvaluationResult): boolean =>
  a.criteria === b.criteria && a.caseset === b.caseset && a.split === b.split && a.mode === b.mode
  && a.subject.kind === b.subject.kind;

function validateComparison(r: Obj, context: Context): Verdict {
  // 1. envelope
  if (!hasExactly(r, ['schema', 'comparison', 'experiment', 'baseline', 'candidate', 'deltas', 'verdict'])) {
    return reject('envelope');
  }
  if (typeof r.comparison !== 'string' || !(r.experiment === null || typeof r.experiment === 'string')
    || typeof r.baseline !== 'string' || typeof r.candidate !== 'string'
    || !oneOf(r.verdict, 'candidate_better', 'no_difference', 'candidate_worse', 'bar_missed', 'insufficient_evidence')) {
    return reject('envelope');
  }
  const deltas = r.deltas;
  if (!objects(deltas, 0, 32, ['measure', 'delta', 'interval'])
    || !deltas.every(d => isCode(d.measure) && (d.delta === null || isNumber(d.delta))
      && (d.interval === null || isInterval(d.interval)))) {
    return reject('envelope');
  }

  // 2. ref
  if (!isId(r.comparison) || !(r.experiment === null || isId(r.experiment)) || !isId(r.baseline) || !isId(r.candidate)) {
    return reject('ref');
  }

  // 3. binding
  if (r.baseline === r.candidate) return reject('binding');
  const baseline = boundResult(context, r.baseline);
  const candidate = boundResult(context, r.candidate);
  if (baseline === null || candidate === null) return reject('binding');
  if (!sameQuestion(baseline, candidate) || baseline.subject.ref === candidate.subject.ref) return reject('binding');
  // A bound result validated, so its criteria set is known and valid.
  const criteria = boundCriteria(context, baseline.criteria)!;
  if (!matchesOneToOne(deltas, 'measure', criteria.measures.map(d => d.measure))) return reject('binding');

  // 7. measure
  const valueOf = (result: EvaluationResult, name: string) => result.measures.find(e => e.measure === name)!.value;
  const byName = new Map((deltas as unknown as { measure: string; delta: number | null; interval: Interval | null }[])
    .map(d => [d.measure, d] as const));
  for (const d of criteria.measures) {
    const { delta, interval } = byName.get(d.measure)!;
    const base = valueOf(baseline, d.measure);
    const cand = valueOf(candidate, d.measure);
    if (base === null || cand === null) {
      if (delta !== null || interval !== null) return reject('measure');
      continue;
    }
    if (delta === null || Math.abs(delta - (cand - base)) > EPSILON) return reject('measure');
    if (interval === null || delta < interval[0] || delta > interval[1]) return reject('measure');
  }

  // 9. verdict
  const expected = comparisonVerdict(baseline, candidate, criteria, byName);
  if (r.verdict !== expected) return reject('verdict');
  return OK;
}

export function comparisonVerdict(
  baseline: EvaluationResult,
  candidate: EvaluationResult,
  criteria: CriteriaSet,
  deltas: ReadonlyMap<string, { readonly delta: number | null; readonly interval: Interval | null }>,
): ComparisonVerdict {
  const measured = criteria.measures.flatMap(d => {
    const { delta, interval } = deltas.get(d.measure)!;
    return delta === null || interval === null ? [] : [{ d, lo: interval[0], hi: interval[1] }];
  });
  if (baseline.verdict === 'insufficient_evidence' || candidate.verdict === 'insufficient_evidence' || measured.length === 0) {
    return 'insufficient_evidence';
  }
  if (candidate.verdict === 'misses_bar') return 'bar_missed';
  const worse = measured.some(({ d, lo, hi }) =>
    d.better === 'higher' ? hi < 0 && hi <= -d.min_effect : lo > 0 && lo >= d.min_effect);
  if (worse) return 'candidate_worse';
  const better = measured.some(({ d, lo, hi }) =>
    d.better === 'higher' ? lo > 0 && lo >= d.min_effect : hi < 0 && hi <= -d.min_effect);
  return better ? 'candidate_better' : 'no_difference';
}

// gauge.attribution@1

const SIGNALS: Readonly<Record<string, readonly string[]>> = {
  capability_gap: ['no_contract_matched'],
  implementation: ['contract_tests_failed', 'effect_violation', 'implementation_failed'],
  routing: ['better_route_excluded', 'wrong_contract_selected'],
  orchestration: ['dependency_failed', 'schedule_conflict', 'budget_exhausted', 'superseded'],
};

function validateAttribution(r: Obj, context: Context): Verdict {
  // 1. envelope
  if (!hasExactly(r, ['schema', 'attribution', 'result', 'case', 'category', 'basis', 'signal', 'confidence', 'evidence'])) {
    return reject('envelope');
  }
  if (typeof r.attribution !== 'string' || typeof r.result !== 'string' || typeof r.case !== 'string'
    || !oneOf(r.category, 'capability_gap', 'implementation', 'routing', 'orchestration', 'unattributed')
    || !oneOf(r.basis, 'deterministic', 'judgment', 'none')
    || !(r.signal === null || isCode(r.signal)) || !(r.confidence === null || isRatio(r.confidence))
    || !evidenceShaped(r.evidence, 0, 64)) {
    return reject('envelope');
  }

  // 2. ref
  if (!isId(r.attribution) || !isId(r.result) || !isId(r.case) || !r.evidence.every(e => isId(e.ref))) return reject('ref');

  // 3. binding
  const result = boundResult(context, r.result);
  if (result === null) return reject('binding');

  // 5. holdout: attributing a held-out case would reveal which one failed.
  if (result.split !== 'tune') return reject('holdout');

  // 10. attribution
  const hasEvidence = r.evidence.length > 0;
  switch (r.basis) {
    case 'deterministic':
      if (r.category === 'unattributed' || r.confidence !== null || !hasEvidence) return reject('attribution');
      if (!(SIGNALS[r.category as string] ?? []).includes(r.signal as string)) return reject('attribution');
      return OK;
    case 'judgment':
      if (r.category === 'unattributed' || r.signal !== null || r.confidence === null || !hasEvidence) return reject('attribution');
      return OK;
    default:
      if (r.category !== 'unattributed' || r.signal !== null || r.confidence !== null) return reject('attribution');
      return OK;
  }
}

// gauge.cost@1

const COST_LINES = ['trial_micros', 'evaluation_micros', 'review_micros', 'total_micros'] as const;

function validateCost(r: Obj, context: Context): Verdict {
  // 1. envelope: every line is required, so none can be left out.
  if (!hasExactly(r, ['schema', 'cost', 'result', 'trials', 'failed_trials', ...COST_LINES])) return reject('envelope');
  if (typeof r.cost !== 'string' || typeof r.result !== 'string' || !isCount(r.trials) || !isCount(r.failed_trials)
    || !COST_LINES.every(line => isMetric(r[line]))) {
    return reject('envelope');
  }

  // 2. ref
  if (!isId(r.cost) || !isId(r.result)) return reject('ref');

  // 3. binding
  if (boundResult(context, r.result) === null) return reject('binding');

  // 11. cost: failed trials are among the trials, and the total is every line.
  const cost = r as unknown as EvaluationCost;
  if (cost.failed_trials > cost.trials) return reject('cost');
  const lines = cost.trial_micros + cost.evaluation_micros + cost.review_micros;
  if (Math.abs(cost.total_micros - lines) > EPSILON * Math.max(1, cost.total_micros)) return reject('cost');
  return OK;
}

// gauge.preference@1

const PREFERENCE_KEYS = ['schema', 'preference', 'workload', 'criteria', 'caseset', 'split', 'mode', 'accept', 'entries'];

const sameInterval = (a: Interval | null, b: Interval | null): boolean =>
  a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1];

function validatePreference(r: Obj, context: Context): Verdict {
  // 1. envelope: closed keys, so an entry cannot carry a route field.
  if (!hasExactly(r, PREFERENCE_KEYS)) return reject('envelope');
  if (typeof r.preference !== 'string' || typeof r.workload !== 'string' || typeof r.criteria !== 'string'
    || typeof r.caseset !== 'string' || !oneOf(r.split, 'tune', 'holdout') || !oneOf(r.mode, 'replay', 'trial', 'live')
    || !isCode(r.accept)) {
    return reject('envelope');
  }
  const entries = r.entries;
  if (!objects(entries, 1, 64, ['routed_unit', 'result', 'verdict', 'measures'])
    || !entries.every(e => typeof e.routed_unit === 'string' && typeof e.result === 'string'
      && oneOf(e.verdict, 'meets_bar', 'misses_bar', 'insufficient_evidence') && measureEntriesShaped(e.measures))
    || !unique(entries, e => e.routed_unit as string)) {
    return reject('envelope');
  }

  // 2. ref
  if (!isRev(r.preference) || !isId(r.workload) || !isRev(r.criteria) || !isRev(r.caseset)
    || !entries.every(e => isId(e.routed_unit) && isId(e.result))) {
    return reject('ref');
  }

  // 3. binding: every entry is a recorded result for its own routed unit on the set's question.
  const criteria = boundCriteria(context, r.criteria);
  const caseset = boundCaseSet(context, r.caseset);
  if (criteria === null || caseset === null || criteria.workload !== r.workload || caseset.workload !== r.workload) {
    return reject('binding');
  }
  const names = criteria.measures.map(d => d.measure);
  const results: EvaluationResult[] = [];
  for (const e of entries) {
    const result = boundResult(context, e.result);
    if (result === null || result.subject.kind !== 'routed_unit' || result.subject.ref !== e.routed_unit
      || result.criteria !== r.criteria || result.caseset !== r.caseset || result.split !== r.split || result.mode !== r.mode
      || !matchesOneToOne(e.measures as readonly Obj[], 'measure', names)) {
      return reject('binding');
    }
    results.push(result);
  }

  // 7. measure: the accept rate is a higher-is-better rate, and figures are copied, never asserted.
  const accept = criteria.measures.find(d => d.measure === r.accept);
  if (accept === undefined || accept.aggregate !== 'rate' || accept.better !== 'higher') return reject('measure');
  for (const [i, e] of entries.entries()) {
    for (const m of e.measures as EvaluationResult['measures']) {
      const own = results[i]!.measures.find(x => x.measure === m.measure)!;
      if (m.value !== own.value || m.n !== own.n || !sameInterval(m.interval, own.interval)) return reject('measure');
    }
  }

  // 9. verdict
  if (!entries.every((e, i) => e.verdict === results[i]!.verdict)) return reject('verdict');
  return OK;
}
