/**
 * Acceptance facts and task validation.
 *
 * An LLM may propose acceptance lines. Code admits only a single observable
 * fact. Admitted facts become one boolean question each — a Noul on the System
 * One wire. The criteria gate (`task.criteria`) runs before the work. Task
 * validation (`task.validate`) asks every remaining Noul in one evaluation
 * request. Code decides done.
 *
 * This is not the decision layer. It does not weigh `frontier.weigh`, select
 * an action, do arithmetic, or grant execution. A write-up is not part of the
 * state a question may see. Hard constraints are the constraints and authority
 * declared for this task. They are enforced in code and are not Noul questions.
 * `do_not_send` and `do_not_delete` are not global operation bans.
 *
 * Assumptions the repository cannot verify from a provider call:
 * - The month name "may" is not treated as a date signal, because the same
 *   word is a verb.
 * - Flags before a git or npm subcommand are not interpreted. `git push` is
 *   read from argv[0] and argv[1].
 * - TypeSafe publishes no confidence for a Noul. Missing confidence is below
 *   the floor and escalates. That is fail-closed, not a calibration claim, and
 *   it is not comparable to `frontier.weigh`.
 */
import type {
  BooleanQuestion,
  EvaluationOutcome,
  InferenceGateway,
  InferenceTerms,
  RoutedUnit,
} from '@weave/gateway';

export const ACCEPTANCE_LINE_CONTRACT = 'acceptance.line@1' as const;
export const TASK_CRITERIA_SITE = 'task.criteria' as const;
export const TASK_VALIDATE_SITE = 'task.validate' as const;

/**
 * Pinned model id. `jev-latest` and `typesafe-ai/jev` are floating aliases
 * already used elsewhere in the repo; this slice does not follow them.
 * `jev-1.13.0` is the concrete id recorded on the System One fixture.
 */
export const TASK_JEV_MODEL_ID = 'jev-1.13.0' as const;

/**
 * Declared before any frozen-set result. The 0.9 floor sits above the
 * 0.8–0.9 band the hosted-Jev notes already call unsafe for a naive cutoff.
 * The holdout split must not move these numbers.
 */
export const DECLARED_TASK_POLICY = {
  contract: ACCEPTANCE_LINE_CONTRACT,
  model: TASK_JEV_MODEL_ID,
  probability_threshold: 0.8,
  confidence_floor: 0.9,
} as const;

export const ACCEPTANCE_LINE_CONTRACT_RECORD = {
  id: ACCEPTANCE_LINE_CONTRACT,
  question_primitive: 'boolean',
  wire_primitive: 'noul',
  criteria_site: TASK_CRITERIA_SITE,
  validation_site: TASK_VALIDATE_SITE,
  criteria_state: 'the proposed line only: fact, evidence identity, and escape',
  validation_state: 'the admitted fact plus the body of its named artifact or the output of its named command',
  omitted_from_state: ['write_up', 'task prose', 'unreferenced artifacts', 'unreferenced commands'],
  model: TASK_JEV_MODEL_ID,
} as const;

const CRITERIA_INSTRUCTIONS =
  'Is this line exactly one property, and can the named evidence show it without a count, a date, a total, or a taste judgment?';

const VALIDATION_INSTRUCTIONS = 'Does the named evidence show this fact?';

const JUDGMENT_WORDS = [
  'reasonable',
  'appropriate',
  'elegant',
  'sufficient',
  'adequate',
  'acceptable',
  'satisfactory',
  'optimal',
  'nice',
  'proper',
  'beautiful',
  'good',
  'bad',
] as const;

const COUNT_WORDS = [
  'count',
  'counts',
  'counted',
  'several',
  'many',
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

const COUNT_PHRASES = ['number of', 'how many'] as const;

/** "may" is intentionally absent. See the module assumptions. */
const DATE_WORDS = [
  'date',
  'dated',
  'today',
  'yesterday',
  'tomorrow',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const TOTAL_WORDS = ['total', 'totals', 'sum', 'summed', 'average', 'mean', 'percent', 'percentage'] as const;

export interface TaskJudgmentPolicy {
  readonly contract: typeof ACCEPTANCE_LINE_CONTRACT;
  readonly model: typeof TASK_JEV_MODEL_ID;
  readonly probability_threshold: number;
  readonly confidence_floor: number;
}

export type EvidenceRef =
  | { readonly kind: 'artifact'; readonly artifact_id: string }
  | { readonly kind: 'command'; readonly command_id: string };

export interface AcceptanceLine {
  readonly line_id: string;
  readonly fact: string;
  readonly evidence: EvidenceRef;
  readonly escape: string;
}

export interface ArtifactBody {
  readonly artifact_id: string;
  readonly body: string;
}

export interface CommandRecord {
  readonly command_id: string;
  readonly argv: readonly string[];
  readonly output: string;
  readonly asked: boolean;
}

export type LineAdmission =
  | { readonly status: 'admitted'; readonly line: AcceptanceLine }
  | { readonly status: 'rejected'; readonly reason: string; readonly line_id: string | null };

export interface NoulAnswerRecord {
  readonly probability: number;
  readonly confidence: number | null;
}

export type NoulFixture = Readonly<Record<string, NoulAnswerRecord>>;

interface LexicalEntry {
  readonly line_id: string | null;
  readonly lexical: { readonly status: 'admitted'; readonly line: AcceptanceLine } | { readonly status: 'rejected'; readonly reason: string };
}

export interface CriteriaRecord {
  readonly contract: typeof ACCEPTANCE_LINE_CONTRACT;
  readonly site: typeof TASK_CRITERIA_SITE;
  readonly model: typeof TASK_JEV_MODEL_ID;
  readonly probability_threshold: number;
  readonly confidence_floor: number;
  readonly lines: readonly LexicalEntry[];
  readonly state: Readonly<Record<string, unknown>> | null;
  readonly requested: boolean;
  readonly malformed: string | null;
  readonly answers: Readonly<Record<string, NoulAnswerRecord>>;
}

export interface CriteriaLineDecision {
  readonly line_id: string | null;
  readonly status: 'rejected' | 'revise' | 'admitted' | 'escalate';
  readonly reason: string | null;
}

export interface CriteriaDecision {
  readonly entered: readonly AcceptanceLine[];
  readonly lines: readonly CriteriaLineDecision[];
  readonly malformed: string | null;
}

interface ValidationFact {
  readonly line_id: string;
  readonly fact: string;
  readonly evidence: { readonly kind: 'artifact' | 'command'; readonly id: string; readonly body: string } | null;
}

export interface ValidationRecord {
  readonly contract: typeof ACCEPTANCE_LINE_CONTRACT;
  readonly site: typeof TASK_VALIDATE_SITE;
  readonly model: typeof TASK_JEV_MODEL_ID;
  readonly probability_threshold: number;
  readonly confidence_floor: number;
  readonly facts: readonly ValidationFact[];
  readonly state: Readonly<Record<string, unknown>> | null;
  readonly requested: boolean;
  readonly malformed: string | null;
  readonly answers: Readonly<Record<string, NoulAnswerRecord>>;
  readonly commands: readonly CommandRecord[];
  readonly declaration: TaskConstraintDeclaration;
  readonly write_up_ignored: true;
}

export type ValidationDisposition = 'done' | 'fail' | 'escalate' | 'malformed' | 'escape';

export const TASK_HARD_CONSTRAINTS = ['do_not_send', 'do_not_delete', 'ask_before_effect'] as const;
export type TaskHardConstraint = (typeof TASK_HARD_CONSTRAINTS)[number];

/** Effects a task may authorize. Send and delete are not implied by an ask. */
export const TASK_AUTHORITY_EFFECTS = ['send', 'delete'] as const;
export type TaskAuthorityEffect = (typeof TASK_AUTHORITY_EFFECTS)[number];

/**
 * Constraints and authority for one task, declared before validation.
 * A constraint applies only when it is listed here. Authority for `send` or
 * `delete` permits that effect even when the matching constraint is listed.
 */
export interface TaskConstraintDeclaration {
  readonly constraints: readonly TaskHardConstraint[];
  readonly authority: readonly TaskAuthorityEffect[];
}

export interface HardConstraintFailure {
  readonly code: TaskHardConstraint;
  readonly command_id: string;
}

export interface FactVerdict {
  readonly line_id: string;
  readonly status: 'pass' | 'fail' | 'escalate' | 'escape' | 'malformed';
}

export interface ValidationDecision {
  readonly done: boolean;
  readonly disposition: ValidationDisposition;
  readonly reasons: readonly string[];
  readonly lines: readonly FactVerdict[];
  readonly hard_constraints: readonly HardConstraintFailure[];
  readonly write_up_ignored: true;
}

export interface JudgmentCall {
  readonly request_id: string;
  readonly terms: InferenceTerms;
  readonly gateway: InferenceGateway;
  readonly policy?: TaskJudgmentPolicy;
}

// ---------------------------------------------------------------------------
// Admission. Code, not a model.
// ---------------------------------------------------------------------------

export function admitProposedLine(raw: unknown): LineAdmission {
  const parsed = parseLine(raw);
  if (parsed.status === 'rejected') return parsed;
  const reason = vagueReason(parsed.line.fact);
  if (reason !== null) {
    return { status: 'rejected', reason, line_id: parsed.line.line_id };
  }
  return { status: 'admitted', line: parsed.line };
}

export function admitProposedLines(rawLines: readonly unknown[]): readonly LineAdmission[] {
  const admissions = rawLines.map((raw) => admitProposedLine(raw));
  const counts = new Map<string, number>();
  for (const admission of admissions) {
    if (admission.status !== 'admitted') continue;
    counts.set(admission.line.line_id, (counts.get(admission.line.line_id) ?? 0) + 1);
  }
  return admissions.map((admission) => {
    if (admission.status !== 'admitted') return admission;
    if ((counts.get(admission.line.line_id) ?? 0) > 1) {
      return { status: 'rejected', reason: 'duplicate_line_id', line_id: admission.line.line_id };
    }
    return admission;
  });
}

function parseLine(raw: unknown): { readonly status: 'admitted'; readonly line: AcceptanceLine } | LineAdmission {
  if (!isRecord(raw)) return { status: 'rejected', reason: 'not_a_line', line_id: null };
  const line_id = raw['line_id'];
  const fact = raw['fact'];
  const escape = raw['escape'];
  const evidence = parseEvidence(raw['evidence']);
  if (typeof line_id !== 'string' || line_id.trim().length === 0) {
    return { status: 'rejected', reason: 'missing_line_id', line_id: null };
  }
  if (typeof fact !== 'string' || fact.trim().length === 0) {
    return { status: 'rejected', reason: 'empty_fact', line_id };
  }
  if (typeof escape !== 'string' || escape.trim().length === 0) {
    return { status: 'rejected', reason: 'missing_escape', line_id };
  }
  if (evidence === null) return { status: 'rejected', reason: 'missing_evidence', line_id };
  return { status: 'admitted', line: { line_id, fact: fact.trim(), evidence, escape: escape.trim() } };
}

function parseEvidence(raw: unknown): EvidenceRef | null {
  if (!isRecord(raw)) return null;
  if (raw['kind'] === 'artifact' && typeof raw['artifact_id'] === 'string' && raw['artifact_id'].trim().length > 0) {
    return { kind: 'artifact', artifact_id: raw['artifact_id'] };
  }
  if (raw['kind'] === 'command' && typeof raw['command_id'] === 'string' && raw['command_id'].trim().length > 0) {
    return { kind: 'command', command_id: raw['command_id'] };
  }
  return null;
}

/** Quoted literals are text the artifact must contain, not counts or dates. */
function withoutQuotes(fact: string): string {
  return fact.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ');
}

function vagueReason(fact: string): string | null {
  const bare = withoutQuotes(fact);
  if (bare.trim().length === 0) return 'empty_fact';
  if (JUDGMENT_WORDS.some((word) => hasWord(bare, word))) return 'judgment';
  if (COUNT_PHRASES.some((phrase) => bare.toLowerCase().includes(phrase))) return 'count';
  if (/\d/.test(bare) || COUNT_WORDS.some((word) => hasWord(bare, word))) return 'count';
  if (DATE_WORDS.some((word) => hasWord(bare, word))) return 'date';
  if (TOTAL_WORDS.some((word) => hasWord(bare, word))) return 'total';
  if (/\band\b/i.test(bare) || /\bor\b/i.test(bare) || bare.includes(';')) return 'compound_fact';
  return null;
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

// ---------------------------------------------------------------------------
// Questions and state. One boolean question per line. One shared state.
// ---------------------------------------------------------------------------

function criteriaQuestions(lines: readonly AcceptanceLine[]): Readonly<Record<string, BooleanQuestion>> {
  const questions: Record<string, BooleanQuestion> = {};
  for (const line of lines) {
    questions[line.line_id] = {
      type: 'boolean',
      instructions: `${CRITERIA_INSTRUCTIONS} Line ${line.line_id}.`,
      criteria: {
        true: 'The line is exactly one property and the named evidence can show it.',
        false: 'The line is vague, compound, or not observable from the named evidence.',
      },
    };
  }
  return questions;
}

function validationQuestions(facts: readonly ValidationFact[]): Readonly<Record<string, BooleanQuestion>> {
  const questions: Record<string, BooleanQuestion> = {};
  for (const fact of facts) {
    if (fact.evidence === null) continue;
    questions[fact.line_id] = {
      type: 'boolean',
      instructions: `${VALIDATION_INSTRUCTIONS} Line ${fact.line_id}.`,
      criteria: {
        true: 'The evidence shows the fact.',
        false: 'The evidence does not show the fact.',
      },
    };
  }
  return questions;
}

function criteriaState(lines: readonly AcceptanceLine[]): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  for (const line of lines) {
    body[line.line_id] = {
      fact: line.fact,
      evidence: evidenceIdentity(line.evidence),
      escape: line.escape,
    };
  }
  return { contract: ACCEPTANCE_LINE_CONTRACT, lines: body };
}

function validationState(facts: readonly ValidationFact[]): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  for (const fact of facts) {
    if (fact.evidence === null) continue;
    body[fact.line_id] = { fact: fact.fact, evidence: fact.evidence };
  }
  return { contract: ACCEPTANCE_LINE_CONTRACT, facts: body };
}

function evidenceIdentity(evidence: EvidenceRef): Readonly<Record<string, string>> {
  if (evidence.kind === 'artifact') return { kind: 'artifact', id: evidence.artifact_id };
  return { kind: 'command', id: evidence.command_id };
}

// ---------------------------------------------------------------------------
// Records, decisions, replay. Replay has no gateway parameter.
// ---------------------------------------------------------------------------

function assertPolicy(policy: TaskJudgmentPolicy): void {
  if (policy.contract !== ACCEPTANCE_LINE_CONTRACT) throw new Error('unknown acceptance contract');
  if (policy.model !== TASK_JEV_MODEL_ID) throw new Error(`unpinned model: ${policy.model}`);
  if (!inOpenUnit(policy.probability_threshold) || !inOpenUnit(policy.confidence_floor)) {
    throw new Error('thresholds must be declared in (0, 1] before the run');
  }
}

function policyOf(policy: TaskJudgmentPolicy | undefined): TaskJudgmentPolicy {
  const resolved = policy ?? DECLARED_TASK_POLICY;
  assertPolicy(resolved);
  return resolved;
}

function lexicalEntries(rawLines: readonly unknown[]): readonly LexicalEntry[] {
  return admitProposedLines(rawLines).map((admission) => {
    if (admission.status === 'admitted') {
      return { line_id: admission.line.line_id, lexical: { status: 'admitted' as const, line: admission.line } };
    }
    return { line_id: admission.line_id, lexical: { status: 'rejected' as const, reason: admission.reason } };
  });
}

function admittedOf(lines: readonly LexicalEntry[]): AcceptanceLine[] {
  const admitted: AcceptanceLine[] = [];
  for (const entry of lines) {
    if (entry.lexical.status === 'admitted') admitted.push(entry.lexical.line);
  }
  return admitted;
}

export function criteriaFromFixture(
  proposed: readonly unknown[],
  fixture: NoulFixture,
  policy?: TaskJudgmentPolicy,
): CriteriaRecord {
  const resolved = policyOf(policy);
  const lines = lexicalEntries(proposed);
  const admitted = admittedOf(lines);
  if (admitted.length === 0) return criteriaRecord(resolved, lines, null, null);
  const answers: Record<string, NoulAnswerRecord> = {};
  for (const line of admitted) {
    const answer = fixture[line.line_id];
    if (answer === undefined) throw new Error(`fixture missing criteria for ${line.line_id}`);
    answers[line.line_id] = answer;
  }
  return criteriaRecord(resolved, lines, answers, null);
}

export function validationFromFixture(
  admitted: readonly AcceptanceLine[],
  artifacts: readonly ArtifactBody[],
  commands: readonly CommandRecord[],
  fixture: NoulFixture,
  declaration: TaskConstraintDeclaration,
  writeUp?: string,
  policy?: TaskJudgmentPolicy,
): ValidationRecord {
  const resolved = policyOf(policy);
  const facts = factsFor(admitted, artifacts, commands);
  const shown = facts.filter((fact) => fact.evidence !== null);
  if (shown.length === 0) return validationRecord(resolved, facts, commands, declaration, null, null, writeUp);
  const answers: Record<string, NoulAnswerRecord> = {};
  for (const fact of shown) {
    const answer = fixture[fact.line_id];
    if (answer === undefined) throw new Error(`fixture missing validation for ${fact.line_id}`);
    answers[fact.line_id] = answer;
  }
  return validationRecord(resolved, facts, commands, declaration, answers, null, writeUp);
}

export function decideCriteria(record: CriteriaRecord): CriteriaDecision {
  if (record.model !== TASK_JEV_MODEL_ID) {
    return { entered: [], lines: escalateAsked(record, 'unpinned_model'), malformed: 'unpinned_model' };
  }
  if (record.malformed !== null) {
    return { entered: [], lines: escalateAsked(record, record.malformed), malformed: record.malformed };
  }
  for (const entry of record.lines) {
    if (entry.lexical.status !== 'admitted') continue;
    const answer = record.answers[entry.lexical.line.line_id];
    if (
      !record.requested ||
      answer === undefined ||
      !inUnit(answer.probability) ||
      (answer.confidence !== null && !inUnit(answer.confidence))
    ) {
      return { entered: [], lines: escalateAsked(record, 'malformed'), malformed: 'malformed' };
    }
  }

  const decisions: CriteriaLineDecision[] = [];
  const entered: AcceptanceLine[] = [];
  for (const entry of record.lines) {
    if (entry.lexical.status === 'rejected') {
      decisions.push({ line_id: entry.line_id, status: 'rejected', reason: entry.lexical.reason });
      continue;
    }
    const line = entry.lexical.line;
    const answer = record.answers[line.line_id];
    if (answer === undefined) {
      return { entered: [], lines: escalateAsked(record, 'malformed'), malformed: 'malformed' };
    }
    if (answer.confidence === null || answer.confidence < record.confidence_floor) {
      decisions.push({ line_id: line.line_id, status: 'revise', reason: 'low_confidence' });
      continue;
    }
    if (answer.probability < record.probability_threshold) {
      decisions.push({ line_id: line.line_id, status: 'rejected', reason: 'not_one_observable_fact' });
      continue;
    }
    decisions.push({ line_id: line.line_id, status: 'admitted', reason: null });
    entered.push(line);
  }
  return { entered, lines: decisions, malformed: null };
}

export function replayCriteria(record: CriteriaRecord): CriteriaDecision {
  return decideCriteria(record);
}

export function decideValidation(record: ValidationRecord): ValidationDecision {
  const constraints = hardConstraints(record.commands, record.declaration);
  if (record.model !== TASK_JEV_MODEL_ID) {
    return validationDecision('malformed', ['unpinned_model'], [], constraints);
  }
  if (constraints.length > 0) {
    return validationDecision(
      'fail',
      constraints.map((failure) => failure.code),
      [],
      constraints,
    );
  }
  if (record.malformed !== null) {
    return validationDecision('malformed', [record.malformed], [], constraints);
  }
  if (record.facts.length === 0) {
    return validationDecision('fail', ['no_admitted_facts'], [], constraints);
  }

  const lines: FactVerdict[] = [];
  let failed = false;
  let escalated = false;
  let escaped = false;
  for (const fact of record.facts) {
    if (fact.evidence === null) {
      escaped = true;
      lines.push({ line_id: fact.line_id, status: 'escape' });
      continue;
    }
    const answer = record.answers[fact.line_id];
    if (answer === undefined || !inUnit(answer.probability) || (answer.confidence !== null && !inUnit(answer.confidence))) {
      return validationDecision('malformed', [`unanswered:${fact.line_id}`], lines, constraints);
    }
    if (answer.confidence === null || answer.confidence < record.confidence_floor) {
      escalated = true;
      lines.push({ line_id: fact.line_id, status: 'escalate' });
      continue;
    }
    if (answer.probability < record.probability_threshold) {
      failed = true;
      lines.push({ line_id: fact.line_id, status: 'fail' });
      continue;
    }
    lines.push({ line_id: fact.line_id, status: 'pass' });
  }
  if (failed) return validationDecision('fail', ['fact_failed'], lines, constraints);
  if (escalated) return validationDecision('escalate', ['low_confidence'], lines, constraints);
  if (escaped) return validationDecision('escape', ['evidence_missing'], lines, constraints);
  return validationDecision('done', [], lines, constraints);
}

export function replayValidation(record: ValidationRecord): ValidationDecision {
  return decideValidation(record);
}

export async function judgeCriteria(
  proposed: readonly unknown[],
  call: JudgmentCall,
): Promise<CriteriaRecord> {
  const policy = policyOf(call.policy);
  const lines = lexicalEntries(proposed);
  const admitted = admittedOf(lines);
  if (admitted.length === 0) return criteriaRecord(policy, lines, null, null);
  const state = criteriaState(admitted);
  const questions = criteriaQuestions(admitted);
  const outcome = await call.gateway.evaluate({
    request_id: call.request_id,
    site: TASK_CRITERIA_SITE,
    role: 'working',
    kind: 'boolean',
    state,
    questions,
    terms: call.terms,
  });
  const reduced = reduceOutcome(outcome, Object.keys(questions));
  return criteriaRecord(policy, lines, reduced.answers, reduced.malformed);
}

export async function judgeValidation(
  admitted: readonly AcceptanceLine[],
  artifacts: readonly ArtifactBody[],
  commands: readonly CommandRecord[],
  declaration: TaskConstraintDeclaration,
  call: JudgmentCall,
  writeUp?: string,
): Promise<ValidationRecord> {
  const policy = policyOf(call.policy);
  const facts = factsFor(admitted, artifacts, commands);
  const shown = facts.filter((fact) => fact.evidence !== null);
  if (shown.length === 0) return validationRecord(policy, facts, commands, declaration, null, null, writeUp);
  const state = validationState(shown);
  const questions = validationQuestions(shown);
  const outcome = await call.gateway.evaluate({
    request_id: call.request_id,
    site: TASK_VALIDATE_SITE,
    role: 'working',
    kind: 'boolean',
    state,
    questions,
    terms: call.terms,
  });
  const reduced = reduceOutcome(outcome, Object.keys(questions));
  return validationRecord(policy, facts, commands, declaration, reduced.answers, reduced.malformed, writeUp);
}

export function taskJevRoute(adapter: string, destination: string): RoutedUnit {
  if (adapter.trim().length === 0 || destination.trim().length === 0) {
    throw new Error('taskJevRoute requires an adapter and a destination');
  }
  return {
    routed_unit_id: 'boolean.task@jev-1.13.0',
    operation: 'evaluate',
    kind: 'boolean',
    context_profile: 'profile.task-acceptance',
    context_profile_version: 1,
    prompt_template: 'template.task-acceptance.boolean',
    prompt_template_version: 1,
    adapter,
    model: TASK_JEV_MODEL_ID,
    settings: { max_output_tokens: 256 },
    destination,
    quality: 'baseline',
    context_limit_tokens: 128_000,
    // Same input price the weigh example records for Jev. Output is unused.
    price: { input_per_mtok: 42_000, output_per_mtok: 0 },
  };
}

export function hardConstraints(
  commands: readonly CommandRecord[],
  declaration: TaskConstraintDeclaration,
): readonly HardConstraintFailure[] {
  const constraints = new Set(declaration.constraints);
  const authority = new Set(declaration.authority);
  const failures: HardConstraintFailure[] = [];
  for (const command of commands) {
    const effect = commandEffect(command.argv);
    if (effect === 'send' && constraints.has('do_not_send') && !authority.has('send')) {
      failures.push({ code: 'do_not_send', command_id: command.command_id });
    } else if (effect === 'delete' && constraints.has('do_not_delete') && !authority.has('delete')) {
      failures.push({ code: 'do_not_delete', command_id: command.command_id });
    } else if (effect === 'consequential' && constraints.has('ask_before_effect') && !command.asked) {
      failures.push({ code: 'ask_before_effect', command_id: command.command_id });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function criteriaRecord(
  policy: TaskJudgmentPolicy,
  lines: readonly LexicalEntry[],
  answers: Readonly<Record<string, NoulAnswerRecord>> | null,
  malformed: string | null,
): CriteriaRecord {
  const admitted = admittedOf(lines);
  const requested = admitted.length > 0 && answers !== null;
  return {
    contract: ACCEPTANCE_LINE_CONTRACT,
    site: TASK_CRITERIA_SITE,
    model: policy.model,
    probability_threshold: policy.probability_threshold,
    confidence_floor: policy.confidence_floor,
    lines,
    state: requested ? criteriaState(admitted) : null,
    requested,
    malformed,
    answers: answers ?? {},
  };
}

function validationRecord(
  policy: TaskJudgmentPolicy,
  facts: readonly ValidationFact[],
  commands: readonly CommandRecord[],
  declaration: TaskConstraintDeclaration,
  answers: Readonly<Record<string, NoulAnswerRecord>> | null,
  malformed: string | null,
  writeUp: string | undefined,
): ValidationRecord {
  void writeUp;
  const shown = facts.filter((fact) => fact.evidence !== null);
  const requested = shown.length > 0 && answers !== null;
  return {
    contract: ACCEPTANCE_LINE_CONTRACT,
    site: TASK_VALIDATE_SITE,
    model: policy.model,
    probability_threshold: policy.probability_threshold,
    confidence_floor: policy.confidence_floor,
    facts,
    state: requested ? validationState(shown) : null,
    requested,
    malformed,
    answers: answers ?? {},
    commands,
    declaration,
    write_up_ignored: true,
  };
}

function factsFor(
  admitted: readonly AcceptanceLine[],
  artifacts: readonly ArtifactBody[],
  commands: readonly CommandRecord[],
): readonly ValidationFact[] {
  return admitted.map((line) => ({
    line_id: line.line_id,
    fact: line.fact,
    evidence: lookupBody(line, artifacts, commands),
  }));
}

function lookupBody(
  line: AcceptanceLine,
  artifacts: readonly ArtifactBody[],
  commands: readonly CommandRecord[],
): ValidationFact['evidence'] {
  const evidence = line.evidence;
  if (evidence.kind === 'artifact') {
    const artifactId = evidence.artifact_id;
    const found = artifacts.find((item) => item.artifact_id === artifactId);
    if (found === undefined) return null;
    return { kind: 'artifact', id: found.artifact_id, body: found.body };
  }
  const commandId = evidence.command_id;
  const found = commands.find((item) => item.command_id === commandId);
  if (found === undefined) return null;
  return { kind: 'command', id: found.command_id, body: found.output };
}

function reduceOutcome(
  outcome: EvaluationOutcome<'boolean'>,
  questionIds: readonly string[],
): { readonly malformed: string | null; readonly answers: Readonly<Record<string, NoulAnswerRecord>> } {
  if (outcome.status !== 'accepted') {
    return { malformed: outcome.reason, answers: {} };
  }
  const attempt = outcome.attempts.find((item) => item.disposition.status === 'accepted');
  if (attempt === undefined || attempt.model !== TASK_JEV_MODEL_ID) {
    return { malformed: 'unpinned_model', answers: {} };
  }
  for (const id of Object.keys(outcome.answers)) {
    if (!questionIds.includes(id)) return { malformed: `unasked:${id}`, answers: {} };
  }
  const answers: Record<string, NoulAnswerRecord> = {};
  for (const id of questionIds) {
    const answer = outcome.answers[id];
    if (answer === undefined || answer.type !== 'boolean' || !inUnit(answer.probability)) {
      return { malformed: `unanswered:${id}`, answers: {} };
    }
    const raw = outcome.confidence?.[id];
    if (raw === undefined) {
      answers[id] = { probability: answer.probability, confidence: null };
      continue;
    }
    if (!inUnit(raw)) return { malformed: `confidence:${id}`, answers: {} };
    answers[id] = { probability: answer.probability, confidence: raw };
  }
  return { malformed: null, answers };
}

function validationDecision(
  disposition: ValidationDisposition,
  reasons: readonly string[],
  lines: readonly FactVerdict[],
  hard_constraints: readonly HardConstraintFailure[],
): ValidationDecision {
  return {
    done: disposition === 'done',
    disposition,
    reasons,
    lines,
    hard_constraints,
    write_up_ignored: true,
  };
}

function escalateAsked(record: CriteriaRecord, reason: string): CriteriaLineDecision[] {
  return record.lines.map((entry) => {
    if (entry.lexical.status === 'rejected') {
      return { line_id: entry.line_id, status: 'rejected' as const, reason: entry.lexical.reason };
    }
    return { line_id: entry.lexical.line.line_id, status: 'escalate' as const, reason };
  });
}

function commandEffect(argv: readonly string[]): 'send' | 'delete' | 'consequential' | null {
  const bin = basename(argv[0] ?? '').toLowerCase();
  const sub = (argv[1] ?? '').toLowerCase();
  if ((bin === 'git' && sub === 'push') || (bin === 'npm' && sub === 'publish') || bin === 'send' || bin === 'mail') {
    return 'send';
  }
  if ((bin === 'git' && (sub === 'rm' || sub === 'clean')) || bin === 'rm' || bin === 'rmdir' || bin === 'unlink') {
    return 'delete';
  }
  if ((bin === 'git' && sub === 'commit') || bin === 'mv' || bin === 'mkdir' || bin === 'patch' || bin === 'apply') {
    return 'consequential';
  }
  return null;
}

function basename(command: string): string {
  const parts = command.split(/[/\\]/);
  return parts[parts.length - 1] ?? command;
}

function inUnit(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function inOpenUnit(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
