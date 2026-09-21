/**
 * AgentSOP — the capability contract layer.
 *
 * This package depends on neither Weave nor AgentFabric (M0-C1). It states what
 * a capability contract says and what a host must check; it executes nothing.
 */

export {
  EFFECT_VOCABULARY_REVISION,
  EFFECTS,
  effectsConflict,
  isEffect,
  type Effect,
} from './effects.js';

export {
  effectSetsEqual,
  isWellFormedRef,
  resourceEffectKey,
  selectorsEqual,
  type EffectSelector,
  type ResourceEffect,
  type ResourceRef,
} from './refs.js';

export {
  FAILURE_CODES,
  FAILURE_PRECEDENCE,
  failurePrecedes,
  type FailureCode,
} from './failures.js';

export {
  createGrantAuthority,
  grantCovers,
  type Grant,
  type GrantAuthority,
  type GrantMatch,
} from './grants.js';

export {
  bindSelectors,
  INFERENCE_ROLES,
  type BindResult,
  type CapabilityContract,
  type InferenceLimits,
  type InferenceRole,
} from './contracts.js';

export { validateCatalogue, type CatalogueResult } from './catalogue.js';

export type {
  CapabilityHost,
  DescribeResult,
  InferCall,
  InferResult,
  InvocationHandle,
  InvocationOutcome,
  InvocationRejected,
  InvokeOptions,
  LookupResult,
  OutcomeLookup,
  ResolutionStatus,
  ResolverContext,
} from './host.js';
