import type { CapabilityRegistry } from "./registry.ts";
import type { WeaveState } from "./state.ts";

export type ActionKind =
  | "request_inference"
  | "execute_capability"
  | "demonstrate_red"
  | "prove_green"
  | "admit_capability"
  | "request_approval"
  | "clarify"
  | "communicate"
  | "wait"
  | "complete_goal";

export interface Action {
  id: string;
  kind: ActionKind;
  key: string;
  threadId?: string;
  dependsOn: string[];
  input: Record<string, unknown>;
  requiredPermissions: string[];
  effects: string[];
  estimatedCost?: number;
}

export function enumerateActions(state: WeaveState, registry: CapabilityRegistry): Action[] {
  const actions: Action[] = [];
  const gap = state.gap;
  const admitted = gap ? registry.get(gap.capabilityId) : undefined;

  if (gap && !admitted) {
    const phase = state.crystallization?.phase ?? "awaiting_contract";
    switch (phase) {
      case "awaiting_contract":
        actions.push(
          inferenceAction("propose_contract", {
            purpose: gap.purpose,
            capabilityId: gap.capabilityId,
          }),
        );
        break;
      case "awaiting_tests":
        actions.push(
          inferenceAction("propose_tests", {
            contract: state.crystallization?.contract,
          }),
        );
        break;
      case "awaiting_red":
        actions.push({
          id: "tmp",
          kind: "demonstrate_red",
          key: `demonstrate_red:${gap.capabilityId}`,
          dependsOn: [],
          input: { capabilityId: gap.capabilityId },
          requiredPermissions: [],
          effects: [],
        });
        break;
      case "awaiting_implementation":
        actions.push(
          inferenceAction("propose_implementation", {
            contract: state.crystallization?.contract,
            corpus: state.crystallization?.corpus,
          }),
        );
        break;
      case "awaiting_green":
        actions.push({
          id: "tmp",
          kind: "prove_green",
          key: `prove_green:${gap.capabilityId}`,
          dependsOn: [],
          input: { capabilityId: gap.capabilityId },
          requiredPermissions: [],
          effects: [],
        });
        break;
      case "awaiting_admission":
        actions.push({
          id: "tmp",
          kind: "admit_capability",
          key: `admit_capability:${gap.capabilityId}`,
          dependsOn: [],
          input: { capabilityId: gap.capabilityId },
          requiredPermissions: [],
          effects: [],
        });
        break;
      default:
        break;
    }
  }

  if (gap && admitted) {
    const authorized = canExecute(state, gap.capabilityId);
    if (!authorized) {
      const approval = state.approvals.find((item) => item.subject === gap.capabilityId);
      if (!approval?.requested) {
        actions.push({
          id: "tmp",
          kind: "request_approval",
          key: `request_approval:${gap.capabilityId}`,
          dependsOn: [],
          input: {
            capabilityId: gap.capabilityId,
            reason: "admitted capability is not in goal authority",
          },
          requiredPermissions: [],
          effects: [],
        });
      }
    }
    const items = state.facts[gap.listKey]?.value;
    if (Array.isArray(items)) {
      for (const item of items) {
        const itemKey = String(item);
        const outputKey = `${gap.outputPrefix}${itemKey}`;
        if (outputKey in state.facts) continue;
        actions.push({
          id: "tmp",
          kind: "execute_capability",
          key: `execute:${gap.capabilityId}:${itemKey}`,
          dependsOn: [],
          input: {
            capabilityId: gap.capabilityId,
            item: itemKey,
            outputKey,
            capabilityInput: { [gap.inputKey]: item },
          },
          requiredPermissions: admitted.contract.permissions,
          effects: admitted.contract.effects,
        });
      }
    }
  }

  actions.push({
    id: "tmp",
    kind: "complete_goal",
    key: `complete_goal:${state.goal.id}`,
    dependsOn: [],
    input: { goalId: state.goal.id },
    requiredPermissions: [],
    effects: [],
  });

  const blocking = state.openQuestions.filter((question) => question.blocking && !question.asked);
  if (blocking.length > 0) {
    actions.push({
      id: "tmp",
      kind: "clarify",
      key: "clarify:blocking",
      dependsOn: [],
      input: { questions: blocking.map((question) => question.prompt) },
      requiredPermissions: [],
      effects: [],
    });
  }

  return actions;
}

export function canExecute(state: WeaveState, capabilityId: string): boolean {
  if (state.goal.authority.canExecute.includes("*")) return true;
  if (state.goal.authority.canExecute.includes(capabilityId)) return true;
  return state.approvals.some((approval) => approval.subject === capabilityId && approval.granted);
}

function inferenceAction(kind: string, context: Record<string, unknown>): Action {
  return {
    id: "tmp",
    kind: "request_inference",
    key: `request_inference:${kind}`,
    dependsOn: [],
    input: { kind, quality: "min_sufficient", context },
    requiredPermissions: [],
    effects: [],
    estimatedCost: 1,
  };
}

export function assignActionIds(actions: Action[], ids: { next(kind: string): string }): Action[] {
  return actions.map((action) => ({ ...action, id: ids.next("action") }));
}
