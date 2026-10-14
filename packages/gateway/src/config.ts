/** Pure validation of composition-root data. No credentials are resolved here. */
import {
  EVALUATION_KINDS, GENERATION_KINDS, QUALITY_BARS, TIERS,
  type RoutedUnit, type RouteTable,
} from './types.js';

export interface DecisionConfig {
  readonly provider: string;
  readonly fallback: string | null;
  readonly providers: Record<string, {
    base_url: string;
    model: string;
    auth?: string;
    key_env?: string;
  }>;
}

export type RouteConfigResult =
  | { ok: true; table: RouteTable; decision: DecisionConfig }
  | { ok: false; errors: string[] };

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function positiveInteger(value: unknown): boolean {
  return number(value) && Number.isInteger(value) && value > 0;
}
function member(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}
function httpUrl(value: unknown): boolean {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' && url.password === '';
  } catch { return false; }
}

/** Errors name fields, never echo configuration values or credentials. */
export function parseRouteConfig(json: unknown): RouteConfigResult {
  const errors: string[] = [];
  const check = (valid: boolean, path: string) => { if (!valid) errors.push(`invalid ${path}`); };
  if (!object(json)) return { ok: false, errors: ['invalid route config: expected object'] };
  const ids = new Set<string>();
  check(Array.isArray(json.units), 'units: expected array');
  if (Array.isArray(json.units)) json.units.forEach((unit: unknown, i: number) => {
    const path = `units[${i}]`;
    if (!object(unit)) { check(false, path); return; }
    for (const key of ['routed_unit_id', 'context_profile', 'prompt_template', 'adapter', 'model', 'destination']) {
      check(text(unit[key]), `${path}.${key}`);
    }
    if (text(unit.routed_unit_id)) {
      check(!ids.has(unit.routed_unit_id), `${path}.routed_unit_id: duplicate`);
      ids.add(unit.routed_unit_id);
    }
    check(unit.operation === 'generate' || unit.operation === 'evaluate', `${path}.operation`);
    check(member(unit.kind, unit.operation === 'generate' ? GENERATION_KINDS : unit.operation === 'evaluate' ? EVALUATION_KINDS : []), `${path}.kind: operation/kind pair`);
    check(unit.tier === undefined || member(unit.tier, TIERS), `${path}.tier`);
    check(member(unit.quality, QUALITY_BARS), `${path}.quality`);
    for (const key of ['context_profile_version', 'prompt_template_version', 'context_limit_tokens']) {
      check(positiveInteger(unit[key]), `${path}.${key}`);
    }
    if (!object(unit.settings)) check(false, `${path}.settings`);
    else {
      check(positiveInteger(unit.settings.max_output_tokens), `${path}.settings.max_output_tokens`);
      check(unit.settings.temperature === undefined || number(unit.settings.temperature), `${path}.settings.temperature`);
    }
    if (!object(unit.price)) check(false, `${path}.price`);
    else for (const key of ['input_per_mtok', 'output_per_mtok']) check(number(unit.price[key]), `${path}.price.${key}`);
    if (unit.evidence !== undefined) {
      if (!object(unit.evidence)) check(false, `${path}.evidence`);
      else {
        const { attempts, accepted } = unit.evidence;
        check(number(attempts) && Number.isInteger(attempts), `${path}.evidence.attempts`);
        check(number(accepted) && Number.isInteger(accepted) && number(attempts) && accepted <= attempts, `${path}.evidence.accepted`);
      }
    }
    if (unit.rate_limits !== undefined) {
      check(Array.isArray(unit.rate_limits), `${path}.rate_limits`);
      if (Array.isArray(unit.rate_limits)) unit.rate_limits.forEach((limit: unknown, j: number) => {
        check(object(limit) && positiveInteger(limit.requests) && number(limit.window_ms) && limit.window_ms > 0, `${path}.rate_limits[${j}]`);
      });
    }
  });
  const decision = json.decision;
  if (!object(decision)) check(false, 'decision');
  else {
    check(text(decision.provider), 'decision.provider');
    check(decision.fallback === null || text(decision.fallback), 'decision.fallback');
    check(decision.fallback === null || decision.fallback !== decision.provider, 'decision.fallback: must differ from provider');
    if (!object(decision.providers)) check(false, 'decision.providers');
    else {
      check(text(decision.provider) && Object.hasOwn(decision.providers, decision.provider), 'decision.provider: must exist in providers');
      check(decision.fallback === null || (text(decision.fallback) && Object.hasOwn(decision.providers, decision.fallback)), 'decision.fallback: must exist in providers');
      Object.values(decision.providers).forEach((provider, i) => {
        const path = `decision.providers[${i}]`;
        if (!object(provider)) { check(false, path); return; }
        check(httpUrl(provider.base_url), `${path}.base_url: expected http(s) URL without credentials`);
        check(text(provider.model), `${path}.model`);
        for (const key of ['auth', 'key_env']) check(provider[key] === undefined || text(provider[key]), `${path}.${key}`);
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  // Every field of the public shapes has been checked above. No ambient data is added.
  return { ok: true, table: json.units as RoutedUnit[], decision: decision as unknown as DecisionConfig };
}
