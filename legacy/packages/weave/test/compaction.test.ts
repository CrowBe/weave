import test from 'node:test';
import assert from 'node:assert/strict';
import { compactContext } from '../src/compaction.js';

const tokens = Array.from({ length: 80 }, (_, index) => `token ${index}\n`);
test('compaction triggers at 80%, retains last 5% exactly and caps summary at 10%', async () => {
  let prefix: readonly string[] = [];
  const result = await compactContext(tokens, 100, async (input, cap) => {
    prefix = input;
    assert.equal(cap, 10);
    return ['summary'];
  });
  assert.equal(result.status, 'compacted');
  assert.deepEqual(prefix, tokens.slice(0, 75));
  assert.deepEqual(result.tail, tokens.slice(-5));
  assert.deepEqual(result.tokens, ['summary', ...tokens.slice(-5)]);
});
test('below threshold leaves original context and never summarizes', async () => {
  const input = tokens.slice(0, 79);
  const result = await compactContext(input, 100, async () => {
    throw new Error('unexpected');
  });
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.tokens, input);
});
test('without summarizer reports pending work and preserves original tokens', async () => {
  const result = await compactContext(tokens, 100);
  assert.equal(result.status, 'summary_needed');
  assert.deepEqual(result.tokens, tokens);
  assert.deepEqual(result.tail, tokens.slice(-5));
});
test('oversized summary fails without publishing replacement context', async () => {
  await assert.rejects(
    compactContext(tokens, 100, async () => Array(11).fill('x')),
    /summary exceeds/,
  );
});
