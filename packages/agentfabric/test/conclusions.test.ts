import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGrantAuthority } from '@weave/agentsop';
import { AgentFabricHost, FabricStore } from '@weave/agentfabric';

// The fallback lets the complexity assertion demonstrate the old full-copy cost.
function since(host: AgentFabricHost, cursor: number): readonly unknown[] {
  const incremental = host as AgentFabricHost & { conclusionsSince?: (cursor: number) => readonly unknown[] };
  return incremental.conclusionsSince?.(cursor) ?? host.conclusions();
}

describe('WV-N275 retained conclusion reads', () => {
  it('clones only the unread suffix, independent of the retained prefix size', (t) => {
    const host = new AgentFabricHost({ authority: createGrantAuthority() });
    for (let i = 0; i < 128; i++)
      host.retainConclusion({ conclusion_id: `conc:${i}`, output: { text: 'x'.repeat(1024) } });
    const clone = structuredClone;
    let clones = 0;
    t.mock.method(globalThis, 'structuredClone', (value: unknown) => {
      clones++;
      return clone(value);
    });
    const empty = since(host, 128);
    assert.equal(clones, 0, 'unchanged reads must clone zero retained conclusions');
    assert.deepEqual(empty, []);

    host.retainConclusion({ conclusion_id: 'conc:new', output: { text: 'new' } });
    clones = 0;
    const delta = since(host, 128);
    assert.equal(clones, 1, 'one appended conclusion must require one clone');
    assert.deepEqual(delta, [{ conclusion_id: 'conc:new', output: { text: 'new' } }]);
    (delta[0] as { output: { text: string } }).output.text = 'mutated';
    assert.deepEqual(since(host, 128), [{ conclusion_id: 'conc:new', output: { text: 'new' } }]);
    assert.deepEqual(empty, [], 'an earlier read stays a snapshot after a writer appends');
  });

  it('reads nothing for a cursor outside the non-negative integer offsets up to the retained length', (t) => {
    const host = new AgentFabricHost({ authority: createGrantAuthority() });
    for (const id of ['a', 'b', 'c']) host.retainConclusion({ conclusion_id: `conc:${id}` });
    const clone = structuredClone;
    let clones = 0;
    t.mock.method(globalThis, 'structuredClone', (value: unknown) => {
      clones++;
      return clone(value);
    });
    for (const cursor of [-1, -3, -Infinity, 0.5, 2.5, Number.NaN, 4, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      assert.deepEqual(host.conclusionsSince(cursor), [], `cursor ${cursor}`);
    }
    assert.equal(clones, 0, 'an out-of-range cursor clones nothing');
    assert.deepEqual(host.conclusionsSince(3), []);
    assert.deepEqual(host.conclusionsSince(2), [{ conclusion_id: 'conc:c' }]);
    assert.deepEqual(host.conclusionsSince(-0), host.conclusions());
    assert.equal(host.conclusions().length, 3);
  });

  it('rebuilds the same ordered suffixes after torn-tail repair and refuses a second writer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-n275-conclusions-'));
    const path = join(dir, 'fabric.jsonl');
    let store = FabricStore.open(path);
    const authority = createGrantAuthority();
    try {
      const host = new AgentFabricHost({ authority, store });
      const accepted = [{ conclusion_id: 'conc:a', output: { text: 'a' } }, 'ignored', { conclusion_id: 'conc:b' }];
      for (const item of accepted) host.retainConclusion(item);
      assert.throws(() => FabricStore.open(path), /already open/);
      const suffixes = accepted.map((_, cursor) => since(host, cursor));
      assert.deepEqual(
        suffixes,
        accepted.map((_, cursor) => accepted.slice(cursor)),
      );
      store.close();
      appendFileSync(path, '{"op":"conclusion","conclusion":');
      store = FabricStore.open(path);
      assert.equal(store.recovery.torn_tail_ignored, true);
      const recovered = new AgentFabricHost({ authority, store });
      assert.deepEqual(
        accepted.map((_, cursor) => since(recovered, cursor)),
        suffixes,
      );
      recovered.retainConclusion('after repair');
      assert.deepEqual(since(recovered, accepted.length), ['after repair']);
      store.close();
      store = FabricStore.open(path);
      assert.equal(store.recovery.torn_tail_ignored, false);
      const again = new AgentFabricHost({ authority, store });
      assert.deepEqual(since(again, 0), [...accepted, 'after repair']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not advance retained positions when serialization or persistence rejects an append', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-n275-conclusions-refused-'));
    const store = FabricStore.open(join(dir, 'fabric.jsonl'));
    const host = new AgentFabricHost({ authority: createGrantAuthority(), store });
    try {
      host.retainConclusion('accepted');
      assert.throws(() => host.retainConclusion(1n));
      assert.deepEqual(since(host, 1), []);
      host.retainConclusion('next');
      assert.deepEqual(since(host, 1), ['next']);
      store.close();
      assert.throws(() => host.retainConclusion('refused'), /closed/);
      assert.deepEqual(since(host, 2), []);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
