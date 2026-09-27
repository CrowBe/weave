/**
 * Routing — the deterministic selection step inside the gateway
 * (CONTEXT.md "Routing", ARCHITECTURE.md §6).
 *
 * Policy filters by operation, kind, privacy, required quality, context limit
 * and affordability first. Only then does evaluation evidence order what
 * survives. Without enough evidence the configured order stands and the
 * uncertainty is recorded; a cheaper model is not presumed adequate.
 */
import {
  qualityClears,
  type InferenceTerms,
  type Micros,
  type RoutedUnit,
  type RouteTable,
  type RouteTarget,
} from './types.js';

export interface AttemptPrice {
  readonly cost: Micros;
  /** Cached input tokens were omitted from this cost. */
  readonly cache_applied: boolean;
  /** The cache matched but its token count exceeded the input, so the attempt is cold. */
  readonly cache_ignored: boolean;
}

export type ExclusionReason =
  | 'operation_mismatch'
  | 'kind_mismatch'
  | 'destination_not_permitted'
  | 'quality_below_bar'
  | 'context_limit_too_small'
  | 'unaffordable';

export interface RouteExclusion {
  readonly routed_unit_id: string;
  readonly reason: ExclusionReason;
}

export interface RoutingDecision {
  /** Routes to try, in escalation order. Empty when nothing survived. */
  readonly order: readonly RoutedUnit[];
  readonly excluded: readonly RouteExclusion[];
  readonly uncertainty: readonly string[];
}

/**
 * The most an attempt on this route can cost: a full context window in, the
 * settings' output cap out. Charging the ceiling against this bound keeps a
 * reservation honest when a provider reports no usage.
 */
export function worstCaseCost(route: RoutedUnit, terms: InferenceTerms): Micros {
  return tokenCost(terms.max_context_tokens, route.price.input_per_mtok) + tokenCost(route.settings.max_output_tokens, route.price.output_per_mtok);
}

/**
 * Cost of one attempt. Input and output default to the cold window: the full
 * context the terms allow, and the route's output cap. A matching prefix cache
 * drops cached input tokens. A cache larger than the input is ignored.
 */
export function priceAttempt(
  route: RoutedUnit,
  terms: InferenceTerms,
  tokens?: { readonly input_tokens: number; readonly output_tokens: number },
): AttemptPrice {
  const input = tokens?.input_tokens ?? terms.max_context_tokens;
  const output = tokens?.output_tokens ?? route.settings.max_output_tokens;
  const cache = terms.prefix_cache;
  const matches =
    cache !== undefined &&
    terms.prefix_digest !== undefined &&
    cache.routed_unit_id === route.routed_unit_id &&
    cache.prefix_digest === terms.prefix_digest;
  if (matches && cache.cached_tokens > input) {
    return { cost: tokenCost(input, route.price.input_per_mtok) + tokenCost(output, route.price.output_per_mtok), cache_applied: false, cache_ignored: true };
  }
  const uncached = matches ? input - cache.cached_tokens : input;
  return {
    cost: tokenCost(uncached, route.price.input_per_mtok) + tokenCost(output, route.price.output_per_mtok),
    cache_applied: matches && cache.cached_tokens > 0,
    cache_ignored: false,
  };
}

function tokenCost(tokens: number, perMtok: Micros): Micros {
  return (tokens * perMtok) / 1_000_000;
}

/** Expected cost of reaching acceptance, given observed accept rate. */
function expectedCost(route: RoutedUnit, terms: InferenceTerms, minAttempts: number): number | null {
  const evidence = route.evidence;
  if (evidence === undefined || evidence.attempts < minAttempts || evidence.accepted === 0) return null;
  return priceAttempt(route, terms).cost * (evidence.attempts / evidence.accepted);
}

/**
 * Deterministic for a given table and terms: filters preserve declaration
 * order, and the evidence sort breaks ties on `routed_unit_id`.
 */
export function route(
  table: RouteTable,
  target: RouteTarget,
  terms: InferenceTerms,
  minEvidenceAttempts: number,
): RoutingDecision {
  const excluded: RouteExclusion[] = [];
  const eligible: RoutedUnit[] = [];

  for (const unit of table) {
    const reason = excludeReason(unit, target, terms);
    if (reason !== null) {
      excluded.push({ routed_unit_id: unit.routed_unit_id, reason });
      continue;
    }
    eligible.push(unit);
  }

  const uncertainty: string[] = [];
  for (const unit of eligible) {
    if (priceAttempt(unit, terms).cache_ignored) {
      uncertainty.push(`prefix cache ignored for ${unit.routed_unit_id}: cached tokens exceed the input`);
    }
  }
  const thin = eligible.filter((u) => expectedCost(u, terms, minEvidenceAttempts) === null);
  if (thin.length > 0) {
    uncertainty.push(
      `no evaluation evidence for ${thin.map((u) => u.routed_unit_id).join(', ')}; used configured order`,
    );
  }

  // Evidenced routes sort by expected total cost; the rest keep the
  // conservative configured order behind them.
  const evidenced = eligible
    .filter((u) => expectedCost(u, terms, minEvidenceAttempts) !== null)
    .sort((a, b) => {
      const ca = expectedCost(a, terms, minEvidenceAttempts) ?? 0;
      const cb = expectedCost(b, terms, minEvidenceAttempts) ?? 0;
      return ca === cb ? a.routed_unit_id.localeCompare(b.routed_unit_id) : ca - cb;
    });

  return { order: [...evidenced, ...thin], excluded, uncertainty };
}

function excludeReason(unit: RoutedUnit, target: RouteTarget, terms: InferenceTerms): ExclusionReason | null {
  if (unit.operation !== target.operation) return 'operation_mismatch';
  // Safe across the union: the kind vocabularies are disjoint, so a route that
  // serves the right operation can still serve the wrong shape.
  if (unit.kind !== target.kind) return 'kind_mismatch';
  if (!terms.destinations.includes(unit.destination)) return 'destination_not_permitted';
  if (!qualityClears(unit.quality, terms.quality)) return 'quality_below_bar';
  if (unit.context_limit_tokens < terms.max_context_tokens) return 'context_limit_too_small';
  if (worstCaseCost(unit, terms) > terms.cost_ceiling) return 'unaffordable';
  return null;
}
