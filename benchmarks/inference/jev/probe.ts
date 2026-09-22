/**
 * Run the corpus against hosted Jev, write raw records, print the scored report.
 *
 * Requests are issued sequentially by default so the recorded latency is the
 * route's, not a measurement of local contention.
 *
 *   node --env-file-if-exists=.env.local benchmarks/inference/jev/probe.ts \
 *     --repeats 3 --output .local/jev/results.json
 *
 *   node benchmarks/inference/jev/probe.ts --from .local/jev/results.json
 *
 * The second form rescores an existing file and issues no inference.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Clock, EvaluationKind } from '@weave/gateway';
import { CORPUS, type DecisionCase } from './corpus.ts';
import {
  EVALUATION_KINDS,
  createJevGateway,
  createKevGateway,
  describeKevService,
  readCredentials,
  readKevBaseURL,
  runCase,
  type ProbeRecord,
} from './run.ts';
import { scoreShape, type ShapeReport } from './score.ts';
import { applyOrdering, orderingsFor, scorePermutation, type PermutationRecordView } from './permutation.ts';

/** Fixed so a recorded run replays with the same presentation orders. */
const ORDER_SEED = 20260921;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function present(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Records grouped into the view the permutation scorer reads. */
function permutationViews(records: readonly ProbeRecord[], kind: string): PermutationRecordView[] {
  const out: PermutationRecordView[] = [];
  for (const record of records) {
    if (record.kind !== kind || record.status !== 'accepted') continue;
    const predicted = record.ranking?.top;
    if (predicted === undefined) continue;
    out.push({
      case_id: record.case_id,
      ordering_index: record.ordering_index,
      presented: record.candidate_ids,
      label: record.label,
      predicted,
    });
  }
  return out;
}

function printPermutation(kind: string, records: readonly ProbeRecord[]): void {
  const views = permutationViews(records, kind);
  if (views.length === 0) return;
  const report = scorePermutation(views);
  if (report.orderings_seen < 2) {
    console.log(
      `  order           1 ordering only — stability here is repeat-stability, not order-stability`,
    );
    return;
  }
  console.log(
    `  order           ${report.stable_top}/${report.permuted} permuted cases stable across ${report.orderings_seen} orderings (${pct(
      report.stability_rate,
    )})   ${report.cases - report.permuted} case(s) asked one way only`,
  );
  console.log(
    `  order accuracy  worst ordering ${pct(report.worst_ordering_accuracy)}   best ${pct(
      report.best_ordering_accuracy,
    )}   on ${report.balanced_cases} case(s) present under every ordering`,
  );
  console.log(
    `  position bias   ${report.position_bias.toFixed(3)}  (chosen ${JSON.stringify(
      report.chosen_position,
    )} vs label ${JSON.stringify(report.label_position)})`,
  );
}

const clock: Clock = { now: () => Date.now() };

/** Set once in main so the report printer can reach the raw records. */
let PRINT_RECORDS: readonly ProbeRecord[] = [];

function pct(value: number): string {
  return (value * 100).toFixed(1).padStart(5) + '%';
}

function printReport(report: ShapeReport): void {
  const f = report.floors;
  console.log(`\n── ${report.kind} ${'─'.repeat(Math.max(0, 58 - report.kind.length))}`);
  console.log(`  accepted        ${report.accepted}/${report.attempted}`);
  console.log(
    `  accuracy        ${pct(report.accuracy)}  ± ${(report.standard_error * 100).toFixed(1)} (1 s.e.)`,
  );
  console.log(
    `  floors          always-first ${pct(f.always_first)}   uniform ${pct(f.uniform)}   best-constant ${pct(
      f.majority_operation,
    )} (${f.majority_operation_name})`,
  );
  console.log(`  margin          ${pct(report.margin_over_best_floor)} over the strongest floor`);
  if (report.ties > 0) console.log(`  ties            ${report.ties} broken by order`);
  console.log(
    `  calibration     ECE ${report.calibration.ece.toFixed(3)}   Brier ${report.calibration.brier.toFixed(
      3,
    )}   mean conf ${report.calibration.mean_confidence.toFixed(3)}`,
  );
  const c = report.contrast;
  console.log(
    `  contrast        must-move ${c.relevant_flipped_both_correct}/${c.relevant_groups}   must-hold ${c.irrelevant_held}/${c.irrelevant_groups}`,
  );
  printPermutation(report.kind, PRINT_RECORDS);
  const d = report.determinism;
  console.log(
    `  determinism     ${d.unanimous_top}/${d.groups} cases unanimous across repeats   max top-value spread ${d.max_top_value_spread.toFixed(
      3,
    )}`,
  );
  const l = report.latency_ms;
  console.log(`  latency (ms)    median ${l.median}   p90 ${l.p90}   p95 ${l.p95}   max ${l.max}`);
  console.log(`  answered by     ${JSON.stringify(report.answered_by)}`);
  console.log(
    `  routing         ${report.escalated} request(s) took more than one attempt, ${report.waits} wait(s)`,
  );
  if (Object.keys(report.failures).length > 0) console.log(`  failures        ${JSON.stringify(report.failures)}`);
  console.log(`  spent           ${report.spent_micros.toFixed(1)} micros (accounting, not a bill)`);
  console.log('  per source');
  for (const source of report.per_source) {
    console.log(
      `    ${source.source.padEnd(22)} n=${String(source.n).padStart(3)}  acc ${pct(
        source.accuracy,
      )}  always-first ${pct(source.always_first)}`,
    );
  }
}

async function main(): Promise<void> {
  const from = flag('from');
  const kinds = (flag('kinds')?.split(',') ?? EVALUATION_KINDS) as EvaluationKind[];
  const only = flag('cases')?.split(',');
  const corpus: readonly DecisionCase[] = only === undefined ? CORPUS : CORPUS.filter((c) => only.includes(c.id));

  let records: ProbeRecord[];

  if (from !== undefined) {
    records = JSON.parse(await readFile(from, 'utf8')) as ProbeRecord[];
    console.log(`rescoring ${records.length} recorded results from ${from}; no inference issued`);
  } else {
    const credentials = readCredentials(process.env);
    if ('error' in credentials) {
      console.error(credentials.error);
      process.exit(1);
    }
    console.log(
      `credentials: AI_GATEWAY_API_KEY present; TYPESAFE_AI_API_KEY ${
        credentials.typesafe === undefined ? 'absent — no fallback route' : 'present — fallback route enabled'
      }`,
    );

    const repeats = Number(flag('repeats') ?? 1);
    const permute = Math.max(1, Number(flag('permute') ?? 1));
    const local = (flag('model') ?? 'jev') === 'kev';
    const options = { preferFree: present('prefer-free'), local };
    const kevBaseURL = readKevBaseURL(process.env);
    const gateway = local ? createKevGateway(clock, kevBaseURL) : createJevGateway(credentials, clock, options);
    console.log(
      local
        ? `model: local Kev 4B (single route, no fallback)\nservice: ${await describeKevService(kevBaseURL)}`
        : 'model: hosted Jev',
    );
    records = [];

    // Precompute each case's orderings so the plan — and the cost — is known
    // before any request is issued.
    const plan = corpus.map((decision) => ({
      decision,
      orders: orderingsFor(decision.candidates.length, permute, ORDER_SEED),
    }));
    const perPass = plan.reduce((sum, entry) => sum + entry.orders.length, 0);
    const total = perPass * kinds.length * repeats;
    console.log(
      `plan: ${corpus.length} cases × ${kinds.length} shape(s) × ${repeats} repeat(s), ` +
        `${permute} ordering(s) requested → ${total} requests` +
        (options.preferFree ? '; preferring the free route (will wait on throttle)' : ''),
    );

    let done = 0;
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const kind of kinds) {
        for (const { decision, orders } of plan) {
          for (let o = 0; o < orders.length; o += 1) {
            const presented = applyOrdering(decision, orders[o]!);
            const record = await runCase(gateway, clock, credentials, presented, kind, repeat, options, o);
            records.push(record);
            done += 1;
            const mark = record.status === 'accepted' ? (record.ranking?.top === record.label ? '·' : '✗') : '!';
            process.stdout.write(mark);
            if (done % 60 === 0) process.stdout.write(` ${done}/${total}\n`);
          }
        }
      }
    }
    process.stdout.write(`\n`);

    const output = flag('output') ?? '.local/jev/results.json';
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(records, null, 2));
    console.log(`\n${records.length} records written to ${output}`);
  }

  PRINT_RECORDS = records;
  for (const kind of kinds) {
    if (!records.some((r) => r.kind === kind)) continue;
    printReport(scoreShape(kind, records, CORPUS));
  }
  console.log(
    '\nLegend: · correct, ✗ wrong, ! not accepted. Accuracy means nothing without its floor;',
  );
  console.log('the floors are printed above every accuracy for that reason.');
}

await main();
