import type { Effect } from './effects.js';

/**
 * An opaque, host-issued handle. Kind and locator stay in the host's table;
 * this string is not a path, URL, or other locator. M0 used canonical
 * `ResourceId` strings in this role; M1's host issues handles that do not
 * encode locators.
 */
export type ResourceRef = string;

/**
 * Well-formedness is syntactic. It does not disclose whether the host issued
 * the handle or whether a resource exists. Locators (paths, URLs) are not refs.
 */
export function isWellFormedRef(value: unknown): value is ResourceRef {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (value.includes('/') || value.includes('\\') || value.includes('://')) {
    return false;
  }
  return true;
}

/** A concrete effect on a concrete resource: what a grant covers and an action declares. */
export interface ResourceEffect {
  readonly resource: ResourceRef;
  readonly mode: Effect;
}

/**
 * An authority selector on the contract: the input field that carries the
 * reference (or list of references) and the effect the capability needs on it.
 */
export interface EffectSelector {
  readonly input: string;
  readonly mode: Effect;
}

export function resourceEffectKey(effect: ResourceEffect): string {
  return `${effect.mode}\0${effect.resource}`;
}

/** Declared and authorized effect sets are equal as sets of (resource, mode). */
export function effectSetsEqual(a: readonly ResourceEffect[], b: readonly ResourceEffect[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = new Set(a.map(resourceEffectKey));
  if (left.size !== a.length) {
    return false;
  }
  for (const effect of b) {
    if (!left.delete(resourceEffectKey(effect))) {
      return false;
    }
  }
  return left.size === 0;
}

export function selectorsEqual(a: readonly EffectSelector[], b: readonly EffectSelector[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (s: EffectSelector) => `${s.mode}\0${s.input}`;
  const left = new Set(a.map(key));
  if (left.size !== a.length) {
    return false;
  }
  for (const selector of b) {
    if (!left.delete(key(selector))) {
      return false;
    }
  }
  return left.size === 0;
}
