/**
 * Effects: a closed, versioned vocabulary. Adding an effect is a revision.
 */
export const EFFECT_VOCABULARY_REVISION = 1;

export const EFFECTS = ['discover', 'read', 'create', 'write', 'append', 'delete'] as const;
export type Effect = (typeof EFFECTS)[number];

export function isEffect(value: unknown): value is Effect {
  return typeof value === 'string' && (EFFECTS as readonly string[]).includes(value);
}

/**
 * Two effects on the same resource conflict unless both are `read`.
 * Reads do not commute with anything that changes the resource, and the
 * vocabulary is closed, so the rule is stated once here.
 */
export function effectsConflict(a: Effect, b: Effect): boolean {
  return !(a === 'read' && b === 'read');
}
