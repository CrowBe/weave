import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, SHELL_RUN } from '@weave/agentfabric';
import { cliGenerations } from './cli-generations.ts';

it('the operator command lists retained CLI generations and durably reconciles one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-generations-command-'));
  const path = join(dir, 'fabric.jsonl');
  try {
    const store = FabricStore.open(path);
    const host = new AgentFabricHost({ authority: createGrantAuthority(), store });
    const cwd_ref = host.registerWorkspace(dir);
    store.persistInvocationStart({
      invocation_id: 'shell-cli:0',
      action_id: 'shell-cli:0',
      operation: 'shell.run@1',
      implementation_id: 'builtin',
      binding_digest: 'binding',
      inputs: { cwd_ref },
      status: 'running',
      outcome: null,
      cancel_requested: true,
      reservation: [{ resource: store.lookupRef(cwd_ref)!.canonical_id, mode: 'write' }],
      cli_generation: { cwd_ref, before_snapshot: null },
    });
    store.close();
    const args = ['--store', path];
    assert.deepEqual(await cliGenerations([...args, 'list']), [
      {
        invocation_id: 'shell-cli:0',
        cwd_ref,
        reason: 'execution outcome requires reconciliation after restart',
        startup_check: 'process_group_unknown',
      },
    ]);
    assert.deepEqual(
      await cliGenerations([
        ...args,
        'reconcile',
        '--invocation',
        'shell-cli:0',
        '--resolution',
        'not_committed',
        '--evidence',
        'operator inspected',
        '--force-with-evidence',
      ]),
      { invocation_id: 'shell-cli:0', status: 'stopped', resolution: 'not_committed' },
    );
    assert.deepEqual(await cliGenerations([...args, 'list']), []);
    await assert.rejects(
      async () =>
        cliGenerations([
          ...args,
          'reconcile',
          '--invocation',
          'shell-cli:0',
          '--resolution',
          'not_committed',
          '--evidence',
          'again',
        ]),
      /reconciled|conflicts/,
    );

    const priorStartup = FabricStore.open(path);
    priorStartup.persistInvocationStart({
      invocation_id: 'shell-cli:1',
      action_id: 'shell-cli:1',
      operation: 'shell.run@1',
      binding_digest: 'next',
      inputs: { cwd_ref },
      status: 'running',
      outcome: null,
      cancel_requested: true,
      cli_generation: { cwd_ref, before_snapshot: null },
    });
    new AgentFabricHost({ authority: createGrantAuthority(), store: priorStartup }).reconcileCliGeneration(
      'shell-cli:1',
      {
        resolution: 'not_committed',
        evidence: 'workspace snapshot unchanged: historical',
        force_with_evidence: true,
      },
    );
    priorStartup.close();
    await assert.rejects(
      async () =>
        cliGenerations([
          ...args,
          'reconcile',
          '--invocation',
          'shell-cli:1',
          '--resolution',
          'committed',
          '--evidence',
          'again',
          '--output',
          '{}',
        ]),
      /reconciled|conflicts/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('the operator command validates resolution and evidence before opening a journal', async () => {
  await assert.rejects(async () => cliGenerations(['list']), /usage/);
  await assert.rejects(
    async () => cliGenerations(['--store', '/unused', 'reconcile', '--invocation', 'id']),
    /evidence/,
  );
  await assert.rejects(
    async () =>
      cliGenerations([
        '--store',
        '/unused',
        'reconcile',
        '--invocation',
        'id',
        '--evidence',
        'inspected',
        '--resolution',
        'committed',
        '--output',
        '{',
      ]),
    /must be JSON/,
  );
});

it('refuses live-group releases unless forced with evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-generations-safety-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const path = join(dir, 'fabric.jsonl');
  try {
    const store = FabricStore.open(path);
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({
      authority,
      store,
      shell: {
        env: { lookup: () => undefined },
        clock: { now: () => 0 },
        timer: { sleep: async () => {} },
      },
    });
    const cwd_ref = host.registerWorkspace(workspace);
    const grant = authority.issue({
      action_id: 'shell-cli:0',
      operation: SHELL_RUN.id,
      contract_rev: SHELL_RUN.revision,
      permissions: [{ resource: cwd_ref, mode: 'write' }],
      effects: [{ resource: cwd_ref, mode: 'write' }],
      process_effects: ['process.spawn', `fs.write:${cwd_ref}`],
      issued_at: 0,
    });
    const invocation = await host.invokeCliGeneration(grant, {
      argv: [process.execPath],
      cwd_ref,
      env_allow: [],
      timeout_ms: 1000,
      stdin: '',
    });
    assert.equal(invocation.kind, 'handle');
    // Simulate the durable start of an orphan without creating a real orphan.
    const started = store.getInvocation('shell-cli:0')!;
    store.persistInvocationStart({
      ...started,
      invocation_id: 'shell-cli:orphan',
      action_id: 'shell-cli:orphan',
      cli_generation: { ...started.cli_generation!, pgid: 12345 },
    });
    store.close();
    const args = ['--store', path, 'reconcile', '--invocation', 'shell-cli:orphan', '--evidence', 'inspected'];
    const run = (rest: string[], state: 'alive' | 'gone' | 'unknown') =>
      cliGenerations([...args, ...rest], { cliProcessGroupProbe: () => state });
    await assert.rejects(async () => run(['--resolution', 'not_committed'], 'alive'), /process group/);
    const live = FabricStore.open(path);
    live.persistInvocationStart({
      invocation_id: 'shell-cli:1',
      action_id: 'shell-cli:1',
      operation: SHELL_RUN.id,
      binding_digest: 'live',
      inputs: { cwd_ref },
      status: 'running',
      outcome: null,
      cancel_requested: true,
      cli_generation: { cwd_ref, before_snapshot: null, pgid: 12346 },
    });
    live.close();
    assert.deepEqual(
      await cliGenerations(
        [
          '--store',
          path,
          'reconcile',
          '--invocation',
          'shell-cli:1',
          '--resolution',
          'not_committed',
          '--evidence',
          'operator verified stopped effects',
          '--force-with-evidence',
        ],
        { cliProcessGroupProbe: () => 'alive' },
      ),
      { invocation_id: 'shell-cli:1', status: 'stopped', resolution: 'not_committed' },
    );
    const resolved = FabricStore.open(path);
    try {
      assert.match(resolved.getInvocation('shell-cli:1')!.reconciliation!.evidence, /^forced process-group override:/);
    } finally {
      resolved.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('exits nonzero when a requested resolution conflicts with startup reconciliation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-generations-safety-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const path = join(dir, 'fabric.jsonl');
  try {
    const store = FabricStore.open(path);
    const authority = createGrantAuthority();
    const host = new AgentFabricHost({
      authority,
      store,
      shell: {
        env: { lookup: () => undefined },
        clock: { now: () => 0 },
        timer: { sleep: async () => {} },
      },
    });
    const cwd_ref = host.registerWorkspace(workspace);
    const grant = authority.issue({
      action_id: 'shell-cli:0',
      operation: SHELL_RUN.id,
      contract_rev: SHELL_RUN.revision,
      permissions: [{ resource: cwd_ref, mode: 'write' }],
      effects: [{ resource: cwd_ref, mode: 'write' }],
      process_effects: ['process.spawn', `fs.write:${cwd_ref}`],
      issued_at: 0,
    });
    const invocation = await host.invokeCliGeneration(grant, {
      argv: [process.execPath],
      cwd_ref,
      env_allow: [],
      timeout_ms: 1000,
      stdin: '',
    });
    assert.equal(invocation.kind, 'handle');
    // Simulate the durable start of an orphan without creating a real orphan.
    const started = store.getInvocation('shell-cli:0')!;
    store.persistInvocationStart({
      ...started,
      invocation_id: 'shell-cli:orphan',
      action_id: 'shell-cli:orphan',
      cli_generation: { ...started.cli_generation!, pgid: 12345 },
    });
    store.close();
    const args = ['--store', path, 'reconcile', '--invocation', 'shell-cli:orphan', '--evidence', 'inspected'];
    const run = (rest: string[], state: 'alive' | 'gone' | 'unknown') =>
      cliGenerations([...args, ...rest], { cliProcessGroupProbe: () => state });
    await assert.rejects(
      async () => run(['--resolution', 'committed', '--output', '{}'], 'gone'),
      /conflicts.*not_committed/,
    );
    await assert.rejects(
      async () => run(['--resolution', 'committed', '--output', '{}'], 'gone'),
      /conflicts.*not_committed/,
    );
    const stderrPath = join(dir, 'command.stderr');
    const stderrFd = openSync(stderrPath, 'w');
    let commandCode: number | null;
    try {
      commandCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL('./cli-generations.ts', import.meta.url)),
            ...args,
            '--resolution',
            'committed',
            '--output',
            '{}',
          ],
          { stdio: ['ignore', 'ignore', stderrFd] },
        );
        child.on('error', reject);
        child.on('close', resolve);
      });
    } finally {
      closeSync(stderrFd);
    }
    assert.equal(commandCode, 1);
    assert.match(readFileSync(stderrPath, 'utf8'), /conflicts.*not_committed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const kind of ['shell step', 'shell-cli', 'cli_generation', 'legacy block', 'other writer'] as const) {
  it(`lists and safely reconciles a CLI workspace blocked by ${kind}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-any-hold-'));
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const path = join(dir, 'fabric.jsonl');
    try {
      const store = FabricStore.open(path);
      const host = new AgentFabricHost({ authority: createGrantAuthority(), store });
      const cwd_ref = host.registerWorkspace(workspace);
      const id = kind === 'shell-cli' ? 'shell-cli:hold' : 'held';
      store.persistInvocationStart({
        invocation_id: id,
        action_id: id,
        operation: kind === 'other writer' ? 'test.write@1' : SHELL_RUN.id,
        binding_digest: 'held',
        inputs: kind === 'legacy block' ? {} : { cwd_ref },
        status: 'running',
        outcome: null,
        cancel_requested: true,
        ...(kind === 'legacy block'
          ? {}
          : { reservation: [{ resource: store.lookupRef(cwd_ref)!.canonical_id, mode: 'write' as const }] }),
        ...(kind === 'cli_generation' ? { cli_generation: { cwd_ref, before_snapshot: null, pgid: 12345 } } : {}),
      });
      store.close();
      const args = ['--store', path];
      const listed = (await cliGenerations([...args, 'list'])) as { invocation_id: string }[];
      assert.deepEqual(
        listed.map((entry) => entry.invocation_id),
        [id],
      );
      const reconcile = [
        ...args,
        'reconcile',
        '--invocation',
        id,
        '--resolution',
        'not_committed',
        '--evidence',
        'operator verified effects',
      ];
      await assert.rejects(() => cliGenerations(reconcile, { cliProcessGroupProbe: () => 'gone' }), {
        message:
          kind === 'cli_generation'
            ? 'workspace snapshot is changed or unavailable; explicit evidence and force_with_evidence required'
            : 'no CLI process evidence exists; explicit evidence and force_with_evidence required',
      });
      assert.deepEqual(await cliGenerations([...reconcile, '--force-with-evidence']), {
        invocation_id: id,
        status: 'stopped',
        resolution: 'not_committed',
      });
      assert.deepEqual(await cliGenerations([...args, 'list']), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it('default operator reconciliation retains a changed workspace even with a gone process group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-changed-hold-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const path = join(dir, 'fabric.jsonl');
  try {
    const store = FabricStore.open(path);
    const host = new AgentFabricHost({ authority: createGrantAuthority(), store });
    const cwd_ref = host.registerWorkspace(workspace);
    store.persistInvocationStart({
      invocation_id: 'shell-cli:changed',
      action_id: 'shell-cli:changed',
      operation: SHELL_RUN.id,
      binding_digest: 'changed',
      inputs: { cwd_ref },
      status: 'running',
      outcome: null,
      cancel_requested: true,
      reservation: [{ resource: store.lookupRef(cwd_ref)!.canonical_id, mode: 'write' }],
      cli_generation: { cwd_ref, before_snapshot: 'a'.repeat(64), pgid: 12345 },
    });
    store.close();
    const args = [
      '--store',
      path,
      'reconcile',
      '--invocation',
      'shell-cli:changed',
      '--resolution',
      'not_committed',
      '--evidence',
      'inspected',
    ];
    await assert.rejects(() => cliGenerations(args, { cliProcessGroupProbe: () => 'gone' }), /snapshot|workspace/);
    assert.deepEqual(await cliGenerations([...args, '--force-with-evidence'], { cliProcessGroupProbe: () => 'gone' }), {
      invocation_id: 'shell-cli:changed',
      status: 'stopped',
      resolution: 'not_committed',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
