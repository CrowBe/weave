#!/usr/bin/env node
/**
 * D3 (`loop.preselect`) is a frozen benchmark and Gauge site (WV-S1 P4c).
 *
 * Decide-2 replaced it in the loop. No runtime composition may ask D3 or feed
 * its narrowed slice into a generation prompt, so package source may name it
 * only where it is defined and re-exported for the benchmark and Gauge, and in
 * the gateway's provider-selection config for that benchmark site. Benchmarks,
 * examples and tests are outside `packages/<pkg>/src` and are not scanned.
 * This is a source-shape check: a site name computed at run time is not seen.
 *
 * Usage: node checks/no-preselect-in-runtime.mjs [root]. The root defaults to
 * the repository; checks/test passes a fixture tree.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { blankComments, walkTs } from './source-scan.mjs';

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname);
const ALLOWED = new Set([
  // The frozen D3 site itself (frozen digests; Decide-2 may reuse its relevance evidence shape).
  'packages/weave/src/sites/boolean.ts',
  // Type and function re-exports the benchmark and Gauge import.
  'packages/weave/src/index.ts',
  // Provider selection for the benchmark site; it selects an adapter, never a prompt.
  'packages/gateway/src/config.ts',
  'packages/gateway/src/index.ts',
]);
const D3 = /preselect/gi;

const packages = join(root, 'packages');
const violations = [];
let filesChecked = 0;
for (const pkg of existsSync(packages) ? readdirSync(packages).sort() : []) {
  for (const file of walkTs(join(packages, pkg, 'src'))) {
    filesChecked += 1;
    const path = relative(root, file).split('\\').join('/');
    if (ALLOWED.has(path)) continue;
    const source = blankComments(readFileSync(file, 'utf8'));
    const lines = source.split('\n');
    for (const [index, line] of lines.entries()) {
      D3.lastIndex = 0;
      if (D3.test(line)) violations.push(`${path}:${index + 1}: D3 loop.preselect is frozen; use Decide-2`);
    }
  }
}

if (filesChecked === 0) {
  console.error('No-preselect-in-runtime FAIL: no package sources found');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('No-preselect-in-runtime FAIL: runtime source names the frozen D3 site');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`No-preselect-in-runtime OK: D3 appears only at its frozen sites, in ${filesChecked} package source files`);
