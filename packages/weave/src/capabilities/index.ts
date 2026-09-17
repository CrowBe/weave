import type { Fabric } from "@weave/agentfabric";
import type { CapabilityView } from "@weave/agentfabric";

export function assembleCapabilities(fabric: Fabric): CapabilityView[] {
  return fabric.list();
}

export function capabilityView(fabric: Fabric, id: string): CapabilityView | undefined {
  if (!fabric.has(id)) return undefined;
  return fabric.resolutionOf(id);
}
