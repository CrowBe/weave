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
      const remaining = window.percentRemaining;
      const pace = object(window.pace);
      if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100 ||
          timestamp(window.resetsAt) === null || (window.pace !== undefined && typeof pace?.status !== 'string')) malformed = true;
      windows.push({ id: window.id, percentRemaining: typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100 ? remaining : null,
        resetsAt: timestamp(window.resetsAt),
        ...(typeof pace?.status === 'string' ? { pace: { status: pace.status } } : {}),
      });
    }
    if (windows.length === 0) malformed = true;
    const state = object(provider.state);
    const refreshedAt = timestamp(state?.refreshedAt);
    const staleReuse = state?.reused === true && (refreshedAt === null || refreshedAt > observed_at || observed_at - refreshedAt >= 60_000);
    providers.push({ provider: provider.provider, status: malformed ? 'unknown' : staleReuse ? 'stale' : typeof provider.status === 'string' ? provider.status : 'unknown', windows });
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
