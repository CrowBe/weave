import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationOutcome } from '@weave/gateway';
import { transitionBooleanSite, INPUT_RULES, type BooleanSiteInput, type PreselectPolicyInput, type PreselectSelection } from '../src/sites/boolean.js';

const current = { state_revision: 1, state_updated_at: 10 };
const terms = { quality: 'baseline' as const, destinations: ['local'], max_context_tokens: 100, deadline: 100, cost_ceiling: 10, max_attempts: 1 };
function policy(k: number, floor = 0, provider: PreselectPolicyInput['provider'] = 'typesafe-jev'): PreselectPolicyInput {
  return { k, floor, provider };
}
function input(probabilities: readonly number[], extra: Partial<BooleanSiteInput> = {}): BooleanSiteInput {
  return {
    ...current, request_id: 'r1', state: { text: 'STATE_CANARY' }, needs_dispatch: true, terms,
    catalogue_index: probabilities.map((_, n) => ({ id: `cap_${n}`, purpose: 'PURPOSE_CANARY' })),
    ...extra,
  };
}
function recorded(probabilities: readonly number[], confidence = 1) {
  const keys = probabilities.map((_, n) => `entry_${n}`);
  const outcome: EvaluationOutcome<'boolean'> = {
    status: 'accepted', kind: 'boolean', site: 'loop.preselect', request_id: 'r1',
    answers: Object.fromEntries(keys.map((key, n) => [key, { type: 'boolean' as const, probability: probabilities[n]! }])),
    confidence: Object.fromEntries(keys.map(key => [key, confidence])),
    provider_response_id: 'provider-1', routed_unit_id: 'fixture', attempts: [], spent: 0, uncertainty: [],
  };
  return { state_revision: 1, observed_at: 10, outcome };
}
function select(probabilities: readonly number[], extra: Partial<BooleanSiteInput> = {}, confidence = 1) {
  return transitionBooleanSite('loop.preselect', input(probabilities, extra), recorded(probabilities, confidence), current);
}
function ids(result: { catalogue_index: readonly { id: string }[] }) {
  return result.catalogue_index.map(entry => entry.id);
}
function assertTrace(record: PreselectSelection, probabilities: readonly number[]) {
  assert.deepEqual(Object.keys(record), ['schema', 'k', 'floor', 'cap', 'provider', 'outcome', 'scores', 'kept', 'required_missing']);
  assert.equal(record.schema, 'preselect-selection@1');
  assert.equal(record.cap, 8);
  assert.equal(record.scores.length, probabilities.length);
  assert.equal(record.kept, record.scores.filter(score => score.kept).length);
  for (const [n, score] of record.scores.entries()) {
    assert.deepEqual(Object.keys(score), ['entry', 'p', 'rank', 'kept', 'required']);
    assert.equal(score.entry, n);
  }
  const text = JSON.stringify(record);
  assert.deepEqual(JSON.parse(text), record);
  assert.equal(text.includes('cap_'), false);
  assert.equal(text.includes('PURPOSE_CANARY'), false);
  assert.equal(text.includes('MISSING_CANARY'), false);
  assert.equal(text.includes('STATE_CANARY'), false);
}

test('top-k keeps exactly k by score, including k=1, k=8, ties, and a short index', () => {
  const descending = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05];
  assert.deepEqual(ids(select(descending, { preselect_policy: policy(3) })), ['cap_0', 'cap_1', 'cap_2']);
  assert.deepEqual(ids(select(descending)), ['cap_0', 'cap_1', 'cap_2']);
  assert.deepEqual(ids(select(descending, { preselect_policy: policy(1) })), ['cap_0']);
  assert.deepEqual(ids(select([0.2, 0.2, 0.2], { preselect_policy: policy(1) })), ['cap_0']);
  assert.deepEqual(ids(select([0.1, 0.4, 0.4], { preselect_policy: policy(2) })), ['cap_1', 'cap_2']);
  assert.deepEqual(ids(select(descending, { preselect_policy: policy(8) })), descending.slice(0, 8).map((_, n) => `cap_${n}`));
  assert.deepEqual(ids(select([0.2, 0.9])), ['cap_1', 'cap_0']);
  const short = select([0.4, 0.2], { preselect_policy: policy(8) });
  assert.deepEqual(ids(short), ['cap_0', 'cap_1']);
  assert.equal(short.preselect?.outcome, 'narrowed');
  assert.equal(short.preselect?.kept, 2);
});

test('a probability of .49 inside the top k is kept and the observation follows the kept set', () => {
  const result = select([0.49, 0.9, 0.49, 0.1], { preselect_policy: policy(3, 0, 'amos') });
  assert.deepEqual(ids(result), ['cap_1', 'cap_0', 'cap_2']);
  assert.deepEqual(result.observations.slice(0, 4).map(observation => observation.answer), ['include', 'include', 'include', 'exclude']);
  assert.deepEqual(result.observations.slice(0, 4).map(observation => observation.top_p), [0.49, 0.9, 0.49, 0.1]);
  assert.equal(result.preselect?.provider, 'amos');
  assert.equal(result.preselect?.outcome, 'narrowed');
});

test('a score exactly equal to the floor is kept', () => {
  const result = select([0.9, 0.5, 0.49], { preselect_policy: policy(3, 0.5) });
  assert.deepEqual(ids(result), ['cap_0', 'cap_1']);
  assert.equal(result.preselect?.scores[1]?.kept, true);
  assert.equal(result.preselect?.scores[1]?.p, 0.5);
  assert.equal(result.preselect?.scores[2]?.kept, false);
  assert.equal(result.preselect?.outcome, 'narrowed');
});

test('a catalogue id that appears twice keeps both positions when required', () => {
  const probabilities = [0.2, 0.9, 0.05];
  const catalogue_index = [
    { id: 'cap_dup', purpose: 'FIRST_POSITION' },
    { id: 'cap_other', purpose: 'OTHER_POSITION' },
    { id: 'cap_dup', purpose: 'SECOND_POSITION' },
  ];
  const result = select(probabilities, {
    preselect_policy: policy(1, 0.5),
    required_entry_ids: ['cap_dup'],
    catalogue_index,
  });
  assert.deepEqual(result.catalogue_index.map(entry => [entry.id, entry.purpose]), [
    ['cap_other', 'OTHER_POSITION'],
    ['cap_dup', 'FIRST_POSITION'],
    ['cap_dup', 'SECOND_POSITION'],
  ]);
  assert.equal(result.preselect?.scores[0]?.required, true);
  assert.equal(result.preselect?.scores[0]?.kept, true);
  assert.equal(result.preselect?.scores[2]?.required, true);
  assert.equal(result.preselect?.scores[2]?.kept, true);
  assert.equal(result.preselect?.scores[1]?.required, false);
  assert.equal(result.preselect?.required_missing, 0);
  assert.equal(result.preselect?.kept, 3);
  const text = JSON.stringify(result.preselect);
  assert.equal(text.includes('FIRST_POSITION'), false);
  assert.equal(text.includes('SECOND_POSITION'), false);
  assert.equal(text.includes('cap_dup'), false);
  assert.ok(result.preselect);
  assertTrace(result.preselect, probabilities);
});

test('narrowed catalogue order is required plus top-k by p descending, ties in disclosed order', () => {
  const probabilities = [0.6, 0.6, 0.9, 0.6, 0.1];
  const result = select(probabilities, { preselect_policy: policy(2), required_entry_ids: ['cap_1'] });
  assert.deepEqual(ids(result), ['cap_2', 'cap_0', 'cap_1']);
  assert.equal(result.preselect?.scores[1]?.required, true);
  assert.equal(result.preselect?.scores[1]?.kept, true);
  assert.equal(result.preselect?.scores[0]?.kept, true);
  assert.equal(result.preselect?.scores[2]?.kept, true);
  assert.equal(result.preselect?.scores[3]?.kept, false);
  assert.equal(result.preselect?.scores[4]?.kept, false);
  assert.equal(result.preselect?.kept, 3);
  assert.equal(result.preselect?.outcome, 'narrowed');
});

test('floor drops a score inside k and floor 0 keeps that score', () => {
  const probabilities = [0.9, 0.04, 0.5];
  const floored = select(probabilities, { preselect_policy: policy(3, 0.1) });
  assert.deepEqual(ids(floored), ['cap_0', 'cap_2']);
  assert.equal(floored.preselect?.scores[1]?.kept, false);
  assert.equal(floored.preselect?.floor, 0.1);
  const open = select(probabilities, { preselect_policy: policy(3, 0) });
  assert.deepEqual(ids(open), ['cap_0', 'cap_2', 'cap_1']);
  assert.equal(open.preselect?.scores[1]?.kept, true);
  assert.deepEqual(ids(select([0, 0, 0], { preselect_policy: policy(3, 0) })), ['cap_0', 'cap_1', 'cap_2']);
});

test('required entries stay beyond k and cap, and a missing id is only a count', () => {
  const beyondK = select([0.99, 0, 0.4], { preselect_policy: policy(1), required_entry_ids: ['cap_1', 'cap_1'] });
  assert.deepEqual(ids(beyondK), ['cap_0', 'cap_1']);
  assert.equal(beyondK.preselect?.scores[1]?.required, true);
  assert.equal(beyondK.preselect?.scores[1]?.kept, true);
  assert.equal(beyondK.preselect?.scores[1]?.p, 0);
  assert.equal(beyondK.observations[1]?.answer, 'include');
  const notConsuming = select([0.99, 0.5, 0.4], { preselect_policy: policy(1), required_entry_ids: ['cap_0'] });
  assert.deepEqual(ids(notConsuming), ['cap_0', 'cap_1']);
  const probabilities = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.01, 0.8];
  const beyondCap = select(probabilities, { preselect_policy: policy(8), required_entry_ids: ['cap_8', 'MISSING_CANARY'] });
  assert.equal(beyondCap.catalogue_index.length, 9);
  assert.equal(beyondCap.catalogue_index.some(entry => entry.id === 'cap_8'), true);
  assert.equal(beyondCap.catalogue_index.some(entry => entry.id === 'cap_9'), false);
  assert.equal(beyondCap.preselect?.required_missing, 1);
  assert.equal(beyondCap.preselect?.cap, 8);
  assert.ok(beyondCap.preselect);
  assertTrace(beyondCap.preselect, probabilities);
});

test('admission failure returns the whole index, keeps required entries, and records fallback', () => {
  const probabilities = [0.99, 0.01, 0.4];
  const extra = { preselect_policy: policy(1), required_entry_ids: ['cap_1', 'MISSING_CANARY'] };
  for (const result of [
    select(probabilities, extra, .74),
    transitionBooleanSite('loop.preselect', input(probabilities, extra), { ...recorded(probabilities), observed_at: 9 }, current),
    transitionBooleanSite('loop.preselect', input(probabilities, extra), { ...recorded(probabilities), outcome: null }, current),
  ]) {
    assert.deepEqual(ids(result), ['cap_0', 'cap_1', 'cap_2']);
    assert.equal(result.preselect?.outcome, 'fallback');
    assert.equal(result.preselect?.scores.every(score => score.kept), true);
    assert.equal(result.preselect?.scores[1]?.required, true);
    assert.equal(result.preselect?.required_missing, 1);
    assert.ok(result.preselect);
    assertTrace(result.preselect, probabilities);
  }
  const missing = recorded(probabilities);
  const answers = Object.fromEntries(Object.entries(missing.outcome.answers).filter(([key]) => key !== 'entry_1'));
  const partial = transitionBooleanSite('loop.preselect', input(probabilities, extra),
    { ...missing, outcome: { ...missing.outcome, answers } }, current);
  assert.equal(partial.preselect?.outcome, 'fallback');
  assert.equal(partial.preselect?.scores[1]?.p, null);
  assert.equal(partial.preselect?.scores[1]?.rank, null);
  assert.equal(partial.preselect?.scores[1]?.kept, true);
  assert.equal(partial.observations[1]?.answer, null);
  assert.deepEqual(ids(partial), ['cap_0', 'cap_1', 'cap_2']);
  const ranked = partial.preselect?.scores.filter(score => score.p !== null).map(score => score.rank);
  assert.deepEqual(ranked, [1, 2]);
});

test('an invalid preselect policy is replaced by the defaults and still narrows', () => {
  const probabilities = [0.9, 0.8, 0.7, 0.1];
  const expected = ids(select(probabilities));
  const bad = [
    { k: 0, floor: 0, provider: 'amos' },
    { k: 9, floor: 0, provider: 'amos' },
    { k: 2.5, floor: 0, provider: 'amos' },
    { k: 1, floor: 1, provider: 'amos' },
    { k: 1, floor: -0.1, provider: 'amos' },
    { k: 1, floor: 0, provider: 'MISSING_CANARY' },
    { k: 1, floor: 0, provider: 'amos', leak: 'PURPOSE_CANARY' },
    null,
    ['k'],
  ];
  for (const preselect_policy of bad) {
    const first = select(probabilities, { preselect_policy: preselect_policy as PreselectPolicyInput });
    const second = select(probabilities, { preselect_policy: preselect_policy as PreselectPolicyInput });
    assert.deepEqual(ids(first), expected);
    assert.equal(first.preselect?.k, 3);
    assert.equal(first.preselect?.floor, 0);
    assert.equal(first.preselect?.provider, null);
    assert.deepEqual(first.preselect, second.preselect);
    assert.equal(JSON.stringify(first.preselect), JSON.stringify(second.preselect));
    assert.ok(first.preselect);
    assertTrace(first.preselect, probabilities);
  }
});

test('the selection record is present for an empty index and absent for guards', () => {
  const empty = transitionBooleanSite('loop.preselect', { ...input([]), catalogue_index: [], required_entry_ids: ['MISSING_CANARY'] },
    { state_revision: 1, observed_at: 10, outcome: null }, current);
  assert.equal(empty.preselect?.outcome, 'empty_index');
  assert.deepEqual(empty.preselect?.scores, []);
  assert.equal(empty.preselect?.kept, 0);
  assert.equal(empty.preselect?.required_missing, 1);
  assert.equal(empty.observations[0]?.reason, 'empty_index');
  assert.ok(empty.preselect);
  assertTrace(empty.preselect, []);
  for (const site of ['guard.input', 'guard.output'] as const) {
    const keys = site === 'guard.input' ? INPUT_RULES : ['decision'];
    const outcome: EvaluationOutcome<'boolean'> = {
      status: 'accepted', kind: 'boolean', site, request_id: 'r1',
      answers: Object.fromEntries(keys.map(key => [key, { type: 'boolean' as const, probability: .1 }])),
      confidence: Object.fromEntries(keys.map(key => [key, 1])),
      provider_response_id: 'provider-1', routed_unit_id: 'fixture', attempts: [], spent: 0, uncertainty: [],
    };
    const result = transitionBooleanSite(site, input([0.1]), { state_revision: 1, observed_at: 10, outcome }, current);
    assert.equal(Object.hasOwn(result, 'preselect'), false);
    assert.equal(result.status, 'transition');
  }
});
