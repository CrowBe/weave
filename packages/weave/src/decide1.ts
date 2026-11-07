/** Decide-1 is deterministic policy over bounded observations, never execution authority. */
export const DECIDE1_BANDS = Object.freeze(['tool_call', 'spawn_subtasks', 'escalate_gen', 'ask_human'] as const);
export type Band = (typeof DECIDE1_BANDS)[number];
export const DECIDE1_RULE_TABLE = 'decide1.rules@1' as const;
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
}
export type Decide1RuleId =
  | 'hold.admission'
  | 'hold.outage'
  | 'hold.paused'
  | 'ask.intake'
  | 'ask.irreversible'
  | 'ask.thread_target'
  | 'act.thread'
  | 'ask.triage'
  | 'act.capability'
  | 'act.done_check'
  | 'act.decline'
  | 'gen.triage_fallback'
  | 'gen.route'
  | 'gen.route_fallback';
export interface Decide1Trace extends Decide1Inputs {
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

/** Ordered first-match policy. Later slices add inputs and rows here, never a second dispatch path. */
export const DECIDE1_RULES: readonly Decide1Rule[] = Object.freeze(
  (
    [
      {
        id: 'hold.admission',
        when: (f) => STAGES.some((stage) => admission(f.get(`${stage}.reason`))),
        band: 'withheld',
      },
      {
        id: 'hold.outage',
        when: (f) => STAGES.some((stage) => f.get(`${stage}.reason`) === 'decision_unavailable'),
        band: 'withheld',
      },
      {
        id: 'hold.paused',
        when: (f) => STAGES.some((stage) => f.get(`${stage}.status`) === 'paused'),
        band: 'withheld',
      },
      { id: 'ask.intake', when: (f) => f.get('intake.status') === 'needs_human', band: 'ask_human' },
      { id: 'ask.irreversible', when: (f) => f.get('intake.choice') === 'stop', band: 'ask_human' },
      {
        id: 'ask.thread_target',
        when: (f) => thread(f) && ['no_target', 'ambiguous_reference'].includes(f.get('thread_target') as string),
        band: 'ask_human',
      },
      { id: 'act.thread', when: (f) => thread(f) && f.get('thread_target') === 'resolved', band: 'tool_call' },
      { id: 'ask.triage', when: (f) => f.get('triage.status') === 'needs_human', band: 'ask_human' },
      {
        id: 'act.capability',
        when: (f) => f.get('triage.accepted') === true && f.get('triage.choice') === 'capability',
        band: 'tool_call',
      },
      {
        id: 'act.done_check',
        when: (f) => f.get('triage.accepted') === true && f.get('triage.choice') === 'done_check',
        band: 'tool_call',
      },
      {
        id: 'act.decline',
        when: (f) => f.get('triage.accepted') === true && f.get('triage.choice') === 'out_of_scope',
        band: 'tool_call',
      },
      {
        id: 'gen.triage_fallback',
        when: (f) => f.get('triage.accepted') === false && f.get('triage.choice') === 'implement',
        band: 'escalate_gen',
      },
      {
        id: 'gen.route',
        when: (f) => f.get('route.accepted') === true && TIERS.includes(f.get('route.choice') as string),
        band: 'escalate_gen',
      },
      {
        id: 'gen.route_fallback',
        when: (f) =>
          f.get('route.choice') !== null && f.get('route.choice') !== undefined && f.get('route.accepted') === false,
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

/** Impossible stage sets are code defects, not operator ambiguity. */
function stageSet(facts: ReadonlyMap<string, Decide1Fact['value']>): boolean {
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
  names(inputs.judgments);
  names(inputs.facts);
  for (const judgment of inputs.judgments)
    if (
      typeof judgment.probability !== 'number' ||
      !Number.isFinite(judgment.probability) ||
      judgment.probability < 0 ||
      judgment.probability > 1
    )
      throw new Error('decide1: invalid probability');
  for (const fact of inputs.facts) {
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
          : facts.get(`${stage}.status`) === 'paused',
    );
    if (stage === undefined) throw new Error('decide1: no withheld stage');
    band = bandOfChoice(stage, facts.get(`${stage}.choice`));
  } else band = row.band;
  return {
    table: DECIDE1_RULE_TABLE,
    judgments: inputs.judgments.map(({ name, probability }) => ({ name, probability })),
    facts: inputs.facts.map(({ name, value }) => ({ name, value })),
    rule: row.id,
    band,
  };
}
