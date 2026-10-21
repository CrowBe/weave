/** A billed promotional refusal remains evidence across journal recovery. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { it } from 'node:test';
import { vercelAiGatewayFreeAdapter, VERCEL_AI_GATEWAY_FREE_MODELS } from '@weave/gateway/vercel-ai-gateway';
import { FileJournal, MemoryJournal, Runtime, ScriptedDecisionLayer, fixtureGateway, recover, replay,
  type InferenceRecordedPayload } from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import { ALPHA, BETA, CONTENT, goalOpened, registered } from './fixture.js';
import { variantGoal } from './m2-fixture.js';

for (const crash of ['after inference.recorded', 'after action.result'] as const) {
  it(`preserves a reported promotional charge once on crash/recovery/replay ${crash}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wv018-cost-'));
    try {
      const journal = new FileJournal(join(directory, 'observations.jsonl'));
      const host = new FakeHost(new FixtureEnvironment());
      const decisionLayer = new ScriptedDecisionLayer();
      let calls = 0;
      const model = VERCEL_AI_GATEWAY_FREE_MODELS.nemotron;
      const adapter = vercelAiGatewayFreeAdapter({ apiKey: 'synthetic-wv018-journal', now: () => 0,
        catalogue: { data: [{ id: model, pricing: { input: '0', output: '0' } }] },
        fetch: async () => {
          calls++;
          return Response.json({ content: [{ type: 'text', text: 'refused' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 2 }, outputTokens: { total: 1 } },
            providerMetadata: { gateway: { cost: '0.01' } } });
        } });
      // Exercise the real adapter through the existing synthetic framing route.
      const gateway = fixtureGateway({ clock: { now: () => 0 }, generate: {
        id: 'fixture.generate', execute: call => adapter.execute({ ...call, model }),
      } });
      const runtime = new Runtime({ host, decisionLayer, journal, gateway });
      for (const resource of [ALPHA, BETA]) runtime.observe(registered(resource, CONTENT[resource]!));
      runtime.operator.submit(goalOpened(variantGoal()));
      const action = Object.values(runtime.state().actions).find(a => a.operation === 'goal.frame');
      assert.ok(action);
      await runtime.settle(action.action_id);
      const durable = new FileJournal(journal.path).snapshot();
      const billed = durable.find(o => o.payload_type === 'inference.recorded');
      assert.ok(billed && billed.validation.status === 'accepted');
      const payload = billed.payload as InferenceRecordedPayload;
      assert.equal(payload.spent, 10_000);
      assert.equal(payload.attempts.length, 1);
      assert.equal(payload.attempts[0]?.cost, 10_000);
      assert.equal(payload.attempts[0]?.cost_is_upper_bound, false);
      assert.equal(payload.status, 'unaccepted');
      assert.equal(runtime.state().budget.cost.spent, 10_000);
      const recorded = crash === 'after inference.recorded' ? durable.filter(o => o.seq <= billed.seq) : durable;
      const restoredJournal = new MemoryJournal(recorded);
      const restored = recover(restoredJournal.snapshot(), { host, decisionLayer, journal: restoredJournal, gateway });
      assert.equal(restored.state().budget.cost.spent, 10_000);
      assert.equal(restored.state().budget.cost.reserved, 0);
      // A repeated recorded arrival must be rejected rather than charged twice.
      const { seq: _seq, validation: _validation, ...arrival } = billed;
      const duplicate = restored.feed({ ...arrival, observation_id: 'duplicate-billed-response' });
      assert.equal(duplicate.validation.status, 'rejected');
      assert.equal(restored.state().budget.cost.spent, 10_000);
      const again = recover(restoredJournal.snapshot(), { host, decisionLayer, gateway });
      assert.equal(again.state().budget.cost.spent, 10_000);
      const replayed = replay(durable, { host: new FakeHost(new FixtureEnvironment()), decisionLayer, gateway });
      assert.equal(replayed.ok, true);
      assert.equal(replayed.state.budget.cost.spent, 10_000);
      await setImmediate();
      assert.equal(calls, 1, 'recovery and replay must not dispatch another billed attempt');
      assert.ok(!JSON.stringify(durable).includes('synthetic-wv018-journal'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
