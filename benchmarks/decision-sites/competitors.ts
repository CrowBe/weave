/**
 * Competitors: generic CLI harnesses, whose prompt/data are sent only through
 * the injected process stdin, and the Muse Spark contributor model over HTTP.
 */
import { createInferenceGateway, type AttemptRecord, type InferenceGateway, type RoutedUnit } from '@weave/gateway';
import {
  museSparkAdapter, MUSE_SPARK_ADAPTER, MUSE_SPARK_DEFAULT_SETTINGS, MUSE_SPARK_DESTINATION,
  MUSE_SPARK_FALLBACK_MODEL, MUSE_SPARK_PRIMARY_MODEL,
} from '@weave/gateway/muse-spark';
import type { Answer, Provider, Request, Result } from './types.ts';
import { probability, record } from './providers.ts';
export interface ProcessOptions { cwd: string; stdin: string; signal: AbortSignal; }
export type ProcessRunner = (command: string, args: readonly string[], options: ProcessOptions) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export interface CompetitorsConfig {
  run: ProcessRunner;
  /** Composition root creates an empty temporary directory, outside every repository. */
  cwd: string;
  quotaAllowed: boolean;
  timeoutMs?: number;
  /** Reconstructed from completed/intended competitor calls in the live journal. */
  callCounts?: Record<string, number>;
}
export function quotaAllowsCompetitors(raw: unknown, now: number, maxAgeMs = 60_000): boolean {
  if (!record(raw) || typeof raw.generatedAt !== 'string' || !Array.isArray(raw.providers)) return false;
  const observed = Date.parse(raw.generatedAt);
  if (!Number.isFinite(observed) || observed > now || now - observed >= maxAgeMs) return false;
  const providers = raw.providers.filter((provider: unknown) => record(provider) && provider.provider === 'codex');
  if (providers.length !== 1 || !record(providers[0])) return false;
  const provider = providers[0];
  if (!record(provider.state) || provider.state.status !== 'fresh' || provider.state.stale !== false) return false;
  if (provider.state.reused === true) {
    const refreshed = typeof provider.state.refreshedAt === 'string' ? Date.parse(provider.state.refreshedAt) : NaN;
    if (!Number.isFinite(refreshed) || refreshed > observed || now - refreshed >= maxAgeMs) return false;
  }
  if (!Array.isArray(provider.windows)) return false;
  const weeks = provider.windows.filter((window: unknown) => record(window) && (window.kind === 'weekly' || window.id === 'seven_day' || window.id === 'weekly'));
  if (weeks.length === 0) return false;
  const ids = new Set<unknown>();
  let minimumRemaining = 100;
  for (const week of weeks) {
    if (!record(week) || ids.has(week.id)) return false;
    ids.add(week.id);
    const reset = typeof week.resetsAt === 'string' ? Date.parse(week.resetsAt) : NaN;
    if (!Number.isFinite(reset) || reset <= now) return false;
    const remaining = week.percentRemaining;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100) return false;
    minimumRemaining = Math.min(minimumRemaining, remaining);
  }
  return minimumRemaining > 20;
}
export function competitorPrompt(request: Request): string {
  return 'Answer the supplied production questions using only the supplied state. Do not use tools. Return only strict JSON: {"answers":{"<question id>":{"choice":"<option key>","confidence":0.0}}}. For boolean questions use "probability" instead of "choice"; for score questions use "score". Confidence must be your self-reported number between 0 and 1; omit it when unknown. No prose or Markdown.\n' + JSON.stringify(request);
}
export function buildCompetitors(config: CompetitorsConfig): Provider[] {
  return ['pi', 'fx-ask'].map(id => {
    let skipped: Result | undefined;
    let initialized = false;
    let count = config.callCounts?.[id] ?? 0;
    let argv: string[] = [];
    const command = id === 'pi' ? 'pi' : 'fx';
    return { id, model: 'chatgpt-sign-in', price: 0, competitor: true,
      serialize: competitorPrompt,
      async request(request, external): Promise<Result> {
        if (external.aborted) return { status: 'failed', reason: 'cancelled' };
        if (skipped) return skipped;
        if (!config.quotaAllowed) return { status: 'skipped', reason: 'quota_unavailable_or_weekly_cap' };
        if (count >= 40) return { status: 'skipped', reason: 'call_cap' };
        let dispatched = false;
        const signal = AbortSignal.any([external, AbortSignal.timeout(config.timeoutMs ?? 120_000)]);
        const run = async (args: readonly string[], stdin = '') => {
          signal.throwIfAborted();
          // Once the prompt is handed to the process runner, cancellation cannot
          // establish that no plan quota was consumed. Count it conservatively.
          if (stdin) { count++; dispatched = true; }
          const result = await config.run(command, args, { cwd: config.cwd, stdin, signal });
          signal.throwIfAborted();
          return result;
        };
        try {
          if (!initialized) {
            if (id === 'fx-ask') {
              const status = await run(['status']);
              const authLine = status.stdout.split(/\r?\n/).find(line => /^\s*auth(?:entication)?\s*:/i.test(line));
              if (status.exitCode !== 0 || !authLine || /(?:not\s+auth|unauth|missing|required|none|logged\s*out)/i.test(authLine) || !/(?:chatgpt|codex)/i.test(authLine)) return skipped = { status: 'skipped', reason: 'auth_required' };
              const help = await run(['ask', '--help']);
              // Never silently run a tool-enabled harness. Current fx versions without this
              // capability are reported, so the captain can install a compatible version.
              if (help.exitCode !== 0 || !help.stdout.includes('--no-tools')) return skipped = { status: 'skipped', reason: 'tools_cannot_be_disabled' };
              argv = ['ask', '--json', '--no-save', '--no-tools'];
            } else {
              const help = await run(['--help']);
              const required = ['--mode', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-context-files', '--offline'];
              if (help.exitCode !== 0 || required.some(flag => !help.stdout.includes(flag))) return skipped = { status: 'skipped', reason: 'unsupported_cli_flags' };
              argv = ['-p', '--mode', 'json', '--no-session', '--no-tools', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--offline', '--provider', 'openai-codex', '--model', 'gpt-6.1'];
            }
            initialized = true;
          }
          const result = await run(argv, competitorPrompt(request));
          const parsed = parseCompetitorOutput(result.stdout, request);
          // JSON streams can echo the supplied state. Only stderr can establish
          // an auth failure, and a successful parsed answer takes precedence.
          if ((result.exitCode !== 0 || !parsed) && /(?:authentication required|not authenticated|no api key|no (?:available )?models|please (?:log|sign) in|login required|not logged in)/i.test(result.stderr)) return skipped = { status: 'skipped', reason: 'auth_required' };
          if (result.exitCode !== 0) return { status: 'failed', reason: 'nonzero_exit' };
          return parsed ? { status: 'ok', model: 'chatgpt-sign-in', answers: parsed } : { status: 'failed', reason: 'non_json_output', parse_failure: true };
        } catch { return { status: 'failed', reason: external.aborted ? (dispatched ? 'cancelled_after_dispatch' : 'cancelled') : signal.aborted ? 'timeout' : 'process_unavailable' }; }
      },
    } satisfies Provider;
  });
}
/** The only content classes a training-allowed destination may receive. */
const TRAINING_ALLOWED_CLASSES: readonly string[] = ['public', 'non_sensitive'];
export interface MuseSparkCompetitorConfig {
  /** Injected from MODEL_API_KEY by the composition root; missing or blank skips the provider. */
  apiKey?: string | undefined;
  /**
   * The operator's classification of all benchmark content sent. Contributor
   * content may be used for training, so only public or non_sensitive is accepted.
   */
  contentClass: 'public' | 'non_sensitive';
  /** Clock for the gateway deadline; the composition root supplies it. */
  now: () => number;
  fetch?: typeof globalThis.fetch;
  baseURL?: string;
  timeoutMs?: number;
}
/**
 * Meta Muse Spark contributor as a holdout-only competitor. Its destination may
 * train on content, so this is the one benchmark route that goes through the
 * gateway: routing admits the training-allowed destination only for the declared
 * public/non_sensitive class and excludes credential-shaped content before any
 * dispatch. The 1.2 contributor model is the declared fallback unit, tried once
 * after a 1.3 failure other than a refused credential. The answering unit's
 * requested model is recorded; the provider's echoed model is not observed.
 * Every unit keeps the 1024-token output budget its default reasoning needs.
 */
export function museSparkCompetitor(config: MuseSparkCompetitorConfig): Provider {
  if (!TRAINING_ALLOWED_CLASSES.includes(config.contentClass)) throw new Error('Muse Spark requires --content-class public or non_sensitive');
  const timeoutMs = config.timeoutMs ?? 120_000;
  let skipped: Result | undefined;
  let gateway: InferenceGateway | undefined;
  // Both models share one credential: a refusal must not route the fallback.
  const availability: Record<string, 'available' | 'auth_required'> = { [MUSE_SPARK_ADAPTER]: 'available' };
  const routes: RoutedUnit[] = [MUSE_SPARK_PRIMARY_MODEL, MUSE_SPARK_FALLBACK_MODEL].map(model => ({
    routed_unit_id: `muse-spark.${model}`, operation: 'generate', kind: 'transform', adapter: MUSE_SPARK_ADAPTER, model,
    destination: MUSE_SPARK_DESTINATION, destination_training_allowed: true, quality: 'baseline',
    context_profile: 'decision-sites.competitor', context_profile_version: 1,
    prompt_template: 'decision-sites.competitor', prompt_template_version: 1,
    settings: MUSE_SPARK_DEFAULT_SETTINGS,
    // Benchmark-local bound, not a claimed provider context capacity.
    context_limit_tokens: 8192,
    // Official price unknown: flat zero placeholder, not a claim of free use.
    price: { input_per_mtok: 0, output_per_mtok: 0 },
  }));
  return { id: 'muse-spark', model: MUSE_SPARK_PRIMARY_MODEL, price: 0, competitor: true,
    serialize: competitorPrompt,
    async request(request, external): Promise<Result> {
      if (external.aborted) return { status: 'failed', reason: 'cancelled' };
      if (skipped) return skipped;
      if (!config.apiKey?.trim()) return { status: 'skipped', reason: 'no_credential' };
      if (!gateway) {
        let adapter: ReturnType<typeof museSparkAdapter>;
        // The adapter refuses a key that cannot be a Bearer header; never echo it.
        try { adapter = museSparkAdapter({ apiKey: config.apiKey, ...(config.fetch ? { fetch: config.fetch } : {}), ...(config.baseURL ? { baseURL: config.baseURL } : {}) }); }
        catch { return skipped = { status: 'skipped', reason: 'no_credential' }; }
        gateway = createInferenceGateway({ routes, availability, clock: { now: config.now }, adapters: [{ ...adapter, async execute(call) {
          const result = await adapter.execute(call);
          if (result.status === 'failed' && result.failure.code === 'unauthorized') availability[MUSE_SPARK_ADAPTER] = 'auth_required';
          return result;
        } }] });
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      let outcome: Awaited<ReturnType<InferenceGateway['generate']>>;
      try {
        outcome = await gateway.generate({ request_id: 'decision-sites.competitor', site: 'benchmark.decision-sites', role: 'working', kind: 'transform',
          input: { instructions: '', prompt: competitorPrompt(request) },
          terms: { quality: 'baseline', destinations: [MUSE_SPARK_DESTINATION], content_class: config.contentClass,
            max_context_tokens: 8000, deadline: config.now() + timeoutMs, cost_ceiling: 0, max_attempts: 2, max_attempts_per_route: 1 } },
        AbortSignal.any([external, timeout]));
      } catch {
        // Dispatch cannot be ruled out, so a cancellation here is never retried.
        return { status: 'failed', reason: external.aborted ? 'cancelled_after_dispatch' : timeout.aborted ? 'timeout' : 'gateway_error' };
      }
      const usage = attemptUsage(outcome.attempts);
      if (outcome.status === 'accepted') {
        const model = outcome.attempts.at(-1)?.model ?? MUSE_SPARK_PRIMARY_MODEL;
        const answers = parseCompetitorOutput(outcome.text, request);
        return answers ? { status: 'ok', model, answers, ...usage } : { status: 'failed', reason: 'non_json_output', parse_failure: true, model, ...usage };
      }
      if (external.aborted) return { status: 'failed', reason: outcome.attempts.length ? 'cancelled_after_dispatch' : 'cancelled' };
      if (timeout.aborted) return { status: 'failed', reason: 'timeout', ...usage };
      const failures = outcome.attempts.flatMap(attempt => attempt.disposition.status === 'failed' ? [attempt.disposition.failure] : []);
      if (failures.some(failure => failure.code === 'unauthorized')) return skipped = { status: 'skipped', reason: 'unauthorized' };
      // Routing refused before dispatch; the outcome's note names the reason without content.
      if (outcome.status === 'blocked') return { status: 'failed', reason: outcome.uncertainty.some(note => note.includes('(credential_content)')) ? 'credential_content' : `blocked_${outcome.reason}` };
      const last = failures.at(-1);
      // The adapter maps exactly HTTP 429 to rate_limited; the engine bounds its retries.
      if (last?.code === 'rate_limited') return { status: 'failed', reason: 'rate_limited', http_status: 429, ...(last.retry_after_ms === undefined ? {} : { retry_after_ms: last.retry_after_ms }), ...usage };
      return { status: 'failed', reason: last?.code ?? outcome.reason, ...usage };
    },
  };
}
/** Reported usage summed across the gateway's attempts; unreported usage stays absent. */
function attemptUsage(attempts: readonly AttemptRecord[]): { input_tokens?: number; output_tokens?: number } {
  const sum = (key: 'input_tokens' | 'output_tokens') => {
    const values = attempts.map(attempt => attempt.usage[key]).filter((value): value is number => Number.isSafeInteger(value) && value! >= 0);
    return values.length ? { [key]: values.reduce((a, b) => a + b, 0) } : {};
  };
  return { ...sum('input_tokens'), ...sum('output_tokens') };
}
export function parseCompetitorOutput(output: string, request: Request): Record<string, Answer> | undefined {
  let value: unknown;
  try { value = JSON.parse(output); } catch {
    // pi JSON mode emits a JSONL stream; its final assistant message is authoritative.
    const messages: unknown[] = [];
    try { for (const line of output.split(/\r?\n/).filter(line => line.trim())) messages.push(JSON.parse(line)); } catch { return undefined; }
    for (const entry of messages) if (record(entry) && entry.type === 'message_end' && record(entry.message) && entry.message.role === 'assistant') value = entry.message;
  }
  if (record(value) && typeof value.final_output === 'string') { try { value = JSON.parse(value.final_output); } catch { return undefined; } }
  else if (record(value) && typeof value.output === 'string') { try { value = JSON.parse(value.output); } catch { return undefined; } }
  if (record(value) && value.role === 'assistant' && Array.isArray(value.content)) {
    const text = value.content.filter(record).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
    try { value = JSON.parse(text); } catch { return undefined; }
  }
  if (!record(value) || !record(value.answers) || Object.keys(value.answers).length !== Object.keys(request.questions).length) return undefined;
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    const raw = value.answers[id];
    if (!record(raw) || (raw.confidence !== undefined && !probability(raw.confidence))) return undefined;
    const confidence = probability(raw.confidence) ? { confidence: raw.confidence } : {};
    if (q.type === 'boolean') { if (!probability(raw.probability)) return undefined; out[id] = { probability: raw.probability, ...confidence }; }
    else if (q.type === 'choice') { if (typeof raw.choice !== 'string' || !Object.hasOwn(q.criteria, raw.choice)) return undefined; out[id] = { choice: raw.choice, ...confidence }; }
    else { if (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > q.criteria.length - 1) return undefined; out[id] = { score: raw.score, ...confidence }; }
  }
  return out;
}
