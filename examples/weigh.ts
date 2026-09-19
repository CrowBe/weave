/**
 * Weighing candidates with Jev, through the inference gateway.
 *
 * Jev is reachable two ways: through the Vercel AI Gateway, and directly at
 * api.typesafe.ai. Both are routed units in the table below, the direct one
 * second, so a throttled or unavailable gateway escalates rather than failing
 * the judgment. The attempt list printed at the end shows which one answered.
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
 *   npm run example:weigh
 */
import {
  createInferenceGateway,
  type AttemptRecord,
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

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) {
  console.error('AI_GATEWAY_API_KEY is not set. Put it in .env.local (git-ignored) and rerun.');
  process.exit(1);
}
const typesafeKey = process.env.TYPESAFE_AI_API_KEY;

/**
 * Two routed units per answer shape: the same model reached two ways. The
 * Vercel AI Gateway route is preferred and listed first; the direct TypeSafe
 * route is the fallback the gateway escalates to when the first stops working.
 *
 * They carry different destinations because they cross different boundaries,
 * so the fallback engages only because `terms` below names both.
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

  const routes: RoutedUnit[] = [
    {
      ...shared,
      routed_unit_id: `${kind}.candidate@vercel`,
      adapter: VERCEL_AI_GATEWAY_ADAPTER,
      model: 'typesafe-ai/jev',
      destination: VERCEL_AI_GATEWAY_DESTINATION,
    },
  ];

  // The composition root decides whether the fallback exists at all.
  if (typesafeKey) {
    routes.push({
      ...shared,
      routed_unit_id: `${kind}.candidate@typesafe`,
      adapter: TYPESAFE_AI_ADAPTER,
      // The direct API names the model differently than the gateway catalogue.
      model: 'jev-latest',
      destination: TYPESAFE_AI_DESTINATION,
    });
  }
  return routes;
}

const gateway = createInferenceGateway({
  routes: [...jevRoutes('score'), ...jevRoutes('boolean')],
  evaluators: [
    vercelAiGatewayEvaluator({ apiKey }),
    ...(typesafeKey ? [typesafeAiEvaluator({ apiKey: typesafeKey })] : []),
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
  // Naming both destinations is what permits the fallback. Drop the second and
  // the direct route is excluded at routing, not silently used anyway.
  destinations: typesafeKey
    ? [VERCEL_AI_GATEWAY_DESTINATION, TYPESAFE_AI_DESTINATION]
    : [VERCEL_AI_GATEWAY_DESTINATION],
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
