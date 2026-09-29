/** Paired, quality-only probe: Nous Space Bunny and signed-in Codex GPT-6 Sol. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOUS_PORTAL_FREE_MODELS, nousPortalAdapter } from '@weave/gateway/nous-portal';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASE_NAME = process.env.BENCH_CASES ?? 'cases.json';
const CASES = resolve(HERE, CASE_NAME);
const OUTPUT = resolve(HERE, process.env.BENCH_OUTPUT ??
  (CASE_NAME === 'cases.json' ? 'results.json' : 'hard-results.json'));
const TEMP = '/tmp/weave-sol-llm-probe';
const CODEX = process.env.CODEX_BENCH_BIN ?? 'codex';
const BUNNY = NOUS_PORTAL_FREE_MODELS.spaceBunny;
const SOL = 'gpt-6-sol';
const ENDPOINT = 'https://inference-api.nousresearch.com/v1';

function batchesOf(cases) {
  // One item from each domain in each batch; identical batch for both models.
  const byCategory = Object.groupBy(cases, (item) => item.category);
  const categories = ['quantitative', 'logic', 'code', 'reading'];
  const n = byCategory[categories[0]]?.length;
  if (!n || categories.some((category) => byCategory[category]?.length !== n)) {
    throw new Error('expected balanced cases in four categories');
  }
  return Array.from({ length: n }, (_, i) => categories.map((category) => byCategory[category][i]));
}

function promptFor(batch) {
  return [
    'Text-only benchmark. Solve from the text below. Do not call tools, browse, or read files.',
    'Return one valid JSON object with exactly these case IDs as keys and short final answers as string values.',
    'Use only the requested answer format for each case. Do not explain your reasoning.',
    '',
    ...batch.map((item) => `${item.id}: ${item.prompt}`),
  ].join('\n');
}

async function checkFree(apiKey) {
  const response = await fetch(`${ENDPOINT}/models`, {
    headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Nous catalogue status ${response.status}`);
  const data = await response.json();
  const entry = data.data?.find((model) => model.id === BUNNY);
  if (!entry || Number(entry.pricing?.prompt) !== 0 || Number(entry.pricing?.completion) !== 0) {
    throw new Error(`${BUNNY} is not listed at zero input and output price`);
  }
  return { prompt: entry.pricing.prompt, completion: entry.pricing.completion };
}

function parseAnswers(raw, batch) {
  if (typeof raw !== 'string') return { answers: null, format_error: 'no text' };
  let text = raw.trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { answers: null, format_error: 'invalid JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { answers: null, format_error: 'expected JSON object' };
  }
  const ids = batch.map((item) => item.id);
  if (Object.keys(parsed).sort().join(',') !== [...ids].sort().join(',')) {
    return { answers: null, format_error: 'missing or extra case IDs' };
  }
  if (Object.values(parsed).some((answer) => typeof answer !== 'string')) {
    return { answers: null, format_error: 'non-string answer' };
  }
  return { answers: parsed, format_error: null };
}

function correct(answer, expected, id) {
  if (answer === null || answer === undefined) return false;
  const a = String(answer).trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (a === e) return true;
  if (/^-?\d+(?:\.\d+)?$/.test(a) && /^-?\d+(?:\.\d+)?$/.test(e)) {
    return Number(a) === Number(e);
  }
  if (id.startsWith('code.') && id !== 'code.default') {
    return a.replace(/\s+/g, '') === e.replace(/\s+/g, '');
  }
  return false;
}

function rowsFor(model, index, batch, raw, status, detail) {
  const parsed = parseAnswers(raw, batch);
  return batch.map((item) => {
    const answer = parsed.answers?.[item.id] ?? null;
    return { id: item.id, category: item.category, batch: index, model,
      expected: item.expected, answer, correct: correct(answer, item.expected, item.id),
      status, format_error: parsed.format_error, detail };
  });
}

function runCommand(binary, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { cwd: TEMP, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exit_code) => resolvePromise({ exit_code, stdout, stderr }));
  });
}

async function callSol(prompt, index, runId) {
  const path = resolve(TEMP, `sol-${runId}-batch-${index}.txt`);
  try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { exit_code, stdout, stderr } = await runCommand(CODEX, [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', 'read-only', '-C', TEMP, '-m', SOL,
    '-c', 'model_reasoning_effort=medium', '-o', path, prompt,
  ]);
  const events = stdout.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const toolEvents = events.filter((event) =>
    /tool|command_execution|file_change|mcp/i.test(JSON.stringify(event.type ?? '') + ' ' + JSON.stringify(event.item?.type ?? '')));
  let raw = null;
  try { raw = await readFile(path, 'utf8'); } catch { /* preserve failure */ }
  return { status: exit_code === 0 && toolEvents.length === 0 ? 'completed' : 'failed',
    raw, detail: { exit_code, tool_event_count: toolEvents.length,
      error_tail: exit_code === 0 ? null : stderr.slice(-1200) } };
}

async function callBunny(adapter, prompt) {
  const attempts = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await adapter.execute({ model: BUNNY, instructions: '', prompt,
      settings: { max_output_tokens: 8192, temperature: 0 },
      signal: AbortSignal.timeout(120_000) });
    if (result.status === 'completed') {
      return { status: 'completed', raw: result.text,
        detail: { usage: result.usage, finish_reason: result.finish_reason, attempts } };
    }
    attempts.push(result.failure);
    if (result.failure.code !== 'rate_limited' || attempt === 4) break;
    const match = result.failure.message.match(/"retry_after"\s*:\s*(\d+)/);
    const delay = result.failure.retry_after_ms ?? (match ? Number(match[1]) * 1000 : 20_000);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(60_000, delay + 1000)));
  }
  return { status: 'failed', raw: null, detail: { attempts } };
}

async function main() {
  const apiKey = process.env.NOUS_PORTAL_API_KEY;
  if (!apiKey) throw new Error('NOUS_PORTAL_API_KEY is required');
  const bytes = await readFile(CASES);
  const corpus = JSON.parse(bytes.toString('utf8'));
  if (!['space-bunny-vs-sol.v1', 'space-bunny-vs-sol.hard.v1'].includes(corpus.version) ||
      ![20, 40].includes(corpus.cases.length) ||
      new Set(corpus.cases.map((item) => item.id)).size !== corpus.cases.length) {
    throw new Error('invalid corpus');
  }
  const batches = batchesOf(corpus.cases);
  const pricing = await checkFree(apiKey);
  const adapter = nousPortalAdapter({ apiKey });
  const report = { status: 'exploratory quality-only comparison',
    observed_at: new Date().toISOString(),
    corpus_sha256: createHash('sha256').update(bytes).digest('hex'),
    models: [BUNNY, SOL],
    settings: { bunny: 'Nous adapter, temperature 0, max_output_tokens 8192',
      sol: 'Codex CLI 0.157.0, fresh ephemeral session, read-only, medium effort',
      tools: 'forbidden in prompt; Codex event log checked' },
    pricing: { [BUNNY]: pricing }, rows: [], calls: [] };
  try {
    const old = JSON.parse(await readFile(OUTPUT, 'utf8'));
    if (old.corpus_sha256 === report.corpus_sha256 &&
        JSON.stringify(old.models) === JSON.stringify(report.models) &&
        JSON.stringify(old.settings) === JSON.stringify(report.settings)) {
      report.rows = old.rows;
      report.calls = old.calls;
      report.observed_at = old.observed_at;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const prompt = promptFor(batch);
    for (const model of [BUNNY, SOL]) {
      if (report.calls.some((call) => call.batch === i && call.model === model)) continue;
      const result = model === BUNNY ? await callBunny(adapter, prompt) :
        await callSol(prompt, i, report.corpus_sha256.slice(0, 12));
      report.calls.push({ batch: i, model, raw: result.raw, status: result.status,
        detail: result.detail });
      report.rows.push(...rowsFor(model, i, batch, result.raw, result.status, result.detail));
      await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ batch: i, model, status: result.status,
        correct: report.rows.filter((row) => row.batch === i && row.model === model && row.correct).length,
        format_error: report.rows.find((row) => row.batch === i && row.model === model)?.format_error }));
    }
  }
  report.summary = Object.fromEntries([BUNNY, SOL].map((model) => {
    const rows = report.rows.filter((row) => row.model === model);
    return [model, { correct: rows.filter((row) => row.correct).length, n: rows.length,
      by_category: Object.fromEntries(['quantitative', 'logic', 'code', 'reading'].map((category) => {
        const subset = rows.filter((row) => row.category === category);
        return [category, { correct: subset.filter((row) => row.correct).length, n: subset.length }];
      })),
      failed_batches: report.calls.filter((call) => call.model === model && call.status !== 'completed').length,
      format_failed_batches: report.rows.filter((row) => row.model === model && row.format_error).length / 4 }];
  }));
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

await main();
