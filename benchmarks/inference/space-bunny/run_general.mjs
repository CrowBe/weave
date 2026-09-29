/** Self-contained general-reasoning probe of two explicitly free Nous models. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOUS_PORTAL_FREE_MODELS, nousPortalAdapter } from '@weave/gateway/nous-portal';

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUT = resolve(HERE, 'general-cases.json');
const OUTPUT = resolve(HERE, 'general-results.json');
const ENDPOINT = 'https://inference-api.nousresearch.com/v1';
const MODELS = [NOUS_PORTAL_FREE_MODELS.spaceBunny, NOUS_PORTAL_FREE_MODELS.stepFlash];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(rows) {
  const categories = [...new Set(rows.map((row) => row.category))];
  const complete = rows.filter((row) => row.status === 'completed');
  return {
    n: rows.length, correct: rows.filter((row) => row.correct).length,
    provider_failures: rows.length - complete.length,
    format_failures: complete.filter((row) => row.predicted === null).length,
    median_ms: median(rows.map((row) => row.latency_ms)),
    p95_ms: [...rows.map((row) => row.latency_ms)].sort((a, b) => a - b)[Math.floor(0.95 * (rows.length - 1))],
    input_tokens: complete.reduce((sum, row) => sum + (row.usage?.input_tokens ?? 0), 0),
    output_tokens: complete.reduce((sum, row) => sum + (row.usage?.output_tokens ?? 0), 0),
    categories: Object.fromEntries(categories.map((category) => {
      const items = rows.filter((row) => row.category === category);
      return [category, { n: items.length, correct: items.filter((row) => row.correct).length }];
    })),
  };
}

async function checkFree(apiKey) {
  const response = await fetch(`${ENDPOINT}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`catalogue status ${response.status}`);
  const data = await response.json();
  return Object.fromEntries(MODELS.map((id) => {
    const entry = data.data?.find((model) => model.id === id);
    if (!entry || Number(entry.pricing?.prompt) !== 0 || Number(entry.pricing?.completion) !== 0) {
      throw new Error(`${id} is not listed at zero input and output price`);
    }
    return [id, { prompt: entry.pricing.prompt, completion: entry.pricing.completion }];
  }));
}

function validate(corpus) {
  if (corpus.version !== 'general-reasoning.v1' || corpus.cases.length !== 20) {
    throw new Error('unexpected corpus version or count');
  }
  const ids = new Set();
  const answerCounts = { A: 0, B: 0, C: 0, D: 0 };
  const categories = new Map();
  for (const item of corpus.cases) {
    if (ids.has(item.id) || !item.question || !item.reason) throw new Error(`invalid case ${item.id}`);
    ids.add(item.id);
    if (Object.keys(item.choices).join(',') !== 'A,B,C,D' || !item.choices[item.answer]) {
      throw new Error(`invalid choices ${item.id}`);
    }
    answerCounts[item.answer]++;
    categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
  }
  if (Object.values(answerCounts).some((count) => count !== 5) ||
      [...categories.values()].some((count) => count !== 5) || categories.size !== 4) {
    throw new Error('case answer positions or categories are unbalanced');
  }
}

function promptFor(item) {
  return `${item.question}\n\n${Object.entries(item.choices).map(([label, text]) => `${label}. ${text}`).join('\n')}\n\nAnswer with only A, B, C, or D.`;
}

async function main() {
  const apiKey = process.env.NOUS_PORTAL_API_KEY;
  if (!apiKey) throw new Error('NOUS_PORTAL_API_KEY is required');
  const bytes = await readFile(INPUT);
  const corpus = JSON.parse(bytes.toString('utf8'));
  validate(corpus);
  const pricing = await checkFree(apiKey);
  const adapter = nousPortalAdapter({ apiKey });
  const report = {
    status: 'exploratory authored general-reasoning probe; not a model ranking',
    observed_at: new Date().toISOString(),
    corpus_sha256: createHash('sha256').update(bytes).digest('hex'),
    models: MODELS, pricing,
    settings: { temperature: 0, max_output_tokens: 1024,
      reasoning_effort: 'provider default (not configurable through gateway adapter)' },
    rows: [],
  };
  // Preserve completed observations when a free endpoint fails mid-run.
  try {
    const previous = JSON.parse(await readFile(OUTPUT, 'utf8'));
    if (previous.corpus_sha256 === report.corpus_sha256 &&
        JSON.stringify(previous.models) === JSON.stringify(MODELS) &&
        JSON.stringify(previous.settings) === JSON.stringify(report.settings)) {
      report.rows = previous.rows;
      report.observed_at = previous.observed_at;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const item of corpus.cases) {
    for (const model of MODELS) {
      if (report.rows.some((row) => row.id === item.id && row.model === model)) continue;
      const started = performance.now();
      const result = await adapter.execute({ model,
        instructions: 'Solve the question carefully. Return only the chosen option letter.',
        prompt: promptFor(item),
        settings: { max_output_tokens: 1024, temperature: 0 },
        signal: AbortSignal.timeout(120_000) });
      const raw = result.status === 'completed' ? result.text : null;
      const match = raw?.trim().match(/^([ABCD])[.)]?$/i);
      const predicted = match ? match[1].toUpperCase() : null;
      const row = { id: item.id, category: item.category, model,
        expected: item.answer, predicted, correct: predicted === item.answer,
        status: result.status, raw,
        latency_ms: Math.round(performance.now() - started),
        usage: result.status === 'completed' ? result.usage : null,
        failure: result.status === 'failed' ? result.failure : null };
      report.rows.push(row);
      await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ id: row.id, model, expected: row.expected,
        predicted, latency_ms: row.latency_ms }));
    }
  }
  report.summary = Object.fromEntries(MODELS.map((model) =>
    [model, summarize(report.rows.filter((row) => row.model === model))]));
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

await main();
