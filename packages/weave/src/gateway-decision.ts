/**
 * Frontier weighing through the inference gateway (evaluation, kind `score`).
 */
import type { EvaluationAdapter, EvaluationContent, GenerationAdapter, InferenceGateway, RoutedUnit } from '@weave/gateway';
import { createInferenceGateway } from '@weave/gateway';
import type { Candidate, InferenceAttemptRecord, WeighRequest, WeighResult, WeightEntry } from './types.js';

export const LOCAL_DESTINATION = 'local';
export const HOSTED_DESTINATION = 'hosted.vendor';

const SCORE_CRITERIA = ['defer', 'consider', 'dispatch'] as const;

export class GatewayDecisionLayer {
  readonly implementation = 'gateway.evaluate@1';
  readonly async = true as const;

  constructor(
    private readonly gateway: InferenceGateway,
    private readonly destinations: readonly string[] = [LOCAL_DESTINATION],
  ) {}

  async weigh(request: WeighRequest): Promise<WeighResult> {
    const questions: Record<string, { type: 'score'; instructions: string; criteria: readonly (string | null)[] }> = {};
    for (const candidate of request.candidates) {
      questions[candidate.candidate_id] = {
        type: 'score',
        instructions: `How useful is ${candidate.operation} for the authorized goal?`,
        criteria: SCORE_CRITERIA,
      };
    }
    const outcome = await this.gateway.evaluate({
      request_id: `weigh:${request.state_revision}:${request.candidate_set.slice(0, 8)}`,
      site: 'frontier.weigh',
      role: 'working',
      kind: 'score',
      state: (request.view?.content as EvaluationContent) ?? { candidates: request.candidates.map((c) => c.candidate_id) },
      questions,
      terms: {
        quality: 'baseline',
        destinations: [...this.destinations],
        max_context_tokens: 8_000,
        deadline: Number.MAX_SAFE_INTEGER,
        cost_ceiling: 1_000_000,
        max_attempts: 3,
      },
    });
    const attempts = toAttempts(outcome.attempts);
    if (outcome.status !== 'accepted') {
      return {
        weights: [],
        attempts,
        spent: toMicros(outcome.spent),
        status: outcome.status,
        reason: outcome.reason,
        implementation: this.implementation,
      };
    }
    const weights: WeightEntry[] = request.candidates.map((candidate) => {
      const answer = outcome.answers[candidate.candidate_id];
      const score = answer && answer.type === 'score' ? answer.score / (SCORE_CRITERIA.length - 1) : 0;
      return { candidate_id: candidate.candidate_id, weight: score };
    });
    return {
      weights,
      attempts,
      spent: toMicros(outcome.spent),
      status: 'accepted',
      implementation: outcome.routed_unit_id,
    };
  }
}

/** Weave records cost as integer micros; gateway metering may yield a fraction. */
export function toMicros(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.ceil(value);
}

export function toAttempts(
  attempts: readonly {
    attempt: number;
    routed_unit_id: string;
    cost: number;
    cost_is_upper_bound: boolean;
    disposition: unknown;
  }[],
): InferenceAttemptRecord[] {
  return attempts.map((a) => ({
    attempt: a.attempt,
    routed_unit_id: a.routed_unit_id,
    cost: toMicros(a.cost),
    cost_is_upper_bound: a.cost_is_upper_bound,
    disposition: a.disposition,
  }));
}

export function scriptedInspectScores(candidates: readonly Candidate[]): Record<string, number> {
  const byOp: Record<string, number> = {
    'goal.complete': 2,
    'report.publish': 1.9,
    'report.assemble': 1.8,
    'goal.frame': 1.7,
    'source.inspect': 1.6,
  };
  const out: Record<string, number> = {};
  for (const candidate of candidates) {
    out[candidate.candidate_id] = byOp[candidate.operation] ?? 0;
  }
  return out;
}

const FRAME_PROFILE_ID = 'profile.frame@1';

export function localGenerateUnit(overrides: { routed_unit_id: string; adapter?: string }): RoutedUnit {
  return {
    operation: 'generate',
    kind: 'transform',
    context_profile: FRAME_PROFILE_ID,
    context_profile_version: 1,
    prompt_template: 'template.frame.bindings',
    prompt_template_version: 1,
    adapter: overrides.adapter ?? 'fixture.generate',
    model: 'fixture/framer',
    settings: { max_output_tokens: 256 },
    destination: LOCAL_DESTINATION,
    quality: 'baseline',
    context_limit_tokens: 8_000,
    price: { input_per_mtok: 1, output_per_mtok: 1 },
    routed_unit_id: overrides.routed_unit_id,
  };
}

export function localEvaluateUnit(overrides: {
  routed_unit_id: string;
  adapter?: string;
  destination?: string;
}): RoutedUnit {
  return {
    operation: 'evaluate',
    kind: 'score',
    context_profile: 'profile.frontier-weigh',
    context_profile_version: 1,
    prompt_template: 'template.weigh.score',
    prompt_template_version: 1,
    adapter: overrides.adapter ?? 'fixture.evaluate',
    model: 'fixture/weigher',
    settings: { max_output_tokens: 256 },
    destination: overrides.destination ?? LOCAL_DESTINATION,
    quality: 'baseline',
    context_limit_tokens: 8_000,
    price: { input_per_mtok: 1, output_per_mtok: 1 },
    routed_unit_id: overrides.routed_unit_id,
  };
}

export function hostedEvaluateUnit(overrides: { routed_unit_id: string; adapter?: string }): RoutedUnit {
  return localEvaluateUnit({
    routed_unit_id: overrides.routed_unit_id,
    adapter: overrides.adapter ?? 'fixture.hosted',
    destination: HOSTED_DESTINATION,
  });
}

export function fixtureGateway(options: {
  clock: { now(): number };
  generate?: GenerationAdapter;
  evaluate?: EvaluationAdapter;
  hosted?: EvaluationAdapter;
  includeHosted?: boolean;
}): InferenceGateway {
  const routes: RoutedUnit[] = [];
  const adapters: GenerationAdapter[] = [];
  const evaluators: EvaluationAdapter[] = [];
  if (options.generate) {
    adapters.push(options.generate);
    routes.push(localGenerateUnit({ routed_unit_id: 'frame.local', adapter: options.generate.id }));
  }
  if (options.evaluate) {
    evaluators.push(options.evaluate);
    routes.push(localEvaluateUnit({ routed_unit_id: 'weigh.local', adapter: options.evaluate.id }));
  }
  if (options.includeHosted) {
    const hosted = options.hosted ?? options.evaluate;
    if (hosted && hosted.id !== options.evaluate?.id) {
      evaluators.push(hosted);
    }
    routes.push(
      hostedEvaluateUnit({
        routed_unit_id: 'weigh.hosted',
        adapter: (options.hosted ?? options.evaluate)?.id ?? 'fixture.hosted',
      }),
    );
  }
  return createInferenceGateway({
    routes,
    adapters,
    evaluators,
    clock: options.clock,
  });
}
