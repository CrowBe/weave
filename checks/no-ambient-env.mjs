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
  [/\bprocess\s*(?:\??\.\s*env\b|(?:\?\.\s*)?\[\s*['"`]env['"`]\s*\])/, 'process.env'],
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

/**
 * Blanks comments and template-literal text with spaces, keeping every newline
 * and offset. A scanner, not a regex: a `/*` or `//` inside a string or a
 * template is text, and a template's text is not code, while its `${...}`
 * expressions are. Quoted strings are kept, since `process['env']` and
 * `from 'node:process'` are matched through them. A regex literal containing a
 * quote or comment marker is not modelled.
 */
function blankComments(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // One entry per open template: the brace depth of its innermost `${` expression, or -1 in its text.
  const templates = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const inText = templates.length > 0 && templates[templates.length - 1] === -1;
    if (inText) {
      if (c === '\\') {
        blank(i, i + 2);
        i += 2;
      } else if (c === '`') {
        templates.pop();
        i += 1;
      } else if (c === '$' && source[i + 1] === '{') {
        templates[templates.length - 1] = 0;
        i += 2;
      } else {
        blank(i, i + 1);
        i += 1;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const stop = source.indexOf('\n', i);
      const to = stop === -1 ? source.length : stop;
      blank(i, to);
      i = to;
    } else if (c === '/' && source[i + 1] === '*') {
      const stop = source.indexOf('*/', i + 2);
      const to = stop === -1 ? source.length : stop + 2;
      blank(i, to);
      i = to;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < source.length && source[k] !== c && source[k] !== '\n') k += source[k] === '\\' ? 2 : 1;
      i = k + 1;
    } else if (c === '`') {
      templates.push(-1);
      i += 1;
    } else {
      if (templates.length > 0) {
        const top = templates.length - 1;
        if (c === '{') templates[top] += 1;
        else if (c === '}') templates[top] = templates[top] === 0 ? -1 : templates[top] - 1;
      }
      i += 1;
    }
  }
  return out.join('');
}

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
    // Match whole-source constructs, so a formatter splitting an import or a
    // destructuring across lines cannot hide it. Comments and allowed
    // expressions are blanked with spaces, keeping offsets and line numbers.
    let code = blankComments(readFileSync(file, 'utf8'));
    for (const entry of allowed) {
      const parts = code.split(entry.expression);
      allowanceUses.set(entry, allowanceUses.get(entry) + parts.length - 1);
      code = parts.join(' '.repeat(entry.expression.length));
    }
    const found = [];
    for (const [pattern, label] of FORBIDDEN) {
      for (const match of code.matchAll(new RegExp(pattern.source, 'g'))) {
        found.push({ line: code.slice(0, match.index).split('\n').length, label });
      }
    }
    found.sort((a, b) => a.line - b.line);
    for (const { line, label } of found) violations.push(`${path}:${line}: ${label}`);
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
