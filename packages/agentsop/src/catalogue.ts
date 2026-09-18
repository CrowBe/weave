import { selectorsEqual } from './refs.js';
import type { CapabilityContract } from './contracts.js';
import type { FailureCode } from './failures.js';

export type CatalogueResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'INVALID_CATALOGUE'; readonly reason: string };

/**
 * Catalogue graph rules: every dependency exists, the graph is acyclic, and a
 * contract's declared effect selectors equal its authorized effect selectors.
 */
export function validateCatalogue(contracts: readonly CapabilityContract[]): CatalogueResult {
  const byId = new Map<string, CapabilityContract>();
  for (const contract of contracts) {
    if (byId.has(contract.id)) {
      return fail(`duplicate capability id ${contract.id}`);
    }
    byId.set(contract.id, contract);
  }
  for (const contract of contracts) {
    if (!selectorsEqual(contract.effects, contract.permissions)) {
      return fail(`${contract.id}: declared effects must equal authorized effects`);
    }
    for (const dep of contract.depends_on) {
      if (!byId.has(dep)) {
        return fail(`${contract.id} depends on missing ${dep}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): CatalogueResult => {
    if (visited.has(id)) {
      return { ok: true };
    }
    if (visiting.has(id)) {
      return fail(`cyclic dependency involving ${id}`);
    }
    visiting.add(id);
    const contract = byId.get(id) as CapabilityContract;
    for (const dep of contract.depends_on) {
      const nested = visit(dep);
      if (!nested.ok) {
        return nested;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return { ok: true };
  };
  for (const contract of contracts) {
    const result = visit(contract.id);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

function fail(reason: string): { ok: false; code: 'INVALID_CATALOGUE'; reason: string } {
  return { ok: false, code: 'INVALID_CATALOGUE' satisfies FailureCode as 'INVALID_CATALOGUE', reason };
}
