import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeTrace, importTraceLines, validateTrace, type TraceRecord } from '@weave/agentsop';
const record: TraceRecord = { schema: 'weave.trace@1', id: 'step1', parentId: null, run_id: 'run1', kind: 'audit', sequence: 0, payload: { spent_micros: 4 } };
test('trace schema validates fixed fields after mandatory redaction; import is idempotent by identity', async () => {
  const line = serializeTrace(record, x => x);
  assert.equal(line, '{"schema":"weave.trace@1","id":"step1","parentId":null,"run_id":"run1","kind":"audit","sequence":0,"payload":{"spent_micros":4}}\n');
  assert.throws(() => serializeTrace({ ...record, payload: { secret: 'canary' } } as unknown as TraceRecord, x => x));
  assert.throws(() => serializeTrace({ ...record, sequence: -1 }, x => x));
  const rows = new Map<string, TraceRecord>();
  const port = { upsert: async (row: TraceRecord) => { rows.set(`${row.run_id}:${row.id}`, row); } };
  await importTraceLines(line + line, port);
  assert.equal(rows.size, 1);
  await assert.rejects(importTraceLines('{"schema":"unknown"}\n', port));
});
test('trace ids reject token prefixes without rejecting ordinary identifiers', () => {
  for (const id of ['task_1', 'risk-2', 'disk-3', 'mask_4']) assert.equal(validateTrace({ ...record, id }), true);
  for (const id of ['sk-abc', 'run:sk_live', 'x_sk-abc', 'ghp_abc', 'AKIAABC', 'eyJabc']) assert.equal(validateTrace({ ...record, id }), false);
});
