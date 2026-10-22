import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { workspaceSnapshot } from '../src/workspace-state.js';

it('bounds snapshots by total bytes and entry count; never follows symlinks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file'), '12345');
  assert.equal(await workspaceSnapshot(root, { max_bytes: 4, max_entries: 100 }), null);
  symlinkSync('/missing-target', join(root, 'link'));
  const before = await workspaceSnapshot(root);
  assert.equal(typeof before, 'string');
  assert.equal(await workspaceSnapshot(root), before);
  assert.equal(await workspaceSnapshot(root, { max_bytes: 4, max_entries: 100 }), null);
  assert.equal(await workspaceSnapshot(root, { max_bytes: 100, max_entries: 1 }), null);
});

for (const prefix of ['', 'nested/']) {
  it(`refuses a snapshot with ${prefix}.git indirection`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-gitdir-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, prefix), { recursive: true });
    writeFileSync(join(root, prefix, '.git'), 'gitdir: /uninspected/git/state\n');
    assert.equal(await workspaceSnapshot(root), null);
  });
  for (const entry of [
    'refs/heads/main',
    'refs/tags/nested/v1',
    'packed-refs',
    'config',
    'hooks/pre-commit',
    'info/exclude',
    'HEAD',
    'index',
    'other',
  ]) {
    it(`snapshots ${prefix}.git/${entry}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'snapshot-git-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const git = join(root, prefix, '.git');
      mkdirSync(join(git, 'refs', 'heads'), { recursive: true });
      const before = await workspaceSnapshot(root);
      const file = join(git, entry);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'changed');
      assert.notEqual(await workspaceSnapshot(root), before);
    });
  }
}
it('excludes only Git objects and logs, including nested Git directories', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const prefix of ['', 'nested/']) {
    const git = join(root, prefix, '.git');
    mkdirSync(git, { recursive: true });
    const before = await workspaceSnapshot(root);
    for (const name of ['objects', 'logs']) {
      mkdirSync(join(git, name));
      writeFileSync(join(git, name, 'ignored'), 'ignored');
    }
    assert.equal(await workspaceSnapshot(root), before);
  }
});
it('compares portable state across device, inode, ownership and timestamp changes but retains mode', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'file');
  writeFileSync(file, 'same');
  const before = await workspaceSnapshot(root);
  const promises = createRequire(import.meta.url)('node:fs/promises');
  const adjust = (stat: Record<string, unknown>) => {
    for (const key of ['dev', 'ino', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs']) {
      if (typeof stat[key] === 'bigint') stat[key] = (stat[key] as bigint) + 1n;
    }
    return stat;
  };
  const original = promises.lstat;
  const originalOpen = promises.open;
  const mocked = t.mock.method(promises, 'lstat', async (...args: unknown[]) => adjust(await original(...args)));
  const opened = t.mock.method(promises, 'open', async (...args: unknown[]) => {
    const handle = await originalOpen(...args);
    const stat = handle.stat.bind(handle);
    handle.stat = async (...options: unknown[]) => adjust(await stat(...options));
    return handle;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await workspaceSnapshot(root), before);
  } finally {
    mocked.mock.restore();
    opened.mock.restore();
    syncBuiltinESMExports();
  }
  chmodSync(file, 0o700);
  assert.notEqual(await workspaceSnapshot(root), before);
});
