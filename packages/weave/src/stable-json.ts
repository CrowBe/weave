/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Traces are
 * compared and digested through this so byte-identity is well-defined.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) {
        out[key] = canonicalize(v);
      }
    }
    return out;
  }
  return value;
}
