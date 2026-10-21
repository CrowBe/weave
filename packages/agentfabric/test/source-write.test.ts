import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, type InvocationRecord } from '@weave/agentfabric';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'weave-source-write-'));
  const path = join(dir, 'fabric.jsonl');
  const authority = createGrantAuthority();
  const store = FabricStore.open(path);
  const stores = [store];
  t.after(() => {
    for (const opened of stores) opened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const host = new AgentFabricHost({ authority, store });
  const source = host.registerSource('mem:source-write', 'original');
  const write: (content: string, expectedRevision?: number) => ReturnType<AgentFabricHost['tryWriteSource']> =
    host.tryWriteSource.bind(host, source);
  return {
    host, store, source, path, write,
    reopen() {
      store.close();
      const reopened = FabricStore.open(path);
      stores.push(reopened);
      return new AgentFabricHost({ authority, store: reopened });
    },
  };
}

function invocation(): InvocationRecord {
  return {
    invocation_id: 'inv-source-write',
    action_id: 'action-source-write',
    operation: 'source.inspect',
    binding_digest: 'binding',
    inputs: {},
    status: 'running',
    outcome: null,
    cancel_requested: false,
  };
}

describe('AgentFabric source write journal', () => {
  for (const compaction of ['none', 'before', 'after'] as const) {
    it(`persists source content and revision with compaction ${compaction}`, (t) => {
      const f = fixture(t);
      const compact = () => {
        f.store.retainConclusion('x'.repeat(300 * 1024));
        assert.equal(JSON.parse(readFileSync(f.path, 'utf8').split('\n')[0]!).op, 'snapshot');
      };
      if (compaction === 'before') compact();
      assert.deepEqual(f.write('updated'), { ok: true, revision: 2 });
      f.store.save();
      if (compaction === 'after') compact();
      const reopened = f.reopen();
      assert.equal(reopened.content(f.source), 'updated');
      assert.equal(reopened.revision(f.source), 2);
    });
  }

  it('does not append or change content for a stale revision', (t) => {
    const f = fixture(t);
    const before = readFileSync(f.path);
    assert.deepEqual(f.write('stale', 0), { ok: false, reason: 'conflict' });
    assert.deepEqual(readFileSync(f.path), before);
    assert.equal(f.host.content(f.source), 'original');
    assert.equal(f.host.revision(f.source), 1);
    const reopened = f.reopen();
    assert.equal(reopened.content(f.source), 'original');
    assert.equal(reopened.revision(f.source), 1);
  });

  it('preserves read locks across aliases without appending a rejected write', (t) => {
    const f = fixture(t);
    const alias = f.host.alias(f.source);
    f.host.holdReads('reader', [alias]);
    const before = readFileSync(f.path);
    assert.deepEqual(f.write('blocked', 1), { ok: false, reason: 'conflict' });
    assert.deepEqual(readFileSync(f.path), before);
    f.host.releaseReads('reader');
    assert.deepEqual(f.write('released', 1), { ok: true, revision: 2 });
    const reopened = f.reopen();
    assert.equal(reopened.content(alias), 'released');
    assert.equal(reopened.revision(alias), 2);
  });

  it('replays the last of several sequential writes without a later save', (t) => {
    const f = fixture(t);
    for (let revision = 1; revision <= 4; revision += 1) {
      assert.deepEqual(f.write(`write-${revision}`, revision), { ok: true, revision: revision + 1 });
    }
    const reopened = f.reopen();
    assert.equal(reopened.content(f.source), 'write-4');
    assert.equal(reopened.revision(f.source), 5);
  });

  it('replays the last complete resource write before a torn final line', (t) => {
    const f = fixture(t);
    assert.deepEqual(f.write('complete', 1), { ok: true, revision: 2 });
    f.store.close();
    const tail = '{"op":"put","resource":';
    appendFileSync(f.path, tail);
    const reopened = f.reopen();
    assert.equal(reopened.store.recovery.torn_tail_ignored, true);
    assert.equal(reopened.store.recovery.ignored_tail_bytes, Buffer.byteLength(tail));
    assert.equal(reopened.content(f.source), 'complete');
    assert.equal(reopened.revision(f.source), 2);
  });

  it('conflicts same-tick writers and replays interleaved invocation records', async (t) => {
    const f = fixture(t);
    const alias = f.host.alias(f.source);
    const writeAlias: (content: string, expectedRevision?: number) => ReturnType<AgentFabricHost['tryWriteSource']> =
      f.host.tryWriteSource.bind(f.host, alias);
    const results = await Promise.all([
      Promise.resolve().then(() => {
        f.store.persistInvocationStart(invocation(), 17);
        return f.write('winner', 1);
      }),
      Promise.resolve().then(() => {
        const before = readFileSync(f.path);
        const result = writeAlias('loser', 1);
        assert.deepEqual(readFileSync(f.path), before);
        f.store.persistInvocationResult({
          ...invocation(), status: 'committed', outcome: { outcome: 'succeeded', output: { ok: true } },
        });
        return result;
      }),
    ]);
    assert.deepEqual(results, [{ ok: true, revision: 2 }, { ok: false, reason: 'conflict' }]);
    const reopened = f.reopen();
    assert.equal(reopened.content(f.source), 'winner');
    assert.equal(reopened.revision(f.source), 2);
    assert.equal(reopened.store.getInvocation(invocation().invocation_id)?.status, 'committed');
    assert.deepEqual(reopened.store.getInvocation(invocation().invocation_id)?.outcome,
      { outcome: 'succeeded', output: { ok: true } });
    assert.equal(reopened.store.measuredCostMicros(), 17);
  });

  it('reports a partial append failure without changing memory or the journal', (t) => {
    const f = fixture(t);
    const before = readFileSync(f.path);
    const canonical = f.store.lookupRef(f.source)!.canonical_id;
    const resource = f.store.getResource(canonical)!;
    const mutableFs = createRequire(import.meta.url)('node:fs') as {
      appendFileSync: typeof nodeFs.appendFileSync;
    };
    const original = mutableFs.appendFileSync;
    let injected = false;
    mutableFs.appendFileSync = ((file: nodeFs.PathLike, data: string, options?: nodeFs.WriteFileOptions) => {
      if (!injected && String(file) === f.path) {
        injected = true;
        original(file, data.slice(0, 5));
        const error = new Error('simulated source append failure') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return original(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.write('failed', 1), /simulated source append failure/);
    } finally {
      mutableFs.appendFileSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal(f.store.getResource(canonical), resource);
    assert.equal(resource.content, 'original');
    assert.equal(resource.revision, 1);
    assert.deepEqual(readFileSync(f.path), before);
    assert.deepEqual(f.write('retry', 1), { ok: true, revision: 2 });
    const reopened = f.reopen();
    assert.equal(reopened.content(f.source), 'retry');
    assert.equal(reopened.revision(f.source), 2);
  });
});
