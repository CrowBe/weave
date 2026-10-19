/** budget.policy@1: deterministic policy over injected whole-account observations. */
import { route, type RoutingDecision, type RouteExclusion } from './routing.js';
import type { BudgetReason, InferenceTerms, ProviderAvailability, QuotaSnapshot, RouteTable, RouteTarget, RoutedUnit } from './types.js';

export const BUDGET_POLICY = Object.freeze({
  id: 'budget.policy@1' as const,
  weekly_percent_remaining: 20,
  five_hour_percent_remaining: 10,
  max_snapshot_age_ms: 60_000,
});
type Window = QuotaSnapshot['providers'][number]['windows'][number];
interface Gate { reason: BudgetReason; until: number | null }
export interface BudgetRoutingDecision extends RoutingDecision {
  readonly pause?: Gate;
  readonly downgraded: boolean;
}
function reset(window: Window | undefined, now: number): number | null {
  return window?.resetsAt !== null && window?.resetsAt !== undefined &&
    Number.isFinite(window.resetsAt) && window.resetsAt > now ? window.resetsAt : null;
}
function percent(window: Window | undefined): number | null {
  const value = window?.percentRemaining;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
function gate(unit: RoutedUnit, snapshot: QuotaSnapshot | undefined, now: number): Gate | undefined {
  const strong = unit.tier === 'strong';
  const providers = unit.quota_provider === undefined ? [] :
    snapshot?.providers.filter(p => p.provider === unit.quota_provider) ?? [];
  const provider = providers.length === 1 ? providers[0] : undefined;
  const weeks = provider?.windows.filter(w => w.id === 'seven_day') ?? [];
  const week = weeks.length === 1 ? weeks[0] : undefined;
  const remaining = percent(week);
  // Ambiguity cannot erase a known cap. Inspect every matching account
  // observation before requiring unique data for a strong route to clear.
  const capped = providers.flatMap(p => p.windows).filter(w => w.id === 'seven_day' &&
    percent(w) !== null && percent(w)! <= BUDGET_POLICY.weekly_percent_remaining);
  if (capped.length > 0) {
    const resets = capped.map(w => reset(w, now));
    return { reason: 'weekly_budget_cap', until: resets.some(t => t === null) ? null : Math.min(...resets as number[]) };
  }
  const fresh = snapshot !== undefined && Number.isFinite(snapshot.observed_at) &&
    snapshot.observed_at <= now && now - snapshot.observed_at <= BUDGET_POLICY.max_snapshot_age_ms &&
    provider?.status === 'fresh' && reset(week, now) !== null;
  const pace = week?.pace?.status;
  const failClosed = strong || (unit.tier === 'standard' && unit.quota_provider !== undefined);
  if (failClosed && (!fresh || remaining === null || !['ahead', 'on_pace', 'behind'].includes(pace ?? ''))) {
    return { reason: 'quota_unknown', until: null };
  }
  const lowHours = providers.flatMap(p => p.windows).filter(w => w.id === 'five_hour' &&
    percent(w) !== null && percent(w)! <= BUDGET_POLICY.five_hour_percent_remaining);
  if (lowHours.length > 0) {
    const resets = lowHours.map(w => reset(w, now));
    return { reason: 'five_hour_budget_low', until: resets.some(t => t === null) ? null : Math.min(...resets as number[]) };
  }
  if (strong && pace === 'ahead') return { reason: 'budget_pace_ahead', until: reset(week, now) };
  return undefined;
}

/** Hard routing constraints run first. Downgrade changes tier only, never quality or authority. */
export function budgetRoute(table: RouteTable, target: RouteTarget, terms: InferenceTerms,
  minEvidence: number, availability: ProviderAvailability | undefined,
  snapshot: QuotaSnapshot | undefined, now: number, containsCredentials = false): BudgetRoutingDecision {
  const base = route(table, target, terms, minEvidence, availability, containsCredentials);
  if (base.invalid !== undefined) return { ...base, downgraded: false };
  const excluded: RouteExclusion[] = [...base.excluded];
  const blocked: Gate[] = [];
  const eligible = base.order.filter(unit => {
    const result = gate(unit, snapshot, now);
    if (!result) return true;
    excluded.push({ routed_unit_id: unit.routed_unit_id, reason: result.reason });
    blocked.push(result);
    return false;
  });
  if (eligible.length === 0 && blocked.some(g => g.reason === 'budget_pace_ahead') && !terms.audit &&
      (terms.tier === 'strong' || target.tier === 'strong')) {
    const lower = budgetRoute(table, { ...target, tier: 'standard' }, { ...terms, tier: 'standard' },
      minEvidence, availability, snapshot, now, containsCredentials);
    if (lower.order.length === 0 && !lower.pause) {
      const ahead = blocked.find(g => g.reason === 'budget_pace_ahead')!;
      return { ...lower, pause: ahead, downgraded: true };
    }
    return { ...lower, excluded: [...excluded.filter(e => e.reason !== 'tier_mismatch'), ...lower.excluded],
      uncertainty: [...base.uncertainty, ...lower.uncertainty, 'budget.policy@1: strong downgraded to standard'], downgraded: true };
  }
  // A known reset only permits a recheck. An unknown blocker needs a new
  // observation, so no scheduled resume may imply permission.
  const until = blocked.some(g => g.until === null) ? null : Math.min(...blocked.map(g => g.until!));
  const reason = blocked.find(g => g.reason === 'weekly_budget_cap')?.reason ?? blocked[0]?.reason;
  return { order: eligible, excluded, uncertainty: base.uncertainty, downgraded: false,
    ...(eligible.length === 0 && reason ? { pause: { reason, until } } : {}) };
}
