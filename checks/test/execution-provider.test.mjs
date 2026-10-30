import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scenarios } from '../fixtures/execution-provider/contract.mjs';
import { ExecutionProviderDouble, makeDouble } from '../fixtures/execution-provider/doubles.mjs';

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
