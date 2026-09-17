import { describe, expect, it } from "vitest";
import { Fabric } from "@weave/agentfabric";
import {
  HeuristicDecisionLayer,
  identifyGap,
  type CheckEvidence,
  type DecisionLayer,
  type ExpansionEvaluation,
  type WeaveState,
} from "../src/index.ts";
import { emailNormalizeDocument, emailNormalizeScripts, emailNormalizeSource } from "../src/demo/normalize-email.ts";
import { ScriptedInferenceProvider } from "../src/inference.ts";
import { createRuntime, seedNormalizeGoal } from "./harness.ts";

const passingChecks = (overrides?: Partial<CheckEvidence>): CheckEvidence => ({
  passed: true,
  reasons: ["red demonstrated", "green proven", "held-out passed"],
  red: { demonstrated: true, rejectedBy: ["lowercases"] },
  green: { proven: true },
  heldOut: { proven: true },
  ...overrides,
});

describe("capability expansion mix", () => {
  it("identifies unnamed and unresolved gaps against the catalogue, not by generating them", () => {
    const fabric = new Fabric();
    const need = {
      purpose: "Normalize an email address",
      capabilityId: "email.normalize",
      listKey: "emails",
      outputPrefix: "normalized_email:",
      inputKey: "email",
    };
    const unnamed = identifyGap({ gap: need } as WeaveState, fabric);
    expect(unnamed?.kind).toBe("unnamed");

    fabric.register(emailNormalizeDocument);
    const unresolved = identifyGap({ gap: need } as WeaveState, fabric);
    expect(unresolved?.kind).toBe("unresolved");

    fabric.bind("email.normalize", () => ({ email: "x" }), "local");
    expect(identifyGap({ gap: need } as WeaveState, fabric)).toBeUndefined();
  });

  it("constructs an unnamed gap with inference before checks and evaluation", async () => {
    const { runtime, fabric } = createRuntime({ registerDocument: false });
    seedNormalizeGoal(runtime);
    expect(identifyGap(runtime.snapshot(), fabric)?.kind).toBe("unnamed");
    await runtime.runUntilIdle();
    const generated = runtime
      .journal()
      .filter((obs) => obs.kind === "inference_result")
      .map((obs) => obs.payload.requestKind);
    expect(generated).toEqual(["propose_contract", "propose_tests", "propose_resolver"]);
    expect(runtime.journal().map((obs) => obs.kind)).toEqual(
      expect.arrayContaining([
        "capability_registered",
        "check_event",
        "evaluation_event",
        "capability_crystallised",
      ]),
    );
    expect(identifyGap(runtime.snapshot(), fabric)).toBeUndefined();
  });

  it("rejects failed checks and does not let evaluation waive them", () => {
    const layer = new HeuristicDecisionLayer();
    const failed: CheckEvidence = passingChecks({
      passed: false,
      reasons: ["development corpus did not prove green"],
      green: { proven: false },
    });
    expect(layer.evaluate({} as WeaveState, failed).decision).toBe("reject");
    expect(layer.evaluate({} as WeaveState, passingChecks()).decision).toBe("accept");
  });

  it("refuses crystallization when a decision layer accepts a candidate that failed checks", async () => {
    class WaiveChecks implements DecisionLayer {
      readonly name = "waive-v0";
      private readonly inner = new HeuristicDecisionLayer();
      weigh(state: WeaveState, actionSpace: Parameters<DecisionLayer["weigh"]>[1]) {
        return this.inner.weigh(state, actionSpace);
      }
      evaluate(): ExpansionEvaluation {
        return {
          decision: "accept",
          weight: { value: 0.99, uncertainty: 0, basis: ["looks fine"] },
          reasons: ["waive failed checks"],
        };
      }
    }

    const { runtime, fabric } = createRuntime({
      decision: new WaiveChecks(),
      provider: new ScriptedInferenceProvider({
        ...emailNormalizeScripts(),
        propose_resolver: "return { email: input.email };",
      }),
    });
    seedNormalizeGoal(runtime);
    await runtime.runUntilIdle();

    const expansion = runtime.snapshot().expansion;
    expect(expansion?.checks?.passed).toBe(false);
    expect(expansion?.evaluation?.decision).toBe("accept");
    expect(fabric.resolutionOf("email.normalize").status).toBe("unresolved");
    expect(
      runtime.plan().rejected.some(
        (item) =>
          item.action.kind === "crystallise" &&
          item.cause === "policy" &&
          item.policy?.reasons.some((reason) => /passed checks/.test(reason)),
      ),
    ).toBe(true);
    expect(runtime.snapshot().goal.status).toBe("active");
  });

  it("escalates an uncertain evaluation to inference before crystallization", async () => {
    class UncertainDecisionLayer implements DecisionLayer {
      readonly name = "uncertain-v0";
      private readonly inner = new HeuristicDecisionLayer();
      weigh(state: WeaveState, actionSpace: Parameters<DecisionLayer["weigh"]>[1]) {
        return this.inner.weigh(state, actionSpace);
      }
      evaluate(state: WeaveState, evidence: CheckEvidence): ExpansionEvaluation {
        if (!evidence.passed) return this.inner.evaluate(state, evidence);
        return {
          decision: "uncertain",
          weight: { value: 0.5, uncertainty: 0.4, basis: ["candidate is unfamiliar"] },
          reasons: ["heuristic cannot accept"],
        };
      }
    }

    const { runtime, fabric } = createRuntime({ decision: new UncertainDecisionLayer() });
    seedNormalizeGoal(runtime);
    await runtime.runUntilIdle();

    const generated = runtime
      .journal()
      .filter((obs) => obs.kind === "inference_result")
      .map((obs) => obs.payload.requestKind);
    expect(generated).toEqual(["propose_tests", "propose_resolver", "evaluate_expansion"]);
    expect(runtime.snapshot().expansion?.evaluation?.decision).toBe("accept");
    expect(runtime.snapshot().expansion?.evaluation?.reasons).toContain("escalated evaluation accepts");
    expect(fabric.resolutionOf("email.normalize").status).toBe("resolved");
  });
});
