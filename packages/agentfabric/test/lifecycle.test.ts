/**
 * Lifecycle checks that belong to AgentFabric: corpus rules, isolation,
 * demonstrated red, held-out spending, and admission without a grant.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority, validateTestCases, type CapabilityContract, type TestCase } from '@weave/agentsop';
import { AgentFabricHost, FabricLifecycle } from '@weave/agentfabric';

const CONTRACT: CapabilityContract = {
  id: 'report.fold',
  revision: 'r1',
  purpose: 'Fold inspection digests into one canonical digest',
  input: { inspections: '[InspectionResult]' },
  output: { fold: 'string' },
  effects: [],
  permissions: [],
  failures: ['empty_input', 'invalid_inspection'],
  depends_on: [],
};

const DESIRED = {
  operation: CONTRACT.id,
  purpose: CONTRACT.purpose,
  input: CONTRACT.input,
  output: CONTRACT.output,
};

const SOURCE = `
if (!Array.isArray(input.inspections) || input.inspections.length === 0) {
  return { failure: "empty_input" };
}
var lines = [];
for (var index = 0; index < input.inspections.length; index = index + 1) {
  var row = input.inspections[index];
  if (row === null || typeof row !== "object" || typeof row.source !== "string" || typeof row.digest !== "string" || row.digest.length === 0) {
    return { failure: "invalid_inspection" };
  }
  lines.push(row.source + "=" + row.digest);
}
lines.sort();
var folded = "fold";
for (var cursor = 0; cursor < lines.length; cursor = cursor + 1) {
  folded = folded + "|" + lines[cursor];
}
return { fold: folded };
`;

function cases(): { visible: TestCase[]; heldOut: TestCase[] } {
  const visible: TestCase[] = [
    {
      id: 'vis-pair',
      split: 'visible',
      input: { inspections: [{ source: 'source:beta', digest: 'b' }, { source: 'source:alpha', digest: 'a' }] },
      expected: { kind: 'output', output: { fold: 'fold|source:alpha=a|source:beta=b' } },
    },
    {
      id: 'vis-empty',
      split: 'visible',
      input: { inspections: [] },
      expected: { kind: 'failure', code: 'empty_input' },
    },
  ];
  const heldOut: TestCase[] = [
    {
      id: 'hold-one',
      split: 'held_out',
      input: { inspections: [{ source: 'source:held', digest: 'held-digest-unique' }] },
      expected: { kind: 'output', output: { fold: 'fold|source:held=held-digest-unique' } },
    },
    {
      id: 'hold-bad',
      split: 'held_out',
      input: { inspections: [{ source: 'source:held', digest: '' }] },
      expected: { kind: 'failure', code: 'invalid_inspection' },
    },
  ];
  return { visible, heldOut };
}

function established(mode: 'enforcing' | 'unsupported' = 'enforcing'): FabricLifecycle {
  const life = new FabricLifecycle(new AgentFabricHost({ authority: createGrantAuthority() }), mode);
  const { visible, heldOut } = cases();
  assert.equal(life.search(DESIRED, 'retained text').ok, true);
  assert.equal(life.proposeContract(CONTRACT).ok, true);
  assert.equal(life.submitCases('visible', visible).ok, true);
  assert.equal(life.submitCases('held_out', heldOut).ok, true);
  assert.equal(life.validateCorpus().ok, true);
  return life;
}

function outputOf(step: { ok: boolean; output?: Record<string, unknown> }): Record<string, unknown> {
  assert.equal(step.ok, true);
  return step.output ?? {};
}

describe('AgentFabric crystallization lifecycle', () => {
  it('rejects contradictory cases and dropped or rewritten held-out cases', () => {
    const { visible, heldOut } = cases();
    const first = visible[0] as TestCase;
    const checked = validateTestCases(
      [first, { ...first, id: 'vis-other', expected: { kind: 'output', output: { fold: 'fold|nope' } } }],
      CONTRACT,
    );
    assert.equal(checked.ok, false);
    const life = established('unsupported');
    const dropped = life.reviseCases('held_out', heldOut.slice(1));
    assert.equal(dropped.ok, false);
    assert.match((dropped as { reason: string }).reason, /cannot be dropped/);
    const head = heldOut[0] as TestCase;
    const rewritten = life.reviseCases('held_out', [
      { ...head, expected: { kind: 'output', output: { fold: 'fold|changed' } } },
      ...(heldOut.slice(1) as TestCase[]),
    ]);
    assert.equal(rewritten.ok, false);
    assert.match((rewritten as { reason: string }).reason, /cannot be rewritten/);
  });

  it('proves isolation before generated code and keeps held-out expectations out of the child', async () => {
    const previous = process.env['WEAVE_ISOLATION_CANARY'];
    process.env['WEAVE_ISOLATION_CANARY'] = 'do-not-leak';
    try {
      const life = established();
      const red = await life.demonstrateRed();
      assert.equal(red.ok, true);
      const isolation = outputOf(red)['isolation'] as { supported: boolean; filesystem: string; child_process: string; credentials: string; held_out_mounted: boolean };
      assert.equal(isolation.supported, true);
      assert.equal(isolation.filesystem, 'blocked');
      assert.equal(isolation.child_process, 'blocked');
      assert.equal(isolation.credentials, 'absent');
      assert.equal(isolation.held_out_mounted, false);
      assert.deepEqual(life.runner.dispatchedCaseKeys, ['id', 'input']);
      const view = life.implementerView();
      assert.ok(view);
      assert.equal(JSON.stringify(view).includes('held-digest-unique'), false);
      const attached = life.attachImplementation('direct', SOURCE);
      assert.equal(attached.ok, true);
      const green = await life.proveGreen('direct');
      assert.equal(green.ok, true);
      assert.equal(outputOf(green)['proven'], true);
      const heldOut = outputOf(green)['held_out'] as object;
      assert.equal('cases' in heldOut, false);
      assert.equal(life.audit().held_out_executed, 2);
      const late = life.attachImplementation('late', SOURCE);
      assert.equal(late.ok, false);
      assert.match((late as { reason: string }).reason, /spent/);
    } finally {
      if (previous === undefined) {
        delete process.env['WEAVE_ISOLATION_CANARY'];
      } else {
        process.env['WEAVE_ISOLATION_CANARY'] = previous;
      }
    }
  });

  it('refuses generated runs when isolation is unsupported', async () => {
    const life = established('unsupported');
    const red = await life.demonstrateRed();
    assert.equal(red.ok, false);
    assert.equal(life.audit().execute_runs, 0);
    assert.equal(life.audit().probe_runs, 0);
  });

  it('admission does not issue an execution grant', async () => {
    const host = new AgentFabricHost({ authority: createGrantAuthority() });
    const life = new FabricLifecycle(host);
    const { visible, heldOut } = cases();
    life.search(DESIRED, null);
    life.proposeContract(CONTRACT);
    life.submitCases('visible', visible);
    life.submitCases('held_out', heldOut);
    life.validateCorpus();
    assert.equal((await life.demonstrateRed()).ok, true);
    life.attachImplementation('direct', SOURCE);
    assert.equal((await life.proveGreen('direct')).ok, true);
    const requested = life.requestAdmission('direct');
    assert.equal(requested.ok, true);
    const output = outputOf(requested) as { request_id: string; evidence_digest: string };
    const admitted = life.admit({
      request_id: output.request_id,
      implementation_id: 'direct',
      evidence_digest: output.evidence_digest,
      approver: 'operator',
      authority_revision: 1,
    });
    assert.equal(admitted.ok, true);
    assert.equal('grant' in (admitted as { output: object }).output, false);
    assert.equal(host.resolution('report.fold'), 'resolved');
    const denied = host.invoke(null, 'report.fold', { inspections: [{ source: 'source:alpha', digest: 'a' }] });
    assert.equal(denied.kind, 'rejected');
    assert.equal(host.invocations.length, 0);
  });

  it('a semantic change at the same revision is rejected and invalidates green evidence', async () => {
    const life = established();
    const same = life.reviseContract({ ...CONTRACT, purpose: 'changed purpose' });
    assert.equal(same.ok, false);
    assert.equal((await life.demonstrateRed()).ok, true);
    life.attachImplementation('direct', SOURCE);
    assert.equal((await life.proveGreen('direct')).ok, true);
    const requested = life.requestAdmission('direct');
    assert.equal(requested.ok, true);
    const revised = life.reviseContract({ ...CONTRACT, revision: 'r2', purpose: 'changed purpose' });
    assert.equal(revised.ok, true);
    const output = outputOf(requested) as { request_id: string; evidence_digest: string };
    const admitted = life.admit({
      request_id: output.request_id,
      implementation_id: 'direct',
      evidence_digest: output.evidence_digest,
      approver: 'operator',
      authority_revision: 1,
    });
    assert.equal(admitted.ok, false);
    assert.match((admitted as { reason: string }).reason, /invalidated|not pending/);
  });
});
