/** Pure scoring and tune-only threshold selection. See SCORING.md before changing. */
import { SITE_POLICY } from '@weave/weave';
import { BOOLEAN_SITE_POLICY } from '@weave/weave';
import { OUTPUT_EVAL_POLICY } from '@weave/weave';
import { AUDIT_DISPOSITIONS } from '@weave/weave';
import type { Item, Result, Answer } from './types.ts';

export interface Observed {
  readonly item: Item;
  readonly result: Result;
  readonly latency_ms: number;
  readonly cost_usd: number;
  readonly split: 'tune' | 'holdout';
}
export interface Thresholds {
  readonly confidence: number;
  readonly top_p?: number;
  readonly probability?: number;
  readonly fail_probability?: number;
  readonly profile?: 'openai-provisional-probability-band';
  readonly k?: number;
  readonly floor?: number;
  readonly max_excluded?: number;
  readonly margin?: number;
  readonly margin_reference?: 'best_kept' | 'kth_kept';
  readonly allow_missing_confidence?: boolean;
  readonly ungated?: boolean;
  readonly tuning_status?: 'selected' | 'no_tune_data' | 'minimum_coverage_unmet';
  readonly not_applied?: 'needs captain (#142)' | 'looser than production (report only)';
}
export function productionThresholds(site: string, provider?: string): Thresholds {
  if (site === 'loop.preselect') {
    const p = BOOLEAN_SITE_POLICY[site];
    return { confidence: p.confidence, k: p.k, floor: p.floor, max_excluded: p.max_excluded,
      margin: p.min_margin, margin_reference: 'best_kept', allow_missing_confidence: true };
  }
  if (site === 'guard.input' || site === 'guard.output') {
    const p = BOOLEAN_SITE_POLICY[site]; return { confidence: p.confidence, probability: p.threshold };
  }
  if (site === 'eval.output' && provider === 'openai-decisions') return { confidence: OUTPUT_EVAL_POLICY.confidence, probability: .85, fail_probability: .15, allow_missing_confidence: true, profile: 'openai-provisional-probability-band' };
  if (site === 'eval.output') return { confidence: OUTPUT_EVAL_POLICY.confidence, probability: OUTPUT_EVAL_POLICY.probability };
  if (site === 'audit.dispose') return { confidence: .75 };
  if (!(site in SITE_POLICY)) throw new Error('Unknown decision site');
  const p = SITE_POLICY[site as keyof typeof SITE_POLICY];
  return { confidence: p.confidence, ...(site === 'loop.triage' ? { top_p: .6 } : {}) };
}
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const mean = (values: readonly number[]): number | null => values.length ? values.reduce((a,b) => a+b, 0)/values.length : null;
const gap = (a: number, b: number) => Math.round((a-b)*1e10)/1e10;
const guard = (site: string) => site === 'guard.input' || site === 'guard.output';
function confidencePass(answer: Answer | undefined, thresholds: Thresholds): boolean {
  return thresholds.ungated === true || (unit(answer?.confidence) ? answer.confidence >= thresholds.confidence :
    answer?.confidence === undefined && thresholds.allow_missing_confidence === true);
}
function choices(site: string): readonly string[] {
  return site === 'audit.dispose' ? AUDIT_DISPOSITIONS : site in SITE_POLICY ? SITE_POLICY[site as keyof typeof SITE_POLICY].options : [];
}
interface Decision { covered: boolean; predicted: Record<string,string|boolean>; best_gap: number|null; kth_gap: number|null }
function decide(site: string, o: Observed, t: Thresholds): Decision {
  const no: Decision = { covered: false, predicted: {}, best_gap: null, kth_gap: null };
  if (o.result.status !== 'ok' || !o.result.answers) return no;
  const keys = Object.keys(o.item.gold);
  if (site === 'loop.preselect') keys.sort((a,b) => Number(a.slice(6))-Number(b.slice(6)));
  const answers = o.result.answers;
  if (!keys.length || Object.keys(answers).length !== keys.length || keys.some(key => !Object.hasOwn(answers,key))) return no;
  if (site === 'loop.preselect' && !t.ungated) {
    const entries = keys.map((key, ordinal) => ({ key, ordinal, answer: answers[key]!, p: answers[key]?.probability }));
    if (entries.some(e => !unit(e.p) || (e.answer.confidence !== undefined && !unit(e.answer.confidence)))) return no;
    const state = typeof o.item.state === 'object' && o.item.state !== null ? o.item.state as Record<string,unknown> : {};
    const catalogue = Array.isArray(state['catalogue_index'] ?? state['index']) ? (state['catalogue_index'] ?? state['index']) as {id?:unknown}[] : [];
    const requiredIds = Array.isArray(state['required_entry_ids']) ? state['required_entry_ids'] : [];
    const required = new Set(entries.filter(e => requiredIds.includes(catalogue[e.ordinal]?.id)).map(e => e.key));
    const ranked = entries.sort((a,b) => b.p! - a.p! || a.ordinal-b.ordinal);
    const selected = ranked.filter(e => !required.has(e.key) && e.p! >= (t.floor ?? 0)).slice(0,t.k ?? 3);
    const kept = new Set([...required,...selected.map(e => e.key)]);
    const excluded = ranked.find(e => !kept.has(e.key));
    const best_gap = excluded && selected.length ? gap(selected[0]!.p!,excluded.p!) : null;
    const kth_gap = excluded && selected.length ? gap(selected.at(-1)!.p!,excluded.p!) : null;
    const chosenGap = t.margin_reference === 'kth_kept' ? kth_gap : best_gap;
    const boundary = excluded ? [...selected,excluded] : [];
    const tunedMissing = t.allow_missing_confidence !== true && entries.some(e => !unit(e.answer.confidence));
    const covered = !tunedMissing && (!excluded || (chosenGap !== null && chosenGap >= (t.margin ?? .3) &&
      excluded.p! <= (t.max_excluded ?? .4) && boundary.every(e => confidencePass(e.answer,t))));
    return { covered, predicted: Object.fromEntries(keys.map(key => [key,kept.has(key)])), best_gap, kth_gap };
  }
  const predicted: Record<string,string|boolean> = {};
  for (const key of keys) {
    const answer = answers[key];
    if (!answer || !confidencePass(answer,t)) return no;
    if (typeof o.item.gold[key] === 'boolean') {
      if (!unit(answer.probability)) return no;
      if (t.fail_probability !== undefined && answer.probability > t.fail_probability && answer.probability < (t.probability ?? .85)) return no;
      predicted[key] = answer.probability >= (t.probability ?? .5);
    } else {
      if (!answer.choice || !choices(site).includes(answer.choice)) return no;
      if (t.top_p !== undefined || (site === 'audit.dispose' && !t.ungated)) {
        const distribution = answer.probabilities;
        const selected = distribution?.[answer.choice];
        if (!unit(selected) || selected < (t.top_p ?? 0) || !distribution ||
          Object.entries(distribution).some(([key,value]) => !choices(site).includes(key) || !unit(value) || value > selected) ||
          Math.abs(Object.values(distribution).reduce((a,b) => a+b,0)-1) > .000001) return no;
      }
      predicted[key] = answer.choice;
    }
  }
  return { covered: true, predicted, best_gap: null, kth_gap: null };
}
export interface Metrics {
  readonly attempted: number; readonly covered: number; readonly coverage: number; readonly accuracy: number|null;
  readonly exact_set_accuracy: number|null;
  readonly failures: number; readonly missing_confidence: number; readonly confidence_coverage: number;
  readonly mean_confidence: number|null; readonly brier: number|null; readonly ece: number|null; readonly calibration_n: number;
  readonly violation_recall: number|null; readonly needed_recall: number|null; readonly all_needed_recall: number|null;
  readonly multi_entry_steps: number; readonly mean_best_gap: number|null; readonly mean_kth_gap: number|null;
  readonly latency_ms: { readonly p50: number|null; readonly p90: number|null };
  readonly input_tokens: number; readonly output_tokens: number; readonly cost_usd: number; readonly parse_failure_rate: number;
}
/**
 * What each SCORING.md quantity aggregates, in observation and question order:
 * the per-item check that both `metrics` and the Gauge criteria (gauge.ts) read.
 */
export interface Samples {
  /** Per attempted item: 1 when covered. */
  readonly coverage: readonly number[];
  /** Per covered item: 1 when it agrees with every gold label; for D3, when it keeps every needed entry. */
  readonly accuracy: readonly number[];
  /** Per covered item: 1 on exact agreement with every gold label. */
  readonly exact_set_accuracy: readonly number[];
  /** Per gold question: 1 when its confidence is missing or invalid. */
  readonly missing_confidence: readonly number[];
  /** Per gold question with a valid confidence: that confidence. */
  readonly confidence: readonly number[];
  /** Per valid supplied probability: boolean P(true), or the selected choice's probability, against gold. */
  readonly calibration: readonly { readonly p: number; readonly y: number }[];
  /** Per gold-positive guard rule: 1 when a covered item blocked it. */
  readonly violation_recall: readonly number[];
  /** Per needed entry of a covered D3 step: 1 when kept. */
  readonly needed_recall: readonly number[];
  /** Per D3 step: 1 when it needs more than one entry. */
  readonly multi_entry: readonly number[];
  readonly best_gap: readonly number[];
  readonly kth_gap: readonly number[];
}
export function samples(site: string, observations: readonly Observed[], thresholds: Thresholds): Samples {
  const coverage: number[] = [], accuracy: number[] = [], exact: number[] = [], missing: number[] = [], confidence: number[] = [];
  const calibration: {p:number;y:number}[] = [], violations: number[] = [], needed: number[] = [], multi: number[] = [];
  const best: number[] = [], kth: number[] = [];
  for (const o of observations) {
    const decision = decide(site,o,thresholds);
    const gold = Object.entries(o.item.gold);
    const kept = (key: string) => decision.covered && decision.predicted[key] === true ? 1 : 0;
    const itemKept: number[] = [];
    for (const [key,label] of gold) {
      const answer = o.result.status === 'ok' ? o.result.answers?.[key] : undefined;
      if (unit(answer?.confidence)) { confidence.push(answer.confidence); missing.push(0); } else missing.push(1);
      if (guard(site) && label === true) violations.push(kept(key));
      if (site === 'loop.preselect' && label === true) itemKept.push(kept(key));
      if (typeof label === 'boolean' && unit(answer?.probability)) calibration.push({p:answer.probability,y:label ? 1 : 0});
      else if (typeof label === 'string' && answer?.choice && unit(answer.probabilities?.[answer.choice]))
        calibration.push({p:answer.probabilities![answer.choice]!,y:answer.choice === label ? 1 : 0});
    }
    coverage.push(decision.covered ? 1 : 0);
    if (decision.covered) {
      const correct = gold.every(([key,value]) => decision.predicted[key] === value) ? 1 : 0;
      exact.push(correct);
      accuracy.push(site === 'loop.preselect' ? (itemKept.every(k => k === 1) ? 1 : 0) : correct);
    }
    if (site === 'loop.preselect') {
      multi.push(itemKept.length > 1 ? 1 : 0);
      if (decision.covered) needed.push(...itemKept);
    }
    if (decision.best_gap !== null) best.push(decision.best_gap);
    if (decision.kth_gap !== null) kth.push(decision.kth_gap);
  }
  return { coverage, accuracy, exact_set_accuracy:exact, missing_confidence:missing, confidence, calibration,
    violation_recall:violations, needed_recall:needed, multi_entry:multi, best_gap:best, kth_gap:kth };
}
const count = (xs: readonly number[]): number => xs.reduce((a,b) => a+b, 0);
export function metrics(site: string, observations: readonly Observed[], thresholds: Thresholds): Metrics {
  const s = samples(site,observations,thresholds), points = s.calibration;
  const n = observations.length, covered = s.accuracy.length, missing = count(s.missing_confidence), confidenceN = s.confidence.length;
  const latencies = observations.map(o=>o.latency_ms).sort((a,b)=>a-b);
  const bins = Array.from({length:10},()=>({n:0,p:0,y:0}));
  for(const point of points) { const b=bins[Math.min(9,Math.floor(point.p*10))]!; b.n++;b.p+=point.p;b.y+=point.y; }
  return { attempted:n,covered,coverage:n ? covered/n : 0,
    accuracy:covered ? count(s.accuracy)/covered : null,
    exact_set_accuracy:covered ? count(s.exact_set_accuracy)/covered : null,
    failures:observations.filter(o=>o.result.status!=='ok').length,missing_confidence:missing,
    confidence_coverage:confidenceN+missing ? confidenceN/(confidenceN+missing) : 0,
    mean_confidence:mean(s.confidence),
    brier:mean(points.map(v=>(v.p-v.y)**2)),ece:points.length ? bins.reduce((s,b)=>s+(b.n ? Math.abs(b.p-b.y)/points.length : 0),0) : null,calibration_n:points.length,
    violation_recall:guard(site) && s.violation_recall.length ? count(s.violation_recall)/s.violation_recall.length : null,
    needed_recall:site === 'loop.preselect' && s.needed_recall.length ? count(s.needed_recall)/s.needed_recall.length : null,
    all_needed_recall:site === 'loop.preselect' && covered ? count(s.accuracy)/covered : null,multi_entry_steps:count(s.multi_entry),
    mean_best_gap:mean(s.best_gap),mean_kth_gap:mean(s.kth_gap),
    latency_ms:{p50:latencies.length ? latencies[Math.floor(.5*(latencies.length-1))]! : null,p90:latencies.length ? latencies[Math.floor(.9*(latencies.length-1))]! : null},
    input_tokens:observations.reduce((s,o)=>s+(o.result.input_tokens??0),0),output_tokens:observations.reduce((s,o)=>s+(o.result.output_tokens??0),0),
    cost_usd:observations.reduce((s,o)=>s+o.cost_usd,0),parse_failure_rate:n ? observations.filter(o=>o.result.parse_failure).length/n : 0 };
}
/** Question-level holdout diagnostics, independent of production confidence admission. */
export function probabilityOnly(site:string, observations:readonly Observed[]) {
  const points: {p:number;violation:boolean}[]=[];let total=0;
  for(const o of observations)for(const [key,gold] of Object.entries(o.item.gold)) {
    if(typeof gold!=='boolean')continue;
    total++;
    const p=o.result.status==='ok'?o.result.answers?.[key]?.probability:undefined;
    if(unit(p))points.push({p:site==='eval.output'?1-p:p,violation:site==='eval.output'?!gold:gold});
  }
  const positive=points.filter(p=>p.violation),negative=points.filter(p=>!p.violation);
  let wins=0;for(const a of positive)for(const b of negative)wins+=a.p>b.p?1:a.p===b.p?.5:0;
  return {label:'descriptive only, not applied (#142)' as const,block_probability:.3,
    questions:points.length,probability_coverage:total?points.length/total:0,
    violation_recall:positive.length?positive.filter(p=>p.p>=.3).length/positive.length:null,
    false_block_rate:negative.length?negative.filter(p=>p.p>=.3).length/negative.length:null,
    auc:positive.length&&negative.length?wins/(positive.length*negative.length):null};
}
function* grid(site: string, provider?: string): Generator<Thresholds> {
  const production = productionThresholds(site,provider);
  const allow_missing_confidence = production.profile === 'openai-provisional-probability-band';
  yield {...production,allow_missing_confidence};
  const confidence = [...new Set([production.confidence,0,.5,.6,.7,.75,.8,.85,.9,.95,1])];
  for(const c of confidence) {
    const base = { ...production,confidence:c,allow_missing_confidence };
    if(site === 'loop.preselect') {
      for(const k of [1,3,5,8]) for(const floor of [0,.2,.5]) for(const max_excluded of [.2,.4,.6])
        for(const margin of [0,.1,.2,.3,.4]) for(const margin_reference of ['best_kept','kth_kept'] as const)
          yield {...base,k,floor,max_excluded,margin,margin_reference};
    } else if(site === 'loop.triage') { for(const top_p of [0,.4,.5,.6,.7,.8,.9]) yield {...base,top_p}; }
    else if(base.fail_probability !== undefined) {
      for(const probability of [.7,.8,.85,.9,.95]) for(const fail_probability of [.05,.1,.15,.2,.3]) yield {...base,probability,fail_probability};
    }
    else if(base.probability !== undefined) { for(const probability of [.1,.2,.3,.4,.5,.6,.7,.8,.9]) yield {...base,probability}; }
    else yield base;
  }
}
export function tune(site: string, observations: readonly Observed[], provider?: string): Thresholds {
  // Filter before reading labels/results: callers can supply inaccessible holdout observations.
  const rows=observations.filter(o=>o.split==='tune');
  const production=productionThresholds(site,provider);
  if(!rows.length) return {...production,tuning_status:'no_tune_data'};
  let best: Thresholds|undefined, score: Metrics|undefined;
  for(const candidate of grid(site,provider)) {
    const m=metrics(site,rows,candidate);
    if(m.coverage<.5) continue;
    const better = !score || (guard(site) && (m.violation_recall??0)>(score.violation_recall??0)) ||
      ((!guard(site) || (m.violation_recall??0)===(score.violation_recall??0)) &&
        ((m.accuracy??0)>(score.accuracy??0) || ((m.accuracy??0)===(score.accuracy??0) && m.coverage>score.coverage)));
    if(better) {best=candidate;score=m;}
  }
  if(!best) return {...production,tuning_status:'minimum_coverage_unmet'};
  const not_applied: Thresholds['not_applied'] = guard(site) || site==='loop.preselect' || site==='eval.output'
    ? 'needs captain (#142)' : 'looser than production (report only)';
  return {...best,tuning_status:'selected',...(isLooser(site,best,production) ? {not_applied} : {})};
}
export function isLooser(site:string,best:Thresholds,production:Thresholds):boolean {
  return best.confidence<production.confidence ||
    (guard(site) && (best.probability??0)>(production.probability??0)) ||
    (site==='loop.triage' && (best.top_p??0)<(production.top_p??0)) ||
    (site==='loop.preselect' && ((best.margin??0)<(production.margin??0) ||
      (best.max_excluded??0)>(production.max_excluded??0) || (best.floor??0)>(production.floor??0) || (best.k??0)<(production.k??0))) ||
    (site==='eval.output' && ((best.probability??0)<(production.probability??0) || (best.fail_probability??0)>(production.fail_probability??0)));
}
