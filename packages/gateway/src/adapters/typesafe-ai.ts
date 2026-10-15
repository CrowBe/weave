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
  /** Per-call Fisher-Yates choice ordering. Defaults to Math.random; false disables. Values are clamped to [0, 1); NaN becomes 0. */
  readonly shuffle?: false | (() => number);
  /** TypeSafe documents no data-sharing field as of jev-1.14; Weave never opts in. Defaults to false. */
  readonly dataSharing?: false;
  /** Send the long-context danger-zone header on every request. Defaults to false; raises both context limits to 262k. */
  readonly longContext?: boolean;
  /** Send the images danger-zone header on every request. Defaults to false; does not add asset or box request support. */
  readonly images?: boolean;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Request and response mapping for `/v1/systemone`. No HTTP and no credentials. */
export function typesafeWireProfile(
  options: Pick<TypesafeAiOptions, 'shuffle' | 'dataSharing' | 'longContext' | 'images'> = {},
): DecisionWireProfile {
  const shuffle = options.shuffle ?? Math.random;
  return {
    id: TYPESAFE_AI_ADAPTER,
    path: '/v1/systemone',
    headers: {
      ...(options.longContext === true ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : {}),
      ...(options.images === true ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}),
    },
    // Present on hosted responses. It is the only handle on a call once it has been made.
    requestIdHeader: 'x-typesafe-request-id',
    toBody(call: EvaluationCall): unknown {
      return {
        state: call.state,
        model: call.model,
        questions: Object.fromEntries(
          Object.entries(call.questions).map(([id, question]) => [id, toWireQuestion(question, shuffle)]),
        ),
      };
    },
    parse(body: unknown, call: EvaluationCall): DecisionParse {
      return parseBody(body, call);
    },
  };
}

export const typesafeWire: DecisionWireProfile = typesafeWireProfile({ shuffle: false });

export function typesafeAiEvaluator(options: TypesafeAiOptions): EvaluationAdapter {
  if (options.apiKey.trim().length === 0) {
    throw new Error('typesafeAiEvaluator requires an apiKey');
  }
  return evaluationTransport(typesafeWireProfile(options), {
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

function toWireQuestion(question: EvaluationQuestion, shuffle: false | (() => number)): WireQuestion {
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
    case 'choice': {
      const entries = Object.entries(question.criteria);
      if (shuffle !== false) {
        for (let i = entries.length - 1; i > 0; i--) {
          const sample = shuffle();
          const bounded = Number.isNaN(sample) ? 0 : Math.max(0, Math.min(1 - Number.EPSILON, sample));
          const j = Math.floor(bounded * (i + 1));
          [entries[i], entries[j]] = [entries[j]!, entries[i]!];
        }
      }
      return { type: 'choice', instructions: question.instructions, criteria: Object.fromEntries(entries) };
    }
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.criteria };
  }
}

// ---------------------------------------------------------------------------
// Response translation. An unparseable answer is a malformed response, not a
// judgment. Confidence is copied only when the provider publishes a number.
// Absence is not zero: missing confidence stays below the floor.
// ---------------------------------------------------------------------------

const supportedAnswerTypes = new Map<string, EvaluationAnswer['type']>([
  ['noul', 'boolean'], ['choice', 'choice'], ['score', 'score'],
]);

function parseBody(body: unknown, call: EvaluationCall): DecisionParse {
  if (!isRecord(body)) return { status: 'malformed', detail: 'response body was not an object' };

  const rawAnswers = body['answers'];
  if (!isRecord(rawAnswers)) return { status: 'malformed', detail: 'response carried no answers object' };

  const answers: Record<QuestionId, EvaluationAnswer> = {};
  const confidence: Record<QuestionId, number> = {};

  for (const [id, raw] of Object.entries(rawAnswers)) {
    if (!Object.hasOwn(call.questions, id)) continue;
    const question = call.questions[id]!;
    if (isRecord(raw) && (typeof raw['type'] !== 'string' || !supportedAnswerTypes.has(raw['type']))) continue;
    const answer = toAnswer(raw);
    if (answer === null) return { status: 'malformed', detail: `answer '${id}' was not a recognised shape` };
    if (answer.type !== question.type) {
      return { status: 'malformed', detail: `answer '${id}' did not match the asked question type` };
    }
    if (answer.type === 'choice' && question.type === 'choice') {
      if (!Object.hasOwn(question.criteria, answer.choice)) {
        return { status: 'malformed', detail: `answer '${id}' chose an unknown key` };
      }
      const probabilities = answer.probabilities === undefined ? undefined : Object.fromEntries(
        Object.keys(question.criteria)
          .filter(key => Object.hasOwn(answer.probabilities!, key))
          .map(key => [key, answer.probabilities![key]!]),
      );
      answers[id] = probabilities === undefined ? { type: 'choice', choice: answer.choice }
        : { type: 'choice', choice: answer.choice, probabilities };
    } else {
      answers[id] = answer;
    }

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

  switch (typeof raw['type'] === 'string' ? supportedAnswerTypes.get(raw['type']) : undefined) {
    case 'boolean': {
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
