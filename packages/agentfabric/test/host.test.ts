/**
 * AgentFabric host checks independent of Weave scheduling (M1-T04, T15, aliases,
 * failure precedence, catalogue rules).
 */
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createGrantAuthority, type Grant, type InvocationOutcome, validateCatalogue } from '@weave/agentsop';
import { AgentFabricHost, type CapabilityImplementation, FabricStore, REPORT_PUBLISH, SOURCE_INSPECT } from '@weave/agentfabric';

function inspectGrant(authority: ReturnType<typeof createGrantAuthority>, source: string, action_id: string): Grant {
  return authority.issue({
    action_id,
    operation: SOURCE_INSPECT.id,
    contract_rev: SOURCE_INSPECT.revision,
    permissions: [{ resource: source, mode: 'read' }],
    effects: [{ resource: source, mode: 'read' }],
    issued_at: 1,
  });
}

describe('admitted implementation single-use release', () => {
  const succeeded: InvocationOutcome = { outcome: 'succeeded', output: { revision: 1 } };

  function deferred() {
    let resolve!: (outcome: InvocationOutcome) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<InvocationOutcome>((yes, no) => { resolve = yes; reject = no; });
    return { result, resolve, reject };
  }

  function fixture(t: TestContext, run: CapabilityImplementation) {
    const dir = mkdtempSync(join(tmpdir(), 'weave-host-single-release-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority, store });
    const source = host.registerSource('mem:single-release', 'line');
    const counts = { runs: 0, finishes: 0, settlements: 0, reservationReleases: 0 };
    host.installAdmitted(SOURCE_INSPECT, (inputs, context) => {
      counts.runs += 1;
      return run(inputs, context);
    });
    const persist = store.persistInvocationResult.bind(store);
    store.persistInvocationResult = (record) => { counts.finishes += 1; persist(record); };
    const release = host.coordinator.release.bind(host.coordinator);
    host.coordinator.release = (id) => { counts.reservationReleases += 1; release(id); };
    const grant = inspectGrant(authority, source, 'single-action');
    const handle = host.invoke(grant, SOURCE_INSPECT.id, { source }, { invocation_id: 'single-invocation' });
    assert.equal(handle.kind, 'handle');
    if (handle.kind !== 'handle') throw new Error('expected invocation handle');
    const result = handle.result.then((outcome) => { counts.settlements += 1; return outcome; });
    const records = () => readFileSync(path, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { op: string; record?: { invocation_id: string; status: string } })
      .filter((entry) => entry.op === 'result' && entry.record?.invocation_id === handle.invocation_id);
    return { path, store, host, source, grant, handle, result, counts, records };
  }

  for (const second of ['release', 'releaseAll', 'proceed'] as const) {
    it(`runs once for same-tick release followed by ${second}, including replay`, async (t) => {
      const pending = deferred();
      const f = fixture(t, () => pending.result);
      f.host.release('single-action');
      if (second === 'release') f.host.release('single-action');
      else if (second === 'releaseAll') f.host.releaseAll();
      else f.host.proceed('single-action');
      const runsWhilePending = f.counts.runs;
      pending.resolve(succeeded);
      assert.deepEqual(await f.result, succeeded);
      assert.equal(runsWhilePending, 1);
      assert.deepEqual(f.counts, { runs: 1, finishes: 1, settlements: 1, reservationReleases: 1 });
      assert.equal(f.records().length, 1);
      f.store.close();
      const reopened = FabricStore.open(f.path);
      try {
        const host = new AgentFabricHost({ authority: f.host.authority, store: reopened });
        host.installAdmitted(SOURCE_INSPECT, () => { f.counts.runs += 1; return succeeded; });
        const replay = host.invoke(f.grant, SOURCE_INSPECT.id, { source: f.source },
          { invocation_id: f.handle.invocation_id });
        assert.equal(replay.kind, 'handle');
        if (replay.kind !== 'handle') throw new Error('expected replay handle');
        assert.deepEqual(await replay.result, succeeded);
        assert.deepEqual(host.releaseAll(), []);
        assert.equal(f.counts.runs, 1);
        assert.equal(f.records().length, 1);
        assert.deepEqual(reopened.getInvocation(f.handle.invocation_id)?.outcome, succeeded);
      } finally { reopened.close(); }
    });
  }

  for (const fault of ['closed store', 'replaced lock', 'persistence refusal'] as const) {
    for (const completion of ['resolves', 'rejects'] as const) {
      it(`ignores late releases and a run that ${completion} after a result write fails: ${fault}`, async (t) => {
        const first = deferred();
        const late = deferred();
        let calls = 0;
        const f = fixture(t, () => ++calls === 1 ? first.result : late.result);
        f.host.release('single-action');
        f.host.releaseAll();
        if (fault === 'closed store') f.store.close();
        if (fault === 'replaced lock') nodeFs.writeFileSync(`${f.path}.lock`, `${process.pid}:replacement`);
        if (fault === 'persistence refusal') f.store.persistResult = false;
        const before = readFileSync(f.path);
        first.resolve(succeeded);
        const markerPersisted = fault === 'persistence refusal';
        const uncertain = { outcome: 'uncertain', reason: 'failed to persist invocation result' +
          (markerPersisted ? '' : '; uncertain marker was not persisted') };
        assert.deepEqual(await f.result, uncertain);
        const holds = structuredClone(f.host.coordinator.held());
        const releases = f.counts.reservationReleases;
        // A retained terminal entry is still excluded from the public release API.
        assert.throws(() => f.host.release('single-action'), /no open invocation/);
        assert.deepEqual(f.host.releaseAll(), []);
        f.store.persistResult = true;
        if (completion === 'resolves') late.resolve(succeeded);
        else {
          // On the fixed host this promise was never returned by run.
          void late.result.catch(() => undefined);
          late.reject(new Error('late implementation failure'));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(await f.handle.result, uncertain);
        assert.equal(f.counts.runs, 1);
        assert.equal(f.counts.finishes, 1);
        assert.equal(f.counts.settlements, 1);
        assert.equal(f.counts.reservationReleases, releases);
        assert.deepEqual(f.host.coordinator.held(), holds);
        assert.deepEqual(f.host.lookup(f.handle.invocation_id, f.grant), {
          status: 'unresolved', reason: uncertain.reason,
        });
        assert.equal(f.store.getInvocation(f.handle.invocation_id)?.status, markerPersisted ? 'uncertain' : 'running');
        if (markerPersisted) assert.notDeepEqual(readFileSync(f.path), before);
        else assert.deepEqual(readFileSync(f.path), before);
        assert.equal(f.records().length, 0);
      });
    }
  }

  for (const completion of ['resolves', 'rejects', 'throws synchronously'] as const) {
    it(`settles once when releaseAll is called inside run and the implementation ${completion}`, async (t) => {
      const pending = deferred();
      let f: ReturnType<typeof fixture>;
      f = fixture(t, () => {
        // Bound recursion on the broken host, so red is a count failure rather than a stack overflow.
        if (f.counts.runs === 1) f.host.releaseAll();
        if (completion === 'throws synchronously') throw new Error('implementation failed');
        return pending.result;
      });
      assert.doesNotThrow(() => f.host.release('single-action'));
      if (completion !== 'throws synchronously') f.host.releaseAll();
      if (completion === 'resolves') pending.resolve(succeeded);
      if (completion === 'rejects') pending.reject(new Error('implementation failed'));
      assert.deepEqual(await f.result, completion === 'resolves'
        ? succeeded : { outcome: 'failed', failure: 'implementation failed' });
      assert.deepEqual(f.counts, { runs: 1, finishes: 1, settlements: 1, reservationReleases: 1 });
      assert.equal(f.records().length, 1);
    });
  }

  it('does not start another run after stop requests cancellation of a pending run', async (t) => {
    const pending = deferred();
    const f = fixture(t, () => pending.result);
    f.host.release('single-action');
    f.handle.requestCancel();
    f.host.release('single-action');
    f.host.releaseAll();
    pending.resolve({ outcome: 'failed', failure: 'cancelled' });
    assert.deepEqual(await f.result, { outcome: 'failed', failure: 'cancelled' });
    assert.deepEqual(f.counts, { runs: 1, finishes: 1, settlements: 1, reservationReleases: 1 });
    assert.equal(f.store.getInvocation(f.handle.invocation_id)?.cancel_requested, true);
    // Cancellation writes a running record; settlement adds one terminal record.
    assert.deepEqual(f.records().map((entry) => entry.record?.status), ['running', 'stopped']);
  });

  it('denies reuse of the invocation grant while its implementation is pending', async (t) => {
    const pending = deferred();
    const f = fixture(t, () => pending.result);
    f.host.release('single-action');
    const reused = f.host.invoke(f.grant, SOURCE_INSPECT.id, { source: f.source }, { invocation_id: 'second-invocation' });
    assert.equal(reused.kind, 'rejected');
    if (reused.kind !== 'rejected') throw new Error('expected grant reuse rejection');
    assert.equal(reused.code, 'DENIED');
    f.host.releaseAll();
    pending.resolve(succeeded);
    await f.result;
    assert.deepEqual(f.counts, { runs: 1, finishes: 1, settlements: 1, reservationReleases: 1 });
    assert.equal(f.host.invocations.length, 1);
    assert.equal(f.records().length, 1);
  });
});

describe('AgentFabric host authority', () => {
  for (const fault of ['closed store', 'replaced lock', 'poisoned append', 'validation error', 'persistence refusal',
    'rejected implementation', 'uncertain implementation', 'cache error']) {
    it(`settles an admitted implementation after ${fault} without an unhandled rejection`, () => {
      // Observe unhandled rejections in a child, independently of node:test's hook.
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { createGrantAuthority } from '@weave/agentsop';
        import { AgentFabricHost, FabricStore, SOURCE_INSPECT } from '@weave/agentfabric';
        const fault = ${JSON.stringify(fault)};
        const dir = mkdtempSync(join(tmpdir(), 'weave-host-settlement-'));
        const path = join(dir, 'fabric.json');
        const store = FabricStore.open(path);
        const unhandled = [];
        process.on('unhandledRejection', (error) => unhandled.push(error));
        try {
          const authority = createGrantAuthority();
          const host = new AgentFabricHost({ authority, store });
          const source = host.registerSource('mem:settlement', 'line');
          let complete, reject;
          const running = new Promise((resolve, fail) => { complete = resolve; reject = fail; });
          host.installAdmitted(SOURCE_INSPECT, () => running);
          const grant = authority.issue({ action_id: 'settle-action', operation: SOURCE_INSPECT.id,
            contract_rev: SOURCE_INSPECT.revision, permissions: [{ resource: source, mode: 'read' }],
            effects: [{ resource: source, mode: 'read' }], issued_at: 1 });
          const handle = host.invoke(grant, SOURCE_INSPECT.id, { source }, { invocation_id: 'settle-invocation' });
          assert.equal(handle.kind, 'handle');
          host.release('settle-action');
          assert.equal(host.coordinator.held().length, 1);
          if (fault === 'closed store' || fault === 'rejected implementation') store.close();
          if (fault === 'replaced lock') {
            rmSync(path + '.lock');
            writeFileSync(path + '.lock', 'replacement owner');
          }
          if (fault === 'poisoned append') {
            appendFileSync(path, 'unexpected journal bytes');
            assert.throws(() => store.retainConclusion('unaccepted'), /unexpected journal length/);
          }
          if (fault === 'validation error') {
            store.persistInvocationResult = () => { throw new TypeError('injected result validation error'); };
          }
          if (fault === 'persistence refusal' || fault === 'uncertain implementation') store.persistResult = false;
          let cacheAttempts = 0;
          if (fault === 'cache error') {
            store.rememberResult = () => { cacheAttempts += 1; throw new Error('injected cache error'); };
          }
          const before = readFileSync(path);
          const completed = fault === 'uncertain implementation'
            ? { outcome: 'uncertain', reason: 'implementation cannot confirm effects' }
            : { outcome: 'succeeded', output: { revision: 1 } };
          if (fault === 'rejected implementation') reject(new Error('implementation failed'));
          else complete(completed);
          const result = await Promise.race([handle.result, new Promise((resolve) => setImmediate(() => resolve('unsettled')))]);
          if (fault === 'cache error') {
            assert.deepEqual(result, completed);
            assert.equal(cacheAttempts, 1);
            assert.equal(store.getInvocation('settle-invocation').status, 'committed');
          } else {
            const markerPersisted = ['validation error', 'persistence refusal', 'uncertain implementation'].includes(fault);
            assert.deepEqual(result, fault === 'uncertain implementation' ? completed : { outcome: 'uncertain',
              reason: 'failed to persist invocation result' + (markerPersisted ? '' : '; uncertain marker was not persisted') });
            if (markerPersisted) {
              assert.notDeepEqual(readFileSync(path), before);
              assert.equal(store.getInvocation('settle-invocation').status, 'uncertain');
            } else assert.deepEqual(readFileSync(path), before);
            assert.deepEqual(host.lookup('settle-invocation', grant), {
              status: 'unresolved', reason: result.reason,
            });
          }
          assert.equal(host.openCount(), 0);
          assert.deepEqual(host.openInvocationIds(), []);
          assert.equal(host.coordinator.held().length, 0);
          store.close();
          if (fault === 'replaced lock') assert.equal(readFileSync(path + '.lock', 'utf8'), 'replacement owner');
          await new Promise((resolve) => setImmediate(resolve));
          assert.deepEqual(unhandled, []);
        } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
      `], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.status, 0, child.stderr || String(child.error));
    });
  }

  for (const malformed of ['undefined output', 'non-string failure', 'BigInt output', 'cyclic output', 'invalid serialized outcome']) {
    it(`settles an admitted implementation's ${malformed} without an unhandled rejection`, () => {
      // Isolate rejection observation from node:test's own unhandled-rejection hook.
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { mkdtempSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { createGrantAuthority } from '@weave/agentsop';
        import { AgentFabricHost, FabricStore, SOURCE_INSPECT } from '@weave/agentfabric';
        const dir = mkdtempSync(join(tmpdir(), 'weave-host-invalid-outcome-'));
        const path = join(dir, 'fabric.json');
        const store = FabricStore.open(path);
        const unhandled = [];
        process.on('unhandledRejection', (error) => unhandled.push(error));
        try {
          const authority = createGrantAuthority();
          const host = new AgentFabricHost({ authority, store });
          const source = host.registerSource('mem:invalid-outcome', 'line');
          const cyclic = {}; cyclic.self = cyclic;
          const outcomes = {
            'undefined output': { outcome: 'succeeded', output: undefined },
            'non-string failure': { outcome: 'failed', failure: 42 },
            'BigInt output': { outcome: 'succeeded', output: 1n },
            'cyclic output': { outcome: 'succeeded', output: cyclic },
            'invalid serialized outcome': { outcome: 'succeeded', output: {}, toJSON: () => ({ outcome: 'succeeded' }) },
          };
          host.installAdmitted(SOURCE_INSPECT, async () => outcomes[${JSON.stringify(malformed)}]);
          const grant = authority.issue({ action_id: 'invalid-action', operation: SOURCE_INSPECT.id,
            contract_rev: SOURCE_INSPECT.revision, permissions: [{ resource: source, mode: 'read' }],
            effects: [{ resource: source, mode: 'read' }], issued_at: 1 });
          const handle = host.invoke(grant, SOURCE_INSPECT.id, { source }, { invocation_id: 'invalid-invocation' });
          assert.equal(handle.kind, 'handle');
          assert.equal(host.coordinator.held().length, 1);
          host.release('invalid-action');
          const result = await Promise.race([handle.result, new Promise((resolve) => setImmediate(() => resolve('unsettled')))]);
          assert.deepEqual(result, { outcome: 'failed', failure: 'implementation returned an invalid outcome' });
          assert.equal(host.openCount(), 0);
          assert.deepEqual(host.openInvocationIds(), []);
          assert.deepEqual(host.coordinator.held(), []);
          assert.equal(store.getInvocation('invalid-invocation').status, 'stopped');
          store.close();
          const reopened = FabricStore.open(path);
          try { assert.deepEqual(reopened.getInvocation('invalid-invocation').outcome, result); }
          finally { reopened.close(); }
          await new Promise((resolve) => setImmediate(resolve));
          assert.deepEqual(unhandled, []);
        } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
      `], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.status, 0, child.stderr || String(child.error));
    });
  }

  it('retains only conclusions accepted and normalized by the store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-host-conclusion-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    const host = new AgentFabricHost({ authority: createGrantAuthority(), store });
    try {
      host.retainConclusion('accepted');
      for (const invalid of [undefined, 1n]) {
        assert.throws(() => host.retainConclusion(invalid));
        assert.deepEqual(host.conclusions(), ['accepted']);
      }
      const conclusion = { optional: undefined, finite: NaN, nested: { evidence: 'accepted' } };
      host.retainConclusion(conclusion);
      conclusion.nested.evidence = 'mutated';
      assert.deepEqual(host.conclusions(), ['accepted', { finite: null, nested: { evidence: 'accepted' } }]);
      assert.deepEqual(host.conclusions(), store.conclusions());
      store.close();
      const reopened = FabricStore.open(path);
      try { assert.deepEqual(host.conclusions(), reopened.conclusions()); }
      finally { reopened.close(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not retain a conclusion after persistence is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-host-conclusion-closed-'));
    const store = FabricStore.open(join(dir, 'fabric.json'));
    const host = new AgentFabricHost({ authority: createGrantAuthority(), store });
    store.close();
    try {
      assert.throws(() => host.retainConclusion('unaccepted'), /closed/);
      assert.deepEqual(host.conclusions(), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const late of ['completion', 'cancellation'] as const) {
    it(`preserves successor records on late invocation ${late} after store close`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-host-closed-store-'));
      const path = join(dir, 'fabric.json');
      const store = FabricStore.open(path);
      const authority = createGrantAuthority();
      const host = new AgentFabricHost({ authority, store });
      const source = host.registerSource('mem:late', 'line');
      const handle = host.invoke(inspectGrant(authority, source, 'late-action'), SOURCE_INSPECT.id,
        { source }, { invocation_id: 'late-invocation' });
      assert.equal(handle.kind, 'handle');
      if (handle.kind !== 'handle') throw new Error('expected invocation handle');
      store.close();
      const successor = FabricStore.open(path);
      try {
        successor.retainConclusion('successor evidence');
        const before = readFileSync(path);
        if (late === 'completion') {
          host.release('late-action');
          assert.deepEqual(await handle.result, { outcome: 'uncertain',
            reason: 'failed to persist invocation result; uncertain marker was not persisted' });
          assert.equal(host.openCount(), 0);
          assert.deepEqual(host.coordinator.held(), []);
        } else {
          assert.throws(() => host.requestCancel('late-invocation'), /closed/);
        }
        assert.deepEqual(readFileSync(path), before);
        assert.deepEqual(successor.conclusions(), ['successor evidence']);
      } finally {
        successor.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('M1-T04 forged, absent, copied and widened grants are denied without resource access', () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const alpha = host.registerSource('mem:alpha', 'a');
    const gamma = host.registerSource('mem:gamma', 'g');
    const grant = inspectGrant(authority, alpha, 'a:1:1');

    const absent = host.invoke(null, 'source.inspect', { source: gamma });
    const forged = host.invoke(
      {
        action_id: 'a:1:9',
        operation: 'source.inspect',
        contract_rev: 'r1',
        permissions: [{ resource: gamma, mode: 'read' }],
        effects: [{ resource: gamma, mode: 'read' }],
        issued_at: 1,
      },
      'source.inspect',
      { source: gamma },
    );
    const copied = host.invoke(structuredClone(grant), 'source.inspect', { source: alpha });
    const widened = host.invoke(grant, 'source.inspect', { source: gamma });
    const unknown = host.invoke(
      {
        action_id: 'a:1:8',
        operation: 'source.inspect',
        contract_rev: 'r1',
        permissions: [{ resource: 'ref_missing', mode: 'read' }],
        effects: [{ resource: 'ref_missing', mode: 'read' }],
        issued_at: 1,
      },
      'source.inspect',
      { source: 'ref_missing' },
    );

    for (const result of [absent, forged, copied, widened, unknown]) {
      assert.equal(result.kind, 'rejected');
      assert.equal((result as { code: string }).code, 'DENIED');
    }
    assert.equal(host.resourceAccesses.length, 0);
    assert.equal(host.invocations.length, 0);

    const ok = host.invoke(grant, 'source.inspect', { source: alpha });
    assert.equal(ok.kind, 'handle');
    const reuse = host.invoke(grant, 'source.inspect', { source: alpha });
    assert.equal(reuse.kind, 'rejected');
    assert.equal((reuse as { code: string }).code, 'DENIED');
  });

  it('M1-T15 duplicate identity returns the receipt; a changed binding is refused', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const alpha = host.registerSource('mem:alpha', 'line');
    const dest = host.registerDestination('mem:outbox');
    const report = { entries: [{ source: alpha, revision: 1, line_count: 1, digest: 'x' }], read_set: [{ resource: alpha, revision: 1 }] };
    const inputs = { report, read_set: report.read_set, sources: [alpha], destination: dest, expected_revision: 1 };
    const grant = authority.issue({
      action_id: 'a:3:1',
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: [
        { resource: alpha, mode: 'read' },
        { resource: dest, mode: 'write' },
      ],
      effects: [
        { resource: alpha, mode: 'read' },
        { resource: dest, mode: 'write' },
      ],
      issued_at: 3,
    });
    const first = host.invoke(grant, REPORT_PUBLISH.id, inputs, { invocation_id: 'inv-1' });
    assert.equal(first.kind, 'handle');
    host.release('a:3:1');
    const outcome = await (first as { result: Promise<{ outcome: string; output: { committed_revision: number } }> }).result;
    assert.equal(outcome.outcome, 'succeeded');
    const writes = host.resourceAccesses.filter((a) => a.operation === 'write').length;

    const grant2 = authority.issue({
      action_id: 'a:9:1',
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: grant.permissions,
      effects: grant.effects,
      issued_at: 9,
    });
    const duplicate = host.invoke(grant2, REPORT_PUBLISH.id, inputs, { invocation_id: 'inv-1' });
    assert.equal(duplicate.kind, 'handle');
    const again = await (duplicate as { result: Promise<{ outcome: string }> }).result;
    assert.equal(again.outcome, 'succeeded');
    assert.equal(host.resourceAccesses.filter((a) => a.operation === 'write').length, writes);
    assert.equal(host.revision(dest), 2);

    const changed = { ...inputs, expected_revision: 99 };
    const grant3 = authority.issue({
      action_id: 'a:9:2',
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: grant.permissions,
      effects: grant.effects,
      issued_at: 10,
    });
    const refused = host.invoke(grant3, REPORT_PUBLISH.id, changed, { invocation_id: 'inv-1' });
    assert.equal(refused.kind, 'rejected');
  });

  it('aliases share an effect lock', () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const alpha = host.registerSource('mem:alpha', 'line');
    const dest = host.registerDestination('mem:outbox');
    const alias = host.alias(dest);
    const report = { entries: [], read_set: [{ resource: alpha, revision: 1 }] };
    const inputs = { report: { entries: [{ source: alpha, revision: 1, line_count: 1, digest: 'x' }], read_set: [{ resource: alpha, revision: 1 }] }, read_set: [{ resource: alpha, revision: 1 }], sources: [alpha], destination: dest, expected_revision: 1 };
    void report;
    const grant = authority.issue({
      action_id: 'a:1:1',
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: [
        { resource: alpha, mode: 'read' },
        { resource: dest, mode: 'write' },
      ],
      effects: [
        { resource: alpha, mode: 'read' },
        { resource: dest, mode: 'write' },
      ],
      issued_at: 1,
    });
    const first = host.invoke(grant, REPORT_PUBLISH.id, inputs, { invocation_id: 'p1' });
    assert.equal(first.kind, 'handle');
    const grant2 = authority.issue({
      action_id: 'a:1:2',
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: [
        { resource: alpha, mode: 'read' },
        { resource: alias, mode: 'write' },
      ],
      effects: [
        { resource: alpha, mode: 'read' },
        { resource: alias, mode: 'write' },
      ],
      issued_at: 1,
    });
    const second = host.invoke(grant2, REPORT_PUBLISH.id, { ...inputs, destination: alias }, { invocation_id: 'p2' });
    assert.equal(second.kind, 'rejected');
  });

  it('freezes the validated invocation binding against later input mutation', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const alpha = host.registerSource('mem:alpha', 'line');
    const permitted = host.registerDestination('mem:permitted');
    const substituted = host.registerDestination('mem:substituted');
    const report = {
      entries: [{ source: alpha, revision: 1, line_count: 1, digest: 'x' }],
      read_set: [{ resource: alpha, revision: 1 }],
    };
    const inputs = {
      report,
      read_set: report.read_set,
      sources: [alpha],
      destination: permitted,
      expected_revision: 1,
    };
    const grant = authority.issue({
      action_id: 'a:1:1',
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: [
        { resource: alpha, mode: 'read' },
        { resource: permitted, mode: 'write' },
      ],
      effects: [
        { resource: alpha, mode: 'read' },
        { resource: permitted, mode: 'write' },
      ],
      issued_at: 1,
    });
    const handle = host.invoke(grant, REPORT_PUBLISH.id, inputs);
    assert.equal(handle.kind, 'handle');
    inputs.destination = substituted;
    host.release('a:1:1');
    const outcome = await (handle as { result: Promise<{ outcome: string }> }).result;
    assert.equal(outcome.outcome, 'succeeded');
    assert.equal(host.revision(permitted), 2);
    assert.ok(host.publication(permitted));
    assert.equal(host.revision(substituted), 1);
    assert.equal(host.publication(substituted), null);
  });

  it('rejects a publication whose read_set names a resource outside the granted sources', () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const allowed = host.registerSource('mem:allowed', 'ok');
    const secret = host.registerSource('mem:secret', 'hidden');
    const dest = host.registerDestination('mem:outbox');
    const inputs = {
      report: {
        entries: [{ source: allowed, revision: 1, line_count: 1, digest: 'x' }],
        read_set: [{ resource: secret, revision: 1 }],
      },
      read_set: [{ resource: secret, revision: 1 }],
      sources: [allowed],
      destination: dest,
      expected_revision: 1,
    };
    const grant = authority.issue({
      action_id: 'a:2:1',
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: [
        { resource: allowed, mode: 'read' },
        { resource: dest, mode: 'write' },
      ],
      effects: [
        { resource: allowed, mode: 'read' },
        { resource: dest, mode: 'write' },
      ],
      issued_at: 1,
    });
    const refused = host.invoke(grant, REPORT_PUBLISH.id, inputs);
    assert.equal(refused.kind, 'rejected');
    assert.equal((refused as { code: string }).code, 'INVALID_INPUT');
    assert.equal(host.resourceAccesses.length, 0);
    assert.equal(host.publication(dest), null);
    assert.equal(host.revision(dest), 1);
  });

  it('requires a currently issued scoped grant to look up a receipt', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const alpha = host.registerSource('mem:alpha', 'line');
    const dest = host.registerDestination('mem:outbox');
    const report = {
      entries: [{ source: alpha, revision: 1, line_count: 1, digest: 'x' }],
      read_set: [{ resource: alpha, revision: 1 }],
    };
    const inputs = { report, read_set: report.read_set, sources: [alpha], destination: dest, expected_revision: 1 };
    const grant = authority.issue({
      action_id: 'a:3:1',
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: [
        { resource: alpha, mode: 'read' },
        { resource: dest, mode: 'write' },
      ],
      effects: [
        { resource: alpha, mode: 'read' },
        { resource: dest, mode: 'write' },
      ],
      issued_at: 3,
    });
    const first = host.invoke(grant, REPORT_PUBLISH.id, inputs, { invocation_id: 'inv-lookup' });
    assert.equal(first.kind, 'handle');
    host.release('a:3:1');
    await (first as { result: Promise<unknown> }).result;
    host.authority.revoke(grant);

    const forged = host.lookup('inv-lookup', {
      action_id: 'a:3:1',
      operation: REPORT_PUBLISH.id,
      contract_rev: 'bogus',
      permissions: [],
      effects: [],
      issued_at: 1,
    });
    assert.equal('kind' in forged && forged.kind, 'rejected');
    assert.equal('code' in forged && forged.code, 'DENIED');

    const empty = host.lookup(
      'inv-lookup',
      authority.issue({
        action_id: 'a:3:1',
        operation: REPORT_PUBLISH.id,
        contract_rev: REPORT_PUBLISH.revision,
        permissions: [],
        effects: [],
        issued_at: 4,
      }),
    );
    assert.equal('kind' in empty && empty.kind, 'rejected');
    assert.equal('code' in empty && empty.code, 'DENIED');

    const scoped = host.lookup(
      'inv-lookup',
      authority.issue({
        action_id: 'a:3:1',
        operation: REPORT_PUBLISH.id,
        contract_rev: REPORT_PUBLISH.revision,
        permissions: [
          { resource: alpha, mode: 'read' },
          { resource: dest, mode: 'write' },
        ],
        effects: [
          { resource: alpha, mode: 'read' },
          { resource: dest, mode: 'write' },
        ],
        issued_at: 5,
      }),
    );
    assert.equal('status' in scoped && scoped.status, 'committed');
  });

  it('catalogue rejects a cycle and unequal effect selectors', () => {
    const cyclic = validateCatalogue([
      { ...SOURCE_INSPECT, depends_on: ['report.publish'] },
      { ...REPORT_PUBLISH, depends_on: ['source.inspect'] },
    ]);
    assert.equal(cyclic.ok, false);
    const unequal = validateCatalogue([
      {
        ...SOURCE_INSPECT,
        permissions: [{ input: 'source', mode: 'read' }],
        effects: [{ input: 'source', mode: 'write' }],
        depends_on: [],
      },
    ]);
    assert.equal(unequal.ok, false);
  });

  it('a supplied implementation is not executed', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const alpha = host.registerSource('mem:alpha', 'alpha body');
    let replaced = false;
    const refusal = host.registerImplementation(SOURCE_INSPECT.id, () => {
      replaced = true;
      return { outcome: 'succeeded', output: {} };
    });
    assert.equal(refusal.admitted, false);
    const handle = host.invoke(inspectGrant(authority, alpha, 'a:9:1'), SOURCE_INSPECT.id, { source: alpha });
    assert.equal(handle.kind, 'handle');
    if (handle.kind !== 'handle') {
      return;
    }
    host.release(handle.action_id);
    const outcome = await handle.result;
    assert.equal(outcome.outcome, 'succeeded');
    assert.equal(replaced, false);

    host.replaceLiveContract({
      id: 'text.normalize',
      revision: 'r1',
      purpose: 'Normalize whitespace',
      input: {},
      output: { text: 'string' },
      effects: [],
      permissions: [],
      failures: [],
      depends_on: [],
    });
    let proposed = false;
    host.registerImplementation('text.normalize', () => {
      proposed = true;
      return { outcome: 'succeeded', output: { text: 'x' } };
    });
    const invoked = host.invoke(
      authority.issue({
        action_id: 'a:9:2',
        operation: 'text.normalize',
        contract_rev: 'r1',
        permissions: [],
        effects: [],
        issued_at: 1,
      }),
      'text.normalize',
      {},
    );
    assert.equal(invoked.kind, 'rejected');
    if (invoked.kind === 'rejected') {
      assert.equal(invoked.code, 'UNRESOLVED');
    }
    assert.equal(proposed, false);
    assert.equal(host.resolution('text.normalize'), 'unresolved');
    assert.ok(host.operations().includes('text.normalize'));
  });

  it('an unbound resolver context cannot read or write resources', () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const gamma = host.registerSource('mem:gamma', 'gamma one');
    const ctx = host.resolverContext(SOURCE_INSPECT);
    assert.throws(() => ctx.read(gamma), /DENIED/);
    assert.throws(() => ctx.write(gamma, 1, 'rewritten'), /DENIED/);
    assert.equal(host.content(gamma), 'gamma one');
    assert.equal(host.revision(gamma), 1);
  });
});

describe('Fabric store indexes', () => {
  function publishInput(source: string, destination: string) {
    const report = {
      entries: [{ source, revision: 1, line_count: 1, digest: 'x' }],
      read_set: [{ resource: source, revision: 1 }],
    };
    return { report, read_set: report.read_set, sources: [source], destination, expected_revision: 1 };
  }

  function publishGrant(
    authority: ReturnType<typeof createGrantAuthority>,
    source: string,
    destination: string,
    action_id: string,
    issued_at: number,
  ): Grant {
    return authority.issue({
      action_id,
      operation: REPORT_PUBLISH.id,
      contract_rev: REPORT_PUBLISH.revision,
      permissions: [
        { resource: source, mode: 'read' },
        { resource: destination, mode: 'write' },
      ],
      effects: [
        { resource: source, mode: 'read' },
        { resource: destination, mode: 'write' },
      ],
      issued_at,
    });
  }

  it('cancels an in-flight invocation while compaction rename keeps failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-host-compaction-cancel-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority, store });
    const source = host.registerSource('mem:cancel', 'line');
    const destination = host.registerDestination('mem:cancel-outbox');
    store.putResource({ canonical_id: 'res_padding', kind: 'source', locator: 'mem:padding', revision: 1,
      content: 'x'.repeat(300 * 1024), publication: null }, false);
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof nodeFs;
    const original = mutableFs.renameSync;
    let failures = 0;
    mutableFs.renameSync = ((...args: Parameters<typeof original>) => {
      if (String(args[0]) === `${path}.tmp`) {
        failures += 1;
        throw new Error('injected compaction rename failure');
      }
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      const handle = host.invoke(publishGrant(authority, source, destination, 'cancel-action', 1), REPORT_PUBLISH.id,
        publishInput(source, destination), { invocation_id: 'cancel-invocation' });
      assert.equal(handle.kind, 'handle');
      if (handle.kind !== 'handle') throw new Error('expected invocation handle');
      handle.requestCancel();
      host.release('cancel-action');
      assert.deepEqual(await handle.result, { outcome: 'failed', failure: 'cancelled' });
      assert.ok(failures >= 3);
      assert.equal(host.openCount(), 0);
      assert.equal(store.getInvocation('cancel-invocation')?.status, 'stopped');
      assert.equal(store.getInvocation('cancel-invocation')?.cancel_requested, true);
      store.close();
      const reopened = FabricStore.open(path);
      try {
        assert.equal(reopened.getInvocation('cancel-invocation')?.status, 'stopped');
        assert.equal(reopened.getInvocation('cancel-invocation')?.cancel_requested, true);
      } finally { reopened.close(); }
    } finally {
      mutableFs.renameSync = original;
      syncBuiltinESMExports();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds canonical-primary and publication indexes from a snapshot', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const source = host.registerSource('mem:index-alpha', 'line');
    const alias = host.alias(source);
    const destination = host.registerDestination('mem:index-outbox');
    const grant = publishGrant(authority, source, destination, 'a:index:1', 1);
    const handle = host.invoke(grant, REPORT_PUBLISH.id, publishInput(source, destination), {
      invocation_id: 'inv-index',
    });
    assert.equal(handle.kind, 'handle');
    host.release('a:index:1');
    await (handle as { result: Promise<unknown> }).result;

    const store = FabricStore.restore(host.snapshot());
    const sourceIssued = store.lookupRef(alias);
    const destinationIssued = store.lookupRef(destination);
    assert.ok(sourceIssued);
    assert.ok(destinationIssued);
    assert.equal(store.primaryRef(sourceIssued.canonical_id), source);
    assert.equal(store.primaryRef(destinationIssued.canonical_id), destination);
    assert.equal(store.primaryRef('res_missing'), undefined);
    assert.equal(store.publishedBy('inv-index')?.canonical_id, destinationIssued.canonical_id);
    assert.equal(store.publishedBy('inv-index')?.publication?.invocation_id, 'inv-index');
    assert.equal(store.publishedBy('inv-missing'), undefined);

    const restored = new AgentFabricHost({ authority, store });
    assert.equal(restored.canonicalResource(alias), source);
    assert.equal(restored.canonicalResource('ref_missing'), 'ref_missing');
  });

  it('canonicalResource and lookup read indexes without snapshotting the store', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const source = host.registerSource('mem:index-alpha', 'line');
    const alias = host.alias(source);
    const destination = host.registerDestination('mem:index-outbox');
    const grant = publishGrant(authority, source, destination, 'a:index:2', 2);
    const handle = host.invoke(grant, REPORT_PUBLISH.id, publishInput(source, destination), {
      invocation_id: 'inv-index-lookup',
    });
    assert.equal(handle.kind, 'handle');
    host.release('a:index:2');
    await (handle as { result: Promise<unknown> }).result;

    const snapshot = host.snapshot();
    const running = {
      ...snapshot,
      invocations: snapshot.invocations.map((record) =>
        record.invocation_id === 'inv-index-lookup'
          ? { ...record, status: 'running' as const, outcome: null }
          : record,
      ),
    };
    const restored = new AgentFabricHost({ authority, store: FabricStore.restore(running) });
    const originalSnapshot = restored.store.snapshot;
    let snapshots = 0;
    restored.store.snapshot = () => {
      snapshots += 1;
      return originalSnapshot.call(restored.store);
    };
    try {
      const lookupGrant = publishGrant(authority, source, destination, 'a:index:2', 3);
      assert.equal(restored.canonicalResource(alias), source);
      assert.equal(restored.canonicalResource('ref_missing'), 'ref_missing');
      const found = restored.lookup('inv-index-lookup', lookupGrant);
      assert.equal('status' in found && found.status, 'committed');
      const missing = restored.lookup('inv-missing', lookupGrant);
      assert.equal('status' in missing && missing.status, 'unresolved');
      assert.equal(snapshots, 0);
    } finally {
      restored.store.snapshot = originalSnapshot;
    }

    const uncommittedWithoutPublication = {
      ...running,
      resources: running.resources.map((resource) => ({ ...resource, publication: null })),
    };
    const absent = new AgentFabricHost({
      authority,
      store: FabricStore.restore(uncommittedWithoutPublication),
    });
    const uncertain = absent.lookup(
      'inv-index-lookup',
      publishGrant(authority, source, destination, 'a:index:2', 4),
    );
    assert.equal('status' in uncertain && uncertain.status, 'unresolved');
  });

  for (const fault of ['closed store', 'replaced lock', 'validation error', 'persistence refusal'] as const) {
    for (const pathToCommit of ['rejected acknowledgement', 'after_commit release', 'after_commit proceed', 'disconnect'] as const) {
      it(`settles ${pathToCommit} after ${fault} without escaping and reconciles the publication`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'weave-host-note-committed-'));
        const path = join(dir, 'fabric.json');
        const store = FabricStore.open(path);
        const authority = createGrantAuthority();
        const host = new AgentFabricHost({ authority, store, faults: {
          rejectPromiseAfterCommit: pathToCommit === 'rejected acknowledgement',
          disconnectAfterCommit: pathToCommit === 'disconnect',
          publishGate: pathToCommit === 'after_commit proceed' ? 'before_commit'
            : pathToCommit === 'after_commit release' ? 'after_commit' : 'none',
        } });
        const source = host.registerSource('mem:note-committed', 'line');
        const destination = host.registerDestination('mem:note-committed-outbox');
        const issued = publishGrant(authority, source, destination, 'note-action', 1);
        const handle = host.invoke(issued, REPORT_PUBLISH.id, publishInput(source, destination),
          { invocation_id: 'note-invocation' });
        assert.equal(handle.kind, 'handle');
        if (handle.kind !== 'handle') throw new Error('expected invocation handle');
        const persistResult = store.persistInvocationResult.bind(store);
        let before: Buffer | undefined;
        store.persistInvocationResult = (record) => {
          assert.ok(store.publishedBy('note-invocation')?.publication, 'fault must follow the publication commit');
          before ??= readFileSync(path);
          if (fault === 'closed store') store.close();
          if (fault === 'replaced lock') nodeFs.writeFileSync(`${path}.lock`, `${process.pid}:replacement`);
          if (fault === 'validation error') throw new TypeError('injected result validation error');
          if (fault === 'persistence refusal') store.persistResult = false;
          persistResult(record);
        };
        try {
          assert.doesNotThrow(() => host.release('note-action'));
          if (pathToCommit === 'after_commit proceed') {
            host.faults.publishGate = 'after_commit';
            assert.doesNotThrow(() => host.proceed('note-action'));
          }
          const result = await Promise.race([
            handle.result,
            new Promise((resolve) => setImmediate(() => resolve('unsettled'))),
          ]);
          const markerPersisted = fault === 'validation error' || fault === 'persistence refusal';
          assert.deepEqual(result, { outcome: 'uncertain', reason: 'failed to persist invocation result after commit' +
            (markerPersisted ? '' : '; uncertain marker was not persisted') });
          assert.equal(host.openCount(), 0);
          assert.deepEqual(host.openInvocationIds(), []);
          assert.equal(host.coordinator.held().length, 2);
          if (markerPersisted) {
            assert.notDeepEqual(readFileSync(path), before);
            assert.equal(store.getInvocation('note-invocation')?.status, 'uncertain');
          } else assert.deepEqual(readFileSync(path), before);
          const reconciled = host.lookup('note-invocation', issued);
          assert.equal('status' in reconciled && reconciled.status, markerPersisted ? 'committed' : 'unresolved');
          assert.equal(host.coordinator.held().length, markerPersisted ? 0 : 2);
          store.close();
          if (fault === 'replaced lock') {
            assert.equal(readFileSync(`${path}.lock`, 'utf8'), `${process.pid}:replacement`);
            rmSync(`${path}.lock`);
          }
          const reopened = FabricStore.open(path);
          try {
            const recovered = new AgentFabricHost({ authority, store: reopened });
            const found = recovered.lookup('note-invocation', issued);
            assert.equal('status' in found && found.status, 'committed');
            assert.deepEqual(recovered.coordinator.held(), []);
            assert.equal(reopened.getInvocation('note-invocation')?.status, 'committed');
          } finally { reopened.close(); }
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  for (const gate of ['after_commit', 'disconnect'] as const) {
    it(`settles committed and releases after the second result write fails (${gate})`, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-second-result-'));
      const path = join(dir, 'fabric.json');
      const store = FabricStore.open(path);
      t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
      const authority = createGrantAuthority();
      const host = new AgentFabricHost({ authority, store, faults: gate === 'after_commit'
        ? { publishGate: 'after_commit' } : { disconnectAfterCommit: true } });
      const source = host.registerSource('mem:second-result', 'line');
      const destination = host.registerDestination('mem:second-result-outbox');
      const grant = publishGrant(authority, source, destination, 'second-action', 1);
      const handle = host.invoke(grant, REPORT_PUBLISH.id, publishInput(source, destination),
        { invocation_id: 'second-invocation' });
      assert.equal(handle.kind, 'handle');
      if (handle.kind !== 'handle') throw new Error('expected handle');
      const persist = store.persistInvocationResult.bind(store);
      let writes = 0;
      let markers = 0;
      store.persistInvocationResult = (record) => {
        if (++writes === 2) throw new Error('injected second result write failure');
        persist(record);
      };
      const mark = store.persistInvocationUncertain.bind(store);
      store.persistInvocationUncertain = (record) => { markers += 1; mark(record); };
      host.release('second-action');
      const durable = store.getInvocation('second-invocation')!;
      assert.equal(durable.status, 'committed');
      const before = readFileSync(path);
      host.proceed('second-action');
      assert.equal(writes, 2);
      assert.deepEqual(await handle.result, durable.outcome);
      assert.equal(markers, 0);
      assert.equal(host.openCount(), 0);
      assert.deepEqual(host.coordinator.held(), []);
      assert.deepEqual(host.lookup('second-invocation', grant), { status: 'committed', outcome: durable.outcome });
      assert.deepEqual(readFileSync(path), before);
      const next = host.invoke(publishGrant(authority, source, destination, 'next-action', 2), REPORT_PUBLISH.id,
        { ...publishInput(source, destination), expected_revision: 2 });
      assert.equal(next.kind, 'handle');
      store.close();
      const reopened = FabricStore.open(path);
      try {
        const recovered = new AgentFabricHost({ authority, store: reopened });
        assert.deepEqual(recovered.lookup('second-invocation', grant), { status: 'committed', outcome: durable.outcome });
      } finally { reopened.close(); }
    });
  }

  it('looks up a legacy stopped publication as committed from its durable receipt', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const source = host.registerSource('mem:stopped-receipt', 'line');
    const destination = host.registerDestination('mem:stopped-receipt-outbox');
    const grant = publishGrant(authority, source, destination, 'stopped-action', 1);
    const handle = host.invoke(grant, REPORT_PUBLISH.id, publishInput(source, destination),
      { invocation_id: 'stopped-invocation' });
    assert.equal(handle.kind, 'handle');
    if (handle.kind !== 'handle') throw new Error('expected handle');
    host.release('stopped-action');
    const outcome = await handle.result;
    const snapshot = host.snapshot();
    const store = FabricStore.restore({ ...snapshot, invocations: snapshot.invocations.map((record) => ({
      ...record, status: 'stopped', outcome: { outcome: 'failed', failure: 'legacy interrupted acknowledgement' },
    })) });
    const recovered = new AgentFabricHost({ authority, store });
    assert.deepEqual(recovered.lookup('stopped-invocation', grant), { status: 'committed', outcome });
    assert.deepEqual(recovered.coordinator.held(), []);
  });

  async function publicationReplayFixture(t: TestContext, status: 'stopped' | 'uncertain' | 'running') {
    const authority = createGrantAuthority();
    const original = new AgentFabricHost({ authority });
    const source = original.registerSource('mem:replay-receipt', 'line');
    const destination = original.registerDestination('mem:replay-receipt-outbox');
    const grant = publishGrant(authority, source, destination, 'replay-action', 1);
    const inputs = publishInput(source, destination);
    const options = { invocation_id: 'replay-invocation' };
    const handle = original.invoke(grant, REPORT_PUBLISH.id, inputs, options);
    if (handle.kind !== 'handle') throw new Error('expected handle');
    original.release('replay-action');
    const outcome = await handle.result;
    assert.equal(outcome.outcome, 'succeeded');
    const snapshot = original.snapshot();
    const dir = mkdtempSync(join(tmpdir(), 'weave-publication-replay-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.restore({ ...snapshot, invocations: snapshot.invocations.map((record) => ({
      ...record, status, outcome: status === 'running' ? null : status === 'stopped'
        ? { outcome: 'failed', failure: 'legacy interrupted acknowledgement' }
        : { outcome: 'uncertain', reason: 'interrupted acknowledgement' },
    })) }, path);
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const mark = store.persistInvocationUncertain.bind(store);
    // Keep the durable orphan start intact to exercise prepare's running path.
    if (status === 'running') store.persistInvocationUncertain = () => { throw new Error('marker append refused'); };
    const host = new AgentFabricHost({ authority, store });
    store.persistInvocationUncertain = mark;
    let runs = 0;
    host.installAdmitted(REPORT_PUBLISH, () => { runs += 1; return outcome; });
    assert.equal(store.getInvocation(options.invocation_id)?.status, status);
    assert.equal(host.coordinator.held().length, status === 'stopped' ? 0 : 2);
    return { authority, host, store, path, grant, inputs, options, outcome, runs: () => runs };
  }

  for (const status of ['stopped', 'uncertain', 'running'] as const) {
    it(`re-invokes a ${status} publication from its durable receipt without a new grant or run`, async (t) => {
      const f = await publicationReplayFixture(t, status);
      const cost = f.host.measuredCostMicros();
      const replay = f.host.invoke(f.grant, REPORT_PUBLISH.id, f.inputs, f.options);
      assert.equal(replay.kind, 'handle');
      if (replay.kind !== 'handle') throw new Error('expected replay handle');
      assert.deepEqual(await replay.result, f.outcome);
      assert.deepEqual(f.host.releaseAll(), []);
      assert.equal(f.runs(), 0);
      assert.deepEqual(f.host.invocations, []);
      assert.equal(f.host.measuredCostMicros(), cost);
      assert.deepEqual(f.host.coordinator.held(), []);
      assert.equal(f.store.getInvocation(f.options.invocation_id)?.status, 'committed');
      assert.deepEqual(f.host.lookup(f.options.invocation_id, f.grant), { status: 'committed', outcome: f.outcome });
      f.store.close();
      const reopened = FabricStore.open(f.path);
      try {
        assert.equal(reopened.getInvocation(f.options.invocation_id)?.status, 'committed');
        const recovered = new AgentFabricHost({ authority: f.authority, store: reopened });
        assert.deepEqual(recovered.coordinator.held(), []);
        assert.deepEqual(recovered.lookup(f.options.invocation_id, f.grant), { status: 'committed', outcome: f.outcome });
      } finally { reopened.close(); }
    });
  }

  for (const status of ['uncertain', 'running'] as const) {
    it(`retains the ${status} publication hold if re-invocation cannot persist reconciliation`, async (t) => {
      const f = await publicationReplayFixture(t, status);
      const persist = f.store.persistInvocationReconciliation.bind(f.store);
      f.store.persistInvocationReconciliation = () => { throw new Error('reconciliation append refused'); };
      const before = readFileSync(f.path);
      const replay = f.host.invoke(f.grant, REPORT_PUBLISH.id, f.inputs, f.options);
      assert.equal(replay.kind, 'handle');
      if (replay.kind !== 'handle') throw new Error('expected replay handle');
      const outcome = { outcome: 'uncertain', reason: 'failed to persist publication reconciliation' };
      assert.deepEqual(await replay.result, outcome);
      assert.deepEqual(f.host.lookup(f.options.invocation_id, f.grant), { status: 'unresolved', reason: outcome.reason });
      assert.deepEqual(readFileSync(f.path), before);
      assert.equal(f.host.coordinator.held().length, 2);
      assert.equal(f.runs(), 0);
      f.store.persistInvocationReconciliation = persist;
      const retry = f.host.invoke(f.grant, REPORT_PUBLISH.id, f.inputs, f.options);
      if (retry.kind !== 'handle') throw new Error('expected replay handle');
      assert.deepEqual(await retry.result, f.outcome);
      assert.deepEqual(f.host.coordinator.held(), []);
    });
  }

  for (const stale of ['destination', 'source'] as const) {
    it(`recognizes a same-invocation publication before checking the ${stale} revision`, async () => {
      const authority = createGrantAuthority();
      const host = new AgentFabricHost({ authority, faults: { publishGate: 'before_commit' } });
      const source = host.registerSource('mem:commit-receipt', 'line');
      const destination = host.registerDestination('mem:commit-receipt-outbox');
      const grant = publishGrant(authority, source, destination, 'commit-action', 1);
      const handle = host.invoke(grant, REPORT_PUBLISH.id, publishInput(source, destination),
        { invocation_id: 'commit-invocation' });
      if (handle.kind !== 'handle') throw new Error('expected handle');
      host.release('commit-action');
      const dest = host.store.getResource(host.store.lookupRef(destination)!.canonical_id)!;
      const receipt = { invocation_id: handle.invocation_id,
        binding_digest: host.store.getInvocation(handle.invocation_id)!.binding_digest,
        report_digest: 'already-committed', destination, committed_revision: 2 };
      host.store.putResource({ ...dest, revision: 2, content: receipt.report_digest, publication: receipt });
      if (stale === 'source') {
        const resource = host.store.getResource(host.store.lookupRef(source)!.canonical_id)!;
        host.store.putResource({ ...resource, revision: 2 });
      }
      const resources = host.snapshot().resources;
      host.proceed('commit-action');
      assert.deepEqual(await handle.result, { outcome: 'succeeded', output: {
        invocation_id: handle.invocation_id, report_digest: receipt.report_digest, destination, committed_revision: 2,
      } });
      assert.deepEqual(host.snapshot().resources, resources);
      assert.deepEqual(host.coordinator.held(), []);
    });
  }

  it('settles a publication after a result validation error and retains reservations for reconciliation', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const source = host.registerSource('mem:unpersisted', 'line');
    const destination = host.registerDestination('mem:unpersisted-outbox');
    const handle = host.invoke(publishGrant(authority, source, destination, 'unpersisted-action', 1), REPORT_PUBLISH.id,
      publishInput(source, destination), { invocation_id: 'unpersisted-invocation' });
    assert.equal(handle.kind, 'handle');
    if (handle.kind !== 'handle') throw new Error('expected invocation handle');
    const persistResult = host.store.persistInvocationResult;
    host.store.persistInvocationResult = () => { throw new TypeError('injected result validation error'); };
    try {
      host.release('unpersisted-action');
      assert.deepEqual(await handle.result, { outcome: 'uncertain', reason: 'failed to persist invocation result after commit' });
      assert.equal(host.openCount(), 0);
      assert.equal(host.coordinator.held().length, 2);
    } finally { host.store.persistInvocationResult = persistResult; }
    const reconciled = host.lookup('unpersisted-invocation',
      publishGrant(authority, source, destination, 'unpersisted-action', 2));
    assert.equal('status' in reconciled && reconciled.status, 'committed');
    assert.deepEqual(host.coordinator.held(), []);
  });

  it('does not leave a stale publication owner when the prior result was unpersisted', async () => {
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({ authority });
    const source = host.registerSource('mem:index-replaced', 'line');
    const destination = host.registerDestination('mem:index-replaced-outbox');

    host.store.persistResult = false;
    const firstGrant = publishGrant(authority, source, destination, 'a:replaced:1', 1);
    const first = host.invoke(firstGrant, REPORT_PUBLISH.id, publishInput(source, destination), {
      invocation_id: 'inv-replaced-a',
    });
    assert.equal(first.kind, 'handle');
    host.release('a:replaced:1');
    const firstOutcome = await (first as { result: Promise<{ outcome: string }> }).result;
    assert.equal(firstOutcome.outcome, 'uncertain');

    const restarted = new AgentFabricHost({ authority, store: FabricStore.restore(host.snapshot()) });
    assert.equal(restarted.coordinator.held().length, 2);
    const firstReconciled = restarted.lookup('inv-replaced-a', firstGrant);
    assert.equal('status' in firstReconciled && firstReconciled.status, 'committed');
    assert.deepEqual(restarted.coordinator.held(), []);
    const secondGrant = publishGrant(authority, source, destination, 'a:replaced:2', 2);
    const second = restarted.invoke(
      secondGrant,
      REPORT_PUBLISH.id,
      { ...publishInput(source, destination), expected_revision: 2 },
      { invocation_id: 'inv-replaced-b' },
    );
    assert.equal(second.kind, 'handle');
    restarted.release('a:replaced:2');
    const secondOutcome = await (second as { result: Promise<{ outcome: string }> }).result;
    assert.equal(secondOutcome.outcome, 'succeeded');

    assert.equal(restarted.store.publishedBy('inv-replaced-a'), undefined);
    assert.equal(restarted.store.publishedBy('inv-replaced-b')?.publication?.invocation_id, 'inv-replaced-b');

    const lookupGrant = publishGrant(authority, source, destination, 'a:replaced:1', 3);
    const recovered = restarted.lookup('inv-replaced-a', lookupGrant);
    assert.equal('status' in recovered && recovered.status, 'committed');

    const restored = FabricStore.restore(restarted.snapshot());
    assert.equal(restored.publishedBy('inv-replaced-a'), undefined);
    assert.equal(restored.publishedBy('inv-replaced-b')?.publication?.invocation_id, 'inv-replaced-b');
  });

  it('coalesces registration writes and folds invocation cost into the start write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-coalesce-'));
    const path = join(dir, 'fabric.json');
    const store = FabricStore.open(path);
    try {
      const authority = createGrantAuthority();
      const host = new AgentFabricHost({ authority, store });
      let saves = 0;
      const save = store.save.bind(store);
      store.save = () => {
        saves += 1;
        save();
      };

      const source = host.registerSource('mem:coalesce-alpha', 'line');
      assert.equal(saves, 1);
      const destination = host.registerDestination('mem:coalesce-outbox');
      assert.equal(saves, 2);

      saves = 0;
      const grant = publishGrant(authority, source, destination, 'a:coalesce:1', 1);
      const handle = host.invoke(grant, REPORT_PUBLISH.id, publishInput(source, destination), {
        invocation_id: 'inv-coalesce',
      });
      assert.equal(handle.kind, 'handle');
      assert.equal(saves, 1);
      const cost = host.measuredCostMicros();
      assert.ok(cost > 0);
      assert.equal(store.getInvocation('inv-coalesce')?.measured_cost_micros, cost);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps invocation cost once across a restart before the result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-coalesce-restart-'));
    const path = join(dir, 'fabric.json');
    const first = FabricStore.open(path);
    let cost = 0;
    let source = '';
    let destination = '';
    try {
      const authority = createGrantAuthority();
      const host = new AgentFabricHost({ authority, store: first });
      source = host.registerSource('mem:coalesce-restart-alpha', 'line');
      destination = host.registerDestination('mem:coalesce-restart-outbox');
      const grant = publishGrant(authority, source, destination, 'a:coalesce:2', 1);
      const handle = host.invoke(grant, REPORT_PUBLISH.id, publishInput(source, destination), {
        invocation_id: 'inv-coalesce-restart',
      });
      assert.equal(handle.kind, 'handle');
      cost = host.measuredCostMicros();
      assert.ok(cost > 0);
    } finally {
      first.close();
    }

    const restarted = FabricStore.open(path);
    try {
      assert.equal(restarted.measuredCostMicros(), cost);
      assert.equal(restarted.getInvocation('inv-coalesce-restart')?.measured_cost_micros, cost);
      const authority = createGrantAuthority();
      const host = new AgentFabricHost({ authority, store: restarted });
      const grant = publishGrant(authority, source, destination, 'a:coalesce:3', 2);
      const retried = host.invoke(grant, REPORT_PUBLISH.id, publishInput(source, destination), {
        invocation_id: 'inv-coalesce-restart',
      });
      assert.equal(retried.kind, 'handle');
      assert.equal(host.measuredCostMicros(), cost);
    } finally {
      restarted.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps builtin results deduplicated and unchanged in snapshots', () => {
    const store = FabricStore.restore({
      next_handle: 1,
      next_canonical: 1,
      resources: [],
      refs: [],
      invocations: [],
      builtin_results: [
        {
          key: 'inspect:key',
          operation: SOURCE_INSPECT.id,
          implementation_id: 'first',
          outcome: { outcome: 'succeeded', output: { revision: 1 } },
        },
      ],
    });
    assert.deepEqual(store.cachedResult('inspect:key')?.outcome, { outcome: 'succeeded', output: { revision: 1 } });
    store.rememberResult({
      key: 'inspect:key',
      operation: SOURCE_INSPECT.id,
      implementation_id: 'second',
      outcome: { outcome: 'succeeded', output: { revision: 2 } },
    });
    const restored = store.snapshot();
    assert.equal(restored.builtin_results?.length, 1);
    assert.equal(restored.builtin_results?.[0]?.implementation_id, 'second');
    assert.deepEqual(store.cachedResult('inspect:key')?.outcome, { outcome: 'succeeded', output: { revision: 2 } });
    assert.equal(store.cachedResult('missing'), undefined);
  });
});
