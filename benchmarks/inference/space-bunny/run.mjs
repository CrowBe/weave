/** Exploratory typed-judgment probe through the real Nous Portal adapter. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import {
  NOUS_PORTAL_FREE_MODELS,
  nousPortalAdapter,
} from '@weave/gateway/nous-portal';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const MODEL = NOUS_PORTAL_FREE_MODELS.spaceBunny;
const ENDPOINT = 'https://inference-api.nousresearch.com/v1';
const DATA = resolve(ROOT, '.local/gliner-decide/collected');
const OUTPUT = resolve(HERE, 'results.json');
const SITES = ['capability.match', 'result.evaluate'];
const MAX_OUTPUT_TOKENS = 1024;

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.group}.v${row.variant}`;
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[row.arm] = row;
  }
  const completeGroups = [...groups.values()].filter((g) => g.base && g.relevant && g.irrelevant);
  const successful = rows.filter((row) => row.status === 'completed');
  const labels = new Map();
  for (const row of rows) labels.set(row.expected, (labels.get(row.expected) ?? 0) + 1);
  return {
    n: rows.length,
    correct: rows.filter((row) => row.correct).length,
    completed: successful.length,
    format_failures: successful.filter((row) => row.predicted === null).length,
    provider_failures: rows.length - successful.length,
    majority_label_floor: Math.max(...labels.values()),
    independent_groups: new Set(rows.map((row) => row.group)).size,
    contrast_pairs: completeGroups.length,
    relevant_flips: completeGroups.filter((g) => g.base.predicted !== g.relevant.predicted).length,
    irrelevant_holds: completeGroups.filter((g) => g.base.predicted === g.irrelevant.predicted).length,
    false_matches: rows.filter((row) => row.expected === 'none' && row.predicted !== 'none').length,
    median_ms: median(rows.map((row) => row.latency_ms)),
    median_output_tokens: median(successful.map((row) => row.usage.output_tokens).filter(Number.isFinite)),
  };
}

function promptFor(caseRecord) {
  const classification = caseRecord.output.classifications[0];
  const options = Object.entries(classification.label_descriptions)
    .map(([label, description]) => `${label}: ${description}`).join('\n');
  return {
    labels: classification.labels,
    expected: classification.true_label[0],
    text: `${classification.prompt}\n\nOptions:\n${options}\n\nCase:\n${caseRecord.input}\n\nAnswer with exactly one option label and no explanation.`,
  };
}

async function loadSite(site) {
  const dir = resolve(DATA, site);
  const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'));
  const bytes = await readFile(resolve(dir, 'validation.jsonl'));
  if (hash(bytes) !== manifest.output_sha256.validation) throw new Error(`${site} validation digest changed`);
  const cases = bytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const index = (await readFile(resolve(dir, 'validation-index.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  if (cases.length !== index.length || cases.length !== 18) throw new Error(`${site} index mismatch`);
  return { manifest, cases, index };
}

async function checkFreeCatalogue(apiKey) {
  const response = await fetch(`${ENDPOINT}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`catalogue status ${response.status}`);
  const body = await response.json();
  const entry = body.data?.find((model) => model.id === MODEL);
  if (!entry || Number(entry.pricing?.prompt) !== 0 || Number(entry.pricing?.completion) !== 0) {
    throw new Error(`${MODEL} is not listed at zero input and output price`);
  }
  return {
    id: entry.id, pricing: entry.pricing,
    context_length: entry.context_length,
    supported_parameters: entry.supported_parameters,
  };
}

async function main() {
  const apiKey = process.env.NOUS_PORTAL_API_KEY;
  if (!apiKey) throw new Error('NOUS_PORTAL_API_KEY is required');
  const catalogue = await checkFreeCatalogue(apiKey);
  const adapter = nousPortalAdapter({ apiKey });
  const report = {
    status: 'exploratory, authored synthetic cases; not routing evidence',
    observed_at: new Date().toISOString(),
    adapter: adapter.id, model: MODEL, endpoint: ENDPOINT,
    settings: { max_output_tokens: MAX_OUTPUT_TOKENS, temperature: 0,
      reasoning_effort: 'provider default (not configurable through the gateway adapter)' },
    catalogue,
    sites: {},
  };
  for (const site of SITES) {
    const { manifest, cases, index } = await loadSite(site);
    const rows = [];
    for (let i = 0; i < cases.length; i++) {
      const meta = index[i];
      const task = promptFor(cases[i]);
      if (task.expected !== meta.wire_label) throw new Error(`${meta.id} label mismatch`);
      const started = performance.now();
      const result = await adapter.execute({
        model: MODEL,
        instructions: 'Make the semantic judgment from the case and option descriptions. Follow the output format exactly.',
        prompt: task.text,
        settings: { max_output_tokens: MAX_OUTPUT_TOKENS, temperature: 0 },
        signal: AbortSignal.timeout(120_000),
      });
      const latency = Math.round(performance.now() - started);
      const raw = result.status === 'completed' ? result.text : null;
      const predicted = raw === null ? null : task.labels.includes(raw.trim()) ? raw.trim() : null;
      const row = {
        id: meta.id, group: meta.group, variant: meta.variant, arm: meta.arm,
        expected: task.expected, predicted, correct: predicted === task.expected,
        status: result.status, raw, latency_ms: latency,
        usage: result.status === 'completed' ? result.usage : null,
        failure: result.status === 'failed' ? result.failure : null,
      };
      rows.push(row);
      report.sites[site] = {
        validation_sha256: manifest.output_sha256.validation,
        summary: summary(rows), rows,
      };
      await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ id: row.id, expected: row.expected, predicted, latency_ms: latency }));
      if (result.status !== 'completed') throw new Error(`${meta.id} failed: ${JSON.stringify(result.failure)}`);
    }
  }
  console.log(JSON.stringify(Object.fromEntries(SITES.map((site) => [site, report.sites[site].summary])), null, 2));
}

await main();
