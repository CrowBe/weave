import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalApi } from './api.ts';
import type { LocalTaskPorts } from '@weave/weave';

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
function api(extra: Partial<LocalTaskPorts> = {}) {
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
