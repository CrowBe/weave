import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvaluationOutcome } from '@weave/gateway';
import { transitionBooleanSite, evaluateBooleanSite, INPUT_RULES, type BooleanSiteInput, type PreselectPolicyInput, type PreselectSelection } from '../src/sites/boolean.js';
import type { InferenceGateway } from '@weave/gateway';
import { FileJournal } from '../src/journal.js';
import { digest } from '../src/digest.js';
import type { Observation } from '../src/types.js';

const current = { state_revision: 1, state_updated_at: 10 };
const terms = { quality: 'baseline' as const, destinations: ['local'], max_context_tokens: 100, deadline: 100, cost_ceiling: 10, max_attempts: 1 };
function policy(k: number, floor = 0, provider: PreselectPolicyInput['provider'] = 'typesafe-jev', max_excluded = 0.4, min_margin = 0.3): PreselectPolicyInput {
  return { k, floor, max_excluded, min_margin, provider };
}
function input(probabilities: readonly number[], extra: Partial<BooleanSiteInput> = {}): BooleanSiteInput {
  return {
    ...current, request_id: 'r1', state: { text: 'STATE_CANARY' }, needs_dispatch: true, terms,
    catalogue_index: probabilities.map((_, n) => ({ id: `cap_${n}`, purpose: 'PURPOSE_CANARY' })),
    ...extra,
  };
}
function recorded(probabilities: readonly number[], confidence: number | readonly unknown[] | 'missing' = 1, routed_unit_id = 'fixture') {
  const keys = probabilities.map((_, n) => `entry_${n}`);
  const confidenceMap = confidence === 'missing' ? undefined
    : typeof confidence === 'number' ? Object.fromEntries(keys.map(key => [key, confidence]))
    : Object.fromEntries(keys.flatMap((key, n) => confidence[n] === undefined ? [] : [[key, confidence[n]]]));
  const outcome: EvaluationOutcome<'boolean'> = {
    status: 'accepted', kind: 'boolean', site: 'loop.preselect', request_id: 'r1',
    answers: Object.fromEntries(keys.map((key, n) => [key, { type: 'boolean' as const, probability: probabilities[n]! }])),
    confidence: confidenceMap as Extract<EvaluationOutcome<'boolean'>, { status: 'accepted' }>['confidence'],
    provider_response_id: 'provider-1', routed_unit_id, attempts: [], spent: 0, uncertainty: [],
  };
  return { state_revision: 1, observed_at: 10, outcome };
}
function select(probabilities: readonly number[], extra: Partial<BooleanSiteInput> = {}, confidence: number | readonly unknown[] | 'missing' = 1, routed_unit_id = 'fixture') {
  return transitionBooleanSite('loop.preselect', input(probabilities, extra), recorded(probabilities, confidence, routed_unit_id), current);
}
function ids(result: { catalogue_index: readonly { id: string }[] }) {
  return result.catalogue_index.map(entry => entry.id);
}
function assertTrace(record: PreselectSelection, probabilities: readonly number[]) {
  assert.deepEqual(Object.keys(record), ['schema', 'k', 'floor', 'cap', 'max_excluded', 'min_margin', 'policy_provider',
    'routed_unit_id', 'outcome', 'reason', 'top_p', 'best_excluded_p', 'margin', 'scores', 'kept', 'required_missing',
    'required_ids_invalid']);
  assert.equal(record.schema, 'preselect-selection@2');
  assert.equal(record.cap, 8);
  assert.equal(Object.hasOwn(record, 'provider'), false);
  assert.equal(record.routed_unit_id === null || typeof record.routed_unit_id === 'string', true);
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
  const descending = [0.95, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05, 0.02];
  assert.deepEqual(ids(select(descending, { preselect_policy: policy(3) })), ['cap_0', 'cap_1', 'cap_2']);
  assert.deepEqual(ids(select(descending)), ['cap_0', 'cap_1', 'cap_2']);
  assert.deepEqual(ids(select(descending, { preselect_policy: policy(1) })), ['cap_0']);
  assert.deepEqual(ids(select([0.9, 0.4, 0.4], { preselect_policy: policy(2) })), ['cap_0', 'cap_1']);
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
  assert.equal(result.preselect?.policy_provider, 'amos');
  assert.equal(result.preselect?.routed_unit_id, 'fixture');
  assert.equal(result.preselect?.outcome, 'narrowed');
});

test('a score exactly equal to the floor is kept', () => {
  const result = select([0.9, 0.5, 0.3], { preselect_policy: policy(3, 0.5) });
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

test('kept union ordered by p descending, ties in disclosed order', () => {
  const probabilities = [0.7, 0.7, 0.95, 0.4, 0.1];
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
  const notConsuming = select([0.99, 0.8, 0.4], { preselect_policy: policy(1), required_entry_ids: ['cap_0'] });
  assert.deepEqual(ids(notConsuming), ['cap_0', 'cap_1']);
  const probabilities = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.01, 0.2];
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
  const stale = transitionBooleanSite('loop.preselect', input(probabilities, extra), { ...recorded(probabilities), observed_at: 9 }, current);
  const outage = transitionBooleanSite('loop.preselect', input(probabilities, extra), { ...recorded(probabilities), outcome: null }, current);
  const cancelled = transitionBooleanSite('loop.preselect', input(probabilities, extra), { ...recorded(probabilities), cancelled: true }, current);
  for (const result of [stale, outage, cancelled]) {
    assert.deepEqual(ids(result), ['cap_0', 'cap_1', 'cap_2']);
    assert.equal(result.preselect?.outcome, 'fallback');
    assert.equal(result.preselect?.reason, 'admission');
    assert.equal(result.preselect?.top_p, null);
    assert.equal(result.preselect?.margin, null);
    assert.equal(result.preselect?.scores.every(score => score.kept), true);
    assert.equal(result.preselect?.scores[1]?.required, true);
    assert.equal(result.preselect?.required_missing, 1);
    assert.ok(result.preselect);
    assertTrace(result.preselect, probabilities);
  }
  assert.equal(stale.preselect?.routed_unit_id, 'fixture');
  assert.equal(outage.preselect?.routed_unit_id, null);
  assert.equal(cancelled.status, 'paused');
  assert.equal(cancelled.observations[0]?.reason, 'cancelled');
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
    { k: 3, floor: 0, provider: 'amos', max_excluded: 1.1, min_margin: 0.3 },
    { k: 3, floor: 0, provider: 'amos', max_excluded: 0.4, min_margin: -0.01 },
    { k: 3, floor: 0, provider: 'amos', max_excluded: 0.4 },
    null,
    ['k'],
  ];
  for (const preselect_policy of bad) {
    const first = select(probabilities, { preselect_policy: preselect_policy as PreselectPolicyInput });
    const second = select(probabilities, { preselect_policy: preselect_policy as PreselectPolicyInput });
    assert.deepEqual(ids(first), expected);
    assert.equal(first.preselect?.k, 3);
    assert.equal(first.preselect?.floor, 0);
    assert.equal(first.preselect?.policy_provider, null);
    assert.equal(first.preselect?.max_excluded, 0.4);
    assert.equal(first.preselect?.min_margin, 0.3);
    assert.equal(first.preselect?.reason, null);
    assert.equal(first.preselect?.outcome, 'narrowed');
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

test('a strong margin narrows when no confidence is published, and the boundary values are inclusive', () => {
  const open = select([0.9, 0.8, 0.7, 0.2], { preselect_policy: policy(3) }, 'missing');
  assert.deepEqual(ids(open), ['cap_0', 'cap_1', 'cap_2']);
  assert.equal(open.preselect?.outcome, 'narrowed');
  assert.equal(open.preselect?.reason, null);
  assert.equal(open.preselect?.top_p, 0.9);
  assert.equal(open.preselect?.best_excluded_p, 0.2);
  assert.equal(open.preselect?.margin, 0.7);
  assert.deepEqual(open.observations.slice(0, 4).map(observation => observation.reason), ['accepted', 'accepted', 'accepted', 'accepted']);
  assert.ok(open.observations.slice(0, 4).every(observation => observation.accepted && !observation.fallback_used && observation.confidence === null));
  const both = select([0.7, 0.4], { preselect_policy: policy(1) });
  assert.deepEqual(ids(both), ['cap_0']);
  assert.equal(both.preselect?.outcome, 'narrowed');
  assert.equal(both.preselect?.best_excluded_p, 0.4);
  assert.equal(both.preselect?.margin, 0.3);
  assert.equal(both.preselect?.max_excluded, 0.4);
  assert.equal(both.preselect?.min_margin, 0.3);
  const ceiling = select([0.9, 0.4], { preselect_policy: policy(1) });
  assert.deepEqual(ids(ceiling), ['cap_0']);
  assert.equal(ceiling.preselect?.margin, 0.5);
});

test('a weak margin returns the full index and does not blame a missing confidence', () => {
  const above = select([0.9, 0.41], { preselect_policy: policy(1) }, 'missing');
  assert.deepEqual(ids(above), ['cap_0', 'cap_1']);
  assert.equal(above.preselect?.outcome, 'fallback');
  assert.equal(above.preselect?.reason, 'weak_margin');
  assert.equal(above.preselect?.best_excluded_p, 0.41);
  assert.equal(above.preselect?.top_p, 0.9);
  assert.ok(above.observations.every(observation => observation.reason === 'accepted' && observation.accepted && !observation.fallback_used));
  assert.ok(above.preselect?.scores.every(score => score.kept));
  const tight = select([0.69, 0.4], { preselect_policy: policy(1) });
  assert.deepEqual(ids(tight), ['cap_0', 'cap_1']);
  assert.equal(tight.preselect?.reason, 'weak_margin');
  assert.equal(tight.preselect?.best_excluded_p, 0.4);
  assert.equal(tight.preselect?.margin, 0.29);
});

test('published low confidence blocks only the boundary of the candidate slice', () => {
  const keptLow = select([0.9, 0.8, 0.7, 0.2], { preselect_policy: policy(3) }, [1, 1, 0.74, 1]);
  assert.equal(keptLow.preselect?.reason, 'low_confidence');
  assert.equal(keptLow.preselect?.outcome, 'fallback');
  assert.deepEqual(ids(keptLow), ['cap_0', 'cap_1', 'cap_2', 'cap_3']);
  assert.equal(keptLow.observations[2]?.reason, 'low_confidence');
  assert.equal(keptLow.observations[2]?.accepted, false);
  assert.equal(keptLow.observations[2]?.fallback_used, true);
  assert.equal(keptLow.observations[0]?.reason, 'accepted');
  const excludedLow = select([0.9, 0.8, 0.7, 0.2], { preselect_policy: policy(3) }, [1, 1, 1, 0.74]);
  assert.equal(excludedLow.preselect?.reason, 'low_confidence');
  assert.equal(excludedLow.observations[3]?.reason, 'low_confidence');
  const elsewhere = select([0.9, 0.8, 0.7, 0.2, 0.1], { preselect_policy: policy(3) }, [1, 1, 1, 1, 0.1]);
  assert.deepEqual(ids(elsewhere), ['cap_0', 'cap_1', 'cap_2']);
  assert.equal(elsewhere.preselect?.outcome, 'narrowed');
  assert.equal(elsewhere.preselect?.reason, null);
  assert.equal(elsewhere.observations[4]?.reason, 'accepted');
  assert.equal(elsewhere.observations[4]?.confidence, 0.1);
  assert.equal(elsewhere.observations[4]?.answer, 'exclude');
  const tied = select([0.9, 0.4, 0.4], { preselect_policy: policy(1) }, [1, 1, 0.1]);
  assert.deepEqual(ids(tied), ['cap_0']);
  assert.equal(tied.preselect?.reason, null);
  const tiedBoundary = select([0.9, 0.4, 0.4], { preselect_policy: policy(1) }, [1, 0.1, 1]);
  assert.equal(tiedBoundary.preselect?.reason, 'low_confidence');
  const requiredLow = select([0.95, 0.9, 0.2], { preselect_policy: policy(1), required_entry_ids: ['cap_0'] }, [0.1, 1, 1]);
  assert.deepEqual(ids(requiredLow), ['cap_0', 'cap_1']);
  assert.equal(requiredLow.preselect?.top_p, 0.9);
  assert.equal(requiredLow.observations[0]?.reason, 'accepted');
  assert.equal(requiredLow.preselect?.scores[0]?.required, true);
  const inclusive = select([0.9, 0.2], { preselect_policy: policy(1) }, 0.75);
  assert.deepEqual(ids(inclusive), ['cap_0']);
  assert.equal(inclusive.observations[0]?.reason, 'accepted');
});

test('nothing excluded keeps the index without applying the margin or confidence gate', () => {
  const short = select([0.2, 0.9], { preselect_policy: policy(3) }, 0.1);
  assert.deepEqual(ids(short), ['cap_1', 'cap_0']);
  assert.equal(short.preselect?.outcome, 'narrowed');
  assert.equal(short.preselect?.reason, null);
  assert.equal(short.preselect?.best_excluded_p, null);
  assert.equal(short.preselect?.margin, null);
  assert.equal(short.preselect?.top_p, 0.9);
  assert.ok(short.observations.every(observation => observation.reason === 'accepted' && observation.confidence === 0.1));
  const covered = select([0.4, 0.2, 0.1], { preselect_policy: policy(2), required_entry_ids: ['cap_2'] }, 0.2);
  assert.deepEqual(ids(covered), ['cap_0', 'cap_1', 'cap_2']);
  assert.equal(covered.preselect?.best_excluded_p, null);
  assert.equal(covered.preselect?.outcome, 'narrowed');
});

test('a routed unit id that starts with bearer is recorded; a real token marker is omitted (#158)', () => {
  for (const id of ['bearer_unit', 'Bearer-1', 'bearer.jev@1.14']) assert.equal(select([0.9, 0.1], {}, 1, id).preselect?.routed_unit_id, id, id);
  for (const id of ['Bearer abc', 'sk-abc', 'ghp_abc', 'github_pat_abc', 'eyJhbGci', 'AKIAABC']) {
    assert.equal(select([0.9, 0.1], {}, 1, id).preselect?.routed_unit_id, null, id);
  }
});

test('a configured margin replaces the defaults, and the record names the routed unit without leaking it', () => {
  const loose = select([0.9, 0.5], { preselect_policy: policy(1, 0, 'amos', 0.5, 0.3) });
  assert.deepEqual(ids(loose), ['cap_0']);
  assert.equal(loose.preselect?.max_excluded, 0.5);
  assert.equal(loose.preselect?.min_margin, 0.3);
  assert.equal(loose.preselect?.policy_provider, 'amos');
  assert.equal(loose.preselect?.reason, null);
  const strict = select([0.9, 0.5], { preselect_policy: policy(1, 0, 'amos', 0.4, 0.3) });
  assert.equal(strict.preselect?.reason, 'weak_margin');
  assert.deepEqual(ids(strict), ['cap_0', 'cap_1']);
  const named = select([0.9, 0.2], { preselect_policy: policy(1) }, 1, 'boolean@vercel');
  assert.equal(named.preselect?.routed_unit_id, 'boolean@vercel');
  const secret = select([0.9, 0.2], { preselect_policy: policy(1) }, 1, 'sk-secret-key');
  assert.equal(secret.preselect?.routed_unit_id, null);
  const trace = JSON.stringify(secret.preselect);
  assert.equal(trace.includes('sk-'), false);
  assert.equal(trace.includes('PURPOSE_CANARY'), false);
  assert.equal(trace.includes('cap_'), false);
  const again = select([0.9, 0.2], { preselect_policy: policy(1) }, 1, 'boolean@vercel');
  assert.deepEqual(named.preselect, again.preselect);
});

test('untyped required_entry_ids do not throw and are not treated as required ids', async () => {
  const probabilities = [0.9, 0.2, 0.05];
  const base = input(probabilities, { preselect_policy: policy(1) });
  const port = { evaluate: async () => recorded(probabilities).outcome } as Pick<InferenceGateway, 'evaluate'>;
  const now = () => ({ ...current, observed_at: 10 });
  for (const required_entry_ids of [7, 'cap_1', { length: 1 }, null, [1, { id: 'cap_1' }]]) {
    const result = await evaluateBooleanSite('loop.preselect', { ...base, required_entry_ids } as BooleanSiteInput, port, now);
    assert.deepEqual(ids(result), ['cap_0']);
    assert.equal(result.preselect?.required_ids_invalid, true);
    assert.equal(result.preselect?.scores[1]?.required, false);
    assert.equal(result.preselect?.required_missing, 0);
    assert.equal(JSON.stringify(result.preselect).includes('cap_'), false);
  }
  const mixed = await evaluateBooleanSite('loop.preselect', { ...base, required_entry_ids: ['cap_1', 1] } as BooleanSiteInput, port, now);
  assert.deepEqual(ids(mixed), ['cap_0', 'cap_1']);
  assert.equal(mixed.preselect?.required_ids_invalid, true);
  assert.equal(mixed.preselect?.scores[1]?.required, true);
  assert.equal(mixed.preselect?.scores[1]?.kept, true);
  const clean = await evaluateBooleanSite('loop.preselect', { ...base, required_entry_ids: ['cap_1', 'cap_1'] }, port, now);
  assert.equal(clean.preselect?.required_ids_invalid, false);
  assert.equal(clean.preselect?.scores[1]?.required, true);
  assert.deepEqual(ids(clean), ['cap_0', 'cap_1']);
  const direct = transitionBooleanSite('loop.preselect', { ...base, required_entry_ids: 'cap_1' as unknown as readonly string[] }, recorded(probabilities), current);
  assert.equal(direct.preselect?.required_ids_invalid, true);
  assert.deepEqual(ids(direct), ['cap_0']);
});

test('a published invalid confidence fails closed on any entry; an absent one stays unknown', () => {
  const probabilities = [0.9, 0.8, 0.7, 0.2, 0.1];
  const boundary = [0, 3];
  const offBoundary = 4;
  for (const bad of [60, -1, Number.NaN, '60', null]) {
    for (const index of [...boundary, offBoundary]) {
      const confidence = [1, 1, 1, 1, 1] as unknown[];
      confidence[index] = bad;
      const result = select(probabilities, { preselect_policy: policy(3) }, confidence);
      assert.equal(result.preselect?.reason, 'invalid_confidence');
      assert.equal(result.preselect?.outcome, 'fallback');
      assert.deepEqual(ids(result), ['cap_0', 'cap_1', 'cap_2', 'cap_3', 'cap_4']);
      assert.equal(result.preselect?.top_p, 0.9);
      assert.equal(result.preselect?.best_excluded_p, 0.2);
      assert.equal(result.preselect?.margin, 0.7);
      for (const [n, observation] of result.observations.entries()) {
        assert.equal(observation.reason, n === index ? 'invalid_confidence' : 'accepted');
        assert.equal(observation.accepted, n !== index);
        assert.equal(observation.fallback_used, n === index);
      }
      assert.equal(result.observations[index]?.confidence, null);
      assert.ok(result.preselect);
      assertTrace(result.preselect, probabilities);
    }
  }
  const absent = select(probabilities, { preselect_policy: policy(3) }, [1, undefined, 1, 1, 1]);
  assert.equal(absent.preselect?.outcome, 'narrowed');
  assert.equal(absent.preselect?.reason, null);
  assert.deepEqual(ids(absent), ['cap_0', 'cap_1', 'cap_2']);
  assert.equal(absent.observations[1]?.confidence, null);
  assert.equal(absent.observations[1]?.reason, 'accepted');
  const covered = select([0.9, 0.2], { preselect_policy: policy(3) }, [Number.NaN, 1]);
  assert.equal(covered.preselect?.reason, 'invalid_confidence');
  assert.equal(covered.preselect?.outcome, 'fallback');
  assert.equal(covered.preselect?.best_excluded_p, null);
  assert.deepEqual(ids(covered), ['cap_0', 'cap_1']);
  assert.equal(covered.observations[0]?.reason, 'invalid_confidence');
  assert.equal(covered.observations[1]?.reason, 'accepted');
  const requiredInvalid = select([0.95, 0.9, 0.2], { preselect_policy: policy(1), required_entry_ids: ['cap_0'] }, [60, 1, 1]);
  assert.equal(requiredInvalid.preselect?.reason, 'invalid_confidence');
  assert.deepEqual(ids(requiredInvalid), ['cap_0', 'cap_1', 'cap_2']);
  assert.equal(requiredInvalid.observations[0]?.reason, 'invalid_confidence');
  assert.equal(requiredInvalid.observations[1]?.reason, 'accepted');
  const weakAndInvalid = select([0.9, 0.5], { preselect_policy: policy(1) }, [60, 1]);
  assert.equal(weakAndInvalid.preselect?.reason, 'invalid_confidence');
  const base = recorded(probabilities, [60, 1, 1, 1, 1]);
  assert.equal(base.outcome.status, 'accepted');
  const answers = Object.fromEntries(Object.entries(base.outcome.answers).filter(([key]) => key !== 'entry_4'));
  const partial = transitionBooleanSite('loop.preselect', input(probabilities, { preselect_policy: policy(3) }),
    { ...base, outcome: { ...base.outcome, answers } }, current);
  assert.equal(partial.preselect?.reason, 'admission');
  const again = select(probabilities, { preselect_policy: policy(3) }, [60, 1, 1, 1, 1]);
  assert.deepEqual(again.preselect, select(probabilities, { preselect_policy: policy(3) }, [60, 1, 1, 1, 1]).preselect);
  const invalidAndEmpty = select([0.04, 0.02], { preselect_policy: policy(3, 0.1) }, [60, 1]);
  assert.equal(invalidAndEmpty.preselect?.reason, 'invalid_confidence');
});

test('each invalid confidence has its own observation marker while valid entries stay accepted', () => {
  const result = select([0.9, 0.8, 0.7, 0.2, 0.1], { preselect_policy: policy(3) }, [Number.NaN, 1, -1, 1, 60]);
  assert.equal(result.preselect?.reason, 'invalid_confidence');
  assert.deepEqual(ids(result), ['cap_0', 'cap_1', 'cap_2', 'cap_3', 'cap_4']);
  assert.deepEqual(result.observations.map(observation => observation.reason),
    ['invalid_confidence', 'accepted', 'invalid_confidence', 'accepted', 'invalid_confidence']);
  assert.deepEqual(result.observations.map(observation => observation.confidence), [null, 1, null, 1, null]);
  assert.deepEqual(result.observations.map(observation => observation.accepted), [false, true, false, true, false]);
  assert.deepEqual(result.observations.map(observation => observation.fallback_used), [true, false, true, false, true]);
  for (const observation of result.observations) {
    assert.equal(observation.schema, 'decision-site@1');
    assert.deepEqual(Object.keys(observation), ['schema', 'site', 'question', 'request_id', 'state_revision',
      'answer', 'confidence', 'top_p', 'accepted', 'fallback_used', 'reason', 'provider_request_id']);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('journal and digest readers preserve historical D3 observations alongside invalid confidence markers', () => {
  // A pre-change observation could not distinguish invalid from absent confidence.
  const historical = {
    schema: 'decision-site@1', site: 'loop.preselect', question: 'Is this disclosed catalogue entry relevant to this step?',
    request_id: 'r1', state_revision: 1, answer: 'include', confidence: null, top_p: 0.9,
    accepted: true, fallback_used: false, reason: 'accepted', provider_request_id: 'provider-1',
  };
  const envelope = (seq: number, payload: unknown): Observation => ({
    observation_id: `o${seq}`, source: { kind: 'test', id: 'fixture' }, caused_by: null,
    payload_type: 'decision-site', payload_version: 1, payload, seq, validation: { status: 'unknown_type' },
  });
  const legacy = envelope(1, historical);
  const before = digest(legacy);
  const directory = mkdtempSync(join(tmpdir(), 'weave-d3-replay-'));
  try {
    const path = join(directory, 'observations.jsonl');
    writeFileSync(path, `${JSON.stringify(legacy)}\n`);
    const marker = select([0.9, 0.1], { preselect_policy: policy(1) }, [60, 1]).observations[0]!;
    assert.equal(marker.reason, 'invalid_confidence');
    const latest = envelope(2, marker);
    new FileJournal(path).persist(latest);
    const reloaded = new FileJournal(path).snapshot();
    assert.deepEqual(reloaded, [legacy, latest]);
    assert.equal(digest(reloaded[0]), before);
    assert.equal(digest(reloaded[1]), digest(latest));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a floor that keeps no non-required entry is no_candidate, with or without required entries', () => {
  const none = select([0.04, 0.02], { preselect_policy: policy(3, 0.1) });
  assert.equal(none.preselect?.reason, 'no_candidate');
  assert.equal(none.preselect?.outcome, 'fallback');
  assert.equal(none.preselect?.top_p, null);
  assert.equal(none.preselect?.margin, null);
  assert.equal(none.preselect?.best_excluded_p, 0.04);
  assert.deepEqual(ids(none), ['cap_0', 'cap_1']);
  assert.ok(none.preselect?.scores.every(score => score.kept && !score.required));
  assert.ok(none.observations.every(observation => observation.reason === 'accepted' && observation.accepted && !observation.fallback_used));
  assert.ok(none.preselect);
  assertTrace(none.preselect, [0.04, 0.02]);
  const required = select([0.99, 0.04, 0.02], { preselect_policy: policy(3, 0.1), required_entry_ids: ['cap_0'] });
  assert.equal(required.preselect?.reason, 'no_candidate');
  assert.equal(required.preselect?.outcome, 'fallback');
  assert.equal(required.preselect?.top_p, null);
  assert.equal(required.preselect?.margin, null);
  assert.equal(required.preselect?.best_excluded_p, 0.04);
  assert.equal(required.preselect?.scores[0]?.required, true);
  assert.equal(required.preselect?.scores[0]?.kept, true);
  assert.deepEqual(ids(required), ['cap_0', 'cap_1', 'cap_2']);
  assert.ok(required.observations.every(observation => observation.reason === 'accepted' && observation.accepted && !observation.fallback_used));
  const kept = select([0.9, 0.04, 0.5], { preselect_policy: policy(3, 0.1) });
  assert.equal(kept.preselect?.reason, null);
  assert.equal(kept.preselect?.outcome, 'narrowed');
  assert.deepEqual(ids(kept), ['cap_0', 'cap_2']);
  const onlyRequired = select([0.01, 0.02], { preselect_policy: policy(1, 0.5), required_entry_ids: ['cap_0', 'cap_1'] });
  assert.equal(onlyRequired.preselect?.reason, null);
  assert.equal(onlyRequired.preselect?.outcome, 'narrowed');
  assert.equal(onlyRequired.preselect?.top_p, null);
  assert.equal(onlyRequired.preselect?.best_excluded_p, null);
  assert.deepEqual(ids(onlyRequired), ['cap_1', 'cap_0']);
});

test('recorded probabilities use +0 where a score was -0', () => {
  const result = select([-0, 0], { preselect_policy: policy(1) });
  assert.equal(result.preselect?.outcome, 'fallback');
  assert.equal(result.preselect?.reason, 'weak_margin');
  assert.equal(Object.is(result.preselect?.top_p, 0), true);
  assert.equal(Object.is(result.preselect?.best_excluded_p, 0), true);
  assert.equal(Object.is(result.preselect?.margin, 0), true);
  assert.equal(Object.is(result.preselect?.scores[0]?.p, 0), true);
  assert.equal(Object.is(result.preselect?.scores[1]?.p, 0), true);
  assert.equal(Object.is(result.observations[0]?.top_p, 0), true);
  assert.equal(Object.is(result.observations[1]?.top_p, 0), true);
  assert.ok(result.preselect);
  assertTrace(result.preselect, [-0, 0]);
});

test('max_excluded and min_margin accept exactly 0 and exactly 1', () => {
  const ceilingZero = select([0.5, 0], { preselect_policy: policy(1, 0, 'amos', 0, 0) });
  assert.equal(ceilingZero.preselect?.outcome, 'narrowed');
  assert.equal(ceilingZero.preselect?.max_excluded, 0);
  assert.equal(ceilingZero.preselect?.min_margin, 0);
  assert.equal(ceilingZero.preselect?.best_excluded_p, 0);
  assert.deepEqual(ids(ceilingZero), ['cap_0']);
  const aboveZero = select([1, 0.01], { preselect_policy: policy(1, 0, 'amos', 0, 0) });
  assert.equal(aboveZero.preselect?.reason, 'weak_margin');
  assert.deepEqual(ids(aboveZero), ['cap_0', 'cap_1']);
  const gapZero = select([0.4, 0.4], { preselect_policy: policy(1, 0, 'amos', 0.4, 0) });
  assert.equal(gapZero.preselect?.outcome, 'narrowed');
  assert.equal(gapZero.preselect?.margin, 0);
  assert.equal(gapZero.preselect?.min_margin, 0);
  assert.deepEqual(ids(gapZero), ['cap_0']);
  const bothOne = select([1, 0], { preselect_policy: policy(1, 0, 'amos', 1, 1) });
  assert.equal(bothOne.preselect?.outcome, 'narrowed');
  assert.equal(bothOne.preselect?.max_excluded, 1);
  assert.equal(bothOne.preselect?.min_margin, 1);
  assert.equal(bothOne.preselect?.margin, 1);
  assert.equal(bothOne.preselect?.best_excluded_p, 0);
  assert.deepEqual(ids(bothOne), ['cap_0']);
  const shortOfOne = select([1, 0.01], { preselect_policy: policy(1, 0, 'amos', 1, 1) });
  assert.equal(shortOfOne.preselect?.reason, 'weak_margin');
  assert.equal(shortOfOne.preselect?.max_excluded, 1);
  assert.equal(shortOfOne.preselect?.margin, 0.99);
  const ceilingOne = select([1, 0.7], { preselect_policy: policy(1, 0, 'amos', 1, 0.3) });
  assert.equal(ceilingOne.preselect?.outcome, 'narrowed');
  assert.equal(ceilingOne.preselect?.max_excluded, 1);
  assert.equal(ceilingOne.preselect?.best_excluded_p, 0.7);
  assert.deepEqual(ids(ceilingOne), ['cap_0']);
  const marginHolds = select([0.9, 0.8], { preselect_policy: policy(1, 0, 'amos', 1, 0.3) });
  assert.equal(marginHolds.preselect?.reason, 'weak_margin');
  assert.equal(marginHolds.preselect?.best_excluded_p, 0.8);
});

// #96: under the old include-if-p>=.5 rule, confident answers all below .5 removed every capability.
// Top-k never drops an entry for a low p(true) alone, and a nonempty index never yields an empty slice.
test('confident answers that are all below .5 never empty a nonempty index', () => {
  const narrowed = select([0.45, 0.4, 0.35, 0.01]);
  assert.equal(narrowed.status, 'transition');
  assert.equal(narrowed.preselect?.outcome, 'narrowed');
  assert.deepEqual(ids(narrowed), ['cap_0', 'cap_1', 'cap_2']);
  const close = select([0.3, 0.2, 0.1, 0.05]);
  assert.equal(close.preselect?.reason, 'weak_margin');
  assert.deepEqual(ids(close), ['cap_0', 'cap_1', 'cap_2', 'cap_3']);
  const floored = select([0.45, 0.4, 0.01], { preselect_policy: policy(3, 0.5) });
  assert.equal(floored.preselect?.reason, 'no_candidate');
  assert.deepEqual(ids(floored), ['cap_0', 'cap_1', 'cap_2']);
  const distributions = [[0.49], [0.49, 0.49], [0.3, 0.2, 0.1, 0.05], [0.45, 0.4, 0.35, 0.01, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0.49, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]];
  for (const probabilities of distributions) for (let k = 1; k <= 8; k++) for (const floor of [0, 0.25, 0.49, 0.5, 0.9]) {
    for (const [max_excluded, min_margin] of [[0.4, 0.3], [0, 0], [1, 1]] as const) {
      const result = select(probabilities, { preselect_policy: policy(k, floor, 'typesafe-jev', max_excluded, min_margin) });
      const label = `k=${k} floor=${floor} margins=${max_excluded}/${min_margin} p=${probabilities.join(',')}`;
      assert.equal(result.status, 'transition', label);
      assert.ok(result.catalogue_index.length > 0, label);
      assert.notEqual(result.preselect?.outcome, 'empty_index', label);
      // A fallback returns the whole index; a narrowed slice holds at least one kept entry.
      if (result.preselect?.outcome === 'fallback') assert.equal(result.catalogue_index.length, probabilities.length, label);
    }
  }
});
