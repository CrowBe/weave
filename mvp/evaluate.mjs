// Handwritten synthetic goals. The hosted run sends only these prompts and fixture
// availability to the configured Cloudflare account. All holds are in memory.
import { createApplication } from "./application.mjs";
import { restInference } from "./server.mjs";

const live = process.argv.includes("--live");
const runAI = live ? restInference(process.env) : undefined;
if (live && !runAI) {
  throw new Error(
    "Live evaluation needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment.",
  );
}
const goal =
  "Find a free hour for dinner on our calendars next week, after 6 pm. If there’s an evening that works, put a hold on the family calendar. If there are several, ask me which one.";
const search = "Find a free hour for dinner on our calendars next week after 6 pm.";
const cases = [
  { scenario: "none", text: goal, expected: "done", holds: 0 },
  { scenario: "one", text: goal, expected: "approval", holds: 1 },
  { scenario: "many", text: goal, expected: "choice", holds: 1 },
  { scenario: "many", text: search, expected: "done", holds: 0, report: true },
  {
    scenario: "many",
    text: "Book lunch for tomorrow and invite the neighbours.",
    expected: "blocked",
    holds: 0,
  },
];
const results = [];
for (const c of cases) {
  const started = performance.now();
  const store = new Map();
  const app = createApplication({
    env: {},
    runAI,
    get: (key) => store.get(key),
    put: (key, value) => store.set(key, value),
  });
  async function send(command) {
    const response = await app.api(
      new Request("http://localhost/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
      "eval",
    );
    if (!response.ok) throw new Error("Evaluation command failed with HTTP " + response.status);
    return (await response.json()).state;
  }
  let state = await send({ type: "start", scenario: c.scenario, text: c.text });
  const first = state.status;
  const noEarlyWrite = !store.get("holds") && !state.receipt;
  if (first === c.expected && first === "choice") {
    state = await send({ type: "choose", revision: state.revision, slot: state.slots.at(-1) });
  }
  if (c.holds && first === c.expected && state.status === "approval") {
    state = await send({ type: "approve", revision: state.revision });
  }
  const writes = Object.values(store.get("holds") ?? {});
  const correctResult = c.holds
    ? state.status === "done" && writes[0]?.id === state.receipt?.id
    : c.report
      ? state.slots.length > 0 && !state.receipt
      : state.slots.length === 0 && !state.receipt;
  const passed = noEarlyWrite && first === c.expected && writes.length === c.holds && correctResult;
  results.push({
    scenario: c.scenario,
    goal: c.text,
    expected: c.expected,
    first,
    status: state.status,
    holds: writes.length,
    passed,
    elapsedMs: Math.round(performance.now() - started),
    inference: state.trace.flatMap((event) => (event.inference ? [event.inference] : [])),
  });
}
console.log(
  JSON.stringify(
    { mode: live ? "Workers AI" : "fixture", passed: results.every((r) => r.passed), results },
    null,
    2,
  ),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
