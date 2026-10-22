/**
 * Executing the corpus against hosted Jev and recording what happened.
 *
 * The route table lists the Vercel AI Gateway first and TypeSafe direct
 * second, omitting routes without credentials. Every configured destination
 * is named in the terms, which permits escalation — drop one and that route
 * is excluded at routing rather
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
  resolveTypesafeApiKey,
  type AttemptRecord,
  type Clock,
  type EvaluationKind,
  type EvaluationOutcome,
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
import { TYPESAFE_AI_ADAPTER, TYPESAFE_AI_DESTINATION, typesafeAiEvaluator } from '@weave/gateway/typesafe-ai';
import type { DecisionCase } from './corpus.ts';
import { reduceAnswers, renderQuestions, renderState, type Ranking } from './shapes.ts';

export const EVALUATION_KINDS: readonly EvaluationKind[] = ['choice', 'score', 'boolean'];
export const JEV_REFERENCE_MODEL = 'jev-1.14.0';

/** Effective TypeSafe request settings. null records a field the adapter cannot send. */
const TYPESAFE_REQUEST_PARAMS = { max_output_tokens: null, shuffle: false } as const;

/** Only fixed configuration messages may be printed by the CLI error boundary. */
export class ProbeConfigurationError extends Error {}

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

/** Conservative retry spacing for the reference route, not a measured quota. */
const REFERENCE_DECLARED_LIMIT = { requests: 60, window_ms: 60_000 } as const;

export interface RouteOptions {
  /** One pinned TypeSafe direct routed unit per kind, with no fallback. */
  readonly reference?: boolean;
  /** Wait out a throttle on the free route instead of escalating to the billed one. */
  readonly preferFree: boolean;
  /**
   * Direct TypeSafe model. Blank or absent means jev-preview. The composition
   * root reads `JEV_MODEL` and passes it here; this module reads no env.
   */
  readonly model?: string;
  /** Route to the local Kev service instead of the hosted Jev routes. */
  readonly local?: boolean;
}

function jevRoutes(kind: EvaluationKind, credentials: Credentials, options: RouteOptions): RoutedUnit[] {
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

  const routes: RoutedUnit[] = [];
  if (options.reference !== true && credentials.vercel !== undefined) {
    routes.push({
      ...shared,
      routed_unit_id: `${kind}@vercel`,
      adapter: VERCEL_AI_GATEWAY_ADAPTER,
      model: 'typesafe-ai/jev',
      destination: VERCEL_AI_GATEWAY_DESTINATION,
      ...(options.preferFree ? { rate_limits: [VERCEL_DECLARED_LIMIT] } : {}),
    });
  }
  if (credentials.typesafe !== undefined) {
    routes.push({
      ...shared,
      routed_unit_id: `${kind}@typesafe`,
      adapter: TYPESAFE_AI_ADAPTER,
      // The direct API names the model differently than the gateway catalogue.
      model: options.reference === true ? JEV_REFERENCE_MODEL : options.model?.trim() || 'jev-preview',
      destination: TYPESAFE_AI_DESTINATION,
      ...(options.reference === true ? { rate_limits: [REFERENCE_DECLARED_LIMIT] } : {}),
    });
  }
  return routes;
}

export interface Credentials {
  readonly vercel: string | undefined;
  readonly typesafe: string | undefined;
}

/** Every hosted route the credentials allow, in the order the gateway tries them. */
export function jevRouteTable(credentials: Credentials, options: RouteOptions): RoutedUnit[] {
  validateReferenceOptions(options);
  if (options.reference === true && !credentials.typesafe?.trim()) {
    throw new ProbeConfigurationError(
      'reference mode requires a TypeSafe API key (TYPESAFE_API_KEY or TYPESAFE_AI_API_KEY)',
    );
  }
  return EVALUATION_KINDS.flatMap((kind) => jevRoutes(kind, credentials, options));
}

/** Reject conflicting programmatic reference settings without echoing their values. */
export function validateReferenceOptions(options: RouteOptions): void {
  if (options.reference !== true) return;
  if (options.local === true || (options.model !== undefined && options.model.trim() !== JEV_REFERENCE_MODEL)) {
    throw new ProbeConfigurationError(
      `reference mode requires model ${JEV_REFERENCE_MODEL}; conflicting model/local option`,
    );
  }
}

/** Validate every occurrence so duplicate flags cannot hide a conflicting model. */
export function validateReferenceArgs(argv: readonly string[]): void {
  if (!argv.includes('--reference')) return;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--model' || arg.startsWith('--model=')) {
      const model = arg === '--model' ? (argv[i + 1] ?? '') : arg.slice('--model='.length);
      validateReferenceOptions({ preferFree: false, reference: true, model });
    }
  }
}

/** Read from the environment by the composition root only. Never logged. */
export function readCredentials(
  env: NodeJS.ProcessEnv,
  options?: RouteOptions,
): Credentials | { readonly error: string } {
  if (options?.reference === true) {
    const typesafe = resolveTypesafeApiKey(env);
    return typesafe === undefined
      ? { error: 'reference mode requires a TypeSafe API key (TYPESAFE_API_KEY or TYPESAFE_AI_API_KEY)' }
      : { vercel: '', typesafe };
  }
  const vercel = env['AI_GATEWAY_API_KEY']?.trim() || undefined;
  const typesafe = resolveTypesafeApiKey(env);
  if (vercel === undefined && typesafe === undefined) {
    return {
      error:
        'Set TYPESAFE_API_KEY (preferred; TYPESAFE_AI_API_KEY is the legacy fallback) or AI_GATEWAY_API_KEY in .env.local (git-ignored) and rerun.',
    };
  }
  return { vercel, typesafe };
}

/** One line for the run log: which routes exist and which is tried first. Names no secret. */
export function describeRoutes(credentials: Credentials, options: RouteOptions): string {
  if (options.reference === true) return `routes: TypeSafe direct only (pinned ${JEV_REFERENCE_MODEL}, no fallback)`;
  if (credentials.vercel === undefined) return 'routes: TypeSafe direct only';
  const free = `; free route ${options.preferFree ? 'preferred, throttles waited out' : 'escalates on throttle'}`;
  return credentials.typesafe === undefined
    ? `routes: Vercel AI Gateway only${free}`
    : `routes: Vercel AI Gateway first, then TypeSafe direct${free}`;
}

/**
 * Which local Kev service to call. Read from the environment by the composition
 * root only, like the credentials above.
 *
 * Unset means the default PyTorch service. Both services report their backbone
 * and weights at `/api/info`, so a run can state what answered it rather than
 * inferring it from a port number.
 */
export function readKevBaseURL(env: NodeJS.ProcessEnv): string {
  const url = env['WEAVE_KEV_BASE_URL'];
  return url === undefined || url.trim().length === 0 ? KEV_LOCAL_BASE_URL : url.trim().replace(/\/+$/, '');
}

/** What a local Kev service says it is, for the run log. Never fails a run. */
export async function describeKevService(baseURL: string): Promise<string> {
  try {
    const response = await fetch(`${baseURL}/api/info`);
    if (!response.ok) return `${baseURL} (no identity: HTTP ${response.status})`;
    const info = (await response.json()) as Record<string, unknown>;
    const backend = typeof info['backend'] === 'string' ? info['backend'] : 'pytorch';
    const weights = typeof info['weights'] === 'string' ? ` ${info['weights']}` : '';
    return `${baseURL} — ${backend}${weights}, lora ${String(info['lora'])}`;
  } catch {
    return `${baseURL} (unreachable)`;
  }
}

export const realTimer: Timer = {
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) return reject(new Error('aborted'));
      const abort = () => {
        clearTimeout(id);
        reject(new Error('aborted'));
      };
      const id = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  },
};

export function createJevGateway(
  credentials: Credentials,
  clock: Clock,
  options: RouteOptions = { preferFree: false },
): InferenceGateway {
  return createInferenceGateway({
    routes: jevRouteTable(credentials, options),
    evaluators: [
      ...(options.reference === true || credentials.vercel === undefined
        ? []
        : [vercelAiGatewayEvaluator({ apiKey: credentials.vercel })]),
      ...(credentials.typesafe === undefined
        ? []
        : [
            typesafeAiEvaluator({
              apiKey: credentials.typesafe,
              shuffle: TYPESAFE_REQUEST_PARAMS.shuffle,
            }),
          ]),
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
  validateReferenceOptions(options);
  if (options.reference === true)
    return {
      quality: 'baseline',
      destinations: [TYPESAFE_AI_DESTINATION],
      max_context_tokens: 8_000,
      deadline: clock.now() + 120_000,
      cost_ceiling: 5_000,
      max_attempts: 4,
      max_attempts_per_route: 4,
    };
  if (options.local === true) return kevTerms(clock);
  return {
    quality: 'baseline',
    destinations: [
      ...(credentials.vercel === undefined ? [] : [VERCEL_AI_GATEWAY_DESTINATION]),
      ...(credentials.typesafe === undefined ? [] : [TYPESAFE_AI_DESTINATION]),
    ],
    max_context_tokens: 8_000,
    deadline: clock.now() + 120_000,
    cost_ceiling: 5_000,
    // Waiting out a throttle needs attempts to spend on the free route; the
    // default of 2 escalates almost immediately under sustained refusal.
    max_attempts: options.preferFree ? 8 : 4,
    max_attempts_per_route: options.preferFree ? 6 : 2,
  };
}

/** Request and provider evidence attached only to reference-mode records. */
export interface ReferenceProvenance {
  readonly resolved_model_id?: string | null;
  readonly provider_response_id?: string | null;
  readonly pin_mismatch?: boolean;
  readonly request_params?: {
    /** null means not sent: the System One wire does not send this setting. */
    readonly max_output_tokens: typeof TYPESAFE_REQUEST_PARAMS.max_output_tokens;
    readonly shuffle: typeof TYPESAFE_REQUEST_PARAMS.shuffle;
    readonly presentation_order: readonly string[];
  };
}

/** Missing identity, including a failed request with no response, is a mismatch. */
export function referenceProvenance(
  outcome: EvaluationOutcome,
  options: RouteOptions,
  order: readonly string[],
): ReferenceProvenance & { readonly routed_unit_id?: string } {
  if (options.reference !== true) return {};
  const last = outcome.attempts.at(-1);
  const resolved = outcome.status === 'accepted' ? outcome.resolved_model_id : last?.resolved_model_id;
  return {
    ...(last === undefined ? {} : { routed_unit_id: last.routed_unit_id }),
    resolved_model_id: resolved ?? null,
    provider_response_id:
      (outcome.status === 'accepted' ? outcome.provider_response_id : last?.provider_response_id) ?? null,
    pin_mismatch:
      resolved !== JEV_REFERENCE_MODEL ||
      outcome.attempts.some((a) => a.resolved_model_id !== undefined && a.resolved_model_id !== JEV_REFERENCE_MODEL),
    request_params: { ...TYPESAFE_REQUEST_PARAMS, presentation_order: [...order] },
  };
}

export function failureReason(outcome: EvaluationOutcome, options: RouteOptions): string | undefined {
  if (outcome.status === 'accepted') return undefined;
  if (
    options.reference === true &&
    outcome.attempts.length > 0 &&
    outcome.attempts.every((a) => a.disposition.status === 'failed' && a.disposition.failure.code === 'rate_limited')
  )
    return 'throttle_exhausted';
  return outcome.reason;
}

/** One executed record. Raw enough that scoring never needs the gateway again. */
export interface ProbeRecord extends ReferenceProvenance {
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
  signal?: AbortSignal,
): Promise<ProbeRecord> {
  const state = renderState(decision);
  const questions = renderQuestions(kind, decision);
  const startedAt = clock.now();
  const outcome = await gateway.evaluate(
    {
      request_id: `probe:${decision.id}:${kind}:${repeat}:o${orderingIndex}`,
      site: `probe.${decision.source}`,
      role: 'working',
      kind,
      state,
      questions,
      terms: probeTerms(credentials, clock, options),
    },
    signal,
  );
  const latency = clock.now() - startedAt;

  const base = {
    ...referenceProvenance(
      outcome,
      options,
      decision.candidates.map((c) => c.candidate_id),
    ),
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
    return { ...base, reason: failureReason(outcome, options)! };
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
 *
 * `baseURL` selects which service answers, not which model. Two of them speak
 * this contract at the same checkpoint — `kev.serve` in PyTorch, and the
 * llama.cpp-backed shim — and the adapter is indifferent to the difference, so
 * this stays a URL rather than a backend enum.
 */
export function createKevGateway(clock: Clock, baseURL: string = KEV_LOCAL_BASE_URL): InferenceGateway {
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
        baseURL,
        shuffle: false,
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
