import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// This preload forbids live calls, validates argv/header isolation in the child,
// serves the catalogue price check, and checks the request count at exit.
const preload = `
import assert from 'node:assert/strict';
let calls = 0;
globalThis.fetch = async (url, init) => {
  calls++;
  assert.ok(!process.argv.some(arg => arg.includes(process.env.NOUS_API_KEY)));
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + process.env.NOUS_API_KEY);
  const status = Number(process.env.TEST_STATUS || 200);
  const headers = { 'content-type': 'application/json' };
  if (String(url) === 'https://inference-api.nousresearch.com/v1/models') {
    assert.equal(init.method, 'GET');
    return new Response(JSON.stringify(status === 401 ? { error: process.env.NOUS_API_KEY } : { data: [
      { id: 'upstage/solar-mini4:free', pricing: { prompt: '0', completion: '0', input_cache_read: '0' } },
      { id: 'meituan/longcat-2.0:free', pricing: { prompt: '0', completion: '0', input_cache_read: '0' } },
    ] }), { status, headers });
  }
  assert.equal(String(url), 'https://inference-api.nousresearch.com/v1/chat/completions');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'upstage/solar-mini4:free');
  assert.deepEqual(body.tags, ['user=weave']);
  assert.equal(body.messages.at(-1).content, 'Reply with the single word: ok');
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.reasoning, undefined);
  assert.equal(body.stream, undefined);
  return new Response(JSON.stringify({ id: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10, cost: 0 } }), { status, headers });
};
process.on('exit', () => assert.equal(calls, Number(process.env.TEST_EXPECT_REQUESTS)));
`;

function run(key: string | undefined, status: number, requests: number) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_STATUS: String(status),
    TEST_EXPECT_REQUESTS: String(requests),
  };
  // The child is an example process, not a test-runner worker.
  delete env.NODE_TEST_CONTEXT;
  delete env.NOUS_API_KEY;
  if (key !== undefined) env.NOUS_API_KEY = key;
  const dir = mkdtempSync(join(tmpdir(), 'wv016-example-'));
  const stdout = join(dir, 'stdout');
  const stderr = join(dir, 'stderr');
  const out = openSync(stdout, 'w');
  const err = openSync(stderr, 'w');
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        `data:text/javascript,${encodeURIComponent(preload)}`,
        'examples/nous-portal.ts',
      ],
      {
        env,
        stdio: ['ignore', out, err],
        timeout: 10_000,
      },
    );
    assert.equal(child.error, undefined);
    return { status: child.status, stdout: readFileSync(stdout, 'utf8'), stderr: readFileSync(stderr, 'utf8') };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Nous example missing or blank key exits with one safe line and no request', () => {
  for (const key of [undefined, '', '   ']) {
    const result = run(key, 200, 0);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'NOUS_API_KEY is not set\n');
  }
});

test('Nous example refused key prints only bounded outcome fields and never the key', () => {
  const key = 'sk-test-SENTINEL-nous-example-invalid';
  // One catalogue check per routed unit; a refused check is never cached, and no chat request is sent.
  const result = run(key, 401, 2);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes(key));
  const output = JSON.parse(result.stdout);
  assert.equal(output.outcome, 'unaccepted');
  assert.equal(output.attempts.length, 2);
  assert.equal(output.attempts[0].failure, 'unauthorized');
});

test('Nous example performs one public minimal call and prints safe usage, routing and cost', () => {
  const key = 'sk-test-SENTINEL-nous-example-success';
  const result = run(key, 200, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes(key));
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['outcome', 'routed_unit', 'model', 'usage', 'attempts', 'cost']);
  assert.equal(output.outcome, 'accepted');
  assert.equal(output.routed_unit, 'nous-portal.flash.solar-mini4');
  assert.equal(output.model, 'upstage/solar-mini4:free');
  assert.deepEqual(output.usage, { input_tokens: 9, output_tokens: 1 });
  assert.equal(output.attempts.length, 1);
  assert.equal(output.cost, 0);
});

test('Nous example invalid header key fails construction without a request or credential output', () => {
  const key = 'sk-test-SENTINEL-invalid-header\r\nextra: value';
  const result = run(key, 200, 0);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('SENTINEL'));
  assert.deepEqual(JSON.parse(result.stdout), {
    outcome: 'failed',
    routed_unit: null,
    model: null,
    usage: null,
    attempts: [],
    cost: null,
  });
});

test('Nous example obtains credentials only from the environment', () => {
  const source = readFileSync(new URL('./nous-portal.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.NOUS_API_KEY/);
  assert.doesNotMatch(source, /process\.argv|child_process|execFile|spawn/);
});
