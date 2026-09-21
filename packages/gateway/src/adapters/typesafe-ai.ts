/**
 * Provider adapter: TypeSafe AI's System One API, called directly.
 *
 * This is the fallback path for evaluation. The same model is reachable through
 * the Vercel AI Gateway (`./vercel-ai-gateway.ts`), and normally that is the
 * route to use; this one exists so a judgment site is not stranded when the
 * gateway throttles or is unavailable. Nothing in the gateway branches on which
 * is which — they are two routed units, and escalation picks the second when
 * the first stops working.
 *
 * Note the destination. Content sent here crosses a different boundary than
 * content sent to Vercel, so `TYPESAFE_AI_DESTINATION` is its own value and a
 * caller reaches this route only by naming it in `terms.destinations`. Falling
 * back to a different vendor is a disclosure decision, not plumbing.
 *
 * The wire vocabulary is not quite the gateway's. TypeSafe calls a boolean
 * question a `noul` and returns its probability under that name; this adapter
 * translates in both directions so the shape difference stops here.
 *
 * Depends on nothing but `fetch`, and reads no ambient state: credentials and
 * the HTTP implementation both arrive as options.
 */
import type {
  EvaluationAdapter,
  EvaluationAnswer,
  EvaluationAnswers,
  EvaluationCall,
  EvaluationProviderResult,
  EvaluationQuestion,
  ProviderFailure,
  QuestionId,
} from '../types.js';

export const TYPESAFE_AI_ADAPTER = 'typesafe-ai';

/** Use as a routed unit's `destination`: the privacy boundary content crosses. */
export const TYPESAFE_AI_DESTINATION = 'typesafe-ai';

export const TYPESAFE_AI_BASE_URL = 'https://api.typesafe.ai';

export interface TypesafeAiOptions {
  /**
   * The TypeSafe AI API key. Required: the composition root decides where a
   * credential comes from, so nothing here reads ambient process state.
   */
  readonly apiKey: string;
  readonly baseURL?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

export function typesafeAiEvaluator(options: TypesafeAiOptions): EvaluationAdapter {
  if (options.apiKey.trim().length === 0) {
    throw new Error('typesafeAiEvaluator requires an apiKey');
  }
  const baseURL = (options.baseURL ?? TYPESAFE_AI_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    id: TYPESAFE_AI_ADAPTER,
    async evaluate(call: EvaluationCall): Promise<EvaluationProviderResult> {
      let response: Response;
      try {
        response = await doFetch(`${baseURL}/v1/systemone`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            state: call.state,
            model: call.model,
            questions: Object.fromEntries(
              Object.entries(call.questions).map(([id, q]) => [id, toWireQuestion(q)]),
            ),
          }),
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        });
      } catch (error: unknown) {
        return { status: 'failed', failure: classifyTransport(error) };
      }

      // The request id is undocumented but present, and it is the only handle
      // on a call once it has been made. Take it whether or not the call worked.
      const requestId = response.headers.get('x-typesafe-request-id') ?? undefined;

      if (!response.ok) {
        return {
          status: 'failed',
          failure: classifyStatus(response.status, await textOf(response), requestId),
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          status: 'failed',
          failure: malformed('response body was not JSON', requestId),
        };
      }

      const parsed = parseBody(body);
      if ('error' in parsed) {
        return { status: 'failed', failure: malformed(parsed.error, requestId) };
      }

      return {
        status: 'completed',
        answers: parsed.answers,
        usage: parsed.usage,
        provider_response_id: requestId,
        confidence: parsed.confidence,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Request translation. `boolean` is `noul` on the wire.
// ---------------------------------------------------------------------------

type WireQuestion = Readonly<Record<string, unknown>>;

function toWireQuestion(question: EvaluationQuestion): WireQuestion {
  switch (question.type) {
    case 'boolean': {
      const criteria = question.criteria;
      const wire: Record<string, unknown> = { type: 'noul', instructions: question.instructions };
      if (criteria !== undefined) {
        const pairs: Record<string, unknown> = {};
        if (criteria.true !== undefined) pairs['true'] = criteria.true;
        if (criteria.false !== undefined) pairs['false'] = criteria.false;
        if (Object.keys(pairs).length > 0) wire['criteria'] = pairs;
      }
      return wire;
    }
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: question.criteria };
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.criteria };
  }
}

// ---------------------------------------------------------------------------
// Response translation. Read defensively: an unparseable answer is a malformed
// response, not a judgment to be acted on.
// ---------------------------------------------------------------------------

interface ParsedBody {
  readonly answers: EvaluationAnswers;
  readonly confidence: Readonly<Record<QuestionId, number>> | undefined;
  readonly usage: { readonly input_tokens: number | undefined; readonly output_tokens: number | undefined };
}

function parseBody(body: unknown): ParsedBody | { readonly error: string } {
  if (!isRecord(body)) return { error: 'response body was not an object' };

  const rawAnswers = body['answers'];
  if (!isRecord(rawAnswers)) return { error: 'response carried no answers object' };

  const answers: Record<QuestionId, EvaluationAnswer> = {};
  const confidence: Record<QuestionId, number> = {};

  for (const [id, raw] of Object.entries(rawAnswers)) {
    const answer = toAnswer(raw);
    if (answer === null) return { error: `answer '${id}' was not a recognised shape` };
    answers[id] = answer;

    if (isRecord(raw) && typeof raw['confidence'] === 'number') {
      confidence[id] = raw['confidence'];
    }
  }

  const usage = isRecord(body['usage']) ? body['usage'] : {};
  return {
    answers,
    confidence: Object.keys(confidence).length > 0 ? confidence : undefined,
    usage: {
      input_tokens: numberOrUndefined(usage['input_tokens']),
      output_tokens: numberOrUndefined(usage['output_tokens']),
    },
  };
}

function toAnswer(raw: unknown): EvaluationAnswer | null {
  if (!isRecord(raw)) return null;

  switch (raw['type']) {
    case 'noul': {
      const probability = raw['noul'];
      if (typeof probability !== 'number') return null;
      return { type: 'boolean', probability };
    }
    case 'choice': {
      const choice = raw['choice'];
      if (typeof choice !== 'string') return null;
      const probabilities = numberMap(raw['probabilities']);
      return probabilities === undefined
        ? { type: 'choice', choice }
        : { type: 'choice', choice, probabilities };
    }
    case 'score': {
      const score = raw['score'];
      if (typeof score !== 'number') return null;
      const probabilities = numberMap(raw['probabilities']);
      // `legend` echoes the criteria back; the caller already has them.
      return probabilities === undefined ? { type: 'score', score } : { type: 'score', score, probabilities };
    }
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function numberMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number') out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Failure classification, against the documented status codes.
// ---------------------------------------------------------------------------

function classifyStatus(status: number, detail: string, requestId: string | undefined): ProviderFailure {
  const message = withRequestId(`typesafe-ai responded ${status}: ${detail}`, requestId);
  if (status === 401 || status === 403) return { code: 'unauthorized', message, retryable: false };
  if (status === 402) return { code: 'quota_exhausted', message, retryable: false };
  if (status === 429) return { code: 'rate_limited', message, retryable: true };
  // 529 is TypeSafe's "overloaded"; it lands here with the other 5xx.
  if (status >= 500) return { code: 'unavailable', message, retryable: true };
  return { code: 'invalid_request', message, retryable: false };
}

function classifyTransport(error: unknown): ProviderFailure {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return { code: 'cancelled', message, retryable: false };
  if (name === 'TimeoutError') return { code: 'timeout', message, retryable: false };
  // A transport fault says nothing about the request; another attempt is fair.
  return { code: 'unavailable', message, retryable: true };
}

function malformed(detail: string, requestId: string | undefined): ProviderFailure {
  return { code: 'malformed_response', message: withRequestId(detail, requestId), retryable: false };
}

function withRequestId(message: string, requestId: string | undefined): string {
  return requestId === undefined ? message : `${message} (request ${requestId})`;
}

async function textOf(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}
