import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute, countCompetitorCalls } from './engine.ts';
import { Journal, digest } from './journal.ts';
import { buildRequest } from './questions.ts';
import type { Provider, Item } from './types.ts';
const item:Item={id:'i',scenario_id:'s',site:'loop.route',state:{task:'read'},gold:{decision:'flash'}};
async function fixture(fn:(journal:Journal)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'engine-'));try{await fn(new Journal(join(dir,'journal.jsonl')));}finally{await rm(dir,{recursive:true,force:true});}}
const entry={item,split:'holdout' as const,set_digest:'s'};
function provider(request:Provider['request']):Provider{return {id:'fake',model:'fake',price:.1,serialize:JSON.stringify,request};}
const clock={now:()=>100,sleep:async()=>{}};
test('budget stops before call and resume reads newly appended live ledger',()=>fixture(async journal=>{
 let n=0;const p=provider(async()=>{n++;return {status:'ok',model:'fake',input_tokens:1000000,answers:{}};});
 await execute({entries:[entry],providers:[p],journal,maxSpend:0,...clock});assert.equal(n,0);
 journal.append({type:'call',call_id:'prior',cost_usd:1});
 await execute({entries:[entry],providers:[p],journal,maxSpend:1,...clock});assert.equal(n,0);
}));
test('429 max three attempts, auth skips rest, failure remains in denominator',()=>fixture(async journal=>{
 let n=0;const p=provider(async()=>{n++;return {status:'failed',model:'fake',http_status:429,retry_after_ms:10};});
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(n,3);
 assert.equal(journal.read().filter(r=>r.type==='call').length,3);
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(n,3);
}));
test('an acknowledged paid answer survives cancellation with actual cost and is never repaid',()=>fixture(async journal=>{
 const controller=new AbortController();let n=0;
 const answer={status:'ok' as const,model:'fake',input_tokens:7,answers:{decision:{choice:'flash',confidence:.9}}};
 const p=provider(async()=>{n++;controller.abort();return answer;});
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,signal:controller.signal,...clock});
 const records=journal.read(),call=records.find(r=>r.type==='call')!;
 assert.ok(call);assert.deepEqual(call.result,answer);assert.equal(call.terminal,true);
 assert.equal(call.cost_usd,7*p.price/1e6);assert.equal(journal.spent(),call.cost_usd);
 assert.ok(records.findIndex(r=>r.type==='call')<records.findIndex(r=>r.type==='cancelled'));
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(n,1);
 assert.equal(journal.spent(),call.cost_usd);assert.equal(journal.read().some(r=>r.type==='uncertain'),false);
}));
test('acknowledged cancellation or not-sent results release spend and competitor cap and remain retryable',async()=>{
 for(const reason of ['cancelled','not_sent'])await fixture(async journal=>{
  for(let i=0;i<39;i++){
   journal.append({type:'intent',provider:'fake',call_id:`paid-${i}`,projected_usd:0});
   journal.append({type:'call',provider:'fake',call_id:`paid-${i}`,result:{status:'ok'},terminal:true,cost_usd:0});
  }
  let n=0;
  for(let i=0;i<4;i++){
   const controller=new AbortController();
   const p={...provider(async()=>{n++;controller.abort();return {status:'failed',reason};}),competitor:true};
   await execute({entries:[entry],providers:[p],journal,maxSpend:2,signal:controller.signal,...clock});
   const call=journal.read().filter(r=>r.type==='call').at(-1)!;
   assert.equal(call.result.reason,reason);assert.equal(call.terminal,false);assert.equal(call.cost_usd,0);
   assert.equal(journal.spent(),0);assert.equal(countCompetitorCalls(journal.read(),'fake'),39);
  }
  const p={...provider(async()=>{n++;return {status:'ok' as const,input_tokens:7,answers:{}};}),competitor:true};
  await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(n,5);
  assert.equal(countCompetitorCalls(journal.read(),'fake'),40);
  assert.equal(journal.read().some(r=>r.type==='uncertain'),false);
 });
});
test('requests that throw without acknowledgement retain a reservation and are not blindly retried',async()=>{
 for(const abort of [false,true])await fixture(async journal=>{
  const controller=new AbortController();let n=0;
  const p=provider(async()=>{n++;if(abort)controller.abort();throw Error('no receipt');});
  await execute({entries:[entry],providers:[p],journal,maxSpend:2,signal:controller.signal,...clock});
  assert.equal(journal.read().some(r=>r.type==='call'),false);const spent=journal.spent();assert.ok(spent>0);
  await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(n,1);
  assert.equal(journal.spent(),spent);assert.equal(journal.read().some(r=>r.type==='uncertain'),true);
 });
});
test('already cancelled dispatch creates no reservation or competitor call',()=>fixture(async journal=>{
 const controller=new AbortController();controller.abort();
 await execute({entries:[entry],providers:[{...provider(async()=>{throw Error('must not dispatch');}),competitor:true}],journal,maxSpend:2,signal:controller.signal,...clock});
 assert.equal(journal.read().some(r=>r.type==='intent'),false);assert.equal(journal.spent(),0);
 assert.equal(countCompetitorCalls(journal.read(),'fake'),0);
}));
test('auth skips provider once and unrelated providers continue; skipped calls cost zero',()=>fixture(async journal=>{
 let denied=0,healthy=0;
 const auth={...provider(async()=>{denied++;return {status:'skipped' as const,http_status:401,reason:'unauthorized'};}),id:'denied'};
 const good={...provider(async()=>{healthy++;return {status:'ok' as const,model:'fake',answers:{}};}),id:'healthy'};
 await execute({entries:[entry,{...entry,item:{...item,id:'j'}}],providers:[auth,good],journal,maxSpend:2,...clock});
 assert.equal(denied,1);assert.equal(healthy,2);assert.ok(journal.read().some(r=>r.type==='provider_status'&&r.provider==='denied'));
 assert.equal(journal.read().find(r=>r.type==='call'&&r.provider==='denied')!.cost_usd,0);
}));
test('exact replay skips payment; changed model, set or request re-asks and retains all spend',()=>fixture(async journal=>{
 let n=0;
 const p=provider(async()=>{n++;return {status:'ok',model:'fake',input_tokens:100,answers:{decision:{choice:'flash',confidence:.9}}};});
 const run=(entries=[entry],providers=[p])=>execute({entries,providers,journal,maxSpend:2,...clock});
 await run();const spent=journal.spent();await run();assert.equal(n,1);assert.equal(journal.spent(),spent);
 await run([{...entry,set_digest:'changed'}]);assert.equal(n,2);
 await run([{...entry,item:{...item,state:{task:'changed'}}}]);assert.equal(n,3);
 await run([entry],[{...p,model:'different',request:async()=>{n++;return{status:'ok',model:'different',input_tokens:100,answers:{}};}}]);assert.equal(n,4);
 assert.equal(journal.spent(),spent*4);
}));
test('Retry-After honored, over-bound backoff fails without early retry',()=>fixture(async journal=>{
 const waits:number[]=[];let n=0;
 const p=provider(async()=>{n++;return {status:'failed',http_status:429,retry_after_ms:n===1?1234:61000};});
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,now:clock.now,sleep:async ms=>{waits.push(ms);}});
 assert.deepEqual(waits,[1234]);assert.equal(n,2);assert.equal(journal.read().filter(r=>r.type==='call').at(-1)!.terminal,true);
}));
test('competitor cap applies across resume and sites are sampled round-robin',()=>fixture(async journal=>{
 const calls:string[]=[];
 const p={...provider(async req=>{calls.push(String(req.state));return {status:'ok' as const,model:'fake',answers:{}};}),competitor:true};
 const rows=Array.from({length:30},(_,n)=>['loop.route','loop.continue'].map(site=>({item:{...item,id:`${site}-${n}`,site,state:site},split:'holdout' as const,set_digest:'s'}))).flat();
 await execute({entries:rows,providers:[p],journal,maxSpend:2,...clock});assert.equal(calls.length,40);assert.equal(calls.filter(s=>s==='loop.route').length,20);
 await execute({entries:rows,providers:[p],journal,maxSpend:2,...clock});assert.equal(calls.length,40);
}));
test('terminal wrong-model results are replayed without repaying or recounting spend',()=>fixture(async journal=>{
 let n=0;
 const p=provider(async()=>{n++;return {status:'failed',reason:'wrong_model',model:'unexpected',input_tokens:100};});
 const run=()=>execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});
 await run();const spent=journal.spent();await run();
 assert.equal(n,1);assert.equal(journal.spent(),spent);
}));
test('wrong-model retry records retain their attempt count on resume',()=>fixture(async journal=>{
 const request=await buildRequest(item);
 for(let attempt=0;attempt<2;attempt++)journal.append({type:'call',provider:'fake',model:'fake',site:item.site,item_id:item.id,set_digest:entry.set_digest,question_digest:digest(JSON.stringify(request)),call_id:`retry-${attempt}`,result:{status:'failed',reason:'wrong_model',model:'unexpected',http_status:429},terminal:false,cost_usd:0});
 let n=0;const p=provider(async()=>{n++;return {status:'failed',reason:'wrong_model',model:'unexpected',http_status:429};});
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});
 assert.equal(n,1);assert.equal(journal.read().filter(r=>r.type==='call').at(-1)!.terminal,true);
}));
test('unsupported question types fail only their item, including after legacy provider skips',()=>fixture(async journal=>{
 journal.append({type:'provider_status',provider:'fake',result:{status:'skipped',reason:'unsupported_question_type'}});
 let n=0;const p=provider(async()=>{n++;return n===1?{status:'skipped',reason:'unsupported_question_type'}:{status:'ok',model:'fake',answers:{}};});
 const run=()=>execute({entries:[entry,{...entry,item:{...item,id:'supported'}}],providers:[p],journal,maxSpend:2,...clock});
 await run();assert.equal(n,2);
 const calls=journal.read().filter(r=>r.type==='call');
 assert.equal(calls[0]!.result.status,'failed');assert.equal(calls[0]!.result.reason,'unsupported_question_type');
 assert.equal(calls[1]!.result.status,'ok');
 assert.equal(journal.read().filter(r=>r.type==='provider_status').length,1);
 await run();assert.equal(n,2);
}));
test('a metered budget stop still allows later zero-price providers',()=>fixture(async journal=>{
 let paid=0,free=0;
 const metered=provider(async()=>{paid++;return {status:'ok',model:'fake',answers:{}};});
 const unmetered={...provider(async()=>{free++;return {status:'ok' as const,model:'fake',answers:{}};}),id:'free',price:0};
 await execute({entries:[entry,{...entry,item:{...item,id:'second'}}],providers:[metered,unmetered],journal,maxSpend:0,...clock});
 assert.equal(paid,0);assert.equal(free,2);assert.equal(journal.read().filter(r=>r.type==='budget_stop').length,1);
}));

test('quota skips last for one invocation, retry the uncalled item on resume, and remain journalled',()=>fixture(async journal=>{
 let n=0;const p={...provider(async()=>{n++;return n===1?{status:'skipped' as const,reason:'quota_unavailable_or_weekly_cap'}:{status:'ok' as const,model:'fake',answers:{}};}),competitor:true};
 const rows=[entry,{...entry,item:{...item,id:'next'}}];
 const run=()=>execute({entries:rows,providers:[p],journal,maxSpend:2,...clock});
 await run();assert.equal(n,1);
 const status=journal.read().find(r=>r.type==='provider_status')!;assert.equal(status.persistent,false);
 await run();assert.equal(n,3);
 assert.equal(journal.read().filter(r=>r.type==='call'&&r.result.status==='ok').length,2);
 await run();assert.equal(n,3);
}));
test('legacy quota skips are recoverable, while credential/auth/tool skips stay persistent',()=>fixture(async journal=>{
 const request=await buildRequest(item);
 journal.append({type:'provider_status',provider:'fake',result:{status:'skipped',reason:'quota_unavailable_or_weekly_cap'}});
 journal.append({type:'call',provider:'fake',model:'fake',site:item.site,item_id:item.id,set_digest:entry.set_digest,question_digest:digest(JSON.stringify(request)),call_id:'legacy-quota',result:{status:'skipped',reason:'quota_unavailable_or_weekly_cap'},terminal:true,cost_usd:0});
 let n=0;const p=provider(async()=>{n++;return {status:'ok',model:'fake',answers:{}};});
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(n,1);
 for(const reason of ['auth_required','no_credential','tools_cannot_be_disabled']){
  let attempts=0;const persistent={...provider(async()=>{attempts++;return {status:'skipped' as const,reason};}),id:reason};
  const run=()=>execute({entries:[entry],providers:[persistent],journal,maxSpend:2,...clock});
  await run();await run();assert.equal(attempts,1);
  assert.equal(journal.read().find(r=>r.type==='provider_status'&&r.provider===reason)!.persistent,true);
 }
}));

test('quota checks that made no inference call do not exhaust the competitor call cap',()=>fixture(async journal=>{
 for(let n=0;n<40;n++){
  journal.append({type:'intent',provider:'fake',call_id:`quota-${n}`,projected_usd:0});
  journal.append({type:'call',provider:'fake',call_id:`quota-${n}`,result:{status:'skipped',reason:'quota_unavailable_or_weekly_cap'},cost_usd:0,terminal:true});
 }
 let calls=0;const p={...provider(async()=>{calls++;return {status:'ok' as const,model:'fake',answers:{}};}),competitor:true};
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(calls,1);
}));
