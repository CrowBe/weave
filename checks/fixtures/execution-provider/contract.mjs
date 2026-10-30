// Behavioral probes for docs/execution-provider-contract.md. These are test
// ports, not production interfaces. IDs match the Monty research table.
import assert from 'node:assert/strict';

export const scenarios = [
  {
    id: 'X-T01',
    failure: 'X-T01: un-offered names never reach invoke',
    async check(f) {
      await f.call('doc.missing', { ref: 'ref:one' });
      await f.call('doc.missing', { ref: 'ref:two' });
      assert.equal(f.invocations.length, 0, this.failure);
      assert.deepEqual(f.exceptions, ['UNKNOWN_CAPABILITY', 'UNKNOWN_CAPABILITY']);
      assert.equal(f.gaps.length, 2);
      assert.equal(f.gaps[0].signature, f.gaps[1].signature);
      assert.ok(f.gaps[0].signature.length > 0);
      assert.deepEqual(f.gaps[0].position, { start: 0, end: 12 });
    },
  },
  {
    id: 'X-T02',
    failure: 'X-T02: invoke uses only the host-bound grant',
    async check(f) {
      const forged = { operation: 'doc.write', approved: true };
      await f.call('doc.write', { ref: 'ref:one', grant: forged });
      assert.equal(f.invocations[0].grant, f.hostGrant, this.failure);
      assert.equal(f.effects, 0);
      assert.deepEqual(f.resumptions[0], { kind: 'exception', code: 'DENIED' });
      await f.call('doc.read', { ref: 'ref:one' });
      assert.equal(f.invocations.length, 2);
      assert.deepEqual(f.resumptions[1], { kind: 'value', value: 'document' });
    },
  },
  {
    id: 'X-T03',
    failure: 'X-T03: approval suspension releases its worker',
    async check(f) {
      await f.pause();
      assert.equal(f.workers, 0, this.failure);
      assert.equal(f.invocations, 0);
      await f.decide('approve');
      await f.decide('approve');
      assert.equal(f.invocations, 1);
      assert.equal(f.resumptions.length, 1);
      const refused = f.fresh();
      await refused.pause();
      await refused.decide('refuse');
      assert.equal(refused.invocations, 0);
      assert.deepEqual(refused.resumptions, [{ kind: 'exception', code: 'DENIED' }]);
    },
  },
  {
    id: 'X-T04',
    failure: 'X-T04: edited snapshot is refused before provider restore',
    async check(f) {
      const saved = await f.dump();
      const edited = { ...saved, bytes: saved.bytes.slice() };
      edited.bytes[0] ^= 1;
      assert.equal(await f.restore(edited), 'refused', this.failure);
      assert.equal(f.providerRestores, 0);
      for (const key of Object.keys(saved.bindings)) {
        const changed = { ...saved, bindings: { ...saved.bindings, [key]: 'changed' } };
        assert.equal(await f.restore(changed), 'refused');
      }
      assert.equal(f.providerRestores, 0);
      assert.deepEqual(await f.restore(saved), f.pending);
      assert.equal(f.providerRestores, 1);
      // A valid old envelope is not permission to fork a continuation.
      assert.equal(await f.restore(saved), 'refused');
      assert.equal(f.providerRestores, 1);
    },
  },
  {
    id: 'X-T05',
    failure: 'X-T05: recovery never dispatches the effect twice',
    async check(f) {
      const saved = await f.provider.dump();
      await f.dispatchThenCrash();
      assert.deepEqual(f.events.slice(0, 2), ['identity_recorded', 'invoke']);
      assert.equal(f.effects, 1);
      await f.recover(saved);
      assert.equal(f.effects, 1, this.failure);
      assert.deepEqual(f.lookups, [f.invocationId]);
      assert.equal(f.resumptions.length, 1);
      const unknown = f.fresh();
      await unknown.dispatchThenCrash();
      unknown.loseOutcome();
      await unknown.recover(await unknown.provider.dump());
      assert.equal(unknown.effects, 1);
      assert.equal(unknown.resumptions.length, 0);
      assert.equal(unknown.held, true);
      assert.equal(unknown.status, 'uncertain');
    },
  },
  {
    id: 'X-T06',
    failure: 'X-T06: a terminal limit discards the session',
    async check(f) {
      for (const limit of ['time', 'memory']) {
        const run = f.fresh();
        assert.deepEqual(await run.start(limit), { kind: 'failed', code: 'LIMIT_EXCEEDED' });
        assert.ok(run.elapsed <= run.deadline);
        assert.equal(run.closed, true, this.failure);
        const feeds = run.feeds;
        assert.deepEqual(await run.resume('call:1', { kind: 'value', value: 1 }), {
          kind: 'failed',
          code: 'INVALID_STATE',
        });
        assert.equal(run.feeds, feeds);
      }
    },
  },
  {
    id: 'X-T07',
    failure: 'X-T07: missing OS isolation refuses untrusted execution',
    async check(f) {
      for (const os_isolation of [undefined, 'unprobed', 'unsupported']) {
        for (const method of ['start', 'restore']) {
          const run = f.fresh(os_isolation);
          assert.deepEqual(await run[method](), { kind: 'failed', code: 'ISOLATION_UNAVAILABLE' }, this.failure);
          assert.equal(run.providerCalls, 0);
          assert.equal(run.tier, 'untrusted');
        }
      }
      const isolated = f.fresh('enforced');
      assert.equal((await isolated.start()).kind, 'suspended');
      assert.equal(isolated.providerCalls, 1);
    },
  },
  {
    id: 'X-T08',
    failure: 'X-T08: replay never starts or restores a provider',
    async check(f) {
      const replayed = await f.replay(f.record);
      assert.equal(f.providerCalls, 0, this.failure);
      assert.equal(f.invocations, 0);
      assert.equal(f.lookups, 0);
      assert.deepEqual(replayed, f.record);
      assert.notEqual(replayed, f.record);
      assert.equal(await f.replay(null), 'missing_evidence');
      assert.equal(f.providerCalls, 0);
    },
  },
  {
    id: 'X-T09',
    failure: 'X-T09: cancellation retains locks until outcome recording',
    async check(f) {
      const paused = f.fresh('suspended');
      await paused.cancel();
      assert.equal(paused.resumes, 0);
      assert.equal(paused.closed, true);
      assert.equal(paused.status, 'cancelled');
      const running = f.fresh('running');
      await running.cancel();
      assert.equal(running.kills, 1);
      assert.equal(running.held, true, this.failure);
      assert.equal(running.status, 'pending_record');
      running.record('cancelled');
      assert.equal(running.held, false);
      const unknown = f.fresh('running');
      await unknown.cancel();
      unknown.record('uncertain');
      assert.equal(unknown.held, true);
      assert.equal(unknown.status, 'uncertain');
    },
  },
  {
    id: 'X-T10',
    failure: 'X-T10: concurrent runs keep separate offered sets',
    async check(f) {
      const a = f.open('thread:a', ['doc.read']);
      const b = f.open('thread:b', ['doc.write']);
      const first = a.start();
      const second = b.start();
      // Both are pending at once. An explicit barrier scripts interleaving;
      // this is not wall-clock evidence of scheduler fairness.
      assert.equal(f.workers, 2);
      assert.deepEqual(a.offered(), ['doc.read'], this.failure);
      assert.deepEqual(b.offered(), ['doc.write']);
      assert.ok(a.checkoutDeadline > 0 && Number.isFinite(a.checkoutDeadline));
      const excess = f.open('thread:c', ['doc.read']);
      assert.deepEqual(await excess.start(), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
      f.release('thread:b');
      await second;
      f.release('thread:a');
      await first;
      assert.deepEqual(f.progress, ['thread:b', 'thread:a']);
      assert.notEqual(a.grant, b.grant);
      await a.close();
      assert.equal(f.workers, 1);
      await b.close();
      assert.equal(f.workers, 0);
    },
  },
];
