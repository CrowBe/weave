import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateLocalRun, LocalGaugeStore, type RunEvidence } from './gauge.ts';
import { validate } from '@weave/gauge';

const run: RunEvidence = {
  id: 'prior-run',
  input: 'Convert the recipe PDF into a regular document.',
  status: 'settled',
  started_at: '2026-11-17T03:45:35.986Z',
  events: [
    {
      sequence: 1,
      task_id: 'task-1',
      parent: null,
      stage: 'input',
      detail: { input: 'Convert the recipe PDF into a regular document.' },
    },
    { sequence: 2, task_id: 'task-1', parent: null, stage: 'extract', detail: { intent: 'Convert' } },
    {
      sequence: 3,
      task_id: 'task-1',
      parent: null,
      stage: 'inference',
      detail: {
        site: 'local.band',
        choice: 'tool_call',
        admitted: false,
        probabilities: { tool_call: 0.46, ask_human: 0.39 },
      },
    },
  ],
  result: { status: 'needs_human', output: null, reason: 'uncertain decision', nodes: 1, requires_review: false },
  stats: { calls: 2, spent: 16, reserved: 0 },
};

test('the prior missing-question gap is captured in valid Gauge records without inventing an extraction failure', () => {
  const evaluation = evaluateLocalRun(run);
  assert.equal(evaluation.summary.verdict, 'misses_bar');
  assert.ok(evaluation.summary.gaps.includes('clarification_missing'));
  assert.ok(evaluation.summary.gaps.includes('decision_uncertain'));
  for (const record of evaluation.records) assert.deepEqual(validate(record, evaluation.context), { ok: true });
  const info = evaluation.records.find((record) => record.schema === 'gauge.result@2');
  assert.equal(info?.measures.find((measure) => measure.measure === 'extraction_completeness')?.value, null);
  const attribution = evaluation.records.find((record) => record.schema === 'gauge.attribution@1');
  assert.equal(attribution?.category, 'unattributed');
});

test('a question satisfies only the feedback requirement and does not claim task completion', () => {
  const evaluation = evaluateLocalRun({
    ...run,
    result: { ...run.result, question: 'Would you like Markdown or Word output?' },
  });
  assert.equal(evaluation.summary.verdict, 'meets_bar');
  assert.ok(!evaluation.summary.gaps.includes('clarification_missing'));
  assert.equal(evaluation.run.result.status, 'needs_human');
  assert.ok(evaluation.summary.gaps.includes('decision_uncertain'));
});

test('Gauge archives survive a new store instance and retain the earlier failed result', () => {
  const directory = mkdtempSync(join(tmpdir(), 'loom-gauge-'));
  try {
    const before = new LocalGaugeStore(directory).save(run);
    const restored = new LocalGaugeStore(directory).latest();
    assert.equal(restored?.summary.key, before.key);
    assert.equal(restored?.summary.verdict, 'misses_bar');
    const after = new LocalGaugeStore(directory).save({
      ...run,
      result: { ...run.result, question: 'Which output format?' },
    });
    assert.notEqual(after.key, before.key);
    assert.equal(new LocalGaugeStore(directory).latest()?.summary.verdict, 'meets_bar');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
