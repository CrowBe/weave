/**
 * Types for Gauge's evaluation records (GAUGE-CONTRACT.md). They describe the
 * shape a valid record has; `validate` is the only thing that establishes it,
 * including every recomputed status and verdict.
 */
import type { Disposition, Kind, Link } from '@weave/weft';

export interface Governance {
  readonly kind: 'policy' | 'approval';
  readonly ref: string;
}

export type Interval = readonly [lo: number, hi: number];
export type Split = 'tune' | 'holdout';
export type Aggregate = 'rate' | 'mean' | 'sum' | 'p95';
export type Better = 'higher' | 'lower';

export type MeasureSource =
  | { readonly weft_kind: Kind; readonly field: string }
  | { readonly evidence: 'check' | 'held_out_report' };

export interface MeasureDefinition {
  readonly measure: string;
  readonly source: MeasureSource;
  readonly aggregate: Aggregate;
  readonly better: Better;
  readonly min_effect: number;
}

export interface ConstraintDefinition {
  readonly constraint: string;
  readonly measure: string;
  readonly op: 'ge' | 'le';
  readonly bound: number;
  readonly role: 'quality_bar' | 'protected';
}

export interface CriteriaSet {
  readonly schema: 'gauge.criteria@1';
  readonly criteria: string;
  readonly workload: string;
  readonly governed_by: Governance;
  readonly method: {
    readonly interval: 'wilson@1' | 'bootstrap@1';
    readonly level: number;
    readonly seed: number;
    readonly min_samples: number;
  };
  readonly measures: readonly MeasureDefinition[];
  readonly constraints: readonly ConstraintDefinition[];
}

export interface CaseSet {
  readonly schema: 'gauge.caseset@1';
  readonly caseset: string;
  readonly workload: string;
  readonly governed_by: Governance;
  readonly splits: readonly { readonly split: Split; readonly digest: string; readonly size: number }[];
}

/**
 * The recorded change that makes one revision of a criteria set or case set
 * usable. Only the governor of the set it supersedes may issue it.
 */
export interface Revision {
  readonly schema: 'gauge.revision@1';
  readonly revision: string;
  readonly record: 'criteria' | 'caseset';
  readonly digest: string;
  readonly supersedes: string | null;
  readonly issued_by: Governance;
  readonly justification: string;
  readonly evidence: readonly EvidenceRef[];
}

export interface EvidenceRef {
  readonly source: 'weft_trace' | 'check' | 'held_out_report' | 'observation';
  readonly ref: string;
}

export type ConstraintStatus = 'held' | 'violated' | 'unknown';
export type ResultVerdict = 'meets_bar' | 'misses_bar' | 'insufficient_evidence';

export interface EvaluationResult {
  readonly schema: 'gauge.result@1';
  readonly result: string;
  readonly subject: {
    readonly kind: 'implementation' | 'routed_unit' | 'policy' | 'operating_strategy';
    readonly ref: string;
  };
  readonly criteria: string;
  readonly caseset: string;
  readonly split: Split;
  readonly caseset_digest: string;
  readonly mode: 'replay' | 'trial' | 'live';
  readonly evidence: readonly EvidenceRef[];
  readonly measures: readonly {
    readonly measure: string;
    readonly value: number | null;
    readonly n: number;
    readonly interval: Interval | null;
  }[];
  readonly constraints: readonly { readonly constraint: string; readonly status: ConstraintStatus }[];
  readonly verdict: ResultVerdict;
}

export type ComparisonVerdict =
  | 'candidate_better'
  | 'no_difference'
  | 'candidate_worse'
  | 'bar_missed'
  | 'insufficient_evidence';

export interface Comparison {
  readonly schema: 'gauge.comparison@1';
  readonly comparison: string;
  readonly experiment: string | null;
  readonly baseline: string;
  readonly candidate: string;
  readonly deltas: readonly {
    readonly measure: string;
    readonly delta: number | null;
    readonly interval: Interval | null;
  }[];
  readonly verdict: ComparisonVerdict;
}

export type AttributionCategory = 'capability_gap' | 'implementation' | 'routing' | 'orchestration' | 'unattributed';

export interface FailureAttribution {
  readonly schema: 'gauge.attribution@1';
  readonly attribution: string;
  readonly result: string;
  readonly case: string;
  readonly category: AttributionCategory;
  readonly basis: 'deterministic' | 'judgment' | 'none';
  readonly signal: string | null;
  readonly confidence: number | null;
  readonly evidence: readonly EvidenceRef[];
}

/**
 * The conceptual category set. It maps to the existing wire values in
 * `AttributionCategory`: `capability` becomes `capability_gap`; every other
 * name is identical. `gauge.attribution@1` is unchanged.
 */
export type ConceptualAttributionCategory =
  | 'capability'
  | 'implementation'
  | 'routing'
  | 'orchestration'
  | 'unattributed';

/** The wire value for a conceptual category. Never accept a second spelling on the wire. */
export type WireAttributionCategory<C extends ConceptualAttributionCategory> =
  C extends 'capability' ? 'capability_gap' : C;

/** The closed deterministic signal for each attributed wire category. */
export interface DeterministicSignals {
  readonly capability_gap: 'no_contract_matched';
  readonly implementation: 'contract_tests_failed' | 'effect_violation' | 'implementation_failed';
  readonly routing: 'better_route_excluded' | 'wrong_contract_selected';
  readonly orchestration: 'dependency_failed' | 'schedule_conflict' | 'budget_exhausted' | 'superseded';
}

export type DeterministicSignal = DeterministicSignals[keyof DeterministicSignals];
export type DeterministicSignalFor<C extends keyof DeterministicSignals> = DeterministicSignals[C];

/**
 * One immutable Weft record resolved from an `EvidenceRef` of source
 * `weft_trace`. It names the exact record and content digest in the frozen
 * snapshot, not merely the run it belongs to.
 */
export interface WeftEvidenceFact {
  readonly source: 'weft_trace';
  readonly ref: string;
  readonly trace_id: string;
  readonly record_id: string;
  readonly kind: Kind;
  readonly digest: string;
  readonly parent_id: string | null;
  readonly links: readonly Link[];
  readonly fields: Readonly<Record<string, unknown>>;
}

/** One check receipt bound to the case, revisions, invocation and producing attempt. */
export interface CheckEvidenceFact {
  readonly source: 'check';
  readonly ref: string;
  readonly case: string;
  readonly contract_revision: string;
  readonly implementation_revision: string;
  readonly invocation: string;
  readonly check_revision: string;
  readonly attempt: string;
  readonly passed: boolean;
  readonly exit_code: number | null;
  readonly digest: string;
}

/**
 * What a recorded observation establishes. A model-authored assertion of an
 * effect is not a check. A `judgment` here is an earlier recorded observation,
 * never the receipt for the current decision: that receipt is cited evidence
 * only and is excluded from the bundle and its digest.
 */
export type ObservationFactKind = 'search' | 'route' | 'policy' | 'schedule' | 'judgment';

/** One recorded observation with its source revision and content digest. */
export interface ObservationEvidenceFact {
  readonly source: 'observation';
  readonly ref: string;
  readonly observation: ObservationFactKind;
  readonly source_revision: string;
  readonly case: string | null;
  readonly digest: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * A revision-bound catalogue search. Only a complete search over the
 * authorized catalogue and compositions can establish a capability gap.
 */
export interface SearchInventoryFact {
  readonly search: string;
  readonly revision: string;
  readonly catalogue_revision: string;
  readonly complete: boolean;
  readonly authorized: boolean;
  readonly matches: readonly string[];
  readonly compositions: readonly string[];
  readonly informed_by_inference: boolean;
  readonly revoked: readonly string[];
  readonly missing_grants: readonly string[];
  readonly evidence: readonly EvidenceRef[];
}

/** How one route candidate stood at the recorded decision revision. */
export type RouteCandidateDisposition =
  | 'selected'
  | 'eligible'
  | 'excluded'
  | 'unavailable'
  | 'prohibited'
  | 'approval_required';

export interface RouteCandidateFact {
  readonly routed_unit: string;
  readonly disposition: RouteCandidateDisposition;
  readonly exclusion: string | null;
  readonly terms_revision: string | null;
}

/** The recorded selection, availability, terms, policy revisions and comparative checks. */
export interface RouteInventoryFact {
  readonly decision: string;
  readonly policy_revision: string;
  readonly route_table_revision: string;
  readonly preference_revision: string | null;
  readonly selected: string;
  readonly candidates: readonly RouteCandidateFact[];
  readonly comparative_evidence: readonly EvidenceRef[];
  readonly evidence: readonly EvidenceRef[];
}

/** One dependency's recorded state. A downstream failure does not prove its upstream cause. */
export interface ScheduleDependencyFact {
  readonly result: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
}

/** The recorded scheduler disposition, terminal outcome, budget and supersession state. */
export interface ScheduleInventoryFact {
  readonly scheduler_revision: string;
  readonly policy_revision: string;
  readonly disposition: Disposition;
  readonly terminal: 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | null;
  readonly dependencies: readonly ScheduleDependencyFact[];
  readonly budget: {
    readonly line: 'actions' | 'judgments' | 'cost';
    readonly limit: number;
    readonly reserved: number;
    readonly spent: number;
  } | null;
  readonly superseded: boolean;
  readonly evidence: readonly EvidenceRef[];
}

/**
 * The frozen, normalized deterministic facts for one failed case. Its
 * `recordDigest` is the identity's `evidence_bundle_digest`. It contains no
 * judgment receipt and no host objects.
 */
export interface AttributionEvidenceBundle {
  readonly weft: readonly WeftEvidenceFact[];
  readonly checks: readonly CheckEvidenceFact[];
  readonly observations: readonly ObservationEvidenceFact[];
  readonly search: readonly SearchInventoryFact[];
  readonly route: readonly RouteInventoryFact[];
  readonly schedule: readonly ScheduleInventoryFact[];
}

/**
 * The revision digests injected by the composition layer. The classifier and
 * rule revisions always require digests. The prompt and model revisions are
 * explicit null only when no judgment is requested.
 */
export interface AttributionRevisions {
  readonly classifier_revision: string;
  readonly rule_revision: string;
  readonly prompt_revision: string | null;
  readonly model_revision: string | null;
}

/**
 * The exact permitted judgment request, frozen before dispatch. Its
 * `recordDigest` is `judgment_request_digest`. The response, rationale,
 * latency and provider ids are receipt evidence, never part of this request.
 */
export interface AttributionJudgmentRequest {
  readonly request: string;
  readonly result: string;
  readonly case: string;
  readonly evidence_bundle_digest: string;
  readonly categories: readonly ConceptualAttributionCategory[];
  readonly evidence: readonly EvidenceRef[];
  readonly allowed_destinations: readonly string[];
  readonly budget: { readonly line: 'judgments' | 'cost'; readonly limit: number } | null;
  readonly prompt_revision: string;
  readonly model_revision: string;
}

/** Everything the pure decision step may observe. No ambient clock, entropy or provider. */
export interface AttributionDecisionInput {
  readonly result: string;
  readonly case: string;
  readonly split: Split;
  readonly bundle: AttributionEvidenceBundle;
  readonly revisions: AttributionRevisions;
  readonly judgment_request: AttributionJudgmentRequest | null;
}

/**
 * The closed `g7.claim` `id_inputs`: the pre-judgment identity preimage without
 * `domain`. `evidence_bundle_digest` and `judgment_request_digest` are
 * `recordDigest` values; the latter is explicit null when no judgment is
 * requested.
 */
export interface AttributionIdInputs {
  readonly result: string;
  readonly case: string;
  readonly evidence_bundle_digest: string;
  readonly classifier_revision: string;
  readonly rule_revision: string;
  readonly prompt_revision: string | null;
  readonly model_revision: string | null;
  readonly judgment_request_digest: string | null;
}

/** A deterministic claim: a closed category signal, no confidence, cited evidence. */
export type DeterministicAttributionDecision = {
  readonly [C in keyof DeterministicSignals]: {
    readonly category: C;
    readonly basis: 'deterministic';
    readonly signal: DeterministicSignals[C];
    readonly confidence: null;
    readonly evidence: readonly EvidenceRef[];
  };
}[keyof DeterministicSignals];

/** A probabilistic claim: no signal, a confidence, cited evidence. */
export interface JudgmentAttributionDecision {
  readonly category: Exclude<AttributionCategory, 'unattributed'>;
  readonly basis: 'judgment';
  readonly signal: null;
  readonly confidence: number;
  readonly evidence: readonly EvidenceRef[];
}

/** An explicit abstention: the valid `unattributed` outcome when evidence does not decide. */
export interface AbstentionAttributionDecision {
  readonly category: 'unattributed';
  readonly basis: 'none';
  readonly signal: null;
  readonly confidence: null;
  readonly evidence: readonly EvidenceRef[];
}

/**
 * What the pure decision step returns before result binding. The tune-only
 * producer copies it into `gauge.attribution@1`; the holdout evaluator scores
 * it without creating a holdout record.
 */
export type AttributionDecision =
  | DeterministicAttributionDecision
  | JudgmentAttributionDecision
  | AbstentionAttributionDecision;

/** How a cost line is known. An unknown line has no amount: it is never zero. */
export type CostBasis = 'measured' | 'estimated' | 'unknown';

export type CostLine =
  | { readonly basis: 'measured' | 'estimated'; readonly micros: number }
  | { readonly basis: 'unknown'; readonly micros: null };

/** What producing one result cost, failed trials, evaluation and review included. */
export interface EvaluationCost {
  readonly schema: 'gauge.cost@1';
  readonly cost: string;
  readonly result: string;
  readonly trials: number;
  readonly failed_trials: number;
  readonly trial: CostLine;
  readonly evaluation: CostLine;
  readonly review: CostLine;
  readonly total: CostLine;
}

/**
 * Eval-derived routing evidence published as data. The gateway reads it
 * without importing Gauge; applying it is a governed promotion outside Gauge.
 */
export interface PreferenceSet {
  readonly schema: 'gauge.preference@1';
  readonly preference: string;
  readonly workload: string;
  readonly criteria: string;
  readonly caseset: string;
  readonly split: Split;
  readonly mode: EvaluationResult['mode'];
  /** The criteria measure read as a routed unit's accept rate. */
  readonly accept: string;
  readonly entries: readonly {
    readonly routed_unit: string;
    readonly result: string;
    readonly verdict: ResultVerdict;
    readonly measures: EvaluationResult['measures'];
  }[];
}

/** An info-only measure's aggregate: v1's, plus the report statistics that are never weighed. */
export type InfoAggregate = Aggregate | 'p50_floor' | 'p90_floor' | 'ece10' | 'auc';

/** A measure recorded to reproduce a report, never weighed: no direction, no effect size, no interval. */
export interface InfoMeasureDefinition {
  readonly measure: string;
  readonly source: MeasureSource;
  readonly aggregate: InfoAggregate;
  /** The value with no samples, fixed by the set: 0 where a report prints 0, null where it prints nothing. */
  readonly empty: number | null;
}

/**
 * An info-only criteria set (`gauge.criteria@2`). It declares no bar and no
 * statistical method, and nothing may gate, compare, track, cost, attribute
 * or route on its measures.
 */
export interface InfoCriteriaSet {
  readonly schema: 'gauge.criteria@2';
  readonly criteria: string;
  readonly workload: string;
  readonly governed_by: Governance;
  readonly measures: readonly InfoMeasureDefinition[];
}

/** A subject's info-only measures (`gauge.result@2`). Its verdict is always `info_only`, never a bar verdict. */
export interface InfoResult {
  readonly schema: 'gauge.result@2';
  readonly result: string;
  readonly subject: EvaluationResult['subject'];
  readonly criteria: string;
  readonly caseset: string;
  readonly split: Split;
  readonly caseset_digest: string;
  readonly mode: EvaluationResult['mode'];
  readonly evidence: readonly EvidenceRef[];
  readonly measures: readonly { readonly measure: string; readonly value: number | null; readonly n: number }[];
  readonly verdict: 'info_only';
}

export type GaugeRecord =
  | CriteriaSet
  | CaseSet
  | Revision
  | EvaluationResult
  | Comparison
  | FailureAttribution
  | EvaluationCost
  | PreferenceSet
  | InfoCriteriaSet
  | InfoResult;

/** First applicable rejection reason, in the contract's order. */
export type Rejection =
  | 'envelope'
  | 'ref'
  | 'info_only'
  | 'binding'
  | 'governance'
  | 'approval_reused'
  | 'holdout'
  | 'mode'
  | 'measure'
  | 'constraint'
  | 'verdict'
  | 'attribution'
  | 'cost'
  | 'trial_count'
  | 'cost_unknown';

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: Rejection };

/** A producer's outcome: a record that has passed `validate`, or the first rejection. */
export type Produced<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly reason: Rejection };

/** Samples for one evaluation result, one list per criteria measure. */
export interface Run {
  readonly result: string;
  readonly subject: EvaluationResult['subject'];
  /** The workload the samples came from. It must be the criteria set's and case set's. */
  readonly workload: string;
  readonly criteria: string;
  readonly caseset: string;
  readonly split: Split;
  readonly mode: EvaluationResult['mode'];
  readonly evidence: readonly EvidenceRef[];
  /**
   * Keyed by measure. A rate sample is 0 or 1; an empty list is no evidence.
   * Only an info-only `ece10` or `auc` measure takes `[x, y]` pairs.
   */
  readonly samples: Readonly<Record<string, readonly number[] | readonly Pair[]>>;
}

/** An `ece10` sample `[p, y]` or an `auc` sample `[score, y]`, y 0 or 1. */
export type Pair = readonly [x: number, y: number];

export interface ComparisonRequest {
  readonly comparison: string;
  readonly experiment: string | null;
  readonly baseline: string;
  readonly candidate: string;
}

/** One step of a track: a result compared with the one recorded before it. */
export interface TrackStep {
  readonly previous: string;
  readonly next: string;
  readonly deltas: Comparison['deltas'];
  readonly verdict: ComparisonVerdict;
  readonly regression: boolean;
}

export type Track =
  | { readonly ok: true; readonly steps: readonly TrackStep[] }
  | { readonly ok: false; readonly reason: Rejection };

/**
 * Known criteria sets, case sets, results and revisions, keyed by `criteria`,
 * `caseset`, `result` and `revision`. A criteria set or case set is known only
 * while a revision records it. Info-only criteria sets and results file in the
 * same tables as their @1 counterparts.
 */
export interface Context {
  readonly criteria: Readonly<Record<string, unknown>>;
  readonly casesets: Readonly<Record<string, unknown>>;
  readonly results: Readonly<Record<string, unknown>>;
  readonly revisions: Readonly<Record<string, unknown>>;
}
