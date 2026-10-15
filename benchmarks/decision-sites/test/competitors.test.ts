import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildCompetitors, quotaAllowsCompetitors } from '../competitors.ts';
const req={state:'question state CANARY_DATA',questions:{q:{type:'boolean' as const,instructions:'Allowed?'}}};
test('quota uses nested freshness from the verbatim codex capture and seven_day window shape',()=>{
 const snapshot=JSON.parse(readFileSync(new URL('./fixtures/quota-codex-sample.json',import.meta.url),'utf8'));
 const now=Date.parse(snapshot.generatedAt);
 assert.equal(quotaAllowsCompetitors(snapshot,now),true);
 const sevenDay=structuredClone(snapshot);
 sevenDay.providers[0].windows.find((window:{kind:string})=>window.kind==='weekly').id='seven_day';
 assert.equal(quotaAllowsCompetitors(sevenDay,now),true);
 for(const state of [undefined,{}, {status:'fresh'}, {status:'fresh',stale:true}, {status:'stale',stale:false}, {status:'unknown',stale:false}]){
  const value=structuredClone(snapshot);value.providers[0].status='fresh';value.providers[0].state=state;
  assert.equal(quotaAllowsCompetitors(value,now),false);
 }
 const obsolete=structuredClone(snapshot);obsolete.providers[0].status='stale';
 assert.equal(quotaAllowsCompetitors(obsolete,now),true);
});
test('quota fails closed for missing, stale, ambiguous and 80% weekly usage',()=>{
 const now=Date.parse('2026-10-15T00:00:00Z');
 const value=(remaining:number)=>({generatedAt:new Date(now).toISOString(),providers:[{provider:'codex',state:{status:'fresh',stale:false},windows:[{id:'seven_day',percentRemaining:remaining,resetsAt:new Date(now+3600000).toISOString()}]}]});
 assert.equal(quotaAllowsCompetitors(value(21),now),true);assert.equal(quotaAllowsCompetitors(value(20),now),false);assert.equal(quotaAllowsCompetitors(value(50),now+60001),false);assert.equal(quotaAllowsCompetitors({},now),false);
});
test('quota accepts weekly kind and both weekly ids, using the lowest remaining weekly quota',()=>{
 const now=Date.parse('2026-10-15T00:00:00Z');
 const window=(id:string,percentRemaining:number,kind?:string)=>({id,kind,percentRemaining,resetsAt:new Date(now+3600000).toISOString()});
 const snapshot=(windows:unknown[])=>({generatedAt:new Date(now).toISOString(),providers:[{provider:'codex',state:{status:'fresh',stale:false},windows}]});
 assert.equal(quotaAllowsCompetitors(snapshot([window('weekly',75,'weekly')]),now),true);
 assert.equal(quotaAllowsCompetitors(snapshot([window('seven_day',75,'weekly')]),now),true);
 assert.equal(quotaAllowsCompetitors(snapshot([window('weekly',75)]),now),true);
 assert.equal(quotaAllowsCompetitors(snapshot([window('custom',75,'weekly')]),now),true);
 assert.equal(quotaAllowsCompetitors(snapshot([window('seven_day',75),window('weekly',21,'weekly')]),now),true);
 assert.equal(quotaAllowsCompetitors(snapshot([window('seven_day',75),window('weekly',20,'weekly')]),now),false);
 assert.equal(quotaAllowsCompetitors(snapshot([window('weekly',75),window('custom',NaN,'weekly')]),now),false);
 assert.equal(quotaAllowsCompetitors(snapshot([window('daily',75,'daily')]),now),false);
});
test('fx prompts only on stdin and pi verifies no-tools flags via help; competitors capped at 40',async()=>{
 const calls:Array<{command:string,args:readonly string[],stdin:string}>=[];
 const providers=buildCompetitors({cwd:'/tmp/empty',quotaAllowed:true,run:async(command,args,options)=>{calls.push({command,args,stdin:options.stdin});if(args[0]==='status')return{exitCode:0,stdout:'Auth: authenticated with ChatGPT',stderr:''};if(args.includes('--help'))return{exitCode:0,stdout:'-p --mode --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files --offline',stderr:''};return{exitCode:0,stdout:JSON.stringify({answers:{q:{probability:.9,confidence:.8}}}),stderr:''};}});
 const signal=new AbortController().signal;
 for(const p of providers){for(let i=0;i<40;i++)assert.equal((await p.request(req,signal)).status,'ok');assert.equal((await p.request(req,signal)).reason,'call_cap');}
 for(const call of calls){assert.ok(!call.args.join(' ').includes('CANARY_DATA'));if(call.stdin)assert.ok(call.stdin.includes('CANARY_DATA'));}
 assert.ok(calls.some(x=>x.command==='pi'&&x.args.includes('--no-tools')));
});
test('auth failures are not retried; malformed and nonzero output are failures',async()=>{
 let calls=0;
 const fx=buildCompetitors({cwd:'/tmp/empty',quotaAllowed:true,run:async()=>{calls++;return{exitCode:1,stdout:'Auth: not authenticated',stderr:'login required'};}})[1]!;
 assert.equal((await fx.request(req,new AbortController().signal)).reason,'auth_required');assert.equal((await fx.request(req,new AbortController().signal)).reason,'auth_required');assert.equal(calls,1);
});
test('tool-enabled fx fails closed, and quota refusal never invokes a process',async()=>{
 let calls=0;
 const blocked=buildCompetitors({cwd:'/tmp/empty',quotaAllowed:false,run:async()=>{throw Error('must not spawn');}});
 assert.equal((await blocked[0]!.request(req,new AbortController().signal)).status,'skipped');
 const fx=buildCompetitors({cwd:'/tmp/empty',quotaAllowed:true,run:async(_cmd,args)=>{calls++;return{exitCode:0,stdout:args[0]==='status'?'Auth: authenticated with ChatGPT':'fx ask --json --no-save',stderr:''};}})[1]!;
 assert.equal((await fx.request(req,new AbortController().signal)).reason,'tools_cannot_be_disabled');assert.equal(calls,2);
});
test('pi auth failure is sticky, malformed/nonzero responses fail, and missing confidence remains missing',async()=>{
 const help='--mode --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files --offline';
 for(const output of [{exitCode:1,stdout:'',stderr:'bad command'},{exitCode:0,stdout:'not json',stderr:''},{exitCode:0,stdout:'{"answers":{"q":{"probability":1.5}}}',stderr:''}]){
  const p=buildCompetitors({cwd:'/tmp/empty',quotaAllowed:true,run:async(_cmd,args)=>args[0]==='--help'?{exitCode:0,stdout:help,stderr:''}:output})[0]!;
  assert.equal((await p.request(req,new AbortController().signal)).status,'failed');
 }
 let calls=0;const auth=buildCompetitors({cwd:'/tmp/empty',quotaAllowed:true,run:async(_cmd,args)=>{calls++;return args[0]==='--help'?{exitCode:0,stdout:help,stderr:''}:{exitCode:1,stdout:'',stderr:'No API key found for openai-codex'};}})[0]!;
 assert.equal((await auth.request(req,new AbortController().signal)).reason,'auth_required');assert.equal((await auth.request(req,new AbortController().signal)).reason,'auth_required');assert.equal(calls,2);
 const p=buildCompetitors({cwd:'/tmp/empty',quotaAllowed:true,run:async(_cmd,args)=>args[0]==='--help'?{exitCode:0,stdout:help,stderr:''}:{exitCode:0,stdout:'{"answers":{"q":{"probability":0.9}}}',stderr:''}})[0]!;
 assert.equal((await p.request(req,new AbortController().signal)).answers?.q?.confidence,undefined);
});
test('quota-axi fresh schema validates reset, reused source age, duplicates and missing evidence',()=>{
 const now=Date.parse('2026-10-15T00:00:00Z');
 const snapshot=(remaining=21)=>({generatedAt:new Date(now).toISOString(),providers:[{provider:'codex',state:{status:'fresh',stale:false},windows:[{id:'seven_day',percentRemaining:remaining,resetsAt:new Date(now+3600000).toISOString(),pace:{status:'ahead'}}]}]});
 assert.equal(quotaAllowsCompetitors(snapshot(21),now),true);assert.equal(quotaAllowsCompetitors(snapshot(20),now),false);
 for(const resetsAt of [undefined,'invalid',new Date(now).toISOString()]){const v:any=snapshot();v.providers[0].windows[0].resetsAt=resetsAt;assert.equal(quotaAllowsCompetitors(v,now),false);}
 for(const refreshedAt of [undefined,'invalid',new Date(now-60000).toISOString(),new Date(now+1).toISOString()]){const v:any=snapshot();Object.assign(v.providers[0].state,{reused:true,refreshedAt});assert.equal(quotaAllowsCompetitors(v,now),false);}
 const reused:any=snapshot();Object.assign(reused.providers[0].state,{reused:true,refreshedAt:new Date(now-1000).toISOString()});assert.equal(quotaAllowsCompetitors(reused,now),true);
 const duplicate=snapshot();duplicate.providers.push(duplicate.providers[0]!);assert.equal(quotaAllowsCompetitors(duplicate,now),false);
 const windows=snapshot();windows.providers[0]!.windows.push(windows.providers[0]!.windows[0]!);assert.equal(quotaAllowsCompetitors(windows,now),false);
 for(const status of ['stale','unknown','error']){const v=snapshot();v.providers[0]!.state.status=status;assert.equal(quotaAllowsCompetitors(v,now),false);}
 assert.equal(quotaAllowsCompetitors(snapshot(),now+60000),false);
});
