import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  FIELD_DISCLOSURE, KIND_FIELDS, serializeRecord, validateRecord, validateTrace,
  type InlinePolicy, type Redactor, type WeftRecord,
} from '@weave/weft';

/** W4: disclosure classes and the redaction boundary (WEFT-CONTRACT.md, Disclosure). */

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
  evidence: [{ source: 'observation', ref: 'obs:1' }],
  fields: { goal_ref: 'goal-17', statement: { content_class: 'private', digest: sha(TEXT) } },
} as const;

const record = (x: unknown) => x as WeftRecord;
const withStatement = (statement: unknown) => record({ ...goal, fields: { ...goal.fields, statement } });
const withText = (text: unknown, content_class = 'private', digest = typeof text === 'string' ? sha(text) : sha('')) =>
  withStatement({ content_class, digest, text });
const keep: Redactor = r => r;
const policy: InlinePolicy = { trace_id: 'goal-17', classes: ['private'] };
const reason = (value: unknown, inline?: InlinePolicy) => {
  const verdict = validateRecord(value, inline);
  return verdict.ok ? 'ok' : verdict.reason;
};

test('every kind field has one disclosure class, and only content values are content', () => {
  assert.deepEqual(Object.keys(FIELD_DISCLOSURE), Object.keys(KIND_FIELDS));
  const content: string[] = [];
  for (const [kind, fields] of Object.entries(FIELD_DISCLOSURE)) {
    assert.deepEqual(Object.keys(fields), KIND_FIELDS[kind as keyof typeof KIND_FIELDS], kind);
    for (const [field, cls] of Object.entries(fields)) {
      assert.ok(['metric', 'reference', 'content'].includes(cls), `${kind}.${field}: ${cls}`);
      if (cls === 'content') content.push(`${kind}.${field}`);
    }
  }
  assert.deepEqual(content, ['goal.intent.statement']);
  assert.equal(FIELD_DISCLOSURE['inference.attempt'].input_tokens, 'metric');
  assert.equal(FIELD_DISCLOSURE.judgment.confidence, 'metric');
  assert.equal(FIELD_DISCLOSURE.judgment.request_ref, 'reference');
  assert.equal(FIELD_DISCLOSURE['cycle.weighed'].candidates, 'reference');
  assert.equal(FIELD_DISCLOSURE['context.assembled'].slices, 'reference');
});

test('by default content crosses as a class and digest, never as text', () => {
  const line = serializeRecord(record(goal), keep);
  assert.equal(line, `${JSON.stringify(goal)}\n`);
  assert.equal(line.includes(TEXT), false);
});

test('inline text crosses only with an explicit class plus a policy for this trace and class', () => {
  const inline = withText(TEXT);
  assert.equal(reason(inline), 'content');
  assert.throws(() => serializeRecord(inline, keep), /content/);
  assert.throws(() => serializeRecord(inline, keep, { trace_id: 'goal-18', classes: ['private'] }), /content/);
  assert.throws(() => serializeRecord(inline, keep, { trace_id: 'goal-17', classes: ['public', 'non_sensitive', 'sensitive'] }), /content/);
  assert.throws(() => serializeRecord(inline, keep, { trace_id: 'goal-17', classes: [] }), /content/);
  // No explicit class: a policy cannot make up for it.
  assert.throws(() => serializeRecord(withStatement({ digest: sha(TEXT), text: TEXT }), keep, policy), /content/);
  assert.equal(reason(inline, policy), 'ok');
  const line = serializeRecord(inline, keep, policy);
  assert.deepEqual(JSON.parse(line).fields.statement, { content_class: 'private', digest: sha(TEXT), text: TEXT });
});

test('a redactor that drops the text lets the record cross without a policy', () => {
  const dropText: Redactor = r => ({ ...r, fields: { ...r.fields, statement: { content_class: 'private', digest: sha(TEXT) } } });
  assert.equal(serializeRecord(withText(TEXT), dropText), `${JSON.stringify(goal)}\n`);
});

test('secrets are rejected after redaction, in ids and in inline text', () => {
  assert.throws(() => serializeRecord(record({ ...goal, record_id: 'ghp_abc123' }), keep), /id/);
  const renameId: Redactor = r => ({ ...r, record_id: 'r-goal' });
  assert.equal(serializeRecord(record({ ...goal, record_id: 'ghp_abc123' }), renameId), `${JSON.stringify(goal)}\n`);
  for (const secret of [
    'Authorization: Bearer abc123', 'use sk-live-123', 'token=ghp_abc', 'eyJhbGciOi', 'AKIAABCDEF',
    'key AIzaSyD-x', 'xoxb-1-2', 'github_pat_11AB', '-----BEGIN RSA PRIVATE KEY-----\nMIIB',
  ]) {
    assert.equal(reason(withText(secret), policy), 'content', secret);
    assert.throws(() => serializeRecord(withText(secret), keep, policy), /content/, secret);
  }
  const scrub: Redactor = r => {
    const text = 'Authorization: [redacted]';
    return { ...r, fields: { ...r.fields, statement: { content_class: 'private', digest: sha(text), text } } };
  };
  assert.equal(JSON.parse(serializeRecord(withText('Authorization: Bearer abc123'), scrub, policy)).fields.statement.text, 'Authorization: [redacted]');
  // Ordinary words are not credentials (#158).
  assert.equal(reason(withText('Rotate the bearer_x and task_sk rows'), policy), 'ok');
});

test('the credential screen covers the repository markers in ids, content refs and weave.trace@1 ids', () => {
  for (const id of ['AIzaSyabc', 'xoxb-123', 'xoxp-9']) {
    assert.equal(reason({ ...goal, record_id: id }), 'id', id);
    assert.equal(reason(withStatement({ ...goal.fields.statement, ref: id })), 'content', id);
    assert.equal(validateTrace({ schema: 'weave.trace@1', id, parentId: null, run_id: 'run1', kind: 'audit', sequence: 0, payload: {} }), false, id);
  }
});

test('inline text must be well-formed, non-empty and match its digest', () => {
  assert.equal(reason(withText(TEXT, 'private', sha('another text')), policy), 'content');
  assert.equal(reason(withText(''), policy), 'content');
  assert.equal(reason(withText('lone \uD800 surrogate'), policy), 'content');
  assert.equal(reason(withText('lone \uDC00 low surrogate'), policy), 'content');
  assert.equal(reason(withText('Ship it \u{1F680}'), policy), 'ok');
  assert.equal(reason(withText(42), policy), 'content');
  assert.equal(reason(withText(null), policy), 'content');
});

test('a missing redactor fails before anything runs', () => {
  for (const redact of [undefined, null, 'redact', {}]) {
    assert.throws(() => serializeRecord(record(goal), redact as unknown as Redactor), /redactor/i);
  }
});

test('a redactor that returns an invalid record or throws serializes nothing', () => {
  for (const out of [undefined, null, 'line', [], {}, { ...goal, extra: 1 }, { ...goal, fields: { ...goal.fields, note: 'x' } }, { ...goal, schema: 'weave.trace@1' }]) {
    assert.throws(() => serializeRecord(record(goal), () => out), /Invalid Weft record/);
  }
  assert.throws(() => serializeRecord(record(goal), () => { throw new Error('redactor failed'); }), /redactor failed/);
});

test('the serializer writes exactly the redactor output it validated, read once', () => {
  let reads = 0;
  const shifting: Redactor = r => Object.defineProperty({ ...r }, 'record_id', { enumerable: true, get: () => `r-${(reads += 1)}` });
  assert.equal(JSON.parse(serializeRecord(record(goal), shifting)).record_id, 'r-1');
  assert.equal(reads, 1);
});

test('an unknown class fails closed in a content value and in a policy', () => {
  assert.equal(reason(withStatement({ ...goal.fields.statement, content_class: 'secret' })), 'content');
  assert.throws(() => serializeRecord(withStatement({ ...goal.fields.statement, content_class: 'secret' }), keep), /content/);
  let calls = 0;
  const counting: Redactor = r => { calls += 1; return r; };
  for (const bad of [
    { trace_id: 'goal-17', classes: ['secret'] },
    { trace_id: 'goal-17', classes: 'private' },
    { trace_id: 'goal-17' },
    { trace_id: 'goal-17', classes: ['private'], fields: ['statement'] },
    { trace_id: 'sk-live-1', classes: ['private'] },
    null,
  ]) {
    assert.throws(() => validateRecord(goal, bad as unknown as InlinePolicy), /inline content policy/, JSON.stringify(bad));
    assert.throws(() => serializeRecord(withText(TEXT), counting, bad as unknown as InlinePolicy), /inline content policy/, JSON.stringify(bad));
  }
  assert.equal(calls, 0);
});

/** Reverse every object's key order, deeply. */
const reversed = (x: unknown): unknown => Array.isArray(x)
  ? x.map(reversed)
  : typeof x === 'object' && x !== null
    ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reversed(v)]))
    : x;

test('serialization writes every key in contract order, whatever order the redactor returns', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as {
    readonly valid: readonly { readonly name: string; readonly record: WeftRecord }[];
  };
  for (const { name, record: r } of fixtures.valid) {
    const line = serializeRecord(r, keep);
    assert.equal(line, `${JSON.stringify(r)}\n`, name);
    assert.equal(serializeRecord(r, x => reversed(x)), line, name);
  }
  assert.equal(serializeRecord(withText(TEXT), x => reversed(x), policy), serializeRecord(withText(TEXT), keep, policy));
});
