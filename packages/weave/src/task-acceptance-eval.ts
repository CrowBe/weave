/**
 * Scoring for the frozen acceptance-fact set.
 *
 * The rule is `task-acceptance.score@1`, written down in
 * `benchmarks/task-acceptance/SCORING.md` before any result. Thresholds come
 * from `DECLARED_TASK_POLICY`. This module has no parameter that would let a
 * caller fit them on the holdout, and the offline path never receives a gateway.
 *
 * A disagreement with a hand label is a recorded outcome. It is not a failure
 * of the eval. A mismatch between the computed attribution and the attribution
 * stored on the frozen task means the set and the rule have drifted, and that
 * does fail.
 */
import type { InferenceGateway, InferenceTerms } from '@weave/gateway';
import {
  DECLARED_TASK_POLICY,
  ACCEPTANCE_LINE_CONTRACT,
  TASK_JEV_MODEL_ID,
  criteriaFromFixture,
  decideCriteria,
  decideValidation,
  judgeCriteria,
  judgeValidation,
  validationFromFixture,
  type AcceptanceLine,
  type CriteriaDecision,
  type NoulFixture,
  type ValidationDecision,
  type ValidationDisposition,
} from './task-acceptance.js';

export const SCORING_RULE = 'task-acceptance.score@1' as const;

export type Disagreement = 'criteria' | 'agent' | 'low_confidence_noul';

export interface FrozenTask {
  readonly id: string;
  readonly split: 'tune' | 'holdout';
  readonly task: string;
  readonly proposed_lines: readonly AcceptanceLine[];
  readonly label_single_facts: readonly string[];
  readonly label_done: boolean;
  readonly artifacts: readonly { readonly artifact_id: string; readonly body: string }[];
  readonly commands: readonly {
    readonly command_id: string;
    readonly argv: readonly string[];
    readonly output: string;
    readonly asked: boolean;
  }[];
  readonly write_up: string;
  readonly fixture_criteria: NoulFixture;
  readonly fixture_validation: NoulFixture;
  readonly label_disagreement: Disagreement | null;
  readonly agent_stop: 'done' | 'not_done' | null;
}

export interface TaskScore {
  readonly id: string;
  readonly split: 'tune' | 'holdout';
  readonly single_facts: boolean;
  readonly validation_agrees: boolean;
  readonly disagreement: Disagreement | null;
  readonly disposition: ValidationDisposition;
  readonly label_done: boolean;
  readonly agent_stop: 'done' | 'not_done' | null;
  readonly malformed: boolean;
}

export interface FrozenReport {
  readonly scoring_rule: typeof SCORING_RULE;
  readonly contract: typeof ACCEPTANCE_LINE_CONTRACT;
  readonly model: typeof TASK_JEV_MODEL_ID;
  readonly probability_threshold: typeof DECLARED_TASK_POLICY.probability_threshold;
  readonly confidence_floor: typeof DECLARED_TASK_POLICY.confidence_floor;
  readonly thresholds_source: 'declared_before_run';
  readonly holdout_used_for_tuning: false;
  readonly live_comparison: 'not_run';
  readonly counts: {
    readonly tasks: number;
    readonly tune: number;
    readonly holdout: number;
    readonly single_facts: number;
    readonly validation_agrees: number;
    readonly disagreements: number;
  };
  readonly tasks: readonly TaskScore[];
  readonly disagreements: readonly TaskScore[];
}

export interface AgentTranscript {
  readonly agent: string;
  readonly tasks: readonly {
    readonly id: string;
    readonly stop: 'done' | 'not_done';
    readonly write_up?: string;
  }[];
}

export interface LiveReport {
  readonly scoring_rule: typeof SCORING_RULE;
  readonly contract: typeof ACCEPTANCE_LINE_CONTRACT;
  readonly model: typeof TASK_JEV_MODEL_ID;
  readonly probability_threshold: typeof DECLARED_TASK_POLICY.probability_threshold;
  readonly confidence_floor: typeof DECLARED_TASK_POLICY.confidence_floor;
  readonly live_comparison: 'ran';
  readonly status: 'recorded';
  readonly tasks: readonly (TaskScore & { readonly agent_comparison: 'recorded' | 'skip' })[];
  readonly disagreements: readonly TaskScore[];
  readonly unknown_transcript_tasks: readonly string[];
}

export function planLiveComparison(input: {
  readonly transcript_provided: boolean;
  readonly jev_configured: boolean;
}): { readonly status: 'skip'; readonly reason: string } | { readonly status: 'run' } {
  if (!input.transcript_provided) return { status: 'skip', reason: 'agent transcript missing' };
  if (!input.jev_configured) return { status: 'skip', reason: 'jev route not configured' };
  return { status: 'run' };
}

export function loadFrozenSet(raw: unknown): readonly FrozenTask[] {
  if (!Array.isArray(raw)) throw new Error('frozen set must be an array');
  const tasks = raw.map((item, index) => parseTask(item, index));
  if (tasks.length < 20 || tasks.length > 30) {
    throw new Error(`frozen set must hold 20 to 30 tasks, found ${tasks.length}`);
  }
  const ids = new Set<string>();
  let tune = 0;
  let holdout = 0;
  const attributions = new Set<Disagreement>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate frozen task ${task.id}`);
    ids.add(task.id);
    if (task.split === 'tune') tune += 1;
    else holdout += 1;
    if (task.label_disagreement !== null) attributions.add(task.label_disagreement);
    const criteria = criteriaFromFixture(task.proposed_lines, task.fixture_criteria);
    const decision = decideCriteria(criteria);
    if (decision.malformed !== null) throw new Error(`${task.id} criteria fixture is malformed`);
    validationFromFixture(decision.entered, task.artifacts, task.commands, task.fixture_validation, task.write_up);
  }
  if (tune === 0 || holdout === 0 || holdout >= tune) {
    throw new Error('frozen set needs a smaller holdout split beside tune');
  }
  for (const kind of ['criteria', 'agent', 'low_confidence_noul'] as const) {
    if (!attributions.has(kind)) throw new Error(`frozen set is missing a ${kind} disagreement`);
  }
  return tasks;
}

export function loadTranscript(raw: unknown): AgentTranscript {
  if (!isRecord(raw) || typeof raw['agent'] !== 'string' || raw['agent'].trim().length === 0) {
    throw new Error('transcript requires an agent name');
  }
  if (!Array.isArray(raw['tasks'])) throw new Error('transcript requires tasks');
  const tasks: { id: string; stop: 'done' | 'not_done'; write_up?: string }[] = [];
  for (const item of raw['tasks']) {
    if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].trim().length === 0) {
      throw new Error('transcript task requires an id');
    }
    if (item['stop'] !== 'done' && item['stop'] !== 'not_done') {
      throw new Error(`transcript task ${item['id']} requires a stop of done or not_done`);
    }
    const write_up = item['write_up'];
    if (write_up === undefined) tasks.push({ id: item['id'], stop: item['stop'] });
    else if (typeof write_up === 'string') tasks.push({ id: item['id'], stop: item['stop'], write_up });
    else throw new Error(`transcript task ${item['id']} write_up must be a string`);
  }
  return { agent: raw['agent'], tasks };
}

export function scoreFrozenSet(tasks: readonly FrozenTask[]): FrozenReport {
  const scores = tasks.map((task) => {
    const score = scoreTask(task, offlineView(task), task.agent_stop);
    if (score.malformed) throw new Error(`${task.id} fixture resolved to a malformed judgment`);
    if (score.disagreement !== task.label_disagreement) {
      throw new Error(
        `${task.id} disagreement drifted: computed ${String(score.disagreement)} labeled ${String(task.label_disagreement)}`,
      );
    }
    return score;
  });
  return reportOf(scores);
}

export async function runLiveComparison(input: {
  readonly tasks: readonly FrozenTask[];
  readonly transcript: AgentTranscript;
  readonly gateway: InferenceGateway;
  readonly terms: InferenceTerms;
}): Promise<LiveReport> {
  const known = new Set(input.tasks.map((task) => task.id));
  const unknown = input.transcript.tasks.map((task) => task.id).filter((id) => !known.has(id));
  const scores: (TaskScore & { readonly agent_comparison: 'recorded' | 'skip' })[] = [];
  for (const task of input.tasks) {
    const fromAgent = input.transcript.tasks.find((item) => item.id === task.id);
    const criteria = await judgeCriteria(task.proposed_lines, {
      request_id: `${task.id}:criteria`,
      terms: input.terms,
      gateway: input.gateway,
      policy: DECLARED_TASK_POLICY,
    });
    const criteriaDecision = decideCriteria(criteria);
    const validationDecision = await liveValidation(task, criteriaDecision, input, fromAgent?.write_up);
    const view = viewOf(criteriaDecision, validationDecision);
    const score = scoreTask(task, view, fromAgent?.stop ?? null);
    scores.push({ ...score, agent_comparison: fromAgent === undefined ? 'skip' : 'recorded' });
  }
  return {
    scoring_rule: SCORING_RULE,
    contract: ACCEPTANCE_LINE_CONTRACT,
    model: TASK_JEV_MODEL_ID,
    probability_threshold: DECLARED_TASK_POLICY.probability_threshold,
    confidence_floor: DECLARED_TASK_POLICY.confidence_floor,
    live_comparison: 'ran',
    status: 'recorded',
    tasks: scores,
    disagreements: scores.filter((score) => score.disagreement !== null || score.malformed),
    unknown_transcript_tasks: unknown,
  };
}

async function liveValidation(
  task: FrozenTask,
  criteria: CriteriaDecision,
  input: { readonly gateway: InferenceGateway; readonly terms: InferenceTerms },
  writeUp: string | undefined,
): Promise<ValidationDecision> {
  if (criteria.malformed !== null) {
    return {
      done: false,
      disposition: 'malformed',
      reasons: [criteria.malformed],
      lines: [],
      hard_constraints: [],
      write_up_ignored: true,
    };
  }
  const record = await judgeValidation(
    criteria.entered,
    task.artifacts,
    task.commands,
    {
      request_id: `${task.id}:validate`,
      terms: input.terms,
      gateway: input.gateway,
      policy: DECLARED_TASK_POLICY,
    },
    writeUp,
  );
  return decideValidation(record);
}

function offlineView(task: FrozenTask): PipelineView {
  const criteria = decideCriteria(criteriaFromFixture(task.proposed_lines, task.fixture_criteria));
  if (criteria.malformed !== null) {
    return {
      entered: [],
      disposition: 'malformed',
      malformed: true,
      lowConfidence: false,
    };
  }
  const validation = decideValidation(
    validationFromFixture(criteria.entered, task.artifacts, task.commands, task.fixture_validation, task.write_up),
  );
  return viewOf(criteria, validation);
}

interface PipelineView {
  readonly entered: readonly string[];
  readonly disposition: ValidationDisposition;
  readonly malformed: boolean;
  readonly lowConfidence: boolean;
}

function viewOf(criteria: CriteriaDecision, validation: ValidationDecision): PipelineView {
  return {
    entered: criteria.entered.map((line) => line.line_id),
    disposition: criteria.malformed !== null ? 'malformed' : validation.disposition,
    malformed: criteria.malformed !== null || validation.disposition === 'malformed',
    lowConfidence:
      validation.disposition === 'escalate' ||
      criteria.lines.some((line) => line.status === 'revise' && line.reason === 'low_confidence'),
  };
}

function scoreTask(task: FrozenTask, view: PipelineView, agentStop: FrozenTask['agent_stop']): TaskScore {
  const single_facts = sameIds(view.entered, task.label_single_facts);
  const validation_agrees =
    !view.malformed &&
    (view.disposition === 'done'
      ? task.label_done
      : (view.disposition === 'fail' || view.disposition === 'escape') && !task.label_done);
  let disagreement: Disagreement | null = null;
  if (!view.malformed && !(single_facts && validation_agrees)) {
    if (view.lowConfidence) disagreement = 'low_confidence_noul';
    else if (!single_facts) disagreement = 'criteria';
    else disagreement = 'agent';
  }
  return {
    id: task.id,
    split: task.split,
    single_facts,
    validation_agrees,
    disagreement,
    disposition: view.disposition,
    label_done: task.label_done,
    agent_stop: agentStop,
    malformed: view.malformed,
  };
}

function reportOf(tasks: readonly TaskScore[]): FrozenReport {
  const disagreements = tasks.filter((task) => task.disagreement !== null);
  return {
    scoring_rule: SCORING_RULE,
    contract: ACCEPTANCE_LINE_CONTRACT,
    model: TASK_JEV_MODEL_ID,
    probability_threshold: DECLARED_TASK_POLICY.probability_threshold,
    confidence_floor: DECLARED_TASK_POLICY.confidence_floor,
    thresholds_source: 'declared_before_run',
    holdout_used_for_tuning: false,
    live_comparison: 'not_run',
    counts: {
      tasks: tasks.length,
      tune: tasks.filter((task) => task.split === 'tune').length,
      holdout: tasks.filter((task) => task.split === 'holdout').length,
      single_facts: tasks.filter((task) => task.single_facts).length,
      validation_agrees: tasks.filter((task) => task.validation_agrees).length,
      disagreements: disagreements.length,
    },
    tasks,
    disagreements,
  };
}

function parseTask(raw: unknown, index: number): FrozenTask {
  if (!isRecord(raw)) throw new Error(`frozen task ${index} is not an object`);
  const id = requiredString(raw['id'], `task ${index} id`);
  if (raw['split'] !== 'tune' && raw['split'] !== 'holdout') throw new Error(`${id} split must be tune or holdout`);
  const task = requiredString(raw['task'], `${id} task`);
  if (!Array.isArray(raw['proposed_lines']) || raw['proposed_lines'].length === 0) {
    throw new Error(`${id} needs proposed lines`);
  }
  const proposed_lines = raw['proposed_lines'].map((line) => parseLine(line, id));
  const lineIds = new Set(proposed_lines.map((line) => line.line_id));
  if (lineIds.size !== proposed_lines.length) throw new Error(`${id} repeats a line id`);
  const label_single_facts = stringList(raw['label_single_facts'], `${id} label_single_facts`);
  for (const lineId of label_single_facts) {
    if (!lineIds.has(lineId)) throw new Error(`${id} labels an unknown line ${lineId}`);
  }
  if (typeof raw['label_done'] !== 'boolean') throw new Error(`${id} label_done must be boolean`);
  const artifacts = parseArtifacts(raw['artifacts'], id);
  const commands = parseCommands(raw['commands'], id);
  const write_up = stringField(raw['write_up'], `${id} write_up`);
  const fixture_criteria = parseFixture(raw['fixture_criteria'], `${id} fixture_criteria`);
  const fixture_validation = parseFixture(raw['fixture_validation'], `${id} fixture_validation`);
  const label_disagreement = parseDisagreement(raw['label_disagreement'], id);
  const agent_stop = parseStop(raw['agent_stop'], id);
  return {
    id,
    split: raw['split'],
    task,
    proposed_lines,
    label_single_facts,
    label_done: raw['label_done'],
    artifacts,
    commands,
    write_up,
    fixture_criteria,
    fixture_validation,
    label_disagreement,
    agent_stop,
  };
}

function parseLine(raw: unknown, taskId: string): AcceptanceLine {
  if (!isRecord(raw)) throw new Error(`${taskId} has a line that is not an object`);
  const line_id = requiredString(raw['line_id'], `${taskId} line id`);
  const fact = requiredString(raw['fact'], `${taskId} ${line_id} fact`);
  const escape = requiredString(raw['escape'], `${taskId} ${line_id} escape`);
  const evidence = raw['evidence'];
  if (!isRecord(evidence)) throw new Error(`${taskId} ${line_id} needs evidence`);
  if (evidence['kind'] === 'artifact') {
    return {
      line_id,
      fact,
      escape,
      evidence: { kind: 'artifact', artifact_id: requiredString(evidence['artifact_id'], `${taskId} ${line_id} artifact`) },
    };
  }
  if (evidence['kind'] === 'command') {
    return {
      line_id,
      fact,
      escape,
      evidence: { kind: 'command', command_id: requiredString(evidence['command_id'], `${taskId} ${line_id} command`) },
    };
  }
  throw new Error(`${taskId} ${line_id} evidence kind is unknown`);
}

function parseArtifacts(raw: unknown, taskId: string): FrozenTask['artifacts'] {
  if (!Array.isArray(raw)) throw new Error(`${taskId} artifacts must be an array`);
  return raw.map((item) => {
    if (!isRecord(item)) throw new Error(`${taskId} artifact is not an object`);
    return {
      artifact_id: requiredString(item['artifact_id'], `${taskId} artifact id`),
      body: stringField(item['body'], `${taskId} artifact body`),
    };
  });
}

function parseCommands(raw: unknown, taskId: string): FrozenTask['commands'] {
  if (!Array.isArray(raw)) throw new Error(`${taskId} commands must be an array`);
  return raw.map((item) => {
    if (!isRecord(item) || !Array.isArray(item['argv']) || !item['argv'].every((part) => typeof part === 'string')) {
      throw new Error(`${taskId} command is not a record`);
    }
    if (typeof item['asked'] !== 'boolean') throw new Error(`${taskId} command asked must be boolean`);
    return {
      command_id: requiredString(item['command_id'], `${taskId} command id`),
      argv: item['argv'] as readonly string[],
      output: stringField(item['output'], `${taskId} command output`),
      asked: item['asked'],
    };
  });
}

function parseFixture(raw: unknown, label: string): NoulFixture {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`);
  const fixture: Record<string, { probability: number; confidence: number | null }> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) throw new Error(`${label} ${id} needs a probability`);
    const probability = value['probability'];
    const confidence = value['confidence'];
    if (typeof probability !== 'number' || !inUnit(probability)) throw new Error(`${label} ${id} needs a probability`);
    let recorded: number | null;
    if (confidence === null) recorded = null;
    else if (typeof confidence === 'number' && inUnit(confidence)) recorded = confidence;
    else throw new Error(`${label} ${id} confidence is not a unit interval or null`);
    fixture[id] = { probability, confidence: recorded };
  }
  return fixture;
}

function parseDisagreement(raw: unknown, taskId: string): Disagreement | null {
  if (raw === null) return null;
  if (raw === 'criteria' || raw === 'agent' || raw === 'low_confidence_noul') return raw;
  throw new Error(`${taskId} label_disagreement is unknown`);
}

function parseStop(raw: unknown, taskId: string): FrozenTask['agent_stop'] {
  if (raw === null) return null;
  if (raw === 'done' || raw === 'not_done') return raw;
  throw new Error(`${taskId} agent_stop is unknown`);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function stringList(raw: unknown, label: string): readonly string[] {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${label} must be a list of ids`);
  }
  return raw;
}

function requiredString(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return raw;
}

function stringField(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw new Error(`${label} must be a string`);
  return raw;
}

function inUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
