import { digest } from './digest.js';
import { stableStringify } from './stable-json.js';

export const AUDIT_SLICES = ['goal', 'iteration', 'plan', 'decisions', 'artifacts', 'checks', 'evals', 'open_issues', 'budget'] as const;
export type AuditSliceName = (typeof AUDIT_SLICES)[number];
export interface AuditCriterion {
  readonly criterion_id: string;
  readonly statement: string;
  readonly check_ids: readonly string[];
}
export interface AuditGoal {
  readonly goal_id: string;
  readonly statement: string;
  readonly success_criteria: readonly AuditCriterion[];
  /** Authorized artifact references; no wildcard expansion occurs here. */
  readonly authority_scope: readonly string[];
  readonly revision: number;
}
export interface AuditArtifact {
  readonly artifact_id: string;
  readonly kind: 'diff' | 'file' | 'report';
  readonly digest: string;
  readonly summary: string;
  readonly bytes: number;
  readonly ref: string;
  readonly body?: string;
}
export interface AuditCheck {
  readonly check_id: string;
  readonly argv_digest: string;
  readonly exit: number | null;
  readonly passed: boolean;
  readonly tail: string;
}
export interface AuditEval {
  readonly criterion_id: string;
  readonly verdict_probability: number | null;
  readonly confidence: number | null;
  readonly passed: boolean;
}
export interface AuditIssue {
  readonly issue_id: string;
  readonly source: 'check' | 'eval' | 'audit';
  readonly text: string;
  readonly severity: string;
}
export interface AuditBudget {
  readonly spent_micros: number;
  readonly ceiling_micros: number;
  readonly quota: readonly { readonly provider: string; readonly window: string; readonly percent_remaining: number; readonly resets_at: number | null }[];
}
export interface AuditState {
  readonly schema: 'audit-state@1';
  readonly view: 'view.audit@1';
  readonly goal: AuditGoal;
  readonly iteration: number;
  readonly plan: readonly { readonly step_id: string; readonly intent: string; readonly tier: string; readonly status: 'done' | 'failed' | 'skipped' }[];
  readonly decisions: readonly { readonly site: string; readonly question_id: string; readonly choice: string | null; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number | null; readonly fallback_used: boolean; readonly obs_seq: number }[];
  readonly artifacts: readonly AuditArtifact[];
  readonly checks: readonly AuditCheck[];
  readonly evals: readonly AuditEval[];
  readonly open_issues: readonly AuditIssue[];
  readonly budget: AuditBudget | null;
  readonly omissions: readonly string[];
  readonly source_revisions: Readonly<Record<string, number>>;
  readonly digest: string;
}
export type AuditStateInput = Pick<AuditState, 'goal' | 'iteration' | 'source_revisions'> & Partial<Pick<AuditState, 'plan' | 'decisions' | 'artifacts' | 'checks' | 'evals' | 'open_issues' | 'budget' | 'omissions'>> & {
  readonly authorized_slices: readonly AuditSliceName[];
  readonly max_body_bytes?: number;
};

function boundedUtf8(value: string, cap: number): string {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > cap) break;
    result += character;
    bytes += width;
  }
  return result;
}

/** Policy supplies already disclosed, secret-free slices. No inference or IO. */
export function assembleAuditState(input: AuditStateInput): AuditState {
  const allowed = new Set(input.authorized_slices);
  if (!allowed.has('goal') || !allowed.has('iteration')) throw new Error('Audit requires authorized goal and iteration slices.');
  if (!Number.isSafeInteger(input.iteration) || input.iteration < 0) throw new Error('Invalid audit iteration.');
  const cap = input.max_body_bytes ?? 4096;
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error('Invalid audit body cap.');
  const omissions = [...(input.omissions ?? [])];
  for (const slice of AUDIT_SLICES) if (!allowed.has(slice)) omissions.push(`${slice}:authority`);
  const refs = new Set(input.goal.authority_scope);
  const artifacts: AuditArtifact[] = [];
  if (allowed.has('artifacts')) for (const artifact of input.artifacts ?? []) {
    if (!refs.has(artifact.ref)) {
      omissions.push(`artifact:${artifact.artifact_id}:authority`);
      continue;
    }
    const { body, summary, ...metadata } = artifact;
    const boundedSummary = boundedUtf8(summary, 240);
    if (boundedSummary !== summary) omissions.push(`artifact:${artifact.artifact_id}:summary_cap`);
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > cap) {
      omissions.push(`artifact:${artifact.artifact_id}:size_cap`);
      artifacts.push({ ...metadata, summary: boundedSummary });
    } else artifacts.push({ ...metadata, summary: boundedSummary, ...(body === undefined ? {} : { body }) });
  }
  const source_revisions = Object.fromEntries(Object.entries(input.source_revisions).filter(([key]) => allowed.has(key as AuditSliceName) || artifacts.some(artifact => artifact.ref === key)));
  const content = {
    schema: 'audit-state@1' as const, view: 'view.audit@1' as const,
    goal: input.goal, iteration: input.iteration,
    plan: allowed.has('plan') ? input.plan ?? [] : [],
    decisions: allowed.has('decisions') ? input.decisions ?? [] : [],
    artifacts,
    checks: allowed.has('checks') ? (input.checks ?? []).map(check => {
      if (check.tail.length > 240) omissions.push(`check:${check.check_id}:tail_cap`);
      return { ...check, tail: check.tail.slice(-240) };
    }) : [],
    evals: allowed.has('evals') ? input.evals ?? [] : [],
    open_issues: allowed.has('open_issues') ? input.open_issues ?? [] : [],
    budget: allowed.has('budget') ? input.budget ?? null : null,
    omissions: [...new Set(omissions)].sort(), source_revisions,
  };
  // Canonicalize and detach all nested input references before publishing.
  return JSON.parse(stableStringify({ ...content, digest: digest(content) })) as AuditState;
}
