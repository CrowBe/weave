/**
 * Provider adapter: TypeSafe AI's System One API, called directly.
 *
 * The wire profile below is the request and response mapping for
 * `/v1/systemone`. HTTP, status classification, and credential redaction live
 * in the shared decision transport. TypeSafe direct is the sole decision
 * provider. OpenAI Decisions, Cloudflare Workers AI, and the Vercel route are
 * deferred; a second profile can use the same transport later.
 *
 * Note the destination. Content sent here crosses a different boundary than
 * content sent to Vercel, so `TYPESAFE_AI_DESTINATION` is its own value and a
 * caller reaches this route only by naming it in `terms.destinations`.
 *
 * The wire vocabulary is not quite the gateway's. TypeSafe calls a boolean
 * question a `noul` and returns its probability under that name; this profile
 * translates in both directions so the shape difference stops here. Choice and
 * score criteria stay under `criteria` — not `choices` or `levels`.
 *
 * Depends on nothing but `fetch`, and reads no ambient state: credentials and
 * the HTTP implementation both arrive as options. `baseURL` selects a locally
 * run TypeSafe or Jev without changing the profile. The default is
 * `https://api.typesafe.ai`.
 */
import type {
  EvaluationAdapter,
  EvaluationAnswer,
  EvaluationCall,
  EvaluationQuestion,
  QuestionId,
} from '../types.js';
import {
  evaluationTransport,
  type DecisionParse,
  type DecisionWireProfile,
} from './decision-transport.js';

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

/** Request and response mapping for `/v1/systemone`. No HTTP and no credentials. */
export const typesafeWire: DecisionWireProfile = {
  id: TYPESAFE_AI_ADAPTER,
  path: '/v1/systemone',
  // Present on hosted responses. It is the only handle on a call once it has been made.
  requestIdHeader: 'x-typesafe-request-id',
  toBody(call: EvaluationCall): unknown {
    return {
      state: call.state,
      model: call.model,
      questions: Object.fromEntries(
        Object.entries(call.questions).map(([id, question]) => [id, toWireQuestion(question)]),
      ),
    };
  },
  parse(body: unknown): DecisionParse {
    return parseBody(body);
  },
};

export function typesafeAiEvaluator(options: TypesafeAiOptions): EvaluationAdapter {
  if (options.apiKey.trim().length === 0) {
    throw new Error('typesafeAiEvaluator requires an apiKey');
  }
  return evaluationTransport(typesafeWire, {
    credential: options.apiKey,
    defaultBaseURL: TYPESAFE_AI_BASE_URL,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

// ---------------------------------------------------------------------------
// Request translation. `boolean` is `noul` on the wire. Criteria stay `criteria`.
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
// Response translation. An unparseable answer is a malformed response, not a
// judgment. Confidence is copied only when the provider publishes a number.
// Absence is not zero: missing confidence stays below the floor.
// ---------------------------------------------------------------------------

function parseBody(body: unknown): DecisionParse {
  if (!isRecord(body)) return { status: 'malformed', detail: 'response body was not an object' };

  const rawAnswers = body['answers'];
  if (!isRecord(rawAnswers)) return { status: 'malformed', detail: 'response carried no answers object' };

  const answers: Record<QuestionId, EvaluationAnswer> = {};
  const confidence: Record<QuestionId, number> = {};

  for (const [id, raw] of Object.entries(rawAnswers)) {
    const answer = toAnswer(raw);
    if (answer === null) return { status: 'malformed', detail: `answer '${id}' was not a recognised shape` };
    answers[id] = answer;

    if (isRecord(raw) && typeof raw['confidence'] === 'number') {
      confidence[id] = raw['confidence'];
    }
  }

  const usage = isRecord(body['usage']) ? body['usage'] : {};
  return {
    status: 'completed',
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
