import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportOtlp } from '../src/otel.js';
import { validOtlpTrace } from './fixtures/otlp-validator.js';

type FixtureRecord = Record<string, unknown> & { kind: string; fields: Record<string, unknown> };
function allKinds(): FixtureRecord[] {
  const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as {
    valid: { record: FixtureRecord }[];
  };
  const first = new Map<string, FixtureRecord>();
  for (const { record } of fixtures.valid) if (!first.has(record.kind)) first.set(record.kind, record);
  return [...first.values()].map((record, i) => ({
    ...record,
    trace_id: 'all-kinds',
    record_id: `kind-${i}`,
    sequence: i,
    emitter: { kind: 'external', id: 'all-kinds-emitter' },
    parent_id: i === 0 ? null : 'kind-0',
    links:
      i === 1
        ? ['caused_by', 'joins', 'supersedes', 'cancels', 'handoff', 'retry_of'].map((rel) => ({
            rel,
            record_id: 'kind-0',
          }))
        : [],
    evidence: ['observation', 'inference_request', 'invocation', 'check', 'external'].map((source) => ({
      source,
      ref: `evidence-${source}`,
    })),
    fields:
      record.kind === 'thread.transition'
        ? { transition: 'cancelled' }
        : record.kind === 'action.transition'
          ? { ...record.fields, state: 'cancelled' }
          : record.fields,
  }));
}

test('all thirteen Weft kinds have an independently specified OTLP golden', () => {
  const input = allKinds();
  assert.equal(input.length, 13);
  // This static golden was calculated independently with Python hashlib and the
  // documented mapping; it was never captured from exportOtlp output.
  const expected = JSON.parse(
    readFileSync(new URL('../../fixtures/otel-all-kinds.json', import.meta.url), 'utf8'),
  ) as unknown;
  assert.equal(validOtlpTrace(expected), true);
  const result = exportOtlp([...input].reverse(), { redact: (record) => record });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(JSON.parse(result.json), expected);
    assert.equal(validOtlpTrace(JSON.parse(result.json)), true);
    assert.deepEqual(exportOtlp(input, { redact: (record) => record }), result);
  }
});
