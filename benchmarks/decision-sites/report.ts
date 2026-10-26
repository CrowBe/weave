/** Deterministic rendering of bound journal observations. No inference, I/O or clock. */
import {
  metrics,
  probabilityOnly,
  productionThresholds,
  tune,
  type Metrics,
  type Observed,
  type Thresholds,
} from './tune.ts';
export interface ReportMetadata {
  readonly run_id: string;
  readonly node_version: string;
  readonly max_spend_usd: number;
  readonly set_digests: Readonly<Record<string, string>>;
  readonly providers?: readonly string[];
  readonly sites?: readonly string[];
  readonly statuses?: readonly unknown[];
  /** Live journal ledger, including pending reservations and every retry. */
  readonly spent_usd?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}
export interface BoundCall extends Observed {
  readonly type: 'call';
  readonly provider: string;
  readonly model: string;
  readonly site: string;
  readonly item_id: string;
  readonly set_digest: string;
  readonly question_digest: string;
  readonly call_id: string;
  readonly terminal?: boolean;
}
interface SiteRow {
  readonly site: string;
  readonly provider: string;
  readonly tuned_thresholds: Thresholds;
  readonly production_thresholds: Thresholds;
  readonly holdout: Metrics;
  readonly production: Metrics;
  readonly tune_items: number;
  readonly holdout_items: number;
  readonly probability_only?: ReturnType<typeof probabilityOnly>;
}
interface CompetitorRow {
  readonly provider: string;
  readonly site: string;
  readonly holdout: Metrics;
  readonly skip_reason: string | null;
}
const pct = (value: number | null) => (value === null ? '—' : `${(100 * value).toFixed(1)}%`);
const num = (value: number | null) => (value === null ? '—' : value.toFixed(3));
const safe = (value: string) => value.replace(/[|\r\n]/g, ' ');
function thresholdText(t: Thresholds): string {
  const fields = [`conf≥${t.confidence}`];
  if (t.top_p !== undefined) fields.push(`top-p≥${t.top_p}`);
  if (t.probability !== undefined) fields.push(`p≥${t.probability}`);
  if (t.fail_probability !== undefined) fields.push(`fail-p≤${t.fail_probability}`);
  if (t.profile) fields.push(t.profile);
  if (t.k !== undefined)
    fields.push(`k=${t.k}`, `floor=${t.floor}`, `excluded≤${t.max_excluded}`, `${t.margin_reference} gap≥${t.margin}`);
  if (t.tuning_status) fields.push(t.tuning_status);
  if (t.not_applied) fields.push(`not_applied: ${t.not_applied}`);
  return fields.join('; ');
}
/** Retry records count towards spend, but a logical item has only its last terminal answer. */
export function finalObservations(records: readonly BoundCall[]): BoundCall[] {
  const latest = new Map<string, BoundCall>();
  for (const r of records)
    if (r.terminal !== false)
      latest.set(JSON.stringify([r.provider, r.site, r.split, r.item_id, r.set_digest, r.question_digest]), r);
  return [...latest.values()];
}
export const isCompetitor = (provider: string): boolean =>
  provider === 'pi' || provider === 'fx-ask' || provider === 'nous-portal' || provider === 'muse-spark';
/** Competitors are scored without a gate, on holdout calls that were not provider-level skips. */
export const COMPETITOR_THRESHOLDS: Thresholds = { confidence: 0, ungated: true };
export const competitorCalls = (holdout: readonly BoundCall[]): BoundCall[] =>
  holdout.filter((r) => r.result.status !== 'skipped');
/** Sites whose rows also carry probability-only diagnostics. */
export const PROBABILITY_SITES: readonly string[] = ['guard.input', 'guard.output', 'eval.output'];
export function makeReport(metadata: ReportMetadata, records: readonly BoundCall[]) {
  const ordered = [...records].sort(
    (a, b) =>
      a.site.localeCompare(b.site) ||
      a.provider.localeCompare(b.provider) ||
      a.split.localeCompare(b.split) ||
      a.item_id.localeCompare(b.item_id) ||
      a.call_id.localeCompare(b.call_id),
  );
  const observations = finalObservations(records);
  const providers = [...new Set([...(metadata.providers ?? []), ...records.map((r) => r.provider)])].sort();
  const sites = [...new Set([...(metadata.sites ?? []), ...records.map((r) => r.site)])].sort();
  const rows: SiteRow[] = [],
    competitors: CompetitorRow[] = [];
  for (const site of sites)
    for (const provider of providers) {
      const subset = observations.filter((r) => r.site === site && r.provider === provider);
      const holdout = subset.filter((r) => r.split === 'holdout');
      if (isCompetitor(provider)) {
        let skip_reason = subset.find((r) => r.result.status === 'skipped')?.result.reason ?? null;
        for (const raw of metadata.statuses ?? []) {
          const status = raw as { provider?: string; result?: { status?: string; reason?: string } } | null;
          if (status?.provider === provider && status.result?.status === 'skipped')
            skip_reason = status.result.reason ?? skip_reason;
        }
        competitors.push({
          site,
          provider,
          skip_reason,
          holdout: metrics(site, competitorCalls(holdout), COMPETITOR_THRESHOLDS),
        });
        continue;
      }
      const tuned = tune(site, subset, provider),
        production = productionThresholds(site, provider);
      rows.push({
        site,
        provider,
        tuned_thresholds: tuned,
        production_thresholds: production,
        holdout: metrics(site, holdout, tuned),
        production: metrics(site, holdout, production),
        tune_items: subset.filter((r) => r.split === 'tune').length,
        holdout_items: holdout.length,
        ...(PROBABILITY_SITES.includes(site) ? { probability_only: probabilityOnly(site, holdout) } : {}),
      });
    }
  const models = [
    ...new Set(ordered.map((r) => r.result.model).filter((m): m is string => !!m && m !== 'chatgpt-sign-in')),
  ].sort();
  const spend = metadata.spent_usd ?? ordered.reduce((s, r) => s + r.cost_usd, 0);
  const digests = Object.fromEntries(Object.entries(metadata.set_digests).sort(([a], [b]) => a.localeCompare(b)));
  const statuses = [...(metadata.statuses ?? [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const summary = {
    schema: 'decision-sites.report@1',
    scoring_rule: 'decision-sites.score@2',
    run_id: metadata.run_id,
    node_version: metadata.node_version,
    non_gating: true,
    holdout_used_for_tuning: false,
    max_spend_usd: metadata.max_spend_usd,
    spent_usd: spend,
    remaining_usd: Math.max(0, metadata.max_spend_usd - spend),
    set_digests: digests,
    models_served: models,
    provider_statuses: statuses,
    decision_providers: rows,
    competitors,
    input_tokens: metadata.input_tokens ?? ordered.reduce((s, r) => s + (r.result.input_tokens ?? 0), 0),
    output_tokens: metadata.output_tokens ?? ordered.reduce((s, r) => s + (r.result.output_tokens ?? 0), 0),
  };
  const lines = [
    `# Decision-site benchmark: ${safe(metadata.run_id)}`,
    '',
    'Non-gating. Thresholds are fitted on tune only; runtime thresholds and guard behavior are unchanged.',
    'Scoring rule: decision-sites.score@2 (D3 all-needed objective correction; see SCORING.md).',
    `Node: ${safe(metadata.node_version)}. Spend: $${spend.toFixed(6)} / $${metadata.max_spend_usd.toFixed(2)}.`,
    `Models served: ${models.length ? models.map(safe).join(', ') : 'none'}.`,
    '',
    'D3 headline accuracy is all-needed recall among covered steps: every needed entry is kept, and extra entries are permitted. Exact-set agreement remains secondary. Full-index fallbacks remain uncovered.',
    '',
    '| Site | Provider | Tuned thresholds | Holdout n | Tuned accuracy / D3 all-needed recall | Tuned coverage | Production accuracy / D3 all-needed recall | Production coverage | Exact-set tuned | Exact-set production |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const r of rows)
    lines.push(
      `| ${r.site} | ${r.provider} | ${thresholdText(r.tuned_thresholds)} | ${r.holdout_items} | ${pct(r.holdout.accuracy)} | ${pct(r.holdout.coverage)} | ${pct(r.production.accuracy)} | ${pct(r.production.coverage)} | ${r.site === 'loop.preselect' ? pct(r.holdout.exact_set_accuracy) : '—'} | ${r.site === 'loop.preselect' ? pct(r.production.exact_set_accuracy) : '—'} |`,
    );
  lines.push(
    '',
    'Production thresholds are imported from the site policies (D1 top-p .6 and D6 confidence .75 follow their production transitions). Missing confidence counts below the floor except production D3 (unknown) and the explicitly provisional OpenAI D5 probability band (pass ≥.85, fail ≤.15). The OpenAI band is a benchmark assumption from docs §4b; its deferred adapter has no runtime production policy. Supplied D5 confidence still meets the floor.',
    '',
    '| Site | Provider | Brier | ECE | Mean confidence | Missing confidence | Violation recall | Needed recall / all needed | Multi-entry steps | Best / kth gap | p50 / p90 ms | Input / output tokens | USD |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- | ---: |',
  );
  for (const r of rows) {
    const m = r.holdout;
    lines.push(
      `| ${r.site} | ${r.provider} | ${num(m.brier)} | ${num(m.ece)} | ${num(m.mean_confidence)} | ${m.missing_confidence} | ${pct(m.violation_recall)} | ${pct(m.needed_recall)} / ${pct(m.all_needed_recall)} | ${m.multi_entry_steps} | ${num(m.mean_best_gap)} / ${num(m.mean_kth_gap)} | ${num(m.latency_ms.p50)} / ${num(m.latency_ms.p90)} | ${m.input_tokens} / ${m.output_tokens} | ${m.cost_usd.toFixed(6)} |`,
    );
  }
  lines.push(
    '',
    '## Probability-only safety diagnostics',
    '',
    '**descriptive only, not applied (#142)**. Holdout questions with valid probabilities only; confidence is ignored. Block at P(violation) ≥ .3. For D5, violation means an unsatisfied criterion: P(violation) = 1 − P(satisfied). AUC gives ties half credit and is undefined without both classes. Production gates above are unchanged.',
    '',
    '| Site | Provider | Violation recall | False-block rate | AUC | Probability coverage |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  );
  for (const r of rows)
    if (r.probability_only) {
      const d = r.probability_only;
      lines.push(
        `| ${r.site} | ${r.provider} | ${pct(d.violation_recall)} | ${pct(d.false_block_rate)} | ${num(d.auc)} | ${pct(d.probability_coverage)} |`,
      );
    }
  lines.push(
    '',
    '## Competitors',
    '',
    'Holdout only; no threshold tuning. Provider-level skips are not attempted inference calls. Self-reported confidence is separate from probability calibration. Competitor served model ids are unobserved; chatgpt-sign-in is an authentication profile, not a served model id.' +
      (providers.includes('muse-spark')
        ? " muse-spark records the requested model of the routed unit that answered (1.3 contributor, or its declared 1.2 fallback); the response's own model id is not checked."
        : ''),
    '',
    '| Competitor | Site | Attempted | Accuracy | Parse-failure rate | Confidence coverage | Answer coverage | Skip reason |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  for (const r of competitors)
    lines.push(
      `| ${r.provider} | ${r.site} | ${r.holdout.attempted} | ${pct(r.holdout.accuracy)} | ${pct(r.holdout.parse_failure_rate)} | ${pct(r.holdout.confidence_coverage)} | ${pct(r.holdout.coverage)} | ${r.skip_reason ? safe(r.skip_reason) : '—'} |`,
    );
  if (!competitors.length) lines.push('| — | — | 0 | — | — | — | — | — |');
  lines.push('', '## Provider statuses', '');
  if (statuses.length) for (const status of statuses) lines.push(`- \`${safe(JSON.stringify(status))}\``);
  else lines.push('No provider-status records. See per-provider attempted counts.');
  lines.push('', '## Frozen set digests', '', '| Set | SHA-256 |', '| --- | --- |');
  for (const [site, digest] of Object.entries(digests)) lines.push(`| ${safe(site)} | ${safe(digest)} |`);
  lines.push('', 'See [SCORING.md](SCORING.md) for the predeclared objective, denominators and threshold grids.', '');
  return { markdown: lines.join('\n'), summary };
}
