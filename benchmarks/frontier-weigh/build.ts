/**
 * Build each `frontier.weigh@1` case from recorded observations, the way Loom
 * would: fold the log into state, form candidates with the established
 * procedure, keep the eligible ones and render the weighing view. Nothing here
 * reads the environment or a clock.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CapabilityContract } from '@weave/agentsop';
import {
  candidateId,
  candidateSetDigest,
  foldState,
  formCandidates,
  renderWeighView,
  type Candidate,
  type Goal,
  type Observation,
  type State,
  type StateView,
} from '@weave/weave';

export const CASES_URL = new URL('./cases.json', import.meta.url);

export type Split = 'tune' | 'holdout';
export type CaseKind = 'gather' | 'act' | 'hold';

export interface CaseSpec {
  readonly goal_sources: readonly string[];
  readonly readable: readonly string[];
  readonly review: boolean;
  /** Sources the accepted framing proposal binds; null before framing. */
  readonly proposal: readonly string[] | null;
  /** Inspected at revision 1. */
  readonly inspected: readonly string[];
  readonly assembled: boolean;
  /** Changed to revision 2 after inspection and assembly. */
  readonly changed: readonly string[];
  /** Inspections started and not finished. */
  readonly running: readonly string[];
  readonly actions_remaining: number;
}

export interface CaseLabel {
  /** Candidate keys of the adjudicated frontier. Empty means stay blocked. */
  readonly preferred: readonly string[];
  /** Eligible or pending keys on the path to the success evidence. */
  readonly critical: readonly string[];
  /** Actions still needed to produce the success evidence and complete. */
  readonly needed: number;
  readonly kind: CaseKind;
  readonly rule: string;
  readonly rationale: string;
}

export interface FrontierCase {
  readonly id: string;
  readonly split: Split;
  readonly family: string;
  readonly spec: CaseSpec;
  readonly label: CaseLabel;
}

export interface CaseSet {
  readonly caseset: string;
  readonly rubric: string;
  readonly note: string;
  readonly cases: readonly FrontierCase[];
}

export interface BuiltCase {
  readonly case: FrontierCase;
  readonly state: State;
  readonly formed: readonly Candidate[];
  readonly eligible: readonly Candidate[];
  readonly view: StateView;
  readonly candidate_set: string;
  /** Candidate id to case key. */
  readonly keys: ReadonlyMap<string, string>;
}

export function loadCaseSet(): { readonly set: CaseSet; readonly digest: string } {
  const bytes = readFileSync(CASES_URL);
  return {
    set: JSON.parse(bytes.toString('utf8')) as CaseSet,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

const INSPECT: CapabilityContract = {
  id: 'source.inspect',
  revision: 'r1',
  purpose: 'Inspect one text source and report its revision, line count, and digest',
  input: { source: 'ResourceId' },
  output: { source: 'ResourceId', revision: 'integer', line_count: 'integer', digest: 'string' },
  effects: [{ input: 'source', mode: 'read' }],
  permissions: [{ input: 'source', mode: 'read' }],
  failures: ['not_found', 'access_denied'],
  depends_on: [],
};

const ASSEMBLE: CapabilityContract = {
  id: 'report.assemble',
  revision: 'r1',
  purpose: 'Assemble inspection results into a report that records the read set it was assembled under',
  input: { inspections: '[InspectionResult]' },
  output: { entries: '[InspectionResult]', read_set: '[{resource, revision}]' },
  effects: [],
  permissions: [],
  failures: ['empty_input'],
  depends_on: [],
};

export function describe(operation: string): CapabilityContract | null {
  return operation === INSPECT.id ? INSPECT : operation === ASSEMBLE.id ? ASSEMBLE : null;
}

export const REGISTERED = ['source:alpha', 'source:beta', 'source:gamma', 'source:delta', 'source:epsilon'] as const;

export function candidateKey(candidate: Candidate): string {
  return candidate.operation === 'source.inspect'
    ? `source.inspect:${(candidate.inputs as { source: string }).source}`
    : candidate.operation;
}

function inspection(source: string) {
  return { source, revision: 1, line_count: 2, digest: createHash('sha256').update(source).digest('hex').slice(0, 16) };
}

/** The observation log that leads to the case's state. */
export function caseObservations(spec: CaseSpec): Observation[] {
  const log: Observation[] = [];
  const push = (payload_type: string, payload: unknown, kind: Observation['source']['kind'] = 'host'): void => {
    const seq = log.length + 1;
    log.push({
      seq,
      observation_id: `case:${seq}:${payload_type}`,
      source: { kind, id: 'frontier-weigh-case' },
      caused_by: null,
      payload_type,
      payload_version: 1,
      payload,
      validation: { status: 'accepted' },
    });
  };
  let cycle = 0;
  const run = (operation: string, inputs: unknown, output: unknown | undefined): void => {
    cycle += 1;
    const action_id = `a:${cycle}:1`;
    const contract_rev = describe(operation)?.revision ?? null;
    const source = (inputs as { source?: string }).source;
    push(
      'action.started',
      {
        action_id,
        candidate_id: candidateId(operation, contract_rev, inputs),
        operation,
        contract_rev,
        inputs,
        read_set: source ? [{ resource: source, revision: 1 }] : [],
        effects: source ? [{ resource: source, mode: 'read' }] : [],
        reservation: { actions: 1, judgments: 0 },
        grant: null,
      },
      'runtime',
    );
    if (output !== undefined) {
      push('action.result', { action_id, outcome: { outcome: 'succeeded', output } }, operation === 'goal.frame' ? 'runtime' : 'host');
    }
  };

  for (const resource of REGISTERED) {
    push('source.registered', { resource, revision: 1, content: `${resource} line one\n${resource} line two` });
  }
  const started =
    (spec.proposal ? 1 : 0) + spec.inspected.length + (spec.assembled ? 1 : 0) + spec.running.length;
  const goal: Goal = {
    goal_id: 'g-report-variant',
    purpose: 'Produce a checked report over the listed sources',
    sources: [...spec.goal_sources],
    authority: { read: [...spec.readable] },
    framing: true,
    ...(spec.review ? { review: true } : {}),
    budget: { actions: spec.actions_remaining + started, judgments: 8, cost: 1_000_000 },
    success_evidence:
      'a Report artifact covering every goal source whose read set matches the current revision of each source',
  };
  push('goal.opened', goal, 'operator');
  if (spec.proposal) {
    run(
      'goal.frame',
      { goal_id: goal.goal_id },
      { bindings: spec.proposal.map((source) => ({ operation: 'source.inspect', inputs: { source } })), rejected: [] },
    );
  }
  for (const source of spec.inspected) {
    run('source.inspect', { source }, inspection(source));
  }
  if (spec.assembled) {
    const entries = spec.goal_sources.map(inspection);
    run('report.assemble', { inspections: entries }, {
      entries,
      read_set: spec.goal_sources.map((resource) => ({ resource, revision: 1 })),
    });
  }
  for (const resource of spec.changed) {
    push('source.changed', { resource, revision: 2, content: `${resource} revised` });
  }
  for (const source of spec.running) {
    run('source.inspect', { source }, undefined);
  }
  return log;
}

export function buildCase(frontierCase: FrontierCase): BuiltCase {
  const state = foldState(caseObservations(frontierCase.spec));
  const formation = formCandidates(state, describe);
  const formed = formation.candidates;
  const eligible = formed.filter((candidate) => candidate.eligibility.status === 'allowed');
  const keys = new Map(formed.map((candidate) => [candidate.candidate_id, candidateKey(candidate)]));
  return {
    case: frontierCase,
    state,
    formed,
    eligible,
    view: renderWeighView(state, eligible, formed),
    candidate_set: candidateSetDigest(eligible.map((candidate) => candidate.candidate_id)),
    keys,
  };
}
