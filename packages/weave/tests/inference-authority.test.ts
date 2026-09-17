import { describe, expect, it } from "vitest";
import {
  HeuristicDecisionLayer,
  Runtime,
  SequenceIds,
  corePolicy,
  type Goal,
} from "../src/index.ts";
import { ControllableClock } from "../src/ids.ts";
import { CapabilityRegistry } from "../src/registry.ts";
import { CheapestSufficientRouter, ScriptedInferenceProvider } from "../src/inference.ts";
import { localBinding } from "./harness.ts";

describe("inference is an observation", () => {
  it("does not complete a goal just because a model said to", async () => {
    const goal: Goal = {
      id: "goal_authority",
      statement: "Do not trust a fluent completion",
      scope: "test",
      authority: {
        canCrystallize: false,
        canRequestInference: true,
        canCommunicate: true,
        canComplete: true,
        canExecute: [],
        inferenceBudget: 5,
      },
      status: "active",
      success: { kind: "facts_present", keys: ["done"] },
    };
    const runtime = new Runtime({
      goal,
      decision: new HeuristicDecisionLayer(),
      policy: corePolicy(),
      registry: new CapabilityRegistry(),
      router: new CheapestSufficientRouter([localBinding]),
      providers: new Map([
        [
          "scripted",
          new ScriptedInferenceProvider({
            reason: { action: { kind: "complete_goal" }, commentary: "looks done to me" },
          }),
        ],
      ]),
      ids: new SequenceIds("auth_"),
      clock: new ControllableClock(new Date("2026-09-17T00:00:00.000Z")),
    });

    runtime.observe({
      kind: "user_input",
      payload: { text: "Please finish", facts: { prompt: "finish" } },
    });

    const frontier = runtime.plan();
    const complete = frontier.actionSpace.find((action) => action.kind === "complete_goal");
    expect(complete).toBeTruthy();
    expect(
      frontier.rejected.some(
        (item) => item.action.kind === "complete_goal" && item.cause === "policy",
      ),
    ).toBe(true);

    runtime.observe({
      kind: "inference_result",
      payload: {
        requestKind: "reason",
        output: { action: { kind: "complete_goal" } },
        cost: 1,
      },
    });

    expect(runtime.snapshot().goal.status).toBe("active");
    expect(runtime.snapshot().facts.done).toBeUndefined();
    const after = runtime.plan();
    expect(after.viable.some((item) => item.action.kind === "complete_goal")).toBe(false);
  });
});
