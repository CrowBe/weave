import {
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
import { ResourceCoordinator } from './coordinator.js';
import { FIXTURE_CONTRACTS, REPORT_ASSEMBLE, REPORT_PUBLISH, SOURCE_INSPECT } from './contracts.js';
import { contentDigest, digest } from './digest.js';
import {
  FabricStore,
  PersistFailure,
  type FabricSnapshot,
  type InvocationRecord,
  type PublicationRecord,
} from './store.js';

export interface PublishInput {
  readonly report: { readonly entries: readonly unknown[]; readonly read_set: readonly { resource: string; revision: number }[] };
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
  readonly inputs: unknown;
  readonly grant: Grant;
  readonly effects: readonly ResourceEffect[];
  readonly binding_digest: string;
  phase: 'held' | 'before_commit' | 'after_commit' | 'done';
  cancel_requested: boolean;
  resolve: (outcome: InvocationOutcome) => void;
  committed: PublicationRecord | null;
  outcome: InvocationOutcome | null;
}

export type CapabilityImplementation = (
  inputs: unknown,
  context: ResolverContext,
) => Promise<InvocationOutcome> | InvocationOutcome;

export class AgentFabricHost implements CapabilityHost {
  readonly store: FabricStore;
  readonly authority: GrantAuthority;
  readonly coordinator = new ResourceCoordinator();
  readonly invocations: { action_id: string; invocation_id: string; operation: string; inputs: unknown }[] = [];
  readonly rejections: InvocationRejected[] = [];
  readonly resourceAccesses: AccessRecord[] = [];
  readonly lookups: { invocation_id: string; granted: boolean }[] = [];
  faults: HostFaults;
  private readonly gateway: InferenceGateway | undefined;
  /** Cost ceilings already admitted against each contract's max_cost. */
  private readonly inferenceCharged = new Map<string, number>();
  private inferenceSeq = 0;

  private readonly live = new Map<string, CapabilityContract>();
  private readonly historical = new Map<string, CapabilityContract>();
  private readonly status = new Map<string, ResolutionStatus>();
  private readonly open = new Map<string, OpenInvocation>();

  constructor(options: {
    authority: GrantAuthority;
    store?: FabricStore;
    faults?: HostFaults;
    contracts?: readonly CapabilityContract[];
    gateway?: InferenceGateway;
  }) {
    this.authority = options.authority;
    this.store = options.store ?? new FabricStore();
    this.faults = { ...options.faults };
    this.gateway = options.gateway;
    const contracts = options.contracts ?? FIXTURE_CONTRACTS;
    const catalogue = validateCatalogue(contracts);
    if (!catalogue.ok) {
      throw new Error(`INVALID_CATALOGUE: ${catalogue.reason}`);
    }
    for (const contract of contracts) {
      this.live.set(contract.id, contract);
      this.historical.set(contract.id, contract);
      this.status.set(contract.id, trustedBuiltin(contract.id) ? 'resolved' : 'unresolved');
    }
  }

  snapshot(): FabricSnapshot {
    return this.store.snapshot();
  }

  static restore(authority: GrantAuthority, snapshot: FabricSnapshot, faults?: HostFaults): AgentFabricHost {
    const options: { authority: GrantAuthority; store: FabricStore; faults?: HostFaults } = {
      authority,
      store: FabricStore.restore(snapshot),
    };
    if (faults) {
      options.faults = faults;
    }
    return new AgentFabricHost(options);
  }

  registerSource(locator: string, content: string): ResourceRef {
    const canonical_id = this.store.allocateCanonical();
    this.store.putResource({
      canonical_id,
      kind: 'source',
      locator,
      revision: 1,
      content,
      publication: null,
    });
    return this.store.issue(canonical_id, 'source');
  }

  registerDestination(locator: string): ResourceRef {
    const canonical_id = this.store.allocateCanonical();
    this.store.putResource({
      canonical_id,
      kind: 'destination',
      locator,
      revision: 1,
      content: '',
      publication: null,
    });
    return this.store.issue(canonical_id, 'destination');
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
  tryWriteSource(handle: ResourceRef, content: string): { ok: true; revision: number } | { ok: false; reason: 'conflict' | 'unknown' } {
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
    resource.content = content;
    resource.revision += 1;
    return { ok: true, revision: resource.revision };
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
    const infer =
      registered?.inference ? (call: InferCall) => this.infer(registered, call) : undefined;
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
      typeof input === 'object' && input !== null && !Array.isArray(input) && typeof (input as { prompt?: unknown }).prompt === 'string'
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
    return {
      status: outcome.status,
      reason: outcome.reason,
      attempts: [...outcome.attempts],
      spent: outcome.spent,
    };
  }

  revoke(operation: string, reason = 'revoked'): void {
    void reason;
    this.live.delete(operation);
    this.status.set(operation, 'unavailable');
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

  canonicalResource(ref: ResourceRef): ResourceRef {
    const issued = this.store.lookupRef(ref);
    if (!issued) {
      return ref;
    }
    const primary = [...this.store.snapshot().refs].find((r) => r.canonical_id === issued.canonical_id);
    return primary?.handle ?? ref;
  }

  invoke(
    grant: Grant | null,
    operation: string,
    inputs: unknown,
    options?: InvokeOptions,
  ): InvocationHandle | InvocationRejected {
    const prepared = this.prepare(grant, operation, inputs, options);
    if (prepared.kind === 'rejected') {
      return prepared;
    }
    if (prepared.kind === 'replay') {
      return prepared.handle;
    }
    const { open, record } = prepared;
    try {
      this.store.persistInvocationStart(record);
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
      inputs: open.inputs,
    });
    this.open.set(open.invocation_id, open);
    const result = new Promise<InvocationOutcome>((resolve) => {
      open.resolve = resolve;
    });
    return {
      kind: 'handle',
      action_id: open.action_id,
      invocation_id: open.invocation_id,
      result,
      requestCancel: () => {
        this.requestCancel(open.invocation_id);
      },
    };
  }

  lookup(invocation_id: string, grant: Grant | null): LookupResult {
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
    const target = record ?? (open
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
    const contract = this.live.get(target.operation) ?? this.historical.get(target.operation);
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
    const status = record?.status ?? 'running';
    const outcome = record?.outcome ?? open?.outcome;
    if (status !== 'committed') {
      const published = [...this.store.snapshot().resources].find(
        (r) => r.publication?.invocation_id === invocation_id,
      );
      if (published?.publication) {
        this.coordinator.release(invocation_id);
        return {
          status: 'committed',
          outcome: { outcome: 'succeeded', output: this.receiptFrom(published.publication) },
        };
      }
    }
    if (status === 'running' && !open) {
      this.coordinator.release(invocation_id);
      return {
        status: 'stopped',
        outcome: { outcome: 'failed', failure: 'execution stopped without commit' },
      };
    }
    if (status === 'committed' && outcome) {
      this.coordinator.release(invocation_id);
      return { status: 'committed', outcome };
    }
    if (status === 'stopped' && outcome) {
      this.coordinator.release(invocation_id);
      return { status: 'stopped', outcome };
    }
    if (status === 'uncertain' && outcome) {
      return { status: 'unresolved', reason: outcome.outcome === 'uncertain' ? outcome.reason : 'uncertain' };
    }
    return { status: 'unresolved', reason: `invocation ${invocation_id} is ${status}` };
  }

  requestCancel(invocation_id: string): { readonly acknowledged: true } {
    const open = this.open.get(invocation_id);
    if (open) {
      open.cancel_requested = true;
    }
    const record = this.store.getInvocation(invocation_id);
    if (record) {
      record.cancel_requested = true;
      this.store.writeInvocation(record);
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
        this.noteCommitted(open, open.committed);
        open.phase = 'done';
        open.resolve({ outcome: 'uncertain', reason: 'acknowledgement rejected after commit' });
        this.open.delete(open.invocation_id);
        return;
      }
      const receipt = this.receiptFrom(open.committed);
      this.finish(open, { outcome: 'succeeded', output: receipt }, 'committed');
    }
  }

  private noteCommitted(open: OpenInvocation, record: PublicationRecord): void {
    const outcome: InvocationOutcome = { outcome: 'succeeded', output: this.receiptFrom(record) };
    try {
      this.store.persistInvocationResult({
        invocation_id: open.invocation_id,
        action_id: open.action_id,
        operation: open.operation,
        binding_digest: open.binding_digest,
        inputs: open.inputs,
        status: 'committed',
        outcome,
        cancel_requested: open.cancel_requested,
      });
    } catch (error) {
      if (!(error instanceof PersistFailure)) {
        throw error;
      }
    }
    open.outcome = outcome;
  }

  private finish(open: OpenInvocation, outcome: InvocationOutcome, status?: InvocationRecord['status']): void {
    const terminal: InvocationRecord['status'] =
      status ?? (outcome.outcome === 'succeeded' ? 'committed' : outcome.outcome === 'uncertain' ? 'uncertain' : 'stopped');
    try {
      this.store.persistInvocationResult({
        invocation_id: open.invocation_id,
        action_id: open.action_id,
        operation: open.operation,
        binding_digest: open.binding_digest,
        inputs: open.inputs,
        status: terminal,
        outcome,
        cancel_requested: open.cancel_requested,
      });
    } catch (error) {
      if (error instanceof PersistFailure) {
        if (terminal === 'committed' || open.committed) {
          open.outcome = outcome;
          open.phase = 'done';
          this.open.delete(open.invocation_id);
          open.resolve({ outcome: 'uncertain', reason: 'failed to persist invocation result after commit' });
          return;
        }
        throw error;
      }
      throw error;
    }
    if (terminal !== 'uncertain') {
      this.coordinator.release(open.invocation_id);
    }
    open.outcome = outcome;
    open.phase = 'done';
    this.open.delete(open.invocation_id);
    open.resolve(outcome);
  }

  private finishUncertain(open: OpenInvocation, reason: string): void {
    this.finish(open, { outcome: 'uncertain', reason }, 'uncertain');
  }

  private prepare(
    grant: Grant | null,
    operation: string,
    inputs: unknown,
    options?: InvokeOptions,
  ): { kind: 'open'; open: OpenInvocation; record: InvocationRecord } | { kind: 'replay'; handle: InvocationHandle } | InvocationRejected {
    const contract = this.live.get(operation);
    if (!contract) {
      if (this.historical.has(operation)) {
        return this.reject('UNRESOLVED', `${operation} is not currently resolved`);
      }
      return this.reject('UNKNOWN_CAPABILITY', `unknown operation ${operation}`);
    }
    if (this.status.get(operation) !== 'resolved') {
      return this.reject('UNRESOLVED', `${operation} is ${this.status.get(operation)}`);
    }
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
    if (!this.authority.isIssued(grant) || !this.authority.isValid(grant)) {
      return this.reject('DENIED', 'grant is not a currently valid issued grant');
    }
    const covered = grantCovers(grant, operation, contract.revision, required.bound, declared.bound);
    if (!covered.ok) {
      return this.reject(covered.code, covered.reason);
    }
    if (operation === REPORT_PUBLISH.id) {
      const binding = publishSetsAgree(boundInputs, (ref) => this.store.lookupRef(ref)?.canonical_id ?? ref);
      if (!binding.ok) {
        return this.reject('INVALID_INPUT', binding.reason);
      }
    }
    const action_id = (grant as Grant).action_id;
    const invocation_id = options?.invocation_id ?? action_id;
    const existing = this.store.getInvocation(invocation_id);
    const binding_digest = digest({ operation, inputs: boundInputs });
    if (existing && existing.binding_digest !== binding_digest) {
      return this.reject('DENIED', 'invocation identity is bound to a different input');
    }
    if (existing?.status === 'committed' && existing.outcome) {
      return { kind: 'replay', handle: this.replayCompleted(existing) };
    }
    if (!this.authority.markInvoked(grant as Grant)) {
      return this.reject('DENIED', 'grant has already been used for an invocation');
    }
    for (const effect of declared.bound) {
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
      }
    }
    const conflict = this.coordinator.acquire(invocation_id, declared.bound, (ref) => {
      const issued = this.store.lookupRef(ref);
      return issued?.canonical_id ?? ref;
    });
    if (conflict) {
      return this.reject('RESOLVER_ERROR', `effect conflict on ${conflict.canonical_id}`);
    }
    const open: OpenInvocation = {
      invocation_id,
      action_id,
      operation,
      inputs: boundInputs,
      grant: grant as Grant,
      effects: declared.bound,
      binding_digest,
      phase: 'held',
      cancel_requested: false,
      resolve: () => undefined,
      committed: null,
      outcome: null,
    };
    const record: InvocationRecord = {
      invocation_id,
      action_id,
      operation,
      binding_digest,
      inputs: boundInputs,
      status: 'running',
      outcome: null,
      cancel_requested: false,
    };
    return { kind: 'open', open, record };
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
    if (dest.publication) {
      if (dest.publication.invocation_id === open.invocation_id && dest.publication.binding_digest === binding_digest) {
        return { kind: 'committed', record: dest.publication };
      }
      if (dest.publication.invocation_id === open.invocation_id) {
        return { kind: 'outcome', outcome: { outcome: 'failed', failure: 'binding_conflict' }, status: 'stopped' };
      }
    }
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
    dest.revision += 1;
    const record: PublicationRecord = {
      invocation_id: open.invocation_id,
      binding_digest,
      report_digest,
      destination: input.destination,
      committed_revision: dest.revision,
    };
    dest.publication = record;
    dest.content = report_digest;
    this.store.save();
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

  private reject(code: FailureCode, reason: string): InvocationRejected {
    const rejection: InvocationRejected = { kind: 'rejected', code, reason };
    this.rejections.push(rejection);
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
  if (!Array.isArray(sources) || sources.length === 0 || !Array.isArray(read_set) || !report || !Array.isArray(report.read_set)) {
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

const TRUSTED_BUILTINS: ReadonlySet<string> = new Set([
  SOURCE_INSPECT.id,
  REPORT_ASSEMBLE.id,
  REPORT_PUBLISH.id,
]);

function trustedBuiltin(id: string): boolean {
  return TRUSTED_BUILTINS.has(id);
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
      return { ok: false, reason: `missing field '${key}'` };
    }
  }
  return { ok: true };
}

export { FIXTURE_CONTRACTS, REPORT_ASSEMBLE, REPORT_PUBLISH, SOURCE_INSPECT };
