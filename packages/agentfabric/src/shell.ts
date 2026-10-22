/**
 * Pure shell-run parsing, secret redaction, and trace records.
 * Process spawning lives in process-spawn.ts. Nothing here reads a clock,
 * the environment, or a locator.
 */

export const SHELL_TAIL_CHARS = 4096;
export const SHELL_MAX_ARGV = 32;
export const SHELL_MAX_ARG_CHARS = 4096;
export const SHELL_MAX_STDIN_CHARS = 1_000_000;
export const SHELL_MAX_TIMEOUT_MS = 600_000;
export const SHELL_MAX_ENV = 32;
export const SHELL_MAX_ARTIFACTS = 32;
/**
 * Every injected value is a secret. A shorter one cannot be redacted without
 * eating ordinary output, so the host refuses to inject it at all.
 */
export const SHELL_MIN_SECRET_CHARS = 8;

export const SHELL_TRACE_SCHEMA = 'shell.trace@1';

export interface EnvPort {
  /** Value for one allowed name, or undefined when the host will not inject it. */
  lookup(name: string): string | undefined;
}

export interface RepoCommands {
  readonly test: readonly string[];
  readonly lint: readonly string[];
  readonly build: readonly string[];
}

export interface ShellClock {
  now(): number;
}

export interface ShellTimer {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ShellHostOptions {
  readonly env: EnvPort;
  readonly clock: ShellClock;
  readonly timer: ShellTimer;
  readonly repo?: RepoCommands;
  readonly tail_chars?: number;
}

export interface ParsedShellCall {
  readonly argv: readonly string[];
  readonly cwd_ref: string;
  readonly env_allow: readonly string[];
  readonly timeout_ms: number;
  readonly stdin: string;
}

export type ShellFailure = 'timeout' | 'denied' | 'spawn_failed' | 'cancelled';

/**
 * JSONL-tree record. Field order is fixed. `env_allow` is names only.
 * `argv` is the vector that was spawned, never a shell string.
 */
export interface ShellTraceRecord {
  readonly schema: typeof SHELL_TRACE_SCHEMA;
  readonly id: string;
  readonly parentId: string | null;
  readonly operation: string;
  readonly argv: readonly string[];
  readonly cwd_ref: string;
  readonly env_allow: readonly string[];
  readonly exit: number | null;
  readonly failure: ShellFailure | null;
  readonly duration_ms: number;
  readonly stdout_tail: string;
  readonly stderr_tail: string;
  readonly artifacts: readonly string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function freezeArgv(argv: readonly string[], label: string): readonly string[] {
  if (argv.length === 0 || argv.length > SHELL_MAX_ARGV) {
    throw new Error(`${label} argv must be a non-empty bounded list`);
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > SHELL_MAX_ARG_CHARS || arg.includes('\0')) {
      throw new Error(`${label} argv is invalid`);
    }
  }
  return Object.freeze([...argv]);
}

export function freezeRepoCommands(repo: RepoCommands): RepoCommands {
  return {
    test: freezeArgv(repo.test, 'repo.test'),
    lint: freezeArgv(repo.lint, 'repo.lint'),
    build: freezeArgv(repo.build, 'repo.build'),
  };
}

export function parseShellCall(
  inputs: Record<string, unknown>,
  argv: readonly unknown[],
): { ok: true; value: ParsedShellCall } | { ok: false; reason: string } {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > SHELL_MAX_ARGV) {
    return { ok: false, reason: 'argv must be a non-empty bounded list' };
  }
  const copy: string[] = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > SHELL_MAX_ARG_CHARS || arg.includes('\0')) {
      return { ok: false, reason: 'argv must be a list of strings' };
    }
    copy.push(arg);
  }
  const cwd_ref = inputs['cwd_ref'];
  if (typeof cwd_ref !== 'string') {
    return { ok: false, reason: 'cwd_ref must be a resource reference' };
  }
  const env_allow = inputs['env_allow'];
  if (!Array.isArray(env_allow) || env_allow.length > SHELL_MAX_ENV) {
    return { ok: false, reason: 'env_allow must name variables' };
  }
  const names: string[] = [];
  for (const name of env_allow) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 128 || !ENV_NAME.test(name)) {
      return { ok: false, reason: 'env_allow must name variables' };
    }
    names.push(name);
  }
  const timeout_ms = inputs['timeout_ms'];
  if (!Number.isInteger(timeout_ms) || (timeout_ms as number) < 1 || (timeout_ms as number) > SHELL_MAX_TIMEOUT_MS) {
    return { ok: false, reason: 'timeout_ms must be a positive integer' };
  }
  let stdin = '';
  if ('stdin' in inputs && inputs['stdin'] !== undefined) {
    if (typeof inputs['stdin'] !== 'string' || inputs['stdin'].length > SHELL_MAX_STDIN_CHARS) {
      return { ok: false, reason: 'stdin must be a string' };
    }
    stdin = inputs['stdin'];
  }
  return {
    ok: true,
    value: { argv: copy, cwd_ref, env_allow: names, timeout_ms: timeout_ms as number, stdin },
  };
}

export interface EnvLookup {
  readonly ok: true;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
}

/**
 * Names only go in. Values stay in the returned record and are never logged here.
 * A value shorter than SHELL_MIN_SECRET_CHARS, including an empty one, fails the
 * whole lookup: it could be neither refused on argv nor redacted reliably.
 */
export function lookupEnv(port: EnvPort, names: readonly string[]): EnvLookup | { ok: false } {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  for (const name of names) {
    let value: string | undefined;
    try {
      value = port.lookup(name);
    } catch {
      return { ok: false };
    }
    if (typeof value !== 'string') {
      continue;
    }
    if (value.length < SHELL_MIN_SECRET_CHARS) {
      return { ok: false };
    }
    env[name] = value;
    secrets.push(value);
  }
  return { ok: true, env, secrets };
}

/** `secrets` come from lookupEnv, so each has at least SHELL_MIN_SECRET_CHARS characters. */
export function containsSecret(parts: readonly string[], secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    for (const part of parts) {
      if (part.includes(secret)) {
        return true;
      }
    }
  }
  return false;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    if (out.includes(secret)) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

export function redactArgv(argv: readonly string[], secrets: readonly string[]): string[] {
  return argv.map((arg) => redactSecrets(arg, secrets));
}

export function traceInOrder(record: ShellTraceRecord): ShellTraceRecord {
  return {
    schema: record.schema,
    id: record.id,
    parentId: record.parentId,
    operation: record.operation,
    argv: record.argv,
    cwd_ref: record.cwd_ref,
    env_allow: record.env_allow,
    exit: record.exit,
    failure: record.failure,
    duration_ms: record.duration_ms,
    stdout_tail: record.stdout_tail,
    stderr_tail: record.stderr_tail,
    artifacts: record.artifacts,
  };
}

export function isShellOperation(operation: string): boolean {
  return (
    operation === 'shell.run@1' || operation === 'repo.test' || operation === 'repo.lint' || operation === 'repo.build'
  );
}

export function isRepoOperation(operation: string): boolean {
  return operation === 'repo.test' || operation === 'repo.lint' || operation === 'repo.build';
}
