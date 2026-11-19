// FU3 document lint, test-only. Source resolution is against tracked child-base
// paths; positions come from TypeScript AST getStart(), never comment text.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/async';
export const git = async (...args: string[]) =>
  (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })).stdout;

export const root = resolve(import.meta.dirname, '../../../..');
export const tracked = (await git('ls-files', '-z')).split('\0').filter(Boolean);
export const plan = readFileSync(resolve(root, '_plan/PLAN.md'), 'utf8');
export const contract = readFileSync(resolve(root, 'packages/weave/src/CONTEXT-BUDGET-CONTRACT.md'), 'utf8');
const trees = new Map<string, ts.SourceFile>();
const api = new API({ cwd: root });
try {
  const paths = tracked.filter(
    (path) => path.endsWith('.ts') && (plan.includes(path) || plan.includes(basename(path)) || contract.includes(path)),
  );
  const snapshot = await api.updateSnapshot({ openFiles: paths.map((path) => resolve(root, path)) });
  for (const path of paths) {
    const absolute = resolve(root, path);
    const project = await snapshot.getDefaultProjectForFile(absolute);
    const tree = await project?.program.getSourceFile(absolute);
    if (!tree) throw new Error(`TypeScript AST unavailable: ${path}`);
    trees.set(path, tree);
  }
  await snapshot.dispose();
} finally {
  await api.close();
}

export interface ProseLine {
  text: string;
  line: number;
  section: number | null;
  closed: boolean;
}
export function prose(text: string): ProseLine[] {
  let fence: string | undefined;
  let section: number | null = null;
  let closed = false;
  const lines: ProseLine[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (line.startsWith('## ')) {
      const heading = /^## (\d+)\. Review disposition — /.exec(line);
      section = /^## (\d+)\./.exec(line)?.[1] ? Number(/^## (\d+)\./.exec(line)![1]) : null;
      closed = !!heading && Number(heading[1]) >= 14 && Number(heading[1]) < 29;
    }
    lines.push({ text: line, line: index + 1, section, closed });
  }
  return lines;
}
interface Source {
  ast: ts.SourceFile;
  declarations: { name: string; line: number; exported: boolean }[];
  calls: { callee: string; start: number; end: number; title?: string }[];
}
const sources = new Map<string, Source>();
export function source(path: string): Source {
  const cached = sources.get(path);
  if (cached) return cached;
  const tree = trees.get(path);
  if (!tree) throw new Error(`TypeScript AST unavailable for tracked path: ${path}`);
  const ast: ts.SourceFile = tree;
  const result: Source = { ast, declarations: [], calls: [] };
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      result.calls.push({
        callee: node.expression.getText(ast),
        start: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        end: ast.getLineAndCharacterOfPosition(node.end - 1).line + 1,
        ...(first && ts.isStringLiteralLikeNode(first) ? { title: first.text } : {}),
      });
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertyAssignment(node) ||
        node.kind === ts.SyntaxKind.MethodSignature ||
        node.kind === ts.SyntaxKind.PropertySignature) &&
      'name' in node &&
      node.name &&
      ts.isIdentifier(node.name as ts.Node)
    ) {
      const name = (node.name as ts.Identifier).text;
      const declaration = ts.isVariableDeclaration(node) ? node.parent.parent : node;
      const modifiers =
        'modifiers' in declaration ? (declaration.modifiers as readonly ts.Node[] | undefined) : undefined;
      const exported = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      result.declarations.push({
        name,
        line: ast.getLineAndCharacterOfPosition(declaration.getStart(ast)).line + 1,
        exported,
      });
    }
    node.forEachChild(visit);
  }
  visit(ast);
  sources.set(path, result);
  return result;
}
export function pathFor(pin: string, inherited?: string): string {
  if (!pin) {
    if (!inherited) throw new Error('missing inherited path');
    return inherited;
  }
  if (tracked.includes(pin)) return pin;
  const matches = tracked.filter((path) => path.endsWith('/' + pin));
  if (matches.length !== 1) throw new Error(`unresolved/ambiguous tracked path ${pin}`);
  return matches[0]!;
}
const shortName = (symbol: string) => symbol.split('.').at(-1)!;
export function checkDeclaration(path: string, symbol: string, line: number, closed = false): string[] {
  try {
    const src = source(pathFor(path));
    const matches = src.declarations.filter((declaration) => declaration.name === shortName(symbol));
    return matches.some((declaration) => closed || declaration.line === line) ||
      (closed && src.calls.some((call) => call.callee === symbol))
      ? []
      : [`${path}:${line}: declaration ${symbol}`];
  } catch (error) {
    return [String(error)];
  }
}
export function checkCall(path: string, callee: string, start: number, end?: number, closed = false): string[] {
  if (!path.includes('/') || !tracked.includes(path)) return [`unresolved full tracked path ${path}`];
  try {
    const src = source(path);
    const found = closed
      ? src.calls.some((call) => call.callee === callee) ||
        src.declarations.some((decl) => decl.name === shortName(callee))
      : src.calls.some(
          (call) => call.callee === callee && call.start === start && (end === undefined || call.end === end),
        );
    return found ? [] : [`${path}:${start}${end ? `-${end}` : ''}: call ${callee}`];
  } catch (error) {
    return [String(error)];
  }
}
export function checkTest(path: string, title: string, line: number, closed = false): string[] {
  try {
    return source(pathFor(path)).calls.some(
      (call) => /^(test|it)$/.test(call.callee) && call.title === title && (closed || call.start === line),
    )
      ? []
      : [`${path}:${line}: test title ${title}`];
  } catch (error) {
    return [String(error)];
  }
}
const labelled = /`([^`]+)`\s+\(call (at|range) `([^`]+)`\)/g;
const legacy = '`stillAuthorized` (`:1399`, call at `:1802`)';
const legacyRow = plan.split('\n').find((line) => line.startsWith('| Drain stale-authority branch'))!;
export function callPins(doc: string): { pins: string[]; errors: string[] } {
  const pins: string[] = [];
  const errors: string[] = [];
  const lines = prose(doc);
  for (const row of lines) {
    let line = row.text;
    if (line === legacyRow)
      line = line.replace(legacy, '`this.stillAuthorized` (call at `packages/weave/src/runtime.ts:1802`)');
    if (
      !row.closed &&
      (/\bcall\s+(?:at|range)\s*$/.test(line) ||
        (/\bcall\s*$/.test(line) && /^\s*(?:at|range)\b/.test(lines[lines.indexOf(row) + 1]?.text ?? '')))
    )
      errors.push(`${row.line}: wrapped call pin`);
    const matches = [...line.matchAll(labelled)];
    if (!row.closed && matches.length !== [...line.matchAll(/\bcall (?:at|range)\s+/g)].length)
      errors.push(`${row.line}: unverifiable labelled call syntax`);
    for (const pin of matches) {
      const [, callee, kind, location] = pin;
      const parsed = /^([^:]+):(\d+)(?:-(\d+))?$/.exec(location!);
      if (!parsed) {
        errors.push(`${row.line}: malformed call pin`);
        continue;
      }
      const [, path, start, end] = parsed;
      if (!row.closed) pins.push(`${path}|${callee}|${start}|${end ?? ''}`);
      if ((kind === 'range') !== !!end && !row.closed) errors.push(`${row.line}: call range shape`);
      errors.push(...checkCall(path!, callee!, Number(start), end ? Number(end) : undefined, row.closed));
    }
  }
  return { pins: pins.sort(), errors };
}

// Bare symbol groups are associated with their own parenthesized pin group.
// All remaining source navigation pins still get tracked-path resolution.
export function definitionPins(doc: string): { checked: number; errors: string[] } {
  const errors: string[] = [];
  let checked = 0;
  let inherited: string | undefined;
  let paragraph = '';
  let closed = false;
  function flush(): void {
    if (!paragraph) return;
    inherited = undefined;
    const groups = [
      ...paragraph.matchAll(/((?:`[\w.$]+`(?:\s*(?:,|and|\/)\s*|\s*))+?)\s*\(([^)]*`[^`]*:\d[^`]*`[^)]*)\)/g),
    ];
    for (const match of groups) {
      const earlier = paragraph.slice(0, match.index);
      const lastPath = [...earlier.matchAll(/`([^`\s:]+\.(?:ts|mjs|md|json)):\d[^`]*`/g)].at(-1)?.[1];
      if (lastPath) {
        try {
          inherited = pathFor(lastPath);
        } catch {
          /* The explicit pin is reported by the navigation pass below. */
        }
      }
      const symbols = [...match[1]!.matchAll(/`([^`]+)`/g)].map((part) => part[1]!);
      const body = match[2]!.split(';')[0]!;
      if (/call (?:at|range)/.test(body)) continue;
      const positions: { path: string; line: number; labelled: boolean }[] = [];
      for (const location of body.matchAll(/`([^`]*?):(\d+(?:[-,]\d+)*)`/g)) {
        try {
          if (!location[1] && !inherited) {
            errors.push(`unresolved inherited pin ${location[0]}`);
            continue;
          }
          const path = pathFor(location[1]!, inherited);
          inherited = path;
          const labelledUse = /(?:\bat\s+|\bbranch\s+|\bassignment\s+)/.test(body.slice(0, location.index));
          for (const number of location[2]!.split(','))
            positions.push({ path, line: Number(number.split('-')[0]), labelled: labelledUse });
        } catch (error) {
          errors.push(String(error));
        }
      }
      if (closed) {
        for (const symbol of symbols.filter((name) => /^(?:[A-Z]\w*\.)?[A-Za-z_$]\w*$/.test(name))) {
          const candidates = positions.filter((pin) => pin.path.endsWith('.ts'));
          if (
            candidates.length &&
            !candidates.some((pin) => checkDeclaration(pin.path, symbol, pin.line, true).length === 0)
          )
            errors.push(`historical symbol ${symbol} missing in ${candidates.map((pin) => pin.path).join(', ')}`);
        }
        continue;
      }
      if (
        positions.length !== symbols.length &&
        /^`[^`]+\.ts:\d/.test(body.trim()) &&
        symbols.every((symbol) => /^(?:[A-Z]\w*\.)?[A-Za-z_$]\w*$/.test(symbol))
      )
        errors.push(`unmatched grouped definitions: ${symbols.join(', ')}`);
      if (positions.length === symbols.length) {
        for (const [index, symbol] of symbols.entries()) {
          const pin = positions[index]!;
          if (
            !pin.path.endsWith('.ts') ||
            pin.labelled ||
            /:\d+-\d+/.test(body) ||
            !/^`[^`]+\.(?:ts|mjs):\d/.test(body.trim()) ||
            !/^(?:[A-Z]\w*\.)?[A-Za-z_$]\w*$/.test(symbol)
          )
            continue;
          checked++;
          errors.push(...checkDeclaration(pin.path, symbol, pin.line, closed));
        }
      }
    }
    for (const testPin of paragraph.matchAll(/`test` declarations? at `([^`]+\.ts):(\d+(?:,\d+)*)`/g)) {
      try {
        const path = pathFor(testPin[1]!);
        const before = paragraph.slice(0, testPin.index);
        const titles = [...before.matchAll(/`([^`]+)`/g)]
          .map((match) => match[1]!)
          .filter((title) => title.includes(' '));
        const numbers = testPin[2]!.split(',').map(Number);
        const named = titles.slice(-numbers.length);
        if (named.length !== numbers.length) errors.push(`missing test title at ${path}`);
        else
          for (const [index, title] of named.entries()) errors.push(...checkTest(path, title, numbers[index]!, closed));
      } catch (error) {
        errors.push(String(error));
      }
    }
    // Resolve all explicit navigation paths, even in review history. External
    // operator paths and historical PLAN.md citations are not source pins.
    for (const pin of paragraph.matchAll(/`([^`\s:]+\.(?:ts|mjs|md|json)):(\d[^`]*)`/g)) {
      if (pin[1] === 'PLAN.md' || pin[1]!.includes(':')) continue;
      try {
        pathFor(pin[1]!);
      } catch (error) {
        errors.push(String(error));
      }
    }
    for (const pin of paragraph.matchAll(
      /\b((?:packages|benchmarks|checks|scripts)\/[\w./-]+\.(?:ts|mjs|md|json)):\d+/g,
    )) {
      try {
        pathFor(pin[1]!);
      } catch (error) {
        errors.push(String(error));
      }
    }
    paragraph = '';
  }
  for (const row of prose(doc)) {
    if (!row.text.trim() || row.text.startsWith('#') || row.text.startsWith('|')) flush();
    closed = row.closed;
    paragraph += `${row.text}\n`;
    if (row.text.startsWith('|')) flush();
  }
  flush();
  return { checked, errors: [...new Set(errors)] };
}

export function w2Present(doc: string): boolean {
  return ['### 2.7 ', '### 5.5 '].every((scope) => {
    const body = doc.split(scope)[1]?.split('\n##')[0] ?? '';
    return [
      ['renderFrameView', 1236],
      ['this.frameGoal', 2545],
      ['this.abandonUnrecordedInferences', 1846],
    ].every(([symbol, line]) => body.includes(`\`${symbol}\` (call at \`packages/weave/src/runtime.ts:${line}\`)`));
  });
}
