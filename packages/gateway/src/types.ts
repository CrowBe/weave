/**
 * Inference gateway shapes, transcribed from CONTEXT.md ("Inference gateway",
 * "Inference kind", "Judgment site", "Context profile", "Routed unit",
 * "Routing", "Decision layer") and ARCHITECTURE.md §6.
 *
 * The gateway performs two operations. **Generation** asks a model for text.
 * **Evaluation** asks typed questions about shared state and gets back choices,
 * scores and probabilities — the shape the decision layer needs to produce
 * weights, and the shape a native evaluation model answers in. Both run under
 * the same terms, the same routing and the same attempt accounting; only the
 * provider call differs, so a judgment site is never forced to parse prose
 * into a score.
 *
 * This package imports neither Weave nor AgentFabric: the request interface is
 * usable by the runtime and by a generative implementation alike. Nothing here
 * reads a clock, a goal, or ambient state — time and provider execution arrive
 * as injected ports.
 */

export type JudgmentSite = string;
export type RoutedUnitId = string;
export type AdapterId = string;
export type QuestionId = string;

/** A reading from the caller's clock. The gateway never takes its own. */
export type Timestamp = number;

/** Accounting unit, 1e-6 of a currency unit. Budgets and prices share it. */
export type Micros = number;

/** Time enters as an injected reading (checks/no-ambient-clock.mjs). */
export interface Clock {
  now(): Timestamp;
}

/**
 * Waiting enters as a port for the same reason reading time does: runtime code
 * in this package may not reach for a timer of its own
 * (checks/no-ambient-clock.mjs). A gateway built without one cannot wait at
 * all, and escalates to the next route instead — the safe default, not a
 * degraded one.
 */
export interface Timer {
  /** Resolve after `ms` have elapsed, or earlier if `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Request vocabulary. Kinds belong to the gateway, not the capability
// catalogue: a capability is named for its operation, and its generative
// implementation declares the kind (CONTEXT.md "Inference kind").
// ---------------------------------------------------------------------------

export const INFERENCE_ROLES = ['framing', 'working', 'extension'] as const;
export type InferenceRole = (typeof INFERENCE_ROLES)[number];

/** What a routed unit is able to do. A route serves exactly one. */
export const ROUTE_OPERATIONS = ['generate', 'evaluate'] as const;
export type RouteOperation = (typeof ROUTE_OPERATIONS)[number];

/** Generation kinds: what the model is being asked to write. */
export const GENERATION_KINDS = ['classify', 'extract', 'transform', 'draft-contract', 'judge'] as const;
export type GenerationKind = (typeof GENERATION_KINDS)[number];

/**
 * Evaluation kinds are the answer shapes, because the shapes are not
 * interchangeable downstream: a choice names an option, a score places a
 * position on an ordered scale, a boolean carries a probability. The decision
 * layer turns each into a weight differently, a routed unit is good at one
 * without being good at another, and accept-rate evidence is only meaningful
 * per shape. So a request declares one shape and its questions all share it;
 * asking two shapes over the same state is two requests, separately routed and
 * separately accounted.
 */
export const EVALUATION_KINDS = ['choice', 'score', 'boolean'] as const;
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];

export type InferenceKind = GenerationKind | EvaluationKind;

/** Where request content may be sent. Routing filters on this before quality. */
export type DataDestination = string;

export const QUALITY_BARS = ['baseline', 'high'] as const;
export type QualityBar = (typeof QUALITY_BARS)[number];

/** `high` clears `baseline`; `baseline` does not clear `high`. */
export function qualityClears(offered: QualityBar, required: QualityBar): boolean {
  return required === 'baseline' || offered === 'high';
}

/**
 * What the caller supplies and the gateway may not relax: scope, quality,
 * permitted destinations, context limits, deadline and cost ceiling
 * (ARCHITECTURE.md §6). The gateway may retry or escalate inside these terms.
 */
/**
 * A recorded match between one routed unit and a view prefix digest.
 * The caller supplies it. The gateway does not discover it from Weave state.
 */
export interface PrefixCacheRecord {
  readonly routed_unit_id: RoutedUnitId;
  readonly prefix_digest: string;
  readonly cached_tokens: number;
}

export interface InferenceTerms {
  readonly quality: QualityBar;
  readonly destinations: readonly DataDestination[];
  readonly max_context_tokens: number;
  readonly deadline: Timestamp;
  readonly cost_ceiling: Micros;
  readonly max_attempts: number;
  /** Digest of the view prefix this request is pricing. Absent means no cache lookup. */
  readonly prefix_digest?: string;
  /** Absent means expected cost stays the cold window. */
  readonly prefix_cache?: PrefixCacheRecord;
  /**
   * How many attempts one routed unit may consume before the gateway escalates
   * to the next. Defaults to 2, so a retryable fault gets one retry.
   *
   * Without a per-route bound, a route that keeps failing retryably — a rate
   * limit is the ordinary case — spends the whole `max_attempts` budget and no
   * fallback route is ever reached. Raise it for a route worth waiting on; set
   * it to 1 to escalate on first fault.
   */
  readonly max_attempts_per_route?: number;
}

export type Acceptance =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

// ---------------------------------------------------------------------------
// Generation: text in, text out.
// ---------------------------------------------------------------------------

/** Content the caller has already filtered for disclosure. The gateway adds none. */
export interface GenerationInput {
  readonly instructions: string;
  readonly prompt: string;
}

/**
 * A deterministic check of a property that can actually be checked. A model
 * judge is another fallible observation and does not belong here
 * (ARCHITECTURE.md §6).
 */
export type GenerationAcceptance = (text: string) => Acceptance;

export interface GenerationRequest {
  readonly request_id: string;
  readonly site: JudgmentSite;
  readonly role: InferenceRole;
  readonly kind: GenerationKind;
  readonly input: GenerationInput;
  readonly terms: InferenceTerms;
  /** Defaults to `nonEmptyText`. */
  readonly accept?: GenerationAcceptance;
}

/** The default acceptance check: the model returned something to act on. */
export const nonEmptyText: GenerationAcceptance = (text) =>
  text.trim().length > 0 ? { status: 'accepted' } : { status: 'rejected', reason: 'empty_text' };

// ---------------------------------------------------------------------------
// Evaluation: shared state plus typed questions, typed answers out.
//
// The question and answer shapes are the gateway's own. They deliberately
// mirror what a native evaluation model accepts, so no adapter has to invent a
// distribution or squeeze a score out of prose.
// ---------------------------------------------------------------------------

/** JSON-compatible content: state, instructions, and criterion descriptions. */
export type EvaluationContent = string | { readonly [key: string]: unknown } | readonly unknown[];

/** Pick one named option. Criteria name the options and describe each. */
export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: EvaluationContent;
  readonly criteria: Readonly<Record<string, EvaluationContent | null>>;
}

/** Place the state on an ordered scale. At least two levels, indexed from zero. */
export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: EvaluationContent;
  readonly criteria: readonly (EvaluationContent | null)[];
}

/** Answer a proposition. The answer is a probability, not a verdict. */
export interface BooleanQuestion {
  readonly type: 'boolean';
  readonly instructions: EvaluationContent;
  readonly criteria?: {
    readonly true?: EvaluationContent | null;
    readonly false?: EvaluationContent | null;
  };
}

export type EvaluationQuestion = ChoiceQuestion | ScoreQuestion | BooleanQuestion;

export interface ChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export interface ScoreAnswer {
  readonly type: 'score';
  /** Fractional position in [0, levels - 1]. */
  readonly score: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export interface BooleanAnswer {
  readonly type: 'boolean';
  /** The model's estimated P(true). Not a confidence, and not calibrated. */
  readonly probability: number;
}

export type EvaluationAnswer = ChoiceAnswer | ScoreAnswer | BooleanAnswer;

/** A question set of one shape, keyed by question id. */
export type EvaluationQuestions<K extends EvaluationKind = EvaluationKind> = Readonly<
  Record<QuestionId, Extract<EvaluationQuestion, { type: K }>>
>;

export type EvaluationAnswers<K extends EvaluationKind = EvaluationKind> = Readonly<
  Record<QuestionId, Extract<EvaluationAnswer, { type: K }>>
>;

export type EvaluationAcceptance<K extends EvaluationKind = EvaluationKind> = (
  answers: EvaluationAnswers<K>,
) => Acceptance;

/**
 * `kind` is the shape every question and answer in this request takes. The
 * gateway rejects a mismatched question set as an invalid request rather than
 * routing it: a route was selected for one shape and cannot be held to another.
 */
export interface EvaluationRequest<K extends EvaluationKind = EvaluationKind> {
  readonly request_id: string;
  readonly site: JudgmentSite;
  readonly role: InferenceRole;
  readonly kind: K;
  /** One shared state, even when the value is an array. Already disclosure-filtered. */
  readonly state: EvaluationContent;
  readonly questions: EvaluationQuestions<K>;
  readonly terms: InferenceTerms;
  /**
   * An extra deterministic bar. The gateway always checks that every question
   * came back answered in the requested shape first; this adds the caller's own
   * — a minimum separation between choices, say, or a score out of a band.
   */
  readonly accept?: EvaluationAcceptance<K>;
}

// ---------------------------------------------------------------------------
// Routed units. A versioned context profile, prompt template, model and
// settings selected together; evaluation evidence attaches to the combination
// (CONTEXT.md "Routed unit").
// ---------------------------------------------------------------------------

export interface ModelSettings {
  /**
   * Required: an unbounded output cannot be priced against a cost ceiling.
   * Generation sends it to the provider; evaluation uses it only as the
   * accounting bound, since an evaluation call has no output cap to set.
   */
  readonly max_output_tokens: number;
  readonly temperature?: number;
}

export interface TokenPrice {
  readonly input_per_mtok: Micros;
  readonly output_per_mtok: Micros;
}

/**
 * A limit the provider is known to enforce on this route.
 *
 * Declared, not measured: this is what the vendor documents or what an
 * operator has observed, and it can be wrong. OpenRouter documents 20 requests
 * per minute on its free tier and did not refuse 25 issued at once, and its
 * own daily counter lagged the requests it had served. So a declared limit
 * never suppresses an attempt and is never treated as a quota the gateway can
 * count down. Its one job is to estimate how long to wait once the provider
 * has actually refused and has not said for how long.
 */
export interface RateLimit {
  readonly requests: number;
  readonly window_ms: number;
}

/** Observed outcomes for this routed unit at this site, supplied by the caller. */
export interface RouteEvidence {
  readonly attempts: number;
  readonly accepted: number;
}

interface RoutedUnitBase {
  readonly routed_unit_id: RoutedUnitId;
  readonly context_profile: string;
  readonly context_profile_version: number;
  readonly prompt_template: string;
  readonly prompt_template_version: number;
  readonly adapter: AdapterId;
  readonly model: string;
  readonly settings: ModelSettings;
  readonly destination: DataDestination;
  readonly quality: QualityBar;
  readonly context_limit_tokens: number;
  readonly price: TokenPrice;
  /** Known provider limits, used only to time a retry after a refusal. */
  readonly rate_limits?: readonly RateLimit[];
  readonly evidence?: RouteEvidence;
}

/** Operation and kind travel together: a generate route cannot claim a shape. */
export type RoutedUnit =
  | (RoutedUnitBase & { readonly operation: 'generate'; readonly kind: GenerationKind })
  | (RoutedUnitBase & { readonly operation: 'evaluate'; readonly kind: EvaluationKind });

export type RouteTable = readonly RoutedUnit[];

/** What routing is looking for. Same pairing as the unit it must match. */
export type RouteTarget =
  | { readonly operation: 'generate'; readonly kind: GenerationKind }
  | { readonly operation: 'evaluate'; readonly kind: EvaluationKind };

// ---------------------------------------------------------------------------
// Provider ports. Adapters implement execution; they decide nothing about
// scope, acceptance or budget, and they report failure rather than throwing,
// so a provider fault cannot bypass attempt accounting.
// ---------------------------------------------------------------------------

export interface ProviderUsage {
  readonly input_tokens: number | undefined;
  readonly output_tokens: number | undefined;
}

export const PROVIDER_FAILURES = [
  'unauthorized',
  'quota_exhausted',
  'rate_limited',
  'unavailable',
  'invalid_request',
  'cancelled',
  'timeout',
  'malformed_response',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURES)[number];

export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  readonly message: string;
  /** Whether the same routed unit is worth another attempt. */
  readonly retryable: boolean;
  /**
   * How long the provider said to wait, in milliseconds, when it said so — an
   * HTTP `Retry-After`, say. Authoritative: it beats anything the route
   * declares. Absent means the provider gave no figure, not that zero is safe.
   */
  readonly retry_after_ms?: number;
}

export interface GenerationCall {
  readonly model: string;
  readonly instructions: string;
  readonly prompt: string;
  readonly settings: ModelSettings;
  readonly signal: AbortSignal | undefined;
}

export type GenerationProviderResult =
  | {
      readonly status: 'completed';
      readonly text: string;
      readonly usage: ProviderUsage;
      readonly finish_reason: string;
      readonly provider_response_id: string | undefined;
    }
  | { readonly status: 'failed'; readonly failure: ProviderFailure };

export interface GenerationAdapter {
  readonly id: AdapterId;
  execute(call: GenerationCall): Promise<GenerationProviderResult>;
}

export interface EvaluationCall {
  readonly model: string;
  readonly kind: EvaluationKind;
  readonly state: EvaluationContent;
  readonly questions: EvaluationQuestions;
  readonly signal: AbortSignal | undefined;
}

export type EvaluationProviderResult =
  | {
      readonly status: 'completed';
      readonly answers: EvaluationAnswers;
      readonly usage: ProviderUsage;
      readonly provider_response_id: string | undefined;
      /**
       * A provider's own per-question confidence statistic, when it publishes
       * one. Separate from a boolean answer's probability, and not comparable
       * across providers — weights from different judgment sites are not
       * assumed to share a calibrated scale (ARCHITECTURE.md §4).
       */
      readonly confidence: Readonly<Record<QuestionId, number>> | undefined;
    }
  | { readonly status: 'failed'; readonly failure: ProviderFailure };

export interface EvaluationAdapter {
  readonly id: AdapterId;
  evaluate(call: EvaluationCall): Promise<EvaluationProviderResult>;
}

// ---------------------------------------------------------------------------
// Attempts and outcome. Every attempt is recorded and accounted for,
// independently of whether its judgment is accepted (ARCHITECTURE.md §6).
// ---------------------------------------------------------------------------

export type AttemptDisposition =
  | { readonly status: 'accepted' }
  | { readonly status: 'unaccepted'; readonly reason: string }
  | { readonly status: 'failed'; readonly failure: ProviderFailure };

export interface AttemptRecord {
  readonly attempt: number;
  readonly routed_unit_id: RoutedUnitId;
  readonly model: string;
  readonly started_at: Timestamp;
  readonly ended_at: Timestamp;
  readonly usage: ProviderUsage;
  readonly cost: Micros;
  /** True when usage was unreported and the worst case was charged instead. */
  readonly cost_is_upper_bound: boolean;
  /**
   * How long the gateway waited before making this attempt, when it waited.
   * Time the caller spent without an answer is part of what the attempt cost
   * them, so it is recorded rather than left to be inferred from the gap
   * between one attempt's `ended_at` and the next one's `started_at`.
   */
  readonly waited_ms?: number;
  readonly disposition: AttemptDisposition;
}

export type BlockedReason = 'invalid_request' | 'no_route' | 'no_budget' | 'deadline_passed';

export type UnacceptedReason =
  | 'attempts_exhausted'
  | 'budget_exhausted'
  | 'deadline_reached'
  | 'provider_failed';

interface OutcomeBase {
  readonly request_id: string;
  readonly site: JudgmentSite;
  readonly attempts: readonly AttemptRecord[];
  readonly spent: Micros;
  /** Conditions the caller must weigh: thin evidence, upper-bound costs. */
  readonly uncertainty: readonly string[];
}

/**
 * No budget or unusable routing produces an explicit blocked outcome, never
 * implicit permission to execute (ARCHITECTURE.md §6).
 */
export type GenerationOutcome =
  | (OutcomeBase & {
      readonly status: 'accepted';
      readonly text: string;
      readonly routed_unit_id: RoutedUnitId;
      readonly provider_response_id: string | undefined;
    })
  | (OutcomeBase & { readonly status: 'unaccepted'; readonly reason: UnacceptedReason })
  | (OutcomeBase & { readonly status: 'blocked'; readonly reason: BlockedReason });

export type EvaluationOutcome<K extends EvaluationKind = EvaluationKind> =
  | (OutcomeBase & {
      readonly status: 'accepted';
      readonly kind: K;
      readonly answers: EvaluationAnswers<K>;
      readonly confidence: Readonly<Record<QuestionId, number>> | undefined;
      readonly routed_unit_id: RoutedUnitId;
      readonly provider_response_id: string | undefined;
    })
  | (OutcomeBase & { readonly status: 'unaccepted'; readonly reason: UnacceptedReason })
  | (OutcomeBase & { readonly status: 'blocked'; readonly reason: BlockedReason });

export interface InferenceGateway {
  generate(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationOutcome>;
  evaluate<K extends EvaluationKind>(
    request: EvaluationRequest<K>,
    signal?: AbortSignal,
  ): Promise<EvaluationOutcome<K>>;
}

// ---------------------------------------------------------------------------

/**
 * Structural validation the gateway applies before the caller's acceptance:
 * every question answered, nothing extra, and every answer in the shape the
 * request declared. A provider that drops a question or answers it in another
 * shape produced a malformed response, not a judgment.
 */
export function answersMatchQuestions(
  kind: EvaluationKind,
  questions: EvaluationQuestions,
  answers: EvaluationAnswers,
): Acceptance {
  for (const id of Object.keys(questions)) {
    const answer = answers[id];
    if (answer === undefined) return { status: 'rejected', reason: `unanswered_question:${id}` };
    if (answer.type !== kind) return { status: 'rejected', reason: `wrong_answer_type:${id}` };
  }
  const extra = Object.keys(answers).find((id) => questions[id] === undefined);
  return extra === undefined ? { status: 'accepted' } : { status: 'rejected', reason: `unasked_question:${extra}` };
}
