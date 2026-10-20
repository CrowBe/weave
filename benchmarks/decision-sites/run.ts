/** Composition root: the only benchmark module that reads env or the ambient clock. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildProviders } from './providers.ts';
import { buildCompetitors, museSparkCompetitor, quotaAllowsCompetitors } from './competitors.ts';
import type { ProcessRunner } from './competitors.ts';
import { Journal, acquireLock, ledger } from './journal.ts';
import { SITES } from './questions.ts';
import { countCompetitorCalls, execute } from './engine.ts';
import { bindObservations } from './observations.ts';
import { loadSets } from './sets.ts';
import { makeReport } from './report.ts';
import type { Provider } from './types.ts';
const DEFAULT_PROVIDERS=['typesafe-jev','amos-small','openai-decisions','pi','fx-ask'];
// Selectable with --providers, never implied: Nous terms flag automated and
// performance-monitoring use for a captain decision (WV-016 scout report).
const OPT_IN_PROVIDERS=['nous-portal'];
// Opt-in only: its destination may train on content, so the operator must classify the sets.
const OPTIONAL_PROVIDERS=['muse-spark'];
const CONTENT_CLASS_REQUIRED='Muse Spark requires --content-class public or non_sensitive';
export function flags(args:string[]) {
 const values:Record<string,string>={};const booleans=new Set<string>();
 for(let i=0;i<args.length;i++) {
  const flag=args[i]!;
  if(['--resume','--render-only','--allow-spend-above-5','--allow-spend-increase'].includes(flag)){booleans.add(flag);continue;}
  if(!['--providers','--sites','--split','--max-spend-usd','--run-id','--content-class'].includes(flag)||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('Invalid benchmark flags');
  values[flag]=args[++i]!;
 }
 const maxSpend=Number(values['--max-spend-usd']??2);
 if(!Number.isFinite(maxSpend)||maxSpend<0||(maxSpend>5&&!booleans.has('--allow-spend-above-5')))throw new Error('Spend ceiling above 5 requires --allow-spend-above-5');
 const runId=values['--run-id']??`decision-${new Date().toISOString().replace(/[^0-9]/g,'')}`;
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(runId))throw new Error('Invalid run id');
 const sites=(values['--sites']??SITES.join(',')).split(',');if(sites.some(s=>!SITES.includes(s as typeof SITES[number])))throw new Error('Unknown site');
 const providers=(values['--providers']??DEFAULT_PROVIDERS.join(',')).split(',');
 if(providers.some(p=>![...DEFAULT_PROVIDERS,...OPT_IN_PROVIDERS,...OPTIONAL_PROVIDERS,'fake'].includes(p)))throw new Error('Unknown provider');
 const contentClass=values['--content-class'];
 if(contentClass!==undefined&&contentClass!=='public'&&contentClass!=='non_sensitive')throw new Error(CONTENT_CLASS_REQUIRED);
 if(providers.includes('muse-spark')&&contentClass===undefined)throw new Error(CONTENT_CLASS_REQUIRED);
 const split=values['--split']??'all';if(!['all','tune','holdout'].includes(split))throw new Error('Invalid split');
 return {maxSpend,maxSpendExplicit:values['--max-spend-usd']!==undefined,allowSpendIncrease:booleans.has('--allow-spend-increase'),allowSpendAbove5:booleans.has('--allow-spend-above-5'),runId,sites:[...new Set(sites)],providers:[...new Set(providers)],split,resume:booleans.has('--resume'),renderOnly:booleans.has('--render-only'),...(contentClass===undefined?{}:{contentClass:contentClass as 'public'|'non_sensitive'})};
}
const runProcess:ProcessRunner = async(command,args,options)=>{
 const cwd=mkdtempSync(join(options.cwd,'call-'));
 try {return await new Promise<Awaited<ReturnType<ProcessRunner>>>(resolveProcess=>{
 let stdout='',stderr='',done=false;
 const finish=(exitCode:number)=>{if(!done){done=true;resolveProcess({exitCode,stdout,stderr});}};
 const child=spawn(command,[...args],{cwd,stdio:['pipe','pipe','pipe'],signal:options.signal,
  env:Object.fromEntries(Object.entries(process.env).filter(([name])=>name==='HOME'||name==='PATH'||name.startsWith('XDG_')))});
 child.stdout.on('data',(data:Buffer)=>{stdout+=data.toString();if(stdout.length>4*1024*1024)child.kill('SIGTERM');});
 child.stderr.on('data',(data:Buffer)=>{stderr+=data.toString();if(stderr.length>1024*1024)child.kill('SIGTERM');});
 child.on('error',()=>finish(127));child.on('close',code=>finish(code??1));
 child.stdin.on('error',()=>{});child.stdin.end(options.stdin);
 });}finally{rmSync(cwd,{recursive:true,force:true});}
};
function fakeProvider():Provider {return {id:'fake',model:'offline-fake',price:0,serialize:JSON.stringify,async request(request){return {status:'ok',model:'offline-fake',input_tokens:0,output_tokens:0,answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>[id,q.type==='choice'?{choice:Object.keys(q.criteria)[0]!,confidence:.95,probabilities:Object.fromEntries(Object.keys(q.criteria).map((key,i)=>[key,i===0?1:0]))}:{probability:.1,confidence:.95}]))};}};}
export async function main(args=process.argv.slice(2), injected?:{providers:readonly Provider[]}):Promise<number> {
 const options=flags(args);if(!process.versions.node.startsWith('22.'))throw new Error('Node 22 required');
 const root=dirname(fileURLToPath(import.meta.url));const dir=join(root,'results',options.runId);
 if(options.renderOnly&&!existsSync(join(dir,'journal.jsonl')))throw new Error('Run journal missing');
 const release=acquireLock(dir);let tempPath:string|undefined;
 const controller=new AbortController();const abort=()=>controller.abort();
 process.on('SIGINT',abort);process.on('SIGTERM',abort);
 try {
  const temp=mkdtempSync(join(tmpdir(),'weave-decision-'));tempPath=temp;
  const journal=new Journal(join(dir,'journal.jsonl'),options.renderOnly);
  const history=journal.read();
  if(history.length&&!options.resume&&!options.renderOnly)throw new Error('Run already exists; use --resume');
  const firstRun=history.find(r=>r.type==='run');
  if(firstRun){
   const ceiling=firstRun.max_spend_usd;
   if(typeof ceiling!=='number'||!Number.isFinite(ceiling)||ceiling<0)throw new Error('Invalid original run ceiling');
   if(!options.maxSpendExplicit)options.maxSpend=ceiling;
   else if(options.maxSpend>ceiling&&!options.allowSpendIncrease)throw new Error('Run ceiling increase requires --allow-spend-increase');
  }
  if(!options.renderOnly&&options.maxSpend>5&&!options.allowSpendAbove5)throw new Error('Spend ceiling above 5 requires --allow-spend-above-5');
  const {entries,digests}=loadSets(join(root,'sets'),options.sites,options.split);
  if(!options.renderOnly)journal.append({type:'run',run_id:options.runId,node_version:process.version,max_spend_usd:options.maxSpend,allow_spend_increase:options.allowSpendIncrease,set_digests:digests,providers:options.providers,sites:options.sites,...(options.contentClass?{content_class:options.contentClass}:{})});
  const configs={...(process.env.TYPESAFE_API_KEY??process.env.TYPESAFE_AI_API_KEY?{typesafeKey:(process.env.TYPESAFE_API_KEY??process.env.TYPESAFE_AI_API_KEY)!}:{}),...(process.env.OPENAI_API_KEY?{openaiKey:process.env.OPENAI_API_KEY}:{}),...(process.env.NOUS_API_KEY?{nousKey:process.env.NOUS_API_KEY}:{}),...(process.env.AMOS_BASE_URL?{amosBaseURL:process.env.AMOS_BASE_URL}:{}),now:Date.now,
   sleep:async(ms:number,signal?:AbortSignal)=>{await delay(ms,undefined,signal?{signal}:{});}};
  const counts=Object.fromEntries(['pi','fx-ask'].map(p=>[p,countCompetitorCalls(journal.read(),p)]));
  const competitors=buildCompetitors({run:runProcess,cwd:temp,quotaAllowed:true,callCounts:counts}).map(provider=>({
   ...provider, async request(request:Parameters<Provider['request']>[0],signal:AbortSignal) {
    // Re-read plan quota immediately before every competitor call; never reuse a stale pause snapshot.
    const quota=await runProcess('quota-axi',['--provider','codex','--json'],{cwd:temp,stdin:'',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
    if(signal.aborted)return {status:'failed' as const,reason:'cancelled'};
    let allowed=false;try{allowed=quota.exitCode===0&&quotaAllowsCompetitors(JSON.parse(quota.stdout),Date.now());}catch{/* fail closed */}
    return allowed?provider.request(request,signal):{status:'skipped' as const,reason:'quota_unavailable_or_weekly_cap'};
   }
  }));
  // MODEL_API_KEY is read here only; the competitor sends it solely as a Bearer header.
  const muse=options.contentClass?[museSparkCompetitor({apiKey:process.env.MODEL_API_KEY,contentClass:options.contentClass,now:Date.now})]:[];
  const providers=[...(injected?.providers??[...buildProviders(configs),...competitors,...muse,fakeProvider()])].filter(p=>options.providers.includes(p.id));
  if(!options.renderOnly)await execute({entries,providers,journal,maxSpend:options.maxSpend,now:Date.now,sleep:async(ms,signal)=>{await delay(ms,undefined,signal?{signal}:{});},signal:controller.signal});
  const records=journal.read();
  const {bound,statuses,complete}=await bindObservations(records,providers,entries,options.renderOnly);
  const publish=complete&&!options.providers.includes('fake')&&DEFAULT_PROVIDERS.every(p=>options.providers.includes(p))&&options.split==='all'&&options.sites.length===SITES.length;
  const callCost=records.filter(r=>r.type==='call').reduce((sum,r)=>sum+(r.cost_usd??0),0);
  const reportRecords=bound;
  const report=makeReport({run_id:options.runId,node_version:process.version,max_spend_usd:options.maxSpend,set_digests:digests,providers:options.providers,sites:options.sites,
   statuses,spent_usd:journal.spent(),
   input_tokens:records.filter(r=>r.type==='call').reduce((sum,r)=>sum+(r.result.input_tokens??0),0),
   output_tokens:records.filter(r=>r.type==='call').reduce((sum,r)=>sum+(r.result.output_tokens??0),0)},reportRecords);
  // Reserved spend may over-state the bill (a usage-less 429 is charged at projection), never under-state it.
  const spend=ledger(records);
  Object.assign(report.summary,{metered_call_cost_usd:callCost,observed_usd:spend.observed_usd,reserved_usd:spend.reserved_usd,pending_reservation_usd:spend.pending_reservation_usd});
  writeFileSync(join(dir,'summary.json'),JSON.stringify(report.summary,null,2)+'\n',{mode:0o600});
  const markdown=report.markdown+'\n\nLedger spend (including pending reservations): $'+journal.spent().toFixed(8)+'\n'+
   'Observed spend (usage receipts): $'+spend.observed_usd.toFixed(8)+'. Reserved spend (no usage receipt): $'+spend.reserved_usd.toFixed(8)+
   ', of which pending reservations: $'+spend.pending_reservation_usd.toFixed(8)+'. The budget stop uses the ledger total.\n';
  writeFileSync(join(dir,'REPORT.md'),markdown);
  if(publish&&reportRecords.some(r=>r.result.status==='ok'))writeFileSync(join(root,'REPORT.md'),markdown);
  writeSync(1,`Run ${options.runId}: ${bound.length} items; spend $${journal.spent().toFixed(8)} / $${options.maxSpend.toFixed(2)}\n`);
  return controller.signal.aborted?130:0;
 } finally {process.off('SIGINT',abort);process.off('SIGTERM',abort);try{if(tempPath)rmSync(tempPath,{recursive:true,force:true});}finally{release();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(code=>{process.exitCode=code;}).catch((error:unknown)=>{const message=error instanceof Error?error.message:'';writeSync(2,(['Run directory locked','Run directory has stale lock; inspect before removing','Run directory has stale-unknown lock; inspect before removing','Run already exists; use --resume','Spend ceiling above 5 requires --allow-spend-above-5','Run ceiling increase requires --allow-spend-increase','Invalid original run ceiling','Corrupt journal before final line','Frozen set digest mismatch',CONTENT_CLASS_REQUIRED].includes(message)?message:'Decision benchmark failed; inspect flags, lock, sets and journal.')+'\n');process.exitCode=1;});
