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
    this.rows();
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
    if (cached !== undefined) return cached.rows;
    const rows = this.load();
    owner?.journals.set(path, new JournalIndex(rows));
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
      const persisted = JSON.parse(serialized) as JournalRecord;
      const index = this.owner()?.journals.get(resolve(this.path));
      if (index) index.add(persisted);
      else rows.push(persisted);
    } catch (error) {
      this.owner()?.journals.delete(resolve(this.path));
      throw error;
    }
  }
  spent(): number {
    return this.index().spent;
  }
  private index(): JournalIndex {
    const rows = this.rows();
    return this.owner()?.journals.get(resolve(this.path)) ?? new JournalIndex(rows);
  }
  length(): number {
    return this.rows().length;
  }
  recordsFor(key: string): JournalRecord[] {
    return structuredClone(this.index().bindings.get(key) ?? []);
  }
  hasCall(id: unknown): boolean {
    return this.index().calls.has(id);
  }
  competitorCalls(provider: string): number {
    return this.index().competitor.get(provider) ?? 0;
  }
  budgetState(): { stopped: boolean; excess?: JournalRecord; projected?: number | undefined } {
    const index = this.index();
    const excess = index.excess();
    return {
      stopped: index.stopped,
      ...(excess ? { excess: structuredClone(excess), projected: index.reservations.get(excess.call_id) } : {}),
    };
  }
}
/**
 * The conservative ledger, split by evidence for reporting only. Every completed
 * attempt is charged once; an unacknowledged intent keeps its reservation.
 * Observed spend is priced from a provider usage receipt. Reserved spend has no
 * receipt: a completed call without usage keeps its byte projection (the engine
 * charges a usage-less 429 that way on every retry) and pending intents keep
 * theirs. The budget always uses the conservative total, `spent_usd`.
 */
export function ledger(rows: readonly JournalRecord[]): {
  spent_usd: number;
  observed_usd: number;
  reserved_usd: number;
  pending_reservation_usd: number;
} {
  const complete = new Set(rows.filter((r) => r.type === 'call').map((r) => r.call_id));
  const seen = new Set<string>();
  let total = 0,
    observed = 0,
    pending = 0;
  for (const r of rows) {
    if (r.type === 'call' && !seen.has(r.call_id)) {
      const cost = r.cost_usd ?? 0;
      total += cost;
      if (r.result?.input_tokens !== undefined) observed += cost;
      seen.add(r.call_id);
    }
    if (r.type === 'intent' && !complete.has(r.call_id)) {
      const cost = r.projected_usd ?? 0;
      total += cost;
      pending += cost;
    }
  }
  return { spent_usd: total, observed_usd: observed, reserved_usd: total - observed, pending_reservation_usd: pending };
}
/** Derived solely from persisted rows; shared only while the local writer lock is held. */
class JournalIndex {
  readonly rows: JournalRecord[] = [];
  readonly bindings = new Map<string, JournalRecord[]>();
  readonly calls = new Set<unknown>();
  readonly reservations = new Map<unknown, number>();
  readonly competitor = new Map<string, number>();
  readonly byId = new Map<unknown, { intents: JournalRecord[]; calls: JournalRecord[] }>();
  stopped = false;
  spent = 0;
  private excessive: JournalRecord | undefined;
  private beforeLast = 0;
  constructor(rows: JournalRecord[]) {
    for (const row of rows) this.add(row);
  }
  private dispatch(group: { intents: JournalRecord[]; calls: JournalRecord[] }): Map<string, number> {
    const result = new Map<string, number>();
    const uncalled = group.calls.some(
      (r) =>
        r.result &&
        ((r.result.status !== 'ok' && (r.result.reason === 'cancelled' || r.result.reason === 'not_sent')) ||
          (r.result.status === 'skipped' && r.result.reason === 'quota_unavailable_or_weekly_cap')),
    );
    const dispatched = group.calls
      .filter((r) => Number.isSafeInteger(r.result?.dispatches) && r.result.dispatches >= 0)
      .at(-1)?.result.dispatches;
    if (!uncalled)
      for (const r of group.intents)
        result.set(r.provider, (result.get(r.provider) ?? 0) + (dispatched ?? r.dispatch_reservation ?? 1));
    return result;
  }
  add(row: JournalRecord): void {
    const previousRow = this.rows.at(-1),
      oldSpent = this.spent;
    this.rows.push(row);
    const key = replayKey(row),
      group = this.bindings.get(key) ?? [];
    group.push(row);
    this.bindings.set(key, group);
    if (row.type === 'budget_stop' && row.reason === 'actual_cost_exceeds_projection') this.stopped = true;
    if (row.type !== 'intent' && row.type !== 'call') {
      this.beforeLast = oldSpent;
      return;
    }
    const id = row.call_id,
      prior = this.byId.get(id) ?? { intents: [], calls: [] };
    const before = this.dispatch(prior),
      hadCalls = prior.calls.length > 0,
      hadIntents = prior.intents.length;
    if (row.type === 'intent') {
      prior.intents.push(row);
      this.reservations.set(id, row.projected_usd);
    } else {
      prior.calls.push(row);
      this.calls.add(id);
    }
    this.byId.set(id, prior);
    if (row.type === 'call' && !this.excessive && row.cost_usd > this.reservations.get(id)!) this.excessive = row;
    if (row.type === 'intent' && prior.calls.length)
      this.excessive = this.rows.find((r) => r.type === 'call' && r.cost_usd > this.reservations.get(r.call_id)!);
    if (row.type === 'intent' && !hadCalls) this.spent += row.projected_usd ?? 0;
    else if (row.type === 'call' && !hadCalls) {
      if (!hadIntents) this.spent += row.cost_usd ?? 0;
      else if (hadIntents === 1 && previousRow === prior.intents[0]) this.spent = this.beforeLast + (row.cost_usd ?? 0);
      else this.spent = ledger(this.rows).spent_usd;
    }
    this.beforeLast = oldSpent;
    const after = this.dispatch(prior);
    for (const provider of new Set([...before.keys(), ...after.keys()]))
      this.competitor.set(
        provider,
        (this.competitor.get(provider) ?? 0) + (after.get(provider) ?? 0) - (before.get(provider) ?? 0),
      );
  }
  excess(): JournalRecord | undefined {
    return this.excessive;
  }
}
interface HeldLock {
  nonce: string;
  journals: Map<string, JournalIndex>;
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
