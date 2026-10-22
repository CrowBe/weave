/**
 * W5 acceptance 1 (#187): a concurrent multi-thread run produces a Weft trace
 * whose causal graph matches the recorded observations, including
 * cancellation and retry (packages/weft/src/WEFT-CONTRACT.md, Emission).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActionResultPayload, ActionStartedPayload, Observation } from '@weave/weave';
import { collector, runW5, settleAsync, TRACE_ID, w5World, type Rec } from './w5-fixture.js';

function byId(records: readonly Rec[]): Map<string, Rec> {
  const map = new Map<string, Rec>();
  for (const record of records) {
    assert.equal(map.has(record.record_id), false, `duplicate record id ${record.record_id}`);
    map.set(record.record_id, record);
  }
  return map;
}

function accepted(observations: readonly Observation[], type: string): Observation[] {
  return observations.filter((o) => o.payload_type === type && o.validation.status === 'accepted');
}

function transitions(records: readonly Rec[], thread: string): string[] {
  return records
    .filter((r) => r.kind === 'thread.transition' && r.thread_id === thread)
    .map((r) => r.fields['transition'] as string);
}

async function tracedRun() {
  const loom = collector();
  const gateway = collector();
  const fabric = collector();
  const world = w5World({ loom: loom.sink, gateway: gateway.sink, fabric: fabric.sink });
  const run = await runW5(world);
  const all = [...loom.records, ...gateway.records, ...fabric.records];
  return { world, run, loom: loom.records, gateway: gateway.records, fabric: fabric.records, all };
}

describe('W5 causal trace', () => {
  it('W5-T01 every emitter emits weft.record@1 records into the composition-chosen trace, in sequence', async () => {
    const { loom, gateway, fabric, all } = await tracedRun();
    assert.ok(loom.length > 0, 'Loom emitted nothing');
    assert.ok(gateway.length > 0, 'the gateway emitted nothing');
    assert.ok(fabric.length > 0, 'the Fabric host emitted nothing');
    byId(all);
    for (const [records, kind, id] of [
      [loom, 'loom', 'loom.main'],
      [gateway, 'gateway', 'gateway.main'],
      [fabric, 'fabric', 'fabric.host'],
    ] as const) {
      let last = -1;
      for (const record of records) {
        assert.equal(record.schema, 'weft.record@1');
        assert.equal(record.trace_id, TRACE_ID);
        assert.deepEqual(record.emitter, { kind, id });
        assert.ok(record.sequence > last, `${id} sequence ${record.sequence} after ${last}`);
        last = record.sequence;
      }
    }
  });

  it('W5-T02 every link and parent resolves inside the trace', async () => {
    const { all } = await tracedRun();
    const ids = byId(all);
    for (const record of all) {
      if (record.parent_id !== null) {
        assert.ok(ids.has(record.parent_id), `${record.record_id} has unresolved parent ${record.parent_id}`);
      }
      for (const link of record.links) {
        assert.ok(ids.has(link.record_id), `${record.record_id} ${link.rel} link to missing ${link.record_id}`);
        assert.notEqual(link.record_id, record.record_id);
      }
    }
  });

  it('W5-T03 one cycle.weighed per cycle record, with each candidate disposition from the cycle', async () => {
    const { world, loom } = await tracedRun();
    const cycles = world.runtime.trace().cycles;
    const weighed = loom.filter((r) => r.kind === 'cycle.weighed');
    assert.equal(weighed.length, cycles.length);
    for (const cycle of cycles) {
      const record = weighed.find((r) => r.fields['cycle_no'] === cycle.cycle_no);
      assert.ok(record, `no cycle.weighed for cycle ${cycle.cycle_no}`);
      assert.equal(record.thread_id, null);
      assert.equal(record.fields['state_revision'], cycle.state_revision);
      assert.equal(record.fields['procedure'], cycle.procedure);
      assert.equal(record.fields['weights_ref'], cycle.weights_ref === null ? null : `seq:${cycle.weights_ref}`);
      const candidates = record.fields['candidates'] as {
        candidate_ref: string;
        disposition: string;
        weight: number | null;
        eligibility: string;
      }[];
      assert.equal(candidates.length, cycle.candidates.length);
      cycle.candidates.forEach((candidate, index) => {
        const emitted = candidates[index]!;
        assert.equal(emitted.candidate_ref, candidate.candidate_id.replace('#', ':'));
        assert.equal(emitted.eligibility, candidate.eligibility.status);
        const selected = cycle.selected.some((s) => s.candidate_id === candidate.candidate_id);
        const rejected = cycle.not_selected.find((n) => n.candidate_id === candidate.candidate_id);
        const expected =
          candidate.eligibility.status !== 'allowed'
            ? 'policy_filtered'
            : selected
              ? 'selected'
              : rejected && rejected.reason !== 'deferred'
                ? rejected.reason
                : 'not_reached';
        assert.equal(emitted.disposition, expected, `cycle ${cycle.cycle_no} ${candidate.candidate_id}`);
        assert.equal(emitted.weight, candidate.eligibility.status === 'allowed' ? candidate.weight : null);
      });
      for (const sel of cycle.selected) {
        const opened = loom.find(
          (r) => r.kind === 'thread.transition' && r.thread_id === sel.action_id && r.fields['transition'] === 'opened',
        );
        assert.ok(opened, `no opened thread for ${sel.action_id}`);
        assert.equal(opened.parent_id, record.record_id, `${sel.action_id} is not a child of cycle ${cycle.cycle_no}`);
      }
    }
  });

  it('W5-T04 threads open, run and close as the observations record, and run concurrently', async () => {
    const { world, loom } = await tracedRun();
    const observations = world.runtime.trace().observations;
    const dispatched = new Set(
      [...accepted(observations, 'action.started'), ...accepted(observations, 'action.queued')].map(
        (o) => (o.payload as ActionStartedPayload).action_id,
      ),
    );
    const opened = new Set(
      loom.filter((r) => r.kind === 'thread.transition' && r.fields['transition'] === 'opened').map((r) => r.thread_id),
    );
    assert.deepEqual([...opened].sort(), [...dispatched].sort());
    for (const result of accepted(observations, 'action.result')) {
      const payload = result.payload as ActionResultPayload;
      const action = loom.find(
        (r) =>
          r.kind === 'action.transition' &&
          r.thread_id === payload.action_id &&
          r.fields['state'] === payload.outcome.outcome,
      );
      assert.ok(action, `no ${payload.outcome.outcome} transition for ${payload.action_id}`);
      assert.deepEqual(action.evidence[0], { source: 'observation', ref: `seq:${result.seq}` });
      const closed = loom.find(
        (r) =>
          r.kind === 'thread.transition' && r.thread_id === payload.action_id && r.fields['transition'] === 'closed',
      );
      assert.ok(closed, `thread ${payload.action_id} not closed`);
      assert.deepEqual(closed.links, [{ rel: 'caused_by', record_id: action.record_id }]);
    }
    // Two inspections ran at once: both opened before either closed.
    const firstInspections = Object.values(world.runtime.state().actions)
      .filter((a) => a.operation === 'source.inspect' && a.state === 'succeeded')
      .map((a) => a.action_id)
      .sort()
      .slice(0, 2);
    const seqOf = (thread: string, transition: string) =>
      loom.find(
        (r) => r.kind === 'thread.transition' && r.thread_id === thread && r.fields['transition'] === transition,
      )!.sequence;
    const [a, b] = firstInspections as [string, string];
    assert.ok(
      seqOf(a, 'opened') < seqOf(b, 'closed') && seqOf(b, 'opened') < seqOf(a, 'closed'),
      'inspections did not overlap',
    );
  });

  it('W5-T05 cancellation and supersession are explicit links', async () => {
    const { world, run, loom } = await tracedRun();
    const state = world.runtime.state();
    assert.equal(state.actions[run.cancelled]?.state, 'cancelled');
    assert.deepEqual(transitions(loom, run.cancelled), ['opened', 'cancelled', 'superseded']);
    const opened = `loom.main:thread:${run.cancelled}:opened`;
    const cancelled = loom.find((r) => r.thread_id === run.cancelled && r.fields['transition'] === 'cancelled')!;
    assert.deepEqual(cancelled.links, [{ rel: 'cancels', record_id: opened }]);
    const cancelObservation = accepted(world.runtime.trace().observations, 'action.cancel_requested')[0]!;
    assert.deepEqual(cancelled.evidence, [{ source: 'observation', ref: `seq:${cancelObservation.seq}` }]);
    assert.ok(
      loom.some(
        (r) => r.kind === 'action.transition' && r.thread_id === run.cancelled && r.fields['state'] === 'cancelled',
      ),
    );
    const superseded = loom.find((r) => r.thread_id === run.cancelled && r.fields['transition'] === 'superseded')!;
    assert.deepEqual(superseded.links, [
      { rel: 'supersedes', record_id: `loom.main:thread:${run.superseding}:opened` },
    ]);
    assert.equal(state.actions[run.superseding]?.candidate_id, state.actions[run.cancelled]?.candidate_id);
  });

  it('W5-T05b a second cancel request for the same thread is a second record, not a conflicting one', async () => {
    const loom = collector();
    const world = w5World({ loom: loom.sink });
    await settleAsync(world);
    const queued = Object.values(world.runtime.state().actions).find((a) => a.state === 'pending')!;
    world.runtime.cancel(queued.action_id, 'operator cancel');
    const again = world.runtime.operator.submit({
      observation_id: `operator:cancel:${queued.action_id}:again`,
      caused_by: null,
      payload_type: 'action.cancel_requested',
      payload_version: 1,
      payload: { action_id: queued.action_id, reason: 'operator cancel, repeated' },
    });
    assert.equal(again.validation.status, 'accepted');
    const cancels = loom.records.filter(
      (r) => r.thread_id === queued.action_id && r.fields['transition'] === 'cancelled',
    );
    assert.equal(cancels.length, 2);
    byId(loom.records);
  });

  it('W5-T06 the report joins every inspection thread it depends on', async () => {
    const { world, loom } = await tracedRun();
    const cycles = world.runtime.trace().cycles;
    const assemble = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.assemble')!;
    const cycle = cycles.find((c) => c.selected.some((s) => s.action_id === assemble.action_id))!;
    const candidate = cycle.candidates.find((c) => c.candidate_id === assemble.candidate_id)!;
    assert.equal(candidate.dependencies.length, 3);
    const joined = loom.find((r) => r.thread_id === assemble.action_id && r.fields['transition'] === 'joined')!;
    assert.deepEqual(
      joined.links,
      candidate.dependencies.map((dep) => ({ rel: 'joins', record_id: `loom.main:thread:${dep}:closed` })),
    );
  });

  it('W5-T07 the gateway retry is linked to the attempt it repeats, with the failure as an error child', async () => {
    const { world, gateway, loom } = await tracedRun();
    assert.ok(world.weigher.calls.length >= 2);
    const attempts = gateway.filter((r) => r.kind === 'inference.attempt');
    const first = attempts.find((r) => r.fields['attempt_no'] === 1 && r.fields['disposition'] === 'failed')!;
    assert.ok(first, 'no failed first attempt');
    const request = first.fields['request_ref'] as string;
    const retry = attempts.find((r) => r.fields['request_ref'] === request && r.fields['attempt_no'] === 2)!;
    assert.equal(retry.fields['disposition'], 'accepted');
    assert.deepEqual(retry.links, [{ rel: 'retry_of', record_id: first.record_id }]);
    assert.equal(retry.parent_id, first.parent_id, 'a same-route retry stays under its route');
    const route = gateway.find((r) => r.record_id === first.parent_id)!;
    assert.equal(route.kind, 'route.selected');
    assert.equal(route.fields['routed_unit'], 'weigh.local');
    const error = gateway.find((r) => r.kind === 'error' && r.parent_id === first.record_id)!;
    assert.deepEqual(error.fields, { code: 'unavailable', retryable: true });
    // An evaluation failure reports no usage, so it is charged its worst case.
    assert.equal(Object.hasOwn(first.fields, 'input_tokens'), false);
    assert.equal(first.fields['cost_is_upper_bound'], true);
    assert.equal(retry.fields['input_tokens'], 30);
    assert.equal(retry.fields['output_tokens'], 10);
    assert.deepEqual(first.evidence, [{ source: 'inference_request', ref: request }]);
    // Loom reports the judgment the retry produced.
    const recorded = accepted(world.runtime.trace().observations, 'inference.recorded');
    const judgments = loom.filter((r) => r.kind === 'judgment');
    assert.equal(judgments.length, recorded.length);
    assert.ok(judgments.every((r) => r.fields['site'] === 'frontier.weigh' && r.fields['accepted'] === true));
    assert.equal(judgments[0]!.fields['routed_unit'], 'weigh.local');
  });

  it('W5-T08 Fabric reports selection and each invocation, cited by the invocation Loom dispatched', async () => {
    const { world, fabric, loom } = await tracedRun();
    const invocations = world.host.invocations;
    assert.ok(invocations.length >= 4);
    for (const invocation of invocations) {
      const selected = fabric.find(
        (r) =>
          r.kind === 'capability.lifecycle' &&
          r.fields['event'] === 'selected' &&
          r.evidence[0]?.ref === invocation.invocation_id,
      )!;
      assert.ok(selected, `no selection for ${invocation.invocation_id}`);
      assert.equal(selected.fields['operation'], invocation.operation);
      assert.equal(selected.fields['implementation'], invocation.implementation_id);
      const invoked = fabric.find(
        (r) => r.kind === 'capability.invoked' && r.fields['invocation_ref'] === invocation.invocation_id,
      )!;
      assert.ok(invoked, `no capability.invoked for ${invocation.invocation_id}`);
      assert.equal(invoked.parent_id, selected.record_id);
      assert.equal(invoked.fields['status'], world.runtime.state().actions[invocation.action_id]?.state);
      assert.ok(
        loom.some((r) => r.kind === 'action.transition' && r.fields['action_ref'] === invocation.action_id),
        `Loom has no transition for ${invocation.action_id}`,
      );
    }
    assert.equal(
      fabric.some((r) => r.thread_id !== null),
      false,
      'Fabric does not know Loom threads',
    );
  });

  it('W5-T09 the goal intent and outcome bracket the trace', async () => {
    const { world, loom } = await tracedRun();
    const intent = loom[0]!;
    assert.equal(intent.kind, 'goal.intent');
    assert.equal(intent.fields['goal_ref'], TRACE_ID);
    const statement = intent.fields['statement'] as Record<string, unknown>;
    assert.equal(statement['content_class'], 'private');
    assert.match(statement['digest'] as string, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(statement, 'text'), false);
    const outcomes = loom.filter((r) => r.kind === 'outcome');
    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0]!.fields, { subject: 'goal', subject_ref: TRACE_ID, status: 'complete' });
    // It cites the observation that completed the goal: goal.complete's result.
    const complete = Object.values(world.runtime.state().actions).find((a) => a.operation === 'goal.complete')!;
    assert.deepEqual(outcomes[0]!.evidence, [{ source: 'observation', ref: `seq:${complete.finished_at}` }]);
  });
});
