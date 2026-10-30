import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { scenarios } from '../fixtures/execution-provider/contract.mjs';
import { ExecutionProviderDouble, makeDouble } from '../fixtures/execution-provider/doubles.mjs';

test('raw red runner lives outside default Node test discovery', async () => {
  await access(new URL('../fixtures/execution-provider/red.mjs', import.meta.url));
  await assert.rejects(access(new URL('../fixtures/execution-provider/red.test.mjs', import.meta.url)), {
    code: 'ENOENT',
  });
});

test('execution-provider probes preserve research IDs X-T01–X-T10', () => {
  assert.deepEqual(
    scenarios.map(({ id }) => id),
    Array.from({ length: 10 }, (_, n) => `X-T${String(n + 1).padStart(2, '0')}`),
  );
});

test('scripted provider exposes start/resume/dump/restore/close without executing source', async () => {
  const provider = new ExecutionProviderDouble();
  const program = { source: 'not executable: fixture only', digest: 'fixture-digest', language: 'fixture@1' };
  const offered = [{ capability: 'doc.write', revision: 'r1', input: { ref: 'reference' } }];
  const limits = { deadline: 10, memory_bytes: 1024 };
  const report = await provider.isolationReport();
  assert.equal(report.os_isolation, 'enforced');
  const suspended = await provider.start(program, offered, limits);
  assert.equal(suspended.kind, 'suspended');
  assert.deepEqual(provider.calls[1], { method: 'start', program, offered, limits });
  const bytes = await provider.dump();
  assert.ok(bytes instanceof Uint8Array);
  await provider.close();
  await provider.close();
  assert.equal(provider.worker, false);
  assert.equal(provider.calls.filter(({ method }) => method === 'close').length, 1);
  assert.equal((await provider.resume(suspended.call_id, { kind: 'value', value: 1 })).code, 'INVALID_STATE');

  const restored = new ExecutionProviderDouble();
  assert.deepEqual(await restored.restore(bytes), suspended);
  assert.equal((await restored.resume('wrong-call', { kind: 'value', value: 1 })).code, 'INVALID_STATE');
  assert.equal(restored.state, 'suspended');
  assert.deepEqual(await restored.resume(suspended.call_id, { kind: 'value', value: 1 }), {
    kind: 'completed',
    output: 'done',
  });
  assert.equal((await restored.resume(suspended.call_id, { kind: 'value', value: 1 })).code, 'INVALID_STATE');
  await restored.close();
});

for (const scenario of scenarios) {
  test(`${scenario.id} rejects its invalid double with the required contract assertion`, async () => {
    await assert.rejects(
      () => scenario.check(makeDouble(scenario.id, true)),
      (error) =>
        error instanceof assert.AssertionError &&
        error.code === 'ERR_ASSERTION' &&
        error.message.split('\n')[0] === scenario.failure,
    );
  });
  test(`${scenario.id} scripted positive control satisfies the same probe`, () =>
    scenario.check(makeDouble(scenario.id)));
}

for (const [id, defect, failure] of [
  ['X-T03', 'duplicate-approval', 'X-T03: duplicate approval never repeats invocation'],
  ['X-T05', 'wrong-identity-lookup', 'X-T05: recovery looks up the recorded invocation identity'],
  ['X-T05', 'ignore-restored-call', 'X-T05: changed restored call is refused before lookup'],
  ['X-T06', 'late-time', 'X-T06: time trip stays within the deadline'],
  ['X-T06', 'late-memory', 'X-T06: memory trip stays within the deadline'],
  ['X-T09', 'missed-kill', 'X-T09: running cancellation kills the worker'],
  ['X-T10', 'unbounded-checkout', 'X-T10: worker checkout has a finite positive deadline'],
]) {
  test(`${id} rejects independent defect: ${defect}`, async () => {
    const scenario = scenarios.find((candidate) => candidate.id === id);
    await assert.rejects(
      () => scenario.check(makeDouble(id, defect)),
      (error) =>
        error instanceof assert.AssertionError &&
        error.code === 'ERR_ASSERTION' &&
        error.message.split('\n')[0] === failure,
    );
  });
}
