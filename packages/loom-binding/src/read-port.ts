import {
  ATTACHMENT_KINDS,
  WORKSPACE_VIEW_ID,
  type AttachmentIndex,
  type AttachmentKind,
  type Disclosure,
  type DisclosedApproval,
  type DisclosedEffect,
  type DisclosedObservation,
  type DisclosedValidation,
  type NamedDisclosure,
  type ProvenanceRole,
  type WorkspaceView,
} from '@weave/tapestry';
import type { ApprovalRecord, Observation, ProvenanceKind, State, Trace, Validation } from '@weave/weave';

/** Most recent observations copied into one workspace view. */
export const OBSERVATION_WINDOW = 24;

export interface ProjectAttachment {
  readonly label: string;
  readonly kind: AttachmentKind;
}

/** One attached project. Locators stay with the host; this record carries labels. */
export interface ProjectRecord {
  readonly project_id: string;
  readonly name: string;
  readonly attachments: readonly ProjectAttachment[];
}

export interface SliceOmission {
  readonly reason: string;
}

export interface DisclosurePolicy {
  readonly availability?: SliceOmission;
  readonly observations?: SliceOmission;
  readonly approvals?: SliceOmission;
}

/** Recorded Loom state. The binding does not accept a host or a locator table. */
export interface LoomRead {
  state(): State;
  trace(): Trace;
}

export interface ReadPort {
  readonly project_id: string;
  workspaceView(): WorkspaceView;
}

const LOCATOR = /[/\\]|:\/\//;

function copyToken(value: string): string | null {
  if (value.length === 0 || value.length > 256 || LOCATOR.test(value)) return null;
  return value;
}

function requireLabel(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120 || /[/\\:]/.test(trimmed)) {
    throw new Error(`refusing to disclose a locator in ${what}`);
  }
  return trimmed;
}

function provenanceRole(kind: ProvenanceKind): ProvenanceRole {
  switch (kind) {
    case 'operator':
    case 'runtime':
    case 'host':
    case 'clock':
      return kind;
    case 'judgment':
    case 'gateway':
      return 'judgment';
    case 'test':
      return 'untrusted';
    default:
      return 'untrusted';
  }
}

function validationOf(validation: Validation): DisclosedValidation {
  if (validation.status === 'accepted') return { status: 'accepted' };
  if (validation.status === 'unknown_type') return { status: 'unknown' };
  return { status: 'rejected', reason: copyToken(validation.reason) ?? 'withheld' };
}

function causeOf(caused_by: Observation['caused_by']): number | string | null {
  if (typeof caused_by === 'number') return caused_by;
  if (typeof caused_by === 'string') return copyToken(caused_by);
  return null;
}

function observationsOf(trace: Trace, omission: SliceOmission | undefined): Disclosure<DisclosedObservation> {
  if (omission) return { status: 'omitted', reason: omission.reason };
  const recent = trace.observations.slice(-OBSERVATION_WINDOW);
  const items: DisclosedObservation[] = [];
  for (const observation of recent) {
    const type = copyToken(observation.payload_type);
    if (!type) continue;
    items.push({
      sequence: observation.seq,
      type,
      provenance: provenanceRole(observation.source.kind),
      validation: validationOf(observation.validation),
      cause: causeOf(observation.caused_by),
    });
  }
  return {
    status: 'disclosed',
    items,
    truncated: trace.observations.length > OBSERVATION_WINDOW,
  };
}

function requestId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || !('request_id' in payload)) return null;
  const id = payload.request_id;
  return typeof id === 'string' ? id : null;
}

function sequenceFor(record: ApprovalRecord, observations: readonly Observation[]): number {
  for (const observation of observations) {
    if (observation.payload_type !== 'approval.requested') continue;
    if (requestId(observation.payload) !== record.request_id) continue;
    return observation.seq;
  }
  return record.evidence[0] ?? 0;
}

function approvalsOf(state: State, trace: Trace, omission: SliceOmission | undefined): Disclosure<DisclosedApproval> {
  if (omission) return { status: 'omitted', reason: omission.reason };
  const items: DisclosedApproval[] = [];
  for (const record of Object.values(state.approvals)) {
    if (record.status !== 'pending') continue;
    const request = record.request;
    const request_id = copyToken(request.request_id);
    const operation = copyToken(request.operation);
    const contract_revision = copyToken(request.contract_rev);
    const destination = copyToken(request.destination);
    const binding_digest = copyToken(request.binding_digest);
    const report_digest = copyToken(request.report_digest);
    if (!request_id || !operation || !contract_revision || !destination || !binding_digest || !report_digest) {
      continue;
    }
    const effects: DisclosedEffect[] = [];
    for (const effect of request.effects) {
      const mode = copyToken(effect.mode);
      const resource = copyToken(effect.resource);
      if (!mode || !resource) continue;
      effects.push({ mode, resource });
    }
    items.push({
      request_id,
      sequence: sequenceFor(record, trace.observations),
      operation,
      contract_revision,
      destination,
      effects,
      expected_revision: request.expected_revision,
      reservation: { actions: request.budget.actions, judgments: request.budget.judgments },
      valid_from_tick: request.valid_from_tick,
      valid_until_tick: request.valid_until_tick,
      binding_digest,
      report_digest,
    });
  }
  items.sort((left, right) => left.sequence - right.sequence || left.request_id.localeCompare(right.request_id));
  return { status: 'disclosed', items, truncated: false };
}

function availabilityOf(
  project: ProjectRecord,
  omission: SliceOmission | undefined,
): { readonly project_name: NamedDisclosure; readonly availability: Disclosure<AttachmentIndex> } {
  if (omission) {
    return {
      project_name: { status: 'omitted', reason: omission.reason },
      availability: { status: 'omitted', reason: omission.reason },
    };
  }
  const items = project.attachments.map((attachment) => {
    if (!(ATTACHMENT_KINDS as readonly string[]).includes(attachment.kind)) {
      throw new Error(`unknown attachment kind ${attachment.kind}`);
    }
    return { label: requireLabel(attachment.label, 'attachment label'), kind: attachment.kind };
  });
  return {
    project_name: { status: 'disclosed', name: requireLabel(project.name, 'project name') },
    availability: { status: 'disclosed', items, truncated: false },
  };
}

function assertNoLocator(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (LOCATOR.test(value)) throw new Error(`refusing to disclose a locator at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLocator(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      assertNoLocator(inner, `${path}.${key}`);
    }
  }
}

export function openReadPort(input: {
  readonly read: LoomRead;
  readonly project: ProjectRecord;
  readonly disclosure?: DisclosurePolicy;
}): ReadPort {
  return {
    project_id: input.project.project_id,
    workspaceView() {
      const state = input.read.state();
      const trace = input.read.trace();
      const project = availabilityOf(input.project, input.disclosure?.availability);
      const view: WorkspaceView = {
        id: WORKSPACE_VIEW_ID,
        revision: state.state_revision,
        project_name: project.project_name,
        availability: project.availability,
        observations: observationsOf(trace, input.disclosure?.observations),
        approvals: approvalsOf(state, trace, input.disclosure?.approvals),
      };
      assertNoLocator(view, 'view');
      return view;
    },
  };
}
