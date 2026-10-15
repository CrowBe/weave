/** Sequential dispatch is an intentional bound: Jev <=4, Amos and competitors exactly one. */
import { Journal, digest, projectedCost, replayKey } from './journal.ts';
import { buildRequest } from './questions.ts';
import type { Item, Provider, Result } from './types.ts';
export interface Entry {item:Item;split:'tune'|'holdout';set_digest:string}
export function providerSkip(result:Result):boolean {
 return result.http_status===401||result.http_status===403||(result.status==='skipped'&&['auth_required','unauthorized','no_credential','quota_unavailable_or_weekly_cap','call_cap','model_not_listed','tools_cannot_be_disabled','unsupported_cli_flags'].includes(result.reason??''));
}
export async function execute(options:{entries:readonly Entry[];providers:readonly Provider[];journal:Journal;maxSpend:number;now:()=>number;sleep:(ms:number,signal?:AbortSignal)=>Promise<void>;signal?:AbortSignal}):Promise<void> {
 const {entries,providers,journal,signal}=options;
 const skipped=new Set(journal.read().filter(r=>r.type==='provider_status'&&r.result?.status==='skipped'&&providerSkip(r.result)).map(r=>r.provider));
 for(const provider of providers) {
  if(skipped.has(provider.id))continue;
  const scheduled=provider.competitor?competitorEntries(entries):entries;
  items:for(const entry of scheduled) {
   if(provider.competitor && journal.read().filter(r=>r.type==='intent'&&r.provider===provider.id).length>=40){journal.append({type:'provider_status',provider:provider.id,result:{status:'skipped',reason:'call_cap'}});break;}
   if(signal?.aborted){journal.append({type:'cancelled'});return;}
   if(provider.competitor && entry.split!=='holdout')continue;
   const request=await buildRequest(entry.item);
   const binding={provider:provider.id,model:provider.model,site:entry.item.site,item_id:entry.item.id,set_digest:entry.set_digest,question_digest:digest(JSON.stringify(request))};
   const key=replayKey(binding);const history=journal.read();
   const prior=history.filter(r=>r.type==='call'&&replayKey(r)===key);
   if(prior.some(r=>r.terminal))continue;
   const pending=history.filter(r=>r.type==='intent'&&replayKey(r)===key&&!history.some(c=>c.type==='call'&&c.call_id===r.call_id));
   if(pending.length){
    // The provider may have accepted a request before a crash. Never automatically pay again.
    if(!history.some(r=>r.type==='uncertain'&&replayKey(r)===key))journal.append({type:'uncertain',...binding,reason:'unacknowledged_call_no_automatic_retry'});
    continue;
   }
   for(let attempt=prior.length;attempt<3;attempt++) {
    if(signal?.aborted){journal.append({type:'cancelled'});return;}
    const projected=projectedCost(provider.serialize(request),provider.price);
    if(journal.spent()+projected>options.maxSpend){journal.append({type:'budget_stop',spent_usd:journal.spent(),projected_usd:projected,ceiling_usd:options.maxSpend});break items;}
    const call_id=digest(JSON.stringify([binding,history.length,attempt,journal.read().length]));
    journal.append({type:'intent',...binding,split:entry.split,call_id,projected_usd:projected});
    const started=options.now();let result:Result;
    try{result=await provider.request(request,signal??new AbortController().signal);}catch{result={status:'failed',reason:'provider_exception'};}
    if(signal?.aborted){journal.append({type:'cancelled',...binding,call_id});return;}
    const retry=result.http_status===429 && attempt<2 && (result.retry_after_ms??0)<=60000;
    const cost=result.input_tokens===undefined?(result.status==='skipped'?0:projected):result.input_tokens*provider.price/1e6;
    const skip=providerSkip(result);
    if(result.status==='skipped'&&!skip)result={...result,status:'failed'};
    journal.append({type:'call',...binding,split:entry.split,call_id,result,terminal:!retry,latency_ms:Math.max(0,options.now()-started),cost_usd:cost});
    if(skip){journal.append({type:'provider_status',provider:provider.id,result:{...result,status:'skipped'}});skipped.add(provider.id);break;}
    if(!retry)break;
    try{await options.sleep(Math.min(60000,Math.max(0,result.retry_after_ms??1000*(attempt+1))),signal);}catch{journal.append({type:'cancelled'});return;}
   }
   if(skipped.has(provider.id))break;
  }
 }
}

/** Spread the hard competitor cap across sites in stable round-robin order. */
export function competitorEntries(entries:readonly Entry[]):Entry[] {
 const sites=[...new Set(entries.map(e=>e.item.site))].sort();
 const groups=sites.map(site=>entries.filter(e=>e.split==='holdout'&&e.item.site===site).sort((a,b)=>a.item.id.localeCompare(b.item.id)));
 const result:Entry[]=[];for(let n=0;groups.some(g=>n<g.length);n++)for(const group of groups)if(group[n])result.push(group[n]!);
 return result;
}
