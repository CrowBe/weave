import assert from 'node:assert/strict';

/** Records carry ids, numbers and fixed vocabulary; never disclosed text. */
export function assertRecordCopiesNoText(record: unknown, forbidden: readonly string[]): void {
  const text = JSON.stringify(record);
  for (const value of forbidden) {
    assert.ok(!text.includes(value), `record copies forbidden text ${JSON.stringify(value)}`);
  }
}

export const assertNoCopiedText = assertRecordCopiesNoText;
