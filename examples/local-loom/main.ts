/** Local development composition root. Provider credentials stay in this process. */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createLocalApi } from './api.ts';
import { localConfiguration } from './config.ts';
import { localTaskPorts } from './ports.ts';

const root = new URL('../../', import.meta.url);
const port = Number(process.env['LOOM_PORT'] ?? 5180);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('LOOM_PORT must be between 1024 and 65535.');
const origin = `http://127.0.0.1:${port}`;
const config = localConfiguration(process.env, root);
const api = createLocalApi({
  origin,
  status: config.status,
  createPorts: (evidence) =>
    localTaskPorts(
      config.gateway,
      {
        max_calls: 64,
        cost_ceiling: 1_000_000,
        per_call_ceiling: 250_000,
        deadline: Date.now() + 5 * 60_000,
        destinations: config.destinations,
      },
      () => Date.now(),
      evidence,
    ),
});

const server = createServer(async (incoming, outgoing) => {
  if (!incoming.url?.startsWith('/api/')) {
    vite.middlewares(incoming, outgoing);
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of incoming) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 100_000) {
        outgoing.writeHead(413);
        outgoing.end('Request too large');
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers))
      if (typeof value === 'string') headers.set(name, value);
    const response = await api.handle(
      new Request(`http://${incoming.headers.host}${incoming.url}`, {
        method: incoming.method ?? 'GET',
        headers,
        ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? {} : { body: Buffer.concat(chunks).toString('utf8') }),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch (error) {
    console.error('Local request failed:', error instanceof Error ? error.name : 'unknown failure');
    outgoing.writeHead(500, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'Local request failed. See server terminal.' }));
  }
});
const vite = await createViteServer({
  configFile: fileURLToPath(new URL('packages/tapestry-web/vite.config.ts', root)),
  server: { middlewareMode: true, hmr: { server }, fs: { allow: [fileURLToPath(root)] } },
  appType: 'spa',
});
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
  void vite.close();
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Loom local workspace: ${origin}`);
  for (const message of config.status.messages) console.log(`Configuration: ${message}`);
});
const shutdown = () => {
  api.stop();
  server.close();
  void vite.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
