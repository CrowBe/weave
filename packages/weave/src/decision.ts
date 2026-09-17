import type { Action } from "./action.ts";
import { successCriteriaMet } from "./state.ts";
import type { WeaveState } from "./state.ts";

export interface Weight {
  value: number;
  uncertainty: number;
  basis: string[];
}

export interface WeightedAction {
  action: Action;
  weight: Weight;
}

export interface DecisionLayer {
  readonly name: string;
  weigh(state: WeaveState, actionSpace: readonly Action[]): WeightedAction[];
}

function w(value: number, uncertainty: number, basis: string[]): Weight {
  return { value, uncertainty, basis };
}

export class HeuristicDecisionLayer implements DecisionLayer {
  readonly name = "heuristic-v0";

  weigh(state: WeaveState, actionSpace: readonly Action[]): WeightedAction[] {
    return actionSpace.map((action) => ({
      action,
      weight: this.weightOne(state, action),
    }));
  }

  private weightOne(state: WeaveState, action: Action): Weight {
    switch (action.kind) {
      case "complete_goal":
        return successCriteriaMet(state)
          ? w(0.99, 0.02, ["success evidence is present"])
          : w(0.04, 0.1, ["success evidence is missing"]);
      case "execute_capability": {
        const outputKey = String(action.input.outputKey ?? "");
        if (outputKey && outputKey in state.facts) {
          return w(0, 0, ["output already recorded"]);
        }
        return w(0.88, 0.08, ["established capability can advance the gap"]);
      }
      case "request_approval":
        return w(0.82, 0.05, ["execution authority is missing"]);
      case "request_inference": {
        const kind = String(action.input.kind ?? "");
        const phase = state.crystallization?.phase;
        if (kind === "propose_contract" && (phase === "awaiting_contract" || !phase)) {
          return w(0.91, 0.18, ["capability gap needs a contract"]);
        }
        if (kind === "propose_tests" && phase === "awaiting_tests") {
          return w(0.9, 0.16, ["contract is ready for a test corpus"]);
        }
        if (kind === "propose_implementation" && phase === "awaiting_implementation") {
          return w(0.89, 0.2, ["red demonstrated; implementation can be proposed"]);
        }
        return w(0.15, 0.35, ["inference is not the cheapest path from this state"]);
      }
      case "demonstrate_red":
        return state.crystallization?.phase === "awaiting_red"
          ? w(0.93, 0.04, ["corpus must reject a placeholder before implementation"])
          : w(0.05, 0.1, ["not awaiting red"]);
      case "prove_green":
        return state.crystallization?.phase === "awaiting_green"
          ? w(0.93, 0.04, ["candidate must prove green against the development corpus"])
          : w(0.05, 0.1, ["not awaiting green"]);
      case "admit_capability":
        return state.crystallization?.phase === "awaiting_admission"
          ? w(0.94, 0.03, ["held-out evidence can be evaluated for admission"])
          : w(0.05, 0.1, ["not awaiting admission"]);
      case "clarify":
        return w(0.72, 0.2, ["blocking question remains"]);
      case "communicate":
        return w(0.4, 0.25, ["communication is optional"]);
      case "wait":
        return w(0.2, 0.2, ["waiting is a last resort"]);
    }
  }
}
