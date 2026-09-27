import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CapabilityContract, InvocationOutcome } from '@weave/agentsop';

const openStores = new Set<string>();

export type ResourceKind = 'source' | 'destination';

export interface PublicationRecord {
  readonly invocation_id: string;
  readonly binding_digest: string;
  readonly report_digest: string;
  readonly destination: string;
  readonly committed_revision: number;
}

export interface StoredResource {
  canonical_id: string;
  kind: ResourceKind;
  locator: string;
  revision: number;
  content: string;
  publication: PublicationRecord | null;
}

export type InvocationStatus = 'running' | 'committed' | 'stopped' | 'uncertain';

export interface InvocationRecord {
  invocation_id: string;
  action_id: string;
  operation: string;
  implementation_id?: string;
  binding_digest: string;
  inputs: unknown;
  status: InvocationStatus;
  outcome: InvocationOutcome | null;
  cancel_requested: boolean;
}

export interface IssuedRef {
  handle: string;
  canonical_id: string;
  kind: ResourceKind;
}

/** Admitted implementation source. The host store is the single writer. */
export interface StoredAdmission {
  readonly operation: string;
  readonly implementation_id: string;
  readonly contract: CapabilityContract;
  readonly source: string;
}

export interface StoredWorkload {
  readonly goal_id: string;
  readonly quality: 'held' | 'missed';
}

export interface StoredBuiltinResult {
  readonly key: string;
  readonly operation: string;
  readonly implementation_id: string;
  readonly outcome: InvocationOutcome;
}

export interface FabricSnapshot {
  readonly next_handle: number;
  readonly next_canonical: number;
  readonly resources: readonly StoredResource[];
  readonly refs: readonly IssuedRef[];
  readonly invocations: readonly InvocationRecord[];
  readonly admissions?: readonly StoredAdmission[];
  readonly conclusions?: readonly unknown[];
  readonly workload?: readonly StoredWorkload[];
  readonly measured_cost_micros?: number;
  readonly builtin_results?: readonly StoredBuiltinResult[];
}

interface MutableResource extends StoredResource {}

/**
 * Host store. Locators never leave this object. When constructed with a path,
 * every mutation is written atomically so a later process can restore it.
 */
export class FabricStore {
  private next_handle: number;
  private next_canonical: number;
  private readonly resources: Map<string, MutableResource>;
  private readonly refs: Map<string, IssuedRef>;
  private readonly invocations: Map<string, InvocationRecord>;
  private admissions: StoredAdmission[];
  private conclusionRecords: unknown[];
  private workloadRecords: StoredWorkload[];
  private measured_cost_micros: number;
  private builtinResults: StoredBuiltinResult[];
  private readonly path: string | null;
  persistStart = true;
  persistResult = true;

  constructor(snapshot?: FabricSnapshot, path: string | null = null) {
    this.next_handle = snapshot?.next_handle ?? 1;
    this.next_canonical = snapshot?.next_canonical ?? 1;
    this.resources = new Map((snapshot?.resources ?? []).map((r) => [r.canonical_id, { ...r }]));
    this.refs = new Map((snapshot?.refs ?? []).map((r) => [r.handle, { ...r }]));
    this.invocations = new Map((snapshot?.invocations ?? []).map((r) => [r.invocation_id, { ...r }]));
    this.admissions = (snapshot?.admissions ?? []).map((admission) => ({ ...admission, contract: { ...admission.contract } }));
    this.conclusionRecords = (snapshot?.conclusions ?? []).map((conclusion) => structuredClone(conclusion));
    this.workloadRecords = (snapshot?.workload ?? []).map((item) => ({ ...item }));
    this.measured_cost_micros = snapshot?.measured_cost_micros ?? 0;
    this.builtinResults = (snapshot?.builtin_results ?? []).map((item) => ({
      ...item,
      outcome: structuredClone(item.outcome),
    }));
    this.path = path;
  }

  static open(path: string): FabricStore {
    const key = resolve(path);
    if (openStores.has(key)) {
      throw new Error(`host store is already open: ${key}`);
    }
    const store = existsSync(path)
      ? new FabricStore(JSON.parse(readFileSync(path, 'utf8')) as FabricSnapshot, path)
      : new FabricStore(undefined, path);
    if (!existsSync(path)) {
      store.save();
    }
    openStores.add(key);
    return store;
  }

  /** Release this process's ownership so a later restart can open the store. */
  close(): void {
    if (!this.path) {
      return;
    }
    openStores.delete(resolve(this.path));
  }

  snapshot(): FabricSnapshot {
    return {
      next_handle: this.next_handle,
      next_canonical: this.next_canonical,
      resources: [...this.resources.values()].map((r) => ({ ...r })),
      refs: [...this.refs.values()].map((r) => ({ ...r })),
      invocations: [...this.invocations.values()].map((r) => ({
        ...r,
        inputs: structuredClone(r.inputs),
      })),
      admissions: this.admissions.map((admission) => ({ ...admission, contract: { ...admission.contract } })),
      conclusions: this.conclusionRecords.map((conclusion) => structuredClone(conclusion)),
      workload: this.workloadRecords.map((item) => ({ ...item })),
      measured_cost_micros: this.measured_cost_micros,
      builtin_results: this.builtinResults.map((item) => ({ ...item, outcome: structuredClone(item.outcome) })),
    };
  }

  static restore(snapshot: FabricSnapshot, path: string | null = null): FabricStore {
    return new FabricStore(snapshot, path);
  }

  allocateCanonical(): string {
    const id = `res_${this.next_canonical}`;
    this.next_canonical += 1;
    this.save();
    return id;
  }

  issue(canonical_id: string, kind: ResourceKind): string {
    const handle = `ref_${this.next_handle}`;
    this.next_handle += 1;
    this.refs.set(handle, { handle, canonical_id, kind });
    this.save();
    return handle;
  }

  lookupRef(handle: string): IssuedRef | undefined {
    return this.refs.get(handle);
  }

  putResource(resource: MutableResource): void {
    this.resources.set(resource.canonical_id, resource);
    this.save();
  }

  getResource(canonical_id: string): MutableResource | undefined {
    return this.resources.get(canonical_id);
  }

  getInvocation(id: string): InvocationRecord | undefined {
    return this.invocations.get(id);
  }

  persistInvocationStart(record: InvocationRecord): void {
    if (!this.persistStart) {
      throw new PersistFailure('invocation start');
    }
    this.invocations.set(record.invocation_id, { ...record, inputs: structuredClone(record.inputs) });
    this.save();
  }

  persistInvocationResult(record: InvocationRecord): void {
    if (!this.persistResult) {
      throw new PersistFailure('invocation result');
    }
    this.invocations.set(record.invocation_id, { ...record, inputs: structuredClone(record.inputs) });
    this.save();
  }

  recordAdmission(admission: StoredAdmission): void {
    const copy = { ...admission, contract: { ...admission.contract } };
    const index = this.admissions.findIndex(
      (item) => item.operation === admission.operation && item.implementation_id === admission.implementation_id,
    );
    if (index >= 0) {
      this.admissions[index] = copy;
    } else {
      this.admissions.push(copy);
    }
    this.save();
  }

  admitted(): readonly StoredAdmission[] {
    return this.admissions.map((admission) => ({ ...admission, contract: { ...admission.contract } }));
  }

  retainConclusion(conclusion: unknown): void {
    this.conclusionRecords.push(structuredClone(conclusion));
    this.save();
  }

  conclusions(): readonly unknown[] {
    return this.conclusionRecords.map((conclusion) => structuredClone(conclusion));
  }

  noteWorkload(record: StoredWorkload): void {
    const index = this.workloadRecords.findIndex((item) => item.goal_id === record.goal_id);
    if (index >= 0) {
      this.workloadRecords[index] = { ...record };
    } else {
      this.workloadRecords.push({ ...record });
    }
    this.save();
  }

  workload(): readonly StoredWorkload[] {
    return this.workloadRecords.map((item) => ({ ...item }));
  }

  addMeasuredCost(micros: number): void {
    this.measured_cost_micros += micros;
    this.save();
  }

  measuredCostMicros(): number {
    return this.measured_cost_micros;
  }

  rememberResult(result: StoredBuiltinResult): void {
    const index = this.builtinResults.findIndex((item) => item.key === result.key);
    const copy = { ...result, outcome: structuredClone(result.outcome) };
    if (index >= 0) {
      this.builtinResults[index] = copy;
    } else {
      this.builtinResults.push(copy);
    }
    this.save();
  }

  cachedResult(key: string): StoredBuiltinResult | undefined {
    const found = this.builtinResults.find((item) => item.key === key);
    return found ? { ...found, outcome: structuredClone(found.outcome) } : undefined;
  }

  writeInvocation(record: InvocationRecord): void {
    this.invocations.set(record.invocation_id, { ...record, inputs: structuredClone(record.inputs) });
    this.save();
  }

  save(): void {
    if (!this.path) {
      return;
    }
    const directory = dirname(this.path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.snapshot())}\n`);
    renameSync(tmp, this.path);
  }
}

export class PersistFailure extends Error {
  constructor(what: string) {
    super(`failed to persist ${what}`);
    this.name = 'PersistFailure';
  }
}
