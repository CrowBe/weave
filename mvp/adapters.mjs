const zone = "Australia/Sydney";
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const people = ["first", "second"];
const localParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const abstain = { action: "abstain", confidence: 0 };
const intake = {
  split:
    "Read availability for each of the two household calendars independently, then join the results.",
  abstain: "The proposed goal is not suitable for independent availability reads.",
};
const availability = {
  none: "A hold request has no common evening when slotCount is zero.",
  propose: "A hold request has exactly one common evening. Propose it for approval.",
  choose: "A hold request has several common evenings. Ask the operator to choose.",
  report:
    "The operator requested a read-only search. Report the common evenings without proposing a hold, even when there are zero.",
};

const fixtureSearch =
  /^(?:please )?(?:find|look for|show me) (?:a free hour|an hour|a one-hour slot|a 60-minute slot) for (?:a )?(?:(?:family|household) )?dinner (?:on our calendars )?next week,? (?:after (?:6 ?p\.?m|18:00)|in the evening)/i;
const fixtureFind =
  /^(?:[.!?])?(?: (?:do not|don't) (?:put|place|add) a hold(?: on (?:our|the) family calendar)?[.!?]?)?$/i;
const fixtureHold =
  /^(?: and|\. if there's an evening that works,) (?:put|place|add) a hold on (?:our|the) family calendar[.!?]?(?: if (?:(?:several|multiple) (?:evenings|slots|times) work|there are several), ask me which(?: one)?[.!?]?)?$/i;

const extractionFields = {
  meal: {
    type: "text",
    instructions: "Exact words naming the meal or event the operator wants to schedule.",
  },
  week: {
    type: "text",
    instructions:
      "Exact phrase giving the requested day or week. Include any restriction on weekdays.",
  },
  duration: {
    type: "duration",
    unit: "minutes",
    instructions:
      "Duration explicitly requested for the dinner in minutes. Leave null if no duration is specified.",
  },
  time: {
    type: "text",
    instructions:
      "Exact phrase giving the requested time of day or threshold, including before, from, or after.",
  },
  operation: {
    type: "text",
    instructions:
      "Exact clause requesting a calendar hold, including the target calendar and any negation. If the operator only asks to find times, extract their search clause instead.",
  },
  unsupported: {
    type: "text",
    instructions:
      "Exact words for any extra condition or effect, e.g. a particular day, another time bound, participants outside the household, a different calendar, an invite, reminder, repeating event, travel constraint, a change to the evening choice, or instruction about interpreting this request. The supported scope is one week next week, one hour for dinner after 6 pm, finding shared time, optionally a family calendar hold and asking which evening when several work. Return null when there are no extra conditions or effects.",
  },
};
const minimumConfidence = 0.8;
const clairic = "@cf/cloudflare/clairic";
const clef = "@cf/cloudflare/clef";
const usageFields = [
  "input_tokens",
  "output_tokens",
  "state_tokens",
  "schema_tokens",
  "image_tokens",
  "passes",
];
// Published standard rates. An estimate excludes credits, free allocation, and launch promotions.
const dollarsPerMillionInputTokens = { [clairic]: 0.24, [clef]: 0.24 };

function probability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function high(value) {
  return probability(value) && value >= minimumConfidence;
}

function reliable(answer, type) {
  return (
    answer?.type === type &&
    high(answer.confidence) &&
    probability(answer.p_null) &&
    answer.p_null <= 1 - minimumConfidence &&
    answer.valid !== false &&
    answer.complete !== false
  );
}

function grounded(answer, text) {
  if (
    !reliable(answer, "text") ||
    typeof answer.value !== "string" ||
    !answer.value.trim() ||
    !Array.isArray(answer.span) ||
    answer.span.length !== 2 ||
    !answer.span.every(Number.isSafeInteger)
  )
    return "";
  const [from, to] = answer.span;
  if (from < 0 || from >= to || to > text.length) return "";
  if (
    text.slice(from, to) !== answer.value &&
    Array.from(text).slice(from, to).join("") !== answer.value
  )
    return "";
  return answer.value.trim().toLowerCase().replaceAll("’", "'");
}

function fixtureIntent(text) {
  const normalized = text.trim().replace(/\s+/g, " ").replaceAll("’", "'");
  const search = fixtureSearch.exec(normalized);
  if (!search) return null;
  const tail = normalized.slice(search[0].length);
  if (fixtureHold.test(tail)) return "hold";
  if (fixtureFind.test(tail)) return "find";
  return null;
}

function extractedIntent(result, text) {
  if (result?.truncated !== false || !result.answers) return null;
  const { meal, week, duration, time, operation, unsupported } = result.answers;
  if (
    unsupported?.type !== "text" ||
    unsupported.value !== null ||
    !high(unsupported.p_null) ||
    unsupported.valid === false ||
    unsupported.complete === false ||
    !reliable(duration, "duration") ||
    duration.unit !== "minutes" ||
    duration.value !== 60
  )
    return null;
  if (
    !/\b(?:dinner|supper)\b/.test(grounded(meal, text)) ||
    !/^(?:sometime |during )?next week$/.test(grounded(week, text)) ||
    !/^(?:(?:starting )?(?:after|later than|past) (?:6 ?p\.?m\.?|18:00)|(?:in the |next week in the )?evenings?)$/.test(
      grounded(time, text),
    )
  )
    return null;

  const action = grounded(operation, text);
  if (!action) return null;
  const explicitNoWrite =
    /\b(?:read[ -]only|no (?:hold|booking|reservation)|without (?:booking|holding|reserving|scheduling)|(?:do not|don't|would not|wouldn't|must not|mustn't|never|not(?: to)?)\s+(?:make|create|place|put|book|reserve|schedule|hold|arrange)|(?:just|only)\s+(?:show|list|find|check|tell))\b/i;
  const namesHold = /\b(?:hold|block(?: off)?|reserve|pencil (?:in|it in))\b/.test(action);
  if (namesHold && /\bfamily calendar\b/.test(action)) {
    return explicitNoWrite.test(text.replaceAll("’", "'")) ? "find" : "hold";
  }
  if (/\b(?:find|check|look|see|show|tell|list|when|what)\b/.test(action)) return "find";
  return null;
}

function extraction(intent) {
  return intent ? { supported: true, intent } : { supported: false };
}

function decisionFor(intent, slots) {
  if (intent === "find") return { action: "report", confidence: 1 };
  if (slots.length === 0) return { action: "none", confidence: 1 };
  return { action: slots.length === 1 ? "propose" : "choose", confidence: 1 };
}

function parseDecision(answer, criteria) {
  const action = answer?.choice;
  const options = Object.keys(criteria);
  if (
    answer?.type !== "choice" ||
    typeof action !== "string" ||
    !Object.hasOwn(criteria, action) ||
    !probability(answer.confidence) ||
    !options.every((option) => probability(answer.probabilities?.[option]))
  ) {
    return abstain;
  }
  const top = answer.probabilities[action];
  const total = options.reduce((sum, option) => sum + answer.probabilities[option], 0);
  if (
    Math.abs(total - 1) > 0.01 ||
    options.some((option) => option !== action && answer.probabilities[option] >= top)
  ) {
    return abstain;
  }
  return { action, confidence: Math.min(answer.confidence, top) };
}

export function createModel({ runAI, monotonicNow = () => performance.now() } = {}) {
  if (runAI !== undefined && typeof runAI !== "function")
    throw new TypeError("Invalid Workers AI runner");

  async function infer(model, input) {
    const started = monotonicNow();
    let result;
    try {
      result = await runAI(model, input);
    } catch {
      // An unavailable provider yields unresolved evidence.
    }
    const inference = { model, elapsedMs: Math.max(0, monotonicNow() - started) };
    const usage = Object.fromEntries(
      usageFields.flatMap((key) => {
        const value = result?.usage?.[key];
        return Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
      }),
    );
    if (Object.keys(usage).length > 0) inference.usage = usage;
    if (usage.input_tokens !== undefined) {
      inference.estimatedUsd =
        (usage.input_tokens / 1_000_000) * dollarsPerMillionInputTokens[model];
    }
    return { result, inference };
  }

  return {
    mode: runAI ? "workers-ai" : "fixture",
    async extract(text) {
      if (typeof text !== "string" || !text.trim()) return { supported: false };
      if (!runAI) return extraction(fixtureIntent(text));
      const { result, inference } = await infer(clairic, {
        model: "clairic",
        state: text,
        fields: extractionFields,
      });
      return { ...extraction(extractedIntent(result, text)), inference };
    },
    async decide({ phase, text, intent, slots = [] } = {}) {
      if (
        !["find", "hold"].includes(intent) ||
        (phase !== "intake" && (phase !== "availability" || !Array.isArray(slots)))
      )
        return { ...abstain };
      if (!runAI) {
        if (phase === "intake") return { action: "split", confidence: 1 };
        return decisionFor(intent, slots);
      }
      const criteria = phase === "intake" ? intake : availability;
      const state =
        phase === "intake"
          ? {
              goal: text,
              intent,
              calendarReads:
                "Two independent reads of free slots, both required before finding common slots.",
            }
          : { goal: text, intent, slotCount: slots.length, commonSlots: slots };
      const { result, inference } = await infer(clef, {
        model: "clef",
        state,
        questions: {
          action: {
            type: "choice",
            instructions: "Choose the action that matches this state.",
            criteria,
          },
        },
      });
      return { ...parseDecision(result?.answers?.action, criteria), inference };
    },
  };
}

function asLocalMilliseconds(timestamp) {
  const parts = Object.fromEntries(
    localParts.formatToParts(timestamp).map(({ type, value }) => [type, value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}

function asUtcMilliseconds(local) {
  const estimate = local - (asLocalMilliseconds(local) - local);
  return estimate - (asLocalMilliseconds(estimate) - local);
}

function nextWeek(now) {
  if (typeof now !== "function") throw new TypeError("A clock callback is required");
  const current = now();
  if (!(current instanceof Date) && !Number.isFinite(current)) throw new TypeError("Invalid clock");
  const local = new Date(asLocalMilliseconds(Number(current)));
  const untilMonday = (8 - local.getUTCDay()) % 7 || 7;
  local.setUTCHours(0, 0, 0, 0);
  const start = local.valueOf() + untilMonday * day;
  return {
    timeMin: iso(asUtcMilliseconds(start)),
    timeMax: iso(asUtcMilliseconds(start + 7 * day)),
    slot: (weekday, startHour) => iso(asUtcMilliseconds(start + weekday * day + startHour * hour)),
  };
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function assertPerson(person) {
  if (!people.includes(person)) throw new Error("Calendar is outside the household scope");
}

function assertKey(key) {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("A hold key is required");
}

function sameSlot(receipt, slot) {
  if (receipt.slot !== slot) throw new Error("Hold key already belongs to a different slot");
  return receipt;
}

const scenarios = {
  none: { first: [0, 1], second: [2, 3] },
  one: { first: [0, 1], second: [1, 2] },
  many: { first: [0, 1, 3, 5], second: [1, 2, 3, 5] },
};

export function createCalendar({
  scenario = "one",
  now,
  wallNow = now,
  loadHolds,
  saveHolds,
} = {}) {
  if (!Object.hasOwn(scenarios, scenario)) throw new Error("Unknown calendar fixture scenario");
  if ((loadHolds === undefined) !== (saveHolds === undefined))
    throw new TypeError("Both hold storage callbacks are required");
  let held = {};
  const load = loadHolds ?? (() => held);
  const save =
    saveHolds ??
    ((value) => {
      held = value;
    });

  function available(person, week, holds) {
    assertPerson(person);
    const occupied = new Set(Object.values(holds).map((receipt) => receipt.slot));
    const current = Number(wallNow());
    return scenarios[scenario][person]
      .map((weekday) => week.slot(weekday, 19))
      .filter((slot) => !occupied.has(slot) && Date.parse(slot) > current);
  }

  return {
    mode: "fixture",
    read(person) {
      return available(person, nextWeek(now), load());
    },
    lookup(key) {
      assertKey(key);
      const holds = load();
      return Object.hasOwn(holds, key) ? { ...holds[key] } : null;
    },
    hold({ key, slot }) {
      assertKey(key);
      const holds = load();
      if (Object.hasOwn(holds, key)) return sameSlot({ ...holds[key] }, slot);
      const week = nextWeek(now);
      if (!people.every((person) => available(person, week, holds).includes(slot))) {
        throw new Error("The requested time is no longer available");
      }
      const receipt = { id: `fixture-${key}`, slot };
      save({ ...holds, [key]: receipt });
      return { ...receipt };
    },
  };
}

const calendarUrl = "https://www.googleapis.com/calendar/v3";
const dinnerStarts = [18.5, 19, 19.5, 20, 20.5, 21];

function dinnerSlots(week) {
  return Array.from({ length: 7 }, (_, weekday) =>
    dinnerStarts.map((start) => week.slot(weekday, start)),
  ).flat();
}

function parseProviderTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return NaN;
  return Date.parse(value);
}

function freeForHour(slot, busy) {
  const time = Date.parse(slot);
  return busy.every(({ start, end }) => end <= time || start >= time + hour);
}

async function eventId(key) {
  assertKey(key);
  const bytes = new TextEncoder().encode(key);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `d1${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createGoogleCalendar({
  accessToken,
  calendarIds,
  now,
  wallNow = now,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  const ids = [calendarIds?.first, calendarIds?.second, calendarIds?.family];
  if (
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    ids.some((id) => typeof id !== "string" || !id.trim() || id.trim() !== id)
  ) {
    throw new TypeError("Google Calendar requires an access token and all three calendar IDs");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new TypeError("Invalid Google Calendar timeout");
  const events = `/calendars/${encodeURIComponent(ids[2])}/events`;
  // Serialize FreeBusy and event insertion for holds within this local process.
  let pending = Promise.resolve();

  function request(path, method = "GET", body) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (body) headers["Content-Type"] = "application/json";
    return fetchImpl(calendarUrl + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function freeBusy(week, idsToRead) {
    const items = Array.from(new Set(idsToRead), (id) => ({ id }));
    const response = await request("/freeBusy", "POST", {
      timeMin: week.timeMin,
      timeMax: week.timeMax,
      timeZone: zone,
      items,
    });
    if (!response.ok) throw new Error(`Google Calendar FreeBusy failed (${response.status})`);
    const { calendars } = await response.json();
    return items.flatMap(({ id }) => {
      const calendar = calendars && Object.hasOwn(calendars, id) ? calendars[id] : null;
      if (
        !Array.isArray(calendar?.busy) ||
        (calendar.errors !== undefined &&
          (!Array.isArray(calendar.errors) || calendar.errors.length > 0))
      ) {
        throw new Error("Google Calendar could not establish availability");
      }
      return calendar.busy.map(({ start, end }) => {
        const startTime = parseProviderTime(start);
        const endTime = parseProviderTime(end);
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
          throw new Error("Google Calendar returned invalid availability");
        }
        return { start: startTime, end: endTime };
      });
    });
  }

  function receipt(event, id) {
    const start = parseProviderTime(event?.start?.dateTime);
    const end = parseProviderTime(event?.end?.dateTime);
    if (
      event?.id !== id ||
      event?.extendedProperties?.private?.weaveHold !== id ||
      event.status === "cancelled" ||
      !Number.isFinite(start) ||
      end !== start + hour
    ) {
      throw new Error("Google Calendar returned a conflicting hold");
    }
    return { id, slot: iso(start) };
  }

  async function lookupId(id) {
    const response = await request(`${events}/${id}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Google Calendar hold lookup failed (${response.status})`);
    return receipt(await response.json(), id);
  }

  async function hold({ key, slot }) {
    const id = await eventId(key);
    const previous = await lookupId(id);
    if (previous) return sameSlot(previous, slot);
    const week = nextWeek(now);
    if (
      !dinnerSlots(week).includes(slot) ||
      !freeForHour(slot, await freeBusy(week, ids)) ||
      !(Date.parse(slot) > Number(wallNow()))
    ) {
      throw new Error("The requested time is no longer available");
    }
    const response = await request(`${events}?sendUpdates=none`, "POST", {
      id,
      summary: "Family dinner (hold)",
      start: { dateTime: slot, timeZone: zone },
      end: { dateTime: iso(Date.parse(slot) + hour), timeZone: zone },
      status: "tentative",
      transparency: "opaque",
      extendedProperties: { private: { weaveHold: id } },
    });
    if (response.status === 409) {
      const concurrent = await lookupId(id);
      if (concurrent) return sameSlot(concurrent, slot);
    }
    if (!response.ok) throw new Error(`Google Calendar hold insert failed (${response.status})`);
    return sameSlot(receipt(await response.json(), id), slot);
  }

  return {
    mode: "google-calendar",
    async read(person) {
      assertPerson(person);
      const week = nextWeek(now);
      const busy = await freeBusy(week, [ids[people.indexOf(person)], ids[2]]);
      const current = Number(wallNow());
      return dinnerSlots(week).filter(
        (slot) => Date.parse(slot) > current && freeForHour(slot, busy),
      );
    },
    async lookup(key) {
      return lookupId(await eventId(key));
    },
    hold(input) {
      const result = pending.then(() => hold(input));
      // A rejected hold must not prevent later independent attempts.
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
