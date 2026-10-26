/** Optional OTLP/HTTP JSON projection. No registration, clock, transport or SDK. */
import { createHash } from 'node:crypto';
import { assertInlinePolicy } from './validate.js';
import { serializeRecord } from './serialize.js';
import type { InlinePolicy, Redactor, WeftRecord } from './types.js';

export interface OtlpOptions {
  readonly redact: Redactor;
  /** Composition-root supplied Unix nanoseconds; no ambient clock is consulted. */
  readonly baseTimeUnixNano?: bigint | string | undefined;
  readonly inline?: InlinePolicy;
}
export type OtlpResult =
  | { readonly ok: true; readonly json: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'input'
        | 'config'
        | 'disclosure'
        | 'conflict'
        | 'sequence'
        | 'incomplete'
        | 'parent_cycle'
        | 'write';
    };
type Obj = Record<string, unknown>;
type Attribute = { key: string; value: Obj };
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const hash = (parts: readonly string[], length: number): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, length);
const traceId = (trace: string): string => hash(['weft.otel.trace@1', trace], 32);
const spanId = (trace: string, record: string): string => hash(['weft.otel.span@1', trace, record], 16);

/** Null has no native OTLP attribute representation; omit it rather than invent one. */
function value(v: unknown): Obj {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isSafeInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.filter((item) => item !== null).map(value) } };
  return { kvlistValue: { values: attributes(v as Obj) } };
}
function attributes(v: Obj, prefix = ''): Attribute[] {
  return Object.keys(v)
    .sort(compare)
    .filter((k) => v[k] !== null)
    .map((k) => ({ key: prefix + k, value: value(v[k]) }));
}
function span(r: WeftRecord, base: bigint): Obj {
  const fields = r.fields as unknown as Obj;
  const attrs = attributes(
    {
      schema: r.schema,
      trace_id: r.trace_id,
      record_id: r.record_id,
      emitter: r.emitter,
      sequence: r.sequence,
      kind: r.kind,
      thread_id: r.thread_id,
      parent_id: r.parent_id,
      time_basis: 'sequence',
      evidence: [...r.evidence].sort((a, b) => compare(a.source, b.source) || compare(a.ref, b.ref)),
      fields,
    },
    'weft.',
  );
  if (r.kind === 'inference.attempt') {
    for (const name of ['input_tokens', 'output_tokens'] as const) {
      if (r.fields[name] !== undefined) attrs.push({ key: `gen_ai.usage.${name}`, value: value(r.fields[name]) });
    }
  }
  attrs.sort((a, b) => compare(a.key, b.key));
  const failed =
    r.kind === 'error' ||
    ['failed', 'missed', 'uncertain'].includes(String(fields['status'] ?? fields['state'])) ||
    fields['disposition'] === 'failed' ||
    fields['disposition'] === 'unaccepted';
  const time = (base + BigInt(r.sequence) + 1n).toString();
  return {
    traceId: traceId(r.trace_id),
    spanId: spanId(r.trace_id, r.record_id),
    ...(r.parent_id === null ? {} : { parentSpanId: spanId(r.trace_id, r.parent_id) }),
    name: r.kind,
    kind: r.kind === 'inference.attempt' ? 3 : 1,
    startTimeUnixNano: time,
    endTimeUnixNano: time,
    attributes: attrs,
    links: [...r.links]
      .sort((a, b) => compare(a.rel, b.rel) || compare(a.record_id, b.record_id))
      .map((link) => ({
        traceId: traceId(r.trace_id),
        spanId: spanId(r.trace_id, link.record_id),
        attributes: [{ key: 'weft.link.rel', value: { stringValue: link.rel } }],
      })),
    status: { code: failed ? 2 : 0 },
  };
}

/** All-or-nothing batch. Only the redacted, validated snapshot is ever mapped. */
export function exportOtlp(records: unknown, options: OtlpOptions): OtlpResult {
  let base = 0n;
  const maxTime = (1n << 64n) - 1n;
  try {
    const supplied = options?.baseTimeUnixNano;
    if (supplied !== undefined) {
      if (typeof supplied !== 'bigint' && (typeof supplied !== 'string' || !/^[0-9]+$/.test(supplied)))
        return { ok: false, reason: 'config' };
      base = BigInt(supplied);
      if (base < 0n || base > maxTime) return { ok: false, reason: 'config' };
    }
    if (typeof options?.redact !== 'function') return { ok: false, reason: 'config' };
    if (options.inline !== undefined) assertInlinePolicy(options.inline);
  } catch {
    return { ok: false, reason: 'config' };
  }
  try {
    if (!Array.isArray(records)) return { ok: false, reason: 'input' };
    const traces = new Map<string, Map<string, { record: WeftRecord; line: string }>>();
    for (const raw of records) {
      const line = serializeRecord(raw as WeftRecord, options.redact, options.inline);
      const r = JSON.parse(line) as WeftRecord;
      if (base + BigInt(r.sequence) + 1n > maxTime) return { ok: false, reason: 'config' };
      let group = traces.get(r.trace_id);
      if (group === undefined) {
        group = new Map();
        traces.set(r.trace_id, group);
      }
      const previous = group.get(r.record_id);
      if (previous !== undefined && previous.line !== line) return { ok: false, reason: 'conflict' };
      group.set(r.record_id, { record: r, line });
    }
    const resourceSpans: Obj[] = [];
    for (const [trace, group] of [...traces].sort(([a], [b]) => compare(a, b))) {
      const ordered = [...group.values()]
        .map((v) => v.record)
        .sort(
          (a, b) => compare(a.emitter.id, b.emitter.id) || a.sequence - b.sequence || compare(a.record_id, b.record_id),
        );
      const sequences = new Map<string, Set<number>>();
      for (const r of ordered) {
        const seen = sequences.get(r.emitter.id) ?? new Set<number>();
        if (seen.has(r.sequence)) return { ok: false, reason: 'sequence' };
        seen.add(r.sequence);
        sequences.set(r.emitter.id, seen);
        if ((r.parent_id !== null && !group.has(r.parent_id)) || r.links.some((link) => !group.has(link.record_id))) {
          return { ok: false, reason: 'incomplete' };
        }
      }
      // Iterative parent walk avoids stack overflow on long valid batches.
      const complete = new Set<string>();
      for (const r of ordered) {
        const path = new Set<string>();
        let cursor: string | null = r.record_id;
        while (cursor !== null && !complete.has(cursor)) {
          if (path.has(cursor)) return { ok: false, reason: 'parent_cycle' };
          path.add(cursor);
          cursor = group.get(cursor)!.record.parent_id;
        }
        for (const id of path) complete.add(id);
      }
      resourceSpans.push({
        resource: { attributes: [{ key: 'weft.trace_id', value: { stringValue: trace } }] },
        scopeSpans: [{ scope: { name: '@weave/weft/otel', version: '1' }, spans: ordered.map((r) => span(r, base)) }],
      });
    }
    return { ok: true, json: JSON.stringify({ resourceSpans }) };
  } catch {
    // Never return errors or input fragments: either may contain secrets.
    return { ok: false, reason: 'disclosure' };
  }
}

/**
 * The composition root owns writer liveness and supplies a cancellable timer.
 * The timer must fire within the requested delay, even when the writer hangs.
 */
export interface OtlpExporterOptions extends OtlpOptions {
  readonly write: (json: string) => unknown;
  readonly timer: (ms: number, expire: () => void) => () => void;
  readonly writeTimeoutMs?: number;
}

/** Explicit composition only. Transport failure is observational, never control. */
export function createOtlpExporter(options: OtlpExporterOptions): {
  readonly export: (records: unknown, signal?: AbortSignal) => Promise<OtlpResult>;
} {
  const { redact, inline, baseTimeUnixNano, write, timer, writeTimeoutMs = 1000 } = options;
  return {
    async export(records: unknown, signal?: AbortSignal): Promise<OtlpResult> {
      try {
        if (
          typeof write !== 'function' ||
          typeof timer !== 'function' ||
          !Number.isFinite(writeTimeoutMs) ||
          writeTimeoutMs <= 0 ||
          writeTimeoutMs > 2 ** 31 - 1 ||
          (signal !== undefined &&
            (typeof signal.aborted !== 'boolean' ||
              typeof signal.addEventListener !== 'function' ||
              typeof signal.removeEventListener !== 'function'))
        )
          return { ok: false, reason: 'config' };
        if (signal?.aborted) return { ok: false, reason: 'write' };
      } catch {
        return { ok: false, reason: 'config' };
      }
      const result = exportOtlp(records, { redact, baseTimeUnixNano, ...(inline === undefined ? {} : { inline }) });
      if (!result.ok) return result;
      return new Promise<OtlpResult>((resolve) => {
        let settled = false;
        let cancel: (() => void) | undefined;
        const finish = (outcome: OtlpResult) => {
          if (settled) return;
          settled = true;
          try {
            signal?.removeEventListener('abort', failed);
          } catch {
            /* Signal cleanup cannot escape to the run. */
          }
          try {
            cancel?.();
          } catch {
            /* Cleanup cannot escape to the run. */
          }
          resolve(outcome);
        };
        const failed = () => finish({ ok: false, reason: 'write' });
        try {
          signal?.addEventListener('abort', failed, { once: true });
          cancel = timer(writeTimeoutMs, failed);
          // Injected timers may fire synchronously.
          if (settled) {
            try {
              cancel();
            } catch {
              /* Already settled. */
            }
            return;
          }
          if (signal?.aborted) {
            failed();
            return;
          }
          // Both handlers stay attached after abandonment, including to thenables.
          Promise.resolve(write(result.json)).then(() => finish(result), failed);
        } catch {
          failed();
        }
      });
    },
  };
}
