/**
 * Boundary tests for the Jev probe harness.
 *
 * The seams that matter are the two the network does not cross: the mapping
 * between a decision and Jev's answer shapes, and the scorer. Both are pure,
 * so these run offline and issue no inference.
 *
 * The scorer's central obligation is that it must not credit a predictor that
 * reads nothing. That is asserted directly here against constructed
 * constant-predictor records, which is the same control the repository's local
 * benchmarks require before quoting any model number.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CORPUS, type DecisionCase } from '../corpus.ts';
import { reduceAnswers, renderQuestions, renderState, ADVANCEMENT_LEVELS } from '../shapes.ts';
import { scoreShape } from '../score.ts';
import { optionKeys, toGatewayQuestion } from '../transfer.ts';
import type { ProbeRecord } from '../run.ts';

const CASE = CORPUS.find((c) => c.id === 'blocked.beta-unread')!;

test('every corpus label names one of that case’s own candidates', () => {
  for (const decision of CORPUS) {
    assert.ok(
      decision.candidates.some((c) => c.candidate_id === decision.label),
      `${decision.id} labels a candidate it does not offer`,
    );
  }
});

test('corpus case ids are unique', () => {
  assert.equal(new Set(CORPUS.map((c) => c.id)).size, CORPUS.length);
});

test('a contrast group holds exactly two members and one arm', () => {
  const groups = new Map<string, DecisionCase[]>();
  for (const decision of CORPUS) {
    if (decision.contrast === undefined) continue;
    const list = groups.get(decision.contrast.group) ?? [];
    list.push(decision);
    groups.set(decision.contrast.group, list);
  }
  assert.ok(groups.size > 0, 'the corpus carries no contrast groups');
  for (const [name, members] of groups) {
    assert.equal(members.length, 2, `${name} is not a pair`);
    assert.equal(new Set(members.map((m) => m.contrast!.arm)).size, 1, `${name} mixes arms`);
    const arm = members[0]!.contrast!.arm;
    const labels = new Set(members.map((m) => m.label));
    if (arm === 'relevant') assert.equal(labels.size, 2, `${name} must move but both members share a label`);
    else assert.equal(labels.size, 1, `${name} must hold but its members disagree`);
  }
});

test('every shape sees the same candidates, so the comparison is of shape only', () => {
  const state = JSON.stringify(renderState(CASE));
  for (const candidate of CASE.candidates) assert.ok(state.includes(candidate.candidate_id));
});

test('choice asks one question; score and boolean ask one per candidate', () => {
  assert.equal(Object.keys(renderQuestions('choice', CASE)).length, 1);
  assert.equal(Object.keys(renderQuestions('score', CASE)).length, CASE.candidates.length);
  assert.equal(Object.keys(renderQuestions('boolean', CASE)).length, CASE.candidates.length);
});

test('a boolean question states both arms declaratively and with content', () => {
  const question = Object.values(renderQuestions('boolean', CASE))[0]!;
  assert.equal(question.type, 'boolean');
  const criteria = (question as { criteria?: { true?: string; false?: string } }).criteria;
  assert.ok(criteria?.true !== undefined && criteria.true.length > 20);
  assert.ok(criteria.false !== undefined && criteria.false.length > 20);
  assert.ok(!criteria.true.trim().endsWith('?'), 'a hypothesis must not be interrogative');
});

test('each shape reduces to the same winner when the answers agree', () => {
  const winner = CASE.label;
  const choice = reduceAnswers('choice', CASE, {
    best: { type: 'choice', choice: winner, probabilities: { [winner]: 0.9 } },
  });
  const score = reduceAnswers(
    'score',
    CASE,
    Object.fromEntries(
      CASE.candidates.map((c) => [
        c.candidate_id,
        { type: 'score' as const, score: c.candidate_id === winner ? ADVANCEMENT_LEVELS.length - 1 : 0 },
      ]),
    ),
  );
  const boolean = reduceAnswers(
    'boolean',
    CASE,
    Object.fromEntries(
      CASE.candidates.map((c) => [
        c.candidate_id,
        { type: 'boolean' as const, probability: c.candidate_id === winner ? 0.95 : 0.05 },
      ]),
    ),
  );
  assert.equal(choice.top, winner);
  assert.equal(score.top, winner);
  assert.equal(boolean.top, winner);
});

test('a tie is reported rather than hidden by argmax', () => {
  const tied = reduceAnswers(
    'boolean',
    CASE,
    Object.fromEntries(CASE.candidates.map((c) => [c.candidate_id, { type: 'boolean' as const, probability: 0.5 }])),
  );
  assert.equal(tied.tied, true);
  assert.equal(tied.margin, 0);
});

test('a missing answer is an error, never an invented one', () => {
  assert.throws(() => reduceAnswers('score', CASE, {}));
});

// --- the scorer must not credit a predictor that reads nothing -------------

function constantPredictorRecords(kind: string): ProbeRecord[] {
  return CORPUS.map((decision) => {
    const first = decision.candidates[0]!;
    return {
      case_id: decision.id,
      source: decision.source,
      kind: kind as ProbeRecord['kind'],
      repeat: 0,
      ordering_index: 0,
      label: decision.label,
      candidate_ids: decision.candidates.map((c) => c.candidate_id),
      state_chars: 0,
      latency_ms: 1,
      status: 'accepted',
      routed_unit_id: 'stub',
      spent: 0,
      attempts: [],
      ranking: {
        top: first.candidate_id,
        ordered: decision.candidates.map((c, i) => ({ candidate_id: c.candidate_id, value: i === 0 ? 1 : 0 })),
        confidence: 1,
        margin: 1,
        tied: false,
      },
    } satisfies ProbeRecord;
  });
}

test('an always-first predictor scores exactly its own floor and no margin', () => {
  const report = scoreShape('score', constantPredictorRecords('score'), CORPUS);
  assert.equal(report.accuracy, report.floors.always_first);
  assert.ok(
    report.margin_over_best_floor <= 0,
    `a state-blind predictor claimed ${report.margin_over_best_floor} of margin`,
  );
});

test('an always-first predictor cannot pass a contrast arm that must move', () => {
  const report = scoreShape('score', constantPredictorRecords('score'), CORPUS);
  assert.ok(report.contrast.relevant_groups > 0);
  assert.equal(
    report.contrast.relevant_flipped_both_correct,
    0,
    'a predictor that ignores the state cannot flip when the state changes',
  );
});

test('a perfect predictor clears every floor and both contrast arms', () => {
  const records = CORPUS.map((decision) => {
    const base = constantPredictorRecords('choice').find((r) => r.case_id === decision.id)!;
    return {
      ...base,
      ranking: { ...base.ranking!, top: decision.label },
    } satisfies ProbeRecord;
  });
  const report = scoreShape('choice', records, CORPUS);
  assert.equal(report.accuracy, 1);
  assert.ok(report.margin_over_best_floor > 0);
  assert.equal(report.contrast.relevant_flipped_both_correct, report.contrast.relevant_groups);
  assert.equal(report.contrast.irrelevant_held, report.contrast.irrelevant_groups);
});

// --- the suite mapping ------------------------------------------------------

test('noul is the suite’s name for a boolean question', () => {
  const mapped = toGatewayQuestion({
    type: 'noul',
    instructions: 'Is this post offensive?',
    criteria: { true: 'Contains insults', false: 'Not offensive' },
    label: true,
    src: 'tweet_offensive',
  });
  assert.equal(mapped.kind, 'boolean');
  assert.equal(mapped.question.type, 'boolean');
});

test('the mapping never carries the answer to the model', () => {
  for (const question of [
    { type: 'choice' as const, instructions: 'q', criteria: { a: 'A', b: 'B' }, label: 'a', src: 's' },
    { type: 'noul' as const, instructions: 'q', criteria: { true: 'T', false: 'F' }, label: true, src: 's' },
    { type: 'score' as const, instructions: 'q', criteria: ['low', 'high'], label: 1, src: 's' },
  ]) {
    const encoded = JSON.stringify(toGatewayQuestion(question).question);
    assert.ok(!encoded.includes('"label"'), `${question.type} leaked its label`);
    assert.ok(!encoded.includes('"src"'), `${question.type} leaked its source`);
  }
});

test('option counts drive the uniform floor for every question type', () => {
  assert.equal(optionKeys({ type: 'choice', instructions: '', criteria: { a: 1, b: 2, c: 3 }, label: 'a', src: '' }).length, 3);
  assert.equal(optionKeys({ type: 'noul', instructions: '', label: true, src: '' }).length, 2);
  assert.equal(optionKeys({ type: 'score', instructions: '', criteria: ['a', 'b', 'c', 'd'], label: 0, src: '' }).length, 4);
});
