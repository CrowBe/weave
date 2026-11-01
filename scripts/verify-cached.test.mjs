import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('verify requires formatting before the remaining checks', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(scripts.verify.split(' && ')[0], 'npm run fmt:check');
});

test('verify fails at the format step for malformed source or a missing formatter', (t) => {
  if (process.platform === 'win32') {
    t.skip('format-failure isolation requires POSIX symlinks and /bin/sh');
    return;
  }
  if (!existsSync('/bin/sh')) {
    t.skip('format-failure isolation requires /bin/sh');
    return;
  }

  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_(loglevel|silent)$/i.test(key)) delete env[key];
  }
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const installed of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'weave-verify-format-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, 'node'));
      // verify invokes npm again, so expose only node and the selected npm CLI.
      symlinkSync(npmCli, join(bin, 'npm'));
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ private: true, type: 'module', scripts }, null, 2) + '\n',
      );
      writeFileSync(join(dir, 'vite.config.ts'), readFileSync(join(root, 'vite.config.ts'), 'utf8'));
      if (installed) {
        symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
        writeFileSync(join(dir, 'malformed.js'), 'const value={a:1,b:2}\n');
      }
      const log = join(dir, 'output');
      const fd = openSync(log, 'w');
      let result;
      try {
        result = spawnSync(process.execPath, [npmCli, 'run', 'verify'], {
          cwd: dir,
          stdio: ['ignore', fd, fd],
          env: {
            ...env,
            // Keep node/npm available without inheriting local or global formatters.
            PATH: bin,
            // npm otherwise resolves its default POSIX shell by name on PATH.
            npm_config_script_shell: '/bin/sh',
            npm_config_loglevel: 'notice',
          },
        });
      } finally {
        closeSync(fd);
      }
      assert.ifError(result.error);
      const output = readFileSync(log, 'utf8');
      assert.notEqual(result.status, 0, output);
      assert.match(output, /> fmt:check\n> vp fmt --check/);
      assert.doesNotMatch(output, /> check\n/);
      assert.match(output, installed ? /malformed\.js/ : /vp: (?:not found|command not found)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('verify cache rejects formatting-only changes to root and docs Markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-verify-cache-format-'));
  try {
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'cache-format-regression',
          private: true,
          type: 'module',
          scripts: { verify: 'npm run fmt:check', 'fmt:check': 'vp fmt --check' },
        },
        null,
        2,
      ) + '\n',
    );
    const config = readFileSync(join(root, 'vite.config.ts'), 'utf8').replace(
      "output: ['packages/*/dist/**']",
      'output: []',
    );
    writeFileSync(join(dir, 'vite.config.ts'), config);
    mkdirSync(join(dir, 'docs'));
    const files = ['README.md', 'docs/guide.md'];
    const formatted = '# Heading\n\n- item\n';
    for (const file of files) writeFileSync(join(dir, file), formatted);
    const run = () =>
      spawnSync(join(root, 'node_modules', '.bin', 'vp'), ['run', 'verify-cached'], { cwd: dir, encoding: 'utf8' });
    for (let i = 0; i < 2; i += 1) {
      const result = run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    for (const file of files) {
      writeFileSync(join(dir, file), '# Heading\n\n-   item\n');
      const result = run();
      assert.notEqual(result.status, 0, `formatting change in ${file} replayed a cached pass: ${result.stdout}`);
      assert.match(result.stdout + result.stderr, /Format issues found/);
      writeFileSync(join(dir, file), formatted);
      const restored = run();
      assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'verify.yml'), 'name: original\n');
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
    writeFileSync(join(dir, '.github', 'workflows', 'verify.yml'), 'name: changed\n');
    assert.equal(run(), 'run\nrun\nrun\n');
    assert.equal(run(), 'run\nrun\nrun\n');
    writeFileSync(join(dir, '.npmrc'), 'fund=true\n');
    assert.equal(run(), 'run\nrun\nrun\nrun\n');
    writeFileSync(join(dir, '.tool-versions'), 'nodejs 22.18.0\n');
    assert.equal(run(), 'run\nrun\nrun\nrun\nrun\n');
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

test('interrupted verify cache tasks are not cached as successful', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process-group signals are unavailable on Windows');
    return;
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const dir = mkdtempSync(join(tmpdir(), `weave-verify-cache-${signal.toLowerCase()}-`));
    let child;
    let closed;
    try {
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
      writeFileSync(join(dir, 'package.json'), '{"name":"cache-interrupt-regression","private":true,"type":"module"}');
      const config = readFileSync(join(root, 'vite.config.ts'), 'utf8')
        .replace("command: 'npm run verify'", "command: 'node task.mjs'")
        .replace("output: ['packages/*/dist/**']", 'output: []');
      writeFileSync(join(dir, 'vite.config.ts'), config);
      writeFileSync(
        join(dir, 'task.mjs'),
        `
        import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
        appendFileSync('runs', 'run\\n');
        if (!existsSync('started')) {
          writeFileSync('started', 'yes');
          process.once('SIGINT', () => process.exit(1));
          process.once('SIGTERM', () => process.exit(1));
          setInterval(() => {}, 1000);
        }
      `,
      );
      child = spawn(join(root, 'node_modules', '.bin', 'vp'), ['run', 'verify-cached'], {
        cwd: dir,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      closed = waitForClose(child);
      await waitForFile(join(dir, 'started'));
      process.kill(-child.pid, signal);
      const result = await closed;
      child = undefined;
      assert.notEqual(result.code, 0, `${signal} unexpectedly completed successfully: ${result.output}`);

      const rerun = spawnSync(join(root, 'node_modules', '.bin', 'vp'), ['run', 'verify-cached'], {
        cwd: dir,
        encoding: 'utf8',
      });
      assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
      assert.equal(readFileSync(join(dir, 'runs'), 'utf8'), 'run\nrun\n');
      const cached = spawnSync(join(root, 'node_modules', '.bin', 'vp'), ['run', 'verify-cached'], {
        cwd: dir,
        encoding: 'utf8',
      });
      assert.equal(cached.status, 0, cached.stdout + cached.stderr);
      assert.equal(readFileSync(join(dir, 'runs'), 'utf8'), 'run\nrun\n');
    } finally {
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
        await closed?.catch(() => {});
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('concurrent verify cache writers leave a reusable cache entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-verify-cache-concurrent-'));
  try {
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"name":"cache-concurrent-regression","private":true,"type":"module"}');
    const config = readFileSync(join(root, 'vite.config.ts'), 'utf8')
      .replace("command: 'npm run verify'", "command: 'node task.mjs'")
      .replace("output: ['packages/*/dist/**']", 'output: []');
    writeFileSync(join(dir, 'vite.config.ts'), config);
    writeFileSync(
      join(dir, 'task.mjs'),
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync('runs', 'run\\n');
      await new Promise((resolve) => setTimeout(resolve, 250));
    `,
    );

    const first = spawn(join(root, 'node_modules', '.bin', 'vp'), ['run', 'verify-cached'], {
      cwd: dir,
      stdio: 'pipe',
    });
    const second = spawn(join(root, 'node_modules', '.bin', 'vp'), ['run', 'verify-cached'], {
      cwd: dir,
      stdio: 'pipe',
    });
    const results = await Promise.all([waitForClose(first), waitForClose(second)]);
    for (const result of results) assert.equal(result.code, 0, result.output);

    const runsBeforeHit = existsSync(join(dir, 'runs')) ? readFileSync(join(dir, 'runs'), 'utf8') : '';
    assert.ok(runsBeforeHit.length > 0, 'at least one concurrent task should execute');
    const cached = spawnSync(join(root, 'node_modules', '.bin', 'vp'), ['run', 'verify-cached'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(cached.status, 0, cached.stdout + cached.stderr);
    assert.equal(readFileSync(join(dir, 'runs'), 'utf8'), runsBeforeHit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function waitForFile(path, timeoutMs = 10_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}
