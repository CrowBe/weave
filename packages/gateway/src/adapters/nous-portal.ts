/**
 * Provider adapter: Nous Portal.
 *
 * A second source of free inference, and a better-instrumented one. The
 * protocol is the same OpenAI-compatible one OpenRouter speaks, so it is
 * implemented once in `./openai-compatible.ts`; what is here is the base URL,
 * the identity, and the one thing Nous does differently and better.
 *
 * Measured on 2026-09-19 against `meituan/longcat-2.0:free`:
 *
 * - Every response, including a success, carries the full `x-ratelimit-*` set
 *   at two granularities: `-requests` and `-tokens` per minute, and the same
 *   pair suffixed `-1h`. A free-tier key reported 400 requests/minute,
 *   16800/hour, 4M tokens/minute and 168M/hour — limits generous enough that
 *   the throttle is unlikely to be what stops a caller.
 * - `x-ratelimit-reset-requests` is **relative seconds** (`59.999`), not an
 *   absolute timestamp, so a delay can be read off it without a clock — which
 *   matters, because this package may not read one
 *   (checks/no-ambient-clock.mjs).
 * - There is no `/v1/key` endpoint; it 404s. Quota is learned from response
 *   headers or not at all.
 *
 * So a refusal from Nous carries an exact delay rather than an estimate, and
 * `NOUS_PORTAL_OBSERVED_FREE_LIMITS` is a fallback that should rarely be
 * needed. Compare `./open-router.ts`, which reports nothing until it refuses.
 */
import {
  openAiCompatibleAdapter,
  secondsToMs,
  type OpenAiCompatibleOptions,
} from './openai-compatible.js';
import type { GenerationAdapter } from '../types.js';

export const NOUS_PORTAL_ADAPTER = 'nous-portal';

/** Use as a routed unit's `destination`: the privacy boundary content crosses. */
export const NOUS_PORTAL_DESTINATION = 'nous-portal';

export const NOUS_PORTAL_BASE_URL = 'https://inference-api.nousresearch.com/v1';

/**
 * Limits read off a live free-tier response, as a routed unit's `rate_limits`.
 * Only a fallback: a Nous refusal states its own reset, and that is preferred.
 */
export const NOUS_PORTAL_OBSERVED_FREE_LIMITS = [
  { requests: 400, window_ms: 60_000 },
  { requests: 16_800, window_ms: 3_600_000 },
] as const;

/**
 * The zero-priced IDs observed in the live catalogue. Most use a `:free`
 * suffix; `stealth/space-bunny-alpha` is zero-priced at its exact ID.
 * Catalogue pricing is discovery data, not a serving guarantee: on 2026-09-25
 * LongCat's free ID was listed at zero price but its inference endpoint
 * rejected requests as "no longer free". Never switch to a paid twin.
 */
export const NOUS_PORTAL_FREE_MODELS = {
  lingFlashFin: 'inclusionai/ling-3.0-flash-fin:free',
  lingFlashSante: 'inclusionai/ling-3.0-flash-sante:free',
  longcat: 'meituan/longcat-2.0:free',
  lagunaS: 'poolside/laguna-s-2.1:free',
  lagunaXS: 'poolside/laguna-xs-2.1:free',
  spaceBunny: 'stealth/space-bunny-alpha',
  stepFlash: 'stepfun/step-3.7-flash:free',
  solarPro: 'upstage/solar-pro4:free',
} as const;

export type NousPortalOptions = OpenAiCompatibleOptions;

export function nousPortalAdapter(options: NousPortalOptions): GenerationAdapter {
  return openAiCompatibleAdapter(
    {
      id: NOUS_PORTAL_ADAPTER,
      defaultBaseURL: NOUS_PORTAL_BASE_URL,
      // Observed on 2026-09-22 with an API key: some listed free models return
      // 400 "missing tags" without a user tag. The public OpenAPI omits it.
      requestTags: ['user=weave'],
      // Relative seconds, so no clock is needed. Requests reset before tokens
      // in the common case, but take whichever is further out: coming back
      // while the other limit still bites earns a second refusal.
      retryDelayFrom: (headers) => {
        const candidates = [
          secondsToMs(headers.get('x-ratelimit-reset-requests')),
          secondsToMs(headers.get('x-ratelimit-reset-tokens')),
        ].filter((ms): ms is number => ms !== undefined);
        return candidates.length === 0 ? undefined : Math.max(...candidates);
      },
    },
    options,
    'nousPortalAdapter',
  );
}
