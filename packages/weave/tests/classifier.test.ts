import { describe, expect, it } from "vitest";
import { Fabric } from "@weave/agentfabric";
import { classifyResolver } from "../src/classifier/index.ts";
import { emailNormalizeCorpus, emailNormalizeDocument, emailNormalizeSource } from "../src/demo/normalize-email.ts";

describe("classifier trust layer", () => {
  it("refuses to trust a placeholder and trusts a corpus-backed resolver", async () => {
    const fabric = new Fabric();
    fabric.register(emailNormalizeDocument);
    const untrusted = await classifyResolver({
      fabric,
      principal: "operator",
      capability: emailNormalizeDocument,
      source: "return input;",
      corpus: emailNormalizeCorpus,
    });
    expect(untrusted.trusted).toBe(false);
    expect(untrusted.red.demonstrated).toBe(true);

    const trusted = await classifyResolver({
      fabric,
      principal: "operator",
      capability: emailNormalizeDocument,
      source: emailNormalizeSource,
      corpus: emailNormalizeCorpus,
    });
    expect(trusted.trusted).toBe(true);
    expect(fabric.resolutionOf("email.normalize").status).toBe("unresolved");
  });
});
