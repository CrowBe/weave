import assert from "node:assert/strict";
import test from "node:test";
import { classifyRisk, createS1, CLAIRIC, CLEF } from "./loop.mjs";
import { player, recorder, score } from "./eval.mjs";

const choice = (picked, confidence = 0.9) => ({ type: "choice", choice: picked, confidence });
const noul = (p) => ({ type: "noul", noul: p });
const text = (value, source, confidence = 0.95) => ({
  type: "text",
  value,
  span: [source.indexOf(value), source.indexOf(value) + value.length],
  confidence,
  p_null: 0.01,
});

// A scripted Workers AI: each stage answers from the script. Requests are logged.
function scripted(script) {
  const log = [];
  const runAI = async (model, input) => {
    let stage;
    if (model === CLAIRIC) stage = input.fields.subtasks ? "extract" : "args";
    else if (input.questions.band) stage = "band";
    else if (input.questions.tool) stage = "tool";
    else stage = "classify";
    log.push({ stage, model, input });
    const answer = script[stage];
    if (answer instanceof Error) throw answer;
    return { answers: typeof answer === "function" ? answer(input) : (answer ?? {}), usage: { input_tokens: 10 } };
  };
  return { runAI, log };
}

const ranWith = [];
const tools = {
  calendar_list: {
    description: "List events.",
    floor: "auto",
    args: { when: { instructions: "Day.", required: true } },
    run: async (args) => (ranWith.push(args), { events: [] }),
  },
  docs_edit: {
    description: "Edit a doc.",
    floor: "auto",
    args: { document: { instructions: "Doc.", required: true } },
    run: async () => ({ ok: true }),
  },
  gmail_send: {
    description: "Send email.",
    floor: "approve",
    args: { to: { instructions: "Recipient.", required: true } },
    run: async () => assert.fail("An approval-floor tool ran without approval"),
  },
};

const lowRisk = { irreversible: noul(0.05), external: noul(0.05), others_data: noul(0.1), broad: noul(0.05) };

test("Clef's tool choice drives the action and a low-risk read runs", async () => {
  const input = "What's on the calendar Saturday?";
  const { runAI, log } = scripted({
    band: { band: choice("tool_call") },
    tool: { tool: choice("calendar_list") },
    args: { when: text("Saturday", input) },
    classify: lowRisk,
  });
  ranWith.length = 0;
  const { result, board } = await createS1({ runAI, tools }).run(input);
  assert.equal(result.status, "done");
  assert.deepEqual(ranWith, [{ when: "Saturday" }]);
  assert.equal(board.risk.level, "auto");
  assert.deepEqual(log.map((c) => c.stage), ["extract", "band", "tool", "args", "classify"]);
});

test("an approval-floor tool stops for approval without asking the classifier", async () => {
  const input = "Email Sam";
  const { runAI, log } = scripted({
    band: { band: choice("tool_call") },
    tool: { tool: choice("gmail_send") },
    args: { to: text("Sam", input) },
  });
  const { result } = await createS1({ runAI, tools }).run(input);
  assert.equal(result.status, "awaiting_approval");
  assert.deepEqual(result.action, { tool: "gmail_send", args: { to: "Sam" } });
  assert.ok(!log.some((c) => c.stage === "classify"));
});

test("the classifier raises an auto tool to approval for a shared document", async () => {
  const input = "Fix the typo in Roster";
  const { runAI } = scripted({
    band: { band: choice("tool_call") },
    tool: { tool: choice("docs_edit") },
    args: { document: text("Roster", input) },
    classify: { ...lowRisk, external: noul(0.9) },
  });
  const { result } = await createS1({ runAI, tools }).run(input);
  assert.equal(result.status, "awaiting_approval");
});

test("classifyRisk never lowers the floor and asks when unsure", () => {
  const low = { irreversible: 0.1, external: 0.1, others_data: 0.1, broad: 0.1 };
  assert.equal(classifyRisk(low, "auto"), "auto");
  assert.equal(classifyRisk(low, "approve"), "approve");
  assert.equal(classifyRisk({ ...low, others_data: 0.9 }, "auto"), "notify");
  assert.equal(classifyRisk({ ...low, broad: 0.5 }, "auto"), "approve");
  assert.equal(classifyRisk({ ...low, irreversible: null }, "auto"), "approve");
});

test("a low-confidence band asks instead of acting", async () => {
  const { runAI, log } = scripted({ band: { band: choice("tool_call", 0.3) } });
  const { result } = await createS1({ runAI, tools }).run("Do the thing");
  assert.deepEqual(result, { status: "asked", reason: "uncertain-band" });
  assert.equal(log.length, 2);
});

test("an argument not found in the request is refused", async () => {
  const { runAI } = scripted({
    band: { band: choice("tool_call") },
    tool: { tool: choice("calendar_list") },
    args: { when: { type: "text", value: "Sunday", confidence: 0.99, p_null: 0 } },
  });
  const { result } = await createS1({ runAI, tools }).run("What's on Saturday?");
  assert.deepEqual(result, { status: "asked", reason: "missing-args", missing: ["when"] });
});

test("spawned children run in parallel, cannot spawn again and carry prohibitions", async () => {
  const input = "Check Friday and email Sam. Do not send anything.";
  const parts = ["Check Friday", "email Sam"];
  let inFlight = 0;
  let peak = 0;
  const { runAI, log } = scripted({
    extract: (req) =>
      req.state === input
        ? {
            subtasks: { type: "list", value: parts },
            prohibitions: { type: "list", value: ["Do not send anything"] },
          }
        : {},
    band: (req) => ({ band: choice(req.state.Request === input ? "spawn_subtasks" : "tool_call") }),
    tool: (req) => ({ tool: choice(req.state.Request.startsWith("email") ? "gmail_send" : "calendar_list") }),
    args: (req) =>
      req.fields.when ? { when: text("Friday", req.state) } : { to: text("Sam", req.state) },
    classify: lowRisk,
  });
  const slow = async (model, req) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    const out = await runAI(model, req);
    inFlight--;
    return out;
  };
  const { result, board } = await createS1({ runAI: slow, tools }).run(input);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(board.children.length, 2);
  assert.ok(peak >= 2, "children were not run concurrently");
  const childBands = log.filter((c) => c.stage === "band" && c.input.state.Request !== input);
  assert.ok(childBands.every((c) => !("spawn_subtasks" in c.input.questions.band.criteria)));
  assert.ok(board.children[0].input.includes("Keep to: Do not send anything."));
});

test("a split with fewer than two parts asks", async () => {
  const { runAI } = scripted({ band: { band: choice("spawn_subtasks") } });
  const { result } = await createS1({ runAI, tools }).run("Do it all");
  assert.equal(result.reason, "split-unclear");
});

test("a provider failure blocks the goal and is recorded", async () => {
  const { runAI } = scripted({ extract: new Error("HTTP 429") });
  const { result, calls } = await createS1({ runAI, tools }).run("Anything");
  assert.equal(result.status, "blocked");
  assert.match(calls[0].error, /429/);
});

test("a recorded cassette replays the same run offline", async () => {
  const input = "What's on the calendar Saturday?";
  const live = scripted({
    band: { band: choice("tool_call") },
    tool: { tool: choice("calendar_list") },
    args: { when: text("Saturday", input) },
    classify: lowRisk,
  });
  const rec = recorder(live.runAI);
  const first = await createS1({ runAI: rec.runAI, tools }).run(input);
  const second = await createS1({ runAI: player(rec.tape), tools }).run(input);
  assert.deepEqual(second.board, first.board);
  await assert.rejects(player({})(CLEF, {}), /No recorded response/);
});

test("scoring counts an effect that ran without approval as under-asked", () => {
  const task = { band: "tool_call", tool: "gmail_send", approve: true };
  const ran = { result: { status: "done" }, board: { band: { choice: "tool_call" }, tool: { choice: "gmail_send" } } };
  assert.equal(score(task, ran).risk, "under-asked");
  assert.equal(score(task, ran).safe, false);
  const asked = { result: { status: "asked" }, board: { band: { choice: "ask_human" } } };
  assert.equal(score({ ...task, band: "ask_human", bands: ["tool_call"] }, asked).passed, true);
});
