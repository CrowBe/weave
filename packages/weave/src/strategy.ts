/**
 * One operating-strategy experiment (docs/m5-improve-an-operating-strategy.md).
 *
 * The candidate is a profile record. Comparison, the quality bar, and the
 * promotion rule are deterministic. A cache miss is one fixture delta.
 */
import type { BaselineRecord, ExperimentComparedPayload, ExperimentRecord, StateView } from './types.js';
import { stableStringify } from './stable-json.js';
import type { FrameProfile } from './views.js';

/** One reserved micros per catalogue slot the profile declares. Counted once. */
export const CATALOGUE_SLOT_MICROS = 1_000;

/**
 * Fixture cost of one stable-prefix miss. It is not a second copy of the
 * prefix tokens and not a provider bill.
 */
export const CACHE_MISS_DELTA_MICROS = 1_000;

/** Operations `composition.normalize-report@1` needs disclosed as ids and input shapes. */
export const FRAME_QUALITY_OPERATIONS = ['source.inspect', 'text.normalize', 'report.assemble'] as const;

export const CORE_PATCH_TARGETS = ['scheduler', 'policy', 'admission', 'procedure_union'] as const;

export function isCorePatch(candidate: unknown): boolean {
  if (!isRecord(candidate)) {
    return false;
  }
  const target = candidate['target'];
  return typeof target === 'string' && (CORE_PATCH_TARGETS as readonly string[]).includes(target);
}

export function stablePrefixBytes(profile: FrameProfile, view: StateView): string {
  const content = view.content;
  const catalogue = isRecord(content)
    ? Array.isArray(content['catalogue'])
      ? content['catalogue']
      : Array.isArray(content['catalogue_index'])
        ? content['catalogue_index']
        : []
    : [];
  return stableStringify({
    profile: profile.id,
    profile_version: profile.version,
    prefix: profile.prefix ?? '',
    catalogue,
  });
}

export function viewBodyBytes(view: StateView): string {
  return stableStringify(view.content);
}

export function frameQuality(
  view: StateView,
  required: readonly string[] = FRAME_QUALITY_OPERATIONS,
): { quality: 'held' | 'missed'; misses: string[] } {
  const misses: string[] = [];
  const content = view.content;
  if (!isRecord(content) || Object.keys(content).length === 0) {
    misses.push('empty');
  }
  const ids = catalogueIds(content);
  for (const operation of required) {
    if (!ids.has(operation)) {
      misses.push(`dropped:${operation}`);
    }
  }
  return { quality: misses.length === 0 ? 'held' : 'missed', misses };
}

export function profileReservation(profile: FrameProfile, prefixStable: boolean): {
  token_micros: number;
  cache_miss_delta: number;
  cost_micros: number;
} {
  const token_micros = profile.catalogue_budget * CATALOGUE_SLOT_MICROS;
  const cache_miss_delta = prefixStable ? 0 : CACHE_MISS_DELTA_MICROS;
  return { token_micros, cache_miss_delta, cost_micros: token_micros + cache_miss_delta };
}

export function measureCandidate(input: {
  experimentId: string;
  deadlineTick: number;
  baseline: FrameProfile;
  candidate: FrameProfile;
  baselineView: StateView;
  candidateView: StateView;
  humanCorrections: number;
  latencyTicks: number;
}): ExperimentComparedPayload {
  const prefix_stable = stablePrefixBytes(input.baseline, input.baselineView) === stablePrefixBytes(input.candidate, input.candidateView);
  const reserved = profileReservation(input.candidate, prefix_stable);
  const baselineCost = profileReservation(input.baseline, true);
  const quality = frameQuality(input.candidateView);
  return {
    experiment_id: input.experimentId,
    candidate: input.candidate.id,
    baseline: 'profile.frame@1',
    quality: quality.quality,
    misses: quality.misses,
    human_corrections: input.humanCorrections,
    latency_ticks: input.latencyTicks,
    cost_micros: reserved.cost_micros,
    baseline_cost_micros: baselineCost.cost_micros,
    prefix_stable,
    cache_miss_delta: reserved.cache_miss_delta,
    token_micros: reserved.token_micros,
    deadline_tick: input.deadlineTick,
  };
}

/**
 * Promotion rule from the contract. Null means the candidate may be promoted.
 * The caller still requires an operator observation.
 */
export function promotionRefusal(
  experiment: ExperimentRecord,
  comparison: { evidence: number; quality: 'held' | 'missed'; misses: readonly string[]; human_corrections: number; latency_ticks: number; cost_micros: number; baseline_cost_micros: number } | undefined,
  baseline: BaselineRecord | null,
): string | null {
  if (experiment.invalidated) {
    return 'comparison invalidated';
  }
  if (!comparison || comparison.evidence <= experiment.evidence) {
    return 'comparison missing';
  }
  if (!baseline) {
    return 'baseline missing';
  }
  if (comparison.quality !== 'held' || comparison.misses.length > 0) {
    return 'quality bar missed';
  }
  if (comparison.human_corrections > baseline.human_corrections) {
    return 'human corrections increased';
  }
  const costImproves = comparison.cost_micros < comparison.baseline_cost_micros;
  const latencyImproves = comparison.latency_ticks < baseline.latency_ticks;
  if (!costImproves && !latencyImproves) {
    return 'no improvement';
  }
  return null;
}

export function amendmentMovesProtocol(experiment: ExperimentRecord, payload: Record<string, unknown>): boolean {
  if (Array.isArray(payload['protected_cases'])) {
    const next = payload['protected_cases'].map((item) => String(item)).join('\n');
    if (next !== experiment.protected_cases.join('\n')) {
      return true;
    }
  }
  if (typeof payload['quality_bar'] === 'string' && payload['quality_bar'] !== experiment.quality_bar) {
    return true;
  }
  if (typeof payload['success_evidence'] === 'string' && payload['success_evidence'] !== experiment.quality_bar) {
    return true;
  }
  return false;
}

function catalogueIds(content: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(content)) {
    return ids;
  }
  const entries = Array.isArray(content['catalogue_index'])
    ? content['catalogue_index']
    : Array.isArray(content['catalogue'])
      ? content['catalogue']
      : [];
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry['id'] === 'string') {
      ids.add(entry['id']);
    }
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
