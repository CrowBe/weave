/** Composition-root I/O only: gateway receives sanitized quota data, never CLI diagnostics. */
import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { QuotaPort, QuotaSnapshot, LoopPausedRecord } from '@weave/gateway';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * quota-axi window ids that budget.policy@1 reads, under the policy's own ids.
 * Claude reports its weekly allowance as `seven_day` and Codex as `weekly`
 * (both `kind: "weekly"`). Every other window, such as model, credit,
 * code-review and used-share windows, keeps its own id and is not read.
 */
const GATED_WINDOWS: Readonly<Record<string, 'seven_day' | 'five_hour'>> = {
  seven_day: 'seven_day', weekly: 'seven_day', five_hour: 'five_hour',
};

/**
 * Normalizes quota-axi `--json` output (schemaVersion 5). A provider's status
 * is quota-axi's `state.status`; a status quota-axi already reports as not
 * fresh is kept as is. A fresh status becomes `unknown` when the row breaks the
 * published schema or a window the policy reads lacks its percentage or reset.
 * Optional fields absent from other windows do not count against the row.
 */
export function normalizeQuotaSnapshot(value: unknown): QuotaSnapshot | undefined {
  const data = object(value);
  const observed_at = timestamp(data?.generatedAt);
  if (observed_at === null || !Array.isArray(data?.providers)) return undefined;
  const providers: QuotaSnapshot['providers'][number][] = [];
  for (const raw of data.providers) {
    const provider = object(raw);
    if (typeof provider?.provider !== 'string' || !provider.provider.trim()) continue;
    // Preserve ambiguous account evidence: a known cap must survive duplicates.
    const windows: QuotaSnapshot['providers'][number]['windows'][number][] = [];
    let malformed = !Array.isArray(provider.windows);
    for (const rawWindow of Array.isArray(provider.windows) ? provider.windows : []) {
      const window = object(rawWindow);
      if (typeof window?.id !== 'string' || !window.id.trim()) { malformed = true; continue; }
      const id = Object.hasOwn(GATED_WINDOWS, window.id) ? GATED_WINDOWS[window.id]! : window.id;
      const gated = id === 'seven_day' || id === 'five_hour';
      const remaining = window.percentRemaining;
      const percentRemaining = typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
        ? remaining : null;
      const resetsAt = timestamp(window.resetsAt);
      const pace = object(window.pace);
      if (percentRemaining === null && (gated || remaining !== undefined)) malformed = true;
      if (resetsAt === null && (gated || window.resetsAt !== undefined)) malformed = true;
      if (window.pace !== undefined && typeof pace?.status !== 'string') malformed = true;
      windows.push({ id, percentRemaining, resetsAt,
        ...(typeof pace?.status === 'string' ? { pace: { status: pace.status } } : {}),
      });
    }
    if (windows.length === 0) malformed = true;
    const state = object(provider.state);
    const reported = typeof state?.status !== 'string' ? 'unknown'
      : state.status === 'fresh' && state.stale !== false ? 'stale' : state.status;
    // A reused reading was taken at refreshedAt, so its age counts from there.
    const reused = state?.reused === true;
    const refreshedAt = timestamp(state?.refreshedAt);
    const takenAt = reused && refreshedAt !== null && refreshedAt <= observed_at ? refreshedAt : null;
    const status = reported !== 'fresh' ? reported : reused && takenAt === null ? 'stale' : malformed ? 'unknown' : 'fresh';
    providers.push({ provider: provider.provider, status, ...(takenAt === null ? {} : { observed_at: takenAt }), windows });
  }
  return { observed_at, providers };
}

function runQuota(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fixed argv contains no credentials. stderr and error text never leave this root.
    execFile('quota-axi', ['--json'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('Quota snapshot unavailable'));
      else resolve(stdout);
    });
  });
}

export function createQuotaPort(options: { now?: () => number; run?: () => Promise<string> } = {}): QuotaPort {
  const now = options.now ?? Date.now;
  const run = options.run ?? runQuota;
  let loadedAt: number | undefined;
  let cached: QuotaSnapshot | undefined;
  let pending: Promise<QuotaSnapshot | undefined> | undefined;
  return { read() {
    const current = now();
    if (pending) return pending;
    if (loadedAt !== undefined && current >= loadedAt && current - loadedAt < 60_000) return Promise.resolve(cached);
    loadedAt = current;
    pending = (async () => {
      try { cached = normalizeQuotaSnapshot(JSON.parse(await Promise.resolve().then(run))); }
      catch { cached = undefined; }
      finally { pending = undefined; }
      return cached;
    })();
    return pending;
  } };
}

export function localBudgetGate(options: { pausePath?: string } = {}): {
  quota: QuotaPort;
  persist_pause: (record: LoopPausedRecord) => Promise<void>;
} {
  const pausePath = options.pausePath ?? join(homedir(), '.local', 'state', 'weave', 'loop-paused.jsonl');
  return { quota: createQuotaPort(), persist_pause: async (record) => {
    await mkdir(dirname(pausePath), { recursive: true, mode: 0o700 });
    await appendFile(pausePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } };
}
