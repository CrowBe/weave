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

/** The CPU budget advertised in the isolation report (`limits.cpu_ms`). */
const CPU_LIMIT_MS = 100;
/**
 * vm's `timeout` is a wall-clock watchdog, so on its own it cannot enforce a
 * CPU budget: a busy machine can deschedule a trivial script past 100ms. It is
 * kept only as a backstop that interrupts runaway code; the budget itself is
 * checked against the CPU time this thread actually spent.
 */
const WALL_BACKSTOP_MS = 2_000;

function cpuMicros(): number {
  // threadCpuUsage (Node >= 23.9) excludes GC and other helper threads.
  const usage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return usage.user + usage.system;
}

/** Run a script under the CPU budget. A spent budget throws, as a vm timeout does. */
function runBudgeted(script: vm.Script, context: vm.Context): unknown {
  const before = cpuMicros();
  let output: unknown;
  let failure: { error: unknown } | null = null;
  try {
    output = script.runInContext(context, { timeout: WALL_BACKSTOP_MS });
  } catch (error) {
    failure = { error };
  }
  if ((cpuMicros() - before) / 1000 > CPU_LIMIT_MS) {
    throw new Error(`Script execution exceeded the ${CPU_LIMIT_MS}ms CPU budget`);
  }
  if (failure) {
    throw failure.error;
  }
  return output;
}

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
  const evaluated = runBudgeted(
    new vm.Script('({ process: typeof process, require: typeof require, fetch: typeof fetch })'),
    sandbox(),
  ) as { process: string; require: string; fetch: string };
  return {
    filesystem,
    network,
    child_process: childProcess,
    canary: process.env['WEAVE_ISOLATION_CANARY'] ?? null,
    vm: evaluated,
  };
}

function runBatch(
  source: string,
  cases: readonly { readonly id: string; readonly input: unknown }[],
): { results: unknown[] } {
  const results: unknown[] = [];
  for (const testCase of cases) {
    try {
      const literal = JSON.stringify(JSON.stringify(testCase.input));
      const script = new vm.Script(
        `"use strict"; (function () {\nconst input = JSON.parse(${literal});\n${source}\n})()`,
      );
      const output = runBudgeted(script, sandbox());
      results.push({ id: testCase.id, output });
    } catch (error) {
      results.push({ id: testCase.id, error: error instanceof Error ? error.name : 'Error' });
    }
  }
  return { results };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
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
