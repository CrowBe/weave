export type {
  Authority,
  CapabilityGap,
  EvidenceRecord,
  ExpansionPhase,
  ExpansionWork,
  Fact,
  Goal,
  GoalStatus,
  Observation,
  ObservationKind,
  OpenQuestion,
  SuccessCriteria,
  WeaveState,
} from "./state/index.ts";
export { applyObservation, createState, successCriteriaMet } from "./state/index.ts";

export type { Clock, IdGenerator } from "./ids.ts";
export { ControllableClock, SequenceIds, SystemClock } from "./ids.ts";

export type { Action, ActionKind } from "./action.ts";
export { assignActionIds, enumerateActions } from "./action.ts";

export type {
  DecisionLayer,
  ExpansionDecision,
  ExpansionEvaluation,
  Weight,
  WeightedAction,
} from "./decision/index.ts";
export { HeuristicDecisionLayer } from "./decision/index.ts";

export type { Policy, PolicyContext, PolicyDecision, PolicyRule } from "./policy.ts";
export { ConjunctionPolicy, corePolicy } from "./policy.ts";

export type { ActionFrontier, FrontierRejection } from "./frontier.ts";
export { VIABLE_WEIGHT_THRESHOLD, buildFrontier } from "./frontier.ts";

export { assembleCapabilities, capabilityView, identifyGap } from "./capabilities/index.ts";
export type { GapKind, IdentifiedGap } from "./capabilities/index.ts";
export { checkCandidate } from "./checks/index.ts";
export type { CheckEvidence, TestCorpus } from "./checks/index.ts";

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
  emailNormalizeCorpus,
  emailNormalizeDocument,
  emailNormalizeScripts,
  emailNormalizeSource,
} from "./demo/normalize-email.ts";
