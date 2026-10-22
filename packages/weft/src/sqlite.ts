/** Optional local inspection store. Never a journal, scheduler or authority store. */
import { DatabaseSync } from 'node:sqlite';
import { scheduler } from 'node:timers/promises';
import { hasCredential } from './credential.js';
import { serializeRecord } from './serialize.js';
import { serializeTrace, validateTrace } from './weave-trace.js';
import type { TraceImportPort, TraceRecord, TraceWriteResult } from './weave-trace.js';
import type { Redactor, WeftRecord } from './types.js';

export interface TraceStoreOptions {
  readonly redactTrace: (record: TraceRecord) => unknown;
  readonly redact: Redactor;
}
type Failure = Extract<TraceWriteResult, { ok: false }>;
const fail = (reason: Failure['reason']): Failure => ({ ok: false, reason });
const success = (inserted = 0, torn = false): TraceWriteResult => ({ ok: true, inserted, torn });
function storageFailure(error: unknown): Failure {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return fail(typeof code === 'number' && [5, 6].includes(code & 255) ? 'busy' : 'storage');
}
type Snapshot = {
  run: string;
  id: string;
  schema: string;
  parent: string | null;
  thread: string | null;
  kind: string;
  sequence: number;
  line: string;
  fields: Record<string, unknown>;
  emitterKind: string | null;
  emitterId: string | null;
  table: string | undefined;
};
const subtypes: Readonly<Record<string, string>> = {
  decision: 'decisions',
  audit: 'decisions',
  'cycle.weighed': 'decisions',
  judgment: 'decisions',
  'route.selected': 'decisions',
  'inference.attempt': 'model_calls',
  shell: 'tool_calls',
  'capability.invoked': 'tool_calls',
  error: 'errors',
  budget: 'budget_events',
};
// Column order is part of schema v1. Nested fields remain in the canonical record.
const details = {
  decisions: {
    site: 'TEXT',
    request_ref: 'TEXT',
    accepted: 'INTEGER',
    confidence: 'REAL',
    passed: 'INTEGER',
    procedure: 'TEXT',
    cycle_no: 'INTEGER',
    state_revision: 'INTEGER',
    weights_ref: 'TEXT',
    cost_micros: 'INTEGER',
    routed_unit: 'TEXT',
    tier: 'TEXT',
  },
  model_calls: {
    request_ref: 'TEXT',
    routed_unit: 'TEXT',
    attempt_no: 'INTEGER',
    disposition: 'TEXT',
    input_tokens: 'INTEGER',
    output_tokens: 'INTEGER',
    spent_micros: 'INTEGER',
    cost_is_upper_bound: 'INTEGER',
    latency_ms: 'REAL',
  },
  tool_calls: {
    contract_rev: 'TEXT',
    implementation: 'TEXT',
    status: 'TEXT',
    invocation_ref: 'TEXT',
    execution_tier: 'TEXT',
    failure: 'TEXT',
    latency_ms: 'REAL',
    spent_micros: 'REAL',
  },
  errors: { code: 'TEXT', retryable: 'INTEGER' },
  budget_events: { line: 'TEXT', budget_limit: 'INTEGER', reserved: 'INTEGER', spent: 'INTEGER', spent_micros: 'REAL' },
} as const;
const tables = Object.keys(details) as (keyof typeof details)[];
const schema = `
CREATE TABLE runs (run_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE threads (run_id TEXT NOT NULL REFERENCES runs(run_id), thread_id TEXT NOT NULL,
 PRIMARY KEY (run_id, thread_id)) STRICT;
CREATE TABLE spans (run_id TEXT NOT NULL REFERENCES runs(run_id), id TEXT NOT NULL,
 schema TEXT NOT NULL, parent_id TEXT, thread_id TEXT, kind TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence >= 0), emitter_kind TEXT, emitter_id TEXT, record_json TEXT NOT NULL,
 PRIMARY KEY (run_id, id), FOREIGN KEY (run_id, thread_id) REFERENCES threads(run_id, thread_id)) STRICT;
${tables
  .map(
    (table) => `CREATE TABLE ${table} (run_id TEXT NOT NULL, id TEXT NOT NULL, ${Object.entries(details[table])
      .map(([name, type]) => `${name} ${type}`)
      .join(', ')},
 PRIMARY KEY (run_id, id), FOREIGN KEY (run_id, id) REFERENCES spans(run_id, id)) STRICT;`,
  )
  .join('\n')}
PRAGMA user_version = 1;`;

export interface TraceStore extends TraceImportPort {
  upsert(record: TraceRecord): Promise<TraceWriteResult>;
  upsertBatch(records: readonly TraceRecord[], signal?: AbortSignal): Promise<TraceWriteResult>;
  importRecords(records: readonly unknown[], signal?: AbortSignal): Promise<TraceWriteResult>;
  importJsonl(jsonl: string, signal?: AbortSignal): Promise<TraceWriteResult>;
  read(): { readonly ok: true; readonly rows: readonly (TraceRecord | WeftRecord)[] } | Failure;
  close(): { readonly ok: true } | Failure;
}

/** All persistence is behind this explicit entry point; no database opens on import. */
export function openTraceStore(
  path: string,
  options: TraceStoreOptions,
): { readonly ok: true; readonly store: TraceStore } | Failure {
  let db: DatabaseSync | undefined;
  try {
    if (typeof options?.redact !== 'function' || typeof options?.redactTrace !== 'function') return fail('config');
    // Capture the functions once; changing options later cannot change a batch's boundary.
    const { redact, redactTrace } = options;
    db = new DatabaseSync(path);
    const database = db;
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;');
    const version = database.prepare('PRAGMA user_version').get()!['user_version'];
    if (version !== 0 && version !== 1) {
      database.close();
      return fail('schema');
    }
    if (version === 0) {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(schema);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    // Unknown or incomplete schemas fail before accepting work.
    for (const table of ['runs', 'threads', 'spans', ...tables])
      database.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
    let active = false;
    let closed = false;
    function snapshot(raw: unknown): Snapshot {
      const input = structuredClone(raw) as TraceRecord | WeftRecord;
      let line: string;
      if (input?.schema === 'weave.trace@1') {
        // Validate original JSONL as well as the redacted snapshot.
        if (!validateTrace(input)) throw new Error('input');
        line = serializeTrace(input, (r) => structuredClone(redactTrace(r)));
      } else {
        const validated = JSON.parse(serializeRecord(input as WeftRecord, redact)) as WeftRecord;
        const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
        // W6 omits optional null fields, but candidate weights are required nullable values.
        const fields = Object.fromEntries(Object.entries(validated.fields).filter(([, value]) => value !== null));
        line = serializeRecord(
          {
            ...validated,
            fields,
            links: [...validated.links].sort((a, b) => compare(a.rel, b.rel) || compare(a.record_id, b.record_id)),
            evidence: [...validated.evidence].sort((a, b) => compare(a.source, b.source) || compare(a.ref, b.ref)),
          } as unknown as WeftRecord,
          (record) => record,
        );
      }
      if (hasCredential(line)) throw new Error('disclosure');
      const clean = JSON.parse(line) as TraceRecord | WeftRecord;
      const legacy = clean.schema === 'weave.trace@1';
      return {
        run: legacy ? clean.run_id : clean.trace_id,
        id: legacy ? clean.id : clean.record_id,
        schema: clean.schema,
        parent: legacy ? clean.parentId : clean.parent_id,
        thread: legacy ? null : clean.thread_id,
        kind: clean.kind,
        sequence: clean.sequence,
        line,
        fields: { ...(legacy ? clean.payload : clean.fields) },
        emitterKind: legacy ? null : clean.emitter.kind,
        emitterId: legacy ? null : clean.emitter.id,
        table: subtypes[clean.kind],
      };
    }
    async function write(records: readonly unknown[], signal?: AbortSignal, torn = false): Promise<TraceWriteResult> {
      if (closed) return fail('storage');
      if (active) return fail('busy');
      active = true;
      let transaction = false;
      try {
        if (signal?.aborted) return fail('cancelled');
        let rows: Snapshot[];
        try {
          if (!Array.isArray(records)) return fail('input');
          rows = records.map(snapshot);
        } catch {
          return fail('disclosure');
        }
        if (signal?.aborted) return fail('cancelled');
        database.exec('BEGIN IMMEDIATE');
        transaction = true;
        let inserted = 0;
        const find = database.prepare('SELECT record_json FROM spans WHERE run_id = ? AND id = ?');
        const run = database.prepare('INSERT OR IGNORE INTO runs(run_id) VALUES (?)');
        const thread = database.prepare('INSERT OR IGNORE INTO threads(run_id, thread_id) VALUES (?, ?)');
        const span = database.prepare('INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const row of rows) {
          if (signal?.aborted) return fail('cancelled');
          const previous = find.get(row.run, row.id);
          if (previous) {
            if (previous['record_json'] !== row.line) return fail('conflict');
          } else {
            run.run(row.run);
            if (row.thread !== null) thread.run(row.run, row.thread);
            span.run(
              row.run,
              row.id,
              row.schema,
              row.parent,
              row.thread,
              row.kind,
              row.sequence,
              row.emitterKind,
              row.emitterId,
              row.line,
            );
            if (row.table) {
              const columns = Object.keys(details[row.table as keyof typeof details]);
              const values = columns.map((column) => {
                const value = row.fields[column === 'budget_limit' ? 'limit' : column];
                return typeof value === 'boolean'
                  ? Number(value)
                  : typeof value === 'string' || typeof value === 'number'
                    ? value
                    : null;
              });
              database
                .prepare(`INSERT INTO ${row.table} VALUES (?, ?, ${columns.map(() => '?').join(', ')})`)
                .run(row.run, row.id, ...values);
            }
            inserted++;
          }
          // Yield to pending abort handlers and other importer calls, retaining the lock.
          await scheduler.yield();
        }
        if (signal?.aborted) return fail('cancelled');
        database.exec('COMMIT');
        transaction = false;
        return success(inserted, torn);
      } catch (error) {
        return storageFailure(error);
      } finally {
        if (transaction) {
          try {
            database.exec('ROLLBACK');
          } catch {
            closed = true;
            try {
              database.close();
            } catch {
              /* Fail closed after rollback failure. */
            }
          }
        }
        active = false;
      }
    }
    const store: TraceStore = {
      upsert: (record) => write([record]),
      upsertBatch: (records, signal) => write(records, signal),
      importRecords: (records, signal) => write(records, signal),
      async importJsonl(jsonl, signal) {
        try {
          if (typeof jsonl !== 'string') return fail('input');
          const lines = jsonl.split('\n');
          const final = lines.pop()!;
          const records: TraceRecord[] = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            const value: unknown = JSON.parse(line);
            if (!validateTrace(value)) return fail('input');
            records.push(value);
          }
          return await write(records, signal, final.length > 0);
        } catch {
          return fail('input');
        }
      },
      read() {
        if (closed) return fail('storage');
        if (active) return fail('busy');
        try {
          return {
            ok: true,
            rows: database
              .prepare('SELECT record_json FROM spans ORDER BY run_id, id')
              .all()
              .map((row) => JSON.parse(row['record_json'] as string) as TraceRecord | WeftRecord),
          };
        } catch (error) {
          return storageFailure(error);
        }
      },
      close() {
        if (active) return fail('busy');
        if (closed) return { ok: true };
        try {
          database.close();
          closed = true;
          return { ok: true };
        } catch (error) {
          return storageFailure(error);
        }
      },
    };
    return { ok: true, store };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* Opening failed; do not expose SQLite messages. */
    }
    return storageFailure(error);
  }
}
