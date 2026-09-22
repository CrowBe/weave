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
}

/** Discloses the fixture catalogue. A tighter profile is a different record. */
export const DEFAULT_FRAME_PROFILE: FrameProfile = {
  id: FRAME_PROFILE,
  version: 1,
  catalogue_budget: 32,
};

export interface CatalogueOp {
  readonly id: string;
  readonly input: Readonly<Record<string, string>>;
}

function slice(
  name: string,
  revisions: readonly Seq[],
  omitted: readonly ViewOmission[],
  truncated = false,
): ViewSliceManifest {
  return { name, revisions, truncated, omitted };
}

/** Framing view: purpose, authorized ids, catalogue shapes. No source bodies. */
export function renderFrameView(
  state: State,
  catalogue: readonly CatalogueOp[],
  profile: FrameProfile = DEFAULT_FRAME_PROFILE,
): StateView {
  const goal = state.goal;
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

  const content = {
    purpose: goal?.purpose ?? '',
    sources: [...(goal?.sources ?? [])],
    authority: { read: [...(goal?.authority.read ?? [])] },
    catalogue: selectedOps.map((id) => {
      const op = catalogue.find((c) => c.id === id);
      return { id, input: op?.input ?? {} };
    }),
    registered: authorizedSources,
  };

  return {
    profile: profile.id,
    profile_version: profile.version,
    state_revision: state.state_revision,
    content,
    manifest: {
      slices: [
        slice('goal', goal ? [goal.evidence] : [], []),
        slice('authority', goal ? [goal.evidence] : [], authorityOmitted),
        slice('catalogue', [], catalogueOmitted, omittedOps.length > 0),
        slice(
          'registered',
          authorizedSources.map((s) => state.sources[s.id]!.evidence),
          [],
        ),
      ],
    },
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
