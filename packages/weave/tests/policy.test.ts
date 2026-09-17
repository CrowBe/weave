import { describe, expect, it } from "vitest";
import {
  evaluateAdmissionEligibility,
  type AdmissionVerdict,
  type CapabilityContract,
} from "@weave/agentfabric";
import { buildFrontier } from "../src/frontier.ts";
import { HeuristicDecisionLayer } from "../src/decision.ts";
import { enumerateActions, assignActionIds } from "../src/action.ts";
import { corePolicy } from "../src/policy.ts";
import { createState, type Goal } from "../src/state.ts";
import { CapabilityRegistry } from "../src/registry.ts";
import { SequenceIds } from "../src/ids.ts";

const destructiveContract: CapabilityContract = {
  id: "wipe_tmp",
  version: "1.0.0",
  purpose: "Delete temporary files",
  inputs: { type: "object", properties: {}, required: [] },
  outputs: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  invariants: [],
  failures: [],
  effects: ["filesystem.write"],
  permissions: ["fs.write"],
  successEvidence: ["ok"],
  executionConstraints: { timeoutMs: 20 },
};

function eligibleVerdict(): AdmissionVerdict {
  return evaluateAdmissionEligibility({
    red: { kind: "demonstrated_red", demonstrated: true, rejectedBy: ["x"], passedUnexpectedly: [], results: [] },
    green: { kind: "proven_green", proven: true, results: [] },
    heldOut: { kind: "proven_green", proven: true, results: [] },
  });
}

describe("policy outranks weight", () => {
  it("blocks executing an unadmitted capability even if the decision layer wants it", () => {
    const goal: Goal = {
      id: "g",
      statement: "wipe",
      scope: "test",
      authority: {
        canCrystallize: false,
        canRequestInference: false,
        canCommunicate: false,
        canComplete: true,
        canExecute: ["wipe_tmp"],
        inferenceBudget: 0,
      },
      status: "active",
      success: { kind: "facts_present", keys: ["wiped"] },
    };
    const state = createState(goal);
    const registry = new CapabilityRegistry();
    const actions = assignActionIds(
      [
        {
          id: "tmp",
          kind: "execute_capability",
          key: "execute:wipe_tmp:/tmp/x",
          dependsOn: [],
          input: { capabilityId: "wipe_tmp", outputKey: "wiped:/tmp/x", capabilityInput: {} },
          requiredPermissions: ["fs.write"],
          effects: ["filesystem.write"],
        },
      ],
      new SequenceIds(),
    );
    const weighted = new HeuristicDecisionLayer().weigh(state, actions);
    expect(weighted[0]?.weight.value).toBeGreaterThan(0.8);
    const frontier = buildFrontier(actions, weighted, corePolicy(), { state, registry });
    expect(frontier.viable).toEqual([]);
    expect(frontier.rejected[0]?.cause).toBe("policy");
    expect(frontier.rejected[0]?.policy?.rule).toBe("execute_requires_admission");
  });

  it("blocks destructive execution without approval even when admitted and weighted highly", () => {
    const goal: Goal = {
      id: "g",
      statement: "wipe",
      scope: "test",
      authority: {
        canCrystallize: false,
        canRequestInference: false,
        canCommunicate: false,
        canComplete: true,
        canExecute: ["wipe_tmp"],
        inferenceBudget: 0,
      },
      status: "active",
      success: { kind: "facts_present", keys: ["wiped"] },
    };
    const state = createState(goal);
    state.gap = {
      purpose: "wipe tmp",
      capabilityId: "wipe_tmp",
      listKey: "targets",
      outputPrefix: "wiped:",
      inputKey: "path",
    };
    state.facts.targets = {
      key: "targets",
      value: ["/tmp/x"],
      evidenceIds: [],
      producedAt: "2026-09-17T00:00:00.000Z",
    };
    const registry = new CapabilityRegistry();
    registry.admit({
      contract: destructiveContract,
      implementation: {
        id: "wipe",
        contractId: "wipe_tmp",
        kind: "function",
        execute: () => ({ ok: true }),
        provenance: { origin: "test", generators: [] },
      },
      maturity: "provisional",
      admission: eligibleVerdict(),
      admittedAt: "2026-09-17T00:00:00.000Z",
    });
    const actions = assignActionIds(enumerateActions(state, registry), new SequenceIds());
    const weighted = new HeuristicDecisionLayer().weigh(state, actions);
    const execute = weighted.find((item) => item.action.kind === "execute_capability");
    expect(execute && execute.weight.value).toBeGreaterThan(0.8);
    const frontier = buildFrontier(actions, weighted, corePolicy(), { state, registry });
    const rejected = frontier.rejected.find((item) => item.action.kind === "execute_capability");
    expect(rejected?.cause).toBe("policy");
    expect(rejected?.policy?.rule).toBe("destructive_effects_require_approval");
  });
});
