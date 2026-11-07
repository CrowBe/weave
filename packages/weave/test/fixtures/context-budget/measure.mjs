// Test-only observation of existing fixture renderer outputs. Never writes source.
// npm run build
// WV353_MEASURE=/tmp/wv353-shapes.jsonl node --import ./packages/weave/test/fixtures/context-budget/measure.mjs --test 'packages/weave/dist/test/*.test.js' 'benchmarks/frontier-weigh/test/*.test.ts'
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';

const destination = process.env.WV353_MEASURE;
if (!destination) throw new Error('WV353_MEASURE is required');
globalThis.__wv353Measure = (site, value) => {
  let nodes = 0;
  let depth = 0;
  const walk = (item, level) => {
    nodes += 1;
    depth = Math.max(depth, level);
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) walk(child, level + 1);
    }
  };
  walk(value, 0);
  const fixture = new Error().stack
    .split('\n')
    .filter((line) => /(?:test|benchmarks)\//.test(line) && !line.includes('measure.mjs'))[0]
    ?.trim();
  appendFileSync(destination, JSON.stringify({ site, depth, nodes, fixture }) + '\n');
  return value;
};
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const names = url.endsWith('/weave/dist/src/views.js')
      ? [
          ['renderFrameView', 'goal.frame'],
          ['renderWeighView', 'frontier.weigh'],
        ]
      : url.endsWith('/weave/dist/src/audit-view.js')
        ? [['assembleAuditState', 'audit.generate']]
        : [];
    if (!names.length) return loaded;
    let source = String(loaded.source);
    for (const [name, site] of names) {
      source = source.replace(`export function ${name}(`, `function __measured_${name}(`);
      source += `\nexport function ${name}(...args) { return globalThis.__wv353Measure(${JSON.stringify(site)}, __measured_${name}(...args)); }\n`;
    }
    return { ...loaded, source };
  },
});
