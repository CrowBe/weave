/**
 * Log bounds (docs/h1-bound-the-log.md). The bound is the canonical encoding
 * of the payload. A mid-value cut is rejected, not repaired.
 */
import { stableStringify } from './stable-json.js';

export function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(stableStringify(payload), 'utf8');
}

export function hasMidValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return hasLoneSurrogate(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasMidValue(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasMidValue(item));
  }
  return false;
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const high = code >= 0xd800 && code <= 0xdbff;
    const low = code >= 0xdc00 && code <= 0xdfff;
    if (low) {
      return true;
    }
    if (high) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    }
  }
  return false;
}

/**
 * One retained record per attempt. Eviction drops the oldest records and
 * records the omission. It does not delete the observation log.
 */
export class TraceRetention {
  readonly records: { attempt_id: string; bytes: number }[] = [];
  omissions = 0;
  evictionUnderLock = false;
  private total = 0;

  constructor(readonly max_bytes: number) {}

  retain(attempt_id: string, body: string, lockHeld: boolean): void {
    if (this.records.some((record) => record.attempt_id === attempt_id)) {
      return;
    }
    const bytes = Buffer.byteLength(body, 'utf8');
    this.records.push({ attempt_id, bytes });
    this.total += bytes;
    while (this.total > this.max_bytes && this.records.length > 1) {
      if (lockHeld) {
        this.evictionUnderLock = true;
      }
      const dropped = this.records.shift();
      if (!dropped) {
        break;
      }
      this.total -= dropped.bytes;
      this.omissions += 1;
    }
  }
}
