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
  const misissued = withEntries(context, 'revisions', { [C1]: { ...revision(C1), issued_by: { kind: 'approval', ref: 'appr-50' } } });
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
  // Its governor is approval appr-41, which already issued cases@1: a single-use grant is not issued twice.
  const governed = { ...issued, issued_by: { kind: 'approval', ref: 'appr-41' } };
  assert.equal(reason(governed, withEntries(ctx, 'revisions', { 'decision-sites.cases@2': governed })), 'approval_reused');
});

// An approval is a single-use grant: it issues exactly one revision. A policy is a standing authority.

/** A fresh case set named `name`, governed by `governor`, and the @1 revision that `governor` issues for it. */
const freshCaseSet = (name: string, governor: Rec) => {
  const set = { ...(clone(context.casesets[CASES]) as Rec), caseset: name, governed_by: governor };
  const issued = { ...revision(CASES), revision: name, digest: recordDigest(set), issued_by: governor };
  return { set, issued };
};
const withCaseSets = (ctx: Context, ...fresh: readonly { set: Rec; issued: Rec }[]): Context =>
  withEntries(withEntries(ctx, 'casesets', Object.fromEntries(fresh.map(f => [f.set.caseset as string, f.set]))),
    'revisions', Object.fromEntries(fresh.map(f => [f.issued.revision as string, f.issued])));
const appr41 = { kind: 'approval', ref: 'appr-41' };

test('an approval ref reused for a second revision of the same set is refused, and unrecords the set', () => {
  const cases2 = { ...(clone(context.casesets[CASES]) as Rec), caseset: 'decision-sites.cases@2' };
  const reissued: Rec = {
    ...revision(CASES), revision: 'decision-sites.cases@2', digest: recordDigest(cases2), supersedes: CASES,
    justification: 'case_added', evidence: [{ source: 'check', ref: 'chk-cases-2' }],
  };
  assert.deepEqual(reissued.issued_by, appr41);
  const ctx = withEntries(withEntries(context, 'casesets', { 'decision-sites.cases@2': cases2 }),
    'revisions', { 'decision-sites.cases@2': reissued });
  assert.deepEqual(validate(reissued, ctx), { ok: false, reason: 'approval_reused' });
  assert.equal(reason({ ...result('res-hold'), caseset: 'decision-sites.cases@2' }, ctx), 'binding');
});

test('an approval ref reused across two different sets is refused', () => {
  const other = freshCaseSet('other-sites.cases@1', appr41);
  const ctx = withCaseSets(context, other);
  assert.equal(reason(other.issued, ctx), 'approval_reused');
  // Presented without being in context, it is refused the same way.
  assert.equal(reason(other.issued, withEntries(context, 'casesets', { 'other-sites.cases@1': other.set })), 'approval_reused');
  // A criteria set may not spend it either.
  const crit = { ...criteria(C1), criteria: 'other-sites.criteria@1', governed_by: appr41 };
  const critRev = { ...revision(C1), revision: 'other-sites.criteria@1', digest: recordDigest(crit), issued_by: appr41 };
  const critCtx = withEntries(withEntries(context, 'criteria', { 'other-sites.criteria@1': crit }),
    'revisions', { 'other-sites.criteria@1': critRev });
  assert.equal(reason(critRev, critCtx), 'approval_reused');
});

test('concurrent issuance citing one approval refuses every claimant, whatever the input order', () => {
  const a = freshCaseSet('alpha.cases@1', { kind: 'approval', ref: 'appr-77' });
  const b = freshCaseSet('beta.cases@1', { kind: 'approval', ref: 'appr-77' });
  assert.equal(reason(a.issued, withCaseSets(context, a)), 'ok');
  assert.equal(reason(b.issued, withCaseSets(context, b)), 'ok');
  for (const ctx of [withCaseSets(context, a, b), withCaseSets(context, b, a)]) {
    assert.equal(reason(a.issued, ctx), 'approval_reused');
    assert.equal(reason(b.issued, ctx), 'approval_reused');
    assert.equal(reason({ ...result('res-hold'), caseset: 'alpha.cases@1' }, ctx), 'binding');
    assert.equal(reason({ ...result('res-hold'), caseset: 'beta.cases@1' }, ctx), 'binding');
  }
});

test('replay after a crash: the recorded revision re-validates, a re-issue with its approval is refused', () => {
  // Idempotent replay: the same recorded revision, in any key order, still passes.
  const recorded = revision(CASES);
  assert.equal(reason(recorded), 'ok');
  assert.equal(reason(recorded), 'ok');
  assert.equal(reason(Object.fromEntries(Object.entries(recorded).reverse())), 'ok');
  assert.equal(reason(result('res-hold')), 'ok');

  // A re-issued revision beside the recorded one: both refused, and nothing binds to cases@1.
  const again = freshCaseSet('decision-sites.retry@1', appr41);
  const ctx = withCaseSets(context, again);
  assert.equal(reason(again.issued, ctx), 'approval_reused');
  assert.equal(reason(recorded, ctx), 'approval_reused');
  assert.equal(reason(result('res-hold'), ctx), 'binding');

  // A re-issue that replaced the recorded entry under its own name is a different revision too.
  const rewritten = { ...recorded, justification: 'reissued_after_crash' };
  const rewrittenCtx = withEntries(context, 'revisions', { [CASES]: rewritten });
  assert.equal(reason(rewritten, rewrittenCtx), 'ok');
  assert.equal(reason(recorded, rewrittenCtx), 'approval_reused');
});

test('the same ref under another kind is a different authority', () => {
  // Approval p-1 governs; policy p-1 does not satisfy it, nor the reverse.
  const byApproval = freshCaseSet('kinds.cases@1', { kind: 'approval', ref: 'p-1' });
  const asPolicy = { ...byApproval.issued, issued_by: { kind: 'policy', ref: 'p-1' } };
  assert.equal(reason(asPolicy, withCaseSets(context, { ...byApproval, issued: asPolicy })), 'governance');
  const byPolicy = freshCaseSet('kinds.cases@1', { kind: 'policy', ref: 'p-1' });
  const asApproval = { ...byPolicy.issued, issued_by: { kind: 'approval', ref: 'p-1' } };
  assert.equal(reason(asApproval, withCaseSets(context, { ...byPolicy, issued: asApproval })), 'governance');

  // A policy is a standing authority: policy appr-41 does not spend approval appr-41, and may issue many revisions.
  const standing = freshCaseSet('standing.cases@1', { kind: 'policy', ref: 'appr-41' });
  const standing2 = freshCaseSet('standing-two.cases@1', { kind: 'policy', ref: 'appr-41' });
  const ctx = withCaseSets(context, standing, standing2);
  assert.equal(reason(standing.issued, ctx), 'ok');
  assert.equal(reason(standing2.issued, ctx), 'ok');
  assert.equal(reason(revision(CASES), ctx), 'ok');
  assert.equal(reason(revision(C2), ctx), 'ok');
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
