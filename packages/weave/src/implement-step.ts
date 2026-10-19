/**
 * One implementation-tier step: generate, configured repo checks, then D5 for
 * the criteria whose criterion proof is `judgment`. A red check already fails
 * the attempt, so D5 is not asked on that attempt (#200).
 *
 * The same execution id covers retries and the single escalation. Each finished
 * attempt is appended before the next one starts. Each check on each attempt
 * uses a fresh grant of equal scope from the composition-root issuer. A decision
 * answer cannot mint a grant, raise the tier past the ceiling, or complete the goal.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { effectSetsEqual, isWellFormedRef, type CapabilityHost, type Grant, type GrantAuthority } from '@weave/agentsop';
import type {
  GenerationKind,
  GenerationOutcome,
  InferenceGateway,
  InferenceTerms,
} from '@weave/gateway';
import { nonEmptyText } from '@weave/gateway';
import { admitCriterionProof, isCriterionProof, type CriterionProof, type ProofAdmission } from './criterion-proof.js';
import { digest } from './digest.js';
import { PersistError } from './journal.js';
import {
  OUTPUT_EVAL_SITE,
  evaluateOutputEval,
  type OutputCriterion,
  type OutputEvalInput,
  type OutputEvalObservation,
  type OutputEvalTransition,
} from './sites/output-eval.js';
import { correlation, type SiteState } from './sites/index.js';

export const IMPLEMENT_TIERS = ['flash', 'standard', 'strong'] as const;
export type ImplementTier = (typeof IMPLEMENT_TIERS)[number];
export const DEFAULT_IMPLEMENT_RETRIES = 2;
export const IMPLEMENT_STEP_SCHEMA = 'impl.step@1' as const;
export const IMPLEMENT_ATTEMPT_SCHEMA = 'impl.attempt@1' as const;
export const IMPLEMENT_STOP_SCHEMA = 'impl.stop@1' as const;
export const OPEN_ISSUE_SCHEMA = 'open_issue@1' as const;
const CHECKS = ['repo.test', 'repo.lint', 'repo.build'] as const;
export type ImplementCheckId = (typeof CHECKS)[number];
const GENERATION_KINDS: readonly GenerationKind[] = ['classify', 'extract', 'transform', 'draft-contract', 'judge'];
const PAUSE_REASONS = ['weekly_budget_cap', 'five_hour_budget_low', 'quota_unknown', 'budget_pace_ahead', 'no_budget', 'cancelled'] as const;
export type ImplementPauseReason = (typeof PAUSE_REASONS)[number];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEPT_REF = /^(?:ref_|gen_)[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CREDENTIAL = /sk[-_]|Bearer |eyJ|gh[pousr]_|github_pat_|AKIA/i;
const TAIL_CHARS = 240;
const MAX_RETRIES = 8;
const CHECK_TEXT = 'Deterministic checks failed.';
const EVAL_TEXT = 'Output evaluation failed for the listed criteria.';

export interface ImplementCheck {
  readonly operation: ImplementCheckId;
  /**
   * Held grant the composition root already issued. The step does not invoke
   * this object twice and does not widen it. Null means the check is denied.
   */
  readonly grant: Grant | null;
  readonly cwd_ref: string;
  readonly env_allow: readonly string[];
  readonly timeout_ms: number;
  /** Configured argv, digested for evidence. It is not passed to the host. */
  readonly argv?: readonly string[];
  /**
   * Resources the check's verdict comes from (held-out tests, fixtures). The
   * held grant must permit `read` on each. Required for a `check` criterion proof.
   */
  readonly oracle_refs?: readonly string[];
}
/** A success criterion with its proposed criterion proof (#199). Absent proof is `judgment`. */
export interface ImplementCriterion extends OutputCriterion {
  readonly proof?: CriterionProof;
  /** Configured check ids that settle a `check` criterion. */
  readonly check_ids?: readonly string[];
}
export interface ImplementStepInput {
  readonly execution_id: string;
  readonly request_id: string;
  /** Tier selected for this unit. Budget may downgrade it. */
  readonly tier: ImplementTier;
  /** D2 ceiling. Escalation cannot pass it, and nothing here can raise it. */
  readonly ceiling: ImplementTier;
  /** Same-tier retries after the first attempt. Default 2. */
  readonly retries?: number;
  readonly criteria: readonly ImplementCriterion[];
  readonly instructions: string;
  readonly prompt: string;
  readonly kind: GenerationKind;
  readonly terms: InferenceTerms;
  readonly checks: readonly ImplementCheck[];
  /**
   * Resources the generate backend may write, from that backend's grant.
   * Undefined is unknown, and no criterion can then be `check`-proven.
   */
  readonly generation_writes?: readonly string[];
}
export interface ImplementBudgetRequest {
  readonly requested: ImplementTier;
  readonly escalation: boolean;
  readonly attempt: number;
}
export type ImplementBudgetDecision =
  | { readonly status: 'allow'; readonly tier: ImplementTier }
  | { readonly status: 'pause'; readonly reason: string; readonly until: number | null };
/**
 * Composition-root port. One fresh single-use grant equal in scope to `held`,
 * or null. This is not a decision port: a decision answer cannot mint a grant.
 */
export interface EqualGrantIssuer {
  issue(held: Grant): Grant | null;
}
export interface ImplementPorts {
  readonly generate: InferenceGateway['generate'];
  readonly evaluate: InferenceGateway['evaluate'];
  readonly invoke: CapabilityHost['invoke'];
  /**
   * Fresh grant for one check attempt. Supplied by the composition root.
   * The step invokes the result only when its scope equals `held`.
   */
  readonly issueCheckGrant: EqualGrantIssuer['issue'];
  readonly now: () => number;
  /**
   * Fresh opaque value for each generation run, from the composition root (for
   * example a random UUID), as time comes from `now`. It must not repeat
   * for one execution, including across restarts. It is digested, never recorded.
   */
  readonly runId: () => string;
  readonly readState: () => SiteState;
  readonly budget?: (request: ImplementBudgetRequest) => ImplementBudgetDecision;
  /** Host canonical resource identity; aliases share one id. Absent admits no `check` proof. */
  readonly canonical?: (ref: string) => string;
}
export interface ImplementPause {
  readonly reason: ImplementPauseReason;
  readonly until: number | null;
}
export interface CheckEvidence {
  readonly check_id: ImplementCheckId;
  readonly argv_digest: string;
  readonly exit: number | null;
  readonly passed: boolean;
  readonly tail: string;
  readonly artifacts: readonly string[];
  /**
   * The host's invocation id for this check, linking the attempt journal to the
   * host record. Null when the host rejected it or reported no bounded id.
   * Absent on records written before #121.
   */
  readonly invocation_id?: string | null;
}
export interface ImplementEval {
  readonly criterion_id: string;
  readonly verdict_probability: number | null;
  readonly confidence: number | null;
  readonly passed: boolean;
}
export interface OpenIssue {
  readonly schema: typeof OPEN_ISSUE_SCHEMA;
  readonly issue_id: string;
  readonly execution_id: string;
  readonly source: 'check' | 'eval';
  readonly criterion_ids: readonly string[];
  readonly check_ids: readonly string[];
  readonly text: string;
  readonly severity: 'blocker';
  readonly blocked_by: 'ceiling' | 'budget' | null;
}
export interface AttemptRecord {
  readonly schema: typeof IMPLEMENT_ATTEMPT_SCHEMA;
  readonly id: string;
  readonly parentId: string | null;
  readonly execution_id: string;
  readonly attempt: number;
  readonly requested_tier: ImplementTier;
  readonly effective_tier: ImplementTier | null;
  readonly escalated: boolean;
  readonly status: 'passed' | 'failed' | 'paused';
  readonly generate_request_id: string | null;
  readonly artifact_refs: readonly string[];
  readonly checks: readonly CheckEvidence[];
  readonly evals: readonly ImplementEval[];
  readonly observations: readonly OutputEvalObservation[];
  readonly failing_criterion_ids: readonly string[];
  readonly failing_check_ids: readonly string[];
  readonly pause: ImplementPause | null;
  /** Why D5 was not asked on this finished attempt. Absent when it was asked or had nothing to judge. */
  readonly eval_skipped?: 'check_failed';
  /** Criterion proof admissions for this step. Absent on records written before #199. */
  readonly proofs?: readonly ProofAdmission[];
}
export interface StopRecord {
  readonly schema: typeof IMPLEMENT_STOP_SCHEMA;
  readonly id: string;
  readonly parentId: string | null;
  readonly execution_id: string;
  readonly blocked_by: 'ceiling' | 'budget' | null;
  readonly open_issue: OpenIssue;
}
export type JournalEntry = AttemptRecord | StopRecord;
export interface ImplementStepResult {
  readonly schema: typeof IMPLEMENT_STEP_SCHEMA;
  readonly execution_id: string | null;
  /**
   * `unfinished` only from replay of a journal the step has not finished (a
   * crash between attempts, or nothing yet): running the step continues it.
   */
  readonly status: 'passed' | 'failed' | 'paused' | 'unfinished';
  readonly goal_done: false;
  readonly reason: 'invalid_input' | null;
  readonly tier: ImplementTier | null;
  readonly ceiling: ImplementTier | null;
  readonly effective_tier: ImplementTier | null;
  readonly escalated: boolean;
  readonly attempts: readonly AttemptRecord[];
  readonly artifact_refs: readonly string[];
  readonly checks: readonly CheckEvidence[];
  readonly evals: readonly ImplementEval[];
  readonly observations: readonly OutputEvalObservation[];
  readonly open_issue: OpenIssue | null;
  readonly proofs: readonly ProofAdmission[];
}
export interface AttemptJournal {
  load(execution_id: string): JournalEntry[];
  append(entry: JournalEntry): void;
}

interface Normalized extends ImplementStepInput {
  readonly execution_id: string;
  readonly retries: number;
  readonly criteria: readonly ImplementCriterion[];
  readonly checks: readonly ImplementCheck[];
}
type Action =
  | { readonly type: 'finished' }
  | { readonly type: 'stop'; readonly blocked_by: 'ceiling' | 'budget' | null }
  | {
      readonly type: 'generate';
      readonly attempt: number;
      readonly requested: ImplementTier;
      readonly escalation: boolean;
      readonly parentId: string | null;
      readonly feedback: AttemptRecord | null;
    };

/**
 * `<execution_id><suffix>` while it fits the 128-character correlation limit.
 * Longer ids keep a bounded execution prefix plus the full execution digest and
 * the readable suffix, as audit request ids do, so shared prefixes stay distinct.
 */
function stepId(execution_id: string, suffix: string): string {
  const readable = `${execution_id}${suffix}`;
  const id = readable.length <= 128 ? readable
    : `${execution_id.slice(0, Math.max(0, 128 - suffix.length - 65))}:${digest(execution_id)}${suffix}`;
  if (!correlation(id)) throw new Error('Invalid implementation step id');
  return id;
}
function isTier(value: unknown): value is ImplementTier {
  return value === 'flash' || value === 'standard' || value === 'strong';
}
function rank(tier: ImplementTier): number {
  return IMPLEMENT_TIERS.indexOf(tier);
}
function nextTier(tier: ImplementTier): ImplementTier | null {
  return IMPLEMENT_TIERS[rank(tier) + 1] ?? null;
}
function isAttempt(entry: JournalEntry): entry is AttemptRecord {
  return entry.schema === IMPLEMENT_ATTEMPT_SCHEMA;
}
function pauseOf(reason: unknown, until: unknown): ImplementPause {
  return {
    reason: PAUSE_REASONS.includes(reason as ImplementPauseReason) ? reason as ImplementPauseReason : 'quota_unknown',
    until: typeof until === 'number' && Number.isFinite(until) ? until : null,
  };
}
function boundTail(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  const cut = value.slice(0, TAIL_CHARS);
  return CREDENTIAL.test(cut) ? '' : cut;
}
function keptRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && KEPT_REF.test(item));
}
function normalize(input: ImplementStepInput): Normalized | null {
  const execution_id = correlation(input.execution_id);
  const request_id = correlation(input.request_id);
  const retries = input.retries ?? DEFAULT_IMPLEMENT_RETRIES;
  if (!execution_id || !request_id || !isTier(input.tier) || !isTier(input.ceiling) || rank(input.tier) > rank(input.ceiling)) return null;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > MAX_RETRIES) return null;
  if (!GENERATION_KINDS.includes(input.kind) || typeof input.instructions !== 'string' || typeof input.prompt !== 'string') return null;
  if (!input.terms || !Array.isArray(input.criteria) || input.criteria.length === 0 || !Array.isArray(input.checks)) return null;
  const seen = new Set<string>();
  const criteria: ImplementCriterion[] = [];
  for (const criterion of input.criteria) {
    const criterion_id = correlation(criterion?.criterion_id);
    if (!criterion_id || seen.has(criterion_id) || typeof criterion.statement !== 'string') return null;
    if (criterion.proof !== undefined && !isCriterionProof(criterion.proof)) return null;
    const check_ids = criterion.check_ids;
    if (check_ids !== undefined && (!Array.isArray(check_ids) || check_ids.length > CHECKS.length ||
      !check_ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128))) return null;
    seen.add(criterion_id);
    criteria.push({
      criterion_id, statement: criterion.statement,
      ...(criterion.proof === undefined ? {} : { proof: criterion.proof }),
      ...(check_ids === undefined ? {} : { check_ids: [...check_ids] }),
    });
  }
  const checks: ImplementCheck[] = [];
  for (const check of input.checks) {
    if (!CHECKS.includes(check?.operation) || !isWellFormedRef(check.cwd_ref)) return null;
    if (!Number.isInteger(check.timeout_ms) || check.timeout_ms < 1 || check.timeout_ms > 600_000) return null;
    if (!Array.isArray(check.env_allow) || check.env_allow.length > 32) return null;
    const env_allow: string[] = [];
    for (const name of check.env_allow) {
      if (typeof name !== 'string' || name.length === 0 || name.length > 128 || !ENV_NAME.test(name)) return null;
      env_allow.push(name);
    }
    if (check.argv !== undefined) {
      if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.length > 32) return null;
      for (const arg of check.argv) {
        if (typeof arg !== 'string' || arg.length === 0 || arg.length > 4096 || arg.includes('\0')) return null;
      }
    }
    if (check.oracle_refs !== undefined && !isRefList(check.oracle_refs)) return null;
    checks.push({
      operation: check.operation,
      grant: check.grant,
      cwd_ref: check.cwd_ref,
      env_allow,
      timeout_ms: check.timeout_ms,
      ...(check.argv === undefined ? {} : { argv: [...check.argv] }),
      ...(check.oracle_refs === undefined ? {} : { oracle_refs: [...check.oracle_refs] }),
    });
  }
  if (input.generation_writes !== undefined && !isRefList(input.generation_writes)) return null;
  return {
    ...input, execution_id, request_id, retries, criteria, checks,
    ...(input.generation_writes === undefined ? {} : { generation_writes: [...input.generation_writes] }),
  };
}
function isRefList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(ref => isWellFormedRef(ref) && ref.length <= 128);
}
/** Pure; recorded on every attempt so replay never needs the canonical port. */
function admitProofs(input: Normalized, canonical: ImplementPorts['canonical']): ProofAdmission[] {
  const checks = input.checks.map(check => ({
    check_id: check.operation,
    ...(check.oracle_refs === undefined ? {} : { oracle_refs: check.oracle_refs }),
    permissions: check.grant?.permissions ?? null,
  }));
  return input.criteria.map(criterion => admitCriterionProof(criterion, checks,
    { generation_writes: input.generation_writes, canonical }));
}
function invalidResult(): ImplementStepResult {
  return {
    schema: IMPLEMENT_STEP_SCHEMA,
    execution_id: null,
    status: 'failed',
    goal_done: false,
    reason: 'invalid_input',
    tier: null,
    ceiling: null,
    effective_tier: null,
    escalated: false,
    attempts: [],
    artifact_refs: [],
    checks: [],
    evals: [],
    observations: [],
    open_issue: null,
    proofs: [],
  };
}
function lastFailure(attempts: readonly AttemptRecord[]): AttemptRecord | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt && attempt.status === 'failed') return attempt;
  }
  return null;
}
function actionFor(attempts: readonly AttemptRecord[], input: Normalized, stopped: boolean): Action {
  if (stopped || attempts.some(attempt => attempt.status === 'passed')) return { type: 'finished' };
  let fails = 0;
  let sawEscalation = false;
  let parentId: string | null = null;
  for (const attempt of attempts) {
    parentId = attempt.id;
    if (attempt.status === 'paused') continue;
    if (attempt.escalated) sawEscalation = true;
    else fails += 1;
  }
  if (sawEscalation && attempts.some(attempt => attempt.escalated && attempt.status === 'failed')) {
    return { type: 'stop', blocked_by: null };
  }
  const feedback = lastFailure(attempts);
  const attempt = attempts.length + 1;
  if (sawEscalation || fails > input.retries) {
    const requested = nextTier(input.tier);
    if (requested === null || rank(requested) > rank(input.ceiling)) return { type: 'stop', blocked_by: 'ceiling' };
    return { type: 'generate', attempt, requested, escalation: true, parentId, feedback };
  }
  return { type: 'generate', attempt, requested: input.tier, escalation: false, parentId, feedback };
}
function openIssue(input: Normalized, last: AttemptRecord | null, blocked_by: OpenIssue['blocked_by']): OpenIssue {
  const criterion_ids = last?.failing_criterion_ids ?? input.criteria.map(criterion => criterion.criterion_id);
  const check_ids = last?.failing_check_ids ?? [];
  const source = check_ids.length > 0 ? 'check' : 'eval';
  return {
    schema: OPEN_ISSUE_SCHEMA,
    issue_id: stepId(input.execution_id, ':open'),
    execution_id: input.execution_id,
    source,
    criterion_ids: [...criterion_ids],
    check_ids: [...check_ids],
    text: source === 'check' ? CHECK_TEXT : EVAL_TEXT,
    severity: 'blocker',
    blocked_by,
  };
}
function project(entries: readonly JournalEntry[], input: Normalized, cancelled: boolean): ImplementStepResult {
  const attempts = entries.filter(isAttempt);
  const stop = entries.find(entry => entry.schema === IMPLEMENT_STOP_SCHEMA) ?? null;
  const action = actionFor(attempts, input, stop !== null);
  const passed = attempts.find(attempt => attempt.status === 'passed') ?? null;
  const last = attempts.at(-1) ?? null;
  const focus = passed ?? last;
  let status: ImplementStepResult['status'];
  let open_issue: OpenIssue | null = null;
  if (cancelled && !passed && !stop) status = 'paused';
  else if (passed) status = 'passed';
  else if (stop) {
    status = 'failed';
    open_issue = stop.open_issue;
  } else if (action.type === 'stop') {
    status = 'failed';
    open_issue = openIssue(input, lastFailure(attempts), action.blocked_by);
  } else if (last?.status === 'paused') status = 'paused';
  // Another attempt is due: not terminal, and no open issue is raised yet.
  else status = 'unfinished';
  return {
    schema: IMPLEMENT_STEP_SCHEMA,
    execution_id: input.execution_id,
    status,
    goal_done: false,
    reason: null,
    tier: input.tier,
    ceiling: input.ceiling,
    effective_tier: focus?.effective_tier ?? null,
    escalated: attempts.some(attempt => attempt.escalated && attempt.status !== 'paused'),
    attempts: attempts.map(attempt => structuredClone(attempt)),
    artifact_refs: [...(focus?.artifact_refs ?? [])],
    checks: focus?.checks.map(check => structuredClone(check)) ?? [],
    evals: focus?.evals.map(item => structuredClone(item)) ?? [],
    observations: focus?.observations.map(item => structuredClone(item)) ?? [],
    open_issue: open_issue === null ? null : structuredClone(open_issue),
    proofs: (focus?.proofs ?? []).map(item => structuredClone(item)),
  };
}
function stopRecord(input: Normalized, attempts: readonly AttemptRecord[], blocked_by: OpenIssue['blocked_by']): StopRecord {
  const parent = attempts.at(-1) ?? null;
  return {
    schema: IMPLEMENT_STOP_SCHEMA,
    id: stepId(input.execution_id, ':stop'),
    parentId: parent?.id ?? null,
    execution_id: input.execution_id,
    blocked_by,
    open_issue: openIssue(input, lastFailure(attempts), blocked_by),
  };
}
function decisionTerms(terms: InferenceTerms): InferenceTerms {
  return {
    quality: terms.quality,
    destinations: [...terms.destinations],
    ...(terms.content_class === undefined ? {} : { content_class: terms.content_class }),
    max_context_tokens: terms.max_context_tokens,
    deadline: terms.deadline,
    cost_ceiling: terms.cost_ceiling,
    max_attempts: terms.max_attempts,
    tier: 'decision',
    ...(terms.max_attempts_per_route === undefined ? {} : { max_attempts_per_route: terms.max_attempts_per_route }),
    ...(terms.prefix_digest === undefined ? {} : { prefix_digest: terms.prefix_digest }),
    ...(terms.prefix_cache === undefined ? {} : { prefix_cache: terms.prefix_cache }),
  };
}
function generateTerms(terms: InferenceTerms, tier: ImplementTier): InferenceTerms {
  return { ...decisionTerms(terms), tier };
}
function feedbackPrompt(prompt: string, previous: AttemptRecord | null): string {
  if (!previous || (previous.failing_criterion_ids.length === 0 && previous.failing_check_ids.length === 0)) return prompt;
  const lines = ['[impl.feedback]'];
  for (const id of previous.failing_criterion_ids) lines.push(`criterion_id=${id} passed=false`);
  for (const id of previous.failing_check_ids) {
    const exit = previous.checks.find(check => check.check_id === id)?.exit;
    lines.push(`check_id=${id} passed=false exit=${exit === undefined || exit === null ? 'none' : String(exit)}`);
  }
  return `${prompt}\n${lines.join('\n')}`;
}
function flatEval(transition: { readonly evals: readonly { criterion_id: string; verdict_probability: number | null; confidence: number | null; passed: boolean }[] }): ImplementEval[] {
  return transition.evals.map(item => ({
    criterion_id: item.criterion_id,
    verdict_probability: item.verdict_probability,
    confidence: item.confidence,
    passed: item.passed,
  }));
}
function attemptRecord(fields: AttemptRecord): AttemptRecord {
  return {
    schema: IMPLEMENT_ATTEMPT_SCHEMA,
    id: fields.id,
    parentId: fields.parentId,
    execution_id: fields.execution_id,
    attempt: fields.attempt,
    requested_tier: fields.requested_tier,
    effective_tier: fields.effective_tier,
    escalated: fields.escalated,
    status: fields.status,
    generate_request_id: fields.generate_request_id,
    artifact_refs: fields.artifact_refs,
    checks: fields.checks,
    evals: fields.evals,
    observations: fields.observations,
    failing_criterion_ids: fields.failing_criterion_ids,
    failing_check_ids: fields.failing_check_ids,
    pause: fields.pause,
    ...(fields.eval_skipped === undefined ? {} : { eval_skipped: fields.eval_skipped }),
    ...(fields.proofs === undefined ? {} : { proofs: fields.proofs }),
  };
}
async function runChecks(input: Normalized, ports: ImplementPorts, attempt: number, checkRun: string, signal: AbortSignal | undefined): Promise<CheckEvidence[]> {
  const evidence: CheckEvidence[] = [];
  for (const check of input.checks) {
    if (signal?.aborted) break;
    const argv_digest = digest(check.argv ?? [check.operation]);
    const requested = stepId(input.execution_id, `:a${attempt}:${checkRun}:${check.operation}`);
    let exit: number | null = null;
    let passed = false;
    let tail = '';
    let artifacts: string[] = [];
    let invocation_id: string | null = null;
    try {
      const invoked = ports.invoke(freshCheckGrant(ports, check.grant), check.operation, {
        cwd_ref: check.cwd_ref,
        env_allow: [...check.env_allow],
        timeout_ms: check.timeout_ms,
      }, { invocation_id: requested });
      if (invoked.kind === 'rejected') {
        evidence.push({ check_id: check.operation, argv_digest, exit, passed, tail, artifacts, invocation_id });
        continue;
      }
      invocation_id = correlation(invoked.invocation_id);
      // Cancelling the step cancels the check in flight; the host still settles its result.
      const cancel = (): void => invoked.requestCancel();
      signal?.addEventListener('abort', cancel, { once: true });
      let outcome: Awaited<typeof invoked.result>;
      try {
        outcome = await invoked.result;
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
      if (outcome.outcome === 'succeeded' && outcome.output !== null && typeof outcome.output === 'object') {
        const output = outcome.output as Record<string, unknown>;
        if (Number.isInteger(output['exit'])) {
          exit = output['exit'] as number;
          passed = exit === 0;
        }
        tail = boundTail(output['stdout_tail']);
        artifacts = keptRefs(output['artifacts']);
      }
    } catch {
      exit = null;
      passed = false;
      tail = '';
      artifacts = [];
    }
    evidence.push({ check_id: check.operation, argv_digest, exit, passed, tail, artifacts, invocation_id });
  }
  return evidence;
}
function generatePaused(outcome: GenerationOutcome): ImplementPause | null {
  if (outcome.paused) return pauseOf(outcome.paused.reason, outcome.paused.until);
  if (outcome.status === 'blocked' && (PAUSE_REASONS as readonly string[]).includes(outcome.reason)) return pauseOf(outcome.reason, null);
  return null;
}

function copyGrant(fields: Grant): Grant {
  return {
    action_id: fields.action_id,
    operation: fields.operation,
    contract_rev: fields.contract_rev,
    permissions: fields.permissions.map(effect => ({ resource: effect.resource, mode: effect.mode })),
    effects: fields.effects.map(effect => ({ resource: effect.resource, mode: effect.mode })),
    issued_at: fields.issued_at,
    ...(fields.process_effects === undefined ? {} : { process_effects: [...fields.process_effects] }),
  };
}
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  if (seen.size !== left.length) return false;
  for (const token of right) {
    if (!seen.delete(token)) return false;
  }
  return seen.size === 0;
}
/** Equal scope. Action id and issued_at are not scope. A wider set is not equal. */
function sameGrantScope(held: Grant, issued: Grant): boolean {
  return held.operation === issued.operation
    && held.contract_rev === issued.contract_rev
    && effectSetsEqual(held.permissions, issued.permissions)
    && effectSetsEqual(held.effects, issued.effects)
    && sameStringSet(held.process_effects ?? [], issued.process_effects ?? []);
}
function freshCheckGrant(ports: ImplementPorts, held: Grant | null): Grant | null {
  if (!held) return null;
  const issued = ports.issueCheckGrant(held);
  if (!issued || !sameGrantScope(held, issued)) return null;
  return issued;
}

/**
 * Bind an authority to grants it has already issued. Scope is copied at bind
 * time, so a later mutation of the held grant cannot widen a fresh one.
 * Object identity is the hold: a field-equal copy, a wider grant, or a
 * decision answer is refused. The held grant is not consumed.
 *
 * `limit` bounds fresh grants per held grant (#124). One step run invokes each
 * check once per generation run, at most `retries + 2` times, so the default
 * fits the default retries; bind one issuer per step run and pass
 * `retries + 2` when the step is configured with more. Each fresh grant gets
 * its own action id, `<held action_id>:g<n>`, so release and proceed by action
 * id stay unambiguous among this issuer's grants (#125). Action id is not scope.
 */
export function createEqualGrantIssuer(authority: GrantAuthority, held: readonly Grant[],
  limit: number = DEFAULT_IMPLEMENT_RETRIES + 2): EqualGrantIssuer {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETRIES + 2) throw new Error('Invalid grant issue limit');
  const scopes = new Map<Grant, { readonly scope: Grant; issued: number }>();
  for (const grant of held) {
    if (!authority.isIssued(grant) || !authority.isValid(grant)) continue;
    scopes.set(grant, { scope: copyGrant(grant), issued: 0 });
  }
  return {
    issue(template) {
      const bound = scopes.get(template);
      if (!bound || bound.issued >= limit || !authority.isValid(template)) return null;
      bound.issued += 1;
      return authority.issue({ ...copyGrant(bound.scope), action_id: `${bound.scope.action_id}:g${bound.issued}` });
    },
  };
}

/** Rebuild the step result from finished entries. Does not call a provider or the host. */
export function replayImplementationStep(entries: readonly JournalEntry[], input: ImplementStepInput): ImplementStepResult {
  const normalized = normalize(input);
  if (!normalized) return invalidResult();
  return project(entries.filter(entry => entry.execution_id === normalized.execution_id), normalized, false);
}

export async function runImplementationStep(input: ImplementStepInput, ports: ImplementPorts,
  journal: AttemptJournal, signal?: AbortSignal): Promise<ImplementStepResult> {
  const normalized = normalize(input);
  if (!normalized) return invalidResult();
  const history = journal.load(normalized.execution_id);
  const finish = (): ImplementStepResult => project(history, normalized, false);
  const proofs = admitProofs(normalized, ports.canonical);
  const judged = normalized.criteria.filter((_, index) => proofs[index]?.proof !== 'check');
  // One iteration per attempt, plus the stop that follows the last failure.
  // Earlier pauses do not consume this bound.
  for (let guard = 0; guard <= normalized.retries + 2; guard += 1) {
    const attempts = history.filter(isAttempt);
    const stopped = history.some(entry => entry.schema === IMPLEMENT_STOP_SCHEMA);
    const action = actionFor(attempts, normalized, stopped);
    if (action.type === 'finished') return finish();
    if (action.type === 'stop') {
      if (!stopped) history.push(remember(journal, stopRecord(normalized, attempts, action.blocked_by)));
      return finish();
    }
    if (signal?.aborted) return project(history, normalized, true);
    const attemptId = stepId(normalized.execution_id, `:a${action.attempt}`);
    const decision = ports.budget?.({ requested: action.requested, escalation: action.escalation, attempt: action.attempt })
      ?? { status: 'allow' as const, tier: action.requested };
    const allowed = decision.status === 'allow' && isTier(decision.tier) ? decision.tier : null;
    // Escalation is exactly one tier, so a downgrade there stops the step. A pause
    // is temporary at either tier: it is recorded and a later run resumes (#128).
    if (allowed === null || (action.escalation && allowed !== action.requested)) {
      if (action.escalation && allowed !== null) {
        history.push(remember(journal, stopRecord(normalized, attempts, 'budget')));
        return finish();
      }
      history.push(remember(journal, attemptRecord({
        schema: IMPLEMENT_ATTEMPT_SCHEMA,
        id: attemptId,
        parentId: action.parentId,
        execution_id: normalized.execution_id,
        attempt: action.attempt,
        requested_tier: action.requested,
        effective_tier: null,
        escalated: action.escalation,
        status: 'paused',
        generate_request_id: null,
        artifact_refs: [],
        checks: [],
        evals: [],
        observations: [],
        failing_criterion_ids: [],
        failing_check_ids: [],
        pause: pauseOf(decision.status === 'pause' ? decision.reason : 'quota_unknown', decision.status === 'pause' ? decision.until : null),
        proofs,
      })));
      return finish();
    }
    const effective = action.escalation ? action.requested
      : IMPLEMENT_TIERS[Math.min(rank(allowed), rank(action.requested), rank(normalized.ceiling))]!;
    const generateId = stepId(normalized.execution_id, `:a${action.attempt}:gen`);
    // Taken before the paid call, so a broken port fails before anything is spent.
    const run = ports.runId();
    if (typeof run !== 'string' || run.length === 0) throw new Error('Invalid implementation run id');
    const outcome = await ports.generate({
      request_id: generateId,
      site: 'impl.generate',
      role: 'working',
      kind: normalized.kind,
      input: { instructions: normalized.instructions, prompt: feedbackPrompt(normalized.prompt, action.feedback) },
      terms: generateTerms(normalized.terms, effective),
      accept: nonEmptyText,
    }, signal);
    const held = generatePaused(outcome);
    if (held || signal?.aborted) {
      history.push(remember(journal, attemptRecord({
        schema: IMPLEMENT_ATTEMPT_SCHEMA,
        id: attemptId,
        parentId: action.parentId,
        execution_id: normalized.execution_id,
        attempt: action.attempt,
        requested_tier: action.requested,
        effective_tier: effective,
        escalated: action.escalation,
        status: 'paused',
        generate_request_id: generateId,
        artifact_refs: [],
        checks: [],
        evals: [],
        observations: [],
        failing_criterion_ids: [],
        failing_check_ids: [],
        pause: held ?? pauseOf('cancelled', null),
        proofs,
      })));
      return finish();
    }
    let artifactRefs: string[] = [];
    let checks: CheckEvidence[] = [];
    let evals: ImplementEval[] = [];
    let observations: OutputEvalObservation[] = [];
    let failingCriteria: string[] = [];
    let failingChecks: string[] = [];
    let evalSkipped: AttemptRecord['eval_skipped'];
    if (outcome.status !== 'accepted') {
      // Generation failed before D5: retain the blocker without fabricating an evaluation.
      failingCriteria = normalized.criteria.map(criterion => criterion.criterion_id);
    } else {
      const digestHex = digest(outcome.text);
      const ref = `gen_${digestHex.slice(0, 32)}`;
      artifactRefs = [ref];
      // Text alone does not identify workspace edits: even equal output text can
      // accompany different edits on recovery. Never replay across generate runs.
      // 128 bits over the full text digest and this run's value: a fresh identity per run.
      const checkRun = digest({ artifact: digestHex, run }).slice(0, 32);
      checks = await runChecks(normalized, ports, action.attempt, checkRun, signal);
      if (signal?.aborted) {
        history.push(remember(journal, attemptRecord({
          schema: IMPLEMENT_ATTEMPT_SCHEMA,
          id: attemptId,
          parentId: action.parentId,
          execution_id: normalized.execution_id,
          attempt: action.attempt,
          requested_tier: action.requested,
          effective_tier: effective,
          escalated: action.escalation,
          status: 'paused',
          generate_request_id: generateId,
          artifact_refs: artifactRefs,
          checks,
          evals: [],
          observations: [],
          failing_criterion_ids: [],
          failing_check_ids: checks.filter(check => !check.passed).map(check => check.check_id),
          pause: pauseOf('cancelled', null),
          proofs,
        })));
        return finish();
      }
      failingChecks = checks.filter(check => !check.passed).map(check => check.check_id);
      // A check-proven criterion is settled by its bound checks; D5 is not asked about it.
      const green = (id: string): boolean => {
        const ran = checks.filter(check => check.check_id === id);
        return ran.length > 0 && ran.every(check => check.passed);
      };
      const checkFailed = new Set(normalized.criteria
        .filter((criterion, index) => proofs[index]?.proof === 'check' && !(criterion.check_ids ?? []).every(green))
        .map(criterion => criterion.criterion_id));
      let transition: OutputEvalTransition = { status: 'pass', evals: [], observations: [], failing_criterion_ids: [] };
      // A red check fails this attempt whatever D5 answers, so D5 is not asked and no eval is recorded.
      if (judged.length > 0 && failingChecks.length > 0) evalSkipped = 'check_failed';
      else if (judged.length > 0) {
        const live = ports.readState();
        const evalRequest = stepId(normalized.execution_id, `:a${action.attempt}:eval`);
        const disclosed = {
          criteria: judged.map(criterion => ({ criterion_id: criterion.criterion_id, statement: criterion.statement })),
          artifact: { ref, digest: digestHex },
          artifact_text: outcome.text,
          checks: checks.map(check => ({ check_id: check.check_id, exit: check.exit, passed: check.passed })),
        };
        transition = await evaluateOutputEval({
          request_id: evalRequest,
          state_revision: live.state_revision,
          state_updated_at: live.state_updated_at,
          state: disclosed,
          terms: decisionTerms(normalized.terms),
          needs_dispatch: false,
          criteria: judged.map(criterion => ({ criterion_id: criterion.criterion_id, statement: criterion.statement })),
        }, { evaluate: ports.evaluate }, () => ({ ...ports.readState(), observed_at: ports.now() }), signal);
      }
      const evalFailed = new Set(transition.failing_criterion_ids);
      const failingOf = (): string[] => normalized.criteria.map(criterion => criterion.criterion_id)
        .filter(id => checkFailed.has(id) || evalFailed.has(id));
      if (transition.status === 'paused') {
        history.push(remember(journal, attemptRecord({
          schema: IMPLEMENT_ATTEMPT_SCHEMA,
          id: attemptId,
          parentId: action.parentId,
          execution_id: normalized.execution_id,
          attempt: action.attempt,
          requested_tier: action.requested,
          effective_tier: effective,
          escalated: action.escalation,
          status: 'paused',
          generate_request_id: generateId,
          artifact_refs: [...artifactRefs, ...checks.flatMap(check => check.artifacts)],
          checks,
          evals: flatEval(transition),
          observations: [...transition.observations],
          failing_criterion_ids: failingOf(),
          failing_check_ids: failingChecks,
          pause: pauseOf('cancelled', null),
          proofs,
        })));
        return finish();
      }
      evals = flatEval(transition);
      observations = [...transition.observations];
      failingCriteria = failingOf();
      artifactRefs = [...artifactRefs, ...checks.flatMap(check => check.artifacts)];
    }
    const failed = outcome.status !== 'accepted' || failingChecks.length > 0 || failingCriteria.length > 0;
    history.push(remember(journal, attemptRecord({
      schema: IMPLEMENT_ATTEMPT_SCHEMA,
      id: attemptId,
      parentId: action.parentId,
      execution_id: normalized.execution_id,
      attempt: action.attempt,
      requested_tier: action.requested,
      effective_tier: effective,
      escalated: action.escalation,
      status: failed ? 'failed' : 'passed',
      generate_request_id: generateId,
      artifact_refs: artifactRefs,
      checks,
      evals,
      observations,
      failing_criterion_ids: failingCriteria,
      failing_check_ids: failingChecks,
      pause: null,
      ...(evalSkipped === undefined ? {} : { eval_skipped: evalSkipped }),
      proofs,
    })));
    if (!failed) return finish();
  }
  const attempts = history.filter(isAttempt);
  const stopped = history.some(entry => entry.schema === IMPLEMENT_STOP_SCHEMA);
  const action = actionFor(attempts, normalized, stopped);
  if (action.type === 'stop' && !stopped) history.push(remember(journal, stopRecord(normalized, attempts, action.blocked_by)));
  return finish();
}
function remember(journal: AttemptJournal, entry: JournalEntry): JournalEntry {
  journal.append(entry);
  return entry;
}

export class MemoryAttemptJournal implements AttemptJournal {
  private readonly items: JournalEntry[] = [];
  load(execution_id: string): JournalEntry[] {
    return this.items.filter(entry => entry.execution_id === execution_id).map(entry => structuredClone(entry));
  }
  append(entry: JournalEntry): void {
    if (this.items.some(item => item.id === entry.id)) return;
    this.items.push(structuredClone(entry));
  }
}

/** JSONL attempt log. A torn final line is repaired before the next read or append. */
export class FileAttemptJournal implements AttemptJournal {
  constructor(readonly path: string) {
    const directory = dirname(path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');
  }
  load(execution_id: string): JournalEntry[] {
    return readEntries(this.path).filter(entry => entry.execution_id === execution_id);
  }
  append(entry: JournalEntry): void {
    if (readEntries(this.path).some(item => item.id === entry.id)) return;
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }
}
/**
 * A crash can end the file mid-record. Drop that unparseable tail so the next
 * record starts on its own line. A complete record that is missing its newline
 * is terminated instead, so a finished attempt is kept.
 */
function repairTornTail(path: string): void {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return;
  const breakAt = bytes.lastIndexOf(0x0a);
  try {
    JSON.parse(bytes.subarray(breakAt + 1).toString('utf8'));
  } catch {
    truncateSync(path, breakAt + 1);
    return;
  }
  appendFileSync(path, '\n');
}
function readEntries(path: string): JournalEntry[] {
  repairTornTail(path);
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const entries: JournalEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) continue;
      throw new PersistError('impl.attempt');
    }
    if (!parsed || typeof parsed !== 'object') throw new PersistError('impl.attempt');
    const record = parsed as Partial<JournalEntry>;
    if (record.schema !== IMPLEMENT_ATTEMPT_SCHEMA && record.schema !== IMPLEMENT_STOP_SCHEMA) throw new PersistError('impl.attempt');
    if (typeof record.execution_id !== 'string' || typeof record.id !== 'string') throw new PersistError('impl.attempt');
    entries.push(record as JournalEntry);
  }
  return entries;
}
