import type { Action } from "../action.ts";
import { successCriteriaMet, type WeaveState } from "../state/index.ts";

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
    return actionSpace.map((action) => ({ action, weight: this.weightOne(state, action) }));
  }

  private weightOne(state: WeaveState, action: Action): Weight {
    switch (action.kind) {
      case "complete_goal":
        return successCriteriaMet(state)
          ? w(0.99, 0.02, ["success evidence is present"])
          : w(0.04, 0.1, ["success evidence is missing"]);
      case "invoke_capability":
        return w(0.88, 0.08, ["resolved capability can advance the gap"]);
      case "request_approval":
        return w(0.82, 0.05, ["invocation was denied"]);
      case "register_capability":
        return w(0.9, 0.1, ["AgentSOP document is ready to name"]);
      case "classify_resolver":
        return w(0.93, 0.04, ["classifier must trust a resolver before crystallization"]);
      case "crystallise":
        return w(0.94, 0.03, ["trusted resolver can be bound"]);
      case "request_inference": {
        const kind = String(action.input.kind ?? "");
        if (kind === "propose_contract") return w(0.91, 0.18, ["gap is unnamed"]);
        if (kind === "propose_tests") return w(0.9, 0.16, ["classifier needs a corpus"]);
        if (kind === "propose_resolver") return w(0.89, 0.2, ["AgentFabric needs a resolver in contract shape"]);
        return w(0.15, 0.35, ["inference is not the cheapest path"]);
      }
      case "clarify":
        return w(0.72, 0.2, ["blocking question remains"]);
      case "communicate":
        return w(0.4, 0.25, ["communication is optional"]);
      case "wait":
        return w(0.2, 0.2, ["waiting is a last resort"]);
    }
  }
}
