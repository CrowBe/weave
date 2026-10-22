/**
 * W5 acceptance 5 (#187): emission never touches authority. Single-use grants
 * are issued, consumed and revoked exactly as without a sink, no record holds
 * or names one, and a benchmark gets a sink only by composing one.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGrantAuthority, type Grant, type GrantAuthority } from '@weave/agentsop';
import { collector, runW5, w5World, type Rec, type W5Sinks } from './w5-fixture.js';

interface Ledger {
  readonly authority: GrantAuthority;
  readonly calls: string[];
  readonly issued: Grant[];
}

/** Delegates to a real authority and records every call, by action id. */
function ledger(): Ledger {
  const inner = createGrantAuthority();
  const calls: string[] = [];
  const issued: Grant[] = [];
  const authority: GrantAuthority = {
    issue(fields) {
      const grant = inner.issue(fields);
      issued.push(grant);
      calls.push(`issue ${fields.action_id}`);
      return grant;
    },
    isIssued(grant) {
      calls.push(`isIssued ${grant?.action_id ?? 'none'}`);
      return inner.isIssued(grant);
    },
    isValid(grant) {
      calls.push(`isValid ${grant?.action_id ?? 'none'}`);
      return inner.isValid(grant);
    },
    markInvoked(grant) {
      const first = inner.markInvoked(grant);
      calls.push(`markInvoked ${grant.action_id} ${first}`);
      return first;
    },
    revoke(grant) {
      calls.push(`revoke ${grant.action_id}`);
      inner.revoke(grant);
    },
  };
  return { authority, calls, issued };
}

async function run(sinks: W5Sinks): Promise<Ledger> {
  const book = ledger();
  await runW5(w5World(sinks, { authority: book.authority }));
  return book;
}

/** Every object reachable from a value. */
function objects(value: unknown, into: object[] = []): object[] {
  if (value !== null && typeof value === 'object') {
    into.push(value);
    for (const inner of Object.values(value)) objects(inner, into);
  }
  return into;
}

const repoRoot = new URL('../../../../', import.meta.url).pathname;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Benchmarks that compose a Weft port. Opting in is adding the file here, deliberately. */
const OPTED_IN: readonly string[] = [];

describe('W5 authority and opt-in', () => {
  it('W5-T40 grant issuance, consumption and revocation are the same with any sink', async () => {
    const plain = await run({});
    assert.ok(plain.issued.length >= 5);
    const throwing = () => {
      throw new Error('sink down');
    };
    for (const sinks of [
      { loom: collector().sink, gateway: collector().sink, fabric: collector().sink },
      { loom: throwing, gateway: throwing, fabric: throwing },
    ]) {
      const traced = await run(sinks);
      assert.deepEqual(traced.calls, plain.calls);
    }
    // Each grant was consumed at most once.
    const consumed = plain.calls.filter((call) => call.startsWith('markInvoked') && call.endsWith(' true'));
    assert.equal(new Set(consumed).size, consumed.length);
  });

  it('W5-T41 no record holds a grant, or any object the authority issued', async () => {
    const seen = collector();
    const book = await run({ loom: seen.sink, gateway: seen.sink, fabric: seen.sink });
    const issued = new Set<object>(book.issued);
    for (const record of seen.records) {
      for (const inner of objects(record)) {
        assert.equal(issued.has(inner), false, `${record.record_id} holds an issued grant`);
        assert.equal(book.authority.isIssued(inner as Grant), false, `${record.record_id} carries an issued grant`);
      }
      const text = JSON.stringify(record);
      for (const key of ['"grant"', '"permissions"', '"effects"', '"issued_at"']) {
        assert.equal(text.includes(key), false, `${record.record_id} names ${key}`);
      }
    }
  });

  it('W5-T42 a sink that re-presents what it received cannot start, repeat or commit work', async () => {
    const book = ledger();
    const kept: Rec[] = [];
    const world = w5World(
      { loom: (r) => void kept.push(r), fabric: (r) => void kept.push(r) },
      { authority: book.authority },
    );
    await runW5(world);
    const before = world.host.invocations.length;
    // The host reports each rejection to the same sink, so walk what it had received.
    for (const record of [...kept]) {
      for (const candidate of objects(record)) {
        const handle = world.host.invoke(candidate as Grant, 'source.inspect', { source: world.alpha });
        assert.equal(handle.kind, 'rejected', `${record.record_id} was accepted as a grant`);
      }
    }
    assert.equal(world.host.invocations.length, before);
  });

  it('W5-T43 no benchmark composes a Weft port unless it opts in', () => {
    const composing = sources(join(repoRoot, 'benchmarks')).filter((file) =>
      /\bweft\s*:/.test(readFileSync(file, 'utf8')),
    );
    assert.deepEqual(
      composing.map((file) => file.slice(repoRoot.length)),
      [...OPTED_IN],
    );
  });
});
