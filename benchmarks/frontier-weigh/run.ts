/**
 * Paired `frontier.weigh@1` comparison. Composition root: the only module here
 * that reads the environment, the route table or the wall clock.
 *
 *   npm run bench:frontier-weigh               offline, plus Jev when a key and route are configured
 *   npm run bench:frontier-weigh -- --offline  never call Jev
 *   npm run bench:frontier-weigh -- --rerun    allow a second live run over the same case-set digest
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  applyRouteOverlay,
  bindDecisionProvider,
  createInferenceGateway,
  parseRouteConfig,
  resolveTypesafeApiKey,
} from '@weave/gateway';
import { TYPESAFE_AI_ADAPTER, typesafeAiEvaluator } from '@weave/gateway/typesafe-ai';
import { buildCase, loadCaseSet, type BuiltCase } from './build.ts';
import { renderReport, type JevStatus } from './report.ts';
import { CASESET_DIGEST, promotion, scoreCase, type CaseResult, type PromotionVerdict } from './score.ts';
import { constantWeigher, scriptedWeigher, siteWeigher, type WeighOutcome, type Weigher } from './weighers.ts';

const HERE = new URL('./', import.meta.url);
const REPO = new URL('../../', import.meta.url);
const PER_CASE_TIMEOUT_MS = 30_000;

export const OFFLINE_WEIGHERS: readonly { readonly weigher: () => Weigher; readonly role: string }[] = [
  { weigher: scriptedWeigher, role: 'baseline: the runtime default, weights by operation only' },
  { weigher: () => constantWeigher(2), role: 'red control: every candidate `dispatch`' },
  { weigher: () => constantWeigher(0), role: 'red control: every candidate `defer`' },
];

export interface Comparison {
  readonly digest: string;
  readonly results: readonly CaseResult[];
  readonly verdicts: readonly PromotionVerdict[];
  readonly report: string;
}

/** Run every weigher on every case, then score. The holdout is read only here, once per call. */
export async function compare(
  weighers: readonly { readonly weigher: Weigher; readonly role: string }[],
  jev: JevStatus,
): Promise<Comparison> {
  const { set, digest } = loadCaseSet();
  if (digest !== CASESET_DIGEST) {
    throw new Error(`cases.json sha256 ${digest} is not the frozen ${CASESET_DIGEST}; labels changed after freezing`);
  }
  const built: BuiltCase[] = set.cases.map(buildCase);
  const results: CaseResult[] = [];
  for (const { weigher } of weighers) {
    for (const item of built) {
      results.push(scoreCase(item, weigher.id, await weigher.weigh(item)));
    }
  }
  const verdicts = weighers
    .map(({ weigher }) => weigher.id)
    .filter((id) => id !== 'scripted@1')
    .map((id) => promotion(results, id));
  const report = renderReport({
    caseset: set.caseset,
    digest,
    cases: set.cases,
    weighers: weighers.filter(({ weigher }) => weigher.id !== 'jev').map(({ weigher, role }) => ({ id: weigher.id, role })),
    results,
    verdicts,
    jev,
  });
  return { digest, results, verdicts, report };
}

function repoJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, REPO), 'utf8')) as unknown;
}

/** The explicitly configured Jev route, or the reason it cannot run. */
export function configureJev(env: Readonly<Record<string, string | undefined>>): { weigher: Weigher; routed_unit: string } | { not_run: string } {
  const key = resolveTypesafeApiKey(env);
  if (!key) {
    return { not_run: 'no_credential' };
  }
  let json = repoJson(existsSync(new URL('weave.routes.json', REPO)) ? 'weave.routes.json' : 'weave.routes.example.json');
  if (existsSync(new URL('weave.routes.local.json', REPO))) {
    json = applyRouteOverlay(json, repoJson('weave.routes.local.json'));
  }
  const parsed = parseRouteConfig(json);
  if (!parsed.ok) {
    return { not_run: 'invalid_route_config' };
  }
  const unit = parsed.table.find((u) => u.operation === 'evaluate' && u.kind === 'score' && u.adapter === TYPESAFE_AI_ADAPTER);
  if (!unit) {
    return { not_run: 'no_route' };
  }
  let binding: ReturnType<typeof bindDecisionProvider>;
  try {
    binding = bindDecisionProvider(parsed.decision);
  } catch {
    return { not_run: 'unsupported_decision_provider' };
  }
  const gateway = createInferenceGateway({
    routes: [unit],
    evaluators: [typesafeAiEvaluator({ apiKey: key, baseURL: binding.baseURL })],
    clock: { now: () => Date.now() },
  });
  const inner = siteWeigher('jev', 'jev', gateway, [unit.destination], () => Date.now());
  return {
    routed_unit: unit.routed_unit_id,
    weigher: {
      id: 'jev',
      kind: 'jev',
      async weigh(built) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<WeighOutcome>((resolveTimeout) => {
          timer = setTimeout(
            () =>
              resolveTimeout({
                status: 'failed',
                reason: 'timeout',
                weights: [],
                contract: undefined,
                implementation: unit.routed_unit_id,
                spent: 0,
                attempts: 0,
                latency_ms: PER_CASE_TIMEOUT_MS,
              }),
            PER_CASE_TIMEOUT_MS,
          );
        });
        try {
          return await Promise.race([inner.weigh(built), timeout]);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  };
}

export async function main(args: readonly string[] = process.argv.slice(2), env = process.env): Promise<number> {
  const offline = args.includes('--offline');
  const rerun = args.includes('--rerun');
  const unknown = args.filter((arg) => arg !== '--offline' && arg !== '--rerun');
  if (unknown.length > 0) {
    process.stderr.write(`unknown flag: ${unknown.join(' ')}\n`);
    return 2;
  }
  const configured = offline ? { not_run: 'offline' } : configureJev(env);
  const resultsPath = new URL('results.json', HERE);
  const previous = existsSync(resultsPath)
    ? (JSON.parse(readFileSync(resultsPath, 'utf8')) as { digest?: string; jev?: JevStatus })
    : {};
  if (previous.jev?.status === 'run' && previous.digest === CASESET_DIGEST) {
    if (!('weigher' in configured)) {
      process.stderr.write('results.json records a live Jev run; an offline run would overwrite it\n');
      return 1;
    }
    if (!rerun) {
      process.stderr.write('a live Jev run over this case-set digest is already recorded; pass --rerun to start a new experiment\n');
      return 1;
    }
  }
  const run_id = `frontier-weigh-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const jev: JevStatus =
    'weigher' in configured ? { status: 'run', routed_unit: configured.routed_unit, run_id } : { status: 'not_run', reason: configured.not_run };
  const weighers = [
    ...OFFLINE_WEIGHERS.map(({ weigher, role }) => ({ weigher: weigher(), role })),
    ...('weigher' in configured ? [{ weigher: configured.weigher, role: 'configured Jev route' }] : []),
  ];
  const comparison = await compare(weighers, jev);
  writeFileSync(new URL('REPORT.md', HERE), comparison.report);
  writeFileSync(
    resultsPath,
    `${JSON.stringify({ digest: comparison.digest, jev, verdicts: comparison.verdicts, results: comparison.results }, null, 2)}\n`,
  );
  for (const verdict of comparison.verdicts) {
    process.stdout.write(`${verdict.weigher}: ${verdict.verdict}\n`);
  }
  process.stdout.write(jev.status === 'run' ? `jev: ran through ${jev.routed_unit}\n` : `jev: not run (${jev.reason})\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'frontier-weigh comparison failed'}\n`);
      process.exitCode = 1;
    },
  );
}
