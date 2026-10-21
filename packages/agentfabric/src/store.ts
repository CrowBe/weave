import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CapabilityContract, InvocationOutcome } from '@weave/agentsop';

const openStores = new Set<string>();
const COMPACT_BYTES = 256 * 1024;
let lockSequence = 0;

export type ResourceKind = 'source' | 'destination' | 'workspace';

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
  measured_cost_micros?: number;
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

type FabricMutation =
  | { readonly op: 'snapshot'; readonly snapshot: FabricSnapshot }
  | { readonly op: 'allocate'; readonly id: string }
  | { readonly op: 'issue'; readonly ref: IssuedRef }
  | { readonly op: 'put'; readonly resource: StoredResource }
  | { readonly op: 'start'; readonly record: InvocationRecord; readonly measured_cost_micros: number }
  | { readonly op: 'result'; readonly record: InvocationRecord }
  | { readonly op: 'cost'; readonly micros: number }
  | { readonly op: 'admission'; readonly admission: StoredAdmission }
  | { readonly op: 'conclusion'; readonly conclusion: unknown }
  | { readonly op: 'workload'; readonly workload: StoredWorkload }
  | { readonly op: 'remember'; readonly result: StoredBuiltinResult };

interface LoadedJournal {
  readonly records: readonly FabricMutation[];
  readonly legacySnapshot: FabricSnapshot | null;
  readonly torn_tail_ignored: boolean;
  readonly ignored_tail_bytes: number;
}

/**
 * Host store. Locators never leave this object. When constructed with a path,
 * every mutation is appended to a JSONL journal and folded back on open.
 */
export class FabricStore {
  private next_handle = 1;
  private next_canonical = 1;
  private readonly resources = new Map<string, MutableResource>();
  private readonly refs = new Map<string, IssuedRef>();
  private readonly canonicalPrimary = new Map<string, string>();
  private readonly publicationOwners = new Map<string, string>();
  private readonly invocations = new Map<string, InvocationRecord>();
  private admissions: StoredAdmission[] = [];
  private conclusionRecords: unknown[] = [];
  private workloadRecords: StoredWorkload[] = [];
  private measured_cost_micros = 0;
  private readonly builtinResults = new Map<string, StoredBuiltinResult>();
  private readonly path: string | null;
  private fileBytes = 0;
  private tailBytes = 0;
  private written_bytes = 0;
  private journalReady = false;
  private poisoned: string | null = null;
  recovery = { torn_tail_ignored: false, ignored_tail_bytes: 0 };
  persistStart = true;
  persistResult = true;

  constructor(snapshot?: FabricSnapshot, path: string | null = null) {
    this.path = path;
    this.applySnapshot(snapshot);
  }

  static open(path: string): FabricStore {
    const key = resolve(path);
    if (openStores.has(key)) {
      throw new Error(`host store is already open: ${key}`);
    }
    const directory = dirname(path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    acquireLock(path);
    try {
      if (!existsSync(path)) {
        writeFileSync(path, '');
      }
      const loaded = readJournal(path);
      const store = loaded.legacySnapshot
        ? new FabricStore(loaded.legacySnapshot, path)
        : new FabricStore(undefined, path);
      store.recovery = {
        torn_tail_ignored: loaded.torn_tail_ignored,
        ignored_tail_bytes: loaded.ignored_tail_bytes,
      };
      if (loaded.legacySnapshot) {
        store.compact();
      } else {
        store.replay(loaded.records);
      }
      store.fileBytes = statSync(path).size;
      store.tailBytes = 0;
      store.journalReady = true;
      openStores.add(key);
      return store;
    } catch (error) {
      releaseLock(path);
      throw error;
    }
  }

  /** Release this process's ownership so a later restart can open the store. */
  close(): void {
    if (!this.path) {
      return;
    }
    openStores.delete(resolve(this.path));
    releaseLock(this.path);
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
      builtin_results: [...this.builtinResults.values()].map((item) => ({
        ...item,
        outcome: structuredClone(item.outcome),
      })),
    };
  }

  static restore(snapshot: FabricSnapshot, path: string | null = null): FabricStore {
    return new FabricStore(snapshot, path);
  }

  allocateCanonical(save = true): string {
    const id = `res_${this.next_canonical}`;
    this.mutate({ op: 'allocate', id });
    if (save) {
      this.save();
    }
    return id;
  }

  issue(canonical_id: string, kind: ResourceKind, save = true): string {
    const handle = `ref_${this.next_handle}`;
    this.mutate({ op: 'issue', ref: { handle, canonical_id, kind } });
    if (save) {
      this.save();
    }
    return handle;
  }

  lookupRef(handle: string): IssuedRef | undefined {
    return this.refs.get(handle);
  }

  primaryRef(canonical_id: string): string | undefined {
    return this.canonicalPrimary.get(canonical_id);
  }

  putResource(resource: MutableResource, save = true): void {
    this.mutate({ op: 'put', resource });
    if (save) {
      this.save();
    }
  }

  publishedBy(invocation_id: string): MutableResource | undefined {
    const canonical_id = this.publicationOwners.get(invocation_id);
    return canonical_id === undefined ? undefined : this.resources.get(canonical_id);
  }

  getResource(canonical_id: string): MutableResource | undefined {
    return this.resources.get(canonical_id);
  }

  getInvocation(id: string): InvocationRecord | undefined {
    return this.invocations.get(id);
  }

  persistInvocationStart(record: InvocationRecord, measuredCostMicros = 0): void {
    if (!this.persistStart) {
      throw new PersistFailure('invocation start');
    }
    this.mutate({ op: 'start', record, measured_cost_micros: measuredCostMicros });
    this.save();
  }

  persistInvocationResult(record: InvocationRecord): void {
    if (!this.persistResult) {
      throw new PersistFailure('invocation result');
    }
    this.mutate({ op: 'result', record });
    this.save();
  }

  recordAdmission(admission: StoredAdmission): void {
    const copy = { ...admission, contract: { ...admission.contract } };
    this.mutate({ op: 'admission', admission: copy });
    this.save();
  }

  admitted(): readonly StoredAdmission[] {
    return this.admissions.map((admission) => ({ ...admission, contract: { ...admission.contract } }));
  }

  retainConclusion(conclusion: unknown): void {
    this.mutate({ op: 'conclusion', conclusion });
    this.save();
  }

  conclusions(): readonly unknown[] {
    return this.conclusionRecords.map((conclusion) => structuredClone(conclusion));
  }

  noteWorkload(record: StoredWorkload): void {
    this.mutate({ op: 'workload', workload: record });
    this.save();
  }

  workload(): readonly StoredWorkload[] {
    return this.workloadRecords.map((item) => ({ ...item }));
  }

  addMeasuredCost(micros: number): void {
    this.mutate({ op: 'cost', micros });
    this.save();
  }

  measuredCostMicros(): number {
    return this.measured_cost_micros;
  }

  rememberResult(result: StoredBuiltinResult): void {
    this.mutate({ op: 'remember', result: { ...result, outcome: structuredClone(result.outcome) } });
    this.save();
  }

  cachedResult(key: string): StoredBuiltinResult | undefined {
    const found = this.builtinResults.get(key);
    return found ? { ...found, outcome: structuredClone(found.outcome) } : undefined;
  }

  writeInvocation(record: InvocationRecord): void {
    this.mutate({ op: 'result', record });
    this.save();
  }

  /** Total journal bytes written by this store instance, including compaction. */
  bytesWritten(): number {
    return this.written_bytes;
  }

  save(): void {
    if (!this.path) {
      return;
    }
    const retained = Math.max(0, this.fileBytes - this.tailBytes);
    if (this.tailBytes >= Math.max(COMPACT_BYTES, retained)) {
      this.compact();
    }
  }

  private mutate(mutation: FabricMutation): void {
    this.append(mutation);
    this.applyMutation(mutation);
  }

  private append(mutation: FabricMutation): void {
    if (!this.path) {
      return;
    }
    if (this.poisoned) {
      throw new Error(this.poisoned);
    }
    if (!this.journalReady) {
      this.compact();
    }
    const line = `${JSON.stringify(mutation)}\n`;
    const previousBytes = this.fileBytes;
    try {
      appendFileSync(this.path, line);
    } catch (error) {
      try {
        truncateSync(this.path, previousBytes);
      } catch {
        this.poisoned = `host store must be reopened after a failed append: ${String(error)}`;
      }
      throw error;
    }
    const bytes = Buffer.byteLength(line);
    this.fileBytes += bytes;
    this.tailBytes += bytes;
    this.written_bytes += bytes;
  }

  private compact(): void {
    if (!this.path) {
      return;
    }
    const directory = dirname(this.path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    const text = `${JSON.stringify({ op: 'snapshot', snapshot: this.snapshot() })}\n`;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.path);
    const bytes = Buffer.byteLength(text);
    this.fileBytes = bytes;
    this.tailBytes = 0;
    this.written_bytes += bytes;
    this.journalReady = true;
  }

  private replay(records: readonly FabricMutation[]): void {
    for (const mutation of records) {
      this.applyMutation(mutation);
    }
  }

  private applyMutation(mutation: FabricMutation): void {
    switch (mutation.op) {
      case 'snapshot':
        this.applySnapshot(mutation.snapshot);
        return;
      case 'allocate': {
        const value = counterAfter(mutation.id, 'res_');
        if (value === undefined) {
          throw new Error(`invalid host store allocation: ${mutation.id}`);
        }
        this.next_canonical = Math.max(this.next_canonical, value + 1);
        return;
      }
      case 'issue':
        this.applyIssue(mutation.ref);
        return;
      case 'put':
        this.applyPut(mutation.resource);
        return;
      case 'start':
        this.applyStart(mutation.record, mutation.measured_cost_micros);
        return;
      case 'result':
        this.setInvocation(mutation.record);
        return;
      case 'cost':
        this.measured_cost_micros += mutation.micros;
        return;
      case 'admission':
        this.applyAdmission(mutation.admission);
        return;
      case 'conclusion':
        this.conclusionRecords.push(structuredClone(mutation.conclusion));
        return;
      case 'workload':
        this.applyWorkload(mutation.workload);
        return;
      case 'remember':
        this.applyRemember(mutation.result);
        return;
    }
  }

  private applySnapshot(snapshot?: FabricSnapshot): void {
    this.next_handle = snapshot?.next_handle ?? 1;
    this.next_canonical = snapshot?.next_canonical ?? 1;
    this.resources.clear();
    for (const resource of snapshot?.resources ?? []) {
      this.resources.set(resource.canonical_id, { ...resource });
    }
    this.refs.clear();
    for (const ref of snapshot?.refs ?? []) {
      this.refs.set(ref.handle, { ...ref });
    }
    this.canonicalPrimary.clear();
    for (const ref of snapshot?.refs ?? []) {
      if (!this.canonicalPrimary.has(ref.canonical_id)) {
        this.canonicalPrimary.set(ref.canonical_id, ref.handle);
      }
    }
    this.publicationOwners.clear();
    for (const resource of this.resources.values()) {
      if (resource.publication && !this.publicationOwners.has(resource.publication.invocation_id)) {
        this.publicationOwners.set(resource.publication.invocation_id, resource.canonical_id);
      }
    }
    this.invocations.clear();
    for (const record of snapshot?.invocations ?? []) {
      this.invocations.set(record.invocation_id, { ...record });
    }
    this.admissions = (snapshot?.admissions ?? []).map((admission) => ({
      ...admission,
      contract: { ...admission.contract },
    }));
    this.conclusionRecords = (snapshot?.conclusions ?? []).map((conclusion) => structuredClone(conclusion));
    this.workloadRecords = (snapshot?.workload ?? []).map((item) => ({ ...item }));
    this.measured_cost_micros = snapshot?.measured_cost_micros ?? 0;
    this.builtinResults.clear();
    for (const item of snapshot?.builtin_results ?? []) {
      this.builtinResults.set(item.key, { ...item, outcome: structuredClone(item.outcome) });
    }
  }

  private applyIssue(ref: IssuedRef): void {
    this.refs.set(ref.handle, { ...ref });
    if (!this.canonicalPrimary.has(ref.canonical_id)) {
      this.canonicalPrimary.set(ref.canonical_id, ref.handle);
    }
    const value = counterAfter(ref.handle, 'ref_');
    if (value === undefined) {
      throw new Error(`invalid host store reference: ${ref.handle}`);
    }
    this.next_handle = Math.max(this.next_handle, value + 1);
  }

  private applyPut(resource: StoredResource): void {
    const previous = this.resources.get(resource.canonical_id);
    if (
      previous?.publication &&
      previous.publication.invocation_id !== resource.publication?.invocation_id &&
      this.publicationOwners.get(previous.publication.invocation_id) === resource.canonical_id
    ) {
      this.publicationOwners.delete(previous.publication.invocation_id);
    }
    this.resources.set(resource.canonical_id, resource);
    if (resource.publication) {
      const owner = this.publicationOwners.get(resource.publication.invocation_id);
      if (owner === undefined || owner === resource.canonical_id) {
        this.publicationOwners.set(resource.publication.invocation_id, resource.canonical_id);
      }
    }
  }

  private applyStart(record: InvocationRecord, measuredCostMicros: number): void {
    const previous = this.invocations.get(record.invocation_id);
    const previousCost = previous ? previous.measured_cost_micros ?? measuredCostMicros : 0;
    this.invocations.set(record.invocation_id, {
      ...record,
      inputs: structuredClone(record.inputs),
      measured_cost_micros: measuredCostMicros,
    });
    this.measured_cost_micros += measuredCostMicros - previousCost;
  }

  private applyAdmission(admission: StoredAdmission): void {
    const copy = { ...admission, contract: { ...admission.contract } };
    const index = this.admissions.findIndex(
      (item) => item.operation === admission.operation && item.implementation_id === admission.implementation_id,
    );
    if (index >= 0) {
      this.admissions[index] = copy;
    } else {
      this.admissions.push(copy);
    }
  }

  private applyWorkload(record: StoredWorkload): void {
    const index = this.workloadRecords.findIndex((item) => item.goal_id === record.goal_id);
    if (index >= 0) {
      this.workloadRecords[index] = { ...record };
    } else {
      this.workloadRecords.push({ ...record });
    }
  }

  private applyRemember(result: StoredBuiltinResult): void {
    this.builtinResults.set(result.key, { ...result, outcome: structuredClone(result.outcome) });
  }

  private setInvocation(record: InvocationRecord): void {
    const previous = this.invocations.get(record.invocation_id);
    const stored: InvocationRecord = { ...record, inputs: structuredClone(record.inputs) };
    if (stored.measured_cost_micros === undefined && previous?.measured_cost_micros !== undefined) {
      stored.measured_cost_micros = previous.measured_cost_micros;
    }
    this.invocations.set(record.invocation_id, stored);
  }
}

export class PersistFailure extends Error {
  constructor(what: string) {
    super(`failed to persist ${what}`);
    this.name = 'PersistFailure';
  }
}

function acquireLock(path: string): void {
  const lockPath = `${path}.lock`;
  const tempPath = `${lockPath}.${process.pid}.${(lockSequence += 1)}.tmp`;
  writeFileSync(tempPath, String(process.pid));
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        linkSync(tempPath, lockPath);
        return;
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw error;
        }
      }
      const owner = readLockOwner(lockPath);
      if (owner === undefined || isAlive(owner)) {
        throw new Error(`host store is already open: ${resolve(path)}`);
      }
      const quarantine = `${lockPath}.stale.${process.pid}.${(lockSequence += 1)}`;
      try {
        renameSync(lockPath, quarantine);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) {
          continue;
        }
        throw error;
      }
      if (readLockOwner(quarantine) !== owner) {
        // A live writer replaced the stale lock as we took it. Put it back
        // rather than becoming a second writer.
        try {
          linkSync(quarantine, lockPath);
        } catch {
          // The lock path is already published by another contender.
        }
        try {
          unlinkSync(quarantine);
        } catch {
          // ignore
        }
        throw new Error(`host store is already open: ${resolve(path)}`);
      }
      try {
        unlinkSync(quarantine);
      } catch {
        // ignore
      }
    }
    throw new Error(`host store is already open: ${resolve(path)}`);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore
    }
  }
}

function readLockOwner(lockPath: string): number | undefined {
  try {
    const owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(owner) && owner > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

function releaseLock(path: string): void {
  const lockPath = `${path}.lock`;
  try {
    if (readLockOwner(lockPath) === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    return;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function counterAfter(value: string, prefix: string): number | undefined {
  if (!value.startsWith(prefix)) {
    return undefined;
  }
  const parsed = Number(value.slice(prefix.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function readJournal(path: string): LoadedJournal {
  let text = readFileSync(path, 'utf8');
  let torn_tail_ignored = false;
  let ignored_tail_bytes = 0;
  if (text.length > 0 && !text.endsWith('\n')) {
    const breakAt = text.lastIndexOf('\n');
    const tail = text.slice(breakAt + 1);
    try {
      JSON.parse(tail);
      appendFileSync(path, '\n');
      text += '\n';
    } catch {
      const valid = text.slice(0, breakAt + 1);
      truncateSync(path, Buffer.byteLength(valid));
      text = valid;
      torn_tail_ignored = true;
      ignored_tail_bytes = Buffer.byteLength(tail);
    }
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const parsed: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) {
        const validLines = lines.slice(0, index);
        const valid = validLines.length === 0 ? '' : `${validLines.join('\n')}\n`;
        truncateSync(path, Buffer.byteLength(valid));
        torn_tail_ignored = true;
        ignored_tail_bytes += Buffer.byteLength(line);
        continue;
      }
      throw new Error(`invalid host store log at line ${index + 1}: ${path}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`invalid host store log at line ${index + 1}: ${path}`);
    }
    parsed.push(value);
  }
  if (parsed.length === 1 && isLegacySnapshot(parsed[0])) {
    return {
      records: [],
      legacySnapshot: parsed[0],
      torn_tail_ignored,
      ignored_tail_bytes,
    };
  }
  const records = parsed.map((value, index) => asMutation(value, index, path));
  return { records, legacySnapshot: null, torn_tail_ignored, ignored_tail_bytes };
}

function isLegacySnapshot(value: unknown): value is FabricSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return !('op' in record) && 'next_handle' in record && 'resources' in record && 'refs' in record;
}

function asMutation(value: unknown, index: number, path: string): FabricMutation {
  const record = value as { op?: unknown };
  if (
    typeof record.op !== 'string' ||
    ![
      'snapshot',
      'allocate',
      'issue',
      'put',
      'start',
      'result',
      'cost',
      'admission',
      'conclusion',
      'workload',
      'remember',
    ].includes(record.op)
  ) {
    throw new Error(`invalid host store mutation at line ${index + 1}: ${path}`);
  }
  return value as FabricMutation;
}
