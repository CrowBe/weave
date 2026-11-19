/**
 * The Fabric host's Weft emission (packages/weft/src/WEFT-CONTRACT.md, Emission).
 *
 * Declared here because AgentFabric does not import Weft. Records carry ids
 * and codes only: never inputs, outputs, grants, environment or failure text.
 * They reach the port only once the host step that built them has completed,
 * so a sink that calls back into the host never sees a half-applied one.
 */

import type { FailureCode } from '@weave/agentsop';

/** A `weft.record@1` as the host builds it. Weft's validator decides whether it is valid. */
export interface WeftRecordShape {
  readonly schema: 'weft.record@1';
  readonly trace_id: string;
  readonly record_id: string;
  readonly emitter: { readonly kind: 'loom' | 'gateway' | 'fabric' | 'external'; readonly id: string };
  readonly sequence: number;
  readonly kind: string;
  readonly thread_id: string | null;
  readonly parent_id: string | null;
  readonly links: readonly { readonly rel: string; readonly record_id: string }[];
  readonly evidence: readonly { readonly source: string; readonly ref: string }[];
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Supplied at composition. Absent: the host emits nothing and builds nothing. */
export interface WeftPort {
  readonly trace_id: string;
  readonly emitter_id: string;
  emit(record: WeftRecordShape): unknown;
}

export class FabricWeft {
  private sequence = 0;
  /** Records built during the running host step, in order, delivered when it completes. */
  private readonly pending: WeftRecordShape[] = [];
  /** Nesting of host steps: a rejection inside invoke is part of invoke's step. */
  private depth = 0;
  /** Set while records are delivered: a step a sink starts is delivered by the same loop. */
  private flushing = false;

  constructor(private readonly port: WeftPort) {}

  /** Run one host step. Steps nest; records wait for the outermost to end. */
  step<T>(run: () => T): T {
    this.depth += 1;
    try {
      return run();
    } finally {
      this.depth -= 1;
      if (this.depth === 0) {
        this.flush();
      }
    }
  }

  /**
   * Deliver pending records. A sink may call back into the host: that call
   * runs as its own step after the one being reported, and its records are
   * delivered here, after the ones already pending.
   */
  private flush(): void {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      for (let i = 0; i < this.pending.length; i += 1) {
        deliver(this.port, this.pending[i] as WeftRecordShape);
      }
    } finally {
      this.pending.length = 0;
      this.flushing = false;
    }
  }

  private send(
    record_id: string | null,
    kind: string,
    parent_id: string | null,
    invocation: string | null,
    fields: Record<string, unknown>,
  ): void {
    this.sequence += 1;
    this.pending.push({
      schema: 'weft.record@1',
      trace_id: this.port.trace_id,
      record_id: record_id ?? `${this.port.emitter_id}:event:${this.sequence}`,
      emitter: { kind: 'fabric', id: this.port.emitter_id },
      sequence: this.sequence,
      kind,
      thread_id: null,
      parent_id,
      links: [],
      evidence: invocation === null ? [] : [{ source: 'invocation', ref: invocation }],
      fields,
    });
    if (this.depth === 0) {
      this.flush();
    }
  }

  /**
   * A re-run supersedes a stopped attempt under the same invocation id (WV-040). Weft identifies a
   * record by `(trace_id, record_id)`, so a later attempt's ids carry the store's durable attempt
   * number; the first attempt keeps the plain id. Evidence still correlates by invocation id.
   */
  private attemptId(event: string, invocation_id: string, attempt: number | undefined): string {
    const base = `${this.port.emitter_id}:${event}:${invocation_id}`;
    return attempt === undefined || attempt <= 1 ? base : `${base}:attempt-${attempt}`;
  }

  selected(
    invocation_id: string,
    operation: string,
    implementation: string,
    contract_rev: string,
    attempt?: number,
  ): void {
    this.send(this.attemptId('selected', invocation_id, attempt), 'capability.lifecycle', null, invocation_id, {
      operation,
      implementation,
      event: 'selected',
      contract_rev,
    });
  }

  invoked(
    invocation_id: string,
    implementation: string,
    contract_rev: string,
    status: 'succeeded' | 'failed' | 'uncertain' | 'cancelled',
    attempt?: number,
  ): void {
    this.send(
      this.attemptId('invoked', invocation_id, attempt),
      'capability.invoked',
      this.attemptId('selected', invocation_id, attempt),
      invocation_id,
      {
        contract_rev,
        implementation,
        status,
        invocation_ref: invocation_id,
      },
    );
  }

  rejected(code: FailureCode): void {
    this.send(null, 'error', null, null, { code: code.toLowerCase(), retryable: code === 'RESOLVER_UNAVAILABLE' });
  }

  admitted(operation: string, implementation: string, contract_rev: string): void {
    this.send(null, 'capability.lifecycle', null, null, { operation, implementation, event: 'admitted', contract_rev });
  }

  revoked(operation: string, implementations: readonly string[]): void {
    if (implementations.length === 0) {
      this.send(null, 'capability.lifecycle', null, null, { operation, event: 'revoked' });
      return;
    }
    for (const implementation of implementations) {
      this.send(null, 'capability.lifecycle', null, null, { operation, implementation, event: 'revoked' });
    }
  }
}

/**
 * Hand one record to the port. Emission is one-way: a throw is swallowed, a
 * returned promise is never awaited and its rejection is handled.
 */
function deliver(port: WeftPort, record: WeftRecordShape): void {
  try {
    const result: unknown = port.emit(record);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      const then = (result as { then?: unknown }).then;
      if (typeof then === 'function') {
        (then as (resolved: undefined, rejected: () => void) => unknown).call(result, undefined, ignore);
      }
    }
  } catch {
    // The sink's failure is the sink's: it never reaches state or scheduling.
  }
}

function ignore(): void {}
