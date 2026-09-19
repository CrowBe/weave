/**
 * Provider adapter: OpenRouter.
 *
 * OpenRouter's reason for being here is its free tier: models priced at zero
 * that make a usable last resort when a paid route is blocked or a budget is
 * spent. Free means throttled, so this is the adapter that taught the gateway
 * to wait — see `rate_limits` on a routed unit and the `Timer` port.
 *
 * The protocol is OpenAI-compatible and lives in `./openai-compatible.ts`.
 * What is specific to OpenRouter is here, and most of it is what its free tier
 * actually does, measured on 2026-09-19 rather than read off the docs:
 *
 * - The documented 20 requests/minute did not fire. Twenty-five issued at once
 *   all returned 200. Treat the documented figure as a hint, not a contract.
 * - The 50 free-model requests/day is real, and reported by `GET /api/v1/key`
 *   under `free_model_daily_requests`. Its counter lags: twenty-six served
 *   requests read back as fifteen used, so it cannot be polled to decide
 *   whether the next request will be allowed.
 * - Rejected requests (a bad model id, say) count toward neither limit.
 * - No `x-ratelimit-*` headers come back on a success, so remaining quota
 *   cannot be learned from a call that worked. This is the opposite of
 *   `./nous-portal.ts`, which reports remaining quota on every success.
 *
 * Those four are why this adapter models no quota of its own: the only
 * trustworthy signal is the provider refusing, and the only trustworthy delay
 * is the one it states in `Retry-After`. A route's declared `rate_limits`
 * cover the case where it refuses and says nothing.
 */
import { openAiCompatibleAdapter, type OpenAiCompatibleOptions } from './openai-compatible.js';
import type { GenerationAdapter } from '../types.js';

export const OPEN_ROUTER_ADAPTER = 'open-router';

/** Use as a routed unit's `destination`: the privacy boundary content crosses. */
export const OPEN_ROUTER_DESTINATION = 'open-router';

export const OPEN_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * The limits OpenRouter documents for its free tier, as a routed unit's
 * `rate_limits`. Named `DOCUMENTED` because that is all they are: the
 * per-minute figure did not hold under test. Accounts that have bought ten or
 * more credits get 1000/day in place of 50.
 */
export const OPEN_ROUTER_DOCUMENTED_FREE_LIMITS = [
  { requests: 20, window_ms: 60_000 },
  { requests: 50, window_ms: 86_400_000 },
] as const;

export type OpenRouterOptions = OpenAiCompatibleOptions;

export function openRouterAdapter(options: OpenRouterOptions): GenerationAdapter {
  return openAiCompatibleAdapter(
    { id: OPEN_ROUTER_ADAPTER, defaultBaseURL: OPEN_ROUTER_BASE_URL },
    options,
    'openRouterAdapter',
  );
}
