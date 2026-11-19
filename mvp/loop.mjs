const MIN_CONFIDENCE = 0.8;
const MAX_HOLD_PASSES = 3;
const MAX_TRACE_EVENTS = 64;
const PEOPLE = ["first", "second"];
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "state_tokens",
  "schema_tokens",
  "image_tokens",
  "passes",
];
const DINNER_DATE = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  dateStyle: "short",
});
const DINNER_WEEKDAY = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  weekday: "long",
});
const WEEKDAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const NO_CONSTRAINTS = { excludeDays: [], preferredDay: null };

const EMPTY_STATE = {
  revision: 0,
  status: "idle",
  message: "No dinner goal yet.",
  slots: [],
  selected: null,
  receipt: null,
  trace: [],
  actor: null,
  text: "",
  startedAt: null,
  intent: null,
  recovery: null,
  constraints: NO_CONSTRAINTS,
};

function slotList(value) {
  if (!Array.isArray(value)) throw new Error("Invalid calendar availability");
  return value.map((slot) => {
    if (typeof slot !== "string" || !Number.isFinite(Date.parse(slot))) {
      throw new Error("Invalid calendar slot");
    }
    if (slot !== new Date(slot).toISOString()) throw new Error("Invalid calendar slot");
    return slot;
  });
}

function accepts(answer, action) {
  return (
    answer?.action === action &&
    Number.isFinite(answer.confidence) &&
    answer.confidence >= MIN_CONFIDENCE &&
    answer.confidence <= 1
  );
}

function readOnly(text) {
  return /\b(?:read[ -]only|no (?:hold|booking|reservation)|without (?:booking|holding|reserving|scheduling)|(?:do not|don't|never|not(?: to)?)\s+(?:make|create|place|put|book|reserve|schedule|hold|arrange)|(?:just|only)\s+(?:show|list|find|check|tell))\b/i.test(
    text.replaceAll("’", "'"),
  );
}

function describe(error) {
  return error instanceof Error ? error.message.slice(0, 300) : "The operation did not complete.";
}

function inferenceEvidence(value) {
  if (typeof value?.model !== "string" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0)
    return {};
  const inference = { model: value.model.slice(0, 128), elapsedMs: value.elapsedMs };
  if (value.unavailable === true) inference.unavailable = true;
  const usage = Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, value.usage?.[field]]).filter(
      ([, count]) => Number.isSafeInteger(count) && count >= 0,
    ),
  );
  if (Object.keys(usage).length) inference.usage = usage;
  if (Number.isFinite(value.estimatedUsd) && value.estimatedUsd >= 0)
    inference.estimatedUsd = value.estimatedUsd;
  return { inference };
}

function earliestEachEvening(slots) {
  const evenings = new Map();
  for (const slot of slots) {
    const date = DINNER_DATE.format(new Date(slot));
    if (!evenings.has(date)) evenings.set(date, slot);
  }
  return [...evenings.values()];
}

function validateConstraints(value) {
  if (value === undefined) return NO_CONSTRAINTS;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { excludeDays = [], preferredDay = null } = value;
  if (!Array.isArray(excludeDays) || !excludeDays.every((day) => WEEKDAYS.has(day))) return null;
  if (preferredDay !== null && !WEEKDAYS.has(preferredDay)) return null;
  return { excludeDays: [...new Set(excludeDays)], preferredDay };
}

function weekday(slot) {
  return DINNER_WEEKDAY.format(new Date(slot)).toLowerCase();
}

export function createLoop({ load, save, model, calendar, now, newId }) {
  const saved = load();
  let current = { ...EMPTY_STATE, ...saved };
  if (saved && !Object.hasOwn(saved, "startedAt")) {
    current.startedAt = saved.trace?.find(({ type }) => type === "goal.started")?.at ?? null;
  }
  if (
    saved &&
    !Object.hasOwn(saved, "intent") &&
    (["choice", "approval"].includes(saved.status) ||
      ["availability", "recheck", "hold"].includes(saved.phase))
  ) {
    current.intent = "hold";
  }
  let running;

  function state() {
    const { phase, goal, holdKey, holdPasses, freshSlots, ...publicState } = current;
    return structuredClone(publicState);
  }

  function update(changes, ...events) {
    const revision = current.revision + 1;
    const time = now();
    const at = time instanceof Date ? time.toISOString() : time;
    const trace = changes.trace ?? current.trace;
    const next = {
      ...current,
      ...changes,
      revision,
      startedAt: changes.goal === undefined ? current.startedAt : at,
      trace: [...trace, ...events.map((event) => ({ ...event, at, revision }))].slice(
        -MAX_TRACE_EVENTS,
      ),
    };
    save(structuredClone(next));
    current = next;
  }

  function finish(status, message, ...events) {
    update({ status, message, phase: null }, ...events);
  }

  async function readShared() {
    const { excludeDays } = current.constraints;
    const [first, second] = await Promise.all(
      PEOPLE.map(async (person) => slotList(await calendar.read(person))),
    );
    const available = new Set(second);
    const shared = [...new Set(first)].filter((slot) => available.has(slot));
    const slots = shared.filter((slot) => !excludeDays.includes(weekday(slot))).sort();
    return {
      slots,
      evidence: [
        { type: "calendar.read", person: "first", count: first.length },
        { type: "calendar.read", person: "second", count: second.length },
        { type: "calendar.join", slots, excludedCount: shared.length - slots.length },
      ],
    };
  }

  function providerUnavailable(event, preceding = []) {
    if (!event.inference?.unavailable) return false;
    finish("blocked", "Workers AI is unavailable. Try the request again.", ...preceding, event, {
      type: "policy.block",
      reason: "provider-unavailable",
    });
    return true;
  }

  async function intake() {
    const { revision, text } = current;
    const extraction = await model.extract(text);
    if (current.revision !== revision) return;
    const constraints = validateConstraints(extraction?.constraints);
    const supported =
      extraction?.supported === true &&
      constraints !== null &&
      ["find", "hold"].includes(extraction.intent);
    const intent = supported ? extraction.intent : null;
    const evidence = {
      type: "goal.extract",
      supported,
      intent,
      constraints,
      ...inferenceEvidence(extraction?.inference),
    };
    if (providerUnavailable(evidence)) return;
    if (!supported || (intent === "hold" && readOnly(text))) {
      finish(
        "blocked",
        "I can find a one-hour family dinner time next week after 6 pm or ask you to approve a hold.",
        evidence,
        { type: "policy.block", reason: "scope" },
      );
      return;
    }

    const answer = await model.decide({ phase: "intake", text, intent, slots: [] });
    if (current.revision !== revision) return;
    const weighed = decision("intake", answer);
    if (providerUnavailable(weighed, [evidence])) return;
    if (!accepts(answer, "split")) {
      finish(
        "blocked",
        "I need a clearer request before checking the calendars.",
        evidence,
        weighed,
        { type: "policy.block", reason: "intake-decision" },
      );
      return;
    }
    update(
      { phase: "availability", intent, constraints, message: "Checking both calendars." },
      evidence,
      weighed,
      { type: "calendar.split", people: PEOPLE },
    );
  }

  function decision(phase, answer) {
    return {
      type: "goal.decide",
      phase,
      action: typeof answer?.action === "string" ? answer.action.slice(0, 64) : null,
      confidence: Number.isFinite(answer?.confidence) ? answer.confidence : null,
      ...inferenceEvidence(answer?.inference),
    };
  }

  async function availability() {
    const { revision, text, intent, freshSlots, constraints } = current;
    const { slots: shared, evidence } = freshSlots
      ? { slots: freshSlots, evidence: [] }
      : await readShared();
    if (current.revision !== revision) return;
    const slots = earliestEachEvening(shared);
    const preferredSlot = constraints.preferredDay
      ? (slots.find((slot) => weekday(slot) === constraints.preferredDay) ?? null)
      : null;
    const action =
      intent === "find"
        ? "report"
        : slots.length === 0
          ? "none"
          : slots.length === 1 || preferredSlot
            ? "propose"
            : "choose";
    const answer = await model.decide({
      phase: "availability",
      text,
      intent,
      slots: [...slots],
      preferredSlot,
      constraints: structuredClone(constraints),
    });
    if (current.revision !== revision) return;
    evidence.push({ type: "availability.eligible", slots, preferredSlot });
    const weighed = decision("availability", answer);
    if (providerUnavailable(weighed, evidence)) return;
    evidence.push(weighed);
    const clarify =
      intent === "hold" &&
      slots.length > 0 &&
      answer?.action === action &&
      Number.isFinite(answer.confidence) &&
      answer.confidence > 0 &&
      answer.confidence < MIN_CONFIDENCE;
    if (clarify) {
      evidence.push({ type: "clarification.requested", reason: "uncertain-selection" });
    } else if (!accepts(answer, action) && intent === "find") {
      evidence.push({ type: "policy.block", reason: "read-only-decision" });
    } else if (!accepts(answer, action)) {
      finish(
        "blocked",
        "I could not confirm the next step from the calendar results.",
        ...evidence,
        { type: "policy.block", reason: "availability-decision" },
      );
      return;
    }

    switch (clarify ? "choose" : action) {
      case "report":
        update(
          {
            status: "done",
            phase: null,
            slots,
            message: slots.length
              ? "Here are the shared dinner times."
              : "There is no shared dinner time next week.",
          },
          ...evidence,
          { type: "availability.reported", count: slots.length },
        );
        break;
      case "none":
        finish("done", "There is no shared dinner time next week.", ...evidence);
        break;
      case "propose":
        propose(preferredSlot ?? slots[0], slots, ...evidence);
        break;
      case "choose":
        update(
          {
            status: "choice",
            phase: null,
            slots,
            selected: null,
            message: clarify
              ? "Please choose from the verified times before I propose a hold."
              : "Choose a shared dinner time.",
          },
          ...evidence,
        );
        break;
    }
  }

  function propose(slot, slots, ...events) {
    update(
      {
        status: "approval",
        phase: null,
        slots,
        selected: slot,
        message: "Approve the calendar hold for this dinner time.",
      },
      ...events,
      { type: "hold.proposed", slot },
    );
  }

  function reopenAvailability(slots, evidence, reason) {
    update(
      {
        phase: "availability",
        freshSlots: slots,
        selected: null,
        slots: [],
        holdKey: null,
        holdPasses: 0,
        recovery: null,
        message: "Checking the remaining dinner times.",
      },
      ...evidence,
      { type: "availability.changed", reason },
    );
  }

  async function recheck() {
    const { revision, selected } = current;
    const { slots, evidence } = await readShared();
    if (current.revision !== revision) return;
    if (!slots.includes(selected)) {
      reopenAvailability(slots, evidence, "approved-slot-unavailable");
      return;
    }

    const holdKey = `dinner-${newId()}`;
    update(
      { phase: "hold", holdKey, holdPasses: 0, message: "Placing the approved calendar hold." },
      ...evidence,
      { type: "hold.intent", key: holdKey, slot: selected },
    );
  }

  function recordReceipt(receipt, slot, recovered) {
    if (typeof receipt?.id !== "string" || !receipt.id || receipt.slot !== slot) {
      throw new Error("Calendar hold receipt did not match the approved time");
    }
    const verified = { id: receipt.id, slot };
    update(
      {
        status: "done",
        phase: null,
        recovery: null,
        receipt: verified,
        message: "The dinner hold is on the calendar.",
      },
      { type: "hold.receipt", receipt: verified, recovered },
    );
  }

  async function recover(key, slot) {
    const receipt = await calendar.lookup(key);
    if (receipt === null) return false;
    recordReceipt(receipt, slot, true);
    return true;
  }

  async function hold(recovering) {
    const { holdKey: key, selected: slot } = current;
    if (recovering) {
      if (await recover(key, slot)) return;
      const { slots, evidence } = await readShared();
      if (!slots.includes(slot)) {
        reopenAvailability(slots, evidence, "approved-slot-unavailable");
        return;
      }
      update({}, ...evidence, { type: "hold.retry", key, slot });
    }
    try {
      recordReceipt(await calendar.hold({ key, slot }), slot, false);
    } catch (error) {
      update(
        { message: "Checking whether the approved hold was placed." },
        { type: "hold.uncertain", reason: describe(error) },
      );
      await recover(key, slot);
    }
  }

  function pauseRecovery() {
    update(
      {
        recovery: "manual",
        message: "The calendar hold needs manual reconciliation.",
      },
      { type: "hold.manual-required", attempts: current.holdPasses },
    );
  }

  async function reconcile() {
    const { holdKey: key, selected: slot } = current;
    if (await recover(key, slot)) return;
    const { slots, evidence } = await readShared();
    reopenAvailability(slots, evidence, "hold-not-found");
  }

  async function work(job) {
    const recovering = current.phase === "hold";
    while (running === job && current.status === "working") {
      const { phase, revision } = current;
      try {
        switch (phase) {
          case "intake":
            await intake();
            break;
          case "availability":
            await availability();
            break;
          case "recheck":
            await recheck();
            break;
          case "hold":
            if (job.manual) {
              await reconcile();
            } else {
              const attempts = current.holdPasses ?? 0;
              if (attempts >= MAX_HOLD_PASSES) {
                pauseRecovery();
                return state();
              }
              update({ holdPasses: attempts + 1 });
              await hold(recovering);
              if (current.phase === "hold") {
                if (current.holdPasses >= MAX_HOLD_PASSES) pauseRecovery();
                return state();
              }
            }
            break;
          default:
            throw new Error("Unknown work phase");
        }
      } catch (error) {
        if (running !== job || current.status !== "working") return state();
        const event = { type: "operation.failed", phase, reason: describe(error) };
        if (current.phase === "hold") {
          update({ message: "The calendar hold is awaiting confirmation." }, event);
          if (job.manual || current.holdPasses >= MAX_HOLD_PASSES) pauseRecovery();
        } else if (current.revision === revision) {
          finish("blocked", "I could not complete the dinner request.", event);
        }
        return state();
      }
    }
    return state();
  }

  function hasPending() {
    return current.status === "working" && current.recovery !== "manual";
  }

  function resume(manual = false) {
    if (!(manual || hasPending())) return Promise.resolve(state());
    const { goal } = current;
    if (running?.goal === goal && running.manual === manual) return running.promise;
    const job = { goal, manual };
    job.promise = Promise.resolve().then(async () => {
      try {
        return await work(job);
      } finally {
        if (running === job) running = undefined;
      }
    });
    running = job;
    return job.promise;
  }

  async function dispatch(command) {
    const { type, actor, revision, slot } = command;
    if (type === "start") {
      const text = typeof command.text === "string" ? command.text.trim() : "";
      const available = ["idle", "done", "blocked", "cancelled"].includes(current.status);
      if (
        typeof actor !== "string" ||
        !actor ||
        !text ||
        !available ||
        (current.actor && actor !== current.actor)
      ) {
        return state();
      }
      update(
        {
          ...EMPTY_STATE,
          actor,
          text,
          status: "working",
          phase: "intake",
          goal: current.revision + 1,
          holdKey: null,
          holdPasses: 0,
          freshSlots: null,
          message: "Checking the dinner request.",
        },
        { type: "goal.started" },
      );
      return resume();
    }
    if (actor !== current.actor || revision !== current.revision) return state();

    if (
      type === "choose" &&
      current.intent === "hold" &&
      current.status === "choice" &&
      current.slots.includes(slot)
    ) {
      propose(slot, current.slots, { type: "slot.chosen", actor, slot });
    } else if (type === "approve" && current.intent === "hold" && current.status === "approval") {
      update(
        {
          status: "working",
          phase: "recheck",
          freshSlots: null,
          message: "Rechecking both calendars.",
        },
        { type: "hold.approved", actor, approvalRevision: revision, slot: current.selected },
      );
      running = undefined;
      return resume();
    } else if (type === "reconcile" && current.phase === "hold" && current.recovery === "manual") {
      if (running?.manual) return running.promise;
      update(
        { message: "Checking whether the approved hold was placed." },
        { type: "hold.reconciliation", actor },
      );
      return resume(true);
    } else if (
      type === "cancel" &&
      ["working", "choice", "approval"].includes(current.status) &&
      current.phase !== "hold"
    ) {
      finish("cancelled", "The dinner request was cancelled.", { type: "goal.cancelled", actor });
    }
    return state();
  }

  return { dispatch, resume: () => resume(), state, hasPending };
}
