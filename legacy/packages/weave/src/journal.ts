import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

/** JSONL observation log. Survives process termination independently of FabricStore. */
export class FileJournal implements ObservationJournal {
  failStarts = false;
  failResults = false;

  constructor(readonly path: string) {
    const directory = dirname(path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    if (!existsSync(path)) {
      writeFileSync(path, '');
    }
  }

  persist(observation: Observation): void {
    if (observation.payload_type === 'action.started' && this.failStarts) {
      throw new PersistError('action.started');
    }
    if (observation.payload_type === 'action.result' && this.failResults) {
      throw new PersistError('action.result');
    }
    appendFileSync(this.path, `${JSON.stringify(observation)}\n`);
  }

  snapshot(): Observation[] {
    const text = readFileSync(this.path, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Observation);
  }
}
