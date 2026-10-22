/**
 * Weft's sink for an emission port (WEFT-CONTRACT.md, Emission). Every record
 * is redacted and validated by `serializeRecord` before `write` sees it; a
 * record either step rejects is counted and dropped.
 */
import { serializeRecord } from './serialize.js';
import type { InlinePolicy, Redactor, WeftRecord } from './types.js';
import { assertInlinePolicy } from './validate.js';

export interface WeftSinkOptions {
  /** The composition root's redactor. Required, as for `serializeRecord`. */
  readonly redact: Redactor;
  readonly inline?: InlinePolicy;
  /** Receives one JSONL line per accepted record. */
  readonly write: (line: string) => unknown;
}

export interface WeftSink {
  /** Assignable to the `emit` of Loom's, the gateway's and the Fabric host's `WeftPort`. */
  readonly emit: (record: unknown) => void;
  /** Records the redactor or the validator rejected. None of them was written. */
  readonly rejected: number;
}

export function createWeftSink(options: WeftSinkOptions): WeftSink {
  const { redact, inline, write } = options;
  if (typeof redact !== 'function') throw new TypeError('A Weft redactor is required before serialization');
  if (typeof write !== 'function') throw new TypeError('A Weft sink needs a write function');
  if (inline !== undefined) assertInlinePolicy(inline);
  let rejected = 0;
  return {
    emit(record: unknown): void {
      let line: string;
      try {
        line = serializeRecord(record as WeftRecord, redact, inline);
      } catch {
        rejected += 1;
        return;
      }
      write(line);
    },
    get rejected(): number {
      return rejected;
    },
  };
}
