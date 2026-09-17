import type { Fabric } from "@weave/agentfabric";
import { capabilityView } from "./capabilities/index.ts";
import type { WeaveState } from "./state/index.ts";

export type ActionKind =
  | "request_inference"
  | "register_capability"
  | "classify_resolver"
  | "crystallise"
  | "invoke_capability"
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

export function enumerateActions(state: WeaveState, fabric: Fabric): Action[] {
  const actions: Action[] = [];
  const gap = state.gap;
  const work = state.classifier;
  const view = gap ? capabilityView(fabric, gap.capabilityId) : undefined;

  if (gap && !view) {
    if (work?.document) {
      actions.push({
        id: "tmp",
        kind: "register_capability",
        key: `register:${gap.capabilityId}`,
        dependsOn: [],
        input: { document: work.document },
        requiredPermissions: [],
        effects: [],
      });
    } else {
      actions.push(inferenceAction("propose_contract", { purpose: gap.purpose, capabilityId: gap.capabilityId }));
    }
  } else if (gap && view?.status !== "resolved") {
    const phase = work?.phase ?? "awaiting_corpus";
    if (!work?.corpus && (phase === "awaiting_document" || phase === "awaiting_corpus")) {
      actions.push(inferenceAction("propose_tests", { capabilityId: gap.capabilityId, document: work?.document }));
    } else if (!work?.resolverSource) {
      actions.push(inferenceAction("propose_resolver", { capabilityId: gap.capabilityId, document: work?.document }));
    } else if (phase === "awaiting_trust" || !work.trust?.trusted) {
      actions.push({
        id: "tmp",
        kind: "classify_resolver",
        key: `classify:${gap.capabilityId}`,
        dependsOn: [],
        input: { capabilityId: gap.capabilityId },
        requiredPermissions: [],
        effects: [],
      });
    } else if (phase === "awaiting_crystallise") {
      actions.push({
        id: "tmp",
        kind: "crystallise",
        key: `crystallise:${gap.capabilityId}`,
        dependsOn: [],
        input: { capabilityId: gap.capabilityId },
        requiredPermissions: [],
        effects: [],
      });
    }
  }

  if (gap && view?.status === "resolved") {
    const approval = state.approvals.find((item) => item.subject === gap.capabilityId);
    const deniedPending = Boolean(approval && !approval.granted);
    if (deniedPending && !approval?.requested) {
      actions.push({
        id: "tmp",
        kind: "request_approval",
        key: `request_approval:${gap.capabilityId}`,
        dependsOn: [],
        input: { capabilityId: gap.capabilityId, reason: "invoke returned DENIED" },
        requiredPermissions: [],
        effects: [],
      });
    }
    if (!deniedPending) {
      const items = state.facts[gap.listKey]?.value;
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemKey = String(item);
          const outputKey = `${gap.outputPrefix}${itemKey}`;
          if (outputKey in state.facts) continue;
          actions.push({
            id: "tmp",
            kind: "invoke_capability",
            key: `invoke:${gap.capabilityId}:${itemKey}`,
            dependsOn: [],
            input: {
              capabilityId: gap.capabilityId,
              item: itemKey,
              outputKey,
              capabilityInput: { [gap.inputKey]: item },
            },
            requiredPermissions: [],
            effects: view.effects,
          });
        }
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
