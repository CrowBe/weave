import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createGrantAuthority, type Grant } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, SHELL_RUN, createGrantedCliSpawn } from '@weave/agentfabric';
import { digest } from '../src/digest.js';

type Wait = 'recovery' | 'startup check';
type RecoveryChecks = { checkUncertainCliGenerations(cwd_ref?: string): Promise<void> };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(
  t: TestContext,
  wait?: Wait,
  existingStatus?: 'running' | 'uncertain' | 'committed' | 'stopped',
) {
  const dir = mkdtempSync(join(tmpdir(), 'weave-cli-pending-cancel-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const path = join(dir, 'fabric.jsonl');
  const authority = createGrantAuthority();
  const gate = deferred();
  const shell = {
    env: { lookup: () => undefined },
    clock: { now: () => 1000 },
    timer: {
      sleep: (_ms: number, signal?: AbortSignal) => {
        if (!signal) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(new Error('aborted'));
          else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    },
  };
  const recovery =
    wait === 'recovery'
      ? t.mock.method(
          AgentFabricHost.prototype as unknown as RecoveryChecks,
          'checkUncertainCliGenerations',
          () => gate.promise,
        )
      : undefined;
  let store = new FabricStore(undefined, path);
  let host = new AgentFabricHost({ authority, store, shell, cliProcessGroupProbe: () => 'unknown' });
  const cwd_ref = host.registerWorkspace(workspace);
  const request = (ref = cwd_ref) => ({
    argv: [process.execPath, '-e', 'void 0'],
    cwd_ref: ref,
    env_allow: [],
    timeout_ms: 60_000,
    stdin: '',
  });
  if (existingStatus) {
    const record = {
      invocation_id: 'shell-cli:existing',
      action_id: 'shell-cli:existing',
      operation: SHELL_RUN.id,
      binding_digest: digest({ operation: SHELL_RUN.id, inputs: request() }),
      inputs: request(),
      status: 'running' as const,
      outcome: null,
      cancel_requested: false,
      reservation: [{ resource: store.lookupRef(cwd_ref)!.canonical_id, mode: 'write' as const }],
      cli_generation: { cwd_ref, before_snapshot: null },
    };
    store.persistInvocationStart(record);
    if (existingStatus === 'uncertain') {
      store.persistInvocationUncertain({
        ...record,
        status: 'uncertain',
        outcome: { outcome: 'uncertain', reason: 'existing effects require reconciliation' },
      });
    } else if (existingStatus === 'committed') {
      store.persistInvocationResult({
        ...record,
        status: 'committed',
        outcome: { outcome: 'succeeded', output: { receipt: 'existing effect' } },
      });
    } else if (existingStatus === 'stopped') {
      store.persistInvocationReconciliation({
        ...record,
        status: 'stopped',
        outcome: { outcome: 'failed', failure: 'reconciled: not committed' },
        reconciliation: { resolution: 'not_committed', evidence: 'existing execution confirmed stopped' },
      });
    }
    store.close();
    store = new FabricStore(undefined, path);
    host = new AgentFabricHost({ authority, store, shell, cliProcessGroupProbe: () => 'unknown' });
  }
  if (wait !== 'recovery') await host.cliRecoveryReady;
  if (wait === 'startup check') {
    store.persistInvocationStart({
      invocation_id: 'legacy',
      action_id: 'legacy',
      operation: SHELL_RUN.id,
      binding_digest: 'legacy',
      inputs: {},
      status: 'running',
      outcome: null,
      cancel_requested: false,
    });
    store.close();
    store = new FabricStore(undefined, path);
    host = new AgentFabricHost({ authority, store, shell, cliProcessGroupProbe: () => 'unknown' });
    await host.cliRecoveryReady;
    t.mock.method(host as unknown as RecoveryChecks, 'checkUncertainCliGenerations', () => gate.promise);
  }
  const originalSpawn = childProcess.spawn;
  const spawn = t.mock.method(childProcess, 'spawn', originalSpawn);
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const grant = (action_id: string, ref = cwd_ref) =>
    authority.issue({
      action_id,
      operation: SHELL_RUN.id,
      contract_rev: SHELL_RUN.revision,
      permissions: [{ resource: ref, mode: 'write' }],
      effects: [{ resource: ref, mode: 'write' }],
      process_effects: ['process.spawn', `fs.write:${ref}`],
      issued_at: 0,
    });
  const clearLegacy = () => {
    if (wait === 'startup check' && !store.getInvocation('legacy')?.reconciliation) {
      host.reconcileCliGeneration('legacy', {
        resolution: 'not_committed',
        evidence: 'test legacy hold has no process',
        force_with_evidence: true,
      });
    }
  };
  const resume = () => {
    clearLegacy();
    gate.resolve();
  };
  const reopen = async () => {
    recovery?.mock.restore();
    clearLegacy();
    store.close();
    store = new FabricStore(undefined, path);
    host = new AgentFabricHost({ authority, store, shell, cliProcessGroupProbe: () => 'unknown' });
    await host.cliRecoveryReady;
  };
  return {
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    authority,
    gate,
    spawn,
    workspace,
    cwd_ref,
    grant,
    request,
    resume,
    reopen,
    run: (ref = cwd_ref, signal?: AbortSignal) =>
      createGrantedCliSpawn({ host, authority }).run({ ...request(ref), ...(signal ? { signal } : {}) }),
  };
}

describe('CLI cancellation before prepare', () => {
  for (const invalid of ['legacy reconciliation', 'unresolved', 'unknown cwd_ref', 'wrong cwd_ref kind'] as const) {
    it(`rejects ${invalid} before consuming a grant with pending cancellation`, async (t) => {
      const f = await fixture(t, invalid === 'legacy reconciliation' ? 'startup check' : 'recovery');
      const status = (f.host as unknown as { status: Map<string, string> }).status;
      if (invalid === 'unresolved') status.set(SHELL_RUN.id, 'unresolved');
      const ref =
        invalid === 'unknown cwd_ref'
          ? 'workspace:unknown'
          : invalid === 'wrong cwd_ref kind'
            ? f.host.registerSource('mem:source', 'source content')
            : f.cwd_ref;
      const inputs = f.request(ref);
      const consume = t.mock.method(f.authority, 'markInvoked');
      const expected = f.host.invoke(f.grant('shell-cli:ordinary-validation', ref), SHELL_RUN.id, inputs);
      assert.equal(expected.kind, 'rejected');
      if (expected.kind !== 'rejected') return;
      assert.equal(
        expected.code,
        invalid === 'legacy reconciliation'
          ? 'RESOLVER_ERROR'
          : invalid === 'unresolved'
            ? 'UNRESOLVED'
            : invalid === 'unknown cwd_ref'
              ? 'UNKNOWN_RESOURCE'
              : 'KIND_MISMATCH',
      );
      const id = 'shell-cli:preparation-validation';
      const grant = f.grant(id, ref);
      assert.equal(consume.mock.callCount(), 0, 'ordinary rejection must precede consumption too');
      const pending = f.host.invokeCliGeneration(grant, inputs);
      assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
      // Keep the legacy reconciliation gate closed when the startup check returns.
      f.gate.resolve();
      assert.deepEqual(await pending, expected);
      assert.equal(consume.mock.callCount(), 0);
      assert.equal(f.authority.markInvoked(grant), true, 'rejection must not consume the grant');
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.store.getInvocation(id), undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.host.openCount(), 0);
      status.set(SHELL_RUN.id, 'resolved');
      f.resume();
      const fresh = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(fresh.kind, 'handle', 'rejection must release the identity reservation');
      if (fresh.kind !== 'handle') return;
      f.host.release(id);
      assert.equal((await fresh.result).outcome, 'succeeded');
      assert.equal(f.store.getInvocation(id)?.cancel_requested, false);
    });
  }

  for (const invalid of [
    'operation',
    'contract revision',
    'permissions',
    'effects',
    'process effects',
    'input shape',
    'shell input',
  ] as const) {
    it(`rejects ${invalid} before consuming a grant with pending cancellation`, async (t) => {
      const f = await fixture(t, 'recovery');
      const id = 'shell-cli:invalid';
      const fields = f.grant(id);
      const grant = f.authority.issue({
        ...fields,
        ...(invalid === 'operation' ? { operation: 'repo.test' } : {}),
        ...(invalid === 'contract revision' ? { contract_rev: 'wrong-revision' } : {}),
        ...(invalid === 'permissions' ? { permissions: [] } : {}),
        ...(invalid === 'effects' ? { effects: [] } : {}),
        ...(invalid === 'process effects' ? { process_effects: [] } : {}),
      });
      const inputs = {
        ...f.request(),
        ...(invalid === 'input shape' ? { timeout_ms: 'invalid' } : {}),
        ...(invalid === 'shell input' ? { argv: [] } : {}),
      };
      const expected = f.host.invoke(grant, SHELL_RUN.id, inputs);
      assert.equal(expected.kind, 'rejected');
      const consume = t.mock.method(f.authority, 'markInvoked');
      const pending = f.host.invokeCliGeneration(grant, inputs);
      assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
      f.resume();
      assert.deepEqual(await pending, expected);
      assert.equal(consume.mock.callCount(), 0);
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.store.getInvocation(id), undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.host.openCount(), 0);
      assert.equal(f.authority.markInvoked(grant), true, 'rejection must not consume the grant');
      const fresh = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(fresh.kind, 'handle', 'rejection must release the identity reservation');
      if (fresh.kind !== 'handle') return;
      f.host.release(id);
      assert.equal((await fresh.result).outcome, 'succeeded');
    });
  }

  for (const invalid of [
    'revoked',
    'not issued',
    'revoked during consumption',
    'not issued during consumption',
  ] as const) {
    it(`reports ${invalid} accurately with pending cancellation`, async (t) => {
      const f = await fixture(t, 'recovery');
      const id = 'shell-cli:invalid-authority';
      const issued = f.grant(id);
      const grant = invalid === 'not issued' ? { ...issued } : issued;
      if (invalid === 'revoked') f.authority.revoke(grant);
      const markInvoked = f.authority.markInvoked.bind(f.authority);
      const consume = t.mock.method(
        f.authority,
        'markInvoked',
        (candidate: Grant) => {
          if (invalid === 'revoked during consumption') f.authority.revoke(candidate);
          if (invalid === 'not issued during consumption') {
            t.mock.method(f.authority, 'isIssued', () => false, { times: 1 });
            return false;
          }
          return markInvoked(candidate);
        },
        { times: 1 },
      );
      const pending = f.host.invokeCliGeneration(grant, f.request());
      assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
      f.resume();
      const result = await pending;
      assert.equal(result.kind, 'rejected');
      if (result.kind === 'rejected') {
        assert.equal(result.code, 'DENIED');
        assert.match(result.reason, invalid.startsWith('revoked') ? /revoked/ : /not.*issued/);
      }
      assert.equal(consume.mock.callCount(), invalid.includes('during consumption') ? 1 : 0);
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.store.getInvocation(id), undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.host.openCount(), 0);
      const fresh = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(fresh.kind, 'handle', 'rejection must release the identity reservation');
      if (fresh.kind !== 'handle') return;
      f.host.release(id);
      assert.equal((await fresh.result).outcome, 'succeeded');
    });
  }

  for (const wait of ['recovery', 'startup check'] as const) {
    it(`retains request.signal abort while awaiting ${wait}, without a durable record or spawn`, async (t) => {
      const f = await fixture(t, wait);
      const controller = new AbortController();
      const pending = f.run(f.cwd_ref, controller.signal);
      controller.abort();
      f.resume();
      const result = await pending;
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') assert.equal(result.failure, 'cancelled');
      assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.host.openCount(), 0);
      await f.reopen();
      assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
      assert.deepEqual(f.host.listUncertainCliGenerations(), []);
    });

    it(`keeps a concurrent generation unaffected by request.signal abort during ${wait}`, async (t) => {
      const f = await fixture(t, wait);
      const other = join(f.workspace, '..', 'other');
      mkdirSync(other);
      const other_ref = f.host.registerWorkspace(other);
      const controller = new AbortController();
      const first = f.run(f.cwd_ref, controller.signal);
      const second = f.run(other_ref);
      controller.abort();
      f.resume();
      const [cancelled, completed] = await Promise.all([first, second]);
      assert.equal(cancelled.status, 'failed');
      if (cancelled.status === 'failed') assert.equal(cancelled.failure, 'cancelled');
      assert.equal(completed.status, 'completed');
      assert.equal(f.spawn.mock.callCount(), 1);
      assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
      assert.equal(f.store.getInvocation('shell-cli:1')?.status, 'committed');
      assert.equal(f.host.coordinator.held().length, 0);
    });

    it(`removes the request.signal listener when ${wait} rejects`, async (t) => {
      const f = await fixture(t, wait);
      const controller = new AbortController();
      const add = t.mock.method(controller.signal, 'addEventListener');
      const remove = t.mock.method(controller.signal, 'removeEventListener');
      const cancel = t.mock.method(f.host, 'requestCancel');
      const pending = f.run(f.cwd_ref, controller.signal);
      const rejected = assert.rejects(pending, /injected startup failure/);
      f.gate.reject(new Error('injected startup failure'));
      await rejected;
      assert.equal(add.mock.callCount(), 1);
      assert.equal(remove.mock.callCount(), 1);
      assert.equal(remove.mock.calls[0]!.arguments[1], add.mock.calls[0]!.arguments[1]);
      controller.abort();
      assert.equal(cancel.mock.callCount(), 0);
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.host.coordinator.held().length, 0);
    });

    for (const status of ['uncertain', 'running', 'committed', 'stopped'] as const) {
      it(`replays an existing ${status} record unchanged when cancelled during ${wait}`, async (t) => {
        const f = await fixture(t, wait, status);
        const id = 'shell-cli:existing';
        const before = f.store.getInvocation(id)!;
        assert.equal(before.status, status === 'running' ? 'uncertain' : status);
        const pending = f.host.invokeCliGeneration(f.grant(id), f.request());
        assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
        f.resume();
        const replay = await pending;
        assert.equal(replay.kind, 'handle');
        if (replay.kind !== 'handle') return;
        assert.deepEqual(await replay.result, before.outcome);
        assert.deepEqual(f.store.getInvocation(id), {
          ...before,
          cancel_requested: status !== 'stopped',
        });
        assert.equal(f.spawn.mock.callCount(), 0);
        assert.equal(f.host.invocations.length, 0, 'replay must not start an invocation');
        assert.equal(f.host.openCount(), 0);
        assert.deepEqual(
          f.host.coordinator.held().map((hold) => hold.invocation_id),
          status === 'uncertain' || status === 'running' ? [id] : [],
        );
      });
    }

    it(`retains double cancellation while awaiting ${wait}, without a durable record or spawn`, async (t) => {
      const f = await fixture(t, wait);
      const pending = f.run();
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
      assert.deepEqual(f.host.requestCancel('shell-cli:0'), { acknowledged: true });
      assert.deepEqual(f.host.requestCancel('shell-cli:0'), { acknowledged: true });
      assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
      f.resume();
      const result = await pending;
      assert.equal(f.spawn.mock.callCount(), 0, 'cancelled preparation must never call process.spawn');
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') assert.equal(result.failure, 'cancelled');
      assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.host.openCount(), 0);
      await f.reopen();
      assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
      assert.deepEqual(f.host.listUncertainCliGenerations(), []);
      assert.equal(f.host.coordinator.held().length, 0);
    });

    it(`cleans up a pending cancel when ${wait} rejects`, async (t) => {
      const f = await fixture(t, wait);
      const id = 'shell-cli:retry';
      const pending = f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
      const rejected = assert.rejects(pending, /injected startup failure/);
      f.gate.reject(new Error('injected startup failure'));
      await rejected;
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.store.getInvocation(id), undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      // An ordinary invocation bypasses the failed startup promise and proves
      // that both the placeholder and its identity reservation were released.
      f.resume();
      const retry = f.host.invoke(f.grant(id), SHELL_RUN.id, f.request());
      assert.equal(retry.kind, 'handle');
      if (retry.kind !== 'handle') return;
      f.host.release(id);
      assert.equal((await retry.result).outcome, 'succeeded');
      assert.equal(f.spawn.mock.callCount(), 1);
      assert.equal(f.host.coordinator.held().length, 0);
    });

    it(`cancels only one of two concurrent generations awaiting ${wait}`, async (t) => {
      const f = await fixture(t, wait);
      const other = join(f.workspace, '..', 'other');
      mkdirSync(other);
      const other_ref = f.host.registerWorkspace(other);
      const first = f.run();
      const second = f.run(other_ref);
      assert.deepEqual(f.host.requestCancel('shell-cli:0'), { acknowledged: true });
      f.resume();
      const [cancelled, completed] = await Promise.all([first, second]);
      assert.equal(cancelled.status, 'failed');
      if (cancelled.status === 'failed') assert.equal(cancelled.failure, 'cancelled');
      assert.equal(completed.status, 'completed');
      assert.equal(f.spawn.mock.callCount(), 1);
      assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
      assert.equal(f.store.getInvocation('shell-cli:1')?.status, 'committed');
      assert.equal(f.host.coordinator.held().length, 0);
    });

    it(`consumes the grant when cancellation races ${wait} completion, including across reopen`, async (t) => {
      const f = await fixture(t, wait);
      const id = 'shell-cli:reuse';
      const grant = f.grant(id);
      const pending = f.host.invokeCliGeneration(grant, f.request());
      f.resume();
      assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
      const first = await pending;
      assert.deepEqual(first, { kind: 'cancelled', invocation_id: id });
      for (const reopened of [false, true]) {
        if (reopened) await f.reopen();
        const retry = await f.host.invokeCliGeneration(grant, f.request());
        // Drive a wrongly accepted retry to expose an actual unwanted spawn.
        if (retry.kind === 'handle') {
          f.host.release(id);
          await retry.result;
        }
        assert.equal(retry.kind, 'rejected');
        if (retry.kind === 'rejected') {
          assert.equal(retry.code, 'DENIED');
          assert.match(retry.reason, /grant.*(used|consumed)/);
        }
        const ordinary = f.host.invoke(grant, SHELL_RUN.id, f.request());
        assert.equal(ordinary.kind, 'rejected');
        if (ordinary.kind === 'rejected') assert.equal(ordinary.code, 'DENIED');
        assert.equal(f.spawn.mock.callCount(), 0);
        assert.equal(f.store.getInvocation(id), undefined);
        assert.equal(f.host.coordinator.held().length, 0);
        assert.equal(f.host.openCount(), 0);
      }
      const freshId = 'shell-cli:fresh';
      const fresh = await f.host.invokeCliGeneration(f.grant(freshId), f.request());
      assert.equal(fresh.kind, 'handle');
      if (fresh.kind !== 'handle') return;
      f.host.release(freshId);
      assert.equal((await fresh.result).outcome, 'succeeded');
      assert.equal(f.store.getInvocation(freshId)?.cancel_requested, false);
      assert.equal(f.spawn.mock.callCount(), 1);
    });

    it(`refuses concurrent reuse of the cancelled grant while awaiting ${wait}`, async (t) => {
      const f = await fixture(t, wait);
      const grant = f.grant('shell-cli:race');
      const pending = f.host.invokeCliGeneration(grant, f.request());
      assert.deepEqual(f.host.requestCancel(grant.action_id), { acknowledged: true });
      const duplicate = await f.host.invokeCliGeneration(grant, f.request());
      assert.equal(duplicate.kind, 'rejected');
      if (duplicate.kind === 'rejected') assert.equal(duplicate.code, 'DENIED');
      f.resume();
      assert.deepEqual(await pending, { kind: 'cancelled', invocation_id: grant.action_id });
      const reuse = await f.host.invokeCliGeneration(grant, f.request());
      if (reuse.kind === 'handle') {
        f.host.release(grant.action_id);
        await reuse.result;
      }
      assert.equal(reuse.kind, 'rejected');
      if (reuse.kind === 'rejected') assert.equal(reuse.code, 'DENIED');
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.store.getInvocation(grant.action_id), undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.host.openCount(), 0);
    });
  }

  it('consumes before releasing the pending identity reservation', async (t) => {
    const f = await fixture(t, 'recovery');
    const grant = f.grant('shell-cli:consume');
    const markInvoked = f.authority.markInvoked.bind(f.authority);
    const consume = t.mock.method(f.authority, 'markInvoked', (issued: Grant) => {
      const duplicate = f.host.invoke(issued, SHELL_RUN.id, f.request());
      assert.equal(duplicate.kind, 'rejected');
      if (duplicate.kind === 'rejected') assert.match(duplicate.reason, /already active/);
      return markInvoked(issued);
    });
    const pending = f.host.invokeCliGeneration(grant, f.request());
    f.host.requestCancel(grant.action_id);
    f.resume();
    assert.deepEqual(await pending, { kind: 'cancelled', invocation_id: grant.action_id });
    assert.equal(consume.mock.callCount(), 1);
    assert.equal(markInvoked(grant), false);
    assert.equal(f.host.coordinator.held().length, 0);
    assert.equal(f.spawn.mock.callCount(), 0);
  });

  for (const fault of ['already consumed', 'consume throws', 'persist throws after consume'] as const) {
    it(`fails closed and releases the pending reservation when ${fault}`, async (t) => {
      const f = await fixture(t, 'recovery');
      const id = 'shell-cli:consume-failure';
      const grant = f.grant(id);
      const markInvoked = f.authority.markInvoked.bind(f.authority);
      if (fault === 'already consumed') assert.equal(markInvoked(grant), true);
      else {
        t.mock.method(
          f.authority,
          'markInvoked',
          (issued: Grant) => {
            if (fault === 'persist throws after consume') markInvoked(issued);
            throw new Error('injected grant consumption failure');
          },
          { times: 1 },
        );
      }
      const pending = f.host.invokeCliGeneration(grant, f.request());
      f.host.requestCancel(id);
      const failed =
        fault === 'already consumed' ? undefined : assert.rejects(pending, /injected grant consumption failure/);
      f.resume();
      if (failed) await failed;
      else {
        const result = await pending;
        assert.equal(result.kind, 'rejected');
        if (result.kind === 'rejected') assert.equal(result.code, 'DENIED');
      }
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.store.getInvocation(id), undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.host.openCount(), 0);
      // A new grant at the same identity proves that cleanup released the reservation.
      const fresh = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(fresh.kind, 'handle');
      if (fresh.kind !== 'handle') return;
      f.host.release(id);
      assert.equal((await fresh.result).outcome, 'succeeded');
      assert.equal(f.host.coordinator.held().length, 0);
    });
  }

  it('does not spawn or write a durable record when request.signal is already aborted', async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    controller.abort();
    const result = await f.run(f.cwd_ref, controller.signal);
    assert.equal(f.spawn.mock.callCount(), 0);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.failure, 'cancelled');
    assert.equal(f.store.getInvocation('shell-cli:0'), undefined);
    assert.equal(f.host.coordinator.held().length, 0);
  });

  for (const settlement of ['completed', 'cancelled', 'rejected'] as const) {
    it(`removes the request.signal listener after ${settlement}, with no late effect on a later generation`, async (t) => {
      const f = await fixture(t, settlement === 'cancelled' ? 'recovery' : undefined);
      const controller = new AbortController();
      const add = t.mock.method(controller.signal, 'addEventListener');
      const remove = t.mock.method(controller.signal, 'removeEventListener');
      const cancel = t.mock.method(f.host, 'requestCancel');
      if (settlement === 'rejected') {
        t.mock.method(f.authority, 'isValid', () => false, { times: 1 });
      }
      const pending = f.run(f.cwd_ref, controller.signal);
      if (settlement === 'cancelled') {
        controller.abort();
        f.resume();
      }
      const result = await pending;
      assert.equal(result.status, settlement === 'completed' ? 'completed' : 'failed');
      assert.equal(add.mock.callCount(), 1);
      assert.equal(remove.mock.callCount(), 1);
      assert.equal(remove.mock.calls[0]!.arguments[1], add.mock.calls[0]!.arguments[1]);
      const cancellations = cancel.mock.callCount();
      // A cancelled, non-durable identity can be reused; a stale listener must
      // not cancel it or mutate the record of an already completed invocation.
      const id = settlement === 'cancelled' ? 'shell-cli:0' : 'shell-cli:later';
      const later = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(later.kind, 'handle');
      if (later.kind !== 'handle') return;
      const before = f.store.invocationRecords();
      controller.abort();
      assert.equal(cancel.mock.callCount(), cancellations);
      assert.deepEqual(f.store.invocationRecords(), before);
      f.host.release(id);
      assert.equal((await later.result).outcome, 'succeeded');
      assert.equal(f.host.coordinator.held().length, 0);
    });
  }

  it('retains cancellation of an allocated identity before invokeCliGeneration installs its placeholder', async (t) => {
    const f = await fixture(t);
    const id = f.host.nextCliGenerationId();
    assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
    const first = await f.host.invokeCliGeneration(f.grant(id), f.request());
    if (first.kind === 'handle') {
      f.host.release(id);
      await first.result;
    }
    assert.equal(f.spawn.mock.callCount(), 0);
    assert.equal(f.store.getInvocation(id), undefined);
    assert.equal(f.host.coordinator.held().length, 0);
  });

  for (const rejection of ['DENIED', 'conflict'] as const) {
    it(`never spawns or leaks a reservation when cancellation races prepare ${rejection}`, async (t) => {
      const f = await fixture(t, 'recovery');
      const id = 'shell-cli:rejected';
      const grant = f.grant(id);
      if (rejection === 'DENIED') f.authority.revoke(grant);
      else {
        const canonical_id = f.store.lookupRef(f.cwd_ref)!.canonical_id;
        f.host.coordinator.acquire('other', [{ resource: f.cwd_ref, mode: 'write' }], () => canonical_id);
      }
      // Retain the cancellation inside prepare, after its preflight cancel check.
      const method = rejection === 'DENIED' ? 'isValid' : 'markInvoked';
      const original = f.authority[method].bind(f.authority);
      t.mock.method(
        f.authority,
        method,
        (issued: Grant) => {
          assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
          return original(issued);
        },
        { times: 1 },
      );
      const pending = f.host.invokeCliGeneration(grant, f.request());
      f.resume();
      const result = await pending;
      assert.equal(result.kind, 'rejected');
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.store.getInvocation(id), undefined);
      assert.ok(f.host.coordinator.held().every((hold) => hold.invocation_id === 'other'));
      f.host.coordinator.release('other');
      const retry = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(retry.kind, 'handle');
      if (retry.kind !== 'handle') return;
      f.host.release(id);
      assert.equal((await retry.result).outcome, 'succeeded');
      assert.equal(f.host.coordinator.held().length, 0);
    });
  }

  it('seeds the open cancellation flag when a host callback cancels the placeholder during prepare', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:prepare-callback';
    const markInvoked = f.authority.markInvoked.bind(f.authority);
    t.mock.method(f.authority, 'markInvoked', (grant: Grant) => {
      assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
      return markInvoked(grant);
    });
    const handle = await f.host.invokeCliGeneration(f.grant(id), f.request());
    assert.equal(handle.kind, 'handle');
    if (handle.kind !== 'handle') return;
    f.host.release(id);
    assert.deepEqual(await handle.result, { outcome: 'failed', failure: 'cancelled' });
    assert.equal(f.spawn.mock.callCount(), 0);
    assert.equal(f.store.getInvocation(id)?.status, 'stopped');
    assert.equal(f.store.getInvocation(id)?.cancel_requested, true);
    assert.equal(f.host.coordinator.held().length, 0);
  });

  it('preserves the unknown-id acknowledgement without cancelling a future invocation with that id', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:unknown';
    assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
    const result = await f.host.invokeCliGeneration(f.grant(id), f.request());
    assert.equal(result.kind, 'handle');
    if (result.kind !== 'handle') return;
    f.host.release(id);
    assert.equal((await result.result).outcome, 'succeeded');
    assert.equal(f.spawn.mock.callCount(), 1);
    assert.equal(f.host.coordinator.held().length, 0);
  });

  it('preserves the uncertain write hold when cancellation follows a confirmed spawn', async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const started = deferred();
    const persist = f.store.persistCliGenerationStarted.bind(f.store);
    t.mock.method(f.store, 'persistCliGenerationStarted', (id: string, pgid: number) => {
      persist(id, pgid);
      started.resolve();
    });
    const pending = createGrantedCliSpawn({ host: f.host, authority: f.authority }).run({
      ...f.request(),
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 'uncertain');
    if (result.status === 'uncertain') assert.equal(result.reason, 'cancelled');
    assert.equal(f.spawn.mock.callCount(), 1);
    assert.equal(f.store.getInvocation('shell-cli:0')?.status, 'uncertain');
    assert.equal(f.host.coordinator.held().length, 1);
    await f.reopen();
    assert.equal(f.host.listUncertainCliGenerations()[0]?.invocation_id, 'shell-cli:0');
    assert.equal(f.host.coordinator.held().length, 1);
  });

  for (const phase of ['inspection', 'durable start'] as const) {
    it(`keeps cancellation after ${phase} stopped across reopen and rejects contradictory uncertainty`, async (t) => {
      const f = await fixture(t);
      const id = 'shell-cli:prepared';
      const grant = f.grant(id);
      const pending = f.host.invokeCliGeneration(grant, f.request());
      assert.equal(f.host.coordinator.held().length, 1);
      if (phase === 'inspection') f.host.requestCancel(id);
      const handle = await pending;
      assert.equal(handle.kind, 'handle');
      if (handle.kind !== 'handle') return;
      if (phase === 'durable start') f.host.requestCancel(id);
      assert.equal(f.store.getInvocation(id)?.cancel_requested, true);
      f.host.release(id);
      assert.deepEqual(await handle.result, { outcome: 'failed', failure: 'cancelled' });
      assert.equal(f.spawn.mock.callCount(), 0);
      const record = f.store.getInvocation(id)!;
      assert.equal(record.status, 'stopped');
      assert.equal(record.cli_generation?.pgid, undefined);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.throws(
        () =>
          f.store.persistInvocationUncertain({
            ...record,
            status: 'uncertain',
            outcome: { outcome: 'uncertain', reason: 'contradictory' },
          }),
        /transition/,
      );
      await f.reopen();
      assert.equal(f.store.getInvocation(id)?.status, 'stopped');
      assert.deepEqual(f.host.lookup(id, grant), {
        status: 'stopped',
        outcome: { outcome: 'failed', failure: 'cancelled' },
      });
      assert.deepEqual(f.host.listUncertainCliGenerations(), []);
      assert.equal(f.host.coordinator.held().length, 0);
    });
  }
});
