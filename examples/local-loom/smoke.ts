/** A synthetic live wiring probe, not a benchmark or a model quality estimate. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { runLocalTask, type LocalTaskEvent } from '@weave/weave';
import { localConfiguration } from './config.ts';
import { localTaskPorts, type InferenceEvidence } from './ports.ts';

const flags = process.argv.slice(2);
if (flags.some((flag) => !['--all-local', '--compound'].includes(flag))) throw new Error('Unknown smoke flag.');
const allLocal = flags.includes('--all-local');
const compound = flags.includes('--compound');
const config = localConfiguration(
  { ...process.env, ...(allLocal ? { LOOM_EXTRACTOR: '' } : {}) },
  new URL('../../', import.meta.url),
);
if (!config.status.ready) throw new Error(config.status.messages.join(' '));
const evidence: InferenceEvidence[] = [];
const events: LocalTaskEvent[] = [];
const local = localTaskPorts(
  config.gateway,
  {
    max_calls: 24,
    cost_ceiling: 100_000,
    per_call_ceiling: 25_000,
    deadline: Date.now() + 120_000,
    destinations: config.destinations,
  },
  () => Date.now(),
  (event) => evidence.push(event),
  config.nativeExtract,
);
const input = compound
  ? 'Normalize whitespace in each of these two separate strings: " one   two " and " three   four ". Return both normalized strings separately.'
  : 'Normalize whitespace in "  hello    world  "';
const result = await runLocalTask(
  input,
  local.ports,
  { max_nodes: 16, max_depth: 4, concurrency: 2 },
  undefined,
  (event) => events.push(event),
);
const directory = new URL('../../.local/inference/', import.meta.url);
mkdirSync(directory, { recursive: true });
const file = new URL(`smoke-${allLocal ? 'local' : 'hybrid'}-${compound ? 'compound' : 'single'}.json`, directory);
writeFileSync(
  file,
  JSON.stringify(
    {
      provenance:
        'Synthetic request authored for this local wiring probe; permitted for the explicitly configured extraction destination. No external dataset or private document. No held-out quality claim.',
      input,
      result,
      stats: local.stats(),
      evidence,
      events,
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
console.log(JSON.stringify({ result, stats: local.stats(), evidence: file.pathname }, null, 2));
if (result.status !== 'completed') process.exitCode = 1;
