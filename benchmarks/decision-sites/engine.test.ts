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
test('cancelled call is never an answer and pending crash is never blindly repaid',()=>fixture(async journal=>{
 const controller=new AbortController();let n=0;
 const p=provider(async()=>{n++;controller.abort();return {status:'ok',model:'fake',answers:{}};});
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,signal:controller.signal,...clock});
 assert.equal(journal.read().some(r=>r.type==='call'&&r.result.status==='ok'),false);
 assert.equal(journal.read().some(r=>r.type==='cancelled'),true);
 await execute({entries:[entry],providers:[p],journal,maxSpend:2,...clock});assert.equal(n,1);
}));
