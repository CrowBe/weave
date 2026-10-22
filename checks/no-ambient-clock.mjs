#!/usr/bin/env node
/**
 * M0-C2 No ambient clock.
 *
 * Runtime code paths that produce CycleRecord, Candidate, or ActionRecord do
 * not read a wall clock or a monotonic clock. Time enters only as `clock.tick`
 * observations. The check scans package source (not tests) for clock APIs.
 * ALLOWED lists the few exact expressions that use `Date` without reading a
 * clock. An entry that no longer matches fails the check, so the list cannot
 * outlive the code it excuses.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const SCANNED = [
  'packages/agentsop/src',
  'packages/agentfabric/src',
  'packages/auth-chatgpt/src',
  'packages/gateway/src',
  'packages/weave/src',
  'packages/weft/src',
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

/** Exact expressions that format or parse a given time; none reads a clock. */
const ALLOWED = [
  // Formats the injected clock reading for the persisted credential record.
  { file: 'packages/auth-chatgpt/src/index.ts', expression: 'new Date(clock.now()).toISOString()' },
  // Validates the stored `saved_at` text when loading credentials.
  { file: 'packages/auth-chatgpt/src/file-store.ts', expression: 'Date.parse(record.saved_at as string)' },
];
const allowanceUses = new Map(ALLOWED.map((entry) => [entry, 0]));

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
    const path = relative(root, file);
    const allowed = ALLOWED.filter((entry) => entry.file === path);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // A URL's `://` is not a comment; stripping from there would hide the rest of the line.
      let code = line.replace(/(^|[^:])\/\/.*$/, '$1');
      for (const entry of allowed) {
        const parts = code.split(entry.expression);
        allowanceUses.set(entry, allowanceUses.get(entry) + parts.length - 1);
        code = parts.join(' ');
      }
      for (const [pattern, name] of FORBIDDEN) {
        if (pattern.test(code)) {
          violations.push(`${path}:${index + 1}: ${name}`);
        }
      }
    });
  }
}

for (const [entry, uses] of allowanceUses) {
  if (uses === 0) violations.push(`${entry.file}: unused allowance \`${entry.expression}\``);
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
