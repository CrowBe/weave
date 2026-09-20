/**
 * The inference gateway's public surface.
 *
 * Provider adapters are deliberately absent: they live behind
 * `@weave/gateway/vercel-ai-gateway` and its future peers, so importing the
 * gateway never pulls a provider SDK into the importer's dependency graph.
 */
export { createInferenceGateway, type GatewayConfig } from './gateway.js';
export {
  route,
  worstCaseCost,
  type ExclusionReason,
  type RouteExclusion,
  type RoutingDecision,
} from './routing.js';
export * from './types.js';
