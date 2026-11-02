# WV-352: durable asynchronous approval and resumption

Planning only, on `wv-352-durable-hitl-plan`. No implementation is authorized
until captain go. This document is the only tracked change. Review target:
`f7dac89` (Claude review: the admission regime was not journaled, so inert
replay diverged on post-C1 refusals and post-C5 prohibitions; refused-approval
log convention; required hold setting; held-mode request path; M5 and crash
worker approvals; pre-gate approved v1 path across activation; M1-T20 and
`load` citations). `54d55dd` is the prior review target and PLAN-only
predecessor of `f7dac89` (v1 gate placement versus load/replay, receipt clock
versus persisted ticks, recorded opener, unrouted v1 request formation,
escalation at the deadline, runtime revoke of a pending wait, and Q-PUB, closed
by D-ENG-024). `2f3f6d7` (plan7: v1 self-approval gate, deadline-equality
expiry, late revoke cases) precedes it. Keep the prior goal-scoped v2
routing, v2-aware lookup, separate notification and decision revisions,
late wait-cancel no-op and post-consumption rejections closed. The acceptance
mapping below uses
[#352](https://github.com/CrowBe/weave/issues/352)'s body as retrieved during
the plan3 pass and as summarized by the Claude review of `7446f36` (Weave
mapping, three open questions, docs child). This pass uses that inherited issue
mapping without re-reading the external issue. See Verification.

Owner lock **D-ENG-022** (Benjamin, 2026-11-02) is applied throughout: Loom's
first high-stakes action kind, `report.publish` publication, has no
self-approval. **D-ENG-024** (Benjamin, 2026-11-02) closes **Q-PUB** with
option (b): C1 lands code/tests for the live v1 start/queue/request publication
gate, but production activation joins C5's release; C5 removes the temporary
hold. Standing-write-only publication remains available until that activation.
Live v1 _approval_ refusal activates immediately in C1. Both decisions are
locked; see "Separation of duties" and the owner evidence cited there.

Inventory baseline: source inventory at `2f3f6d7`; `f7dac89` (HEAD for this
pass) differs only in PLAN.md (`git diff --stat 2f3f6d7..f7dac89`). Only PLAN.md
differs from the former `e4dc5e16bf8d1ad25d18c9d7041066a9fa982883` baseline;
relevant source and tests were rechecked at `f7dac89`. Names explicitly marked
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

| Concern                               | Exact files and symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Existing behavior and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval records                      | [types.ts](packages/weave/src/types.ts): `ApprovalRequestedPayload`, `ApprovalDecidedPayload`, `ApprovalRecord`, `ApprovalDecisionKind`, `ObservationInput`                                                                                                                                                                                                                                                                                                                                                                                                      | Observation envelopes have `payload_type` and `payload_version`; the runtime writes approval payload version 1. Requests bind publication-specific digests, destination, expected revision, resource read set, effects, reservation and validity ticks. Decisions carry a claimed principal as a bare string (there is no code type named `Principal`) and authority revision. There is no channel identity proof or durable resume ownership.                                                                                                                                                              |
| Request formation and decisions       | [runtime.ts](packages/weave/src/runtime.ts): `Runtime.requestApprovals`, `Runtime.decide`, `Runtime.stillAuthorized`, `Runtime.issueGrant`                                                                                                                                                                                                                                                                                                                                                                                                                       | Requests are specific to `report.publish`, use `apr:${candidate_id}`, and expire at current tick + 10. An existing request prevents another with that id. `decide` uses operator ingress, not remote authentication. `Runtime.dispatch` calls `issueGrant` before appending `action.started@1` or `action.queued@1`, embedding the live grant in the payload. The v2 plan intentionally reverses issuance/persist order.                                                                                                                                                                                    |
| Approval policy                       | [candidates.ts](packages/weave/src/candidates.ts): `publishEligibility`, `bindingDigest`, `matchingApproval`, `approvalStillValid`                                                                                                                                                                                                                                                                                                                                                                                                                               | Digest covers inputs and effects. `matchingApproval` searches every `state.approvals` entry by binding digest/destination; approved status and inclusive validity tick can permit publication, as can standing destination write authority. `Runtime.stillAuthorized` reforms candidates using that policy. No external entitlement/current principal revision check or maximum delegable scope exists here. V2 records must fold separately, and a routed goal's publication must never dispatch through this v1 route in any wait status.                                                                 |
| Recovery lookup authorization         | [runtime.ts](packages/weave/src/runtime.ts): `Runtime.reconcileStep`, `Runtime.grantForLookup`, `Runtime.lookupAuthorized`; [host.ts](packages/agentfabric/src/host.ts): `AgentFabricHost.lookup`                                                                                                                                                                                                                                                                                                                                                                | `reconcileStep` calls `grantForLookup`, which, with a `GrantAuthority`, issues a fresh grant carrying the action's permissions only if `lookupAuthorized` passes. For `report.publish` that check is v1-only: standing write or `matchingApproval` plus `approvalStillValid`. `AgentFabricHost.lookup` requires an issued, valid grant that covers the contract permissions; it does not `markInvoked`. The lookup grant therefore has execution-capable scope and stays valid after lookup. C3c replaces this check for v2 starts.                                                                         |
| Validation and folding                | [validation.ts](packages/weave/src/validation.ts): `EXPECTED_SOURCE`, `validate`, `validateApprovalRequest`, `validateApprovalDecision`; [state.ts](packages/weave/src/state.ts): `applyAccepted`, `expireApprovals`, `readSetMatches`                                                                                                                                                                                                                                                                                                                           | `validate` rejects every `payload_version !== 1` before type-specific parsing. It checks privileged provenance, request existence/status and basic fields, not webhook authentication or principal entitlement. Request shape checks are partial; decision scope can extend expiry. `applyAccepted` dispatches by payload type alone. V1 ticks implicitly expire pending/approved requests only at `tick > valid_until_tick`; equality is valid. V1 revoked/expired decisions can overwrite approved status. C1 adds shared type/version dispatch and a separate v2 projection without changing v1 history. |
| Trusted ingress                       | [runtime.ts](packages/weave/src/runtime.ts): `IngressHandle`, `Runtime.observe`, `Runtime.operator`, `Runtime.clock`, `Runtime.appendStep`, `Runtime.admitStep`                                                                                                                                                                                                                                                                                                                                                                                                  | Untrusted observations cannot claim privileged provenance. Accepted observations persist before state application and cycle triggering. Handles are in-process bootstrap authority; strings naming an operator are not credentials. Only accepted observations go to `ObservationJournal`, so rejected-input diagnostics are not a durable security inbox.                                                                                                                                                                                                                                                  |
| `ask_user` and intake                 | [sites/index.ts](packages/weave/src/sites/index.ts): `SITE_POLICY`, `IntakeState`, `SiteObservation`, `transitionSite`, `evaluateSite`; [sites/CONTRACT.md](packages/weave/src/sites/CONTRACT.md)                                                                                                                                                                                                                                                                                                                                                                | `intake.classify` proposes `new_thread`, `continue_thread`, `queue`, `steer`, `interrupt`, `stop`. Low confidence returns `ask_user` / `needs_human` in `decision-site@1`; it creates neither approval authority nor a durable human wait. A classification answer cannot approve an action.                                                                                                                                                                                                                                                                                                                |
| Input routing                         | [input-route.ts](packages/weave/src/input-route.ts): `decideRoute`, `applyRoute`; [workstream.ts](packages/weave/src/workstream.ts): `Workstream`, `WorkstreamEvent`, `WORKSTREAM_SCHEMA`                                                                                                                                                                                                                                                                                                                                                                        | Input routing and pure `workstream@1` transitions exist independently of intake classification. External approval commands must use a typed ingress path, not natural-language classification or inferred operator intent.                                                                                                                                                                                                                                                                                                                                                                                  |
| Waiting actions and wait observations | [types.ts](packages/weave/src/types.ts): `ActionState`, `CycleOutcome`, `PAYLOAD_TYPES`; [runtime.ts](packages/weave/src/runtime.ts): `Runtime.runCycle`, `Runtime.drainQueue`                                                                                                                                                                                                                                                                                                                                                                                   | `ActionState` has pending/running/terminal/uncertain states, with no suspended human-wait action. Cycle `waiting` describes in-flight work; publication awaiting approval is a blocked outcome. `PAYLOAD_TYPES` contains `action.queued` as well as `clock.tick`, approval and cancellation observations. `action.queued` folds the existing start-shaped payload to pending with its grant and reservation; no generic durable `wait.*` observation exists. A returned `waiting` outcome is not itself a durable wait record.                                                                              |
| Operating process                     | [operating-process.ts](packages/weave/src/operating-process.ts): `PROCESS_SCHEMA`, `OperatingProcess`, `WaitReason`, `ResumePoint`, `transitionProcess`                                                                                                                                                                                                                                                                                                                                                                                                          | Pure `operating.process@1` transitions support `waiting` on approval/capability/dependency, `woke`, and pause/resume by opaque ref plus digest. They do not journal a bound request, authenticate a decision, issue authority, or wire recovery to publication. Reuse these semantics where a workstream is attached; do not equate waiting with paused.                                                                                                                                                                                                                                                    |
| Observation durability and recovery   | [journal.ts](packages/weave/src/journal.ts): `ObservationJournal`, `MemoryJournal`, `FileJournal`, `PersistError`; [runtime.ts](packages/weave/src/runtime.ts): `Runtime.load`, `Runtime.reconcile`, `replay`, `recover`                                                                                                                                                                                                                                                                                                                                         | `FileJournal` appends JSONL and `snapshot` parses each nonempty line as JSON; it lacks fsync, torn-tail repair and writer fencing. `Runtime.load` checks increasing seqs, then trusts stored accepted validation and folds/indexes without a payload-version check. Thus a legacy loader could interpret v2 as v1. C1 requires version preflight; C2 uses a distinct owned format/path that this JSONL reader refuses. `recover` loads/reconciles actions, not every approved wait. Existing APIs do not establish arbitrary crash durability, tamper protection or two-resumer exclusion.                  |
| Other durable records                 | [implement-step.ts](packages/weave/src/implement-step.ts): `FileAttemptJournal`, `MemoryAttemptJournal`, `AttemptJournal`, `repairTornTail`; [audit-loop.ts](packages/weave/src/audit-loop.ts): `AuditJournal`, `MemoryAuditJournal`, `AuditCheckpoint`                                                                                                                                                                                                                                                                                                          | Attempt journals use `impl.attempt@1` / `impl.stop@1`, sync appends and new directory entries, repair tails, deduplicate ids and detect some foreign writes. Their own contract requires one writer; detection is not a lock. Audit checkpoints are a different contract. Reuse proven mechanics/tests where appropriate, not these domain records as human waits.                                                                                                                                                                                                                                          |
| Effect locks and host durability      | [scheduler.ts](packages/weave/src/scheduler.ts): `select`, `rejectReason`; [coordinator.ts](packages/agentfabric/src/coordinator.ts): `ResourceCoordinator.acquire`, `restore`, `release`; [store.ts](packages/agentfabric/src/store.ts): `FabricStore`, `InvocationRecord`; [host.ts](packages/agentfabric/src/host.ts): `AgentFabricHost.prepare`, `lookup`, `reconcile`                                                                                                                                                                                       | Scheduler reserves effects for pending/running/unreconciled uncertain actions. Fabric enforces canonical-resource locks and durably records invocation reservations; uncertain writes retain holds until reconciliation. `FabricStore` has path-backed writer locking, mutation validation, tail handling and replay. Its lock is not a Loom journal lock, and Fabric must not gain knowledge of goals, approval waits or scheduling.                                                                                                                                                                       |
| Grants and revocation                 | [grants.ts](packages/agentsop/src/grants.ts): `Grant`, `GrantAuthority`, `createGrantAuthority`, `grantCovers`; [host.ts](packages/agentfabric/src/host.ts): `validateInvocation`, `prepare`, `invalidGrantReason`                                                                                                                                                                                                                                                                                                                                               | Issuance is object identity; serialized field-equal grants are not issued. `markInvoked` consumes a grant for invocation; revocation blocks further validity. Host invocation records supply durable outcome identity across restart. Never restore a serialized grant as executable authority or re-use a consumed grant.                                                                                                                                                                                                                                                                                  |
| Budget and ceiling gates              | [scheduler.ts](packages/weave/src/scheduler.ts): `select`; [state.ts](packages/weave/src/state.ts): `applyAccepted`; [sites/index.ts](packages/weave/src/sites/index.ts): `transitionSite`; [implement-step.ts](packages/weave/src/implement-step.ts): `ImplementStepInput.ceiling`; [budget.ts](packages/gateway/src/budget.ts): `BUDGET_POLICY`, `budgetRoute`; [gateway.ts](packages/gateway/src/gateway.ts): `GatewayConfig`, `createInferenceGateway`; [implement-step.ts](packages/weave/src/implement-step.ts): `ImplementPorts`, `runImplementationStep` | Goal actions/judgments reserve and settle in Loom; gateway dispatch has cost/quota gates and injected quota/time ports; D2 `loop.route` and `ImplementStepInput.ceiling` bound tier separately. These are distinct constraints. A loop pause/reset time is permission to recheck, never a budget refill.                                                                                                                                                                                                                                                                                                    |
| Operator disclosure                   | [read-port.ts](packages/loom-binding/src/read-port.ts): `openReadPort`, `approvalsOf`, `LoomRead`; [view.ts](packages/tapestry/src/view.ts): `DisclosedApproval`; [vocabulary.ts](packages/tapestry/src/vocabulary.ts): `VOCABULARY`; [tree.ts](packages/tapestry/src/tree.ts): `resolveTree`                                                                                                                                                                                                                                                                    | Pending approvals disclose metadata/digests/effects/reservation through a bounded view. Approval submission is declared unbound; the tree marks decisions unavailable. This is not an authenticated remote decision binding, and digests alone do not show a human the action content.                                                                                                                                                                                                                                                                                                                      |
| Time, purity and benchmarks           | [types.ts](packages/gateway/src/types.ts): `Clock`, `Timer`; [boolean.ts](packages/weave/src/sites/boolean.ts): `INPUT_RULES`, `OUTPUT_RULE`, `transitionBooleanSite`; [typesafe-ai.ts](packages/gateway/src/adapters/typesafe-ai.ts): `typesafeWire`, `typesafeWireProfile`; [providers.ts](benchmarks/decision-sites/providers.ts)                                                                                                                                                                                                                             | Time/waiting are injected ports; Loom receives `clock.tick`. Production guard judgments are observations. Direct benchmark routes deliberately omit production gateway policy and shuffling; `typesafeWire` fixes `shuffle: false`. HITL must not become a shared inference-adapter wrapper.                                                                                                                                                                                                                                                                                                                |

Existing behavioral evidence to preserve, with the live v1 publication
hardening described under D-ENG-022:

- [m1.test.ts](packages/weave/test/m1.test.ts): M1-T01 approval then one
  publication (HEAD permits the legacy self-approval this plan closes);
  T02 denial/expiry/silence; T03 forged origin; T05 revoked queued
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
replay semantics or silently upgrade old approvals into remote authority.
Live v1 publication admission is hardened as specified under D-ENG-022 and
D-ENG-024 (approval refusal at C1, full gate activation at C5);
historical validity does not authorize a new start.

C1 first freezes the contract and reviewed fixtures, then implements the
parsers/folds in the same child after that acceptance checkpoint. Keep contract
review separate from code admission; do not merge a fixture-only PR with failing
checks. Replace [validation.ts](packages/weave/src/validation.ts)'s global
`validate` version-1 gate with an explicit supported-version table shared by
admission and [runtime.ts](packages/weave/src/runtime.ts)'s `Runtime.load`:

| Payload type                                                      | Supported versions and fold                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `approval.requested`, `approval.decided`                          | 1: existing approval fold; 2: separate v2 wait projection.                                                      |
| `clock.tick`                                                      | 1: existing logical clock/implicit v1 expiry; 2: separate v2 receipt/deadline clock, explicit settlements only. |
| `action.started`                                                  | 1: existing start; 2: atomic v2 consumption/start.                                                              |
| `approval.escalated` (proposed)                                   | 1: v2 wait notification evidence only.                                                                          |
| `approval.route` (proposed)                                       | 1: goal-scoped, irrevocable v2 publication routing; folds into a separate route projection.                     |
| `publication.admission` (proposed)                                | 1: journal-scoped, monotonic live v1 publication admission regime; folds into a regime projection.              |
| Every other HEAD `PAYLOAD_TYPES` entry, including `action.queued` | 1 only, existing semantics. C1 enumerates these entries explicitly; no wildcard or default version fallback.    |

Select parser, transition validation, fold and indexes by `(payload_type,
payload_version)`, including replay and recovery. At HEAD, `Runtime.load`
checks only that seqs increase; it then trusts each record's stored
`validation.status` and applies accepted records with `applyAccepted` and
`indexApprovalRequest`. C1 adds a **proposed** `load` preflight: before any
log/index/state mutation it checks the whole input for supported
types/versions, then validates each accepted record under the historical
contract/transition rules selected by the admission regime and route recorded
before it (see "Separation of duties"). Stored `validation: accepted` is
insufficient. Unknown versions fail closed,
never fall through to v1 `applyAccepted` or `indexApprovalRequest`. Historical
replay verifies recorded evidence without contacting live authentication ports.
`HITL-C1 load_refuses_unknown_payload_version_instead_of_v1_fold` pins this
failure and leaves the prior state/indexes unchanged.

**Historical transition validation and live admission are separate functions**
(D-ENG-021). At HEAD one `validate` serves both: `Runtime.appendStep` calls
it for every append, and `replay` re-feeds recorded external records through
`Runtime.feed` into that same `appendStep`. The proposed C1 `load` preflight
reuses the historical rules. So the D-ENG-022 v1 refusals below are a
**proposed** pure admission predicate, `liveV1PublicationRefusal`, and never
part of `validate`, `validateApprovalRequest`, `validateApprovalDecision` or the
transition rules `load` runs. It takes the **journaled admission regime**
(proposed `publication.admission@1`, below) as an argument and never reads a
live option. With no recorded regime it refuses nothing, so pre-gate v1
approval, start and queue records keep loading, folding, indexing and
replaying under HEAD's rules. See "Separation of duties" for where the
predicate runs and how replay reproduces both pre-gate and post-gate traces.

V2 requests/decisions **never enter `state.approvals`**. That map remains v1-only;
[candidates.ts](packages/weave/src/candidates.ts)'s `matchingApproval`,
`approvalStillValid`, `publishEligibility` and
[runtime.ts](packages/weave/src/runtime.ts)'s `Runtime.stillAuthorized` cannot
derive v1 authority from a v2 wait.

**V2 management is a durable routing property of the goal, not of a wait.**
At HEAD, `publishEligibility` returns `allowed` for standing destination write
authority or any approved, unexpired `matchingApproval`, whatever the candidate's
history. A rule that applies only while a v2 wait is open therefore lets a
denied, cancelled, expired or invalidated candidate, or one in the gap between
replacement closure and the new opening, fall back to `action.started@1`
without the distinct-principal approval D-ENG-022 requires. Architectural
recommendation for C1:

- **Proposed** `approval.route@1` `{ goal_id, operation: "report.publish",
  route: "approval-v2", policy_id, policy_revision, opener_principal,
  opener_mapping_revision }` is admitted only from `operator` provenance (the
  trusted HITL bootstrap, as for `goal.opened@1` in `EXPECTED_SOURCE`) while the
  goal is active. `examples/hitl.ts` appends it immediately after opening a goal,
  before publication candidate formation. Any earlier cycle in the opted-in
  Runtime blocks publication until routing. It pins the goal opener, a fixed
  historical fact,
  from the injected authority lookup at routing time (see "Separation of
  duties"); an unverified opener refuses routing. An identical retry is
  idempotent; a conflicting record, including a different opener, is rejected.
  No record removes or downgrades a route, so a routed goal stays routed through every wait status, replacement
  gap, restart and terminal outcome. `load` rebuilds the route projection
  before forming candidates.
- For a routed goal, `report.publish` eligibility is `{ status:
  "approval_required", policy: "publication-v2" }` after the existing read-authority
  check, whatever standing write authority or `state.approvals` contain. That
  reuses the existing `Eligibility` union. Every v1 route already gates on
  `allowed`: `Runtime.runCycleOnce`'s `eligible` filter, `Runtime.dispatch` via
  `Runtime.stillAuthorized`, and `Runtime.drainQueue`, which turns a pre-route
  queued publication into its existing stale-authority `action.cancel_requested@1`.
  So none of them can start a routed publication. At HEAD
  `Runtime.requestApprovals` forms an `approval.requested@1` for **any**
  `approval_required` candidate and never reads `policy`. C1 therefore adds a
  `policy === "publication"` filter there, so a `publication-v2` candidate cannot
  form a v1 request. Validation refuses `approval.requested@1` and
  `approval.decided@1` for a routed goal's publication as a backstop, so
  `Runtime.decide` cannot mint a v1 approval after routing. This route check
  belongs in the historical validator: no routed goal predates C1, and pre-route
  records are validated against the pre-route state in which they were folded.
  Pre-route v1 approval records stay in history and confer nothing. Standing write authority
  remains part of current goal authority checked at the C3c gates; it is never
  sufficient on its own.
- Only C3c's `action.started@2`, consuming an approved v2 wait, can start a
  routed publication. A terminal wait leaves the candidate blocked until a new,
  authorized v2 opening.
- An opted-in Runtime refuses to form publication candidates for an active goal
  that has no route record (fail closed). A v1-only Runtime that loads a journal
  containing `approval.route@1` refuses it under the C1 version table. Legacy
  goals keep their v1 history and are not upgraded silently. C1 refuses every
  new live v1 publication approval. Its live start/queue/request gate for
  unrouted goals refuses new v1 requests, queues and starts until trusted
  composition explicitly routes the goal and obtains a v2 approval; when that
  gate activates is locked by **D-ENG-024**: C5's release removes the temporary
  hold. The immediate approval refusal and routed-goal enforcement remain
  independent of that hold. Neither gate is controlled by the HITL feature
  flag, so disabling HITL cannot restore self-approval or bypass the activated
  gate. C5 activates the full gate with the usable v2 path.

C3a proves that an approved v2 fixture cannot escape through v1
start/queue/grant issuance while v2 dispatch is disabled. Its restart cases
seed standing write authority on the destination plus a pre-route approved
v1 request that matches the binding digest/destination, for each terminal v2
outcome (denied, cancelled, expired, invalidated) and the replacement gap. After
kill/reopen and cycles at zero and free capacity, and after `Runtime.reconcile`,
none of them produces `approval.requested@1`, `action.started@1`,
`action.queued@1`, an issued grant or an invocation. A negative control that
removes the route record must now hit C1's legacy-publication gate (the test
Runtime records the `active` admission regime ahead of C5 activation under
D-ENG-024). A mutation
disabling both that gate and goal-route enforcement restores HEAD's v1 dispatch,
so the guards are sensitive to the bypass. This closes the eligibility, request and
queue routes as well as forbidding v2 queue references.

### Bound request and durable wait

**Proposed** `approval.requested` payload version 2 is one atomic opening record.
It contains both the bound request and its durable wait; there is no separate
request/write-wait gap. The wait is a projection of the observation log, not a
second mutable database. Required fields:

- Deterministically derived `request_id`, `wait_id`, initial decision and notification revisions, project/goal identity,
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
is rejected. Under the fenced writer, refuse a new opening while any pending or
approved v2 wait exists for the same `(goal_id, candidate_id, execution binding
digest)` in the project. Rebuild that uniqueness index on load before request
formation/redrive or notification; return the existing wait for an identical
retry. A consumed binding is not a reason to re-request or repeat the action:
reconcile its action instead. After denial/expiry/invalidation a newly authorized
request uses a new opening sequence, even for the same candidate and binding.
It cannot reopen
the old request. Replay derives ids from records, never ambient entropy/time.
A wait carries two revisions, and C1 freezes both. Architectural
recommendation: keep notification out of decision concurrency.

- The **decision revision** is the sequence of the last accepted record that
  changes what a decision acts on: opening, `approval.decided@2` (authenticated
  decision or runtime-policy settlement) or `action.started@2` consumption. Every
  delivered approve/deny/cancel/revoke control binds request/wait id and this
  revision. Decisions and settlements compare it under ownership before append.
- The **notification revision** is the sequence of the last `approval.escalated@1`
  for the wait, or the opening if none. It serializes escalation records only,
  and no decision compares it.

Escalation cannot change the binding, presentation, deadline or entitled set
(those require a replacement request). So it advances only the notification
revision, and controls delivered before it stay valid without any refresh or
redelivery protocol. Escalation recipients receive controls bound to the same
decision revision. Delivery status and clock ticks change neither revision. An
idempotent redelivery returns its original result before either comparison.
A decision that carries an earlier decision revision is genuinely stale: for
example, a cancel control issued before another principal's approval, or a
control for a request closed by replacement. It is refused before append. The
first path counts one entitled approver; a future quorum must state in its own
C1 amendment whether partial approvals advance the decision revision.

### One persisted clock contract

Architectural recommendation for C1: introduce **proposed**
`clock.tick@2` with a strictly increasing v2-only `tick`, `time_domain =
"unix-epoch-ms"`, `time_version = 1`, and a nonnegative safe-integer `time_ms`.
The injected trusted clock supplies this monotonic reading: `time_ms` must be
nondecreasing against the last persisted v2 reading, including across restart.
The domain has the fixed Unix UTC epoch and millisecond unit; logical ticks do
not convert to elapsed time and their frequency cannot change a deadline.
V2 readings update only the v2 clock projection: they never change v1
`state.clock.tick`, call v1 `expireApprovals` or advance inference tick deadlines
([runtime.ts](packages/weave/src/runtime.ts): `Runtime.weighAndSelect` /
`Runtime.frameGoal`).
Reject missing/regressing readings and unknown domains/versions; never clamp a
regression into apparent freshness. A v1 tick supplies no v2 time evidence.
Without a new valid v2 reading, opening, accepting a decision and resuming are
blocked. Historical replay uses only the persisted readings.

A request deadline is a safe-integer `deadline_ms` in that same domain and
version, strictly greater than opening `time_ms`. V2 validity is half-open:
`opening_time_ms <= current.time_ms < effective_deadline_ms`, with a decision
allowed only to narrow the deadline. At equality or later, expiry wins. This is
a deliberate v2 difference: the v1 historical fold remains valid at `tick == valid_until_tick` and
expires only at `tick > valid_until_tick`, with its implicit fold unchanged.

Trusted composition persists v2 clock readings at startup, trusted timeout
evaluation and immediately before consumption. Two readings are named here and
used consistently below:

- The **receipt reading** `t1` is an unpersisted trusted reading captured at
  ingress before writer access. It is freshness evidence only. Verify bounded
  raw bytes/signature, endpoint/tenant, mapping, entitlement, command shape,
  expected decision revision and deadline before writing. The versioned
  verification policy carries finite `max_age_ms` and `max_future_skew_ms`;
  accept signed timestamps only when
  `-max_future_skew_ms <= t1 - signed_timestamp_ms <= max_age_ms`. The skew
  allowance tolerates sender clocks ahead of the receiver without moving Loom
  time. The skew window is checked once, against `t1`, at ingress.
- The **decision reading** `now` is a new trusted reading taken under journal
  ownership, satisfying `now >= max(t1, last persisted v2 time_ms)`. A timer
  evaluation or startup tick may persist `t2 > t1` between ingress and
  ownership. Persisting `t1` would then be a rejected regression, and checking
  the deadline against `t1` would ignore a persisted `t2 >= deadline`, so
  neither is allowed. If the trusted clock cannot supply such a `now`, the
  command is refused without ACK and without any append, and the channel
  redelivers. This is a retryable refusal, not a terminal one.

Under ownership, recheck the command against current state and evaluate the
deadline with `now`. If due, the separate trusted timeout evaluation persists
`now` as `clock.tick@2`, then appends expiry referencing that persisted reading;
it accepts no competing decision. Otherwise persist `now` as `clock.tick@2`
immediately before the accepted decision. The decision references that clock seq/time and also carries `t1` as
`receipt_time_ms` evidence. Both appends must be durable before ACK/wake.
`HITL-C3b receipt_reading_older_than_persisted_tick_neither_regresses_nor_misses_expiry`
uses a barrier that interleaves a persisted timer tick between ingress and
ownership: before the deadline the decision is accepted at `now` with no
regression, and at or past the deadline expiry is appended and the decision is
refused.
Under the same ownership, trusted timeout evaluation uses `now` to
append any due runtime-policy expiry before accepting **any** authenticated
decision (approve, deny, cancel or revoke), escalation or start. At
`time_ms >= effective_deadline_ms`, settle the pending/approved wait as expired
and refuse the competing decision/start, even without a timer callback and after
restart. Authenticate and validate shape/entitlement first; a rejected command
does not itself append a clock or settlement. Due expiry is a separate trusted
evaluation, not acceptance of that command. If its append fails, no decision or
start is accepted. Consumed waits are excluded from due settlement.
If a crash leaves only the clock append, it authorizes nothing; redelivery
reverifies, takes a fresh `now` against the new persisted maximum, and the
decision is still required. Same-id identical redelivery
returns the original acceptance without another clock append after successful
authentication. Rejected/forged/unauthorized/stale ingress writes **no record**
and changes neither clock; due expiry is handled by a separate trusted timeout
evaluation or pre-start settlement, not by a rejected command. Bound ingress
rate/body size and accepted-event rate at the composition edge before writer
access, and coalesce trusted timer evaluations. Timer callbacks only request an
observation. Payload timestamps never advance Loom's clock. C3 and C4 share
this port/evidence; unavailable trustworthy time refuses progress.

Clock regression after restart fails closed for v2 opening, decisions and
resumption, with an operator-visible `clock_regression` diagnostic carrying the
last persisted seq/time and observed trusted time through an injected diagnostic
port, outside the journal and without payload/secrets. Recovery procedure:
inspect/fix the trusted clock source (or wait for it to catch up), then retry
with a reading at least the persisted value. Never reset the epoch/deadlines,
rewrite the journal or clamp time to bypass the check. C3a tests regression,
diagnostic and recovery with injected readings across reopen; v1 time is intact.

The human and external channel see **this bound request only**. They receive no
ambient state dump, transcript, nearby artifacts, unrelated approvals, secret
material, budget credentials or grant objects. Disclosure policy independently
authorizes content and destination before notification; approver entitlement
does not imply disclosure permission. If safe display cannot show the exact
action, withhold external delivery and require an entitled operator surface.
Record delivery ids/status separately so delivery retries never open more waits.

### Authenticated decision and principal mapping

**Proposed** `approval.decided@2` is a strict union discriminated by `origin`.
All variants bind request/wait id and expected decision revision, full execution and
presentation digests, decision and causal evidence. Reject fields belonging to
another variant, unknown versions and extra authority claims:

- `origin = channel`: authenticated `approved`/`denied`/`revoked`/`cancelled` only, with verified
  principal, authority revision, ingress event id, adapter and installation/tenant,
  decision evidence ref, decision clock seq/time (the persisted `now`),
  `receipt_time_ms` (`t1`) and identity-mapping/policy revisions. It cannot
  assert `expired` or runtime invalidation.
- `origin = operator`: authenticated local `approved`/`denied`/`revoked`/`cancelled` only, with
  principal, authority revision, trusted ingress command id, local identity
  configuration revision, decision evidence, decision clock seq/time and
  `receipt_time_ms`. It has
  no invented channel tenant or signature fields. Optional scope in either
  authenticated variant may only narrow the bound scope/deadline.
- `origin = runtime_policy`: `expired`/`revoked`/`invalidated` only, with policy
  id/revision, effective deadline, causing persisted v2 tick seq and reason/cause
  evidence (including authority/resource revisions as applicable). It has no
  principal, identity-mapping revision, ingress event id or channel fields.
  Runtime revocation/invalidation must cite the policy evidence that caused it;
  a tick alone is not authority to revoke. Runtime-policy `revoked` applies only
  to an approved, unconsumed wait; a pending wait that loses authority uses
  `invalidated`. One cause therefore has one terminal meaning per wait status.
  `HITL-C1 runtime_policy_revoke_of_pending_wait_is_rejected` pins it.

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

### Separation of duties (D-ENG-022, closed)

**Owner decision D-ENG-022** (Benjamin, 2026-11-02; the decision is stated in
full here because the repository has no decision log): Loom's first
high-stakes action kind has no self-approval. An approving principal must differ
from (a) the principal that opened the goal and (b) the principal that
delegated the authority the action uses. Self-approval is refused. This is no
longer an open owner question, and it no longer blocks C1 acceptance.

**Q-PUB (closed: D-ENG-024, Benjamin, 2026-11-02).** Benjamin chose
**(b)**: hold C1's live v1 start/queue/request publication gate, including
standing-write-only publication, on C5's release train. Gate code and tests
still land in C1; production activation joins C5; C5 removes the temporary
hold. Live v1 **approval** refusal activates immediately in C1 under D-ENG-022.
Standing-write-only publication remains available until C5 activates the held
gate. Option (a), accepting a publication outage from C1 to C5, was not chosen.
Owner evidence: [Q-PUB answer](/workspace/decisions/owner-answers/WV-352-Q-PUB.md)
and [D-ENG-022 / D-ENG-024 decision log](/workspace/decisions/weave.md).
These are supplied external owner records, not files committed in this repo.

Concrete hold recommendation (D-ENG-021, implementing D-ENG-024): use one
**proposed temporary trusted-bootstrap setting**, a **required**
`RuntimeOptions.hold_publication_gate_until_c5: boolean` with no default, so
every composition site must choose. At HEAD `new Runtime(` appears outside
tests only in [crystallize.ts](examples/crystallize.ts) and inside
[runtime.ts](packages/weave/src/runtime.ts)'s `replay` and `recover`. C1's
production sites, `examples/crystallize.ts` and the proposed
`examples/hitl.ts`, set `true` (held). Test fixtures set it explicitly
(`m1World` and `restoreWorld` in `m1-fixture.ts`, `fixture.ts`, `m2-fixture.ts`,
`m3-fixture.ts`, `w5-fixture.ts` and the direct test constructions); the
compiler enumerates them. HITL tests exercise both values. The setting is
never read during `replay`: it only selects which regime a live Runtime
journals (below), and replay reads the recorded regime instead. `replay`'s
options type omits the field (`Omit<RuntimeOptions,
"hold_publication_gate_until_c5">`), so replay callers such as M1-T17 cannot
pass it; `recover` is live and requires it. It holds the
unrouted v1 start/queue/request gate as a whole, including its preapproved-queue
checks. It cannot disable live v1 approval refusal or routed-goal enforcement,
and is not channel input or an ambient environment flag.

While held, retain HEAD's unrouted start/queue/drain eligibility and
current-authority checks. Three paths can still start an unrouted publication:
standing-write-only publication, a historical preapproved queue, and a pre-gate
`approved` v1 decision that `matchingApproval` plus `approvalStillValid` still
accept and that has not started. The third may be a legacy self-approval;
D-ENG-024's deferral accepts this until C5, and no new v1 approval is admitted.
**Held mode keeps HEAD's v1 request formation**, as the lock requires: an
unrouted publication without standing write still gets `approval.requested@1`
from `Runtime.requestApprovals`. But every `approved` decision on it is
refused, and because the request id is `apr:${candidate_id}`, no second request
forms after the first expires. **From C1 to C5, approval-gated unrouted
publication therefore cannot complete**; only the three paths above publish.
The operator-visible outcome is pinned so the goal does not stall behind a
misleading reason. The refused decision carries `publication_requires_v2_route`
(below). While the recorded regime refuses v1 approvals, `Runtime.cycleOutcome`
no longer reports `awaiting approval for report.publish` (runtime.ts:840-842)
for an unrouted `report.publish` candidate whose eligibility
is `approval_required`/`publication`. It reports
`blocked: publication approval unavailable: publication_requires_v2_route`,
before and after the v1 request expires. `approvalsOf` still discloses the
pending request, and Tapestry's `resolveTree` already marks its decision
`unavailable`. `HITL-C1 held_mode_unrouted_approval_path_reports_v2_route_required`
pins this outcome.

This is the temporary activation deferral D-ENG-024 chose, not a new v1
approval exemption under D-ENG-022. C5 **deletes** the field so the compiler
finds every remaining use, activates the full gate at the same release
boundary as the opt-in usable v2 path, and tests restart/queued work across
that boundary. `HITL-C5 c5_activation_removes_hold_and_requires_v2_route`
asserts that `RuntimeOptions` no longer has the key and that no composition
site or fixture sets it. There is no post-C5 legacy execution switch. A routed
goal always requires v2, even during the hold and even with HITL disabled.

Principal identities at HEAD. None of the three roles has a verified principal:

| Role                | What HEAD records                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal opener         | `goal.opened@1` is admitted only from provenance kind `operator` ([validation.ts](packages/weave/src/validation.ts): `EXPECTED_SOURCE`). [runtime.ts](packages/weave/src/runtime.ts)'s `Runtime.operator` is an `IngressHandle` stamped with the constant `OPERATOR_SOURCE = { kind: 'operator', id: 'operator' }`. [types.ts](packages/weave/src/types.ts)'s `Goal` has no opener field, so every opener has the same provenance.                                |
| Authority delegator | `Goal.authority` is just `{ read, write? }` resource lists inside the operator-sourced `goal.opened` payload. It names no delegator. `AuthorityScope` (`{ goal_id } \| { policy_id }`) scopes cached conclusions, not people. [grants.ts](packages/agentsop/src/grants.ts)'s `Grant` has `action_id`, operation/contract, permissions/effects and an `issued_at` seq, but no issuer or delegating principal, and `GrantAuthority` issues by object identity.      |
| Approver            | `ApprovalDecidedPayload.principal` is a bare claimed string. `validateApprovalDecision` checks only that it is nonempty, and `applyAccepted` copies it into `ApprovalRecord.principal`. `Runtime.decide` submits through that same `Runtime.operator` handle, and M1 tests pass `principal: 'operator'`. Neither [candidates.ts](packages/weave/src/candidates.ts)'s `matchingApproval`/`approvalStillValid` nor any read port compares the approver with anyone. |

So HEAD cannot tell an approver apart from an opener or delegator.
**D-ENG-022 covers legacy v1 goals too; v1 is not exempt.** Architectural recommendation
(D-ENG-021): once the full gate activates at C5 under D-ENG-024, require
explicit v2 routing before any new publication, rather than invent verified
identities for historical v1 records. C1 immediately refuses new v1 approvals. C1 adds the
**proposed** live-admission predicate `liveV1PublicationRefusal` (see "Contract
first"). It has two parts.

- **Approval refusal (active immediately in C1 under D-ENG-022/D-ENG-024).** `Runtime.decide` and
  live `Runtime.appendStep` admission refuse
  `approval.decided@1 { decision: approved }` for a `report.publish` request
  from either `EXPECTED_SOURCE` provenance (`operator`, `runtime`). This refusal
  activates in C1 regardless of the temporary hold; it must not be deferred
  with the start/queue/request gate. **Recommendation (D-ENG-021): the refusal
  follows HEAD's rejected-observation convention.** `Runtime.appendStep`
  (runtime.ts:605-664) gives a rejected observation a seq, pushes it into the
  in-memory log and trace, records its observation id, and persists only
  accepted records to `ObservationJournal`. The refused
  `operator:approval:<request_id>:approved` record therefore consumes a seq,
  appears in the log/trace with `validation: { status: "rejected", reason:
  "publication_requires_v2_route" }`, is not persisted, folds nothing and
  triggers no cycle (`Runtime.admitStep` runs cycles only for accepted input).
  `Runtime.decide` returns it. A retry with the same id is rejected as
  `duplicate`, as at HEAD. "Refused before append" in this plan means before
  the journal append and state fold, not before seq assignment. Replay
  reproduces the rejection from the journaled regime (below).
- **Start/queue/request gate for unrouted goals (active at C5 under D-ENG-024).** The
  Runtime wraps `publishEligibility`'s result for an unrouted goal's
  `report.publish` candidate as the existing
  `{ status: "prohibited", reason: "publication_requires_v2_route" }` variant of
  the `Eligibility` union, not `approval_required`/`publication`. So
  `Runtime.requestApprovals` forms no new `approval.requested@1`.
  `Runtime.runCycleOnce`'s `eligible` filter, `Runtime.dispatch` via
  `Runtime.stillAuthorized`, and `Runtime.drainQueue` refuse before grant
  issuance, reservation or invocation. This also blocks starts relying on
  pre-gate v1 approvals; a historical queued publication takes the existing stale-authority `action.cancel_requested@1`. Standing
  write authority, restart and HITL being disabled cannot bypass it. The
  cycle's `awaiting` check (`approval_required`) no longer matches, so the
  outcome is `blocked` through `blockedReason`; C1 pins the reason text.
  Pending pre-gate v1 requests keep their v1 expiry fold. `approvalsOf` still
  discloses them, but approving one is refused, and Tapestry's tree already
  marks decisions unavailable.

Neither part is in the historical validator (finding 1 of the `54d55dd`
review). `load` accepts pre-gate v1 records, and `Runtime.reconcile` recovers
an already-started v1 publication through the unchanged v1
`Runtime.lookupAuthorized` (standing write, or `matchingApproval` plus
`approvalStillValid`). Its historical evidence is not rewritten.
**`replay`, the journaled admission regime and pre-gate journals.** Preserve
historical replay, including M1-T17 (`historical replay uses recorded contracts
after revocation`), M1-T20 (`replay reports observations beyond the recorded
log`, m1.test.ts:457, raised by `checkPrefix`) and `replay`'s separate
`missing recorded action.result` refusal for a running or pending action
(runtime.ts:2794-2797). At HEAD `replay` (runtime.ts:2754) re-feeds operator and
other non-cycle records through `Runtime.feed`/`appendStep`, regenerates cycle
records, and `checkPrefix` (runtime.ts:2833) compares the `stableStringify` of
every whole observation, including `validation` and each cycle's candidate
eligibility. Replay with HEAD's v1 rules everywhere would therefore diverge on
every post-C1 trace containing a refused approval (replay would accept it, then
form a new `approval.requested@1`) and on every post-activation unrouted
publication cycle (`approval_required` instead of
`prohibited`/`publication_requires_v2_route`). A live option cannot select the
rules either, because the hold setting is not journaled and a journal may span
the C5 boundary.

**Recommendation (D-ENG-021): journal the admission regime.** The **proposed**
`publication.admission@1 { v1_approval_refusal: true, unrouted_gate: "held" |
"active" }` is admitted only from `operator` provenance, the trusted bootstrap,
as for `goal.opened@1`. It is journal-scoped and does not require an active
goal. Before its first live append after construction or `load`, a non-replay
Runtime compares the most recent recorded regime with the one its build
requires. C1 requires `held` when `hold_publication_gate_until_c5` is true and
`active` when it is false; C5 always requires `active`. If no regime is
recorded, or the recorded regime is weaker, the Runtime first appends the
required record through its trusted operator path. Equal means no append. A
weaker requirement than the recorded regime (`held` after `active`) refuses
live operation with a bounded diagnostic and appends nothing. Validation
rejects `v1_approval_refusal: false`, a downgrade, a repeat equal to the
current regime and non-operator provenance. Operator provenance is deliberate:
`replay` re-feeds operator records rather than regenerating them, so the
regime comes from the record, never from options. A fresh Runtime's first
record is the regime, before `goal.opened@1`, so it triggers no cycle. On a
reloaded journal with an active goal, the regime record is accepted operator
input and triggers a cycle, as replay will. C1 adapts tests that assert
absolute seqs or trace lengths for the one extra record.

Live admission and replay both evaluate `liveV1PublicationRefusal` with the
regime in the projection at that sequence number. With no regime record,
HEAD's v1 rules apply, so pre-gate journals replay unchanged. After a `held`
record, the approval refusal applies and the cycle reports the held blocked
reason. After an `active` record, unrouted publication is also
`prohibited`/`publication_requires_v2_route`. A recorded route selects its
versioned route/v2 rules from that sequence onward. The predicate stays pure
and is not part of the historical validators. The proposed `load` preflight
applies the same regime selection, so an accepted `approval.decided@1
approved` for `report.publish` after a regime record is refused as an
inconsistent journal. Unknown versions, illegal transitions and missing
required evidence still fail closed.

The existing internal `replayMode` still keeps replay inert; it selects no
admission rule. Historical acceptance never authorizes execution, lookup or a
new live append. Replay must use recorded contracts/results and scope evidence
only, contact no live authority/channel/host port, issue no live grant,
append no regime record and persist nothing, even if live ports are supplied.
Pin this with instrumented ports in the C1 legacy replay
guard; `Runtime.issueGrant` must reconstruct recorded grant fields in replay
rather than call a supplied `GrantAuthority.issue`. `load` followed by live
continuation always applies the regime the build requires, appending it first
if needed, including the C1 approval refusal and D-ENG-024 activation.

C1 pins replay equality across regimes:
`HITL-C1 post_gate_trace_with_refused_v1_approval_replays_exactly` (held and
active: the rejected decision's seq, reason and the following cycles replay
byte for byte) and `HITL-C1 prohibited_unrouted_cycle_replays_exactly`
(active). Both replay whole traces, including the rejected record, as M1-T17
does with `Runtime.trace`. A mutation that reads the hold option instead of the
recorded regime during replay must make them fail. C5 adds
`HITL-C5 journal_spanning_activation_replays_exactly`: a journal written under
`held` (including a pre-gate approved but unstarted v1 approval that starts),
reopened by the C5 build, which appends `active` and then prohibits the next
unrouted publication; replay reproduces both segments.

After routing, only `action.started@2` may publish; routing never unblocks an
old v1 queue or makes a new v1 approval/start acceptable.

Scope and rationale after full gate activation: v1 has no verified
opener/delegator evidence, so a string-only inequality check cannot prove
separation. Requiring the existing
route plus C1's verified v2 identities is the smaller safe hardening and gives
legacy goals the same rule as new goals. A missing opener blocks routing, and a
missing delegator blocks each v2 opening. There is no inferred migration, v1 exemption or legacy
self-approval fallback. V1 record schemas, replay folds, `OPERATOR_SOURCE` and
`goal.opened@1` stay unchanged; the provenance id is never reinterpreted as a
principal. Trusted bootstrap must supply verified opener/delegator evidence:

- The **proposed** injected authority lookup returns, under trusted bootstrap,
  the goal's verified `opener_principal`, its `authority_delegator_principal`,
  the authority revision and the maximum delegable scope. Both principals are
  canonical strings in the same identity-mapping namespace as approvers.
  **The opener is captured once.** Routing records the lookup's verified opener
  and mapping revision in `approval.route@1`. Every later
  `approval.requested@2` for the goal, including replacement openings after a
  mapping edit or a reconfigured lookup, must carry that same opener string.
  On a mismatch the opening is refused, so a mutable lookup cannot hand the
  opener role to someone else. The **delegator** is current authority: each
  opening records the lookup's delegator with its mapping/authority revisions,
  and C3c rechecks it at resume. If the opener at routing, or the delegator at
  opening, is missing, ambiguous or unmapped, the step is refused. A v1-opened
  goal gets no inferred identity; it is routed only if trusted bootstrap can
  verify its opener.
- An `approved` decision of either authenticated origin is refused before append
  when its verified principal equals the recorded opener or delegator. The
  comparison happens after mapping, so a second channel account that maps to the
  same principal is still self-approval. With a quorum, every counted approver
  must be distinct from both. The opener and delegator may be the same principal.
- At C3c resume the authority lookup is consulted again. If the current
  delegator for the action's authority is now the approving principal, or the
  delegator cannot be determined, the wait is invalidated through the
  runtime-policy variant. It does not dispatch.
- D-ENG-022 restricts `approved` only. `denied`, `revoked` and `cancelled` only
  withdraw authority, so they are not self-approval. Whether the opener or
  delegator is entitled to issue them is still governed by the entitlement
  question in section A.

C1 first demonstrates
`HITL-C1 legacy_v1_publication_requires_routing_before_approval_or_start` red
against HEAD's M1-T01 path ([m1-fixture.ts](packages/weave/test/m1-fixture.ts):
`m1World` opens via `Runtime.operator`; M1-T01 calls `Runtime.decide` with
`principal: 'operator'`). Green refuses that approval under the
rejected-observation convention above. In both held and active regimes it
asserts the refused record's seq, its log/trace entry with reason
`publication_requires_v2_route`, its absence from the `MemoryJournal`, an
unchanged `state.approvals` entry, a `duplicate` rejection for a same-id
retry, and replay equality of the trace. It proves no
grant/start/queue/invocation, including standing-write and preapproved-queue
fixtures after reopen with HITL disabled, under the `active` regime recorded
by C1 tests ahead of D-ENG-024's C5 production activation. It also asserts
that no `approval.requested@1` is appended after an `active` regime. Live
eligibility for the unrouted publication is then
`prohibited`/`publication_requires_v2_route`, not `approval_required`. A forged
distinct principal string also cannot bypass routing.
`HITL-C1 held_mode_unrouted_approval_path_reports_v2_route_required`: under
`held`, an unrouted publication without standing write forms exactly one
`approval.requested@1` as at HEAD; its `approved` decision is refused as above;
the cycle reports `publication approval unavailable:
publication_requires_v2_route`, not `awaiting approval for report.publish`,
before and after v1 expiry; no second request, grant, start or queue appears;
and the trace replays exactly.
`HITL-C1 legacy_v1_approved_record_still_replays_and_reconciles_after_gate`: a
completed pre-gate v1 publication journal replays with the same log/state
and zero live calls/grants/writes; its prefix containing an approved v1 record
and a started publication with no result loads, and `Runtime.reconcile` gets its
lookup grant through unchanged v1 `Runtime.lookupAuthorized`, recording one
outcome without re-invocation. The incomplete prefix still fails inert replay
for its missing recorded result, as at HEAD. A mutation that moves
`liveV1PublicationRefusal` into `validateApprovalDecision` (the historical
validator), or applies it without a recorded regime, must make it fail.
After explicit routing, v2 fixtures refuse the opener, delegator and aliases,
and accept a distinct entitled principal.

**Tests that approve v1 publication live.** C1's immediate approval refusal
turns red every test that calls `Runtime.decide({ decision: 'approved' })` on a
publication request, not only M1:

- [m1.test.ts](packages/weave/test/m1.test.ts): M1-T01, M1-T17 and the other
  M1 cases that approve through `pendingApproval`.
- [m1-crash-worker.ts](packages/weave/test/m1-crash-worker.ts) (lines 19-24),
  the child process for M1-T13.
- [m5.test.ts](packages/weave/test/m5.test.ts)'s `publishReport` (line 267),
  used by `M5-T05 a protected-case regression restores the baseline for future
  goals`.

C1 switches these setups to standing write on the destination under the
`held` regime, which still publishes, through the test goals' authority
(`m1Goal`'s overrides and the goal in M5's `publishReport`); it adds no
production bypass. Keep M5's strategy-comparison and
promotion assertions, M1-T13's after-commit crash boundary, M1-T17's replay
after revocation and M1-T20's beyond-log refusal unchanged. Approval-path
coverage moves to the HITL-C1 refusal and replay cases above. Preserve denial,
expiry, queue cancellation, crash and committed-effect assertions as
historical fixtures, or as routed integration cases in C3c. When C5 deletes the
hold, standing write alone stops publishing, so C5 moves these setups onto the
routed v2 path from C3c, with no post-C5 legacy execution switch.
`examples/crystallize.ts` and the read-queries `denied` decision are
unaffected by the refusal. This intentional admission hardening is the
exception to preserving existing M1 and M5 behavior.

C1 also freezes the fields and refusal rule in approver-policy fixtures:
`HITL-C1 approval_by_goal_opener_or_authority_delegator_is_refused`,
`HITL-C1 v2_opening_without_opener_and_delegator_principals_is_refused` and
`HITL-C1 replacement_opening_cannot_change_recorded_opener` (a reconfigured
lookup reports a different opener for a replacement opening; the opening is
refused and the real opener still cannot approve). C3b
proves the refusal on the real acceptance path, and C3c proves the resume
recheck.

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
timestamp/freshness using the unpersisted receipt reading `t1` above. `t1` is
never persisted as a clock; an accepted event persists the decision reading
`now` and carries `t1` only as `receipt_time_ms` evidence.
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
one recorded action start; pending → denied; approved → revoked; or
pending/approved → expired, cancelled or invalidated. The consumed wait points
to the existing action record
and its succeeded/failed/uncertain/reconciled lifecycle. **Consumed is terminal**
in the v2 wait projection. Later expiry/revocation/cancellation/invalidation cannot overwrite
it: reject the stale settlement before append; replay validation rejects an
illegally appended transition. Action cancellation/reconciliation may still
advance the action, never return its wait to approved. No terminal request can
be reopened or reused, and approval does not complete the goal.

C1 adds `HITL-C1 revocation_after_consumption_is_rejected` (both authenticated
origins and runtime policy) and
`HITL-C1 runtime_policy_invalidation_after_consumption_is_rejected`, alongside
expiry/cancellation fixtures. C3c integrates the same rejection through
`HITL-C3c revocation_after_consumption_is_rejected_before_append` and
`HITL-C3c runtime_policy_invalidation_after_consumption_is_rejected_before_append`.
Exercise stale and current decision revisions, before/after reopen and effect
commit: no decision-clock or settlement append, unchanged consumption/action
identity, grant, holds and outcome; replay rejects a planted illegal transition.
These are late wait settlements, not cancellation of the consumed action.
Trusted policy enumeration excludes consumed waits; a stale queued policy task
must still be rejected under ownership before append. Recovery may observe
changed current authority and refuse lookup, but must not rewrite consumption
or re-invoke.

Use the origin-discriminated `approval.decided@2` union for authenticated
decisions and runtime expiry/revocation/invalidation. **Explicit records are
the only source of v2 settlement truth**: folding `clock.tick@2` updates time
without expiring waits. The writer appends due runtime-policy expiry before
accepting any authenticated decision (approve, deny, cancel or revoke) or start,
including after restart; a crash between
tick and settlement blocks progress until the missing settlement is appended.
Replay never synthesizes it. Keep v1 `expireApprovals` and its historical
implicit tick fold unchanged, restricted to v1 requests, so a v2 request cannot
receive both implicit and explicit terminal transitions.
Use `decision = cancelled` in that same `approval.decided@2` union; do not add
`approval.cancelled@1`. Both channel and operator cancellation require the same
verified principal, authentication evidence and current request entitlement as
approval, plus a reason and expected decision revision. `denied` refuses a pending
request; `revoked` withdraws an approved but unconsumed decision; `cancelled`
withdraws a pending or approved request without deciding its merits. A pending
request cannot be revoked by any origin; runtime policy uses `invalidated` for
it. These transitions preserve distinct audit meanings
under one terminal contract. C1's fixture
`HITL-C1 channel_cancel_without_verified_principal_and_entitlement_is_refused`
rejects missing evidence; C3b wires the same rule at real decision acceptance.
**Post-consumption cancellation recommendation (D-ENG-021):** a wait-cancel
control received after consumption is a no-op rejection, even if it names the
current decision revision. Refuse before any decision-clock or decision append;
return the consumed action reference and record a bounded rejection diagnostic
through the injected diagnostic port proposed above, outside the observation journal.
This diagnostic is not durable settlement evidence. Do not append
`action.cancel_requested@1`, call `Runtime.cancel`/`AgentFabricHost.requestCancel`,
revoke the consumed action's grant, release its locks or change its outcome.
Restart and redelivery use the recorded consumption to reach the same refusal.
Stopping not-yet-started downstream work requires a separate currently
authorized stop command; the stale wait control confers no such authority.

Action-targeted cancellation remains separate through existing
`action.cancel_requested@1`. A fresh command must authenticate the principal,
check current entitlement to cancel the named action in this project/goal and
bind its explicit action/invocation identity; never translate an old approval
control into that command. At HEAD,
[runtime.ts](packages/weave/src/runtime.ts): `Runtime.cancel` calls
`AgentFabricHost.requestCancel`, aborts inference and revokes the action grant
before submitting `{ action_id, reason }`; it does not perform those external
identity/entitlement checks. C3c must gate the command before calling it.
[types.ts](packages/weave/src/types.ts): `ActionCancelRequestedPayload` and
[state.ts](packages/weave/src/state.ts): `applyAccepted` target the action,
while [host.ts](packages/agentfabric/src/host.ts): `requestCancel` and
`advancePublish` retain committed effects. Existing
[m1.test.ts](packages/weave/test/m1.test.ts): `M1-T11 cancel before commit stops;
late receipt after commit is kept` characterizes action cancellation, not a
late wait-cancel. Keep that behavior and uncertain-effect reconciliation; the
consumed wait and single-use consumption identity remain unchanged.
Stale bindings, missing artifacts or failed current-authority checks use the
runtime-policy invalidation variant, with reason and revision evidence; do not
add a second invalidation payload with competing terminal semantics.

**Proposed** `approval.escalated@1` records the causing `clock.tick@2` seq and
`time_ms` in the v2 domain/version, wait id, the current decision revision
(checked, not advanced), the expected notification revision, policy revision,
recipient set and delivery references. It is valid only while the wait is
pending and `time_ms < effective_deadline_ms`. Under the same ownership step,
due expiry is appended before escalation is considered. At equality or later
the escalation is refused, so no recipient gets live-looking controls for an
expired wait. `HITL-C3b escalation_at_deadline_appends_expiry_not_escalation`
covers equality, a tick-caused escalation and reopen.
Deadline equality has now come back across several reviews (decisions, start,
escalation), so C1 makes it a table-driven check rather than per-transition
prose: `HITL-C1 every_non_expiry_v2_transition_at_or_after_deadline_is_rejected`
iterates over every v2 transition kind the version table admits
(`approval.decided@2` authenticated variants, runtime-policy `revoked` and
`invalidated`, `approval.escalated@1`, `action.started@2`) at `deadline - 1`,
`deadline` and `deadline + 1`. A new transition kind that is missing from the
table fails the check. Escalation is bounded notification, not
approval, a new budget, a deadline extension or silent entitlement broadening.
Changing the entitled set or action creates a replacement bound request with a
fresh id derived from its new opening sequence; close the old one with
`approval.decided@2 { origin: runtime_policy, decision: invalidated,
reason: replacement, ...revision/binding evidence }` before opening the
replacement. If already terminal, cite its existing settlement instead.
Recommended timeout is expire and notify an entitled operator; silence never
approves. Timeout and escalation
choices remain product forks below.

**Proposed** `action.started` payload version 2 adds the expected decision revision,
approval decision sequence, binding digest and consumption reference to the
existing action start. Its single durable append atomically consumes the
approval, binds the unique action/invocation identity and books the existing
resource reservation. Serialized grant fields in that record are scope evidence,
not an issued object: trusted issuance happens for the live dispatch only after
the required start is durable. This deliberately reverses HEAD's
`Runtime.dispatch` → `Runtime.issueGrant` → append order for v2 only.
`HITL-C3c failed_v2_start_persist_leaves_no_issued_grant` instruments the grant
authority and all invocation-reachable objects: a failed start persist causes
zero issuance and invocation, not merely no running action (stronger than
M1-T18's invocation assertion). For the first v2 path, an approved but unconsumed
wait **never becomes `action.queued`**: keep it ready with no grant, action
reservation or execution slot until capacity is available, then recheck all C3c
resume gates and append `action.started@2` directly. Reject v2 wait references
on `action.queued`; do not introduce a second grant-bearing route around
consumption. Keep historical v1 queued-action folding; once active at C5, the
C1 gate blocks draining legacy publications, which require a new routed v2
approval/start instead.
Preserve M1-T05 revocation/cancellation assertions in historical
fixtures and routed coverage. D-ENG-024 holds this live drain gate until C5;
during the hold HEAD's unrouted eligibility checks remain in force. C3c adds a
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
not grant dispatch authority. Preserve the M1-T13 crash boundary and
`m1-crash-worker.ts`, M1-T18 persistence and M1-T19 bounded recovery assertions,
as well as M1-T05 queued-action revocation coverage; adapt live publication
setup for C1's routing gate in active-mode tests and the D-ENG-024 hold in production.

The owned journal uses a distinct path and a mandatory non-JSON first-line
format header, **proposed** `WEAVE-OWNED-OBSERVATIONS/1`, followed by versioned
records. HEAD's `FileJournal.snapshot` calls `JSON.parse` on every nonempty line,
so it refuses this header before `Runtime.load` can fold a v2 record as v1.
C2 pins that rollback behavior against the unchanged reader; a distinct filename
alone would not protect an old binary pointed at the owned file. **Deployment
assumption:** rollback preserves the header/path and never exports v2 records as
headerless v1 JSONL or supplies them directly to an old `Runtime.load`. An old
binary cannot be retrofitted by this child; in-memory snapshots require a
v2-aware loader. C1 freezes this boundary, C2 implements and tests it.

Use one fenced writer per opted-in Loom observation journal, owned by trusted bootstrap.
All accepted ingress decisions, ticks, cancellations and resume attempts go through that
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
3. Verify ingress, actor mapping and entitlement against the receipt reading
   `t1`. Under journal ownership, deduplicate event identity, take the decision
   reading `now >= max(t1, last persisted)` (otherwise refuse without ACK for
   redelivery), compare the expected decision revision and the deadline at
   `now`, and run the separate trusted timeout evaluation: due expiry must
   append before any authenticated approve/deny/cancel/revoke, escalation or
   start. At or beyond the deadline refuse the competing command. Otherwise
   persist `now` and the normalized decision (carrying `t1` as evidence) before
   acknowledging receipt or waking work. No effect may run from the adapter's pre-persist memory.
   C3b owns this Runtime acceptance path for both authenticated operator and
   normalized channel origins: strict origin union, entitlement, scoped event-id
   dedupe (adapter/tenant/event, or local identity/command), conflicting-id refusal
   and expected-revision comparison. C4 supplies verification/mapping evidence
   through that path; it does not implement a second acceptance mechanism.
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
   runtime-policy expiry records for due pending/approved v2 requests, reconcile existing action
   starts within their finite allowance, then enumerate approved unconsumed
   waits. Pure historical replay contacts neither authority/channel ports nor
   capabilities and never resumes work.
6. Before dispatch, validate request/decision/presentation digests, retained
   inputs, goal still active, policy and contract compatibility, approver still
   entitled and still distinct from the current authority delegator
   (D-ENG-022), current grant ceiling, current goal authority and any revocation.
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
   approval. No new pre-invocation lock API is assumed. A wait-cancel/revoke
   arriving after consumption is refused before append and cannot touch the
   action or its grant. A separately authenticated, currently entitled command
   naming the action/invocation may use existing action cancellation and
   reconciliation; a committed effect is evidence, never erased by a later
   denial. An explicit stop may prevent not-yet-started downstream work without
   rewriting consumed evidence.

No atomic transaction spans Loom and Fabric today. A durable start with no
terminal result therefore enters existing recovery/reconciliation; an absent or
uncertain host outcome never authorizes blind repetition. If a crash occurs
after start but before invocation, stop for bounded reconciliation/explicit
resolution rather than issue the consumed authority again. A safe confirmed
no-effect retry is a new authorized attempt, with a fresh single-use grant and
recorded relationship to the prior attempt; it cannot reuse that request's
consumed approval. Safety is required even when liveness needs operator help.

**V2-aware lookup authorization (C3c).** At HEAD, existing reconciliation cannot
cover a v2 start. `Runtime.reconcileStep` gets its lookup grant from
`Runtime.grantForLookup`, and `Runtime.lookupAuthorized` permits a
`report.publish` lookup only through standing write or a valid v1
`matchingApproval`. A routed publication authorized only by a v2 wait would
therefore get a `null` grant, `AgentFabricHost.lookup` would answer `DENIED`, and
a committed outcome would stay uncertain. Architectural recommendation:
`lookupAuthorized` selects its rule by the action's start version.

- `action.started@1`: HEAD's check stays unchanged (M1-T13, M1-T19).
- `action.started@2`: authorize lookup from the **recorded consumption
  identity**. The start's wait id, decision seq, binding digest and consumption
  reference must match one consumed v2 wait whose consumption names this
  action/invocation id. The current authority lookup must still cover observing
  that destination for this project/goal. Lookup observes an already consumed
  start and authorizes no new effect. So approval validity, deadline,
  post-consumption expiry/revocation and the D-ENG-022 delegator recheck do not
  gate it. Missing or mismatched consumption evidence, or unavailable current
  authority, refuses the lookup and leaves the action uncertain with its holds
  (operator resolution, never re-invocation).
- **No execution permission is restored.** The v2 lookup grant is issued only
  after `recovery.attempted@1` is durable and is passed only to
  `AgentFabricHost.lookup`. It never reaches `environment.execute`, state or the
  journal. `GrantAuthority.revoke` is called on it in a `finally` immediately
  after lookup returns or throws. The start's serialized grant fields stay
  scope evidence. Because HEAD's lookup grant carries execution-capable
  permissions and stays valid, this revocation is the v2 difference. The v1
  path is not changed in this parent.

`HITL-C3c crash_after_commit_reconciles_v2_without_standing_write_or_v1_approval`
proves this. Setup: a routed goal with no standing write on the destination, no
v1 approval record and an accepted v2 approval consumed by `action.started@2`.
The process is killed after the host commits the publication and before
`action.result`. After reopen, `Runtime.reconcile` records the host's committed
outcome. Exactly one publication receipt exists, there is no further host
invocation, and the wait stays consumed. Afterwards the lookup grant fails
`isValid`, an invoke presenting it is refused `DENIED`, and no grant is reachable
from `environment.execute`. A variant advances the clock past the deadline
after consumption, rejects a late expiry settlement before append and still
reconciles. Against the predecessor, the v1-only `lookupAuthorized` yields
a `null` grant and an uncertain action, so this test is genuinely red.

### Races, failures and effect lock policy

| Case                                                   | Required deterministic result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same approval delivered twice, including after restart | One decision, one consumption/action identity, at most one external effect; same-id same-body delivery returns original evidence. New event ids cannot answer a closed request again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Forged, altered, cross-tenant or replayed approval     | Verify using an unpersisted trusted reading before writer access. Rejected/forged ingress appends nothing and changes neither v1 logical ticks nor v2 time; rate/body bounds limit verification work. A signature for another binding/project grants nothing. Authenticated identical redelivery returns recorded acceptance without a new decision-clock tick; conflicting ids refuse. C4 tests a flood of rejected inputs against real journal length/clock projections; C5 proves no resume/effect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Approval versus timeout/cancel                         | Serialize by expected decision revision and journal order. Before accepting any authenticated decision (approve, deny, cancel or revoke), escalation or start, take and persist the decision reading `now >= max(t1, last persisted)` under ownership; a receipt reading older than a persisted timer tick neither regresses the clock nor misses expiry: at `time_ms >= effective_deadline_ms`, append due runtime-policy expiry first and refuse the competing decision/start, even without a timer callback or after restart. Rejected commands append no decision clock or decision; the separate trusted expiry evaluation owns its clock/settlement. V1 historical equality remains valid. A valid cancel before consumption prevents dispatch; a wait-cancel after consumption is refused before append and cannot cancel the action or revoke its grant. Test both arrival orders, cancel-at-deadline and deny-at-deadline (also approve/revoke), equality in both versions and expiry/revocation/runtime-policy invalidation after consumption (all rejected before append, consumed unchanged). |
| Cancel after consumption, restart or effect commit     | `HITL-C3c cancel_after_consumption_is_noop_across_restart_and_commit`: use barriers for cancel-first and consume-first. Cancel-first accepts the current approved revision and prevents start. Consume-first, before and after kill/reopen and commit, refuses both the delivered pre-consumption control and a current-revision cancel: bounded no-op rejection diagnostic, no journal/clock/action mutation, no host cancellation, no grant revoke/reissue and no released hold. Replay preserves one consumed wait and the same action/invocation; recovery reconciles it without repeating effects. A separate currently authorized stop may prevent not-yet-started downstream work only.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Two resumers after restart                             | Only the fenced journal owner may dispatch. Loser leaves journal, budgets, grants and effects untouched. Dead owner recovery never relies solely on elapsed time; unknown/live owner blocks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Disk full, partial write, ACK lost, corrupt record     | No unpersisted acceptance/wake; safe redelivery or fail-closed recovery. Preserve acknowledged prefix and consumption identity. Never truncate a complete malformed record to make recovery green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Crash after consumption or effect commit               | Replay is inert; recovery looks up the same invocation under current authority and bounded allowance. A v2 start's lookup is authorized by its recorded consumption identity, not v1 approvals or standing write, and its lookup grant is revoked after use. Keep uncertainty and locks until evidence resolves it; do not invoke again from an approved-state projection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Authority or read-set changes while waiting            | Refuse dispatch under the old decision. Record invalidation/revocation evidence; rebind and request a new decision if useful and authorized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Notification failure/cancellation of adapter           | Request remains durable; bounded retry/escalation records do not approve, renew budgets or implicitly cancel the goal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cancel while offline                                   | At trusted ingress once reachable, persist only a valid pending/approved wait cancellation; a consumed wait returns the no-op rejection above. Startup processes durable cancellation/expiry before resumption. An undelivered remote click cannot already have cancelled work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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
No permanently skipped red tests or weakened assertions. New v2 execution paths
remain off by default through C3a, C3b and C3c and until opt-in C5 activation.
C1's live v1 approval refusal is a safety gate, active independently of that
feature flag; it cannot be disabled to preserve self-approval. D-ENG-024 locks
production activation of the C1 unrouted start/queue/request gate to C5's
release train. C1 lands and tests both modes of the temporary hold; C5 removes
it. Standing-write-only publication continues during the hold; the existing
unrouted eligibility paths remain until activation, while new v1 approvals
are refused immediately.

| Child / PR                                                    | Dependency and scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Genuinely red against predecessor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Done means / green guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — freeze channel-agnostic approval contract                | Captain go first. Contract/fixture review checkpoint before parser/fold implementation in this child; freeze the supported-version table, rollback format assumption, separate v2 projection, durable goal route, unique-open invariant, decision/notification revisions, clock/skew, origin/cancellation union, identity and authority ports, and D-ENG-022 opener (pinned in the route record)/delegator evidence plus the admission-only live v1 publication routing gate (including HITL disabled). D-ENG-024 closes Q-PUB: land gate code/tests here, activate approval refusal now, hold the unrouted start/queue/request gate in production until C5 through the required `hold_publication_gate_until_c5` option, journaled as the operator-provenance `publication.admission@1` regime that live admission and replay both read. Benjamin owns the remaining product policy; no live adapter. Glossary changes belong to this future child. | `HITL-C1 binding rejects changed display, effects, scope and unknown versions`; `HITL-C1 load_refuses_unknown_payload_version_instead_of_v1_fold`; `HITL-C1 decision scope cannot extend request expiry`; `HITL-C1 re-request after denial gets a distinct id and does not reopen the old one`; `HITL-C1 origin_union_rejects_channel_expired_and_runtime_principal`; `HITL-C1 channel_cancel_without_verified_principal_and_entitlement_is_refused`; `HITL-C1 clock_rejects_regressing_or_missing_time`; `HITL-C1 deadline_equality_preserves_v1_and_expires_v2`; `HITL-C1 expiry_after_consumption_is_rejected`, `HITL-C1 cancellation_after_consumption_is_rejected`, `HITL-C1 revocation_after_consumption_is_rejected` and `HITL-C1 runtime_policy_invalidation_after_consumption_is_rejected` (fixture/parser transition rules); `HITL-C1 legacy_v1_publication_requires_routing_before_approval_or_start` (M1-T01 red; v1 self-approval refused as a rejected observation with seq, trace entry, no journal persist, `duplicate` retry and replay equality; active-regime standing-write/preapproved-queue bypass under D-ENG-024, reopen, HITL disabled, no `approval.requested@1` after an `active` regime); `HITL-C1 legacy_v1_approved_record_still_replays_and_reconciles_after_gate` (historical guard; mutation moving the gate into `validateApprovalDecision` or applying it without a recorded regime fails it); `HITL-C1 post_gate_trace_with_refused_v1_approval_replays_exactly` (held and active); `HITL-C1 prohibited_unrouted_cycle_replays_exactly` (mutation reading the hold option during replay fails both); `HITL-C1 held_mode_unrouted_approval_path_reports_v2_route_required`; `HITL-C1 standing_write_remains_available_until_c5` (held mode preserves standing write, historical preapproved queues and a pre-gate approved but unstarted v1 approval, which starts as at HEAD; active mode blocks all three and is red at HEAD; HITL disabled and reopen; new v1 approvals stay refused in both modes); `HITL-C1 admission_regime_is_monotonic_and_operator_only` (no regime, held, active; downgrade, repeat, `v1_approval_refusal: false` and non-operator provenance rejected; a Runtime requiring `held` refuses a journal recorded `active`); `HITL-C1 approval_by_goal_opener_or_authority_delegator_is_refused`; `HITL-C1 v2_opening_without_opener_and_delegator_principals_is_refused`; `HITL-C1 replacement_opening_cannot_change_recorded_opener`; `HITL-C1 runtime_policy_revoke_of_pending_wait_is_rejected`; `HITL-C1 every_non_expiry_v2_transition_at_or_after_deadline_is_rejected`; `HITL-C1 routed_goal_publication_is_never_v1_eligible` (standing write plus matching approved v1 record still yields `publication-v2`); `HITL-C1 route_record_conflict_or_downgrade_is_rejected`; `HITL-C1 escalation_advances_notification_revision_only`. | Reviewed fixtures fail before parsers/folds, then valid records round-trip and malformed transitions refuse. Load refuses unknown versions before mutating state/indexes. V1 load/equality stay unchanged; new live v1 publication approval is refused before append in both held and active modes, without an approval opt-out, through the admission-only `liveV1PublicationRefusal`, never the historical validator `load` runs. D-ENG-024 holds unrouted standing-write-only start/queue/request refusal until C5; C1 tests both modes and the immediate approval refusal. `hold_publication_gate_until_c5` is a required `RuntimeOptions` field with no default; `examples/crystallize.ts` and `examples/hitl.ts` set it held, and `replay`'s options omit it. A live Runtime appends the required `publication.admission@1` before its first live append when the recorded regime is absent or weaker; replay never appends or reads options, and reproduces refused approvals, held blocked reasons and prohibited cycles exactly. The refused approval is a rejected, unpersisted observation with a seq. Held mode keeps v1 request formation but reports approval unavailable; approval-gated unrouted publication cannot complete until C5. Pre-gate journals replay inertly and load/reconcile through unchanged v1 lookup; preserve M1-T17, M1-T20 and the missing-result replay refusal as described. Adapt every live v1 publication approval in tests (M1 cases, `m1-crash-worker.ts`, M5's `publishReport`) to standing write under `held`, keeping M5's strategy-comparison and M1-T13's crash assertions, plus seq-sensitive assertions for the regime record. V2 waits never enter `state.approvals`. **Green characterization:** `HITL-C1 ask_user and intake answers confer no approval`, with a negative control that mints approval from intake. D-ENG-022 is encoded in approver-policy fixtures: approval by the opener, by the delegator, or by a second channel subject mapped to either is refused; a distinct entitled principal is accepted. Self-approval no longer blocks C1 acceptance. |
| C2 — opt-in owned observation journal                         | After C1. Add `OwnedFileJournal` with sync, validated tails, fenced ownership and mandatory non-JSON header/distinct path. Preserve `FileJournal` and callers; no remote route enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `HITL-C2 acknowledged prefix survives partial append and reopen`; `HITL-C2 complete corrupt record refuses recovery`; `HITL-C2 second_owned_writer_is_refused_while_read_only_snapshot_works`; `HITL-C2 crash after durable append before response preserves event exactly once`; `HITL-C2 legacy_file_journal_refuses_owned_format_before_v2_fold`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Fault injection covers before/partial/after append and sync, header/new-file durability, poisoned writer, duplicate/conflicting ids and ownership recovery. Unchanged legacy `FileJournal.snapshot` refuses the owned header. M1-T13 with `m1-crash-worker.ts`, M1-T18 and M1-T19 assertions stay green with C1-adapted publication setup; no lock retrofit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C3a — open and reconstruct v2 waits                           | After C1+C2. Wire the bootstrap route record, publication opening, unique-open check/index rebuild, route-based v1 request/dispatch/queue suppression in every wait status, no-slot suspension and restart reconstruction with injected clock/diagnostic ports. Feature off by default; v2 dispatch disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `HITL-C3a restart_mid_wait_resumes_from_journal_once`; `HITL-C3a durable_opening_holds_no_slot_or_grant`; `HITL-C3a approved_v2_wait_never_satisfies_v1_publish_eligibility`; `HITL-C3a terminal_v2_outcomes_never_fall_back_to_v1_after_restart` (denied, cancelled, expired, invalidated and replacement gap, each with standing write and a pre-route approved v1 record); `HITL-C3a request_formation_after_restart_does_not_open_second_wait`; `HITL-C3a clock_regression_diagnoses_blocks_then_recovers`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Kill/reopen after durable opening, rebuild one wait, redrive formation without a second opening/notification. For the approved fixture, a test-owned journal seeds a C1-valid normalized decision before load; no test-only production endpoint, privileged Runtime flag or bootstrap binding. Ordinary cycles, including zero/free capacity and standing authority, create no publication `action.started@1`/`action.queued@1`, no grant and one ready continuation. Terminal fixtures are seeded the same way. After reopen, cycles and `Runtime.reconcile` produce no `approval.requested@1`, v1 start/queue, grant or invocation; removing the route remains blocked by C1's legacy gate under the `active` regime these tests record ahead of C5; a mutation disabling both protections dispatches through v1. Production acceptance arrives in C3b. Independent work proceeds. Regressed trusted time diagnoses/blocks; repaired injected time permits progress without deadline reset; missing artifacts/time fail closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C3b — authenticated acceptance and explicit settlement        | After C3a. Own Runtime acceptance of authenticated operator/channel `approval.decided@2`: strict origin/evidence union, entitlement, scoped event-id dedupe, conflicting-id refusal and expected revision. Wire runtime-policy timeout/revocation/invalidation, authenticated cancellation and replacement closure. Feature off; no v2 dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `HITL-C3b approve_timeout_cancel_each_order_has_one_winner` (approve/cancel/deny/revoke before, at and after the deadline; cancel-at-deadline and deny-at-deadline cannot beat expiry); `HITL-C3b crash_between_tick_and_settlement_recovers_one_terminal_record`; `HITL-C3b authenticated_origins_dedupe_and_compare_expected_revision`; `HITL-C3b replacement_invalidates_old_before_new_opening`; `HITL-C3b self_approval_by_opener_or_delegator_appends_nothing` (D-ENG-022); `HITL-C3b escalated_unchanged_request_stays_decidable_after_restart`; `HITL-C3b receipt_reading_older_than_persisted_tick_neither_regresses_nor_misses_expiry` (barrier interleaves a timer tick between ingress and ownership); `HITL-C3b escalation_at_deadline_appends_expiry_not_escalation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Test real waits via injected authenticated ingress doubles, not a production bypass. Permute decision/timeout/cancel/invalidation with barriers; both authenticated origins share one acceptance path. Refused commands append no decision-clock or decision; separate trusted evaluation appends due expiry first, before any authenticated decision or start. Duplicate acceptance returns original evidence; conflicting/stale commands cannot reopen terminal waits. At equality and later, cancel/deny (and approve/revoke) lose to exactly one runtime-policy expiry, regardless of arrival order or missing timer callback, including crash between clock and settlement and reopen. Before the deadline the valid first decision wins; deny uses pending and revoke uses approved fixtures. V1 equality is historical-fold coverage only. Explicit v2 settlement/equality rule holds across reopen; cancel/revoke have the distinct preconditions above. Escalation case: deliver controls at decision revision R, append `approval.escalated@1`, then kill/reopen. An approve control at R is accepted once. A cancel control at R that arrives after another principal's approval, and a control for a replaced request, are refused with no append. Clock interleaving: a decision whose `t1` precedes a persisted timer tick is accepted at `now >= max(t1, last persisted)` before the deadline (no regression rejection) and loses to expiry at or past it; an unavailable ordered `now` refuses without ACK or append and a redelivery succeeds. A tick-caused escalation at deadline equality appends expiry only. Post-consumption integration belongs to C3c.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| C3c — consume at start under current gates                    | After C3b. Append/consume `action.started@2` before live grant issuance; wire all resume gates, non-renewal, two-resumer handling, post-consumption wait-cancel/revocation/invalidation refusal, separately authenticated action cancellation, and reconciliation with version-selected `Runtime.lookupAuthorized` (v2 from recorded consumption identity, lookup grant revoked after use). Feature off by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `HITL-C3c revoked_authority_or_stale_read_set_fails_closed`; `HITL-C3c resume_does_not_renew_budget_or_reuse_grant`; `HITL-C3c two_resumers_after_restart_dispatch_once`; `HITL-C3c approved_before_crash_without_wake_is_resumed`; `HITL-C3c zero_capacity_keeps_v2_wait_unqueued_then_revocation_blocks_start`; `HITL-C3c failed_v2_start_persist_leaves_no_issued_grant`; `HITL-C3c redelegation_to_approver_invalidates_before_start` (D-ENG-022); `HITL-C3c expiry_after_consumption_cannot_change_wait` (Runtime/journal/recovery integration, beyond C1 fixture parsing); `HITL-C3c revocation_after_consumption_is_rejected_before_append`; `HITL-C3c runtime_policy_invalidation_after_consumption_is_rejected_before_append`; `HITL-C3c cancel_after_consumption_is_noop_across_restart_and_commit`; `HITL-C3c action_cancel_requires_fresh_authenticated_entitled_target`; `HITL-C3c crash_after_commit_reconciles_v2_without_standing_write_or_v1_approval`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | With explicit test opt-in, accept through C3b, restart and publish once; another reopen repeats no effect. Check authority, ceilings, policy/contract, bindings/read sets, budgets/reservations, finite recovery, D2 and gateway gates. Instrument issuance and invocation-reachable objects: failed start persist issues zero grants and invokes nothing. Kill/reopen at start/invoke/commit/result boundaries; uncertainty retains holds. With no standing write and no v1 approval, crash-after-commit reconciles from consumption identity without a further invocation, and the revoked lookup grant cannot invoke. Late expiry/cancel/revocation/runtime-policy invalidation is rejected before append, including current-revision attempts and stale queued policy tasks after reopen/commit; no decision-clock, settlement, action/grant/hold/outcome mutation. Replay rejects an illegally appended transition; recovery still reconciles from consumption identity under current lookup authority. Cancel-first prevents start; consume-first rejects stale and current-revision wait-cancels with no decision-clock tick, decision/action-cancel append, host cancel or grant revocation, including after reopen and effect commit. Assert one consumption/invocation and unchanged outcome/holds. Only a fresh authenticated action-targeted command with current entitlement may call Runtime.cancel; wrong identity, missing entitlement and reused wait controls do nothing. Preserve M1-T11 committed-effect evidence. Preserve M1-T05 cancellation evidence and historical v1 queue folding; the active C1 gate prevents any new v1 publication drain/start; during the D-ENG-024 hold, HEAD's unrouted eligibility/current-authority checks remain in force.                                                                                                                                                                                                                                                                                                                                            |
| C4 — signed ingress and exact request delivery                | After C3b (which includes C1+C2). Verification/HTTP doubles may develop alongside C3a–b against C1; integration/merge uses real waits and C3b acceptance. Independent of C3c dispatch. Leaf channel composition supplies bounded raw-body/signature, injected key lookup and mapping evidence; no new package/dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `HITL-C4 forged_or_replayed_ingress_is_refused_before_decision_append`; `HITL-C4 rejected_ingress_appends_nothing_and_preserves_logical_tick`; `HITL-C4 ingress_crash_before_append_requires_redelivery`; `HITL-C4 durable_decision_before_ack_redelivery_is_idempotent`; `HITL-C4 channel_identity_cannot_choose_principal`; `HITL-C4 receipt_timestamp_accepts_bounded_future_skew_only`; `HITL-C4 approval_delivery_discloses_bound_request_only`; `HITL-C4 secrets_never_reach_argv_logs_or_journal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Use real pending/approved v2 waits with dispatch disabled; evidence ends at durable normalized acceptance/refusal, not resume. Signed fixtures cover tamper, wrong tenant, freshness/skew boundaries, key rotation/revocation, size/rate limits, mapping removal, widened scope and conflicting ids. Rejected/forged traffic (including repeated inputs) produces no append, clock change, grant or effect. Accepted clock is the decision reading `now >= max(t1, last persisted)`, with `t1` recorded as `receipt_time_ms` evidence; crash after clock-only append accepts no decision; redelivery yields one durable decision and no duplicate clock for an accepted event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| C5 — first production channel, docs and end-to-end acceptance | After C3c+C4+C6 and Benjamin's channel/entitlement/timeout choices (self-approval is closed by D-ENG-022). D-ENG-024 requires this release to activate C1's held unrouted start/queue/request publication gate and remove the temporary hold setting; standing write alone then stops being sufficient. Bind only at trusted bootstrap; Slack only if selected. Verify current primary protocol docs in this child. Own #352's docs deliverable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `HITL-C5 channel_approve_deny_timeout_cancel_restart_contract` against the unbound production channel; `HITL-C5 delivery_failure_keeps_wait_and_consumes_no_execution_slot`; `HITL-C5 replayed_or_forged_approval_cannot_resume` (joins C4 ingress with C3c dispatch); `HITL-C5 c5_activation_removes_hold_and_requires_v2_route` (standing-write-only, preapproved legacy queues and a pre-gate approved but unstarted v1 approval: the same journal that started it under `held` reopens under C5 and yields `prohibited` with no start, grant or queue; restart, HITL disabled, `RuntimeOptions` without the hold key, and routed v2 continuation); `HITL-C5 journal_spanning_activation_replays_exactly` (a `held` segment, the appended `active` record and the prohibited segment replay byte for byte).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Fake channel plus real journals/host proves draft → exact display → days of injected time/restart → approve or deny → gated continuation. Forged/replayed events cannot resume. Preserve uncertain holds. Ship protocol/operator docs: displayed payload, identity/entitlement, rotation, bounded skew, retry/ACK, clock-regression recovery, rollback format assumption, inspection/cancellation, lock policy and remaining product choices. At activation, no new unrouted v1 request/start/queue/drain succeeds, even with standing write and HITL disabled; already-started v1 actions still load/reconcile. Explicitly routed v2 approval/dispatch remains usable. Assert the temporary setting is deleted from `RuntimeOptions` and every composition site and fixture, the C5 build appends `publication.admission@1 { unrouted_gate: "active" }` once on reopen of a `held` journal, there is no activation gap across restart, and no legacy bypass is restored. Move M1, `m1-crash-worker.ts` and M5 `publishReport` setups from held-mode standing write onto the routed v2 path from C3c. Live smoke needs an explicitly authorized destination; opt-in rollout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C6 — harden existing isolation checks                         | After C1; develop alongside C2–C4, merge before C5 activation. Existing `checks/import-direction.mjs` already prohibits package → consumer (`examples/`) imports/re-exports; harden its fixture coverage, not a new prohibition. Preserve clock/secret/benchmark boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `HITL-C6 import_direction_checks_supplied_hitl_fixture_root`: add fixture-root support and assert existing prohibition against planted weave/gateway/agentfabric → channel composition imports/re-exports. HEAD ignores that argument (`root` is derived from `import.meta.url`) and reports the clean repository; this new harness assertion fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **Green guards:** `HITL-C6 benchmark_routes_omit_hitl_guardrails_and_shuffle` and `HITL-C6 runtime_and_gateway_import_no_channel_adapter` (cover Fabric too). Negative controls add an approval envelope/guardrail/shuffle field to a fixture route or plant forbidden imports in each package; guards reject mutations. Existing wire tests remain green under hostile HITL configuration; no corpus, held-out check, threshold or route is weakened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Dependencies are C1 → C2 → C3a → C3b, then C3b → C3c and C3b → C4;
C3c and C4 join at C5 with C6 a release gate. C4 verification-only work and C6
can proceed alongside the runtime children against C1's frozen contract, but
C4's real-wait acceptance tests require C3b and its C2 durability. C3b alone owns
normalized decision acceptance; C4 proves append/refusal, C5 proves no resume.
Independent review of adversarial
cases should precede implementation; reserve held-out cases before any later
comparative benchmark. This task does not run benchmarks or send any corpus to
a hosted model. A negative control validates a guard's sensitivity; it does not
relabel an already-green production guard as red against the predecessor.

### Acceptance traceability (issue body)

This table maps [#352](https://github.com/CrowBe/weave/issues/352)'s body as
retrieved in the plan3 pass and as the `7446f36` review summarized it. This pass
did not re-read the issue; see Verification. The issue's Goal and Weave mapping
require the protocol below, and its Parent of list includes docs. Its Done means remains accepted protocol plus
child breakdown, with captain go before implementation.

| Acceptance item                                         | Contract and implementation evidence                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft the high-stakes action                            | C1 exact presentation/execution binding; C3a publication opening; C5 exact-display flow.                                                                                                                                                                                                                                      |
| Serialize the pending request/continuation              | C1 atomic opening and record-only continuation; C2 owned journal; C3a kill/reopen reconstruction.                                                                                                                                                                                                                             |
| Wait hours to days without occupying execution capacity | C1 persisted millisecond clock/deadline; C3a no-slot/no-grant suspension; C3b timeout; C5 days of injected time/restart.                                                                                                                                                                                                      |
| Decision by an entitled principal                       | C1 string identity, mapping, bounded approver policy and D-ENG-022 opener/delegator separation, including `legacy_v1_publication_requires_routing_before_approval_or_start` (red against M1-T01, no v1 exemption); C3b refusal of self-approval; C4 verified mapping; C3c entitlement/delegator recheck; C5 selected channel. |
| Signed webhook ingress                                  | C1 origin/receipt-time/skew contract; C2 persist-before-ACK; C3b normalized authenticated acceptance; C4 signature/refusal/redelivery; C5 no-resume integration; C6 isolation guards.                                                                                                                                         |
| Resume under current authority                          | C3b due expiry before every authenticated decision/start (cancel/deny-at-deadline included); C3c current authority/read set/ceilings, single consumption and late revocation/invalidation rejected before append; C5 complete flow; C6 dependency isolation.                                                                  |
| No budget renewal                                       | C1 folded limits/spend/reservations; C3c non-renewal of budgets/grants/approval and finite recovery; C5 restart flow; C6 benchmark isolation.                                                                                                                                                                                 |

Additional issue-body traceability:

| Issue item                                                    | Ownership / recommendation                                                                                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout / escalate / cancel (Weave mapping)                   | C1 origin-discriminated terminal contract and v2 escalation time; C3b settlement/races; C3c late wait-cancel refusal and separate action cancellation; C5 operator docs and selected notification policy. |
| Wait/resume protocol and restart mid-wait tests (Parent of)   | C1–C3c contract, journal, opening/recovery and consumption; C5 complete channel flow.                                                                                                                     |
| Docs (Parent of)                                              | C5 owns protocol and operator documentation listed in its done-means; no separate implementation child is required.                                                                                       |
| Channel-agnostic first / Slack first adapter? (open question) | Recommend channel-agnostic C1 and generic local proof C4; Benjamin chooses the first production channel before C5.                                                                                        |
| Human payload: bound request only? (open question)            | Recommend the exact bound request only, enforced in C1/C4/C5; Benjamin chooses which action/content/destination is permitted, with no ambient dump.                                                       |
| Effect locks across the wait? (open question)                 | Architect recommendation: release before waiting, reacquire/revalidate at C3c dispatch; preserve uncertain holds. Refuse unsupported held-wait policy; add it only for a concrete action requirement.     |

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

D-ENG-022 and Q-PUB/D-ENG-024 are closed owner decisions and must not reopen.
The other rows remain open product forks for Benjamin; their recommendations
describe proposed defaults, not accepted product decisions.

| Question                                                                                                                                 | Recommendation                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which channel first: signed webhook for an existing operator surface, Slack, or another channel?                                         | Prove the generic signed-webhook contract locally, then choose Slack only if it is the actual operator workflow. Do not make Slack identity or payloads a Loom type.                                                                                                                                                                                                                 |
| Who is entitled to approve, and is multiple approval required?                                                                           | **Open for Benjamin.** Recommend explicitly mapped project approvers and one entitled principal within a configured maximum delegable scope. No membership/name inference. Multiple approvals require quorum and distinct-principal aggregation in C1. Every counted approver must also be distinct from the opener and the delegator (D-ENG-022).                                   |
| Benjamin: may the goal opener approve Loom's first high-stakes publication draft, including when that principal delegated the authority? | **Closed: D-ENG-022 (Benjamin, 2026-11-02).** No self-approval. The approver must be a principal distinct from both the goal opener and the authority delegator, so dispatch waits for that other entitled principal. C1 records verified opener/delegator principals and freezes the refusal; C3b and C3c test it (see "Separation of duties"). Do not reopen as an owner question. |
| **Q-PUB (closed: D-ENG-024).** When does C1's live v1 start/queue/request publication gate activate?                                     | **Locked: option (b), Benjamin, 2026-11-02.** Code/tests land in C1; production activation joins C5, which removes the temporary hold. Standing-write-only publication remains available until then. Live v1 approval refusal activates in C1 immediately. See the linked owner answer and decision log under "Separation of duties".                                                |
| What timeout and escalation should operators expect?                                                                                     | Make the deadline explicit per request, with a configurable default; recommend 24 hours initially, expiry plus bounded notification, no automatic approve or execution. Escalation may notify an already entitled alternate without extending validity.                                                                                                                              |
| Which actions justify a long wait, and how much exact draft content may leave the host?                                                  | Start with publication of a bounded draft to one target. Disclose only that request to an allowed destination; use a trusted operator surface when content cannot safely leave. Choose retention requirements explicitly.                                                                                                                                                            |
| Can cancellation/denial end the goal or only this action?                                                                                | Settle a pending/approved request and keep goal outcome separate; let the operator explicitly stop the goal. After consumption, refuse the wait control without append or grant revocation; only a separate authorized stop may prevent not-yet-started downstream work. Preserve committed/uncertain effects.                                                                       |

### B. Architectural and code-health questions

Architectural and code-health decisions belong to an architect session, not
Benjamin. The concrete recommendations below are self-contained; C1 freezes
them before code. Only the product forks in section A need Benjamin's choice.

| Question                                                                           | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend publication records or add a generic wait service?                          | Use v2 approval records and a separate journal-derived wait projection, with a shared explicit type/version table for admission/load and a rollback-safe owned format. One open wait per goal/candidate/binding. Publication is the first consumer; reuse operating-process transitions, not a second scheduler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Where is the current authority ceiling recorded?                                   | Define an injected deterministic authority lookup and explicit maximum delegable scope in the contract. Existing `Goal.authority` and M1 publication exception do not establish a general remote-approval ceiling. Freeze that distinction before code; preserve D2 tier ceiling independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| How to coordinate recovery and two resumers?                                       | Opt-in `OwnedFileJournal` with one exclusive, fenced local writer plus lock-free read-only snapshots; preserve `FileJournal` and its M1 callers. Reject unknown/live competing owners. Keep ownership mechanics at storage/bootstrap. Defer multi-host ownership rather than suggest optimistic in-memory dedupe solves it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Reuse FabricStore or FileAttemptJournal directly?                                  | Reuse their tested durability mechanics where coherent, but keep Loom observation records separate from invocation/attempt domains. `FileAttemptJournal` is explicitly not a lock; do not make it one by assertion. Avoid a storage framework or new dependency without evidence of need.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Which clock, decision origin, identity and queue rules?                            | Use a separate v2 clock projection with nondecreasing Unix milliseconds, bounded future skew and regression diagnostic/recovery; verify ingress against the unpersisted receipt reading `t1`, then persist the decision reading `now >= max(t1, last persisted)` taken under ownership (refuse without ACK if unavailable). Pin the opener in the route record; runtime-policy `revoked` only for approved unconsumed waits. Freeze the strict decision/cancellation origin union, validated string principals, terminal consumption, an irrevocable goal-scoped `approval.route@1` that excludes v1 eligibility in every wait status, separate decision and notification revisions, and no v2 queue. Keep historical v1 clocks/approval/queue folds; enforce routed-goal isolation and immediate v1 approval refusal even with HITL disabled; D-ENG-024 holds the unrouted start/queue/request gate until C5.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| May legacy v1 publication bypass D-ENG-022?                                        | **D-ENG-021 recommendation:** no. C1 refuses new live v1 approval immediately. Explicit v2 routing before new publication start/queue/request, including preapproved queues, restart and HITL disabled, activates at C5 under D-ENG-024; gate code/tests land in C1. The refusal is the pure `liveV1PublicationRefusal`, never the historical validator `load` uses, and it selects its rules from the journaled `publication.admission@1` regime, never a live option: pre-gate records (no regime) load and already-started v1 actions reconcile through unchanged v1 lookup, while inert `replay` reproduces held and active outcomes from the recorded regime and never invokes live ports, appends or issues grants. Once the `active` regime is recorded, unrouted publication eligibility is `prohibited`/`publication_requires_v2_route`, so no v1 request forms. Refuse a missing verified opener at routing and a missing delegator at v2 opening. This avoids an invented v1 identity migration and keeps D-ENG-022 closed.                                                                                                                                                                                                                                                                                              |
| Hold effect locks during the wait?                                                 | Release before the wait; reacquire and revalidate on dispatch. Preserve uncertain invocation holds. Add durable held-wait support only for a concrete action that cannot use revision checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| What if a consumption/start exists but host execution is unconfirmed?              | Reconcile the existing invocation within finite allowance; for `action.started@2`, authorize lookup from the recorded consumption identity and current authority, and revoke the lookup grant after use. Fail closed if evidence is unavailable. Never replay a consumed approval or grant to improve liveness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| How to keep gateway and runtime pure?                                              | Use leaf `examples/hitl.ts` for bootstrap/Runtime ports and `examples/hitl-channel.ts` for HTTP/signatures, injected key lookup and identity wiring. Keep deterministic transitions in Loom and persistence in the owned journal. C6 fixture-checks forbid weave, gateway and agentfabric imports of this composition. Keep ambient-clock/env checks and Fabric independence intact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| How to connect waiting workstreams without adopting the recursive-thread proposal? | Store optional existing workstream/process identifiers and projection evidence; reconstruct `operating.process@1` waiting/woke transitions. Add no execution-claim or result-reference implementation under this parent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Can a late wait-cancel cancel an already consumed action?                          | **D-ENG-021 recommendation:** refuse it before any append, with a bounded no-op rejection diagnostic; preserve the consumed wait, action grant and effects. Keep action cancellation a fresh authenticated command with current entitlement and explicit action/invocation identity through `action.cancel_requested@1`. Only a separately authorized stop may block not-yet-started downstream work. C1 freezes terminal validation; C3c tests both orderings, restart and commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| How to prevent repeated review regressions?                                        | Turn repeated findings into narrow tests/lints: version/load downgrade, v1 eligibility bypass in any wait status (including terminal and replacement gap), v1-only recovery lookup, escalation staling controls, post-consumption wait-cancel/revocation/invalidation mutation or grant revocation, deadline cancel/deny beating expiry, any non-expiry v2 transition at or after the deadline (one table-driven C1 check over every admitted transition kind, since deadline equality recurred), receipt reading older than a persisted tick, v1 gate moved into the historical validator (mutation), any admission rule selected by a live option instead of a journaled record (replay of the same trace must be byte-identical under no regime, `held`, `active` and across activation; this replay/admission divergence recurred, so every new admission-regime outcome joins that replay-equality set), unrouted v1 request formation, opener drift across replacement openings, runtime revoke of a pending wait, duplicate waits, self-approval by opener/delegator including legacy v1, rejected-ingress writes/time, binding drift, scope extension, grant-before-persist/reuse, ACK-before-persist, ambient time, secret disclosure and benchmark wire contamination. Preserve independent validation/held-out evidence. |

## Terms to add in the implementation contract PR

No glossary edit is made in this planning task. C1 should propose these precise
additions/clarifications before code introduces the corresponding names:

- **Durable approval wait**: journal-derived suspension of one bound request;
  it holds no execution slot and grants no authority.
- **Approval-request binding**: immutable association of exact displayed request,
  typed action, revisions, scope and validity, identified by a versioned digest.
- **Approval consumption**: one durable association of an approved bound request
  with one action start; it does not renew budgets or permit reuse.
- **Approval route**: durable, irrevocable goal-scoped record that a high-stakes
  action kind is governed only by durable approval waits; no v1 approval or
  standing authority can substitute. It pins the verified goal opener.
- **Publication admission regime**: durable, monotonic journal record of the
  live v1 publication admission rules in force from its sequence onward
  (`held` or `active` unrouted gate, v1 approval refusal); live admission and
  replay both read it, and no option or caller can lower it.
- **Decision revision** / **notification revision**: the wait revision that
  decisions compare, and the separate revision that escalation alone advances.
- **Channel identity mapping**: versioned trusted mapping from a verified channel
  subject and installation/tenant to a principal; distinct from entitlement.
- Clarify **Approval** to say that for the first high-stakes action kind the
  approver is distinct from the goal opener and the authority delegator
  (D-ENG-022).
- Clarify existing **Recovery**, **Read set**, **Effect lock** and
  **Resume point** entries only as needed. Do not redefine **Replay**, **Thread**,
  **Execution claim**, **Session record**, **Grant** or **Budget gate** to imply
  this work implements their unrelated proposals or resets their limits.

## Plan10 review disposition

All findings from [the supplied review](/workspace/wvops/WV-352-review-f7dac89.json)
were checked against `f7dac89` and fixed in this document. They are
contract/test commitments, not implemented fixes:

| Review finding                                     | Disposition                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission regime not journaled; replay diverges    | Operator-provenance, monotonic `publication.admission@1` appended by a live Runtime before its first live append; live admission and replay read it. C1 replay-equality tests for held/active; C5 spanning test. |
| Refused approval versus HEAD's rejected convention | Rejected observation with seq, trace entry and reason `publication_requires_v2_route`, not persisted, no fold or cycle; C1 asserts seq, log, journal, `duplicate` retry and replay equality.                     |
| Hold setting default and composition sites         | Required `RuntimeOptions` field with no default; `examples/crystallize.ts` and `examples/hitl.ts` set held; `replay` options omit it; C5 deletes it and asserts no use survives.                                 |
| Held-mode request path left undecided              | Held mode keeps v1 request formation; approval-gated unrouted publication cannot complete until C5; cycle reports approval unavailable with `publication_requires_v2_route`; new C1 test.                        |
| M5 and crash-worker v1 approvals unlisted          | M1 cases, `m1-crash-worker.ts` and M5 `publishReport` move to standing write under `held` in C1 and to routed v2 in C5; M5 comparison and M1-T13 crash assertions kept.                                          |
| Pre-gate approved but unstarted v1 approval        | Held mode starts it as at HEAD (possible legacy self-approval, accepted by D-ENG-024 until C5); after activation the same journal yields `prohibited`. Added to both tests.                                      |
| M1-T20 citation                                    | Cited as the beyond-recorded-log refusal; the missing `action.result` refusal is cited separately in `replay`.                                                                                                   |
| `load` preflight read as existing                  | Marked **proposed**; HEAD's `load` checks seq order only. The preflight validates under the rules selected by the recorded regime and route.                                                                     |

## Plan8/plan9 review disposition

All findings from [the supplied review](/workspace/wvops/WV-352-review-54d55dd.json)
were checked against `54d55dd`; the interrupted plan8 edits were unverified input.
The following are contract/test commitments, not implemented fixes:

| Review finding                                    | Disposition                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live v1 refusal corrupts historical load/replay   | Separate `liveV1PublicationRefusal` from historical validators and inert replay; C1 legacy replay/load/reconcile guard plus gate-in-validator mutation. Preserve v1 recovery lookup.                         |
| Publication outage / Q-PUB                        | Closed by D-ENG-024 (b). C1 immediate approval refusal; C1 gate code/tests with held production standing-write path; C5 removes hold and activates full gate. Both child rows name activation tests.         |
| Receipt reading older than persisted tick         | C1 freezes `t1` freshness versus owned `now`; C3b timer-barrier test covers before/at deadline, missing ordered reading, no ACK and redelivery.                                                              |
| Mutable goal opener across replacement            | Pin opener and mapping revision in `approval.route@1`; C1 mismatch/replacement fixture, C3b self-approval refusal, C3c current delegator recheck.                                                            |
| Unrouted v1 requests remain actionable            | Activated gate returns `prohibited`/`publication_requires_v2_route`, forms no v1 request; C1/C5 test it. D-ENG-024 explicitly holds this request gate until C5; v1 approval refusal is immediate throughout. |
| Escalation at deadline equality                   | Settle due expiry first under ownership; C3b equality/reopen test, plus C1 exhaustive non-expiry transition/deadline table.                                                                                  |
| Runtime-policy revoke of pending wait             | C1 rejects `revoked` unless approved and unconsumed; pending authority loss uses `invalidated`.                                                                                                              |
| Baseline and missing full-suite green (follow-up) | Inventory at `2f3f6d7`, PLAN-only HEAD `54d55dd`; current verification attempt and tracked F-VERIFY below.                                                                                                   |

## Verification and assumptions for this planning change

Review target: `f7dac89`; source inventory at `2f3f6d7`; `f7dac89` differs
only in PLAN.md (`git diff --stat 2f3f6d7..f7dac89`). The only difference from
the former `e4dc5e16bf8d1ad25d18c9d7041066a9fa982883` baseline is PLAN.md.
For the plan10 findings, this pass checked at `f7dac89`: `Runtime.appendStep`
(rejected observations get a seq, enter the log and are not persisted),
`Runtime.admitStep` (cycles only for accepted non-cycle input), `Runtime.decide`
(observation id `operator:approval:<request_id>:<decision>`), `CYCLE_APPENDED`
and `replay` (operator records re-fed, cycle records regenerated), `checkPrefix`
(whole-observation `stableStringify` comparison), `Runtime.load` (seq order
only, stored validation trusted), `Runtime.requestApprovals` (`apr:${candidate_id}`,
one request per id), `Runtime.cycleOutcome` (`awaiting approval for
report.publish`), `publishEligibility`, M1-T17 and M1-T20, `m1-crash-worker.ts`,
M5's `publishReport` and every `new Runtime(` site (production:
`examples/crystallize.ts`; otherwise `replay`, `recover` and tests).
Rechecked the runtime version gate/load/indexing, v1 eligibility/dispatch/clock,
grant ordering, journal format, import-direction checker and named existing test
contracts against HEAD. Source/tests are unchanged since `440a031` (verified
with `git diff --stat 440a031..HEAD`). The prior inventory covers:
`publishEligibility`, `matchingApproval`, `approvalStillValid` and the
`Eligibility` union; `Runtime.runCycleOnce`, `Runtime.requestApprovals`,
`Runtime.dispatch`, `Runtime.stillAuthorized` and `Runtime.drainQueue`; and
`Runtime.reconcileStep`, `Runtime.grantForLookup` and `Runtime.lookupAuthorized`.
Also checked: `AgentFabricHost.lookup` (requires an issued, valid, covering
grant and does not consume it), `validateInvocation` (refuses a revoked grant)
and `GrantAuthority.revoke`. References above cite repository files/symbols; proposed
records/tests are future child work, not implementation or demonstrated red in
this planning change. Read VISION.md, GLOSSARY.md and AGENTS.md before decisions.
The plan6 cancellation review covered `Runtime.cancel`,
`ActionCancelRequestedPayload`, `validate`'s `action.cancel_requested` branch,
`applyAccepted`, `AgentFabricHost.requestCancel`, `advancePublish`,
`GrantAuthority.revoke` and M1-T11 in the linked files above. The existing
action-cancel command can revoke a live grant; a late wait control must never
reach it implicitly. Plan6 recorded a temporary plan-consistency check that
failed on its old race
table's action-cancel conversion, then passed with the explicit no-op contract
and C3c restart/race row. This checks the document, not the
proposed Runtime behavior. C1/C3c must still demonstrate their named behavioral
tests red before implementation and green afterward; include a mutation that
routes a stale wait control into `Runtime.cancel` so this finding becomes a
regression test.
For D-ENG-022, the principal identities were checked at HEAD:
`EXPECTED_SOURCE`, `OPERATOR_SOURCE`, `Runtime.operator`, `Runtime.decide`,
`Goal`, `AuthorityScope`, `Grant`, `ApprovalDecidedPayload`,
`validateApprovalDecision`, `applyAccepted`, `ApprovalRecord` and
`matchingApproval`. None has a verified opener or delegator principal, and no
path compares the approver with either. M1-T01 and `m1World` still exercise the
legacy self-approval gap at this HEAD. C1 refuses new v1 approvals immediately;
D-ENG-024 holds the full unrouted publication gate until C5, preserving
standing-write-only publication in the meantime. Historical evidence stays intact. There is no separate
decision log for D-ENG-022 or D-ENG-021 in the repository; this plan states the
owner lock and concrete architectural recommendations in full.

Plan7 reported a temporary document-consistency check red against `2f3f6d7`
for the legacy routing gate/scope, all-decision deadline precedence and late
revocation/invalidation cases. That earlier check was not rerun here. For this
plan8/plan9 pass, a temporary check failed on the inherited partial edits for
D-ENG-024 closure/activation tests, historical replay preservation and the stale
verification baseline; it passes after revision and checks the other findings
and four prior fixes remain covered. This is document evidence only, not
behavioral Runtime evidence; C1/C3 must still demonstrate red before code and
green afterward. The plan10 pass ran no temporary document check; its findings
were verified by reading the cited source and tests at `f7dac89`.

Issue access, assumption: a prior pass reported that `gh issue view 352` needed
unavailable approval. Plan7 did not retry external issue access. The mapping
above comes from the plan3 pass's retrieval. The Claude review of `7446f36`
summarized the issue's Weave mapping, open questions and docs child the same
way. Benjamin's remaining product forks in section A stay open. D-ENG-022 and
D-ENG-024 are closed.

The plan10 pass ran `npm run fmt:check` (passes across 506 files, including
PLAN.md) and `git diff --check` (passes) with Node 22.23.4 from
`/home/box/.local/node22/bin`. It did not rerun `npm run verify`; the
following plan9 result stands as reported and is not re-established here.

The plan9 pass reran `npm run verify` with Node 22.23.4 from
`/home/box/.local/node22/bin` (repository minimum `>=22.18.0`). Formatting passes
across 506 files, including PLAN.md (`vite.config.ts` excludes no such file),
and `npm run check` passes import direction, ambient clock/entropy/environment,
swallowed-failure and script/benchmark-digest tests. Verify exits 1 at
`npm run test:checks`: [checks.test.mjs](checks/test/checks.test.mjs)'s `run`
uses `spawnSync`, which reports `EPERM` launching this Node executable for the
fixtures. A direct reproduction with both red and green `no-ambient-env`
fixtures confirms `error.code = EPERM` and empty stdout/stderr. The other two
test:checks files pass; subsequent verify stages did not run. This repeats the
plan7 blocker. The prior `440a031` pass reported full green; plan9 did not
re-establish it. `git diff --check` and the plan9 temporary document check passed.
No permissions or checks are weakened. Proposed behavioral tests are not
claimed as demonstrated red by this planning task.

**Tracked follow-up F-VERIFY (before captain go):** run `npm run verify` with
supported Node in an environment where the fixture runner's `spawnSync` is
permitted, then attach its full result. The present environment cannot supply
that evidence; do not substitute formatting/document checks for full green.

Repository evidence cannot establish deployed channel setup, approver,
opener or delegator identities,
secret provisioning, external delivery retention/ACK guarantees, storage medium
durability, or multi-host filesystem semantics. Those are explicit assumptions
to resolve in the relevant children. Slack protocol details require current
primary documentation in C5 if selected. No source, tests, schemas, glossary,
vision, permissions, protected checks or benchmark inputs change in this task.
