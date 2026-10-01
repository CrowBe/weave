import { themeById } from './theme.js';
import { VOCABULARY_ID, type AdaptiveRegion } from './vocabulary.js';

export type ComponentNode =
  | { readonly component: 'project.index@1' }
  | { readonly component: 'conversation.thread@1' }
  | { readonly component: 'approval.pending@1'; readonly request_id: string }
  | { readonly component: 'approval.pending@1'; readonly withheld: string };

export type PlacementNode = ComponentNode | { readonly component: 'collapsed' };

export interface Pin {
  readonly region: AdaptiveRegion;
  readonly node: ComponentNode;
}

export interface Placement {
  readonly region: AdaptiveRegion;
  readonly node: PlacementNode;
}

export interface SessionRecord {
  readonly session_id: string;
  readonly vocabulary: typeof VOCABULARY_ID;
  readonly theme_id: string;
  readonly selection: string | null;
  readonly pins: readonly Pin[];
  readonly placements: readonly Placement[];
  readonly ended: false | { readonly reason: string };
}

export function freshSession(session_id: string, theme_id = 'theme.weave-default'): SessionRecord {
  if (!themeById(theme_id)) {
    throw new Error(`unknown theme ${theme_id}`);
  }
  return {
    session_id,
    vocabulary: VOCABULARY_ID,
    theme_id,
    selection: null,
    pins: [],
    placements: [],
    ended: false,
  };
}

/** Theme is paint state. Changing it does not end the session or clear selection. */
export function changeTheme(session: SessionRecord, theme_id: string): SessionRecord {
  if (session.ended) {
    return session;
  }
  if (!themeById(theme_id)) {
    throw new Error(`unknown theme ${theme_id}`);
  }
  return { ...session, theme_id };
}

/** Selection is session state. It does not disclose a body or submit an observation. */
export function selectAttachment(session: SessionRecord, label: string | null): SessionRecord {
  if (session.ended) {
    return session;
  }
  return { ...session, selection: label };
}
