import type { Capability } from "@weave/agentsop";
import type { InferenceKind } from "../inference.ts";
import type { TestCorpus } from "../classifier/index.ts";

export const emailNormalizeDocument: Capability = {
  agentsop: "0.1",
  id: "email.normalize",
  title: "Normalize email",
  description: "Trim whitespace and lowercase an email address.",
  input: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
    additionalProperties: false,
  },
  effects: [],
  idempotent: true,
  authority: { resources: [], effects: [] },
  depends_on: [],
};

export const emailNormalizeCorpus: TestCorpus = {
  capabilityId: "email.normalize",
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
      id: "plus-tag",
      name: "held-out plus addressing",
      visibility: "held_out",
      input: { email: "User+Tag@SUB.Example.com" },
      expected: { email: "user+tag@sub.example.com" },
    },
  ],
};

export const emailNormalizeSource = `
const email = String(input.email ?? "").trim().toLowerCase();
const at = email.indexOf("@");
if (at <= 0 || at !== email.lastIndexOf("@") || !email.slice(at + 1)) {
  throw new Error("invalid_email");
}
return { email };
`.trim();

export function emailNormalizeScripts(): Partial<Record<InferenceKind, unknown>> {
  return {
    propose_contract: emailNormalizeDocument,
    propose_tests: emailNormalizeCorpus,
    propose_resolver: emailNormalizeSource,
  };
}
