#!/usr/bin/env node
/**
 * M0-C1 Package direction.
 *
 *   agentsop     imports neither weave nor agentfabric
 *   agentfabric  imports agentsop only
 *   weave        imports agentsop and agentfabric only
 *   the fake host (weave test code) depends only on the host interface (agentsop)
 *
 * Runs on source text alone; it does not load Weave or its tests.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const packagesDir = join(root, 'packages');

const ALLOWED = {
  agentsop: new Set(),
  agentfabric: new Set(['agentsop']),
  weave: new Set(['agentsop', 'agentfabric']),
};

const FAKE_HOST_ALLOWED = new Set(['agentsop']);

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.mts') || full.endsWith('.js') || full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

function packageOf(file) {
  const rel = relative(packagesDir, file);
  if (rel.startsWith('..')) return null;
  return rel.split(sep)[0];
}

function targetPackage(specifier, fromFile) {
  const scoped = specifier.match(/^@weave\/([a-z]+)(?:\/|$)/);
  if (scoped) return scoped[1];
  if (specifier.startsWith('.')) {
    return packageOf(resolve(dirname(fromFile), specifier));
  }
  return null; // node builtins or third-party: not an in-repo edge
}

const violations = [];
let filesChecked = 0;

for (const pkg of Object.keys(ALLOWED)) {
  const pkgDir = join(packagesDir, pkg);
  if (!existsSync(pkgDir)) continue;
  for (const file of walk(pkgDir)) {
    filesChecked += 1;
    const text = readFileSync(file, 'utf8');
    const isFakeHost = pkg === 'weave' && relative(pkgDir, file).replace(/\\/g, '/') === 'test/fake-host.ts';
    const isTest = relative(pkgDir, file).split(sep)[0] === 'test';
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      const target = targetPackage(specifier, file);
      if (target === null || target === pkg) {
        if (isFakeHost && target === pkg) {
          violations.push(`${relative(root, file)}: fake host imports Weave runtime code ('${specifier}')`);
        }
        continue;
      }
      const allowed = isFakeHost ? FAKE_HOST_ALLOWED : isTest ? new Set([...ALLOWED[pkg], pkg]) : ALLOWED[pkg];
      if (!allowed.has(target)) {
        violations.push(`${relative(root, file)}: ${pkg} may not import ${target} ('${specifier}')`);
      }
    }
  }
}

if (filesChecked === 0) {
  console.error('M0-C1 FAIL: no package sources found under packages/');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('M0-C1 FAIL: import direction violations');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`M0-C1 OK: import direction holds across ${filesChecked} files`);
