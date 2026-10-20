/**
 * Compare task validation with an external coding agent's own stop.
 *
 * Not part of verify. A missing transcript skips, and a skip is not a pass.
 * The Jev route is pinned to jev-1.13.0. Fixture probabilities are not read.
 * This file does not vendor an agent CLI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInferenceGateway, resolveTypesafeApiKey } from '@weave/gateway';
import {
  TYPESAFE_AI_ADAPTER,
  TYPESAFE_AI_DESTINATION,
  typesafeAiEvaluator,
} from '@weave/gateway/typesafe-ai';
import { loadFrozenSet, loadTranscript, planLiveComparison, runLiveComparison, taskJevRoute } from '@weave/weave';

export type LivePlan =
  | { readonly status: 'skip'; readonly reason: string }
  | { readonly status: 'run'; readonly transcriptPath: string; readonly apiKey: string };

/** Pure planning from the composition root's argv and env. The key is never printed. */
export function planLive(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): LivePlan {
  const flag = argv.indexOf('--transcript');
  const transcriptPath = flag >= 0 ? argv[flag + 1] : undefined;
  const transcriptProvided = typeof transcriptPath === 'string' && transcriptPath.length > 0 && exists(transcriptPath);
  const apiKey = resolveTypesafeApiKey(env);
  const plan = planLiveComparison({ transcript_provided: transcriptProvided, jev_configured: apiKey !== undefined });
  if (plan.status === 'skip') return plan;
  // A run plan implies both; narrow here rather than pass placeholders on.
  if (transcriptPath === undefined || apiKey === undefined) {
    throw new Error('a live comparison run requires a transcript and a TypeSafe key');
  }
  return { status: 'run', transcriptPath, apiKey };
}

async function main(): Promise<void> {
  const plan = planLive(process.argv.slice(2), process.env, existsSync);
  if (plan.status === 'skip') {
    console.log(JSON.stringify({ status: 'skip', reason: plan.reason, live_comparison: 'skip' }));
    return;
  }

  const tasks = loadFrozenSet(JSON.parse(readFileSync(new URL('./frozen-set.json', import.meta.url), 'utf8')));
  const transcript = loadTranscript(JSON.parse(readFileSync(plan.transcriptPath, 'utf8')));
  const gateway = createInferenceGateway({
    routes: [taskJevRoute(TYPESAFE_AI_ADAPTER, TYPESAFE_AI_DESTINATION)],
    evaluators: [typesafeAiEvaluator({ apiKey: plan.apiKey })],
    clock: { now: () => Date.now() },
  });
  const report = await runLiveComparison({
    tasks,
    transcript,
    gateway,
    terms: {
      quality: 'baseline',
      destinations: [TYPESAFE_AI_DESTINATION],
      max_context_tokens: 8_000,
      deadline: Date.now() + 60_000,
      cost_ceiling: 50_000,
      max_attempts: 2,
    },
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
