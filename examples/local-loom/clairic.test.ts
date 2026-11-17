import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clairicExtractor } from './clairic.ts';

test('native Clairic extraction preserves exact spans and accounts input tokens only', async () => {
  const extract = clairicExtractor({
    run: async (body) => {
      assert.equal(body.model, 'clairic');
      assert.equal(body.fields.operand?.type, 'text');
      return {
        model: 'clairic',
        answers: { operand: { type: 'text', value: ' a   b ', span: [11, 18], confidence: 0.95, p_null: 0.01 } },
        truncated: false,
        usage: { input_tokens: 100, output_tokens: 0, passes: 1 },
      };
    },
  });
  const result = await extract({
    request_id: 'test',
    site: 'local.arguments',
    state: 'Normalize " a   b "',
    fields: { operand: 'Text within quotes.' },
  });
  assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') assert.equal(result.values.operand, ' a   b ');
  assert.equal(result.spent, 10);
});

test('Clairic refuses ungrounded and truncated answers, and never promotes guesses', async () => {
  for (const raw of [
    { answers: { intent: { type: 'text', value: 'invented', span: [0, 3] } }, truncated: false },
    { answers: { intent: { type: 'text', value: 'abc', span: [0, 3] } }, truncated: true },
  ]) {
    const extract = clairicExtractor({ run: async () => ({ ...raw, usage: { input_tokens: 10, output_tokens: 0 } }) });
    const result = await extract({
      request_id: 'test',
      site: 'local.extract',
      state: 'abc',
      fields: { intent: 'Request.' },
    });
    assert.equal(result.status, 'blocked');
  }
  const extract = clairicExtractor({
    run: async () => ({
      answers: { intent: { type: 'text', value: null, guess: 'abc' } },
      truncated: false,
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
  });
  const result = await extract({
    request_id: 'test',
    site: 'local.extract',
    state: 'abc',
    fields: { intent: 'Request.' },
  });
  assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') assert.equal(result.values.intent, null);
});
