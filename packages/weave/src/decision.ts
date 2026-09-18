/**
 * The scripted decision layer for M0 (§7 step 3). Weights are compared only
 * within one `weights.recorded` observation; the rule is ordinal, not calibrated.
 */
import type { DecisionLayer, WeighRequest, WeightEntry } from './types.js';

const SCRIPTED_WEIGHTS: Readonly<Record<string, number>> = {
  'goal.complete': 1.0,
  'report.publish': 0.95,
  'report.assemble': 0.9,
  'source.inspect': 0.8,
};

export class ScriptedDecisionLayer implements DecisionLayer {
  readonly implementation = 'scripted@1';

  weigh(request: WeighRequest): readonly WeightEntry[] {
    return request.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      weight: SCRIPTED_WEIGHTS[candidate.operation] ?? 0,
    }));
  }
}
