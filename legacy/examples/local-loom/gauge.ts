/** Local observations become bound Gauge records; no model-quality verdict or inferred root cause. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluate,
  evaluateInfo,
  recordDigest,
  validate,
  type CaseSet,
  type Context,
  type CriteriaSet,
  type InfoCriteriaSet,
  type Revision,
  type FailureAttribution,
} from '@weave/gauge';
import type { LocalTaskResult } from '@weave/weave';

export interface RunEvidence {
  readonly id: string;
  readonly input: string;
  readonly operator_input?: string;
  readonly started_at: string;
  readonly status: 'settled';
  readonly parent_run?: string;
  readonly events: readonly {
    sequence: number;
    task_id: string;
    parent: string | null;
    stage: string;
    detail: unknown;
  }[];
  readonly result: LocalTaskResult;
  readonly stats: { calls: number; spent: number; reserved: number };
}
export interface GaugeSummary {
  readonly key: string;
  readonly verdict: string;
  readonly gaps: readonly string[];
}
const governor = { kind: 'policy', ref: 'local.operator-feedback' } as const;
const workload = 'loom.local.workspace';
const checks = ['question_when_needed', 'uncertainty_blocks_dispatch', 'question_is_not_completion'] as const;
const quality: CriteriaSet = {
  schema: 'gauge.criteria@1',
  criteria: 'loom.local.feedback@1',
  workload,
  governed_by: governor,
  method: { interval: 'bootstrap@1', level: 0.95, seed: 1, min_samples: 1 },
  measures: checks.map((measure) => ({
    measure,
    source: { evidence: 'check' },
    aggregate: 'mean',
    better: 'higher',
    min_effect: 0,
  })),
  constraints: checks.map((measure) => ({ constraint: measure, measure, op: 'ge', bound: 1, role: 'protected' })),
};
const info: InfoCriteriaSet = {
  schema: 'gauge.criteria@2',
  criteria: 'loom.local.diagnostics@1',
  workload,
  governed_by: governor,
  measures: [
    ...[
      'decision_rejections',
      'clarification_attempts',
      'clarification_present',
      'capability_no_match',
      'inference_calls',
      'accounted_micros',
    ].map((measure) => ({ measure, source: { evidence: 'check' } as const, aggregate: 'sum' as const, empty: 0 })),
    { measure: 'intent_character_coverage', source: { evidence: 'check' }, aggregate: 'mean', empty: null },
    { measure: 'extraction_completeness', source: { evidence: 'check' }, aggregate: 'mean', empty: null },
  ],
};
const detail = (event: RunEvidence['events'][number]): Record<string, unknown> =>
  event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
    ? (event.detail as Record<string, unknown>)
    : {};
function revision(set: CriteriaSet | InfoCriteriaSet | CaseSet): Revision {
  const cases = set.schema === 'gauge.caseset@1';
  return {
    schema: 'gauge.revision@1',
    revision: cases ? set.caseset : set.criteria,
    record: cases ? 'caseset' : 'criteria',
    digest: recordDigest(set),
    supersedes: null,
    issued_by: governor,
    justification: 'local_operator_feedback',
    evidence: [],
  };
}

export function evaluateLocalRun(run: RunEvidence) {
  const key = recordDigest(run).slice(7);
  const caseId = `case-${recordDigest({ input: run.input, started_at: run.started_at, id: run.id }).slice(7)}`;
  const caseset: CaseSet = {
    schema: 'gauge.caseset@1',
    caseset: `${caseId}@1`,
    workload,
    governed_by: governor,
    splits: [
      { split: 'tune', digest: recordDigest({ input: run.input, started_at: run.started_at, id: run.id }), size: 1 },
    ],
  };
  const revisions = [revision(quality), revision(info), revision(caseset)];
  let context: Context = {
    criteria: { [quality.criteria]: quality, [info.criteria]: info },
    casesets: { [caseset.caseset]: caseset },
    revisions: Object.fromEntries(revisions.map((r) => [r.revision, r])),
    results: {},
  };
  const rejected = run.events.filter((event) => detail(event).admitted === false);
  const firstRejection = rejected[0]?.sequence;
  const question = run.result.question?.trim() || null;
  const samples = {
    question_when_needed: [run.result.status === 'needs_human' && !question ? 0 : 1],
    uncertainty_blocks_dispatch: [
      firstRejection === undefined ||
      !run.events.some((event) => event.stage === 'act' && event.sequence > firstRejection)
        ? 1
        : 0,
    ],
    question_is_not_completion: [question && run.result.status !== 'needs_human' ? 0 : 1],
  };
  const checkRecords = checks.map((code) => ({
    code,
    passed: samples[code][0] === 1,
    ref: `check-${recordDigest({ key, code, sample: samples[code] }).slice(7)}`,
  }));
  const evidence = checkRecords.map((check) => ({ source: 'check' as const, ref: check.ref }));
  const common = {
    subject: { kind: 'operating_strategy' as const, ref: 'loom.local.operator-loop' },
    workload,
    caseset: caseset.caseset,
    split: 'tune' as const,
    mode: 'live' as const,
    evidence,
  };
  const produced = evaluate({ ...common, result: `quality-${key}`, criteria: quality.criteria, samples }, context);
  if (!produced.ok) throw new Error(`Gauge feedback rejected: ${produced.reason}`);
  const inputs = new Map(
    run.events.filter((event) => event.stage === 'input').map((event) => [event.task_id, detail(event).input]),
  );
  const coverage = run.events
    .filter((event) => event.stage === 'extract')
    .flatMap((event) => {
      const original = inputs.get(event.task_id);
      const intent = detail(event).intent;
      return typeof original === 'string' && original.length && typeof intent === 'string'
        ? [intent.length / original.length]
        : [];
    });
  const diagnostics = evaluateInfo(
    {
      ...common,
      result: `diagnostics-${key}`,
      criteria: info.criteria,
      samples: {
        decision_rejections: [rejected.length],
        clarification_attempts: [
          run.events.filter((event) => event.stage === 'clarify' && detail(event).status === 'started').length,
        ],
        clarification_present: [question ? 1 : 0],
        capability_no_match: [
          run.events.filter(
            (event) =>
              detail(event).site === 'local.capability' &&
              detail(event).choice === 'unavailable' &&
              detail(event).admitted === true,
          ).length,
        ],
        inference_calls: [run.stats.calls],
        accounted_micros: [run.stats.spent],
        intent_character_coverage: coverage,
        // A source span is not an oracle for semantic completeness. It remains unassessed.
        extraction_completeness: [],
      },
    },
    context,
  );
  if (!diagnostics.ok) throw new Error(`Gauge diagnostics rejected: ${diagnostics.reason}`);
  context = {
    ...context,
    results: { [produced.record.result]: produced.record, [diagnostics.record.result]: diagnostics.record },
  };
  const attributions: FailureAttribution[] =
    produced.record.verdict === 'misses_bar'
      ? [
          {
            schema: 'gauge.attribution@1',
            attribution: `attribution-${key}`,
            result: produced.record.result,
            case: caseId,
            category: 'unattributed',
            basis: 'none',
            signal: null,
            confidence: null,
            evidence,
          },
        ]
      : [];
  const records = [quality, info, caseset, ...revisions, produced.record, diagnostics.record, ...attributions];
  for (const record of records) {
    const verdict = validate(record, context);
    if (!verdict.ok) throw new Error(`Gauge record invalid: ${verdict.reason}`);
  }
  const gaps = [
    ...(rejected.length ? ['decision_uncertain'] : []),
    ...(run.result.status === 'needs_human' && !question ? ['clarification_missing'] : []),
    ...(coverage.length ? ['extraction_completeness_unassessed'] : []),
    ...(run.events.some((event) => detail(event).choice === 'unavailable' && detail(event).admitted === true)
      ? ['capability_no_match']
      : []),
    ...(run.events.some((event) => event.stage === 'clarify' && detail(event).status === 'failed')
      ? ['clarification_failed']
      : []),
    ...(run.result.status === 'failed' ? ['run_failed'] : []),
    ...(run.result.status === 'budget_exhausted' ? ['budget_exhausted'] : []),
  ];
  return {
    key,
    run,
    checks: checkRecords,
    records,
    context,
    summary: { key, verdict: produced.record.verdict, gaps } satisfies GaugeSummary,
  };
}

export class LocalGaugeStore {
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  save(run: RunEvidence): GaugeSummary {
    const archive = evaluateLocalRun(run);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, archive.key + '.json');
    const text = JSON.stringify(archive, null, 2) + '\n';
    if (existsSync(file)) {
      if (readFileSync(file, 'utf8') !== text) throw new Error('Immutable Gauge archive conflict.');
    } else writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
    const temporary = join(this.directory, 'latest.tmp');
    writeFileSync(temporary, JSON.stringify({ key: archive.key }) + '\n', { mode: 0o600 });
    renameSync(temporary, join(this.directory, 'latest.json'));
    return archive.summary;
  }
  latest(): { run: RunEvidence; summary: GaugeSummary } | null {
    const pointer = join(this.directory, 'latest.json');
    if (!existsSync(pointer)) return null;
    const index = JSON.parse(readFileSync(pointer, 'utf8')) as { key?: unknown };
    if (typeof index.key !== 'string' || !/^[a-f0-9]{64}$/.test(index.key))
      throw new Error('Invalid Gauge archive pointer.');
    const archive = this.read(index.key);
    if (archive.key !== index.key || recordDigest(archive.run).slice(7) !== index.key)
      throw new Error('Gauge archive digest mismatch.');
    return { run: archive.run, summary: archive.summary };
  }
  read(key: string): ReturnType<typeof evaluateLocalRun> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid Gauge archive key.');
    const archive = JSON.parse(readFileSync(join(this.directory, key + '.json'), 'utf8')) as ReturnType<
      typeof evaluateLocalRun
    >;
    if (archive.key !== key || recordDigest(archive.run).slice(7) !== key || archive.summary.key !== key)
      throw new Error('Gauge archive digest mismatch.');
    // Validate against the archived revisions, never today's evaluation policy.
    for (const record of archive.records)
      if (!validate(record, archive.context).ok) throw new Error('Invalid archived Gauge record.');
    return archive;
  }
  resetDisplay(): void {
    rmSync(join(this.directory, 'latest.json'), { force: true });
  }
}
