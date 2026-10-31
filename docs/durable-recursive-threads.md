# Durable recursive threads and execution claims

Status: design note for #320 (WV-320). Nothing here is implemented. It
proposes language, records and transitions, and one thin increment. It
records one gap in the existing queue (§9.1), with its failing check
specified but not yet run (§15).

## 1. Decision

Extend the existing **Thread** instead of adding a Task entity or giving each
thread its own worker. A Thread becomes a durable record within one goal. It has
an identity, a purpose, a completion condition, an optional parent,
dependencies on other threads' results, and a budget and authority share. It
advances only through **actions** that Loom dispatches for it. Each running
action holds one **execution slot** through an **execution claim**. A thread
that is waiting holds no claim and no slot.

Accepting and keeping work is a journal append. Allocating compute is the
`pending → running` transition, which already exists for actions. Everything
else follows from three rules:

1. **Recording work needs no compute.** `thread.opened` appends an
   observation; it reserves no slot, opens no operating process and starts no
   worker.
2. **Waiting releases capacity.** A thread is waiting exactly when it has no
   running action and its join condition is not met. A parent waiting on its
   children has no running action, so it cannot hold the capacity they need.
   The design has no state for a thread that holds a claim while it waits.
3. **Only Loom changes a thread.** Worker reports, child completion, model
   proposals and late results are observations. Deterministic rules turn them
   into thread transitions. A transition caused by an attempt's output is
   validated against the thread's current revision and the recorded claim of
   the attempt that produced it, not against a claim still held (§7).

## 2. What exists today

| Foundation                                                                                                                                                       | Where                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Execution capacity is a counter, separate from budget and effect locks                                                                                           | `runtime.ts:106`, `runtime.ts:271`, `runtime.ts:1371-1372`     |
| Selected work waiting for a slot is durable `action.queued` (`pending`)                                                                                          | `runtime.ts:1377-1383`, `state.ts:353-384`, M1 doc §6          |
| `pending → running` is fenced: a second start, or a start of non-pending work, is refused                                                                        | `validation.ts:367-375`                                        |
| Transitions are serialized: one writer, one append at a time                                                                                                     | `runtime.ts:556-567`, `runtime.ts:601-679`                     |
| Duplicate observation ids are rejected, so derived appends are idempotent                                                                                        | `runtime.ts:623-627`                                           |
| Cancelling queued work releases its reservation and never starts it; running work only records the request                                                       | `state.ts:423-436`, M1-T10                                     |
| Results, cancellation and authority changes progress under saturated slots                                                                                       | M1-T16, `ARCHITECTURE.md:225-229`                              |
| Dependencies gate selection; uncertain unreconciled actions keep effect locks                                                                                    | `scheduler.ts:23-26`, `scheduler.ts:55-57`                     |
| Recovery: load, then reconcile running and uncertain work under a finite allowance, then drain the queue                                                         | `runtime.ts:1845-1898`, `runtime.ts:2818-2823`                 |
| Budget is charged once on result; reconciliation does not charge again                                                                                           | `state.ts:385-416`                                             |
| Grants are single-use, in-process issued objects (identity is the authority boundary)                                                                            | `agentsop/src/grants.ts:90-139`                                |
| Workstreams hold goals; an operating process is one workstream's execution state and may be backed by nothing                                                    | `WORKSTREAM-CONTRACT.md:111-118`, `operating-process.ts:10-12` |
| A Thread exists only as a Weft projection: one per dispatched action, `joins` from dependencies, `supersedes` by operation and resources                         | `weft.ts:285-319`                                              |
| Execution provider: a suspension releases the worker; scripted doubles cover interleaved Threads and cancellation, but scheduler capacity integration is blocked | `execution-provider-contract.md` (`close`, X-T09, X-T10)       |
| A dependency that ends with no result is `failed` or `uncertain`, and the parent continues                                                                       | `m3-fill-a-capability-gap.md` §5                               |

What is missing is a durable Thread record: no parent, no completion
condition, no waiting reason and no result reference that survives restart.
There is also no rule that ties capacity to a thread instead of to an
action.

## 3. Terminology resolved

- **Thread** keeps its glossary meaning: a causally related sequence of
  actions and observations within one goal. This note gives it a durable
  record and a parent link. It does not widen it beyond one goal.
- **Workstream** (#26) stays the cross-goal stream. Its rename (#329) is out
  of scope. #26's "independent Threads" are workstreams in this repository
  (`WORKSTREAM-CONTRACT.md:12-23`).
- **Operating process** (#28) is per workstream, not per thread. #28's
  process-per-thread wording is settled this way: no thread gets an operating
  process, a model session or a worker of its own. A provider may back one
  running action with a worker. It releases that worker when the action
  ends or suspends. Whether the operating process state becomes a projection
  of the goal's threads is open (§17, Q5).
- **Weft `thread_id`** today names one action's projection (`weft.ts:285`).
  With durable threads it would name the thread record, and attempts would be
  its actions (#187). Weft stays a projection; scheduling never reads it.
- **`intake.classify`** still says `new_thread` and `running_threads`
  (`sites/index.ts:25-26`, `:59-60`). Those are summaries of running work.
  They are a frozen benchmark vocabulary and are not renamed here.
- **Claim** in Agensh (§2, Appendix B, as summarized in #320) is a
  coordination announcement that peers negotiate over. A Weave **execution
  claim** is a runtime-recorded, fenced right to occupy a slot. It is not
  negotiated and it is not an effect lock.

## 4. Options compared

| Option                                                          | Accept and keep work without compute  | Waiting parent and capacity                                  | New primitives                                                               | Verdict    |
| --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------- |
| Separate Task model beside Thread                               | Yes                                   | Depends on its own scheduler                                 | Second hierarchy: identity, cancellation, dependencies and budget duplicated | Rejected   |
| Immediate per-thread allocation (worker/session/process)        | No: a new thread needs a slot at once | Parent holds a slot while waiting; one slot deadlocks a fork | Worker pool, session lifecycle                                               | Rejected   |
| **Extend Thread; action is the attempt; slot claimed at start** | Yes: `thread.opened` is an append     | Structural: waiting means no running action                  | Thread record and its transitions; claim fields on an existing action start  | **Chosen** |

The chosen option keeps the action as the only unit of execution. It keeps
`executionSlots` as the only capacity, and `action.queued` as "accepted, no
slot". It adds no workflow engine, distributed scheduler or permanent worker
pool. Workers come in only through the execution provider (#328), for
actions whose execution outlives one host call.

## 5. Thread contract

### 5.1 Record (`thread@1`, derived by folding the journal)

| Field          | Meaning                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread_id`    | Bounded id, unique in the goal. Child ids are derived: `<parent>/<opening seq>/<index>`                                                                   |
| `goal_id`      | Fixed. A thread never leaves its goal                                                                                                                     |
| `parent`       | Thread id or null (the goal's root thread). Explains why the thread exists. It does not decide when the thread may proceed                                |
| `purpose`      | Reference to the observation or accepted proposal that states it (`opened_by`), plus a digest. Not free text copied from a model                          |
| `completion`   | Ordered condition list. Each item names how it is established: `reference`, `check`, `judgment` or `review` (§10)                                         |
| `depends_on`   | `{ thread_id, result_key, required }[]` result references this thread reads (§6)                                                                          |
| `share`        | Authority (subset of the parent's) and budget lines carved from the parent's unallocated share (§11)                                                      |
| `deadline`     | Tick, at most the parent's                                                                                                                                |
| `revision`     | 0 at opening; +1 only on a steer. Opening children, changing dependency edges and accepting results never change it. Claims and results bind to it (§6.3) |
| `lifecycle`    | `open`, then exactly one terminal: `completed`, `failed`, `cancelled` or `superseded`                                                                     |
| `cancel`       | Evidence of a cancel request, or null                                                                                                                     |
| `resume_point` | `{ ref, digest }` under Loom's custody, when the last attempt suspended with a continuation (same shape as `operating-process.ts` `ResumePoint`)          |
| `results`      | Accepted result references: `{ result_key, thread_revision, artifact_id, artifact_revision, digest, produced_by, inputs, accepted_by }` (§10)             |
| `evidence`     | Seqs supporting each transition                                                                                                                           |

A thread exists from `thread.opened`, before any action. The record holds ids,
digests and seqs only. It holds no payload, grant, slice or transcript.

### 5.2 Three axes, kept apart

1. **Lifecycle** is durable and recorded: `open`, then a terminal outcome.
2. **Eligibility** is derived each cycle and never stored as authority:
   - `ready`: open, no cancel request, every required dependency edge is
     satisfied (§6.3), current authority admits the next candidate, and the
     goal is active and not paused.
   - `unmet(edges)`: as `ready`, except that at least one required edge is
     unmet: its producer has settled with no current result for the key
     (§6.3). The thread may claim a slot, but only for a failure-handling
     attempt (§6.4). `unmet` takes precedence over `waiting(dependency)`, so
     a failure is handled without waiting for unrelated siblings.
   - `waiting(reasons)` with closed reasons: `dependency`, `approval`,
     `capability`, `reconciliation`, `budget`, `pause`. The first three match
     `operating-process.ts` `WaitReason`.
   - `blocked(reason)`: a deterministic refusal that needs new evidence or a
     human, for example an exhausted share or recovery allowance.
   - Lack of capacity is not a waiting reason. A ready thread with no free
     slot is still ready, and the board shows it as unclaimed.
3. **Ownership** is `unclaimed` or `claimed` by exactly one running action
   (§7). It is derived from action records and never written separately.

A board is a projection over these three axes and disclosed result
references. It schedules nothing, stores nothing and grants nothing.

### 5.3 Transitions

| Observation (proposed)                                                    | Requires                                                                                                                                                                  | Effect                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread.opened { parent, threads[], edges[] }` (runtime)                  | Parent open and not cancelled; derived from an accepted proposal or a rule; limits, authority subset, share fit and acyclicity hold (§6, §11)                             | Opens every listed child, and adds or rebinds the parent's dependency edges to their result keys, in one append, which is atomic. The parent's revision is unchanged |
| `action.started` with `thread_id`, `thread_revision`, `attempt`, `inputs` | Thread `ready` or `unmet`, no running action for it, revision current, slot free (§7). `inputs` are the current result references disclosed to the attempt                | Claim acquired and recorded. Grant issued now, not at queue time                                                                                                     |
| `action.result` for that action                                           | As today (`validation.ts:407-418`)                                                                                                                                        | Claim released; its record stays. The output may offer named results, a proposal or a resume point                                                                   |
| `thread.result_accepted { thread_id, result_key, action_id, by }`         | Thread open; the offer passes the producing-claim fence (§7); no current accepted result for the key; established by a reference, a check, a judgment or a review         | Result recorded as current. Revision unchanged; dependants re-evaluated                                                                                              |
| `thread.revised { thread_id, change }` (steer, or dependency edges)       | Open; source authorized: an operator steer via `input.route` `steer` (#27/#90), which alone may drop or weaken a required edge; acyclicity                                | Steer: revision +1, and results at the old revision stop being current (§6.3). Edges only: revision unchanged; eligibility re-evaluated                              |
| `thread.cancel_requested { thread_id, reason }`                           | Open                                                                                                                                                                      | No new claims. Pending actions are cancelled; running ones get cancel requests. Cascades to open descendants                                                         |
| `thread.settled { thread_id, outcome, evidence }`                         | `completed`: completion condition established (§10), every required edge satisfied, no required child open, no unreconciled uncertain effect in the subtree. Others: §6.4 | Terminal. Unused share returns to the parent                                                                                                                         |

## 6. Hierarchy and dependencies

### 6.1 Parentage and dependencies are different edges

The parent edge records why a thread exists. Dependency edges decide what may
proceed. A parent usually depends on its children's results. A thread may
also depend on any thread in the same goal (cross-branch reuse). It reads
that thread's **named result**, not its completion, and only through the
slices its view discloses (§11).

### 6.2 Asymmetric nesting and partial results

Every thread decides independently whether to act directly, decompose, or
both. Nesting needs no per-level structure. One child can finish with one
lookup while a sibling opens grandchildren. A thread can publish a named
result before it completes, for example `api_diff` before its migration
notes. Dependants of that key become ready without waiting for the producer
or its siblings to finish. Accepting a result does not change the
producer's revision, so `api_diff` stays current while the same thread's
later results, or its siblings' results, are accepted.

### 6.3 Joins, result currency and optional children

An accepted result is **current** while both of these hold:

- its `thread_revision` equals the producer's current revision, and
- every result reference in its `inputs` (what the producing attempt was
  disclosed, recorded on its `action.started`) is itself current.

The check walks result references within one goal. Acyclicity (§6.5) keeps
the walk finite and the limits in §8 keep it bounded. A result therefore
goes stale only when its producer is steered or a result it read goes stale.
Accepting another result, of this thread or any other, never makes it
stale. At most one result per `(thread_id, result_key)` is current at a
time.

A join is the set of `required` dependency edges. Each required edge is in
exactly one derived state:

- `satisfied`: the producer has a current accepted result for the key;
- `pending`: not satisfied, and the producer is open;
- `unmet`: not satisfied, and the producer has settled (`failed`,
  `cancelled`, `superseded`, or `completed` without a current result for
  the key).

A thread is `waiting(dependency)` while a required edge is `pending` and
none is `unmet`. It is `ready` when every required edge is `satisfied`, and
`unmet` when any required edge is `unmet` (§5.2). An unmet edge is never
treated as satisfied: it satisfies no join, it is never an input, and a
thread cannot complete while it has one. `optional` edges never block. A
parent **may** complete with optional children outstanding. Completion
requests cancellation of those children. They keep their identity, effect
locks and late results as evidence. A required child that is open blocks
completion.

### 6.4 Failure, cancellation, supersession, orphans

- **Failure.** A child that settles `failed` satisfies no join, but it is
  still evidence. A required edge to it becomes `unmet`, and the parent
  becomes `unmet` (§5.2). It claims a slot like a ready thread, for a
  **failure-handling attempt**, with a fresh grant from its remaining share.
  That attempt is disclosed its satisfied inputs and, for each unmet edge,
  the producer's settle outcome and evidence references, never a result.
  Its output may propose only:
  - a replacement: one `thread.opened` that opens a child with a new id and
    rebinds the unmet edge to that child's result key, in the same append;
    or
  - settling the parent `failed`, which cascades cancel requests to its open
    children.

  The attempt's offered results are never accepted, because its recorded
  `inputs` do not cover every required edge (§7). If the attempt ends
  without an accepted replacement, Loom settles the parent `failed`, citing
  the unmet edges and the attempt's result. Retries draw on the same share
  and limits (§8, §11), so failure handling is finite. An unmet `optional`
  edge needs no handling. Only an operator steer may drop or weaken a
  required edge (§5.3). The failed child stays as history
  (`m3-fill-a-capability-gap.md` §5).

- **Cancellation.** Cancelling a thread cascades cancel requests to every open
  descendant. Requests are recorded separately from outcomes, as for actions
  (`ARCHITECTURE.md:233-236`, `:258-263`). A thread settles `cancelled` once
  its own running action has a terminal outcome. A required edge to a
  cancelled child is `unmet` (§6.3).
- **Supersession.** A parent steer that changes what a child was opened for
  settles that child `superseded`, by rule or by the parent's next attempt.
  The replacement is a new thread, and the opening rebinds the parent's edge
  to it. Results of the superseded child are kept as evidence and do not
  satisfy the parent's new join. An edge left bound to the superseded child
  is `unmet` and handled as a failure.
- **Orphans are prevented by an invariant.** An open thread either has an open
  parent or has a cancel request. Any transition that settles a parent and
  leaves an open child without a cancel request is refused.

### 6.5 Cycle prevention

At `thread.opened` and `thread.revised`, validation refuses a dependency
edge that would close a cycle among dependency edges. It also refuses an
edge to an ancestor's **completion**, because an ancestor's completion
waits on its descendants. A thread may read an ancestor's named result
that is already accepted and current. The check is a walk over one goal's graph, which
the limits in §8 keep bounded.

## 7. Execution claims

The smallest mechanism that works is the existing atomic action start. No
lease service or distributed lock is needed while Loom is the single writer
of the journal.

- **Acquire.** An execution claim is acquired when `action.started` for a
  thread's action is accepted. That happens in one serialized step, which
  checks that the thread is `ready` (or `unmet`, for a failure-handling
  attempt), has no running action and is at the revision the action was
  formed against, and that a slot is free.
  `validation.ts:373` already refuses a second start of the same action.
  The thread rule adds one live action per thread. Concurrency inside a
  thread is expressed by child threads, which cost one append each. The
  grant is issued at this moment, under current authority (§9.1).
- **Bind.** The claim is `(thread_id, thread_revision, attempt, action_id,
  invocation_id, holder)`, recorded on `action.started` together with the
  attempt's `inputs`. `holder` is `loom` for in-process execution, or the
  execution provider's run identity. The `action_id` is the fencing token.
- **Release.** A terminal `action.result` releases the claim and its slot.
  The claim's record stays in the journal. When an attempt suspends with a
  continuation, its result carries a resume point. The thread then holds
  that resume point, but no claim and no slot.
- **Producing-claim fence.** A result is accepted after its claim is
  released, so acceptance never requires the claim to be live. An offer is
  validated against its **producing claim**, the recorded claim of the
  action whose terminal `action.result` offered it. It passes when all of
  these hold:
  - that `action.result` is recorded, its outcome is a success or a
    reconciled committed outcome, and it offered this key and digest;
  - the claim's `thread_revision` equals the thread's current revision;
  - the claim's `inputs` satisfy every required edge and are all still
    current (§6.3), so a failure-handling attempt's offers never pass;
  - no later `action.started` for the thread was recorded before that
    `action.result` (stale-attempt fence). Because a thread has one running
    action at a time, a later start can precede an earlier attempt's result
    only after that attempt became `uncertain` and was reconciled
    `not_committed`.

  Each check reads recorded seqs only, so a replay or restart decides the
  same way. The derived observation id is `accept:<action_id>:<result_key>`,
  so duplicate observation-id rejection (`runtime.ts:623-627`) makes a
  re-derived acceptance idempotent. A refused offer stays as evidence.

- **Renew and expire.** These apply only to actions held outside Loom's
  process lifetime (#328). Such a start carries `valid_until_tick`. The
  provider's trusted supervisor renews it through host ingress. A renewal
  cannot go past the thread or goal deadline, and it renews no grant,
  approval or budget. On a `clock.tick` past `valid_until_tick` with no
  result, Loom records the action `uncertain`. That reuses the recovery path
  (`runtime.ts:1877-1895`). Expiry does not prove that execution stopped.
  Effect locks stay held until reconciliation. The slot is quarantined until
  the provider reports the worker terminated, within its finite termination
  grace (`execution-provider-contract.md` `close`, X-T09). There is no
  ambient clock: ticks are observations.
- **Handoff.** There is no direct transfer. The holder suspends (dump), the
  result releases the claim, and a later start claims anew with
  `attempt + 1`. The restore presents the resume point's digest. Single-use
  grants are never carried across: each attempt gets a fresh grant.
- **In-process holders** need no expiry. If Loom dies, its claims die with it.
  Restart treats every `running` action as unfinished and reconciles it
  (§9).

## 8. Compute scarcity and liveness

- **Persist under exhaustion.** With zero free slots, `thread.opened`,
  `action.queued`, results, cancellation, steering, authority changes and
  reconciliation all still apply (M1-T16 at action level). Ready threads stay
  ready and durable. The cycle records `waiting` and does not spin.
- **Bounded wake and recheck.** Eligibility is recomputed only when an
  accepted observation touches a thread's dependencies, authority, budget,
  deadline or claim. Each such observation causes at most one cycle. There is
  no polling loop, so an idle goal costs nothing.
- **Fairness.** Claim order is weight (`frontier.weigh`), then oldest
  `thread.opened`, then id. A continuation whose join was just met competes
  like any ready thread. Starvation is bounded by a skip count: a ready
  thread passed over K times goes ahead of higher weights (K is open, §17).
  Today `drainQueue` sorts by `action_id.localeCompare`
  (`runtime.ts:1781-1783`). That is lexical, not arrival order: `a:10:0`
  sorts before `a:9:0`. It is deterministic, but it is not oldest-first
  (#242).
- **Backpressure.** Per goal there are limits on open threads, depth and
  fan-out per opening, plus each thread's budget share. Over a limit,
  `thread.opened` is refused with a closed reason. The proposing attempt gets
  the refusal as an observation and can do the work directly or wait.
  Accepted work is never dropped to make room.
- **Deadlines.** A tick past a thread's deadline requests its cancellation.
  The parent sees the child settle `failed: deadline` or `cancelled`. A child
  deadline never exceeds its parent's.
- **Reconciliation never queues behind the work it settles.** It uses the
  recovery allowance, not slots (`runtime.ts:1854-1857`).

## 9. Recovery and stale results

Folding the journal restores threads, edges, revisions, shares and resume
points. They are records, so nothing needs re-deriving from a model.
`running` actions are reconciled as today. `pending` actions are drained
under current authority. Recovery renews no approval, grant or budget, and
the finite recovery allowance still applies.

- **Crash in the middle of a fork.** The fork is one `thread.opened` append.
  Either every child exists or none do. If the proposal was accepted but the
  opening was not, recovery derives the opening again from the recorded
  proposal. The derived child ids and duplicate observation-id rejection
  (`runtime.ts:623-627`) make this idempotent. Recovery does not call the
  model again. This assumes a single JSONL line is appended atomically (§17,
  Q11).
- **Restart during result propagation.** An `action.result` that was recorded
  but has no `thread.result_accepted` is re-evaluated by its deterministic
  rule against its producing claim (§7). The claim was released by that
  result, and acceptance does not need it live. A later start of the same
  thread does not fence the offer, because the result was recorded first. A
  check that is a separate action reconciles like any action. If the result
  was not recorded, the action is `running` and goes through lookup.
- **Restart during failure handling.** A failure-handling attempt's
  recorded result is re-evaluated like any proposal: a missing replacement
  opening is derived again from it, and the derived ids make it idempotent.
  The fallback `failed` settlement is derived from the same recorded result,
  so replay reaches the same outcome and never both.
- **Late results.** A result from an expired claim is recorded and accepted
  as that action's outcome, so it is not lost across restart. The journal
  persists accepted observations only (`runtime.ts:636-658`). If no later
  attempt started before it and the revision is unchanged, it passes the
  producing-claim fence, like a committed outcome found by reconciliation.
  Otherwise the thread transition it would cause is refused as a stale
  attempt or revision. The evidence stays, and the state is fenced.
- **Uncertain committed effects** keep their effect locks and their
  reservation (`ARCHITECTURE.md:273-278`). The thread is
  `waiting(reconciliation)`. Conflicting work is blocked; unrelated threads
  proceed. A committed outcome found by reconciliation is integrated without
  repeating the invocation. `not_committed` makes the thread ready again for
  a fresh attempt, with a fresh grant drawn from the same share.

### 9.1 Gap found: a queued action keeps the grant it was queued with

`dispatch` issues the grant before it decides whether to queue
(`runtime.ts:1353`, `:1371-1383`). The `pending` record keeps it
(`state.ts:377`). `drainQueue` starts the action later with that stored
grant (`runtime.ts:1813-1824`). It rechecks authority only for
`report.publish` (`runtime.ts:1399-1408`).

Fabric grants are object-identity-bound to the authority that issued them
(`grants.ts:90-95`). After a restart the stored grant is a JSON copy, and the
new authority instance never issued it. The host refuses it as "grant is not
issued by this authority" (`host.ts:1643-1646`, `:1852-1854`). The runtime
records `failed` (`runtime.ts:2561-2565`). A failed candidate is never formed
again (`candidates.ts:69-76`). So work queued for compute before a restart
fails instead of resuming. That breaks M1 §4: recheck authority before
dispatch, then record the start "and its version-bound grant". The grant is
supposed to be issued at start.

This is the action-level form of this note's main rule: claim when capacity
is reserved to begin, not while queued. The fix is to issue the grant in
`drainQueue` at start, after `stillAuthorized`, and to record
`grant: null` on `action.queued`. Validation already allows a null grant.
Replay does not invoke, so recorded logs still replay. The budget
reservation stays at queue time: it is accounting that prevents
overcommitment, not an execution claim (`state.ts:381-382`, `:428-433`).
Pending actions also keep effect holds in selection (`scheduler.ts:23-26`).
That keeps conflicting work in order and does not delay reconciliation.

This finding comes from reading the code. It was not executed here (§15, RT-00).

## 10. Results and finalisation

A **result reference** is `{ thread_id, result_key, thread_revision,
artifact_id, artifact_revision, digest, produced_by, inputs }` plus the
evidence that accepted it. `produced_by` is the producing action's id, and
`inputs` are the result references its claim recorded. A reference is used
only while it is current (§6.3). An attempt's output offers results. A
worker's statement that it is done is an observation and is never accepted
on its own.

Acceptance and completion use the same ladder. Each step is used only for
what the steps before it could not establish (#197):

1. **Reference.** The result is an established output that is still valid:
   an admitted capability's output with a matching read set, or a cached
   conclusion whose invalidation conditions hold.
2. **Check.** A deterministic check bound to an oracle the producer cannot
   write (Criterion proof `check`, acceptance predicates).
3. **Judgment.** A bounded judgment site, such as `task.validate` facts,
   decides what remains, under thresholds declared before the run.
4. **Review.** The audit tier or the operator reviews where the completion
   condition requires it.

A parent's continuation becomes eligible when its join is met, or when an
edge is unmet, for a failure-handling attempt only (§6.4). Once the join is
met, its final attempt may cite an accepted result, combine artifacts, request judgment,
or run a review. The parent completes only against its own completion
condition, never because its children completed. A steer increments the
parent's revision. The parent's own results at the old revision, and any
result that read them, stop being current. A later attempt at the new
revision may offer the same artifact again, and acceptance by reference
then revalidates it. Child results stay current, because they are bound to
the child's revision. A steer that changes what a child is for supersedes
the child instead (§6.4). Goal
completion still needs the goal's recorded success evidence
(`ARCHITECTURE.md:115-120`). The root thread completing is necessary for
that, but not sufficient.

## 11. Authority, budgets and disclosure

- **No minting.** A child's authority is a subset of its parent's: read and
  write resources, effects and destinations. An opening that widens any of
  them is refused. Approvals stay bound to their exact request
  (`types.ts:166-181`); a child cannot reuse one for another binding.
  Grants are issued per action at start and are single-use.
- **Budget shares.** A child's share is moved out of the parent's unallocated
  share when the child is opened. For every thread, children's shares plus
  its own reserved plus its own spent stay at or below its share. Spend is
  charged once, on the action result (`state.ts:396-399`), and never again on
  reconciliation (`state.ts:405-416`). Retries draw on the same share; it is
  never refilled. When a child settles, its unspent, unreserved remainder
  returns to the parent. An uncertain action keeps its reservation until it
  is reconciled. The recovery allowance stays goal-wide and is restored from
  the log, not renewed.
- **Disclosure.** Each attempt receives a state view assembled from slices
  authorized for its thread: its purpose, its accepted dependency result
  references with the artifact slices policy discloses, and its own
  attempts. A parent sees its children's result references and settle
  status, not their working observations. Shared history is evidence held by
  Loom, not context any thread receives.
- **Authority changes.** Queued and ready work is rechecked when it starts,
  because the grant is issued then (§9.1). Running work has its grant
  revoked, so the host refuses to commit (`host.ts:2233-2235`). The thread
  becomes `waiting(approval)` or `blocked`.

## 12. Ownership

- **Loom** owns thread records, transitions, claims, slots, fairness and
  validation of proposed decomposition.
- **Fabric** is unchanged. It sees invocations, grants and invocation ids,
  never threads, goals or scheduling (`checks/import-direction.mjs`).
- **The execution provider** runs one action's program, reports suspensions
  and releases workers. It holds no grant decision and makes no thread
  transition (#328).
- **Tapestry** presents a disclosed board: lifecycle, eligibility, ownership
  and result references.
- **Weft** projects parent, join, supersede and attempt links (#187). It is
  never read for scheduling.
- **Models** may propose decomposition, dependencies or weights. A proposal
  is an observation. Loom checks limits, authority subset, share fit and
  acyclicity, then applies policy, before any `thread.opened`.

## 13. Worked example (one execution slot)

Goal: write release notes `notes` for v2. Root thread **T0** has this
completion condition: `notes` contains the literal `v2.0.0` (check), every
breaking change is described (judgment), and an audit review passes.

| Step | Observation                                                                                                                                                               | Slot holder | Open threads and eligibility                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| 1    | `goal.opened`; root `thread.opened` T0                                                                                                                                    | —           | T0 ready                                               |
| 2    | T0 attempt 1 starts (framing inference)                                                                                                                                   | T0#1        | T0 claimed                                             |
| 3    | T0#1 result proposes T1 (leaf: list changes since v1) and T2 (summarise breaking changes). One `thread.opened` opens both. T0's join needs `T1.changes` and `T2.breaking` | —           | T0 waiting(dependency); T1, T2 ready                   |
| 4    | T1#1 starts: one `changes.list` capability call                                                                                                                           | T1#1        | T2 ready, unclaimed                                    |
| 5    | T1 result `changes` accepted **by reference** (admitted capability, read set valid); T1 completed. Partial result: T0's join is half met                                  | —           | T0 waiting(T2); T2 ready                               |
| 6    | T2#1 decomposes: T2a (API diff), T2b (migration notes, depends on `T2a.api_diff`), T2c (benchmark deltas, **optional**)                                                   | T2#1 → —    | T2 waiting(T2a, T2b); T2a, T2c ready; T2b waiting(T2a) |
| 7    | T2a#1: `api_diff` accepted **by check**; T2a completed                                                                                                                    | T2a#1 → —   | T2b ready; T2c ready                                   |
| 8    | T2b#1 (weight above T2c): `migration` accepted **by judgment**; T2b completed                                                                                             | T2b#1 → —   | T2 ready (required join met); T2c still ready          |
| 9    | T2#2 combines into `breaking`, accepted by judgment. T2 completes with optional T2c outstanding: T2c is cancelled before it ever started, using no slot                   | T2#2 → —    | T0 ready                                               |
| 10   | T0#2 writes `notes` rev 1 under a write effect lock                                                                                                                       | T0#2        | —                                                      |
| 11   | T0 finalisation: the literal check (an action), then the judgment, then the audit review. All pass; T0 completed. The goal then checks its own success evidence           | checks → —  | none open                                              |

At most one action ran at a time, and no waiting thread held the slot. The
shape is asymmetric: T1 was one lookup; T2 had grandchildren. T1's result
was recorded at step 5 and used at step 10 without waiting for T2's
subtree. No acceptance changed a revision, so `T1.changes` stayed current
while the results of T2a, T2b and T2 were accepted. If T2b had settled
`failed` at step 8, T2's edge to `T2b.migration` would be `unmet`. T2 would
claim the slot for a failure-handling attempt, disclosed `T2a.api_diff` and
T2b's failure evidence. That attempt either opens a replacement child T2d
and rebinds the edge to `T2d.migration` in the same append, or settles T2
`failed`. It never combines `breaking` as if `migration` existed. With zero
slots at step 4, T1 and T2 stay ready and durable; an
operator steer or cancel still applies at once.

## 14. Failure-scenario matrix

"Today" names the action-level behaviour that already holds. The RT checks
are proposed in §15.

| Scenario                                                                          | Expected deterministic outcome                                                                                                                                                                                                                                                                                                                      | Today                                           | Check        |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------ |
| One slot, parent forks a child                                                    | Parent's action ends at the fork, freeing the slot. The child claims it, and the parent continues after the child's result. No deadlock                                                                                                                                                                                                             | No nesting                                      | RT-01        |
| Zero available compute                                                            | Openings, queueing, results, cancel, steer and authority changes all apply. Ready threads persist. The cycle reports `waiting` without spinning. Nothing starts                                                                                                                                                                                     | M1-T05 (`slots: 0`), M1-T16                     | RT-02        |
| Competing claims on one thread                                                    | Exactly one `action.started` is accepted. The other is a refused observation: no slot, no grant, no invocation                                                                                                                                                                                                                                      | Same-action fence `validation.ts:373`           | RT-03        |
| Abandoned claim (holder stops renewing) is reclaimed                              | Tick past `valid_until_tick` records the action `uncertain`. Effect locks stay. The slot stays quarantined until termination is confirmed. After `not_committed`, the next start is attempt 2 with a fresh grant                                                                                                                                    | Recovery path for `running`                     | RT-04        |
| Late result after expiry or supersession                                          | Recorded and accepted as that action's outcome, so it survives restart. If a later attempt started before it, the revision changed or the thread settled, the thread transition is refused as stale; otherwise it is integrated like a reconciled committed outcome                                                                                 | Late committed receipt kept (M1-T11)            | RT-05        |
| Crash in the middle of a fork                                                     | Either all children are open or none are. Recovery derives a missing opening from the recorded proposal exactly once, without calling the model again                                                                                                                                                                                               | Duplicate-id fence                              | RT-06        |
| Restart during result propagation                                                 | A recorded result is re-evaluated against its released producing claim and accepted exactly once, even if the thread's next attempt already started. An unrecorded one goes through lookup. The parent becomes ready once, not twice                                                                                                                | Recovery and reconciliation                     | RT-07        |
| Child completes while the parent is paused                                        | The child result is accepted with no slot. The parent's join is met but it stays `waiting(pause)`. Resume renews nothing; the continuation's grant is issued at its start                                                                                                                                                                           | Operating-process pause rules                   | RT-08        |
| Cancel a parent with running children                                             | Cancel requests cascade, and queued descendants are cancelled at once. Running ones settle on their own outcomes. Locks are held until those outcomes and any reconciliation. No orphan                                                                                                                                                             | M1-T10, M1-T11                                  | RT-09        |
| Steer supersedes a child                                                          | Parent revision +1, and the parent's own old-revision results stop being current. The replacement child is a new id and the edge is rebound to it. Superseded results stay as evidence and satisfy no join                                                                                                                                          | Weft `supersedes` projection only               | RT-10        |
| Authority revoked while queued and while running                                  | Queued: refused at start. Running: the grant is revoked and the host refuses to commit. The thread becomes `waiting(approval)` or `blocked`. A restart does not restore authority                                                                                                                                                                   | M1-T05, M1-T08 (publish only); see §9.1         | RT-00, RT-11 |
| Uncertain committed effect in a child                                             | Locks are held and the child waits on reconciliation. Conflicting work is blocked, unrelated work proceeds. A committed outcome is integrated without repeating it. The parent cannot complete until it is reconciled                                                                                                                               | M1-T12, M1-T14                                  | RT-12        |
| Child opening would widen authority or exceed the share                           | Refused with a closed reason, and the proposing attempt observes the refusal. Spend is charged once, and unused share returns on settle                                                                                                                                                                                                             | Goal-level reservations                         | RT-13        |
| Dependency would form a cycle                                                     | Refused at opening or revision                                                                                                                                                                                                                                                                                                                      | —                                               | RT-14        |
| Queued action survives a restart                                                  | Starts after restart under a grant issued by the current authority. Not `failed: DENIED`                                                                                                                                                                                                                                                            | **Fails** (§9.1)                                | RT-00        |
| Required child fails                                                              | The edge is `unmet` and the parent `unmet`. With one slot, the parent's failure-handling attempt claims it with a fresh grant and either opens a replacement and rebinds the edge in one append, or settles `failed`. Its offers are never accepted, and the parent never completes on the missing result. Restart re-derives the same outcome once | `m3-fill-a-capability-gap.md` §5 (action level) | RT-15        |
| One attempt offers two named results; a sibling's result is accepted between them | Both are accepted and both stay current: no acceptance changes a revision. A result goes stale only when its producer is steered or one of its inputs goes stale, and dependants then wait again                                                                                                                                                    | —                                               | RT-16        |

## 15. Thin increment

**Increment A: grant at start (prerequisite).** This is RT-00. It is
independent of threads and fixes §9.1.

- Red check, added to `test/m1.test.ts` and using the existing fixture:
  `m1World({ slots: 1 })` leaves one inspect running and one pending. Then
  `restoreWorld(world, world.host.snapshot(),
  world.runtime.trace().observations)` runs with no slot limit. Assert that
  the formerly pending inspect reached the restored host
  (`host.invocations`), and that its record is not `failed` with a
  `DENIED: grant is not issued by this authority` failure. Expected red
  today, by reading the code (§9.1).
- Green: issue the grant in `drainQueue` at start, after `stillAuthorized`,
  and record `grant: null` on `action.queued`. M1-T05, M1-T06, M1-T10,
  M1-T16 and the M0 to W5 replay suites must stay green.

**Increment B: one-slot fork and join through the runtime.** The contract
comes first: `packages/weave/src/THREAD-CONTRACT.md`, then red tests against
a placeholder, then the code.

- Scope: a root thread per goal; `thread.opened` with one parent and N
  children, with edge rebinding; `thread_id`, `thread_revision`, `attempt`
  and `inputs` on action starts; one running action per thread; derived
  eligibility, including `unmet` and failure-handling attempts;
  `thread.result_accepted` by `reference` or `check` only (judgment and
  review come later), under the producing-claim fence and result currency;
  cancellation cascade; budget-share conservation; acyclicity. No provider
  expiry, which waits for #328.
- Acceptance: RT-01, RT-02, RT-03, RT-06, RT-07, RT-09, RT-13, RT-14, RT-15
  and RT-16,
  with `FileJournal` restarts at each boundary of the worked example's steps
  3, 5 and 9. Replay of the recorded log matches with zero host invocations.
- Dependencies: #26 and #28 (workstream and process records; unchanged).
  #27 and #90 (steer becomes `thread.revised`; RT-10 follows). #187 (Weft
  links from thread records). #197 (the finalisation ladder; RT for
  judgment and review). #234 (stale-lock reclaim, the model for RT-04).
  #242 (fairness: skip count and the lexical-order finding). #126 and #128
  (budget pause becomes `waiting(budget)`; replay of thread records). #328
  (out-of-process holders: RT-04, RT-05).

No benchmark is needed. These are behavioural checks over fixtures with
injected ticks.

## 16. Glossary changes

Applied in `GLOSSARY.md`:

- **Thread** is updated: durable record, parent, dependencies on named
  results, no capacity while waiting, and child completion never completes
  a parent.
- **Execution slot** is new. The term was used under _Region_ but never
  defined.
- **Execution claim** is new. It includes the producing claim: the
  recorded claim a released attempt's offers are accepted against.
- **Result reference** is new. It includes when a reference is current.
- **Unmet dependency** is new. It includes the failure-handling attempt.
- A language constraint is added: say _execution claim_, not _lease_ or
  _lock_.

## 17. Assumptions and open questions for the captain

1. **Widen Thread or rename?** This note keeps the name _Thread_ and gives it
   a durable record. It does not touch the workstream rename (#329).
2. **One running action per thread.** Concurrency inside a thread happens
   only through child threads. Is that acceptable, or should one thread own
   several concurrent actions?
3. **Completion and uncertainty.** The proposal is conservative: any
   unreconciled uncertain effect in a parent's subtree blocks its
   completion. The alternative is to block only on effects that the
   completion condition reads.
4. **Optional children at parent completion** are cancelled automatically in
   this proposal. The alternative is to let them run on, detached, under the
   goal.
5. **Operating process versus threads.** Should `operating.process@1` become
   a projection of the goal's thread tree (for example `waiting{dependency}`
   when nothing is claimed), or stay provider-reported?
6. **Fairness.** The skip count K is open, and so is whether `drainQueue`'s
   lexical `action_id` order should become arrival order (#242).
7. **Late-result durability** relies on accepting the late result as the
   action's outcome, because the journal persists only accepted observations.
   The alternative is to persist rejected observations too.
8. **Limit defaults** for depth, fan-out and open threads per goal.
9. **Expired out-of-process claims** keep their slot quarantined until the
   provider confirms termination. That trades capacity for safety.
10. **Increment A** changes `action.queued` to carry no grant. Recorded logs
    with grants still replay. Approve the behaviour change.
11. **Fork atomicity** assumes one JSONL line is appended atomically.
    `FileJournal.snapshot` throws on a torn final line, which a later
    hardening step should settle.
12. **Agensh claims.** The paper's claim records are taken as #320 summarizes
    them. The paper was not re-read here.
13. **Failure handling.** One failure-handling attempt per unmet episode; if
    it opens no accepted replacement, the thread settles `failed`. The
    alternative is to allow a bounded number of such attempts before
    settling. Handling also starts as soon as any required edge is unmet,
    without waiting for pending siblings.
14. **Revision scope.** Only a steer changes a thread's revision. Dependency
    changes invalidate results through `inputs` currency instead. This
    assumes every attempt's disclosed inputs are recorded on its start.
