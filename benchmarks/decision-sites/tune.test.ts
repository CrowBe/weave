import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics, productionThresholds, tune, type Observed } from './tune.ts';
import { makeReport } from './report.ts';
import { transitionBooleanSite } from '@weave/weave';

function row(site: string, split: 'tune'|'holdout' = 'tune', overrides: Partial<Observed> = {}): Observed {
  return { item: { id: 'x', scenario_id: 's', site, state: {}, gold: { decision: true } }, split,
    result: { status: 'ok', answers: { decision: { probability: .8, confidence: .95 } } }, latency_ms: 10, cost_usd: .001, ...overrides };
}
test('tuning never reads holdout answers or labels', () => {
  const hidden = { split: 'holdout', get item() { throw Error('holdout leak'); }, get result() { throw Error('holdout leak'); } } as unknown as Observed;
  assert.deepEqual(tune('guard.output', [row('guard.output'), hidden]), tune('guard.output', [row('guard.output')]));
});
test('failures remain in coverage denominator and missing confidence is below zero floor', () => {
  const good = row('guard.output');
  const failed = row('guard.output', 'holdout', { result: { status: 'failed', reason: 'timeout' } });
  const missing = row('guard.output', 'holdout', { result: { status: 'ok', answers: { decision: { probability: .8 } } } });
  const score = metrics('guard.output', [good, failed, missing], { ...productionThresholds('guard.output'), confidence: 0 });
  assert.equal(score.coverage, 1/3); assert.equal(score.missing_confidence, 2); assert.equal(score.violation_recall, 1/3);
});
test('guard loosening is marked for captain and guards maximise recall', () => {
  const low = row('guard.output', 'tune', { result: { status: 'ok', answers: { decision: { probability: .2, confidence: .8 } } } });
  const tuned = tune('guard.output', [low]);
  assert.equal(tuned.not_applied, 'needs captain (#142)');
  assert.equal(metrics('guard.output', [low], tuned).violation_recall, 1);
});
test('D3 reports kth versus excluded gap and multi-entry recall', () => {
  const observed = row('loop.preselect', 'holdout', {
    item: { id: 'multi', scenario_id: 's', site: 'loop.preselect', state: {}, gold: { entry_0: true, entry_1: true, entry_2: false } },
    result: { status: 'ok', answers: { entry_0: { probability: .95, confidence: .9 }, entry_1: { probability: .51, confidence: .9 }, entry_2: { probability: .4, confidence: .9 } } },
  });
  const base = { ...productionThresholds('loop.preselect'), k: 2 };
  const best = metrics('loop.preselect', [observed], base);
  assert.equal(best.coverage, 1); assert.equal(best.needed_recall, 1); assert.equal(best.multi_entry_steps, 1);
  assert.equal(best.mean_kth_gap, .11); assert.equal(best.mean_best_gap, .55);
  assert.equal(metrics('loop.preselect', [observed], { ...base, margin_reference: 'kth_kept' }).coverage, 0);
});
test('D3 production allows absent confidence but tuning does not', () => {
  const observed = row('loop.preselect', 'tune', {
    item: { id: 'x', scenario_id: 's', site: 'loop.preselect', state: {}, gold: { entry_0: true, entry_1: false } },
    result: { status: 'ok', answers: { entry_0: { probability: .9 }, entry_1: { probability: .1 } } },
  });
  assert.equal(metrics('loop.preselect', [observed], { ...productionThresholds('loop.preselect'), k: 1 }).coverage, 1);
  assert.equal(metrics('loop.preselect', [observed], { ...productionThresholds('loop.preselect'), k: 1, allow_missing_confidence: false }).coverage, 0);
});
test('report is deterministic and excludes holdout from tuning', () => {
  const observed = row('guard.output', 'holdout');
  const call = { ...observed, type: 'call' as const, provider: 'fake', model: 'fake', site: 'guard.output', item_id: 'x', set_digest: 'abc', question_digest: 'def', call_id: 'one' };
  const metadata = { run_id: 'offline', node_version: 'v22.0.0', max_spend_usd: 2, set_digests: { 'guard.output': 'abc' } };
  const a = makeReport(metadata, [call]);
  assert.deepEqual(a, makeReport(metadata, [call])); assert.match(a.markdown, /no_tune_data/); assert.match(a.markdown, /0.001000/);
});

test('D3 tuned policy rejects absent confidence even when every entry fits', () => {
  const observed = row('loop.preselect', 'tune', {
    item: { id: 'x', scenario_id: 's', site: 'loop.preselect', state: {}, gold: { entry_0: true } },
    result: { status: 'ok', answers: { entry_0: { probability: .9 } } },
  });
  assert.equal(metrics('loop.preselect', [observed], { ...productionThresholds('loop.preselect'), allow_missing_confidence: false }).coverage, 0);
});
test('D6 production validates the selected distribution', () => {
  const observed = row('audit.dispose', 'holdout', {
    item: { id: 'x', scenario_id: 's', site: 'audit.dispose', state: {}, gold: { finding_0: 'defer' } },
    result: { status: 'ok', answers: { finding_0: { choice: 'defer', confidence: .9 } } },
  });
  assert.equal(metrics('audit.dispose', [observed], productionThresholds('audit.dispose')).coverage, 0);
  assert.equal(metrics('audit.dispose', [observed], {confidence:0,ungated:true}).coverage, 1);
});

test('D5 lower confidence and probability floors require captain', () => {
  const observed = row('eval.output', 'tune', {result:{status:'ok',answers:{decision:{probability:.7,confidence:.8}}}});
  const thresholds=tune('eval.output',[observed]);
  assert.equal(thresholds.not_applied,'needs captain (#142)');
});
test('report uses the live ledger including retry spend and pending reservations', () => {
  const report=makeReport({run_id:'r',node_version:'v22',max_spend_usd:2,set_digests:{},spent_usd:.012,input_tokens:1234,output_tokens:12},[]);
  assert.equal(report.summary.spent_usd,.012);assert.equal(report.summary.remaining_usd,1.988);
  assert.equal(report.summary.input_tokens,1234);assert.match(report.markdown,/0.012000/);
});
test('D3 production metrics match real transition boundary and required-entry behavior', () => {
  const current={state_revision:1,state_updated_at:0};
  const terms={quality:'baseline' as const,destinations:['local'],max_context_tokens:100,deadline:100,cost_ceiling:10,max_attempts:1};
  const cases=[
    {p:[.95,.85,.7,.4],c:[.9,.9,.9,.9],required:[]},
    {p:[.95,.85,.7,.4],c:[.9,.9,.9,.74],required:[]},
    {p:[.95,.85,.7,.4],c:[],required:[]},
    {p:[.95,.85,.7,.4,.1],c:[.9,.9,.9,.9,.1],required:['cap_4']},
    {p:[.7,.6,.5,.4],c:[.9,.9,.9,.9],required:[]},
    {p:[.9,.1],c:[.1,.1],required:[]},
  ];
  for(const fixture of cases){
    const index=fixture.p.map((_,n)=>({id:`cap_${n}`,purpose:'fixture'}));
    const answers=Object.fromEntries(fixture.p.map((probability,n)=>[`entry_${n}`,{type:'boolean' as const,probability}]));
    const confidence=Object.fromEntries(fixture.c.map((c,n)=>[`entry_${n}`,c]));
    const outcome={status:'accepted' as const,kind:'boolean' as const,site:'loop.preselect',request_id:'r',answers,confidence,provider_response_id:undefined,routed_unit_id:'fake',attempts:[],spent:0,uncertainty:[]};
    const transition=transitionBooleanSite('loop.preselect',{...current,terms,request_id:'r',needs_dispatch:false,state:{},catalogue_index:index,required_entry_ids:fixture.required},{state_revision:1,observed_at:1,outcome},current);
    const gold=Object.fromEntries(transition.preselect!.scores.map(s=>[`entry_${s.entry}`,s.kept]));
    const observed=row('loop.preselect','holdout',{item:{id:'x',scenario_id:'s',site:'loop.preselect',state:{index,required_entry_ids:fixture.required},gold},result:{status:'ok',answers:Object.fromEntries(fixture.p.map((probability,n)=>[`entry_${n}`,{probability,...(fixture.c[n]===undefined?{}:{confidence:fixture.c[n]})}]))}});
    const scored=metrics('loop.preselect',[observed],productionThresholds('loop.preselect'));
    assert.equal(scored.coverage,transition.preselect!.outcome==='narrowed'?1:0);
    if(scored.coverage)assert.equal(scored.accuracy,1);
    assert.equal(scored.mean_best_gap,transition.preselect!.margin);
  }
});

test('OpenAI provisional D5 accepts absent confidence only outside its probability band', () => {
  const policy=productionThresholds('eval.output','openai-decisions');
  assert.equal(policy.profile,'openai-provisional-probability-band');
  for(const [p,covered,gold]of [[.85,1,true],[.15,1,false],[.5,0,true]] as const){
    const observed=row('eval.output','holdout',{item:{id:'x',scenario_id:'s',site:'eval.output',state:{},gold:{decision:gold}},result:{status:'ok',answers:{decision:{probability:p}}}});
    const score=metrics('eval.output',[observed],policy);assert.equal(score.coverage,covered);
    if(covered)assert.equal(score.accuracy,1);
  }
  const supplied=row('eval.output','holdout',{result:{status:'ok',answers:{decision:{probability:.95,confidence:.89}}}});
  assert.equal(metrics('eval.output',[supplied],policy).coverage,0);
  assert.equal(metrics('eval.output',[row('eval.output','holdout',{result:{status:'ok',answers:{decision:{probability:.95}}}})],productionThresholds('eval.output','typesafe-jev')).coverage,0);
});
test('OpenAI provisional D5 tunes its band without reading holdout and marks loosening', () => {
  const observed=row('eval.output','tune',{result:{status:'ok',answers:{decision:{probability:.8}}}});
  const held={split:'holdout',get item(){throw Error('holdout leak');},get result(){throw Error('holdout leak');}} as unknown as Observed;
  const selected=tune('eval.output',[observed,held],'openai-decisions');
  assert.equal(selected.not_applied,'needs captain (#142)');
  assert.equal(metrics('eval.output',[observed],selected).coverage,1);
});
