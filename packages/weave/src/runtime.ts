/**
 * Placeholder runtime. Every entry point rejects so that the M0 checks are
 * observed red against a known-invalid implementation before runtime code is
 * written (docs/m0-inspect-and-report.md §13).
 */
import type { CapabilityHost } from '@weave/agentsop';
import type {
  ActionId,
  DecisionLayer,
  Observation,
  ObservationInput,
  ReplayResult,
  State,
  Trace,
  WeighRequest,
  WeightEntry,
} from './types.js';

export interface RuntimeOptions {
  readonly host: CapabilityHost;
  readonly decisionLayer: DecisionLayer;
}

const NOT_IMPLEMENTED = 'M0 runtime not implemented';

export class Runtime {
  constructor(_options: RuntimeOptions) {}

  /** Append an observation; a cycle runs when it is accepted, external, and a goal is open. */
  observe(_input: ObservationInput): Observation {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Resolves once the named action's result has been integrated into the log. */
  settle(_action_id: ActionId): Promise<void> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  state(): State {
    throw new Error(NOT_IMPLEMENTED);
  }

  trace(): Trace {
    throw new Error(NOT_IMPLEMENTED);
  }
}

export class ScriptedDecisionLayer implements DecisionLayer {
  readonly implementation = 'scripted@1';

  weigh(_request: WeighRequest): readonly WeightEntry[] {
    throw new Error(NOT_IMPLEMENTED);
  }
}

/** Deterministic fold of accepted observations into state (§4). */
export function foldState(_observations: readonly Observation[]): State {
  throw new Error(NOT_IMPLEMENTED);
}

/** Replay a recorded log without invoking the host or the decision layer (§10). */
export function replay(_recorded: readonly Observation[], _options: RuntimeOptions): ReplayResult {
  throw new Error(NOT_IMPLEMENTED);
}

/** M0-C3: returns one message per violation of trace completeness (§9). */
export function traceCompletenessViolations(_trace: Trace): string[] {
  throw new Error(NOT_IMPLEMENTED);
}
