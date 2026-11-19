// C1 test-only seams and deliberate invalid placeholders. No runtime import path
// uses this module. Byte-token units below belong only to synthetic fixtures.
import assert from 'node:assert/strict';
import { payloadBytes } from '../src/log-bound.js';

export interface Probe {
  ceiling: number;
  full: number;
  required: number;
  mode?: 'refuse' | 'drop_optional';
  markerRequired?: number;
  invalid?: { reason: string; code: string; position?: object[] };
  body?: unknown;
  limits?: { max_depth: number; max_nodes: number };
  expected_inventory?: string[];
  expected_bodies?: unknown[];
  parts?: { name: string; class: string; body: unknown; path?: string; link?: string }[];
  coverage?: string;
  operands?: number[];
}
export interface Answer {
  status: 'fits' | 'overflow';
  reason?: string;
  code?: string;
  ceiling_tokens?: number;
  total_tokens?: number;
  required_tokens?: number;
  over_by_tokens?: number;
  total_over_by_tokens?: number;
  witness?: { part: string; code: string; position: object[] };
  used_tokens?: number;
  included?: string[];
  bodies?: unknown[];
  dispatches: number;
  diagnostics: readonly string[];
}
export type Subject = (input: Probe) => Answer;
export const alwaysFit: Subject = (input) => ({
  status: 'fits',
  used_tokens: input.full,
  included: input.parts?.map((part) => part.name) ?? [],
  bodies: input.parts?.map((part) => part.body) ?? [],
  dispatches: 0,
  diagnostics: [],
});
export const rejectEverything: Subject = () => ({
  status: 'overflow',
  reason: 'invalid_part',
  code: 'node_limit',
  dispatches: 0,
  diagnostics: [],
});
// Deliberately uses a markers-inclusive diagnostic before testing the full input.
export const requiredFirst: Subject = (input) => ({
  status: 'overflow',
  reason: 'required_exceeds_ceiling',
  ceiling_tokens: input.ceiling,
  total_tokens: input.full,
  required_tokens: input.markerRequired ?? input.required,
  over_by_tokens: (input.markerRequired ?? input.required) - input.ceiling,
  total_over_by_tokens: input.full - input.ceiling,
  dispatches: 0,
  diagnostics: [],
});
export const trimRequired: Subject = (input) => ({
  status: 'fits',
  used_tokens: input.ceiling,
  included: [],
  bodies: [],
  dispatches: 0,
  diagnostics: [],
});
export const leakedInvalid: Subject = (input) => ({
  status: 'overflow',
  ...input.invalid,
  total_tokens: NaN,
  diagnostics: ['SECRET-OFFENDING-KEY'],
  dispatches: 1,
});

const hex = 'f'.repeat(64);
export const MAX = Number.MAX_SAFE_INTEGER;
export const largestActionId = `a:${MAX}:${MAX}`;
export const largestWeighAttempt = `inf:c${MAX}:weigh`;
export function maximumMarker(site: 'goal.frame' | 'frontier.weigh') {
  return {
    decision_id: `ctx:${hex}`,
    owner: {
      site,
      owner_scope: hex,
      logical_attempt: site === 'goal.frame' ? largestActionId : largestWeighAttempt,
      candidate_set: site === 'goal.frame' ? null : hex,
    },
    fit_input_digest: hex,
    policy_digest: hex,
    storage_policy_digest: hex,
    code: 'evidence_record_too_large',
    attempted_type: 'inference.requested@2',
    attempted_payload_bytes: MAX,
    max_observation_bytes: MAX - 1,
    attempted_decision_digest: hex,
  };
}
export function maximumStoppedResult() {
  return {
    action_id: largestActionId,
    outcome: { outcome: 'failed', failure: 'context_persistence_failure' },
    context_decision_id: `ctx:${hex}`,
  };
}
export const encodedMaxima = {
  marker_frame: payloadBytes(maximumMarker('goal.frame')),
  marker_weigh: payloadBytes(maximumMarker('frontier.weigh')),
  stopped_result: payloadBytes(maximumStoppedResult()),
};

// Default runs validate that the corpus kills its named mutations. WV353_RED=1
// runs the SAME assertions uncaught, exposing real behavioral assertion failures.
export function demonstrateRed(check: () => void): void {
  if (process.env['WV353_RED'] === '1') check();
  else assert.throws(check, assert.AssertionError, 'the invalid placeholder must fail a behavioral assertion');
}
