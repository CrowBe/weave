/**
 * Scoring rule `decision-sites.score@2` (SCORING.md) as Gauge records
 * (packages/gauge/src/GAUGE-CONTRACT.md), and the recorded run evaluated under
 * it. Gauge produces evidence here: nothing it returns changes thresholds,
 * routing, the report or the journal, and the benchmark stays non-gating.
 *
 * Per site, one governed criteria set and one case set, each recorded by a
 * `gauge.revision@1` at @1. Criteria @1 encodes score@2, whose own history
 * stays in SCORING.md. The case set names the frozen tune and holdout files by
 * their SHA-256, so a changed set no longer binds.
 *
 * A result is one report row: a provider's holdout observations under the
 * tune-selected or production thresholds (subject kind `policy`), or a
 * competitor's without a gate (`routed_unit`). It is a `replay`: answers were
 * recorded once, and admission is re-decided from them, so no outcome is
 * measured. It cites only the run's held-out report.
 *
 * Measures come from two sources. Answer-scored ones are the benchmark's own
 * check (`samples` in tune.ts) against the frozen gold, because Weft v1 has no
 * kind for an answer set. Tokens come from the run's Weft `inference.attempt`
 * records (weft.ts). Report numbers Gauge does not measure are DIAGNOSTICS.
 */
import { evaluate, recordDigest, type CaseSet, type Context, type CriteriaSet, type EvaluationResult, type MeasureDefinition, type Revision } from '@weave/gauge';
import type { WeftRecord } from '@weave/weft';
import { COMPETITOR_THRESHOLDS, competitorCalls, finalObservations, type BoundCall } from './report.ts';
import { samples, type Metrics, type Thresholds } from './tune.ts';
import type { Entry } from './engine.ts';

const D3 = 'loop.preselect';
const GUARDS = ['guard.input', 'guard.output'];
const SCORING = { kind: 'policy', ref: 'decision-sites.scoring' } as const;
const PROVENANCE = { kind: 'policy', ref: 'decision-sites.provenance' } as const;

export const workload = (site: string) => `decision-sites.${site}`;
export const criteriaName = (site: string) => `decision-sites.${site}.criteria@1`;
export const caseSetName = (site: string) => `decision-sites.${site}.cases@1`;

/**
 * Report numbers that are not Gauge measures, and why. They stay the
 * benchmark's diagnostics, computed by `metrics` in tune.ts.
 */
export const DIAGNOSTICS: Readonly<Partial<Record<keyof Metrics, string>>> = {
  failures: 'a summary count that includes provider-level skips and unacknowledged calls, which are not Weft attempts',
  missing_confidence: 'descriptive: the rule declares no better direction, and every Gauge measure needs one',
  confidence_coverage: 'descriptive: the rule declares no better direction, and every Gauge measure needs one',
  mean_confidence: 'descriptive: the rule declares no better direction, and every Gauge measure needs one',
  mean_best_gap: 'descriptive: the rule declares no better direction, and every Gauge measure needs one',
  mean_kth_gap: 'descriptive: the rule declares no better direction, and every Gauge measure needs one',
  multi_entry_steps: 'a property of the D3 cases, not of the subject evaluated',
  ece: 'ten-bin calibration error is not an aggregate of per-sample values',
  latency_ms: 'p50 and p90 at floor(q(n-1)) are not Gauge aggregates, whose only quantile is p95 at ceil(0.95n)-1',
  cost_usd: 'journal cost is fractional micro-USD, Weft spent_micros is a count, and spend belongs to the journal ledger',
};

const check = (measure: string, aggregate: MeasureDefinition['aggregate'], better: MeasureDefinition['better']): MeasureDefinition =>
  ({ measure, source: { evidence: 'check' }, aggregate, better, min_effect: 0 });
const attempt = (field: 'input_tokens' | 'output_tokens'): MeasureDefinition =>
  ({ measure: field, source: { weft_kind: 'inference.attempt', field }, aggregate: 'sum', better: 'lower', min_effect: 0 });

/**
 * The rule's measures for one site. Non-gating, so no constraint, and the rule
 * declares no minimum effect. The verdict of a result under it is therefore
 * `meets_bar`, meaning only that no declared bar was missed.
 */
export function criteriaFor(site: string): CriteriaSet {
  return {
    schema: 'gauge.criteria@1', criteria: criteriaName(site), workload: workload(site), governed_by: SCORING,
    method: { interval: 'bootstrap@1', level: 0.95, seed: 0, min_samples: 1 },
    measures: [
      check('coverage', 'rate', 'higher'),
      check('accuracy', 'rate', 'higher'),
      ...(site === D3 ? [check('exact_set_accuracy', 'rate', 'higher'), check('needed_recall', 'rate', 'higher')] : []),
      ...(GUARDS.includes(site) ? [check('violation_recall', 'rate', 'higher')] : []),
      check('brier', 'mean', 'lower'),
      check('parse_failure_rate', 'rate', 'lower'),
      attempt('input_tokens'),
      attempt('output_tokens'),
    ],
    constraints: [],
  };
}

/** The frozen tune and holdout files of one site, by the digests `loadSets` checked against DIGESTS.json. */
export function caseSetFor(site: string, entries: readonly Entry[], digests: Readonly<Record<string, string>>): CaseSet {
  return {
    schema: 'gauge.caseset@1', caseset: caseSetName(site), workload: workload(site), governed_by: PROVENANCE,
    splits: (['tune', 'holdout'] as const).map(split => ({
      split, digest: `sha256:${digests[`${site}/${split}`]}`, size: entries.filter(e => e.item.site === site && e.split === split).length,
    })),
  };
}

const revision = (set: CriteriaSet | CaseSet, justification: string): Revision => ({
  schema: 'gauge.revision@1', revision: set.schema === 'gauge.criteria@1' ? set.criteria : set.caseset,
  record: set.schema === 'gauge.criteria@1' ? 'criteria' : 'caseset', digest: recordDigest(set), supersedes: null,
  issued_by: set.governed_by, justification, evidence: [],
});

/** Criteria sets, case sets and their revisions for every site of the loaded sets. */
export function gaugeContext(sets: { readonly entries: readonly Entry[]; readonly digests: Readonly<Record<string, string>> }): Context {
  const sites = [...new Set(sets.entries.map(e => e.item.site))];
  const criteria = sites.map(criteriaFor), casesets = sites.map(site => caseSetFor(site, sets.entries, sets.digests));
  return {
    criteria: Object.fromEntries(criteria.map(c => [c.criteria, c])),
    casesets: Object.fromEntries(casesets.map(c => [c.caseset, c])),
    results: {},
    revisions: Object.fromEntries([
      ...criteria.map(c => revision(c, 'decision-sites.score@2')),
      ...casesets.map(c => revision(c, 'initial')),
    ].map(r => [r.revision, r])),
  };
}

/** The report rows Gauge evaluates: the subjects tuning chose, as the report recorded them. */
export interface ReportRows {
  readonly decision_providers: readonly { readonly site: string; readonly provider: string; readonly tuned_thresholds: Thresholds; readonly production_thresholds: Thresholds }[];
  readonly competitors: readonly { readonly site: string; readonly provider: string }[];
}
export interface ScoredRow {
  readonly site: string;
  readonly provider: string;
  readonly thresholds: 'tuned' | 'production' | 'ungated';
  readonly result: EvaluationResult;
}

/**
 * One holdout result per report row, in the report's row order, from the
 * observations the report scored and the run's Weft attempts. Throws when Gauge
 * refuses a result or an observation lies outside its case set's holdout.
 */
export function scoreReport(input: {
  readonly run_id: string; readonly rows: ReportRows; readonly observations: readonly BoundCall[];
  readonly attempts: readonly WeftRecord[]; readonly context: Context;
}): ScoredRow[] {
  const { run_id, context } = input;
  const observations = finalObservations(input.observations);
  const attempts = new Map(input.attempts.flatMap(a => a.kind === 'inference.attempt' ? [[a.record_id, a.fields] as const] : []));
  const holdout = (site: string, provider: string) =>
    observations.filter(r => r.site === site && r.provider === provider && r.split === 'holdout');

  function score(site: string, provider: string, thresholds: ScoredRow['thresholds'], rows: readonly BoundCall[], applied: Thresholds): ScoredRow {
    const criteria = context.criteria[criteriaName(site)] as CriteriaSet;
    const cases = context.casesets[caseSetName(site)] as CaseSet;
    if (rows.some(r => `sha256:${r.set_digest}` !== cases.splits.find(s => s.split === 'holdout')?.digest)) {
      throw new Error(`Observation outside ${caseSetName(site)} holdout`);
    }
    const s = samples(site, rows, applied);
    const fields = rows.map(r => attempts.get(r.call_id));
    const tokens = (field: 'input_tokens' | 'output_tokens') => fields.flatMap(f => f?.[field] === undefined ? [] : [f[field]]);
    const all: Readonly<Record<string, readonly number[]>> = {
      coverage: s.coverage, accuracy: s.accuracy, exact_set_accuracy: s.exact_set_accuracy, needed_recall: s.needed_recall,
      violation_recall: s.violation_recall, brier: s.calibration.map(v => (v.p - v.y) ** 2),
      parse_failure_rate: rows.map(r => r.result.parse_failure ? 1 : 0),
      input_tokens: tokens('input_tokens'), output_tokens: tokens('output_tokens'),
    };
    const subject = thresholds === 'ungated'
      ? { kind: 'routed_unit', ref: provider } as const
      : { kind: 'policy', ref: `${provider}.${thresholds}` } as const;
    const result = `${run_id}.${site}.${subject.ref}`;
    const out = evaluate({
      result, subject, workload: workload(site), criteria: criteria.criteria, caseset: cases.caseset, split: 'holdout', mode: 'replay',
      evidence: [{ source: 'held_out_report', ref: run_id }],
      samples: Object.fromEntries(criteria.measures.map(d => [d.measure, all[d.measure]!])),
    }, context);
    if (!out.ok) throw new Error(`Gauge refused ${result}: ${out.reason}`);
    return { site, provider, thresholds, result: out.record };
  }

  return [
    ...input.rows.decision_providers.flatMap(r => [
      score(r.site, r.provider, 'tuned', holdout(r.site, r.provider), r.tuned_thresholds),
      score(r.site, r.provider, 'production', holdout(r.site, r.provider), r.production_thresholds),
    ]),
    ...input.rows.competitors.map(r => score(r.site, r.provider, 'ungated', competitorCalls(holdout(r.site, r.provider)), COMPETITOR_THRESHOLDS)),
  ];
}
