import assert from "node:assert/strict";
import test from "node:test";
import { createLoop } from "./loop.mjs";

const text = "Please arrange a one-hour family dinner next week after 6 pm.";
const first = "2026-11-23T08:00:00.000Z";
const second = "2026-11-24T08:00:00.000Z";
const actor = "operator";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  let snapshot;
  const calls = [];
  const holds = new Map();
  const dependencies = {
    load: () => snapshot && structuredClone(snapshot),
    save: (next) => {
      snapshot = structuredClone(next);
    },
    now: () => "2026-11-19T03:00:00.000Z",
    newId: () => crypto.randomUUID(),
    model: {
      extract: async (input) => {
        calls.push(["extract", input]);
        return { supported: true, intent: "hold" };
      },
      decide: async ({ phase, slots, intent, preferredSlot, constraints }) => {
        calls.push(["decide", phase]);
        if (phase === "availability") calls.push(["eligible", slots, preferredSlot, constraints]);
        const action =
          phase === "intake"
            ? "split"
            : intent === "find"
              ? "report"
              : preferredSlot
                ? "propose"
                : ["none", "propose", "choose"][Math.min(slots.length, 2)];
        return { action, confidence: 0.95 };
      },
      ...overrides.model,
    },
    calendar: {
      read: async (person) => {
        calls.push(["read", person]);
        return [first];
      },
      hold: async ({ key, slot }) => {
        calls.push(["hold", key, slot]);
        const receipt = { id: "hold-1", slot };
        holds.set(key, receipt);
        return receipt;
      },
      lookup: async (key) => holds.get(key) ?? null,
      ...overrides.calendar,
    },
  };
  const loop = createLoop(dependencies);
  return { loop, calls, restart: () => createLoop(dependencies) };
}

function start(loop, input = text) {
  return loop.dispatch({ type: "start", actor, text: input });
}

function command(loop, type, revision, fields = {}) {
  return loop.dispatch({ type, actor, revision, ...fields });
}

test("runs both reads in parallel and an exact approval creates one hold", async () => {
  const reads = { first: deferred(), second: deferred() };
  const secondStarted = deferred();
  const readCalls = [];
  const { loop, calls } = fixture({
    calendar: {
      read(person) {
        readCalls.push(person);
        if (person === "second") secondStarted.resolve();
        return reads[person].promise;
      },
    },
  });
  const pending = start(loop);
  await secondStarted.promise;
  assert.deepEqual(readCalls, ["first", "second"]);
  reads.first.resolve([first, second]);
  reads.second.resolve([second]);
  const proposed = await pending;
  assert.equal(proposed.status, "approval");
  assert.equal(proposed.selected, second);
  assert.equal(
    (await command(loop, "approve", proposed.revision, { actor: "other" })).status,
    "approval",
  );
  assert.equal((await command(loop, "approve", proposed.revision - 1)).status, "approval");
  assert.equal(calls.filter(([type]) => type === "hold").length, 0);
  const firstApproval = command(loop, "approve", proposed.revision);
  const duplicateApproval = command(loop, "approve", proposed.revision);
  const [done] = await Promise.all([firstApproval, duplicateApproval]);
  assert.equal(done.status, "done");
  assert.deepEqual(done.receipt, { id: "hold-1", slot: second });
  assert.equal(calls.filter(([type]) => type === "hold").length, 1);
  assert.equal(readCalls.length, 4);
});

test("joins to no overlap or asks for an exact choice from the sorted intersection", async () => {
  const noOverlap = fixture({
    calendar: { read: async (person) => (person === "first" ? [first] : [second]) },
  });
  assert.equal((await start(noOverlap.loop)).status, "done");
  const many = fixture({ calendar: { read: async () => [second, first, second] } });
  const choice = await start(many.loop);
  assert.equal(choice.status, "choice");
  assert.deepEqual(choice.slots, [first, second]);
  assert.equal(
    (await command(many.loop, "choose", choice.revision, { slot: "other" })).status,
    "choice",
  );
  const proposed = await command(many.loop, "choose", choice.revision, { slot: second });
  assert.equal(proposed.status, "approval");
  assert.equal(proposed.selected, second);
});

test("offers the earliest exact shared start on each Sydney evening", async () => {
  const later = "2026-11-23T08:30:00.000Z";
  const { loop } = fixture({ calendar: { read: async () => [second, later, first] } });
  const choice = await start(loop);
  assert.equal(choice.status, "choice");
  assert.deepEqual(choice.slots, [first, second]);
});

test("low confidence, an incompatible decision, and read-only intent stop safely", async () => {
  for (const answer of [
    { action: "split", confidence: 0.1 },
    { action: "hold", confidence: 1 },
  ]) {
    const { loop, calls } = fixture({ model: { decide: async () => answer } });
    assert.equal((await start(loop)).status, "blocked");
    assert.equal(
      calls.some(([type]) => type === "read"),
      false,
    );
  }
  const { loop, calls } = fixture();
  assert.equal(
    (await start(loop, "Find a family dinner next week, but do not book anything.")).status,
    "blocked",
  );
  assert.equal(
    calls.some(([type]) => type === "read"),
    false,
  );
});

test("cancellation during calendar reads drops stale work", async () => {
  const readStarted = deferred();
  const read = deferred();
  const { loop, calls } = fixture({
    calendar: {
      read: async () => {
        readStarted.resolve();
        return read.promise;
      },
    },
  });
  const pending = start(loop);
  await readStarted.promise;
  const working = loop.state();
  assert.deepEqual(await start(loop), working);
  const cancelled = await command(loop, "cancel", working.revision);
  assert.equal(cancelled.status, "cancelled");
  read.resolve([first]);
  assert.deepEqual(await pending, cancelled);
  assert.deepEqual(loop.state(), cancelled);
  assert.equal(
    calls.some(([type, phase]) => type === "decide" && phase === "availability"),
    false,
  );
});

test("changed availability after approval offers a fresh proposal", async () => {
  let reads = 0;
  const { loop, calls } = fixture({
    calendar: { read: async () => (++reads <= 2 ? [first] : [second]) },
  });
  const proposed = await start(loop);
  const result = await command(loop, "approve", proposed.revision);
  assert.equal(result.status, "approval");
  assert.equal(result.selected, second);
  assert.equal(result.receipt, null);
  assert.equal(
    calls.some(([type]) => type === "hold"),
    false,
  );
  assert.deepEqual(await command(loop, "approve", proposed.revision), result);
  assert.equal((await command(loop, "approve", result.revision)).status, "done");
});

test("read-only goals finish with available times and reject a proposed effect", async () => {
  const input = "Just find an available dinner time next week.";
  const reported = fixture({
    model: {
      extract: async () => ({
        supported: true,
        intent: "find",
        inference: { model: "extract", elapsedMs: 12, secret: "hidden" },
      }),
    },
  });
  const result = await start(reported.loop, input);
  assert.equal(result.status, "done");
  assert.deepEqual(result.slots, [first]);
  assert.equal(result.receipt, null);
  assert.deepEqual(result.trace.find(({ type }) => type === "goal.extract").inference, {
    model: "extract",
    elapsedMs: 12,
  });

  const attemptedWrite = fixture({
    model: {
      extract: async () => ({ supported: true, intent: "find" }),
      decide: async (request) => {
        assert.equal(request.text, input);
        assert.equal(request.intent, "find");
        return { action: request.phase === "intake" ? "split" : "propose", confidence: 1 };
      },
    },
  });
  const safe = await start(attemptedWrite.loop, input);
  assert.equal(safe.status, "done");
  assert.deepEqual(safe.slots, [first]);
  assert.equal(safe.receipt, null);
  assert.equal(
    attemptedWrite.calls.some(([type]) => type === "hold"),
    false,
  );
});

test("recovers an acknowledged effect from its persisted key after losing the response", async () => {
  let receipt;
  let holdKey;
  let lookups = 0;
  let writes = 0;
  const { loop, restart } = fixture({
    calendar: {
      async hold({ key, slot }) {
        writes++;
        holdKey = key;
        receipt = { id: "lost-response", slot };
        throw new Error("response lost");
      },
      async lookup(key) {
        lookups++;
        if (receipt && lookups <= 1) throw new Error("lookup unavailable");
        assert.equal(key, holdKey);
        return receipt;
      },
    },
  });
  const proposed = await start(loop);
  assert.equal((await command(loop, "approve", proposed.revision)).status, "working");
  const done = await restart().resume();
  assert.equal(done.status, "done");
  assert.deepEqual(done.receipt, receipt);
  assert.equal(writes, 1);
});

test("rechecks and retries a definitely absent hold with the same persisted key", async () => {
  const keys = [];
  let reads = 0;
  const { loop, restart } = fixture({
    calendar: {
      async read() {
        reads++;
        return [first];
      },
      async hold({ key, slot }) {
        keys.push(key);
        if (keys.length === 1) throw new Error("request never arrived");
        return { id: "retried", slot };
      },
    },
  });
  const proposed = await start(loop);
  assert.equal((await command(loop, "approve", proposed.revision)).status, "working");
  assert.equal(loop.hasPending(), true);
  const recovered = restart();
  assert.equal((await recovered.resume()).status, "done");
  assert.equal(recovered.hasPending(), false);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(reads, 6);
});

test("bounds automatic recovery and reconciles manually without writing again", async () => {
  let writes = 0;
  let lookups = 0;
  let readReceipt = false;
  const { loop, restart } = fixture({
    calendar: {
      async hold() {
        writes++;
        throw new Error("unknown outcome");
      },
      async lookup() {
        lookups++;
        if (readReceipt) return { id: "existing", slot: first };
        throw new Error("lookup unavailable");
      },
    },
  });
  const proposal = await start(loop);
  await command(loop, "approve", proposal.revision);
  await restart().resume();
  const paused = restart();
  let working = await paused.resume();
  assert.equal(working.recovery, "manual");
  assert.equal(paused.hasPending(), false);
  assert.equal(writes, 1);
  assert.equal(lookups, 3);
  assert.deepEqual(await paused.resume(), working);
  assert.deepEqual(
    await command(paused, "reconcile", working.revision, { actor: "other" }),
    working,
  );
  assert.deepEqual(await command(paused, "cancel", working.revision), working);
  for (let attempt = 0; attempt < 32; attempt++) {
    working = await command(paused, "reconcile", working.revision);
  }
  assert.equal(working.recovery, "manual");
  assert.ok(working.trace.length <= 64);
  assert.equal(working.startedAt, proposal.startedAt);
  readReceipt = true;
  const result = await command(paused, "reconcile", working.revision);
  assert.equal(result.status, "done");
  assert.equal(result.receipt.id, "existing");
  assert.equal(writes, 1);
});

test("manual reconciliation of a missing hold offers new approval", async () => {
  let canLookUp = false;
  let writes = 0;
  const { loop } = fixture({
    calendar: {
      async hold() {
        writes++;
        throw new Error("unknown outcome");
      },
      async lookup() {
        if (canLookUp) return null;
        throw new Error("lookup unavailable");
      },
    },
  });
  const proposal = await start(loop);
  await command(loop, "approve", proposal.revision);
  await loop.resume();
  const paused = await loop.resume();
  canLookUp = true;
  const result = await command(loop, "reconcile", paused.revision);
  assert.equal(result.status, "approval");
  assert.equal(result.recovery, null);
  assert.equal(writes, 1);
  assert.deepEqual(await command(loop, "approve", proposal.revision), result);
});

test("separate actor stores use distinct hold keys at identical revisions and times", async () => {
  const keys = [];
  for (const owner of ["first-operator", "second-operator"]) {
    const { loop } = fixture({
      calendar: {
        async hold({ key, slot }) {
          keys.push(key);
          return { id: "hold", slot };
        },
      },
    });
    const proposed = await loop.dispatch({ type: "start", actor: owner, text });
    assert.equal(
      (await command(loop, "approve", proposed.revision, { actor: owner })).status,
      "done",
    );
  }
  assert.notEqual(keys[0], keys[1]);
});

test("reports eligible evenings and passes the same evidence to the availability decision", async () => {
  const third = "2026-11-25T08:00:00.000Z";
  const constraints = { excludeDays: ["monday"], preferredDay: "wednesday" };
  const { loop, calls } = fixture({
    model: { extract: async () => ({ supported: true, intent: "find", constraints }) },
    calendar: { read: async () => [first, second, third] },
  });
  const result = await start(loop);
  assert.equal(result.status, "done");
  assert.deepEqual(result.slots, [second, third]);
  assert.deepEqual(
    calls.find(([type]) => type === "eligible"),
    ["eligible", [second, third], third, constraints],
  );
});

test("replans when the preferred evening disappears and never offers or writes an excluded time", async () => {
  let available = true;
  const third = "2026-11-25T08:00:00.000Z";
  const { loop, calls, restart } = fixture({
    model: {
      extract: async () => ({
        supported: true,
        intent: "hold",
        constraints: { excludeDays: ["monday"], preferredDay: "wednesday" },
      }),
    },
    calendar: { read: async () => (available ? [first, second, third] : [first, second]) },
  });
  const preferred = await start(loop);
  assert.equal(preferred.status, "approval");
  assert.equal(preferred.selected, third);
  assert.deepEqual(preferred.slots, [second, third]);
  available = false;
  const recovered = restart();
  const alternative = await command(recovered, "approve", preferred.revision);
  assert.equal(alternative.status, "approval");
  assert.equal(alternative.selected, second);
  assert.deepEqual(alternative.slots, [second]);
  assert.deepEqual(await command(recovered, "approve", preferred.revision), alternative);
  assert.equal(
    calls.some(([type]) => type === "hold"),
    false,
  );
  assert.equal((await command(recovered, "approve", alternative.revision)).status, "done");
  assert.deepEqual(
    calls.filter(([type]) => type === "hold").map(([, , slot]) => slot),
    [second],
  );
});

test("rejects malformed typed weekday constraints before calendar reads", async () => {
  const { loop, calls } = fixture({
    model: {
      extract: async () => ({
        supported: true,
        intent: "hold",
        constraints: { excludeDays: ["monday", "funday"], preferredDay: null },
      }),
    },
  });
  assert.equal((await start(loop)).status, "blocked");
  assert.equal(
    calls.some(([type]) => type === "read"),
    false,
  );
});

test("provider outage is visible to the operator and does not become a scope refusal", async () => {
  const { loop, calls } = fixture({
    model: {
      extract: async () => ({
        supported: false,
        inference: { model: "@cf/cloudflare/clairic", elapsedMs: 12, unavailable: true },
      }),
    },
  });
  const state = await loop.dispatch({ type: "start", actor, text });
  assert.equal(state.status, "blocked");
  assert.match(state.message, /unavailable/i);
  assert.equal(
    state.trace.find((event) => event.type === "goal.extract").inference.unavailable,
    true,
  );
  assert.ok(!calls.some(([name]) => name === "read"));
});

test("uncertain replacement asks for an explicit choice and fresh approval", async () => {
  let remaining = [first, second];
  const { loop, calls } = fixture({
    calendar: { read: async () => remaining },
    model: {
      decide: async ({ phase, slots }) =>
        phase === "intake"
          ? { action: "split", confidence: 0.99 }
          : slots.length === 2
            ? { action: "choose", confidence: 0.99 }
            : { action: "propose", confidence: 0.76 },
    },
  });
  const options = await start(loop);
  const initial = await loop.dispatch({
    type: "choose",
    actor,
    slot: first,
    revision: options.revision,
  });
  remaining = [second];
  const clarification = await command(loop, "approve", initial.revision);
  assert.equal(clarification.status, "choice");
  assert.deepEqual(clarification.slots, [second]);
  assert.ok(clarification.trace.some((e) => e.type === "clarification.requested"));
  assert.deepEqual(await command(loop, "approve", clarification.revision), clarification);
  const fresh = await loop.dispatch({
    type: "choose",
    actor,
    revision: clarification.revision,
    slot: second,
  });
  assert.equal(fresh.status, "approval");
  assert.ok(!calls.some(([type]) => type === "hold"));
  assert.deepEqual(await command(loop, "approve", initial.revision), fresh);
  assert.equal((await command(loop, "approve", fresh.revision)).receipt.slot, second);
});
