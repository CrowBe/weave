import {test,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,mkdirSync,copyFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {flags} from './run.ts';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import {loadSets} from './sets.ts';

// Run the real CLI from an isolated composition root so verification never writes recorded results.
const testRoot=mkdtempSync(join(tmpdir(),'p10-cli-tests-'));
const sourceRoot=new URL('./',import.meta.url).pathname;
for(const name of readdirSync(sourceRoot)){
 if(name==='results')continue;
 if(name==='run.ts'||name==='REPORT.md')copyFileSync(join(sourceRoot,name),join(testRoot,name));
 else symlinkSync(join(sourceRoot,name),join(testRoot,name));
}
writeFileSync(join(testRoot,'package.json'),'{"type":"module"}');
const cliPath=join(testRoot,'run.ts');
const {main}=await import(pathToFileURL(cliPath).href) as typeof import('./run.ts');
after(()=>rmSync(testRoot,{recursive:true,force:true}));

test('CLI budget hard bound and flags',()=>{
 assert.equal(flags([]).maxSpend,2);
 assert.throws(()=>flags(['--max-spend-usd','5.01']));
 assert.equal(flags(['--max-spend-usd','6','--allow-spend-above-5']).maxSpend,6);
 assert.throws(()=>flags(['--run-id','../escape']));
 assert.throws(()=>flags(['--providers','unknown']));
});
test('frozen sets have disjoint scenarios and production-shaped questions',()=>{
 const sets=loadSets(new URL('./sets/',import.meta.url).pathname,['loop.route'],'all');
 assert.ok(sets.entries.length>=24);assert.equal(Object.keys(sets.digests).length,3);
});
test('canary credentials never enter fake offline files or output; resume does not repeat calls',()=>{
 const dir=mkdtempSync(join(tmpdir(),'p10-canary-'));const id=`offline-test-${process.pid}`;
 const resultDir=join(testRoot,'results',id);
 const reportPath=join(testRoot,'REPORT.md');
 let oldReport:string|undefined;try{oldReport=readFileSync(reportPath,'utf8');}catch{}
 const canaries=['P10_TYPESAFE_CANARY_7R9','P10_OPENAI_CANARY_K39'];
 try {
  const args=['--experimental-strip-types',cliPath,'--providers','fake','--sites','loop.route','--run-id',id];
  const env={...process.env,TYPESAFE_API_KEY:canaries[0]!,TYPESAFE_AI_API_KEY:canaries[0]!,OPENAI_API_KEY:canaries[1]!};
  const first=spawnSync(process.execPath,args,{encoding:'utf8',env});assert.equal(first.status,0,first.stderr);
  const journal=readFileSync(join(resultDir,'journal.jsonl'),'utf8');const count=journal.split('\n').filter(s=>s.includes('"type":"call"')).length;
  const resumed=spawnSync(process.execPath,[...args,'--resume'],{encoding:'utf8',env});assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(readFileSync(join(resultDir,'journal.jsonl'),'utf8').split('\n').filter(s=>s.includes('"type":"call"')).length,count);
  const all=[first.stdout,first.stderr,resumed.stdout,resumed.stderr,readFileSync(reportPath,'utf8'),...readdirSync(resultDir).map(name=>readFileSync(join(resultDir,name),'utf8'))].join('\n');
  for(const canary of canaries)assert.equal(all.includes(canary),false);
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(resultDir,{recursive:true,force:true});if(oldReport!==undefined)writeFileSync(reportPath,oldReport);else rmSync(reportPath,{force:true}); }
});

test('SIGINT and SIGTERM abort in-flight calls, flush cancellation, and return nonzero',async()=>{
 const reportPath=join(testRoot,'REPORT.md');
 let oldReport:string|undefined;try{oldReport=readFileSync(reportPath,'utf8');}catch{}
 for(const event of ['SIGINT','SIGTERM'] as const){
  const id=`signal-${event}-${process.pid}`;const dir=join(testRoot,'results',id);
  try {
   const code=await main(['--providers','fake','--sites','loop.route','--run-id',id],{providers:[{
    id:'fake',model:'signal-fake',price:0,serialize:JSON.stringify,
    request:async(_req,signal)=>new Promise(resolve=>{signal.addEventListener('abort',()=>resolve({status:'failed',reason:'cancelled'}),{once:true});setImmediate(()=>process.emit(event));}),
   }]});
   assert.equal(code,130);
   const records=readFileSync(join(dir,'journal.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
   assert.ok(records.some(r=>r.type==='cancelled'));
   const call=records.find(r=>r.type==='call');assert.ok(call);assert.equal(call.result.reason,'cancelled');assert.equal(call.terminal,false);assert.equal(call.cost_usd,0);
   const summary=JSON.parse(readFileSync(join(dir,'summary.json'),'utf8'));assert.equal(summary.decision_providers[0].holdout.coverage,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
 if(oldReport!==undefined)writeFileSync(reportPath,oldReport);else rmSync(reportPath,{force:true});
});

test('CLI reports concurrent and stale locks without stealing them',()=>{
 const id=`locks-${process.pid}`;const dir=join(testRoot,'results',id);
 try{
  mkdirSync(dir,{recursive:true});
  const args=['--experimental-strip-types',cliPath,'--providers','fake','--run-id',id];
  for(const [pid,expected] of [[process.pid,'locked'],[2147483647,'stale'],['','stale-unknown']] as const){
   writeFileSync(join(dir,'lock'),String(pid));
   const result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,1);assert.ok(result.stderr.includes(expected),JSON.stringify({expected,stderr:result.stderr,stdout:result.stdout}));assert.equal(readFileSync(join(dir,'lock'),'utf8'),String(pid));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('cancellation during quota preflight acknowledges an uncalled competitor item',()=>{
 const helper=mkdtempSync(join(tmpdir(),'p10-quota-abort-')),id=`quota-abort-${process.pid}`,dir=join(testRoot,'results',id);
 try{
  writeFileSync(join(helper,'quota-axi'),`#!${process.execPath}\nprocess.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);\n`,{mode:0o700});
  const result=spawnSync(process.execPath,['--experimental-strip-types',cliPath,'--providers','pi','--sites','loop.route','--split','holdout','--run-id',id],{env:{...process.env,PATH:helper+':'+process.env.PATH},encoding:'utf8',timeout:30000});
  assert.equal(result.status,130,result.stderr);
  const records=readFileSync(join(dir,'journal.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const call=records.find(r=>r.type==='call');assert.ok(call);
  assert.equal(call.result.reason,'cancelled');assert.equal(call.terminal,false);assert.equal(call.cost_usd,0);
  assert.equal(records.some(r=>r.type==='provider_status'),false);
 }finally{rmSync(helper,{recursive:true,force:true});rmSync(dir,{recursive:true,force:true});}
});

test('resume re-renders completed results; render-only never dispatches or mutates the journal',async()=>{
 const id=`render-${process.pid}`;const dir=join(testRoot,'results',id);
 const reportPath=join(dir,'REPORT.md');
 const publishedPath=join(testRoot,'REPORT.md');const published=readFileSync(publishedPath,'utf8');
 try{
  const args=['--providers','fake','--sites','loop.route','--run-id',id];
  const first=spawnSync(process.execPath,['--experimental-strip-types',cliPath,...args],{encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);
  const journalPath=join(dir,'journal.jsonl');
  const completed=readFileSync(journalPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(r=>r.type==='call').length;
  const noCalls={providers:[{id:'fake',model:'offline-fake',price:0,serialize:JSON.stringify,request:async()=>{throw Error('unexpected dispatch');}}]};
  writeFileSync(reportPath,'stale report');rmSync(join(dir,'summary.json'));
  assert.equal(await main([...args,'--resume'],noCalls),0);
  assert.match(readFileSync(reportPath,'utf8'),/Decision-site benchmark/);
  assert.equal(readFileSync(publishedPath,'utf8'),published);
  assert.equal(readFileSync(journalPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(r=>r.type==='call').length,completed);
  // A journal may end in a torn tail after a crash. Rendering must leave even those bytes alone.
  const before=readFileSync(journalPath,'utf8')+'{"torn":';writeFileSync(journalPath,before);
  writeFileSync(reportPath,'stale report');rmSync(join(dir,'summary.json'));
  let calls=0;const uncompleted={providers:[{...noCalls.providers[0]!,model:'new-model',request:async()=>{calls++;throw Error('unexpected dispatch');}}]};
  assert.equal(await main([...args,'--render-only'],uncompleted),0);
  assert.equal(calls,0);assert.equal(readFileSync(journalPath,'utf8'),before);
  assert.match(readFileSync(reportPath,'utf8'),/Decision-site benchmark/);
  assert.equal(readFileSync(publishedPath,'utf8'),published);
  assert.ok(JSON.parse(readFileSync(join(dir,'summary.json'),'utf8')).non_gating);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('quota and competitor children receive only auth-location environment, never API keys',()=>{
 const dir=mkdtempSync(join(tmpdir(),'p10-child-env-'));const id=`child-env-${process.pid}`;
 const resultDir=join(testRoot,'results',id);
 const reportPath=join(testRoot,'REPORT.md');
 const oldReport=readFileSync(reportPath,'utf8');
 try{
  const stub=`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');\nconst name=path.basename(process.argv[1]);\nfs.writeFileSync(path.join(${JSON.stringify(dir)},name+'.env.json'),JSON.stringify(Object.keys(process.env)));\nif(name==='quota-axi'){const now=Date.now();fs.writeSync(1,JSON.stringify({generatedAt:new Date(now).toISOString(),providers:[{provider:'codex',state:{status:'fresh',stale:false},windows:[{id:'weekly',kind:'weekly',percentRemaining:75,resetsAt:new Date(now+3600000).toISOString()}]}]}));}\nelse if(name==='fx'){fs.writeSync(1,'Auth: not authenticated');}\nelse if(process.argv.includes('--help')){fs.writeSync(1,'--mode --no-session --no-tools --no-mcp --no-extensions --no-skills --no-prompt-templates --no-context-files --offline');}\nelse{fs.writeSync(2,'Authentication required');process.exitCode=1;}\n`;
  for(const name of ['quota-axi','pi','fx'])writeFileSync(join(dir,name),stub,{mode:0o700});
  const env={...process.env,PATH:dir+':'+process.env.PATH,XDG_CONFIG_HOME:join(dir,'config'),TYPESAFE_API_KEY:'FAKE_TYPESAFE',TYPESAFE_AI_API_KEY:'FAKE_TYPESAFE_AI',OPENAI_API_KEY:'FAKE_OPENAI',OPENAI_ACCESS_TOKEN:'FAKE_TOKEN',P10_UNRELATED_SECRET:'FAKE_OTHER'};
  const result=spawnSync(process.execPath,['--experimental-strip-types',cliPath,'--providers','pi,fx-ask','--sites','loop.route','--split','holdout','--run-id',id],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  for(const name of ['quota-axi','pi','fx']){
   const names=JSON.parse(readFileSync(join(dir,name+'.env.json'),'utf8')) as string[];
   assert.ok(names.includes('HOME'));assert.ok(names.includes('PATH'));assert.ok(names.includes('XDG_CONFIG_HOME'));
   assert.deepEqual(names.filter(key=>key!=='HOME'&&key!=='PATH'&&!key.startsWith('XDG_')),[],name+' received unrelated environment names');
  }
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(resultDir,{recursive:true,force:true});writeFileSync(reportPath,oldReport);}
});

test('fake and partial reports stay in the run directory without overwriting the published report',async()=>{
 const id=`local-report-${process.pid}`;const dir=join(testRoot,'results',id);
 const reportPath=join(testRoot,'REPORT.md');const original=readFileSync(reportPath,'utf8');
 try{
  const args=['--providers','fake','--sites','loop.route','--run-id',id];
  assert.equal(await main(args),0);
  assert.equal(readFileSync(reportPath,'utf8'),original);
  assert.match(readFileSync(join(dir,'REPORT.md'),'utf8'),/Decision-site benchmark/);
  assert.equal(await main([...args,'--resume','--split','holdout']),0);
  assert.equal(readFileSync(reportPath,'utf8'),original);
 }finally{rmSync(dir,{recursive:true,force:true});writeFileSync(reportPath,original);}
 const partialId=`partial-report-${process.pid}`,partialDir=join(testRoot,'results',partialId);
 try{
  assert.equal(await main(['--providers','typesafe-jev','--sites','loop.route','--split','holdout','--run-id',partialId],{providers:[{id:'typesafe-jev',model:'fake-live-shape',price:0,serialize:JSON.stringify,request:async()=>({status:'skipped',reason:'no_credential'})}]}),0);
  assert.equal(readFileSync(reportPath,'utf8'),original);
  assert.match(readFileSync(join(partialDir,'REPORT.md'),'utf8'),/Decision-site benchmark/);
 }finally{rmSync(partialDir,{recursive:true,force:true});writeFileSync(reportPath,original);}
});

test('a budget-stopped all-site run writes its report only in its run directory',async()=>{
 const id=`budget-report-${process.pid}`,dir=join(testRoot,'results',id);
 const reportPath=join(testRoot,'REPORT.md'),original=readFileSync(reportPath,'utf8');
 let calls=0;
 try{
  assert.equal(await main(['--providers','typesafe-jev','--max-spend-usd','0','--run-id',id],{providers:[{id:'typesafe-jev',model:'fake-live-shape',price:.1,serialize:JSON.stringify,request:async()=>{calls++;throw Error('budget must block');}}]}),0);
  assert.equal(calls,0);assert.equal(readFileSync(reportPath,'utf8'),original);
  assert.match(readFileSync(join(dir,'REPORT.md'),'utf8'),/budget_stop/);
 }finally{rmSync(dir,{recursive:true,force:true});writeFileSync(reportPath,original);}
});

test('an all-skipped run keeps its empty report out of the published report',async()=>{
 const id=`skipped-report-${process.pid}`,dir=join(testRoot,'results',id);
 const reportPath=join(testRoot,'REPORT.md'),original=readFileSync(reportPath,'utf8');
 try{
  assert.equal(await main(['--providers','typesafe-jev','--run-id',id],{providers:[{id:'typesafe-jev',model:'fake-live-shape',price:0,serialize:JSON.stringify,request:async()=>({status:'skipped',reason:'no_credential'})}]}),0);
  assert.equal(readFileSync(reportPath,'utf8'),original);
  assert.match(readFileSync(join(dir,'REPORT.md'),'utf8'),/no_credential/);
 }finally{rmSync(dir,{recursive:true,force:true});writeFileSync(reportPath,original);}
});

test('resume binds spend to the first run ceiling and requires explicit authorization for increases',async()=>{
 const id=`ceiling-${process.pid}`,dir=join(testRoot,'results',id),args=['--providers','fake','--sites','loop.route','--run-id',id];
 try{
  assert.equal(await main([...args,'--max-spend-usd','1']),0);
  const path=join(dir,'journal.jsonl'),original=readFileSync(path,'utf8');
  await assert.rejects(main([...args,'--resume','--max-spend-usd','2']),/ceiling increase requires --allow-spend-increase/);
  assert.equal(readFileSync(path,'utf8'),original);
  assert.equal(await main([...args,'--resume']),0);
  assert.equal(JSON.parse(readFileSync(join(dir,'summary.json'),'utf8')).max_spend_usd,1);
  assert.equal(await main([...args,'--resume','--max-spend-usd','.5']),0);
  assert.equal(JSON.parse(readFileSync(join(dir,'summary.json'),'utf8')).max_spend_usd,.5);
  assert.equal(await main([...args,'--render-only']),0);
  assert.equal(JSON.parse(readFileSync(join(dir,'summary.json'),'utf8')).max_spend_usd,1);
  assert.equal(await main([...args,'--resume','--max-spend-usd','3','--allow-spend-increase']),0);
  assert.equal(JSON.parse(readFileSync(join(dir,'summary.json'),'utf8')).max_spend_usd,3);
  // A prior increase must not silently reset the original ceiling for later invocations.
  await assert.rejects(main([...args,'--resume','--max-spend-usd','3']),/ceiling increase requires/);
  await assert.rejects(main([...args,'--resume','--max-spend-usd','6','--allow-spend-increase']),/above 5/);
  assert.equal(await main([...args,'--resume','--max-spend-usd','6','--allow-spend-increase','--allow-spend-above-5']),0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a failed temp-directory creation releases the run lock',async()=>{
 const id=`temp-failure-${process.pid}`,dir=join(testRoot,'results',id);
 const stub=mock.method(fs,'mkdtempSync',()=>{throw Error('fake temp failure');});
 syncBuiltinESMExports();
 try{
  await assert.rejects(main(['--providers','fake','--run-id',id]),/fake temp failure/);
  assert.equal(existsSync(join(dir,'lock')),false);
 }finally{stub.mock.restore();syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

test('a recovered quota skip is not reported as a current provider skip after resume',async()=>{
 const id=`quota-recovery-${process.pid}`,dir=join(testRoot,'results',id);
 const args=['--providers','pi','--sites','loop.route','--split','holdout','--run-id',id];let calls=0;
 const injected={providers:[{id:'pi',model:'chatgpt-sign-in',competitor:true,price:0,serialize:JSON.stringify,request:async()=>{
  calls++;return calls===1?{status:'skipped' as const,reason:'quota_unavailable_or_weekly_cap'}:{status:'ok' as const,model:'chatgpt-sign-in',answers:{decision:{choice:'flash',confidence:.99}}};
 }}]};
 try{
  assert.equal(await main(args,injected),0);
  assert.equal(JSON.parse(readFileSync(join(dir,'summary.json'),'utf8')).competitors[0].skip_reason,'quota_unavailable_or_weekly_cap');
  assert.equal(await main([...args,'--resume'],injected),0);
  const summary=JSON.parse(readFileSync(join(dir,'summary.json'),'utf8'));
  assert.equal(summary.competitors[0].holdout.attempted,12);assert.equal(calls,13);
  assert.equal(summary.competitors[0].skip_reason,null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('competitor and quota calls use fresh empty cwd and clean up on success, error and abort',()=>{
 const helper=mkdtempSync(join(tmpdir(),'p10-cwd-fixtures-'));
 const help='--mode --no-session --no-tools --no-mcp --no-extensions --no-skills --no-prompt-templates --no-context-files --offline';
 try{
  for(const mode of ['success','error','abort']){
   const id=`cwd-${mode}-${process.pid}`,resultDir=join(testRoot,'results',id),log=join(helper,mode+'.jsonl');
   const stub=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const name=path.basename(process.argv[1]),help=process.argv.includes('--help'),status=process.argv[2]==='status';
const prompt=name!=='quota-axi'&&!help&&!status;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({name,prompt,cwd:process.cwd(),entries:fs.readdirSync(process.cwd())})+'\\n');
fs.writeFileSync('marker','fixture residue');
if(name==='quota-axi'){const now=Date.now();fs.writeSync(1,JSON.stringify({generatedAt:new Date(now).toISOString(),providers:[{provider:'codex',state:{status:'fresh',stale:false},windows:[{id:'weekly',kind:'weekly',percentRemaining:75,resetsAt:new Date(now+3600000).toISOString()}]}]}));}
else if(status)fs.writeSync(1,'Auth: authenticated with ChatGPT');
else if(help)fs.writeSync(1,${JSON.stringify(help)});
else if(${JSON.stringify(mode)}==='abort'){process.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);}
else if(${JSON.stringify(mode)}==='error'){fs.writeSync(2,'fixture error');process.exitCode=1;}
else fs.writeSync(1,JSON.stringify({answers:{decision:{choice:'flash',confidence:.95}}}));
`;
   for(const name of ['quota-axi','pi','fx'])writeFileSync(join(helper,name),stub,{mode:0o700});
   const result=spawnSync(process.execPath,['--experimental-strip-types',cliPath,'--providers',mode==='abort'?'pi':'pi,fx-ask','--sites','loop.route','--split','holdout','--run-id',id],{env:{...process.env,PATH:helper+':'+process.env.PATH},encoding:'utf8',timeout:30000});
   assert.equal(result.status,mode==='abort'?130:0,result.stderr);
   const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line) as {name:string;prompt:boolean;cwd:string;entries:string[]});
   assert.ok(calls.some(call=>call.prompt));
   assert.equal(new Set(calls.map(call=>call.cwd)).size,calls.length,'each child needs its own cwd');
   for(const call of calls){assert.deepEqual(call.entries,[]);assert.equal(existsSync(call.cwd),false,call.cwd+' was not removed');}
   if(mode!=='abort')assert.equal(calls.filter(call=>call.prompt).length,24);
   else{
    const records=readFileSync(join(resultDir,'journal.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const call=records.find(r=>r.type==='call');assert.ok(call);
    assert.equal(call.result.reason,'cancelled_after_dispatch');assert.equal(call.terminal,true);
   }
   rmSync(resultDir,{recursive:true,force:true});
  }
 }finally{rmSync(helper,{recursive:true,force:true});}
});
