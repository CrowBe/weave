import { describe, expect, it } from "vitest";
import type { CapabilityContract, ImplementationCandidate, TestCorpus } from "../src/index.ts";
import {
  InProcessRuntime,
  demonstrateRed,
  evaluateAdmissionEligibility,
  evaluateHeldOut,
  placeholderImplementation,
  proveGreen,
  runCrystallizationPipeline,
} from "../src/index.ts";

const contract: CapabilityContract = {
  id: "normalize_email",
  version: "1.0.0",
  purpose: "Normalize an email address.",
  inputs: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
  },
  outputs: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
  },
  invariants: ["trimmed", "lowercase"],
  failures: [{ code: "invalid_email", when: "missing local@domain" }],
  effects: [],
  permissions: [],
  successEvidence: ["normalized email"],
  executionConstraints: { timeoutMs: 50 },
};

const corpus: TestCorpus = {
  contractId: "normalize_email",
  revision: "1",
  cases: [
    {
      id: "lowercases",
      name: "lowercases",
      visibility: "development",
      input: { email: "Foo@Example.COM" },
      expected: { email: "foo@example.com" },
    },
    {
      id: "trims",
      name: "trims",
      visibility: "development",
      input: { email: "  bar@test.org  " },
      expected: { email: "bar@test.org" },
    },
    {
      id: "empty",
      name: "empty",
      visibility: "development",
      input: { email: "" },
      expectedError: { code: "invalid_email" },
    },
    {
      id: "held",
      name: "held-out plus tag",
      visibility: "held_out",
      input: { email: "User+Tag@SUB.Example.com" },
      expected: { email: "user+tag@sub.example.com" },
    },
  ],
};

const candidate: ImplementationCandidate = {
  id: "ok",
  contractId: "normalize_email",
  kind: "local_source",
  source: `
    const email = String(input.email ?? "").trim().toLowerCase();
    const at = email.indexOf("@");
    if (at <= 0 || at !== email.lastIndexOf("@") || !email.slice(at + 1)) {
      throw { code: "invalid_email" };
    }
    return { email };
  `,
  provenance: { origin: "test", generators: ["author"] },
};

const lowercaseOnly: ImplementationCandidate = {
  id: "partial",
  contractId: "normalize_email",
  kind: "local_source",
  source: `return { email: String(input.email ?? "").toLowerCase() };`,
  provenance: { origin: "test", generators: ["author"] },
};

describe("AgentFabric crystallization lifecycle", () => {
  const runtime = new InProcessRuntime();

  it("begins with a contract, not an implementation", () => {
    expect(contract.purpose.length).toBeGreaterThan(0);
    expect(contract.inputs).toBeTruthy();
    expect(contract.outputs).toBeTruthy();
  });

  it("demonstrates red by rejecting a placeholder", async () => {
    const red = await demonstrateRed(
      contract,
      corpus,
      runtime,
      placeholderImplementation(contract.id),
    );
    expect(red.demonstrated).toBe(true);
    expect(red.rejectedBy.length).toBeGreaterThan(0);
  });

  it("does not prove green for a partial implementation", async () => {
    const green = await proveGreen(contract, corpus, lowercaseOnly, runtime);
    expect(green.proven).toBe(false);
    expect(green.results.some((result) => result.caseId === "trims" && !result.passed)).toBe(true);
  });

  it("proves green for a correct implementation and requires held-out tests for eligibility", async () => {
    const red = await demonstrateRed(contract, corpus, runtime);
    const green = await proveGreen(contract, corpus, candidate, runtime);
    const heldOut = await evaluateHeldOut(contract, corpus, candidate, runtime);
    expect(green.proven).toBe(true);
    expect(heldOut.proven).toBe(true);
    const verdict = evaluateAdmissionEligibility({ red, green, heldOut });
    expect(verdict.eligible).toBe(true);
    expect(verdict.maturity).toBe("provisional");
  });

  it("refuses admission when the corpus does not reject a placeholder", async () => {
    const weakCorpus: TestCorpus = {
      contractId: "normalize_email",
      revision: "weak",
      cases: [
        {
          id: "echo",
          name: "echo",
          visibility: "development",
          input: { email: "a@b.c" },
          expected: { email: "a@b.c" },
        },
        {
          id: "held",
          name: "held",
          visibility: "held_out",
          input: { email: "a@b.c" },
          expected: { email: "a@b.c" },
        },
      ],
    };
    const record = await runCrystallizationPipeline({
      contract,
      corpus: weakCorpus,
      candidate: placeholderImplementation(contract.id),
      runtime,
    });
    expect(record.verdict.eligible).toBe(false);
    expect(record.verdict.reasons.some((reason) => reason.includes("red was not demonstrated"))).toBe(
      true,
    );
  });

  it("refuses admission when held-out tests are missing", async () => {
    const noHeldOut: TestCorpus = {
      ...corpus,
      cases: corpus.cases.filter((testCase) => testCase.visibility === "development"),
    };
    const record = await runCrystallizationPipeline({
      contract,
      corpus: noHeldOut,
      candidate,
      runtime,
    });
    expect(record.verdict.eligible).toBe(false);
    expect(record.verdict.reasons.some((reason) => reason.includes("held-out"))).toBe(true);
  });
});
