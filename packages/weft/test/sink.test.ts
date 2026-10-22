import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWeftSink, serializeRecord, type InlinePolicy, type Redactor, type WeftRecord } from '@weave/weft';

/** W5: Weft's sink for an emission port (WEFT-CONTRACT.md, Emission). */

const sha = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const TEXT = 'Publish the quarterly report';

const goal = {
  schema: 'weft.record@1',
  trace_id: 'goal-17',
  record_id: 'r-goal',
  emitter: { kind: 'loom', id: 'loom.main' },
  sequence: 0,
  kind: 'goal.intent',
  thread_id: null,
  parent_id: null,
  links: [],
  evidence: [{ source: 'observation', ref: 'seq:1' }],
  fields: { goal_ref: 'goal-17', statement: { content_class: 'private', digest: sha(TEXT) } },
} as const;

const keep: Redactor = (r) => r;

test('the sink writes exactly what serializeRecord produces, one line per record', () => {
  const lines: string[] = [];
  const sink = createWeftSink({ redact: keep, write: (line) => void lines.push(line) });
  sink.emit(goal);
  sink.emit({ ...goal, record_id: 'r-goal-2', sequence: 1 });
  assert.equal(sink.rejected, 0);
  assert.deepEqual(lines, [
    serializeRecord(goal as unknown as WeftRecord, keep),
    serializeRecord({ ...goal, record_id: 'r-goal-2', sequence: 1 } as unknown as WeftRecord, keep),
  ]);
});

test('write never sees a record before redaction', () => {
  const lines: string[] = [];
  const sink = createWeftSink({
    redact: (r) => ({ ...r, fields: { ...r.fields, goal_ref: 'goal-opaque' } }),
    write: (line) => void lines.push(line),
  });
  sink.emit(goal);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.includes('"goal_ref":"goal-17"'), false);
  assert.ok(lines[0]!.includes('"goal_ref":"goal-opaque"'));
});

test('invalid records, unredacted credentials, unpermitted text and throwing redactors are counted, not written', () => {
  const lines: string[] = [];
  let redactions = 0;
  const sink = createWeftSink({
    redact: (r) => {
      redactions += 1;
      if (r.record_id === 'r-throws') throw new Error('redactor failed');
      return r;
    },
    write: (line) => void lines.push(line),
  });
  sink.emit({ ...goal, kind: 'unknown.kind' });
  sink.emit({ ...goal, record_id: 'sk-live0123456789abcdef' });
  sink.emit({
    ...goal,
    fields: { ...goal.fields, statement: { content_class: 'private', digest: sha(TEXT), text: TEXT } },
  });
  sink.emit({ ...goal, record_id: 'r-throws' });
  sink.emit('not a record');
  assert.equal(sink.rejected, 5);
  assert.deepEqual(lines, []);
  assert.ok(redactions >= 4);
});

test('inline text is written only under the policy the composition root supplied', () => {
  const lines: string[] = [];
  const policy: InlinePolicy = { trace_id: 'goal-17', classes: ['private'] };
  const sink = createWeftSink({ redact: keep, inline: policy, write: (line) => void lines.push(line) });
  sink.emit({
    ...goal,
    fields: { ...goal.fields, statement: { content_class: 'private', digest: sha(TEXT), text: TEXT } },
  });
  sink.emit({
    ...goal,
    trace_id: 'goal-18',
    fields: { ...goal.fields, statement: { content_class: 'private', digest: sha(TEXT), text: TEXT } },
  });
  assert.equal(lines.length, 1);
  assert.equal(sink.rejected, 1);
});

test('a missing redactor, a missing write or a malformed policy is a configuration error at composition', () => {
  const write = () => {};
  assert.throws(() => createWeftSink({ redact: undefined as unknown as Redactor, write }), TypeError);
  assert.throws(
    () => createWeftSink({ redact: keep, write: undefined as unknown as (line: string) => void }),
    TypeError,
  );
  assert.throws(() =>
    createWeftSink({
      redact: keep,
      write,
      inline: { trace_id: 'goal-17', classes: ['secret'] } as unknown as InlinePolicy,
    }),
  );
});
