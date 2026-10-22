/** Pure validation of composition-root data. No credentials are resolved here. */
import {
  EVALUATION_KINDS, GENERATION_KINDS, QUALITY_BARS, TIERS,
  type RoutedUnit, type RouteTable,
} from './types.js';
import { NOUS_PORTAL_ADAPTER, isNousPortalFreeModel } from './adapters/nous-portal-catalogue.js';

const DECISION_AUTH = ['chatgpt-oauth', 'api-key'] as const;

/** Default decision provider; site overrides never change this default. */
export const DECISION_PROVIDER_ID = 'typesafe-jev';

/** Adapter id that serves {@link DECISION_PROVIDER_ID}. It is not the provider id. */
export const DECISION_PROVIDER_ADAPTER = 'typesafe-ai';

/** Upper bound on D3 top-k. Required entries are not counted against it. */
export const PRESELECT_CAP = 8;

/** Documented D3 default when a provider omits k. */
export const PRESELECT_DEFAULT_K = 3;

/** Documented D3 default. Zero leaves the floor off. */
export const PRESELECT_DEFAULT_FLOOR = 0;

/** Highest p(true) an excluded entry may have when D3 narrows. */
export const PRESELECT_DEFAULT_MAX_EXCLUDED = 0.4;

/** Minimum gap from the highest kept non-required p(true) to that excluded p. */
export const PRESELECT_DEFAULT_MIN_MARGIN = 0.3;

const PRESELECT_SITES = ['intake.classify', 'loop.preselect'] as const;

/** `key_env` requires `auth: 'api-key'`. A non-loopback provider requires `auth` or `key_env`. */
export interface DecisionConfig {
  readonly provider: string;
  readonly fallback: string | null;
  readonly sites?: Readonly<Record<string, string>>;
  /** Per-provider D3 top-k, floor, and margin gate. Absent fields use the documented defaults. */
  readonly preselect?: Readonly<Record<string, {
    readonly k?: number;
    readonly floor?: number;
    readonly max_excluded?: number;
    readonly min_margin?: number;
  }>>;
  readonly providers: Record<string, {
    base_url: string;
    model: string;
    auth?: (typeof DECISION_AUTH)[number];
    key_env?: string;
  }>;
}

/** Effective D3 policy for one decision provider. Cap is fixed. */
export interface ResolvedPreselectPolicy {
  readonly k: number;
  readonly floor: number;
  readonly cap: typeof PRESELECT_CAP;
  readonly max_excluded: number;
  readonly min_margin: number;
  readonly provider: 'typesafe-jev' | 'amos';
}

export type RouteConfigResult =
  | { ok: true; table: RouteTable; decision: DecisionConfig }
  | { ok: false; errors: string[] };

/** What the composition root passes to the selected evaluator. No credential. */
export interface DecisionProviderBinding {
  readonly provider: 'typesafe-jev' | 'amos';
  readonly adapter: 'typesafe-ai' | 'amos';
  readonly baseURL: string;
  readonly model: string;
}

/**
 * Select the configured decision provider. `parseRouteConfig` already rejects
 * unsupported defaults and overrides; this fails closed if a caller skips it.
 */
export function bindDecisionProvider(decision: DecisionConfig, site?: string): DecisionProviderBinding {
  if (decision.provider !== DECISION_PROVIDER_ID) {
    throw new Error(`decision.provider: only ${DECISION_PROVIDER_ID} is supported`);
  }
  for (const [key, value] of Object.entries(decision.sites ?? {})) {
    if (!PRESELECT_SITES.includes(key as typeof PRESELECT_SITES[number]) || (value !== 'amos' && value !== DECISION_PROVIDER_ID) ||
        !Object.hasOwn(decision.providers, value)) throw new Error('decision.sites: unsupported provider or site');
  }
  const selected = site !== undefined && Object.hasOwn(decision.sites ?? {}, site) ? decision.sites![site]! : decision.provider;
  const siteMayUseAmos = site !== undefined && PRESELECT_SITES.includes(site as typeof PRESELECT_SITES[number]);
  if (selected !== DECISION_PROVIDER_ID && !(selected === 'amos' && siteMayUseAmos)) throw new Error('decision.sites: unsupported provider or site');
  const provider = decision.providers[selected];
  if (provider === undefined) throw new Error('decision.provider: must exist in providers');
  return {
    provider: selected,
    adapter: selected === 'amos' ? 'amos' : DECISION_PROVIDER_ADAPTER,
    baseURL: provider.base_url,
    model: provider.model,
  };
}

/**
 * Deep-merge a route-table overlay onto a base document. Objects merge; arrays
 * and scalars replace. The composition root uses this for `weave.routes.local.json`.
 * Neither value is mutated. Keys are defined, not assigned, so a parsed
 * `__proto__` key stays an own data key that `parseRouteConfig` rejects as
 * unknown; it cannot replace the merged object's prototype.
 */
export function applyRouteOverlay(base: unknown, overlay: unknown): unknown {
  if (!object(base) || !object(overlay)) return overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    Object.defineProperty(out, key, {
      value: Object.hasOwn(base, key) ? applyRouteOverlay(base[key], value) : value,
      enumerable: true, writable: true, configurable: true,
    });
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
/**
 * Takes a parsed `URL.hostname`. The URL parser canonicalizes every IPv4 form
 * (`127.1`, `2130706433`) to dotted decimal and rejects invalid octets, so only
 * a real 127.0.0.0/8 address matches; a domain such as `127.0.0.1.evil.com`
 * never does.
 */
function loopbackHost(hostname: string): boolean {
  return ['[::1]', 'localhost'].includes(hostname) ||
    /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(hostname);
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
function preselectK(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= PRESELECT_CAP;
}
function preselectFloor(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1;
}
/** Inclusive unit interval. Distinct from the floor, which excludes 1. */
function preselectBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Effective D3 policy for a provider. Missing and out-of-range fields use the
 * defaults. `parseRouteConfig` already rejects a bad document; this stays
 * defined when a caller skips it.
 */
export function resolvePreselectPolicy(
  decision: Pick<DecisionConfig, 'preselect'>,
  provider: 'typesafe-jev' | 'amos',
): ResolvedPreselectPolicy {
  const raw = decision.preselect?.[provider];
  const record = object(raw) ? raw : undefined;
  const kValue = record?.['k'];
  const floorValue = record?.['floor'];
  const maxExcludedValue = record?.['max_excluded'];
  const minMarginValue = record?.['min_margin'];
  const k = preselectK(kValue) ? kValue : PRESELECT_DEFAULT_K;
  const floor = preselectFloor(floorValue) ? floorValue : PRESELECT_DEFAULT_FLOOR;
  const maxExcluded = preselectBound(maxExcludedValue) ? maxExcludedValue : PRESELECT_DEFAULT_MAX_EXCLUDED;
  const minMargin = preselectBound(minMarginValue) ? minMarginValue : PRESELECT_DEFAULT_MIN_MARGIN;
  return {
    k, floor: floor === 0 ? 0 : floor, cap: PRESELECT_CAP,
    max_excluded: maxExcluded === 0 ? 0 : maxExcluded,
    min_margin: minMargin === 0 ? 0 : minMargin,
    provider,
  };
}

/** An evaluate unit whose adapter, kind, and model are the configured Amos provider's. */
function matchingAmosUnit(units: unknown, providers: unknown, kind: 'choice' | 'boolean'): boolean {
  if (!object(providers) || !object(providers['amos']) || !identifier(providers['amos']['model']) || !Array.isArray(units)) return false;
  const model = providers['amos']['model'];
  return units.some((unit: unknown) =>
    object(unit) && unit['operation'] === 'evaluate' && unit['kind'] === kind && unit['adapter'] === 'amos' && unit['model'] === model);
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
      'quality', 'context_limit_tokens', 'settings', 'price', 'rate_limits', 'destination_training_allowed',
      'evidence', 'tier', 'operation', 'kind', 'quota_provider'], path);
    for (const key of ['routed_unit_id', 'context_profile', 'prompt_template', 'adapter', 'model', 'destination']) {
      check(identifier(unit[key]), `${path}.${key}`);
    }
    if (identifier(unit.routed_unit_id)) {
      check(!ids.has(unit.routed_unit_id), `${path}.routed_unit_id: duplicate`);
      ids.add(unit.routed_unit_id);
    }
    check(unit.operation === 'generate' || unit.operation === 'evaluate', `${path}.operation`);
    check(member(unit.kind, unit.operation === 'generate' ? GENERATION_KINDS : unit.operation === 'evaluate' ? EVALUATION_KINDS : []), `${path}.kind: operation/kind pair`);
    check(unit.quota_provider === undefined || identifier(unit.quota_provider), `${path}.quota_provider`);
    check(unit.destination_training_allowed === undefined || typeof unit.destination_training_allowed === 'boolean', `${path}.destination_training_allowed`);
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
    // Nous Portal serves only free models here: a priced ID or price fails closed.
    if (unit.adapter === NOUS_PORTAL_ADAPTER) {
      check(isNousPortalFreeModel(unit.model), `${path}.model: not on the Nous Portal free-model allowlist`);
      if (object(unit.price)) {
        check(unit.price.input_per_mtok === 0 && unit.price.output_per_mtok === 0, `${path}.price: Nous Portal units must be priced at zero`);
      }
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
        if (object(limit)) keys(limit, ['requests', 'tokens', 'window_ms', 'pace'], `${path}.rate_limits[${j}]`);
        check(object(limit) && positiveInteger(limit.requests) && number(limit.window_ms) && limit.window_ms > 0 &&
          (limit.tokens === undefined || positiveInteger(limit.tokens)) &&
          (limit.pace === undefined || typeof limit.pace === 'boolean'), `${path}.rate_limits[${j}]`);
      });
    }
  });
  const decision = json.decision;
  if (!object(decision)) check(false, 'decision');
  else {
    keys(decision, ['provider', 'fallback', 'providers', 'sites', 'preselect'], 'decision');
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
        check(['typesafe-jev', 'amos', 'openai-decisions'].includes(id), 'decision.providers: unknown provider');
        if (!object(provider)) { check(false, path); return; }
        keys(provider, ['base_url', 'model', 'auth', 'key_env'], path);
        const url = providerUrl(provider.base_url);
        check(url !== null, `${path}.base_url: expected HTTPS or loopback HTTP URL without userinfo, query, or fragment`);
        if (id === 'amos') {
          check(url !== null && loopbackHost(url.hostname), `${path}.base_url: Amos requires loopback`);
          check(provider.auth === undefined && provider.key_env === undefined, `${path}: Amos requires no auth`);
        }
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
      if (decision.sites !== undefined) {
        check(object(decision.sites), 'decision.sites');
        if (object(decision.sites)) for (const [site, selected] of Object.entries(decision.sites)) {
          const amosKind = site === 'intake.classify' ? 'choice' : site === 'loop.preselect' ? 'boolean' : null;
          check(amosKind !== null, 'decision.sites: unknown or unsupported site');
          check(selected === 'amos' || selected === DECISION_PROVIDER_ID, 'decision.sites: unknown provider');
          check(typeof selected === 'string' && Object.hasOwn(decision.providers, selected), 'decision.sites: provider must exist');
          if (selected === 'amos' && amosKind !== null) check(matchingAmosUnit(json.units, decision.providers, amosKind),
            amosKind === 'choice' ? 'decision.sites: no matching Amos choice unit' : 'decision.sites: no matching Amos boolean unit');
        }
      }
      if (decision.preselect !== undefined) {
        check(object(decision.preselect), 'decision.preselect');
        if (object(decision.preselect)) for (const [id, policy] of Object.entries(decision.preselect)) {
          const path = `decision.preselect.${id}`;
          check(id === DECISION_PROVIDER_ID || id === 'amos', `${path}: only typesafe-jev or amos is supported`);
          check(Object.hasOwn(decision.providers, id), `${path}: provider must exist`);
          if (!object(policy)) { check(false, path); continue; }
          keys(policy, ['k', 'floor', 'max_excluded', 'min_margin'], path);
          if (policy['k'] !== undefined) check(preselectK(policy['k']), `${path}.k`);
          if (policy['floor'] !== undefined) check(preselectFloor(policy['floor']), `${path}.floor`);
          if (policy['max_excluded'] !== undefined) check(preselectBound(policy['max_excluded']), `${path}.max_excluded`);
          if (policy['min_margin'] !== undefined) check(preselectBound(policy['min_margin']), `${path}.min_margin`);
        }
      }
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
