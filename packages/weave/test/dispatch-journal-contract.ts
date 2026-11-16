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
      assert.equal(claimed.attempt, null);
      assert.equal(claimed.presented, false);

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
      assert.equal(empty.attempt, null);
      assert.deepEqual(empty.decisions, []);

      assert.equal(journal.claim(DECISION, intent), true);
      const live = issued(journal.acquire(DECISION));
      const held = picture(journal);
      assert.equal(held.attempt, live);
      assert.equal(journal.acquire(DECISION), null);
      assert.deepEqual(picture(journal), held);

      assert.equal(journal.acquire('d2'), null);
      assert.equal(picture(journal, 'd2').attempt, null);
      assert.equal(journal.load(DECISION).attempt, live);
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
      assert.equal(journal.append(pause(1), replacement), true);
      const appended = take(journal.acquire(DECISION));
      assert.equal(journal.append(pause(2), appended), true);
      const again = take(journal.acquire(DECISION));
      journal.release(DECISION, again);
      const latest = take(journal.acquire(DECISION));
      assert.equal(seen.size, 6);
      assert.equal(journal.load(DECISION).attempt, latest);
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
      assert.equal(journal.load(DECISION).attempt, live);
      assert.equal(journal.load('d2').attempt, other);

      journal.release(DECISION, live);
      assert.equal(journal.load(DECISION).attempt, null);
      assert.equal(journal.load('d2').attempt, other);
      assert.equal(journal.append(pause(1), live), false);
      assert.deepEqual(journal.load(DECISION).decisions, []);

      const next = issued(journal.acquire(DECISION));
      assert.notEqual(next, live);
      journal.release(DECISION, live);
      journal.release('d2', next);
      journal.release(DECISION, other);
      assert.equal(journal.load(DECISION).attempt, next, 'a retired attempt releases nothing');
      assert.equal(journal.load('d2').attempt, other, 'an attempt live on another decision is left alone');

      assert.equal(journal.append(pause(1, 'd2'), other), true);
      assert.equal(journal.load('d2').attempt, null);
      assert.equal(journal.load(DECISION).attempt, next);
    });

    test('present returns false and writes nothing for a non-live or retired attempt', () => {
      const journal = make();
      const empty = picture(journal);
      assert.equal(journal.present(DECISION, 'absent'), false);
      assert.deepEqual(picture(journal), empty);

      assert.equal(journal.claim(DECISION, intent), true);
      const live = issued(journal.acquire(DECISION));
      const held = picture(journal);
      assert.equal(held.presented, false);
      assert.equal(journal.present(DECISION, `${live}:other`), false);
      assert.equal(journal.present('d2', live), false);
      assert.deepEqual(picture(journal), held);
      assert.equal(picture(journal, 'd2').presented, false);
      assert.deepEqual(picture(journal, 'd2').decisions, []);

      journal.release(DECISION, live);
      const retired = picture(journal);
      assert.equal(retired.attempt, null);
      assert.equal(retired.presented, false);
      assert.equal(journal.present(DECISION, live), false);
      assert.deepEqual(picture(journal), retired);

      const next = issued(journal.acquire(DECISION));
      const again = picture(journal);
      assert.equal(journal.present(DECISION, live), false);
      assert.deepEqual(picture(journal), again);
      assert.equal(again.attempt, next);
      assert.equal(journal.present(DECISION, next), true);
      assert.equal(journal.load(DECISION).presented, true);
      assert.equal(journal.load(DECISION).attempt, next);
      assert.deepEqual(journal.load(DECISION).decisions, []);
    });

    test('presented stays true until a decision is appended by the holder', () => {
      const journal = make();
      assert.equal(journal.claim(DECISION, intent), true);
      const holder = issued(journal.acquire(DECISION));
      assert.equal(journal.load(DECISION).presented, false);
      assert.equal(journal.present(DECISION, holder), true);
      assert.equal(journal.load(DECISION).presented, true);

      assert.equal(journal.present(DECISION, `${holder}:other`), false);
      assert.equal(journal.append(settled(1), `${holder}:other`), false);
      assert.equal(journal.append(settled(1)), false);
      journal.release(DECISION, `${holder}:other`);
      assert.equal(journal.load(DECISION).presented, true);
      assert.equal(journal.load(DECISION).attempt, holder);
      assert.deepEqual(journal.load(DECISION).decisions, []);

      // Ending the attempt is not an append: the intent stays presented.
      journal.release(DECISION, holder);
      assert.equal(journal.load(DECISION).presented, true);
      assert.equal(journal.load(DECISION).attempt, null);
      assert.equal(journal.append(settled(1), holder), false);
      assert.equal(journal.load(DECISION).presented, true);
      assert.deepEqual(journal.load(DECISION).decisions, []);

      // A receipt-less decision leaves it presented. The load field clears only once a receipt is appended.
      const pausing = issued(journal.acquire(DECISION));
      assert.equal(journal.append(pause(1), pausing), true);
      assert.equal(journal.load(DECISION).presented, true);
      assert.equal(journal.load(DECISION).attempt, null);
      assert.equal(journal.load(DECISION).decisions.length, 1);

      const settling = issued(journal.acquire(DECISION));
      assert.equal(journal.append(settled(2), `${settling}:other`), false);
      assert.equal(journal.load(DECISION).presented, true);
      assert.equal(journal.load(DECISION).decisions.length, 1);
      assert.equal(journal.append(settled(2), settling), true);
      assert.equal(journal.load(DECISION).presented, false);
      assert.equal(journal.load(DECISION).attempt, null);
      assert.equal(journal.load(DECISION).decisions.length, 2);
    });

    test('a successful append retires the live attempt', () => {
      const journal = make();
      assert.equal(journal.claim(DECISION, intent), true);
      const live = issued(journal.acquire(DECISION));
      const held = picture(journal);
      const wrong: DispatchIntent = { kind: 'decline', dispatch_id: 'd1:decline' };

      assert.equal(journal.append(decision({ intent: wrong }), live), false);
      assert.equal(journal.append(pause(1), `${live}:other`), false);
      assert.equal(journal.append(pause(1)), false);
      assert.deepEqual(picture(journal), held);

      assert.equal(journal.append(pause(1), live), true);
      assert.equal(journal.load(DECISION).attempt, null);
      assert.equal(journal.load(DECISION).decisions.length, 1);
      assert.equal(journal.append(pause(2), live), false);
      assert.equal(journal.present(DECISION, live), false);
      assert.equal(journal.acquire(DECISION, live), null);
      assert.equal(journal.load(DECISION).decisions.length, 1);

      const next = issued(journal.acquire(DECISION));
      assert.notEqual(next, live);
      assert.equal(journal.append(settled(2), next), true);
      assert.equal(journal.load(DECISION).attempt, null);
      assert.equal(journal.append(settled(3), next), false);
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
      assert.equal(journal.load(DECISION).attempt, replacement);
      assert.deepEqual(journal.load(DECISION).decisions, []);
      assert.equal(journal.load('d2').attempt, other);

      assert.equal(journal.acquire(DECISION, live), null);
      assert.equal(journal.append(pause(1), live), false);
      assert.equal(journal.present(DECISION, live), false);
      journal.release(DECISION, live);
      assert.equal(journal.load(DECISION).attempt, replacement);
      assert.equal(journal.load(DECISION).presented, false);
      assert.deepEqual(journal.load(DECISION).decisions, []);

      journal.release(DECISION, replacement);
      assert.equal(journal.load(DECISION).attempt, null);
      assert.equal(journal.acquire(DECISION, replacement), null);
      assert.equal(journal.acquire(DECISION, live), null);
      const fresh = issued(journal.acquire(DECISION));
      assert.equal(journal.load(DECISION).attempt, fresh);
      assert.notEqual(fresh, live);
      assert.notEqual(fresh, replacement);
    });
  });
}
