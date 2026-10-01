import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost } from '@weave/agentfabric';
import { openReadPort, type ProjectRecord } from '@weave/loom-binding';
import { MemoryJournal, Runtime, ScriptedDecisionLayer, type Candidate, type CycleRecord } from '@weave/weave';

const SOURCE_TEXT = 'alpha one\nalpha two\nalpha three';
const LOCATOR = 'mem:alpha';
const DEST_LOCATOR = 'mem:outbox';

const project: ProjectRecord = {
  project_id: 'project-field',
  name: 'Field notes',
  attachments: [
    { label: 'Field repository', kind: 'repository' },
    { label: 'Brief', kind: 'document' },
  ],
};

function keysOf(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, found);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.add(key);
      keysOf(inner, found);
    }
  }
}

async function pendingPublish() {
  const authority = createGrantAuthority();
  const host = new AgentFabricHost({ authority });
  const runtime = new Runtime({
    host,
    decisionLayer: new ScriptedDecisionLayer(),
    grantAuthority: authority,
    journal: new MemoryJournal(),
  });
  const alpha = host.registerSource(LOCATOR, SOURCE_TEXT);
  const beta = host.registerSource('mem:beta', 'beta one\nbeta two');
  const dest = host.registerDestination(DEST_LOCATOR);
  runtime.observe({
    observation_id: 'test:source.registered:alpha',
    source: { kind: 'test', id: 'binding' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource: alpha, revision: 1, content: SOURCE_TEXT },
  });
  runtime.observe({
    observation_id: 'test:source.registered:beta',
    source: { kind: 'test', id: 'binding' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource: beta, revision: 1, content: 'beta one\nbeta two' },
  });
  runtime.observe({
    observation_id: 'test:source.registered:dest',
    source: { kind: 'test', id: 'binding' },
    caused_by: null,
    payload_type: 'source.registered',
    payload_version: 1,
    payload: { resource: dest, revision: 1, content: '' },
  });
  runtime.operator.submit({
    observation_id: 'operator:goal.opened:g-report',
    caused_by: null,
    payload_type: 'goal.opened',
    payload_version: 1,
    payload: {
      goal_id: 'g-report',
      purpose: 'Produce and publish a checked report over the listed sources',
      sources: [alpha, beta],
      destination: dest,
      authority: { read: [alpha, beta] },
      budget: { actions: 8, judgments: 8, recovery: 4 },
      success_evidence: 'a publication receipt for the current report at the authorized destination',
    },
  });

  const release = async (cycle: CycleRecord, candidate: Candidate) => {
    const selected = cycle.selected.find((item) => item.candidate_id === candidate.candidate_id);
    assert.ok(selected);
    host.release(selected.action_id);
    await runtime.settle(selected.action_id);
  };

  const first = runtime.trace().cycles[0];
  assert.ok(first);
  const inspections = first.candidates.filter((candidate) => candidate.operation === 'source.inspect');
  assert.equal(inspections.length, 2);
  for (const candidate of inspections) {
    await release(first, candidate);
  }
  const assembled = runtime.trace().cycles.at(-1);
  assert.ok(assembled);
  const assemble = assembled.candidates.find((candidate) => candidate.operation === 'report.assemble');
  assert.ok(assemble);
  await release(assembled, assemble);
  return { runtime, host };
}

describe('Loom read port', () => {
  it('discloses a recorded observation and a pending approval without locators or runtime state', async () => {
    const { runtime } = await pendingPublish();
    const before = runtime.trace().observations.length;
    const pending = Object.values(runtime.state().approvals).filter((record) => record.status === 'pending');
    assert.equal(pending.length, 1);
    const port = openReadPort({ read: runtime, project });
    const view = port.workspaceView();
    assert.equal(runtime.trace().observations.length, before);
    assert.equal(runtime.state().approvals[pending[0]!.request_id]?.status, 'pending');

    assert.equal(view.id, 'view.workspace@1');
    assert.equal(view.project_name.status, 'disclosed');
    if (view.project_name.status === 'disclosed') {
      assert.equal(view.project_name.name, 'Field notes');
    }
    assert.equal(view.availability.status, 'disclosed');
    if (view.availability.status === 'disclosed') {
      assert.deepEqual(
        view.availability.items.map((item) => item.label),
        ['Field repository', 'Brief'],
      );
    }
    assert.equal(view.observations.status, 'disclosed');
    if (view.observations.status === 'disclosed') {
      const opened = view.observations.items.find((item) => item.type === 'goal.opened');
      assert.ok(opened);
      assert.equal(opened.provenance, 'operator');
      assert.deepEqual(opened.validation, { status: 'accepted' });
      const registered = view.observations.items.find((item) => item.type === 'source.registered');
      assert.ok(registered);
      assert.equal(registered.provenance, 'untrusted');
    }
    assert.equal(view.approvals.status, 'disclosed');
    if (view.approvals.status === 'disclosed') {
      assert.equal(view.approvals.items.length, 1);
      assert.equal(view.approvals.items[0]?.operation, 'report.publish');
      assert.match(view.approvals.items[0]?.destination ?? '', /^ref_\d+$/);
    }

    const encoded = JSON.stringify(view);
    assert.equal(encoded.includes(SOURCE_TEXT), false);
    assert.equal(encoded.includes(LOCATOR), false);
    assert.equal(encoded.includes(DEST_LOCATOR), false);
    assert.equal(encoded.includes('://'), false);
    assert.equal(encoded.includes('Produce and publish'), false);
    const found = new Set<string>();
    keysOf(view, found);
    for (const key of ['payload', 'content', 'locator', 'grant', 'sources', 'purpose', 'inputs']) {
      assert.equal(found.has(key), false, key);
    }
  });

  it('omits a slice without turning it into an empty list, and refuses a locator label', async () => {
    const { runtime } = await pendingPublish();
    const view = openReadPort({
      read: runtime,
      project,
      disclosure: { observations: { reason: 'policy' } },
    }).workspaceView();
    assert.deepEqual(view.observations, { status: 'omitted', reason: 'policy' });
    assert.equal(view.approvals.status, 'disclosed');

    assert.throws(
      () =>
        openReadPort({
          read: runtime,
          project: { ...project, attachments: [{ label: 'mem:alpha', kind: 'repository' }] },
        }).workspaceView(),
      /locator/,
    );
  });

  it('does not change when read twice at the same revision', async () => {
    const { runtime } = await pendingPublish();
    const port = openReadPort({ read: runtime, project });
    assert.deepEqual(port.workspaceView(), port.workspaceView());
  });
});
