import type { CapabilityView, Fabric } from "@weave/agentfabric";
import type { CapabilityGap, WeaveState } from "../state/index.ts";

export function assembleCapabilities(fabric: Fabric): CapabilityView[] {
  return fabric.list();
}

export function capabilityView(fabric: Fabric, id: string): CapabilityView | undefined {
  if (!fabric.has(id)) return undefined;
  return fabric.resolutionOf(id);
}

export type GapKind = "unnamed" | "unresolved";

export interface IdentifiedGap {
  need: CapabilityGap;
  kind: GapKind;
  reason: string;
}

export function identifyGap(state: WeaveState, fabric: Fabric): IdentifiedGap | undefined {
  const need = state.gap;
  if (!need) return undefined;
  if (!fabric.has(need.capabilityId)) {
    return {
      need,
      kind: "unnamed",
      reason: "catalogue has no AgentSOP document for the stated need",
    };
  }
  const status = fabric.resolutionOf(need.capabilityId).status;
  if (status !== "resolved") {
    return {
      need,
      kind: "unresolved",
      reason: `named capability is ${status}`,
    };
  }
  return undefined;
}
