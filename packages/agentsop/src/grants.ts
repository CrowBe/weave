import { effectSetsEqual, type ResourceEffect } from './refs.js';
import type { FailureCode } from './failures.js';

/**
 * Grants. Weave's policy issues one per action at dispatch; the host checks it
 * at invocation. Admission never issues one. A serialized copy of these fields
 * is not issuance — see GrantAuthority.
 */
export interface Grant {
  readonly action_id: string;
  readonly operation: string;
  readonly contract_rev: string;
  readonly permissions: readonly ResourceEffect[];
  readonly effects: readonly ResourceEffect[];
  /** Sequence number of the observation under which the grant was issued. */
  readonly issued_at: number;
}

export type GrantMatch =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: FailureCode; readonly reason: string };

/**
 * Structural grant matching. A grant covers a request when it names the same
 * operation and contract revision, every required resource effect is present in
 * the grant's permissions, and the grant's effect set equals the declared bound
 * effects. Wildcards do not exist; absence is denial.
 *
 * This does not establish trusted issuance. Copied field-equal records still
 * match here; the host must also require GrantAuthority.isIssued.
 */
export function grantCovers(
  grant: Grant | null | undefined,
  operation: string,
  contract_rev: string,
  requiredPermissions: readonly ResourceEffect[],
  declaredEffects?: readonly ResourceEffect[],
): GrantMatch {
  if (!grant) {
    return { ok: false, code: 'DENIED', reason: 'no grant' };
  }
  if (grant.operation !== operation) {
    return { ok: false, code: 'DENIED', reason: 'grant names a different operation' };
  }
  if (grant.contract_rev !== contract_rev) {
    return { ok: false, code: 'DENIED', reason: 'grant names a different contract revision' };
  }
  for (const need of requiredPermissions) {
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
  if (declaredEffects !== undefined && !effectSetsEqual(grant.effects, declaredEffects)) {
    return { ok: false, code: 'DENIED', reason: 'grant effects do not equal the declared effect set' };
  }
  return { ok: true };
}

/**
 * In-process issuance. Object identity is the authority boundary: field-equal
 * copies, JSON round-trips, and forged literals are not issued. Consume on
 * accept so a grant cannot start a second invocation; revoke so a still-open
 * invocation cannot commit.
 */
export interface GrantAuthority {
  issue(fields: Grant): Grant;
  isIssued(grant: Grant | null | undefined): boolean;
  isValid(grant: Grant | null | undefined): boolean;
  markInvoked(grant: Grant): boolean;
  revoke(grant: Grant): void;
}

export function createGrantAuthority(): GrantAuthority {
  const issued = new WeakSet<object>();
  const invoked = new WeakSet<object>();
  const revoked = new WeakSet<object>();
  return {
    issue(fields) {
      const grant: Grant = {
        action_id: fields.action_id,
        operation: fields.operation,
        contract_rev: fields.contract_rev,
        permissions: fields.permissions,
        effects: fields.effects,
        issued_at: fields.issued_at,
      };
      issued.add(grant);
      return grant;
    },
    isIssued(grant) {
      return !!grant && issued.has(grant);
    },
    isValid(grant) {
      return !!grant && issued.has(grant) && !revoked.has(grant);
    },
    markInvoked(grant) {
      if (!issued.has(grant) || revoked.has(grant) || invoked.has(grant)) {
        return false;
      }
      invoked.add(grant);
      return true;
    },
    revoke(grant) {
      revoked.add(grant);
    },
  };
}
