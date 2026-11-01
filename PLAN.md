# WV-352: durable asynchronous approval and resumption

Planning only, on `wv-352-durable-hitl-plan`. No implementation is authorized
until captain go. This document is the only tracked change. The issue brief is
the requirements source: the no-network instruction takes precedence over
fetching #352 with `gh`. No issue body or comments were fetched.

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

| Concern                               | Exact files and symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Existing behavior and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval records                      | [types.ts](packages/weave/src/types.ts): `ApprovalRequestedPayload`, `ApprovalDecidedPayload`, `ApprovalRecord`, `ApprovalDecisionKind`, `ObservationInput`                                                                                                                                                                                                                                                                                                                                                                                                      | Observation envelopes have `payload_type` and `payload_version`; the runtime writes approval payload version 1. Requests bind publication-specific digests, destination, expected revision, resource read set, effects, reservation and validity ticks. Decisions carry a claimed principal and authority revision. There is no channel identity proof or durable resume ownership.                                                                           |
| Request formation and decisions       | [runtime.ts](packages/weave/src/runtime.ts): `Runtime.requestApprovals`, `Runtime.decide`, `Runtime.stillAuthorized`, `Runtime.issueGrant`                                                                                                                                                                                                                                                                                                                                                                                                                       | Requests are currently specific to `report.publish`, use `apr:${candidate_id}`, and expire at current tick + 10. An existing request prevents another request with that id. `decide` uses the operator ingress; it is not a remote authentication service. Grants are issued at dispatch.                                                                                                                                                                     |
| Approval policy                       | [candidates.ts](packages/weave/src/candidates.ts): `publishEligibility`, `bindingDigest`, `matchingApproval`, `approvalStillValid`                                                                                                                                                                                                                                                                                                                                                                                                                               | Digest covers inputs and effects. Standing destination write authority or a matching approved request permits publication. `approvalStillValid` checks status and upper validity tick, not an external entitlement service or a current principal authority revision. A separate maximum delegable approval scope is not represented here.                                                                                                                    |
| Validation and folding                | [validation.ts](packages/weave/src/validation.ts): `EXPECTED_SOURCE`, `validate`, `validateApprovalRequest`, `validateApprovalDecision`; [state.ts](packages/weave/src/state.ts): `applyAccepted`, `expireApprovals`, `readSetMatches`                                                                                                                                                                                                                                                                                                                           | Validation checks privileged provenance kinds, request existence/status and basic decision fields; it does not authenticate a webhook or establish principal entitlement. Request validation checks only part of the declared shape. Decision scope can replace the expiry tick without enforcing narrowing. Ticks expire pending/approved requests; folding retains evidence sequences. These are gaps to close, not patterns to copy into the new contract. |
| Trusted ingress                       | [runtime.ts](packages/weave/src/runtime.ts): `IngressHandle`, `Runtime.observe`, `Runtime.operator`, `Runtime.clock`, `Runtime.appendStep`, `Runtime.admitStep`                                                                                                                                                                                                                                                                                                                                                                                                  | Untrusted observations cannot claim privileged provenance. Accepted observations persist before state application and cycle triggering. Handles are in-process bootstrap authority; strings naming an operator are not credentials. Only accepted observations go to `ObservationJournal`, so rejected-input diagnostics are not a durable security inbox.                                                                                                    |
| `ask_user` and intake                 | [sites/index.ts](packages/weave/src/sites/index.ts): `SITE_POLICY`, `IntakeState`, `SiteObservation`, `transitionSite`, `evaluateSite`; [sites/CONTRACT.md](packages/weave/src/sites/CONTRACT.md)                                                                                                                                                                                                                                                                                                                                                                | `intake.classify` proposes `new_thread`, `continue_thread`, `queue`, `steer`, `interrupt`, `stop`. Low confidence returns `ask_user` / `needs_human` in `decision-site@1`; it creates neither approval authority nor a durable human wait. A classification answer cannot approve an action.                                                                                                                                                                  |
| Input routing                         | [input-route.ts](packages/weave/src/input-route.ts): `decideRoute`, `applyRoute`; [workstream.ts](packages/weave/src/workstream.ts): `Workstream`, `WorkstreamEvent`, `WORKSTREAM_SCHEMA`                                                                                                                                                                                                                                                                                                                                                                        | Input routing and pure `workstream@1` transitions exist independently of intake classification. External approval commands must use a typed ingress path, not natural-language classification or inferred operator intent.                                                                                                                                                                                                                                    |
| Waiting actions and wait observations | [types.ts](packages/weave/src/types.ts): `ActionState`, `CycleOutcome`, `PAYLOAD_TYPES`; [runtime.ts](packages/weave/src/runtime.ts): `Runtime.runCycle`, `Runtime.drainQueue`                                                                                                                                                                                                                                                                                                                                                                                   | `ActionState` has pending/running/terminal/uncertain states, with no suspended human-wait action. Cycle `waiting` describes in-flight work; publication awaiting approval is a blocked outcome. `PAYLOAD_TYPES` contains `clock.tick`, approval and cancellation observations, but no generic durable `wait.*` observation. A returned `waiting` outcome is not itself a durable wait record.                                                                 |
| Operating process                     | [operating-process.ts](packages/weave/src/operating-process.ts): `PROCESS_SCHEMA`, `OperatingProcess`, `WaitReason`, `ResumePoint`, `transitionProcess`                                                                                                                                                                                                                                                                                                                                                                                                          | Pure `operating.process@1` transitions support `waiting` on approval/capability/dependency, `woke`, and pause/resume by opaque ref plus digest. They do not journal a bound request, authenticate a decision, issue authority, or wire recovery to publication. Reuse these semantics where a workstream is attached; do not equate waiting with paused.                                                                                                      |
| Observation durability and recovery   | [journal.ts](packages/weave/src/journal.ts): `ObservationJournal`, `MemoryJournal`, `FileJournal`, `PersistError`; [runtime.ts](packages/weave/src/runtime.ts): `Runtime.load`, `Runtime.reconcile`, `replay`, `recover`                                                                                                                                                                                                                                                                                                                                         | `FileJournal` appends JSONL and parses lines. It lacks fsync, torn-tail repair and exclusive-writer fencing. `load` checks increasing seqs and folds accepted records; it trusts stored validation. `recover` loads then reconciles actions; it does not independently wake every approved wait. Do not claim arbitrary crash durability, tamper protection, or two-resumer exclusion from these APIs.                                                        |
| Other durable records                 | [implement-step.ts](packages/weave/src/implement-step.ts): `FileAttemptJournal`, `MemoryAttemptJournal`, `AttemptJournal`, `repairTornTail`; [audit-loop.ts](packages/weave/src/audit-loop.ts): `AuditJournal`, `MemoryAuditJournal`, `AuditCheckpoint`                                                                                                                                                                                                                                                                                                          | Attempt journals use `impl.attempt@1` / `impl.stop@1`, sync appends and new directory entries, repair tails, deduplicate ids and detect some foreign writes. Their own contract requires one writer; detection is not a lock. Audit checkpoints are a different contract. Reuse proven mechanics/tests where appropriate, not these domain records as human waits.                                                                                            |
| Effect locks and host durability      | [scheduler.ts](packages/weave/src/scheduler.ts): `select`, `rejectReason`; [coordinator.ts](packages/agentfabric/src/coordinator.ts): `ResourceCoordinator.acquire`, `restore`, `release`; [store.ts](packages/agentfabric/src/store.ts): `FabricStore`, `InvocationRecord`; [host.ts](packages/agentfabric/src/host.ts): `AgentFabricHost.prepare`, `lookup`, `reconcile`                                                                                                                                                                                       | Scheduler reserves effects for pending/running/unreconciled uncertain actions. Fabric enforces canonical-resource locks and durably records invocation reservations; uncertain writes retain holds until reconciliation. `FabricStore` has path-backed writer locking, mutation validation, tail handling and replay. Its lock is not a Loom journal lock, and Fabric must not gain knowledge of goals, approval waits or scheduling.                         |
| Grants and revocation                 | [grants.ts](packages/agentsop/src/grants.ts): `Grant`, `GrantAuthority`, `createGrantAuthority`, `grantCovers`; [host.ts](packages/agentfabric/src/host.ts): `validateInvocation`, `prepare`, `invalidGrantReason`                                                                                                                                                                                                                                                                                                                                               | Issuance is object identity; serialized field-equal grants are not issued. `markInvoked` consumes a grant for invocation; revocation blocks further validity. Host invocation records supply durable outcome identity across restart. Never restore a serialized grant as executable authority or re-use a consumed grant.                                                                                                                                    |
| Budget and ceiling gates              | [scheduler.ts](packages/weave/src/scheduler.ts): `select`; [state.ts](packages/weave/src/state.ts): `applyAccepted`; [sites/index.ts](packages/weave/src/sites/index.ts): `transitionSite`; [implement-step.ts](packages/weave/src/implement-step.ts): `ImplementStepInput.ceiling`; [budget.ts](packages/gateway/src/budget.ts): `BUDGET_POLICY`, `budgetRoute`; [gateway.ts](packages/gateway/src/gateway.ts): `GatewayConfig`, `createInferenceGateway`; [implement-step.ts](packages/weave/src/implement-step.ts): `ImplementPorts`, `runImplementationStep` | Goal actions/judgments reserve and settle in Loom; gateway dispatch has cost/quota gates and injected quota/time ports; D2 `loop.route` and `ImplementStepInput.ceiling` bound tier separately. These are distinct constraints. A loop pause/reset time is permission to recheck, never a budget refill.                                                                                                                                                      |
| Operator disclosure                   | [read-port.ts](packages/loom-binding/src/read-port.ts): `openReadPort`, `approvalsOf`, `LoomRead`; [view.ts](packages/tapestry/src/view.ts): `DisclosedApproval`; [vocabulary.ts](packages/tapestry/src/vocabulary.ts): `VOCABULARY`; [tree.ts](packages/tapestry/src/tree.ts): `resolveTree`                                                                                                                                                                                                                                                                    | Pending approvals disclose metadata/digests/effects/reservation through a bounded view. Approval submission is declared unbound; the tree marks decisions unavailable. This is not an authenticated remote decision binding, and digests alone do not show a human the action content.                                                                                                                                                                        |
| Time, purity and benchmarks           | [types.ts](packages/gateway/src/types.ts): `Clock`, `Timer`; [boolean.ts](packages/weave/src/sites/boolean.ts): `INPUT_RULES`, `OUTPUT_RULE`, `transitionBooleanSite`; [typesafe-ai.ts](packages/gateway/src/adapters/typesafe-ai.ts): `typesafeWire`, `typesafeWireProfile`; [providers.ts](benchmarks/decision-sites/providers.ts)                                                                                                                                                                                                                             | Time/waiting are injected ports; Loom receives `clock.tick`. Production guard judgments are observations. Direct benchmark routes deliberately omit production gateway policy and shuffling; `typesafeWire` fixes `shuffle: false`. HITL must not become a shared inference-adapter wrapper.                                                                                                                                                                  |

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

- Unique `request_id`, `wait_id`, initial wait revision, project/goal identity,
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
- An explicit clock domain/version and absolute deadline in its injected time
  units. Retain tick-based semantics only with a documented persistent epoch and
  unit mapping; the current +10 ticks is not a production day-scale timeout.
  Reject invalid/regressing readings; missing trustworthy time blocks approval
  use. Clock readings and timeout evaluation are recorded observations.
- Lock policy `release_before_wait` for the first path, and evidence that no
  invocation or uncertain effects are outstanding. A future hold policy must
  name durable reservation owners; a record saying “hold” cannot create a lock.

The human and external channel see **this bound request only**. They receive no
ambient state dump, transcript, nearby artifacts, unrelated approvals, secret
material, budget credentials or grant objects. Disclosure policy independently
authorizes content and destination before notification; approver entitlement
does not imply disclosure permission. If safe display cannot show the exact
action, withhold external delivery and require an entitled operator surface.
Record delivery ids/status separately so delivery retries never open more waits.

### Authenticated decision and principal mapping

**Proposed** `approval.decided` payload version 2 retains request id, principal,
decision and authority revision, adding wait/request revision, full binding and
presentation digests, ingress event id, channel installation/tenant identity,
decision evidence reference, verified receipt time and identity-mapping/policy
revision. Optional scope may only narrow the bound scope/deadline, never extend
it. Unknown versions, extra authority claims and malformed fields fail closed.

Trusted bootstrap injects a channel identity mapper and authority lookup. The
mapper resolves `(adapter, tenant/installation, stable channel subject id)` to a
Weave `Principal`; display names, email text, channel membership alone and
payload-supplied `principal`/`authority_revision` are insufficient. The lookup
must establish that this principal may decide this request in this project,
within its current authority and the goal's maximum delegable scope. Capture
the verified mapping and authority revision as evidence, and recheck them at
resume. Missing, ambiguous, stale or revoked mappings/authority refuse progress.

The channel adapter verifies raw bounded bytes before interpreting a command:
signature algorithm/version, intended endpoint/tenant, event identity and signed
timestamp/freshness using an injected clock. Signature proves channel origin;
principal mapping establishes the actor; entitlement permits the decision.
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
and its succeeded/failed/uncertain/reconciled lifecycle. No terminal request can
be reopened or reused, and approval does not complete the goal.

Reuse `approval.decided@2` for denial, revocation and expiry, with runtime expiry
caused by a persisted `clock.tick`, deterministic policy id and deadline.
**Proposed** `approval.cancelled@1` records wait/request revision, requester,
authority evidence, reason and causal sequence before dispatch. Existing
`action.cancel_requested@1` remains the path once an action exists.
**Proposed** `approval.invalidated@1` records stale bindings, missing artifacts,
or failed current-authority checks with reason and revision evidence.

**Proposed** `approval.escalated@1` records trigger tick, policy revision,
recipient set and delivery references. Escalation is bounded notification, not
approval, a new budget, a deadline extension or silent entitlement broadening.
Changing the entitled set or action creates a replacement bound request with a
fresh id; the old one is closed explicitly. Recommended timeout is expire and
notify an entitled operator; silence never approves. Timeout and escalation
choices remain product forks below.

**Proposed** `action.started` payload version 2 adds the wait/request revision,
approval decision sequence, binding digest and consumption reference to the
existing action start. Its single durable append atomically consumes the
approval, binds the unique action/invocation identity and books the existing
resource reservation. Serialized grant fields in that record are scope evidence,
not an issued object: trusted issuance happens for the live dispatch only after
the required start is durable. Do not queue a consumed approval with a serialized grant
for hours: keep it ready until capacity is available, recheck then, and issue a
fresh execution grant only for dispatch. Recovery of a start must reconcile its
recorded invocation before considering any execution.

## Crash ordering, resumption and concurrency

Use one fenced writer per Loom observation journal, owned by trusted bootstrap.
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
   injected clock observation, expire due requests, reconcile existing action
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

| Case                                                   | Required deterministic result                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same approval delivered twice, including after restart | One decision, one consumption/action identity, at most one external effect; same-id same-body delivery returns original evidence. New event ids cannot answer a closed request again.                                                                                                                                                                                 |
| Forged, altered, cross-tenant or replayed approval     | Reject before privileged submission when verification fails; a valid signature for another request/digest/project does not bind this one. Expired, unmapped or unauthorized actors cause no grant or effect.                                                                                                                                                          |
| Approval versus timeout/cancel                         | Serialize by expected wait revision and journal order. Before approving or starting, apply the persisted current tick: at/after the chosen deadline, expiry wins even if a delayed timer callback has not arrived. A cancel before consumption prevents dispatch; after consumption it requests action cancellation. Test both arrival orders and the exact boundary. |
| Two resumers after restart                             | Only the fenced journal owner may dispatch. Loser leaves journal, budgets, grants and effects untouched. Dead owner recovery never relies solely on elapsed time; unknown/live owner blocks.                                                                                                                                                                          |
| Disk full, partial write, ACK lost, corrupt record     | No unpersisted acceptance/wake; safe redelivery or fail-closed recovery. Preserve acknowledged prefix and consumption identity. Never truncate a complete malformed record to make recovery green.                                                                                                                                                                    |
| Crash after consumption or effect commit               | Replay is inert; recovery looks up the same invocation under current authority and bounded allowance. Keep uncertainty and locks until evidence resolves it; do not invoke again from an approved-state projection.                                                                                                                                                   |
| Authority or read-set changes while waiting            | Refuse dispatch under the old decision. Record invalidation/revocation evidence; rebind and request a new decision if useful and authorized.                                                                                                                                                                                                                          |
| Notification failure/cancellation of adapter           | Request remains durable; bounded retry/escalation records do not approve, renew budgets or implicitly cancel the goal.                                                                                                                                                                                                                                                |
| Cancel while offline                                   | Persist at trusted ingress once reachable; startup processes durable cancellation/expiry before resumption. No claim that an undelivered remote click has already cancelled work.                                                                                                                                                                                     |

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

These are proposed child issues to create after review; no issue creation or
network action is part of this task. Each PR begins with its listed failing
behavioral test/check demonstrated against the prior implementation, then the
smallest implementation that makes it green. Contract fixtures and generated
tests require review and negative controls; names below are planned tests, not
claims that they exist. Each merged PR runs narrow checks then the full suite
and leaves main green. No permanently skipped red tests or weakened assertions.

| Child / PR                                                     | Dependency and scope                                                                                                                                                                                                                                               | Named red-before-green evidence                                                                                                                                                                                                                                                                                                                  | Done means                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — freeze channel-agnostic approval contract                 | Captain go first. Document versions, immutable binding, identity/authority ports, deadline semantics, state transitions and unsupported cases. Add strict parsers/folds without a live adapter or default activation. Add the glossary terms listed below.         | `HITL-C1 binding rejects changed display, effects, scope and unknown versions`; `HITL-C1 decision scope cannot extend request expiry`; `HITL-C1 ask_user and intake answers confer no approval`                                                                                                                                                  | Valid fixtures round-trip; malformed/mismatched fixtures refuse; v1 historical replay remains unchanged; no new authority from v1 remote input. Contract accepted before generating implementation.                                                                                                                                                                                         |
| C2 — durable observation journal ownership and append contract | After C1. Strengthen the Loom journal boundary using existing sync/tail/locking lessons; keep Fabric independent. No remote route enabled.                                                                                                                         | `HITL-C2 acknowledged prefix survives partial append and reopen`; `HITL-C2 complete corrupt record refuses recovery`; `HITL-C2 competing journal writers cannot both own dispatch`; `HITL-C2 crash after durable append before response preserves event exactly once`                                                                            | Fault injection covers before/partial/after append and sync, new-file durability, poisoned writer, exact duplicate/conflicting ids and ownership recovery. All prior M1 persistence/replay tests stay green.                                                                                                                                                                                |
| C3 — durable wait and safe consumption                         | After C1+C2. Wire the existing publication path to journal-derived waits, no-slot suspension, timeout/cancel/invalidation and one consumption at action start. Use injected authority/clock/host doubles.                                                          | `HITL-C3 restart_mid_wait_resumes_from_journal_once`; `HITL-C3 approved_before_crash_without_wake_is_resumed`; `HITL-C3 revoked_authority_or_stale_read_set_fails_closed`; `HITL-C3 resume_does_not_renew_budget_or_reuse_grant`; `HITL-C3 approve_timeout_cancel_each_order_has_one_winner`; `HITL-C3 two_resumers_after_restart_dispatch_once` | A real child process is killed after durable request and before decision; a fresh process reconstructs from files, accepts a valid decision and publishes once. Reopen again with no effect. Test changed contract/authority, deadline equality, missing clock, exhausted budget/recovery, lock reacquisition conflict, independent work and all consumption/start/commit crash boundaries. |
| C4 — signed channel ingress and exact request delivery         | After C1+C2; may develop independently of C3 behind a disabled composition binding. Implement channel-neutral verification/mapping plus local signed-webhook test adapter at a host edge. No new package/dependency unless existing composition cannot contain it. | `HITL-C4 replayed_or_forged_approval_cannot_resume`; `HITL-C4 ingress_crash_before_append_requires_redelivery`; `HITL-C4 durable_decision_before_ack_redelivery_is_idempotent`; `HITL-C4 channel_identity_cannot_choose_principal`; `HITL-C4 approval_delivery_discloses_bound_request_only`; `HITL-C4 secrets_never_reach_argv_logs_or_journal` | Offline signed fixtures cover tamper, wrong tenant, stale timestamp, unknown/rotated/revoked key, oversized body, mapping removal, widened scope and conflicting ids. Instrument ports to prove zero grants/effects for rejection. Delivery retry references one request; no ambient state leaks.                                                                                           |
| C5 — first production channel and end-to-end acceptance        | After C3+C4 and Benjamin's channel/entitlement/timeout choices. Bind ports only at trusted bootstrap; Slack adapter only if selected. Check current primary protocol docs then; no live channel traffic required by this planning task.                            | `HITL-C5 channel_approve_deny_timeout_cancel_restart_contract`; `HITL-C5 delivery_failure_keeps_wait_and_consumes_no_execution_slot`; `HITL-C5 uncertain_effect_retains_hold_until_reconciled`                                                                                                                                                   | Fake channel plus real journals/host proves draft → exact display → days of injected time/restart → approve or deny → gated continuation. Document installation mapping, key rotation, retry/ACK behavior and operator inspection/cancellation. Live smoke requires explicit authorized destination; rollout is opt-in.                                                                     |
| C6 — isolation and recurring-finding regression checks         | After C1; can develop alongside C2–C4, must merge before C5 activation. Preserve dependency/clock/secret boundaries and benchmark wire contracts.                                                                                                                  | `HITL-C6 benchmark_routes_omit_hitl_guardrails_and_shuffle`; `HITL-C6 runtime_and_gateway_import_no_channel_adapter`; extend `checks/test/checks.test.mjs` red fixtures if a repeated finding is structural                                                                                                                                      | Existing reference/provider wire tests plus a hostile HITL configuration show no approval envelope, production guardrail questions, shuffling, keys or resume hooks on benchmark routes. Repeated review defects become a focused lint or behavioral regression test. No benchmark corpus, held-out check, threshold or route is weakened.                                                  |

C2 and C4 share a frozen contract, not code generation authority. C4 cannot
activate before C2's durability guarantee. C3/C4 join at C5; C6 is a release
gate. Independent review of adversarial cases should precede implementation;
reserve held-out cases before any later comparative benchmark. This task does
not run benchmarks or send any corpus to a hosted model.

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

| Question                                                                                         | Recommendation                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which channel first: signed webhook for an existing operator surface, Slack, or another channel? | Prove the generic signed-webhook contract locally, then choose Slack only if it is the actual operator workflow. Do not make Slack identity or payloads a Loom type.                                                                                    |
| Who is entitled to approve, and is self-approval or multiple approval required?                  | Start with explicitly mapped project approvers and one entitled principal within a configured maximum delegable scope. No membership/name inference. Require a separate contract revision if quorum/separation of duties is needed.                     |
| What timeout and escalation should operators expect?                                             | Make the deadline explicit per request, with a configurable default; recommend 24 hours initially, expiry plus bounded notification, no automatic approve or execution. Escalation may notify an already entitled alternate without extending validity. |
| Which actions justify a long wait, and how much exact draft content may leave the host?          | Start with publication of a bounded draft to one target. Disclose only that request to an allowed destination; use a trusted operator surface when content cannot safely leave. Choose retention requirements explicitly.                               |
| Can cancellation/denial end the goal or only this action?                                        | Settle this request and keep goal outcome separate; let the operator explicitly stop the goal. Show committed/uncertain effects honestly when cancellation arrives late.                                                                                |

### B. Architectural and code-health questions

| Question                                                                           | Recommendation                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend publication records or add a generic wait service?                          | Use version-2 approval request/decision records and a journal-derived wait projection, with publication as the first consumer. Reuse operating-process transitions, not a second scheduler.                                                                                                        |
| Where is the current authority ceiling recorded?                                   | Define an injected deterministic authority lookup and explicit maximum delegable scope in the contract. Existing `Goal.authority` and M1 publication exception do not establish a general remote-approval ceiling. Freeze that distinction before code; preserve D2 tier ceiling independently.    |
| How to coordinate recovery and two resumers?                                       | One exclusive, fenced local journal writer; reject unknown/live competing owners. Keep ownership mechanics at storage/bootstrap. Defer multi-host ownership rather than suggest optimistic in-memory dedupe solves it.                                                                             |
| Reuse FabricStore or FileAttemptJournal directly?                                  | Reuse their tested durability mechanics where coherent, but keep Loom observation records separate from invocation/attempt domains. `FileAttemptJournal` is explicitly not a lock; do not make it one by assertion. Avoid a storage framework or new dependency without evidence of need.          |
| Hold effect locks during the wait?                                                 | Release before the wait; reacquire and revalidate on dispatch. Preserve uncertain invocation holds. Add durable held-wait support only for a concrete action that cannot use revision checks.                                                                                                      |
| What if a consumption/start exists but host execution is unconfirmed?              | Reconcile the existing invocation within finite allowance; fail closed if evidence is unavailable. Never replay a consumed approval or grant to improve liveness.                                                                                                                                  |
| How to keep gateway and runtime pure?                                              | Deterministic transition/binding logic takes explicit records/ports; filesystem/network, signing, secrets and timers stay in storage or trusted composition. No adapter, SDK or protocol import in Loom/gateway; no Loom scheduling import in Fabric. Keep ambient-clock/env/import checks intact. |
| How to connect waiting workstreams without adopting the recursive-thread proposal? | Store optional existing workstream/process identifiers and projection evidence; reconstruct `operating.process@1` waiting/woke transitions. Add no execution-claim or result-reference implementation under this parent.                                                                           |
| How to prevent repeated review regressions?                                        | Make each repeated finding a narrow test or lint: binding drift, scope extension, grant reuse, ACK-before-persist, ambient time, secret disclosure and benchmark wire contamination. Never relax validation or held-out evidence to make green.                                                    |

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

Inventory was checked by reading source and existing tests at the baseline
above, including VISION.md, GLOSSARY.md and AGENTS.md before design decisions.
No implementation code, test, schema or glossary change was generated.

Initial `npm run fmt:check` and `npm run verify` both stopped at
`sh: 1: vp: not found` because this worktree had no dependencies. Dependencies
were then restored with `npm ci --offline --no-audit --no-fund` from the local
cache, without network access or tracked manifest/lockfile changes.
Final `npm run fmt:check` passes with PLAN.md included. `npm run check` also
passes, including import direction, ambient clock/entropy/environment and
swallowed-failure checks.

The full `npm run verify` was attempted under the default Node 20.19.2 and then
under the available supported Node 22.23.4 by prepending
`/home/box/.local/node22/bin` to PATH. The Node 20 run stops at quoted test-glob
handling. With Node 22, formatting and `check` pass, but `test:checks` fails in
`checks/test/checks.test.mjs`: fixture child launches are denied by the sandbox.
A direct reproduction with `spawnSync(process.execPath, ...)` reports
`spawnSync /home/box/.local/node22/bin/node EPERM`, status 1 and empty output;
the fixture assertions consequently see no diagnostics. Running the same
red-fixture check directly prints its expected findings. The full suite's later
stages did not run. No permissions, checks or tests were weakened or modified
to work around this blocker. Verification logs are local temporary artifacts,
not additional deliverables.

Repository evidence cannot establish deployed channel setup, approver identities,
secret provisioning, external delivery retention/ACK guarantees, storage medium
durability, or multi-host filesystem semantics. Those are explicit assumptions
to resolve in the relevant children. The repository requires Node >=22.18.0;
the supported local executable was used for the final verification attempt.

Commit was attempted with the requested message
`plan: durable async HITL approve/resume (#352)`, but `git add -- PLAN.md` failed:
`Unable to create '/workspace/weave-p7/.git/worktrees/weave-WV-352/index.lock': Read-only file system`.
PLAN.md remains uncommitted on `wv-352-durable-hitl-plan`; no push was attempted.
