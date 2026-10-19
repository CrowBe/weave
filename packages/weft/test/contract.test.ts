import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRecord } from '@weave/weft';

interface Fixtures {
  readonly valid: readonly { readonly name: string; readonly record: unknown }[];
  readonly invalid: readonly { readonly name: string; readonly reason: string; readonly record: unknown }[];
}

// Compiled to dist/test; the fixtures stay at the package root.
const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as Fixtures;

for (const { name, record } of fixtures.valid) {
  test(`accepts ${name}`, () => {
    assert.deepEqual(validateRecord(record), { ok: true });
  });
}

for (const { name, reason, record } of fixtures.invalid) {
  test(`rejects ${name} with ${reason}`, () => {
    assert.deepEqual(validateRecord(record), { ok: false, reason });
  });
}
