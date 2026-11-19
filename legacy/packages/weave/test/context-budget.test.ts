import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { digest } from '../src/digest.js';
import { hasMidValue, payloadBytes } from '../src/log-bound.js';
import { stableStringify } from '../src/stable-json.js';
import { typesafeWireProfile } from '@weave/gateway/typesafe-ai';
import { openRouterAdapter } from '@weave/gateway/open-router';
import {
  alwaysFit,
  rejectEverything,
  requiredFirst,
  trimRequired,
  leakedInvalid,
  demonstrateRed,
  type Answer,
  type Probe,
  type Subject,
} from './context-budget-fixture.js';

function overflow(subject: Subject, input: Probe, reason: string) {
  const result = subject(input);
  assert.equal(result.status, 'overflow');
  assert.equal(result.reason, reason);
  assert.deepEqual(
    {
      ceiling_tokens: result.ceiling_tokens,
      total_tokens: result.total_tokens,
      required_tokens: result.required_tokens,
      over_by_tokens: result.over_by_tokens,
      total_over_by_tokens: result.total_over_by_tokens,
    },
    {
      ceiling_tokens: input.ceiling,
      total_tokens: input.full,
      required_tokens: input.required,
      over_by_tokens: (reason === 'required_exceeds_ceiling' ? input.required : input.full) - input.ceiling,
      total_over_by_tokens: input.full - input.ceiling,
    },
  );
  assert.ok(result.over_by_tokens! > 0 && result.total_over_by_tokens! > 0);
  assert.equal(result.dispatches, 0);
  assert.deepEqual(result.diagnostics, []);
}

test('C1 T1 red: always-fit misses required one-over and exact excess fields', () => {
  demonstrateRed(() => overflow(alwaysFit, { ceiling: 8, full: 10, required: 9 }, 'required_exceeds_ceiling'));
});
test('C1 T1 red: exact equality fits, so reject-everything is invalid', () => {
  demonstrateRed(() => assert.equal(rejectEverything({ ceiling: 8, full: 8, required: 8 }).status, 'fits'));
});
test('C1 T1 red: full input fits before a markers-inclusive required diagnostic', () => {
  demonstrateRed(() =>
    assert.equal(requiredFirst({ ceiling: 8, full: 8, required: 6, markerRequired: 9 }).status, 'fits'),
  );
});
test('C1 T1 red: required-first ordering emits zero/negative total excess', () => {
  demonstrateRed(() => {
    const result = requiredFirst({ ceiling: 8, full: 8, required: 6, markerRequired: 9 });
    assert.ok(result.status === 'fits' || (result.over_by_tokens! > 0 && result.total_over_by_tokens! > 0));
  });
});
const protectedParts = [
  { name: 'instructions', class: 'required', body: 'Keep the entire instruction' },
  { name: 'authority', class: 'required', body: { read: ['ref:authorized'] } },
  { name: 'audit', class: 'required', body: ['all selected audit material'] },
  { name: 'artifact', class: 'optional', body: { complete: '界😀' } },
];
test('C1 T2 red: optional one-over refuses total and never trims protected bodies', () => {
  demonstrateRed(() =>
    overflow(
      alwaysFit,
      {
        ceiling: 8,
        full: 9,
        required: 8,
        parts: protectedParts,
      },
      'total_exceeds_ceiling',
    ),
  );
});
test('C1 T2 red: fit preserves complete protected bodies and canonical digests', () => {
  demonstrateRed(() => {
    const result = trimRequired({ ceiling: 20, full: 9, required: 8, parts: protectedParts });
    assert.deepEqual(
      result.included,
      protectedParts.map((part) => part.name),
    );
    assert.deepEqual(
      result.bodies,
      protectedParts.map((part) => part.body),
    );
    assert.deepEqual(
      result.bodies?.map(digest),
      protectedParts.map((part) => digest(part.body)),
    );
  });
});
test('C1 T2 future C3 red: oversized omission markers cannot authorize trimming', () => {
  demonstrateRed(() => {
    const result = trimRequired({ ceiling: 8, full: 9, required: 6, markerRequired: 10, mode: 'drop_optional' });
    assert.equal(result.status, 'overflow');
    assert.equal(result.reason, 'unsupported_accounting');
    assert.equal(result.code, 'marker_swap');
  });
});

test('C1 T3 evidence: actual canonical encodings distinguish lone surrogate and replacement', () => {
  assert.equal(payloadBytes('\ud800'), 8);
  assert.equal(payloadBytes('\ufffd'), 5);
  assert.notEqual(digest('\ud800'), digest('\ufffd'));
  const raw = (body: string) => createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
  assert.equal(raw('\ud800'), raw('\ufffd'));
  demonstrateRed(() => assert.notEqual(raw('\ud800'), raw('\ufffd')));
});

test('C1 T3 evidence/red: exact TypeSafe projection wraps escaped CJK/emoji and many long question ids', () => {
  const question = { type: 'boolean' as const, instructions: '"\\\n界😀', criteria: { true: 'yes', false: 'no' } };
  const questions = Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [`long_question_${i}_${'q'.repeat(80)}`, question]),
  );
  const state = {
    slices: Array.from({ length: 24 }, () => ({ text: '', digest: Buffer.from('界😀').toString('base64') })),
  };
  const call = { model: 'pinned-fixture', kind: 'boolean' as const, state, questions, signal: undefined };
  const projected = typesafeWireProfile({ shuffle: false }).toBody(call);
  assert.deepEqual(projected, {
    state,
    model: call.model,
    questions: Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        {
          type: 'noul',
          instructions: question.instructions,
          criteria: question.criteria,
        },
      ]),
    ),
  });
  const leafBytes = 24 * payloadBytes(question.instructions);
  assert.ok(payloadBytes(projected) > leafBytes);
  demonstrateRed(() =>
    overflow(
      alwaysFit,
      {
        ceiling: payloadBytes(projected) - 1,
        full: payloadBytes(projected),
        required: payloadBytes(projected),
      },
      'required_exceeds_ceiling',
    ),
  );
});

test('C1 T3 evidence: TypeSafe sealed permutations are explicit', () => {
  const question = { type: 'choice' as const, instructions: 'choose', criteria: { alpha: 'A', beta: 'B', gamma: 'C' } };
  const call = {
    model: 'pinned-fixture',
    kind: 'choice' as const,
    state: {},
    questions: { q: question },
    signal: undefined,
  };
  const stable = typesafeWireProfile({ shuffle: false }).toBody(call);
  assert.equal(stableStringify(stable), stableStringify(typesafeWireProfile({ shuffle: false }).toBody(call)));
  assert.notEqual(JSON.stringify(stable), JSON.stringify(typesafeWireProfile({ shuffle: () => 0 }).toBody(call)));
});

test('C1 T3 evidence/red: actual OpenAI body includes message envelope, settings and empty-system behavior', async () => {
  const bodies: object[] = [];
  const adapter = openRouterAdapter({
    baseURL: 'https://fixture.invalid',
    apiKey: 'fixture-only',
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as object);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    },
  });
  for (const instructions of ['', ' \n', '"界😀\\']) {
    await adapter.execute({
      model: 'fixture',
      instructions,
      prompt: '',
      settings: { max_output_tokens: 7, temperature: 0 },
      signal: undefined,
    });
    const messages = instructions.trim()
      ? [
          { role: 'system', content: instructions },
          { role: 'user', content: '' },
        ]
      : [{ role: 'user', content: '' }];
    assert.deepEqual(bodies.at(-1), { model: 'fixture', messages, max_tokens: 7, temperature: 0 });
  }
  assert.ok(payloadBytes(bodies[0]) > payloadBytes(''));
  demonstrateRed(() =>
    overflow(
      alwaysFit,
      {
        ceiling: payloadBytes(bodies[0]) - 1,
        full: payloadBytes(bodies[0]),
        required: payloadBytes(bodies[0]),
      },
      'required_exceeds_ceiling',
    ),
  );
});

for (const code of ['coverage', 'tokenizer_revision', 'framing', 'capacity', 'volatile_overlap', 'monotonicity']) {
  test(`C1 T3 red: unsupported accounting ${code} refuses without guessed numbers`, () => {
    demonstrateRed(() =>
      invalid(alwaysFit({ ceiling: 8, full: 1, required: 1, coverage: code }), 'unsupported_accounting', code),
    );
  });
}

function invalid(result: Answer, reason: string, code: string) {
  assert.equal(result.status, 'overflow');
  assert.equal(result.reason, reason);
  assert.equal(result.code, code);
  for (const key of ['ceiling_tokens', 'total_tokens', 'required_tokens', 'over_by_tokens', 'total_over_by_tokens']) {
    assert.equal(Object.hasOwn(result, key), false, `uncomputable ${key} must be absent`);
  }
  assert.equal(result.dispatches, 0);
  assert.deepEqual(result.diagnostics, []);
}

const cyclic: object[] = [];
cyclic.push(cyclic);
let getterCalls = 0;
const accessor = Object.defineProperty({}, 'SECRET-OFFENDING-KEY', {
  enumerable: true,
  get() {
    getterCalls++;
    return 'secret';
  },
});
let hookCalls = 0;
const hook = {
  toJSON() {
    hookCalls++;
    return 'secret';
  },
};
const symbolKey = { [Symbol('SECRET-OFFENDING-KEY')]: 'secret' };
const invalidBodies: [string, unknown][] = [
  ['cycle', cyclic],
  ['bigint', 1n],
  ['undefined', undefined],
  ['function', () => 0],
  ['symbol', symbolKey],
  ['non_finite', NaN],
  ['non_finite', Infinity],
  ['non_finite', -Infinity],
  ['sparse_array', new Array(1)],
  ['accessor', accessor],
  ['unsupported_hook', hook],
  ['custom_prototype', new Date(0)],
  ['lone_surrogate', '\ud800'],
  ['lone_surrogate', { '\ud800': 'SECRET-OFFENDING-KEY' }],
];
for (const [index, [code, body]] of invalidBodies.entries()) {
  test(`C1 T4 red: invalid JSON ${index}/${code} yields a closed text-free witness`, () => {
    demonstrateRed(() => {
      const result = alwaysFit({ ceiling: 8, full: 1, required: 1, body });
      invalid(result, 'invalid_part', code);
      assert.deepEqual(result.witness, { part: 'state', code, position: [] });
      assert.equal(hasMidValue(result.witness), false);
      assert.equal(getterCalls, 0);
      assert.equal(hookCalls, 0);
    });
  });
}
const inventory = ['instructions', 'questions', 'goal', 'authority', 'audit'];
const validParts = inventory.map((name) => ({ name, class: 'required', body: name, path: name, link: name }));
const invalidInventories: [string, Probe][] = [
  [
    'missing_part',
    {
      ceiling: 8,
      full: 1,
      required: 1,
      parts: validParts.filter((part) => part.name !== 'instructions'),
      expected_inventory: inventory,
    },
  ],
  [
    'missing_part',
    {
      ceiling: 8,
      full: 1,
      required: 1,
      parts: validParts.filter((part) => part.name !== 'questions'),
      expected_inventory: inventory,
    },
  ],
  [
    'duplicate_part',
    { ceiling: 8, full: 1, required: 1, parts: [...validParts, validParts[0]!], expected_inventory: inventory },
  ],
  [
    'unknown_part',
    {
      ceiling: 8,
      full: 1,
      required: 1,
      parts: [...validParts, { name: 'rogue', class: 'required', body: 'extra' }],
      expected_inventory: inventory,
    },
  ],
  [
    'unmapped_part',
    {
      ceiling: 8,
      full: 1,
      required: 1,
      parts: validParts.map((part, index) => (index ? part : { ...part, path: 'unmapped.path' })),
      expected_inventory: inventory,
    },
  ],
  [
    'wrong_inventory',
    {
      ceiling: 8,
      full: 1,
      required: 1,
      parts: validParts,
      expected_inventory: inventory,
      expected_bodies: inventory.map(() => 'different original view body'),
    },
  ],
  [
    'protected_class',
    {
      ceiling: 8,
      full: 1,
      required: 1,
      parts: validParts.map((part, index) => (index ? part : { ...part, class: 'optional' })),
      expected_inventory: inventory,
    },
  ],
  [
    'link_mismatch',
    {
      ceiling: 8,
      full: 1,
      required: 1,
      parts: validParts.map((part, index) => (index ? part : { ...part, link: 'wrong manifest index' })),
      expected_inventory: inventory,
    },
  ],
];
for (const [index, [code, input]] of invalidInventories.entries()) {
  test(`C1 T4 red: policy-derived inventory rejects ${index}/${code}`, () => {
    demonstrateRed(() => invalid(alwaysFit(input), 'invalid_part', code));
  });
}
for (const ceiling of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`C1 T4 red: invalid ceiling ${ceiling}`, () => {
    demonstrateRed(() =>
      invalid(
        alwaysFit({ ceiling, full: 1, required: 1 }),
        'invalid_budget',
        ceiling <= 0 ? 'non_positive' : 'unsafe_integer',
      ),
    );
  });
}
test('C1 T4 red: safe operands whose sum overflows are rejected', () => {
  demonstrateRed(() =>
    invalid(
      alwaysFit({ ceiling: 8, full: 1, required: 1, operands: [Number.MAX_SAFE_INTEGER, 1] }),
      'invalid_budget',
      'arithmetic_overflow',
    ),
  );
});
test('C1 T4 red: invalid diagnostics cannot contain values, unsafe numbers or effects', () => {
  demonstrateRed(() =>
    invalid(
      leakedInvalid({ ceiling: 8, full: 1, required: 1, invalid: { reason: 'invalid_part', code: 'lone_surrogate' } }),
      'invalid_part',
      'lone_surrogate',
    ),
  );
});
function nested(depth: number): unknown {
  let body: unknown = null;
  for (let i = 0; i < depth; i++) body = [body];
  return body;
}
for (const max_nodes of [4096, 8192]) {
  test(`C1 T4 red: exactly ${max_nodes} nodes accepts; one over refuses`, () => {
    demonstrateRed(() => {
      const body = Array.from({ length: max_nodes - 1 }, () => null);
      assert.equal(
        alwaysFit({ ceiling: 8, full: 1, required: 1, body, limits: { max_depth: 32, max_nodes } }).status,
        'fits',
      );
      invalid(
        alwaysFit({ ceiling: 8, full: 1, required: 1, body: [...body, null], limits: { max_depth: 32, max_nodes } }),
        'invalid_part',
        'node_limit',
      );
    });
  });
  test(`C1 T4 red: reject-all incorrectly refuses exactly ${max_nodes} nodes`, () => {
    demonstrateRed(() =>
      assert.equal(
        rejectEverything({
          ceiling: 8,
          full: 1,
          required: 1,
          body: Array.from({ length: max_nodes - 1 }, () => null),
          limits: { max_depth: 32, max_nodes },
        }).status,
        'fits',
      ),
    );
  });
}
test('C1 T4 red: depth 32 accepts; depth 33 refuses', () => {
  demonstrateRed(() => {
    assert.equal(
      alwaysFit({ ceiling: 8, full: 1, required: 1, body: nested(32), limits: { max_depth: 32, max_nodes: 4096 } })
        .status,
      'fits',
    );
    invalid(
      alwaysFit({ ceiling: 8, full: 1, required: 1, body: nested(33), limits: { max_depth: 32, max_nodes: 4096 } }),
      'invalid_part',
      'depth_limit',
    );
  });
});
test('C1 T4 red: valid pairs and normalized negative zero cannot be rejected indiscriminately', () => {
  demonstrateRed(() =>
    assert.equal(rejectEverything({ ceiling: 8, full: 1, required: 1, body: ['😀𠀀', -0] }).status, 'fits'),
  );
});
test('C1 T4 witness evidence: ordinals carry no offending key/value text', () => {
  const witness = {
    schema: 'context.rejection-witness@1',
    validator: { id: 'fixture', version: 1, digest: 'a'.repeat(64) },
    part: 'state',
    position: [{ key_ordinal: 0 }],
    code: 'lone_surrogate',
  };
  assert.equal(hasMidValue(witness), false);
  assert.equal(stableStringify(witness).includes('SECRET-OFFENDING-KEY'), false);
  // Runtime admission of context.refused is deliberately deferred to C2c.
});

for (const [name, result, assertion] of [
  [
    'unsafe totals omitted',
    {
      status: 'overflow',
      reason: 'invalid_part',
      code: 'lone_surrogate',
      total_tokens: NaN,
      diagnostics: [],
      dispatches: 0,
    },
    (r: Answer) => assert.equal(Object.hasOwn(r, 'total_tokens'), false),
  ],
  [
    'no dispatch on invalid input',
    { status: 'overflow', reason: 'invalid_part', code: 'lone_surrogate', diagnostics: [], dispatches: 1 },
    (r: Answer) => assert.equal(r.dispatches, 0),
  ],
  [
    'content-free diagnostics',
    {
      status: 'overflow',
      reason: 'invalid_part',
      code: 'lone_surrogate',
      diagnostics: ['SECRET-OFFENDING-KEY'],
      dispatches: 0,
    },
    (r: Answer) => assert.deepEqual(r.diagnostics, []),
  ],
] as const) {
  test(`C1 T4 red: ${name}`, () => demonstrateRed(() => assertion(result)));
}
test('C1 T4 red: witness-only refusal must be accepted before claiming a durable stop', () => {
  const rejectsWitness = () => ({ status: 'unknown_type' });
  demonstrateRed(() => assert.equal(rejectsWitness().status, 'accepted'));
});
