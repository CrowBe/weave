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
  /** Evidence that spawn succeeded, before any execution result or host bookkeeping. */
  readonly onStarted: (pgid: number | undefined) => void;
}

export interface ProcessRunSuccess {
  readonly ok: true;
  readonly exit: number;
  readonly stdout_truncated: boolean;
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

  // The direct child's 'exit' decides the outcome; a descendant holding the pipes
  // must not turn a finished run into a timeout. 'error' covers a spawn that never
  // becomes a process (ENOENT, EACCES): it arrives without 'exit'.
  const exited = new Promise<ExitInfo>((resolveExit) => {
    child.on('error', () => resolveExit({ code: null, signal: null, failed: true }));
    child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal, failed: false }));
  });
  // 'close' means every stdio pipe reached end-of-file, so the tails hold the last writes.
  const closed = new Promise<void>((resolveClose) => {
    child.once('close', () => resolveClose());
  });

  // A timer racing an ENOENT must not turn a genuine spawn failure into a
  // timeout. Only the spawn event establishes that a process began execution.
  const spawned = await new Promise<boolean>((resolveSpawn) => {
    child.once('spawn', () => resolveSpawn(true));
    child.once('error', () => resolveSpawn(false));
  });
  if (!spawned) {
    return failed('spawn_failed', stdout.value(), stderr.value(), started, request.clock);
  }

  const stop = new AbortController();
  const abort = (): void => {
    stop.abort();
  };
  if (request.signal.aborted) {
    stop.abort();
  } else {
    request.signal.addEventListener('abort', abort, { once: true });
  }

  try {
    request.onStarted(process.platform === 'win32' ? undefined : child.pid);
    const timed = request.timer.sleep(request.timeout_ms, stop.signal).then(
      () => 'timeout' as const,
      () => (request.signal.aborted ? ('cancelled' as const) : ('execution_fault' as const)),
    );
    const winner = await Promise.race([
      exited.then((info) => ({ kind: 'exit' as const, info })),
      timed.then((kind) => ({ kind })),
    ]);
    stop.abort();

    if (winner.kind === 'exit') {
      // Pipes still open after the bounded drain mean a descendant holds them: terminate it as on timeout.
      const drained = (await ended(closed, request.timer)) || (await terminate(child, closed, request.timer));
      if (winner.info.failed || winner.info.code === null) {
        return failed(
          winner.info.failed ? 'execution_fault' : 'killed',
          stdout.value(),
          stderr.value(),
          started,
          request.clock,
        );
      }
      return {
        ok: true,
        exit: winner.info.code,
        // Detached before end-of-file: stdout may be incomplete, so it is not reported as whole.
        stdout_truncated: stdout.truncated || !drained,
        stdout_tail: stdout.value(),
        stderr_tail: stderr.value(),
        duration_ms: elapsed(started, request.clock),
      };
    }

    await terminate(child, closed, request.timer);
    return failed(winner.kind, stdout.value(), stderr.value(), started, request.clock);
  } catch {
    // A port or execution fault after spawn must still terminate the child and
    // cannot be described as a failure to spawn.
    await terminate(child, closed, request.timer).catch(() => undefined);
    return failed('execution_fault', stdout.value(), stderr.value(), started, request.clock);
  } finally {
    stop.abort();
    request.signal.removeEventListener('abort', abort);
  }
}

const KILL_GRACE_MS = 30;
const DRAIN_MS = 100;

/** Whether stdio reaches end-of-file within the bounded drain. */
async function ended(closed: Promise<void>, timer: ShellTimer): Promise<boolean> {
  const drain = new AbortController();
  try {
    return await Promise.race([
      closed.then(() => true),
      timer.sleep(DRAIN_MS, drain.signal).then(
        () => false,
        () => false,
      ),
    ]);
  } finally {
    drain.abort();
  }
}

/**
 * Signals the process group (SIGTERM, then SIGKILL), waits the bounded drain,
 * and detaches from the pipes. Returns whether stdio reached end-of-file.
 */
async function terminate(child: ChildProcess, closed: Promise<void>, timer: ShellTimer): Promise<boolean> {
  kill(child, 'SIGTERM');
  try {
    await timer.sleep(KILL_GRACE_MS);
  } catch {
    /* Still send SIGKILL if the timer faults. */
  }
  kill(child, 'SIGKILL');
  let drained = false;
  try {
    drained = await ended(closed, timer);
  } catch {
    /* Pipe cleanup is required even if the timer faults. */
  }
  // A descendant that left the process group is not signalled and can keep inherited pipes open.
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  return drained;
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
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (chunk.length > this.limit) this.truncated = true;
    const slice = chunk.length > this.limit ? chunk.subarray(chunk.length - this.limit) : chunk;
    this.text += slice.toString('utf8');
    if (this.text.length > this.limit) {
      this.truncated = true;
      this.text = this.text.slice(this.text.length - this.limit);
    }
  }

  value(): string {
    return this.text;
  }
}
