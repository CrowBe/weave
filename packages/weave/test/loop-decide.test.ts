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
  extra: { verdict?: 'use_hints' | 'original_only' | 're_extract'; reason?: 'faithful' | 'unfaithful' } = {},
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
  const first = observed('loop.triage', 'fix the parser', 'triage-1:x1');
  const final = observed('loop.triage', 'fix the parser', 'triage-1:x2', {
    verdict: 're_extract',
    reason: 'unfaithful',
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

test('replay accepts the recorded extracts and site transition from a live decision', async () => {
  const fake = port({
    generate: async (request) => acceptedGeneration(request, 'fix the parser'),
    evaluate: async (request) => acceptedChoice(request, 'implement'),
  });
  const live = await decideTriage(triageAsk, fake.fake, now);
  const replayed = transitionTriage(triageAsk, { extracts: live.extracts, site: live.site }, revision);
  assert.deepEqual(replayed, live);
});
