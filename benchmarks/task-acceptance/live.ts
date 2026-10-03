/**
 * Compare task validation with an external coding agent's own stop.
 *
 * Not part of verify. A missing transcript skips, and a skip is not a pass.
 * The Jev route is pinned to jev-1.13.0. Fixture probabilities are not read.
 * This file does not vendor an agent CLI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createInferenceGateway } from '@weave/gateway';
import {
  TYPESAFE_AI_ADAPTER,
  TYPESAFE_AI_DESTINATION,
  typesafeAiEvaluator,
} from '@weave/gateway/typesafe-ai';
import { loadFrozenSet, loadTranscript, planLiveComparison, runLiveComparison, taskJevRoute } from '@weave/weave';

const flag = process.argv.indexOf('--transcript');
const transcriptPath = flag >= 0 ? process.argv[flag + 1] : undefined;
const transcriptProvided = typeof transcriptPath === 'string' && transcriptPath.length > 0 && existsSync(transcriptPath);
const jevConfigured = (process.env.TYPESAFE_AI_API_KEY ?? '').trim().length > 0;
const plan = planLiveComparison({ transcript_provided: transcriptProvided, jev_configured: jevConfigured });

if (plan.status === 'skip') {
  console.log(JSON.stringify({ status: 'skip', reason: plan.reason, live_comparison: 'skip' }));
  process.exit(0);
}

const apiKey = process.env.TYPESAFE_AI_API_KEY ?? '';
const tasks = loadFrozenSet(JSON.parse(readFileSync(new URL('./frozen-set.json', import.meta.url), 'utf8')));
const transcript = loadTranscript(JSON.parse(readFileSync(transcriptPath ?? '', 'utf8')));
const gateway = createInferenceGateway({
  routes: [taskJevRoute(TYPESAFE_AI_ADAPTER, TYPESAFE_AI_DESTINATION)],
  evaluators: [typesafeAiEvaluator({ apiKey })],
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
