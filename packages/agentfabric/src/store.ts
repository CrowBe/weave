import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CapabilityContract, InvocationOutcome } from '@weave/agentsop';

const openStores = new Map<string, FabricStore>();
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
 * All path-backed entry points take the writer lock. A supplied snapshot may
 * seed an empty path, but cannot replace existing journal history.
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
  private lockToken: string | null = null;
  private closed = false;
  private lastCompactionError: unknown = null;
  recovery = { torn_tail_ignored: false, ignored_tail_bytes: 0 };
  persistStart = true;
  persistResult = true;

  constructor(snapshot?: FabricSnapshot, path: string | null = null) {
    this.path = path === null ? null : canonicalStorePath(path);
    this.applySnapshot(snapshot);
    if (this.path === null) {
      return;
    }
    const key = this.path;
    if (openStores.has(key)) {
      throw new Error(`host store is already open: ${key}`);
    }
    const directory = dirname(key);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    const lockToken = acquireLock(key);
    this.lockToken = lockToken;
    try {
      this.assertWritable();
      if (snapshot !== undefined && existsSync(key) && statSync(key).size > 0) {
        throw new Error(`cannot restore a snapshot over existing host store history: ${key}`);
      }
      if (!existsSync(key)) {
        writeFileSync(key, '', { flag: 'wx' });
      }
      const loaded = readJournal(key, () => this.assertWritable());
      this.recovery = {
        torn_tail_ignored: loaded.torn_tail_ignored,
        ignored_tail_bytes: loaded.ignored_tail_bytes,
      };
      if (snapshot !== undefined || loaded.legacySnapshot) {
        if (loaded.legacySnapshot) {
          this.applySnapshot(loaded.legacySnapshot);
        }
        this.compact();
      } else {
        this.replay(loaded.records);
      }
      this.fileBytes = statSync(key).size;
      this.tailBytes = 0;
      this.journalReady = true;
      openStores.set(key, this);
    } catch (error) {
      releaseLock(key, lockToken);
      throw error;
    }
  }

  static open(path: string): FabricStore {
    return new FabricStore(undefined, path);
  }

  /** Release this process's ownership so a later restart can open the store. */
  close(): void {
    if (!this.path || this.closed) {
      return;
    }
    this.closed = true;
    const key = resolve(this.path);
    if (openStores.get(key) === this) {
      openStores.delete(key);
    }
    if (this.lockToken !== null) {
      releaseLock(this.path, this.lockToken);
      this.lockToken = null;
    }
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

  /** Most recent maintenance failure; a successful compaction clears it. */
  compactionError(): unknown {
    return this.lastCompactionError;
  }

  save(): void {
    if (!this.path) {
      return;
    }
    this.assertWritable();
    const retained = Math.max(0, this.fileBytes - this.tailBytes);
    if (this.tailBytes >= Math.max(COMPACT_BYTES, retained)) {
      // Appends have already committed. Maintenance cannot turn that success
      // into an apparent mutation failure (and release an invocation reservation).
      try {
        this.compact();
        this.lastCompactionError = null;
      } catch (error) {
        this.lastCompactionError = error;
      }
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
    this.assertWritable();
    if (!this.journalReady) {
      this.compact();
    }
    const line = Buffer.from(`${JSON.stringify(mutation)}\n`);
    // Serialization can call user-provided toJSON methods. Check again before I/O.
    this.assertWritable();
    const previousBytes = this.fileBytes;
    const fd = openSync(this.path, 'a');
    let written = 0;
    try {
      if (fstatSync(fd).size !== previousBytes) {
        this.poisoned = 'host store must be reopened after an unexpected journal length';
        throw new Error(this.poisoned);
      }
      try {
        while (written < line.length) {
          this.assertWritable();
          const count = writeSync(fd, line, written, line.length - written);
          if (count === 0) {
            throw new Error('host store append made no progress');
          }
          written += count;
        }
      } catch (error) {
        try {
          this.assertWritable();
          if (fstatSync(fd).size !== previousBytes + written) {
            throw new Error('host store append range changed');
          }
          // Only successful writeSync calls contribute to the rollback range.
          if (written > 0) {
            ftruncateSync(fd, previousBytes);
          }
        } catch {
          this.poisoned = 'host store must be reopened after a failed append';
        }
        throw error;
      }
    } finally {
      closeSync(fd);
    }
    const bytes = line.length;
    this.fileBytes += bytes;
    this.tailBytes += bytes;
    this.written_bytes += bytes;
  }

  private compact(): void {
    if (!this.path) {
      return;
    }
    this.assertWritable();
    const directory = dirname(this.path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    const text = `${JSON.stringify({ op: 'snapshot', snapshot: this.snapshot() })}\n`;
    this.assertWritable();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, text);
    this.assertWritable();
    renameSync(tmp, this.path);
    const bytes = Buffer.byteLength(text);
    this.fileBytes = bytes;
    this.tailBytes = 0;
    this.written_bytes += bytes;
    this.journalReady = true;
  }

  private assertWritable(): void {
    if (this.closed) {
      throw new Error('host store is closed');
    }
    if (this.path && (this.lockToken === null || readLockContent(`${this.path}.lock`) !== this.lockToken)) {
      throw new Error('host store no longer owns its lock');
    }
    if (this.poisoned) {
      throw new Error(this.poisoned);
    }
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

function canonicalStorePath(path: string): string {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  mkdirSync(directory, { recursive: true });
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    try {
      // A dangling symlink is an existing alias, not a new journal filename.
      lstatSync(absolute);
    } catch (missing) {
      if (!isErrno(missing, 'ENOENT')) throw missing;
      // A new journal has no inode yet; resolve directory aliases before locking.
      return join(realpathSync(directory), basename(absolute));
    }
    throw error;
  }
}

function acquireLock(path: string): string {
  const lockPath = `${path}.lock`;
  const token = `${process.pid}:${(lockSequence += 1)}`;
  const tempPath = `${lockPath}.${token}.tmp`;
  writeFileSync(tempPath, token);
  try {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      try {
        linkSync(tempPath, lockPath);
        return token;
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw error;
        }
      }
      const owner = readLockContent(lockPath);
      const pid = lockOwner(owner);
      if (pid === undefined || isAlive(pid)) {
        throw new Error(`host store is already open: ${resolve(path)}`);
      }
      if (!acquireReclaim(`${lockPath}.reclaim`, token)) {
        continue;
      }
      try {
        const current = readLockContent(lockPath);
        if (current !== owner) {
          continue;
        }
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) {
            throw error;
          }
        }
      } finally {
        releaseReclaim(`${lockPath}.reclaim`, token);
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

/**
 * Serialize stale-lock reclamation so only the holder removes the main lock
 * and no contender can move a live writer's lock into quarantine.
 */
function acquireReclaim(reclaimPath: string, token: string): boolean {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const tempPath = `${reclaimPath}.${process.pid}.${(lockSequence += 1)}.tmp`;
    mkdirSync(tempPath);
    try {
      writeFileSync(`${tempPath}/owner`, token);
      renameSync(tempPath, reclaimPath);
      return true;
    } catch (error) {
      if (
        !isErrno(error, 'EEXIST') &&
        !isErrno(error, 'ENOTEMPTY') &&
        !isErrno(error, 'ENOTDIR') &&
        !isErrno(error, 'EISDIR') &&
        !isErrno(error, 'EPERM')
      ) {
        throw error;
      }
    } finally {
      try {
        rmSync(tempPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    const owner = readReclaimIdentity(reclaimPath);
    if (owner === undefined || isAlive(owner.pid)) {
      return false;
    }
    // Atomic mkdir grants a single contender the right to move this generation.
    // All reapers must claim before revalidating: a check followed by rename
    // alone allows a delayed contender to quarantine a live successor.
    try {
      mkdirSync(`${reclaimPath}/reap`);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      if (isErrno(error, 'EEXIST')) return false;
      throw error;
    }
    const current = readReclaimIdentity(reclaimPath);
    if (!sameReclaimOwner(owner, current) || isAlive(current.pid)) {
      // Leave the claim in place. Removing it through a reused pathname could
      // release another reaper's claim. A live holder removes it on release;
      // a crashed reaper requires operator recovery, failing closed meanwhile.
      return false;
    }
    const quarantine = `${reclaimPath}.stale.${process.pid}.${(lockSequence += 1)}`;
    try {
      renameSync(reclaimPath, quarantine);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        continue;
      }
      throw error;
    }
    const moved = readReclaimIdentity(quarantine);
    if (!sameReclaimOwner(owner, moved) || isAlive(moved.pid)) {
      // Defensive validation: restoration failure must stop acquisition. Never
      // continue while a displaced owner could still be in the critical section.
      renameSync(quarantine, reclaimPath);
      return false;
    }
    try {
      rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  return false;
}

function releaseReclaim(reclaimPath: string, token: string): void {
  try {
    if (readLockContent(`${reclaimPath}/owner`) === token) {
      rmSync(reclaimPath, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

interface ReclaimIdentity {
  readonly token: string;
  readonly pid: number;
  readonly dev: number;
  readonly ino: number;
}

function readReclaimIdentity(reclaimPath: string): ReclaimIdentity | undefined {
  try {
    const before = statSync(reclaimPath);
    const token = readLockContent(`${reclaimPath}/owner`);
    const pid = lockOwner(token);
    const after = statSync(reclaimPath);
    if (token === undefined || pid === undefined || before.dev !== after.dev || before.ino !== after.ino) {
      return undefined;
    }
    return { token, pid, dev: after.dev, ino: after.ino };
  } catch {
    return undefined;
  }
}

function sameReclaimOwner(expected: ReclaimIdentity, actual: ReclaimIdentity | undefined): actual is ReclaimIdentity {
  return actual !== undefined && expected.token === actual.token && expected.dev === actual.dev && expected.ino === actual.ino;
}

function lockOwner(content: string | undefined): number | undefined {
  const owner = Number.parseInt(content ?? '', 10);
  return Number.isInteger(owner) && owner > 0 ? owner : undefined;
}

function readLockContent(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function releaseLock(path: string, token: string): void {
  const lockPath = `${path}.lock`;
  try {
    if (readLockContent(lockPath) === token) {
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

function readJournal(path: string, assertWritable: () => void): LoadedJournal {
  const originalText = readFileSync(path, 'utf8');
  let text = originalText;
  let torn_tail_ignored = false;
  let ignored_tail_bytes = 0;
  if (text.length > 0 && !text.endsWith('\n')) {
    const breakAt = text.lastIndexOf('\n');
    const tail = text.slice(breakAt + 1);
    let validTail = false;
    try {
      JSON.parse(tail);
      validTail = true;
    } catch {
      const valid = text.slice(0, breakAt + 1);
      text = valid;
      torn_tail_ignored = true;
      ignored_tail_bytes = Buffer.byteLength(tail);
    }
    if (validTail) {
      text += '\n';
    }
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const parsed: { value: unknown; index: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`invalid host store log at line ${index + 1}: ${path}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`invalid host store log at line ${index + 1}: ${path}`);
    }
    parsed.push({ value, index });
  }
  const single = parsed.length === 1 ? parsed[0] : undefined;
  const legacySnapshot = single && isLegacySnapshot(single.value) ? single.value : null;
  const records = legacySnapshot ? [] : parsed.map(({ value, index }) => asMutation(value, index, path));
  // Validate every complete record before repairing a torn tail or adding a newline.
  if (text !== originalText) {
    assertWritable();
    if (originalText.startsWith(text)) {
      truncateSync(path, Buffer.byteLength(text));
    } else {
      appendFileSync(path, '\n');
    }
  }
  return { records, legacySnapshot, torn_tail_ignored, ignored_tail_bytes };
}

function isLegacySnapshot(value: unknown): value is FabricSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return !('op' in record) && isSnapshot(value);
}

function asMutation(value: unknown, index: number, path: string): FabricMutation {
  const record = value as { op?: unknown; snapshot?: unknown };
  if (record.op === 'snapshot' && !isSnapshot(record.snapshot)) {
    throw new Error(`invalid host store snapshot at line ${index + 1}: ${path}`);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCounter(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function arrayOf(value: unknown, valid: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(valid);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isKind(value: unknown): boolean {
  return value === 'source' || value === 'destination' || value === 'workspace';
}

function isOutcome(value: unknown): boolean {
  return isRecord(value) && (
    (value.outcome === 'succeeded' && 'output' in value) ||
    (value.outcome === 'failed' && isString(value.failure)) ||
    (value.outcome === 'uncertain' && isString(value.reason))
  );
}

function isPublication(value: unknown): boolean {
  return isRecord(value) && isString(value.invocation_id) && isString(value.binding_digest) &&
    isString(value.report_digest) && isString(value.destination) && isCounter(value.committed_revision);
}

function isResource(value: unknown): boolean {
  return isRecord(value) && isString(value.canonical_id) && isKind(value.kind) &&
    isString(value.locator) && isCounter(value.revision) && isString(value.content) &&
    (value.publication === null || isPublication(value.publication));
}

function isRef(value: unknown): boolean {
  return isRecord(value) && isString(value.handle) && isString(value.canonical_id) && isKind(value.kind);
}

function isInvocation(value: unknown): boolean {
  return isRecord(value) && isString(value.invocation_id) && isString(value.action_id) &&
    isString(value.operation) && (value.implementation_id === undefined || isString(value.implementation_id)) &&
    isString(value.binding_digest) && 'inputs' in value &&
    ['running', 'committed', 'stopped', 'uncertain'].includes(value.status as string) &&
    (value.outcome === null || isOutcome(value.outcome)) && typeof value.cancel_requested === 'boolean' &&
    (value.measured_cost_micros === undefined || isNonNegativeNumber(value.measured_cost_micros));
}

function isContract(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const stringMap = (item: unknown) => isRecord(item) && Object.values(item).every(isString);
  const selector = (item: unknown) => isRecord(item) && isString(item.input) &&
    ['discover', 'read', 'create', 'write', 'append', 'delete'].includes(item.mode as string);
  const processSelector = (item: unknown) => isRecord(item) && (
    item.name === 'process.spawn' || (item.name === 'fs.write' && isString(item.input))
  );
  const inference = value.inference;
  return isString(value.id) && isString(value.revision) && isString(value.purpose) &&
    stringMap(value.input) && stringMap(value.output) && arrayOf(value.effects, selector) &&
    arrayOf(value.permissions, selector) && arrayOf(value.failures, isString) &&
    arrayOf(value.depends_on, isString) &&
    (value.process_effects === undefined || arrayOf(value.process_effects, processSelector)) &&
    (inference === undefined || (isRecord(inference) && isString(inference.kind) &&
      ['framing', 'working', 'extension'].includes(inference.role as string) &&
      isNonNegativeNumber(inference.max_cost) && arrayOf(inference.destinations, isString) &&
      isCounter(inference.max_attempts)));
}

function isAdmission(value: unknown): boolean {
  return isRecord(value) && isString(value.operation) && isString(value.implementation_id) &&
    isContract(value.contract) && isString(value.source);
}

function isWorkload(value: unknown): boolean {
  return isRecord(value) && isString(value.goal_id) && (value.quality === 'held' || value.quality === 'missed');
}

function isBuiltinResult(value: unknown): boolean {
  return isRecord(value) && isString(value.key) && isString(value.operation) &&
    isString(value.implementation_id) && isOutcome(value.outcome);
}

function isSnapshot(value: unknown): value is FabricSnapshot {
  return isRecord(value) && isCounter(value.next_handle) && isCounter(value.next_canonical) &&
    arrayOf(value.resources, isResource) && arrayOf(value.refs, isRef) && arrayOf(value.invocations, isInvocation) &&
    (value.admissions === undefined || arrayOf(value.admissions, isAdmission)) &&
    (value.conclusions === undefined || Array.isArray(value.conclusions)) &&
    (value.workload === undefined || arrayOf(value.workload, isWorkload)) &&
    (value.measured_cost_micros === undefined || isNonNegativeNumber(value.measured_cost_micros)) &&
    (value.builtin_results === undefined || arrayOf(value.builtin_results, isBuiltinResult));
}
