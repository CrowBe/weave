import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { root, tracked, plan, contract, source, definitionPins } from './context-budget-pins.js';

test('C1 reference has the recorded SHA-256 content hash', () => {
  const bytes = readFileSync(resolve(root, '_plan/PLAN.md'));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '3f59bef6e400fab64800e96595ba71521b66489f1242b958f0d4d3810730ad4d',
  );
});
test('FU3 contract source table resolves every tracked path and exported symbol', () => {
  const table = contract.split('Contract source pins contain symbols only')[1]!;
  assert.ok(table);
  let count = 0;
  for (const row of table.split('\n').filter((line) => line.startsWith('| `'))) {
    const [path, ...names] = [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    assert.ok(tracked.includes(path!));
    for (const name of names) {
      assert.ok(
        source(path!).declarations.some((declaration) => declaration.name === name && declaration.exported),
        `${path}: exported ${name}`,
      );
      count++;
    }
  }
  assert.equal(count, 22);
  assert.equal(/`[^`]+\.(?:ts|mjs):\d/.test(contract), false, 'contract source references contain no line pins');
});

// D-ENG-046: the immutable parent plan has these known diagnostics at the C1
// base. Compare the entire list: additions, removals and substitutions fail.
// The resolver remains strict; no todo, environment gate or ignored errors.
test('FU3 immutable plan has exactly the owner-approved definition/navigation diagnostics', () => {
  const result = definitionPins(plan);
  assert.ok(result.checked >= 60, `checked ${result.checked} declarations`);
  assert.deepEqual(result.errors, [
    'Error: unresolved/ambiguous tracked path digest.ts',
    'unmatched grouped definitions: payloadBytes, digest',
    'Error: unresolved/ambiguous tracked path stable-json.ts',
    'unmatched grouped definitions: stableStringify',
    'benchmarks/decision-sites/questions.ts:19: declaration buildRequest',
    'Error: unresolved/ambiguous tracked path run.ts',
    'unmatched grouped definitions: recordResultStep',
    'Error: unresolved/ambiguous tracked path journal.ts',
    'unmatched grouped definitions: FileAttemptJournal, FileJournal',
    'packages/weave/test/p8.test.ts:1096: test title a torn final line is repaired so later attempts stay loadable and resume does not repeat one',
    'packages/weave/test/p8.test.ts:1903: test title a part-written file journal append is reported as incomplete, not as another writer (#249)',
    'unmatched grouped definitions: FileJournal.snapshot',
    'packages/weave/src/runtime.ts:620: declaration Runtime.appendStep',
    'unmatched grouped definitions: reconcileStep',
    'unmatched grouped definitions: setTimeout',
    'Error: unresolved/ambiguous tracked path types.ts',
    'unmatched grouped definitions: ModelSettings.max_output_tokens',
  ]);
});
