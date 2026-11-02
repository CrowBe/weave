# WV-352: durable asynchronous approval and resumption

Planning only, on `wv-352-durable-hitl-plan`. No implementation is authorized
until captain go. This document is the only tracked change. Review target:
`7446f36`. The acceptance mapping below uses
[#352](https://github.com/CrowBe/weave/issues/352)'s body as retrieved during
the plan3 pass and as summarized by the Claude review of `7446f36` (Weave
mapping, three open questions, docs child). This pass could not re-read it:
`gh issue view 352` needs approval that this session lacks. See Verification.

Owner lock **D-ENG-022** (Benjamin, 2026-11-02) is applied throughout: Loom's
first high-stakes action kind, `report.publish` publication, has no
self-approval. See "Separation of duties" below.

Inventory baseline: HEAD `7446f360b297f193c4018a6da312fe4eefe0d76f`.
Only PLAN.md differs from the former `e4dc5e16bf8d1ad25d18c9d7041066a9fa982883`
baseline; relevant source and tests were rechecked at HEAD. Names explicitly marked
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
| Approval policy                       | [candidates.ts](packages/weave/src/candidates.ts): `publishEligibility`, `bindingDigest`, `matchingApproval`, `approvalStillValid`                                                                                                                                                                                                                                                                                                                                                                                                                               | Digest covers inputs and effects. `matchingApproval` searches every `state.approvals` entry by binding digest/destination; approved status and inclusive validity tick can permit publication, as can standing destination write authority. `Runtime.stillAuthorized` reforms candidates using that policy. No external entitlement/current principal revision check or maximum delegable scope exists here. V2 records must fold separately and the v2-managed candidate must not dispatch through this v1 route.                                                                                          |
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
| Every other HEAD `PAYLOAD_TYPES` entry, including `action.queued` | 1 only, existing semantics. C1 enumerates these entries explicitly; no wildcard or default version fallback.    |

Select parser, transition validation, fold and indexes by `(payload_type,
payload_version)`, including replay and recovery. Before any log/index/state
mutation, `load` preflights the whole input for supported types/versions and
validates accepted records with their historical contract/transition rules;
stored `validation: accepted` is insufficient. Unknown versions fail closed,
never fall through to v1 `applyAccepted` or `indexApprovalRequest`. Historical
replay verifies recorded evidence without contacting live authentication ports.
`HITL-C1 load_refuses_unknown_payload_version_instead_of_v1_fold` pins this
failure and leaves the prior state/indexes unchanged.

V2 requests/decisions **never enter `state.approvals`**. That map remains v1-only;
[candidates.ts](packages/weave/src/candidates.ts)'s `matchingApproval`,
`approvalStillValid`, `publishEligibility` and
[runtime.ts](packages/weave/src/runtime.ts)'s `Runtime.stillAuthorized` cannot
derive v1 authority from a v2 wait. For an action managed by an open v2 wait,
the opt-in path also suppresses ordinary v1
publication dispatch/request formation, including standing-write eligibility;
only C3c may consume that wait. C3a must prove an approved v2 fixture cannot
escape through v1 start/queue/grant issuance while v2 dispatch is disabled.
This closes the eligibility route as well as forbidding v2 queue references.

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
is rejected. Under the fenced writer, refuse a new opening while any pending or
approved v2 wait exists for the same `(goal_id, candidate_id, execution binding
digest)` in the project. Rebuild that uniqueness index on load before request
formation/redrive or notification; return the existing wait for an identical
retry. A consumed binding is not a reason to re-request or repeat the action:
reconcile its action instead. After denial/expiry/invalidation a newly authorized
request uses a new opening sequence, even for the same candidate and binding.
It cannot reopen
the old request. Replay derives ids from records, never ambient entropy/time.
The wait revision is the sequence of its last accepted wait-affecting record:
opening, decision/settlement, escalation or consumption. Delivery
status and clock ticks alone do not change it. Commands compare the expected
revision under ownership before append; an idempotent redelivery returns its
original result before this comparison.

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
a deliberate v2 difference: v1 remains valid at `tick == valid_until_tick` and
expires only at `tick > valid_until_tick`, with its implicit fold unchanged.

Trusted composition persists fresh v2 clock readings at startup, trusted timeout
evaluation and immediately before consumption. At ingress it first captures an
**unpersisted trusted receipt reading**. Verify bounded raw bytes/signature,
endpoint/tenant, mapping, entitlement, command shape, expected revision and
deadline before writing. The versioned verification policy carries finite
`max_age_ms` and `max_future_skew_ms`; accept signed timestamps only when
`-max_future_skew_ms <= time_ms - signed_timestamp_ms <= max_age_ms`. The skew
allowance tolerates sender clocks ahead of the receiver without moving Loom time.
Under ownership, recheck the command against current state and persist that
exact verified receipt reading immediately before the accepted decision,
referenced by its clock seq/time; both appends must be durable before ACK/wake.
If a crash leaves only the clock append, it authorizes nothing; redelivery
reverifies and the decision is still required. Same-id identical redelivery
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
All variants bind request/wait id and expected revision, full execution and
presentation digests, decision and causal evidence. Reject fields belonging to
another variant, unknown versions and extra authority claims:

- `origin = channel`: authenticated `approved`/`denied`/`revoked`/`cancelled` only, with verified
  principal, authority revision, ingress event id, adapter and installation/tenant,
  decision evidence ref, receipt clock seq/time and identity-mapping/policy
  revisions. It cannot assert `expired` or runtime invalidation.
- `origin = operator`: authenticated local `approved`/`denied`/`revoked`/`cancelled` only, with
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

### Separation of duties (D-ENG-022, closed)

**Owner decision D-ENG-022** (Benjamin, 2026-11-02; the decision is stated in
full here because the repository has no decision log): Loom's first
high-stakes action kind has no self-approval. An approving principal must differ
from (a) the principal that opened the goal and (b) the principal that
delegated the authority the action uses. Self-approval is refused. This is no
longer an open owner question, and it no longer blocks C1 acceptance.

Principal identities at HEAD. None of the three roles has a verified principal:

| Role                | What HEAD records                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal opener         | `goal.opened@1` is admitted only from provenance kind `operator` ([validation.ts](packages/weave/src/validation.ts): `EXPECTED_SOURCE`). [runtime.ts](packages/weave/src/runtime.ts)'s `Runtime.operator` is an `IngressHandle` stamped with the constant `OPERATOR_SOURCE = { kind: 'operator', id: 'operator' }`. [types.ts](packages/weave/src/types.ts)'s `Goal` has no opener field, so every opener has the same provenance.                                |
| Authority delegator | `Goal.authority` is just `{ read, write? }` resource lists inside the operator-sourced `goal.opened` payload. It names no delegator. `AuthorityScope` (`{ goal_id } \| { policy_id }`) scopes cached conclusions, not people. [grants.ts](packages/agentsop/src/grants.ts)'s `Grant` has `action_id`, operation/contract, permissions/effects and an `issued_at` seq, but no issuer or delegating principal, and `GrantAuthority` issues by object identity.      |
| Approver            | `ApprovalDecidedPayload.principal` is a bare claimed string. `validateApprovalDecision` checks only that it is nonempty, and `applyAccepted` copies it into `ApprovalRecord.principal`. `Runtime.decide` submits through that same `Runtime.operator` handle, and M1 tests pass `principal: 'operator'`. Neither [candidates.ts](packages/weave/src/candidates.ts)'s `matchingApproval`/`approvalStillValid` nor any read port compares the approver with anyone. |

So HEAD cannot tell an approver apart from an opener or delegator. C1 has to add
that evidence for v2 only. V1 records, `OPERATOR_SOURCE` and `goal.opened@1`
stay unchanged, and the `operator` provenance id is never reinterpreted as a
principal. Architectural recommendation:

- The **proposed** injected authority lookup returns, under trusted bootstrap,
  the goal's verified `opener_principal`, its `authority_delegator_principal`,
  the authority revision and the maximum delegable scope. Both principals are
  canonical strings in the same identity-mapping namespace as approvers.
  `approval.requested@2` records both, with their mapping/authority revisions,
  as opening evidence. If either is missing, ambiguous or unmapped, opening is
  refused. A v1-opened goal gets no inferred identity.
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

C1 freezes these fields and the refusal rule in approver-policy fixtures:
`HITL-C1 approval_by_goal_opener_or_authority_delegator_is_refused` and
`HITL-C1 v2_opening_without_opener_and_delegator_principals_is_refused`. C3b
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
timestamp/freshness using the unpersisted trusted receipt reading above; only
an accepted event's reading becomes persisted v2 receipt-clock evidence.
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
Use `decision = cancelled` in that same `approval.decided@2` union; do not add
`approval.cancelled@1`. Both channel and operator cancellation require the same
verified principal, authentication evidence and current request entitlement as
approval, plus a reason and expected revision. `denied` refuses a pending
request; `revoked` withdraws an approved but unconsumed decision; `cancelled`
withdraws a pending or approved request without deciding its merits. A pending
request cannot be revoked. These transitions preserve distinct audit meanings
under one terminal contract. C1's fixture
`HITL-C1 channel_cancel_without_verified_principal_and_entitlement_is_refused`
rejects missing evidence; C3b wires the same rule at real decision acceptance.
Existing `action.cancel_requested@1` remains the path once an action exists.
Stale bindings, missing artifacts or failed current-authority checks use the
runtime-policy invalidation variant, with reason and revision evidence; do not
add a second invalidation payload with competing terminal semantics.

**Proposed** `approval.escalated@1` records the causing `clock.tick@2` seq and
`time_ms` in the v2 domain/version, wait id/expected revision, policy revision,
recipient set and delivery references. Escalation is bounded notification, not
approval, a new budget, a deadline extension or silent entitlement broadening.
Changing the entitled set or action creates a replacement bound request with a
fresh id derived from its new opening sequence; close the old one with
`approval.decided@2 { origin: runtime_policy, decision: invalidated,
reason: replacement, ...revision/binding evidence }` before opening the
replacement. If already terminal, cite its existing settlement instead.
Recommended timeout is expire and notify an entitled operator; silence never
approves. Timeout and escalation
choices remain product forks below.

**Proposed** `action.started` payload version 2 adds the wait/request revision,
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
3. Verify ingress, actor mapping and entitlement. Under journal ownership,
   deduplicate event identity, compare expected request/wait revision and
   deadline, then persist the verified receipt clock and normalized decision before acknowledging receipt
   or waking work. No effect may run from the adapter's pre-persist memory.
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
   runtime-policy expiry records for all due v2 requests, reconcile existing action
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
| Forged, altered, cross-tenant or replayed approval     | Verify using an unpersisted trusted reading before writer access. Rejected/forged ingress appends nothing and changes neither v1 logical ticks nor v2 time; rate/body bounds limit verification work. A signature for another binding/project grants nothing. Authenticated identical redelivery returns recorded acceptance without a new receipt tick; conflicting ids refuse. C4 tests a flood of rejected inputs against real journal length/clock projections; C5 proves no resume/effect.       |
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

| Child / PR                                                    | Dependency and scope                                                                                                                                                                                                                                                                                                                                                                                                                          | Genuinely red against predecessor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Done means / green guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — freeze channel-agnostic approval contract                | Captain go first. Contract/fixture review checkpoint before parser/fold implementation in this child; freeze the supported-version table, rollback format assumption, separate v2 projection, unique-open invariant, clock/skew, origin/cancellation union, identity and authority ports, and D-ENG-022 opener/delegator evidence. Benjamin owns the remaining product policy; no live adapter. Glossary changes belong to this future child. | `HITL-C1 binding rejects changed display, effects, scope and unknown versions`; `HITL-C1 load_refuses_unknown_payload_version_instead_of_v1_fold`; `HITL-C1 decision scope cannot extend request expiry`; `HITL-C1 re-request after denial gets a distinct id and does not reopen the old one`; `HITL-C1 origin_union_rejects_channel_expired_and_runtime_principal`; `HITL-C1 channel_cancel_without_verified_principal_and_entitlement_is_refused`; `HITL-C1 clock_rejects_regressing_or_missing_time`; `HITL-C1 deadline_equality_preserves_v1_and_expires_v2`; `HITL-C1 expiry_after_consumption_is_rejected` (fixture/parser transition rule); `HITL-C1 approval_by_goal_opener_or_authority_delegator_is_refused`; `HITL-C1 v2_opening_without_opener_and_delegator_principals_is_refused`. | Reviewed fixtures fail before parsers/folds, then valid records round-trip and malformed transitions refuse. Load refuses unknown versions before mutating state/indexes. V1 replay/equality stay unchanged; v2 waits never enter `state.approvals`. **Green characterization:** `HITL-C1 ask_user and intake answers confer no approval`, with a negative control that mints approval from intake. D-ENG-022 is encoded in approver-policy fixtures: approval by the opener, by the delegator, or by a second channel subject mapped to either is refused; a distinct entitled principal is accepted. Self-approval no longer blocks C1 acceptance.                                |
| C2 — opt-in owned observation journal                         | After C1. Add `OwnedFileJournal` with sync, validated tails, fenced ownership and mandatory non-JSON header/distinct path. Preserve `FileJournal` and callers; no remote route enabled.                                                                                                                                                                                                                                                       | `HITL-C2 acknowledged prefix survives partial append and reopen`; `HITL-C2 complete corrupt record refuses recovery`; `HITL-C2 second_owned_writer_is_refused_while_read_only_snapshot_works`; `HITL-C2 crash after durable append before response preserves event exactly once`; `HITL-C2 legacy_file_journal_refuses_owned_format_before_v2_fold`.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fault injection covers before/partial/after append and sync, header/new-file durability, poisoned writer, duplicate/conflicting ids and ownership recovery. Unchanged legacy `FileJournal.snapshot` refuses the owned header. M1-T13 with `m1-crash-worker.ts`, M1-T18 and M1-T19 stay green; no lock retrofit.                                                                                                                                                                                                                                                                                                                                                                     |
| C3a — open and reconstruct v2 waits                           | After C1+C2. Wire publication opening, unique-open check/index rebuild, v1 dispatch exclusion, no-slot suspension and restart reconstruction with injected clock/diagnostic ports. Feature off by default; v2 dispatch disabled.                                                                                                                                                                                                              | `HITL-C3a restart_mid_wait_resumes_from_journal_once`; `HITL-C3a durable_opening_holds_no_slot_or_grant`; `HITL-C3a approved_v2_wait_never_satisfies_v1_publish_eligibility`; `HITL-C3a request_formation_after_restart_does_not_open_second_wait`; `HITL-C3a clock_regression_diagnoses_blocks_then_recovers`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Kill/reopen after durable opening, rebuild one wait, redrive formation without a second opening/notification. For the approved fixture, a test-owned journal seeds a C1-valid normalized decision before load; no test-only production endpoint, privileged Runtime flag or bootstrap binding. Ordinary cycles, including zero/free capacity and standing authority, create no publication `action.started@1`/`action.queued@1`, no grant and one ready continuation. Production acceptance arrives in C3b. Independent work proceeds. Regressed trusted time diagnoses/blocks; repaired injected time permits progress without deadline reset; missing artifacts/time fail closed. |
| C3b — authenticated acceptance and explicit settlement        | After C3a. Own Runtime acceptance of authenticated operator/channel `approval.decided@2`: strict origin/evidence union, entitlement, scoped event-id dedupe, conflicting-id refusal and expected revision. Wire runtime-policy timeout/revocation/invalidation, authenticated cancellation and replacement closure. Feature off; no v2 dispatch.                                                                                              | `HITL-C3b approve_timeout_cancel_each_order_has_one_winner`; `HITL-C3b crash_between_tick_and_settlement_recovers_one_terminal_record`; `HITL-C3b authenticated_origins_dedupe_and_compare_expected_revision`; `HITL-C3b replacement_invalidates_old_before_new_opening`; `HITL-C3b self_approval_by_opener_or_delegator_appends_nothing` (D-ENG-022).                                                                                                                                                                                                                                                                                                                                                                                                                                            | Test real waits via injected authenticated ingress doubles, not a production bypass. Permute decision/timeout/cancel/invalidation with barriers; both authenticated origins share one acceptance path. Refused commands append nothing. Duplicate acceptance returns original evidence; conflicting/stale commands cannot reopen terminal waits. Explicit v2 settlement/equality rule holds across reopen; cancel/revoke have the distinct preconditions above. Post-consumption integration belongs to C3c.                                                                                                                                                                        |
| C3c — consume at start under current gates                    | After C3b. Append/consume `action.started@2` before live grant issuance; wire all resume gates, non-renewal, two-resumer and reconciliation handling. Feature off by default.                                                                                                                                                                                                                                                                 | `HITL-C3c revoked_authority_or_stale_read_set_fails_closed`; `HITL-C3c resume_does_not_renew_budget_or_reuse_grant`; `HITL-C3c two_resumers_after_restart_dispatch_once`; `HITL-C3c approved_before_crash_without_wake_is_resumed`; `HITL-C3c zero_capacity_keeps_v2_wait_unqueued_then_revocation_blocks_start`; `HITL-C3c failed_v2_start_persist_leaves_no_issued_grant`; `HITL-C3c redelegation_to_approver_invalidates_before_start` (D-ENG-022); `HITL-C3c expiry_after_consumption_cannot_change_wait` (Runtime/journal/recovery integration, beyond C1 fixture parsing).                                                                                                                                                                                                                  | With explicit test opt-in, accept through C3b, restart and publish once; another reopen repeats no effect. Check authority, ceilings, policy/contract, bindings/read sets, budgets/reservations, finite recovery, D2 and gateway gates. Instrument issuance and invocation-reachable objects: failed start persist issues zero grants and invokes nothing. Kill/reopen at start/invoke/commit/result boundaries; uncertainty retains holds. A late expiry/cancel cannot rewrite the consumed wait and action cancellation remains separate. Preserve M1-T05 and v1 queue behavior.                                                                                                  |
| C4 — signed ingress and exact request delivery                | After C3b (which includes C1+C2). Verification/HTTP doubles may develop alongside C3a–b against C1; integration/merge uses real waits and C3b acceptance. Independent of C3c dispatch. Leaf channel composition supplies bounded raw-body/signature, injected key lookup and mapping evidence; no new package/dependency.                                                                                                                     | `HITL-C4 forged_or_replayed_ingress_is_refused_before_decision_append`; `HITL-C4 rejected_ingress_appends_nothing_and_preserves_logical_tick`; `HITL-C4 ingress_crash_before_append_requires_redelivery`; `HITL-C4 durable_decision_before_ack_redelivery_is_idempotent`; `HITL-C4 channel_identity_cannot_choose_principal`; `HITL-C4 receipt_timestamp_accepts_bounded_future_skew_only`; `HITL-C4 approval_delivery_discloses_bound_request_only`; `HITL-C4 secrets_never_reach_argv_logs_or_journal`.                                                                                                                                                                                                                                                                                         | Use real pending/approved v2 waits with dispatch disabled; evidence ends at durable normalized acceptance/refusal, not resume. Signed fixtures cover tamper, wrong tenant, freshness/skew boundaries, key rotation/revocation, size/rate limits, mapping removal, widened scope and conflicting ids. Rejected/forged traffic (including repeated inputs) produces no append, clock change, grant or effect. Accepted clock is the exact verified receipt reading; crash after clock-only append accepts no decision; redelivery yields one durable decision and no duplicate clock for an accepted event.                                                                           |
| C5 — first production channel, docs and end-to-end acceptance | After C3c+C4+C6 and Benjamin's channel/entitlement/timeout choices (self-approval is closed by D-ENG-022). Bind only at trusted bootstrap; Slack only if selected. Verify current primary protocol docs in this child. Own #352's docs deliverable.                                                                                                                                                                                           | `HITL-C5 channel_approve_deny_timeout_cancel_restart_contract` against the unbound production channel; `HITL-C5 delivery_failure_keeps_wait_and_consumes_no_execution_slot`; `HITL-C5 replayed_or_forged_approval_cannot_resume` (joins C4 ingress with C3c dispatch).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Fake channel plus real journals/host proves draft → exact display → days of injected time/restart → approve or deny → gated continuation. Forged/replayed events cannot resume. Preserve uncertain holds. Ship protocol/operator docs: displayed payload, identity/entitlement, rotation, bounded skew, retry/ACK, clock-regression recovery, rollback format assumption, inspection/cancellation, lock policy and remaining product choices. Live smoke needs an explicitly authorized destination; opt-in rollout.                                                                                                                                                                |
| C6 — harden existing isolation checks                         | After C1; develop alongside C2–C4, merge before C5 activation. Existing `checks/import-direction.mjs` already prohibits package → consumer (`examples/`) imports/re-exports; harden its fixture coverage, not a new prohibition. Preserve clock/secret/benchmark boundaries.                                                                                                                                                                  | `HITL-C6 import_direction_checks_supplied_hitl_fixture_root`: add fixture-root support and assert existing prohibition against planted weave/gateway/agentfabric → channel composition imports/re-exports. HEAD ignores that argument (`root` is derived from `import.meta.url`) and reports the clean repository; this new harness assertion fails.                                                                                                                                                                                                                                                                                                                                                                                                                                              | **Green guards:** `HITL-C6 benchmark_routes_omit_hitl_guardrails_and_shuffle` and `HITL-C6 runtime_and_gateway_import_no_channel_adapter` (cover Fabric too). Negative controls add an approval envelope/guardrail/shuffle field to a fixture route or plant forbidden imports in each package; guards reject mutations. Existing wire tests remain green under hostile HITL configuration; no corpus, held-out check, threshold or route is weakened.                                                                                                                                                                                                                              |

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

| Acceptance item                                         | Contract and implementation evidence                                                                                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft the high-stakes action                            | C1 exact presentation/execution binding; C3a publication opening; C5 exact-display flow.                                                                                                                   |
| Serialize the pending request/continuation              | C1 atomic opening and record-only continuation; C2 owned journal; C3a kill/reopen reconstruction.                                                                                                          |
| Wait hours to days without occupying execution capacity | C1 persisted millisecond clock/deadline; C3a no-slot/no-grant suspension; C3b timeout; C5 days of injected time/restart.                                                                                   |
| Decision by an entitled principal                       | C1 string identity, mapping, bounded approver policy and D-ENG-022 opener/delegator separation; C3b refusal of self-approval; C4 verified mapping; C3c entitlement/delegator recheck; C5 selected channel. |
| Signed webhook ingress                                  | C1 origin/receipt-time/skew contract; C2 persist-before-ACK; C3b normalized authenticated acceptance; C4 signature/refusal/redelivery; C5 no-resume integration; C6 isolation guards.                      |
| Resume under current authority                          | C3b settle before resumption; C3c current authority/read set/ceilings and single consumption; C5 complete flow; C6 dependency isolation.                                                                   |
| No budget renewal                                       | C1 folded limits/spend/reservations; C3c non-renewal of budgets/grants/approval and finite recovery; C5 restart flow; C6 benchmark isolation.                                                              |

Additional issue-body traceability:

| Issue item                                                    | Ownership / recommendation                                                                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout / escalate / cancel (Weave mapping)                   | C1 origin-discriminated terminal contract and v2 escalation time; C3b settlement/races; C5 operator docs and selected notification policy.                                                            |
| Wait/resume protocol and restart mid-wait tests (Parent of)   | C1–C3c contract, journal, opening/recovery and consumption; C5 complete channel flow.                                                                                                                 |
| Docs (Parent of)                                              | C5 owns protocol and operator documentation listed in its done-means; no separate implementation child is required.                                                                                   |
| Channel-agnostic first / Slack first adapter? (open question) | Recommend channel-agnostic C1 and generic local proof C4; Benjamin chooses the first production channel before C5.                                                                                    |
| Human payload: bound request only? (open question)            | Recommend the exact bound request only, enforced in C1/C4/C5; Benjamin chooses which action/content/destination is permitted, with no ambient dump.                                                   |
| Effect locks across the wait? (open question)                 | Architect recommendation: release before waiting, reacquire/revalidate at C3c dispatch; preserve uncertain holds. Refuse unsupported held-wait policy; add it only for a concrete action requirement. |

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

Every row except the closed D-ENG-022 row remains an open product-fork owner
question for Benjamin. Recommendations describe proposed defaults, not accepted
product decisions.

| Question                                                                                                                                 | Recommendation                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which channel first: signed webhook for an existing operator surface, Slack, or another channel?                                         | Prove the generic signed-webhook contract locally, then choose Slack only if it is the actual operator workflow. Do not make Slack identity or payloads a Loom type.                                                                                                                                                                                                                 |
| Who is entitled to approve, and is multiple approval required?                                                                           | **Open for Benjamin.** Recommend explicitly mapped project approvers and one entitled principal within a configured maximum delegable scope. No membership/name inference. Multiple approvals require quorum and distinct-principal aggregation in C1. Every counted approver must also be distinct from the opener and the delegator (D-ENG-022).                                   |
| Benjamin: may the goal opener approve Loom's first high-stakes publication draft, including when that principal delegated the authority? | **Closed: D-ENG-022 (Benjamin, 2026-11-02).** No self-approval. The approver must be a principal distinct from both the goal opener and the authority delegator, so dispatch waits for that other entitled principal. C1 records verified opener/delegator principals and freezes the refusal; C3b and C3c test it (see "Separation of duties"). Do not reopen as an owner question. |
| What timeout and escalation should operators expect?                                                                                     | Make the deadline explicit per request, with a configurable default; recommend 24 hours initially, expiry plus bounded notification, no automatic approve or execution. Escalation may notify an already entitled alternate without extending validity.                                                                                                                              |
| Which actions justify a long wait, and how much exact draft content may leave the host?                                                  | Start with publication of a bounded draft to one target. Disclose only that request to an allowed destination; use a trusted operator surface when content cannot safely leave. Choose retention requirements explicitly.                                                                                                                                                            |
| Can cancellation/denial end the goal or only this action?                                                                                | Settle this request and keep goal outcome separate; let the operator explicitly stop the goal. Show committed/uncertain effects honestly when cancellation arrives late.                                                                                                                                                                                                             |

### B. Architectural and code-health questions

Architectural and code-health decisions belong to an architect session, not
Benjamin. The concrete recommendations below are self-contained; C1 freezes
them before code. Only the product forks in section A need Benjamin's choice.

| Question                                                                           | Recommendation                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend publication records or add a generic wait service?                          | Use v2 approval records and a separate journal-derived wait projection, with a shared explicit type/version table for admission/load and a rollback-safe owned format. One open wait per goal/candidate/binding. Publication is the first consumer; reuse operating-process transitions, not a second scheduler.                                                                      |
| Where is the current authority ceiling recorded?                                   | Define an injected deterministic authority lookup and explicit maximum delegable scope in the contract. Existing `Goal.authority` and M1 publication exception do not establish a general remote-approval ceiling. Freeze that distinction before code; preserve D2 tier ceiling independently.                                                                                       |
| How to coordinate recovery and two resumers?                                       | Opt-in `OwnedFileJournal` with one exclusive, fenced local writer plus lock-free read-only snapshots; preserve `FileJournal` and its M1 callers. Reject unknown/live competing owners. Keep ownership mechanics at storage/bootstrap. Defer multi-host ownership rather than suggest optimistic in-memory dedupe solves it.                                                           |
| Reuse FabricStore or FileAttemptJournal directly?                                  | Reuse their tested durability mechanics where coherent, but keep Loom observation records separate from invocation/attempt domains. `FileAttemptJournal` is explicitly not a lock; do not make it one by assertion. Avoid a storage framework or new dependency without evidence of need.                                                                                             |
| Which clock, decision origin, identity and queue rules?                            | Use a separate v2 clock projection with nondecreasing Unix milliseconds, bounded future skew and regression diagnostic/recovery; verify ingress before persisting its time. Freeze the strict decision/cancellation origin union, validated string principals, terminal consumption, v1 eligibility exclusion and no v2 queue. Keep v1 clocks/approvals/queues unchanged.             |
| Hold effect locks during the wait?                                                 | Release before the wait; reacquire and revalidate on dispatch. Preserve uncertain invocation holds. Add durable held-wait support only for a concrete action that cannot use revision checks.                                                                                                                                                                                         |
| What if a consumption/start exists but host execution is unconfirmed?              | Reconcile the existing invocation within finite allowance; fail closed if evidence is unavailable. Never replay a consumed approval or grant to improve liveness.                                                                                                                                                                                                                     |
| How to keep gateway and runtime pure?                                              | Use leaf `examples/hitl.ts` for bootstrap/Runtime ports and `examples/hitl-channel.ts` for HTTP/signatures, injected key lookup and identity wiring. Keep deterministic transitions in Loom and persistence in the owned journal. C6 fixture-checks forbid weave, gateway and agentfabric imports of this composition. Keep ambient-clock/env checks and Fabric independence intact.  |
| How to connect waiting workstreams without adopting the recursive-thread proposal? | Store optional existing workstream/process identifiers and projection evidence; reconstruct `operating.process@1` waiting/woke transitions. Add no execution-claim or result-reference implementation under this parent.                                                                                                                                                              |
| How to prevent repeated review regressions?                                        | Turn repeated findings into narrow tests/lints: version/load downgrade, v1 eligibility bypass, duplicate waits, self-approval by opener/delegator, rejected-ingress writes/time, binding drift, scope extension, grant-before-persist/reuse, ACK-before-persist, ambient time, secret disclosure and benchmark wire contamination. Preserve independent validation/held-out evidence. |

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
- Clarify **Approval** to say that for the first high-stakes action kind the
  approver is distinct from the goal opener and the authority delegator
  (D-ENG-022).
- Clarify existing **Recovery**, **Read set**, **Effect lock** and
  **Resume point** entries only as needed. Do not redefine **Replay**, **Thread**,
  **Execution claim**, **Session record**, **Grant** or **Budget gate** to imply
  this work implements their unrelated proposals or resets their limits.

## Verification and assumptions for this planning change

Review target and source inventory are HEAD `7446f36`; the only difference from
the former `e4dc5e16bf8d1ad25d18c9d7041066a9fa982883` baseline is PLAN.md.
Rechecked the runtime version gate/load/indexing, v1 eligibility/dispatch/clock,
grant ordering, journal format, import-direction checker and named existing test
contracts against HEAD. References above cite repository files/symbols; proposed
records/tests are future child work, not implementation or demonstrated red in
this planning change. Read VISION.md, GLOSSARY.md and AGENTS.md before decisions.
For D-ENG-022, the principal identities were checked at HEAD:
`EXPECTED_SOURCE`, `OPERATOR_SOURCE`, `Runtime.operator`, `Runtime.decide`,
`Goal`, `AuthorityScope`, `Grant`, `ApprovalDecidedPayload`,
`validateApprovalDecision`, `applyAccepted`, `ApprovalRecord` and
`matchingApproval`. None has a verified opener or delegator principal, and no
path compares the approver with either. "D-ENG-022" and the related
architect-session rule have no record in the repository. This plan therefore
states each decision in full instead of relying on the id.

Issue access, assumption: this pass ran `gh issue view 352`, and it needed
approval that was not available, so the issue was not re-read. The mapping
above comes from the plan3 pass's retrieval. The Claude review of `7446f36`
summarized the issue's Weave mapping, open questions and docs child the same
way. Benjamin's remaining product forks in section A stay open. D-ENG-022 is
closed.

With supported Node 22.23.4 (repository minimum `>=22.18.0`), `npm run fmt:check`
passes across 506 files and includes PLAN.md (`vite.config.ts`, `fmt` has no
exclusion for it). `git diff --check` passes. The full `npm run verify` exits 0
in this pass: formatting, `npm run check` (import direction, ambient
clock/entropy/environment, swallowed-failure) and every test stage report zero
failures. That includes [checks.test.mjs](checks/test/checks.test.mjs), which
failed with a child-launch `EPERM` in the earlier pass. No tests, permissions
or checks are weakened.

Repository evidence cannot establish deployed channel setup, approver,
opener or delegator identities,
secret provisioning, external delivery retention/ACK guarantees, storage medium
durability, or multi-host filesystem semantics. Those are explicit assumptions
to resolve in the relevant children. Slack protocol details require current
primary documentation in C5 if selected. No source, tests, schemas, glossary,
vision, permissions, protected checks or benchmark inputs change in this task.
