/**
 * Gauge's statistics (GAUGE-CONTRACT.md "Statistics"). Everything here is a
 * pure function of its arguments: the bootstrap draws from a seeded generator,
 * so a criteria set's `seed` reproduces every interval. Internal to the
 * package; the producers are the public surface.
 */
import type { Aggregate, Interval } from './types.js';

export const BOOTSTRAP_RESAMPLES = 2000;

/** mulberry32: the same stream for the same seed (taken modulo 2^32) on every run. */
export function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Acklam's rational approximation to the inverse standard normal CDF
// (relative error below 1.2e-9 over (0, 1)).
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
  2.506628277459239,
];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
  2.938163982698783,
];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

/** The standard normal quantile for p in (0, 1). */
export function normalQuantile(p: number): number {
  const tail = (q: number) =>
    (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
    ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  if (p < P_LOW) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - P_LOW) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) /
    (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1)
  );
}

const sum = (xs: readonly number[]): number => xs.reduce((total, x) => total + x, 0);

/** A measure's value over a non-empty sample. A rate sample is 0 or 1, so a rate is a mean. */
export function aggregate(kind: Aggregate, samples: readonly number[]): number {
  switch (kind) {
    case 'rate':
    case 'mean':
      return sum(samples) / samples.length;
    case 'sum':
      return sum(samples);
    case 'p95': {
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
    }
  }
}

/** Widen to contain the value, and clamp a rate's interval to [0, 1]. */
function containing(value: number, [lo, hi]: Interval, rate: boolean): Interval {
  const low = Math.min(lo, value);
  const high = Math.max(hi, value);
  return rate ? [Math.max(0, low), Math.min(1, high)] : [low, high];
}

/** The Wilson score interval for `successes` of `n` (n ≥ 1) at `level`. */
export function wilson(successes: number, n: number, level: number): Interval {
  const z = normalQuantile(1 - (1 - level) / 2);
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return containing(p, [centre - half, centre + half], true);
}

/** A percentile bootstrap interval for a non-empty sample, from `seed`. */
export function bootstrap(samples: readonly number[], kind: Aggregate, level: number, seed: number): Interval {
  const n = samples.length;
  const next = generator(seed);
  const statistics = new Float64Array(BOOTSTRAP_RESAMPLES);
  const draw = new Array<number>(n);
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b += 1) {
    for (let i = 0; i < n; i += 1) draw[i] = samples[Math.floor(next() * n)]!;
    statistics[b] = aggregate(kind, draw);
  }
  statistics.sort();
  const alpha = 1 - level;
  const lo = statistics[Math.floor((BOOTSTRAP_RESAMPLES * alpha) / 2)]!;
  const hi = statistics[Math.ceil(BOOTSTRAP_RESAMPLES * (1 - alpha / 2)) - 1]!;
  return containing(aggregate(kind, samples), [lo, hi], kind === 'rate');
}

export interface Estimate {
  readonly value: number;
  readonly interval: Interval;
}

/**
 * An interval for candidate minus baseline by the method of variance
 * estimates recovery; with Wilson inputs it is Newcombe's hybrid score
 * interval. It treats the two estimates as independent.
 */
export function difference(baseline: Estimate, candidate: Estimate): Interval {
  const d = candidate.value - baseline.value;
  const [l1, u1] = candidate.interval;
  const [l2, u2] = baseline.interval;
  return [
    d - Math.sqrt((candidate.value - l1) ** 2 + (u2 - baseline.value) ** 2),
    d + Math.sqrt((u1 - candidate.value) ** 2 + (baseline.value - l2) ** 2),
  ];
}
