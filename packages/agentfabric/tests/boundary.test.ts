import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

describe("AgentFabric boundary", () => {
  it("does not import Weave runtime or scheduling modules", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files = walk(src).filter((file) => file.endsWith(".ts"));
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (
        text.includes("@weave/runtime") ||
        text.includes("packages/weave") ||
        /from ["']\.\.\/.*weave/.test(text)
      ) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
