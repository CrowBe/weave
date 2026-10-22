import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportOtlp } from '../src/otel.js';
import { mapOtlp, intakeOtlp, createOtlpListener } from '../src/sqlite-intake.js';
import { openTraceStore } from '../src/sqlite.js';
import type { WeftRecord } from '../src/types.js';
const identity = (r: WeftRecord) => r;
const record: WeftRecord = { schema: 'weft.record@1', trace_id: 'run', record_id: 'r', emitter: { kind: 'external', id: 'source' }, sequence: 0,
  kind: 'error', thread_id: null, parent_id: null, links: [], evidence: [], fields: { code: 'unavailable', retryable: false } };
const generic = { resourceSpans: [{ resource: { attributes: [{ key: 'env', value: { stringValue: 'env-canary-value' } }] }, scopeSpans: [{ spans: [{
  traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', name: 'sk-name-canary',
  startTimeUnixNano: '1234', endTimeUnixNano: '5678', attributes: [{ key: 'secret', value: { stringValue: 'sk-raw-canary' } }], status: { code: 2 },
}] }] }] };
function memory(redact = identity) {
  const result = openTraceStore(':memory:', { redact, redactTrace: r => r });
  assert.ok(result.ok); if (!result.ok) throw new Error('open'); return result.store;
}
test('OTLP pure mapping and SQLite intake roundtrip W6 through the serializer boundary', async () => {
  const exported = exportOtlp([record], { redact: identity }); assert.ok(exported.ok); if (!exported.ok) return;
  const mapped = mapOtlp(JSON.parse(exported.json), { redact: identity });
  assert.deepEqual(mapped, { ok: true, records: [record] });
  const store = memory();
  try {
    assert.deepEqual(await intakeOtlp(JSON.parse(exported.json), store, { redact: identity }), { ok: true, inserted: 1, torn: false });
    assert.deepEqual(await intakeOtlp(JSON.parse(exported.json), store, { redact: identity }), { ok: true, inserted: 0, torn: false });
    assert.deepEqual(store.read(), { ok: true, rows: [record] });
  } finally { store.close(); }
});
test('all W6 kinds including links/evidence and structured fields survive intake', () => {
  const exported = JSON.parse(readFileSync(new URL('../../fixtures/otel-all-kinds.json', import.meta.url), 'utf8'));
  const result = mapOtlp(exported, { redact: identity }); assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.records.length, 13);
    assert.equal(new Set(result.records.map(r => r.kind)).size, 13);
    const cycle = result.records.find(r => r.kind === 'cycle.weighed');
    assert.ok(cycle?.kind === 'cycle.weighed');
    assert.equal(cycle.fields.candidates.find(c => c.eligibility === 'prohibited')?.weight, null);
    assert.equal(result.records[1]!.links.length, 6);
    assert.equal(result.records[0]!.evidence.length, 5);
  }
});
test('generic OTLP keeps only derived identity, parents and status; raw secrets are discarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weft-intake-')); const path = join(dir, 'trace.db');
  const result = openTraceStore(path, { redact: identity, redactTrace: r => r }); assert.ok(result.ok); if (!result.ok) return;
  try {
    assert.ok((await intakeOtlp(generic, result.store, { redact: identity })).ok);
    assert.deepEqual(result.store.read(), { ok: true, rows: [{ schema: 'weft.record@1', trace_id: 'otlp:0123456789abcdef0123456789abcdef',
      record_id: 'otlp:0123456789abcdef', emitter: { kind: 'external', id: 'otlp.import' }, sequence: 0,
      kind: 'action.transition', thread_id: null, parent_id: null, links: [], evidence: [],
      fields: { action_ref: 'otlp:0123456789abcdef', operation: 'otlp.span', state: 'failed' } }] });
  } finally { result.store.close(); }
  try { assert.doesNotMatch(readFileSync(path).toString(), /env-canary-value|sk-name-canary|sk-raw-canary/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test('redactor removes environment values; credentials in any field and single-use grants cannot be stored', async () => {
  const envValue = 'private-env-canary';
  const redact = (r: WeftRecord): unknown => ({ ...r, fields: { code: r.kind === 'error' && r.fields.code === envValue ? 'redacted' : (r.fields as { code: string }).code } });
  const store = memory(redact as typeof identity);
  try {
    assert.ok((await store.importRecords([{ ...record, fields: { code: envValue } }])).ok);
    assert.doesNotMatch(JSON.stringify(store.read()), /private-env-canary/);
    assert.deepEqual(await store.importRecords([{ ...record, record_id: 'credential', fields: { code: 'sk-secret' } }]), { ok: false, reason: 'disclosure' });
    assert.deepEqual(await store.importRecords([{ ...record, record_id: 'grant', grant: { token: 'once' } }]), { ok: false, reason: 'disclosure' });
  } finally { store.close(); }
});
test('invalid OTLP rejects atomically and typed failures do not reveal raw data', async () => {
  const store = memory();
  try {
    for (const invalid of [null, {}, { resourceSpans: [{}] }, { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'bad' }] }] }] }]) {
      assert.deepEqual(await intakeOtlp(invalid, store, { redact: identity }), { ok: false, reason: 'input' });
    }
    assert.deepEqual(mapOtlp(generic, { redact: undefined as unknown as typeof identity }), { ok: false, reason: 'config' });
    assert.deepEqual(mapOtlp(generic, { redact: () => { throw new Error('secret'); } }), { ok: false, reason: 'disclosure' });
    assert.deepEqual(store.read(), { ok: true, rows: [] });
    const signal = AbortSignal.abort();
    assert.deepEqual(await intakeOtlp(generic, store, { redact: identity }, signal), { ok: false, reason: 'cancelled' });
  } finally { store.close(); }
});
test('loopback listener is explicit, bounded, and rejects non-loopback before creating a server', async () => {
  const store = memory();
  try {
    let created = false;
    assert.deepEqual(await createOtlpListener({ store, redact: identity, host: '0.0.0.0', createServer: listener => { created = true; return createServer(listener); } }), { ok: false, reason: 'config' });
    assert.equal(created, false);
    const listener = await createOtlpListener({ store, redact: identity, createServer, maxBytes: 4096 }); assert.ok(listener.ok); if (!listener.ok) return;
    try {
      const response = await fetch(`${listener.url}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(generic) });
      assert.equal(response.status, 200); assert.equal(response.headers.get('date'), null);
      assert.equal((await fetch(`${listener.url}/other`)).status, 404);
      assert.equal((await fetch(`${listener.url}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) })).status, 413);
      assert.equal((await fetch(`${listener.url}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    } finally { assert.deepEqual(await listener.close(), { ok: true }); }
  } finally { store.close(); }
});
