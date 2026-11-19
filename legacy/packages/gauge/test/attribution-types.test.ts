import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AbstentionAttributionDecision,
  AttributionCategory,
  AttributionDecision,
  AttributionDecisionInput,
  AttributionEvidenceBundle,
  AttributionIdInputs,
  AttributionRevisions,
  DeterministicAttributionDecision,
  EvidenceRef,
  JudgmentAttributionDecision,
  WireAttributionCategory,
} from '@weave/gauge';

/**
 * Compile-time conformance for the slice-1a attribution contract. The positive
 * fixtures must typecheck; each `@ts-expect-error` must be consumed by the
 * diagnostic it describes, so the build fails if a type becomes too permissive.
 */

const evidence: readonly EvidenceRef[] = [{ source: 'check', ref: 'check-1' }];

test('the pure input and decision types accept a deterministic tune decision', () => {
  const bundle: AttributionEvidenceBundle = {
    weft: [],
    checks: [],
    observations: [],
    search: [],
    route: [],
    schedule: [],
  };
  const revisions: AttributionRevisions = {
    classifier_revision: `sha256:${'a'.repeat(64)}`,
    rule_revision: `sha256:${'b'.repeat(64)}`,
    prompt_revision: null,
    model_revision: null,
  };
  const input: AttributionDecisionInput = {
    result: 'result@1',
    case: 'case-1',
    split: 'tune',
    bundle,
    revisions,
    judgment_request: null,
  };
  const id: AttributionIdInputs = {
    result: input.result,
    case: input.case,
    evidence_bundle_digest: `sha256:${'c'.repeat(64)}`,
    classifier_revision: revisions.classifier_revision,
    rule_revision: revisions.rule_revision,
    prompt_revision: revisions.prompt_revision,
    model_revision: revisions.model_revision,
    judgment_request_digest: null,
  };
  const deterministic: DeterministicAttributionDecision = {
    category: 'capability_gap',
    basis: 'deterministic',
    signal: 'no_contract_matched',
    confidence: null,
    evidence,
  };
  const judgment: JudgmentAttributionDecision = {
    category: 'capability_gap',
    basis: 'judgment',
    signal: null,
    confidence: 0.5,
    evidence,
  };
  const abstention: AbstentionAttributionDecision = {
    category: 'unattributed',
    basis: 'none',
    signal: null,
    confidence: null,
    evidence,
  };
  const decision: AttributionDecision = deterministic;
  const wire: WireAttributionCategory<'capability'> = 'capability_gap';

  assert.equal(decision.category, 'capability_gap');
  assert.equal(wire, 'capability_gap');
  assert.equal(id.judgment_request_digest, null);
  assert.equal(judgment.confidence, 0.5);
  assert.equal(abstention.basis, 'none');
});

test('the types reject conceptual wire values, a judgment receipt in the bundle and malformed decisions', () => {
  // @ts-expect-error the wire category is capability_gap, never the conceptual capability
  const conceptualOnWire: AttributionCategory = 'capability';

  const withReceipt: AttributionEvidenceBundle = {
    weft: [],
    checks: [],
    observations: [],
    search: [],
    route: [],
    schedule: [],
    // @ts-expect-error the judgment receipt is cited evidence only, never part of the evidence bundle
    judgment_receipt: 'receipt-1',
  };

  // @ts-expect-error a capability gap has exactly one signal
  const wrongSignal: DeterministicAttributionDecision = {
    category: 'capability_gap',
    basis: 'deterministic',
    signal: 'implementation_failed',
    confidence: null,
    evidence,
  };

  const missingConfidence: JudgmentAttributionDecision = {
    category: 'routing',
    basis: 'judgment',
    signal: null,
    // @ts-expect-error judgment requires a confidence
    confidence: null,
    evidence,
  };

  const attributedAbstention: AbstentionAttributionDecision = {
    category: 'unattributed',
    // @ts-expect-error an abstention has basis none
    basis: 'deterministic',
    signal: null,
    confidence: null,
    evidence,
  };

  const badId: AttributionIdInputs = {
    result: 'result@1',
    case: 'case-1',
    // @ts-expect-error revision and bundle digests are strings checked with Weft isDigest at the producer
    evidence_bundle_digest: 1,
    classifier_revision: `sha256:${'a'.repeat(64)}`,
    rule_revision: `sha256:${'b'.repeat(64)}`,
    prompt_revision: null,
    model_revision: null,
    judgment_request_digest: null,
  };

  assert.equal(conceptualOnWire, 'capability');
  assert.equal(withReceipt.weft.length, 0);
  assert.equal(wrongSignal.signal, 'implementation_failed');
  assert.equal(missingConfidence.confidence, null);
  assert.equal(attributedAbstention.basis, 'deterministic');
  assert.equal(badId.case, 'case-1');
});
