import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, acquireLock, projectedCost, replayKey } from './journal.ts';
import { buildRequest } from './questions.ts';

test('journal repairs torn tail, fsyncs appends, counts each completed attempt once', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'decision-test-'));
 try {
  const path = join(dir,'journal.jsonl');
  await writeFile(path, '{"type":"call","call_id":"a","cost_usd":0.2}\n{"broken":');
  const journal = new Journal(path);
  assert.equal(journal.spent(), .2);
  journal.append({type:'call',call_id:'b',cost_usd:.3});
  assert.equal(new Journal(path).spent(), .5);
  assert.equal((await readFile(path,'utf8')).trim().split('\n').length,2);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('lock refuses re-entrant own pid and reports dead pid without stealing', async () => {
 const dir = await mkdtemp(join(tmpdir(),'decision-lock-'));
 try {
  const release = acquireLock(dir);
  assert.throws(()=>acquireLock(dir),/locked/);
  assert.equal(await readFile(join(dir,'lock'),'utf8'),String(process.pid));
  release();
  await writeFile(join(dir,'lock'), String(process.pid));
  assert.throws(()=>acquireLock(dir),/stale/);
  await writeFile(join(dir,'lock'), '2147483647');
  assert.throws(()=>acquireLock(dir),/stale/);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('own reused PID after a crash reads as stale without stealing the lock', async () => {
 const dir = await mkdtemp(join(tmpdir(),'decision-own-pid-'));
 try {
  const lock = join(dir,'lock');
  await writeFile(lock,String(process.pid));
  assert.throws(()=>acquireLock(dir),/stale/);
  assert.equal(await readFile(lock,'utf8'),String(process.pid));
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('budget projection and replay binding include all evidence identities', () => {
 assert.equal(projectedCost('1234567', .1), 7 * .1 / 1e6);
 assert.equal(projectedCost('漢😀', .1), 7 * .1 / 1e6);
 const base = {provider:'p',model:'m',site:'loop.route',item_id:'i',set_digest:'s',question_digest:'q',request_digest:'wire'};
 for(const key of Object.keys(base)) assert.notEqual(replayKey(base),replayKey({...base,[key]:'changed'}));
});
test('requests reuse production builders, including disclosed D3-only state', async () => {
 const r = await buildRequest({id:'i',scenario_id:'s',site:'loop.preselect',state:{preselect_step:'read',index:[{id:'x',purpose:'Read files'}],secret:'excluded'},gold:{entry_0:true}});
 assert.deepEqual(r.state,{step:'read',catalogue_index:[{id:'x',purpose:'Read files'}]});
 assert.deepEqual(r.questions.entry_0?.instructions,{question:'Is this disclosed catalogue entry relevant to this step?',entry:{id:'x',purpose:'Read files'}});
});

test('empty or malformed lock is stale-unknown and is never stolen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'decision-unknown-lock-'));
 try{
  for(const value of ['', 'not-a-pid', '0']){
   await writeFile(join(dir,'lock'),value);
   assert.throws(()=>acquireLock(dir),/stale-unknown/);
   assert.equal(await readFile(join(dir,'lock'),'utf8'),value);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
