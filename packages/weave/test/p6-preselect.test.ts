import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationOutcome } from '@weave/gateway';
import { transitionBooleanSite, evaluateBooleanSite, INPUT_RULES, type BooleanSiteInput, type PreselectPolicyInput, type PreselectSelection } from '../src/sites/boolean.js';
import type { InferenceGateway } from '@weave/gateway';

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
function recorded(probabilities: readonly number[], confidence: number | readonly (number | undefined)[] | 'missing' = 1, routed_unit_id = 'fixture') {
  const keys = probabilities.map((_, n) => `entry_${n}`);
  const confidenceMap = confidence === 'missing' ? undefined
    : typeof confidence === 'number' ? Object.fromEntries(keys.map(key => [key, confidence]))
    : Object.fromEntries(keys.flatMap((key, n) => confidence[n] === undefined ? [] : [[key, confidence[n]!]]));
  const outcome: EvaluationOutcome<'boolean'> = {
    status: 'accepted', kind: 'boolean', site: 'loop.preselect', request_id: 'r1',
    answers: Object.fromEntries(keys.map((key, n) => [key, { type: 'boolean' as const, probability: probabilities[n]! }])),
    confidence: confidenceMap,
    provider_response_id: 'provider-1', routed_unit_id, attempts: [], spent: 0, uncertainty: [],
  };
  return { state_revision: 1, observed_at: 10, outcome };
}
function select(probabilities: readonly number[], extra: Partial<BooleanSiteInput> = {}, confidence: number | readonly (number | undefined)[] | 'missing' = 1, routed_unit_id = 'fixture') {
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

test('narrowed catalogue order is required plus top-k by p descending, ties in disclosed order', () => {
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
  const dropped = select([0.04, 0.02], { preselect_policy: policy(3, 0.1) });
  assert.equal(dropped.preselect?.reason, 'weak_margin');
  assert.deepEqual(ids(dropped), ['cap_0', 'cap_1']);
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
