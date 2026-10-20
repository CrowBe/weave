/**
 * The digest a governed revision records (GAUGE-CONTRACT.md `gauge.revision@1`):
 * `sha256:` and the lowercase hex SHA-256 of canonical JSON, with object keys
 * sorted recursively and no whitespace. Editing a set in place changes it.
 */
import { createHash } from 'node:crypto';

export function recordDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  }
  return value;
}
