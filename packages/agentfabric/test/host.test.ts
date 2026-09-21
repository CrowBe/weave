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
