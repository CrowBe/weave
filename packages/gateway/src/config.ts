/** Pure validation of composition-root data. No credentials are resolved here. */
import {
  EVALUATION_KINDS, GENERATION_KINDS, QUALITY_BARS, TIERS,
  type RoutedUnit, type RouteTable,
} from './types.js';

const DECISION_AUTH = ['chatgpt-oauth', 'api-key'] as const;

/** The only decision provider this phase installs. OpenAI Decisions stays deferred. */
export const DECISION_PROVIDER_ID = 'typesafe-jev';

/** Adapter id that serves {@link DECISION_PROVIDER_ID}. It is not the provider id. */
export const DECISION_PROVIDER_ADAPTER = 'typesafe-ai';

/** `key_env` requires `auth: 'api-key'`. A non-loopback provider requires `auth` or `key_env`. */
export interface DecisionConfig {
  readonly provider: string;
  readonly fallback: string | null;
  readonly providers: Record<string, {
    base_url: string;
    model: string;
    auth?: (typeof DECISION_AUTH)[number];
    key_env?: string;
  }>;
}

export type RouteConfigResult =
  | { ok: true; table: RouteTable; decision: DecisionConfig }
  | { ok: false; errors: string[] };

/** What the composition root passes to the TypeSafe evaluator. No credential. */
export interface DecisionProviderBinding {
  readonly provider: typeof DECISION_PROVIDER_ID;
  readonly adapter: typeof DECISION_PROVIDER_ADAPTER;
  readonly baseURL: string;
  readonly model: string;
}

/**
 * Select the configured decision provider. `parseRouteConfig` already rejects
 * anything other than `typesafe-jev`; this fails closed if a caller skips it.
 */
export function bindDecisionProvider(decision: DecisionConfig): DecisionProviderBinding {
  if (decision.provider !== DECISION_PROVIDER_ID) {
    throw new Error(`decision.provider: only ${DECISION_PROVIDER_ID} is supported`);
  }
  const provider = decision.providers[DECISION_PROVIDER_ID];
  if (provider === undefined) throw new Error('decision.provider: must exist in providers');
  return {
    provider: DECISION_PROVIDER_ID,
    adapter: DECISION_PROVIDER_ADAPTER,
    baseURL: provider.base_url,
    model: provider.model,
  };
}

/**
 * Deep-merge a route-table overlay onto a base document. Objects merge; arrays
 * and scalars replace. The composition root uses this for `weave.routes.local.json`.
 * Neither value is mutated.
 */
export function applyRouteOverlay(base: unknown, overlay: unknown): unknown {
  if (!object(base) || !object(overlay)) return overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = Object.hasOwn(base, key) ? applyRouteOverlay(base[key], value) : value;
  }
  return out;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
/** Identity fields compare and are sent as written, so surrounding whitespace is invalid. */
function identifier(value: unknown): value is string {
  return text(value) && value === value.trim();
}
function loopbackHost(hostname: string): boolean {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(hostname);
}
/** A usable provider URL, or null when the transport rules reject it. */
function providerUrl(value: unknown): URL | null {
  // `URL.search` and `URL.hash` are empty for a bare `?` or `#`, so reject the characters themselves.
  if (!text(value) || value.includes('?') || value.includes('#')) return null;
  try {
    const url = new URL(value);
    const loopback = loopbackHost(url.hostname);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
      url.username === '' && url.password === '' && url.search === '' && url.hash === '') return url;
    return null;
  } catch { return null; }
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

/** An evaluate unit whose adapter and model are the configured TypeSafe provider's. */
function matchingEvaluateUnit(units: unknown, provider: unknown): boolean {
  if (!object(provider) || !identifier(provider.model) || !Array.isArray(units)) return false;
  const model = provider.model;
  return units.some((unit: unknown) =>
    object(unit) &&
    unit.operation === 'evaluate' &&
    unit.adapter === DECISION_PROVIDER_ADAPTER &&
    unit.model === model);
}

/** Errors name fields, never echo field values. */
export function parseRouteConfig(json: unknown): RouteConfigResult {
  const errors: string[] = [];
  const check = (valid: boolean, path: string) => { if (!valid) errors.push(`invalid ${path}`); };
  if (!object(json)) return { ok: false, errors: ['invalid route config: expected object'] };
  const keys = (value: ObjectValue, allowed: readonly string[], path: string) => {
    for (const key of Object.keys(value)) check(allowed.includes(key), `${path ? path + '.' : ''}${key}: unknown key`);
  };
  keys(json, ['units', 'decision'], '');
  const ids = new Set<string>();
  check(Array.isArray(json.units), 'units: expected array');
  if (Array.isArray(json.units)) json.units.forEach((unit: unknown, i: number) => {
    const path = `units[${i}]`;
    if (!object(unit)) { check(false, path); return; }
    keys(unit, ['routed_unit_id', 'context_profile', 'context_profile_version',
      'prompt_template', 'prompt_template_version', 'adapter', 'model', 'destination',
      'quality', 'context_limit_tokens', 'settings', 'price', 'rate_limits',
      'evidence', 'tier', 'operation', 'kind'], path);
    for (const key of ['routed_unit_id', 'context_profile', 'prompt_template', 'adapter', 'model', 'destination']) {
      check(identifier(unit[key]), `${path}.${key}`);
    }
    if (identifier(unit.routed_unit_id)) {
      check(!ids.has(unit.routed_unit_id), `${path}.routed_unit_id: duplicate`);
      ids.add(unit.routed_unit_id);
    }
    check(unit.operation === 'generate' || unit.operation === 'evaluate', `${path}.operation`);
    check(member(unit.kind, unit.operation === 'generate' ? GENERATION_KINDS : unit.operation === 'evaluate' ? EVALUATION_KINDS : []), `${path}.kind: operation/kind pair`);
    check(unit.tier === undefined || member(unit.tier, TIERS), `${path}.tier`);
    check(unit.tier !== 'decision' || unit.operation === 'evaluate', `${path}.tier: decision tier requires evaluate`);
    check(member(unit.quality, QUALITY_BARS), `${path}.quality`);
    for (const key of ['context_profile_version', 'prompt_template_version', 'context_limit_tokens']) {
      check(positiveInteger(unit[key]), `${path}.${key}`);
    }
    if (!object(unit.settings)) check(false, `${path}.settings`);
    else {
      keys(unit.settings, ['max_output_tokens', 'temperature'], `${path}.settings`);
      check(positiveInteger(unit.settings.max_output_tokens), `${path}.settings.max_output_tokens`);
      check(unit.settings.temperature === undefined || number(unit.settings.temperature), `${path}.settings.temperature`);
    }
    if (!object(unit.price)) check(false, `${path}.price`);
    else {
      keys(unit.price, ['input_per_mtok', 'output_per_mtok'], `${path}.price`);
      for (const key of ['input_per_mtok', 'output_per_mtok']) check(number(unit.price[key]), `${path}.price.${key}`);
    }
    if (unit.evidence !== undefined) {
      if (!object(unit.evidence)) check(false, `${path}.evidence`);
      else {
        keys(unit.evidence, ['attempts', 'accepted'], `${path}.evidence`);
        const { attempts, accepted } = unit.evidence;
        check(number(attempts) && Number.isInteger(attempts), `${path}.evidence.attempts`);
        check(number(accepted) && Number.isInteger(accepted) && number(attempts) && accepted <= attempts, `${path}.evidence.accepted`);
      }
    }
    if (unit.rate_limits !== undefined) {
      check(Array.isArray(unit.rate_limits), `${path}.rate_limits`);
      if (Array.isArray(unit.rate_limits)) unit.rate_limits.forEach((limit: unknown, j: number) => {
        if (object(limit)) keys(limit, ['requests', 'window_ms'], `${path}.rate_limits[${j}]`);
        check(object(limit) && positiveInteger(limit.requests) && number(limit.window_ms) && limit.window_ms > 0, `${path}.rate_limits[${j}]`);
      });
    }
  });
  const decision = json.decision;
  if (!object(decision)) check(false, 'decision');
  else {
    keys(decision, ['provider', 'fallback', 'providers'], 'decision');
    check(identifier(decision.provider), 'decision.provider');
    check(decision.fallback === null || identifier(decision.fallback), 'decision.fallback');
    check(decision.fallback === null || decision.fallback !== decision.provider, 'decision.fallback: must differ from provider');
    if (!object(decision.providers)) check(false, 'decision.providers');
    else {
      check(identifier(decision.provider) && Object.hasOwn(decision.providers, decision.provider), 'decision.provider: must exist in providers');
      check(decision.fallback === null || (identifier(decision.fallback) && Object.hasOwn(decision.providers, decision.fallback)), 'decision.fallback: must exist in providers');
      check(decision.provider === DECISION_PROVIDER_ID, `decision.provider: only ${DECISION_PROVIDER_ID} is supported`);
      Object.entries(decision.providers).forEach(([id, provider]) => {
        const path = `decision.providers.${id}`;
        check(identifier(id), 'decision.providers: expected unpadded identifier');
        if (!object(provider)) { check(false, path); return; }
        keys(provider, ['base_url', 'model', 'auth', 'key_env'], path);
        const url = providerUrl(provider.base_url);
        check(url !== null, `${path}.base_url: expected HTTPS or loopback HTTP URL without userinfo, query, or fragment`);
        check(identifier(provider.model), `${path}.model`);
        check(provider.auth === undefined || member(provider.auth, DECISION_AUTH), `${path}.auth`);
        check(provider.key_env === undefined || (typeof provider.key_env === 'string' &&
          /^[A-Z_][A-Z0-9_]*$/.test(provider.key_env)), `${path}.key_env: expected environment variable name`);
        check(provider.auth !== 'chatgpt-oauth' || provider.key_env === undefined,
          `${path}.key_env: not allowed with chatgpt-oauth`);
        check(provider.auth !== 'api-key' || provider.key_env !== undefined,
          `${path}.key_env: required with api-key`);
        check(provider.key_env === undefined || provider.auth === 'api-key',
          `${path}.auth: required api-key with key_env`);
        check(url === null || loopbackHost(url.hostname) || provider.auth !== undefined || provider.key_env !== undefined,
          `${path}: expected auth or key_env`);
      });
      // Issue #47: the selected provider must have an evaluate unit this phase can call.
      // Match the adapter and the model. A provider id is not an adapter id.
      if (decision.provider === DECISION_PROVIDER_ID) {
        const provider = decision.providers[DECISION_PROVIDER_ID];
        check(matchingEvaluateUnit(json.units, provider), 'decision.provider: no matching evaluate unit');
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  // Every field of the public shapes has been checked above. No ambient data is added.
  return { ok: true, table: structuredClone(json.units) as RoutedUnit[], decision: structuredClone(decision) as unknown as DecisionConfig };
}
