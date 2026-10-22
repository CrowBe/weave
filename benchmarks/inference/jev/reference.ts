/** Reference-run snapshots belong to the benchmark composition root, never the gateway. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Clock } from '@weave/gateway';
import { JEV_REFERENCE_MODEL, type ReferenceProvenance } from './run.ts';

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
  readonly jobs: readonly (() => Promise<T>)[];
  readonly signal?: AbortSignal | undefined;
}): Promise<ReferenceOutput<T>> {
  const identity = {
    mode: 'reference' as const,
    run_id: randomUUID(),
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
}

/** Recompute mismatch on replay too, so a stale summary cannot mask missing identities. */
export function readProbeOutput<T extends ReferenceProvenance>(value: T[] | ReferenceOutput<T>): {
  records: T[]; exitCode: number;
} {
  if (Array.isArray(value)) return { records: value, exitCode: 0 };
  if (value.header.mode !== 'reference' || value.header.pinned_model_id !== JEV_REFERENCE_MODEL) {
    throw new Error('invalid reference run header');
  }
  return {
    records: [...value.records],
    exitCode: value.header.status !== 'completed' || value.header.pin_mismatch ||
      value.records.some(r => r.pin_mismatch !== false || r.resolved_model_id !== JEV_REFERENCE_MODEL) ? 1 : 0,
  };
}
