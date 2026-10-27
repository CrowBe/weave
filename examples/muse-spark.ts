/**
 * One public implementation-tier call. Credentials enter only at this root.
 * Contributor content may be used for training: never classify private repo
 * work, operator/captain data, or sensitive content as public/non_sensitive.
 *
 * npm run example:muse-spark
 */
import { createInferenceGateway, type RoutedUnit, type Timer } from '@weave/gateway';
import {
  museSparkAdapter,
  MUSE_SPARK_ADAPTER,
  MUSE_SPARK_DESTINATION,
  MUSE_SPARK_PRIMARY_MODEL,
  MUSE_SPARK_FALLBACK_MODEL,
  MUSE_SPARK_DOCUMENTED_CONTRIBUTOR_LIMITS,
  MUSE_SPARK_DEFAULT_SETTINGS,
} from '@weave/gateway/muse-spark';

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  console.error('MODEL_API_KEY is not set');
  process.exitCode = 1;
} else {
  try {
    const routes: RoutedUnit[] = [MUSE_SPARK_PRIMARY_MODEL, MUSE_SPARK_FALLBACK_MODEL].map((model) => ({
      routed_unit_id: `muse-spark.flash.${model}`,
      adapter: MUSE_SPARK_ADAPTER,
      model,
      tier: 'flash',
      operation: 'generate',
      kind: 'transform',
      destination: MUSE_SPARK_DESTINATION,
      billing: 'metered',
      destination_training_allowed: true,
      quality: 'baseline',
      context_profile: 'implementation',
      context_profile_version: 1,
      prompt_template: 'implementation',
      prompt_template_version: 1,
      settings: MUSE_SPARK_DEFAULT_SETTINGS,
      // This example's local bound, not a claimed provider context capacity.
      context_limit_tokens: 1024,
      // Official price unknown: flat zero placeholder, not a claim of free use.
      price: { input_per_mtok: 0, output_per_mtok: 0 },
      rate_limits: MUSE_SPARK_DOCUMENTED_CONTRIBUTOR_LIMITS,
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
    const adapter = museSparkAdapter({ apiKey });
    const availability: Record<string, 'available' | 'auth_required'> = { [adapter.id]: 'available' };
    const gateway = createInferenceGateway({
      routes,
      availability,
      adapters: [
        {
          ...adapter,
          async execute(call) {
            const result = await adapter.execute(call);
            // Both models use this one credential. A refusal excludes the adapter
            // before routing the fallback; a different model cannot repair sign-in.
            if (result.status === 'failed' && result.failure.code === 'unauthorized') {
              availability[adapter.id] = 'auth_required';
            }
            return result;
          },
        },
      ],
      clock: { now: () => Date.now() },
      timer,
    });
    const result = await gateway.generate({
      request_id: 'example-muse-spark',
      site: 'example.muse-spark',
      role: 'working',
      kind: 'transform',
      input: { instructions: '', prompt: 'Reply with the single word: ok' },
      terms: {
        tier: 'flash',
        quality: 'baseline',
        destinations: [MUSE_SPARK_DESTINATION],
        content_class: 'non_sensitive',
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
          ...(attempt.disposition.status === 'failed' ? { failure: attempt.disposition.failure.code } : {}),
        })),
      }),
    );
    if (result.status !== 'accepted') process.exitCode = 1;
  } catch {
    // Never print provider exceptions, headers, credentials, or response bodies.
    console.log(JSON.stringify({ outcome: 'failed', routed_unit: null, model: null, usage: null, attempts: [] }));
    process.exitCode = 1;
  }
}
