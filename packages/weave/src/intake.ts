/**
 * Intake composition (WV-S1 P2a): extract typed hints, gate them against the
 * original message, then ask `intake.classify` only when no stop or operator
 * ambiguity decides first. The original message is always authoritative.
 */
import type { EvaluationKind, EvaluationOutcome, EvaluationRequest, InferenceGateway } from '@weave/gateway';
import { stableStringify } from './stable-json.js';
import {
  correlation,
  evaluateSite,
  transitionSite,
  type IntakeHints,
  type IntakeSiteInput,
  type IntakeState,
  type RecordedSiteAnswer,
  type SiteChoice,
  type SiteObservation,
  type SiteReason,
  type SiteState,
  type SiteTransition,
} from './sites/index.js';
import {
  attemptExtract,
  defineExtractSchema,
  observeExtract,
  type ExtractObservation,
  type ExtractSchema,
  type RecordedExtract,
} from './sites/extract.js';

export type { RecordedExtract };

export const INTAKE_EXTRACT_SCHEMA = 'intake.message@1' as const;
export const INTAKE_EXTRACT_SITE = 'intake.extract' as const;

export interface IntakeDecision {
  readonly schema: 'intake.decision@1';
  readonly request_id: string | null;
  readonly decided_by: 'extract' | 'site';
  readonly choice: SiteChoice;
  readonly status: SiteTransition['status'];
  readonly reason: SiteReason | 'ambiguous_reference';
  readonly extract: readonly ExtractObservation[];
  readonly site: SiteObservation | null;
}
export interface RecordedIntake {
  /** One or two attempts, in attempt order. */
  readonly extracts: readonly RecordedExtract[];
  readonly site: RecordedSiteAnswer | null;
}

/** `intake.message@1`: one closed thread choice and one optional verbatim request span. */
export function intakeExtractSchema(state: IntakeState): ExtractSchema {
  const options: string[] = [];
  for (const thread of state.running_threads) {
    const id = correlation(thread.thread_id);
    if (id !== null && !options.includes(id)) options.push(id);
  }
  if (!options.includes('none')) options.push('none');
  return defineExtractSchema({
    id: INTAKE_EXTRACT_SCHEMA,
    slots: {
      thread_ref: {
        kind: 'choice',
        required: true,
        instructions: 'The running thread this message refers to, or none.',
        options,
        none: 'none',
      },
      request: {
        kind: 'span',
        required: false,
        instructions: 'The actionable request in the message.',
      },
    },
  });
}

function capture(ask: IntakeSiteInput): IntakeSiteInput {
  return {
    request_id: ask.request_id,
    state_revision: ask.state_revision,
    state_updated_at: ask.state_updated_at,
    terms: { ...ask.terms, destinations: [...ask.terms.destinations] },
    needs_dispatch: ask.needs_dispatch,
    state: {
      message: ask.state.message,
      running_threads: ask.state.running_threads.map((thread) => ({
        thread_id: thread.thread_id,
        summary: thread.summary,
      })),
    },
  };
}

function callFor(ask: IntakeSiteInput, schema: ExtractSchema, attempt: 1 | 2, feedback?: string) {
  return {
    site: 'intake.classify',
    extract_site: INTAKE_EXTRACT_SITE,
    schema,
    original: ask.state.message,
    prompt: stableStringify({
      message: ask.state.message,
      running_threads: ask.state.running_threads,
    }),
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
    ? `The previous extraction was not faithful: ${issues.join('; ')}. Copy only text that appears verbatim in the message, or use null.`
    : 'The previous extraction could not be used. Return only the required JSON object, copying text verbatim from the message, or use null.';
}

function hintsFor(state: IntakeState, observation: ExtractObservation): IntakeHints {
  const thread = observation.slots.find((slot) => slot.slot === 'thread_ref');
  const request = observation.slots.find((slot) => slot.slot === 'request');
  return {
    schema: INTAKE_EXTRACT_SCHEMA,
    thread_ref:
      thread?.status === 'grounded' && thread.value !== null
        ? {
            value: thread.value,
            cue: thread.span === null ? null : state.message.slice(thread.span[0], thread.span[1]),
          }
        : null,
    request:
      request?.status === 'grounded' && request.span !== null
        ? state.message.slice(request.span[0], request.span[1])
        : null,
  };
}

function siteState(state: IntakeState, hints: IntakeHints | null): IntakeState {
  return hints === null
    ? { message: state.message, running_threads: state.running_threads }
    : { message: state.message, running_threads: state.running_threads, hints };
}

function lastState(extracts: readonly RecordedExtract[]): SiteState {
  const last = extracts[extracts.length - 1];
  return last === undefined
    ? { state_revision: 0, state_updated_at: 0 }
    : { state_revision: last.state_revision, state_updated_at: last.state_updated_at };
}

interface IntakePlan {
  readonly observations: readonly ExtractObservation[];
  readonly final: ExtractObservation;
  readonly hints: IntakeHints | null;
  readonly askOperator: boolean;
  readonly stop: 'paused' | 'needs_human' | null;
  readonly needsExtract: boolean;
}

function planIntake(ask: IntakeSiteInput, recorded: RecordedIntake): IntakePlan {
  if (recorded.extracts.length === 0 || recorded.extracts.length > 2)
    throw new Error('intake needs one or two recorded extracts');
  for (const [index, extract] of recorded.extracts.entries()) {
    if (extract.attempt !== index + 1)
      throw new Error('recorded extract attempts must be unique, ordered and consecutive');
  }
  const schema = intakeExtractSchema(ask.state);
  const observations = recorded.extracts.map((extract) =>
    observeExtract(callFor(ask, schema, extract.attempt), extract),
  );
  if (observations.length === 2 && observations[0]!.verdict !== 're_extract')
    throw new Error('a recorded stop cannot be followed by a second extraction');
  const final = observations[observations.length - 1]!;
  if (final.reason === 'cancelled')
    return { observations, final, hints: null, askOperator: false, stop: 'paused', needsExtract: false };
  if (final.reason === 'stale_answer')
    return { observations, final, hints: null, askOperator: false, stop: 'needs_human', needsExtract: false };
  if (final.verdict === 're_extract') {
    if (observations.length >= 2) throw new Error('a second extraction cannot request another extraction');
    return { observations, final, hints: null, askOperator: false, stop: null, needsExtract: true };
  }
  const hints = final.verdict === 'use_hints' ? hintsFor(ask.state, final) : null;
  const thread = final.slots.find((slot) => slot.slot === 'thread_ref');
  const askOperator =
    final.verdict === 'use_hints' && thread?.status === 'unresolved' && ask.state.running_threads.length >= 2;
  return { observations, final, hints, askOperator, stop: null, needsExtract: false };
}

function decision(
  ask: IntakeSiteInput,
  decided_by: IntakeDecision['decided_by'],
  choice: SiteChoice,
  status: SiteTransition['status'],
  reason: IntakeDecision['reason'],
  extract: readonly ExtractObservation[],
  site: SiteObservation | null,
): IntakeDecision {
  return {
    schema: 'intake.decision@1',
    request_id: correlation(ask.request_id),
    decided_by,
    choice,
    status,
    reason,
    extract,
    site,
  };
}

/** Pure record construction and replay from recorded outcomes; no port is touched. */
export function transitionIntake(ask: IntakeSiteInput, recorded: RecordedIntake, current: SiteState): IntakeDecision {
  const plan = planIntake(ask, recorded);
  if (plan.needsExtract) throw new Error('intake extraction needs a second recorded attempt');
  if (plan.stop === 'paused')
    return decision(ask, 'extract', 'ask_user', 'paused', 'cancelled', plan.observations, null);
  if (plan.stop === 'needs_human')
    return decision(ask, 'extract', 'ask_user', 'needs_human', 'stale_answer', plan.observations, null);
  if (plan.askOperator)
    return decision(ask, 'extract', 'ask_user', 'needs_human', 'ambiguous_reference', plan.observations, null);
  if (recorded.site === null) throw new Error('intake site answer is missing');
  const siteInput: IntakeSiteInput = { ...ask, state: siteState(ask.state, plan.hints) };
  const site = transitionSite('intake.classify', siteInput, recorded.site, current);
  return decision(ask, 'site', site.choice, site.status, site.observation.reason, plan.observations, site.observation);
}

/**
 * Extract, gate, then ask the site through the injected ports. The site is
 * skipped on cancellation, staleness, or an operator-only ambiguity.
 */
export async function decideIntake(
  ask: IntakeSiteInput,
  port: Pick<InferenceGateway, 'generate' | 'evaluate'>,
  now: () => SiteState & { readonly observed_at: number },
  signal?: AbortSignal,
): Promise<IntakeDecision> {
  const captured = capture(ask);
  const schema = intakeExtractSchema(captured.state);
  const extracts: RecordedExtract[] = [];
  const first = await attemptExtract(callFor(captured, schema, 1), port, now, signal);
  extracts.push(first.recorded);
  let plan = planIntake(captured, { extracts, site: null });
  if (plan.needsExtract) {
    const second = await attemptExtract(callFor(captured, schema, 2, feedbackFor(plan.final)), port, now, signal);
    extracts.push(second.recorded);
    plan = planIntake(captured, { extracts, site: null });
  }
  if (plan.needsExtract || plan.stop !== null || plan.askOperator)
    return transitionIntake(captured, { extracts, site: null }, lastState(extracts));

  const siteInput: IntakeSiteInput = { ...captured, state: siteState(captured.state, plan.hints) };
  let siteOutcome: EvaluationOutcome<'choice'> | null = null;
  let siteNow: (SiteState & { readonly observed_at: number }) | null = null;
  const capturingPort: Pick<InferenceGateway, 'evaluate'> = {
    async evaluate<K extends EvaluationKind>(
      request: EvaluationRequest<K>,
      callSignal?: AbortSignal,
    ): Promise<EvaluationOutcome<K>> {
      const outcome = await port.evaluate(request, callSignal);
      siteOutcome = outcome as EvaluationOutcome<'choice'>;
      return outcome;
    },
  };
  await evaluateSite('intake.classify', siteInput, capturingPort, () => (siteNow = now()), signal);
  const observed = siteNow ?? { ...lastState(extracts), observed_at: lastState(extracts).state_updated_at };
  const recordedSite: RecordedSiteAnswer = {
    state_revision: siteInput.state_revision,
    observed_at: observed.observed_at,
    outcome: siteOutcome,
    ...(signal?.aborted ? { cancelled: true } : {}),
  };
  return transitionIntake(captured, { extracts, site: recordedSite }, observed);
}
