import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordDigest, validate, type Context } from '@weave/gauge';

/**
 * G3: success is governed independently of the subject under test. A result
 * binds only to a recorded revision, and only the governor can record a new
 * one, so a candidate-side change cannot alter criteria or held-out sets.
 */

type Rec = Record<string, unknown>;
interface Fixtures {
  readonly context: Context;
  readonly valid: readonly { readonly name: string; readonly record: Rec }[];
}

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/records.json', import.meta.url), 'utf8')) as Fixtures;
const { context } = fixtures;
const C1 = 'decision-sites.criteria@1';
const C2 = 'decision-sites.criteria@2';
const CASES = 'decision-sites.cases@1';

const clone = <T>(x: T): T => structuredClone(x);
const record = (name: string): Rec => {
  const found = fixtures.valid.find(v => v.name === name);
  assert.ok(found, name);
  return found.record;
};
const criteria = (name: string) => clone(context.criteria[name]) as Rec & { constraints: Rec[] };
const result = (id: string) => clone(context.results[id]) as Rec;
const revision = (name: string) => clone(context.revisions[name]) as Rec;
const reason = (value: unknown, ctx: Context = context) => {
  const verdict = validate(value, ctx);
  return verdict.ok ? 'ok' : verdict.reason;
};
const withEntries = (ctx: Context, key: keyof Context, entries: Readonly<Record<string, unknown>>): Context =>
  ({ ...ctx, [key]: { ...ctx[key], ...entries } });

/** res-cheap re-asserted as meeting a bar it misses under decision-sites.criteria@1. */
const cheapClaimingBar = { ...result('res-cheap'), constraints: [
  { constraint: 'accuracy_bar', status: 'held' }, { constraint: 'cost_cap', status: 'held' },
], verdict: 'meets_bar' };

test('every revision in the fixture context is recorded, except the set edited after recording', () => {
  for (const [name, entry] of Object.entries(context.revisions)) {
    assert.equal(reason(entry), name === 'decision-sites.edited@1' ? 'binding' : 'ok', name);
  }
});

test('a context without revisions records nothing, and fails closed', () => {
  const { revisions: _none, ...bare } = context;
  assert.equal(reason(result('res-base'), bare as unknown as Context), 'binding');
  assert.equal(reason(revision(C2), bare as unknown as Context), 'binding');
});

test('recordDigest is canonical: key order does not matter, content does', () => {
  const set = criteria(C1);
  const reordered = Object.fromEntries(Object.entries(set).reverse());
  assert.equal(recordDigest(reordered), recordDigest(set));
  assert.equal(recordDigest(set), revision(C1).digest);
  assert.match(recordDigest(set), /^sha256:[0-9a-f]{64}$/);
  set.constraints[0]!.bound = 0.6;
  assert.notEqual(recordDigest(set), revision(C1).digest);
});

test('editing a recorded criteria set in place unbinds everything that cites it', () => {
  assert.equal(reason(cheapClaimingBar), 'constraint');
  const lowered = criteria(C1);
  lowered.constraints[0]!.bound = 0.6;
  const ctx = withEntries(context, 'criteria', { [C1]: lowered });
  // Under the lowered bar the claim recomputes, but the bar is not the recorded one.
  assert.equal(reason(cheapClaimingBar, ctx), 'binding');
  assert.equal(reason(result('res-base'), ctx), 'binding');
  assert.equal(reason(record('a comparison where the candidate is better'), ctx), 'binding');
  assert.equal(reason(record('a deterministic routing attribution'), ctx), 'binding');
  assert.equal(reason(revision(C1), ctx), 'binding');
});

test('a candidate cannot issue a revision of its own criteria', () => {
  const lowered = { ...criteria(C1), criteria: C2 };
  lowered.constraints[0]!.bound = 0.6;
  const issued = {
    ...revision(C2), digest: recordDigest(lowered), justification: 'bar_lowered',
    issued_by: { kind: 'policy', ref: 'optimiser-2' },
  };
  const ctx = withEntries(withEntries(context, 'criteria', { [C2]: lowered }), 'revisions', { [C2]: issued });
  assert.equal(reason(issued, ctx), 'governance');
  assert.equal(reason({ ...cheapClaimingBar, criteria: C2 }, ctx), 'binding');

  // A policy under test issuing its own revision is refused the same way.
  const selfIssued = { ...issued, issued_by: { kind: 'policy', ref: 'routing-policy-9' } };
  const policyResult = { ...cheapClaimingBar, criteria: C2, subject: { kind: 'policy', ref: 'routing-policy-9' } };
  const selfCtx = withEntries(ctx, 'revisions', { [C2]: selfIssued });
  assert.equal(reason(selfIssued, selfCtx), 'governance');
  assert.equal(reason(policyResult, selfCtx), 'binding');
});

test('the governor changes success only through a justified new revision', () => {
  assert.equal(reason(revision(C2)), 'ok');
  assert.equal(reason({ ...revision(C2), evidence: [] }), 'governance');

  // res-base under the raised bar: its accuracy interval [0.8, 0.9] no longer clears 0.82.
  const underC2 = { ...result('res-base'), result: 'res-base-c2', criteria: C2,
    constraints: [{ constraint: 'accuracy_bar', status: 'unknown' }, { constraint: 'cost_cap', status: 'held' }],
    verdict: 'insufficient_evidence' };
  assert.equal(reason(underC2), 'ok');
  // The result cites @1 and keeps its verdict there.
  assert.equal(reason(result('res-base')), 'ok');

  // A comparison cannot mix revisions.
  const candC2 = { ...result('res-cand'), result: 'res-cand-c2', criteria: C2 };
  assert.equal(reason(candC2), 'ok');
  const ctx = withEntries(context, 'results', { 'res-cand-c2': candC2 });
  const mixed = { ...record('a comparison where the candidate is better'), candidate: 'res-cand-c2' };
  assert.equal(reason(mixed, ctx), 'binding');
});

test('a revision is recorded only when its whole chain holds', () => {
  const { [C1]: _dropped, ...rest } = context.revisions;
  const orphaned: Context = { ...context, revisions: rest };
  assert.equal(reason(revision(C2), orphaned), 'binding');
  assert.equal(reason({ ...result('res-cand'), criteria: C2 }, orphaned), 'binding');

  const tampered = withEntries(context, 'revisions', { [C1]: { ...revision(C1), justification: 'Initial' } });
  assert.equal(reason(revision(C2), tampered), 'binding');
  const misissued = withEntries(context, 'revisions', { [C1]: { ...revision(C1), issued_by: { kind: 'approval', ref: 'appr-41' } } });
  assert.equal(reason(revision(C2), misissued), 'binding');
});

test('the candidate side cannot change held-out cases', () => {
  const holdout = result('res-hold');
  assert.equal(reason(holdout), 'ok');

  // Same split digests, one case quietly dropped from the holdout: no longer the recorded set.
  const shrunk = clone(context.casesets[CASES]) as Rec & { splits: Rec[] };
  shrunk.splits[1]!.size = 39;
  assert.equal(reason(holdout, withEntries(context, 'casesets', { [CASES]: shrunk })), 'binding');

  const cases2 = { ...shrunk, caseset: 'decision-sites.cases@2' };
  const issued = {
    schema: 'gauge.revision@1', revision: 'decision-sites.cases@2', record: 'caseset', digest: recordDigest(cases2),
    supersedes: CASES, issued_by: { kind: 'policy', ref: 'optimiser-2' }, justification: 'case_removed',
    evidence: [{ source: 'observation', ref: 'obs-optimiser-1' }],
  };
  const ctx = withEntries(withEntries(context, 'casesets', { 'decision-sites.cases@2': cases2 }),
    'revisions', { 'decision-sites.cases@2': issued });
  assert.equal(reason(issued, ctx), 'governance');
  assert.equal(reason({ ...holdout, caseset: 'decision-sites.cases@2' }, ctx), 'binding');
  // Its governor can.
  const governed = { ...issued, issued_by: { kind: 'approval', ref: 'appr-41' } };
  assert.equal(reason(governed, withEntries(ctx, 'revisions', { 'decision-sites.cases@2': governed })), 'ok');
});

test('a protected constraint is a gate, not a term traded against a score', () => {
  const costly = { ...result('res-cand'), result: 'res-costly', subject: { kind: 'routed_unit', ref: 'boolean.task@jev-2.0.0' },
    measures: [
      { measure: 'accuracy', value: 0.97, n: 120, interval: [0.94, 0.99] },
      { measure: 'cost', value: 250, n: 120, interval: [240, 260] },
      { measure: 'completion', value: 0.9, n: 120, interval: [0.84, 0.95] },
    ],
    constraints: [{ constraint: 'accuracy_bar', status: 'held' }, { constraint: 'cost_cap', status: 'violated' }],
    verdict: 'misses_bar' };
  assert.equal(reason(costly), 'ok');
  assert.equal(reason({ ...costly, verdict: 'meets_bar' }), 'verdict');

  const ctx = withEntries(context, 'results', { 'res-costly': costly });
  const comparison = {
    schema: 'gauge.comparison@1', comparison: 'cmp-costly', experiment: 'exp-12', baseline: 'res-base', candidate: 'res-costly',
    deltas: [
      { measure: 'accuracy', delta: 0.97 - 0.85, interval: [0.06, 0.18] },
      { measure: 'cost', delta: 100, interval: [82, 118] },
      { measure: 'completion', delta: 0.9 - 0.7, interval: [0.1, 0.3] },
    ],
    verdict: 'bar_missed',
  };
  assert.equal(reason(comparison, ctx), 'ok');
  assert.equal(reason({ ...comparison, verdict: 'candidate_better' }, ctx), 'verdict');
});
