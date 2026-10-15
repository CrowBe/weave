/** D6 dispositions are observations, never execution authority. */
import type { EvaluationOutcome, InferenceGateway } from '@weave/gateway';
import { admissionReason, correlation, unit, type SiteInput, type SiteReason, type SiteState } from './index.js';
export const AUDIT_DISPOSITIONS = ['fix_now', 'defer', 'reject_as_out_of_scope', 'needs_human'] as const;
export type AuditDisposition = typeof AUDIT_DISPOSITIONS[number];
export interface AuditDisposeInput extends SiteInput { readonly findings: readonly unknown[] }
export interface AuditDisposeObservation {
  readonly schema: 'decision-site@1'; readonly site: 'audit.dispose'; readonly question: string;
  readonly request_id: string | null; readonly state_revision: number; readonly answer: AuditDisposition | null;
  readonly confidence: number | null; readonly top_p: number | null; readonly accepted: boolean;
  readonly fallback_used: boolean; readonly reason: SiteReason; readonly provider_request_id: string | null;
}
export interface AuditDisposal { readonly choices: readonly AuditDisposition[]; readonly observations: readonly AuditDisposeObservation[] }
export function transitionAuditDispose(input: AuditDisposeInput, recorded: {
  readonly outcome: EvaluationOutcome<'choice'> | null; readonly state_revision: number; readonly observed_at: number;
  readonly cancelled?: boolean;
}, current: SiteState): AuditDisposal {
  const outcome = recorded.outcome?.status === 'accepted' ? recorded.outcome : null;
  const observations = input.findings.map((_, index): AuditDisposeObservation => {
    const key = `finding_${index}`;
    const raw = outcome?.answers[key];
    const answer = raw?.type === 'choice' && AUDIT_DISPOSITIONS.includes(raw.choice as AuditDisposition) ? raw.choice as AuditDisposition : null;
    const conf = outcome?.confidence?.[key];
    const confidence = unit(conf) ? conf : null;
    const p = raw?.type === 'choice' && answer ? raw.probabilities?.[answer] : null;
    const probabilities = raw?.type === 'choice' ? raw.probabilities : undefined;
    const validDistribution = probabilities && Object.entries(probabilities).length > 0 &&
      Object.entries(probabilities).every(([key, value]) => AUDIT_DISPOSITIONS.includes(key as AuditDisposition) && unit(value) && unit(p) && value <= p) &&
      Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) <= .000001;
    const reason = admissionReason('audit.dispose', input, recorded, current) ??
      (!outcome ? 'no_answer' : outcome.kind !== 'choice' || answer === null || !validDistribution ? 'invalid_answer' :
        confidence === null ? 'missing_confidence' : confidence < .75 ? 'low_confidence' : 'accepted');
    return { schema: 'decision-site@1', site: 'audit.dispose', question: 'How should this audit finding be disposed?',
      request_id: correlation(input.request_id), state_revision: input.state_revision, answer: reason === 'accepted' ? answer : null,
      confidence: ['stale_answer', 'mismatched_answer', 'decision_unavailable', 'cancelled'].includes(reason) ? null : confidence,
      top_p: reason === 'accepted' && unit(p) ? p : null, accepted: reason === 'accepted', fallback_used: reason !== 'accepted',
      reason, provider_request_id: correlation(outcome?.provider_response_id) };
  });
  return { choices: observations.map(item => item.accepted ? item.answer! : 'needs_human'), observations };
}
export async function evaluateAuditDispose(input: AuditDisposeInput, port: Pick<InferenceGateway, 'evaluate'>,
  current: () => SiteState & { observed_at: number }, signal?: AbortSignal): Promise<AuditDisposal> {
  const captured = structuredClone(input);
  let outcome: EvaluationOutcome<'choice'> | null = null;
  if (!signal?.aborted && captured.findings.length) try {
    outcome = await port.evaluate({ request_id: captured.request_id, site: 'audit.dispose', role: 'working', kind: 'choice',
      state: captured.state, questions: Object.fromEntries(captured.findings.map((_, i) => [`finding_${i}`, {
        type: 'choice' as const, instructions: 'How should this audit finding be disposed?',
        criteria: Object.fromEntries(AUDIT_DISPOSITIONS.map(choice => [choice, null])),
      }])), terms: { ...captured.terms, tier: 'decision' } }, signal);
  } catch { /* Failure details may contain credentials. */ }
  const live = current();
  return transitionAuditDispose(captured, { outcome, state_revision: captured.state_revision,
    observed_at: live.observed_at, cancelled: signal?.aborted ?? false }, live);
}
