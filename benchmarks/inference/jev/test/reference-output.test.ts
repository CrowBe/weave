import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProbeOutput, runReference, writeReferenceOutput } from '../reference.ts';

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'wv037-output-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('atomic reference replacements never expose partial JSON to a concurrent reader', async () => temporary(async dir => {
  const output = join(dir, 'result.json');
  await writeFile(output, JSON.stringify({ header: { status: 'running' }, records: [] }));
  let finished = false;
  const reader = (async () => {
    let reads = 0;
    do {
      const value = JSON.parse(await readFile(output, 'utf8'));
      assert.ok(Array.isArray(value.records));
      assert.ok(value.header);
      reads++;
    } while (!finished);
    return reads;
  })();
  try {
    await runReference({ clock: { now: () => 1_000 }, corpus: ['test'], output,
      jobs: Array.from({ length: 8 }, () => async () => ({ pin_mismatch: false, resolved_model_id: 'jev-1.14.0', payload: 'x'.repeat(20_000) })) });
  } finally { finished = true; }
  assert.ok(await reader > 1);
  assert.deepEqual(await readdir(dir), ['result.json', 'result.json.lock']);
  assert.deepEqual(await readdir(`${output}.lock`), []);
}));

test('failed snapshot serialization preserves the previous durable generation', async () => temporary(async dir => {
  const output = join(dir, 'result.json');
  const valid = await runReference({ clock: { now: () => 1_000 }, corpus: ['first'], output, jobs: [] });
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(writeReferenceOutput(output, { ...valid, records: [circular] }), /circular/i);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), valid);
  assert.deepEqual(await readdir(dir), ['result.json', 'result.json.lock']);
  assert.deepEqual(await readdir(`${output}.lock`), []);
}));

test('replay refuses missing resolved identity even when summary flags claim a match', () => {
  assert.equal(readProbeOutput({ header: {
    mode: 'reference', run_id: 'fake', pinned_model_id: 'jev-1.14.0', run_date: 'fake', corpus_hash: 'fake',
    route: { adapter: 'typesafe-ai', destination: 'typesafe-ai' }, status: 'completed', pin_mismatch: false, pin_mismatch_count: 0,
  }, records: [{ pin_mismatch: false }] }).exitCode, 1);
});

test('reference output recovers the sidecar of a process that has exited', async t => temporary(async dir => {
  const output = join(dir, 'result.json');
  const lock = `${output}.lock`;
  await mkdir(lock);
  await writeFile(join(lock, '123-crashed-run'), '');
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    assert.equal(pid, 123);
    assert.equal(signal, 0);
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  });
  assert.equal((await readdir(lock)).length, 1);
  try {
    const saved = await runReference({ clock: { now: () => 1_000 }, corpus: [], output, jobs: [] });
    assert.equal(saved.header.status, 'completed');
    assert.deepEqual(await readdir(lock), [], 'dead owner markers must be reclaimed');
  } finally { t.mock.restoreAll(); }
}));

test('reference output refuses unknown sidecar owners without replacing prior records', async () => temporary(async dir => {
  const output = join(dir, 'result.json');
  await writeFile(output, 'previous generation');
  await mkdir(`${output}.lock`);
  await writeFile(join(`${output}.lock`, 'unknown'), '');
  await assert.rejects(runReference({ clock: { now: () => 1_000 }, corpus: [], output, jobs: [] }), /output.*in use/i);
  assert.equal(await readFile(output, 'utf8'), 'previous generation');
}));

test('reference output treats a permission-denied PID check as a live owner', async t => temporary(async dir => {
  const output = join(dir, 'result.json');
  const lock = `${output}.lock`;
  await mkdir(lock);
  await writeFile(join(lock, '123-inaccessible-owner'), '');
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  try {
    await assert.rejects(runReference({ clock: { now: () => 1_000 }, corpus: [], output, jobs: [] }), /output.*in use/i);
    assert.deepEqual(await readdir(lock), ['123-inaccessible-owner']);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  } finally { t.mock.restoreAll(); }
}));

test('snapshot failure releases the output claim and preserves the last complete snapshot', async () => temporary(async dir => {
  const output = join(dir, 'result.json');
  const circular: { pin_mismatch: false; self?: unknown } = { pin_mismatch: false };
  circular.self = circular;
  await assert.rejects(runReference({ clock: { now: () => 1_000 }, corpus: [], output,
    jobs: [async () => circular] }), /circular/i);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(saved.records, []);
  assert.deepEqual(await readdir(`${output}.lock`), []);
  assert.equal((await runReference({ clock: { now: () => 1_000 }, corpus: [], output, jobs: [] })).header.status, 'completed');
}));
