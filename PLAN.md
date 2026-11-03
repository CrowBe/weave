# WV-354: self-healing rewrite on capability failure

Status: proposed architecture parent; **captain go is required before implementation**. This task adds only this plan.
No child issues, source, tests, schemas, glossary entries, or benchmark data are changed here.

Review target and inventory baseline: `9ce2ff25db5e5be036e9dde7bf5d00bbe86802b2` (`plan: WV-354 plan2 address Claude
review of ba3a753`) on `wv-354-self-heal-plan`. It and its parent `ba3a753` change only `PLAN.md` relative to
`0281c5ed13ee0b3fbedd50399f9ed19837a58c17`, so source, tests and checks are identical; every citation below was
rechecked at `9ce2ff2`. This revision (plan3) addresses the GLM review of `9ce2ff2`, recorded in
`/workspace/wvops/WV-354-review-9ce2ff2.json`; §12 gives its disposition. Plan2's map of the Claude Opus review of
`ba3a753` (`/workspace/wvops/WV-354-review-ba3a753.json`) stays in §11 and those fixes are unchanged.
Read `VISION.md`, `GLOSSARY.md`, and the current implementation and tests before preparing this proposal.
`gh issue view 354 --repo CrowBe/weave` failed to connect to `api.github.com`; the GitHub connector subsequently returned
[#354](https://github.com/CrowBe/weave/issues/354), its empty comment list, and
[#355](https://github.com/CrowBe/weave/issues/355). This is a plan for rewritten calls, not permission to modify a running
implementation or relax its contract.

## 1. Inventory at HEAD

Paths and symbols below exist at the baseline. Names introduced later in this document are explicitly proposals.

| Existing mechanism                             | Exact files and symbols                                                                                                                                                                                                                                                                                                         | Boundary relevant to this plan                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation-step retry and escalation       | `packages/weave/src/implement-step.ts`: `runImplementationStep`, `actionFor`, `feedbackPrompt`, `DEFAULT_IMPLEMENT_RETRIES`                                                                                                                                                                                                     | Default two same-tier retries, then one escalation above the input tier, bounded by the ceiling and budget port. Regenerates implementation work; does not rewrite an arbitrary invocation.                                                                                                                                                                                                                                                          |
| Check invocation and fresh grants              | Same file: `runChecks`, `freshCheckGrant`, `sameGrantScope`, `createEqualGrantIssuer`, `EqualGrantIssuer`                                                                                                                                                                                                                       | Fresh grants match operation, contract revision, permissions, effects and process effects. Issuer limit is `retries + 2`, held in memory per issuer. It is not a durable allowance for a nested rewrite loop.                                                                                                                                                                                                                                        |
| Step evidence and open issues                  | Same file: `AttemptRecord`, `StopRecord`, `OpenIssue`, `OPEN_ISSUE_SCHEMA`, `AttemptJournal`, `FileAttemptJournal`, `replayImplementationStep`; `packages/weave/src/audit-loop.ts`: `AuditIssue.schema`                                                                                                                         | Existing versions are `impl.step@1`, `impl.attempt@1`, `impl.stop@1`, `open_issue@1`. `OpenIssue.source` is only `check` or `eval`; it cannot honestly represent a general capability blocker. `GLOSSARY.md` "Open issue" defines the term as an implementation-step or audit blocker. Finished attempts are journaled before continuation.                                                                                                          |
| Audit escalation and loop stops                | `packages/weave/src/audit-loop.ts`: `runAuditLoop`, `AuditJournal`, `AuditRound`, `AuditCheckpoint`, `AuditIssue`; `packages/weave/src/audit-view.ts`: `AuditIssue`, `assembleAuditState`                                                                                                                                       | Audit generates at `strong` with `audit: true`; budget pauses and unconfirmed paid dispatch are explicit. The two `AuditIssue` interfaces and the implementation-step `OpenIssue` are distinct types. The audit view accepts sources `check`, `eval`, `audit`.                                                                                                                                                                                       |
| Bound calls                                    | `packages/weave/src/types.ts`: `Candidate`, `ActionStartedPayload`, `ActionRecord`; `packages/agentsop/src/contracts.ts`: `CapabilityContract`, `bindSelectors`; `packages/agentsop/src/process-effects.ts`: `bindProcessEffects`                                                                                               | There is no existing `BoundCall` type. Reuse the candidate's operation, revision, inputs, evidence, dependencies, read set, effects and reservation. Selector binding checks resource references, not arbitrary semantic correctness.                                                                                                                                                                                                                |
| Candidate identity and failed-call suppression | `packages/weave/src/candidates.ts`: `formCandidates`, `failedCandidateIds`, `bindingDigest`, `matchingApproval`, `approvalStillValid`; `packages/weave/src/digest.ts`: `candidateId`; `packages/weave/src/normalize.ts`: `formNormalizeCandidates`                                                                              | `candidateId` digests only operation, contract revision and inputs, so a rewritten input has a new id and is not suppressed by `failedCandidateIds`. A rewrite must produce a newly validated candidate with explicit, recorded lineage; deleting suppression or changing an id to rerun the same inputs would defeat the existing loop guard. Composition-specific formation has its own suppression too.                                           |
| Action identity                                | `packages/weave/src/runtime.ts`: the cycle loop assigns `` `a:${cycle_no}:${index + 1}` `` to each selected candidate, and `Runtime.dispatch` sets `invocation_id = action_id`; `CYCLE_ACTION_ID` notes cycle numbers on replay; `packages/weave/src/validation.ts`: `validateStarted` requires `^a:\d+:\d+$`                   | An action id is allocated at selection, not earlier, and is also the invocation id. Any id assigned before selection either collides with this scheme or is rejected by `validateStarted`; §5 therefore introduces a versioned, rewrite-scoped id form.                                                                                                                                                                                              |
| Scheduling, read sets and dispatch             | `packages/weave/src/scheduler.ts`: `select`, `rejectReason`; `packages/weave/src/state.ts`: `readSetMatches`; `packages/weave/src/runtime.ts`: `Runtime.dispatch`, `stillAuthorized`, `issueGrant`, `drainQueue`, `invokeHost`                                                                                                  | Scheduler checks dependencies, effect conflicts, budget and source revisions. `dispatch` issues a grant, then appends `action.started` or `action.queued` (both carrying `grant: Grant \| null`, null only for a contract-less candidate), and calls `environment.execute` only after an accepted append. `drainQueue` reuses `record.grant`, rebuilds a candidate with `eligibility: allowed`, and `stillAuthorized` reforms only `report.publish`. |
| Observation versions                           | `packages/weave/src/validation.ts`: `validate` rejects every `payload_version !== 1`; `packages/weave/src/types.ts`: the observation payload-type list                                                                                                                                                                          | Every Loom observation is version 1 today. Any v2 payload needs a per-type supported-version table in the closed validator; v1 meanings stay unchanged.                                                                                                                                                                                                                                                                                              |
| Single-use authority                           | `packages/agentsop/src/grants.ts`: `Grant`, `GrantAuthority`, `createGrantAuthority`, `grantCovers`; `packages/agentfabric/src/host.ts`: `AgentFabricHost.validateInvocation`, `prepare`, `startPrepared`                                                                                                                       | Issuance is object identity in in-process `WeakSet`s; serialized fields are not authority, and a restart forgets every earlier grant. `markInvoked` consumes acceptance once. Grants also enforce exact declared effects and process effects. Validation rejection can precede consumption; rewrite policy must still retire that attempt's grant.                                                                                                   |
| Failure surface                                | `packages/agentsop/src/failures.ts`: `FailureCode`, `FAILURE_CODES`, `FAILURE_PRECEDENCE`; `packages/agentsop/src/host.ts`: `InvocationRejected`, `InvocationOutcome`, `InvokeOptions`                                                                                                                                          | Rejections have a code and reason; failed outcomes have a string. There is no typed Pydantic/API/stack diagnostic contract or first-class rewrite record. Do not branch on reason strings.                                                                                                                                                                                                                                                           |
| Shape checking                                 | `packages/agentfabric/src/host.ts`: `closedShape`, `validateInvocation`; `packages/agentfabric/src/store.ts`: `normalizeInvocationOutcome`                                                                                                                                                                                      | `closedShape` checks missing/unexpected fields and optional `?` names only; it does no type checking. No host-owned pre-start typed validator exists, so no host attests a pre-start type rejection today. New numeric/API repair must not be attributed to this checker.                                                                                                                                                                            |
| Reconciliation                                 | `packages/agentsop/src/host.ts`: `CapabilityHost.lookup`, `OutcomeLookup`; `packages/agentfabric/src/host.ts`: `AgentFabricHost.lookup`, `reconcile`, `implementationFault`, `finishStep`, `reconcileStoppedRun`; `packages/agentfabric/src/coordinator.ts`: `ResourceCoordinator`                                              | Throws/malformed outcomes with declared writes become uncertain; reservations remain. Host-owner reconciliation durably records committed/not-committed evidence before release. CLI supersession is a special existing path, not permission to change inputs under an existing invocation id.                                                                                                                                                       |
| Durable host and Loom recovery                 | `packages/agentfabric/src/store.ts`: `FabricStore`, `InvocationRecord`, `persistInvocationStart`, `persistInvocationResult`, `persistInvocationUncertain`, `persistInvocationReconciliation`; `packages/weave/src/runtime.ts`: `Runtime.recordResultStep`, `recordReconciledStep`, `reconcileStep`, `load`, `replay`, `recover` | Host records starts and outcomes; `InvocationRecord` extends by optional fields absent in old journals. Loom journals recovery lookup attempts against a finite allowance; `reconcileStep` skips `pending` actions and ends with `drainQueue`. Historical replay does not invoke or reconcile. Reconciliation does not charge an action result twice.                                                                                                |
| Journal guarantees and gaps                    | `packages/weave/src/journal.ts`: `ObservationJournal`, `FileJournal`, `PersistError`; `packages/weave/src/implement-step.ts`: `FileAttemptJournal`, `repairTornTail`, `readEntries`                                                                                                                                             | `FileJournal` uses `appendFileSync` and parses every nonempty line; it has no fsync/torn-tail repair and no writer exclusion. `FileAttemptJournal` fsyncs appends and new directories, repairs a torn final line, poisons an incomplete append, and detects some competing writes by size/inode, but its own comment says this is "best effort, not a lock". Neither journal has a lock or stale-owner rule.                                         |
| Cost and pauses                                | `packages/gateway/src/gateway.ts`: `createInferenceGateway`, `runBounded`; `packages/gateway/src/budget.ts`: `BUDGET_POLICY`, `budgetRoute`; `packages/gateway/src/types.ts`: `InferenceTerms`, `LoopPausedRecord`; `packages/weave/src/audit-loop.ts`: `runAuditLoop`                                                          | Gateway rechecks routing/quota and worst-case cost per provider attempt; `loop.paused` records pauses. A request cost ceiling is not a goal-wide spend ledger. Current non-audit strong work can downgrade under ahead pace; audit cannot. #355's hard mid-loop ceiling is additional work.                                                                                                                                                          |
| Recurring review findings                      | `packages/weave/src/recurring-findings.ts`: `DECLARED_RECURRENCE_POLICY`, `CheckGapRecord`                                                                                                                                                                                                                                      | Existing `capability_gap.check@1` records are evidence, not admission or execution authority. Repeated rewrite findings should become checks through the ordinary contract/corpus/red/green/admission gates.                                                                                                                                                                                                                                         |

Existing evidence inspected includes `packages/weave/test/p8.test.ts` (fresh grants, exhaustion, escalation pause, torn
tails, competing journal writers, uncertainty and replay), `p9.test.ts` (strong audit pause, paid-report crash recovery),
`m1.test.ts` (authority, cancellation and crash recovery), `packages/agentfabric/test/host.test.ts`, `uncertain.test.ts`,
`cli-rerun.test.ts`, and `packages/gateway/test/budget.test.ts`. In particular, retain these named regressions:

- `a real host accepts a fresh grant when a green check is retried after D5 fails`;
- `the equal issuer refuses a wider grant and the step does not invoke one`;
- `resume after a crash repeats no finished attempt and keeps the execution id`;
- `uncertain generation records its invocation and stalls without checks, evaluation, or implicit retry`;
- `ahead pace through the real gateway pauses the audit instead of a standard-tier downgrade`.

## 2. Recommended acceptance boundary

Start with a deterministic, opt-in repair of an argument representation for one registered operation/revision. The
smallest authority-preserving integration point is Loom's failed-result incorporation and candidate formation, feeding
the ordinary scheduler and dispatch. Fabric normalizes and records diagnostics; it does not start a retry loop or ask
Loom questions. A direct recursive call inside `AgentFabricHost.invoke` would bypass current Loom budgets and read sets.

The first vertical case is a read-only or effect-free admitted fixture capability whose schema/API rejects a decimal
string argument, whose registered semantics explicitly equate that string with an integer, and whose corrected call
succeeds. This fixture is a future test, not a claim about an existing production capability. A host `INVALID_INPUT`
rejection can also qualify when its structured diagnostic and a registered repair rule establish the same conditions.

V1 eligibility is restricted everywhere (this section, the §3 taxonomy, §5 admission and PR 4) to registered operations
whose contract declares no write effects and no process effects. An operation with declared effects is ineligible in v1
even when a well-formed structured diagnostic says it was rejected before start: `closedShape` does no type checking, so
no host-attested pre-start type rejection exists at HEAD to trust. Such failures keep today's handling and open a
capability blocker. Every post-start failure of an effectful call reconciles first; even a confirmed not-committed outcome
then opens a blocker, with no automatic rewrite after that resolution. Committed outcomes integrate normally, and
uncertainty remains a reconciliation wait. The declared-effect pre-start path is tracked follow-up F1 (§9): it needs a
host-owned typed validator contract that attests the rejection phase, plus a separate effect/idempotency contract and
captain go.

Rewriting input is not rewriting source, admitting a capability, changing a schema to accept bad input, or deciding that
a red check passed. A rewritten call still passes all its normal checks, output evaluation and completion gates.

## 3. Failure taxonomy and ownership

Classification is deterministic and versioned. The error body is untrusted evidence, including apparent stack frames,
HTTP status, validation suggestions and instructions embedded in it. Only host-owned adapters attest execution phase;
an implementation's claim that it made no writes is insufficient.

| Failure and evidence                                                                                                                                                              | v1 disposition                                                                                                  | Judgment owner                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Structured schema/API argument error; exact registered operation/revision and field rule; operation declares no write or process effects; host-attested rejection or stopped call | Propose one permitted representation edit, then validate it                                                     | Pure deterministic rewriter; deterministic admission owns eligibility                       |
| The same structured error for an operation with declared write or process effects, at any phase                                                                                   | Capability blocker in v1; follow-up F1 requires a host-owned typed validator contract                           | Code; a well-formed diagnostic does not establish effect safety                             |
| API validation response such as 400/422 without structured field evidence or registered semantic equivalence                                                                      | Capability blocker                                                                                              | Code; the HTTP status alone is insufficient                                                 |
| Stack-only error, `RESOLVER_ERROR`, arbitrary failed-outcome string, malformed diagnostics or unsupported schema constraint                                                       | Capability blocker with bounded evidence references                                                             | Code; no regex-based diagnosis of arbitrary prose                                           |
| `DENIED`, malformed resource reference, unknown resource/capability, kind mismatch, invalid catalogue, undeclared/blocked/failed dependency                                       | Capability blocker; never repair permissions, resource identities or dependencies                               | Existing policy and failure precedence                                                      |
| `UNRESOLVED`, `RESOLVER_UNAVAILABLE`, network outage, timeout, rate limit, missing executable/start failure                                                                       | No rewritten call; retain existing bounded retry/pause/escalation handling where available, otherwise a blocker | Existing owner; a rewrite does not invent an availability fallback                          |
| Cancellation, revoked approval/grant, goal pause/stop, expired deadline                                                                                                           | Cancel/pause and retain evidence; no new dispatch                                                               | Loom control state; cancellation never becomes a rewrite error                              |
| Stale read set, changed contract/admission/policy, changed original binding                                                                                                       | Refuse admission; re-observe/reform through ordinary work; no automatic stale-input retry                       | Loom                                                                                        |
| Possible write, process start with effects, interrupted invocation, malformed write outcome, persistence ambiguity                                                                | Reconcile with finite existing allowance; retain locks; then integrate committed outcome or open a blocker      | Trusted host owner and Loom recovery                                                        |
| Check exits nonzero, D5 rejects, admission/held-out check fails                                                                                                                   | Keep current implementation-step/audit handling                                                                 | The check's oracle and existing evaluation gates; repair cannot turn a failed verdict green |

The v1 rule set contains exactly one rule: `decimal-string-to-safe-integer@1`. It accepts only a JSON string matching
`^(0|[1-9][0-9]{0,15})$`, with numeric value at most `9007199254740991`, and the operation's registered inclusive integer
range. It changes exactly the diagnostic's allowlisted non-resource field to that integer. Reject signs, whitespace,
leading zeroes other than `0`, fractions, exponents, overflow, nested edits and all other conversions. No defaults,
field deletion, arbitrary renaming, URL repair, command edits or additional rules are implicit in this plan.

The registration is trusted composition data pinned to operation, contract revision, rule revision, field and semantic
equivalence evidence. A model or error response cannot create it. Registration of an operation whose contract declares
write or process effects is refused in v1. Operation, revision, resource-bearing fields, dependencies, instructions,
argv, destinations, environment, deadlines, success criteria and every other input stay immutable. Equal effect scope
alone cannot establish equal intent: a same-scope command substitution must be rejected.

Recommendation under D-ENG-021 (an issue-brief designation; see §9 assumptions): deterministic repair first; ambiguous failures remain blockers. A later bounded
`call.rewrite` judgment site may propose an edit within the same registered edit language, with its response recorded
as an observation. It cannot attest equivalence, classify away uncertainty, change the allowance or authorize dispatch.
No automatic deterministic-to-model fallback ships in v1. This avoids an unbudgeted second judgment inside one attempt.

## 4. Proposed data contract and versions

All names in this section are proposed. Reuse `Candidate`, `ReadSetEntry`, `ResourceEffect`, `Grant`, `ObservationInput`,
`InvocationOutcome` and their existing ids; do not introduce a parallel generic bound-call framework.

Versioning rule: every durable record whose shape or meaning changes gets a new version or a new record type; no frozen
version acquires a field, nullable field or authority meaning. `validate` in `packages/weave/src/validation.ts` replaces
its global `payload_version !== 1` gate with a closed per-type table of supported versions; every v1 keeps its exact
current validation, reduction and replay. Readers that see an unsupported version fail closed. Fabric store additions
follow the existing optional-field pattern of `InvocationRecord` and carry their own schema tag.

- **`call.failure@1`**: a closed, bounded diagnostic attached optionally to `InvocationRejected` or the failed variant of
  `InvocationOutcome` in `packages/agentsop/src/host.ts`, tagged `schema: 'call.failure@1'`. Preserve `FailureCode` and
  failure-string behavior for legacy callers. Fields: original code, class (`schema` or `api_argument`), operation/contract
  revision, field, expected representation, host-attested phase (`rejected` or `stopped`), sanitized diagnostic digest,
  and truncation flag. Absent or invalid details never qualify. Provider-specific parsing lives in the relevant
  host/adapter, not Loom. Update Fabric's store validation and normalization so valid details survive restart and
  malformed ones fail closed; an `InvocationRecord` without the field reads exactly as today.
- **`action.result@2`**: same result accounting plus optional validated failure details. Keep version 1 readable with its
  old meaning; legacy strings do not acquire rewrite eligibility. Update the closed validator, reducer, host-result
  conversion, replay dispatch and persistence together.
- **`action.started@2` and `action.queued@2`**: the only payloads that can carry a rewrite action. Both add a required
  `rewrite: { chain_id, ordinal }` and require `action_id === "rw:" + chain_id + ":" + ordinal`, where `chain_id` is the
  root action id (`a:<cycle>:<index>`) and `ordinal >= 1`. `queued@2` requires `grant: null`; `started@2` requires a
  grant naming this action. `invocation_id` stays equal to `action_id`. Validation also requires the proposal's exact
  inputs, operation and revision and a §5 chain phase at that ordinal: `queued@2` needs `proposed(k)` or
  `paused(proposed, k)`; a direct `started@2` needs the same, and a drain-time `started@2` needs `queued(k)` or
  `paused(queued, k)` plus the still-`pending` `queued@2` action with the same id, candidate, inputs, read set and
  reservation. `started@1`/`queued@1` keep the `^a:\d+:\d+$` rule and their grant semantics (a v1
  null grant means a contract-less candidate, not deferred authority), so existing queued records replay and drain
  unchanged. `CYCLE_ACTION_ID` does not match `rw:` ids, so `noteCycleNumber` ignores them. Weft does not parse action
  ids: `supersedeKey` in `packages/weave/src/weft.ts` keys by operation and resources, so a same-scope rewrite would
  project as superseding its predecessor. PR 3 records the `rewrite` lineage in Weft instead of inferring it.
- **`call.rewrite@1`**: one closed evidence record, carried as a new Loom observation. Envelope includes stable id, goal
  id, chain id (the root action id), predecessor action/invocation and failure observation, sequence ordinal, policy/rule
  versions, state revision, and expected previous chain revision. Each event names one legal transition from §5.
  Proposal data includes before/after input digests, complete corrected JSON inputs, unchanged operation/revision,
  canonical permissions/effects/process-effect ceiling, read set, dependencies, approval binding digest and rule evidence.
  A `paused` event carries `suspended_phase` and an opaque, versioned gate-evidence reference (§6), not #355's payload.
  The projection links its later candidate, `rw:` action, grant issuance sequence, outcome and stop/blocker evidence.
- **`call.rewrite.policy@1`**: one record per goal, appended before the goal's first rewrite decision and immutable
  after. It pins `max_rewrites` per chain in `[0, 2]` (recommended default `1`) and `max_goal_rewrites` in `[0, 4]`
  (recommended default `2`); `0` in either disables repair. A goal without this record has repair disabled.
- **Allowance**: a chain's counter is the number of admitted `reserved` events, starting at ordinal 1; the original
  invocation is ordinal 0. The goal counter is the number of admitted `reserved` events across all of the goal's chains.
  Each reservation spends one unit of both whether the proposal succeeds, declines, crashes, is cancelled or is denied.
  Never decrement either. A repeated digest or no-op proposal stops immediately. At most `1 + max_rewrites` calls can
  start in one chain and at most `max_goal_rewrites` rewritten calls can start in one goal; a hard issue may stop earlier.
- **Chain identity through lineage**: a chain is keyed by its root action, and lineage resolves through the recorded
  `rewrite` field of `action.started@2`/`queued@2`, never by parsing an id or matching inputs. A failure of an action that
  has rewrite lineage only advances its existing chain (`dispatched(k)` to `reserved(k+1)` or a terminal state); it can
  never be `none -> reserved`, never open a second chain and never refill either allowance. Only an action recorded with
  a v1 start, or a non-rewrite v2 path if one is later defined, can root a chain, and each root roots at most one chain.
- **`capability.blocker@1`**: a distinct blocker record for capability failures, scoped by goal and chain/root action,
  with stable blocker id, reason, failure class, evidence ids and nullable criterion/check associations. It does not
  forge a check/eval source or execution id for an arbitrary action. `open_issue@1` (`OPEN_ISSUE_SCHEMA`,
  `AuditIssue.schema`) and its glossary term stay unchanged; no existing reader has to handle a second shape. Record the
  new blocker in Loom state; it dispatches nothing and cannot itself complete a goal. It does not enter the closed
  `view.audit@1` source union. The implementation-check adapter can produce its truthful existing check-sourced
  `open_issue@1`, citing the capability blocker id, without changing the frozen audit view contract.

Use the observation journal as the durable owner of corrected inputs; no new artifact store is necessary. Limit each
input snapshot and sanitized diagnostic before parsing/recording (proposed 16 KiB inputs and 2 KiB diagnostics); reject
oversized/non-JSON/non-finite/cyclic values. Canonicalize with `packages/weave/src/stable-json.ts`'s `stableStringify` and
hash with `digest`; replay verifies digests before candidate reconstruction. Retain the whole chain with its goal's
observation history. At HEAD `compactContext` in `packages/weave/src/compaction.ts` compacts context tokens and
`TraceRetention` in `packages/weave/src/log-bound.ts` evicts trace projections; neither deletes the observation log.
Keep rewrite reconstruction independent of those projections. Any future journal compaction must retain complete,
verified chain evidence before dropping records.
Missing payloads, unsupported versions or digest disagreement block continuation, never trigger regeneration.

Sensitive inputs remain authorized goal data under the journal's access policy. Diagnostics contain allowlisted fields
and codes, not raw request/response bodies, headers, credentials or stack text. Keep raw stack evidence outside this
feature's records; an opaque authorized evidence reference may cite it. No keys on argv, in error tails, logs, observations
or Weft records. Credential screening is a final check, not disclosure authority.

## 5. Durable transitions, dispatch and recovery

The new projection lives in Loom. Proposed pure code is `packages/weave/src/call-rewrite.ts`; shared diagnostic parsing
belongs in proposed `packages/agentsop/src/call-failure.ts`. Loom admission uses its existing validator/reducer rather
than a second scheduler. There is one writer per goal journal, enforced by PR 1's journal writer lock and the
composition root; a second writer is refused. This does not claim cross-process scheduling. Independent goals/actions
continue concurrently.

**Id scheme.** One scheme only: the chain id is its root action id, and ordinal `k` of that chain is action and
invocation id `rw:<root_action_id>:<k>` (for example `rw:a:3:1:1`). The id is derived deterministically when `reserved`
is admitted and is never reallocated by the cycle loop: the rewrite candidate reaches `select` with its reserved id, and
the rewrite path of `dispatch` uses it for `action_id` and `invocation_id` instead of `` `a:${cycle_no}:${index + 1}` ``.
Because `validateStarted` rejects a second start for an existing non-pending action, the journal admits at most one
start per ordinal. Replay and recovery resolve a chain's action by that id plus the recorded `rewrite` lineage.

1. Incorporate and durably record the failed result first. A deterministic event key identifies the same invocation's
   failure across duplicate callbacks and recovery. Resolve chain identity through lineage (§4): a rewrite action's
   failure advances its own chain only. Classification may immediately append `stopped` plus its capability blocker.
2. Before reserving, check goal state, cancellation, remaining deadline, the goal policy record, both allowances and the
   #355 budget/loop gate. A gate refusal appends `paused(pre_reserve)` and spends no rewrite unit. If eligible,
   atomically validate and append `reserved` against the expected chain revision, spending one unit of each allowance
   and fixing ordinal `k` and id `rw:<root>:<k>`.
3. Run the pure rule and append `proposed`, or append `stopped` for unsupported/no-op/invalid output. Proposal admission
   checks the reserved ordinal, current chain revision, original intent, rule registration, complete inputs and digests.
   A duplicate identical proposal is idempotent; a conflicting duplicate is rejected. No grant exists at this stage.
4. Rebind selectors and process effects against the corrected inputs, canonicalize references, and require equal bound
   permissions/effects/process effects within the original ceiling. Recheck contract/admission, dependencies, read set,
   current goal authority and approvals. Changed binding digests require ordinary matching approval; an earlier approval
   is not portable merely because effects match. The same source revisions must hold; re-observation is separate work.
5. Form a new candidate from the admitted proposal, preserving lineage and the original failure's evidence. Pass through
   frontier policy, `select` and dispatch. Extend candidate formation deliberately; retain failed-candidate suppression.
   There is no separate `dispatching` record: the `action.started@2` append is the `proposed(k) -> dispatched(k)`
   transition and the `action.queued@2` append is `proposed(k) -> queued(k)`, because each payload already carries the
   binding (and the started payload its grant). Started now: as `Runtime.dispatch` does at HEAD, issue the grant through
   the trusted composition-root `GrantAuthority` immediately before the append and call `environment.execute` only after
   the append is accepted. The host call keeps HEAD's normal invocation semantics: `invokeHost` passes only
   `invocation_id` (`runtime.ts`), and `reject_existing` is set at HEAD only by implementation-step checks
   (`implement-step.ts`, `sites/CONTRACT.md`). The rewrite path does not add it: `rw:<root>:<k>` is fresh per ordinal,
   the journal admits one start per id, recovery after a durable start uses `lookup` rather than re-invoking, and
   Fabric's `prepare` already rejects a recorded id under a different action or binding digest, so a predecessor's
   result cannot be replayed under a rewrite id. Queued: append `action.queued@2` with `grant: null`; no grant exists
   while work waits for a slot.
6. When `drainQueue` reaches a rewrite-lineage pending action, it must not reuse `record.grant` or trust a rebuilt
   `eligibility: allowed`, and it skips the action while its chain is `paused(queued, k)`. Before `issueGrant` it calls
   `readSetMatches(record.read_set, state)`, rechecks the contract revision, admission, rule registration, approval
   binding (`approvalStillValid`), goal authority, cancellation and the #355 gate. Success issues a fresh grant and
   appends `action.started@2` (`queued(k) -> dispatched(k)`): the saved proposal, no new unit, proposal or budget
   reservation. A gate pause appends only chain `paused(queued, k)` and leaves the action `pending` with `grant: null`,
   because the `action.cancel_requested` reducer in `state.ts` turns a pending action `cancelled`, after which
   `validateStarted` rejects any start for that id. Any other failure appends the existing `action.cancel_requested`
   (releasing its reservation) and then chain `stopped`; cancelling or stopping `paused(queued, k)` does the same.
   V1 queued records keep today's drain path exactly.
7. Never copy/reuse the old grant, even after a pre-start rejection; revoke/retire it when choosing repair. A grant
   belongs to exactly one attempt; its serialized record cannot be reconstructed as authority.
8. Record terminal result and then `healed` on success, or the next eligible failure/`stopped` on exhaustion. Cancellation
   records `cancelled`, requests host cancellation for active work, and waits for normal settlement/reconciliation.
   `paused`, `cancelled`, `healed` and `stopped` are durable transitions, not inferred from an in-memory return value.

**Closed chain state machine.** Phases are `none`, `reserved(k)`, `proposed(k)`, `queued(k)` (projected from the
accepted `action.queued@2` for `rw:<root>:<k>`; no grant), `dispatched(k)` (projected from the accepted
`action.started@2` for that id; grant issued), `paused(suspended_phase, k)` with
`suspended_phase ∈ {pre_reserve, reserved, proposed, queued}`, and terminal `healed`, `stopped`, `cancelled`. These are
the only legal edges; every other edge, including any edge out of a terminal phase, is rejected by validation:

| From                             | Legal successors                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `none` (root failure)            | `reserved(1)`, `paused(pre_reserve, 1)`, `stopped`                                                                                       |
| `reserved(k)`                    | `proposed(k)`, `paused(reserved, k)`, `cancelled`, `stopped`                                                                             |
| `proposed(k)`                    | `dispatched(k)`, `queued(k)`, `paused(proposed, k)`, `cancelled`, `stopped`                                                              |
| `queued(k)`                      | `dispatched(k)` (drain-time start; saved proposal, fresh grant, no new unit or reservation), `paused(queued, k)`, `cancelled`, `stopped` |
| `dispatched(k)`                  | `healed`; `reserved(k+1)`; `paused(pre_reserve, k+1)`; `cancelled`; `stopped`                                                            |
| `paused(pre_reserve,k)`          | `reserved(k)` (resume; spends the unit then), `cancelled`, `stopped`                                                                     |
| `paused(reserved,k)`             | `proposed(k)` (resume; no new unit), `cancelled`, `stopped`                                                                              |
| `paused(proposed,k)`             | `dispatched(k)` or `queued(k)` (resume with the saved proposal; no new unit or proposal), `cancelled`, `stopped`                         |
| `paused(queued,k)`               | `dispatched(k)` (resume by drain-time start of the still-pending action), `cancelled`, `stopped`                                         |
| `healed`, `stopped`, `cancelled` | none (terminal)                                                                                                                          |

`dispatched(k) -> healed` requires a succeeded result for `rw:<root>:<k>`. `dispatched(k) -> reserved(k+1)` and
`-> paused(pre_reserve, k+1)` require a recorded failed, safe terminal result for that action, an eligible
classification and remaining allowance in both counters. An uncertain result keeps the chain in `dispatched(k)` until
reconciliation; afterwards a committed success is `healed` and every other settlement is `stopped` (no rewrite after
uncertainty). `dispatched(k) -> cancelled` stops the chain; the in-flight action still settles through its own action
record and cannot advance the chain. Resuming rechecks policy; a refused resume appends no chain event and leaves the
pause, with the gate's own record as evidence. A cancelled chain is terminal; new operator work retains its history and
is still charged against the same goal ceilings. Validation fences every append by chain revision and current state.
This table is the PR 2 contract text and the PR 3 exhaustive transition-matrix test. Because transition gaps have now
recurred across two review rounds, PR 3 also parses this table from `CALL-REWRITE-CONTRACT.md` and requires it to equal
the validator's edge set, so the frozen text and code cannot drift apart.

| Interruption/race                                                | Required behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash after `reserved`, before pure proposal                     | Recompute the same pure rule from recorded evidence for that ordinal; no additional reservation or external work.                                                                                                                                                                                                                                                                                                                                                                                    |
| Crash after `proposed`, before the started/queued append         | No durable `action.started@2`/`queued@2` for `rw:<root>:<k>` proves this single-writer runtime never invoked the host for it: `dispatch` calls `environment.execute` only after an accepted, acknowledged (PR 1) append, and any grant issued in the dead process died with its in-memory `GrantAuthority`. The chain is still `proposed(k)`: recheck policy/read set and dispatch the same ordinal and id with a fresh grant, or stop. No pause for owner evidence, no new unit, no duplicate edit. |
| Crash after `action.queued@2`, before the drain-time start       | The chain is `queued(k)` or `paused(queued, k)` and the action is `pending` with `grant: null`; `reconcileStep` skips it and `drainQueue` applies step 6's rechecks before issuing the first grant. No lookup is needed because nothing could have started; no unit, proposal or reservation is added.                                                                                                                                                                                               |
| Crash after durable `action.started@2`, before Loom result       | Existing bounded recovery looks up invocation `rw:<root>:<k>`. Integrate the outcome once. Possible effects retain locks; no rewrite on uncertainty. No second start for that id is admissible.                                                                                                                                                                                                                                                                                                      |
| Persistence failure at any required append                       | No next grant/invoke. Preserve durable prefix, consume any already reserved ordinal, and fail closed until recovery. A failed `action.started@2` append is rejected (as `PersistError` handling does for v1 starts) and does not execute.                                                                                                                                                                                                                                                            |
| Duplicate failure callbacks or two proposals for the same action | First validated expected-revision append wins; duplicate event ids do not spend another unit. A competing writer cannot open the journal.                                                                                                                                                                                                                                                                                                                                                            |
| Failure of a rewritten action                                    | Lineage routes it to its own chain's `dispatched(k)`; it cannot open a new chain or refill allowance.                                                                                                                                                                                                                                                                                                                                                                                                |
| Unrelated actions fail concurrently                              | Separate chains can reserve independently, but still compete for the goal rewrite cap, goal-wide budget, execution slots and effect locks.                                                                                                                                                                                                                                                                                                                                                           |
| Cancellation/revocation races with proposal or queued dispatch   | Recheck at admission and drain. Record cancellation before any later transition; old proposals cannot revive it. If already started, request cancel and retain uncertain holds.                                                                                                                                                                                                                                                                                                                      |
| Late result after pause/recovery                                 | Keep its invocation evidence; integrate only through its owning recorded action. It cannot start a replacement or advance a newer chain revision.                                                                                                                                                                                                                                                                                                                                                    |
| Historical replay                                                | Reconstruct transitions, inputs, counters, blockers and accounting without rewriter/provider/grant issuer/host calls. Unsupported or missing evidence fails replay.                                                                                                                                                                                                                                                                                                                                  |

The "never invoked" inference in the second row holds only with PR 1's acknowledged appends and writer lock; until both
land, rewrite dispatch stays disabled. An unused grant lost in a crash is intentionally not recovered as execution
authority. Durable evidence makes an interruption explainable; it does not make the two stores and in-process grant
issuance one atomic transaction.

## 6. Cost and loop kill-switch dependency (#355 / D-ENG-023)

Treat the brief's D-ENG-023 constraint as binding: rewrites cannot bypass a strong-tier pause or a ceiling. Its separate
decision text is not present at HEAD; do not claim an already implemented new kill-switch API. Agree the child interface
with #355 before enabling live dispatch. Until that interface lands, keep the integrated feature disabled.

PR 3 must not freeze #355's evidence shape. A `call.rewrite@1` `paused` event holds only an opaque, versioned
gate-evidence reference (`{ schema, observation_id }`), and PR 3's validator checks only that it is well-formed and names
an accepted observation. Interpreting it belongs to the #355 interface; PR 4 depends on that agreed interface contract,
not on #355's implementation details (tracked follow-up F2, §9).

The #355 gate must run before reservation, before the drain-time grant, and immediately before every capability
invocation/provider attempt, including recovery lookup, optional future judgment and implementation-step inner repair.
It returns recorded allow/pause/stop evidence under the same goal/cycle budget. Account for projected spend plus existing
reservations, actual usage including failures, and unknown paid outcomes conservatively. New request/action ids never
create a new spending allowance. Cancellation, result persistence and reconciliation settlement can still progress after
a ceiling closes dispatch.

Do not multiply budgets across implementation retries, rewrite attempts and gateway `max_attempts`. A rewrite unit caps
edits/call attempts; provider attempts and action/judgment reservations remain separately bounded and charged to their
existing parent budget. Recovery consumes its existing lookup allowance. Model work, if later admitted, gets only the
remaining parent tokens/cost/deadline and no new independent purse. Loop-depth accounting includes this path.

Preserve current policy evidence accurately: `budgetRoute` presently permits an ahead-pace downgrade for some non-audit
strong work. The rewrite path must not exploit that by dropping `audit`, relabeling a required strong request as working,
or asking again at standard after a pause. Require the original tier where policy requires strong; if unavailable, pause.
D2 ceiling, D4/D7, audit quality, destination/privacy restrictions and acceptance thresholds stay unchanged. No automatic
escalation is added by v1 repair. On rewrite exhaustion, open one capability blocker; an implementation-step owner may
then use only its already bounded escalation policy. Reset time permits a new check, never automatic authority renewal.

## 7. PR slices and red-before-green evidence

These are proposed child scopes, not issues created by this task. Each PR first adds and runs the named behavioral test
against the missing behavior to observe red, then implements the smallest change and proves green in that same PR.
Do not merge failing intermediate commits to main. Contract/test authors must validate negative cases and mutation or
placeholder rejection before trusting generated tests. PR 1 and PR 2 are independent; downstream dependencies follow.

Guard tests that assert something does not happen would pass at HEAD before any implementation, so each one names its
red evidence: a test-only mutation or deliberately broken fixture that the test must catch, run and recorded as the red
step in the same PR, then removed. The mutation lives in the test file or fixture, never in production code.

| PR                                                      | Owned change and dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Named red-before-green tests/checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Durable observation journal                          | Generic `FileJournal` hardening in `packages/weave/src/journal.ts`, no rewrite concepts: acknowledged fsync, directory sync on creation, torn-final-line repair, poisoned partial appends, size/inode competing-write detection (reusing `FileAttemptJournal`'s fsync, directory sync, `repairTornTail` and incomplete-append behavior) and a new writer lock, which `FileAttemptJournal` does not have. Lock: exclusive-create `<journal>.lock` (`openSync(..., 'wx')`, fsynced with its directory) holding a random-free owner id injected by the composition root; a held lock refuses a second writer. Stale owner: the lock is never broken by pid or clock heuristics. A composition-root supervisor that observed its owning process exit opens with `takeover: <recorded owner id>`; takeover succeeds only if the lock still names that owner, replaces it, repairs the torn tail and continues. Every append re-reads the lock and fails closed if displaced, and post-write size/inode checks catch a zombie former writer. Release: `FileJournal` has no close or release at HEAD, so add `release()`; it stops further appends on that instance, then re-reads the lock and unlinks it (and syncs the directory) only if it still names the releasing owner, so a displaced writer's release leaves its successor's lock in place. Composition roots and tests call it on graceful shutdown; an unclean exit or a failed unlink leaves the lock, and supervised takeover remains the only path past it. Retain complete legacy observations and reject corrupt interior records. | New `packages/weave/test/journal-durability.test.ts`: `a torn final line is repaired without losing a complete observation`; `a second writer is refused while the lock is held`; `a released lock accepts a new writer without takeover`; `release by a displaced writer leaves its successor's lock in place`; `a released journal refuses further appends`; `a failed append is not acknowledged and poisons the instance`; `after the owning process is killed, takeover with its recorded owner id recovers deterministically`; `takeover naming a different owner is refused`; `a displaced former writer cannot append after takeover`. Exercise child-process termination (SIGKILL) and injected persistence faults, not just in-memory reload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2. Diagnostic and rewrite contract                      | Freeze the closed taxonomy, JSON bounds, one registered rule, intent restrictions, the v1 no-declared-effects eligibility rule, the §4 record versions, the id scheme and the closed state machine table in proposed `packages/weave/src/CALL-REWRITE-CONTRACT.md`; add shared diagnostic validation, optional host details, Fabric persistence and the pure Loom rule. Add `GLOSSARY.md` entries for **call rewrite**, **rewrite chain**, **rewrite attempt**, **rewrite evidence** and **capability blocker**, and the distinction between a representation edit and implementation regeneration; leave "Open issue" unchanged. No live dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | New `packages/agentfabric/test/call-failure.test.ts`: `structured schema failure survives host restart while malformed detail never becomes eligible`; `an invocation record without failure detail reads unchanged`. New `packages/weave/test/call-rewrite.test.ts`: `only a registered decimal representation edit is proposed`; `same-scope semantic substitution is rejected`; `a declared-effect operation with a valid structured diagnostic is ineligible`; `registering a rule for a declared-effect operation is refused`; boundary table for lexical grammar, numeric range, unsupported stack/API errors, injection, secrets and oversized input. Acceptance also requires the glossary entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3. Durable Loom projection and blocker                  | Depends on 1 and 2. Add `call.rewrite@1`, `call.rewrite.policy@1`, `action.result@2`, `action.started@2`/`queued@2`, `capability.blocker@1`, the per-type version table, closed validation, reducers and replay in `types.ts`, `validation.ts`, `state.ts`, `runtime.ts`, `weft.ts`; pure projection/rule in proposed `call-rewrite.ts`. `paused` stores only an opaque gate-evidence reference. Keep the observation log authoritative through context/trace eviction. Live retry still disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | New `packages/weave/test/call-rewrite-recovery.test.ts`: `duplicate failure records reserve one ordinal`; `a second writer cannot reserve an ordinal` (via PR 1's lock); `a failed append never advances the rewrite projection`; `replay and recovery resolve the chain's action from its reserved rw id`; `Weft links a rewrite to its root from recorded lineage`; `every illegal chain edge is rejected` (exhaustive matrix over the §5 table, including every edge out of a terminal phase); `a drain-time start moves queued(k) to dispatched(k) with no new unit, proposal or reservation`; `a gate pause at drain keeps the queued rewrite action pending and later startable under its rw id`; `the contract transition table equals the validator edge set` (red: a test-only contract fixture missing the `queued(k) -> dispatched(k)` row must be caught); `a failed rewritten call cannot open a new chain or refill allowance`; `the goal rewrite cap bounds independent chains`; `replay reconstructs proposed inputs and counters with zero external calls`; `missing or changed proposal payload blocks continuation`; `legacy action.result@1, action.started@1, action.queued@1 and impl.attempt@1 replay unchanged`; `unsupported payload versions fail closed`; `context compaction and trace eviction cannot lose rewrite evidence`. Red for the version-table guard: a test-only fixture that accepts a v2 shape under v1 must be caught. |
| 4. First vertical retry under policy                    | Depends on 3 and the agreed #355 dispatch-gate interface contract. Wire failed-result processing to candidate formation and ordinary dispatch in `runtime.ts`, `candidates.ts`, relevant composition formation, and `scheduler.ts` only where needed; the rewrite path of `dispatch` uses the reserved `rw:` id; `drainQueue` gets step 6's rechecks for rewrite-lineage work. Enable only registered operations with no declared write or process effects. No host-recursive retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | New `packages/weave/test/call-rewrite-integration.test.ts`: `a 422 with structured field evidence and registered equivalence rewrites once then succeeds under a fresh equal-scope grant`; `a bare API 422 with no structured field detail opens a blocker` (red: a test-only classifier fixture that treats the HTTP status alone as eligible must be caught); `rewrite exhaustion opens one blocker before a fourth invoke and cannot refill budget on restart`; `old single-use grant cannot invoke again` (red: a test-only dispatch wrapper that passes the predecessor's grant must be caught); `queued rewrite work carries no grant until drain`; `stale read set at queue drain prevents a fresh grant` (red: a drain fixture that skips `readSetMatches` must be caught); `changed binding requires matching approval`; `ceiling closes before next invoke`; `required strong pause produces no standard fallback`; `a declared-effect operation is never rewritten`. For max 2, assert at most 3 starts and exact action/provider/lookup accounting.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5. Crash, cancellation and concurrency acceptance       | Depends on 4; required before enabling outside the fixture. Use real Fabric stores and subprocess crashes, injected clock and deterministic interleavings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Extend `call-rewrite-recovery.test.ts`: `crash between decision and grant keeps one reserved ordinal`; `subprocess crash after proposed and before the started append reaches the next start or a terminal phase without operator input`; `crash after a durable start never admits a second start for that id`; `crash after host start reconciles without duplicate invocation`; `crash after queued rewrite drains with a fresh rechecked grant`; `concurrent same-action failures admit one replacement`; `cancel or revoke before dispatch starts nothing`; `uncertain writes retain locks and never rewrite even after not_committed`; `unrelated chains progress within the shared ceiling and goal cap`; `replay never invokes a host or rewriter` (red: a test-only replay host that records calls must report one when the replay guard is removed in the fixture).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6. Implementation-step adapter and boundary regressions | Depends on 5 and #355; opt-in use in `implement-step.ts`/composition roots only for qualifying invocation protocol failures. Keep real red check verdicts and D5 handling unchanged. Carry rewrite lineage in a separate closed record, proposed `impl.rewrite@1`, added as a third `JournalEntry` variant of the attempt journal: its own id plus foreign keys `execution_id`, attempt number, logical check id, check invocation ids, chain root and ordinal. It is appended before the repaired check invocation, so it keys the attempt by `(execution_id, attempt)` rather than an `impl.attempt@1` entry id that is written only when the attempt finishes. `impl.attempt@1` and `impl.stop@1` payloads gain no field and read unchanged (§4); `readEntries` admits the new schema only through an explicit closed list, so an older binary fails closed on it rather than misreading it. No `impl.attempt@2` is planned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Extend `packages/weave/test/p8.test.ts`: `check protocol repair does not regenerate or reset the step retry allowance`; `red check output is never rewritten into success` (red: a test-only rule fixture that maps a nonzero exit to success must be caught); `inner repair exhaustion preserves one check-sourced open issue and the existing escalation bound`; `pause and restart cannot reset issuer or rewrite counters`; `impl.rewrite@1 links repair lineage while impl.attempt@1 entries read unchanged` (red: a test-only fixture that writes lineage as a field on `impl.attempt@1` must be rejected by `readEntries`). Add the benchmark isolation test below and run existing p8/p9, uncertainty, authority and credential regressions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The implementation adapter's chain key is bound to the implementation execution id and logical check identity, with
recorded root lineage preserved across generation retries and pause/resume. Reconstruct spent issuance/repair allowance
from durable entries before creating an issuer; do not enlarge `retries + 2` and call that a budget. A new generation can
still run its ordinary checks; it does not refill the earlier repair allowance. Its check oracle, argv and environment
remain immutable, and every actual invocation receives its own grant and parent budget reservation.

For each implementation PR, run the narrow new tests first, then `npm run verify` and relevant mutation/negative checks.
Use repository checks including import direction, ambient clock/entropy/environment, swallowed failures and credential
parity. No hosted benchmark run is requested here. Any later comparative evaluation reserves independent adversarial and
held-out cases before tuning, verifies provenance/license, names its exact external destination and sanitizes disclosure
or obtains authorization before sending benchmark-derived content.

## 8. Benchmark and architecture guardrails

`benchmarks/decision-sites/providers.ts` builds direct benchmark routes with `shuffle: false`;
`benchmarks/inference/jev/run.ts` pins the request shuffle setting. Existing tests include
`benchmarks/inference/jev/test/reference.test.ts`'s
`reference gateway factory sends the pin and corpus order with no guardrail or shuffle fields` and
`benchmarks/decision-sites/test/nous.test.ts`'s explicit no-shuffle/no-guardrail request assertion. Preserve their route
semantics, including the documented gateway-routed Muse Spark competitor exception.

Add `production call repair cannot wrap direct benchmark requests` to the reference/provider test boundary: capture the
wire request and assert unchanged question/order, no rewrite retry, no guardrail fields, no hidden shuffling and unchanged
route identity. Its red evidence is a test-only wrapper that does apply the rewrite path (and a guardrail field and
reordering) to the benchmark route; the test must fail against that wrapper before it is removed. Do not add global
gateway/adapter interceptors, change frozen corpus bytes, or silently apply production repair to a benchmark route. The
fixture integration test is not evidence of model quality.

Keep Loom independent of providers and tool protocols. Fabric may depend on AgentSOP and gateway but must not import
Loom scheduling/state. Gateway imports no runtime. The new decision, admission and projection functions are pure:
injected observations, clock ticks/ports and recorded versions determine their output. Filesystem/process/network work
stays at existing host, journal and composition boundaries. No ambient clock, entropy, environment or credentials enter
the policy functions. Enforce `checks/import-direction.mjs`, `no-ambient-clock.mjs`, `no-ambient-entropy.mjs`,
`no-ambient-env.mjs`, `no-swallowed-failures.mjs` and `checks/test/credential-parity.test.mjs`; never add an exception merely
to pass. Repeated review findings become a targeted lint or behavioral regression, with a red fixture proving detection.
Unversioned durable record changes have now been raised across review rounds, so PR 3's version-table test is that
regression for Loom payloads.

## 9. Recommendations, owner forks, follow-ups and assumptions

Architectural/code-health recommendations under D-ENG-021 are concrete: choose the deterministic registered rule first;
keep policy in Loom and error normalization at the host edge; use one durable chain in the observation journal, keyed by
root action and resolved through lineage; use `rw:<root>:<k>` ids carried by versioned start/queued payloads and no
separate dispatching record; keep a closed state machine that distinguishes `queued(k)` from `dispatched(k)`; keep
HEAD's normal invocation semantics for rewrite invocations; preserve single-use grants and generic read-set revalidation
at drain; open a distinct `capability.blocker@1` on exhaustion; require the #355 interface before live dispatch; restrict
v1 to operations without declared effects. These are recommendations for plan acceptance, not questions delegated to
Benjamin.

Product forks for Benjamin remain open until captain go:

1. Should automatic repair be enabled for explicitly registered operations by default, or require per-goal opt-in?
   Recommend opt-in initially; absence of a decision keeps it disabled.
2. Accept the proposed defaults (one rewrite per chain, hard maximum two; two per goal, hard maximum four), or choose
   smaller allowances? The implementation contract must pin finite values before execution; no runtime model chooses them.
3. Should a later product milestone fund model-assisted proposals for ambiguous failures, or keep them operator-visible
   blockers? V1 needs no model site; approving this plan does not authorize that later milestone.

Tracked follow-ups, not part of v1:

- **F1 declared-effect pre-start repair.** Requires a host-owned typed validator contract that attests a pre-start
  rejection phase (today's `closedShape` does no type checking), an effect/idempotency contract and captain go.
- **F2 #355 gate-evidence interface.** From the review's follow-up note: PR 3 records `paused` with only an opaque,
  versioned gate-evidence reference, and PR 4 depends on the agreed #355 interface contract, so PR 3 cannot freeze a
  pause record that #355 later contradicts. D-ENG-023's text is still absent at HEAD.

PR 2 adds the glossary definitions for **call rewrite**, **rewrite chain**, **rewrite attempt**, **rewrite evidence** and
**capability blocker** as part of its acceptance; "Open issue" keeps its current meaning. Do not add a new BoundCall term
when action candidate already fits. This task leaves `GLOSSARY.md` unchanged. No vision acceptance boundary is changed by
the proposed bounded path.

Assumptions requiring explicit verification in the children: a host adapter can attest the stopped/rejected phase without
trusting error prose; the selected operation has reviewed semantic equivalence for the one allowed conversion; the
composition root can supply a stable owner id and observe its journal owner's exit for takeover; #355 supplies durable
goal/cycle admission and strong-pause semantics. D-ENG-021 (concrete recommendations for architecture/code-health
questions; only product forks go to the owner) and D-ENG-023 (rewrites cannot bypass a strong-tier pause or ceiling) come
from the issue brief; neither designation is defined anywhere in the repository at `9ce2ff2` outside this plan, so both
are recorded assumptions rather than verified repository decisions. If any assumption fails, leave repair disabled and preserve the original
failure/blocker. Neither a recovered journal nor a model answer creates missing authority.

Acceptance of this parent requires agreement on taxonomy, record/state contract, child dependencies, the unresolved
product forks and the #355 boundary. Implementation remains blocked on captain go.

## 10. Verification of this planning change

Plan3 rechecked at `9ce2ff2` (identical source to `ba3a753` and `0281c5e`): `Runtime.dispatch` appends before
`environment.execute` and `invokeHost` passes only `invocation_id` (`runtime.ts`); `reject_existing` is set only at
`implement-step.ts`'s check invocation and honored in `AgentFabricHost.prepare`, which also rejects a recorded id under a
different action or binding digest; the `action.cancel_requested` reducer in `state.ts` moves a pending action to
`cancelled`, and `validateStarted` then rejects a start for it; `FileJournal` has no release method; `readEntries`
accepts only `impl.attempt@1` and `impl.stop@1`; and no file other than `PLAN.md` mentions D-ENG-021 or D-ENG-023.

Plan2 rechecked the inventory's paths and symbols at `ba3a753`, including that review's new citations: action-id allocation
and `invocation_id = action_id` in `runtime.ts`, `validateStarted`'s id rule and the global version gate in
`validation.ts`, the v1 `grant: Grant | null` field in `types.ts`, `CYCLE_ACTION_ID` and Weft's `supersedeKey`,
`drainQueue`'s grant reuse and `eligibility: allowed`, `stillAuthorized`, `readSetMatches`,
`candidateId`, `failedCandidateIds`, `createGrantAuthority`, `closedShape`, `FileJournal`, `FileAttemptJournal` and the
`open_issue@1` readers. Using the installed Node 22 toolchain, `npm run fmt:check` passes for plan3. The first plan
revision's `npm run check`/`npm test` results (seven sandbox-related failures from `spawnSync ... EPERM` and
`listen EPERM`) were not rerun because plan2 and plan3 change only `PLAN.md`; a fully green suite is not established here. No check or fixture
was weakened. The only tracked deliverable is `PLAN.md`; no push is part of this task.

## 11. Review finding map (`ba3a753`)

| Review location                       | Resolution in this plan                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| §5 steps 2/6, §7 PR 3/4: id scheme    | §5 id scheme `rw:<root>:<k>` via `action.started@2`/`queued@2` (§4); PR 3 id-resolution test                             |
| §5 crash after dispatching            | `dispatching` removed; started/queued append is the transition; §5 recovery row; PR 5 subprocess-crash test              |
| §2 vs §7 PR 4: effect scope           | §2, §3, §4 registration and PR 4 restricted to no declared effects; F1; PR 2 ineligibility tests                         |
| §5 legal transitions                  | Closed state-machine table with `paused(suspended_phase)` and terminal phases; PR 3 exhaustive matrix test               |
| §4/§5 lineage and unbounded chains    | §4 chain identity through lineage and `max_goal_rewrites`; PR 3 lineage and goal-cap tests                               |
| §5 step 5, PR 4: queued without grant | `action.queued@2` with `grant: null`; §5 step 6 drain rechecks; v1 queued unchanged; PR 3 legacy replay, PR 4 drain test |
| §7 PR 1: rewrite tests and stale lock | PR 1 generic `journal-durability.test.ts`; lock and takeover specified; rewrite ordinal tests moved to PR 3              |
| §7/§8 guard tests without red         | §7 red-evidence rule; named mutations for each guard test in PR 3–6 and §8                                               |
| §4 `open_issue@2`                     | Replaced by `capability.blocker@1`; `open_issue@1` and its glossary term unchanged                                       |
| §9 glossary unassigned                | Glossary entries assigned to PR 2 acceptance                                                                             |
| §6/PR 4 #355 dependency (follow-up)   | Opaque versioned gate-evidence reference in PR 3; PR 4 depends on the agreed interface; F2                               |

## 12. Review disposition (GLM review of `9ce2ff2`)

All six findings were verified against `9ce2ff2` and accepted; none was rejected.

| Severity | Review location                         | Verified at `9ce2ff2`                                                                                                                                                            | Disposition                                                                                                                                                                                                                                                                                           |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| error    | §4 started@2/queued@2, §5 table, step 6 | Confirmed. Also found that step 6's gate pause appended `action.cancel_requested`, which the `state.ts` reducer turns `cancelled`, so `validateStarted` would refuse the resume. | Fixed: new `queued(k)` and `paused(queued, k)` phases with `queued(k) -> dispatched(k)`; the undefined `pending` chain phase is replaced in §4; a drain gate pause leaves the action pending. PR 3 adds the queued-edge tests and a contract-table/validator parity test (repeat-finding regression). |
| error    | §5 step 5 `reject_existing`             | Confirmed: `Runtime.dispatch`/`invokeHost` pass only `invocation_id`; only the `implement-step.ts` check invocation sets `reject_existing`.                                      | Fixed: claim removed. Recommendation is to keep HEAD's normal invocation semantics for `rw:` ids (fresh id per ordinal, one start per id, `lookup` on recovery, `prepare`'s action/binding checks), so no new host option or test is proposed.                                                        |
| warning  | §7 PR 1 writer lock                     | Confirmed: no release path; `FileJournal` has no release method.                                                                                                                 | Fixed: owner-checked `release()` that unlinks only its own lock; takeover stays the only path after unclean exit. Three release tests added to `journal-durability.test.ts`.                                                                                                                          |
| warning  | §7 PR 6 lineage attachment              | Confirmed: an attachment on `impl.attempt@1` contradicts §4's versioning rule.                                                                                                   | Fixed: separate closed `impl.rewrite@1` attempt-journal record keyed by `(execution_id, attempt)` because it precedes the attempt's entry; `impl.attempt@1` unchanged; PR 6 regression with a red fixture.                                                                                            |
| warning  | §7 PR 4 vs §3 422 classification        | Confirmed: the test name contradicted §3's bare-status row.                                                                                                                      | Fixed: test restated with structured evidence and registered equivalence; added `a bare API 422 with no structured field detail opens a blocker` with named red evidence.                                                                                                                             |
| note     | §3, §6, §9 D-ENG-021                    | Confirmed: D-ENG-021 and D-ENG-023 appear only in `PLAN.md`.                                                                                                                     | Fixed: §9 assumptions record both as issue-brief designations not verifiable in the repository; §3 cross-references it.                                                                                                                                                                               |
