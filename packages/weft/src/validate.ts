/**
 * Fail-closed validator for `weft.record@1` (WEFT-CONTRACT.md). It returns the
 * first applicable rejection reason in the contract's order. It sees one
 * record at a time: per-emitter sequence order and `(trace_id, record_id)`
 * idempotency are store rules.
 */
import { createHash } from 'node:crypto';
import { hasCredential } from './credential.js';
import {
  SCHEMA,
  type ContentClass,
  type DisclosureClass,
  type InlinePolicy,
  type Kind,
  type Rejection,
  type Verdict,
} from './types.js';

export const ENVELOPE_KEYS = [
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
] as const;
export const EMITTER_KEYS = ['kind', 'id'] as const;
export const LINK_KEYS = ['rel', 'record_id'] as const;
export const EVIDENCE_KEYS = ['source', 'ref'] as const;
const CONTENT_KEYS = ['content_class', 'digest', 'ref', 'text'] as const;
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
const LONE_SURROGATE = /\p{Cs}/u;

export const isId = (x: unknown): x is string => typeof x === 'string' && ID.test(x) && !hasCredential(x);
export const isCode = (x: unknown): x is string => typeof x === 'string' && CODE.test(x);
export const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export const isMetric = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
export const isRatio = (x: unknown): x is number => isMetric(x) && x <= 1;
export const isDigest = (x: unknown): x is string => typeof x === 'string' && DIGEST.test(x);

type Obj = Readonly<Record<string, unknown>>;
const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const hasExactly = (o: Obj, keys: readonly string[], optional: readonly string[] = []): boolean =>
  keys.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => keys.includes(k) || optional.includes(k));

/** A content value in its default form: class, digest and optional ref, never text. */
export function isContent(x: unknown): boolean {
  return (
    isObject(x) &&
    hasExactly(x, ['content_class', 'digest'], ['ref']) &&
    CONTENT_CLASSES.has(x.content_class as string) &&
    isDigest(x.digest) &&
    (!Object.hasOwn(x, 'ref') || isId(x.ref))
  );
}

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** A content value, with text only where the policy permits it for this trace and class. */
function contentHolds(x: unknown, traceId: unknown, inline: InlinePolicy | undefined): boolean {
  if (!isObject(x) || !Object.hasOwn(x, 'text')) return isContent(x);
  const { text, ...value } = x;
  return (
    isContent(value) &&
    inline !== undefined &&
    inline.trace_id === traceId &&
    inline.classes.includes(value.content_class as ContentClass) &&
    typeof text === 'string' &&
    text.length > 0 &&
    !LONE_SURROGATE.test(text) &&
    !hasCredential(text) &&
    value.digest === sha256(text)
  );
}

/** A malformed inline content policy is a configuration error, not a verdict. */
export function assertInlinePolicy(inline: unknown): asserts inline is InlinePolicy {
  if (
    !(
      isObject(inline) &&
      hasExactly(inline, ['trace_id', 'classes']) &&
      isId(inline.trace_id) &&
      Array.isArray(inline.classes) &&
      inline.classes.every((c) => CONTENT_CLASSES.has(c as string))
    )
  ) {
    throw new TypeError('Invalid inline content policy');
  }
}

type Scalar = (x: unknown) => boolean;
const code = (...vocabulary: string[]): Scalar =>
  vocabulary.length === 0 ? isCode : (x) => isCode(x) && vocabulary.includes(x);
const flag: Scalar = (x) => typeof x === 'boolean';
const nullable =
  (inner: Scalar): Scalar =>
  (x) =>
    x === null || inner(x);
const list =
  (inner: Scalar, max: number): Scalar =>
  (x) =>
    Array.isArray(x) && x.length <= max && x.every(inner);
const shape =
  (spec: Readonly<Record<string, Scalar>>): Scalar =>
  (x) =>
    isObject(x) && hasExactly(x, Object.keys(spec)) && Object.entries(spec).every(([k, ok]) => ok(x[k]));

export interface Field {
  readonly ok: Scalar;
  readonly disclosure: DisclosureClass;
  readonly required?: true;
  /** Key order of an object value, or of each object in a list value, when serialized. */
  readonly keys?: readonly string[];
}
/** A measure: count, metric, ratio or flag. */
const met = (ok: Scalar): Field => ({ ok, disclosure: 'metric' });
/** A name or fingerprint: id, code or digest, or lists and objects of them (with any metrics beside). */
const ref = (ok: Scalar, keys?: readonly string[]): Field =>
  keys === undefined ? { ok, disclosure: 'reference' } : { ok, disclosure: 'reference', keys };
/** Goal content: a content value, checked by `contentHolds` under the inline policy. */
const content: Field = { ok: isContent, disclosure: 'content', keys: CONTENT_KEYS };
const req = (field: Field): Field => ({ ...field, required: true });

const SCHEDULER_REASONS = ['dependency', 'conflict', 'stale_read_set', 'budget'];
const CANDIDATE = {
  candidate_ref: isId,
  operation: isCode,
  eligibility: code('allowed', 'approval_required', 'prohibited'),
  weight: nullable(isMetric),
  disposition: code('selected', ...SCHEDULER_REASONS, 'not_reached', 'policy_filtered'),
};
const EXCLUSION = { routed_unit: isId, reason: isCode };

/** One disposition per path through Loom's cycle; see the `cycle.weighed` table. */
function candidatePathHolds(c: Obj): boolean {
  if (c.disposition === 'policy_filtered') return c.eligibility !== 'allowed' && c.weight === null;
  return c.eligibility === 'allowed';
}

export const FIELDS: { readonly [K in Kind]: Readonly<Record<string, Field>> } = {
  'goal.intent': {
    goal_ref: req(ref(isId)),
    statement: req(content),
    criteria: ref(list(isId, 64)),
  },
  'thread.transition': {
    transition: req(ref(code('opened', 'joined', 'superseded', 'cancelled', 'closed'))),
  },
  'cycle.weighed': {
    cycle_no: req(met(isCount)),
    state_revision: req(met(isCount)),
    procedure: req(ref(isCode)),
    weights_ref: ref(nullable(isId)),
    cost_micros: met(isCount),
    candidates: req(ref(list(shape(CANDIDATE), 256), Object.keys(CANDIDATE))),
  },
  judgment: {
    site: req(ref(isCode)),
    request_ref: req(ref(isId)),
    accepted: req(met(flag)),
    confidence: met(isRatio),
    routed_unit: ref(isId),
  },
  'route.selected': {
    request_ref: req(ref(isId)),
    routed_unit: req(ref(isId)),
    tier: ref(code('decision', 'flash', 'standard', 'strong')),
    excluded: ref(list(shape(EXCLUSION), 64), Object.keys(EXCLUSION)),
  },
  'inference.attempt': {
    request_ref: req(ref(isId)),
    routed_unit: req(ref(isId)),
    attempt_no: req(met(isCount)),
    disposition: req(ref(code('accepted', 'unaccepted', 'failed', 'uncertain'))),
    input_tokens: met(isCount),
    output_tokens: met(isCount),
    spent_micros: met(isCount),
    cost_is_upper_bound: met(flag),
    latency_ms: met(isMetric),
  },
  'capability.invoked': {
    contract_rev: req(ref(isId)),
    implementation: req(ref(isId)),
    status: req(ref(code('succeeded', 'failed', 'uncertain', 'cancelled'))),
    invocation_ref: ref(isId),
    execution_tier: ref(isCode),
    failure: ref(isCode),
    latency_ms: met(isMetric),
  },
  'capability.lifecycle': {
    operation: req(ref(isCode)),
    implementation: ref(isId),
    event: req(ref(code('selected', 'admitted', 'revoked'))),
    contract_rev: ref(nullable(isId)),
  },
  'action.transition': {
    action_ref: req(ref(isId)),
    operation: req(ref(isCode)),
    state: req(ref(code('pending', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled'))),
    contract_rev: ref(nullable(isId)),
  },
  'context.assembled': {
    assembly_ref: req(ref(isId)),
    view_ref: ref(isId),
    consumer: ref(isCode),
    slices: ref(list(isCode, 64)),
    source_revision: met(isCount),
    omissions: met(isCount),
    disclosed_bytes: met(isCount),
    cost_micros: met(isCount),
  },
  budget: {
    line: req(ref(code('actions', 'judgments', 'cost'))),
    limit: met(isCount),
    reserved: met(isCount),
    spent: met(isCount),
  },
  outcome: {
    subject: req(ref(code('goal', 'thread', 'action'))),
    subject_ref: req(ref(isId)),
    status: req(ref(code('complete', 'missed', 'succeeded', 'failed', 'cancelled', 'uncertain'))),
    criteria_met: met(isCount),
    criteria_total: met(isCount),
  },
  error: {
    code: req(ref(isCode)),
    retryable: met(flag),
  },
};

/** The fields each v1 kind may carry. Gauge reads this to bind a measure to a Weft source. */
export const KIND_FIELDS: { readonly [K in Kind]: readonly string[] } = Object.fromEntries(
  Object.entries(FIELDS).map(([kind, fields]) => [kind, Object.freeze(Object.keys(fields))]),
) as { readonly [K in Kind]: readonly string[] };

/** The disclosure class of every field of each v1 kind (WEFT-CONTRACT.md, Disclosure). */
export const FIELD_DISCLOSURE: { readonly [K in Kind]: Readonly<Record<string, DisclosureClass>> } = Object.fromEntries(
  Object.entries(FIELDS).map(([kind, fields]) => [
    kind,
    Object.freeze(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.disclosure]))),
  ]),
) as { readonly [K in Kind]: Readonly<Record<string, DisclosureClass>> };

export const isKind = (x: unknown): x is Kind => typeof x === 'string' && Object.hasOwn(FIELDS, x);

/** Cross-field rules a single field's type cannot express. */
function crossFieldHolds(kind: Kind, f: Obj): boolean {
  switch (kind) {
    case 'cycle.weighed':
      return (f.candidates as readonly Obj[]).every(candidatePathHolds);
    case 'capability.invoked':
      return !Object.hasOwn(f, 'failure') || f.status === 'failed';
    case 'outcome':
      return (
        !(Object.hasOwn(f, 'criteria_met') && Object.hasOwn(f, 'criteria_total')) ||
        (f.criteria_met as number) <= (f.criteria_total as number)
      );
    default:
      return true;
  }
}

/** Transitions that name the other thread's record. */
const REQUIRED_LINK: Readonly<Record<string, string>> = { joined: 'joins', superseded: 'supersedes' };

const reject = (reason: Rejection): Verdict => ({ ok: false, reason });

/**
 * Without `inline`, no record may carry content text. A malformed `inline`
 * throws: it is a configuration error, not a property of the record.
 */
export function validateRecord(value: unknown, inline?: InlinePolicy): Verdict {
  if (inline !== undefined) assertInlinePolicy(inline);

  // 1. envelope
  if (!isObject(value) || !hasExactly(value, ENVELOPE_KEYS)) return reject('envelope');
  const r = value;
  if (r.schema !== SCHEMA) return reject('envelope');
  if (!isObject(r.emitter) || !hasExactly(r.emitter, EMITTER_KEYS) || !EMITTER_KINDS.has(r.emitter.kind as string)) {
    return reject('envelope');
  }
  if (
    typeof r.trace_id !== 'string' ||
    typeof r.record_id !== 'string' ||
    typeof r.emitter.id !== 'string' ||
    !(r.thread_id === null || typeof r.thread_id === 'string') ||
    !(r.parent_id === null || typeof r.parent_id === 'string') ||
    typeof r.sequence !== 'number' ||
    typeof r.kind !== 'string' ||
    !Array.isArray(r.links) ||
    !Array.isArray(r.evidence) ||
    !isObject(r.fields)
  ) {
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
    if (!isObject(link) || !hasExactly(link, LINK_KEYS)) return reject('link');
    if (!LINK_RELS.has(link.rel as string) || !isId(link.record_id)) return reject('link');
    if (link.record_id === r.record_id) return reject('link');
    const pair = `${link.rel as string}\u0000${link.record_id}`;
    if (linkPairs.has(pair)) return reject('link');
    linkPairs.add(pair);
  }
  if (kind === 'thread.transition') {
    const needed = REQUIRED_LINK[r.fields.transition as string];
    if (needed !== undefined && !links.some((l) => (l as Obj).rel === needed)) return reject('link');
  }

  // 6. evidence
  const evidence = r.evidence as readonly unknown[];
  if (evidence.length > MAX_EVIDENCE) return reject('evidence');
  const evidencePairs = new Set<string>();
  for (const item of evidence) {
    if (!isObject(item) || !hasExactly(item, EVIDENCE_KEYS)) return reject('evidence');
    if (!EVIDENCE_SOURCES.has(item.source as string) || !isId(item.ref)) return reject('evidence');
    const pair = `${item.source as string}\u0000${item.ref}`;
    if (evidencePairs.has(pair)) return reject('evidence');
    evidencePairs.add(pair);
  }
  if (r.emitter.kind === 'loom' && !evidence.some((e) => (e as Obj).source === 'observation'))
    return reject('evidence');

  // 7. content
  const spec = FIELDS[kind];
  const fields = r.fields;
  for (const [name, field] of Object.entries(spec)) {
    if (
      field.disclosure === 'content' &&
      Object.hasOwn(fields, name) &&
      !contentHolds(fields[name], r.trace_id, inline)
    ) {
      return reject('content');
    }
  }

  // 8. field
  for (const name of Object.keys(fields)) if (!Object.hasOwn(spec, name)) return reject('field');
  for (const [name, field] of Object.entries(spec)) {
    if (!Object.hasOwn(fields, name)) {
      if (field.required) return reject('field');
    } else if (field.disclosure !== 'content' && !field.ok(fields[name])) {
      return reject('field');
    }
  }
  if (!crossFieldHolds(kind, fields)) return reject('field');

  return { ok: true };
}
