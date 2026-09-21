/**
 * M3 — fill one capability gap. The report needs a fold the catalogue cannot
 * supply. Crystallization runs contract, corpus, red, isolation, green, and
 * human admission before a separate execution grant finishes the report.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGrantAuthority, type CapabilityContract, type CapabilityLifecycle } from '@weave/agentsop';
import { AgentFabricHost } from '@weave/agentfabric';
import {
  FOLD_CONTRACT,
  HELD_OUT_MARKER,
  ScriptedFoldAuthor,
  foldSource,
  replay,
  traceCompletenessViolations,
  type ActionResultPayload,
  type ActionStartedPayload,
  type AdmissionDecidedPayload,
  type CycleRecord,
  type ExtensionAuthor,
} from '@weave/weave';
import { FailingDecisionLayer } from './fixture.js';
import { driveFold, m3World, openFoldGoal, type M3World } from './m3-fixture.js';

function started(world: M3World, operation: string): ActionStartedPayload[] {
  return world.runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'action.started' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as ActionStartedPayload)
    .filter((payload) => payload.operation === operation);
}

function results(world: M3World, operation: string): ActionResultPayload[] {
  const ids = new Set(started(world, operation).map((payload) => payload.action_id));
  return world.runtime
    .trace()
    .observations.filter((observation) => observation.payload_type === 'action.result' && observation.validation.status === 'accepted')
    .map((observation) => observation.payload as ActionResultPayload)
    .filter((payload) => ids.has(payload.action_id));
}

function cycleSelecting(world: M3World, operation: string, count: number): CycleRecord | undefined {
  return world.runtime.trace().cycles.find((cycle) => cycle.selected.filter((item) => operationOf(cycle, item.candidate_id) === operation).length >= count);
}

function operationOf(cycle: CycleRecord, candidate_id: string): string | undefined {
  return cycle.candidates.find((candidate) => candidate.candidate_id === candidate_id)?.operation;
}

describe('M3 fill one capability gap', () => {
  it('M3-T01 crystallizes report.fold and finishes the report under a separate grant', async () => {
    const world = m3World();
    openFoldGoal(world);
    const first = world.runtime.trace().cycles[0];
    assert.ok(first);
    assert.equal(first.procedure, 'crystallize_and_report@1');
    assert.equal(first.candidates.filter((candidate) => candidate.operation === 'source.inspect').length, 2);
    assert.equal(first.candidates.some((candidate) => candidate.operation === 'gap.search'), true);
    assert.equal(first.selected.length >= 3, true);

    await driveFold(world);
    const state = world.runtime.state();
    assert.equal(state.goal?.status, 'complete');
    assert.ok(state.report);
    assert.ok(state.crystallization.fold);
    assert.equal(state.crystallization.admission?.status, 'admitted');
    assert.equal(state.crystallization.admission?.approver, 'operator');
    assert.deepEqual(traceCompletenessViolations(world.runtime.trace()), []);

    const corpusCycle = cycleSelecting(world, 'corpus.propose', 2);
    assert.ok(corpusCycle, 'visible and held-out corpus proposals run in one cycle');
    const generateCycle = cycleSelecting(world, 'implementation.generate', 2);
    assert.ok(generateCycle, 'implementation proposals run in one cycle');

    const redSeq = resultSeq(world, 'red.demonstrate');
    const generateSeqs = started(world, 'implementation.generate').map((payload) => seqOf(world, payload.action_id, 'action.started'));
    assert.ok(generateSeqs.every((seq) => seq > redSeq));
    const redOutput = results(world, 'red.demonstrate')[0]?.outcome;
    assert.equal(redOutput?.outcome, 'succeeded');
    const placeholder = redOutput?.outcome === 'succeeded' ? (redOutput.output as { placeholder_digest: string }).placeholder_digest : '';
    for (const payload of started(world, 'implementation.generate')) {
      const result = results(world, 'implementation.generate').find((item) => item.action_id === payload.action_id);
      assert.equal(result?.outcome.outcome, 'succeeded');
      if (result?.outcome.outcome === 'succeeded') {
        assert.notEqual((result.outcome.output as { source_digest: string }).source_digest, placeholder);
      }
    }

    const fold = started(world, 'report.fold')[0];
    assert.ok(fold?.grant);
    assert.equal(fold?.grant?.operation, 'report.fold');
    assert.equal(fold?.grant?.contract_rev, 'r1');
    assert.deepEqual(fold?.grant?.permissions, []);
    assert.equal(fold?.grant?.action_id, fold?.action_id);
    assert.ok(world.host.invocations.some((invocation) => invocation.operation === 'report.fold' && invocation.action_id === fold?.action_id));
    const decision = world.runtime.trace().observations.find((observation) => observation.payload_type === 'admission.decided');
    assert.ok(decision);
    assert.equal('grant' in (decision.payload as object), false);
    assert.ok((decision.seq as number) < seqOf(world, fold.action_id, 'action.started'));
  });

  it('M3-T02 a retained procedure informs search and does not admit or dispatch the fold', async () => {
    const world = m3World();
    openFoldGoal(world);
    await driveFold(world, 'admission-requested');
    const search = results(world, 'gap.search')[0];
    assert.equal(search?.outcome.outcome, 'succeeded');
    if (search?.outcome.outcome === 'succeeded') {
      const output = search.outcome.output as { status: string; informed_by: string };
      assert.equal(output.status, 'gap');
      assert.match(output.informed_by, /not an implementation/);
    }
    assert.equal(started(world, 'report.fold').length, 0);
    assert.equal(world.host.resolution('report.fold'), 'unresolved');
    assert.equal(world.runtime.state().goal?.status, 'active');
    const denied = world.host.invoke(null, 'report.fold', { inspections: [] });
    assert.equal(denied.kind, 'rejected');
    assert.equal(world.host.invocations.length, started(world, 'source.inspect').length);
  });

  it('M3-T03 held-out cases stay out of the implementer view and the green observation', async () => {
    const world = m3World();
    openFoldGoal(world);
    await driveFold(world);
    assert.ok(world.author.views.length >= 1);
    for (const view of world.author.views) {
      assert.equal(JSON.stringify(view).includes(HELD_OUT_MARKER), false);
      assert.equal(view.visible_cases.every((testCase) => testCase.split === 'visible'), true);
    }
    for (const result of results(world, 'green.prove')) {
      assert.equal(result.outcome.outcome, 'succeeded');
      if (result.outcome.outcome === 'succeeded') {
        const output = result.outcome.output as { held_out: { passed: number; failed: number }; proven: boolean };
        assert.equal(output.proven, true);
        assert.equal(JSON.stringify(output).includes(HELD_OUT_MARKER), false);
        assert.equal('cases' in output.held_out, false);
      }
    }
    assert.deepEqual(world.lifecycle.audit().held_out_ids, ['hold-three', 'hold-one', 'hold-blank']);
    assert.equal(world.lifecycle.audit().held_out_executed, 6);
    assert.equal(JSON.stringify(world.lifecycle.heldOutCases()).includes(HELD_OUT_MARKER), true);
  });

  it('M3-T04 unsupported isolation blocks red and does not run generated code', async () => {
    const world = m3World({ isolation: 'unsupported' });
    openFoldGoal(world);
    await driveFold(world, 'green');
    const red = results(world, 'red.demonstrate')[0];
    assert.equal(red?.outcome.outcome, 'failed');
    if (red?.outcome.outcome === 'failed') {
      assert.match(red.outcome.failure, /isolation unsupported/);
    }
    assert.equal(started(world, 'implementation.generate').length, 0);
    assert.equal(world.lifecycle.audit().execute_runs, 0);
    assert.equal(world.runtime.state().goal?.status, 'active');
  });

  it('M3-T05 implementation generation is not a candidate before demonstrated red', async () => {
    const world = m3World();
    openFoldGoal(world);
    await driveFold(world, 'admission-requested');
    const redAt = resultSeq(world, 'red.demonstrate');
    for (const payload of started(world, 'implementation.generate')) {
      assert.ok(seqOf(world, payload.action_id, 'action.started') > redAt);
    }
    const beforeRed = world.runtime.trace().cycles.filter((cycle) => cycle.state_revision < redAt);
    assert.equal(
      beforeRed.some((cycle) => cycle.candidates.some((candidate) => candidate.operation === 'implementation.generate')),
      false,
    );
  });

  it('M3-T06 green evidence is not authority, and a forged admission is rejected', async () => {
    const world = m3World();
    openFoldGoal(world);
    await driveFold(world, 'admission-requested');
    assert.equal(world.host.resolution('report.fold'), 'unresolved');
    const forged = world.runtime.observe({
      observation_id: 'forged:admission',
      source: { kind: 'operator', id: 'forged' },
      caused_by: null,
      payload_type: 'admission.decided',
      payload_version: 1,
      payload: {
        request_id: world.runtime.state().crystallization.admission?.request_id,
        implementation_id: 'direct',
        decision: 'admitted',
        approver: 'operator',
        evidence_digest: world.runtime.state().crystallization.admission?.evidence_digest,
        authority_revision: 1,
      },
    });
    assert.equal(forged.validation.status, 'rejected');
    const untrusted = world.runtime.observe({
      observation_id: 'test:admission',
      source: { kind: 'test', id: 'm3' },
      caused_by: null,
      payload_type: 'admission.decided',
      payload_version: 1,
      payload: { request_id: 'adm:nope', implementation_id: 'direct', decision: 'admitted', approver: 'operator', evidence_digest: 'x', authority_revision: 1 },
    });
    assert.equal(untrusted.validation.status, 'rejected');
    assert.equal(started(world, 'report.fold').length, 0);
    const admission = world.runtime.state().crystallization.admission;
    assert.ok(admission);
    const decided = world.runtime.admitCapability({
      request_id: admission.request_id,
      implementation_id: admission.implementation_id,
      evidence_digest: admission.evidence_digest,
      approver: 'operator',
      authority_revision: 1,
    });
    assert.equal(decided.validation.status, 'accepted');
    assert.equal((decided.payload as AdmissionDecidedPayload).decision, 'admitted');
    assert.equal(world.host.resolution('report.fold'), 'resolved');
    const fold = started(world, 'report.fold')[0];
    assert.ok(fold?.grant);
    assert.notEqual(fold.grant, decided.payload);
  });

  it('M3-T07 a contract revision invalidates green evidence', async () => {
    const world = m3World();
    openFoldGoal(world);
    await driveFold(world, 'admission-requested');
    const revised: CapabilityContract = { ...FOLD_CONTRACT, revision: 'r2', purpose: 'Fold digests under a revised contract' };
    const invalidated = world.runtime.invalidateEvidence(revised);
    assert.equal(invalidated.validation.status, 'accepted');
    assert.equal(world.runtime.state().crystallization.contract, null);
    assert.equal(world.runtime.state().crystallization.admission, null);
    const admission = world.runtime.trace().observations.find((observation) => observation.payload_type === 'admission.decided' && observation.validation.status === 'accepted');
    assert.equal(admission, undefined);
    const decided = world.runtime.admitCapability({
      request_id: 'adm:stale',
      implementation_id: 'direct',
      evidence_digest: 'stale',
      approver: 'operator',
      authority_revision: 1,
    });
    assert.equal(decided.validation.status, 'rejected');
    assert.notEqual(world.host.resolution('report.fold'), 'resolved');
    assert.equal(started(world, 'report.fold').length, 0);
  });

  it('M3-T08 revocation blocks an in-flight fold and leaves the goal incomplete', async () => {
    const world = m3World();
    openFoldGoal(world);
    await driveFold(world, 'admission-requested');
    const admission = world.runtime.state().crystallization.admission;
    assert.ok(admission);
    world.runtime.admitCapability({
      request_id: admission.request_id,
      implementation_id: admission.implementation_id,
      evidence_digest: admission.evidence_digest,
      approver: 'operator',
      authority_revision: 1,
    });
    const fold = Object.values(world.runtime.state().actions).find((action) => action.operation === 'report.fold' && action.state === 'running');
    assert.ok(fold);
    const notice = world.runtime.revokeCapability('report.fold', admission.implementation_id, 'operator revoked the fold');
    assert.equal(notice.validation.status, 'accepted');
    world.host.release(fold.action_id);
    await world.runtime.settle(fold.action_id);
    assert.equal(world.runtime.state().actions[fold.action_id]?.state, 'failed');
    assert.equal(world.runtime.state().goal?.status, 'active');
    assert.equal(world.host.resolution('report.fold'), 'unavailable');
    const again = world.host.invoke(null, 'report.fold', { inspections: [] });
    assert.equal(again.kind, 'rejected');
  });

  it('M3-T10 a late implementation is refused after held-out scoring, and an already attached sibling can still be scored', async () => {
    const world = m3World();
    openFoldGoal(world);
    await driveFold(world, 'admission-requested');
    const running = Object.values(world.runtime.state().actions).filter((action) => action.state === 'running');
    await Promise.all(running.map((action) => world.runtime.settle(action.action_id).catch(() => undefined)));
    await Promise.resolve();
    const green = world.runtime.state().crystallization.green;
    assert.equal(green.length, 2);
    assert.equal(green.every((item) => item.proven), true);
    const late = world.lifecycle.attachImplementation('late', foldSource('direct'));
    assert.equal(late.ok, false);
    assert.match((late as { reason: string }).reason, /spent/);
    assert.equal(started(world, 'implementation.generate').length, 2);
  });

  it('M3-T11 replay reconstructs the run without the author, lifecycle, or generated code', async () => {
    const world = m3World();
    openFoldGoal(world);
    await driveFold(world);
    const executeRuns = world.lifecycle.audit().execute_runs;
    const calls = world.author.calls.length;
    const recorded = world.runtime.trace().observations;
    const host = new AgentFabricHost({ authority: createGrantAuthority() });
    const result = replay(recorded, {
      host,
      decisionLayer: new FailingDecisionLayer(),
      lifecycle: throwingLifecycle(),
      author: throwingAuthor(),
    });
    assert.equal(result.ok, true, result.ok ? '' : result.failure.reason);
    assert.equal(result.state.goal?.status, 'complete');
    assert.equal(result.state.crystallization.fold?.fold, world.runtime.state().crystallization.fold?.fold);
    assert.equal(host.invocations.length, 0);
    assert.equal(world.lifecycle.audit().execute_runs, executeRuns);
    assert.equal(world.author.calls.length, calls);
  });

  it('M3-T13 a matching output type is composition and does not establish or execute the fold', async () => {
    const world = m3World();
    world.lifecycle.installEstablished(
      { ...FOLD_CONTRACT, id: 'digest.pack', purpose: 'Pack a digest under another operation' },
      foldSource('direct'),
    );
    openFoldGoal(world);
    await driveFold(world, 'admission-requested');
    const search = results(world, 'gap.search')[0];
    assert.equal(search?.outcome.outcome, 'succeeded');
    if (search?.outcome.outcome === 'succeeded') {
      const output = search.outcome.output as { status: string; compositions: readonly string[] };
      assert.equal(output.status, 'composed');
      assert.deepEqual(output.compositions, ['digest.pack']);
    }
    assert.equal(started(world, 'contract.establish').length, 0);
    assert.equal(started(world, 'report.fold').length, 0);
    assert.equal(world.runtime.state().goal?.status, 'active');
    assert.equal(world.host.resolution('report.fold'), 'unresolved');
    assert.equal(world.host.resolution('digest.pack'), 'resolved');
  });

  it('M3-T12 an already admitted fold is reused and does not open a new contract', async () => {
    const world = m3World();
    world.lifecycle.installEstablished(FOLD_CONTRACT, foldSource('direct'));
    openFoldGoal(world);
    await driveFold(world);
    assert.equal(world.runtime.state().goal?.status, 'complete');
    assert.equal(started(world, 'contract.establish').length, 0);
    assert.equal(started(world, 'corpus.propose').length, 0);
    assert.equal(started(world, 'red.demonstrate').length, 0);
    assert.equal(world.author.calls.length, 0);
    const search = results(world, 'gap.search')[0];
    assert.equal(search?.outcome.outcome, 'succeeded');
    if (search?.outcome.outcome === 'succeeded') {
      assert.equal((search.outcome.output as { status: string }).status, 'reusable');
    }
    assert.ok(started(world, 'report.fold')[0]?.grant);
  });
});

function resultSeq(world: M3World, operation: string): number {
  const action_id = started(world, operation)[0]?.action_id;
  assert.ok(action_id);
  const observation = world.runtime.trace().observations.find(
    (item) => item.payload_type === 'action.result' && (item.payload as ActionResultPayload).action_id === action_id,
  );
  assert.ok(observation);
  return observation.seq;
}

function seqOf(world: M3World, action_id: string, payload_type: string): number {
  const observation = world.runtime.trace().observations.find(
    (item) => item.payload_type === payload_type && (item.payload as { action_id?: string }).action_id === action_id,
  );
  assert.ok(observation);
  return observation.seq;
}

function throwingAuthor(): ExtensionAuthor {
  const fail = (): never => {
    throw new Error('author must not be invoked');
  };
  return { implementation: 'boom', variants: [], proposeContract: fail, proposeCases: fail, proposeImplementation: fail };
}

function throwingLifecycle(): CapabilityLifecycle {
  const fail = (): never => {
    throw new Error('lifecycle must not be invoked');
  };
  return {
    search: fail,
    proposeContract: fail,
    submitCases: fail,
    reviseCases: fail,
    validateCorpus: fail,
    demonstrateRed: fail,
    implementerView: fail,
    attachImplementation: fail,
    proveGreen: fail,
    requestAdmission: fail,
    admit: fail,
    revoke: fail,
    reviseContract: fail,
    audit: fail,
  };
}
