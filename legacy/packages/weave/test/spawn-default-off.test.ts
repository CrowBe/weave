import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * WV-S1 P5c1 group 1 (D-ENG-053/054/056): production spawn stays default-off. No non-test module
 * under `packages/<name>/src` may supply a `spawn` key to a `DispatchPorts` value or to a
 * `decideDispatch` port object. A module is in scope when it names `DispatchPorts`,
 * `decideDispatch` or `SpawnPort`; the port's own type declaration (`readonly spawn?:`) is exempt.
 */
const REPOSITORY = new URL('../../../../', import.meta.url).pathname;
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SCOPE = /\b(?:DispatchPorts|decideDispatch|SpawnPort)\b/;
const SUPPLIES: readonly RegExp[] = [
  // `spawn: port`, `spawn?: port` in an object literal, but not a `readonly` type member.
  /(?<!\breadonly\s+)\bspawn\s*\??\s*:(?!:)/,
  // Shorthand `{ ...rest, spawn }`.
  /[{,]\s*spawn\s*(?=[,}])/,
  // Quoted or computed key, assignment and definition.
  /\[\s*(['"`])spawn\1\s*\]\s*[:=](?!=)/,
  /(['"`])spawn\1\s*:/,
  /\.spawn\s*=(?!=)/,
  /defineProperty\([^)]*(['"`])spawn\1/,
];

/** Blanks comments and string/template text (keeping quotes), so prose never matches. */
export function code(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '/' && source[i + 1] === '/') {
      const stop = source.indexOf('\n', i);
      const to = stop === -1 ? source.length : stop;
      out += ' '.repeat(to - i);
      i = to;
    } else if (c === '/' && source[i + 1] === '*') {
      const stop = source.indexOf('*/', i + 2);
      const to = stop === -1 ? source.length : stop + 2;
      out += source.slice(i, to).replace(/[^\n]/g, ' ');
      i = to;
    } else if (c === "'" || c === '"' || c === '`') {
      let k = i + 1;
      while (k < source.length && source[k] !== c) k += source[k] === '\\' ? 2 : 1;
      const body = source.slice(i + 1, k);
      // Keep a whole `'spawn'` literal so a quoted key still matches; blank any other text.
      out += c + (body === 'spawn' ? body : body.replace(/[^\n]/g, ' ')) + (k < source.length ? c : '');
      i = k + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function sources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'test' || name === 'node_modules' || name === 'dist') continue;
      files.push(...sources(path));
    } else if (SOURCE.test(name) && !/\.test\.[a-z]+$/.test(name) && !name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

export function spawnSuppliers(root: string, override?: { readonly file: string; readonly text: string }): string[] {
  const offenders: string[] = [];
  const packages = join(root, 'packages');
  for (const name of readdirSync(packages)) {
    const src = join(packages, name, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sources(src)) {
      const rel = relative(root, file);
      const text = override?.file === rel ? override.text : readFileSync(file, 'utf8');
      const scanned = code(text);
      if (!SCOPE.test(scanned)) continue;
      for (const pattern of SUPPLIES) if (pattern.test(scanned)) offenders.push(`${rel}: ${pattern}`);
    }
  }
  return offenders;
}

test('P5c1-1 no production module supplies ports.spawn (default-off source scan)', () => {
  assert.deepEqual(spawnSuppliers(REPOSITORY), []);
});

test('P5c1-1 the scan rejects each way a production composition could inject ports.spawn', () => {
  const file = 'packages/weave/src/dispatch.ts';
  const original = readFileSync(join(REPOSITORY, file), 'utf8');
  const compositions = [
    'const ports: DispatchPorts = { generate, evaluate, now, dispatch, spawn: openChildren };',
    'export const compose = (base: DispatchPorts) => ({ ...base, spawn });',
    'void decideDispatch(request, { ...ports, spawn: port }, journal);',
    "void decideDispatch(request, { ...ports, ['spawn']: port } as DispatchPorts, journal);",
    "const p = { ...ports } as Record<string, unknown>; p['spawn'] = port;",
    'const p: { spawn?: SpawnPort } = {}; p.spawn = port;',
  ];
  for (const line of compositions)
    assert.notDeepEqual(spawnSuppliers(REPOSITORY, { file, text: `${original}\n${line}\n` }), [], line);
  // Comments, strings, kind values and reads stay clean.
  const benign = [
    '// ports.spawn: never injected here; { spawn } is prose',
    "const label = 'spawn: off';",
    "const isSpawn = (i: { kind: string }) => i.kind === 'spawn';",
    'const injected = (p: DispatchPorts) => p.spawn !== undefined;',
  ];
  for (const line of benign)
    assert.deepEqual(spawnSuppliers(REPOSITORY, { file, text: `${original}\n${line}\n` }), [], line);
});
