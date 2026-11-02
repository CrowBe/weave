# WV-352: durable asynchronous approval and resumption

Planning only, on `wv-352-durable-hitl-plan`. No implementation is authorized
until captain go. This document is the only tracked change. Review target:
`dabe4f3`. `gh issue view 352 --repo CrowBe/weave` (requesting body and comments)
failed with `error connecting to api.github.com`. **Explicit assumption:** the
acceptance items supplied in the review brief accurately represent
[#352](https://github.com/CrowBe/weave/issues/352); the live body and comments
remain unverified. Reconcile this mapping with the issue before C1 acceptance.

Inventory baseline: `e4dc5e16bf8d1ad25d18c9d7041066a9fa982883`.
Existing symbols below were inspected at that commit. Names explicitly marked
**proposed** describe future contracts, not capabilities present at HEAD.

## Outcome and boundaries

Loom can bind a high-stakes action, durably record an approval request, release
execution capacity, wait hours or days, accept an authenticated decision by an
entitled principal through an external channel, and continue under current
authority. Restart does not lose a pending request or a durably accepted
decision. Replay reconstructs evidence without execution; recovery may reconcile
and continue only after the ordinary gates. Approval, recovery and resumption
renew no budget, grant or approval.

Start with a channel-agnostic contract and the existing `report.publish`
vertical path. Generalize the binding representation to a typed action;
do not build a universal workflow engine, a durable recursive-thread scheduler,
or provider-specific continuation machinery. Slack is a possible first edge
adapter, subject to Benjamin's product decision. No acceptance boundary in
`VISION.md` needs to change for this plan.

## Inventory at HEAD

| Concern                               | Exact files and symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Existing behavior and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval records                      | [types.ts](packages/weave/src/types.ts): `ApprovalRequestedPayload`, `ApprovalDecidedPayload`, `ApprovalRecord`, `ApprovalDecisionKind`, `ObservationInput`                                                                                                                                                                                                                                                                                                                                                                                                      | Observation envelopes have `payload_type` and `payload_version`; the runtime writes approval payload version 1. Requests bind publication-specific digests, destination, expected revision, resource read set, effects, reservation and validity ticks. Decisions carry a claimed principal as a bare string (there is no code type named `Principal`) and authority revision. There is no channel identity proof or durable resume ownership.                                                                                                                                                          |
| Request formation and decisions       | [runtime.ts](packages/weave/src/runtime.ts): `Runtime.requestApprovals`, `Runtime.decide`, `Runtime.stillAuthorized`, `Runtime.issueGrant`                                                                                                                                                                                                                                                                                                                                                                                                                       | Requests are currently specific to `report.publish`, use `apr:${candidate_id}`, and expire at current tick + 10. An existing request prevents another request with that id. `decide` uses the operator ingress; it is not a remote authentication service. Grants are issued at dispatch.                                                                                                                                                                                                                                                                                                               |
| Approval policy                       | [candidates.ts](packages/weave/src/candidates.ts): `publishEligibility`, `bindingDigest`, `matchingApproval`, `approvalStillValid`                                                                                                                                                                                                                                                                                                                                                                                                                               | Digest covers inputs and effects. Standing destination write authority or a matching approved request permits publication. `approvalStillValid` checks status and upper validity tick, not an external entitlement service or a current principal authority revision. A separate maximum delegable approval scope is not represented here.                                                                                                                                                                                                                                                              |
| Validation and folding                | [validation.ts](packages/weave/src/validation.ts): `EXPECTED_SOURCE`, `validate`, `validateApprovalRequest`, `validateApprovalDecision`; [state.ts](packages/weave/src/state.ts): `applyAccepted`, `expireApprovals`, `readSetMatches`                                                                                                                                                                                                                                                                                                                           | Validation checks privileged provenance kinds, request existence/status and basic decision fields; it does not authenticate a webhook or establish principal entitlement. Request validation checks only part of the declared shape. Decision scope can replace the expiry tick without enforcing narrowing. V1 ticks implicitly expire pending/approved requests only when `tick > valid_until_tick`; validity includes equality. V1 revoked/expired decisions can overwrite approved status. Folding retains evidence sequences. These are gaps to close, not patterns to copy into the new contract. |
| Trusted ingress                       | [runtime.ts](packages/weave/src/runtime.ts): `IngressHandle`, `Runtime.observe`, `Runtime.operator`, `Runtime.clock`, `Runtime.appendStep`, `Runtime.admitStep`                                                                                                                                                                                                                                                                                                                                                                                                  | Untrusted observations cannot claim privileged provenance. Accepted observations persist before state application and cycle triggering. Handles are in-process bootstrap authority; strings naming an operator are not credentials. Only accepted observations go to `ObservationJournal`, so rejected-input diagnostics are not a durable security inbox.                                                                                                                                                                                                                                              |
| `ask_user` and intake                 | [sites/index.ts](packages/weave/src/sites/index.ts): `SITE_POLICY`, `IntakeState`, `SiteObservation`, `transitionSite`, `evaluateSite`; [sites/CONTRACT.md](packages/weave/src/sites/CONTRACT.md)                                                                                                                                                                                                                                                                                                                                                                | `intake.classify` proposes `new_thread`, `continue_thread`, `queue`, `steer`, `interrupt`, `stop`. Low confidence returns `ask_user` / `needs_human` in `decision-site@1`; it creates neither approval authority nor a durable human wait. A classification answer cannot approve an action.                                                                                                                                                                                                                                                                                                            |
| Input routing                         | [input-route.ts](packages/weave/src/input-route.ts): `decideRoute`, `applyRoute`; [workstream.ts](packages/weave/src/workstream.ts): `Workstream`, `WorkstreamEvent`, `WORKSTREAM_SCHEMA`                                                                                                                                                                                                                                                                                                                                                                        | Input routing and pure `workstream@1` transitions exist independently of intake classification. External approval commands must use a typed ingress path, not natural-language classification or inferred operator intent.                                                                                                                                                                                                                                                                                                                                                                              |
| Waiting actions and wait observations | [types.ts](packages/weave/src/types.ts): `ActionState`, `CycleOutcome`, `PAYLOAD_TYPES`; [runtime.ts](packages/weave/src/runtime.ts): `Runtime.runCycle`, `Runtime.drainQueue`                                                                                                                                                                                                                                                                                                                                                                                   | `ActionState` has pending/running/terminal/uncertain states, with no suspended human-wait action. Cycle `waiting` describes in-flight work; publication awaiting approval is a blocked outcome. `PAYLOAD_TYPES` contains `action.queued` as well as `clock.tick`, approval and cancellation observations. `action.queued` folds the existing start-shaped payload to pending with its grant and reservation; no generic durable `wait.*` observation exists. A returned `waiting` outcome is not itself a durable wait record.                                                                          |
| Operating process                     | [operating-process.ts](packages/weave/src/operating-process.ts): `PROCESS_SCHEMA`, `OperatingProcess`, `WaitReason`, `ResumePoint`, `transitionProcess`                                                                                                                                                                                                                                                                                                                                                                                                          | Pure `operating.process@1` transitions support `waiting` on approval/capability/dependency, `woke`, and pause/resume by opaque ref plus digest. They do not journal a bound request, authenticate a decision, issue authority, or wire recovery to publication. Reuse these semantics where a workstream is attached; do not equate waiting with paused.                                                                                                                                                                                                                                                |
| Observation durability and recovery   | [journal.ts](packages/weave/src/journal.ts): `ObservationJournal`, `MemoryJournal`, `FileJournal`, `PersistError`; [runtime.ts](packages/weave/src/runtime.ts): `Runtime.load`, `Runtime.reconcile`, `replay`, `recover`                                                                                                                                                                                                                                                                                                                                         | `FileJournal` appends JSONL and parses lines. It lacks fsync, torn-tail repair and exclusive-writer fencing. `load` checks increasing seqs and folds accepted records; it trusts stored validation. `recover` loads then reconciles actions; it does not independently wake every approved wait. Do not claim arbitrary crash durability, tamper protection, or two-resumer exclusion from these APIs.                                                                                                                                                                                                  |
| Other durable records                 | [implement-step.ts](packages/weave/src/implement-step.ts): `FileAttemptJournal`, `MemoryAttemptJournal`, `AttemptJournal`, `repairTornTail`; [audit-loop.ts](packages/weave/src/audit-loop.ts): `AuditJournal`, `MemoryAuditJournal`, `AuditCheckpoint`                                                                                                                                                                                                                                                                                                          | Attempt journals use `impl.attempt@1` / `impl.stop@1`, sync appends and new directory entries, repair tails, deduplicate ids and detect some foreign writes. Their own contract requires one writer; detection is not a lock. Audit checkpoints are a different contract. Reuse proven mechanics/tests where appropriate, not these domain records as human waits.                                                                                                                                                                                                                                      |
| Effect locks and host durability      | [scheduler.ts](packages/weave/src/scheduler.ts): `select`, `rejectReason`; [coordinator.ts](packages/agentfabric/src/coordinator.ts): `ResourceCoordinator.acquire`, `restore`, `release`; [store.ts](packages/agentfabric/src/store.ts): `FabricStore`, `InvocationRecord`; [host.ts](packages/agentfabric/src/host.ts): `AgentFabricHost.prepare`, `lookup`, `reconcile`                                                                                                                                                                                       | Scheduler reserves effects for pending/running/unreconciled uncertain actions. Fabric enforces canonical-resource locks and durably records invocation reservations; uncertain writes retain holds until reconciliation. `FabricStore` has path-backed writer locking, mutation validation, tail handling and replay. Its lock is not a Loom journal lock, and Fabric must not gain knowledge of goals, approval waits or scheduling.                                                                                                                                                                   |
| Grants and revocation                 | [grants.ts](packages/agentsop/src/grants.ts): `Grant`, `GrantAuthority`, `createGrantAuthority`, `grantCovers`; [host.ts](packages/agentfabric/src/host.ts): `validateInvocation`, `prepare`, `invalidGrantReason`                                                                                                                                                                                                                                                                                                                                               | Issuance is object identity; serialized field-equal grants are not issued. `markInvoked` consumes a grant for invocation; revocation blocks further validity. Host invocation records supply durable outcome identity across restart. Never restore a serialized grant as executable authority or re-use a consumed grant.                                                                                                                                                                                                                                                                              |
| Budget and ceiling gates              | [scheduler.ts](packages/weave/src/scheduler.ts): `select`; [state.ts](packages/weave/src/state.ts): `applyAccepted`; [sites/index.ts](packages/weave/src/sites/index.ts): `transitionSite`; [implement-step.ts](packages/weave/src/implement-step.ts): `ImplementStepInput.ceiling`; [budget.ts](packages/gateway/src/budget.ts): `BUDGET_POLICY`, `budgetRoute`; [gateway.ts](packages/gateway/src/gateway.ts): `GatewayConfig`, `createInferenceGateway`; [implement-step.ts](packages/weave/src/implement-step.ts): `ImplementPorts`, `runImplementationStep` | Goal actions/judgments reserve and settle in Loom; gateway dispatch has cost/quota gates and injected quota/time ports; D2 `loop.route` and `ImplementStepInput.ceiling` bound tier separately. These are distinct constraints. A loop pause/reset time is permission to recheck, never a budget refill.                                                                                                                                                                                                                                                                                                |
| Operator disclosure                   | [read-port.ts](packages/loom-binding/src/read-port.ts): `openReadPort`, `approvalsOf`, `LoomRead`; [view.ts](packages/tapestry/src/view.ts): `DisclosedApproval`; [vocabulary.ts](packages/tapestry/src/vocabulary.ts): `VOCABULARY`; [tree.ts](packages/tapestry/src/tree.ts): `resolveTree`                                                                                                                                                                                                                                                                    | Pending approvals disclose metadata/digests/effects/reservation through a bounded view. Approval submission is declared unbound; the tree marks decisions unavailable. This is not an authenticated remote decision binding, and digests alone do not show a human the action content.                                                                                                                                                                                                                                                                                                                  |
| Time, purity and benchmarks           | [types.ts](packages/gateway/src/types.ts): `Clock`, `Timer`; [boolean.ts](packages/weave/src/sites/boolean.ts): `INPUT_RULES`, `OUTPUT_RULE`, `transitionBooleanSite`; [typesafe-ai.ts](packages/gateway/src/adapters/typesafe-ai.ts): `typesafeWire`, `typesafeWireProfile`; [providers.ts](benchmarks/decision-sites/providers.ts)                                                                                                                                                                                                                             | Time/waiting are injected ports; Loom receives `clock.tick`. Production guard judgments are observations. Direct benchmark routes deliberately omit production gateway policy and shuffling; `typesafeWire` fixes `shuffle: false`. HITL must not become a shared inference-adapter wrapper.                                                                                                                                                                                                                                                                                                            |

Existing behavioral evidence to preserve:

- [m1.test.ts](packages/weave/test/m1.test.ts): M1-T01 approval then one
  publication; T02 denial/expiry/silence; T03 forged origin; T05 revoked queued
  work across restart; T06 changed binding; T07 effect conflicts and independent
  reads; T08 stale revisions/pre-commit revocation; T09 budget; T10–T12
  cancellation/failures; T13 commit/result crash; T18 persistence faults; T19
  bounded recovery. T13 uses [m1-crash-worker.ts](packages/weave/test/m1-crash-worker.ts)
  and dies **after publication**, not during an approval wait.
- [host.test.ts](packages/agentfabric/test/host.test.ts): M1-T04 forged, absent,
  copied and widened grants; `denies reuse of the invocation grant while its
  implementation is pending`.
- [store.test.ts](packages/agentfabric/test/store.test.ts): `round-trips every
  accepted mutation through append, replay and compaction`, partial-append and
  torn-tail cases, and `allows exactly one process to win a concurrent open`.
- [operating-process.test.ts](packages/weave/test/operating-process.test.ts):
  `a process paused while waiting resumes to waiting; an idle one to idle`.
- [p5.test.ts](packages/weave/test/p5.test.ts): confidence/staleness/intake
  fallbacks and D2 ceiling with budget downgrade.
- [reference.test.ts](benchmarks/inference/jev/test/reference.test.ts):
  `reference gateway factory sends the pin and corpus order with no guardrail or
  shuffle fields`; [providers.test.ts](benchmarks/decision-sites/test/providers.test.ts):
  `TypeSafe pins model, batches and preserves question order; missing confidence
  remains absent`.

## Contract first: proposed records and trust boundaries

Freeze a contract and example record fixtures before implementation. Reuse the
observation envelope, sequence evidence, `Candidate`, `ReadSetEntry`,
`ResourceEffect`, `Reservation`, `ActionStartedPayload`, `ApprovalDecisionKind`
and `ResumePoint` where their meaning fits. Do not mutate historical version-1
semantics or silently upgrade old approvals into remote authority.

### Bound request and durable wait

**Proposed** `approval.requested` payload version 2 is one atomic opening record.
It contains both the bound request and its durable wait; there is no separate
request/write-wait gap. The wait is a projection of the observation log, not a
second mutable database. Required fields:

- Deterministically derived `request_id`, `wait_id`, initial wait revision, project/goal identity,
  candidate identity, opening state revision, contract/procedure/policy versions,
  and causal evidence sequences. Workstream/operating-process identity and
  revision are present only when attached; do not invent an implemented durable
  Thread record from the recursive-thread design.
- Exact operation, contract revision, immutable canonical inputs (or a retained
  content-addressed artifact ref plus revision and digest), canonical resource
  identities, effects, destination/expected revision when applicable, full
  `ReadSetEntry[]`, resource needs, and a digest of the entire execution binding.
  Preserve `bindingDigest(inputs, effects)` as a component, rather than pretending
  that it currently covers identity, policy, contract and disclosure.
- A versioned human presentation of this request, its digest, content class and
  allowed external destination. Retain the exact bytes/schema displayed. Include
  action content/draft, target, consequences/effects, input revisions, bounded
  spending/resource request, validity deadline, eligible approver policy and
  explicit approve/deny controls. A model-authored explanation is labelled as an
  observation and cannot replace exact content. Bind display and execution
  together; changed bytes, targets, effects, resource bounds or revisions require
  a new request and decision. Never ask a human to approve only an opaque digest.
- Continuation data limited to the typed action binding, journal position,
  versioned reconstruction instructions and, if needed, a `ResumePoint` ref and
  digest held by Loom. Retain referenced artifacts through decision, recovery
  and audit retention. No JS closure, provider conversation object, environment,
  host locator or serialized executable grant is a continuation.
- Approval policy reference/revision, explicit maximum delegable scope, captured
  authority revision, requested approver set, validity bounds and timeout policy
  revision. Preserve goal budget limits/spent/reserved through journal folding;
  request resource needs are not an already acquired execution reservation.
- An absolute deadline in the single persisted time domain defined below, plus
  the opening clock observation sequence. The current +10 ticks is not a
  production day-scale timeout. Clock observations are evidence; timeout
  settlement requires a separate explicit record.
- Lock policy `release_before_wait` for the first path, and evidence that no
  invocation or uncertain effects are outstanding. A future hold policy must
  name durable reservation owners; a record saying “hold” cannot create a lock.

C1 freezes identity derivation before runtime changes. Under the single journal
writer, let `opening_seq` be the next accepted observation sequence. Encode ids
as versioned, canonical length-prefixed tuples: `request_id = encode("apr-v2",
project_id, goal_id, candidate_id, opening_seq)` and `wait_id = encode("wait-v2",
request_id)`. This encoding is injective; uniqueness does not depend on a digest
collision assumption. The binding digest is stored and checked separately.
An append retry with the same id must have identical bytes; a conflicting reuse
is rejected. After denial/expiry/invalidation a newly authorized request uses a
new opening sequence, even for the same candidate and binding. It cannot reopen
the old request. Replay derives ids from records, never ambient entropy/time.
The wait revision is the sequence of its last accepted wait-affecting record:
opening, decision, settlement, cancellation, escalation or consumption. Delivery
status and clock ticks alone do not change it. Commands compare the expected
revision under ownership before append; an idempotent redelivery returns its
original result before this comparison.

### One persisted clock contract

Architectural recommendation for C1 (D-ENG-021): introduce **proposed**
`clock.tick@2` with a strictly increasing logical `tick`, `time_domain =
"unix-epoch-ms"`, `time_version = 1`, and a nonnegative safe-integer `time_ms`.
The injected trusted clock supplies this monotonic reading: `time_ms` must be
nondecreasing against the last persisted v2 reading, including across restart.
The domain has the fixed Unix UTC epoch and millisecond unit; logical ticks do
not convert to elapsed time and their frequency cannot change a deadline.
Reject missing/regressing readings and unknown domains/versions; never clamp a
regression into apparent freshness. A v1 tick supplies no v2 time evidence.
Without a new valid v2 reading, opening, accepting a decision and resuming are
blocked. Historical replay uses only the persisted readings.

A request deadline is a safe-integer `deadline_ms` in that same domain and
version, strictly greater than opening `time_ms`. V2 validity is half-open:
`opening_time_ms <= current.time_ms < effective_deadline_ms`, with a decision
allowed only to narrow the deadline. At equality or later, expiry wins. This is
a deliberate v2 difference: v1 remains valid at `tick == valid_until_tick` and
expires only at `tick > valid_until_tick`, with its implicit fold unchanged.

Trusted composition captures and persists a fresh v2 clock reading at startup,
ingress receipt, timeout evaluation and immediately before consumption. Timer
callbacks only request an observation; they cannot themselves expire a wait.
The signature verifier uses that exact persisted reading, referenced by seq,
for receipt/freshness: a verified signed epoch timestamp must satisfy
`0 <= time_ms - signed_timestamp_ms <= max_age_ms`, where the finite maximum
age belongs to the versioned verification policy. Do not compare signed times
to logical ticks or let payload timestamps advance Loom's clock. C3 and C4 use
this same port and evidence; unavailable trustworthy time refuses progress.

The human and external channel see **this bound request only**. They receive no
ambient state dump, transcript, nearby artifacts, unrelated approvals, secret
material, budget credentials or grant objects. Disclosure policy independently
authorizes content and destination before notification; approver entitlement
does not imply disclosure permission. If safe display cannot show the exact
action, withhold external delivery and require an entitled operator surface.
Record delivery ids/status separately so delivery retries never open more waits.

### Authenticated decision and principal mapping

**Proposed** `approval.decided@2` is a strict union discriminated by `origin`.
All variants bind request/wait id and expected revision, full execution and
presentation digests, decision and causal evidence. Reject fields belonging to
another variant, unknown versions and extra authority claims:

- `origin = channel`: authenticated `approved`/`denied`/`revoked` only, with verified
  principal, authority revision, ingress event id, adapter and installation/tenant,
  decision evidence ref, receipt clock seq/time and identity-mapping/policy
  revisions. It cannot assert `expired` or runtime invalidation.
- `origin = operator`: authenticated local `approved`/`denied`/`revoked` only, with
  principal, authority revision, trusted ingress command id, local identity
  configuration revision, decision evidence and receipt clock seq/time. It has
  no invented channel tenant or signature fields. Optional scope in either
  authenticated variant may only narrow the bound scope/deadline.
- `origin = runtime_policy`: `expired`/`revoked`/`invalidated` only, with policy
  id/revision, effective deadline, causing persisted v2 tick seq and reason/cause
  evidence (including authority/resource revisions as applicable). It has no
  principal, identity-mapping revision, ingress event id or channel fields.
  Runtime revocation/invalidation must cite the policy evidence that caused it;
  a tick alone is not authority to revoke.

C1 keeps the verified principal as a validated nonempty canonical identity
**string**, matching HEAD's representation. `Principal` is the glossary concept,
not an existing code type; no branded identity type is introduced. The mapper
resolves `(adapter, tenant/installation, stable channel subject id)` to that
string. Display names, email text, channel membership alone and payload-supplied
`principal`/`authority_revision` are insufficient. The injected authority lookup
must establish that this principal may decide this request in this project,
within its current authority and the goal's maximum delegable scope. Capture
the verified mapping and authority revision as evidence, and recheck them at
resume. Missing, ambiguous, stale or revoked mappings/authority refuse progress.
Benjamin's self-approval decision remains open in section A; C1 must bind the
chosen option into approver-policy fixtures before acceptance.

C1 fixes composition at a **proposed** leaf `examples/hitl.ts`, alongside the
existing Runtime/bootstrap composition in `examples/crystallize.ts`. Put HTTP
handling, bounded raw-body/signature verification, injected key lookup and
identity-mapper wiring in **proposed** `examples/hitl-channel.ts`; the leaf
bootstrap supplies Runtime's ports and the owned journal. Use no new package or
SDK for the local webhook proof. These modules are trusted composition, outside
`packages/weave`, `packages/gateway`, `packages/agentfabric` and `loom-binding`.
Loom receives normalized observations/ports; Fabric receives only its existing
invocation contract. Extend `checks/import-direction.mjs` fixture support in C6
so weave, gateway and agentfabric cannot import these modules by relative path
or a re-export. Keep the existing package-to-consumer prohibition; add red
fixtures for each protected package rather than asserting purity by convention.

The channel adapter verifies raw bounded bytes before interpreting a command:
signature algorithm/version, intended endpoint/tenant, event identity and signed
timestamp/freshness using the persisted v2 receipt-clock evidence above.
Signature proves channel origin; principal mapping establishes the actor;
entitlement permits the decision.
Ordinary channel text and `intake.classify` never synthesize approval.

The adapter receives secrets through an injected key lookup at trusted bootstrap.
Support key ids, bounded rotation overlap and revocation; verify using a
constant-time comparison where applicable. Never put keys, tokens, signatures,
raw webhook bodies or secret-bearing diagnostics on argv, logs, observations or
Weft traces. Store only bounded verified evidence/digests and a restricted
evidence ref when necessary. Exact Slack signature/API details remain unverified
offline and must be checked against primary documentation during that child.

### Settlement, timeout, escalation and cancellation

**Proposed** wait projection: pending → approved (ready for gates) → consumed by
one recorded action start; or pending/approved → denied, expired, cancelled,
revoked or invalidated. The consumed wait points to the existing action record
and its succeeded/failed/uncertain/reconciled lifecycle. **Consumed is terminal**
in the v2 wait projection. Later expiry/revocation/invalidation cannot overwrite
it: reject the stale settlement before append; replay validation rejects an
illegally appended transition. Action cancellation/reconciliation may still
advance the action, never return its wait to approved. No terminal request can
be reopened or reused, and approval does not complete the goal.

Use the origin-discriminated `approval.decided@2` union for authenticated
decisions and runtime expiry/revocation/invalidation. **Explicit records are
the only source of v2 settlement truth**: folding `clock.tick@2` updates time
without expiring waits. The writer appends due runtime-policy settlements before
accepting any later decision/start, including after restart; a crash between
tick and settlement blocks progress until the missing settlement is appended.
Replay never synthesizes it. Keep v1 `expireApprovals` and its historical
implicit tick fold unchanged, restricted to v1 requests, so a v2 request cannot
receive both implicit and explicit terminal transitions.
**Proposed** `approval.cancelled@1` records wait/request revision, requester,
authority evidence, reason and causal sequence before dispatch. Existing
`action.cancel_requested@1` remains the path once an action exists.
Stale bindings, missing artifacts or failed current-authority checks use the
runtime-policy invalidation variant, with reason and revision evidence; do not
add a second invalidation payload with competing terminal semantics.

**Proposed** `approval.escalated@1` records trigger tick, policy revision,
recipient set and delivery references. Escalation is bounded notification, not
approval, a new budget, a deadline extension or silent entitlement broadening.
Changing the entitled set or action creates a replacement bound request with a
fresh id derived from its new opening sequence; close the old one explicitly
before opening the replacement. Recommended timeout is expire and
notify an entitled operator; silence never approves. Timeout and escalation
choices remain product forks below.

**Proposed** `action.started` payload version 2 adds the wait/request revision,
approval decision sequence, binding digest and consumption reference to the
existing action start. Its single durable append atomically consumes the
approval, binds the unique action/invocation identity and books the existing
resource reservation. Serialized grant fields in that record are scope evidence,
not an issued object: trusted issuance happens for the live dispatch only after
the required start is durable. For the first v2 path, an approved but unconsumed
wait **never becomes `action.queued`**: keep it ready with no grant, action
reservation or execution slot until capacity is available, then recheck all C3c
resume gates and append `action.started@2` directly. Reject v2 wait references
on `action.queued`; do not introduce a second grant-bearing route around
consumption. Keep v1 queued-action folding and M1-T05 unchanged. C3c adds a
zero-capacity/restart behavioral coverage proving a v2 ready wait stays unqueued,
then revocation prevents dispatch when capacity returns. Recovery of a start
must reconcile its recorded invocation before considering any execution.

## Crash ordering, resumption and concurrency

C2 adds an opt-in **proposed** `OwnedFileJournal` implementing
`ObservationJournal`, selected only by HITL bootstrap. Keep `FileJournal`'s
constructor, append/snapshot behavior and existing callers unchanged; migration
of other callers requires a separate child. A read-only owned-journal snapshot
reader takes no writer lock, does not repair/create files and exposes only a
validated complete prefix; a second owned writer is refused. Snapshot reads do
not grant dispatch authority. Preserve M1-T13 and its `m1-crash-worker.ts`,
M1-T18 and M1-T19 unchanged, as well as M1-T05 queued-action coverage.

Use one fenced writer per opted-in Loom observation journal, owned by trusted bootstrap.
All ingress decisions, ticks, cancellations and resume attempts go through that
writer. A second resumer fails ownership before folding/dispatch; it cannot use
an in-memory flag as a cross-process fence. Start with local process ownership
and proven-dead recovery, drawing on the Fabric store's tested approach without
making Fabric import Loom. Multi-host/shared-filesystem ownership is out of
scope until a storage contract can fence it; unknown ownership fails closed.

The journal contract must define validated records, exclusive ownership,
complete append plus sync before acknowledgement, directory sync for new files,
safe handling of partial tails, and failure poisoning. Preserve all complete
acknowledged records; reject malformed complete records, conflicting duplicate
ids, broken sequence ordering and unknown required versions. Repair only a
provably incomplete unacknowledged suffix under writer ownership. Distinguish
identical event redelivery (idempotent success referencing the original result)
from conflicting payloads under the same event id (rejection). Rebuild all
deduplication, wait, consumption and budget indexes from the journal.
Current `FileJournal` cannot satisfy this merely by being called durable.

1. Bind and validate the draft under deterministic policy; persist the complete
   request/wait before sending a notification. A crash before delivery leaves a
   discoverable pending request. Delivery retries use its stable id and binding.
2. Suspend without an execution slot, in-flight model request or invocation
   grant. Independently viable work continues. When attached, project the
   existing operating process to `waiting` with request evidence; persist enough
   to reconstruct that projection rather than depending on a live session.
3. Verify ingress, actor mapping and entitlement. Under journal ownership,
   deduplicate event identity, compare expected request/wait revision and
   deadline, then persist the normalized decision before acknowledging receipt
   or waking work. No effect may run from the adapter's pre-persist memory.
4. If the process dies between verification/receipt and append, no success ACK
   was sent: channel redelivery retries the same event. If it dies after durable
   append but before ACK/wake, redelivery returns the recorded result and recovery
   discovers approved unconsumed waits. Do not rely on another inbound message
   to trigger resumption. An ACK-before-journal design needs a separate durable
   inbox and is excluded from the first implementation. A channel lacking
   redelivery/reliable sender retention needs such an inbox before admission;
   bytes never durably accepted cannot be promised recoverable.
5. On startup, acquire ownership, validate/fold the journal, accept a fresh
   `clock.tick@2` reading in the fixed Unix-millisecond domain, append explicit
   runtime-policy expiry records for all due v2 requests, reconcile existing action
   starts within their finite allowance, then enumerate approved unconsumed
   waits. Pure historical replay contacts neither authority/channel ports nor
   capabilities and never resumes work.
6. Before dispatch, validate request/decision/presentation digests, retained
   inputs, goal still active, policy and contract compatibility, approver still
   entitled, current grant ceiling, current goal authority and any revocation.
   Revalidate every read-set revision and destination precondition through
   authorized host access. Stale or unavailable evidence invalidates/blocks the
   request; it never silently updates the approved action. A fresh draft needs a
   fresh request. Approval cannot widen maximum delegable authority.
7. Recheck action/judgment/cost limits and existing reservations/spend, finite
   recovery allowance, D2 ceiling where inference is needed, and current gateway
   quota/cost/privacy gates for every routed dispatch. A budget pause preserves
   the existing wait/decision until its deadline; a reset only permits recheck.
   Unknown required quota/authority fails closed. None of these checks is waived
   by a human decision.
8. Check scheduler effect compatibility, append the consumption/action start
   once, issue only a current scoped single-use grant, then invoke under that
   action identity. The existing host invocation path reacquires canonical
   effect locks and checks preconditions before any consequential effect; its
   pre-commit validation and durable outcome recording remain mandatory. A host
   conflict/refusal is recorded and cannot recycle the consumed grant or
   approval. No new pre-invocation lock API is assumed. Cancellation/revocation
   arriving after start uses existing cancellation/reconciliation semantics; a
   committed effect is evidence, never erased by a later denial.

No atomic transaction spans Loom and Fabric today. A durable start with no
terminal result therefore enters existing recovery/reconciliation; an absent or
uncertain host outcome never authorizes blind repetition. If a crash occurs
after start but before invocation, stop for bounded reconciliation/explicit
resolution rather than issue the consumed authority again. A safe confirmed
no-effect retry is a new authorized attempt, with a fresh single-use grant and
recorded relationship to the prior attempt; it cannot reuse that request's
consumed approval. Safety is required even when liveness needs operator help.

### Races, failures and effect lock policy

| Case                                                   | Required deterministic result                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same approval delivered twice, including after restart | One decision, one consumption/action identity, at most one external effect; same-id same-body delivery returns original evidence. New event ids cannot answer a closed request again.                                                                                                                                                                                                                                                                                                                 |
| Forged, altered, cross-tenant or replayed approval     | Reject before privileged submission when verification fails; a valid signature for another request/digest/project does not bind this one. Expired, unmapped or unauthorized actors cause no grant or effect.                                                                                                                                                                                                                                                                                          |
| Approval versus timeout/cancel                         | Serialize by expected wait revision and journal order. Before approving or starting, apply the persisted current tick: at `time_ms >= effective_deadline_ms`, append explicit v2 expiry before decision/start even if a timer callback has not arrived. V1 equality remains valid. A cancel before consumption prevents dispatch; after consumption it requests action cancellation. Test both arrival orders, equality in both versions and expiry after consumption (rejected, consumed unchanged). |
| Two resumers after restart                             | Only the fenced journal owner may dispatch. Loser leaves journal, budgets, grants and effects untouched. Dead owner recovery never relies solely on elapsed time; unknown/live owner blocks.                                                                                                                                                                                                                                                                                                          |
| Disk full, partial write, ACK lost, corrupt record     | No unpersisted acceptance/wake; safe redelivery or fail-closed recovery. Preserve acknowledged prefix and consumption identity. Never truncate a complete malformed record to make recovery green.                                                                                                                                                                                                                                                                                                    |
| Crash after consumption or effect commit               | Replay is inert; recovery looks up the same invocation under current authority and bounded allowance. Keep uncertainty and locks until evidence resolves it; do not invoke again from an approved-state projection.                                                                                                                                                                                                                                                                                   |
| Authority or read-set changes while waiting            | Refuse dispatch under the old decision. Record invalidation/revocation evidence; rebind and request a new decision if useful and authorized.                                                                                                                                                                                                                                                                                                                                                          |
| Notification failure/cancellation of adapter           | Request remains durable; bounded retry/escalation records do not approve, renew budgets or implicitly cancel the goal.                                                                                                                                                                                                                                                                                                                                                                                |
| Cancel while offline                                   | Persist at trusted ingress once reachable; startup processes durable cancellation/expiry before resumption. No claim that an undelivered remote click has already cancelled work.                                                                                                                                                                                                                                                                                                                     |

Recommended lock policy: create the approval wait **before** starting the
consequential invocation, holding no action execution reservation or effect
lock for days. Release completed preparation locks, then bind their revisions.
Other work can change resources; stale bindings fail closed on reacquisition.
If an invocation already owns locks, stop/reconcile it before opening this wait.
Never release an uncertain write hold just to obtain human input.

Holding locks across a wait is a separate architectural fork: it requires
durable reservation ownership, reconstruction before any competing work,
bounded cancellation/expiry handling and reconciliation. It blocks conflicting
work for the entire wait and still does not keep data or authority current.
Defer it unless a concrete product action requires it; test that unsupported
hold requests are refused rather than silently treated as released.

## PR sequence and child issues

These are proposed child issues to create after review; this task creates none.
Each PR must demonstrate at least one genuinely failing behavioral test/check
against its immediate predecessor before implementation, then make it green.
The table separates new red evidence from characterization/guard evidence that
already passes. Contract fixtures and generated tests require review and
negative controls; names below are planned tests, not claims that they exist.
Each merged PR runs narrow checks then the full suite and leaves main green.
No permanently skipped red tests or weakened assertions. All new paths remain
off by default through C3a, C3b and C3c and until opt-in C5 activation.

| Child / PR                                              | Dependency and scope                                                                                                                                                                                                                                                                                                        | Genuinely red against predecessor                                                                                                                                                                                                                                                                                                                                                                                                                              | Done means / green guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — freeze channel-agnostic approval contract          | Captain go first. Freeze versions, immutable binding, id derivation and wait revision, clock/deadline boundary, origin union, string principal, authority ports and composition location. Benjamin owns approver-policy forks. Add glossary terms and strict parsers/folds only after contract acceptance; no live adapter. | `HITL-C1 binding rejects changed display, effects, scope and unknown versions`; `HITL-C1 decision scope cannot extend request expiry`; `HITL-C1 re-request after denial gets a distinct id and does not reopen the old one`; `HITL-C1 origin_union_rejects_channel_expired_and_runtime_principal`; `HITL-C1 clock_rejects_regressing_or_missing_time`; `HITL-C1 deadline_equality_preserves_v1_and_expires_v2`; `HITL-C1 expiry_after_consumption_is_rejected` | V2 fixtures fail before new parsers/folds, then valid records round-trip and malformed/mismatched transitions refuse. V1 historical replay and equality stay unchanged. **Green characterization:** `HITL-C1 ask_user and intake answers confer no approval`; prove its negative control rejects a fixture transition that mints approval from an intake answer. Encode Benjamin's self-approval answer with a matching policy test before C1 acceptance.                                                                             |
| C2 — opt-in owned observation journal                   | After C1. Add `OwnedFileJournal` with sync, validated tails and fenced writer ownership; HITL bootstrap opts in. Keep `FileJournal` untouched; separate migration child for other callers. No remote route enabled.                                                                                                         | `HITL-C2 acknowledged prefix survives partial append and reopen`; `HITL-C2 complete corrupt record refuses recovery`; `HITL-C2 second_owned_writer_is_refused_while_read_only_snapshot_works`; `HITL-C2 crash after durable append before response preserves event exactly once`                                                                                                                                                                               | Fault injection covers before/partial/after append and sync, new-file durability, poisoned writer, exact duplicate/conflicting ids and ownership recovery. M1-T13 with `m1-crash-worker.ts`, M1-T18 and M1-T19 pass unchanged; no lock retrofit into their `FileJournal` callers.                                                                                                                                                                                                                                                     |
| C3a — open and reconstruct v2 waits                     | After C1+C2. Wire publication request/wait opening, no-slot suspension and restart reconstruction with injected ports. Feature off by default; dispatch from v2 waits remains disabled.                                                                                                                                     | `HITL-C3a restart_mid_wait_resumes_from_journal_once`; `HITL-C3a durable_opening_holds_no_slot_or_grant`                                                                                                                                                                                                                                                                                                                                                       | Kill a child after durable opening and restart from files. Reconstruct exactly one pending wait; a test-only normalized approval produces exactly one ready continuation, with no invocation until C3c. Independent work proceeds. Another reopen duplicates neither request nor continuation; missing artifacts/time fail closed.                                                                                                                                                                                                    |
| C3b — explicit settlement and race ordering             | After C3a. Wire runtime-policy timeout/revocation/invalidation and authenticated cancellation, expected revisions and journal ordering. Feature off by default; no v2 dispatch.                                                                                                                                             | `HITL-C3b approve_timeout_cancel_each_order_has_one_winner`; `HITL-C3b crash_between_tick_and_settlement_recovers_one_terminal_record`                                                                                                                                                                                                                                                                                                                         | Permute approval, timeout, cancellation and invalidation using barriers; equality expires v2 while v1 stays inclusive. Reopen after each durable boundary; only explicit v2 records settle, stale commands cannot reopen terminal waits. Cancellation after consumption remains an action concern (C3c integration).                                                                                                                                                                                                                  |
| C3c — consume at start under current gates              | After C3b. Append one `action.started@2` and consume atomically; wire complete resume gates, non-renewal and two-resumer/reconciliation handling with injected authority/clock/host doubles. Feature off by default.                                                                                                        | `HITL-C3c revoked_authority_or_stale_read_set_fails_closed`; `HITL-C3c resume_does_not_renew_budget_or_reuse_grant`; `HITL-C3c two_resumers_after_restart_dispatch_once`; `HITL-C3c approved_before_crash_without_wake_is_resumed`; `HITL-C3c zero_capacity_keeps_v2_wait_unqueued_then_revocation_blocks_start`; `HITL-C3c expiry_after_consumption_cannot_change_wait`                                                                                       | With explicit test opt-in, restart, accept approval and publish once; reopen again without repeating effects. Check goal/approver authority, ceilings, policy/contract, retained bindings/read sets, budgets/reservations, recovery allowance, D2 and gateway quota/cost/privacy. Kill/reopen at consumption/start/invoke/commit/result boundaries; uncertain effects retain holds. M1-T05 and all v1 queue behavior pass unchanged.                                                                                                  |
| C4 — signed ingress and exact request delivery          | After C1+C2; develop independently of C3a–c behind a disabled composition binding. HTTP/signatures, key lookup and identity wiring live in `examples/hitl-channel.ts`, injected by `examples/hitl.ts`; no new package/dependency.                                                                                           | `HITL-C4 replayed_or_forged_approval_cannot_resume`; `HITL-C4 ingress_crash_before_append_requires_redelivery`; `HITL-C4 durable_decision_before_ack_redelivery_is_idempotent`; `HITL-C4 channel_identity_cannot_choose_principal`; `HITL-C4 approval_delivery_discloses_bound_request_only`; `HITL-C4 secrets_never_reach_argv_logs_or_journal`                                                                                                               | Offline signed fixtures cover tamper, wrong tenant, stale timestamp in C1's persisted time domain, unknown/rotated/revoked key, oversized body, mapping removal, widened scope and conflicting ids. Rejected ingress produces zero grants/effects; delivery retry references one request with no ambient disclosure.                                                                                                                                                                                                                  |
| C5 — first production channel and end-to-end acceptance | After C3c+C4+C6 and Benjamin's channel/entitlement/self-approval/timeout choices. Bind ports only at trusted bootstrap; Slack only if selected. Verify current primary protocol docs during this child.                                                                                                                     | `HITL-C5 channel_approve_deny_timeout_cancel_restart_contract` against the still-unbound production channel in the predecessor; `HITL-C5 delivery_failure_keeps_wait_and_consumes_no_execution_slot`                                                                                                                                                                                                                                                           | Fake channel plus real journals/host proves draft → exact display → days of injected time/restart → approve or deny → gated continuation. Preserve uncertain-effect holds until reconciliation. Document identity mapping, rotation, retry/ACK behavior and operator inspection/cancellation. Live smoke requires an explicitly authorized destination; rollout is opt-in.                                                                                                                                                            |
| C6 — isolation and recurring-finding checks             | After C1; develop alongside C2–C4, merge before C5 activation. Preserve package/clock/secret boundaries and benchmark wire contracts.                                                                                                                                                                                       | `HITL-C6 import_direction_checks_supplied_hitl_fixture_root`: extend `checks/import-direction.mjs` to honor a fixture root and assert rejection of planted weave/gateway/agentfabric → channel-composition imports. At the predecessor it ignores the fixture-root argument and reports the clean repository instead, so the fixture assertion fails.                                                                                                          | **Green guards:** `HITL-C6 benchmark_routes_omit_hitl_guardrails_and_shuffle` and `HITL-C6 runtime_and_gateway_import_no_channel_adapter` (extend to Fabric). Negative controls wrap a fixture benchmark route in an approval envelope/add guardrail or shuffle fields, and plant forbidden adapter imports/re-exports in each protected package. Each guard must reject its mutation. Existing reference/provider wire tests stay green under hostile HITL configuration; no corpus, held-out check, threshold or route is weakened. |

C2 and C4 share a frozen contract, not code generation authority. C4 cannot
activate before C2's durability guarantee. Dependencies are C3a → C3b → C3c;
C3c and C4 join at C5, with C6 a release gate. Independent review of adversarial
cases should precede implementation; reserve held-out cases before any later
comparative benchmark. This task does not run benchmarks or send any corpus to
a hosted model. A negative control validates a guard's sensitivity; it does not
relabel an already-green production guard as red against the predecessor.

### Acceptance traceability (issue access assumption)

This maps every acceptance item supplied in the review brief; it is not a claim
that the live issue body/comments were read. Confirm against #352 before C1.

| Acceptance item                                         | Contract and implementation evidence                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Draft the high-stakes action                            | C1 exact presentation/execution binding; C3a publication opening; C5 exact-display flow.                                                                           |
| Serialize the pending request/continuation              | C1 atomic opening and record-only continuation; C2 owned journal; C3a kill/reopen reconstruction.                                                                  |
| Wait hours to days without occupying execution capacity | C1 persisted millisecond clock/deadline; C3a no-slot/no-grant suspension; C3b timeout; C5 days of injected time/restart.                                           |
| Decision by an entitled principal                       | C1 string identity, mapping and bounded approver policy (Benjamin's self-approval choice open); C4 verified mapping; C3c entitlement recheck; C5 selected channel. |
| Signed webhook ingress                                  | C1 origin/receipt-time contract and named composition; C2 persist-before-ACK; C4 signature, replay and redelivery tests; C6 import/secret guards.                  |
| Resume under current authority                          | C3b settle before resumption; C3c current authority/read set/ceilings and single consumption; C5 complete flow; C6 dependency isolation.                           |
| No budget renewal                                       | C1 folded limits/spend/reservations; C3c non-renewal of budgets/grants/approval and finite recovery; C5 restart flow; C6 benchmark isolation.                      |

Preserve the existing gateway-routed Muse Spark competitor's privacy and cost
checks in [competitors.ts](benchmarks/decision-sites/competitors.ts),
`museSparkCompetitor`. Isolation means adding no production HITL/guard judgment
or shuffle behavior to benchmark calls; it does not remove that existing gate.

For each child run its named tests, existing M1/host/store/process/site tests
where affected, `npm run fmt:check`, `npm run check`, and `npm run verify`.
Use deterministic barriers and injected clocks for races rather than sleeps.
Kill/reopen subprocess tests supplement in-memory folding; neither alone proves
all filesystem power-loss behavior. Specify supported storage durability and
fault model in C2; do not claim distributed exactly-once delivery from local
process tests.

## Owner questions and recommendations

### A. Product forks for Benjamin

Every row remains an open product-fork owner question for Benjamin.
Recommendations describe proposed defaults, not accepted product decisions.

| Question                                                                                                                                 | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which channel first: signed webhook for an existing operator surface, Slack, or another channel?                                         | Prove the generic signed-webhook contract locally, then choose Slack only if it is the actual operator workflow. Do not make Slack identity or payloads a Loom type.                                                                                                                                                                                                                                                                                                              |
| Who is entitled to approve, and is multiple approval required?                                                                           | **Open for Benjamin.** Recommend explicitly mapped project approvers and one entitled principal within a configured maximum delegable scope. No membership/name inference. Multiple approvals require quorum and distinct-principal aggregation in C1.                                                                                                                                                                                                                            |
| Benjamin: may the goal opener approve Loom's first high-stakes publication draft, including when that principal delegated the authority? | **Open product fork; no selection made.** Allow: an entitled goal opener/delegator can satisfy the approval alone. Disallow: require an entitled principal distinct from the opener (and decide whether separation also excludes the delegator), so dispatch waits for that other principal. C1 records opener/delegator identity as needed, freezes the chosen rule in approver policy and adds a matching allow/refuse test. One-approver quorum does not answer self-approval. |
| What timeout and escalation should operators expect?                                                                                     | Make the deadline explicit per request, with a configurable default; recommend 24 hours initially, expiry plus bounded notification, no automatic approve or execution. Escalation may notify an already entitled alternate without extending validity.                                                                                                                                                                                                                           |
| Which actions justify a long wait, and how much exact draft content may leave the host?                                                  | Start with publication of a bounded draft to one target. Disclose only that request to an allowed destination; use a trusted operator surface when content cannot safely leave. Choose retention requirements explicitly.                                                                                                                                                                                                                                                         |
| Can cancellation/denial end the goal or only this action?                                                                                | Settle this request and keep goal outcome separate; let the operator explicitly stop the goal. Show committed/uncertain effects honestly when cancellation arrives late.                                                                                                                                                                                                                                                                                                          |

### B. Architectural and code-health questions

D-ENG-021: these receive concrete engineering recommendations below; they do
not become product-fork owner questions. C1 freezes the decisions before code.

| Question                                                                           | Recommendation                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extend publication records or add a generic wait service?                          | Use version-2 approval request/decision records and a journal-derived wait projection, with publication as the first consumer. Reuse operating-process transitions, not a second scheduler.                                                                                                                                                                                          |
| Where is the current authority ceiling recorded?                                   | Define an injected deterministic authority lookup and explicit maximum delegable scope in the contract. Existing `Goal.authority` and M1 publication exception do not establish a general remote-approval ceiling. Freeze that distinction before code; preserve D2 tier ceiling independently.                                                                                      |
| How to coordinate recovery and two resumers?                                       | Opt-in `OwnedFileJournal` with one exclusive, fenced local writer plus lock-free read-only snapshots; preserve `FileJournal` and its M1 callers. Reject unknown/live competing owners. Keep ownership mechanics at storage/bootstrap. Defer multi-host ownership rather than suggest optimistic in-memory dedupe solves it.                                                          |
| Reuse FabricStore or FileAttemptJournal directly?                                  | Reuse their tested durability mechanics where coherent, but keep Loom observation records separate from invocation/attempt domains. `FileAttemptJournal` is explicitly not a lock; do not make it one by assertion. Avoid a storage framework or new dependency without evidence of need.                                                                                            |
| Which clock, decision origin, identity and queue rules?                            | Freeze `clock.tick@2` with nondecreasing Unix milliseconds, half-open v2 deadlines and shared ingress freshness; use the strict decision-origin union, validated string principals, terminal consumption and no `action.queued` for v2 waits. Preserve all v1 semantics.                                                                                                             |
| Hold effect locks during the wait?                                                 | Release before the wait; reacquire and revalidate on dispatch. Preserve uncertain invocation holds. Add durable held-wait support only for a concrete action that cannot use revision checks.                                                                                                                                                                                        |
| What if a consumption/start exists but host execution is unconfirmed?              | Reconcile the existing invocation within finite allowance; fail closed if evidence is unavailable. Never replay a consumed approval or grant to improve liveness.                                                                                                                                                                                                                    |
| How to keep gateway and runtime pure?                                              | Use leaf `examples/hitl.ts` for bootstrap/Runtime ports and `examples/hitl-channel.ts` for HTTP/signatures, injected key lookup and identity wiring. Keep deterministic transitions in Loom and persistence in the owned journal. C6 fixture-checks forbid weave, gateway and agentfabric imports of this composition. Keep ambient-clock/env checks and Fabric independence intact. |
| How to connect waiting workstreams without adopting the recursive-thread proposal? | Store optional existing workstream/process identifiers and projection evidence; reconstruct `operating.process@1` waiting/woke transitions. Add no execution-claim or result-reference implementation under this parent.                                                                                                                                                             |
| How to prevent repeated review regressions?                                        | Make each repeated finding a narrow test or lint: binding drift, scope extension, grant reuse, ACK-before-persist, ambient time, secret disclosure and benchmark wire contamination. Never relax validation or held-out evidence to make green.                                                                                                                                      |

## Terms to add in the implementation contract PR

No glossary edit is made in this planning task. C1 should propose these precise
additions/clarifications before code introduces the corresponding names:

- **Durable approval wait**: journal-derived suspension of one bound request;
  it holds no execution slot and grants no authority.
- **Approval-request binding**: immutable association of exact displayed request,
  typed action, revisions, scope and validity, identified by a versioned digest.
- **Approval consumption**: one durable association of an approved bound request
  with one action start; it does not renew budgets or permit reuse.
- **Channel identity mapping**: versioned trusted mapping from a verified channel
  subject and installation/tenant to a principal; distinct from entitlement.
- Clarify existing **Approval**, **Recovery**, **Read set**, **Effect lock** and
  **Resume point** entries only as needed. Do not redefine **Replay**, **Thread**,
  **Execution claim**, **Session record**, **Grant** or **Budget gate** to imply
  this work implements their unrelated proposals or resets their limits.

## Verification and assumptions for this planning change

Review target `dabe4f3` contains the prior plan; source inventory remains based
on `e4dc5e16bf8d1ad25d18c9d7041066a9fa982883`. Rechecked the relevant runtime,
folding, journal, queue, composition, import-check and M1 test contracts when
addressing the review. Read VISION.md, GLOSSARY.md and AGENTS.md before design
decisions. This change updates only PLAN.md; proposed tests/records above are
future child work, not implementation or claims of demonstrated red today.

`gh issue view 352 --repo CrowBe/weave` with body/comments requested failed
with `error connecting to api.github.com`. **Explicit assumption:** acceptance
traceability uses the review brief's seven items; the actual issue body and
comments may add constraints. Confirm them before C1 acceptance. This failure
does not turn Benjamin's product forks into engineering decisions.

With supported Node 22.23.4 (repository minimum >=22.18.0),
`npm run fmt:check` passes and includes PLAN.md; `npm run check` passes,
including import direction, ambient clock/entropy/environment and
swallowed-failure checks. `git diff --check` passes.

The full `npm run verify` passes formatting and `check`, then stops in
`test:checks` at `checks/test/checks.test.mjs`; later stages do not run.
Running the fixture tests directly shows empty child-process diagnostics, and
a direct `spawnSync` reproduction reports `EPERM`, status 1 and empty output.
This is an environment restriction on fixture child launches, not green evidence
for the remaining suite. No tests, permissions or checks were weakened.

Repository evidence cannot establish deployed channel setup, approver identities,
secret provisioning, external delivery retention/ACK guarantees, storage medium
durability, or multi-host filesystem semantics. Those are explicit assumptions
to resolve in the relevant children. Slack protocol details require current
primary documentation in C5 if selected. No source, tests, schemas, glossary,
vision, permissions, protected checks or benchmark inputs change in this task.
