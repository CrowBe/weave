/**
 * The inference gateway: bounded provider execution under the caller's terms
 * (ARCHITECTURE.md §6, CONTEXT.md "Inference gateway").
 *
 * It may retry or escalate within the terms; it cannot rescope the request or
 * relax acceptance. Every attempt is recorded and charged, including malformed
 * responses and failures, independently of whether its judgment is accepted.
 * Exhausted budget, an unroutable request and a passed deadline each produce an
 * explicit outcome — never a silently downgraded one.
 *
 * Generation and evaluation differ only in the provider call and the shape of
 * an accepted answer. Everything that makes this a gateway rather than a client
 * — routing, deadlines, reservations, attempt records, escalation — is the one
 * `runBounded` loop below, so neither operation can drift from the other's
 * accounting.
 */
import { priceAttempt, route, worstCaseCost, type RouteExclusion } from './routing.js';
import {
  answersMatchQuestions,
  nonEmptyText,
  type AttemptRecord,
  type BlockedReason,
  type Clock,
  type EvaluationAdapter,
  type EvaluationAnswers,
  type EvaluationKind,
  type EvaluationQuestion,
  type EvaluationQuestions,
  type EvaluationOutcome,
  type EvaluationRequest,
  type GenerationAdapter,
  type GenerationOutcome,
  type GenerationRequest,
  type InferenceGateway,
  type InferenceTerms,
  type Micros,
  type ProviderFailure,
  type ProviderUsage,
  type QuestionId,
  type RoutedUnit,
  type RoutedUnitId,
  type RouteTable,
  type RouteTarget,
  type Timer,
  type UnacceptedReason,
} from './types.js';

export interface GatewayConfig {
  readonly routes: RouteTable;
  /** Adapters serving `operation: 'generate'` routes. */
  readonly adapters?: readonly GenerationAdapter[];
  /** Adapters serving `operation: 'evaluate'` routes. */
  readonly evaluators?: readonly EvaluationAdapter[];
  readonly clock: Clock;
  /**
   * Lets the gateway wait out a throttle instead of escalating past it. Without
   * one it cannot wait, and a refusal that names a delay escalates immediately.
   */
  readonly timer?: Timer;
  /** Attempts a routed unit needs before its evidence may reorder routing. */
  readonly min_evidence_attempts?: number;
}

const DEFAULT_MIN_EVIDENCE_ATTEMPTS = 20;

/** One retry on a routed unit, then escalate. See InferenceTerms. */
const DEFAULT_MAX_ATTEMPTS_PER_ROUTE = 2;

/**
 * Construction validates the table against the adapters, so a misconfigured
 * route fails here rather than mid-goal. An evaluation route must name an
 * evaluator, not a text adapter: the two ports are not substitutable.
 */
export function createInferenceGateway(config: GatewayConfig): InferenceGateway {
  const generators = new Map((config.adapters ?? []).map((a) => [a.id, a]));
  const evaluators = new Map((config.evaluators ?? []).map((a) => [a.id, a]));

  for (const unit of config.routes) {
    const pool = unit.operation === 'generate' ? generators : evaluators;
    if (!pool.has(unit.adapter)) {
      throw new Error(
        `routed unit '${unit.routed_unit_id}' names unknown ${unit.operation} adapter '${unit.adapter}'`,
      );
    }
  }
  const minEvidence = config.min_evidence_attempts ?? DEFAULT_MIN_EVIDENCE_ATTEMPTS;

  return {
    async generate(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationOutcome> {
      const accept = request.accept ?? nonEmptyText;

      const bounded = await runBounded<GenerationValue>({
        clock: config.clock,
        timer: config.timer,
        signal,
        routes: config.routes,
        minEvidence,
        target: { operation: 'generate', kind: request.kind },
        terms: request.terms,
        invalid: invalidGeneration(request),
        attempt: async (unit) => {
          const adapter = generators.get(unit.adapter);
          if (adapter === undefined) return missingAdapter(unit);

          const result = await adapter.execute({
            model: unit.model,
            instructions: request.input.instructions,
            prompt: request.input.prompt,
            settings: unit.settings,
            signal,
          });
          if (result.status === 'failed') return failedAttempt(result.failure);

          const verdict = accept(result.text);
          return {
            usage: result.usage,
            disposition:
              verdict.status === 'accepted'
                ? {
                    status: 'accepted',
                    value: { text: result.text },
                    provider_response_id: result.provider_response_id,
                  }
                : { status: 'unaccepted', reason: verdict.reason },
          };
        },
      });

      const base = outcomeBase(request.request_id, request.site, bounded);
      return bounded.settled.status === 'accepted'
        ? {
            ...base,
            status: 'accepted',
            text: bounded.settled.value.text,
            routed_unit_id: bounded.settled.routed_unit_id,
            provider_response_id: bounded.settled.provider_response_id,
          }
        : { ...base, ...bounded.settled };
    },

    async evaluate<K extends EvaluationKind>(
      request: EvaluationRequest<K>,
      signal?: AbortSignal,
    ): Promise<EvaluationOutcome<K>> {
      const accept = request.accept;

      const bounded = await runBounded<EvaluationValue>({
        clock: config.clock,
        timer: config.timer,
        signal,
        routes: config.routes,
        minEvidence,
        target: { operation: 'evaluate', kind: request.kind },
        terms: request.terms,
        invalid: invalidEvaluation(request),
        attempt: async (unit) => {
          const adapter = evaluators.get(unit.adapter);
          if (adapter === undefined) return missingAdapter(unit);

          const result = await adapter.evaluate({
            model: unit.model,
            kind: request.kind,
            state: request.state,
            questions: request.questions,
            signal,
          });
          if (result.status === 'failed') return failedAttempt(result.failure);

          // Structural first: an answer set that does not match the questions
          // is a malformed response, and the caller's bar never sees it.
          const structural = answersMatchQuestions(request.kind, request.questions, result.answers);
          if (structural.status === 'rejected') {
            return {
              usage: result.usage,
              disposition: { status: 'unaccepted', reason: structural.reason },
            };
          }

          // Narrowed by `answersMatchQuestions`: every answer carries `kind`.
          const answers = result.answers as EvaluationAnswers<K>;
          const verdict = accept?.(answers) ?? { status: 'accepted' as const };
          return {
            usage: result.usage,
            disposition:
              verdict.status === 'accepted'
                ? {
                    status: 'accepted',
                    value: { answers, confidence: result.confidence },
                    provider_response_id: result.provider_response_id,
                  }
                : { status: 'unaccepted', reason: verdict.reason },
          };
        },
      });

      const base = outcomeBase(request.request_id, request.site, bounded);
      return bounded.settled.status === 'accepted'
        ? {
            ...base,
            status: 'accepted',
            kind: request.kind,
            answers: bounded.settled.value.answers as EvaluationAnswers<K>,
            confidence: bounded.settled.value.confidence,
            routed_unit_id: bounded.settled.routed_unit_id,
            provider_response_id: bounded.settled.provider_response_id,
          }
        : { ...base, ...bounded.settled };
    },
  };
}

// ---------------------------------------------------------------------------
// The bounded attempt loop, shared by both operations.
// ---------------------------------------------------------------------------

interface GenerationValue {
  readonly text: string;
}

interface EvaluationValue {
  readonly answers: EvaluationAnswers;
  readonly confidence: Readonly<Record<QuestionId, number>> | undefined;
}

/** What one provider attempt produced, before it is priced and recorded. */
interface AttemptResult<T> {
  readonly usage: ProviderUsage;
  readonly disposition:
    | { readonly status: 'accepted'; readonly value: T; readonly provider_response_id: string | undefined }
    | { readonly status: 'unaccepted'; readonly reason: string }
    | { readonly status: 'failed'; readonly failure: ProviderFailure };
}

type Settled<T> =
  | {
      readonly status: 'accepted';
      readonly value: T;
      readonly routed_unit_id: RoutedUnitId;
      readonly provider_response_id: string | undefined;
    }
  | { readonly status: 'unaccepted'; readonly reason: UnacceptedReason }
  | { readonly status: 'blocked'; readonly reason: BlockedReason };

interface Bounded<T> {
  readonly settled: Settled<T>;
  readonly attempts: readonly AttemptRecord[];
  readonly spent: Micros;
  readonly uncertainty: readonly string[];
}

interface BoundedParams<T> {
  readonly clock: Clock;
  readonly timer: Timer | undefined;
  readonly signal: AbortSignal | undefined;
  readonly routes: RouteTable;
  readonly minEvidence: number;
  readonly target: RouteTarget;
  readonly terms: InferenceTerms;
  /** A description of why the request is unusable, or null. */
  readonly invalid: string | null;
  readonly attempt: (unit: RoutedUnit) => Promise<AttemptResult<T>>;
}

async function runBounded<T>(params: BoundedParams<T>): Promise<Bounded<T>> {
  const { clock, terms } = params;
  const perRoute = terms.max_attempts_per_route ?? DEFAULT_MAX_ATTEMPTS_PER_ROUTE;
  const attempts: AttemptRecord[] = [];
  const uncertainty: string[] = [];
  let spent: Micros = 0;

  const finish = (settled: Settled<T>): Bounded<T> => ({ settled, attempts, spent, uncertainty });

  if (params.invalid !== null) {
    uncertainty.push(params.invalid);
    return finish({ status: 'blocked', reason: 'invalid_request' });
  }

  if (clock.now() >= terms.deadline) {
    return finish({ status: 'blocked', reason: 'deadline_passed' });
  }

  const decision = route(params.routes, params.target, terms, params.minEvidence);
  uncertainty.push(...decision.uncertainty);
  if (decision.order.length === 0) {
    return finish({ status: 'blocked', reason: blockedRoutingReason(decision.excluded) });
  }

  let lastFailed = false;
  /** Set when the gateway waited; consumed by the next attempt's record. */
  let waitedMs = 0;

  for (const unit of decision.order) {
    const worstCase = worstCaseCost(unit, terms);

    let escalate = false;
    let routeAttempts = 0;
    while (!escalate) {
      if (attempts.length >= terms.max_attempts) {
        return finish({ status: 'unaccepted', reason: 'attempts_exhausted' });
      }
      // This routed unit has had its share of the budget. Escalating keeps a
      // fallback reachable when the first route keeps failing retryably.
      if (routeAttempts >= perRoute) {
        escalate = true;
        break;
      }
      if (clock.now() >= terms.deadline) {
        return finish({ status: 'unaccepted', reason: 'deadline_reached' });
      }
      // Reserve the worst case before spending it: concurrent callers
      // cannot each plan against the same unreserved remainder.
      if (spent + worstCase > terms.cost_ceiling) {
        escalate = true;
        break;
      }

      routeAttempts += 1;
      const started_at = clock.now();
      const result = await params.attempt(unit);
      const ended_at = clock.now();

      const metered = meteredCost(unit, terms, result.usage);
      const cost = metered ?? worstCase;
      if (metered === null) {
        uncertainty.push(
          `attempt ${attempts.length + 1} on ${unit.routed_unit_id}: usage unreported, charged worst case`,
        );
      } else if (priceAttempt(unit, terms, { input_tokens: result.usage.input_tokens ?? 0, output_tokens: result.usage.output_tokens ?? 0 }).cache_ignored) {
        uncertainty.push(
          `attempt ${attempts.length + 1} on ${unit.routed_unit_id}: prefix cache ignored, cached tokens exceed the input`,
        );
      }
      spent += cost;

      const base: Omit<AttemptRecord, 'disposition'> = {
        attempt: attempts.length + 1,
        routed_unit_id: unit.routed_unit_id,
        model: unit.model,
        started_at,
        ended_at,
        usage: result.usage,
        cost,
        cost_is_upper_bound: metered === null,
        ...(waitedMs > 0 ? { waited_ms: waitedMs } : {}),
      };
      waitedMs = 0;

      const disposition = result.disposition;

      if (disposition.status === 'failed') {
        attempts.push({ ...base, disposition: { status: 'failed', failure: disposition.failure } });
        lastFailed = true;
        if (disposition.failure.code === 'cancelled') {
          return finish({ status: 'unaccepted', reason: 'provider_failed' });
        }
        // A retryable fault is worth the same route again; anything else
        // means this routed unit is the wrong one for these terms.
        if (!disposition.failure.retryable) {
          escalate = true;
          continue;
        }

        // Retryable, but not necessarily retryable *now*. A throttle refuses a
        // second time if asked a second time, so an immediate retry spends an
        // attempt to be told the same thing. Wait when a delay is known and
        // fits; escalate when it does not, because a fallback that answers is
        // worth more than a preferred route that is not ready yet.
        const delay = retryDelayMs(disposition.failure, unit);
        if (delay <= 0) continue;

        if (params.timer === undefined) {
          uncertainty.push(
            `${unit.routed_unit_id}: waiting ${Math.round(delay)}ms was indicated but no timer is configured; escalated instead`,
          );
          escalate = true;
        } else if (clock.now() + delay >= terms.deadline) {
          // The caller's deadline is the bound on waiting. Sitting past it
          // would turn a recoverable throttle into a missed deadline.
          uncertainty.push(
            `${unit.routed_unit_id}: waiting ${Math.round(delay)}ms would pass the deadline; escalated instead`,
          );
          escalate = true;
        } else if (await sleepInterrupted(params.timer, delay, params.signal)) {
          // The caller pulled out mid-wait. That ends the request the same way
          // a cancelled provider call does, rather than starting an attempt
          // nobody is waiting for any more.
          return finish({ status: 'unaccepted', reason: 'provider_failed' });
        } else {
          waitedMs = delay;
        }
        continue;
      }

      if (disposition.status === 'accepted') {
        attempts.push({ ...base, disposition: { status: 'accepted' } });
        return finish({
          status: 'accepted',
          value: disposition.value,
          routed_unit_id: unit.routed_unit_id,
          provider_response_id: disposition.provider_response_id,
        });
      }

      attempts.push({ ...base, disposition: { status: 'unaccepted', reason: disposition.reason } });
      lastFailed = false;
      // Acceptance is the caller's bar and the gateway may not lower it:
      // retrying the same routed unit is unlikely to clear it, so escalate.
      escalate = true;
    }
  }

  if (attempts.length === 0) return finish({ status: 'blocked', reason: 'no_budget' });
  if (spent + cheapestWorstCase(decision.order, terms) > terms.cost_ceiling) {
    return finish({ status: 'unaccepted', reason: 'budget_exhausted' });
  }
  return finish({ status: 'unaccepted', reason: lastFailed ? 'provider_failed' : 'attempts_exhausted' });
}

function outcomeBase(
  request_id: string,
  site: string,
  bounded: Bounded<unknown>,
): { request_id: string; site: string; attempts: readonly AttemptRecord[]; spent: Micros; uncertainty: readonly string[] } {
  return {
    request_id,
    site,
    attempts: bounded.attempts,
    spent: bounded.spent,
    uncertainty: bounded.uncertainty,
  };
}

function failedAttempt<T>(failure: ProviderFailure): AttemptResult<T> {
  return {
    usage: { input_tokens: undefined, output_tokens: undefined },
    disposition: { status: 'failed', failure },
  };
}

/** Construction proved the adapter exists; this keeps the lookup type-honest. */
function missingAdapter<T>(unit: RoutedUnit): AttemptResult<T> {
  return failedAttempt({
    code: 'invalid_request',
    message: `routed unit '${unit.routed_unit_id}' names unknown adapter '${unit.adapter}'`,
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// Request validation. A request the gateway cannot honour as written is
// blocked, not quietly repaired.
// ---------------------------------------------------------------------------

function invalidTerms(terms: InferenceTerms): string | null {
  if (terms.max_attempts < 1) return 'terms.max_attempts must be at least 1';
  if (terms.max_attempts_per_route !== undefined && terms.max_attempts_per_route < 1) {
    return 'terms.max_attempts_per_route must be at least 1';
  }
  if (terms.cost_ceiling < 0) return 'terms.cost_ceiling must not be negative';
  if (terms.max_context_tokens < 1) return 'terms.max_context_tokens must be at least 1';
  if (terms.destinations.length === 0) return 'terms.destinations must permit at least one destination';
  return null;
}

function invalidGeneration(request: GenerationRequest): string | null {
  const terms = invalidTerms(request.terms);
  if (terms !== null) return terms;
  if (request.input.prompt.trim().length === 0) return 'input.prompt must not be empty';
  return null;
}

function invalidEvaluation<K extends EvaluationKind>(request: EvaluationRequest<K>): string | null {
  const terms = invalidTerms(request.terms);
  if (terms !== null) return terms;

  // Widened deliberately: with a generic K the `Extract` in EvaluationQuestions
  // stays unresolved and `question.type` will not narrow the union.
  // Generation rejects an empty prompt; evaluation rejects an empty state for
  // the same reason, rather than paying a provider to judge nothing.
  if (typeof request.state === 'string' && request.state.trim().length === 0) {
    return 'state must not be empty';
  }

  const entries: readonly (readonly [string, EvaluationQuestion])[] = Object.entries(
    request.questions as EvaluationQuestions,
  );
  if (entries.length === 0) return 'questions must not be empty';

  for (const [id, question] of entries) {
    // One request, one answer shape: the route was selected for this kind.
    if (question.type !== request.kind) {
      return `question '${id}' is a ${question.type} question in a ${request.kind} request`;
    }
    if (question.type === 'choice' && Object.keys(question.criteria).length < 2) {
      return `choice question '${id}' must offer at least two options`;
    }
    if (question.type === 'score' && question.criteria.length < 2) {
      return `score question '${id}' must define at least two levels`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Wait, and say whether the wait was cut short.
 *
 * A caller's timer may well reject on abort — that is the ordinary JavaScript
 * idiom — and the gateway may not let that escape as a thrown `generate`: an
 * unroutable, refused or abandoned request has an outcome, never an exception.
 */
async function sleepInterrupted(
  timer: Timer,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await timer.sleep(ms, signal);
  } catch {
    return true;
  }
  return signal?.aborted === true;
}

/**
 * How long to wait before asking this routed unit again.
 *
 * The provider's own figure wins outright. Failing that, a declared rate limit
 * gives an estimate — but only for a refusal that identifies itself as a rate
 * limit, since the even spacing implied by a request quota says nothing about
 * how long a 503 will last. Zero means retry at once, which is right for a
 * transient fault and wrong for a throttle.
 */
function retryDelayMs(failure: ProviderFailure, unit: RoutedUnit): number {
  if (failure.retry_after_ms !== undefined) return Math.max(0, failure.retry_after_ms);
  if (failure.code !== 'rate_limited') return 0;

  const limits = unit.rate_limits;
  if (limits === undefined || limits.length === 0) return 0;

  // The tightest declared window, spread evenly. If the limit actually hit was
  // a longer one — a daily quota rather than a per-minute rate — the next
  // attempt is refused too and the per-route bound escalates. A wrong estimate
  // costs one attempt; it does not cost the deadline.
  return Math.min(...limits.map((limit) => limit.window_ms / limit.requests));
}

/**
 * Actual cost when the provider reported usage; null when it did not.
 * A missing report stays the cold ceiling. The hit discount is not invented.
 */
function meteredCost(unit: RoutedUnit, terms: InferenceTerms, usage: ProviderUsage): Micros | null {
  if (usage.input_tokens === undefined || usage.output_tokens === undefined) return null;
  return priceAttempt(unit, terms, { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }).cost;
}

function cheapestWorstCase(order: readonly RoutedUnit[], terms: InferenceTerms): Micros {
  return Math.min(...order.map((u) => worstCaseCost(u, terms)));
}

/** Nothing was routable: say whether the money or the policy was the reason. */
function blockedRoutingReason(excluded: readonly RouteExclusion[]): 'no_route' | 'no_budget' {
  const considered = excluded.filter((e) => e.reason !== 'kind_mismatch' && e.reason !== 'operation_mismatch');
  return considered.length > 0 && considered.every((e) => e.reason === 'unaffordable') ? 'no_budget' : 'no_route';
}
