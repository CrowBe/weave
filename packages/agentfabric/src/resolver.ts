import type { Capability } from "@weave/agentsop";
import { DependencyFailed, ResolverError, UndeclaredDependency } from "./errors.ts";
import type { Fabric } from "./fabric.ts";

export type ResolverFn = (
  ctx: ResolverContext,
  input: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface ResolverBinding {
  capability: string;
  label: string;
  fn: ResolverFn;
}

export interface ResolverContext {
  principal: string;
  capability: string;
  invoke(capabilityId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  locator(ref: string): string;
}

export function loadResolver(source: string): ResolverFn {
  const fn = new Function(
    "ctx",
    "input",
    `"use strict";\n${source}`,
  ) as ResolverFn;
  return (ctx, input) => fn(ctx, input);
}

export function placeholderResolver(): ResolverFn {
  return (_ctx, input) => input;
}

export function createResolverContext(
  fabric: Fabric,
  principal: string,
  capability: Capability,
): ResolverContext {
  return {
    principal,
    capability: capability.id,
    async invoke(capabilityId, input) {
      if (!capability.depends_on.includes(capabilityId)) {
        throw new UndeclaredDependency(
          `${capability.id} does not declare a dependency on ${capabilityId}`,
        );
      }
      const result = await fabric.invoke(principal, capabilityId, input, { nested: true });
      if (!result.ok || !result.output) {
        throw new DependencyFailed(
          `${capabilityId} failed: ${result.error?.code ?? "RESOLVER_ERROR"}: ${result.error?.message ?? ""}`,
        );
      }
      return result.output;
    },
    locator(ref) {
      const record = fabric.resources.get(ref);
      if (!record) throw new ResolverError(`unknown locator for ${ref}`);
      return record.locator;
    },
  };
}
