/**
 * The scripted decision layer for M0 (§7 step 3). Weights are compared only
 * within one `weights.recorded` observation; the rule is ordinal, not calibrated.
 */
import type { DecisionLayer, WeighRequest, WeightEntry } from './types.js';

const SCRIPTED_WEIGHTS: Readonly<Record<string, number>> = {
  'goal.complete': 1.0,
  'report.publish': 0.95,
  'report.fold': 0.92,
  'report.assemble': 0.9,
  'goal.frame': 0.85,
  'source.inspect': 0.8,
  'admission.request': 0.7,
  'green.prove': 0.6,
  'implementation.generate': 0.55,
  'red.demonstrate': 0.5,
  'corpus.validate': 0.45,
  'corpus.propose': 0.4,
  'contract.establish': 0.35,
  'gap.search': 0.3,
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
