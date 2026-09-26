export * from './types.js';
export { stableStringify } from './stable-json.js';
export {
  Runtime,
  ScriptedDecisionLayer,
  GatewayDecisionLayer,
  fixtureGateway,
  HOSTED_DESTINATION,
  LOCAL_DESTINATION,
  foldState,
  replay,
  recover,
  traceCompletenessViolations,
  renderFrameView,
  renderWeighView,
  FRAME_PROFILE,
  DEFAULT_FRAME_PROFILE,
  NARROW_FRAME_PROFILE,
  WEIGH_PROFILE,
  type FrameProfile,
  parseProposalText,
  validateProposal,
  proposalCoversSources,
  type RuntimeOptions,
} from './runtime.js';
export { FileJournal, MemoryJournal, PersistError } from './journal.js';
export { ScriptedFoldAuthor, FOLD_CONTRACT, HELD_OUT_MARKER, RETAINED_FOLD_PROCEDURE, canonicalFold, foldSource, visibleFoldCases, heldOutFoldCases } from './fold-author.js';
export {
  ScriptedNormalizeAuthor,
  NORMALIZE_CONTRACT,
  NORMALIZE_COMPOSITION,
  RETAINED_NORMALIZE_PROCEDURE,
  collapseWhitespace,
  normalizeSource,
  visibleNormalizeCases,
  heldOutNormalizeCases,
} from './normalize-author.js';
export type { ExtensionAuthor } from './crystallize-actions.js';
export { PROCEDURE_IDS } from './candidates.js';
export { HOST_INVOCATION_MICROS, reuseVerdict } from './reuse.js';
export {
  CACHE_MISS_DELTA_MICROS,
  CATALOGUE_SLOT_MICROS,
  FRAME_QUALITY_OPERATIONS,
  frameQuality,
  stablePrefixBytes,
  viewBodyBytes,
} from './strategy.js';
