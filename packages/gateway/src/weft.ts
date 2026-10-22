/**
 * The gateway's Weft emission (packages/weft/src/WEFT-CONTRACT.md, Emission).
 *
 * Declared here because the gateway imports nothing in-repo. A request's
 * records are collected while it runs and handed to the port once it has
 * settled, so the sink cannot spend the request's deadline.
 */
import type { AttemptRecord, RoutedUnit } from './types.js';
import type { RouteExclusion } from './routing.js';

/** A `weft.record@1` as the gateway builds it. Weft's validator decides whether it is valid. */
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

/** Supplied at composition. Absent: the gateway emits nothing and builds nothing. */
export interface WeftPort {
  readonly trace_id: string;
  readonly emitter_id: string;
  emit(record: WeftRecordShape): unknown;
}

type Pending = Omit<WeftRecordShape, 'sequence'>;

/** Exclusions a route record carries (the contract's bound), in routing order. */
const MAX_EXCLUDED = 64;

/** One emitter instance: its sequence spans every request it serves. */
export class GatewayWeft {
  private sequence = 0;

  constructor(private readonly port: WeftPort) {}

  request(request_id: string): RequestWeft {
    return new RequestWeft(this.port, request_id);
  }

  flush(request: RequestWeft): void {
    for (const record of request.records) {
      this.sequence += 1;
      deliver(this.port, { ...record, sequence: this.sequence });
    }
  }
}

/** The records of one request, in the order they happened. */
export class RequestWeft {
  readonly records: Pending[] = [];
  private route: string | null = null;
  private routedUnit: string | null = null;
  private routes = 0;
  private lastAttempt: string | null = null;

  constructor(
    private readonly port: WeftPort,
    private readonly request_id: string,
  ) {}

  private push(
    record_id: string,
    kind: string,
    parent_id: string | null,
    links: { rel: string; record_id: string }[],
    fields: Record<string, unknown>,
  ): void {
    this.records.push({
      schema: 'weft.record@1',
      trace_id: this.port.trace_id,
      record_id,
      emitter: { kind: 'gateway', id: this.port.emitter_id },
      kind,
      thread_id: null,
      parent_id,
      links,
      evidence: [{ source: 'inference_request', ref: this.request_id }],
      fields,
    });
  }

  /** The unit about to be attempted. A unit other than the last is a new route: the first, or an escalation. */
  routed(unit: RoutedUnit, excluded: readonly RouteExclusion[]): void {
    if (unit.routed_unit_id === this.routedUnit) {
      return;
    }
    const previous = this.route;
    this.routes += 1;
    this.routedUnit = unit.routed_unit_id;
    this.route = `${this.port.emitter_id}:${this.request_id}:route:${this.routes}`;
    const links: { rel: string; record_id: string }[] = [];
    if (previous !== null) {
      links.push({ rel: 'supersedes', record_id: previous });
      if (this.lastAttempt !== null) {
        links.push({ rel: 'caused_by', record_id: this.lastAttempt });
      }
    }
    const fields: Record<string, unknown> = { request_ref: this.request_id, routed_unit: unit.routed_unit_id };
    if (unit.tier !== undefined) {
      fields['tier'] = unit.tier;
    }
    if (excluded.length > 0) {
      fields['excluded'] = excluded
        .slice(0, MAX_EXCLUDED)
        .map((e) => ({ routed_unit: e.routed_unit_id, reason: e.reason }));
    }
    this.push(this.route, 'route.selected', null, links, fields);
  }

  attempted(attempt: AttemptRecord): void {
    const record_id = `${this.port.emitter_id}:${this.request_id}:attempt:${attempt.attempt}`;
    const fields: Record<string, unknown> = {
      request_ref: this.request_id,
      routed_unit: attempt.routed_unit_id,
      attempt_no: attempt.attempt,
      disposition: attempt.disposition.status,
    };
    if (Number.isSafeInteger(attempt.usage.input_tokens)) fields['input_tokens'] = attempt.usage.input_tokens;
    if (Number.isSafeInteger(attempt.usage.output_tokens)) fields['output_tokens'] = attempt.usage.output_tokens;
    fields['spent_micros'] = Math.ceil(attempt.cost);
    fields['cost_is_upper_bound'] = attempt.cost_is_upper_bound;
    fields['latency_ms'] = Math.max(0, attempt.ended_at - attempt.started_at);
    this.push(
      record_id,
      'inference.attempt',
      this.route,
      this.lastAttempt === null ? [] : [{ rel: 'retry_of', record_id: this.lastAttempt }],
      fields,
    );
    if (attempt.disposition.status === 'failed') {
      this.push(`${record_id}:error`, 'error', record_id, [], {
        code: attempt.disposition.failure.code,
        retryable: attempt.disposition.failure.retryable,
      });
    }
    this.lastAttempt = record_id;
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
