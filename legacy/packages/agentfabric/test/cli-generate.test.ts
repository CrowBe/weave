/**
 * Stub CLIs behind codex exec, claude -p, and grok. The prompt arrives on
 * stdin. Nonzero exits and timeouts become typed provider failures.
 * Nothing here invokes the real codex, claude, or grok binaries.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGrantAuthority, type GrantAuthority, type InvocationOutcome } from '@weave/agentsop';
import { AgentFabricHost, createGrantedCliSpawn } from '@weave/agentfabric';
import {
  claudePrintAdapter,
  codexExecAdapter,
  grokGenerateAdapter,
  type CliGenerateOptions,
} from '@weave/gateway/cli-generate';
import type { GenerationAdapter, GenerationCall } from '@weave/gateway';

const CANARY = 'canary-secret-9f3a2c7b-NOT-ON-ARGV';
const STUB = fileURLToPath(new URL('../../test/fixtures/stub-cli.mjs', import.meta.url));
const PROMPT = 'PROMPT-TOKEN-p7';
const INSTRUCTIONS = 'INST-TOKEN';

function testTime(): { clock: { now(): number }; timer: { sleep(ms: number, signal?: AbortSignal): Promise<void> } } {
  let now = 1_000;
  return {
    clock: { now: () => now },
    timer: {
      sleep(ms: number, signal?: AbortSignal) {
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          const handle = setTimeout(() => {
            now += ms;
            resolve();
          }, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(handle);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    },
  };
}

const vendors: readonly [string, (options: CliGenerateOptions) => GenerationAdapter][] = [
  ['codex', codexExecAdapter],
  ['claude', claudePrintAdapter],
  ['grok', grokGenerateAdapter],
];

async function withAdapter(
  factory: (options: CliGenerateOptions) => GenerationAdapter,
  stubArgs: readonly string[],
  timeout_ms: number,
  env_allow: readonly string[],
  run: (
    adapter: GenerationAdapter,
    host: AgentFabricHost,
    cwd: string,
    dir: string,
    authority: GrantAuthority,
  ) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'weave-p7-cli-'));
  const authority = createGrantAuthority();
  const time = testTime();
  const host = new AgentFabricHost({
    authority,
    shell: {
      env: {
        lookup(name: string) {
          return name === 'CANARY' ? CANARY : undefined;
        },
      },
      clock: time.clock,
      timer: time.timer,
    },
  });
  const cwd = host.registerWorkspace(dir);
  try {
    const adapter = factory({
      spawn: createGrantedCliSpawn({ host, authority }),
      cwd_ref: cwd,
      timeout_ms,
      env_allow,
      argv: [process.execPath, STUB, ...stubArgs],
    });
    await run(adapter, host, cwd, dir, authority);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForFile(file: string): Promise<void> {
  const started = Date.now();
  while (!existsSync(file) || readFileSync(file, 'utf8').trim() === '') {
    if (Date.now() - started > 5_000) {
      throw new Error('timed out waiting for the stub pid file');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function generation(prompt = PROMPT): GenerationCall {
  return {
    model: 'model-must-not-be-an-argument',
    instructions: INSTRUCTIONS,
    prompt,
    settings: { max_output_tokens: 16 },
    signal: undefined,
  };
}

describe('stub CLI generate adapters', () => {
  for (const [name, factory] of vendors) {
    it(`${name} delivers the prompt on stdin through shell.run`, async () => {
      await withAdapter(factory, ['--report'], 5_000, [], async (adapter, host) => {
        const result = await adapter.execute(generation());
        assert.equal(result.status, 'completed');
        if (result.status !== 'completed') {
          return;
        }
        const body = JSON.parse(result.text) as { argv: string[]; stdin: string };
        assert.equal(body.stdin.includes(PROMPT), true);
        assert.equal(body.stdin.includes(INSTRUCTIONS), true);
        assert.equal(JSON.stringify(body.argv).includes(PROMPT), false);
        assert.equal(JSON.stringify(body.argv).includes(INSTRUCTIONS), false);
        assert.equal(JSON.stringify(body.argv).includes('model-must-not-be-an-argument'), false);
        for (const record of host.spawnRecords()) {
          assert.equal(record.argv.join('\0').includes(PROMPT), false);
        }
        for (const trace of host.shellTraces()) {
          assert.equal(trace.argv.join('\0').includes(PROMPT), false);
          assert.equal(trace.schema, 'shell.trace@1');
          assert.equal(typeof trace.id, 'string');
          assert.equal('parentId' in trace, true);
        }
      });
    });

    it(`${name} fails explicitly when stdout exceeds the shell tail bound`, async () => {
      await withAdapter(factory, ['--flood', '20000'], 5_000, [], async (adapter) => {
        const result = await adapter.execute(generation());
        assert.equal(result.status, 'failed');
        if (result.status === 'failed') {
          assert.match(result.failure.message, /stdout.*truncated/);
          assert.equal(result.failure.retryable, false);
        }
      });
    });

    it(`${name} maps a nonzero stub exit to a typed failure`, async () => {
      await withAdapter(factory, ['--exit', '7'], 5_000, [], async (adapter) => {
        const result = await adapter.execute(generation());
        assert.equal(result.status, 'failed');
        if (result.status !== 'failed') {
          return;
        }
        assert.equal(result.failure.code, 'unavailable');
        assert.match(result.failure.message, /exited 7/);
        assert.equal(result.failure.message.includes(PROMPT), false);
      });
    });

    it(`${name} reports a reconciled stub timeout as a failure`, async () => {
      const pidFile = join(tmpdir(), `weave-p7-${name}-${process.pid}.pid`);
      try {
        await withAdapter(factory, ['--sleep', pidFile], 700, [], async (adapter, host) => {
          const result = await adapter.execute(generation());
          assert.equal(result.status, 'failed');
          if (result.status !== 'failed') return;
          assert.equal(result.failure.code, 'timeout');
          assert.equal(result.failure.message.includes(PROMPT), false);
          assert.equal(host.snapshot().invocations[0]?.reconciliation?.resolution, 'not_committed');
          assert.equal(host.coordinator.held().length, 0);
        });
      } finally {
        rmSync(pidFile, { force: true });
      }
    });
  }

  it('a failed execution carries the redacted tails and duration recorded in its trace', async () => {
    await withAdapter(codexExecAdapter, [], 5_000, [], async (_adapter, host, cwd, dir, authority) => {
      const spawn = createGrantedCliSpawn({ host, authority });
      const pidFile = join(dir, 'partial.pid');
      const abort = new AbortController();
      const pending = spawn.run({
        argv: [process.execPath, STUB, '--partial', pidFile],
        cwd_ref: cwd,
        env_allow: ['CANARY'],
        timeout_ms: 60_000,
        stdin: '',
        signal: abort.signal,
      });
      await waitForFile(pidFile);
      abort.abort();
      const cancelled = await pending;
      const cancelledTrace = host.shellTraces().at(-1);
      assert.deepEqual(cancelled, {
        status: 'uncertain',
        invocation_id: cancelledTrace?.id,
        reason: 'cancelled',
        failure: 'cancelled',
        stdout_tail: 'partial-out:[redacted]\n',
        stderr_tail: 'partial-err\n',
        duration_ms: cancelledTrace?.duration_ms,
      });
      assert.ok(cancelled.duration_ms > 0);
      assert.equal(JSON.stringify(cancelled).includes(CANARY), false);
      assert.ok(cancelledTrace);
      assert.equal(
        host.reconcile(cancelledTrace.id, {
          resolution: 'not_committed',
          evidence: 'stub completed no workspace writes',
        }).status,
        'stopped',
      );

      const signalled = await spawn.run({
        argv: [process.execPath, STUB, '--signal'],
        cwd_ref: cwd,
        env_allow: [],
        timeout_ms: 5_000,
        stdin: '',
      });
      assert.deepEqual(signalled, {
        status: 'failed',
        failure: 'killed',
        stdout_tail: '',
        stderr_tail: 'stub-signalled\n',
        duration_ms: host.shellTraces().at(-1)?.duration_ms,
      });
      assert.equal(host.snapshot().invocations.at(-1)?.reconciliation?.resolution, 'not_committed');
      assert.equal(host.coordinator.held().length, 0);
    });
  });

  for (const [reason, failure] of [
    ['shell_timeout', 'timeout'],
    ['shell_cancelled', 'cancelled'],
    ['shell_killed', 'killed'],
    ['shell_execution_fault', 'execution_fault'],
  ] as const) {
    it(`preserves ${reason} when replay has no in-memory shell trace`, async () => {
      const outcome: InvocationOutcome = { outcome: 'uncertain', reason };
      const host = {
        nextCliGenerationId: () => 'shell-replay',
        invokeCliGeneration: () => ({
          kind: 'handle',
          invocation_id: 'shell-replay',
          result: Promise.resolve(outcome),
        }),
        // A replayed handle has no open invocation, so the real host's release throws.
        openActionIds: () => [],
        release: () => {
          throw new Error('agentfabric: no open invocation for shell-replay');
        },
        shellTraces: () => [],
      } as unknown as AgentFabricHost;
      const spawn = createGrantedCliSpawn({ host, authority: createGrantAuthority() });
      assert.deepEqual(
        await spawn.run({ argv: ['stub'], cwd_ref: 'ref_ws', env_allow: [], timeout_ms: 1000, stdin: '' }),
        {
          status: 'uncertain',
          invocation_id: 'shell-replay',
          reason,
          failure,
          stdout_tail: '',
          stderr_tail: '',
          duration_ms: 0,
        },
      );
    });
  }

  it('redacts a canary injected for the codex adapter', async () => {
    await withAdapter(codexExecAdapter, ['--leak'], 5_000, ['CANARY'], async (adapter, host) => {
      const result = await adapter.execute(generation());
      assert.equal(result.status, 'completed');
      if (result.status !== 'completed') {
        return;
      }
      assert.equal(result.text.includes(CANARY), false);
      const blob = JSON.stringify({ traces: host.shellTraces(), spawns: host.spawnRecords(), text: result.text });
      assert.equal(blob.includes(CANARY), false);
    });
  });
});
