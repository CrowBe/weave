import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Every child replaces fetch before importing the example. No test can reach Zen.
const preload = `
import assert from 'node:assert/strict';
let lists = 0;
let generations = 0;
globalThis.fetch = async (url, init) => {
  assert.ok(!process.argv.some(arg => arg.includes('SENTINEL')));
  const headers = new Headers(init?.headers);
  if (String(url) === 'https://opencode.ai/inference/v1/models') {
    lists++;
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(headers.get('authorization'), null);
    return Response.json({data:[{id:'deepseek-v4.1-flash-free'}]});
  }
  generations++;
  assert.equal(String(url), 'https://opencode.ai/inference/openai/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(headers.get('authorization'), 'Bearer ' + process.env.OPENCODE_API_KEY);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'deepseek-v4.1-flash-free');
  assert.equal(body.messages.at(-1).content, 'Reply with the single word: ok');
  assert.ok(body.max_tokens >= 4096);
  return Response.json(process.env.TEST_STATUS === '401'
    ? {error:{message:process.env.OPENCODE_API_KEY,headers:Object.fromEntries(headers)}}
    : {id:'mock',choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:1}},
    {status:Number(process.env.TEST_STATUS || 200)});
};
process.on('exit', () => {
  assert.equal(lists, Number(process.env.TEST_EXPECT_LISTS));
  assert.equal(generations, Number(process.env.TEST_EXPECT_GENERATIONS));
});
`;

function run(key: string | undefined, status: number, requests: number) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, TEST_STATUS: String(status),
    TEST_EXPECT_LISTS: String(requests), TEST_EXPECT_GENERATIONS: String(requests),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.OPENCODE_API_KEY;
  if (key !== undefined) env.OPENCODE_API_KEY = key;
  const dir = mkdtempSync(join(tmpdir(), 'wv011-example-'));
  const stdout = join(dir, 'stdout');
  const stderr = join(dir, 'stderr');
  const out = openSync(stdout, 'w');
  const err = openSync(stderr, 'w');
  try {
    const child = spawnSync(process.execPath, [
      '--experimental-strip-types', '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      'examples/opencode-zen.ts',
    ], { env, stdio: ['ignore', out, err], timeout: 10_000 });
    assert.equal(child.error, undefined);
    return { status: child.status, stdout: readFileSync(stdout, 'utf8'), stderr: readFileSync(stderr, 'utf8') };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Zen example missing or blank key exits with exactly one safe line and zero requests', () => {
  for (const key of [undefined, '', '   ']) {
    const result = run(key, 200, 0);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'OPENCODE_API_KEY is not set\n');
  }
});

test('Zen example provider error cannot disclose the echoed key or headers', () => {
  const key = 'sk-test-SENTINEL-example-provider-error';
  const result = run(key, 401, 1);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes(key));
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['outcome', 'routed_unit', 'model', 'usage', 'attempts']);
  assert.equal(output.outcome, 'unaccepted');
  assert.equal(output.attempts.length, 1);
  assert.deepEqual(Object.keys(output.attempts[0]), ['routed_unit', 'model', 'usage', 'outcome']);
});

test('Zen example performs one guarded minimal public call and prints only safe routing and usage', () => {
  const key = 'sk-test-SENTINEL-example-success';
  const result = run(key, 200, 1);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes(key));
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['outcome', 'routed_unit', 'model', 'usage', 'attempts']);
  assert.equal(output.outcome, 'accepted');
  assert.equal(output.model, 'deepseek-v4.1-flash-free');
  assert.equal(output.routed_unit, 'opencode-zen.deepseek-free.flash');
  assert.deepEqual(output.usage, { input_tokens: 8, output_tokens: 1 });
  assert.equal(output.attempts.length, 1);
  assert.deepEqual(Object.keys(output.attempts[0]), ['routed_unit', 'model', 'usage', 'outcome']);
});

test('Zen example invalid header key exits safely with zero requests', () => {
  const key = 'sk-test-SENTINEL-invalid-header\r\nextra: value';
  const result = run(key, 200, 0);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('SENTINEL'));
  assert.deepEqual(JSON.parse(result.stdout), {
    outcome: 'failed', routed_unit: null, model: null, usage: null, attempts: [],
  });
});

test('Zen example reads its credential only from env and is included in verify', () => {
  const source = readFileSync(new URL('./opencode-zen.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.OPENCODE_API_KEY/);
  assert.doesNotMatch(source, /process\.argv|child_process|execFile|spawn/);
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  assert.match(scripts['example:opencode-zen'], /examples\/opencode-zen\.ts/);
  assert.match(scripts['test:opencode-zen-example'], /examples\/opencode-zen\.test\.ts/);
  assert.match(scripts.verify, /npm run test:opencode-zen-example/);
});
