#!/usr/bin/env node
/**
 * No swallowed failures in scripts and CI.
 *
 * A gate that cannot fail is a report. `vp lint || true` exited 0 whatever
 * happened, so CI's `continue-on-error` never took effect and a crashed or
 * missing tool still showed green (#81 review, #82-#88, #85). This check keeps
 * that from returning. Related: #203, which turns recurring judgment findings
 * into deterministic checks.
 *
 * It reads the `scripts` of the root and every packages/<name>/package.json,
 * and every step of .github/workflows/*.yml. A script or `run:` command may not
 * end a command with `|| true`, `|| :` or `|| exit 0`, and a workflow step may
 * not set `continue-on-error: true`. ALLOWED lists exact workflow steps (by
 * their `run:` command) that report without gating; an entry that matches no
 * step fails the check, so the list cannot outlive the step it excuses.
 *
 * Usage: node checks/no-swallowed-failures.mjs [root]. The root defaults to the
 * repository; checks/test passes a fixture tree.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repository = resolve(new URL('..', import.meta.url).pathname);
const root = resolve(process.argv[2] ?? repository);

const SWALLOW = /\|\|\s*(?:true|:|exit\s+0)\s*(?:$|[;&|)])/;

/** Workflow steps allowed to report without gating, by exact `run:` command. */
const ALLOWED = [];
const allowanceUses = new Map(ALLOWED.map((entry) => [entry, 0]));

const violations = [];
let filesChecked = 0;

function checkPackageJson(file) {
  if (!existsSync(file)) return;
  filesChecked += 1;
  const scripts = JSON.parse(readFileSync(file, 'utf8')).scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === 'string' && SWALLOW.test(command)) {
      violations.push(`${relative(root, file)}: script "${name}" swallows its failure: ${command}`);
    }
  }
}

/** Decodes a single- or double-quoted YAML scalar; anything else is returned as is. */
function unquote(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return value;
}

function checkWorkflow(file) {
  filesChecked += 1;
  const path = relative(root, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  let step = null;
  const close = () => {
    if (!step) return;
    if (step.continueOnError) {
      const allowed = ALLOWED.find((entry) => entry.file === path && entry.run === step.run);
      if (allowed) allowanceUses.set(allowed, allowanceUses.get(allowed) + 1);
      else
        violations.push(`${path}:${step.line}: step sets continue-on-error: true${step.run ? ` (${step.run})` : ''}`);
    }
    step = null;
  };
  lines.forEach((raw, index) => {
    const line = raw.replace(/(?:^|\s+)#.*$/, '');
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (item && (step === null || item[1].length <= step.indent)) {
      close();
      step = { indent: item[1].length, line: index + 1, run: null, continueOnError: false };
    } else if (step && line.trim() !== '' && /^\s*/.exec(line)[0].length <= step.indent) {
      close();
    }
    const body = item ? item[2] : line;
    const run = /^\s*run:\s*(.*)$/.exec(body);
    const command = run ? unquote(run[1].trim()) : line;
    if (run && step) step.run = command;
    // Any line, so a multi-line `run: |` block is covered too. A quoted `run:`
    // scalar is decoded first, or its closing quote would hide the swallow.
    if (SWALLOW.test(command)) {
      violations.push(`${path}:${index + 1}: command swallows its failure: ${run ? command : line.trim()}`);
    }
    if (/^\s*continue-on-error:\s*(?:true|'true'|"true")\s*$/.test(body)) {
      // A job-level (or any non-step) continue-on-error is never allowed.
      if (step) step.continueOnError = true;
      else violations.push(`${path}:${index + 1}: job sets continue-on-error: true`);
    }
  });
  close();
}

checkPackageJson(join(root, 'package.json'));
const packagesDir = join(root, 'packages');
if (existsSync(packagesDir)) {
  for (const name of readdirSync(packagesDir).sort()) checkPackageJson(join(packagesDir, name, 'package.json'));
}
const workflows = join(root, '.github', 'workflows');
if (existsSync(workflows)) {
  for (const name of readdirSync(workflows).sort()) {
    if (/\.ya?ml$/.test(name)) checkWorkflow(join(workflows, name));
  }
}

for (const [entry, uses] of allowanceUses) {
  // A fixture tree (checks/test) does not contain the excused steps.
  if (uses === 0 && root === repository) violations.push(`${entry.file}: unused allowance for step \`${entry.run}\``);
}

if (filesChecked === 0) {
  console.error('No swallowed failures FAIL: no package.json or workflow found');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('No swallowed failures FAIL: a script or CI step cannot fail');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`No swallowed failures OK: ${filesChecked} package.json and workflow files gate on failure`);
