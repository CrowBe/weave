import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {flags,main} from './run.ts';
import {loadSets} from './sets.ts';

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
 const resultDir=new URL(`./results/${id}`,import.meta.url).pathname;
 const reportPath=new URL('./REPORT.md',import.meta.url).pathname;
 let oldReport:string|undefined;try{oldReport=readFileSync(reportPath,'utf8');}catch{}
 const canaries=['P10_TYPESAFE_CANARY_7R9','P10_OPENAI_CANARY_K39'];
 try {
  const args=['--experimental-strip-types','benchmarks/decision-sites/run.ts','--providers','fake','--sites','loop.route','--run-id',id];
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
 const reportPath=new URL('./REPORT.md',import.meta.url).pathname;
 let oldReport:string|undefined;try{oldReport=readFileSync(reportPath,'utf8');}catch{}
 for(const event of ['SIGINT','SIGTERM'] as const){
  const id=`signal-${event}-${process.pid}`;const dir=new URL(`./results/${id}`,import.meta.url).pathname;
  try {
   const code=await main(['--providers','fake','--sites','loop.route','--run-id',id],{providers:[{
    id:'fake',model:'signal-fake',price:0,concurrency:1,serialize:JSON.stringify,
    request:async(_req,signal)=>new Promise(resolve=>{signal.addEventListener('abort',()=>resolve({status:'ok',model:'signal-fake',answers:{}}),{once:true});setImmediate(()=>process.emit(event));}),
   }]});
   assert.equal(code,130);
   const records=readFileSync(join(dir,'journal.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
   assert.ok(records.some(r=>r.type==='cancelled'));assert.equal(records.some(r=>r.type==='call'),false);
   const summary=JSON.parse(readFileSync(join(dir,'summary.json'),'utf8'));assert.equal(summary.decision_providers[0].holdout.coverage,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
 if(oldReport!==undefined)writeFileSync(reportPath,oldReport);else rmSync(reportPath,{force:true});
});

test('CLI reports concurrent and stale locks without stealing them',()=>{
 const id=`locks-${process.pid}`;const dir=new URL(`./results/${id}`,import.meta.url).pathname;
 try{
  mkdirSync(dir,{recursive:true});
  const args=['--experimental-strip-types','benchmarks/decision-sites/run.ts','--providers','fake','--run-id',id];
  for(const [pid,expected] of [[process.pid,'locked'],[2147483647,'stale']] as const){
   writeFileSync(join(dir,'lock'),String(pid));
   const result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,1);assert.ok(result.stderr.includes(expected),JSON.stringify({expected,stderr:result.stderr,stdout:result.stdout}));assert.equal(readFileSync(join(dir,'lock'),'utf8'),String(pid));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
