/**
 * Deterministic scoring over recorded probe results.
 *
 * No inference happens here and no model judges anything. Jev is not used to
 * score Jev: that measures agreement, not accuracy, and the repository already
 * states the position for the generation path — "a model judge is another
 * fallible observation and does not belong here."
 *
 * Every accuracy is reported against explicit constant-predictor floors,
 * because a floor moves with option count and two suites' raw accuracies are
 * not comparable to each other (`benchmarks/inference/README.md`).
 */
import type { DecisionCase } from './corpus.ts';
import type { ProbeRecord } from './run.ts';

export interface Floors {
  /** Always pick the first eligible candidate. Argmax stubs collapse to this. */
  readonly always_first: number;
  /** Analytic chance: the mean of 1/k over the records scored. */
  readonly uniform: number;
  /** Best constant operation, chosen when present. The strongest constant rule. */
  readonly majority_operation: number;
  readonly majority_operation_name: string;
}

export interface Calibration {
  /** Ten-bin expected calibration error on the top-label confidence. */
  readonly ece: number;
  /** Top-label Brier score: (confidence - correct)^2, averaged. */
  readonly brier: number;
  readonly mean_confidence: number;
  readonly bins: readonly {
    readonly lower: number;
    readonly n: number;
    readonly mean_confidence: number;
    readonly accuracy: number;
  }[];
}

export interface ContrastResult {
  readonly relevant_groups: number;
  /** Pairs whose answer must move and did, with both members correct. */
  readonly relevant_flipped_both_correct: number;
  readonly irrelevant_groups: number;
  /** Pairs whose answer must hold and did. */
  readonly irrelevant_held: number;
}

export interface ShapeReport {
  readonly kind: string;
  readonly attempted: number;
  readonly accepted: number;
  readonly accuracy: number;
  readonly standard_error: number;
  readonly floors: Floors;
  readonly margin_over_best_floor: number;
  readonly ties: number;
  readonly calibration: Calibration;
  readonly contrast: ContrastResult;
  readonly latency_ms: { readonly median: number; readonly p90: number; readonly p95: number; readonly max: number };
  readonly spent_micros: number;
  readonly answered_by: Readonly<Record<string, number>>;
  readonly escalated: number;
  readonly waits: number;
  readonly failures: Readonly<Record<string, number>>;
  readonly determinism: {
    readonly groups: number;
    readonly unanimous_top: number;
    readonly max_top_value_spread: number;
  };
  readonly per_source: readonly {
    readonly source: string;
    readonly n: number;
    readonly accuracy: number;
    readonly always_first: number;
  }[];
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[index] ?? 0;
}

function computeFloors(records: readonly ProbeRecord[], byId: Map<string, DecisionCase>): Floors {
  let alwaysFirst = 0;
  let uniform = 0;
  const operations = new Set<string>();
  for (const record of records) {
    const decision = byId.get(record.case_id);
    if (decision === undefined) continue;
    // "First" means first as presented, not first in the corpus. Under
    // permutation these differ, and an argmax stub follows the presentation.
    const presentedFirst = record.candidate_ids[0] ?? decision.candidates[0]?.candidate_id;
    if (presentedFirst === record.label) alwaysFirst += 1;
    uniform += 1 / decision.candidates.length;
    for (const candidate of decision.candidates) operations.add(candidate.operation);
  }

  let bestName = '';
  let best = 0;
  for (const operation of operations) {
    let hits = 0;
    for (const record of records) {
      const decision = byId.get(record.case_id);
      if (decision === undefined) continue;
      const picked = decision.candidates.find((c) => c.operation === operation) ?? decision.candidates[0];
      if (picked?.candidate_id === record.label) hits += 1;
    }
    if (hits > best) {
      best = hits;
      bestName = operation;
    }
  }
  const n = Math.max(1, records.length);
  return {
    always_first: alwaysFirst / n,
    uniform: uniform / n,
    majority_operation: best / n,
    majority_operation_name: bestName,
  };
}

function computeCalibration(records: readonly ProbeRecord[]): Calibration {
  const points = records
    .filter((r) => r.ranking !== undefined)
    .map((r) => ({ confidence: r.ranking!.confidence, correct: r.ranking!.top === r.label ? 1 : 0 }));
  if (points.length === 0) {
    return { ece: 0, brier: 0, mean_confidence: 0, bins: [] };
  }
  const bins: { lower: number; n: number; sumConfidence: number; hits: number }[] = [];
  for (let i = 0; i < 10; i += 1) bins.push({ lower: i / 10, n: 0, sumConfidence: 0, hits: 0 });
  let brier = 0;
  let sumConfidence = 0;
  for (const point of points) {
    const index = Math.min(9, Math.max(0, Math.floor(point.confidence * 10)));
    const bin = bins[index]!;
    bin.n += 1;
    bin.sumConfidence += point.confidence;
    bin.hits += point.correct;
    brier += (point.confidence - point.correct) ** 2;
    sumConfidence += point.confidence;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.n === 0) continue;
    ece += (bin.n / points.length) * Math.abs(bin.hits / bin.n - bin.sumConfidence / bin.n);
  }
  return {
    ece,
    brier: brier / points.length,
    mean_confidence: sumConfidence / points.length,
    bins: bins
      .filter((b) => b.n > 0)
      .map((b) => ({ lower: b.lower, n: b.n, mean_confidence: b.sumConfidence / b.n, accuracy: b.hits / b.n })),
  };
}

function computeContrast(records: readonly ProbeRecord[], byId: Map<string, DecisionCase>): ContrastResult {
  const groups = new Map<string, { arm: 'relevant' | 'irrelevant'; members: ProbeRecord[] }>();
  for (const record of records) {
    const decision = byId.get(record.case_id);
    const contrast = decision?.contrast;
    if (contrast === undefined) continue;
    const existing = groups.get(contrast.group);
    if (existing === undefined) groups.set(contrast.group, { arm: contrast.arm, members: [record] });
    else existing.members.push(record);
  }
  let relevantGroups = 0;
  let relevantFlipped = 0;
  let irrelevantGroups = 0;
  let irrelevantHeld = 0;
  for (const group of groups.values()) {
    // Compare the first recorded answer per case, so repeats do not inflate.
    const firstPerCase = new Map<string, ProbeRecord>();
    for (const member of group.members) {
      if (!firstPerCase.has(member.case_id)) firstPerCase.set(member.case_id, member);
    }
    const members = [...firstPerCase.values()];
    if (members.length < 2) continue;
    const tops = members.map((m) => m.ranking?.top);
    const allCorrect = members.every((m) => m.ranking?.top === m.label);
    if (group.arm === 'relevant') {
      relevantGroups += 1;
      const moved = new Set(tops).size === members.length;
      if (moved && allCorrect) relevantFlipped += 1;
    } else {
      irrelevantGroups += 1;
      if (new Set(tops).size === 1) irrelevantHeld += 1;
    }
  }
  return {
    relevant_groups: relevantGroups,
    relevant_flipped_both_correct: relevantFlipped,
    irrelevant_groups: irrelevantGroups,
    irrelevant_held: irrelevantHeld,
  };
}

export function scoreShape(kind: string, all: readonly ProbeRecord[], corpus: readonly DecisionCase[]): ShapeReport {
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const records = all.filter((r) => r.kind === kind);
  const accepted = records.filter((r) => r.status === 'accepted' && r.ranking !== undefined);

  const hits = accepted.filter((r) => r.ranking!.top === r.label).length;
  const accuracy = accepted.length === 0 ? 0 : hits / accepted.length;
  const floors = computeFloors(accepted, byId);
  const bestFloor = Math.max(floors.always_first, floors.uniform, floors.majority_operation);

  const latencies = [...records.map((r) => r.latency_ms)].sort((a, b) => a - b);
  const answeredBy: Record<string, number> = {};
  const failures: Record<string, number> = {};
  let escalated = 0;
  let waits = 0;
  for (const record of records) {
    if (record.routed_unit_id !== undefined) {
      answeredBy[record.routed_unit_id] = (answeredBy[record.routed_unit_id] ?? 0) + 1;
    }
    if (record.attempts.length > 1) escalated += 1;
    for (const attempt of record.attempts) {
      if (attempt.waited_ms !== undefined) waits += 1;
      if (attempt.status !== 'accepted') {
        const key = attempt.detail ?? attempt.status;
        failures[key] = (failures[key] ?? 0) + 1;
      }
    }
  }

  const groups = new Map<string, ProbeRecord[]>();
  for (const record of accepted) {
    const list = groups.get(record.case_id) ?? [];
    list.push(record);
    groups.set(record.case_id, list);
  }
  let unanimous = 0;
  let repeated = 0;
  let maxSpread = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    repeated += 1;
    if (new Set(list.map((r) => r.ranking!.top)).size === 1) unanimous += 1;
    const values = list.map((r) => r.ranking!.ordered[0]?.value ?? 0);
    maxSpread = Math.max(maxSpread, Math.max(...values) - Math.min(...values));
  }

  const sources = [...new Set(accepted.map((r) => r.source))].sort();

  return {
    kind,
    attempted: records.length,
    accepted: accepted.length,
    accuracy,
    standard_error: accepted.length === 0 ? 0 : Math.sqrt((accuracy * (1 - accuracy)) / accepted.length),
    floors,
    margin_over_best_floor: accuracy - bestFloor,
    ties: accepted.filter((r) => r.ranking!.tied).length,
    calibration: computeCalibration(accepted),
    contrast: computeContrast(accepted, byId),
    latency_ms: {
      median: quantile(latencies, 0.5),
      p90: quantile(latencies, 0.9),
      p95: quantile(latencies, 0.95),
      max: latencies.length === 0 ? 0 : latencies[latencies.length - 1]!,
    },
    spent_micros: records.reduce((sum, r) => sum + r.spent, 0),
    answered_by: answeredBy,
    escalated,
    waits,
    failures,
    determinism: { groups: repeated, unanimous_top: unanimous, max_top_value_spread: maxSpread },
    per_source: sources.map((source) => {
      const subset = accepted.filter((r) => r.source === source);
      return {
        source,
        n: subset.length,
        accuracy: subset.filter((r) => r.ranking!.top === r.label).length / Math.max(1, subset.length),
        always_first: computeFloors(subset, byId).always_first,
      };
    }),
  };
}
