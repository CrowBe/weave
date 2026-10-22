/**
 * The weighers compared on the case set. Every typed weigher goes through the
 * same `GatewayDecisionLayer` and `frontier.weigh@1` questions; only the
 * evaluation adapter behind the routed unit differs.
 */
import type { EvaluationAdapter, EvaluationCall, InferenceGateway } from '@weave/gateway';
import {
  fixtureGateway,
  GatewayDecisionLayer,
  LOCAL_DESTINATION,
  ScriptedDecisionLayer,
  type WeighRequest,
  type WeightEntry,
} from '@weave/weave';
import type { BuiltCase } from './build.ts';

export type WeigherKind = 'scripted' | 'fixture' | 'jev';

export interface WeighOutcome {
  readonly status: 'accepted' | 'unaccepted' | 'blocked' | 'failed';
  readonly reason: string | null;
  readonly weights: readonly WeightEntry[];
  readonly contract: 'frontier.weigh@1' | undefined;
  readonly implementation: string;
  /** Accounted micros; 0 for scripted weighing. */
  readonly spent: number;
  readonly attempts: number;
  /** Wall-clock milliseconds, measured only by the composition root. */
  readonly latency_ms: number | null;
}

export interface Weigher {
  readonly id: string;
  readonly kind: WeigherKind;
  weigh(built: BuiltCase): Promise<WeighOutcome>;
}

export function weighRequest(built: BuiltCase): WeighRequest {
  return {
    site: 'frontier.weigh',
    state_revision: built.view.state_revision,
    candidate_set: built.candidate_set,
    candidates: built.eligible,
    view: built.view,
    cost_ceiling: 10_000,
  };
}

/** `scripted@1`, the baseline and the runtime default: weights by operation only, no floor. */
export function scriptedWeigher(): Weigher {
  const layer = new ScriptedDecisionLayer();
  return {
    id: 'scripted@1',
    kind: 'scripted',
    async weigh(built) {
      return {
        status: 'accepted',
        reason: null,
        weights: layer.weigh(weighRequest(built)),
        contract: undefined,
        implementation: layer.implementation,
        spent: 0,
        attempts: 0,
        latency_ms: null,
      };
    },
  };
}

/** Any routed unit behind the `frontier.weigh@1` site. */
export function siteWeigher(
  id: string,
  kind: WeigherKind,
  gateway: InferenceGateway,
  destinations: readonly string[],
  measure?: () => number,
): Weigher {
  const layer = new GatewayDecisionLayer(gateway, destinations);
  return {
    id,
    kind,
    async weigh(built) {
      const started = measure?.();
      const result = await layer.weigh(weighRequest(built));
      const finished = measure?.();
      return {
        status: result.status ?? (result.weights.length > 0 ? 'accepted' : 'unaccepted'),
        reason: result.reason ?? null,
        weights: result.weights,
        contract: result.contract,
        implementation: result.implementation ?? layer.implementation,
        spent: result.spent ?? 0,
        attempts: result.attempts?.length ?? 0,
        latency_ms: started === undefined || finished === undefined ? null : finished - started,
      };
    },
  };
}

/** A fixture routed unit that answers every question from `score`. Offline only; never evidence about a model. */
export function fixtureWeigher(id: string, score: (call: EvaluationCall, candidate_id: string) => number): Weigher {
  const adapter: EvaluationAdapter = {
    id: `fixture.${id}`,
    async evaluate(call) {
      const answers: Record<string, { type: 'score'; score: number }> = {};
      for (const candidate_id of Object.keys(call.questions)) {
        answers[candidate_id] = { type: 'score', score: score(call, candidate_id) };
      }
      return {
        status: 'completed',
        answers,
        usage: { input_tokens: 0, output_tokens: 0 },
        provider_response_id: undefined,
        confidence: undefined,
      };
    },
  };
  return siteWeigher(id, 'fixture', fixtureGateway({ clock: { now: () => 0 }, evaluate: adapter }), [
    LOCAL_DESTINATION,
  ]);
}

/** Red controls: unsuitable weighers the promotion rule must reject. */
export function constantWeigher(level: 0 | 2): Weigher {
  return fixtureWeigher(level === 2 ? 'constant-dispatch' : 'constant-defer', () => level);
}
