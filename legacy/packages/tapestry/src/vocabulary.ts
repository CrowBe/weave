/**
 * `vocabulary.workspace@1` for this slice. The closed set is the three
 * components below. Submission stays unbound until a trusted ingress
 * contract exists for that observation.
 */
export const VOCABULARY_ID = 'vocabulary.workspace@1' as const;

export const REGIONS = ['nav', 'main.primary', 'main.bottom', 'right.drawer', 'cut-through'] as const;
export type RegionId = (typeof REGIONS)[number];

export const ADAPTIVE_REGIONS = ['nav', 'main.primary', 'main.bottom', 'right.drawer'] as const;
export type AdaptiveRegion = (typeof ADAPTIVE_REGIONS)[number];

export interface UnboundSubmit {
  readonly type: 'operator.input' | 'approval.decided';
  readonly bound: false;
}

export interface VocabularyComponent {
  readonly id: 'project.index@1' | 'conversation.thread@1' | 'approval.pending@1';
  readonly regions: readonly RegionId[];
  readonly slices: readonly ('availability' | 'observations' | 'approvals')[];
  readonly submits: readonly UnboundSubmit[];
}

export const VOCABULARY = {
  id: VOCABULARY_ID,
  regions: REGIONS,
  components: [
    {
      id: 'project.index@1',
      regions: ['nav'],
      slices: ['availability'],
      submits: [],
    },
    {
      id: 'conversation.thread@1',
      regions: ['main.primary', 'main.bottom', 'right.drawer'],
      slices: ['observations'],
      submits: [{ type: 'operator.input', bound: false }],
    },
    {
      id: 'approval.pending@1',
      regions: ['cut-through', 'main.primary', 'main.bottom', 'right.drawer'],
      slices: ['approvals'],
      submits: [{ type: 'approval.decided', bound: false }],
    },
  ],
} as const satisfies {
  readonly id: typeof VOCABULARY_ID;
  readonly regions: typeof REGIONS;
  readonly components: readonly VocabularyComponent[];
};

export const EMPTY_TEXT = {
  nav: 'No attachments in navigation',
  'main.primary': 'Nothing on the main surface',
  'main.bottom': 'Nothing in the secondary strip',
  'right.drawer': 'Nothing in the drawer',
  'cut-through': 'No pending authority request',
} as const satisfies { readonly [Region in RegionId]: string };
