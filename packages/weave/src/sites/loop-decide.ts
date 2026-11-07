/**
 * Extract-composed decisions for the loop sites (WV-S1 P2c).
 *
 * `loop.triage` and `loop.route` read free text, so they are asked only after a
 * model extraction has been gated against the disclosed state. The extract is
 * the typed-state origin; a missing, non-final, foreign or cancelled record
 * fails closed before the choice site can call a provider.
 */
import type { EvaluationContent, InferenceGateway, InferenceTerms } from '@weave/gateway';
import { stableStringify } from '../stable-json.js';
import {
  correlation,
  evaluateSite,
  modelOrigin,
  originReason,
  transitionSite,
  type RecordedSiteAnswer,
  type SiteInput,
  type SiteState,
  type SiteTransition,
} from './index.js';
import {
  attemptExtract,
  observeExtract,
  type ExtractCall,
  type ExtractObservation,
  type ExtractSchema,
  type RecordedExtract,
} from './extract.js';
import { modelExtractSchema } from './model-extract.js';

export const LOOP_DECISION_SITES = ['loop.triage', 'loop.route'] as const;
export type LoopDecisionSite = (typeof LOOP_DECISION_SITES)[number];
export const LOOP_TRIAGE_EXTRACT_SITE = 'loop.triage.extract' as const;
export const LOOP_ROUTE_EXTRACT_SITE = 'loop.route.extract' as const;

/** The caller's disclosed state, terms and reading; no origin is supplied here. */
export interface LoopDecisionAsk extends SiteState {
  readonly request_id: string;
  readonly state: EvaluationContent;
  readonly terms: InferenceTerms;
  readonly needs_dispatch: boolean;
}

/** Journalable record: the gated extract attempts and the site transition. */
export interface LoopDecision {
  readonly schema: 'loop.decision@1';
  readonly request_id: string | null;
  readonly extracts: readonly ExtractObservation[];
  readonly site: SiteTransition;
}

export type LoopExtractRecord = ExtractObservation | RecordedExtract;
export type LoopRecordedSite = RecordedSiteAnswer | SiteTransition;

/** Replay input: recorded extracts and an optional recorded site answer or transition. */
export interface RecordedLoopDecision {
  readonly extracts: readonly LoopExtractRecord[];
  readonly site?: LoopRecordedSite | null;
}

function extractSiteFor(site: LoopDecisionSite): string {
  return site === 'loop.triage' ? LOOP_TRIAGE_EXTRACT_SITE : LOOP_ROUTE_EXTRACT_SITE;
}

function capture(ask: LoopDecisionAsk): LoopDecisionAsk {
  return {
    request_id: ask.request_id,
    state_revision: ask.state_revision,
    state_updated_at: ask.state_updated_at,
    state: structuredClone(ask.state),
    terms: { ...ask.terms, destinations: [...ask.terms.destinations] },
    needs_dispatch: ask.needs_dispatch,
  };
}

function originalFor(ask: LoopDecisionAsk): string {
  return stableStringify(ask.state);
}

function callFor(
  site: LoopDecisionSite,
  ask: LoopDecisionAsk,
  schema: ExtractSchema,
  attempt: 1 | 2,
  feedback?: string,
): ExtractCall {
  return {
    site,
    extract_site: extractSiteFor(site),
    schema,
    original: originalFor(ask),
    prompt: stableStringify(ask.state),
    request_id: `${ask.request_id}:x${attempt}`,
    attempt,
    state_revision: ask.state_revision,
    state_updated_at: ask.state_updated_at,
    terms: ask.terms,
    ...(feedback === undefined ? {} : { feedback }),
  };
}

function feedbackFor(observation: ExtractObservation): string {
  const issues = observation.slots
    .filter((slot) => slot.status === 'ungrounded' || slot.status === 'out_of_set')
    .map((slot) => `${slot.slot}: ${slot.status}`);
  return issues.length > 0
    ? `The previous extraction was not faithful: ${issues.join('; ')}. Copy only text that appears verbatim in the state, or use null.`
    : 'The previous extraction could not be used. Return only the required JSON object, copying text verbatim from the state, or use null.';
}

function needsSecond(observation: ExtractObservation): boolean {
  return (
    observation.verdict === 're_extract' &&
    observation.reason !== 'cancelled' &&
    observation.reason !== 'stale_answer'
  );
}

function decision(ask: LoopDecisionAsk, extracts: readonly ExtractObservation[], site: SiteTransition): LoopDecision {
  return {
    schema: 'loop.decision@1',
    request_id: correlation(ask.request_id),
    extracts,
    site,
  };
}

function isObservation(value: LoopExtractRecord): value is ExtractObservation {
  return (value as { readonly schema?: unknown }).schema === 'extract@1';
}

function isTransition(value: LoopRecordedSite): value is SiteTransition {
  return (value as { readonly observation?: unknown }).observation !== undefined;
}

function observationsFor(
  site: LoopDecisionSite,
  ask: LoopDecisionAsk,
  records: readonly LoopExtractRecord[],
): readonly ExtractObservation[] {
  const schema = modelExtractSchema(site, ask.state);
  return records.map((value) =>
    isObservation(value) ? value : observeExtract(callFor(site, ask, schema, value.attempt), value),
  );
}

function siteInput(ask: LoopDecisionAsk, origin?: SiteInput['origin']): SiteInput {
  return {
    request_id: ask.request_id,
    state_revision: ask.state_revision,
    state_updated_at: ask.state_updated_at,
    state: ask.state,
    terms: ask.terms,
    needs_dispatch: ask.needs_dispatch,
    ...(origin === undefined ? {} : { origin }),
  };
}

function missingAnswer(ask: LoopDecisionAsk, current: SiteState): RecordedSiteAnswer {
  return {
    state_revision: ask.state_revision,
    observed_at: current.state_updated_at,
    outcome: null,
  };
}

/** Pure record construction and replay from recorded extracts; no port is touched. */
export function transitionLoopDecision(
  site: LoopDecisionSite,
  ask: LoopDecisionAsk,
  recorded: RecordedLoopDecision,
  current: SiteState,
): LoopDecision {
  if (recorded.extracts.length > 2) throw new Error('loop decision needs at most two extract observations');
  const captured = capture(ask);
  const observations = observationsFor(site, captured, recorded.extracts);
  const final = observations[observations.length - 1];
  const input = siteInput(captured, final === undefined ? undefined : modelOrigin(final));
  const recordedSite = recorded.site ?? null;
  if (recordedSite !== null && isTransition(recordedSite) && final !== undefined && originReason(site, input) === null)
    return decision(captured, observations, recordedSite);
  const answer = recordedSite === null || isTransition(recordedSite) ? missingAnswer(captured, current) : recordedSite;
  const transition = transitionSite(site, input, answer, current);
  return decision(captured, observations, transition);
}

export function transitionTriage(
  ask: LoopDecisionAsk,
  recorded: RecordedLoopDecision,
  current: SiteState,
): LoopDecision {
  return transitionLoopDecision('loop.triage', ask, recorded, current);
}

export function transitionLoopRoute(
  ask: LoopDecisionAsk,
  recorded: RecordedLoopDecision,
  current: SiteState,
): LoopDecision {
  return transitionLoopDecision('loop.route', ask, recorded, current);
}

async function decideLoop(
  site: LoopDecisionSite,
  ask: LoopDecisionAsk,
  port: Pick<InferenceGateway, 'generate' | 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<LoopDecision> {
  const captured = capture(ask);
  const schema = modelExtractSchema(site, captured.state);
  const extracts: ExtractObservation[] = [];
  const first = await attemptExtract(callFor(site, captured, schema, 1), port, now, signal);
  extracts.push(first.observation);
  if (needsSecond(first.observation)) {
    const second = await attemptExtract(
      callFor(site, captured, schema, 2, feedbackFor(first.observation)),
      port,
      now,
      signal,
    );
    extracts.push(second.observation);
  }
  const final = extracts[extracts.length - 1]!;
  const transition = await evaluateSite(site, siteInput(captured, modelOrigin(final)), port, now, signal);
  return decision(captured, extracts, transition);
}

/** Extract, gate, then ask `loop.triage` through the injected ports. */
export async function decideTriage(
  ask: LoopDecisionAsk,
  port: Pick<InferenceGateway, 'generate' | 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<LoopDecision> {
  return decideLoop('loop.triage', ask, port, now, signal);
}

/** Extract, gate, then ask `loop.route`; `decideRoute` for `input.route` is unchanged. */
export async function decideLoopRoute(
  ask: LoopDecisionAsk,
  port: Pick<InferenceGateway, 'generate' | 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<LoopDecision> {
  return decideLoop('loop.route', ask, port, now, signal);
}
