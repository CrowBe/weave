/**
 * Scoring for the paired `frontier.weigh@1` comparison. The rubric, outcome
 * classes and promotion rule are fixed here and in README.md before any
 * weigher is scored on the holdout. Deterministic; no environment, no clock.
 */
import { proposalCoversSources, selectFrontier } from '@weave/weave';
import type { BuiltCase, CaseKind, Split } from './build.ts';
import type { WeighOutcome } from './weighers.ts';

export const PROMOTION_RULE = 'frontier-weigh.promotion@1';

/** SHA-256 of cases.json as frozen before scoring. Editing a label changes it. */
export const CASESET_DIGEST = '19b5efd87bbfb8bfa4f19796141b58e00d629cc73dbb23b55743e4d97ff2ebc1';

export const THRESHOLDS = {
  /** P1: accepted weights on at least this share of holdout cases. */
  coverage: 0.9,
  /** P2: holdout frontier agreement at least this ... */
  agreement: 0.8,
  /** ... and at least this much above scripted@1. */
  margin: 0.2,
  /** P3: holdout cases scripted@1 gets right and the candidate does not. */
  max_regressions: 0,
  /** P4: dispatches where the adjudicated frontier is empty. */
  max_premature: 1,
  /** P5: mean accounted spend per holdout case, micros. */
  max_mean_spent_micros: 1_000,
  /** P6: 95th percentile wall-clock latency per weighing, when measured. */
  max_p95_latency_ms: 10_000,
} as const;

export type OutcomeClass = 'advanced' | 'held' | 'premature' | 'misdirected' | 'stalled' | 'failed';
export const OUTCOME_CLASSES: readonly OutcomeClass[] = ['advanced', 'held', 'premature', 'misdirected', 'stalled', 'failed'];

export interface Adjudication {
  readonly preferred: readonly string[];
  readonly critical: readonly string[];
  readonly needed: number;
  readonly kind: CaseKind;
  readonly rule: string;
}

const CONSEQUENTIAL = new Set(['report.assemble', 'goal.complete']);

/** An independent code reading of rubric R1–R4 (README.md), used to audit the hand-written labels. */
export function adjudicate(built: BuiltCase): Adjudication {
  const state = built.state;
  const goal = state.goal;
  if (!goal) {
    throw new Error(`${built.case.id}: no goal`);
  }
  const framed = state.proposal ? proposalCoversSources(state.proposal.proposal, goal.sources) : false;
  const running = new Set(
    Object.values(state.actions)
      .filter((action) => action.operation === 'source.inspect' && (action.state === 'running' || action.state === 'pending'))
      .map((action) => (action.inputs as { source: string }).source),
  );
  const needInspect = goal.sources.filter(
    (source) => state.inspections[source]?.result.revision !== state.sources[source]?.revision && !running.has(source),
  );
  const report = state.report;
  const reportCurrent =
    report !== null &&
    report.report.read_set.every((entry) => state.sources[entry.resource]?.revision === entry.revision) &&
    goal.sources.every((source) => report.report.entries.some((entry) => entry.source === source));
  const needed = (framed ? 0 : 1) + needInspect.length + (reportCurrent ? 0 : 1) + 1;
  const remaining = state.budget.actions.limit - state.budget.actions.reserved - state.budget.actions.spent;
  const keys = built.eligible.map((candidate) => built.keys.get(candidate.candidate_id) as string);
  const critical = keys.filter(
    (key) =>
      (key === 'goal.frame' && !framed) ||
      needInspect.some((source) => key === `source.inspect:${source}`) ||
      CONSEQUENTIAL.has(key),
  );
  const hold = remaining < needed;
  const review = keys.includes('report.review') && remaining - 1 >= needed;
  const preferred = hold ? [] : [...critical, ...(review ? ['report.review'] : [])].sort();
  const irrelevant = keys.some(
    (key) => key.startsWith('source.inspect:') && !goal.sources.includes(key.slice('source.inspect:'.length)),
  );
  return {
    preferred,
    critical: [...critical].sort(),
    needed,
    kind: preferred.length === 0 ? 'hold' : preferred.some((key) => CONSEQUENTIAL.has(key)) ? 'act' : 'gather',
    rule: hold ? 'R3' : irrelevant ? 'R2' : keys.includes('report.review') ? 'R4' : 'R1',
  };
}

/** Weave's frontier from a weigher's outcome: nothing when the weights are unusable. */
export function frontierOf(built: BuiltCase, outcome: WeighOutcome): string[] {
  if (outcome.status !== 'accepted') {
    return [];
  }
  const byId = new Map(outcome.weights.map((entry) => [entry.candidate_id, entry.weight]));
  const weighed = built.eligible
    .filter((candidate) => byId.has(candidate.candidate_id))
    .map((candidate) => ({ ...candidate, weight: byId.get(candidate.candidate_id) as number }));
  return selectFrontier(weighed, built.state, outcome.contract)
    .selected.map((candidate) => built.keys.get(candidate.candidate_id) as string)
    .sort();
}

export interface CaseResult {
  readonly id: string;
  readonly split: Split;
  readonly kind: CaseKind;
  readonly weigher: string;
  readonly preferred: readonly string[];
  readonly selected: readonly string[];
  readonly outcome: OutcomeClass;
  readonly agrees: boolean;
  /** After this frontier, the actions remaining still cover the work the goal needs. */
  readonly completable: boolean;
  readonly status: WeighOutcome['status'];
  readonly reason: string | null;
  readonly weights: Readonly<Record<string, number>>;
  readonly spent: number;
  readonly attempts: number;
  readonly latency_ms: number | null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}

export function scoreCase(built: BuiltCase, weigher: string, outcome: WeighOutcome): CaseResult {
  const label = built.case.label;
  const selected = frontierOf(built, outcome);
  const preferred = [...label.preferred].sort();
  let result: OutcomeClass;
  if (outcome.status !== 'accepted') {
    result = 'failed';
  } else if (preferred.length === 0) {
    result = selected.length === 0 ? 'held' : 'premature';
  } else if (selected.length === 0) {
    result = 'stalled';
  } else {
    result = sameSet(selected, preferred) ? 'advanced' : 'misdirected';
  }
  const remaining = built.state.budget.actions.limit - built.state.budget.actions.reserved - built.state.budget.actions.spent;
  const advancing = selected.filter((key) => label.critical.includes(key)).length;
  const weights: Record<string, number> = {};
  for (const entry of outcome.weights) {
    weights[built.keys.get(entry.candidate_id) ?? entry.candidate_id] = entry.weight;
  }
  return {
    id: built.case.id,
    split: built.case.split,
    kind: label.kind,
    weigher,
    preferred,
    selected,
    outcome: result,
    agrees: result === 'advanced' || result === 'held',
    completable: remaining - selected.length >= label.needed - advancing,
    status: outcome.status,
    reason: outcome.reason,
    weights,
    spent: outcome.spent,
    attempts: outcome.attempts,
    latency_ms: outcome.latency_ms,
  };
}

export interface Summary {
  readonly weigher: string;
  readonly split: Split;
  readonly n: number;
  readonly covered: number;
  readonly agreed: number;
  readonly agreement: number;
  readonly outcomes: Readonly<Record<OutcomeClass, number>>;
  readonly completable: number;
  readonly spent_total: number;
  readonly latency_p95_ms: number | null;
}

/** Nearest-rank percentile over sorted values: index floor(q * (n - 1)). */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(q * (sorted.length - 1))] as number;
}

export function summarize(results: readonly CaseResult[], weigher: string, split: Split): Summary {
  const rows = results.filter((row) => row.weigher === weigher && row.split === split);
  const outcomes = Object.fromEntries(OUTCOME_CLASSES.map((name) => [name, 0])) as Record<OutcomeClass, number>;
  for (const row of rows) {
    outcomes[row.outcome] += 1;
  }
  const agreed = rows.filter((row) => row.agrees).length;
  return {
    weigher,
    split,
    n: rows.length,
    covered: rows.filter((row) => row.status === 'accepted').length,
    agreed,
    agreement: rows.length === 0 ? 0 : agreed / rows.length,
    outcomes,
    completable: rows.filter((row) => row.completable).length,
    spent_total: rows.reduce((sum, row) => sum + row.spent, 0),
    latency_p95_ms: percentile(
      rows.flatMap((row) => (row.latency_ms === null ? [] : [row.latency_ms])),
      0.95,
    ),
  };
}

export interface PromotionCheck {
  readonly id: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
  /** null: not measurable for this weigher (latency offline). */
  readonly held: boolean | null;
  readonly detail: string;
}

export interface PromotionVerdict {
  readonly weigher: string;
  readonly verdict: 'promote' | 'retain scripted@1';
  readonly checks: readonly PromotionCheck[];
}

const fixed = (value: number): string => value.toFixed(2);

/** Promotion rule frontier-weigh.promotion@1, applied to holdout rows only. */
export function promotion(results: readonly CaseResult[], weigher: string, baseline = 'scripted@1'): PromotionVerdict {
  const rows = results.filter((row) => row.weigher === weigher && row.split === 'holdout');
  const base = new Map(results.filter((row) => row.weigher === baseline && row.split === 'holdout').map((row) => [row.id, row]));
  if (rows.length === 0 || base.size !== rows.length) {
    throw new Error(`promotion needs paired holdout rows for ${weigher} and ${baseline}`);
  }
  const mine = summarize(results, weigher, 'holdout');
  const theirs = summarize(results, baseline, 'holdout');
  const coverage = mine.covered / mine.n;
  const regressions = rows.filter((row) => base.get(row.id)?.agrees && !row.agrees).length;
  const strayComplete = rows.filter((row) => row.selected.includes('goal.complete') && !row.preferred.includes('goal.complete')).length;
  const meanSpent = mine.spent_total / mine.n;
  const checks: PromotionCheck[] = [
    {
      id: 'P1',
      held: coverage >= THRESHOLDS.coverage,
      detail: `coverage ${mine.covered}/${mine.n} = ${fixed(coverage)} (needs >= ${THRESHOLDS.coverage})`,
    },
    {
      id: 'P2',
      held: mine.agreement >= THRESHOLDS.agreement && mine.agreement - theirs.agreement >= THRESHOLDS.margin - 1e-9,
      detail: `agreement ${fixed(mine.agreement)} vs ${baseline} ${fixed(theirs.agreement)} (needs >= ${THRESHOLDS.agreement} and +${THRESHOLDS.margin})`,
    },
    {
      id: 'P3',
      held: regressions <= THRESHOLDS.max_regressions,
      detail: `${regressions} regression(s) on cases ${baseline} gets right (allowed ${THRESHOLDS.max_regressions})`,
    },
    {
      id: 'P4',
      held: mine.outcomes.premature <= THRESHOLDS.max_premature && strayComplete === 0,
      detail: `${mine.outcomes.premature} premature dispatch(es) (allowed ${THRESHOLDS.max_premature}); ${strayComplete} goal.complete outside the adjudicated frontier (allowed 0)`,
    },
    {
      id: 'P5',
      held: meanSpent <= THRESHOLDS.max_mean_spent_micros,
      detail: `mean spend ${fixed(meanSpent)} micros per case (allowed ${THRESHOLDS.max_mean_spent_micros})`,
    },
    {
      id: 'P6',
      held: mine.latency_p95_ms === null ? null : mine.latency_p95_ms <= THRESHOLDS.max_p95_latency_ms,
      detail:
        mine.latency_p95_ms === null
          ? 'latency not measured (offline fixture)'
          : `p95 latency ${mine.latency_p95_ms} ms (allowed ${THRESHOLDS.max_p95_latency_ms})`,
    },
  ];
  const promote = checks.every((check) => check.held !== false) && checks.slice(0, 5).every((check) => check.held === true);
  return { weigher, verdict: promote ? 'promote' : 'retain scripted@1', checks };
}
