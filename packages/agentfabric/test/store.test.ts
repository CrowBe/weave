import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
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

  it('restores the journal length after a partial append failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-append-failure-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    const canonical = store.allocateCanonical();
    const mutableFs = createRequire(import.meta.url)('node:fs') as {
      appendFileSync: typeof nodeFs.appendFileSync;
    };
    const original = mutableFs.appendFileSync;
    let failOnce = true;
    mutableFs.appendFileSync = ((file: nodeFs.PathLike, data: string, options?: nodeFs.WriteFileOptions) => {
      if (failOnce && String(file) === path) {
        failOnce = false;
        original(file, data.slice(0, 5));
        const error = new Error('simulated short write') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return original(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => store.issue(canonical, 'source'), /simulated short write/);
    } finally {
      mutableFs.appendFileSync = original;
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
