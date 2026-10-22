/**
 * Types for `weft.record@1` (WEFT-CONTRACT.md). They describe the shape a
 * valid record has; `validateRecord` is the only thing that establishes it.
 */

export const SCHEMA = 'weft.record@1';

export type EmitterKind = 'loom' | 'gateway' | 'fabric' | 'external';
export type LinkRel = 'caused_by' | 'joins' | 'supersedes' | 'cancels' | 'handoff' | 'retry_of';
export type EvidenceSource = 'observation' | 'inference_request' | 'invocation' | 'check' | 'external';
export type ContentClass = 'public' | 'non_sensitive' | 'sensitive' | 'private';

export interface Emitter {
  readonly kind: EmitterKind;
  readonly id: string;
}

export interface Link {
  readonly rel: LinkRel;
  readonly record_id: string;
}

export interface Evidence {
  readonly source: EvidenceSource;
  readonly ref: string;
}

/** What a field can reveal (WEFT-CONTRACT.md, Disclosure). Not a content class. */
export type DisclosureClass = 'metric' | 'reference' | 'content';

/** Names and fingerprints text held elsewhere; carries `text` only under an `InlinePolicy`. */
export interface ContentValue {
  readonly content_class: ContentClass;
  readonly digest: string;
  readonly ref?: string;
  readonly text?: string;
}

/** The composition root's permission to record text inline in one Weft trace, for these classes. Never the default. */
export interface InlinePolicy {
  readonly trace_id: string;
  readonly classes: readonly ContentClass[];
}

export type Eligibility = 'allowed' | 'approval_required' | 'prohibited';
export type Disposition =
  | 'selected'
  | 'dependency'
  | 'conflict'
  | 'stale_read_set'
  | 'budget'
  | 'not_reached'
  | 'policy_filtered';

export interface Candidate {
  readonly candidate_ref: string;
  readonly operation: string;
  readonly eligibility: Eligibility;
  readonly weight: number | null;
  readonly disposition: Disposition;
}

export interface Exclusion {
  readonly routed_unit: string;
  readonly reason: string;
}

export interface KindFields {
  readonly 'goal.intent': {
    readonly goal_ref: string;
    readonly statement: ContentValue;
    readonly criteria?: readonly string[];
  };
  readonly 'thread.transition': {
    readonly transition: 'opened' | 'joined' | 'superseded' | 'cancelled' | 'closed';
  };
  readonly 'cycle.weighed': {
    readonly cycle_no: number;
    readonly state_revision: number;
    readonly procedure: string;
    readonly weights_ref?: string | null;
    readonly cost_micros?: number;
    readonly candidates: readonly Candidate[];
  };
  readonly judgment: {
    readonly site: string;
    readonly request_ref: string;
    readonly accepted: boolean;
    readonly confidence?: number;
    readonly routed_unit?: string;
  };
  readonly 'route.selected': {
    readonly request_ref: string;
    readonly routed_unit: string;
    readonly tier?: 'decision' | 'flash' | 'standard' | 'strong';
    readonly excluded?: readonly Exclusion[];
  };
  readonly 'inference.attempt': {
    readonly request_ref: string;
    readonly routed_unit: string;
    readonly attempt_no: number;
    readonly disposition: 'accepted' | 'unaccepted' | 'failed';
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly spent_micros?: number;
    readonly cost_is_upper_bound?: boolean;
    readonly latency_ms?: number;
  };
  readonly 'capability.invoked': {
    readonly contract_rev: string;
    readonly implementation: string;
    readonly status: 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
    readonly invocation_ref?: string;
    readonly execution_tier?: string;
    readonly failure?: string;
    readonly latency_ms?: number;
  };
  readonly 'capability.lifecycle': {
    readonly operation: string;
    readonly implementation?: string;
    readonly event: 'selected' | 'admitted' | 'revoked';
    readonly contract_rev?: string | null;
  };
  readonly 'action.transition': {
    readonly action_ref: string;
    readonly operation: string;
    readonly state: 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
    readonly contract_rev?: string | null;
  };
  readonly 'context.assembled': {
    readonly assembly_ref: string;
    readonly view_ref?: string;
    readonly consumer?: string;
    readonly slices?: readonly string[];
    readonly source_revision?: number;
    readonly omissions?: number;
    readonly disclosed_bytes?: number;
    readonly cost_micros?: number;
  };
  readonly budget: {
    readonly line: 'actions' | 'judgments' | 'cost';
    readonly limit?: number;
    readonly reserved?: number;
    readonly spent?: number;
  };
  readonly outcome: {
    readonly subject: 'goal' | 'thread' | 'action';
    readonly subject_ref: string;
    readonly status: 'complete' | 'missed' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
    readonly criteria_met?: number;
    readonly criteria_total?: number;
  };
  readonly error: {
    readonly code: string;
    readonly retryable?: boolean;
  };
}

export type Kind = keyof KindFields;

export type WeftRecord = {
  readonly [K in Kind]: {
    readonly schema: typeof SCHEMA;
    readonly trace_id: string;
    readonly record_id: string;
    readonly emitter: Emitter;
    readonly sequence: number;
    readonly kind: K;
    readonly thread_id: string | null;
    readonly parent_id: string | null;
    readonly links: readonly Link[];
    readonly evidence: readonly Evidence[];
    readonly fields: KindFields[K];
  };
}[Kind];

/** Supplied by the composition root before serialization. Weft validates what it returns. */
export type Redactor = (record: WeftRecord) => unknown;

/** First applicable rejection reason, in the contract's order. */
export type Rejection = 'envelope' | 'id' | 'sequence' | 'kind' | 'link' | 'evidence' | 'content' | 'field';

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: Rejection };
