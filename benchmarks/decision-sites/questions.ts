/** Capture the actual production request through its existing port; never route it. */
import type { EvaluationRequest, InferenceGateway } from '@weave/gateway';
import { evaluateSite, SITE_POLICY } from '@weave/weave';
import { evaluateBooleanSite } from '@weave/weave';
import { evaluateOutputEval } from '@weave/weave';
import { evaluateAuditDispose } from '@weave/weave';
import type { Item, Request } from './types.ts';
export const SITES = ['intake.classify','loop.triage','loop.route','loop.preselect','guard.input','eval.output','audit.dispose','guard.output','loop.continue'] as const;
export async function buildRequest(item: Item): Promise<Request> {
 const state = item.state as Record<string, any>;
 let captured: EvaluationRequest | undefined;
 const port = {evaluate: async (request: EvaluationRequest) => {captured=request;return null;}} as unknown as Pick<InferenceGateway,'evaluate'>;
 const current=()=>({state_revision:1,state_updated_at:0,observed_at:1});
 const input={request_id:'benchmark',state_revision:1,state_updated_at:0,state:item.state,terms:{quality:'baseline' as const,destinations:['local'],max_context_tokens:4000,deadline:1,cost_ceiling:0,max_attempts:1},needs_dispatch:false};
 if(item.site in SITE_POLICY) await evaluateSite(item.site as keyof typeof SITE_POLICY,input,port,current);
 else if(['loop.preselect','guard.input','guard.output'].includes(item.site)) await evaluateBooleanSite(item.site as 'loop.preselect'|'guard.input'|'guard.output',{
  ...input,catalogue_index:state.index??[],preselect_step:state.preselect_step??'',required_entry_ids:state.required_entry_ids??[],
 },port,current);
 else if(item.site==='eval.output') await evaluateOutputEval({...input,criteria:state.criteria},port,current);
 else if(item.site==='audit.dispose') await evaluateAuditDispose({...input,findings:state.findings},port,current);
 else throw new Error('Unknown site');
 if(!captured)throw new Error('Site produced no questions');
 return {state:captured.state,questions:captured.questions};
}
