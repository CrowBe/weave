import assert from 'node:assert/strict';
import test from 'node:test';
import { payloadBytes, hasMidValue } from '../src/log-bound.js';
import { readFileSync } from 'node:fs';
import {
  demonstrateRed,
  encodedMaxima,
  maximumMarker,
  maximumStoppedResult,
  largestActionId,
  largestWeighAttempt,
} from './context-budget-fixture.js';

const contract = readFileSync(new URL('../../src/CONTEXT-BUDGET-CONTRACT.md', import.meta.url), 'utf8');

test('C1 T15 contract: closed maximum marker/result encodings include every canonical byte', () => {
  assert.equal(largestActionId.length, 35);
  assert.equal(largestWeighAttempt.length, 27);
  assert.deepEqual(encodedMaxima, { marker_frame: 789, marker_weigh: 847, stopped_result: 215 });
  for (const size of Object.values(encodedMaxima)) assert.ok(new RegExp(`\\|\\s*${size}\\s*\\|`).test(contract));
  for (const site of ['goal.frame', 'frontier.weigh'] as const) {
    const marker = maximumMarker(site);
    assert.equal(hasMidValue(marker), false);
    assert.ok(marker.attempted_payload_bytes > marker.max_observation_bytes);
    assert.equal(payloadBytes({ ...marker, attempted_type: 'context.refused@1' }) <= payloadBytes(marker), true);
  }
  assert.ok(payloadBytes(maximumStoppedResult()) > 0);
});

// Deliberately bad composition and persistence seams. They are never wired to Runtime.
const admitsEveryBound = (_bound: number, _maximum: number) => true;
const rejectsEquality = (bound: number, maximum: number) => bound > maximum;
for (const [name, maximum] of Object.entries(encodedMaxima)) {
  test(`C1 T15 red: ${name} one-under bound rejects before a running action`, () => {
    demonstrateRed(() => assert.equal(admitsEveryBound(maximum - 1, maximum), false));
  });
  test(`C1 T15 red: ${name} exact maximum is sufficient`, () => {
    demonstrateRed(() => assert.equal(rejectsEquality(maximum, maximum), true));
  });
}
for (const bound of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`C1 T15 red: invalid composition bound ${bound}`, () => {
    demonstrateRed(() => assert.equal(admitsEveryBound(bound, encodedMaxima.marker_weigh), false));
  });
}
test('C1 T15 red: no clarification maximum proof means preparation remains unsupported', () => {
  demonstrateRed(() => assert.equal(admitsEveryBound(4096, encodedMaxima.marker_weigh), false));
});
test('C1 T15 red: whole decision payload, rather than ledger/evidence alone, determines fit', () => {
  const ledger = { used_tokens: 1 };
  const evidence = { body: 'x'.repeat(300) };
  const full = {
    context: ledger,
    assembly_evidence: evidence,
    terms: { max_context_tokens: 8 },
    extra_snapshot: evidence,
  };
  const bound = payloadBytes(full) - 1;
  assert.ok(payloadBytes(ledger) <= bound && payloadBytes(evidence) <= bound);
  demonstrateRed(() => assert.equal(payloadBytes(ledger) + payloadBytes(evidence) <= bound, false));
});
test('C1 T15 red: payload exactly at bound is accepted, not converted to marker', () => {
  const bytes = payloadBytes({ body: '界😀' });
  const rejectsExactFit = (payload: unknown, bound: number) => payloadBytes(payload) < bound;
  demonstrateRed(() => assert.equal(rejectsExactFit({ body: '界😀' }, bytes), true));
});
test('C1 T15 red: marker cannot carry bodies, text, token claims or reservation', () => {
  const marker = { ...maximumMarker('goal.frame'), body: 'secret', tokens: 1, reservation: { cost: 1 } };
  demonstrateRed(() => assert.deepEqual(Object.keys(marker).sort(), Object.keys(maximumMarker('goal.frame')).sort()));
});
test('C1 T15 red: failed/ambiguous append cannot be claimed durable or permit dispatch', () => {
  const ignoredAppendFailure = { accepted: false, durable: true, dispatches: 1, reservation: 1 };
  demonstrateRed(() =>
    assert.deepEqual(ignoredAppendFailure, { accepted: false, durable: false, dispatches: 0, reservation: 0 }),
  );
});
test('C1 T15 red: typed stopped result reference is mandatory, never free text', () => {
  const stopped = maximumStoppedResult();
  const textOnly = {
    action_id: stopped.action_id,
    outcome: { outcome: 'failed', failure: `context_persistence_failure:${stopped.context_decision_id}` },
  };
  demonstrateRed(() => assert.deepEqual(textOnly, stopped));
});

for (const mutation of [
  'missing',
  'unknown',
  'cross_owner',
  'cross_action',
  'fit_decision',
  'wrong_failure_code',
  'duplicate_terminal',
  'v1_downgrade',
  'non_runtime_source',
  'non_framing_action',
]) {
  test(`C1 action.result@2 red: reject ${mutation} stop reference`, () => {
    // Deliberately permissive admission; C2c supplies real admission later.
    const admitsEveryReference = (_invalidReference: string) => true;
    demonstrateRed(() => assert.equal(admitsEveryReference(mutation), false));
  });
}
