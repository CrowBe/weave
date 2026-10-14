/** Continue with ChatGPT. Run locally where the browser can reach 127.0.0.1. */
import { createServer } from 'node:http';
import { createAuthorizationAttempt, buildAuthorizeUrl, handleCallback, ensureHostId, exchangeCode, ChatGPTAuthError } from '@weave/auth-chatgpt';
import { FileCredentialStore } from '@weave/auth-chatgpt/file-store';
import { cliOptions, withCredentialLock } from './chatgpt-local.ts';

async function main() {
  const options = cliOptions(true);
  const port = Number(options.port);
  const timeout = Number(options['timeout-ms']);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) {
    throw new Error('Use --port 1..65535 and a positive --timeout-ms no greater than 2147483647.');
  }
  const path = options.credentials!;
  await withCredentialLock(path, async () => {
    const store = new FileCredentialStore(path);
    const hostId = await ensureHostId(store);
    const saved = await store.load();
    const credentials = saved?.credentials ?? saved?.registration;
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    try {
      // Start listening before creating the attempt or disclosing its authorize URL.
      const attempt = createAuthorizationAttempt({ port, hostId, ...(credentials ? { clientId: credentials.client_id, ...(credentials.subject !== undefined ? { subject: credentials.subject } : {}) } : {}) });
      const callback = await new Promise<ReturnType<typeof handleCallback>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sign-in timed out.')), timeout);
        server.once('error', error => { clearTimeout(timer); reject(error); });
        server.on('request', (request, response) => {
          if (request.method !== 'GET' || !request.url?.startsWith('/auth/callback?')) { response.writeHead(404).end(); return; }
          try {
            const result = handleCallback(`http://127.0.0.1:${port}${request.url}`, attempt);
            clearTimeout(timer);
            response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Callback received. Return to Weave for sign-in status.');
            resolve(result);
          } catch {
            clearTimeout(timer);
            response.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Sign-in callback rejected.');
            reject(new Error('Sign-in callback rejected; start a fresh attempt.'));
          }
        });
        console.log('Continue with ChatGPT:');
        console.log(buildAuthorizeUrl(attempt));
      });
      await store.save({ ext_agent_host_id: hostId, ...(saved?.credentials ? { credentials: saved.credentials } : {}), registration: { client_id: callback.clientId, ...(attempt.subject !== undefined ? { subject: attempt.subject } : {}) } });
      const record = await exchangeCode(attempt, callback, { fetch, clock: { now: () => Date.now() } });
      await store.save({ ext_agent_host_id: hostId, credentials: record, registration: { client_id: record.client_id, subject: record.subject } });
      console.log(JSON.stringify({ account: record.email ?? record.subject, client_id: record.client_id, scopes: record.scopes, status: record.plan_usage }));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
main().catch(error => {
  const fixedMessages = new Set([
    'Sign-in timed out.',
    'Sign-in callback rejected; start a fresh attempt.',
    'Credential store in use; close the other command (or remove a stale .lock after confirming it stopped).',
  ]);
  if (error instanceof ChatGPTAuthError) console.error(`Sign-in failed: ${error.code}${error.status !== undefined ? ` (HTTP ${error.status})` : ''}`);
  else if (error instanceof Error && fixedMessages.has(error.message)) console.error(error.message);
  else console.error('Sign-in failed. Check the callback listener, network, and credential-file access, then retry.');
  process.exitCode = 1;
});
