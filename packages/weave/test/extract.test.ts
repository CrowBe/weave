import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExtractSchema,
  gateExtract,
  parseExtract,
  validExtractObservation,
  type ExtractSchema,
  type ExtractSlotSpec,
} from '../src/sites/extract.js';

const choice = (options: string[], none: string | null = 'none'): ExtractSlotSpec => ({
  kind: 'choice',
  required: true,
  instructions: 'which thread?',
  options,
  none,
});
const span = (required = false): ExtractSlotSpec => ({
  kind: 'span',
  required,
  instructions: 'the request',
});
const schema = assertExtractSchema({
  id: 'test.message@1',
  slots: { thread_ref: choice(['T1', 'T2']), request: span() },
});
const MESSAGE = 'Please continue thread T2 with the invoice reconciliation.';

function parse(text: string) {
  return parseExtract(text, schema);
}
function gate(answer: unknown, attempt: 1 | 2 = 1, message = MESSAGE) {
  return gateExtract(schema, message, answer as never, { attempt, request_id: `r:x${attempt}`, state_revision: 1 });
}
function slot(observation: ReturnType<typeof gate>, name: string) {
  const found = observation.slots.find((item) => item.slot === name);
  assert.ok(found, name);
  return found;
}

test('parseExtract rejects every shape outside the schema with invalid_extract', () => {
  for (const text of [
    'not json',
    '{}',
    '{"thread_ref":{"value":"T1","cue":"T2"}}',
    '{"thread_ref":{"value":"T1","cue":"T2"},"request":{"value":null},"extra":{"value":null}}',
    '{"thread_ref":{"value":"T1","cue":"T2","extra":1},"request":{"value":null}}',
    '{"thread_ref":{"value":1,"cue":null},"request":{"value":null}}',
    '{"thread_ref":{"value":null,"cue":null},"request":{"value":["a"]}}',
    '{"thread_ref":"T1","request":{"value":null}}',
    '[]',
  ]) {
    const result = parse(text);
    assert.equal(result.status, 'rejected', text);
    if (result.status === 'rejected') assert.equal(result.reason, 'invalid_extract', text);
  }
  const accepted = parse('{"thread_ref":{"value":"T1","cue":"T2"},"request":{"value":null}}');
  assert.equal(accepted.status, 'accepted');
});

test('span grounding is exact UTF-16 substring matching with offsets', () => {
  const exact = gate({ thread_ref: { value: null, cue: null }, request: { value: 'invoice reconciliation' } });
  assert.deepEqual(slot(exact, 'request'), {
    slot: 'request',
    kind: 'span',
    status: 'grounded',
    value: null,
    span: [MESSAGE.indexOf('invoice reconciliation'), MESSAGE.indexOf('invoice reconciliation') + 22],
  });
  for (const value of [
    'invoice reconciliatioN',
    'Invoice reconciliation',
    'invoice reconciliation ',
    ' invoice reconciliation ',
    '',
  ]) {
    const result = gate({ thread_ref: { value: null, cue: null }, request: { value } });
    assert.equal(slot(result, 'request').status, 'ungrounded', value);
    assert.equal(slot(result, 'request').span, null);
  }
  assert.equal(
    slot(gate({ thread_ref: { value: null, cue: null }, request: { value: null } }), 'request').status,
    'empty',
  );
});

test('choice grounding needs an option and a verbatim cue unless it names nothing', () => {
  const grounded = gate({ thread_ref: { value: 'T2', cue: 'T2' }, request: { value: null } });
  assert.deepEqual(slot(grounded, 'thread_ref'), {
    slot: 'thread_ref',
    kind: 'choice',
    status: 'grounded',
    value: 'T2',
    span: [MESSAGE.indexOf('T2'), MESSAGE.indexOf('T2') + 2],
  });
  assert.deepEqual(slot(gate({ thread_ref: { value: 'none', cue: null }, request: { value: null } }), 'thread_ref'), {
    slot: 'thread_ref',
    kind: 'choice',
    status: 'grounded',
    value: 'none',
    span: null,
  });
  assert.equal(
    slot(gate({ thread_ref: { value: 'T9', cue: 'T2' }, request: { value: null } }), 'thread_ref').status,
    'out_of_set',
  );
  for (const cue of [null, '', 'T9']) {
    const result = slot(gate({ thread_ref: { value: 'T2', cue }, request: { value: null } }), 'thread_ref');
    assert.equal(result.status, 'ungrounded', String(cue));
    assert.equal(result.value, null);
  }
  const unresolved = gate({ thread_ref: { value: null, cue: 'thread T2' }, request: { value: null } });
  assert.deepEqual(slot(unresolved, 'thread_ref'), {
    slot: 'thread_ref',
    kind: 'choice',
    status: 'unresolved',
    value: null,
    span: [MESSAGE.indexOf('thread T2'), MESSAGE.indexOf('thread T2') + 9],
  });
  assert.equal(
    slot(gate({ thread_ref: { value: null, cue: null }, request: { value: null } }), 'thread_ref').status,
    'empty',
  );
});

test('verdict and residual ambiguity count required slots that are not grounded', () => {
  const faithful = gate({ thread_ref: { value: 'T2', cue: 'T2' }, request: { value: null } });
  assert.deepEqual([faithful.verdict, faithful.reason], ['use_hints', 'faithful']);
  assert.deepEqual(faithful.residual_ambiguity, { count: 0, slots: [] });
  assert.deepEqual(Object.keys(faithful), [
    'schema',
    'site',
    'extract_schema',
    'request_id',
    'attempt',
    'state_revision',
    'verdict',
    'reason',
    'slots',
    'residual_ambiguity',
    'provider_request_id',
  ]);
  const unresolved = gate({ thread_ref: { value: null, cue: 'thread T2' }, request: { value: null } });
  assert.deepEqual([unresolved.verdict, unresolved.reason], ['use_hints', 'faithful']);
  assert.deepEqual(unresolved.residual_ambiguity, { count: 1, slots: ['thread_ref'] });
  const first = gate({ thread_ref: { value: 'T9', cue: 'T2' }, request: { value: null } }, 1);
  assert.deepEqual([first.verdict, first.reason], ['re_extract', 'unfaithful']);
  const final = gate({ thread_ref: { value: 'T2', cue: 'missing' }, request: { value: null } }, 2);
  assert.deepEqual([final.verdict, final.reason], ['original_only', 'unfaithful']);
});

test('a list kind, empty options, or a credential-shaped option is rejected when built', () => {
  const base = { id: 'bad@1', slots: {} };
  for (const slots of [
    { target: { kind: 'list', required: true, instructions: 'targets' } },
    { thread_ref: choice([]) },
    { thread_ref: choice(['T1', 'sk-secret']) },
    { thread_ref: choice(['T1', 'Bearer abc']) },
  ] as unknown as { readonly [key: string]: ExtractSlotSpec }[]) {
    assert.throws(() => assertExtractSchema({ ...base, slots } as ExtractSchema));
  }
  assert.throws(() =>
    gateExtract({ id: 'bad@1', slots: { target: { kind: 'list' } } } as unknown as ExtractSchema, MESSAGE, null, {
      attempt: 1,
    }),
  );
});

test('stored extract validation shares the live content-free slot contract', () => {
  for (const thread_ref of [
    { value: 'T2', cue: 'T2' },
    { value: 'none', cue: null },
    { value: null, cue: null },
    { value: null, cue: 'thread T2' },
    { value: 'T9', cue: 'T2' },
    { value: 'T2', cue: 'absent' },
  ]) {
    for (const request of [{ value: null }, { value: 'invoice' }, { value: 'absent' }])
      for (const attempt of [1, 2] as const)
        assert.equal(validExtractObservation(gate({ thread_ref, request }, attempt), schema, MESSAGE), true);
  }
  assert.equal(validExtractObservation(gate(null), schema, MESSAGE), true);
  const live = gate({ thread_ref: { value: 'T2', cue: 'T2' }, request: { value: 'invoice' } });
  const mutations: readonly ((x: any) => void)[] = [
    (x) => {
      x.extra = 'CANARY-msg';
    },
    (x) => {
      delete x.provider_request_id;
    },
    (x) => {
      x.slots[1].value = 'CANARY-msg';
    },
    (x) => {
      x.slots[0].value = 'outside';
    },
    (x) => {
      x.slots.reverse();
    },
    (x) => {
      x.slots[0].kind = 'span';
    },
    (x) => {
      x.slots[0].status = 'CANARY-msg';
    },
    (x) => {
      x.slots[0].extra = 'CANARY-msg';
    },
    (x) => {
      x.verdict = 'CANARY-msg';
    },
    (x) => {
      x.reason = 'CANARY-msg';
    },
    (x) => {
      x.residual_ambiguity.extra = 'CANARY-msg';
    },
    (x) => {
      x.residual_ambiguity = { count: 1, slots: ['thread_ref'] };
    },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(live);
    mutate(forged);
    assert.equal(validExtractObservation(forged, schema, MESSAGE), false);
  }
  for (const bounds of [[-1, 2], [0, MESSAGE.length + 1], [0.5, 2], [2, 1], [1, 1], [0, 1, 2], ['0', 1], null]) {
    const forged = structuredClone(live);
    Object.assign(forged.slots[1]!, { span: bounds });
    assert.equal(validExtractObservation(forged, schema, MESSAGE), false);
  }
});
