/** Experimental task execution for the local workspace. No provider or renderer ownership. */
import type { Band } from './decide1.js';

export interface LocalTask {
  readonly id: string;
  readonly parent: string | null;
  readonly input: string;
  readonly dependencies: readonly unknown[];
}
export interface LocalChild {
  readonly input: string;
  /** Indexes of earlier siblings; this is a topological ordering, not execution order. */
  readonly depends_on: readonly number[];
}
export interface LocalTaskPorts {
  extract(task: LocalTask, signal?: AbortSignal): Promise<string>;
  decide(task: LocalTask, intent: string, signal?: AbortSignal): Promise<Band>;
  split(task: LocalTask, signal?: AbortSignal): Promise<readonly LocalChild[]>;
  admitSplit(task: LocalTask, children: readonly LocalChild[], signal?: AbortSignal): Promise<boolean>;
  act(task: LocalTask, signal?: AbortSignal): Promise<unknown>;
  generate(task: LocalTask, signal?: AbortSignal): Promise<unknown>;
}
export interface LocalTaskEvent {
  readonly sequence: number;
  readonly task_id: string;
  readonly parent: string | null;
  readonly stage: 'input' | 'extract' | 'decide' | 'split' | 'act' | 'generate' | 'join' | 'result' | 'stopped';
  readonly detail: unknown;
}
export interface LocalTaskLimits {
  readonly max_nodes: number;
  readonly max_depth: number;
  readonly concurrency: number;
}
export interface LocalTaskResult {
  readonly status: 'completed' | 'needs_human' | 'failed' | 'cancelled' | 'budget_exhausted';
  readonly output: unknown;
  readonly reason: string | null;
  readonly nodes: number;
  readonly requires_review: boolean;
}
export class LocalTaskStop extends Error {
  constructor(
    readonly status: Exclude<LocalTaskResult['status'], 'completed'>,
    reason: string,
  ) {
    super(reason);
  }
}
export async function runLocalTask(
  input: string,
  ports: LocalTaskPorts,
  limits: LocalTaskLimits,
  signal?: AbortSignal,
  emit: (event: LocalTaskEvent) => void = () => {},
): Promise<LocalTaskResult> {
  const abort = new AbortController();
  const cancel = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let nodes = 1;
  let sequence = 0;
  let requiresReview = false;
  let active = 0;
  const waiting: (() => void)[] = [];
  const check = () => {
    if (abort.signal.aborted) throw new LocalTaskStop('cancelled', 'Execution stopped.');
  };
  const event = (task: LocalTask, stage: LocalTaskEvent['stage'], detail: unknown) =>
    emit({ sequence: ++sequence, task_id: task.id, parent: task.parent, stage, detail: structuredClone(detail) });
  async function step<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limits.concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    // A released permit is handed directly to one waiter.
    else active++;
    try {
      check();
      const value = await fn();
      check();
      return value;
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  const canonical = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const root: LocalTask = { id: 'task-1', parent: null, input, dependencies: [] };
  async function execute(task: LocalTask, depth: number, ancestors: readonly string[]): Promise<unknown> {
    check();
    if (depth > limits.max_depth) throw new LocalTaskStop('budget_exhausted', 'Task depth allowance exhausted.');
    event(task, 'input', { input: task.input, dependencies: task.dependencies });
    const intent = await step(() => ports.extract(task, abort.signal));
    event(task, 'extract', { intent });
    const band = await step(() => ports.decide(task, intent, abort.signal));
    event(task, 'decide', { band });
    let output: unknown;
    if (band === 'ask_human') throw new LocalTaskStop('needs_human', 'The task needs clarification or authority.');
    if (band === 'spawn_subtasks') {
      const plan = structuredClone(await step(() => ports.split(task, abort.signal)));
      const seen = new Set<string>();
      if (!Array.isArray(plan) || plan.length < 2 || plan.length > 8) throw new Error('A split needs 2–8 children.');
      for (const [index, child] of plan.entries()) {
        if (
          typeof child?.input !== 'string' ||
          !child.input.trim() ||
          child.input.length > 16_000 ||
          !Array.isArray(child.depends_on) ||
          child.depends_on.some((dep: number) => !Number.isInteger(dep) || dep < 0 || dep >= index) ||
          new Set(child.depends_on).size !== child.depends_on.length ||
          ancestors.includes(canonical(child.input)) ||
          canonical(child.input) === canonical(task.input) ||
          seen.has(canonical(child.input))
        )
          throw new Error('Split repeats work or has invalid dependencies.');
        seen.add(canonical(child.input));
      }
      if (nodes + plan.length > limits.max_nodes || depth === limits.max_depth)
        throw new LocalTaskStop('budget_exhausted', 'Task node or depth allowance exhausted before split.');
      if (!(await step(() => ports.admitSplit(task, plan, abort.signal))))
        throw new LocalTaskStop('needs_human', 'The proposed split did not establish coverage and useful progress.');
      const ids = plan.map(() => `task-${++nodes}`);
      event(task, 'split', { children: plan.map((child, i) => ({ ...child, id: ids[i] })) });
      const jobs: Promise<unknown>[] = [];
      for (const [index, child] of plan.entries()) {
        jobs.push(
          (async () => {
            const dependencies = await Promise.all(child.depends_on.map((dep: number) => jobs[dep]!));
            check();
            return execute({ id: ids[index]!, parent: task.id, input: child.input, dependencies }, depth + 1, [
              ...ancestors,
              canonical(task.input),
            ]);
          })(),
        );
      }
      try {
        output = await Promise.all(jobs);
      } catch (error) {
        abort.abort();
        await Promise.allSettled(jobs);
        throw error;
      }
      event(task, 'join', { children: ids, output });
    } else if (band === 'tool_call') {
      event(task, 'act', { status: 'started' });
      output = await step(() => ports.act(task, abort.signal));
    } else if (band === 'escalate_gen') {
      requiresReview = true;
      event(task, 'generate', { reason: 'Decision selected generation beyond established operations.' });
      output = await step(() => ports.generate(task, abort.signal));
    } else throw new Error('Unknown decision band.');
    check();
    event(task, 'result', { output });
    return output;
  }
  try {
    if (!input.trim() || input.length > 16_000) throw new Error('Enter between 1 and 16,000 characters.');
    for (const [name, value] of Object.entries(limits))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}.`);
    const output = await execute(root, 0, []);
    return { status: 'completed', output, reason: null, nodes, requires_review: requiresReview };
  } catch (error) {
    const status = signal?.aborted ? 'cancelled' : error instanceof LocalTaskStop ? error.status : 'failed';
    const reason = error instanceof Error ? error.message : 'Execution failed.';
    event(root, 'stopped', { status, reason });
    return { status, output: null, reason, nodes, requires_review: requiresReview };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
