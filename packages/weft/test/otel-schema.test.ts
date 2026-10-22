import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportOtlp } from '../src/otel.js';
import { validOtlpTrace } from './fixtures/otlp-validator.js';

const record = {
  schema: 'weft.record@1', trace_id: 'schema-trace', record_id: 'record-1',
  emitter: { kind: 'external', id: 'schema-emitter' }, sequence: 7,
  kind: 'error', thread_id: null, parent_id: null, links: [], evidence: [],
  fields: { code: 'provider_unavailable', retryable: true },
};

test('exported trace validates against the offline OTLP JSON structural subset', () => {
  const result = exportOtlp([record], { redact: (value) => value });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(validOtlpTrace(JSON.parse(result.json)), true);
});

const fixture = () => ({ resourceSpans: [{ resource: { attributes: [{ key: 'weft.trace_id', value: { stringValue: 'schema-trace' } }] }, scopeSpans: [{ scope: { name: '@weave/weft/otel', version: '1' }, spans: [{
  traceId: '1234567890abcdef1234567890abcdef', spanId: '1234567890abcdef', name: 'error', kind: 1,
  startTimeUnixNano: '7', endTimeUnixNano: '7', attributes: [{ key: 'weft.retryable', value: { boolValue: true } }],
  links: [{ traceId: '1234567890abcdef1234567890abcdef', spanId: 'abcdef1234567890', attributes: [] }], status: { code: 2 },
}] }] }] });

test('offline OTLP validator rejects structural mutations independently of exporter', () => {
  assert.equal(validOtlpTrace(fixture()), true);
  const mutations: ((span: Record<string, unknown>) => void)[] = [
    (s) => { s.traceId = 'opaque-weft-id'; },
    (s) => { s.spanId = '0000000000000000'; },
    (s) => { s.parentSpanId = 'short'; },
    (s) => { s.startTimeUnixNano = 7; },
    (s) => { s.endTimeUnixNano = '6'; },
    (s) => { s.startTimeUnixNano = '18446744073709551616'; },
    (s) => { s.attributes = [{ key: 'bad', value: { stringValue: 'x', boolValue: true } }]; },
    (s) => { s.attributes = [{ key: 'bad', value: { intValue: 1 } }]; },
    (s) => { s.attributes = [{ key: 'bad', value: { doubleValue: Infinity } }]; },
    (s) => { s.attributes = [{ key: 'bad', value: { arrayValue: { values: [null] } } }]; },
    (s) => { s.attributes = [{ key: 'bad', value: { kvlistValue: { values: [null] } } }]; },
    (s) => { s.links = [{ traceId: 'bad', spanId: '1234567890abcdef', attributes: [] }]; },
    (s) => { s.status = { code: 99 }; },
    (s) => { s.kind = 'SPAN_KIND_INTERNAL'; },
    (s) => { delete s.name; },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value.resourceSpans[0]!.scopeSpans[0]!.spans[0]!);
    assert.equal(validOtlpTrace(value), false, String(mutate));
  }
  assert.equal(validOtlpTrace({ resourceSpans: null }), false);
  assert.equal(validOtlpTrace({ ...fixture(), unexpected: true }), false);
});

test('offline OTLP validator checks nested AnyValue and protobuf numeric encodings', () => {
  const value = fixture();
  const span: Record<string, unknown> = value.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  span.attributes = [
    { key: 'integer', value: { intValue: '9223372036854775807' } },
    { key: 'number', value: { doubleValue: 1.5 } },
    { key: 'list', value: { arrayValue: { values: [{ boolValue: false }, { stringValue: 'item' }] } } },
    { key: 'object', value: { kvlistValue: { values: [{ key: 'nested', value: { intValue: '-1' } }] } } },
  ];
  assert.equal(validOtlpTrace(value), true);
  span.attributes = [{ key: 'integer', value: { intValue: '9223372036854775808' } }];
  assert.equal(validOtlpTrace(value), false);
  span.attributes = [{ key: 'duplicate', value: { boolValue: false } }, { key: 'duplicate', value: { boolValue: true } }];
  assert.equal(validOtlpTrace(value), false);
});
