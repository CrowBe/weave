import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  createInferenceGateway,
  type GenerationCall,
  type GenerationRequest,
  type RoutedUnit,
  type Timer,
} from '@weave/gateway';
import { codexExecAdapter, type CliSpawnResult } from '@weave/gateway/cli-generate';

const call: GenerationCall = {
  model: 'cli',
  instructions: '',
  prompt: 'generate',
  settings: { max_output_tokens: 10 },
  signal: undefined,
};
const uncertain: CliSpawnResult = {
  status: 'uncertain',
  invocation_id: 'cli-cancelled-1',
  reason: 'cancelled',
  failure: 'cancelled',
  stdout_tail: '',
  stderr_tail: '',
  duration_ms: 1,
};
const unit: RoutedUnit = {
  routed_unit_id: 'cli.primary',
  operation: 'generate',
  kind: 'transform',
  context_profile: 'test',
  context_profile_version: 1,
  prompt_template: 'test',
  prompt_template_version: 1,
  adapter: 'codex-exec',
  model: 'cli',
  settings: { max_output_tokens: 10 },
  destination: 'local',
  quality: 'baseline',
  context_limit_tokens: 100,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
};
const request: GenerationRequest = {
  request_id: 'cli-test',
  site: 'test',
  role: 'working',
  kind: 'transform',
  input: { instructions: '', prompt: 'generate' },
  terms: {
    quality: 'baseline',
    destinations: ['local'],
    max_context_tokens: 10,
    deadline: 100,
    cost_ceiling: 0,
    max_attempts: 3,
  },
};

it('preserves CLI uncertainty and its invocation identity through the adapter', async () => {
  const adapter = codexExecAdapter({
    spawn: {
      async run() {
        return uncertain;
      },
    },
    cwd_ref: 'workspace',
    timeout_ms: 10,
  });
  assert.deepEqual(await adapter.execute(call), {
    status: 'uncertain',
    invocation_id: 'cli-cancelled-1',
    reason: 'cancelled',
  });
});

for (const failure of ['workspace_held', 'effect_conflict'] as const) {
  it(`preserves ${failure} and its hold owner without claiming a spawn failure`, async () => {
    const adapter = codexExecAdapter({
      spawn: {
        async run() {
          return {
            status: 'failed',
            failure,
            held_by: 'cli-cancelled-1',
            stdout_tail: '',
            stderr_tail: '',
            duration_ms: 0,
          };
        },
      },
      cwd_ref: 'workspace',
      timeout_ms: 10,
    });
    const result = await adapter.execute(call);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure.code, failure);
    assert.equal(result.failure.held_by, 'cli-cancelled-1');
    assert.equal(result.failure.retryable, false);
    assert.doesNotMatch(result.failure.message, /spawn/);
  });
}

it('surfaces an uncertain attempt and stops without retrying or falling back', async () => {
  let calls = 0;
  const adapter = codexExecAdapter({
    spawn: {
      async run() {
        calls += 1;
        return uncertain;
      },
    },
    cwd_ref: 'workspace',
    timeout_ms: 10,
  });
  const gateway = createInferenceGateway({
    routes: [unit, { ...unit, routed_unit_id: 'cli.fallback' }],
    adapters: [adapter],
    clock: { now: () => 0 },
  });
  const result = await gateway.generate(request);
  const attempts = result.attempts;
  assert.equal(result.status, 'uncertain');
  assert.equal(result.invocation_id, 'cli-cancelled-1');
  assert.deepEqual(attempts[0]?.disposition, {
    status: 'uncertain',
    invocation_id: 'cli-cancelled-1',
    reason: 'cancelled',
  });
  assert.equal(calls, 1);
});

it('awaits the grant-enforced CLI result after cancellation with an injected timer', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let complete!: (result: CliSpawnResult) => void;
  const caller = new AbortController();
  const timer: Timer = {
    sleep(_ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
  const adapter = codexExecAdapter({
    spawn: {
      run() {
        started();
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    },
    cwd_ref: 'workspace',
    timeout_ms: 10,
  });
  const gateway = createInferenceGateway({ routes: [unit], adapters: [adapter], clock: { now: () => 0 }, timer });
  let settled = false;
  const pending = gateway.generate(request, caller.signal).then((result) => {
    settled = true;
    return result;
  });
  await ready;
  caller.abort();
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  assert.equal(settled, false, 'the held invocation must remain observable while CLI cancellation settles');
  complete(uncertain);
  const result = await pending;
  assert.equal(result.status, 'uncertain');
  assert.equal(result.invocation_id, 'cli-cancelled-1');
});
