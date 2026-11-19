/**
 * The isolate's CPU budget is measured as CPU time, not wall time. A wall-clock
 * vm timeout alone failed trivial probes when a loaded machine descheduled the
 * child past 100ms; the watchdog now only interrupts runaway code.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IsolateRunner, isolatedCall } from '@weave/agentfabric';

describe('isolate CPU budget', () => {
  it('runs a trivial case and reports the 100ms CPU budget', async () => {
    const runner = new IsolateRunner('enforcing');
    const report = await runner.prove();
    assert.equal(report.supported, true);
    assert.equal(report.limits.cpu_ms, 100);
    const ran = await isolatedCall(runner, 'return input.a + input.b;', { a: 2, b: 3 });
    assert.deepEqual(ran, { ok: true, output: 5 });
  });

  it('stops runaway code and fails only that case', async () => {
    const runner = new IsolateRunner('enforcing');
    const results = await runner.runCases('for (;;) {}', [{ id: 'spin', input: null }]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, 'spin');
    assert.equal(results[0]?.output, undefined);
    assert.equal(results[0]?.error, 'Error');
  });
});
