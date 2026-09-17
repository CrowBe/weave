import { describe, expect, it } from "vitest";
import { CheapestSufficientRouter } from "../src/inference.ts";

describe("inference router", () => {
  it("selects the cheapest binding that meets the requested quality", () => {
    const router = new CheapestSufficientRouter([
      {
        id: "large",
        providerId: "provider-b",
        cost: 8,
        qualityScore: 0.95,
        privacy: "external",
      },
      {
        id: "small",
        providerId: "provider-a",
        cost: 1,
        qualityScore: 0.5,
        privacy: "local",
      },
    ]);
    const binding = router.route({ kind: "classify", quality: "min_sufficient", context: {} }, 10);
    expect(binding.id).toBe("small");
    const high = router.route({ kind: "reason", quality: "high", context: {} }, 10);
    expect(high.id).toBe("large");
  });

  it("does not route when budget cannot cover a sufficient model", () => {
    const router = new CheapestSufficientRouter([
      {
        id: "large",
        providerId: "provider-b",
        cost: 8,
        qualityScore: 0.95,
        privacy: "local",
      },
    ]);
    expect(() => router.route({ kind: "reason", quality: "high", context: {} }, 2)).toThrow(
      /budget/,
    );
  });
});
