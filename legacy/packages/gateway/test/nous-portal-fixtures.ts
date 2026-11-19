/**
 * Offline Nous Portal endpoint for tests. Catalogue entries are copied (id,
 * context and pricing only) from the key-free live `/v1/models` snapshot taken
 * on 17 Oct 2026; the paid twins show the real priced shape, including
 * `original`. Nothing here reaches a network.
 */
export const NOUS_TEST_BASE = 'https://inference-api.nousresearch.com/v1';
export const MODELS_URL = `${NOUS_TEST_BASE}/models`;
export const CHAT_URL = `${NOUS_TEST_BASE}/chat/completions`;

export const LIVE_CATALOGUE_ENTRIES = [
  {
    id: 'upstage/solar-mini4:free',
    context_length: 524288,
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
  },
  {
    id: 'meituan/longcat-2.0:free',
    context_length: 1048756,
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
  },
  {
    id: 'meituan/longcat-2.5-preview:free',
    context_length: 1048576,
    pricing: { prompt: '0.0000000000', completion: '0.0000000000' },
  },
  {
    id: 'poolside/laguna-s-2.1:free',
    context_length: 262144,
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
  },
  {
    id: 'poolside/laguna-xs-2.1:free',
    context_length: 262144,
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
  },
  {
    id: 'stepfun/step-3.7-flash:free',
    context_length: 262144,
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
  },
  {
    id: 'stepfun/step-5-preview:free',
    context_length: 1048576,
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
  },
  {
    id: 'reflection/beam-1.0-501b-a23b:free',
    context_length: 262144,
    pricing: { prompt: '0.0000000000', completion: '0.0000000000' },
  },
  {
    id: 'upstage/solar-mini4',
    context_length: 524288,
    pricing: {
      prompt: '0.0000000500',
      completion: '0.0000002000',
      input_cache_read: '0.0000000050',
      original: { prompt: '0.0000001000', completion: '0.0000004000', input_cache_read: '0.0000000100' },
    },
  },
  {
    id: 'reflection/beam-1.0-501b-a23b',
    context_length: 1048576,
    pricing: { prompt: '0.0000002500', completion: '0.0000010000' },
  },
  {
    id: 'meituan/longcat-2.0',
    context_length: 1048756,
    pricing: { prompt: '0.0000003000', completion: '0.0000012000', input_cache_read: '0.0000000060' },
  },
] as const;

export const LIVE_CATALOGUE = { data: LIVE_CATALOGUE_ENTRIES };

/** Replace one model's pricing in a copy of the live catalogue. */
export function catalogueWith(model: string, pricing: unknown): { data: unknown[] } {
  return { data: LIVE_CATALOGUE_ENTRIES.map((entry) => (entry.id === model ? { ...entry, pricing } : entry)) };
}

export function catalogueWithout(model: string): { data: unknown[] } {
  return { data: LIVE_CATALOGUE_ENTRIES.filter((entry) => entry.id !== model) };
}

export function completionBody(
  text: string | null = 'ok',
  usage: Record<string, unknown> | undefined = { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost: 0 },
  model = 'upstage/solar-mini4:free',
) {
  return {
    id: 'gen-1',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    ...(usage === undefined ? {} : { usage }),
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown> | undefined;
}

/**
 * Serves the catalogue on GET /models and a chat handler on POST
 * /chat/completions, recording every request in order.
 */
export function nousEndpoint(
  options: {
    catalogue?: (sent: Sent) => Response | Promise<Response>;
    chat?: (body: Record<string, unknown>, sent: Sent) => Response | Promise<Response>;
  } = {},
) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const request: Sent = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
    };
    sent.push(request);
    init?.signal?.throwIfAborted();
    if (request.url.endsWith('/models')) return await (options.catalogue?.(request) ?? json(LIVE_CATALOGUE));
    return await (options.chat?.(body ?? {}, request) ??
      json(completionBody('ok', undefined, String(body?.['model']))));
  };
  return {
    fetch,
    sent,
    get catalogueRequests() {
      return sent.filter((s) => s.url.endsWith('/models'));
    },
    get chatRequests() {
      return sent.filter((s) => s.url.endsWith('/chat/completions'));
    },
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
