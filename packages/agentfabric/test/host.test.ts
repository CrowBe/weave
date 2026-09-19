/**
 * AgentFabric host checks independent of Weave scheduling (M1-T04, T15, aliases,
 * failure precedence, catalogue rules).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority, type Grant, validateCatalogue } from '@weave/agentsop';
import { AgentFabricHost, REPORT_PUBLISH, SOURCE_INSPECT } from '@weave/agentfabric';

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

describe('AgentFabric host authority', () => {
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
});
