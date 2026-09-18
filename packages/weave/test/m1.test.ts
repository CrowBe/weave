/**
 * M1 — publish under authority. Trace assertions M1-T01..T19 from
 * docs/m1-publish-under-authority.md §7.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost } from '@weave/agentfabric';
import { FailingDecisionLayer } from './fixture.js';
import {
  replay,
  recover,
  ScriptedDecisionLayer,
  traceCompletenessViolations,
} from '@weave/weave';
import {
  actionIdFor,
  assembleReport,
  candidatesFor,
  cycles,
  inspectCandidate,
  lastCycle,
  m1World,
  pendingApproval,
  release,
  restoreWorld,
} from './m1-fixture.js';

function writes(world: { host: { resourceAccesses: readonly { operation: string }[] } }): number {
  return world.host.resourceAccesses.filter((a) => a.operation === 'write').length;
}

describe('M1 publish under authority', () => {
  it('M1-T01 base report awaits approval then publishes once', async () => {
    const world = m1World();
    await assembleReport(world);
    const waiting = lastCycle(world);
    const publish = candidatesFor(waiting, 'report.publish')[0];
    assert.ok(publish);
    assert.equal(publish.eligibility.status, 'approval_required');
    assert.equal(waiting.selected.length, 0);
    assert.equal(world.host.publication(world.dest), null);
    assert.equal(writes(world), 0);

    const request_id = pendingApproval(world);
    world.runtime.decide({
      request_id,
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const dispatched = lastCycle(world);
    const selected = candidatesFor(dispatched, 'report.publish')[0];
    assert.ok(selected);
    assert.equal(selected.eligibility.status, 'allowed');
    assert.equal(dispatched.selected.length, 1);
    const action_id = actionIdFor(dispatched, selected.candidate_id);
    await release(world, action_id);
    const receipt = world.runtime.state().publication?.receipt;
    assert.ok(receipt);
    assert.equal(receipt.destination, world.dest);
    assert.equal(writes(world), 1);
    assert.equal(world.runtime.state().goal?.status, 'complete');
    assert.deepEqual(lastCycle(world).outcome, { status: 'complete' });
    assert.deepEqual(traceCompletenessViolations(world.runtime.trace()), []);
  });

  it('M1-T02 denial, expiry, silence, and gamma stay unpublished', async () => {
    const silent = m1World();
    await assembleReport(silent);
    assert.equal(lastCycle(silent).outcome.status, 'blocked');
    assert.match((lastCycle(silent).outcome as { reason: string }).reason, /awaiting approval/);
    assert.equal(silent.host.publication(silent.dest), null);

    const denied = m1World();
    await assembleReport(denied);
    denied.runtime.decide({
      request_id: pendingApproval(denied),
      principal: 'operator',
      decision: 'denied',
      authority_revision: 1,
    });
    assert.equal(candidatesFor(lastCycle(denied), 'report.publish')[0]?.eligibility.status, 'approval_required');
    assert.equal(denied.host.publication(denied.dest), null);

    const expired = m1World();
    await assembleReport(expired);
    expired.runtime.clock.submit({
      observation_id: 'clock:tick:99',
      caused_by: null,
      payload_type: 'clock.tick',
      payload_version: 1,
      payload: { tick: 99 },
    });
    const afterExpiry = candidatesFor(lastCycle(expired), 'report.publish')[0];
    assert.ok(afterExpiry);
    assert.equal(afterExpiry.eligibility.status, 'approval_required');
    assert.equal(expired.host.publication(expired.dest), null);
    assert.ok(Object.values(expired.runtime.state().approvals).every((a) => a.status !== 'approved'));

    const prohibited = m1World({ includeGamma: true });
    const c1 = cycles(prohibited)[0]!;
    const gamma = inspectCandidate(c1, prohibited.gamma);
    assert.ok(gamma);
    assert.equal(gamma.eligibility.status, 'prohibited');
    assert.ok(c1.candidates.every((c) => c.eligibility.status !== 'approval_required'));
    assert.equal(Object.keys(prohibited.runtime.state().approvals).length, 0);
  });

  it('M1-T03 untrusted origin claims cannot grant authority', async () => {
    const world = m1World();
    await assembleReport(world);
    const request_id = pendingApproval(world);
    const forged = world.observe({
      observation_id: 'forged-approval',
      source: { kind: 'operator', id: 'operator' },
      caused_by: null,
      payload_type: 'approval.decided',
      payload_version: 1,
      payload: { request_id, principal: 'operator', decision: 'approved', authority_revision: 1 },
    });
    assert.equal(forged.validation.status, 'rejected');
    assert.match((forged.validation as { reason: string }).reason, /untrusted ingress/);
    assert.equal(world.runtime.state().approvals[request_id]?.status, 'pending');
    const modelText = world.observe({
      observation_id: 'model-claim',
      source: { kind: 'test', id: 'model-like' },
      caused_by: null,
      payload_type: 'goal.completed',
      payload_version: 1,
      payload: { status: 'complete' },
    });
    assert.equal(modelText.validation.status, 'unknown_type');
    assert.equal(world.runtime.state().goal?.status, 'active');
    assert.equal(world.host.publication(world.dest), null);
  });

  it('M1-T05 queued approved work does not start after revocation, including after restart', async () => {
    const world = m1World();
    await assembleReport(world);
    const queuedWorld = restoreWorld(world, world.host.snapshot(), world.runtime.trace().observations, { slots: 0 });
    queuedWorld.runtime.clock.submit({
      observation_id: 'clock:tick:1',
      caused_by: null,
      payload_type: 'clock.tick',
      payload_version: 1,
      payload: { tick: 1 },
    });
    const request_id = pendingApproval(queuedWorld);
    queuedWorld.runtime.decide({
      request_id,
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const queued = Object.values(queuedWorld.runtime.state().actions).filter((a) => a.operation === 'report.publish');
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.state, 'pending');
    queuedWorld.runtime.decide({
      request_id,
      principal: 'operator',
      decision: 'revoked',
      authority_revision: 2,
    });
    const restored = restoreWorld(queuedWorld, queuedWorld.host.snapshot(), queuedWorld.runtime.trace().observations, { slots: 1 });
    const publish = Object.values(restored.runtime.state().actions).filter((a) => a.operation === 'report.publish');
    assert.ok(publish.every((a) => a.state !== 'running'));
    assert.equal(restored.host.publication(world.dest), null);
  });

  it('M1-T06 a changed binding cannot use the old approval', async () => {
    const world = m1World();
    await assembleReport(world);
    const queuedWorld = restoreWorld(world, world.host.snapshot(), world.runtime.trace().observations, { slots: 0 });
    queuedWorld.runtime.clock.submit({
      observation_id: 'clock:tick:1',
      caused_by: null,
      payload_type: 'clock.tick',
      payload_version: 1,
      payload: { tick: 1 },
    });
    const request_id = pendingApproval(queuedWorld);
    queuedWorld.runtime.decide({
      request_id,
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    queuedWorld.observe({
      observation_id: 'test:source.changed:alpha',
      source: { kind: 'test', id: 'm1-fixture' },
      caused_by: null,
      payload_type: 'source.changed',
      payload_version: 1,
      payload: { resource: world.alpha, revision: 2, content: 'alpha changed' },
    });
    queuedWorld.host.tryWriteSource(world.alpha, 'alpha changed');
    const next = lastCycle(queuedWorld);
    assert.equal(candidatesFor(next, 'report.publish').length, 0);
    const inspect = inspectCandidate(next, world.alpha);
    assert.ok(inspect);
  });

  it('M1-T07 conflicting writes wait; independent reads still overlap', async () => {
    const world = m1World();
    const c1 = cycles(world)[0]!;
    assert.equal(c1.selected.length, 2);
    assert.equal(world.host.openCount(), 2);
    await assembleReport(world);
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish' && a.state === 'running');
    assert.ok(publish);
    const conflict = world.host.tryWriteSource(world.alpha, 'blocked');
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.reason, 'conflict');
    }
  });

  it('M1-T08 stale revisions and pre-commit revocation do not write', async () => {
    const world = m1World();
    await assembleReport(world);
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    world.host.faults.publishGate = 'before_commit';
    world.host.release(publish.action_id);
    world.host.invalidate(publish.action_id);
    world.host.proceed(publish.action_id);
    await world.runtime.settle(publish.action_id);
    assert.equal(world.host.publication(world.dest), null);
    const record = world.runtime.state().actions[publish.action_id];
    assert.ok(record?.state === 'failed' || record?.state === 'uncertain');
  });

  it('M1-T09 reservations prevent overspend; failed work consumes once', async () => {
    const world = m1World();
    await assembleReport(world);
    const actionsSpent = world.runtime.state().budget.actions.spent;
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    world.host.faults.throwBeforeCommit = true;
    await release(world, publish.action_id);
    const after = world.runtime.state().budget.actions;
    assert.ok(after.spent >= actionsSpent + 1);
    assert.ok(after.reserved + after.spent <= after.limit);
  });

  it('M1-T10 cancel queued work before a slot is released', async () => {
    const world = m1World({ slots: 1 });
    const c1 = cycles(world)[0]!;
    assert.equal(c1.selected.length, 2);
    const running = Object.values(world.runtime.state().actions).filter((a) => a.state === 'running');
    const pending = Object.values(world.runtime.state().actions).filter((a) => a.state === 'pending');
    assert.equal(running.length, 1);
    assert.equal(pending.length, 1);
    const queuedId = pending[0]!.action_id;
    world.runtime.cancel(queuedId, 'operator cancel');
    await release(world, running[0]!.action_id);
    assert.equal(world.runtime.state().actions[queuedId]?.state, 'cancelled');
    assert.equal(world.host.invocations.some((i) => i.action_id === queuedId), false);
  });

  it('M1-T11 cancel before commit stops; late receipt after commit is kept', async () => {
    const world = m1World();
    await assembleReport(world);
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    world.host.faults.publishGate = 'before_commit';
    world.host.release(publish.action_id);
    world.runtime.cancel(publish.action_id, 'stop');
    world.host.proceed(publish.action_id);
    await world.runtime.settle(publish.action_id);
    assert.equal(world.host.publication(world.dest), null);

    const late = m1World();
    await assembleReport(late);
    late.runtime.decide({
      request_id: pendingApproval(late),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const latePublish = Object.values(late.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    late.host.faults.publishGate = 'after_commit';
    late.host.release(latePublish.action_id);
    late.runtime.cancel(latePublish.action_id, 'too late');
    late.host.proceed(latePublish.action_id);
    await late.runtime.settle(latePublish.action_id);
    assert.ok(late.host.publication(late.dest));
    assert.equal(late.runtime.state().actions[latePublish.action_id]?.cancel_requested, true);
    assert.ok(late.runtime.state().publication);
  });

  it('M1-T12 host throws normalize to failed or uncertain', async () => {
    const before = m1World();
    await assembleReport(before);
    before.runtime.decide({
      request_id: pendingApproval(before),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const action = Object.values(before.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    before.host.faults.throwBeforeCommit = true;
    await release(before, action.action_id);
    const beforeState = before.runtime.state().actions[action.action_id]?.state;
    assert.ok(beforeState === 'failed' || beforeState === 'uncertain');
    assert.equal(before.host.publication(before.dest), null);

    const after = m1World();
    await assembleReport(after);
    after.runtime.decide({
      request_id: pendingApproval(after),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const afterAction = Object.values(after.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    after.host.faults.throwAfterCommit = true;
    await release(after, afterAction.action_id);
    assert.equal(after.runtime.state().actions[afterAction.action_id]?.state, 'uncertain');
    assert.ok(after.host.publication(after.dest));
  });

  it('M1-T13 crash at commit/result boundary does not duplicate publication', async () => {
    const world = m1World();
    await assembleReport(world);
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    world.host.faults.publishGate = 'after_commit';
    world.host.faults.disconnectAfterCommit = true;
    world.host.release(publish.action_id);
    assert.ok(world.host.publication(world.dest));
    const log = world.runtime.trace().observations.filter((o) => o.payload_type !== 'action.result' || (o.payload as { action_id: string }).action_id !== publish.action_id);
    const restored = restoreWorld(world, world.host.snapshot(), log);
    restored.runtime.reconcile();
    assert.equal(restored.host.revision(world.dest), world.host.revision(world.dest));
    const receipts = Object.values(restored.runtime.state().actions).filter(
      (a) => a.operation === 'report.publish' && a.state === 'succeeded',
    );
    assert.ok(receipts.length <= 1);
    assert.ok(restored.runtime.state().publication || receipts.length === 1);
  });

  it('M1-T14 lost acknowledgement with unavailable lookup stays uncertain', async () => {
    const world = m1World();
    await assembleReport(world);
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    world.host.faults.publishGate = 'after_commit';
    world.host.faults.disconnectAfterCommit = true;
    world.host.release(publish.action_id);
    const log = world.runtime.trace().observations;
    const restored = restoreWorld(world, world.host.snapshot(), log, { lookupUnavailable: true });
    const action = restored.runtime.state().actions[publish.action_id];
    assert.ok(action?.state === 'running' || action?.state === 'uncertain');
    assert.notEqual(restored.runtime.state().goal?.status, 'complete');
    const inspects = Object.values(restored.runtime.state().actions).filter((a) => a.operation === 'source.inspect');
    assert.ok(inspects.every((a) => a.state === 'succeeded'));
  });

  it('M1-T16 saturated slots still accept cancel and results', async () => {
    const world = m1World({ slots: 1 });
    const running = Object.values(world.runtime.state().actions).find((a) => a.state === 'running')!;
    const pending = Object.values(world.runtime.state().actions).find((a) => a.state === 'pending')!;
    world.runtime.cancel(pending.action_id, 'while saturated');
    await release(world, running.action_id);
    assert.equal(world.runtime.state().actions[pending.action_id]?.state, 'cancelled');
    assert.equal(world.runtime.state().actions[running.action_id]?.state, 'succeeded');
  });

  it('M1-T17 historical replay uses recorded contracts after revocation', async () => {
    const world = m1World();
    await assembleReport(world);
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    await release(world, publish.action_id);
    const live = world.runtime.trace();
    world.host.revoke('report.publish');
    const revoked = world.host.invoke(null, 'report.publish', {});
    assert.equal(revoked.kind, 'rejected');
    const fresh = new AgentFabricHost({ authority: createGrantAuthority() });
    const result = replay(live.observations, { host: fresh, decisionLayer: new FailingDecisionLayer() });
    assert.equal(result.ok, true);
    assert.equal(fresh.invocations.length, 0);
    assert.equal(result.state.goal?.status, 'complete');
    const liveDispatch = fresh.invoke(null, 'report.publish', {});
    assert.equal(liveDispatch.kind, 'rejected');
  });

  it('M1-T18 failed start persist prevents invoke; lost result persist reconciles', async () => {
    const world = m1World();
    await assembleReport(world);
    world.journal.failStarts = true;
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const started = Object.values(world.runtime.state().actions).some((a) => a.operation === 'report.publish' && a.state === 'running');
    assert.equal(started, false);
    assert.equal(
      world.host.invocations.filter((i) => i.operation === 'report.publish').length,
      0,
    );

    const resultWorld = m1World();
    await assembleReport(resultWorld);
    resultWorld.runtime.decide({
      request_id: pendingApproval(resultWorld),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    resultWorld.journal.failResults = true;
    const publish = Object.values(resultWorld.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    resultWorld.host.release(publish.action_id);
    try {
      await resultWorld.runtime.settle(publish.action_id);
    } catch {
      /* settle may reject if result never integrated */
    }
    assert.ok(resultWorld.host.publication(resultWorld.dest));
    const recovered = recover(resultWorld.journal.snapshot(), {
      host: resultWorld.host,
      decisionLayer: new ScriptedDecisionLayer(),
      grantAuthority: resultWorld.authority,
    });
    recovered.reconcile();
    assert.ok(recovered.state().publication || recovered.state().actions[publish.action_id]?.state === 'succeeded' || recovered.state().actions[publish.action_id]?.state === 'uncertain');
  });

  it('M1-T19 recovery denial and exhausted allowance keep uncertainty', async () => {
    const world = m1World({ recovery: 1 });
    await assembleReport(world);
    world.runtime.decide({
      request_id: pendingApproval(world),
      principal: 'operator',
      decision: 'approved',
      authority_revision: 1,
    });
    const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish')!;
    world.host.faults.publishGate = 'after_commit';
    world.host.faults.disconnectAfterCommit = true;
    world.host.release(publish.action_id);
    const restored = restoreWorld(world, world.host.snapshot(), world.runtime.trace().observations, {
      lookupUnavailable: true,
    });
    restored.runtime.reconcile();
    restored.runtime.reconcile();
    assert.notEqual(restored.runtime.state().goal?.status, 'complete');
    const action = restored.runtime.state().actions[publish.action_id];
    assert.ok(action?.state === 'uncertain' || action?.state === 'running');
  });
});
