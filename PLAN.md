# PLAN: #234 — Store log: automatic recovery from abandoned stale-lock reclaim

Planning only. This document proposes a change; it edits no product code.
Line references are to `main` at `74683ef`.

Terminology: this plan says **stale-lock reclaim**, never "recovery", in code
and docs. `GLOSSARY.md` already defines **Recovery** as restoring unfinished
work from durable records, and the store's lock protocol must not borrow it.

## 1. Problem

A path-backed `FabricStore` holds a single-writer lock. When the writer dies,
the next opener reclaims the stale lock through a reclaim directory and a reap
claim. #233 made reclaim safe but fail-closed. #253 (fixes #235) added
reap-claim liveness waits and a retry when the lock vanishes. Some states still
need an operator to delete a path by hand, even when every process involved is
provably dead:

| Abandoned state on disk | Today | Wanted (#234) |
| --- | --- | --- |
| `<j>.lock.reclaim/reap/` exists with a **dead** `owner` token | 8 injected sleeps, then `already open … remove <claim> and retry` (`store.ts:936-948`) | Reclaim automatically |
| `<j>.lock.reclaim/reap/` exists with **no** `owner` file (crash between `mkdirSync` and `writeFileSync`, `store.ts:931-932`) | Same manual error (test `store.test.ts:1106`) | Reclaim automatically after an observed-stable grace on the injected clock |
| Lock or reclaim owner whose PID was **reused** by an unrelated live process | `isAlive(pid)` reports true, so `already open` forever | Treat as dead when the process start identity differs |
| Lock owner token carries **our own PID** from a crashed predecessor (container PID 1, fast restarts) | Reads as alive (`isAlive(process.pid)`) | Treat as dead when the start identity differs (v2 tokens only; legacy tokens keep today's behavior) |
| Owner on another host or PID namespace (shared volume) | `kill(pid,0)` probes an unrelated local PID, so the result is wrong in either direction | `unknown`. Never reclaimed automatically; manual message |

Dead-owner reclaim directories with no claim are already reclaimed today. Keep
that working.

## 2. Current surfaces and paths

All of this lives in `packages/agentfabric/src/store.ts`. No other package
touches these files. `@weave/weave` reaches the store only through
`@weave/agentfabric` exports (import direction:
`checks/import-direction.mjs:46-47`).

### On-disk paths (`<j>` = canonical journal path from `canonicalStorePath`, `store.ts:811`)

| Path | Created by | Content | Removed by |
| --- | --- | --- | --- |
| `<j>.lock` | `acquireLock` via `linkSync(temp, lock)` (`:847`) | token `"<pid>:<lockSequence>"` (`:841`) | `releaseLock` when the token matches (`:1048`); a reclaim holder when the owner is dead (`:872`) |
| `<j>.lock.<token>.tmp` | `acquireLock` (`:843`) | token | `acquireLock` `finally` (`:885`); left behind if the process crashes |
| `<j>.lock.reclaim/` | `acquireReclaim`: mkdir temp, write `owner`, rename into place (`:899-903`) | `owner` = the acquirer's lock token | `releaseReclaim` (rename to `.released.*`, then rm, `:992`); a reaper (rename to `.stale.*`, then rm, `:959-985`) |
| `<j>.lock.reclaim.<pid>.<n>.tmp/` | `acquireReclaim` (`:899`) | `owner` | `finally` rm (`:917`) |
| `<j>.lock.reclaim/reap/` | reaper `mkdirSync` then `writeFileSync owner` (`:931-932`), **not atomic** | `owner` = reaper's token | only implicitly, with the reclaim dir it lives in |
| `<j>.lock.reclaim.stale.<pid>.<n>/` | reaper quarantine (`:959`) | moved reclaim dir | rm (`:984`), or restored on mismatch (`:973`) |
| `<j>.lock.reclaim.released.<pid>.<n>/` | `releaseReclaim` | moved reclaim dir | rm |

### Functions

- `FabricStore` constructor (`:185-235`): calls `acquireLock(key, options.sleep ?? defaultLockSleep)`, then journal load. Releases the lock if anything throws.
- `assertWritable` (`:552`): before every append or compaction, re-reads `<j>.lock` and requires `=== this.lockToken`. Losing the lock poisons writes. It never corrupts.
- `acquireLock` (`:839-890`): up to 32 rounds of link, then read owner. If the owner is unparsable or alive, it throws `already open`. Otherwise it calls `acquireReclaim`, re-reads the lock (it must still equal the dead owner), unlinks it, and releases the reclaim.
- `acquireReclaim` (`:896-990`): up to 16 rounds. It takes the reclaim dir atomically. If one exists with a dead owner, it claims `reap`, revalidates `(token, dev, ino)` and liveness, renames to quarantine, validates the moved identity, and restores the dir (or throws a manual error) on mismatch.
- `readReclaimIdentity` / `sameReclaimOwner` (`:1011-1033`): identity is `(token, pid, dev, ino)`.
- `lockOwner` (`:1035`): `parseInt(token)`, PID only.
- `isAlive` (`:1059`): `kill(pid,0)`. `EPERM` counts as alive, so only `ESRCH` means dead. This matches `probeProcessGroup` in `process-group.ts`.
- `FabricStoreOptions` (`:31-33`): `{ sleep? }`, exported from `index.ts`. There is no clock.

### Callers

`FabricStore.open` is called from `examples/cli-generations.ts:50` (the operator
command) and from tests. `AgentFabricHost` takes an already-open store
(`host.ts:238`). `FabricStore.restore(snapshot, path)` passes no options
(`:279`).

### Constraints from checks and contracts

- `checks/no-ambient-clock.mjs` scans `packages/agentfabric/src`. `Date`, `performance.now`, `hrtime` and timers are forbidden, and adding an allowlist entry would weaken the check (AGENTS.md). **Time must be injected.**
- `checks/no-ambient-entropy.mjs` scans only `weave/src` and `weft/src`, so `randomUUID` is permitted in agentfabric. Record that this plan relies on it.
- `checks/no-ambient-env.mjs`: reading `/proc` is not `process.env`, so it is allowed.
- `docs/h1-bound-the-log.md` H1-T05: a second runtime that opens the same host store must be refused. Liveness must never report a live owner as dead.
- `UNCERTAIN-CONTRACT.md:185-186`: the operator command relies on the single-writer lock.

### Existing tests that pin the behavior (`packages/agentfabric/test/store.test.ts`)

- Live owners are never displaced: `:1149` (live writer or reclaim owner, with no "remove" hint), `:1351` (live lock claimed during reclaim), `:902` (live reclaim successor), `:952` (successor arrives during release), `:1031` (foreign reap claim preserved).
- Waiting and bounds: `:341` (live reaper, then contenders in turn), `:380` (claim disappears during backoff), `:422` (live reaper pid: bounded, with a conditional manual message), `:459` (dead reaper: manual message), `:494` (vanished lock retried).
- Manual messages use canonical paths through aliases: `:1106`, `:1181` (restore failure).
- Basic dead-PID reclaim: `:1832`.

`:459` and `:1106` encode the manual-cleanup behavior that #234 replaces. They
become the red tests (see §7).

The prior art for PID reuse is in `benchmarks/decision-sites/journal.ts:269-339`
(#170/#178). The owner records `boot_id` and the PID namespace, and a liveness
probe runs only when both match. That lock never auto-steals. This store lock
does steal once the owner is proven dead.

## 3. Design

### 3.1 Principles

1. **Liveness is evidence. Time never is.** An owner is reclaimed only when a probe proves it `dead`. The injected clock bounds how long we wait and never turns `alive` or `unknown` into `dead`. Owner leases and heartbeats are explicitly excluded (§8).
2. **Never move or delete a path you do not exclusively hold.** Abandoned claims are never removed. A contender supersedes one by taking the next claim slot. The whole reclaim directory is moved only by the holder of the live highest slot. This removes the regress where an abandoned claim would need its own claim.
3. **Claim, then revalidate.** Keep #233's rule: after acquiring any slot, re-read the identity before acting.
4. **Every on-disk owner record is complete when it becomes visible.** It is written to a temp file and published with `linkSync`, which is atomic and exclusive. Nothing is published as empty-then-filled.
5. **Fail closed on `unknown`,** with the exact canonical path and a conditional manual step, as today.

### 3.2 Owner token

One format is used for `<j>.lock`, `<j>.lock.reclaim/owner` and every claim
slot. It is single-line JSON:

```ts
/** Written by this version. Compared byte-for-byte as text by assertWritable/release. */
interface OwnerTokenV2 {
  readonly v: 2;
  readonly pid: number;          // process.pid
  readonly host: string | null;  // `${/proc/sys/kernel/random/boot_id}:${readlink /proc/self/ns/pid}`; null if unreadable
  readonly start: string | null; // field 22 (starttime, clock ticks since boot) of /proc/self/stat; null if unreadable
  readonly nonce: string;        // `${threadId}.${++lockSequence}.${randomUUID()}`, unique per acquisition
}
```

- Compute `host` and `start` once per process, lazily, the same way as the bench lock.
- To parse `/proc/<pid>/stat`, split after the **last** `)`, because `comm` may contain spaces or parentheses.
- Older readers fail closed on this format: today's `lockOwner` gets `NaN` from `parseInt('{"v":2…')`, so `pid === undefined` and the old code throws `already open`. Keep that property: the first character must never be a digit.
- Legacy tokens (`"<pid>"`, `"<pid>:<seq>"`, and any other text with a leading integer) are still **read**. This version never writes them.

### 3.3 Liveness

```ts
type OwnerState = 'alive' | 'dead' | 'unknown';
function ownerState(text: string | undefined): OwnerState;
```

| Token | Condition | State |
| --- | --- | --- |
| unreadable, empty, or unparsable | — | `unknown` |
| v2 | `host !== null` and `host !== localHost` | `unknown` (foreign boot or namespace; never probe) |
| v2 | `host === localHost`, `start !== null`, `/proc/<pid>/stat` missing (`ENOENT`) | `dead` |
| v2 | same, starttime differs | `dead` (PID reused, including our own PID) |
| v2 | same, starttime equal | `alive` (including our own process or another worker thread) |
| v2 | `/proc` read fails otherwise (`EACCES` etc.) | `unknown` |
| v2 | `host === null` or `start === null` (non-Linux writer) **and** the local host is also null | `kill(pid,0)`: `ESRCH` → `dead`, else `alive` |
| v2 | `host === null` but the local host is known, or the reverse | `unknown` |
| legacy | any | `kill(pid,0)`: `ESRCH` → `dead`, else `alive` (today's behavior, unchanged) |

Legacy tokens deliberately do **not** get an "own PID means stale" rule. This
version never writes them, but a second copy of agentfabric loaded in the same
process could. Existing tests also use `${process.pid}:…` as their fixture for
a live owner (`:341`, `:422`, `:1149`). Reused-PID detection therefore applies
only to v2 tokens.

Worker threads share `process.pid` but have separate module state, including
`openStores`. A v2 token from a sibling worker has matching start, so it reads
`alive` and is refused correctly. Do **not** port the bench lock's rule that
our own PID means stale for v2 tokens.

`isAlive` and `lockOwner` are replaced by `ownerState` at every call site:
`acquireLock :859-860`, `acquireReclaim :923, :941, :944, :953, :969`, and
`readReclaimIdentity` (identity no longer requires a PID).

### 3.4 Injected time

```ts
export interface FabricStoreOptions {
  /** Synchronous backoff for the path-backed writer lock. */
  readonly sleep?: (milliseconds: number) => void;
  /** Injected time for stale-lock reclaim waits. Without it, time is the sum of slept milliseconds. */
  readonly clock?: { now(): number };   // same shape as ShellClock (shell.ts:33)
}
```

- With no `clock`, the store uses a **virtual clock** that advances by exactly the milliseconds passed to whichever `sleep` is in use. This keeps one code path, satisfies `no-ambient-clock`, and lets existing tests that inject only `sleep` terminate.
- Composition roots may pass a real clock. `examples/cli-generations.ts` may pass `{ now: () => Date.now() }`; examples are not scanned.
- Internal constants are not options. No knob is speculative.
  - `RECLAIM_WAIT_MS = 2000`: the longest time to wait for a **live** reaper or reclaim holder before failing closed.
  - `RECLAIM_BACKOFF_MS = 5` initially, doubling to a cap of `50`.
  - `OWNERLESS_GRACE_MS = 500`: how long a legacy ownerless `reap/` dir must be observed with the same `(dev, ino)` and still no owner before it counts as dead.
  - `MAX_CLAIM_SLOTS = 16`.
- Iteration caps stay (the 32 lock rounds and 16 reclaim rounds) as a backstop against a clock that never advances.
- Never compare a timestamp written by another process with our clock. The clock only measures intervals **we** observe. Clock domains differ: fake clocks in tests, and other hosts.

### 3.5 Claim slots (replaces the single `reap/`)

Inside one reclaim generation `<j>.lock.reclaim/` (identity `(dev, ino, owner token)`):

- Slot 1 is `reap`. Slot *n* ≥ 2 is `reap.<n>`. Keeping `reap` as slot 1 means an **older** contender's `mkdirSync(reap)` gets `EEXIST` and falls into its existing wait-then-fail path, so old code never acts concurrently with a new holder.
- A new slot is a **file**. Write the token to `<j>.lock.reclaim/.reap.<nonce>.tmp`, then call `linkSync(tmp, slot)`, which fails atomically with `EEXIST`, then unlink the tmp. Do not use directory rename: `rename(dir, emptyDir)` succeeds on POSIX and could overwrite a legacy empty `reap/`.
- To read a slot's owner: if the slot is a file, read its content. If it is a legacy directory, read `reap/owner`. If a legacy directory has no owner, it is `ownerless(dev, ino)`.
- **Slot state:** use `ownerState(token)`. A legacy ownerless dir is `dead` only once the same `(dev, ino)` has been observed ownerless for at least `OWNERLESS_GRACE_MS` on the injected clock. Until then it is `alive` and we wait. This is a defensive margin: old code writes `owner` before it revalidates, so a paused old claimant would still abort on its own revalidation.

Reaper algorithm, replacing `acquireReclaim :922-987`. The reclaim dir exists and its owner is `dead`:

```
G  := readReclaimIdentity(reclaim)                // (token, dev, ino)
deadline := clock.now() + RECLAIM_WAIT_MS
loop (bounded by MAX_CLAIM_SLOTS and the iteration cap):
  k := highest existing slot index (0 if none)
  if k > 0 and slotState(k) == 'alive':
      if clock.now() >= deadline: fail closed (live-reaper message, §4)
      sleep(backoff); if identity(reclaim) != G: return false (retry outer); continue
  if k > 0 and slotState(k) == 'unknown': fail closed (unknown-claim message)
  if k == MAX_CLAIM_SLOTS: fail closed (exhausted message)
  n := k + 1
  link slot n; on EEXIST: continue (someone else took n; re-scan)
              ENOENT: return false (generation moved; retry outer)
  // claim, then revalidate
  if identity(reclaim) != G or ownerState(G.token) != 'dead'
     or any slot i < n is not 'dead' or any slot > n exists:
      remove only our slot n if it still holds our token; return false
  rename reclaim -> reclaim.stale.<nonce>          // ENOENT: return false
  validate moved identity == G; else restore and fail closed as today (:970-981)
  rm quarantine (best effort, as today)
  return to outer: create our own reclaim dir
```

Why this is safe:

- **One holder per generation.** Slot creation is exclusive. A contender creates slot *n* only after it has observed slot *n−1* as dead. A live holder of *n* is never observed dead (§3.3 never reports a live owner as dead), so nobody creates *n+1* while *n* is live. If an earlier observation went stale, the post-claim check "no slot > n" catches it.
- **Delayed contender.** C reads "slot k dead", stalls, and meanwhile B reclaims and a live successor generation G′ appears. C then links `reap.<k+1>` inside G′ and succeeds, because G′ has no slots. C's revalidation sees `identity != G`, so C removes only its own slot and retries. G′'s owner releases by renaming the whole dir, so a stray slot file in it does no harm. This is the same claim-then-revalidate argument as #233, applied once per slot.
- **No regress.** An abandoned slot *n* is handled by slot *n+1*, and nothing ever has to delete *n*. The chain is bounded by `MAX_CLAIM_SLOTS`. Reaching the cap needs 16 consecutive reapers to die mid-reclaim, and that fails closed.
- **Unreachable restore.** The holder of the live highest slot is the only process that moves G, and G's owner is dead, so it cannot release G. The quarantine-restore path at `:970-981` therefore becomes defensive. Keep it, and keep its message.

The main-lock step after acquiring reclaim (`acquireLock :866-879`) is
unchanged, except that it uses `ownerState(current) === 'dead'` in addition to
`current === owner`.

### 3.6 What stays the same

- `assertWritable` and the poison-on-lost-lock behavior. The token is compared as an exact string.
- `openStores` in-process exclusion and canonical-path keys.
- `releaseLock` and `releaseReclaim` act only when the token matches, and quarantine before removing.
- All journal, compaction and replay behavior.

## 4. Failure behavior and messages

The open still throws `host store is already open: <canonical j>` with a
suffix. Each case names exact canonical paths. A suffix gives a removal hint
only when no owner is known to be alive (this keeps `:1149`).

| Case | Suffix |
| --- | --- |
| Lock owner `alive` | none (today) |
| Lock or reclaim owner `unknown` (foreign host, unparsable, `/proc` denied) | `owner of <path> cannot be verified from this host; confirm no weave process on any host is using <j>, then remove <path> and retry` |
| Live reaper past `RECLAIM_WAIT_MS` | `stale-lock reclaim is in progress by a live process (<slot path>); retry later` (no removal hint, because the owner is alive) |
| Slot owner `unknown` | `stale-lock reclaim is blocked by <slot path>; confirm no weave process is using <j>, then remove <reclaim dir> and retry` |
| `MAX_CLAIM_SLOTS` exhausted | as above, naming the reclaim dir |
| Quarantine restore failed | unchanged (`:975-978`) |

Every unexpected `errno` propagates (fail closed). Only the `errno`s listed in
§3.5 are treated as races. `catch {}` stays limited to best-effort garbage
removal, as today.

Test `:422` changes. Its claimant token `${process.pid}:claimant` is legacy,
and `kill(pid,0)` succeeds on it, so it reads `alive`. Today that case ends with
a removal hint. Under this plan it ends with the live-reaper message, which has
no removal hint, after `RECLAIM_WAIT_MS` on the injected clock. Update the
assertion, and record the behavior change in the PR.

## 5. Cancellation and crash points

`open` is synchronous and takes no `AbortSignal`, so cancellation means the
process is killed. Every kill point must leave a state the next opener either
reclaims automatically or refuses because a live owner exists:

| Killed after… | Leftover | Next opener |
| --- | --- | --- |
| write `<j>.lock.<tok>.tmp` | garbage tmp | links normally |
| link `<j>.lock` | lock, owner dead | reclaims |
| mkdir reclaim temp | garbage `.tmp/` | ignores it |
| rename into `<j>.lock.reclaim` | reclaim dir, owner dead, no slots | slot 1, reclaims |
| write `.reap.<nonce>.tmp` (before link) | garbage inside the reclaim dir | ignores it; removed with the generation |
| link slot *n* | slot *n* dead | slot *n+1*, reclaims |
| rename to `.stale.*` | garbage quarantine; lock still dead | new generation, reclaims |
| unlink `<j>.lock` (before releasing reclaim) | reclaim dir with a dead owner; no lock | links normally; the next stale lock reaps that reclaim dir |
| link our new lock (during journal read) | lock, owner dead | reclaims |
| legacy: `mkdir reap` before `owner` | ownerless `reap/` | dead after the grace, slot 2 |

Garbage (`*.tmp`, `.stale.*`, `.released.*`) never blocks progress. Sweeping it
is a non-goal (§8).

## 6. Concurrency and races to avoid

1. **Check-then-act on a shared path.** Never `unlink` or `rename` the lock, the reclaim dir or a slot based on a read that was not followed by an exclusive claim and a revalidation. This is the #233 invariant.
2. **Deleting an abandoned claim.** Never remove another owner's slot, even a dead one. Superseding it with a higher slot avoids the case where a delayed deleter removes a live replacement.
3. **Empty-then-fill visibility.** Publish every owner record with `linkSync` of a fully written file. Today's `mkdir reap` then `write owner` is the source of the ownerless state.
4. **`rename(dir, emptyDir)` succeeding on POSIX.** Slots are files, not directories, so this cannot happen to them.
5. **PID reuse, including our own PID.** Use the start-time identity on v2 tokens. Legacy tokens and hosts without `/proc` fall back to today's behavior, which is conservative.
6. **Foreign hosts and namespaces.** Never probe; report `unknown`.
7. **Worker threads.** Same PID and separate `openStores`. Use the v2 start match, so the owner is `alive`. Never apply "own PID means stale" to v2 tokens.
8. **Time as liveness.** No lease and no TTL on owners with a verifiable identity. A paused (SIGSTOP or GC) live writer must never lose its lock to a timer. That would break H1-T05 and risk two writers.
9. **Cross-process timestamps.** Never compare them. The clock measures only our own observation intervals.
10. **Mixed versions.** Older readers fail closed on v2 tokens (`parseInt` gives `NaN`). Older reapers see slot 1 `reap` and get `EEXIST`. Assumption: an older reaper that is *already* past its own revalidation when a new contender arrives is covered only by the existing restore path. Record this in the PR.
11. **A clock that never advances.** Iteration caps still terminate.

## 7. Tests (red first, then green)

All tests go in `packages/agentfabric/test/store.test.ts`. They use the
existing tools: `spawnSync` for a real dead PID, the
`createRequire('node:fs')` + `syncBuiltinESMExports` fs interposition, and an
injected `sleep`. A fake `clock` is added that advances inside `sleep`. There
are no real timers.

**Red: these must fail on `main` before implementation.**

1. `reclaims automatically when the reap claim owner is dead`: converts `:459`. Setup: lock = dead PID, reclaim owner = dead, `reap/owner` = dead token. Expect: open succeeds, the journal is intact, the old lock is replaced, the reclaim dir is gone, and no manual message.
2. `reclaims a legacy ownerless reap claim only after the observed-stable grace`: converts `:1106` and keeps its `direct`, `file` and `parent` alias variants. Use a fake clock. Assert that no takeover happens before `OWNERLESS_GRACE_MS`, that it happens after, and that no sleep was requested beyond the bound.
3. `an ownerless claim that gains a live owner during the grace is not superseded`: write `reap/owner` = live v2 token mid-wait. Expect a fail-closed live-reaper message and an untouched claim.
4. `a v2 lock whose pid was reused (own pid, different start) is stale`: reclaims.
5. `a v2 reclaim-dir owner and a v2 reap-claim owner with a reused pid are stale`: reclaims.
6. `a dead slot n is superseded by slot n+1`, and `a dead chain up to n reclaims`.

**Guards: green on `main`, and must stay green.**

7. `a v2 lock from a live sibling worker thread is refused`: open in a `Worker`, then open in the main thread. Expect `already open`, with the lock and journal unchanged (H1-T05 analogue).
8. `a foreign-host v2 owner is never reclaimed, even with a dead local pid`: lock and reclaim variants. Expect a manual message that never removes a live owner and leaks no private token text (`:447`, `:1168`).
9. `a live reaper is waited for up to RECLAIM_WAIT_MS on the injected clock, then fails closed with no removal hint`: adapts `:422`. Use a clock that jumps, and assert that the bound comes from the clock and not from the sleep count.
10. `two contenders that both see slot k dead: exactly one links k+1`: interpose `linkSync`. The loser waits, then acquires in turn (like `:341`).
11. `a delayed contender that links into a successor generation removes only its own slot`: interpose `readFileSync`, as in `:902`. The successor's owner and contents are unchanged.
12. `the post-claim check aborts when a higher slot exists`.
13. `slot exhaustion fails closed naming the reclaim dir`.
14. `a non-advancing clock still terminates via iteration caps`.
15. `new tokens are never parsed as a PID by legacy readers`: assert that `Number.parseInt(readFileSync(lock), 10)` is `NaN`.
16. `slot 1 keeps the legacy name`: while the new code holds slot 1 (paused by interposition), `mkdirSync(<reclaim>/reap)` throws `EEXIST`.
17. Crash-point matrix: one parameterized test per row of §5. Write the leftover state with dead tokens, then expect open to succeed and the journal to be intact.
18. Existing tests `:341`, `:380`, `:494`, `:902`, `:952`, `:990`, `:1031`, `:1065`, `:1149`, `:1181`, `:1351` and `:1832` keep passing, with assertions adapted only where the token format is part of the setup. Adapted tests use legacy tokens wherever they test legacy behavior.

**Checks.** `npm run check` (`no-ambient-clock` must pass with no new
allowlist entry), the narrow
`node --test packages/agentfabric/dist/test/store.test.js`, then `npm test` and
`npm run verify` as available. `examples/cli-generations.test.ts` must stay
green if the example passes a clock.

## 8. Non-goals

- Time-based leases, heartbeats or TTLs for owners with a verifiable identity.
- Automatic reclaim of `unknown` owners (foreign host, unreadable `/proc`, unparsable token).
- Sweeping garbage (`*.tmp`, `.stale.*`, `.released.*`). It can be a follow-up with an own-nonce-only rule.
- Kernel advisory locks (`flock` or `fcntl`). Node has no built-in API and AGENTS.md forbids new dependencies.
- Changes to the journal format, compaction, replay, or `assertWritable` semantics.
- Windows liveness beyond today's `kill(pid,0)` fallback.
- Async or cancellable `open`.
- Making the wait constants configurable.
- Any change to `@weave/weave` or other packages, beyond optionally passing `clock` in `examples/cli-generations.ts`.

## 9. Implementation order (for the follow-up PR, not this commit)

1. **Contract first.** Add a short "Store writer lock" section to `packages/agentfabric/UNCERTAIN-CONTRACT.md` next to `:185`, or to the `FabricStore` doc comment if the reviewer prefers. It covers the token, the liveness table, the slot rule, the messages and the non-goals.
2. Red tests 1–6. Run them and record the failures.
3. Add `OwnerTokenV2`, `ownerState` and the lazily cached local host and start identity. Swap the call sites. Tests 4, 5, 7 and 8 go green.
4. Add `clock` to the options, with the virtual default and deadline waits. Test 9 goes green.
5. Add slot files and the chain algorithm. Tests 1–3, 6 and 10–17 go green.
6. Full suite and checks. Write the PR notes: the `:422`, `:459` and `:1106` behavior changes and the assumptions in §10.

## 10. Assumptions and open questions

- **Assumption:** `/proc/<pid>/stat` starttime together with `boot_id` and the PID-namespace link identifies a process incarnation on Linux, as the bench lock already assumes.
- **Assumption:** `randomUUID` in agentfabric is acceptable, because the entropy check does not scan it. A nonce built from `(threadId, sequence)` plus `start` would be enough on Linux. The UUID covers hosts where `start` is null.
- **Assumption:** stores do not run concurrently with versions older than #233.
- **Open question:** where should the contract text live: `UNCERTAIN-CONTRACT.md` or the store doc comment? Does "store writer lock" deserve a `GLOSSARY.md` entry? The current proposal is no glossary entry, because the term is internal to agentfabric.
- **Open question:** should the operator command (`examples/cli-generations.ts`) pass a real clock? The current proposal is yes. Otherwise waits are measured as slept time, which is accurate enough with `Atomics.wait`.
- **Open question:** constant values (2000 ms wait, 500 ms grace, 16 slots) are judgment calls. No measurement supports them.
