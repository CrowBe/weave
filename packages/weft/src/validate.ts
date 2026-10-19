/**
 * Fail-closed validator for `weft.record@1` (WEFT-CONTRACT.md). It returns the
 * first applicable rejection reason in the contract's order. It sees one
 * record at a time: per-emitter sequence order and `(trace_id, record_id)`
 * idempotency are store rules.
 */
import { hasCredential } from './credential.js';
import { SCHEMA, type Kind, type Rejection, type Verdict } from './types.js';

const ENVELOPE_KEYS = [
  'schema', 'trace_id', 'record_id', 'emitter', 'sequence', 'kind',
  'thread_id', 'parent_id', 'links', 'evidence', 'fields',
] as const;
const MAX_BYTES = 16 * 1024;
const MAX_LINKS = 32;
const UTF8 = new TextEncoder();
const MAX_EVIDENCE = 64;

const EMITTER_KINDS = new Set(['loom', 'gateway', 'fabric', 'external']);
const LINK_RELS = new Set(['caused_by', 'joins', 'supersedes', 'cancels', 'handoff', 'retry_of']);
const EVIDENCE_SOURCES = new Set(['observation', 'inference_request', 'invocation', 'check', 'external']);
const CONTENT_CLASSES = new Set(['public', 'non_sensitive', 'sensitive', 'private']);

const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const CODE = /^[a-z][a-z0-9_.@:-]{0,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const isId = (x: unknown): x is string => typeof x === 'string' && ID.test(x) && !hasCredential(x);
export const isCode = (x: unknown): x is string => typeof x === 'string' && CODE.test(x);
export const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export const isMetric = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
export const isRatio = (x: unknown): x is number => isMetric(x) && x <= 1;
export const isDigest = (x: unknown): x is string => typeof x === 'string' && DIGEST.test(x);

type Obj = Readonly<Record<string, unknown>>;
const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const hasExactly = (o: Obj, keys: readonly string[], optional: readonly string[] = []): boolean =>
  keys.every(k => Object.hasOwn(o, k)) && Object.keys(o).every(k => keys.includes(k) || optional.includes(k));

export function isContent(x: unknown): boolean {
  return isObject(x) && hasExactly(x, ['content_class', 'digest'], ['ref'])
    && CONTENT_CLASSES.has(x.content_class as string) && isDigest(x.digest)
    && (!Object.hasOwn(x, 'ref') || isId(x.ref));
}

type Scalar = (x: unknown) => boolean;
const code = (...vocabulary: string[]): Scalar =>
  vocabulary.length === 0 ? isCode : x => isCode(x) && vocabulary.includes(x);
const flag: Scalar = x => typeof x === 'boolean';
const nullable = (inner: Scalar): Scalar => x => x === null || inner(x);
const list = (inner: Scalar, max: number): Scalar => x => Array.isArray(x) && x.length <= max && x.every(inner);
const shape = (spec: Readonly<Record<string, Scalar>>): Scalar => x =>
  isObject(x) && hasExactly(x, Object.keys(spec)) && Object.entries(spec).every(([k, ok]) => ok(x[k]));

interface Field {
  readonly ok: Scalar;
  readonly required?: true;
  readonly content?: true;
}
const req = (ok: Scalar): Field => ({ ok, required: true });
const opt = (ok: Scalar): Field => ({ ok });

const SCHEDULER_REASONS = ['dependency', 'conflict', 'stale_read_set', 'budget'];
const candidate = shape({
  candidate_ref: isId,
  operation: isCode,
  eligibility: code('allowed', 'approval_required', 'prohibited'),
  weight: nullable(isMetric),
  disposition: code('selected', ...SCHEDULER_REASONS, 'not_reached', 'policy_filtered'),
});

/** One disposition per path through Loom's cycle; see the `cycle.weighed` table. */
function candidatePathHolds(c: Obj): boolean {
  if (c.disposition === 'policy_filtered') return c.eligibility !== 'allowed' && c.weight === null;
  return c.eligibility === 'allowed';
}

const FIELDS: { readonly [K in Kind]: Readonly<Record<string, Field>> } = {
  'goal.intent': {
    goal_ref: req(isId),
    statement: { ok: isContent, required: true, content: true },
    criteria: opt(list(isId, 64)),
  },
  'thread.transition': {
    transition: req(code('opened', 'joined', 'superseded', 'cancelled', 'closed')),
  },
  'cycle.weighed': {
    cycle_no: req(isCount),
    state_revision: req(isCount),
    procedure: req(isCode),
    weights_ref: opt(nullable(isId)),
    cost_micros: opt(isCount),
    candidates: req(list(candidate, 256)),
  },
  judgment: {
    site: req(isCode),
    request_ref: req(isId),
    accepted: req(flag),
    confidence: opt(isRatio),
    routed_unit: opt(isId),
  },
  'route.selected': {
    request_ref: req(isId),
    routed_unit: req(isId),
    tier: opt(code('decision', 'flash', 'standard', 'strong')),
    excluded: opt(list(shape({ routed_unit: isId, reason: isCode }), 64)),
  },
  'inference.attempt': {
    request_ref: req(isId),
    routed_unit: req(isId),
    attempt_no: req(isCount),
    disposition: req(code('accepted', 'unaccepted', 'failed')),
    input_tokens: opt(isCount),
    output_tokens: opt(isCount),
    spent_micros: opt(isCount),
    cost_is_upper_bound: opt(flag),
    latency_ms: opt(isMetric),
  },
  'capability.invoked': {
    contract_rev: req(isId),
    implementation: req(isId),
    status: req(code('succeeded', 'failed', 'uncertain', 'cancelled')),
    invocation_ref: opt(isId),
    execution_tier: opt(isCode),
    failure: opt(isCode),
    latency_ms: opt(isMetric),
  },
  'action.transition': {
    action_ref: req(isId),
    operation: req(isCode),
    state: req(code('pending', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled')),
    contract_rev: opt(nullable(isId)),
  },
  'context.assembled': {
    assembly_ref: req(isId),
    view_ref: opt(isId),
    consumer: opt(isCode),
    slices: opt(list(isCode, 64)),
    source_revision: opt(isCount),
    omissions: opt(isCount),
    disclosed_bytes: opt(isCount),
    cost_micros: opt(isCount),
  },
  budget: {
    line: req(code('actions', 'judgments', 'cost')),
    limit: opt(isCount),
    reserved: opt(isCount),
    spent: opt(isCount),
  },
  outcome: {
    subject: req(code('goal', 'thread', 'action')),
    subject_ref: req(isId),
    status: req(code('complete', 'missed', 'succeeded', 'failed', 'cancelled', 'uncertain')),
    criteria_met: opt(isCount),
    criteria_total: opt(isCount),
  },
  error: {
    code: req(isCode),
    retryable: opt(flag),
  },
};

/** The fields each v1 kind may carry. Gauge reads this to bind a measure to a Weft source. */
export const KIND_FIELDS: { readonly [K in Kind]: readonly string[] } = Object.fromEntries(
  Object.entries(FIELDS).map(([kind, fields]) => [kind, Object.freeze(Object.keys(fields))]),
) as { readonly [K in Kind]: readonly string[] };

export const isKind = (x: unknown): x is Kind => typeof x === 'string' && Object.hasOwn(FIELDS, x);

/** Cross-field rules a single field's type cannot express. */
function crossFieldHolds(kind: Kind, f: Obj): boolean {
  switch (kind) {
    case 'cycle.weighed':
      return (f.candidates as readonly Obj[]).every(candidatePathHolds);
    case 'capability.invoked':
      return !Object.hasOwn(f, 'failure') || f.status === 'failed';
    case 'outcome':
      return !(Object.hasOwn(f, 'criteria_met') && Object.hasOwn(f, 'criteria_total'))
        || (f.criteria_met as number) <= (f.criteria_total as number);
    default:
      return true;
  }
}

/** Transitions that name the other thread's record. */
const REQUIRED_LINK: Readonly<Record<string, string>> = { joined: 'joins', superseded: 'supersedes' };

const reject = (reason: Rejection): Verdict => ({ ok: false, reason });

export function validateRecord(value: unknown): Verdict {
  // 1. envelope
  if (!isObject(value) || !hasExactly(value, ENVELOPE_KEYS)) return reject('envelope');
  const r = value;
  if (r.schema !== SCHEMA) return reject('envelope');
  if (!isObject(r.emitter) || !hasExactly(r.emitter, ['kind', 'id']) || !EMITTER_KINDS.has(r.emitter.kind as string)) {
    return reject('envelope');
  }
  if (typeof r.trace_id !== 'string' || typeof r.record_id !== 'string' || typeof r.emitter.id !== 'string'
    || !(r.thread_id === null || typeof r.thread_id === 'string')
    || !(r.parent_id === null || typeof r.parent_id === 'string')
    || typeof r.sequence !== 'number' || typeof r.kind !== 'string'
    || !Array.isArray(r.links) || !Array.isArray(r.evidence) || !isObject(r.fields)) {
    return reject('envelope');
  }
  if (UTF8.encode(JSON.stringify(r)).length > MAX_BYTES) return reject('envelope');

  // 2. id
  if (![r.trace_id, r.record_id, r.emitter.id].every(isId)) return reject('id');
  if (!(r.thread_id === null || isId(r.thread_id)) || !(r.parent_id === null || isId(r.parent_id))) return reject('id');

  // 3. sequence
  if (!isCount(r.sequence)) return reject('sequence');

  // 4. kind
  if (!isKind(r.kind)) return reject('kind');
  const kind = r.kind;
  if (kind === 'goal.intent' && r.thread_id !== null) return reject('kind');
  if (kind === 'thread.transition' && r.thread_id === null) return reject('kind');

  // 5. link
  const links = r.links as readonly unknown[];
  if (links.length > MAX_LINKS) return reject('link');
  const linkPairs = new Set<string>();
  for (const link of links) {
    if (!isObject(link) || !hasExactly(link, ['rel', 'record_id'])) return reject('link');
    if (!LINK_RELS.has(link.rel as string) || !isId(link.record_id)) return reject('link');
    if (link.record_id === r.record_id) return reject('link');
    const pair = `${link.rel as string}\u0000${link.record_id}`;
    if (linkPairs.has(pair)) return reject('link');
    linkPairs.add(pair);
  }
  if (kind === 'thread.transition') {
    const needed = REQUIRED_LINK[r.fields.transition as string];
    if (needed !== undefined && !links.some(l => (l as Obj).rel === needed)) return reject('link');
  }

  // 6. evidence
  const evidence = r.evidence as readonly unknown[];
  if (evidence.length > MAX_EVIDENCE) return reject('evidence');
  const evidencePairs = new Set<string>();
  for (const item of evidence) {
    if (!isObject(item) || !hasExactly(item, ['source', 'ref'])) return reject('evidence');
    if (!EVIDENCE_SOURCES.has(item.source as string) || !isId(item.ref)) return reject('evidence');
    const pair = `${item.source as string}\u0000${item.ref}`;
    if (evidencePairs.has(pair)) return reject('evidence');
    evidencePairs.add(pair);
  }
  if (r.emitter.kind === 'loom' && !evidence.some(e => (e as Obj).source === 'observation')) return reject('evidence');

  // 7. content
  const spec = FIELDS[kind];
  const fields = r.fields;
  for (const [name, field] of Object.entries(spec)) {
    if (field.content && Object.hasOwn(fields, name) && !field.ok(fields[name])) return reject('content');
  }

  // 8. field
  for (const name of Object.keys(fields)) if (!Object.hasOwn(spec, name)) return reject('field');
  for (const [name, field] of Object.entries(spec)) {
    if (!Object.hasOwn(fields, name)) {
      if (field.required) return reject('field');
    } else if (!field.ok(fields[name])) {
      return reject('field');
    }
  }
  if (!crossFieldHolds(kind, fields)) return reject('field');

  return { ok: true };
}
