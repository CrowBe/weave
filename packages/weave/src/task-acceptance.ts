/**
 * Acceptance facts and task validation.
 *
 * An LLM may propose acceptance lines. Code admits only a single observable
 * fact. Admitted free-text facts become one boolean question each — a Noul on
 * the System One wire. The criteria gate (`task.criteria`) runs before the
 * work. Task validation (`task.validate`) asks every remaining Noul in one
 * evaluation request. Code decides done.
 *
 * `acceptance.line@2` adds a closed predicate. A predicate line establishes
 * only its literal property: an exact exit status, or an exact literal in an
 * artifact body or command output. Code renders its fact text, checks that the
 * predicate fits the evidence kind instead of asking the criteria gate, and
 * decides it from the recorded evidence instead of asking task validation.
 * There is no regex and no arithmetic. Records written under
 * `acceptance.line@1` replay under the rules they were written with.
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
import type { BooleanQuestion, EvaluationOutcome, InferenceGateway, InferenceTerms, RoutedUnit } from '@weave/gateway';

export const ACCEPTANCE_LINE_CONTRACT = 'acceptance.line@2' as const;
/** The contract before predicates. Its records still replay; nothing new is written under it. */
export const ACCEPTANCE_LINE_CONTRACT_V1 = 'acceptance.line@1' as const;
export type AcceptanceContract = typeof ACCEPTANCE_LINE_CONTRACT | typeof ACCEPTANCE_LINE_CONTRACT_V1;
/** Closed. Adding a predicate is a contract revision. */
export const ACCEPTANCE_PREDICATES = ['exit_status', 'contains_literal'] as const;
export const TASK_CRITERIA_SITE = 'task.criteria' as const;
export const TASK_VALIDATE_SITE = 'task.validate' as const;

/**
 * Pinned model id. The direct default is now `jev-preview` and the Vercel
 * route uses `typesafe-ai/jev`; task acceptance retains its fixture pin.
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
  criteria_state: 'the proposed free-text line only: fact, evidence identity, and escape',
  validation_state:
    'the admitted free-text fact plus the body of its named artifact or the output of its named command',
  omitted_from_state: [
    'write_up',
    'task prose',
    'unreferenced artifacts',
    'unreferenced commands',
    'exit status',
    'predicate lines',
  ],
  predicates: ACCEPTANCE_PREDICATES,
  predicate_rule:
    'code renders the fact, admits the predicate only on a fitting evidence kind, and decides it from the recorded evidence; no Noul is asked',
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

/**
 * A closed property code can decide from named evidence. `exit_status` needs
 * command evidence. `contains_literal` is an exact substring of an artifact
 * body or a command output: case, whitespace and quotes all count.
 */
export type AcceptancePredicate =
  | { readonly kind: 'exit_status'; readonly equals: number }
  | { readonly kind: 'contains_literal'; readonly literal: string };

export interface AcceptanceLine {
  readonly line_id: string;
  /** Free text, or for a predicate line the text code rendered from the predicate. */
  readonly fact: string;
  readonly evidence: EvidenceRef;
  readonly escape: string;
  /** `acceptance.line@2`. Code decides this line and no Noul is asked. */
  readonly predicate?: AcceptancePredicate;
}

/** A line as proposed: a free-text fact or a predicate, never both. */
export type ProposedLine =
  | Omit<AcceptanceLine, 'predicate'>
  | (Omit<AcceptanceLine, 'fact' | 'predicate'> & { readonly predicate: AcceptancePredicate });

export interface ArtifactBody {
  readonly artifact_id: string;
  readonly body: string;
}

export interface CommandRecord {
  readonly command_id: string;
  readonly argv: readonly string[];
  readonly output: string;
  readonly asked: boolean;
  /**
   * Exit status. Null when the process ended without one. Absent when it was
   * not recorded, as on every `acceptance.line@1` record. Either way an
   * `exit_status` predicate cannot be shown and escapes.
   */
  readonly exit?: number | null;
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
  readonly lexical:
    | { readonly status: 'admitted'; readonly line: AcceptanceLine }
    | { readonly status: 'rejected'; readonly reason: string };
}

export interface CriteriaRecord {
  readonly contract: AcceptanceContract;
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

type FactEvidence =
  | { readonly kind: 'artifact'; readonly id: string; readonly body: string }
  | { readonly kind: 'command'; readonly id: string; readonly body: string; readonly exit?: number | null };

interface ValidationFact {
  readonly line_id: string;
  readonly fact: string;
  readonly evidence: FactEvidence | null;
  /** `acceptance.line@2`. Absent on an `@1` record, where every fact was a Noul. */
  readonly decided_by?: 'code' | 'noul';
  /** Present when code decides the fact. */
  readonly predicate?: AcceptancePredicate;
}

export interface ValidationRecord {
  readonly contract: AcceptanceContract;
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
  // The predicate is closed and its kind was checked against the evidence.
  // Its rendered text carries the literal, so it is not read for vague words.
  if (parsed.line.predicate !== undefined) return parsed;
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
  if ('predicate' in raw) {
    if (fact !== undefined) return { status: 'rejected', reason: 'fact_with_predicate', line_id };
  } else if (typeof fact !== 'string' || fact.trim().length === 0) {
    return { status: 'rejected', reason: 'empty_fact', line_id };
  }
  if (typeof escape !== 'string' || escape.trim().length === 0) {
    return { status: 'rejected', reason: 'missing_escape', line_id };
  }
  if (evidence === null) return { status: 'rejected', reason: 'missing_evidence', line_id };
  if (!('predicate' in raw)) {
    return { status: 'admitted', line: { line_id, fact: (fact as string).trim(), evidence, escape: escape.trim() } };
  }
  const predicate = parsePredicate(raw['predicate']);
  if (typeof predicate === 'string') return { status: 'rejected', reason: predicate, line_id };
  if (!predicateFits(evidence, predicate))
    return { status: 'rejected', reason: 'predicate_evidence_mismatch', line_id };
  return {
    status: 'admitted',
    line: { line_id, fact: renderFact(evidence, predicate), evidence, escape: escape.trim(), predicate },
  };
}

/**
 * Closed shapes only. Returns the rejection reason for anything else.
 * Admission, replay and the frozen-set loader all read a predicate through
 * this one parser, so a recorded shape is never trusted (#246).
 */
export function parsePredicate(raw: unknown): AcceptancePredicate | 'unknown_predicate' | 'invalid_predicate' {
  if (!isRecord(raw) || typeof raw['kind'] !== 'string') return 'invalid_predicate';
  const keys = Object.keys(raw).sort().join(',');
  if (raw['kind'] === 'exit_status') {
    const equals = raw['equals'];
    if (keys !== 'equals,kind' || typeof equals !== 'number' || !Number.isSafeInteger(equals))
      return 'invalid_predicate';
    return { kind: 'exit_status', equals };
  }
  if (raw['kind'] === 'contains_literal') {
    const literal = raw['literal'];
    if (keys !== 'kind,literal' || typeof literal !== 'string' || literal.length === 0) return 'invalid_predicate';
    return { kind: 'contains_literal', literal };
  }
  return 'unknown_predicate';
}

function predicateFits(evidence: EvidenceRef | FactEvidence, predicate: AcceptancePredicate): boolean {
  return predicate.kind === 'contains_literal' || evidence.kind === 'command';
}

/** Code writes the fact text, so the text and the predicate cannot disagree. */
function renderFact(evidence: EvidenceRef, predicate: AcceptancePredicate): string {
  if (predicate.kind === 'exit_status') {
    const id = evidence.kind === 'command' ? evidence.command_id : evidence.artifact_id;
    return `the exit status of command ${JSON.stringify(id)} is ${predicate.equals}`;
  }
  const literal = JSON.stringify(predicate.literal);
  if (evidence.kind === 'artifact')
    return `artifact ${JSON.stringify(evidence.artifact_id)} contains the literal ${literal}`;
  return `the output of command ${JSON.stringify(evidence.command_id)} contains the literal ${literal}`;
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
    // The exit status stays out: a free-text fact is asked as it was under @1.
    const { kind, id, body: shown } = fact.evidence;
    body[fact.line_id] = { fact: fact.fact, evidence: { kind, id, body: shown } };
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

/** Free-text lines. Only these reach the criteria gate. */
function askedOf(admitted: readonly AcceptanceLine[]): AcceptanceLine[] {
  return admitted.filter((line) => line.predicate === undefined);
}

/** Free-text facts with evidence. Only these reach task validation. */
function shownOf(facts: readonly ValidationFact[]): ValidationFact[] {
  return facts.filter((fact) => fact.decided_by === 'noul' && fact.evidence !== null);
}

function knownContract(contract: unknown): contract is AcceptanceContract {
  return contract === ACCEPTANCE_LINE_CONTRACT || contract === ACCEPTANCE_LINE_CONTRACT_V1;
}

/** Only an `@2` record has predicate lines. An `@1` record replays as it was written. */
function inCode(contract: AcceptanceContract, item: { readonly predicate?: AcceptancePredicate }): boolean {
  return contract === ACCEPTANCE_LINE_CONTRACT && item.predicate !== undefined;
}

export function criteriaFromFixture(
  proposed: readonly unknown[],
  fixture: NoulFixture,
  policy?: TaskJudgmentPolicy,
): CriteriaRecord {
  const resolved = policyOf(policy);
  const lines = lexicalEntries(proposed);
  const asked = askedOf(admittedOf(lines));
  if (asked.length === 0) return criteriaRecord(resolved, lines, null, null);
  const answers: Record<string, NoulAnswerRecord> = {};
  for (const line of asked) {
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
  const shown = shownOf(facts);
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
  if (!knownContract(record.contract)) {
    return { entered: [], lines: escalateAsked(record, 'unknown_contract'), malformed: 'unknown_contract' };
  }
  if (record.model !== TASK_JEV_MODEL_ID) {
    return { entered: [], lines: escalateAsked(record, 'unpinned_model'), malformed: 'unpinned_model' };
  }
  if (record.malformed !== null) {
    return { entered: [], lines: escalateAsked(record, record.malformed), malformed: record.malformed };
  }
  for (const entry of record.lines) {
    if (entry.lexical.status !== 'admitted' || inCode(record.contract, entry.lexical.line)) continue;
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
    if (line.predicate !== undefined && inCode(record.contract, line)) {
      // Code checked the shape and the fit at admission. Replay checks both
      // again rather than trust the record (#246).
      const predicate = parsePredicate(line.predicate);
      if (typeof predicate === 'string') {
        decisions.push({ line_id: line.line_id, status: 'rejected', reason: predicate });
      } else if (predicateFits(line.evidence, predicate)) {
        decisions.push({ line_id: line.line_id, status: 'admitted', reason: 'predicate' });
        entered.push(line);
      } else {
        decisions.push({ line_id: line.line_id, status: 'rejected', reason: 'predicate_evidence_mismatch' });
      }
      continue;
    }
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
  if (!knownContract(record.contract)) {
    return validationDecision('malformed', ['unknown_contract'], [], constraints);
  }
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
    if (fact.decided_by === 'code' && record.contract === ACCEPTANCE_LINE_CONTRACT) {
      const verdict = predicateVerdict(fact.predicate, fact.evidence);
      if (verdict === null) return validationDecision('malformed', [`predicate:${fact.line_id}`], lines, constraints);
      if (verdict === 'fail') failed = true;
      if (verdict === 'escape') escaped = true;
      lines.push({ line_id: fact.line_id, status: verdict });
      continue;
    }
    const answer = record.answers[fact.line_id];
    if (
      answer === undefined ||
      !inUnit(answer.probability) ||
      (answer.confidence !== null && !inUnit(answer.confidence))
    ) {
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

/**
 * Exact comparison on recorded evidence. A missing exit status escapes. A
 * predicate that is absent, outside the closed shapes, or does not fit its
 * evidence is malformed (null): replay re-validates the shape (#246).
 */
function predicateVerdict(
  recorded: AcceptancePredicate | undefined,
  evidence: FactEvidence,
): 'pass' | 'fail' | 'escape' | null {
  const predicate = parsePredicate(recorded);
  if (typeof predicate === 'string' || !predicateFits(evidence, predicate)) return null;
  if (predicate.kind === 'contains_literal') return evidence.body.includes(predicate.literal) ? 'pass' : 'fail';
  const exit = evidence.kind === 'command' ? evidence.exit : undefined;
  if (typeof exit !== 'number' || !Number.isSafeInteger(exit)) return 'escape';
  return exit === predicate.equals ? 'pass' : 'fail';
}

export async function judgeCriteria(proposed: readonly unknown[], call: JudgmentCall): Promise<CriteriaRecord> {
  const policy = policyOf(call.policy);
  const lines = lexicalEntries(proposed);
  const asked = askedOf(admittedOf(lines));
  if (asked.length === 0) return criteriaRecord(policy, lines, null, null);
  const state = criteriaState(asked);
  const questions = criteriaQuestions(asked);
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
  const shown = shownOf(facts);
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
    billing: 'metered',
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
  const asked = askedOf(admittedOf(lines));
  const requested = asked.length > 0 && answers !== null;
  return {
    contract: ACCEPTANCE_LINE_CONTRACT,
    site: TASK_CRITERIA_SITE,
    model: policy.model,
    probability_threshold: policy.probability_threshold,
    confidence_floor: policy.confidence_floor,
    lines,
    state: requested ? criteriaState(asked) : null,
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
  const shown = shownOf(facts);
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
  return admitted.map((line) => {
    const evidence = lookupBody(line, artifacts, commands);
    const predicate = line.predicate;
    if (predicate === undefined) return { line_id: line.line_id, fact: line.fact, evidence, decided_by: 'noul' };
    if (!predicateFits(line.evidence, predicate)) {
      throw new Error(`predicate does not fit the evidence kind of ${line.line_id}`);
    }
    return {
      line_id: line.line_id,
      fact: renderFact(line.evidence, predicate),
      evidence,
      decided_by: 'code',
      predicate,
    };
  });
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
  return { kind: 'command', id: found.command_id, body: found.output, exit: found.exit ?? null };
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
