import { describe, expect, it } from "vitest";
import { Fabric } from "../src/index.ts";

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

const source = `
const email = String(input.email ?? "").trim().toLowerCase();
const at = email.indexOf("@");
if (at <= 0 || at !== email.lastIndexOf("@") || !email.slice(at + 1)) {
  throw new Error("invalid_email");
}
return { email };
`;

describe("AgentFabric invocation", () => {
  it("keeps a named capability unresolved until crystallised", async () => {
    const fabric = new Fabric();
    fabric.register(normalize);
    expect(fabric.resolutionOf("email.normalize").status).toBe("unresolved");
    const result = await fabric.invoke("operator", "email.normalize", { email: "A@B.C" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNRESOLVED");
  });

  it("binds a resolver without granting a guest permission to invoke", async () => {
    const fabric = new Fabric();
    fabric.register(normalize);
    fabric.crystallise("operator", "email.normalize", source);
    expect(fabric.resolutionOf("email.normalize").status).toBe("resolved");
    const guest = await fabric.invoke("guest", "email.normalize", { email: "A@B.C" });
    expect(guest.ok).toBe(false);
    expect(guest.error?.code).toBe("DENIED");
    const operator = await fabric.invoke("operator", "email.normalize", { email: "A@B.C" });
    expect(operator.ok).toBe(true);
    expect(operator.output).toEqual({ email: "a@b.c" });
  });

  it("does not let a guest crystallise", () => {
    const fabric = new Fabric();
    fabric.register(normalize);
    expect(() => fabric.crystallise("guest", "email.normalize", source)).toThrow(
      /lacks privilege crystallise/,
    );
    expect(fabric.resolutionOf("email.normalize").status).toBe("unresolved");
  });
});

describe("AgentFabric authority", () => {
  const blobRead = {
    agentsop: "0.1",
    id: "blob.read",
    title: "Read blob",
    description: "Read a blob resource.",
    input: {
      type: "object",
      properties: { resource: { $ref: "#/$defs/ResourceRef" } },
      required: ["resource"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    effects: ["read"],
    idempotent: true,
    authority: { resources: ["input.resource"], effects: ["read"] },
    depends_on: [],
  };

  it("returns INVALID_REF before DENIED when a locator is smuggled in", async () => {
    const fabric = new Fabric();
    fabric.register(blobRead);
    const result = await fabric.invoke("guest", "blob.read", {
      resource: { ref: "rf_abc", kind: "blob", path: "/etc/passwd" },
    });
    expect(result.error?.code).toBe("INVALID_REF");
  });

  it("returns DENIED for an ungranted well-formed ref without revealing existence", async () => {
    const fabric = new Fabric();
    fabric.register(blobRead);
    fabric.bind("blob.read", (_ctx, input) => ({ text: String(input.resource) }), "builtin");
    const issued = fabric.resources.issue({
      kind: "blob",
      label: "notes",
      locator: "notes.md",
      created_by: "operator",
    });
    const unknown = await fabric.invoke("guest", "blob.read", {
      resource: { ref: "rf_deadbeef", kind: "blob" },
    });
    const known = await fabric.invoke("guest", "blob.read", {
      resource: { ref: issued.ref, kind: "blob" },
    });
    expect(unknown.error?.code).toBe("DENIED");
    expect(known.error?.code).toBe("DENIED");
  });
});

describe("AgentFabric composition", () => {
  it("rejects undeclared nested invokes and allows declared ones", async () => {
    const fabric = new Fabric();
    fabric.register({
      agentsop: "0.1",
      id: "text.normalize",
      title: "Normalize text",
      description: "Trim text.",
      input: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      effects: [],
      idempotent: true,
      authority: { resources: [], effects: [] },
      depends_on: [],
    });
    fabric.bind("text.normalize", (_ctx, input) => ({ text: String(input.text).trim() }), "builtin");
    fabric.register({
      agentsop: "0.1",
      id: "text.wrap",
      title: "Wrap text",
      description: "Normalize then wrap.",
      input: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      effects: [],
      idempotent: true,
      authority: { resources: [], effects: [] },
      depends_on: ["text.normalize"],
    });
    fabric.bind(
      "text.wrap",
      async (ctx, input) => {
        const inner = await ctx.invoke("text.normalize", { text: String(input.text) });
        return { text: `(${inner.text})` };
      },
      "local",
    );
    const ok = await fabric.invoke("operator", "text.wrap", { text: "  hi  " });
    expect(ok.output).toEqual({ text: "(hi)" });

    fabric.register({
      agentsop: "0.1",
      id: "text.sneak",
      title: "Sneak",
      description: "Tries an undeclared dependency.",
      input: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      effects: [],
      idempotent: true,
      authority: { resources: [], effects: [] },
      depends_on: [],
    });
    fabric.bind(
      "text.sneak",
      async (ctx, input) => ctx.invoke("text.normalize", { text: String(input.text) }),
      "bad",
    );
    const sneak = await fabric.invoke("operator", "text.sneak", { text: "x" });
    expect(sneak.error?.code).toBe("UNDECLARED_DEPENDENCY");
  });
});
