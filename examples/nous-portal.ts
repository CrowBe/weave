/**
 * One public implementation-tier call on a Nous Portal free model. Credentials
 * enter only at this root, from NOUS_API_KEY, and are sent only as a Bearer
 * header. Nous may store and train on prompts and outputs: never classify
 * private repo work, operator/captain data, or sensitive content as
 * public/non_sensitive.
 *
 * npm run example:nous-portal
 */
import { createInferenceGateway, type RoutedUnit, type Timer } from '@weave/gateway';
import {
  nousPortalAdapter,
  NOUS_PORTAL_ADAPTER,
  NOUS_PORTAL_DESTINATION,
  NOUS_PORTAL_FREE_LIMITS,
  NOUS_PORTAL_FREE_MODELS,
} from '@weave/gateway/nous-portal';

const apiKey = process.env.NOUS_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  console.error('NOUS_API_KEY is not set');
  process.exitCode = 1;
} else {
  try {
    // Escalation order: the fast non-reasoning model, then a fallback unit.
    const routes: RoutedUnit[] = [
      ['nous-portal.flash.solar-mini4', NOUS_PORTAL_FREE_MODELS.solarMini],
      ['nous-portal.flash.longcat-2.0', NOUS_PORTAL_FREE_MODELS.longcat],
    ].map(([routed_unit_id, model]) => ({
      routed_unit_id: routed_unit_id!,
      adapter: NOUS_PORTAL_ADAPTER,
      model: model!,
      tier: 'flash',
      operation: 'generate',
      kind: 'transform',
      destination: NOUS_PORTAL_DESTINATION,
      destination_training_allowed: true,
      quality: 'baseline',
      context_profile: 'implementation',
      context_profile_version: 1,
      prompt_template: 'implementation',
      prompt_template_version: 1,
      settings: { max_output_tokens: 64 },
      // This example's local bound, not a claimed provider context capacity.
      context_limit_tokens: 1024,
      // Zero in the live catalogue on 17 Oct 2026; the adapter re-checks it.
      price: { input_per_mtok: 0, output_per_mtok: 0 },
      rate_limits: NOUS_PORTAL_FREE_LIMITS,
    }));
    const timer: Timer = {
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(handle);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const handle = setTimeout(done, ms);
          if (signal?.aborted) done();
          else signal?.addEventListener('abort', done, { once: true });
        }),
    };
    const gateway = createInferenceGateway({
      routes,
      adapters: [nousPortalAdapter({ apiKey })],
      clock: { now: () => Date.now() },
      timer,
    });
    const result = await gateway.generate({
      request_id: 'example-nous-portal',
      site: 'example.nous-portal',
      role: 'working',
      kind: 'transform',
      input: { instructions: '', prompt: 'Reply with the single word: ok' },
      terms: {
        tier: 'flash',
        quality: 'baseline',
        destinations: [NOUS_PORTAL_DESTINATION],
        content_class: 'public',
        max_context_tokens: 64,
        deadline: Date.now() + 15_000,
        cost_ceiling: 0,
        max_attempts: 2,
        max_attempts_per_route: 1,
      },
    });
    const last = result.attempts.at(-1);
    console.log(
      JSON.stringify({
        outcome: result.status,
        routed_unit: result.status === 'accepted' ? result.routed_unit_id : (last?.routed_unit_id ?? null),
        model: last?.model ?? null,
        usage: last?.usage ?? null,
        attempts: result.attempts.map((attempt) => ({
          routed_unit: attempt.routed_unit_id,
          model: attempt.model,
          usage: attempt.usage,
          outcome: attempt.disposition.status,
          cost: attempt.cost,
          ...(attempt.disposition.status === 'failed' ? { failure: attempt.disposition.failure.code } : {}),
        })),
        cost: result.spent,
      }),
    );
    if (result.status !== 'accepted') process.exitCode = 1;
  } catch {
    // Never print provider exceptions, headers, credentials, or response bodies.
    console.log(
      JSON.stringify({ outcome: 'failed', routed_unit: null, model: null, usage: null, attempts: [], cost: null }),
    );
    process.exitCode = 1;
  }
}
