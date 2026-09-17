import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("AgentSOP boundary", () => {
  it("does not import AgentFabric or Weave", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const violations = walk(src).filter((file) => {
      if (!file.endsWith(".ts")) return false;
      const text = readFileSync(file, "utf8");
      return text.includes("@weave/agentfabric") || text.includes("@weave/runtime");
    });
    expect(violations).toEqual([]);
  });
});
