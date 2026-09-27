/** Bounded hosted Jev probe over a deterministic, Kev-paired BEV subset. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { Clock, EvaluationKind, EvaluationQuestion } from '@weave/gateway';
import { createJevGateway, probeTerms, readCredentials } from '../jev/run.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SAMPLE = `${ROOT}.local/bev-decision-150k/f83fe8b97094112fa305bfc793be07c8f8742282/sample-v1`;
const KEV_RESULTS = new URL('./kev-results.json', import.meta.url);
const DEFAULT_OUTPUT = new URL('./jev-results.json', import.meta.url);
const CELL_KEYS = [
  'Support and intent routing / choice',
  'Tool and workflow decisions / choice',
  'Reading comprehension / noul',
  'Tool and workflow decisions / noul',
  'Retail, product, and shopping / score',
  'Sentiment, emotion, and moderation / score',
] as const;

type Case = {
  id: string; row_index: number; domain: string; type: 'choice' | 'noul' | 'score';
  question_key: string; state: unknown;
  question: { type: string; instructions: string; criteria: Record<string, unknown> | readonly string[] };
};
type Label = string | number | boolean;
type KevRow = { id: string; domain: string; type: string; label: Label; status: string; result?: {
  correct: boolean; predicted?: unknown; rounded_correct?: boolean; rounded_level?: number; expected_level?: number;
}; };

export function selectPaired(cases: readonly Case[], kevRows: readonly KevRow[]): Case[] {
  const kev = new Map(kevRows.filter((r) => r.status === 'accepted' && r.result !== undefined).map((r) => [r.id, r]));
  if (kev.size !== kevRows.length) throw new Error('duplicate IDs in Kev results');
  const selected: Case[] = [];
  for (const cell of CELL_KEYS) {
    const candidates = cases.filter((c) => {
      const paired = kev.get(c.id);
      return `${c.domain} / ${c.type}` === cell && paired?.domain === c.domain && paired.type === c.type;
    });
    if (candidates.length < (cell === 'Reading comprehension / noul' || cell === 'Retail, product, and shopping / score' ? 3 : 2)) throw new Error(`not enough Kev-paired cases in ${cell}`);
    const pair = cell === 'Reading comprehension / noul' || cell === 'Retail, product, and shopping / score'
      ? [candidates[0]!, candidates[2]!]
      : candidates.slice(0, 2);
    selected.push(...pair);
  }
  if (selected.length !== 12 || new Set(selected.map((c) => c.id)).size !== 12) throw new Error('selection is not 12 unique paired cases');
  return selected;
}

export function gatewayQuestion(c: Case): { kind: EvaluationKind; question: EvaluationQuestion } {
  const { instructions, criteria } = c.question;
  if (c.type === 'choice') return { kind: 'choice', question: { type: 'choice', instructions, criteria: criteria as Record<string, never> } };
  if (c.type === 'noul') return { kind: 'boolean', question: { type: 'boolean', instructions,
    criteria: criteria as { true?: string; false?: string } } };
  return { kind: 'score', question: { type: 'score', instructions, criteria: criteria as readonly string[] } };
}

export function modelRequest(c: Case): { state: unknown; questions: Record<string, EvaluationQuestion> } {
  const { question } = gatewayQuestion(c);
  return { state: c.state, questions: { [c.question_key]: question } };
}

export function scoreAnswer(c: Case, label: Label, raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') throw new Error(`${c.id}: answer is not an object`);
  const answer = raw as Record<string, unknown>;
  if (c.type === 'choice') {
    if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(c.question.criteria, answer.choice)) throw new Error(`${c.id}: invalid choice answer`);
    return { predicted: answer.choice, correct: answer.choice === label };
  }
  if (c.type === 'noul') {
    if (answer.type !== 'boolean' || typeof answer.probability !== 'number' || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) throw new Error(`${c.id}: invalid boolean answer`);
    const predicted = answer.probability >= 0.5;
    return { predicted, probability_true: answer.probability, correct: predicted === label };
  }
  if (answer.type !== 'score' || typeof answer.score !== 'number' || !Number.isFinite(answer.score)) throw new Error(`${c.id}: invalid score answer`);
  const max = (c.question.criteria as readonly string[]).length - 1;
  if (answer.score < 0 || answer.score > max || typeof label !== 'number') throw new Error(`${c.id}: score outside valid range`);
  // Scores are nonnegative, so floor(x + 0.5) is round-half-up.
  const predicted = Math.floor(answer.score + 0.5);
  return { expected_score: answer.score, predicted, correct: predicted === label, absolute_error: Math.abs(answer.score - label) };
}

async function main(): Promise<void> {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
  const casesPath = arg('cases') ?? `${SAMPLE}/cases.json`;
  const kevPath = arg('kev') ?? new URL('./kev-results.json', import.meta.url).pathname;
  const outPath = arg('output') ?? DEFAULT_OUTPUT.pathname;
  const caseDoc = JSON.parse(await readFile(casesPath, 'utf8')) as { dataset: unknown; cases: Case[] };
  const labelsPath = `${dirname(casesPath)}/labels.json`;
  const kevDoc = JSON.parse(await readFile(kevPath, 'utf8')) as { status: string; records: KevRow[] };
  const labelsDoc = JSON.parse(await readFile(labelsPath, 'utf8')) as { dataset_revision: string; labels: { id: string; label: Label }[] };
  if (kevDoc.status !== 'complete') throw new Error(`Kev result status is ${kevDoc.status}, expected complete`);
  const caseLabels = new Map(labelsDoc.labels.map((r) => [r.id, r.label]));
  if (caseLabels.size !== labelsDoc.labels.length || labelsDoc.dataset_revision !== (caseDoc.dataset as { revision?: string }).revision || caseLabels.size !== caseDoc.cases.length) throw new Error('sample label manifest is duplicated, incomplete, or has a different dataset revision');
  const selected = selectPaired(caseDoc.cases, kevDoc.records);
  const kevById = new Map(kevDoc.records.map((r) => [r.id, r]));
  for (const c of selected) {
    if (!caseLabels.has(c.id) || caseLabels.get(c.id) !== kevById.get(c.id)?.label) throw new Error(`${c.id}: sample and Kev labels do not match`);
  }
  const credentials = readCredentials(process.env);
  if ('error' in credentials) throw new Error(credentials.error);
  // Deliberately drop direct credentials so Jev can only route through Vercel.
  const gateway = createJevGateway({ vercel: credentials.vercel, typesafe: undefined }, { now: () => Date.now() }, { preferFree: true });
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const report: Record<string, unknown> = { status: 'running', dataset: caseDoc.dataset, method: 'deterministic paired selection; positions 0 and 2 for balanced label cells / all other cells positions 0 and 1',
    sample_sha256: { cases: sha(await readFile(casesPath)), labels: sha(await readFile(labelsPath)) },
    route: 'Vercel AI Gateway (preferFree throttle policy; spend is measured, not assumed zero)', cost_accounting: 'micros (1e-6 currency units); reported values follow gateway accounting', requested_cases: 12, records: [] };
  const records: Record<string, unknown>[] = [];
  report.selected_ids = selected.map((c) => c.id);
  for (const c of selected) {
    const label = kevById.get(c.id)!.label;
    const { kind } = gatewayQuestion(c);
    const request = modelRequest(c);
    if (Object.keys(request).sort().join(',') !== 'questions,state' || Object.keys(request.questions[c.question_key]!).sort().join(',') !== 'criteria,instructions,type') throw new Error(`${c.id}: model-visible request fields are invalid`);
    const started = Date.now();
    const outcome = await gateway.evaluate({
      request_id: `bev-jev:${c.id}`, site: 'bev-decision-150k.sample-v1', role: 'working', kind,
      state: request.state as never, questions: request.questions as never,
      terms: { ...probeTerms({ vercel: credentials.vercel, typesafe: undefined }, { now: () => Date.now() }, { preferFree: true }), max_attempts: 1, max_attempts_per_route: 1 },
    });
    const latency = Date.now() - started;
    const attempt = outcome.attempts[0];
    const base = { id: c.id, row_index: c.row_index, domain: c.domain, type: c.type, question_key: c.question_key,
      status: outcome.status, routed_unit_id: outcome.status === 'accepted' ? outcome.routed_unit_id : undefined,
      model: attempt?.model, latency_ms: latency, spent: outcome.spent,
      attempts: outcome.attempts.map((a) => ({ model: a.model, status: a.disposition.status, cost: a.cost,
        ...(a.disposition.status === 'failed' ? { failure_code: a.disposition.failure.code } : {}),
        ...(a.usage.input_tokens === undefined ? {} : { input_tokens: a.usage.input_tokens }) })) };
    const checkpointFailure = async (reason: string, raw_answer?: unknown): Promise<never> => {
      records.push({ ...base, reason, ...(raw_answer === undefined ? {} : { raw_answer }) });
      report.status = 'failed'; report.records = records;
      await mkdir(dirname(outPath), { recursive: true }); await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
      throw new Error(`${c.id}: ${reason}; gateway spend so far ${records.reduce((s, r) => s + Number(r['spent']), 0)}`);
    };
    if (outcome.status !== 'accepted') {
      await checkpointFailure(`gateway status ${outcome.status}: ${outcome.reason}`);
      return;
    }
    if (outcome.routed_unit_id !== `${kind}@vercel` || attempt?.model !== 'typesafe-ai/jev') {
      await checkpointFailure(`unexpected Jev route/model identity (route=${outcome.routed_unit_id ?? 'missing'}, model=${attempt?.model ?? 'missing'})`);
      return;
    }
    const raw = outcome.answers[c.question_key];
    if (raw === undefined) { await checkpointFailure('missing typed answer'); return; }
    let scored: Record<string, unknown>;
    try { scored = scoreAnswer(c, label, raw); }
    catch (error) { await checkpointFailure(error instanceof Error ? error.message : String(error), raw); return; }
    const kr = kevById.get(c.id)!;
    records.push({ ...base, raw_answer: raw, ...scored, label, kev_prediction: c.type === 'score' ? kr.result?.rounded_level : kr.result?.predicted,
      kev_correct: c.type === 'score' ? kr.result?.rounded_correct : kr.result?.correct,
      kev_predicted: c.type === 'score' ? kr.result?.rounded_level : undefined, kev_expected_level: kr.result?.expected_level });
    report.records = records;
    await mkdir(dirname(outPath), { recursive: true }); await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`${records.length}/12 ${c.id} ${outcome.status} ${String(scored['correct'])}`);
  }
  report.status = 'complete';
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const r of records) { const k = `${r['domain']} / ${r['type']}`; grouped.set(k, [...(grouped.get(k) ?? []), r]); }
  report.per_cell = Object.fromEntries([...grouped].map(([k, rows]) => [k, { n: rows.length,
    jev_correct: rows.filter((r) => r['correct'] === true).length, kev_correct: rows.filter((r) => r['kev_correct'] === true).length,
    mean_latency_ms: rows.reduce((s, r) => s + Number(r['latency_ms']), 0) / rows.length }]));
  report.paired = { n: records.length, jev_correct: records.filter((r) => r['correct'] === true).length,
    kev_correct: records.filter((r) => r['kev_correct'] === true).length,
    both_correct: records.filter((r) => r['correct'] === true && r['kev_correct'] === true).length,
    jev_only: records.filter((r) => r['correct'] === true && r['kev_correct'] === false).length,
    kev_only: records.filter((r) => r['correct'] === false && r['kev_correct'] === true).length,
    neither: records.filter((r) => r['correct'] === false && r['kev_correct'] === false).length,
    total_spent_micros: Number(records.reduce((s, r) => s + Number(r['spent']), 0).toFixed(6)),
    mean_latency_ms: records.reduce((s, r) => s + Number(r['latency_ms']), 0) / records.length };
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ per_cell: report.per_cell, paired: report.paired }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
