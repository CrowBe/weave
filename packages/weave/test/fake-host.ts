/**
 * The fake host: Weave's test double for the capability host interface
 * (docs/m0-inspect-and-report.md §8). It is not AgentFabric and proves nothing
 * about AgentFabric. It depends only on AgentSOP (M0-C1).
 */
import { createHash } from 'node:crypto';
import {
  bindSelectors,
  grantCovers,
  type CapabilityContract,
  type CapabilityHost,
  type DescribeResult,
  type Grant,
  type InvocationHandle,
  type InvocationOutcome,
  type InvocationRejected,
} from '@weave/agentsop';

export const SOURCE_INSPECT: CapabilityContract = {
  id: 'source.inspect',
  revision: 'r1',
  purpose: 'Inspect one text source and report its revision, line count, and digest',
  input: { source: 'ResourceId' },
  output: { source: 'ResourceId', revision: 'integer', line_count: 'integer', digest: 'string' },
  effects: [{ input: 'source', mode: 'read' }],
  permissions: [{ input: 'source', mode: 'read' }],
  failures: ['not_found', 'access_denied'],
};

export const REPORT_ASSEMBLE: CapabilityContract = {
  id: 'report.assemble',
  revision: 'r1',
  purpose: 'Assemble inspection results into a report that records the read set it was assembled under',
  input: { inspections: '[InspectionResult]' },
  output: { entries: '[InspectionResult]', read_set: '[{resource, revision}]' },
  effects: [],
  permissions: [],
  failures: ['empty_input'],
};

interface FixtureSource {
  revision: number;
  content: string;
}

/** The in-memory environment the fake host reads. It is not Weave state. */
export class FixtureEnvironment {
  private readonly sources = new Map<string, FixtureSource>();

  register(resource: string, content: string): FixtureSource {
    const entry = { revision: 1, content };
    this.sources.set(resource, entry);
    return entry;
  }

  change(resource: string, content: string): FixtureSource {
    const current = this.sources.get(resource);
    if (!current) {
      throw new Error(`fixture: unknown resource ${resource}`);
    }
    const entry = { revision: current.revision + 1, content };
    this.sources.set(resource, entry);
    return entry;
  }

  get(resource: string): FixtureSource | undefined {
    return this.sources.get(resource);
  }
}

interface OpenInvocation {
  readonly action_id: string;
  readonly operation: string;
  readonly inputs: unknown;
  readonly resolve: (outcome: InvocationOutcome) => void;
}

export class FakeHost implements CapabilityHost {
  private readonly contracts = new Map<string, CapabilityContract>([
    [SOURCE_INSPECT.id, SOURCE_INSPECT],
    [REPORT_ASSEMBLE.id, REPORT_ASSEMBLE],
  ]);
  private readonly open = new Map<string, OpenInvocation>();

  /** Every accepted invocation, in order. */
  readonly invocations: { action_id: string; operation: string; inputs: unknown }[] = [];
  /** Every rejection, in order. Observable to tests; never returned as a result. */
  readonly rejections: InvocationRejected[] = [];

  constructor(private readonly environment: FixtureEnvironment) {}

  describe(operation: string): DescribeResult {
    const contract = this.contracts.get(operation);
    return contract ? { kind: 'contract', contract } : { kind: 'unknown_operation' };
  }

  invoke(grant: Grant | null, operation: string, inputs: unknown): InvocationHandle | InvocationRejected {
    const contract = this.contracts.get(operation);
    if (!contract) {
      return this.reject('UNKNOWN_CAPABILITY', `unknown operation ${operation}`);
    }
    const required = bindSelectors(contract.permissions, inputs);
    if (!required.ok) {
      return this.reject(required.code, required.reason);
    }
    const covered = grantCovers(grant, operation, contract.revision, required.bound);
    if (!covered.ok) {
      return this.reject(covered.code, covered.reason);
    }
    const action_id = (grant as Grant).action_id;
    if (this.open.has(action_id)) {
      return this.reject('DENIED', `grant for ${action_id} already in use`);
    }
    this.invocations.push({ action_id, operation, inputs });
    let resolve!: (outcome: InvocationOutcome) => void;
    const result = new Promise<InvocationOutcome>((r) => {
      resolve = r;
    });
    this.open.set(action_id, { action_id, operation, inputs, resolve });
    return { kind: 'handle', action_id, result };
  }

  /** Number of invocations accepted and not yet released. */
  openCount(): number {
    return this.open.size;
  }

  openActionIds(): string[] {
    return [...this.open.keys()];
  }

  /** Complete a held invocation. Tests control completion order. */
  release(action_id: string): void {
    const invocation = this.open.get(action_id);
    if (!invocation) {
      throw new Error(`fake host: no open invocation for ${action_id}`);
    }
    this.open.delete(action_id);
    invocation.resolve(this.perform(invocation.operation, invocation.inputs));
  }

  releaseAll(): string[] {
    const ids = this.openActionIds();
    for (const id of ids) {
      this.release(id);
    }
    return ids;
  }

  private reject(code: InvocationRejected['code'], reason: string): InvocationRejected {
    const rejection: InvocationRejected = { kind: 'rejected', code, reason };
    this.rejections.push(rejection);
    return rejection;
  }

  private perform(operation: string, inputs: unknown): InvocationOutcome {
    const record = inputs as Record<string, unknown>;
    switch (operation) {
      case 'source.inspect': {
        const source = record['source'] as string;
        const entry = this.environment.get(source);
        if (!entry) {
          return { outcome: 'failed', failure: 'not_found' };
        }
        return {
          outcome: 'succeeded',
          output: {
            source,
            revision: entry.revision,
            line_count: entry.content === '' ? 0 : entry.content.split('\n').length,
            digest: createHash('sha256').update(entry.content).digest('hex').slice(0, 16),
          },
        };
      }
      case 'report.assemble': {
        const inspections = record['inspections'] as { source: string; revision: number }[];
        if (!Array.isArray(inspections) || inspections.length === 0) {
          return { outcome: 'failed', failure: 'empty_input' };
        }
        return {
          outcome: 'succeeded',
          output: {
            entries: inspections,
            read_set: inspections.map((i) => ({ resource: i.source, revision: i.revision })),
          },
        };
      }
      default:
        return { outcome: 'failed', failure: 'not_found' };
    }
  }
}
