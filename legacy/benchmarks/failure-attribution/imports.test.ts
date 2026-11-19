import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

const leaf = dirname(new URL(import.meta.url).pathname);
const root = resolve(leaf, '../..');
const harness = { 'node:test': ['test'], 'node:assert/strict': ['strict'] };
const reader = ['readTuneArtifact', 'readSealedInputs', 'type:SealedOptions', 'type:SealedInputs'];
const digest = ['storedByteDigest'];
const sealed = ['loadSealedLabels', 'validateSealedLabelEnvelope'];
const labels = [
  'loadTuneCorpus',
  'validateCorpus',
  'projectInput',
  'assess',
  'assertLineageDisjoint',
  'expectedOfflineControl',
  'expectedJudgmentControl',
  'summarize',
  'shapeVerdict',
  'tuneContext',
  'type:Corpus',
  'type:TuneCase',
  'type:TuneLabel',
  'type:FrozenFacts',
  'type:LeafDecision',
];
const permissions: Record<string, Record<string, string[]>> = {
  'reader-core.ts': {
    'node:fs': ['openSync', 'fstatSync', 'readSync', 'closeSync', 'lstatSync', 'realpathSync'],
    'node:path': ['dirname', 'isAbsolute', 'relative', 'resolve', 'sep'],
    '@weave/weft': ['isDigest'],
    '@weave/gauge': ['recordDigest'],
    './stored-byte-digest.ts': digest,
  },
  'reader.ts': { './reader-core.ts': ['productionReader'] },
  'stored-byte-digest.ts': { 'node:crypto': ['createHash'] },
  'sealed-labels.ts': {
    './reader.ts': reader,
    '@weave/weft': ['isDigest'],
    '@weave/gauge': ['type:AttributionCategory'],
  },
  'label-harness.ts': {
    './reader.ts': reader,
    './sealed-labels.ts': sealed,
    '@weave/gauge': ['validate', 'recordDigest', 'type:AttributionCategory', 'type:Context'],
  },
  'cases.test.ts': { ...harness, './reader.ts': reader, './label-harness.ts': labels, './sealed-labels.ts': sealed },
  'reader.test.ts': {
    ...harness,
    'node:fs': ['mkdtempSync', 'mkdirSync', 'writeFileSync', 'readFileSync', 'symlinkSync', 'rmSync'],
    'node:os': ['tmpdir'],
    'node:path': ['join', 'resolve'],
    './reader-core.ts': ['createTestReader'],
    './reader.ts': reader,
    './stored-byte-digest.ts': digest,
    '@weave/gauge': ['recordDigest'],
  },
  'imports.test.ts': {
    ...harness,
    'node:fs': ['readdirSync', 'readFileSync', 'lstatSync'],
    'node:path': ['dirname', 'join', 'relative', 'resolve', 'sep'],
    'typescript/unstable/sync': ['API'],
    'typescript/unstable/ast': ['SyntaxKind'],
  },
};
const globals = new Set([
  'JSON',
  'Object',
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'Promise',
  'Error',
  'TypeError',
  'RangeError',
  'Number',
  'String',
  'Boolean',
  'Symbol',
  'RegExp',
  'Uint8Array',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'undefined',
  'NaN',
  'Infinity',
]);
const math = new Set(['abs', 'ceil', 'floor', 'max', 'min', 'round', 'trunc']);
const forbiddenBuiltins = [
  'node:vm',
  'node:module',
  'node:child_process',
  'node:worker_threads',
  'node:inspector',
  'node:wasi',
  'node:repl',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:dns',
  'node:http',
  'node:https',
  'node:http2',
];
type Project = ReturnType<ReturnType<API['updateSnapshot']>['getProjects']>[number];
type Node = Parameters<Project['checker']['getSymbolAtLocation']>[0][number];
type Ast = Node & {
  text?: string;
  body?: Node;
  arguments?: readonly Node[];
  name?: Node;
  expression?: Node;
  argumentExpression?: Node;
  moduleSpecifier?: Node;
  importClause?: Node;
  namedBindings?: Node;
  elements?: readonly Node[];
  propertyName?: Node;
  isTypeOnly?: boolean;
  attributes?: Node;
  assertClause?: Node;
  modifiers?: readonly Node[];
  parameters?: readonly Node[];
  type?: Node;
};
function ast(node: Node): Ast {
  return node as Ast;
}
function word(node: Node | undefined): string {
  return node ? (ast(node).text ?? node.getText()) : '';
}

// All test mutations are virtual source files: no snippet is imported or evaluated.
function scanSources(entries: readonly { file: string; source: string }[], omitImportCheck = false): string[][] {
  const config = join(leaf, '__g7_inert_controls__/tsconfig.json');
  const files = entries.map((entry, index) => join(dirname(config), String(index), entry.file));
  const overlay = new Map(files.map((file, index) => [file, entries[index]!.source]));
  overlay.set(
    config,
    JSON.stringify({ compilerOptions: { target: 'es2024', module: 'nodenext', strict: true }, files }),
  );
  const api = new API({
    cwd: root,
    fs: {
      readFile: (path) => overlay.get(path),
      fileExists: (path) => (overlay.has(path) ? true : undefined),
      directoryExists: (path) => (path.startsWith(dirname(config)) ? true : undefined),
    },
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      assert.ok(project, 'pinned TypeScript API opens the virtual project');
      return files.map((path, index) => {
        const errors: string[] = [];
        const entry = entries[index]!;
        const row = permissions[entry.file];
        if (!row) return ['unlisted executable'];
        const source = project.program.getSourceFile(path);
        assert.ok(source, 'pinned TypeScript API supplies program source files');
        if (project.program.getSyntacticDiagnostics(path).length || project.program.getBindDiagnostics(path).length)
          errors.push('parse/bind');
        if (
          !source.statements.some(
            (statement) =>
              statement.kind === SyntaxKind.ImportDeclaration ||
              statement.kind === SyntaxKind.ExportDeclaration ||
              ast(statement).modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword),
          )
        )
          errors.push('non-module script');
        if (
          source.referencedFiles.length ||
          source.typeReferenceDirectives.length ||
          source.libReferenceDirectives.length
        )
          errors.push('triple-slash reference');
        function local(node: Node, shorthand: boolean): boolean {
          const symbol = shorthand
            ? project!.checker.getShorthandAssignmentValueSymbol(node.parent)
            : project!.checker.getSymbolAtLocation(node);
          return (
            !!symbol?.declarations.length &&
            symbol.declarations.every((declaration) => declaration.path === source!.path)
          );
        }
        let factoryCalls = 0;
        function walk(node: Node, erased = false): void {
          const value = ast(node);
          const typePosition =
            erased ||
            node.kind === SyntaxKind.InterfaceDeclaration ||
            node.kind === SyntaxKind.TypeAliasDeclaration ||
            (node.kind >= SyntaxKind.FirstTypeNode && node.kind <= SyntaxKind.LastTypeNode);
          if (node.kind === SyntaxKind.ImportDeclaration) {
            if (omitImportCheck) return;
            const specifier = word(value.moduleSpecifier);
            const bindings = ast(value.importClause ?? node);
            const named = bindings.namedBindings && ast(bindings.namedBindings);
            if (
              value.moduleSpecifier?.kind !== SyntaxKind.StringLiteral ||
              value.attributes ||
              value.assertClause ||
              !value.importClause ||
              bindings.name ||
              named?.kind !== SyntaxKind.NamedImports
            )
              errors.push('static named imports only');
            const allowed = row?.[specifier];
            if (!allowed) errors.push('unlisted import');
            if (specifier.startsWith('.')) {
              const target = resolve(leaf, specifier);
              if (
                dirname(target) !== leaf ||
                !permissions[relative(leaf, target)] ||
                specifier !== `./${relative(leaf, target)}`
              )
                errors.push('noncanonical relative edge');
            }
            for (const binding of named?.elements ?? []) {
              const part = ast(binding);
              const imported = word(part.propertyName ?? part.name);
              const typeOnly = bindings.isTypeOnly || part.isTypeOnly;
              if (
                entry.file === 'reader.ts' &&
                imported === 'productionReader' &&
                word(part.name) !== 'productionReader'
              )
                errors.push('reader delegate alias');
              if (!allowed?.includes(typeOnly ? `type:${imported}` : imported)) errors.push('unlisted binding');
            }
            return;
          }
          if (
            node.kind === SyntaxKind.ImportEqualsDeclaration ||
            node.kind === SyntaxKind.ImportType ||
            node.kind === SyntaxKind.ImportKeyword
          )
            errors.push('dynamic import or require');
          if (
            entry.file === 'reader.ts' &&
            node.kind === SyntaxKind.CallExpression &&
            word(value.expression) === 'productionReader'
          ) {
            factoryCalls++;
            const declaration = ast(node.parent);
            const list = declaration.parent;
            const statement = list.parent;
            const args = value.arguments ?? [];
            if (
              declaration.kind !== SyntaxKind.VariableDeclaration ||
              word(declaration.name) !== 'reader' ||
              list.kind !== SyntaxKind.VariableDeclarationList ||
              !/^const\s/.test(list.getText()) ||
              statement.parent !== source ||
              args.length !== 2 ||
              args.some((arg) => arg.kind !== SyntaxKind.StringLiteral) ||
              word(args[0]) !== 'benchmarks/failure-attribution/fixtures/manifest.json' ||
              !/^sha256:[a-f0-9]{64}$/.test(word(args[1]))
            )
              errors.push('reader factory must bind a code-pinned top-level constant');
          }
          if (node.kind === SyntaxKind.FunctionDeclaration && !value.body) errors.push('ambient function declaration');
          if (node.kind === SyntaxKind.ExportAssignment) errors.push('export assignment');
          if (node.kind === SyntaxKind.ExportDeclaration && (value.moduleSpecifier || node.getText() !== 'export {};'))
            errors.push('module re-export or alias');
          if (
            node.kind === SyntaxKind.DeclareKeyword ||
            value.modifiers?.some((modifier) => modifier.kind === SyntaxKind.DeclareKeyword) ||
            node.kind === SyntaxKind.ModuleDeclaration
          )
            errors.push('ambient declaration or augmentation');
          if (
            (node.kind === SyntaxKind.PropertyAccessExpression && word(value.name) === 'constructor') ||
            (node.kind === SyntaxKind.ElementAccessExpression &&
              value.argumentExpression &&
              [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral].includes(
                value.argumentExpression.kind,
              ) &&
              word(value.argumentExpression) === 'constructor')
          )
            errors.push('constructor access');
          if (node.kind === SyntaxKind.MetaProperty) {
            const parent = ast(node.parent);
            if (
              node.getText() !== 'import.meta' ||
              parent.kind !== SyntaxKind.PropertyAccessExpression ||
              parent.expression !== node ||
              !['url', 'dirname', 'filename'].includes(word(parent.name))
            )
              errors.push('meta access');
            return;
          }
          const exported = value.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword);
          if (
            exported &&
            entry.file === 'reader.ts' &&
            !['readTuneArtifact', 'readSealedInputs', 'SealedOptions', 'SealedInputs'].includes(word(value.name))
          )
            errors.push('unlisted production reader export');
          if (exported && entry.file === 'reader.ts' && node.kind === SyntaxKind.FunctionDeclaration) {
            const signatures: Record<string, string[]> = {
              readTuneArtifact: ['path:string', 'expectedStoredByteDigest?:string', '...unexpected:unknown[]'],
              readSealedInputs: ['options:SealedOptions', '...unexpected:unknown[]'],
            };
            const expected = signatures[word(value.name)];
            const actual = (value.parameters ?? []).map((parameter) => parameter.getText().replace(/\s+/g, ''));
            if (
              !expected ||
              actual.length !== expected.length ||
              actual.some((parameter, index) => parameter !== expected[index])
            )
              errors.push('reader production signature');
          }
          if (exported && entry.file.endsWith('.test.ts')) errors.push('test exports binding');
          if (
            exported &&
            entry.file === 'reader.ts' &&
            ![
              SyntaxKind.FunctionDeclaration,
              SyntaxKind.TypeAliasDeclaration,
              SyntaxKind.InterfaceDeclaration,
            ].includes(node.kind)
          )
            errors.push('reader exports core alias');
          if (
            entry.file === 'reader.ts' &&
            node.kind === SyntaxKind.Parameter &&
            /anchor|override/i.test(node.getText())
          )
            errors.push('reader anchor override');
          if (node.kind === SyntaxKind.Identifier && !typePosition) {
            const parent = ast(node.parent);
            const name = node.getText();
            const shorthand = parent.kind === SyntaxKind.ShorthandPropertyAssignment;
            const declarationOrPropertyName =
              (parent.name === node && !shorthand) ||
              (parent.kind === SyntaxKind.BindingElement && parent.propertyName === node);
            if (
              entry.file === 'reader.ts' &&
              !declarationOrPropertyName &&
              word(node) === 'reader' &&
              (parent.kind !== SyntaxKind.PropertyAccessExpression ||
                parent.expression !== node ||
                !['readArtifact', 'readSealed'].includes(word(parent.name)))
            )
              errors.push('reader binding escape');
            if (!declarationOrPropertyName && word(node) === 'require') errors.push('require reference');
            if (!declarationOrPropertyName && parent.kind !== SyntaxKind.QualifiedName && !local(node, shorthand)) {
              if (name === 'Math') {
                if (
                  parent.kind !== SyntaxKind.PropertyAccessExpression ||
                  parent.expression !== node ||
                  !math.has(word(parent.name))
                )
                  errors.push('ambient Math access');
              } else if (!globals.has(name)) errors.push(`free global: ${name}`);
            }
            if (
              !declarationOrPropertyName &&
              entry.file === 'reader.ts' &&
              name === 'productionReader' &&
              !(parent.kind === SyntaxKind.CallExpression && parent.expression === node)
            )
              errors.push('core delegate escape');
          }
          node.forEachChild((child) => {
            walk(child, typePosition);
          });
        }
        walk(source);
        if (entry.file === 'reader.ts' && factoryCalls !== 1)
          errors.push('reader must bind exactly one production factory');
        return errors;
      });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function inventory(
  path: string,
  names: (path: string) => string[] = readdirSync,
  inspect: (path: string) => { isSymbolicLink(): boolean; isDirectory(): boolean } = lstatSync,
): string[] {
  const out: string[] = [];
  for (const name of names(path)) {
    const full = join(path, name);
    const stat = inspect(full);
    assert.ok(!stat.isSymbolicLink(), `symlinked leaf entry: ${relative(leaf, full)}`);
    if (stat.isDirectory()) out.push(...inventory(full, names, inspect));
    else if (!/\.(?:md|json|jsonl)$/.test(name)) out.push(relative(leaf, full).split(sep).join('/'));
  }
  return out.sort();
}

function refuse(entries: readonly { file: string; source: string }[]): void {
  const results = scanSources(entries);
  for (const [index, errors] of results.entries())
    assert.ok(errors.length > 0, `accepted negative ${index}: ${entries[index]!.source}`);
}

test('G7-T14: G7 leaf imports only allowlisted public Gauge/Weft/built-in specifiers', () => {
  for (const row of Object.values(permissions))
    for (const specifier of Object.keys(row)) assert.ok(!forbiddenBuiltins.includes(specifier));
  assert.deepEqual(inventory(leaf), Object.keys(permissions).sort());
  const files = Object.keys(permissions);
  assert.deepEqual(
    scanSources(files.map((file) => ({ file, source: readFileSync(join(leaf, file), 'utf8') }))),
    files.map(() => []),
  );
});

test('10: exact static module edges and bindings reject prefix and type-only bypasses', () => {
  // Assemble this inert negative so the repository's text-only direction check
  // does not mistake its quoted package-internal edge for an executable import.
  const packageInternal = '../../packages/gauge/src/types.ts';
  const sources = [
    "import type {State} from '@weave/weave'; export {};",
    "import {open} from '@weave/weft/sqlite'; export {};",
    ...[
      '@weave/gateway',
      '@weave/agentfabric',
      '@weave/agentsop',
      '@weave/weave/internal',
      'unlisted',
      'fs',
      'node:vm',
    ].map((spec) => `import type {X} from '${spec}'; export {};`),
    `import {X} from '${packageInternal}'; export {};`,
    "import {X} from '../elsewhere.ts'; export {};",
    "import * as fs from 'node:fs'; export {};",
    "import fs from 'node:fs'; export {};",
    "import {writeFileSync} from 'node:fs'; export {};",
    "import {isDigest} from '@weave/weft' with {type:'json'}; export {};",
    "import data from './fixtures/manifest.json' with {type:'json'}; export {};",
    "export {isDigest} from '@weave/weft';",
    'export const = ;',
    'export {}; let same; let same;',
    "export type Hidden = import('@weave/weave').State;",
    "export type Hidden = typeof import('node:vm');",
    'export const require = ()=>1; export const x = require();',
  ];
  refuse(sources.map((source) => ({ file: 'reader-core.ts', source })));
  const controls = [
    { file: 'reader-core.ts', source: "import {isDigest} from '@weave/weft'; export const ok = isDigest('x');" },
    {
      file: 'sealed-labels.ts',
      source: "import type {AttributionCategory} from '@weave/gauge'; export type C = AttributionCategory;",
    },
    {
      file: 'stored-byte-digest.ts',
      source: "import {createHash as hash} from 'node:crypto'; export const h = hash('sha256');",
    },
  ];
  assert.deepEqual(
    scanSources(controls),
    controls.map(() => []),
  );
  for (const file of [
    'report.ts',
    'fixtures/child.mjs',
    'child.mts',
    'child.cts',
    'child.tsx',
    'child.js',
    'child.cjs',
    'child.jsx',
    'child.d.ts',
  ])
    refuse([{ file, source: 'export {};' }]);
  const extensions = ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'd.ts', 'sh', 'py', 'wasm'];
  const planted = extensions.map((ext) => `planted.${ext}`);
  const names = (path: string) => (path === leaf ? [...planted, 'fixtures'] : planted);
  const inspect = (path: string) => ({
    isSymbolicLink: () => false,
    isDirectory: () => path === join(leaf, 'fixtures'),
  });
  assert.deepEqual(inventory(leaf, names, inspect), [...planted, ...planted.map((name) => `fixtures/${name}`)].sort());
  for (const name of inventory(leaf, names, inspect)) assert.ok(!permissions[name]);
  for (const target of ['reader-core.ts', 'fixtures']) {
    assert.throws(
      () =>
        inventory(
          leaf,
          () => [target],
          () => ({ isSymbolicLink: () => true, isDirectory: () => target === 'fixtures' }),
        ),
      { name: 'AssertionError' },
    );
  }
  // A controlled checker mutation that omits exact import enforcement accepts both negatives.
  const negatives = sources.slice(0, 2).map((source) => ({ file: 'reader-core.ts', source }));
  assert.throws(
    () => {
      for (const errors of scanSources(negatives, true))
        assert.ok(errors.length > 0, 'import-check mutation accepted negative');
    },
    { name: 'AssertionError' },
  );
});

test('11: non-test leaf code cannot call the core verifier', () => {
  refuse([
    { file: 'label-harness.ts', source: "import {createTestReader} from './reader-core.ts'; export {};" },
    { file: 'sealed-labels.ts', source: "export const x = import('./reader-core.ts');" },
    { file: 'label-harness.ts', source: 'export const x = new Function(\'return import("./reader-core.ts")\');' },
    { file: 'label-harness.ts', source: "import {runInNewContext} from 'node:vm'; export {};" },
    { file: 'reader.ts', source: "export {productionReader as core} from './reader-core.ts';" },
    {
      file: 'reader.ts',
      source: "import {productionReader} from './reader-core.ts'; export const core = productionReader;",
    },
    { file: 'reader.ts', source: 'export function read(anchor: string){return anchor;}' },
    { file: 'reader.ts', source: 'export function read(options: {anchor:string}){return options.anchor;}' },
    {
      file: 'reader.ts',
      source:
        "import {productionReader as delegate} from './reader-core.ts'; export function readTuneArtifact(path:string, x:string){return delegate('benchmarks/failure-attribution/fixtures/manifest.json', x).readArtifact(path);}",
    },
    {
      file: 'reader.ts',
      source:
        "import {productionReader} from './reader-core.ts'; export function readTuneArtifact(path:string, x:string){return productionReader('benchmarks/failure-attribution/fixtures/manifest.json', x).readArtifact(path);}",
    },
    {
      file: 'reader.ts',
      source:
        "import {productionReader as delegate} from './reader-core.ts'; const reader = delegate('benchmarks/failure-attribution/fixtures/manifest.json', 'sha256:'+'0'.repeat(64)); export function readTuneArtifact(path:string, expectedStoredByteDigest?:string,...unexpected:unknown[]){return reader.readArtifact(path);}",
    },
    {
      file: 'reader.ts',
      source:
        "import {productionReader} from './reader-core.ts'; const x='sha256:'+'0'.repeat(64); const reader=productionReader('benchmarks/failure-attribution/fixtures/manifest.json', x); export function readTuneArtifact(path:string, expectedStoredByteDigest?:string,...unexpected:unknown[]){return reader.readArtifact(path);}",
    },
    { file: 'reader.test.ts', source: "import {createTestReader} from './reader-core.ts'; export {createTestReader};" },
    { file: 'reader.test.ts', source: "import {productionReader} from './reader-core.ts'; export {};" },
    { file: 'sealed-labels.ts', source: "import {readFileSync} from 'node:fs'; export {};" },
    { file: 'report.ts', source: "import {readFile} from 'node:fs/promises'; export {};" },
    { file: 'label-harness.ts', source: "import {fixture} from './reader.test.ts'; export {};" },
    { file: 'label-harness.ts', source: "import {fixture} from './test-children/child.ts'; export {};" },
  ]);
  const wrapper = readFileSync(join(leaf, 'reader.ts'), 'utf8');
  const mutations = [
    wrapper.replace(/expectedStoredByteDigest/g, 'x'),
    wrapper.replace('...unexpected: unknown[]', '...unexpected: string[]'),
    wrapper
      .replace('{ productionReader }', '{ productionReader as delegate }')
      .replace('= productionReader(', '= delegate('),
    wrapper.replace(/'sha256:[a-f0-9]{64}'/, (literal) => `String(${literal})`),
    wrapper.replace('const reader = productionReader(', 'let reader = productionReader('),
    wrapper.replace('return reader.readArtifact(path, expectedStoredByteDigest);', 'return reader;'),
    wrapper.replace(
      'benchmarks/failure-attribution/fixtures/manifest.json',
      'benchmarks/failure-attribution/fixtures/other.json',
    ),
  ];
  for (const mutation of mutations) assert.notEqual(mutation, wrapper, 'reader mutation was applied');
  refuse(mutations.map((source) => ({ file: 'reader.ts', source })));
  assert.deepEqual(scanSources([{ file: 'reader.ts', source: wrapper }]), [[]]);
  const allowed = [
    {
      file: 'reader.test.ts',
      source: "import {createTestReader} from './reader-core.ts'; const x = createTestReader; export {};",
    },
  ];
  assert.deepEqual(scanSources(allowed), [[]]);
});

test('12: closed globals use lexical declarations, including nested and shorthand values', () => {
  const sources = [
    'export const x = process.getBuiltinModule("node:vm");',
    'export const x = Reflect.construct(Function, []);',
    'export const x = fetch("https://inert.invalid");',
    'export const x = process.env.KEY;',
    'export const x = setTimeout(()=>{}, 1);',
    'export const x = queueMicrotask(()=>{});',
    'export const x = Date.now();',
    'export const x = performance.now();',
    'export const x = crypto.getRandomValues([]);',
    'export const x = Math.random();',
    'export const x = Math["abs"](-1);',
    'export const x = Math;',
    'export const {abs} = Math;',
    'export const x = import.meta.env;',
    'export const x = import.meta.resolve("x");',
    'export const x = (()=>{}).constructor;',
    'export const x = (()=>{})["constructor"];',
    'export const x = (()=>{})?.constructor;',
    'export const x = (()=>{})?.["constructor"];',
    'export const x = (()=>{})[`constructor`];',
    'export const x = (()=>{})["constr\\u0075ctor"];',
    'export const x = (()=>{}).constr\\u0075ctor;',
    'export function process(): unknown; export const x = process();',
    'declare const process: {env: {KEY:string}}; export const x = process.env.KEY;',
    'export {}; declare global {const process: unknown;}',
    'export {}; declare type Hidden = string;',
    '/// <reference types="node"/>\nexport {};',
    'const x = JSON.parse("{}");',
    'export function f(){return ()=>process.env.KEY;}',
    'export const row = {process};',
    'export const row = {eval};',
  ];
  refuse(sources.map((source) => ({ file: 'label-harness.ts', source })));
  const controls = [
    'export const x = JSON.stringify(new Map());',
    'export const x = Math.abs(-1) + Math.ceil(1) + Math.floor(1) + Math.max(1) + Math.min(1) + Math.round(1) + Math.trunc(1);',
    'export function f(process: {env:string}){return {process, value:process.env};}',
    'export function f(row: Record<string,string>, field:string){return row[field];}',
    'export type T = {process:string; Date:string}; export const row = {process:1, Date:2};',
    'export function f(){const fetch = ()=>1; return fetch();}',
    'export const url = import.meta.url;',
    'export function f(row: {process:string}){const {process: renamed}=row;return renamed;}',
    'export function f(Math: {random:()=>number}){return Math.random();}',
  ];
  assert.deepEqual(
    scanSources(controls.map((source) => ({ file: 'label-harness.ts', source }))),
    controls.map(() => []),
  );
});

test('13: computed-key Function construction throws EvalError', () => {
  const key = ['con', 'structor'].join('');
  const callable = (() => {}) as unknown as Record<string, (source: string) => () => number>;
  assert.throws(() => callable[key]!('return 1')(), { name: 'EvalError' });
});
