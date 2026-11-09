import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const vp = join(root, 'node_modules/.bin/vp');

test('G7 group 5: unchanged production code anchor refuses a coherent manifest replacement', () => {
  // test:checks precedes the package suite in verify; public exports require a build.
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr + build.stdout);
  const dir = mkdtempSync(join(tmpdir(), 'g7-production-anchor-'));
  const leaf = 'benchmarks/failure-attribution';
  const tunePath = `${leaf}/fixtures/tune.jsonl`;
  const manifestPath = `${leaf}/fixtures/manifest.json`;
  const source = readFileSync(join(root, leaf, 'reader.ts'), 'utf8');
  try {
    mkdirSync(join(dir, leaf, 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    for (const name of [
      'reader.ts',
      'reader-core.ts',
      'stored-byte-digest.ts',
      'fixtures/manifest.json',
      'fixtures/tune.jsonl',
    ])
      writeFileSync(join(dir, leaf, name), readFileSync(join(root, leaf, name)));
    const child = join(dir, 'check.mjs');
    writeFileSync(
      child,
      `import { strict as assert } from 'node:assert';
import { readTuneArtifact } from './${leaf}/reader.ts';
assert.ok(readTuneArtifact('${tunePath}').byteLength > 0);
`,
    );
    const run = () =>
      spawnSync(process.execPath, ['--experimental-strip-types', '--disallow-code-generation-from-strings', child], {
        cwd: dir,
        encoding: 'utf8',
      });
    const original = run();
    assert.equal(original.status, 0, original.stderr + original.stdout);
    // Replace only isolated data, keeping the production wrapper's exact source and code anchor.
    const replacement = '{"synthetic":"coherent replacement"}\n';
    writeFileSync(join(dir, tunePath), replacement);
    const manifest = JSON.parse(readFileSync(join(dir, manifestPath), 'utf8'));
    manifest.entries.find((entry) => entry.path === tunePath).storedByteDigest =
      `sha256:${createHash('sha256').update(replacement).digest('hex')}`;
    writeFileSync(join(dir, manifestPath), JSON.stringify(manifest));
    writeFileSync(
      child,
      `import { strict as assert } from 'node:assert';
import { readTuneArtifact } from './${leaf}/reader.ts';
assert.throws(() => readTuneArtifact('${tunePath}'), /manifest anchor mismatch/);
`,
    );
    const changed = run();
    assert.equal(changed.status, 0, changed.stderr + changed.stdout);
    assert.equal(readFileSync(join(dir, leaf, 'reader.ts'), 'utf8'), source);
    assert.equal(readFileSync(join(root, leaf, 'reader.ts'), 'utf8'), source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G7 group 14: native lint checks every leaf name with mandatory error diagnostics', () => {
  const listing = spawnSync(vp, ['lint', '--rules', '--format=json'], { cwd: root, encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const rules = JSON.parse(listing.stdout);
  for (const value of ['no-eval', 'no-new-func', 'no-implied-eval']) {
    assert.ok(rules.some((rule) => rule.scope === 'eslint' && rule.value === value && rule.type_aware === false));
  }
  const dir = mkdtempSync(join(tmpdir(), 'g7-lint-'));
  try {
    const leaf = join(dir, 'benchmarks/failure-attribution');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'vite.config.ts'), readFileSync(join(root, 'vite.config.ts')));
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const names = ['reader-core.ts', 'cases.test.ts', 'imports.test.ts', 'newly-named-leaf.ts'];
    for (const name of names)
      writeFileSync(
        join(leaf, name),
        "export const bad = eval('1');\nexport const other = new Function('return 1');\n",
      );
    const run = () =>
      spawnSync(vp, ['lint', 'benchmarks/failure-attribution', '--format=json'], { cwd: dir, encoding: 'utf8' });
    const bad = run();
    assert.equal(bad.status, 1, bad.stderr + bad.stdout);
    const report = JSON.parse(bad.stdout);
    assert.equal(report.number_of_files, names.length);
    for (const name of names)
      for (const code of ['eslint(no-eval)', 'eslint(no-new-func)']) {
        assert.ok(
          report.diagnostics.some((d) => d.filename.endsWith(name) && d.code === code && d.severity === 'error'),
          `${name}: missing ${code} error`,
        );
      }
    // Pinned Vite+ 1.2.0 exposes no-implied-eval but plain lint emits no diagnostic.
    // Record that outcome explicitly; type-aware lint and custom rules are outside this slice.
    const config = readFileSync(join(dir, 'vite.config.ts'), 'utf8');
    const withImplied = config.replace(
      "'eslint/no-new-func': 'error',",
      "'eslint/no-new-func': 'error', 'eslint/no-implied-eval': 'error',",
    );
    assert.notEqual(withImplied, config);
    writeFileSync(join(dir, 'vite.config.ts'), withImplied);
    for (const name of names) writeFileSync(join(leaf, name), "export const clean = JSON.parse('{}');\n");
    writeFileSync(join(leaf, names[0]), "setTimeout('inert()', 1);\n");
    const implied = run();
    assert.equal(implied.status, 0, implied.stderr + implied.stdout);
    assert.ok(!JSON.parse(implied.stdout).diagnostics.some((d) => d.code.includes('implied-eval')));
    writeFileSync(join(dir, 'vite.config.ts'), config);
    writeFileSync(join(leaf, names[0]), "export const clean = JSON.parse('{}');\n");
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr + clean.stdout);
    assert.equal(JSON.parse(clean.stdout).number_of_files, names.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G7 group 15: build-first flagged script is integrated into verify and strict benchmark scope', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['test:failure-attribution'],
    'npm run build && node --experimental-strip-types --disallow-code-generation-from-strings --test "benchmarks/failure-attribution/*.test.ts"',
  );
  assert.ok(pkg.scripts.verify.split(' && ').includes('npm run test:failure-attribution'));
  assert.ok(
    JSON.parse(readFileSync(join(root, 'tsconfig.benchmarks.json'), 'utf8')).include.includes(
      'benchmarks/failure-attribution/**/*.ts',
    ),
  );
});

test('G7 group 13: string-compilation prohibition propagates to Node test children', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const dir = mkdtempSync(join(tmpdir(), 'g7-runtime-'));
  const args = [
    '--experimental-strip-types',
    '--test',
    '--test-name-pattern=13:',
    'benchmarks/failure-attribution/imports.test.ts',
  ];
  function run(flags) {
    const path = join(dir, 'child-output.txt');
    const fd = openSync(path, 'w');
    try {
      // Regular descriptors also work on hosts that prohibit child pipe sizing.
      const result = spawnSync(process.execPath, flags, { cwd: root, env, stdio: ['ignore', fd, fd] });
      assert.equal(result.error, undefined);
      return { status: result.status, output: readFileSync(path, 'utf8') };
    } finally {
      closeSync(fd);
    }
  }
  try {
    const direct = run(args.filter((arg) => arg !== '--test'));
    assert.equal(direct.status, 1, direct.output);
    assert.match(direct.output, /Missing expected exception \(EvalError\)/);
    const unflagged = run(args);
    assert.equal(unflagged.status, 1, unflagged.output);
    const flagged = run(['--disallow-code-generation-from-strings', ...args]);
    assert.equal(flagged.status, 0, flagged.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
