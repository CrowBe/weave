import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from './engine.ts';
import { Journal } from './journal.ts';
import type { Provider, Item } from './types.ts';
const item:Item={id:'i',scenario_id:'s',site:'loop.route',state:{task:'read'},gold:{decision:'flash'}};
async function fixture(fn:(journal:Journal)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'engine-'));try{await fn(new Journal(join(dir,'journal.jsonl')));}finally{await rm(dir,{recursive:true,force:true});}}
const entry={item,split:'holdout' as const,set_digest:'s'};
function provider(request:Provider['request']):Provider{return {id:'fake',model:'fake',price:.1,concurrency:1,serialize:JSON.stringify,request};}
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
test('cancelled call is never an answer and pending crash is never blindly repaid',()=>fixture(async journal=>{
 const controller=new AbortController();let n=0;
 const p=provider(async()=>{n++;controller.abort();return {status:'ok',model:'fake',answers:{}};});
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,signal:controller.signal,...clock});
 assert.equal(journal.read().some(r=>r.type==='call'&&r.result.status==='ok'),false);
 assert.equal(journal.read().some(r=>r.type==='cancelled'),true);
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(n,1);
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
