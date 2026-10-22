/**
 * Composition-root bridge from a gateway generate adapter to shell.run@1.
 * Each call is one issued grant and one host.invoke. A decision answer is not
 * a grant and cannot be passed here: only GrantAuthority.issue produces one.
 */
import type { GrantAuthority, InvocationOutcome } from '@weave/agentsop';
import type { CliSpawn, CliSpawnFailure, CliSpawnRequest, CliSpawnResult } from '@weave/gateway/cli-generate';
import type { AgentFabricHost } from './host.js';
import { SHELL_RUN } from './shell-contracts.js';
import type { ShellTraceRecord } from './shell.js';

export function createGrantedCliSpawn(options: {
  readonly host: AgentFabricHost;
  readonly authority: GrantAuthority;
  readonly issued_at?: number;
}): CliSpawn {
  return {
    async run(request: CliSpawnRequest): Promise<CliSpawnResult> {
      const action_id = options.host.nextCliGenerationId();
      const grant = options.authority.issue({
        action_id,
        operation: SHELL_RUN.id,
        contract_rev: SHELL_RUN.revision,
        permissions: [{ resource: request.cwd_ref, mode: 'write' }],
        effects: [{ resource: request.cwd_ref, mode: 'write' }],
        process_effects: ['process.spawn', `fs.write:${request.cwd_ref}`],
        issued_at: options.issued_at ?? 0,
      });
      const cancel = (): void => {
        options.host.requestCancel(action_id);
      };
      try {
        if (request.signal?.aborted) {
          cancel();
        } else {
          request.signal?.addEventListener('abort', cancel, { once: true });
        }
        const invoked = await options.host.invokeCliGeneration(grant, {
          argv: [...request.argv],
          cwd_ref: request.cwd_ref,
          env_allow: [...request.env_allow],
          timeout_ms: request.timeout_ms,
          stdin: request.stdin,
        });
        if (invoked.kind === 'cancelled') {
          return mapShellOutcome({ outcome: 'failed', failure: 'cancelled' }, undefined, invoked.invocation_id);
        }
        if (invoked.kind === 'rejected') {
          const conflict = invoked.workspace_conflict;
          const reconciliation =
            invoked.code === 'RESOLVER_ERROR' && invoked.reason.startsWith('operation requires reconciliation');
          return {
            status: 'failed',
            failure: reconciliation
              ? 'workspace_held'
              : conflict
                ? conflict.uncertain
                  ? 'workspace_held'
                  : 'effect_conflict'
                : invoked.code === 'DENIED'
                  ? 'denied'
                  : 'spawn_failed',
            ...(conflict ? { held_by: conflict.invocation_id } : {}),
            ...(reconciliation || conflict?.uncertain
              ? {
                  hint: 'List and reconcile workspace holds with examples/cli-generations.ts --store JOURNAL list | reconcile --invocation ID --resolution not_committed --evidence TEXT [--force-with-evidence].',
                }
              : {}),
            stdout_tail: '',
            stderr_tail: '',
            duration_ms: 0,
          };
        }
        // A replayed handle has no open invocation to advance; its result is already settled.
        if (options.host.openActionIds().includes(action_id)) options.host.release(action_id);
        const outcome = await invoked.result;
        // Failure and uncertainty outcomes carry their reason; redacted tails and duration stay in the trace.
        const trace = options.host
          .shellTraces()
          .filter((record) => record.id === invoked.invocation_id && record.parentId === null)
          .at(-1);
        return mapShellOutcome(outcome, trace, invoked.invocation_id);
      } finally {
        request.signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

function mapShellOutcome(
  outcome: InvocationOutcome,
  trace: ShellTraceRecord | undefined,
  invocation_id: string,
): CliSpawnResult {
  if (outcome.outcome === 'succeeded' && isShellOutput(outcome.output)) {
    return {
      status: 'completed',
      exit: outcome.output.exit,
      stdout_truncated: outcome.output.stdout_truncated,
      stdout_tail: outcome.output.stdout_tail,
      stderr_tail: outcome.output.stderr_tail,
      duration_ms: outcome.output.duration_ms,
    };
  }
  const failure =
    outcome.outcome === 'failed' ? outcome.failure : outcome.outcome === 'uncertain' ? outcome.reason : null;
  return {
    ...(outcome.outcome === 'uncertain'
      ? { status: 'uncertain' as const, invocation_id, reason: outcome.reason }
      : { status: 'failed' as const }),
    failure: shellFailure(failure) ?? shellFailure(trace?.failure ?? null) ?? 'execution_fault',
    stdout_tail: trace?.stdout_tail ?? '',
    stderr_tail: trace?.stderr_tail ?? '',
    duration_ms: trace?.duration_ms ?? 0,
  };
}

function shellFailure(reason: string | null): CliSpawnFailure | undefined {
  switch (reason) {
    case 'shell_timeout':
    case 'timeout':
      return 'timeout';
    case 'shell_cancelled':
    case 'cancelled':
      return 'cancelled';
    case 'shell_killed':
    case 'killed':
      return 'killed';
    case 'shell_execution_fault':
    case 'execution_fault':
      return 'execution_fault';
    case 'denied':
      return 'denied';
    case 'spawn_failed':
      return 'spawn_failed';
    default:
      return undefined;
  }
}

function isShellOutput(value: unknown): value is {
  exit: number;
  stdout_truncated: boolean;
  stdout_tail: string;
  stderr_tail: string;
  duration_ms: number;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['exit'] === 'number' &&
    typeof record['stdout_truncated'] === 'boolean' &&
    typeof record['stdout_tail'] === 'string' &&
    typeof record['stderr_tail'] === 'string' &&
    typeof record['duration_ms'] === 'number'
  );
}
