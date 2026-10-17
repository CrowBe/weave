/** Direct benchmark routes: no gateway policy, shuffles, tier downgrades or ambient credentials. */
import { typesafeWireProfile } from '@weave/gateway/typesafe-ai';
import { amosBody, amosEvaluator } from '@weave/gateway/amos';
import type { EvaluationAnswer, EvaluationCall, EvaluationQuestion } from '@weave/gateway';
import type { Answer, Provider, Request, Result } from './types.ts';
export type { Answer, Provider, Request, Result } from './types.ts';
export const PRICES = Object.freeze({
  // https://docs.typesafe.ai/models (pinned Jev 1.14); output free.
  'typesafe-jev': { input_per_million: .042, source: 'https://docs.typesafe.ai/models' },
  // Decisions guide: $0.10/M input, no output or cache charges (source below).
  // Unconfirmed until a credentialed benchmark run; metering remains input-only.
  'openai-decisions': { input_per_million: .10, source: 'https://developers.openai.com/api/docs/guides/decisions' },
});
export interface ProvidersConfig {
  typesafeKey?: string | undefined;
  openaiKey?: string;
  amosBaseURL?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Required for parsing HTTP-date Retry-After without an ambient clock. */
  now?: () => number;
}
export function buildProviders(config: ProvidersConfig): Provider[] {
  const wire = typesafeWireProfile({ shuffle: false });
  const call = (request: Request, model: string, signal?: AbortSignal): EvaluationCall => ({ ...request, model, signal, kind: Object.values(request.questions)[0]?.type ?? 'boolean' });
  return [
    httpProvider('typesafe-jev', 'jev-1.14.0', PRICES['typesafe-jev'].input_per_million,
      config.typesafeKey, 'https://api.typesafe.ai/v1/systemone', request => wire.toBody(call(request, 'jev-1.14.0')), config),
    amosProvider(config),
    httpProvider('openai-decisions', 'gpt-6-luna', PRICES['openai-decisions'].input_per_million,
      config.openaiKey, 'https://api.openai.com/v1/decisions', request => openaiBody(request), config),
  ];
}
function httpProvider(id: string, model: string, price: number, key: string | undefined, url: string,
  body: (request: Request) => unknown, config: ProvidersConfig): Provider {
  let skipped: Result | undefined;
  const safe = (value: unknown) => safeMetadata(value,config);
  return { id, model, price,
    serialize: request => JSON.stringify(body(request)),
    async request(request, external): Promise<Result> {
      if (external.aborted) return { status: 'failed', reason: 'cancelled' };
      if (skipped) return skipped;
      if (!key?.trim()) return { status: 'skipped', reason: 'no_credential' };
      const signal = AbortSignal.any([external, AbortSignal.timeout(config.timeoutMs ?? 30_000)]);
      try {
        const response = await (config.fetch ?? globalThis.fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body(request)), signal, redirect: 'error' });
        const requestId = safe(response.headers.get(id === 'typesafe-jev' ? 'x-typesafe-request-id' : 'x-request-id'));
        const metadata = { http_status: response.status, ...(requestId === undefined ? {} : { request_id: requestId }) };
        let raw: unknown;
        try { raw = await response.json(); } catch {
          if (external.aborted) throw new Error('unacknowledged_call');
          if (response.ok && signal.aborted) return { status: 'failed', reason: 'timeout', ...metadata };
          if (response.ok) return { status: 'failed', reason: 'malformed_body', ...metadata }; raw = {};
        }
        const usage = record(raw) && record(raw.usage) ? raw.usage : {};
        const tokens = { ...(token(usage.input_tokens) ? { input_tokens: usage.input_tokens } : {}), ...(token(usage.output_tokens) ? { output_tokens: usage.output_tokens } : {}) };
        if (!response.ok) {
          const code = safe(record(raw) && record(raw.error) ? raw.error.code : undefined);
          const reason = response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'http_error';
          const result: Result = { status: reason === 'unauthorized' ? 'skipped' : 'failed', reason, ...metadata, ...tokens, ...(code === undefined ? {} : { error_code: code }) };
          if (response.status === 429) {
            const value = response.headers.get('retry-after');
            if (value !== null) {
              const seconds = Number(value);
              const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : config.now ? Date.parse(value) - config.now() : NaN;
              if (Number.isFinite(ms)) result.retry_after_ms = Math.max(0, ms);
            }
          }
          if (reason === 'unauthorized') skipped = result;
          return result;
        }
        if (!record(raw)) return { status: 'failed', reason: 'malformed_body', ...metadata, ...tokens };
        if (raw.refusal || raw.status === 'refused' || (Array.isArray(raw.answers) && raw.answers.some((entry: unknown) => record(entry) && entry.type === 'refusal'))) return { status: 'failed', reason: 'refusal', ...metadata, ...tokens };
        if (typeof raw.model !== 'string' || raw.model !== model) return { status: 'failed', reason: 'wrong_model', ...(typeof raw.model === 'string' ? { model: safe(raw.model)! } : {}), ...metadata, ...tokens };
        const answers = id === 'openai-decisions' ? parseOpenAI(raw, request) : parseTypeSafe(raw, request);
        if (!token(usage.input_tokens) || !token(usage.output_tokens)) return { status: 'failed', reason: 'missing_usage', model, ...metadata, ...tokens };
        if (!answers) return { status: 'failed', reason: 'malformed_answers', model, ...metadata, ...tokens };
        return { status: 'ok', model, answers, ...metadata, ...tokens };
      } catch {
        // Fetch was called: cancellation cannot prove that inference was unbilled.
        // No usable receipt leaves the engine's intent and reservation pending.
        if (external.aborted) throw new Error('unacknowledged_call');
        return { status: 'failed', reason: signal.aborted ? 'timeout' : 'network_error' };
      }
    },
  };
}
function amosProvider(config: ProvidersConfig): Provider {
  const baseURL = (config.amosBaseURL ?? 'http://127.0.0.1:8766').replace(/\/+$/, '');
  const fetch = config.fetch ?? globalThis.fetch;
  return { id: 'amos-small', model: 'amos-1-2b', price: 0,
    serialize: request => JSON.stringify(amosBody({model:'amos-1-2b',...request})),
    async request(request, external) {
      if (external.aborted) return { status: 'failed', reason: 'cancelled' };
      try {
        const signal = AbortSignal.any([external, AbortSignal.timeout(config.timeoutMs ?? 30_000)]);
        let observed: unknown;
        const observedFetch: typeof globalThis.fetch = async (url, init) => {
          // Share this item's preflight response with the adapter's health check.
          if (String(url) === `${baseURL}/v1/models`) return health.clone();
          const response = await fetch(url, init);
          if (String(url).endsWith('/v1/systemone')) {
            // The existing adapter intentionally drops the echoed model. Capture the
            // benchmark provenance without changing the runtime adapter or consuming its body.
            try { observed = await response.clone().json(); } catch { observed = undefined; }
          }
          return response;
        };
        // Construction enforces loopback-only configuration before any traffic.
        const adapter = amosEvaluator({ baseURL, fetch: observedFetch, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) });
        const health = await fetch(`${baseURL}/v1/models`, { signal, redirect: 'error' });
        if (!health.ok) return { status: 'failed', reason: 'models_unavailable', http_status: health.status };
        const data: unknown = await health.clone().json();
        if (!record(data) || !Array.isArray(data.models)) return { status: 'failed', reason: 'models_unavailable' };
        const served = data.models.find((entry: unknown) => record(entry) && entry.name === 'amos-1-2b');
        const supported = data.question_types ?? data.supported_question_types ?? (record(served) ? served.question_types ?? served.supported_question_types ?? (typeof served.description === 'string' ? served.description.match(/\b(?:noul|choice|score)\b/g) : undefined) : undefined);
        // No assumptions about local server support: absent declaration fails closed.
        if (!Array.isArray(supported) || Object.values(request.questions).some(q => !supported.includes(q.type === 'boolean' ? 'noul' : q.type))) return { status: 'skipped', reason: 'unsupported_question_type' };
        if (!record(served)) return { status: 'skipped', reason: 'model_not_listed' };
        const result = await adapter.evaluate({ ...request, model: 'amos-1-2b', signal, kind: Object.values(request.questions)[0]?.type ?? 'boolean' });
        if (external.aborted) return { status: 'failed', reason: 'cancelled' };
        const rawUsage = record(observed) && record(observed.usage) ? observed.usage : {};
        const usage = { ...(token(rawUsage.input_tokens) ? { input_tokens: rawUsage.input_tokens } : {}), ...(token(rawUsage.output_tokens) ? { output_tokens: rawUsage.output_tokens } : {}) };
        const rawModel = record(observed) ? observed.model : undefined;
        const safeModel = safeMetadata(rawModel,config);
        const modelEvidence = safeModel === undefined ? {} : { model: safeModel };
        if (rawModel !== undefined && rawModel !== 'amos-1-2b') return { status: 'failed', reason: 'wrong_model', ...modelEvidence, ...usage };
        if (result.status !== 'completed') return { status: 'failed', reason: result.failure.code, ...modelEvidence, ...usage };
        if (rawModel !== 'amos-1-2b') return { status: 'failed', reason: 'wrong_model', ...modelEvidence, ...usage };
        const answers: Record<string, Answer> = {};
        for (const [id, answer] of Object.entries(result.answers)) answers[id] = { ...normalize(answer), ...(result.confidence?.[id] === undefined ? {} : { confidence: result.confidence[id] }) };
        return { status: 'ok', model: 'amos-1-2b', answers, ...(result.usage.input_tokens === undefined ? {} : { input_tokens: result.usage.input_tokens }), ...(result.usage.output_tokens === undefined ? {} : { output_tokens: result.usage.output_tokens }) };
      } catch { return { status: 'failed', reason: external.aborted ? 'cancelled' : 'models_unavailable' }; }
    },
  };
}
function safeMetadata(value:unknown,config:ProvidersConfig):string|undefined {
  if(typeof value!=='string')return undefined;
  let output=value;
  for(const secret of [config.typesafeKey,config.openaiKey].filter((entry):entry is string=>!!entry)) {
    for(const variant of [secret,JSON.stringify(secret).slice(1,-1),encodeURIComponent(secret)])output=output.split(variant).join('[redacted]');
  }
  return output.slice(0,200);
}
export function openaiBody(request: Request): unknown {
  return { model: 'gpt-6-luna', input: typeof request.state === 'string' ? request.state : JSON.stringify(request.state), questions: Object.entries(request.questions).map(([name, q]) => {
    const common = { name, instructions: q.instructions };
    if (q.type === 'boolean') return { ...common, type: 'predicate', ...(q.criteria === undefined ? {} : { criteria: q.criteria }) };
    if (q.type === 'choice') return { ...common, type: 'choice', choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })) };
    return { ...common, type: 'score', levels: q.criteria.map((description, value) => ({ label: String(value), description })) };
  }) };
}
function parseTypeSafe(raw: Record<string, unknown>, request: Request): Record<string, Answer> | undefined {
  if (!record(raw.answers) || Object.keys(raw.answers).length !== Object.keys(request.questions).length) return undefined;
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    const value = raw.answers[id];
    if (!record(value) || value.refusal || value.type !== (q.type === 'boolean' ? 'noul' : q.type)) return undefined;
    const answer = checkedAnswer(value, q, q.type === 'boolean' ? value.noul : undefined);
    if (!answer) return undefined;
    out[id] = answer;
  }
  return out;
}
function parseOpenAI(raw: Record<string, unknown>, request: Request): Record<string, Answer> | undefined {
  if (!Array.isArray(raw.answers) || raw.answers.length !== Object.keys(request.questions).length) return undefined;
  const out: Record<string, Answer> = {};
  for (const value of raw.answers) {
    if (!record(value) || typeof value.name !== 'string' || value.refusal || value.type === 'refusal' || Object.hasOwn(out, value.name)) return undefined;
    const q = request.questions[value.name];
    if (!q || value.type !== (q.type === 'boolean' ? 'predicate' : q.type)) return undefined;
    const mapped = { ...value };
    if (Array.isArray(value.probabilities)) {
      const probabilities: Record<string, number> = {};
      for (const entry of value.probabilities) {
        if (!record(entry) || typeof entry.value !== 'string' || !probability(entry.probability) || Object.hasOwn(probabilities, entry.value)) return undefined;
        probabilities[entry.value] = entry.probability;
      }
      mapped.probabilities = probabilities;
    }
    const answer = checkedAnswer(mapped, q, q.type === 'boolean' ? value.probability : undefined);
    if (!answer) return undefined;
    out[value.name] = answer;
  }
  return out;
}
function checkedAnswer(value: Record<string, unknown>, q: EvaluationQuestion, p?: unknown): Answer | undefined {
  if (value.confidence !== undefined && !probability(value.confidence)) return undefined;
  const confidence = value.confidence === undefined ? {} : { confidence: value.confidence as number };
  const probabilities: Record<string, number> = {};
  if (value.probabilities !== undefined) {
    if (!record(value.probabilities)) return undefined;
    for (const [key, entry] of Object.entries(value.probabilities)) {
      if (!probability(entry) || (q.type === 'choice' && !Object.hasOwn(q.criteria, key))) return undefined;
      probabilities[key] = entry;
    }
  }
  const distribution = value.probabilities === undefined ? {} : { probabilities };
  if (q.type === 'boolean') return probability(p) ? { probability: p, ...confidence } : undefined;
  if (q.type === 'choice') return typeof value.choice === 'string' && Object.hasOwn(q.criteria, value.choice) ? { choice: value.choice, ...distribution, ...confidence } : undefined;
  return typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= q.criteria.length - 1 ? { score: value.score, ...distribution, ...confidence } : undefined;
}
function normalize(answer: EvaluationAnswer): Answer {
  if (answer.type === 'boolean') return { probability: answer.probability };
  return { ...(answer.type === 'choice' ? { choice: answer.choice } : { score: answer.score }), ...(answer.probabilities === undefined ? {} : { probabilities: { ...answer.probabilities } }) };
}
function token(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
export function probability(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
