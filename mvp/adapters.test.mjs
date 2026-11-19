import assert from "node:assert/strict";
import test from "node:test";
import { createCalendar, createGoogleCalendar, createModel } from "./adapters.mjs";

const goal =
  "Find a free hour for dinner on our calendars next week after 6 pm and put a hold on the family calendar. If several evenings work, ask me which.";
const original =
  "Find a free hour for dinner on our calendars next week, after 6 pm. If there’s an evening that works, put a hold on the family calendar. If there are several, ask me which one.";
const readOnly = "Find a free hour for dinner on our calendars next week after 6 pm.";
const now = () => new Date("2026-04-02T13:00:00Z");

test("offline model accepts only the supported dinner request", async () => {
  const model = createModel();
  assert.equal(model.mode, "fixture");
  assert.deepEqual(await model.extract(goal), { supported: true, intent: "hold" });
  assert.deepEqual(await model.extract(original), { supported: true, intent: "hold" });
  assert.deepEqual(await model.extract(readOnly), { supported: true, intent: "find" });
  for (const text of [
    goal.replace("a free hour", "two free hours"),
    goal.replace("next week", "tomorrow"),
    goal.replace("after 6 pm", "after 8 pm"),
    goal.replace("after 6 pm", "after 6 pm, except Thursday,"),
    goal.replace("family calendar", "work calendar"),
    goal.replace("and put a hold", "and do not put a hold"),
    goal + " Invite the family when you find one.",
  ]) {
    assert.deepEqual(await model.extract(text), { supported: false }, text);
  }
  assert.deepEqual(await model.decide({ phase: "intake", intent: "hold" }), {
    action: "split",
    confidence: 1,
  });
  for (const [slots, action] of [
    [[], "none"],
    [["one"], "propose"],
    [["one", "two"], "choose"],
  ]) {
    assert.deepEqual(await model.decide({ phase: "availability", intent: "hold", slots }), {
      action,
      confidence: 1,
    });
  }
  assert.deepEqual(await model.decide({ phase: "availability", intent: "find", slots: ["one"] }), {
    action: "report",
    confidence: 1,
  });
});

test("hosted adapter uses native typed inference and rejects uncertain or invalid output", async () => {
  const calls = [];
  let response;
  const model = createModel({
    runAI: async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return response;
    },
  });
  assert.equal(model.mode, "workers-ai");
  const paraphrase =
    "Could you see when we are both free to eat dinner for sixty minutes next week, starting later than 18:00, and reserve an hour on the family calendar?";
  const textAnswer = (value, state = paraphrase) => {
    const start = state.indexOf(value);
    return {
      type: "text",
      value,
      span: [start, start + value.length],
      confidence: 0.99,
      p_null: 0.01,
    };
  };
  response = {
    truncated: false,
    answers: {
      meal: textAnswer("dinner"),
      week: textAnswer("next week"),
      duration: { type: "duration", value: 60, unit: "minutes", confidence: 0.99, p_null: 0.01 },
      time: textAnswer("later than 18:00"),
      operation: textAnswer("reserve an hour on the family calendar"),
      unsupported: { type: "text", value: null, confidence: 0.3, p_null: 0.99 },
    },
    usage: { input_tokens: 500, output_tokens: 0, other: 10 },
  };
  const result = await model.extract(paraphrase);
  assert.equal(result.supported, true);
  assert.equal(result.intent, "hold");
  assert.equal(result.inference.model, "@cf/cloudflare/clairic");
  assert.ok(result.inference.elapsedMs >= 0);
  assert.deepEqual(result.inference.usage, { input_tokens: 500, output_tokens: 0 });
  assert.ok(result.inference.estimatedUsd > 0);
  assert.equal(calls[0][0], "@cf/cloudflare/clairic");
  assert.equal(calls[0][1].fields.duration.type, "duration");
  assert.equal(calls[0][1].state, paraphrase);

  const modified = paraphrase + " Only on Thursday.";
  response.answers.unsupported = textAnswer("Only on Thursday", modified);
  assert.equal((await model.extract(modified)).supported, false);
  response.answers.unsupported = { type: "text", value: null, p_null: 0.99 };
  response.answers.week.span = [1, 3];
  assert.equal((await model.extract(paraphrase)).supported, false);
  response.answers.week = textAnswer("next week");
  response.answers.operation = textAnswer("Find a free hour", readOnly);
  response.answers.meal = textAnswer("dinner", readOnly);
  response.answers.week = textAnswer("next week", readOnly);
  response.answers.time = textAnswer("after 6 pm", readOnly);
  assert.equal((await model.extract(readOnly)).intent, "find");
  response.answers.duration.confidence = 0.4;
  assert.equal((await model.extract(readOnly)).supported, false);

  response = {
    answers: {
      action: {
        type: "choice",
        choice: "report",
        probabilities: { none: 0.01, choose: 0.01, propose: 0.01, report: 0.97 },
        confidence: 0.96,
      },
    },
  };
  const args = { phase: "availability", intent: "find", text: readOnly, slots: ["common-slot"] };
  const decision = await model.decide(args);
  assert.equal(decision.action, "report");
  assert.equal(decision.confidence, 0.96);
  assert.equal(decision.inference.usage, undefined);
  assert.equal(decision.inference.estimatedUsd, undefined);
  assert.equal(calls.at(-1)[0], "@cf/cloudflare/clef");
  assert.equal(calls.at(-1)[1].questions.action.type, "choice");
  assert.deepEqual(calls.at(-1)[1].state, {
    goal: readOnly,
    intent: "find",
    slotCount: 1,
    commonSlots: ["common-slot"],
  });
  response.answers.action.probabilities.report = "0.97";
  assert.equal((await model.decide(args)).confidence, 0);
  response = new Error("network");
  const failed = await model.decide({ phase: "intake", intent: "hold", text: goal });
  assert.equal(failed.action, "abstain");
  assert.equal(failed.confidence, 0);
  assert.equal(failed.inference.model, "@cf/cloudflare/clef");
  assert.equal((await model.extract(goal)).supported, false);
});

test("fixture provides independent private availability and durable idempotent holds", () => {
  for (const [scenario, count] of [
    ["none", 0],
    ["one", 1],
    ["many", 3],
  ]) {
    const calendar = createCalendar({ scenario, now });
    const first = calendar.read("first");
    const second = calendar.read("second");
    const common = first.filter((slot) => second.includes(slot));
    assert.equal(common.length, count);
    assert.notDeepEqual(first, second);
    if (count) assert.equal(common[0], "2026-04-07T09:00:00.000Z");
  }
  let holds = {};
  const options = {
    scenario: "many",
    now,
    loadHolds: () => holds,
    saveHolds: (value) => {
      holds = value;
    },
  };
  const calendar = createCalendar(options);
  const slot = calendar.read("first").find((value) => calendar.read("second").includes(value));
  assert.equal(calendar.lookup("goal"), null);
  const receipt = calendar.hold({ key: "goal", slot });
  assert.deepEqual(createCalendar(options).lookup("goal"), receipt);
  assert.deepEqual(createCalendar(options).hold({ key: "goal", slot }), receipt);
  assert.throws(() => calendar.hold({ key: "goal", slot: "2026-04-09T09:00:00.000Z" }));
  assert.throws(() => calendar.hold({ key: "another", slot }));
  assert.throws(() => calendar.read("stranger"));
});

test("Google calendar reads free/busy, rechecks all calendars on hold, and reconciles retries", async () => {
  const calls = [];
  let event;
  let busy = [];
  const calendar = createGoogleCalendar({
    accessToken: "token",
    calendarIds: { first: "one@google", second: "two@google", family: "family@google" },
    now,
    fetchImpl: async (url, request) => {
      const body = request.body ? JSON.parse(request.body) : undefined;
      calls.push({ url, method: request.method, body });
      assert.equal(request.headers.Authorization, "Bearer token");
      if (url.endsWith("/freeBusy")) {
        return Response.json({
          calendars: Object.fromEntries(
            body.items.map(({ id }) => [id, { busy: id === "family@google" ? busy : [] }]),
          ),
        });
      }
      if (request.method === "POST") {
        event = body;
        return Response.json(event);
      }
      return event ? Response.json(event) : new Response(null, { status: 404 });
    },
  });
  assert.equal((await calendar.read("first"))[0], "2026-04-06T08:30:00.000Z");
  assert.deepEqual(calls[0].body.items, [{ id: "one@google" }, { id: "family@google" }]);
  const slot = "2026-04-07T09:00:00.000Z";
  busy = [{ start: "2026-04-07T09:10:00Z", end: "2026-04-07T09:50:00Z" }];
  assert.ok(!(await calendar.read("first")).includes(slot));
  assert.ok(!(await calendar.read("second")).includes(slot));
  await assert.rejects(calendar.hold({ key: "goal", slot }), /no longer available/);
  assert.equal(event, undefined);
  busy = [];
  const receipt = await calendar.hold({ key: "goal", slot });
  assert.deepEqual(await calendar.hold({ key: "goal", slot }), receipt);
  assert.deepEqual(await calendar.lookup("goal"), receipt);
  assert.equal(calls.filter((call) => call.url.includes("sendUpdates=none")).length, 1);
  assert.deepEqual(calls.find((call) => call.body?.items.length === 3).body.items, [
    { id: "one@google" },
    { id: "two@google" },
    { id: "family@google" },
  ]);
  assert.equal(event.end.dateTime, "2026-04-07T10:00:00.000Z");
  assert.match(event.id, /^[0-9a-v]{5,1024}$/);
  assert.equal(event.start.timeZone, "Australia/Sydney");
  assert.equal(event.attendees, undefined);
});

test("Google calendar times out stalled provider requests", async () => {
  const calendar = createGoogleCalendar({
    accessToken: "token",
    calendarIds: { first: "one", second: "two", family: "three" },
    now,
    timeoutMs: 10,
    fetchImpl: async (url, { signal }) =>
      new Promise((resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("Request never timed out")), 100);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(calendar.read("first"), { name: "TimeoutError" });
});

test("a pending goal retains the original week while past slots become unavailable", async () => {
  const wallNow = () => new Date("2026-04-07T09:00:00Z");
  const fixture = createCalendar({ scenario: "one", now, wallNow });
  assert.deepEqual(fixture.read("first"), []);
  assert.deepEqual(fixture.read("second"), ["2026-04-08T09:00:00.000Z"]);
  assert.throws(
    () => fixture.hold({ key: "expired", slot: "2026-04-07T09:00:00.000Z" }),
    /no longer available/,
  );

  let inserts = 0;
  const google = createGoogleCalendar({
    accessToken: "token",
    calendarIds: { first: "one", second: "two", family: "three" },
    now,
    wallNow,
    fetchImpl: async (url, { method, body }) => {
      if (url.endsWith("/freeBusy")) {
        const query = JSON.parse(body);
        assert.equal(query.timeMin, "2026-04-05T14:00:00.000Z");
        assert.equal(query.timeMax, "2026-04-12T14:00:00.000Z");
        return Response.json({
          calendars: Object.fromEntries(query.items.map(({ id }) => [id, { busy: [] }])),
        });
      }
      if (method === "POST") inserts++;
      return new Response(null, { status: 404 });
    },
  });
  assert.equal((await google.read("first"))[0], "2026-04-07T09:30:00.000Z");
  await assert.rejects(
    google.hold({ key: "expired", slot: "2026-04-07T09:00:00.000Z" }),
    /no longer available/,
  );
  assert.equal(inserts, 0);
});
