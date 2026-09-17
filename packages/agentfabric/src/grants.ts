import { Denied } from "./errors.ts";

export type Privilege = "inspect" | "crystallise" | "fallback";

export interface Principal {
  id: string;
  privileges: Privilege[];
}

export interface Grant {
  id: string;
  principal: string;
  capability: string;
  resource: string;
  effects: string[];
}

export class Authority {
  constructor(
    private readonly principals: Map<string, Principal>,
    private readonly grants: Grant[] = [],
  ) {}

  listPrincipals(): Principal[] {
    return [...this.principals.values()];
  }

  listGrants(): Grant[] {
    return [...this.grants];
  }

  requirePrincipal(principalId: string): Principal {
    const principal = this.principals.get(principalId);
    if (!principal) throw new Denied(`unknown principal ${principalId}`);
    return principal;
  }

  requirePrivilege(principalId: string, privilege: Privilege): Principal {
    const principal = this.requirePrincipal(principalId);
    if (!principal.privileges.includes(privilege)) {
      throw new Denied(`principal ${principalId} lacks privilege ${privilege}`);
    }
    return principal;
  }

  allow(
    principalId: string,
    capabilityId: string,
    resource: string | null,
    effects: string[],
  ): void {
    this.requirePrincipal(principalId);
    const resourceKey = resource ?? "*";
    const matched = this.grants.some((grant) =>
      matchesGrant(grant, principalId, capabilityId, resourceKey, effects),
    );
    if (!matched) {
      throw new Denied(
        `principal ${principalId} is not granted ${capabilityId} on ${resourceKey} with effects ${effects.join(",")}`,
      );
    }
  }

  add(grant: Omit<Grant, "id"> & { id?: string }): Grant {
    this.requirePrincipal(grant.principal);
    const record: Grant = {
      id: grant.id ?? `gnt_${this.grants.length + 1}`,
      principal: grant.principal,
      capability: grant.capability,
      resource: grant.resource,
      effects: grant.effects,
    };
    this.grants.push(record);
    return record;
  }
}

export function matchesGrant(
  grant: Grant,
  principal: string,
  capability: string,
  resource: string,
  effects: string[],
): boolean {
  if (grant.principal !== principal) return false;
  if (grant.capability !== "*" && grant.capability !== capability) return false;
  if (grant.resource !== "*" && grant.resource !== resource) return false;
  if (!grant.effects.includes("*") && !effects.every((effect) => grant.effects.includes(effect))) {
    return false;
  }
  return true;
}

export function defaultPrincipals(): Map<string, Principal> {
  return new Map([
    [
      "operator",
      { id: "operator", privileges: ["inspect", "crystallise", "fallback"] },
    ],
    ["guest", { id: "guest", privileges: [] }],
  ]);
}
