import { describe, expect, it } from "vitest";
import { InvalidRef, parseResourceRef, validateAgainst, validateCapabilityDocument } from "../src/index.ts";

const normalize = {
  agentsop: "0.1",
  id: "email.normalize",
  title: "Normalize email",
  description: "Trim and lowercase an email address.",
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

describe("AgentSOP documents", () => {
  it("accepts a 0.1 capability document", () => {
    const capability = validateCapabilityDocument(normalize);
    expect(capability.id).toBe("email.normalize");
    expect(capability.effects).toEqual([]);
  });

  it("rejects locators smuggled onto a ResourceRef", () => {
    expect(() =>
      parseResourceRef({ ref: "rf_abc123", kind: "blob", path: "/etc/passwd" }),
    ).toThrow(InvalidRef);
  });

  it("rejects extra input fields when additionalProperties is false", () => {
    const capability = validateCapabilityDocument(normalize);
    expect(() => validateAgainst(capability.input, { email: "a@b.c", extra: true })).toThrow(
      /unexpected fields/,
    );
  });
});
