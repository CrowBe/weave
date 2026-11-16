/**
 * walkTs lists TypeScript sources the way the repository checks did when each
 * carried its own walker: every file ending in .ts, nested directories included,
 * readdir order, and an empty list when the directory is missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { walkTs } from '../source-scan.mjs';

/** Depth-first readdir order, directories expanded where they stand. */
function readdirOrder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...readdirOrder(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('walkTs lists nested .ts files in readdir order and ignores other files', () => {
  const root = mkdtempSync(join(tmpdir(), 'walk-ts-'));
  try {
    const src = join(root, 'pkg', 'src');
    mkdirSync(join(src, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(src, 'top.ts'), 'export const top = 1;\n');
    writeFileSync(join(src, 'skip.tsx'), 'export const view = 1;\n');
    writeFileSync(join(src, 'notes.md'), '# notes\n');
    writeFileSync(join(src, 'types.d.ts'), 'export {};\n');
    writeFileSync(join(src, 'nested', 'inner.ts'), 'export const inner = 1;\n');
    writeFileSync(join(src, 'nested', 'readme.txt'), 'text\n');
    writeFileSync(join(src, 'nested', 'deeper', 'leaf.ts'), 'export const leaf = 1;\n');
    writeFileSync(join(src, 'nested', 'deeper', 'leaf.js'), 'export const leaf = 1;\n');

    const found = walkTs(src);
    assert.deepEqual(found, readdirOrder(src));
    assert.deepEqual(
      found.map((file) => relative(src, file)).sort(),
      ['nested/deeper/leaf.ts', 'nested/inner.ts', 'top.ts', 'types.d.ts'].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('walkTs returns an empty list when the directory is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'walk-ts-missing-'));
  try {
    const missing = join(root, 'missing');
    assert.equal(existsSync(missing), false);
    assert.deepEqual(walkTs(missing), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
