/**
 * Decision rules that trade extra calls for reliability.
 *
 * Both rules answer the same question — when should the runtime accept a
 * judgment rather than defer it — and both are scored the same way: what the
 * accepted set is worth, what the deferred set was, and how much is deferred.
 * A gate that reaches 99% by accepting three records is not a gate.
 *
 * Neither rule asks a model anything. Jev is not used to score Jev; a stability
 * gate re-asks the *same* question under a different presentation and compares
 * the runtime's own reduced answers, which is a measurement, not a judgement.
 */

export interface GateResult {
  readonly rule: string;
  readonly n: number;
  /** Records the gate accepts. */
  readonly covered: number;
  readonly coverage: number;
  /** Accuracy within the accepted set — the number a caller would rely on. */
  readonly accuracy_covered: number;
  /** Accuracy within the deferred set. A good gate leaves little here. */
  readonly accuracy_deferred: number;
  /** Correct answers the gate throws away by deferring them. */
  readonly correct_deferred: number;
  /** Wrong answers the gate catches. This is what it is buying. */
  readonly wrong_caught: number;
}

function summarise(
  rule: string,
  items: readonly { readonly correct: boolean; readonly accept: boolean }[],
): GateResult {
  const covered = items.filter((i) => i.accept);
  const deferred = items.filter((i) => !i.accept);
  return {
    rule,
    n: items.length,
    covered: covered.length,
    coverage: items.length === 0 ? 0 : covered.length / items.length,
    accuracy_covered: covered.length === 0 ? 0 : covered.filter((i) => i.correct).length / covered.length,
    accuracy_deferred: deferred.length === 0 ? 0 : deferred.filter((i) => i.correct).length / deferred.length,
    correct_deferred: deferred.filter((i) => i.correct).length,
    wrong_caught: deferred.filter((i) => !i.correct).length,
  };
}

export interface OrderedAnswer {
  readonly case_id: string;
  readonly predicted: string;
  readonly label: string;
  readonly confidence: number;
}

/**
 * Accept a case only when every presentation order produced the same answer.
 *
 * Needs no calibration and no threshold, which is its advantage: there is
 * nothing to fit, so nothing to overfit. It costs one call per ordering.
 */
export function stabilityGate(answers: readonly OrderedAnswer[]): GateResult {
  const byCase = new Map<string, OrderedAnswer[]>();
  for (const answer of answers) {
    const list = byCase.get(answer.case_id);
    if (list === undefined) byCase.set(answer.case_id, [answer]);
    else list.push(answer);
  }

  const items: { correct: boolean; accept: boolean }[] = [];
  for (const list of byCase.values()) {
    const first = list[0];
    if (first === undefined) continue;
    const stable = list.every((a) => a.predicted === first.predicted);
    // The answer a caller would get is the one from the order it happened to
    // present, so correctness is judged on the first ordering either way.
    items.push({ correct: first.predicted === first.label, accept: stable });
  }
  return summarise('stable across orderings', items);
}

export interface ThresholdReport {
  /** The threshold fitted on the training half only. */
  readonly chosen: number;
  readonly train: GateResult;
  /** The honest number: the same threshold applied to records it never saw. */
  readonly test: GateResult;
  /** What the same threshold scores when fitted and tested on everything. */
  readonly in_sample: GateResult;
}

function gateByConfidence(rule: string, answers: readonly OrderedAnswer[], threshold: number): GateResult {
  return summarise(
    rule,
    answers.map((a) => ({ correct: a.predicted === a.label, accept: a.confidence >= threshold })),
  );
}

/**
 * Fit a confidence threshold on one half and report it on the other.
 *
 * `benchmarks/inference/README.md` records this as an outstanding requirement
 * twice — a recovered accuracy fitted in-sample is an upper bound, not a
 * result. The split is deterministic so the report replays.
 *
 * `minCoverage` stops the search returning a threshold that accepts almost
 * nothing at a flattering accuracy.
 */
export function fitThreshold(
  answers: readonly OrderedAnswer[],
  minCoverage = 0.5,
  grid: readonly number[] = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99],
): ThresholdReport {
  // Deterministic interleave rather than a shuffle: no seed to report, and
  // every source is split roughly evenly between the halves.
  const train = answers.filter((_, i) => i % 2 === 0);
  const test = answers.filter((_, i) => i % 2 === 1);

  let chosen = grid[0] ?? 0.5;
  let best = -1;
  for (const threshold of grid) {
    const result = gateByConfidence('fit', train, threshold);
    if (result.coverage < minCoverage) continue;
    if (result.accuracy_covered > best) {
      best = result.accuracy_covered;
      chosen = threshold;
    }
  }

  return {
    chosen,
    train: gateByConfidence(`confidence >= ${chosen} (train, fitted here)`, train, chosen),
    test: gateByConfidence(`confidence >= ${chosen} (test, held out)`, test, chosen),
    in_sample: gateByConfidence(`confidence >= ${chosen} (all records, fitted in-sample)`, answers, chosen),
  };
}
