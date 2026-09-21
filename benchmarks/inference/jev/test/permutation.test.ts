/**
 * Boundary tests for presentation order.
 *
 * The load-bearing test is the position-locked stub: a predictor that always
 * names whatever is printed first must fail the stability and bias checks by
 * construction, whatever its accuracy. If it can pass, the metric is measuring
 * nothing and the run that uses it proves nothing.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CORPUS } from '../corpus.ts';
import { applyOrdering, orderingsFor, scorePermutation } from '../permutation.ts';
import type { PermutationRecordView } from '../permutation.ts';

const ORDERINGS = 4;
const SEED = 20260921;

function views(pick: (presented: readonly string[], label: string) => string): PermutationRecordView[] {
  const out: PermutationRecordView[] = [];
  for (const decision of CORPUS) {
    const orders = orderingsFor(decision.candidates.length, ORDERINGS, SEED);
    orders.forEach((order, index) => {
      const presented = applyOrdering(decision, order).candidates.map((c) => c.candidate_id);
      out.push({
        case_id: decision.id,
        ordering_index: index,
        presented,
        label: decision.label,
        predicted: pick(presented, decision.label),
      });
    });
  }
  return out;
}

test('orderings are distinct, and start with identity then reverse', () => {
  const orders = orderingsFor(4, 4, SEED);
  assert.equal(orders.length, 4);
  assert.deepEqual(orders[0], [0, 1, 2, 3]);
  assert.deepEqual(orders[1], [3, 2, 1, 0]);
  const keys = new Set(orders.map((o) => o.join(',')));
  assert.equal(keys.size, 4, 'orderings must be distinct');
});

test('orderings clamp to the permutations that exist', () => {
  assert.equal(orderingsFor(2, 4, SEED).length, 2);
  assert.equal(orderingsFor(1, 4, SEED).length, 1);
  assert.equal(orderingsFor(0, 4, SEED).length, 0);
});

test('orderings are deterministic for a seed', () => {
  assert.deepEqual(orderingsFor(5, 5, SEED), orderingsFor(5, 5, SEED));
});

test('applying an ordering permutes candidates and changes nothing else', () => {
  const decision = CORPUS[0]!;
  const permuted = applyOrdering(decision, [...orderingsFor(decision.candidates.length, 2, SEED)[1]!]);
  assert.equal(permuted.label, decision.label, 'label is a candidate id, not a position');
  assert.equal(permuted.id, decision.id);
  assert.deepEqual(permuted.state, decision.state);
  assert.deepEqual(
    [...permuted.candidates].map((c) => c.candidate_id).sort(),
    [...decision.candidates].map((c) => c.candidate_id).sort(),
    'the same candidates, reordered',
  );
  assert.notDeepEqual(
    permuted.candidates.map((c) => c.candidate_id),
    decision.candidates.map((c) => c.candidate_id),
  );
});

test('a state-reading predictor is perfectly stable and unbiased by position', () => {
  const report = scorePermutation(views((_presented, label) => label));
  assert.equal(report.stability_rate, 1, 'the same candidate is named wherever it is printed');
  assert.equal(report.worst_ordering_accuracy, 1);
  assert.equal(report.position_bias, 0, 'chosen position tracks label position exactly');
});

test('a position-locked predictor is caught: stability collapses and bias is high', () => {
  const report = scorePermutation(views((presented) => presented[0]!));

  assert.ok(
    report.stability_rate < 0.5,
    `a first-position stub must not look stable under permutation, got ${report.stability_rate}`,
  );
  assert.ok(
    report.position_bias > 0.5,
    `a first-position stub must show position bias, got ${report.position_bias}`,
  );
  assert.equal(report.chosen_position[0], report.chosen_position.reduce((a, b) => a + b, 0),
    'every selection sat at position 0');
});

test('position bias is independent of accuracy', () => {
  // A stub locked to the last position is just as biased, and scores differently.
  const locked = scorePermutation(views((presented) => presented[presented.length - 1]!));
  assert.ok(locked.position_bias > 0.5, 'last-position lock is equally a bias');
  assert.ok(locked.stability_rate < 0.5);
});

test('stability alone does not certify a predictor; the repeat-only case is the trap', () => {
  // One ordering per case is what repeating an identical prompt measures.
  // A position-locked stub is trivially consistent under that view, so the
  // report must decline to call it stable rather than score it 1.0.
  const single = views((presented) => presented[0]!).filter((v) => v.ordering_index === 0);
  const report = scorePermutation(single);
  assert.equal(report.orderings_seen, 1);
  assert.equal(report.permuted, 0, 'nothing was presented two ways, so nothing was measured');
  assert.equal(report.stability_rate, 0, 'absence of evidence must not read as a perfect score');
});

test('permuting a choice question reorders options without losing or altering any', async () => {
  const { permuteChoiceQuestion, optionKeys } = await import('../transfer.ts');
  const question = {
    type: 'choice' as const,
    instructions: 'pick one',
    criteria: { a: 'first', b: 'second', c: 'third', d: 'fourth' },
  };
  const permuted = permuteChoiceQuestion(question as never, [3, 2, 1, 0]);
  assert.deepEqual(optionKeys(permuted), ['d', 'c', 'b', 'a'], 'presentation order changed');
  assert.deepEqual(
    Object.fromEntries(Object.entries((permuted as { criteria: Record<string, unknown> }).criteria).sort()),
    Object.fromEntries(Object.entries(question.criteria).sort()),
    'the option contents are untouched',
  );
});

test('a short ordering drops no option', async () => {
  const { permuteChoiceQuestion, optionKeys } = await import('../transfer.ts');
  const question = {
    type: 'choice' as const,
    instructions: 'pick one',
    criteria: { a: '1', b: '2', c: '3' },
  };
  const permuted = permuteChoiceQuestion(question as never, [2]);
  assert.deepEqual([...optionKeys(permuted)].sort(), ['a', 'b', 'c'], 'every option survives');
  assert.equal(optionKeys(permuted)[0], 'c', 'the named one leads');
});

test('score and noul questions are returned unchanged', async () => {
  const { permuteChoiceQuestion } = await import('../transfer.ts');
  const score = { type: 'score' as const, instructions: 's', criteria: ['low', 'mid', 'high'] };
  const noul = { type: 'noul' as const, instructions: 'n', criteria: { true: 't', false: 'f' } };
  assert.deepEqual(permuteChoiceQuestion(score as never, [2, 1, 0]), score, 'a scale is not presentational');
  assert.deepEqual(permuteChoiceQuestion(noul as never, [1, 0]), noul, 'fixed wire slots');
});

test('cases asked under one ordering do not count toward stability', () => {
  // The trap in reverse: a corpus mixes permutable and non-permutable cases,
  // and the non-permutable ones are stable by construction. Counting them
  // reports order-stability that was never measured.
  const single: PermutationRecordView[] = [];
  for (let i = 0; i < 9; i += 1) {
    single.push({
      case_id: `fixed${i}`,
      ordering_index: 0,
      presented: ['a'],
      label: 'a',
      predicted: 'a',
    });
  }
  const unstable: PermutationRecordView[] = [
    { case_id: 'moves', ordering_index: 0, presented: ['a', 'b'], label: 'a', predicted: 'a' },
    { case_id: 'moves', ordering_index: 1, presented: ['b', 'a'], label: 'a', predicted: 'b' },
  ];

  const report = scorePermutation([...single, ...unstable]);
  assert.equal(report.permuted, 1, 'only one case was actually presented more than one way');
  assert.equal(report.stable_top, 0);
  assert.equal(
    report.stability_rate,
    0,
    'nine cases that were never permuted must not certify the one that was',
  );
});

test('ordering accuracy compares the same cases, not whatever each ordering held', () => {
  // Ordering 0 carries an extra case the later orderings never saw. If the
  // per-ordering accuracies are taken over whatever each index happens to
  // hold, that one record makes ordering 0 look better than ordering 1.
  const views: PermutationRecordView[] = [
    // present under both orderings, wrong under both — the honest picture
    { case_id: 'hard', ordering_index: 0, presented: ['a', 'b'], label: 'a', predicted: 'b' },
    { case_id: 'hard', ordering_index: 1, presented: ['b', 'a'], label: 'a', predicted: 'b' },
    // only ever asked one way, and easy
    { case_id: 'easy', ordering_index: 0, presented: ['a'], label: 'a', predicted: 'a' },
  ];
  const report = scorePermutation(views);
  assert.equal(report.balanced_cases, 1, 'only `hard` appears under every ordering');
  assert.equal(
    report.worst_ordering_accuracy,
    report.best_ordering_accuracy,
    'the same case answered the same way under both orderings is not a spread',
  );
  assert.equal(report.worst_ordering_accuracy, 0);
});
