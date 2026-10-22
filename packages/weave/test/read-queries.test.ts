import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MemoryJournal,
  PersistError,
  Runtime,
  ScriptedDecisionLayer,
  recover,
  replay,
  type ApprovalRequestedPayload,
  type Observation,
} from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import { assembleReport, m1World } from './m1-fixture.js';

function options(journal = new MemoryJournal()) {
  return { host: new FakeHost(new FixtureEnvironment()), decisionLayer: new ScriptedDecisionLayer(), journal };
}
const request: ApprovalRequestedPayload = {
  request_id: 'request',
  goal_id: 'goal',
  candidate_id: 'candidate',
  operation: 'report.publish',
  contract_rev: 'r1',
  binding_digest: 'binding',
  report_digest: 'report',
  read_set: [],
  destination: 'ref_1',
  expected_revision: 1,
  effects: [{ resource: 'ref_1', mode: 'write' }],
  budget: { actions: 1, judgments: 0 },
  valid_from_tick: 0,
  valid_until_tick: 10,
};
function requested(runtime: Runtime, id: string, payload: unknown = request) {
  return runtime.feed({
    observation_id: id,
    source: { kind: 'runtime', id: 'test' },
    caused_by: null,
    payload_type: 'approval.requested',
    payload_version: 1,
    payload,
  });
}

describe('narrow observation reads', () => {
  it('copies only the requested suffix, including zero, and keeps returned observations defensive', (t) => {
    const runtime = new Runtime(options());
    assert.equal(typeof runtime.recentObservations, 'function');
    for (let i = 0; i < 50; i++) {
      runtime.clock.submit({
        observation_id: `tick:${i}`,
        caused_by: null,
        payload_type: 'clock.tick',
        payload_version: 1,
        payload: { tick: i },
      });
    }
    const trace = runtime.trace();
    const clone = structuredClone;
    const sizes: number[] = [];
    t.mock.method(globalThis, 'structuredClone', (value: unknown) => {
      if (Array.isArray(value)) sizes.push(value.length);
      return clone(value);
    });
    for (const limit of [0, 1, 24, 50, 100]) {
      const actual = runtime.recentObservations(limit);
      assert.deepEqual(actual, { observations: limit === 0 ? [] : trace.observations.slice(-limit), total: 50 });
    }
    assert.deepEqual(sizes, [0, 1, 24, 50, 50]);
    const recent = runtime.recentObservations(1);
    (recent.observations[0]!.payload as { tick: number }).tick = -1;
    assert.equal((runtime.recentObservations(1).observations[0]!.payload as { tick: number }).tick, 49);
    for (const limit of [-1, 0.5, NaN, Infinity]) assert.throws(() => runtime.recentObservations(limit), RangeError);
  });

  it('uses an index without rereading payloads and preserves the first logged matching sequence', () => {
    const runtime = new Runtime(options());
    assert.equal(typeof runtime.approvalRequestSeq, 'function');
    let reads = 0;
    const payload = {
      ...request,
      get request_id() {
        reads++;
        return 'request';
      },
    };
    const first = requested(runtime, 'first', payload);
    const duplicate = requested(runtime, 'duplicate');
    assert.equal(duplicate.validation.status, 'rejected');
    reads = 0;
    for (let i = 0; i < 1000; i++) {
      assert.equal(runtime.approvalRequestSeq('request'), first.seq);
      assert.equal(runtime.approvalRequestSeq('missing'), undefined);
    }
    assert.equal(reads, 0, 'approval queries must not scan logged payloads');
    const rejected = requested(runtime, 'malformed', { request_id: 'later' });
    assert.equal(rejected.validation.status, 'rejected');
    requested(runtime, 'valid-later', { ...request, request_id: 'later' });
    // The former binding scanned all logged records, including validation rejections.
    assert.equal(runtime.approvalRequestSeq('later'), rejected.seq);
  });

  it('does not publish failed persistence or oversize diagnostics to either read index', () => {
    class FailingJournal extends MemoryJournal {
      fail = true;
      override persist(observation: Observation) {
        if (this.fail) throw new PersistError(observation.payload_type);
        super.persist(observation);
      }
    }
    const journal = new FailingJournal();
    const runtime = new Runtime(options(journal));
    assert.equal(typeof runtime.approvalRequestSeq, 'function');
    assert.throws(() => requested(runtime, 'failed'), PersistError);
    assert.equal(runtime.approvalRequestSeq('request'), undefined);
    assert.deepEqual(runtime.recentObservations(24), { observations: [], total: 0 });
    journal.fail = false;
    const accepted = requested(runtime, 'retry');
    assert.equal(runtime.approvalRequestSeq('request'), accepted.seq);
    const bounded = new Runtime({ ...options(), logBound: { max_observation_bytes: 1 } });
    assert.equal(requested(bounded, 'oversize').validation.status, 'rejected');
    assert.equal(bounded.approvalRequestSeq('request'), undefined);
    assert.deepEqual(bounded.recentObservations(24), { observations: [], total: 0 });
  });

  it('rebuilds the same reads at every loaded prefix, including rejected and repeated requests', () => {
    const runtime = new Runtime(options());
    assert.equal(typeof runtime.approvalRequestSeq, 'function');
    requested(runtime, 'malformed', { request_id: 'request' });
    requested(runtime, 'accepted');
    runtime.decide({ request_id: 'request', principal: 'operator', decision: 'denied', authority_revision: 1 });
    requested(runtime, 'reopened');
    const log = runtime.trace().observations;
    for (let end = 0; end <= log.length; end++) {
      const prefix = log.slice(0, end);
      const loaded = new Runtime(options());
      loaded.load(prefix);
      const recovered = recover(prefix, options());
      for (const reader of [loaded, recovered]) {
        assert.deepEqual(reader.recentObservations(24), { observations: prefix, total: prefix.length });
        assert.equal(reader.approvalRequestSeq('request'), prefix[0]?.seq);
        assert.equal(reader.approvalRequestSeq('missing'), undefined);
      }
    }
  });

  it('replays a real pending approval identically and rebuilds its durable prefix on recovery', async () => {
    const world = m1World();
    await assembleReport(world);
    const runtime = world.runtime;
    assert.equal(typeof runtime.approvalRequestSeq, 'function');
    const before = runtime.trace();
    const result = replay(before.observations, {
      host: world.host,
      decisionLayer: new ScriptedDecisionLayer(),
      grantAuthority: world.authority,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.trace, before);
    assert.deepEqual(result.state, runtime.state());
    const recovered = recover(world.journal.snapshot(), {
      host: world.host,
      decisionLayer: new ScriptedDecisionLayer(),
      grantAuthority: world.authority,
    });
    for (const record of Object.values(runtime.state().approvals)) {
      assert.equal(recovered.approvalRequestSeq(record.request_id), runtime.approvalRequestSeq(record.request_id));
    }
    assert.deepEqual(recovered.recentObservations(24).observations, world.journal.snapshot().slice(-24));
  });
});
