#!/usr/bin/env node
/**
 * M0-C2 No ambient clock.
 *
 * Runtime code paths that produce CycleRecord, Candidate, or ActionRecord do
 * not read a wall clock or a monotonic clock. Time enters only as `clock.tick`
 * observations. The check scans package source (not tests) for clock APIs.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const SCANNED = [
  'packages/agentsop/src',
  'packages/agentfabric/src',
  'packages/gateway/src',
  'packages/weave/src',
];

const FORBIDDEN = [
  [/\bDate\b/, 'Date'],
  [/\bperformance\.now\b/, 'performance.now'],
  [/\bperformance\.timeOrigin\b/, 'performance.timeOrigin'],
  [/\bhrtime\b/, 'process.hrtime'],
  [/\bsetTimeout\b/, 'setTimeout'],
  [/\bsetInterval\b/, 'setInterval'],
  [/\bsetImmediate\b/, 'setImmediate'],
  [/\bIntl\.DateTimeFormat\b/, 'Intl.DateTimeFormat'],
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations = [];
let filesChecked = 0;

for (const dir of SCANNED) {
  for (const file of walk(join(root, dir))) {
    filesChecked += 1;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const [pattern, name] of FORBIDDEN) {
        if (pattern.test(code)) {
          violations.push(`${relative(root, file)}:${index + 1}: ${name}`);
        }
      }
    });
  }
}

if (filesChecked === 0) {
  console.error('M0-C2 FAIL: no runtime sources found');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('M0-C2 FAIL: ambient clock access in runtime code');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`M0-C2 OK: no ambient clock in ${filesChecked} runtime files`);
