import { createHash } from 'node:crypto';
import { stableStringify } from './stable-json.js';

export function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
