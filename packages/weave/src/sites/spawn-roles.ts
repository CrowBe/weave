/** Closed-set role observations for shadow preflight; no threshold or authority. */
import type { EvaluationOutcome, InferenceGateway, InferenceTerms } from '@weave/gateway';
import { admissionReason, correlation, unit, type SiteState } from './index.js';

export const SPAWN_ROLES_SITE = 'spawn.roles' as const;
export const SPAWN_ROLES_QUESTION = 'For this request, what must happen to the named target before or during the work?';
// Kept local: this site imports only gateway types and the shared admission helpers.
type TargetRole = 'edit' | 'read' | 'forbid' | 'skip';
export const SPAWN_ROLE_CRITERIA: Readonly<Record<TargetRole, string>> = Object.freeze({
  edit: 'The request requires changing this target.',
  read: 'This target must be read before anything is generated, and must not change.',
  forbid: 'This target must not change, and does not need to be read.',
  skip: 'This target is not relevant to the request.',
});
export type RoleReason =
  | 'answered'
  | 'no_answer'
  | 'invalid_answer'
  | 'stale_answer'
  | 'mismatched_answer'
  | 'decision_unavailable'
  | 'cancelled';
export interface RoleAsk extends SiteState {
  readonly request_id: string;
  readonly state: {
    readonly request: string;
    readonly context: string;
    readonly targets: readonly { readonly ref: string; readonly summary: string }[];
  };
  readonly terms: InferenceTerms;
}
export interface RoleObservation {
  readonly schema: 'spawn-roles@1';
  readonly site: 'spawn.roles';
  readonly question: string;
  readonly request_id: string | null;
  readonly state_revision: number;
  readonly targets: readonly {
    readonly ref: string;
    readonly role: TargetRole | null;
    readonly top_p: number | null;
    readonly confidence: number | null;
  }[];
  readonly reason: RoleReason;
  readonly provider_request_id: string | null;
}
export interface RecordedRoleAnswer {
  readonly state_revision: number;
  readonly observed_at: number;
  readonly outcome: EvaluationOutcome<'choice'> | null;
  readonly cancelled?: boolean;
}
function role(value: unknown): value is TargetRole {
  return typeof value === 'string' && Object.hasOwn(SPAWN_ROLE_CRITERIA, value);
}
function topProbability(probabilities: unknown, choice: TargetRole): number | null {
  if (typeof probabilities !== 'object' || probabilities === null || Array.isArray(probabilities)) return null;
  const entries = Object.entries(probabilities);
  const selected = (probabilities as Record<string, unknown>)[choice];
  return unit(selected) &&
    entries.every(([key, value]) => role(key) && unit(value) && value <= selected) &&
    Math.abs(entries.reduce((sum, [, value]) => sum + (value as number), 0) - 1) <= 1e-6
    ? selected
    : null;
}
export function transitionRoles(ask: RoleAsk, recorded: RecordedRoleAnswer, current: SiteState): RoleObservation {
  const input = { ...ask, request_id: `${ask.request_id}:roles`, needs_dispatch: true };
  const metadata = admissionReason(SPAWN_ROLES_SITE, input, recorded, current) as Exclude<
    RoleReason,
    'answered' | 'no_answer' | 'invalid_answer'
  > | null;
  const answered = recorded.outcome?.status === 'accepted' ? recorded.outcome : null;
  const raw = ask.state.targets.map((_, i) => answered?.answers?.[`target_${i}`]);
  const reason: RoleReason =
    metadata ??
    (!answered
      ? 'no_answer'
      : answered.kind !== 'choice' || raw.some((item) => item?.type !== 'choice' || !role(item.choice))
        ? 'invalid_answer'
        : 'answered');
  return {
    schema: 'spawn-roles@1',
    site: SPAWN_ROLES_SITE,
    question: SPAWN_ROLES_QUESTION,
    request_id: correlation(input.request_id),
    state_revision: ask.state_revision,
    targets: ask.state.targets.map((target, i) => {
      const item = raw[i];
      const choice = reason === 'answered' && role(item?.choice) ? item.choice : null;
      const confidence = answered?.confidence?.[`target_${i}`];
      return {
        ref: target.ref,
        role: choice,
        top_p: choice === null ? null : topProbability(item?.probabilities, choice),
        confidence: reason === 'answered' && unit(confidence) ? confidence : null,
      };
    }),
    reason,
    provider_request_id: correlation(answered?.provider_response_id),
  };
}
export async function askRoles(
  ask: RoleAsk,
  port: Pick<InferenceGateway, 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<RoleObservation> {
  const captured = structuredClone(ask);
  let outcome: EvaluationOutcome<'choice'> | null = null;
  if (!signal?.aborted) {
    try {
      outcome = await port.evaluate(
        {
          request_id: `${captured.request_id}:roles`,
          site: SPAWN_ROLES_SITE,
          role: 'working',
          kind: 'choice',
          state: structuredClone(captured.state),
          questions: Object.fromEntries(
            captured.state.targets.map((target, i) => [
              `target_${i}`,
              {
                type: 'choice' as const,
                instructions: { question: SPAWN_ROLES_QUESTION, target: target.ref },
                criteria: SPAWN_ROLE_CRITERIA,
              },
            ]),
          ),
          terms: { ...captured.terms, destinations: [...captured.terms.destinations], tier: 'decision' },
        },
        signal,
      );
    } catch {
      // Never put an injected exception (which may contain credentials) in evidence.
    }
  }
  const current = now();
  return transitionRoles(
    captured,
    {
      state_revision: captured.state_revision,
      observed_at: current.observed_at,
      outcome,
      cancelled: signal?.aborted ?? false,
    },
    current,
  );
}
