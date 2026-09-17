export type {
  Authority,
  CapabilityGap,
  CrystallizationPhase,
  CrystallizationWork,
  EvidenceRecord,
  Fact,
  Goal,
  GoalStatus,
  Observation,
  ObservationKind,
  OpenQuestion,
  SuccessCriteria,
  Thread,
  UserInputPayload,
  WeaveState,
} from "./state.ts";
export { applyObservation, createState, successCriteriaMet } from "./state.ts";

export type { Clock, IdGenerator } from "./ids.ts";
export { ControllableClock, SequenceIds, SystemClock } from "./ids.ts";

export type { Action, ActionKind } from "./action.ts";
export { assignActionIds, canExecute, enumerateActions } from "./action.ts";

export type { DecisionLayer, Weight, WeightedAction } from "./decision.ts";
export { HeuristicDecisionLayer } from "./decision.ts";

export type { Policy, PolicyContext, PolicyDecision, PolicyRule } from "./policy.ts";
export { ConjunctionPolicy, corePolicy } from "./policy.ts";

export type { ActionFrontier, FrontierRejection } from "./frontier.ts";
export { VIABLE_WEIGHT_THRESHOLD, buildFrontier } from "./frontier.ts";

export type { AdmittedCapability } from "./registry.ts";
export { CapabilityRegistry } from "./registry.ts";

export type {
  InferenceKind,
  InferenceProvider,
  InferenceQuality,
  InferenceRequest,
  InferenceRouter,
  ModelBinding,
} from "./inference.ts";
export { CheapestSufficientRouter, ScriptedInferenceProvider } from "./inference.ts";

export type { CycleRecord, RuntimeOptions } from "./runtime.ts";
export { Runtime } from "./runtime.ts";

export {
  lowercaseOnlySource,
  normalizeEmailCandidate,
  normalizeEmailContract,
  normalizeEmailCorpus,
  normalizeEmailScripts,
  normalizeEmailSource,
} from "./demo/normalize-email.ts";
