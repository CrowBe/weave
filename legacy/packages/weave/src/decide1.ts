/** Decide-1 is deterministic policy over bounded observations, never execution authority. */
export const DECIDE1_BANDS = Object.freeze(['tool_call', 'spawn_subtasks', 'escalate_gen', 'ask_human'] as const);
export type Band = (typeof DECIDE1_BANDS)[number];
export const DECIDE1_RULE_TABLE = 'decide1.rules@3' as const;
export interface Decide1Judgment {
  readonly name: string;
  readonly probability: number;
}
export interface Decide1Fact {
  readonly name: string;
  readonly value: string | number | boolean | null;
}
export interface Decide1Inputs {
  readonly judgments: readonly Decide1Judgment[];
  readonly facts: readonly Decide1Fact[];
  /** Recorded in the trace, never given to a row (D-ENG-047). Promotion is a row diff plus a table bump. */
  readonly shadow?: {
    readonly judgments: readonly Decide1Judgment[];
    readonly facts: readonly Decide1Fact[];
  };
}
export type Decide1RuleId =
  | 'hold.admission'
  | 'hold.outage'
  | 'hold.paused'
  | 'hold.dependency_pending'
  | 'hold.unmet_dependency'
  | 'act.read'
  | 'gen.child'
  | 'gen.child_fallback'
  | 'ask.intake'
  | 'ask.irreversible'
  | 'ask.thread_target'
  | 'act.thread'
  | 'ask.triage'
  | 'act.capability'
  | 'act.done_check'
  | 'act.decline'
  | 'gen.triage_fallback'
  | 'spawn.preflight'
  | 'gen.route'
  | 'ask.route'
  | 'gen.route_fallback';
export interface Decide1Trace extends Omit<Decide1Inputs, 'shadow'> {
  readonly table: typeof DECIDE1_RULE_TABLE;
  readonly rule: Decide1RuleId;
  readonly band: Band;
}
interface Decide1Rule {
  readonly id: Decide1RuleId;
  readonly when: (facts: ReadonlyMap<string, Decide1Fact['value']>, judgments: ReadonlyMap<string, number>) => boolean;
  readonly band: Band | 'withheld';
}
const STAGES = ['intake', 'triage', 'route'] as const;
const THREADS = ['continue_thread', 'steer', 'queue', 'interrupt'];
const TIERS = ['flash', 'standard', 'strong'];
const admission = (reason: unknown) => reason === 'stale_answer' || reason === 'mismatched_answer';
const thread = (facts: ReadonlyMap<string, Decide1Fact['value']>) =>
  THREADS.includes(facts.get('intake.choice') as string);
type Facts = ReadonlyMap<string, Decide1Fact['value']>;
/** P5c1: root-specific rows require a root entry; child rows a child of the given sealed kind. */
const root = (f: Facts) => f.get('entry.kind') === 'root';
const child = (f: Facts, kind: 'read' | 'generate') => f.get('entry.kind') === 'child' && f.get('child.kind') === kind;
const joined = (f: Facts) => child(f, 'generate') && f.get('child.dependencies') === 'satisfied';
const routed = (f: Facts) => f.get('route.status') === 'transition' && TIERS.includes(f.get('route.choice') as string);
const CHILD_FACTS = [
  'child.kind',
  'child.parent',
  'child.plan',
  'child.dependencies',
  'child.read_bytes',
  'child.share',
  'child.boundary',
];
/** Facts a child never records: it has no intake, triage, roles or plan of its own. */
const ROOT_FACTS = [
  'intake.decided_by',
  'intake.choice',
  'intake.status',
  'intake.reason',
  'thread_target',
  'triage.choice',
  'triage.status',
  'triage.reason',
  'triage.accepted',
  'preflight.reason',
  'preflight.admitted',
  'spawn.gain',
  'spawn.children',
  'spawn.plan',
];

/** Ordered first-match policy. Later slices add inputs and rows here, never a second dispatch path. */
export const DECIDE1_RULES: readonly Decide1Rule[] = Object.freeze(
  (
    [
      {
        // A child's gate code fact (P5c1) extends the stage predicate; it is null on every root.
        id: 'hold.admission',
        when: (f) =>
          STAGES.some((stage) => admission(f.get(`${stage}.reason`))) || f.get('child.boundary') === 'stale_answer',
        band: 'withheld',
      },
      {
        id: 'hold.outage',
        when: (f) => STAGES.some((stage) => f.get(`${stage}.reason`) === 'decision_unavailable'),
        band: 'withheld',
      },
      {
        id: 'hold.paused',
        when: (f) =>
          STAGES.some((stage) => f.get(`${stage}.status`) === 'paused') || f.get('child.boundary') === 'cancelled',
        band: 'withheld',
      },
      {
        id: 'hold.dependency_pending',
        when: (f) => child(f, 'generate') && f.get('child.dependencies') === 'pending',
        band: 'withheld',
      },
      {
        id: 'hold.unmet_dependency',
        when: (f) => child(f, 'generate') && f.get('child.dependencies') === 'unmet',
        band: 'withheld',
      },
      { id: 'act.read', when: (f) => child(f, 'read'), band: 'tool_call' },
      {
        id: 'gen.child',
        when: (f) => joined(f) && routed(f) && f.get('route.accepted') === true,
        band: 'escalate_gen',
      },
      {
        id: 'gen.child_fallback',
        when: (f) => joined(f) && routed(f) && f.get('route.accepted') === false,
        band: 'escalate_gen',
      },
      { id: 'ask.intake', when: (f) => root(f) && f.get('intake.status') === 'needs_human', band: 'ask_human' },
      { id: 'ask.irreversible', when: (f) => root(f) && f.get('intake.choice') === 'stop', band: 'ask_human' },
      {
        id: 'ask.thread_target',
        when: (f) =>
          root(f) && thread(f) && ['no_target', 'ambiguous_reference'].includes(f.get('thread_target') as string),
        band: 'ask_human',
      },
      {
        id: 'act.thread',
        when: (f) => root(f) && thread(f) && f.get('thread_target') === 'resolved',
        band: 'tool_call',
      },
      { id: 'ask.triage', when: (f) => root(f) && f.get('triage.status') === 'needs_human', band: 'ask_human' },
      {
        id: 'act.capability',
        when: (f) => root(f) && f.get('triage.accepted') === true && f.get('triage.choice') === 'capability',
        band: 'tool_call',
      },
      {
        id: 'act.done_check',
        when: (f) => root(f) && f.get('triage.accepted') === true && f.get('triage.choice') === 'done_check',
        band: 'tool_call',
      },
      {
        id: 'act.decline',
        when: (f) => root(f) && f.get('triage.accepted') === true && f.get('triage.choice') === 'out_of_scope',
        band: 'tool_call',
      },
      {
        id: 'gen.triage_fallback',
        when: (f) =>
          root(f) &&
          f.get('triage.status') === 'transition' &&
          f.get('triage.accepted') === false &&
          f.get('triage.choice') === 'implement',
        band: 'escalate_gen',
      },
      {
        // D2 accepted a tier, every target cleared role admission, and a validated plan has split gain.
        id: 'spawn.preflight',
        when: (f) =>
          root(f) &&
          f.get('route.status') === 'transition' &&
          f.get('route.accepted') === true &&
          TIERS.includes(f.get('route.choice') as string) &&
          f.get('preflight.admitted') === true &&
          f.get('spawn.gain') === true &&
          id(f.get('spawn.plan')) &&
          f.get('spawn.port') === true,
        band: 'spawn_subtasks',
      },
      {
        id: 'gen.route',
        when: (f) =>
          root(f) &&
          f.get('route.status') === 'transition' &&
          f.get('route.accepted') === true &&
          TIERS.includes(f.get('route.choice') as string),
        band: 'escalate_gen',
      },
      { id: 'ask.route', when: (f) => f.get('route.status') === 'needs_human', band: 'ask_human' },
      {
        id: 'gen.route_fallback',
        when: (f) =>
          root(f) &&
          f.get('route.status') === 'transition' &&
          f.get('route.choice') !== null &&
          f.get('route.choice') !== undefined &&
          f.get('route.accepted') === false,
        band: 'escalate_gen',
      },
    ] satisfies Decide1Rule[]
  ).map((row) => Object.freeze(row)),
);

/** Same bounded-id screen as correlation(), kept local so policy imports no judgment site. */
function id(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
    !/^(sk[-_]|Bearer\s+|eyJ|gh[pousr]_|github_pat_|AKIA)/i.test(value)
  );
}
const code = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_.@:-]{0,63}$/.test(value);
function names(items: readonly { readonly name: string }[]): void {
  if (
    !Array.isArray(items) ||
    items.length > 64 ||
    items.some((item) => item === null || typeof item !== 'object' || !code(item.name)) ||
    new Set(items.map((item) => item.name)).size !== items.length
  )
    throw new Error('decide1: invalid names');
}

/** A pause reports the band of the choice it withheld; status still says no action happened. */
export function bandOfChoice(stage: string, choice: unknown): Band {
  if (stage === 'intake') {
    if (choice === 'ask_user' || choice === 'stop') return 'ask_human';
    if (THREADS.includes(choice as string)) return 'tool_call';
    // Reuse can go stale between accepted intake and the dependent D1 ask (merged P3a).
    if (choice === 'new_thread') return 'escalate_gen';
  }
  if (stage === 'triage') {
    if (['capability', 'done_check', 'out_of_scope'].includes(choice as string)) return 'tool_call';
    if (choice === 'needs_human') return 'ask_human';
    if (choice === 'implement') return 'escalate_gen';
  }
  if (stage === 'route' && TIERS.includes(choice as string)) return 'escalate_gen';
  throw new Error('decide1: no band for choice');
}

/** A child records no intake, triage or roles; only a satisfied generator records D2 (P5c1). */
function childSet(facts: Facts): boolean {
  if (ROOT_FACTS.some((name) => facts.get(name) != null) || facts.get('intake.accepted') === true) return false;
  if (!id(facts.get('child.parent')) || !id(facts.get('child.plan'))) return false;
  const boundary = facts.get('child.boundary');
  if (boundary != null && boundary !== 'stale_answer' && boundary !== 'cancelled') return false;
  const dependencies = facts.get('child.dependencies');
  const route = facts.get('route.choice');
  const recorded = route != null || facts.get('route.status') != null;
  switch (facts.get('child.kind')) {
    case 'read':
      return dependencies === 'satisfied' && !recorded;
    case 'generate':
      if (!['pending', 'satisfied', 'unmet'].includes(dependencies as string)) return false;
      return !recorded || (dependencies === 'satisfied' && TIERS.includes(route as string));
    default:
      return false;
  }
}

/** Impossible stage sets are code defects, not operator ambiguity. */
function stageSet(facts: ReadonlyMap<string, Decide1Fact['value']>): boolean {
  const entry = facts.get('entry.kind');
  if (entry === 'child') return childSet(facts);
  if (entry !== 'root' || CHILD_FACTS.some((name) => facts.get(name) != null)) return false;
  const intake = facts.get('intake.choice');
  const triage = facts.get('triage.choice');
  const route = facts.get('route.choice');
  if (!['new_thread', 'ask_user', 'stop', ...THREADS].includes(intake as string)) return false;
  if (triage != null) {
    if (intake !== 'new_thread' || facts.get('intake.status') !== 'transition') return false;
    if (!['capability', 'done_check', 'out_of_scope', 'needs_human', 'implement'].includes(triage as string))
      return false;
    if (facts.get('triage.accepted') === false && triage !== 'implement') return false;
  }
  if (
    route != null &&
    (triage !== 'implement' ||
      facts.get('triage.status') !== 'transition' ||
      facts.get('triage.accepted') !== true ||
      !TIERS.includes(route as string))
  )
    return false;
  return true;
}

export function decideBand(inputs: Decide1Inputs): Decide1Trace {
  const traceJudgments = [...inputs.judgments, ...(inputs.shadow?.judgments ?? [])];
  const traceFacts = [...inputs.facts, ...(inputs.shadow?.facts ?? [])];
  names(traceJudgments);
  names(traceFacts);
  for (const judgment of traceJudgments)
    if (
      typeof judgment.probability !== 'number' ||
      !Number.isFinite(judgment.probability) ||
      judgment.probability < 0 ||
      judgment.probability > 1
    )
      throw new Error('decide1: invalid probability');
  for (const fact of traceFacts) {
    const value = fact.value;
    if (
      !(
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        id(value)
      )
    )
      throw new Error('decide1: invalid fact');
  }
  const facts = new Map(inputs.facts.map((fact) => [fact.name, fact.value]));
  const judgments = new Map(inputs.judgments.map((judgment) => [judgment.name, judgment.probability]));
  if (!stageSet(facts)) throw new Error('decide1: no rule matched');
  const row = DECIDE1_RULES.find((rule) => rule.when(facts, judgments));
  if (row === undefined) throw new Error('decide1: no rule matched');
  let band: Band;
  if (row.band === 'withheld') {
    const stage = STAGES.find((stage) =>
      row.id === 'hold.admission'
        ? admission(facts.get(`${stage}.reason`))
        : row.id === 'hold.outage'
          ? facts.get(`${stage}.reason`) === 'decision_unavailable'
          : row.id === 'hold.paused' && facts.get(`${stage}.status`) === 'paused',
    );
    if (stage !== undefined) band = bandOfChoice(stage, facts.get(`${stage}.choice`));
    // A child gate or dependency hold withholds its sealed kind's action.
    else if (child(facts, 'read')) band = 'tool_call';
    else if (child(facts, 'generate')) band = 'escalate_gen';
    else throw new Error('decide1: no withheld stage');
  } else band = row.band;
  return {
    table: DECIDE1_RULE_TABLE,
    judgments: traceJudgments.map(({ name, probability }) => ({ name, probability })),
    facts: traceFacts.map(({ name, value }) => ({ name, value })),
    rule: row.id,
    band,
  };
}
