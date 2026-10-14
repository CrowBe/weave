/**
 * shell.run@1 and the repo commands derived from it.
 * Repo argv is not part of the contract input. The host supplies it from config.
 */
import type { CapabilityContract, EffectSelector, ProcessEffectSelector } from '@weave/agentsop';

const WRITE_CWD: readonly EffectSelector[] = [{ input: 'cwd_ref', mode: 'write' }];

const PROCESS_EFFECTS: readonly ProcessEffectSelector[] = [
  { name: 'process.spawn' },
  { name: 'fs.write', input: 'cwd_ref' },
];

const SHELL_OUTPUT: CapabilityContract['output'] = {
  exit: 'integer',
  stdout_tail: 'string',
  stderr_tail: 'string',
  duration_ms: 'integer',
  artifacts: 'ResourceRef[]',
};

const SHELL_FAILURES = ['timeout', 'denied', 'spawn_failed', 'cancelled'] as const;

export const SHELL_RUN: CapabilityContract = {
  id: 'shell.run@1',
  revision: 'r1',
  purpose: 'Spawn one process from an argument vector in a granted workspace, without a shell',
  input: {
    argv: 'string[]',
    cwd_ref: 'ResourceRef',
    env_allow: 'string[]',
    timeout_ms: 'integer',
    stdin: 'string?',
  },
  output: SHELL_OUTPUT,
  effects: WRITE_CWD,
  permissions: WRITE_CWD,
  process_effects: PROCESS_EFFECTS,
  failures: SHELL_FAILURES,
  depends_on: [],
};

const REPO_INPUT: CapabilityContract['input'] = {
  cwd_ref: 'ResourceRef',
  env_allow: 'string[]',
  timeout_ms: 'integer',
};

function repoContract(id: string, purpose: string): CapabilityContract {
  return {
    id,
    revision: 'r1',
    purpose,
    input: REPO_INPUT,
    output: SHELL_OUTPUT,
    effects: WRITE_CWD,
    permissions: WRITE_CWD,
    process_effects: PROCESS_EFFECTS,
    failures: SHELL_FAILURES,
    depends_on: [SHELL_RUN.id],
  };
}

export const REPO_TEST = repoContract('repo.test', 'Run the configured test command in a granted workspace');
export const REPO_LINT = repoContract('repo.lint', 'Run the configured lint command in a granted workspace');
export const REPO_BUILD = repoContract('repo.build', 'Run the configured build command in a granted workspace');

export function shellCatalogue(includeRepo: boolean): readonly CapabilityContract[] {
  return includeRepo ? [SHELL_RUN, REPO_TEST, REPO_LINT, REPO_BUILD] : [SHELL_RUN];
}
