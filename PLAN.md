# WV-347 — Three memory tiers with active eviction

Planning parent: https://github.com/CrowBe/weave/issues/347. This document is the
only deliverable on `wv-347-memory-plan`. No implementation is authorized until
captain go. Child issues below are proposed work, not filed issues or approvals.

Review target and inventory baseline: `61a7cff`
(`plan: WV-347 plan4 address Codex review of 056c521`). It and its ancestors
`056c521` and `7082342` change only `PLAN.md` relative to
`0281c5ed13ee0b3fbedd50399f9ed19837a58c17` (`git diff --stat 0281c5e 61a7cff`),
so every source/test citation below holds at all four commits and was rechecked
at 61a7cff. Proposed names and versions are explicitly marked; they do not claim
existing APIs. This revision (plan5) addresses the GLM review of 61a7cff
(operator workspace file `WV-347-review-61a7cff.json`, not tracked; dispositions
in §9). Earlier fixes are kept: plan4's for the Codex review of 056c521
(`WV-347-review-056c521.json`) and plan3's for the Claude Opus review of 7082342
(`WV-347-review-7082342.json`). The issue brief supplies the
relationship to SLEEP scout #346 and D-ENG-021; neither a SLEEP product contract
nor D-ENG-021's decision record was found in tracked repository text. Applying
D-ENG-021 as briefed, architectural/code-health questions are decided in §7 with
reopen evidence; only product forks stay open. No network lookup or hosted
inference was performed.

## 1. Inventory before design

| Area | Exact existing files and symbols | What exists; what remains absent |
| --- | --- | --- |
| State and time | [types.ts](packages/weave/src/types.ts): `State`, `Observation`, `Seq`, `ClockTickPayload`, `ReadSetEntry`, `AuthorityScope`; [state.ts](packages/weave/src/state.ts): `initialState`, `applyAccepted`, `foldState`, `expireApprovals` | Accepted observations deterministically update State. `clock.tick` supplies time and expires approvals. Opening a goal resets selected goal fields, but retains sources, conclusions, policies and other history. Goal status is `active`, `complete` or `missed` (`State.goal`); there is no cancelled/abandoned goal status. There is no generic memory record, scratchpad lifecycle, or memory TTL here. Whole State must not become evictable. |
| Cached conclusions | [types.ts](packages/weave/src/types.ts): `CachedConclusion`, `InvalidationCondition`, `PolicyRecord`; [reuse.ts](packages/weave/src/reuse.ts): `reuseVerdict`, `callerInScope`, `readSetFreshness`; [runtime.ts](packages/weave/src/runtime.ts): `maybeCacheConclusion`, `reuseConclusion`, `importRetainedConclusions` | Records carry operation/contract/implementation, input digest, output, evidence, resource revisions, scope and invalidation conditions. The runtime produces/reuses these for `text.normalize`; reuse checks admission, scope, matching inputs and resource revisions. Missing revision evidence is uncertain. `applyAccepted` appends conclusions; there is no TTL or score eviction. The optional `conclusion` view slice currently lists all State conclusions' ids/evidence. |
| Conclusion import and dedup | [runtime.ts](packages/weave/src/runtime.ts): `Runtime.importedConclusions`, `conclusionCursor`, `observationIds`, `importRetainedConclusions`, `load`; [host.ts](packages/agentfabric/src/host.ts): `AgentFabricHost.conclusionsSince`, `retainedConclusions`; tests [wv-026d.test.ts](packages/weave/test/wv-026d.test.ts), [wv-n275.test.ts](packages/weave/test/wv-n275.test.ts) | `importRetainedConclusions` reads `host.conclusionsSince(conclusionCursor)` and appends runtime-sourced `conclusion.cached` observations with id `conclusion:imported:<conclusion_id>`, skipping ids in `importedConclusions` or `observationIds`. It returns early in `replayMode`. `conclusionCursor` is process-local (starts at 0), so every restart re-reads from position 0; `load()` rebuilds `importedConclusions` only from retained accepted `conclusion.cached` observations. Retiring the segments that hold those observations would therefore re-import every evicted conclusion. Imports are runtime-sourced (`EXPECTED_SOURCE['conclusion.cached']` is `['runtime']` in [validation.ts](packages/weave/src/validation.ts)), so `replay()` skips them as `CYCLE_APPENDED` and nothing regenerates them: by inspection, a recording containing an import fails `checkPrefix`. wv-n275's "preserves every observation and cycle compared with full reads, including rejected entries" test (lines 110–137) ends with a replay comparison (lines 123–136) that deliberately compares two such replays to each other, keeping "any divergence" rather than asserting `ok: true`. |
| Durable knowledge and mirrors | [store.ts](packages/agentfabric/src/store.ts): `FabricStore`, `FabricSnapshot`, `StoredAdmission`, `StoredWorkload`, `retainConclusion`, `conclusions`; [host.ts](packages/agentfabric/src/host.ts): `AgentFabricHost.retainConclusion`, `conclusionsSince`, `retainedConclusions` | Fabric persists resources, invocation history, admissions, conclusions, workload and cost; the host rebuilds retained conclusion copies. These are useful existing durable knowledge, not a general semantic recall service. Position-based `conclusionsSince(cursor)` slices an append-only array; deleting array entries would break cursors. `FabricLifecycle` in [lifecycle.ts](packages/agentfabric/src/lifecycle.ts) also holds construction/corpus evidence in process; do not claim every lifecycle artifact is durable. |
| Observation journal and replay | [journal.ts](packages/weave/src/journal.ts): `ObservationJournal`, `MemoryJournal`, `FileJournal`, `PersistError`; [runtime.ts](packages/weave/src/runtime.ts): `CYCLE_APPENDED`, `appendStep`, `followAccepted`, `load`, `replay`, `checkPrefix`, `recover` | Accepted observations persist before State integration; rejected ones are logged in process but not journaled. `appendStep` rejects a reused `observation_id` with reason `duplicate` and returns no earlier outcome. `replay()` feeds recorded observations whose source is outside `CYCLE_APPENDED = ['runtime', 'judgment']` verbatim; the cycle regenerates runtime/judgment observations and `checkPrefix` requires a `stableStringify` match. `followAccepted` already appends runtime follow-ups synchronously (for example `goal.missed`), which replay regenerates. Each such append is a separate `journal.persist` call made after the trigger was persisted and applied, and host notifications (`retainConclusion` in `maybeCacheConclusion`, `noteWorkload`) run between them. `load()` folds stored observations with `applyAccepted` and never runs `followAccepted`, so a crash after the trigger leaves a durable prefix that restart does not complete and replay would extend beyond the record. Replay invokes neither host nor decision layer and fails on missing required results; recovery separately reconciles unfinished work. `FileJournal` appends JSONL with a bare `appendFileSync` and `JSON.parse`s every nonempty line in `snapshot()`, so a torn final line throws and blocks load. It has no writer lock, fsync, torn-tail repair, checkpoint protocol, or retention policy. Do not infer FabricStore's stronger guarantees apply to it. |
| Cancellation | [runtime.ts](packages/weave/src/runtime.ts): `Runtime.cancel`, `inferAbort`; [state.ts](packages/weave/src/state.ts): `action.cancel_requested` case; [types.ts](packages/weave/src/types.ts): `ActionRecord.cancel_requested`, `ActionState` | `Runtime.cancel(action_id, reason)` asks the host to cancel the invocation, aborts the action-scoped inference `inf:<action_id>`, revokes its grant and records an `action.cancel_requested` (operator or runtime source). The fold sets `cancel_requested` and moves only a `pending` action to `cancelled`; a running action's later result is still recorded. Cancellation of non-action asynchronous work has no recorded state today. |
| Other journals | [store.ts](packages/agentfabric/src/store.ts): `mutate`, `append`, `compact`, `save`; [implement-step.ts](packages/weave/src/implement-step.ts): `FileAttemptJournal`, `MemoryAttemptJournal`, `repairTornTail`; [audit-loop.ts](packages/weave/src/audit-loop.ts): `AuditJournal`, `MemoryAuditJournal` | FabricStore validates, appends before applying, owns a writer lock, repairs torn tails and compacts by size into a snapshot preserving retained state. It is not TTL eviction; append/compaction do not fsync, so do not infer power-loss durability. FileAttemptJournal fsyncs appends, indexes ids, repairs a torn tail and detects some competing writes; its contract still requires one writer. MemoryAuditJournal is in-process; it is not crash durability. These stores have different contracts and must remain distinct. |
| Weft tracing | [weft.ts](packages/weave/src/weft.ts): `LoomWeft.observed`, `loaded`; [runtime.ts](packages/weave/src/runtime.ts): `emitWeft`; [types.ts](packages/weft/src/types.ts): `DisclosureClass`; [validate.ts](packages/weft/src/validate.ts) | `appendStep` and `load` call `emitWeft` for every accepted/loaded observation; `LoomWeft.observed` projects selected payload types and emits content as `{ content_class, digest }` (for example `goal.intent`). The runtime constructs no `LoomWeft` when replaying (`recorded !== null`). GLOSSARY: replay and recovery never read a Weft trace. No memory payload is projected today. |
| Context compression | [compaction.ts](packages/weave/src/compaction.ts): `compactContext`, `ContextSummarizer`, `CompactedContext`; [compaction.test.ts](packages/weave/test/compaction.test.ts) | Pure token-array helper: trigger at 80% capacity, keep last 5%, summary capped at 10%; without a summarizer it returns `summary_needed` and original tokens. It has no persistence, time, cancellation, provenance or memory acceptance contract. No production call site was found at this HEAD. |
| Slice budgets | [views.ts](packages/weave/src/views.ts): `FrameProfile`, `DEFAULT_FRAME_PROFILE`, `NARROW_FRAME_PROFILE`, `renderFrameView`, `sliceAssemblyId`; [types.ts](packages/weave/src/types.ts): `ContextProfileRecord`, `StateView`, `ViewSliceManifest`, `InferenceRequestedPayload`; [audit-view.ts](packages/weave/src/audit-view.ts): `assembleAuditState` | Frame profiles bound catalogue counts (32 or 8), select slices and optionally schema detail; manifests record revisions, omissions and assembly identity. Each runtime `inference.requested` journals its full `StateView`, including `manifest.slices`. Audit assembly bounds individual text/body fields (default body cap 4096 bytes), not total collection retention. Existing profiles are not per-memory-tier quotas, and summary size alone cannot bound aggregate memory. |
| Existing retention and expiry | [log-bound.ts](packages/weave/src/log-bound.ts): `payloadBytes`, `TraceRetention`; [runtime.ts](packages/weave/src/runtime.ts): `appendStep`, `retainTrace`; [state.ts](packages/weave/src/state.ts): `expireApprovals` | `logBound.max_observation_bytes` rejects oversized payloads. TraceRetention evicts oldest attempt metadata and counts omissions, outside the transition lock; it preserves the observation log and can retain one record larger than its byte limit. Approval expiry is an authority rule, not memory expiry. None provides general working/episodic/durable recall eviction. |
| Adjacent caches | [types.ts](packages/gateway/src/types.ts): `PrefixCacheRecord`, `Clock`, `Timer`; [store.ts](packages/agentfabric/src/store.ts): `StoredBuiltinResult`, `rememberResult`, `cachedResult` | Prefix cache prices reuse for one routed unit and view-prefix digest; it is not a cached conclusion. Fabric has builtin result caching. Neither supplies the proposed three memory lifetimes. Model promotion expiry in [nous-portal.ts](packages/gateway/src/adapters/nous-portal.ts) is a separate adapter safeguard, not memory retention. |
| Project, workstream, session | [read-port.ts](packages/loom-binding/src/read-port.ts): `ProjectRecord`, `openReadPort`, `OBSERVATION_WINDOW` (24); [workstream.ts](packages/weave/src/workstream.ts): `Workstream`, `WorkstreamIndex`; [session.ts](packages/tapestry/src/session.ts): `SessionRecord`, `freshSession` | Project availability and workstream ids/references do not grant disclosure. The observation window bounds presentation only. Workstream transitions are pure records; they are not evidence of a durable memory service. Tapestry's session record is ephemeral, and recovery does not restore a session. Do not make memory depend on Tapestry attachment. |
| Benchmark routes using Loom or the gateway | [decision-sites](benchmarks/decision-sites): `providers.ts` `buildProviders`, `competitors.ts` `buildCompetitors`/`createInferenceGateway`, `questions.ts`; [jev](benchmarks/inference/jev): `run.ts` `createJevGateway`; [frontier-weigh](benchmarks/frontier-weigh): `build.ts` (`foldState`, `renderWeighView`, `StateView`), `run.ts` (`createInferenceGateway`); [task-acceptance](benchmarks/task-acceptance): `live.ts` (`createInferenceGateway`, `runLiveComparison`, `taskJevRoute`), `offline.ts` | Each of these builds frames from Loom State/views or sends requests through the gateway, so any change to a shared frame profile or gateway composition would silently change its requests. |
| Repeated review findings | [recurring-findings.ts](packages/weave/src/recurring-findings.ts): `recurrenceKey`, `recordCheckGaps`, `DECLARED_RECURRENCE_POLICY`, `CheckGapRecord`; [RECURRING-FINDINGS-CONTRACT.md](packages/weave/src/RECURRING-FINDINGS-CONTRACT.md) | Repeated findings can produce a check-capability gap with cited executions. The record neither generates nor admits a capability; all later gates remain. This is the existing route for turning repeated memory review findings into checks. |

Relevant existing behavioral evidence inspected: [m4.test.ts](packages/weave/test/m4.test.ts)
M4-T02–T04 cover reuse, stale revisions and explicit cross-goal policy;
[m1.test.ts](packages/weave/test/m1.test.ts) M1-T07–T20 cover conflicts,
cancellation, crash/result boundaries, historical replay (M1-T17, M1-T20) and
recovery limits; [h1.test.ts](packages/weave/test/h1.test.ts) covers
payload/identity bounds and trace retention.
[conclusions.test.ts](packages/agentfabric/test/conclusions.test.ts)
checks suffix reads, torn-tail recovery, a refused second writer and failed
append positions. [store.test.ts](packages/agentfabric/test/store.test.ts) checks
round-trips through compaction, partial append failures and writer ownership;
[host.test.ts](packages/agentfabric/test/host.test.ts) checks single-use invocation
and refused conclusion persistence. [nous.test.ts](benchmarks/decision-sites/test/nous.test.ts),
[competitors.test.ts](benchmarks/decision-sites/test/competitors.test.ts),
[reference.test.ts](benchmarks/inference/jev/test/reference.test.ts),
[harness.test.ts](benchmarks/frontier-weigh/test/harness.test.ts) and
[live.test.ts](benchmarks/task-acceptance/live.test.ts) cover the benchmark
routes. These are test definitions inspected for planning, not claims of fresh
green runs.

## 2. Contract and boundaries

Build bounded recall over existing observations, evidence, resources and slices.
Loom owns deterministic memory transitions and selection. Host-owned persistence
and resource access stay behind narrow ports. Compression and semantic matching
are capabilities or bounded inference whose outputs remain observations.
Fabric remains a bounded subsystem shipped with Weave; it imports no Loom State,
memory policy, clock-tick processing or scheduling. The gateway receives only
explicitly disclosed inputs and inference terms. Its routing policy and request
translation do not acquire storage, memory selection or ambient runtime access.
Pure transition/selection/assembly code performs no I/O or provider calls.

The three proposed **memory tiers** are distinct from GLOSSARY's routed-unit
**Tier** and **execution tier**:

| Memory tier | Content and ownership | Lifetime and recall contract |
| --- | --- | --- |
| Working scratchpad | Revisioned notes, hypotheses and intermediate references for one goal, keyed under that goal's `AuthorityScope`. Thread-level scratch uses the same goal key and records the thread id as provenance only; concurrent threads coordinate by expected-revision comparison. Authoritative goal, approvals, budgets and action state remain in State. | Smallest byte/count cap and shortest finite TTL. Explicit writes survive restart once acknowledged. Opening another goal grants no access. When the goal reaches a terminal status, its scratch is evicted with reason `scope_closed` (§3). Eviction may discard unneeded notes; required current references either block eviction or yield an explicit missing dependency. Bodies are inline up to a policy byte cap (§3). |
| Episodic memory | A compressed, provenance-bound account of a bounded observation range, including decisions, unresolved questions, failures and references to original evidence | Larger but finite cap/TTL. Reuse `compactContext` for token selection where suitable; persist the accepted result, tokenizer/producer revisions and exact coverage. A summary cannot establish an approval, successful check, result or truth absent its cited evidence. Bodies are always host references with a digest. |
| Durable recall | Selected durable knowledge and evidence-backed semantic claims beyond one goal; valid cached conclusions retain their existing exact-reuse contract | Longest finite TTL plus score/size eviction and explicit scope. Semantic recall returns candidate evidence with uncertainty; it cannot return an action success merely because text is similar. Registry/admission records and invocation safety evidence are governed separately. Bodies are always host references with a digest. |

“Episodic session compression” in the issue means an in-harness work history
boundary to be decided by Benjamin. Recommendation: a goal/workstream observation
range, available headlessly; record a Tapestry session id only as optional
provenance. It does not change the existing meaning of Session.

Acceptance: finite aggregate records/bytes and finite TTL in every recall tier;
active expiry on injected ticks even without reads; deterministic score eviction
under pressure; no scope widening; no acknowledged memory lost or duplicated by
restart; no step durable in part (A9); no staged or reused body deleted before
Loom's disposition (A10); no proposal from a cancelled producer accepted (A11);
no evicted body resurrected by host import, before or after segment
retirement. Historical replay performs no inference, host, gateway or body-store
calls, effects or grant issuance: runtime-sourced memory events are regenerated
byte-for-byte from fed observations, never decided anew. Eviction is a recorded
transition, not silent truncation. Admission, memory retention, optimisation
promotion and authority to execute remain separate gates.

## 3. Proposed data shape and versions

Contract sketch only; settle field names in the contract child before code.
Reuse `Observation`'s identity, source, causal links, `Seq`, `payload_version` and
validation envelope; `AuthorityScope`, resource read sets, `CachedConclusion`,
`StateView` and `ViewSliceManifest` keep their existing meanings. Do not add a new
package, database, vector dependency or generic event framework in this parent.

Proposed `memory.record@1` contains:

- `memory_id`, `revision`, `memory_tier` (`working`, `episodic`, `durable`),
  `kind` (`note`, `episode`, `claim`, `conclusion_ref`), project/workstream/goal
  identity where available, optional thread id as provenance, and existing
  `AuthorityScope`. A project or thread id is provenance, never authority.
- Body placement (decided, A7): a working note body is inline only up to
  `memory.policy` `working_inline_max_bytes`, which must not exceed
  `logBound.max_observation_bytes`; without a configured `logBound`, inline
  admission is refused. Episodic and durable bodies are always a host-issued
  body reference plus digest, canonical byte size and, where token budgeting
  applies, token count and tokenizer revision. The host stores the body durably
  before its acknowledgement is fed. Do not put locators or credentials in
  records. A `conclusion_ref` points to an existing `CachedConclusion`; an
  episode must not masquerade as one.
- Evidence references qualified by journal identity plus `Seq`/resource revision,
  read set, producer contract/implementation or inference record, coverage range
  for episodes, input digest and recorded omissions. Bare sequences from another
  journal are ambiguous. Version the evidence-reference extension rather than
  silently changing existing `CachedConclusion.evidence` semantics.
- Creation tick, absolute `expires_at_tick`, policy id and revision, and a
  bounded evidence-quality class assigned by executable rules. Last use tick and
  capped use count are derived from recorded disclosures (below), not stored as
  separate writes. No model-supplied confidence is authority or an unverified
  quality bonus. Record the most restrictive **content class** of any source;
  check permitted disclosure per consumer.
- Source memory ids/revisions for derivation. Revisions are immutable; updates
  supersede a revision explicitly. Contradictions retain evidence and uncertainty
  rather than overwriting a claim with the newest prose.

Proposed `memory.policy@1` declares per-tier TTL ticks, max entry bytes,
`working_inline_max_bytes`, aggregate bytes/count per authorized scope and total
store, recall byte/token/top-k limits, finite sweep work allowance, score
coefficients, mirror placeholder count quota, and journal/body-storage quotas.
All numeric inputs are finite validated safe integers with overflow checks;
missing policy refuses memory admission, never means unlimited. Production values
remain an owner decision; small fixed values suffice for deterministic tests.

### Event provenance and replay rule (decided, A1)

Replay at HEAD feeds non-`CYCLE_APPENDED` observations verbatim and regenerates
`runtime`/`judgment` observations, requiring an exact match. Memory events
follow that rule rather than bending it. Anything produced by I/O, inference or
timing is a **fed** observation; every state-changing memory event is
**runtime-sourced** and emitted synchronously in the same step as its trigger,
as `followAccepted` already does for `goal.missed`. Each is a pure function of
State, the recorded policy revision and the triggering fed observation, so replay
regenerates it byte-for-byte without inference, host, gateway or body I/O.

### Durable step completion (decided, A9)

A trigger and the observations its step generates commit together or not at
all. At HEAD they do not (§1): `appendStep` persists the trigger, applies it, then
`followAccepted` persists each follow-up separately, and `load()` never completes
a missing suffix. Contract (C2, journal-wide):

- The runtime computes the whole step on a staged copy of State: the trigger and
  every observation `appendStep`/`followAccepted` would append for it (memory
  writes, refusals, quota and `ttl` evictions, `scope_closed`, and today's
  `goal.missed`, `conclusion.cached` and `baseline.recorded` follow-ups). This
  is pure and bounded by the policy's sweep allowance, so the frame size is
  validated before admission.
- A proposed `ObservationJournal.persistStep(observations)` writes them as one
  framed record (proposed `journal.step@1`: contiguous seqs, count and digest)
  in a single append, then fsyncs. Snapshot treats a complete frame as all its
  observations and a torn final frame as absent; it repairs that tail only under
  sole-writer ownership and rejects any incomplete interior frame. A bare line
  in an older journal reads as a one-observation frame, so old journals load
  unchanged.
- Only after the frame is durable does the runtime apply the staged State,
  update indices, emit Weft and run host notifications (`retainConclusion`,
  `noteWorkload`). A persistence failure applies nothing and leaves the journal
  as it was; if completion is uncertain, the writer fails closed and accepts no
  further work until reopening resolves the tail.
- The asynchronous cycle that a fed trigger starts (`admitStep` → `runCycle`)
  is outside the frame and keeps its existing recovery contract.

Consequences: a durable `memory.proposed` always carries its outcome in the same
frame, so the C2 operation-id lookup never finds a proposal without an outcome;
`load()` stays a pure fold without `followAccepted`; and replay never meets a
recorded prefix that it would extend. A pending-step record completed on load
was rejected: it would make `load()` run `followAccepted`, which calls the host
today, and would rewrite history at restart.

Proposed payload types (initial `payload_version: 1`):

| Event | Source and replay | Preconditions and transition |
| --- | --- | --- |
| `memory.proposed` | Fed: `operator` for operator notes, `host` for capability products and body-store acknowledgements, `gateway` for compression/matching inference outputs. Replay feeds it verbatim. | Carries an operation id, proposal kind (write, promotion, demotion, enrolment), expected source revisions, body inline or body reference + digest + staging reservation id (§3 bodies), evidence and the producing record (`action.result`, `inference.recorded`). Asynchronous products also name their producing action (A11); operator notes need none. A proposal is evidence, never authority; source kind alone grants nothing. |
| `memory.written` | Runtime, regenerated. Emitted on an accepted write proposal. | Validated body/evidence, scope, expected previous revision and capacity. Inserts one revision and supersedes the named previous revision, if any. A stale expected revision yields a runtime `memory.refused` (below), not a write. |
| `memory.transitioned` | Runtime, regenerated. Emitted on an accepted promotion/demotion proposal. | Names operation id, source revisions, destination record, target scope, policy revision, producing evidence and any source retirement. One durable append makes the destination visible and retires named source projections together. |
| `memory.evicted` | Runtime, regenerated. Emitted on an accepted `clock.tick` (bounded `ttl` batch, `scope_closed`), on a write/transition needing space (`capacity`), on a resource/admission change (`invalidated`), or with a supersession. | Expected current revision, reason (`ttl`, `capacity`, `invalidated`, `superseded`, `scope_closed`), sweep identity and scored inputs. Removes recall eligibility/body projection and records a tombstone. It does not delete authority or recovery evidence. `scope_closed` is emitted when the owning goal reaches `complete`/`missed`, or when `goal.opened` replaces it, excluding records pinned as recovery evidence. |
| `memory.refused` | Runtime, regenerated. | Records a deterministic refusal of a proposal (stale revision, quota with no evictable victim, scope, missing evidence, unknown version, `cancelled`, `operation_closed`, `journal_quota`) with its reason, so the producer's retry is a new proposal rather than a silent loss. A refusal never copies the proposal's body. |

There is no `memory.used` event (decided, A8). A use is a memory revision listed
in the memory slice manifest of an accepted, journaled `inference.requested`
view, which the runtime already records. The fold counts at most one use per
record per request, capped by policy; an attempted lookup, an omitted record or
replay does not add a write. Recall frequency therefore causes no extra journal
appends. This requires a new memory-aware frame profile version whose manifest
names memory ids/revisions (below).

Asynchronous work (compression, matching, scoring proposals, body storage) runs
outside the transition lock and may only produce a fed `memory.proposed`. The
order of fed proposals depends on timing, and the journal records that order;
the runtime's acceptance is the deterministic step. A stale proposal is refused,
and the producer may replan within its finite allowance as a new proposal.

Producing operation and cancellation (decided, A11). An `AbortSignal` asks a
producer to stop; it cannot stop an uncooperative producer from returning a
valid result, and cancelling compression changes neither source revisions nor
scope. Acceptance is therefore bound to recorded cancellation state:

- Every asynchronous producer (compression, matching, SLEEP ingestion, scoring)
  runs as a recorded action: an `action.started` whose `action_id` is the
  producing operation, with its reservation and grant. Cancellation is the
  existing `Runtime.cancel` → `action.cancel_requested`, which already aborts
  `inf:<action_id>` and the host invocation. No new cancellation primitive.
- A proposal names `producing_action_id`. Acceptance, in step order, refuses it
  with `cancelled` if that action's `cancel_requested` is set, and with
  `operation_closed` if the action is unknown, terminal before the proposal, or
  already has an accepted proposal (one accepted proposal per action, like a
  single-use grant). Revision and scope checks still apply after these.
- The refused product is not discarded silently: `memory.refused` cites the
  proposal's seq, and the action's `action.result` keeps its bounded outcome and
  spent cost as evidence. The source stays intact.
- Cancellation after acceptance is too late by step order. It cannot erase the
  transition; undoing it is a new, separately validated proposal.

Extend the existing source/version validation boundary in
[validation.ts](packages/weave/src/validation.ts): `EXPECTED_SOURCE`, `validate`.
Only trusted operator ingress records memory policy/scope changes. Only the
runtime emits `memory.written`, `memory.transitioned`, `memory.evicted` and
`memory.refused`; a fed observation claiming one of these is rejected.
Validate record existence, evidence, current authority and expected revisions
at acceptance, not just the payload's shape.

Identity and idempotency: memory ids and operation ids the runtime generates use
a namespace plus a per-namespace monotone counter (as runtime ids such as
`weights:c<n>` already do). Externally supplied ids (`memory.proposed` operation
ids, conclusion ids) are not monotone; each carries its issuing tick, and the
runtime keeps an explicit retained-id index for them (§4). Today a reused
`observation_id` is only rejected as `duplicate`. Proposed C2 contract: a retried
operation id with the identical proposal digest returns the recorded outcome
(the seq of its `memory.written`/`memory.transitioned`/`memory.refused`), a
changed digest under that id is rejected, and an id issued before the retained
horizon is refused (`beyond_horizon`), never accepted as new.

“Memory promotion” means movement between retention lifetimes; distinguish it
from the existing governed optimisation Promotion. It requires validated
evidence and policy, not an automatic side effect of generating a summary.
Demotion may create a smaller episodic projection of durable material. It does
not extend source TTL, cure staleness or broaden scope. An expired record cannot
be demoted to keep it alive. Revalidation under current authority creates a new
revision with new evidence; old uses cannot renew it indefinitely.

Keep historical observation payloads/profiles readable and unchanged. Memory
selection exists only in a new opt-in profile version (proposed
`profile.frame.memory@1`) with recorded memory revisions, digests, policy,
selection and omissions. `DEFAULT_FRAME_PROFILE` (`profile.frame@1`) and
`NARROW_FRAME_PROFILE` (`profile.frame.narrow@1`) stay byte-identical; do not
retrofit filtering into their replay. Existing conclusion invalidation checks
remain mandatory. A legacy conclusion enters bounded recall only through an
explicit, idempotent enrolment proposal with a recorded policy/tick. Legacy
replay still follows its historical contract. Unknown new versions fail closed.

Replayable conclusion import (decided, A12). A host import is I/O, so under A1
it must be a fed observation. Contract (C5):

- New imports are `conclusion.cached` `payload_version: 2` with source `host`
  and the same id `conclusion:imported:<conclusion_id>`, so the A2 dedup set
  and tombstone rule apply unchanged. `EXPECTED_SOURCE` admits `host` for
  version 2 only; runtime-sourced version 1 stays the form for conclusions the
  runtime caches itself (`maybeCacheConclusion`).
- Why fed rather than the existing runtime-sourced host-read pattern:
  `describeOperation` records `host.describe` output as runtime-sourced
  `capability.described` and, in replay, regenerates it from `recordedContracts`
  only when `replayBySeq.get(nextSeq())` carries the id the cycle itself derived
  (`contract:<operation>:<revision>`). That works because the cycle names what it
  needs from State and each contract revision is described once. An import has
  no such derivation: which conclusions arrive, how many and in what order is
  decided by the host's unbounded, dedup-sensitive retained sequence, so replay
  can only take the recording's word for it. That makes the recording the input,
  which A1 calls a fed observation, and a `host` source lets validation tell a
  host import apart from the runtime's own caching. `capability.described` keeps
  its contract.
- Live, `importRetainedConclusions` keeps appending through `this.append` inside
  `runCycleOnce`, as at HEAD; only source and version change. That path starts
  no cycle: only `admitStep` consults `triggerCycle`, and every `admit` call at
  HEAD passes `true`. No `admit(..., false)` path is proposed. Each import is its
  own one-observation step frame (A9) inside the cycle, which stays outside any
  trigger's frame, so the cycle structure at HEAD is unchanged.
- Replay consumes imports inside the cycle. In `replayMode`,
  `importRetainedConclusions` calls no host accessor; while
  `replayBySeq.get(nextSeq())` is a host-sourced `conclusion.cached` version 2,
  it re-appends that observation verbatim, so validation reproduces its recorded
  status (accepted or rejected). This is the `capability.described` lookup
  without the derived-id match.
- The top-level loop never feeds them. The cycle runs inside `feed()` of its
  trigger, so a top-level feed would arrive after the cycle's records, and
  `appendStep` would log the rejected `duplicate` under a new seq. `replay()`
  gets a second deterministic skip rule beside the `CYCLE_APPENDED` source rule,
  keyed only on recorded fields (source `host`, `conclusion.cached`, version 2;
  no marker field). If the observation's index in `ordered` is below
  `liveLog(runtime).length`, the cycle already reproduced it and `checkPrefix`
  already compared it byte-for-byte, so the loop continues. Otherwise the cycle
  did not consume it, and replay fails at its seq with reason
  `recorded conclusion import not consumed by its cycle`. This mirrors the
  cursor in `nextReplayRequest`, which steps over requests already in
  `emittedIds` and never re-serves them. A recorded import that is consumed out
  of order diverges at its seq.
- Crash and restart: a crash between two imports of one cycle leaves the earlier
  ones durable. `load()` puts their ids in `importedConclusions`, and the
  cursor-0 reread on restart appends only the rest, so no import is duplicated or
  lost. The host may retain more conclusions concurrently. The cycle's
  synchronous `conclusionsSince` read fixes the order the journal records, and
  replay follows that record, not the host.
- Historical recordings containing runtime-sourced version 1
  `conclusion:imported:*` observations are outside exact-replay support: no
  recorded input exists from which to regenerate them. `replay()` checks for
  them before its loop and returns `ok: false` with reason
  `unsupported: runtime-sourced conclusion import` at the first such seq,
  instead of today's generic divergence. `recover()`/`load()` of those journals
  stays supported, because load folds stored observations. Tombstones and
  placeholders prevent resurrection; they are not replay input.

Bodies and replay: a memory-aware view records episodic/durable bodies as
`{ content_class, digest, body_ref }`, never text. The decision-layer composition
(outside Loom and outside gateway routing) resolves a reference through a host
body port and verifies the digest before disclosure; an unavailable or
mismatched body fails that inference with a recorded reason. Replay regenerates
the identical digest-only view and checks it against the recorded
`inference.requested`; it never dereferences a body. Inline working notes are
already in the journal. Body cleanup therefore protects only digests owned by a
staging reservation (below), live records, in-flight requests (requested without
a recorded result) and recovery evidence; replay needs none.

Staging reservations and deletion (decided, A10). A staged body awaiting
acceptance belongs to none of Loom's sets, so the host pins it explicitly:

- The host body port's proposed `stage(producing_action_id, bytes)` writes the
  body and durably records a reservation (reservation id, digest, size and
  producing action id) in the body store's own metadata before returning
  `{ body_ref: reservation_id, digest }`. Each reservation is counted against
  the staged quota from that moment; when the quota is full, stage refuses
  and the producer's action fails with a recorded reason.
- A reservation is released only on an explicit disposition taken from Loom's
  committed journal by the composition root, by id only (Fabric and the body
  store import no Loom State, as in A2). Committed ownership: a `memory.written`
  or `memory.transitioned` naming the `body_ref` turns the reservation into
  ownership by that record revision. Explicit abandonment: the producing action
  is terminal (result, cancellation, or reconciled after restart) with no
  accepted proposal naming the reservation. While the action is pending,
  running or uncertain, the body stays pinned. There is no time-based release,
  because a lease could expire between a valid proposal and its commit.
- Bodies are content-addressed by digest with a per-digest owner set. Acquiring
  an owner (`stage`, ownership handoff) and deleting take the same per-digest
  lock in the body store. Cleanup deletes only after it durably marks the digest
  `deleting` with an empty owner set. A `stage` of a digest marked `deleting`
  waits for the deletion to finish and then writes fresh bytes under its new
  reservation; it never reuses the bytes being deleted. A crash during deletion
  leaves the marker, and restart resumes the deletion idempotently before that
  digest accepts new owners.
- Loom acceptance stays pure: it checks the proposal's digest, size and
  reservation id shape, not host state. The guarantee that the body exists at
  commit comes from the pin, which no cleanup can release before Loom's
  disposition.

## 4. Active TTL, score eviction and storage bounds

Recommendation for an initial, auditable score: after hard eligibility checks,
compute:

```text
keep = q*quality + u*min(uses, use_cap)
     + r*max(0, recency_window - age) - b*ceil(body_bytes / byte_unit)
```

Coefficients and caps are versioned integers supplied by policy; validate the
whole arithmetic range. `uses` and the last use tick are folded from recorded
disclosures (§3). Here age is current tick minus last use tick, or creation tick
when unused; `byte_unit` must be positive. Lower scores leave first; ties use
oldest creation sequence, then memory id and revision. Record score inputs at the
sweep revision. There is no random tie-break, ambient time or hidden model
importance score.

Order each maintenance decision:

1. Recheck current scope, dependencies and TTL. At `tick >= expires_at_tick`,
   recall is ineligible regardless of score/use count. Tick units are explicit;
   no invented conversion to wall-clock days. Reject regressing memory time.
2. On each accepted clock tick, emit a bounded deterministic batch of due
   `ttl` evictions in that tick's step, whether or not a goal is active. The
   sweep position is derived from the fold, so restart and replay resume it.
   A trusted host tick source supplies progress while idle. If ticks stop,
   logical TTL cannot advance; capacity bounds and admission backpressure still
   hold. If elapsed downtime must count, the host supplies an explicit tick
   observation before new recall, never `Date.now()` inside Loom.
3. Before a write or promotion would exceed any quota, evict eligible lowest
   scores within the maintenance allowance in the same step; otherwise emit
   `memory.refused`. Include destination bytes and metadata in peak accounting,
   so promotion cannot temporarily double the allowed store. Never evict the
   source first.
4. Rebuildable indices, mirror bodies, superseded bodies and reserved staged
   bodies have finite budgets and bounded cleanup. Episodic/durable eviction
   reclaims host body bytes through cleanup, not just hiding ids from a view.
5. The working quota bounds live recall only; it does not bound physical bytes
   (decided, A13). Inline working bodies stay in the journal until C6 retires
   their segment, so an empty scratchpad can still hold many retained copies.
   Every retained inline copy counts against the journal/storage quota until
   safe segment retirement: the body in `memory.proposed`, its copy in
   `memory.written`, and superseded, evicted and refused revisions. v1 does not
   deduplicate them, so an accepted inline write costs about twice its body.
   Admission sizes the whole step frame (A9) against the journal quota minus the
   reserved settlement headroom. If the write does not fit but its refusal does,
   the step journals `memory.refused` (`journal_quota`). If even that does not
   fit, the proposal is rejected unjournaled, as rejected observations are at
   HEAD. Results, cancellation and reconciliation still use the headroom.

Keep authoritative journals separate from evictable recall. No TTL may delete a
consumed invocation identity, uncertain effect, held reservation, current read
dependency, pending authority request or evidence required by the supported
replay/recovery horizon. Safety holds do not make a body recallable. Required
bodies count against a bounded protected allowance; when that fills, refuse new
work requiring more space and keep accepting results, cancellation and
reconciliation using reserved journal headroom.

Finite recall alone does not solve unbounded journal disk use. A storage child
must define checkpoint/segment compaction and an explicit replay horizon:
write/verify a versioned checkpoint containing memory revisions, tombstones,
scope/policy, recovery/authority state and a versioned retained-id index
(proposed `checkpoint.retained_ids@1`). That index carries per-namespace
counters for runtime-generated ids; every externally supplied observation and
operation id within the horizon, with its digest and outcome seq; and the full
conclusion dedup set (§5, A2) as an explicit id set, never a high-water mark,
because ids are arbitrary strings and not monotone. Publish it atomically
before retiring redundant segments or bodies. Preserve exact historical replay
inputs/versions for the declared horizon. A checkpoint that supports recovery
alone must not claim full historical replay. Archive storage also has a quota;
exporting history is an explicit authorized operation, not an unbounded second
store. When safe retirement is impossible, backpressure is the bounded outcome.
Forgetting content and destroying replay history are distinct product choices;
neither may silently delete recovery safety state.

## 5. Crash, replay, cancellation and concurrency

Use one serialized writer for consequential memory events, alongside Loom's
existing deterministic observation ordering. Independent capability work can
continue concurrently. Expensive compression, matching and physical cleanup run
outside the transition lock and produce only fed proposals or host-side
deletions (§3). Acceptance, quota-driven eviction and the bounded tick sweep run
synchronously in the step that admitted their trigger and are pure functions of
State, so their order is fixed by the journal, not by timing. A stale proposal is
refused, never overwrites a newer write, and replanning stays within a finite
allowance. H1's rule against trace eviction/slow maintenance under that lock
remains intact: the in-step work is a bounded batch with no I/O beyond the one
step-frame append (A9).

| Boundary or race | Required behavior and behavioral check |
| --- | --- |
| Write vs eviction/use | Both are decided in step order. Test both orders: a new revision is not removed by an old eviction, and an evicted revision is not selected into a later view or counted as used. Already disclosed immutable inputs remain evidence for their recorded action; current-state acceptance checks still apply. |
| Interleaved write and TTL sweep under replay | Record a run where a fed write proposal and `clock.tick`s interleave with sweeps and a quota eviction; `replay()` must return `ok: true` with identical memory events and zero host, gateway, decision-layer or body-port calls. |
| Crash inside a step (A9) | Red first at HEAD with a fault-injecting journal that stops after the n-th `persist`: crash after the trigger (`memory.proposed`, `clock.tick`) and after each generated eviction or write, including a quota eviction followed by a failed destination append, and after an `action.result` before `goal.missed`. Today each leaves a durable prefix that `load()` does not complete. After C2, truncate the journal at every byte offset of the final frame: `load()` yields the whole step or none of it, the operation-id lookup finds the proposal and its outcome together or neither, replay returns `ok: true` with no events beyond the record, and no new work is accepted before the tail is resolved. |
| Crash before promotion commit | Destination is invisible and source remains. Any staged body stays pinned by its reservation until the producing action's disposition releases it (A10). Restart must not rerun compression automatically merely because an acknowledgement is missing. |
| Crash after commit, before acknowledgement or projection update | Fold the one transition and derive destination plus source retirement once. Under the proposed C2 contract, retrying the operation id with an identical digest returns its recorded outcome; changed bytes under that id are rejected; an id from before the horizon is refused. Repeated recovery/replay neither duplicates memory nor renews TTL. |
| Crash between host body write and Loom proposal | The reservation was durable before `stage` returned, so the body is pinned, not an orphan. Restart reconciles the producing action (result or `uncertain`). Once it is terminal with no accepted proposal, that disposition releases the reservation and cleanup reclaims the body. A body written without a durable reservation (crash inside `stage`) is unreferenced and reclaimable. No acknowledgement is issued until the proposal's outcome is journaled. |
| Staging vs orphan cleanup (A10) | Controlled interleaving, red first against a cleanup that protects only live records, in-flight requests and recovery evidence: stage a body, run cleanup before the proposal is fed, then accept the digest-valid proposal. Expected: the body survives and the committed reference resolves. Also cover cleanup between acceptance and the ownership handoff, and a reservation whose action is cancelled (released only after `action.cancel_requested` and its terminal result are journaled). |
| Digest reuse vs deletion (A10) | Controlled interleaving with an injected pause inside cleanup after the `deleting` mark: a new `stage` of the same digest waits, then writes fresh bytes, and its later commit resolves. Order the other way (`stage` takes the lock first): cleanup sees a non-empty owner set and deletes nothing. Crash after the mark: restart finishes the deletion before the digest accepts an owner. Red first against a store that deduplicates by digest without the lock. |
| Journal partial write, ENOSPC, malformed record | No acknowledgement before durable complete append. Repair only a provably incomplete tail under sole-writer ownership; reject malformed complete records/interior corruption. Fail closed if completion is uncertain. Preserve previously committed records. Test new-file durability and checkpoint replacement, not only process-local mocks. |
| Cancellation during compression or matching (A11) | `Runtime.cancel` propagates the signal through capability/gateway ports and journals `action.cancel_requested`. A proposal accepted after that, in step order, is refused (`cancelled`); the source stays intact and the action's bounded outcome/cost stays as evidence. Red check: a fake producer ignores its signal and returns a digest-valid proposal with unchanged source revisions and scope; today's revision/scope checks alone would accept it. Also: a second proposal from the same action is refused (`operation_closed`); cancellation journaled after acceptance cannot erase the transition; replay of both orders reproduces the same outcome. |
| Physical cleanup races | Delete only digests whose owner set is empty: no staging reservation, live record, in-flight request or recovery dependency (replay dereferences none). Cleanup has no power to release effect reservations or grants. An aborted cleanup resumes idempotently from its `deleting` mark and recorded retirement; failed cleanup reports storage pressure. |
| Stopped-clock journal growth (A13) | With no ticks, repeat inline write, supersede and evict until the journal quota is reached while the live scratchpad stays small or empty. Expected: retained bytes counted across proposals, written copies and superseded revisions; further proposals refused (`journal_quota`) or rejected unjournaled; `action.result`, cancellation and recovery still accepted within the reserved headroom. Red first against accounting that charges only the working quota. |
| Replay of `conclusion:imported:*` (A12) | Two separate red checks. New contract: a recording with host-sourced version 2 imports interleaved with cycles replays `ok: true` with zero host accessor reads and the same cycle count; dropping or reordering one recorded import fails at its seq; an import the cycle does not consume fails with `recorded conclusion import not consumed by its cycle`. Exactly once, asserted directly on the replayed log rather than inferred from `ok` or `checkPrefix` divergence: each `conclusion:imported:*` id appears once and no observation is rejected as `duplicate`. Make this red against an implementation that consumes in the cycle but lacks the top-level skip, where it must name the duplicated id. Also cover a crash between two imports of one cycle: restart from cursor 0 yields each id once. Historical contract: a recording with runtime-sourced version 1 imports returns `ok: false` with the explicit `unsupported` reason at the first import, and `recover()` of the same journal still loads. |
| Host mirror import after eviction | Decided design in A2. Tests (C5/C6): evict a conclusion, publish a checkpoint and retire the segments holding its `conclusion.cached`/`conclusion:imported:*` observations, restart, and have the host re-serve from cursor 0. Expect zero new `conclusion.cached` observations, in both restart orders (Fabric host first, Loom first) and with the Fabric retire mutation applied or still pending. |
| Goal closes while threads write | `scope_closed` eviction is emitted in the step that records the terminal status; a later write proposal for that goal is refused (`scope`). Two concurrent threads proposing against revision N: one is accepted, the other refused as stale. |
| Missing evidence or stale semantic index | Fail/return explicit uncertainty; never synthesize approval, validity or action success. Index revision/digest mismatches rebuild from committed authorized records without inference in replay. |
| Restarted inference/effect | Reconcile durable invocation identity under current authority and finite recovery allowance. A grant's serialized fields are evidence, never reissued authority. No automatic retry of an uncertain effect. |

Acknowledged durability requires hardening `FileJournal` before using it as the
memory source of truth: one writer, complete validated record, fsync and explicit
tail/checkpoint failure semantics. This is journal-wide: it changes durability
and latency for every observation, so there is no memory-only fast path. Compose
the proven approaches in FabricStore and FileAttemptJournal without importing
Loom concerns into Fabric or claiming a cross-journal transaction. For host body
writes: durable body and reservation first, then one Loom step frame, then the
ownership handoff (A10). Acknowledgements follow the frame.
Test process termination separately from storage durability; any
body/checkpoint path used must prove file and directory sync semantics rather
than inherit an unverified guarantee from FabricStore. A memory projection/index
can always be rebuilt. Do not make State and a second mutable memory database
competing authorities.

Single-use grants remain single-use in all paths. `createGrantAuthority` in
[grants.ts](packages/agentsop/src/grants.ts) rejects copied/JSON-round-tripped
objects and repeat `markInvoked`; Fabric invocation records preserve identity
across restart. Each genuinely new capability invocation needs a fresh grant
from the composition root within unchanged scope and budget. A new grant does
not authorize replaying a possibly committed invocation. Memory stores no live
grant object, secret, approval substitute or executable authority.

## 6. SLEEP products, semantic recall and isolation

#346 may supply consolidation products: summaries, candidate semantic claims,
source references, producer revisions and bounded uncertainty. Its output
format/availability is unverified here. Agree on a contract fixture first; never
assume a new SLEEP scheduler or embedding service exists. Ingest as fed
`memory.proposed` under a recorded producing action (A11) through the same
validation, provenance, disclosure, budget and retention gates. Reject missing source evidence, conflicting scopes,
secrets, oversized products and unsupported versions. No model can choose its
own TTL, cross-goal policy or admission outcome. Repeated ingestion of the same
product id/digest is idempotent; a changed product is a new revision, not a
second copy.

Initially compose existing resource access and slices with bounded deterministic
candidate selection. If semantic matching requires inference, it receives only
authorized candidates, returns a recorded observation and can abstain. Keep the
index rebuildable and independent of a provider or embedding format. Evaluate
exact reuse and semantic evidence recall separately. Under uncertainty the goal
can request current evidence; a memory miss cannot relax an authority check.

Weft boundary: a Weft trace is never a memory source, and memory is never a Weft
store. If memory events are projected by `LoomWeft`, ids are `reference` fields
and body fields are `content` fields carrying content class and digest only, as
`goal.intent` does today; text appears only under an explicit inline content
policy for that trace. Adding such record kinds is a versioned change to
`packages/weft`'s contract, which still imports nothing from Loom. Canary test:
a memory body containing a unique marker is absent from every Weft record unless
an inline content policy for its content class is configured.

Benchmark routes remain explicit consumers, with no ambient memory injection,
middleware, guardrails, shuffles, tier changes or cross-case persistent recall.
Memory slices exist only in the new opt-in profile version (§3); the existing
frame profiles stay byte-identical. Memory experiments must be separate,
labelled scenarios with frozen initial memory/policy/ticks and disjoint
tune/holdout; do not alter an existing reference route to measure memory
quality. Preserve existing route-specific price, credential and pin checks and
the documented competitor gateway exception in `competitors.ts`.

Every Loom- or gateway-consuming benchmark route at 61a7cff gets an exact
frame/body and request-count assertion while production memory is configured
elsewhere, including cancellation/retry, and proves no recall call, product text
or memory option enters it:

- [decision-sites](benchmarks/decision-sites): `providers.ts` `buildProviders`
  uses `typesafeWireProfile({ shuffle: false })`; direct providers have no
  gateway guardrail/routing middleware. [nous.test.ts](benchmarks/decision-sites/test/nous.test.ts)
  asserts shared state/questions, Bearer-only key, unchanged order and no shuffle
  or guardrail. `competitors.ts` builds its own gateway via
  `createInferenceGateway`; [competitors.test.ts](benchmarks/decision-sites/test/competitors.test.ts)
  is its existing boundary.
- [jev](benchmarks/inference/jev): `run.ts` `createJevGateway` and
  `TYPESAFE_REQUEST_PARAMS`; [reference.test.ts](benchmarks/inference/jev/test/reference.test.ts)
  checks model pin, corpus order and bodies containing only model/questions/state.
- [frontier-weigh](benchmarks/frontier-weigh): `build.ts` folds recorded logs with
  `foldState` and renders `renderWeighView` `StateView`s; `run.ts` builds a
  gateway. [harness.test.ts](benchmarks/frontier-weigh/test/harness.test.ts)
  freezes the case-set digest and records the scripted baseline exactly; add an
  exact rendered-view digest per case.
- [task-acceptance](benchmarks/task-acceptance): `live.ts` builds a gateway on
  `taskJevRoute` for `runLiveComparison`; `offline.ts` scores the frozen set.
  [live.test.ts](benchmarks/task-acceptance/live.test.ts) covers credential
  configuration and skips; add an exact request-body assertion with a fake
  evaluator.

Each new isolation assertion must be demonstrated red before memory code exists:
a test-only leak fixture composes the route with an injected memory slice or
recall call, and the assertion must fail on that fixture and pass on the real
route. An assertion that has never failed is not evidence.

- Private repository/operator data stays private. Before any future hosted
  benchmark disclosure, record provenance/license, exact external destination,
  and sanitize untrusted payloads or obtain explicit authorization. Reserve
  independently authored adversarial/held-out cases before comparative runs.
  This task neither runs a benchmark nor sends benchmark-derived text externally.

Keep keys out of argv, logs, observations, summaries, index text and body stores.
Credentials enter through composition-root configuration, scoped host environment
or adapter headers. Retain screens/redaction in [privacy.ts](packages/gateway/src/privacy.ts),
[implement-step.ts](packages/weave/src/implement-step.ts) and
[credential.ts](packages/weft/src/credential.ts), including parity checks in
[credential-parity.test.mjs](checks/test/credential-parity.test.mjs). Add secret
canaries at ingestion, summary, recall, Weft and failure-report boundaries; do
not solve a leak by weakening privacy or benchmark checks.

## 7. Owner questions and decisions

All product decisions below remain **OPEN for Benjamin**. Recommendations are
planning inputs, not selected defaults or implied captain go.

| Product question | Forks and recommendation | Decision needed before |
| --- | --- | --- |
| P1: What defines an episode? | Tapestry attachment vs goal/workstream observation range. Recommend the latter, with optional session provenance, so headless work and restart have the same memory. | Episodic contract and operator wording |
| P2: Who may recall beyond a goal? | Automatic project sharing vs explicit scope policy vs operator-selected items. Recommend goal-local by default and explicit policy for cross-goal recall; availability alone grants nothing. | Durable recall enablement |
| P3: What TTLs and limits feel useful? | Fixed operator policy vs adaptive model importance. Recommend finite operator-controlled per-tier byte/count/TTL limits, short working and progressively longer episodic/durable horizons, with visible eviction reasons. Select actual values and idle/downtime semantics explicitly. | Production policy configuration |
| P4: What does “forget” promise? | Remove from recall vs erase content including archives. Recommend separate operations with clear retained safety evidence and declared replay horizon. Decide storage quota/backpressure behavior and any export/erase expectations; no promise of full deletion while body-bearing replay segments remain. | Physical retirement and operator controls |
| P5: When should consolidation happen? | Every boundary vs pressure/idle vs explicit request. Recommend bounded pressure/explicit work first; SLEEP products use the same budget. Failed compression preserves source and cannot trigger unlimited retries. | Automatic consolidation |
| P6: How much semantic inference is acceptable? | Deterministic recall only vs bounded matching/synthesis with cost. Recommend deterministic baseline plus explicit budgeted matching, with citations/uncertainty and no silent inference on a miss. | Semantic matching rollout |

Architectural/code-health questions are owner-delegated under D-ENG-021 and are
**DECIDED** here. Each records the evidence that would reopen it; reopening
needs that evidence, not preference.

| Decision | Choice and rationale | Reopen if |
| --- | --- | --- |
| A1: Memory authority and event provenance | DECIDED. Loom's observation fold is the only authority; harden its journal port (C2) rather than add a database or move Loom policy into FabricStore. I/O-, inference- or timing-derived inputs are fed `memory.proposed`; state-changing memory events are runtime-sourced, synchronous and pure (§3), matching `replay()`/`checkPrefix` at HEAD. | A replay test shows a memory event that cannot be regenerated from fed input, or hardened `FileJournal` cannot meet C2's durability checks. |
| A2: Fabric conclusion mirror retirement | DECIDED. (1) Loom's `memory.evicted` tombstone is authoritative. The import dedup set is derived from accepted `conclusion.cached` observations plus tombstoned conclusion ids, and the C6 checkpoint carries it as an explicit id set. (2) Fabric gets a versioned retire mutation through FabricStore `mutate` that replaces the body at the same array index with a digest-only placeholder (`conclusion_id`, digest, retired marker). Cursor positions stay stable and mirror bytes are reclaimed; nothing is spliced. The composition root issues it after Loom commits the tombstone, by conclusion id only, so Fabric imports no Loom state. Placeholders count against a mirror quota. (3) `importRetainedConclusions` skips placeholders and any tombstoned id, whether or not the retire mutation has been applied yet. | The restart-order tests in §5 fail, or the placeholder count quota proves insufficient in C6's growth test. |
| A3: Checkpoint/replay compatibility | DECIDED. Versioned checkpoint with `checkpoint.retained_ids@1` (§4) plus retained historical segments/versions for the chosen horizon; recovery and exact replay have separate acceptance tests. Keep v1 conclusion/profile behavior for old recordings. No speculative general migration framework. | A supported recording cannot be replayed within the declared horizon. |
| A4: Score and maintenance scheduling | DECIDED. Integer score, stable tie-breaks, uses folded from recorded disclosures, bounded in-step batches on accepted ticks; host supplies idle ticks. Capacity admission stays strict during backlog. No ambient clock, probabilistic deletion policy or scheduler inside Fabric/gateway. | Measured in-step sweep cost violates H1's lock budget at the C3 test policy. |
| A5: Semantic indexing substrate | DECIDED. Rebuildable bounded index over authorized references first; add a new primitive/dependency only after composed capabilities demonstrably fail the agreed contract. | The C5 contract fixture fails with composed capabilities. |
| A6: Repeated findings | DECIDED. Encode recurring invariants as regression tests/lint using existing check patterns and `recordCheckGaps` evidence (§9). Keep capability generation, admission and execution separate; no automatic self-admission or audit removal. | — |
| A7: Body placement | DECIDED. Working bodies inline up to a policy cap bounded by `logBound`; episodic/durable bodies always host references with digest; views and replay carry digests only (§3). | A required consumer cannot operate on digest-only replay evidence. |
| A8: Recording memory use | DECIDED. No `memory.used` event; uses are folded from memory slice manifests in journaled `inference.requested` views (§3). | A consumer of memory outside recorded views needs use accounting. |
| A9: Durable step completion | DECIDED. The trigger and every observation its step generates are staged purely, persisted as one `journal.step@1` frame with one append and fsync, then applied; host notifications run after commit (§3). This is journal-wide, covering today's `followAccepted` follow-ups too. Load-time completion of a pending step was rejected (it would make `load()` call the host). | A required follow-up cannot be computed without I/O before commit, or the per-step frame bound cannot be validated at the C3 test policy. |
| A10: Body staging and deletion | DECIDED. Host-owned durable reservations pin staged bodies until Loom's committed disposition (ownership or explicit abandonment), with no time-based release. A per-digest lock and a durable `deleting` mark serialize deletion against new owners (§3). Fabric/body store receive ids only. | The C4/C6 interleaving tests fail, or reservations held by uncertain actions exhaust the staged quota in normal operation. |
| A11: Cancellation binding | DECIDED. Asynchronous producers run as recorded actions; acceptance refuses proposals whose action has `cancel_requested`, is closed, or already has an accepted proposal. This reuses `Runtime.cancel`/`action.cancel_requested` rather than adding a primitive (§3). | A producer that cannot be represented as an action needs memory proposals. |
| A12: Replayable conclusion import | DECIDED. New imports are host-sourced `conclusion.cached@2`. Live, they are appended through `this.append` inside `runCycleOnce` as at HEAD, which starts no cycle. In replay the cycle consumes them by seq, and `replay()`'s top-level loop skips ones already reproduced and fails on unconsumed ones. Fed rather than the runtime-sourced `capability.described` pattern, because the cycle cannot derive which imports to expect. Historical runtime-sourced v1 imports fail replay explicitly as unsupported; recovery of them stays supported (§3). | A supported historical recording must replay exactly (then consume v1 by seq as `describeOperation` does, accepting the recording as input), or version 2 changes cycle structure relative to HEAD. |
| A13: Inline byte accounting | DECIDED. Retained inline copies count against the journal/storage quota until segment retirement; the working quota bounds only live recall. v1 counts duplicates explicitly rather than deduplicating (§4). | C6's growth test shows the ~2× inline cost makes useful working notes infeasible within P3's quotas; then `memory.written` cites the proposal's body by seq and digest instead of copying it. |

Implementation children must add agreed terms to GLOSSARY before using them:
**memory tier**, **working scratchpad**, **episodic memory**, **memory record**,
**memory proposal**, **memory promotion/demotion**, **memory eviction**,
**memory tombstone**, **step frame** (A9) and **staging reservation** (A10). Define TTL in injected ticks and the supported replay
horizon; reuse Durable knowledge, Cached conclusion, Slice, Evidence, Replay,
Recovery, Thread, Content class, Disclosure class and Inline content policy as
already defined. Do not redefine Session, Tier or Promotion. GLOSSARY is
unchanged in this planning task; VISION changes only if an agreed acceptance
boundary changes.

## 8. Proposed child issues / smallest PR increments

Each child establishes its contract and validates test authorship, records a
failing behavioral test or check **before implementation**, then proves green
with deterministic execution. Existing tests alone are not demonstrated red
for a new behavior. Use short fixtures, fake capabilities, injected ticks and
controlled interleavings; never wall-clock sleeps or live hosted models to
prove correctness. No source/tests/schema edits are part of this parent.

| Child / PR | Dependencies | Red evidence required first | Done means |
| --- | --- | --- | --- |
| C1 — Freeze memory contract and language | Captain go; P1/P2 semantics | Contract fixture/check rejects unbounded policy, ambiguous evidence identity, forged scope, a fed observation claiming a runtime-only memory event, an inline body over the cap, an asynchronous product without a producing action, a host-referenced body without a reservation id, a host-sourced `conclusion.cached@1` and unknown version | Agreed records/events with fixed provenance and replay rule, body placement, scope, TTL boundary, score arithmetic, concurrency ordering and replay versions; GLOSSARY terms added; product choices still visibly owned. Contract validation fails unsafe examples and passes valid bounded ones. |
| C2 — Journal-wide durability and idempotent outcomes | C1; A1/A3 | A torn final line currently makes `FileJournal.snapshot()` throw; the A9 crash-inside-a-step checks (§5) show a durable trigger prefix that `load()` never completes, using HEAD's `goal.missed` follow-up before memory code exists; plus crash, failed fsync, competing writer and duplicate-operation checks expose the gaps | `FileJournal` (journal-wide, no memory fast path) commits each step as one `journal.step@1` frame (A9), acknowledges only durable frames, reads old bare-line journals unchanged, repairs only a provably torn final frame under sole ownership, fails closed on interior corruption/contention, and supports the proposed operation-id outcome lookup: retry after checkpoint returns the original outcome, a changed digest is rejected, a pre-horizon id is refused. A reusable crash-injection harness truncates a recorded run at every frame and byte boundary and asserts whole-step load plus `ok: true` replay. Per-append fsync cost is measured on the existing m1/h1 suites and stated in the PR. Single-use grant and existing recovery regressions stay green. |
| C3 — Working scratchpads with active eviction | C1/C2; approved test policy | Tick expiry without reads or an active goal, exact TTL boundary, quota overflow, both write/eviction orderings, `scope_closed` on `complete`/`missed`/replacement, the interleaved write + sweep replay test (§5), and the C2 crash harness at every boundary of a write step whose quota eviction precedes a failed destination append fail | Revisioned working records survive acknowledged restart; finite bytes/count, deterministic TTL/score eviction and bounded in-step sweeps; replay regenerates every memory event with zero host/gateway/body calls; no required authority/recovery state deleted. Admission refuses when space cannot be made. |
| C4 — Episodic compression and atomic movement | C3; P1/P5 | Proposal acceptance followed by crash before/after commit; an uncooperative producer that ignores cancellation and returns a valid proposal with unchanged revisions and scope (A11); a second proposal from one action; staging vs orphan cleanup (A10); stale source; duplicate product; and replay after host bodies are deleted fail | Reuses compaction helper where appropriate; compression runs as a recorded action; persisted source coverage/producer/tokenizer evidence; one transition publishes replacement plus retirement. A cancelled producer's proposal is refused with its outcome/cost kept as evidence; staged bodies stay pinned until disposition. No source loss on failure, duplicate episode or repeated inference on replay; replay passes with bodies deleted. Summary never supplies authority/check success. |
| C5 — Durable recall and conclusion retirement | C3; P2/P6 | Cross-goal leak, stale read set/admission, evicted host reimport in both restart orders (retire mutation applied and pending), cursor shift, the two separate A12 import replay checks (new host-sourced version 2 replays `ok: true` with zero host reads and each import appended exactly once, an unconsumed import failing by name; historical runtime-sourced version 1 fails as `unsupported` while `recover()` still loads), and changed index revision fail | Authorized bounded durable recall plus existing exact reuse validity, A2 tombstone/placeholder handling and both host/Loom restart orders; replayable imports per A12, with wv-n275's replay comparison updated to assert the explicit results instead of preserving divergence; no body resurrection, no implicit action success. Semantic matching, if enabled, abstains within explicit budget. |
| C6 — Bounded physical storage and checkpoint retirement | C2/C3 | Repeated writes/evictions grow disk; the A13 stopped-clock growth test against working-quota-only accounting; digest reuse vs deletion and crash after the `deleting` mark (A10); checkpoint crash, failed cleanup, archive-full, and evict + checkpoint + segment retirement + restart with host re-serving from cursor 0 (expect zero new `conclusion.cached`) fail | Journal/storage quota counts every retained inline copy until segment retirement and refuses admission at the physical bound while keeping settlement headroom; reclaims hot/mirror/released-staged bodies (only through the per-digest protocol) and redundant safe segments under finite quotas; verified checkpoint with retained-id index precedes deletion; declared horizon exactly replays, recovery preserves grants/reservations, beyond-horizon ids and replays fail explicitly. No unbounded tombstone/placeholder/archive escape; backpressure plus settlement headroom demonstrated. Product-facing retention limits wait for P3/P4. |
| C7 — Ingest SLEEP #346 products | C4/C5; actual #346 contract | Duplicate/changed product id, fabricated evidence, private cross-scope text, cancellation of the producing action followed by a late valid product (A11), and oversize output fail | Producer fixture is pinned; validated products enter as fed proposals within scopes/limits. Missing producer evidence refuses ingestion; consolidation products never grant admission or execution. No new SLEEP scheduler in Fabric/gateway. |
| C8 — Integration gates and independently reviewed evaluation | C4/C5/C6; C7 when available | Every route in §6 fails its exact frame/body/count assertion against a deliberate leak fixture; Weft and credential canaries fail against a leaking fixture; restart interleavings fail | Offline route-isolation (all four route families), Weft, privacy, crash/replay and adversarial matrix pass; default/narrow frame profiles byte-identical; repeated review findings have targeted lint/tests. Memory quality, if model-touched, is evaluated through **Gauge**: a governed **criteria set** and a **case set** whose holdout and independently authored adversarial cases are frozen by **governed revision** before any comparison. Quality uncertainty is reported, not converted into authority or a weaker check. |

Tracked follow-up: issue #347 lists a child “Gauge holdout for memory quality if
model-touched”. C8 covers it as written above; if C8 grows too large, split it
into its own child with the same frozen-before-comparison requirement.

C2's durability tests can be prepared independently after C1. C8's isolation
assertions can also be written after C1, but each must first be demonstrated red
against its leak fixture; passing against a route that has no memory code is not
evidence. C4 and C5 can proceed independently after C3; C6 need not wait for
semantic matching. Express these dependencies in child issues; do not serialize
unrelated capability work. No production three-tier rollout before C6 bounds
actual retained storage and C8 proves protected boundaries.

For each implementation PR, run the narrow behavioral tests while iterating,
then the full available suite (`npm run verify` at this HEAD, which includes
`npm run fmt:check`, plus `npm run lint`), including package direction, no
ambient clock/entropy/environment and no swallowed failures. Retain
`checks/import-direction.mjs`, `checks/no-ambient-clock.mjs`,
`checks/no-ambient-entropy.mjs`, `checks/no-ambient-env.mjs` and
`checks/no-swallowed-failures.mjs` unchanged unless a separately justified
strengthening is required. Never add an allowance or weaken permissions,
held-out checks, privacy or route assertions merely to pass.

## 9. Review and completion of this planning task

Review against these failure cases before captain go: repeated writes under a
stopped clock; equal scores; exact TTL boundary; cancelled or oversized summary;
source revision/permission change during compression; crash on either side of
promotion/checkpoint publication; replay of interleaved writes and sweeps;
mirror import after retirement and segment loss; duplicate id with changed
digest; pre-horizon id; corrupt complete journal record; torn final line; crash
after a trigger or any generated event inside one step; staging vs cleanup and
digest reuse vs deletion; a producer that ignores cancellation; inline journal
growth with an empty scratchpad; replay of new and historical conclusion
imports; full protected storage; goal closure with live scratch; and
expired/revoked/copied/consumed grants.

Repeated findings become checks, not reminders. Two findings have now recurred
across reviews of this plan: conclusion-mirror resurrection (earlier review
“Host tombstones do not prevent resurrection”, now the cursor/dedup-set
mechanism) and closed-goal memory lifecycle (earlier “Closed-goal eviction has
no execution owner”, now `scope_closed`). Each is bound to a named red test (C5/C6
mirror restart tests; C3 `scope_closed` test) and, at implementation time, cited
through `recordCheckGaps` evidence so a third recurrence is caught by a check.

The 056c521 review shows two more recurrences, so each gets a general check,
not one more case:

- Conclusion import, a third time (resurrection, then cursor/dedup, now replay).
  C5 adds a replay-closure test: every recording the fake host can produce,
  including imports, replays `ok: true` with zero host accessor reads, or fails
  with a named `unsupported` reason. It runs across the m1/wv-026d/wv-n275
  fixtures, so a new runtime-sourced append that reads the host fails it.
- Crash and partial-write boundaries (plan3 commit/ack rows, now step prefixes).
  C2's crash-injection harness truncates at every frame and byte boundary of
  every recorded fixture run, so a future follow-up type is covered without
  writing a new crash test.

The 61a7cff review raises conclusion import a fourth time, now about how replay
consumes it. The fix (A12's second skip rule) is again backed by a general
invariant, not one more case. C5's replay-closure test also asserts, on every
fixture it replays, that no `observation_id` appears twice in the replayed log
and that no observation is rejected as `duplicate`. Any later fed observation
that is consumed inside a cycle is then covered without writing a new test.

### Review dispositions: GLM review of 61a7cff

| Finding | Verified at 61a7cff | Disposition |
| --- | --- | --- |
| W1: A12 never states the top-level replay skip rule | Correct. `replay()` skips only `CYCLE_APPENDED` sources; host-sourced v2 imports would be fed again after the cycle consumed them. `appendStep` logs a rejected `duplicate` under a new seq, and `checkPrefix` then diverges. | Fixed (§3 A12, §5, §7 A12, §8 C5, §9). There is now an explicit position-based skip keyed on recorded fields, mirroring `nextReplayRequest`'s `emittedIds` cursor, plus a named failure for an unconsumed import. An exactly-once red check asserts directly on the replayed log, and the closure test carries a general no-duplicate invariant. Crash between imports and concurrent host retention are covered. |
| W2: A12 cites a nonexistent `admit(input, triggerCycle=false)` path | Correct. All `Runtime.admit` calls pass `true`: the four constructor `IngressHandle`s (reached through `IngressHandle.submit`, which `cancel` also uses), `observe` and `feed`. `importRetainedConclusions` appends through `this.append` from `runCycleOnce`, and only `admitStep` reads `triggerCycle`. | Fixed (§3 A12, §7 A12). The plan now names the HEAD mechanism and states that no `admit(..., false)` path is proposed. |
| N1: wv-n275 citation names lines 123–136 as the test | Correct as to the test's extent: it is lines 110–137. The review's sub-range (comment 122, comparison 127–136) is off by one or more lines. The comment begins at 123, and the replay comparison including host stubs spans 123–136. | Fixed (§1): test cited as 110–137 and its replay comparison as 123–136. |
| N2: no rationale for fed imports over the `capability.described` pattern | Correct. `describeOperation` regenerates runtime-sourced `capability.described` in replay from `recordedContracts` via `replayBySeq`, gated on an id the cycle derives itself. | Fixed (§3 A12, §7 A12). The plan now gives the rationale (imports cannot be derived from State, are unbounded and dedup-sensitive, and need a truthful source). The A12 reopen path names this pattern as the route if historical v1 replay is ever required. |

Planning verification: confirm all cited files/symbols at 61a7cff,
`git diff --check`, `npm run fmt:check`, and only root `PLAN.md` changed. No
runtime suite or benchmark run is warranted by this documentation-only task.
Commit as `plan: WV-347 plan5 address GLM review of 61a7cff` if Git permits,
and do not push.
