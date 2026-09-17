import type { Action } from "./action.ts";
import type { Weight, WeightedAction } from "./decision.ts";
import type { Policy, PolicyContext, PolicyDecision } from "./policy.ts";

export const VIABLE_WEIGHT_THRESHOLD = 0.5;

export interface FrontierRejection {
  action: Action;
  weight: Weight;
  cause: "below_threshold" | "policy";
  policy?: PolicyDecision;
}

export interface ActionFrontier {
  actionSpace: Action[];
  weighted: WeightedAction[];
  viable: WeightedAction[];
  rejected: FrontierRejection[];
}

export function buildFrontier(
  actionSpace: Action[],
  weighted: WeightedAction[],
  policy: Policy,
  ctx: PolicyContext,
): ActionFrontier {
  const rejected: FrontierRejection[] = [];
  const viable: WeightedAction[] = [];
  for (const item of weighted) {
    const decision = policy.evaluate(item.action, ctx);
    if (!decision.allowed) {
      rejected.push({
        action: item.action,
        weight: item.weight,
        cause: "policy",
        policy: decision,
      });
      continue;
    }
    if (item.weight.value < VIABLE_WEIGHT_THRESHOLD) {
      rejected.push({ action: item.action, weight: item.weight, cause: "below_threshold" });
      continue;
    }
    viable.push(item);
  }
  return { actionSpace, weighted, viable, rejected };
}
