/** Offline complexity checks: count work, and report timings without timing-sensitive gates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal, acquireLock, replayKey, type JournalRecord } from './journal.ts';
import { execute, type Entry } from './engine.ts';
import { bindObservations } from './observations.ts';
import { bindingFor } from './binding.ts';
import { buildRequest } from './questions.ts';
import { tune } from './tune.ts';
import type { Provider } from './types.ts';

const entry: Entry = {
  item: { id: 'i', scenario_id: 's', site: 'loop.route', state: { task: 'read' }, gold: { decision: 'flash' } },
  split: 'holdout',
  set_digest: 'synthetic',
};
const provider: Provider = {
  id: 'fake',
  model: 'offline-fake',
  price: 0,
  serialize: JSON.stringify,
  async request() {
    return { status: 'ok', input_tokens: 0, answers: {} };
  },
};

test('report pending-intent matching visits call ids linearly within a binding', async (t) => {
  const binding = bindingFor(provider, entry, await buildRequest(entry.item));
  for (const n of [400, 800]) {
    let visits = 0;
    const records: JournalRecord[] = [];
    for (let i = 0; i < n; i++) {
      records.push({ type: 'intent', ...binding, call_id: `c${i}` });
      records.push({
        type: 'call',
        ...binding,
        get call_id() {
          visits++;
          return `c${i}`;
        },
        terminal: true,
      });
    }
    const result = await bindObservations(records, [provider], [entry], false);
    assert.equal(result.complete, true);
    assert.equal(result.bound[0]!.call_id, `c${n - 1}`);
    t.diagnostic(`report N=${n}: call-id visits=${visits}`);
    assert.ok(visits <= 3 * n, `matching ${n} intents inspected ${visits} call ids`);
  }
});

test('journal construction does not clone a snapshot nobody requested', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-clones-'));
  try {
    const path = join(dir, 'journal.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'call', nested: { saved: true } }) + '\n');
    const clone = t.mock.method(globalThis, 'structuredClone');
    const journal = new Journal(path, true);
    assert.equal(clone.mock.callCount(), 0);
    const rows = journal.read();
    rows[0]!.nested.saved = false;
    assert.equal(journal.read()[0]!.nested.saved, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('threshold selection does not reconstruct reporting diagnostics per candidate', () => {
  const selected = tune('loop.route', [
    {
      ...entry,
      split: 'tune',
      result: { status: 'ok', answers: { decision: { choice: 'flash', confidence: 0.95 } } },
      get latency_ms(): number {
        throw new Error('selection read report-only latency');
      },
      get cost_usd(): number {
        throw new Error('selection read report-only cost');
      },
    },
  ]);
  assert.equal(selected.tuning_status, 'selected');
});

test('execute scaling: locked zero-latency dispatch and cold completed resume', async (t) => {
  for (const n of [400, 800, 1600]) {
    const dir = mkdtempSync(join(tmpdir(), 'journal-scaling-'));
    let release = acquireLock(dir);
    let keys = 0,
      copiedRows = 0;
    const stringify = JSON.stringify,
      clone = structuredClone;
    const keyCounter = t.mock.method(JSON, 'stringify', (value: any, ...args: any[]) => {
      if (Array.isArray(value) && value.length === 7) keys++;
      return Reflect.apply(stringify, JSON, [value, ...args]);
    });
    const copyCounter = t.mock.method(globalThis, 'structuredClone', (value: any) => {
      if (Array.isArray(value)) copiedRows += value.length;
      return clone(value);
    });
    try {
      const path = join(dir, 'journal.jsonl');
      const entries = Array.from({ length: n }, (_, i) => ({ ...entry, item: { ...entry.item, id: `i${i}` } }));
      let dispatches = 0;
      const p: Provider = {
        ...provider,
        async request(request, signal) {
          dispatches++;
          return provider.request(request, signal);
        },
      };
      const options = { entries, providers: [p], maxSpend: 1, now: () => 0, sleep: async () => {} };
      const journal = new Journal(path);
      const start = process.hrtime.bigint();
      await execute({ ...options, journal });
      const dispatchMs = Number(process.hrtime.bigint() - start) / 1e6;
      assert.equal(dispatches, n);
      assert.equal(journal.length(), 2 * n);
      assert.equal(journal.spent(), 0);
      release();
      release = acquireLock(dir);
      const resumeStart = process.hrtime.bigint();
      await execute({ ...options, journal: new Journal(path) });
      const resumeMs = Number(process.hrtime.bigint() - resumeStart) / 1e6;
      assert.equal(dispatches, n, 'completed resume dispatches nothing');
      assert.equal(journal.length(), 2 * n);
      assert.equal(journal.recordsFor(replayKey(bindingFor(p, entries[0]!, await buildRequest(entry.item)))).length, 2);
      t.diagnostic(
        `N=${n}: execute=${dispatchMs.toFixed(2)} ms; cold resume=${resumeMs.toFixed(2)} ms; keys=${keys}; copied rows=${copiedRows}`,
      );
      assert.ok(keys <= 8 * n, `replay identity work must be linear: ${keys}`);
      assert.ok(copiedRows <= 8 * n, `snapshot copying must be linear: ${copiedRows}`);
    } finally {
      keyCounter.mock.restore();
      copyCounter.mock.restore();
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
