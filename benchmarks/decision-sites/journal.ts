/** Single-writer durable JSONL. No provider diagnostics or secrets enter this boundary. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export type JournalRecord = Record<string, any>;
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
// Reserve one input token per UTF-8 byte rather than an average chars/token ratio.
// Output is free in every declared benchmark price profile.
export const projectedCost = (serialized: string, price: number): number =>
  (Buffer.byteLength(serialized, 'utf8') * price) / 1e6;
export function replayKey(r: JournalRecord): string {
  return JSON.stringify([r.provider, r.model, r.site, r.item_id, r.set_digest, r.question_digest, r.request_digest]);
}
function writeAll(fd: number, value: string): void {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (n <= 0) throw new Error('Journal write failed');
    offset += n;
  }
}
export class Journal {
  readonly path: string;
  readonly readOnly: boolean;
  constructor(path: string, readOnly = false) {
    this.path = path;
    this.readOnly = readOnly;
    this.read();
  }
  read(): JournalRecord[] {
    return structuredClone(this.rows());
  }
  private rows(): JournalRecord[] {
    // Only a locally held single-writer lock permits caching. A new tenure reloads
    // disk; readers and unlocked journals continue observing durable writes.
    const owner = this.owner(),
      path = resolve(this.path),
      cached = owner?.journals.get(path);
    if (cached !== undefined) return cached;
    const rows = this.load();
    owner?.journals.set(path, rows);
    return rows;
  }
  private owner(): HeldLock | undefined {
    return this.readOnly ? undefined : heldLocks.get(resolve(dirname(this.path), 'lock'));
  }
  private load(): JournalRecord[] {
    if (!existsSync(this.path)) return [];
    const bytes = readFileSync(this.path);
    const lines = bytes.toString('utf8').split('\n');
    const rows: JournalRecord[] = [];
    let validBytes = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line && i === lines.length - 1) break;
      try {
        rows.push(JSON.parse(line) as JournalRecord);
      } catch {
        if (i !== lines.length - 1) throw new Error('Corrupt journal before final line');
        if (!this.readOnly) {
          truncateSync(this.path, validBytes);
          const fd = openSync(this.path, 'r+');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        return rows;
      }
      validBytes += Buffer.byteLength(line) + (i < lines.length - 1 ? 1 : 0);
    }
    if (!this.readOnly && bytes.length && bytes[bytes.length - 1] !== 10) {
      const fd = openSync(this.path, 'a', 0o600);
      try {
        writeSync(fd, '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return rows;
  }
  append(record: JournalRecord): void {
    if (this.readOnly) throw new Error('Cannot append to a read-only journal');
    const rows = this.rows(),
      serialized = JSON.stringify(record);
    try {
      const fd = openSync(this.path, 'a', 0o600);
      try {
        writeAll(fd, serialized + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      // Snapshot exactly what was persisted, including JSON normalization.
      rows.push(JSON.parse(serialized) as JournalRecord);
    } catch (error) {
      this.owner()?.journals.delete(resolve(this.path));
      throw error;
    }
  }
  spent(): number {
    const rows = this.rows();
    const complete = new Set(rows.filter((r) => r.type === 'call').map((r) => r.call_id));
    const seen = new Set<string>();
    let total = 0;
    for (const r of rows) {
      if (r.type === 'call' && !seen.has(r.call_id)) {
        total += r.cost_usd ?? 0;
        seen.add(r.call_id);
      }
      if (r.type === 'intent' && !complete.has(r.call_id)) total += r.projected_usd ?? 0;
    }
    return total;
  }
}
interface HeldLock {
  nonce: string;
  journals: Map<string, JournalRecord[]>;
}
const heldLocks = new Map<string, HeldLock>();
function lockHost(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + readlinkSync('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
}
export function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, 'lock'),
    host = lockHost();
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    let state: 'locked' | 'stale' | 'stale-unknown' = 'stale-unknown';
    try {
      if (heldLocks.has(path)) state = 'locked';
      else {
        const text = readFileSync(path, 'utf8').trim();
        if (/^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text))) {
          // Preserve inspection of legacy PID-only locks. New locks carry a host
          // identity so a PID from another boot/namespace is never probed locally.
          const pid = Number(text);
          state = pid === process.pid ? 'stale' : 'locked';
          if (pid !== process.pid) process.kill(pid, 0);
        } else {
          const owner = JSON.parse(text) as { pid?: unknown; nonce?: unknown; host?: unknown };
          if (
            owner &&
            Number.isSafeInteger(owner.pid) &&
            Number(owner.pid) > 0 &&
            typeof owner.nonce === 'string' &&
            owner.nonce.length > 0 &&
            host !== undefined &&
            owner.host === host
          ) {
            // heldLocks was checked above, so a same-host lock with our PID is a crashed predecessor.
            const pid = Number(owner.pid);
            state = pid === process.pid ? 'stale' : 'locked';
            if (pid !== process.pid) process.kill(pid, 0);
          }
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') state = 'stale';
    }
    throw new Error(
      state === 'locked' ? 'Run directory locked' : `Run directory has ${state} lock; inspect before removing`,
    );
  }
  const nonce = randomUUID();
  try {
    writeAll(fd, JSON.stringify({ pid: process.pid, nonce, host }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Persist directory entry as well as file contents.
  const directory = openSync(dir, 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  heldLocks.set(path, { nonce, journals: new Map() });
  return () => {
    if (heldLocks.get(path)?.nonce !== nonce) return;
    heldLocks.delete(path);
    unlinkSync(path);
  };
}
