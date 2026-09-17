import type { Action } from "./action.ts";
import type { Fabric } from "@weave/agentfabric";
import { successCriteriaMet, type WeaveState } from "./state/index.ts";

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  rule: string;
}

export interface PolicyContext {
  state: WeaveState;
  fabric: Fabric;
}

export interface PolicyRule {
  name: string;
  evaluate(action: Action, ctx: PolicyContext): PolicyDecision | null;
}

export interface Policy {
  evaluate(action: Action, ctx: PolicyContext): PolicyDecision;
}

function allow(rule: string, reasons: string[] = []): PolicyDecision {
  return { allowed: true, reasons, rule };
}

function deny(rule: string, reason: string): PolicyDecision {
  return { allowed: false, reasons: [reason], rule };
}

export class ConjunctionPolicy implements Policy {
  constructor(private readonly rules: PolicyRule[]) {}

  evaluate(action: Action, ctx: PolicyContext): PolicyDecision {
    const reasons: string[] = [];
    for (const rule of this.rules) {
      const decision = rule.evaluate(action, ctx);
      if (!decision) continue;
      if (!decision.allowed) return decision;
      reasons.push(...decision.reasons);
    }
    return allow("conjunction", reasons);
  }
}

export function corePolicy(): ConjunctionPolicy {
  return new ConjunctionPolicy([
    {
      name: "complete_goal_requires_evidence",
      evaluate(action, ctx) {
        if (action.kind !== "complete_goal") return null;
        if (!ctx.state.goal.authority.canComplete) {
          return deny(this.name, "goal authority does not allow completion");
        }
        if (!successCriteriaMet(ctx.state)) {
          return deny(this.name, "complete_goal requires success evidence");
        }
        return allow(this.name);
      },
    },
    {
      name: "inference_requires_authority_and_budget",
      evaluate(action, ctx) {
        if (action.kind !== "request_inference") return null;
        if (!ctx.state.goal.authority.canRequestInference) {
          return deny(this.name, "goal authority does not allow inference");
        }
        const cost = action.estimatedCost ?? 1;
        if (ctx.state.goal.authority.inferenceBudget < cost) {
          return deny(this.name, "inference budget is exhausted");
        }
        return allow(this.name);
      },
    },
    {
      name: "check_requires_authority",
      evaluate(action, ctx) {
        if (action.kind !== "check_candidate") return null;
        if (!ctx.state.goal.authority.canCheck) {
          return deny(this.name, "goal authority does not allow checks");
        }
        return allow(this.name);
      },
    },
    {
      name: "evaluate_requires_check_evidence",
      evaluate(action, ctx) {
        if (action.kind !== "evaluate_candidate") return null;
        if (!ctx.state.expansion?.checks) {
          return deny(this.name, "evaluation requires check evidence");
        }
        return allow(this.name);
      },
    },
    {
      name: "crystallise_requires_authority",
      evaluate(action, ctx) {
        if (action.kind !== "crystallise" && action.kind !== "register_capability") return null;
        if (!ctx.state.goal.authority.canCrystallise) {
          return deny(this.name, "goal authority does not allow crystallization");
        }
        return allow(this.name);
      },
    },
    {
      name: "crystallise_requires_passed_checks_and_accept",
      evaluate(action, ctx) {
        if (action.kind !== "crystallise") return null;
        if (!ctx.state.expansion?.checks?.passed) {
          return deny(
            this.name,
            "crystallization requires passed checks; evaluation cannot waive them",
          );
        }
        if (ctx.state.expansion.evaluation?.decision !== "accept") {
          return deny(this.name, "crystallization requires an accept evaluation");
        }
        return allow(this.name);
      },
    },
    {
      name: "communicate_requires_authority",
      evaluate(action, ctx) {
        if (action.kind !== "communicate" && action.kind !== "clarify") return null;
        if (!ctx.state.goal.authority.canCommunicate) {
          return deny(this.name, "goal authority does not allow communication");
        }
        return allow(this.name);
      },
    },
  ]);
}
