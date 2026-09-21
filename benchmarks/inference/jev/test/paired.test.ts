/**
 * The paired Jev/Kev comparison counts a case once.
 *
 * A permutation file repeats an id under several presentation orders. Those
 * rows are one disagreement. Counting each row moves z without any new case.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { comparePaired } from '../transfer.ts';

test('the transfer split’s 14-to-7 disagreement is z = 1.53', () => {
  const records = [
    ...Array.from({ length: 14 }, (_, i) => ({ id: `jev-${i}`, correct: true })),
    ...Array.from({ length: 7 }, (_, i) => ({ id: `kev-${i}`, correct: false })),
    ...Array.from({ length: 104 }, (_, i) => ({ id: `same-${i}`, correct: true })),
  ];
  const kev = new Map<string, boolean>([
    ...records.filter((r) => r.id.startsWith('jev-')).map((r) => [r.id, false] as const),
    ...records.filter((r) => r.id.startsWith('kev-')).map((r) => [r.id, true] as const),
    ...records.filter((r) => r.id.startsWith('same-')).map((r) => [r.id, true] as const),
  ]);
  const report = comparePaired(records, (id) => kev.get(id));
  assert.equal(report.cases, 125);
  assert.equal(report.jevOnly, 14);
  assert.equal(report.kevOnly, 7);
  assert.equal(report.both, 104);
  assert.equal(report.z?.toFixed(2), '1.53');
});

test('repeating a stable disagreement does not inflate z', () => {
  const once = [{ id: 'a', correct: true }];
  const repeated = [0, 1, 2, 3].map((ordering) => ({ id: 'a', correct: true, ordering }));
  const kev = () => false;
  const single = comparePaired(once, kev);
  const inflated = comparePaired(repeated, kev);
  assert.equal(single.z, 1);
  assert.equal(inflated.presentations, 4);
  assert.equal(inflated.cases, 1);
  assert.equal(inflated.z, single.z);
});

test('a case whose correctness moves across presentations is omitted', () => {
  const report = comparePaired(
    [
      { id: 'moves', correct: true },
      { id: 'moves', correct: false },
      { id: 'stable', correct: true },
    ],
    () => false,
  );
  assert.equal(report.unstable, 1);
  assert.equal(report.cases, 1);
  assert.equal(report.jevOnly, 1);
  assert.equal(report.z, 1);
});

test('the recorded transfer permutation file is 309 rows of 125 cases', async () => {
  const records = JSON.parse(
    await readFile(new URL('../transfer-permutation-results.json', import.meta.url), 'utf8'),
  ) as { id: string; source: string; correct?: boolean }[];
  const report = comparePaired(records, () => true);
  assert.equal(report.presentations, 309);
  assert.equal(report.cases, 125);
  assert.equal(report.unstable, 0);
  const emotion = comparePaired(
    records.filter((r) => r.source === 'emotion'),
    () => false,
  );
  assert.equal(emotion.cases, 18);
  assert.equal(emotion.jevOnly, 11);
});

test('the 168-record Weave disagreement is z = 5.29, without a continuity correction', () => {
  const records = Array.from({ length: 28 }, (_, i) => ({ id: `only-${i}`, correct: true }));
  const report = comparePaired(records, () => false);
  assert.equal(report.jevOnly, 28);
  assert.equal(report.kevOnly, 0);
  assert.equal(report.z?.toFixed(2), '5.29');
});
