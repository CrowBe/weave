export type { CapabilityView, FabricOptions } from "./fabric.ts";
export { Fabric } from "./fabric.ts";
export type { Grant, Principal, Privilege } from "./grants.ts";
export { Authority, defaultPrincipals } from "./grants.ts";
export { ResourceRegistry } from "./resources.ts";
export type { ResolverBinding, ResolverContext, ResolverFn } from "./resolver.ts";
export { loadResolver, placeholderResolver } from "./resolver.ts";
export {
  Denied,
  DependencyBlocked,
  FabricError,
  KindMismatch,
  ResolverError,
  ResolverUnavailable,
  UndeclaredDependency,
  UnknownCapability,
  UnknownResource,
  Unresolved,
} from "./errors.ts";
