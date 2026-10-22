import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serializeTrace, importTraceLines, validateTrace, type TraceRecord } from '@weave/weft';
const record: TraceRecord = {
  schema: 'weave.trace@1',
  id: 'step1',
  parentId: null,
  run_id: 'run1',
  kind: 'audit',
  sequence: 0,
  payload: { spent_micros: 4 },
};
test('trace schema validates fixed fields after mandatory redaction; import is idempotent by identity', async () => {
  const line = serializeTrace(record, (x) => x);
  assert.equal(
    line,
    '{"schema":"weave.trace@1","id":"step1","parentId":null,"run_id":"run1","kind":"audit","sequence":0,"payload":{"spent_micros":4}}\n',
  );
  assert.throws(() => serializeTrace({ ...record, payload: { secret: 'canary' } } as unknown as TraceRecord, (x) => x));
  assert.throws(() => serializeTrace({ ...record, sequence: -1 }, (x) => x));
  const rows = new Map<string, TraceRecord>();
  const port = {
    upsert: async (row: TraceRecord) => {
      rows.set(`${row.run_id}:${row.id}`, row);
    },
  };
  await importTraceLines(line + line, port);
  assert.equal(rows.size, 1);
  await assert.rejects(importTraceLines('{"schema":"unknown"}\n', port));
});
test('trace ids reject token prefixes without rejecting ordinary identifiers', () => {
  for (const id of ['task_1', 'risk-2', 'disk-3', 'mask_4']) assert.equal(validateTrace({ ...record, id }), true);
  for (const id of ['sk-abc', 'run:sk_live', 'x_sk-abc', 'ghp_abc', 'AKIAABC', 'eyJabc'])
    assert.equal(validateTrace({ ...record, id }), false);
});
test('ordinary ids that start with bearer are not credentials; real token markers still are (#158)', () => {
  for (const id of ['bearer_x', 'Bearer-1', 'run:bearer.token', 'bearerish'])
    assert.equal(validateTrace({ ...record, id }), true, id);
  for (const id of ['Bearer abc', 'bearer\tabc', 'x:Bearer abc', 'sk-abc', 'ghp_abc', 'github_pat_abc'])
    assert.equal(validateTrace({ ...record, id }), false, id);
});
// weave.trace@1 JSONL in the form serializeTrace writes. It is a fixture, not live evidence.
const fixture = readFileSync(new URL('../../fixtures/weave-trace-v1.jsonl', import.meta.url), 'utf8');
const memoryPort = () => {
  const rows = new Map<string, TraceRecord>();
  return {
    rows,
    upsert: async (row: TraceRecord) => {
      rows.set(`${row.run_id}\u0000${row.id}`, row);
    },
  };
};
test('weave.trace@1 JSONL imports into Weft idempotently by (run_id, id)', async () => {
  for (const line of fixture.trimEnd().split('\n'))
    assert.equal(
      serializeTrace(JSON.parse(line) as TraceRecord, (x) => x),
      `${line}\n`,
    );
  const port = memoryPort();
  await importTraceLines(fixture, port);
  const first = structuredClone([...port.rows]);
  assert.equal(first.length, 7);
  await importTraceLines(fixture, port);
  await importTraceLines(fixture + fixture, port);
  assert.deepEqual([...port.rows], first);
});
test('a batch with one invalid line imports nothing', async () => {
  const port = memoryPort();
  const lines = fixture.trimEnd().split('\n');
  const bad = JSON.stringify({ ...JSON.parse(lines[2]!), payload: { note: 'raw provider text' } });
  await assert.rejects(
    importTraceLines([...lines.slice(0, 2), bad, ...lines.slice(2)].join('\n'), port),
    /Invalid trace record/,
  );
  await assert.rejects(importTraceLines(`${lines[0]}\nnot json\n`, port), /Invalid trace record/);
  assert.equal(port.rows.size, 0);
});
