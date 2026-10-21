/**
 * WV-026c — Loom's internal readers use an uncloned read-only view. The public
 * state() accessor remains a detached snapshot for hosts and tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stableStringify, type State } from '@weave/weave';
import { ALPHA, scenario, tick } from './fixture.js';

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
