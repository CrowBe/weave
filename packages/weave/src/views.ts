/**
 * Bounded state views for M2 context profiles (docs/m2-handle-a-novel-request.md §3).
 *
 * Policy chooses the profile and filters disclosure. The view records what
 * actually filled each slice so a recorded judgment can be reproduced.
 */
import type { Candidate, Seq, State, StateView, ViewOmission, ViewSliceManifest } from './types.js';

export const FRAME_PROFILE = 'profile.frame@1' as const;
export const WEIGH_PROFILE = 'profile.frontier-weigh@1' as const;

/**
 * A context profile is a versioned record the runtime selects. The renderer
 * does not own a private budget: promotion of another profile is a different
 * record, not an edit to this function.
 */
export interface FrameProfile {
  readonly id: string;
  readonly version: number;
  /** Maximum catalogue operations disclosed. Excess is omitted with reason `budget`. */
  readonly catalogue_budget: number;
  /**
   * Slice names this profile selects. A cached conclusion is included only
   * when `conclusion` is listed, and then once. Reuse does not add a slice.
   */
  readonly slices?: readonly string[];
  /**
   * Extra bytes that belong to the stable prefix and not to the view body.
   * A different value changes `prefix_stable` without changing disclosed
   * operations. Absent means the profile id alone distinguishes the prefix.
   */
  readonly prefix?: string;
  /**
   * When set, the catalogue is disclosed as an index plus input shapes for
   * these operations only. An empty list omits every shape. Absent keeps the
   * single catalogue slice.
   */
  readonly schema_for?: readonly string[];
}

/** Discloses the fixture catalogue. A tighter profile is a different record. */
export const DEFAULT_FRAME_PROFILE: FrameProfile = {
  id: FRAME_PROFILE,
  version: 1,
  catalogue_budget: 32,
};

/** M5 candidate. A smaller catalogue budget, still a profile record. */
export const NARROW_FRAME_PROFILE: FrameProfile = {
  id: 'profile.frame.narrow@1',
  version: 1,
  catalogue_budget: 8,
};

export interface CatalogueOp {
  readonly id: string;
  readonly input: Readonly<Record<string, string>>;
  /** Fixture purpose line. Disclosed on the catalogue index, not as a contract revision. */
  readonly purpose?: string;
}

function slice(
  name: string,
  revisions: readonly Seq[],
  omitted: readonly ViewOmission[],
  truncated = false,
): ViewSliceManifest {
  return { name, revisions, truncated, omitted };
}

/** Identity of one fill of the named slices at a state revision. */
export function sliceAssemblyId(state_revision: number, slices: readonly string[]): string {
  return `asm:${state_revision}:${[...slices].sort().join('+')}`;
}

export const SHARED_ASSEMBLY_MICROS = 1_000;

function stampAssemblies(slices: readonly ViewSliceManifest[], state_revision: number, enabled: boolean): ViewSliceManifest[] {
  if (!enabled) {
    return [...slices];
  }
  const shared = sliceAssemblyId(state_revision, ['goal', 'registered']);
  return slices.map((item) => {
    if (item.name === 'goal' || item.name === 'registered') {
      return { ...item, assembly_id: shared };
    }
    if (item.name === 'catalogue_schema') {
      return { ...item, assembly_id: sliceAssemblyId(state_revision, ['catalogue_schema']) };
    }
    return item;
  });
}

/** Framing view: purpose, authorized ids, catalogue shapes. No source bodies. */
export function renderFrameView(
  state: State,
  catalogue: readonly CatalogueOp[],
  profile: FrameProfile = DEFAULT_FRAME_PROFILE,
  options?: { readonly assemblies?: boolean },
): StateView {
  const goal = state.goal;
  if (profile.catalogue_budget === 0) {
    return {
      profile: profile.id,
      profile_version: profile.version,
      state_revision: state.state_revision,
      content: {},
      manifest: {
        slices: stampAssemblies(
          [
            slice('goal', goal ? [goal.evidence] : [], []),
            slice('catalogue', [], [{ name: 'catalogue', reason: 'budget' }], true),
          ],
          state.state_revision,
          options?.assemblies === true,
        ),
      },
    };
  }
  const allowed = new Set(goal?.authority.read ?? []);
  const catalogueBudget =
    Number.isInteger(profile.catalogue_budget) && profile.catalogue_budget > 0 ? profile.catalogue_budget : 0;
  const authorityOmitted: ViewOmission[] = [];
  for (const resource of Object.keys(state.sources).sort()) {
    if (!allowed.has(resource)) {
      authorityOmitted.push({ name: resource, reason: 'authority' });
    }
  }

  const catalogueIds = [...catalogue].map((op) => op.id).sort();
  const selectedOps = catalogueIds.slice(0, catalogueBudget);
  const omittedOps = catalogueIds.slice(catalogueBudget);
  const catalogueOmitted = omittedOps.map((name) => ({ name, reason: 'budget' }));

  const authorizedSources = (goal?.authority.read ?? [])
    .filter((id) => state.sources[id])
    .map((id) => ({ id, revision: state.sources[id]!.revision }));

  const content: {
    purpose: string;
    sources: string[];
    authority: { read: string[] };
    catalogue: { id: string; input: Readonly<Record<string, string>> }[];
    registered: { id: string; revision: number }[];
    conclusions?: { conclusion_id: string; evidence: readonly number[] }[];
  } = {
    purpose: goal?.purpose ?? '',
    sources: [...(goal?.sources ?? [])],
    authority: { read: [...(goal?.authority.read ?? [])] },
    catalogue: selectedOps.map((id) => {
      const op = catalogue.find((c) => c.id === id);
      return { id, input: op?.input ?? {} };
    }),
    registered: authorizedSources,
  };

  const slices = [
    slice('goal', goal ? [goal.evidence] : [], []),
    slice('authority', goal ? [goal.evidence] : [], authorityOmitted),
    slice('catalogue', [], catalogueOmitted, omittedOps.length > 0),
    slice(
      'registered',
      authorizedSources.map((s) => state.sources[s.id]!.evidence),
      [],
    ),
  ];
  if (profile.slices?.includes('conclusion')) {
    const seen = new Set<number>();
    const revisions: number[] = [];
    for (const conclusion of state.conclusions) {
      for (const seq of conclusion.evidence) {
        if (!seen.has(seq)) {
          seen.add(seq);
          revisions.push(seq);
        }
      }
    }
    content.conclusions = state.conclusions.map((conclusion) => ({
      conclusion_id: conclusion.conclusion_id,
      evidence: conclusion.evidence,
    }));
    slices.push(slice('conclusion', revisions, []));
  }

  if (profile.schema_for !== undefined) {
    const schemaFor = new Set(profile.schema_for);
    const catalogue_index = selectedOps.map((id) => {
      const op = catalogue.find((item) => item.id === id);
      return { id, purpose: op?.purpose ?? '' };
    });
    const catalogue_schema = selectedOps
      .filter((id) => schemaFor.has(id))
      .map((id) => {
        const op = catalogue.find((item) => item.id === id);
        return { id, input: op?.input ?? {} };
      });
    const schemaOmitted = selectedOps.filter((id) => !schemaFor.has(id)).map((name) => ({ name, reason: 'profile' }));
    const { catalogue: _catalogue, ...rest } = content;
    void _catalogue;
    return {
      profile: profile.id,
      profile_version: profile.version,
      state_revision: state.state_revision,
      content: { ...rest, catalogue_index, catalogue_schema },
      manifest: {
        slices: stampAssemblies(
          [
            slices[0]!,
            slices[1]!,
            slice('catalogue_index', [], catalogueOmitted, omittedOps.length > 0),
            slice('catalogue_schema', [], schemaOmitted, schemaOmitted.length > 0),
            ...slices.slice(3),
          ],
          state.state_revision,
          options?.assemblies === true,
        ),
      },
    };
  }

  return {
    profile: profile.id,
    profile_version: profile.version,
    state_revision: state.state_revision,
    content,
    manifest: { slices: stampAssemblies(slices, state.state_revision, options?.assemblies === true) },
  };
}

/** Read-only review of goal and registered slices. It does not select schemas. */
export function renderReviewView(state: State): StateView {
  const goal = state.goal;
  const authorizedSources = (goal?.authority.read ?? [])
    .filter((id) => state.sources[id])
    .map((id) => ({ id, revision: state.sources[id]!.revision }));
  const slices = stampAssemblies(
    [
      slice('goal', goal ? [goal.evidence] : [], []),
      slice(
        'registered',
        authorizedSources.map((source) => state.sources[source.id]!.evidence),
        [],
      ),
    ],
    state.state_revision,
    true,
  );
  return {
    profile: 'profile.review@1',
    profile_version: 1,
    state_revision: state.state_revision,
    content: {
      purpose: goal?.purpose ?? '',
      registered: authorizedSources,
    },
    manifest: { slices },
  };
}

/** Weighing view: eligible candidates only. */
export function renderWeighView(state: State, eligible: readonly Candidate[]): StateView {
  const goal = state.goal;
  const content = {
    purpose: goal?.purpose ?? '',
    candidates: eligible.map((c) => ({
      candidate_id: c.candidate_id,
      operation: c.operation,
      inputs: c.inputs,
    })),
  };
  return {
    profile: WEIGH_PROFILE,
    profile_version: 1,
    state_revision: state.state_revision,
    content,
    manifest: {
      slices: [
        slice('goal', goal ? [goal.evidence] : [], []),
        slice(
          'candidates',
          eligible.flatMap((c) => [...c.evidence]),
          [],
        ),
      ],
    },
  };
}

export function viewHasGammaContent(view: StateView): boolean {
  const encoded = JSON.stringify(view.content);
  return encoded.includes('gamma one') || encoded.includes('"source:gamma"');
}
