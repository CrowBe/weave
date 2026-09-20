/**
 * The OpenAI-compatible chat-completions protocol, implemented once.
 *
 * Internal. It is not in the package's exports map and no caller names it: the
 * public surface is the named provider modules beside it (`./open-router.ts`,
 * `./nous-portal.ts`), each of which is a base URL, an adapter id, a
 * destination, and whatever that vendor does differently about rate limits.
 * Everything else — the request body, the response fields worth reading, the
 * mapping from status code to the gateway's closed failure vocabulary — is the
 * same protocol and lives here.
 *
 * Providers stay distinct where it matters rather than where it does not. Two
 * vendors speaking one protocol still need separate adapter ids, because a
 * routed unit selects an adapter by id and each carries its own credential;
 * and separate destinations, because content crossing to one vendor has not
 * been disclosed to the other.
 *
 * Depends on nothing but `fetch`, and reads no ambient state.
 */
import type {
  AdapterId,
  GenerationAdapter,
  GenerationCall,
  GenerationProviderResult,
  ProviderFailure,
  ProviderUsage,
} from '../types.js';

/** What distinguishes one OpenAI-compatible vendor from another. */
export interface OpenAiCompatibleProvider {
  readonly id: AdapterId;
  readonly defaultBaseURL: string;
  /**
   * A vendor-specific delay read from a refusal's headers, in milliseconds.
   * Consulted only when the response carries no standard `Retry-After`.
   */
  readonly retryDelayFrom?: (headers: Headers) => number | undefined;
}

export interface OpenAiCompatibleOptions {
  /**
   * The API key. Required: the composition root decides where a credential
   * comes from, so nothing here reads ambient process state.
   */
  readonly apiKey: string;
  readonly baseURL?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

export function openAiCompatibleAdapter(
  provider: OpenAiCompatibleProvider,
  options: OpenAiCompatibleOptions,
  factoryName: string,
): GenerationAdapter {
  if (options.apiKey.trim().length === 0) {
    throw new Error(`${factoryName} requires an apiKey`);
  }
  const baseURL = (options.baseURL ?? provider.defaultBaseURL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    id: provider.id,
    async execute(call: GenerationCall): Promise<GenerationProviderResult> {
      let response: Response;
      try {
        response = await doFetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: call.model,
            messages: messagesFor(call),
            max_tokens: call.settings.max_output_tokens,
            ...(call.settings.temperature === undefined ? {} : { temperature: call.settings.temperature }),
          }),
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        });
      } catch (error: unknown) {
        return { status: 'failed', failure: classifyTransport(error) };
      }

      if (!response.ok) {
        return {
          status: 'failed',
          failure: classifyStatus(
            provider.id,
            response.status,
            await textOf(response),
            retryDelay(provider, response.headers),
          ),
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: 'failed', failure: malformed(provider.id, 'response body was not JSON') };
      }

      return parseCompletion(provider.id, body);
    },
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function messagesFor(call: GenerationCall): readonly { role: string; content: string }[] {
  const user = { role: 'user', content: call.prompt };
  // An empty system message is not neutral on every model; send none instead.
  return call.instructions.trim().length === 0
    ? [user]
    : [{ role: 'system', content: call.instructions }, user];
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

function parseCompletion(id: AdapterId, body: unknown): GenerationProviderResult {
  if (typeof body !== 'object' || body === null) {
    return { status: 'failed', failure: malformed(id, 'response was not an object') };
  }
  const record = body as Record<string, unknown>;

  // A 200 can still carry an error in the body rather than in the status.
  // Take it at its word: this is a failure, and must be recorded as one.
  const embedded = record['error'];
  if (typeof embedded === 'object' && embedded !== null) {
    const e = embedded as Record<string, unknown>;
    const status = typeof e['code'] === 'number' ? (e['code'] as number) : 0;
    const message = typeof e['message'] === 'string' ? (e['message'] as string) : 'provider reported an error';
    return {
      status: 'failed',
      failure: status >= 400 ? classifyStatus(id, status, message, undefined) : malformed(id, message),
    };
  }

  const choices = record['choices'];
  const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
  if (first === undefined) return { status: 'failed', failure: malformed(id, 'response carried no choices') };

  const message = first['message'];
  const content =
    typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['content'] : undefined;
  if (typeof content !== 'string') {
    // A reasoning model that spends its whole output cap on reasoning returns
    // no content. That is a real, recordable outcome rather than a parse
    // failure of ours — but there is no text to accept either.
    return { status: 'failed', failure: malformed(id, 'response carried no text content') };
  }

  return {
    status: 'completed',
    text: content,
    usage: usageOf(record['usage']),
    finish_reason: typeof first['finish_reason'] === 'string' ? (first['finish_reason'] as string) : 'unknown',
    provider_response_id: typeof record['id'] === 'string' ? (record['id'] as string) : undefined,
  };
}

/**
 * `completion_tokens` already includes a reasoning model's hidden reasoning
 * tokens, which is what should be charged: they are billed and they consume
 * the output cap, whether or not the caller ever sees them.
 */
function usageOf(raw: unknown): ProviderUsage {
  if (typeof raw !== 'object' || raw === null) {
    return { input_tokens: undefined, output_tokens: undefined };
  }
  const usage = raw as Record<string, unknown>;
  const input = usage['prompt_tokens'];
  const output = usage['completion_tokens'];
  return {
    input_tokens: typeof input === 'number' ? input : undefined,
    output_tokens: typeof output === 'number' ? output : undefined,
  };
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * The standard `Retry-After` wins; a vendor's own header is the fallback.
 * Both must be relative, because converting an absolute reset timestamp into
 * a delay needs a clock this package may not read
 * (checks/no-ambient-clock.mjs).
 */
function retryDelay(provider: OpenAiCompatibleProvider, headers: Headers): number | undefined {
  const standard = secondsToMs(headers.get('retry-after'));
  if (standard !== undefined) return standard;
  return provider.retryDelayFrom?.(headers);
}

/** Parses a relative header value in seconds, fractions allowed. */
export function secondsToMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}

function classifyStatus(
  id: AdapterId,
  status: number,
  detail: string,
  retryAfter: number | undefined,
): ProviderFailure {
  const delay = retryAfter === undefined ? {} : { retry_after_ms: retryAfter };
  const message = `${id} ${status}: ${detail}`;

  // 402 is the out-of-credits refusal. It is an account problem like 401
  // rather than a bad request, and no retry changes it.
  if (status === 401 || status === 402 || status === 403) {
    return { code: 'unauthorized', message, retryable: false, ...delay };
  }
  if (status === 408) return { code: 'timeout', message, retryable: false, ...delay };
  if (status === 429) return { code: 'rate_limited', message, retryable: true, ...delay };
  if (status >= 500) return { code: 'unavailable', message, retryable: true, ...delay };
  return { code: 'invalid_request', message, retryable: false, ...delay };
}

function classifyTransport(error: unknown): ProviderFailure {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError') return { code: 'cancelled', message, retryable: false };
  if (name === 'TimeoutError') return { code: 'timeout', message, retryable: false };
  return { code: 'unavailable', message, retryable: true };
}

function malformed(id: AdapterId, message: string): ProviderFailure {
  return { code: 'malformed_response', message: `${id}: ${message}`, retryable: false };
}

async function textOf(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}
