import type { ComponentNode, SessionRecord } from './session.js';
import {
  withheld,
  type AttachmentIndex,
  type DisclosedApproval,
  type DisclosedObservation,
  type WorkspaceView,
} from './view.js';
import { EMPTY_TEXT, VOCABULARY_ID, type AdaptiveRegion } from './vocabulary.js';

export type RegionNode =
  | ComponentNode
  | { readonly component: 'collapsed' }
  | { readonly component: 'empty'; readonly text: string };

export interface ComponentTree {
  readonly vocabulary: typeof VOCABULARY_ID;
  readonly revision: number;
  readonly regions: {
    readonly nav: RegionNode;
    readonly 'main.primary': RegionNode;
    readonly 'main.bottom': RegionNode;
    readonly 'right.drawer': RegionNode;
    readonly 'cut-through': readonly ComponentNode[];
  };
}

export type Presentation =
  | { readonly kind: 'index'; readonly items: readonly AttachmentIndex[]; readonly selection: string | null }
  | { readonly kind: 'omitted'; readonly text: string }
  | {
      readonly kind: 'observations';
      readonly items: readonly DisclosedObservation[];
      readonly truncated: boolean;
      readonly input: 'unavailable';
    }
  | { readonly kind: 'approval'; readonly approval: DisclosedApproval; readonly decision: 'unavailable' }
  | { readonly kind: 'empty'; readonly text: string }
  | { readonly kind: 'collapsed' };

function nodeKey(node: ComponentNode): string {
  if (node.component === 'approval.pending@1') {
    if ('withheld' in node) return 'approval.pending@1:withheld';
    return `approval.pending@1:${node.request_id}`;
  }
  return node.component;
}

/**
 * Pure default tree. Pins, then placements, then the cut-through, then the
 * fresh-session occupants. Theme is not an input. A component occupies at
 * most one region, so a pin elsewhere cannot dismiss the cut-through and a
 * placement of one approval removes only that approval.
 */
export function resolveTree(view: WorkspaceView, session: SessionRecord): ComponentTree {
  const used = new Set<string>();
  const claim = (node: ComponentNode): boolean => {
    const key = nodeKey(node);
    if (used.has(key)) return false;
    used.add(key);
    return true;
  };

  const assigned: Partial<Record<AdaptiveRegion, RegionNode>> = {};
  for (const pin of session.pins) {
    if (assigned[pin.region]) continue;
    if (!claim(pin.node)) continue;
    assigned[pin.region] = pin.node;
  }
  for (const placement of session.placements) {
    if (assigned[placement.region]) continue;
    if (placement.node.component === 'collapsed') {
      assigned[placement.region] = placement.node;
      continue;
    }
    if (!claim(placement.node)) continue;
    assigned[placement.region] = placement.node;
  }

  const cut: ComponentNode[] = [];
  if (view.approvals.status === 'omitted') {
    const node: ComponentNode = { component: 'approval.pending@1', withheld: view.approvals.reason };
    if (claim(node)) cut.push(node);
  } else {
    const sorted = [...view.approvals.items].sort(
      (left, right) => left.sequence - right.sequence || left.request_id.localeCompare(right.request_id),
    );
    for (const item of sorted) {
      const node: ComponentNode = { component: 'approval.pending@1', request_id: item.request_id };
      if (claim(node)) cut.push(node);
    }
  }

  const fill = (region: AdaptiveRegion, fallback: RegionNode): RegionNode => {
    const existing = assigned[region];
    if (existing) return existing;
    if (fallback.component === 'collapsed' || fallback.component === 'empty') return fallback;
    if (!claim(fallback)) return { component: 'empty', text: EMPTY_TEXT[region] };
    return fallback;
  };

  return {
    vocabulary: VOCABULARY_ID,
    revision: view.revision,
    regions: {
      nav: fill('nav', { component: 'project.index@1' }),
      'main.primary': fill('main.primary', { component: 'conversation.thread@1' }),
      'main.bottom': fill('main.bottom', { component: 'empty', text: EMPTY_TEXT['main.bottom'] }),
      'right.drawer': fill('right.drawer', { component: 'collapsed' }),
      'cut-through': cut,
    },
  };
}

/** What a component shows for this view. Painting this result performs no runtime action. */
export function present(view: WorkspaceView, session: SessionRecord, node: RegionNode): Presentation {
  if (node.component === 'empty') return { kind: 'empty', text: node.text };
  if (node.component === 'collapsed') return { kind: 'collapsed' };
  if (node.component === 'project.index@1') {
    if (view.availability.status === 'omitted') {
      return { kind: 'omitted', text: withheld('availability', view.availability.reason) };
    }
    const labels = new Set(view.availability.items.map((item) => item.label));
    const selection = session.selection !== null && labels.has(session.selection) ? session.selection : null;
    return { kind: 'index', items: view.availability.items, selection };
  }
  if (node.component === 'conversation.thread@1') {
    if (view.observations.status === 'omitted') {
      return { kind: 'omitted', text: withheld('observations', view.observations.reason) };
    }
    return {
      kind: 'observations',
      items: view.observations.items,
      truncated: view.observations.truncated,
      input: 'unavailable',
    };
  }
  if ('withheld' in node) {
    return { kind: 'omitted', text: withheld('approvals', node.withheld) };
  }
  if (view.approvals.status === 'omitted') {
    return { kind: 'omitted', text: withheld('approvals', view.approvals.reason) };
  }
  const approval = view.approvals.items.find((item) => item.request_id === node.request_id);
  if (!approval) {
    return { kind: 'omitted', text: withheld('approvals', 'request not disclosed') };
  }
  return { kind: 'approval', approval, decision: 'unavailable' };
}
