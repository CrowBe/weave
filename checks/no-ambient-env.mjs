#!/usr/bin/env node
/**
 * No ambient environment in package source.
 *
 * Package code receives configuration, credentials and endpoints from its
 * caller. The process environment is read at the root (an example, a
 * benchmark runner, a CLI entry) and narrowed there before it is handed in.
 * Reviews kept finding the opposite: a key, base URL or model read deep inside
 * library code (#61, #63, #64, #109, #116, #117, #177). Each was moved to
 * the root by hand; this check keeps it there. Related: #203, which turns
 * recurring judgment findings into deterministic checks.
 *
 * The check scans package source (packages/<name>/src, not tests) for reads
 * of the process environment. ALLOWED lists exact expressions that are their
 * own root. An entry that no longer matches fails the check, so the list
 * cannot outlive the code it excuses.
 *
 * Usage: node checks/no-ambient-env.mjs [root]. The root defaults to the
 * repository; checks/test passes a fixture tree.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repository = resolve(new URL('..', import.meta.url).pathname);
const root = resolve(process.argv[2] ?? repository);

const FORBIDDEN = [
  [/\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])/, 'process.env'],
  [/\{\s*[^}]*\benv\b[^}]*\}\s*=\s*process\b/, 'env destructured from process'],
  [/import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/, "env imported from 'node:process'"],
  [/\bimport\.meta\.env\b/, 'import.meta.env'],
];

/** Exact expressions that read the environment as their own root. */
const ALLOWED = [
  // The isolate worker is a spawned process: it reports whether the canary the
  // parent placed in its environment is visible, to prove isolation.
  { file: 'packages/agentfabric/src/isolate-worker.ts', expression: "process.env['WEAVE_ISOLATION_CANARY']" },
];
const allowanceUses = new Map(ALLOWED.map((entry) => [entry, 0]));

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') out.push(...walk(full));
    } else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(full) && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const violations = [];
let filesChecked = 0;
const packagesDir = join(root, 'packages');
const packages = existsSync(packagesDir) ? readdirSync(packagesDir).sort() : [];

for (const name of packages) {
  for (const file of walk(join(packagesDir, name, 'src'))) {
    filesChecked += 1;
    const path = relative(root, file);
    const allowed = ALLOWED.filter((entry) => entry.file === path);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // A URL's `://` is not a comment; stripping from there would hide the rest of the line.
      let code = line.replace(/(^|[^:])\/\/.*$/, '$1');
      // Doc comment lines name the API without reading it.
      if (/^\s*(?:\/\*|\*)/.test(code)) return;
      for (const entry of allowed) {
        const parts = code.split(entry.expression);
        allowanceUses.set(entry, allowanceUses.get(entry) + parts.length - 1);
        code = parts.join(' ');
      }
      for (const [pattern, label] of FORBIDDEN) {
        if (pattern.test(code)) violations.push(`${path}:${index + 1}: ${label}`);
      }
    });
  }
}

for (const [entry, uses] of allowanceUses) {
  // A fixture tree (checks/test) does not contain the excused files.
  if (uses === 0 && root === repository) {
    violations.push(`${entry.file}: unused allowance \`${entry.expression}\``);
  }
}

if (filesChecked === 0) {
  console.error('No ambient env FAIL: no package sources found');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('No ambient env FAIL: package source reads the environment; read it at the root and pass it in');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`No ambient env OK: no environment read in ${filesChecked} package source files`);
