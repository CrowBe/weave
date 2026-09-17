export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(kind: string): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SequenceIds implements IdGenerator {
  private n = 0;

  constructor(private readonly prefix = "") {}

  next(kind: string): string {
    this.n += 1;
    return `${this.prefix}${kind}_${this.n}`;
  }
}

export class ControllableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  tick(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
