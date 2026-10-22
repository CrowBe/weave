/**
 * `frontier.weigh@1`: one typed judgment site, end to end
 * (packages/weave/src/FRONTIER-WEIGH-CONTRACT.md §8, FW-T01..FW-T07).
 *
 * The fixture judge stands in for a routed unit. It is not evidence about any
 * model; it proves the wiring and the control boundary only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvaluationAdapter, EvaluationCall, EvaluationProviderResult, EvaluationQuestion } from '@weave/gateway';
import {
  candidateSetDigest,
  FRONTIER_WEIGH_CONTRACT,
  FRONTIER_WEIGH_CRITERIA,
  fixtureGateway,
  frontierWeighInstructions,
  GatewayDecisionLayer,
  LOCAL_DESTINATION,
  MemoryJournal,
  replay,
  Runtime,
  ScriptedDecisionLayer,
  traceCompletenessViolations,
  type CycleRecord,
  type DecisionLayer,
  type Goal,
  type InferenceRequestedPayload,
  type Observation,
  type StateView,
  type WeightsRecordedPayload,
} from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import { changed, goalOpened, lastCycle, observationsOfType, registered, tick, type Scenario } from './fixture.js';
import {
  ALPHA,
  BETA,
  bindingJson,
  completedText,
  CONTENT,
  GAMMA,
  generateAdapter,
  scoreAnswers,
  variantGoal,
} from './m2-fixture.js';

const DELTA = 'source:delta';
const DEFERRED_REASON = 'frontier deferred by frontier.weigh@1 weights';

type Judge = (call: EvaluationCall) => EvaluationProviderResult;

interface ViewCandidate {
  readonly candidate_id: string;
  readonly operation: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

interface WeighContent {
  readonly goal?: { readonly sources?: readonly string[] };
  readonly candidates: readonly ViewCandidate[];
}

/** Defers an inspect of a source the goal does not list; dispatches everything else. */
const goalJudge: Judge = (call) => {
  const content = call.state as unknown as WeighContent;
  const sources = content.goal?.sources ?? [];
  const scores: Record<string, number> = {};
  for (const id of Object.keys(call.questions)) {
    const candidate = content.candidates.find((c) => c.candidate_id === id);
    const source = candidate?.inputs['source'];
    scores[id] =
      candidate?.operation === 'source.inspect' && typeof source === 'string' && !sources.includes(source) ? 0 : 2;
  }
  return scoreAnswers(scores);
};

const constantJudge =
  (score: number): Judge =>
  (call) =>
    scoreAnswers(Object.fromEntries(Object.keys(call.questions).map((id) => [id, score])));

function recordingAdapter(judge: Judge, calls: EvaluationCall[], held?: Promise<void>): EvaluationAdapter {
  return {
    id: 'fixture.evaluate',
    async evaluate(call) {
      calls.push(call);
      if (held) {
        await held;
      }
      return judge(call);
    },
  };
}

interface FwScenario extends Scenario {
  readonly calls: EvaluationCall[];
}

function fwGoal(overrides: Partial<Goal> = {}): Goal {
  return variantGoal({
    authority: { read: [ALPHA, BETA, DELTA] },
    budget: { actions: 5, judgments: 24, cost: 1_000_000 },
    ...overrides,
  });
}

function fwScenario(
  options: {
    goal?: Goal;
    judge?: Judge;
    held?: Promise<void>;
    decisionLayer?: DecisionLayer;
    proposal?: readonly string[];
    journal?: MemoryJournal;
    /** Recover from this journal snapshot instead of opening a fresh run. */
    recorded?: readonly Observation[];
  } = {},
): FwScenario {
  const environment = new FixtureEnvironment();
  const host = new FakeHost(environment);
  const generate = generateAdapter('fixture.generate', [
    completedText(bindingJson(options.proposal ?? [ALPHA, BETA, DELTA])),
  ]);
  const calls: EvaluationCall[] = [];
  let runtime!: Runtime;
  const clock = { now: () => runtime.state().clock.tick };
  const evaluate = options.judge ? recordingAdapter(options.judge, calls, options.held) : undefined;
  const gateway = fixtureGateway({ clock, generate, ...(evaluate ? { evaluate } : {}) });
  const decisionLayer =
    options.decisionLayer ??
    (evaluate ? new GatewayDecisionLayer(gateway, [LOCAL_DESTINATION]) : new ScriptedDecisionLayer());
  const runtimeOptions = { host, decisionLayer, gateway, ...(options.journal ? { journal: options.journal } : {}) };
  runtime = new Runtime(runtimeOptions);
  if (options.recorded) {
    // recover(), with the runtime bound first: reconcile may weigh, and the gateway clock reads it.
    runtime.load(options.recorded);
    runtime.reconcile();
  }
  const appended: Observation[] = [];
  const s: FwScenario = {
    environment,
    host,
    decisionLayer,
    runtime,
    appended,
    calls,
    observe(input) {
      const observation = runtime.observe(input);
      appended.push(observation);
      return observation;
    },
  };
  const sources: [string, string][] = [
    [ALPHA, CONTENT[ALPHA] as string],
    [BETA, CONTENT[BETA] as string],
    [GAMMA, CONTENT[GAMMA] as string],
    [DELTA, 'delta one\ndelta two'],
  ];
  for (const [resource, content] of sources) {
    environment.register(resource, content);
    if (!options.recorded) {
      s.observe(registered(resource, content));
    }
  }
  if (options.recorded) {
    return s;
  }
  runtime.operator.submit(goalOpened(options.goal ?? fwGoal()));
  return s;
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Release host work and let gateway promises land until the log stops growing. */
async function drive(s: FwScenario, rounds = 80): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < rounds && stable < 3; i += 1) {
    await macrotask();
    for (const id of s.host.openActionIds()) {
      s.host.release(id);
      await s.runtime.settle(id);
    }
    const length = s.runtime.trace().observations.length;
    stable = length === last && s.host.openActionIds().length === 0 ? stable + 1 : 0;
    last = length;
  }
}

function weighRequests(s: Scenario): Observation[] {
  return observationsOfType(s.runtime.trace(), 'inference.requested').filter(
    (o) => (o.payload as InferenceRequestedPayload).site === 'frontier.weigh',
  );
}

function started(s: Scenario): { operation: string; source?: string }[] {
  return observationsOfType(s.runtime.trace(), 'action.started').map((o) => {
    const payload = o.payload as { operation: string; inputs: { source?: string } };
    return { operation: payload.operation, ...(payload.inputs.source ? { source: payload.inputs.source } : {}) };
  });
}

function candidateFor(cycle: CycleRecord, id: string) {
  return cycle.candidates.find((c) => c.candidate_id === id);
}

function deltaCandidateIds(s: Scenario): Set<string> {
  const ids = new Set<string>();
  for (const cycle of s.runtime.trace().cycles) {
    for (const candidate of cycle.candidates) {
      if (candidate.operation === 'source.inspect' && (candidate.inputs as { source: string }).source === DELTA) {
        ids.add(candidate.candidate_id);
      }
    }
  }
  return ids;
}

describe('frontier.weigh@1', () => {
  it('FW-T01 each recorded weight names its contract, state view and candidate set', async () => {
    const s = fwScenario({ judge: goalJudge });
    await drive(s);
    const trace = s.runtime.trace();
    const weights = observationsOfType(trace, 'weights.recorded').filter((o) => o.validation.status === 'accepted');
    assert.ok(weights.length >= 3, 'expected several accepted weighings');
    for (const observation of weights) {
      const payload = observation.payload as WeightsRecordedPayload;
      assert.equal(payload.contract, FRONTIER_WEIGH_CONTRACT);
      const requested = weighRequests(s).find(
        (o) => (o.payload as InferenceRequestedPayload).request_id === payload.request_id,
      );
      assert.ok(requested, `no inference.requested for ${payload.request_id}`);
      const request = requested.payload as InferenceRequestedPayload;
      assert.equal(payload.state_revision, requested.seq);
      assert.equal(payload.candidate_set, request.candidate_set);
      const view = request.view as StateView;
      assert.equal(view.profile, 'profile.frontier-weigh@2');
      assert.equal(view.profile_version, 2);
      assert.ok(view.state_revision < requested.seq);
      assert.deepEqual(
        view.manifest.slices.map((slice) => slice.name),
        ['goal', 'budget', 'progress', 'candidates'],
      );
      const content = view.content as WeighContent;
      const ids = content.candidates.map((c) => c.candidate_id);
      assert.equal(candidateSetDigest(ids), payload.candidate_set);
      assert.deepEqual(payload.weights.map((w) => w.candidate_id).sort(), [...ids].sort());
      assert.ok(payload.weights.every((w) => w.weight >= 0 && w.weight <= 2));
      const call = s.calls.find((c) => JSON.stringify(c.state) === JSON.stringify(view.content));
      assert.ok(call, 'the gateway received exactly the recorded view content');
      assert.deepEqual(Object.keys(call.questions).sort(), [...ids].sort());
      for (const id of ids) {
        const question: EvaluationQuestion | undefined = call.questions[id];
        assert.ok(question && question.type === 'score');
        assert.equal(question.instructions, frontierWeighInstructions(id));
        assert.deepEqual(question.criteria, FRONTIER_WEIGH_CRITERIA);
      }
      const encoded = JSON.stringify(view.content);
      assert.equal(encoded.includes('gamma one'), false);
      assert.equal(encoded.includes(GAMMA), false);
      const progress = view.manifest.slices.find((slice) => slice.name === 'progress');
      assert.ok(progress?.omitted.some((item) => item.name === GAMMA && item.reason === 'authority'));
      assert.ok(progress?.omitted.some((item) => item.name === DELTA && item.reason === 'profile'));
    }
  });

  it('FW-T02 Weave selects the frontier from typed weights; the scripted baseline wastes the budget', async () => {
    const weighed = fwScenario({ judge: goalJudge });
    await drive(weighed);
    assert.equal(weighed.runtime.state().goal?.status, 'complete');
    assert.equal(
      started(weighed).some((a) => a.source === DELTA),
      false,
    );
    const deltaIds = deltaCandidateIds(weighed);
    assert.ok(deltaIds.size > 0, 'the proposal formed an inspect of delta');
    assert.ok(
      weighed.runtime
        .trace()
        .cycles.some((cycle) =>
          cycle.not_selected.some((entry) => deltaIds.has(entry.candidate_id) && entry.reason === 'deferred'),
        ),
    );
    for (const cycle of weighed.runtime.trace().cycles) {
      if (cycle.selected.length === 0) {
        continue;
      }
      const ref = weighed.runtime.trace().observations.find((o) => o.seq === cycle.weights_ref);
      assert.equal((ref?.payload as WeightsRecordedPayload | undefined)?.contract, FRONTIER_WEIGH_CONTRACT);
      for (const sel of cycle.selected) {
        assert.equal(candidateFor(cycle, sel.candidate_id)?.eligibility.status, 'allowed');
      }
    }
    assert.deepEqual(traceCompletenessViolations(weighed.runtime.trace()), []);

    const scripted = fwScenario();
    await drive(scripted);
    assert.equal(
      started(scripted).some((a) => a.source === DELTA),
      true,
    );
    assert.equal(scripted.runtime.state().goal?.status, 'active');
    assert.deepEqual(lastCycle(scripted).outcome, { status: 'blocked', reason: 'actions budget exhausted' });
  });

  it('FW-T03 a frontier deferred by every weight stays blocked until new evidence arrives', async () => {
    const s = fwScenario({ judge: constantJudge(0) });
    await drive(s);
    assert.deepEqual(started(s), []);
    assert.deepEqual(lastCycle(s).outcome, { status: 'blocked', reason: DEFERRED_REASON });
    assert.ok(
      s.runtime.trace().cycles.some((cycle) => cycle.not_selected.some((entry) => entry.reason === 'deferred')),
    );
    assert.equal(weighRequests(s).length, 1);
    assert.equal(s.runtime.state().goal?.status, 'active');
    assert.equal(s.runtime.state().budget.judgments.spent, 1);

    s.runtime.clock.submit(tick(1));
    await drive(s);
    assert.equal(weighRequests(s).length, 1, 'a clock tick is not new evidence');

    s.observe(changed(ALPHA, 2, 'alpha revised'));
    await drive(s);
    assert.equal(weighRequests(s).length, 2, 'new evidence earns one more weighing');
    assert.deepEqual(lastCycle(s).outcome, { status: 'blocked', reason: DEFERRED_REASON });
    assert.deepEqual(started(s), []);
  });

  it('FW-T04 out-of-range weights are unusable and leave an explicit blocked outcome', async () => {
    const s = fwScenario({ judge: constantJudge(7) });
    await drive(s);
    assert.deepEqual(started(s), []);
    const accepted = observationsOfType(s.runtime.trace(), 'weights.recorded').filter(
      (o) => o.validation.status === 'accepted',
    );
    assert.equal(accepted.length, 0);
    assert.equal(weighRequests(s).length, 1);
    const outcome = lastCycle(s).outcome;
    assert.equal(outcome.status, 'blocked');
    assert.ok(outcome.status === 'blocked' && outcome.reason.length > 0);
    assert.equal(s.runtime.state().goal?.status, 'active');
  });

  it('FW-T05 a late weight is stale and authorizes nothing', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = fwScenario({ judge: goalJudge, held });
    await macrotask();
    assert.equal(s.calls.length, 1);
    s.runtime.clock.submit(tick(2));
    release();
    await drive(s);
    const weights = observationsOfType(s.runtime.trace(), 'weights.recorded');
    assert.equal(weights.length, 1);
    assert.equal(weights[0]?.validation.status, 'rejected');
    assert.equal((weights[0]?.payload as WeightsRecordedPayload).contract, FRONTIER_WEIGH_CONTRACT);
    assert.deepEqual(started(s), []);
    assert.deepEqual(lastCycle(s).outcome, { status: 'blocked', reason: 'stale judgment' });
  });

  it('FW-T06 weights cannot create candidates, leave their range, pass policy or reach a prohibited candidate', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = fwScenario({ judge: constantJudge(2), held });
    await macrotask();
    const frame = lastCycle(s).candidates.find((c) => c.operation === 'goal.frame');
    assert.ok(frame);
    const forgedIds = [frame.candidate_id, 'source.inspect#forged000000'];
    const forged = s.runtime.gatewayIngress.submit({
      observation_id: 'forged:weights:1',
      caused_by: null,
      payload_type: 'weights.recorded',
      payload_version: 1,
      payload: {
        site: 'frontier.weigh',
        implementation: 'forged',
        state_revision: s.runtime.state().state_revision,
        candidate_set: candidateSetDigest(forgedIds),
        weights: forgedIds.map((candidate_id) => ({ candidate_id, weight: 2 })),
        contract: FRONTIER_WEIGH_CONTRACT,
      },
    });
    assert.equal(forged.validation.status, 'accepted');
    assert.equal(lastCycle(s).weights_ref, null);
    const outOfRange = s.runtime.gatewayIngress.submit({
      observation_id: 'forged:weights:2',
      caused_by: null,
      payload_type: 'weights.recorded',
      payload_version: 1,
      payload: {
        site: 'frontier.weigh',
        implementation: 'forged',
        state_revision: s.runtime.state().state_revision,
        candidate_set: candidateSetDigest([frame.candidate_id]),
        weights: [{ candidate_id: frame.candidate_id, weight: 9 }],
        contract: FRONTIER_WEIGH_CONTRACT,
      },
    });
    assert.equal(outOfRange.validation.status, 'rejected');
    assert.deepEqual(started(s), []);
    release();
    await drive(s);

    // Budget: every candidate weighed `dispatch`, one action left after framing.
    const tight = fwScenario({
      judge: constantJudge(2),
      proposal: [ALPHA, BETA],
      goal: fwGoal({ budget: { actions: 2, judgments: 8, cost: 1_000_000 } }),
    });
    await drive(tight);
    const inspectCycle = tight.runtime
      .trace()
      .cycles.find(
        (cycle) =>
          cycle.candidates.filter((c) => c.operation === 'source.inspect').length === 2 && cycle.weights_ref !== null,
      );
    assert.ok(inspectCycle);
    assert.equal(inspectCycle.selected.length, 1);
    assert.deepEqual(
      inspectCycle.not_selected.map((entry) => entry.reason),
      ['budget'],
    );

    // Prohibited: gamma is a goal source without read authority. It is never weighed or dispatched.
    const prohibited = fwScenario({
      judge: constantJudge(2),
      goal: fwGoal({ framing: false, sources: [ALPHA, BETA, GAMMA], authority: { read: [ALPHA, BETA] } }),
    });
    await drive(prohibited);
    const first = prohibited.runtime.trace().cycles[0];
    const gammaCandidate = first?.candidates.find((c) => (c.inputs as { source?: string }).source === GAMMA);
    assert.equal(gammaCandidate?.eligibility.status, 'prohibited');
    const request = weighRequests(prohibited)[0]?.payload as InferenceRequestedPayload | undefined;
    assert.ok(request);
    const view = request.view as StateView;
    assert.equal(JSON.stringify(view.content).includes(GAMMA), false);
    const candidatesSlice = view.manifest.slices.find((slice) => slice.name === 'candidates');
    assert.ok(
      candidatesSlice?.omitted.some(
        (item) => item.name === gammaCandidate?.candidate_id && item.reason === 'prohibited',
      ),
    );
    assert.ok(prohibited.calls.every((call) => !Object.keys(call.questions).includes(gammaCandidate!.candidate_id)));
    assert.equal(
      started(prohibited).some((a) => a.source === GAMMA),
      false,
    );
  });

  it('FW-T07 replay reproduces the weighed run from recorded observations without the site', async () => {
    const s = fwScenario({ judge: goalJudge });
    await drive(s);
    assert.equal(s.runtime.state().goal?.status, 'complete');
    const host = new FakeHost(new FixtureEnvironment());
    const guard: DecisionLayer = {
      implementation: 'replay-guard@1',
      async: true,
      weigh() {
        throw new Error('the judgment site must not be invoked in replay');
      },
    };
    const result = replay(s.runtime.trace().observations, { host, decisionLayer: guard });
    assert.equal(result.ok, true, result.ok ? '' : result.failure.reason);
    assert.equal(host.invocations.length, 0);
    assert.equal(JSON.stringify(result.trace.cycles), JSON.stringify(s.runtime.trace().cycles));
    assert.equal(result.state.goal?.status, 'complete');
  });

  it('FW-T08 a crash mid-weighing frees the in-flight slot on recovery instead of wedging the frontier', async () => {
    const journal = new MemoryJournal();
    const s = fwScenario({ judge: goalJudge, held: new Promise<void>(() => {}), journal });
    await macrotask();
    assert.equal(s.calls.length, 1);
    const [abandoned] = weighRequests(s);
    assert.ok(abandoned);
    const request_id = (abandoned.payload as InferenceRequestedPayload).request_id;
    assert.deepEqual(lastCycle(s).outcome, { status: 'waiting' });

    const r = fwScenario({ judge: goalJudge, recorded: journal.snapshot() });
    await drive(r);
    const recorded = observationsOfType(r.runtime.trace(), 'inference.recorded').filter(
      (o) => (o.payload as { request_id: string }).request_id === request_id,
    );
    assert.equal(recorded.length, 1, 'recovery records the abandoned weighing as an observation');
    assert.equal(recorded[0]?.validation.status, 'accepted');
    assert.equal((recorded[0]?.payload as { status: string }).status, 'unaccepted');
    const candidate_set = (abandoned.payload as InferenceRequestedPayload).candidate_set;
    const sameSet = weighRequests(r).filter(
      (o) => (o.payload as InferenceRequestedPayload).candidate_set === candidate_set,
    );
    assert.equal(sameSet.length, 2, 'one fresh weighing of the abandoned frontier, not a wedge');
    let open: string | null = null;
    for (const o of r.runtime.trace().observations) {
      const id = (o.payload as { request_id?: string }).request_id;
      if (
        o.payload_type === 'inference.requested' &&
        (o.payload as InferenceRequestedPayload).site === 'frontier.weigh'
      ) {
        assert.equal(open, null, `${id} was requested while ${open} was still in flight`);
        open = id ?? null;
      } else if (o.payload_type === 'inference.recorded' && id === open) {
        open = null;
      }
    }
    assert.equal(r.calls.length, weighRequests(r).length - 1, 'the abandoned weighing is not re-sent');
    assert.equal(r.runtime.state().budget.judgments.reserved, 0);
    assert.equal(r.runtime.state().goal?.status, 'complete');
  });

  it('FW-T09 seqs stay strictly increasing after recovery over a log with gaps, so new evidence lifts a deferral', async () => {
    const journal = new MemoryJournal();
    const s = fwScenario({ judge: constantJudge(0), journal });
    for (let i = 0; i < 12; i += 1) {
      const gap = s.observe({
        ...changed(ALPHA, 2, 'unsupported'),
        observation_id: `test:gap:${i}`,
        payload_version: 2,
      });
      assert.equal(gap.validation.status, 'rejected');
    }
    await drive(s);
    assert.deepEqual(lastCycle(s).outcome, { status: 'blocked', reason: DEFERRED_REASON });
    assert.equal(weighRequests(s).length, 1);
    const loaded = journal.snapshot();
    const high = Math.max(...loaded.map((o) => o.seq));
    assert.ok(loaded.length < high, 'the journal holds a gap left by rejected observations');

    const r = fwScenario({ judge: constantJudge(0), recorded: loaded });
    await drive(r);
    assert.equal(weighRequests(r).length, 1, 'recovery alone is not new evidence');
    const evidence = r.observe(changed(ALPHA, 2, 'alpha revised'));
    assert.equal(evidence.validation.status, 'accepted');
    assert.ok(evidence.seq > high, `seq ${evidence.seq} must follow the loaded high-water mark ${high}`);
    await drive(r);
    const seqs = r.runtime.trace().observations.map((o) => o.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    assert.equal(new Set(seqs).size, seqs.length);
    assert.equal(weighRequests(r).length, 2, 'new evidence earns one more weighing');
    assert.deepEqual(lastCycle(r).outcome, { status: 'blocked', reason: DEFERRED_REASON });
  });
});
