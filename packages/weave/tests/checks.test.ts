import { describe, expect, it } from "vitest";
import { Fabric } from "@weave/agentfabric";
import { checkCandidate } from "../src/checks/index.ts";
import { emailNormalizeCorpus, emailNormalizeDocument, emailNormalizeSource } from "../src/demo/normalize-email.ts";

describe("deterministic capability checks", () => {
  it("refuses a placeholder and passes a corpus-backed resolver", async () => {
    const fabric = new Fabric();
    fabric.register(emailNormalizeDocument);
    const failed = await checkCandidate({
      fabric,
      principal: "operator",
      capability: emailNormalizeDocument,
      source: "return input;",
      corpus: emailNormalizeCorpus,
    });
    expect(failed.passed).toBe(false);
    expect(failed.red.demonstrated).toBe(true);

    const passed = await checkCandidate({
      fabric,
      principal: "operator",
      capability: emailNormalizeDocument,
      source: emailNormalizeSource,
      corpus: emailNormalizeCorpus,
    });
    expect(passed.passed).toBe(true);
    expect(fabric.resolutionOf("email.normalize").status).toBe("unresolved");
  });
});
