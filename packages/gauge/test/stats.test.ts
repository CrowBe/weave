import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOTSTRAP_RESAMPLES,
  aggregate,
  bootstrap,
  difference,
  generator,
  normalQuantile,
  wilson,
} from '../src/stats.js';
import type { Interval } from '@weave/gauge';

/** G5 statistics: deterministic for a seed, checked against published values where they exist. */

const close = (actual: number, expected: number, tolerance: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} is not within ${tolerance} of ${expected}`);
const closeInterval = (actual: Interval, expected: Interval, tolerance: number, label = '') => {
  close(actual[0], expected[0], tolerance, `${label} lo`);
  close(actual[1], expected[1], tolerance, `${label} hi`);
};
const rates = (successes: number, n: number) => Array.from({ length: n }, (_, i) => (i < successes ? 1 : 0));

test('the normal quantile matches reference values in every branch', () => {
  close(normalQuantile(0.5), 0, 1e-12);
  close(normalQuantile(0.975), 1.959963985, 1e-8);
  close(normalQuantile(0.995), 2.575829304, 1e-8);
  close(normalQuantile(0.01), -2.326347874, 1e-8);
  close(normalQuantile(0.999), 3.090232306, 1e-8);
});

test('wilson@1 matches Newcombe (1998) single-proportion intervals', () => {
  closeInterval(wilson(81, 263, 0.95), [0.2553, 0.3662], 5e-5, '81/263');
  closeInterval(wilson(15, 148, 0.95), [0.0624, 0.1605], 5e-5, '15/148');
  closeInterval(wilson(0, 20, 0.95), [0, 0.1611], 5e-5, '0/20');
  closeInterval(wilson(1, 29, 0.95), [0.0061, 0.1718], 5e-5, '1/29');
});

test('a wilson interval contains its proportion and stays in [0, 1]', () => {
  for (const [k, n] of [
    [0, 1],
    [1, 1],
    [20, 20],
    [0, 20],
    [7, 9],
    [1, 1000],
  ] as const) {
    const [lo, hi] = wilson(k, n, 0.95);
    assert.ok(lo >= 0 && hi <= 1 && lo <= k / n && k / n <= hi, `${k}/${n}: [${lo}, ${hi}]`);
  }
  assert.equal(wilson(20, 20, 0.95)[1], 1);
  assert.equal(wilson(0, 20, 0.95)[0], 0);
});

test("the difference of two wilson intervals is Newcombe's hybrid score interval", () => {
  const diff = (k1: number, n1: number, k2: number, n2: number) =>
    difference({ value: k2 / n2, interval: wilson(k2, n2, 0.95) }, { value: k1 / n1, interval: wilson(k1, n1, 0.95) });
  closeInterval(diff(56, 70, 48, 80), [0.0524, 0.3339], 5e-5, '56/70 - 48/80');
  closeInterval(diff(9, 10, 3, 10), [0.1705, 0.809], 5e-5, '9/10 - 3/10');
  closeInterval(diff(5, 56, 0, 29), [-0.0381, 0.1926], 5e-5, '5/56 - 0/29');
});

test('a difference interval always contains the difference', () => {
  const [lo, hi] = difference({ value: 150, interval: [140, 160] }, { value: 120, interval: [110, 130] });
  assert.ok(lo <= -30 && -30 <= hi);
  close(hi, -30 + Math.SQRT2 * 10, 1e-12);
  assert.deepEqual(difference({ value: 3, interval: [3, 3] }, { value: 3, interval: [3, 3] }), [0, 0]);
});

test('the generator is deterministic for a seed and restarts identically', () => {
  const draw = (seed: number) => {
    const next = generator(seed);
    return Array.from({ length: 5 }, () => next());
  };
  assert.deepEqual(draw(7), draw(7));
  assert.notDeepEqual(draw(7), draw(8));
  // A seed is taken modulo 2^32.
  assert.deepEqual(draw(7 + 2 ** 32), draw(7));
  for (const u of draw(123)) assert.ok(u >= 0 && u < 1);
  // mulberry32's reference stream for seed 7, pinned so a change to it is visible.
  assert.deepEqual(draw(7).slice(0, 3), [0.011704753153026104, 0.06195825757458806, 0.97690763277933]);
});

test('aggregates are the mean, sum and nearest-rank p95', () => {
  const xs = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(aggregate('mean', xs), 10.5);
  assert.equal(aggregate('rate', rates(3, 4)), 0.75);
  assert.equal(aggregate('sum', xs), 210);
  assert.equal(aggregate('p95', [...xs].reverse()), 19);
  assert.equal(
    aggregate(
      'p95',
      Array.from({ length: 100 }, (_, i) => i + 1),
    ),
    95,
  );
  assert.equal(aggregate('p95', [42]), 42);
});

test('bootstrap@1 is deterministic for a seed', () => {
  const xs = Array.from({ length: 60 }, (_, i) => (i * 37) % 101);
  assert.deepEqual(bootstrap(xs, 'mean', 0.95, 7), bootstrap(xs, 'mean', 0.95, 7));
  assert.notDeepEqual(bootstrap(xs, 'mean', 0.95, 7), bootstrap(xs, 'mean', 0.95, 8));
  assert.equal(BOOTSTRAP_RESAMPLES, 2000);
});

test('a bootstrap interval contains its value and is near the normal interval for a mean', () => {
  const xs = Array.from({ length: 400 }, (_, i) => (i * 7919) % 1000);
  const mean = aggregate('mean', xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
  const half = (1.959963985 * sd) / Math.sqrt(xs.length);
  const [lo, hi] = bootstrap(xs, 'mean', 0.95, 7);
  assert.ok(lo <= mean && mean <= hi);
  close(lo, mean - half, half * 0.2, 'lo');
  close(hi, mean + half, half * 0.2, 'hi');
});

test('a bootstrap interval for a rate stays in [0, 1] and a constant sample has no width', () => {
  for (const [k, n] of [
    [0, 30],
    [30, 30],
    [1, 40],
  ] as const) {
    const [lo, hi] = bootstrap(rates(k, n), 'rate', 0.95, 7);
    assert.ok(lo >= 0 && hi <= 1 && lo <= k / n && k / n <= hi, `${k}/${n}`);
  }
  assert.deepEqual(bootstrap([5, 5, 5], 'p95', 0.95, 7), [5, 5]);
});

test('every bootstrap interval contains its statistic, p95 and sum included', () => {
  const skewed = [...Array.from({ length: 50 }, () => 1), 1000, 2000];
  for (const kind of ['mean', 'sum', 'p95'] as const) {
    const value = aggregate(kind, skewed);
    const [lo, hi] = bootstrap(skewed, kind, 0.9, 11);
    assert.ok(lo <= value && value <= hi, `${kind}: ${value} in [${lo}, ${hi}]`);
  }
});
