/**
 * Recurring judgment findings become capability gap records (#203). Record only.
 *
 * Judgment finds a failure; a deterministic check should enforce it afterwards.
 * When D5 or the audit catches the same finding in N executions, with N
 * declared before the findings are read, this module records a capability gap
 * for a check capability that cites those executions. The record is data. It
 * grants nothing, and no code here generates, admits, or runs anything. The
 * only route into crystallization is an operator goal carrying the record's
 * desired operation as its `gap`, which starts at the gap search and passes
 * every existing gate: contract, corpus, demonstrated red, proven green and
 * admission. The audit keeps running however many checks are admitted.
 *
 * Assumptions the repository cannot verify:
 * - The caller supplies a check-relevant evidence reference that is stable
 *   across executions, such as a host resource reference. A reference that
 *   contains the execution id is treated as scoped to that execution.
 * - Coverage counts a finding as covered when a check admitted for its gap
 *   exists at report time. It does not order the admission against the finding.
 */
import type { AuditFinding, AuditRound } from './audit-loop.js';
import { digest } from './digest.js';
import type { ImplementEval } from './implement-step.js';
import type { AuditDisposition } from './sites/audit-dispose.js';
import { correlation, unit } from './sites/index.js';
import { OUTPUT_EVAL_POLICY } from './sites/output-eval.js';

export const RECURRENCE_KEY_SCHEMA = 'judgment.recurrence@1' as const;
export const CHECK_GAP_SCHEMA = 'capability_gap.check@1' as const;
export const CHECK_COVERAGE_SCHEMA = 'judgment.check_coverage@1' as const;

export interface RecurrencePolicy {
  readonly schema: typeof RECURRENCE_KEY_SCHEMA;
  /** Distinct executions a recurrence key must appear in. An integer from 2 to 100. */
  readonly executions: number;
}

/** Declared before any finding is read. Two executions is the smallest recurrence. */
export const DECLARED_RECURRENCE_POLICY: RecurrencePolicy = Object.freeze({
  schema: RECURRENCE_KEY_SCHEMA,
  executions: 2,
});

export type JudgmentFindingKind = 'criterion_failed' | AuditFinding['kind'];

/** A failure judgment caught, reduced to the fields a check could act on. No free text. */
export interface JudgmentFinding {
  readonly site: 'eval.output' | 'audit.generate';
  /** Where it was caught. Cited by a gap record, never part of the key. */
  readonly execution_id: string;
  readonly kind: JudgmentFindingKind;
  readonly criterion_id: string | null;
  /** Check-relevant evidence: a reference stable across executions. */
  readonly evidence_ref: string;
}

export interface CheckGapRecord {
  readonly schema: typeof CHECK_GAP_SCHEMA;
  readonly gap_id: string;
  readonly recurrence_key: string;
  readonly policy: RecurrencePolicy;
  readonly finding: Omit<JudgmentFinding, 'execution_id'>;
  /** Every execution that caught the finding, sorted. */
  readonly cites: readonly { readonly execution_id: string }[];
  /**
   * The desired check operation, shaped as a goal `gap`. A proposal for the
   * gap search, not a contract and not proof that no capability exists.
   */
  readonly desired: {
    readonly operation: string;
    readonly purpose: string;
    readonly input: Readonly<Record<string, string>>;
    readonly output: Readonly<Record<string, string>>;
  };
}

export interface CheckCoverage {
  readonly schema: typeof CHECK_COVERAGE_SCHEMA;
  /** Distinct findings per execution. */
  readonly caught: number;
  /** Of those, findings whose gap names an admitted operation. */
  readonly covered: number;
  readonly share: number | null;
}

const AUDIT_KINDS: readonly AuditFinding['kind'][] = ['gap', 'defect', 'regression', 'scope_creep'];
const FIX_NOW: AuditDisposition = 'fix_now';
const SEGMENT_SEPARATOR = /[_.:-]/;

/** True when the execution id occupies whole segments of the evidence reference, not part of a longer segment. */
function namesExecution(evidence: string, execution: string): boolean {
  for (let at = evidence.indexOf(execution); at !== -1; at = evidence.indexOf(execution, at + 1)) {
    const before = evidence[at - 1];
    const after = evidence[at + execution.length];
    if (
      (before === undefined || SEGMENT_SEPARATOR.test(before)) &&
      (after === undefined || SEGMENT_SEPARATOR.test(after))
    ) {
      return true;
    }
  }
  return false;
}

function checkOperation(kind: JudgmentFindingKind, key: string): string {
  return `check.${kind}.${key.slice(3, 19)}`;
}

/**
 * Stable across executions: kind, criterion and check-relevant evidence. The
 * execution id, any proposed fix, and any other free text are not inputs. Null
 * when the finding cannot recur: an unsafe reference, a kind its site does not
 * produce, or evidence that names its own execution as whole segments.
 */
export function recurrenceKey(finding: JudgmentFinding): string | null {
  const execution = correlation(finding.execution_id);
  const evidence = correlation(finding.evidence_ref);
  if (execution === null || evidence === null) return null;
  if (finding.criterion_id !== null && correlation(finding.criterion_id) === null) return null;
  const known =
    finding.site === 'eval.output'
      ? finding.kind === 'criterion_failed'
      : finding.site === 'audit.generate' && (AUDIT_KINDS as readonly string[]).includes(finding.kind);
  if (!known || namesExecution(evidence, execution)) return null;
  const { kind, criterion_id } = finding;
  return `rk_${digest({ schema: RECURRENCE_KEY_SCHEMA, kind, criterion_id, evidence_ref: evidence }).slice(0, 32)}`;
}

export function recordCheckGaps(
  findings: readonly JudgmentFinding[],
  policy: RecurrencePolicy = DECLARED_RECURRENCE_POLICY,
): readonly CheckGapRecord[] {
  if (
    policy.schema !== RECURRENCE_KEY_SCHEMA ||
    !Number.isSafeInteger(policy.executions) ||
    policy.executions < 2 ||
    policy.executions > 100
  ) {
    throw new Error('recurrence policy must declare 2 to 100 executions before findings are read');
  }
  const byKey = new Map<string, { readonly finding: JudgmentFinding; readonly executions: Set<string> }>();
  for (const finding of findings) {
    const key = recurrenceKey(finding);
    if (key === null) continue;
    const entry = byKey.get(key) ?? { finding, executions: new Set<string>() };
    entry.executions.add(finding.execution_id);
    byKey.set(key, entry);
  }
  const gaps: CheckGapRecord[] = [];
  for (const [key, { finding, executions }] of byKey) {
    if (executions.size < policy.executions) continue;
    const { site, kind, criterion_id, evidence_ref } = finding;
    gaps.push({
      schema: CHECK_GAP_SCHEMA,
      gap_id: `gap_${key.slice(3)}`,
      recurrence_key: key,
      policy: { schema: policy.schema, executions: policy.executions },
      finding: { site, kind, criterion_id, evidence_ref },
      cites: [...executions].sort().map((execution_id) => ({ execution_id })),
      desired: {
        operation: checkOperation(kind, key),
        purpose:
          `Decide in code the recurring ${kind} judgment finding` +
          `${criterion_id === null ? '' : ` for criterion ${criterion_id}`} on evidence ${evidence_ref}`,
        input: { evidence: 'ResourceRef' },
        output: { passed: 'boolean' },
      },
    });
  }
  return gaps.sort((a, b) => (a.gap_id < b.gap_id ? -1 : a.gap_id > b.gap_id ? 1 : 0));
}

/** Findings the audit disposed `fix_now`. Deferred, rejected and unanswered findings are not caught failures. */
export function auditJudgmentFindings(round: AuditRound): readonly JudgmentFinding[] {
  const findings = round.report?.findings ?? [];
  const choices = round.disposal?.choices ?? [];
  return findings.flatMap((finding, index) =>
    choices[index] === FIX_NOW
      ? [
          {
            site: 'audit.generate' as const,
            execution_id: round.execution_id,
            kind: finding.kind,
            criterion_id: finding.criterion_id,
            evidence_ref: finding.evidence_ref,
          },
        ]
      : [],
  );
}

/**
 * D5 failures: a criterion verdict at or above the confidence floor and below
 * the probability threshold. Both statistics must be finite numbers in [0, 1].
 * Malformed statistics, low confidence and outages are not caught failures.
 * The caller names the evidence D5 judged.
 */
export function outputEvalJudgmentFindings(
  attempt: { readonly execution_id: string; readonly evals: readonly ImplementEval[] },
  evidence_ref: string,
): readonly JudgmentFinding[] {
  return attempt.evals.flatMap((item) =>
    !item.passed &&
    unit(item.confidence) &&
    item.confidence >= OUTPUT_EVAL_POLICY.confidence &&
    unit(item.verdict_probability) &&
    item.verdict_probability < OUTPUT_EVAL_POLICY.probability
      ? [
          {
            site: 'eval.output' as const,
            execution_id: attempt.execution_id,
            kind: 'criterion_failed' as const,
            criterion_id: item.criterion_id,
            evidence_ref,
          },
        ]
      : [],
  );
}

/**
 * Share of judgment-caught failures that an admitted check covers. A failure
 * is one finding per execution. It is covered only when a gap record holds its
 * recurrence key and the check operation derived from that key is among the
 * admitted operations. A gap's own `desired.operation` is never read, so a
 * forged gap cannot link a finding to an unrelated admitted operation. A gap
 * record alone covers nothing.
 */
export function checkCoverage(
  findings: readonly JudgmentFinding[],
  gaps: readonly CheckGapRecord[],
  admitted_operations: readonly string[],
): CheckCoverage {
  const admitted = new Set(admitted_operations);
  const recorded = new Set(gaps.map((gap) => gap.recurrence_key));
  const caught = new Map<string, boolean>();
  for (const finding of findings) {
    const { execution_id, kind, criterion_id, evidence_ref } = finding;
    const key = recurrenceKey(finding);
    caught.set(
      digest({ execution_id, kind, criterion_id, evidence_ref }),
      key !== null && recorded.has(key) && admitted.has(checkOperation(kind, key)),
    );
  }
  const covered = [...caught.values()].filter(Boolean).length;
  return {
    schema: CHECK_COVERAGE_SCHEMA,
    caught: caught.size,
    covered,
    share: caught.size === 0 ? null : covered / caught.size,
  };
}
