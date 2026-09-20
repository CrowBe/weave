/**
 * Provider adapters: Vercel AI Gateway, via the AI SDK.
 *
 * This is the only file in the package that knows a provider exists. It is
 * reachable at `@weave/gateway/vercel-ai-gateway`, so the request interface and
 * routing stay free of the `ai` dependency and a second provider is another
 * file rather than a branch in the gateway.
 *
 * There are two adapters because there are two ports. `vercelAiGatewayAdapter`
 * generates text; `vercelAiGatewayEvaluator` answers typed questions through a
 * native evaluation model. Both execute and report: they do not choose a model,
 * judge a response, read an environment variable, or throw — routing,
 * acceptance and credentials belong to the caller, and a fault is a recorded
 * failure.
 *
 * Both pass `maxRetries: 0`. The SDK retries twice by default, which would hide
 * provider attempts inside one accounted attempt; retrying is the gateway's
 * decision to make and record (ARCHITECTURE.md §6).
 */
import { createGateway, experimental_evaluate, generateText } from 'ai';
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

export interface VercelAiGatewayOptions {
  /**
   * The AI Gateway API key. Required: the composition root decides where a
   * credential comes from, so nothing here reads ambient process state.
   */
  readonly apiKey: string;
  readonly baseURL?: string;
}

function gatewayProvider(options: VercelAiGatewayOptions, fn: string) {
  if (options.apiKey.trim().length === 0) throw new Error(`${fn} requires an apiKey`);
  return createGateway(
    options.baseURL === undefined
      ? { apiKey: options.apiKey }
      : { apiKey: options.apiKey, baseURL: options.baseURL },
  );
}

export function vercelAiGatewayAdapter(options: VercelAiGatewayOptions): GenerationAdapter {
  const provider = gatewayProvider(options, 'vercelAiGatewayAdapter');

  return {
    id: VERCEL_AI_GATEWAY_ADAPTER,
    async execute(call: GenerationCall): Promise<GenerationProviderResult> {
      try {
        const result = await generateText({
          model: provider(call.model),
          system: call.instructions,
          prompt: call.prompt,
          maxOutputTokens: call.settings.max_output_tokens,
          maxRetries: 0,
          ...(call.settings.temperature === undefined ? {} : { temperature: call.settings.temperature }),
          ...(call.signal === undefined ? {} : { abortSignal: call.signal }),
        });

        return {
          status: 'completed',
          text: result.text,
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
          },
          finish_reason: result.finishReason,
          provider_response_id: result.response.id,
        };
      } catch (error: unknown) {
        return { status: 'failed', failure: classify(error) };
      }
    },
  };
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
