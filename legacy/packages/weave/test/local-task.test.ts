import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLocalTask, LocalTaskStop, type LocalTaskPorts, type LocalTaskEvent } from '../src/local-task.js';

function ports(overrides: Partial<LocalTaskPorts> = {}): LocalTaskPorts {
  return {
    extract: async (task) => task.input,
    decide: async () => 'tool_call',
    split: async () => [],
    admitSplit: async () => true,
    act: async (task) => ({ text: task.input.replace(/\s+/g, ' ').trim() }),
    generate: async () => 'novel output',
    ...overrides,
  };
}
const limits = { max_nodes: 16, max_depth: 8, concurrency: 2 };

test('an unclear decision uses one clarification call and does not execute an action', async () => {
  let questions = 0;
  let actions = 0;
  const result = await runLocalTask(
    'convert the recipe PDF',
    ports({
      decide: async () => {
        throw new LocalTaskStop('needs_human', 'uncertain band');
      },
      clarify: async (task: { input: string }, reason: string) => {
        questions++;
        assert.equal(task.input, 'convert the recipe PDF');
        assert.equal(reason, 'uncertain band');
        return 'Would you like Markdown or a Word document?';
      },
      act: async () => {
        actions++;
        return 'must not execute';
      },
    }),
    limits,
  );
  assert.equal(result.status, 'needs_human');
  assert.equal(result.question, 'Would you like Markdown or a Word document?');
  assert.equal(result.output, null);
  assert.equal(questions, 1);
  assert.equal(actions, 0);
});

test('failed or cancelled clarification never invents a question or completes the task', async () => {
  const failed = await runLocalTask(
    'ambiguous request',
    ports({
      decide: async () => 'ask_human',
      clarify: async () => {
        throw new Error('unavailable');
      },
    }),
    limits,
  );
  assert.equal(failed.status, 'needs_human');
  assert.equal(failed.question, null);
  const abort = new AbortController();
  const cancelled = await runLocalTask(
    'ambiguous request',
    ports({
      decide: async () => 'ask_human',
      clarify: async () => {
        abort.abort();
        return 'A late question?';
      },
    }),
    limits,
    abort.signal,
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.question, null);
});

test('a real operation result is preserved; a capability exception fails the run', async () => {
  const result = await runLocalTask(' normalize this ', ports(), limits);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output, { text: 'normalize this' });
  const failed = await runLocalTask(
    'x',
    ports({
      act: async () => {
        throw new Error('host refused');
      },
    }),
    limits,
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.output, null);
});

test('children recurse, independent work overlaps, and a dependency waits for its result', async () => {
  const events: LocalTaskEvent[] = [];
  const finished: string[] = [];
  let active = 0;
  let peak = 0;
  const result = await runLocalTask(
    'root',
    ports({
      decide: async (task) => (['root', 'nested'].includes(task.input) ? 'spawn_subtasks' : 'tool_call'),
      split: async (task) =>
        task.input === 'root'
          ? [
              { input: 'a', depends_on: [] },
              { input: 'b', depends_on: [] },
              { input: 'nested', depends_on: [0, 1] },
            ]
          : [
              { input: 'c', depends_on: [] },
              { input: 'd', depends_on: [0] },
            ],
      act: async (task) => {
        if (task.input === 'c') assert.deepEqual(finished.slice(0, 2).sort(), ['a', 'b']);
        if (task.input === 'd') assert.deepEqual(task.dependencies, [{ text: 'c' }]);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        finished.push(task.input);
        return { text: task.input };
      },
    }),
    limits,
    undefined,
    (event) => events.push(event),
  );
  assert.equal(result.status, 'completed');
  assert.equal(peak, 2);
  assert.equal(result.nodes, 6);
  assert.equal(events.filter((event) => event.stage === 'join').length, 2);
});

test('invalid, cyclic, duplicate, repeated or unhelpful plans execute no child', async () => {
  for (const plan of [
    [
      { input: 'a', depends_on: [1] },
      { input: 'b', depends_on: [0] },
    ],
    [
      { input: 'a', depends_on: [] },
      { input: 'a', depends_on: [] },
    ],
    [
      { input: 'root', depends_on: [] },
      { input: 'b', depends_on: [] },
    ],
  ]) {
    let acted = false;
    const result = await runLocalTask(
      'root',
      ports({
        decide: async () => 'spawn_subtasks',
        split: async () => plan,
        act: async () => {
          acted = true;
          return null;
        },
      }),
      limits,
    );
    assert.equal(result.status, 'failed');
    assert.equal(acted, false);
  }
  const denied = await runLocalTask(
    'root',
    ports({
      decide: async () => 'spawn_subtasks',
      split: async () => [
        { input: 'a', depends_on: [] },
        { input: 'b', depends_on: [] },
      ],
      admitSplit: async () => false,
    }),
    limits,
  );
  assert.equal(denied.status, 'needs_human');
});

test('node limit refuses the entire split, and cancellation never reports completion', async () => {
  const budget = await runLocalTask(
    'root',
    ports({
      decide: async () => 'spawn_subtasks',
      split: async () => [
        { input: 'a', depends_on: [] },
        { input: 'b', depends_on: [] },
      ],
    }),
    { ...limits, max_nodes: 2 },
  );
  assert.equal(budget.status, 'budget_exhausted');
  const abort = new AbortController();
  const cancelled = await runLocalTask(
    'root',
    ports({
      act: async () => {
        abort.abort();
        return 'late';
      },
    }),
    limits,
    abort.signal,
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.output, null);
});

test('generation is explicit and requires review, including through a join', async () => {
  const result = await runLocalTask(
    'root',
    ports({
      decide: async (task) => (task.input === 'root' ? 'spawn_subtasks' : 'escalate_gen'),
      split: async () => [
        { input: 'a', depends_on: [] },
        { input: 'b', depends_on: [] },
      ],
    }),
    limits,
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.requires_review, true);
});
