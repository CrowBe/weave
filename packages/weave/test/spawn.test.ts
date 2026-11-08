import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { digest } from '../src/digest.js';
import { correlation } from '../src/sites/index.js';

// Dynamic loading lets every contract case demonstrate red before the module exists.
const spawn = () => import('../src/' + 'spawn.js');
const input = (roles = ['edit', 'read', 'forbid', 'skip']) => ({
  decision_id: 'parent',
  root_ref: 'root',
  goal_digest: digest({ message: 'CANARY-msg' }),
  budget: 17,
  tier: 'strong',
  targets: roles.map((_, i) => `target${i}`),
  roles,
  ambiguity: 2,
});
function frozen(value: any): void {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach(frozen);
}
// Reseal enclosing records so each negative case tests an invariant beyond the digest.
function reseal(plan: any): any {
  for (const child of plan.children)
    if (child.frame) {
      const { seal: _seal, ...fields } = child.frame;
      child.frame.seal = digest(fields);
    }
  const { digest: _digest, ...fields } = plan;
  plan.digest = digest(fields);
  return plan;
}

test('P5a-1 no bare child; sealed parent frame and deep freezing', async () => {
  const { preflightPlan, validatePlan } = await spawn();
  const plan = preflightPlan(input()).plan;
  frozen(plan);
  assert.deepEqual(Object.keys(plan), [
    'schema',
    'pattern',
    'root_ref',
    'parent_ref',
    'goal_digest',
    'budget',
    'children',
    'digest',
  ]);
  assert.deepEqual(Object.keys(plan.children[0]), [
    'schema',
    'child_ref',
    'kind',
    'target_ref',
    'edit',
    'read',
    'forbid',
    'tier',
    'share',
    'frame',
  ]);
  assert.deepEqual(Object.keys(plan.children[0].frame), [
    'schema',
    'root_ref',
    'parent_ref',
    'goal_digest',
    'why',
    'siblings',
    'depends_on',
    'seal',
  ]);
  assert.deepEqual(validatePlan(plan, input().targets), plan);
  for (const child of plan.children) {
    const { seal, ...fields } = child.frame;
    assert.equal(seal, digest(fields));
  }
  const mutations: ((p: any) => void)[] = [
    (p) => {
      delete p.children[0].frame;
    },
    ...['root_ref', 'parent_ref', 'goal_digest', 'why', 'siblings', 'depends_on'].map((key) => (p: any) => {
      delete p.children[0].frame[key];
    }),
    (p) => {
      p.children[0].frame.why = 'preflight.generate';
    },
    (p) => {
      p.children[0].frame.siblings.reverse();
    },
    ...['root_ref', 'parent_ref', 'goal_digest'].map((key) => (p: any) => {
      p.children[0].frame[key] = 'other';
    }),
    (p) => {
      p.children[0].extra = 'CANARY-summary';
    },
    (p) => {
      p.children[0].frame.grant = 'CANARY-provider';
    },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(plan);
    mutate(bad);
    assert.throws(() => validatePlan(bad, input().targets), /^Error: spawn:/);
    assert.throws(() => validatePlan(reseal(bad), input().targets), /^Error: spawn:/);
  }
});

test('P5a-2 edges, bounded deterministic ids, target and child cardinality', async () => {
  const { preflightPlan, validatePlan, childRef } = await spawn();
  const plan = preflightPlan(input()).plan;
  const mutations: ((p: any) => void)[] = [
    (p) => {
      p.children[0].frame.depends_on = [p.children[0].child_ref];
    },
    (p) => {
      p.children[0].frame.depends_on = ['foreign'];
    },
    (p) => {
      p.children[2].frame.depends_on.push(p.children[0].child_ref);
    },
    (p) => {
      p.children[0].frame.depends_on = [p.children[2].child_ref];
    },
    (p) => {
      p.children[0].frame.depends_on = [p.children[1].child_ref];
    },
    (p) => {
      p.children[2].frame.depends_on.pop();
    },
    (p) => {
      p.children.pop();
    },
    (p) => {
      p.children.push(structuredClone(p.children[2]));
    },
    (p) => {
      p.children[2].edit = [];
    },
    (p) => {
      p.children[1].child_ref = p.children[0].child_ref;
    },
    (p) => {
      p.children[0].target_ref = 'foreign';
    },
    (p) => {
      p.children[0].target_ref = 'target2';
    },
    (p) => {
      p.children[0].target_ref = 'target3';
    },
    (p) => {
      p.children[0].child_ref = 'c' + 'a'.repeat(32);
    },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(plan);
    mutate(bad);
    assert.throws(() => validatePlan(reseal(bad), input().targets), /^Error: spawn:/);
  }
  for (const parent of ['parent', 'p'.repeat(96), childRef('root', 'read', 'target', 0)]) {
    const ref = childRef(parent, 'read', 'target', 0);
    assert.equal(ref.length, 33);
    assert.equal(correlation(ref), ref);
    assert.equal(ref, childRef(parent, 'read', 'target', 0));
    assert.notEqual(ref, childRef(parent, 'read', 'target', 1));
  }
});

test('P5a-3 role vectors build reads in target order and one generate child', async () => {
  const { preflightPlan, validatePlan, TARGET_ROLES } = await spawn();
  assert.deepEqual(TARGET_ROLES, ['edit', 'read', 'forbid', 'skip']);
  assert.ok(Object.isFrozen(TARGET_ROLES));
  for (const roles of [
    ['edit', 'edit'],
    ['edit', 'read'],
    ['edit', 'forbid', 'skip'],
    ['read'],
    ['skip'],
    Array(8).fill('edit'),
  ]) {
    const args = input(roles);
    const { plan, gain } = preflightPlan(args);
    assert.equal(gain, roles.includes('edit'));
    if (!gain) {
      assert.equal(plan, null);
      continue;
    }
    validatePlan(plan, args.targets);
    const refs = (kinds: string[]) => args.targets.filter((_, i) => kinds.includes(roles[i]!));
    assert.deepEqual(
      plan.children.slice(0, -1).map((c: any) => c.target_ref),
      refs(['edit', 'read']),
    );
    const gen = plan.children.at(-1);
    assert.deepEqual(
      [gen.kind, gen.target_ref, gen.edit, gen.read, gen.forbid, gen.tier],
      ['generate', null, refs(['edit']), refs(['edit', 'read']), refs(['forbid']), 'strong'],
    );
    assert.deepEqual(
      gen.frame.depends_on,
      plan.children.slice(0, -1).map((c: any) => c.child_ref),
    );
  }
  for (const bad of [{ ...input(), roles: ['edit'] }, input(['unknown']), input(Array(9).fill('edit'))])
    assert.throws(() => preflightPlan(bad), /^Error: spawn:/);
});

test('P5a-4 strict Pareto gain and finite descent without a depth limit', async () => {
  const { splitGain } = await spawn();
  const p = { coupling: 2, unread: 2, ambiguity: 1 };
  assert.equal(splitGain(p, [p]), false);
  assert.equal(splitGain(p, []), false);
  assert.equal(splitGain(p, [{ coupling: 3, unread: 0, ambiguity: 0 }]), false);
  assert.equal(
    splitGain(p, [
      { coupling: 2, unread: 0, ambiguity: 1 },
      { coupling: 0, unread: 0, ambiguity: 0 },
    ]),
    true,
  );
  assert.equal(splitGain(p, [{ coupling: 0, unread: 0, ambiguity: 0 }, p]), false);
  const domain = [];
  for (let coupling = 0; coupling <= 2; coupling++)
    for (let unread = 0; unread <= 2; unread++)
      for (let ambiguity = 0; ambiguity <= 2; ambiguity++) domain.push({ coupling, unread, ambiguity });
  const sum = (s: any) => s.coupling + s.unread + s.ambiguity;
  const longest = new Map<string, number>();
  for (const parent of domain.sort((a, b) => sum(a) - sum(b))) {
    const next = domain.filter((child) => splitGain(parent, [child]));
    for (const child of next) assert.ok(sum(child) < sum(parent));
    const length = 1 + Math.max(0, ...next.map((child) => longest.get(JSON.stringify(child))!));
    longest.set(JSON.stringify(parent), length);
    assert.ok(length <= sum(parent) + 1);
  }
});

test('P5a-5 budget shares are conserved, including zero budget', async () => {
  const { preflightPlan, validatePlan } = await spawn();
  for (const budget of [0, 17]) {
    const plan = preflightPlan({ ...input(), budget }).plan;
    assert.deepEqual(
      plan.children.map((c: any) => c.share),
      [0, 0, budget],
    );
    assert.ok(plan.children.reduce((sum: number, c: any) => sum + c.share, 0) <= budget);
    for (const share of [-1, 0.5, NaN, Infinity, budget + 1]) {
      const bad = structuredClone(plan);
      bad.children.at(-1).share = share;
      assert.throws(() => validatePlan(reseal(bad), input().targets), /^Error: spawn:/);
    }
    const bad = structuredClone(plan);
    bad.children[0].share = 1;
    assert.throws(() => validatePlan(reseal(bad), input().targets), /^Error: spawn:/);
  }
});

test('P5a-6 pure module, immutable inputs, identical bytes, no disclosed text', async () => {
  const { preflightPlan } = await spawn();
  const source = readFileSync(new URL('../../src/spawn.ts', import.meta.url), 'utf8');
  assert.deepEqual(
    [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ['./digest.js'],
  );
  const args = input();
  const before = structuredClone(args);
  const first = preflightPlan(args);
  const second = preflightPlan(args);
  assert.deepEqual(args, before);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(!JSON.stringify(first).includes('CANARY'));
});
