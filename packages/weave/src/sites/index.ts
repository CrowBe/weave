/** P5 judgments are observations; these transitions confer no dispatch authority. */
import type { EvaluationContent, EvaluationOutcome, InferenceGateway, InferenceTerms } from '@weave/gateway';

export const SITE_POLICY = {
  'loop.triage': { question: 'What does this request or state need next?', options: ['capability', 'implement', 'needs_human', 'out_of_scope', 'done_check'], confidence: .80, fallback: 'implement' },
  'loop.route': { question: 'Which tier fits this unit of work?', options: ['flash', 'standard', 'strong'], confidence: .75, fallback: 'standard' },
  'loop.continue': { question: 'Is progress continuing?', options: ['progressing', 'stalled', 'regressing'], confidence: .70, fallback: 'stalled' },
  'intake.classify': { question: 'How should this inbound message relate to the running threads?', options: ['new_thread', 'continue_thread', 'queue', 'steer', 'interrupt', 'stop'], confidence: .80, fallback: 'ask_user' },
} as const;
for (const policy of Object.values(SITE_POLICY)) {
  Object.freeze(policy.options);
  Object.freeze(policy);
}
Object.freeze(SITE_POLICY);
export type DecisionSite = keyof typeof SITE_POLICY;
export type SiteChoice = typeof SITE_POLICY[DecisionSite]['options'][number] | 'ask_user';
export interface SiteState {
  readonly state_revision: number;
  readonly state_updated_at: number;
}
export interface SiteInput extends SiteState {
  readonly request_id: string;
  /** Already filtered for disclosure; never copied to the observation. */
  readonly state: EvaluationContent;
  readonly terms: InferenceTerms;
  /** True for a step that needs dispatch: an outage must pause it. */
  readonly needs_dispatch: boolean;
}
export interface IntakeState {
  readonly message: string;
  readonly running_threads: readonly {
    readonly thread_id: string;
    readonly summary: string;
  }[];
}
export interface RecordedSiteAnswer {
  readonly state_revision: number;
  /** Injected reading at response receipt, never a provider's clock. */
  readonly observed_at: number;
  /** null records a thrown/unavailable evaluate port, without error text. */
  readonly outcome: EvaluationOutcome<'choice'> | null;
  readonly cancelled?: boolean;
}
export type SiteReason = 'accepted' | 'stale_answer' | 'mismatched_answer' | 'invalid_answer' |
  'missing_confidence' | 'low_confidence' | 'low_top_p' | 'no_answer' | 'decision_unavailable' | 'cancelled';
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
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
    !/^(sk[-_]|Bearer|eyJ|gh[pousr]_|github_pat_|AKIA)/i.test(value) ? value : null;
}
export function unit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function validState(state: SiteState): boolean {
  return Number.isSafeInteger(state.state_revision) && state.state_revision >= 0 && Number.isFinite(state.state_updated_at);
}

/** Failure codes meaning no answer could be obtained, unlike a refusal or a malformed answer. */
const OUTAGE_FAILURES: readonly string[] = ['unavailable', 'unauthorized', 'quota_exhausted', 'rate_limited', 'timeout', 'cancelled'];
export function decisionUnavailable(outcome: EvaluationOutcome | null): boolean {
  if (!outcome || outcome.paused !== undefined) return true;
  if (outcome.status === 'accepted') return false;
  if (outcome.status === 'blocked') return ['provider_unavailable', 'no_route', 'no_budget', 'quota_unknown',
    'weekly_budget_cap', 'deadline_passed'].includes(outcome.reason);
  if (outcome.reason === 'budget_exhausted' || outcome.reason === 'deadline_reached') return true;
  // The gateway reports the same failed attempts as provider_failed or attempts_exhausted depending on
  // max_attempts, so classify on their failure codes (#91). provider_failed with no failed attempt is an
  // abort before any attempt: there is no refusal to classify, so it stays an outage.
  const codes = outcome.attempts.flatMap(attempt => attempt.disposition.status === 'failed' ? [attempt.disposition.failure.code] : []);
  if (outcome.reason === 'provider_failed' && codes.length === 0) return true;
  return codes.some(code => OUTAGE_FAILURES.includes(code));
}

/** Deterministic admission and record construction, usable without a gateway for replay. */
export function transitionSite(site: DecisionSite, input: SiteInput, recorded: RecordedSiteAnswer,
  current: SiteState): SiteTransition {
  const policy = SITE_POLICY[site];
  const outcome = recorded.outcome;
  const answered = outcome?.status === 'accepted' ? outcome : null;
  const raw = answered?.answers['decision'];
  const answer = raw?.type === 'choice' && (policy.options as readonly string[]).includes(raw.choice) ? raw.choice as SiteChoice : null;
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
  const choice = accepted ? answer! : policy.fallback;
  // An unavailable decision takes no executive authority even when its fallback says implement.
  const unavailable = decisionUnavailable(outcome);
  const status = recorded.cancelled || (input.needs_dispatch && unavailable) ? 'paused' :
    choice === 'ask_user' || choice === 'needs_human' ? 'needs_human' : 'transition';
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
      answer,
      confidence,
      top_p,
      accepted,
      fallback_used: !accepted,
      reason,
      provider_request_id: correlation(answered?.provider_response_id),
    },
  };
}
function validTopProbability(probabilities: Readonly<Record<string, number>> | undefined, selected: number | null,
  options: readonly string[]): boolean {
  if (!probabilities || selected === null || selected < .6) return false;
  const entries = Object.entries(probabilities);
  return entries.length > 0 && entries.every(([key, value]) => options.includes(key) && unit(value) && value <= selected) &&
    Math.abs(entries.reduce((total, [, value]) => total + value, 0) - 1) <= .000001;
}

/** The only effect is the injected evaluate port; current is read after the await. */
export async function evaluateSite(site: DecisionSite, input: SiteInput, port: Pick<InferenceGateway, 'evaluate'>,
  current: () => SiteState & { readonly observed_at: number }, signal?: AbortSignal): Promise<SiteTransition> {
  // Capture request metadata before await: caller mutation cannot rebind an in-flight answer.
  const captured = { ...input };
  let outcome: EvaluationOutcome<'choice'> | null = null;
  if (!signal?.aborted) {
    try {
      const policy = SITE_POLICY[site];
      outcome = await port.evaluate({
        request_id: captured.request_id,
        site,
        role: 'working',
        kind: 'choice',
        state: captured.state,
        questions: { decision: { type: 'choice', instructions: policy.question,
          criteria: Object.fromEntries(policy.options.map(option => [option, null])) } },
        terms: { ...captured.terms, tier: 'decision' },
      }, signal);
    } catch {
      // Never put an injected exception (which may contain credentials) in evidence.
    }
  }
  const now = current();
  return transitionSite(site, captured, { outcome, state_revision: captured.state_revision,
    observed_at: now.observed_at, cancelled: signal?.aborted ?? false }, now);
}

export type ProgressChoice = 'progressing' | 'stalled' | 'regressing';
export function stopForNoProgress(history: readonly ProgressChoice[], issues: readonly {
  readonly issue_id: string; readonly fix_attempts: number; readonly reappeared: boolean;
}[]): 'no_progress' | 'repeated_issue' | null {
  if (history.length >= 2 && history.slice(-2).every(choice => choice === 'stalled' || choice === 'regressing')) return 'no_progress';
  if (issues.some(issue => issue.reappeared && issue.issue_id.length > 0 && Number.isSafeInteger(issue.fix_attempts) && issue.fix_attempts >= 2)) return 'repeated_issue';
  return null;
}

/** Shared freshness, identity and outage gate for all site answer shapes. */
export function admissionReason(site: string, input: SiteInput,
  recorded: { readonly outcome: EvaluationOutcome | null; readonly state_revision: number;
    readonly observed_at: number; readonly cancelled?: boolean }, current: SiteState): SiteReason | null {
  const outcome = recorded.outcome;
  if (recorded.cancelled) return 'cancelled';
  if (!validState(input) || !validState(current) || !Number.isFinite(recorded.observed_at) ||
    recorded.state_revision !== input.state_revision || input.state_revision !== current.state_revision ||
    input.state_updated_at !== current.state_updated_at || recorded.observed_at < current.state_updated_at) return 'stale_answer';
  if (outcome && (outcome.request_id !== input.request_id || outcome.site !== site)) return 'mismatched_answer';
  if (decisionUnavailable(outcome)) return 'decision_unavailable';
  return null;
}
