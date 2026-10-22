import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, type TestContext } from 'node:test';
import { createGrantAuthority, type CapabilityContract, type InvocationOutcome } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, type ReconciliationResolution, type CapabilityImplementation } from '@weave/agentfabric';

const write: CapabilityContract = {
  id: 'test.write', revision: '1', purpose: 'test uncertain effects',
  input: { target: 'resource reference' }, output: { ok: 'boolean' },
  effects: [{ input: 'target', mode: 'write' }], permissions: [{ input: 'target', mode: 'write' }],
  failures: [], depends_on: [],
};
const read: CapabilityContract = { ...write, id: 'test.read',
  effects: [{ input: 'target', mode: 'read' }], permissions: [{ input: 'target', mode: 'read' }] };
const discover: CapabilityContract = { ...read, id: 'test.discover',
  effects: [{ input: 'target', mode: 'discover' }], permissions: [{ input: 'target', mode: 'discover' }] };
const pure: CapabilityContract = { ...write, id: 'test.pure', effects: [], permissions: [] };
const uncertain: InvocationOutcome = { outcome: 'uncertain', reason: 'external outcome unknown' };
const succeeded: InvocationOutcome = { outcome: 'succeeded', output: { ok: true } };
type Resolution = ReconciliationResolution;
function reconcile(host: AgentFabricHost, resolution: Resolution, id = 'inv') {
  return host.reconcile(id, resolution);
}
const absent: Resolution = { resolution: 'not_committed', evidence: 'external audit: no effect' };

function lookupStatus(host: AgentFabricHost, id: string, grant: Parameters<AgentFabricHost['lookup']>[1]) {
  const found = host.lookup(id, grant);
  assert.ok('status' in found);
  return found.status;
}

function fixture(t: TestContext, contract = write, run?: CapabilityImplementation) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'weave-uncertain-'));
  const path = join(dir, 'fabric.json');
  let store = FabricStore.open(path);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const authority = createGrantAuthority();
  let host = new AgentFabricHost({ authority, store, contracts: [contract] });
  const target = host.registerDestination('mem:uncertain');
  let runs = 0;
  let complete!: (outcome: InvocationOutcome) => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<InvocationOutcome>((resolve, no) => { complete = resolve; reject = no; });
  host.installAdmitted(contract, (inputs, context) => { runs += 1; return run ? run(inputs, context) : pending; });
  const grant = (action_id = 'action') => authority.issue({ action_id, operation: contract.id,
    contract_rev: contract.revision, permissions: contract.permissions.map((effect) => ({ resource: target, mode: effect.mode })),
    effects: contract.effects.map((effect) => ({ resource: target, mode: effect.mode })), issued_at: 1 });
  const originalGrant = grant();
  const invoke = (id = 'inv', issued = originalGrant) => host.invoke(issued, contract.id, { target }, { invocation_id: id });
  const handle = invoke();
  assert.equal(handle.kind, 'handle');
  if (handle.kind !== 'handle') throw new Error('expected handle');
  const reopen = (install = true) => {
    store.close(); store = FabricStore.open(path);
    host = new AgentFabricHost({ authority, store, contracts: [contract] });
    if (install) host.installAdmitted(contract, () => { runs += 1; return succeeded; });
    return host;
  };
  return { get host() { return host; }, get store() { return store; }, path, target, grant, originalGrant,
    invoke, handle, complete, reject, reopen, runs: () => runs };
}

async function assertReplay(f: ReturnType<typeof fixture>, expected: InvocationOutcome) {
  const replay = f.invoke();
  assert.equal(replay.kind, 'handle');
  if (replay.kind !== 'handle') throw new Error('expected replay');
  assert.deepEqual(await replay.result, expected);
  assert.deepEqual(f.host.releaseAll(), []);
  assert.equal(f.runs(), 1);
}

describe('uncertain invocation contract', () => {
  const faults: Record<string, CapabilityImplementation> = {
    'sync throw': () => { throw new Error('implementation fault'); },
    'async throw': async () => { throw new Error('implementation fault'); },
    'async reject': () => Promise.reject(new Error('implementation fault')),
    'non-Error throw': () => { throw null; },
    'malformed outcome': () => undefined as unknown as InvocationOutcome,
    'malformed success': () => ({ outcome: 'succeeded', output: 1n }) as unknown as InvocationOutcome,
    'malformed failure': () => ({ outcome: 'failed', failure: 42 }) as unknown as InvocationOutcome,
  };
  for (const contract of [write, read, discover, pure]) {
    for (const [fault, run] of Object.entries(faults)) {
      it(`${contract.id} ${fault} preserves settlement and reservations across restart`, async (t) => {
        const f = fixture(t, contract, run);
        f.host.release('action');
        const result = await f.handle.result;
        const writes = contract === write;
        assert.equal(result.outcome, writes ? 'uncertain' : 'failed');
        assert.equal(f.store.getInvocation('inv')?.status, writes ? 'uncertain' : 'stopped');
        assert.equal(f.host.coordinator.held().length, writes ? 1 : 0);
        assert.equal(lookupStatus(f.host, 'inv', f.originalGrant), writes ? 'unresolved' : 'stopped');
        if (writes) {
          assert.equal(f.invoke('conflict', f.grant('conflict')).kind, 'rejected');
          await assertReplay(f, result);
        }
        f.reopen();
        assert.equal(f.host.coordinator.held().length, writes ? 1 : 0);
        assert.equal(lookupStatus(f.host, 'inv', f.originalGrant), writes ? 'unresolved' : 'stopped');
        if (writes) {
          await assertReplay(f, result);
          assert.equal(f.invoke('conflict', f.grant('conflict')).kind, 'rejected');
          reconcile(f.host, absent);
          assert.equal(f.host.coordinator.held().length, 0);
        }
        const after = f.invoke('after', f.grant('after'));
        assert.equal(after.kind, 'handle');
        f.host.release('after');
        if (after.kind === 'handle') assert.deepEqual(await after.result, succeeded);
      });
    }
  }

  for (const mode of ['create', 'append', 'delete', 'write'] as const) {
    it(`a fault retains the entire read/${mode} reservation until reconciliation`, async (t) => {
      const effects = [{ input: 'target', mode: 'read' as const }, { input: 'target', mode }];
      const contract = { ...write, id: `test.read-${mode}`, effects, permissions: effects };
      const f = fixture(t, contract, faults['async throw']);
      const holds = structuredClone(f.host.coordinator.held());
      f.host.release('action');
      assert.equal((await f.handle.result).outcome, 'uncertain');
      assert.deepEqual(f.host.coordinator.held(), holds);
      f.reopen();
      assert.deepEqual(f.host.coordinator.held(), holds);
      assert.equal(f.invoke('conflict', f.grant('conflict')).kind, 'rejected');
      reconcile(f.host, absent);
      assert.deepEqual(f.host.coordinator.held(), []);
    });
  }

  it('keeps a valid explicit failed outcome stopped even with declared writes', async (t) => {
    const failed: InvocationOutcome = { outcome: 'failed', failure: 'known not committed' };
    const f = fixture(t, write, () => failed);
    f.host.release('action');
    assert.deepEqual(await f.handle.result, failed);
    assert.equal(f.store.getInvocation('inv')?.status, 'stopped');
    assert.deepEqual(f.host.coordinator.held(), []);
    f.reopen();
    assert.equal(lookupStatus(f.host, 'inv', f.originalGrant), 'stopped');
    assert.deepEqual(f.host.coordinator.held(), []);
  });

  for (const terminal of ['committed', 'uncertain', 'reconciled'] as const) {
    it(`refuses another action before direct ${terminal} replay`, async (t) => {
      const f = fixture(t);
      f.host.release('action');
      f.complete(terminal === 'committed' ? succeeded : uncertain);
      await f.handle.result;
      if (terminal === 'reconciled') reconcile(f.host, absent);
      const other = f.grant('other');
      const snapshot = f.store.snapshot();
      const bytes = fs.readFileSync(f.path);
      const holds = structuredClone(f.host.coordinator.held());
      const result = f.invoke('inv', other);
      assert.equal(result.kind, 'rejected');
      if (result.kind === 'rejected') assert.equal(result.code, 'DENIED');
      assert.deepEqual(f.store.snapshot(), snapshot);
      assert.deepEqual(fs.readFileSync(f.path), bytes);
      assert.deepEqual(f.host.coordinator.held(), holds);
      assert.equal(f.host.authority.markInvoked(other), true);
    });
  }

  for (const cancel of ['before reject', 'after reject', 'inside run'] as const) {
    it(`settles a declared-write rejection once with concurrent invocations and cancellation ${cancel}`, async (t) => {
      let f: ReturnType<typeof fixture>;
      f = fixture(t, write, cancel === 'inside run' ? () => {
        f.handle.requestCancel();
        f.host.releaseAll();
        throw new Error('implementation fault');
      } : undefined);
      let settlements = 0;
      void f.handle.result.then(() => { settlements += 1; });
      f.host.release('action');
      f.host.release('action');
      assert.equal(f.invoke().kind, 'rejected');
      assert.equal(f.invoke('conflict', f.grant('conflict')).kind, 'rejected');
      if (cancel === 'before reject') f.handle.requestCancel();
      if (cancel !== 'inside run') f.reject(new Error('implementation fault'));
      if (cancel === 'after reject') f.handle.requestCancel();
      const result = await f.handle.result;
      assert.equal(result.outcome, 'uncertain');
      assert.equal(settlements, 1);
      assert.equal(f.runs(), 1);
      assert.equal(f.store.getInvocation('inv')?.cancel_requested, true);
      const markers = fs.readFileSync(f.path, 'utf8').split('\n').filter((line) => line.includes('"op":"uncertain"'));
      assert.equal(markers.length, 1);
      assert.equal(f.host.coordinator.held().length, 1);
      await assertReplay(f, result);
      reconcile(f.host, absent);
      assert.equal(f.host.coordinator.held().length, 0);
    });
  }

  for (const fault of ['closed', 'lost lock'] as const) {
    it(`failed reconciliation after a declared-write throw preserves state: ${fault}`, async (t) => {
      const f = fixture(t, write, faults['sync throw']);
      f.host.release('action');
      assert.equal((await f.handle.result).outcome, 'uncertain');
      const snapshot = f.store.snapshot();
      const bytes = fs.readFileSync(f.path);
      const lock = fs.readFileSync(`${f.path}.lock`);
      if (fault === 'closed') f.store.close();
      else fs.writeFileSync(`${f.path}.lock`, 'replacement');
      assert.throws(() => reconcile(f.host, absent), /closed|lock/);
      assert.deepEqual(f.store.snapshot(), snapshot);
      assert.deepEqual(fs.readFileSync(f.path), bytes);
      assert.equal(f.host.coordinator.held().length, 1);
      assert.equal(f.invoke('conflict', f.grant('conflict')).kind, 'rejected');
      if (fault === 'lost lock') fs.writeFileSync(`${f.path}.lock`, lock);
      f.reopen();
      reconcile(f.host, absent);
      assert.equal(f.host.coordinator.held().length, 0);
    });
  }

  it('consumes a fresh replay grant after restart without granting another execution', async (t) => {
    const f = fixture(t);
    f.host.release('action'); f.complete(uncertain); await f.handle.result;
    f.reopen();
    const fresh = f.grant();
    const replay = f.invoke('inv', fresh);
    assert.equal(replay.kind, 'handle');
    if (replay.kind === 'handle') assert.deepEqual(await replay.result, uncertain);
    reconcile(f.host, absent);
    assert.equal(f.invoke('another', fresh).kind, 'rejected');
  });

  it('reports marker persistence failure and reconciles the retained in-memory entry without a leak', async (t) => {
    const f = fixture(t);
    const persist = f.store.persistInvocationUncertain.bind(f.store);
    f.store.persistResult = false;
    f.store.persistInvocationUncertain = () => { throw new Error('marker append refused'); };
    f.host.release('action'); f.complete(succeeded);
    const result = await f.handle.result;
    assert.equal(result.outcome, 'uncertain');
    if (result.outcome === 'uncertain') assert.match(result.reason, /marker.*persist/);
    assert.equal((f.host as unknown as { open: Map<string, unknown> }).open.size, 1);
    assert.equal(f.host.coordinator.held().length, 1);
    f.store.persistInvocationUncertain = persist;
    reconcile(f.host, absent);
    assert.equal((f.host as unknown as { open: Map<string, unknown> }).open.size, 0);
    assert.equal(f.host.coordinator.held().length, 0);
  });

  const crashPoints = ['marker before', 'marker partial', 'marker after',
    'compact temp before', 'compact temp after', 'compact rename before', 'compact rename after',
    'reconcile before', 'reconcile partial', 'reconcile after',
    'resolved compact rename before', 'resolved compact rename after'];
  for (const [source, point] of ['result write failure', 'sync throw', 'async reject', 'malformed outcome']
    .flatMap((source) => crashPoints.map((point) => [source, point] as const))) {
    it(`${source}: crash at ${point} recovers uncertainty or the durable resolution, never a rerun`, async (t) => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'weave-uncertain-crash-'));
      const path = join(dir, 'fabric.json');
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import * as fs from 'node:fs';
        import { createRequire, syncBuiltinESMExports } from 'node:module';
        import { createGrantAuthority } from '@weave/agentsop';
        import { AgentFabricHost, FabricStore } from '@weave/agentfabric';
        const [path, point, encoded, source] = process.argv.slice(1);
        const contract = JSON.parse(encoded);
        const store = FabricStore.open(path);
        const authority = createGrantAuthority();
        const host = new AgentFabricHost({ authority, store, contracts: [contract] });
        const target = host.registerDestination('mem:crash');
        host.installAdmitted(contract, () => {
          if (source === 'sync throw') throw new Error('implementation fault');
          if (source === 'async reject') return Promise.reject(new Error('implementation fault'));
          if (source === 'malformed outcome') return undefined;
          return { outcome: 'succeeded', output: { ok: true } };
        });
        const grant = authority.issue({ action_id: 'action', operation: contract.id, contract_rev: '1',
          permissions: [{ resource: target, mode: 'write' }], effects: [{ resource: target, mode: 'write' }], issued_at: 1 });
        const handle = host.invoke(grant, contract.id, { target }, { invocation_id: 'inv' });
        if (handle.kind !== 'handle') throw new Error(handle.reason);
        const mutable = createRequire(import.meta.url)('node:fs');
        const originalWrite = mutable.writeSync;
        mutable.writeSync = (...args) => {
          const line = String(args[1]);
          const op = point.startsWith('marker') ? 'uncertain' : point.startsWith('reconcile ') ? 'reconcile' : null;
          if (op && line.includes('"op":"' + op + '"')) {
            if (point.endsWith('before')) process.exit(86);
            if (point.endsWith('partial')) { originalWrite(args[0], args[1], 0, 15); process.exit(86); }
            originalWrite(...args); process.exit(86);
          }
          return originalWrite(...args);
        };
        syncBuiltinESMExports();
        store.persistResult = source !== 'result write failure';
        host.release('action'); await handle.result;
        if (point.startsWith('reconcile ') || point.startsWith('resolved ')) {
          host.reconcile('inv', { resolution: 'not_committed', evidence: 'external audit' });
        }
        const originalTemp = mutable.writeFileSync;
        mutable.writeFileSync = (...args) => {
          if (String(args[0]) === path + '.tmp' && point.includes('temp')) {
            if (point.endsWith('before')) process.exit(86);
            originalTemp(...args); process.exit(86);
          }
          return originalTemp(...args);
        };
        const originalRename = mutable.renameSync;
        mutable.renameSync = (...args) => {
          if (String(args[1]) === path && point.includes('rename')) {
            if (point.endsWith('before')) process.exit(86);
            originalRename(...args); process.exit(86);
          }
          return originalRename(...args);
        };
        syncBuiltinESMExports();
        store.compact();
        throw new Error('crash injection was not reached');
      `, path, point, JSON.stringify(write), source], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.status, 86, child.stderr || String(child.error));
      const store = FabricStore.open(path);
      t.after(() => store.close());
      const authority = createGrantAuthority();
      const host = new AgentFabricHost({ authority, store, contracts: [write] });
      const record = store.getInvocation('inv')!;
      host.installAdmitted(write, () => { throw new Error('recovery must never rerun'); });
      const target = (record.inputs as { target: string }).target;
      const grant = authority.issue({ action_id: 'action', operation: write.id, contract_rev: '1',
        permissions: [{ resource: target, mode: 'write' }], effects: [{ resource: target, mode: 'write' }], issued_at: 1 });
      const resolved = point === 'reconcile after' || point.startsWith('resolved ');
      const found = host.lookup('inv', grant);
      assert.equal('status' in found && found.status, resolved ? 'stopped' : 'unresolved');
      assert.equal(host.coordinator.held().length, resolved ? 0 : 1);
      const replay = host.invoke(grant, write.id, { target }, { invocation_id: 'inv' });
      assert.equal(replay.kind, 'handle');
      if (replay.kind === 'handle') assert.equal((await replay.result).outcome, resolved ? 'failed' : 'uncertain');
      assert.deepEqual(host.releaseAll(), []);
      if (!resolved) reconcile(host, absent);
    });
  }


  for (const contract of [write, read, discover, pure]) {
    for (const failedResult of [false, true]) {
      it(`${contract.id} uncertainty retains only declared-write reservations (failed result: ${failedResult})`, async (t) => {
        const f = fixture(t, contract);
        f.host.release('action');
        f.store.persistResult = !failedResult;
        f.complete(failedResult ? succeeded : uncertain);
        const outcome = await f.handle.result;
        assert.equal(outcome.outcome, 'uncertain');
        assert.equal(f.store.getInvocation('inv')?.status, 'uncertain');
        assert.equal(f.host.coordinator.held().length, contract === write ? 1 : 0);
        await assertReplay(f, outcome);
        f.reopen();
        assert.equal(f.host.coordinator.held().length, contract === write ? 1 : 0);
        assert.deepEqual(f.host.lookup('inv', f.originalGrant), { status: 'unresolved', reason: (outcome as { reason: string }).reason });
        await assertReplay(f, outcome);
        const conflict = f.invoke('conflict', f.grant('conflict'));
        assert.equal(conflict.kind, contract === write ? 'rejected' : 'handle');
        if (conflict.kind === 'handle') { f.host.release('conflict'); await conflict.result; }
        reconcile(f.host, absent);
        assert.equal(f.host.coordinator.held().length, 0);
        assert.equal((f.host as unknown as { open: Map<string, unknown> }).open.size, 0);
        const after = f.invoke('after', f.grant('after'));
        assert.equal(after.kind, 'handle');
        if (after.kind === 'handle') { f.host.release('after'); await after.result; }
      });
    }
  }

  for (const mode of ['create', 'append', 'delete'] as const) {
    it(`retains a ${mode} reservation across recovery until reconciliation`, async (t) => {
      const contract: CapabilityContract = { ...write, id: `test.${mode}`,
        effects: [{ input: 'target', mode }], permissions: [{ input: 'target', mode }] };
      const f = fixture(t, contract);
      f.host.release('action'); f.complete(uncertain); await f.handle.result;
      assert.equal(f.host.coordinator.held().length, 1);
      f.reopen();
      assert.equal(f.host.coordinator.held().length, 1);
      assert.equal(f.invoke('blocked', f.grant('blocked')).kind, 'rejected');
      reconcile(f.host, absent);
      assert.equal(f.host.coordinator.held().length, 0);
    });
  }

  it('loads a legacy journal without marker or stored scopes and requires reconciliation', async (t) => {
    const f = fixture(t);
    f.host.release('action');
    const snapshot = f.store.snapshot();
    f.store.close();
    const old = { ...snapshot, invocations: snapshot.invocations.map(({ reservation: _reservation, ...record }) => record) };
    fs.writeFileSync(f.path, JSON.stringify(old) + '\n');
    f.reopen();
    assert.equal(f.host.coordinator.held().length, 1);
    const replay = f.invoke();
    assert.equal(replay.kind, 'handle');
    if (replay.kind === 'handle') assert.equal((await replay.result).outcome, 'uncertain');
    assert.deepEqual(f.host.releaseAll(), []);
    reconcile(f.host, absent);
  });

  for (const storedScopes of [false, true]) {
    for (const first of ['inv', 'orphan']) {
      it(`recovers conflicting orphans as a union until both reconcile (scopes: ${storedScopes}, first: ${first})`, (t) => {
        const f = fixture(t);
        const snapshot = f.store.snapshot();
        const { reservation, ...record } = snapshot.invocations[0]!;
        const recovered = storedScopes ? { ...record, reservation } : record;
        f.store.close();
        fs.writeFileSync(f.path, JSON.stringify({ ...snapshot,
          invocations: [recovered, { ...recovered, invocation_id: 'orphan', action_id: 'orphan' }],
        }) + '\n');
        f.reopen();
        for (const id of ['inv', 'orphan']) assert.equal(f.store.getInvocation(id)?.status, 'uncertain');
        assert.equal(f.host.coordinator.held().length, 2);
        assert.equal(f.invoke('blocked', f.grant('blocked')).kind, 'rejected');
        reconcile(f.host, absent, first);
        assert.equal(f.host.coordinator.held().length, 1);
        assert.equal(f.invoke('still-blocked', f.grant('still-blocked')).kind, 'rejected');
        // A restart after resolving just one owner must retain the other hold.
        f.reopen();
        assert.equal(f.host.coordinator.held().length, 1);
        reconcile(f.host, absent, first === 'inv' ? 'orphan' : 'inv');
        assert.equal(f.host.coordinator.held().length, 0);
        assert.equal(f.invoke('released', f.grant('released')).kind, 'handle');
      });
    }
  }

  for (const install of ['installAdmitted', 'replaceLiveContract', 'never'] as const) {
    it(`recovers a legacy orphan with a missing contract (${install}) and permits reconciliation`, async (t) => {
      const f = fixture(t);
      const snapshot = f.store.snapshot();
      const { reservation: _reservation, ...record } = snapshot.invocations[0]!;
      f.store.close();
      fs.writeFileSync(f.path, JSON.stringify({ ...snapshot, invocations: [record] }) + '\n');
      const store = FabricStore.open(f.path);
      t.after(() => store.close());
      const host = new AgentFabricHost({ authority: f.host.authority, store, contracts: [] });
      assert.equal(store.getInvocation('inv')?.status, 'uncertain');
      if (install !== 'never') {
        if (install === 'installAdmitted') host.installAdmitted(write, () => succeeded);
        else host.replaceLiveContract(write);
        const blocked = host.invoke(f.grant('blocked'), write.id, { target: f.target });
        assert.equal(blocked.kind, 'rejected');
        if (blocked.kind === 'rejected') assert.match(blocked.reason, /reconcil/);
        const replay = host.invoke(f.originalGrant, write.id, { target: f.target }, { invocation_id: 'inv' });
        assert.equal(replay.kind, 'handle');
        if (replay.kind === 'handle') assert.equal((await replay.result).outcome, 'uncertain');
      }
      // Independent operations remain usable while the missing contract is unresolved.
      host.installAdmitted(pure, () => succeeded);
      const grant = host.authority.issue({ action_id: 'pure', operation: pure.id, contract_rev: pure.revision,
        permissions: [], effects: [], issued_at: 1 });
      const independent = host.invoke(grant, pure.id, { target: f.target });
      assert.equal(independent.kind, 'handle');
      host.release('pure');
      if (independent.kind === 'handle') assert.deepEqual(await independent.result, succeeded);
      reconcile(host, absent);
      host.installAdmitted(write, () => succeeded);
      const after = host.invoke(f.grant('after'), write.id, { target: f.target });
      assert.equal(after.kind, 'handle');
      host.release('after');
      if (after.kind === 'handle') assert.deepEqual(await after.result, succeeded);
    });
  }

  it('keeps every missing-scope barrier through failed marker and reconciliation writes', async (t) => {
    const f = fixture(t);
    const snapshot = f.store.snapshot();
    const { reservation: _reservation, ...record } = snapshot.invocations[0]!;
    const store = FabricStore.restore({ ...snapshot, invocations: [record,
      { ...record, invocation_id: 'orphan', action_id: 'orphan' }] });
    store.persistInvocationUncertain = () => { throw new Error('marker write refused'); };
    const host = new AgentFabricHost({ authority: f.host.authority, store, contracts: [] });
    host.installAdmitted(write, () => succeeded);
    assert.equal(store.getInvocation('inv')?.status, 'running');
    assert.equal(host.invoke(f.grant('blocked'), write.id, { target: f.target }).kind, 'rejected');
    const persist = store.persistInvocationReconciliation.bind(store);
    store.persistInvocationReconciliation = () => { throw new Error('resolution write refused'); };
    assert.throws(() => reconcile(host, absent), /resolution write refused/);
    assert.equal(host.invoke(f.grant('still-blocked'), write.id, { target: f.target }).kind, 'rejected');
    store.persistInvocationReconciliation = persist;
    reconcile(host, absent);
    assert.equal(host.invoke(f.grant('other-owner'), write.id, { target: f.target }).kind, 'rejected');
    reconcile(host, absent, 'orphan');
    const after = host.invoke(f.grant('after'), write.id, { target: f.target });
    assert.equal(after.kind, 'handle');
    host.release('after');
    if (after.kind === 'handle') assert.deepEqual(await after.result, succeeded);
  });

  it('blocks a legacy operation whose installed contract cannot rebind its old inputs', (t) => {
    const f = fixture(t);
    const snapshot = f.store.snapshot();
    const { reservation: _reservation, ...record } = snapshot.invocations[0]!;
    const store = FabricStore.restore({ ...snapshot, invocations: [{ ...record, inputs: {} }] });
    const host = new AgentFabricHost({ authority: f.host.authority, store, contracts: [write] });
    host.installAdmitted(write, () => succeeded);
    assert.equal(store.getInvocation('inv')?.status, 'uncertain');
    assert.equal(host.invoke(f.grant('blocked'), write.id, { target: f.target }).kind, 'rejected');
    reconcile(host, absent);
    assert.equal(host.invoke(f.grant('after'), write.id, { target: f.target }).kind, 'handle');
  });

  it('canonical recovery holds block aliases even with the contract absent', async (t) => {
    const f = fixture(t);
    const alias = f.host.alias(f.target);
    f.host.release('action'); f.complete(uncertain); await f.handle.result;
    const snapshot = f.store.snapshot();
    const host = new AgentFabricHost({ authority: f.host.authority, store: FabricStore.restore(snapshot), contracts: [] });
    assert.equal(host.coordinator.isHeld(f.store.lookupRef(alias)!.canonical_id), true);
    host.installAdmitted(write, () => succeeded);
    const issued = host.authority.issue({ action_id: 'alias', operation: write.id, contract_rev: '1',
      permissions: [{ resource: alias, mode: 'write' }], effects: [{ resource: alias, mode: 'write' }], issued_at: 1 });
    const blocked = host.invoke(issued, write.id, { target: alias });
    assert.equal(blocked.kind, 'rejected');
    if (blocked.kind === 'rejected') assert.match(blocked.reason, /effect conflict/);
    reconcile(host, absent);
    assert.equal(host.coordinator.held().length, 0);
  });

  for (const op of ['uncertain', 'reconcile'] as const) {
    it(`rolls back a partial ${op} append without releasing reservations`, async (t) => {
      const f = fixture(t);
      f.host.release('action');
      if (op === 'reconcile') { f.complete(uncertain); await f.handle.result; }
      else f.store.persistResult = false;
      const before = fs.readFileSync(f.path);
      const mutable = createRequire(import.meta.url)('node:fs') as typeof fs;
      const original = mutable.writeSync;
      let partial = false;
      mutable.writeSync = ((...args: Parameters<typeof original>) => {
        if (String(args[1]).includes(`"op":"${op}"`)) {
          if (!partial) { partial = true; return original(args[0], args[1] as unknown as Buffer, 0, 13); }
          throw new Error('injected partial append failure');
        }
        return original(...args);
      }) as typeof original;
      syncBuiltinESMExports();
      try {
        if (op === 'uncertain') { f.complete(succeeded); assert.equal((await f.handle.result).outcome, 'uncertain'); }
        else assert.throws(() => reconcile(f.host, absent), /partial append/);
        assert.equal(partial, true);
        assert.deepEqual(fs.readFileSync(f.path), before);
        assert.equal(f.host.coordinator.held().length, 1);
      } finally { mutable.writeSync = original; syncBuiltinESMExports(); }
      reconcile(f.host, absent);
      assert.equal(f.host.coordinator.held().length, 0);
      f.reopen();
      assert.equal(f.store.getInvocation('inv')?.status, 'stopped');
    });
  }

  it('restores reservations without a live implementation and never reruns an interrupted start', async (t) => {
    const f = fixture(t);
    f.host.release('action');
    f.reopen(false);
    assert.equal(f.host.coordinator.held().length, 1);
    assert.equal(lookupStatus(f.host, 'inv', f.originalGrant), 'unresolved');
    // Install only after verifying that restoration does not depend on it.
    f.host.installAdmitted(write, () => { throw new Error('must not run'); });
    const replay = f.invoke();
    assert.equal(replay.kind, 'handle');
    if (replay.kind === 'handle') assert.equal((await replay.result).outcome, 'uncertain');
    assert.deepEqual(f.host.releaseAll(), []);
    reconcile(f.host, absent);
  });

  for (const fault of ['closed', 'lost lock'] as const) {
    it(`keeps in-memory uncertainty when result and marker writes fail: ${fault}`, async (t) => {
      const f = fixture(t);
      f.host.release('action');
      const lock = fs.readFileSync(`${f.path}.lock`);
      if (fault === 'closed') f.store.close();
      else fs.writeFileSync(`${f.path}.lock`, 'replacement');
      f.complete(succeeded);
      const result = await f.handle.result;
      assert.equal(result.outcome, 'uncertain');
      assert.equal(f.host.coordinator.held().length, 1);
      await assertReplay(f, result);
      assert.throws(() => reconcile(f.host, absent), /closed|lock/);
      assert.equal(f.host.coordinator.held().length, 1);
      if (fault === 'lost lock') fs.writeFileSync(`${f.path}.lock`, lock);
      f.reopen();
      assert.equal(lookupStatus(f.host, 'inv', f.originalGrant), 'unresolved');
      const recovered = f.invoke();
      assert.equal(recovered.kind, 'handle');
      if (recovered.kind === 'handle') assert.equal((await recovered.result).outcome, 'uncertain');
      reconcile(f.host, absent);
    });
  }

  for (const resolution of [absent, { resolution: 'committed', evidence: 'receipt 42', output: { ok: true } } as const]) {
    it(`durably records ${resolution.resolution}, refuses double resolution, and never renews the grant`, async (t) => {
      const f = fixture(t);
      f.host.release('action'); f.complete(uncertain); await f.handle.result;
      reconcile(f.host, resolution);
      const record = f.store.getInvocation('inv')!;
      assert.deepEqual((record as unknown as { reconciliation: unknown }).reconciliation,
        { resolution: resolution.resolution, evidence: resolution.evidence });
      const snapshot = f.store.snapshot();
      assert.throws(() => reconcile(f.host, resolution), /already reconciled/);
      assert.deepEqual(f.store.snapshot(), snapshot);
      assert.equal(f.host.coordinator.held().length, 0);
      f.reopen();
      await assertReplay(f, record.outcome!);
      assert.throws(() => reconcile(f.host, resolution), /already reconciled/);
      assert.equal(f.invoke('another-id').kind, 'rejected');
    });
  }

  it('refuses invalid, unknown, active and failed reconciliation without changing state', async (t) => {
    const f = fixture(t);
    assert.throws(() => reconcile(f.host, absent), /active/);
    f.host.release('action');
    assert.throws(() => reconcile(f.host, absent), /active/);
    f.complete(uncertain); await f.handle.result;
    for (const bad of [null, {}, { resolution: 'other', evidence: 'audit' },
      { resolution: 'not_committed', evidence: '' }, { resolution: 'not_committed', evidence: '   ' },
      { resolution: 'committed', evidence: 'audit' }, { resolution: 'committed', evidence: 'audit', output: 1n }]) {
      const snapshot = f.store.snapshot(); const bytes = fs.readFileSync(f.path);
      assert.throws(() => reconcile(f.host, bad as Resolution), /invalid/);
      assert.deepEqual(f.store.snapshot(), snapshot); assert.deepEqual(fs.readFileSync(f.path), bytes);
      assert.equal(f.host.coordinator.held().length, 1);
    }
    assert.throws(() => reconcile(f.host, absent, 'missing'), /unknown/);
    const persist = (f.store as unknown as { persistInvocationReconciliation: (record: unknown) => void });
    const original = persist.persistInvocationReconciliation;
    persist.persistInvocationReconciliation = () => { throw new Error('injected write failure'); };
    const snapshot = f.store.snapshot();
    assert.throws(() => reconcile(f.host, absent), /write failure/);
    assert.deepEqual(f.store.snapshot(), snapshot); assert.equal(f.host.coordinator.held().length, 1);
    persist.persistInvocationReconciliation = original;
    reconcile(f.host, absent);
  });

  it('keeps conflicts blocked and prevents reentrant reconciliation until its append commits', async (t) => {
    const f = fixture(t);
    f.host.release('action'); f.complete(uncertain); await f.handle.result;
    const persist = f.store.persistInvocationReconciliation.bind(f.store);
    const snapshot = f.store.snapshot();
    f.store.persistInvocationReconciliation = (record) => {
      f.handle.requestCancel();
      assert.throws(() => reconcile(f.host, absent), /active/);
      assert.equal(f.invoke('conflict', f.grant('conflict')).kind, 'rejected');
      const replay = f.invoke();
      assert.equal(replay.kind, 'handle');
      assert.deepEqual(f.store.snapshot(), snapshot);
      persist(record);
      assert.equal(f.host.coordinator.held().length, 1, 'release follows the durable append');
    };
    reconcile(f.host, absent);
    assert.equal(f.host.coordinator.held().length, 0);
    f.reopen();
    assert.equal(f.store.getInvocation('inv')?.status, 'stopped');
    assert.equal(f.store.getInvocation('inv')?.cancel_requested, false);
  });

  it('cancellation during a pending run and reconciliation cannot resolve uncertainty or overwrite resolution', async (t) => {
    const f = fixture(t);
    f.host.release('action'); f.handle.requestCancel(); f.complete(uncertain); await f.handle.result;
    assert.equal(f.store.getInvocation('inv')?.cancel_requested, true);
    assert.equal(f.host.coordinator.held().length, 1);
    const mutable = createRequire(import.meta.url)('node:fs') as typeof fs;
    const original = mutable.writeSync;
    let cancelled = false;
    mutable.writeSync = ((...args: Parameters<typeof original>) => {
      const count = original(...args);
      if (String(args[1]).includes('"op":"reconcile"')) { cancelled = true; f.handle.requestCancel(); }
      return count;
    }) as typeof original;
    syncBuiltinESMExports();
    try { reconcile(f.host, absent); }
    finally { mutable.writeSync = original; syncBuiltinESMExports(); }
    assert.equal(cancelled, true);
    assert.equal(f.store.getInvocation('inv')?.status, 'stopped');
    f.handle.requestCancel();
    f.reopen();
    assert.equal(f.store.getInvocation('inv')?.status, 'stopped');
    assert.equal(f.store.getInvocation('inv')?.cancel_requested, true);
    assert.equal(f.host.coordinator.held().length, 0);
  });
});
