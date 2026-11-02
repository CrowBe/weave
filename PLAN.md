# WV-347 — Three memory tiers with active eviction

Planning parent: https://github.com/CrowBe/weave/issues/347. This document is the
only deliverable on `wv-347-memory-plan`. No implementation is authorized until
captain go. Child issues below are proposed work, not filed issues or approvals.

Inventory baseline: `0281c5ed13ee0b3fbedd50399f9ed19837a58c17` (HEAD before this
plan). All existing file/symbol citations below refer to that commit. Proposed
names and versions are explicitly marked; they do not claim existing APIs.
The issue brief supplies the relationship to SLEEP scout #346 and D-ENG-021;
neither a SLEEP product contract nor D-ENG-021's decision record was found in
tracked repository text. No network lookup or hosted inference was performed.

## 1. Inventory before design

| Area | Exact existing files and symbols | What exists; what remains absent |
| --- | --- | --- |
| State and time | [types.ts](packages/weave/src/types.ts): `State`, `Observation`, `Seq`, `ClockTickPayload`, `ReadSetEntry`, `AuthorityScope`; [state.ts](packages/weave/src/state.ts): `initialState`, `applyAccepted`, `foldState`, `expireApprovals` | Accepted observations deterministically update State. `clock.tick` supplies time and expires approvals. Opening a goal resets selected goal fields, but retains sources, conclusions, policies and other history. There is no generic memory record, scratchpad lifecycle, or memory TTL here. Whole State must not become evictable. |
| Cached conclusions | [types.ts](packages/weave/src/types.ts): `CachedConclusion`, `InvalidationCondition`, `PolicyRecord`; [reuse.ts](packages/weave/src/reuse.ts): `reuseVerdict`, `callerInScope`, `readSetFreshness`; [runtime.ts](packages/weave/src/runtime.ts): `maybeCacheConclusion`, `reuseConclusion`, `importRetainedConclusions` | Records carry operation/contract/implementation, input digest, output, evidence, resource revisions, scope and invalidation conditions. The runtime produces/reuses these for `text.normalize`; reuse checks admission, scope, matching inputs and resource revisions. Missing revision evidence is uncertain. `applyAccepted` appends conclusions; there is no TTL or score eviction. The optional `conclusion` view slice currently lists all State conclusions' ids/evidence. |
| Durable knowledge and mirrors | [store.ts](packages/agentfabric/src/store.ts): `FabricStore`, `FabricSnapshot`, `StoredAdmission`, `StoredWorkload`, `retainConclusion`, `conclusions`; [host.ts](packages/agentfabric/src/host.ts): `AgentFabricHost.retainConclusion`, `conclusionsSince`, `retainedConclusions` | Fabric persists resources, invocation history, admissions, conclusions, workload and cost; the host rebuilds retained conclusion copies. These are useful existing durable knowledge, not a general semantic recall service. Position-based `conclusionsSince(cursor)` is append-only; deleting array entries would break cursors. `FabricLifecycle` in [lifecycle.ts](packages/agentfabric/src/lifecycle.ts) also holds construction/corpus evidence in process; do not claim every lifecycle artifact is durable. |
| Observation journal and replay | [journal.ts](packages/weave/src/journal.ts): `ObservationJournal`, `MemoryJournal`, `FileJournal`, `PersistError`; [runtime.ts](packages/weave/src/runtime.ts): `appendStep`, `load`, `replay`, `recover` | Accepted observations persist before State integration. Replay reconstructs without host/model execution and fails on missing required results; recovery separately reconciles unfinished work. `FileJournal` appends JSONL and parses every nonempty line on snapshot. It has no writer lock, fsync, torn-tail repair, checkpoint protocol, or retention policy. Do not infer FabricStore's stronger guarantees apply to it. |
| Other journals | [store.ts](packages/agentfabric/src/store.ts): `mutate`, `append`, `compact`, `save`; [implement-step.ts](packages/weave/src/implement-step.ts): `FileAttemptJournal`, `MemoryAttemptJournal`, `repairTornTail`; [audit-loop.ts](packages/weave/src/audit-loop.ts): `AuditJournal`, `MemoryAuditJournal` | FabricStore validates, appends before applying, owns a writer lock, repairs torn tails and compacts by size into a snapshot preserving retained state. It is not TTL eviction; append/compaction do not fsync, so do not infer power-loss durability. FileAttemptJournal fsyncs appends, indexes ids, repairs a torn tail and detects some competing writes; its contract still requires one writer. MemoryAuditJournal is in-process; it is not crash durability. These stores have different contracts and must remain distinct. |
| Context compression | [compaction.ts](packages/weave/src/compaction.ts): `compactContext`, `ContextSummarizer`, `CompactedContext`; [compaction.test.ts](packages/weave/test/compaction.test.ts) | Pure token-array helper: trigger at 80% capacity, keep last 5%, summary capped at 10%; without a summarizer it returns `summary_needed` and original tokens. It has no persistence, time, cancellation, provenance or memory acceptance contract. No production call site was found at this HEAD. |
| Slice budgets | [views.ts](packages/weave/src/views.ts): `FrameProfile`, `DEFAULT_FRAME_PROFILE`, `NARROW_FRAME_PROFILE`, `renderFrameView`, `sliceAssemblyId`; [types.ts](packages/weave/src/types.ts): `ContextProfileRecord`, `StateView`, `ViewSliceManifest`; [audit-view.ts](packages/weave/src/audit-view.ts): `assembleAuditState` | Frame profiles bound catalogue counts (32 or 8), select slices and optionally schema detail; manifests record revisions, omissions and assembly identity. Audit assembly bounds individual text/body fields (default body cap 4096 bytes), not total collection retention. Existing profiles are not per-memory-tier quotas, and summary size alone cannot bound aggregate memory. |
| Existing retention and expiry | [log-bound.ts](packages/weave/src/log-bound.ts): `payloadBytes`, `TraceRetention`; [runtime.ts](packages/weave/src/runtime.ts): `appendStep`, `retainTrace`; [state.ts](packages/weave/src/state.ts): `expireApprovals` | `logBound.max_observation_bytes` rejects oversized payloads. TraceRetention evicts oldest attempt metadata and counts omissions, outside the transition lock; it preserves the observation log and can retain one record larger than its byte limit. Approval expiry is an authority rule, not memory expiry. None provides general working/episodic/durable recall eviction. |
| Adjacent caches | [types.ts](packages/gateway/src/types.ts): `PrefixCacheRecord`, `Clock`, `Timer`; [store.ts](packages/agentfabric/src/store.ts): `StoredBuiltinResult`, `rememberResult`, `cachedResult` | Prefix cache prices reuse for one routed unit and view-prefix digest; it is not a cached conclusion. Fabric has builtin result caching. Neither supplies the proposed three memory lifetimes. Model promotion expiry in [nous-portal.ts](packages/gateway/src/adapters/nous-portal.ts) is a separate adapter safeguard, not memory retention. |
| Project, workstream, session | [read-port.ts](packages/loom-binding/src/read-port.ts): `ProjectRecord`, `openReadPort`, `OBSERVATION_WINDOW` (24); [workstream.ts](packages/weave/src/workstream.ts): `Workstream`, `WorkstreamIndex`; [session.ts](packages/tapestry/src/session.ts): `SessionRecord`, `freshSession` | Project availability and workstream ids/references do not grant disclosure. The observation window bounds presentation only. Workstream transitions are pure records; they are not evidence of a durable memory service. Tapestry's session record is ephemeral, and recovery does not restore a session. Do not make memory depend on Tapestry attachment. |
| Repeated review findings | [recurring-findings.ts](packages/weave/src/recurring-findings.ts): `recurrenceKey`, `recordCheckGaps`, `DECLARED_RECURRENCE_POLICY`, `CheckGapRecord`; [RECURRING-FINDINGS-CONTRACT.md](packages/weave/src/RECURRING-FINDINGS-CONTRACT.md) | Repeated findings can produce a check-capability gap with cited executions. The record neither generates nor admits a capability; all later gates remain. This is the existing route for turning repeated memory review findings into checks. |

Relevant existing behavioral evidence inspected: [m4.test.ts](packages/weave/test/m4.test.ts)
M4-T02–T04 cover reuse, stale revisions and explicit cross-goal policy;
[m1.test.ts](packages/weave/test/m1.test.ts) M1-T07–T19 cover conflicts,
cancellation, crash/result boundaries, historical replay and recovery limits;
[h1.test.ts](packages/weave/test/h1.test.ts) covers payload/identity bounds and
trace retention. [conclusions.test.ts](packages/agentfabric/test/conclusions.test.ts)
checks suffix reads, torn-tail recovery, a refused second writer and failed
append positions. [store.test.ts](packages/agentfabric/test/store.test.ts) checks
round-trips through compaction, partial append failures and writer ownership;
[host.test.ts](packages/agentfabric/test/host.test.ts) checks single-use invocation
and refused conclusion persistence. These are test definitions inspected for
planning, not claims of fresh green runs.

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
| Working scratchpad | Revisioned notes, hypotheses and intermediate references for a goal/workstream; authoritative goal, approvals, budgets and action state remain in State | Smallest byte/count cap and shortest finite TTL. Explicit writes survive restart once acknowledged. Opening another goal grants no access. Eviction may discard unneeded notes; required current references either block eviction or yield an explicit missing dependency. |
| Episodic memory | A compressed, provenance-bound account of a bounded observation range, including decisions, unresolved questions, failures and references to original evidence | Larger but finite cap/TTL. Reuse `compactContext` for token selection where suitable; persist the accepted result, tokenizer/producer revisions and exact coverage. A summary cannot establish an approval, successful check, result or truth absent its cited evidence. |
| Durable recall | Selected durable knowledge and evidence-backed semantic claims beyond one goal; valid cached conclusions retain their existing exact-reuse contract | Longest finite TTL plus score/size eviction and explicit scope. Semantic recall returns candidate evidence with uncertainty; it cannot return an action success merely because text is similar. Registry/admission records and invocation safety evidence are governed separately. |

“Episodic session compression” in the issue means an in-harness work history
boundary to be decided by Benjamin. Recommendation: a goal/workstream observation
range, available headlessly; record a Tapestry session id only as optional
provenance. It does not change the existing meaning of Session.

Acceptance: finite aggregate records/bytes and finite TTL in every recall tier;
active expiry on injected ticks even without reads; deterministic score eviction
under pressure; no scope widening; no acknowledged memory lost or duplicated by
restart; no evicted body resurrected by host import; historical replay performs
no inference, effects, maintenance writes or grant issuance. Eviction is a
recorded transition, not silent truncation. Admission, memory retention,
optimisation promotion and authority to execute remain separate gates.

## 3. Proposed data shape and versions

Contract sketch only; settle field names in the contract child before code.
Reuse `Observation`'s identity, source, causal links, `Seq`, `payload_version` and
validation envelope; `AuthorityScope`, resource read sets, `CachedConclusion`,
`StateView` and `ViewSliceManifest` keep their existing meanings. Do not add a new
package, database, vector dependency or generic event framework in this parent.

Proposed `memory.record@1` contains:

- `memory_id`, `revision`, `memory_tier` (`working`, `episodic`, `durable`),
  `kind` (`note`, `episode`, `claim`, `conclusion_ref`), project/workstream/goal
  identity where available, and existing `AuthorityScope`. A project id is
  provenance, never cross-goal authority.
- Body or host-issued body reference with digest, canonical byte size and, where
  token budgeting applies, token count and tokenizer revision. Store the body
  durably before publishing its reference. Do not put locators or credentials in
  records. A `conclusion_ref` points to an existing `CachedConclusion`; an
  episode must not masquerade as one.
- Evidence references qualified by journal identity plus `Seq`/resource revision,
  read set, producer contract/implementation or inference record, coverage range
  for episodes, input digest and recorded omissions. Bare sequences from another
  journal are ambiguous. Version the evidence-reference extension rather than
  silently changing existing `CachedConclusion.evidence` semantics.
- Creation tick, last accepted use tick, absolute `expires_at_tick`, policy id
  and revision, capped accepted-use count, and a bounded evidence-quality class
  assigned by executable rules. No model-supplied confidence is authority or an
  unverified quality bonus. Sensitivity and permitted disclosure are checked for
  every consumer; retain the most restrictive source classification.
- Source memory ids/revisions for derivation. Revisions are immutable; updates
  supersede a revision explicitly. Contradictions retain evidence and uncertainty
  rather than overwriting a claim with the newest prose.

Proposed `memory.policy@1` declares per-tier TTL ticks, max entry bytes, aggregate
bytes/count per authorized scope and total store, recall byte/token/top-k limits,
finite sweep work allowance, score coefficients, and journal/body-storage quotas.
All numeric inputs are finite validated safe integers with overflow checks;
missing policy refuses memory admission, never means unlimited. Production values
remain an owner decision; small fixed values suffice for deterministic tests.

Proposed payload types (initial `payload_version: 1`):

| Event | Preconditions and transition |
| --- | --- |
| `memory.written` | Validated body/evidence, scope, expected previous revision and capacity. Inserts one revision and supersedes the named previous revision, if any. |
| `memory.used` | Accepted recall actually selected a current authorized revision. Charges once and updates capped use metadata; an attempted lookup or replay does not count. |
| `memory.transitioned` | A promotion or demotion names operation id, source revisions, destination record, target scope, policy revision, producing evidence and any source retirement. One durable append makes the destination visible and retires named source projections together. |
| `memory.evicted` | Expected current revision, reason (`ttl`, `capacity`, `invalidated`, `superseded`), sweep identity and scored inputs. Removes recall eligibility/body projection and records a tombstone. It does not delete authority or recovery evidence. |

Extend the existing source/version validation boundary in
[validation.ts](packages/weave/src/validation.ts): `EXPECTED_SOURCE`, `validate`.
Only trusted operator ingress records memory policy/scope changes. Runtime
integration records validated memory events; host/capability/model output alone
cannot claim that provenance. Validate record existence, evidence, current
authority and expected revisions at admission, not just the payload's shape.

“Memory promotion” means movement between retention lifetimes; distinguish it
from the existing governed optimisation Promotion. It requires validated
evidence and policy, not an automatic side effect of generating a summary.
Demotion may create a smaller episodic projection of durable material. It does
not extend source TTL, cure staleness or broaden scope. An expired record cannot
be demoted to keep it alive. Revalidation under current authority creates a new
revision with new evidence; old uses cannot renew it indefinitely.

Keep historical observation payloads/profiles readable and unchanged. New memory
selection needs a new profile/version with recorded memory revisions, policy,
selection and omissions; do not retrofit filtering into historical `profile.frame@1`
replay. Existing conclusion invalidation checks remain mandatory. A legacy
conclusion enters bounded recall only through an explicit, idempotent enrolment
event with a recorded policy/tick. Legacy replay still follows its historical
contract. Unknown new versions fail closed.

## 4. Active TTL, score eviction and storage bounds

Recommendation for an initial, auditable score: after hard eligibility checks,
compute:

```text
keep = q*quality + u*min(accepted_uses, use_cap)
     + r*max(0, recency_window - age) - b*ceil(body_bytes / byte_unit)
```

Coefficients and caps are versioned integers supplied by policy; validate the
whole arithmetic range. Here age is current tick minus last accepted use tick,
or creation tick when unused; `byte_unit` must be positive. Lower scores leave first; ties use oldest creation
sequence, then memory id and revision. Record score inputs at the sweep revision.
There is no random tie-break, ambient time or hidden model importance score.

Order each maintenance decision:

1. Recheck current scope, dependencies and TTL. At `tick >= expires_at_tick`,
   recall is ineligible regardless of score/use count. Tick units are explicit;
   no invented conversion to wall-clock days. Reject regressing memory time.
2. On each admitted clock tick, process a bounded deterministic batch of due
   expirations. Persist sweep position/high-water mark so restart resumes it.
   A trusted host tick source supplies progress while idle. If ticks stop,
   logical TTL cannot advance; capacity bounds and admission backpressure still
   hold. If elapsed downtime must count, the host supplies an explicit tick
   observation before new recall, never `Date.now()` inside Loom.
3. Before a write or promotion would exceed any quota, evict eligible lowest
   scores within the maintenance allowance; otherwise refuse/defer the write.
   Include destination bytes and metadata in peak accounting, so promotion
   cannot temporarily double the allowed store. Never evict the source first.
4. Rebuildable indices, mirror bodies, superseded bodies and unreferenced staged
   bodies have finite budgets and bounded cleanup. Eviction of the recall set
   must reclaim actual hot bytes, not just hide ids from a view.

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
deduplication high-water marks, scope/policy and recovery/authority state; publish
it atomically before retiring redundant segments or bodies. Preserve exact
historical replay inputs/versions for the declared horizon. A checkpoint that
supports recovery alone must not claim full historical replay. Archive storage
also has a quota; exporting history is an explicit authorized operation, not an
unbounded second store. When safe retirement is impossible, backpressure is the
bounded outcome. Forgetting content and destroying replay history are distinct
product choices; neither may silently delete recovery safety state.

## 5. Crash, replay, cancellation and concurrency

Use one serialized writer for consequential memory events, alongside Loom's
existing deterministic observation ordering. Independent capability work can
continue concurrently. Plan expensive compression, scoring and physical cleanup
outside the transition lock; compare expected revisions again at append. Failed
comparison retries planning within a finite allowance, never overwrites a newer
write. State integration of an accepted eviction remains serialized; H1's rule
against trace eviction/slow maintenance under that lock remains intact.

| Boundary or race | Required behavior and behavioral check |
| --- | --- |
| Write vs eviction/use | Stage both from revision N; whichever append wins makes the other stale. Test both orders: a new revision is not removed by an old eviction, and an evicted revision is not recalled or counted as used. Already disclosed immutable inputs remain evidence for their recorded action; current-state acceptance checks still apply. |
| Crash before promotion commit | Destination is invisible and source remains. Any staged body is bounded orphan storage. Restart must not rerun compression automatically merely because an acknowledgement is missing. |
| Crash after commit, before acknowledgement or projection update | Fold the one transition and derive destination plus source retirement once. Retry the operation id with identical digest returns its recorded outcome; changed bytes under that id are rejected. Repeated recovery/replay neither duplicates memory nor renews TTL. |
| Journal partial write, ENOSPC, malformed record | No acknowledgement before durable complete append. Repair only a provably incomplete tail under sole-writer ownership; reject malformed complete records/interior corruption. Fail closed if completion is uncertain. Preserve previously committed records. Test new-file durability and checkpoint replacement, not only process-local mocks. |
| Cancellation during compression or matching | Propagate the signal through capability/gateway ports. Before commit, leave source intact and accept no proposed replacement; record bounded outcome/cost. After commit, cancellation cannot erase the accepted transition. Late output is evidence subject to current revision/scope checks. |
| Physical cleanup races | Delete only retired body digests unreferenced by live records, in-flight disclosed inputs and replay/recovery dependencies. Cleanup has no power to release effect reservations or grants. An aborted cleanup resumes idempotently from recorded retirement; failed cleanup reports storage pressure. |
| Host mirror import after eviction | An evicted conclusion must not reappear from `conclusionsSince` or after host restart. Do not splice append-only cursor arrays. Use a durable retirement fact and monotonically ordered deltas/high-water marks, or remove the mirror from the recall path; decide in architecture review. Test import before/after retirement, two restart orders and compaction. |
| Missing evidence or stale semantic index | Fail/return explicit uncertainty; never synthesize approval, validity or action success. Index revision/digest mismatches rebuild from committed authorized records without inference in replay. |
| Restarted inference/effect | Reconcile durable invocation identity under current authority and finite recovery allowance. A grant's serialized fields are evidence, never reissued authority. No automatic retry of an uncertain effect. |

Acknowledged durability requires hardening `FileJournal` before using it as the
memory source of truth: one writer, complete validated record, fsync and explicit
tail/checkpoint failure semantics. Compose the proven approaches in FabricStore
and FileAttemptJournal without importing Loom concerns into Fabric or claiming
a cross-journal transaction. For host body writes, durable body first then one
Loom commit; acknowledgements follow both. Test process termination separately
from storage durability; any body/checkpoint path used must prove file and
directory sync semantics rather than inherit an unverified guarantee from
FabricStore. A memory projection/index can always
be rebuilt. Do not make State and a second mutable memory database competing
authorities.

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
assume a new SLEEP scheduler or embedding service exists. Ingest through the
same validation, provenance, disclosure, budget and retention gates. Reject
missing source evidence, conflicting scopes, secrets, oversized products and
unsupported versions. No model can choose its own TTL, cross-goal policy or
admission outcome. Repeated ingestion of the same product id/digest is idempotent;
a changed product is a new revision, not a second copy.

Initially compose existing resource access and slices with bounded deterministic
candidate selection. If semantic matching requires inference, it receives only
authorized candidates, returns a recorded observation and can abstain. Keep the
index rebuildable and independent of a provider or embedding format. Evaluate
exact reuse and semantic evidence recall separately. Under uncertainty the goal
can request current evidence; a memory miss cannot relax an authority check.

Benchmark routes remain explicit consumers, with no ambient memory injection,
middleware, guardrails, shuffles, tier changes or cross-case persistent recall.
Memory experiments must be separate, labelled scenarios with frozen initial
memory/policy/ticks and disjoint tune/holdout; do not alter an existing reference
route to measure memory quality. Preserve existing route-specific price,
credential and pin checks and any documented competitor gateway exception.

Existing boundaries to retain and extend with red tests:

- [providers.ts](benchmarks/decision-sites/providers.ts): `buildProviders` uses
  `typesafeWireProfile({ shuffle: false })`; direct providers have no gateway
  guardrail/routing middleware. [nous.test.ts](benchmarks/decision-sites/test/nous.test.ts)
  asserts shared state/questions, Bearer-only key, unchanged order and no shuffle
  or guardrail.
- [run.ts](benchmarks/inference/jev/run.ts): `createJevGateway` and
  `TYPESAFE_REQUEST_PARAMS`; [reference.test.ts](benchmarks/inference/jev/test/reference.test.ts)
  checks model pin, corpus order and bodies containing only model/questions/state.
  Add exact-body/request-count assertions while production memory is configured
  elsewhere, including cancellation/retry. Prove no additional recall calls,
  product text or memory options enter these routes.
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
canaries at ingestion, summary, recall and failure-report boundaries; do not
solve a leak by weakening privacy or benchmark checks.

## 7. Owner questions and recommended forks

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

Architectural/code-health questions are separate. Under D-ENG-021, these **may
be decided by a later Opus session**; record its decision and evidence without
closing Benjamin's product forks. These recommendations require review:

| Architectural question | Recommendation and rationale |
| --- | --- |
| A1: Where is authority for memory state? | Loom observation fold; harden its existing journal port rather than add a second authoritative database. Keep body I/O in the host. Prove crash durability first; do not move Loom policy into FabricStore. |
| A2: How to retire existing Fabric conclusion mirrors? | Prefer one recall authority and an explicit retirement/delta contract if durable mirrors remain. Preserve append-only cursor semantics until a versioned replacement proves both restart orders; never rely on array deletion or log-local ids across journals. |
| A3: Checkpoint/replay compatibility? | Versioned checkpoint plus retained historical segments/versions for the chosen horizon; recovery and exact replay have separate acceptance tests. Keep v1 conclusion/profile behavior for old recordings. No speculative general migration framework. |
| A4: Score and maintenance scheduling? | Integer score, stable tie-breaks, recorded ticks/revisions and bounded batches; host supplies idle ticks. Capacity admission stays strict during backlog. No ambient clock, probabilistic deletion policy or scheduler inside Fabric/gateway. |
| A5: Semantic indexing substrate? | Rebuildable bounded index over authorized references first; add a new primitive/dependency only after composed capabilities demonstrably fail the agreed contract. |
| A6: Repeated findings? | Encode recurring invariants as regression tests/lint using existing check patterns and `recordCheckGaps` evidence. Keep capability generation, admission and execution separate; no automatic self-admission or audit removal. |

Implementation children must add agreed terms to GLOSSARY before using them:
**memory tier**, **working scratchpad**, **episodic memory**, **memory record**,
**memory promotion/demotion**, **memory eviction**, and **memory tombstone**.
Define TTL in injected ticks and the supported replay horizon; reuse Durable
knowledge, Cached conclusion, Slice, Evidence, Replay and Recovery as already
defined. Do not redefine Session, Tier or Promotion. GLOSSARY is unchanged in
this planning task; VISION changes only if an agreed acceptance boundary changes.

## 8. Proposed child issues / smallest PR increments

Each child establishes its contract and validates test authorship, records a
failing behavioral test or check **before implementation**, then proves green
with deterministic execution. Existing tests alone are not demonstrated red
for a new behavior. Use short fixtures, fake capabilities, injected ticks and
controlled interleavings; never wall-clock sleeps or live hosted models to
prove correctness. No source/tests/schema edits are part of this parent.

| Child / PR | Dependencies | Red evidence required first | Done means |
| --- | --- | --- | --- |
| C1 — Freeze memory contract and language | Captain go; P1/P2 semantics; architectural review | Contract fixture/check rejects unbounded policy, ambiguous evidence identity, forged scope and unknown version | Agreed records/events, scope, TTL boundary, score arithmetic, concurrency ordering and replay versions; GLOSSARY terms added; product choices still visibly owned. Contract validation fails unsafe examples and passes valid bounded ones. |
| C2 — Prove journal durability needed by memory | C1; A1/A3 | Crash/torn-tail, duplicate operation, failed fsync and competing writer checks expose FileJournal gaps | Existing journal path acknowledges only durable appends, preserves earlier committed records, fails closed on corruption/contention, and supports idempotent operation results. Restart before/after append reconstructs one outcome. Single-use grant and existing recovery regressions stay green. |
| C3 — Working scratchpads with active eviction | C1/C2; approved test policy | Tick expiry without reads, exact TTL boundary, quota overflow and both write/eviction orderings fail | Revisioned working records survive acknowledged restart; finite bytes/count, deterministic TTL/score eviction and bounded sweep continuation; no required authority/recovery state deleted. Admission refuses when space cannot be made. |
| C4 — Episodic compression and atomic movement | C3; P1/P5 | Summary acceptance followed by crash before/after commit, cancellation, stale source and duplicate product fail | Reuses compaction helper where appropriate; persisted source coverage/producer/tokenizer evidence; one transition publishes replacement plus retirement. No source loss on failure, duplicate episode or repeated inference on replay. Summary never supplies authority/check success. |
| C5 — Durable recall and conclusion retirement | C3; P2/P6; A2/A5 | Cross-goal leak, stale read set/admission, evicted host reimport, cursor shift and changed index revision fail | Authorized bounded durable recall plus existing exact reuse validity, tombstone/delta handling and both host/Loom restart orders; no body resurrection, no implicit action success. Semantic matching, if enabled, abstains within explicit budget. |
| C6 — Bounded physical storage and checkpoint retirement | C2/C3; A3; P3/P4 | Repeated writes/evictions grow disk; checkpoint crash, failed cleanup and archive-full checks fail | Reclaims hot/mirror/orphan bodies and redundant safe segments under finite quotas; verified checkpoint publication precedes deletion; declared horizon exactly replays, recovery preserves grants/reservations, beyond-horizon failure explicit. No unbounded tombstone/archive escape; backpressure plus settlement headroom demonstrated. |
| C7 — Ingest SLEEP #346 products | C4/C5; actual #346 contract | Duplicate/changed product id, fabricated evidence, private cross-scope text, cancellation and oversize output fail | Producer fixture is pinned; validated products enter existing memory transitions within scopes/limits. Missing producer evidence refuses ingestion; consolidation products never grant admission or execution. No new SLEEP scheduler in Fabric/gateway. |
| C8 — Integration gates and independently reviewed evaluation | C4/C5/C6; C7 when available | Configured production memory leaks into reference request body/count/order; credential canary and restart interleavings fail | Offline route-isolation, privacy, crash/replay and adversarial matrix pass; repeated review findings have targeted lint/tests. Frozen independent holdout reserved before any quality comparison. Quality uncertainty is reported, not converted into authority or a weaker check. |

C2's durability tests and C8's benchmark-boundary tests can be prepared
independently after C1; C4 and C5 can proceed independently after C3; C6 need
not wait for semantic matching. Express these dependencies in child issues;
do not serialize unrelated capability work. No production three-tier rollout
before C6 bounds actual retained storage and C8 proves protected boundaries.

For each implementation PR, run the narrow behavioral tests while iterating,
then the full available suite (`npm run verify` at this HEAD), including package
direction, no ambient clock/entropy/environment and no swallowed failures.
Retain `checks/import-direction.mjs`, `checks/no-ambient-clock.mjs`,
`checks/no-ambient-entropy.mjs`, `checks/no-ambient-env.mjs` and
`checks/no-swallowed-failures.mjs` unchanged unless a separately justified
strengthening is required. Never add an allowance or weaken permissions,
held-out checks, privacy or route assertions merely to pass.

## 9. Review and completion of this planning task

Review against these failure cases before captain go: repeated writes under a
stopped clock; equal scores; exact TTL boundary; cancelled or oversized summary;
source revision/permission change during compression; crash on either side of
promotion/checkpoint publication; mirror import after retirement; duplicate id
with changed digest; corrupt complete journal record; full protected storage;
and expired/revoked/copied/consumed grants. A repeated review finding becomes a
lint rule or behavioral regression test, with evidence, rather than another
instruction to remember.

Planning verification: confirm all cited files/symbols at the inventory commit,
`git diff --check`, and only root `PLAN.md` changed. `node_modules` was absent
when inspected, so the requested conditional `npm run fmt:check -- PLAN.md` is
not available; do not install dependencies or access the network. No runtime
suite or benchmark run is warranted by this documentation-only task. Commit as
`plan: 3-tier memory + eviction (#347)` if Git permits, and do not push.
