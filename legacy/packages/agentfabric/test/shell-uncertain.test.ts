import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGrantAuthority, type InvocationOutcome } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, SHELL_RUN, type ShellHostOptions } from '@weave/agentfabric';

const STUB = fileURLToPath(new URL('../../test/fixtures/stub-cli.mjs', import.meta.url));
const TIMEOUT = 60_000;
const absent = { resolution: 'not_committed' as const, evidence: 'external audit of partial writes' };

function time() {
  let expire: () => void = () => {
    throw new Error('timeout not armed');
  };
  const timer: ShellHostOptions['timer'] = {
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const handle = ms === TIMEOUT ? undefined : setTimeout(resolve, ms);
        if (ms === TIMEOUT) expire = resolve;
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
  };
  return { clock: { now: () => 1 }, timer, expire: () => expire() };
}

function fixture(t: TestContext, writes = true) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'weave-shell-uncertain-'));
  const path = join(dir, 'fabric.json');
  let store = FabricStore.open(path);
  const authority = createGrantAuthority();
  const timing = time();
  const contract = writes
    ? SHELL_RUN
    : { ...SHELL_RUN, effects: [], permissions: [], process_effects: [{ name: 'process.spawn' as const }] };
  const options = { authority, contracts: [contract], shell: { env: { lookup: () => undefined }, ...timing } };
  let host = new AgentFabricHost({ ...options, store });
  const cwd = host.registerWorkspace(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const grant = (id: string, ref = cwd) =>
    authority.issue({
      action_id: id,
      operation: contract.id,
      contract_rev: contract.revision,
      effects: writes ? [{ resource: ref, mode: 'write' }] : [],
      permissions: writes ? [{ resource: ref, mode: 'write' }] : [],
      process_effects: writes ? ['process.spawn', `fs.write:${ref}`] : ['process.spawn'],
      issued_at: 1,
    });
  const inputs = (argv: string[], ref = cwd) => ({ argv, cwd_ref: ref, env_allow: [], timeout_ms: TIMEOUT, stdin: '' });
  return {
    dir,
    path,
    cwd,
    grant,
    inputs,
    timing,
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = FabricStore.open(path);
      host = new AgentFabricHost({ ...options, store });
    },
  };
}

async function pidAt(path: string): Promise<number> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (fs.existsSync(path)) {
      const pid = Number(fs.readFileSync(path, 'utf8'));
      if (pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('child did not signal its first write');
}

async function replay(
  f: ReturnType<typeof fixture>,
  issued: ReturnType<typeof f.grant>,
  inputs: ReturnType<typeof f.inputs>,
  result: InvocationOutcome,
) {
  const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
  assert.equal(handle.kind, 'handle');
  if (handle.kind === 'handle') assert.deepEqual(await handle.result, result);
  assert.deepEqual(f.host.releaseAll(), []);
}

function assertHeld(f: ReturnType<typeof fixture>, expected = 1) {
  assert.equal(f.host.coordinator.held().length, expected);
  const conflict = f.host.invoke(f.grant('conflict'), SHELL_RUN.id, f.inputs([process.execPath, STUB, '--report']));
  assert.equal(conflict.kind, 'rejected');
  if (conflict.kind === 'rejected') assert.match(conflict.reason, /effect conflict/);
}

describe('shell uncertainty after process start', () => {
  it('versions the expanded shell failure vocabulary', () => {
    assert.equal(SHELL_RUN.revision, 'r2');
    assert.ok(SHELL_RUN.failures.includes('killed'));
    assert.ok(SHELL_RUN.failures.includes('execution_fault'));
  });

  for (const status of ['uncertain', 'stopped'] as const) {
    it(`loads an old r1 shell ${status} record without rewriting its vocabulary`, async (t) => {
      const f = fixture(t);
      const issued = f.grant('legacy');
      const inputs = f.inputs([process.execPath, STUB, '--report']);
      const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
      if (handle.kind !== 'handle') throw new Error('expected handle');
      const snapshot = f.store.snapshot();
      const outcome: InvocationOutcome =
        status === 'uncertain'
          ? { outcome: 'uncertain', reason: 'shell_timeout' }
          : { outcome: 'failed', failure: 'timeout' };
      const legacy = { ...SHELL_RUN, revision: 'r1', failures: ['timeout', 'denied', 'spawn_failed', 'cancelled'] };
      f.store.close();
      fs.writeFileSync(
        f.path,
        JSON.stringify({
          ...snapshot,
          admissions: [
            { operation: legacy.id, implementation_id: 'legacy-shell', contract: legacy, source: '() => ({})' },
          ],
          invocations: snapshot.invocations.map((record) => ({
            ...record,
            implementation_id: 'legacy-shell',
            status,
            outcome,
          })),
        }) + '\n',
      );
      f.reopen();
      assert.equal(f.store.admitted()[0]?.contract.revision, 'r1');
      assert.deepEqual(f.store.getInvocation('legacy')?.outcome, outcome);
      const replayGrant = f.host.authority.issue({
        action_id: 'legacy',
        operation: legacy.id,
        contract_rev: legacy.revision,
        permissions: [{ resource: f.cwd, mode: 'write' }],
        effects: [{ resource: f.cwd, mode: 'write' }],
        process_effects: ['process.spawn', `fs.write:${f.cwd}`],
        issued_at: 1,
      });
      if (status === 'uncertain') {
        const replayed = f.host.invoke(replayGrant, legacy.id, inputs);
        if (replayed.kind !== 'handle') throw new Error('expected legacy replay');
        assert.deepEqual(await replayed.result, outcome);
        assert.deepEqual(f.host.releaseAll(), []);
        assert.equal(f.host.coordinator.held().length, 1);
        f.host.reconcile('legacy', absent);
      } else {
        assert.deepEqual(f.host.lookup('legacy', replayGrant), { status: 'stopped', outcome });
        assert.equal(f.host.coordinator.held().length, 0);
      }
    });
  }

  for (const interruption of ['timeout', 'cancelled', 'abort', 'killed'] as const) {
    it(`${interruption} after the first write remains held and replays its accurate reason across restart`, async (t) => {
      const f = fixture(t);
      const pidFile = join(f.dir, 'partial.pid');
      const issued = f.grant('interrupted');
      const inputs = f.inputs([process.execPath, STUB, '--sleep', pidFile]);
      const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
      if (handle.kind !== 'handle') throw new Error('expected handle');
      f.host.release(issued.action_id);
      const pid = await pidAt(pidFile);
      if (interruption === 'timeout') f.timing.expire();
      else if (interruption === 'cancelled') handle.requestCancel();
      else if (interruption === 'abort') {
        // Exercise the signal independently of requestCancel's recorded flag.
        const open = (f.host as unknown as { open: Map<string, { abort: AbortController }> }).open;
        open.get(handle.invocation_id)!.abort.abort();
      } else process.kill(pid, 'SIGKILL');
      const reason = interruption === 'abort' ? 'cancelled' : interruption;
      const result = await handle.result;
      assert.deepEqual(result, { outcome: 'uncertain', reason });
      assert.equal(f.store.getInvocation(issued.action_id)?.status, 'uncertain');
      assert.equal(f.host.shellTraces()[0]?.failure, interruption === 'abort' ? 'cancelled' : interruption);
      assertHeld(f);
      await replay(f, issued, inputs, result);
      f.reopen();
      assert.deepEqual(f.store.getInvocation(issued.action_id)?.outcome, result);
      assertHeld(f);
      await replay(f, issued, inputs, result);
      f.host.reconcile(issued.action_id, absent);
      assert.equal(f.host.coordinator.held().length, 0);
      const after = f.host.invoke(f.grant('after'), SHELL_RUN.id, f.inputs([process.execPath, STUB, '--report']));
      if (after.kind !== 'handle') throw new Error('reservation not released');
      f.host.release('after');
      assert.equal((await after.result).outcome, 'succeeded');
    });
  }

  for (const before of [
    'cancel before release',
    'abort before spawn',
    'spawn failure',
    'spawn failure with immediate timeout',
  ] as const) {
    it(`${before} with declared writes stays stopped`, async (t) => {
      const f = fixture(t);
      const issued = f.grant('before');
      const missing = before.startsWith('spawn failure');
      const inputs = f.inputs(missing ? [join(f.dir, 'missing-executable')] : [process.execPath, STUB, '--report']);
      const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
      if (handle.kind !== 'handle') throw new Error('expected handle');
      const mutable = createRequire(import.meta.url)('node:fs') as typeof fs;
      const original = mutable.readdirSync;
      if (before === 'cancel before release') handle.requestCancel();
      if (before === 'abort before spawn') {
        mutable.readdirSync = ((...args: Parameters<typeof original>) => {
          f.host.requestCancel(handle.invocation_id);
          return original(...args);
        }) as typeof original;
        syncBuiltinESMExports();
      }
      if (before.endsWith('immediate timeout')) f.timing.timer.sleep = async () => undefined;
      let result: InvocationOutcome;
      try {
        f.host.release('before');
        result = await handle.result;
      } finally {
        mutable.readdirSync = original;
        syncBuiltinESMExports();
      }
      assert.deepEqual(result, { outcome: 'failed', failure: missing ? 'spawn_failed' : 'cancelled' });
      assert.equal(f.store.getInvocation('before')?.status, 'stopped');
      assert.deepEqual(f.host.coordinator.held(), []);
      f.reopen();
      assert.equal(f.store.getInvocation('before')?.status, 'stopped');
      assert.deepEqual(f.host.coordinator.held(), []);
    });
  }

  for (const interruption of ['timeout', 'cancelled', 'killed'] as const) {
    it(`${interruption} after start with no declared writes stays stopped`, async (t) => {
      const f = fixture(t, false);
      const issued = f.grant('read-only');
      const pidFile = join(f.dir, 'read-only.pid');
      const inputs = f.inputs([process.execPath, STUB, '--sleep', pidFile]);
      const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
      if (handle.kind !== 'handle') throw new Error('expected handle');
      f.host.release(issued.action_id);
      const pid = await pidAt(pidFile);
      if (interruption === 'timeout') f.timing.expire();
      else if (interruption === 'cancelled') handle.requestCancel();
      else process.kill(pid, 'SIGKILL');
      const result = { outcome: 'failed' as const, failure: interruption };
      assert.deepEqual(await handle.result, result);
      assert.equal(f.store.getInvocation(issued.action_id)?.status, 'stopped');
      assert.equal(f.host.shellTraces()[0]?.failure, interruption);
      assert.deepEqual(f.host.coordinator.held(), []);
      f.reopen();
      assert.deepEqual(f.store.getInvocation(issued.action_id)?.outcome, result);
    });
  }

  for (const failure of ['cancelled', 'spawn_failed'] as const) {
    it(`a trace fault cannot turn a known before-start ${failure} into uncertainty`, async (t) => {
      const f = fixture(t);
      let injected = false;
      (f.host as unknown as { pushShellTrace: () => void }).pushShellTrace = () => {
        injected = true;
        throw new Error('trace fault before execution');
      };
      const issued = f.grant('before-trace-fault');
      const inputs = f.inputs(
        failure === 'spawn_failed' ? [join(f.dir, 'missing-executable')] : [process.execPath, STUB, '--report'],
      );
      const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
      if (handle.kind !== 'handle') throw new Error('expected handle');
      if (failure === 'cancelled') handle.requestCancel();
      f.host.release(issued.action_id);
      const result = { outcome: 'failed' as const, failure };
      assert.deepEqual(await handle.result, result);
      assert.equal(injected, true);
      assert.equal(f.store.getInvocation(issued.action_id)?.status, 'stopped');
      assert.deepEqual(f.host.coordinator.held(), []);
      f.reopen();
      assert.deepEqual(f.store.getInvocation(issued.action_id)?.outcome, result);
      assert.deepEqual(f.host.coordinator.held(), []);
    });
  }

  for (const interruption of ['timeout', 'cancelled', 'killed'] as const) {
    it(`a trace fault preserves an observed ${interruption} after start`, async (t) => {
      const f = fixture(t);
      let injected = false;
      (f.host as unknown as { pushShellTrace: () => void }).pushShellTrace = () => {
        injected = true;
        throw new Error('trace fault after interruption');
      };
      const issued = f.grant('interrupted-trace-fault');
      const pidFile = join(f.dir, 'interrupted.pid');
      const inputs = f.inputs([process.execPath, STUB, '--sleep', pidFile]);
      const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
      if (handle.kind !== 'handle') throw new Error('expected handle');
      f.host.release(issued.action_id);
      const pid = await pidAt(pidFile);
      if (interruption === 'timeout') f.timing.expire();
      else if (interruption === 'cancelled') handle.requestCancel();
      else process.kill(pid, 'SIGKILL');
      const result = { outcome: 'uncertain' as const, reason: interruption };
      assert.deepEqual(await handle.result, result);
      assert.equal(injected, true);
      assertHeld(f);
      f.reopen();
      assert.deepEqual(f.store.getInvocation(issued.action_id)?.outcome, result);
      assertHeld(f);
      await replay(f, issued, inputs, result);
      f.host.reconcile(issued.action_id, absent);
      assert.deepEqual(f.host.coordinator.held(), []);
    });
  }

  for (const fault of ['throw', 'reject'] as const) {
    it(`a timer ${fault} after spawn records execution_fault and terminates the process`, async (t) => {
      const f = fixture(t);
      const original = f.timing.timer.sleep;
      let fail!: () => void;
      f.timing.timer.sleep = (ms, signal) => {
        if (ms !== TIMEOUT) return original(ms, signal);
        if (fault === 'throw') throw new Error('timer failed');
        return new Promise<void>((_resolve, reject) => {
          fail = () => reject(new Error('timer failed'));
        });
      };
      const issued = f.grant('timer-fault');
      const pidFile = join(f.dir, 'timer.pid');
      const inputs = f.inputs([process.execPath, STUB, '--sleep', pidFile]);
      const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
      if (handle.kind !== 'handle') throw new Error('expected handle');
      f.host.release(issued.action_id);
      // A synchronous timer fault can occur before the child reaches its first
      // write, but spawn has already established that execution started.
      const pid = fault === 'reject' ? await pidAt(pidFile) : undefined;
      if (fault === 'reject') fail();
      const result = { outcome: 'uncertain' as const, reason: 'execution_fault' };
      assert.deepEqual(await handle.result, result);
      if (pid !== undefined) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(f.host.shellTraces()[0]?.failure, 'execution_fault');
      assertHeld(f);
      f.reopen();
      assert.deepEqual(f.store.getInvocation(issued.action_id)?.outcome, result);
      assertHeld(f);
      f.host.reconcile(issued.action_id, absent);
      assert.deepEqual(f.host.coordinator.held(), []);
    });
  }

  for (const fault of ['snapshot before start', 'snapshot after run', 'issueArtifacts', 'pushShellTrace'] as const) {
    it(`${fault} retains declared-write uncertainty without claiming spawn_failed`, async (t) => {
      const f = fixture(t);
      const mutable = createRequire(import.meta.url)('node:fs') as typeof fs;
      const original = mutable.readdirSync;
      let snapshots = 0;
      let injected = false;
      if (fault.startsWith('snapshot')) {
        // Use a throwing iterator, which lies outside snapshotFiles' readdir catch.
        snapshots = 0;
        mutable.readdirSync = ((...args: Parameters<typeof original>) => {
          const entries = original(...args);
          if (String(args[0]) === f.dir && ++snapshots === (fault === 'snapshot before start' ? 1 : 2)) {
            injected = true;
            Object.defineProperty(entries, Symbol.iterator, {
              value() {
                throw new Error('snapshot fault');
              },
            });
          }
          return entries;
        }) as typeof original;
        syncBuiltinESMExports();
      } else {
        (f.host as unknown as Record<string, unknown>)[fault] = () => {
          injected = true;
          throw new Error('post-run fault');
        };
      }
      const issued = f.grant('fault');
      const inputs = f.inputs([process.execPath, STUB, '--touch', 'written.txt']);
      let result: InvocationOutcome;
      try {
        const handle = f.host.invoke(issued, SHELL_RUN.id, inputs);
        if (handle.kind !== 'handle') throw new Error('expected handle');
        f.host.release('fault');
        result = await handle.result;
      } finally {
        mutable.readdirSync = original;
        syncBuiltinESMExports();
      }
      assert.equal(injected, true);
      assert.deepEqual(result, { outcome: 'uncertain', reason: 'execution_fault' });
      assert.equal(fs.existsSync(join(f.dir, 'written.txt')), fault !== 'snapshot before start');
      assertHeld(f);
      f.reopen();
      assert.deepEqual(f.store.getInvocation('fault')?.outcome, result);
      assertHeld(f);
      await replay(f, issued, inputs, result);
      f.host.reconcile('fault', absent);
      assert.deepEqual(f.host.coordinator.held(), []);
    });
  }

  it('killing one of two concurrent writers retains only its reservation across restart', async (t) => {
    const f = fixture(t);
    const otherDir = fs.mkdtempSync(join(tmpdir(), 'weave-other-writer-'));
    t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));
    const other = f.host.registerWorkspace(otherDir);
    const first = f.host.invoke(
      f.grant('first'),
      SHELL_RUN.id,
      f.inputs([process.execPath, STUB, '--sleep', join(f.dir, 'first.pid')]),
    );
    const second = f.host.invoke(
      f.grant('second', other),
      SHELL_RUN.id,
      f.inputs([process.execPath, STUB, '--sleep', join(otherDir, 'second.pid')], other),
    );
    if (first.kind !== 'handle' || second.kind !== 'handle') throw new Error('expected two handles');
    f.host.releaseAll();
    const [firstPid, secondPid] = await Promise.all([
      pidAt(join(f.dir, 'first.pid')),
      pidAt(join(otherDir, 'second.pid')),
    ]);
    process.kill(firstPid, 'SIGKILL');
    const firstResult = await first.result;
    assert.equal(f.host.openCount(), 1);
    // Finish the independent run too, even if an assertion about the killed writer fails.
    process.kill(secondPid, 'SIGTERM');
    const secondResult = await second.result;
    assert.deepEqual(firstResult, { outcome: 'uncertain', reason: 'killed' });
    assert.deepEqual(secondResult, firstResult);
    assert.equal(f.host.coordinator.held().length, 2);
    f.host.reconcile('second', absent);
    assertHeld(f);
    f.reopen();
    assertHeld(f);
    f.host.reconcile('first', absent);
    assert.deepEqual(f.host.coordinator.held(), []);
  });

  for (const point of ['before', 'partial', 'after'] as const) {
    it(`a crash ${point} the shell uncertain-marker append preserves its hold`, async (t) => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'weave-shell-marker-crash-'));
      const path = join(dir, 'fabric.json');
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { createRequire, syncBuiltinESMExports } from 'node:module';
        import { createGrantAuthority } from '@weave/agentsop';
        import { AgentFabricHost, FabricStore, SHELL_RUN } from '@weave/agentfabric';
        const [path, dir, stub, point] = process.argv.slice(1);
        const authority = createGrantAuthority();
        const store = FabricStore.open(path);
        const host = new AgentFabricHost({ authority, store, shell: {
          env: { lookup: () => undefined }, clock: { now: () => 1 }, timer: { sleep(ms, signal) {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, ms);
              signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
            });
          } }
        } });
        const cwd = host.registerWorkspace(dir);
        const grant = authority.issue({ action_id: 'crash', operation: SHELL_RUN.id, contract_rev: SHELL_RUN.revision,
          permissions: [{ resource: cwd, mode: 'write' }], effects: [{ resource: cwd, mode: 'write' }],
          process_effects: ['process.spawn', 'fs.write:' + cwd], issued_at: 1 });
        const handle = host.invoke(grant, SHELL_RUN.id, { argv: [process.execPath, stub, '--signal'], cwd_ref: cwd, env_allow: [], timeout_ms: 5000 });
        if (handle.kind !== 'handle') throw new Error('expected handle');
        const mutable = createRequire(import.meta.url)('node:fs');
        const original = mutable.writeSync;
        mutable.writeSync = (...args) => {
          if (String(args[1]).includes('"op":"uncertain"')) {
            if (point === 'before') process.exit(86);
            if (point === 'partial') { original(args[0], args[1], 0, 15); process.exit(86); }
            original(...args); process.exit(86);
          }
          return original(...args);
        };
        syncBuiltinESMExports();
        host.release('crash'); await handle.result;
        throw new Error('marker crash injection not reached');
      `,
          path,
          dir,
          STUB,
          point,
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
      assert.equal(child.status, 86, child.stderr || String(child.error));
      const store = FabricStore.open(path);
      t.after(() => store.close());
      const authority = createGrantAuthority();
      const host = new AgentFabricHost({ authority, store, shell: { env: { lookup: () => undefined }, ...time() } });
      const record = store.getInvocation('crash')!;
      assert.equal(record.status, 'uncertain');
      if (point === 'after') assert.deepEqual(record.outcome, { outcome: 'uncertain', reason: 'killed' });
      const cwd = (record.inputs as { cwd_ref: string }).cwd_ref;
      const issue = (action_id: string) =>
        authority.issue({
          action_id,
          operation: SHELL_RUN.id,
          contract_rev: SHELL_RUN.revision,
          permissions: [{ resource: cwd, mode: 'write' }],
          effects: [{ resource: cwd, mode: 'write' }],
          process_effects: ['process.spawn', `fs.write:${cwd}`],
          issued_at: 1,
        });
      const replayed = host.invoke(issue('crash'), SHELL_RUN.id, record.inputs);
      if (replayed.kind !== 'handle') throw new Error('expected recovered replay');
      assert.equal((await replayed.result).outcome, 'uncertain');
      assert.deepEqual(host.releaseAll(), []);
      assert.equal(host.coordinator.held().length, 1);
      assert.equal(host.invoke(issue('blocked'), SHELL_RUN.id, record.inputs).kind, 'rejected');
      host.reconcile('crash', absent);
      assert.deepEqual(host.coordinator.held(), []);
    });
  }
});
