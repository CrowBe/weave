/**
 * Executing the corpus against hosted Jev and recording what happened.
 *
 * The route table lists the Vercel AI Gateway first and TypeSafe direct
 * second. Both destinations are named in the terms, which is what permits the
 * escalation at all — drop one and that route is excluded at routing rather
 * than silently used. A timer is supplied, so a throttle that names a delay is
 * waited out and recorded in `waited_ms` instead of escalating past the
 * preferred route on first refusal.
 *
 * Nothing here judges an answer. It records the answer, the ranking the shape's
 * decision rule produced, every attempt, and the wall clock around the call.
 * Scoring is a separate offline pass so re-analysis costs no inference.
 */
import {
  createInferenceGateway,
  type AttemptRecord,
  type Clock,
  type EvaluationKind,
  type InferenceGateway,
  type InferenceTerms,
  type RoutedUnit,
  type Timer,
} from '@weave/gateway';
import {
  VERCEL_AI_GATEWAY_ADAPTER,
  VERCEL_AI_GATEWAY_DESTINATION,
  vercelAiGatewayEvaluator,
} from '@weave/gateway/vercel-ai-gateway';
import {
  KEV_LOCAL_ADAPTER,
  KEV_LOCAL_BASE_URL,
  KEV_LOCAL_DESTINATION,
  kevLocalEvaluator,
} from '@weave/gateway/kev-local';
import {
  TYPESAFE_AI_ADAPTER,
  TYPESAFE_AI_DESTINATION,
  typesafeAiEvaluator,
} from '@weave/gateway/typesafe-ai';
import type { DecisionCase } from './corpus.ts';
import { reduceAnswers, renderQuestions, renderState, type Ranking } from './shapes.ts';

export const EVALUATION_KINDS: readonly EvaluationKind[] = ['choice', 'score', 'boolean'];

/** Jev bills input only, at $0.042 per million tokens. */
const JEV_PRICE = { input_per_mtok: 42_000, output_per_mtok: 0 } as const;

/**
 * Declared, not measured: what the vendor documents or an operator observed.
 * It never suppresses an attempt and is never counted down as a quota. Its one
 * job is to estimate how long to wait once the free route has actually
 * refused and has not said for how long, so a throttle is waited out rather
 * than escalated past onto the billed route.
 */
const VERCEL_DECLARED_LIMIT = { requests: 60, window_ms: 60_000 } as const;

export interface RouteOptions {
  /** Wait out a throttle on the free route instead of escalating to the billed one. */
  readonly preferFree: boolean;
  /** Route to the local Kev service instead of the hosted Jev routes. */
  readonly local?: boolean;
}

function jevRoutes(kind: EvaluationKind, includeDirect: boolean, options: RouteOptions): RoutedUnit[] {
  const shared = {
    operation: 'evaluate',
    kind,
    context_profile: 'profile.judgment-site-probe',
    context_profile_version: 1,
    prompt_template: `template.probe.${kind}`,
    prompt_template_version: 1,
    settings: { max_output_tokens: 512 },
    quality: 'baseline',
    context_limit_tokens: 128_000,
    price: JEV_PRICE,
  } as const;

  const routes: RoutedUnit[] = [
    {
      ...shared,
      routed_unit_id: `${kind}@vercel`,
      adapter: VERCEL_AI_GATEWAY_ADAPTER,
      model: 'typesafe-ai/jev',
      destination: VERCEL_AI_GATEWAY_DESTINATION,
      ...(options.preferFree ? { rate_limits: [VERCEL_DECLARED_LIMIT] } : {}),
    },
  ];
  if (includeDirect) {
    routes.push({
      ...shared,
      routed_unit_id: `${kind}@typesafe`,
      adapter: TYPESAFE_AI_ADAPTER,
      // The direct API names the model differently than the gateway catalogue.
      model: 'jev-latest',
      destination: TYPESAFE_AI_DESTINATION,
    });
  }
  return routes;
}

export interface Credentials {
  readonly vercel: string;
  readonly typesafe: string | undefined;
}

/** Read from the environment by the composition root only. Never logged. */
export function readCredentials(env: NodeJS.ProcessEnv): Credentials | { readonly error: string } {
  const vercel = env['AI_GATEWAY_API_KEY'];
  if (vercel === undefined || vercel.trim().length === 0) {
    return { error: 'AI_GATEWAY_API_KEY is not set. Put it in .env.local (git-ignored) and rerun.' };
  }
  const typesafe = env['TYPESAFE_AI_API_KEY'];
  return { vercel, typesafe: typesafe !== undefined && typesafe.trim().length > 0 ? typesafe : undefined };
}

export const realTimer: Timer = {
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) return reject(new Error('aborted'));
      const id = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(id);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  },
};

export function createJevGateway(
  credentials: Credentials,
  clock: Clock,
  options: RouteOptions = { preferFree: false },
): InferenceGateway {
  const includeDirect = credentials.typesafe !== undefined;
  return createInferenceGateway({
    routes: EVALUATION_KINDS.flatMap((kind) => jevRoutes(kind, includeDirect, options)),
    evaluators: [
      vercelAiGatewayEvaluator({ apiKey: credentials.vercel }),
      ...(credentials.typesafe === undefined ? [] : [typesafeAiEvaluator({ apiKey: credentials.typesafe })]),
    ],
    clock,
    timer: realTimer,
  });
}

export function probeTerms(
  credentials: Credentials,
  clock: Clock,
  options: RouteOptions = { preferFree: false },
): InferenceTerms {
  if (options.local === true) return kevTerms(clock);
  return {
    quality: 'baseline',
    destinations:
      credentials.typesafe === undefined
        ? [VERCEL_AI_GATEWAY_DESTINATION]
        : [VERCEL_AI_GATEWAY_DESTINATION, TYPESAFE_AI_DESTINATION],
    max_context_tokens: 8_000,
    deadline: clock.now() + 120_000,
    cost_ceiling: 5_000,
    // Waiting out a throttle needs attempts to spend on the free route; the
    // default of 2 escalates almost immediately under sustained refusal.
    max_attempts: options.preferFree ? 8 : 4,
    max_attempts_per_route: options.preferFree ? 6 : 2,
  };
}

/** One executed record. Raw enough that scoring never needs the gateway again. */
export interface ProbeRecord {
  readonly case_id: string;
  readonly source: string;
  readonly kind: EvaluationKind;
  readonly repeat: number;
  /** Which presentation order this record used; 0 is the corpus order. */
  readonly ordering_index: number;
  readonly label: string;
  /** Candidate ids in the order the model actually saw them. */
  readonly candidate_ids: readonly string[];
  readonly state_chars: number;
  readonly latency_ms: number;
  readonly status: string;
  readonly reason?: string;
  readonly routed_unit_id?: string;
  readonly spent: number;
  readonly attempts: readonly {
    readonly attempt: number;
    readonly routed_unit_id: string;
    readonly model: string;
    readonly status: string;
    readonly detail?: string;
    readonly cost: number;
    readonly waited_ms?: number;
    readonly input_tokens?: number;
  }[];
  readonly answers?: unknown;
  readonly provider_confidence?: Readonly<Record<string, number>>;
  readonly ranking?: Ranking;
}

function summariseAttempt(attempt: AttemptRecord): ProbeRecord['attempts'][number] {
  const d = attempt.disposition;
  return {
    attempt: attempt.attempt,
    routed_unit_id: attempt.routed_unit_id,
    model: attempt.model,
    status: d.status,
    ...(d.status === 'failed' ? { detail: d.failure.code } : {}),
    ...(d.status === 'unaccepted' ? { detail: d.reason } : {}),
    cost: attempt.cost,
    ...(attempt.waited_ms === undefined ? {} : { waited_ms: attempt.waited_ms }),
    ...(attempt.usage.input_tokens === undefined ? {} : { input_tokens: attempt.usage.input_tokens }),
  };
}

export async function runCase(
  gateway: InferenceGateway,
  clock: Clock,
  credentials: Credentials,
  decision: DecisionCase,
  kind: EvaluationKind,
  repeat: number,
  options: RouteOptions = { preferFree: false },
  orderingIndex = 0,
): Promise<ProbeRecord> {
  const state = renderState(decision);
  const questions = renderQuestions(kind, decision);
  const startedAt = clock.now();
  const outcome = await gateway.evaluate({
    request_id: `probe:${decision.id}:${kind}:${repeat}:o${orderingIndex}`,
    site: `probe.${decision.source}`,
    role: 'working',
    kind,
    state,
    questions,
    terms: probeTerms(credentials, clock, options),
  });
  const latency = clock.now() - startedAt;

  const base = {
    case_id: decision.id,
    source: decision.source,
    kind,
    repeat,
    ordering_index: orderingIndex,
    label: decision.label,
    candidate_ids: decision.candidates.map((c) => c.candidate_id),
    state_chars: JSON.stringify(state).length,
    latency_ms: latency,
    status: outcome.status,
    spent: outcome.spent,
    attempts: outcome.attempts.map(summariseAttempt),
  };

  if (outcome.status !== 'accepted') {
    return { ...base, reason: outcome.reason };
  }
  return {
    ...base,
    routed_unit_id: outcome.routed_unit_id,
    answers: outcome.answers,
    ...(outcome.confidence === undefined ? {} : { provider_confidence: outcome.confidence }),
    ranking: reduceAnswers(kind, decision, outcome.answers),
  };
}

/**
 * Local Kev, as its own gateway with a single route.
 *
 * Deliberately not added as a fallback leg of the Jev chain: a head-to-head
 * has to be answered by the model under test on every record, and a shared
 * chain would let routing decide who answered what. The comparison is paired
 * by running the same corpus twice, once per gateway.
 *
 * Service lifecycle stays an operator concern (`benchmarks/inference/kev/SERVICE.md`).
 * The runtime seam here reports ready because the unit is started outside this
 * process; it does not install, supervise, or stop anything.
 */
export function createKevGateway(clock: Clock): InferenceGateway {
  const routes: RoutedUnit[] = EVALUATION_KINDS.map((kind) => ({
    operation: 'evaluate',
    kind,
    context_profile: 'profile.judgment-site-probe',
    context_profile_version: 1,
    prompt_template: `template.probe.${kind}`,
    prompt_template_version: 1,
    settings: { max_output_tokens: 512 },
    quality: 'baseline',
    // The service accepts 8192; the suite's own records all sat under 384.
    context_limit_tokens: 8_192,
    // Local compute. Nothing is billed, so a price would be a fiction.
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    routed_unit_id: `${kind}@kev`,
    adapter: KEV_LOCAL_ADAPTER,
    model: 'kev-4b',
    destination: KEV_LOCAL_DESTINATION,
  }));

  return createInferenceGateway({
    routes,
    evaluators: [
      kevLocalEvaluator({
        runtime: { ensureReady: async () => ({ status: 'ready' as const }) },
        baseURL: KEV_LOCAL_BASE_URL,
      }),
    ],
    clock,
    timer: realTimer,
  });
}

/** Terms for the local route: no cost ceiling to speak of, but a long deadline. */
export function kevTerms(clock: Clock): InferenceTerms {
  return {
    quality: 'baseline',
    destinations: [KEV_LOCAL_DESTINATION],
    max_context_tokens: 8_000,
    // Measured at ~6.4 s per request on this machine; a 2-minute deadline
    // would abort a slow record rather than record it.
    deadline: clock.now() + 600_000,
    cost_ceiling: 0,
    max_attempts: 2,
    max_attempts_per_route: 2,
  };
}
