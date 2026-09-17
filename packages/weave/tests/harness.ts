import {
  CheapestSufficientRouter,
  HeuristicDecisionLayer,
  Runtime,
  ScriptedInferenceProvider,
  SequenceIds,
  corePolicy,
  normalizeEmailScripts,
  type Goal,
  type InferenceProvider,
  type ModelBinding,
} from "../src/index.ts";
import { ControllableClock } from "../src/ids.ts";
import { CapabilityRegistry } from "../src/registry.ts";

export const demoGoal = (): Goal => ({
  id: "goal_normalize",
  statement: "Normalize the provided email addresses",
  scope: "demo",
  authority: {
    canCrystallize: true,
    canRequestInference: true,
    canCommunicate: true,
    canComplete: true,
    canExecute: [],
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
  registry?: CapabilityRegistry;
  onCycle?: ConstructorParameters<typeof Runtime>[0]["onCycle"];
}): { runtime: Runtime; registry: CapabilityRegistry } {
  const registry = options?.registry ?? new CapabilityRegistry();
  const provider = options?.provider ?? new ScriptedInferenceProvider(normalizeEmailScripts());
  const runtime = new Runtime({
    goal: options?.goal ?? demoGoal(),
    decision: new HeuristicDecisionLayer(),
    policy: corePolicy(),
    registry,
    router: new CheapestSufficientRouter([localBinding]),
    providers: new Map([["scripted", provider]]),
    ids: new SequenceIds(),
    clock: new ControllableClock(new Date("2026-09-17T00:00:00.000Z")),
    onCycle: options?.onCycle,
  });
  return { runtime, registry };
}

export function seedNormalizeGoal(runtime: Runtime, emails = ["Foo@Example.COM", "  bar@test.org  "]): void {
  runtime.observe({
    kind: "user_input",
    payload: {
      text: "Normalize these emails",
      facts: { emails },
      gap: {
        purpose: "Normalize an email address",
        capabilityId: "normalize_email",
        listKey: "emails",
        outputPrefix: "normalized_email:",
        inputKey: "email",
      },
    },
  });
}
