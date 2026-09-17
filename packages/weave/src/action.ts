import type { Fabric } from "@weave/agentfabric";
import { capabilityView, identifyGap } from "./capabilities/index.ts";
import type { WeaveState } from "./state/index.ts";

export type ActionKind =
  | "request_inference"
  | "register_capability"
  | "check_candidate"
  | "evaluate_candidate"
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
  const need = state.gap;
  const work = state.expansion;
  const gap = identifyGap(state, fabric);
  const view = need ? capabilityView(fabric, need.capabilityId) : undefined;

  if (gap?.kind === "unnamed") {
    if (work?.document) {
      actions.push({
        id: "tmp",
        kind: "register_capability",
        key: `register:${gap.need.capabilityId}`,
        dependsOn: [],
        input: { document: work.document },
        requiredPermissions: [],
        effects: [],
      });
    } else {
      actions.push(
        inferenceAction("propose_contract", {
          purpose: gap.need.purpose,
          capabilityId: gap.need.capabilityId,
        }),
      );
    }
  } else if (gap?.kind === "unresolved") {
    const phase = work?.phase ?? "awaiting_corpus";
    if (!work?.corpus && (phase === "awaiting_document" || phase === "awaiting_corpus")) {
      actions.push(
        inferenceAction("propose_tests", {
          capabilityId: gap.need.capabilityId,
          document: work?.document,
        }),
      );
    } else if (!work?.resolverSource) {
      actions.push(
        inferenceAction("propose_resolver", {
          capabilityId: gap.need.capabilityId,
          document: work?.document,
        }),
      );
    } else if (!work.checks) {
      actions.push({
        id: "tmp",
        kind: "check_candidate",
        key: `check:${gap.need.capabilityId}`,
        dependsOn: [],
        input: { capabilityId: gap.need.capabilityId },
        requiredPermissions: [],
        effects: [],
      });
    } else if (!work.evaluation) {
      actions.push({
        id: "tmp",
        kind: "evaluate_candidate",
        key: `evaluate:${gap.need.capabilityId}`,
        dependsOn: [],
        input: { capabilityId: gap.need.capabilityId },
        requiredPermissions: [],
        effects: [],
      });
    } else if (work.evaluation.decision === "uncertain") {
      actions.push(
        inferenceAction("evaluate_expansion", {
          capabilityId: gap.need.capabilityId,
          checks: work.checks,
          evaluation: work.evaluation,
        }),
      );
    } else if (work.evaluation.decision === "accept") {
      actions.push({
        id: "tmp",
        kind: "crystallise",
        key: `crystallise:${gap.need.capabilityId}`,
        dependsOn: [],
        input: { capabilityId: gap.need.capabilityId },
        requiredPermissions: [],
        effects: [],
      });
    }
  }

  if (need && view?.status === "resolved") {
    const approval = state.approvals.find((item) => item.subject === need.capabilityId);
    const deniedPending = Boolean(approval && !approval.granted);
    if (deniedPending && !approval?.requested) {
      actions.push({
        id: "tmp",
        kind: "request_approval",
        key: `request_approval:${need.capabilityId}`,
        dependsOn: [],
        input: { capabilityId: need.capabilityId, reason: "invoke returned DENIED" },
        requiredPermissions: [],
        effects: [],
      });
    }
    if (!deniedPending) {
      const items = state.facts[need.listKey]?.value;
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemKey = String(item);
          const outputKey = `${need.outputPrefix}${itemKey}`;
          if (outputKey in state.facts) continue;
          actions.push({
            id: "tmp",
            kind: "invoke_capability",
            key: `invoke:${need.capabilityId}:${itemKey}`,
            dependsOn: [],
            input: {
              capabilityId: need.capabilityId,
              item: itemKey,
              outputKey,
              capabilityInput: { [need.inputKey]: item },
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
