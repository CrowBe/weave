import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, type Context } from '../src/validate.ts';

interface Fixtures {
  readonly context: Context;
  readonly valid: readonly { readonly name: string; readonly record: unknown }[];
  readonly invalid: readonly { readonly name: string; readonly reason: string; readonly record: unknown }[];
}

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/records.json', import.meta.url), 'utf8')) as Fixtures;

for (const { name, record } of fixtures.valid) {
  test(`accepts ${name}`, () => {
    assert.deepEqual(validate(record, fixtures.context), { ok: true });
  });
}

for (const { name, reason, record } of fixtures.invalid) {
  test(`rejects ${name} with ${reason}`, () => {
    assert.deepEqual(validate(record, fixtures.context), { ok: false, reason });
  });
}
