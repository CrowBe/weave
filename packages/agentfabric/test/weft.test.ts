/**
 * W5 (#187): the Fabric host's Weft emission (packages/weft/src/WEFT-CONTRACT.md,
 * Emission): selection, invocation, rejection, admission and revocation. The
 * host behaves the same with or without a sink.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority, type Grant } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, SOURCE_INSPECT, type WeftRecordShape } from '@weave/agentfabric';

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

async function scenario(emit?: (record: WeftRecordShape) => unknown) {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({ authority, ...(emit ? { weft: { trace_id: 'run-1', emitter_id: 'fab', emit } } : {}) });
  const source = host.registerSource('mem:w5', 'one\ntwo');
  host.installAdmitted(SOURCE_INSPECT, () => ({ outcome: 'succeeded', output: { line_count: 2 } }), 'impl.secret-free');
  const handle = host.invoke(inspectGrant(authority, source, 'a:1:1'), SOURCE_INSPECT.id, { source }, { invocation_id: 'a:1:1' });
  assert.equal(handle.kind, 'handle');
  if (handle.kind !== 'handle') throw new Error('expected a handle');
  host.release('a:1:1');
  const outcome = await handle.result;
  // A forged grant is rejected; so is a second presentation of the consumed one.
  const forged = host.invoke({ ...inspectGrant(createGrantAuthority(), source, 'a:1:2') }, SOURCE_INSPECT.id, { source });
  host.revoke(SOURCE_INSPECT.id, 'withdrawn for sk-fabriccanary0123456789');
  return { host, outcome, forged };
}

describe('W5 Fabric emission', () => {
  it('W5-T55 admission, selection, invocation, rejection and revocation are reported with ids and codes only', async () => {
    const records: WeftRecordShape[] = [];
    await scenario((r) => void records.push(r));
    assert.deepEqual(
      records.map((r) => [r.kind, r.fields['event'] ?? r.fields['status'] ?? r.fields['code']]),
      [
        ['capability.lifecycle', 'admitted'],
        ['capability.lifecycle', 'selected'],
        ['capability.invoked', 'succeeded'],
        ['error', 'denied'],
        ['capability.lifecycle', 'revoked'],
      ],
    );
    assert.deepEqual(records[0]!.fields, {
      operation: SOURCE_INSPECT.id,
      implementation: 'impl.secret-free',
      event: 'admitted',
      contract_rev: SOURCE_INSPECT.revision,
    });
    assert.equal(records[2]!.parent_id, records[1]!.record_id);
    assert.deepEqual(records[2]!.evidence, [{ source: 'invocation', ref: 'a:1:1' }]);
    assert.deepEqual(records[4]!.fields, { operation: SOURCE_INSPECT.id, implementation: 'impl.secret-free', event: 'revoked' });
    assert.deepEqual(records.map((r) => r.sequence), [1, 2, 3, 4, 5]);
    assert.equal(JSON.stringify(records).includes('canary'), false);
    assert.equal(JSON.stringify(records).includes('one\\ntwo'), false);
  });

  it('W5-T56 the host behaves the same with no sink, a throwing sink and a rejecting sink', async () => {
    const shape = async (emit?: (record: WeftRecordShape) => unknown) => {
      const { host, outcome, forged } = await scenario(emit);
      return JSON.stringify({ outcome, forged, rejections: host.rejections, invocations: host.invocations, store: host.snapshot(), resolution: host.resolution(SOURCE_INSPECT.id) });
    };
    const plain = await shape();
    assert.equal(await shape(() => { throw new Error('sink down'); }), plain);
    assert.equal(await shape(() => Promise.reject(new Error('sink rejected'))), plain);
  });

  it('W5-T57 a restored host does not report restored admissions again', () => {
    const authority = createGrantAuthority();
    const store = new FabricStore();
    const first = new AgentFabricHost({ authority, store });
    first.noteAdmission(SOURCE_INSPECT, 'impl.stored', 'export default (inputs) => ({ outcome: "succeeded", output: inputs });');
    const records: WeftRecordShape[] = [];
    const restored = new AgentFabricHost({
      authority,
      store: FabricStore.restore(first.snapshot()),
      weft: { trace_id: 'run-1', emitter_id: 'fab.2', emit: (r) => void records.push(r) },
    });
    assert.equal(restored.implementationAdmitted(SOURCE_INSPECT.id, 'impl.stored'), true);
    assert.deepEqual(records, []);
  });
  it('W5-T58 a sink that invokes the host from inside an invocation is served after the invocation step', async () => {
    const run = async (reenter: boolean) => {
      const authority = createGrantAuthority();
      let host!: AgentFabricHost;
      let source = '';
      let grant!: Grant;
      let nested: unknown = null;
      let armed = false;
      host = new AgentFabricHost({
        authority,
        weft: {
          trace_id: 'run-1',
          emitter_id: 'fab',
          emit: (record) => {
            if (!armed || record.fields['event'] !== 'selected') return;
            armed = false;
            // The same grant presented again from inside the sink.
            nested = host.invoke(grant, SOURCE_INSPECT.id, { source }, { invocation_id: 'a:1:1' });
          },
        },
      });
      source = host.registerSource('mem:w5', 'one\ntwo');
      host.installAdmitted(SOURCE_INSPECT, () => ({ outcome: 'succeeded', output: { line_count: 2 } }), 'impl.one');
      grant = inspectGrant(authority, source, 'a:1:1');
      armed = reenter;
      const handle = host.invoke(grant, SOURCE_INSPECT.id, { source }, { invocation_id: 'a:1:1' });
      if (!reenter) nested = host.invoke(grant, SOURCE_INSPECT.id, { source }, { invocation_id: 'a:1:1' });
      assert.equal(handle.kind, 'handle');
      if (handle.kind !== 'handle') throw new Error('expected a handle');
      host.release('a:1:1');
      const outcome = await handle.result;
      return JSON.stringify({
        nested,
        outcome,
        rejections: host.rejections,
        invocations: host.invocations,
        store: host.snapshot(),
        open: host.openInvocationIds(),
        // A consumed grant cannot be marked invoked again.
        reusable: authority.markInvoked(grant),
      });
    };
    const after = await run(false);
    assert.match(after, /invocation is already active/);
    assert.equal(await run(true), after);
  });

  it('W5-T59 a sink that invokes the host while an invocation settles is served after it settles', async () => {
    const run = async (reenter: boolean) => {
      const authority = createGrantAuthority();
      let host!: AgentFabricHost;
      let source = '';
      let nested: unknown = null;
      let armed = reenter;
      const again = (): void => {
        const grant = inspectGrant(authority, source, 'a:1:2');
        nested = host.invoke(grant, SOURCE_INSPECT.id, { source }, { invocation_id: 'a:1:2' });
        // After the first settles its result is cached: the second may complete without a release.
        if (host.openActionIds().includes('a:1:2')) host.release('a:1:2');
      };
      host = new AgentFabricHost({
        authority,
        weft: {
          trace_id: 'run-1',
          emitter_id: 'fab',
          emit: (record) => {
            if (!armed || record.kind !== 'capability.invoked') return;
            armed = false;
            again();
          },
        },
      });
      source = host.registerSource('mem:w5', 'one\ntwo');
      host.installAdmitted(SOURCE_INSPECT, () => ({ outcome: 'succeeded', output: { line_count: 2 } }), 'impl.one');
      const handle = host.invoke(inspectGrant(authority, source, 'a:1:1'), SOURCE_INSPECT.id, { source }, { invocation_id: 'a:1:1' });
      if (handle.kind !== 'handle') throw new Error('expected a handle');
      host.release('a:1:1');
      const outcome = await handle.result;
      if (!reenter) again();
      const second = nested as { kind: string; result?: Promise<unknown> } | null;
      const secondOutcome = second?.kind === 'handle' ? await second.result : null;
      return JSON.stringify({
        outcome,
        secondOutcome,
        rejections: host.rejections,
        invocations: host.invocations,
        store: host.snapshot(),
        open: host.openInvocationIds(),
      });
    };
    assert.equal(await run(true), await run(false));
  });
});
