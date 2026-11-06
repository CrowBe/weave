import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InferenceGateway } from '@weave/gateway';
import {
  evaluateSite,
  modelOrigin,
  originReason,
  structuralOrigin,
  transitionSite,
  type RouteSiteInput,
  type SiteInput,
  type SiteState,
} from '../src/sites/index.js';
import { gateExtract, type ExtractObservation } from '../src/sites/extract.js';
import {
  INPUT_ROUTE_EXTRACT_SCHEMA,
  LOOP_ROUTE_EXTRACT_SCHEMA,
  LOOP_TRIAGE_EXTRACT_SCHEMA,
  inputRouteExtractSchema,
  loopRouteExtractSchema,
  loopTriageExtractSchema,
} from '../src/sites/model-extract.js';

const current: SiteState = { state_revision: 1, state_updated_at: 10 };
const terms = {
  quality: 'baseline' as const,
  destinations: ['local'],
  max_context_tokens: 100,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const base = {
  request_id: 'r1',
  ...current,
  state: { text: 'please read the archive' },
  terms,
  needs_dispatch: false,
};

function extractFor(site: string, text = 'read the archive', requestId = 'r1:x1') {
  return gateExtract(
    { id: `${site}@1`, slots: { intent: { kind: 'span', required: true, instructions: 'intent' } } },
    text,
    { intent: { value: text } },
    { site, request_id: requestId, state_revision: 1 },
  );
}

function answer(site: string, choice: string, requestId = 'r1') {
  return {
    state_revision: 1,
    observed_at: 10,
    outcome: {
      status: 'accepted' as const,
      kind: 'choice' as const,
      request_id: requestId,
      site,
      answers: { decision: { type: 'choice' as const, choice, probabilities: { [choice]: 1 } } },
      confidence: { decision: 1 },
      routed_unit_id: 'fixture',
      provider_response_id: 'provider-1',
      attempts: [],
      spent: 0,
      uncertainty: [],
    },
  };
}

test('the model-extract schemas name their site and extract only verbatim intent', () => {
  assert.equal(inputRouteExtractSchema().id, INPUT_ROUTE_EXTRACT_SCHEMA);
  assert.equal(loopTriageExtractSchema().id, LOOP_TRIAGE_EXTRACT_SCHEMA);
  assert.equal(loopRouteExtractSchema().id, LOOP_ROUTE_EXTRACT_SCHEMA);
  assert.deepEqual(Object.keys(inputRouteExtractSchema().slots), ['intent']);
  assert.deepEqual(Object.keys(loopTriageExtractSchema().slots), ['intent']);
  assert.deepEqual(Object.keys(loopRouteExtractSchema().slots), ['intent']);
  const gated = gateExtract(
    loopTriageExtractSchema(),
    'fix the parser',
    { intent: { value: 'fix the parser' } },
    { site: 'loop.triage' },
  );
  assert.equal(gated.verdict, 'use_hints');
  assert.equal(gated.slots[0]?.span?.[0], 0);
});

test('a free-text site needs a matching extract record, not a bare or malformed one', async () => {
  const sites = [
    ['input.route', 'steer'],
    ['loop.triage', 'implement'],
    ['loop.route', 'strong'],
  ] as const;
  for (const [site, choice] of sites) {
    for (const origin of [
      undefined,
      { kind: 'structural', source: 'progress.delta@1' },
      { kind: 'model', extract: {} },
    ]) {
      const input = { ...base, origin } as unknown as SiteInput;
      const record = transitionSite(site, input, answer(site, choice), current);
      assert.equal(record.observation.accepted, false, site);
      assert.equal(record.observation.reason, origin === undefined ? 'extract_missing' : 'invalid_extract');
      assert.equal(record.status, 'needs_human');
      assert.equal(record.observation.answer, null);
      assert.equal(record.observation.provider_request_id, null);
    }
    const input = { ...base, origin: modelOrigin(extractFor(site)) } as unknown as SiteInput;
    let calls = 0;
    const port = {
      async evaluate() {
        calls += 1;
        return answer(site, choice).outcome;
      },
    } as unknown as Pick<InferenceGateway, 'evaluate'>;
    const live = await evaluateSite(site, input, port, () => ({ ...current, observed_at: 10 }));
    assert.equal(calls, 1, site);
    assert.equal(live.observation.accepted, true, `${site}: ${live.observation.reason}`);
  }
});

test('a malformed extract cannot reach the provider and fails closed', async () => {
  let calls = 0;
  const port = {
    async evaluate() {
      calls += 1;
      return answer('input.route', 'conversation').outcome;
    },
  } as unknown as Pick<InferenceGateway, 'evaluate'>;
  const input = {
    ...base,
    origin: { kind: 'model', extract: { schema: 'extract@1', site: 'input.route' } },
  } as unknown as RouteSiteInput;
  const record = await evaluateSite('input.route', input, port, () => ({ ...current, observed_at: 10 }));
  assert.equal(calls, 0);
  assert.equal(record.status, 'needs_human');
  assert.equal(record.observation.reason, 'invalid_extract');
});

test('an extract from another request cannot authorize this input', async () => {
  const site = 'input.route';
  const foreign = extractFor(site);
  const input = {
    ...base,
    request_id: 'r2',
    origin: { kind: 'model', extract: foreign },
  } as unknown as RouteSiteInput;
  assert.equal(originReason(site, input), 'invalid_extract');
  let calls = 0;
  const record = await evaluateSite(
    site,
    input,
    {
      async evaluate() {
        calls += 1;
        return answer(site, 'steer').outcome;
      },
    } as unknown as Pick<InferenceGateway, 'evaluate'>,
    () => ({ ...current, observed_at: 10 }),
  );
  assert.equal(calls, 0);
  assert.equal(record.status, 'needs_human');
  assert.equal(record.observation.reason, 'invalid_extract');
  assert.equal(record.observation.answer, null);

  const wrongAttempt = {
    ...base,
    request_id: site,
    origin: { kind: 'model', extract: { ...foreign, request_id: `${site}:x2` } },
  } as unknown as RouteSiteInput;
  assert.equal(originReason(site, wrongAttempt), 'invalid_extract');

  const own = {
    ...base,
    request_id: site,
    origin: modelOrigin(extractFor(site, 'read the archive', `${site}:x1`)),
  } as unknown as RouteSiteInput;
  assert.equal(originReason(site, own), null);

  const owner = {
    ...base,
    request_id: 'owner',
    origin: modelOrigin(extractFor(site, 'read the archive', 'owner:x1')),
  } as unknown as RouteSiteInput;
  const borrower = { ...owner, request_id: 'borrower' } as unknown as RouteSiteInput;
  let concurrentCalls = 0;
  const read = () => ({ ...current, observed_at: 10 });
  const [ownerRecord, borrowerRecord] = await Promise.all([
    evaluateSite(
      site,
      owner,
      {
        async evaluate(request: { readonly request_id: string; readonly site: string }) {
          concurrentCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
          return answer(request.site, 'steer', request.request_id).outcome;
        },
      } as unknown as Pick<InferenceGateway, 'evaluate'>,
      read,
    ),
    evaluateSite(
      site,
      borrower,
      {
        async evaluate() {
          concurrentCalls += 1;
          return answer(site, 'steer', 'borrower').outcome;
        },
      } as unknown as Pick<InferenceGateway, 'evaluate'>,
      read,
    ),
  ]);
  assert.equal(concurrentCalls, 1);
  assert.equal(ownerRecord.observation.accepted, true);
  assert.equal(borrowerRecord.observation.reason, 'invalid_extract');
});

test('a non-final, cancelled or stale extract stops before the provider', async () => {
  const site = 'input.route';
  const valid = extractFor(site);
  const cases: [ExtractObservation, string, 'paused' | 'needs_human'][] = [
    [{ ...valid, verdict: 're_extract', reason: 'unfaithful' }, 'invalid_extract', 'needs_human'],
    [{ ...valid, verdict: 'original_only', reason: 'cancelled' }, 'cancelled', 'paused'],
    [{ ...valid, verdict: 'original_only', reason: 'stale_answer' }, 'stale_answer', 'needs_human'],
  ];
  for (const [extract, reason, status] of cases) {
    const input = { ...base, origin: { kind: 'model', extract } } as unknown as RouteSiteInput;
    assert.equal(originReason(site, input), reason);
    let calls = 0;
    const record = await evaluateSite(
      site,
      input,
      {
        async evaluate() {
          calls += 1;
          return answer(site, 'steer').outcome;
        },
      } as unknown as Pick<InferenceGateway, 'evaluate'>,
      () => ({ ...current, observed_at: 10 }),
    );
    assert.equal(calls, 0, reason);
    assert.equal(record.status, status, reason);
    assert.equal(record.observation.reason, reason);
    assert.equal(record.observation.answer, null);
    assert.equal(record.observation.provider_request_id, null);
  }
});

test('a free-text site accepts only its expected schema and slot structure', async () => {
  const site = 'loop.route';
  const valid = extractFor(site);
  const invalid: [string, ExtractObservation][] = [
    ['an unrelated schema', { ...valid, extract_schema: 'other@1' }],
    ['zero slots', { ...valid, slots: [] }],
    ['an unexpected slot name', { ...valid, slots: [{ ...valid.slots[0]!, slot: 'other' }] }],
    ['an unexpected slot kind', { ...valid, slots: [{ ...valid.slots[0]!, kind: 'choice' }] }],
  ];
  for (const [name, extract] of invalid) {
    const input = { ...base, origin: { kind: 'model', extract } } as SiteInput;
    assert.equal(originReason(site, input), 'invalid_extract', name);
    let calls = 0;
    const record = await evaluateSite(
      site,
      input,
      {
        async evaluate() {
          calls += 1;
          return answer(site, 'strong').outcome;
        },
      } as unknown as Pick<InferenceGateway, 'evaluate'>,
      () => ({ ...current, observed_at: 10 }),
    );
    assert.equal(calls, 0, name);
    assert.equal(record.status, 'needs_human', name);
    assert.equal(record.observation.reason, 'invalid_extract', name);
  }
});

test('cancellation pauses and never reaches the provider even with no origin', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const port = {
    async evaluate() {
      calls += 1;
      return answer('loop.route', 'strong').outcome;
    },
  } as unknown as Pick<InferenceGateway, 'evaluate'>;
  const record = await evaluateSite(
    'loop.route',
    base,
    port,
    () => ({ ...current, observed_at: 10 }),
    controller.signal,
  );
  assert.equal(calls, 0);
  assert.equal(record.status, 'paused');
  assert.equal(record.observation.reason, 'cancelled');
});

test('concurrent site calls keep their own origin and fail closed independently', async () => {
  const triage = {
    ...base,
    request_id: 'triage',
    origin: modelOrigin(extractFor('loop.triage', 'read the archive', 'triage:x1')),
  };
  const route = {
    ...base,
    request_id: 'route',
    origin: modelOrigin(extractFor('loop.route', 'read the archive', 'route:x1')),
  };
  const seen: string[] = [];
  const port = {
    async evaluate(request: { readonly request_id: string; readonly site: string }) {
      seen.push(request.request_id);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const choice = request.site === 'loop.triage' ? 'implement' : 'strong';
      return answer(request.site, choice, request.request_id).outcome;
    },
  } as unknown as Pick<InferenceGateway, 'evaluate'>;
  const read = () => ({ ...current, observed_at: 10 });
  const [triageRecord, missingRecord, routeRecord] = await Promise.all([
    evaluateSite('loop.triage', triage, port, read),
    evaluateSite('loop.route', base, port, read),
    evaluateSite('loop.route', route, port, read),
  ]);
  assert.deepEqual(seen.sort(), ['route', 'triage']);
  assert.equal(triageRecord.observation.accepted, true);
  assert.equal(routeRecord.observation.accepted, true);
  assert.equal(missingRecord.status, 'needs_human');
  assert.equal(missingRecord.observation.reason, 'extract_missing');
});

test('replay reuses the recorded extract without duplication and cannot be revived without it', () => {
  const origin = modelOrigin(extractFor('loop.route'));
  const input = { ...base, origin };
  const recorded = answer('loop.route', 'strong');
  const first = transitionSite('loop.route', input, recorded, current);
  const second = transitionSite(
    'loop.route',
    { ...input, origin: structuredClone(origin) },
    structuredClone(recorded),
    current,
  );
  assert.deepEqual(first, second);
  assert.equal(first.observation.accepted, true);
  const missing = transitionSite('loop.route', base, recorded, current);
  assert.deepEqual(missing, transitionSite('loop.route', base, recorded, current));
  assert.equal(missing.observation.accepted, false);
  assert.equal(missing.observation.reason, 'extract_missing');
});

test('structural sites name their evidence and reject a model extract', () => {
  const structural = [
    ['loop.continue', 'progress.delta@1'],
    ['audit.dispose', 'audit.findings'],
    ['eval.output', 'criteria'],
  ] as const;
  for (const [site, source] of structural) {
    const input = { ...base, origin: structuralOrigin(source) };
    assert.equal(originReason(site, input), null, site);
    const wrong = { ...input, origin: modelOrigin(extractFor(site)) };
    assert.equal(originReason(site, wrong), 'structural_origin_missing', site);
  }
  const loop = { ...base, origin: structuralOrigin('progress.delta@1') };
  assert.equal(
    transitionSite('loop.continue', loop, answer('loop.continue', 'progressing'), current).choice,
    'progressing',
  );
});
