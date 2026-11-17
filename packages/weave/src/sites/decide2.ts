/**
 * Decide-2 (WV-S1 P4c): pick one disclosed catalogue entry, then extract only its args.
 *
 * Each entry is an isolated relevance judgment (D3's per-entry shape), and the pick is a pure
 * margin rule over those probabilities. The pick and the args extract are observations; the
 * Decide-1 rule table decides what happens, and nothing here confers dispatch authority.
 */
import type { EvaluationOutcome, InferenceGateway, InferenceTerms } from '@weave/gateway';
import { stableStringify } from '../stable-json.js';
import { admissionReason, correlation, unit, type SiteState } from './index.js';
import {
  attemptExtract,
  defineExtractSchema,
  type ExtractCall,
  type ExtractObservation,
  type ExtractSchema,
} from './extract.js';

export const DECIDE2_SITE = 'decide2.pick' as const;
export const DECIDE2_ARGS_SITE = 'decide2.args' as const;
export const DECIDE2_ARGS_EXTRACT_SITE = 'decide2.args.extract' as const;
export const DECIDE2_ARGS_SCHEMA = 'decide2.args@1' as const;
/** The question text is part of decide2-pick@1; changing it requires a new schema. */
export const DECIDE2_QUESTION = 'Is this disclosed catalogue entry the one tool this request needs?';
/**
 * Provisional Decide-2 floors (§3 "Gauge before lock"). D3's margin numbers, reused, not a
 * SITE_POLICY or BOOLEAN_SITE_POLICY entry: those tables are frozen benchmark configuration.
 */
export const DECIDE2_POLICY = Object.freeze({
  confidence: 0.75,
  /** Absolute relevance floor (= max_runner_up + min_margin): a lone weak entry is not a pick. */
  min_top: 0.7,
  min_margin: 0.3,
  max_runner_up: 0.4,
  entries: 8,
  args: 8,
} as const);

/** One disclosed M6 catalogue index entry. `reversible` and `required` are host contract facts. */
export interface CatalogueEntry {
  readonly ref: string;
  readonly purpose: string;
  readonly reversible: boolean;
  readonly args: readonly { readonly name: string; readonly required: boolean }[];
}
export type Decide2Reason =
  | 'answered'
  | 'no_answer'
  | 'invalid_answer'
  | 'stale_answer'
  | 'mismatched_answer'
  | 'decision_unavailable'
  | 'cancelled';
export interface Decide2Ask extends SiteState {
  /** The decision id; the site request id is `<request_id>:decide2`. */
  readonly request_id: string;
  /** Already filtered for disclosure; never copied into a record. */
  readonly state: { readonly request: string; readonly context: string };
  readonly catalogue: readonly CatalogueEntry[];
  /** D1's grounded intent span, or null. Shown to the args extract, never recorded. */
  readonly intent: string | null;
  readonly terms: InferenceTerms;
}
export interface Decide2Observation {
  readonly schema: 'decide2-pick@1';
  readonly site: typeof DECIDE2_SITE;
  readonly question: string;
  readonly request_id: string | null;
  readonly state_revision: number;
  readonly entries: readonly {
    readonly ref: string;
    readonly p: number | null;
    readonly confidence: number | null;
  }[];
  readonly reason: Decide2Reason;
  readonly provider_request_id: string | null;
}
export interface RecordedDecide2Answer {
  readonly state_revision: number;
  readonly observed_at: number;
  readonly outcome: EvaluationOutcome<'boolean'> | null;
  readonly cancelled?: boolean;
}
/** The tool stage record: the pick, then the args extract attempts for a clear pick only. */
export interface ToolDecision {
  readonly schema: 'decide2.decision@1';
  readonly request_id: string | null;
  readonly pick: Decide2Observation;
  readonly extracts: readonly ExtractObservation[];
}
/** Derived, never stored: recomputed from the observation on every read and replay. */
export interface Decide2Pick {
  /** Ordinal of the highest p (ties: the lowest ordinal), or null when no entry was answered. */
  readonly top: number | null;
  /** `top` when the margin rule clears, else null. */
  readonly pick: number | null;
  /** `p(top) - p(runner-up)` at 10 decimal places (runner-up 0 for one entry), or null. */
  readonly margin: number | null;
}

/** Compared in 1e-10 units, so `.7 - .4` clears a `.3` margin exactly as written. */
const scaled = (value: number) => Math.round(value * 1e10);

/**
 * Pure margin rule: one entry clearly above every other on an answered observation. A missing
 * top confidence is no margin (stricter than D3, where it is unknown).
 */
export function decide2Pick(observation: Decide2Observation): Decide2Pick {
  const entries = observation.entries;
  if (observation.reason !== 'answered' || entries.length === 0 || entries.some((entry) => entry.p === null))
    return { top: null, pick: null, margin: null };
  let top = 0;
  for (let i = 1; i < entries.length; i++) if (entries[i]!.p! > entries[top]!.p!) top = i;
  const p = entries[top]!.p!;
  const runnerUp = Math.max(0, ...entries.filter((_, i) => i !== top).map((entry) => entry.p!));
  const margin = scaled(p - runnerUp);
  const confidence = entries[top]!.confidence;
  const clear =
    scaled(p) >= scaled(DECIDE2_POLICY.min_top) &&
    margin >= scaled(DECIDE2_POLICY.min_margin) &&
    scaled(runnerUp) <= scaled(DECIDE2_POLICY.max_runner_up) &&
    confidence !== null &&
    scaled(confidence) >= scaled(DECIDE2_POLICY.confidence);
  return { top, pick: clear ? top : null, margin: margin / 1e10 };
}

/** A top the operator could plausibly mean: above the runner-up ceiling. Only such a top can ask. */
export function plausibleTop(observation: Decide2Observation, top: number | null): boolean {
  const p = top === null ? null : (observation.entries[top]?.p ?? null);
  return p !== null && scaled(p) > scaled(DECIDE2_POLICY.max_runner_up);
}

export function transitionDecide2(
  ask: Decide2Ask,
  recorded: RecordedDecide2Answer,
  current: SiteState,
): Decide2Observation {
  const input = { ...ask, request_id: `${ask.request_id}:decide2`, needs_dispatch: true };
  // No origin requirement: only the shared metadata gate's four reasons apply.
  const metadata = admissionReason(DECIDE2_SITE, input, recorded, current) as Exclude<
    Decide2Reason,
    'answered' | 'no_answer' | 'invalid_answer'
  > | null;
  const answered = recorded.outcome?.status === 'accepted' ? recorded.outcome : null;
  const raw = ask.catalogue.map((_, i) => answered?.answers?.[`entry_${i}`]);
  const reason: Decide2Reason =
    metadata ??
    (!answered
      ? 'no_answer'
      : answered.kind !== 'boolean' || raw.some((item) => item?.type !== 'boolean' || !unit(item.probability))
        ? 'invalid_answer'
        : 'answered');
  return {
    schema: 'decide2-pick@1',
    site: DECIDE2_SITE,
    question: DECIDE2_QUESTION,
    request_id: correlation(input.request_id),
    state_revision: ask.state_revision,
    entries: ask.catalogue.map((entry, i) => {
      const item = raw[i];
      const confidence = answered?.confidence?.[`entry_${i}`];
      return {
        ref: entry.ref,
        p: reason === 'answered' && item?.type === 'boolean' ? item.probability : null,
        confidence: reason === 'answered' && unit(confidence) ? confidence : null,
      };
    }),
    reason,
    provider_request_id: correlation(answered?.provider_response_id),
  };
}

/** One decision-tier call; every entry is its own isolated boolean question. */
export async function askDecide2(
  ask: Decide2Ask,
  port: Pick<InferenceGateway, 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<Decide2Observation> {
  const captured = structuredClone(ask);
  let outcome: EvaluationOutcome<'boolean'> | null = null;
  if (!signal?.aborted) {
    try {
      outcome = await port.evaluate(
        {
          request_id: `${captured.request_id}:decide2`,
          site: DECIDE2_SITE,
          role: 'working',
          kind: 'boolean',
          state: {
            request: captured.state.request,
            context: captured.state.context,
            entries: captured.catalogue.map((entry) => ({ ref: entry.ref, purpose: entry.purpose })),
          },
          questions: Object.fromEntries(
            captured.catalogue.map((entry, i) => [
              `entry_${i}`,
              { type: 'boolean' as const, instructions: { question: DECIDE2_QUESTION, entry: entry.ref } },
            ]),
          ),
          terms: { ...captured.terms, destinations: [...captured.terms.destinations], tier: 'decision' },
        },
        signal,
      );
    } catch {
      // Never put an injected exception (which may contain credentials) in evidence.
    }
  }
  const current = now();
  return transitionDecide2(
    captured,
    {
      state_revision: captured.state_revision,
      observed_at: current.observed_at,
      outcome,
      cancelled: signal?.aborted ?? false,
    },
    current,
  );
}

/** The targeted schema: exactly the picked entry's args, each a verbatim span. */
export function decide2ArgsSchema(entry: CatalogueEntry): ExtractSchema {
  return defineExtractSchema({
    id: DECIDE2_ARGS_SCHEMA,
    slots: Object.fromEntries(
      entry.args.map((arg) => [
        arg.name,
        {
          kind: 'span' as const,
          required: arg.required,
          instructions: `The value of the ${arg.name} argument for ${entry.ref}, copied verbatim.`,
        },
      ]),
    ),
  });
}

/** The args extract grounds against D1's own disclosed state, so a span names text D1 saw. */
export function decide2ArgsOriginal(ask: Pick<Decide2Ask, 'state'>): string {
  return stableStringify({ request: ask.state.request, context: ask.state.context });
}

export function decide2ArgsCall(
  ask: Decide2Ask,
  entry: CatalogueEntry,
  attempt: 1 | 2,
  feedback?: string,
): ExtractCall {
  return {
    site: DECIDE2_ARGS_SITE,
    extract_site: DECIDE2_ARGS_EXTRACT_SITE,
    schema: decide2ArgsSchema(entry),
    original: decide2ArgsOriginal(ask),
    // The prior grounded slot (D1's intent) steers the model; grounding is still against the original.
    prompt: stableStringify({
      tool: { ref: entry.ref, purpose: entry.purpose, args: entry.args.map((arg) => arg.name) },
      intent: ask.intent,
      state: { request: ask.state.request, context: ask.state.context },
    }),
    request_id: `${ask.request_id}:args:x${attempt}`,
    attempt,
    state_revision: ask.state_revision,
    state_updated_at: ask.state_updated_at,
    terms: ask.terms,
    ...(feedback === undefined ? {} : { feedback }),
  };
}

/** Same second-attempt rule as the loop sites: only a re_extract that was not cancelled or stale. */
export function needsSecondExtract(observation: ExtractObservation): boolean {
  return (
    observation.verdict === 're_extract' && observation.reason !== 'cancelled' && observation.reason !== 'stale_answer'
  );
}

export function argsFeedback(observation: ExtractObservation): string {
  const issues = observation.slots
    .filter((slot) => slot.status === 'ungrounded' || slot.status === 'out_of_set')
    .map((slot) => `${slot.slot}: ${slot.status}`);
  return issues.length > 0
    ? `The previous extraction was not faithful: ${issues.join('; ')}. Copy only text that appears verbatim in the state, or use null.`
    : 'The previous extraction could not be used. Return only the required JSON object, copying text verbatim from the state, or use null.';
}

/** Ask the pick; for a clear pick only, extract that entry's args (at most two attempts). */
export async function decideTool(
  ask: Decide2Ask,
  port: Pick<InferenceGateway, 'generate' | 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<ToolDecision> {
  const captured = structuredClone(ask);
  const pick = await askDecide2(captured, port, now, signal);
  const extracts: ExtractObservation[] = [];
  const picked = decide2Pick(pick).pick;
  const entry = picked === null ? undefined : captured.catalogue[picked];
  if (entry !== undefined && entry.args.length > 0 && !signal?.aborted) {
    const first = await attemptExtract(decide2ArgsCall(captured, entry, 1), port, now, signal);
    extracts.push(first.observation);
    if (needsSecondExtract(first.observation)) {
      const feedback = argsFeedback(first.observation);
      const second = await attemptExtract(decide2ArgsCall(captured, entry, 2, feedback), port, now, signal);
      extracts.push(second.observation);
    }
  }
  return { schema: 'decide2.decision@1', request_id: correlation(captured.request_id), pick, extracts };
}
