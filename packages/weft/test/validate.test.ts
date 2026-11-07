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

test('an uncertain inference attempt is a valid explicit disposition', () => {
  assert.equal(
    reason({
      ...judgment,
      kind: 'inference.attempt',
      thread_id: null,
      fields: { request_ref: 'req-9', routed_unit: 'cli.primary', attempt_no: 1, disposition: 'uncertain' },
    }),
    'ok',
  );
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

/** A decision no site answered: an intake pause before any ask, with an empty Decide-1 trace. */
const decided = {
  ...judgment,
  record_id: 'r-dispatch',
  kind: 'dispatch.decided',
  thread_id: null,
  fields: {
    decision_ref: 'req-9',
    decided_by: 'intake',
    choice: 'ask_user',
    status: 'paused',
    judgments: [],
    facts: [],
    rule: 'decision_unavailable',
    band: 'ask_human',
  },
};
const decidedWith = (extra: object) => ({ ...decided, fields: { ...decided.fields, ...extra } });

test('a dispatch decision no site answered is valid without tier or dispatch ref', () => {
  assert.equal(reason(decided), 'ok');
});

test('a dispatch decision carries its full Decide-1 trace', () => {
  assert.equal(
    reason({
      ...decidedWith({
        decided_by: 'route',
        choice: 'flash',
        status: 'dispatched',
        tier: 'flash',
        dispatch_ref: 'req-9:dispatch',
        judgments: [
          { name: 'clarify', probability: 0.12 },
          { name: 'multi_deliverable', probability: 1 },
          { name: 'reads_before_gen', probability: 0 },
        ],
        facts: [
          { name: 'running_threads', value: 2 },
          { name: 'margin', value: -0.25 },
          { name: 'hint_grounded', value: false },
          { name: 'thread_ref', value: 'thread-4' },
          { name: 'tau_irrev', value: null },
        ],
        rule: 'r3.multi_force_spawn',
        band: 'spawn_subtasks',
      }),
      links: [
        { rel: 'caused_by', record_id: 'loom.dispatch:judgment:req-9:intake' },
        { rel: 'caused_by', record_id: 'loom.dispatch:judgment:req-9:route' },
      ],
    }),
    'ok',
  );
  for (const decided_by of ['intake', 'triage', 'route', 'rule'])
    assert.equal(reason(decidedWith({ decided_by })), 'ok', decided_by);
  for (const status of ['dispatched', 'needs_human', 'paused', 'refused'])
    assert.equal(reason(decidedWith({ status })), 'ok', status);
  for (const tier of ['flash', 'standard', 'strong']) assert.equal(reason(decidedWith({ tier })), 'ok', tier);
  for (const band of ['tool_call', 'spawn_subtasks', 'escalate_gen', 'ask_human'])
    assert.equal(reason(decidedWith({ band })), 'ok', band);
});

test('a dispatch decision without any required field is rejected', () => {
  for (const name of ['decision_ref', 'decided_by', 'choice', 'status', 'judgments', 'facts', 'rule', 'band']) {
    const { [name]: _, ...fields } = decided.fields as Record<string, unknown>;
    assert.equal(reason({ ...decided, fields }), 'field', name);
  }
});

test('dispatch decision ids, codes and closed vocabularies fail closed', () => {
  assert.equal(reason(decidedWith({ decision_ref: 'req 9' })), 'field');
  assert.equal(reason(decidedWith({ decision_ref: 'sk-live123' })), 'field');
  assert.equal(reason(decidedWith({ dispatch_ref: 'ghp_x' })), 'field');
  assert.equal(reason(decidedWith({ dispatch_ref: null })), 'field');
  assert.equal(reason(decidedWith({ decided_by: 'extract' })), 'field');
  assert.equal(reason(decidedWith({ decided_by: 'model' })), 'field');
  assert.equal(reason(decidedWith({ status: 'cancelled' })), 'field');
  assert.equal(reason(decidedWith({ tier: 'decision' })), 'field');
  assert.equal(reason(decidedWith({ band: 'tool' })), 'field');
  assert.equal(reason(decidedWith({ band: 'ASK_HUMAN' })), 'field');
  assert.equal(reason(decidedWith({ choice: 'Implement the change' })), 'field');
  assert.equal(reason(decidedWith({ rule: 'R 3' })), 'field');
  assert.equal(reason(decidedWith({ reason: 'accepted' })), 'field');
});

test('Decide-1 judgments carry a code name and a probability in [0, 1]', () => {
  const judged = (...judgments: unknown[]) => reason(decidedWith({ judgments }));
  assert.equal(judged({ name: 'clarify', probability: 0.5 }), 'ok');
  assert.equal(judged({ name: 'clarify', probability: 1.01 }), 'field');
  assert.equal(judged({ name: 'clarify', probability: -0.01 }), 'field');
  assert.equal(judged({ name: 'clarify', probability: Number.NaN }), 'field');
  assert.equal(judged({ name: 'clarify', probability: '0.5' }), 'field');
  assert.equal(judged({ name: 'clarify', probability: null }), 'field');
  assert.equal(judged({ name: 'clarify' }), 'field');
  assert.equal(judged({ name: 'Clarify?', probability: 0.5 }), 'field');
  assert.equal(judged({ name: 'clarify', probability: 0.5, confidence: 0.9 }), 'field');
  assert.equal(judged({ name: 'clarify', probability: 0.5 }, { name: 'clarify', probability: 0.6 }), 'field');
  assert.equal(judged('clarify'), 'field');
  assert.equal(reason(decidedWith({ judgments: {} })), 'field');
  const many = Array.from({ length: 65 }, (_, i) => ({ name: `j${i}`, probability: 0.5 }));
  assert.equal(reason(decidedWith({ judgments: many })), 'field');
  assert.equal(reason(decidedWith({ judgments: many.slice(0, 64) })), 'ok');
});

test('Decide-1 facts carry a code name and a JSON-safe scalar, never text or structure', () => {
  const fact = (...facts: unknown[]) => reason(decidedWith({ facts }));
  for (const value of [0, -3, 2.5, true, false, null, 'thread-4', 'boolean.task@jev-1.13.0'])
    assert.equal(fact({ name: 'f', value }), 'ok', String(value));
  assert.equal(fact({ name: 'f', value: { nested: 1 } }), 'field');
  assert.equal(fact({ name: 'f', value: [1] }), 'field');
  assert.equal(fact({ name: 'f', value: Number.POSITIVE_INFINITY }), 'field');
  assert.equal(fact({ name: 'f', value: Number.NaN }), 'field');
  assert.equal(fact({ name: 'f', value: 'the operator said stop' }), 'field');
  assert.equal(fact({ name: 'f', value: 'sk-live123' }), 'field');
  assert.equal(fact({ name: 'f', value: '' }), 'field');
  assert.equal(fact({ name: 'f' }), 'field');
  assert.equal(fact({ name: 'F', value: 1 }), 'field');
  assert.equal(fact({ name: 'f', value: 1, note: 'x' }), 'field');
  assert.equal(fact({ name: 'f', value: 1 }, { name: 'f', value: 2 }), 'field');
  const many = Array.from({ length: 65 }, (_, i) => ({ name: `f${i}`, value: i }));
  assert.equal(reason(decidedWith({ facts: many })), 'field');
  assert.equal(reason(decidedWith({ facts: many.slice(0, 64) })), 'ok');
});

test('a dispatch decision follows the envelope rules of every kind', () => {
  assert.equal(reason({ ...decided, evidence: [{ source: 'inference_request', ref: 'req-9:intake' }] }), 'evidence');
  assert.equal(reason({ ...decided, links: [{ rel: 'caused_by', record_id: 'r-dispatch' }] }), 'link');
});

test('every v1 kind lists its fields', () => {
  assert.deepEqual(Object.keys(KIND_FIELDS).sort(), [
    'action.transition',
    'budget',
    'capability.invoked',
    'capability.lifecycle',
    'context.assembled',
    'cycle.weighed',
    'dispatch.decided',
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
  assert.deepEqual(KIND_FIELDS['dispatch.decided'], [
    'decision_ref',
    'decided_by',
    'choice',
    'status',
    'tier',
    'dispatch_ref',
    'judgments',
    'facts',
    'rule',
    'band',
  ]);
});
