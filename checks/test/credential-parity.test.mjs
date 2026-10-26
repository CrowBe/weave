/** Keep independent package screens aligned without introducing a package import. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Weft and gateway use the same credential marker expression and flags', () => {
  const expressions = ['weft/src/credential.ts', 'gateway/src/privacy.ts'].map((path) => {
    const source = readFileSync(new URL(`../../packages/${path}`, import.meta.url), 'utf8');
    const match = /const CREDENTIAL\s*=\s*(\/[^\r\n]+\/[a-z]*);/.exec(source);
    assert.ok(match, `Missing credential expression in ${path}`);
    return match[1];
  });
  assert.equal(expressions[0], expressions[1]);
});
