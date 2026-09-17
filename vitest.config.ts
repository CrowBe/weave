import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@weave/agentsop": path.resolve("packages/agentsop/src/index.ts"),
      "@weave/agentfabric": path.resolve("packages/agentfabric/src/index.ts"),
      "@weave/runtime": path.resolve("packages/weave/src/index.ts"),
    },
  },
});
