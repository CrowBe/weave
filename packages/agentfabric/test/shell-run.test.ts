/**
 * shell.run@1 and the repo commands derived from it.
 * The canary is an environment value. It must not appear on argv, in traces,
 * in stored invocations, or in rejection reasons.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createGrantAuthority,
  type Grant,
  type GrantAuthority,
  type InvocationOutcome,
  type InvocationRejected,
} from '@weave/agentsop';
import {
  AgentFabricHost,
  FabricStore,
  REPO_BUILD,
  REPO_LINT,
  REPO_TEST,
  SHELL_RUN,
  type ShellHostOptions,
} from '@weave/agentfabric';

const CANARY = 'canary-secret-9f3a2c7b-NOT-ON-ARGV';
const STUB = fileURLToPath(new URL('../../test/fixtures/stub-cli.mjs', import.meta.url));

function testTime(): { clock: { now(): number }; timer: ShellHostOptions['timer'] } {
  let now = 1_000;
  return {
    clock: { now: () => now },
    timer: {
      sleep(ms: number, signal?: AbortSignal) {
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          const handle = setTimeout(() => {
            now += ms;
            resolve();
          }, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(handle);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    },
  };
}

function envPort(throwOn?: string): ShellHostOptions['env'] {
  return {
    lookup(name: string) {
      if (throwOn !== undefined && name === throwOn) {
        throw new Error(CANARY);
      }
      return name === 'CANARY' ? CANARY : undefined;
    },
  };
}

/**
 * Real sleeps, except a sleep of exactly `timeout_ms`: that one resolves only
 * when the test calls `expire()`, so a timeout fires after an observed event.
 */
function expiringTime(timeout_ms: number): ReturnType<typeof testTime> & { expire(): void } {
  const base = testTime();
  const pending: (() => void)[] = [];
  return {
    clock: base.clock,
    timer: {
      sleep(ms: number, signal?: AbortSignal) {
        if (ms !== timeout_ms) {
          return base.timer.sleep(ms, signal);
        }
        return new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          pending.push(resolve);
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    },
    expire() {
      for (const resolve of pending.splice(0)) {
        resolve();
      }
    },
  };
}

function hostFor(
  repo: ShellHostOptions['repo'],
  port: ShellHostOptions['env'] = envPort(),
  time = testTime(),
): {
  authority: GrantAuthority;
  host: AgentFabricHost;
  dir: string;
  cwd: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p7-shell-'));
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({
    authority,
    shell: {
      env: port,
      clock: time.clock,
      timer: time.timer,
      ...(repo === undefined ? {} : { repo }),
    },
  });
  const cwd = host.registerWorkspace(dir);
  return { authority, host, dir, cwd };
}

function grant(
  authority: GrantAuthority,
  operation: string,
  cwd: string,
  action: string,
  process_effects?: readonly string[],
): Grant {
  return authority.issue({
    action_id: action,
    operation,
    contract_rev: SHELL_RUN.revision,
    permissions: [{ resource: cwd, mode: 'write' }],
    effects: [{ resource: cwd, mode: 'write' }],
    ...(process_effects === undefined ? {} : { process_effects }),
    issued_at: 1,
  });
}

function shellInputs(cwd: string, argv: string[], env_allow: string[] = [], timeout_ms = 5_000, stdin = '') {
  return { argv, cwd_ref: cwd, env_allow, timeout_ms, stdin };
}

type Settled = InvocationRejected | InvocationOutcome;

async function invoke(host: AgentFabricHost, issued: Grant, operation: string, inputs: unknown): Promise<Settled> {
  const handle = host.invoke(issued, operation, inputs);
  if (handle.kind === 'rejected') {
    return handle;
  }
  host.release(issued.action_id);
  return handle.result;
}

function asRejected(value: Settled): InvocationRejected {
  if ('kind' in value) {
    return value;
  }
  assert.fail(`expected a rejection, got ${value.outcome}`);
}

function asOutcome(value: Settled): InvocationOutcome {
  if ('outcome' in value) {
    return value;
  }
  assert.fail(`expected an outcome, got ${value.code}`);
}

function succeeded(value: Settled): {
  exit: number;
  stdout_tail: string;
  stderr_tail: string;
  stdout_truncated: boolean;
} {
  const outcome = asOutcome(value);
  if (outcome.outcome !== 'succeeded') {
    assert.fail(`expected success, got ${outcome.outcome}`);
  }
  return outcome.output as { exit: number; stdout_tail: string; stderr_tail: string; stdout_truncated: boolean };
}

function observed(host: AgentFabricHost): string {
  return JSON.stringify({
    traces: host.shellTraces(),
    jsonl: host.shellTraceJsonl(),
    spawns: host.spawnRecords(),
    invocations: host.invocations,
    stored: host.store.snapshot().invocations,
    rejections: host.rejections,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPid(file: string): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim();
      if (text.length > 0 && Number.isInteger(Number(text))) {
        return Number(text);
      }
    }
    if (Date.now() - started > 5_000) {
      throw new Error('timed out waiting for the child pid file');
    }
    await delay(20);
  }
}

/**
 * True once the process is gone or is a zombie. A killed orphan stays a zombie
 * until init reaps it, which the host cannot do (and some container inits never do).
 */
function terminated(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z');
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<void> {
  const started = Date.now();
  while (!terminated(pid)) {
    if (Date.now() - started > 2_000) {
      throw new Error('child still alive');
    }
    await delay(20);
  }
}

/** Settles with the invocation outcome, or fails if it takes longer than `ms` of real time. */
async function within<T>(ms: number, pending: Promise<T>, label: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

describe('shell.run@1', () => {
  for (const fault of ['throw after execution', 'malformed outcome'] as const) {
    it(`retains declared-write uncertainty for a shell ${fault}`, async () => {
      const world = hostFor(undefined);
      const { host, authority, cwd, dir } = world;
      try {
        if (fault === 'throw after execution') {
          (host as unknown as { pushShellTrace(): void }).pushShellTrace = () => {
            throw new Error('trace fault');
          };
        } else {
          (host as unknown as { performShell(): Promise<unknown> }).performShell = async () => undefined;
        }
        const inputs = shellInputs(cwd, [process.execPath, STUB, '--report']);
        const issue = (id: string) => grant(authority, SHELL_RUN.id, cwd, id, ['process.spawn', `fs.write:${cwd}`]);
        const issued = issue('fault');
        const handle = host.invoke(issued, SHELL_RUN.id, inputs);
        if (handle.kind !== 'handle') throw new Error('expected handle');
        host.release('fault');
        const result = await handle.result;
        assert.equal(result.outcome, 'uncertain');
        assert.equal(host.store.getInvocation('fault')?.status, 'uncertain');
        assert.equal(host.coordinator.held().length, 1);
        assert.equal(host.invoke(issue('conflict'), SHELL_RUN.id, inputs).kind, 'rejected');
        const found = host.lookup('fault', issued);
        assert.ok('status' in found);
        assert.equal(found.status, 'unresolved');
        const replay = host.invoke(issued, SHELL_RUN.id, inputs);
        assert.equal(replay.kind, 'handle');
        if (replay.kind === 'handle') assert.deepEqual(await replay.result, result);
        assert.deepEqual(host.releaseAll(), []);
        host.reconcile('fault', { resolution: 'not_committed', evidence: 'external audit' });
        assert.equal(host.coordinator.held().length, 0);
      } finally {
        host.store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const fault of ['closed store', 'replaced lock'] as const) {
    it(`keeps lookup unresolved after a completed shell run with ${fault} and retains its declared-write reservation`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-shell-result-write-'));
      const path = join(dir, 'fabric.json');
      const store = FabricStore.open(path);
      const authority = createGrantAuthority();
      const time = testTime();
      const host = new AgentFabricHost({
        authority,
        store,
        shell: {
          env: envPort(),
          clock: time.clock,
          timer: time.timer,
        },
      });
      try {
        const cwd = host.registerWorkspace(dir);
        const issued = grant(authority, SHELL_RUN.id, cwd, 'shell-settle', ['process.spawn', `fs.write:${cwd}`]);
        const handle = host.invoke(issued, SHELL_RUN.id, shellInputs(cwd, [process.execPath, STUB, '--report']), {
          invocation_id: 'shell-settle-invocation',
        });
        assert.equal(handle.kind, 'handle');
        if (handle.kind !== 'handle') throw new Error('expected invocation handle');
        host.release('shell-settle');
        if (fault === 'closed store') store.close();
        else writeFileSync(`${path}.lock`, `${process.pid}:replacement`);
        const before = readFileSync(path);
        assert.deepEqual(await handle.result, {
          outcome: 'uncertain',
          reason: 'failed to persist invocation result; uncertain marker was not persisted',
        });
        assert.equal(host.shellTraces()[0]?.exit, 0, 'the shell operation completed');
        assert.equal(host.openCount(), 0);
        assert.deepEqual(host.lookup('shell-settle-invocation', issued), {
          status: 'unresolved',
          reason: 'failed to persist invocation result; uncertain marker was not persisted',
        });
        assert.equal(host.coordinator.held().length, 1);
        assert.deepEqual(readFileSync(path), before);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('injects env_allow by name and keeps the canary out of argv, traces, and errors', async () => {
    const world = hostFor(undefined);
    try {
      const argv = [process.execPath, STUB, '--report'];
      const outcome = asOutcome(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-report', ['process.spawn', `fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, argv, ['CANARY'], 5_000, 'stdin-body'),
        ),
      );
      assert.equal(outcome.outcome, 'succeeded');
      const output = outcome.output as { exit: number; stdout_tail: string; artifacts: string[] };
      assert.equal(output.exit, 0);
      const report = JSON.parse(output.stdout_tail) as {
        argv: string[];
        stdin: string;
        canary_present: boolean;
        canary_len: number;
        env_names: string[];
      };
      assert.deepEqual(report.argv, argv);
      assert.equal(report.stdin, 'stdin-body');
      assert.equal(report.canary_present, true);
      assert.equal(report.canary_len, CANARY.length);
      assert.deepEqual(report.env_names, ['CANARY']);
      assert.equal(observed(world.host).includes(CANARY), false);
      assert.equal(world.host.spawnRecords()[0]?.argv.join('\0').includes(CANARY), false);
      const trace = world.host.shellTraces()[0];
      assert.equal(trace?.schema, 'shell.trace@1');
      assert.equal(trace?.parentId, null);
      assert.deepEqual(trace?.env_allow, ['CANARY']);
      assert.equal(trace?.argv.join('\0').includes(CANARY), false);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it('redacts a canary the child writes to stdout', async () => {
    const world = hostFor(undefined);
    try {
      const outcome = asOutcome(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-leak', ['process.spawn', `fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--leak'], ['CANARY']),
        ),
      );
      assert.equal(outcome.outcome, 'succeeded');
      const output = outcome.output as { stdout_tail: string };
      assert.equal(output.stdout_tail.includes(CANARY), false);
      assert.equal(observed(world.host).includes(CANARY), false);
      assert.match(output.stdout_tail, /\[redacted\]/);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it('denies a grant that does not match process effects, without spawning', async () => {
    const world = hostFor(undefined);
    try {
      const missing = asRejected(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-missing', [`fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--report'], ['CANARY']),
        ),
      );
      const wrongRef = asRejected(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-wrong', ['process.spawn', 'fs.write:ref_other']),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--report']),
        ),
      );
      const absent = asRejected(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-absent'),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--report']),
        ),
      );
      for (const result of [missing, wrongRef, absent]) {
        assert.equal(result.code, 'DENIED');
      }
      assert.equal(world.host.spawnRecords().length, 0);
      assert.equal(observed(world.host).includes(CANARY), false);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it('denies a decision answer and a forged grant without spawning', async () => {
    const world = hostFor(undefined);
    try {
      const decision = world.host.invoke(
        {
          site: 'frontier.weigh',
          choice: 'shell.run@1',
          probabilities: { run: 1 },
          confidence: 0.99,
        } as never,
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--report']),
      );
      const forged = world.host.invoke(
        {
          action_id: 'forged',
          operation: SHELL_RUN.id,
          contract_rev: SHELL_RUN.revision,
          permissions: [{ resource: world.cwd, mode: 'write' }],
          effects: [{ resource: world.cwd, mode: 'write' }],
          process_effects: ['process.spawn', `fs.write:${world.cwd}`],
          issued_at: 1,
        },
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--report']),
      );
      assert.equal(decision.kind, 'rejected');
      assert.equal(decision.code, 'DENIED');
      assert.equal(forged.kind, 'rejected');
      assert.equal(forged.code, 'DENIED');
      assert.equal(world.host.spawnRecords().length, 0);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it('denies when argv carries an injected value or the env port throws, without spawning', async () => {
    const world = hostFor(undefined);
    const throwing = hostFor(undefined, envPort('CANARY'));
    try {
      const carried = asRejected(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-carried', ['process.spawn', `fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, CANARY], ['CANARY']),
        ),
      );
      const blew = asRejected(
        await invoke(
          throwing.host,
          grant(throwing.authority, SHELL_RUN.id, throwing.cwd, 'shell-threw', [
            'process.spawn',
            `fs.write:${throwing.cwd}`,
          ]),
          SHELL_RUN.id,
          shellInputs(throwing.cwd, [process.execPath, STUB, '--report'], ['CANARY']),
        ),
      );
      assert.equal(carried.code, 'DENIED');
      assert.equal(carried.reason, 'denied');
      assert.equal(blew.code, 'DENIED');
      assert.equal(world.host.spawnRecords().length, 0);
      assert.equal(throwing.host.spawnRecords().length, 0);
      assert.equal(observed(world.host).includes(CANARY), false);
      assert.equal(observed(throwing.host).includes(CANARY), false);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
      rmSync(throwing.dir, { recursive: true, force: true });
    }
  });

  it('refuses env values too short to redact, and redacts only whole accepted values', async () => {
    const SHORT = 'q7Zx9Kw';
    const EXACT = 'k8Vw2pQz';
    const values: Record<string, string> = { SHORT, ONE: '1', EMPTY: '', CANARY: EXACT };
    const world = hostFor(undefined, { lookup: (name: string) => values[name] });
    const effects = ['process.spawn', `fs.write:${world.cwd}`];
    try {
      for (const name of ['SHORT', 'ONE', 'EMPTY']) {
        const refused = asRejected(
          await invoke(
            world.host,
            grant(world.authority, SHELL_RUN.id, world.cwd, `shell-short-${name}`, effects),
            SHELL_RUN.id,
            shellInputs(world.cwd, [process.execPath, STUB, '--report'], [name]),
          ),
        );
        assert.equal(refused.code, 'DENIED', name);
        assert.equal(refused.reason, 'denied', name);
      }
      assert.equal(world.host.spawnRecords().length, 0);
      assert.equal(observed(world.host).includes(SHORT), false);

      // Eight characters is the shortest value injected. It is refused on argv and redacted as a whole.
      const carried = asRejected(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-exact-argv', effects),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--report', `--token=${EXACT}`], ['CANARY']),
        ),
      );
      assert.equal(carried.code, 'DENIED');
      const leaked = succeeded(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-exact-leak', effects),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--leak'], ['CANARY']),
        ),
      );
      assert.equal(leaked.stdout_tail, '[redacted]');
      // Fragments of the value and common short tokens are ordinary output, not redaction targets.
      const ordinary = succeeded(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-exact-ordinary', effects),
          SHELL_RUN.id,
          shellInputs(
            world.cwd,
            [process.execPath, STUB, '--report'],
            ['CANARY'],
            5_000,
            `${EXACT.slice(0, 7)} 1 exit`,
          ),
        ),
      );
      const report = JSON.parse(ordinary.stdout_tail) as { stdin: string; canary_len: number };
      assert.equal(report.stdin, `${EXACT.slice(0, 7)} 1 exit`);
      assert.equal(report.canary_len, EXACT.length);
      assert.equal(observed(world.host).includes(EXACT), false);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it('does not interpolate argv through a shell', async () => {
    const world = hostFor(undefined);
    try {
      const outcome = asOutcome(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-literal', ['process.spawn', `fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, ['echo hello && touch pwned']),
        ),
      );
      assert.equal(outcome.outcome, 'failed');
      assert.equal(outcome.failure, 'spawn_failed');
      assert.equal(existsSync(join(world.dir, 'pwned')), false);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it('maps a missing executable to spawn_failed', async () => {
    const world = hostFor(undefined);
    try {
      const outcome = asOutcome(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-enoent', ['process.spawn', `fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, [join(world.dir, 'missing-binary-p7')]),
        ),
      );
      assert.equal(outcome.outcome, 'failed');
      assert.equal(outcome.failure, 'spawn_failed');
      assert.equal(observed(world.host).includes(CANARY), false);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it('bounds stdout and stderr tails', async () => {
    const world = hostFor(undefined);
    try {
      const outcome = asOutcome(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-flood', ['process.spawn', `fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--flood', '20000']),
        ),
      );
      assert.equal(outcome.outcome, 'succeeded');
      const output = outcome.output as { stdout_tail: string; stderr_tail: string };
      assert.equal(output.stdout_tail.length, 4096);
      assert.equal(output.stderr_tail.length, 4096);
      assert.match(output.stdout_tail, /^y+$/);
      assert.match(output.stderr_tail, /^z+$/);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it('kills the child on timeout', async () => {
    const world = hostFor(undefined);
    const pidFile = join(tmpdir(), `weave-p7-timeout-${process.pid}.pid`);
    try {
      const outcome = asOutcome(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-timeout', ['process.spawn', `fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--sleep', pidFile], [], 700),
        ),
      );
      assert.deepEqual(outcome, { outcome: 'uncertain', reason: 'timeout' });
      assert.equal(world.host.coordinator.held().length, 1);
      const pid = await waitForPid(pidFile);
      await waitDead(pid);
      const trace = world.host.shellTraces()[0];
      assert.equal(trace?.failure, 'timeout');
      assert.equal(typeof trace?.duration_ms, 'number');
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
      rmSync(pidFile, { force: true });
    }
  });

  it('kills the child on cancel', async () => {
    const world = hostFor(undefined);
    const pidFile = join(tmpdir(), `weave-p7-cancel-${process.pid}.pid`);
    try {
      const issued = grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-cancel', [
        'process.spawn',
        `fs.write:${world.cwd}`,
      ]);
      const handle = world.host.invoke(
        issued,
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--sleep', pidFile], [], 60_000),
      );
      assert.equal(handle.kind, 'handle');
      if (handle.kind !== 'handle') {
        return;
      }
      world.host.release(issued.action_id);
      const pid = await waitForPid(pidFile);
      handle.requestCancel();
      const outcome = await handle.result;
      assert.deepEqual(outcome, { outcome: 'uncertain', reason: 'cancelled' });
      assert.equal(world.host.coordinator.held().length, 1);
      await waitDead(pid);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
      rmSync(pidFile, { force: true });
    }
  });

  // A grandchild inherits stdout and stderr. In the process group the host terminates it.
  // One that left the group (its own session) is only detached from the pipes; it is not signalled.
  for (const escape of [false, true]) {
    const holder = escape ? 'a grandchild outside the process group' : 'a grandchild';
    const subprocess = (pidFile: string, ...extra: string[]) => [
      process.execPath,
      STUB,
      '--subprocess',
      pidFile,
      ...(escape ? ['--escape'] : []),
      ...extra,
    ];

    for (const failure of ['timeout', 'cancelled'] as const) {
      it(`${failure} returns promptly when ${holder} holds stdout open, and holds the lock until reconciliation`, async () => {
        const TIMEOUT_MS = 60_000;
        const time = expiringTime(TIMEOUT_MS);
        const world = hostFor(undefined, envPort(), time);
        const pidFile = join(world.dir, 'grandchild.pid');
        let grandchild: number | undefined;
        try {
          const effects = ['process.spawn', `fs.write:${world.cwd}`];
          const issued = grant(world.authority, SHELL_RUN.id, world.cwd, 'subprocess', effects);
          const handle = world.host.invoke(
            issued,
            SHELL_RUN.id,
            shellInputs(world.cwd, subprocess(pidFile), [], TIMEOUT_MS),
          );
          assert.equal(handle.kind, 'handle');
          if (handle.kind !== 'handle') return;
          world.host.release(issued.action_id);
          grandchild = await waitForPid(pidFile);
          if (failure === 'timeout') time.expire();
          else handle.requestCancel();
          const outcome = await within(2500, handle.result, 'post-kill wait');
          assert.deepEqual(outcome, { outcome: 'uncertain', reason: failure });
          if (escape) {
            assert.equal(
              terminated(grandchild),
              false,
              'the grandchild left the group, so the group signal did not reach it',
            );
          } else {
            await waitDead(grandchild);
          }
          assert.equal(world.host.coordinator.held().length, 1);
          const blocked = world.host.invoke(
            grant(world.authority, SHELL_RUN.id, world.cwd, 'blocked-subprocess', effects),
            SHELL_RUN.id,
            shellInputs(world.cwd, [process.execPath, STUB, '--report']),
          );
          assert.equal(blocked.kind, 'rejected');
          world.host.reconcile(handle.invocation_id, { resolution: 'not_committed', evidence: 'external audit' });
          const next = asOutcome(
            await invoke(
              world.host,
              grant(world.authority, SHELL_RUN.id, world.cwd, 'after-subprocess', effects),
              SHELL_RUN.id,
              shellInputs(world.cwd, [process.execPath, STUB, '--report']),
            ),
          );
          assert.equal(next.outcome, 'succeeded');
        } finally {
          // Cleanup of the test's own grandchild; every assertion above has already run.
          if (grandchild !== undefined && !terminated(grandchild)) {
            try {
              process.kill(grandchild, 'SIGKILL');
            } catch {
              /* Already gone. */
            }
          }
          rmSync(world.dir, { recursive: true, force: true });
        }
      });
    }

    it(`reports the exit status when the child exits while ${holder} holds stdout open`, async () => {
      const world = hostFor(undefined);
      const pidFile = join(world.dir, 'grandchild.pid');
      let grandchild: number | undefined;
      try {
        const effects = ['process.spawn', `fs.write:${world.cwd}`];
        const issued = grant(world.authority, SHELL_RUN.id, world.cwd, 'exits-early', effects);
        const handle = world.host.invoke(
          issued,
          SHELL_RUN.id,
          shellInputs(world.cwd, subprocess(pidFile, '--exit=5'), [], 60_000),
        );
        assert.equal(handle.kind, 'handle');
        if (handle.kind !== 'handle') return;
        world.host.release(issued.action_id);
        grandchild = await waitForPid(pidFile);
        const output = succeeded(await within(2500, handle.result, 'exit with a lingering grandchild'));
        assert.equal(output.exit, 5);
        assert.match(output.stdout_tail, /parent-done/);
        // Detaching before end-of-file means stdout may be incomplete, so it is reported as truncated.
        assert.equal(output.stdout_truncated, escape);
        if (escape) {
          assert.equal(
            terminated(grandchild),
            false,
            'the grandchild left the group, so the group signal did not reach it',
          );
        } else {
          await waitDead(grandchild);
        }
        const trace = world.host.shellTraces()[0];
        assert.equal(trace?.exit, 5);
        assert.equal(trace?.failure, null);
        const next = asOutcome(
          await invoke(
            world.host,
            grant(world.authority, SHELL_RUN.id, world.cwd, 'after-exit', effects),
            SHELL_RUN.id,
            shellInputs(world.cwd, [process.execPath, STUB, '--report']),
          ),
        );
        assert.equal(next.outcome, 'succeeded');
      } finally {
        if (grandchild !== undefined && !terminated(grandchild)) {
          try {
            process.kill(grandchild, 'SIGKILL');
          } catch {
            /* Already gone. */
          }
        }
        rmSync(world.dir, { recursive: true, force: true });
      }
    });
  }

  it('returns artifact refs and keeps locators in the host', async () => {
    const world = hostFor(undefined);
    try {
      const outcome = asOutcome(
        await invoke(
          world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-touch', ['process.spawn', `fs.write:${world.cwd}`]),
          SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--touch', 'hello.txt']),
        ),
      );
      assert.equal(outcome.outcome, 'succeeded');
      const output = outcome.output as { artifacts: string[] };
      assert.equal(output.artifacts.length, 1);
      const ref = output.artifacts[0] as string;
      assert.match(ref, /^ref_/);
      const issued = world.host.store.lookupRef(ref);
      const resource = issued ? world.host.store.getResource(issued.canonical_id) : undefined;
      assert.equal(resource?.locator.endsWith('hello.txt'), true);
      assert.equal(JSON.stringify(outcome).includes('hello.txt'), false);
      assert.equal(JSON.stringify(outcome).includes(world.dir), false);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });
});

describe('repo.test, repo.lint, and repo.build', () => {
  it('spawn the configured argv and record a shell.run child trace', async () => {
    const commands = {
      test: [process.execPath, STUB, '--report', 'configured-test'],
      lint: [process.execPath, STUB, '--report', 'configured-lint'],
      build: [process.execPath, STUB, '--report', 'configured-build'],
    };
    const world = hostFor(commands);
    try {
      const cases = [
        [REPO_TEST.id, 'configured-test'],
        [REPO_LINT.id, 'configured-lint'],
        [REPO_BUILD.id, 'configured-build'],
      ] as const;
      for (const [operation, token] of cases) {
        const outcome = asOutcome(
          await invoke(
            world.host,
            grant(world.authority, operation, world.cwd, operation, ['process.spawn', `fs.write:${world.cwd}`]),
            operation,
            { cwd_ref: world.cwd, env_allow: [], timeout_ms: 5_000 },
          ),
        );
        assert.equal(outcome.outcome, 'succeeded');
        const output = outcome.output as { stdout_tail: string };
        const report = JSON.parse(output.stdout_tail) as { argv: string[] };
        assert.equal(report.argv.includes(token), true);
        assert.equal(report.argv.includes('model-text'), false);
      }
      const rejected = world.host.invoke(
        grant(world.authority, REPO_TEST.id, world.cwd, 'repo-extra', ['process.spawn', `fs.write:${world.cwd}`]),
        REPO_TEST.id,
        { cwd_ref: world.cwd, env_allow: [], timeout_ms: 5_000, argv: ['model-text'] },
      );
      assert.equal(rejected.kind, 'rejected');
      assert.equal(rejected.code, 'INVALID_INPUT');
      const lines = world.host
        .shellTraceJsonl()
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              id: string;
              parentId: string | null;
              operation: string;
              argv: string[];
            },
        );
      const parent = lines.find((line) => line.operation === REPO_TEST.id && line.parentId === null);
      assert.ok(parent);
      const child = lines.find((line) => line.parentId === parent.id);
      assert.equal(child?.operation, SHELL_RUN.id);
      assert.equal(child?.id, `${parent.id}:shell`);
      assert.equal(child?.argv.includes('configured-test'), true);
      assert.equal(JSON.stringify(lines).includes(CANARY), false);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });
});
