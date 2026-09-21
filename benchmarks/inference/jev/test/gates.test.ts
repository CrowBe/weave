/**
 * Boundary tests for the two acceptance gates.
 *
 * The load-bearing cases are the degenerate ones: a gate that accepts almost
 * nothing reports a flattering accuracy, and a threshold fitted and tested on
 * the same records reports an upper bound. Both must be visible in the output
 * rather than hidden behind a single number.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fitThreshold, stabilityGate, type OrderedAnswer } from '../gates.ts';

function answer(
  case_id: string,
  predicted: string,
  label: string,
  confidence: number,
): OrderedAnswer {
  return { case_id, predicted, label, confidence };
}

test('a case answered identically under every ordering is accepted', () => {
  const report = stabilityGate([
    answer('a', 'x', 'x', 0.9),
    answer('a', 'x', 'x', 0.9),
    answer('a', 'x', 'x', 0.9),
  ]);
  assert.equal(report.covered, 1);
  assert.equal(report.coverage, 1);
  assert.equal(report.accuracy_covered, 1);
});

test('a case whose answer moves with presentation is deferred', () => {
  const report = stabilityGate([
    answer('a', 'x', 'x', 0.9),
    answer('a', 'y', 'x', 0.9),
  ]);
  assert.equal(report.covered, 0);
  assert.equal(report.coverage, 0);
  assert.equal(report.wrong_caught, 0, 'the first ordering was right, so nothing wrong was caught');
  assert.equal(report.correct_deferred, 1, 'and a correct answer was thrown away');
});

test('the gate reports what it throws away, not just what it keeps', () => {
  const report = stabilityGate([
    // stable and right
    answer('a', 'x', 'x', 0.9),
    answer('a', 'x', 'x', 0.9),
    // unstable, first ordering wrong — this is the case the gate is for
    answer('b', 'y', 'x', 0.9),
    answer('b', 'x', 'x', 0.9),
    // unstable, first ordering right — this is what it costs
    answer('c', 'x', 'x', 0.9),
    answer('c', 'z', 'x', 0.9),
  ]);
  assert.equal(report.covered, 1);
  assert.equal(report.accuracy_covered, 1);
  assert.equal(report.wrong_caught, 1, 'one wrong answer deferred');
  assert.equal(report.correct_deferred, 1, 'one right answer deferred');
});

test('a stable but wrong case is accepted; stability is not correctness', () => {
  const report = stabilityGate([
    answer('a', 'wrong', 'right', 0.99),
    answer('a', 'wrong', 'right', 0.99),
  ]);
  assert.equal(report.covered, 1, 'consistently wrong still looks stable');
  assert.equal(report.accuracy_covered, 0);
});

test('a fitted threshold is reported against its held-out half', () => {
  // Confidence is informative on the train half and uninformative on the test
  // half, so an in-sample reading must exceed the held-out one.
  const answers: OrderedAnswer[] = [];
  for (let i = 0; i < 40; i += 1) {
    const even = i % 2 === 0;
    if (even) {
      // train: high confidence is right, low confidence is wrong
      const high = i % 4 === 0;
      answers.push(answer(`c${i}`, high ? 'x' : 'y', 'x', high ? 0.99 : 0.55));
    } else {
      // test: high confidence is right only half the time
      const high = i % 4 === 1;
      answers.push(answer(`c${i}`, i % 8 === 1 ? 'x' : 'y', 'x', high ? 0.99 : 0.55));
    }
  }
  const report = fitThreshold(answers, 0.25);
  assert.ok(report.train.accuracy_covered > report.test.accuracy_covered,
    'the fitted half must flatter the threshold relative to the held-out half');
  assert.ok(report.in_sample.accuracy_covered >= report.test.accuracy_covered,
    'the in-sample figure is an upper bound on the honest one');
  assert.equal(report.train.n + report.test.n, answers.length, 'every record lands in exactly one half');
});

test('the threshold search refuses a gate that accepts almost nothing', () => {
  // One record at 0.99 is right; everything else at 0.6 is wrong. Without a
  // coverage floor the search would pick 0.99 and report 100%.
  const answers: OrderedAnswer[] = [answer('hit', 'x', 'x', 0.99)];
  for (let i = 0; i < 20; i += 1) answers.push(answer(`miss${i}`, 'y', 'x', 0.6));

  const greedy = fitThreshold(answers, 0);
  const floored = fitThreshold(answers, 0.5);
  assert.ok(greedy.chosen > floored.chosen, 'a zero floor chases the degenerate high threshold');
  assert.ok(
    floored.train.coverage >= 0.5,
    `the floor must hold on the half it was fitted on, got ${floored.train.coverage}`,
  );
});

test('an empty gate reports zero rather than dividing by zero', () => {
  const report = stabilityGate([]);
  assert.equal(report.n, 0);
  assert.equal(report.coverage, 0);
  assert.equal(report.accuracy_covered, 0);
  assert.equal(report.accuracy_deferred, 0);
});
