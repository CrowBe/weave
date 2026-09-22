/**
 * Scripted extension author for the report.fold fixture.
 *
 * Corpus expectations come from `canonicalFold`. Implementation source is a
 * separate string the lifecycle runs under isolation. Held-out cases are
 * proposed only when the split is requested; the implementer view is whatever
 * the lifecycle returns.
 */
import type { CapabilityContract, DesiredOperation, ImplementerView, TestCase, TestSplit } from '@weave/agentsop';
import type { ExtensionAuthor } from './crystallize-actions.js';

export const HELD_OUT_MARKER = 'held-digest-unique';

export const FOLD_CONTRACT: CapabilityContract = {
  id: 'report.fold',
  revision: 'r1',
  purpose: 'Fold inspection digests into one canonical digest',
  input: { inspections: '[InspectionResult]' },
  output: { fold: 'string' },
  effects: [],
  permissions: [],
  failures: ['empty_input', 'invalid_inspection'],
  depends_on: [],
};

export const RETAINED_FOLD_PROCEDURE =
  'Sort inspection rows by source, join source=digest with a bar, and prefix the digest with fold. This text is not an implementation.';

const DIRECT_SOURCE = `
if (!Array.isArray(input.inspections) || input.inspections.length === 0) {
  return { failure: "empty_input" };
}
var lines = [];
var index;
for (index = 0; index < input.inspections.length; index = index + 1) {
  var row = input.inspections[index];
  if (row === null || typeof row !== "object" || typeof row.source !== "string" || typeof row.digest !== "string" || row.digest.length === 0) {
    return { failure: "invalid_inspection" };
  }
  lines.push(row.source + "=" + row.digest);
}
lines.sort();
var folded = "fold";
var cursor;
for (cursor = 0; cursor < lines.length; cursor = cursor + 1) {
  folded = folded + "|" + lines[cursor];
}
return { fold: folded };
`;

const ALIASED_SOURCE = `
if (!Array.isArray(input.inspections) || input.inspections.length === 0) {
  return { failure: "empty_input" };
}
var parts = [];
var n;
for (n = 0; n < input.inspections.length; n = n + 1) {
  var item = input.inspections[n];
  if (item === null || typeof item !== "object" || typeof item.source !== "string" || typeof item.digest !== "string" || item.digest.length === 0) {
    return { failure: "invalid_inspection" };
  }
  parts.push(item.source + "=" + item.digest);
}
parts.sort();
var digest = "fold";
var k;
for (k = 0; k < parts.length; k = k + 1) {
  digest = digest + "|" + parts[k];
}
return { fold: digest };
`;

const SOURCES: Readonly<Record<string, string>> = {
  direct: DIRECT_SOURCE,
  aliased: ALIASED_SOURCE,
};

export function canonicalFold(inspections: readonly { source?: unknown; digest?: unknown }[]): { fold: string } | { failure: string } {
  if (inspections.length === 0) {
    return { failure: 'empty_input' };
  }
  const lines: string[] = [];
  for (const row of inspections) {
    if (!row || typeof row.source !== 'string' || typeof row.digest !== 'string' || row.digest.length === 0) {
      return { failure: 'invalid_inspection' };
    }
    lines.push(`${row.source}=${row.digest}`);
  }
  lines.sort();
  return { fold: `fold|${lines.join('|')}` };
}

export function visibleFoldCases(): TestCase[] {
  const pair = canonicalFold([
    { source: 'source:beta', digest: 'vis-digest-beta' },
    { source: 'source:alpha', digest: 'vis-digest-alpha' },
  ]);
  return [
    caseOf('vis-pair', 'visible', { inspections: [
      { source: 'source:beta', digest: 'vis-digest-beta' },
      { source: 'source:alpha', digest: 'vis-digest-alpha' },
    ] }, pair),
    caseOf('vis-empty', 'visible', { inspections: [] }, { failure: 'empty_input' }),
    caseOf('vis-bad', 'visible', { inspections: [{ source: 'source:alpha' }] }, { failure: 'invalid_inspection' }),
  ];
}

export function heldOutFoldCases(): TestCase[] {
  const three = canonicalFold([
    { source: 'source:gamma', digest: 'vis-digest-gamma' },
    { source: 'source:alpha', digest: 'vis-digest-alpha' },
    { source: 'source:held', digest: HELD_OUT_MARKER },
  ]);
  const one = canonicalFold([{ source: 'source:held', digest: HELD_OUT_MARKER }]);
  return [
    caseOf('hold-three', 'held_out', { inspections: [
      { source: 'source:gamma', digest: 'vis-digest-gamma' },
      { source: 'source:held', digest: HELD_OUT_MARKER },
      { source: 'source:alpha', digest: 'vis-digest-alpha' },
    ] }, three),
    caseOf('hold-one', 'held_out', { inspections: [{ source: 'source:held', digest: HELD_OUT_MARKER }] }, one),
    caseOf('hold-blank', 'held_out', { inspections: [{ source: 'source:held', digest: '' }] }, { failure: 'invalid_inspection' }),
  ];
}

export function foldSource(variant: string): string {
  const source = SOURCES[variant];
  if (!source) {
    throw new Error(`no fixture implementation ${variant}`);
  }
  return source;
}

export class ScriptedFoldAuthor implements ExtensionAuthor {
  readonly implementation = 'scripted-fold-author@1';
  readonly views: ImplementerView[] = [];
  readonly calls: string[] = [];

  constructor(readonly variants: readonly string[] = ['direct', 'aliased']) {}

  proposeContract(desired: DesiredOperation): CapabilityContract {
    this.calls.push('contract');
    if (desired.operation !== FOLD_CONTRACT.id) {
      throw new Error(`no fixture contract for ${desired.operation}`);
    }
    return FOLD_CONTRACT;
  }

  proposeCases(split: TestSplit): readonly TestCase[] {
    this.calls.push(`cases:${split}`);
    return split === 'visible' ? visibleFoldCases() : heldOutFoldCases();
  }

  proposeImplementation(variant: string, view: ImplementerView): { readonly source: string } {
    this.calls.push(`implementation:${variant}`);
    this.views.push(view);
    return { source: foldSource(variant) };
  }
}

function caseOf(
  id: string,
  split: TestSplit,
  input: unknown,
  result: { fold: string } | { failure: string },
): TestCase {
  if ('failure' in result) {
    return { id, split, input, expected: { kind: 'failure', code: result.failure } };
  }
  return { id, split, input, expected: { kind: 'output', output: result } };
}
