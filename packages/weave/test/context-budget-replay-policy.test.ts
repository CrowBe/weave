// FU5 coverage is a document contract. No replay cursor or runtime feed ships here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { contract, plan, prose } from './context-budget-pins.js';

const ids = ['T9-L1', 'T9-L2', 'T9-R0', 'T9-R1', 'T9-R2', 'T9-R1x', 'T9-Q0', 'T9-G1', 'T9-C1'];
const obsolete = 'T9-R2(b)';
const anchors = ['  <!-- fu5-label-spec:start -->', '  <!-- fu5-label-spec:end -->'];
const declaration = plan.split(anchors[0]!)[1]!.split(anchors[1]!)[0]!;
function obsoleteErrors(doc: string): string[] {
  const errors: string[] = [];
  let history = false;
  let inside = false;
  const rows = prose(doc);
  const seen = anchors.map((anchor) => rows.filter((row) => row.text === anchor).length);
  if (seen.some((count) => count !== 1)) errors.push('unique declaration anchors');
  let fu5 = false;
  for (const row of rows) {
    if (row.text.startsWith('## ')) history = /^## \d+\. Review disposition — /.test(row.text);
    if (row.text.startsWith('- **FU5 ') && row.section === 13) fu5 = true;
    else if (/^- \*\*FU\d/.test(row.text)) fu5 = false;
    if (row.text === anchors[0]) inside = fu5 && seen.every((count) => count === 1);
    if (new RegExp(`(?<![\\w-])T9-R2\\(b\\)(?![\\w-])`).test(row.text) && !history && !inside)
      errors.push(`obsolete label at ${row.line}`);
    if (row.text === anchors[1]) inside = false;
  }
  return errors;
}
const required: Record<string, string[]> = {
  'T9-L1': ['Reachable', 'formation proof', 'goal.frame', 'report.review', 'candidates.ts:108-130'],
  'T9-L2': ['Reachable', 'PROCEDURE_FRAME', 'queues', 'A', 'B'],
  'T9-R0': ['Synthetic', 'validate/load', 'zero', 'recovery.exhausted'],
  'T9-R1': ['Reachable', 'formation proof', 'FW-T08', 'weights ingress', 'finishReview', 'second reload'],
  'T9-R2': ['Reachable', 'formation proof', 'PROCEDURE_FRAME', 'finishReview', 'second reload', ':1897'],
  'T9-R1x': ['Synthetic', 'validate/load', 'limit=1/spent=0', 'Second reload', 'recovery.attempted'],
  'T9-Q0': ['Synthetic', 'validate/load', 'scoped_queue_cancel_unreachable'],
  'T9-G1': ['Reachable', 'formation proof', 'HEAD', 'unrelated stop'],
  'T9-C1': ['Synthetic', 'validate/load', 'selection', 'prefix'],
};
function t9Errors(doc: string): string[] {
  const errors: string[] = [];
  const section = doc.split('## 8. Red-before-green acceptance plan')[1]?.split('## 9.')[0] ?? '';
  const lines = section.split('\n');
  const rows = lines.flatMap((row, index) => {
    const id = /^\| (T9-[A-Z]\d+x?)\s*\|/.exec(row)?.[1];
    return id ? [{ id, row, index }] : [];
  });
  if (rows.map((row) => row.id).join(',') !== ids.join(',')) errors.push('exact nine-row T9 order');
  if (rows.length !== 9 || rows.at(-1)!.index - rows[0]!.index !== 8) errors.push('contiguous T9 table');
  for (const { id, row } of rows) {
    for (const word of required[id] ?? []) if (!row.includes(word)) errors.push(`${id}: missing ${word}`);
    if (row.includes('Synthetic') && /replay succeeds|replay success witness/i.test(row))
      errors.push(`${id}: synthetic claimed success`);
  }
  for (const word of [
    'Synthetic journal construction',
    'call `validate(input, state)`',
    '`Runtime.load`',
    'no managed v1',
    'scripted',
    'first divergence seq',
    'procedure, candidate set, formation',
    'finishReview',
    'second reload',
    'running-review restart',
    'recovery.attempted',
  ]) {
    if (!section.includes(word)) errors.push(`construction/ordering: ${word}`);
  }
  const precursor = doc.split('**C2d first precursor check')[1]?.split('**Scoped cancellation')[0] ?? '';
  for (const word of [
    'P_overflow',
    'P_marker',
    'measuredCeiling',
    'term-invariance',
    'same injected historical accounting-family member',
    'version and digest',
    'before recomputation',
    'test-local',
    'marker',
    'route',
  ]) {
    if (!precursor.includes(word)) errors.push(`retained precursor: ${word}`);
  }
  const fu5 = doc.split('- **FU5 ')[1]?.split('- **FU6 ')[0] ?? '';
  for (const word of [
    'procedure',
    'candidate set',
    'formation path',
    'source pins',
    'scheduling evidence',
    'q',
    'feedReviewResult',
    'term-only',
    'coverage/route membership',
    'final-term marker byte counts',
    'identity/version/digest assertion',
    'test-local-estimator substitution mutation',
  ]) {
    if (!fu5.includes(word)) errors.push(`FU5 obligation: ${word}`);
  }
  return errors;
}

test('FU5 exact obsolete token placement, anchors and all current history sections', () => {
  assert.deepEqual(obsoleteErrors(plan), []);
  const spec = `## 13. Follow-ups\n- **FU5 (declaration).**\n${anchors[0]}${declaration}${anchors[1]}\n`;
  assert.deepEqual(obsoleteErrors(spec), []);
  const sections = new Set([22, 23, 24, 25, 26, 99]);
  for (const row of prose(plan)) if (row.section && row.text.includes('R2(b)')) sections.add(row.section);
  for (const number of sections) {
    assert.deepEqual(obsoleteErrors(spec + `## ${number}. Review disposition — history\n${obsolete} R2(b)\n`), []);
  }
  assert.deepEqual(obsoleteErrors(spec + '## 3. Decisions\nR2(b) and delayed queued-abandonment are valid\n'), []);
  assert.deepEqual(obsoleteErrors(spec + `## 3. Decisions\nx${obsolete}suffix\n`), []);
  for (const suffix of [
    obsolete,
    `| ${obsolete} | row |`,
    `- **FU5 (outside anchors).**\n${obsolete}`,
    `## 3. Decisions\n- **FU5 (copied).**\n${anchors[0]}\n${obsolete}\n${anchors[1]}`,
    `\n\`\`\`md\n## 99. Review disposition — fake\n\`\`\`\n${obsolete}`,
  ]) {
    assert.ok(obsoleteErrors(spec + '\n## 3. Decisions\n' + suffix).length);
  }
});
test('FU5 contiguous T9 table, construction and retained precursor contracts', () => {
  assert.deepEqual(t9Errors(plan), []);
});
test('FU5 missing/duplicate/split rows and erased formation/reload evidence reject', () => {
  const row = plan.split('\n').find((line) => line.startsWith('| T9-R1 '))!;
  for (const mutation of [
    plan.replace(row, ''),
    plan.replace(row, row + '\n' + row),
    plan.replace(row, row + '\n\n'),
    plan.replace(row, row.replaceAll('formation proof', 'omitted')),
    plan.replace(row, row.replaceAll('second reload', 'later')),
    plan.replaceAll('same injected historical accounting-family member', 'substitute estimator'),
    plan.replaceAll('final-term marker byte counts', 'omitted'),
  ]) {
    assert.ok(t9Errors(mutation).length);
  }
});
test('FU5 every replay write-site has owner/validation, ordering and continuation in the contract', () => {
  const table = contract.split('Policy is keyed by (record type, write site)')[1]?.split('Each disposition')[0] ?? '';
  const rows = table
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .slice(2);
  assert.equal(rows.length, 9);
  for (const row of rows)
    assert.ok(
      row
        .split('|')
        .slice(1, -1)
        .every((cell) => cell.trim().length > 0),
    );
  for (const literal of [
    'live execute',
    'reconcile pre-pass',
    'stop-backed live result drain',
    'post-pre-pass end-of-reconcile drain',
    'scoped_queue_cancel_unreachable',
    'recovery.exhausted',
    'other write sites',
    'owner/action/decision',
    'recorded seq',
    'No cycle or drain',
  ]) {
    assert.ok(table.toLowerCase().includes(literal.toLowerCase()), literal);
  }
});
