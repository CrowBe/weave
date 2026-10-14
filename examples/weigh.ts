/**
 * Weighing candidates with Jev, through the inference gateway.
 *
 * Direct TypeSafe at api.typesafe.ai is the default. Setting AI_GATEWAY_API_KEY
 * adds an optional Vercel AI Gateway route, listed first when both keys are
 * configured. With only a TypeSafe key, it uses direct routes alone. A throttled
 * or unavailable gateway escalates to the direct route when configured.
 * The attempt list shows which route answered.
 *
 * This is the decision layer's shape, not a chat: one shared state, typed
 * questions, typed answers. Nothing here parses prose into a number, because
 * nothing here asked for prose.
 *
 * It runs two requests over the same state, and that is the point. Score and
 * boolean are different answer shapes, so they are different inference kinds,
 * routed separately and accounted separately — a routed unit earns evidence at
 * one shape without earning it at the other. The cost of that split is the
 * state paying input tokens twice; the printout shows exactly what that came to.
 *
 * The TypeSafe base URL and model come from the route table (`weave.routes.json`
 * when present, otherwise `weave.routes.example.json`, with `weave.routes.local.json`
 * overlaid). The credential comes from `resolveTypesafeApiKey`, never from the
 * file and never from argv.
 *
 *   npm run example:weigh
 */
import { localBudgetGate } from './quota-local.ts';
import { existsSync, readFileSync } from 'node:fs';
import {
  applyRouteOverlay,
  bindDecisionProvider,
  createInferenceGateway,
  parseRouteConfig,
  resolveTypesafeApiKey,
  type AttemptRecord,
  type DecisionProviderBinding,
  type EvaluationKind,
  type RoutedUnit,
} from '@weave/gateway';
import {
  VERCEL_AI_GATEWAY_ADAPTER,
  VERCEL_AI_GATEWAY_DESTINATION,
  vercelAiGatewayEvaluator,
} from '@weave/gateway/vercel-ai-gateway';
import {
  TYPESAFE_AI_ADAPTER,
  TYPESAFE_AI_DESTINATION,
  typesafeAiEvaluator,
} from '@weave/gateway/typesafe-ai';

function repoJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

function loadDecision(): DecisionProviderBinding {
  const primary = existsSync(new URL('../weave.routes.json', import.meta.url))
    ? 'weave.routes.json'
    : 'weave.routes.example.json';
  let json = repoJson(primary);
  if (existsSync(new URL('../weave.routes.local.json', import.meta.url))) {
    json = applyRouteOverlay(json, repoJson('weave.routes.local.json'));
  }
  const parsed = parseRouteConfig(json);
  if (!parsed.ok) {
    console.error(parsed.errors.join('\n'));
    process.exit(1);
  }
  return bindDecisionProvider(parsed.decision);
}

const decision = loadDecision();
const apiKey = process.env.AI_GATEWAY_API_KEY?.trim() || undefined;
const typesafeKey = resolveTypesafeApiKey(process.env);
if (!apiKey && !typesafeKey) {
  console.error('Set TYPESAFE_API_KEY (preferred; TYPESAFE_AI_API_KEY is the legacy fallback) or AI_GATEWAY_API_KEY in .env.local (git-ignored) and rerun.');
  process.exit(1);
}

/**
 * Direct TypeSafe is the default route per answer shape. The Vercel AI Gateway
 * route is an optional extra only when AI_GATEWAY_API_KEY is set; it is listed
 * first when enabled, with escalation to direct TypeSafe when configured.
 *
 * They carry different destinations because they cross different boundaries,
 * so escalation engages only because `terms` below names both.
 */
function jevRoutes(kind: EvaluationKind): RoutedUnit[] {
  const shared = {
    operation: 'evaluate',
    kind,
    context_profile: 'profile.candidate-weighing',
    context_profile_version: 1,
    prompt_template: `template.weigh.${kind}`,
    prompt_template_version: 1,
    // Evaluation has no output cap to set; this is the accounting bound only.
    settings: { max_output_tokens: 256 },
    quality: 'baseline',
    context_limit_tokens: 128_000,
    // Jev bills input only, at $0.042 per million tokens.
    price: { input_per_mtok: 42_000, output_per_mtok: 0 },
  } as const;

  const routes: RoutedUnit[] = apiKey ? [
    {
      ...shared,
      routed_unit_id: `${kind}.candidate@vercel`,
      adapter: VERCEL_AI_GATEWAY_ADAPTER,
      model: 'typesafe-ai/jev',
      destination: VERCEL_AI_GATEWAY_DESTINATION,
    },
  ] : [];

  // The composition root decides whether the direct route exists at all.
  if (typesafeKey) {
    routes.push({
      ...shared,
      routed_unit_id: `${kind}.candidate@typesafe`,
      adapter: TYPESAFE_AI_ADAPTER,
      // The direct API names the model differently than the gateway catalogue.
      model: decision.model,
      destination: TYPESAFE_AI_DESTINATION,
    });
  }
  return routes;
}

const gateway = createInferenceGateway({
  ...localBudgetGate(),
  routes: [...jevRoutes('score'), ...jevRoutes('boolean')],
  evaluators: [
    ...(apiKey ? [vercelAiGatewayEvaluator({ apiKey })] : []),
    ...(typesafeKey ? [typesafeAiEvaluator({ apiKey: typesafeKey, baseURL: decision.baseURL })] : []),
  ],
  // The runtime injects its own clock; a script may read the wall clock here.
  clock: { now: () => Date.now() },
});

// The state every question is asked about. A real judgment site assembles this
// from a context profile; here it is written out so the example is readable.
const state = {
  goal: 'Ship the M1 authority contract without breaking the M0 replay guarantee.',
  situation: 'The runtime records every cycle. Publishing under authority is specified but unimplemented.',
  candidates: {
    a: 'Implement the publish-under-authority path behind the existing scheduler.',
    b: 'Rewrite the scheduler to be async-first before touching authority.',
    c: 'Write more documentation about the authority contract.',
  },
};

const terms = {
  quality: 'baseline',
  // Permit only configured destinations; naming both permits the fallback.
  destinations: [
    ...(apiKey ? [VERCEL_AI_GATEWAY_DESTINATION] : []),
    ...(typesafeKey ? [TYPESAFE_AI_DESTINATION] : []),
  ],
  max_context_tokens: 4_000,
  deadline: Date.now() + 60_000,
  // Worst case is 168 micros an attempt at this context size.
  cost_ceiling: 1_000,
  max_attempts: 2,
} as const;

const LEVELS = ['not at all', 'marginally', 'substantially', 'decisively'];

function describe(attempt: AttemptRecord): string {
  const d = attempt.disposition;
  const detail =
    d.status === 'failed'
      ? `failed (${d.failure.code})`
      : d.status === 'unaccepted'
        ? `unaccepted (${d.reason})`
        : 'accepted';
  return `  ${attempt.attempt}. ${attempt.model} -> ${detail}, ${attempt.cost.toFixed(1)} micros`;
}

// --- How far does each candidate advance the goal? ---------------------------

const weights = await gateway.evaluate({
  request_id: 'req_weigh_score',
  site: 'example.weigh.candidates',
  role: 'framing',
  kind: 'score',
  state,
  questions: Object.fromEntries(
    Object.keys(state.candidates).map((id) => [
      id,
      {
        type: 'score' as const,
        instructions: `How far does candidate ${id} advance the goal, given the situation?`,
        criteria: LEVELS,
      },
    ]),
  ),
  terms,
});

if (weights.status !== 'accepted') {
  console.error(`score evaluation ${weights.status}: ${weights.reason}`);
  console.error(weights.attempts.map(describe).join('\n'));
  process.exit(1);
}

console.log('advancement toward the goal');
for (const [id, answer] of Object.entries(weights.answers)) {
  const level = LEVELS[Math.round(answer.score)] ?? '?';
  const confidence = weights.confidence?.[id];
  const suffix = confidence === undefined ? '' : `  (confidence ${confidence.toFixed(2)})`;
  console.log(`  ${id}: ${answer.score.toFixed(2)} / ${LEVELS.length - 1}  ${level}${suffix}`);
  console.log(`     ${state.candidates[id as keyof typeof state.candidates]}`);
}

// --- Is any of them blocked by the replay guarantee? -------------------------

const risks = await gateway.evaluate({
  request_id: 'req_weigh_boolean',
  site: 'example.weigh.candidates',
  role: 'framing',
  kind: 'boolean',
  state,
  questions: Object.fromEntries(
    Object.keys(state.candidates).map((id) => [
      id,
      {
        type: 'boolean' as const,
        instructions: `Would candidate ${id} risk breaking the M0 replay guarantee?`,
      },
    ]),
  ),
  terms,
});

if (risks.status !== 'accepted') {
  console.error(`boolean evaluation ${risks.status}: ${risks.reason}`);
  console.error(risks.attempts.map(describe).join('\n'));
  process.exit(1);
}

console.log('\nrisk to the replay guarantee');
for (const [id, answer] of Object.entries(risks.answers)) {
  console.log(`  ${id}: P(risk) = ${answer.probability.toFixed(2)}`);
}

// --- What the two requests cost ----------------------------------------------

const spent = weights.spent + risks.spent;
console.log(`\n${spent.toFixed(1)} micros spent across two separately routed requests:`);
console.log(`  score   (${weights.routed_unit_id})`);
console.log(weights.attempts.map(describe).join('\n'));
console.log(`  boolean (${risks.routed_unit_id})`);
console.log(risks.attempts.map(describe).join('\n'));

const uncertainty = [...weights.uncertainty, ...risks.uncertainty];
if (uncertainty.length > 0) console.log(`uncertainty: ${uncertainty.join('; ')}`);
