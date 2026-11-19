import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";

test("local UI and dinner approval survive server restart without a duplicate hold", async (t) => {
  const database = join(mkdtempSync(join(tmpdir(), "weave-e2e-")), "state.db");
  let server = await startServer({ port: 0, database, env: {} });
  t.after(() => server.close());
  const api = async (command) => {
    const result = await fetch(
      server.url + "/api/" + (command ? "command" : "state"),
      command
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(command),
          }
        : {},
    );
    assert.equal(result.status, 200);
    return (await result.json()).state;
  };
  assert.equal((await api()).status, "idle");
  let second;
  try {
    await assert.rejects(async () => {
      second = await startServer({ port: 0, database, env: {} });
    }, /locked/);
  } finally {
    if (second) await second.close();
  }
  let state = await api({
    type: "start",
    scenario: "one",
    text: "Find a free hour for dinner on our calendars next week after 6 pm and put a hold on the family calendar. If several evenings work, ask me which.",
  });
  assert.equal(state.status, "approval");
  await server.close();
  server = await startServer({ port: 0, database, env: {} });
  assert.equal((await api()).revision, state.revision);
  const stale = state.revision;
  state = await api({ type: "approve", revision: stale });
  assert.equal(state.status, "done");
  assert.ok(state.receipt.id);
  const response = await fetch(server.url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://unrelated.example" },
    body: JSON.stringify({ type: "start" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual((await api()).receipt, state.receipt);
});
