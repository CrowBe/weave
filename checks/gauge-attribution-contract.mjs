#!/usr/bin/env node
/**
 * WV-195 slice 1a: Gauge attribution contract.
 *
 * The pure attribution input/decision types and the pre-judgment id rule must
 * stay aligned with the contract text. This source-shape check pins the exported
 * names and the derivation rule that slices 2 and 3 build on. The compile-time
 * fixtures in `packages/gauge/test/attribution-types.test.ts` are the build
 * gate that proves valid facts typecheck and malformed ones do not.
 *
 * Usage: node checks/gauge-attribution-contract.mjs [root]. The root defaults
 * to the repository.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname);
const read = (path) => readFileSync(join(root, path), 'utf8');

const contract = read('packages/gauge/src/GAUGE-CONTRACT.md');
const types = read('packages/gauge/src/types.ts');
const glossary = read('GLOSSARY.md');

const TYPE_EXPORTS = [
  'ConceptualAttributionCategory',
  'WireAttributionCategory',
  'DeterministicSignals',
  'DeterministicSignal',
  'WeftEvidenceFact',
  'CheckEvidenceFact',
  'ObservationEvidenceFact',
  'SearchInventoryFact',
  'RouteInventoryFact',
  'ScheduleInventoryFact',
  'AttributionEvidenceBundle',
  'AttributionRevisions',
  'AttributionJudgmentRequest',
  'AttributionDecisionInput',
  'AttributionIdInputs',
  'AttributionDecision',
];

const CONTRACT_TEXT = [
  '## Attribution facts and decision inputs',
  'AttributionEvidenceBundle',
  'AttributionDecisionInput',
  'AttributionDecision',
  'AttributionIdInputs',
  'judgment receipt is cited evidence only',
  'excluded from this bundle digest and the identity',
  'gauge.attribution-id@1',
  'evidence_bundle_digest',
  'classifier_revision',
  'rule_revision',
  'prompt_revision',
  'model_revision',
  'judgment_request_digest',
  'recordDigest',
  'explicit null when no judgment is requested',
  'Weft `isDigest`',
  'sha256:',
  '64 lowercase hex',
  '`g7:`',
  '67-character id',
  '[0-9a-f]',
  'capability_gap',
  'pre-judgment',
  'deterministic',
  'judgment',
];

const GLOSSARY_TEXT = [
  '### Attribution evidence bundle',
  '### Attribution abstention',
  '### Judgment request digest',
  '`capability_gap`',
  'deterministic',
  'judgment',
];

/** Match contract prose regardless of how it is wrapped. */
const squash = (text) => text.replace(/\s+/g, ' ');

const violations = [];

for (const name of TYPE_EXPORTS) {
  if (!types.includes(`export interface ${name}`) && !types.includes(`export type ${name}`)) {
    violations.push(`packages/gauge/src/types.ts: missing exported ${name}`);
  }
}

for (const text of CONTRACT_TEXT) {
  if (!squash(contract).includes(squash(text)))
    violations.push(`packages/gauge/src/GAUGE-CONTRACT.md: missing "${text}"`);
}

for (const text of GLOSSARY_TEXT) {
  if (!squash(glossary).includes(squash(text))) violations.push(`GLOSSARY.md: missing "${text}"`);
}

if (violations.length > 0) {
  console.error('Gauge attribution contract FAIL: the slice-1a contract has drifted');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(
  `Gauge attribution contract OK: ${TYPE_EXPORTS.length} exported types, ${CONTRACT_TEXT.length} contract clauses, ${GLOSSARY_TEXT.length} glossary clauses`,
);
