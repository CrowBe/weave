import { useEffect, useState } from 'react';
import './local-workspace.css';

interface Status {
  ready: boolean;
  messages: string[];
  generation_available: boolean;
  routes: { id: string; model: string; tier: string; destination: string }[];
  scope: string;
}
interface Run {
  id: string;
  input: string;
  status: 'running' | 'stopping' | 'settled';
  events: { sequence: number; task_id: string; parent: string | null; stage: string; detail: unknown }[];
  result: { status: string; output: unknown; reason: string | null; nodes: number; requires_review: boolean } | null;
  stats: { calls: number; spent: number; reserved: number };
}
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-loom-local': '1' },
          body: JSON.stringify(body),
        }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({ error: `Local server returned ${response.status}.` }))) as {
      error?: string;
    };
    throw new Error(failure.error ?? 'Local request failed.');
  }
  return response.json() as Promise<T>;
}
function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { text?: unknown }).text === 'string'
  )
    return (value as { text: string }).text;
  return JSON.stringify(value, null, 2);
}
function download(run: Run) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `loom-${run.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Host() {
  const [status, setStatus] = useState<Status | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = run !== null && run.status !== 'settled';
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<Status>('/api/status', undefined, controller.signal),
      api<Run | null>('/api/run', undefined, controller.signal),
    ])
      .then(([configuration, current]) => {
        setStatus(configuration);
        setRun(current);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Cannot reach the local server.');
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await api<Run | null>('/api/run', undefined, controller.signal);
        setRun(current);
        if (current && current.status !== 'settled')
          timer = setTimeout(() => {
            void poll();
          }, 400);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : 'Connection interrupted.');
          timer = setTimeout(() => {
            void poll();
          }, 1500);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active]);
  async function submit() {
    if (!input.trim() || active || pending) return;
    setPending(true);
    setError(null);
    try {
      setRun(await api<Run>('/api/runs', { input }));
      setInput('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start the run.');
    } finally {
      setPending(false);
    }
  }
  async function stop() {
    if (!run) return;
    setPending(true);
    try {
      setRun(await api<Run>('/api/run/stop', { run_id: run.id }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not stop the run.');
    } finally {
      setPending(false);
    }
  }
  async function reset() {
    setPending(true);
    try {
      await api('/api/run/reset', {});
      setRun(null);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not clear the run.');
    } finally {
      setPending(false);
    }
  }
  const last = run?.events.at(-1);
  return (
    <div className="local-workspace">
      <header className="local-header">
        <span>
          <strong>Weave Loom</strong>
          <span className="local-label">local experiment</span>
        </span>
        <button
          type="button"
          onClick={() => {
            void reset();
          }}
          disabled={active || pending || !run}
        >
          New run
        </button>
      </header>
      <main className="local-main">
        <details className="local-configuration" open={status !== null && !status.ready}>
          <summary>
            {status === null ? 'Connecting…' : status.ready ? 'Model configuration' : 'Model configuration needed'}
          </summary>
          {status ? (
            <div>
              {status.messages.map((message) => (
                <p key={message}>{message}</p>
              ))}
              <p>{status.scope}</p>
              {!status.generation_available ? (
                <p>No strong generation route is configured. An escalation will stop explicitly.</p>
              ) : null}
              <ul>
                {status.routes.map((route) => (
                  <li key={route.id}>
                    {route.model} · {route.tier} · {route.destination}
                  </li>
                ))}
              </ul>
              <p>Restart the local server after changing configuration. Runs are held in memory.</p>
            </div>
          ) : null}
        </details>
        {error ? (
          <p className="local-error" role="alert">
            {error}
          </p>
        ) : null}
        {run ? (
          <section className="local-run" aria-label="Current run">
            <p className="local-request">{run.input}</p>
            <div className="local-run-status" role="status" aria-live="polite">
              {active
                ? run.status === 'stopping'
                  ? 'Stopping…'
                  : `Working${last ? ` · ${last.task_id} · ${last.stage}` : '…'}`
                : run.result?.status === 'completed'
                  ? 'Run completed'
                  : run.result?.status.replaceAll('_', ' ')}
            </div>
            {run.result?.reason ? <p>{run.result.reason}</p> : null}
            {run.result?.status === 'completed' ? (
              <div>
                {run.result.requires_review ? (
                  <p className="local-review">Includes generated text. Review the result.</p>
                ) : null}
                <pre className="local-result" data-testid="run-result">
                  {format(run.result.output)}
                </pre>
              </div>
            ) : null}
            <details className="local-evidence">
              <summary>
                Execution evidence{' '}
                <span>
                  {run.events.length} events · {run.stats.calls} calls · ${(run.stats.spent / 1_000_000).toFixed(4)}
                </span>
              </summary>
              <div className="local-evidence-actions">
                <button type="button" onClick={() => download(run)}>
                  Download evidence
                </button>
              </div>
              <ol>
                {run.events.map((event) => (
                  <li key={event.sequence}>
                    <details>
                      <summary>
                        <span>{event.task_id}</span> {event.stage}
                        {event.parent ? ` ← ${event.parent}` : ''}
                      </summary>
                      <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                    </details>
                  </li>
                ))}
              </ol>
            </details>
          </section>
        ) : (
          <div className="local-empty">
            <h1>What would you like to test?</h1>
          </div>
        )}
        <form
          className="local-input"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="sr-only" htmlFor="task-input">
            Task for Loom
          </label>
          <textarea
            id="task-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={16_000}
            rows={3}
            placeholder="Describe a task…"
            disabled={active || pending}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="local-input-actions">
            <span>Submitted text only</span>
            {active ? (
              <button
                className="local-primary"
                type="button"
                onClick={() => {
                  void stop();
                }}
                disabled={pending || run.status === 'stopping'}
              >
                Stop
              </button>
            ) : (
              <button className="local-primary" type="submit" disabled={!input.trim() || !status?.ready || pending}>
                {pending ? 'Starting…' : 'Run'}
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
