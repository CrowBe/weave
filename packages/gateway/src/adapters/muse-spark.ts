/**
 * Meta Muse Spark contributor generation through the installed Vercel AI SDK.
 *
 * Fallback belongs to routing: declare two routed units on this adapter with
 * the 1.3 primary before the 1.2 fallback in the terms' escalation order.
 * Each execute makes one SDK attempt (`maxRetries: 0`); there is no hidden
 * model fallback or retry. Credentials and transport are injected here.
 *
 * Contributor content may be used for training. Mark its destination
 * training-allowed in the route table so privacy routing admits only explicit
 * public/non-sensitive work and rejects credential-shaped content before sending it.
 *
 * ModelSettings has no reasoning field. This adapter sends no reasoning
 * parameter or provider options, so it never requests the top reasoning level.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import type {
  GenerationAdapter,
  GenerationCall,
  GenerationProviderResult,
  ModelSettings,
  ProviderFailure,
} from '../types.js';
import { secondsToMs } from './openai-compatible.js';

export const MUSE_SPARK_ADAPTER = 'muse-spark';
/** Privacy boundary for the contributor service, which may train on content. */
export const MUSE_SPARK_DESTINATION = 'muse-spark-contributor';
export const MUSE_SPARK_BASE_URL = 'https://api.meta.ai/v1';
export const MUSE_SPARK_PRIMARY_MODEL = 'muse-spark-1.3-contributor';
export const MUSE_SPARK_FALLBACK_MODEL = 'muse-spark-1.2-contributor';
/**
 * Contributor models reason by default, and reasoning counts against the output
 * cap. On 16 Oct 2026 a live one-word answer used about 250 reasoning tokens.
 * This minimum leaves room for that default reasoning plus text; longer answers
 * or reasoning may need a larger cap. No reasoning-level parameter is requested.
 */
export const MUSE_SPARK_MIN_OUTPUT_TOKENS = 1024;
/** Default output budget for contributor calls, including default reasoning. */
export const MUSE_SPARK_DEFAULT_SETTINGS = Object.freeze({
  max_output_tokens: MUSE_SPARK_MIN_OUTPUT_TOKENS,
}) satisfies ModelSettings;
/**
 * Declared contributor limits, used by the gateway only to estimate retry
 * delay after a rate-limit refusal without Retry-After. They neither reserve
 * quota nor proactively throttle concurrent requests.
 */
export const MUSE_SPARK_DOCUMENTED_CONTRIBUTOR_LIMITS = [
  { requests: 150, tokens: 3_000_000, window_ms: 60_000 },
] as const;

export interface MuseSparkOptions {
  /** Required injection. Only the composition root reads MODEL_API_KEY. */
  readonly apiKey: string;
  readonly baseURL?: string;
  /** Injectable for offline tests; defaults to the SDK's fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export function museSparkAdapter(options: MuseSparkOptions): GenerationAdapter {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0 || /[\r\n]/.test(options.apiKey)) {
    throw new Error('museSparkAdapter requires a nonblank apiKey valid for a Bearer header');
  }
  // Copy the credential so mutation of a caller's options cannot change either
  // authentication or secrecy protection between concurrent calls.
  const apiKey = options.apiKey;
  const contentKey = apiKey.trim();
  const provider = createOpenAICompatible({
    name: MUSE_SPARK_ADAPTER,
    apiKey,
    baseURL: options.baseURL ?? MUSE_SPARK_BASE_URL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const redactKey = (value: string) => value.replaceAll(apiKey, '[REDACTED]');

  return {
    id: MUSE_SPARK_ADAPTER,
    async execute(call: GenerationCall): Promise<GenerationProviderResult> {
      if (call.instructions.includes(contentKey) || call.prompt.includes(contentKey)) {
        return { status: 'failed', failure: failure('invalid_request',
          'request content contains the adapter credential', false),
          usage: { input_tokens: 0, output_tokens: 0 } };
      }
      // Route settings validation is adapter-agnostic. Enforce this provider's
      // minimum here, including callers that construct routed units directly.
      if (!Number.isInteger(call.settings.max_output_tokens) || call.settings.max_output_tokens < MUSE_SPARK_MIN_OUTPUT_TOKENS) {
        return { status: 'failed', failure: failure('invalid_request',
          `settings.max_output_tokens must be an integer at least ${MUSE_SPARK_MIN_OUTPUT_TOKENS} to leave room for default reasoning and text`, false),
          usage: { input_tokens: 0, output_tokens: 0 } };
      }
      try {
        const result = await generateText({
          model: provider(call.model),
          ...(call.instructions.trim().length === 0 ? {} : { system: call.instructions }),
          prompt: call.prompt,
          maxOutputTokens: call.settings.max_output_tokens,
          maxRetries: 0,
          ...(call.settings.temperature === undefined ? {} : { temperature: call.settings.temperature }),
          ...(call.signal === undefined ? {} : { abortSignal: call.signal }),
        });
        if (result.text.length === 0) {
          return { status: 'failed', failure: failure('malformed_response', result.finishReason === 'length'
            ? 'output token cap exhausted before any text content; increase settings.max_output_tokens to leave room for reasoning and text'
            : 'response carried no text content', false), usage: {
              input_tokens: Number.isFinite(result.usage.inputTokens) ? result.usage.inputTokens : undefined,
              output_tokens: Number.isFinite(result.usage.outputTokens) ? result.usage.outputTokens : undefined,
            } };
        }
        return {
          status: 'completed',
          text: redactKey(result.text),
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
          },
          finish_reason: redactKey(result.finishReason),
          provider_response_id: result.response.id === undefined ? undefined : redactKey(result.response.id),
        };
      } catch (error: unknown) {
        return { status: 'failed', failure: classify(error, call.signal) };
      }
    },
  };
}

/**
 * Provider-controlled messages, response bodies and SDK error objects can echo
 * credentials or headers. Publish only fixed descriptions and numeric status /
 * relative Retry-After, never the original error or its message.
 */
function classify(error: unknown, signal: AbortSignal | undefined): ProviderFailure {
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
  const retryAfter = typeof headers === 'object' && headers !== null
    ? (headers as Record<string, unknown>)['retry-after']
    : undefined;
  const delay = secondsToMs(typeof retryAfter === 'string' ? retryAfter : null);
  const withDelay = (result: ProviderFailure): ProviderFailure => delay === undefined ? result : { ...result, retry_after_ms: delay };
  if (status === 401 || status === 402 || status === 403) {
    return withDelay(failure('unauthorized', 'provider refused authentication', false));
  }
  if (status === 408) return withDelay(failure('timeout', 'provider request timed out', false));
  if (status === 429) return withDelay(failure('rate_limited', 'provider rate limit refused the request', true));
  if (status !== undefined && status >= 500) return withDelay(failure('unavailable', 'provider unavailable', true));
  if (status !== undefined && status >= 400) return withDelay(failure('invalid_request', 'provider refused the request', false));
  if (status !== undefined || name === 'AI_InvalidResponseDataError' || name === 'AI_NoOutputGeneratedError') {
    return failure('malformed_response', 'provider response was malformed', false);
  }
  return failure('unavailable', 'provider transport failed', true);
}

function failure(code: ProviderFailure['code'], detail: string, retryable: boolean): ProviderFailure {
  return { code, message: `${MUSE_SPARK_ADAPTER}: ${detail}`, retryable };
}
