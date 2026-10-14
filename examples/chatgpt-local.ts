/** Local CLI composition only: no package imports this file. */
import { open, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

export function cliOptions(signin: boolean): { credentials: string; port?: string; 'timeout-ms'?: string; out?: string } {
  return parseArgs({ options: {
    credentials: { type: 'string', default: join(homedir(), '.config', 'weave', 'chatgpt.json') },
    ...(signin ? { port: { type: 'string' as const, default: '1455' }, 'timeout-ms': { type: 'string' as const, default: '600000' } } : { out: { type: 'string' as const } }),
  } }).values as { credentials: string; port?: string; 'timeout-ms'?: string; out?: string };
}

/** Fail closed on contention (including stale locks); never race rotating refresh tokens. */
export async function withCredentialLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch { throw new Error('Credential store in use; close the other command (or remove a stale .lock after confirming it stopped).'); }
  try { return await run(); }
  finally { await handle.close(); await unlink(lock); }
}

export function redactTokens(body: string, tokens: readonly (string | undefined)[]): string {
  let result = body;
  for (const token of tokens.filter((token): token is string => typeof token === 'string' && token.length > 0).sort((a, b) => b.length - a.length)) {
    for (const value of [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)]) {
      result = result.split(value).join('[REDACTED]');
    }
  }
  return result;
}
