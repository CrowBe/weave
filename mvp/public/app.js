const byId = (id) => document.getElementById(id);
const request = byId("request");
const goal = byId("goal");
const scenario = byId("scenario");
const start = byId("start");
const status = byId("status");
const outcome = byId("outcome");
const actions = byId("actions");
const error = byId("error");

const activeStatuses = new Set(["working", "choice", "approval"]);
const timeZone = "Australia/Sydney";
const dateFormat = new Intl.DateTimeFormat("en-AU", { dateStyle: "full", timeZone });
const timeFormat = new Intl.DateTimeFormat("en-AU", {
  hour: "numeric",
  minute: "2-digit",
  timeZone,
  timeZoneName: "short",
});

const percent = new Intl.NumberFormat("en-AU", { style: "percent", maximumFractionDigits: 1 });
const actionLabels = new Map([
  ["split", "Check both calendars"],
  ["report", "Report the shared times"],
  ["none", "Report no shared time"],
  ["propose", "Propose a time for approval"],
  ["choose", "Ask which evening works"],
  ["abstain", "Leave the decision unresolved"],
]);
const stopReasons = new Map([
  ["provider-unavailable", "Workers AI was unavailable."],
  ["scope", "The request was outside the supported dinner planning scope."],
  ["intake-decision", "The intake decision did not authorise checking the calendars."],
  ["availability-decision", "The proposed action did not pass the availability checks."],
  ["read-only-decision", "The proposed action did not pass the read-only checks."],
  ["availability-changed", "The selected time was no longer available."],
]);

let snapshot;
let sending = false;
let pollTimer;
let draftEdited = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatSlot(slot) {
  const from = new Date(slot);
  const to = new Date(from.getTime() + 60 * 60 * 1000);
  return [dateFormat.format(from), `${timeFormat.format(from)} – ${timeFormat.format(to)}`];
}

function timeCard(slot, tag = "div") {
  const [date, time] = formatSlot(slot);
  const card = element(tag, null, "time");
  const copy = element("span");
  copy.append(element("strong", date), element("span", time));
  card.append(copy);
  return card;
}

function makeButton(label, handler, primary = false) {
  const button = element("button", label, primary ? "primary" : "");
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function renderChoices(state) {
  const choices = element("fieldset", null, "choices");
  choices.append(element("legend", "Which evening works for you?"));
  const confirm = makeButton(
    "Continue to approval",
    () => {
      const selected = choices.querySelector("input:checked");
      if (selected) submit({ type: "choose", revision: state.revision, slot: selected.value });
    },
    true,
  );
  confirm.disabled = true;
  for (const slot of state.slots) {
    const option = timeCard(slot, "label");
    const radio = element("input");
    radio.type = "radio";
    radio.name = "dinner-time";
    radio.value = slot;
    option.prepend(radio);
    choices.append(option);
  }
  choices.addEventListener("change", () => {
    confirm.disabled = sending;
  });
  outcome.append(choices);
  actions.append(confirm);
}

function describeActivity(item) {
  const details = [];
  let title;
  switch (item.type) {
    case "goal.extract":
      title = "Interpret dinner request";
      details.push(
        item.inference?.unavailable
          ? "Inference unavailable"
          : item.supported
            ? "Request within scope"
            : "Request could not be accepted",
      );
      break;
    case "goal.decide":
      title =
        item.phase === "intake"
          ? "Decide how to check availability"
          : "Decide what to do with available times";
      details.push(actionLabels.get(item.action) ?? "No recognised action");
      if (Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1) {
        details.push(`Confidence ${percent.format(item.confidence)}`);
      }
      break;
    case "clarification.requested":
      title = "Asked you to choose a verified evening";
      details.push("Decision confidence was below the threshold for an automatic proposal.");
      break;
    case "policy.block":
      title = "Policy stop";
      details.push(
        stopReasons.get(item.reason) ?? "The proposed step did not pass a policy check.",
      );
      break;
    default: {
      const label = item.type.replace(/[_.-]/g, " ");
      title = label.charAt(0).toUpperCase() + label.slice(1);
    }
  }
  const elapsed = item.inference?.elapsedMs;
  if (Number.isFinite(elapsed) && elapsed >= 0) {
    const duration =
      elapsed < 1000 ? `${Math.round(elapsed)} ms` : `${(elapsed / 1000).toFixed(1)} s`;
    details.push(`Inference took ${duration}`);
  }
  const row = element("li");
  row.append(element("span", title));
  if (details.length) row.append(element("span", details.join(" · "), "activity-detail"));
  return row;
}

function renderPlan(state) {
  status.textContent = state.message || "Submit a dinner request to see available times.";
  outcome.replaceChildren();
  actions.replaceChildren();
  if (state.status === "choice") renderChoices(state);
  if (state.status === "approval" && state.selected) {
    outcome.append(
      timeCard(state.selected),
      element("p", "Your approval places this one-hour hold on the family calendar.", "hint"),
    );
    actions.append(
      makeButton(
        "Approve calendar hold",
        () => {
          submit({ type: "approve", revision: state.revision });
        },
        true,
      ),
    );
  }
  if (state.status === "done" && !state.receipt && state.slots?.length) {
    for (const slot of state.slots) outcome.append(timeCard(slot));
  }
  if (state.recovery === "manual") {
    actions.append(
      makeButton(
        "Check calendar receipt",
        () => submit({ type: "reconcile", revision: state.revision }),
        true,
      ),
    );
  }
  if (state.status === "done" && state.receipt) {
    outcome.append(
      timeCard(state.receipt.slot),
      element("p", `Calendar receipt ${state.receipt.id}`, "hint"),
    );
  }
  if (state.status === "choice" || state.status === "approval") {
    actions.append(
      makeButton("Cancel request", () => {
        submit({ type: "cancel", revision: state.revision });
      }),
    );
  }
  byId("activity").hidden = !state.trace?.length;
  byId("trace").replaceChildren(...(state.trace ?? []).map(describeActivity));
}

function updateControls() {
  const requestLocked = !snapshot || sending || activeStatuses.has(snapshot.state.status);
  goal.disabled = requestLocked;
  scenario.disabled = requestLocked;
  start.disabled = requestLocked;
  for (const control of [
    ...actions.querySelectorAll("button"),
    ...outcome.querySelectorAll("input"),
  ]) {
    control.disabled = sending;
  }
  if (snapshot?.state.status === "choice") {
    const [confirm] = actions.querySelectorAll("button");
    confirm.disabled ||= !outcome.querySelector("input:checked");
  }
}

function render(next) {
  const previous = snapshot;
  if (previous && next.state.revision < previous.state.revision) return;
  snapshot = next;
  const fixture = next.calendar === "fixture";
  byId("environment").textContent = fixture
    ? "Demo calendar · " + (next.mode === "fixture" ? "Fixture decisions" : next.mode)
    : "Family calendar · " + (next.mode === "fixture" ? "Fixture decisions" : next.mode);
  byId("request-hint").textContent =
    next.mode === "fixture"
      ? "Try adding “Except Tuesday. Prefer Thursday if it is free.” to the example request."
      : "You can rule out an evening or name a preferred weekday in your own words.";
  byId("scenario-field").hidden = !fixture;
  if (fixture && (!previous || previous.scenario !== next.scenario)) scenario.value = next.scenario;
  if (next.state.text && (!draftEdited || activeStatuses.has(next.state.status))) {
    goal.value = next.state.text;
    draftEdited = false;
  }
  if (
    !previous ||
    previous.state.revision !== next.state.revision ||
    previous.state.status !== next.state.status
  ) {
    renderPlan(next.state);
  }
  updateControls();
}

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

async function readResponse(response) {
  const payload = await response.json();
  if (!response.ok || payload.error)
    throw new Error(payload.error || "Weave could not complete the request.");
  return payload;
}

function scheduleRefresh(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, delay);
}

async function refresh() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const next = await readResponse(response);
    render(next);
    if (error.dataset.connection) showError("");
    delete error.dataset.connection;
    if (sending || (snapshot.state.status === "working" && snapshot.state.recovery !== "manual"))
      scheduleRefresh(800);
  } catch {
    showError("Weave is temporarily unavailable. Reconnecting…");
    error.dataset.connection = "true";
    scheduleRefresh(2500);
  }
}

async function submit(command) {
  if (sending) return;
  sending = true;
  clearTimeout(pollTimer);
  showError("");
  delete error.dataset.connection;
  updateControls();
  scheduleRefresh(800);

  let failed = false;
  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    render(await readResponse(response));
  } catch (cause) {
    failed = true;
    showError(cause.message || "Weave could not complete the request.");
  } finally {
    sending = false;
    clearTimeout(pollTimer);
    updateControls();
  }

  if (failed) {
    await refresh();
  } else {
    status.focus();
    if (snapshot.state.status === "working" && snapshot.state.recovery !== "manual")
      scheduleRefresh(800);
  }
}

goal.addEventListener("input", () => {
  draftEdited = true;
});
request.addEventListener("submit", (event) => {
  event.preventDefault();
  if (start.disabled) return;
  const input = { type: "start", text: goal.value.trim() };
  if (!input.text) {
    showError("Enter a dinner request before searching.");
    goal.focus();
    return;
  }
  if (snapshot.calendar === "fixture") input.scenario = scenario.value;
  submit(input);
});

status.tabIndex = -1;
refresh();
