/**
 * AgentSOP — the capability contract layer.
 *
 * This package depends on neither Weave nor AgentFabric (M0-C1). It states what
 * a capability contract says and what a host must check; it executes nothing.
 * M0 scope (docs/agentfabric-concepts.md §6): capability document, reference
 * and effect shapes, grant shape and matching, failure codes, host interface.
 */

// ---------------------------------------------------------------------------
// Effects: a closed, versioned vocabulary. Adding an effect is a revision.
// ---------------------------------------------------------------------------

export const EFFECT_VOCABULARY_REVISION = 1;

export const EFFECTS = ['discover', 'read', 'create', 'write', 'append', 'delete'] as const;
export type Effect = (typeof EFFECTS)[number];

export function isEffect(value: unknown): value is Effect {
  return typeof value === 'string' && (EFFECTS as readonly string[]).includes(value);
}

/**
 * Two effects on the same resource conflict unless both are `read`.
 * Reads do not commute with anything that changes the resource, and the
 * vocabulary is closed, so the rule is stated once here.
 */
export function effectsConflict(a: Effect, b: Effect): boolean {
  return !(a === 'read' && b === 'read');
}

// ---------------------------------------------------------------------------
// References. In M0 a canonical `ResourceId` plays the role of a resource
// reference; host issuance and the locator table arrive with `agentfabric`
// in M1 (recorded assumption, docs/m0-inspect-and-report.md §13).
// ---------------------------------------------------------------------------

export type ResourceRef = string;

/** A concrete effect on a concrete resource: what a grant covers and an action declares. */
export interface ResourceEffect {
  readonly resource: ResourceRef;
  readonly mode: Effect;
}

/**
 * An authority selector on the contract: the input field that carries the
 * reference and the effect the capability needs on it.
 */
export interface EffectSelector {
  readonly input: string;
  readonly mode: Effect;
}

// ---------------------------------------------------------------------------
// The capability document. The contract is durable; implementations are
// disposable. It is named for its operation, never for an implementation.
// Input and output are described as closed field -> type-name maps in M0; the
// schema syntax is an open toolchain question (ARCHITECTURE.md §11).
// ---------------------------------------------------------------------------

export interface CapabilityContract {
  readonly id: string;
  readonly revision: string;
  readonly purpose: string;
  readonly input: Readonly<Record<string, string>>;
  readonly output: Readonly<Record<string, string>>;
  readonly effects: readonly EffectSelector[];
  readonly permissions: readonly EffectSelector[];
  readonly failures: readonly string[];
}

/**
 * Bind a contract's selectors against concrete inputs. Fails closed: a
 * selector whose input field is missing or not a reference is an error, never
 * an empty permission set.
 */
export function bindSelectors(
  selectors: readonly EffectSelector[],
  inputs: unknown,
): { ok: true; bound: ResourceEffect[] } | { ok: false; code: FailureCode; reason: string } {
  if (typeof inputs !== 'object' || inputs === null) {
    return { ok: false, code: 'INVALID_INPUT', reason: 'inputs must be a record' };
  }
  const record = inputs as Record<string, unknown>;
  const bound: ResourceEffect[] = [];
  for (const selector of selectors) {
    const value = record[selector.input];
    if (typeof value !== 'string' || value.length === 0) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        reason: `input '${selector.input}' must carry a resource reference`,
      };
    }
    bound.push({ resource: value, mode: selector.mode });
  }
  return { ok: true, bound };
}

// ---------------------------------------------------------------------------
// Failure codes are contract; messages are not. Only codes M0 exercises.
// ---------------------------------------------------------------------------

export const FAILURE_CODES = ['UNKNOWN_CAPABILITY', 'DENIED', 'INVALID_INPUT'] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

// ---------------------------------------------------------------------------
// Grants. Weave's policy issues one per action at dispatch; the host checks it
// at invocation. Admission never issues one.
// ---------------------------------------------------------------------------

export interface Grant {
  readonly action_id: string;
  readonly operation: string;
  readonly contract_rev: string;
  readonly permissions: readonly ResourceEffect[];
  readonly effects: readonly ResourceEffect[];
  /** Sequence number of the observation under which the grant was issued. */
  readonly issued_at: number;
}

/**
 * Grant matching. A grant covers a request when it names the same operation
 * and contract revision and every required resource effect is present in the
 * grant's permissions. Wildcards do not exist; absence is denial.
 */
export function grantCovers(
  grant: Grant | null | undefined,
  operation: string,
  contract_rev: string,
  required: readonly ResourceEffect[],
): { ok: true } | { ok: false; code: FailureCode; reason: string } {
  if (!grant) {
    return { ok: false, code: 'DENIED', reason: 'no grant' };
  }
  if (grant.operation !== operation) {
    return { ok: false, code: 'DENIED', reason: 'grant names a different operation' };
  }
  if (grant.contract_rev !== contract_rev) {
    return { ok: false, code: 'DENIED', reason: 'grant names a different contract revision' };
  }
  for (const need of required) {
    const covered = grant.permissions.some(
      (p) => p.resource === need.resource && p.mode === need.mode,
    );
    if (!covered) {
      return {
        ok: false,
        code: 'DENIED',
        reason: `grant does not cover ${need.mode}(${need.resource})`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The capability host interface Weave consumes. AgentFabric supplies the real
// host from M1; in M0 a fake host in Weave's tests satisfies it.
// ---------------------------------------------------------------------------

export type InvocationOutcome =
  | { readonly outcome: 'succeeded'; readonly output: unknown }
  | { readonly outcome: 'failed'; readonly failure: string }
  | { readonly outcome: 'uncertain'; readonly reason: string };

export interface InvocationHandle {
  readonly kind: 'handle';
  readonly action_id: string;
  /** Resolves when the invocation completes. It never rejects; failures are outcomes. */
  readonly result: Promise<InvocationOutcome>;
}

export interface InvocationRejected {
  readonly kind: 'rejected';
  readonly code: FailureCode;
  readonly reason: string;
}

export type DescribeResult =
  | { readonly kind: 'contract'; readonly contract: CapabilityContract }
  | { readonly kind: 'unknown_operation' };

export interface CapabilityHost {
  describe(operation: string): DescribeResult;
  invoke(grant: Grant | null, operation: string, inputs: unknown): InvocationHandle | InvocationRejected;
}
