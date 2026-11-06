/**
 * Model-extract schemas for free-text choice sites (WV-S1 P2b).
 *
 * These schemas only name verbatim spans. The extract@1 gate remains the
 * authority: a model proposal never becomes site state unless it is grounded
 * in the original text.
 */
import { defineExtractSchema, type ExtractObservation, type ExtractSchema } from './extract.js';
import type { ModelSite } from './index.js';

export const INPUT_ROUTE_EXTRACT_SCHEMA = 'input.route@1' as const;
export const LOOP_TRIAGE_EXTRACT_SCHEMA = 'loop.triage@1' as const;
export const LOOP_ROUTE_EXTRACT_SCHEMA = 'loop.route@1' as const;
export type ModelExtractSchemaId =
  | typeof INPUT_ROUTE_EXTRACT_SCHEMA
  | typeof LOOP_TRIAGE_EXTRACT_SCHEMA
  | typeof LOOP_ROUTE_EXTRACT_SCHEMA;

function intentSchema(id: ModelExtractSchemaId, instructions: string): ExtractSchema {
  return defineExtractSchema({
    id,
    slots: {
      intent: { kind: 'span', required: true, instructions },
    },
  });
}

export function inputRouteExtractSchema(_state?: unknown): ExtractSchema {
  return intentSchema(INPUT_ROUTE_EXTRACT_SCHEMA, 'The actionable request in the operator input.');
}
export function loopTriageExtractSchema(_state?: unknown): ExtractSchema {
  return intentSchema(LOOP_TRIAGE_EXTRACT_SCHEMA, 'The work the request or state asks for.');
}
export function loopRouteExtractSchema(_state?: unknown): ExtractSchema {
  return intentSchema(LOOP_ROUTE_EXTRACT_SCHEMA, 'The unit of work to route.');
}

export function modelExtractSchema(site: ModelSite, state?: unknown): ExtractSchema {
  switch (site) {
    case 'input.route':
      return inputRouteExtractSchema(state);
    case 'loop.triage':
      return loopTriageExtractSchema(state);
    case 'loop.route':
      return loopRouteExtractSchema(state);
    case 'intake.classify':
      throw new Error('intake.classify uses intake.message@1');
  }
}
export function modelExtractSchemaIdFor(site: ModelSite): ModelExtractSchemaId {
  switch (site) {
    case 'input.route':
      return INPUT_ROUTE_EXTRACT_SCHEMA;
    case 'loop.triage':
      return LOOP_TRIAGE_EXTRACT_SCHEMA;
    case 'loop.route':
      return LOOP_ROUTE_EXTRACT_SCHEMA;
    case 'intake.classify':
      throw new Error('intake.classify uses intake.message@1');
  }
}
/** The only state a grounded extract contributes to a site: a verbatim hint. */
export interface ModelHints {
  readonly schema: ModelExtractSchemaId;
  readonly intent: string | null;
}
export function modelHints(observation: ExtractObservation, original: string): ModelHints {
  const intent = observation.slots.find((slot) => slot.slot === 'intent');
  return {
    schema: observation.extract_schema as ModelExtractSchemaId,
    intent:
      intent?.status === 'grounded' && intent.span !== null
        ? original.slice(intent.span[0], intent.span[1])
        : null,
  };
}
