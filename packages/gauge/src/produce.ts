/**
 * Gauge's producers (GAUGE-CONTRACT.md "Producers"). Each builds a record from
 * samples or from recorded results with the statistics in `stats.ts`, then runs
 * it through `validate`, so a producer never returns a record the validator
 * would reject. They compute evidence and promote nothing.
 */
import { aggregate, bootstrap, difference, infoAggregate, wilson } from './stats.js';
import {
  OUTCOME_KINDS,
  boundCaseSet,
  boundCriteria,
  boundInfoCriteria,
  boundResult,
  comparisonVerdict,
  constraintStatus,
  isInfoResult,
  resultVerdict,
  sameQuestion,
  unmeasuredInReplay,
  validate,
} from './validate.js';
import type {
  Comparison,
  ComparisonRequest,
  Context,
  CriteriaSet,
  EvaluationResult,
  InfoResult,
  Pair,
  Produced,
  Rejection,
  Run,
  Track,
  TrackStep,
} from './types.js';

type Delta = Comparison['deltas'][number];

const refuse = (reason: Rejection) => ({ ok: false, reason }) as const;
const isObject = (x: unknown): x is Readonly<Record<string, unknown>> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isSampleList = (x: unknown): x is readonly number[] =>
  Array.isArray(x) && x.every((v) => typeof v === 'number' && Number.isFinite(v));

function checked<T>(record: T, context: Context): Produced<T> {
  const verdict = validate(record, context);
  return verdict.ok ? { ok: true, record } : refuse(verdict.reason);
}

/**
 * A result from one sample list per criteria measure. Empty and short lists
 * are honest results, not errors: their constraints stay `unknown` and the
 * verdict says `insufficient_evidence`.
 */
export function evaluate(run: Run, context: Context): Produced<EvaluationResult> {
  if (!isObject(run) || !isObject(run.samples)) return refuse('envelope');
  // Info-only measures are never judged against a bar: evaluateInfo records them.
  if (boundInfoCriteria(context, run.criteria) !== null) return refuse('info_only');
  if (!Object.values(run.samples).every(isSampleList)) return refuse('envelope');
  const samples = run.samples;

  const criteria = boundCriteria(context, run.criteria);
  const caseset = boundCaseSet(context, run.caseset);
  if (
    criteria === null ||
    caseset === null ||
    run.workload !== criteria.workload ||
    run.workload !== caseset.workload
  ) {
    return refuse('binding');
  }
  const split = caseset.splits.find((s) => s.split === run.split);
  const names = criteria.measures.map((d) => d.measure);
  if (
    split === undefined ||
    Object.keys(samples).length !== names.length ||
    !names.every((n) => Object.hasOwn(samples, n))
  ) {
    return refuse('binding');
  }
  const listOf = (name: string) => samples[name] as readonly number[];

  // A replay never took the actions whose outcomes these kinds report.
  if (
    run.mode === 'replay' &&
    criteria.measures.some(
      (d) => 'weft_kind' in d.source && OUTCOME_KINDS.has(d.source.weft_kind) && listOf(d.measure).length > 0,
    )
  ) {
    return refuse('mode');
  }
  if (criteria.measures.some((d) => d.aggregate === 'rate' && !listOf(d.measure).every((x) => x === 0 || x === 1))) {
    return refuse('measure');
  }

  const { interval: method, level, seed, min_samples: minSamples } = criteria.method;
  const measures = criteria.measures.map((d) => {
    const xs = listOf(d.measure);
    if (xs.length === 0) return { measure: d.measure, value: null, n: 0, interval: null };
    const value = aggregate(d.aggregate, xs);
    // wilson@1 applies only to rate measures, whose samples sum to their successes.
    const interval =
      method === 'wilson@1' ? wilson(aggregate('sum', xs), xs.length, level) : bootstrap(xs, d.aggregate, level, seed);
    return { measure: d.measure, value, n: xs.length, interval };
  });
  const byName = new Map(measures.map((m) => [m.measure, m] as const));
  const statuses = criteria.constraints.map((c) => constraintStatus(c, byName.get(c.measure)!, minSamples));
  return checked<EvaluationResult>(
    {
      schema: 'gauge.result@1',
      result: run.result,
      subject: run.subject,
      criteria: run.criteria,
      caseset: run.caseset,
      split: run.split,
      caseset_digest: split.digest,
      mode: run.mode,
      evidence: run.evidence,
      measures,
      constraints: criteria.constraints.map((c, i) => ({ constraint: c.constraint, status: statuses[i]! })),
      verdict: resultVerdict(statuses),
    },
    context,
  );
}

const isPairList = (x: readonly unknown[], unitX: boolean): x is readonly Pair[] =>
  x.every(
    (p) =>
      Array.isArray(p) &&
      p.length === 2 &&
      typeof p[0] === 'number' &&
      Number.isFinite(p[0]) &&
      (p[1] === 0 || p[1] === 1) &&
      (!unitX || (p[0] >= 0 && p[0] <= 1)),
  );

/**
 * An info-only result (`gauge.result@2`) from one sample list per measure of an
 * info-only criteria set. Each value is the report statistic its aggregate
 * names, over the samples in the order given; an empty list, or an `auc` list
 * with one class, takes the measure's declared empty value. Nothing here is
 * weighed: no interval, no bar, and the verdict is always `info_only`.
 */
export function evaluateInfo(run: Run, context: Context): Produced<InfoResult> {
  if (!isObject(run) || !isObject(run.samples) || !Object.values(run.samples).every(Array.isArray))
    return refuse('envelope');
  const samples = run.samples;

  const criteria = boundInfoCriteria(context, run.criteria);
  const caseset = boundCaseSet(context, run.caseset);
  if (
    criteria === null ||
    caseset === null ||
    run.workload !== criteria.workload ||
    run.workload !== caseset.workload
  ) {
    return refuse('binding');
  }
  const split = caseset.splits.find((s) => s.split === run.split);
  const names = criteria.measures.map((d) => d.measure);
  if (
    split === undefined ||
    Object.keys(samples).length !== names.length ||
    !names.every((n) => Object.hasOwn(samples, n))
  ) {
    return refuse('binding');
  }
  const listOf = (name: string) => samples[name]!;
  if (
    !criteria.measures.every((d) =>
      d.aggregate === 'ece10' || d.aggregate === 'auc'
        ? isPairList(listOf(d.measure), d.aggregate === 'ece10')
        : isSampleList(listOf(d.measure)),
    )
  ) {
    return refuse('envelope');
  }

  // A replay never took the actions whose outcomes these kinds report.
  if (run.mode === 'replay' && criteria.measures.some((d) => unmeasuredInReplay(d) && listOf(d.measure).length > 0)) {
    return refuse('mode');
  }
  if (
    criteria.measures.some(
      (d) => d.aggregate === 'rate' && !(listOf(d.measure) as readonly number[]).every((x) => x === 0 || x === 1),
    )
  ) {
    return refuse('measure');
  }

  const measures = criteria.measures.map((d) => {
    const { n, value } = infoAggregate(d.aggregate, listOf(d.measure));
    return { measure: d.measure, value: n === 0 ? d.empty : value, n };
  });
  return checked<InfoResult>(
    {
      schema: 'gauge.result@2',
      result: run.result,
      subject: run.subject,
      criteria: run.criteria,
      caseset: run.caseset,
      split: run.split,
      caseset_digest: split.digest,
      mode: run.mode,
      evidence: run.evidence,
      measures,
      verdict: 'info_only',
    },
    context,
  );
}

/** Candidate minus baseline per measure, or null when a value carries no interval. */
function deltasOf(baseline: EvaluationResult, candidate: EvaluationResult, criteria: CriteriaSet): Delta[] | null {
  const deltas: Delta[] = [];
  for (const { measure } of criteria.measures) {
    const b = baseline.measures.find((m) => m.measure === measure)!;
    const c = candidate.measures.find((m) => m.measure === measure)!;
    if (b.value === null || c.value === null) {
      deltas.push({ measure, delta: null, interval: null });
    } else if (b.interval === null || c.interval === null) {
      return null;
    } else {
      deltas.push({
        measure,
        delta: c.value - b.value,
        interval: difference({ value: b.value, interval: b.interval }, { value: c.value, interval: c.interval }),
      });
    }
  }
  return deltas;
}

const verdictOf = (
  baseline: EvaluationResult,
  candidate: EvaluationResult,
  criteria: CriteriaSet,
  deltas: readonly Delta[],
) => comparisonVerdict(baseline, candidate, criteria, new Map(deltas.map((d) => [d.measure, d] as const)));

/** A comparison of two recorded results for the same question, with an interval on every delta. */
export function compare(request: ComparisonRequest, context: Context): Produced<Comparison> {
  if (!isObject(request)) return refuse('envelope');
  if (isInfoResult(context, request.baseline) || isInfoResult(context, request.candidate)) return refuse('info_only');
  const baseline = boundResult(context, request.baseline);
  const candidate = boundResult(context, request.candidate);
  if (
    baseline === null ||
    candidate === null ||
    request.baseline === request.candidate ||
    !sameQuestion(baseline, candidate) ||
    baseline.subject.ref === candidate.subject.ref
  ) {
    return refuse('binding');
  }
  const criteria = boundCriteria(context, baseline.criteria)!;
  const deltas = deltasOf(baseline, candidate, criteria);
  if (deltas === null) return refuse('measure');
  return checked<Comparison>(
    {
      schema: 'gauge.comparison@1',
      comparison: request.comparison,
      experiment: request.experiment,
      baseline: request.baseline,
      candidate: request.candidate,
      deltas,
      verdict: verdictOf(baseline, candidate, criteria, deltas),
    },
    context,
  );
}

/**
 * Results in the order recorded, each compared with the one before it. The
 * subject may repeat, so one implementation can be followed across
 * re-evaluations as well as across versions.
 */
export function track(results: readonly string[], context: Context): Track {
  if (!Array.isArray(results)) return refuse('envelope');
  if (results.some((id) => isInfoResult(context, id))) return refuse('info_only');
  if (new Set(results).size !== results.length) return refuse('binding');
  const bound = results.map((id) => boundResult(context, id));
  if (bound.some((r) => r === null)) return refuse('binding');
  const series = bound as EvaluationResult[];
  if (!series.every((r) => sameQuestion(r, series[0]!))) return refuse('binding');

  const steps: TrackStep[] = [];
  for (let i = 1; i < series.length; i += 1) {
    const previous = series[i - 1]!;
    const next = series[i]!;
    const criteria = boundCriteria(context, next.criteria)!;
    const deltas = deltasOf(previous, next, criteria);
    if (deltas === null) return refuse('measure');
    const verdict = verdictOf(previous, next, criteria, deltas);
    const regression = verdict === 'candidate_worse' || (verdict === 'bar_missed' && previous.verdict === 'meets_bar');
    steps.push({ previous: previous.result, next: next.result, deltas, verdict, regression });
  }
  return { ok: true, steps };
}
