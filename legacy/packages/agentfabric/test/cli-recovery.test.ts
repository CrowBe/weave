import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGrantAuthority, type Grant } from '@weave/agentsop';
import {
  AgentFabricHost,
  FabricStore,
  PersistFailure,
  REPO_BUILD,
  REPO_LINT,
  REPO_TEST,
  SHELL_RUN,
  createGrantedCliSpawn,
} from '@weave/agentfabric';
import { codexExecAdapter, type CliSpawnRequest } from '@weave/gateway/cli-generate';

const STUB = fileURLToPath(new URL('../../test/fixtures/stub-cli.mjs', import.meta.url));
const ABSENT = {
  resolution: 'not_committed',
  evidence: 'operator inspected workspace',
  force_with_evidence: true,
} as const;

function fixture(t: TestContext, repo = false) {
  const dir = mkdtempSync(join(tmpdir(), 'weave-cli-recovery-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const path = join(dir, 'fabric.jsonl');
  const authority = createGrantAuthority();
  const probeWaits: number[] = [];
  const shell = {
    env: { lookup: () => undefined },
    clock: { now: () => 1000 },
    ...(repo
      ? {
          repo: {
            test: [process.execPath, STUB, '--exit', '0'],
            lint: [process.execPath, STUB, '--exit', '0'],
            build: [process.execPath, STUB, '--exit', '0'],
          },
        }
      : {}),
    timer: {
      sleep: (ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (ms === 25) {
            probeWaits.push(ms);
            resolve();
            return;
          }
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    },
  };
  let probe: 'alive' | 'gone' | 'unknown' = 'unknown';
  let probes: ('alive' | 'gone' | 'unknown')[] = [];
  const probeOptions = { cliProcessGroupProbe: () => probes.shift() ?? probe };
  let store = new FabricStore(undefined, path);
  let host = new AgentFabricHost({ authority, store, shell, ...probeOptions });
  const cwd_ref = host.registerWorkspace(workspace);
  let seq = 0;
  const request = (argv = [process.execPath, STUB, '--report']): CliSpawnRequest => ({
    argv,
    cwd_ref,
    env_allow: [],
    timeout_ms: 60_000,
    stdin: 'hello',
  });
  const spawn = () => createGrantedCliSpawn({ host, authority });
  const cancel = async (change?: () => void) => {
    const marker = join(dir, `started-${seq++}`);
    const abort = new AbortController();
    const adapter = codexExecAdapter({
      spawn: spawn(),
      cwd_ref,
      timeout_ms: 60_000,
      argv: [process.execPath, STUB, '--sleep', marker],
    });
    const pending = adapter.execute({
      model: 'stub',
      instructions: '',
      prompt: 'hello',
      settings: { max_output_tokens: 16 },
      signal: abort.signal,
    });
    for (let i = 0; !existsSync(marker); i++) {
      assert.ok(i < 500, 'stub must start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    change?.();
    abort.abort();
    return pending;
  };
  const reopen = async (beforeHost?: (store: FabricStore) => void, state: typeof probe = 'gone') => {
    probe = state;
    store.close();
    store = new FabricStore(undefined, path);
    beforeHost?.(store);
    host = new AgentFabricHost({ authority, store, shell, ...probeOptions });
    await host.cliRecoveryReady;
  };
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    authority,
    probeWaits,
    setProbes(states: (typeof probe)[]) {
      probes = [...states];
    },
    setProbe(state: typeof probe) {
      probe = state;
    },
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    workspace,
    path,
    cwd_ref,
    request,
    spawn,
    cancel,
    reopen,
  };
}

describe('CLI generation uncertainty recovery', () => {
  for (const contract of [SHELL_RUN, REPO_TEST, REPO_LINT, REPO_BUILD]) {
    it(`keeps the trusted ${contract.id} revision after restoring an r1 admission and preserves historical lookup`, async (t) => {
      const f = fixture(t, true);
      const legacy = { ...contract, revision: 'r1', failures: ['timeout', 'denied', 'spawn_failed', 'cancelled'] };
      f.store.recordAdmission({
        operation: legacy.id,
        implementation_id: 'legacy-shell',
        contract: legacy,
        source: '() => ({})',
      });
      const inputs =
        contract.id === SHELL_RUN.id ? f.request() : { cwd_ref: f.cwd_ref, env_allow: [], timeout_ms: 60_000 };
      const record = {
        invocation_id: 'legacy',
        action_id: 'legacy',
        operation: legacy.id,
        implementation_id: 'legacy-shell',
        binding_digest: 'legacy',
        inputs,
        status: 'stopped' as const,
        outcome: { outcome: 'failed' as const, failure: 'timeout' },
        cancel_requested: false,
      };
      f.store.persistInvocationResult(record);
      await f.reopen();

      let cliGrant: Grant | undefined;
      const invoke = f.host.invokeCliGeneration.bind(f.host);
      f.host.invokeCliGeneration = (grant, inputs) => {
        cliGrant = grant;
        return invoke(grant, inputs);
      };
      assert.equal(
        (await f.spawn().run(f.request([process.execPath, '-e', "process.stdout.write('generated')"]))).status,
        'completed',
      );
      assert.equal(cliGrant?.contract_rev, 'r2');
      assert.equal(f.host.liveContracts().find((live) => live.id === contract.id)?.revision, 'r2');
      assert.equal(f.host.implementationAdmitted(legacy.id, 'legacy-shell'), false);
      const grant = (action_id: string, contract_rev: string) =>
        f.authority.issue({
          action_id,
          operation: legacy.id,
          contract_rev,
          permissions: [{ resource: f.cwd_ref, mode: 'write' }],
          effects: [{ resource: f.cwd_ref, mode: 'write' }],
          process_effects: ['process.spawn', `fs.write:${f.cwd_ref}`],
          issued_at: 0,
        });
      assert.deepEqual(f.host.lookup('legacy', grant('legacy', 'r1')), { status: 'stopped', outcome: record.outcome });
      assert.equal(Reflect.get(f.host.lookup('legacy', grant('legacy', 'r2')), 'code'), 'DENIED');
      assert.equal(Reflect.get(f.host.invoke(grant('fresh-r1', 'r1'), legacy.id, inputs), 'code'), 'DENIED');
      assert.deepEqual(f.store.admitted()[0]?.contract, legacy);
      assert.deepEqual(f.store.getInvocation('legacy'), record);
    });
  }

  for (const operation of [SHELL_RUN.id, REPO_TEST.id]) {
    it(`reports missing CLI process evidence for a non-CLI ${operation} workspace hold`, async (t) => {
      const f = fixture(t, true);
      f.store.persistInvocationStart({
        invocation_id: 'non-cli',
        action_id: 'non-cli',
        operation,
        binding_digest: 'non-cli',
        inputs: { cwd_ref: f.cwd_ref },
        status: 'running',
        outcome: null,
        cancel_requested: false,
        reservation: [{ resource: f.store.lookupRef(f.cwd_ref)!.canonical_id, mode: 'write' }],
      });
      await f.reopen();
      assert.throws(
        () => f.host.reconcileCliGeneration('non-cli', { resolution: 'not_committed', evidence: 'inspected' }),
        /no CLI process evidence exists/,
      );
      assert.equal(f.host.coordinator.held().length, 1);
      assert.equal(f.store.getInvocation('non-cli')?.reconciliation, undefined);
      assert.equal(f.host.reconcileCliGeneration('non-cli', ABSENT).status, 'stopped');
    });
  }

  for (const fault of ['persist', 'resolver'] as const) {
    it(`reports ${fault} rejection before execution as spawn_failed`, async (t) => {
      const f = fixture(t);
      const host = fault === 'resolver' ? new AgentFabricHost({ authority: f.authority, store: f.store }) : f.host;
      if (fault === 'persist')
        f.store.persistInvocationStart = () => {
          throw new PersistFailure('invocation start');
        };
      const result = await createGrantedCliSpawn({ host, authority: f.authority }).run(f.request());
      assert.equal(result.status, 'failed');
      assert.equal(result.status === 'failed' && result.failure, 'spawn_failed');
      assert.equal(f.store.invocationRecords().length, 0);
      assert.equal(host.spawnRecords().length, 0);
      assert.equal(host.coordinator.held().length, 0);
    });
  }

  it('preserves uncertainty when in-process reconciliation cannot persist', async (t) => {
    const f = fixture(t);
    f.setProbe('gone');
    f.store.persistInvocationReconciliation = () => {
      throw new Error('injected reconciliation failure');
    };
    const result = await f.cancel();
    assert.equal(result.status, 'uncertain');
    assert.equal(f.host.coordinator.held().length, 1);
    assert.equal(f.store.invocationRecords()[0]?.status, 'uncertain');
    assert.equal(f.store.invocationRecords()[0]?.reconciliation, undefined);
  });

  it('surfaces cancellation, names the workspace holder, and permits an operator resolution', async (t) => {
    const f = fixture(t);
    const result = await f.cancel();
    assert.equal(result.status, 'uncertain');
    const [entry] = f.host.listUncertainCliGenerations();
    assert.ok(entry);
    assert.equal(entry.cwd_ref, f.cwd_ref);
    const held = await f.spawn().run(f.request());
    assert.equal(held.status, 'failed');
    if (held.status === 'failed') {
      assert.equal(held.failure, 'workspace_held');
      assert.equal(held.held_by, entry.invocation_id);
    }
    f.host.reconcileCliGeneration(entry.invocation_id, ABSENT);
    assert.equal(f.host.coordinator.held().length, 0);
    assert.equal((await f.spawn().run(f.request())).status, 'completed');
    assert.throws(() => f.host.reconcileCliGeneration(entry.invocation_id, ABSENT), /reconciled|require/);
  });

  it('durably snapshots before execution and auto-reconciles unchanged workspaces across repeated restarts', async (t) => {
    const f = fixture(t);
    for (let i = 0; i < 4; i++) {
      f.setProbe('unknown');
      assert.equal((await f.cancel()).status, 'uncertain');
      const [entry] = f.host.listUncertainCliGenerations();
      assert.ok(entry);
      const start = readFileSync(f.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((m) => m.op === 'start' && m.record.invocation_id === entry.invocation_id);
      assert.equal(typeof start.record.cli_generation.before_snapshot, 'string');
      await f.reopen();
      assert.equal(f.host.listUncertainCliGenerations().length, 0);
      assert.equal(f.store.getInvocation(entry.invocation_id)?.reconciliation?.resolution, 'not_committed');
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal((await f.spawn().run(f.request())).status, 'completed');
    }
  });

  it('permits repeated cancellations and operator resolutions without reusing an invocation identity', async (t) => {
    const f = fixture(t);
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      assert.equal((await f.cancel()).status, 'uncertain');
      const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
      assert.ok(id);
      assert.equal(ids.has(id), false);
      ids.add(id);
      f.host.reconcileCliGeneration(id, ABSENT);
      assert.equal(f.host.coordinator.held().length, 0);
    }
    assert.equal((await f.spawn().run(f.request())).status, 'completed');
  });

  it('detects changes to existing hidden/deep file contents and preserves the hold after restart', async (t) => {
    const f = fixture(t);
    const nested = join(f.workspace, '.hidden', 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const file = join(nested, 'same-name');
    writeFileSync(file, 'before');
    await f.cancel(() => writeFileSync(file, 'after!'));
    const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
    assert.ok(id);
    await f.reopen();
    const [entry] = f.host.listUncertainCliGenerations();
    assert.equal(entry?.invocation_id, id);
    assert.equal(entry?.startup_check, 'workspace_changed');
    assert.equal(f.store.getInvocation(id)?.status, 'uncertain');
    const held = await f.spawn().run(f.request());
    if (held.status !== 'failed') throw new Error('expected workspace refusal');
    assert.equal(held.failure, 'workspace_held');
    assert.equal(held.held_by, id);
    f.host.reconcileCliGeneration(id, ABSENT);
    assert.equal((await f.spawn().run(f.request())).status, 'completed');
  });

  it('releases an unchanged workspace despite timestamp-only changes', async (t) => {
    const f = fixture(t);
    const file = join(f.workspace, 'unchanged-content');
    writeFileSync(file, 'same');
    utimesSync(file, 1, 1);
    await f.cancel(() => utimesSync(file, 2, 2));
    const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
    assert.ok(id);
    await f.reopen();
    assert.equal(f.store.getInvocation(id)?.status, 'stopped');
    assert.equal(f.host.coordinator.held().length, 0);
  });

  for (const fault of ['closed', 'lost lock'] as const) {
    it(`keeps uncertainty and holds unchanged when reconciliation fails with ${fault}`, async (t) => {
      const f = fixture(t);
      await f.cancel();
      const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
      assert.ok(id);
      const snapshot = f.host.snapshot();
      const holds = structuredClone(f.host.coordinator.held());
      if (fault === 'closed') f.store.close();
      else writeFileSync(`${f.path}.lock`, 'other-owner');
      assert.throws(() => f.host.reconcileCliGeneration(id, ABSENT), /closed|lock/);
      assert.deepEqual(f.host.snapshot(), snapshot);
      assert.deepEqual(f.host.coordinator.held(), holds);
    });
  }

  it('retains the hold through a racing generation until reconciliation commits', async (t) => {
    const f = fixture(t);
    await f.cancel();
    const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
    assert.ok(id);
    const persist = f.store.persistInvocationReconciliation.bind(f.store);
    let racing: ReturnType<ReturnType<typeof createGrantedCliSpawn>['run']> | undefined;
    f.store.persistInvocationReconciliation = (record) => {
      racing = f.spawn().run(f.request());
      assert.throws(() => f.host.reconcileCliGeneration(id, ABSENT), /active/);
      persist(record);
      assert.equal(f.host.coordinator.held().length, 1);
    };
    f.host.reconcileCliGeneration(id, ABSENT);
    const refused = await racing;
    assert.equal(refused?.status, 'failed');
    if (refused?.status === 'failed') assert.equal(refused.failure, 'workspace_held');
    assert.equal(f.host.coordinator.held().length, 0);
    assert.equal((await f.spawn().run(f.request())).status, 'completed');
    assert.equal(f.host.coordinator.held().length, 0);
  });

  it('does not wedge construction when the startup workspace check fails', async (t) => {
    const f = fixture(t);
    await f.cancel();
    const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
    assert.ok(id);
    rmSync(f.workspace, { recursive: true });
    await f.reopen();
    assert.equal(f.host.listUncertainCliGenerations()[0]?.startup_check, 'snapshot_unavailable');
    assert.equal(f.host.coordinator.held().length, 1);
    f.host.reconcileCliGeneration(id, ABSENT);
    assert.equal(f.host.coordinator.held().length, 0);
  });

  it('records symlinks without following their targets', async (t) => {
    const f = fixture(t);
    symlinkSync(f.path, join(f.workspace, 'external-journal'));
    await f.cancel();
    const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
    assert.ok(id);
    assert.equal(typeof f.store.getInvocation(id)?.cli_generation?.before_snapshot, 'string');
    await f.reopen();
    assert.equal(f.host.coordinator.held().length, 0);
  });

  for (const state of ['alive', 'unknown'] as const) {
    it(`keeps a crashed generation held when its process group is ${state}`, async (t) => {
      const f = fixture(t);
      await f.cancel();
      const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
      assert.ok(id);
      await f.reopen((store) => {
        // A crash leaves a durable running record with no terminal outcome.
        const record = store.getInvocation(id)!;
        store.persistInvocationResult({ ...record, status: 'running', outcome: null });
      }, state);
      assert.equal(f.host.coordinator.held().length, 1);
      assert.equal(typeof Reflect.get(f.store.getInvocation(id)!.cli_generation!, 'pgid'), 'number');
      assert.equal(f.host.listUncertainCliGenerations()[0]?.startup_check, `process_group_${state}`);
      assert.throws(
        () => f.host.reconcileCliGeneration(id, { resolution: 'not_committed', evidence: 'inspected' }),
        /process group/,
      );
      f.host.reconcileCliGeneration(id, ABSENT);
      assert.equal(f.host.coordinator.held().length, 0);
    });
  }

  it('retains a legacy CLI hold when process-group evidence is missing', async (t) => {
    const f = fixture(t);
    f.store.persistInvocationStart({
      invocation_id: 'shell-cli:legacy',
      action_id: 'shell-cli:legacy',
      operation: 'shell.run@1',
      binding_digest: 'legacy',
      inputs: { cwd_ref: f.cwd_ref },
      status: 'running',
      outcome: null,
      cancel_requested: false,
      reservation: [{ resource: f.store.lookupRef(f.cwd_ref)!.canonical_id, mode: 'write' }],
      cli_generation: { cwd_ref: f.cwd_ref, before_snapshot: null },
    });
    await f.reopen();
    assert.equal(f.host.listUncertainCliGenerations()[0]?.startup_check, 'process_group_unknown');
    assert.equal(f.host.coordinator.held().length, 1);
  });

  for (const code of [undefined, 'EPERM', 'ESRCH'] as const) {
    it(`probes the negative saved pgid and treats ${code ?? 'success'} conservatively`, async (t) => {
      const f = fixture(t);
      f.store.persistInvocationStart({
        invocation_id: 'shell-cli:probe',
        action_id: 'shell-cli:probe',
        operation: 'shell.run@1',
        binding_digest: 'probe',
        inputs: { cwd_ref: f.cwd_ref },
        status: 'running',
        outcome: null,
        cancel_requested: false,
        reservation: [{ resource: f.store.lookupRef(f.cwd_ref)!.canonical_id, mode: 'write' }],
        cli_generation: { cwd_ref: f.cwd_ref, before_snapshot: null, pgid: 12345 },
      });
      const kill = t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
        assert.equal(pid, -12345);
        assert.equal(signal, 0);
        if (code) throw Object.assign(new Error('injected probe result'), { code });
        return true;
      });
      const host = new AgentFabricHost({ authority: f.authority, store: f.store });
      await host.cliRecoveryReady;
      assert.equal(kill.mock.callCount(), 1);
      assert.equal(
        host.listUncertainCliGenerations()[0]?.startup_check,
        code === 'ESRCH' ? 'snapshot_unavailable' : code ? 'process_group_unknown' : 'process_group_alive',
      );
      assert.equal(host.coordinator.held().length, 1);
    });
  }

  it('reconciles a crashed running record when its group is gone and workspace unchanged', async (t) => {
    const f = fixture(t);
    await f.cancel();
    const id = f.store.invocationRecords()[0]!.invocation_id;
    await f.reopen((store) => {
      store.persistInvocationResult({ ...store.getInvocation(id)!, status: 'running', outcome: null });
    }, 'gone');
    assert.equal(f.store.getInvocation(id)?.reconciliation?.resolution, 'not_committed');
    assert.equal(f.host.coordinator.held().length, 0);
  });

  it('retains the hold if the process probe becomes live during snapshot comparison', async (t) => {
    const f = fixture(t);
    await f.cancel();
    let calls = 0;
    f.store.close();
    const store = FabricStore.open(f.path);
    t.after(() => store.close());
    const host = new AgentFabricHost({
      authority: f.authority,
      store,
      cliProcessGroupProbe: () => (++calls === 1 ? 'gone' : 'alive'),
    });
    await host.cliRecoveryReady;
    assert.equal(calls, 2);
    assert.equal(host.coordinator.held().length, 1);
    assert.equal(store.invocationRecords()[0]?.reconciliation, undefined);
  });

  it('reconciles immediately after in-process termination when dead and unchanged', async (t) => {
    const f = fixture(t);
    f.setProbe('gone');
    const result = await f.cancel();
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.failure.code, 'cancelled');
    assert.equal(f.host.listUncertainCliGenerations().length, 0);
    assert.equal(f.host.coordinator.held().length, 0);
    assert.equal(f.store.invocationRecords()[0]?.reconciliation?.resolution, 'not_committed');
    assert.equal(f.store.invocationRecords()[0]?.status, 'stopped');
    assert.equal((await f.spawn().run(f.request())).status, 'completed');
  });

  it('re-probes a zombie-like process group with bounded injected waits after termination', async (t) => {
    const f = fixture(t);
    f.setProbe('gone');
    f.setProbes(['alive', 'alive', 'gone']);
    assert.equal((await f.cancel()).status, 'failed');
    assert.equal(f.host.coordinator.held().length, 0);
    assert.equal(f.probeWaits.length, 2);
    assert.ok(f.probeWaits.every((ms) => ms > 0 && ms <= 100));
  });
  it('returns a failed timeout after automatic not_committed reconciliation', async (t) => {
    const f = fixture(t);
    f.setProbe('gone');
    const result = await f.spawn().run({ ...f.request([process.execPath, STUB, '--sleep']), timeout_ms: 500 });
    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.failure, 'timeout');
    assert.equal(f.store.invocationRecords()[0]?.status, 'stopped');
    assert.equal(f.store.invocationRecords()[0]?.reconciliation?.resolution, 'not_committed');
    assert.equal(f.host.coordinator.held().length, 0);
  });

  for (const prefix of ['', 'submodule/']) {
    it(`keeps ${prefix}.git indirection held after termination and restart`, async (t) => {
      const f = fixture(t);
      f.setProbe('gone');
      mkdirSync(join(f.workspace, prefix), { recursive: true });
      writeFileSync(join(f.workspace, prefix, '.git'), 'gitdir: /uninspected/git/state\n');
      assert.equal((await f.cancel()).status, 'uncertain');
      const record = f.store.invocationRecords()[0]!;
      assert.equal(record.cli_generation?.before_snapshot, null);
      await f.reopen();
      assert.equal(f.host.listUncertainCliGenerations()[0]?.startup_check, 'snapshot_unavailable');
      assert.equal(f.host.coordinator.held().length, 1);
      assert.equal(f.store.getInvocation(record.invocation_id)?.reconciliation, undefined);
    });
  }
  it('rechecks a retained process group on the next generation without restarting', async (t) => {
    const f = fixture(t);
    f.setProbe('alive');
    await f.cancel();
    assert.equal(f.host.coordinator.held().length, 1);
    assert.ok(f.probeWaits.length <= 3);
    f.setProbe('gone');
    assert.equal((await f.spawn().run(f.request())).status, 'completed');
    assert.equal(f.host.coordinator.held().length, 0);
  });
  for (const prefix of ['', 'submodule/']) {
    for (const entry of ['refs/heads/main', 'hooks/pre-commit', 'config']) {
      it(`does not auto-reconcile a cancelled write to ${prefix}.git/${entry}`, async (t) => {
        const f = fixture(t);
        const git = join(f.workspace, prefix, '.git');
        mkdirSync(join(git, 'refs', 'heads'), { recursive: true });
        mkdirSync(join(git, 'hooks'));
        const file = join(git, entry);
        if (!entry.startsWith('hooks/')) writeFileSync(file, 'before');
        await f.cancel(() => writeFileSync(file, 'after'));
        f.setProbe('gone');
        const held = await f.spawn().run(f.request());
        assert.equal(held.status, 'failed');
        await f.reopen();
        assert.equal(f.host.listUncertainCliGenerations()[0]?.startup_check, 'workspace_changed');
        assert.equal(f.host.coordinator.held().length, 1);
        assert.throws(
          () =>
            f.host.reconcileCliGeneration(f.store.invocationRecords()[0]!.invocation_id, {
              resolution: 'not_committed',
              evidence: 'inspected',
            }),
          /snapshot|workspace/,
        );
      });
    }
  }

  for (const phase of ['recovery', 'legacy startup check', 'inspection'] as const) {
    for (const firstEntry of ['bridge', 'caller-supplied identity'] as const) {
      it(`allocates distinct identities for concurrent CLI runs during ${phase} (${firstEntry})`, async (t) => {
        const f = fixture(t);
        if (phase !== 'recovery') await f.host.cliRecoveryReady;
        if (phase === 'legacy startup check') {
          f.store.persistInvocationStart({
            invocation_id: 'legacy',
            action_id: 'legacy',
            operation: SHELL_RUN.id,
            binding_digest: 'legacy',
            inputs: {},
            status: 'running',
            outcome: null,
            cancel_requested: false,
          });
          await f.reopen();
        }
        const other = join(f.workspace, '..', 'other');
        mkdirSync(other);
        const other_ref = f.host.registerWorkspace(other);
        const request = f.request([process.execPath, STUB, '--exit', '0']);
        const first =
          firstEntry === 'bridge'
            ? f.spawn().run(request)
            : (async () => {
                const grant = f.authority.issue({
                  action_id: 'shell-cli:0',
                  operation: SHELL_RUN.id,
                  contract_rev: SHELL_RUN.revision,
                  permissions: [{ resource: f.cwd_ref, mode: 'write' }],
                  effects: [{ resource: f.cwd_ref, mode: 'write' }],
                  process_effects: ['process.spawn', `fs.write:${f.cwd_ref}`],
                  issued_at: 0,
                });
                const handle = await f.host.invokeCliGeneration(grant, request);
                assert.equal(handle.kind, 'handle');
                if (handle.kind !== 'handle') throw new Error('expected CLI invocation handle');
                f.host.release(handle.action_id);
                assert.equal((await handle.result).outcome, 'succeeded');
                return { status: 'completed' };
              })();
        // Recovery and the legacy check yield before prepare; inspection yields after it.
        assert.equal(f.host.coordinator.held().length, phase === 'inspection' ? 1 : 0);
        assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
        const duplicateGrant = f.authority.issue({
          action_id: 'shell-cli:0',
          operation: SHELL_RUN.id,
          contract_rev: SHELL_RUN.revision,
          permissions: [{ resource: other_ref, mode: 'write' }],
          effects: [{ resource: other_ref, mode: 'write' }],
          process_effects: ['process.spawn', `fs.write:${other_ref}`],
          issued_at: 0,
        });
        const duplicate = f.host.invoke(duplicateGrant, SHELL_RUN.id, { ...request, cwd_ref: other_ref });
        assert.equal(duplicate.kind, 'rejected');
        if (duplicate.kind === 'rejected') assert.equal(duplicate.code, 'DENIED');
        const duplicateCli = f.host.invokeCliGeneration(duplicateGrant, { ...request, cwd_ref: other_ref });
        const second = f.spawn().run({ ...request, cwd_ref: other_ref });
        // Release the legacy operation block while both new calls are waiting for its check.
        if (phase === 'legacy startup check') f.host.reconcileCliGeneration('legacy', ABSENT);
        assert.equal((await duplicateCli).kind, 'rejected');
        const results = await Promise.all([first, second]);
        assert.deepEqual(
          results.map((result) => result.status),
          ['completed', 'completed'],
        );
        assert.deepEqual(f.host.invocations.map((entry) => entry.invocation_id).sort(), ['shell-cli:0', 'shell-cli:1']);
        assert.equal(f.host.spawnRecords().length, 2);
        assert.equal(f.host.coordinator.held().length, 0);
      });
    }
  }

  it('reserves allocated identities against ordinary invocations and releases them when prepare fails', async (t) => {
    const f = fixture(t);
    const action_id = f.host.nextCliGenerationId();
    const grant = () =>
      f.authority.issue({
        action_id,
        operation: SHELL_RUN.id,
        contract_rev: SHELL_RUN.revision,
        permissions: [{ resource: f.cwd_ref, mode: 'write' }],
        effects: [{ resource: f.cwd_ref, mode: 'write' }],
        process_effects: ['process.spawn', `fs.write:${f.cwd_ref}`],
        issued_at: 0,
      });
    const blocked = f.host.invoke(grant(), SHELL_RUN.id, f.request());
    assert.equal(blocked.kind, 'rejected');
    if (blocked.kind === 'rejected') assert.equal(blocked.code, 'DENIED');
    const invalid = await f.host.invokeCliGeneration(grant(), {});
    assert.equal(invalid.kind, 'rejected');
    if (invalid.kind === 'rejected') assert.equal(invalid.code, 'INVALID_INPUT');
    assert.equal(f.host.coordinator.held().length, 0);
    const retry = f.host.invoke(grant(), SHELL_RUN.id, f.request());
    assert.equal(retry.kind, 'handle');
    if (retry.kind !== 'handle') throw new Error('expected CLI invocation handle');
    f.host.release(action_id);
    assert.equal((await retry.result).outcome, 'succeeded');
    assert.equal(f.host.coordinator.held().length, 0);
  });

  it('protects pending invocation identities and preserves cancellation during asynchronous inspection', async (t) => {
    const f = fixture(t);
    await f.host.cliRecoveryReady;
    const other = join(f.workspace, 'other');
    mkdirSync(other);
    const other_ref = f.host.registerWorkspace(other);
    const grant = (cwd_ref: string) =>
      f.authority.issue({
        action_id: 'shell-cli:pending',
        operation: SHELL_RUN.id,
        contract_rev: SHELL_RUN.revision,
        permissions: [{ resource: cwd_ref, mode: 'write' }],
        effects: [{ resource: cwd_ref, mode: 'write' }],
        process_effects: ['process.spawn', `fs.write:${cwd_ref}`],
        issued_at: 0,
      });
    const pending = f.host.invokeCliGeneration(grant(f.cwd_ref), f.request());
    f.host.requestCancel('shell-cli:pending');
    const duplicate = await f.host.invokeCliGeneration(grant(other_ref), { ...f.request(), cwd_ref: other_ref });
    assert.equal(duplicate.kind, 'rejected');
    const first = await pending;
    assert.equal(first.kind, 'handle');
    assert.equal(f.host.coordinator.held().length, 1);
    if (first.kind !== 'handle') return;
    f.host.release(first.action_id);
    assert.deepEqual(await first.result, { outcome: 'failed', failure: 'cancelled' });
    assert.equal(f.host.coordinator.held().length, 0);
    assert.equal(f.store.getInvocation(first.invocation_id)?.cancel_requested, true);
  });

  it('maps an operation reconciliation block to a held failure with a hint', async (t) => {
    const f = fixture(t);
    f.store.persistInvocationStart({
      invocation_id: 'legacy',
      action_id: 'legacy',
      operation: 'shell.run@1',
      binding_digest: 'legacy',
      inputs: {},
      status: 'running',
      outcome: null,
      cancel_requested: false,
    });
    await f.reopen();
    const result = await f.spawn().run(f.request());
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'workspace_held');
    assert.match(Reflect.get(result, 'hint') ?? '', /examples\/cli-generations\.ts/);
  });

  it('records null and keeps the hold when a workspace exceeds the byte cap', async (t) => {
    const f = fixture(t);
    const file = join(f.workspace, 'over-cap');
    writeFileSync(file, '');
    truncateSync(file, 64 * 1024 * 1024 + 1);
    f.setProbe('gone');
    await f.cancel();
    const record = f.store.invocationRecords()[0]!;
    assert.equal(record.cli_generation?.before_snapshot, null);
    assert.equal(f.host.listUncertainCliGenerations()[0]?.startup_check, 'snapshot_unavailable');
    await f.reopen();
    assert.equal(f.host.coordinator.held().length, 1);
    assert.equal(f.store.getInvocation(record.invocation_id)?.reconciliation, undefined);
  });

  it('keeps a failed automatic reconciliation uncertain and retries safely on another restart', async (t) => {
    const f = fixture(t);
    await f.cancel();
    const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
    assert.ok(id);
    await f.reopen((store) => {
      store.persistInvocationReconciliation = () => {
        throw new Error('injected append failure');
      };
    });
    assert.equal(f.host.listUncertainCliGenerations()[0]?.startup_check, 'check_failed');
    assert.equal(f.host.coordinator.held().length, 1);
    assert.equal(f.store.getInvocation(id)?.reconciliation, undefined);
    await f.reopen();
    assert.equal(f.store.getInvocation(id)?.reconciliation?.resolution, 'not_committed');
    assert.equal(f.host.coordinator.held().length, 0);
  });

  it('distinguishes active effect conflicts and refuses reconciliation of running generations', async (t) => {
    const f = fixture(t);
    const marker = join(f.workspace, 'started');
    const abort = new AbortController();
    const pending = f.spawn().run({ ...f.request([process.execPath, STUB, '--sleep', marker]), signal: abort.signal });
    while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
    const record = f.store.invocationRecords().find((record) => record.status === 'running');
    assert.ok(record);
    try {
      assert.equal(f.host.listUncertainCliGenerations().length, 0);
      assert.throws(() => f.host.reconcileCliGeneration(record.invocation_id, ABSENT), /active/);
      const conflict = await f.spawn().run(f.request());
      if (conflict.status !== 'failed') throw new Error('expected active conflict');
      assert.equal(conflict.failure, 'effect_conflict');
      assert.equal(conflict.held_by, record.invocation_id);
      assert.equal(f.host.coordinator.held().length, 1);
    } finally {
      abort.abort();
      await pending;
    }
    f.host.reconcileCliGeneration(record.invocation_id, ABSENT);
    assert.equal((await f.spawn().run(f.request())).status, 'completed');
  });

  it('validates durable before-snapshot evidence and prevents replacement after start', async (t) => {
    const f = fixture(t);
    await f.cancel();
    const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
    assert.ok(id);
    const record = f.store.getInvocation(id);
    assert.ok(record?.cli_generation);
    const snapshot = f.store.snapshot();
    assert.throws(
      () =>
        f.store.persistInvocationStart({
          ...record,
          invocation_id: 'bad',
          cli_generation: { cwd_ref: f.cwd_ref, before_snapshot: 'not-a-digest' },
        }),
      /invalid/,
    );
    const withoutEvidence = { ...record };
    delete withoutEvidence.cli_generation;
    assert.throws(() => f.store.persistInvocationStart(withoutEvidence), /evidence transition/);
    assert.throws(
      () =>
        f.store.persistInvocationResult({
          ...record,
          cli_generation: { cwd_ref: f.cwd_ref, before_snapshot: '0'.repeat(64) },
        }),
      /evidence transition/,
    );
    assert.deepEqual(f.store.snapshot(), snapshot);
    assert.equal(f.host.coordinator.held().length, 1);
  });

  it('rejects invalid or replaced durable process-group evidence', async (t) => {
    const f = fixture(t);
    await f.cancel();
    const record = f.store.invocationRecords()[0]!;
    const before = f.store.snapshot();
    for (const pgid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      assert.throws(
        () =>
          f.store.persistInvocationStart({
            ...record,
            invocation_id: 'bad-pgid',
            cli_generation: { ...record.cli_generation!, pgid },
          }),
        /invalid/,
      );
    }
    assert.throws(() => f.store.persistCliGenerationStarted(record.invocation_id, 123), /transition/);
    assert.throws(
      () => f.store.persistInvocationResult({ ...record, cli_generation: { ...record.cli_generation!, pgid: 123 } }),
      /evidence transition/,
    );
    assert.deepEqual(f.store.snapshot(), before);
  });

  it('keeps uncertainty if recording the spawned process group fails', async (t) => {
    const f = fixture(t);
    f.setProbe('gone');
    f.store.persistCliGenerationStarted = () => {
      throw new Error('injected pgid append failure');
    };
    const result = await f.spawn().run({ ...f.request([process.execPath, STUB, '--sleep']), timeout_ms: 200 });
    assert.equal(result.status, 'uncertain');
    assert.equal(f.host.listUncertainCliGenerations()[0]?.startup_check, 'process_group_unknown');
    assert.equal(f.host.coordinator.held().length, 1);
  });

  for (const access of ['snapshot', 'lookup'] as const) {
    it(`detaches CLI snapshot evidence returned by ${access}`, async (t) => {
      const f = fixture(t);
      await f.cancel();
      const id = f.host.listUncertainCliGenerations()[0]?.invocation_id;
      assert.ok(id);
      const original = f.store.getInvocation(id)?.cli_generation?.before_snapshot;
      assert.ok(original);
      const exposed =
        access === 'snapshot'
          ? f.store.snapshot().invocations.find((r) => r.invocation_id === id)
          : f.store.getInvocation(id);
      assert.ok(exposed?.cli_generation);
      (exposed.cli_generation as { before_snapshot: string | null }).before_snapshot = '0'.repeat(64);
      assert.equal(f.store.getInvocation(id)?.cli_generation?.before_snapshot, original);
    });
  }
});
