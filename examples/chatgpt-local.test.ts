import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCredentialLock, redactTokens } from './chatgpt-local.ts';

test('credential lock excludes another process and releases after failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weave-cli-'));
  const path = join(dir, 'chatgpt.json');
  try {
    await withCredentialLock(path, async () => {
      await assert.rejects(withCredentialLock(path, async () => {}), /in use/);
    });
    await assert.rejects(withCredentialLock(path, async () => { throw new Error('test'); }), /test/);
    await withCredentialLock(path, async () => {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('probe diagnostics remove literal and JSON-escaped credential values', () => {
  assert.equal(redactTokens('token abc \\"x', ['abc', '\\"x']), 'token [REDACTED] [REDACTED]');
});
