import { Fabric } from "@weave/agentfabric";
import {
  CheapestSufficientRouter,
  HeuristicDecisionLayer,
  Runtime,
  ScriptedInferenceProvider,
  SequenceIds,
  corePolicy,
  emailNormalizeDocument,
  emailNormalizeScripts,
  type DecisionLayer,
  type Goal,
  type InferenceProvider,
  type ModelBinding,
} from "../src/index.ts";
import { ControllableClock } from "../src/ids.ts";

export const demoGoal = (): Goal => ({
  id: "goal_normalize",
  statement: "Normalize the provided email addresses",
  scope: "demo",
  principal: "guest",
  authority: {
    canCrystallise: true,
    canCheck: true,
    canRequestInference: true,
    canCommunicate: true,
    canComplete: true,
    inferenceBudget: 12,
  },
  status: "active",
  success: { kind: "fact_for_each", listKey: "emails", factPrefix: "normalized_email:" },
});

export const localBinding: ModelBinding = {
  id: "model-local-small",
  providerId: "scripted",
  cost: 1,
  qualityScore: 0.55,
  privacy: "local",
};

export function createRuntime(options?: {
  goal?: Goal;
  provider?: InferenceProvider;
  fabric?: Fabric;
  registerDocument?: boolean;
  decision?: DecisionLayer;
  onCycle?: ConstructorParameters<typeof Runtime>[0]["onCycle"];
}): { runtime: Runtime; fabric: Fabric } {
  const fabric = options?.fabric ?? new Fabric();
  if (options?.registerDocument !== false) {
    fabric.register(emailNormalizeDocument);
  }
  const provider = options?.provider ?? new ScriptedInferenceProvider(emailNormalizeScripts());
  const runtime = new Runtime({
    goal: options?.goal ?? demoGoal(),
    decision: options?.decision ?? new HeuristicDecisionLayer(),
    policy: corePolicy(),
    fabric,
    router: new CheapestSufficientRouter([localBinding]),
    providers: new Map([["scripted", provider]]),
    ids: new SequenceIds(),
    clock: new ControllableClock(new Date("2026-09-17T00:00:00.000Z")),
    onCycle: options?.onCycle,
  });
  return { runtime, fabric };
}

export function seedNormalizeGoal(
  runtime: Runtime,
  emails = ["Foo@Example.COM", "  bar@test.org  "],
): void {
  runtime.observe({
    kind: "user_input",
    payload: {
      text: "Normalize these emails",
      facts: { emails },
      gap: {
        purpose: "Normalize an email address",
        capabilityId: "email.normalize",
        listKey: "emails",
        outputPrefix: "normalized_email:",
        inputKey: "email",
      },
    },
  });
}
