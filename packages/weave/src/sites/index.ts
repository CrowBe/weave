/** P5 judgments are observations; these transitions confer no dispatch authority. */
import type {
  EvaluationContent,
  EvaluationOutcome,
  GenerationOutcome,
  InferenceGateway,
  InferenceTerms,
} from '@weave/gateway';
import type { ProcessState } from '../operating-process.js';
import type { ExtractObservation } from './extract.js';

export const SITE_POLICY = {
  'loop.triage': {
    question: 'What does this request or state need next?',
    options: ['capability', 'implement', 'needs_human', 'out_of_scope', 'done_check'],
    confidence: 0.8,
    fallback: 'implement',
  },
  'loop.route': {
    question: 'Which tier fits this unit of work?',
    options: ['flash', 'standard', 'strong'],
    confidence: 0.75,
    fallback: 'standard',
  },
  'loop.continue': {
    question: 'Is progress continuing?',
    options: ['progressing', 'stalled', 'regressing'],
    confidence: 0.7,
    fallback: 'stalled',
  },
  'intake.classify': {
    question: 'How should this inbound message relate to the running threads?',
    options: ['new_thread', 'continue_thread', 'queue', 'steer', 'interrupt', 'stop'],
    confidence: 0.8,
    fallback: 'ask_user',
  },
  'input.route': {
    question: 'How does this operator input relate to the active work?',
    options: ['conversation', 'steer', 'interrupt', 'parallel', 'queue'],
    confidence: 0.8,
    fallback: 'ask_user',
  },
} as const;
for (const policy of Object.values(SITE_POLICY)) {
  Object.freeze(policy.options);
  Object.freeze(policy);
}
Object.freeze(SITE_POLICY);
export type DecisionSite = keyof typeof SITE_POLICY;
export type SiteChoice = (typeof SITE_POLICY)[DecisionSite]['options'][number] | 'ask_user';
export interface SiteState {
  readonly state_revision: number;
  readonly state_updated_at: number;
}
/** Free-text sites must declare the extract@1 record that grounds their state. */
export const MODEL_SITES = ['intake.classify', 'input.route', 'loop.triage', 'loop.route'] as const;
export type ModelSite = (typeof MODEL_SITES)[number];
/** Sites answered from recorded structured evidence, not from free text. */
export const STRUCTURAL_SOURCE_FOR = {
  'loop.continue': 'progress.delta@1',
  'audit.dispose': 'audit.findings',
  'eval.output': 'criteria',
} as const;
export type StructuralSource = (typeof STRUCTURAL_SOURCE_FOR)[keyof typeof STRUCTURAL_SOURCE_FOR];
export interface ModelSiteOrigin {
  readonly kind: 'model';
  readonly extract: ExtractObservation;
}
export interface StructuralSiteOrigin {
  readonly kind: 'structural';
  readonly source: StructuralSource;
}
export type SiteOrigin = ModelSiteOrigin | StructuralSiteOrigin;
export function modelOrigin(extract: ExtractObservation): ModelSiteOrigin {
  return { kind: 'model', extract };
}
export function structuralOrigin(source: StructuralSource): StructuralSiteOrigin {
  return { kind: 'structural', source };
}
export interface SiteInput extends SiteState {
  readonly request_id: string;
  /** Already filtered for disclosure; never copied to the observation. */
  readonly state: EvaluationContent;
  readonly terms: InferenceTerms;
  /** True for a step that needs dispatch: an outage must pause it. */
  readonly needs_dispatch: boolean;
  /** Required before a site can be asked; absent only while preprocessing a free-text site. */
  readonly origin?: SiteOrigin;
}
/** Hints are grounded substrings and closed-vocabulary ids only; the original stays authoritative. */
export type IntakeHints = {
  readonly schema: 'intake.message@1';
  readonly thread_ref: { readonly value: string; readonly cue: string | null } | null;
  readonly request: string | null;
};
/** Intake discloses one inbound message and running-thread summaries; nothing channel-specific. */
export type IntakeState = {
  readonly message: string;
  readonly running_threads: readonly {
    readonly thread_id: string;
    readonly summary: string;
  }[];
  readonly hints?: IntakeHints;
};
export interface IntakeSiteInput extends SiteInput {
  readonly state: IntakeState;
}
/** What `input.route` may propose; WORKSTREAM-CONTRACT.md fixes what each one does. */
export type RouteOutcome = (typeof SITE_POLICY)['input.route']['options'][number];
/** Input routing (#27) discloses one operator input and its workstream's active work; nothing else. */
export type RouteState = {
  readonly input: string;
  readonly active_work: {
    readonly summary: string;
    readonly process: ProcessState | null;
  };
};
export interface RouteSiteInput extends SiteInput {
  readonly state: RouteState;
}
/** Intake takes IntakeState (#90), input routing RouteState; every other choice site any disclosed content. */
export type SiteInputFor<S extends DecisionSite> = S extends 'intake.classify'
  ? IntakeSiteInput
  : S extends 'input.route'
    ? RouteSiteInput
    : SiteInput;
export interface RecordedSiteAnswer {
  readonly state_revision: number;
  /** Injected reading at response receipt, never a provider's clock. */
  readonly observed_at: number;
  /** null records a thrown/unavailable evaluate port, without error text. */
  readonly outcome: EvaluationOutcome<'choice'> | null;
  readonly cancelled?: boolean;
}
export type SiteReason =
  | 'accepted'
  | 'stale_answer'
  | 'mismatched_answer'
  | 'invalid_answer'
  | 'missing_confidence'
  | 'low_confidence'
  | 'low_top_p'
  | 'no_answer'
  | 'decision_unavailable'
  | 'cancelled'
  | 'extract_missing'
  | 'invalid_extract'
  | 'structural_origin_missing';
export interface SiteObservation {
  readonly schema: 'decision-site@1';
  readonly site: DecisionSite;
  readonly question: string;
  readonly request_id: string | null;
  readonly state_revision: number;
  readonly answer: SiteChoice | null;
  readonly confidence: number | null;
  readonly top_p: number | null;
  readonly accepted: boolean;
  readonly fallback_used: boolean;
  readonly reason: SiteReason;
  /** The gateway exposes the provider's correlation id as provider_response_id. */
  readonly provider_request_id: string | null;
}
export interface SiteTransition {
  readonly choice: SiteChoice;
  readonly tier: 'strong' | null;
  readonly status: 'transition' | 'paused' | 'needs_human';
  readonly observation: SiteObservation;
}

/** Bound opaque correlation ids; don't forward arbitrary provider text. */
export function correlation(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
    !/^(sk[-_]|Bearer\s+|eyJ|gh[pousr]_|github_pat_|AKIA)/i.test(value)
    ? value
    : null;
}
export function unit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function validState(state: SiteState): boolean {
  return (
    Number.isSafeInteger(state.state_revision) && state.state_revision >= 0 && Number.isFinite(state.state_updated_at)
  );
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
const EXTRACT_VERDICTS = ['use_hints', 'original_only', 're_extract'] as const;
const FINAL_EXTRACT_VERDICTS: readonly (typeof EXTRACT_VERDICTS)[number][] = ['use_hints', 'original_only'];
const EXTRACT_REASONS = [
  'faithful',
  'unfaithful',
  'no_answer',
  'mismatched_answer',
  'decision_unavailable',
  'stale_answer',
  'cancelled',
] as const;
const SLOT_STATUSES = ['grounded', 'empty', 'unresolved', 'ungrounded', 'out_of_set', 'unread'] as const;
interface ExpectedExtract {
  readonly schema: string;
  readonly slots: readonly { readonly slot: string; readonly kind: 'span' | 'choice' }[];
}
const EXPECTED_EXTRACT: Readonly<Record<string, ExpectedExtract>> = {
  'intake.classify': {
    schema: 'intake.message@1',
    slots: [
      { slot: 'thread_ref', kind: 'choice' },
      { slot: 'request', kind: 'span' },
    ],
  },
  'input.route': { schema: 'input.route@1', slots: [{ slot: 'intent', kind: 'span' }] },
  'loop.triage': { schema: 'loop.triage@1', slots: [{ slot: 'intent', kind: 'span' }] },
  'loop.route': { schema: 'loop.route@1', slots: [{ slot: 'intent', kind: 'span' }] },
};
function validExtractRecord(site: string, input: SiteInput, value: unknown): value is ExtractObservation {
  if (!plainObject(value)) return false;
  if (value['schema'] !== 'extract@1' || value['site'] !== site) return false;
  const expected = EXPECTED_EXTRACT[site];
  if (expected === undefined || value['extract_schema'] !== expected.schema) return false;
  if (value['request_id'] !== null && correlation(value['request_id']) === null) return false;
  if (value['attempt'] !== 1 && value['attempt'] !== 2) return false;
  if (value['state_revision'] !== input.state_revision) return false;
  if (!EXTRACT_VERDICTS.includes(value['verdict'] as (typeof EXTRACT_VERDICTS)[number])) return false;
  if (!EXTRACT_REASONS.includes(value['reason'] as (typeof EXTRACT_REASONS)[number])) return false;
  if (value['provider_request_id'] !== null && correlation(value['provider_request_id']) === null) return false;
  const slots = value['slots'];
  if (!Array.isArray(slots) || slots.length !== expected.slots.length) return false;
  for (const [index, slot] of slots.entries()) {
    if (!plainObject(slot)) return false;
    const shape = expected.slots[index]!;
    if (slot['slot'] !== shape.slot || slot['kind'] !== shape.kind) return false;
    if (!SLOT_STATUSES.includes(slot['status'] as (typeof SLOT_STATUSES)[number])) return false;
    if (slot['value'] !== null && typeof slot['value'] !== 'string') return false;
    const span = slot['span'];
    if (
      span !== null &&
      (!Array.isArray(span) ||
        span.length !== 2 ||
        !Number.isSafeInteger(span[0]) ||
        !Number.isSafeInteger(span[1]) ||
        span[0] < 0 ||
        span[1] < span[0])
    )
      return false;
  }
  const residual = value['residual_ambiguity'];
  if (!plainObject(residual) || !Number.isSafeInteger(residual['count'])) return false;
  const residualSlots = residual['slots'];
  return Array.isArray(residualSlots) && residualSlots.every((slot) => typeof slot === 'string');
}
function extractOriginReason(site: string, input: SiteInput, value: unknown): SiteReason | null {
  if (!validExtractRecord(site, input, value)) return 'invalid_extract';
  if (value.reason === 'cancelled') return 'cancelled';
  if (value.reason === 'stale_answer') return 'stale_answer';
  return FINAL_EXTRACT_VERDICTS.includes(value.verdict) ? null : 'invalid_extract';
}
/** Why a site cannot be asked from this input, or null when its declared origin is adequate. */
export function originReason(site: string, input: SiteInput): SiteReason | null {
  const structural = (STRUCTURAL_SOURCE_FOR as Readonly<Record<string, StructuralSource | undefined>>)[site];
  if (structural !== undefined) {
    const origin = input.origin;
    return origin?.kind === 'structural' && origin.source === structural ? null : 'structural_origin_missing';
  }
  if (!(MODEL_SITES as readonly string[]).includes(site)) return null;
  if (input.origin === undefined) return 'extract_missing';
  if (input.origin.kind !== 'model') return 'invalid_extract';
  return extractOriginReason(site, input, input.origin.extract);
}
function originFailure(reason: SiteReason | null): boolean {
  return (
    reason === 'extract_missing' ||
    reason === 'invalid_extract' ||
    reason === 'structural_origin_missing' ||
    reason === 'stale_answer' ||
    reason === 'cancelled'
  );
}

/** Failure codes meaning no answer could be obtained, unlike a refusal or a malformed answer. */
const OUTAGE_FAILURES: readonly string[] = [
  'unavailable',
  'unauthorized',
  'quota_exhausted',
  'rate_limited',
  'timeout',
  'cancelled',
];
export function decisionUnavailable(outcome: EvaluationOutcome | GenerationOutcome | null): boolean {
  if (!outcome || outcome.paused !== undefined) return true;
  if (outcome.status === 'accepted') return false;
  if (outcome.status === 'blocked')
    return [
      'provider_unavailable',
      'no_route',
      'no_budget',
      'quota_unknown',
      'weekly_budget_cap',
      'deadline_passed',
    ].includes(outcome.reason);
  if (outcome.reason === 'budget_exhausted' || outcome.reason === 'deadline_reached') return true;
  // The gateway reports the same failed attempts as provider_failed or attempts_exhausted depending on
  // max_attempts, so classify on their failure codes (#91). provider_failed with no failed attempt is an
  // abort before any attempt: there is no refusal to classify, so it stays an outage.
  const codes = outcome.attempts.flatMap((attempt) =>
    attempt.disposition.status === 'failed' ? [attempt.disposition.failure.code] : [],
  );
  if (outcome.reason === 'provider_failed' && codes.length === 0) return true;
  return codes.some((code) => OUTAGE_FAILURES.includes(code));
}

/** Deterministic admission and record construction, usable without a gateway for replay. */
export function transitionSite<S extends DecisionSite>(
  site: S,
  input: SiteInputFor<S>,
  recorded: RecordedSiteAnswer,
  current: SiteState,
): SiteTransition {
  const policy = SITE_POLICY[site];
  const outcome = recorded.outcome;
  const answered = outcome?.status === 'accepted' ? outcome : null;
  const raw = answered?.answers['decision'];
  const answer =
    raw?.type === 'choice' && (policy.options as readonly string[]).includes(raw.choice)
      ? (raw.choice as SiteChoice)
      : null;
  const statistic = answered?.confidence?.['decision'];
  const confidence = unit(statistic) ? statistic : null;
  const probabilities = raw?.type === 'choice' ? raw.probabilities : undefined;
  const selected = answer === null ? undefined : probabilities?.[answer];
  const top_p = unit(selected) ? selected : null;
  let reason: SiteReason;
  const metadata = admissionReason(site, input, recorded, current);
  if (metadata) reason = metadata;
  else if (!answered) reason = 'no_answer';
  else if (answered.kind !== 'choice' || answer === null) reason = 'invalid_answer';
  else if (confidence === null) reason = 'missing_confidence';
  else if (confidence < policy.confidence) reason = 'low_confidence';
  else if (site === 'loop.triage' && !validTopProbability(probabilities, top_p, policy.options)) reason = 'low_top_p';
  else reason = 'accepted';
  const accepted = reason === 'accepted';
  const origin = originReason(site, input);
  const originFailed = originFailure(origin);
  const choice = accepted ? answer! : policy.fallback;
  // An unavailable decision takes no executive authority even when its fallback says implement.
  const unavailable = decisionUnavailable(outcome);
  const status =
    recorded.cancelled || origin === 'cancelled'
      ? 'paused'
      : originFailed
        ? 'needs_human'
        : input.needs_dispatch && unavailable
          ? 'paused'
          : choice === 'ask_user' || choice === 'needs_human'
            ? 'needs_human'
            : 'transition';
  return {
    choice,
    tier: site === 'loop.triage' && !accepted ? 'strong' : null,
    status,
    observation: {
      schema: 'decision-site@1',
      site,
      question: policy.question,
      request_id: correlation(input.request_id),
      state_revision: input.state_revision,
      answer: originFailed ? null : answer,
      confidence: originFailed ? null : confidence,
      top_p: originFailed ? null : top_p,
      accepted,
      fallback_used: !accepted,
      reason,
      provider_request_id: originFailed ? null : correlation(answered?.provider_response_id),
    },
  };
}
function validTopProbability(
  probabilities: Readonly<Record<string, number>> | undefined,
  selected: number | null,
  options: readonly string[],
): boolean {
  if (!probabilities || selected === null || selected < 0.6) return false;
  const entries = Object.entries(probabilities);
  return (
    entries.length > 0 &&
    entries.every(([key, value]) => options.includes(key) && unit(value) && value <= selected) &&
    Math.abs(entries.reduce((total, [, value]) => total + value, 0) - 1) <= 0.000001
  );
}

/** The only effect is the injected evaluate port; current is read after the await. */
export async function evaluateSite<S extends DecisionSite>(
  site: S,
  input: SiteInputFor<S>,
  port: Pick<InferenceGateway, 'evaluate'>,
  current: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<SiteTransition> {
  // Capture request metadata before await: caller mutation cannot rebind an in-flight answer or origin.
  const captured = {
    ...input,
    ...(input.origin === undefined ? {} : { origin: structuredClone(input.origin) }),
  };
  let outcome: EvaluationOutcome<'choice'> | null = null;
  if (!signal?.aborted && originReason(site, captured) === null) {
    try {
      const policy = SITE_POLICY[site];
      outcome = await port.evaluate(
        {
          request_id: captured.request_id,
          site,
          role: 'working',
          kind: 'choice',
          state: captured.state,
          questions: {
            decision: {
              type: 'choice',
              instructions: policy.question,
              criteria: Object.fromEntries(policy.options.map((option) => [option, null])),
            },
          },
          terms: { ...captured.terms, tier: 'decision' },
        },
        signal,
      );
    } catch {
      // Never put an injected exception (which may contain credentials) in evidence.
    }
  }
  const now = current();
  return transitionSite(
    site,
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

export type ProgressChoice = 'progressing' | 'stalled' | 'regressing';
export function stopForNoProgress(
  history: readonly ProgressChoice[],
  issues: readonly {
    readonly issue_id: string;
    readonly fix_attempts: number;
    readonly reappeared: boolean;
  }[],
): 'no_progress' | 'repeated_issue' | null {
  if (history.length >= 2 && history.slice(-2).every((choice) => choice === 'stalled' || choice === 'regressing'))
    return 'no_progress';
  if (
    issues.some(
      (issue) =>
        issue.reappeared &&
        issue.issue_id.length > 0 &&
        Number.isSafeInteger(issue.fix_attempts) &&
        issue.fix_attempts >= 2,
    )
  )
    return 'repeated_issue';
  return null;
}

/** Shared freshness, identity and outage gate for all site answer shapes. */
export function admissionReason(
  site: string,
  input: SiteInput,
  recorded: {
    readonly outcome: EvaluationOutcome | null;
    readonly state_revision: number;
    readonly observed_at: number;
    readonly cancelled?: boolean;
  },
  current: SiteState,
): SiteReason | null {
  const outcome = recorded.outcome;
  if (recorded.cancelled) return 'cancelled';
  const origin = originReason(site, input);
  if (origin !== null) return origin;
  if (
    !validState(input) ||
    !validState(current) ||
    !Number.isFinite(recorded.observed_at) ||
    recorded.state_revision !== input.state_revision ||
    input.state_revision !== current.state_revision ||
    input.state_updated_at !== current.state_updated_at ||
    recorded.observed_at < current.state_updated_at
  )
    return 'stale_answer';
  if (outcome && (outcome.request_id !== input.request_id || outcome.site !== site)) return 'mismatched_answer';
  if (decisionUnavailable(outcome)) return 'decision_unavailable';
  return null;
}
