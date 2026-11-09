import { readTuneArtifact } from './reader.ts';
import { validate, recordDigest, type AttributionCategory, type Context } from '@weave/gauge';

type Row = Record<string, unknown>;
type Family = 'weft' | 'checks' | 'observations' | 'search' | 'route' | 'schedule';
export interface FrozenFacts {
  result: string;
  case: string;
  split: 'tune';
  bundle: Record<Family, Row[]>;
}
export interface TuneCase {
  id: string;
  split: 'tune';
  scenario_family: string;
  source_lineage: string;
  source_revision: string;
  source_digest: string;
  permissions: { content_class: 'non_sensitive'; uses: ['offline-development']; destinations: [] };
  observed_failure: string;
  receipts: { path: string; storedByteDigest: string };
  facts: { path: string; storedByteDigest: string };
  bundle_digest: string;
  annotation: 'characterization' | 'ambiguous-adversarial';
}
export interface TuneLabel {
  case: string;
  offline: { category: AttributionCategory; signal: string | null };
  judgment: Exclude<AttributionCategory, 'unattributed'> | null;
  acceptable_citations: { source: string; ref: string }[];
  rationale: string;
  author: string;
  reviewer: null;
  disagreement: 'unreviewed';
}
export interface Corpus {
  cases: TuneCase[];
  labels: TuneLabel[];
  facts: FrozenFacts[];
  review_status: 'implementer-authored-no-independent-review';
}
export interface LeafDecision {
  category: AttributionCategory;
  basis: 'deterministic' | 'judgment' | 'none';
  signal: string | null;
  confidence: number | null;
  evidence: { source: string; ref: string }[];
}
const families: Family[] = ['weft', 'checks', 'observations', 'search', 'route', 'schedule'];
const factKeys: Record<Family, readonly string[]> = {
  // A serialized fact family, not the `weft` port composition checked by W5-T43.
  ['weft']: ['source', 'ref', 'trace_id', 'record_id', 'kind', 'digest', 'parent_id', 'links', 'fields'],
  checks: [
    'source',
    'ref',
    'case',
    'contract_revision',
    'implementation_revision',
    'invocation',
    'check_revision',
    'attempt',
    'passed',
    'exit_code',
    'digest',
  ],
  observations: ['source', 'ref', 'observation', 'source_revision', 'case', 'digest', 'fields'],
  search: [
    'search',
    'revision',
    'catalogue_revision',
    'complete',
    'authorized',
    'matches',
    'compositions',
    'informed_by_inference',
    'revoked',
    'missing_grants',
    'evidence',
  ],
  route: [
    'decision',
    'policy_revision',
    'route_table_revision',
    'preference_revision',
    'selected',
    'candidates',
    'comparative_evidence',
    'evidence',
  ],
  schedule: [
    'scheduler_revision',
    'policy_revision',
    'disposition',
    'terminal',
    'dependencies',
    'budget',
    'superseded',
    'evidence',
  ],
};
function select(value: Row, fields: readonly string[]): Row {
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
function projectFact(family: Family, value: Row): Row {
  const selected = select(value, factKeys[family]);
  for (const key of ['evidence', 'comparative_evidence', 'links', 'candidates', 'dependencies']) {
    const keys =
      key === 'links'
        ? ['rel', 'record_id']
        : key === 'candidates'
          ? ['routed_unit', 'disposition', 'exclusion', 'terms_revision']
          : key === 'dependencies'
            ? ['result', 'status']
            : ['source', 'ref'];
    if (Object.hasOwn(selected, key)) selected[key] = array(selected[key]).map((item) => select(row(item), keys));
  }
  if (Object.hasOwn(selected, 'budget') && selected.budget !== null)
    selected.budget = select(row(selected.budget), ['line', 'limit', 'reserved', 'spent']);
  return JSON.parse(JSON.stringify(selected)) as Row;
}
// The raw corpus inventory contains these four Weft kinds. This is a local
// finite corpus check, not a substitute public Weft validator or host resolver.
function rawFields(kind: unknown, value: unknown): void {
  const f = row(value);
  const keys =
    kind === 'outcome'
      ? ['subject', 'subject_ref', 'status']
      : kind === 'action.transition'
        ? ['action_ref', 'operation', 'state']
        : kind === 'capability.invoked'
          ? ['contract_rev', 'implementation', 'status', 'invocation_ref']
          : kind === 'route.selected'
            ? ['request_ref', 'routed_unit', ...(Object.hasOwn(f, 'excluded') ? ['excluded'] : [])]
            : [];
  need(
    keys.length > 0 && Object.keys(f).length === keys.length && keys.every((key) => Object.hasOwn(f, key)),
    'weft-fields',
  );
  if (kind === 'outcome')
    need(
      ['goal', 'thread', 'action'].includes(f.subject as string) &&
        id(f.subject_ref) &&
        ['complete', 'missed', 'succeeded', 'failed', 'cancelled', 'uncertain'].includes(f.status as string),
      'weft-fields',
    );
  if (kind === 'action.transition')
    need(
      id(f.action_ref) &&
        id(f.operation) &&
        ['pending', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled'].includes(f.state as string),
      'weft-fields',
    );
  if (kind === 'capability.invoked')
    need(
      digest(f.contract_rev) &&
        id(f.implementation) &&
        id(f.invocation_ref) &&
        ['succeeded', 'failed', 'uncertain', 'cancelled'].includes(f.status as string),
      'weft-fields',
    );
  if (kind === 'route.selected') {
    need(id(f.request_ref) && id(f.routed_unit), 'weft-fields');
    if (Object.hasOwn(f, 'excluded'))
      for (const item of array(f.excluded)) {
        const e = exact(item, ['routed_unit', 'reason']);
        need(
          id(e.routed_unit) && typeof e.reason === 'string' && /^[a-z][a-z0-9_.@:-]{0,63}$/.test(e.reason),
          'weft-fields',
        );
      }
  }
}
const signals: Record<string, string[]> = {
  capability_gap: ['no_contract_matched'],
  implementation: ['contract_tests_failed', 'effect_violation', 'implementation_failed'],
  routing: ['better_route_excluded', 'wrong_contract_selected'],
  orchestration: ['dependency_failed', 'schedule_conflict', 'budget_exhausted', 'superseded'],
  unattributed: [],
};
const categories = Object.keys(signals);
const refusal = (code: string): never => {
  throw new Error(`g7:${code}`);
};
function row(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refusal('shape');
  return value as Row;
}
function exact(value: unknown, keys: readonly string[]): Row {
  const out = row(value);
  if (Object.keys(out).length !== keys.length || keys.some((k) => !Object.hasOwn(out, k))) return refusal('keys');
  return out;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 256) return refusal('array');
  return value;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function need(ok: unknown, code: string): asserts ok {
  if (!ok) refusal(code);
}
const equal = (a: unknown, b: unknown) => recordDigest(a) === recordDigest(b);
function ids(value: unknown): void {
  need(array(value).every(id), 'id');
}
function refs(value: unknown): { source: string; ref: string }[] {
  return array(value).map((item) => {
    const r = exact(item, ['source', 'ref']);
    need(
      ['weft_trace', 'check', 'observation', 'held_out_report'].includes(r.source as string) && id(r.ref),
      'citation-shape',
    );
    return { source: r.source as string, ref: r.ref };
  });
}
function decode(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return refusal('json');
  }
}
function nullableId(value: unknown): void {
  need(value === null || id(value), 'id');
}
function nullableDigest(value: unknown): void {
  need(value === null || digest(value), 'digest');
}

/** Shape and recorded bindings only; this function does not select a cause. */
function factsShape(value: unknown, descriptor: TuneCase, rawValue: unknown): FrozenFacts {
  const f = exact(value, ['result', 'case', 'split', 'bundle']);
  need(id(f.result) && f.case === descriptor.id && f.split === 'tune', 'fact-binding');
  const b = exact(f.bundle, families);
  const raw = exact(rawValue, [
    'schema',
    'case',
    'result',
    'records',
    'checks',
    'observations',
    'search',
    'route',
    'schedule',
  ]);
  need(raw.schema === 'gauge.raw-receipts@1' && raw.case === f.case && raw.result === f.result, 'raw-binding');
  const backing = array(raw.records).map((item) => exact(item, ['record', 'digest']));
  const bundle = Object.fromEntries(families.map((k) => [k, array(b[k]).map(row)])) as Record<Family, Row[]>;
  const citations: { source: string; ref: string }[] = [];
  for (const w of bundle.weft) {
    exact(w, ['source', 'ref', 'trace_id', 'record_id', 'kind', 'digest', 'parent_id', 'links', 'fields']);
    need(w.source === 'weft_trace' && id(w.ref) && id(w.trace_id) && id(w.record_id) && digest(w.digest), 'weft-shape');
    nullableId(w.parent_id);
    for (const l of array(w.links)) {
      const link = exact(l, ['rel', 'record_id']);
      need(
        ['caused_by', 'joins', 'supersedes', 'cancels', 'handoff', 'retry_of'].includes(link.rel as string) &&
          id(link.record_id),
        'link',
      );
    }
    row(w.fields);
    const matches = backing.filter((pair) => row(pair.record).record_id === w.record_id);
    need(matches.length === 1, 'weft-backing');
    const pair = matches[0]!;
    const rec = exact(pair.record, [
      'schema',
      'trace_id',
      'record_id',
      'emitter',
      'sequence',
      'kind',
      'thread_id',
      'parent_id',
      'links',
      'evidence',
      'fields',
    ]);
    rawFields(rec.kind, rec.fields);
    need(
      rec.schema === 'weft.record@1' &&
        count(rec.sequence) &&
        digest(pair.digest) &&
        recordDigest(rec) === pair.digest &&
        pair.digest === w.digest,
      'weft-digest',
    );
    const emitter = exact(rec.emitter, ['kind', 'id']);
    need(['loom', 'gateway', 'fabric', 'external'].includes(emitter.kind as string) && id(emitter.id), 'weft-emitter');
    nullableId(rec.thread_id);
    for (const r of array(rec.evidence)) {
      const e = exact(r, ['source', 'ref']);
      need(
        ['observation', 'inference_request', 'invocation', 'check', 'external'].includes(e.source as string) &&
          id(e.ref),
        'weft-evidence',
      );
    }
    need(
      [
        'goal.intent',
        'thread.transition',
        'cycle.weighed',
        'judgment',
        'dispatch.decided',
        'route.selected',
        'inference.attempt',
        'capability.invoked',
        'capability.lifecycle',
        'action.transition',
        'context.assembled',
        'budget',
        'outcome',
        'error',
      ].includes(w.kind as string),
      'weft-kind',
    );
    for (const k of ['trace_id', 'record_id', 'kind', 'parent_id', 'links', 'fields'])
      need(equal(rec[k], w[k]), 'weft-identity');
    citations.push({ source: 'weft_trace', ref: w.ref });
  }
  need(backing.length === bundle.weft.length, 'weft-backing');
  for (const c of bundle.checks) {
    exact(c, [
      'source',
      'ref',
      'case',
      'contract_revision',
      'implementation_revision',
      'invocation',
      'check_revision',
      'attempt',
      'passed',
      'exit_code',
      'digest',
    ]);
    need(c.source === 'check' && id(c.ref) && c.case === f.case && id(c.invocation) && id(c.attempt), 'check-binding');
    need([c.contract_revision, c.implementation_revision, c.check_revision, c.digest].every(digest), 'check-revision');
    need(typeof c.passed === 'boolean' && (c.exit_code === null || Number.isSafeInteger(c.exit_code)), 'check-shape');
    need(
      typeof c.attempt === 'string' &&
        c.attempt.startsWith(`${f.case}.`) &&
        /^a[0-9]+$/.test(c.attempt.slice((f.case as string).length + 1)),
      'check-attempt',
    );
    need(c.invocation === `${c.attempt}.invocation`, 'check-invocation');
    need(c.ref === `${c.attempt}.check.${(c.check_revision as string).slice(7, 15)}`, 'check-revision-binding');
    citations.push({ source: 'check', ref: c.ref });
  }
  for (const o of bundle.observations) {
    exact(o, ['source', 'ref', 'observation', 'source_revision', 'case', 'digest', 'fields']);
    need(
      o.source === 'observation' &&
        id(o.ref) &&
        ['search', 'route', 'policy', 'schedule', 'judgment'].includes(o.observation as string),
      'observation-shape',
    );
    need(
      digest(o.source_revision) && digest(o.digest) && (o.case === null || o.case === f.case),
      'observation-binding',
    );
    row(o.fields);
    citations.push({ source: 'observation', ref: o.ref });
  }
  for (const s of bundle.search) {
    exact(s, [
      'search',
      'revision',
      'catalogue_revision',
      'complete',
      'authorized',
      'matches',
      'compositions',
      'informed_by_inference',
      'revoked',
      'missing_grants',
      'evidence',
    ]);
    need(id(s.search) && digest(s.revision) && digest(s.catalogue_revision), 'search-revision');
    need(
      [s.complete, s.authorized, s.informed_by_inference].every((x) => typeof x === 'boolean'),
      'search-flags',
    );
    for (const k of ['matches', 'compositions', 'revoked', 'missing_grants']) ids(s[k]);
    refs(s.evidence);
  }
  for (const r of bundle.route) {
    exact(r, [
      'decision',
      'policy_revision',
      'route_table_revision',
      'preference_revision',
      'selected',
      'candidates',
      'comparative_evidence',
      'evidence',
    ]);
    need(
      id(r.decision) && id(r.selected) && digest(r.policy_revision) && digest(r.route_table_revision),
      'route-revision',
    );
    nullableDigest(r.preference_revision);
    const candidateIds = new Set<string>();
    for (const v of array(r.candidates)) {
      const c = exact(v, ['routed_unit', 'disposition', 'exclusion', 'terms_revision']);
      need(
        id(c.routed_unit) &&
          ['selected', 'eligible', 'excluded', 'unavailable', 'prohibited', 'approval_required'].includes(
            c.disposition as string,
          ),
        'candidate',
      );
      nullableId(c.exclusion);
      nullableDigest(c.terms_revision);
      need(!candidateIds.has(c.routed_unit), 'candidate-duplicate');
      candidateIds.add(c.routed_unit);
    }
    need(candidateIds.has(r.selected as string), 'selected');
    refs(r.comparative_evidence);
    refs(r.evidence);
  }
  for (const s of bundle.schedule) {
    exact(s, [
      'scheduler_revision',
      'policy_revision',
      'disposition',
      'terminal',
      'dependencies',
      'budget',
      'superseded',
      'evidence',
    ]);
    need(digest(s.scheduler_revision) && digest(s.policy_revision), 'schedule-revision');
    need(
      ['selected', 'dependency', 'conflict', 'stale_read_set', 'budget', 'not_reached', 'policy_filtered'].includes(
        s.disposition as string,
      ),
      'schedule-disposition',
    );
    need(
      s.terminal === null || ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(s.terminal as string),
      'terminal',
    );
    need(typeof s.superseded === 'boolean', 'superseded');
    for (const v of array(s.dependencies)) {
      const d = exact(v, ['result', 'status']);
      need(
        id(d.result) && ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(d.status as string),
        'dependency',
      );
    }
    if (s.budget !== null) {
      const budget = exact(s.budget, ['line', 'limit', 'reserved', 'spent']);
      need(
        ['actions', 'judgments', 'cost'].includes(budget.line as string) &&
          [budget.limit, budget.reserved, budget.spent].every(
            (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0,
          ),
        'budget',
      );
    }
    refs(s.evidence);
  }
  const seen = new Set<string>();
  for (const c of citations) {
    need(
      c.ref.startsWith(`${f.case}.`) && /^a[0-9]+\./.test(c.ref.slice((f.case as string).length + 1)),
      'citation-attempt',
    );
    const key = `${c.source}:${c.ref}`;
    need(!seen.has(key), 'citation-duplicate');
    seen.add(key);
  }
  for (const k of ['checks', 'observations', 'search', 'route', 'schedule'] as const)
    need(equal(raw[k], bundle[k]), 'raw-fact');
  for (const k of ['search', 'route', 'schedule'] as const)
    for (const v of bundle[k]) {
      for (const e of [...refs(v.evidence), ...(k === 'route' ? refs(v.comparative_evidence) : [])])
        need(seen.has(`${e.source}:${e.ref}`), 'fact-citation');
    }
  need(recordDigest(bundle) === descriptor.bundle_digest, 'bundle-digest');
  return { result: f.result as string, case: f.case as string, split: 'tune', bundle };
}

export function assertLineageDisjoint(tune: readonly unknown[], opposite: readonly unknown[]): void {
  for (const key of ['id', 'scenario_family', 'source_lineage']) {
    const first = new Set<unknown>();
    for (const value of tune) {
      const r = row(value);
      need(id(r[key]) && !first.has(r[key]), 'lineage');
      first.add(r[key]);
    }
    const second = new Set<unknown>();
    for (const value of opposite) {
      const r = row(value);
      need(id(r[key]) && !second.has(r[key]) && !first.has(r[key]), 'lineage');
      second.add(r[key]);
    }
  }
}

/** Pure validation for inert in-memory mutations; no input callback can open files. */
export function validateCorpus(
  descriptors: unknown,
  labelsValue: unknown,
  factValues: readonly unknown[],
  rawValues: readonly unknown[],
): Corpus {
  const cases = array(descriptors).map((value) => {
    const c = exact(value, [
      'id',
      'split',
      'scenario_family',
      'source_lineage',
      'source_revision',
      'source_digest',
      'permissions',
      'observed_failure',
      'receipts',
      'facts',
      'bundle_digest',
      'annotation',
    ]);
    need(id(c.id) && c.split === 'tune' && id(c.scenario_family) && id(c.source_lineage), 'descriptor');
    need(
      digest(c.source_revision) && digest(c.source_digest) && digest(c.bundle_digest) && text(c.observed_failure),
      'descriptor-digest',
    );
    need(['characterization', 'ambiguous-adversarial'].includes(c.annotation as string), 'annotation');
    const p = exact(c.permissions, ['content_class', 'uses', 'destinations']);
    need(
      p.content_class === 'non_sensitive' && equal(p.uses, ['offline-development']) && equal(p.destinations, []),
      'permissions',
    );
    for (const key of ['receipts', 'facts']) {
      const pin = exact(c[key], ['path', 'storedByteDigest']);
      need(
        pin.path === `benchmarks/failure-attribution/fixtures/${key}/${c.id}.json` && digest(pin.storedByteDigest),
        'artifact-pin',
      );
    }
    return c as unknown as TuneCase;
  });
  need(cases.length >= 28 && cases.filter((c) => c.annotation === 'ambiguous-adversarial').length >= 8, 'minimum');
  assertLineageDisjoint(cases, []);
  need(factValues.length === cases.length && rawValues.length === cases.length, 'fact-count');
  const facts = cases.map((c, i) => factsShape(factValues[i], c, rawValues[i]));
  const env = exact(labelsValue, ['schema', 'review_status', 'labels']);
  need(
    env.schema === 'gauge.tune-labels@1' && env.review_status === 'implementer-authored-no-independent-review',
    'review-status',
  );
  const labels = array(env.labels).map((value) => {
    const l = exact(value, [
      'case',
      'offline',
      'judgment',
      'acceptable_citations',
      'rationale',
      'author',
      'reviewer',
      'disagreement',
    ]);
    need(id(l.case) && cases.some((c) => c.id === l.case), 'label-binding');
    const offline = exact(l.offline, ['category', 'signal']);
    need(categories.includes(offline.category as string), 'category');
    need(
      offline.category === 'unattributed'
        ? offline.signal === null
        : signals[offline.category as string]!.includes(offline.signal as string),
      'signal',
    );
    need(
      l.judgment === null || (categories.includes(l.judgment as string) && l.judgment !== 'unattributed'),
      'judgment-category',
    );
    need(
      text(l.rationale) && text(l.author) && l.reviewer === null && l.disagreement === 'unreviewed',
      'review-status',
    );
    const evidence = refs(l.acceptable_citations);
    need(
      evidence.every((e) => e.ref.startsWith(`${l.case}.a1.`)),
      'oracle-attempt',
    );
    const f = facts.find((v) => v.case === l.case)!;
    const allowed = new Set(
      [...f.bundle.weft, ...f.bundle.checks, ...f.bundle.observations].map((v) => `${v.source}:${v.ref}`),
    );
    need(
      new Set(evidence.map((e) => `${e.source}:${e.ref}`)).size === evidence.length &&
        evidence.every((e) => allowed.has(`${e.source}:${e.ref}`)),
      'oracle-citation',
    );
    need((offline.category === 'unattributed' && l.judgment === null) || evidence.length > 0, 'oracle-evidence');
    return l as unknown as TuneLabel;
  });
  need(labels.length === cases.length && new Set(labels.map((l) => l.case)).size === cases.length, 'label-count');
  for (const category of categories)
    need(
      cases.filter(
        (c) =>
          c.annotation === 'characterization' && labels.find((l) => l.case === c.id)!.offline.category === category,
      ).length >= 4,
      'coverage',
    );
  return { cases, labels, facts, review_status: 'implementer-authored-no-independent-review' };
}

const base = 'benchmarks/failure-attribution/fixtures/';
export function loadTuneCorpus(): Corpus {
  // Reader checks pins; additionally bind descriptor pins to the authenticated manifest.

  let descriptors: unknown;
  try {
    descriptors = new TextDecoder('utf-8', { fatal: true })
      .decode(readTuneArtifact(`${base}tune.jsonl`))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch {
    return refusal('jsonl');
  }
  const cases = array(descriptors);
  const facts: unknown[] = [];
  const raw: unknown[] = [];
  for (const value of cases) {
    const c = row(value);
    for (const [key, output] of [
      ['facts', facts],
      ['receipts', raw],
    ] as const) {
      const pin = exact(c[key], ['path', 'storedByteDigest']);
      need(typeof pin.path === 'string' && digest(pin.storedByteDigest), 'descriptor-pin');
      output.push(decode(readTuneArtifact(pin.path, pin.storedByteDigest)));
    }
  }
  return validateCorpus(cases, decode(readTuneArtifact(`${base}tune-labels.json`)), facts, raw);
}

export function projectInput(facts: FrozenFacts, revisions: unknown) {
  const r = exact(revisions, ['classifier_revision', 'rule_revision', 'prompt_revision', 'model_revision']);
  need(
    digest(r.classifier_revision) && digest(r.rule_revision) && r.prompt_revision === null && r.model_revision === null,
    'runtime-revisions',
  );
  // JSON cloning selects the already validated six families; unknown top-level keys never flow.
  const bundle = Object.fromEntries(
    families.map((k) => [k, facts.bundle[k].map((fact) => projectFact(k, fact))]),
  ) as Record<Family, Row[]>;
  return {
    result: facts.result,
    case: facts.case,
    split: facts.split,
    bundle,
    revisions: {
      classifier_revision: r.classifier_revision,
      rule_revision: r.rule_revision,
      prompt_revision: null,
      model_revision: null,
    },
    judgment_request: null,
  };
}

/** Synthetic ordinary @1 context, not a corpus success criterion or runtime authority. */
export function tuneContext(facts: FrozenFacts, split: 'tune' | 'holdout' = 'tune', info = false): Context {
  const governed_by = { kind: 'policy', ref: 'g7-control-policy' };
  const criteria = info
    ? {
        schema: 'gauge.criteria@2',
        criteria: 'g7-control@1',
        workload: 'g7-control',
        governed_by,
        measures: [{ measure: 'success', source: { evidence: 'check' }, aggregate: 'rate', empty: null }],
      }
    : {
        schema: 'gauge.criteria@1',
        criteria: 'g7-control@1',
        workload: 'g7-control',
        governed_by,
        method: { interval: 'wilson@1', level: 0.95, seed: 1, min_samples: 1 },
        measures: [
          { measure: 'success', source: { evidence: 'check' }, aggregate: 'rate', better: 'higher', min_effect: 0 },
        ],
        constraints: [{ constraint: 'bar', measure: 'success', op: 'ge', bound: 0.9, role: 'quality_bar' }],
      };
  const caseset = {
    schema: 'gauge.caseset@1',
    caseset: 'g7-cases@1',
    workload: 'g7-control',
    governed_by,
    splits: [{ split, digest: recordDigest({ split }), size: 1 }],
  };
  const common = {
    result: facts.result,
    subject: { kind: 'implementation', ref: 'g7-supplied-control' },
    criteria: criteria.criteria,
    caseset: caseset.caseset,
    split,
    caseset_digest: recordDigest({ split }),
    mode: 'trial',
    evidence: [{ source: split === 'holdout' ? 'held_out_report' : 'check', ref: 'g7-observed-failure' }],
  };
  const result = info
    ? { ...common, schema: 'gauge.result@2', measures: [{ measure: 'success', value: 0, n: 2 }], verdict: 'info_only' }
    : {
        ...common,
        schema: 'gauge.result@1',
        measures: [{ measure: 'success', value: 0, n: 2, interval: [0, 0.1] }],
        constraints: [{ constraint: 'bar', status: 'violated' }],
        verdict: 'misses_bar',
      };
  const revision = (record: string, revision: string, value: unknown) => ({
    schema: 'gauge.revision@1',
    revision,
    record,
    digest: recordDigest(value),
    supersedes: null,
    issued_by: governed_by,
    justification: 'initial',
    evidence: [],
  });
  return {
    criteria: { [criteria.criteria]: criteria },
    casesets: { [caseset.caseset]: caseset },
    results: { [facts.result]: result },
    revisions: {
      [criteria.criteria]: revision('criteria', criteria.criteria, criteria),
      [caseset.caseset]: revision('caseset', caseset.caseset, caseset),
    },
  };
}

export function shapeVerdict(facts: FrozenFacts, decision: unknown, context: Context = tuneContext(facts)) {
  const d = row(decision);
  return validate(
    { schema: 'gauge.attribution@1', attribution: 'g7-control', result: facts.result, case: facts.case, ...d },
    context,
  );
}
export function expectedOfflineControl(label: TuneLabel): LeafDecision {
  return {
    ...label.offline,
    basis: label.offline.category === 'unattributed' ? 'none' : 'deterministic',
    confidence: null,
    evidence: label.offline.category === 'unattributed' ? [] : label.acceptable_citations.map((e) => ({ ...e })),
  };
}
export function expectedJudgmentControl(label: TuneLabel): LeafDecision {
  need(label.judgment !== null, 'no-judgment-control');
  return {
    category: label.judgment,
    basis: 'judgment',
    signal: null,
    confidence: 0.7,
    evidence: label.acceptable_citations.map((e) => ({ ...e })),
  };
}
export function assess(facts: FrozenFacts, label: TuneLabel, answer: unknown): { ok: boolean; code: string } {
  if (answer === undefined || answer === null) return { ok: false, code: 'missing' };
  try {
    const d = exact(answer, ['category', 'basis', 'signal', 'confidence', 'evidence']);
    const shape = shapeVerdict(facts, d);
    if (!shape.ok) return { ok: false, code: `shape:${shape.reason}` };
    if (label.case !== facts.case) return { ok: false, code: 'binding' };
    const expected = d.basis === 'judgment' ? label.judgment : label.offline.category;
    if (expected === null || d.category !== expected) return { ok: false, code: 'category' };
    if (d.basis !== 'judgment' && d.signal !== label.offline.signal) return { ok: false, code: 'signal' };
    const evidence = refs(d.evidence);
    const allowed = new Set(label.acceptable_citations.map((e) => `${e.source}:${e.ref}`));
    if (
      (d.category !== 'unattributed' && evidence.length !== allowed.size) ||
      new Set(evidence.map((e) => `${e.source}:${e.ref}`)).size !== evidence.length ||
      evidence.some((e) => !allowed.has(`${e.source}:${e.ref}`))
    )
      return { ok: false, code: 'citation' };
    return { ok: true, code: 'pass' };
  } catch {
    return { ok: false, code: 'malformed' };
  }
}
export function summarize(outcomes: readonly { ok: boolean; code: string }[]) {
  const failures: Record<string, number> = {};
  for (const o of outcomes) if (!o.ok) failures[o.code] = (failures[o.code] ?? 0) + 1;
  return {
    total: outcomes.length,
    passed: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    failures,
  };
}
