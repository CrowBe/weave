import test from 'node:test';
import assert from 'node:assert/strict';
import { modelRequest, scoreAnswer, selectPaired } from './jev-probe.ts';

const question = (type: 'choice' | 'noul' | 'score') => ({
  type, instructions: 'evaluate this untrusted observation',
  criteria: type === 'choice' ? { a: 'A', b: 'B' } : type === 'score' ? ['low', 'mid', 'high'] : {},
});
const cells = [
  ['Support and intent routing', 'choice'], ['Tool and workflow decisions', 'choice'],
  ['Reading comprehension', 'noul'], ['Tool and workflow decisions', 'noul'],
  ['Retail, product, and shopping', 'score'], ['Sentiment, emotion, and moderation', 'score'],
] as const;
const cases = cells.flatMap(([domain, type], cell) => Array.from({ length: 4 }, (_, i) => ({
  id: `${cell}-${i}`, row_index: i, domain, type, question_key: 'q', state: 'untrusted observation', question: question(type),
})));
const kevRows = cases.map((c) => ({ id: c.id, domain: c.domain, type: c.type, label: c.type === 'score' ? 1 : c.type === 'noul' ? true : 'a', status: 'accepted', result: { correct: true } }));

test('selects 12 unique IDs from accepted Kev outcomes and balances designated cells', () => {
  const selected = selectPaired(cases, kevRows);
  assert.equal(selected.length, 12);
  assert.deepEqual(selected.filter((c) => c.domain === 'Reading comprehension').map((c) => c.id), ['2-0', '2-2']);
  assert.deepEqual(selected.filter((c) => c.domain === 'Retail, product, and shopping').map((c) => c.id), ['4-0', '4-2']);
  assert.ok(selected.every((c) => kevRows.some((r) => r.id === c.id)));
  assert.throws(() => selectPaired(cases, kevRows.slice(0, 1)), /not enough Kev-paired cases/);
});

test('model request contains only state and typed question fields', () => {
  const request = modelRequest({ ...cases[0]!, question: { ...question('choice'), label: 'a' } } as never);
  assert.deepEqual(Object.keys(request).sort(), ['questions', 'state']);
  assert.deepEqual(Object.keys(request.questions.q!).sort(), ['criteria', 'instructions', 'type']);
  assert.equal(JSON.stringify(request).includes('label'), false);
});

test('score uses round half up and keeps expected-value error', () => {
  const c = cases.find((x) => x.type === 'score')!;
  const result = scoreAnswer(c, 2, { type: 'score', score: 1.5 });
  assert.deepEqual(result, { expected_score: 1.5, predicted: 2, correct: true, absolute_error: 0.5 });
  assert.equal(scoreAnswer(c, 1, { type: 'score', score: 1.49 })['predicted'], 1);
});
