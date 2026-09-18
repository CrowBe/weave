import type { Observation } from './types.js';

export class PersistError extends Error {
  constructor(readonly payload_type: string) {
    super(`failed to persist ${payload_type}`);
    this.name = 'PersistError';
  }
}

/** Durable observation log. Persistence failure is explicit, never silent. */
export interface ObservationJournal {
  persist(observation: Observation): void;
  snapshot(): Observation[];
}

export class MemoryJournal implements ObservationJournal {
  failStarts = false;
  failResults = false;
  private readonly items: Observation[];

  constructor(items: readonly Observation[] = []) {
    this.items = items.map((o) => structuredClone(o));
  }

  persist(observation: Observation): void {
    if (observation.payload_type === 'action.started' && this.failStarts) {
      throw new PersistError('action.started');
    }
    if (observation.payload_type === 'action.result' && this.failResults) {
      throw new PersistError('action.result');
    }
    this.items.push(structuredClone(observation));
  }

  snapshot(): Observation[] {
    return this.items.map((o) => structuredClone(o));
  }
}
