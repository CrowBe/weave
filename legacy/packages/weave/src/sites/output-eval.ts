/** D5 judges one criterion at a time. A pass is evidence, never goal completion or a grant. */
import type { BooleanQuestion, EvaluationOutcome, InferenceGateway } from '@weave/gateway';
import {
  admissionReason,
  correlation,
  originReason,
  structuralOrigin,
  unit,
  type SiteInput,
  type SiteReason,
  type SiteState,
} from './index.js';

export const OUTPUT_EVAL_SITE = 'eval.output' as const;
/** Fixed question text. Criterion statements stay in the disclosed state, not in the record. */
export const OUTPUT_EVAL_QUESTION = 'Does the artifact satisfy this success criterion?';
/**
 * Matches task-acceptance `confidence_floor`. A published confidence is below the floor.
 * An absent confidence uses the tune-fitted probability-only threshold instead; an
 * invalid one still fails closed.
 */
export const OUTPUT_EVAL_POLICY = Object.freeze({
  probability: 0.8,
  confidence: 0.9,
  missing_confidence_probability: 0.5,
});

export interface OutputCriterion {
  readonly criterion_id: string;
  /** Disclosed to the evaluator. Never copied into the observation. */
  readonly statement: string;
}
export interface OutputEvalInput extends SiteInput {
  readonly criteria: readonly OutputCriterion[];
}
export interface RecordedOutputEval {
  readonly state_revision: number;
  readonly observed_at: number;
  readonly outcome: EvaluationOutcome<'boolean'> | null;
  readonly cancelled?: boolean;
}
export type OutputEvalReason = SiteReason | 'below_probability' | 'unknown_answer' | 'empty_criteria';
export interface OutputEvalObservation {
  readonly schema: 'decision-site@1';
  readonly site: typeof OUTPUT_EVAL_SITE;
  readonly question: string;
  readonly request_id: string | null;
  readonly state_revision: number;
  readonly answer: 'pass' | 'fail' | null;
  readonly confidence: number | null;
  readonly top_p: number | null;
  readonly accepted: boolean;
  readonly fallback_used: boolean;
  readonly reason: OutputEvalReason;
  readonly provider_request_id: string | null;
}
export interface OutputCriterionEval {
  readonly criterion_id: string;
  readonly verdict_probability: number | null;
  readonly confidence: number | null;
  readonly passed: boolean;
  readonly observation: OutputEvalObservation;
}
export interface OutputEvalTransition {
  readonly status: 'pass' | 'fail' | 'paused';
  readonly evals: readonly OutputCriterionEval[];
  readonly observations: readonly OutputEvalObservation[];
  readonly failing_criterion_ids: readonly string[];
}

export function criterionKey(index: number): string {
  return `criterion_${index}`;
}

/** A confidence container must be a plain object; null, arrays, scalars and class instances are malformed. */
function confidenceMap(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function observe(
  input: OutputEvalInput,
  fields: {
    readonly answer: OutputEvalObservation['answer'];
    readonly confidence: number | null;
    readonly top_p: number | null;
    readonly accepted: boolean;
    readonly reason: OutputEvalReason;
    readonly provider_request_id: string | null;
  },
): OutputEvalObservation {
  return {
    schema: 'decision-site@1',
    site: OUTPUT_EVAL_SITE,
    question: OUTPUT_EVAL_QUESTION,
    request_id: correlation(input.request_id),
    state_revision: input.state_revision,
    answer: fields.answer,
    confidence: fields.confidence,
    top_p: fields.top_p,
    accepted: fields.accepted,
    fallback_used: !fields.accepted,
    reason: fields.reason,
    provider_request_id: fields.provider_request_id,
  };
}

/** Live and replay apply the same default; a supplied origin, even a forged one, is never replaced. */
function withOrigin(input: OutputEvalInput): OutputEvalInput {
  return input.origin === undefined ? { ...input, origin: structuralOrigin('criteria') } : input;
}

/** Pure threshold rule. An outage fails every criterion; it does not read another site. */
export function transitionOutputEval(
  supplied: OutputEvalInput,
  recorded: RecordedOutputEval,
  current: SiteState,
): OutputEvalTransition {
  const input = withOrigin(supplied);
  const criteria = input.criteria.map((criterion) => ({
    criterion_id: criterion.criterion_id,
    statement: criterion.statement,
  }));
  const metadata = admissionReason(OUTPUT_EVAL_SITE, input, recorded, current);
  const answered = recorded.outcome?.status === 'accepted' ? recorded.outcome : null;
  const provider_request_id = correlation(answered?.provider_response_id);
  const observations: OutputEvalObservation[] = [];
  const evals: OutputCriterionEval[] = [];
  if (criteria.length === 0) {
    observations.push(
      observe(input, {
        answer: null,
        confidence: null,
        top_p: null,
        accepted: false,
        reason: metadata && metadata !== 'decision_unavailable' ? metadata : 'empty_criteria',
        provider_request_id,
      }),
    );
  }
  for (const [index, criterion] of criteria.entries()) {
    const key = criterionKey(index);
    // An unsafe id is not evidence and cannot pass. The ordinal key is not the raw value.
    const safeId = correlation(criterion.criterion_id);
    const raw = answered?.answers?.[key];
    const probability = raw?.type === 'boolean' && unit(raw.probability) ? raw.probability : null;
    const container = answered?.confidence;
    let statistic: unknown;
    let confidenceMissing: boolean;
    let confidenceInvalid: boolean;
    if (container === undefined) {
      statistic = undefined;
      confidenceMissing = true;
      confidenceInvalid = false;
    } else if (!confidenceMap(container)) {
      statistic = undefined;
      confidenceMissing = false;
      confidenceInvalid = true;
    } else {
      statistic = container[key];
      confidenceMissing = !Object.hasOwn(container, key);
      confidenceInvalid = !confidenceMissing && !unit(statistic);
    }
    const confidence = unit(statistic) ? statistic : null;
    let reason: OutputEvalReason;
    let answer: OutputEvalObservation['answer'] = null;
    let accepted = false;
    if (metadata) reason = metadata;
    else if (!safeId) reason = 'invalid_answer';
    else if (!answered) reason = 'no_answer';
    else if (answered.kind !== 'boolean') reason = 'invalid_answer';
    else if (probability === null) reason = confidenceMissing ? 'missing_confidence' : 'invalid_answer';
    else if (confidenceInvalid) reason = 'missing_confidence';
    else if (confidenceMissing) {
      // The fitted cutoff is a block threshold on P(violation) = 1 - P(satisfied).
      if (1 - probability >= OUTPUT_EVAL_POLICY.missing_confidence_probability) {
        reason = 'below_probability';
        answer = 'fail';
        accepted = true;
      } else {
        reason = 'accepted';
        answer = 'pass';
        accepted = true;
      }
    } else if (confidence !== null && confidence < OUTPUT_EVAL_POLICY.confidence) reason = 'low_confidence';
    else if (probability < OUTPUT_EVAL_POLICY.probability) {
      reason = 'below_probability';
      answer = 'fail';
      accepted = true;
    } else {
      reason = 'accepted';
      answer = 'pass';
      accepted = true;
    }
    const observation = observe(input, {
      answer,
      confidence: metadata || !safeId ? null : confidence,
      top_p: metadata || !safeId ? null : probability,
      accepted,
      reason,
      provider_request_id,
    });
    const passed = accepted && answer === 'pass' && safeId !== null;
    observations.push(observation);
    evals.push({
      criterion_id: safeId ?? key,
      verdict_probability: metadata || !safeId ? null : probability,
      confidence: metadata || !safeId ? null : confidence,
      passed,
      observation,
    });
  }
  const expected = new Set(criteria.map((_, index) => criterionKey(index)));
  for (const key of Object.keys(answered?.answers ?? {})) {
    if (!expected.has(key))
      observations.push(
        observe(input, {
          answer: null,
          confidence: null,
          top_p: null,
          accepted: false,
          reason: 'unknown_answer',
          provider_request_id,
        }),
      );
  }
  const failing_criterion_ids = evals.filter((item) => !item.passed).map((item) => item.criterion_id);
  const status =
    recorded.cancelled || metadata === 'cancelled'
      ? 'paused'
      : criteria.length > 0 && failing_criterion_ids.length === 0
        ? 'pass'
        : 'fail';
  return { status, evals, observations, failing_criterion_ids };
}

/** One boolean question per criterion. `current` is read after the await. */
export async function evaluateOutputEval(
  input: OutputEvalInput,
  port: Pick<InferenceGateway, 'evaluate'>,
  current: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<OutputEvalTransition> {
  const criteria = Object.freeze(
    input.criteria.map((criterion) =>
      Object.freeze({
        criterion_id: criterion.criterion_id,
        statement: criterion.statement,
      }),
    ),
  );
  // Capture the origin before await: caller mutation cannot rebind an in-flight answer, as in evaluateSite.
  const captured = withOrigin({
    ...input,
    criteria,
    ...(input.origin === undefined ? {} : { origin: structuredClone(input.origin) }),
  });
  let outcome: EvaluationOutcome<'boolean'> | null = null;
  if (!signal?.aborted && criteria.length > 0 && originReason(OUTPUT_EVAL_SITE, captured) === null) {
    try {
      const questions: Record<string, BooleanQuestion> = {};
      for (const [index, criterion] of criteria.entries()) {
        questions[criterionKey(index)] = {
          type: 'boolean',
          instructions: {
            question: OUTPUT_EVAL_QUESTION,
            criterion_id: criterion.criterion_id,
            statement: criterion.statement,
          },
        };
      }
      outcome = await port.evaluate(
        {
          request_id: captured.request_id,
          site: OUTPUT_EVAL_SITE,
          role: 'working',
          kind: 'boolean',
          state: captured.state,
          questions,
          terms: { ...captured.terms, tier: 'decision' },
        },
        signal,
      );
    } catch {
      /* Exception text may contain credentials; never record it. */
    }
  }
  const now = current();
  return transitionOutputEval(
    captured,
    {
      outcome,
      state_revision: captured.state_revision,
      observed_at: now.observed_at,
      cancelled: signal?.aborted ?? false,
    },
    now,
  );
}
