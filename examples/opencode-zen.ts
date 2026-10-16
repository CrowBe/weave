/**
 * One minimal public call through OpenCode Zen's guarded free DeepSeek route.
 * Credentials enter only at this composition root. Zen documents this model
 * as free for a limited time, with zero retention and no training:
 * https://opencode.ai/docs/zen/
 *
 * The sample JSON unit opencode-zen.deepseek-free.flash uses the same documented
 * free price. Limits float, so no numerical rate limits are declared. The free
 * model guard checks the public live list before each generation; a missing
 * model or throttle makes this routed unit unavailable.
 *
 * npm run example:opencode-zen
 */
import { createInferenceGateway, type RoutedUnit } from '@weave/gateway';
import {
  opencodeZenAdapter,
  OPENCODE_ZEN_ADAPTER,
  OPENCODE_ZEN_DESTINATION,
  OPENCODE_ZEN_MODEL,
} from '@weave/gateway/opencode-zen';

const apiKey = process.env.OPENCODE_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  console.error('OPENCODE_API_KEY is not set');
  process.exitCode = 1;
} else {
  try {
    const routes: RoutedUnit[] = [{
      routed_unit_id: 'opencode-zen.deepseek-free.flash',
      adapter: OPENCODE_ZEN_ADAPTER,
      model: OPENCODE_ZEN_MODEL,
      destination: OPENCODE_ZEN_DESTINATION,
      tier: 'flash', operation: 'generate', kind: 'transform', quality: 'baseline',
      context_profile: 'implementation', context_profile_version: 1,
      prompt_template: 'implementation', prompt_template_version: 1,
      // Reasoning tokens share this output budget even for a one-word answer.
      settings: { max_output_tokens: 8192 },
      // A local bound for this example, not a provider capacity claim.
      context_limit_tokens: 1024,
      // Documented limited-time free tier: https://opencode.ai/docs/zen/
      price: { input_per_mtok: 0, output_per_mtok: 0 },
    }];
    const gateway = createInferenceGateway({
      routes, adapters: [opencodeZenAdapter({ apiKey })],
      clock: { now: () => Date.now() },
    });
    const result = await gateway.generate({
      request_id: 'example-opencode-zen', site: 'example.opencode-zen',
      role: 'working', kind: 'transform',
      input: { instructions: '', prompt: 'Reply with the single word: ok' },
      terms: {
        tier: 'flash', quality: 'baseline', destinations: [OPENCODE_ZEN_DESTINATION],
        max_context_tokens: 64, deadline: Date.now() + 60_000,
        cost_ceiling: 0, max_attempts: 1, max_attempts_per_route: 1,
      },
    });
    const last = result.attempts.at(-1);
    console.log(JSON.stringify({
      outcome: result.status,
      routed_unit: result.status === 'accepted' ? result.routed_unit_id : last?.routed_unit_id ?? null,
      model: last?.model ?? null,
      usage: last?.usage ?? null,
      attempts: result.attempts.map(attempt => ({
        routed_unit: attempt.routed_unit_id, model: attempt.model, usage: attempt.usage ?? null,
        outcome: attempt.disposition.status,
      })),
    }));
    if (result.status !== 'accepted') process.exitCode = 1;
  } catch {
    // Print no exceptions, provider response text, headers, or credentials.
    console.log(JSON.stringify({ outcome: 'failed', routed_unit: null, model: null, usage: null, attempts: [] }));
    process.exitCode = 1;
  }
}
