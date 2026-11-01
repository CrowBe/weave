import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
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
  readdirSync,
  readlinkSync,
  readSync,
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
import { isEffect, type CapabilityContract, type InvocationOutcome, type ResourceEffect } from '@weave/agentsop';
import { stableStringify } from './stable-json.js';

const openStores = new Map<string, FabricStore>();
const COMPACT_BYTES = 256 * 1024;
let lockSequence = 0;

/** Synchronous backoff for the path-backed writer lock; injectable for deterministic races. */
export interface FabricStoreOptions {
  readonly sleep?: (milliseconds: number) => void;
  /** Bounds local waits only; without it, time is the sum of slept milliseconds. */
  readonly clock?: { now(): number };
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));
const defaultLockSleep = (milliseconds: number): void => {
  Atomics.wait(lockWait, 0, 0, milliseconds);
};

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

export interface InvocationReconciliation {
  readonly resolution: 'committed' | 'not_committed';
  readonly evidence: string;
}

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
  /** Canonical effect scopes persisted before execution; absent in old journals. */
  reservation?: readonly ResourceEffect[];
  /** Host-owned snapshot captured before spawn; pgid appended once after spawn. */
  cli_generation?: { readonly cwd_ref: string; readonly before_snapshot: string | null; readonly pgid?: number };
  reconciliation?: InvocationReconciliation;
  /** Absent for the first attempt. A later attempt supersedes a reconciled stopped CLI generation. */
  attempt?: number;
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
  /** Earlier attempts of re-run invocation ids, oldest first. */
  readonly superseded_invocations?: readonly InvocationRecord[];
}

interface MutableResource extends StoredResource {}

type FabricMutation =
  | { readonly op: 'snapshot'; readonly snapshot: FabricSnapshot }
  | { readonly op: 'allocate'; readonly id: string }
  | { readonly op: 'issue'; readonly ref: IssuedRef }
  | { readonly op: 'put'; readonly resource: StoredResource }
  | { readonly op: 'start'; readonly record: InvocationRecord; readonly measured_cost_micros: number }
  | { readonly op: 'cli_started'; readonly invocation_id: string; readonly pgid: number }
  | { readonly op: 'result'; readonly record: InvocationRecord }
  | { readonly op: 'uncertain'; readonly record: InvocationRecord }
  | { readonly op: 'reconcile'; readonly record: InvocationRecord }
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
 *
 * Store writer lock: lock, reclaim owner and claims share a JSON v2 token
 * (pid, boot/PID-namespace identity, process start time, unique nonce). Legacy
 * leading-pid tokens retain kill(pid, 0) behavior. Matching local start means
 * alive; ESRCH-confirmed missing pid or changed start means dead. V2 owners
 * with a foreign host identity or unverifiable liveness are unknown and never
 * automatically reclaimed. A sibling worker is alive.
 * Only proven-dead owners permit stale-lock reclaim, never elapsed time.
 *
 * Reapers exclusively link fully written files at reap, reap.2, ... (16 max).
 * Only the highest live claimant may move a generation, after revalidating its
 * token/device/inode, all earlier claims dead and no later claim. Never delete
 * another owner's claim. Legacy ownerless reap directories need 500 ms of
 * stable local observation. Injected time (default: sum of sleeps) bounds live
 * waits to 2000 ms per acquisition; iteration caps also bound a stopped clock.
 * Live reapers produce retry-later errors without removal hints, including a
 * live claim seen linking into a back-out gap below ours while that same claim
 * (token, device, inode) stays live across retries; other earlier live claims,
 * unknown owners, non-directory generations and slot exhaustion fail closed
 * with canonical paths and conditional operator steps.
 * Quarantine identity mismatches must restore or fail closed.
 *
 * No leases, heartbeats, garbage sweeping, journal changes or async open.
 * Assumes Linux boot/namespace/start identify an incarnation and stores do not
 * mix with versions older than #233. An older reaper already past revalidation
 * relies on the defensive quarantine restore. UUID nonces cover hosts without
 * start identity; no clock or owner timestamp supplies liveness evidence.
 */
export class FabricStore {
  private next_handle = 1;
  private next_canonical = 1;
  private readonly resources = new Map<string, MutableResource>();
  private readonly refs = new Map<string, IssuedRef>();
  private readonly canonicalPrimary = new Map<string, string>();
  private readonly publicationOwners = new Map<string, string>();
  private readonly invocations = new Map<string, InvocationRecord>();
  private superseded: InvocationRecord[] = [];
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

  constructor(snapshot?: FabricSnapshot, path: string | null = null, options: FabricStoreOptions = {}) {
    if (snapshot !== undefined) {
      const validated = encodeMutation({ op: 'snapshot', snapshot }).mutation;
      if (validated.op !== 'snapshot') throw new Error('invalid host store snapshot');
      snapshot = validated.snapshot;
    }
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
    const lockToken = acquireLock(key, options);
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

  static open(path: string, options: FabricStoreOptions = {}): FabricStore {
    return new FabricStore(undefined, path, options);
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
      invocations: [...this.invocations.values()].map((record) => structuredClone(record)),
      admissions: this.admissions.map((admission) => ({ ...admission, contract: { ...admission.contract } })),
      conclusions: this.conclusionRecords.map((conclusion) => structuredClone(conclusion)),
      workload: this.workloadRecords.map((item) => ({ ...item })),
      measured_cost_micros: this.measured_cost_micros,
      builtin_results: [...this.builtinResults.values()].map((item) => ({
        ...item,
        outcome: structuredClone(item.outcome),
      })),
      ...(this.superseded.length
        ? { superseded_invocations: this.superseded.map((record) => structuredClone(record)) }
        : {}),
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
    const record = this.invocations.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  invocationRecords(): readonly InvocationRecord[] {
    return [...this.invocations.values()].map((record) => structuredClone(record));
  }

  /** Superseded attempts of an invocation id, oldest first; `getInvocation` holds the current attempt. */
  supersededInvocations(id: string): readonly InvocationRecord[] {
    return this.superseded.filter((record) => record.invocation_id === id).map((record) => structuredClone(record));
  }

  persistInvocationStart(record: InvocationRecord, measuredCostMicros = 0): void {
    if (!this.persistStart) {
      throw new PersistFailure('invocation start');
    }
    this.mutate({ op: 'start', record, measured_cost_micros: measuredCostMicros });
    this.save();
  }

  persistCliGenerationStarted(invocation_id: string, pgid: number): void {
    this.mutate({ op: 'cli_started', invocation_id, pgid });
    this.save();
  }

  persistInvocationResult(record: InvocationRecord): void {
    if (!this.persistResult) {
      throw new PersistFailure('invocation result');
    }
    this.mutate({ op: 'result', record });
    this.save();
  }

  persistInvocationUncertain(record: InvocationRecord): void {
    this.mutate({ op: 'uncertain', record });
    this.save();
  }

  persistInvocationReconciliation(record: InvocationRecord): void {
    this.mutate({ op: 'reconcile', record });
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

  retainConclusion(conclusion: unknown): unknown {
    this.mutate({ op: 'conclusion', conclusion });
    this.save();
    return structuredClone(this.conclusionRecords.at(-1));
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
    this.mutate({ op: 'remember', result });
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
    // Validate both the supplied value and its JSON representation. Apply exactly
    // the detached value that replay will see, including allowed JSON normalization.
    const encoded = encodeMutation(mutation);
    mutation = encoded.mutation;
    this.validateTransition(mutation);
    let cost = this.measured_cost_micros;
    if (mutation.op === 'cost') cost += mutation.micros;
    if (mutation.op === 'start') {
      const previous = this.invocations.get(mutation.record.invocation_id);
      const superseding = supersedes(previous, mutation.record);
      if (previous?.cli_generation !== undefined && !superseding) {
        throw new Error('invalid host store CLI generation evidence transition');
      }
      // A superseded attempt keeps its measured cost.
      const previousCost =
        previous && !superseding ? (previous.measured_cost_micros ?? mutation.measured_cost_micros) : 0;
      cost += mutation.measured_cost_micros - previousCost;
    }
    if (!isNonNegativeNumber(cost)) throw new Error('invalid host store measured cost');
    this.append(encoded.text);
    this.applyMutation(mutation);
  }

  private append(text: string): void {
    if (!this.path) {
      return;
    }
    this.assertWritable();
    if (!this.journalReady) {
      this.compact();
    }
    const line = Buffer.from(text);
    const previousBytes = this.fileBytes;
    const fd = openSync(this.path, 'a+');
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
            const appended = Buffer.alloc(written);
            if (
              readSync(fd, appended, 0, written, previousBytes) !== written ||
              !appended.equals(line.subarray(0, written))
            ) {
              throw new Error('host store append range changed');
            }
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
    const { text } = encodeMutation({ op: 'snapshot', snapshot: this.snapshot() });
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
    this.validateTransition(mutation);
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
      case 'cli_started': {
        const record = this.invocations.get(mutation.invocation_id)!;
        this.setInvocation({ ...record, cli_generation: { ...record.cli_generation!, pgid: mutation.pgid } });
        return;
      }
      case 'result':
      case 'uncertain':
      case 'reconcile':
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

  private validateTransition(mutation: FabricMutation): void {
    if (mutation.op === 'cli_started') {
      const previous = this.invocations.get(mutation.invocation_id);
      if (
        !previous?.cli_generation ||
        previous.status !== 'running' ||
        previous.reconciliation ||
        previous.cli_generation.pgid !== undefined
      )
        throw new Error('invalid host store CLI process group transition');
    }
    if ('record' in mutation && ['start', 'result', 'uncertain', 'reconcile'].includes(mutation.op)) {
      const previous = this.invocations.get(mutation.record.invocation_id);
      // Only a superseding start sets an attempt; later mutations keep (or omit and inherit) it.
      if (
        mutation.record.attempt !== undefined &&
        (mutation.op === 'start'
          ? !supersedes(previous, mutation.record)
          : previous?.attempt !== mutation.record.attempt)
      ) {
        throw new Error('invalid host store attempt transition');
      }
      if (
        mutation.record.cli_generation !== undefined &&
        !(mutation.op === 'start' && supersedes(previous, mutation.record)) &&
        (previous
          ? previous.cli_generation?.cwd_ref !== mutation.record.cli_generation.cwd_ref ||
            previous.cli_generation.before_snapshot !== mutation.record.cli_generation.before_snapshot ||
            previous.cli_generation.pgid !== mutation.record.cli_generation.pgid
          : mutation.op !== 'start')
      ) {
        throw new Error('invalid host store CLI generation evidence transition');
      }
    }
    if (mutation.op !== 'uncertain' && mutation.op !== 'reconcile') return;
    const previous = this.invocations.get(mutation.record.invocation_id);
    // A stopped record may only gain not_committed evidence; its terminal outcome is unchanged.
    const stoppedEvidence =
      mutation.op === 'reconcile' &&
      previous?.status === 'stopped' &&
      mutation.record.status === 'stopped' &&
      mutation.record.reconciliation?.resolution === 'not_committed' &&
      stableStringify(previous.outcome) === stableStringify(mutation.record.outcome);
    if (
      !previous ||
      previous.binding_digest !== mutation.record.binding_digest ||
      previous.action_id !== mutation.record.action_id ||
      previous.operation !== mutation.record.operation ||
      previous.reconciliation ||
      (previous.status !== 'running' && previous.status !== 'uncertain' && !stoppedEvidence)
    ) {
      throw new Error(`invalid host store ${mutation.op} transition`);
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
      this.invocations.set(record.invocation_id, structuredClone(record));
    }
    this.superseded = (snapshot?.superseded_invocations ?? []).map((record) => structuredClone(record));
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
    const superseding = supersedes(previous, record);
    if (superseding) this.superseded.push(previous!);
    const previousCost = previous && !superseding ? (previous.measured_cost_micros ?? measuredCostMicros) : 0;
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
    if (stored.reservation === undefined && previous?.reservation !== undefined) {
      stored.reservation = structuredClone(previous.reservation);
    }
    if (stored.cli_generation === undefined && previous?.cli_generation !== undefined) {
      stored.cli_generation = structuredClone(previous.cli_generation);
    }
    if (stored.attempt === undefined && previous?.attempt !== undefined) {
      stored.attempt = previous.attempt;
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
      lstatSync(absolute);
    } catch (missing) {
      if (!isErrno(missing, 'ENOENT')) throw missing;
      // A new journal has no inode yet; resolve directory aliases before locking.
      return join(realpathSync(directory), basename(absolute));
    }
    // Another opener may have created the journal after realpath missed it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return realpathSync(absolute);
      } catch (retryError) {
        if (!isErrno(retryError, 'ENOENT')) throw retryError;
      }
    }
    // A dangling symlink is an existing alias, not a new journal filename.
    throw error;
  }
}

function acquireLock(path: string, options: FabricStoreOptions): string {
  const lockPath = `${path}.lock`;
  const nonce = `${threadId}.${(lockSequence += 1)}.${randomUUID()}`;
  const token = JSON.stringify({ v: 2, pid: process.pid, ...localOwnerIdentity(), nonce } satisfies OwnerTokenV2);
  const tempPath = `${lockPath}.${nonce}.tmp`;
  let slept = 0;
  const wait = {
    now: () => options.clock?.now() ?? slept,
    sleep(milliseconds: number) {
      (options.sleep ?? defaultLockSleep)(milliseconds);
      slept += milliseconds;
    },
  };
  const evidence: ReclaimEvidence = { deadline: undefined, arrivals: new Map() };
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
      if (owner === undefined) {
        // The previous writer may have released its lock after link failed.
        continue;
      }
      const state = ownerState(owner);
      if (state === 'unknown') throw unverifiableOwner(path, lockPath);
      if (state === 'alive') {
        throw new Error(`host store is already open: ${path}`);
      }
      if (!acquireReclaim(path, token, nonce, wait, evidence)) {
        continue;
      }
      try {
        const current = readLockContent(lockPath);
        if (current !== owner || ownerState(current) !== 'dead') {
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
        releaseReclaim(`${lockPath}.reclaim`, token, nonce);
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

const RECLAIM_WAIT_MS = 2000;
const OWNERLESS_GRACE_MS = 500;
const MAX_CLAIM_SLOTS = 16;
// Enough backoff rounds to reach the deadline; also terminates a stopped clock.
const MAX_RECLAIM_WAITS = 128;

interface ReclaimWait {
  now(): number;
  sleep(milliseconds: number): void;
}

/** Kept across one acquisition's reclaim retries, so a back-out is not forgotten. */
interface ReclaimEvidence {
  deadline: number | undefined;
  // Live file claims seen linking into a back-out gap after our pre-link scan.
  readonly arrivals: Map<string, ClaimIdentity>;
}

interface ClaimIdentity {
  readonly token: string;
  readonly dev: number;
  readonly ino: number;
}

/** Only a claimant of the observed generation may move it. */
function acquireReclaim(
  path: string,
  token: string,
  nonce: string,
  wait: ReclaimWait,
  evidence: ReclaimEvidence,
): boolean {
  const reclaimPath = `${path}.lock.reclaim`;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const tempPath = `${reclaimPath}.${nonce}.${(lockSequence += 1)}.tmp`;
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
        // Best-effort removal of our unpublished directory.
      }
    }
    const owner = readReclaimIdentity(path, reclaimPath);
    if (owner === undefined) return false;
    const state = ownerState(owner.token);
    if (state === 'unknown') throw unverifiableOwner(path, reclaimPath);
    if (state === 'alive') return false;
    if (!reapGeneration(path, reclaimPath, owner, token, nonce, wait, evidence)) return false;
  }
  return false;
}

function reapGeneration(
  path: string,
  reclaimPath: string,
  owner: ReclaimIdentity,
  token: string,
  nonce: string,
  wait: ReclaimWait,
  evidence: ReclaimEvidence,
): boolean {
  // One live-wait budget per acquisition, however often we back out and retry.
  const deadline = (evidence.deadline ??= wait.now() + RECLAIM_WAIT_MS);
  const ownerless = new Map<string, number>();
  let backoff = 5;
  for (let attempt = 0; attempt < MAX_RECLAIM_WAITS; attempt += 1) {
    if (!sameReclaimOwner(owner, readReclaimIdentity(path, reclaimPath))) return false;
    const slots = claimSlots(reclaimPath);
    const highest = slots.at(-1) ?? 0;
    const claimPath = slotPath(reclaimPath, highest);
    // Observe every slot before linking, so earlier ownerless claims accrue
    // grace even when a later reaper has already linked and then crashed.
    const states = slots.map((slot) => {
      const path = slotPath(reclaimPath, slot);
      return { path, state: claimState(path, ownerless, wait) };
    });
    const unknown = states.find((claim) => claim.state === 'unknown');
    if (unknown) throw blockedReclaim(path, unknown.path, reclaimPath);
    if (states.some((claim) => claim.state === undefined)) continue;
    const pending = states.find((claim) => claim.state === 'alive');
    if (pending) {
      if (wait.now() >= deadline || attempt === MAX_RECLAIM_WAITS - 1) {
        // A lower live claim is only a reaper mid-protocol if we saw that same
        // claim arrive in a gap; anything else earlier still fails closed.
        const blocked = states.find(
          (claim) =>
            claim.state === 'alive' &&
            claim.path !== claimPath &&
            !sameClaim(evidence.arrivals.get(claim.path), claimIdentity(claim.path)),
        );
        if (blocked) throw blockedReclaim(path, blocked.path, reclaimPath);
        throw new Error(
          `host store is already open: ${path}; stale-lock reclaim is in progress by a live process (${pending.path}); retry later`,
        );
      }
      wait.sleep(Math.min(backoff, Math.max(0, deadline - wait.now())));
      backoff = Math.min(backoff * 2, 50);
      continue;
    }
    if (highest >= MAX_CLAIM_SLOTS) throw blockedReclaim(path, reclaimPath, reclaimPath);
    const next = highest + 1;
    const ours = slotPath(reclaimPath, next);
    const temp = `${reclaimPath}/.reap.${nonce}.tmp`;
    try {
      writeFileSync(temp, token, { flag: 'wx' });
      // The entire token is visible on success, including to legacy readers.
      linkSync(temp, ours);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      if (isErrno(error, 'EEXIST')) continue;
      throw error;
    } finally {
      try {
        unlinkSync(temp);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    // Claim then revalidate: a delayed link can land in a successor generation.
    const current = readReclaimIdentity(path, reclaimPath);
    const claims = claimSlots(reclaimPath);
    let unresolved: string | undefined;
    if (
      !sameReclaimOwner(owner, current) ||
      ownerState(current.token) !== 'dead' ||
      readLockContent(ours) !== token ||
      claims.some((n) => {
        if (n > next) return true;
        if (n === next) return false;
        const earlier = slotPath(reclaimPath, n);
        const state = claimState(earlier, ownerless, wait);
        if (state === 'unknown' || (state === 'alive' && slots.includes(n))) unresolved = earlier;
        else if (state === 'alive') {
          // A live claim absent from our scan was linked into a back-out gap; its
          // owner also sees a higher claim and backs out, so retry instead. Remember
          // it so a retry that outlasts the deadline still reports retry-later.
          const arrival = claimIdentity(earlier);
          if (arrival) evidence.arrivals.set(earlier, arrival);
        }
        return state !== 'dead';
      })
    ) {
      // Accepted residual race: generation replacement between this
      // token check and unlink can redirect the path to a successor's slot.
      // A dev/ino precheck would still leave a gap before unlink; the invariant
      // remains that we must never delete another owner's claim. Closing the
      // window requires deletion relative to a stable directory identity;
      // this cleanup retains the existing claim-slot protocol.
      if (readLockContent(ours) === token) {
        try {
          unlinkSync(ours);
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
      }
      if (unresolved) throw blockedReclaim(path, unresolved, reclaimPath);
      return false;
    }
    const quarantine = `${reclaimPath}.stale.${nonce}.${(lockSequence += 1)}`;
    try {
      renameSync(reclaimPath, quarantine);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }
    const moved = readReclaimIdentity(path, quarantine);
    if (!sameReclaimOwner(owner, moved) || ownerState(moved.token) !== 'dead') {
      try {
        renameSync(quarantine, reclaimPath);
      } catch (error) {
        throw new Error(
          `failed to restore host store reclaim directory from ${quarantine} to ${reclaimPath}; ` +
            `confirm no weave process is using ${path}, then move ${reclaimPath} and ${quarantine} aside and retry`,
          { cause: error },
        );
      }
      return false;
    }
    try {
      rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // Best-effort garbage removal after exclusively moving the generation.
    }
    return true;
  }
  throw new Error(
    `host store is already open: ${path}; stale-lock reclaim contention exhausted retries (${reclaimPath}); retry later`,
  );
}

function slotPath(reclaimPath: string, slot: number): string {
  return `${reclaimPath}/reap${slot <= 1 ? '' : `.${slot}`}`;
}

function claimSlots(reclaimPath: string): number[] {
  try {
    return readdirSync(reclaimPath)
      .flatMap((name) =>
        name === 'reap'
          ? [1]
          : /^reap\.[1-9][0-9]*$/.test(name) && Number(name.slice(5)) >= 2
            ? [Number(name.slice(5))]
            : [],
      )
      .sort((a, b) => a - b);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
}

/** A v2 file claim's stable token and inode; directory claims have none. */
function claimIdentity(path: string): ClaimIdentity | undefined {
  try {
    const before = lstatSync(path);
    if (!before.isFile()) return undefined;
    const token = readLockContent(path);
    const after = lstatSync(path);
    if (token === undefined || before.dev !== after.dev || before.ino !== after.ino) return undefined;
    return { token, dev: after.dev, ino: after.ino };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function sameClaim(expected: ClaimIdentity | undefined, actual: ClaimIdentity | undefined): boolean {
  return (
    expected !== undefined &&
    actual !== undefined &&
    expected.token === actual.token &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    ownerState(actual.token) === 'alive'
  );
}

function claimState(path: string, ownerless: Map<string, number>, wait: ReclaimWait): OwnerState | undefined {
  try {
    const before = lstatSync(path);
    const token = readLockContent(before.isDirectory() ? `${path}/owner` : path);
    if (!before.isDirectory()) return token === undefined ? undefined : ownerState(token);
    // Legacy directory claims can expose an empty owner before publishing it.
    if (token !== undefined && token !== '') return ownerState(token);
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino) return 'alive';
    const key = `${path}:${before.dev}:${before.ino}`;
    const observed = ownerless.get(key);
    if (observed === undefined) ownerless.set(key, wait.now());
    return observed !== undefined && wait.now() - observed >= OWNERLESS_GRACE_MS ? 'dead' : 'alive';
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function unverifiableOwner(path: string, ownerPath: string): Error {
  return new Error(
    `host store is already open: ${path}; owner of ${ownerPath} cannot be verified from this host; retry later; ` +
      `confirm no weave process on any host is using ${path}, then remove ${ownerPath} and retry`,
  );
}

function blockedReclaim(path: string, blockedPath: string, reclaimPath: string): Error {
  return new Error(
    `host store is already open: ${path}; stale-lock reclaim is blocked by ${blockedPath}; ` +
      `confirm no weave process is using ${path}, then remove ${reclaimPath} and retry`,
  );
}

function releaseReclaim(reclaimPath: string, token: string, nonce: string): void {
  try {
    if (readLockContent(`${reclaimPath}/owner`) === token) {
      const quarantine = `${reclaimPath}.released.${nonce}.${(lockSequence += 1)}`;
      renameSync(reclaimPath, quarantine);
      rmSync(quarantine, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

interface ReclaimIdentity {
  readonly token: string | undefined;
  readonly dev: number;
  readonly ino: number;
}

function readReclaimIdentity(path: string, reclaimPath: string): ReclaimIdentity | undefined {
  try {
    const before = statSync(reclaimPath);
    const token = readLockContent(`${reclaimPath}/owner`);
    const after = statSync(reclaimPath);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      return undefined;
    }
    return { token, dev: after.dev, ino: after.ino };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    // A non-directory generation or owner has no verifiable identity.
    if (isErrno(error, 'ENOTDIR') || isErrno(error, 'EISDIR')) {
      throw blockedReclaim(path, reclaimPath, `${path}.lock.reclaim`);
    }
    throw error;
  }
}

function sameReclaimOwner(expected: ReclaimIdentity, actual: ReclaimIdentity | undefined): actual is ReclaimIdentity {
  return (
    actual !== undefined &&
    expected.token === actual.token &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

interface OwnerTokenV2 {
  readonly v: 2;
  readonly pid: number;
  readonly host: string | null;
  readonly start: string | null;
  readonly nonce: string;
}

type OwnerState = 'alive' | 'dead' | 'unknown';
let localIdentity: { host: string | null; start: string | null } | undefined;

function processStart(pid: number | 'self'): string | null {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
  return start !== undefined && /^[0-9]+$/.test(start) ? start : null;
}

function localOwnerIdentity(): { host: string | null; start: string | null } {
  if (localIdentity !== undefined) return localIdentity;
  let host: string | null = null;
  let start: string | null = null;
  try {
    host = `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${readlinkSync('/proc/self/ns/pid')}`;
  } catch {
    // An unavailable local identity allows only the legacy kill probe fallback.
  }
  try {
    start = processStart('self');
  } catch {
    // A missing start identity is recorded explicitly, never guessed.
  }
  localIdentity = { host, start };
  return localIdentity;
}

function ownerState(text: string | undefined): OwnerState {
  if (text === undefined) return 'unknown';
  if (!text.startsWith('{')) {
    const pid = Number.parseInt(text, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? probePid(pid) : 'unknown';
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'unknown';
  }
  if (
    !isRecord(value) ||
    value.v !== 2 ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    !(value.host === null || (typeof value.host === 'string' && value.host.length > 0)) ||
    !(value.start === null || (typeof value.start === 'string' && /^[0-9]+$/.test(value.start))) ||
    typeof value.nonce !== 'string' ||
    value.nonce.length === 0
  )
    return 'unknown';
  const local = localOwnerIdentity();
  if (local.host === null && value.host === null) return probePid(Number(value.pid));
  if (local.host === null || value.host !== local.host || value.start === null) return 'unknown';
  try {
    const start = processStart(Number(value.pid));
    return start === null ? 'unknown' : start === value.start ? 'alive' : 'dead';
  } catch (error) {
    // hidepid can also return ENOENT for a live process owned by another user.
    return isErrno(error, 'ENOENT') && probePid(Number(value.pid)) === 'dead' ? 'dead' : 'unknown';
  }
}

function probePid(pid: number): OwnerState {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return isErrno(error, 'ESRCH') ? 'dead' : 'alive';
  }
}

function readLockContent(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8').trim();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
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

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function counterAfter(value: string, prefix: string): number | undefined {
  if (!value.startsWith(prefix) || !/^[0-9]+$/.test(value.slice(prefix.length))) {
    return undefined;
  }
  const parsed = Number(value.slice(prefix.length));
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed < Number.MAX_SAFE_INTEGER ? parsed : undefined;
}

function readJournal(path: string, assertWritable: () => void): LoadedJournal {
  const raw = readFileSync(path);
  const originalText = raw.toString('utf8');
  let text = originalText;
  let torn_tail_ignored = false;
  let ignored_tail_bytes = 0;
  let retainedBytes = raw.length;
  if (raw.length > 0 && raw.at(-1) !== 0x0a) {
    const breakAt = raw.lastIndexOf(0x0a);
    const tail = raw.subarray(breakAt + 1).toString('utf8');
    let validTail = false;
    try {
      JSON.parse(tail);
      validTail = true;
    } catch {
      retainedBytes = breakAt + 1;
      text = raw.subarray(0, retainedBytes).toString('utf8');
      torn_tail_ignored = true;
      ignored_tail_bytes = raw.length - retainedBytes;
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
    if (torn_tail_ignored) {
      truncateSync(path, retainedBytes);
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
  if (!isMutation(value)) {
    throw new Error(`invalid host store mutation at line ${index + 1}: ${path}`);
  }
  return value as FabricMutation;
}

/** One payload contract for journal input, appends and compaction. */
function isMutation(value: unknown): value is FabricMutation {
  if (!isRecord(value)) return false;
  switch (value.op) {
    case 'snapshot':
      return isSnapshot(value.snapshot);
    case 'allocate':
      return isString(value.id) && counterAfter(value.id, 'res_') !== undefined;
    case 'issue':
      return isRef(value.ref);
    case 'put':
      return isResource(value.resource);
    case 'start':
      return isInvocation(value.record) && isNonNegativeNumber(value.measured_cost_micros);
    case 'cli_started':
      return isString(value.invocation_id) && isPgid(value.pgid);
    case 'result':
      return isInvocation(value.record);
    case 'uncertain':
      return (
        isInvocation(value.record) &&
        isRecord(value.record) &&
        value.record.status === 'uncertain' &&
        isRecord(value.record.outcome) &&
        value.record.outcome.outcome === 'uncertain' &&
        value.record.reconciliation === undefined
      );
    case 'reconcile':
      return isInvocation(value.record) && isRecord(value.record) && isReconciliation(value.record.reconciliation);
    case 'cost':
      return isNonNegativeNumber(value.micros);
    case 'admission':
      return isAdmission(value.admission);
    case 'conclusion':
      return 'conclusion' in value;
    case 'workload':
      return isWorkload(value.workload);
    case 'remember':
      return isBuiltinResult(value.result);
    default:
      return false;
  }
}

function encodeMutation(value: FabricMutation): { mutation: FabricMutation; text: string } {
  if (!isMutation(value)) throw new Error('invalid host store mutation');
  const json = JSON.stringify(value);
  const mutation: unknown = JSON.parse(json);
  if (!isMutation(mutation)) throw new Error('invalid host store serialized mutation');
  return { mutation, text: `${json}\n` };
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
  return (
    isRecord(value) &&
    ((value.outcome === 'succeeded' && 'output' in value) ||
      (value.outcome === 'failed' && isString(value.failure)) ||
      (value.outcome === 'uncertain' && isString(value.reason)))
  );
}

/** Validate and detach an untrusted outcome using the journal's replay rules. */
export function normalizeInvocationOutcome(value: unknown): InvocationOutcome {
  if (!isOutcome(value)) throw new Error('invalid host store outcome');
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  if (!isOutcome(normalized)) throw new Error('invalid host store serialized outcome');
  return normalized as InvocationOutcome;
}

function isPublication(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.invocation_id) &&
    isString(value.binding_digest) &&
    isString(value.report_digest) &&
    isString(value.destination) &&
    isCounter(value.committed_revision)
  );
}

function isResource(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.canonical_id) &&
    isKind(value.kind) &&
    isString(value.locator) &&
    isCounter(value.revision) &&
    isString(value.content) &&
    (value.publication === null || isPublication(value.publication))
  );
}

function isRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.handle) &&
    counterAfter(value.handle, 'ref_') !== undefined &&
    isString(value.canonical_id) &&
    isKind(value.kind)
  );
}

function isInvocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.invocation_id) &&
    isString(value.action_id) &&
    isString(value.operation) &&
    (value.implementation_id === undefined || isString(value.implementation_id)) &&
    isString(value.binding_digest) &&
    'inputs' in value &&
    ['running', 'committed', 'stopped', 'uncertain'].includes(value.status as string) &&
    (value.outcome === null || isOutcome(value.outcome)) &&
    typeof value.cancel_requested === 'boolean' &&
    (value.measured_cost_micros === undefined || isNonNegativeNumber(value.measured_cost_micros)) &&
    (value.reservation === undefined ||
      arrayOf(
        value.reservation,
        (effect) =>
          isRecord(effect) && isString(effect.resource) && effect.resource.length > 0 && isEffect(effect.mode),
      )) &&
    (value.cli_generation === undefined ||
      (value.operation === 'shell.run@1' &&
        isRecord(value.cli_generation) &&
        (value.cli_generation.pgid === undefined || isPgid(value.cli_generation.pgid)) &&
        isString(value.cli_generation.cwd_ref) &&
        value.cli_generation.cwd_ref.length > 0 &&
        isRecord(value.inputs) &&
        value.inputs.cwd_ref === value.cli_generation.cwd_ref &&
        (value.cli_generation.before_snapshot === null ||
          (typeof value.cli_generation.before_snapshot === 'string' &&
            /^[a-f0-9]{64}$/.test(value.cli_generation.before_snapshot))))) &&
    (value.attempt === undefined ||
      (typeof value.attempt === 'number' && Number.isSafeInteger(value.attempt) && value.attempt >= 2)) &&
    (value.reconciliation === undefined ||
      (isReconciliation(value.reconciliation) &&
        isRecord(value.outcome) &&
        (value.reconciliation.resolution === 'committed'
          ? value.status === 'committed' && value.outcome.outcome === 'succeeded'
          : value.status === 'stopped' && value.outcome.outcome === 'failed')))
  );
}

/**
 * One invocation id holds one current record. A CLI generation start may replace
 * a stopped attempt reconciled as not_committed only with the next attempt
 * number; the replaced record is retained as superseded history.
 */
function supersedes(previous: InvocationRecord | undefined, record: InvocationRecord): boolean {
  return (
    previous !== undefined &&
    previous.status === 'stopped' &&
    previous.reconciliation?.resolution === 'not_committed' &&
    record.attempt === (previous.attempt ?? 1) + 1 &&
    record.cli_generation !== undefined &&
    record.status === 'running' &&
    record.reconciliation === undefined &&
    record.action_id === previous.action_id &&
    record.operation === previous.operation &&
    record.binding_digest === previous.binding_digest
  );
}

function isReconciliation(value: unknown): value is InvocationReconciliation {
  return (
    isRecord(value) &&
    (value.resolution === 'committed' || value.resolution === 'not_committed') &&
    isString(value.evidence) &&
    value.evidence.trim().length > 0
  );
}

function isContract(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const stringMap = (item: unknown) => isRecord(item) && Object.values(item).every(isString);
  const selector = (item: unknown) =>
    isRecord(item) &&
    isString(item.input) &&
    ['discover', 'read', 'create', 'write', 'append', 'delete'].includes(item.mode as string);
  const processSelector = (item: unknown) =>
    isRecord(item) && (item.name === 'process.spawn' || (item.name === 'fs.write' && isString(item.input)));
  const inference = value.inference;
  return (
    isString(value.id) &&
    isString(value.revision) &&
    isString(value.purpose) &&
    stringMap(value.input) &&
    stringMap(value.output) &&
    arrayOf(value.effects, selector) &&
    arrayOf(value.permissions, selector) &&
    arrayOf(value.failures, isString) &&
    arrayOf(value.depends_on, isString) &&
    (value.process_effects === undefined || arrayOf(value.process_effects, processSelector)) &&
    (inference === undefined ||
      (isRecord(inference) &&
        isString(inference.kind) &&
        ['framing', 'working', 'extension'].includes(inference.role as string) &&
        isNonNegativeNumber(inference.max_cost) &&
        arrayOf(inference.destinations, isString) &&
        isCounter(inference.max_attempts)))
  );
}

function isAdmission(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.operation) &&
    isString(value.implementation_id) &&
    isContract(value.contract) &&
    isString(value.source)
  );
}

function isWorkload(value: unknown): boolean {
  return isRecord(value) && isString(value.goal_id) && (value.quality === 'held' || value.quality === 'missed');
}

function isBuiltinResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.key) &&
    isString(value.operation) &&
    isString(value.implementation_id) &&
    isOutcome(value.outcome)
  );
}

function isSnapshot(value: unknown): value is FabricSnapshot {
  return (
    isRecord(value) &&
    isCounter(value.next_handle) &&
    isCounter(value.next_canonical) &&
    arrayOf(value.resources, isResource) &&
    arrayOf(value.refs, isRef) &&
    arrayOf(value.invocations, isInvocation) &&
    (value.admissions === undefined || arrayOf(value.admissions, isAdmission)) &&
    (value.conclusions === undefined || Array.isArray(value.conclusions)) &&
    (value.workload === undefined || arrayOf(value.workload, isWorkload)) &&
    (value.measured_cost_micros === undefined || isNonNegativeNumber(value.measured_cost_micros)) &&
    (value.builtin_results === undefined || arrayOf(value.builtin_results, isBuiltinResult)) &&
    (value.superseded_invocations === undefined || arrayOf(value.superseded_invocations, isInvocation))
  );
}

function isPgid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
