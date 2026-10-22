import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// This preload forbids live calls, validates argv/header isolation in the child,
// and checks the request count even when the composition root exits early.
const preload = `
import assert from 'node:assert/strict';
let calls = 0;
globalThis.fetch = async (url, init) => {
  calls++;
  assert.ok(!process.argv.some(arg => arg.includes(process.env.MODEL_API_KEY)));
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + process.env.MODEL_API_KEY);
  assert.equal(String(url), 'https://api.meta.ai/v1/chat/completions');
  const body = JSON.parse(init.body);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.messages.at(-1).content, 'Reply with the single word: ok');
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.reasoning, undefined);
  const exhausted = body.max_tokens <= 250;
  return new Response(JSON.stringify(['401','402','403'].includes(process.env.TEST_STATUS)
    ? {error:{message:process.env.MODEL_API_KEY}}
    : {id:'mock',choices:[{index:0,message:{role:'assistant',content:exhausted ? '' : 'ok'},finish_reason:exhausted ? 'length' : 'stop'}],
      usage:{prompt_tokens:8,completion_tokens:exhausted ? body.max_tokens : 251,
        completion_tokens_details:{reasoning_tokens:exhausted ? body.max_tokens : 250}}}),
    {status:Number(process.env.TEST_STATUS || 200),headers:{'content-type':'application/json'}});
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
  delete env.MODEL_API_KEY;
  if (key !== undefined) env.MODEL_API_KEY = key;
  const dir = mkdtempSync(join(tmpdir(), 'wv010-example-'));
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
        'examples/muse-spark.ts',
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

test('Muse example missing or blank key exits with one safe line and no request', () => {
  for (const key of [undefined, '', '   ']) {
    const result = run(key, 200, 0);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'MODEL_API_KEY is not set\n');
  }
});

for (const status of [401, 402, 403])
  test(`Muse example ${status} exhausts the shared credential before fallback`, () => {
    const key = 'sk-test-SENTINEL-example-invalid';
    const result = run(key, status, 1);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes(key));
    const output = JSON.parse(result.stdout);
    assert.equal(output.outcome, 'blocked');
    assert.equal(output.attempts.length, 1);
    assert.equal(output.attempts[0].failure, 'unauthorized');
  });

test('Muse example performs one public minimal call and prints safe usage and routing', () => {
  const key = 'sk-test-SENTINEL-example-success';
  const result = run(key, 200, 1);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes(key));
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['outcome', 'routed_unit', 'model', 'usage', 'attempts']);
  assert.equal(output.outcome, 'accepted');
  assert.equal(output.model, 'muse-spark-1.3-contributor');
  assert.deepEqual(output.usage, { input_tokens: 8, output_tokens: 251 });
  assert.equal(output.attempts.length, 1);
});

test('Muse example invalid header key fails construction without a request or credential output', () => {
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
  });
});

test('Muse example obtains credentials only from the environment', () => {
  const source = readFileSync(new URL('./muse-spark.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.MODEL_API_KEY/);
  assert.doesNotMatch(source, /process\.argv|child_process|execFile|spawn/);
});
