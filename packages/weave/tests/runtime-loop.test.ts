import { describe, expect, it } from "vitest";
import { createRuntime, seedNormalizeGoal } from "./harness.ts";

describe("minimal Weave loop", () => {
  it("classifies a resolver, crystallises through AgentFabric, then invokes only after a grant", async () => {
    const { runtime, fabric } = createRuntime();
    seedNormalizeGoal(runtime);

    const beforeGrant = await runtime.runUntilIdle();
    expect(beforeGrant.length).toBeGreaterThan(0);
    expect(runtime.snapshot().classifier?.phase).toBe("ready");
    expect(fabric.resolutionOf("email.normalize").status).toBe("resolved");
    expect(runtime.snapshot().goal.status).toBe("active");
    expect(
      Object.keys(runtime.snapshot().facts).some((key) => key.startsWith("normalized_email:")),
    ).toBe(false);

    runtime.observe({
      kind: "approval",
      payload: { subject: "email.normalize", granted: true },
    });
    await runtime.runUntilIdle();

    const state = runtime.snapshot();
    expect(state.goal.status).toBe("completed");
    expect(state.facts["normalized_email:Foo@Example.COM"]?.value).toEqual({
      email: "foo@example.com",
    });
    expect(state.facts["normalized_email:  bar@test.org  "]?.value).toEqual({
      email: "bar@test.org",
    });
    const kinds = runtime.journal().map((obs) => obs.kind);
    expect(kinds).toContain("inference_result");
    expect(kinds).toContain("classifier_event");
    expect(kinds).toContain("capability_crystallised");
    expect(kinds).toContain("capability_result");
    expect(kinds).toContain("goal_completed");
  });

  it("keeps generation, classification, crystallization, and invocation as separate gates", async () => {
    const { runtime, fabric } = createRuntime();
    seedNormalizeGoal(runtime);
    await runtime.runUntilIdle();
    const generated = runtime
      .journal()
      .filter((obs) => obs.kind === "inference_result")
      .map((obs) => obs.payload.requestKind);
    expect(generated).toEqual(["propose_tests", "propose_resolver"]);
    expect(fabric.resolutionOf("email.normalize").status).toBe("resolved");
    expect(runtime.snapshot().goal.status).toBe("active");
    expect(
      runtime.journal().some((obs) => obs.kind === "capability_result" && obs.payload.denied === true),
    ).toBe(true);
  });
});
