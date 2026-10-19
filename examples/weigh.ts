/**
 * Weighing candidates with Jev, through the inference gateway.
 *
 * Direct TypeSafe, the configured decision provider, is the default route and
 * is tried first. Setting AI_GATEWAY_API_KEY adds an optional Vercel AI Gateway
 * route after it, so a throttled or unavailable direct route escalates there.
 * With only one key, that route is used alone. The attempt list shows which
 * route answered.
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
 * The direct route's base URL, model and destination come from the route table
 * (`weave.routes.json` when present, otherwise `weave.routes.example.json`, with
 * `weave.routes.local.json` overlaid): the provider's `base_url` and `model`,
 * and the `destination` of its evaluate unit for each answer shape. The
 * credential is read from the environment variable the provider's `key_env`
 * names, never from the file and never from argv. The default `TYPESAFE_API_KEY`
 * also accepts the legacy `TYPESAFE_AI_API_KEY`.
 *
 *   npm run example:weigh
 */
import { localBudgetGate } from './quota-local.ts';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyRouteOverlay,
  bindDecisionProvider,
  createInferenceGateway,
  parseRouteConfig,
  resolveTypesafeApiKey,
  type AttemptRecord,
  type DataDestination,
  type EvaluationAdapter,
  type EvaluationKind,
  type RoutedUnit,
} from '@weave/gateway';
import {
  VERCEL_AI_GATEWAY_ADAPTER,
  VERCEL_AI_GATEWAY_DESTINATION,
  vercelAiGatewayEvaluator,
} from '@weave/gateway/vercel-ai-gateway';
import { typesafeAiEvaluator } from '@weave/gateway/typesafe-ai';

/** The key name whose legacy spelling `resolveTypesafeApiKey` also accepts. */
const TYPESAFE_KEY_ENV = 'TYPESAFE_API_KEY';

const KINDS = ['score', 'boolean'] as const satisfies readonly EvaluationKind[];

export type WeighComposition =
  | {
      readonly ok: true;
      /** Per answer shape, direct first, then the optional Vercel route. */
      readonly routes: RoutedUnit[];
      readonly evaluators: EvaluationAdapter[];
      /** Exactly the destinations of the configured routes. */
      readonly destinations: DataDestination[];
    }
  | { readonly ok: false; readonly error: string };

/** The credential `key_env` names. Only the default name keeps its legacy fallback. */
function directKey(keyEnv: string | undefined, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (keyEnv === undefined) return undefined;
  return keyEnv === TYPESAFE_KEY_ENV ? resolveTypesafeApiKey(env) : env[keyEnv]?.trim() || undefined;
}

/**
 * Pure composition from a parsed route document and an environment. Neither is
 * read here, and no credential is returned or logged.
 */
export function composeWeigh(json: unknown, env: Readonly<Record<string, string | undefined>>): WeighComposition {
  const parsed = parseRouteConfig(json);
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('\n') };
  const decision = bindDecisionProvider(parsed.decision);
  const keyEnv = parsed.decision.providers[decision.provider]?.key_env;
  const typesafeKey = directKey(keyEnv, env);
  const gatewayKey = env['AI_GATEWAY_API_KEY']?.trim() || undefined;
  if (typesafeKey === undefined && gatewayKey === undefined) {
    return {
      ok: false,
      error:
        keyEnv === undefined
          ? `decision provider ${decision.provider} declares no key_env; set AI_GATEWAY_API_KEY in .env.local (git-ignored) and rerun.`
          : `Set ${keyEnv}${keyEnv === TYPESAFE_KEY_ENV ? ' (preferred; TYPESAFE_AI_API_KEY is the legacy fallback)' : ''} or AI_GATEWAY_API_KEY in .env.local (git-ignored) and rerun.`,
    };
  }

  const routes: RoutedUnit[] = [];
  for (const kind of KINDS) {
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

    // The composition root decides whether the direct route exists at all.
    if (typesafeKey !== undefined) {
      // The configured unit says which boundary this provider's content crosses.
      const unit = parsed.table.find(
        (u) =>
          u.operation === 'evaluate' && u.kind === kind && u.adapter === decision.adapter && u.model === decision.model,
      );
      if (unit === undefined) {
        return {
          ok: false,
          error: `no ${kind} evaluate unit for ${decision.adapter} model ${decision.model} in the route table`,
        };
      }
      routes.push({
        ...shared,
        routed_unit_id: `${kind}.candidate@typesafe`,
        adapter: decision.adapter,
        // The direct API names the model differently than the gateway catalogue.
        model: decision.model,
        destination: unit.destination,
      });
    }
    if (gatewayKey !== undefined) {
      routes.push({
        ...shared,
        routed_unit_id: `${kind}.candidate@vercel`,
        adapter: VERCEL_AI_GATEWAY_ADAPTER,
        model: 'typesafe-ai/jev',
        destination: VERCEL_AI_GATEWAY_DESTINATION,
      });
    }
  }

  return {
    ok: true,
    routes,
    evaluators: [
      ...(typesafeKey === undefined ? [] : [typesafeAiEvaluator({ apiKey: typesafeKey, baseURL: decision.baseURL })]),
      ...(gatewayKey === undefined ? [] : [vercelAiGatewayEvaluator({ apiKey: gatewayKey })]),
    ],
    // Permit only configured destinations; naming both permits the escalation.
    destinations: [...new Set(routes.map((unit) => unit.destination))],
  };
}

function repoJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

function loadRoutes(): unknown {
  const primary = existsSync(new URL('../weave.routes.json', import.meta.url))
    ? 'weave.routes.json'
    : 'weave.routes.example.json';
  const json = repoJson(primary);
  return existsSync(new URL('../weave.routes.local.json', import.meta.url))
    ? applyRouteOverlay(json, repoJson('weave.routes.local.json'))
    : json;
}

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

async function main(): Promise<void> {
  const composed = composeWeigh(loadRoutes(), process.env);
  if (!composed.ok) {
    console.error(composed.error);
    process.exit(1);
  }

  const gateway = createInferenceGateway({
    ...localBudgetGate(),
    routes: composed.routes,
    evaluators: composed.evaluators,
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
    destinations: composed.destinations,
    max_context_tokens: 4_000,
    deadline: Date.now() + 60_000,
    // Worst case is 168 micros an attempt at this context size.
    cost_ceiling: 1_000,
    max_attempts: 2,
  } as const;

  // --- How far does each candidate advance the goal? -------------------------

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

  // --- Is any of them blocked by the replay guarantee? -----------------------

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

  // --- What the two requests cost --------------------------------------------

  const spent = weights.spent + risks.spent;
  console.log(`\n${spent.toFixed(1)} micros spent across two separately routed requests:`);
  console.log(`  score   (${weights.routed_unit_id})`);
  console.log(weights.attempts.map(describe).join('\n'));
  console.log(`  boolean (${risks.routed_unit_id})`);
  console.log(risks.attempts.map(describe).join('\n'));

  const uncertainty = [...weights.uncertainty, ...risks.uncertainty];
  if (uncertainty.length > 0) console.log(`uncertainty: ${uncertainty.join('; ')}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
