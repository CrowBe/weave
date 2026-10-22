/**
 * CLI generate backends. The prompt is written to stdin and never appended
 * to argv. This module does not spawn: `spawn` is the grant-enforced port
 * supplied by the composition root (`createGrantedCliSpawn`).
 */
import type { GenerationAdapter, GenerationCall, GenerationProviderResult, ProviderFailure } from '../types.js';

export const CODEX_EXEC_ADAPTER = 'codex-exec';
export const CLAUDE_PRINT_ADAPTER = 'claude-print';
export const GROK_CLI_ADAPTER = 'grok-cli';

export const CODEX_EXEC_ARGV = ['codex', 'exec'] as const;
export const CLAUDE_PRINT_ARGV = ['claude', '-p'] as const;
export const GROK_CLI_ARGV = ['grok'] as const;

export type CliSpawnFailure =
  | 'timeout'
  | 'denied'
  | 'spawn_failed'
  | 'cancelled'
  | 'killed'
  | 'execution_fault'
  | 'workspace_held'
  | 'effect_conflict';

export interface CliSpawnRequest {
  readonly argv: readonly string[];
  readonly cwd_ref: string;
  readonly env_allow: readonly string[];
  readonly timeout_ms: number;
  readonly stdin: string;
  readonly signal?: AbortSignal;
}

export type CliSpawnResult =
  | {
      readonly status: 'uncertain';
      readonly invocation_id: string;
      readonly reason: string;
      readonly failure: CliSpawnFailure;
      readonly stdout_tail: string;
      readonly stderr_tail: string;
      readonly duration_ms: number;
    }
  | {
      readonly status: 'completed';
      readonly exit: number;
      readonly stdout_truncated: boolean;
      readonly stdout_tail: string;
      readonly stderr_tail: string;
      readonly duration_ms: number;
    }
  | {
      readonly status: 'failed';
      readonly failure: CliSpawnFailure;
      readonly held_by?: string;
      readonly hint?: string;
      readonly stdout_tail: string;
      readonly stderr_tail: string;
      readonly duration_ms: number;
    };

/** Grant-enforced process spawn. Implementations live outside the gateway. */
export interface CliSpawn {
  run(request: CliSpawnRequest): Promise<CliSpawnResult>;
}

export interface CliGenerateOptions {
  readonly spawn: CliSpawn;
  readonly cwd_ref: string;
  readonly timeout_ms: number;
  readonly env_allow?: readonly string[];
  /** Replaces the vendor argv. The prompt is still not added. */
  readonly argv?: readonly string[];
}

export function codexExecAdapter(options: CliGenerateOptions): GenerationAdapter {
  return cliAdapter(CODEX_EXEC_ADAPTER, CODEX_EXEC_ARGV, options);
}

export function claudePrintAdapter(options: CliGenerateOptions): GenerationAdapter {
  return cliAdapter(CLAUDE_PRINT_ADAPTER, CLAUDE_PRINT_ARGV, options);
}

export function grokGenerateAdapter(options: CliGenerateOptions): GenerationAdapter {
  return cliAdapter(GROK_CLI_ADAPTER, GROK_CLI_ARGV, options);
}

function cliAdapter(id: string, defaultArgv: readonly string[], options: CliGenerateOptions): GenerationAdapter {
  if (!Number.isInteger(options.timeout_ms) || options.timeout_ms < 1) {
    throw new Error(`${id} timeout_ms must be a positive integer`);
  }
  if (options.cwd_ref.length === 0) {
    throw new Error(`${id} requires a workspace reference`);
  }
  const argv = Object.freeze([...(options.argv ?? defaultArgv)]);
  if (argv.length === 0 || argv.some((part) => part.length === 0)) {
    throw new Error(`${id} requires a non-empty argv`);
  }
  const env_allow = Object.freeze([...(options.env_allow ?? [])]);
  return {
    id,
    await_on_abort: true,
    async execute(call: GenerationCall): Promise<GenerationProviderResult> {
      const result = await options.spawn.run({
        argv,
        cwd_ref: options.cwd_ref,
        env_allow,
        timeout_ms: options.timeout_ms,
        stdin: promptOnStdin(call),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      return toProvider(result);
    },
  };
}

function promptOnStdin(call: GenerationCall): string {
  const instructions = call.instructions.trim();
  if (instructions.length === 0) {
    return call.prompt;
  }
  return `${instructions}\n\n${call.prompt}`;
}

function toProvider(result: CliSpawnResult): GenerationProviderResult {
  if (result.status === 'uncertain') {
    return { status: 'uncertain', invocation_id: result.invocation_id, reason: result.reason };
  }
  if (result.status === 'failed') {
    if (result.failure === 'workspace_held' || result.failure === 'effect_conflict') {
      return {
        status: 'failed',
        failure: {
          code: result.failure,
          retryable: false,
          message:
            result.hint ??
            (result.failure === 'workspace_held'
              ? 'cli generate workspace is held by an uncertain invocation; list and reconcile with examples/cli-generations.ts --store JOURNAL list | reconcile'
              : 'cli generate effects conflict with another invocation'),
          ...(result.held_by === undefined ? {} : { held_by: result.held_by }),
        },
      };
    }
    if (result.failure === 'timeout') {
      return failed('timeout', 'cli generate timed out');
    }
    if (result.failure === 'denied') {
      return failed('unauthorized', 'cli generate denied');
    }
    if (result.failure === 'cancelled') {
      return failed('cancelled', 'cli generate cancelled');
    }
    if (result.failure === 'killed') {
      return failed('unavailable', 'cli generate was killed');
    }
    if (result.failure === 'execution_fault') {
      return failed('unavailable', 'cli generate execution failed');
    }
    return failed('unavailable', 'cli generate failed to spawn');
  }
  if (result.exit !== 0) {
    return failed('unavailable', `cli generate exited ${result.exit}`);
  }
  if (result.stdout_truncated) {
    return failed('unavailable', 'cli generate stdout was truncated');
  }
  return {
    status: 'completed',
    text: result.stdout_tail,
    usage: { input_tokens: undefined, output_tokens: undefined },
    finish_reason: 'stop',
    provider_response_id: undefined,
  };
}

function failed(code: ProviderFailure['code'], message: string): GenerationProviderResult {
  return { status: 'failed', failure: { code, message, retryable: false } };
}
