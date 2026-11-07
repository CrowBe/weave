import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  EvaluationOutcome,
  EvaluationRequest,
  GenerationOutcome,
  GenerationRequest,
  InferenceGateway,
  InferenceTerms,
} from '@weave/gateway';
import {
  decideLoopRoute,
  decideTriage,
  transitionLoopRoute,
  transitionTriage,
  type LoopDecisionAsk,
} from '../src/sites/loop-decide.js';
import { decideRoute } from '../src/input-route.js';
import { gateExtract, type ExtractObservation } from '../src/sites/extract.js';
import type { RecordedSiteAnswer, SiteState, SiteTransition } from '../src/sites/index.js';
import { loopRouteExtractSchema, loopTriageExtractSchema } from '../src/sites/model-extract.js';
import { emptyWorkstreamIndex, openWorkstream, transitionWorkstream } from '../src/workstream.js';

const terms: InferenceTerms = {
  quality: 'baseline',
  destinations: ['local'],
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const revision = { state_revision: 1, state_updated_at: 10 };
const now = () => ({ ...revision, observed_at: 10 });

type Generate = (request: GenerationRequest, signal?: AbortSignal) => Promise<GenerationOutcome>;
type Evaluate = (request: EvaluationRequest<'choice'>, signal?: AbortSignal) => Promise<EvaluationOutcome<'choice'>>;

function acceptedGeneration(request: GenerationRequest, intent: string | null): GenerationOutcome {
  return {
    status: 'accepted',
    text: JSON.stringify({ intent: { value: intent } }),
    request_id: request.request_id,
    site: request.site,
    routed_unit_id: 'extract.fake',
    provider_response_id: 'provider-1',
    attempts: [],
    spent: 0,
    uncertainty: [],
  } as GenerationOutcome;
}

function acceptedChoice(
  request: EvaluationRequest<'choice'>,
  choice: string,
  extra: Record<string, unknown> = {},
): EvaluationOutcome<'choice'> {
  return {
    status: 'accepted',
    kind: 'choice',
    request_id: request.request_id,
    site: request.site,
    answers: { decision: { type: 'choice', choice, probabilities: { [choice]: 1 } } },
    confidence: { decision: 1 },
    routed_unit_id: 'site.fake',
    provider_response_id: 'provider-site',
    attempts: [],
    spent: 0,
    uncertainty: [],
    ...extra,
  } as EvaluationOutcome<'choice'>;
}

function port(options: { generate?: Generate; evaluate?: Evaluate } = {}) {
  const generateCalls: GenerationRequest[] = [];
  const evaluateCalls: EvaluationRequest<'choice'>[] = [];
  const fake = {
    async generate(request: GenerationRequest, signal?: AbortSignal) {
      generateCalls.push(request);
      if (!options.generate) throw new Error('unexpected generate');
      return options.generate(request, signal);
    },
    async evaluate(request: EvaluationRequest<'choice'>, signal?: AbortSignal) {
      evaluateCalls.push(request);
      if (!options.evaluate) throw new Error('unexpected evaluate');
      return options.evaluate(request, signal);
    },
  } as Pick<InferenceGateway, 'generate' | 'evaluate'>;
  return { fake, generateCalls, evaluateCalls };
}

const triageAsk: LoopDecisionAsk = {
  request_id: 'triage-1',
  ...revision,
  state: { request: 'fix the parser' },
  terms,
  needs_dispatch: false,
};
const routeAsk: LoopDecisionAsk = {
  request_id: 'route-1',
  ...revision,
  state: { unit_of_work: 'route the migration' },
  terms,
  needs_dispatch: false,
};

function observed(
  site: 'loop.triage' | 'loop.route',
  text: string,
  requestId = 'triage-1:x1',
  extra: {
    verdict?: 'use_hints' | 'original_only' | 're_extract';
    reason?: 'faithful' | 'unfaithful';
    attempt?: 1 | 2;
  } = {},
): ExtractObservation {
  const schema = site === 'loop.triage' ? loopTriageExtractSchema() : loopRouteExtractSchema();
  return gateExtract(
    schema,
    text,
    { intent: { value: text } },
    { site, request_id: requestId, state_revision: revision.state_revision, ...extra },
  );
}

test('grounded extraction lets triage decide, bound to the caller request', async () => {
  const fake = port({
    generate: async (request) => acceptedGeneration(request, 'fix the parser'),
    evaluate: async (request) => acceptedChoice(request, 'implement'),
  });
  const record = await decideTriage(triageAsk, fake.fake, now);
  assert.equal(fake.generateCalls.length, 1);
  assert.equal(fake.evaluateCalls.length, 1);
  assert.equal(fake.generateCalls[0]!.request_id, 'triage-1:x1');
  assert.equal(fake.generateCalls[0]!.site, 'loop.triage.extract');
  assert.deepEqual(fake.evaluateCalls[0]!.state, triageAsk.state);
  assert.deepEqual(
    record.extracts.map((item) => [item.site, item.extract_schema, item.request_id, item.verdict]),
    [['loop.triage', 'loop.triage@1', 'triage-1:x1', 'use_hints']],
  );
  assert.equal(record.site.choice, 'implement');
  assert.equal(record.site.status, 'transition');
  assert.equal(record.site.observation.accepted, true);
  assert.equal(record.site.observation.request_id, 'triage-1');
  assert.deepEqual(Object.keys(record), ['schema', 'request_id', 'extracts', 'site']);
});

test('grounded extraction lets loop.route decide without touching input.route', async () => {
  const fake = port({
    generate: async (request) => acceptedGeneration(request, 'route the migration'),
    evaluate: async (request) => acceptedChoice(request, 'strong'),
  });
  const record = await decideLoopRoute(routeAsk, fake.fake, now);
  assert.equal(fake.generateCalls.length, 1);
  assert.equal(fake.generateCalls[0]!.site, 'loop.route.extract');
  assert.equal(fake.evaluateCalls.length, 1);
  assert.equal(fake.evaluateCalls[0]!.site, 'loop.route');
  assert.deepEqual([record.site.choice, record.site.status], ['strong', 'transition']);

  const opened = openWorkstream(emptyWorkstreamIndex('p'), {
    workstream_id: 'w',
    origin: 'operator',
    evidence: 1,
  });
  assert.ok(opened.ok);
  const index = transitionWorkstream(opened.index, 'w', { type: 'input.recorded', seq: 2 });
  assert.ok(index.ok);
  const rulePort = port();
  const rule = await decideRoute(
    { workstream: index.index.workstreams[0]!, input_seq: 2, direction: null },
    { request_id: 'route-2', ...revision, terms, disclosed: { input: 'hello', summary: '' } },
    rulePort.fake,
    now,
  );
  assert.deepEqual([rule.decided_by, rule.outcome], ['rule', 'conversation']);
  assert.equal(rulePort.evaluateCalls.length, 0);
});

test('a remaining re_extract after two attempts makes no choice call and fails closed', () => {
  const first = observed('loop.triage', 'fix the parser', 'triage-1:x1', {
    verdict: 're_extract',
    reason: 'unfaithful',
  });
  const final = observed('loop.triage', 'fix the parser', 'triage-1:x2', {
    verdict: 're_extract',
    reason: 'unfaithful',
    attempt: 2,
  });
  const record = transitionTriage(triageAsk, { extracts: [first, final] }, revision);
  assert.deepEqual([record.site.status, record.site.observation.reason], ['needs_human', 'invalid_extract']);
  assert.equal(record.site.observation.answer, null);
  assert.equal(record.extracts.length, 2);
});

test('missing, wrong-schema and foreign extracts fail closed before any choice call', () => {
  const missing = transitionTriage(triageAsk, { extracts: [] }, revision);
  assert.deepEqual([missing.site.status, missing.site.observation.reason], ['needs_human', 'extract_missing']);

  const wrong = gateExtract(
    { id: 'other@1', slots: { intent: { kind: 'span', required: true, instructions: 'intent' } } },
    'fix the parser',
    { intent: { value: 'fix the parser' } },
    { site: 'loop.triage', request_id: 'triage-1:x1', state_revision: 1 },
  );
  const wrongRecord = transitionTriage(triageAsk, { extracts: [wrong] }, revision);
  assert.equal(wrongRecord.site.status, 'needs_human');
  assert.equal(wrongRecord.site.observation.reason, 'invalid_extract');

  const foreign = observed('loop.triage', 'fix the parser', 'other:x1');
  const foreignRecord = transitionTriage(triageAsk, { extracts: [foreign] }, revision);
  assert.equal(foreignRecord.site.status, 'needs_human');
  assert.equal(foreignRecord.site.observation.reason, 'invalid_extract');
  assert.equal(foreignRecord.site.observation.answer, null);
});

test('cancellation during extraction or the site pauses without a later call', async () => {
  const duringExtract = new AbortController();
  const extracting = port({
    generate: async (request) => {
      duringExtract.abort();
      return acceptedGeneration(request, 'fix the parser');
    },
    evaluate: async (request) => acceptedChoice(request, 'implement'),
  });
  const paused = await decideTriage(triageAsk, extracting.fake, now, duringExtract.signal);
  assert.equal(extracting.generateCalls.length, 1);
  assert.equal(extracting.evaluateCalls.length, 0);
  assert.deepEqual([paused.site.status, paused.site.observation.reason], ['paused', 'cancelled']);
  assert.equal(paused.extracts[0]!.reason, 'cancelled');

  const duringSite = new AbortController();
  const site = port({
    generate: async (request) => acceptedGeneration(request, 'route the migration'),
    evaluate: async (request) => {
      duringSite.abort();
      return acceptedChoice(request, 'strong');
    },
  });
  const mid = await decideLoopRoute(routeAsk, site.fake, now, duringSite.signal);
  assert.equal(site.evaluateCalls.length, 1);
  assert.deepEqual([mid.site.status, mid.site.observation.reason], ['paused', 'cancelled']);
});

test('a second extraction is requested at most once and only after re_extract', async () => {
  const fake = port({
    generate: async (request) => acceptedGeneration(request, 'not in the state'),
    evaluate: async (request) => acceptedChoice(request, 'implement'),
  });
  const record = await decideTriage(triageAsk, fake.fake, now);
  assert.equal(fake.generateCalls.length, 2);
  assert.deepEqual(
    fake.generateCalls.map((item) => item.request_id),
    ['triage-1:x1', 'triage-1:x2'],
  );
  assert.deepEqual(
    record.extracts.map((item) => item.verdict),
    ['re_extract', 'original_only'],
  );
  assert.equal(fake.evaluateCalls.length, 1);
  assert.equal(record.site.observation.accepted, true);

  const replay = transitionLoopRoute(
    routeAsk,
    { extracts: [observed('loop.route', 'route the migration', 'route-1:x1')] },
    revision,
  );
  assert.equal(replay.site.observation.reason, 'decision_unavailable');
});

test('replay refuses a forged site transition instead of trusting its fields', () => {
  const extract = observed('loop.triage', 'fix the parser', 'triage-1:x1');
  const base = transitionTriage(triageAsk, { extracts: [extract] }, revision).site;
  const forged: readonly [string, SiteTransition][] = [
    ['wrong site', { ...base, observation: { ...base.observation, site: 'loop.route' } }],
    ['wrong request id', { ...base, observation: { ...base.observation, request_id: 'other' } }],
    ['wrong state revision', { ...base, observation: { ...base.observation, state_revision: 2 } }],
    ['wrong schema', { ...base, observation: { ...base.observation, schema: 'other@1' } } as unknown as SiteTransition],
    ['choice is not the fallback', { ...base, choice: 'capability' }],
    ['status contradicts the fallback', { ...base, status: 'needs_human' }],
    [
      'accepted choice disagrees with the answer',
      {
        ...base,
        choice: 'implement',
        observation: { ...base.observation, accepted: true, answer: 'capability' },
      },
    ],
  ];
  for (const [name, transition] of forged) {
    const replayed = transitionTriage(triageAsk, { extracts: [extract], site: transition }, revision);
    assert.notDeepEqual(replayed.site, transition, name);
    assert.equal(replayed.site.status, 'needs_human', name);
    assert.equal(replayed.site.observation.accepted, false, name);
    assert.equal(replayed.site.observation.request_id, 'triage-1', name);
    assert.equal(replayed.site.observation.state_revision, revision.state_revision, name);
  }
});

test('replay refuses accepted transitions whose admission evidence is invalid', () => {
  const extract = observed('loop.triage', 'fix the parser', 'triage-1:x1');
  const base = transitionTriage(triageAsk, { extracts: [extract] }, revision).site;
  const accepted: SiteTransition = {
    ...base,
    choice: 'implement',
    tier: null,
    status: 'transition',
    observation: {
      ...base.observation,
      answer: 'implement',
      confidence: 1,
      top_p: 1,
      accepted: true,
      fallback_used: false,
      reason: 'accepted',
    },
  };
  assert.deepEqual(transitionTriage(triageAsk, { extracts: [extract], site: accepted }, revision).site, accepted);
  const forged: readonly [string, SiteTransition][] = [
    ['confidence below the site floor', { ...accepted, observation: { ...accepted.observation, confidence: 0 } }],
    ['top_p below the accepted threshold', { ...accepted, observation: { ...accepted.observation, top_p: 0 } }],
    [
      'accepted with a cancellation reason',
      { ...accepted, observation: { ...accepted.observation, reason: 'cancelled' } },
    ],
    ['accepted but marked as fallback', { ...accepted, observation: { ...accepted.observation, fallback_used: true } }],
    ['accepted with a fallback tier', { ...accepted, tier: 'strong' }],
    [
      'answer outside the triage options',
      { ...accepted, choice: 'strong', observation: { ...accepted.observation, answer: 'strong' } },
    ],
    ['confidence outside the unit interval', { ...accepted, observation: { ...accepted.observation, confidence: 60 } }],
    ['top_p outside the unit interval', { ...accepted, observation: { ...accepted.observation, top_p: -1 } }],
    ['wrong fixed question', { ...accepted, observation: { ...accepted.observation, question: 'other' } }],
  ];
  for (const [name, transition] of forged) {
    const replayed = transitionTriage(triageAsk, { extracts: [extract], site: transition }, revision);
    assert.notDeepEqual(replayed.site, transition, name);
    assert.equal(replayed.site.status, 'needs_human', name);
    assert.equal(replayed.site.observation.accepted, false, name);
  }
});

test('replay requires cancellation and outage transitions to keep their pause status', () => {
  const extract = observed('loop.triage', 'fix the parser', 'triage-1:x1');
  const base = transitionTriage(triageAsk, { extracts: [extract] }, revision).site;
  const cancelled: SiteTransition = {
    ...base,
    choice: 'implement',
    tier: 'strong',
    status: 'paused',
    observation: {
      ...base.observation,
      answer: null,
      confidence: null,
      top_p: null,
      accepted: false,
      fallback_used: true,
      reason: 'cancelled',
    },
  };
  assert.deepEqual(transitionTriage(triageAsk, { extracts: [extract], site: cancelled }, revision).site, cancelled);
  const cancelledAsTransition: SiteTransition = { ...cancelled, status: 'transition' };
  const replayedCancel = transitionTriage(triageAsk, { extracts: [extract], site: cancelledAsTransition }, revision);
  assert.notDeepEqual(replayedCancel.site, cancelledAsTransition);
  assert.equal(replayedCancel.site.status, 'needs_human');

  const dispatchAsk = { ...triageAsk, needs_dispatch: true };
  const outage: SiteTransition = {
    ...cancelled,
    observation: { ...cancelled.observation, reason: 'decision_unavailable' },
  };
  assert.deepEqual(transitionTriage(dispatchAsk, { extracts: [extract], site: outage }, revision).site, outage);
  const outageAsTransition: SiteTransition = { ...outage, status: 'transition' };
  const replayedOutage = transitionTriage(dispatchAsk, { extracts: [extract], site: outageAsTransition }, revision);
  assert.notDeepEqual(replayedOutage.site, outageAsTransition);
  assert.equal(replayedOutage.site.status, 'needs_human');

  const readOnlyOutage: SiteTransition = { ...outage, status: 'transition' };
  assert.deepEqual(
    transitionTriage(triageAsk, { extracts: [extract], site: readOnlyOutage }, revision).site,
    readOnlyOutage,
  );
  const readOnlyOutagePaused: SiteTransition = { ...outage, status: 'paused' };
  const replayedReadOnly = transitionTriage(triageAsk, { extracts: [extract], site: readOnlyOutagePaused }, revision);
  assert.notDeepEqual(replayedReadOnly.site, readOnlyOutagePaused);
  assert.equal(replayedReadOnly.site.status, 'needs_human');
});

test('replay rejects a live transition when the current state has moved', async () => {
  const fake = port({
    generate: async (request) => acceptedGeneration(request, 'fix the parser'),
    evaluate: async (request) => acceptedChoice(request, 'implement'),
  });
  const live = await decideTriage(triageAsk, fake.fake, now);
  const recordedAnswer: RecordedSiteAnswer = {
    state_revision: revision.state_revision,
    observed_at: revision.state_updated_at,
    outcome: acceptedChoice(
      { request_id: 'triage-1', site: 'loop.triage' } as EvaluationRequest<'choice'>,
      'implement',
    ),
  };
  const moved: readonly SiteState[] = [
    { state_revision: 2, state_updated_at: 20 },
    { state_revision: 1, state_updated_at: 11 },
  ];
  for (const current of moved) {
    const transitionReplay = transitionTriage(triageAsk, { extracts: live.extracts, site: live.site }, current);
    const answerReplay = transitionTriage(triageAsk, { extracts: live.extracts, site: recordedAnswer }, current);
    assert.notDeepEqual(transitionReplay.site, live.site);
    assert.deepEqual(
      [
        transitionReplay.site.choice,
        transitionReplay.site.tier,
        transitionReplay.site.status,
        transitionReplay.site.observation.accepted,
        transitionReplay.site.observation.reason,
      ],
      [
        answerReplay.site.choice,
        answerReplay.site.tier,
        answerReplay.site.status,
        answerReplay.site.observation.accepted,
        answerReplay.site.observation.reason,
      ],
    );
    assert.equal(transitionReplay.site.observation.reason, 'stale_answer');
    assert.equal(transitionReplay.site.observation.accepted, false);
    assert.equal(transitionReplay.site.status, 'transition');
  }
});

test('replay rejects out-of-order, attempt-2-only and unjustified second extracts', () => {
  const first = observed('loop.triage', 'fix the parser', 'triage-1:x1');
  const second = observed('loop.triage', 'fix the parser', 'triage-1:x2', { attempt: 2 });
  assert.throws(
    () => transitionTriage(triageAsk, { extracts: [second] }, revision),
    /recorded extract attempts must be unique, ordered and consecutive/,
  );
  assert.throws(
    () => transitionTriage(triageAsk, { extracts: [second, first] }, revision),
    /recorded extract attempts must be unique, ordered and consecutive/,
  );
  assert.throws(() => transitionTriage(triageAsk, { extracts: [first, second] }, revision), /second extraction/);
  const cancelledFirst = observed('loop.triage', 'fix the parser', 'triage-1:x1', {
    verdict: 're_extract',
    reason: 'unfaithful',
  });
  assert.throws(
    () => transitionTriage(triageAsk, { extracts: [{ ...cancelledFirst, reason: 'cancelled' }, second] }, revision),
    /second extraction/,
  );
});

test('replay accepts the recorded extracts and site transition from a live decision', async () => {
  const fake = port({
    generate: async (request) => acceptedGeneration(request, 'fix the parser'),
    evaluate: async (request) => acceptedChoice(request, 'implement'),
  });
  const live = await decideTriage(triageAsk, fake.fake, now);
  const replayed = transitionTriage(triageAsk, { extracts: live.extracts, site: live.site }, revision);
  assert.deepEqual(replayed, live);
});
