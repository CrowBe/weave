import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Native SDK responses only. Forbid real network and inspect every request.
const preload = `
import assert from 'node:assert/strict';
let catalogues = 0;
let generations = 0;
// Keep the promotion eligible regardless of the machine's actual test date.
Date.now = () => 1_792_454_400_000;
const ids = ['nvidia/nemotron-3.5-lightning-free','poolside/laguna-s-2.1-free',
  'reflection/beam-free','minimax/minimax-m3.1-flash','stealth/glyph-cluster'];
globalThis.fetch = async (url, init) => {
  if (String(url) === 'https://ai-gateway.vercel.sh/v1/models') {
    catalogues++;
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    return Response.json({data:ids.map(id => ({id,pricing:{input:'0',output:'0'}}))});
  }
  generations++;
  assert.equal(String(url), 'https://ai-gateway.vercel.sh/v4/ai/language-model');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + process.env.AI_GATEWAY_API_KEY);
  assert.ok(!process.argv.some(arg => arg.includes(process.env.AI_GATEWAY_API_KEY)));
  const model = new Headers(init.headers).get('ai-language-model-id');
  assert.equal(model, ids[generations - 1]);
  if (process.env.TEST_CASE === 'rate' && generations === 1) {
    return Response.json({error:{message:process.env.AI_GATEWAY_API_KEY}}, {status:429});
  }
  return Response.json({content:[{type:'text',text:'ok'}],finishReason:{unified:'stop',raw:'stop'},
    usage:{inputTokens:{total:2},outputTokens:{total:1}},
    providerMetadata:{gateway:{cost:process.env.TEST_CASE === 'paid' ? '0.01' : '0',marketCost:'0',gatewayCost:'0'}}});
};
process.on('exit', () => {
  const expected = Number(process.env.TEST_EXPECT_REQUESTS);
  assert.equal(catalogues, expected);
  assert.equal(generations, expected);
});
`;
function run(key: string | undefined, scenario: string, requests: number) {
  const env: NodeJS.ProcessEnv = { ...process.env, TEST_CASE: scenario, TEST_EXPECT_REQUESTS: String(requests) };
  delete env.NODE_TEST_CONTEXT;
  delete env.AI_GATEWAY_API_KEY;
  if (key !== undefined) env.AI_GATEWAY_API_KEY = key;
  const dir = mkdtempSync(join(tmpdir(), 'wv018-example-'));
  const out = openSync(join(dir, 'stdout'), 'w');
  const err = openSync(join(dir, 'stderr'), 'w');
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        `data:text/javascript,${encodeURIComponent(preload)}`,
        'examples/vercel-ai-gateway-free.ts',
      ],
      { env, stdio: ['ignore', out, err], timeout: 10_000 },
    );
    return {
      ...result,
      stdout: readFileSync(join(dir, 'stdout'), 'utf8'),
      stderr: readFileSync(join(dir, 'stderr'), 'utf8'),
    };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(dir, { recursive: true, force: true });
  }
}
test('Vercel free example requires an injected environment key before network', () => {
  for (const key of [undefined, '', '   ']) {
    const result = run(key, 'ok', 0);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'AI_GATEWAY_API_KEY is not set\n');
  }
});
for (const [scenario, requests, status] of [
  ['ok', 1, 0],
  ['rate', 2, 0],
  ['paid', 1, 1],
] as const) {
  test(`Vercel free example ${scenario} prints safe accounted outcomes`, () => {
    const key = 'synthetic-wv018-example';
    const result = run(key, scenario, requests);
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes(key));
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.outcome, status === 0 ? 'accepted' : 'unaccepted');
    assert.equal(outcome.attempts.length, requests);
    if (scenario === 'paid') {
      assert.equal(outcome.attempts[0].outcome, 'failed');
      assert.equal(outcome.attempts[0].failure, 'invalid_request');
      assert.equal(outcome.attempts[0].usage.cost, 10_000);
    }
  });
}
