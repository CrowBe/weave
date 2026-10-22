import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitCriterionProof,
  type ProofCheck,
  type ProofCriterion,
  type ProofDowngrade,
  type ProofScope,
} from '../src/criterion-proof.js';

const oracle: ProofCheck = {
  check_id: 'repo.test',
  oracle_refs: ['heldout-1'],
  permissions: [
    { resource: 'heldout-1', mode: 'read' },
    { resource: 'workspace-1', mode: 'write' },
  ],
};
const scope: ProofScope = { generation_writes: ['workspace-1'], canonical: (ref) => ref };
const proposed: ProofCriterion = { criterion_id: 'c1', proof: 'check', check_ids: ['repo.test'] };

test('criterion proof: absent and judgment proposals stay judgment with no reason', () => {
  assert.deepEqual(admitCriterionProof({ criterion_id: 'c1' }, [oracle], scope), {
    criterion_id: 'c1',
    proposed: 'judgment',
    proof: 'judgment',
    reason: null,
  });
  assert.deepEqual(
    admitCriterionProof({ criterion_id: 'c1', proof: 'judgment', check_ids: ['repo.test'] }, [oracle], scope),
    { criterion_id: 'c1', proposed: 'judgment', proof: 'judgment', reason: null },
  );
});

test('criterion proof: check is admitted when every bound oracle is readable and outside generation writes', () => {
  assert.deepEqual(admitCriterionProof(proposed, [oracle], scope), {
    criterion_id: 'c1',
    proposed: 'check',
    proof: 'check',
    reason: null,
  });
  const lint: ProofCheck = {
    check_id: 'repo.lint',
    oracle_refs: ['rules-1'],
    permissions: [{ resource: 'rules-1', mode: 'read' }],
  };
  assert.equal(
    admitCriterionProof({ ...proposed, check_ids: ['repo.test', 'repo.lint'] }, [oracle, lint], scope).proof,
    'check',
  );
  // Generation that declares no writes cannot reach any oracle.
  assert.equal(admitCriterionProof(proposed, [oracle], { ...scope, generation_writes: [] }).proof, 'check');
});

const throwing = (): string => {
  throw new Error('unknown ref');
};
const cases: readonly (readonly [string, ProofCriterion, readonly ProofCheck[], ProofScope, ProofDowngrade])[] = [
  ['no bound checks', { ...proposed, check_ids: [] }, [oracle], scope, 'unbound_check'],
  ['missing check ids', { criterion_id: 'c1', proof: 'check' }, [oracle], scope, 'unbound_check'],
  [
    'a bound id that is not configured',
    { ...proposed, check_ids: ['repo.test', 'repo.lint'] },
    [oracle],
    scope,
    'unbound_check',
  ],
  [
    'unknown generation writes',
    proposed,
    [oracle],
    { generation_writes: undefined, canonical: (ref) => ref },
    'write_scope_unknown',
  ],
  [
    'no canonical identity',
    proposed,
    [oracle],
    { generation_writes: ['workspace-1'], canonical: undefined },
    'write_scope_unknown',
  ],
  [
    'a throwing canonical identity',
    proposed,
    [oracle],
    { generation_writes: ['workspace-1'], canonical: throwing },
    'write_scope_unknown',
  ],
  ['an empty oracle', proposed, [{ ...oracle, oracle_refs: [] }], scope, 'no_oracle'],
  ['an absent oracle', proposed, [{ check_id: 'repo.test', permissions: oracle.permissions }], scope, 'no_oracle'],
  ['a malformed oracle ref', proposed, [{ ...oracle, oracle_refs: ['/abs/path'] }], scope, 'no_oracle'],
  ['a denied check', proposed, [{ ...oracle, permissions: null }], scope, 'oracle_not_granted'],
  [
    'an oracle granted only for write',
    proposed,
    [{ ...oracle, permissions: [{ resource: 'heldout-1', mode: 'write' }] }],
    scope,
    'oracle_not_granted',
  ],
  [
    'an oracle another resource grants',
    proposed,
    [{ ...oracle, permissions: [{ resource: 'heldout-2', mode: 'read' }] }],
    scope,
    'oracle_not_granted',
  ],
  // Today's CLI wiring: the generate backend writes the workspace its tests live in.
  [
    'tests in the workspace generation writes',
    proposed,
    [{ check_id: 'repo.test', oracle_refs: ['workspace-1'], permissions: [{ resource: 'workspace-1', mode: 'read' }] }],
    scope,
    'oracle_writable',
  ],
  [
    'an oracle aliased to a written resource',
    proposed,
    [oracle],
    { generation_writes: ['workspace-alias'], canonical: (ref) => (ref === 'workspace-alias' ? 'heldout-1' : ref) },
    'oracle_writable',
  ],
  [
    'one of two same-id checks with a writable oracle',
    proposed,
    [
      oracle,
      { check_id: 'repo.test', oracle_refs: ['workspace-1'], permissions: [{ resource: 'workspace-1', mode: 'read' }] },
    ],
    scope,
    'oracle_writable',
  ],
];
for (const [name, criterion, checks, proofScope, reason] of cases) {
  test(`criterion proof: ${name} keeps judgment with reason ${reason}`, () => {
    assert.deepEqual(admitCriterionProof(criterion, checks, proofScope), {
      criterion_id: 'c1',
      proposed: 'check',
      proof: 'judgment',
      reason,
    });
  });
}

test('criterion proof: admission is pure and does not retain caller objects', () => {
  const checks = [structuredClone(oracle)];
  const writes = ['workspace-1'];
  const first = admitCriterionProof(proposed, checks, { generation_writes: writes, canonical: (ref) => ref });
  writes.push('heldout-1');
  checks[0] = { ...checks[0]!, oracle_refs: [] };
  assert.equal(first.proof, 'check');
  assert.deepEqual(admitCriterionProof(proposed, [oracle], scope), first);
});
