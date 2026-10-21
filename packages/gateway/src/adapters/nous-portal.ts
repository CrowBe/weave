/**
 * Provider adapter: Nous Portal free models through the installed Vercel AI SDK.
 *
 * Plain OpenAI-compatible chat completions (`createOpenAICompatible` +
 * `generateText`). Each execute makes at most one chat request
 * (`maxRetries: 0`, never streamed); fallback belongs to routing, declared as
 * several Nous routed units in escalation order. Credentials and transport are
 * injected; nothing here reads the environment, a file, a shell or a clock.
 *
 * Only free models are served, and a price is refused at three layers:
 *
 * 1. Free-model allowlist: `call.model` must be one of
 *    `NOUS_PORTAL_FREE_MODELS`; paid twins and anything else are refused before
 *    a request (route-config parsing refuses them too).
 * 2. Catalogue price check: before the first chat request for a model, `GET
 *    {base}/models` with the same Bearer must list that model with every
 *    pricing field, nested field and `overrides` tier exactly zero. Concurrent
 *    first calls share one in-flight check. A pass is trusted for the life of
 *    this adapter instance, because there is no clock to expire it; it is
 *    dropped after a refusal suggesting the model changed (402, 404, "no
 *    longer free", "requires available credits"), so the next call checks
 *    again. A failed, abandoned or absent check is never cached as a pass. A
 *    priced or unreadable listing refuses the model for this instance.
 * 3. Response cost: a `usage.cost` that is present and not exactly zero fails
 *    the call and refuses the model for this instance.
 *
 * Measured live on 17 Oct 2026:
 *
 * - Chat requests with an API key need a top-level `"tags": ["user=<app>"]`
 *   or Nous answers `400 missing tags`. It is added through the SDK's
 *   `transformRequestBody`; the app label is honestly `weave`.
 * - `x-ratelimit-reset-requests` / `-tokens` are relative seconds, so a refusal
 *   states an exact delay without a clock (checks/no-ambient-clock.mjs).
 *   Retry-After wins when present; otherwise the later of the two resets.
 *
 * Nous may store, train on and license prompts and outputs by default (Terms
 * s12.3; Privacy Mode is opt-in and does not cover upstream providers). Mark
 * its destination training-allowed in the route table so privacy routing
 * admits only explicit public/non-sensitive work and screens credentials.
 *
 * ModelSettings has no reasoning field and no reasoning parameter is sent.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import type {
  GenerationAdapter,
  GenerationCall,
  GenerationProviderResult,
  ProviderFailure,
  ProviderUsage,
} from '../types.js';
import { secondsToMs } from './openai-compatible.js';
import {
  NOUS_PORTAL_ADAPTER,
  NOUS_PORTAL_FREE_MODELS,
  isNousPortalFreeModel,
  nousPortalCatalogueVerdict,
} from './nous-portal-catalogue.js';

export {
  NOUS_PORTAL_ADAPTER,
  NOUS_PORTAL_FREE_MODELS,
  isNousPortalFreeModel,
  type NousPortalFreeModel,
} from './nous-portal-catalogue.js';

/** Use as a routed unit's `destination`: the privacy boundary content crosses. */
export const NOUS_PORTAL_DESTINATION = 'nous-portal';

export const NOUS_PORTAL_BASE_URL = 'https://inference-api.nousresearch.com/v1';

/**
 * Free-tier limits read off live response headers on 17 Oct 2026 (10 requests
 * and 80k tokens per 60 s; 420 requests and 3.36M tokens per hour). Nous does
 * not publish them and they may change. As a routed unit's `rate_limits` they
 * only estimate a wait after a refusal that stated none: the header delay is
 * preferred, and nothing here reserves quota or throttles ahead of a refusal.
 */
export const NOUS_PORTAL_FREE_LIMITS = [
  { requests: 10, tokens: 80_000, window_ms: 60_000 },
  { requests: 420, tokens: 3_360_000, window_ms: 3_600_000 },
] as const;

/**
 * Allowlisted models whose catalogue entry declares reasoning mandatory on
 * 17 Oct 2026.
 */
export const NOUS_PORTAL_REASONING_MODELS: readonly string[] = Object.freeze([
  NOUS_PORTAL_FREE_MODELS.stepFlash,
  NOUS_PORTAL_FREE_MODELS.stepPreview,
]);

/**
 * Mandatory reasoning counts against the output cap, so a small cap can end in
 * no text at all. No Nous reasoning-token figure was measured; this matches the
 * Muse Spark minimum (about 250 reasoning tokens for a one-word answer there)
 * as an assumption, and longer answers may need a larger cap.
 */
export const NOUS_PORTAL_MIN_REASONING_OUTPUT_TOKENS = 1024;

export interface NousPortalOptions {
  /** Required injection. Only the composition root reads an environment variable. */
  readonly apiKey: string;
  readonly baseURL?: string;
  /** Injectable for offline tests; defaults to the global fetch at call time. */
  readonly fetch?: typeof globalThis.fetch;
}

const REQUEST_TAGS: readonly string[] = ['user=weave'];
const REASONING: ReadonlySet<string> = new Set(NOUS_PORTAL_REASONING_MODELS);
const ZERO_USAGE: ProviderUsage = { input_tokens: 0, output_tokens: 0 };
/** Refusal text that says the model is no longer served free; never echoed. */
const NO_LONGER_FREE = /no longer free|requires available credits/i;

type CatalogueResult = { readonly verdict: 'free' | 'priced' | 'absent' } | { readonly failure: ProviderFailure };

interface CatalogueCheck {
  readonly controller: AbortController;
  result: Promise<CatalogueResult>;
  waiters: number;
  settled: boolean;
}

export function nousPortalAdapter(options: NousPortalOptions): GenerationAdapter {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0 || /[\r\n]/.test(options.apiKey)) {
    throw new Error('nousPortalAdapter requires an apiKey that is nonblank and valid for a Bearer header');
  }
  // Copied so a caller mutating its options cannot change authentication or
  // secrecy protection between concurrent calls.
  const apiKey = options.apiKey;
  const contentKey = apiKey.trim();
  const baseURL = (options.baseURL ?? NOUS_PORTAL_BASE_URL).replace(/\/+$/, '');
  const injectedFetch = options.fetch;
  const doFetch: typeof globalThis.fetch = (input, init) => (injectedFetch ?? globalThis.fetch)(input, init);
  const provider = createOpenAICompatible({
    name: NOUS_PORTAL_ADAPTER,
    apiKey,
    baseURL,
    fetch: doFetch,
    transformRequestBody: (body) => ({ ...body, tags: [...REQUEST_TAGS] }),
  });
  const redactKey = (value: string) => value.replaceAll(apiKey, '[REDACTED]').replaceAll(contentKey, '[REDACTED]');

  /** Models refused for this instance after a price was observed. */
  const refused = new Set<string>();
  /** In-flight checks and passed (`free`) checks, per model. */
  const checks = new Map<string, CatalogueCheck>();

  async function lookup(model: string, signal: AbortSignal): Promise<CatalogueResult> {
    try {
      const response = await doFetch(`${baseURL}/models`, {
        method: 'GET', headers: { authorization: `Bearer ${apiKey}` }, signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status === 401 || status === 403) return { failure: failure('unauthorized', 'provider refused authentication', false) };
        if (status === 429) return { failure: withDelay(failure('rate_limited', 'provider rate limit refused the catalogue price check', true), (name) => response.headers.get(name)) };
        return { failure: CHECK_FAILED };
      }
      const verdict = nousPortalCatalogueVerdict(await response.json() as unknown, model);
      return verdict === 'malformed' ? { failure: CHECK_FAILED } : { verdict };
    } catch {
      return { failure: CHECK_FAILED };
    }
  }

  /** Undefined when the model is confirmed free; otherwise why not to send. */
  async function checkCatalogue(model: string, signal: AbortSignal | undefined): Promise<ProviderFailure | undefined> {
    let check = checks.get(model);
    if (check === undefined) {
      const created: CatalogueCheck = { controller: new AbortController(), result: Promise.resolve({ failure: CHECK_FAILED }), waiters: 0, settled: false };
      created.result = lookup(model, created.controller.signal).then(result => {
        created.settled = true;
        if (!('verdict' in result) || result.verdict !== 'free') {
          if (checks.get(model) === created) checks.delete(model);
          if ('verdict' in result && result.verdict === 'priced') refused.add(model);
        }
        return result;
      });
      checks.set(model, created);
      check = created;
    }
    check.waiters += 1;
    const result = await untilAborted(check.result, signal);
    check.waiters -= 1;
    if (result === ABORTED) {
      // The last waiter leaving abandons the check; an abandoned check is not a pass.
      if (!check.settled && check.waiters === 0) {
        check.controller.abort();
        if (checks.get(model) === check) checks.delete(model);
      }
      return abortFailure(signal);
    }
    if ('failure' in result) return result.failure;
    if (result.verdict === 'free') return refused.has(model) ? PRICE_REFUSED : undefined;
    return result.verdict === 'priced' ? PRICE_REFUSED : NOT_LISTED;
  }

  /** A refusal suggesting the model changed: the next call checks the catalogue again. */
  function forgetPass(model: string) {
    const check = checks.get(model);
    if (check?.settled === true) checks.delete(model);
  }

  return {
    id: NOUS_PORTAL_ADAPTER,
    async execute(call: GenerationCall): Promise<GenerationProviderResult> {
      const refuse = (result: ProviderFailure): GenerationProviderResult => ({ status: 'failed', failure: result, usage: ZERO_USAGE });
      if (call.instructions.includes(contentKey) || call.prompt.includes(contentKey)) {
        return refuse(failure('invalid_request', 'request content contains the adapter credential', false));
      }
      const model = call.model;
      if (!isNousPortalFreeModel(model)) return refuse(NOT_ALLOWLISTED);
      // Route settings validation is adapter-agnostic; enforce this minimum here.
      if (REASONING.has(model) && (!Number.isInteger(call.settings.max_output_tokens) ||
          call.settings.max_output_tokens < NOUS_PORTAL_MIN_REASONING_OUTPUT_TOKENS)) {
        return refuse(failure('invalid_request',
          `settings.max_output_tokens must be an integer at least ${NOUS_PORTAL_MIN_REASONING_OUTPUT_TOKENS} for a mandatory-reasoning model`, false));
      }
      if (refused.has(model)) return refuse(PRICE_REFUSED);
      if (call.signal?.aborted) return refuse(abortFailure(call.signal));

      const unchecked = await checkCatalogue(model, call.signal);
      if (unchecked !== undefined) return refuse(unchecked);

      try {
        const result = await generateText({
          model: provider(model),
          ...(call.instructions.trim().length === 0 ? {} : { system: call.instructions }),
          prompt: call.prompt,
          maxOutputTokens: call.settings.max_output_tokens,
          maxRetries: 0,
          // Retained only to read `usage.cost`; never returned or recorded.
          include: { responseBody: true },
          ...(call.settings.temperature === undefined ? {} : { temperature: call.settings.temperature }),
          ...(call.signal === undefined ? {} : { abortSignal: call.signal }),
        });
        const usage: ProviderUsage = {
          input_tokens: Number.isFinite(result.usage.inputTokens) ? result.usage.inputTokens : undefined,
          output_tokens: Number.isFinite(result.usage.outputTokens) ? result.usage.outputTokens : undefined,
        };
        if (!zeroOrAbsentCost(result.response.body)) {
          refused.add(model);
          return { status: 'failed', failure: COST_REPORTED, usage };
        }
        if (result.text.length === 0) {
          return { status: 'failed', failure: failure('malformed_response', result.finishReason === 'length'
            ? 'output token cap exhausted before any text content'
            : 'response carried no text content', false), usage };
        }
        return {
          status: 'completed',
          text: redactKey(result.text),
          usage,
          finish_reason: redactKey(result.finishReason),
          provider_response_id: result.response.id === undefined ? undefined : redactKey(result.response.id),
        };
      } catch (error: unknown) {
        return { status: 'failed', failure: classify(error, call.signal, () => forgetPass(model)) };
      }
    },
  };
}

const NOT_ALLOWLISTED = failure('invalid_request', 'model is not on the free-model allowlist; no request sent', false);
const PRICE_REFUSED = failure('invalid_request', 'model refused: a non-zero or unreadable price was observed', false);
const NOT_LISTED = failure('unavailable', 'model is not listed in the live catalogue', true);
const CHECK_FAILED = failure('unavailable', 'catalogue price check failed; no request sent', true);
const NO_LONGER_SERVED_FREE = failure('unavailable', 'provider no longer serves this model free', true);
const COST_REPORTED = failure('invalid_request', 'response reported a non-zero or non-numeric usage.cost; model refused from now on', false);

/** A present `usage.cost` must be exactly the number zero. */
function zeroOrAbsentCost(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return true;
  const usage = (body as Record<string, unknown>)['usage'];
  if (typeof usage !== 'object' || usage === null || !Object.hasOwn(usage, 'cost')) return true;
  return (usage as Record<string, unknown>)['cost'] === 0;
}

const ABORTED = Symbol('aborted');

/** Wait for a shared promise, leaving early (without cancelling it) when this caller aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise(resolve => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(value => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

function abortFailure(signal: AbortSignal | undefined): ProviderFailure {
  const reason = signal?.reason as unknown;
  return reason instanceof Error && reason.name === 'TimeoutError'
    ? failure('timeout', 'request timed out', false)
    : failure('cancelled', 'request cancelled', false);
}

/** Retry-After first; otherwise the later of the relative request and token resets. */
function withDelay(result: ProviderFailure, header: (name: string) => string | null | undefined): ProviderFailure {
  const read = (name: string) => {
    const value = header(name);
    return secondsToMs(typeof value === 'string' ? value : null);
  };
  const resets = [read('x-ratelimit-reset-requests'), read('x-ratelimit-reset-tokens')]
    .filter((ms): ms is number => ms !== undefined);
  const delay = read('retry-after') ?? (resets.length === 0 ? undefined : Math.max(...resets));
  return delay === undefined ? result : { ...result, retry_after_ms: delay };
}

/**
 * Provider-controlled messages, response bodies and SDK error objects can echo
 * credentials or headers. Publish only fixed descriptions and numeric status /
 * relative delays, never the original error or its message.
 */
function classify(error: unknown, signal: AbortSignal | undefined, modelChanged: () => void): ProviderFailure {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const name = typeof record['name'] === 'string' ? record['name'] : '';
  const reason = signal?.reason as unknown;
  const reasonName = reason instanceof Error ? reason.name : '';
  if (name === 'TimeoutError' || (signal?.aborted && reasonName === 'TimeoutError')) {
    return failure('timeout', 'request timed out', false);
  }
  if (signal?.aborted || name === 'AbortError') return failure('cancelled', 'request cancelled', false);

  const status = typeof record['statusCode'] === 'number' ? record['statusCode'] : undefined;
  const headers = record['responseHeaders'];
  const header = (key: string): string | undefined => {
    const value = typeof headers === 'object' && headers !== null ? (headers as Record<string, unknown>)[key] : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  const body = typeof record['responseBody'] === 'string' ? record['responseBody'] : '';
  if (status === 429) return withDelay(failure('rate_limited', 'provider rate limit refused the request', true), header);
  if (status === 402 || status === 404 || NO_LONGER_FREE.test(body)) {
    modelChanged();
    return NO_LONGER_SERVED_FREE;
  }
  if (status === 401 || status === 403) return withDelay(failure('unauthorized', 'provider refused authentication', false), header);
  if (status === 408) return withDelay(failure('timeout', 'provider request timed out', false), header);
  if (status !== undefined && status >= 500) return withDelay(failure('unavailable', 'provider unavailable', true), header);
  if (status !== undefined && status >= 400) return withDelay(failure('invalid_request', 'provider refused the request', false), header);
  if (status !== undefined || name === 'AI_InvalidResponseDataError' || name === 'AI_NoOutputGeneratedError') {
    return failure('malformed_response', 'provider response was malformed', false);
  }
  return failure('unavailable', 'provider transport failed', true);
}

function failure(code: ProviderFailure['code'], detail: string, retryable: boolean): ProviderFailure {
  return { code, message: `${NOUS_PORTAL_ADAPTER}: ${detail}`, retryable };
}
