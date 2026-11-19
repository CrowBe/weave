/** Host-only inspection. A failed or incomplete scan is never evidence of no writes. */
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface SnapshotLimits {
  readonly max_bytes: number;
  readonly max_entries: number;
}
const DEFAULT_LIMITS: SnapshotLimits = { max_bytes: 64 * 1024 * 1024, max_entries: 10_000 };

/** Bounded, asynchronous hashing; symlink targets, Git objects and Git logs are never traversed. */
export async function workspaceSnapshot(root: string, limits: SnapshotLimits = DEFAULT_LIMITS): Promise<string | null> {
  let bytes = 0;
  let entries = 0;
  const hash = createHash('sha256');
  const field = (value: string | Buffer): void => {
    hash.update(String(Buffer.byteLength(value)));
    hash.update(':');
    hash.update(value);
  };
  // Portable comparison state: directory size and inode bookkeeping can change
  // after remounts or writes to excluded Git objects/logs.
  const metadata = (stat: BigIntStats): string => [stat.mode, ...(stat.isDirectory() ? [] : [stat.size])].join(':');
  // Transient identity/timestamps detect races within this scan, never across scans.
  const inspection = (stat: BigIntStats): string =>
    [metadata(stat), stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':');
  const countBytes = (size: number): void => {
    bytes += size;
    if (bytes > limits.max_bytes) throw new Error('snapshot byte limit');
  };
  const walk = async (path: string, relative: string): Promise<void> => {
    if (++entries > limits.max_entries) throw new Error('snapshot entry limit');
    const stat = await lstat(path, { bigint: true });
    // A gitdir file points outside this traversal, so equality cannot cover Git state.
    if (relative.endsWith('/.git') && stat.isFile()) throw new Error('gitdir indirection');
    const git = relative.endsWith('/.git') && stat.isDirectory();
    field(relative);
    field(metadata(stat));
    if (stat.isDirectory()) {
      field('directory');
      const names: string[] = [];
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (git && (entry.name === 'objects' || entry.name === 'logs')) continue;
        names.push(entry.name);
        if (entries + names.length > limits.max_entries) throw new Error('snapshot entry limit');
      }
      for (const name of names.sort()) await walk(join(path, name), `${relative}/${name}`);
    } else if (stat.isFile()) {
      field('file');
      if (stat.size > BigInt(limits.max_bytes - bytes)) throw new Error('snapshot byte limit');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (inspection(await file.stat({ bigint: true })) !== inspection(stat)) throw new Error('file changed');
        // A per-file digest preserves framing without buffering file content.
        const content = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let size = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          countBytes(bytesRead);
          size += bytesRead;
          content.update(buffer.subarray(0, bytesRead));
        }
        if (BigInt(size) !== stat.size || inspection(await file.stat({ bigint: true })) !== inspection(stat))
          throw new Error('file changed');
        field(content.digest('hex'));
      } finally {
        await file.close();
      }
    } else if (stat.isSymbolicLink()) {
      field('symlink');
      const target = await readlink(path, { encoding: 'buffer' });
      countBytes(target.length);
      field(target);
    } else throw new Error('unsupported workspace entry');
    if (inspection(await lstat(path, { bigint: true })) !== inspection(stat))
      throw new Error('workspace changed during inspection');
  };
  try {
    if (
      !Number.isSafeInteger(limits.max_bytes) ||
      limits.max_bytes < 0 ||
      !Number.isSafeInteger(limits.max_entries) ||
      limits.max_entries < 1 ||
      !(await lstat(root)).isDirectory()
    )
      return null;
    field('workspace-snapshot-v3');
    await walk(root, '');
    return hash.digest('hex');
  } catch {
    return null;
  }
}
