/** Hosted probe composition tests ported from #250, retaining Vercel-first order. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CORPUS } from '../corpus.ts';
import { renderQuestions } from '../shapes.ts';
import * as run from '../run.ts';

const clock = { now: () => 1_000 };
const direct = { vercel: undefined, typesafe: 'fake-typesafe-key' };
const both = { vercel: 'fake-vercel-key', typesafe: 'fake-typesafe-key' };
/** The --prefer-free policy is stated whenever the free (Vercel) route is configured. */
const freeRoute = (preferFree: boolean) =>
  `; free route ${preferFree ? 'preferred, throttles waited out' : 'escalates on throttle'}`;

test('a TypeSafe key alone configures the probe; the legacy name still works', () => {
  assert.deepEqual(run.readCredentials({ TYPESAFE_API_KEY: ' ts-key ' }), {
    vercel: undefined,
    typesafe: 'ts-key',
  });
  assert.deepEqual(run.readCredentials({ TYPESAFE_AI_API_KEY: 'legacy' }), {
    vercel: undefined,
    typesafe: 'legacy',
  });
  assert.deepEqual(run.readCredentials({ AI_GATEWAY_API_KEY: ' gw ' }), {
    vercel: 'gw',
    typesafe: undefined,
  });
  assert.deepEqual(run.readCredentials({ AI_GATEWAY_API_KEY: 'gw', TYPESAFE_API_KEY: 'ts' }), {
    vercel: 'gw',
    typesafe: 'ts',
  });
  assert.deepEqual(run.readCredentials({ TYPESAFE_API_KEY: ' ', TYPESAFE_AI_API_KEY: ' legacy ' }), {
    vercel: undefined,
    typesafe: 'legacy',
  });
  assert.deepEqual(run.readCredentials({ TYPESAFE_API_KEY: 'preferred', TYPESAFE_AI_API_KEY: 'legacy' }), {
    vercel: undefined,
    typesafe: 'preferred',
  });
});

test('neither usable key returns a clear error naming both credential choices', () => {
  for (const env of [{}, { TYPESAFE_API_KEY: '  ', TYPESAFE_AI_API_KEY: '\t', AI_GATEWAY_API_KEY: '' }]) {
    const result = run.readCredentials(env);
    assert.ok('error' in result);
    assert.match(result.error, /^Set TYPESAFE_API_KEY/);
    assert.match(result.error, /TYPESAFE_AI_API_KEY.*AI_GATEWAY_API_KEY/);
  }
});

test('a TypeSafe-only route table and terms contain only the direct destination', () => {
  for (const preferFree of [false, true]) {
    assert.deepEqual(
      run.jevRouteTable(direct, { preferFree }).map((u) => u.routed_unit_id),
      ['choice@typesafe', 'score@typesafe', 'boolean@typesafe'],
    );
    assert.deepEqual(run.probeTerms(direct, clock, { preferFree }).destinations, ['typesafe-ai']);
  }
});

test('both keys keep Vercel first for every kind with and without --prefer-free', () => {
  for (const preferFree of [false, true]) {
    const routes = run.jevRouteTable(both, { preferFree });
    assert.deepEqual(
      routes.map((u) => u.routed_unit_id),
      ['choice@vercel', 'choice@typesafe', 'score@vercel', 'score@typesafe', 'boolean@vercel', 'boolean@typesafe'],
    );
    for (const route of routes) {
      assert.deepEqual(
        route.rate_limits,
        preferFree && route.adapter === 'vercel-ai-gateway' ? [{ requests: 60, window_ms: 60_000 }] : undefined,
      );
    }
    const terms = run.probeTerms(both, clock, { preferFree });
    assert.deepEqual(terms.destinations, ['vercel-ai-gateway', 'typesafe-ai']);
    assert.equal(terms.max_attempts, preferFree ? 8 : 4);
    assert.equal(terms.max_attempts_per_route, preferFree ? 6 : 2);
  }
});

test('a Vercel key alone keeps only the Vercel route and destination', () => {
  const credentials = { vercel: 'fake-vercel-key', typesafe: undefined };
  assert.deepEqual(
    run.jevRouteTable(credentials, { preferFree: false }).map((u) => u.routed_unit_id),
    ['choice@vercel', 'score@vercel', 'boolean@vercel'],
  );
  assert.deepEqual(run.probeTerms(credentials, clock).destinations, ['vercel-ai-gateway']);
});

test('describeRoutes names routes in order and never includes fake key or model material', () => {
  assert.equal(typeof run.describeRoutes, 'function', 'describeRoutes must be exported');
  for (const preferFree of [false, true]) {
    const options = { preferFree, model: 'fake-env-model-value' };
    const cases = [
      [direct, 'routes: TypeSafe direct only'],
      [{ vercel: both.vercel, typesafe: undefined }, `routes: Vercel AI Gateway only${freeRoute(preferFree)}`],
      [both, `routes: Vercel AI Gateway first, then TypeSafe direct${freeRoute(preferFree)}`],
    ] as const;
    for (const [credentials, expected] of cases) {
      const line = run.describeRoutes(credentials, options);
      assert.equal(line, expected);
      for (const secret of [both.vercel, both.typesafe, options.model]) assert.ok(!line.includes(secret));
    }
  }
});

test('describeRoutes in reference mode names only the pinned TypeSafe route, whatever keys are present', () => {
  const reference = { preferFree: false, reference: true };
  for (const credentials of [both, direct, run.readCredentials({ TYPESAFE_API_KEY: 'fake-typesafe-key' }, reference)]) {
    assert.ok(!('error' in credentials));
    assert.equal(run.describeRoutes(credentials, reference), 'routes: TypeSafe direct only (pinned jev-1.14.0, no fallback)');
  }
});

test('the TypeSafe-only hosted gateway sends choice criteria in the probe order', async (t) => {
  const decision = CORPUS.find((c) => c.candidates.length >= 3)!;
  const urls: string[] = [];
  const bodies: { questions: { best: { criteria: Record<string, unknown> } } }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        model: 'jev-preview',
        answers: { best: { type: 'choice', choice: decision.label, confidence: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  // A shuffling adapter would reorder every list of two or more under this RNG.
  t.mock.method(Math, 'random', () => 0);
  const gateway = run.createJevGateway(direct, clock);
  const record = await run.runCase(gateway, clock, direct, decision, 'choice', 0);
  assert.equal(record.status, 'accepted');
  assert.deepEqual(urls, ['https://api.typesafe.ai/v1/systemone']);
  const question = renderQuestions('choice', decision)['best']!;
  assert.equal(question.type, 'choice');
  const order = Object.keys(question.type === 'choice' ? question.criteria : {});
  assert.deepEqual(Object.keys(bodies[0]!.questions.best.criteria), order);
  assert.deepEqual(record.candidate_ids, order);
  assert.ok(!JSON.stringify(record).includes(direct.typesafe));
});

for (const script of ['probe.ts', 'transfer-probe.ts']) {
  test(`${script} logs describeRoutes before running, with no credential values`, async (t) => {
    for (const preferFree of [false, true]) {
      for (const [env, expected] of [
        [{ TYPESAFE_API_KEY: direct.typesafe }, 'routes: TypeSafe direct only'],
        [{ AI_GATEWAY_API_KEY: both.vercel }, `routes: Vercel AI Gateway only${freeRoute(preferFree)}`],
        [
          { AI_GATEWAY_API_KEY: both.vercel, TYPESAFE_API_KEY: both.typesafe },
          `routes: Vercel AI Gateway first, then TypeSafe direct${freeRoute(preferFree)}`,
        ],
      ] as const) {
        await t.test(`${expected}; preferFree=${preferFree}`, async (t) => {
          const { main } = (await import(`../${script}`)) as { main: (deps: object) => Promise<number> };
          t.mock.method(globalThis, 'fetch', async () => {
            throw new Error('provider calls forbidden');
          });
          // Stop at the first run-level log, before any provider call or output write.
          const stopped = new Error('captured first run log');
          let line: string | undefined;
          t.mock.method(console, 'log', (...args: unknown[]) => {
            line = args.join(' ');
            throw stopped;
          });
          await assert.rejects(
            main({
              argv: ['node', script, ...(preferFree ? ['--prefer-free'] : [])],
              env: { ...env, JEV_MODEL: 'fake-env-model-value' },
              clock,
            }),
            (error: unknown) => error === stopped,
          );
          assert.equal(line, expected);
          for (const secret of [both.typesafe, both.vercel, 'fake-env-model-value']) {
            assert.ok(!line!.includes(secret));
          }
        });
      }
    }
    await t.test('reference mode logs the pinned single route', async (t) => {
      const { main } = (await import(`../${script}`)) as { main: (deps: object) => Promise<number> };
      t.mock.method(globalThis, 'fetch', async () => {
        throw new Error('provider calls forbidden');
      });
      const stopped = new Error('captured first run log');
      let line: string | undefined;
      t.mock.method(console, 'log', (...args: unknown[]) => {
        line = args.join(' ');
        throw stopped;
      });
      await assert.rejects(
        main({
          argv: ['node', script, '--reference'],
          env: { AI_GATEWAY_API_KEY: both.vercel, TYPESAFE_API_KEY: both.typesafe },
          clock,
        }),
        (error: unknown) => error === stopped,
      );
      assert.equal(line, 'routes: TypeSafe direct only (pinned jev-1.14.0, no fallback)');
    });
  });
}
