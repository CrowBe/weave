import type { Action } from "./action.ts";
import type { CapabilityRegistry } from "./registry.ts";
import { successCriteriaMet } from "./state.ts";
import type { WeaveState } from "./state.ts";

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  rule: string;
}

export interface PolicyContext {
  state: WeaveState;
  registry: CapabilityRegistry;
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

export const completeGoalRequiresEvidence: PolicyRule = {
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
};

export const inferenceRequiresAuthorityAndBudget: PolicyRule = {
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
};

export const crystallizationRequiresAuthority: PolicyRule = {
  name: "crystallization_requires_authority",
  evaluate(action, ctx) {
    const crystallization =
      action.kind === "demonstrate_red" ||
      action.kind === "prove_green" ||
      action.kind === "admit_capability" ||
      (action.kind === "request_inference" &&
        ["propose_contract", "propose_tests", "propose_implementation"].includes(
          String(action.input.kind ?? ""),
        ));
    if (!crystallization) return null;
    if (!ctx.state.goal.authority.canCrystallize) {
      return deny(this.name, "goal authority does not allow crystallization");
    }
    return allow(this.name);
  },
};

export const executeRequiresAdmission: PolicyRule = {
  name: "execute_requires_admission",
  evaluate(action, ctx) {
    if (action.kind !== "execute_capability") return null;
    const capabilityId = String(action.input.capabilityId ?? "");
    if (!ctx.registry.get(capabilityId)) {
      return deny(this.name, "capability is not admitted to the registry");
    }
    return allow(this.name);
  },
};

export const executeRequiresAuthorityOrApproval: PolicyRule = {
  name: "execute_requires_authority_or_approval",
  evaluate(action, ctx) {
    if (action.kind !== "execute_capability") return null;
    const capabilityId = String(action.input.capabilityId ?? "");
    const authority = ctx.state.goal.authority.canExecute;
    if (authority.includes("*") || authority.includes(capabilityId)) {
      return allow(this.name);
    }
    const approved = ctx.state.approvals.some(
      (approval) => approval.subject === capabilityId && approval.granted,
    );
    if (!approved) {
      return deny(
        this.name,
        "acquiring a capability does not grant permission to use it",
      );
    }
    return allow(this.name);
  },
};

export const destructiveEffectsRequireApproval: PolicyRule = {
  name: "destructive_effects_require_approval",
  evaluate(action, ctx) {
    const destructive = action.effects.filter(
      (effect) => effect.startsWith("filesystem.") || effect.includes("destructive"),
    );
    if (destructive.length === 0) return null;
    const capabilityId = String(action.input.capabilityId ?? action.key);
    const approved = ctx.state.approvals.some(
      (approval) => approval.subject === capabilityId && approval.granted,
    );
    if (!approved && !ctx.state.goal.authority.canExecute.includes("*")) {
      return deny(this.name, `destructive effects require approval: ${destructive.join(", ")}`);
    }
    return allow(this.name);
  },
};

export const communicateRequiresAuthority: PolicyRule = {
  name: "communicate_requires_authority",
  evaluate(action, ctx) {
    if (action.kind !== "communicate" && action.kind !== "clarify") return null;
    if (!ctx.state.goal.authority.canCommunicate) {
      return deny(this.name, "goal authority does not allow communication");
    }
    return allow(this.name);
  },
};

export function corePolicy(): ConjunctionPolicy {
  return new ConjunctionPolicy([
    completeGoalRequiresEvidence,
    inferenceRequiresAuthorityAndBudget,
    crystallizationRequiresAuthority,
    executeRequiresAdmission,
    executeRequiresAuthorityOrApproval,
    destructiveEffectsRequireApproval,
    communicateRequiresAuthority,
  ]);
}
