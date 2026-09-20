/**
 * Free inference, with a paid route behind it.
 *
 * This is the example that shows the gateway deciding between waiting and
 * escalating. Three routes, in the order a caller who prefers not to pay would
 * want them tried: Nous Portal first, because its free tier is generous and it
 * states an exact reset when it does refuse; OpenRouter second, free but on a
 * 50-a-day budget that cannot be polled; a paid model last, which answers but
 * is not free.
 *
 * The caller says how long it is willing to wait by setting a deadline, and
 * the gateway does the rest: it waits out a refusal when the wait fits inside
 * that deadline, and escalates when it does not. Nothing in the gateway knows
 * which provider is which — these are three routed units, and escalation takes
 * the next one when the one before it stops working.
 *
 * Note where the timer comes from. Runtime code in `@weave/gateway` may not
 * reach for `setTimeout` (checks/no-ambient-clock.mjs), so waiting arrives as
 * an injected port exactly like the clock does, and it is this composition
 * root that supplies one.
 *
 *   npm run example:free
 */
import {
  createInferenceGateway,
  type GenerationRequest,
  type RoutedUnit,
  type Timer,
} from '@weave/gateway';
import {
  NOUS_PORTAL_ADAPTER,
  NOUS_PORTAL_DESTINATION,
  NOUS_PORTAL_FREE_MODELS,
  NOUS_PORTAL_OBSERVED_FREE_LIMITS,
  nousPortalAdapter,
} from '@weave/gateway/nous-portal';
import {
  OPEN_ROUTER_ADAPTER,
  OPEN_ROUTER_DESTINATION,
  OPEN_ROUTER_DOCUMENTED_FREE_LIMITS,
  openRouterAdapter,
} from '@weave/gateway/open-router';
import {
  VERCEL_AI_GATEWAY_ADAPTER,
  VERCEL_AI_GATEWAY_DESTINATION,
  vercelAiGatewayAdapter,
} from '@weave/gateway/vercel-ai-gateway';

const nousKey = process.env.NOUS_PORTAL_API_KEY;
const openRouterKey = process.env.OPEN_ROUTER_API_KEY;
if (!nousKey && !openRouterKey) {
  console.error(
    'Set NOUS_PORTAL_API_KEY or OPEN_ROUTER_API_KEY in .env.local (git-ignored) and rerun.',
  );
  process.exit(1);
}
const vercelKey = process.env.AI_GATEWAY_API_KEY;

const SHARED = {
  operation: 'generate',
  kind: 'transform',
  context_profile: 'profile.none',
  context_profile_version: 1,
  prompt_template: 'template.holiday',
  prompt_template_version: 1,
  settings: { max_output_tokens: 700 },
  quality: 'baseline',
} as const;

// Free routes are priced at zero, so both are affordable under any ceiling
// and the configured order decides which is tried first.
const ROUTES: RoutedUnit[] = [];

if (nousKey) {
  ROUTES.push({
    ...SHARED,
    routed_unit_id: 'transform.holiday@nous-longcat',
    adapter: NOUS_PORTAL_ADAPTER,
    model: NOUS_PORTAL_FREE_MODELS.longcat,
    destination: NOUS_PORTAL_DESTINATION,
    context_limit_tokens: 1_048_576,
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    // A fallback only. Nous states an exact reset on a refusal, and a stated
    // delay always beats a declared one.
    rate_limits: NOUS_PORTAL_OBSERVED_FREE_LIMITS,
  });
}

if (openRouterKey) {
  ROUTES.push({
    ...SHARED,
    routed_unit_id: 'transform.holiday@openrouter-nemotron',
    adapter: OPEN_ROUTER_ADAPTER,
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    destination: OPEN_ROUTER_DESTINATION,
    context_limit_tokens: 1_000_000,
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    // Declared, not measured, and only ever used to time a retry after the
    // provider has refused. OpenRouter says nothing until it refuses, so this
    // is the estimate the gateway actually falls back on.
    rate_limits: OPEN_ROUTER_DOCUMENTED_FREE_LIMITS,
  });
}

// The paid fallback only exists if there is a credential for it. Without one
// the free route is the whole table, and a throttle ends the request rather
// than quietly costing money.
if (vercelKey) {
  ROUTES.push({
    ...SHARED,
    routed_unit_id: 'transform.holiday@gpt-4o-mini',
    adapter: VERCEL_AI_GATEWAY_ADAPTER,
    model: 'openai/gpt-4o-mini',
    destination: VERCEL_AI_GATEWAY_DESTINATION,
    context_limit_tokens: 128_000,
    price: { input_per_mtok: 150_000, output_per_mtok: 600_000 },
  });
}

/**
 * Resolves early rather than rejecting when the wait is abandoned. The gateway
 * copes with either, but resolving keeps the abort on one path: the next
 * provider call sees the aborted signal and reports it as a cancellation.
 */
const timer: Timer = {
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      const id = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(id);
          resolve();
        },
        { once: true },
      );
    }),
};

const gateway = createInferenceGateway({
  routes: ROUTES,
  adapters: [
    ...(nousKey ? [nousPortalAdapter({ apiKey: nousKey })] : []),
    ...(openRouterKey ? [openRouterAdapter({ apiKey: openRouterKey })] : []),
    ...(vercelKey ? [vercelAiGatewayAdapter({ apiKey: vercelKey })] : []),
  ],
  clock: { now: () => Date.now() },
  timer,
});

const request: GenerationRequest = {
  request_id: 'req_free_1',
  site: 'example.free',
  role: 'working',
  kind: 'transform',
  input: {
    instructions: 'You invent plausible-sounding cultural traditions. Be concrete and brief.',
    prompt: 'Invent a new holiday and describe its traditions.',
  },
  terms: {
    quality: 'baseline',
    // Each provider is its own destination: reaching a fallback at another
    // vendor is a disclosure decision the caller makes here, not plumbing.
    destinations: [
      ...(nousKey ? [NOUS_PORTAL_DESTINATION] : []),
      ...(openRouterKey ? [OPEN_ROUTER_DESTINATION] : []),
      ...(vercelKey ? [VERCEL_AI_GATEWAY_DESTINATION] : []),
    ],
    max_context_tokens: 2_000,
    // The deadline is the only thing bounding how long the gateway will wait
    // out a throttle. Ninety seconds leaves room for several 3s waits; drop it
    // to a couple of seconds and the same refusal escalates to the paid route
    // instead.
    deadline: Date.now() + 90_000,
    // A worst-case paid attempt is 660 micros; both free routes are 0.
    cost_ceiling: 5_000,
    max_attempts: 5,
  },
};

const outcome = await gateway.generate(request);

function describe(attempt: (typeof outcome.attempts)[number]): string {
  const d = attempt.disposition;
  const detail =
    d.status === 'failed'
      ? `${d.status} (${d.failure.code})`
      : d.status === 'unaccepted'
        ? `${d.status} (${d.reason})`
        : d.status;
  const waited = attempt.waited_ms === undefined ? '' : ` after waiting ${(attempt.waited_ms / 1000).toFixed(1)}s`;
  return `  ${attempt.attempt}. ${attempt.model} -> ${detail}${waited}, ${attempt.cost.toFixed(1)} micros`;
}

if (outcome.status !== 'accepted') {
  console.error(`inference ${outcome.status}: ${outcome.reason}`);
  console.error(outcome.attempts.map(describe).join('\n'));
  if (outcome.uncertainty.length > 0) console.error(`uncertainty: ${outcome.uncertainty.join('; ')}`);
  process.exit(1);
}

console.log(outcome.text);
console.log(`\naccepted by ${outcome.routed_unit_id}, ${outcome.spent.toFixed(1)} micros spent across:`);
console.log(outcome.attempts.map(describe).join('\n'));
if (outcome.uncertainty.length > 0) console.log(`uncertainty: ${outcome.uncertainty.join('; ')}`);
