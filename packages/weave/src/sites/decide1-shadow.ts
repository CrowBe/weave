/** Isolated observations for Gauge; no judgment here has dispatch authority. */
import type { EvaluationOutcome, InferenceGateway, InferenceTerms } from '@weave/gateway';
import { admissionReason, correlation, unit, type SiteState } from './index.js';

export const DECIDE1_SHADOW_JUDGMENTS = Object.freeze([
  'clarify',
  'multi_deliverable',
  'reads_before_gen',
  'veto_bare_gen',
] as const);
export type ShadowJudgment = (typeof DECIDE1_SHADOW_JUDGMENTS)[number];
/** The question text is part of decide1-shadow@1; changing it requires a new schema. */
export const DECIDE1_SHADOW_QUESTIONS: Readonly<Record<ShadowJudgment, string>> = Object.freeze({
  clarify: 'Does this request need clarification that only the requester can give before work starts?',
  multi_deliverable: 'Does this request ask for more than one separate deliverable?',
  reads_before_gen: 'Must existing files or artifacts be read before anything can be generated for this request?',
  veto_bare_gen: 'Would one generation call, without prior reads or decomposition, likely fail this request?',
});
export type ShadowReason =
  | 'answered'
  | 'no_answer'
  | 'invalid_answer'
  | 'stale_answer'
  | 'mismatched_answer'
  | 'decision_unavailable'
  | 'cancelled';
export interface ShadowAsk extends SiteState {
  readonly request_id: string;
  readonly state: { readonly request: string; readonly context: string };
  readonly terms: InferenceTerms;
}
export interface ShadowObservation {
  readonly schema: 'decide1-shadow@1';
  readonly site: `decide1.${ShadowJudgment}`;
  readonly question: string;
  readonly request_id: string | null;
  readonly state_revision: number;
  readonly probability: number | null;
  readonly confidence: number | null;
  readonly reason: ShadowReason;
  readonly provider_request_id: string | null;
}
export interface RecordedShadowAnswer {
  readonly state_revision: number;
  readonly observed_at: number;
  readonly outcome: EvaluationOutcome<'boolean'> | null;
  readonly cancelled?: boolean;
}

/** Pure admission records probability, never acceptance, a fallback, or authority. */
export function transitionShadow(
  judgment: ShadowJudgment,
  ask: ShadowAsk,
  recorded: RecordedShadowAnswer,
  current: SiteState,
): ShadowObservation {
  const site = `decide1.${judgment}` as const;
  const input = { ...ask, request_id: `${ask.request_id}:shadow.${judgment}`, needs_dispatch: true };
  // Shadow sites have no origin requirement, so only the shared metadata gate's four reasons apply.
  const metadata = admissionReason(site, input, recorded, current) as
    | 'cancelled'
    | 'stale_answer'
    | 'mismatched_answer'
    | 'decision_unavailable'
    | null;
  const answered = recorded.outcome?.status === 'accepted' ? recorded.outcome : null;
  const raw = answered?.answers?.['decision'];
  const probability = raw?.type === 'boolean' && unit(raw.probability) ? raw.probability : null;
  const reason: ShadowReason =
    metadata ??
    (!answered ? 'no_answer' : answered.kind !== 'boolean' || probability === null ? 'invalid_answer' : 'answered');
  const confidence = answered?.confidence?.['decision'];
  return {
    schema: 'decide1-shadow@1',
    site,
    question: DECIDE1_SHADOW_QUESTIONS[judgment],
    request_id: correlation(input.request_id),
    state_revision: ask.state_revision,
    probability: reason === 'answered' ? probability : null,
    confidence: reason === 'answered' && unit(confidence) ? confidence : null,
    reason,
    provider_request_id: correlation(answered?.provider_response_id),
  };
}

/** Four independent decision-tier calls start together and retain the fixed judgment order. */
export async function askShadow(
  ask: ShadowAsk,
  port: Pick<InferenceGateway, 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<readonly ShadowObservation[]> {
  // Capture all disclosed state and terms before any await or injected port call.
  const captured = structuredClone(ask);
  return Promise.all(
    DECIDE1_SHADOW_JUDGMENTS.map(async (judgment) => {
      let outcome: EvaluationOutcome<'boolean'> | null = null;
      if (!signal?.aborted) {
        try {
          outcome = await port.evaluate(
            {
              request_id: `${captured.request_id}:shadow.${judgment}`,
              site: `decide1.${judgment}`,
              role: 'working',
              kind: 'boolean',
              state: { ...captured.state },
              questions: { decision: { type: 'boolean', instructions: DECIDE1_SHADOW_QUESTIONS[judgment] } },
              terms: { ...captured.terms, destinations: [...captured.terms.destinations], tier: 'decision' },
            },
            signal,
          );
        } catch {
          // Never put an injected exception (which may contain credentials) in evidence.
        }
      }
      const current = now();
      return transitionShadow(
        judgment,
        captured,
        {
          state_revision: captured.state_revision,
          observed_at: current.observed_at,
          outcome,
          cancelled: signal?.aborted ?? false,
        },
        current,
      );
    }),
  );
}
