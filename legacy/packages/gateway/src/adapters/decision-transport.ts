/**
 * Provider-neutral HTTP transport for a decision wire profile.
 *
 * The profile translates typed questions and answers. This transport only
 * carries that body: it does not choose a route, read the environment, or log.
 * Credentials arrive as options and are redacted from every failure message
 * and from the provider request id.
 * A second profile can plug in here; this phase ships TypeSafe only.
 */
import type {
  AdapterId,
  EvaluationAdapter,
  EvaluationAnswers,
  EvaluationCall,
  EvaluationProviderResult,
  ProviderFailure,
  ProviderUsage,
  QuestionId,
} from '../types.js';

export interface DecisionWireProfile {
  /** Adapter id, also the name used in failure messages. Never a credential. */
  readonly id: AdapterId;
  /** Path under the configured base URL, including the leading slash. */
  readonly path: string;
  /** Response header that carries the provider request id, when one is sent. */
  readonly requestIdHeader: string;
  /** Additional request headers. Authorization and Content-Type are transport-owned. */
  readonly headers?: Readonly<Record<string, string>>;
  toBody(call: EvaluationCall): unknown;
  parse(body: unknown, call: EvaluationCall): DecisionParse;
}

export type DecisionParse =
  | {
      readonly status: 'completed';
      readonly resolved_model_id?: string;
      readonly answers: EvaluationAnswers;
      readonly confidence: Readonly<Record<QuestionId, number>> | undefined;
      readonly usage: ProviderUsage;
    }
  | { readonly status: 'malformed'; readonly detail: string };

export interface EvaluationTransportOptions {
  /** Sent as the Bearer token and redacted from failure messages and request ids. */
  readonly credential: string;
  /**
   * The credential is a fixed public placeholder, such as local Kev's `local`.
   * It is still sent but never redacted, so text like `localhost` survives.
   */
  readonly placeholder?: boolean;
  readonly baseURL?: string;
  readonly defaultBaseURL: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function evaluationTransport(
  profile: DecisionWireProfile,
  options: EvaluationTransportOptions,
): EvaluationAdapter {
  const baseURL = (options.baseURL ?? options.defaultBaseURL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const credential = options.credential;
  const secret = options.placeholder === true ? '' : credential;

  return {
    id: profile.id,
    async evaluate(call: EvaluationCall): Promise<EvaluationProviderResult> {
      const safe = (text: string) => redact(text, secret);
      let response: Response;
      try {
        response = await doFetch(`${baseURL}${profile.path}`, {
          method: 'POST',
          headers: {
            ...Object.fromEntries(
              Object.entries(profile.headers ?? {}).filter(
                ([name]) => !['authorization', 'content-type'].includes(name.trim().toLowerCase()),
              ),
            ),
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(profile.toBody(call)),
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        });
      } catch (error: unknown) {
        return { status: 'failed', failure: classifyTransport(error, safe) };
      }

      const requestId = response.headers.get(profile.requestIdHeader) ?? undefined;
      const provenance = requestId === undefined ? {} : { provider_response_id: safe(requestId) };
      const withId = (message: string) => safe(requestId === undefined ? message : `${message} (request ${requestId})`);

      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const delay = retry === null || retry.trim() === '' ? NaN : Number(retry) * 1000;
        return {
          status: 'failed',
          ...provenance,
          failure: {
            ...classifyStatus(profile.id, response.status, await textOf(response), withId),
            ...(Number.isFinite(delay) && delay >= 0 ? { retry_after_ms: delay } : {}),
          },
        };
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch (error: unknown) {
        // The body never arrived whole: a transport fault or cancellation, not a provider answer.
        return { status: 'failed', ...provenance, failure: classifyTransport(error, withId) };
      }

      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return { status: 'failed', ...provenance, failure: malformed(withId('response body was not JSON')) };
      }

      const parsed = profile.parse(body, call);
      if (parsed.status === 'malformed') {
        return { status: 'failed', ...provenance, failure: malformed(withId(parsed.detail)) };
      }

      return {
        status: 'completed',
        answers: parsed.answers,
        usage: parsed.usage,
        provider_response_id: requestId === undefined ? undefined : safe(requestId),
        confidence: parsed.confidence,
        ...(parsed.resolved_model_id === undefined ? {} : { resolved_model_id: safe(parsed.resolved_model_id) }),
      };
    },
  };
}

/**
 * 400 and 422 are both `invalid_request` and are not retryable. Live TypeSafe
 * returns 400 `api_usage_error` for a wrong-shaped body; the docs also name 422.
 * 529 is TypeSafe's overloaded status and is retryable along with every other 5xx.
 */
function classifyStatus(
  id: string,
  status: number,
  detail: string,
  withId: (message: string) => string,
): ProviderFailure {
  const message = withId(`${id} responded ${status}: ${detail}`);
  if (status === 401 || status === 403) return { code: 'unauthorized', message, retryable: false };
  if (status === 402) return { code: 'quota_exhausted', message, retryable: false };
  if (status === 429) return { code: 'rate_limited', message, retryable: true };
  if (status >= 500) return { code: 'unavailable', message, retryable: true };
  return { code: 'invalid_request', message, retryable: false };
}

function classifyTransport(error: unknown, safe: (text: string) => string): ProviderFailure {
  const message = safe(error instanceof Error ? error.message : String(error));
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return { code: 'cancelled', message, retryable: false };
  if (name === 'TimeoutError') return { code: 'timeout', message, retryable: false };
  return { code: 'unavailable', message, retryable: true };
}

function malformed(message: string): ProviderFailure {
  return { code: 'malformed_response', message, retryable: false };
}

async function textOf(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}

/** Remove the credential, including JSON-escaped and percent-encoded forms. */
export function redact(value: string, secret: string): string {
  if (secret.length === 0) return value;
  const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
  for (const variant of [...new Set(variants)].filter((item) => item.length > 0).sort((a, b) => b.length - a.length)) {
    value = value.split(variant).join('[redacted]');
  }
  return value;
}
