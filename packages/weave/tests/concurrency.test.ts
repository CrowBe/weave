import { describe, expect, it } from "vitest";
import { Fabric } from "@weave/agentfabric";
import {
  HeuristicDecisionLayer,
  Runtime,
  SequenceIds,
  corePolicy,
  type Goal,
} from "../src/index.ts";
import { ControllableClock } from "../src/ids.ts";
import { CheapestSufficientRouter, ScriptedInferenceProvider } from "../src/inference.ts";
import { localBinding } from "./harness.ts";
import { runScheduler } from "../src/scheduler.ts";
import type { Action } from "../src/action.ts";
import type { ActionFrontier } from "../src/frontier.ts";
import type { Observation } from "../src/state/index.ts";

describe("concurrent invocation", () => {
  it("runs independent capability invocations at the same time", async () => {
    let current = 0;
    let max = 0;
    const fabric = new Fabric();
    fabric.register({
      agentsop: "0.1",
      id: "delay.echo",
      title: "Echo after a delay",
      description: "Echo a value.",
      input: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      effects: [],
      idempotent: true,
      authority: { resources: [], effects: [] },
      depends_on: [],
    });
    fabric.bind(
      "delay.echo",
      async (_ctx, input) => {
        current += 1;
        max = Math.max(max, current);
        await new Promise((resolve) => setTimeout(resolve, 40));
        current -= 1;
        return input;
      },
      "local",
    );
    fabric.authority.add({
      principal: "guest",
      capability: "delay.echo",
      resource: "*",
      effects: ["*"],
    });
    const goal: Goal = {
      id: "parallel",
      statement: "echo two values",
      scope: "test",
      principal: "guest",
      authority: {
        canCrystallise: false,
        canClassify: false,
        canRequestInference: false,
        canCommunicate: false,
        canComplete: true,
        inferenceBudget: 0,
      },
      status: "active",
      success: { kind: "fact_for_each", listKey: "values", factPrefix: "echo:" },
    };
    const runtime = new Runtime({
      goal,
      decision: new HeuristicDecisionLayer(),
      policy: corePolicy(),
      fabric,
      router: new CheapestSufficientRouter([localBinding]),
      providers: new Map([["scripted", new ScriptedInferenceProvider({})]]),
      ids: new SequenceIds("p_"),
      clock: new ControllableClock(new Date("2026-09-17T00:00:00.000Z")),
    });
    runtime.observe({
      kind: "user_input",
      payload: {
        facts: { values: ["a", "b"] },
        gap: {
          purpose: "echo",
          capabilityId: "delay.echo",
          listKey: "values",
          outputPrefix: "echo:",
          inputKey: "value",
        },
      },
    });
    await runtime.runUntilIdle();
    expect(max).toBeGreaterThanOrEqual(2);
    expect(runtime.snapshot().goal.status).toBe("completed");
    expect(runtime.snapshot().facts["echo:a"]?.value).toEqual({ value: "a" });
    expect(runtime.snapshot().facts["echo:b"]?.value).toEqual({ value: "b" });
  });

  it("cancels in-flight work that leaves the action frontier", async () => {
    let cancelled = false;
    const weighted = (action: Action) => ({
      action,
      weight: { value: 0.9, uncertainty: 0, basis: [] },
    });
    const fast: Action = {
      id: "a-fast",
      kind: "wait",
      key: "fast",
      dependsOn: [],
      input: {},
      requiredPermissions: [],
      effects: [],
    };
    const slow: Action = {
      id: "a-slow",
      kind: "wait",
      key: "slow",
      dependsOn: [],
      input: {},
      requiredPermissions: [],
      effects: [],
    };
    let dropSlow = false;
    const frontierOf = (): ActionFrontier => ({
      actionSpace: [fast, slow],
      weighted: [],
      viable: dropSlow ? [] : [weighted(fast), weighted(slow)],
      rejected: [],
    });
    const result = await runScheduler({
      initial: frontierOf(),
      execute: async (action, signal) => {
        if (action.key === "fast") {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return [
            {
              id: "obs_fast",
              at: new Date().toISOString(),
              kind: "timeout",
              payload: {},
            },
          ];
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          signal.addEventListener("abort", () => {
            cancelled = true;
            clearTimeout(timer);
            resolve();
          });
        });
        return [] as Observation[];
      },
      replan: () => frontierOf(),
      onObservations: () => {
        dropSlow = true;
      },
    });
    expect(cancelled).toBe(true);
    expect(result.cancelled).toContain("slow");
    expect(result.executed).toContain("fast");
  });
});
