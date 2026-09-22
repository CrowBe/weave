/**
 * Process isolation for generated tests and implementations.
 *
 * A probe has to succeed before any generated source runs. An unsupported
 * mode never falls back to in-process evaluation.
 */
import { spawn, type Serializable } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { IsolationReport } from '@weave/agentsop';
import { digest } from './digest.js';

export type IsolationMode = 'enforcing' | 'unsupported';

export interface IsolatedCase {
  readonly id: string;
  readonly input: unknown;
}

export interface IsolatedResult {
  readonly id: string;
  readonly output?: unknown;
  readonly error?: string;
}

interface WorkerSuccess {
  readonly ok: true;
  readonly result: unknown;
}

const WORKER = fileURLToPath(new URL('./isolate-worker.js', import.meta.url));

export class IsolateRunner {
  probeRuns = 0;
  executeRuns = 0;
  private report: IsolationReport | null = null;
  /** Keys placed on each case that crossed into the child. Expectations must not appear. */
  dispatchedCaseKeys: string[] = [];

  currentReport(): IsolationReport | null {
    return this.report;
  }

  constructor(private readonly mode: IsolationMode) {}

  async prove(): Promise<IsolationReport> {
    if (this.report) {
      return this.report;
    }
    if (this.mode === 'unsupported') {
      this.report = unsupported();
      return this.report;
    }
    this.probeRuns += 1;
    const response = await this.spawnWorker({ type: 'probe' });
    const result = response as {
      filesystem?: string;
      network?: string;
      child_process?: string;
      canary?: unknown;
      vm?: { process?: string; require?: string; fetch?: string };
    };
    const filesystem = result.filesystem === 'blocked' ? 'blocked' : 'open';
    const network = result.network === 'none' ? 'none' : 'open';
    const child_process = result.child_process === 'blocked' ? 'blocked' : 'open';
    const credentials = result.canary == null ? 'absent' : 'visible';
    const evaluated_process = result.vm?.process === 'undefined' ? 'undefined' : 'defined';
    const evaluated_require = result.vm?.require === 'undefined' ? 'undefined' : 'defined';
    const evaluated_fetch = result.vm?.fetch === 'undefined' ? 'undefined' : 'defined';
    const supported =
      filesystem === 'blocked' &&
      network === 'none' &&
      child_process === 'blocked' &&
      credentials === 'absent' &&
      evaluated_process === 'undefined' &&
      evaluated_require === 'undefined' &&
      evaluated_fetch === 'undefined';
    const body: Omit<IsolationReport, 'report_id'> = {
      supported,
      tier: 'untrusted',
      filesystem,
      network,
      child_process,
      credentials,
      evaluated_process,
      evaluated_require,
      evaluated_fetch,
      held_out_mounted: false,
      host_process: evaluated_process === 'undefined' ? 'unreachable' : 'unprobed',
      broker: 'resolver-context',
      limits: { memory_bytes: 32 * 1024 * 1024, cpu_ms: 100 },
    };
    const report: IsolationReport = { ...body, report_id: digest(body) };
    this.report = report;
    return report;
  }

  async runCases(source: string, cases: readonly IsolatedCase[]): Promise<IsolatedResult[]> {
    const report = await this.prove();
    if (!report.supported) {
      throw new Error('isolation unsupported');
    }
    for (const testCase of cases) {
      if (testCase && typeof testCase === 'object' && 'expected' in testCase) {
        throw new Error('held-out expectation must not cross the isolation boundary');
      }
    }
    this.dispatchedCaseKeys = ['id', 'input'];
    this.executeRuns += 1;
    const response = (await this.spawnWorker({
      type: 'batch',
      source,
      cases: cases.map((testCase) => ({ id: testCase.id, input: testCase.input })),
    })) as { results?: IsolatedResult[] };
    return response.results ?? [];
  }

  /** A dependency that exits before it sends an outcome. The promise settles as failure. */
  async endedWithoutResult(): Promise<{ readonly ok: false; readonly failure: string }> {
    try {
      await this.spawnWorker({ type: 'silent-exit' });
      return { ok: false, failure: 'no result' };
    } catch (error) {
      return { ok: false, failure: error instanceof Error ? error.message : 'no result' };
    }
  }

  private spawnWorker(message: Serializable): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${WORKER}`, '--max-old-space-size=32', WORKER], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {},
      });
      let settled = false;
      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('message', (payload: WorkerSuccess) => {
        if (!payload || payload.ok !== true) {
          finish(new Error('isolate worker rejected the run'));
          return;
        }
        finish(null, payload.result);
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => {
        if (!settled) {
          finish(new Error(stderr.trim() || `isolate worker exited ${code ?? 'unknown'}`));
        }
      });
      child.send(message);
    });
  }
}

function unsupported(): IsolationReport {
  const body = {
    supported: false,
    tier: 'untrusted' as const,
    filesystem: 'unprobed' as const,
    network: 'unprobed' as const,
    child_process: 'unprobed' as const,
    credentials: 'unprobed' as const,
    evaluated_process: 'unprobed' as const,
    evaluated_require: 'unprobed' as const,
    evaluated_fetch: 'unprobed' as const,
    held_out_mounted: false as const,
    host_process: 'unprobed' as const,
    broker: 'resolver-context' as const,
    limits: { memory_bytes: 32 * 1024 * 1024, cpu_ms: 100 },
  };
  return { ...body, report_id: digest(body) };
}

export async function isolatedCall(
  runner: IsolateRunner,
  source: string,
  input: unknown,
): Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly failure: string }> {
  let results: IsolatedResult[];
  try {
    results = await runner.runCases(source, [{ id: 'call', input }]);
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : 'isolation failed' };
  }
  const result = results[0];
  if (!result || result.error) {
    return { ok: false, failure: result?.error ?? 'isolate error' };
  }
  return { ok: true, output: result.output };
}
