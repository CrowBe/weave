/** Capture the actual production request through its existing port; never route it. */
import type { EvaluationRequest, InferenceGateway } from '@weave/gateway';
import {
  evaluateSite,
  gateExtract,
  intakeExtractSchema,
  modelExtractSchema,
  modelOrigin,
  SITE_POLICY,
  structuralOrigin,
  type IntakeState,
} from '@weave/weave';
import { evaluateBooleanSite } from '@weave/weave';
import { evaluateOutputEval } from '@weave/weave';
import { evaluateAuditDispose } from '@weave/weave';
import type { Item, Request } from './types.ts';
export const SITES = [
  'intake.classify',
  'loop.triage',
  'loop.route',
  'loop.preselect',
  'guard.input',
  'eval.output',
  'audit.dispose',
  'guard.output',
  'loop.continue',
] as const;
/** Supply the typed-state origin the production site now requires; it never changes captured state. */
function originFor(item: Item) {
  if (item.site === 'loop.continue') return structuralOrigin('progress.delta@1');
  if (item.site === 'intake.classify') {
    const state = item.state as Record<string, unknown>;
    const intake: IntakeState = {
      message: typeof state['message'] === 'string' ? state['message'] : '',
      running_threads: Array.isArray(state['running_threads'])
        ? (state['running_threads'] as IntakeState['running_threads'])
        : [],
    };
    return modelOrigin(
      gateExtract(
        intakeExtractSchema(intake),
        intake.message,
        { thread_ref: { value: 'none', cue: null }, request: { value: null } },
        { site: 'intake.classify', request_id: 'benchmark', state_revision: 1 },
      ),
    );
  }
  if (item.site === 'loop.triage' || item.site === 'loop.route') {
    return modelOrigin(
      gateExtract(
        modelExtractSchema(item.site),
        '',
        { intent: { value: null } },
        { site: item.site, request_id: 'benchmark', state_revision: 1 },
      ),
    );
  }
  return undefined;
}
export async function buildRequest(item: Item): Promise<Request> {
  const state = item.state as Record<string, any>;
  let captured: EvaluationRequest | undefined;
  const port = {
    evaluate: async (request: EvaluationRequest) => {
      captured = request;
      return null;
    },
  } as unknown as Pick<InferenceGateway, 'evaluate'>;
  const current = () => ({ state_revision: 1, state_updated_at: 0, observed_at: 1 });
  const input = {
    request_id: 'benchmark',
    state_revision: 1,
    state_updated_at: 0,
    state: item.state,
    terms: {
      quality: 'baseline' as const,
      destinations: ['local'],
      max_context_tokens: 4000,
      deadline: 1,
      cost_ceiling: 0,
      max_attempts: 1,
    },
    needs_dispatch: false,
  };
  const origin = originFor(item);
  const siteInput = origin === undefined ? input : { ...input, origin };
  if (item.site in SITE_POLICY) await evaluateSite(item.site as keyof typeof SITE_POLICY, siteInput, port, current);
  else if (['loop.preselect', 'guard.input', 'guard.output'].includes(item.site))
    await evaluateBooleanSite(
      item.site as 'loop.preselect' | 'guard.input' | 'guard.output',
      {
        ...input,
        catalogue_index: state.index ?? [],
        preselect_step: state.preselect_step ?? '',
        required_entry_ids: state.required_entry_ids ?? [],
      },
      port,
      current,
    );
  else if (item.site === 'eval.output') await evaluateOutputEval({ ...input, criteria: state.criteria }, port, current);
  else if (item.site === 'audit.dispose')
    await evaluateAuditDispose({ ...input, findings: state.findings }, port, current);
  else throw new Error('Unknown site');
  if (!captured) throw new Error('Site produced no questions');
  return { state: captured.state, questions: captured.questions };
}
