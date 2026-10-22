/** Reference-run snapshots belong to the benchmark composition root, never the gateway. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Clock } from '@weave/gateway';
import { JEV_REFERENCE_MODEL, ProbeConfigurationError, type ReferenceProvenance } from './run.ts';

export interface ReferenceHeader {
  readonly mode: 'reference';
  readonly run_id: string;
  readonly pinned_model_id: typeof JEV_REFERENCE_MODEL;
  readonly run_date: string;
  readonly corpus_hash: string;
  readonly route: { readonly adapter: 'typesafe-ai'; readonly destination: 'typesafe-ai' };
  readonly status: 'running' | 'completed' | 'cancelled' | 'interrupted';
  readonly pin_mismatch: boolean;
  readonly pin_mismatch_count: number;
}

export interface ReferenceOutput<T> {
  readonly header: ReferenceHeader;
  readonly records: readonly T[];
}

/**
 * Publish a unique PID marker before checking for other owners. Overlapping
 * claimants may both refuse, but cannot both start. Only proven-dead owners
 * are removed, by unique name, so recovery cannot unlink a successor's claim.
 * Keep the empty sidecar directory: removing it would race a new claimant.
 */
async function lockOutput(output: string): Promise<() => Promise<void>> {
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  const sidecar = join(parent, `${basename(output)}.lock`);
  await mkdir(sidecar, { recursive: true, mode: 0o700 });
  const owner = `${process.pid}-${randomUUID()}`;
  const marker = join(sidecar, owner);
  const handle = await open(marker, 'wx', 0o600);
  const release = () => rm(marker, { force: true });
  try {
    await handle.close();
    for (const other of await readdir(sidecar)) {
      if (other === owner) continue;
      const match = /^([1-9]\d*)-.+$/.exec(other);
      const pid = Number(match?.[1]);
      let dead = false;
      if (Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647) {
        try { process.kill(pid, 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      if (!dead) throw new ProbeConfigurationError('reference output is in use; another live or unknown owner holds its sidecar');
      await rm(join(sidecar, other), { force: true });
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

/** Same-directory staging, file sync, atomic replacement, then directory sync. */
export async function writeReferenceOutput<T>(output: string, snapshot: ReferenceOutput<T>): Promise<void> {
  const json = JSON.stringify(snapshot, null, 2);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.jev-reference-'));
  try {
    const path = join(staging, 'snapshot.json');
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
    await rename(path, output);
    const directory = await open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Every invocation is a new generation: replace snapshots, never append/reuse prior records. */
export async function runReference<T extends ReferenceProvenance>(config: {
  readonly clock: Clock;
  readonly corpus: unknown;
  readonly output: string;
  readonly runId?: string | undefined;
  readonly jobs: readonly (() => Promise<T>)[];
  readonly signal?: AbortSignal | undefined;
}): Promise<ReferenceOutput<T>> {
  const identity = {
    mode: 'reference' as const,
    run_id: config.runId ?? randomUUID(),
    pinned_model_id: JEV_REFERENCE_MODEL,
    run_date: new Date(config.clock.now()).toISOString(),
    corpus_hash: createHash('sha256').update(JSON.stringify(config.corpus)).digest('hex'),
    route: { adapter: 'typesafe-ai', destination: 'typesafe-ai' },
  } as const;
  const records: T[] = [];
  const snapshot = (status: ReferenceHeader['status']): ReferenceOutput<T> => {
    const count = records.filter(r => r.pin_mismatch !== false).length;
    return { header: { ...identity, status, pin_mismatch: count > 0, pin_mismatch_count: count }, records: [...records] };
  };
  const release = await lockOutput(config.output);
  try {
    await writeReferenceOutput(config.output, snapshot('running'));
    try {
      for (const job of config.jobs) {
        if (config.signal?.aborted) break;
        const record = await job();
        // Discard an in-flight result after cancellation; only whole, completed records commit.
        if (config.signal?.aborted) break;
        records.push(record);
        await writeReferenceOutput(config.output, snapshot('running'));
      }
    } catch (error) {
      await writeReferenceOutput(config.output, snapshot(config.signal?.aborted ? 'cancelled' : 'interrupted'));
      if (!config.signal?.aborted) throw error;
    }
    const result = snapshot(config.signal?.aborted ? 'cancelled' : 'completed');
    await writeReferenceOutput(config.output, result);
    return result;
  } finally { await release(); }
}

/** Recompute mismatch on replay too, so a stale summary cannot mask missing identities. */
export function readProbeOutput<T extends ReferenceProvenance>(value: T[] | ReferenceOutput<T>): {
  records: T[]; exitCode: number;
} {
  if (Array.isArray(value)) return { records: value, exitCode: 0 };
  if (value.header.mode !== 'reference' || value.header.pinned_model_id !== JEV_REFERENCE_MODEL) {
    throw new ProbeConfigurationError('invalid reference run header');
  }
  return {
    records: [...value.records],
    exitCode: value.header.status !== 'completed' || value.header.pin_mismatch ||
      value.records.some(r => r.pin_mismatch !== false || r.resolved_model_id !== JEV_REFERENCE_MODEL) ? 1 : 0,
  };
}
