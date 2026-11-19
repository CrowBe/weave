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
  split: "Start both independent availability reads in parallel before joining their results.",
  abstain:
    "Wait for an operator clarification because a missing requirement prevents safe calendar reads.",
};
const availability = {
  none: "Tell the operator that there are no eligible dinner times for the proposed hold.",
  propose:
    "Show one eligible dinner time for the operator to approve a hold, selecting an available preferred evening when present.",
  choose:
    "Ask the operator to choose between the multiple eligible dinner times, when no available evening has priority.",
  report:
    "Summarize the eligible dinner times, including an empty result, for a find-only request without updating calendars or requesting approval.",
};
const decisionPolicy = [
  "For a find-only request, report all eligible shared evenings, including when the list is empty.",
  "For a calendar-hold request with no eligible shared evening, say there is no time.",
  "For a calendar-hold request with exactly one eligible shared evening, propose it for approval.",
  "If the preferred evening is eligible, propose it for approval even when alternatives exist.",
  "For a calendar-hold request with several eligible shared evenings and no eligible preferred evening, ask which evening.",
].join(" ");
const decisionWeekday = new Intl.DateTimeFormat("en-AU", { timeZone: zone, weekday: "long" });
const weekdayList = new Intl.ListFormat("en-US");
const eveningQuantities = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven"];

const fixtureSearch =
  /^(?:please )?(?:find|look for|show me) (?:a free hour|an hour|a one-hour slot|a 60-minute slot) for (?:a )?(?:(?:family|household) )?dinner (?:on our calendars )?next week,? (?:after (?:6 ?p\.?m|18:00)|in the evening)/i;
const fixtureFind =
  /^(?:[.!?])?(?: (?:do not|don't) (?:put|place|add) a hold(?: on (?:our|the) family calendar)?[.!?]?)?$/i;
const fixtureHold =
  /^(?: and|\. if there's an evening that works,) (?:put|place|add) a hold on (?:our|the) family calendar[.!?]?(?: if (?:(?:several|multiple) (?:evenings|slots|times) work|there are several), ask me which(?: one)?[.!?]?)?$/i;
const weekday = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const weekdayMention =
  /\b(?:mon(?:day)?|tue(?:sday|s)?|wed(?:nesday)?|thu(?:rsday|rs|r)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|weekday|weekend)s?\b/i;
const excluded = new RegExp(
  `(?:[,;]\\s*|\\s+)except(?: on)? (\\b(?:${weekday})\\b(?:(?:,\\s*| and )\\b(?:${weekday})\\b)*)(?=$|[,;.!?]| and )`,
  "gi",
);
const preferred = new RegExp(
  `(^|[.!?]\\s*|[,;]\\s*| and )(?:(?:i|we) (?:would )?)?prefer (${weekday})(?: if (?:it(?:'s| is) free|available))?(?=$|[,;.!?]| and )`,
  "gi",
);

function parseConstraints(text) {
  const excludeDays = new Set();
  const preferences = [];
  const normalized = text.trim().replace(/\s+/g, " ").replaceAll("’", "'");
  let base = normalized
    .replace(excluded, (_, days) => {
      for (const dayName of days.match(new RegExp(weekday, "gi"))) {
        excludeDays.add(dayName.toLowerCase());
      }
      return "";
    })
    .replace(preferred, (_, separator, dayName) => {
      preferences.push(dayName.toLowerCase());
      return /^[.!?]/.test(separator) ? separator.trim() : "";
    });
  if (preferences.length || excludeDays.size) {
    base = base
      .replace(/[.!?]+(?=\s|$)/g, (punctuation) => punctuation[0])
      .replace(/, (?=and )/g, " ")
      .trim();
  }
  const preferredDay = preferences[0] ?? null;
  if (preferences.length > 1 || excludeDays.has(preferredDay) || weekdayMention.test(base))
    return null;
  return { base, constraints: { excludeDays: [...excludeDays], preferredDay } };
}

const extractionFields = {
  meal: { type: "text", instructions: "Meal noun, e.g. dinner." },
  week: { type: "text", instructions: "Requested week, e.g. next week." },
  duration: {
    type: "duration",
    unit: "minutes",
    instructions:
      "Convert the requested length of the calendar slot to minutes. An hour is 60 minutes.",
  },
  hold: {
    type: "boolean",
    instructions:
      "Does the operator want to reserve or block a time on the family calendar (create a tentative calendar hold)?",
  },
  search: {
    type: "boolean",
    instructions: "Does the operator ask to find an available time for dinner?",
  },
  blocker: {
    type: "boolean",
    instructions:
      "Does this request contain a calendar constraint other than one hour for dinner next week after 6 pm, search or a family calendar hold, one excluded weekday, and one preferred weekday?",
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

const eveningBound =
  /\b(?:(?:after|later than|past) (?:6 ?p\.?m\.?|18:00)|in the evenings?)(?![\w:])/gi;
const additionalTiming =
  /\b(?:before|by|until|between|tomorrow|tonight|weekday|weekend|bank holiday|public holiday|when school ends|when work ends)\b|\b\d{1,2}(?::\d{2}|\s*[ap]\.?m\b)/i;
const additionalEffect =
  /\b(?:send|message|invite|notify|remind|cancel|delete|reschedule|repeat|restaurant|venue|booking|book a table)\b/i;
const noWrite =
  /\b(?:read[ -]only|no (?:hold|booking|reservation)|without (?:booking|holding|reserving|scheduling)|(?:do not|don't|would not|wouldn't|must not|mustn't|never|not(?: to)?)\s+(?:make|create|place|put|book|reserve|schedule|hold|arrange)|(?:just|only)\s+(?:show|list|find|check|tell))\b/i;
const holdLanguage = /\b(?:hold|reserve|block off|pencil(?: it)? in)\b/i;
const positiveHold =
  /\b(?:(?:put|place|add|create|make|schedule)\b[^.!?]{0,50}\bhold|hold|reserve|block(?: off)?|pencil(?: it)? in)\b[^.!?]{0,60}\b(?:on|in) (?:the |our )?family calendar\b/i;

function supportedTiming(text) {
  const withoutBound = text.replace(eveningBound, "");
  return withoutBound !== text && !additionalTiming.test(withoutBound);
}

function booleanAnswer(answer, value) {
  return reliable(answer, "boolean") && answer.value === value;
}

function extractedIntent(result, text) {
  if (result?.truncated !== false || !result.answers) return null;
  const { meal, week, duration, hold, search, blocker } = result.answers;
  if (
    !booleanAnswer(blocker, false) ||
    !reliable(duration, "duration") ||
    duration.unit !== "minutes" ||
    duration.value !== 60 ||
    !/^(?:dinner|supper)$/.test(grounded(meal, text)) ||
    !/^next week$/.test(grounded(week, text)) ||
    !supportedTiming(text) ||
    additionalEffect.test(text)
  )
    return null;
  if (positiveHold.test(text) && !noWrite.test(text)) {
    return booleanAnswer(hold, true) ? "hold" : null;
  }
  if ((hold?.value === true || holdLanguage.test(text)) && !noWrite.test(text)) return null;
  return booleanAnswer(search, true) ? "find" : null;
}

function extraction(intent, constraints) {
  return intent ? { supported: true, intent, constraints } : { supported: false };
}

function decisionFor(intent, slots, preferredSlot) {
  if (intent === "find") return { action: "report", confidence: 1 };
  if (slots.length === 0) return { action: "none", confidence: 1 };
  return { action: slots.length === 1 || preferredSlot ? "propose" : "choose", confidence: 1 };
}

function availabilityFacts(intent, slots, preferredSlot, preferredDay) {
  const request = intent === "find" ? "a find-only search" : "a calendar hold";
  const evenings = slots.map((slot) => decisionWeekday.format(new Date(slot)));
  const count = evenings.length;
  const quantity = eveningQuantities[count] ?? count;
  const eligible =
    count === 0
      ? "Zero shared dinner evenings are eligible."
      : count === 1
        ? `Only one shared dinner evening is eligible: ${evenings[0]}.`
        : `${quantity} shared dinner evenings are eligible: ${weekdayList.format(evenings)}.`;
  let preference = "";
  if (preferredSlot) {
    preference = ` ${decisionWeekday.format(new Date(preferredSlot))} is preferred and available.`;
  } else if (preferredDay) {
    preference = ` ${preferredDay} is preferred but is not eligible.`;
  } else if (intent === "hold" && count > 1) {
    preference = " No evening is preferred.";
  }
  return `The operator requests ${request}. ${eligible}${preference}`;
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
    let unavailable;
    try {
      result = await runAI(model, input);
    } catch {
      unavailable = true;
    }
    const inference = { model, elapsedMs: Math.max(0, monotonicNow() - started) };
    if (unavailable) inference.unavailable = true;
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
      const parsed = parseConstraints(text);
      if (!parsed) return { supported: false };
      if (!runAI) return extraction(fixtureIntent(parsed.base), parsed.constraints);
      const { result, inference } = await infer(clairic, {
        model: "clairic",
        state: parsed.base,
        fields: extractionFields,
      });
      return { ...extraction(extractedIntent(result, parsed.base), parsed.constraints), inference };
    },
    async decide({ phase, text, intent, slots = [], preferredSlot = null, constraints } = {}) {
      if (
        !["find", "hold"].includes(intent) ||
        (phase !== "intake" &&
          (phase !== "availability" ||
            !Array.isArray(slots) ||
            slots.some((slot) => typeof slot !== "string" || !Number.isFinite(Date.parse(slot))) ||
            (preferredSlot !== null && !slots.includes(preferredSlot))))
      )
        return { ...abstain };
      if (!runAI) {
        if (phase === "intake") return { action: "split", confidence: 1 };
        return decisionFor(intent, slots, preferredSlot);
      }
      const criteria = phase === "intake" ? intake : availability;
      const state =
        phase === "intake"
          ? {
              Goal: text,
              Request:
                intent === "hold"
                  ? "Find shared availability and then seek approval for a family calendar hold."
                  : "Find and report shared availability without changing calendars.",
              Inputs:
                "Two configured household calendars are known. Each read is independent; comparing evenings requires both calendar results.",
            }
          : {
              Goal: text,
              Policy: decisionPolicy,
              Facts: availabilityFacts(intent, slots, preferredSlot, constraints?.preferredDay),
            };
      const { result, inference } = await infer(clef, {
        model: "clef",
        state,
        questions: {
          action: {
            type: "choice",
            instructions:
              phase === "intake"
                ? "Which plan advances the goal with its dependencies respected?"
                : "Which of the following actions applies? Follow the policy and the calendar facts.",
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
