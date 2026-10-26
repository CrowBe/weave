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

// #244: the implementation step's check-tail screen carries the same markers.
// It omits only the token-start guard, so it drops at least what they drop.
test('the implementation step check-tail screen uses the shared credential markers', () => {
  const read = (path) => {
    const source = readFileSync(new URL(`../../packages/${path}`, import.meta.url), 'utf8');
    const match = /const CREDENTIAL\s*=\s*(\/[^\r\n]+\/[a-z]*);/.exec(source);
    assert.ok(match, `Missing credential expression in ${path}`);
    return match[1];
  };
  const shared = read('gateway/src/privacy.ts');
  const guard = '(?<![A-Za-z0-9])';
  assert.ok(shared.startsWith(`/${guard}(?:`), shared);
  assert.equal(read('weave/src/implement-step.ts'), `/${shared.slice(1 + guard.length)}`);
});
