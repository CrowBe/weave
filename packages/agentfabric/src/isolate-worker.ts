/**
 * Child entry for untrusted corpus and implementation runs.
 *
 * The parent spawns this file under Node's permission model with no
 * credentials and no filesystem or child-process grant. User source runs in a
 * vm context that cannot compile new strings. This file is trusted runner
 * code; generated source arrives only as an IPC message.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

interface ProbeMessage {
  readonly type: 'probe';
}

interface BatchMessage {
  readonly type: 'batch';
  readonly source: string;
  readonly cases: readonly { readonly id: string; readonly input: unknown }[];
}

interface SilentExitMessage {
  readonly type: 'silent-exit';
}

type Inbound = ProbeMessage | BatchMessage | SilentExitMessage;

const GLOBALS = ['Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Error'] as const;

function send(message: unknown, done: () => void): void {
  if (!process.send) {
    throw new Error('isolate worker requires ipc');
  }
  process.send(message, done);
}

function sandbox(): vm.Context {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  const target = context as Record<string, unknown>;
  for (const name of GLOBALS) {
    target[name] = globalThis[name];
  }
  target['broker'] = {
    read: () => ({ ok: false, code: 'DENIED' }),
    write: () => ({ ok: false, code: 'DENIED' }),
    invoke: () => ({ ok: false, code: 'DENIED' }),
  };
  return context;
}

function probe(): Record<string, unknown> {
  let filesystem: 'blocked' | 'open' | 'error' = 'error';
  try {
    readFileSync('/etc/hostname', 'utf8');
    filesystem = 'open';
  } catch (error) {
    filesystem = codeOf(error) === 'ERR_ACCESS_DENIED' ? 'blocked' : 'error';
  }
  let childProcess: 'blocked' | 'open' | 'error' = 'error';
  try {
    spawn(process.execPath, ['-e', '0']);
    childProcess = 'open';
  } catch (error) {
    childProcess = codeOf(error) === 'ERR_ACCESS_DENIED' ? 'blocked' : 'error';
  }
  const permission = process.permission;
  const network: 'none' | 'open' | 'error' = permission ? (permission.has('net') ? 'open' : 'none') : 'error';
  const evaluated = new vm.Script('({ process: typeof process, require: typeof require, fetch: typeof fetch })').runInContext(
    sandbox(),
    { timeout: 100 },
  ) as { process: string; require: string; fetch: string };
  return {
    filesystem,
    network,
    child_process: childProcess,
    canary: process.env['WEAVE_ISOLATION_CANARY'] ?? null,
    vm: evaluated,
  };
}

function runBatch(source: string, cases: readonly { readonly id: string; readonly input: unknown }[]): { results: unknown[] } {
  const results: unknown[] = [];
  for (const testCase of cases) {
    try {
      const literal = JSON.stringify(JSON.stringify(testCase.input));
      const script = new vm.Script(`"use strict"; (function () {\nconst input = JSON.parse(${literal});\n${source}\n})()`);
      const output = script.runInContext(sandbox(), { timeout: 100 });
      results.push({ id: testCase.id, output });
    } catch (error) {
      results.push({ id: testCase.id, error: error instanceof Error ? error.name : 'Error' });
    }
  }
  return { results };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

process.on('message', (message: Inbound) => {
  if (message.type === 'silent-exit') {
    process.exit(0);
  }
  try {
    const result = message.type === 'probe' ? probe() : runBatch(message.source, message.cases);
    send({ ok: true, result }, () => process.exit(0));
  } catch (error) {
    send({ ok: false, error: error instanceof Error ? error.name : 'Error' }, () => process.exit(1));
  }
});
