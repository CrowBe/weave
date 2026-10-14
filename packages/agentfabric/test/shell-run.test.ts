/**
 * shell.run@1 and the repo commands derived from it.
 * The canary is an environment value. It must not appear on argv, in traces,
 * in stored invocations, or in rejection reasons.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { AgentFabricHost, REPO_BUILD, REPO_LINT, REPO_TEST, SHELL_RUN, type ShellHostOptions } from '@weave/agentfabric';

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

function hostFor(repo: ShellHostOptions['repo'], port: ShellHostOptions['env'] = envPort()): {
  authority: GrantAuthority;
  host: AgentFabricHost;
  dir: string;
  cwd: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p7-shell-'));
  const authority = createGrantAuthority();
  const time = testTime();
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
    contract_rev: 'r1',
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

async function waitDead(pid: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() - started > 2_000) {
      throw new Error('child still alive');
    }
    await delay(20);
  }
}

describe('shell.run@1', () => {
  it('injects env_allow by name and keeps the canary out of argv, traces, and errors', async () => {
    const world = hostFor(undefined);
    try {
      const argv = [process.execPath, STUB, '--report'];
      const outcome = asOutcome(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-report', ['process.spawn', `fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, argv, ['CANARY'], 5_000, 'stdin-body'),
      ));
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
      const outcome = asOutcome(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-leak', ['process.spawn', `fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--leak'], ['CANARY']),
      ));
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
      const missing = asRejected(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-missing', [`fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--report'], ['CANARY']),
      ));
      const wrongRef = asRejected(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-wrong', ['process.spawn', 'fs.write:ref_other']),
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--report']),
      ));
      const absent = asRejected(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-absent'),
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--report']),
      ));
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
          contract_rev: 'r1',
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
      const carried = asRejected(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-carried', ['process.spawn', `fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, CANARY], ['CANARY']),
      ));
      const blew = asRejected(await invoke(
        throwing.host,
        grant(throwing.authority, SHELL_RUN.id, throwing.cwd, 'shell-threw', ['process.spawn', `fs.write:${throwing.cwd}`]),
        SHELL_RUN.id,
        shellInputs(throwing.cwd, [process.execPath, STUB, '--report'], ['CANARY']),
      ));
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

  it('does not interpolate argv through a shell', async () => {
    const world = hostFor(undefined);
    try {
      const outcome = asOutcome(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-literal', ['process.spawn', `fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, ['echo hello && touch pwned']),
      ));
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
      const outcome = asOutcome(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-enoent', ['process.spawn', `fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, [join(world.dir, 'missing-binary-p7')]),
      ));
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
      const outcome = asOutcome(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-flood', ['process.spawn', `fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--flood', '20000']),
      ));
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
      const outcome = asOutcome(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-timeout', ['process.spawn', `fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--sleep', pidFile], [], 700),
      ));
      assert.equal(outcome.outcome, 'failed');
      assert.equal(outcome.failure, 'timeout');
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
      assert.equal(outcome.outcome, 'failed');
      assert.equal(outcome.failure, 'cancelled');
      await waitDead(pid);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
      rmSync(pidFile, { force: true });
    }
  });

  for (const failure of ['timeout', 'cancelled'] as const) {
    it(`${failure} returns promptly when a grandchild holds stdout open and releases the lock`, async () => {
      const world = hostFor(undefined);
      const pidFile = join(world.dir, 'grandchild.pid');
      let grandchild: number | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const issued = grant(world.authority, SHELL_RUN.id, world.cwd, 'subprocess', [
          'process.spawn', `fs.write:${world.cwd}`,
        ]);
        const handle = world.host.invoke(issued, SHELL_RUN.id,
          shellInputs(world.cwd, [process.execPath, STUB, '--subprocess', pidFile], [],
            failure === 'timeout' ? 1000 : 60_000));
        assert.equal(handle.kind, 'handle');
        if (handle.kind !== 'handle') return;
        world.host.release(issued.action_id);
        grandchild = await waitForPid(pidFile);
        if (failure === 'cancelled') handle.requestCancel();
        const outcome = await Promise.race([
          handle.result,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('post-kill wait exceeded 2500 ms')), 2500);
          }),
        ]);
        assert.equal(outcome.outcome, 'failed');
        assert.equal(outcome.failure, failure);
        const next = asOutcome(await invoke(world.host,
          grant(world.authority, SHELL_RUN.id, world.cwd, 'after-subprocess', [
            'process.spawn', `fs.write:${world.cwd}`,
          ]), SHELL_RUN.id, shellInputs(world.cwd, [process.execPath, STUB, '--report'])));
        assert.equal(next.outcome, 'succeeded');
      } finally {
        clearTimeout(deadline);
        if (grandchild !== undefined) {
          try { process.kill(grandchild, 'SIGKILL'); } catch { /* Already gone. */ }
        }
        rmSync(world.dir, { recursive: true, force: true });
      }
    });
  }

  it('returns artifact refs and keeps locators in the host', async () => {
    const world = hostFor(undefined);
    try {
      const outcome = asOutcome(await invoke(
        world.host,
        grant(world.authority, SHELL_RUN.id, world.cwd, 'shell-touch', ['process.spawn', `fs.write:${world.cwd}`]),
        SHELL_RUN.id,
        shellInputs(world.cwd, [process.execPath, STUB, '--touch', 'hello.txt']),
      ));
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
        const outcome = asOutcome(await invoke(
          world.host,
          grant(world.authority, operation, world.cwd, operation, ['process.spawn', `fs.write:${world.cwd}`]),
          operation,
          { cwd_ref: world.cwd, env_allow: [], timeout_ms: 5_000 },
        ));
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
      const lines = world.host.shellTraceJsonl().trim().split('\n').map((line) => JSON.parse(line) as {
        id: string;
        parentId: string | null;
        operation: string;
        argv: string[];
      });
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
