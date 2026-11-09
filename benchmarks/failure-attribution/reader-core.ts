import { openSync, fstatSync, readSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isDigest } from '@weave/weft';
import { recordDigest } from '@weave/gauge';
import { storedByteDigest } from './stored-byte-digest.ts';

type Role = 'holdout-input' | 'holdout-digest' | 'sealed-label' | 'tune' | 'schema' | 'snapshot' | 'parity';
type ArtifactEntry = { path: string; role: Exclude<Role, 'sealed-label'>; storedByteDigest: string };
type LabelEntry = { role: 'sealed-label'; storedByteDigest: string };
type Entry = ArtifactEntry | LabelEntry;
type SealedOptions = { sealedLabelPath: string; sealedLabelDigest: string; holdoutSetDigest: string };
const roles = new Set(['holdout-input', 'holdout-digest', 'sealed-label', 'tune', 'schema', 'snapshot', 'parity']);
const reservedSnapshot = 'benchmarks/failure-attribution/fixtures/weft-snapshot.jsonl';
const maxBytes = 8 * 1024 * 1024;
function fail(code: string): never {
  throw new Error(`g7-reader: ${code}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function canonicalPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length < 1024 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && isDigest(value);
}

// JSON.parse collapses duplicate keys. Check tokens before that collapse, including escaped key spelling.
function rejectDuplicateKeys(text: string): void {
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '{') stack.push(new Set());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = i;
      i++;
      for (; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      const current = stack[stack.length - 1];
      if (text[next] === ':' && current) {
        const key: unknown = JSON.parse(text.slice(start, i + 1));
        if (typeof key !== 'string' || current.has(key)) fail('duplicate manifest key');
        current.add(key);
      }
    }
  }
}
function parse(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    rejectDuplicateKeys(text);
    return JSON.parse(text) as unknown;
  } catch {
    return fail('malformed data');
  }
}

// No symlink component is admitted, even when its present target happens to be inside the root.
function checkedTarget(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail('noncanonical target');
  const components: string[] = [];
  let cursor = path;
  while (dirname(cursor) !== cursor) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  for (const component of components.reverse()) {
    if (lstatSync(component).isSymbolicLink()) fail('symlink target');
  }
  if (realpathSync(path) !== path) fail('target alias');
  return path;
}
function readOnce(path: string): Uint8Array {
  try {
    const target = checkedTarget(path);
    const expected = lstatSync(target);
    if (!expected.isFile()) fail('non-file target');
    const fd = openSync(target, 'r');
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.size > maxBytes)
        fail('descriptor mismatch');
      const bytes = new Uint8Array(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) fail('truncated data');
        offset += count;
      }
      const after = fstatSync(fd);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        readSync(fd, new Uint8Array(1), 0, 1, offset) !== 0
      )
        fail('changed data');
      // The caller verifies and returns this exact buffer; there is no second unchecked path read.
      return bytes;
    } finally {
      closeSync(fd);
    }
  } catch {
    return fail('unreadable data');
  }
}
function readPinned(path: string, pin: string): Uint8Array {
  const bytes = readOnce(path);
  if (storedByteDigest(bytes) !== pin) fail('stored-byte mismatch');
  return bytes;
}
function verifiedManifest(root: string, manifestPath: string, anchor: string): Entry[] {
  if (!digest(anchor)) fail('manifest anchor format');
  if (!canonicalPath(manifestPath)) fail('manifest path');
  const bytes = readOnce(resolve(root, manifestPath));
  if (storedByteDigest(bytes) !== anchor) fail('manifest anchor mismatch');
  const envelope = parse(bytes);
  if (!record(envelope) || !keys(envelope, ['entries']) || !Array.isArray(envelope.entries)) fail('manifest envelope');
  const paths = new Set<string>();
  const entries: Entry[] = [];
  for (const row of envelope.entries as unknown[]) {
    if (!record(row) || typeof row.role !== 'string' || !roles.has(row.role) || !digest(row.storedByteDigest))
      fail('manifest entry');
    if (row.role === 'sealed-label') {
      if (!keys(row, ['role', 'storedByteDigest'])) fail('sealed-label entry');
      entries.push({ role: row.role, storedByteDigest: row.storedByteDigest });
    } else {
      if (!keys(row, ['path', 'role', 'storedByteDigest']) || !canonicalPath(row.path) || paths.has(row.path))
        fail('manifest path identity');
      paths.add(row.path);
      entries.push({ path: row.path, role: row.role as ArtifactEntry['role'], storedByteDigest: row.storedByteDigest });
    }
  }
  return entries;
}
function isArtifact(entry: Entry): entry is ArtifactEntry {
  return entry.role !== 'sealed-label';
}
function hasSnapshot(value: unknown, snapshotPaths: readonly string[]): boolean {
  if (typeof value === 'string')
    return snapshotPaths.some((path) => value === path || value.startsWith(`${path}#`) || value.startsWith(`${path}:`));
  if (Array.isArray(value)) return value.some((item: unknown) => hasSnapshot(item, snapshotPaths));
  if (record(value))
    return value.role === 'snapshot' || Object.values(value).some((item) => hasSnapshot(item, snapshotPaths));
  return false;
}
function reader(root: string, manifestPath: string, anchor: string) {
  function readArtifact(path: string, expectedStoredByteDigest?: string): Uint8Array {
    const entries = verifiedManifest(root, manifestPath, anchor);
    if (!canonicalPath(path)) fail('artifact path');
    const entry = entries.filter(isArtifact).find((row) => row.path === path);
    if (!entry || entry.role === 'holdout-input' || entry.role === 'holdout-digest')
      fail('undeclared development input');
    if (
      expectedStoredByteDigest !== undefined &&
      (!digest(expectedStoredByteDigest) || expectedStoredByteDigest !== entry.storedByteDigest)
    )
      fail('descriptor pin mismatch');
    return readPinned(resolve(root, entry.path), entry.storedByteDigest);
  }
  function readSealed(options: SealedOptions) {
    const entries = verifiedManifest(root, manifestPath, anchor);
    const inputs = entries.filter(isArtifact).filter((entry) => entry.role === 'holdout-input');
    const holdoutSetDigests = entries.filter(isArtifact).filter((entry) => entry.role === 'holdout-digest');
    const labels = entries.filter((entry) => entry.role === 'sealed-label');
    // Cardinality is checked first. A tune-only manifest cannot be opened by supplying syntactically valid pins.
    if (inputs.length === 0 || holdoutSetDigests.length === 0 || labels.length !== 1) fail('missing freeze');
    if (!record(options) || !keys(options, ['sealedLabelPath', 'sealedLabelDigest', 'holdoutSetDigest']))
      fail('sealed options');
    if (!digest(options.sealedLabelDigest) || !digest(options.holdoutSetDigest)) fail('independent digest format');
    const label = labels[0]!;
    if (options.sealedLabelDigest !== label.storedByteDigest) fail('independent sealed-label mismatch');
    const compact = (rows: ArtifactEntry[]) =>
      rows
        .map(({ path, storedByteDigest }) => ({ path, storedByteDigest }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path === b.path ? 0 : 1));
    const holdoutSetDigest = recordDigest({
      domain: 'gauge.holdout-set@1',
      inputs: compact(inputs),
      holdoutSetDigests: compact(holdoutSetDigests),
      sealedLabelDigest: label.storedByteDigest,
    });
    if (options.holdoutSetDigest !== holdoutSetDigest) fail('independent holdout-set mismatch');
    if (typeof options.sealedLabelPath !== 'string') fail('sealed path');
    const snapshotPaths = [
      reservedSnapshot,
      ...entries
        .filter(isArtifact)
        .filter((entry) => entry.role === 'snapshot')
        .map((entry) => entry.path),
    ];
    const load = (entry: ArtifactEntry) => {
      if (snapshotPaths.includes(entry.path)) fail('snapshot-backed evidence');
      const bytes = readPinned(resolve(root, entry.path), entry.storedByteDigest);
      if (hasSnapshot(parse(bytes), snapshotPaths)) fail('snapshot-backed evidence');
      return { path: entry.path, bytes };
    };
    const verifiedInputs = inputs.map(load);
    const verifiedDigests = holdoutSetDigests.map(load);
    const verifiedLabels = readPinned(options.sealedLabelPath, label.storedByteDigest);
    // Refuse malformed external bytes here too; semantic label validation belongs to sealed-labels.ts.
    parse(verifiedLabels);
    return { inputs: verifiedInputs, holdoutSetDigests: verifiedDigests, labels: verifiedLabels };
  }
  return { readArtifact, readSealed };
}

/** Sole synthetic-anchor entry; only exact reader.test.ts may import this binding. */
export function createTestReader(root: string, manifestPath: string, anchor: string) {
  return reader(resolve(root), manifestPath, anchor);
}

/** Production wrapper binds path/anchor as constants; no caller-supplied anchor is forwarded. */
export function productionReader(manifestPath: string, anchor: string) {
  return reader(resolve(import.meta.dirname, '../..'), manifestPath, anchor);
}
