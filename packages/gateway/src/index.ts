/**
 * The inference gateway's public surface.
 *
 * Provider adapters are deliberately absent: they live behind
 * `@weave/gateway/vercel-ai-gateway` and its future peers, so importing the
 * gateway never pulls a provider SDK into the importer's dependency graph.
 */
export { createInferenceGateway, type GatewayConfig } from './gateway.js';
export type { WeftPort, WeftRecordShape } from './weft.js';
export {
  prefixCacheUse,
  priceAttempt,
  route,
  worstCaseCost,
  type AttemptPrice,
  type ExclusionReason,
  type PrefixCacheUse,
  type RouteExclusion,
  type RoutingDecision,
} from './routing.js';
export * from './types.js';
export { resolveTypesafeApiKey } from './typesafe-key.js';

export {
  applyRouteOverlay,
  bindDecisionProvider,
  parseRouteConfig,
  resolvePreselectPolicy,
  DECISION_PROVIDER_ADAPTER,
  DECISION_PROVIDER_ID,
  PRESELECT_CAP,
  PRESELECT_DEFAULT_FLOOR,
  PRESELECT_DEFAULT_K,
  PRESELECT_DEFAULT_MAX_EXCLUDED,
  PRESELECT_DEFAULT_MIN_MARGIN,
  type DecisionConfig,
  type DecisionProviderBinding,
  type ResolvedPreselectPolicy,
  type RouteConfigResult,
} from './config.js';

export { BUDGET_POLICY, budgetRoute } from './budget.js';

export {
  applyPreferences,
  loadPreferenceSet,
  PREFERENCE_SCHEMA,
  type PreferenceEntry,
  type PreferenceLoad,
  type PreferenceMeasure,
  type PreferenceSet,
  type PreferenceVerdict,
} from './preferences.js';
