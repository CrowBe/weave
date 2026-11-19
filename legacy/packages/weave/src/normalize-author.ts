/**
 * Scripted extension author for `text.normalize`.
 *
 * The composition that calls it is recorded data. This author proposes the
 * contract, the corpus, and the source. It does not admit and it does not
 * issue a grant.
 */
import type { CapabilityContract, DesiredOperation, ImplementerView, TestCase, TestSplit } from '@weave/agentsop';
import type { ExtensionAuthor } from './crystallize-actions.js';
import type { RecordedComposition } from './types.js';

export const NORMALIZE_CONTRACT: CapabilityContract = {
  id: 'text.normalize',
  revision: 'r1',
  purpose: 'Collapse whitespace in one text value',
  input: { text: 'string' },
  output: { text: 'string' },
  effects: [],
  permissions: [],
  failures: [],
  depends_on: [],
};

export const NORMALIZE_COMPOSITION: RecordedComposition = {
  id: 'composition.normalize-report@1',
  operation: 'text.normalize',
  purpose: NORMALIZE_CONTRACT.purpose,
  input: NORMALIZE_CONTRACT.input,
  output: NORMALIZE_CONTRACT.output,
  steps: ['source.inspect', 'text.normalize', 'report.assemble'],
  variants: ['direct', 'aliased'],
};

export const RETAINED_NORMALIZE_PROCEDURE =
  'Collapse internal whitespace and trim. This text is not an implementation.';

const DIRECT_SOURCE = `
var text = String(input.text).replace(/[ \\t\\n\\r\\f\\v]+/g, " ").trim();
return { text: text };
`;

const ALIASED_SOURCE = `
var collapsed = String(input.text).split(/[ \\t\\n\\r\\f\\v]+/).filter(function (part) { return part.length > 0; }).join(" ");
return { text: collapsed };
`;

const SOURCES: Readonly<Record<string, string>> = {
  direct: DIRECT_SOURCE,
  aliased: ALIASED_SOURCE,
};

export function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f\v]+/g, ' ').trim();
}

export function visibleNormalizeCases(): readonly TestCase[] {
  return [
    {
      id: 'visible-internal',
      split: 'visible',
      input: { text: 'a  b' },
      expected: { kind: 'output', output: { text: 'a b' } },
    },
    {
      id: 'visible-edges',
      split: 'visible',
      input: { text: '  a\nb  ' },
      expected: { kind: 'output', output: { text: 'a b' } },
    },
  ];
}

export function heldOutNormalizeCases(): readonly TestCase[] {
  return [
    {
      id: 'held-tab',
      split: 'held_out',
      input: { text: 'held\tvalue  unique' },
      expected: { kind: 'output', output: { text: 'held value unique' } },
    },
  ];
}

export function normalizeSource(variant: string): string {
  const source = SOURCES[variant];
  if (!source) {
    throw new Error(`unknown normalize variant ${variant}`);
  }
  return source;
}

export class ScriptedNormalizeAuthor implements ExtensionAuthor {
  readonly implementation = 'scripted-normalize@1';
  readonly calls: string[] = [];

  constructor(readonly variants: readonly string[] = ['direct', 'aliased']) {}

  proposeContract(desired: DesiredOperation): CapabilityContract {
    this.calls.push('contract');
    if (desired.operation !== NORMALIZE_CONTRACT.id) {
      throw new Error(`normalize author cannot propose ${desired.operation}`);
    }
    return NORMALIZE_CONTRACT;
  }

  proposeCases(split: TestSplit): readonly TestCase[] {
    this.calls.push(split);
    return split === 'visible' ? visibleNormalizeCases() : heldOutNormalizeCases();
  }

  proposeImplementation(variant: string, view: ImplementerView): { readonly source: string } {
    this.calls.push(`implementation:${variant}`);
    if (JSON.stringify(view).includes('held-tab') || JSON.stringify(view).includes('held value unique')) {
      throw new Error('held-out case leaked into the implementer view');
    }
    return { source: normalizeSource(variant) };
  }
}
