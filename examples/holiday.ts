/**
 * The same prompt as `index.ts`, but through the inference gateway.
 *
 * This is the shape a caller actually uses: the composition root supplies the
 * credential, the clock and the route table; the request carries scope,
 * acceptance and limits; the outcome carries every attempt and what it cost.
 * Weave's runtime and an AgentFabric generative implementation would both call
 * `gateway.generate` exactly like this.
 *
 * The table holds two routed units so escalation is visible: on an account
 * without paid credits, `openai/gpt-5.5` returns a non-retryable 403 and the
 * gateway falls through to the second route rather than failing the request.
 * Both attempts are recorded and charged.
 *
 *   npm run example:gateway
 */
import { createInferenceGateway, type GenerationRequest, type RoutedUnit } from '@weave/gateway';
import {
  VERCEL_AI_GATEWAY_ADAPTER,
  VERCEL_AI_GATEWAY_DESTINATION,
  vercelAiGatewayAdapter,
} from '@weave/gateway/vercel-ai-gateway';

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) {
  console.error('AI_GATEWAY_API_KEY is not set. Put it in .env.local (git-ignored) and rerun.');
  process.exit(1);
}

// A routed unit is a versioned context profile, prompt template, model and
// settings chosen together. Prices are micros (1e-6 USD) per million tokens,
// as published by the gateway's model catalogue.
function holidayRoute(
  model: string,
  quality: 'baseline' | 'high',
  contextLimit: number,
  price: { input_per_mtok: number; output_per_mtok: number },
): RoutedUnit {
  return {
    routed_unit_id: `transform.holiday@${model}`,
    operation: 'generate',
    kind: 'transform',
    context_profile: 'profile.none',
    context_profile_version: 1,
    prompt_template: 'template.holiday',
    prompt_template_version: 1,
    adapter: VERCEL_AI_GATEWAY_ADAPTER,
    model,
    settings: { max_output_tokens: 600 },
    destination: VERCEL_AI_GATEWAY_DESTINATION,
    quality,
    context_limit_tokens: contextLimit,
    price,
  };
}

const ROUTES: RoutedUnit[] = [
  holidayRoute('openai/gpt-5.5', 'high', 1_000_000, { input_per_mtok: 5_000_000, output_per_mtok: 30_000_000 }),
  holidayRoute('openai/gpt-4o-mini', 'baseline', 128_000, { input_per_mtok: 150_000, output_per_mtok: 600_000 }),
];

const gateway = createInferenceGateway({
  routes: ROUTES,
  adapters: [vercelAiGatewayAdapter({ apiKey })],
  // The runtime injects its own clock; a script may read the wall clock here.
  clock: { now: () => Date.now() },
});

const request: GenerationRequest = {
  request_id: 'req_holiday_1',
  site: 'example.holiday',
  role: 'working',
  kind: 'transform',
  input: {
    instructions: 'You invent plausible-sounding cultural traditions. Be concrete and brief.',
    prompt: 'Invent a new holiday and describe its traditions.',
  },
  terms: {
    // Baseline: the caller will take gpt-4o-mini's answer if it has to. Asking
    // for `high` here would exclude the fallback at routing and there would be
    // nothing to escalate to.
    quality: 'baseline',
    destinations: [VERCEL_AI_GATEWAY_DESTINATION],
    max_context_tokens: 2_000,
    deadline: Date.now() + 60_000,
    // A worst-case attempt costs 28_000 micros ($0.028) on gpt-5.5 and 660 on
    // gpt-4o-mini; the ceiling leaves room for both attempts the terms allow.
    cost_ceiling: 60_000,
    max_attempts: 2,
  },
};

const outcome = await gateway.generate(request);

function describe(attempt: (typeof outcome.attempts)[number]): string {
  const d = attempt.disposition;
  const detail =
    d.status === 'failed' ? `${d.status} (${d.failure.code})` : d.status === 'unaccepted' ? `${d.status} (${d.reason})` : d.status;
  return `  ${attempt.attempt}. ${attempt.model} -> ${detail}, ${attempt.cost.toFixed(0)} micros`;
}

if (outcome.status !== 'accepted') {
  console.error(`inference ${outcome.status}: ${outcome.reason}`);
  console.error(outcome.attempts.map(describe).join('\n'));
  process.exit(1);
}

console.log(outcome.text);
console.log(`\naccepted by ${outcome.routed_unit_id}, ${outcome.spent.toFixed(0)} micros spent across:`);
console.log(outcome.attempts.map(describe).join('\n'));
if (outcome.uncertainty.length > 0) console.log(`uncertainty: ${outcome.uncertainty.join('; ')}`);
