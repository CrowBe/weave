/** Curate fixture-derived capability.match training rows with hosted Jev.
 *
 * Run `npm run build` first, then `node --env-file-if-exists=.env.local
 * benchmarks/inference/gliner-decide/curate-jev.mjs`. Only the public fixture
 * scenario summaries in jev-curation-source.json cross the TypeSafe boundary. The audit retains
 * disagreements and failures; those rows never enter the training JSONL.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInferenceGateway } from '@weave/gateway';
import { typesafeAiEvaluator, TYPESAFE_AI_ADAPTER, TYPESAFE_AI_DESTINATION } from '@weave/gateway/typesafe-ai';
import { FIXTURE_CONTRACTS } from '@weave/agentfabric';
import { FOLD_CONTRACT, NORMALIZE_CONTRACT } from '@weave/weave';

const HERE = dirname(fileURLToPath(import.meta.url));
const outputFlag = process.argv.indexOf('--output');
if (outputFlag !== -1 && !process.argv[outputFlag + 1]) throw Error('--output requires a directory');
const OUTPUT = resolve(outputFlag === -1 ? resolve(HERE, 'jev-curated') : process.argv[outputFlag + 1]);
const PROMPT = 'Which one listed capability contract performs the requested operation by itself? Choose none when no single contract does. Select semantic fit only; this does not grant execution authority.';
const CONTRACTS = new Map([...FIXTURE_CONTRACTS, NORMALIZE_CONTRACT, FOLD_CONTRACT].map((contract) => [contract.id, contract]));
async function sourceRows() {
  const source = JSON.parse(await readFile(resolve(HERE, 'jev-curation-source.json'), 'utf8'));
  if (source.version !== 'capability.match.fixture-source.v1' || !Array.isArray(source.rows)) {
    throw Error('invalid curation source');
  }
  const ids = new Set();
  for (const row of source.rows) {
    if (!row.id || ids.has(row.id) || !Array.isArray(row.catalogue) || !row.catalogue.includes(row.label) && row.label !== 'none') {
      throw Error(`invalid curation row ${row.id}`);
    }
    ids.add(row.id);
    for (const id of row.catalogue) if (!CONTRACTS.has(id)) throw Error(`unknown contract ${id}`);
  }
  return source.rows;
}

function description(contract) {
  return JSON.stringify({ purpose: contract.purpose, input: contract.input, output: contract.output, effects: contract.effects });
}

function wire(row) {
  const ordered = [...row.catalogue].sort((a, b) => createHash('sha256').update(`${row.id}:${a}`).digest('hex').localeCompare(createHash('sha256').update(`${row.id}:${b}`).digest('hex')));
  const ids = Object.fromEntries(ordered.map((id, index) => [id, `c${index}`]));
  ids.none = 'none';
  const criteria = Object.fromEntries(ordered.map((id) => [ids[id], description(CONTRACTS.get(id))]));
  criteria.none = 'No single listed capability performs the requested operation.';
  return { ids, criteria };
}

async function main() {
  try {
    await access(OUTPUT);
    throw Error(`refusing to overwrite ${OUTPUT}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const key = process.env.TYPESAFE_AI_API_KEY;
  if (!key) throw Error('TYPESAFE_AI_API_KEY is required; no other destination is used');
  const rows = await sourceRows();
  const clock = { now: () => Date.now() };
  const gateway = createInferenceGateway({
    routes: [{ routed_unit_id: 'choice@typesafe-curation', operation: 'evaluate', kind: 'choice', adapter: TYPESAFE_AI_ADAPTER,
      model: 'jev-latest', destination: TYPESAFE_AI_DESTINATION, quality: 'baseline', context_limit_tokens: 8_000,
      context_profile: 'profile.capability-match-curation', context_profile_version: 1,
      prompt_template: 'template.capability-match-curation', prompt_template_version: 1,
      settings: { max_output_tokens: 512 }, price: { input_per_mtok: 42_000, output_per_mtok: 0 } }],
    evaluators: [typesafeAiEvaluator({ apiKey: key })], clock,
  });
  const audit = [];
  const training = [];
  for (const row of rows) {
    const { ids, criteria } = wire(row);
    const state = { desired_operation: row.desired, situation: row.situation };
    const result = await gateway.evaluate({ request_id: `curate:${row.id}`, site: 'capability.match.curate', role: 'working', kind: 'choice',
      state, questions: { match: { type: 'choice', instructions: PROMPT, criteria } },
      terms: { quality: 'baseline', destinations: [TYPESAFE_AI_DESTINATION], max_context_tokens: 8_000,
        deadline: clock.now() + 30_000, cost_ceiling: 1_000, max_attempts: 1, max_attempts_per_route: 1 } });
    const answer = result.status === 'accepted' ? result.answers.match : undefined;
    const chosen = answer?.type === 'choice' ? answer.choice : null;
    const expected = ids[row.label];
    const decision = chosen === expected ? 'training_candidate' : 'quarantine';
    audit.push({ ...row, presented: criteria, expected_wire_label: expected, jev: { status: result.status, choice: chosen,
      probabilities: answer?.type === 'choice' ? answer.probabilities : undefined,
      routed_unit_id: result.status === 'accepted' ? result.routed_unit_id : undefined,
      provider_response_id: result.status === 'accepted' ? result.provider_response_id : undefined,
      attempts: result.attempts.map((attempt) => ({ routed_unit_id: attempt.routed_unit_id, status: attempt.disposition.status })),
      reason: result.status === 'accepted' ? undefined : result.reason,
      spent_micros: result.spent }, decision });
    if (decision === 'training_candidate') {
      training.push({ input: JSON.stringify(state), output: { classifications: [{ task: 'match', labels: Object.keys(criteria),
        true_label: [expected], label_descriptions: criteria, prompt: PROMPT }] } });
    }
    console.log(`${row.id}: ${decision} (${chosen ?? result.status})`);
  }
  await mkdir(OUTPUT, { recursive: false });
  await writeFile(resolve(OUTPUT, 'training.jsonl'), training.map((item) => JSON.stringify(item)).join('\n') + '\n');
  await writeFile(resolve(OUTPUT, 'audit.json'), JSON.stringify({ version: 'capability.match.jev-curation.v1',
    status: 'fixture-derived exploratory training seed; no independent production labels or held-out quality claim',
    model: 'jev-latest', destination: TYPESAFE_AI_DESTINATION,
    source_sha256: createHash('sha256').update(await readFile(resolve(HERE, 'jev-curation-source.json'))).digest('hex'),
    contract_revisions: Object.fromEntries([...CONTRACTS].map(([id, contract]) => [id, {
      revision: contract.revision, sha256: createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
    }])),
    prompt: PROMPT, source_rows: rows.length, training_candidates: training.length, quarantined: rows.length - training.length,
    rows: audit }, null, 2) + '\n');
}

await main();
