/**
 * Presentation order as an independent variable.
 *
 * Repeating one prompt measures whether the provider is deterministic. It does
 * not measure whether the answer was read from the state, because a predictor
 * locked to the first position returns the same candidate every time and looks
 * perfectly stable. Varying the order separates the two: a state-reading
 * predictor names the same candidate wherever it is printed, and a
 * position-locked one follows the position.
 *
 * `benchmarks/inference/README.md` already records that how a question is put
 * moves the signal more than the model does. Order is part of how it is put,
 * so it is varied deterministically and recorded, never left to chance.
 */
import type { DecisionCase } from './corpus.ts';

/** A presentation order: indices into the case's corpus-order candidate list. */
export type Ordering = readonly number[];

/** Deterministic PRNG, so a recorded run replays exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(count: number, random: () => number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = order[i]!;
    order[i] = order[j]!;
    order[j] = a;
  }
  return order;
}

function factorial(n: number): number {
  let out = 1;
  for (let i = 2; i <= n; i += 1) out *= i;
  return out;
}

/**
 * `k` distinct orderings over `count` candidates, identity first and reverse
 * second so the two extremes are always measured, then seeded shuffles.
 *
 * Clamped to the number of distinct permutations that exist, so a two-candidate
 * case yields two orderings rather than four duplicates.
 */
export function orderingsFor(count: number, k: number, seed: number): readonly Ordering[] {
  if (count <= 0) return [];
  const limit = Math.max(1, Math.min(k, factorial(count)));
  const identity = Array.from({ length: count }, (_, i) => i);
  const seen = new Set<string>();
  const out: number[][] = [];

  const push = (order: number[]): void => {
    const key = order.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(order);
  };

  push(identity);
  if (out.length < limit) push([...identity].reverse());

  const random = mulberry32(seed);
  let guard = 0;
  while (out.length < limit && guard < 1000) {
    push(shuffled(count, random));
    guard += 1;
  }
  return out.slice(0, limit);
}

/**
 * The case as the model will see it under one ordering.
 *
 * Only presentation changes. The label is a candidate id, so it is unaffected,
 * and the contrast group is carried through unchanged.
 */
export function applyOrdering(decision: DecisionCase, order: Ordering): DecisionCase {
  const candidates = order.map((index) => decision.candidates[index]).filter((c) => c !== undefined);
  return { ...decision, candidates };
}

/** Where the label sat, and where the answer landed, as presented. */
export interface PermutationRecordView {
  readonly case_id: string;
  readonly ordering_index: number;
  /** Candidate ids in the order the model saw them. */
  readonly presented: readonly string[];
  readonly label: string;
  readonly predicted: string;
}

export interface PermutationReport {
  readonly cases: number;
  readonly orderings_seen: number;
  /**
   * Cases actually presented more than one way. Only these carry evidence
   * about order; a case with one candidate, or asked once, is stable by
   * construction and counting it reports stability that was never measured.
   */
  readonly permuted: number;
  /** Cases, among `permuted`, whose selected candidate never moved. */
  readonly stable_top: number;
  readonly stability_rate: number;
  /**
   * Cases holding a record under every ordering index seen. The per-ordering
   * accuracies are restricted to these, because ordering indices otherwise
   * hold different populations — a corpus mixing 2- and 4-candidate cases
   * gives ordering 0 every case and ordering 3 only the 4-candidate ones, so
   * an unrestricted spread measures which cases are hard, not order.
   */
  readonly balanced_cases: number;
  /** Accuracy on the balanced panel per ordering index, worst and best. */
  readonly worst_ordering_accuracy: number;
  readonly best_ordering_accuracy: number;
  /** How often the selected candidate sat at position i as presented. */
  readonly chosen_position: readonly number[];
  /** How often the correct candidate sat at position i as presented. */
  readonly label_position: readonly number[];
  /**
   * Total variation distance between those two distributions, computed within
   * each candidate-count stratum and then weighted by records.
   *
   * Stratification is load-bearing. Compared over absolute index alone, a
   * predictor locked to the *last* position spreads across indices 1..k-1 when
   * the corpus mixes 2-, 3- and 4-candidate cases, and hides below the same
   * threshold that catches a first-position lock. Within a stratum it is
   * concentrated again, which is what a position lock actually means.
   */
  readonly position_bias: number;
}

function distribution(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total === 0) return counts.map(() => 0);
  return counts.map((n) => n / total);
}

export function scorePermutation(views: readonly PermutationRecordView[]): PermutationReport {
  const byCase = new Map<string, PermutationRecordView[]>();
  for (const view of views) {
    const list = byCase.get(view.case_id);
    if (list === undefined) byCase.set(view.case_id, [view]);
    else list.push(view);
  }

  let stable = 0;
  let permuted = 0;
  for (const list of byCase.values()) {
    const first = list[0];
    if (first === undefined) continue;
    // Distinct presentations, not repeats: asking the same order twice is a
    // determinism check and is scored elsewhere.
    const distinctOrders = new Set(list.map((v) => v.presented.join('\u0000')));
    if (distinctOrders.size < 2) continue;
    permuted += 1;
    if (list.every((v) => v.predicted === first.predicted)) stable += 1;
  }

  const width = views.reduce((max, v) => Math.max(max, v.presented.length), 0);
  const chosen = Array.from({ length: width }, () => 0);
  const labelAt = Array.from({ length: width }, () => 0);
  const byOrdering = new Map<number, { n: number; correct: number }>();

  for (const view of views) {
    const chosenIndex = view.presented.indexOf(view.predicted);
    if (chosenIndex >= 0) chosen[chosenIndex] = (chosen[chosenIndex] ?? 0) + 1;
    const labelIndex = view.presented.indexOf(view.label);
    if (labelIndex >= 0) labelAt[labelIndex] = (labelAt[labelIndex] ?? 0) + 1;

    byOrdering.set(view.ordering_index, byOrdering.get(view.ordering_index) ?? { n: 0, correct: 0 });
  }

  // Compare like with like: only cases answered under every ordering index.
  const orderingIndices = [...byOrdering.keys()];
  const balanced = [...byCase.values()].filter((list) => {
    const seen = new Set(list.map((v) => v.ordering_index));
    return orderingIndices.every((index) => seen.has(index));
  });
  for (const list of balanced) {
    for (const view of list) {
      const bucket = byOrdering.get(view.ordering_index)!;
      bucket.n += 1;
      if (view.predicted === view.label) bucket.correct += 1;
    }
  }

  const accuracies = [...byOrdering.values()]
    .filter((b) => b.n > 0)
    .map((b) => b.correct / b.n);

  // Within each candidate count, compare where the answer landed against where
  // the label sat, then weight the strata by how many records each holds.
  const strata = new Map<number, { chosen: number[]; label: number[]; n: number }>();
  for (const view of views) {
    const k = view.presented.length;
    const stratum = strata.get(k) ?? {
      chosen: Array.from({ length: k }, () => 0),
      label: Array.from({ length: k }, () => 0),
      n: 0,
    };
    const chosenIndex = view.presented.indexOf(view.predicted);
    if (chosenIndex >= 0) stratum.chosen[chosenIndex] = (stratum.chosen[chosenIndex] ?? 0) + 1;
    const labelIndex = view.presented.indexOf(view.label);
    if (labelIndex >= 0) stratum.label[labelIndex] = (stratum.label[labelIndex] ?? 0) + 1;
    stratum.n += 1;
    strata.set(k, stratum);
  }

  let weighted = 0;
  let total = 0;
  for (const stratum of strata.values()) {
    const a = distribution(stratum.chosen);
    const b = distribution(stratum.label);
    const tv = a.reduce((sum, p, i) => sum + Math.abs(p - (b[i] ?? 0)), 0) / 2;
    weighted += tv * stratum.n;
    total += stratum.n;
  }
  const bias = total === 0 ? 0 : weighted / total;

  return {
    cases: byCase.size,
    orderings_seen: byOrdering.size,
    permuted,
    stable_top: stable,
    stability_rate: permuted === 0 ? 0 : stable / permuted,
    balanced_cases: balanced.length,
    worst_ordering_accuracy: accuracies.length === 0 ? 0 : Math.min(...accuracies),
    best_ordering_accuracy: accuracies.length === 0 ? 0 : Math.max(...accuracies),
    chosen_position: chosen,
    label_position: labelAt,
    position_bias: bias,
  };
}
