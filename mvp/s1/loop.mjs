// A general System 1 loop: Input -> Extract -> Decide -> Act.
//
// Unlike the calendar MVP, the runtime does not work out the answer and ask the
// model to agree. Clef's choices pick the branch. The runtime only refuses
// choices that are unsafe or unsupported: low confidence, an unknown tool,
// arguments missing from the request, or an effect above the tool's risk floor.

export const CLAIRIC = "@cf/cloudflare/clairic";
export const CLEF = "@cf/cloudflare/clef";

export const BANDS = {
  tool_call: "One tool action from the catalogue completes the request.",
  spawn_subtasks:
    "The request has two or more independent parts that should run as separate child tasks.",
  escalate_gen:
    "The request needs free-form writing or planning, such as a draft, an itinerary or an essay, rather than a tool action.",
  ask_human:
    "Ask the user first: the request is ambiguous, names an unclear target, or asks for an irreversible or destructive act that needs their confirmation.",
};

const BAND_POLICY =
  "The original request is authoritative; extraction hints may be incomplete. " +
  "Choose ask_human when an irreversible act is requested or the target is unclear. " +
  "Choose spawn_subtasks only for independent parts; a single read followed by writing is still one part when no tool is needed for the writing.";

// The classifier's questions. Each is a probability that the answer is yes.
const RISK_QUESTIONS = {
  irreversible: "Would this action be hard or impossible to undo (deleting, sending, sharing)?",
  external: "Would anyone outside the household see or receive the result of this action?",
  others_data: "Does this action change something another person owns or relies on, such as a shared document or calendar?",
  broad: "Does this action affect many items at once rather than one specific item?",
};

export const RISK_LEVELS = ["auto", "notify", "approve"];
const higher = (a, b) => (RISK_LEVELS.indexOf(a) >= RISK_LEVELS.indexOf(b) ? a : b);

const DEFAULTS = {
  bandThreshold: 0.5,
  toolThreshold: 0.5,
  argThreshold: 0.5,
  riskUncertainty: [0.3, 0.7],
  maxChildren: 4,
};

const probability = (v) => Number.isFinite(v) && v >= 0 && v <= 1;

function readChoice(answer, options) {
  if (
    answer?.type !== "choice" ||
    !Object.hasOwn(options, answer.choice) ||
    !probability(answer.confidence)
  )
    return null;
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities ?? null,
  };
}

function readNoul(answer) {
  return answer?.type === "noul" && probability(answer.noul) ? answer.noul : null;
}

function grounded(answer, text) {
  if (typeof answer?.value !== "string" || !answer.value.trim()) return null;
  if (Array.isArray(answer.span) && answer.span.length === 2) {
    const [from, to] = answer.span;
    if (text.slice(from, to) !== answer.value) return null;
  } else if (!text.includes(answer.value)) return null;
  return answer.value.trim();
}

function list(answer, text) {
  if (answer?.type !== "list" || !Array.isArray(answer.value)) return [];
  return answer.value.filter((item) => typeof item === "string" && item.trim() && text.includes(item));
}

/**
 * Map the classifier's probabilities to an approval level. The tool's floor is a
 * minimum; the classifier can raise it but never lower it. Uncertain answers ask.
 */
export function classifyRisk(scores, floor, [low, high] = DEFAULTS.riskUncertainty) {
  const values = Object.values(scores);
  let level;
  if (values.some((p) => p === null || (p > low && p < high))) level = "approve";
  else if (scores.irreversible >= high || scores.external >= high) level = "approve";
  else if (scores.others_data >= high || scores.broad >= high) level = "notify";
  else level = "auto";
  return higher(level, floor);
}

export function createS1({ runAI, tools, now = () => performance.now(), options = {} }) {
  const config = { ...DEFAULTS, ...options };
  const calls = [];

  async function infer(stage, model, input) {
    const started = now();
    let result;
    let error;
    try {
      result = await runAI(model, input);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    calls.push({
      stage,
      model,
      elapsedMs: Math.round(now() - started),
      usage: result?.usage ?? null,
      ...(error ? { error } : {}),
    });
    if (error) throw new Error(`${stage}: ${error}`);
    return result;
  }

  async function extract(text) {
    const result = await infer("extract", CLAIRIC, {
      model: "clairic",
      state: text,
      fields: {
        entities: {
          type: "list",
          items: "text",
          instructions: "Named people, emails, files, folders, calendars, ids, repos and channels, exactly as written.",
        },
        prohibitions: {
          type: "list",
          items: "text",
          instructions: "Each complete do-not or never instruction, keeping the negation.",
        },
        subtasks: {
          type: "list",
          items: "text",
          instructions: "Each separate thing the user asks to be done, as written. One item when there is only one request.",
        },
      },
    });
    const answers = result?.answers ?? {};
    return {
      entities: list(answers.entities, text),
      prohibitions: list(answers.prohibitions, text),
      subtasks: list(answers.subtasks, text),
    };
  }

  async function decideBand(text, hints, allowSpawn) {
    const criteria = { ...BANDS };
    if (!allowSpawn) delete criteria.spawn_subtasks;
    const result = await infer("decide.band", CLEF, {
      model: "clef",
      state: { Request: text, Hints: hints, Policy: BAND_POLICY },
      questions: {
        band: { type: "choice", instructions: "Which kind of next step fits this request?", criteria },
      },
    });
    return readChoice(result?.answers?.band, criteria);
  }

  async function decideTool(text, hints) {
    const criteria = Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, tool.description]),
    );
    criteria.none = "No tool in the catalogue does what the request asks.";
    const result = await infer("decide.tool", CLEF, {
      model: "clef",
      state: {
        Request: text,
        Hints: hints,
        Policy: "Pick the single tool that does what the request asks. Prefer the least destructive tool that fits.",
      },
      questions: { tool: { type: "choice", instructions: "Which tool?", criteria } },
    });
    return readChoice(result?.answers?.tool, criteria);
  }

  async function extractArgs(text, tool) {
    const result = await infer("extract.args", CLAIRIC, {
      model: "clairic",
      state: text,
      fields: Object.fromEntries(
        Object.entries(tool.args).map(([name, arg]) => [name, { type: "text", instructions: arg.instructions }]),
      ),
    });
    const args = {};
    const missing = [];
    for (const [name, spec] of Object.entries(tool.args)) {
      const answer = result?.answers?.[name];
      const value = grounded(answer, text);
      const confident =
        probability(answer?.confidence) &&
        answer.confidence >= config.argThreshold &&
        !(probability(answer?.p_null) && answer.p_null > 1 - config.argThreshold);
      if (value !== null && confident) args[name] = value;
      else if (spec.required) missing.push(name);
    }
    return { args, missing };
  }

  async function classify(text, toolName, tool, args) {
    if (tool.floor === "approve") return { level: "approve", scores: null, floor: tool.floor };
    const result = await infer("classify", CLEF, {
      model: "clef",
      state: {
        Request: text,
        Action: `${toolName}: ${tool.description}`,
        Arguments: args,
        Household: "Two adults share this assistant. Their own mail, calendars and files are household data.",
      },
      questions: Object.fromEntries(
        Object.entries(RISK_QUESTIONS).map(([key, instructions]) => [key, { type: "noul", instructions }]),
      ),
    });
    const scores = Object.fromEntries(
      Object.keys(RISK_QUESTIONS).map((key) => [key, readNoul(result?.answers?.[key])]),
    );
    return { level: classifyRisk(scores, tool.floor, config.riskUncertainty), scores, floor: tool.floor };
  }

  /** Run one goal node. `board` is the node's slot on the shared blackboard. */
  async function step(text, board, depth) {
    board.input = text;
    const hints = await extract(text);
    board.extract = hints;

    const band = await decideBand(text, hints, depth === 0);
    board.band = band;
    if (!band || band.confidence < config.bandThreshold) {
      return (board.result = { status: "asked", reason: "uncertain-band" });
    }

    switch (band.choice) {
      case "ask_human":
        return (board.result = { status: "asked", reason: "model-asked" });
      case "escalate_gen":
        // System 2 picks this up with the extracted hints as its brief.
        return (board.result = { status: "escalated", brief: { request: text, ...hints } });
      case "spawn_subtasks": {
        const parts = hints.subtasks.slice(0, config.maxChildren);
        if (parts.length < 2) return (board.result = { status: "asked", reason: "split-unclear" });
        const context = hints.prohibitions.length ? `\nKeep to: ${hints.prohibitions.join("; ")}.` : "";
        board.children = parts.map(() => ({}));
        const results = await Promise.all(
          parts.map((part, i) => step(part + context, board.children[i], depth + 1)),
        );
        const status = ["asked", "awaiting_approval", "escalated", "done"].find((s) =>
          results.some((r) => r.status === s),
        );
        return (board.result = { status: status ?? "done", children: results.length });
      }
      case "tool_call": {
        const pick = await decideTool(text, hints);
        board.tool = pick;
        if (!pick || pick.choice === "none" || pick.confidence < config.toolThreshold) {
          return (board.result = { status: "asked", reason: "no-tool" });
        }
        const tool = tools[pick.choice];
        const { args, missing } = await extractArgs(text, tool);
        board.args = args;
        if (missing.length) return (board.result = { status: "asked", reason: "missing-args", missing });
        const risk = await classify(text, pick.choice, tool, args);
        board.risk = risk;
        const action = { tool: pick.choice, args };
        if (risk.level === "approve") return (board.result = { status: "awaiting_approval", action });
        const output = await tool.run(args);
        return (board.result = { status: "done", action, output, notify: risk.level === "notify" });
      }
    }
    return (board.result = { status: "blocked", reason: "unknown-band" });
  }

  return {
    async run(text) {
      const board = {};
      let result;
      try {
        result = await step(text, board, 0);
      } catch (error) {
        result = board.result = { status: "blocked", reason: error.message };
      }
      return { result, board, calls: calls.splice(0) };
    },
  };
}
