/** ChatGPT plan Responses transport. Credentials and HTTP arrive from the root. */
import type { GenerationAdapter, GenerationCall, GenerationProviderResult, ProviderFailure } from '../types.js';

export const OPENAI_CHATGPT_PLAN_ADAPTER = 'openai-chatgpt-plan';
export const OPENAI_CHATGPT_PLAN_DESTINATION = 'openai.chatgpt-plan';
export const OPENAI_CHATGPT_PLAN_BASE_URL = 'https://api.openai.com';
export interface OpenaiChatgptPlanOptions {
  readonly accessToken: string | (() => string | Promise<string>);
  readonly baseURL?: string;
  readonly fetch?: typeof globalThis.fetch;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {}; }
function failed(code: ProviderFailure['code'], message: string, retryable = false): GenerationProviderResult { return { status: 'failed', failure: { code, message, retryable } }; }
function redact(value: string, token: string): string {
  if (token.length === 0) return value;
  const variants = [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)];
  for (const variant of variants.sort((a, b) => b.length - a.length)) value = value.split(variant).join('[redacted]');
  return value;
}
function classify(status: number, body: unknown, detail: string): GenerationProviderResult {
  const error = record(record(body)['error']);
  const code = error['code'];
  if (code === 'subscription_sharing_usage_limit_exceeded') return failed('quota_exhausted', detail);
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') return failed('unavailable', detail, true);
  if (code === 'subscription_sharing_user_not_eligible' || code === 'subscription_sharing_invalid_user' || code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context') return failed('unauthorized', detail);
  if (code === 'subscription_sharing_unsupported_capability' || code === 'subscription_sharing_route_not_supported') return failed('invalid_request', detail);
  if (status === 401 || status === 403) return failed('unauthorized', detail);
  if (status === 408) return failed('timeout', detail);
  if (status === 429) return failed('rate_limited', detail, true);
  if (status >= 500) return failed('unavailable', detail, true);
  return failed('invalid_request', detail);
}
function transport(error: unknown, signal: AbortSignal | undefined): GenerationProviderResult {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return failed('cancelled', 'ChatGPT plan request cancelled');
  if (error instanceof Error && error.name === 'TimeoutError') return failed('timeout', 'ChatGPT plan request timed out');
  // Exception messages can contain credentials from transports and token providers.
  return failed('unavailable', 'ChatGPT plan transport interrupted', true);
}
export function openaiChatgptPlanAdapter(options: OpenaiChatgptPlanOptions): GenerationAdapter {
  const base = (options.baseURL ?? OPENAI_CHATGPT_PLAN_BASE_URL).replace(/\/+$/, '');
  return { id: OPENAI_CHATGPT_PLAN_ADAPTER, async execute(call: GenerationCall): Promise<GenerationProviderResult> {
    if (call.signal?.aborted) return failed('cancelled', 'ChatGPT plan request cancelled');
    let token: string;
    try { token = typeof options.accessToken === 'function' ? await options.accessToken() : options.accessToken; }
    catch { return failed('unauthorized', 'ChatGPT plan credential unavailable'); }
    if (typeof token !== 'string' || token.trim().length === 0) return failed('unauthorized', 'ChatGPT plan credential unavailable');
    if (call.signal?.aborted) return failed('cancelled', 'ChatGPT plan request cancelled');
    const safe = (text: string) => redact(text, token);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(`${base}/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        // The plan preview explicitly forbids max_output_tokens and temperature.
        body: JSON.stringify({ model: call.model, input: [{ role: 'user', content: call.prompt }], ...(call.instructions.trim() ? { instructions: call.instructions } : {}), store: false, stream: true }),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      const requestId = response.headers.get('x-request-id');
      const diagnostic = (text: string) => safe(`ChatGPT plan HTTP ${response.status}${requestId === null ? '' : ` (request ${requestId})`}: ${text}`);
      if (!response.ok) {
        const text = await response.text(); let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        const result = classify(response.status, body, diagnostic(text));
        const retry = response.headers.get('retry-after');
        if (result.status === 'failed' && retry !== null && retry.trim() !== '' && Number.isFinite(Number(retry) * 1000) && Number(retry) >= 0) return { status: 'failed', failure: { ...result.failure, retry_after_ms: Number(retry) * 1000 } };
        return result;
      }
      if (response.body === null) return failed('malformed_response', diagnostic('missing stream'));
      const reader = response.body.getReader();
      const abort = () => { void reader.cancel().catch(() => {}); };
      call.signal?.addEventListener('abort', abort, { once: true });
      const decoder = new TextDecoder(); let pending = ''; let data: string[] = []; let eventType = '';
      function dispatch(): GenerationProviderResult | undefined {
        if (data.length === 0) { eventType = ''; return undefined; }
        const payload = data.join('\n'); data = [];
        if (payload === '[DONE]') { eventType = ''; return undefined; }
        let event: RecordValue;
        try { event = record(JSON.parse(payload)); } catch { return failed('malformed_response', diagnostic('invalid SSE JSON')); }
        const type = event['type'] ?? eventType; eventType = '';
        const result = record(event['response']);
        if (type === 'response.failed' || type === 'error') return classify(0, type === 'error' ? { error: event } : result, diagnostic(payload));
        if (type === 'response.incomplete') return failed('malformed_response', diagnostic(payload));
        if (type !== 'response.completed') return undefined;
        if (!Array.isArray(result['output'])) return failed('malformed_response', diagnostic('completed response missing output'));
        let text = '';
        for (const item of result['output']) {
          const content = record(item)['content'];
          if (Array.isArray(content)) for (const part of content) { const entry = record(part); if (entry['type'] === 'output_text' && typeof entry['text'] === 'string') text += entry['text']; }
        }
        const usage = record(result['usage']);
        return { status: 'completed', text: safe(text), finish_reason: 'completed', provider_response_id: typeof result['id'] === 'string' ? safe(result['id']) : undefined,
          usage: { input_tokens: typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : undefined, output_tokens: typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : undefined } };
      }
      function line(value: string): GenerationProviderResult | undefined {
        if (value === '') return dispatch();
        if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
        else if (value.startsWith('event:')) eventType = value.slice(6).trim();
        return undefined;
      }
      try {
        while (true) {
          if (call.signal?.aborted) return failed('cancelled', 'ChatGPT plan request cancelled');
          const chunk = await reader.read();
          if (call.signal?.aborted) return failed('cancelled', 'ChatGPT plan request cancelled');
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) { const next = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); const result = line(next); if (result !== undefined) return result; }
          if (chunk.done) return failed('unavailable', diagnostic('stream ended without response.completed'), true);
        }
      } finally { call.signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error: unknown) { return transport(error, call.signal); }
  } };
}
