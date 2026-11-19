import { existsSync, readFileSync } from 'node:fs';
import {
  applyRouteOverlay,
  bindDecisionProvider,
  createInferenceGateway,
  parseRouteConfig,
  resolveTypesafeApiKey,
  type EvaluationAdapter,
  type GenerationAdapter,
  type RoutedUnit,
} from '@weave/gateway';
import { typesafeAiEvaluator } from '@weave/gateway/typesafe-ai';
import { amosEvaluator } from '@weave/gateway/amos';
import { localTextAdapter } from '@weave/gateway/local-text';
import { liquidLocalEvaluator } from '@weave/gateway/liquid-local';
import { clairicExtractor } from './clairic.ts';
import { vercelAiGatewayAdapter } from '@weave/gateway/vercel-ai-gateway';
import { museSparkAdapter } from '@weave/gateway/muse-spark';
import { nousPortalAdapter } from '@weave/gateway/nous-portal';

export function localConfiguration(env: Readonly<Record<string, string | undefined>>, root: URL) {
  const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
  const primary = existsSync(new URL('weave.routes.json', root)) ? 'weave.routes.json' : 'weave.routes.example.json';
  let json = read(primary);
  if (existsSync(new URL('weave.routes.local.json', root)))
    json = applyRouteOverlay(json, read('weave.routes.local.json'));
  const parsed = parseRouteConfig(json);
  if (!parsed.ok) throw new Error(`Route configuration: ${parsed.errors.join('; ')}`);
  const decision = bindDecisionProvider(parsed.decision);
  const evaluators: EvaluationAdapter[] = [];
  const adapters: GenerationAdapter[] = [];
  const messages: string[] = [];
  const localDecision = env['LOOM_DECISION_BASE_URL'] && env['LOOM_DECISION_MODEL'];
  if (localDecision) evaluators.push(liquidLocalEvaluator({ baseURL: env['LOOM_DECISION_BASE_URL']! }));
  else if (decision.adapter === 'amos') evaluators.push(amosEvaluator({ baseURL: decision.baseURL }));
  else if (decision.adapter === 'typesafe-ai') {
    const keyEnv = parsed.decision.providers[decision.provider]?.key_env;
    const key = keyEnv === 'TYPESAFE_API_KEY' ? resolveTypesafeApiKey(env) : keyEnv ? env[keyEnv] : undefined;
    if (key) evaluators.push(typesafeAiEvaluator({ apiKey: key, baseURL: decision.baseURL }));
    else messages.push(`Set ${keyEnv ?? 'TYPESAFE_API_KEY'} for the decision provider.`);
  } else messages.push(`Decision provider ${decision.adapter} is not supported by this local experiment.`);
  if (env['AI_GATEWAY_API_KEY']) adapters.push(vercelAiGatewayAdapter({ apiKey: env['AI_GATEWAY_API_KEY'] }));
  if (env['MODEL_API_KEY']) adapters.push(museSparkAdapter({ apiKey: env['MODEL_API_KEY'] }));
  if (env['NOUS_PORTAL_API_KEY']) adapters.push(nousPortalAdapter({ apiKey: env['NOUS_PORTAL_API_KEY'] }));
  let routes: RoutedUnit[] = parsed.table.filter((unit) =>
    unit.operation === 'evaluate'
      ? unit.adapter === decision.adapter &&
        unit.model === decision.model &&
        evaluators.some((adapter) => adapter.id === unit.adapter)
      : adapters.some((adapter) => adapter.id === unit.adapter),
  );
  if (localDecision) {
    routes = routes.filter((unit) => unit.operation !== 'evaluate');
    for (const kind of ['choice', 'boolean', 'score'] as const)
      routes.push({
        routed_unit_id: `liquid-local.${kind}`,
        adapter: 'liquid-local',
        model: env['LOOM_DECISION_MODEL']!,
        operation: 'evaluate',
        kind,
        tier: 'decision',
        billing: 'local',
        destination: 'local',
        quality: 'baseline',
        context_profile: 'local.task',
        context_profile_version: 1,
        prompt_template: 'local.task',
        prompt_template_version: 1,
        settings: { max_output_tokens: 0 },
        context_limit_tokens: 4096,
        price: { input_per_mtok: 0, output_per_mtok: 0 },
      });
  }
  // The same text model serves two distinct inference kinds, with separate routed-unit identities.
  if (env['LOOM_LOCAL_MODEL'] && env['LOOM_LOCAL_BASE_URL']) {
    adapters.push(localTextAdapter({ baseURL: env['LOOM_LOCAL_BASE_URL'] }));
    routes = routes.filter((unit) => unit.operation !== 'generate' || unit.tier !== 'flash');
    routes.unshift({
      routed_unit_id: 'local-text.flash',
      adapter: 'local-text',
      model: env['LOOM_LOCAL_MODEL'],
      operation: 'generate',
      kind: 'transform',
      tier: 'flash',
      billing: 'local',
      destination: 'local',
      quality: 'baseline',
      context_profile: 'local.task',
      context_profile_version: 1,
      prompt_template: 'local.task',
      prompt_template_version: 1,
      settings: { max_output_tokens: 2048 },
      context_limit_tokens: 4096,
      price: { input_per_mtok: 0, output_per_mtok: 0 },
    });
    const localText = routes[0]!;
    routes.push({
      ...localText,
      operation: 'generate',
      routed_unit_id: 'local-text.extract',
      kind: 'extract',
      context_profile: 'local.extract',
      prompt_template: 'local.extract',
    });
  }
  // Sensitive content must not silently enter contributor/training routes.
  routes = routes.filter((unit) => unit.destination_training_allowed !== true);
  const flash = routes.filter(
    (unit) => unit.operation === 'generate' && unit.kind === 'extract' && unit.tier === 'flash',
  );
  if (env['LOOM_EXTRACTOR'] && env['LOOM_EXTRACTOR'] !== 'clairic') throw new Error('Unknown LOOM_EXTRACTOR.');
  const nativeExtract = env['LOOM_EXTRACTOR'] === 'clairic' ? clairicExtractor() : undefined;
  if (!flash.length && !nativeExtract)
    messages.push(
      'Configure a flash text route, or set LOOM_LOCAL_BASE_URL (including /v1) and LOOM_LOCAL_MODEL for extraction and split proposals.',
    );
  if (!routes.some((unit) => unit.operation === 'evaluate' && unit.kind === 'choice'))
    messages.push('No usable choice decision route is configured.');
  const strong = routes.some((unit) => unit.operation === 'generate' && unit.tier === 'strong');
  const gateway = createInferenceGateway({ routes, adapters, evaluators, clock: { now: () => Date.now() } });
  return {
    gateway,
    nativeExtract,
    status: {
      ready: messages.length === 0,
      messages,
      generation_available: strong,
      routes: [
        ...routes.map((unit) => ({
          id: unit.routed_unit_id,
          model: unit.model,
          tier: unit.tier,
          destination: unit.destination,
        })),
        ...(nativeExtract
          ? [
              {
                id: 'cloudflare.clairic',
                model: '@cf/cloudflare/clairic',
                tier: 'extraction',
                destination: 'cloudflare-workers-ai',
              },
            ]
          : []),
      ],
      scope: 'Submitted text only. One established operation: text.normalize.',
    },
    destinations: [
      ...new Set([...routes.map((unit) => unit.destination), ...(nativeExtract ? ['cloudflare-workers-ai'] : [])]),
    ],
  };
}
