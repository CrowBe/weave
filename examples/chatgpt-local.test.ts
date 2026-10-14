import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
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


test('sign-in persists issued registration before exchange and reuses it after failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weave-signin-'));
  const path = join(dir, 'chatgpt.json');
  const original = { createServer: http.createServer, fetch, log: console.log, error: console.error, argv: process.argv, exitCode: process.exitCode };
  try {
    for (let run = 0; run < 2; run++) {
      const server = new EventEmitter();
      Object.assign(server, { listen: (_port: number, _host: string, ready: () => void) => ready(), closeAllConnections: () => {}, close: (done: () => void) => done() });
      http.createServer = (() => server) as typeof http.createServer;
      syncBuiltinESMExports();
      process.argv = ['node', 'chatgpt-signin.ts', '--credentials', path, '--port', '1455', '--timeout-ms', '5000'];
      const output: string[] = [];
      console.log = (...args) => {
        output.push(args.join(' '));
        if (typeof args[0] !== 'string' || !args[0].startsWith('https://auth.openai.com/')) return;
        const url = new URL(args[0]);
        assert.equal(url.searchParams.get('client_id'), run ? 'oaiapp_issued' : 'dynamic_agent_client');
        assert.equal(url.searchParams.has('agent_name_hint'), !run);
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'SECRET_CODE', ...(run ? {} : { client_id: 'oaiapp_issued' }) }).toString();
        const response = { writeHead() { return this; }, end() {} };
        server.emit('request', { method: 'GET', url: callback.pathname + callback.search }, response);
      };
      globalThis.fetch = async () => {
        assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).registration, { client_id: 'oaiapp_issued' });
        return new Response(JSON.stringify({ error: 'unauthorized_client', error_description: 'SECRET_BODY SECRET_CODE' }), { status: 403 });
      };
      let diagnostic = '';
      const finished = new Promise<void>(resolve => { console.error = message => { diagnostic = String(message); resolve(); }; });
      await import(`./chatgpt-signin.ts?registration-test=${run}`);
      await finished;
      assert.equal(diagnostic, 'Sign-in failed: unauthorized_client (HTTP 403)');
      assert.doesNotMatch(output.join(' ') + diagnostic, /SECRET/);
      assert.equal(process.exitCode, 1);
      process.exitCode = original.exitCode;
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).registration, { client_id: 'oaiapp_issued' });
    }
  } finally {
    http.createServer = original.createServer;
    syncBuiltinESMExports();
    globalThis.fetch = original.fetch;
    console.log = original.log;
    console.error = original.error;
    process.argv = original.argv;
    process.exitCode = original.exitCode;
    await rm(dir, { recursive: true, force: true });
  }
});
