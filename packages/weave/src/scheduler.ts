/**
 * Selection (§7 step 4): ordinal, explainable, stable tie-breaking. Every
 * eligible candidate that is not selected is recorded with its reason.
 */
import { effectsConflict, type ResourceEffect } from '@weave/agentsop';
import type { Candidate, CandidateId, NotSelectedReason, Reservation, State } from './types.js';

export interface Selection {
  readonly selected: readonly Candidate[];
  readonly not_selected: readonly { readonly candidate_id: CandidateId; readonly reason: NotSelectedReason }[];
}

export function select(weighed: readonly Candidate[], state: State): Selection {
  const ordered = [...weighed].sort((a, b) => {
    const wa = a.weight ?? Number.NEGATIVE_INFINITY;
    const wb = b.weight ?? Number.NEGATIVE_INFINITY;
    if (wa !== wb) {
      return wb - wa;
    }
    return a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0;
  });

  const running = Object.values(state.actions).filter(
    (a) => a.state === 'running' || a.state === 'pending' || (a.state === 'uncertain' && !a.reconciled),
  );
  const heldEffects: ResourceEffect[] = running.flatMap((a) => [...a.effects]);
  const remaining: { -readonly [K in keyof Reservation]: number } = {
    actions: state.budget.actions.limit - state.budget.actions.reserved - state.budget.actions.spent,
    judgments: state.budget.judgments.limit - state.budget.judgments.reserved - state.budget.judgments.spent,
  };

  const selected: Candidate[] = [];
  const not_selected: { candidate_id: CandidateId; reason: NotSelectedReason }[] = [];

  for (const candidate of ordered) {
    const reason = rejectReason(candidate, state, heldEffects, remaining);
    if (reason) {
      not_selected.push({ candidate_id: candidate.candidate_id, reason });
      continue;
    }
    selected.push(candidate);
    heldEffects.push(...candidate.effects);
    remaining.actions -= candidate.resources.actions;
    remaining.judgments -= candidate.resources.judgments;
  }
  return { selected, not_selected };
}

function rejectReason(
  candidate: Candidate,
  state: State,
  heldEffects: readonly ResourceEffect[],
  remaining: Reservation,
): NotSelectedReason | null {
  if (!candidate.dependencies.every((id) => state.actions[id]?.state === 'succeeded')) {
    return 'dependency';
  }
  for (const effect of candidate.effects) {
    if (heldEffects.some((held) => held.resource === effect.resource && effectsConflict(held.mode, effect.mode))) {
      return 'conflict';
    }
  }
  for (const entry of candidate.read_set) {
    if (!('resource' in entry)) {
      // No M0 procedure binds a state-field read set; an unknown binding fails closed.
      return 'stale_read_set';
    }
    if (state.sources[entry.resource]?.revision !== entry.revision) {
      return 'stale_read_set';
    }
  }
  if (candidate.resources.actions > remaining.actions || candidate.resources.judgments > remaining.judgments) {
    return 'budget';
  }
  return null;
}
