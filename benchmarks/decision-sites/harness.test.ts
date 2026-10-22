import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Journal, acquireLock, projectedCost, replayKey } from './journal.ts';
import { buildRequest } from './questions.ts';

test('journal repairs torn tail, fsyncs appends, counts each completed attempt once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-test-'));
  try {
    const path = join(dir, 'journal.jsonl');
    await writeFile(path, '{"type":"call","call_id":"a","cost_usd":0.2}\n{"broken":');
    const journal = new Journal(path);
    assert.equal(journal.spent(), 0.2);
    journal.append({ type: 'call', call_id: 'b', cost_usd: 0.3 });
    assert.equal(new Journal(path).spent(), 0.5);
    assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('lock refuses re-entrant own pid and reports dead pid without stealing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-lock-'));
  try {
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), /locked/);
    const owner = JSON.parse(await readFile(join(dir, 'lock'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.nonce, 'string');
    release();
    await writeFile(join(dir, 'lock'), String(process.pid));
    assert.throws(() => acquireLock(dir), /has stale lock/);
    await writeFile(join(dir, 'lock'), '2147483647');
    assert.throws(() => acquireLock(dir), /has stale lock/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('own reused PID after a crash reads as stale without stealing the lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-own-pid-'));
  try {
    const lock = join(dir, 'lock');
    await writeFile(lock, String(process.pid));
    assert.throws(() => acquireLock(dir), /has stale lock/);
    assert.equal(await readFile(lock, 'utf8'), String(process.pid));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('relative and absolute spellings identify the same held lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-lock-alias-'));
  const release = acquireLock(dir);
  try {
    assert.throws(() => acquireLock(relative(process.cwd(), dir)), /^Error: Run directory locked$/);
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});
test('a crashed same-host lock with our PID reads as stale without stealing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-own-host-lock-'));
  const release = acquireLock(dir),
    value = await readFile(join(dir, 'lock'), 'utf8');
  release();
  try {
    await writeFile(join(dir, 'lock'), value);
    assert.throws(() => acquireLock(dir), /has stale lock/);
    assert.equal(await readFile(join(dir, 'lock'), 'utf8'), value);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('a foreign nonce with our PID is unknown rather than falsely stale, and is never stolen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-foreign-lock-'));
  try {
    const value = JSON.stringify({ pid: process.pid, nonce: 'another-container' });
    await writeFile(join(dir, 'lock'), value);
    assert.throws(() => acquireLock(dir), /has stale-unknown lock/);
    assert.equal(await readFile(join(dir, 'lock'), 'utf8'), value);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('a foreign boot or PID namespace never uses local PID liveness', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-foreign-host-'));
  const release = acquireLock(dir),
    owner = JSON.parse(await readFile(join(dir, 'lock'), 'utf8'));
  release();
  let probes = 0;
  const stub = t.mock.method(process, 'kill', () => {
    probes++;
    throw Object.assign(new Error(), { code: 'ESRCH' });
  });
  try {
    const value = JSON.stringify({ ...owner, host: 'foreign-boot:foreign-namespace' });
    await writeFile(join(dir, 'lock'), value);
    assert.throws(() => acquireLock(dir), /has stale-unknown lock/);
    assert.equal(probes, 0);
    assert.equal(await readFile(join(dir, 'lock'), 'utf8'), value);
  } finally {
    stub.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
test('journal handles under the same lock share the current durable ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-shared-journal-')),
    path = join(dir, 'journal.jsonl');
  const release = acquireLock(dir);
  try {
    const first = new Journal(path),
      second = new Journal(path);
    first.append({ type: 'intent', call_id: 'a', projected_usd: 0.5 });
    assert.equal(second.spent(), 0.5);
    second.append({ type: 'call', call_id: 'a', cost_usd: 0.2 });
    assert.equal(first.spent(), 0.2);
    assert.equal(first.read().length, 2);
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});
test('writable journal reads once per lock tenure and protects its cached records', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-journal-cache-')),
    path = join(dir, 'journal.jsonl');
  await writeFile(path, JSON.stringify({ type: 'intent', call_id: 'a', projected_usd: 0.5 }) + '\n');
  let release = acquireLock(dir),
    reads = 0;
  const original = fs.readFileSync;
  const stub = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === path) reads++;
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  try {
    const journal = new Journal(path);
    assert.equal(journal.spent(), 0.5);
    journal.append({ type: 'call', call_id: 'a', cost_usd: 0.2 });
    const input = { type: 'call', call_id: 'b', cost_usd: 0.3, nested: { value: 'saved' } };
    journal.append(input);
    input.nested.value = 'mutated';
    const rows = journal.read();
    rows[1]!.cost_usd = 99;
    rows[2]!.nested.value = 'mutated again';
    rows.length = 0;
    assert.equal(journal.spent(), 0.5);
    assert.equal(journal.read()[2]!.nested.value, 'saved');
    assert.equal(reads, 1, 'append, spent and read must reuse the parsed journal while locked');
    release();
    await writeFile(path, JSON.stringify({ type: 'call', call_id: 'new', cost_usd: 0.7 }) + '\n');
    release = acquireLock(dir);
    assert.equal(journal.spent(), 0.7, 'a new lock tenure must reload disk');
    assert.equal(reads, 2);
    const reader = new Journal(path, true);
    journal.append({ type: 'call', call_id: 'newer', cost_usd: 0.1 });
    assert.equal(reader.read().length, 2, 'read-only journals must keep observing durable writes');
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
    release();
    await rm(dir, { recursive: true, force: true });
  }
});
test('budget projection and replay binding include all evidence identities', () => {
  assert.equal(projectedCost('1234567', 0.1), (7 * 0.1) / 1e6);
  assert.equal(projectedCost('漢😀', 0.1), (7 * 0.1) / 1e6);
  const base = {
    provider: 'p',
    model: 'm',
    site: 'loop.route',
    item_id: 'i',
    set_digest: 's',
    question_digest: 'q',
    request_digest: 'wire',
  };
  for (const key of Object.keys(base)) assert.notEqual(replayKey(base), replayKey({ ...base, [key]: 'changed' }));
});
test('requests reuse production builders, including disclosed D3-only state', async () => {
  const r = await buildRequest({
    id: 'i',
    scenario_id: 's',
    site: 'loop.preselect',
    state: { preselect_step: 'read', index: [{ id: 'x', purpose: 'Read files' }], secret: 'excluded' },
    gold: { entry_0: true },
  });
  assert.deepEqual(r.state, { step: 'read', catalogue_index: [{ id: 'x', purpose: 'Read files' }] });
  assert.deepEqual(r.questions.entry_0?.instructions, {
    question: 'Is this disclosed catalogue entry relevant to this step?',
    entry: { id: 'x', purpose: 'Read files' },
  });
});

test('empty or malformed lock is stale-unknown and is never stolen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-unknown-lock-'));
  try {
    for (const value of ['', 'not-a-pid', '0']) {
      await writeFile(join(dir, 'lock'), value);
      assert.throws(() => acquireLock(dir), /stale-unknown/);
      assert.equal(await readFile(join(dir, 'lock'), 'utf8'), value);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
