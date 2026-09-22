/**
 * The mapping between one labeled decision and Jev's three answer shapes.
 *
 * A decision case yields a ranking over its candidates however it is asked, so
 * the three shapes are scored against the same label on the same records. What
 * differs is only how the question is put and how the answer is reduced.
 *
 * **Every shape sees the same information.** The shared state carries the full
 * candidate list, so a `score` question — which names one candidate — is not
 * answered in ignorance of the alternatives that a `choice` question would have
 * shown. Without this the comparison would measure disclosure, not shape.
 *
 * **Confidence is defined per shape, because it is not the same quantity.**
 * `benchmarks/inference/README.md` records what happens when that definition is
 * left implicit. Each reducer states its own below, and the scorer never
 * compares one shape's confidence against another's as though they shared a
 * scale (ARCHITECTURE.md §4).
 */
import type {
  BooleanAnswer,
  ChoiceAnswer,
  EvaluationAnswers,
  EvaluationContent,
  EvaluationKind,
  EvaluationQuestions,
  QuestionId,
  EvaluationQuestion,
  ScoreAnswer,
} from '@weave/gateway';
import type { CandidateOption, DecisionCase } from './corpus.ts';

/** Ordered low to high; the index is the score the model returns. */
export const ADVANCEMENT_LEVELS: readonly string[] = [
  'does not advance the goal from this state',
  'advances the goal marginally from this state',
  'advances the goal substantially from this state',
  'is the action this state calls for',
];

/** What the model reads. Identical across shapes for one case. */
export function renderState(decision: DecisionCase): EvaluationContent {
  return {
    goal: decision.state.goal,
    situation: decision.state.situation,
    facts: [...decision.state.facts],
    eligible_candidates: decision.candidates.map((c) => ({
      candidate_id: c.candidate_id,
      operation: c.operation,
      summary: c.summary,
    })),
  };
}

function describe(candidate: CandidateOption): string {
  return `${candidate.candidate_id} (${candidate.operation}): ${candidate.summary}`;
}

export function renderQuestions(kind: EvaluationKind, decision: DecisionCase): EvaluationQuestions {
  switch (kind) {
    case 'choice': {
      const criteria: Record<string, EvaluationContent> = {};
      for (const candidate of decision.candidates) {
        criteria[candidate.candidate_id] = `${candidate.operation}: ${candidate.summary}`;
      }
      return {
        best: {
          type: 'choice',
          instructions:
            'Exactly one of these eligible candidates should be dispatched now. Which one best advances the authorized goal from the situation described?',
          criteria,
        },
      };
    }
    case 'score': {
      const questions: Record<QuestionId, EvaluationQuestion> = {};
      for (const candidate of decision.candidates) {
        questions[candidate.candidate_id] = {
          type: 'score',
          instructions: `Place this candidate on the scale, given the goal, the situation and the facts: ${describe(candidate)}`,
          criteria: [...ADVANCEMENT_LEVELS],
        };
      }
      return questions as EvaluationQuestions;
    }
    case 'boolean': {
      const questions: Record<QuestionId, EvaluationQuestion> = {};
      for (const candidate of decision.candidates) {
        questions[candidate.candidate_id] = {
          type: 'boolean',
          instructions: `Consider this candidate, given the goal, the situation and the facts: ${describe(candidate)}`,
          // Declarative and content-bearing on both arms: the repository's
          // entailment work found that an interrogative or contentless
          // hypothesis moves the signal more than the model does.
          criteria: {
            true: 'This candidate is the action the described state calls for, and dispatching it now advances the authorized goal.',
            false: 'This candidate is not the action the described state calls for; some other eligible candidate should be dispatched first.',
          },
        };
      }
      return questions as EvaluationQuestions;
    }
  }
}

export interface Ranking {
  /** The candidate the shape's decision rule selects. */
  readonly top: string;
  /** All candidates, best first, with the raw quantity the rule ranked on. */
  readonly ordered: readonly { readonly candidate_id: string; readonly value: number }[];
  /**
   * Confidence in `top`, renormalised across the candidates so the shapes are
   * at least on a comparable [0,1] decision scale. Never compared across
   * shapes as though calibrated the same way.
   */
  readonly confidence: number;
  /** Separation between first and second, on the rule's own scale. */
  readonly margin: number;
  /** True when the rule had to break a tie, which argmax would hide. */
  readonly tied: boolean;
}

function rank(values: readonly { candidate_id: string; value: number }[]): Ranking {
  const ordered = [...values].sort((a, b) => b.value - a.value);
  const first = ordered[0];
  if (first === undefined) return { top: '', ordered: [], confidence: 0, margin: 0, tied: false };
  const second = ordered[1];
  const total = ordered.reduce((sum, entry) => sum + Math.max(0, entry.value), 0);
  return {
    top: first.candidate_id,
    ordered,
    confidence: total > 0 ? Math.max(0, first.value) / total : 0,
    margin: second === undefined ? first.value : first.value - second.value,
    tied: second !== undefined && second.value === first.value,
  };
}

/**
 * Reduce typed answers to a ranking.
 *
 * - `choice` ranks on the returned per-option probabilities when the provider
 *   publishes them, and otherwise places the chosen option first with a
 *   degenerate distribution — recorded as such rather than invented.
 * - `score` ranks on the fractional score, normalised to [0,1] by the level
 *   count so the confidence figure does not depend on scale length.
 * - `boolean` ranks on P(true) per candidate, renormalised across candidates,
 *   because the decision being scored is which candidate to dispatch.
 */
export function reduceAnswers(
  kind: EvaluationKind,
  decision: DecisionCase,
  answers: EvaluationAnswers,
): Ranking {
  switch (kind) {
    case 'choice': {
      const answer = answers['best'] as ChoiceAnswer | undefined;
      if (answer === undefined) throw new Error('choice answer missing');
      const probabilities = answer.probabilities;
      if (probabilities === undefined) {
        return {
          top: answer.choice,
          ordered: decision.candidates.map((c) => ({
            candidate_id: c.candidate_id,
            value: c.candidate_id === answer.choice ? 1 : 0,
          })),
          confidence: 1,
          margin: 1,
          tied: false,
        };
      }
      return rank(
        decision.candidates.map((c) => ({ candidate_id: c.candidate_id, value: probabilities[c.candidate_id] ?? 0 })),
      );
    }
    case 'score': {
      const levels = ADVANCEMENT_LEVELS.length - 1;
      return rank(
        decision.candidates.map((c) => {
          const answer = answers[c.candidate_id] as ScoreAnswer | undefined;
          if (answer === undefined) throw new Error(`score answer missing for ${c.candidate_id}`);
          return { candidate_id: c.candidate_id, value: answer.score / levels };
        }),
      );
    }
    case 'boolean': {
      return rank(
        decision.candidates.map((c) => {
          const answer = answers[c.candidate_id] as BooleanAnswer | undefined;
          if (answer === undefined) throw new Error(`boolean answer missing for ${c.candidate_id}`);
          return { candidate_id: c.candidate_id, value: answer.probability };
        }),
      );
    }
  }
}
