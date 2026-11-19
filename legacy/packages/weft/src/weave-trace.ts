/**
 * `weave.trace@1`, the P9 trace envelope. Weft keeps it as a supported version
 * beside `weft.record@1` rather than converting it (WEFT-CONTRACT.md).
 */
import { hasCredential } from './credential.js';

export type TraceKind = 'decision' | 'implement' | 'audit' | 'shell' | 'budget' | 'error';
export interface TraceRecord {
  readonly schema: 'weave.trace@1';
  readonly id: string;
  readonly parentId: string | null;
  readonly run_id: string;
  readonly kind: TraceKind;
  readonly sequence: number;
  readonly payload: Readonly<
    Partial<
      Record<
        'spent_micros' | 'latency_ms' | 'input_tokens' | 'output_tokens' | 'confidence' | 'passed',
        number | boolean
      >
    >
  >;
}
export type TraceWriteResult =
  | { readonly ok: true; readonly inserted: number; readonly torn: boolean }
  | {
      readonly ok: false;
      readonly reason: 'input' | 'config' | 'disclosure' | 'conflict' | 'cancelled' | 'busy' | 'storage' | 'schema';
    };
export interface TraceImportPort {
  /** Identical canonical content is a no-op; different content must conflict. */
  upsert(record: TraceRecord): Promise<void | TraceWriteResult>;
  /** Transactional adapters validate and commit the entire batch atomically. */
  upsertBatch?(records: readonly TraceRecord[], signal?: AbortSignal): Promise<TraceWriteResult>;
}
const keys = ['schema', 'id', 'parentId', 'run_id', 'kind', 'sequence', 'payload'];
const metrics = ['spent_micros', 'latency_ms', 'input_tokens', 'output_tokens', 'confidence', 'passed'];
const kinds: readonly string[] = ['decision', 'implement', 'audit', 'shell', 'budget', 'error'];
const safeId = (x: unknown): x is string =>
  typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(x) && !hasCredential(x);
export function validateTrace(value: unknown): value is TraceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || !keys.every((k) => Object.hasOwn(r, k))) return false;
  if (
    r.schema !== 'weave.trace@1' ||
    !safeId(r.id) ||
    !safeId(r.run_id) ||
    !(r.parentId === null || safeId(r.parentId))
  )
    return false;
  if (!kinds.includes(r.kind as string) || !Number.isSafeInteger(r.sequence) || (r.sequence as number) < 0)
    return false;
  if (!r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload)) return false;
  return Object.entries(r.payload).every(
    ([k, v]) =>
      metrics.includes(k) &&
      (k === 'passed'
        ? typeof v === 'boolean'
        : typeof v === 'number' && Number.isFinite(v) && v >= 0 && (k !== 'confidence' || v <= 1)),
  );
}
/** Caller must remove secrets at the composition boundary, even for opaque ids. */
export function serializeTrace(record: TraceRecord, redact: (record: TraceRecord) => unknown): string {
  // Validate and serialize the same snapshot, including nested metric getters.
  const clean: unknown = structuredClone(redact(record));
  if (!validateTrace(clean)) throw new Error('Invalid trace record');
  const payload: Record<string, number | boolean> = {};
  for (const key of metrics) {
    const value = clean.payload[key as keyof TraceRecord['payload']];
    if (value !== undefined) payload[key] = value;
  }
  return (
    JSON.stringify({
      schema: clean.schema,
      id: clean.id,
      parentId: clean.parentId,
      run_id: clean.run_id,
      kind: clean.kind,
      sequence: clean.sequence,
      payload,
    }) + '\n'
  );
}
export async function importTraceLines(jsonl: string, port: TraceImportPort): Promise<void> {
  // Validate the whole batch before any database mutation.
  const rows: TraceRecord[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('Invalid trace record');
    }
    if (!validateTrace(value)) throw new Error('Invalid trace record');
    rows.push(value);
  }
  if (port.upsertBatch) {
    const result = await port.upsertBatch(rows);
    if (!result.ok) throw new Error(`Trace import rejected: ${result.reason}`);
  } else {
    for (const row of rows) {
      const result = await port.upsert(row);
      if (result && !result.ok) throw new Error(`Trace import rejected: ${result.reason}`);
    }
  }
}
