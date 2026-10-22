/**
 * W5 acceptance 4 (#187): what the reference stack emits passes
 * `@weave/weft` validation, is redacted before any sink stores it, and never
 * carries goal text, source content, provider messages, environment values or
 * credentials.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWeftSink, validateRecord, type WeftRecord } from '@weave/weft';
import type { WeftPort as FabricPort } from '@weave/agentfabric';
import type { WeftPort as GatewayPort } from '@weave/gateway';
import type { WeftPort as LoomPort } from '@weave/weave';
import { collector, runW5, TRACE_ID, w5World, type Rec } from './w5-fixture.js';

const CANARY = 'sk-w5canary7f3b9c2e4d1a6b8f0e2c4a6b';

const identity = (record: WeftRecord): WeftRecord => record;

describe('W5 records', () => {
  it('W5-T30 every record a concurrent run emits passes validateRecord', async () => {
    const seen = collector();
    await runW5(w5World({ loom: seen.sink, gateway: seen.sink, fabric: seen.sink }));
    assert.ok(seen.records.length > 40);
    const kinds = new Set<string>();
    for (const record of seen.records) {
      assert.deepEqual(validateRecord(record), { ok: true }, `${record.record_id} (${record.kind})`);
      kinds.add(record.kind);
    }
    assert.deepEqual([...kinds].sort(), [
      'action.transition',
      'capability.invoked',
      'capability.lifecycle',
      'cycle.weighed',
      'error',
      'goal.intent',
      'inference.attempt',
      'judgment',
      'outcome',
      'route.selected',
      'thread.transition',
    ]);
  });

  it('W5-T31 Weft\'s sink fits every package\'s port and writes only redacted, validated lines', async () => {
    const lines: string[] = [];
    const seenByRedactor: unknown[] = [];
    const sink = createWeftSink({
      redact: (record) => {
        seenByRedactor.push(record);
        // The composition root's redaction: the goal reference is replaced by an opaque one.
        if (record.kind === 'goal.intent' || record.kind === 'outcome') {
          const fields = record.fields as Record<string, unknown>;
          const key = record.kind === 'goal.intent' ? 'goal_ref' : 'subject_ref';
          return { ...record, fields: { ...fields, [key]: 'goal-redacted' } };
        }
        return record;
      },
      write: (line) => void lines.push(line),
    });
    const loom: LoomPort = { trace_id: TRACE_ID, emitter_id: 'loom.main', emit: sink.emit };
    const gateway: GatewayPort = { trace_id: TRACE_ID, emitter_id: 'gateway.main', emit: sink.emit };
    const fabric: FabricPort = { trace_id: TRACE_ID, emitter_id: 'fabric.host', emit: sink.emit };
    // The ports above type-check Weft's sink against each package's own port type.
    assert.ok(loom.emit === gateway.emit && gateway.emit === fabric.emit);
    await runW5(w5World({ loom: sink.emit, gateway: sink.emit, fabric: sink.emit }));
    assert.equal(sink.rejected, 0);
    assert.equal(lines.length, seenByRedactor.length);
    for (const line of lines) {
      assert.ok(line.endsWith('\n'));
      const parsed = JSON.parse(line) as Rec;
      assert.deepEqual(validateRecord(parsed), { ok: true });
      if (parsed.kind === 'goal.intent') assert.equal(parsed.fields['goal_ref'], 'goal-redacted');
      if (parsed.kind === 'outcome') assert.equal(parsed.fields['subject_ref'], 'goal-redacted');
    }
  });

  it('W5-T32 a record the redactor or validator rejects never reaches write', async () => {
    const lines: string[] = [];
    const sink = createWeftSink({
      // A redactor that leaves a credential-shaped reference in place.
      redact: (record) =>
        record.kind === 'judgment' ? { ...record, fields: { ...record.fields, request_ref: CANARY } } : record,
      write: (line) => void lines.push(line),
    });
    await runW5(w5World({ loom: sink.emit }));
    assert.ok(sink.rejected > 0, 'the credential-shaped request_ref was not rejected');
    assert.equal(lines.some((line) => line.includes(CANARY)), false);
    assert.equal(lines.some((line) => JSON.parse(line).kind === 'judgment'), false);
  });

  it('W5-T33 canary: goal text, source content, provider messages and environment values never enter a record', async () => {
    const previous = process.env['W5_CANARY_SECRET'];
    process.env['W5_CANARY_SECRET'] = CANARY;
    try {
      const raw = collector();
      const lines: string[] = [];
      const sink = createWeftSink({ redact: identity, write: (line) => void lines.push(line) });
      const both = (record: Rec): void => {
        raw.sink(record);
        sink.emit(record);
      };
      const world = w5World({ loom: both, gateway: both, fabric: both }, undefined, CANARY);
      await runW5(world);
      // The canary did reach the run: the goal, the sources and the provider failure carry it.
      assert.ok(world.runtime.state().goal?.purpose.includes(CANARY));
      assert.ok(world.weigher.calls.length >= 2);
      const everything = JSON.stringify(raw.records);
      assert.equal(everything.includes(CANARY), false, 'a record carries the canary');
      assert.equal(everything.includes('provider overloaded'), false, 'a record carries provider text');
      assert.equal(everything.includes('alpha one'), false, 'a record carries source content');
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && value.length >= 16) {
          assert.equal(everything.includes(value), false, `a record carries the value of ${name}`);
        }
      }
      assert.equal(sink.rejected, 0);
      assert.equal(lines.join('').includes(CANARY), false);
    } finally {
      if (previous === undefined) delete process.env['W5_CANARY_SECRET'];
      else process.env['W5_CANARY_SECRET'] = previous;
    }
  });
});
