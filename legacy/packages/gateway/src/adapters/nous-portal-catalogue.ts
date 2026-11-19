/**
 * Nous Portal free-model allowlist and catalogue price check, without the SDK.
 *
 * Pure data and pure functions. Route-config parsing imports this module, so it
 * must not pull `@ai-sdk/*` into `@weave/gateway`'s root entry; the adapter in
 * `./nous-portal.ts` imports it too and re-exports the public names.
 */

export const NOUS_PORTAL_ADAPTER = 'nous-portal';

/**
 * The free-model allowlist: IDs whose every catalogue pricing field read "0"
 * with no `overrides` in the live catalogue on 17 Oct 2026. Every one has a paid
 * twin with the same name minus `:free`; no twin is listed here, and a unit or
 * call naming one is refused. Catalogue pricing is discovery data, not a
 * serving guarantee: on 25 Sep 2026 a $0-listed ID was refused as "no longer
 * free". So the adapter also checks the live catalogue and the response cost.
 * The Laguna IDs were listed as expiring on 31 Oct 2026.
 * LongCat 2.5 Preview and Beam are opt-in, expiring entries in the separate
 * `NOUS_PORTAL_PROMO_MODELS` map; they are never default allowlist members.
 */
export const NOUS_PORTAL_FREE_MODELS = {
  solarMini: 'upstage/solar-mini4:free',
  longcat: 'meituan/longcat-2.0:free',
  lagunaS: 'poolside/laguna-s-2.1:free',
  lagunaXS: 'poolside/laguna-xs-2.1:free',
  stepFlash: 'stepfun/step-3.7-flash:free',
  stepPreview: 'stepfun/step-5-preview:free',
} as const;

/**
 * Explicit adapter opt-in only; all catalogue and response cost checks still
 * apply. `expires_at` is epoch milliseconds: 2026-10-23T10:30:00+11:00.
 * Missing injected time or time at/after this boundary refuses dispatch.
 */
export const NOUS_PORTAL_PROMO_MODELS = Object.freeze({
  longcat25: Object.freeze({ id: 'meituan/longcat-2.5-preview:free', expires_at: 1_792_711_800_000 }),
  beam: Object.freeze({ id: 'reflection/beam-1.0-501b-a23b:free', expires_at: 1_792_711_800_000 }),
} as const);

export type NousPortalFreeModel = (typeof NOUS_PORTAL_FREE_MODELS)[keyof typeof NOUS_PORTAL_FREE_MODELS];

const FREE_MODEL_IDS: ReadonlySet<string> = new Set(Object.values(NOUS_PORTAL_FREE_MODELS));

/** Default allowlist only, excluding promos. No trimming, case folding, or suffix inference. */
export function isNousPortalFreeModel(model: unknown): model is NousPortalFreeModel {
  return typeof model === 'string' && FREE_MODEL_IDS.has(model);
}

/**
 * What the live catalogue says about one model: every price exactly zero
 * (`free`), any other price or an unreadable one (`priced`), not listed
 * (`absent`), or a catalogue body that is not a model list (`malformed`).
 */
export type NousPortalCatalogueVerdict = 'free' | 'priced' | 'absent' | 'malformed';

export function nousPortalCatalogueVerdict(body: unknown, model: string): NousPortalCatalogueVerdict {
  if (!object(body) || !Array.isArray(body['data'])) return 'malformed';
  const entries = body['data'].filter((entry) => object(entry) && entry['id'] === model);
  if (entries.length === 0) return 'absent';
  // A duplicate listing must not let one zero-priced entry vouch for another.
  return entries.every((entry) => freePricing((entry as Record<string, unknown>)['pricing'])) ? 'free' : 'priced';
}

/** Override tiers carry these thresholds beside their prices; they are not prices. */
const OVERRIDE_THRESHOLDS: ReadonlySet<string> = new Set(['min_prompt_tokens', 'utc_start', 'utc_end']);

/**
 * Every scalar pricing field must be numeric zero or an unsigned decimal
 * string with an all-zero mantissa matching ^0+(\.0+)?([eE][+-]?[0-9]+)?$.
 * Nonzero mantissas fail closed even when Number(value) underflows to zero.
 * Prompt and completion must be present, nested objects such as `original`
 * included, and every `overrides` tier's prices too. Unreadable prices fail closed.
 */
function freePricing(pricing: unknown): boolean {
  if (!object(pricing) || !Object.hasOwn(pricing, 'prompt') || !Object.hasOwn(pricing, 'completion')) return false;
  return Object.entries(pricing).every(([key, value]) => {
    if (key !== 'overrides') return zeroLeaves(value);
    return (
      Array.isArray(value) &&
      value.every(
        (tier) =>
          object(tier) &&
          Object.keys(tier).some((field) => !OVERRIDE_THRESHOLDS.has(field)) &&
          Object.entries(tier).every(([field, price]) => OVERRIDE_THRESHOLDS.has(field) || zeroLeaves(price)),
      )
    );
  });
}

function zeroLeaves(value: unknown): boolean {
  if (object(value)) return Object.keys(value).length > 0 && Object.values(value).every(zeroLeaves);
  // A leading sign is anomalous and outside the unsigned price grammar;
  // fail closed: refusing can never meter a paid call as $0.
  return (
    value === 0 || (typeof value === 'string' && /^0+(\.0+)?([eE][+-]?[0-9]+)?$/.test(value) && Number(value) === 0)
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
