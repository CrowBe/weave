/**
 * The `frontier.weigh@1` site contract (packages/weave/src/FRONTIER-WEIGH-CONTRACT.md).
 *
 * One score question per eligible candidate, asked about one state view.
 * Weave validates the answers into weights, defers candidates whose weight
 * falls below the floor, and selects the frontier with the ordinary
 * scheduler. A weight is ordinal evidence within this site only.
 */
import type { ScoreAnswer, ScoreQuestion } from '@weave/gateway';
import { select, type Selection } from './scheduler.js';
import type { Candidate, CandidateId, State, WeightEntry, WeightsRecordedPayload } from './types.js';

export const FRONTIER_WEIGH_CONTRACT = 'frontier.weigh@1' as const;
export type FrontierWeighContract = typeof FRONTIER_WEIGH_CONTRACT;

/** Level names, lowest first. The answer's score is its fractional position. */
export const FRONTIER_WEIGH_LEVELS = ['defer', 'consider', 'dispatch'] as const;

/** Criteria sent with every question, in level order. Changing a word is a new contract version. */
export const FRONTIER_WEIGH_CRITERIA: readonly string[] = [
  'defer: do not dispatch it now. It does not contribute to the success evidence, what it would produce is already current or in flight, or the actions remaining cannot cover the work still needed to complete the goal.',
  'consider: it contributes to the success evidence, but it is not among the most direct steps from this state.',
  'dispatch: it is among the most direct steps from this state toward the success evidence, and the actions remaining still cover completing the goal.',
];

/** Highest valid weight: the index of the last level. */
export const FRONTIER_WEIGH_MAX = FRONTIER_WEIGH_LEVELS.length - 1;

/** A weight below this is nearer `defer` than `consider`. Weave does not dispatch it. */
export const FRONTIER_WEIGH_DEFER_BELOW = 0.5;

export function frontierWeighInstructions(candidate_id: CandidateId): string {
  return `Candidate ${candidate_id} is listed in candidates. If Weave dispatched it now, how directly would it move this goal toward its success evidence, given the progress shown and the actions remaining?`;
}

/** The exact question set: one score question per eligible candidate, keyed by candidate id. */
export function frontierWeighQuestions(candidates: readonly Candidate[]): Record<CandidateId, ScoreQuestion> {
  const questions: Record<CandidateId, ScoreQuestion> = {};
  for (const candidate of candidates) {
    questions[candidate.candidate_id] = {
      type: 'score',
      instructions: frontierWeighInstructions(candidate.candidate_id),
      criteria: FRONTIER_WEIGH_CRITERIA,
    };
  }
  return questions;
}

export function validFrontierWeight(weight: unknown): weight is number {
  return typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= FRONTIER_WEIGH_MAX;
}

/**
 * Valid output: exactly one score answer per eligible candidate, each a finite
 * position in [0, FRONTIER_WEIGH_MAX]. The weight is that position unchanged.
 */
export function frontierWeights(
  candidates: readonly Candidate[],
  answers: Readonly<Record<string, { readonly type: string; readonly score?: number }>>,
): { readonly ok: true; readonly weights: WeightEntry[] } | { readonly ok: false; readonly reason: string } {
  const expected = new Set(candidates.map((candidate) => candidate.candidate_id));
  for (const id of Object.keys(answers)) {
    if (!expected.has(id)) {
      return { ok: false, reason: `answer for unknown candidate ${id}` };
    }
  }
  const weights: WeightEntry[] = [];
  for (const candidate of candidates) {
    const answer = answers[candidate.candidate_id] as ScoreAnswer | { readonly type: string } | undefined;
    if (!answer) {
      return { ok: false, reason: `missing weight for ${candidate.candidate_id}` };
    }
    if (answer.type !== 'score' || !validFrontierWeight((answer as ScoreAnswer).score)) {
      return { ok: false, reason: `invalid weight for ${candidate.candidate_id}` };
    }
    weights.push({ candidate_id: candidate.candidate_id, weight: (answer as ScoreAnswer).score });
  }
  return { ok: true, weights };
}

export function deferredByContract(weight: number | null, contract: string | undefined): boolean {
  return contract === FRONTIER_WEIGH_CONTRACT && weight !== null && weight < FRONTIER_WEIGH_DEFER_BELOW;
}

/** True when the recorded weights defer every candidate they weigh. */
export function defersEverything(payload: WeightsRecordedPayload): boolean {
  return payload.weights.length > 0 && payload.weights.every((entry) => deferredByContract(entry.weight, payload.contract));
}

/**
 * Weave's selection from weighed, eligible candidates. Deferred candidates are
 * recorded and never reach the scheduler; the rest are selected by weight
 * (descending), candidate id, dependencies, effects and budget, unchanged.
 */
export function selectFrontier(weighed: readonly Candidate[], state: State, contract: string | undefined): Selection {
  const deferred = weighed.filter((candidate) => deferredByContract(candidate.weight, contract));
  const kept = weighed.filter((candidate) => !deferredByContract(candidate.weight, contract));
  const selection = select(kept, state);
  return {
    selected: selection.selected,
    not_selected: [
      ...selection.not_selected,
      ...deferred.map((candidate) => ({ candidate_id: candidate.candidate_id, reason: 'deferred' as const })),
    ],
  };
}
