/**
 * Local Kev evaluation adapter.
 *
 * Kev is installed and supervised outside this repository. This adapter owns
 * neither installation nor model files: it asks a runtime port to make the
 * configured service ready, then speaks the same System One wire contract as
 * the hosted TypeSafe adapter.
 */
import { typesafeAiEvaluator } from './typesafe-ai.js';
import { execFile } from 'node:child_process';

import type { Clock, EvaluationAdapter, ProviderFailure, Timer } from '../types.js';

export const KEV_LOCAL_ADAPTER = 'kev-local';
export const KEV_LOCAL_DESTINATION = 'local';
export const KEV_LOCAL_BASE_URL = 'http://127.0.0.1:8000';

export type KevReady =
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly failure: ProviderFailure };

/** External service lifecycle seam. Installation remains an operator concern. */
export interface KevRuntime {
  ensureReady(signal?: AbortSignal): Promise<KevReady>;
}

export interface KevLocalOptions {
  readonly runtime: KevRuntime;
  readonly baseURL?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface KevServiceIdentity {
  readonly run: string;
  readonly base: string;
  readonly lora: number;
}

export interface SystemdKevRuntimeOptions {
  readonly clock: Clock;
  readonly timer: Timer;
  readonly expected: KevServiceIdentity;
  readonly baseURL?: string;
  readonly unit?: string;
  readonly readiness_timeout_ms?: number;
  readonly poll_interval_ms?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly start?: (unit: string, signal: AbortSignal | undefined) => Promise<void>;
}

export function kevLocalEvaluator(options: KevLocalOptions): EvaluationAdapter {
  const delegate = typesafeAiEvaluator({
    apiKey: 'local',
    baseURL: options.baseURL ?? KEV_LOCAL_BASE_URL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    id: KEV_LOCAL_ADAPTER,
    async evaluate(call) {
      const ready = await options.runtime.ensureReady(call.signal);
      if (ready.status === 'failed') return ready;
      return delegate.evaluate(call);
    },
  };
}

type Probe = { readonly status: 'absent' } | KevReady;

/**
 * Discover or start a user-level service registered outside this repository.
 * Concurrent callers share one warmup so a remote outage cannot start several
 * 19 GiB model processes at once.
 */
export function createSystemdKevRuntime(options: SystemdKevRuntimeOptions): KevRuntime {
  const fetch = options.fetch ?? globalThis.fetch;
  const start = options.start ?? startUserUnit;
  const baseURL = (options.baseURL ?? KEV_LOCAL_BASE_URL).replace(/\/+$/, '');
  const unit = options.unit ?? 'weave-kev.service';
  const timeout = options.readiness_timeout_ms ?? 30_000;
  const poll = options.poll_interval_ms ?? 250;
  let warming: Promise<KevReady> | undefined;

  async function prepare(signal: AbortSignal | undefined): Promise<KevReady> {
    if (isAborted(signal)) return cancelled();

    const initial = await probe(fetch, `${baseURL}/api/info`, options.expected, signal);
    if (initial.status !== 'absent') return initial;

    try {
      await start(unit, signal);
    } catch (error) {
      if (isAborted(signal) || abortLike(error)) return cancelled();
      return {
        status: 'failed',
        failure: {
          code: 'unavailable',
          message: `could not start ${unit}: ${errorMessage(error)}`,
          retryable: true,
        },
      };
    }

    const deadline = options.clock.now() + timeout;
    while (options.clock.now() < deadline) {
      if (isAborted(signal)) return cancelled();
      try {
        await options.timer.sleep(poll, signal);
      } catch {
        return cancelled();
      }
      const result = await probe(fetch, `${baseURL}/api/info`, options.expected, signal);
      if (result.status !== 'absent') return result;
    }

    return {
      status: 'failed',
      failure: {
        code: 'timeout',
        message: `${unit} did not become ready within ${timeout}ms`,
        retryable: false,
      },
    };
  }

  return {
    ensureReady(signal) {
      if (isAborted(signal)) return Promise.resolve(cancelled());
      if (warming === undefined) {
        // Service warmup belongs to the runtime, not to whichever request won
        // the race to initiate it. A caller may stop waiting without tearing
        // down the one warmup every other caller is sharing.
        warming = prepare(undefined).finally(() => {
          warming = undefined;
        });
      }
      return waitForWarmup(warming, signal);
    },
  };
}

function waitForWarmup(warming: Promise<KevReady>, signal: AbortSignal | undefined): Promise<KevReady> {
  if (signal === undefined) return warming;
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void warming.then((result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    });
  });
}

async function probe(
  fetch: typeof globalThis.fetch,
  url: string,
  expected: KevServiceIdentity,
  signal: AbortSignal | undefined,
): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(url, signal === undefined ? {} : { signal });
  } catch (error) {
    if (isAborted(signal) || abortLike(error)) return cancelled();
    return { status: 'absent' };
  }
  if (!response.ok) return { status: 'absent' };

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return identityFailure('readiness response was not JSON');
  }
  if (!isIdentity(value)) return identityFailure('readiness response did not identify the checkpoint');
  if (value.run !== expected.run || value.base !== expected.base || value.lora !== expected.lora) {
    return identityFailure(
      `checkpoint mismatch: expected ${expected.run} / ${expected.base} / lora ${expected.lora}, ` +
        `received ${value.run} / ${value.base} / lora ${value.lora}`,
    );
  }
  return { status: 'ready' };
}

function isIdentity(value: unknown): value is KevServiceIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['run'] === 'string' && typeof record['base'] === 'string' && typeof record['lora'] === 'number';
}

function identityFailure(message: string): KevReady {
  return {
    status: 'failed',
    failure: { code: 'malformed_response', message, retryable: false },
  };
}

function cancelled(): KevReady {
  return {
    status: 'failed',
    failure: { code: 'cancelled', message: 'Kev warmup was cancelled', retryable: false },
  };
}

function abortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startUserUnit(unit: string, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'systemctl',
      ['--user', 'start', unit],
      signal === undefined ? {} : { signal },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });
}
