/**
 * Public promotional inference, using the existing native AI SDK gateway path.
 * npm run example:vercel-free
 * All models may train on content: never classify private repo/operator work as public.
 */
import { createInferenceGateway, type RoutedUnit, type Timer } from '@weave/gateway';
import {
  vercelAiGatewayFreeAdapter,
  VERCEL_AI_GATEWAY_FREE_ADAPTER,
  VERCEL_AI_GATEWAY_FREE_DESTINATION,
  VERCEL_AI_GATEWAY_FREE_MODELS,
} from '@weave/gateway/vercel-ai-gateway';

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  console.error('AI_GATEWAY_API_KEY is not set');
  process.exitCode = 1;
} else {
  try {
    const routes: RoutedUnit[] = Object.values(VERCEL_AI_GATEWAY_FREE_MODELS).map((model) => ({
      routed_unit_id: `vercel-free.${model}`,
      adapter: VERCEL_AI_GATEWAY_FREE_ADAPTER,
      model,
      operation: 'generate',
      kind: 'transform',
      tier: 'flash',
      quality: 'baseline',
      context_profile: 'example',
      context_profile_version: 1,
      prompt_template: 'example',
      prompt_template_version: 1,
      destination: VERCEL_AI_GATEWAY_FREE_DESTINATION,
      destination_training_allowed: true,
      settings: { max_output_tokens: 1024 },
      context_limit_tokens: 1024,
      price: { input_per_mtok: 0, output_per_mtok: 0 },
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
      clock: { now: () => Date.now() },
      timer,
      adapters: [
        vercelAiGatewayFreeAdapter({
          apiKey,
          now: () => Date.now(),
          // Key-free catalogue fetch at the composition root, refreshed per attempt.
          catalogue: async (signal: AbortSignal | undefined) => {
            const response = await fetch('https://ai-gateway.vercel.sh/v1/models', {
              ...(signal === undefined ? {} : { signal }),
            });
            if (!response.ok) throw new Error('catalogue unavailable');
            return response.json();
          },
        }),
      ],
    });
    const result = await gateway.generate({
      request_id: 'example-vercel-free',
      site: 'example.free',
      role: 'working',
      kind: 'transform',
      input: { instructions: '', prompt: 'Reply with the single word: ok' },
      terms: {
        tier: 'flash',
        quality: 'baseline',
        content_class: 'public',
        destinations: [VERCEL_AI_GATEWAY_FREE_DESTINATION],
        max_context_tokens: 64,
        deadline: Date.now() + 30_000,
        cost_ceiling: 0,
        max_attempts: routes.length,
        max_attempts_per_route: 1,
      },
    });
    // Print accounted routing/usage only; no provider messages, headers or content.
    console.log(
      JSON.stringify({
        outcome: result.status,
        attempts: result.attempts.map((attempt) => ({
          model: attempt.model,
          usage: attempt.usage,
          outcome: attempt.disposition.status,
          ...(attempt.disposition.status === 'failed' ? { failure: attempt.disposition.failure.code } : {}),
        })),
      }),
    );
    if (result.status !== 'accepted') process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ outcome: 'failed', attempts: [] }));
    process.exitCode = 1;
  }
}
