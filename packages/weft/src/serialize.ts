/**
 * The redaction boundary for `weft.record@1` (WEFT-CONTRACT.md, Disclosure).
 * The composition root supplies the redactor; Weft validates what it returns
 * and writes nothing it rejects.
 */
import type { InlinePolicy, Redactor, WeftRecord } from './types.js';
import {
  EMITTER_KEYS, ENVELOPE_KEYS, EVIDENCE_KEYS, FIELDS, LINK_KEYS, assertInlinePolicy, validateRecord,
} from './validate.js';

type Obj = Readonly<Record<string, unknown>>;

/** The keys of `o` in the given order. Validation has already ruled out any other key. */
const pick = (o: unknown, keys: readonly string[]): Obj =>
  Object.fromEntries(keys.filter(k => Object.hasOwn(o as Obj, k)).map(k => [k, (o as Obj)[k]]));

/** One JSONL line: the record redacted, validated under `inline`, with every key in contract order. */
export function serializeRecord(record: WeftRecord, redact: Redactor, inline?: InlinePolicy): string {
  if (typeof redact !== 'function') throw new TypeError('A Weft redactor is required before serialization');
  if (inline !== undefined) assertInlinePolicy(inline);
  // Snapshot the redactor's output so what is written is exactly what was validated.
  const clean: unknown = structuredClone(redact(record));
  const verdict = validateRecord(clean, inline);
  if (!verdict.ok) throw new Error(`Invalid Weft record: ${verdict.reason}`);
  const r = clean as WeftRecord;
  const fields = r.fields as Obj;
  const ordered = Object.entries(FIELDS[r.kind])
    .filter(([name]) => Object.hasOwn(fields, name))
    .map(([name, field]) => {
      const value = fields[name];
      if (field.keys === undefined) return [name, value];
      return [name, Array.isArray(value) ? value.map(item => pick(item, field.keys!)) : pick(value, field.keys)];
    });
  return `${JSON.stringify({
    ...pick(r, ENVELOPE_KEYS),
    emitter: pick(r.emitter, EMITTER_KEYS),
    links: r.links.map(link => pick(link, LINK_KEYS)),
    evidence: r.evidence.map(item => pick(item, EVIDENCE_KEYS)),
    fields: Object.fromEntries(ordered),
  })}\n`;
}
