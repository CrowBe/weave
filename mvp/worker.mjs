import { DurableObject } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createApplication } from "./application.mjs";

let keys;
let keysUrl;
async function principal(request, env) {
  if (!env.ACCESS_TEAM || !/^[a-z0-9-]+$/.test(env.ACCESS_TEAM) || !env.ACCESS_AUD) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const issuer = "https://" + env.ACCESS_TEAM + ".cloudflareaccess.com";
  if (keysUrl !== issuer) {
    keys = createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs"));
    keysUrl = issuer;
  }
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: env.ACCESS_AUD,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "sub"],
  });
  return typeof payload.sub === "string" && payload.sub.length ? payload.sub : null;
}

export default {
  async fetch(request, env) {
    let actor;
    try {
      actor = await principal(request, env);
    } catch {
      actor = null;
    }
    if (!actor)
      return new Response("Sign in through the configured Cloudflare Access application.", {
        status: 403,
      });
    if (!new URL(request.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const room = env.GOALS.get(env.GOALS.idFromName(actor));
    const headers = new Headers(request.headers);
    headers.set("x-weave-owner", actor);
    return room.fetch(new Request(request, { headers }));
  },
};

export class DinnerGoal extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (env.CALENDAR_MODE === "google")
      throw new Error("Live Google calendars require the local single-operator host.");
    this.app = createApplication({
      env,
      runAI: env.AI ? (model, input) => env.AI.run(model, input) : undefined,
      get: (key) =>
        JSON.parse(
          sql.exec("SELECT value FROM kv WHERE key = ?", key).toArray()[0]?.value ?? "null",
        ),
      put: (key, value) =>
        sql.exec("INSERT OR REPLACE INTO kv VALUES (?, ?)", key, JSON.stringify(value)),
      armRecovery: () => ctx.storage.setAlarm(Date.now() + 30_000),
    });
  }
  async fetch(request) {
    const actor = request.headers.get("x-weave-owner");
    if (!actor) return new Response("Missing owner.", { status: 403 });
    return this.app.api(request, actor);
  }
  async alarm() {
    if (!this.app.hasPending()) return;
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    await this.app.resume();
  }
}
