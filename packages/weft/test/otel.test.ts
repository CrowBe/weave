import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportOtlp, createOtlpExporter } from '../src/otel.js';
import type { Redactor } from '@weave/weft';

const keep: Redactor = r => r;
const record = (record_id = 'a', trace_id = 'trace') => ({
  schema: 'weft.record@1', trace_id, record_id,
  emitter: { kind: 'gateway', id: 'gateway' }, sequence: 0,
  kind: 'inference.attempt', thread_id: null, parent_id: null, links: [], evidence: [],
  fields: { request_ref: 'request', routed_unit: 'unit', attempt_no: 0,
    disposition: 'accepted', input_tokens: 7, output_tokens: 2, latency_ms: 1.5 },
});
const json = (records: unknown) => {
  const result = exportOtlp(records, { redact: keep });
  if (!result.ok) assert.fail(result.reason);
  return result.json;
};

test('golden mapping: deterministic ids, point times, parent and cross-thread links', () => {
  const a = record();
  const b = { ...record('b'), sequence: 1, kind: 'thread.transition', thread_id: 'thread-b',
    parent_id: 'a', links: [{ rel: 'handoff', record_id: 'a' }],
    evidence: [{ source: 'external', ref: 'evidence' }], fields: { transition: 'cancelled' } };
  assert.equal(json([b, a]), readFileSync(new URL('../../fixtures/otel-golden.json', import.meta.url), 'utf8').trimEnd());
  assert.equal(json([a, b, a]), json([b, a]));
});

test('malformed, partial, conflicting, sequence-invalid and cyclic batches fail closed', () => {
  const a = record();
  for (const [input, reason] of [
    [null, 'input'], [[null], 'disclosure'], [[{ ...a, fields: {} }], 'disclosure'],
    [[{ ...a, parent_id: 'missing' }], 'incomplete'],
    [[{ ...a, links: [{ rel: 'handoff', record_id: 'missing' }] }], 'incomplete'],
    [[a, { ...a, fields: { ...a.fields, input_tokens: 9 } }], 'conflict'],
    [[a, record('b')], 'sequence'],
    [[{ ...a, parent_id: 'b' }, { ...record('b'), sequence: 1, parent_id: 'a' }], 'parent_cycle'],
  ] as const) assert.deepEqual(exportOtlp(input, { redact: keep }), { ok: false, reason });
  assert.deepEqual(exportOtlp([a], { redact: () => { throw Error('secret'); } }), { ok: false, reason: 'disclosure' });
});

test('W4 canaries: environment, credential strings and single-use grants never cross export', () => {
  const canary = 'ENV-CANARY-032';
  process.env['WEFT_OTEL_CANARY'] = canary;
  try {
    assert.ok(!json([record()]).includes(canary));
    for (const patch of [{ record_id: 'sk-secret' }, { grant: { token: canary } },
      { fields: { ...record().fields, grant: canary } },
      { fields: { ...record().fields, request_ref: 'ghp_secret' } }]) {
      assert.deepEqual(exportOtlp([{ ...record(), ...patch }], { redact: keep }), { ok: false, reason: 'disclosure' });
    }
    const raw = { ...record(), fields: { ...record().fields, request_ref: canary } };
    const result = exportOtlp([raw], { redact: r => ({ ...r, fields: { ...r.fields, request_ref: 'redacted' } }) });
    assert.ok(result.ok && !result.json.includes(canary));
  } finally { delete process.env['WEFT_OTEL_CANARY']; }
});

test('one-way writes contain sync throws and async rejections; interleaved traces and crash retry are isolated', async () => {
  for (const write of [() => { throw Error('failure'); }, async () => { throw Error('failure'); }]) {
    assert.deepEqual(await createOtlpExporter({ redact: keep, write }).export([record()]), { ok: false, reason: 'write' });
  }
  const writes: string[] = [];
  const exporter = createOtlpExporter({ redact: keep, write: async (s: string) => { await Promise.resolve(); writes.push(s); } });
  const inputs = [[record('a', 'one')], [record('a', 'two')]];
  await Promise.all(inputs.map(r => exporter.export(r)));
  assert.deepEqual(writes, inputs.map(json));
  assert.ok(!writes[0]!.includes('two'));
  const crashed = createOtlpExporter({ redact: keep, write: () => { throw Error(); } });
  await crashed.export(inputs[0]);
  assert.equal(json(inputs[0]), writes[0]);
  let called = false;
  await createOtlpExporter({ redact: keep, write: () => { called = true; } }).export([{}]);
  assert.equal(called, false);
});
