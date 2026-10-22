/**
 * The Fabric host's Weft emission (packages/weft/src/WEFT-CONTRACT.md, Emission).
 *
 * Declared here because AgentFabric does not import Weft. Records carry ids
 * and codes only: never inputs, outputs, grants, environment or failure text.
 */

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

  constructor(private readonly port: WeftPort) {}

  private send(record_id: string | null, kind: string, parent_id: string | null, invocation: string | null, fields: Record<string, unknown>): void {
    this.sequence += 1;
    deliver(this.port, {
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
  }

  private selectedId(invocation_id: string): string {
    return `${this.port.emitter_id}:selected:${invocation_id}`;
  }

  selected(invocation_id: string, operation: string, implementation: string, contract_rev: string): void {
    this.send(this.selectedId(invocation_id), 'capability.lifecycle', null, invocation_id, {
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
  ): void {
    this.send(`${this.port.emitter_id}:invoked:${invocation_id}`, 'capability.invoked', this.selectedId(invocation_id), invocation_id, {
      contract_rev,
      implementation,
      status,
      invocation_ref: invocation_id,
    });
  }

  rejected(code: string): void {
    this.send(null, 'error', null, null, { code: code.toLowerCase(), retryable: false });
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
