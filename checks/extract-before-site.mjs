#!/usr/bin/env node
/**
 * Free-text choice sites need an extract@1 origin.
 *
 * A runtime call that names a free-text site must pass a state origin grounded
 * in an extract record. Structural sites name their recorded evidence instead.
 * This is a source-shape check: the runtime gate in sites/index.ts is still the
 * authority that rejects a missing or malformed record at run time.
 *
 * Usage: node checks/extract-before-site.mjs [root]. The root defaults to the
 * repository; checks/test passes a fixture tree.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { blankComments } from './source-scan.mjs';

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname);
const SCANNED = 'packages/weave/src';
const MODEL_SITES = new Set(['intake.classify', 'input.route', 'loop.triage', 'loop.route']);
const STRUCTURAL_SITES = new Set(['loop.continue', 'audit.dispose', 'eval.output']);
const ENTRY_POINTS = /\b(?:evaluateSite|transitionSite)\s*\(/g;
const MODEL_MARKER = /\bmodelOrigin\s*\(|\borigin\s*:\s*\{[^}]*\bkind\s*:\s*['"]model['"]/s;
const STRUCTURAL_MARKER = /\bstructuralOrigin\s*\(|\borigin\s*:\s*\{[^}]*\bkind\s*:\s*['"]structural['"]/s;

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

function callEnd(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === quote) break;
      }
    } else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length - 1;
}

function firstArgument(call) {
  const open = call.indexOf('(');
  const text = call.slice(open + 1, callEnd(call, open));
  const match = /^\s*(['"])([^'"]+)\1/.exec(text);
  return match?.[2] ?? null;
}

const violations = [];
let filesChecked = 0;
let callsChecked = 0;

for (const file of walk(join(root, SCANNED))) {
  filesChecked += 1;
  const source = blankComments(readFileSync(file, 'utf8'));
  const lines = source.split('\n');
  ENTRY_POINTS.lastIndex = 0;
  for (let match = ENTRY_POINTS.exec(source); match !== null; match = ENTRY_POINTS.exec(source)) {
    const open = source.indexOf('(', match.index);
    const call = source.slice(match.index, callEnd(source, open) + 1);
    const site = firstArgument(call);
    if (site === null) continue;
    callsChecked += 1;
    const line = source.slice(0, match.index).split('\n').length;
    if (MODEL_SITES.has(site) && !MODEL_MARKER.test(call)) {
      violations.push(`${relative(root, file)}:${line}: ${site} is free text and needs an extract@1 model origin`);
    } else if (STRUCTURAL_SITES.has(site) && !STRUCTURAL_MARKER.test(call)) {
      violations.push(`${relative(root, file)}:${line}: ${site} needs its recorded structural origin`);
    }
  }
}

if (filesChecked === 0) {
  console.error('Extract-before-site FAIL: no runtime sources found');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('Extract-before-site FAIL: a decision site is asked without a typed-state origin');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`Extract-before-site OK: ${callsChecked} site calls declare an origin in ${filesChecked} files`);
