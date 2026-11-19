/** Trusted local operator command. Close the generation host before opening its store here. */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, FabricStore, type ReconciliationResolution } from '@weave/agentfabric';

export async function cliGenerations(
  args: readonly string[],
  options: {
    cliProcessGroupProbe?: (pgid: number) => 'alive' | 'gone' | 'unknown';
  } = {},
): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      store: { type: 'string' },
      invocation: { type: 'string' },
      resolution: { type: 'string' },
      evidence: { type: 'string' },
      output: { type: 'string' },
      'force-with-evidence': { type: 'boolean' },
    },
  });
  if (!values.store || positionals.length !== 1 || !['list', 'reconcile'].includes(positionals[0] ?? '')) {
    throw new Error(
      'usage: cli-generations.ts --store JOURNAL list | reconcile --invocation ID --resolution committed|not_committed --evidence TEXT [--output JSON] [--force-with-evidence]',
    );
  }
  let resolution: ReconciliationResolution | undefined;
  if (positionals[0] === 'reconcile') {
    if (!values.invocation || !values.evidence?.trim())
      throw new Error('reconcile requires an invocation id and evidence');
    if (values.resolution === 'not_committed')
      resolution = {
        resolution: 'not_committed',
        evidence: values.evidence,
        ...(values['force-with-evidence'] ? { force_with_evidence: true } : {}),
      };
    else if (values.resolution === 'committed' && values.output !== undefined) {
      let output: unknown;
      try {
        output = JSON.parse(values.output);
      } catch {
        throw new Error('committed output must be JSON');
      }
      resolution = { resolution: 'committed', evidence: values.evidence, output };
    } else throw new Error('resolution must be not_committed, or committed with --output JSON');
  }
  const store = FabricStore.open(values.store);
  try {
    const previouslyReconciled =
      values.invocation === undefined ? false : store.getInvocation(values.invocation)?.reconciliation !== undefined;
    const host = new AgentFabricHost({ authority: createGrantAuthority(), store, ...options });
    await host.cliRecoveryReady;
    if (!resolution) return host.listUncertainCliGenerations();
    const invocation_id = values.invocation!;
    const existing = store.getInvocation(invocation_id);
    if (existing?.reconciliation && existing.reconciliation.resolution !== resolution.resolution) {
      throw new Error(
        `requested resolution ${resolution.resolution} conflicts with recorded resolution ${existing.reconciliation.resolution}`,
      );
    }
    // Opening performs the safe startup check through the same durable gate.
    if (
      !previouslyReconciled &&
      existing?.reconciliation?.resolution === 'not_committed' &&
      existing.reconciliation.evidence.startsWith('workspace snapshot unchanged: ')
    ) {
      return { invocation_id, status: 'stopped', resolution: 'not_committed', startup_reconciled: true };
    }
    const result = host.reconcileCliGeneration(invocation_id, resolution);
    return { invocation_id, status: result.status, resolution: resolution.resolution };
  } finally {
    store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await cliGenerations(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'CLI reconciliation failed'}\n`);
    process.exitCode = 1;
  }
}
