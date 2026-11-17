import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalApi } from './api.ts';
import type { LocalTaskPorts } from '@weave/weave';
import { LocalGaugeStore } from './gauge.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const origin = 'http://127.0.0.1:5180';
const status = { ready: true, messages: [], routes: [], generation_available: false, scope: 'Text only' };
function request(path: string, body?: unknown, foreign = false) {
  return new Request(
    origin + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-loom-local': '1',
            origin: foreign ? 'https://elsewhere.example' : origin,
          },
          body: JSON.stringify(body),
        },
  );
}
function api(
  extra: Partial<LocalTaskPorts> = {},
  recording: Partial<
    Pick<Parameters<typeof createLocalApi>[0], 'recordRun' | 'readGauge' | 'initial' | 'resetDisplay'>
  > = {},
) {
  const ports: LocalTaskPorts = {
    extract: async (task) => task.input,
    decide: async () => 'tool_call',
    split: async () => [],
    admitSplit: async () => false,
    act: async () => 'result',
    generate: async () => 'novel',
    ...extra,
  };
  return createLocalApi({
    origin,
    status,
    createPorts: () => ({ ports, stats: () => ({ calls: 0, spent: 0, reserved: 0 }) }),
    ...recording,
  });
}

test('empty workspace submits to the actual loop and exposes its settled evidence', async () => {
  const local = api();
  assert.equal(await (await local.handle(request('/api/run'))).json(), null);
  const accepted = await local.handle(request('/api/runs', { input: 'a test' }));
  assert.equal(accepted.status, 202);
  await local.settled();
  const run = (await (await local.handle(request('/api/run'))).json()) as NonNullable<
    ReturnType<typeof local.snapshot>
  >;
  assert.equal(run.result?.status, 'completed');
  assert.equal(run.result?.output, 'result');
  assert.ok(run.events.some((event: { stage: string }) => event.stage === 'decide'));
  assert.equal((await local.handle(request('/api/run/reset', {}))).status, 200);
  assert.equal(await (await local.handle(request('/api/run'))).json(), null);
});

test('concurrent submission, stale cancellation, cross-origin and oversized input are refused', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const local = api({
    act: async () => {
      await gate;
      return 'late';
    },
  });
  const run = (await (await local.handle(request('/api/runs', { input: 'work' }))).json()) as NonNullable<
    ReturnType<typeof local.snapshot>
  >;
  assert.equal((await local.handle(request('/api/runs', { input: 'second' }))).status, 409);
  assert.equal((await local.handle(request('/api/run/stop', { run_id: 'wrong' }))).status, 409);
  assert.equal((await local.handle(request('/api/run/stop', { run_id: run.id }, true))).status, 403);
  assert.equal((await local.handle(request('/api/run/stop', { run_id: run.id }))).status, 202);
  release();
  await local.settled();
  const stopped = (await (await local.handle(request('/api/run'))).json()) as NonNullable<
    ReturnType<typeof local.snapshot>
  >;
  assert.equal(stopped.result?.status, 'cancelled');
  assert.equal((await local.handle(request('/api/runs', { input: 'x'.repeat(16_001) }))).status, 400);
});

test('settlement archives Gauge evidence and restores the displayed run without re-executing it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'loom-api-gauge-'));
  try {
    const store = new LocalGaugeStore(directory);
    const local = api(
      { decide: async () => 'ask_human', clarify: async () => 'Which output format?' },
      {
        recordRun: (run) => store.save(run),
        readGauge: (key) => store.read(key),
        resetDisplay: () => store.resetDisplay(),
      },
    );
    await local.handle(request('/api/runs', { input: 'Convert the recipe PDF' }));
    await local.settled();
    assert.equal(local.snapshot()?.gauge?.verdict, 'meets_bar');
    const restored = api(
      {
        act: async () => {
          throw new Error('Restore must not execute.');
        },
      },
      { initial: new LocalGaugeStore(directory).latest() },
    );
    assert.equal(restored.snapshot()?.result?.question, 'Which output format?');
    const evidence = (await (await local.handle(request('/api/run/gauge'))).json()) as { records: unknown[] };
    assert.ok(evidence.records.length > 0);
    const key = local.snapshot()!.gauge!.key;
    await local.handle(request('/api/run/reset', {}));
    assert.equal(store.latest(), null);
    assert.ok(store.read(key));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a reply retains the original request and question, and rejects a stale question id', async () => {
  const inputs: string[] = [];
  const local = api({
    extract: async (task) => {
      inputs.push(task.input);
      return task.input;
    },
    decide: async (task) => (task.input.includes('OPERATOR ANSWER') ? 'tool_call' : 'ask_human'),
    clarify: async () => 'Which output format?',
  });
  await local.handle(request('/api/runs', { input: 'Convert the recipe PDF' }));
  await local.settled();
  const parent = local.snapshot()!.id;
  assert.equal((await local.handle(request('/api/runs', { input: 'Markdown', reply_to: 'wrong-run' }))).status, 409);
  assert.equal((await local.handle(request('/api/runs', { input: 'Markdown', reply_to: parent }))).status, 202);
  await local.settled();
  assert.equal(local.snapshot()?.parent_run, parent);
  assert.ok(inputs[1]?.includes('Convert the recipe PDF'));
  assert.ok(inputs[1]?.includes('Which output format?'));
  assert.ok(inputs[1]?.includes('Markdown'));
});

test('a recording failure remains visible and does not erase the actual execution result', async () => {
  const local = api(
    {},
    {
      recordRun: () => {
        throw new Error('disk unavailable');
      },
    },
  );
  await local.handle(request('/api/runs', { input: 'a test' }));
  await local.settled();
  assert.equal(local.snapshot()?.result?.status, 'completed');
  assert.ok(local.snapshot()?.recording_error?.includes('could not be saved'));
});
