import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FabricStore, type FabricSnapshot, type InvocationRecord } from '@weave/agentfabric';

function invocation(id: string): InvocationRecord {
  return {
    invocation_id: id,
    action_id: `action-${id}`,
    operation: 'source.inspect',
    binding_digest: 'binding',
    inputs: { slot: 7 },
    status: 'running',
    outcome: null,
    cancel_requested: false,
  };
}

describe('FabricStore append-only journal', () => {
  it('refuses append and compaction after close without changing bytes or state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-closed-writes-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    store.allocateCanonical();
    store.close();
    const before = readFileSync(path);
    const snapshot = store.snapshot();
    try {
      assert.throws(() => store.allocateCanonical(), /closed/);
      assert.throws(() => (store as unknown as { compact(): void }).compact(), /closed/);
      assert.throws(() => store.save(), /closed/);
      assert.deepEqual(readFileSync(path), before);
      assert.deepEqual(store.snapshot(), snapshot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a former owner and a live store whose lock was replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-lost-lock-'));
    const path = join(dir, 'fabric.json');
    const first = FabricStore.open(path);
    first.allocateCanonical();
    first.close();
    const second = FabricStore.open(path);
    try {
      second.retainConclusion('successor evidence');
      const before = readFileSync(path);
      assert.throws(() => first.allocateCanonical(), /closed/);
      assert.throws(() => (first as unknown as { compact(): void }).compact(), /closed/);
      writeFileSync(`${path}.lock`, `${process.pid}:replacement`);
      assert.throws(() => second.allocateCanonical(), /lock.*own|own.*lock/);
      assert.throws(() => (second as unknown as { compact(): void }).compact(), /lock.*own|own.*lock/);
      assert.deepEqual(readFileSync(path), before);
      second.close();
      assert.equal(readFileSync(`${path}.lock`, 'utf8'), `${process.pid}:replacement`);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const factory of ['constructor', 'restore'] as const) {
    it(`takes the lock for path-backed ${factory} and preserves existing history`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-construction-'));
      const path = join(dir, 'nested', 'fabric.json');
      const seed = new FabricStore();
      seed.retainConclusion('seed evidence');
      const snapshot = seed.snapshot();
      const store = factory === 'constructor' ? new FabricStore(snapshot, path) : FabricStore.restore(snapshot, path);
      try {
        assert.throws(() => FabricStore.open(path), /already open/);
        assert.throws(() => new FabricStore(undefined, path), /already open/);
        assert.throws(() => FabricStore.restore(snapshot, path), /already open/);
        store.close();
        const before = readFileSync(path);
        assert.throws(() => FabricStore.restore(new FabricStore().snapshot(), path), /existing|history/);
        assert.deepEqual(readFileSync(path), before);
        const reopened = new FabricStore(undefined, path);
        try {
          assert.deepEqual(reopened.conclusions(), ['seed evidence']);
        } finally {
          reopened.close();
        }
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  const validSnapshot = new FabricStore().snapshot();
  const malformedSnapshots: unknown[] = [
    undefined, null, {},
    ...['next_handle', 'next_canonical', 'resources', 'refs', 'invocations'].map((field) => {
      const copy = { ...validSnapshot } as Record<string, unknown>;
      delete copy[field];
      return copy;
    }),
    ...Object.keys(validSnapshot).map((field) => ({ ...validSnapshot, [field]: 'wrong type' })),
    ...['resources', 'refs', 'invocations', 'admissions', 'workload', 'builtin_results'].map(
      (field) => ({ ...validSnapshot, [field]: [{}] }),
    ),
    { ...validSnapshot, next_handle: 0 },
    { ...validSnapshot, next_canonical: 1.5 },
  ];
  for (const [index, snapshot] of malformedSnapshots.entries()) {
    it(`rejects malformed snapshot ${index} at its physical line without repairing the file`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-invalid-snapshot-'));
      const path = join(dir, 'fabric.json');
      const bytes = `{"op":"allocate","id":"res_1"}\n\n${JSON.stringify({ op: 'snapshot', snapshot })}\n`;
      try {
        for (const tail of ['', '{"op":']) {
          writeFileSync(path, bytes + tail);
          let opened: FabricStore | undefined;
          try {
            assert.throws(() => { opened = FabricStore.open(path); }, /snapshot.*line 3/);
          } finally {
            opened?.close();
          }
          assert.equal(readFileSync(path, 'utf8'), bytes + tail);
          assert.equal(existsSync(`${path}.lock`), false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('rejects a malformed complete final line rather than treating it as a torn tail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-complete-invalid-'));
    const path = join(dir, 'fabric.json');
    const bytes = '{"op":"allocate","id":"res_1"}\n{"op":"snapshot",\n';
    let store: FabricStore | undefined;
    try {
      writeFileSync(path, bytes);
      assert.throws(() => { store = FabricStore.open(path); }, /line 2/);
      assert.equal(readFileSync(path, 'utf8'), bytes);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed snapshot without a final newline before adding one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-invalid-no-newline-'));
    const path = join(dir, 'fabric.json');
    const bytes = '{"op":"snapshot","snapshot":null}';
    try {
      writeFileSync(path, bytes);
      assert.throws(() => FabricStore.open(path), /snapshot.*line 1/);
      assert.equal(readFileSync(path, 'utf8'), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows exactly one process to win a concurrent open', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-open-race-'));
    const path = join(dir, 'fabric.json');
    const source = `
      import { FabricStore } from '@weave/agentfabric';
      let store;
      process.send('ready');
      process.on('message', (message) => {
        if (message === 'open') {
          try {
            store = FabricStore.open(process.argv[1]);
            process.send('won');
          } catch (error) {
            process.send(/already open/.test(String(error)) ? 'lost' : 'error');
          }
        }
        if (message === 'close') { store?.close(); process.exit(0); }
      });
    `;
    const children = Array.from({ length: 2 }, () => spawn(process.execPath,
      ['--input-type=module', '-e', source, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    const message = (child: (typeof children)[number]) => new Promise<unknown>((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('race contender exited early')));
    });
    try {
      assert.deepEqual(await Promise.all(children.map(message)), ['ready', 'ready']);
      const results = children.map(message);
      children.forEach((child) => child.send('open'));
      assert.deepEqual((await Promise.all(results)).sort(), ['lost', 'won']);
      const exits = children.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
      children.forEach((child) => child.send('close'));
      await Promise.all(exits);
      const reopened = FabricStore.open(path);
      reopened.close();
    } finally {
      children.forEach((child) => child.kill());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps journal bytes per invocation flat as history grows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-bytes-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    try {
      const sizes: number[] = [];
      for (let index = 0; index < 80; index += 1) {
        const id = `inv-${String(index).padStart(4, '0')}`;
        const before = store.bytesWritten();
        store.persistInvocationStart(invocation(id), 1_000);
        store.persistInvocationResult({
          ...invocation(id),
          status: 'committed',
          outcome: { outcome: 'succeeded', output: { ok: true } },
        });
        sizes.push(store.bytesWritten() - before);
      }
      assert.equal(sizes[0], sizes[79]);
      assert.ok(sizes[79]! < 4_096);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps per-invocation bytes bounded across repeated compactions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-compact-bytes-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    const original = store.snapshot.bind(store);
    let compactions = 0;
    store.snapshot = () => {
      compactions += 1;
      return original();
    };
    try {
      const total = 1_024;
      const blob = 'x'.repeat(4_096);
      const sizes: number[] = [];
      for (let index = 0; index < total; index += 1) {
        const id = `inv-${String(index).padStart(4, '0')}`;
        const before = store.bytesWritten();
        store.persistInvocationStart(invocation(id), 1_000);
        store.persistInvocationResult({
          ...invocation(id),
          status: 'committed',
          outcome: { outcome: 'succeeded', output: { ok: true, blob } },
        });
        sizes.push(store.bytesWritten() - before);
      }
      assert.ok(compactions >= 3, `expected repeated compactions, saw ${compactions}`);
      const firstHalf = sizes.slice(0, total / 2).reduce((sum, value) => sum + value, 0);
      const secondHalf = sizes.slice(total / 2).reduce((sum, value) => sum + value, 0);
      assert.ok(secondHalf <= firstHalf * 2, `write volume grew with history: ${firstHalf} -> ${secondHalf}`);
      assert.ok(store.bytesWritten() < total * 16_384, `bytes grew with history: ${store.bytesWritten()}`);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a valid final record when appending its newline fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-final-newline-'));
    const path = join(dir, 'fabric.json');
    const first = `${JSON.stringify({ op: 'allocate', id: 'res_1' })}\n`;
    const second = JSON.stringify({ op: 'allocate', id: 'res_2' });
    writeFileSync(path, `${first}${second}`);
    const mutableFs = createRequire(import.meta.url)('node:fs') as {
      appendFileSync: typeof nodeFs.appendFileSync;
    };
    const original = mutableFs.appendFileSync;
    let failOnce = true;
    mutableFs.appendFileSync = ((file: nodeFs.PathLike, data: string, options?: nodeFs.WriteFileOptions) => {
      if (failOnce && String(file) === path) {
        failOnce = false;
        const error = new Error('simulated newline write failure') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return original(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => FabricStore.open(path), /simulated newline write failure/);
    } finally {
      mutableFs.appendFileSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(readFileSync(path, 'utf8'), `${first}${second}`);

    const reopened = FabricStore.open(path);
    try {
      assert.equal(reopened.recovery.torn_tail_ignored, false);
      assert.equal(reopened.allocateCanonical(), 'res_3');
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not remove a live lock claimed during stale-lock reclamation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-reclaim-race-'));
    const path = join(dir, 'fabric.json');
    const lockPath = `${path}.lock`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    assert.ok(dead.pid);
    writeFileSync(lockPath, String(dead.pid));
    const live = `${process.pid}:live-a`;
    const successor = `${process.pid}:live-c`;
    const mutableFs = createRequire(import.meta.url)('node:fs') as {
      readFileSync: typeof nodeFs.readFileSync;
      linkSync: typeof nodeFs.linkSync;
    };
    const originalRead = mutableFs.readFileSync;
    const originalLink = mutableFs.linkSync;
    let injected = false;
    mutableFs.readFileSync = ((file: nodeFs.PathLike, options?: unknown) => {
      if (!injected && String(file) === lockPath) {
        injected = true;
        writeFileSync(lockPath, live);
        return String(dead.pid);
      }
      return originalRead(file, options as never);
    }) as typeof nodeFs.readFileSync;
    mutableFs.linkSync = ((existing: nodeFs.PathLike, next: nodeFs.PathLike) => {
      if (String(next) === lockPath && String(existing).includes('.stale.')) {
        writeFileSync(lockPath, successor);
      }
      return originalLink(existing, next);
    }) as typeof nodeFs.linkSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => FabricStore.open(path), /already open/);
    } finally {
      mutableFs.readFileSync = originalRead;
      mutableFs.linkSync = originalLink;
      syncBuiltinESMExports();
    }
    try {
      assert.equal(readFileSync(lockPath, 'utf8'), live, 'stale reclamation removed the live owner lock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close is idempotent and cannot release a successor lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-close-'));
    const path = join(dir, 'fabric.json');
    const first = FabricStore.open(path);
    first.close();
    const second = FabricStore.open(path);
    try {
      first.close();
      assert.throws(() => FabricStore.open(path), /already open/);
      assert.equal(existsSync(`${path}.lock`), true);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores the journal length after a partial append failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-append-failure-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    const canonical = store.allocateCanonical();
    const mutableFs = createRequire(import.meta.url)('node:fs') as {
      writeSync: typeof nodeFs.writeSync;
    };
    const original = mutableFs.writeSync;
    let failOnce = true;
    let partial = true;
    mutableFs.writeSync = ((fd: number, data: Buffer, offset: number, length: number) => {
      if (partial) {
        partial = false;
        return original(fd, data, offset, 5);
      }
      if (failOnce) {
        failOnce = false;
        const error = new Error('simulated short write') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return original(fd, data, offset, length);
    }) as typeof nodeFs.writeSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => store.issue(canonical, 'source'), /simulated short write/);
    } finally {
      mutableFs.writeSync = original;
      syncBuiltinESMExports();
    }
    try {
      store.issue(canonical, 'source');
      store.close();

      const reopened = FabricStore.open(path);
      try {
        assert.equal(reopened.snapshot().refs.length, 1);
        assert.equal(reopened.lookupRef('ref_1')?.canonical_id, canonical);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never rolls back successor bytes when ownership changes during a failed append', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-rollback-owner-'));
    const path = join(dir, 'fabric.json');
    const first = FabricStore.open(path);
    first.allocateCanonical();
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const originalAppend = mutableFs.appendFileSync;
    const originalWrite = mutableFs.writeSync;
    let second: FabricStore | undefined;
    let successorBytes: Buffer | undefined;
    let injected = false;
    const takeOver = () => {
      if (injected) return;
      injected = true;
      first.close();
      second = FabricStore.open(path);
      second.retainConclusion('successor evidence');
      successorBytes = readFileSync(path);
      throw new Error('simulated failed append after takeover');
    };
    mutableFs.appendFileSync = ((...args: Parameters<typeof originalAppend>) => {
      if (String(args[0]) === path) takeOver();
      return originalAppend(...args);
    }) as typeof originalAppend;
    mutableFs.writeSync = ((...args: Parameters<typeof originalWrite>) => {
      takeOver();
      return originalWrite(...args);
    }) as typeof originalWrite;
    syncBuiltinESMExports();
    try {
      assert.throws(() => first.allocateCanonical(), /simulated failed append|closed/);
      assert.ok(injected);
      assert.deepEqual(readFileSync(path), successorBytes);
      assert.deepEqual(second?.conclusions(), ['successor evidence']);
    } finally {
      mutableFs.appendFileSync = originalAppend;
      mutableFs.writeSync = originalWrite;
      syncBuiltinESMExports();
      first.close();
      second?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not truncate unexpected bytes after a failed append', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-rollback-range-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    store.allocateCanonical();
    const before = readFileSync(path, 'utf8');
    const foreign = '{"op":"conclusion","conclusion":"external evidence"}\n';
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const originalAppend = mutableFs.appendFileSync;
    const originalWrite = mutableFs.writeSync;
    const fail = () => {
      originalAppend(path, foreign);
      throw new Error('simulated failed append with unexpected bytes');
    };
    mutableFs.appendFileSync = fail as typeof originalAppend;
    mutableFs.writeSync = fail as typeof originalWrite;
    syncBuiltinESMExports();
    try {
      assert.throws(() => store.allocateCanonical(), /simulated failed append/);
      assert.equal(readFileSync(path, 'utf8'), before + foreign);
      assert.throws(() => store.allocateCanonical(), /reopened/);
    } finally {
      mutableFs.appendFileSync = originalAppend;
      mutableFs.writeSync = originalWrite;
      syncBuiltinESMExports();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not snapshot the whole store on ordinary mutations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-snapshot-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    try {
      const original = store.snapshot.bind(store);
      let snapshots = 0;
      store.snapshot = () => {
        snapshots += 1;
        return original();
      };
      for (let index = 0; index < 20; index += 1) {
        const id = `inv-${String(index).padStart(4, '0')}`;
        store.persistInvocationStart(invocation(id), 1_000);
        store.persistInvocationResult({
          ...invocation(id),
          status: 'committed',
          outcome: { outcome: 'succeeded', output: { ok: true } },
        });
      }
      assert.equal(snapshots, 0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores and reports a torn final line without losing earlier state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-torn-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    const canonical = store.allocateCanonical();
    store.putResource({
      canonical_id: canonical,
      kind: 'source',
      locator: 'mem:torn',
      revision: 1,
      content: 'alpha',
      publication: null,
    });
    const handle = store.issue(canonical, 'source');
    store.close();

    appendFileSync(path, '{"op":"put","resource":');
    const reopened = FabricStore.open(path);
    try {
      assert.equal(reopened.recovery.torn_tail_ignored, true);
      assert.ok(reopened.recovery.ignored_tail_bytes > 0);
      assert.equal(reopened.snapshot().resources.length, 1);
      assert.equal(reopened.lookupRef(handle)?.canonical_id, canonical);

      const next = reopened.allocateCanonical();
      reopened.putResource({
        canonical_id: next,
        kind: 'destination',
        locator: 'mem:torn-outbox',
        revision: 1,
        content: '',
        publication: null,
      });
      reopened.issue(next, 'destination');
    } finally {
      reopened.close();
    }

    const again = FabricStore.open(path);
    try {
      assert.equal(again.recovery.torn_tail_ignored, false);
      assert.equal(again.snapshot().resources.length, 2);
      for (const line of readFileSync(path, 'utf8').split('\n').filter((item) => item.length > 0)) {
        JSON.parse(line);
      }
    } finally {
      again.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens an empty or whitespace-only file as an empty store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-empty-'));
    try {
      const emptyPath = join(dir, 'empty.json');
      writeFileSync(emptyPath, '');
      const empty = FabricStore.open(emptyPath);
      try {
        assert.equal(empty.snapshot().resources.length, 0);
        assert.equal(empty.recovery.torn_tail_ignored, false);
      } finally {
        empty.close();
      }

      const whitespacePath = join(dir, 'whitespace.json');
      writeFileSync(whitespacePath, '  \n');
      const whitespace = FabricStore.open(whitespacePath);
      try {
        assert.equal(whitespace.snapshot().resources.length, 0);
        assert.equal(whitespace.recovery.torn_tail_ignored, true);
      } finally {
        whitespace.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compacts by size into a snapshot record and ignores a stale compaction temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-compact-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    const canonical = store.allocateCanonical();
    store.putResource({
      canonical_id: canonical,
      kind: 'source',
      locator: 'mem:large',
      revision: 1,
      content: 'x'.repeat(300 * 1024),
      publication: null,
    });
    const handle = store.issue(canonical, 'source');
    store.save();
    store.close();

    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
    const head = JSON.parse(lines[0] ?? '{}') as { op?: string; snapshot?: FabricSnapshot };
    assert.equal(head.op, 'snapshot');
    assert.equal(head.snapshot?.resources[0]?.canonical_id, canonical);
    assert.equal(existsSync(`${path}.tmp`), false);

    writeFileSync(
      `${path}.tmp`,
      `${JSON.stringify({
        op: 'snapshot',
        snapshot: { next_handle: 99, next_canonical: 99, resources: [], refs: [], invocations: [] },
      })}\n`,
    );
    const reopened = FabricStore.open(path);
    try {
      assert.equal(reopened.snapshot().resources.length, 1);
      assert.equal(reopened.lookupRef(handle)?.canonical_id, canonical);
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a legacy snapshot and replays the fold deterministically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-migrate-'));
    const path = join(dir, 'fabric.json');
    const legacy: FabricSnapshot = {
      next_handle: 4,
      next_canonical: 3,
      resources: [
        {
          canonical_id: 'res_1',
          kind: 'source',
          locator: 'mem:legacy',
          revision: 1,
          content: 'legacy',
          publication: null,
        },
      ],
      refs: [{ handle: 'ref_1', canonical_id: 'res_1', kind: 'source' }],
      invocations: [{ ...invocation('inv-legacy'), status: 'committed', outcome: { outcome: 'succeeded', output: {} } }],
      admissions: [],
      conclusions: [],
      workload: [],
      measured_cost_micros: 7,
      builtin_results: [],
    };
    writeFileSync(path, `${JSON.stringify(legacy)}\n`);
    const migrated = FabricStore.open(path);
    const expectedSnapshot = FabricStore.restore(legacy).snapshot();
    const head = JSON.parse(readFileSync(path, 'utf8').split('\n')[0] ?? '{}') as { op?: string };
    assert.equal(head.op, 'snapshot');
    assert.deepEqual(migrated.snapshot(), expectedSnapshot);

    const resource = {
      canonical_id: 'res_3',
      kind: 'destination' as const,
      locator: 'mem:legacy-outbox',
      revision: 1,
      content: '',
      publication: null,
    };
    migrated.putResource(resource);
    migrated.issue(resource.canonical_id, 'destination');
    migrated.close();

    const expected = FabricStore.restore(expectedSnapshot);
    expected.putResource(resource);
    expected.issue(resource.canonical_id, 'destination');

    const reopened = FabricStore.open(path);
    try {
      assert.deepEqual(reopened.snapshot(), expected.snapshot());
    } finally {
      reopened.close();
    }
    const again = FabricStore.open(path);
    try {
      assert.deepEqual(again.snapshot(), expected.snapshot());
    } finally {
      again.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an empty lock instead of stealing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-empty-lock-'));
    const path = join(dir, 'fabric.json');
    try {
      writeFileSync(`${path}.lock`, '');
      assert.throws(() => FabricStore.open(path), /already open/);
      assert.equal(readFileSync(`${path}.lock`, 'utf8'), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a second writer and clears a stale lock from a dead process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-lock-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    try {
      assert.throws(() => FabricStore.open(path), /already open/);
    } finally {
      store.close();
    }

    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    assert.ok(dead.pid);
    writeFileSync(`${path}.lock`, String(dead.pid));
    const recovered = FabricStore.open(path);
    try {
      assert.equal(recovered.snapshot().resources.length, 0);
    } finally {
      recovered.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
