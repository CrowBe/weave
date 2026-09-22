import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InvocationOutcome } from '@weave/agentsop';

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

export interface FabricSnapshot {
  readonly next_handle: number;
  readonly next_canonical: number;
  readonly resources: readonly StoredResource[];
  readonly refs: readonly IssuedRef[];
  readonly invocations: readonly InvocationRecord[];
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
  private readonly path: string | null;
  persistStart = true;
  persistResult = true;

  constructor(snapshot?: FabricSnapshot, path: string | null = null) {
    this.next_handle = snapshot?.next_handle ?? 1;
    this.next_canonical = snapshot?.next_canonical ?? 1;
    this.resources = new Map((snapshot?.resources ?? []).map((r) => [r.canonical_id, { ...r }]));
    this.refs = new Map((snapshot?.refs ?? []).map((r) => [r.handle, { ...r }]));
    this.invocations = new Map((snapshot?.invocations ?? []).map((r) => [r.invocation_id, { ...r }]));
    this.path = path;
  }

  static open(path: string): FabricStore {
    if (existsSync(path)) {
      const snapshot = JSON.parse(readFileSync(path, 'utf8')) as FabricSnapshot;
      return new FabricStore(snapshot, path);
    }
    const store = new FabricStore(undefined, path);
    store.save();
    return store;
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
