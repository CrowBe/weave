/** Deterministic rendering of bound journal observations. No inference, I/O or clock. */
import { metrics, productionThresholds, tune, type Metrics, type Observed, type Thresholds } from './tune.ts';
export interface ReportMetadata {
  readonly run_id: string;
  readonly node_version: string;
  readonly max_spend_usd: number;
  readonly set_digests: Readonly<Record<string,string>>;
  readonly providers?: readonly string[];
  readonly sites?: readonly string[];
  readonly statuses?: readonly unknown[];
  /** Live journal ledger, including pending reservations and every retry. */
  readonly spent_usd?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}
export interface BoundCall extends Observed {
  readonly type: 'call'; readonly provider: string; readonly model: string; readonly site: string;
  readonly item_id: string; readonly set_digest: string; readonly question_digest: string; readonly call_id: string;
  readonly terminal?: boolean;
}
interface SiteRow {
  readonly site:string;readonly provider:string;readonly tuned_thresholds:Thresholds;
  readonly production_thresholds:Thresholds;readonly holdout:Metrics;readonly production:Metrics;
  readonly tune_items:number;readonly holdout_items:number;
}
interface CompetitorRow { readonly provider:string;readonly site:string;readonly holdout:Metrics }
const pct=(value:number|null) => value === null ? '—' : `${(100*value).toFixed(1)}%`;
const num=(value:number|null) => value === null ? '—' : value.toFixed(3);
const safe=(value:string) => value.replace(/[|\r\n]/g,' ');
function thresholdText(t:Thresholds):string {
 const fields=[`conf≥${t.confidence}`];
 if(t.top_p!==undefined)fields.push(`top-p≥${t.top_p}`);
 if(t.probability!==undefined)fields.push(`p≥${t.probability}`);
 if(t.fail_probability!==undefined)fields.push(`fail-p≤${t.fail_probability}`);
 if(t.profile)fields.push(t.profile);
 if(t.k!==undefined)fields.push(`k=${t.k}`,`floor=${t.floor}`,`excluded≤${t.max_excluded}`,`${t.margin_reference} gap≥${t.margin}`);
 if(t.tuning_status)fields.push(t.tuning_status);
 if(t.not_applied)fields.push(`not_applied: ${t.not_applied}`);
 return fields.join('; ');
}
export function makeReport(metadata:ReportMetadata, records:readonly BoundCall[]) {
 const ordered=[...records].sort((a,b)=>a.site.localeCompare(b.site)||a.provider.localeCompare(b.provider)||a.split.localeCompare(b.split)||a.item_id.localeCompare(b.item_id)||a.call_id.localeCompare(b.call_id));
 // Retry records count towards spend, but a logical item has only its last terminal answer.
 const latest=new Map<string,BoundCall>();
 for(const r of records) if(r.terminal!==false) latest.set(JSON.stringify([r.provider,r.site,r.split,r.item_id,r.set_digest,r.question_digest]),r);
 const observations=[...latest.values()];
 const providers=[...new Set([...(metadata.providers??[]),...records.map(r=>r.provider)])].sort();
 const sites=[...new Set([...(metadata.sites??[]),...records.map(r=>r.site)])].sort();
 const rows:SiteRow[]=[],competitors:CompetitorRow[]=[];
 for(const site of sites)for(const provider of providers) {
  const subset=observations.filter(r=>r.site===site&&r.provider===provider);
  const holdout=subset.filter(r=>r.split==='holdout');
  if(provider==='pi'||provider==='fx-ask') {
   competitors.push({site,provider,holdout:metrics(site,holdout,{confidence:0,ungated:true})});continue;
  }
  const tuned=tune(site,subset,provider),production=productionThresholds(site,provider);
  rows.push({site,provider,tuned_thresholds:tuned,production_thresholds:production,
   holdout:metrics(site,holdout,tuned),production:metrics(site,holdout,production),
   tune_items:subset.filter(r=>r.split==='tune').length,holdout_items:holdout.length});
 }
 const models=[...new Set(ordered.map(r=>r.result.model).filter((m):m is string=>!!m && m!=='chatgpt-sign-in'))].sort();
 const spend=metadata.spent_usd ?? ordered.reduce((s,r)=>s+r.cost_usd,0);
 const digests=Object.fromEntries(Object.entries(metadata.set_digests).sort(([a],[b])=>a.localeCompare(b)));
 const statuses=[...(metadata.statuses??[])].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const summary={schema:'decision-sites.report@1',run_id:metadata.run_id,node_version:metadata.node_version,
  non_gating:true,holdout_used_for_tuning:false,max_spend_usd:metadata.max_spend_usd,spent_usd:spend,
  remaining_usd:Math.max(0,metadata.max_spend_usd-spend),set_digests:digests,models_served:models,
  provider_statuses:statuses,decision_providers:rows,competitors,
  input_tokens:metadata.input_tokens ?? ordered.reduce((s,r)=>s+(r.result.input_tokens??0),0),output_tokens:metadata.output_tokens ?? ordered.reduce((s,r)=>s+(r.result.output_tokens??0),0)};
 const lines=[`# Decision-site benchmark: ${safe(metadata.run_id)}`,'',
  'Non-gating. Thresholds are fitted on tune only; runtime thresholds and guard behavior are unchanged.',
  `Node: ${safe(metadata.node_version)}. Spend: $${spend.toFixed(6)} / $${metadata.max_spend_usd.toFixed(2)}.`,
  `Models served: ${models.length?models.map(safe).join(', '):'none'}.`,'',
  '| Site | Provider | Tuned thresholds | Holdout n | Tuned accuracy | Tuned coverage | Production accuracy | Production coverage |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |'];
 for(const r of rows)lines.push(`| ${r.site} | ${r.provider} | ${thresholdText(r.tuned_thresholds)} | ${r.holdout_items} | ${pct(r.holdout.accuracy)} | ${pct(r.holdout.coverage)} | ${pct(r.production.accuracy)} | ${pct(r.production.coverage)} |`);
 lines.push('','Production thresholds are imported from the site policies (D1 top-p .6 and D6 confidence .75 follow their production transitions). Missing confidence counts below the floor except production D3 (unknown) and the explicitly provisional OpenAI D5 probability band (pass ≥.85, fail ≤.15). The OpenAI band is a benchmark assumption from docs §4b; its deferred adapter has no runtime production policy. Supplied D5 confidence still meets the floor.','','| Site | Provider | Brier | ECE | Mean confidence | Missing confidence | Violation recall | Needed recall / all needed | Multi-entry steps | Best / kth gap | p50 / p90 ms | Input / output tokens | USD |',
 '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- | ---: |');
 for(const r of rows){const m=r.holdout;lines.push(`| ${r.site} | ${r.provider} | ${num(m.brier)} | ${num(m.ece)} | ${num(m.mean_confidence)} | ${m.missing_confidence} | ${pct(m.violation_recall)} | ${pct(m.needed_recall)} / ${pct(m.all_needed_recall)} | ${m.multi_entry_steps} | ${num(m.mean_best_gap)} / ${num(m.mean_kth_gap)} | ${num(m.latency_ms.p50)} / ${num(m.latency_ms.p90)} | ${m.input_tokens} / ${m.output_tokens} | ${m.cost_usd.toFixed(6)} |`);}
 lines.push('','## Competitors','','Holdout only; no threshold tuning. Self-reported confidence is separate from probability calibration. Competitor served model ids are unobserved; chatgpt-sign-in is an authentication profile, not a served model id.','',
 '| Competitor | Site | Attempted | Accuracy | Parse-failure rate | Confidence coverage | Answer coverage |',
 '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
 for(const r of competitors)lines.push(`| ${r.provider} | ${r.site} | ${r.holdout.attempted} | ${pct(r.holdout.accuracy)} | ${pct(r.holdout.parse_failure_rate)} | ${pct(r.holdout.confidence_coverage)} | ${pct(r.holdout.coverage)} |`);
 if(!competitors.length)lines.push('| — | — | 0 | — | — | — | — |');
 lines.push('','## Provider statuses','');
 if(statuses.length)for(const status of statuses)lines.push(`- \`${safe(JSON.stringify(status))}\``);
 else lines.push('No provider-status records. See per-provider attempted counts.');
 lines.push('','## Frozen set digests','','| Set | SHA-256 |','| --- | --- |');
 for(const [site,digest]of Object.entries(digests))lines.push(`| ${safe(site)} | ${safe(digest)} |`);
 lines.push('','See [SCORING.md](SCORING.md) for the predeclared objective, denominators and threshold grids.','');
 return {markdown:lines.join('\n'),summary};
}
