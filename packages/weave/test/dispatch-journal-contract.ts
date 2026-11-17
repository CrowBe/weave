/**
 * Contract every `DispatchJournal` passes. The rules are the ones on that interface.
 * `make` is called once per case and must return a fresh journal.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DECIDE1_RULE_TABLE } from '../src/decide1.js';
import type {
  DispatchCheckpoint,
  DispatchDecision,
  DispatchIntent,
  DispatchJournal,
  DispatchReceipt,
} from '../src/dispatch.js';

const DECISION = 'd1';

type Loaded = ReturnType<DispatchJournal['load']>;

/** The live attempt on a claimed or presented slot, else null. */
export function attemptOf(loaded: Loaded): string | null {
  const { slot } = loaded;
  return slot.phase === 'claimed' || slot.phase === 'presented' ? slot.attempt : null;
}

/** An attempt presented the claimed intent and no receipt has been appended since. */
export function isPresented(loaded: Loaded): boolean {
  return loaded.slot.phase === 'presented';
}

const intent: DispatchIntent = { kind: 'capability', dispatch_id: 'd1:dispatch' };

function checkpoint(decision_id: string): DispatchCheckpoint {
  return {
    schema: 'dispatch.checkpoint@5',
    decision_id,
    state_revision: 1,
    state_updated_at: 10,
    asks: { intake: 0, triage: 0, route: 0, shadow: 0, preflight: 0 },
    intake: null,
    triage: null,
    route: null,
    shadow: null,
    preflight: null,
    preflight_budget: null,
    spawn_port: false,
    preflight_terms: null,
    child_terms: null,
    child: null,
    intent: null,
  };
}

function decision(patch: Partial<DispatchDecision>): DispatchDecision {
  return {
    schema: 'dispatch.decision@6',
    rule_table: DECIDE1_RULE_TABLE,
    decide1: { judgments: [], facts: [], rule: 'hold.outage', band: 'tool_call' },
    decision_id: DECISION,
    entry: 1,
    state_revision: 1,
    decided_by: 'triage',
    choice: 'capability',
    status: 'paused',
    reason: 'dispatch_unconfirmed',
    child: null,
    intent: null,
    receipt: null,
    intake: null,
    triage: null,
    route: null,
    shadow: null,
    preflight: null,
    ...patch,
  };
}

/** A resumable pause keeps the decision open and carries no receipt. */
function pause(entry: number, decision_id = DECISION): DispatchDecision {
  return decision({ decision_id, entry, intent, status: 'paused', reason: 'dispatch_unconfirmed' });
}

function settled(entry: number): DispatchDecision {
  const receipt: DispatchReceipt = { status: 'dispatched', dispatch_id: intent.dispatch_id, ref: `action:${entry}` };
  return decision({ entry, intent, receipt, status: 'dispatched', reason: 'accepted' });
}

function issued(attempt: string | null): string {
  if (typeof attempt !== 'string' || attempt.length === 0) assert.fail('expected an attempt id');
  return attempt;
}

function picture(journal: DispatchJournal, decision_id = DECISION) {
  return structuredClone(journal.load(decision_id));
}

export function dispatchJournalContract(name: string, make: () => DispatchJournal): void {
  describe(`${name} dispatch journal`, () => {
    test('claim succeeds once per decision', () => {
      const journal = make();
      const rival: DispatchIntent = { kind: 'decline', dispatch_id: 'd1:decline' };
      assert.equal(journal.claim(DECISION, intent, checkpoint(DECISION)), true);
      const claimed = picture(journal);
      assert.deepEqual(claimed.checkpoint?.intent, intent);
      assert.equal(attemptOf(claimed), null);
      assert.equal(isPresented(claimed), false);

      assert.equal(journal.claim(DECISION, intent, checkpoint(DECISION)), false);
      assert.equal(journal.claim(DECISION, rival, { ...checkpoint(DECISION), state_revision: 99 }), false);
      assert.deepEqual(picture(journal), claimed);

      assert.equal(journal.claim('d2', rival, checkpoint('d2')), true);
      assert.deepEqual(picture(journal), claimed);
      assert.deepEqual(picture(journal, 'd2').checkpoint?.intent, rival);
      assert.equal(journal.claim('d2', intent, checkpoint('d2')), false);
      assert.deepEqual(picture(journal, 'd2').checkpoint?.intent, rival);

      const closed = make();
      assert.equal(
        closed.append(decision({ status: 'needs_human', reason: 'accepted', choice: 'needs_human', intent: null })),
        true,
      );
      const terminal = picture(closed);
      assert.equal(terminal.decisions.length, 1);
      assert.equal(terminal.checkpoint, null);
      assert.equal(closed.claim(DECISION, intent, checkpoint(DECISION)), false);
      assert.deepEqual(picture(closed), terminal);
      assert.equal(closed.acquire(DECISION), null);
    });

    test('acquire returns null without a claim and while an attempt is live', () => {
      const journal = make();
      const empty = picture(journal);
      assert.equal(journal.acquire(DECISION), null);
      assert.equal(journal.acquire(DECISION, 'pending'), null);
      assert.deepEqual(picture(journal), empty);
      assert.equal(attemptOf(empty), null);
      assert.deepEqual(empty.decisions, []);

      assert.equal(journal.claim(DECISION, intent), true);
      const live = issued(journal.acquire(DECISION));
      const held = picture(journal);
      assert.equal(attemptOf(held), live);
      assert.equal(journal.acquire(DECISION), null);
      assert.deepEqual(picture(journal), held);

      assert.equal(journal.acquire('d2'), null);
      assert.equal(attemptOf(picture(journal, 'd2')), null);
      assert.equal(attemptOf(journal.load(DECISION)), live);
    });

    test('attempt ids are never reissued', () => {
      const journal = make();
      assert.equal(journal.claim(DECISION, intent), true);
      const seen = new Set<string>();
      const take = (attempt: string | null): string => {
        if (attempt === null || seen.has(attempt)) {
          assert.fail(attempt === null ? 'expected a fresh attempt id' : `reissued attempt id ${attempt}`);
        }
        seen.add(attempt);
        return attempt;
      };

      const released = take(journal.acquire(DECISION));
      journal.release(DECISION, released);
      const superseded = take(journal.acquire(DECISION));
      const replacement = take(journal.acquire(DECISION, superseded));
      assert.notEqual(replacement, superseded);
      assert.equal(journal.append(pause(1), { attempt: replacement }), true);
      const appended = take(journal.acquire(DECISION));
      assert.equal(journal.append(pause(2), { attempt: appended }), true);
      const again = take(journal.acquire(DECISION));
      journal.release(DECISION, again);
      const latest = take(journal.acquire(DECISION));
      assert.equal(seen.size, 6);
      assert.equal(attemptOf(journal.load(DECISION)), latest);
      for (const retired of [released, superseded, replacement, appended, again]) {
        assert.equal(seen.has(retired), true);
        assert.notEqual(latest, retired);
      }
    });

    test('release only retires the live attempt', () => {
      const journal = make();
      assert.equal(journal.claim(DECISION, intent), true);
      const live = issued(journal.acquire(DECISION));
      const held = picture(journal);

      journal.release(DECISION, `${live}:other`);
      assert.deepEqual(picture(journal), held, 'a non-live attempt is left alone');

      assert.equal(journal.claim('d2', intent), true);
      const other = issued(journal.acquire('d2'));
      assert.notEqual(other, live);
      journal.release(DECISION, other);
      journal.release('d2', live);
      assert.equal(attemptOf(journal.load(DECISION)), live);
      assert.equal(attemptOf(journal.load('d2')), other);

      journal.release(DECISION, live);
      assert.equal(attemptOf(journal.load(DECISION)), null);
      assert.equal(attemptOf(journal.load('d2')), other);
      assert.equal(journal.append(pause(1), { attempt: live }), false);
      assert.deepEqual(journal.load(DECISION).decisions, []);

      const next = issued(journal.acquire(DECISION));
      assert.notEqual(next, live);
      journal.release(DECISION, live);
      journal.release('d2', next);
      journal.release(DECISION, other);
      assert.equal(attemptOf(journal.load(DECISION)), next, 'a retired attempt releases nothing');
      assert.equal(attemptOf(journal.load('d2')), other, 'an attempt live on another decision is left alone');

      assert.equal(journal.append(pause(1, 'd2'), { attempt: other }), true);
      assert.equal(attemptOf(journal.load('d2')), null);
      assert.equal(attemptOf(journal.load(DECISION)), next);
    });

    test('present returns false and writes nothing for a non-live or retired attempt', () => {
      const journal = make();
      const empty = picture(journal);
      assert.equal(journal.present(DECISION, 'absent'), false);
      assert.deepEqual(picture(journal), empty);

      assert.equal(journal.claim(DECISION, intent), true);
      const live = issued(journal.acquire(DECISION));
      const held = picture(journal);
      assert.equal(isPresented(held), false);
      assert.equal(journal.present(DECISION, `${live}:other`), false);
      assert.equal(journal.present('d2', live), false);
      assert.deepEqual(picture(journal), held);
      assert.equal(isPresented(picture(journal, 'd2')), false);
      assert.deepEqual(picture(journal, 'd2').decisions, []);

      journal.release(DECISION, live);
      const retired = picture(journal);
      assert.equal(attemptOf(retired), null);
      assert.equal(isPresented(retired), false);
      assert.equal(journal.present(DECISION, live), false);
      assert.deepEqual(picture(journal), retired);

      const next = issued(journal.acquire(DECISION));
      const again = picture(journal);
      assert.equal(journal.present(DECISION, live), false);
      assert.deepEqual(picture(journal), again);
      assert.equal(attemptOf(again), next);
      assert.equal(journal.present(DECISION, next), true);
      assert.equal(isPresented(journal.load(DECISION)), true);
      assert.equal(attemptOf(journal.load(DECISION)), next);
      assert.deepEqual(journal.load(DECISION).decisions, []);
    });

    test('presented stays true until a decision is appended by the holder', () => {
      const journal = make();
      assert.equal(journal.claim(DECISION, intent), true);
      const holder = issued(journal.acquire(DECISION));
      assert.equal(isPresented(journal.load(DECISION)), false);
      assert.equal(journal.present(DECISION, holder), true);
      assert.equal(isPresented(journal.load(DECISION)), true);

      assert.equal(journal.present(DECISION, `${holder}:other`), false);
      assert.equal(journal.append(settled(1), { attempt: `${holder}:other` }), false);
      assert.equal(journal.append(settled(1)), false);
      journal.release(DECISION, `${holder}:other`);
      assert.equal(isPresented(journal.load(DECISION)), true);
      assert.equal(attemptOf(journal.load(DECISION)), holder);
      assert.deepEqual(journal.load(DECISION).decisions, []);

      // Ending the attempt is not an append: the intent stays presented.
      journal.release(DECISION, holder);
      assert.equal(isPresented(journal.load(DECISION)), true);
      assert.equal(attemptOf(journal.load(DECISION)), null);
      assert.equal(journal.append(settled(1), { attempt: holder }), false);
      assert.equal(isPresented(journal.load(DECISION)), true);
      assert.deepEqual(journal.load(DECISION).decisions, []);

      // A receipt-less decision leaves it presented. The load field clears only once a receipt is appended.
      const pausing = issued(journal.acquire(DECISION));
      assert.equal(journal.append(pause(1), { attempt: pausing }), true);
      assert.equal(isPresented(journal.load(DECISION)), true);
      assert.equal(attemptOf(journal.load(DECISION)), null);
      assert.equal(journal.load(DECISION).decisions.length, 1);

      const settling = issued(journal.acquire(DECISION));
      assert.equal(journal.append(settled(2), { attempt: `${settling}:other` }), false);
      assert.equal(isPresented(journal.load(DECISION)), true);
      assert.equal(journal.load(DECISION).decisions.length, 1);
      assert.equal(journal.append(settled(2), { attempt: settling }), true);
      assert.equal(isPresented(journal.load(DECISION)), false);
      assert.equal(attemptOf(journal.load(DECISION)), null);
      assert.equal(journal.load(DECISION).decisions.length, 2);
    });

    test('a successful append retires the live attempt', () => {
      const journal = make();
      assert.equal(journal.claim(DECISION, intent), true);
      const live = issued(journal.acquire(DECISION));
      const held = picture(journal);
      const wrong: DispatchIntent = { kind: 'decline', dispatch_id: 'd1:decline' };

      assert.equal(journal.append(decision({ intent: wrong }), { attempt: live }), false);
      assert.equal(journal.append(pause(1), { attempt: `${live}:other` }), false);
      assert.equal(journal.append(pause(1)), false);
      assert.deepEqual(picture(journal), held);

      assert.equal(journal.append(pause(1), { attempt: live }), true);
      assert.equal(attemptOf(journal.load(DECISION)), null);
      assert.equal(journal.load(DECISION).decisions.length, 1);
      assert.equal(journal.append(pause(2), { attempt: live }), false);
      assert.equal(journal.present(DECISION, live), false);
      assert.equal(journal.acquire(DECISION, live), null);
      assert.equal(journal.load(DECISION).decisions.length, 1);

      const next = issued(journal.acquire(DECISION));
      assert.notEqual(next, live);
      assert.equal(journal.append(settled(2), { attempt: next }), true);
      assert.equal(attemptOf(journal.load(DECISION)), null);
      assert.equal(journal.append(settled(3), { attempt: next }), false);
      assert.equal(journal.present(DECISION, next), false);
      assert.equal(journal.acquire(DECISION), null);
      assert.equal(journal.load(DECISION).decisions.length, 2);
    });

    test('supersedes only works while the named attempt is live', () => {
      const journal = make();
      const empty = picture(journal);
      assert.equal(journal.acquire(DECISION, 'absent'), null);
      assert.deepEqual(picture(journal), empty);

      assert.equal(journal.claim(DECISION, intent), true);
      const unheld = picture(journal);
      assert.equal(journal.acquire(DECISION, 'absent'), null);
      assert.deepEqual(picture(journal), unheld);

      const live = issued(journal.acquire(DECISION));
      const held = picture(journal);
      assert.equal(journal.acquire(DECISION, `${live}:other`), null);
      assert.deepEqual(picture(journal), held);

      assert.equal(journal.claim('d2', intent), true);
      const other = issued(journal.acquire('d2'));
      assert.notEqual(other, live);
      const otherHeld = picture(journal, 'd2');
      assert.equal(journal.acquire(DECISION, other), null);
      assert.deepEqual(picture(journal), held);
      assert.deepEqual(picture(journal, 'd2'), otherHeld);

      const replacement = issued(journal.acquire(DECISION, live));
      assert.notEqual(replacement, live);
      assert.equal(attemptOf(journal.load(DECISION)), replacement);
      assert.deepEqual(journal.load(DECISION).decisions, []);
      assert.equal(attemptOf(journal.load('d2')), other);

      assert.equal(journal.acquire(DECISION, live), null);
      assert.equal(journal.append(pause(1), { attempt: live }), false);
      assert.equal(journal.present(DECISION, live), false);
      journal.release(DECISION, live);
      assert.equal(attemptOf(journal.load(DECISION)), replacement);
      assert.equal(isPresented(journal.load(DECISION)), false);
      assert.deepEqual(journal.load(DECISION).decisions, []);

      journal.release(DECISION, replacement);
      assert.equal(attemptOf(journal.load(DECISION)), null);
      assert.equal(journal.acquire(DECISION, replacement), null);
      assert.equal(journal.acquire(DECISION, live), null);
      const fresh = issued(journal.acquire(DECISION));
      assert.equal(attemptOf(journal.load(DECISION)), fresh);
      assert.notEqual(fresh, live);
      assert.notEqual(fresh, replacement);
    });

    test('one stage ask is in flight at a time: the first ask takes it, the same ask joins, others are refused', () => {
      const journal = make();
      const base = checkpoint(DECISION);
      const asked = { ...base, asks: { ...base.asks, route: 1 } };
      const route = { stage: 'route', ask: 1 } as const;
      assert.equal(journal.ask(DECISION, route, asked), 'taken');
      const held = picture(journal);
      assert.deepEqual(held.slot, { phase: 'open', ask: route });
      assert.deepEqual(held.checkpoint, asked);

      // A concurrent or recovering caller joins the same ask id; nothing is written.
      assert.equal(journal.ask(DECISION, route, asked), 'joined');
      // No second ask number, and no other stage, while one is in flight.
      const second = { ...base, asks: { ...base.asks, route: 2 } };
      assert.equal(journal.ask(DECISION, { stage: 'route', ask: 2 }, second), null);
      const triage = { ...base, asks: { ...base.asks, triage: 1 } };
      assert.equal(journal.ask(DECISION, { stage: 'triage', ask: 1 }, triage), null);
      // Nothing claims while an ask is in flight.
      assert.equal(journal.claim(DECISION, intent, asked), false);
      assert.deepEqual(picture(journal), held);

      // The first record of the ask wins; a joiner's later record is refused and writes nothing.
      const answered = { ...asked, state_updated_at: 11 };
      assert.equal(journal.record(DECISION, { stage: 'route', ask: 2 }, answered), false);
      assert.equal(journal.record(DECISION, route, answered), true);
      const recorded = picture(journal);
      assert.deepEqual(recorded.slot, { phase: 'open', ask: null });
      assert.deepEqual(recorded.checkpoint, answered);
      assert.equal(journal.record(DECISION, route, { ...asked, state_updated_at: 12 }), false);
      // A recorded ask is never taken again: a stale caller's ask of the same number is refused.
      assert.equal(journal.ask(DECISION, route, asked), null);
      assert.deepEqual(picture(journal), recorded);

      // The next ask number is taken once the previous one is recorded.
      const next = { ...answered, asks: { ...answered.asks, route: 2 } };
      assert.equal(journal.ask(DECISION, { stage: 'route', ask: 2 }, next), 'taken');
      // A counter that does not match the ask it names is refused.
      assert.equal(make().ask(DECISION, route, base), null);
    });

    test('appends are numbered in order, keep an in-flight ask, and never journal a presented intent as cancelled', () => {
      const journal = make();
      const base = checkpoint(DECISION);
      const asked = { ...base, asks: { ...base.asks, intake: 1 } };
      const intake = { stage: 'intake', ask: 1 } as const;
      assert.equal(journal.ask(DECISION, intake, asked), 'taken');
      const cancelled = decision({ entry: 1, reason: 'cancelled', decided_by: 'rule', choice: 'ask_user' });
      // An entry that is not the next one is refused.
      assert.equal(journal.append({ ...cancelled, entry: 2 }), false);
      // An intent-less cancel appends beside the in-flight ask, which it leaves for a resume to join;
      // the checkpoint passed with it does not overwrite the asked one.
      assert.equal(journal.append(cancelled, { checkpoint: base }), true);
      assert.deepEqual(picture(journal).slot, { phase: 'open', ask: intake });
      assert.deepEqual(picture(journal).checkpoint, asked);
      assert.equal(journal.append(cancelled), false, 'the same entry twice is refused');
      assert.equal(journal.ask(DECISION, intake, asked), 'joined');

      // With no ask in flight, an intent-less append writes its checkpoint in the same record.
      const fresh = make();
      assert.equal(fresh.append(cancelled, { checkpoint: base }), true);
      assert.deepEqual(picture(fresh).checkpoint, base);
      assert.deepEqual(picture(fresh).slot, { phase: 'open', ask: null });

      // A claimed intent is cancelled before present; once presented it never is.
      const claimed = make();
      assert.equal(claimed.claim(DECISION, intent, base), true);
      assert.equal(claimed.append({ ...pause(1), reason: 'cancelled' }), true);
      assert.deepEqual(picture(claimed).slot, { phase: 'claimed', intent, attempt: null });
      const holder = issued(claimed.acquire(DECISION));
      assert.equal(claimed.present(DECISION, holder), true);
      assert.throws(() => claimed.append({ ...pause(2), reason: 'cancelled' }, { attempt: holder }), /cancelled/);
      assert.equal(claimed.append(pause(2), { attempt: holder }), true);
      assert.deepEqual(picture(claimed).slot, { phase: 'presented', intent, attempt: null });

      // A terminal decision closes the slot and keeps the intent it closed.
      const settling = issued(claimed.acquire(DECISION));
      assert.equal(claimed.append(settled(3), { attempt: settling }), true);
      assert.deepEqual(picture(claimed).slot, { phase: 'terminal', intent });
      assert.deepEqual(picture(claimed).checkpoint?.intent, intent);
      assert.equal(claimed.ask(DECISION, { stage: 'intake', ask: 1 }, asked), null);
    });
  });
}
