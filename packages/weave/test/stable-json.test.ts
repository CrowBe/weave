import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
