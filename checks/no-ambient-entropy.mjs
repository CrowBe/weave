#!/usr/bin/env node
/**
 * No ambient entropy in Loom.
 *
 * Loom runtime code does not draw random values itself. Fresh identities enter
 * through injected ports (for example the implementation step's `runId`), as
 * time enters through `now` and `clock.tick` (M0-C2), so a run can be replayed
 * from its inputs. The check scans Loom source (not tests) for entropy APIs.
 * Composition roots, tests and other packages may still use them.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const SCANNED = ['packages/weave/src'];

const FORBIDDEN = [
  [/\brandomUUID\b/, 'randomUUID'],
  [/\brandomBytes\b/, 'randomBytes'],
  [/\brandomInt\b/, 'randomInt'],
  [/\brandomFill(?:Sync)?\b/, 'randomFill'],
  [/\bgetRandomValues\b/, 'getRandomValues'],
  [/\bMath\.random\b/, 'Math.random'],
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
  console.error('No ambient entropy FAIL: no Loom sources found');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('No ambient entropy FAIL: entropy API in Loom runtime code');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`No ambient entropy OK: no entropy API in ${filesChecked} Loom files`);
