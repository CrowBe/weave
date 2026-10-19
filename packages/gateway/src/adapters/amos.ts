/** Local Amos System One decision provider. No credentials or ambient state. */
import type {
  EvaluationAdapter,
  EvaluationAnswer,
  EvaluationCall,
  EvaluationContent,
  EvaluationProviderResult,
  EvaluationQuestion,
  ProviderFailureCode,
} from '../types.js';

export const AMOS_ADAPTER = 'amos';
export const AMOS_DESTINATION = 'amos';
export const AMOS_BASE_URL = 'http://127.0.0.1:8766';
export const AMOS_MODEL = 'amos-1-2b';

export function resolveAmosBaseURL(env: Readonly<Record<string, string | undefined>>): string {
  return env['AMOS_BASE_URL'] ?? AMOS_BASE_URL;
}

export interface AmosOptions {
  readonly baseURL?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Total bound covering health, decision, and response body reads. */
  readonly timeoutMs?: number;
}

/** The exact decision wire body, also used to bind non-executing benchmark replay. */
export function amosBody(call: Pick<EvaluationCall, 'model' | 'state' | 'questions'>): unknown {
  return {
    model: call.model,
    state: content(call.state),
    questions: Object.fromEntries(
      Object.entries(call.questions).map(([id, question]) => [id, wireQuestion(question)]),
    ),
  };
}

export function amosEvaluator(options: AmosOptions = {}): EvaluationAdapter {
  const baseURL = (options.baseURL ?? AMOS_BASE_URL).replace(/\/+$/, '');
  const url = parseURL(baseURL);
  if (url === null || !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || baseURL.includes('?') || baseURL.includes('#')) {
    throw new Error('Amos base URL must be a loopback HTTP URL without credentials, query, or fragment');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Amos timeout must be a positive integer');
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    id: AMOS_ADAPTER,
    async evaluate(call): Promise<EvaluationProviderResult> {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = call.signal === undefined ? deadline : AbortSignal.any([deadline, call.signal]);
      try {
        const health = await doFetch(`${baseURL}/v1/models`, { method: 'GET', signal, redirect: 'error' });
        if (!health.ok) return failure('unavailable');
        const models: unknown = await health.json();
        if (!record(models) || !Array.isArray(models['models']) || models['models'].length === 0 ||
            !models['models'].every((model: unknown) =>
              record(model) && typeof model['name'] === 'string' && model['name'].length > 0)) {
          return failure('unavailable');
        }
        // The server answers an unknown model with its own, so check the configured one is served.
        // Retrying cannot change that, so the failure is not retryable.
        if (!models['models'].some((model: unknown) => record(model) && model['name'] === call.model)) {
          return failure('unavailable', false);
        }
        const response = await doFetch(`${baseURL}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal,
          redirect: 'error',
          body: JSON.stringify(amosBody(call)),
        });
        if (!response.ok) return failure(response.status >= 500 ? 'unavailable' : 'invalid_request');
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return signal.aborted
            ? failure(call.signal?.aborted ? 'cancelled' : 'unavailable')
            : failure('malformed_response');
        }
        return parse(body, call);
      } catch {
        // Provider exceptions, response text, and request ids are never evidence.
        return failure(call.signal?.aborted ? 'cancelled' : 'unavailable');
      }
    },
  };
}

/** An empty or unparseable base URL gets the loopback error, not a bare TypeError. */
function parseURL(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function content(value: EvaluationContent | null): string | null {
  return value === null || typeof value === 'string' ? value : JSON.stringify(value);
}

function wireQuestion(question: EvaluationQuestion): unknown {
  const instructions = content(question.instructions);
  if (question.type === 'score') return { type: 'score', instructions, criteria: question.criteria.map(content) };
  if (question.type === 'choice') {
    return {
      type: 'choice',
      instructions,
      criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, content(value)])),
    };
  }
  return {
    type: 'noul',
    instructions,
    ...(question.criteria === undefined ? {} : {
      criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, content(value)])),
    }),
  };
}

function parse(body: unknown, call: EvaluationCall): EvaluationProviderResult {
  if (!record(body) || body['model'] !== call.model || !record(body['answers']) || !record(body['usage'])) {
    return failure('malformed_response');
  }
  const rawAnswers = body['answers'];
  if (!sameKeys(rawAnswers, Object.keys(call.questions))) return failure('malformed_response');
  const answers: Record<string, EvaluationAnswer> = {};
  const confidence: Record<string, number> = {};
  for (const [id, question] of Object.entries(call.questions)) {
    const raw = rawAnswers[id];
    if (!record(raw)) return failure('malformed_response');
    if (raw['confidence'] !== undefined) {
      if (!probability(raw['confidence'])) return failure('malformed_response');
      confidence[id] = raw['confidence'];
    }
    if (question.type === 'boolean') {
      if (raw['type'] !== 'noul' || !probability(raw['noul'])) return failure('malformed_response');
      answers[id] = { type: 'boolean', probability: raw['noul'] };
    } else if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      if (raw['type'] !== 'choice' || typeof raw['choice'] !== 'string' || !keys.includes(raw['choice'])) {
        return failure('malformed_response');
      }
      const probabilities = distribution(raw['probabilities'], keys);
      if (!probabilities) return failure('malformed_response');
      answers[id] = { type: 'choice', choice: raw['choice'], probabilities };
    } else {
      const keys = question.criteria.map((_, index) => String(index));
      if (raw['type'] !== 'score' || typeof raw['score'] !== 'number' || !Number.isFinite(raw['score']) ||
          raw['score'] < 0 || raw['score'] > question.criteria.length - 1 ||
          !record(raw['legend']) || !sameKeys(raw['legend'], keys)) {
        return failure('malformed_response');
      }
      const legend = raw['legend'];
      if (!question.criteria.every((level, index) => echoesLevel(legend[String(index)], content(level)))) {
        return failure('malformed_response');
      }
      const probabilities = distribution(raw['probabilities'], keys);
      if (!probabilities) return failure('malformed_response');
      answers[id] = { type: 'score', score: raw['score'], probabilities };
    }
  }
  const usage = body['usage'];
  if (!tokens(usage['input_tokens']) || !tokens(usage['output_tokens'])) return failure('malformed_response');
  return {
    status: 'completed',
    answers,
    confidence: Object.keys(confidence).length ? confidence : undefined,
    usage: { input_tokens: usage['input_tokens'], output_tokens: usage['output_tokens'] },
    provider_response_id: undefined,
  };
}

/** The live server echoes a null level as the string "null" (review of #106); accept that or null, nothing else. */
function echoesLevel(echoed: unknown, level: string | null): boolean {
  return echoed === level || (level === null && echoed === 'null');
}

function distribution(value: unknown, keys: readonly string[]): Record<string, number> | undefined {
  if (!record(value) || !sameKeys(value, keys)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => probability(entry))) return undefined;
  // Allow float serialization rounding, never renormalize a bad distribution.
  if (Math.abs(entries.reduce((sum, [, entry]) => sum + (entry as number), 0) - 1) > 0.001) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function tokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function failure(code: ProviderFailureCode, retryable = code === 'unavailable'): EvaluationProviderResult {
  return { status: 'failed', failure: { code, message: `amos ${code}`, retryable } };
}
