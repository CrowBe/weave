import test from 'node:test';
import assert from 'node:assert/strict';
import { KIND_FIELDS, validateRecord } from '@weave/weft';

/** Fail-closed paths the contract fixtures do not exercise. */

const judgment = {
  schema: 'weft.record@1',
  trace_id: 'goal-17',
  record_id: 'r-judgment',
  emitter: { kind: 'loom', id: 'loom.main' },
  sequence: 4,
  kind: 'judgment',
  thread_id: 't1',
  parent_id: null,
  links: [],
  evidence: [{ source: 'observation', ref: 'obs:12' }],
  fields: { site: 'frontier.weigh', request_ref: 'req-9', accepted: true },
};

const goal = {
  ...judgment,
  record_id: 'r-goal',
  kind: 'goal.intent',
  thread_id: null,
  fields: {
    goal_ref: 'goal-17',
    statement: { content_class: 'private', digest: `sha256:${'a'.repeat(64)}` },
  },
};

const reason = (record: unknown) => {
  const verdict = validateRecord(record);
  return verdict.ok ? 'ok' : verdict.reason;
};

test('the base records are valid', () => {
  assert.equal(reason(judgment), 'ok');
  assert.equal(reason(goal), 'ok');
});

test('mistyped envelope values are envelope, not id or sequence', () => {
  assert.equal(reason({ ...judgment, trace_id: 17 }), 'envelope');
  assert.equal(reason({ ...judgment, sequence: '4' }), 'envelope');
  assert.equal(reason({ ...judgment, links: {} }), 'envelope');
  assert.equal(reason({ ...judgment, fields: [] }), 'envelope');
  assert.equal(reason({ ...judgment, emitter: { kind: 'loom', id: 'loom.main', name: 'x' } }), 'envelope');
  assert.equal(reason(null), 'envelope');
});

test('envelope ids, parent and thread ids are screened', () => {
  assert.equal(reason({ ...judgment, parent_id: 'Bearer abc' }), 'id');
  assert.equal(reason({ ...judgment, thread_id: '' }), 'id');
  assert.equal(reason({ ...judgment, emitter: { kind: 'loom', id: 'ghp_x' } }), 'id');
  assert.equal(reason({ ...judgment, record_id: 'x'.repeat(129) }), 'id');
  assert.equal(reason({ ...judgment, record_id: 'boolean.task@jev-1.13.0' }), 'ok');
});

test('an id that starts with bearer is not a credential (#158)', () => {
  assert.equal(reason({ ...judgment, record_id: 'bearer_x' }), 'ok');
  assert.equal(reason({ ...judgment, thread_id: 'Bearer-1' }), 'ok');
  assert.equal(reason({ ...judgment, record_id: 'Bearer abc' }), 'id');
  assert.equal(reason({ ...judgment, record_id: 'run:bearer.token' }), 'ok');
  assert.equal(reason({ ...judgment, record_id: 'bearer_sk-live' }), 'id');
});

test('goal intent must not name a thread', () => {
  assert.equal(reason({ ...goal, thread_id: 't1' }), 'kind');
});

test('a superseded thread needs its supersedes link', () => {
  const superseded = { ...judgment, kind: 'thread.transition', fields: { transition: 'superseded' } };
  assert.equal(reason(superseded), 'link');
  assert.equal(reason({ ...superseded, links: [{ rel: 'joins', record_id: 'r-other' }] }), 'link');
  assert.equal(reason({ ...superseded, links: [{ rel: 'supersedes', record_id: 'r-other' }] }), 'ok');
});

test('link and evidence bounds, shapes and ids fail closed', () => {
  const links = Array.from({ length: 33 }, (_, i) => ({ rel: 'caused_by', record_id: `r-${i}` }));
  assert.equal(reason({ ...judgment, links }), 'link');
  assert.equal(reason({ ...judgment, links: links.slice(0, 32) }), 'ok');
  assert.equal(reason({ ...judgment, links: [{ rel: 'caused_by', record_id: 'r 1' }] }), 'link');
  const evidence = Array.from({ length: 65 }, (_, i) => ({ source: 'observation', ref: `obs:${i}` }));
  assert.equal(reason({ ...judgment, evidence }), 'evidence');
  assert.equal(reason({ ...judgment, evidence: [...judgment.evidence, judgment.evidence[0]] }), 'evidence');
  assert.equal(reason({ ...judgment, evidence: [{ source: 'observation', ref: 'obs:1', note: 'x' }] }), 'evidence');
});

test('content positions accept only a content value', () => {
  const statement = (value: unknown) => ({ ...goal, fields: { ...goal.fields, statement: value } });
  assert.equal(reason(statement({ ...goal.fields.statement, ref: 'blob-1' })), 'ok');
  assert.equal(reason(statement({ ...goal.fields.statement, ref: 'sk-live123' })), 'content');
  assert.equal(reason(statement({ ...goal.fields.statement, content_class: 'secret' })), 'content');
  assert.equal(reason(statement({ ...goal.fields.statement, digest: 'sha256:abc' })), 'content');
  assert.equal(reason(statement(null)), 'content');
  // Content outranks field: a bad statement beside an unknown field reports content.
  assert.equal(reason({ ...goal, fields: { ...goal.fields, statement: 'text', extra: 1 } }), 'content');
});

test('optional fields are typed when present', () => {
  const fields = (extra: object) => ({ ...judgment, fields: { ...judgment.fields, ...extra } });
  assert.equal(reason(fields({ confidence: 0.5, routed_unit: 'jev-1.14.0' })), 'ok');
  assert.equal(reason(fields({ confidence: null })), 'field');
  assert.equal(reason(fields({ confidence: Number.NaN })), 'field');
  assert.equal(reason(fields({ site: 'Frontier' })), 'field');
});

test('every v1 kind lists its fields', () => {
  assert.deepEqual(Object.keys(KIND_FIELDS).sort(), [
    'action.transition',
    'budget',
    'capability.invoked',
    'capability.lifecycle',
    'context.assembled',
    'cycle.weighed',
    'error',
    'goal.intent',
    'inference.attempt',
    'judgment',
    'outcome',
    'route.selected',
    'thread.transition',
  ]);
  assert.deepEqual(KIND_FIELDS.judgment, ['site', 'request_ref', 'accepted', 'confidence', 'routed_unit']);
  assert.deepEqual(KIND_FIELDS['capability.lifecycle'], ['operation', 'implementation', 'event', 'contract_rev']);
});
