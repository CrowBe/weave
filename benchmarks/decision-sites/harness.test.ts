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
test('lock refuses concurrent writer and reports dead pid without stealing', async () => {
 const dir = await mkdtemp(join(tmpdir(),'decision-lock-'));
 try {
  const release = acquireLock(dir);
  assert.throws(()=>acquireLock(dir),/locked/);
  release();
  await writeFile(join(dir,'lock'), '2147483647');
  assert.throws(()=>acquireLock(dir),/stale/);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('budget projection and replay binding include all evidence identities', () => {
 assert.equal(projectedCost('1234567', .1), 3 * .1 / 1e6);
 const base = {provider:'p',model:'m',site:'loop.route',item_id:'i',set_digest:'s',question_digest:'q'};
 for(const key of Object.keys(base)) assert.notEqual(replayKey(base),replayKey({...base,[key]:'changed'}));
});
test('requests reuse production builders, including disclosed D3-only state', async () => {
 const r = await buildRequest({id:'i',scenario_id:'s',site:'loop.preselect',state:{preselect_step:'read',index:[{id:'x',purpose:'Read files'}],secret:'excluded'},gold:{entry_0:true}});
 assert.deepEqual(r.state,{step:'read',catalogue_index:[{id:'x',purpose:'Read files'}]});
 assert.deepEqual(r.questions.entry_0?.instructions,{question:'Is this disclosed catalogue entry relevant to this step?',entry:{id:'x',purpose:'Read files'}});
});
