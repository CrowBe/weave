/**
 * Stub CLIs behind codex exec, claude -p, and grok. The prompt arrives on
 * stdin. Nonzero exits and timeouts become typed provider failures.
 * Nothing here invokes the real codex, claude, or grok binaries.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGrantAuthority } from '@weave/agentsop';
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
  run: (adapter: GenerationAdapter, host: AgentFabricHost) => Promise<void>,
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
    await run(adapter, host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

    it(`${name} maps a stub timeout to a typed failure`, async () => {
      const pidFile = join(tmpdir(), `weave-p7-${name}-${process.pid}.pid`);
      try {
        await withAdapter(factory, ['--sleep', pidFile], 700, [], async (adapter) => {
          const result = await adapter.execute(generation());
          assert.equal(result.status, 'failed');
          if (result.status !== 'failed') {
            return;
          }
          assert.equal(result.failure.code, 'timeout');
          assert.equal(result.failure.message.includes(PROMPT), false);
        });
      } finally {
        rmSync(pidFile, { force: true });
      }
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
