#!/usr/bin/env node
/**
 * M0-C1 Package direction.
 *
 *   agentsop     imports neither weave nor agentfabric
 *   gateway      imports nothing in-repo: both runtimes may call it, and the
 *                inference request interface must not drag either in
 *   agentfabric  imports agentsop and gateway only
 *   weave        imports agentsop, agentfabric and gateway only
 *   the fake host (weave test code) depends only on the host interface (agentsop)
 *
 * Consumers (benchmarks/, examples/) are leaves. They may import any package —
 * a benchmark of a judgment site needs the view renderer — but the dependency
 * runs one way: no package may reach into a consumer, and a consumer reaches a
 * package through its `@weave/*` entry point rather than by relative path into
 * its internals. Both directions were unchecked before: a relative specifier
 * that escaped packages/ resolved to no package and was read as third-party.
 *
 * Runs on source text alone; it does not load Weave or its tests.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const packagesDir = join(root, 'packages');

const ALLOWED = {
  agentsop: new Set(),
  gateway: new Set(),
  agentfabric: new Set(['agentsop', 'gateway']),
  weave: new Set(['agentsop', 'agentfabric', 'gateway']),
};

const FAKE_HOST_ALLOWED = new Set(['agentsop']);

/** Leaf directories that consume packages and are consumed by nothing. */
const CONSUMERS = ['benchmarks', 'examples'];

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

/** The repo-root directory a relative specifier lands in, or null if outside. */
function consumerOf(specifier, fromFile) {
  if (!specifier.startsWith('.')) return null;
  const rel = relative(root, resolve(dirname(fromFile), specifier));
  if (rel.startsWith('..')) return null;
  return rel.split(sep)[0];
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
      const escaped = consumerOf(specifier, file);
      if (escaped !== null && escaped !== 'packages') {
        violations.push(
          `${relative(root, file)}: ${pkg} may not import from ${escaped}/ ('${specifier}') — ` +
            'the dependency runs from a consumer to a package, never back',
        );
        continue;
      }
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

for (const consumer of CONSUMERS) {
  const dir = join(root, consumer);
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    filesChecked += 1;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith('.')) continue;
      const landed = consumerOf(specifier, file);
      if (landed === 'packages') {
        violations.push(
          `${relative(root, file)}: ${consumer} reaches into package internals ('${specifier}') — ` +
            "import the package's @weave/* entry point instead",
        );
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
