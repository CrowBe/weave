/**
 * M0 — inspect and report. Trace assertions M0-T01..T19 and the C3 trace
 * completeness check, transcribed from docs/m0-inspect-and-report.md §11.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  foldState,
  replay,
  stableStringify,
  traceCompletenessViolations,
  type ActionStartedPayload,
  type Observation,
  type Trace,
  type WeightsRecordedPayload,
} from '@weave/weave';
import type { Grant } from '@weave/agentsop';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import {
  ALPHA,
  BETA,
  CONTENT,
  FailingDecisionLayer,
  GAMMA,
  actionIdFor,
  baseGoal,
  candidatesFor,
  cycles,
  inspectCandidate,
  lastCycle,
  observationsOfType,
  release,
  runBaseToCompletion,
  scenario,
  tick,
  type Scenario,
} from './fixture.js';

function startedPayloads(trace: Trace): ActionStartedPayload[] {
  return observationsOfType(trace, 'action.started').map((o) => o.payload as ActionStartedPayload);
}

function resultFor(trace: Trace, action_id: string): Observation | undefined {
  return observationsOfType(trace, 'action.result').find(
    (o) => (o.payload as { action_id: string }).action_id === action_id,
  );
}

function assertComplete(trace: Trace): void {
  assert.deepEqual(traceCompletenessViolations(trace), []);
}

describe('M0 base scenario', () => {
  it('M0-T01 goal opens without acting', () => {
    const s = scenario();
    const opened = s.appended.find((o) => o.payload_type === 'goal.opened');
    assert.ok(opened);
    assert.equal(opened.validation.status, 'accepted');
    const before = foldState(s.runtime.trace().observations.filter((o) => o.seq <= opened.seq));
    assert.equal(before.goal?.goal_id, 'g-report');
    assert.equal(before.goal?.status, 'active');
    assert.deepEqual(Object.keys(before.actions), []);
    assert.deepEqual(before.budget, {
      actions: { limit: 6, reserved: 0, spent: 0 },
      judgments: { limit: 6, reserved: 0, spent: 0 },
    });
  });

  it('M0-T02 both inspections form as candidates', () => {
    const s = scenario();
    const c1 = cycles(s)[0];
    assert.ok(c1);
    assert.equal(c1.cycle_no, 1);
    assert.equal(c1.procedure, 'inspect_and_report@1');
    assert.equal(c1.candidates.length, 2);
    for (const source of [ALPHA, BETA]) {
      const candidate = inspectCandidate(c1, source);
      assert.ok(candidate, `candidate for ${source}`);
      assert.equal(candidate.contract_rev, 'r1');
      assert.deepEqual(candidate.eligibility, { status: 'allowed' });
      assert.deepEqual(candidate.read_set, [{ resource: source, revision: 1 }]);
      assert.deepEqual(candidate.effects, [{ resource: source, mode: 'read' }]);
      assert.deepEqual(candidate.resources, { actions: 1, judgments: 0 });
    }
    assert.equal(candidatesFor(c1, 'report.assemble').length, 0);
  });

  it('M0-T03 weights are an observation', () => {
    const s = scenario();
    const c1 = cycles(s)[0];
    assert.ok(c1);
    assert.notEqual(c1.weights_ref, null);
    const weights = s.runtime.trace().observations.find((o) => o.seq === c1.weights_ref);
    assert.ok(weights);
    assert.equal(weights.payload_type, 'weights.recorded');
    assert.equal(weights.source.kind, 'judgment');
    assert.equal(weights.validation.status, 'accepted');
    const payload = weights.payload as WeightsRecordedPayload;
    assert.equal(payload.site, 'frontier.weigh');
    assert.equal(payload.implementation, 'scripted@1');
    assert.equal(payload.state_revision, c1.state_revision);
    assert.equal(payload.weights.length, 2);
    for (const candidate of c1.candidates) {
      assert.equal(candidate.weight, 0.8);
    }
    // The reservation is spent by the recorded observation: one unit went reserved -> spent.
    assert.deepEqual(s.runtime.state().budget.judgments, { limit: 6, reserved: 0, spent: 1 });
  });

  it('M0-T04 independent reads dispatch together', () => {
    const s = scenario();
    const c1 = cycles(s)[0];
    assert.ok(c1);
    assert.equal(c1.selected.length, 2);
    assert.deepEqual(c1.not_selected, []);
    assert.deepEqual(c1.outcome, { status: 'dispatched' });
    const started = startedPayloads(s.runtime.trace());
    assert.equal(started.length, 2);
    assert.notEqual(started[0]?.action_id, started[1]?.action_id);
    assert.equal(
      started.reduce((sum, p) => sum + p.reservation.actions, 0),
      2,
    );
    assert.deepEqual(s.runtime.state().budget.actions, { limit: 6, reserved: 2, spent: 0 });
  });

  it('M0-T05 independent reads run concurrently', () => {
    const s = scenario();
    assert.equal(s.host.openCount(), 2);
    const state = s.runtime.state();
    const records = Object.values(state.actions);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.state, 'running');
      assert.notEqual(record.started_at, null);
      assert.equal(record.finished_at, null);
      assert.ok(record.grant, 'capability invocation carries a grant');
    }
    assert.equal(observationsOfType(s.runtime.trace(), 'action.result').length, 0);
  });

  it('M0-T06 results integrate in arrival order', async () => {
    const s = scenario();
    const c1 = cycles(s)[0];
    assert.ok(c1);
    const betaAction = actionIdFor(c1, inspectCandidate(c1, BETA)!.candidate_id);
    const alphaAction = actionIdFor(c1, inspectCandidate(c1, ALPHA)!.candidate_id);

    await release(s, betaAction);
    assert.equal(cycles(s).length, 2);
    const c2 = cycles(s)[1];
    assert.ok(c2);
    assert.equal(candidatesFor(c2, 'report.assemble').length, 0);
    assert.deepEqual(c2.outcome, { status: 'waiting' });
    const betaResult = resultFor(s.runtime.trace(), betaAction);
    assert.ok(betaResult);
    assert.equal(s.runtime.state().inspections[BETA]?.evidence, betaResult.seq);
    assert.equal(s.runtime.state().inspections[ALPHA], undefined);

    await release(s, alphaAction);
    const alphaResult = resultFor(s.runtime.trace(), alphaAction);
    assert.ok(alphaResult);
    assert.ok(betaResult.seq < alphaResult.seq);
    assert.equal(s.runtime.state().inspections[ALPHA]?.evidence, alphaResult.seq);
  });

  it('M0-T07 assembly depends on all inspections', async () => {
    const s = scenario();
    const c1 = cycles(s)[0];
    assert.ok(c1);
    const betaAction = actionIdFor(c1, inspectCandidate(c1, BETA)!.candidate_id);
    const alphaAction = actionIdFor(c1, inspectCandidate(c1, ALPHA)!.candidate_id);
    await release(s, betaAction);
    await release(s, alphaAction);

    const c3 = lastCycle(s);
    assert.equal(c3.cycle_no, 3);
    assert.equal(c3.candidates.length, 1);
    const assemble = candidatesFor(c3, 'report.assemble')[0];
    assert.ok(assemble);
    assert.equal(assemble.contract_rev, 'r1');
    const inputs = assemble.inputs as { inspections: { source: string }[] };
    assert.deepEqual(
      inputs.inspections.map((i) => i.source),
      [ALPHA, BETA],
    );
    assert.deepEqual(assemble.read_set, [
      { resource: ALPHA, revision: 1 },
      { resource: BETA, revision: 1 },
    ]);
    assert.deepEqual(assemble.effects, []);
    assert.deepEqual([...assemble.dependencies].sort(), [alphaAction, betaAction].sort());
    assert.equal(assemble.weight, 0.9);
    assert.equal(c3.selected.length, 1);
    assert.equal(c3.selected[0]?.candidate_id, assemble.candidate_id);
    assert.deepEqual(c3.outcome, { status: 'dispatched' });
    assert.equal(s.host.openCount(), 1);
  });

  it('M0-T08 report carries evidence', async () => {
    const s = scenario();
    const c1 = cycles(s)[0];
    assert.ok(c1);
    const betaAction = actionIdFor(c1, inspectCandidate(c1, BETA)!.candidate_id);
    const alphaAction = actionIdFor(c1, inspectCandidate(c1, ALPHA)!.candidate_id);
    await release(s, betaAction);
    await release(s, alphaAction);
    const c3 = lastCycle(s);
    const assemble = candidatesFor(c3, 'report.assemble')[0];
    assert.ok(assemble);
    const assembleAction = actionIdFor(c3, assemble.candidate_id);
    await release(s, assembleAction);

    const trace = s.runtime.trace();
    const report = s.runtime.state().report;
    assert.ok(report);
    assert.deepEqual(report.report.read_set, assemble.read_set);
    assert.equal(report.report.entries.length, 2);
    const expectedEvidence = [betaAction, alphaAction, assembleAction].map((id) => resultFor(trace, id)!.seq);
    assert.deepEqual([...report.evidence].sort(), expectedEvidence.sort());
  });

  it('M0-T09 completion needs success evidence', async () => {
    const s = scenario();
    const trace = await runBaseToCompletion(s);
    const final = lastCycle(s);
    assert.equal(final.cycle_no, 4);
    const complete = candidatesFor(final, 'goal.complete')[0];
    assert.ok(complete);
    assert.equal(complete.contract_rev, null);
    assert.equal(complete.weight, 1.0);
    assert.equal(final.selected.length, 1);
    const completeAction = actionIdFor(final, complete.candidate_id);
    const result = resultFor(trace, completeAction);
    assert.ok(result);
    assert.equal(result.source.kind, 'runtime');
    assert.equal((result.payload as { outcome: { outcome: string } }).outcome.outcome, 'succeeded');
    assert.equal(s.runtime.state().goal?.status, 'complete');
    assert.deepEqual(final.outcome, { status: 'complete' });
    assert.deepEqual(s.runtime.state().budget, {
      actions: { limit: 6, reserved: 0, spent: 4 },
      judgments: { limit: 6, reserved: 0, spent: 3 },
    });
    assert.equal(s.host.invocations.length, 3);
    assertComplete(trace);
  });

  it('M0-T10 the trace is deterministic', async () => {
    const realNow = Date.now;
    const run = async (clock: number): Promise<string> => {
      Date.now = () => clock;
      try {
        const s = scenario();
        return stableStringify(await runBaseToCompletion(s));
      } finally {
        Date.now = realNow;
      }
    };
    const first = await run(1_000);
    const second = await run(9_999_999_999);
    assert.equal(first, second);
  });
});

describe('M0 authority', () => {
  it('M0-T11 a claimed completion is not completion', () => {
    const control = scenario();
    control.observe(tick(1));

    const s = scenario();
    const before = s.runtime.state();
    const cyclesBefore = cycles(s).length;
    const claim = s.observe({
      observation_id: 'test:goal.completed:forged',
      source: { kind: 'test', id: 'm0-fixture' },
      caused_by: null,
      payload_type: 'goal.completed',
      payload_version: 1,
      payload: { goal_id: 'g-report', status: 'complete' },
    });
    assert.deepEqual(claim.validation, { status: 'unknown_type' });
    assert.ok(s.runtime.trace().observations.some((o) => o.seq === claim.seq), 'retained in the log');
    assert.equal(s.runtime.state().state_revision, before.state_revision);
    assert.equal(s.runtime.state().goal?.status, 'active');
    assert.equal(cycles(s).length, cyclesBefore, 'a non-accepted observation triggers no cycle');

    s.observe(tick(1));
    const next = lastCycle(s);
    const controlNext = lastCycle(control);
    assert.equal(next.cycle_no, controlNext.cycle_no);
    assert.equal(stableStringify(next.candidates), stableStringify(controlNext.candidates));
    assert.deepEqual(next.outcome, controlNext.outcome);
    assert.equal(s.runtime.state().goal?.status, 'active');
  });

  it('M0-T12 prohibited access is excluded before weighing', () => {
    const s = scenario({
      goal: baseGoal({ sources: [ALPHA, BETA, GAMMA], authority: { read: [ALPHA, BETA] } }),
    });
    const c1 = cycles(s)[0];
    assert.ok(c1);
    assert.equal(c1.candidates.length, 3);
    const gamma = inspectCandidate(c1, GAMMA);
    assert.ok(gamma);
    assert.equal(gamma.eligibility.status, 'prohibited');
    assert.equal(gamma.weight, null);
    const weights = s.runtime.trace().observations.find((o) => o.seq === c1.weights_ref);
    assert.ok(weights);
    const weighed = (weights.payload as WeightsRecordedPayload).weights.map((w) => w.candidate_id).sort();
    assert.deepEqual(
      weighed,
      [inspectCandidate(c1, ALPHA)!.candidate_id, inspectCandidate(c1, BETA)!.candidate_id].sort(),
    );
    for (const started of startedPayloads(s.runtime.trace())) {
      assert.notEqual((started.inputs as { source: string }).source, GAMMA);
    }
    assert.ok(c1.candidates.every((c) => c.eligibility.status !== 'approval_required'));
    assert.deepEqual(c1.outcome, { status: 'dispatched' });
  });

  it('M0-T13 prohibition blocks honestly', async () => {
    const s = scenario({
      goal: baseGoal({ sources: [ALPHA, BETA, GAMMA], authority: { read: [ALPHA, BETA] } }),
    });
    const c1 = cycles(s)[0];
    assert.ok(c1);
    await release(s, actionIdFor(c1, inspectCandidate(c1, ALPHA)!.candidate_id));
    await release(s, actionIdFor(c1, inspectCandidate(c1, BETA)!.candidate_id));
    const last = lastCycle(s);
    assert.equal(candidatesFor(last, 'report.assemble').length, 0);
    assert.equal(last.outcome.status, 'blocked');
    assert.match((last.outcome as { reason: string }).reason, /source:gamma/);
    assert.equal(last.weights_ref, null, 'no eligible candidate, so nothing was weighed');
    assert.equal(s.runtime.state().goal?.status, 'active');
    for (const cycle of cycles(s)) {
      assert.ok(cycle.candidates.every((c) => c.eligibility.status !== 'approval_required'));
    }
    assert.equal(s.host.openCount(), 0);
    assertComplete(s.runtime.trace());
  });

  it('M0-T14 the host rejects an ungranted invocation', () => {
    const s = scenario();
    const c1 = cycles(s)[0];
    assert.ok(c1);
    const alphaAction = actionIdFor(c1, inspectCandidate(c1, ALPHA)!.candidate_id);
    const grantForAlpha = s.runtime.state().actions[alphaAction]?.grant as Grant;
    assert.ok(grantForAlpha);
    const invocationsBefore = s.host.invocations.length;
    const rejectionsBefore = s.host.rejections.length;

    const first = s.host.invoke(null, 'source.inspect', { source: GAMMA });
    const second = s.host.invoke(grantForAlpha, 'source.inspect', { source: GAMMA });
    assert.equal(first.kind, 'rejected');
    assert.equal(second.kind, 'rejected');
    assert.equal((first as { code: string }).code, 'DENIED');
    assert.equal((second as { code: string }).code, 'DENIED');
    assert.equal(s.host.rejections.length - rejectionsBefore, 2);
    assert.equal(s.host.invocations.length, invocationsBefore);
  });
});

describe('M0 budget', () => {
  it('M0-T15 actions are reserved before dispatch', async () => {
    const s = scenario({ goal: baseGoal({ budget: { actions: 2, judgments: 6 } }) });
    const c1 = cycles(s)[0];
    assert.ok(c1);
    assert.equal(c1.selected.length, 2);
    assert.deepEqual(s.runtime.state().budget.actions, { limit: 2, reserved: 2, spent: 0 });
    for (const id of s.host.openActionIds()) {
      await release(s, id);
    }
    assert.deepEqual(s.runtime.state().budget.actions, { limit: 2, reserved: 0, spent: 2 });
    const last = lastCycle(s);
    const assemble = candidatesFor(last, 'report.assemble')[0];
    assert.ok(assemble);
    assert.deepEqual(assemble.eligibility, { status: 'allowed' });
    assert.deepEqual(last.selected, []);
    assert.deepEqual(last.not_selected, [{ candidate_id: assemble.candidate_id, reason: 'budget' }]);
    assert.deepEqual(last.outcome, { status: 'blocked', reason: 'actions budget exhausted' });
    assert.equal(s.host.openCount(), 0);
  });

  it('M0-T16 no judgment budget means no dispatch', () => {
    const s = scenario({ goal: baseGoal({ budget: { actions: 6, judgments: 0 } }) });
    const c1 = cycles(s)[0];
    assert.ok(c1);
    assert.equal(c1.candidates.length, 2);
    assert.ok(c1.candidates.every((c) => c.eligibility.status === 'allowed'));
    assert.ok(c1.candidates.every((c) => c.weight === null));
    assert.equal(c1.weights_ref, null);
    assert.deepEqual(c1.selected, []);
    assert.deepEqual(c1.outcome, { status: 'blocked', reason: 'judgments budget exhausted' });
    assert.equal(observationsOfType(s.runtime.trace(), 'action.started').length, 0);
    assert.equal(observationsOfType(s.runtime.trace(), 'weights.recorded').length, 0);
    assert.equal(s.host.invocations.length, 0);
  });
});

describe('M0 malformed input', () => {
  it('M0-T17 malformed observations cannot transition', () => {
    const control = scenario();
    control.observe(tick(1));

    const s = scenario();
    const sourcesBefore = stableStringify(s.runtime.state().sources);
    const revisionBefore = s.runtime.state().state_revision;
    const malformed = s.observe({
      observation_id: 'test:source.changed:malformed',
      source: { kind: 'test', id: 'm0-fixture' },
      caused_by: null,
      payload_type: 'source.changed',
      payload_version: 1,
      payload: { resource: ALPHA, content: 'changed without a revision' },
    });
    assert.equal(malformed.validation.status, 'rejected');
    assert.ok(s.runtime.trace().observations.some((o) => o.seq === malformed.seq), 'retained in the log');
    assert.equal(stableStringify(s.runtime.state().sources), sourcesBefore);
    assert.equal(s.runtime.state().state_revision, revisionBefore);

    s.observe(tick(1));
    const next = lastCycle(s);
    const controlNext = lastCycle(control);
    assert.equal(stableStringify(next.candidates), stableStringify(controlNext.candidates));
    assert.deepEqual(next.outcome, controlNext.outcome);
  });
});

describe('M0 replay', () => {
  async function completedLog(): Promise<{ live: Scenario; trace: Trace }> {
    const live = scenario();
    const trace = await runBaseToCompletion(live);
    return { live, trace };
  }

  it('M0-T18 replay reproduces the trace without executing', async () => {
    const { trace } = await completedLog();
    const freshHost = new FakeHost(new FixtureEnvironment());
    const result = replay(trace.observations, { host: freshHost, decisionLayer: new FailingDecisionLayer() });
    assert.equal(result.ok, true);
    assert.equal(stableStringify(result.trace.cycles), stableStringify(trace.cycles));
    assert.equal(stableStringify(result.trace.observations), stableStringify(trace.observations));
    assert.equal(freshHost.invocations.length, 0);
    assert.equal(freshHost.rejections.length, 0);
    assert.equal(result.state.goal?.status, 'complete');
    assertComplete(result.trace);
  });

  it('M0-T19 replay fails closed on missing results', async () => {
    const { trace } = await completedLog();
    const results = observationsOfType(trace, 'action.result');
    const finalResult = results[results.length - 1];
    assert.ok(finalResult);
    const missingAction = (finalResult.payload as { action_id: string }).action_id;
    const truncated = trace.observations.filter((o) => o.seq !== finalResult.seq);

    const freshHost = new FakeHost(new FixtureEnvironment());
    const result = replay(truncated, { host: freshHost, decisionLayer: new FailingDecisionLayer() });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.failure.action_id, missingAction);
    assert.match(result.failure.reason, /missing recorded/);
    assert.equal(freshHost.invocations.length, 0);
    assert.equal(resultFor(result.trace, missingAction), undefined, 'no synthetic result is recorded');
    assert.notEqual(result.state.goal?.status, 'complete');
  });
});

describe('M0 structural', () => {
  it('M0-C3 every action.started is explained by exactly one cycle record', async () => {
    const s = scenario();
    const trace = await runBaseToCompletion(s);
    assertComplete(trace);
    assert.equal(observationsOfType(trace, 'action.started').length, 4);

    // A trace with an orphan start must be reported.
    const orphan: Observation = {
      ...observationsOfType(trace, 'action.started')[0]!,
      seq: 999,
      payload: { ...(observationsOfType(trace, 'action.started')[0]!.payload as object), action_id: 'a:9:9' },
    };
    const broken: Trace = { observations: [...trace.observations, orphan], cycles: trace.cycles };
    assert.ok(traceCompletenessViolations(broken).length > 0);
  });

  it('fixture sources have the documented shape', () => {
    assert.equal(CONTENT[ALPHA]!.split('\n').length, 3);
    assert.equal(CONTENT[BETA]!.split('\n').length, 5);
    assert.equal(CONTENT[GAMMA]!.split('\n').length, 1);
  });
});
