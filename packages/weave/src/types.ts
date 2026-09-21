/**
 * Weave record shapes for M0, transcribed from docs/m0-inspect-and-report.md.
 * These are the contract the checks are written against; the runtime that
 * produces them lives beside this file.
 */
import type { Grant, ResourceEffect } from '@weave/agentsop';

export type Seq = number;
export type ActionId = string;
export type CandidateId = string;
export type ResourceId = string;

// ---------------------------------------------------------------------------
// §3 Observation envelope
// ---------------------------------------------------------------------------

export type ProvenanceKind = 'runtime' | 'host' | 'judgment' | 'clock' | 'operator' | 'test' | 'gateway';

export interface Provenance {
  readonly kind: ProvenanceKind;
  readonly id: string;
}

export type Validation =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unknown_type' };

/** What a source supplies. The sequencer assigns `seq`; validation is determined at append. */
export interface ObservationInput {
  readonly observation_id: string;
  readonly source: Provenance;
  readonly caused_by: ActionId | Seq | null;
  readonly payload_type: string;
  readonly payload_version: number;
  readonly payload: unknown;
}

export interface Observation extends ObservationInput {
  readonly seq: Seq;
  readonly validation: Validation;
}

// Payload types used in M0. Any other `payload_type` is `unknown_type`.

export interface Goal {
  readonly goal_id: string;
  readonly purpose: string;
  readonly sources: readonly ResourceId[];
  readonly destination?: ResourceId;
  readonly authority: { readonly read: readonly ResourceId[]; readonly write?: readonly ResourceId[] };
  readonly framing?: boolean;
  readonly budget: { readonly actions: number; readonly judgments: number; readonly recovery?: number; readonly cost?: number };
  readonly success_evidence: string;
}

export interface SourcePayload {
  readonly resource: ResourceId;
  readonly revision: number;
  readonly content: string;
}

export interface ClockTickPayload {
  readonly tick: number;
}

export interface WeightEntry {
  readonly candidate_id: CandidateId;
  readonly weight: number;
}

export interface WeightsRecordedPayload {
  readonly site: 'frontier.weigh';
  readonly implementation: string;
  readonly state_revision: Seq;
  readonly candidate_set: string;
  readonly weights: readonly WeightEntry[];
  readonly request_id?: string;
}

export interface Reservation {
  readonly actions: number;
  readonly judgments: number;
}

export interface ActionStartedPayload {
  readonly action_id: ActionId;
  readonly candidate_id: CandidateId;
  readonly operation: string;
  readonly contract_rev: string | null;
  readonly inputs: unknown;
  readonly read_set: readonly ReadSetEntry[];
  readonly effects: readonly ResourceEffect[];
  readonly reservation: Reservation;
  readonly grant: Grant | null;
  readonly invocation_id?: string;
}

export type ActionOutcome =
  | { readonly outcome: 'succeeded'; readonly output: unknown }
  | { readonly outcome: 'failed'; readonly failure: string }
  | { readonly outcome: 'uncertain'; readonly reason: string };

export interface ActionResultPayload {
  readonly action_id: ActionId;
  readonly outcome: ActionOutcome;
}

export interface ActionReconciledPayload {
  readonly action_id: ActionId;
  readonly invocation_id: string;
  readonly outcome: ActionOutcome;
}

export interface RecoveryAttemptedPayload {
  readonly action_id: ActionId;
  readonly invocation_id: string;
}

export interface RecoveryExhaustedPayload {
  readonly reason: string;
}

export interface ActionCancelRequestedPayload {
  readonly action_id: ActionId;
  readonly reason: string;
}

export interface ApprovalRequestedPayload {
  readonly request_id: string;
  readonly goal_id: string;
  readonly candidate_id: CandidateId;
  readonly operation: string;
  readonly contract_rev: string;
  readonly binding_digest: string;
  readonly report_digest: string;
  readonly read_set: readonly ResourceReadSetEntry[];
  readonly destination: ResourceId;
  readonly expected_revision: number;
  readonly effects: readonly ResourceEffect[];
  readonly budget: Reservation;
  readonly valid_from_tick: number;
  readonly valid_until_tick: number;
}

export type ApprovalDecisionKind = 'approved' | 'denied' | 'revoked' | 'expired';

export interface ApprovalDecidedPayload {
  readonly request_id: string;
  readonly principal: string;
  readonly decision: ApprovalDecisionKind;
  readonly authority_revision: number;
  readonly scope?: {
    readonly valid_until_tick?: number;
  };
}

export interface CapabilityDescribedPayload {
  readonly operation: string;
  readonly contract: unknown;
}

export interface ViewOmission {
  readonly name: string;
  readonly reason: string;
}

export interface ViewSliceManifest {
  readonly name: string;
  readonly revisions: readonly Seq[];
  readonly truncated: boolean;
  readonly omitted: readonly ViewOmission[];
}

export interface StateView {
  readonly profile: string;
  readonly profile_version: number;
  readonly state_revision: Seq;
  readonly content: unknown;
  readonly manifest: { readonly slices: readonly ViewSliceManifest[] };
}

export interface InferenceTermsRecord {
  readonly quality: string;
  readonly destinations: readonly string[];
  readonly max_context_tokens: number;
  readonly deadline: number;
  readonly cost_ceiling: number;
  readonly max_attempts: number;
}

export interface InferenceRequestedPayload {
  readonly request_id: string;
  readonly site: 'frontier.weigh' | 'goal.frame';
  readonly role: 'framing' | 'working';
  readonly kind: string;
  readonly view: StateView;
  readonly state_revision: Seq;
  readonly candidate_set: string | null;
  readonly terms: InferenceTermsRecord;
  readonly reservation: { readonly judgments: number; readonly cost: number };
}

export interface InferenceAttemptRecord {
  readonly attempt: number;
  readonly routed_unit_id: string;
  readonly cost: number;
  readonly cost_is_upper_bound: boolean;
  readonly disposition: unknown;
}

export interface InferenceRecordedPayload {
  readonly request_id: string;
  readonly attempts: readonly InferenceAttemptRecord[];
  readonly spent: number;
  readonly status: 'accepted' | 'unaccepted' | 'blocked';
  readonly reason: string | null;
}

export interface ProposedBinding {
  readonly operation: string;
  readonly inputs: unknown;
}

export interface RejectedBinding {
  readonly operation: string;
  readonly inputs: unknown;
  readonly reason: string;
}

export interface Proposal {
  readonly bindings: readonly ProposedBinding[];
  readonly rejected: readonly RejectedBinding[];
}

export interface PublishReceipt {
  readonly invocation_id: string;
  readonly report_digest: string;
  readonly destination: ResourceId;
  readonly committed_revision: number;
}

export const PAYLOAD_TYPES = [
  'goal.opened',
  'source.registered',
  'source.changed',
  'clock.tick',
  'weights.recorded',
  'action.started',
  'action.queued',
  'action.result',
  'action.reconciled',
  'action.cancel_requested',
  'approval.requested',
  'approval.decided',
  'capability.described',
  'recovery.attempted',
  'recovery.exhausted',
  'inference.requested',
  'inference.recorded',
] as const;
export type PayloadType = (typeof PAYLOAD_TYPES)[number];

// ---------------------------------------------------------------------------
// Fixture capability records (§2)
// ---------------------------------------------------------------------------

export interface InspectionResult {
  readonly source: ResourceId;
  readonly revision: number;
  readonly line_count: number;
  readonly digest: string;
}

export interface Report {
  readonly entries: readonly InspectionResult[];
  readonly read_set: readonly ResourceReadSetEntry[];
}

// ---------------------------------------------------------------------------
// §4 Derived state
// ---------------------------------------------------------------------------

export type GoalStatus = 'active' | 'complete';

export interface BudgetLine {
  readonly limit: number;
  readonly reserved: number;
  readonly spent: number;
}

export interface Budget {
  readonly actions: BudgetLine;
  readonly judgments: BudgetLine;
  readonly cost: BudgetLine;
}

export interface SourceState {
  readonly revision: number;
  readonly content: string;
  /** seq of the observation that established this revision */
  readonly evidence: Seq;
}

export interface State {
  readonly state_revision: Seq;
  readonly goal: (Goal & { readonly status: GoalStatus; readonly evidence: Seq }) | null;
  readonly sources: Readonly<Record<ResourceId, SourceState>>;
  readonly actions: Readonly<Record<ActionId, ActionRecord>>;
  readonly inspections: Readonly<Record<ResourceId, { readonly result: InspectionResult; readonly evidence: Seq }>>;
  readonly report: { readonly report: Report; readonly evidence: readonly Seq[] } | null;
  readonly publication: { readonly receipt: PublishReceipt; readonly evidence: Seq } | null;
  readonly budget: Budget;
  readonly clock: { readonly tick: number; readonly evidence: Seq | null };
  readonly approvals: Readonly<Record<string, ApprovalRecord>>;
  readonly contracts: Readonly<Record<string, unknown>>;
  readonly recovery: { readonly limit: number; readonly spent: number };
  readonly proposal: { readonly proposal: Proposal; readonly evidence: Seq } | null;
  readonly inferences: Readonly<Record<string, InferenceRecord>>;
}

// ---------------------------------------------------------------------------
// §5 Action lifecycle
// ---------------------------------------------------------------------------

export type ActionState = 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';

export interface ResourceReadSetEntry {
  readonly resource: ResourceId;
  readonly revision: number;
}

export interface StateFieldReadSetEntry {
  readonly state_field: string;
  readonly revision: number;
}

export type ReadSetEntry = ResourceReadSetEntry | StateFieldReadSetEntry;

export interface ActionRecord {
  readonly action_id: ActionId;
  readonly candidate_id: CandidateId;
  readonly operation: string;
  readonly contract_rev: string | null;
  readonly inputs: unknown;
  readonly read_set: readonly ReadSetEntry[];
  readonly effects: readonly ResourceEffect[];
  readonly reservation: Reservation;
  readonly state: ActionState;
  readonly cancel_requested: boolean;
  readonly started_at: Seq | null;
  readonly finished_at: Seq | null;
  readonly grant: Grant | null;
  readonly invocation_id: string | null;
  readonly reconciled: boolean;
}

// ---------------------------------------------------------------------------
// §6 Action candidate
// ---------------------------------------------------------------------------

export type Eligibility =
  | { readonly status: 'allowed' }
  | { readonly status: 'approval_required'; readonly policy: string }
  | { readonly status: 'prohibited'; readonly reason: string };

export interface Candidate {
  readonly candidate_id: CandidateId;
  readonly operation: string;
  readonly contract_rev: string | null;
  readonly inputs: unknown;
  readonly evidence: readonly Seq[];
  readonly read_set: readonly ReadSetEntry[];
  readonly dependencies: readonly ActionId[];
  readonly effects: readonly ResourceEffect[];
  readonly resources: Reservation;
  readonly eligibility: Eligibility;
  readonly weight: number | null;
}

// ---------------------------------------------------------------------------
// §9 Trace
// ---------------------------------------------------------------------------

export type ProcedureId = 'inspect_and_report@1' | 'inspect_report_publish@1' | 'frame_and_report@1';

export interface InferenceRecord {
  readonly request_id: string;
  readonly request: InferenceRequestedPayload;
  readonly recorded: InferenceRecordedPayload | null;
  readonly evidence: readonly Seq[];
}

export interface ApprovalRecord {
  readonly request_id: string;
  readonly request: ApprovalRequestedPayload;
  readonly status: 'pending' | ApprovalDecisionKind;
  readonly evidence: readonly Seq[];
  readonly principal: string | null;
  readonly authority_revision: number | null;
}

export type NotSelectedReason = 'dependency' | 'conflict' | 'stale_read_set' | 'budget';

export type CycleOutcome =
  | { readonly status: 'dispatched' }
  | { readonly status: 'waiting' }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'complete' };

export interface CycleRecord {
  readonly cycle_no: number;
  readonly state_revision: Seq;
  readonly procedure: ProcedureId;
  readonly candidates: readonly Candidate[];
  readonly weights_ref: Seq | null;
  readonly selected: readonly {
    readonly candidate_id: CandidateId;
    readonly action_id: ActionId;
    readonly reservation: Reservation;
  }[];
  readonly not_selected: readonly { readonly candidate_id: CandidateId; readonly reason: NotSelectedReason }[];
  readonly outcome: CycleOutcome;
}

export interface Trace {
  readonly observations: readonly Observation[];
  readonly cycles: readonly CycleRecord[];
}

// ---------------------------------------------------------------------------
// Decision layer (judgment site `frontier.weigh`)
// ---------------------------------------------------------------------------

export interface WeighRequest {
  readonly site: 'frontier.weigh';
  readonly state_revision: Seq;
  readonly candidate_set: string;
  /** The eligible candidates only. Prohibited candidates never reach a judgment site. */
  readonly candidates: readonly Candidate[];
  readonly view?: StateView;
  /** Cost envelope reserved for this gateway weigh, in micros. */
  readonly cost_ceiling?: number;
}

export interface WeighResult {
  readonly weights: readonly WeightEntry[];
  readonly attempts?: readonly InferenceAttemptRecord[];
  readonly spent?: number;
  readonly status?: 'accepted' | 'unaccepted' | 'blocked';
  readonly reason?: string;
  readonly implementation?: string;
}

export interface DecisionLayer {
  readonly implementation: string;
  /** Gateway weighing is asynchronous; scripted weighing is not. */
  readonly async?: boolean;
  weigh(request: WeighRequest): readonly WeightEntry[] | Promise<WeighResult>;
}

// ---------------------------------------------------------------------------
// §10 Replay
// ---------------------------------------------------------------------------

export interface ReplayFailure {
  readonly at_seq: Seq | null;
  readonly action_id: ActionId | null;
  readonly reason: string;
}

export type ReplayResult =
  | { readonly ok: true; readonly trace: Trace; readonly state: State }
  | { readonly ok: false; readonly failure: ReplayFailure; readonly trace: Trace; readonly state: State };
