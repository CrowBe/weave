import type { CapabilityContract, InferenceRole } from './contracts.js';
import type { FailureCode } from './failures.js';
import type { Grant } from './grants.js';
import type { ResourceRef } from './refs.js';

export type ResolutionStatus = 'resolved' | 'unresolved' | 'unavailable' | 'blocked';

export type InvocationOutcome =
  | { readonly outcome: 'succeeded'; readonly output: unknown }
  | { readonly outcome: 'failed'; readonly failure: string }
  | { readonly outcome: 'uncertain'; readonly reason: string };

export interface InvokeOptions {
  readonly invocation_id?: string;
}

export interface InvocationHandle {
  readonly kind: 'handle';
  readonly action_id: string;
  /** Stable identity across disconnects and recovery. Defaults to action_id when omitted at invoke. */
  readonly invocation_id: string;
  /** Resolves when the invocation completes. It never rejects; failures are outcomes. */
  readonly result: Promise<InvocationOutcome>;
  requestCancel(): void;
}

export interface InvocationRejected {
  readonly kind: 'rejected';
  readonly code: FailureCode;
  readonly reason: string;
}

export type DescribeResult =
  | { readonly kind: 'contract'; readonly contract: CapabilityContract }
  | { readonly kind: 'unknown_operation' };

/**
 * Bounded outcome lookup. Does not repeat the effect. Absence of a receipt
 * while execution may continue is unresolved.
 */
export type OutcomeLookup =
  | { readonly status: 'committed'; readonly outcome: InvocationOutcome }
  | { readonly status: 'stopped'; readonly outcome: InvocationOutcome }
  | { readonly status: 'unresolved'; readonly reason: string };

export type LookupResult = OutcomeLookup | InvocationRejected;

/**
 * The capability host interface Weave consumes. AgentFabric supplies the real
 * host; a fake host in Weave's tests satisfies it for M0.
 *
 * A result Promise is not the only completion path: lookup and cancellation
 * exist so crash recovery and control-plane work do not depend on in-memory
 * handles.
 */
export interface CapabilityHost {
  /** Live catalogue ids. Listing does not grant invocation. */
  operations(): readonly string[];
  describe(operation: string): DescribeResult;
  invoke(
    grant: Grant | null,
    operation: string,
    inputs: unknown,
    options?: InvokeOptions,
  ): InvocationHandle | InvocationRejected;
  canonicalResource(ref: ResourceRef): ResourceRef;
  lookup(invocation_id: string, grant: Grant | null): LookupResult;
  requestCancel(invocation_id: string): { readonly acknowledged: true };
}

/**
 * A bounded inference request from an implementation. The host enforces the
 * contract's declared limits before any provider is reached.
 */
export interface InferCall {
  readonly kind: string;
  readonly role: InferenceRole;
  readonly input: unknown;
  readonly terms: {
    readonly cost_ceiling: number;
    readonly destinations: readonly string[];
    readonly max_attempts: number;
    /** Tick deadline forwarded to the gateway. An open deadline is not substituted. */
    readonly deadline: number;
  };
}

export type InferResult =
  | {
      readonly status: 'accepted';
      readonly output: unknown;
      readonly attempts: readonly unknown[];
      readonly spent: number;
    }
  | {
      readonly status: 'unaccepted';
      readonly reason: string;
      readonly attempts: readonly unknown[];
      readonly spent: number;
    }
  | {
      readonly status: 'blocked';
      readonly reason: string;
      readonly attempts: readonly unknown[];
      readonly spent: number;
    }
  | { readonly status: 'refused'; readonly code: FailureCode; readonly reason: string };

/**
 * Resolver context: operations in contract vocabulary only. No locators or
 * substrate types. Nested invoke is limited to the contract's depends_on.
 * `infer` is present only when the contract declared inference limits.
 */
export interface ResolverContext {
  read(ref: ResourceRef): { readonly revision: number; readonly content: string };
  write(
    ref: ResourceRef,
    expected_revision: number,
    content: string,
  ): { readonly revision: number };
  invoke(capability: string, input: unknown): InvocationOutcome;
  infer?(call: InferCall): Promise<InferResult>;
}
