import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createGrantAuthority, type Grant } from '@weave/agentsop';
import {
  AgentFabricHost,
  FabricStore,
  SHELL_RUN,
  type InvocationRecord,
  type WeftRecordShape,
} from '@weave/agentfabric';
import { digest } from '../src/digest.js';

type RecoveryChecks = { checkUncertainCliGenerations(cwd_ref?: string): Promise<void> };

const AUTOMATIC = /automatic reconciliation on re-run/;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'weave-cli-rerun-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  // Outside the workspace: installing it does not change the workspace snapshot.
  const tool = join(dir, 'tool');
  const path = join(dir, 'fabric.jsonl');
  const authority = createGrantAuthority();
  const shell = {
    env: { lookup: () => undefined },
    clock: { now: () => 1000 },
    // Timeouts never fire; only an abort ends a sleep.
    timer: {
      sleep: (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('aborted'));
          else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    },
  };
  /** Weft records from every host this fixture opens, as one trace. */
  const records: WeftRecordShape[] = [];
  const weft = { trace_id: 'run-1', emitter_id: 'fab', emit: (record: WeftRecordShape) => void records.push(record) };
  const open = () =>
    new AgentFabricHost({ authority, store, shell, weft, cliProcessGroupProbe: () => 'unknown' as const });
  let store = new FabricStore(undefined, path);
  let host = open();
  await host.cliRecoveryReady;
  const cwd_ref = host.registerWorkspace(workspace);
  const originalSpawn = childProcess.spawn;
  const spawn = t.mock.method(childProcess, 'spawn', originalSpawn);
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (overrides: Record<string, unknown> = {}) => ({
    argv: [tool],
    cwd_ref,
    env_allow: [],
    timeout_ms: 60_000,
    stdin: '',
    ...overrides,
  });
  const grant = (action_id: string) =>
    authority.issue({
      action_id,
      operation: SHELL_RUN.id,
      contract_rev: SHELL_RUN.revision,
      permissions: [{ resource: cwd_ref, mode: 'write' }],
      effects: [{ resource: cwd_ref, mode: 'write' }],
      process_effects: ['process.spawn', `fs.write:${cwd_ref}`],
      issued_at: 0,
    });
  /** Reopen as after a crash. A gate holds construction's recovery check open. */
  const reopen = async (gate?: Promise<void>) => {
    store.close();
    if (gate) {
      t.mock.method(
        AgentFabricHost.prototype as unknown as RecoveryChecks,
        'checkUncertainCliGenerations',
        () => gate,
        {
          times: 1,
        },
      );
    }
    store = new FabricStore(undefined, path);
    host = open();
    if (!gate) await host.cliRecoveryReady;
  };
  const install = () => writeFileSync(tool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  /** A durable stopped run with no reconciliation: its tool is missing, so it never spawns a process. */
  const stopped = async (id: string) => {
    const first = grant(id);
    const handle = await host.invokeCliGeneration(first, request());
    assert.equal(handle.kind, 'handle');
    if (handle.kind !== 'handle') throw new Error('expected a handle');
    host.release(id);
    assert.deepEqual(await handle.result, { outcome: 'failed', failure: 'spawn_failed' });
    const before = store.getInvocation(id)!;
    assert.equal(before.status, 'stopped');
    assert.equal(before.reconciliation, undefined);
    assert.equal(before.cancel_requested, false);
    install();
    return { grant: first, before, spawns: spawn.mock.callCount() };
  };
  /** Run an accepted handle to completion. */
  const finish = async (result: Awaited<ReturnType<AgentFabricHost['invokeCliGeneration']>>) => {
    assert.equal(result.kind, 'handle', JSON.stringify(result));
    if (result.kind !== 'handle') throw new Error('expected a handle');
    host.release(result.invocation_id);
    return result.result;
  };
  return {
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    authority,
    records,
    spawn,
    cwd_ref,
    request,
    grant,
    reopen,
    install,
    stopped,
    finish,
  };
}

function reconciled(before: InvocationRecord, evidence: RegExp = AUTOMATIC) {
  return (record: InvocationRecord | undefined) => {
    assert.ok(record);
    assert.match(record.reconciliation?.evidence ?? '', evidence);
    assert.deepEqual(record, {
      ...before,
      reconciliation: { resolution: 'not_committed', evidence: record.reconciliation!.evidence },
    });
  };
}

describe('CLI generation re-run of a stopped record (WV-040)', () => {
  it('reconciles a stopped run automatically, then starts a fresh attempt with a fresh grant', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:rerun';
    const { before, spawns } = await f.stopped(id);
    const reconcile = t.mock.method(f.store, 'persistInvocationReconciliation');
    const fresh = f.grant(id);
    const result = await f.finish(await f.host.invokeCliGeneration(fresh, f.request()));
    assert.equal(result.outcome, 'succeeded');
    if (result.outcome === 'succeeded') assert.equal((result.output as { exit: number }).exit, 0);
    assert.equal(reconcile.mock.callCount(), 1, 'exactly one durable reconciliation');
    assert.equal(f.spawn.mock.callCount(), spawns + 1);
    const history = f.store.supersededInvocations(id);
    assert.equal(history.length, 1);
    reconciled(before)(history[0]);
    assert.match(history[0]!.reconciliation!.evidence, /spawn_failed/);
    const current = f.store.getInvocation(id)!;
    assert.equal(current.status, 'committed');
    assert.equal(current.attempt, 2);
    assert.match(current.cli_generation?.before_snapshot ?? '', /^[a-f0-9]{64}$/);
    assert.equal(f.host.coordinator.held().length, 0);
    assert.equal(f.authority.markInvoked(fresh), false, 'the fresh grant is consumed');
    await f.reopen();
    assert.deepEqual(f.store.supersededInvocations(id), history);
    assert.deepEqual(f.store.getInvocation(id), current);
    assert.deepEqual(f.host.listUncertainCliGenerations(), []);
    assert.equal(f.host.coordinator.held().length, 0);
  });

  it('gives each attempt distinct Weft record ids, linked to its own selection, in one host and after reopen', async (t) => {
    const check = async (id: string, reopen: boolean) => {
      // A fresh fixture each time: the first stopped run needs its tool missing.
      const f = await fixture(t);
      const from = f.records.length;
      await f.stopped(id);
      if (reopen) await f.reopen();
      const result = await f.finish(await f.host.invokeCliGeneration(f.grant(id), f.request()));
      assert.equal(result.outcome, 'succeeded');
      const own = f.records.slice(from).filter((r) => r.evidence.some((e) => e.ref === id));
      assert.deepEqual(
        own.map((r) => [r.kind, r.fields['event'] ?? r.fields['status']]),
        [
          ['capability.lifecycle', 'selected'],
          ['capability.invoked', 'failed'],
          ['capability.lifecycle', 'selected'],
          ['capability.invoked', 'succeeded'],
        ],
      );
      // Weft identifies a record by (trace_id, record_id): a repeat would be refused as a conflict on import.
      assert.equal(new Set(own.map((r) => r.record_id)).size, own.length, JSON.stringify(own.map((r) => r.record_id)));
      for (const at of [0, 2]) {
        const selected = own[at]!;
        const invoked = own[at + 1]!;
        assert.equal(invoked.parent_id, selected.record_id, 'an invocation points at its own attempt');
        assert.deepEqual(invoked.evidence, [{ source: 'invocation', ref: id }], 'correlation by invocation id stays');
      }
    };
    await check('shell-cli:weft', false);
    await check('shell-cli:weft-reopen', true);
  });

  it('starts a fresh attempt over an already reconciled stopped run without reconciling it again', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:reconciled';
    const record: InvocationRecord = {
      invocation_id: id,
      action_id: id,
      operation: SHELL_RUN.id,
      binding_digest: digest({ operation: SHELL_RUN.id, inputs: f.request() }),
      inputs: f.request(),
      status: 'running',
      outcome: null,
      cancel_requested: false,
      reservation: [{ resource: f.store.lookupRef(f.cwd_ref)!.canonical_id, mode: 'write' }],
      cli_generation: { cwd_ref: f.cwd_ref, before_snapshot: null },
    };
    f.store.persistInvocationStart(record);
    f.store.persistInvocationReconciliation({
      ...record,
      status: 'stopped',
      outcome: { outcome: 'failed', failure: 'reconciled: not committed' },
      reconciliation: { resolution: 'not_committed', evidence: 'operator confirmed stopped' },
    });
    await f.reopen();
    f.install();
    const before = f.store.getInvocation(id)!;
    const reconcile = t.mock.method(f.store, 'persistInvocationReconciliation');
    const result = await f.finish(await f.host.invokeCliGeneration(f.grant(id), f.request()));
    assert.equal(result.outcome, 'succeeded');
    assert.equal(reconcile.mock.callCount(), 0, 'no double reconciliation');
    assert.deepEqual(f.store.supersededInvocations(id), [before]);
    assert.equal(f.store.getInvocation(id)?.attempt, 2);
    assert.equal(f.spawn.mock.callCount(), 1);
  });

  for (const status of ['uncertain', 'committed'] as const) {
    it(`replays a ${status} record unchanged with a fresh grant`, async (t) => {
      const f = await fixture(t);
      const id = `shell-cli:${status}`;
      const record: InvocationRecord = {
        invocation_id: id,
        action_id: id,
        operation: SHELL_RUN.id,
        binding_digest: digest({ operation: SHELL_RUN.id, inputs: f.request() }),
        inputs: f.request(),
        status: 'running',
        outcome: null,
        cancel_requested: false,
        reservation: [{ resource: f.store.lookupRef(f.cwd_ref)!.canonical_id, mode: 'write' }],
        cli_generation: { cwd_ref: f.cwd_ref, before_snapshot: null },
      };
      f.store.persistInvocationStart(record);
      if (status === 'committed') {
        f.store.persistInvocationResult({
          ...record,
          status: 'committed',
          outcome: { outcome: 'succeeded', output: { receipt: 'existing' } },
        });
      }
      await f.reopen();
      const before = f.store.getInvocation(id)!;
      const reconcile = t.mock.method(f.store, 'persistInvocationReconciliation');
      const replay = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(replay.kind, 'handle');
      if (replay.kind !== 'handle') return;
      assert.deepEqual(await replay.result, before.outcome);
      assert.deepEqual(f.store.getInvocation(id), before);
      assert.deepEqual(f.store.supersededInvocations(id), []);
      assert.equal(reconcile.mock.callCount(), 0);
      assert.equal(f.spawn.mock.callCount(), 0);
      assert.equal(f.host.openCount(), 0);
      assert.deepEqual(
        f.host.coordinator.held().map((hold) => hold.invocation_id),
        status === 'uncertain' ? [id] : [],
      );
    });
  }

  it('denies reuse of consumed grants without reconciling, and consumes each fresh grant once', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:grants';
    const { grant: old, before, spawns } = await f.stopped(id);
    const reconcile = t.mock.method(f.store, 'persistInvocationReconciliation');
    const reuse = async (grant: Grant) => {
      const result = await f.host.invokeCliGeneration(grant, f.request());
      if (result.kind === 'handle') await f.finish(result);
      assert.equal(result.kind, 'rejected');
      if (result.kind === 'rejected') {
        assert.equal(result.code, 'DENIED');
        assert.match(result.reason, /already been used/);
      }
    };
    await reuse(old);
    assert.deepEqual(f.store.getInvocation(id), before, 'a denied re-run does not reconcile');
    assert.equal(reconcile.mock.callCount(), 0);
    const consume = t.mock.method(f.authority, 'markInvoked');
    const second = f.grant(id);
    const handle = await f.host.invokeCliGeneration(second, f.request());
    assert.equal(handle.kind, 'handle');
    if (handle.kind !== 'handle') return;
    // Stop the second attempt too, so later reuse reaches the re-run path again.
    f.host.requestCancel(id);
    assert.deepEqual(await f.finish(handle), { outcome: 'failed', failure: 'cancelled' });
    assert.equal(consume.mock.calls.filter((call) => call.arguments[0] === second).length, 1);
    assert.equal(reconcile.mock.callCount(), 1);
    const attempt2 = f.store.getInvocation(id)!;
    assert.equal(attempt2.attempt, 2);
    assert.equal(attempt2.status, 'stopped');
    for (const grant of [old, second]) await reuse(grant);
    assert.deepEqual(f.store.getInvocation(id), attempt2);
    assert.equal(reconcile.mock.callCount(), 1);
    assert.equal(f.spawn.mock.callCount(), spawns);
    const third = f.grant(id);
    assert.equal((await f.finish(await f.host.invokeCliGeneration(third, f.request()))).outcome, 'succeeded');
    assert.equal(consume.mock.calls.filter((call) => call.arguments[0] === third).length, 1);
    assert.equal(f.store.getInvocation(id)?.attempt, 3);
    assert.deepEqual(
      f.store.supersededInvocations(id).map((record) => record.attempt ?? 1),
      [1, 2],
    );
    assert.equal(f.spawn.mock.callCount(), spawns + 1);
  });

  it('keeps input binding: a fresh grant with different inputs is denied before consumption', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:binding';
    const { before, spawns } = await f.stopped(id);
    const grant = f.grant(id);
    const result = await f.host.invokeCliGeneration(grant, f.request({ timeout_ms: 1000 }));
    assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.match(result.reason, /different input/);
    assert.deepEqual(f.store.getInvocation(id), before);
    assert.equal(f.authority.markInvoked(grant), true, 'the fresh grant stays unconsumed');
    assert.equal(f.spawn.mock.callCount(), spawns);
  });

  it('fails closed without spawning when the automatic reconciliation cannot be persisted', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:reconcile-fails';
    const { before, spawns } = await f.stopped(id);
    t.mock.method(
      f.store,
      'persistInvocationReconciliation',
      () => {
        throw new Error('injected reconciliation failure');
      },
      { times: 1 },
    );
    const invocations = f.host.invocations.length;
    const fresh = f.grant(id);
    const result = await f.host.invokeCliGeneration(fresh, f.request());
    assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') {
      assert.equal(result.code, 'RESOLVER_ERROR');
      assert.match(result.reason, /automatic reconciliation/);
    }
    assert.equal(f.spawn.mock.callCount(), spawns);
    assert.deepEqual(f.store.getInvocation(id), before, 'the old record is unchanged');
    assert.deepEqual(f.store.supersededInvocations(id), [], 'no fresh record');
    assert.equal(f.host.invocations.length, invocations);
    assert.equal(f.host.coordinator.held().length, 0, 'the fresh reservation is released');
    assert.equal(f.host.openCount(), 0);
    // Documented fail-closed choice: consumption precedes the durable reconciliation.
    assert.equal(f.authority.markInvoked(fresh), false);
    await f.reopen();
    assert.deepEqual(f.store.getInvocation(id), before);
    assert.equal(f.host.coordinator.held().length, 0);
    assert.equal((await f.finish(await f.host.invokeCliGeneration(f.grant(id), f.request()))).outcome, 'succeeded');
    reconciled(before)(f.store.supersededInvocations(id)[0]);
  });

  describe('cancellation', () => {
    it('returns cancelled while awaiting recovery, without reconciling, recording or spawning', async (t) => {
      const f = await fixture(t);
      const id = 'shell-cli:cancel-recovery';
      const { before, spawns } = await f.stopped(id);
      const gate = deferred();
      await f.reopen(gate.promise);
      const fresh = f.grant(id);
      const pending = f.host.invokeCliGeneration(fresh, f.request());
      assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
      assert.deepEqual(f.store.getInvocation(id), before, 'the earlier run is not marked cancelled');
      gate.resolve();
      assert.deepEqual(await pending, { kind: 'cancelled', invocation_id: id });
      assert.deepEqual(f.store.getInvocation(id), before);
      assert.deepEqual(f.store.supersededInvocations(id), []);
      assert.equal(f.spawn.mock.callCount(), spawns);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.authority.markInvoked(fresh), false, 'consumed after the gates, as in #297');
      // The retained cancellation is not inherited by a later re-run.
      assert.equal((await f.finish(await f.host.invokeCliGeneration(f.grant(id), f.request()))).outcome, 'succeeded');
      assert.equal(f.store.getInvocation(id)?.cancel_requested, false);
    });

    it('rejects a pre-consumption failure with pending cancellation, leaving the grant unconsumed', async (t) => {
      const f = await fixture(t);
      const id = 'shell-cli:cancel-binding';
      const { before, spawns } = await f.stopped(id);
      const gate = deferred();
      await f.reopen(gate.promise);
      const fresh = f.grant(id);
      const pending = f.host.invokeCliGeneration(fresh, f.request({ timeout_ms: 1000 }));
      f.host.requestCancel(id);
      gate.resolve();
      const result = await pending;
      assert.equal(result.kind, 'rejected');
      if (result.kind === 'rejected') assert.match(result.reason, /different input/);
      assert.deepEqual(f.store.getInvocation(id), before);
      assert.equal(f.spawn.mock.callCount(), spawns);
      assert.equal(f.authority.markInvoked(fresh), true);
    });

    it('surfaces a recovery failure over pending cancellation without consuming or reconciling', async (t) => {
      const f = await fixture(t);
      const id = 'shell-cli:cancel-recovery-failure';
      const { before, spawns } = await f.stopped(id);
      const gate = deferred();
      await f.reopen(gate.promise);
      const fresh = f.grant(id);
      const pending = f.host.invokeCliGeneration(fresh, f.request());
      f.host.requestCancel(id);
      const rejected = assert.rejects(pending, /injected recovery failure/);
      gate.reject(new Error('injected recovery failure'));
      await rejected;
      assert.deepEqual(f.store.getInvocation(id), before);
      assert.equal(f.spawn.mock.callCount(), spawns);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.authority.markInvoked(fresh), true);
    });

    it('settles the fresh attempt stopped without spawning when cancelled during the automatic reconciliation', async (t) => {
      const f = await fixture(t);
      const id = 'shell-cli:cancel-reconcile';
      const { before, spawns } = await f.stopped(id);
      const persist = f.store.persistInvocationReconciliation.bind(f.store);
      t.mock.method(
        f.store,
        'persistInvocationReconciliation',
        (record: InvocationRecord) => {
          assert.deepEqual(f.host.requestCancel(id), { acknowledged: true });
          persist(record);
        },
        { times: 1 },
      );
      const fresh = f.grant(id);
      assert.deepEqual(await f.finish(await f.host.invokeCliGeneration(fresh, f.request())), {
        outcome: 'failed',
        failure: 'cancelled',
      });
      assert.equal(f.spawn.mock.callCount(), spawns);
      reconciled(before)(f.store.supersededInvocations(id)[0]);
      const current = f.store.getInvocation(id)!;
      assert.equal(current.attempt, 2);
      assert.equal(current.status, 'stopped');
      assert.equal(current.cancel_requested, true);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.equal(f.authority.markInvoked(fresh), false);
    });
  });

  for (const overlap of ['recovery', 'inspection'] as const) {
    it(`admits exactly one of two re-runs racing during ${overlap}`, async (t) => {
      const f = await fixture(t);
      const id = `shell-cli:race-${overlap}`;
      const { spawns } = await f.stopped(id);
      const gate = deferred();
      if (overlap === 'recovery') await f.reopen(gate.promise);
      const reconcile = t.mock.method(f.store, 'persistInvocationReconciliation');
      const [first, second] = [f.grant(id), f.grant(id)];
      const winner = f.host.invokeCliGeneration(first, f.request());
      const loser = await f.host.invokeCliGeneration(second, f.request());
      assert.equal(loser.kind, 'rejected');
      if (loser.kind === 'rejected') {
        assert.equal(loser.code, 'DENIED');
        assert.match(loser.reason, /already active/);
      }
      gate.resolve();
      assert.equal((await f.finish(await winner)).outcome, 'succeeded');
      assert.equal(reconcile.mock.callCount(), 1);
      assert.equal(f.spawn.mock.callCount(), spawns + 1);
      assert.equal(f.store.supersededInvocations(id).length, 1);
      assert.equal(f.store.getInvocation(id)?.attempt, 2);
      assert.equal(f.authority.markInvoked(second), true, 'the losing grant is not consumed');
      assert.equal(f.authority.markInvoked(first), false);
    });
  }

  it('keeps the fresh attempt reservation when the stopped run is looked up during inspection', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:lookup';
    const { grant: old, before } = await f.stopped(id);
    const pending = f.host.invokeCliGeneration(f.grant(id), f.request());
    assert.deepEqual(f.host.lookup(id, old), { status: 'stopped', outcome: before.outcome });
    assert.deepEqual(
      f.host.coordinator.held().map((hold) => hold.invocation_id),
      [id],
    );
    assert.equal((await f.finish(await pending)).outcome, 'succeeded');
    assert.equal(f.host.coordinator.held().length, 0);
  });

  describe('crash and recovery', () => {
    it('reopens with the stopped run reconciled and no fresh record after a crash before the fresh start', async (t) => {
      const f = await fixture(t);
      const id = 'shell-cli:crash-before-start';
      const { before, spawns } = await f.stopped(id);
      t.mock.method(
        f.store,
        'persistInvocationStart',
        () => {
          throw new Error('injected crash before fresh start');
        },
        { times: 1 },
      );
      await assert.rejects(f.host.invokeCliGeneration(f.grant(id), f.request()), /injected crash/);
      await f.reopen();
      reconciled(before)(f.store.getInvocation(id));
      assert.deepEqual(f.store.supersededInvocations(id), []);
      assert.equal(f.host.coordinator.held().length, 0);
      assert.deepEqual(f.host.listUncertainCliGenerations(), []);
      const reconciledRecord = f.store.getInvocation(id)!;
      const reconcile = t.mock.method(f.store, 'persistInvocationReconciliation');
      assert.equal((await f.finish(await f.host.invokeCliGeneration(f.grant(id), f.request()))).outcome, 'succeeded');
      assert.equal(reconcile.mock.callCount(), 0);
      assert.deepEqual(f.store.supersededInvocations(id), [reconciledRecord]);
      assert.equal(f.store.getInvocation(id)?.attempt, 2);
      assert.equal(f.spawn.mock.callCount(), spawns + 1);
    });

    it('recovers the fresh attempt normally after a crash following its start record', async (t) => {
      const f = await fixture(t);
      const id = 'shell-cli:crash-after-start';
      const { before, spawns } = await f.stopped(id);
      const handle = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(handle.kind, 'handle');
      assert.equal(f.store.getInvocation(id)?.status, 'running');
      await f.reopen();
      const history = f.store.supersededInvocations(id);
      assert.equal(history.length, 1);
      reconciled(before)(history[0]);
      const current = f.store.getInvocation(id)!;
      assert.equal(current.attempt, 2);
      assert.equal(current.status, 'uncertain');
      assert.deepEqual(
        f.host.coordinator.held().map((hold) => hold.invocation_id),
        [id],
      );
      assert.deepEqual(
        f.host.listUncertainCliGenerations().map((entry) => entry.invocation_id),
        [id],
      );
      // An uncertain fresh attempt keeps its hold and replays; it is never auto-reconciled.
      const replay = await f.host.invokeCliGeneration(f.grant(id), f.request());
      assert.equal(replay.kind, 'handle');
      if (replay.kind === 'handle') assert.equal((await replay.result).outcome, 'uncertain');
      assert.deepEqual(f.store.getInvocation(id), current);
      f.host.reconcileCliGeneration(id, {
        resolution: 'not_committed',
        evidence: 'operator inspected attempt 2',
        force_with_evidence: true,
      });
      assert.equal((await f.finish(await f.host.invokeCliGeneration(f.grant(id), f.request()))).outcome, 'succeeded');
      assert.deepEqual(
        f.store.supersededInvocations(id).map((record) => [record.attempt ?? 1, record.reconciliation?.evidence]),
        [
          [1, history[0]!.reconciliation!.evidence],
          [2, 'forced process-group override: operator inspected attempt 2'],
        ],
      );
      assert.equal(f.store.getInvocation(id)?.attempt, 3);
      assert.equal(f.spawn.mock.callCount(), spawns + 1);
      assert.equal(f.host.coordinator.held().length, 0);
    });
  });
});

describe('store transitions for superseded CLI generations (WV-040)', () => {
  const inputs = { argv: ['tool'], cwd_ref: 'ref_1', env_allow: [], timeout_ms: 1000, stdin: '' };
  const start: InvocationRecord = {
    invocation_id: 'shell-cli:store',
    action_id: 'shell-cli:store',
    operation: SHELL_RUN.id,
    binding_digest: 'binding',
    inputs,
    status: 'running',
    outcome: null,
    cancel_requested: false,
    reservation: [{ resource: 'res_1', mode: 'write' }],
    cli_generation: { cwd_ref: 'ref_1', before_snapshot: null },
  };
  const stoppedRecord: InvocationRecord = {
    ...start,
    status: 'stopped',
    outcome: { outcome: 'failed', failure: 'spawn_failed' },
  };
  const automatic = { resolution: 'not_committed' as const, evidence: 'automatic reconciliation on re-run' };

  it('accepts only a not_committed reconciliation of a stopped record that preserves its outcome', () => {
    const store = new FabricStore();
    store.persistInvocationStart(start);
    store.persistInvocationResult(stoppedRecord);
    const settled = store.getInvocation(start.invocation_id);
    assert.throws(
      () =>
        store.persistInvocationReconciliation({
          ...stoppedRecord,
          status: 'committed',
          outcome: { outcome: 'succeeded', output: {} },
          reconciliation: { resolution: 'committed', evidence: 'contradiction' },
        }),
      /transition/,
    );
    assert.throws(
      () =>
        store.persistInvocationReconciliation({
          ...stoppedRecord,
          outcome: { outcome: 'failed', failure: 'rewritten' },
          reconciliation: automatic,
        }),
      /transition/,
    );
    assert.deepEqual(store.getInvocation(start.invocation_id), settled);
    store.persistInvocationReconciliation({ ...stoppedRecord, reconciliation: automatic });
    assert.throws(
      () => store.persistInvocationReconciliation({ ...stoppedRecord, reconciliation: automatic }),
      /transition/,
    );
  });

  it('supersedes only a reconciled stopped CLI generation with the next attempt, keeping history across reopen', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-cli-rerun-store-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'fabric.jsonl');
    let store = new FabricStore(undefined, path);
    store.persistInvocationStart(start);
    store.persistInvocationResult(stoppedRecord);
    const fresh: InvocationRecord = {
      ...start,
      attempt: 2,
      cli_generation: { cwd_ref: 'ref_1', before_snapshot: 'a'.repeat(64) },
    };
    assert.throws(() => store.persistInvocationStart(fresh), /transition/, 'an unreconciled stopped run');
    store.persistInvocationReconciliation({ ...stoppedRecord, reconciliation: automatic });
    const old = store.getInvocation(start.invocation_id)!;
    for (const invalid of [
      { ...fresh, attempt: undefined },
      { ...fresh, attempt: 3 },
      { ...fresh, binding_digest: 'other' },
    ]) {
      assert.throws(() => store.persistInvocationStart(invalid as InvocationRecord), /transition/);
    }
    assert.deepEqual(store.getInvocation(start.invocation_id), old);
    store.persistInvocationStart(fresh);
    assert.deepEqual(store.supersededInvocations(start.invocation_id), [old]);
    assert.equal(store.getInvocation(start.invocation_id)?.attempt, 2);
    assert.equal(store.snapshot().superseded_invocations?.length, 1);
    store.close();
    store = new FabricStore(undefined, path);
    assert.deepEqual(store.supersededInvocations(start.invocation_id), [old]);
    assert.equal(store.getInvocation(start.invocation_id)?.attempt, 2);
    const restored = FabricStore.restore(store.snapshot());
    assert.deepEqual(restored.supersededInvocations(start.invocation_id), [old]);
    store.close();
  });

  it('keeps the public reconcile API refusing stopped records', async (t) => {
    const f = await fixture(t);
    const id = 'shell-cli:public-reconcile';
    const { before } = await f.stopped(id);
    assert.throws(
      () => f.host.reconcile(id, { resolution: 'not_committed', evidence: 'operator' }),
      /does not require reconciliation/,
    );
    assert.deepEqual(f.store.getInvocation(id), before);
  });
});
