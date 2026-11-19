/**
 * WV-026c — Loom's internal readers use an uncloned read-only view. The public
 * state() accessor remains a detached snapshot for hosts and tests.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type {
  CapabilityContract,
  CapabilityHost,
  DescribeResult,
  Grant,
  InvocationHandle,
  InvocationRejected,
  LookupResult,
  ResourceRef,
} from '@weave/agentsop';
import { REPORT_PUBLISH } from '@weave/agentfabric';
import {
  Runtime,
  ScriptedDecisionLayer,
  replay,
  stableStringify,
  type DecisionLayer,
  type InferenceRequestedPayload,
  type State,
  type WeighRequest,
  type WeightEntry,
} from '@weave/weave';
import {
  ALPHA,
  BETA,
  CONTENT,
  GAMMA,
  FailingDecisionLayer,
  actionIdFor,
  baseGoal,
  candidatesFor,
  cycles,
  goalOpened,
  inspectCandidate,
  registered,
  release,
  scenario,
  tick,
} from './fixture.js';
import { FakeHost, FixtureEnvironment } from './fake-host.js';

function isState(value: unknown): value is State {
  return (
    value !== null &&
    typeof value === 'object' &&
    'state_revision' in value &&
    'goal' in value &&
    'sources' in value &&
    'actions' in value &&
    'inferences' in value
  );
}

describe('WV-026c state access', () => {
  it('WV-026c-T01 a cycle does not clone state for internal readers', () => {
    const s = scenario();
    const original = globalThis.structuredClone;
    let stateClones = 0;
    try {
      globalThis.structuredClone = function <T>(value: T, options?: Parameters<typeof original>[1]): T {
        if (isState(value)) {
          stateClones += 1;
        }
        return original(value, options);
      };
      s.runtime.clock.submit(tick(1));
    } finally {
      globalThis.structuredClone = original;
    }
    assert.equal(stateClones, 0, `a cycle cloned state ${stateClones} times`);
  });

  it('WV-026c-T02 mutating state() output cannot change the runtime', () => {
    const s = scenario();
    const before = stableStringify(s.runtime.state());
    const detached = s.runtime.state() as unknown as {
      goal: { purpose: string } | null;
      sources: Record<string, { revision: number }>;
      inferences: Record<string, unknown>;
    };
    assert.ok(detached.goal);
    detached.goal.purpose = 'tampered';
    const alpha = detached.sources[ALPHA];
    assert.ok(alpha);
    alpha.revision = 999;
    detached.inferences.forged = { request_id: 'forged' };
    assert.equal(stableStringify(s.runtime.state()), before);
  });

  it('WV-026c-T03 internal readers do not write the internal view', () => {
    const s = scenario();
    const internals = s.runtime as unknown as {
      current: Record<PropertyKey, unknown>;
      transitionLock: boolean;
    };
    const unlockedWrites: string[] = [];
    const proxies = new WeakMap<object, object>();
    const readonly = (value: unknown, path: string): unknown => {
      if (value === null || typeof value !== 'object') {
        return value;
      }
      const cached = proxies.get(value);
      if (cached) {
        return cached;
      }
      const proxy = new Proxy(value, {
        get(target, property, receiver) {
          return readonly(Reflect.get(target, property, receiver), `${path}.${String(property)}`);
        },
        set(target, property, next) {
          if (!internals.transitionLock) {
            unlockedWrites.push(`${path}.${String(property)}`);
          }
          return Reflect.set(target, property, next);
        },
        deleteProperty(target, property) {
          if (!internals.transitionLock) {
            unlockedWrites.push(`delete ${path}.${String(property)}`);
          }
          return Reflect.deleteProperty(target, property);
        },
      });
      proxies.set(value, proxy);
      return proxy;
    };
    internals.current = readonly(internals.current, 'state') as Record<PropertyKey, unknown>;
    s.runtime.clock.submit(tick(1));
    assert.deepEqual(unlockedWrites, [], 'state changed outside applyAccepted');
  });
});
class MutatingDecisionLayer implements DecisionLayer {
  readonly implementation = 'mutating@1';
  private readonly base = new ScriptedDecisionLayer();
  assembleMutated = false;
  publishMutated = false;

  constructor(private readonly target: 'assemble' | 'publish' | 'both' = 'both') {}

  weigh(request: WeighRequest): readonly WeightEntry[] {
    for (const candidate of request.candidates) {
      if (candidate.operation === 'report.assemble' && this.target !== 'publish') {
        const inspections = (candidate.inputs as { inspections?: { digest?: string }[] }).inspections;
        const first = inspections?.[0];
        if (first) {
          first.digest = 'tampered';
          this.assembleMutated = true;
        }
      }
      if (candidate.operation === 'report.publish' && this.target !== 'assemble') {
        const report = (candidate.inputs as { report?: { entries?: { digest?: string }[] } }).report;
        const first = report?.entries?.[0];
        if (first) {
          first.digest = 'tampered';
          this.publishMutated = true;
        }
      }
    }
    return this.base.weigh(request);
  }
}

class PublishHost implements CapabilityHost {
  constructor(private readonly base: FakeHost) {}

  operations(): readonly string[] {
    return [...new Set([...this.base.operations(), 'report.publish'])].sort();
  }

  describe(operation: string): DescribeResult {
    return operation === 'report.publish'
      ? { kind: 'contract', contract: REPORT_PUBLISH as CapabilityContract }
      : this.base.describe(operation);
  }

  invoke(grant: Grant | null, operation: string, inputs: unknown): InvocationHandle | InvocationRejected {
    if (operation === 'report.publish') {
      return { kind: 'rejected', code: 'DENIED', reason: 'test host does not publish' };
    }
    return this.base.invoke(grant, operation, inputs);
  }

  canonicalResource(ref: ResourceRef): ResourceRef {
    return this.base.canonicalResource(ref);
  }

  lookup(invocation_id: string): LookupResult {
    return this.base.lookup(invocation_id);
  }

  requestCancel(invocation_id: string): { readonly acknowledged: true } {
    return this.base.requestCancel(invocation_id);
  }
}

function reportDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function releaseFromHost(host: FakeHost, runtime: Runtime, action_id: string): Promise<void> {
  host.release(action_id);
  await runtime.settle(action_id);
}

describe('WV-026c external state boundaries', () => {
  it('WV-026c-T04 report.assemble inputs are detached from state and recorded evidence', async () => {
    const layer = new MutatingDecisionLayer('assemble');
    const s = scenario({ decisionLayer: layer });
    const first = cycles(s)[0];
    assert.ok(first);
    const alpha = inspectCandidate(first, ALPHA);
    const beta = inspectCandidate(first, BETA);
    assert.ok(alpha);
    assert.ok(beta);
    const alphaAction = actionIdFor(first, alpha.candidate_id);
    await release(s, actionIdFor(first, beta.candidate_id));
    await release(s, alphaAction);
    assert.equal(layer.assembleMutated, true, 'the assemble candidate did not reach the decision layer');

    const expected = reportDigest(CONTENT[ALPHA] as string);
    const inspected = s.runtime.state().inspections[ALPHA];
    assert.equal(inspected?.result.digest, expected);
    const result = s.runtime
      .trace()
      .observations.find(
        (observation) =>
          observation.payload_type === 'action.result' &&
          (observation.payload as { action_id: string }).action_id === alphaAction,
      );
    assert.ok(result);
    const output = (result.payload as { outcome: { output: { digest: string } } }).outcome.output;
    assert.equal(output.digest, expected);
  });

  it('WV-026c-T05 report.publish inputs are detached from state and recorded evidence', async () => {
    const layer = new MutatingDecisionLayer('publish');
    const environment = new FixtureEnvironment();
    const host = new FakeHost(environment);
    const runtime = new Runtime({ host: new PublishHost(host), decisionLayer: layer });
    for (const resource of [ALPHA, BETA, GAMMA]) {
      const content = CONTENT[resource] as string;
      environment.register(resource, content);
      runtime.observe(registered(resource, content));
    }
    runtime.operator.submit(
      goalOpened(
        baseGoal({
          destination: GAMMA,
          authority: { read: [ALPHA, BETA], write: [GAMMA] },
          budget: { actions: 8, judgments: 8 },
        }),
      ),
    );
    const first = runtime.trace().cycles[0];
    assert.ok(first);
    const alpha = inspectCandidate(first, ALPHA);
    const beta = inspectCandidate(first, BETA);
    assert.ok(alpha);
    assert.ok(beta);
    await releaseFromHost(host, runtime, actionIdFor(first, beta.candidate_id));
    await releaseFromHost(host, runtime, actionIdFor(first, alpha.candidate_id));
    const assembleCycle = runtime.trace().cycles.at(-1);
    assert.ok(assembleCycle);
    const assemble = candidatesFor(assembleCycle, 'report.assemble')[0];
    assert.ok(assemble);
    const assembleAction = actionIdFor(assembleCycle, assemble.candidate_id);
    await releaseFromHost(host, runtime, assembleAction);
    assert.equal(layer.publishMutated, true, 'the publish candidate did not reach the decision layer');

    const expected = reportDigest(CONTENT[ALPHA] as string);
    const report = runtime.state().report?.report;
    assert.ok(report);
    assert.equal(report.entries[0]?.digest, expected);
    const result = runtime
      .trace()
      .observations.find(
        (observation) =>
          observation.payload_type === 'action.result' &&
          (observation.payload as { action_id: string }).action_id === assembleAction,
      );
    assert.ok(result);
    const output = (result.payload as { outcome: { output: { entries: { digest: string }[] } } }).outcome.output;
    assert.equal(output.entries[0]?.digest, expected);
  });

  it('WV-026c-T06 shared views keep the captured cycle-start revision and replay a pre-change journal', () => {
    const environment = new FixtureEnvironment();
    const host = new FakeHost(environment);
    environment.register(ALPHA, CONTENT[ALPHA] as string);
    const runtime = new Runtime({ host, decisionLayer: new ScriptedDecisionLayer(), shareAssemblies: true });
    runtime.observe(registered(ALPHA, CONTENT[ALPHA] as string));
    runtime.operator.submit(
      goalOpened(
        baseGoal({
          framing: true,
          sources: [ALPHA],
          authority: { read: [ALPHA] },
          budget: { actions: 4, judgments: 4 },
        }),
      ),
    );

    const trace = runtime.trace();
    const request = trace.observations.find(
      (observation) =>
        observation.payload_type === 'inference.requested' &&
        (observation.payload as InferenceRequestedPayload).site === 'goal.frame',
    );
    assert.ok(request);
    const requested = request.payload as InferenceRequestedPayload;
    const started = trace.observations.find(
      (observation) =>
        observation.payload_type === 'action.started' &&
        (observation.payload as { operation: string }).operation === 'goal.frame',
    );
    assert.ok(started);
    const startedAction = (started.payload as { action_id: string }).action_id;
    const cycle = trace.cycles.find((item) => item.selected.some((selected) => selected.action_id === startedAction));
    assert.ok(cycle);
    assert.equal(requested.view.state_revision, cycle.state_revision);
    assert.equal(
      requested.view.manifest.slices.find((slice) => slice.name === 'goal')?.assembly_id,
      `asm:${cycle.state_revision}:goal+registered`,
    );

    const recorded = trace.observations.map((observation) => {
      const copy = structuredClone(observation);
      if (copy.payload_type !== 'inference.requested') {
        return copy;
      }
      const payload = copy.payload as InferenceRequestedPayload;
      if (payload.site !== 'goal.frame') {
        return copy;
      }
      const view = {
        ...payload.view,
        state_revision: cycle.state_revision,
        manifest: {
          slices: payload.view.manifest.slices.map((slice) => ({
            ...slice,
            assembly_id: slice.assembly_id?.replace(
              `asm:${payload.view.state_revision}:`,
              `asm:${cycle.state_revision}:`,
            ),
          })),
        },
      };
      return { ...copy, payload: { ...payload, view } };
    });
    const result = replay(recorded, {
      host: new FakeHost(new FixtureEnvironment()),
      decisionLayer: new FailingDecisionLayer(),
      shareAssemblies: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : result.failure.reason);
  });
});
