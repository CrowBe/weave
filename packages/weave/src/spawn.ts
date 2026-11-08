/** Pure, content-free preflight plans. Seals bind lineage and edges, never authority. */
import { digest } from './digest.js';

export const TARGET_ROLES = Object.freeze(['edit', 'read', 'forbid', 'skip'] as const);
export type TargetRole = (typeof TARGET_ROLES)[number];
export interface SpawnFrame {
  readonly schema: 'spawn.frame@1';
  readonly root_ref: string;
  readonly parent_ref: string;
  readonly goal_digest: string;
  readonly why: 'preflight.read' | 'preflight.generate';
  readonly siblings: readonly string[];
  readonly depends_on: readonly string[];
  readonly seal: string;
}
export interface ChildBrief {
  readonly schema: 'spawn.child@1';
  readonly child_ref: string;
  readonly kind: 'read' | 'generate';
  readonly target_ref: string | null;
  readonly edit: readonly string[];
  readonly read: readonly string[];
  readonly forbid: readonly string[];
  readonly tier: 'flash' | 'standard' | 'strong' | null;
  readonly share: number;
  readonly frame: SpawnFrame;
}
export interface SpawnPlan {
  readonly schema: 'spawn.plan@1';
  readonly pattern: 'preflight';
  readonly root_ref: string;
  readonly parent_ref: string;
  readonly goal_digest: string;
  readonly budget: number;
  readonly children: readonly ChildBrief[];
  readonly digest: string;
}
export interface SplitScore {
  readonly coupling: number;
  readonly unread: number;
  readonly ambiguity: number;
}
export function childRef(
  parent_ref: string,
  kind: ChildBrief['kind'],
  target_ref: string | null,
  index: number,
): string {
  return 'c' + digest({ parent_ref, kind, target_ref, index }).slice(0, 32);
}
export function sealFrame(frame: Omit<SpawnFrame, 'schema' | 'seal'>): SpawnFrame {
  const fields = {
    schema: 'spawn.frame@1' as const,
    root_ref: frame.root_ref,
    parent_ref: frame.parent_ref,
    goal_digest: frame.goal_digest,
    why: frame.why,
    siblings: Object.freeze([...frame.siblings]),
    depends_on: Object.freeze([...frame.depends_on]),
  };
  return Object.freeze({ ...fields, seal: digest(fields) });
}
const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const axes = ['coupling', 'unread', 'ambiguity'] as const;
export function splitGain(parent: SplitScore, children: readonly SplitScore[]): boolean {
  return (
    axes.every((axis) => natural(parent[axis])) &&
    children.length > 0 &&
    children.every(
      (child) =>
        axes.every((axis) => natural(child[axis]) && child[axis] <= parent[axis]) &&
        axes.some((axis) => child[axis] < parent[axis]),
    )
  );
}
function requirePlan(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`spawn: ${reason}`);
}
function keys(value: unknown, expected: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function ref(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
    !/^(sk[-_]|Bearer\s+|eyJ|gh[pousr]_|github_pat_|AKIA)/i.test(value)
  );
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
function targetSet(targets: readonly string[]): void {
  requirePlan(
    Array.isArray(targets) &&
      targets.length <= 8 &&
      Array.from(targets).every(ref) &&
      new Set(targets).size === targets.length,
    'invalid targets',
  );
}
function orderedRefs(value: unknown, targets: readonly string[]): asserts value is readonly string[] {
  requirePlan(
    Array.isArray(value) &&
      value.every(ref) &&
      equal(
        value,
        targets.filter((t) => value.includes(t)),
      ),
    'invalid target list',
  );
}

/** Validate the complete closed shape before returning a frozen, detached plan. */
export function validatePlan(value: unknown, targets: readonly string[]): SpawnPlan {
  targetSet(targets);
  requirePlan(
    keys(value, ['schema', 'pattern', 'root_ref', 'parent_ref', 'goal_digest', 'budget', 'children', 'digest']),
    'invalid plan shape',
  );
  const plan = value as SpawnPlan;
  requirePlan(
    plan.schema === 'spawn.plan@1' &&
      plan.pattern === 'preflight' &&
      ref(plan.root_ref) &&
      ref(plan.parent_ref) &&
      hash(plan.goal_digest) &&
      natural(plan.budget),
    'invalid plan fields',
  );
  requirePlan(
    Array.isArray(plan.children) && plan.children.length >= 2 && plan.children.length <= 9,
    'invalid children',
  );
  const siblings = plan.children.map((child) => child?.child_ref);
  requirePlan(
    siblings.every((id) => typeof id === 'string' && /^c[a-f0-9]{32}$/.test(id)) &&
      new Set(siblings).size === siblings.length,
    'invalid child refs',
  );
  for (const [index, child] of plan.children.entries()) {
    requirePlan(
      keys(child, ['schema', 'child_ref', 'kind', 'target_ref', 'edit', 'read', 'forbid', 'tier', 'share', 'frame']),
      'invalid child shape',
    );
    const generate = index === plan.children.length - 1;
    requirePlan(
      child.schema === 'spawn.child@1' && child.kind === (generate ? 'generate' : 'read'),
      'invalid child kind',
    );
    requirePlan(
      (generate ? child.target_ref === null : ref(child.target_ref) && targets.includes(child.target_ref)) &&
        natural(child.share),
      'invalid child fields',
    );
    requirePlan(
      child.child_ref === childRef(plan.parent_ref, child.kind, child.target_ref, index),
      'child ref differs',
    );
    for (const list of [child.edit, child.read, child.forbid]) orderedRefs(list, targets);
    const frame = child.frame;
    requirePlan(
      keys(frame, ['schema', 'root_ref', 'parent_ref', 'goal_digest', 'why', 'siblings', 'depends_on', 'seal']),
      'missing parent frame',
    );
    requirePlan(
      frame.schema === 'spawn.frame@1' &&
        frame.root_ref === plan.root_ref &&
        frame.parent_ref === plan.parent_ref &&
        frame.goal_digest === plan.goal_digest &&
        frame.why === `preflight.${child.kind}`,
      'parent frame differs',
    );
    requirePlan(Array.isArray(frame.siblings) && equal(frame.siblings, siblings), 'siblings differ');
    // Preflight has only parallel reads and their single join: this also excludes cycles,
    // foreign edges, duplicate edges, self edges and omitted dependencies.
    requirePlan(
      Array.isArray(frame.depends_on) && equal(frame.depends_on, generate ? siblings.slice(0, -1) : []),
      'invalid edges',
    );
    const { seal, ...fields } = frame;
    requirePlan(hash(seal) && seal === digest(fields), 'frame seal differs');
    if (generate) {
      requirePlan(
        ['flash', 'standard', 'strong'].includes(child.tier as string) &&
          child.share === plan.budget &&
          child.edit.length >= 1,
        'invalid generate child',
      );
      requirePlan(
        child.edit.every((t: string) => child.read.includes(t)) &&
          child.forbid.every((t: string) => !child.read.includes(t)),
        'invalid roles',
      );
      requirePlan(
        equal(
          child.read,
          plan.children.slice(0, -1).map((c) => c.target_ref!),
        ),
        'reads differ',
      );
    } else
      requirePlan(
        child.tier === null && child.share === 0 && child.edit.length + child.read.length + child.forbid.length === 0,
        'invalid read child',
      );
  }
  const { digest: recorded, ...fields } = plan;
  requirePlan(hash(recorded) && recorded === digest(fields), 'plan digest differs');
  return Object.freeze({
    ...fields,
    children: Object.freeze(
      plan.children.map((child) =>
        Object.freeze({
          ...child,
          edit: Object.freeze([...child.edit]),
          read: Object.freeze([...child.read]),
          forbid: Object.freeze([...child.forbid]),
          frame: sealFrame(child.frame),
        }),
      ),
    ),
    digest: recorded,
  });
}

export function preflightPlan(input: {
  readonly decision_id: string;
  readonly root_ref: string;
  readonly goal_digest: string;
  readonly budget: number;
  readonly tier: 'flash' | 'standard' | 'strong';
  readonly targets: readonly string[];
  readonly roles: readonly TargetRole[];
  readonly ambiguity: number;
}): { readonly gain: boolean; readonly plan: SpawnPlan | null } {
  targetSet(input.targets);
  requirePlan(
    Array.isArray(input.roles) &&
      input.roles.length === input.targets.length &&
      Array.from(input.roles).every((r) => TARGET_ROLES.includes(r)),
    'invalid roles',
  );
  requirePlan(natural(input.ambiguity), 'invalid ambiguity');
  const select = (roles: readonly TargetRole[]) => input.targets.filter((_, i) => roles.includes(input.roles[i]!));
  const edit = select(['edit']);
  const read = select(['edit', 'read']);
  const forbid = select(['forbid']);
  if (edit.length === 0) return { gain: false, plan: null };
  const refs = [
    ...read.map((target, i) => childRef(input.decision_id, 'read', target, i)),
    childRef(input.decision_id, 'generate', null, read.length),
  ];
  const children: ChildBrief[] = [...read, null].map((target_ref, i) => {
    const kind = target_ref === null ? 'generate' : 'read';
    return {
      schema: 'spawn.child@1',
      child_ref: refs[i]!,
      kind,
      target_ref,
      edit: kind === 'generate' ? edit : [],
      read: kind === 'generate' ? read : [],
      forbid: kind === 'generate' ? forbid : [],
      tier: kind === 'generate' ? input.tier : null,
      share: kind === 'generate' ? input.budget : 0,
      frame: sealFrame({
        root_ref: input.root_ref,
        parent_ref: input.decision_id,
        goal_digest: input.goal_digest,
        why: `preflight.${kind}`,
        siblings: refs,
        depends_on: kind === 'generate' ? refs.slice(0, -1) : [],
      }),
    };
  });
  const fields = {
    schema: 'spawn.plan@1' as const,
    pattern: 'preflight' as const,
    root_ref: input.root_ref,
    parent_ref: input.decision_id,
    goal_digest: input.goal_digest,
    budget: input.budget,
    children,
  };
  const gain = splitGain({ coupling: edit.length, unread: read.length, ambiguity: input.ambiguity }, [
    ...read.map(() => ({ coupling: 0, unread: 0, ambiguity: 0 })),
    { coupling: edit.length, unread: 0, ambiguity: input.ambiguity },
  ]);
  return { gain, plan: validatePlan({ ...fields, digest: digest(fields) }, input.targets) };
}
