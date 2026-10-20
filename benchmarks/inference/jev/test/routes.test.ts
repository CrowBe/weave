/**
 * Composition tests for the hosted and local probe gateways.
 *
 * Network is replaced by a stubbed `fetch`; nothing here reaches a provider.
 * These pin the call sites rather than the helpers they use: which credentials
 * make a route exist, which route is tried first, which model the direct route
 * names, and that both TypeSafe-wire gateways send choice criteria in the
 * probe's own order (the order the permutation scorer records as `presented`).
 */
import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';

import { CORPUS } from '../corpus.ts';
import { renderQuestions } from '../shapes.ts';
import {
  createJevGateway,
  createKevGateway,
  describeRoutes,
  jevRouteTable,
  probeTerms,
  readCredentials,
  runCase,
  type Credentials,
} from '../run.ts';

const CASE = CORPUS.find((c) => c.candidates.length >= 3)!;
const clock = { now: () => 1_000 };

/** Order as the probe renders it; the scorer assumes the model saw this order. */
function probeOrder(): string[] {
  const question = renderQuestions('choice', CASE)['best']!;
  assert.equal(question.type, 'choice');
  return Object.keys(question.type === 'choice' ? question.criteria : {});
}

/** Capture every System One body; answer with the case label so no retry follows. */
function stubSystemOne(t: TestContext): { urls: string[]; bodies: Record<string, any>[] } {
  const seen = { urls: [] as string[], bodies: [] as Record<string, any>[] };
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    seen.urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    seen.bodies.push(body);
    return new Response(
      JSON.stringify({
        model: body['model'],
        answers: { best: { type: 'choice', choice: CASE.label, confidence: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  // A shuffling adapter would reorder every list of two or more under this RNG.
  t.mock.method(Math, 'random', () => 0);
  return seen;
}

test('a TypeSafe key alone configures the probe; the legacy name still works', () => {
  assert.deepEqual(readCredentials({ TYPESAFE_API_KEY: ' ts-key ' }), { vercel: undefined, typesafe: 'ts-key' });
  assert.deepEqual(readCredentials({ TYPESAFE_AI_API_KEY: 'legacy' }), { vercel: undefined, typesafe: 'legacy' });
  assert.deepEqual(readCredentials({ AI_GATEWAY_API_KEY: 'gw' }), { vercel: 'gw', typesafe: undefined });
  assert.deepEqual(readCredentials({ AI_GATEWAY_API_KEY: 'gw', TYPESAFE_API_KEY: 'ts' }), { vercel: 'gw', typesafe: 'ts' });
});

test('no usable key is an error naming the default credential first', () => {
  for (const env of [{}, { TYPESAFE_API_KEY: '  ', AI_GATEWAY_API_KEY: '' }]) {
    const result = readCredentials(env);
    assert.ok('error' in result);
    assert.match(result.error, /^Set TYPESAFE_API_KEY/);
  }
});

test('direct TypeSafe is first when both keys are set; only --prefer-free puts the free route first', () => {
  const both: Credentials = { vercel: 'gw', typesafe: 'ts' };
  const ids = (preferFree: boolean) =>
    jevRouteTable(both, { preferFree }).filter((u) => u.kind === 'choice').map((u) => u.routed_unit_id);
  assert.deepEqual(ids(false), ['choice@typesafe', 'choice@vercel']);
  assert.deepEqual(ids(true), ['choice@vercel', 'choice@typesafe']);
  assert.deepEqual(
    jevRouteTable({ vercel: undefined, typesafe: 'ts' }, { preferFree: true }).map((u) => u.routed_unit_id),
    ['choice@typesafe', 'score@typesafe', 'boolean@typesafe'],
  );
  assert.deepEqual(
    jevRouteTable({ vercel: 'gw', typesafe: undefined }, { preferFree: false }).map((u) => u.routed_unit_id),
    ['choice@vercel', 'score@vercel', 'boolean@vercel'],
  );
  assert.deepEqual(probeTerms({ vercel: undefined, typesafe: 'ts' }, clock).destinations, ['typesafe-ai']);
});

test('the banner calls direct TypeSafe the default route, never the fallback', () => {
  const line = describeRoutes({ vercel: 'gw', typesafe: 'ts' }, { preferFree: false });
  assert.match(line, /TypeSafe direct first/);
  assert.doesNotMatch(line, /fallback/i);
  assert.match(describeRoutes({ vercel: undefined, typesafe: 'ts' }, { preferFree: false }), /TypeSafe direct only/);
  assert.match(describeRoutes({ vercel: 'gw', typesafe: undefined }, { preferFree: false }), /Vercel AI Gateway only/);
  assert.match(describeRoutes({ vercel: 'gw', typesafe: 'ts' }, { preferFree: true }), /Vercel AI Gateway first/);
});

test('the direct model defaults to jev-preview; blank is not a model and the env is not read here', (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const prior = process.env['JEV_MODEL'];
  process.env['JEV_MODEL'] = 'from-ambient-env';
  try {
    const model = (options: { preferFree: boolean; model?: string }) =>
      jevRouteTable({ vercel: undefined, typesafe: 'ts' }, options)[0]!.model;
    assert.equal(model({ preferFree: false }), 'jev-preview');
    assert.equal(model({ preferFree: false, model: '' }), 'jev-preview');
    assert.equal(model({ preferFree: false, model: '   ' }), 'jev-preview');
    assert.equal(model({ preferFree: false, model: ' jev-1.14.0 ' }), 'jev-1.14.0');
  } finally {
    if (prior === undefined) delete process.env['JEV_MODEL'];
    else process.env['JEV_MODEL'] = prior;
  }
});

test('the hosted Jev gateway sends choice criteria in the probe order', async (t) => {
  const seen = stubSystemOne(t);
  const credentials: Credentials = { vercel: undefined, typesafe: 'ts-key' };
  const gateway = createJevGateway(credentials, clock);
  const record = await runCase(gateway, clock, credentials, CASE, 'choice', 0);
  assert.equal(record.status, 'accepted');
  assert.deepEqual(seen.urls, ['https://api.typesafe.ai/v1/systemone']);
  assert.deepEqual(Object.keys(seen.bodies[0]!['questions']['best']['criteria']), probeOrder());
  assert.deepEqual(record.candidate_ids, probeOrder());
});

test('the local Kev gateway sends choice criteria in the probe order', async (t) => {
  const seen = stubSystemOne(t);
  const credentials: Credentials = { vercel: undefined, typesafe: undefined };
  const gateway = createKevGateway(clock, 'http://127.0.0.1:8000');
  const record = await runCase(gateway, clock, credentials, CASE, 'choice', 0, { preferFree: false, local: true });
  assert.equal(record.status, 'accepted');
  assert.deepEqual(seen.urls, ['http://127.0.0.1:8000/v1/systemone']);
  assert.deepEqual(Object.keys(seen.bodies[0]!['questions']['best']['criteria']), probeOrder());
});
