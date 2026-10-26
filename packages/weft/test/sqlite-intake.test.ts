import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportOtlp } from '../src/otel.js';
import { mapOtlp, intakeOtlp, createOtlpListener } from '../src/sqlite-intake.js';
import { openTraceStore } from '../src/sqlite.js';
import type { WeftRecord } from '../src/types.js';
const identity = (r: WeftRecord) => r;
const record: WeftRecord = {
  schema: 'weft.record@1',
  trace_id: 'run',
  record_id: 'r',
  emitter: { kind: 'external', id: 'source' },
  sequence: 0,
  kind: 'error',
  thread_id: null,
  parent_id: null,
  links: [],
  evidence: [],
  fields: { code: 'unavailable', retryable: false },
};
const generic = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'env', value: { stringValue: 'env-canary-value' } }] },
      scopeSpans: [
        {
          spans: [
            {
              traceId: '0123456789abcdef0123456789abcdef',
              spanId: '0123456789abcdef',
              name: 'sk-name-canary',
              startTimeUnixNano: '1234',
              endTimeUnixNano: '5678',
              attributes: [{ key: 'secret', value: { stringValue: 'sk-raw-canary' } }],
              status: { code: 2 },
            },
          ],
        },
      ],
    },
  ],
};
function memory(redact = identity) {
  const result = openTraceStore(':memory:', { redact, redactTrace: (r) => r });
  assert.ok(result.ok);
  if (!result.ok) throw new Error('open');
  return result.store;
}
test('OTLP pure mapping and SQLite intake roundtrip W6 through the serializer boundary', async () => {
  const exported = exportOtlp([record], { redact: identity });
  assert.ok(exported.ok);
  if (!exported.ok) return;
  const mapped = mapOtlp(JSON.parse(exported.json), { redact: identity });
  assert.deepEqual(mapped, { ok: true, records: [record] });
  const store = memory();
  try {
    assert.deepEqual(await intakeOtlp(JSON.parse(exported.json), store, { redact: identity }), {
      ok: true,
      inserted: 1,
      torn: false,
    });
    assert.deepEqual(await intakeOtlp(JSON.parse(exported.json), store, { redact: identity }), {
      ok: true,
      inserted: 0,
      torn: false,
    });
    assert.deepEqual(store.read(), { ok: true, rows: [record] });
  } finally {
    store.close();
  }
});
test('all W6 kinds including links/evidence and structured fields survive intake', () => {
  const exported = JSON.parse(readFileSync(new URL('../../fixtures/otel-all-kinds.json', import.meta.url), 'utf8'));
  const result = mapOtlp(exported, { redact: identity });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.records.length, 13);
    assert.equal(new Set(result.records.map((r) => r.kind)).size, 13);
    const cycle = result.records.find((r) => r.kind === 'cycle.weighed');
    assert.ok(cycle?.kind === 'cycle.weighed');
    assert.equal(cycle.fields.candidates.find((c) => c.eligibility === 'prohibited')?.weight, null);
    assert.equal(result.records[1]!.links.length, 6);
    assert.equal(result.records[0]!.evidence.length, 5);
  }
});
test('generic OTLP keeps only derived identity, parents and status; raw secrets are discarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weft-intake-'));
  const path = join(dir, 'trace.db');
  const result = openTraceStore(path, { redact: identity, redactTrace: (r) => r });
  assert.ok(result.ok);
  if (!result.ok) return;
  try {
    assert.ok((await intakeOtlp(generic, result.store, { redact: identity })).ok);
    assert.deepEqual(result.store.read(), {
      ok: true,
      rows: [
        {
          schema: 'weft.record@1',
          trace_id: 'otlp:0123456789abcdef0123456789abcdef',
          record_id: 'otlp:0123456789abcdef',
          emitter: { kind: 'external', id: 'otlp.import:0123456789abcdef' },
          sequence: 0,
          kind: 'action.transition',
          thread_id: null,
          parent_id: null,
          links: [],
          evidence: [],
          fields: { action_ref: 'otlp:0123456789abcdef', operation: 'otlp.span', state: 'failed' },
        },
      ],
    });
  } finally {
    result.store.close();
  }
  try {
    assert.doesNotMatch(readFileSync(path).toString(), /env-canary-value|sk-name-canary|sk-raw-canary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('redactor removes environment values; credentials in any field and single-use grants cannot be stored', async () => {
  const envValue = 'private-env-canary';
  const redact = (r: WeftRecord): unknown => ({
    ...r,
    fields: {
      code: r.kind === 'error' && r.fields.code === envValue ? 'redacted' : (r.fields as { code: string }).code,
    },
  });
  const store = memory(redact as typeof identity);
  try {
    assert.ok((await store.importRecords([{ ...record, fields: { code: envValue } }])).ok);
    assert.doesNotMatch(JSON.stringify(store.read()), /private-env-canary/);
    assert.deepEqual(
      await store.importRecords([{ ...record, record_id: 'credential', fields: { code: 'sk-secret' } }]),
      { ok: false, reason: 'disclosure' },
    );
    assert.deepEqual(await store.importRecords([{ ...record, record_id: 'grant', grant: { token: 'once' } }]), {
      ok: false,
      reason: 'disclosure',
    });
  } finally {
    store.close();
  }
});
test('invalid OTLP rejects atomically and typed failures do not reveal raw data', async () => {
  const store = memory();
  try {
    for (const invalid of [
      null,
      {},
      { resourceSpans: [{}] },
      { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'bad' }] }] }] },
    ]) {
      assert.deepEqual(await intakeOtlp(invalid, store, { redact: identity }), { ok: false, reason: 'input' });
    }
    assert.deepEqual(mapOtlp(generic, { redact: undefined as unknown as typeof identity }), {
      ok: false,
      reason: 'config',
    });
    assert.deepEqual(
      mapOtlp(generic, {
        redact: () => {
          throw new Error('secret');
        },
      }),
      { ok: false, reason: 'disclosure' },
    );
    assert.deepEqual(store.read(), { ok: true, rows: [] });
    const signal = AbortSignal.abort();
    assert.deepEqual(await intakeOtlp(generic, store, { redact: identity }, signal), {
      ok: false,
      reason: 'cancelled',
    });
  } finally {
    store.close();
  }
});
test('loopback listener is explicit, bounded, and rejects non-loopback before creating a server', async () => {
  const store = memory();
  try {
    let created = false;
    assert.deepEqual(
      await createOtlpListener({
        store,
        redact: identity,
        host: '0.0.0.0',
        createServer: (listener) => {
          created = true;
          return createServer(listener);
        },
      }),
      { ok: false, reason: 'config' },
    );
    assert.equal(created, false);
    const listener = await createOtlpListener({ store, redact: identity, createServer, maxBytes: 4096 });
    assert.ok(listener.ok);
    if (!listener.ok) return;
    try {
      const response = await fetch(`${listener.url}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(generic),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('date'), null);
      assert.equal((await fetch(`${listener.url}/other`)).status, 404);
      assert.equal(
        (
          await fetch(`${listener.url}/v1/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'x'.repeat(4097),
          })
        ).status,
        413,
      );
      assert.equal(
        (
          await fetch(`${listener.url}/v1/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{',
          })
        ).status,
        400,
      );
    } finally {
      assert.deepEqual(await listener.close(), { ok: true });
    }
  } finally {
    store.close();
  }
});
test('generic multi-span projection remains a valid Weft batch with no invented cross-span sequence', () => {
  const input = structuredClone(generic);
  const spans = input.resourceSpans[0]!.scopeSpans[0]!.spans;
  spans.push({ ...spans[0]!, spanId: 'fedcba9876543210' });
  const mapped = mapOtlp(input, { redact: identity });
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  assert.ok(exportOtlp(mapped.records, { redact: identity }).ok);
});

test('listener rejects wrong or missing Host and every Origin before importing', async () => {
  let writes = 0;
  const listener = await createOtlpListener({
    createServer,
    redact: identity,
    store: {
      importRecords: async () => {
        writes++;
        return { ok: true, inserted: 0, torn: false };
      },
    },
  });
  assert.ok(listener.ok);
  if (!listener.ok) return;
  const authority = new URL(listener.url).host;
  const post = (headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const req = request(
        listener.url + '/v1/traces',
        { method: 'POST', setHost: false, headers: { 'Content-Type': 'application/json', ...headers } },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode!));
        },
      );
      req.end(JSON.stringify(generic));
    });
  try {
    for (const headers of [
      { Host: 'attacker.example' },
      {},
      { Host: authority, Origin: '' },
      { Host: authority, Origin: listener.url },
      { Host: 'localhost:' + new URL(listener.url).port },
    ]) {
      assert.equal(await post(headers), 403);
    }
    assert.equal(writes, 0);
    assert.equal(await post({ Host: authority }), 200);
    assert.equal(writes, 1);
  } finally {
    await listener.close();
  }
});

test('listener closes a factory server bound outside loopback and returns config', async () => {
  const store = memory();
  const server = createServer();
  const listen = server.listen.bind(server);
  server.listen = ((_port: number, _host: string, callback: () => void) =>
    listen(0, '0.0.0.0', callback)) as typeof server.listen;
  try {
    assert.deepEqual(
      await createOtlpListener({
        createServer: (handler) => {
          server.on('request', handler);
          return server;
        },
        store,
        redact: identity,
      }),
      { ok: false, reason: 'config' },
    );
    assert.equal(server.listening, false);
  } finally {
    if (server.listening) server.close();
    store.close();
  }
});

test('canonical identity survives native import, W6 export and intake with nulls and unordered references', async () => {
  const source: WeftRecord = {
    ...record,
    kind: 'action.transition',
    links: [
      { rel: 'joins', record_id: 'target' },
      { rel: 'caused_by', record_id: 'target' },
    ],
    evidence: [
      { source: 'observation', ref: 'z' },
      { source: 'observation', ref: 'a' },
    ],
    fields: { action_ref: 'action', operation: 'test', state: 'succeeded', contract_rev: null },
  };
  const store = memory();
  try {
    assert.ok((await store.importRecords([{ ...record, record_id: 'target', sequence: 1 }])).ok);
    assert.deepEqual(await store.importRecords([source]), { ok: true, inserted: 1, torn: false });
    const stored = store.read();
    assert.ok(stored.ok);
    if (!stored.ok) return;
    const exported = exportOtlp(stored.rows as WeftRecord[], { redact: identity });
    assert.ok(exported.ok);
    if (!exported.ok) return;
    assert.deepEqual(await intakeOtlp(JSON.parse(exported.json), store, { redact: identity }), {
      ok: true,
      inserted: 0,
      torn: false,
    });
    assert.deepEqual(store.read(), stored);
    assert.deepEqual(await store.importRecords([{ ...source, fields: { ...source.fields, state: 'failed' } }]), {
      ok: false,
      reason: 'conflict',
    });
    assert.deepEqual(store.read(), stored);
  } finally {
    store.close();
  }
});

/** Whether this host can bind the IPv6 loopback; containers without IPv6 cannot. */
function ipv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}
test('listener accepts only the configured authority for IPv6 and localhost bindings', async (t) => {
  const store = memory();
  const hosts = ['localhost'];
  if (await ipv6Loopback()) hosts.unshift('::1');
  else t.diagnostic('::1 skipped: this host has no IPv6 loopback (#283)');
  try {
    for (const host of hosts) {
      const listener = await createOtlpListener({ createServer, store, redact: identity, host });
      assert.ok(listener.ok);
      if (!listener.ok) continue;
      try {
        const response = await fetch(listener.url + '/v1/traces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(generic),
        });
        assert.equal(response.status, 200);
      } finally {
        await listener.close();
      }
    }
  } finally {
    store.close();
  }
});
