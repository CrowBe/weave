/**
 * Composition-root bridge from a gateway generate adapter to shell.run@1.
 * Each call is one issued grant and one host.invoke. A decision answer is not
 * a grant and cannot be passed here: only GrantAuthority.issue produces one.
 */
import type { GrantAuthority, InvocationOutcome } from '@weave/agentsop';
import type { CliSpawn, CliSpawnRequest, CliSpawnResult } from '@weave/gateway/cli-generate';
import type { AgentFabricHost } from './host.js';
import { SHELL_RUN } from './shell-contracts.js';

export function createGrantedCliSpawn(options: {
  readonly host: AgentFabricHost;
  readonly authority: GrantAuthority;
  readonly issued_at?: number;
}): CliSpawn {
  let seq = 0;
  return {
    async run(request: CliSpawnRequest): Promise<CliSpawnResult> {
      const action_id = `shell-cli:${seq++}`;
      const grant = options.authority.issue({
        action_id,
        operation: SHELL_RUN.id,
        contract_rev: SHELL_RUN.revision,
        permissions: [{ resource: request.cwd_ref, mode: 'write' }],
        effects: [{ resource: request.cwd_ref, mode: 'write' }],
        process_effects: ['process.spawn', `fs.write:${request.cwd_ref}`],
        issued_at: options.issued_at ?? 0,
      });
      const invoked = options.host.invoke(grant, SHELL_RUN.id, {
        argv: [...request.argv],
        cwd_ref: request.cwd_ref,
        env_allow: [...request.env_allow],
        timeout_ms: request.timeout_ms,
        stdin: request.stdin,
      });
      if (invoked.kind === 'rejected') {
        return {
          status: 'failed',
          failure: invoked.code === 'DENIED' ? 'denied' : 'spawn_failed',
          stdout_tail: '',
          stderr_tail: '',
          duration_ms: 0,
        };
      }
      const cancel = (): void => {
        options.host.requestCancel(invoked.invocation_id);
      };
      if (request.signal !== undefined) {
        if (request.signal.aborted) {
          cancel();
        } else {
          request.signal.addEventListener('abort', cancel, { once: true });
        }
      }
      options.host.release(action_id);
      try {
        return mapShellOutcome(await invoked.result);
      } finally {
        request.signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

function mapShellOutcome(outcome: InvocationOutcome): CliSpawnResult {
  if (outcome.outcome === 'succeeded' && isShellOutput(outcome.output)) {
    return {
      status: 'completed',
      exit: outcome.output.exit,
      stdout_tail: outcome.output.stdout_tail,
      stderr_tail: outcome.output.stderr_tail,
      duration_ms: outcome.output.duration_ms,
    };
  }
  if (outcome.outcome === 'failed') {
    const failure = outcome.failure;
    if (failure === 'timeout' || failure === 'denied' || failure === 'spawn_failed' || failure === 'cancelled') {
      return { status: 'failed', failure, stdout_tail: '', stderr_tail: '', duration_ms: 0 };
    }
  }
  return { status: 'failed', failure: 'spawn_failed', stdout_tail: '', stderr_tail: '', duration_ms: 0 };
}

function isShellOutput(value: unknown): value is {
  exit: number;
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
    typeof record['stdout_tail'] === 'string' &&
    typeof record['stderr_tail'] === 'string' &&
    typeof record['duration_ms'] === 'number'
  );
}
