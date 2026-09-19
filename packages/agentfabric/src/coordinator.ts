import { effectsConflict, type Effect, type ResourceEffect } from '@weave/agentsop';

interface Hold {
  readonly invocation_id: string;
  readonly canonical_id: string;
  readonly mode: Effect;
}

/**
 * Canonical effect locks. Aliases share canonical_id, so they serialize as one
 * resource. Reads share; anything else is exclusive against the same resource.
 */
export class ResourceCoordinator {
  private readonly holds: Hold[] = [];

  held(): readonly Hold[] {
    return this.holds;
  }

  conflicts(effects: readonly { canonical_id: string; mode: Effect }[]): Hold | null {
    for (const effect of effects) {
      for (const held of this.holds) {
        if (held.canonical_id === effect.canonical_id && effectsConflict(held.mode, effect.mode)) {
          return held;
        }
      }
    }
    return null;
  }

  acquire(invocation_id: string, effects: readonly ResourceEffect[], canonical: (ref: string) => string): Hold | null {
    const mapped = effects.map((e) => ({ canonical_id: canonical(e.resource), mode: e.mode }));
    const conflict = this.conflicts(mapped);
    if (conflict) {
      return conflict;
    }
    for (const effect of mapped) {
      this.holds.push({ invocation_id, canonical_id: effect.canonical_id, mode: effect.mode });
    }
    return null;
  }

  release(invocation_id: string): void {
    for (let i = this.holds.length - 1; i >= 0; i -= 1) {
      if (this.holds[i]?.invocation_id === invocation_id) {
        this.holds.splice(i, 1);
      }
    }
  }

  isHeld(canonical_id: string): boolean {
    return this.holds.some((h) => h.canonical_id === canonical_id);
  }
}
