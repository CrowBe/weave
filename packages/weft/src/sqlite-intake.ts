/** Optional OTLP/JSON intake. Transport exists only when explicitly injected. */
import { createHash } from 'node:crypto';
import type { RequestListener, Server } from 'node:http';
import { serializeRecord } from './serialize.js';
import type { Redactor, WeftRecord } from './types.js';
import type { TraceStore } from './sqlite.js';
import type { TraceWriteResult } from './weave-trace.js';

type Obj = Record<string, unknown>;
type Failure = Extract<TraceWriteResult, { ok: false }>;
export interface IntakeOptions { readonly redact: Redactor }
export type IntakeResult = { readonly ok: true; readonly records: readonly WeftRecord[] } | Failure;
const failure = (reason: Failure['reason']): Failure => ({ ok: false, reason });
const object = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
function obj(x: unknown): Obj { if (!object(x)) throw new Error('input'); return x; }
function array(x: unknown): unknown[] { if (!Array.isArray(x)) throw new Error('input'); return x; }
function hex(x: unknown, length: number): string {
  if (typeof x !== 'string' || !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(x) || /^0+$/.test(x)) throw new Error('input');
  return x.toLowerCase();
}
function anyValue(raw: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error('input');
  const v = obj(raw);
  if (Object.keys(v).length !== 1) throw new Error('input');
  if (typeof v['stringValue'] === 'string') return v['stringValue'];
  if (typeof v['boolValue'] === 'boolean') return v['boolValue'];
  if (typeof v['intValue'] === 'string' && /^-?\d+$/.test(v['intValue'])) {
    const n = Number(v['intValue']); if (Number.isSafeInteger(n)) return n;
  }
  if (typeof v['doubleValue'] === 'number' && Number.isFinite(v['doubleValue'])) return v['doubleValue'];
  if (v['arrayValue'] !== undefined) return array(obj(v['arrayValue'])['values']).map(value => anyValue(value, depth + 1));
  if (v['kvlistValue'] !== undefined) return attributes(obj(v['kvlistValue'])['values'], depth + 1);
  throw new Error('input');
}
function attributes(raw: unknown, depth = 0): Obj {
  const entries: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const item of array(raw)) {
    const a = obj(item); const key = a['key'];
    if (typeof key !== 'string' || seen.has(key)) throw new Error('input');
    seen.add(key); entries.push([key, anyValue(a['value'], depth)]);
  }
  return Object.fromEntries(entries);
}
const hash = (parts: string[], length: number): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, length);
function native(span: Obj, attrs: Obj, traceId: string, spanId: string): WeftRecord {
  const trace = attrs['weft.trace_id']; const id = attrs['weft.record_id'];
  if (attrs['weft.schema'] !== 'weft.record@1' || typeof trace !== 'string' || typeof id !== 'string' ||
    hash(['weft.otel.trace@1', trace], 32) !== traceId || hash(['weft.otel.span@1', trace, id], 16) !== spanId) throw new Error('input');
  const parent = attrs['weft.parent_id'] ?? null;
  if (parent === null ? span['parentSpanId'] !== undefined :
    typeof parent !== 'string' || hash(['weft.otel.span@1', trace, parent], 16) !== hex(span['parentSpanId'], 16)) throw new Error('input');
  const fields = obj(attrs['weft.fields']);
  if (attrs['weft.kind'] === 'cycle.weighed') {
    fields['candidates'] = array(fields['candidates']).map(raw => {
      const candidate = obj(raw); return { ...candidate, weight: candidate['weight'] ?? null };
    });
  }
  const links = (span['links'] === undefined ? [] : array(span['links'])).map(raw => {
    const link = obj(raw); const linkAttrs = attributes(link['attributes']);
    if (hex(link['traceId'], 32) !== traceId) throw new Error('input');
    // W6 uses hashed targets; a batch-local identity map resolves these below.
    return { rel: linkAttrs['weft.link.rel'], record_id: hex(link['spanId'], 16) };
  });
  return { schema: 'weft.record@1', trace_id: trace, record_id: id, emitter: attrs['weft.emitter'],
    sequence: attrs['weft.sequence'], kind: attrs['weft.kind'], thread_id: attrs['weft.thread_id'] ?? null,
    parent_id: parent, links, evidence: attrs['weft.evidence'], fields } as unknown as WeftRecord;
}

/** Only validated redacted snapshots leave this function. No input fragments on failure. */
export function mapOtlp(value: unknown, options: IntakeOptions): IntakeResult {
  if (typeof options?.redact !== 'function') return failure('config');
  let records: WeftRecord[];
  try {
    const spans: { span: Obj; traceId: string; spanId: string; attrs: Obj }[] = [];
    for (const resource of array(obj(value)['resourceSpans'])) {
      for (const scope of array(obj(resource)['scopeSpans'])) {
        for (const raw of array(obj(scope)['spans'])) {
          const span = obj(raw);
          const traceId = hex(span['traceId'], 32); const spanId = hex(span['spanId'], 16);
          if (span['parentSpanId'] !== undefined) hex(span['parentSpanId'], 16);
          // Generic attributes are discarded, not decoded into a persistence schema.
          const all = span['attributes'] === undefined ? [] : array(span['attributes']);
          const selected = all.filter(a => typeof obj(a)['key'] === 'string' && (obj(a)['key'] as string).startsWith('weft.'));
          const attrs = selected.length ? attributes(selected) : {};
          spans.push({ span, traceId, spanId, attrs });
        }
      }
    }
    const ids = new Map<string, string>();
    for (const { traceId, spanId, attrs } of spans) {
      if (attrs['weft.schema'] !== undefined) {
        const key = `${traceId}:${spanId}`; const id = attrs['weft.record_id'];
        if (typeof id !== 'string' || (ids.has(key) && ids.get(key) !== id)) throw new Error('input');
        ids.set(key, id);
      }
    }
    records = spans.map(({ span, traceId, spanId, attrs }) => {
      if (Object.keys(attrs).length) {
        const r = native(span, attrs, traceId, spanId);
        return { ...r, links: r.links.map(link => {
          const target = ids.get(`${traceId}:${link.record_id}`);
          if (target === undefined) throw new Error('input');
          return { ...link, record_id: target };
        }) } as WeftRecord;
      }
      const status = span['status'] === undefined ? {} : obj(span['status']);
      if (status['code'] !== undefined && ![0, 1, 2].includes(status['code'] as number)) throw new Error('input');
      return { schema: 'weft.record@1', trace_id: `otlp:${traceId}`, record_id: `otlp:${spanId}`,
        emitter: { kind: 'external', id: `otlp.import:${spanId}` }, sequence: 0, kind: 'action.transition', thread_id: null,
        parent_id: span['parentSpanId'] === undefined ? null : `otlp:${hex(span['parentSpanId'], 16)}`,
        links: [], evidence: [], fields: { action_ref: `otlp:${spanId}`, operation: 'otlp.span',
          state: status['code'] === 2 ? 'failed' : 'succeeded' } } satisfies WeftRecord;
    });
  } catch { return failure('input'); }
  try {
    return { ok: true, records: records.map(record => JSON.parse(serializeRecord(record, options.redact)) as WeftRecord) };
  } catch { return failure('disclosure'); }
}

export async function intakeOtlp(value: unknown, store: Pick<TraceStore, 'importRecords'>,
  options: IntakeOptions, signal?: AbortSignal): Promise<TraceWriteResult> {
  try {
    if (signal?.aborted) return failure('cancelled');
    const result = mapOtlp(value, options);
    if (!result.ok) return result;
    return await store.importRecords(result.records, signal);
  } catch { return failure('storage'); }
}

export interface ListenerOptions extends IntakeOptions {
  readonly createServer: (listener: RequestListener) => Server;
  readonly store: Pick<TraceStore, 'importRecords'>;
  readonly host?: string;
  readonly port?: number;
  readonly maxBytes?: number;
}
export type ListenerResult = { readonly ok: true; readonly url: string;
  readonly close: () => Promise<{ readonly ok: true } | Failure> } | Failure;

/** No default server factory: the composition root owns all listening effects. */
export async function createOtlpListener(options: ListenerOptions): Promise<ListenerResult> {
  let server: Server | undefined;
  try {
    const { createServer, store, redact, host = '127.0.0.1', port = 0, maxBytes = 1024 * 1024 } = options;
    if (!['127.0.0.1', '::1'].includes(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || typeof createServer !== 'function' || typeof redact !== 'function') return failure('config');
    server = createServer((request, response) => {
      response.sendDate = false;
      const reply = (status: number) => { if (!response.destroyed && !response.writableEnded) { response.writeHead(status); response.end(); } };
      if (request.method !== 'POST' || request.url !== '/v1/traces') { request.resume(); reply(404); return; }
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { request.resume(); reply(415); return; }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.once('aborted', cancel);
      response.once('close', cancel);
      request.once('error', () => { cancel(); reply(400); });
      let size = 0; let exceeded = false; const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { exceeded = true; chunks.length = 0; reply(413); }
        else if (!exceeded) chunks.push(chunk);
      });
      request.once('end', () => {
        if (exceeded || controller.signal.aborted) return;
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reply(400); return; }
        chunks.length = 0;
        void intakeOtlp(value, store, { redact }, controller.signal).then(result => {
          reply(result.ok ? 200 : result.reason === 'busy' || result.reason === 'storage' ? 503 : result.reason === 'conflict' ? 409 : 400);
        }, () => reply(503));
      });
    });
    const listening = server;
    const started = await new Promise<boolean>(resolve => {
      const failed = () => resolve(false);
      listening.once('error', failed);
      listening.listen(port, host, () => { listening.removeListener('error', failed); resolve(true); });
    });
    // Keep an error handler for later transport failures; no error escapes to Loom.
    listening.on('error', () => { /* Local intake failure has no runtime authority. */ });
    if (!started) { try { listening.close(); } catch { /* Never expose transport messages. */ } return failure('storage'); }
    const address = listening.address();
    if (!address || typeof address === 'string') { listening.close(); return failure('storage'); }
    return { ok: true, url: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
      close: () => new Promise(resolve => {
        try { listening.close(error => resolve(error ? failure('storage') : { ok: true })); }
        catch { resolve(failure('storage')); }
      }) };
  } catch {
    try { server?.close(); } catch { /* Never expose transport messages. */ }
    return failure('storage');
  }
}
