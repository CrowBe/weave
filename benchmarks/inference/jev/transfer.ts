/**
 * Hosted Jev over Kev's `transfer-v4` held-out development split.
 *
 * The suite declares `trainable_sources: []`, `eval_only: true` and nine
 * holdout sources, so it is out of domain by construction for a checkpoint
 * trained on `decision-v4`. Whether it is out of domain for the *hosted*
 * checkpoint is not established by that manifest — see the disclosure in the
 * README. What the suite does give unconditionally is records this harness's
 * author did not write, which is exactly what the saturated Weave corpus
 * lacked.
 *
 * By default it runs the 125 records Kev was scored on, read from Kev's own
 * `predictions.jsonl`, so the comparison is paired on identical records rather
 * than across two different subsamples. `--all` runs the full 764.
 *
 * `noul` is the suite's (and the wire's) name for a boolean question.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock, EvaluationKind, EvaluationQuestion, InferenceGateway } from '@weave/gateway';
import { createJevGateway, probeTerms, type Credentials, type RouteOptions } from './run.ts';

export const KEV_HOME = process.env['WEAVE_KEV_HOME'] ?? join(homedir(), '.local/share/weave/kev');
export const SUITE = join(KEV_HOME, 'src/evals/v4/transfer-v4');
export const KEV_TRANSFER_RUN = join(KEV_HOME, 'runs/kev-4b-fp32-transfer/predictions.jsonl');

type SuiteLabel = string | number | boolean;

interface SuiteQuestion {
  readonly type: 'choice' | 'noul' | 'score';
  readonly instructions: string;
  readonly criteria?: unknown;
  readonly label: SuiteLabel;
  readonly src: string;
}

export interface SuiteRecord {
  readonly id: string;
  readonly source: string;
  readonly group: string;
  readonly variant: string;
  readonly state: unknown;
  readonly questionId: string;
  readonly question: SuiteQuestion;
}

export async function loadSuite(split = 'development'): Promise<SuiteRecord[]> {
  const text = await readFile(join(SUITE, `${split}.jsonl`), 'utf8');
  const records: SuiteRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as {
      state: unknown;
      questions: Record<string, SuiteQuestion>;
      _meta: { id: string; source: string; group_id: string; variant: string };
    };
    for (const [questionId, question] of Object.entries(row.questions)) {
      records.push({
        id: row._meta.id,
        source: question.src ?? row._meta.source,
        group: row._meta.group_id,
        variant: row._meta.variant,
        state: row.state,
        questionId,
        question,
      });
    }
  }
  return records;
}

/** Kev's own per-record outcome, for the paired comparison. */
export interface KevOutcome {
  readonly id: string;
  readonly correct: boolean;
  readonly latency_ms: number;
  readonly input_tokens: number;
}

export async function loadKevOutcomes(): Promise<Map<string, KevOutcome>> {
  const out = new Map<string, KevOutcome>();
  let text: string;
  try {
    text = await readFile(KEV_TRANSFER_RUN, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as {
      id: string;
      prediction: { latency_ms: number; input_tokens: number };
      rows: readonly { label: number; p: readonly number[] }[];
    };
    const first = row.rows[0];
    if (first === undefined) continue;
    let best = 0;
    for (let i = 1; i < first.p.length; i += 1) if ((first.p[i] ?? 0) > (first.p[best] ?? 0)) best = i;
    out.set(row.id, {
      id: row.id,
      correct: best === first.label,
      latency_ms: row.prediction.latency_ms,
      input_tokens: row.prediction.input_tokens,
    });
  }
  return out;
}

/** The suite's question, minus the answer, in the gateway's vocabulary. */
export function toGatewayQuestion(question: SuiteQuestion): { kind: EvaluationKind; question: EvaluationQuestion } {
  switch (question.type) {
    case 'choice':
      return {
        kind: 'choice',
        question: {
          type: 'choice',
          instructions: question.instructions,
          criteria: (question.criteria ?? {}) as Record<string, never>,
        },
      };
    case 'noul': {
      const criteria = question.criteria as { true?: unknown; false?: unknown } | undefined;
      return {
        kind: 'boolean',
        question: {
          type: 'boolean',
          instructions: question.instructions,
          ...(criteria === undefined
            ? {}
            : {
                criteria: {
                  ...(criteria.true === undefined ? {} : { true: criteria.true as string }),
                  ...(criteria.false === undefined ? {} : { false: criteria.false as string }),
                },
              }),
        },
      };
    }
    case 'score':
      return {
        kind: 'score',
        question: {
          type: 'score',
          instructions: question.instructions,
          criteria: (question.criteria ?? []) as readonly string[],
        },
      };
  }
}

/** Option keys in the suite's own order, so a uniform floor is 1/k. */
export function optionKeys(question: SuiteQuestion): readonly string[] {
  if (question.type === 'choice') return Object.keys((question.criteria ?? {}) as object);
  if (question.type === 'noul') return ['true', 'false'];
  return ((question.criteria ?? []) as readonly unknown[]).map((_, i) => String(i));
}

export interface TransferRecord {
  readonly id: string;
  /** Which presentation order this record used; 0 is the suite's own order. */
  readonly ordering_index: number;
  /** Option keys in the order the model saw them. */
  readonly presented: readonly string[];
  readonly source: string;
  readonly group: string;
  readonly variant: string;
  readonly type: string;
  readonly kind: EvaluationKind;
  readonly option_count: number;
  readonly label: SuiteLabel;
  readonly predicted?: SuiteLabel;
  readonly correct?: boolean;
  /** Absolute level error; `score` questions only. */
  readonly score_error?: number;
  readonly confidence?: number;
  readonly latency_ms: number;
  readonly status: string;
  readonly reason?: string;
  readonly routed_unit_id?: string;
  readonly attempts: number;
  readonly rate_limited: number;
  readonly waited_ms: number;
  readonly spent: number;
  readonly input_tokens?: number;
}

export async function runSuiteRecord(
  gateway: InferenceGateway,
  clock: Clock,
  credentials: Credentials,
  record: SuiteRecord,
  options: RouteOptions,
  ordering: readonly number[] = [],
  orderingIndex = 0,
): Promise<TransferRecord> {
  // Only `choice` has a presentational order; the helper returns the other
  // kinds unchanged, so this is a no-op for them.
  const asked = ordering.length === 0 ? record.question : permuteChoiceQuestion(record.question, ordering);
  const { kind, question } = toGatewayQuestion(asked);
  const keys = optionKeys(asked);
  const startedAt = clock.now();
  const outcome = await gateway.evaluate({
    request_id: `transfer:${record.id}:${record.questionId}:o${orderingIndex}`,
    site: `transfer.${record.source}`,
    role: 'working',
    kind,
    state: record.state as never,
    questions: { [record.questionId]: question } as never,
    terms: probeTerms(credentials, clock, options),
  });
  const latency = clock.now() - startedAt;

  let rateLimited = 0;
  let waited = 0;
  for (const attempt of outcome.attempts) {
    if (attempt.disposition.status === 'failed' && attempt.disposition.failure.code === 'rate_limited') rateLimited += 1;
    waited += attempt.waited_ms ?? 0;
  }
  const base = {
    id: record.id,
    source: record.source,
    ordering_index: orderingIndex,
    /** Option keys in the order the model actually saw them. */
    presented: keys,
    group: record.group,
    variant: record.variant,
    type: record.question.type,
    kind,
    option_count: keys.length,
    label: record.question.label,
    latency_ms: latency,
    status: outcome.status,
    attempts: outcome.attempts.length,
    rate_limited: rateLimited,
    waited_ms: waited,
    spent: outcome.spent,
  };
  if (outcome.status !== 'accepted') return { ...base, reason: outcome.reason };

  const answer = outcome.answers[record.questionId];
  const inputTokens = outcome.attempts[outcome.attempts.length - 1]?.usage.input_tokens;
  if (answer === undefined) return { ...base, reason: 'unanswered' };

  if (answer.type === 'choice') {
    return {
      ...base,
      predicted: answer.choice,
      correct: answer.choice === record.question.label,
      ...(answer.probabilities === undefined ? {} : { confidence: answer.probabilities[answer.choice] ?? 0 }),
      routed_unit_id: outcome.routed_unit_id,
      ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
    };
  }
  if (answer.type === 'boolean') {
    const predicted = answer.probability >= 0.5;
    return {
      ...base,
      predicted,
      correct: predicted === record.question.label,
      confidence: predicted ? answer.probability : 1 - answer.probability,
      routed_unit_id: outcome.routed_unit_id,
      ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
    };
  }
  const predicted = Math.round(answer.score);
  const label = Number(record.question.label);
  return {
    ...base,
    predicted,
    correct: predicted === label,
    score_error: Math.abs(answer.score - label),
    ...(answer.probabilities === undefined
      ? {}
      : { confidence: answer.probabilities[String(predicted)] ?? 0 }),
    routed_unit_id: outcome.routed_unit_id,
    ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
  };
}

export async function selectRecords(all: readonly SuiteRecord[], useAll: boolean): Promise<SuiteRecord[]> {
  if (useAll) return [...all];
  const kev = await loadKevOutcomes();
  if (kev.size === 0) return [...all];
  return all.filter((r) => kev.has(r.id));
}

/**
 * A choice question with its options presented in a different order.
 *
 * Scoped to `choice` deliberately. A `score` question's criteria are an ordered
 * scale, so permuting them changes what the levels mean rather than how they
 * are presented, and a `noul` question's two arms occupy fixed slots in the
 * wire format. Only `choice` has an order that is presentational.
 *
 * The suite itself already varies option order on some sources — one source
 * ships 48 records as `accept,reject` and 48 as `reject,accept` — so this
 * measures the same property the suite's authors were already controlling for.
 */
export function permuteChoiceQuestion(question: SuiteQuestion, order: readonly number[]): SuiteQuestion {
  if (question.type !== 'choice') return question;
  const criteria = (question.criteria ?? {}) as Record<string, unknown>;
  const keys = Object.keys(criteria);
  const reordered: Record<string, unknown> = {};
  for (const index of order) {
    const key = keys[index];
    if (key !== undefined) reordered[key] = criteria[key];
  }
  // Any key the ordering failed to cover is appended, so no option is dropped.
  for (const key of keys) if (!(key in reordered)) reordered[key] = criteria[key];
  return { ...question, criteria: reordered } as SuiteQuestion;
}
