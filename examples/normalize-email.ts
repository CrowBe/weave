import { Fabric } from "@weave/agentfabric";
import {
  HeuristicDecisionLayer,
  Runtime,
  SequenceIds,
  corePolicy,
  emailNormalizeDocument,
  emailNormalizeScripts,
  type CycleRecord,
  type WeaveState,
} from "../packages/weave/src/index.ts";
import { ControllableClock } from "../packages/weave/src/ids.ts";
import {
  CheapestSufficientRouter,
  ScriptedInferenceProvider,
} from "../packages/weave/src/inference.ts";

function formatCycle(record: CycleRecord, state: WeaveState): string {
  const lines = [
    `=== Cycle ${record.index} ===`,
    `goal: ${state.goal.status}  principal: ${state.goal.principal}`,
    `classifier: ${record.classifierPhase ?? "none"}`,
    `facts: ${record.factKeys.join(", ") || "(none)"}`,
    "action space:",
    ...record.actionSpace.map((action) => `  - ${action.kind}  ${action.key}`),
    "weights:",
    ...record.weighted.map(
      (item) =>
        `  - ${item.kind}  ${item.key}  weight=${item.value.toFixed(2)}  uncertainty=${item.uncertainty.toFixed(2)}  (${item.basis.join("; ")})`,
    ),
    "policy rejections:",
    ...(record.policy.length === 0
      ? ["  - (none)"]
      : record.policy.map((item) => `  - ${item.key}  ${item.cause}: ${item.reasons.join("; ")}`)),
    `viable: ${record.viable.join(", ") || "(none)"}`,
    `executed: ${record.executed.join(", ") || "(none)"}`,
    "observations:",
    ...(record.resultingObservations.length === 0
      ? ["  - (none)"]
      : record.resultingObservations.map((observation) => {
          const detail = observation.detail ? `:${observation.detail}` : "";
          return `  - ${observation.kind}${detail}`;
        })),
  ];
  return lines.join("\n");
}

const fabric = new Fabric();
fabric.register(emailNormalizeDocument);

const runtime = new Runtime({
  goal: {
    id: "goal_normalize",
    statement: "Normalize the provided email addresses",
    scope: "demo",
    principal: "guest",
    authority: {
      canCrystallise: true,
      canClassify: true,
      canRequestInference: true,
      canCommunicate: true,
      canComplete: true,
      inferenceBudget: 12,
    },
    status: "active",
    success: { kind: "fact_for_each", listKey: "emails", factPrefix: "normalized_email:" },
  },
  decision: new HeuristicDecisionLayer(),
  policy: corePolicy(),
  fabric,
  router: new CheapestSufficientRouter([
    {
      id: "model-local-small",
      providerId: "scripted",
      cost: 1,
      qualityScore: 0.55,
      privacy: "local",
    },
  ]),
  providers: new Map([["scripted", new ScriptedInferenceProvider(emailNormalizeScripts())]]),
  ids: new SequenceIds(),
  clock: new ControllableClock(new Date("2026-09-17T00:00:00.000Z")),
  onCycle(record, state) {
    console.log(formatCycle(record, state));
    console.log("");
  },
});

runtime.observe({
  kind: "user_input",
  payload: {
    text: "Normalize these emails",
    facts: { emails: ["Foo@Example.COM", "  bar@test.org  "] },
    gap: {
      purpose: "Normalize an email address",
      capabilityId: "email.normalize",
      listKey: "emails",
      outputPrefix: "normalized_email:",
      inputKey: "email",
    },
  },
});

console.log("Observation: user_input (emails + capability gap)\n");
await runtime.runUntilIdle();

console.log("Observation: approval granted for email.normalize\n");
runtime.observe({
  kind: "approval",
  payload: { subject: "email.normalize", granted: true },
});
await runtime.runUntilIdle();

const state = runtime.snapshot();
console.log("=== Result ===");
console.log(`status: ${state.goal.status}`);
console.log(`fabric: ${fabric.resolutionOf("email.normalize").status}`);
for (const [key, fact] of Object.entries(state.facts)) {
  if (key.startsWith("normalized_email:")) {
    console.log(`${key} -> ${JSON.stringify(fact.value)}`);
  }
}
