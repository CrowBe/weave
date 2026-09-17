import { describe, expect, it } from "vitest";
import {
  InProcessRuntime,
  type CapabilityContract,
  type ImplementationCandidate,
} from "@weave/agentfabric";
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
import { runScheduler } from "../src/scheduler.ts";
import type { Action } from "../src/action.ts";
import type { ActionFrontier } from "../src/frontier.ts";
import type { Observation } from "../src/state.ts";

const delayContract: CapabilityContract = {
  id: "delay_echo",
  version: "1.0.0",
  purpose: "Echo after a delay",
  inputs: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  outputs: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  invariants: [],
  failures: [],
  effects: [],
  permissions: [],
  successEvidence: ["echoed value"],
  executionConstraints: { timeoutMs: 500 },
};

describe("concurrent execution", () => {
  it("runs independent capability executions at the same time", async () => {
    let current = 0;
    let max = 0;
    const implementation: ImplementationCandidate = {
      id: "delay",
      contractId: "delay_echo",
      kind: "function",
      execute: async (input) => {
        current += 1;
        max = Math.max(max, current);
        await new Promise((resolve) => setTimeout(resolve, 40));
        current -= 1;
        return input;
      },
      provenance: { origin: "test", generators: [] },
    };
    const registry = new CapabilityRegistry();
    registry.admit({
      contract: delayContract,
      implementation,
      maturity: "provisional",
      admission: {
        eligible: true,
        maturity: "provisional",
        reasons: ["test"],
        red: { kind: "demonstrated_red", demonstrated: true, rejectedBy: ["x"], passedUnexpectedly: [], results: [] },
        green: { kind: "proven_green", proven: true, results: [] },
        heldOut: { kind: "proven_green", proven: true, results: [] },
      },
      admittedAt: "2026-09-17T00:00:00.000Z",
    });
    const goal: Goal = {
      id: "parallel",
      statement: "echo two values",
      scope: "test",
      authority: {
        canCrystallize: false,
        canRequestInference: false,
        canCommunicate: false,
        canComplete: true,
        canExecute: ["delay_echo"],
        inferenceBudget: 0,
      },
      status: "active",
      success: { kind: "fact_for_each", listKey: "values", factPrefix: "echo:" },
    };
    const runtime = new Runtime({
      goal,
      decision: new HeuristicDecisionLayer(),
      policy: corePolicy(),
      registry,
      router: new CheapestSufficientRouter([localBinding]),
      providers: new Map([["scripted", new ScriptedInferenceProvider({})]]),
      ids: new SequenceIds("p_"),
      clock: new ControllableClock(new Date("2026-09-17T00:00:00.000Z")),
      fabricRuntime: new InProcessRuntime(),
    });
    runtime.observe({
      kind: "user_input",
      payload: {
        facts: { values: ["a", "b"] },
        gap: {
          purpose: "echo",
          capabilityId: "delay_echo",
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
