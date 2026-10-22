import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const weft = join(root, 'packages/weft');

test('OTel is an explicit package subpath with no runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(weft, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./otel'], './dist/src/otel.js');
  assert.equal(manifest.exports['./sqlite'], './dist/src/sqlite.js');
  assert.equal(manifest.exports['./intake'], './dist/src/sqlite-intake.js');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), []);
});

test('core builds, passes its tests and imports with the OTel and SQLite adapters physically absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-core-only-'));
  try {
    const manifest = JSON.parse(readFileSync(join(weft, 'package.json'), 'utf8'));
    // Keep the real export map: importing core must never try to resolve the absent adapter.
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    cpSync(join(weft, 'fixtures'), join(directory, 'fixtures'), { recursive: true });
    cpSync(join(weft, 'src'), join(directory, 'src'), { recursive: true });
    for (const name of readdirSync(join(directory, 'src'))) {
      if (name.startsWith('otel') || name.startsWith('sqlite'))
        rmSync(join(directory, 'src', name), { recursive: true });
    }
    for (const name of readdirSync(join(weft, 'test'))) {
      if (!name.startsWith('otel') && !name.startsWith('sqlite') && name.endsWith('.test.ts')) {
        cpSync(join(weft, 'test', name), join(directory, 'test', name), { recursive: true });
      }
    }
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        extends: join(root, 'tsconfig.base.json'),
        compilerOptions: { rootDir: '.', outDir: 'dist', typeRoots: [join(root, 'node_modules/@types')] },
        include: ['src/**/*.ts', 'test/**/*.ts'],
      }),
    );
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', directory], {
      encoding: 'utf8',
    });
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const testOutput = execFileSync(
      process.execPath,
      [
        '--test',
        ...readdirSync(join(directory, 'dist/test'))
          .filter((name) => name.endsWith('.test.js'))
          .map((name) => join(directory, 'dist/test', name)),
      ],
      { cwd: directory, encoding: 'utf8', env: childEnv },
    );
    assert.match(testOutput, /# fail 0/);
    assert.doesNotMatch(testOutput, /# tests 0/);
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const core = await import('@weave/weft'); if (typeof core.validateRecord !== 'function') process.exit(1); console.log('core-only import passed');",
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.match(result, /core-only import passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('benchmark routes have no ambient OTel opt-in', () => {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : /\.(?:ts|mts|js|mjs)$/.test(entry.name) ? [path] : [];
    });
  const sources = walk(join(root, 'benchmarks'));
  assert.ok(sources.length > 0);
  for (const path of sources) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /@weave\/weft\/otel|@opentelemetry\//, path);
  }
});
