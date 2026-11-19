import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, SignJWT, exportJWK } from "jose";

test("workerd validates Access before reaching isolated, SQLite-backed household goals", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
  const issuer = "https://test.cloudflareaccess.com";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "weave",
      modules: true,
      scriptPath: ".wrangler/verify/worker.js",
      compatibilityDate: "2026-11-18",
      bindings: { ACCESS_TEAM: "test", ACCESS_AUD: "weave-test" },
      durableObjects: { GOALS: { className: "DinnerGoal", useSQLite: true } },
      outboundService: (request) => {
        assert.equal(request.url, issuer + "/cdn-cgi/access/certs");
        return Response.json({ keys: [key] });
      },
    }),
  );
  t.after(() => mf.dispose());
  async function token(sub, audience = "weave-test") {
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setSubject(sub)
      .setAudience(audience)
      .setExpirationTime("10m")
      .sign(privateKey);
  }
  async function api(jwt, command) {
    const headers = { "content-type": "application/json" };
    if (jwt) headers["cf-access-jwt-assertion"] = jwt;
    return mf.dispatchFetch("https://weave.test/api/" + (command ? "command" : "state"), {
      method: command ? "POST" : "GET",
      headers,
      body: command ? JSON.stringify(command) : undefined,
    });
  }
  assert.equal((await api()).status, 403);
  assert.equal((await api(await token("first", "wrong"))).status, 403);
  const jwt = await token("first");
  const response = await api(jwt, {
    type: "start",
    scenario: "one",
    text: "Find a free hour for dinner on our calendars next week after 6 pm and put a hold on the family calendar. If several evenings work, ask me which.",
  });
  assert.equal(response.status, 200);
  const { state } = await response.json();
  assert.equal(state.status, "approval", JSON.stringify(state.trace));
  await mf.unsafeEvictDurableObject("weave", "DinnerGoal", { name: "first" });
  const other = await (await api(await token("second"))).json();
  assert.equal(other.state.status, "idle");
  const final = await (await api(jwt, { type: "approve", revision: state.revision })).json();
  assert.equal(final.state.receipt.slot, state.selected);
});
