import { isAbsolute, resolve, sep } from 'node:path';
import { statSync } from 'node:fs';
import {
  bindProcessEffects,
  bindSelectors,
  grantCovers,
  validateCatalogue,
  type CapabilityContract,
  type CapabilityHost,
  type DescribeResult,
  type FailureCode,
  type Grant,
  type GrantAuthority,
  type InferCall,
  type InferResult,
  type InvocationHandle,
  type InvocationOutcome,
  type InvocationRejected,
  type InvokeOptions,
  type LookupResult,
  type ResolverContext,
  type ResourceEffect,
  type ResourceRef,
  type ResolutionStatus,
} from '@weave/agentsop';
import { GENERATION_KINDS, type GenerationKind, type InferenceGateway } from '@weave/gateway';
import { acceptCapabilityOutput } from './bounds.js';
import { ResourceCoordinator } from './coordinator.js';
import { FIXTURE_CONTRACTS, REPORT_ASSEMBLE, REPORT_PUBLISH, SOURCE_INSPECT } from './contracts.js';
import { newFilesInside, runProcess, snapshotFiles } from './process-spawn.js';
import { REPO_BUILD, REPO_LINT, REPO_TEST, SHELL_RUN, shellCatalogue } from './shell-contracts.js';
import {
  SHELL_TAIL_CHARS,
  containsSecret,
  freezeRepoCommands,
  isRepoOperation,
  isShellOperation,
  lookupEnv,
  parseShellCall,
  redactArgv,
  redactSecrets,
  traceInOrder,
  type ParsedShellCall,
  type RepoCommands,
  type ShellFailure,
  type ShellHostOptions,
  type ShellTraceRecord,
} from './shell.js';
import { contentDigest, digest } from './digest.js';
import { IsolateRunner, isolatedCall } from './isolate.js';
import {
  FabricStore,
  normalizeInvocationOutcome,
  PersistFailure,
  type FabricSnapshot,
  type InvocationRecord,
  type PublicationRecord,
} from './store.js';
import { FabricWeft, type WeftPort } from './weft.js';
import { probeProcessGroup, type ProcessGroupState } from './process-group.js';
import { workspaceSnapshot } from './workspace-state.js';

export interface PublishInput {
  readonly report: {
    readonly entries: readonly unknown[];
    readonly read_set: readonly { resource: string; revision: number }[];
  };
  readonly read_set: readonly { resource: string; revision: number }[];
  readonly sources: readonly string[];
  readonly destination: string;
  readonly expected_revision: number;
}

export interface PublishReceipt {
  readonly invocation_id: string;
  readonly report_digest: string;
  readonly destination: string;
  readonly committed_revision: number;
}

export type PublishGate = 'none' | 'before_commit' | 'after_commit';

export interface HostFaults {
  lookupUnavailable?: boolean;
  throwBeforeCommit?: boolean;
  throwAfterCommit?: boolean;
  rejectPromiseAfterCommit?: boolean;
  disconnectAfterCommit?: boolean;
  publishGate?: PublishGate;
}

interface AccessRecord {
  readonly handle: string;
  readonly operation: string;
}

interface OpenInvocation {
  readonly invocation_id: string;
  readonly action_id: string;
  readonly operation: string;
  readonly implementation_id: string;
  readonly inputs: unknown;
  readonly grant: Grant;
  readonly effects: readonly ResourceEffect[];
  readonly binding_digest: string;
  phase: 'held' | 'running' | 'before_commit' | 'after_commit' | 'done';
  cancel_requested: boolean;
  /** Aborted by requestCancel. Shell runs observe it and kill the child. */
  readonly abort: AbortController;
  shellArgv: readonly string[];
  shellStdin: string;
  shellEnv: Record<string, string>;
  shellSecrets: string[];
  shellEnvAllow: readonly string[];
  shellTimeout: number;
  shellCwdRef: string;
  resolve: (outcome: InvocationOutcome) => void;
  committed: PublicationRecord | null;
  outcome: InvocationOutcome | null;
  /** The store's attempt number; absent for the first attempt. */
  readonly attempt?: number;
}

export type CapabilityImplementation = (
  inputs: unknown,
  context: ResolverContext,
) => Promise<InvocationOutcome> | InvocationOutcome;

export type ReconciliationResolution =
  | { readonly resolution: 'committed'; readonly evidence: string; readonly output: unknown }
  | { readonly resolution: 'not_committed'; readonly evidence: string; readonly force_with_evidence?: boolean };

export type ReconciliationResult = {
  readonly status: 'committed' | 'stopped';
  readonly outcome: InvocationOutcome;
};

type CliGenerationRejection = InvocationRejected & {
  readonly workspace_conflict?: { readonly invocation_id: string; readonly uncertain: boolean };
};

/** Cancelled before preparation: no invocation or effect reservation was created. */
type CliGenerationCancelled = { readonly kind: 'cancelled'; readonly invocation_id: string };

export interface UncertainCliGeneration {
  readonly invocation_id: string;
  readonly cwd_ref: string;
  readonly reason: string;
  readonly startup_check?:
    | 'workspace_changed'
    | 'snapshot_unavailable'
    | 'check_failed'
    | 'process_group_alive'
    | 'process_group_unknown';
}

export interface ImplementationProfile {
  readonly id: string;
  readonly reliability: { readonly successes: number; readonly failures: number } | null;
  readonly cost_micros: number | null;
}

interface AdmittedImplementation {
  readonly id: string;
  readonly run: CapabilityImplementation;
  reliability: { successes: number; failures: number } | null;
  cost_micros: number | null;
}

/**
 * Admission order only. Reliability and cost are not inputs, so a second
 * implementation is not selected because an earlier one measured well.
 */
export function selectAdmittedImplementation(records: readonly { readonly id: string }[]): string | null {
  return records[0]?.id ?? null;
}

export class AgentFabricHost implements CapabilityHost {
  readonly store: FabricStore;
  readonly authority: GrantAuthority;
  readonly coordinator = new ResourceCoordinator();
  readonly invocations: {
    action_id: string;
    invocation_id: string;
    operation: string;
    implementation_id: string;
    inputs: unknown;
  }[] = [];
  /** Registry copies of conclusions. Presence here is not cross-goal authority. */
  readonly retainedConclusions: unknown[] = [];
  readonly rejections: InvocationRejected[] = [];
  readonly resourceAccesses: AccessRecord[] = [];
  readonly lookups: { invocation_id: string; granted: boolean }[] = [];
  faults: HostFaults;
  readonly cliRecoveryReady: Promise<void>;
  private cliRecoveryComplete = false;
  private readonly preparingCli = new Map<string, OpenInvocation | undefined>();
  private readonly reservedCliIds = new Set<string>();
  private readonly pendingCliCancel = new Set<string>();
  private readonly cliProcessGroupProbe: (pgid: number) => ProcessGroupState;
  private readonly gateway: InferenceGateway | undefined;
  private readonly shellOptions: ShellHostOptions | undefined;
  private readonly repoCommands: RepoCommands | undefined;
  private readonly shellTraceLog: ShellTraceRecord[] = [];
  private readonly shellSpawns: { argv: string[]; env_names: string[] }[] = [];
  /** Cost ceilings already admitted against each contract's max_cost. */
  private readonly inferenceCharged = new Map<string, number>();
  private inferenceSeq = 0;
  private cliGenerationSeq = 0;
  private readonly cliStartupChecks = new Map<string, UncertainCliGeneration['startup_check']>();
  /** Written only by admission. A function passed to registerImplementation is not stored here. */
  private readonly admitted = new Map<string, AdmittedImplementation[]>();
  private readonly restored = new IsolateRunner('enforcing');

  private readonly live = new Map<string, CapabilityContract>();
  private readonly historical = new Map<string, CapabilityContract>();
  private readonly status = new Map<string, ResolutionStatus>();
  private readonly open = new Map<string, OpenInvocation>();
  private readonly reconciling = new Set<string>();
  /** Legacy invocations whose resource scopes cannot be reconstructed. */
  private readonly unscopedRecovery = new Map<string, string>();
  private readonly weft: FabricWeft | null;

  constructor(options: {
    authority: GrantAuthority;
    store?: FabricStore;
    faults?: HostFaults;
    contracts?: readonly CapabilityContract[];
    gateway?: InferenceGateway;
    shell?: ShellHostOptions;
    /** Host process evidence port. Only gone permits automatic release. */
    cliProcessGroupProbe?: (pgid: number) => ProcessGroupState;
    /** Weft emission port (WEFT-CONTRACT.md, Emission). Absent: nothing is emitted. */
    weft?: WeftPort;
  }) {
    this.cliProcessGroupProbe = options.cliProcessGroupProbe ?? probeProcessGroup;
    this.authority = options.authority;
    this.store = options.store ?? new FabricStore();
    this.faults = { ...options.faults };
    this.gateway = options.gateway;
    this.shellOptions = options.shell;
    this.repoCommands = options.shell?.repo === undefined ? undefined : freezeRepoCommands(options.shell.repo);
    const base = options.contracts ?? FIXTURE_CONTRACTS;
    const extras = options.shell ? shellCatalogue(this.repoCommands !== undefined) : [];
    const seen = new Set(base.map((contract) => contract.id));
    const contracts = [...base, ...extras.filter((contract) => !seen.has(contract.id))];
    const catalogue = validateCatalogue(contracts);
    if (!catalogue.ok) {
      throw new Error(`INVALID_CATALOGUE: ${catalogue.reason}`);
    }
    for (const contract of contracts) {
      this.live.set(contract.id, contract);
      this.historical.set(contract.id, contract);
      this.status.set(contract.id, trustedBuiltin(contract.id) ? 'resolved' : 'unresolved');
    }
    this.restoreAdmissions();
    this.restoreReservations();
    // Restored admissions were reported when they happened; emission starts here.
    this.weft = options.weft ? new FabricWeft(options.weft) : null;
    this.cliRecoveryReady = this.checkUncertainCliGenerations().then(() => {
      this.cliRecoveryComplete = true;
    });
  }

  /** Host-owned identity allocation works across bridge instances and restarts. */
  nextCliGenerationId(): string {
    let id: string;
    do {
      id = `shell-cli:${this.cliGenerationSeq++}`;
    } while (
      this.store.getInvocation(id) ||
      this.open.has(id) ||
      this.preparingCli.has(id) ||
      this.reservedCliIds.has(id)
    );
    this.reservedCliIds.add(id);
    return id;
  }

  /** Composition entry point; the supplied grant still determines all authority. */
  async invokeCliGeneration(
    grant: Grant,
    inputs: unknown,
  ): Promise<InvocationHandle | CliGenerationRejection | CliGenerationCancelled> {
    const invocation_id = grant.action_id;
    if (this.preparingCli.has(invocation_id)) return this.reject('DENIED', 'invocation is already active');
    // Caller-supplied identities also need protection before recovery can yield.
    this.preparingCli.set(invocation_id, undefined);
    this.reservedCliIds.add(invocation_id);
    let preparedOpen = false;
    try {
      if (!this.cliRecoveryComplete) await this.cliRecoveryReady;
      if (isRecord(inputs) && typeof inputs['cwd_ref'] === 'string') {
        const cwd_ref = inputs['cwd_ref'];
        const conflict = this.workspaceConflict(cwd_ref);
        const legacy = [...this.unscopedRecovery.values()].includes(SHELL_RUN.id);
        if ((conflict?.uncertain || legacy) && !this.reconciling.size) await this.checkUncertainCliGenerations(cwd_ref);
      }
      const existing = this.store.getInvocation(invocation_id);
      // A re-run of a stopped generation is cancelled before reconciling or superseding it.
      if (this.pendingCliCancel.has(invocation_id) && (existing === undefined || existing.status === 'stopped')) {
        const checked = this.validateInvocation(grant, SHELL_RUN.id, inputs);
        if (checked.kind === 'rejected') return checked;
        // Mirror preparation's order: pre-consumption gates, consumption, then resource checks.
        if (existing && existing.action_id !== grant.action_id) {
          return this.reject('DENIED', 'grant does not name this invocation');
        }
        if (existing && existing.binding_digest !== digest({ operation: SHELL_RUN.id, inputs: checked.boundInputs })) {
          return this.reject('DENIED', 'invocation identity is bound to a different input');
        }
        const unresolved = this.resolutionRejection(SHELL_RUN.id);
        if (unresolved) return unresolved;
        const preparedShell = this.prepareShell(SHELL_RUN.id, checked.boundInputs);
        if (!preparedShell.ok) return this.reject(preparedShell.code, preparedShell.reason);
        // Consume through the ordinary authority gate before releasing the identity.
        if (!this.authority.markInvoked(grant)) {
          return this.reject(
            'DENIED',
            this.invalidGrantReason(grant) ?? 'grant has already been used for an invocation',
          );
        }
        return this.resourceRejection(SHELL_RUN.id, checked.effects) ?? { kind: 'cancelled', invocation_id };
      }
      const prepared = this.step(() => this.prepare(grant, SHELL_RUN.id, inputs, undefined, invocation_id));
      if (prepared.kind === 'rejected') {
        const conflict =
          prepared.code === 'RESOLVER_ERROR' &&
          prepared.reason.startsWith('effect conflict on ') &&
          isRecord(inputs) &&
          typeof inputs['cwd_ref'] === 'string'
            ? this.workspaceConflict(inputs['cwd_ref'])
            : undefined;
        // Capture the owner before yielding; reconciliation may release it meanwhile.
        return { ...prepared, ...(conflict ? { workspace_conflict: conflict } : {}) };
      }
      if (prepared.kind === 'replay') return prepared.handle;
      // Keep the identity reserved and cancellation addressable while inspection yields.
      preparedOpen = true;
      this.preparingCli.set(grant.action_id, prepared.open);
      // A synchronous host callback during prepare may have cancelled the placeholder.
      if (this.pendingCliCancel.has(invocation_id)) {
        prepared.open.cancel_requested = true;
        prepared.open.abort.abort();
      }
      const resource = this.resourceFor(prepared.open.shellCwdRef);
      const before_snapshot = resource?.kind === 'workspace' ? await workspaceSnapshot(resource.locator) : null;
      if (!this.authority.isValid(grant)) {
        return this.reject('DENIED', 'grant was revoked during workspace inspection');
      }
      prepared.record.cli_generation = { cwd_ref: prepared.open.shellCwdRef, before_snapshot };
      return this.step(() => {
        const stopped = this.store.getInvocation(invocation_id);
        if (stopped && !stopped.reconciliation) {
          const failed = this.reconcileStoppedRun(stopped);
          if (failed) return failed;
        }
        // Read after reconciliation: cancellation during it applies to the fresh attempt.
        prepared.record.cancel_requested = prepared.open.cancel_requested;
        return this.startPrepared(prepared, SHELL_RUN.id);
      });
    } finally {
      this.reservedCliIds.delete(invocation_id);
      this.preparingCli.delete(invocation_id);
      this.pendingCliCancel.delete(invocation_id);
      if (preparedOpen && !this.open.has(invocation_id)) this.coordinator.release(invocation_id);
    }
  }

  workspaceConflict(cwd_ref: string): { readonly invocation_id: string; readonly uncertain: boolean } | undefined {
    const canonical_id = this.store.lookupRef(cwd_ref)?.canonical_id ?? cwd_ref;
    const held = this.coordinator.conflicts([{ canonical_id, mode: 'write' }]);
    if (!held) return undefined;
    const open = this.open.get(held.invocation_id);
    const record = this.store.getInvocation(held.invocation_id);
    return {
      invocation_id: held.invocation_id,
      uncertain:
        open?.outcome?.outcome === 'uncertain' ||
        record?.status === 'uncertain' ||
        (record?.status === 'running' && (!open || open.phase === 'done')),
    };
  }

  /** Trusted operator listing: no prompts, argv, environment, or locators. */
  listUncertainCliGenerations(): readonly UncertainCliGeneration[] {
    return this.store.invocationRecords().flatMap((record) => {
      if (!this.blocksCliWorkspace(record)) return [];
      const open = this.open.get(record.invocation_id);
      if (open && open.phase !== 'done') return [];
      if (record.status !== 'uncertain' && record.status !== 'running') return [];
      const outcome = open?.outcome ?? record.outcome;
      const cwd_ref =
        record.cli_generation?.cwd_ref ??
        (isRecord(record.inputs) && typeof record.inputs['cwd_ref'] === 'string' ? record.inputs['cwd_ref'] : '');
      const startup_check = this.cliStartupChecks.get(record.invocation_id);
      return [
        {
          invocation_id: record.invocation_id,
          cwd_ref,
          reason: outcome?.outcome === 'uncertain' ? outcome.reason : RECOVERED_UNCERTAINTY,
          ...(startup_check ? { startup_check } : {}),
        },
      ];
    });
  }

  /** The operator path shares reconciliation's durable append-before-release gate. */
  reconcileCliGeneration(invocation_id: string, resolution: ReconciliationResolution): ReconciliationResult {
    const record = this.store.getInvocation(invocation_id);
    if (!record || !this.blocksCliWorkspace(record)) throw new Error('unknown CLI workspace hold for reconciliation');
    if (
      !record.reconciliation &&
      resolution.resolution === 'not_committed' &&
      resolution.force_with_evidence !== true
    ) {
      if (record.cli_generation?.pgid === undefined)
        throw new Error('no CLI process evidence exists; explicit evidence and force_with_evidence required');
      if (this.cliGroupState(record) !== 'gone')
        throw new Error('CLI process group is alive or unknown; explicit evidence and force_with_evidence required');
      // Safe defaults settle via the asynchronous snapshot check. A synchronous
      // operator call cannot establish fresh evidence of an unchanged workspace.
      throw new Error(
        'workspace snapshot is changed or unavailable; explicit evidence and force_with_evidence required',
      );
    }
    const result = this.reconcile(invocation_id, resolution);
    this.cliStartupChecks.delete(invocation_id);
    return result;
  }

  private blocksCliWorkspace(record: InvocationRecord): boolean {
    if (isCliGeneration(record) || this.unscopedRecovery.get(record.invocation_id) === SHELL_RUN.id) return true;
    return this.coordinator
      .held()
      .some(
        (hold) =>
          hold.invocation_id === record.invocation_id &&
          this.store.getResource(hold.canonical_id)?.kind === 'workspace',
      );
  }

  private cliGroupState(record: InvocationRecord): ProcessGroupState {
    const pgid = record.cli_generation?.pgid;
    if (pgid === undefined) return 'unknown';
    try {
      return this.cliProcessGroupProbe(pgid);
    } catch {
      return 'unknown';
    }
  }

  private async checkUncertainCliGenerations(cwd_ref?: string): Promise<void> {
    const canonical = cwd_ref === undefined ? undefined : (this.store.lookupRef(cwd_ref)?.canonical_id ?? cwd_ref);
    await Promise.all(
      this.listUncertainCliGenerations()
        .filter(
          (entry) =>
            canonical === undefined ||
            this.unscopedRecovery.get(entry.invocation_id) === SHELL_RUN.id ||
            this.coordinator
              .held()
              .some((hold) => hold.invocation_id === entry.invocation_id && hold.canonical_id === canonical),
        )
        .map((entry) => this.checkUncertainCliGeneration(entry.invocation_id)),
    );
  }

  private async checkUncertainCliGeneration(invocation_id: string, postTerminate = false): Promise<void> {
    try {
      const record = this.store.getInvocation(invocation_id);
      if (
        !record ||
        record.reconciliation ||
        !this.blocksCliWorkspace(record) ||
        this.reconciling.has(invocation_id) ||
        (this.open.has(invocation_id) && this.open.get(invocation_id)!.phase !== 'done') ||
        (record.status !== 'running' && record.status !== 'uncertain')
      )
        return;
      let group = this.cliGroupState(record);
      for (let retry = 0; postTerminate && group === 'alive' && retry < 3 && this.shellOptions; retry++) {
        await this.shellOptions.timer.sleep(25);
        group = this.cliGroupState(record);
      }
      if (group !== 'gone') {
        this.cliStartupChecks.set(invocation_id, group === 'alive' ? 'process_group_alive' : 'process_group_unknown');
        return;
      }
      const evidence = record.cli_generation;
      if (!evidence?.before_snapshot) {
        this.cliStartupChecks.set(invocation_id, 'snapshot_unavailable');
        return;
      }
      const resource = this.resourceFor(evidence.cwd_ref);
      if (!resource || resource.kind !== 'workspace') throw new Error('workspace unavailable');
      const after = await workspaceSnapshot(resource.locator);
      if (after === null) {
        this.cliStartupChecks.set(invocation_id, 'snapshot_unavailable');
        return;
      }
      if (after !== evidence.before_snapshot) {
        this.cliStartupChecks.set(invocation_id, 'workspace_changed');
        return;
      }
      // Reconciliation rechecks process evidence after the asynchronous scan.
      if (this.store.getInvocation(invocation_id)?.reconciliation) return;
      this.reconcile(invocation_id, {
        resolution: 'not_committed',
        evidence: `workspace snapshot unchanged: ${evidence.before_snapshot}; process group confirmed gone`,
      });
      this.cliStartupChecks.delete(invocation_id);
    } catch {
      // Inspection or a failed durable gate never releases protection.
      this.cliStartupChecks.set(invocation_id, 'check_failed');
    }
  }

  snapshot(): FabricSnapshot {
    return this.store.snapshot();
  }

  static restore(
    authority: GrantAuthority,
    snapshot: FabricSnapshot,
    faults?: HostFaults,
    shell?: ShellHostOptions,
  ): AgentFabricHost {
    const options: {
      authority: GrantAuthority;
      store: FabricStore;
      faults?: HostFaults;
      shell?: ShellHostOptions;
    } = {
      authority,
      store: FabricStore.restore(snapshot),
    };
    if (faults) {
      options.faults = faults;
    }
    if (shell) {
      options.shell = shell;
    }
    return new AgentFabricHost(options);
  }

  /** A workspace directory the host may spawn in. The locator stays in the store. */
  registerWorkspace(locator: string): ResourceRef {
    if (!isAbsolute(locator) || !isDirectory(locator)) {
      throw new Error('workspace locator must be an absolute directory');
    }
    const canonical_id = this.store.allocateCanonical();
    this.store.putResource({
      canonical_id,
      kind: 'workspace',
      locator,
      revision: 1,
      content: '',
      publication: null,
    });
    return this.store.issue(canonical_id, 'workspace');
  }

  /** Shell-out traces in id/parentId order. Environment values are not fields. */
  shellTraces(): readonly ShellTraceRecord[] {
    return this.shellTraceLog.map((record) => ({
      ...traceInOrder(record),
      argv: [...record.argv],
      env_allow: [...record.env_allow],
      artifacts: [...record.artifacts],
    }));
  }

  shellTraceJsonl(): string {
    if (this.shellTraceLog.length === 0) {
      return '';
    }
    return this.shellTraceLog.map((record) => JSON.stringify(traceInOrder(record))).join('\n') + '\n';
  }

  /** Argv and environment names of spawn attempts. Values are not recorded. */
  spawnRecords(): readonly { argv: readonly string[]; env_names: readonly string[] }[] {
    return this.shellSpawns.map((record) => ({ argv: [...record.argv], env_names: [...record.env_names] }));
  }

  registerSource(locator: string, content: string): ResourceRef {
    const canonical_id = this.store.allocateCanonical(false);
    this.store.putResource(
      {
        canonical_id,
        kind: 'source',
        locator,
        revision: 1,
        content,
        publication: null,
      },
      false,
    );
    const handle = this.store.issue(canonical_id, 'source', false);
    this.store.save();
    return handle;
  }

  registerDestination(locator: string): ResourceRef {
    const canonical_id = this.store.allocateCanonical(false);
    this.store.putResource(
      {
        canonical_id,
        kind: 'destination',
        locator,
        revision: 1,
        content: '',
        publication: null,
      },
      false,
    );
    const handle = this.store.issue(canonical_id, 'destination', false);
    this.store.save();
    return handle;
  }

  alias(handle: ResourceRef): ResourceRef {
    const issued = this.store.lookupRef(handle);
    if (!issued) {
      throw new Error(`cannot alias unknown handle`);
    }
    return this.store.issue(issued.canonical_id, issued.kind);
  }

  revision(handle: ResourceRef): number | undefined {
    const resource = this.resourceFor(handle);
    return resource?.revision;
  }

  publication(handle: ResourceRef): PublicationRecord | null | undefined {
    return this.resourceFor(handle)?.publication;
  }

  content(handle: ResourceRef): string | undefined {
    return this.resourceFor(handle)?.content;
  }

  /** Fixture source writer: subject to the same coordinator as publication. */
  /** Hold read locks for a runtime action. A write to one of these resources waits. */
  holdReads(invocation_id: string, resources: readonly string[]): void {
    this.coordinator.acquire(
      invocation_id,
      resources.map((resource) => ({ resource, mode: 'read' as const })),
      (ref) => this.store.lookupRef(ref)?.canonical_id ?? ref,
    );
  }

  releaseReads(invocation_id: string): void {
    this.coordinator.release(invocation_id);
  }

  /** Journal a fixture source edit; an expected revision rejects stale writers. */
  tryWriteSource(
    handle: ResourceRef,
    content: string,
    expectedRevision?: number,
  ): { ok: true; revision: number } | { ok: false; reason: 'conflict' | 'unknown' } {
    const issued = this.store.lookupRef(handle);
    if (!issued || issued.kind !== 'source') {
      return { ok: false, reason: 'unknown' };
    }
    if (this.coordinator.isHeld(issued.canonical_id)) {
      return { ok: false, reason: 'conflict' };
    }
    const resource = this.store.getResource(issued.canonical_id);
    if (!resource) {
      return { ok: false, reason: 'unknown' };
    }
    if (expectedRevision !== undefined && resource.revision !== expectedRevision) {
      return { ok: false, reason: 'conflict' };
    }
    const revision = resource.revision + 1;
    this.store.putResource({ ...resource, content, revision });
    return { ok: true, revision };
  }

  /**
   * Record that an implementation was offered. The function is not retained
   * and cannot run: untrusted code stays unresolved until isolation exists
   * and admission evidence is recorded. Trusted fixture operations are not
   * replaceable by this call.
   */
  registerImplementation(
    operation: string,
    implementation: CapabilityImplementation,
  ): { readonly admitted: false; readonly reason: string } {
    void operation;
    void implementation;
    return {
      admitted: false,
      reason: 'untrusted execution is blocked: isolation is not supported',
    };
  }

  resolverContext(contract: CapabilityContract): ResolverContext {
    const registered = this.live.get(contract.id);
    const infer = registered?.inference ? (call: InferCall) => this.infer(registered, call) : undefined;
    return {
      read: () => {
        throw new Error('DENIED');
      },
      write: () => {
        throw new Error('DENIED');
      },
      invoke: (capability) => {
        const depends = registered?.depends_on ?? contract.depends_on;
        if (!depends.includes(capability)) {
          return { outcome: 'failed', failure: 'UNDECLARED_DEPENDENCY' };
        }
        return { outcome: 'failed', failure: 'UNRESOLVED' };
      },
      ...(infer ? { infer } : {}),
    };
  }

  async infer(contract: CapabilityContract, call: InferCall): Promise<InferResult> {
    const registered = this.live.get(contract.id);
    if (!registered) {
      return { status: 'refused', code: 'UNKNOWN_CAPABILITY', reason: `${contract.id} is not in the catalogue` };
    }
    const limits = registered.inference;
    if (!limits) {
      return { status: 'refused', code: 'UNDECLARED_DEPENDENCY', reason: 'contract did not declare inference' };
    }
    if (!this.gateway) {
      return { status: 'refused', code: 'RESOLVER_UNAVAILABLE', reason: 'inference gateway is not configured' };
    }
    if (call.kind !== limits.kind) {
      return { status: 'refused', code: 'DENIED', reason: `kind ${call.kind} is outside contract limits` };
    }
    if (!isGenerationKind(call.kind)) {
      return { status: 'refused', code: 'DENIED', reason: `kind ${call.kind} is not a generation kind` };
    }
    if (call.role !== limits.role) {
      return { status: 'refused', code: 'DENIED', reason: `role ${call.role} is outside contract limits` };
    }
    if (call.terms.max_attempts > limits.max_attempts) {
      return { status: 'refused', code: 'DENIED', reason: 'max_attempts exceeds contract limits' };
    }
    if (!Number.isFinite(call.terms.deadline)) {
      return { status: 'refused', code: 'DENIED', reason: 'deadline must be a finite tick' };
    }
    const charged = this.inferenceCharged.get(registered.id) ?? 0;
    if (charged + call.terms.cost_ceiling > limits.max_cost) {
      return { status: 'refused', code: 'DENIED', reason: 'cost_ceiling exceeds the contract cost remaining' };
    }
    if (call.terms.destinations.some((d) => !limits.destinations.includes(d))) {
      return { status: 'refused', code: 'DENIED', reason: 'destination is outside contract limits' };
    }
    this.inferenceCharged.set(registered.id, charged + call.terms.cost_ceiling);
    const input = call.input;
    const prompt =
      typeof input === 'object' &&
      input !== null &&
      !Array.isArray(input) &&
      typeof (input as { prompt?: unknown }).prompt === 'string'
        ? (input as { prompt: string }).prompt
        : JSON.stringify(input);
    const request_id = `fabric:${registered.id}:${this.inferenceSeq++}`;
    const outcome = await this.gateway.generate({
      request_id,
      site: registered.id,
      role: call.role,
      kind: call.kind,
      input: { instructions: `capability ${registered.id}`, prompt },
      terms: {
        quality: 'baseline',
        destinations: call.terms.destinations,
        max_context_tokens: 8_000,
        deadline: call.terms.deadline,
        cost_ceiling: call.terms.cost_ceiling,
        max_attempts: call.terms.max_attempts,
      },
    });
    if (outcome.status === 'accepted') {
      return { status: 'accepted', output: outcome.text, attempts: [...outcome.attempts], spent: outcome.spent };
    }
    if (outcome.status === 'uncertain') {
      return {
        status: 'uncertain',
        invocation_id: outcome.invocation_id,
        reason: outcome.reason,
        attempts: [...outcome.attempts],
        spent: outcome.spent,
      };
    }
    return {
      status: outcome.status,
      reason: outcome.reason,
      attempts: [...outcome.attempts],
      spent: outcome.spent,
    };
  }

  revoke(operation: string, reason = 'revoked'): void {
    this.step(() => this.revokeStep(operation, reason));
  }

  private revokeStep(operation: string, reason: string): void {
    void reason;
    this.weft?.revoked(
      operation,
      (this.admitted.get(operation) ?? []).map((record) => record.id),
    );
    this.live.delete(operation);
    this.admitted.delete(operation);
    this.status.set(operation, 'unavailable');
  }

  liveContracts(): CapabilityContract[] {
    return [...this.live.values()];
  }

  /**
   * The host store records the admitted source. A later process restores the
   * implementation from that record and does not consult a second in-memory copy.
   */
  noteAdmission(contract: CapabilityContract, implementationId: string, source: string): void {
    this.store.recordAdmission({
      operation: contract.id,
      implementation_id: implementationId,
      contract,
      source,
    });
    this.installAdmitted(contract, this.storedImplementation(contract, source), implementationId);
  }

  /** Registry installation after admission, or for a capability that is already established. */
  installAdmitted(
    contract: CapabilityContract,
    implementation: CapabilityImplementation,
    implementationId = 'admitted',
  ): void {
    const others = [...this.live.values()].filter((item) => item.id !== contract.id);
    const catalogue = validateCatalogue([...others, contract]);
    if (!catalogue.ok) {
      throw new Error(`INVALID_CATALOGUE: ${catalogue.reason}`);
    }
    this.live.set(contract.id, contract);
    this.historical.set(contract.id, contract);
    this.status.set(contract.id, 'resolved');
    const records = this.admitted.get(contract.id) ?? [];
    const fresh: AdmittedImplementation = {
      id: implementationId,
      run: implementation,
      reliability: null,
      cost_micros: null,
    };
    const existing = records.findIndex((record) => record.id === implementationId);
    if (existing >= 0) {
      records[existing] = fresh;
    } else {
      records.push(fresh);
    }
    this.admitted.set(contract.id, records);
    this.weft?.admitted(contract.id, implementationId, contract.revision);
  }

  implementationRecords(operation: string): ImplementationProfile[] {
    return (this.admitted.get(operation) ?? []).map((record) => ({
      id: record.id,
      reliability: record.reliability === null ? null : { ...record.reliability },
      cost_micros: record.cost_micros,
    }));
  }

  /** The implementation invoke will run. Measurements are not consulted. */
  selectedImplementation(operation: string): string | null {
    return selectAdmittedImplementation(this.implementationRecords(operation));
  }

  implementationAdmitted(operation: string, implementationId: string): boolean {
    return (this.admitted.get(operation) ?? []).some((record) => record.id === implementationId);
  }

  /**
   * Record reliability and cost for one implementation. A later admission does
   * not read this when choosing which implementation runs.
   */
  recordMeasurement(
    operation: string,
    implementationId: string,
    reliability: { successes: number; failures: number } | null,
    cost_micros: number | null,
  ): void {
    const record = (this.admitted.get(operation) ?? []).find((item) => item.id === implementationId);
    if (!record) {
      throw new Error(`no admitted implementation ${implementationId} for ${operation}`);
    }
    record.reliability = reliability === null ? null : { ...reliability };
    record.cost_micros = cost_micros;
  }

  /** Store a conclusion in the registry. This does not widen its authority scope. */
  retainConclusion(conclusion: unknown): void {
    const accepted = this.store.retainConclusion(conclusion);
    this.retainedConclusions.push(accepted);
  }

  conclusions(): readonly unknown[] {
    return this.conclusionsSince(0);
  }

  conclusionsSince(cursor: number): readonly unknown[] {
    // slice() would read a negative cursor from the end and truncate a fraction.
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.retainedConclusions.length) return [];
    return this.retainedConclusions.slice(cursor).map((conclusion) => structuredClone(conclusion));
  }

  noteWorkload(goal_id: string, quality: 'held' | 'missed'): void {
    this.store.noteWorkload({ goal_id, quality });
  }

  workload(): readonly { goal_id: string; quality: 'held' | 'missed' }[] {
    return this.store.workload();
  }

  measuredCostMicros(): number {
    return this.store.measuredCostMicros();
  }

  private restoreAdmissions(): void {
    for (const admission of this.store.admitted()) {
      const builtin = trustedBuiltin(admission.contract.id) ? this.live.get(admission.contract.id) : undefined;
      // A stored revision remains evidence for old invocations, not authority
      // to replace the trusted builtin shipped by this host.
      if (builtin && builtin.revision !== admission.contract.revision) continue;
      this.installAdmitted(
        admission.contract,
        this.storedImplementation(admission.contract, admission.source),
        admission.implementation_id,
      );
    }
    for (const conclusion of this.store.conclusions()) {
      this.retainedConclusions.push(structuredClone(conclusion));
    }
  }

  private storedImplementation(contract: CapabilityContract, source: string): CapabilityImplementation {
    return async (inputs) => {
      const ran = await isolatedCall(this.restored, source, inputs);
      if (!ran.ok) {
        return { outcome: 'failed', failure: ran.failure };
      }
      return acceptCapabilityOutput(contract, inputs, ran.output);
    };
  }

  replaceLiveContract(contract: CapabilityContract): void {
    this.live.set(contract.id, contract);
    this.historical.set(contract.id, contract);
    this.status.set(contract.id, trustedBuiltin(contract.id) ? 'resolved' : 'unresolved');
  }

  resolution(operation: string): ResolutionStatus {
    return this.status.get(operation) ?? 'unresolved';
  }

  operations(): readonly string[] {
    return [...this.live.keys()].sort();
  }

  describe(operation: string): DescribeResult {
    const contract = this.live.get(operation);
    return contract ? { kind: 'contract', contract } : { kind: 'unknown_operation' };
  }

  historicalContract(operation: string): CapabilityContract | undefined {
    return this.historical.get(operation);
  }

  private invocationContract(record: InvocationRecord): CapabilityContract | undefined {
    const current = this.live.get(record.operation) ?? this.historical.get(record.operation);
    if (!trustedBuiltin(record.operation) || record.implementation_id === undefined) return current;
    const admissions = this.store
      .admitted()
      .filter(
        (admission) =>
          admission.operation === record.operation &&
          admission.contract.id === record.operation &&
          admission.implementation_id === record.implementation_id,
      );
    const first = admissions[0]?.contract;
    if (first) {
      return admissions.every(({ contract }) => digest(contract) === digest(first)) ? first : undefined;
    }
    return current;
  }

  canonicalResource(ref: ResourceRef): ResourceRef {
    const issued = this.store.lookupRef(ref);
    if (!issued) {
      return ref;
    }
    return this.store.primaryRef(issued.canonical_id) ?? ref;
  }

  invoke(
    grant: Grant | null,
    operation: string,
    inputs: unknown,
    options?: InvokeOptions,
  ): InvocationHandle | InvocationRejected {
    return this.step(() => this.invokeStep(grant, operation, inputs, options));
  }

  private invokeStep(
    grant: Grant | null,
    operation: string,
    inputs: unknown,
    options?: InvokeOptions,
  ): InvocationHandle | InvocationRejected {
    return this.startPrepared(this.prepare(grant, operation, inputs, options), operation);
  }

  private startPrepared(
    prepared: ReturnType<AgentFabricHost['prepare']>,
    operation: string,
  ): InvocationHandle | InvocationRejected {
    if (prepared.kind === 'rejected') {
      return prepared;
    }
    if (prepared.kind === 'replay') {
      return prepared.handle;
    }
    const { open, record } = prepared;
    try {
      this.store.persistInvocationStart(record, HOST_INVOCATION_MICROS);
    } catch (error) {
      this.coordinator.release(open.invocation_id);
      if (error instanceof PersistFailure) {
        return this.reject('RESOLVER_ERROR', error.message);
      }
      throw error;
    }
    this.invocations.push({
      action_id: open.action_id,
      invocation_id: open.invocation_id,
      operation,
      implementation_id: open.implementation_id,
      inputs: open.inputs,
    });
    this.weft?.selected(open.invocation_id, operation, open.implementation_id, open.grant.contract_rev, open.attempt);
    this.open.set(open.invocation_id, open);
    const result = new Promise<InvocationOutcome>((resolve) => {
      open.resolve = resolve;
    });
    return {
      kind: 'handle',
      action_id: open.action_id,
      invocation_id: open.invocation_id,
      implementation_id: open.implementation_id,
      result,
      requestCancel: () => {
        this.requestCancel(open.invocation_id);
      },
    };
  }

  lookup(invocation_id: string, grant: Grant | null): LookupResult {
    return this.step(() => this.lookupStep(invocation_id, grant));
  }

  private lookupStep(invocation_id: string, grant: Grant | null): LookupResult {
    if (this.faults.lookupUnavailable) {
      this.lookups.push({ invocation_id, granted: false });
      return this.reject('RESOLVER_UNAVAILABLE', 'outcome lookup unavailable');
    }
    if (!grant || !this.authority.isIssued(grant) || !this.authority.isValid(grant)) {
      this.lookups.push({ invocation_id, granted: false });
      return this.reject('DENIED', 'lookup requires a currently valid issued grant');
    }
    const record = this.store.getInvocation(invocation_id);
    const open = this.open.get(invocation_id);
    const target =
      record ??
      (open
        ? {
            action_id: open.action_id,
            operation: open.operation,
            inputs: open.inputs,
          }
        : null);
    if (!target) {
      this.lookups.push({ invocation_id, granted: false });
      return { status: 'unresolved', reason: `no durable record for ${invocation_id}` };
    }
    if (grant.action_id !== target.action_id || grant.operation !== target.operation) {
      this.lookups.push({ invocation_id, granted: false });
      return this.reject('DENIED', 'grant does not name this invocation');
    }
    const contract = record
      ? this.invocationContract(record)
      : (this.live.get(target.operation) ?? this.historical.get(target.operation));
    if (!contract || grant.contract_rev !== contract.revision) {
      this.lookups.push({ invocation_id, granted: false });
      return this.reject('DENIED', 'grant names a different contract revision');
    }
    const required = bindSelectors(contract.permissions, target.inputs);
    if (!required.ok) {
      this.lookups.push({ invocation_id, granted: false });
      return this.reject(required.code, required.reason);
    }
    const covered = grantCovers(grant, target.operation, contract.revision, required.bound);
    if (!covered.ok) {
      this.lookups.push({ invocation_id, granted: false });
      return this.reject(covered.code, covered.reason);
    }
    this.lookups.push({ invocation_id, granted: true });
    const status =
      open?.phase === 'done' && open.outcome?.outcome === 'uncertain' ? 'uncertain' : (record?.status ?? 'running');
    const outcome = open?.phase === 'done' ? open.outcome : record?.outcome;
    if (status !== 'committed') {
      const published = this.reconcilePublication(invocation_id, status);
      if (published) return published;
    }
    if (status === 'running' && !open) {
      return { status: 'unresolved', reason: RECOVERED_UNCERTAINTY };
    }
    if (status === 'committed' && outcome) {
      this.coordinator.release(invocation_id);
      return { status: 'committed', outcome };
    }
    if (status === 'stopped' && outcome) {
      // A re-run being prepared holds this id's reservation for its fresh attempt.
      if (!this.preparingCli.has(invocation_id)) this.coordinator.release(invocation_id);
      return { status: 'stopped', outcome };
    }
    if (status === 'uncertain' && outcome) {
      return { status: 'unresolved', reason: outcome.outcome === 'uncertain' ? outcome.reason : 'uncertain' };
    }
    return { status: 'unresolved', reason: `invocation ${invocation_id} is ${status}` };
  }

  private reconcilePublication(
    invocation_id: string,
    status: InvocationRecord['status'],
  ): ReconciliationResult | { status: 'unresolved'; reason: string } | undefined {
    const published = this.store.publishedBy(invocation_id);
    if (!published?.publication) return undefined;
    const output = this.receiptFrom(published.publication);
    const committed: ReconciliationResult = { status: 'committed', outcome: { outcome: 'succeeded', output } };
    // Legacy stopped records are outside the uncertainty-only transition.
    // Repair them when possible; the durable receipt already proves commit.
    if (status === 'stopped') {
      const record = this.store.getInvocation(invocation_id);
      if (record) {
        try {
          this.store.persistInvocationResult({ ...record, status: 'committed', outcome: committed.outcome });
        } catch {
          /* The receipt remains authoritative if result persistence fails. */
        }
      }
      return committed;
    }
    const open = this.open.get(invocation_id);
    try {
      // Persist receipt-based reconciliation before releasing an uncertain hold.
      if (!open || open.phase === 'done') {
        return this.reconcile(invocation_id, {
          resolution: 'committed',
          evidence: `publication:${digest(published.publication)}`,
          output,
        });
      }
      return committed;
    } catch {
      return { status: 'unresolved', reason: 'failed to persist publication reconciliation' };
    }
  }

  /** Trusted host-owner API; resolver contexts cannot reconcile external effects. */
  reconcile(invocation_id: string, resolution: ReconciliationResolution): ReconciliationResult {
    if (
      !isRecord(resolution) ||
      !['committed', 'not_committed'].includes(resolution.resolution) ||
      typeof resolution.evidence !== 'string' ||
      resolution.evidence.trim().length === 0 ||
      (resolution.resolution === 'committed' && !('output' in resolution))
    ) {
      throw new Error('invalid reconciliation resolution');
    }
    const record = this.store.getInvocation(invocation_id);
    if (!record) throw new Error('unknown invocation for reconciliation');
    if (record.reconciliation) throw new Error('invocation already reconciled');
    const open = this.open.get(invocation_id);
    if (this.reconciling.has(invocation_id) || (open && open.phase !== 'done')) {
      throw new Error('cannot reconcile an active invocation');
    }
    if (record.status !== 'running' && record.status !== 'uncertain') {
      throw new Error('invocation does not require reconciliation');
    }
    if (
      resolution.resolution === 'not_committed' &&
      isCliGeneration(record) &&
      this.cliGroupState(record) !== 'gone' &&
      resolution.force_with_evidence !== true
    ) {
      throw new Error(
        'CLI process group is alive or unknown; not_committed requires force_with_evidence and explicit evidence',
      );
    }
    if (resolution.resolution === 'not_committed' && this.store.publishedBy(invocation_id)) {
      throw new Error('invalid not_committed resolution for a durable publication');
    }
    let outcome: InvocationOutcome;
    try {
      outcome = normalizeInvocationOutcome(
        resolution.resolution === 'committed'
          ? { outcome: 'succeeded', output: resolution.output }
          : { outcome: 'failed', failure: 'reconciled: not committed' },
      );
    } catch {
      throw new Error('invalid reconciliation output');
    }
    const status = resolution.resolution === 'committed' ? 'committed' : 'stopped';
    this.appendReconciliation({
      ...record,
      status,
      outcome,
      cancel_requested: open?.cancel_requested ?? record.cancel_requested,
      reconciliation: {
        resolution: resolution.resolution,
        evidence:
          resolution.resolution === 'not_committed' && resolution.force_with_evidence === true
            ? `forced process-group override: ${resolution.evidence}`
            : resolution.evidence,
      },
    });
    this.coordinator.release(invocation_id);
    this.unscopedRecovery.delete(invocation_id);
    this.open.delete(invocation_id);
    return { status, outcome };
  }

  /** The durable gate: a validated append, guarded against reentrant cancellation, precedes any release. */
  private appendReconciliation(record: InvocationRecord): void {
    this.reconciling.add(record.invocation_id);
    try {
      this.store.persistInvocationReconciliation(record);
    } finally {
      this.reconciling.delete(record.invocation_id);
    }
  }

  /**
   * Before a re-run supersedes a stopped CLI generation, record that the stopped
   * run did not commit. It retains no reservation: the id's current hold belongs
   * to the fresh attempt, which the caller releases if this append fails.
   */
  private reconcileStoppedRun(record: InvocationRecord): InvocationRejected | undefined {
    const failure = record.outcome?.outcome === 'failed' ? record.outcome.failure : 'no outcome';
    try {
      this.appendReconciliation({
        ...record,
        reconciliation: {
          resolution: 'not_committed',
          evidence: `automatic reconciliation on re-run: attempt ${record.attempt ?? 1} settled stopped (${failure})`,
        },
      });
      return undefined;
    } catch {
      return this.reject('RESOLVER_ERROR', 'failed to persist automatic reconciliation of the stopped run');
    }
  }

  requestCancel(invocation_id: string): { readonly acknowledged: true } {
    const record = this.store.getInvocation(invocation_id);
    const preparing = this.preparingCli.get(invocation_id);
    // A re-run superseding a stopped generation owns its id's cancellation; the
    // earlier attempt's terminal record is not marked.
    const rerun = record?.status === 'stopped' && this.preparingCli.has(invocation_id);
    // Resolution records facts, not new execution. A reentrant cancellation
    // cannot append an obsolete running record over a reconciliation write,
    // but a fresh attempt prepared behind that reconciliation observes it.
    if (this.reconciling.has(invocation_id)) {
      if (rerun && preparing) {
        preparing.cancel_requested = true;
        preparing.abort.abort();
      }
      return { acknowledged: true };
    }
    const open = this.open.get(invocation_id) ?? preparing;
    if (open) {
      open.cancel_requested = true;
      open.abort.abort();
    } else if (
      (record === undefined || rerun) &&
      (this.reservedCliIds.has(invocation_id) || this.preparingCli.has(invocation_id))
    ) {
      this.pendingCliCancel.add(invocation_id);
    }
    if (record && !record.reconciliation && !rerun) {
      this.store.writeInvocation({ ...record, cancel_requested: true });
    }
    return { acknowledged: true };
  }

  openCount(): number {
    return [...this.open.values()].filter((o) => o.phase !== 'done').length;
  }

  openActionIds(): string[] {
    return [...this.open.values()].filter((o) => o.phase !== 'done').map((o) => o.action_id);
  }

  openInvocationIds(): string[] {
    return [...this.open.values()].filter((o) => o.phase !== 'done').map((o) => o.invocation_id);
  }

  /** Advance a held invocation. Inspect/assemble complete; publish honours gates. */
  release(action_id: string): void {
    const open = this.findOpen(action_id);
    if (!open) {
      throw new Error(`agentfabric: no open invocation for ${action_id}`);
    }
    this.advance(open);
  }

  releaseAll(): string[] {
    const ids = this.openActionIds();
    for (const id of ids) {
      this.release(id);
    }
    return ids;
  }

  invalidate(action_id: string): void {
    const open = this.findOpen(action_id);
    if (open) {
      this.authority.revoke(open.grant);
    }
  }

  /** Continue a publish paused at a gate. */
  proceed(action_id: string): void {
    const open = this.findOpen(action_id);
    if (!open) {
      throw new Error(`agentfabric: no open invocation for ${action_id}`);
    }
    this.advance(open);
  }

  private findOpen(action_id: string): OpenInvocation | undefined {
    return [...this.open.values()].find((o) => o.action_id === action_id && o.phase !== 'done');
  }

  private advance(open: OpenInvocation): void {
    if (open.phase === 'running') {
      return;
    }
    if (isShellOperation(open.operation)) {
      if (open.phase !== 'held') {
        return;
      }
      open.phase = 'before_commit';
      if (this.store.getInvocation(open.invocation_id)?.cli_generation) {
        const resolve = open.resolve;
        open.resolve = (outcome) => {
          // Record uncertainty first, then compare while the reservation is held.
          void this.checkUncertainCliGeneration(open.invocation_id, true).then(() => {
            const record = this.store.getInvocation(open.invocation_id);
            resolve(
              outcome.outcome === 'uncertain' && record?.reconciliation?.resolution === 'not_committed'
                ? { outcome: 'failed', failure: outcome.reason }
                : outcome,
            );
          });
        };
      }
      void this.performShell(open).then(
        (outcome) => {
          if (open.phase === 'done') {
            return;
          }
          this.finish(open, outcome);
        },
        () => {
          if (open.phase === 'done') {
            return;
          }
          this.finish(open, this.implementationFault(open, 'execution_fault'));
        },
      );
      return;
    }
    if (this.status.get(open.operation) === 'unavailable') {
      this.finish(open, { outcome: 'failed', failure: 'UNRESOLVED' });
      return;
    }
    const selectedId = selectAdmittedImplementation(this.implementationRecords(open.operation));
    const implementation = (this.admitted.get(open.operation) ?? []).find((record) => record.id === selectedId);
    if (implementation) {
      if (open.phase !== 'held') {
        return;
      }
      const contract = this.live.get(open.operation);
      if (!contract) {
        this.finish(open, { outcome: 'failed', failure: 'UNKNOWN_CAPABILITY' });
        return;
      }
      // Consume the release before run can reenter the host. The executor also
      // turns synchronous throws into the same settlement as rejected promises.
      open.phase = 'running';
      void new Promise<InvocationOutcome>((resolve) => {
        resolve(implementation.run(open.inputs, this.resolverContext(contract)));
      }).then(
        (outcome) => {
          if (open.phase === 'done') {
            return;
          }
          this.finish(open, outcome);
        },
        (error: unknown) => {
          if (open.phase === 'done') {
            return;
          }
          this.finish(
            open,
            this.implementationFault(open, error instanceof Error ? error.message : 'implementation threw'),
          );
        },
      );
      return;
    }
    if (open.operation === SOURCE_INSPECT.id) {
      this.finish(open, this.performInspect(open));
      return;
    }
    if (open.operation === REPORT_ASSEMBLE.id) {
      this.finish(open, this.performAssemble(open));
      return;
    }
    if (open.operation !== REPORT_PUBLISH.id) {
      this.finish(open, { outcome: 'failed', failure: 'UNKNOWN_CAPABILITY' });
      return;
    }
    this.advancePublish(open);
  }

  private advancePublish(open: OpenInvocation): void {
    if (open.phase === 'held') {
      open.phase = 'before_commit';
      if ((this.faults.publishGate ?? 'none') === 'before_commit') {
        return;
      }
    }
    if (open.phase === 'before_commit') {
      if (open.cancel_requested && !open.committed) {
        this.finish(open, { outcome: 'failed', failure: 'cancelled' }, 'stopped');
        return;
      }
      if (this.faults.throwBeforeCommit) {
        this.finishUncertain(open, 'host threw before commit');
        return;
      }
      const committed = this.commitPublish(open);
      if (committed.kind === 'outcome') {
        this.finish(open, committed.outcome, committed.status);
        return;
      }
      open.committed = committed.record;
      open.phase = 'after_commit';
      if (this.faults.throwAfterCommit) {
        this.finishUncertain(open, 'host threw after commit');
        return;
      }
      if ((this.faults.publishGate ?? 'none') === 'after_commit' || this.faults.disconnectAfterCommit) {
        this.noteCommitted(open, committed.record);
        return;
      }
    }
    if (open.phase === 'after_commit' && open.committed) {
      if (this.faults.rejectPromiseAfterCommit) {
        if (!this.noteCommitted(open, open.committed)) return;
        open.phase = 'done';
        open.resolve({ outcome: 'uncertain', reason: 'acknowledgement rejected after commit' });
        this.open.delete(open.invocation_id);
        return;
      }
      const receipt = this.receiptFrom(open.committed);
      this.finish(open, { outcome: 'succeeded', output: receipt }, 'committed');
    }
  }

  private noteCommitted(open: OpenInvocation, record: PublicationRecord): boolean {
    const outcome: InvocationOutcome = { outcome: 'succeeded', output: this.receiptFrom(record) };
    try {
      this.store.persistInvocationResult({
        invocation_id: open.invocation_id,
        action_id: open.action_id,
        operation: open.operation,
        implementation_id: open.implementation_id,
        binding_digest: open.binding_digest,
        inputs: open.inputs,
        status: 'committed',
        outcome,
        cancel_requested: open.cancel_requested,
      });
    } catch {
      this.finishUncertain(open, 'failed to persist invocation result after commit');
      return false;
    }
    open.outcome = outcome;
    return true;
  }

  private implementationFault(open: OpenInvocation, reason: string): InvocationOutcome {
    // A fault does not establish whether execution already produced effects.
    return hasDeclaredWrites(open.effects) ? { outcome: 'uncertain', reason } : { outcome: 'failed', failure: reason };
  }

  private finish(open: OpenInvocation, value: unknown, status?: InvocationRecord['status']): void {
    this.step(() => this.finishStep(open, value, status));
  }

  private finishStep(open: OpenInvocation, value: unknown, status?: InvocationRecord['status']): void {
    let outcome: InvocationOutcome;
    try {
      outcome = normalizeInvocationOutcome(value);
    } catch {
      outcome = this.implementationFault(open, 'implementation returned an invalid outcome');
      status = outcome.outcome === 'uncertain' ? 'uncertain' : 'stopped';
    }
    const terminal: InvocationRecord['status'] =
      status ??
      (outcome.outcome === 'succeeded' ? 'committed' : outcome.outcome === 'uncertain' ? 'uncertain' : 'stopped');
    let persisted = false;
    const record: InvocationRecord = {
      invocation_id: open.invocation_id,
      action_id: open.action_id,
      operation: open.operation,
      implementation_id: open.implementation_id,
      binding_digest: open.binding_digest,
      inputs: open.inputs,
      status: terminal,
      outcome,
      cancel_requested: open.cancel_requested,
    };
    try {
      if (terminal === 'uncertain') this.store.persistInvocationUncertain(record);
      else this.store.persistInvocationResult(record);
      persisted = true;
    } catch {
      const durable = this.store.getInvocation(open.invocation_id);
      if (durable?.status === 'committed' && durable.outcome) {
        // noteCommitted may already have recorded the result. A later failed
        // write cannot downgrade durable evidence or retain an uncertain hold.
        outcome = durable.outcome;
        persisted = true;
      } else {
        // Store guards and validation can fail as well as append. A completed
        // implementation must still settle; publications await reconciliation.
        outcome = {
          outcome: 'uncertain',
          reason: open.committed
            ? 'failed to persist invocation result after commit'
            : 'failed to persist invocation result',
        };
        try {
          this.store.persistInvocationUncertain({ ...record, status: 'uncertain', outcome });
          persisted = true;
        } catch {
          // A closed/poisoned store or lost lock cannot record the marker. Keep
          // the settled entry; its durable start also recovers as uncertain.
          outcome = { ...outcome, reason: `${outcome.reason}; uncertain marker was not persisted` };
        }
      }
    }
    if (outcome.outcome !== 'uncertain' || !hasDeclaredWrites(open.effects)) {
      this.coordinator.release(open.invocation_id);
    }
    open.outcome = outcome;
    open.phase = 'done';
    this.weft?.invoked(
      open.invocation_id,
      open.implementation_id,
      open.grant.contract_rev,
      open.cancel_requested && outcome.outcome !== 'succeeded' ? 'cancelled' : outcome.outcome,
      open.attempt,
    );
    // A failed marker write leaves a running durable record. Retain the
    // settled uncertainty until durable reconciliation removes it.
    if (persisted) this.open.delete(open.invocation_id);
    if (outcome.outcome === 'succeeded') {
      try {
        const key = this.builtinCacheKey(open.operation, open.inputs);
        if (key) {
          this.store.rememberResult({
            key,
            operation: open.operation,
            implementation_id: open.implementation_id,
            outcome,
          });
        }
      } catch {
        // The invocation result is durable; cache maintenance is optional.
      }
    }
    open.resolve(outcome);
  }

  private finishUncertain(open: OpenInvocation, reason: string): void {
    this.finish(open, { outcome: 'uncertain', reason }, 'uncertain');
  }

  private cachedBuiltin(operation: string, inputs: unknown): CachedBuiltin | null {
    const key = this.builtinCacheKey(operation, inputs);
    if (!key) {
      return null;
    }
    return this.store.cachedResult(key) ?? null;
  }

  /** Inspect and assemble only. `text.normalize` is reused through a conclusion, not this cache. */
  private builtinCacheKey(operation: string, inputs: unknown): string | null {
    if (operation === SOURCE_INSPECT.id) {
      const source = (inputs as { source?: string }).source;
      if (!source) {
        return null;
      }
      const resource = this.resourceFor(source);
      if (!resource) {
        return null;
      }
      return digest({
        operation,
        canonical_id: resource.canonical_id,
        revision: resource.revision,
        content: resource.content,
      });
    }
    if (operation === REPORT_ASSEMBLE.id) {
      return digest({ operation, inputs });
    }
    return null;
  }

  private invalidGrantReason(grant: Grant | null): string | undefined {
    if (!this.authority.isIssued(grant)) return 'grant is not issued by this authority';
    if (!this.authority.isValid(grant)) return 'grant was revoked';
    return undefined;
  }

  /** Shared input, issuance, validity and coverage checks; never consumes a grant. */
  private validateInvocation(
    grant: Grant | null,
    operation: string,
    inputs: unknown,
    options?: InvokeOptions,
  ):
    | {
        kind: 'validated';
        boundInputs: Record<string, unknown>;
        effects: readonly ResourceEffect[];
        existing: InvocationRecord | undefined;
      }
    | InvocationRejected {
    let contract = this.live.get(operation);
    if (!contract) {
      if (this.historical.has(operation)) {
        return this.reject('UNRESOLVED', `${operation} is not currently resolved`);
      }
      return this.reject('UNKNOWN_CAPABILITY', `unknown operation ${operation}`);
    }
    const existing = grant ? this.store.getInvocation(options?.invocation_id ?? grant.action_id) : undefined;
    if (existing?.operation === operation) contract = this.invocationContract(existing) ?? contract;
    if (!isRecord(inputs)) {
      return this.reject('INVALID_INPUT', 'inputs must be a record');
    }
    const boundInputs = structuredClone(inputs);
    if (!isRecord(boundInputs)) {
      return this.reject('INVALID_INPUT', 'inputs must be a record');
    }
    const shape = closedShape(contract.input, boundInputs);
    if (!shape.ok) {
      return this.reject('INVALID_INPUT', shape.reason);
    }
    const required = bindSelectors(contract.permissions, boundInputs);
    if (!required.ok) {
      return this.reject(required.code, required.reason);
    }
    const declared = bindSelectors(contract.effects, boundInputs);
    if (!declared.ok) {
      return this.reject(declared.code, declared.reason);
    }
    let processTokens: readonly string[] | undefined;
    if (contract.process_effects !== undefined) {
      const boundProcess = bindProcessEffects(contract.process_effects, boundInputs);
      if (!boundProcess.ok) {
        return this.reject(boundProcess.code, boundProcess.reason);
      }
      processTokens = boundProcess.tokens;
    }
    const invalid = this.invalidGrantReason(grant);
    if (invalid) return this.reject('DENIED', invalid);
    const covered =
      processTokens === undefined
        ? grantCovers(grant, operation, contract.revision, required.bound, declared.bound)
        : grantCovers(grant, operation, contract.revision, required.bound, declared.bound, processTokens);
    if (!covered.ok) {
      return this.reject(covered.code, covered.reason);
    }
    if (operation === REPORT_PUBLISH.id) {
      const binding = publishSetsAgree(boundInputs, (ref) => this.store.lookupRef(ref)?.canonical_id ?? ref);
      if (!binding.ok) {
        return this.reject('INVALID_INPUT', binding.reason);
      }
    }
    return { kind: 'validated', boundInputs, effects: declared.bound, existing };
  }

  /** Shared reconciliation and resolution gates; run before grant consumption. */
  private resolutionRejection(operation: string): InvocationRejected | undefined {
    if ([...this.unscopedRecovery.values()].includes(operation)) {
      return this.reject('RESOLVER_ERROR', 'operation requires reconciliation of recovered effect scopes');
    }
    if (this.status.get(operation) !== 'resolved') {
      return this.reject('UNRESOLVED', `${operation} is ${this.status.get(operation)}`);
    }
    return undefined;
  }

  /** Shared resource existence and kind checks; run after grant consumption. */
  private resourceRejection(operation: string, effects: readonly ResourceEffect[]): InvocationRejected | undefined {
    for (const effect of effects) {
      const issued = this.store.lookupRef(effect.resource);
      if (!issued) {
        return this.reject('UNKNOWN_RESOURCE', 'unknown resource');
      }
      if (operation === REPORT_PUBLISH.id) {
        if (effect.mode === 'write' && issued.kind !== 'destination') {
          return this.reject('KIND_MISMATCH', 'destination reference has the wrong kind');
        }
        if (effect.mode === 'read' && issued.kind !== 'source') {
          return this.reject('KIND_MISMATCH', 'source reference has the wrong kind');
        }
      } else if (operation === SOURCE_INSPECT.id && issued.kind !== 'source') {
        return this.reject('KIND_MISMATCH', 'source reference has the wrong kind');
      } else if (isShellOperation(operation) && issued.kind !== 'workspace') {
        return this.reject('KIND_MISMATCH', 'workspace reference has the wrong kind');
      }
    }
    return undefined;
  }

  private prepare(
    grant: Grant | null,
    operation: string,
    inputs: unknown,
    options?: InvokeOptions,
    reservedCliId?: string,
  ):
    | { kind: 'open'; open: OpenInvocation; record: InvocationRecord }
    | { kind: 'replay'; handle: InvocationHandle }
    | InvocationRejected {
    const checked = this.validateInvocation(grant, operation, inputs, options);
    if (checked.kind === 'rejected') return checked;
    const { boundInputs, effects, existing } = checked;
    const action_id = (grant as Grant).action_id;
    const invocation_id = options?.invocation_id ?? action_id;
    const binding_digest = digest({ operation, inputs: boundInputs });
    if (existing && existing.action_id !== action_id) {
      return this.reject('DENIED', 'grant does not name this invocation');
    }
    if (existing && existing.binding_digest !== binding_digest) {
      return this.reject('DENIED', 'invocation identity is bound to a different input');
    }
    // A CLI generation re-run supersedes a stopped attempt instead of replaying it (WV-040).
    const rerun = existing?.status === 'stopped' && reservedCliId === invocation_id;
    if (existing && (existing.status === 'committed' || (existing.reconciliation && !rerun)) && existing.outcome) {
      this.authority.markInvoked(grant as Grant);
      return { kind: 'replay', handle: this.replayCompleted(existing) };
    }
    const inMemory = this.open.get(invocation_id) ?? this.preparingCli.get(invocation_id);
    if (existing && (!inMemory || inMemory.phase === 'done')) {
      const published = this.reconcilePublication(invocation_id, existing.status);
      if (published) {
        this.authority.markInvoked(grant as Grant);
        return {
          kind: 'replay',
          handle: this.replayCompleted({
            ...existing,
            status: published.status === 'committed' ? 'committed' : 'uncertain',
            outcome:
              published.status === 'unresolved'
                ? { outcome: 'uncertain', reason: published.reason }
                : published.outcome,
          }),
        };
      }
    }
    if (
      existing &&
      (existing.status === 'uncertain' || (existing.status === 'running' && (!inMemory || inMemory.phase === 'done')))
    ) {
      this.authority.markInvoked(grant as Grant);
      return {
        kind: 'replay',
        handle: this.replayCompleted({
          ...existing,
          status: 'uncertain',
          outcome: inMemory?.outcome ?? existing.outcome ?? { outcome: 'uncertain', reason: RECOVERED_UNCERTAINTY },
        }),
      };
    }
    if (inMemory || (this.reservedCliIds.has(invocation_id) && reservedCliId !== invocation_id))
      return this.reject('DENIED', 'invocation is already active');
    const unresolved = this.resolutionRejection(operation);
    if (unresolved) return unresolved;
    const cached = this.cachedBuiltin(operation, boundInputs);
    if (cached && grant) {
      return {
        kind: 'replay',
        handle: {
          kind: 'handle',
          action_id: grant.action_id,
          invocation_id,
          implementation_id: cached.implementation_id,
          result: Promise.resolve(cached.outcome),
          requestCancel: () => {
            this.requestCancel(invocation_id);
          },
        },
      };
    }
    let shellCall: ParsedShellCall | null = null;
    let shellEnv: Record<string, string> = {};
    let shellSecrets: string[] = [];
    if (isShellOperation(operation)) {
      const preparedShell = this.prepareShell(operation, boundInputs);
      if (!preparedShell.ok) {
        return this.reject(preparedShell.code, preparedShell.reason);
      }
      shellCall = preparedShell.call;
      shellEnv = preparedShell.env;
      shellSecrets = preparedShell.secrets;
    }
    if (!this.authority.markInvoked(grant as Grant)) {
      return this.reject('DENIED', this.invalidGrantReason(grant) ?? 'grant has already been used for an invocation');
    }
    const resource = this.resourceRejection(operation, effects);
    if (resource) return resource;
    const conflict = this.coordinator.acquire(invocation_id, effects, (ref) => {
      const issued = this.store.lookupRef(ref);
      return issued?.canonical_id ?? ref;
    });
    if (conflict) {
      return this.reject('RESOLVER_ERROR', `effect conflict on ${conflict.canonical_id}`);
    }
    const implementation_id =
      selectAdmittedImplementation(this.implementationRecords(operation)) ??
      (trustedBuiltin(operation) ? 'builtin' : 'unresolved');
    const open: OpenInvocation = {
      invocation_id,
      action_id,
      operation,
      implementation_id,
      inputs: boundInputs,
      grant: grant as Grant,
      effects,
      binding_digest,
      phase: 'held',
      cancel_requested: false,
      abort: new AbortController(),
      shellArgv: shellCall?.argv ?? [],
      shellStdin: shellCall?.stdin ?? '',
      shellEnv,
      shellSecrets,
      shellEnvAllow: shellCall?.env_allow ?? [],
      shellTimeout: shellCall?.timeout_ms ?? 0,
      shellCwdRef: shellCall?.cwd_ref ?? '',
      resolve: () => undefined,
      committed: null,
      outcome: null,
      ...(rerun && existing ? { attempt: (existing.attempt ?? 1) + 1 } : {}),
    };
    const record: InvocationRecord = {
      invocation_id,
      action_id,
      operation,
      implementation_id,
      binding_digest,
      inputs: boundInputs,
      status: 'running',
      outcome: null,
      cancel_requested: false,
      reservation: effects.map((effect) => ({
        resource: this.store.lookupRef(effect.resource)?.canonical_id ?? effect.resource,
        mode: effect.mode,
      })),
      ...(open.attempt === undefined ? {} : { attempt: open.attempt }),
    };
    return { kind: 'open', open, record };
  }

  private restoreReservations(): void {
    for (const record of this.store.invocationRecords()) {
      if (record.status !== 'running' && record.status !== 'uncertain') continue;
      let effects = record.reservation;
      if (effects === undefined) {
        // Legacy journals did not retain scopes or a contract revision. Only
        // the admission of the implementation that ran identifies that revision;
        // the current contract may have narrowed its effects since execution.
        const admissions =
          record.implementation_id === undefined
            ? []
            : this.store
                .admitted()
                .filter(
                  (admission) =>
                    admission.operation === record.operation &&
                    admission.contract.id === record.operation &&
                    admission.implementation_id === record.implementation_id,
                );
        const first = admissions[0]?.contract;
        // An implementation id alone cannot identify a revision when a legacy
        // snapshot contains conflicting admissions. Retain an operation block
        // instead of guessing the first admission's effect scopes.
        const contract =
          first &&
          admissions.every(
            ({ contract }) =>
              contract.revision === first.revision && digest(contract.effects) === digest(first.effects),
          )
            ? first
            : undefined;
        const bound = contract && bindSelectors(contract.effects, record.inputs);
        if (bound?.ok) {
          effects = bound.bound.map((effect) => ({
            resource: this.store.lookupRef(effect.resource)?.canonical_id ?? effect.resource,
            mode: effect.mode,
          }));
        } else {
          this.unscopedRecovery.set(record.invocation_id, record.operation);
        }
      }
      if (effects && hasDeclaredWrites(effects)) {
        this.coordinator.restore(record.invocation_id, effects);
      }
      if (record.status === 'running') {
        try {
          this.store.persistInvocationUncertain({
            ...record,
            ...(effects ? { reservation: effects } : {}),
            status: 'uncertain',
            outcome: { outcome: 'uncertain', reason: RECOVERED_UNCERTAINTY },
          });
        } catch {
          // Interrupted starts already replay as uncertain. A failed marker
          // cannot wedge construction or remove the recovered protection.
        }
      }
    }
  }

  private configuredArgv(operation: string): readonly string[] | null {
    if (!this.repoCommands) {
      return null;
    }
    if (operation === REPO_TEST.id) {
      return this.repoCommands.test;
    }
    if (operation === REPO_LINT.id) {
      return this.repoCommands.lint;
    }
    if (operation === REPO_BUILD.id) {
      return this.repoCommands.build;
    }
    return null;
  }

  /**
   * Resolve argv and environment before the grant is consumed.
   * Repo commands take argv from host config. A value named by env_allow is
   * injected later and must not already be on argv or stdin.
   */
  private prepareShell(
    operation: string,
    inputs: Record<string, unknown>,
  ):
    | { ok: true; call: ParsedShellCall; env: Record<string, string>; secrets: string[] }
    | { ok: false; code: FailureCode; reason: string } {
    if (!this.shellOptions) {
      return { ok: false, code: 'DENIED', reason: 'denied' };
    }
    const configured = this.configuredArgv(operation);
    if (isRepoOperation(operation) && !configured) {
      return { ok: false, code: 'DENIED', reason: 'denied' };
    }
    const argv = configured ?? (Array.isArray(inputs['argv']) ? inputs['argv'] : []);
    const parsed = parseShellCall(inputs, argv);
    if (!parsed.ok) {
      return { ok: false, code: 'INVALID_INPUT', reason: parsed.reason };
    }
    const looked = lookupEnv(this.shellOptions.env, parsed.value.env_allow);
    if (!looked.ok) {
      return { ok: false, code: 'DENIED', reason: 'denied' };
    }
    if (containsSecret([parsed.value.stdin, ...parsed.value.argv], looked.secrets)) {
      return { ok: false, code: 'DENIED', reason: 'denied' };
    }
    return { ok: true, call: parsed.value, env: { ...looked.env }, secrets: [...looked.secrets] };
  }

  private async performShell(open: OpenInvocation): Promise<InvocationOutcome> {
    let processStarted = false;
    let faultReason: ShellFailure = 'execution_fault';
    let failureBeforeStart: ShellFailure | undefined;
    try {
      if (!this.shellOptions) {
        failureBeforeStart = 'denied';
        this.pushShellTrace(open, {
          exit: null,
          failure: 'denied',
          duration_ms: 0,
          stdout_tail: '',
          stderr_tail: '',
          artifacts: [],
        });
        return { outcome: 'failed', failure: 'denied' };
      }
      if (open.cancel_requested || open.abort.signal.aborted) {
        failureBeforeStart = 'cancelled';
        this.pushShellTrace(open, {
          exit: null,
          failure: 'cancelled',
          duration_ms: 0,
          stdout_tail: '',
          stderr_tail: '',
          artifacts: [],
        });
        return { outcome: 'failed', failure: 'cancelled' };
      }
      const resource = this.resourceFor(open.shellCwdRef);
      if (!resource || resource.kind !== 'workspace') {
        failureBeforeStart = 'denied';
        this.pushShellTrace(open, {
          exit: null,
          failure: 'denied',
          duration_ms: 0,
          stdout_tail: '',
          stderr_tail: '',
          artifacts: [],
        });
        return { outcome: 'failed', failure: 'denied' };
      }
      const requested = this.shellOptions.tail_chars;
      const tail_chars =
        typeof requested === 'number' && Number.isInteger(requested) && requested >= 1 && requested <= 65_536
          ? requested
          : SHELL_TAIL_CHARS;
      this.shellSpawns.push({
        argv: redactArgv(open.shellArgv, open.shellSecrets),
        env_names: Object.keys(open.shellEnv).sort(),
      });
      const before = snapshotFiles(resource.locator);
      const result = await runProcess({
        argv: open.shellArgv,
        cwd: resource.locator,
        env: open.shellEnv,
        stdin: open.shellStdin,
        timeout_ms: open.shellTimeout,
        signal: open.abort.signal,
        clock: this.shellOptions.clock,
        timer: this.shellOptions.timer,
        tail_chars,
        onStarted: (pgid) => {
          processStarted = true;
          if (pgid !== undefined && this.store.getInvocation(open.invocation_id)?.cli_generation) {
            this.store.persistCliGenerationStarted(open.invocation_id, pgid);
          }
        },
      });
      const stdout_tail = redactSecrets(result.stdout_tail, open.shellSecrets);
      const stderr_tail = redactSecrets(result.stderr_tail, open.shellSecrets);
      if (!result.ok) {
        if (processStarted) faultReason = result.failure;
        else failureBeforeStart = result.failure;
        this.pushShellTrace(open, {
          exit: null,
          failure: result.failure,
          duration_ms: result.duration_ms,
          stdout_tail,
          stderr_tail,
          artifacts: [],
        });
        return processStarted && hasDeclaredWrites(open.effects)
          ? { outcome: 'uncertain', reason: faultReason }
          : { outcome: 'failed', failure: result.failure };
      }
      const created = newFilesInside(resource.locator, before, snapshotFiles(resource.locator));
      const artifacts = this.issueArtifacts(resource.locator, created);
      this.pushShellTrace(open, {
        exit: result.exit,
        failure: null,
        duration_ms: result.duration_ms,
        stdout_tail,
        stderr_tail,
        artifacts,
      });
      return {
        outcome: 'succeeded',
        output: {
          exit: result.exit,
          stdout_truncated: result.stdout_truncated,
          stdout_tail,
          stderr_tail,
          duration_ms: result.duration_ms,
          artifacts,
        },
      };
    } catch {
      // Trace recording cannot invalidate evidence that execution never began.
      if (failureBeforeStart !== undefined) return { outcome: 'failed', failure: failureBeforeStart };
      // Snapshot and post-run bookkeeping faults do not prove absence of effects.
      return this.implementationFault(open, faultReason);
    } finally {
      open.shellEnv = {};
      open.shellSecrets = [];
    }
  }

  private pushShellTrace(
    open: OpenInvocation,
    fields: {
      exit: number | null;
      failure: ShellFailure | null;
      duration_ms: number;
      stdout_tail: string;
      stderr_tail: string;
      artifacts: readonly string[];
    },
  ): void {
    const record = {
      schema: 'shell.trace@1' as const,
      argv: redactArgv(open.shellArgv, open.shellSecrets),
      cwd_ref: open.shellCwdRef,
      env_allow: [...open.shellEnvAllow],
      exit: fields.exit,
      failure: fields.failure,
      duration_ms: fields.duration_ms,
      stdout_tail: redactSecrets(fields.stdout_tail, open.shellSecrets),
      stderr_tail: redactSecrets(fields.stderr_tail, open.shellSecrets),
      artifacts: [...fields.artifacts],
    };
    if (isRepoOperation(open.operation)) {
      this.shellTraceLog.push({ ...record, id: open.invocation_id, parentId: null, operation: open.operation });
      this.shellTraceLog.push({
        ...record,
        id: `${open.invocation_id}:shell`,
        parentId: open.invocation_id,
        operation: SHELL_RUN.id,
      });
      return;
    }
    this.shellTraceLog.push({ ...record, id: open.invocation_id, parentId: null, operation: open.operation });
  }

  private issueArtifacts(root: string, relativePaths: readonly string[]): string[] {
    const refs: string[] = [];
    const rootResolved = resolve(root);
    for (const rel of relativePaths) {
      const full = resolve(root, rel);
      if (full !== rootResolved && !full.startsWith(`${rootResolved}${sep}`)) {
        continue;
      }
      const canonical_id = this.store.allocateCanonical();
      this.store.putResource({
        canonical_id,
        kind: 'source',
        locator: full,
        revision: 1,
        content: '',
        publication: null,
      });
      refs.push(this.store.issue(canonical_id, 'source'));
    }
    return refs;
  }

  private performInspect(open: OpenInvocation): InvocationOutcome {
    const source = (open.inputs as { source: string }).source;
    this.noteAccess(source, 'read');
    const resource = this.resourceFor(source);
    if (!resource) {
      return { outcome: 'failed', failure: 'not_found' };
    }
    return {
      outcome: 'succeeded',
      output: {
        source,
        revision: resource.revision,
        line_count: resource.content === '' ? 0 : resource.content.split('\n').length,
        digest: contentDigest(resource.content),
      },
    };
  }

  private performAssemble(open: OpenInvocation): InvocationOutcome {
    const inspections = (open.inputs as { inspections: { source: string; revision: number }[] }).inspections;
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

  private commitPublish(
    open: OpenInvocation,
  ):
    | { kind: 'outcome'; outcome: InvocationOutcome; status: InvocationRecord['status'] }
    | { kind: 'committed'; record: PublicationRecord } {
    const input = open.inputs as PublishInput;
    if (!this.authority.isValid(open.grant)) {
      return { kind: 'outcome', outcome: { outcome: 'failed', failure: 'access_denied' }, status: 'stopped' };
    }
    const binding = publishSetsAgree(input, (ref) => this.store.lookupRef(ref)?.canonical_id ?? ref);
    if (!binding.ok) {
      return { kind: 'outcome', outcome: { outcome: 'failed', failure: 'INVALID_INPUT' }, status: 'stopped' };
    }
    const published = this.store.publishedBy(open.invocation_id)?.publication;
    if (published) {
      if (published.binding_digest !== open.binding_digest) {
        return { kind: 'outcome', outcome: { outcome: 'failed', failure: 'binding_conflict' }, status: 'stopped' };
      }
      return { kind: 'committed', record: published };
    }
    for (const source of input.sources) {
      const entry = input.read_set.find((item) => this.sameResource(item.resource, source));
      if (!entry) {
        return { kind: 'outcome', outcome: { outcome: 'failed', failure: 'INVALID_INPUT' }, status: 'stopped' };
      }
      this.noteAccess(source, 'read');
      const resource = this.resourceFor(source);
      if (!resource || resource.revision !== entry.revision) {
        return { kind: 'outcome', outcome: { outcome: 'failed', failure: 'stale_revision' }, status: 'stopped' };
      }
    }
    this.noteAccess(input.destination, 'write');
    const dest = this.resourceFor(input.destination);
    if (!dest || dest.kind !== 'destination') {
      return { kind: 'outcome', outcome: { outcome: 'failed', failure: 'not_found' }, status: 'stopped' };
    }
    if (dest.revision !== input.expected_revision) {
      return { kind: 'outcome', outcome: { outcome: 'failed', failure: 'stale_revision' }, status: 'stopped' };
    }
    const report_digest = digest(input.report);
    const binding_digest = open.binding_digest;
    const existingInv = this.store.getInvocation(open.invocation_id);
    if (existingInv?.status === 'committed' && existingInv.outcome?.outcome === 'succeeded') {
      const output = existingInv.outcome.output as PublishReceipt;
      return {
        kind: 'committed',
        record: {
          invocation_id: open.invocation_id,
          binding_digest,
          report_digest: output.report_digest,
          destination: output.destination,
          committed_revision: output.committed_revision,
        },
      };
    }
    const record: PublicationRecord = {
      invocation_id: open.invocation_id,
      binding_digest,
      report_digest,
      destination: input.destination,
      committed_revision: dest.revision + 1,
    };
    this.store.putResource({
      ...dest,
      revision: dest.revision + 1,
      content: report_digest,
      publication: record,
    });
    return { kind: 'committed', record };
  }

  private receiptFrom(record: PublicationRecord): PublishReceipt {
    return {
      invocation_id: record.invocation_id,
      report_digest: record.report_digest,
      destination: record.destination,
      committed_revision: record.committed_revision,
    };
  }

  private replayCompleted(existing: InvocationRecord): InvocationHandle {
    const outcome = existing.outcome as InvocationOutcome;
    return {
      kind: 'handle',
      action_id: existing.action_id,
      invocation_id: existing.invocation_id,
      implementation_id: existing.implementation_id ?? 'builtin',
      result: Promise.resolve(outcome),
      requestCancel: () => {
        this.requestCancel(existing.invocation_id);
      },
    };
  }

  private resourceFor(handle: ResourceRef) {
    const issued = this.store.lookupRef(handle);
    if (!issued) {
      return undefined;
    }
    return this.store.getResource(issued.canonical_id);
  }

  private noteAccess(handle: string, operation: string): void {
    this.resourceAccesses.push({ handle, operation });
  }

  /**
   * Run one host step. Weft records it builds reach the port once the
   * outermost step has completed, never mid-invocation or mid-settlement.
   */
  private step<T>(run: () => T): T {
    return this.weft ? this.weft.step(run) : run();
  }

  private reject(code: FailureCode, reason: string): InvocationRejected {
    const rejection: InvocationRejected = { kind: 'rejected', code, reason };
    this.rejections.push(rejection);
    this.weft?.rejected(code);
    return rejection;
  }

  private sameResource(left: ResourceRef, right: ResourceRef): boolean {
    return (this.store.lookupRef(left)?.canonical_id ?? left) === (this.store.lookupRef(right)?.canonical_id ?? right);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publishSetsAgree(
  input: Record<string, unknown> | PublishInput,
  canonical: (ref: string) => string,
): { ok: true } | { ok: false; reason: string } {
  const sources = (input as PublishInput).sources;
  const read_set = (input as PublishInput).read_set;
  const report = (input as PublishInput).report;
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    !Array.isArray(read_set) ||
    !report ||
    !Array.isArray(report.read_set)
  ) {
    return { ok: false, reason: 'publication sources and read sets are required' };
  }
  const sourceIds = uniqueCanonical(sources, canonical);
  if (!sourceIds.ok) {
    return sourceIds;
  }
  const readIds = uniqueCanonical(
    read_set.map((entry) => entry.resource),
    canonical,
  );
  if (!readIds.ok) {
    return readIds;
  }
  const reportIds = uniqueCanonical(
    report.read_set.map((entry) => entry.resource),
    canonical,
  );
  if (!reportIds.ok) {
    return reportIds;
  }
  if (!sameSet(sourceIds.ids, readIds.ids) || !sameSet(sourceIds.ids, reportIds.ids)) {
    return { ok: false, reason: 'publication sources, read_set, and report.read_set must name the same resources' };
  }
  for (const source of sources) {
    const key = canonical(source);
    const fromRead = read_set.find((entry) => canonical(entry.resource) === key);
    const fromReport = report.read_set.find((entry) => canonical(entry.resource) === key);
    if (!fromRead || !fromReport || fromRead.revision !== fromReport.revision) {
      return { ok: false, reason: 'publication read-set revisions must match the report' };
    }
  }
  return { ok: true };
}

function uniqueCanonical(
  refs: readonly string[],
  canonical: (ref: string) => string,
): { ok: true; ids: readonly string[] } | { ok: false; reason: string } {
  const ids = refs.map(canonical);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'publication resource set contains duplicates' };
  }
  return { ok: true, ids };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const wanted = new Set(left);
  return right.every((id) => wanted.delete(id)) && wanted.size === 0;
}

const HOST_INVOCATION_MICROS = 1_000;
const RECOVERED_UNCERTAINTY = 'execution outcome requires reconciliation after restart';

function hasDeclaredWrites(effects: readonly ResourceEffect[]): boolean {
  return effects.some((effect) => effect.mode !== 'read' && effect.mode !== 'discover');
}

function isCliGeneration(record: InvocationRecord): boolean {
  return (
    record.operation === SHELL_RUN.id &&
    (record.cli_generation !== undefined || record.action_id.startsWith('shell-cli:'))
  );
}

const TRUSTED_BUILTINS: ReadonlySet<string> = new Set([
  SOURCE_INSPECT.id,
  REPORT_ASSEMBLE.id,
  REPORT_PUBLISH.id,
  SHELL_RUN.id,
  REPO_TEST.id,
  REPO_LINT.id,
  REPO_BUILD.id,
]);

function trustedBuiltin(id: string): boolean {
  return TRUSTED_BUILTINS.has(id);
}

interface CachedBuiltin {
  readonly implementation_id: string;
  readonly outcome: InvocationOutcome;
}

function isGenerationKind(kind: string): kind is GenerationKind {
  return (GENERATION_KINDS as readonly string[]).includes(kind);
}

function closedShape(
  schema: Readonly<Record<string, string>>,
  inputs: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const expected = new Set(Object.keys(schema));
  const keys = Object.keys(inputs);
  for (const key of keys) {
    if (!expected.has(key)) {
      return { ok: false, reason: `unexpected field '${key}'` };
    }
  }
  for (const key of expected) {
    if (!(key in inputs)) {
      const typeName = schema[key];
      if (typeof typeName === 'string' && typeName.endsWith('?')) {
        continue;
      }
      return { ok: false, reason: `missing field '${key}'` };
    }
  }
  return { ok: true };
}

function isDirectory(locator: string): boolean {
  try {
    return statSync(locator).isDirectory();
  } catch {
    return false;
  }
}

export { FIXTURE_CONTRACTS, REPORT_ASSEMBLE, REPORT_PUBLISH, SOURCE_INSPECT };
