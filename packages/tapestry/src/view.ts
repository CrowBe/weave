/**
 * `view.workspace@1` for the first slice: project availability, recorded
 * observations, and pending approvals. An omitted slice stays omitted.
 * Payloads, locators, and grants are not fields of this view.
 */
export const WORKSPACE_VIEW_ID = 'view.workspace@1' as const;

export const ATTACHMENT_KINDS = ['repository', 'document', 'artifact', 'capability', 'history'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface AttachmentIndex {
  readonly label: string;
  readonly kind: AttachmentKind;
}

export const PROVENANCE_ROLES = [
  'operator',
  'runtime',
  'host',
  'clock',
  'judgment',
  'untrusted',
] as const;
export type ProvenanceRole = (typeof PROVENANCE_ROLES)[number];

export type DisclosedValidation =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unknown' };

export interface DisclosedObservation {
  readonly sequence: number;
  readonly type: string;
  readonly provenance: ProvenanceRole;
  readonly validation: DisclosedValidation;
  readonly cause: number | string | null;
}

export interface DisclosedEffect {
  readonly mode: string;
  readonly resource: string;
}

export interface DisclosedApproval {
  readonly request_id: string;
  readonly sequence: number;
  readonly operation: string;
  readonly contract_revision: string;
  readonly destination: string;
  readonly effects: readonly DisclosedEffect[];
  readonly expected_revision: number;
  readonly reservation: { readonly actions: number; readonly judgments: number };
  readonly valid_from_tick: number;
  readonly valid_until_tick: number;
  readonly binding_digest: string;
  readonly report_digest: string;
}

export type Disclosure<T> =
  | { readonly status: 'disclosed'; readonly items: readonly T[]; readonly truncated: boolean }
  | { readonly status: 'omitted'; readonly reason: string };

export type NamedDisclosure =
  | { readonly status: 'disclosed'; readonly name: string }
  | { readonly status: 'omitted'; readonly reason: string };

export interface WorkspaceView {
  readonly id: typeof WORKSPACE_VIEW_ID;
  readonly revision: number;
  readonly project_name: NamedDisclosure;
  readonly availability: Disclosure<AttachmentIndex>;
  readonly observations: Disclosure<DisclosedObservation>;
  readonly approvals: Disclosure<DisclosedApproval>;
}

export function withheld(slice: string, reason: string): string {
  return `Withheld: ${slice} (${reason})`;
}
