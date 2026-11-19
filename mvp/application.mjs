import { createLoop } from "./loop.mjs";
import { createModel, createCalendar, createGoogleCalendar } from "./adapters.mjs";

const scenarios = ["one", "many", "none"];
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const active = new Set(["working", "choice", "approval"]);

export function createApplication({
  get,
  put,
  env,
  runAI,
  now = () => new Date(),
  armRecovery = async () => {},
}) {
  const calendarMode = env.CALENDAR_MODE ?? "fixture";
  if (!["fixture", "google"].includes(calendarMode)) throw new Error("Unknown CALENDAR_MODE");
  const goalClock = () => {
    const started = loop.state().startedAt;
    return started ? new Date(started) : now();
  };
  const google =
    calendarMode === "google"
      ? createGoogleCalendar({
          accessToken: env.GOOGLE_ACCESS_TOKEN,
          calendarIds: {
            first: env.GOOGLE_FIRST_CALENDAR,
            second: env.GOOGLE_SECOND_CALENDAR,
            family: env.GOOGLE_FAMILY_CALENDAR,
          },
          now: goalClock,
          wallNow: now,
        })
      : null;
  const calendar = () =>
    google ??
    createCalendar({
      scenario: get("scenario") ?? "many",
      now: goalClock,
      wallNow: now,
      loadHolds: () => get("holds") ?? {},
      saveHolds: (holds) => put("holds", holds),
    });
  const loop = createLoop({
    load: () => get("goal"),
    save: (state) => put("goal", state),
    now,
    newId: () => crypto.randomUUID(),
    model: createModel({ runAI }),
    calendar: Object.fromEntries(
      ["read", "hold", "lookup"].map((method) => [
        method,
        (...args) => calendar()[method](...args),
      ]),
    ),
  });
  const snapshot = () =>
    json({
      state: loop.state(),
      calendar: calendarMode,
      scenario: get("scenario") ?? "many",
      mode: runAI ? "Workers AI" : "fixture",
    });
  async function api(request, actor) {
    const url = new URL(request.url);
    if (url.pathname === "/api/state" && request.method === "GET") return snapshot();
    if (url.pathname !== "/api/command" || request.method !== "POST")
      return json({ error: "Unknown endpoint." }, 404);
    if (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
      return json({ error: "Origin mismatch." }, 403);
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
      return json({ error: "Send JSON." }, 415);
    let command;
    try {
      const raw = await request.text();
      if (raw.length > 8192) return json({ error: "Request too large." }, 413);
      command = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
    if (!command || !["start", "choose", "approve", "cancel", "reconcile"].includes(command.type))
      return json({ error: "Unknown command." }, 400);
    // Arrange a durable wake-up before the first goal mutation or external effect.
    await armRecovery();
    const state = loop.state();
    if (command.type === "start") {
      if (active.has(state.status) || loop.hasPending())
        return json({ error: "Finish or cancel the current goal first." }, 409);
      if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 2000)
        return json({ error: "Enter a goal of up to 2000 characters." }, 400);
      if (command.scenario !== undefined && !scenarios.includes(command.scenario))
        return json({ error: "Unknown fixture scenario." }, 400);
      put("scenario", command.scenario ?? "many");
    } else {
      if (state.actor !== actor) return json({ error: "Only the goal owner can change it." }, 403);
      if (command.revision !== state.revision)
        return json({ error: "The goal changed. Review its current state." }, 409);
      if (
        command.type === "choose" &&
        (state.status !== "choice" || !state.slots.includes(command.slot))
      )
        return json({ error: "Choose a current slot." }, 409);
      if (command.type === "reconcile" && state.recovery !== "manual")
        return json({ error: "No reconciliation is pending." }, 409);
      if (command.type === "approve" && state.status !== "approval")
        return json({ error: "There is no pending approval." }, 409);
    }
    await loop.dispatch({
      type: command.type,
      text: command.text,
      slot: command.slot,
      revision: command.revision,
      actor,
    });
    return snapshot();
  }
  return { api, resume: () => loop.resume(), hasPending: () => loop.hasPending() };
}
