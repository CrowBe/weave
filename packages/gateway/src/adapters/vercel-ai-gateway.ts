/**
 * Provider adapters: Vercel AI Gateway, via the AI SDK.
 *
 * This is the only file in the package that knows a provider exists. It is
 * reachable at `@weave/gateway/vercel-ai-gateway`, so the request interface and
 * routing stay free of the `ai` dependency and a second provider is another
 * file rather than a branch in the gateway.
 *
 * `vercelAiGatewayAdapter` generates text; `vercelAiGatewayFreeAdapter` adds
 * promotional price checks; `vercelAiGatewayEvaluator` answers typed questions
 * through a native evaluation model. They execute and report: they do not choose a model,
 * judge a response, read an environment variable, or throw — routing,
 * acceptance and credentials belong to the caller, and a fault is a recorded
 * failure.
 *
 * All pass `maxRetries: 0`. The SDK retries twice by default, which would hide
 * provider attempts inside one accounted attempt; retrying is the gateway's
 * decision to make and record (ARCHITECTURE.md §6).
 */
import { createGateway, experimental_evaluate, generateText, wrapLanguageModel } from 'ai';
import type {
  EvaluationAdapter,
  EvaluationAnswers,
  EvaluationCall,
  EvaluationProviderResult,
  GenerationAdapter,
  GenerationCall,
  GenerationProviderResult,
  ProviderFailure,
  QuestionId,
} from '../types.js';

export const VERCEL_AI_GATEWAY_ADAPTER = 'vercel-ai-gateway';

/** Use as a routed unit's `destination`: the privacy boundary content crosses. */
export const VERCEL_AI_GATEWAY_DESTINATION = 'vercel-ai-gateway';

export const VERCEL_AI_GATEWAY_FREE_ADAPTER = 'vercel-ai-gateway-free';
/** All promotional models allow training; mark every routed unit accordingly. */
export const VERCEL_AI_GATEWAY_FREE_DESTINATION = 'vercel-ai-gateway-free';
/** Observed at zero price on 2026-10-20; membership alone never permits dispatch. */
export const VERCEL_AI_GATEWAY_FREE_MODELS = Object.freeze({
  nemotron: 'nvidia/nemotron-3.5-lightning-free',
  laguna: 'poolside/laguna-s-2.1-free',
  beam: 'reflection/beam-free',
  minimax: 'minimax/minimax-m3.1-flash',
  glyph: 'stealth/glyph-cluster',
});
// Known promotion boundary, in epoch milliseconds, even if later catalogues omit it.
const LAGUNA_FREE_EXPIRY = 1_793_404_800_000;

export interface VercelAiGatewayOptions {
  /**
   * The AI Gateway API key. Required: the composition root decides where a
   * credential comes from, so nothing here reads ambient process state.
   */
  readonly apiKey: string;
  readonly baseURL?: string;
  /** Optional SDK transport injection, including deterministic offline tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface VercelAiGatewayFreeOptions extends VercelAiGatewayOptions {
  /**
   * Caller-fetched GET /v1/models JSON (object or JSON text), or a function
   * (signal: AbortSignal | undefined) => unknown | Promise<unknown> that fetches it.
   * Functions are invoked afresh per attempt; snapshots are revalidated per attempt.
   * Snapshot freshness is the caller's responsibility. No catalogue is cached here.
   */
  readonly catalogue: unknown;
  /** Caller time in epoch milliseconds, sampled after catalogue resolution. */
  readonly now: () => number;
}

function gatewayProvider(options: VercelAiGatewayOptions, fn: string) {
  if (options.apiKey.trim().length === 0) throw new Error(`${fn} requires an apiKey`);
  return createGateway({ apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export function vercelAiGatewayAdapter(options: VercelAiGatewayOptions): GenerationAdapter {
  return generationAdapter(options);
}

/**
 * Promotional free generation over the existing createGateway/generateText path.
 * Configure max_attempts_per_route: 1 for immediate fallback after a 429.
 * This adapter owns no retry, fallback, clock, credentials source, or mutable blacklist.
 */
export function vercelAiGatewayFreeAdapter(options: VercelAiGatewayFreeOptions): GenerationAdapter {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0 || /[\r\n]/.test(options.apiKey)) {
    throw new Error('vercelAiGatewayFreeAdapter requires a nonblank apiKey valid for a Bearer header');
  }
  // Capture injected inputs so caller mutation cannot switch credentials or checks.
  return generationAdapter({ ...options }, { catalogue: options.catalogue, now: options.now });
}

function generationAdapter(
  options: VercelAiGatewayOptions,
  free?: Pick<VercelAiGatewayFreeOptions, 'catalogue' | 'now'>,
): GenerationAdapter {
  const provider = gatewayProvider(options, 'vercelAiGatewayAdapter');
  const key = options.apiKey.trim();
  const redact = (text: string) => text.replaceAll(key, '[REDACTED]');

  return {
    id: free ? VERCEL_AI_GATEWAY_FREE_ADAPTER : VERCEL_AI_GATEWAY_ADAPTER,
    async execute(call: GenerationCall): Promise<GenerationProviderResult> {
      if (free) {
        const refused = await freePreflight(call, free, key);
        if (refused) return { status: 'failed', failure: refused, usage: { input_tokens: 0, output_tokens: 0 } };
      }
      try {
        const model = provider(call.model);
        const result = await generateText({
          model: free ? wrapLanguageModel({ model, middleware: {
            async wrapGenerate({ doGenerate }) {
              const response = await doGenerate();
              // The SDK logs warnings before returning. Untrusted provider warning
              // details may echo headers; withhold them per call, never globally.
              return { ...response, warnings: [] };
            },
          } }) : model,
          ...(free && call.instructions.trim().length === 0 ? {} : { system: call.instructions }),
          prompt: call.prompt,
          maxOutputTokens: call.settings.max_output_tokens,
          maxRetries: 0,
          ...(call.settings.temperature === undefined ? {} : { temperature: call.settings.temperature }),
          ...(call.signal === undefined ? {} : { abortSignal: call.signal }),
        });

        const usage = { input_tokens: free ? tokenCount(result.usage.inputTokens) : result.usage.inputTokens,
          output_tokens: free ? tokenCount(result.usage.outputTokens) : result.usage.outputTokens };
        if (free && call.signal?.aborted) return { status: 'failed', failure: freeFailure('cancelled', 'request cancelled') };
        if (free && !freeCost(result.providerMetadata)) {
          return { status: 'failed', failure: freeFailure('invalid_request',
            'response cost is absent, invalid, or no longer zero; promotional model refused'),
            usage };
        }
        return {
          status: 'completed',
          text: free ? redact(result.text) : result.text,
          usage,
          finish_reason: free ? redact(result.finishReason) : result.finishReason,
          provider_response_id: free && result.response.id ? redact(result.response.id) : result.response.id,
        };
      } catch (error: unknown) {
        if (free) return { status: 'failed', failure: freeFault(error, call.signal) };
        return { status: 'failed', failure: classify(error) };
      }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Avoid coercion, underflow and unknown price structures being mistaken for zero. */
function zero(value: unknown): boolean {
  return value === 0 || (typeof value === 'string' && /^0(?:\.0+)?$/.test(value));
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function freeFailure(code: ProviderFailure['code'], message: string): ProviderFailure {
  return { code, message: `vercel-ai-gateway-free: ${message}`, retryable: false };
}

async function freePreflight(
  call: GenerationCall,
  options: Pick<VercelAiGatewayFreeOptions, 'catalogue' | 'now'>,
  key: string,
): Promise<ProviderFailure | undefined> {
  if (call.signal?.aborted) return freeFailure('cancelled', 'request cancelled');
  if (!Object.values(VERCEL_AI_GATEWAY_FREE_MODELS).some(id => id === call.model)) {
    return freeFailure('invalid_request', 'model is outside the promotional free allowlist');
  }
  if (call.instructions.includes(key) || call.prompt.includes(key)) {
    return freeFailure('invalid_request', 'request content contains the adapter credential');
  }
  try {
    const source = typeof options.catalogue === 'function'
      ? await options.catalogue(call.signal) : options.catalogue;
    if (call.signal?.aborted) return freeFailure('cancelled', 'request cancelled');
    const catalogue: unknown = typeof source === 'string' ? JSON.parse(source) : source;
    if (!record(catalogue) || !Array.isArray(catalogue.data)) {
      return freeFailure('malformed_response', 'catalogue is missing or invalid');
    }
    const matches = catalogue.data.filter((entry: unknown) => record(entry) && entry.id === call.model);
    if (matches.length === 0) return freeFailure('unavailable', 'model is absent from catalogue');
    if (matches.length !== 1) return freeFailure('malformed_response', 'catalogue model is ambiguous');
    const model = matches[0] as Record<string, unknown>;
    const pricing = model.pricing;
    if (!record(pricing) || !zero(pricing.input) || !zero(pricing.output) ||
      Object.keys(pricing).some(field => field !== 'input' && field !== 'output') ||
      ('varies_by_provider' in model && model.varies_by_provider !== false)) {
      return freeFailure('invalid_request', 'catalogue does not establish an unconditional zero price');
    }
    const now = options.now();
    if (!Number.isFinite(now)) return freeFailure('invalid_request', 'caller time is invalid');
    if (('deprecated_at' in model && model.deprecated_at !== null && (typeof model.deprecated_at !== 'number' ||
      !Number.isFinite(model.deprecated_at) || now >= model.deprecated_at)) ||
      (call.model === VERCEL_AI_GATEWAY_FREE_MODELS.laguna && now >= LAGUNA_FREE_EXPIRY)) {
      return freeFailure('unavailable', 'promotional model is deprecated or expiry is invalid');
    }
    return undefined;
  } catch {
    // Catalogue fetch/parse failures may contain headers: never retain their messages.
    return call.signal?.aborted ? freeFailure('cancelled', 'request cancelled')
      : freeFailure('malformed_response', 'catalogue or caller time could not be read');
  }
}

function freeCost(metadata: unknown): boolean {
  if (!record(metadata) || !record(metadata.gateway)) return false;
  const gateway = metadata.gateway;
  return zero(gateway.cost) && ['marketCost', 'gatewayCost'].every(field => !(field in gateway) || zero(gateway[field]));
}

function freeFault(error: unknown, signal: AbortSignal | undefined): ProviderFailure {
  if (signal?.aborted) return freeFailure('cancelled', 'request cancelled');
  // Body-read faults can wrap an actual 429 beneath SDK errors with status 200.
  // Bound traversal even for adversarial/cyclic causes; retain no SDK messages.
  let current: unknown = error;
  let status: number | undefined;
  let retryable = false;
  for (let depth = 0; depth < 8 && record(current); depth++) {
    if (current.name === 'AbortError') return freeFailure('cancelled', 'request cancelled');
    if (current.name === 'TimeoutError') return freeFailure('timeout', 'provider request timed out');
    const candidate = statusOf(current);
    if (candidate !== undefined && candidate >= 400) status = candidate;
    retryable ||= isRetryable(current);
    current = current.cause;
  }
  if (status === 404) return freeFailure('unavailable', 'model is unavailable');
  const failure = classify({ statusCode: status, isRetryable: retryable });
  return { ...failure, message: `vercel-ai-gateway-free: provider request failed (${failure.code})` };
}

/**
 * The evaluation port over an AI Gateway evaluation model (Jev and peers).
 *
 * The question and answer shapes the gateway defines are the shapes such a
 * model already speaks, so this adapter passes them through rather than
 * translating. What it does not do is invent: an answer the model did not give
 * is absent, and the gateway rejects the response as malformed.
 */
export function vercelAiGatewayEvaluator(options: VercelAiGatewayOptions): EvaluationAdapter {
  const provider = gatewayProvider(options, 'vercelAiGatewayEvaluator');

  return {
    id: VERCEL_AI_GATEWAY_ADAPTER,
    async evaluate(call: EvaluationCall): Promise<EvaluationProviderResult> {
      try {
        const result = await experimental_evaluate({
          model: provider.evaluationModel(call.model),
          state: call.state as Parameters<typeof experimental_evaluate>[0]['state'],
          questions: call.questions as Parameters<typeof experimental_evaluate>[0]['questions'],
          maxRetries: 0,
          ...(call.signal === undefined ? {} : { abortSignal: call.signal }),
        });

        return {
          status: 'completed',
          answers: result.answers as EvaluationAnswers,
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
          },
          provider_response_id: result.response.id,
          confidence: confidenceOf(result.providerMetadata),
        };
      } catch (error: unknown) {
        return { status: 'failed', failure: classify(error) };
      }
    },
  };
}

/**
 * TypeSafe's evaluation models publish a per-question confidence under their
 * own metadata key. Read defensively: absent metadata is not an error, and a
 * provider without the statistic simply reports none.
 */
function confidenceOf(metadata: unknown): Readonly<Record<QuestionId, number>> | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const typesafe = (metadata as { typesafe?: unknown }).typesafe;
  if (typeof typesafe !== 'object' || typesafe === null) return undefined;
  const confidence = (typesafe as { confidence?: unknown }).confidence;
  if (typeof confidence !== 'object' || confidence === null) return undefined;

  const out: Record<QuestionId, number> = {};
  for (const [id, value] of Object.entries(confidence as Record<string, unknown>)) {
    if (typeof value === 'number') out[id] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map a provider fault onto the closed failure vocabulary. Read structurally:
 * the SDK's error classes are its business, and an unrecognised fault must
 * still be accounted for rather than escape as an exception.
 */
function classify(error: unknown): ProviderFailure {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const status = statusOf(error);

  if (name === 'AbortError' || name === 'TimeoutError') {
    return { code: name === 'TimeoutError' ? 'timeout' : 'cancelled', message, retryable: false };
  }
  if (status === 401 || status === 403) return { code: 'unauthorized', message, retryable: false };
  if (status === 429) return { code: 'rate_limited', message, retryable: true };
  if (status !== undefined && status >= 500) return { code: 'unavailable', message, retryable: true };
  if (status !== undefined && status >= 400) return { code: 'invalid_request', message, retryable: false };

  // No status: a transport fault the SDK marks retryable, or a response it
  // could not parse. Trust the SDK's own retry judgment when it states one.
  const retryable = isRetryable(error);
  return { code: retryable ? 'unavailable' : 'malformed_response', message, retryable };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { isRetryable?: unknown }).isRetryable === true;
}
