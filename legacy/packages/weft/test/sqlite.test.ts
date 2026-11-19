import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openTraceStore } from '../src/sqlite.js';
import type { TraceRecord } from '../src/weave-trace.js';

const row: TraceRecord = {
  schema: 'weave.trace@1',
  id: 'first',
  run_id: 'run',
  parentId: null,
  kind: 'decision',
  sequence: 0,
  payload: { confidence: 0.5 },
};
const line = (r = row) => JSON.stringify(r) + '\n';
const options = { redactTrace: (r: TraceRecord) => r, redact: (r: import('../src/types.js').WeftRecord) => r };
function memory() {
  const result = openTraceStore(':memory:', options);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('open failed');
  return result.store;
}
test('SQLite identity is canonical, conflict never overwrites and rolls back the entire batch', async () => {
  const store = memory();
  try {
    assert.deepEqual(await store.importJsonl(line()), { ok: true, inserted: 1, torn: false });
    const before = store.read();
    assert.deepEqual(await store.importJsonl(line() + line()), { ok: true, inserted: 0, torn: false });
    assert.deepEqual(store.read(), before);
    assert.deepEqual(await store.importJsonl(line({ ...row, id: 'second' }) + line({ ...row, sequence: 1 })), {
      ok: false,
      reason: 'conflict',
    });
    assert.deepEqual(store.read(), before);
    assert.deepEqual(await store.importJsonl(line({ ...row, id: 'second' }) + '{}\n'), { ok: false, reason: 'input' });
    assert.deepEqual(store.read(), before);
    assert.deepEqual(await store.upsert({ ...row, id: 'third' }), { ok: true, inserted: 1, torn: false });
  } finally {
    store.close();
  }
});
test('only newline-terminated JSONL records commit; a torn final line is reported', async () => {
  const store = memory();
  try {
    assert.deepEqual(await store.importJsonl(line() + '{"schema":'), { ok: true, inserted: 1, torn: true });
    assert.deepEqual(await store.importJsonl(JSON.stringify({ ...row, id: 'no-newline' })), {
      ok: true,
      inserted: 0,
      torn: true,
    });
    assert.deepEqual(await store.importJsonl(line({ ...row, id: 'second' }) + 'bad\n'), { ok: false, reason: 'input' });
    const rows = store.read();
    assert.ok(rows.ok);
    if (rows.ok) assert.equal(rows.rows.length, 1);
  } finally {
    store.close();
  }
});
test('mid-batch cancellation, concurrent importer and closed database return typed failures', async () => {
  const store = memory();
  const controller = new AbortController();
  const importing = store.importJsonl(line() + line({ ...row, id: 'second' }), controller.signal);
  assert.deepEqual(await store.importJsonl(line()), { ok: false, reason: 'busy' });
  controller.abort();
  assert.deepEqual(await importing, { ok: false, reason: 'cancelled' });
  assert.deepEqual(store.read(), { ok: true, rows: [] });
  store.close();
  assert.deepEqual(await store.upsert(row), { ok: false, reason: 'storage' });
  assert.deepEqual(store.read(), { ok: false, reason: 'storage' });
  assert.deepEqual(store.close(), { ok: true });
});
test('versioned normalized tables, independent connections, locked DB and durable reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weft-sqlite-'));
  const path = join(dir, 'trace.db');
  try {
    const a = openTraceStore(path, options);
    const b = openTraceStore(path, options);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 1);
    for (const table of [
      'runs',
      'threads',
      'spans',
      'decisions',
      'model_calls',
      'tool_calls',
      'errors',
      'budget_events',
    ]) {
      assert.ok(raw.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table));
    }
    const importing = a.store.importJsonl(line() + line({ ...row, id: 'second' }));
    assert.deepEqual(await b.store.importJsonl(line()), { ok: false, reason: 'busy' });
    assert.ok((await importing).ok);
    const snapshot = a.store.read();
    raw.exec('BEGIN IMMEDIATE');
    assert.deepEqual(await a.store.upsert({ ...row, id: 'locked' }), { ok: false, reason: 'busy' });
    raw.exec('ROLLBACK');
    raw.close();
    a.store.close();
    b.store.close();
    const c = openTraceStore(path, options);
    assert.ok(c.ok);
    if (!c.ok) return;
    assert.deepEqual(await c.store.importJsonl(line() + line({ ...row, id: 'second' })), {
      ok: true,
      inserted: 0,
      torn: false,
    });
    assert.deepEqual(c.store.read(), snapshot);
    c.store.close();
    const schema = new DatabaseSync(path);
    schema.exec('PRAGMA user_version = 99');
    schema.close();
    assert.deepEqual(openTraceStore(path, options), { ok: false, reason: 'schema' });
    assert.deepEqual(openTraceStore(join(dir, 'missing', 'trace.db'), options), { ok: false, reason: 'storage' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
for (const version of [1, 99]) {
  test(`first open rechecks schema version ${version} after another opener wins the transaction`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-first-open-'));
    const path = join(dir, 'trace.db');
    const exec = DatabaseSync.prototype.exec;
    let competed = false;
    // Deterministically interleave another real connection after the version read,
    // immediately before this opener acquires its schema transaction.
    t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === 'BEGIN IMMEDIATE' && !competed) {
        competed = true;
        const other = openTraceStore(path, options);
        assert.ok(other.ok);
        if (other.ok) other.store.close();
        if (version !== 1) {
          const raw = new DatabaseSync(path);
          raw.exec(`PRAGMA user_version = ${version}`);
          raw.close();
        }
      }
      return exec.call(this, sql);
    });
    try {
      const result = openTraceStore(path, options);
      assert.equal(competed, true);
      if (version === 1) {
        assert.ok(result.ok, JSON.stringify(result));
        if (result.ok) {
          assert.deepEqual(result.store.read(), { ok: true, rows: [] });
          result.store.close();
        }
      } else {
        assert.deepEqual(result, { ok: false, reason: 'schema' });
      }
    } finally {
      t.mock.restoreAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
test('SQLite failure after a write rolls back all tables; no raw error escapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weft-sqlite-fail-'));
  const path = join(dir, 'trace.db');
  try {
    const result = openTraceStore(path, options);
    assert.ok(result.ok);
    if (!result.ok) return;
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER disk_failure BEFORE INSERT ON spans WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'disk-canary'); END",
    );
    assert.deepEqual(await result.store.importJsonl(line() + line({ ...row, id: 'second' })), {
      ok: false,
      reason: 'storage',
    });
    assert.equal(raw.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
    assert.deepEqual(result.store.read(), { ok: true, rows: [] });
    raw.close();
    result.store.close();
    assert.doesNotMatch(readFileSync(path).toString(), /disk-canary.*confidence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('normalized model/tool/error/budget columns preserve semantic provenance without JSON queries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weft-columns-'));
  const path = join(dir, 'trace.db');
  try {
    const result = openTraceStore(path, options);
    assert.ok(result.ok);
    if (!result.ok) return;
    const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as {
      valid: { record: import('../src/types.js').WeftRecord }[];
    };
    const kinds = ['inference.attempt', 'capability.invoked', 'error', 'budget', 'cycle.weighed'];
    const records = kinds.map((kind) => fixtures.valid.find((item) => item.record.kind === kind)!.record);
    assert.ok((await result.store.importRecords(records)).ok);
    assert.ok((await result.store.importJsonl(line({ ...row, kind: 'audit', payload: { passed: true } }))).ok);
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('SELECT routed_unit FROM model_calls').get()!.routed_unit, 'jev-1.14.0');
    assert.equal(raw.prepare('SELECT contract_rev FROM tool_calls').get()!.contract_rev, 'repo.read@2');
    assert.equal(typeof raw.prepare('SELECT code FROM errors').get()!.code, 'string');
    assert.equal(typeof raw.prepare('SELECT line FROM budget_events').get()!.line, 'string');
    assert.equal(raw.prepare('SELECT passed FROM decisions WHERE run_id = ?').get('run')!.passed, 1);
    assert.equal(
      raw.prepare('SELECT emitter_id FROM spans WHERE kind = ?').get('inference.attempt')!.emitter_id,
      'gateway.local',
    );
    assert.equal(raw.prepare('SELECT count(*) AS n FROM threads').get()!.n, 1);
    raw.close();
    result.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('process death during an uncommitted batch recovers; replay yields identical canonical rows', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'weft-crash-'));
  const path = join(dir, 'trace.db');
  const jsonl = line() + line({ ...row, id: 'second' });
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { openTraceStore } from ${JSON.stringify(new URL('../src/sqlite.js', import.meta.url).href)};
      const result = openTraceStore(process.argv[1], { redact: r => r, redactTrace: r => r });
      if (!result.ok) process.exit(1);
      void result.store.importJsonl(process.argv[2]);
      // importJsonl has inserted its first row and yielded with BEGIN IMMEDIATE open.
      process.exit(73);
    `,
        path,
        jsonl,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.status, 73, child.stderr);
    const result = openTraceStore(path, options);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.store.read(), { ok: true, rows: [] });
    assert.deepEqual(await result.store.importJsonl(jsonl), { ok: true, inserted: 2, torn: false });
    const baseline = memory();
    await baseline.importJsonl(jsonl);
    assert.deepEqual(result.store.read(), baseline.read());
    const snapshot = result.store.read();
    assert.deepEqual(await result.store.importJsonl(jsonl), { ok: true, inserted: 0, torn: false });
    assert.deepEqual(result.store.read(), snapshot);
    baseline.close();
    result.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('existing TraceImportPort parser uses one transaction and canonical identity ignores object key order', async () => {
  const { importTraceLines } = await import('../src/weave-trace.js');
  const store = memory();
  try {
    await importTraceLines(line(), store);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(row).reverse())) + '\n';
    assert.deepEqual(await store.importJsonl(reordered), { ok: true, inserted: 0, torn: false });
    await assert.rejects(
      importTraceLines(line({ ...row, id: 'new' }) + line({ ...row, sequence: 2 }), store),
      /conflict/,
    );
    assert.deepEqual(store.read(), { ok: true, rows: [row] });
    const pending = store.upsert({ ...row, id: 'other', run_id: 'other-run' });
    assert.deepEqual(store.close(), { ok: false, reason: 'busy' });
    assert.ok((await pending).ok);
    assert.deepEqual(await store.upsertBatch([row], AbortSignal.abort()), { ok: false, reason: 'cancelled' });
  } finally {
    store.close();
  }
});
