import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('verify cache ignores removed Python cache directories but tracks source changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-verify-cache-'));
  try {
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"name":"cache-regression","private":true,"type":"module"}');
    const config = readFileSync(join(root, 'vite.config.ts'), 'utf8')
      .replace("command: 'npm run verify'", "command: 'node task.mjs'")
      .replace("output: ['packages/*/dist/**']", 'output: []');
    writeFileSync(join(dir, 'vite.config.ts'), config);
    writeFileSync(join(dir, 'task.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync('runs', 'run\\n');`);
    mkdirSync(join(dir, 'benchmarks', '__pycache__'), { recursive: true });
    writeFileSync(join(dir, 'benchmarks', '__pycache__', 'probe.pyc'), 'ignored');
    writeFileSync(join(dir, 'benchmarks', 'probe.py'), '# source\n');
    const run = () => {
      const result = spawnSync(join(root, 'node_modules', '.bin', 'vp'), ['run', 'verify-cached'], {
        cwd: dir,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return readFileSync(join(dir, 'runs'), 'utf8');
    };
    assert.equal(run(), 'run\n');
    assert.equal(run(), 'run\n');
    rmSync(join(dir, 'benchmarks', '__pycache__'), { recursive: true });
    assert.equal(run(), 'run\n');
    writeFileSync(join(dir, 'benchmarks', 'probe.py'), '# changed source\n');
    assert.equal(run(), 'run\nrun\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CI runs lint and formatting as required gates', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(scripts.lint, 'vp lint');
  assert.equal(scripts['fmt:check'], 'vp fmt --check');
  assert.equal(scripts.fmt, 'vp fmt');
  const workflow = readFileSync(join(root, '.github/workflows/verify.yml'), 'utf8');
  assert.match(workflow, /run: npm run lint\n/);
  assert.match(workflow, /run: npm run fmt:check\n/);
  assert.doesNotMatch(workflow, /continue-on-error|\|\| true/);
});
