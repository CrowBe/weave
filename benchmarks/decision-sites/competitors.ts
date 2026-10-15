/** Generic CLI competitors. Prompt/data are sent only through the injected process stdin. */
import type { Answer, Provider, Request, Result } from './types.ts';
import { probability, record } from './providers.ts';
export interface ProcessOptions { cwd: string; stdin: string; signal: AbortSignal; }
export type ProcessRunner = (command: string, args: readonly string[], options: ProcessOptions) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export interface CompetitorsConfig {
  run: ProcessRunner;
  /** Composition root creates an empty temporary directory, outside every repository. */
  cwd: string;
  quotaAllowed: boolean;
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
    return { id, model: 'chatgpt-sign-in', price: 0, concurrency: 1, competitor: true,
      serialize: competitorPrompt,
      async request(request, signal): Promise<Result> {
        if (signal.aborted) return { status: 'failed', reason: 'cancelled' };
        if (skipped) return skipped;
        if (!config.quotaAllowed) return { status: 'skipped', reason: 'quota_unavailable_or_weekly_cap' };
        if (count >= 40) return { status: 'skipped', reason: 'call_cap' };
        const run = (args: readonly string[], stdin = '') => config.run(command, args, { cwd: config.cwd, stdin, signal });
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
          count++;
          const result = await run(argv, competitorPrompt(request));
          if (signal.aborted) return { status: 'failed', reason: 'cancelled' };
          if (/(?:authentication required|not authenticated|no api key|no (?:available )?models|please (?:log|sign) in|login required|not logged in)/i.test(result.stderr + '\n' + result.stdout)) return skipped = { status: 'skipped', reason: 'auth_required' };
          if (result.exitCode !== 0) return { status: 'failed', reason: 'nonzero_exit' };
          const parsed = parseCompetitorOutput(result.stdout, request);
          return parsed ? { status: 'ok', model: 'chatgpt-sign-in', answers: parsed } : { status: 'failed', reason: 'non_json_output', parse_failure: true };
        } catch { return { status: 'failed', reason: signal.aborted ? 'cancelled' : 'process_unavailable' }; }
      },
    } satisfies Provider;
  });
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
