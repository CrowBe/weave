/**
 * Red and green fixtures for the repository checks that encode recurring
 * review findings (#203). Each check runs as a child process against a fixture
 * root, exactly as `npm run check` runs it against the repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checks = fileURLToPath(new URL('..', import.meta.url));

function run(check, fixture) {
  const result = spawnSync(process.execPath, [`${checks}${check}.mjs`, `${checks}fixtures/${check}/${fixture}`], {
    encoding: 'utf8',
  });
  const findings = result.stderr
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim());
  return { status: result.status, findings, stdout: result.stdout };
}

test('no-ambient-env is red on package source that reads the environment', () => {
  const { status, findings } = run('no-ambient-env', 'red');
  assert.equal(status, 1);
  assert.deepEqual(findings, [
    "packages/demo/src/config.ts:2: env imported from 'node:process'",
    'packages/demo/src/config.ts:4: process.env',
    'packages/demo/src/config.ts:5: process.env',
    'packages/demo/src/config.ts:6: process.env',
    'packages/demo/src/destructured.ts:2: env destructured from process',
    "packages/demo/src/multiline.ts:2: env imported from 'node:process'",
    'packages/demo/src/multiline.ts:5: env destructured from process',
    'packages/demo/src/template.ts:4: process.env',
    'packages/demo/src/template.ts:6: process.env',
  ]);
});

test('no-ambient-env is green when configuration is passed in and only tests read the environment', () => {
  const { status, findings, stdout } = run('no-ambient-env', 'green');
  assert.deepEqual(findings, []);
  assert.equal(status, 0);
  assert.match(stdout, /in 2 package source files/);
});

test('no-swallowed-failures is red on scripts and CI steps that cannot fail', () => {
  const { status, findings } = run('no-swallowed-failures', 'red');
  assert.equal(status, 1);
  assert.deepEqual(findings, [
    'package.json: script "lint:report" swallows its failure: vp lint || true',
    'package.json: script "fmt:report" swallows its failure: vp fmt --check || exit 0',
    'package.json: script "check" swallows its failure: node checks/a.mjs || : && node checks/b.mjs',
    'packages/demo/package.json: script "test" swallows its failure: node --test || true',
    '.github/workflows/ci.yml:11: step sets continue-on-error: true (npm run lint)',
    '.github/workflows/ci.yml:13: step sets continue-on-error: true (npm run audit)',
    '.github/workflows/ci.yml:17: command swallows its failure: npm run docs || true',
    '.github/workflows/ci.yml:18: command swallows its failure: npm run lint || true',
    '.github/workflows/ci.yml:19: command swallows its failure: npm run check || exit 0',
    '.github/workflows/ci.yml:22: job sets continue-on-error: true',
  ]);
});

test('no-swallowed-failures is green when every script and step gates, including || fallbacks', () => {
  const { status, findings } = run('no-swallowed-failures', 'green');
  assert.deepEqual(findings, []);
  assert.equal(status, 0);
});
