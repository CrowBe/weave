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

  it('reads only the observation window and indexed approval sequences, never the full trace', async () => {
    const { runtime } = await pendingPublish();
    for (let i = 0; i < 30; i++) {
      runtime.observe({
        observation_id: `unknown:${i}`,
        source: { kind: 'test', id: 'binding' },
        caused_by: null,
        payload_type: 'unknown',
        payload_version: 1,
        payload: {},
      });
    }
    const trace = runtime.trace();
    const record = Object.values(runtime.state().approvals).find((item) => item.status === 'pending')!;
    const request = record.request;
    // Independent expected disclosure from the former full-trace projection.
    const expected = {
      id: 'view.workspace@1',
      revision: runtime.state().state_revision,
      project_name: { status: 'disclosed', name: project.name },
      availability: { status: 'disclosed', items: project.attachments, truncated: false },
      observations: {
        status: 'disclosed',
        truncated: true,
        items: trace.observations.slice(-24).map((observation) => ({
          sequence: observation.seq,
          type: 'unknown',
          provenance: 'untrusted',
          validation: { status: 'unknown' },
          cause: null,
        })),
      },
      approvals: {
        status: 'disclosed',
        truncated: false,
        items: [
          {
            request_id: request.request_id,
            sequence: trace.observations.find(
              (observation) =>
                observation.payload_type === 'approval.requested' &&
                (observation.payload as { request_id: string }).request_id === request.request_id,
            )!.seq,
            operation: request.operation,
            contract_revision: request.contract_rev,
            destination: request.destination,
            effects: request.effects,
            expected_revision: request.expected_revision,
            reservation: request.budget,
            valid_from_tick: request.valid_from_tick,
            valid_until_tick: request.valid_until_tick,
            binding_digest: request.binding_digest,
            report_digest: request.report_digest,
          },
        ],
      },
    };
    assert.deepEqual(openReadPort({ read: runtime, project }).workspaceView(), expected);
    let windows = 0;
    let lookups = 0;
    const read = {
      state: () => runtime.state(),
      trace() {
        assert.fail('workspaceView must not clone the full trace');
      },
      recentObservations(limit: number) {
        assert.equal(limit, 24);
        windows++;
        return { observations: trace.observations.slice(-limit), total: trace.observations.length };
      },
      approvalRequestSeq(request_id: string) {
        lookups++;
        return trace.observations.find(
          (observation) =>
            observation.payload_type === 'approval.requested' &&
            (observation.payload as { request_id: string }).request_id === request_id,
        )?.seq;
      },
    };
    assert.deepEqual(openReadPort({ read, project }).workspaceView(), expected);
    assert.equal(windows, 1);
    assert.equal(lookups, 1);
  });

  it('keeps omitted reads undisclosed and returned views defensive while arrivals interleave', async () => {
    const { runtime } = await pendingPublish();
    const read = {
      state: () => runtime.state(),
      recentObservations() {
        assert.fail('omitted observations must not be read');
      },
      approvalRequestSeq() {
        assert.fail('omitted approvals must not be read');
      },
    };
    const omitted = openReadPort({
      read,
      project,
      disclosure: {
        observations: { reason: 'policy' },
        approvals: { reason: 'policy' },
      },
    }).workspaceView();
    assert.deepEqual(omitted.observations, { status: 'omitted', reason: 'policy' });
    assert.deepEqual(omitted.approvals, { status: 'omitted', reason: 'policy' });

    const port = openReadPort({ read: runtime, project });
    const before = port.workspaceView();
    const saved = structuredClone(before);
    await Promise.all([
      Promise.resolve().then(() =>
        runtime.clock.submit({
          observation_id: 'interleaved:tick',
          caused_by: null,
          payload_type: 'clock.tick',
          payload_version: 1,
          payload: { tick: 0 },
        }),
      ),
      Promise.resolve().then(() => {
        const view = port.workspaceView();
        if (view.approvals.status === 'disclosed') Reflect.set(view.approvals.items, 'length', 0);
        if (view.observations.status === 'disclosed') Reflect.set(view.observations.items, 'length', 0);
      }),
    ]);
    assert.deepEqual(before, saved);
    const after = port.workspaceView();
    assert.equal(after.approvals.status === 'disclosed' && after.approvals.items.length, 1);
    assert.equal(after.observations.status === 'disclosed' && after.observations.items.at(-1)?.type, 'clock.tick');
  });
});
