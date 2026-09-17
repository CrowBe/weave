import {
  HeuristicDecisionLayer,
  Runtime,
  SequenceIds,
  corePolicy,
  type CycleRecord,
  type WeaveState,
} from "../packages/weave/src/index.ts";
import { ControllableClock } from "../packages/weave/src/ids.ts";
import { CapabilityRegistry } from "../packages/weave/src/registry.ts";
import {
  CheapestSufficientRouter,
  ScriptedInferenceProvider,
} from "../packages/weave/src/inference.ts";
import { normalizeEmailScripts } from "../packages/weave/src/demo/normalize-email.ts";

function formatCycle(record: CycleRecord, state: WeaveState): string {
  const lines = [
    `=== Cycle ${record.index} ===`,
    `goal: ${state.goal.status}`,
    `crystallization: ${record.crystallizationPhase ?? "none"}`,
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
      : record.policy.map(
          (item) => `  - ${item.key}  ${item.cause}: ${item.reasons.join("; ")}`,
        )),
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

const emails = ["Foo@Example.COM", "  bar@test.org  "];

const runtime = new Runtime({
  goal: {
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
  },
  decision: new HeuristicDecisionLayer(),
  policy: corePolicy(),
  registry: new CapabilityRegistry(),
  router: new CheapestSufficientRouter([
    {
      id: "model-local-small",
      providerId: "scripted",
      cost: 1,
      qualityScore: 0.55,
      privacy: "local",
    },
  ]),
  providers: new Map([["scripted", new ScriptedInferenceProvider(normalizeEmailScripts())]]),
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

console.log("Observation: user_input (emails + capability gap)\n");
await runtime.runUntilIdle();

console.log("Observation: approval granted for normalize_email\n");
runtime.observe({
  kind: "approval",
  payload: { subject: "normalize_email", granted: true },
});
await runtime.runUntilIdle();

const state = runtime.snapshot();
console.log("=== Result ===");
console.log(`status: ${state.goal.status}`);
for (const [key, fact] of Object.entries(state.facts)) {
  if (key.startsWith("normalized_email:")) {
    console.log(`${key} -> ${JSON.stringify(fact.value)}`);
  }
}
