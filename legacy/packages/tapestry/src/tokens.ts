/**
 * Token roles `tokens@1`. Components name roles. A theme record supplies a
 * value for every role. A renderer binds the values; this module does not.
 */
export const TOKEN_ROLES_ID = 'tokens@1' as const;

export const BASE_COLOR_ROLES = [
  'canvas',
  'surface',
  'surface-raised',
  'border',
  'text',
  'text-muted',
  'focus',
] as const;

export const STATUS_COLOR_ROLES = [
  'provenance-operator',
  'provenance-runtime',
  'provenance-host',
  'provenance-clock',
  'provenance-judgment',
  'provenance-untrusted',
  'eligibility-allowed',
  'eligibility-approval',
  'eligibility-prohibited',
  'action-pending',
  'action-running',
  'action-succeeded',
  'action-failed',
  'action-uncertain',
  'action-cancelled',
  'validation-accepted',
  'validation-rejected',
  'validation-unknown',
  'condition-empty',
  'condition-omitted',
  'condition-stale',
  'condition-exhausted',
  'decision-request',
  'decision-approve',
  'decision-deny',
] as const;

export const COLOR_ROLES = [...BASE_COLOR_ROLES, ...STATUS_COLOR_ROLES] as const;

export type BaseColorRole = (typeof BASE_COLOR_ROLES)[number];
export type StatusColorRole = (typeof STATUS_COLOR_ROLES)[number];
export type ColorRole = (typeof COLOR_ROLES)[number];

export const TYPE_ROLES = ['title', 'heading', 'body', 'label', 'id', 'numeric'] as const;
export type TypeRole = (typeof TYPE_ROLES)[number];

/** Pairs that must not share one color value. */
export const DISTINCT_COLOR_PAIRS = [
  ['action-failed', 'action-uncertain'],
  ['validation-accepted', 'validation-rejected'],
  ['decision-approve', 'decision-deny'],
] as const satisfies readonly (readonly [StatusColorRole, StatusColorRole])[];
