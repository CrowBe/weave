import type {
  CapabilityContract,
  ImplementationCandidate,
  TestCorpus,
} from "@weave/agentfabric";
import type { InferenceKind } from "../inference.ts";

export const normalizeEmailContract: CapabilityContract = {
  id: "normalize_email",
  version: "1.0.0",
  purpose: "Normalize an email address by trimming whitespace and lowercasing it.",
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
  invariants: [
    "output.email is trimmed",
    "output.email is lowercase",
    "output.email contains a local part and a domain",
  ],
  failures: [{ code: "invalid_email", when: "the input is empty or lacks a valid local@domain shape" }],
  effects: [],
  permissions: [],
  successEvidence: ["output.email matches the normalized form of a valid input"],
  executionConstraints: { timeoutMs: 50 },
};

export const normalizeEmailCorpus: TestCorpus = {
  contractId: "normalize_email",
  revision: "1",
  cases: [
    {
      id: "lowercases",
      name: "lowercases mixed-case addresses",
      visibility: "development",
      input: { email: "Foo@Example.COM" },
      expected: { email: "foo@example.com" },
    },
    {
      id: "trims",
      name: "trims surrounding whitespace",
      visibility: "development",
      input: { email: "  bar@test.org  " },
      expected: { email: "bar@test.org" },
    },
    {
      id: "empty",
      name: "rejects an empty string",
      visibility: "development",
      input: { email: "" },
      expectedError: { code: "invalid_email" },
    },
    {
      id: "missing-at",
      name: "rejects a value without @",
      visibility: "development",
      input: { email: "not-an-email" },
      expectedError: { code: "invalid_email" },
    },
    {
      id: "plus-tag",
      name: "held-out plus addressing and subdomain case",
      visibility: "held_out",
      input: { email: "User+Tag@SUB.Example.com" },
      expected: { email: "user+tag@sub.example.com" },
    },
  ],
};

export const normalizeEmailSource = `
const email = String(input.email ?? "").trim().toLowerCase();
const at = email.indexOf("@");
if (at <= 0 || at !== email.lastIndexOf("@")) {
  throw { code: "invalid_email", message: "invalid_email" };
}
const domain = email.slice(at + 1);
if (!domain) {
  throw { code: "invalid_email", message: "invalid_email" };
}
return { email };
`.trim();

export const lowercaseOnlySource = `
return { email: String(input.email ?? "").toLowerCase() };
`.trim();

export function normalizeEmailCandidate(): ImplementationCandidate {
  return {
    id: "normalize_email:local:1",
    contractId: "normalize_email",
    kind: "local_source",
    source: normalizeEmailSource,
    provenance: {
      origin: "scripted-inference",
      generators: ["propose_implementation"],
    },
  };
}

export function normalizeEmailScripts(): Partial<Record<InferenceKind, unknown>> {
  return {
    propose_contract: normalizeEmailContract,
    propose_tests: normalizeEmailCorpus,
    propose_implementation: normalizeEmailCandidate(),
  };
}
