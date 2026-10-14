/**
 * Direct process spawn for shell.run. There is no shell interpolation:
 * argv[0] is the executable and the rest are arguments. The environment
 * object passed here is the whole environment of the child.
 *
 * Time comes from the injected clock and timer. This file does not read
 * the wall clock, arm a timer itself, or read the process environment.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, type Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { SHELL_MAX_ARTIFACTS, type ShellClock, type ShellFailure, type ShellTimer } from './shell.js';

export interface ProcessRunRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly timeout_ms: number;
  readonly signal: AbortSignal;
  readonly clock: ShellClock;
  readonly timer: ShellTimer;
  readonly tail_chars: number;
}

export interface ProcessRunSuccess {
  readonly ok: true;
  readonly exit: number;
  readonly stdout_tail: string;
  readonly stderr_tail: string;
  readonly duration_ms: number;
}

export interface ProcessRunFailure {
  readonly ok: false;
  readonly failure: ShellFailure;
  readonly stdout_tail: string;
  readonly stderr_tail: string;
  readonly duration_ms: number;
}

export type ProcessRunResult = ProcessRunSuccess | ProcessRunFailure;

interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failed: boolean;
}

export async function runProcess(request: ProcessRunRequest): Promise<ProcessRunResult> {
  const started = request.clock.now();
  if (request.signal.aborted) {
    return failed('cancelled', '', '', started, request.clock);
  }
  const file = request.argv[0];
  if (file === undefined) {
    return failed('spawn_failed', '', '', started, request.clock);
  }

  let child: ChildProcess;
  try {
    child = spawn(file, request.argv.slice(1), {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch {
    return failed('spawn_failed', '', '', started, request.clock);
  }

  const stdout = new Tail(request.tail_chars);
  const stderr = new Tail(request.tail_chars);
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin?.on('error', () => undefined);
  try {
    child.stdin?.end(request.stdin);
  } catch {
    // The child may already have exited. The exit status still decides the outcome.
  }

  const exited = new Promise<ExitInfo>((resolveExit) => {
    let settled = false;
    let failed = false;
    let closed: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const finish = (info: ExitInfo): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolveExit(info);
    };
    // 'close' waits until stdio ends, so the tail includes the child's last write.
    // 'error' covers a spawn that never becomes a process (ENOENT). It can arrive
    // before or without 'close'.
    child.once('error', () => {
      failed = true;
      queueMicrotask(() => finish(closed ? { ...closed, failed: true } : { code: null, signal: null, failed: true }));
    });
    child.once('close', (code, exitSignal) => {
      closed = { code, signal: exitSignal };
      if (!failed) {
        finish({ code, signal: exitSignal, failed: false });
      }
    });
  });

  const stop = new AbortController();
  if (request.signal.aborted) {
    stop.abort();
  } else {
    request.signal.addEventListener('abort', () => stop.abort(), { once: true });
  }

  const timed = request.timer.sleep(request.timeout_ms, stop.signal).then(
    () => 'timeout' as const,
    () => (request.signal.aborted ? 'cancelled' as const : 'stopped' as const),
  );
  const winner = await Promise.race([
    exited.then((info) => ({ kind: 'exit' as const, info })),
    timed.then((kind) => ({ kind })),
  ]);
  stop.abort();

  if (winner.kind === 'exit') {
    if (winner.info.failed || winner.info.code === null) {
      return failed('spawn_failed', stdout.value(), stderr.value(), started, request.clock);
    }
    return {
      ok: true,
      exit: winner.info.code,
      stdout_tail: stdout.value(),
      stderr_tail: stderr.value(),
      duration_ms: elapsed(started, request.clock),
    };
  }

  kill(child, 'SIGTERM');
  await request.timer.sleep(30).catch(() => undefined);
  kill(child, 'SIGKILL');
  const drain = new AbortController();
  try {
    await Promise.race([exited, request.timer.sleep(100, drain.signal).catch(() => undefined)]);
  } finally {
    drain.abort();
    // A descendant can escape the process group and retain inherited pipes.
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  return failed(winner.kind === 'cancelled' ? 'cancelled' : 'timeout', stdout.value(), stderr.value(), started, request.clock);
}

export function snapshotFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 2 || found.length >= 500) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), childRel, depth + 1);
      } else if (entry.isFile()) {
        found.push(childRel);
      }
    }
  };
  walk(root, '', 0);
  found.sort();
  return found;
}

/** Relative paths that appeared after the run, still inside `root`. */
export function newFilesInside(root: string, before: readonly string[], after: readonly string[]): string[] {
  const prior = new Set(before);
  const rootResolved = resolve(root);
  const created: string[] = [];
  for (const rel of after) {
    if (prior.has(rel) || created.length >= SHELL_MAX_ARTIFACTS) {
      continue;
    }
    const full = resolve(root, rel);
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
      continue;
    }
    created.push(rel);
  }
  return created;
}

function failed(
  failure: ShellFailure,
  stdout: string,
  stderr: string,
  started: number,
  clock: ShellClock,
): ProcessRunFailure {
  return {
    ok: false,
    failure,
    stdout_tail: stdout,
    stderr_tail: stderr,
    duration_ms: elapsed(started, clock),
  };
}

function elapsed(started: number, clock: ShellClock): number {
  return Math.max(0, clock.now() - started);
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Already gone; the post-kill stdio wait is bounded.
  }
}

class Tail {
  private text = '';

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const slice = chunk.length > this.limit ? chunk.subarray(chunk.length - this.limit) : chunk;
    this.text += slice.toString('utf8');
    if (this.text.length > this.limit) {
      this.text = this.text.slice(this.text.length - this.limit);
    }
  }

  value(): string {
    return this.text;
  }
}
