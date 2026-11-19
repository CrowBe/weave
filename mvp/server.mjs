import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createApplication } from "./application.mjs";

export function restInference(env) {
  if (!env.CLOUDFLARE_ACCOUNT_ID && !env.CLOUDFLARE_API_TOKEN) return undefined;
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN)
    throw new Error("Set both Workers AI credentials.");
  return async (model, input) => {
    const response = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" +
        encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID) +
        "/ai/run/" +
        model,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error("Workers AI returned HTTP " + response.status);
    const body = await response.json();
    if (!body.success) throw new Error("Workers AI rejected the request.");
    return body.result;
  };
}

export async function startServer({
  env = process.env,
  port = Number(env.PORT ?? 5186),
  database = env.WEAVE_DATABASE ??
    fileURLToPath(new URL("../.local/calendar.sqlite", import.meta.url)),
} = {}) {
  mkdirSync(dirname(resolve(database)), { recursive: true });
  const db = new DatabaseSync(database);
  try {
    db.exec(
      "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); COMMIT",
    );
  } catch (error) {
    db.close();
    throw error;
  }
  const read = db.prepare("SELECT value FROM kv WHERE key = ?");
  const write = db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)");
  let timer;
  let closing = false;
  function armRecovery() {
    if (timer || closing) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (!app.hasPending() || closing) return;
      try {
        await app.resume();
      } catch {
        console.error("Goal recovery interrupted. Retrying.");
      } finally {
        if (!closing && app.hasPending()) armRecovery();
      }
    }, 30_000);
    timer.unref();
  }
  // Approval state belongs to the exact backend and calendar identities it was issued for.
  const scope = JSON.stringify(
    env.CALENDAR_MODE === "google"
      ? [
          "google",
          env.GOOGLE_FIRST_CALENDAR,
          env.GOOGLE_SECOND_CALENDAR,
          env.GOOGLE_FAMILY_CALENDAR,
        ]
      : ["fixture"],
  );
  const app = createApplication({
    env,
    runAI: restInference(env),
    get: (key) => JSON.parse(read.get(scope + key)?.value ?? "null"),
    put: (key, value) => write.run(scope + key, JSON.stringify(value)),
    armRecovery,
  });
  if (app.hasPending()) armRecovery();
  const assets = {
    "/": ["index.html", "text/html"],
    "/app.js": ["app.js", "text/javascript"],
    "/style.css": ["style.css", "text/css"],
  };
  const server = createServer(async (req, res) => {
    try {
      const origin = "http://127.0.0.1:" + server.address().port;
      if (
        !["127.0.0.1:" + server.address().port, "localhost:" + server.address().port].includes(
          req.headers.host,
        )
      ) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith("/api/")) {
        const parts = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 8192) {
            res.writeHead(413).end();
            return;
          }
          parts.push(chunk);
        }
        const request = new Request("http://" + req.headers.host + url.pathname, {
          method: req.method,
          headers: req.headers,
          body: parts.length ? Buffer.concat(parts) : undefined,
        });
        const result = await app.api(request, "local-operator");
        res.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text());
      } else if (req.method === "GET" && Object.hasOwn(assets, url.pathname)) {
        const [file, type] = assets[url.pathname];
        res
          .writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" })
          .end(readFileSync(new URL("./public/" + file, import.meta.url)));
      } else res.writeHead(404).end();
    } catch (error) {
      console.error("Calendar request failed:", error.name);
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "Request failed. Reload to check the latest goal." }));
    }
  });
  try {
    await new Promise((yes, no) => {
      server.once("error", no);
      server.listen(port, "127.0.0.1", yes);
    });
  } catch (error) {
    clearTimeout(timer);
    db.close();
    throw error;
  }
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: async () => {
      closing = true;
      clearTimeout(timer);
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer();
  console.log("Weave calendar is ready at " + server.url);
}
