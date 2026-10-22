/**
 * CLI generate adapters keep the prompt on stdin. The spawn port is a fake
 * here; stub processes are covered by the Fabric host tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAUDE_PRINT_ARGV,
  CODEX_EXEC_ARGV,
  GROK_CLI_ARGV,
  claudePrintAdapter,
  codexExecAdapter,
  grokGenerateAdapter,
  type CliGenerateOptions,
  type CliSpawn,
  type CliSpawnRequest,
  type CliSpawnResult,
} from '@weave/gateway/cli-generate';
import type { GenerationAdapter, GenerationCall } from '@weave/gateway';

const call: GenerationCall = {
  model: 'model-must-not-be-an-argument',
  instructions: 'INST-TOKEN',
  prompt: 'PROMPT-TOKEN-p7',
  settings: { max_output_tokens: 16 },
  signal: undefined,
};

function recording(result: CliSpawnResult): { spawn: CliSpawn; seen: CliSpawnRequest[] } {
  const seen: CliSpawnRequest[] = [];
  return {
    seen,
    spawn: {
      async run(request) {
        seen.push(request);
        return result;
      },
    },
  };
}

const vendors: readonly [string, (options: CliGenerateOptions) => GenerationAdapter, readonly string[]][] = [
  ['codex', codexExecAdapter, CODEX_EXEC_ARGV],
  ['claude', claudePrintAdapter, CLAUDE_PRINT_ARGV],
  ['grok', grokGenerateAdapter, GROK_CLI_ARGV],
];

describe('cli generate adapters', () => {
  for (const [name, factory, argv] of vendors) {
    it(`${name} sends the prompt on stdin and not on argv`, async () => {
      const port = recording({
        status: 'completed',
        stdout_truncated: false,
        exit: 0,
        stdout_tail: 'ok',
        stderr_tail: '',
        duration_ms: 1,
      });
      const adapter = factory({ spawn: port.spawn, cwd_ref: 'ref_ws', timeout_ms: 1000 });
      const result = await adapter.execute(call);
      assert.equal(result.status, 'completed');
      assert.equal(port.seen.length, 1);
      const request = port.seen[0];
      assert.ok(request);
      assert.deepEqual(request.argv, [...argv]);
      assert.equal(request.stdin.includes('PROMPT-TOKEN-p7'), true);
      assert.equal(request.stdin.includes('INST-TOKEN'), true);
      assert.equal(request.argv.join('\0').includes('PROMPT-TOKEN-p7'), false);
      assert.equal(request.argv.join('\0').includes('INST-TOKEN'), false);
      assert.equal(request.argv.join('\0').includes('model-must-not-be-an-argument'), false);
      assert.equal(request.cwd_ref, 'ref_ws');
    });
  }

  it('does not report truncated stdout as a completed answer', async () => {
    const port = recording({
      status: 'completed',
      exit: 0,
      stdout_truncated: true,
      stdout_tail: 'partial answer',
      stderr_tail: '',
      duration_ms: 1,
    });
    const result = await claudePrintAdapter({ spawn: port.spawn, cwd_ref: 'ref_ws', timeout_ms: 1000 }).execute(call);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.match(result.failure.message, /stdout.*truncated/);
  });

  it('maps a nonzero exit and a timeout to typed failures', async () => {
    const nonzero = recording({
      status: 'completed',
      stdout_truncated: false,
      exit: 7,
      stdout_tail: 'PROMPT-TOKEN-p7',
      stderr_tail: '',
      duration_ms: 1,
    });
    const exited = await codexExecAdapter({ spawn: nonzero.spawn, cwd_ref: 'ref_ws', timeout_ms: 1000 }).execute(call);
    assert.equal(exited.status, 'failed');
    if (exited.status === 'failed') {
      assert.equal(exited.failure.code, 'unavailable');
      assert.match(exited.failure.message, /exited 7/);
      assert.equal(exited.failure.message.includes('PROMPT-TOKEN-p7'), false);
    }

    const timed = recording({ status: 'failed', failure: 'timeout', stdout_tail: '', stderr_tail: '', duration_ms: 4 });
    const timeout = await claudePrintAdapter({ spawn: timed.spawn, cwd_ref: 'ref_ws', timeout_ms: 1000 }).execute(call);
    assert.equal(timeout.status, 'failed');
    if (timeout.status === 'failed') {
      assert.equal(timeout.failure.code, 'timeout');
    }

    const denied = recording({ status: 'failed', failure: 'denied', stdout_tail: '', stderr_tail: '', duration_ms: 0 });
    const refusal = await grokGenerateAdapter({ spawn: denied.spawn, cwd_ref: 'ref_ws', timeout_ms: 1000 }).execute(
      call,
    );
    assert.equal(refusal.status, 'failed');
    if (refusal.status === 'failed') {
      assert.equal(refusal.failure.code, 'unauthorized');
    }
  });

  for (const [failure, message] of [
    ['killed', 'cli generate was killed'],
    ['execution_fault', 'cli generate execution failed'],
  ] as const) {
    it(`reports ${failure} without claiming a spawn failure`, async () => {
      const port = recording({ status: 'failed', failure, stdout_tail: '', stderr_tail: '', duration_ms: 1 });
      const result = await codexExecAdapter({ spawn: port.spawn, cwd_ref: 'ref_ws', timeout_ms: 1000 }).execute(call);
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') {
        assert.equal(result.failure.code, 'unavailable');
        assert.equal(result.failure.message, message);
        assert.equal(result.failure.retryable, false);
      }
    });
  }
});
