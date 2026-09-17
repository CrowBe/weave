import { describe, expect, it } from "vitest";
import { createRuntime, seedNormalizeGoal } from "./harness.ts";

describe("minimal Weave loop", () => {
  it("observes, crystallizes, waits for authority, then executes and completes", async () => {
    const { runtime, registry } = createRuntime();
    seedNormalizeGoal(runtime);

    const beforeAuthority = await runtime.runUntilIdle();
    expect(beforeAuthority.length).toBeGreaterThan(0);
    expect(runtime.snapshot().crystallization?.phase).toBe("admitted");
    expect(registry.get("normalize_email")?.maturity).toBe("provisional");
    expect(runtime.snapshot().goal.status).toBe("active");
    expect(runtime.journal().some((obs) => obs.kind === "capability_result")).toBe(false);
    expect(
      runtime.cycles().some((cycle) =>
        cycle.policy.some(
          (decision) =>
            decision.key.startsWith("execute:normalize_email:") && decision.cause === "policy",
        ),
      ),
    ).toBe(true);

    const approvalRequested = runtime.journal().some((obs) => obs.kind === "approval_requested");
    expect(approvalRequested).toBe(true);

    runtime.observe({
      kind: "approval",
      payload: { subject: "normalize_email", granted: true },
    });

    const afterAuthority = await runtime.runUntilIdle();
    expect(afterAuthority.length).toBeGreaterThan(0);
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
    expect(kinds).toContain("crystallization_event");
    expect(kinds).toContain("capability_result");
    expect(kinds).toContain("goal_completed");

    const cycle = runtime.cycles()[0];
    expect(cycle?.actionSpace.length).toBeGreaterThan(0);
    expect(cycle?.weighted.length).toBeGreaterThan(0);
  });

  it("keeps generation, admission, and execution authority as separate gates", async () => {
    const { runtime, registry } = createRuntime();
    seedNormalizeGoal(runtime);
    await runtime.runUntilIdle();

    const generated = runtime
      .journal()
      .filter((obs) => obs.kind === "inference_result")
      .map((obs) => obs.payload.requestKind);
    expect(generated).toEqual([
      "propose_contract",
      "propose_tests",
      "propose_implementation",
    ]);
    expect(registry.get("normalize_email")).toBeTruthy();
    expect(runtime.snapshot().goal.status).toBe("active");
    expect(Object.keys(runtime.snapshot().facts).some((key) => key.startsWith("normalized_email:"))).toBe(
      false,
    );
  });
});
