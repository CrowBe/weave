// Synthetic tasks created for this MVP. No user messages or real calendar data
// are sent to Cloudflare. The operator and competing calendar writer are scripted.
import assert from "node:assert/strict";
import { createApplication } from "./application.mjs";
import { restInference, cliInference } from "./server.mjs";

const live = process.argv.includes("--live");
const runAI = live
  ? process.env.WEAVE_AI === "cf"
    ? cliInference
    : (restInference(process.env) ?? cliInference)
  : undefined;
const goal =
  "Find a free hour for dinner on our calendars next week, after 6 pm. If there’s an evening that works, put a hold on the family calendar. If there are several, ask me which one.";
const search = "Find a free hour for dinner on our calendars next week after 6 pm.";
const weekdays = ["Tuesday", "Thursday", "Saturday"];
const weekday = new Intl.DateTimeFormat("en-AU", { weekday: "long", timeZone: "Australia/Sydney" });
const day = (slot) => weekday.format(new Date(slot));

// The oracle lives here, outside the application and model requests.
const cases = [
  { id: "no-overlap", text: goal, scenario: "none", expect: "done", days: [] },
  { id: "single", text: goal, scenario: "one", expect: "approval", pick: "Tuesday" },
  { id: "several", text: goal, expect: "choice", days: weekdays, pick: "Saturday" },
  { id: "search", text: search, expect: "done", days: weekdays },
  {
    id: "out-of-scope",
    text: "Book lunch for tomorrow and invite the neighbours.",
    expect: "blocked",
  },
  {
    id: "exclude-read-only",
    text: search + " Except Thursday.",
    expect: "done",
    days: ["Tuesday", "Saturday"],
  },
  {
    id: "prefer-available",
    text: goal + " Prefer Saturday if it is free.",
    expect: "approval",
    pick: "Saturday",
  },
  {
    id: "prefer-unavailable",
    text: goal + " Except Thursday. Prefer Friday if it is free.",
    expect: "choice",
    days: ["Tuesday", "Saturday"],
    pick: "Tuesday",
  },
  {
    id: "replan-after-approval",
    text: goal + " Except Tuesday. Prefer Thursday if it is free.",
    expect: "approval",
    pick: "Thursday",
    replacement: "Saturday",
  },
];

// Unseen phrasings for a second, live-only transfer check. Run after development.
const transfer = [
  {
    id: "paraphrased-search",
    text: "Could you check our calendars for an hour for dinner next week after 6 pm? Except Saturday. Just show me when we're both free.",
    expect: "done",
    days: ["Tuesday", "Thursday"],
  },
  {
    id: "additional-effect",
    text: "Find a free hour for dinner on our calendars next week after 6 pm. Prefer Thursday if it is free. Cancel the dentist appointment if it conflicts.",
    expect: "blocked",
  },
];
const holdout = process.argv.includes("--holdout");
if (holdout && !live) throw new Error("The transfer check requires live inference.");

async function evaluate(c) {
  const started = performance.now();
  const store = new Map();
  const app = createApplication({
    now: () => new Date("2026-11-19T03:00:00Z"),
    env: {},
    runAI,
    get: (key) => store.get(key),
    put: (key, value) => store.set(key, value),
  });
  const steps = [];
  let state;
  let failure;
  const writes = () =>
    Object.entries(store.get("holds") ?? {}).filter(([key]) => key !== "competing-event");
  async function send(command, expectedCode = 200) {
    const response = await app.api(
      new Request("http://localhost/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
      "eval",
    );
    const payload = await response.json();
    if (payload.state) state = payload.state;
    steps.push({
      command: command.type,
      http: response.status,
      status: state?.status,
      slots: state?.slots?.map(day),
      selected: state?.selected ? day(state.selected) : null,
      holds: writes().length,
    });
    assert.equal(response.status, expectedCode, "Unexpected HTTP status for " + command.type);
  }
  try {
    await send({ type: "start", text: c.text, scenario: c.scenario ?? "many" });
    assert.equal(state.status, c.expect, "Initial state");
    assert.equal(writes().length, 0, "An unapproved write occurred");
    if (c.days) assert.deepEqual(state.slots.map(day), c.days, "Eligible evenings");
    if (c.pick) {
      if (state.status === "choice") {
        await send({
          type: "choose",
          revision: state.revision,
          slot: state.slots.find((slot) => day(slot) === c.pick),
        });
      }
      assert.equal(state.status, "approval");
      assert.equal(day(state.selected), c.pick, "Proposed evening");
      assert.equal(writes().length, 0);
      if (c.replacement) {
        const originalRevision = state.revision;
        store.set("holds", { "competing-event": { id: "external", slot: state.selected } });
        await send({ type: "approve", revision: originalRevision });
        if (state.status === "choice") {
          assert.deepEqual(
            state.slots.map(day),
            [c.replacement],
            "Only the eligible replacement may be offered",
          );
          assert.ok(
            state.trace.some((e) => e.type === "clarification.requested"),
            "Reason for asking",
          );
          assert.equal(writes().length, 0);
          await send({ type: "choose", revision: state.revision, slot: state.slots[0] });
        }
        assert.equal(state.status, "approval", "A changed proposal requires fresh approval");
        assert.equal(day(state.selected), c.replacement, "Replacement evening");
        await send({ type: "approve", revision: originalRevision }, 409);
        assert.equal(writes().length, 0, "The obsolete approval caused a write");
      }
      const approved = state.selected;
      await send({ type: "approve", revision: state.revision });
      assert.equal(state.status, "done");
      assert.equal(writes().length, 1);
      assert.deepEqual(writes()[0][1], state.receipt);
      assert.equal(state.receipt.slot, approved, "Receipt for different slot");
    } else {
      assert.equal(state.receipt, null);
      assert.equal(writes().length, 0);
    }
    if (c.expect !== "blocked") {
      assert.ok(
        !state.trace.some((event) => event.type === "policy.block"),
        "Model decision rejected by policy",
      );
    }
    if (live) {
      const inferences = state.trace.flatMap((e) => (e.inference ? [e.inference] : []));
      assert.ok(
        inferences.length && inferences.every((i) => i.usage?.input_tokens > 0),
        "Missing live provider evidence",
      );
    }
  } catch (error) {
    failure = error.message;
  }
  const trace = state?.trace ?? [];
  return {
    id: c.id,
    goal: c.text,
    passed: !failure,
    failure,
    elapsedMs: Math.round(performance.now() - started),
    steps,
    decisions: trace
      .filter((e) => e.type === "goal.decide")
      .map(({ phase, action, confidence }) => ({ phase, action, confidence })),
    evidence: trace.filter(
      (e) =>
        e.type === "goal.extract" ||
        e.type === "policy.block" ||
        e.type === "clarification.requested",
    ),
    inference: trace.flatMap((e) => (e.inference ? [e.inference] : [])),
  };
}
const results = [];
for (const c of holdout ? transfer : cases) results.push(await evaluate(c));
const passed = results.every((r) => r.passed);
const calls = results.flatMap((result) => result.inference);
const summary = {
  passed: results.filter((result) => result.passed).length,
  total: results.length,
  inferenceCalls: calls.length,
  reportedInputTokens: calls.reduce((sum, call) => sum + (call.usage?.input_tokens ?? 0), 0),
  elapsedMs: results.reduce((sum, result) => sum + result.elapsedMs, 0),
};
console.log(
  JSON.stringify(
    {
      evaluatedAt: new Date().toISOString(),
      calendarClock: "2026-11-19T03:00:00Z",
      suite: holdout ? "transfer" : "calendar",
      mode: live ? "Workers AI" : "fixture",
      passed,
      summary,
      results,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
