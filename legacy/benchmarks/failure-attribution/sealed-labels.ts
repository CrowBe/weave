import { readSealedInputs, type SealedOptions } from './reader.ts';
import type { AttributionCategory } from '@weave/gauge';

type SealedLabel = { id: string; category: AttributionCategory; rationale: string };
type SealedLabels = { schema: 'gauge.sealed-labels@1'; labels: SealedLabel[] };
const categories = new Set(['capability_gap', 'implementation', 'routing', 'orchestration', 'unattributed']);
function fail(): never {
  throw new Error('g7-sealed: invalid label envelope');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** Semantic validation is separate from raw-byte and independent freeze-pin verification. */
export function validateSealedLabelEnvelope(value: unknown): SealedLabels {
  if (
    !record(value) ||
    !keys(value, ['schema', 'labels']) ||
    value.schema !== 'gauge.sealed-labels@1' ||
    !Array.isArray(value.labels)
  )
    fail();
  const ids = new Set<string>();
  const labels: SealedLabel[] = [];
  for (const row of value.labels as unknown[]) {
    if (
      !record(row) ||
      !keys(row, ['id', 'category', 'rationale']) ||
      typeof row.id !== 'string' ||
      !/^[A-Za-z0-9_.:@-]{1,128}$/.test(row.id) ||
      ids.has(row.id) ||
      typeof row.category !== 'string' ||
      !categories.has(row.category) ||
      typeof row.rationale !== 'string' ||
      row.rationale.trim().length === 0 ||
      row.rationale.length > 4096
    )
      fail();
    ids.add(row.id);
    labels.push({ id: row.id, category: row.category as AttributionCategory, rationale: row.rationale });
  }
  return { schema: 'gauge.sealed-labels@1', labels };
}

export function loadSealedLabels(options: SealedOptions): SealedLabels {
  const verified = readSealedInputs(options);
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.labels)) as unknown;
  } catch {
    return fail();
  }
  return validateSealedLabelEnvelope(envelope);
}
