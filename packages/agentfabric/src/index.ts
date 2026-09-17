export type { JsonSchema, SchemaViolation } from "./schema.ts";
export { deepEqual, validateSchema } from "./schema.ts";

export type {
  CapabilityContract,
  EffectName,
  ExecutionConstraints,
  FailureMode,
  Maturity,
  PermissionName,
  Provenance,
} from "./contract.ts";
export { assertContract } from "./contract.ts";

export type {
  ExecutionError,
  ExecutionResult,
  ImplementationCandidate,
  ImplementationKind,
  ImplementationRuntime,
} from "./implementation.ts";
export {
  InProcessRuntime,
  implementationForContract,
  normalizeError,
  placeholderImplementation,
} from "./implementation.ts";

export type {
  TestCase,
  TestCorpus,
  TestResult,
  TestVisibility,
} from "./corpus.ts";
export {
  assertCorpus,
  developmentCases,
  heldOutCases,
  runCases,
} from "./corpus.ts";

export type {
  AdmissionVerdict,
  CrystallizationRecord,
  GreenEvidence,
  RedEvidence,
} from "./lifecycle.ts";
export {
  demonstrateRed,
  evaluateAdmissionEligibility,
  evaluateHeldOut,
  proveGreen,
  runCrystallizationPipeline,
} from "./lifecycle.ts";
