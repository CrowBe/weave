/**
 * OpenCode Zen's DeepSeek free tier through the installed AI SDK (DEC-008).
 * https://opencode.ai/docs/zen/ documents this exact -free model as limited
 * time, zero retention and no model training. Limits float: no numerical quota
 * is declared. A throttle or unavailable free model escalates immediately.
 *
 * The free-model guard intersects a fixed allowlist with the public live list
 * before every generation. No positive result survives a call and no model is
 * substituted, especially the paid twin. Independent list fetches keep caller
 * cancellation isolated without a clock or a shared cache lifecycle.
 *
 * Each destination has one data policy. This destination remains NOT
 * training-allowed once #167 lands. Future training models need their own
 * destination and privacy admission; adding an id to this profile is not that
 * admission. The caller must explicitly permit this destination in its terms.
 *
 * Credentials and transport are injected; the composition root alone reads
 * OPENCODE_API_KEY. Provider messages/headers never enter failure evidence.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import type {
  GenerationAdapter, GenerationCall, GenerationProviderResult, ProviderFailure,
} from '../types.js';

export const OPENCODE_ZEN_ADAPTER = 'opencode-zen';
export const OPENCODE_ZEN_DESTINATION = 'opencode-zen.deepseek-free';
export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/inference/openai/v1';
export const OPENCODE_ZEN_MODELS_URL = 'https://opencode.ai/inference/v1/models';
export const OPENCODE_ZEN_MODEL = 'deepseek-v4.1-flash-free';

// Exact ids, private and immutable. Future profiles may extend the guard's
// allowlist pattern while keeping their protocol and data policy separate.
const FREE_MODELS: readonly string[] = Object.freeze([OPENCODE_ZEN_MODEL]);

export interface OpencodeZenOptions {
  readonly apiKey: string;
  /** Injected for offline tests; endpoints and model policy stay fixed. */
  readonly fetch?: typeof globalThis.fetch;
}

export function opencodeZenAdapter(options: OpencodeZenOptions): GenerationAdapter {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0 || /[\r\n]/.test(options.apiKey)) {
    throw new Error('opencodeZenAdapter requires a nonblank apiKey valid for a Bearer header');
  }
  const apiKey = options.apiKey;
  const doFetch = options.fetch ?? globalThis.fetch;
  const provider = createOpenAICompatible({
    name: OPENCODE_ZEN_ADAPTER, apiKey, baseURL: OPENCODE_ZEN_BASE_URL, fetch: doFetch,
  });
  const redactKey = (value: string) => value.replaceAll(apiKey, '[REDACTED]');

  return {
    id: OPENCODE_ZEN_ADAPTER,
    async execute(call: GenerationCall): Promise<GenerationProviderResult> {
      let checkingList = true;
      try {
        // Snapshot before awaiting: mutation of a caller's call cannot swap in
        // a paid model after the validated id has passed the guard.
        const model = call.model;
        if (!FREE_MODELS.includes(model)) return failed('invalid_request', 'model is not allowlisted');
        call.signal?.throwIfAborted();
        const response = await doFetch(OPENCODE_ZEN_MODELS_URL, {
          method: 'GET', redirect: 'error',
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        });
        call.signal?.throwIfAborted();
        if (!response.ok) return failed('unavailable', 'live models list unavailable');
        const list: unknown = await response.json();
        call.signal?.throwIfAborted();
        if (!hasModel(list, model)) return failed('unavailable', 'free model not confirmed by live list');
        checkingList = false;
        const result = await generateText({
          model: provider(model),
          ...(call.instructions.trim().length === 0 ? {} : { system: call.instructions }),
          prompt: call.prompt,
          maxOutputTokens: call.settings.max_output_tokens,
          maxRetries: 0,
          ...(call.settings.temperature === undefined ? {} : { temperature: call.settings.temperature }),
          ...(call.signal === undefined ? {} : { abortSignal: call.signal }),
        });
        call.signal?.throwIfAborted();
        if (result.text.length === 0) return failed('malformed_response', 'response carried no text content');
        return {
          status: 'completed',
          text: redactKey(result.text),
          usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens },
          finish_reason: redactKey(result.finishReason),
          provider_response_id: result.response.id === undefined ? undefined : redactKey(result.response.id),
        };
      } catch (error: unknown) {
        return { status: 'failed', failure: classify(error, call.signal, checkingList) };
      }
    },
  };
}

function hasModel(value: unknown, model: string): boolean {
  if (typeof value !== 'object' || value === null || !('data' in value)) return false;
  const data: unknown = value.data;
  return Array.isArray(data) && data.every((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string') &&
    data.some((entry: { id: string }) => entry.id === model);
}

function classify(error: unknown, signal: AbortSignal | undefined, checkingList: boolean): ProviderFailure {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const name = record['name'];
  const reason: unknown = signal?.reason;
  if ((signal?.aborted && reason instanceof Error && reason.name === 'TimeoutError') || name === 'TimeoutError') {
    return failure('timeout', 'request timed out');
  }
  if (signal?.aborted || name === 'AbortError') return failure('cancelled', 'request cancelled');
  if (checkingList) return failure('unavailable', 'live models list unavailable');
  const status = typeof record['statusCode'] === 'number' ? record['statusCode'] : undefined;
  if (status === 401 || status === 402 || status === 403) return failure('unauthorized', 'provider refused authentication');
  if (status === 408) return failure('timeout', 'provider request timed out');
  // 404 also covers removal between the guard and generation. No paid twin
  // substitution or waiting on this limited-time free tier is ever attempted.
  if (status === 404 || status === 429 || (status !== undefined && status >= 500)) {
    return failure('unavailable', 'free provider unavailable');
  }
  if (status !== undefined && status >= 400) return failure('invalid_request', 'provider refused the request');
  if (status !== undefined || name === 'AI_InvalidResponseDataError' || name === 'AI_NoOutputGeneratedError') {
    return failure('malformed_response', 'provider response was malformed');
  }
  return failure('unavailable', 'provider transport failed');
}

function failure(code: ProviderFailure['code'], detail: string): ProviderFailure {
  // Every Zen refusal moves to the next routed unit; in particular, 429 must
  // not use rate_limited/Retry-After, which would invite waiting on this unit.
  return { code, message: `${OPENCODE_ZEN_ADAPTER}: ${detail}`, retryable: false };
}
function failed(code: ProviderFailure['code'], detail: string): GenerationProviderResult {
  return { status: 'failed', failure: failure(code, detail) };
}
