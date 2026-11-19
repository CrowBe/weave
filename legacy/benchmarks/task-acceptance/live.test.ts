/**
 * Caller-level tests for the live comparison's composition root.
 *
 * Only the skip paths are spawned: a run would call the hosted Jev route, and
 * no test here may reach a provider. Planning is pure, so the run path is
 * asserted on `planLive` with an injected environment instead.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planLive } from './live.ts';

const exists = (path: string) => path === 'transcript.json';
const argv = ['--transcript', 'transcript.json'];

test('TYPESAFE_API_KEY alone configures the live Jev route, trimmed', () => {
  assert.deepEqual(planLive(argv, { TYPESAFE_API_KEY: ' preferred ' }, exists), {
    status: 'run',
    transcriptPath: 'transcript.json',
    apiKey: 'preferred',
  });
});

test('the legacy TYPESAFE_AI_API_KEY still configures it, and the preferred name wins', () => {
  assert.deepEqual(planLive(argv, { TYPESAFE_AI_API_KEY: 'legacy' }, exists), {
    status: 'run',
    transcriptPath: 'transcript.json',
    apiKey: 'legacy',
  });
  assert.deepEqual(planLive(argv, { TYPESAFE_API_KEY: 'preferred', TYPESAFE_AI_API_KEY: 'legacy' }, exists), {
    status: 'run',
    transcriptPath: 'transcript.json',
    apiKey: 'preferred',
  });
});

test('a missing or blank key, or a missing transcript, skips; a skip is not a pass', () => {
  for (const env of [{}, { TYPESAFE_API_KEY: '  ' }, { AI_GATEWAY_API_KEY: 'gateway-only' }]) {
    assert.deepEqual(planLive(argv, env, exists), { status: 'skip', reason: 'jev route not configured' });
  }
  for (const args of [[], ['--transcript'], ['--transcript', 'absent.json']]) {
    assert.deepEqual(planLive(args, { TYPESAFE_API_KEY: 'k' }, exists), {
      status: 'skip',
      reason: 'agent transcript missing',
    });
  }
});

test('the script itself treats TYPESAFE_API_KEY alone as configured and reports each skip', () => {
  const script = fileURLToPath(new URL('./live.ts', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'live-acceptance-'));
  try {
    const transcript = join(dir, 'transcript.json');
    writeFileSync(transcript, '{}');
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['TYPESAFE_API_KEY'];
    delete env['TYPESAFE_AI_API_KEY'];
    delete env['NODE_TEST_CONTEXT'];
    const run = (args: string[], extra: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], {
        env: { ...env, ...extra },
        encoding: 'utf8',
      });
    const unconfigured = run(['--transcript', transcript], {});
    assert.equal(unconfigured.status, 0, unconfigured.stderr);
    assert.equal(JSON.parse(unconfigured.stdout).reason, 'jev route not configured');
    const missing = run([], { TYPESAFE_API_KEY: 'LIVE_KEY_CANARY' });
    assert.equal(missing.status, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      status: 'skip',
      reason: 'agent transcript missing',
      live_comparison: 'skip',
    });
    // The preferred key alone gets past planning. The invalid transcript then
    // stops the run before any gateway exists, so nothing is dispatched.
    const configured = run(['--transcript', transcript], { TYPESAFE_API_KEY: 'LIVE_KEY_CANARY' });
    assert.notEqual(configured.status, 0);
    assert.equal(configured.stdout, '');
    assert.match(configured.stderr, /transcript requires an agent name/);
    assert.ok(!configured.stderr.includes('LIVE_KEY_CANARY'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
