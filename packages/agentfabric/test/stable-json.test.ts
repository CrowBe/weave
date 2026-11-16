import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkHeldOutRetained, type TestCase } from '@weave/agentsop';
import { stableStringify } from '../src/stable-json.js';

describe('stableStringify', () => {
  it('keeps an own __proto__ key and sorts its nested keys', () => {
    const parsed = JSON.parse('{"__proto__":{"b":2,"a":1}}');
    assert.equal(stableStringify(parsed), '{"__proto__":{"a":1,"b":2}}');
    assert.notEqual(stableStringify(parsed), stableStringify({}));
  });

  it('keeps an own __proto__ key nested in arrays and objects', () => {
    assert.equal(stableStringify(JSON.parse('[{"__proto__":{"b":2,"a":1}}]')), '[{"__proto__":{"a":1,"b":2}}]');
    assert.equal(
      stableStringify(JSON.parse('{"z":{"__proto__":{"b":2,"a":1}},"a":1}')),
      '{"a":1,"z":{"__proto__":{"a":1,"b":2}}}',
    );
  });

  it('canonicalizes ordinary values with sorted keys and no whitespace', () => {
    assert.equal(stableStringify({ b: 1, a: { d: 4, c: undefined } }), '{"a":{"d":4},"b":1}');
    assert.equal(stableStringify([1, undefined, { b: 2, a: 1 }]), '[1,null,{"a":1,"b":2}]');
    assert.equal(stableStringify({}), '{}');
  });
});

describe('corpus canonical order', () => {
  it('keeps an own __proto__ key in held-out identity', () => {
    const prior: TestCase = {
      id: 'proto',
      split: 'held_out',
      input: { n: 1 },
      expected: { kind: 'output', output: JSON.parse('{"__proto__":{"b":2,"a":1}}') },
    };
    const retained = checkHeldOutRetained([prior], [prior]);
    assert.deepEqual(retained, { ok: true });
    const rewritten = checkHeldOutRetained(
      [prior],
      [{ id: prior.id, split: prior.split, input: prior.input, expected: { kind: 'output', output: {} } }],
    );
    assert.equal(rewritten.ok, false);
    if (!rewritten.ok) assert.match(rewritten.reason, /cannot be rewritten/);
  });
});
