/**
 * Types for Gauge's evaluation records (GAUGE-CONTRACT.md). They describe the
 * shape a valid record has; `validate` is the only thing that establishes it,
 * including every recomputed status and verdict.
 */
import type { Kind } from '@weave/weft';

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

/** What producing one result cost, failed trials, evaluation and review included. */
export interface EvaluationCost {
  readonly schema: 'gauge.cost@1';
  readonly cost: string;
  readonly result: string;
  readonly trials: number;
  readonly failed_trials: number;
  readonly trial_micros: number;
  readonly evaluation_micros: number;
  readonly review_micros: number;
  readonly total_micros: number;
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

export type GaugeRecord =
  | CriteriaSet
  | CaseSet
  | Revision
  | EvaluationResult
  | Comparison
  | FailureAttribution
  | EvaluationCost
  | PreferenceSet;

/** First applicable rejection reason, in the contract's order. */
export type Rejection =
  | 'envelope'
  | 'ref'
  | 'binding'
  | 'governance'
  | 'holdout'
  | 'mode'
  | 'measure'
  | 'constraint'
  | 'verdict'
  | 'attribution'
  | 'cost';

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: Rejection };

/** A producer's outcome: a record that has passed `validate`, or the first rejection. */
export type Produced<T> = { readonly ok: true; readonly record: T } | { readonly ok: false; readonly reason: Rejection };

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
  /** Keyed by measure. A rate sample is 0 or 1; an empty list is no evidence. */
  readonly samples: Readonly<Record<string, readonly number[]>>;
}

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

export type Track = { readonly ok: true; readonly steps: readonly TrackStep[] } | { readonly ok: false; readonly reason: Rejection };

/**
 * Known criteria sets, case sets, results and revisions, keyed by `criteria`,
 * `caseset`, `result` and `revision`. A criteria set or case set is known only
 * while a revision records it.
 */
export interface Context {
  readonly criteria: Readonly<Record<string, unknown>>;
  readonly casesets: Readonly<Record<string, unknown>>;
  readonly results: Readonly<Record<string, unknown>>;
  readonly revisions: Readonly<Record<string, unknown>>;
}
