import { runLocalTask, type LocalTaskPorts } from '@weave/weave';
import type { InferenceEvidence } from './ports.ts';
import { randomUUID } from 'node:crypto';
import type { GaugeSummary, RunEvidence } from './gauge.ts';

export interface LocalStatus {
  readonly ready: boolean;
  readonly messages: readonly string[];
  readonly generation_available: boolean;
  readonly routes: readonly unknown[];
  readonly scope: string;
}
export function createLocalApi(options: {
  readonly origin: string;
  readonly status: LocalStatus;
  readonly createPorts: (evidence: (event: InferenceEvidence) => void) => {
    ports: LocalTaskPorts;
    stats: () => { calls: number; spent: number; reserved: number };
  };
  readonly recordRun?: (run: RunEvidence) => GaugeSummary | Promise<GaugeSummary>;
  readonly readGauge?: (key: string) => unknown;
  readonly resetDisplay?: () => void;
  readonly initial?: { run: RunEvidence; summary: GaugeSummary } | null;
}) {
  let current: {
    id: string;
    input: string;
    operator_input?: string;
    status: 'running' | 'stopping' | 'settled';
    started_at: string;
    events: { sequence: number; task_id: string; parent: string | null; stage: string; detail: unknown }[];
    result: Awaited<ReturnType<typeof runLocalTask>> | null;
    parent_run?: string;
    gauge?: GaugeSummary;
    recording_error?: string;
  } | null = options.initial
    ? { ...options.initial.run, events: [...options.initial.run.events], gauge: options.initial.summary }
    : null;
  let abort: AbortController | null = null;
  let running: Promise<void> = Promise.resolve();
  let stats = () => options.initial?.run.stats ?? { calls: 0, spent: 0, reserved: 0 };
  const reply = (value: unknown, code = 200) =>
    Response.json(value, { status: code, headers: { 'cache-control': 'no-store' } });
  const snapshot = () => (current ? { ...current, stats: stats() } : null);
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== options.origin) return reply({ error: 'Unexpected local host.' }, 403);
    if (request.method === 'GET') {
      if (url.pathname === '/api/status') return reply(options.status);
      if (url.pathname === '/api/run' || url.pathname === '/api/run/evidence') return reply(snapshot());
      if (url.pathname === '/api/run/gauge') {
        const key = url.searchParams.get('key') ?? current?.gauge?.key;
        if (!key || !options.readGauge) return reply(null);
        if (!/^[a-f0-9]{64}$/.test(key)) return reply({ error: 'Invalid Gauge key.' }, 400);
        try {
          return reply(options.readGauge(key));
        } catch {
          return reply({ error: 'Gauge archive unavailable.' }, 404);
        }
      }
      return reply({ error: 'Unknown endpoint.' }, 404);
    }
    if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
    if (
      request.headers.get('x-loom-local') !== '1' ||
      request.headers.get('content-type') !== 'application/json' ||
      (request.headers.get('origin') !== null && request.headers.get('origin') !== options.origin)
    )
      return reply({ error: 'Use the local workspace to submit work.' }, 403);
    let body: { input?: unknown; run_id?: unknown; reply_to?: unknown };
    try {
      const text = await request.text();
      if (text.length > 100_000) return reply({ error: 'Request too large.' }, 413);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return reply({ error: 'Expected a request object.' }, 400);
      body = value;
    } catch {
      return reply({ error: 'Invalid JSON.' }, 400);
    }
    if (url.pathname === '/api/runs') {
      if (current && current.status !== 'settled')
        return reply({ error: 'Stop the active run before starting another.' }, 409);
      if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 16_000)
        return reply({ error: 'Enter between 1 and 16,000 characters.' }, 400);
      if (!options.status.ready) return reply({ error: options.status.messages.join(' ') }, 503);
      let input = body.input;
      if (body.reply_to !== undefined) {
        if (
          !current ||
          current.id !== body.reply_to ||
          current.status !== 'settled' ||
          current.result?.status !== 'needs_human' ||
          !current.result.question
        )
          return reply({ error: 'No matching question to answer.' }, 409);
        input = `ORIGINAL REQUEST\n${current.input}\n\nLOOM CLARIFICATION QUESTION\n${current.result.question}\n\nOPERATOR ANSWER\n${body.input}`;
        if (input.length > 16_000)
          return reply({ error: 'The request and clarification exceed the local context limit.' }, 400);
      }
      const run: NonNullable<typeof current> = {
        id: `run-${randomUUID()}`,
        input,
        operator_input: body.input,
        ...(body.reply_to === undefined ? {} : { parent_run: String(body.reply_to) }),
        status: 'running',
        started_at: new Date().toISOString(),
        events: [],
        result: null,
      };
      const controller = new AbortController();
      const local = options.createPorts((event) =>
        run.events.push({
          sequence: run.events.length + 1,
          task_id: event.task_id,
          parent: null,
          stage: 'inference',
          detail: { site: event.site, ...(event.detail as object) },
        }),
      );
      stats = local.stats;
      abort = controller;
      current = run;
      running = runLocalTask(
        run.input,
        local.ports,
        { max_nodes: 32, max_depth: 8, concurrency: 3 },
        controller.signal,
        (event) => run.events.push({ ...event, sequence: run.events.length + 1 }),
      ).then(async (result) => {
        run.result = result;
        if (options.recordRun) {
          try {
            run.gauge = await options.recordRun({ ...run, status: 'settled', result, stats: local.stats() });
          } catch {
            run.recording_error =
              'Gauge evidence could not be saved. Download the execution evidence before clearing this run.';
          }
        }
        run.status = 'settled';
      });
      return reply(snapshot(), 202);
    }
    if (url.pathname === '/api/run/stop') {
      if (!current || current.id !== body.run_id || current.status === 'settled')
        return reply({ error: 'No matching active run.' }, 409);
      current.status = 'stopping';
      abort?.abort();
      return reply(snapshot(), 202);
    }
    if (url.pathname === '/api/run/reset') {
      if (current && current.status !== 'settled') return reply({ error: 'Stop the active run first.' }, 409);
      options.resetDisplay?.();
      current = null;
      return reply(null);
    }
    return reply({ error: 'Unknown endpoint.' }, 404);
  }
  return { handle, snapshot, settled: () => running, stop: () => abort?.abort() };
}
