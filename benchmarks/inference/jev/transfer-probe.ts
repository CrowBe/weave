/**
 * Run hosted Jev over transfer-v4 and print the scored comparison.
 *
 *   node --env-file-if-exists=.env.local benchmarks/inference/jev/transfer-probe.ts \
 *     --prefer-free --output benchmarks/inference/jev/transfer-results.json
 *
 *   node benchmarks/inference/jev/transfer-probe.ts --from <file>   # rescore only
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Clock } from '@weave/gateway';
import { createJevGateway, readCredentials } from './run.ts';
import {
  loadKevOutcomes,
  loadSuite,
  runSuiteRecord,
  optionKeys,
  selectRecords,
  type TransferRecord,
} from './transfer.ts';
import { orderingsFor, scorePermutation, type PermutationRecordView } from './permutation.ts';

/** Fixed so a recorded run replays with the same presentation orders. */
const ORDER_SEED = 20260921;

function printPermutation(records: readonly TransferRecord[]): void {
  const views: PermutationRecordView[] = [];
  for (const r of records) {
    if (r.status !== 'accepted' || r.predicted === undefined) continue;
    if (r.presented.length < 2) continue;
    views.push({
      case_id: r.id,
      ordering_index: r.ordering_index,
      presented: r.presented,
      label: String(r.label),
      predicted: String(r.predicted),
    });
  }
  if (views.length === 0) return;
  const report = scorePermutation(views);
  if (report.orderings_seen < 2) return;
  console.log('\n  presentation order');
  console.log(
    `    stable          ${report.stable_top}/${report.permuted} permuted records identical across ${
      report.orderings_seen
    } orderings (${(report.stability_rate * 100).toFixed(1)}%)`,
  );
  console.log(
    `    not permuted    ${report.cases - report.permuted} record(s) asked one way only — no order evidence`,
  );
  console.log(
    `    accuracy        worst ordering ${(report.worst_ordering_accuracy * 100).toFixed(1)}%   best ${(
      report.best_ordering_accuracy * 100
    ).toFixed(1)}%   on ${report.balanced_cases} record(s) under every ordering`,
  );
  console.log(`    position bias   ${report.position_bias.toFixed(3)}`);
  console.log(`    chosen position ${JSON.stringify(report.chosen_position)}`);
  console.log(`    label position  ${JSON.stringify(report.label_position)}`);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const clock: Clock = { now: () => Date.now() };
const pct = (v: number): string => (v * 100).toFixed(1).padStart(5) + '%';

/** Wilson score interval: honest at the sample sizes a per-source split gives. */
function wilson(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

function majorityFloor(records: readonly TransferRecord[]): number {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(String(r.label), (counts.get(String(r.label)) ?? 0) + 1);
  return records.length === 0 ? 0 : Math.max(...counts.values()) / records.length;
}

function uniformFloor(records: readonly TransferRecord[]): number {
  if (records.length === 0) return 0;
  return records.reduce((s, r) => s + 1 / Math.max(1, r.option_count), 0) / records.length;
}

function calibration(records: readonly TransferRecord[]): { ece: number; brier: number; mean: number } {
  const pts = records.filter((r) => r.confidence !== undefined && r.correct !== undefined);
  if (pts.length === 0) return { ece: 0, brier: 0, mean: 0 };
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, hits: 0 }));
  let brier = 0;
  let mean = 0;
  for (const r of pts) {
    const c = r.confidence!;
    const correct = r.correct === true ? 1 : 0;
    const b = bins[Math.min(9, Math.max(0, Math.floor(c * 10)))]!;
    b.n += 1;
    b.conf += c;
    b.hits += correct;
    brier += (c - correct) ** 2;
    mean += c;
  }
  let ece = 0;
  for (const b of bins) if (b.n > 0) ece += (b.n / pts.length) * Math.abs(b.hits / b.n - b.conf / b.n);
  return { ece, brier: brier / pts.length, mean: mean / pts.length };
}

async function main(): Promise<void> {
  const from = flag('from');
  let records: TransferRecord[];

  if (from !== undefined) {
    records = JSON.parse(await readFile(from, 'utf8')) as TransferRecord[];
    console.log(`rescoring ${records.length} recorded results from ${from}; no inference issued`);
  } else {
    const credentials = readCredentials(process.env);
    if ('error' in credentials) {
      console.error(credentials.error);
      process.exit(1);
    }
    const options = { preferFree: has('prefer-free') };
    const suite = await loadSuite(flag('split') ?? 'development');
    const chosen = await selectRecords(suite, has('all'));
    const limit = flag('limit');
    const selected = limit === undefined ? chosen : chosen.slice(0, Number(limit));
    console.log(
      `${selected.length} records from transfer-v4 (${has('all') ? 'full split' : 'paired with Kev’s run'})` +
        `; free route ${options.preferFree ? 'preferred, throttles waited out' : 'escalates on throttle'}`,
    );

    const gateway = createJevGateway(credentials, clock, options);
    const permute = Math.max(1, Number(flag('permute') ?? 1));
    records = [];

    // Only `choice` records have a presentational order to vary, so the other
    // kinds are asked once however many orderings are requested.
    const plan = selected.map((record) => ({
      record,
      orders:
        permute > 1 && record.question.type === 'choice'
          ? orderingsFor(optionKeys(record.question).length, permute, ORDER_SEED)
          : [[] as readonly number[]],
    }));
    const total = plan.reduce((sum, entry) => sum + entry.orders.length, 0);
    if (permute > 1) {
      const permuted = plan.filter((entry) => entry.orders.length > 1).length;
      console.log(
        `permutation: ${permuted} choice record(s) asked under up to ${permute} orderings → ${total} requests`,
      );
    }

    let done = 0;
    for (const { record, orders } of plan) {
      for (let o = 0; o < orders.length; o += 1) {
        records.push(await runSuiteRecord(gateway, clock, credentials, record, options, orders[o]!, o));
        done += 1;
        const last = records[records.length - 1]!;
        process.stdout.write(last.status !== 'accepted' ? '!' : last.correct === true ? '·' : '✗');
        if (done % 60 === 0) process.stdout.write(` ${done}/${total}\n`);
      }
    }
    process.stdout.write('\n');
    const output = flag('output') ?? 'benchmarks/inference/jev/transfer-results.json';
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(records, null, 2));
    console.log(`\n${records.length} records written to ${output}`);
  }

  const scored = records.filter((r) => r.correct !== undefined);
  const hits = scored.filter((r) => r.correct === true).length;
  const acc = scored.length === 0 ? 0 : hits / scored.length;
  const [lo, hi] = wilson(hits, scored.length);
  const uni = uniformFloor(scored);
  const maj = majorityFloor(scored);
  const bestFloor = Math.max(uni, maj);
  const se = Math.sqrt((acc * (1 - acc)) / Math.max(1, scored.length));
  const cal = calibration(scored);

  console.log(`\n── hosted Jev on transfer-v4 ${'─'.repeat(32)}`);
  console.log(`  scored          ${scored.length}/${records.length}`);
  console.log(`  accuracy        ${pct(acc)}   95% Wilson [${pct(lo).trim()}, ${pct(hi).trim()}]`);
  console.log(`  floors          uniform ${pct(uni)}   majority-class ${pct(maj)}`);
  console.log(
    `  margin          ${pct(acc - bestFloor)} over the stronger floor  (${(
      (acc - bestFloor) / Math.max(1e-9, se)
    ).toFixed(1)} s.e.)`,
  );
  console.log(
    `  calibration     ECE ${cal.ece.toFixed(3)}   Brier ${cal.brier.toFixed(3)}   mean conf ${cal.mean.toFixed(3)}`,
  );

  const byType = [...new Set(scored.map((r) => r.type))].sort();
  console.log('\n  by question type');
  for (const t of byType) {
    const subset = scored.filter((r) => r.type === t);
    const h = subset.filter((r) => r.correct === true).length;
    const c = calibration(subset);
    console.log(
      `    ${t.padEnd(8)} n=${String(subset.length).padStart(3)}  acc ${pct(
        h / subset.length,
      )}  uniform ${pct(uniformFloor(subset))}  majority ${pct(majorityFloor(subset))}  ECE ${c.ece.toFixed(3)}`,
    );
  }

  const kev = await loadKevOutcomes();
  console.log('\n  by source' + (kev.size > 0 ? '   (Kev = local 4B fp32 on the same records)' : ''));
  for (const source of [...new Set(scored.map((r) => r.source))].sort()) {
    const subset = scored.filter((r) => r.source === source);
    const h = subset.filter((r) => r.correct === true).length;
    const paired = subset.filter((r) => kev.has(r.id));
    const kevHits = paired.filter((r) => kev.get(r.id)!.correct).length;
    const kevCell =
      paired.length === 0 ? '     —' : pct(kevHits / paired.length);
    console.log(
      `    ${source.padEnd(28)} n=${String(subset.length).padStart(3)}  jev ${pct(
        h / subset.length,
      )}  kev ${kevCell}  uniform ${pct(uniformFloor(subset))}  majority ${pct(majorityFloor(subset))}`,
    );
  }

  const paired = scored.filter((r) => kev.has(r.id));
  if (paired.length > 0) {
    let both = 0;
    let jevOnly = 0;
    let kevOnly = 0;
    let neither = 0;
    for (const r of paired) {
      const k = kev.get(r.id)!.correct;
      if (r.correct === true && k) both += 1;
      else if (r.correct === true) jevOnly += 1;
      else if (k) kevOnly += 1;
      else neither += 1;
    }
    const kevAcc = paired.filter((r) => kev.get(r.id)!.correct).length / paired.length;
    const jevAcc = paired.filter((r) => r.correct === true).length / paired.length;
    const disagree = jevOnly + kevOnly;
    console.log(`\n  paired against Kev on ${paired.length} identical records`);
    console.log(`    hosted Jev ${pct(jevAcc)}   local Kev ${pct(kevAcc)}`);
    console.log(
      `    both right ${both}   jev only ${jevOnly}   kev only ${kevOnly}   neither ${neither}`,
    );
    if (disagree > 0) {
      // McNemar, normal approximation. Small counts make this indicative only.
      const z = (jevOnly - kevOnly) / Math.sqrt(disagree);
      console.log(
        `    they disagree on ${disagree}; McNemar z = ${z.toFixed(2)} ${
          Math.abs(z) < 1.96 ? '(not significant at 0.05)' : '(significant at 0.05)'
        }`,
      );
    }
    const kevLat = paired.map((r) => kev.get(r.id)!.latency_ms).sort((a, b) => a - b);
    const jevLat = paired.map((r) => r.latency_ms).sort((a, b) => a - b);
    const med = (xs: readonly number[]): number => xs[Math.floor(xs.length / 2)] ?? 0;
    console.log(
      `    median latency: hosted ${med(jevLat).toFixed(0)} ms vs local ${med(kevLat).toFixed(0)} ms ` +
        `(${(med(kevLat) / Math.max(1, med(jevLat))).toFixed(0)}x)`,
    );
  }

  const answered: Record<string, number> = {};
  let limited = 0;
  let waited = 0;
  let attempts = 0;
  for (const r of records) {
    if (r.routed_unit_id !== undefined) answered[r.routed_unit_id] = (answered[r.routed_unit_id] ?? 0) + 1;
    limited += r.rate_limited;
    waited += r.waited_ms;
    attempts += r.attempts;
  }
  const lat = records.map((r) => r.latency_ms).sort((a, b) => a - b);
  const q = (p: number): number => lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))] ?? 0;
  printPermutation(records);

  console.log('\n  route and cost');
  console.log(`    answered by   ${JSON.stringify(answered)}`);
  console.log(`    attempts      ${attempts} for ${records.length} requests; ${limited} throttled`);
  console.log(`    waited        ${(waited / 1000).toFixed(1)} s total on the free route`);
  console.log(`    latency (ms)  median ${q(0.5)}  p90 ${q(0.9)}  p95 ${q(0.95)}  max ${lat[lat.length - 1] ?? 0}`);
  console.log(
    `    spent         ${records.reduce((s, r) => s + r.spent, 0).toFixed(1)} micros accounted (free window; not a bill)`,
  );
  const failed = records.filter((r) => r.status !== 'accepted');
  if (failed.length > 0) {
    const reasons: Record<string, number> = {};
    for (const r of failed) reasons[r.reason ?? r.status] = (reasons[r.reason ?? r.status] ?? 0) + 1;
    console.log(`    unaccepted    ${failed.length} ${JSON.stringify(reasons)}`);
  }
}

await main();
