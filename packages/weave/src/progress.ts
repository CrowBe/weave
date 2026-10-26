/**
 * Round progress from recorded evidence before D8 (#202).
 *
 * `progressDelta` compares two consecutive tidy states. When that comparison decides progress, the
 * rule answers and D8 is not asked; otherwise D8 (`loop.continue`) answers as before. The rule only
 * produces one of D8's three options. It adds no stop condition and changes no threshold: the
 * returned choice feeds the existing two-in-a-row `stopForNoProgress` rule.
 */
import type { InferenceGateway } from '@weave/gateway';
import type { AuditCriterion, AuditState } from './audit-view.js';
import { digest } from './digest.js';
import { OUTPUT_EVAL_POLICY } from './sites/output-eval.js';
import {
  evaluateSite,
  type ProgressChoice,
  type SiteInput,
  type SiteState,
  type SiteTransition,
} from './sites/index.js';

export interface CriterionSettlement {
  readonly criterion_id: string;
  /** Settled in the previous tidy state; null when the criterion was not there. */
  readonly before: boolean | null;
  readonly after: boolean;
}
export interface ProgressDelta {
  readonly schema: 'progress.delta@1';
  /** One digest over the previous state's checks, evals and artifacts. */
  readonly previous_digest: string;
  readonly current_digest: string;
  /** In the current goal's criterion order. */
  readonly criteria: readonly CriterionSettlement[];
  /** Previous criteria that the current goal no longer lists. */
  readonly removed: number;
  readonly gained: number;
  readonly lost: number;
  /** The rule's answer, or null when the evidence does not decide it and D8 must. */
  readonly rule: ProgressChoice | null;
}
export interface ProgressRecord {
  readonly schema: 'progress.record@1';
  /** Null in the first round, which has no previous tidy state. */
  readonly delta: ProgressDelta | null;
  readonly decided_by: 'rule' | 'site';
  readonly choice: ProgressChoice;
  readonly status: SiteTransition['status'];
  /** D8's transition when the site decided; null when the rule did. */
  readonly site: SiteTransition | null;
}

function current(iteration: number) {
  return (item: { readonly iteration?: number | null }): boolean =>
    typeof item.iteration === 'number' &&
    Number.isSafeInteger(item.iteration) &&
    item.iteration >= 0 &&
    item.iteration === iteration;
}
/**
 * The per-criterion part of the audit loop's completion evidence: every run of each bound check is green
 * (for a check-proven criterion, at least one run in the current iteration and only those runs count),
 * no current D5 eval for it failed, and a judgment criterion has a current confident D5 pass.
 */
function settled(state: AuditState, criterion: AuditCriterion): boolean {
  if (criterion.check_ids.length === 0) return false;
  const now = current(state.iteration);
  const scoped = criterion.proof === 'check';
  const green = criterion.check_ids.every((id) => {
    const runs = state.checks.filter((check) => check.check_id === id && (!scoped || now(check)));
    return runs.length > 0 && runs.every((check) => check.passed && check.exit === 0);
  });
  const evals = state.evals.filter((item) => item.criterion_id === criterion.criterion_id && now(item));
  if (!green || evals.some((item) => !item.passed)) return false;
  return (
    scoped ||
    evals.some(
      (item) =>
        item.passed &&
        (item.verdict_probability ?? 0) >= OUTPUT_EVAL_POLICY.probability &&
        (item.confidence ?? 0) >= OUTPUT_EVAL_POLICY.confidence,
    )
  );
}
function evidenceDigest(state: AuditState): string {
  return digest({ checks: state.checks, evals: state.evals, artifacts: state.artifacts });
}
/** Pure rule over a recorded delta. Changed criteria, or a delta that is neither one-sided nor empty, ask D8. */
export function progressRule(delta: Omit<ProgressDelta, 'rule'>): ProgressChoice | null {
  if (delta.removed > 0 || delta.criteria.some((item) => item.before === null)) return null;
  if (delta.previous_digest === delta.current_digest) return 'stalled';
  if (delta.gained > 0 && delta.lost === 0) return 'progressing';
  if (delta.lost > 0 && delta.gained === 0) return 'regressing';
  return null;
}
/** Pure `progress.delta@1` over two consecutive tidy states. */
export function progressDelta(previous: AuditState, state: AuditState): ProgressDelta {
  const before = new Map<string, boolean>();
  for (const criterion of previous.goal.success_criteria) {
    if (!before.has(criterion.criterion_id)) before.set(criterion.criterion_id, settled(previous, criterion));
  }
  const criteria = state.goal.success_criteria.map((criterion): CriterionSettlement => ({
    criterion_id: criterion.criterion_id,
    before: before.get(criterion.criterion_id) ?? null,
    after: settled(state, criterion),
  }));
  const listed = new Set(criteria.map((item) => item.criterion_id));
  const delta = {
    schema: 'progress.delta@1' as const,
    previous_digest: evidenceDigest(previous),
    current_digest: evidenceDigest(state),
    criteria,
    removed: [...before.keys()].filter((id) => !listed.has(id)).length,
    gained: criteria.filter((item) => item.before === false && item.after).length,
    lost: criteria.filter((item) => item.before === true && !item.after).length,
  };
  return { ...delta, rule: progressRule(delta) };
}
/**
 * Pure record construction, also the replay path: a recorded delta and D8 transition rebuild the record.
 * A cancelled D8 transition wins over the rule, because cancellation is checked before the rule decides.
 */
export function transitionProgress(delta: ProgressDelta | null, site: SiteTransition | null): ProgressRecord {
  if (delta !== null && delta.rule !== null && site?.observation.reason !== 'cancelled') {
    return {
      schema: 'progress.record@1',
      delta,
      decided_by: 'rule',
      choice: delta.rule,
      status: 'transition',
      site: null,
    };
  }
  if (site === null || !['progressing', 'stalled', 'regressing'].includes(site.choice)) {
    throw new Error('An undecided progress delta needs a recorded D8 transition');
  }
  return {
    schema: 'progress.record@1',
    delta,
    decided_by: 'site',
    choice: site.choice as ProgressChoice,
    status: site.status,
    site,
  };
}
/**
 * Applies the rule first; asks D8 through the injected port only when the evidence does not decide.
 * Cancellation is checked before the rule (#244): an aborted round never records a rule `transition`.
 * It takes D8's path, which makes no call and records a `paused` cancellation that counts toward nothing.
 */
export async function decideProgress(
  previous: AuditState | null,
  state: AuditState,
  input: SiteInput,
  port: Pick<InferenceGateway, 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<ProgressRecord> {
  const delta = previous === null ? null : progressDelta(previous, state);
  if (delta !== null && delta.rule !== null && !signal?.aborted) return transitionProgress(delta, null);
  return transitionProgress(delta, await evaluateSite('loop.continue', input, port, now, signal));
}
