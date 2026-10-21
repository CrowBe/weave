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

  it('does not report failure when ownership ends after the append commits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-post-commit-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const original = mutableFs.writeSync;
    mutableFs.writeSync = ((...args: Parameters<typeof original>) => {
      const written = original(...args);
      store.close();
      return written;
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      assert.doesNotThrow(() => store.persistInvocationResult(invocation('committed')));
    } finally {
      mutableFs.writeSync = original;
      syncBuiltinESMExports();
      store.close();
    }
    try {
      const reopened = FabricStore.open(path);
      try { assert.equal(reopened.getInvocation('committed')?.status, 'running'); }
      finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const invalidMutations = [
    { op: 'cost', micros: '5' }, { op: 'cost', micros: -1 },
    { op: 'put', resource: {} }, { op: 'result', record: {} },
    { op: 'start', record: invocation('bad-start'), measured_cost_micros: null },
    { op: 'allocate', id: 'res_no' }, { op: 'allocate', id: 'res_' },
    { op: 'allocate', id: 'res_9007199254740991' },
    { op: 'issue', ref: { handle: 'ref_no', canonical_id: 'res_1', kind: 'source' } },
    { op: 'admission', admission: {} }, { op: 'workload', workload: {} },
    { op: 'remember', result: {} }, { op: 'conclusion' },
  ];
  for (const [index, mutation] of invalidMutations.entries()) {
    it(`rejects malformed mutation payload ${index} before append`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-invalid-append-'));
      const path = join(dir, 'fabric.json');
      const store = FabricStore.open(path);
      try {
        const before = readFileSync(path);
        const state = store.snapshot();
        assert.throws(() => (store as unknown as { mutate(value: unknown): void }).mutate(mutation), /invalid host store/);
        assert.deepEqual(readFileSync(path), before);
        assert.deepEqual(store.snapshot(), state);
        (store as unknown as { compact(): void }).compact();
        store.close();
        const reopened = FabricStore.open(path);
        try { assert.deepEqual(reopened.snapshot(), state); } finally { reopened.close(); }
      } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
    });
    it(`rejects malformed mutation payload ${index} at its physical line without changing bytes`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-invalid-mutation-'));
      const path = join(dir, 'fabric.json');
      let opened: FabricStore | undefined;
      try {
        for (const tail of ['', '{"op":', 'no-newline']) {
          const bytes = `{"op":"allocate","id":"res_1"}\n\n${JSON.stringify(mutation)}` +
            (tail === 'no-newline' ? '' : `\n${tail}`);
          writeFileSync(path, bytes);
          assert.throws(() => { opened = FabricStore.open(path); }, /line 3/);
          assert.equal(readFileSync(path, 'utf8'), bytes);
          assert.equal(existsSync(`${path}.lock`), false);
        }
      } finally { opened?.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }

  const invalidRecords = [
    { ...invocation('bad-output'), outcome: { outcome: 'succeeded', output: undefined } },
    { ...invocation('bad-failure'), outcome: { outcome: 'failed', failure: 42 } },
    { ...invocation('bad-cost'), measured_cost_micros: NaN },
    { ...invocation('bad-json'), outcome: { outcome: 'succeeded', output: {}, toJSON: () => ({ outcome: 'succeeded' }) } },
  ] as InvocationRecord[];
  for (const [index, record] of invalidRecords.entries()) {
    it(`rejects unreadable invocation ${index} before append and stays readable after compaction`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-invalid-write-'));
      const path = join(dir, 'fabric.json');
      const store = FabricStore.open(path);
      try {
        store.persistInvocationStart(invocation('valid'));
        const before = readFileSync(path);
        const state = store.snapshot();
        assert.throws(() => store.persistInvocationResult(record), /invalid host store/);
        assert.deepEqual(readFileSync(path), before);
        assert.deepEqual(store.snapshot(), state);
        (store as unknown as { compact(): void }).compact();
        store.close();
        const reopened = FabricStore.open(path);
        try { assert.deepEqual(reopened.snapshot(), state); } finally { reopened.close(); }
      } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
    });
    it(`rejects unreadable restore ${index} before creating a journal`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-invalid-restore-'));
      const path = join(dir, 'fabric.json');
      let opened: FabricStore | undefined;
      try {
        const snapshot = { ...new FabricStore().snapshot(), invocations: [record] };
        assert.throws(() => { opened = FabricStore.restore(snapshot, path); }, /invalid host store/);
        assert.equal(existsSync(path), false);
        assert.equal(existsSync(`${path}.lock`), false);
      } finally { opened?.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it('rejects invalid and overflowing measured costs before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-cost-guard-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    try {
      store.addMeasuredCost(Number.MAX_VALUE);
      const before = readFileSync(path);
      for (const cost of [NaN, Infinity, -1, Number.MAX_VALUE]) {
        assert.throws(() => store.addMeasuredCost(cost), /invalid host store/);
        assert.throws(() => store.persistInvocationStart(invocation('overflow'), cost), /invalid host store/);
        assert.deepEqual(readFileSync(path), before);
      }
      (store as unknown as { compact(): void }).compact();
      store.close();
      const reopened = FabricStore.open(path);
      try { assert.equal(reopened.measuredCostMicros(), Number.MAX_VALUE); } finally { reopened.close(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('validates the serialized snapshot before touching a compaction file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-compact-guard-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    try {
      store.persistInvocationStart(invocation('valid'));
      const before = readFileSync(path);
      const original = store.snapshot.bind(store);
      store.snapshot = () => ({ ...original(), invocations: [invalidRecords[0]!] });
      assert.throws(() => (store as unknown as { compact(): void }).compact(), /invalid host store/);
      assert.deepEqual(readFileSync(path), before);
      assert.equal(existsSync(`${path}.tmp`), false);
      store.close();
      const reopened = FabricStore.open(path);
      reopened.close();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('round-trips every accepted mutation through append, replay and compaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-round-trip-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    try {
      const contract = { id: 'test', revision: '1', purpose: 'round trip', input: {}, output: {},
        effects: [], permissions: [], failures: [], depends_on: [] };
      const payloads = [null, false, 0, '', [], {}, { nested: [1, null, 'value'] },
        { optional: undefined }, { toJSON: () => ({ normalized: true }) }];
      const operations = [
        () => store.allocateCanonical(),
        () => store.issue('res_1', 'source'),
        () => store.putResource({ canonical_id: 'res_1', kind: 'source', locator: 'mem:test',
          revision: 1, content: 'test', publication: null }),
        () => store.persistInvocationStart(invocation('round-trip'), 7),
        () => store.recordAdmission({ operation: 'test', implementation_id: 'test@1', contract, source: 'test' }),
        () => store.noteWorkload({ goal_id: 'goal', quality: 'held' }),
        () => store.addMeasuredCost(5),
        ...payloads.flatMap((payload, i) => [
          () => store.persistInvocationResult({ ...invocation(`result-${i}`), outcome: { outcome: 'succeeded', output: payload } }),
          () => store.retainConclusion(payload),
          () => store.rememberResult({ key: `result-${i}`, operation: 'test', implementation_id: 'test@1',
            outcome: { outcome: 'succeeded', output: payload } }),
        ]),
      ];
      for (const operation of operations) {
        operation();
        const expected = JSON.parse(JSON.stringify(store.snapshot()));
        const replayPath = join(dir, 'replay.json');
        writeFileSync(replayPath, readFileSync(path));
        const replayed = FabricStore.open(replayPath);
        try { assert.deepEqual(replayed.snapshot(), expected); } finally { replayed.close(); }
        (store as unknown as { compact(): void }).compact();
        const compactPath = join(dir, 'compact.json');
        writeFileSync(compactPath, readFileSync(path));
        const compacted = FabricStore.open(compactPath);
        try { assert.deepEqual(compacted.snapshot(), expected); } finally { compacted.close(); }
      }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('waits for a live reaper and then lets contenders acquire in turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-live-reaper-'));
    const path = join(dir, 'fabric.json');
    const reclaim = `${path}.lock.reclaim`;
    const claim = `${reclaim}/reap`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(`${path}.lock`, String(dead.pid));
    nodeFs.mkdirSync(claim, { recursive: true });
    writeFileSync(`${reclaim}/owner`, String(dead.pid));
    writeFileSync(`${claim}/owner`, `${process.pid}:claimant`);
    let sleeps = 0;
    let first: FabricStore | undefined;
    let second: FabricStore | undefined;
    // A synchronous injected sleep lets the other contender finish deterministically.
    try {
      second = FabricStore.open(path, { sleep(ms) {
        assert.ok(ms > 0 && ms <= 10);
        sleeps += 1;
        if (sleeps === 2) {
          rmSync(reclaim, { recursive: true });
          first = FabricStore.open(path);
          first.retainConclusion('first contender');
          first.close();
        }
      } });
      assert.equal(sleeps, 2);
      second.retainConclusion('second contender');
      assert.throws(() => FabricStore.open(path), /already open/);
      assert.deepEqual(second.conclusions(), ['first contender', 'second contender']);
    } finally { first?.close(); second?.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('retries when a claim disappears during owner revalidation after backoff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-reaper-finished-'));
    const path = join(dir, 'fabric.json');
    const reclaim = `${path}.lock.reclaim`;
    const claim = `${reclaim}/reap`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(`${path}.lock`, String(dead.pid));
    nodeFs.mkdirSync(claim, { recursive: true });
    writeFileSync(`${reclaim}/owner`, String(dead.pid));
    writeFileSync(`${claim}/owner`, String(dead.pid));
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const original = mutableFs.readFileSync;
    let finished = false;
    let sleeps = 0;
    let store: FabricStore | undefined;
    mutableFs.readFileSync = ((...args: Parameters<typeof original>) => {
      const result = original(...args);
      if (!finished && sleeps === 8 && String(args[0]) === `${reclaim}/owner`) {
        finished = true;
        rmSync(reclaim, { recursive: true });
      }
      return result;
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      store = FabricStore.open(path, { sleep() { sleeps += 1; } });
      assert.ok(finished);
      assert.equal(sleeps, 8);
      store.retainConclusion('reaper completed');
    } finally {
      mutableFs.readFileSync = original;
      syncBuiltinESMExports();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the blocked claim under a dead reclaim owner after the retry bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-live-reaper-bound-'));
    const path = join(dir, 'fabric.json');
    const reclaim = `${path}.lock.reclaim`;
    const claim = `${reclaim}/reap`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(`${path}.lock`, String(dead.pid));
    nodeFs.mkdirSync(claim, { recursive: true });
    writeFileSync(`${reclaim}/owner`, String(dead.pid));
    writeFileSync(`${claim}/owner`, `${process.pid}:claimant`);
    let sleeps = 0;
    try {
      assert.throws(() => FabricStore.open(path, { sleep() { sleeps += 1; } }), (error: Error) => {
        assert.match(error.message, /already open/);
        assert.ok(error.message.includes(`stale-lock reclaim is blocked by ${claim}`));
        assert.ok(error.message.includes(`confirm no weave process is using ${path}`));
        assert.ok(error.message.includes(`then remove ${claim} and retry`));
        assert.doesNotMatch(error.message, /claimant/);
        return true;
      });
      assert.ok(sleeps > 0 && sleeps <= 16);
      assert.ok(existsSync(claim));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

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
      assert.doesNotThrow(() => store.save());
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

  for (const aliasKind of ['file', 'parent'] as const) {
    it(`refuses a second writer through a ${aliasKind} symlink`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-alias-'));
      const real = join(dir, 'real');
      nodeFs.mkdirSync(real);
      const path = join(real, 'fabric.json');
      const alias = aliasKind === 'file' ? join(dir, 'alias.json') : join(dir, 'alias', 'fabric.json');
      if (aliasKind === 'file') writeFileSync(path, '');
      nodeFs.symlinkSync(aliasKind === 'file' ? path : real, aliasKind === 'file' ? alias : join(dir, 'alias'));
      const first = FabricStore.open(alias);
      let second: FabricStore | undefined;
      try {
        assert.throws(() => { second = FabricStore.open(path); }, /already open/);
      } finally {
        second?.close();
        first.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('refuses a dangling journal symlink without replacing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-dangling-alias-'));
    const alias = join(dir, 'alias.json');
    nodeFs.symlinkSync(join(dir, 'missing.json'), alias);
    let store: FabricStore | undefined;
    try {
      assert.throws(() => { store = FabricStore.open(alias); }, /ENOENT/);
      assert.equal(nodeFs.lstatSync(alias).isSymbolicLink(), true);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compacts the real file while preserving its symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-alias-compact-'));
    const path = join(dir, 'fabric.json');
    const alias = join(dir, 'alias.json');
    writeFileSync(path, '');
    nodeFs.symlinkSync(path, alias);
    const store = FabricStore.open(alias);
    try {
      store.retainConclusion('x'.repeat(300 * 1024));
      assert.equal(nodeFs.lstatSync(alias).isSymbolicLink(), true);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).op, 'snapshot');
      store.close();
      const reopened = FabricStore.open(path);
      try { assert.deepEqual(reopened.conclusions(), ['x'.repeat(300 * 1024)]); }
      finally { reopened.close(); }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const failure of ['write', 'rename'] as const) {
    it(`keeps committed mutations successful and writable after compaction ${failure} failure`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-compaction-failure-'));
      const path = join(dir, 'fabric.json');
      const store = FabricStore.open(path);
      // Defer maintenance so the invocation start itself crosses the threshold.
      store.putResource({ canonical_id: 'res_1', kind: 'source', locator: 'mem:large', revision: 1,
        content: 'x'.repeat(300 * 1024), publication: null }, false);
      const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
      const originalRename = mutableFs.renameSync;
      const originalWrite = mutableFs.writeFileSync;
      mutableFs.renameSync = ((...args: Parameters<typeof originalRename>) => {
        if (failure === 'rename' && String(args[0]) === `${path}.tmp`) throw new Error('injected compaction failure');
        return originalRename(...args);
      }) as typeof originalRename;
      mutableFs.writeFileSync = ((...args: Parameters<typeof originalWrite>) => {
        if (failure === 'write' && String(args[0]) === `${path}.tmp`) throw new Error('injected compaction failure');
        return originalWrite(...args);
      }) as typeof originalWrite;
      syncBuiltinESMExports();
      try {
        assert.doesNotThrow(() => store.persistInvocationStart(invocation('inv-compaction')));
        assert.match(String(store.compactionError()), /injected compaction failure/);
        assert.doesNotThrow(() => store.retainConclusion('still writable'));
        store.close();
        const reopened = FabricStore.open(path);
        try {
          assert.equal(reopened.getInvocation('inv-compaction')?.status, 'running');
          assert.deepEqual(reopened.conclusions(), ['still writable']);
          reopened.retainConclusion('y'.repeat(600 * 1024));
          assert.match(String(reopened.compactionError()), /injected compaction failure/);
          mutableFs.renameSync = originalRename;
          mutableFs.writeFileSync = originalWrite;
          syncBuiltinESMExports();
          reopened.save();
          assert.equal(reopened.compactionError(), null);
          assert.equal(JSON.parse(readFileSync(path, 'utf8')).op, 'snapshot');
        } finally { reopened.close(); }
      } finally {
        mutableFs.renameSync = originalRename;
        mutableFs.writeFileSync = originalWrite;
        syncBuiltinESMExports();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('never quarantines a live reclaim successor after reading a dead owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-reclaim-successor-'));
    const path = join(dir, 'fabric.json');
    const reclaim = `${path}.lock.reclaim`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(`${path}.lock`, String(dead.pid));
    nodeFs.mkdirSync(reclaim);
    writeFileSync(`${reclaim}/owner`, String(dead.pid));
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const originalRead = mutableFs.readFileSync;
    const originalRename = mutableFs.renameSync;
    let injected = false;
    let movedLive = false;
    mutableFs.readFileSync = ((...args: Parameters<typeof originalRead>) => {
      const result = originalRead(...args);
      if (!injected && String(args[0]) === `${reclaim}/owner`) {
        injected = true;
        rmSync(reclaim, { recursive: true });
        nodeFs.mkdirSync(reclaim);
        writeFileSync(`${reclaim}/owner`, `${process.pid}:successor`);
      }
      return result;
    }) as typeof originalRead;
    mutableFs.renameSync = ((...args: Parameters<typeof originalRename>) => {
      if (String(args[0]) === reclaim) movedLive = true;
      return originalRename(...args);
    }) as typeof originalRename;
    syncBuiltinESMExports();
    try {
      assert.throws(() => FabricStore.open(path), (error: Error) => {
        assert.match(error.message, /already open|reclaim/);
        assert.doesNotMatch(error.message, /remove/i);
        return true;
      });
      assert.ok(injected);
      assert.equal(movedLive, false);
      assert.equal(readFileSync(`${reclaim}/owner`, 'utf8'), `${process.pid}:successor`);
      assert.equal(readFileSync(`${path}.lock`, 'utf8'), String(dead.pid));
    } finally {
      mutableFs.readFileSync = originalRead;
      mutableFs.renameSync = originalRename;
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes only the quarantined reclaim generation when a successor arrives during release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-reclaim-release-'));
    const path = join(dir, 'fabric.json');
    const reclaim = `${path}.lock.reclaim`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(`${path}.lock`, String(dead.pid));
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const originalRemove = mutableFs.rmSync;
    let injected = false;
    let store: FabricStore | undefined;
    mutableFs.rmSync = ((...args: Parameters<typeof originalRemove>) => {
      const target = String(args[0]);
      if (!injected && (target === reclaim || target.startsWith(`${reclaim}.released.`))) {
        injected = true;
        // Another contender occupies the live name after release has selected
        // its removal target, before recursive removal starts walking it.
        if (existsSync(reclaim)) nodeFs.renameSync(reclaim, `${reclaim}.previous`);
        nodeFs.mkdirSync(reclaim);
        writeFileSync(`${reclaim}/owner`, `${process.pid}:successor`);
      }
      return originalRemove(...args);
    }) as typeof originalRemove;
    syncBuiltinESMExports();
    try {
      store = FabricStore.open(path);
      assert.ok(injected);
      assert.ok(existsSync(reclaim), 'release must preserve the successor directory');
      assert.equal(readFileSync(`${reclaim}/owner`, 'utf8'), `${process.pid}:successor`);
    } finally {
      mutableFs.rmSync = originalRemove;
      syncBuiltinESMExports();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const changedOwner of ['dead', 'live'] as const) {
    it(`removes its own reap claim after revalidation finds a changed ${changedOwner} owner`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-reclaim-revalidate-'));
      const path = join(dir, 'fabric.json');
      const reclaim = `${path}.lock.reclaim`;
      const claim = `${reclaim}/reap`;
      const dead = spawnSync(process.execPath, ['-e', '']);
      assert.equal(dead.status, 0);
      writeFileSync(`${path}.lock`, String(dead.pid));
      nodeFs.mkdirSync(reclaim);
      writeFileSync(`${reclaim}/owner`, String(dead.pid));
      const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
      const originalWrite = mutableFs.writeFileSync;
      let changed = false;
      let store: FabricStore | undefined;
      mutableFs.writeFileSync = ((...args: Parameters<typeof originalWrite>) => {
        const result = originalWrite(...args);
        if (!changed && String(args[0]) === `${claim}/owner`) {
          changed = true;
          originalWrite(`${reclaim}/owner`, `${changedOwner === 'live' ? process.pid : dead.pid}:changed`);
        }
        return result;
      }) as typeof originalWrite;
      syncBuiltinESMExports();
      try {
        if (changedOwner === 'live') assert.throws(() => FabricStore.open(path), /already open/);
        else store = FabricStore.open(path);
        assert.ok(changed);
        assert.equal(existsSync(claim), false, 'failed revalidation must release its own claim');
        if (changedOwner === 'live') {
          assert.equal(readFileSync(`${reclaim}/owner`, 'utf8'), `${process.pid}:changed`);
          assert.equal(readFileSync(`${path}.lock`, 'utf8'), String(dead.pid));
        }
      } finally {
        mutableFs.writeFileSync = originalWrite;
        syncBuiltinESMExports();
        store?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('preserves another contender reap claim when failed revalidation finds a replacement token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-reclaim-foreign-claim-'));
    const path = join(dir, 'fabric.json');
    const reclaim = `${path}.lock.reclaim`;
    const claim = `${reclaim}/reap`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(`${path}.lock`, String(dead.pid));
    nodeFs.mkdirSync(reclaim);
    writeFileSync(`${reclaim}/owner`, String(dead.pid));
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const originalWrite = mutableFs.writeFileSync;
    let changed = false;
    mutableFs.writeFileSync = ((...args: Parameters<typeof originalWrite>) => {
      const result = originalWrite(...args);
      if (!changed && String(args[0]) === `${claim}/owner`) {
        changed = true;
        originalWrite(`${reclaim}/owner`, `${process.pid}:successor`);
        originalWrite(`${claim}/owner`, `${process.pid}:foreign-claim`);
      }
      return result;
    }) as typeof originalWrite;
    syncBuiltinESMExports();
    try {
      assert.throws(() => FabricStore.open(path), /already open/);
      assert.ok(changed);
      assert.equal(readFileSync(`${claim}/owner`, 'utf8'), `${process.pid}:foreign-claim`);
    } finally {
      mutableFs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes contenders while a dead reclaim generation is claimed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-reclaim-claim-'));
    const path = join(dir, 'fabric.json');
    const reclaim = `${path}.lock.reclaim`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(`${path}.lock`, String(dead.pid));
    nodeFs.mkdirSync(reclaim);
    writeFileSync(`${reclaim}/owner`, String(dead.pid));
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const original = mutableFs.renameSync;
    let raced = false;
    let rival: FabricStore | undefined;
    mutableFs.renameSync = ((...args: Parameters<typeof original>) => {
      if (!raced && String(args[0]) === reclaim) {
        raced = true;
        assert.throws(() => { rival = FabricStore.open(path); }, /already open/);
        assert.equal(readFileSync(`${reclaim}/owner`, 'utf8'), String(dead.pid));
        assert.ok(new RegExp(`^${process.pid}:[0-9]+$`).test(readFileSync(`${reclaim}/reap/owner`, 'utf8')));
      }
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    let winner: FabricStore | undefined;
    try {
      winner = FabricStore.open(path);
      assert.ok(raced);
      winner.retainConclusion('exclusive owner');
      assert.throws(() => FabricStore.open(path), /already open/);
    } finally {
      mutableFs.renameSync = original;
      syncBuiltinESMExports();
      rival?.close();
      winner?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const aliasKind of ['direct', 'file', 'parent'] as const) {
    it(`names the exact crashed recovery claim and manual cleanup through a ${aliasKind} path`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-reclaim-abandoned-'));
      const path = join(nodeFs.realpathSync(dir), 'fabric.json');
      const alias = aliasKind === 'file' ? join(dir, 'alias.json') : join(dir, 'alias', 'fabric.json');
      if (aliasKind === 'file') {
        writeFileSync(path, '');
        nodeFs.symlinkSync(path, alias);
      } else if (aliasKind === 'parent') {
        nodeFs.symlinkSync(dir, join(dir, 'alias'));
      }
      const openedPath = aliasKind === 'direct' ? path : alias;
      const reclaim = `${path}.lock.reclaim`;
      const claim = `${reclaim}/reap`;
      const dead = spawnSync(process.execPath, ['-e', '']);
      assert.equal(dead.status, 0);
      writeFileSync(`${path}.lock`, String(dead.pid));
      nodeFs.mkdirSync(claim, { recursive: true });
      writeFileSync(`${reclaim}/owner`, String(dead.pid));
      let reopened: FabricStore | undefined;
      try {
        const inode = nodeFs.statSync(reclaim).ino;
        assert.throws(() => FabricStore.open(openedPath), (error: Error) => {
          assert.ok(error.message.includes(`confirm no weave process is using ${path}`));
          assert.ok(error.message.includes(`then remove ${claim} and retry`));
          if (aliasKind !== 'direct') assert.ok(!error.message.includes(alias));
          return true;
        });
        assert.equal(nodeFs.statSync(reclaim).ino, inode);
        assert.equal(readFileSync(`${path}.lock`, 'utf8'), String(dead.pid));
        assert.ok(existsSync(claim), 'open must leave the abandoned claim for manual cleanup');
        rmSync(claim, { recursive: true });
        reopened = FabricStore.open(openedPath);
        reopened.retainConclusion('manual cleanup succeeded');
      } finally {
        reopened?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const liveOwner of ['writer', 'reclaim'] as const) {
    it(`never instructs removal of a live ${liveOwner} owner's lock`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-live-reclaim-'));
      const path = join(dir, 'fabric.json');
      const reclaim = `${path}.lock.reclaim`;
      const dead = spawnSync(process.execPath, ['-e', '']);
      assert.equal(dead.status, 0);
      const live = `${process.pid}:private-owner-token`;
      const writer = liveOwner === 'writer' ? live : String(dead.pid);
      const reclaimer = liveOwner === 'reclaim' ? live : String(dead.pid);
      writeFileSync(`${path}.lock`, writer);
      nodeFs.mkdirSync(`${reclaim}/reap`, { recursive: true });
      writeFileSync(`${reclaim}/owner`, reclaimer);
      try {
        assert.throws(() => FabricStore.open(path), (error: Error) => {
          assert.match(error.message, /already open/);
          assert.doesNotMatch(error.message, /remove/i);
          assert.ok(!error.message.includes(live));
          return true;
        });
        assert.equal(readFileSync(`${path}.lock`, 'utf8'), writer);
        assert.equal(readFileSync(`${reclaim}/owner`, 'utf8'), reclaimer);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const changedOwner of ['dead', 'live'] as const) {
    it(`gives exact paths and manual cleanup when a changed ${changedOwner} reclaim owner cannot be restored`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-reclaim-restore-'));
      const path = join(nodeFs.realpathSync(dir), 'fabric.json');
      const alias = join(dir, 'alias.json');
      writeFileSync(path, '');
      nodeFs.symlinkSync(path, alias);
      const reclaim = `${path}.lock.reclaim`;
      const dead = spawnSync(process.execPath, ['-e', '']);
      assert.equal(dead.status, 0);
      const pid = changedOwner === 'live' ? process.pid : dead.pid;
      const movedOwner = `${pid}:changed-private-owner-token`;
      const conflictingOwner = `${pid}:conflicting-private-owner-token`;
      writeFileSync(`${path}.lock`, String(dead.pid));
      nodeFs.mkdirSync(reclaim);
      writeFileSync(`${reclaim}/owner`, String(dead.pid));
      const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
      const originalRename = mutableFs.renameSync;
      let quarantine: string | undefined;
      let reopened: FabricStore | undefined;
      mutableFs.renameSync = ((...args: Parameters<typeof originalRename>) => {
        if (String(args[0]) === reclaim) {
          // Defensive fault: the moved directory no longer has the observed owner,
          // and a third contender has occupied the vacated name.
          originalRename(...args);
          quarantine = String(args[1]);
          writeFileSync(`${quarantine}/owner`, movedOwner);
          nodeFs.mkdirSync(reclaim);
          writeFileSync(`${reclaim}/owner`, conflictingOwner);
          return;
        }
        return originalRename(...args);
      }) as typeof originalRename;
      syncBuiltinESMExports();
      try {
        assert.throws(() => FabricStore.open(alias), (error: Error) => {
          assert.ok(quarantine);
          assert.match(error.message, /restore.*reclaim/);
          assert.ok(error.message.includes(`confirm no weave process is using ${path}`));
          assert.ok(error.message.includes(`then move ${reclaim} and ${quarantine} aside and retry`));
          assert.ok(!error.message.includes(alias));
          assert.ok(!error.message.includes(movedOwner));
          assert.ok(!error.message.includes(conflictingOwner));
          assert.doesNotMatch(error.message, /remove/i);
          assert.ok(['ENOTEMPTY', 'EEXIST'].some((code) =>
            (error.cause as NodeJS.ErrnoException)?.code === code));
          return true;
        });
        assert.equal(readFileSync(`${path}.lock`, 'utf8'), String(dead.pid));
        assert.equal(readFileSync(`${reclaim}/owner`, 'utf8'), conflictingOwner);
        assert.equal(readFileSync(`${quarantine}/owner`, 'utf8'), movedOwner);
        mutableFs.renameSync = originalRename;
        syncBuiltinESMExports();
        if (changedOwner === 'dead') {
          assert.ok(quarantine);
          nodeFs.renameSync(reclaim, `${reclaim}.manual-backup`);
          nodeFs.renameSync(quarantine, `${quarantine}.manual-backup`);
          reopened = FabricStore.open(alias);
          reopened.retainConclusion('manual restoration succeeded');
        }
      } finally {
        mutableFs.renameSync = originalRename;
        syncBuiltinESMExports();
        reopened?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

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
    const before = readFileSync(path);
    const snapshot = store.snapshot();
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
      assert.deepEqual(readFileSync(path), before, 'partial bytes must be removed before retry');
      assert.deepEqual(store.snapshot(), snapshot, 'failed append must not change memory');
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

  it('preserves a replaced append range of the same length and poisons further writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-store-rollback-replaced-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    store.allocateCanonical();
    const before = readFileSync(path);
    const snapshot = store.snapshot();
    const foreign = Buffer.from('other');
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const originalWrite = mutableFs.writeSync;
    let partial = true;
    mutableFs.writeSync = ((fd: number, data: Buffer, offset: number) => {
      if (partial) {
        partial = false;
        return originalWrite(fd, data, offset, foreign.length);
      }
      const otherFd = nodeFs.openSync(path, 'r+');
      try {
        originalWrite(otherFd, foreign, 0, foreign.length, before.length);
      } finally {
        nodeFs.closeSync(otherFd);
      }
      throw new Error('simulated failed append after range replacement');
    }) as typeof originalWrite;
    syncBuiltinESMExports();
    try {
      try {
        assert.throws(() => store.allocateCanonical(), /simulated failed append/);
        assert.deepEqual(store.snapshot(), snapshot);
        assert.deepEqual(readFileSync(path), Buffer.concat([before, foreign]), 'foreign bytes must survive rollback');
      } finally {
        mutableFs.writeSync = originalWrite;
        syncBuiltinESMExports();
      }
      assert.throws(() => store.allocateCanonical(), /reopened/);
      assert.throws(() => (store as unknown as { compact(): void }).compact(), /reopened/);
      assert.deepEqual(store.snapshot(), snapshot);
      assert.deepEqual(readFileSync(path), Buffer.concat([before, foreign]));
    } finally {
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

  for (const malformedPrefix of [false, true]) {
    it(`repairs torn UTF-8 using raw byte offsets (malformed prefix: ${malformedPrefix})`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-store-torn-utf8-'));
      const path = join(dir, 'fabric.json');
      const complete = Buffer.concat([
        Buffer.from('{"op":"conclusion","conclusion":"'),
        malformedPrefix ? Buffer.from([0xff]) : Buffer.from('evidence 🧵'),
        Buffer.from('"}\n'),
      ]);
      const tail = Buffer.concat([Buffer.from('{"op":"'), Buffer.from([0xe2, 0x82])]);
      writeFileSync(path, Buffer.concat([complete, tail]));
      let store: FabricStore | undefined;
      try {
        store = FabricStore.open(path);
        assert.equal(store.recovery.ignored_tail_bytes, tail.length);
        assert.deepEqual(readFileSync(path), complete);
        store.retainConclusion('after repair');
        store.close();
        store = FabricStore.open(path);
        assert.equal(store.recovery.torn_tail_ignored, false);
        assert.deepEqual(store.conclusions(), [malformedPrefix ? '\ufffd' : 'evidence 🧵', 'after repair']);
      } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }

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

    const completeBytes = readFileSync(path);
    appendFileSync(path, '{"op":"put","resource":');
    const reopened = FabricStore.open(path);
    try {
      assert.equal(reopened.recovery.torn_tail_ignored, true);
      assert.deepEqual(readFileSync(path), completeBytes);
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

  it('opens an empty file and rejects a complete whitespace-only record', () => {
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
      assert.throws(() => FabricStore.open(whitespacePath), /line 1/);
      assert.equal(readFileSync(whitespacePath, 'utf8'), '  \n');
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
