/**
 * Scoring rule `decision-sites.score@2` (SCORING.md) as info-only Gauge records
 * (packages/gauge/src/GAUGE-CONTRACT.md `gauge.criteria@2`), and the report's
 * rows evaluated under it (G4, #192). Every number of a report row is an
 * info-only measure: Gauge reproduces it exactly, and nothing may weigh, gate,
 * compare, cost or route on it. The benchmark stays non-gating, and nothing
 * here changes thresholds, routing, the report, the journal or its ledger.
 *
 * Per site, one criteria set for the row metrics (`report`), one for the
 * probability-only diagnostics of guard and D5 rows (`probability-only`), and
 * one case set naming the frozen tune and holdout files by SHA-256. A
 * `gauge.revision@1` records each at @1, so editing one in place unbinds it.
 *
 * A result is one report row on the holdout, in `replay` mode, citing only the
 * run's held-out report: a provider's recorded answers admitted under the
 * tuned or production thresholds (subject kind `policy`), a competitor's
 * without a gate (`routed_unit`), or a provider's probability-only diagnostics
 * (`routed_unit`, thresholds ignored).
 *
 * Samples are score@2's own decisions (`samples` and `probabilityPoints` in
 * tune.ts) over the observations the report scored, in the report's order;
 * Gauge reduces them independently. Tokens and latency come from the run's
 * Weft `inference.attempt` records (weft.ts). An observation that never
 * reached a provider (a provider-level skip, or an unacknowledged call) has no
 * attempt, and keeps what the journal recorded for it, as the report does.
 * Cost stays the journal's fractional USD: Weft's `spent_micros` would round it.
 *
 * Out of scope, as in the report itself: thresholds are the subject under
 * evaluation, not a measure of it; the ceiling, spend, reservations and
 * run-wide tokens are the journal ledger, which stays authoritative.
 */
import { evaluateInfo, recordDigest, type CaseSet, type Context, type InfoCriteriaSet, type InfoMeasureDefinition, type InfoResult, type Pair, type Revision } from '@weave/gauge';
import type { Entry } from './engine.ts';
import { COMPETITOR_THRESHOLDS, PROBABILITY_SITES, competitorCalls, finalObservations, type BoundCall } from './report.ts';
import { BLOCK_PROBABILITY, probabilityPoints, samples, type Metrics, type Thresholds } from './tune.ts';
import type { Attempt } from './weft.ts';

export { PROBABILITY_SITES };
const D3 = 'loop.preselect';
const SCORING = { kind: 'policy', ref: 'decision-sites.scoring' } as const;
const PROVENANCE = { kind: 'policy', ref: 'decision-sites.provenance' } as const;

export const workload = (site: string) => `decision-sites.${site}`;
export const reportCriteria = (site: string) => `decision-sites.${site}.report@1`;
export const probabilityCriteria = (site: string) => `decision-sites.${site}.probability-only@1`;
export const caseSetName = (site: string) => `decision-sites.${site}.cases@1`;

const check = { evidence: 'check' } as const;
const recorded = { evidence: 'held_out_report' } as const;
const attempt = (field: 'input_tokens' | 'output_tokens' | 'latency_ms') => ({ weft_kind: 'inference.attempt', field }) as const;
const measure = (name: string, source: InfoMeasureDefinition['source'], aggregate: InfoMeasureDefinition['aggregate'], empty: 0 | null): InfoMeasureDefinition =>
  ({ measure: name, source, aggregate, empty });

/**
 * One measure per report row number, in `Metrics` order, with the report's
 * empty value: 0 for a count or a rate the report prints as 0, null for one it
 * prints as —. Every site has every measure; one that does not apply to a site
 * has no samples there, so it is the empty value the report prints.
 */
const REPORT_MEASURES: readonly InfoMeasureDefinition[] = [
  measure('attempted', recorded, 'sum', 0),
  measure('covered', check, 'sum', 0),
  measure('coverage', check, 'rate', 0),
  measure('accuracy', check, 'rate', null),
  measure('exact_set_accuracy', check, 'rate', null),
  measure('failures', recorded, 'sum', 0),
  measure('missing_confidence', check, 'sum', 0),
  measure('confidence_coverage', check, 'rate', 0),
  measure('mean_confidence', check, 'mean', null),
  measure('brier', check, 'mean', null),
  measure('ece', check, 'ece10', null),
  measure('calibration_n', check, 'sum', 0),
  measure('violation_recall', check, 'rate', null),
  measure('needed_recall', check, 'rate', null),
  measure('all_needed_recall', check, 'rate', null),
  measure('multi_entry_steps', check, 'sum', 0),
  measure('mean_best_gap', check, 'mean', null),
  measure('mean_kth_gap', check, 'mean', null),
  measure('latency_p50', attempt('latency_ms'), 'p50_floor', null),
  measure('latency_p90', attempt('latency_ms'), 'p90_floor', null),
  measure('input_tokens', attempt('input_tokens'), 'sum', 0),
  measure('output_tokens', attempt('output_tokens'), 'sum', 0),
  measure('cost_usd', recorded, 'sum', 0),
  measure('parse_failure_rate', recorded, 'rate', 0),
];

/** The probability-only diagnostics' numbers. `block_probability` is the rule's parameter, not a measure. */
const PROBABILITY_MEASURES: readonly InfoMeasureDefinition[] = [
  measure('questions', check, 'sum', 0),
  measure('probability_coverage', check, 'rate', 0),
  measure('violation_recall', check, 'rate', null),
  measure('false_block_rate', check, 'rate', null),
  measure('auc', check, 'auc', null),
];

const criteria = (name: string, site: string, measures: readonly InfoMeasureDefinition[]): InfoCriteriaSet =>
  ({ schema: 'gauge.criteria@2', criteria: name, workload: workload(site), governed_by: SCORING, measures });

/** The frozen tune and holdout files of one site, by the digests `loadSets` checked against DIGESTS.json. */
function caseSetFor(site: string, entries: readonly Entry[], digests: Readonly<Record<string, string>>): CaseSet {
  return {
    schema: 'gauge.caseset@1', caseset: caseSetName(site), workload: workload(site), governed_by: PROVENANCE,
    splits: (['tune', 'holdout'] as const).map(split => ({
      split, digest: `sha256:${digests[`${site}/${split}`]}`, size: entries.filter(e => e.item.site === site && e.split === split).length,
    })),
  };
}

const revision = (set: InfoCriteriaSet | CaseSet, justification: string): Revision => ({
  schema: 'gauge.revision@1', revision: set.schema === 'gauge.caseset@1' ? set.caseset : set.criteria,
  record: set.schema === 'gauge.caseset@1' ? 'caseset' : 'criteria', digest: recordDigest(set), supersedes: null,
  issued_by: set.governed_by, justification, evidence: [],
});

/** Criteria sets, case sets and their revisions for every site of the loaded sets. */
export function gaugeContext(sets: { readonly entries: readonly Entry[]; readonly digests: Readonly<Record<string, string>> }): Context {
  const sites = [...new Set(sets.entries.map(e => e.item.site))];
  const criteriaSets = [
    ...sites.map(site => criteria(reportCriteria(site), site, REPORT_MEASURES)),
    ...sites.filter(site => PROBABILITY_SITES.includes(site)).map(site => criteria(probabilityCriteria(site), site, PROBABILITY_MEASURES)),
  ];
  const casesets = sites.map(site => caseSetFor(site, sets.entries, sets.digests));
  return {
    criteria: Object.fromEntries(criteriaSets.map(c => [c.criteria, c])),
    casesets: Object.fromEntries(casesets.map(c => [c.caseset, c])),
    results: {},
    revisions: Object.fromEntries([
      ...criteriaSets.map(c => revision(c, 'decision-sites.score@2')),
      ...casesets.map(c => revision(c, 'initial')),
    ].map(r => [r.revision, r])),
  };
}

/** Score@2's samples for one report row, keyed by report measure. */
function reportSamples(site: string, rows: readonly BoundCall[], applied: Thresholds, attempts: ReadonlyMap<string, Attempt>) {
  const s = samples(site, rows, applied);
  const sent = rows.map(r => attempts.get(r.call_id));
  const valid = s.confidence.filter((c): c is number => c !== null);
  const latency = rows.map((r, i) => sent[i]?.fields.latency_ms ?? r.latency_ms);
  const tokens = (field: 'input_tokens' | 'output_tokens') => rows.map((r, i) => (sent[i] ? sent[i].fields[field] : r.result[field]) ?? 0);
  const all: Readonly<Record<string, readonly number[] | readonly Pair[]>> = {
    attempted: rows.map(() => 1),
    covered: s.coverage,
    coverage: s.coverage,
    accuracy: site === D3 ? s.all_needed : s.exact,
    exact_set_accuracy: s.exact,
    failures: rows.map(r => (r.result.status !== 'ok' ? 1 : 0)),
    missing_confidence: s.confidence.map(c => (c === null ? 1 : 0)),
    confidence_coverage: s.confidence.map(c => (c === null ? 0 : 1)),
    mean_confidence: valid,
    brier: s.calibration.map(([p, y]) => (p - y) ** 2),
    ece: s.calibration,
    calibration_n: s.calibration.map(() => 1),
    violation_recall: s.violation,
    needed_recall: s.needed,
    all_needed_recall: s.all_needed,
    multi_entry_steps: s.multi_entry,
    mean_best_gap: s.best_gap,
    mean_kth_gap: s.kth_gap,
    latency_p50: latency,
    latency_p90: latency,
    input_tokens: tokens('input_tokens'),
    output_tokens: tokens('output_tokens'),
    cost_usd: rows.map(r => r.cost_usd),
    parse_failure_rate: rows.map(r => (r.result.parse_failure ? 1 : 0)),
  };
  return all;
}

function probabilitySamples(site: string, rows: readonly BoundCall[]): Readonly<Record<string, readonly number[] | readonly Pair[]>> {
  const questions = probabilityPoints(site, rows);
  const points = questions.filter(p => p !== null);
  const blocked = (violation: boolean) => points.filter(p => p.violation === violation).map(p => (p.p >= BLOCK_PROBABILITY ? 1 : 0));
  return {
    questions: points.map(() => 1),
    probability_coverage: questions.map(q => (q === null ? 0 : 1)),
    violation_recall: blocked(true),
    false_block_rate: blocked(false),
    auc: points.map(p => [p.p, p.violation ? 1 : 0] as const),
  };
}

/** The report rows Gauge evaluates: the subjects the report scored, with the thresholds tuning chose. */
export interface ReportRows {
  readonly decision_providers: readonly { readonly site: string; readonly provider: string; readonly tuned_thresholds: Thresholds; readonly production_thresholds: Thresholds }[];
  readonly competitors: readonly { readonly site: string; readonly provider: string }[];
}
export interface ScoredRow {
  readonly site: string;
  readonly provider: string;
  readonly label: 'tuned' | 'production' | 'ungated' | 'probability_only';
  readonly result: InfoResult;
}

/**
 * One holdout result per report row: each decision row under its tuned and
 * production thresholds, each competitor row, then the probability-only
 * diagnostics of each guard and D5 decision row. Pure: it reads only its
 * arguments. Throws when Gauge refuses a result or an observation lies
 * outside its site's frozen holdout.
 */
export function scoreReport(input: {
  readonly run_id: string; readonly rows: ReportRows; readonly observations: readonly BoundCall[];
  readonly attempts: readonly Attempt[]; readonly context: Context;
}): ScoredRow[] {
  const { run_id, context } = input;
  const observations = finalObservations(input.observations);
  const attempts = new Map(input.attempts.map(a => [a.record_id, a] as const));
  const holdout = (site: string, provider: string) =>
    observations.filter(r => r.site === site && r.provider === provider && r.split === 'holdout');

  function score(site: string, provider: string, label: ScoredRow['label'], rows: readonly BoundCall[], applied: Thresholds): ScoredRow {
    const cases = context.casesets[caseSetName(site)] as CaseSet | undefined;
    if (rows.some(r => `sha256:${r.set_digest}` !== cases?.splits.find(s => s.split === 'holdout')?.digest)) {
      throw new Error(`Observation outside ${caseSetName(site)} holdout`);
    }
    const diagnostic = label === 'probability_only';
    const subject = label === 'tuned' || label === 'production'
      ? { kind: 'policy', ref: `${provider}.${label}` } as const
      : { kind: 'routed_unit', ref: provider } as const;
    const result = `${run_id}.${site}.${provider}.${label}`;
    const out = evaluateInfo({
      result, subject, workload: workload(site), criteria: diagnostic ? probabilityCriteria(site) : reportCriteria(site),
      caseset: caseSetName(site), split: 'holdout', mode: 'replay', evidence: [{ source: 'held_out_report', ref: run_id }],
      samples: diagnostic ? probabilitySamples(site, rows) : reportSamples(site, rows, applied, attempts),
    }, context);
    if (!out.ok) throw new Error(`Gauge refused ${result}: ${out.reason}`);
    return { site, provider, label, result: out.record };
  }

  const decisions = input.rows.decision_providers;
  return [
    ...decisions.flatMap(r => [
      score(r.site, r.provider, 'tuned', holdout(r.site, r.provider), r.tuned_thresholds),
      score(r.site, r.provider, 'production', holdout(r.site, r.provider), r.production_thresholds),
    ]),
    ...input.rows.competitors.map(r => score(r.site, r.provider, 'ungated', competitorCalls(holdout(r.site, r.provider)), COMPETITOR_THRESHOLDS)),
    ...decisions.filter(r => PROBABILITY_SITES.includes(r.site))
      .map(r => score(r.site, r.provider, 'probability_only', holdout(r.site, r.provider), r.production_thresholds)),
  ];
}

const valueOf = (result: InfoResult, name: string) => {
  const entry = result.measures.find(m => m.measure === name);
  if (entry === undefined) throw new Error(`${result.result} has no ${name} measure`);
  return entry.value;
};
const countOf = (result: InfoResult, name: string) => valueOf(result, name) as number;

/** A report row's numbers, read from Gauge's measures without further arithmetic. */
export function reported(result: InfoResult): Metrics {
  const v = (name: string) => valueOf(result, name), c = (name: string) => countOf(result, name);
  return {
    attempted: c('attempted'), covered: c('covered'), coverage: c('coverage'), accuracy: v('accuracy'),
    exact_set_accuracy: v('exact_set_accuracy'), failures: c('failures'), missing_confidence: c('missing_confidence'),
    confidence_coverage: c('confidence_coverage'), mean_confidence: v('mean_confidence'), brier: v('brier'), ece: v('ece'),
    calibration_n: c('calibration_n'), violation_recall: v('violation_recall'), needed_recall: v('needed_recall'),
    all_needed_recall: v('all_needed_recall'), multi_entry_steps: c('multi_entry_steps'), mean_best_gap: v('mean_best_gap'),
    mean_kth_gap: v('mean_kth_gap'), latency_ms: { p50: v('latency_p50'), p90: v('latency_p90') },
    input_tokens: c('input_tokens'), output_tokens: c('output_tokens'), cost_usd: c('cost_usd'), parse_failure_rate: c('parse_failure_rate'),
  };
}

/** A probability-only diagnostic's numbers, read from Gauge's measures. */
export function reportedProbabilityOnly(result: InfoResult) {
  const v = (name: string) => valueOf(result, name);
  return {
    questions: countOf(result, 'questions'), probability_coverage: countOf(result, 'probability_coverage'),
    violation_recall: v('violation_recall'), false_block_rate: v('false_block_rate'), auc: v('auc'),
  };
}
