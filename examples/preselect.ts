/**
 * One D3 preselect call through the configured decision provider.
 *
 * Loads `weave.routes.json` when it exists, otherwise `weave.routes.example.json`,
 * then overlays `weave.routes.local.json`. `--provider typesafe-jev|amos`
 * selects the provider for this run (default `typesafe-jev`). Amos is the
 * loopback adapter at the configured base URL (example: http://127.0.0.1:8766,
 * model amos-1-2b). The TypeSafe key comes from `resolveTypesafeApiKey` and is
 * sent only as a Bearer header by the adapter. It is never read from argv and
 * never printed.
 *
 *   npm run example:preselect
 *   npm run example:preselect -- --provider amos
 */
import { localBudgetGate } from './quota-local.ts';
import { existsSync, readFileSync } from 'node:fs';
import { evaluateBooleanSite } from '@weave/weave';
import {
  applyRouteOverlay,
  bindDecisionProvider,
  createInferenceGateway,
  parseRouteConfig,
  resolvePreselectPolicy,
  resolveTypesafeApiKey,
  type EvaluationAdapter,
} from '@weave/gateway';
import { amosEvaluator } from '@weave/gateway/amos';
import { typesafeAiEvaluator } from '@weave/gateway/typesafe-ai';

const STEP =
  'Keep the catalogue entries needed to narrow a disclosed index to the top few relevant capabilities, and always retain the grant check.';
const CATALOGUE = Object.freeze([
  Object.freeze({ id: 'cap.preselect', purpose: 'Keep the highest-scoring disclosed catalogue entries for this step' }),
  Object.freeze({
    id: 'cap.policy',
    purpose: 'Validate the preselect policy: top-k and an optional probability floor',
  }),
  Object.freeze({
    id: 'cap.intake',
    purpose: 'Classify an inbound message as a new thread, a continuation, or a stop',
  }),
  Object.freeze({ id: 'cap.grant', purpose: 'Refuse a destructive effect unless a grant already covers it' }),
  Object.freeze({ id: 'cap.theme', purpose: 'Paint workspace theme tokens for the operator surface' }),
  Object.freeze({ id: 'cap.fold', purpose: 'Fold a long observation into a retained summary' }),
  Object.freeze({ id: 'cap.quota', purpose: 'Read the weekly quota snapshot before a dispatch' }),
  Object.freeze({ id: 'cap.signin', purpose: 'Start a ChatGPT sign-in on a loopback port' }),
  Object.freeze({ id: 'cap.audit', purpose: 'Assemble tidy state for the audit tier' }),
  Object.freeze({ id: 'cap.holiday', purpose: 'Invent a description of a holiday and its traditions' }),
]);

function repoJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function providerFlag(): 'typesafe-jev' | 'amos' {
  const args = process.argv.slice(2);
  let provider: 'typesafe-jev' | 'amos' = 'typesafe-jev';
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--provider') {
      console.error('unsupported argument');
      process.exit(1);
    }
    const value = args[++i];
    if (value !== 'typesafe-jev' && value !== 'amos') {
      console.error('provider must be typesafe-jev or amos');
      process.exit(1);
    }
    provider = value;
  }
  return provider;
}
function loadDecision(provider: 'typesafe-jev' | 'amos') {
  const primary = existsSync(new URL('../weave.routes.json', import.meta.url))
    ? 'weave.routes.json'
    : 'weave.routes.example.json';
  let json = repoJson(primary);
  if (existsSync(new URL('../weave.routes.local.json', import.meta.url)))
    json = applyRouteOverlay(json, repoJson('weave.routes.local.json'));
  if (!record(json) || !record(json['decision'])) {
    console.error('invalid route config');
    process.exit(1);
  }
  const sites = record(json['decision']['sites']) ? json['decision']['sites'] : {};
  json['decision']['sites'] = { ...sites, 'loop.preselect': provider };
  const parsed = parseRouteConfig(json);
  if (!parsed.ok) {
    console.error(parsed.errors.join('\n'));
    process.exit(1);
  }
  return {
    binding: bindDecisionProvider(parsed.decision, 'loop.preselect'),
    table: parsed.table,
    decision: parsed.decision,
  };
}

try {
  const provider = providerFlag();
  const loaded = loadDecision(provider);
  const destination = loaded.table.find(
    (unit) =>
      unit.operation === 'evaluate' &&
      unit.kind === 'boolean' &&
      unit.adapter === loaded.binding.adapter &&
      unit.model === loaded.binding.model,
  )?.destination;
  if (destination === undefined) {
    console.error('no matching boolean evaluate unit');
    process.exit(1);
  }
  let evaluators: EvaluationAdapter[];
  if (provider === 'amos') evaluators = [amosEvaluator({ baseURL: loaded.binding.baseURL, timeoutMs: 120_000 })];
  else {
    const apiKey = resolveTypesafeApiKey(process.env);
    if (apiKey === undefined) {
      console.error(
        'Set TYPESAFE_API_KEY (preferred; TYPESAFE_AI_API_KEY is the legacy fallback) in .env.local and rerun.',
      );
      process.exit(1);
    }
    evaluators = [typesafeAiEvaluator({ apiKey, baseURL: loaded.binding.baseURL })];
  }
  const gateway = createInferenceGateway({
    ...localBudgetGate(),
    decision: loaded.decision,
    routes: loaded.table.filter((unit) => unit.operation === 'evaluate' && unit.adapter === loaded.binding.adapter),
    evaluators,
    clock: { now: () => Date.now() },
  });
  const policy = resolvePreselectPolicy(loaded.decision, loaded.binding.provider);
  const state = { state_revision: 1, state_updated_at: Date.now() };
  const result = await evaluateBooleanSite(
    'loop.preselect',
    {
      ...state,
      request_id: 'req_preselect_example',
      state: { note: 'disclosed index only' },
      needs_dispatch: false,
      terms: {
        quality: 'baseline',
        destinations: [destination],
        max_context_tokens: 4_000,
        deadline: Date.now() + 180_000,
        cost_ceiling: 1_000,
        max_attempts: 1,
      },
      preselect_step: STEP,
      catalogue_index: CATALOGUE,
      required_entry_ids: ['cap.grant'],
      preselect_policy: {
        k: policy.k,
        floor: policy.floor,
        max_excluded: policy.max_excluded,
        min_margin: policy.min_margin,
        provider: policy.provider,
      },
    },
    gateway,
    () => ({ ...state, observed_at: Date.now() }),
  );
  console.log(
    JSON.stringify({ preselect: result.preselect ?? null, kept: result.catalogue_index.map((entry) => entry.id) }),
  );
} catch {
  console.error('preselect example failed');
  process.exit(1);
}
