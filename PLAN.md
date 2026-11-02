# WV-354: self-healing rewrite on capability failure

Status: proposed architecture parent; **captain go is required before implementation**. This task adds only this plan.
No child issues, source, tests, schemas, glossary entries, or benchmark data are changed here.

Inventory baseline: `0281c5ed13ee0b3fbedd50399f9ed19837a58c17` on `wv-354-self-heal-plan`.
Read `VISION.md`, `GLOSSARY.md`, and the current implementation and tests before preparing this proposal.
`gh issue view 354 --repo CrowBe/weave` failed to connect to `api.github.com`; the GitHub connector subsequently returned
[#354](https://github.com/CrowBe/weave/issues/354), its empty comment list, and
[#355](https://github.com/CrowBe/weave/issues/355). This is a plan for rewritten calls, not permission to modify a running
implementation or relax its contract.

## 1. Inventory at HEAD

Paths and symbols below exist at the baseline. Names introduced later in this document are explicitly proposals.

| Existing mechanism                             | Exact files and symbols                                                                                                                                                                                                                                                                                                         | Boundary relevant to this plan                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation-step retry and escalation       | `packages/weave/src/implement-step.ts`: `runImplementationStep`, `actionFor`, `feedbackPrompt`, `DEFAULT_IMPLEMENT_RETRIES`                                                                                                                                                                                                     | Default two same-tier retries, then one escalation above the input tier, bounded by the ceiling and budget port. Regenerates implementation work; does not rewrite an arbitrary invocation.                                                                                                                                                                |
| Check invocation and fresh grants              | Same file: `runChecks`, `freshCheckGrant`, `sameGrantScope`, `createEqualGrantIssuer`, `EqualGrantIssuer`                                                                                                                                                                                                                       | Fresh grants match operation, contract revision, permissions, effects and process effects. Issuer limit is `retries + 2`, held in memory per issuer. It is not a durable allowance for a nested rewrite loop.                                                                                                                                              |
| Step evidence and open issues                  | Same file: `AttemptRecord`, `StopRecord`, `OpenIssue`, `AttemptJournal`, `FileAttemptJournal`, `replayImplementationStep`                                                                                                                                                                                                       | Existing versions are `impl.step@1`, `impl.attempt@1`, `impl.stop@1`, `open_issue@1`. `OpenIssue.source` is only `check` or `eval`; it cannot honestly represent a general capability blocker. Finished attempts are journaled before continuation.                                                                                                        |
| Audit escalation and loop stops                | `packages/weave/src/audit-loop.ts`: `runAuditLoop`, `AuditJournal`, `AuditRound`, `AuditCheckpoint`, `AuditIssue`; `packages/weave/src/audit-view.ts`: `AuditIssue`, `assembleAuditState`                                                                                                                                       | Audit generates at `strong` with `audit: true`; budget pauses and unconfirmed paid dispatch are explicit. The two `AuditIssue` interfaces and the implementation-step `OpenIssue` are distinct types. The audit view accepts sources `check`, `eval`, `audit`.                                                                                             |
| Bound calls                                    | `packages/weave/src/types.ts`: `Candidate`, `ActionStartedPayload`, `ActionRecord`; `packages/agentsop/src/contracts.ts`: `CapabilityContract`, `bindSelectors`; `packages/agentsop/src/process-effects.ts`: `bindProcessEffects`                                                                                               | There is no existing `BoundCall` type. Reuse the candidate's operation, revision, inputs, evidence, dependencies, read set, effects and reservation. Selector binding checks resource references, not arbitrary semantic correctness.                                                                                                                      |
| Candidate identity and failed-call suppression | `packages/weave/src/candidates.ts`: `formCandidates`, `failedCandidateIds`, `bindingDigest`, `matchingApproval`, `approvalStillValid`; `packages/weave/src/digest.ts`: `candidateId`; `packages/weave/src/normalize.ts`: `formNormalizeCandidates`                                                                              | Failed candidate identities are suppressed. A rewrite must produce a newly validated candidate with explicit lineage; deleting suppression or changing an id to rerun the same inputs would defeat the existing loop guard. Composition-specific formation has its own suppression too.                                                                    |
| Scheduling, read sets and dispatch             | `packages/weave/src/scheduler.ts`: `select`, `rejectReason`; `packages/weave/src/state.ts`: `readSetMatches`; `packages/weave/src/runtime.ts`: `Runtime.dispatch`, `stillAuthorized`, `issueGrant`, `drainQueue`, `invokeHost`                                                                                                  | Scheduler checks dependencies, effect conflicts, budget and source revisions. Dispatch journals a start/queue before execution. `stillAuthorized` specifically reforms `report.publish`; this is not a generic revalidation guarantee for arbitrary rewritten inputs.                                                                                      |
| Single-use authority                           | `packages/agentsop/src/grants.ts`: `Grant`, `GrantAuthority`, `createGrantAuthority`, `grantCovers`; `packages/agentfabric/src/host.ts`: `AgentFabricHost.validateInvocation`, `prepare`, `startPrepared`                                                                                                                       | Issuance depends on object identity; serialized fields are not authority. `markInvoked` consumes acceptance once. Grants also enforce exact declared effects and process effects. Validation rejection can precede consumption; rewrite policy must still retire that attempt's grant.                                                                     |
| Failure surface                                | `packages/agentsop/src/failures.ts`: `FailureCode`, `FAILURE_CODES`, `FAILURE_PRECEDENCE`; `packages/agentsop/src/host.ts`: `InvocationRejected`, `InvocationOutcome`, `InvokeOptions`                                                                                                                                          | Rejections have a code and reason; failed outcomes have a string. There is no typed Pydantic/API/stack diagnostic contract or first-class rewrite record. Do not branch on reason strings.                                                                                                                                                                 |
| Shape checking                                 | `packages/agentfabric/src/host.ts`: `closedShape`, `validateInvocation`; `packages/agentfabric/src/store.ts`: `normalizeInvocationOutcome`                                                                                                                                                                                      | `closedShape` checks missing/unexpected fields and optional `?` names. It does not validate all type-name semantics or implement JSON Schema/Pydantic. New numeric/API repair must not be attributed to this checker.                                                                                                                                      |
| Reconciliation                                 | `packages/agentsop/src/host.ts`: `CapabilityHost.lookup`, `OutcomeLookup`; `packages/agentfabric/src/host.ts`: `AgentFabricHost.lookup`, `reconcile`, `implementationFault`, `finishStep`, `reconcileStoppedRun`; `packages/agentfabric/src/coordinator.ts`: `ResourceCoordinator`                                              | Throws/malformed outcomes with declared writes become uncertain; reservations remain. Host-owner reconciliation durably records committed/not-committed evidence before release. CLI supersession is a special existing path, not permission to change inputs under an existing invocation id.                                                             |
| Durable host and Loom recovery                 | `packages/agentfabric/src/store.ts`: `FabricStore`, `InvocationRecord`, `persistInvocationStart`, `persistInvocationResult`, `persistInvocationUncertain`, `persistInvocationReconciliation`; `packages/weave/src/runtime.ts`: `Runtime.recordResultStep`, `recordReconciledStep`, `reconcileStep`, `load`, `replay`, `recover` | Host records starts and outcomes. Loom journals recovery lookup attempts against a finite allowance. Historical replay does not invoke or reconcile. Reconciliation does not charge an action result twice.                                                                                                                                                |
| Journal guarantees and gaps                    | `packages/weave/src/journal.ts`: `ObservationJournal`, `FileJournal`, `PersistError`; `packages/weave/src/implement-step.ts`: `FileAttemptJournal`, `repairTornTail`, `readEntries`                                                                                                                                             | `FileJournal` uses `appendFileSync` and parses every nonempty line; it has no fsync/torn-tail repair. `FileAttemptJournal` already fsyncs appends, repairs a torn final line and detects some competing writes, but explicitly requires an exclusive writer. Do not claim power-loss durability or atomic multiwriter admission for `FileJournal` at HEAD. |
| Cost and pauses                                | `packages/gateway/src/gateway.ts`: `createInferenceGateway`, `runBounded`; `packages/gateway/src/budget.ts`: `BUDGET_POLICY`, `budgetRoute`; `packages/gateway/src/types.ts`: `InferenceTerms`, `LoopPausedRecord`; `packages/weave/src/audit-loop.ts`: `runAuditLoop`                                                          | Gateway rechecks routing/quota and worst-case cost per provider attempt; `loop.paused` records pauses. A request cost ceiling is not a goal-wide spend ledger. Current non-audit strong work can downgrade under ahead pace; audit cannot. #355's hard mid-loop ceiling is additional work.                                                                |
| Recurring review findings                      | `packages/weave/src/recurring-findings.ts`: `DECLARED_RECURRENCE_POLICY`, `CheckGapRecord`                                                                                                                                                                                                                                      | Existing `capability_gap.check@1` records are evidence, not admission or execution authority. Repeated rewrite findings should become checks through the ordinary contract/corpus/red/green/admission gates.                                                                                                                                               |

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

Initial scope permits host-attested pre-start rejection, including an operation with declared effects, but excludes every
post-start call with declared writes or process effects. Such failures reconcile first;
even a confirmed not-committed outcome then opens a blocker in v1. There is no automatic rewrite after that resolution.
Committed outcomes integrate normally, and uncertainty remains a reconciliation wait. This one rule applies throughout
taxonomy, recovery and tests. Extending it later requires a separate effect/idempotency contract and captain go.

Rewriting input is not rewriting source, admitting a capability, changing a schema to accept bad input, or deciding that
a red check passed. A rewritten call still passes all its normal checks, output evaluation and completion gates.

## 3. Failure taxonomy and ownership

Classification is deterministic and versioned. The error body is untrusted evidence, including apparent stack frames,
HTTP status, validation suggestions and instructions embedded in it. Only host-owned adapters attest execution phase;
an implementation's claim that it made no writes is insufficient.

| Failure and evidence                                                                                                                                                        | v1 disposition                                                                                                   | Judgment owner                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Structured schema/API argument error; exact registered operation/revision and field rule; host-attested pre-start rejection, or stopped call with no writes/process effects | Propose one permitted representation edit, then validate it                                                      | Pure deterministic rewriter; deterministic admission owns eligibility                       |
| API validation response such as 400/422 without structured field evidence or registered semantic equivalence                                                                | Hard open issue                                                                                                  | Code; the HTTP status alone is insufficient                                                 |
| Stack-only error, `RESOLVER_ERROR`, arbitrary failed-outcome string, malformed diagnostics or unsupported schema constraint                                                 | Hard open issue with bounded evidence references                                                                 | Code; no regex-based diagnosis of arbitrary prose                                           |
| `DENIED`, malformed resource reference, unknown resource/capability, kind mismatch, invalid catalogue, undeclared/blocked/failed dependency                                 | Hard open issue; never repair permissions, resource identities or dependencies                                   | Existing policy and failure precedence                                                      |
| `UNRESOLVED`, `RESOLVER_UNAVAILABLE`, network outage, timeout, rate limit, missing executable/start failure                                                                 | No rewritten call; retain existing bounded retry/pause/escalation handling where available, otherwise open issue | Existing owner; a rewrite does not invent an availability fallback                          |
| Cancellation, revoked approval/grant, goal pause/stop, expired deadline                                                                                                     | Cancel/pause and retain evidence; no new dispatch                                                                | Loom control state; cancellation never becomes a rewrite error                              |
| Stale read set, changed contract/admission/policy, changed original binding                                                                                                 | Refuse admission; re-observe/reform through ordinary work; no automatic stale-input retry                        | Loom                                                                                        |
| Possible write, process start with effects, interrupted invocation, malformed write outcome, persistence ambiguity                                                          | Reconcile with finite existing allowance; retain locks; then integrate committed outcome or open issue           | Trusted host owner and Loom recovery                                                        |
| Check exits nonzero, D5 rejects, admission/held-out check fails                                                                                                             | Keep current implementation-step/audit handling                                                                  | The check's oracle and existing evaluation gates; repair cannot turn a failed verdict green |

The v1 rule set contains exactly one rule: `decimal-string-to-safe-integer@1`. It accepts only a JSON string matching
`^(0|[1-9][0-9]{0,15})$`, with numeric value at most `9007199254740991`, and the operation's registered inclusive integer
range. It changes exactly the diagnostic's allowlisted non-resource field to that integer. Reject signs, whitespace,
leading zeroes other than `0`, fractions, exponents, overflow, nested edits and all other conversions. No defaults,
field deletion, arbitrary renaming, URL repair, command edits or additional rules are implicit in this plan.

The registration is trusted composition data pinned to operation, contract revision, rule revision, field and semantic
equivalence evidence. A model or error response cannot create it. Operation, revision, resource-bearing fields,
dependencies, instructions, argv, destinations, environment, deadlines, success criteria and every other input stay
immutable. Equal effect scope alone cannot establish equal intent: a same-scope command substitution must be rejected.

Recommendation under D-ENG-021: deterministic repair first; ambiguous failures remain blockers. A later bounded
`call.rewrite` judgment site may propose an edit within the same registered edit language, with its response recorded
as an observation. It cannot attest equivalence, classify away uncertainty, change the allowance or authorize dispatch.
No automatic deterministic-to-model fallback ships in v1. This avoids an unbudgeted second judgment inside one attempt.

## 4. Proposed data contract and versions

All names in this section are proposed. Reuse `Candidate`, `ReadSetEntry`, `ResourceEffect`, `Grant`, `ObservationInput`,
`InvocationOutcome` and their existing ids; do not introduce a parallel generic bound-call framework.

- **`call.failure@1`**: a closed, bounded diagnostic attached optionally to `InvocationRejected` or the failed variant of
  `InvocationOutcome` in `packages/agentsop/src/host.ts`. Preserve `FailureCode` and failure-string behavior for legacy
  callers. Fields: original code, class (`schema` or `api_argument`), operation/contract revision, field, expected
  representation, host-attested phase (`rejected` or `stopped`), sanitized diagnostic digest, and truncation flag.
  Absent or invalid details never qualify. Provider-specific parsing lives in the relevant host/adapter, not Loom.
  Update Fabric's store validation and normalization so valid details survive restart and malformed ones fail closed.
- **`action.result` payload version 2**: same result accounting plus optional validated failure details. Keep version 1
  readable with its old meaning; legacy strings do not acquire rewrite eligibility. Update the closed validator, reducer,
  host-result conversion, replay dispatch and persistence together. Do not silently add authority semantics to version 1.
- **`call.rewrite@1`**: one closed evidence record, carried as a new version-1 Loom observation. Envelope includes stable
  id, goal id, root action id, predecessor action/invocation and failure observation, sequence ordinal, policy/rule
  versions, state revision, and expected previous chain revision. Each event has one of the transitions below.
  Proposal data includes before/after input digests, complete corrected JSON inputs, unchanged operation/revision,
  canonical permissions/effects/process-effect ceiling, read set, dependencies, approval binding digest and rule evidence.
  The projection links its later candidate, action, invocation, grant issuance sequence, outcome and stop/issue evidence.
- **Allowance**: immutable `max_rewrites` in `[0, 2]`, recommended default `1`, recorded before the first decision;
  `0` disables repair. The counter is the number of admitted `reserved` events, starting at ordinal 1. Original invocation
  is ordinal 0. Each reservation spends one unit whether proposal succeeds, declines, crashes, is cancelled or is denied.
  Never decrement it. A repeated digest or no-op proposal stops immediately. At most `1 + max_rewrites` calls can start
  in that chain; a hard issue may stop it earlier.
- **Blocker**: propose `open_issue@2` for capability failures, scoped by goal and root action, with source `capability`,
  stable issue id, reason, evidence ids and nullable criterion/check associations. Do not forge a check/eval source or
  execution id for an arbitrary action. Existing `open_issue@1` remains unchanged for implementation-step/audit records.
  Record the new blocker in Loom state; it dispatches nothing and cannot itself complete a goal. Initially it need not
  enter the closed `view.audit@1` source union. The implementation-check adapter can produce its truthful existing
  check-sourced `open_issue@1`, citing the rewrite blocker, without changing the frozen audit view contract.

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
than a second scheduler. There is one writer per goal journal, enforced by the composition root; reject a second writer.
This does not claim cross-process scheduling. Independent goals/actions continue concurrently.

1. Incorporate and durably record the failed result first. A deterministic event key identifies the same invocation's
   failure across duplicate callbacks and recovery. Classification may immediately append `stopped` plus its blocker.
2. Before reserving, check goal state, cancellation, remaining deadline, allowance and #355 budget/loop gate. A budget
   refusal appends `paused` and spends no rewrite unit. If eligible, atomically validate and append `reserved` against the
   expected chain revision, spending one unit and assigning its stable ordinal and future action/invocation ids.
3. Run the pure rule and append `proposed`, or append `stopped` for unsupported/no-op/invalid output. Proposal admission
   checks the reserved ordinal, current chain revision, original intent, rule registration, complete inputs and digests.
   A duplicate identical proposal is idempotent; a conflicting duplicate is rejected. No grant exists at this stage.
4. Rebind selectors and process effects against the corrected inputs, canonicalize references, and require equal bound
   permissions/effects/process effects within the original ceiling. Recheck contract/admission, dependencies, read set,
   current goal authority and approvals. Changed binding digests require ordinary matching approval; an earlier approval
   is not portable merely because effects match. The same source revisions must hold; re-observation is separate work.
5. Form a new candidate from the admitted proposal, preserving lineage and the original failure's evidence. Pass through
   frontier policy, `select` and dispatch. Extend candidate formation deliberately; retain failed-candidate suppression.
   Recheck freshness and authority again when a queued candidate drains, immediately before issuing its grant. For a
   rewrite, queue the bound work without an execution grant; issuance waits until a slot can actually start it. This is
   a deliberate change from current `Runtime.dispatch`, which issues even for queued work.
6. Append `dispatching` before issuance, with the reserved action/invocation ids, exact binding and reservation. Issue
   through the trusted composition-root `GrantAuthority`, journal the normal start, and invoke using that new identity
   and `reject_existing: true`. Never copy/reuse the old grant, even after a pre-start rejection. Revoke/retire it when
   choosing repair. A grant belongs to exactly one attempt; its serialized record cannot be reconstructed as authority.
7. Record terminal result and then `healed` on success, or the next eligible failure/`stopped` on exhaustion. Cancellation
   records `cancelled`, requests host cancellation for active work, and waits for normal settlement/reconciliation.
   `paused`, `cancelled`, `healed` and `stopped` are durable transitions, not inferred from an in-memory return value.

Legal chain transitions are `none -> paused|reserved|stopped`, `reserved -> proposed|cancelled|stopped`,
`proposed -> dispatching|paused|cancelled|stopped`, and
`dispatching -> healed|paused|cancelled|reserved|stopped`. The last transition to `reserved` requires a recorded failed,
safe terminal predecessor and remaining allowance. A pause after reservation keeps that ordinal and its saved proposal;
record its suspended phase explicitly. A pre-reservation pause resumes to `reserved`; a saved proposal resumes toward
`dispatching` without reserving again. A dispatching pause only settles/reconciles that owning action and cannot return
to grant issuance. Every pause may instead cancel or stop. Resuming rechecks policy. A cancelled chain is terminal;
new operator work retains its history
and is still charged against the same goal ceilings. Validation fences every append by chain revision and current state.

| Interruption/race                                                | Required behavior                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Crash after `reserved`, before pure proposal                     | Recompute the same pure rule from recorded evidence for that ordinal; no additional reservation or external work.                                                                                                                    |
| Crash after `proposed`, before `dispatching`/grant               | Recover the exact saved proposal; recheck current policy/read set, then progress the same ordinal. No inference or duplicate edit.                                                                                                   |
| Crash after `dispatching`, before grant/start becomes durable    | Treat dispatch as potentially issued. Never issue another execution grant for that ordinal. Use authorized lookup/reconciliation; missing host record alone is not proof of no effect. Unresolved absence pauses for owner evidence. |
| Crash after host start or effect, before Loom result             | Existing bounded recovery looks up the invocation. Integrate the outcome once. Possible effects retain locks; no rewrite on uncertainty.                                                                                             |
| Persistence failure at any required append                       | No next grant/invoke. Preserve durable prefix, consume any already reserved ordinal, and fail closed until recovery.                                                                                                                 |
| Duplicate failure callbacks or two proposals for the same action | First validated expected-revision append wins; duplicate event ids do not spend another unit. A competing writer cannot open the journal.                                                                                            |
| Unrelated actions fail concurrently                              | Separate chains can reserve independently, but still compete for goal-wide budget, execution slots and effect locks.                                                                                                                 |
| Cancellation/revocation races with proposal or queued dispatch   | Recheck at admission and dispatch. Record cancellation before any later transition; old proposals cannot revive it. If already started, request cancel and retain uncertain holds.                                                   |
| Late result after pause/recovery                                 | Keep its invocation evidence; integrate only through its owning recorded action. It cannot start a replacement or advance a newer chain revision.                                                                                    |
| Historical replay                                                | Reconstruct transitions, inputs, counters, issues and accounting without rewriter/provider/grant issuer/host calls. Unsupported or missing evidence fails replay.                                                                    |

An unused grant lost in a crash is intentionally not recovered as execution authority. Durable evidence makes an
interruption explainable; it does not make the two stores and in-process grant issuance one atomic transaction.

## 6. Cost and loop kill-switch dependency (#355 / D-ENG-023)

Treat the brief's D-ENG-023 constraint as binding: rewrites cannot bypass a strong-tier pause or a ceiling. Its separate
decision text is not present at HEAD; do not claim an already implemented new kill-switch API. Agree the child interface
with #355 before enabling live dispatch. Until that interface lands, keep the integrated feature disabled.

The #355 gate must run before reservation and immediately before every capability invocation/provider attempt, including
recovery lookup, optional future judgment and implementation-step inner repair. It returns recorded allow/pause/stop
evidence under the same goal/cycle budget. Account for projected spend plus existing reservations, actual usage including
failures, and unknown paid outcomes conservatively. New request/action ids never create a new spending allowance.
Cancellation, result persistence and reconciliation settlement can still progress after a ceiling closes dispatch.

Do not multiply budgets across implementation retries, rewrite attempts and gateway `max_attempts`. A rewrite unit caps
edits/call attempts; provider attempts and action/judgment reservations remain separately bounded and charged to their
existing parent budget. Recovery consumes its existing lookup allowance. Model work, if later admitted, gets only the
remaining parent tokens/cost/deadline and no new independent purse. Loop-depth accounting includes this path.

Preserve current policy evidence accurately: `budgetRoute` presently permits an ahead-pace downgrade for some non-audit
strong work. The rewrite path must not exploit that by dropping `audit`, relabeling a required strong request as working,
or asking again at standard after a pause. Require the original tier where policy requires strong; if unavailable, pause.
D2 ceiling, D4/D7, audit quality, destination/privacy restrictions and acceptance thresholds stay unchanged. No automatic
escalation is added by v1 repair. On rewrite exhaustion, open one issue; an implementation-step owner may then use only
its already bounded escalation policy. Reset time permits a new check, never automatic authority renewal.

## 7. PR slices and red-before-green evidence

These are proposed child scopes, not issues created by this task. Each PR first adds and runs the named behavioral test
against the missing behavior to observe red, then implements the smallest change and proves green in that same PR.
Do not merge failing intermediate commits to main. Contract/test authors must validate negative cases and mutation or
placeholder rejection before trusting generated tests. PR 1 and PR 2 are independent; downstream dependencies follow.

| PR                                                      | Owned change and dependency                                                                                                                                                                                                                                                                                                                                                  | Named red-before-green tests/checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Durable observation admission                        | Harden `packages/weave/src/journal.ts` for acknowledged fsync, directory sync on creation, torn-final-line repair, exclusive writer ownership and poisoned partial appends; retain complete legacy observations and reject corrupt interior records. Reuse the established `FileAttemptJournal` behavior without creating a generic storage framework.                       | New `packages/weave/test/call-rewrite-journal.test.ts`: `acknowledged rewrite evidence survives crash and a torn tail without losing a complete record`; `a second writer cannot reserve an ordinal`; `failed append never advances the rewrite projection`. Exercise child-process termination and injected persistence faults, not just in-memory reload.                                                                                                                                                                                                            |
| 2. Diagnostic and rewrite contract                      | Freeze the closed taxonomy, JSON bounds, one registered rule and intent restrictions in proposed `packages/weave/src/CALL-REWRITE-CONTRACT.md`; add shared diagnostic validation, optional host details, Fabric persistence and the pure Loom rule. No live dispatch.                                                                                                        | New `packages/agentfabric/test/call-failure.test.ts`: `structured schema failure survives host restart while malformed detail never becomes eligible`. New `packages/weave/test/call-rewrite.test.ts`: `only a registered decimal representation edit is proposed`; `same-scope semantic substitution is rejected`; boundary table for lexical grammar, numeric range, unsupported stack/API errors, injection, secrets and oversized input.                                                                                                                           |
| 3. Durable Loom projection and blocker                  | Depends on 1 and 2. Add `call.rewrite@1`, result payload v2, `open_issue@2`, closed validation, reducers and replay in `types.ts`, `validation.ts`, `state.ts`, `runtime.ts`; pure projection/rule in proposed `call-rewrite.ts`. Keep the observation log authoritative through context/trace eviction. Live retry still disabled.                                          | New `packages/weave/test/call-rewrite-recovery.test.ts`: `duplicate failure records reserve one ordinal`; `replay reconstructs proposed inputs and counters with zero external calls`; `missing or changed proposal payload blocks continuation`; `legacy action.result@1 and impl.attempt@1 replay unchanged`; `context compaction and trace eviction cannot lose rewrite evidence`.                                                                                                                                                                                  |
| 4. First vertical retry under policy                    | Depends on 3 and an accepted, implemented #355 dispatch gate. Wire failed-result processing to candidate formation and ordinary dispatch in `runtime.ts`, `candidates.ts`, relevant composition formation, and `scheduler.ts` only where needed. Enable only explicit registered read-only/effect-free operations. Recheck queued work; no host-recursive retry.             | New `packages/weave/test/call-rewrite-integration.test.ts`: `schema API 422 rewrites once then succeeds under a fresh equal-scope grant`; `rewrite exhaustion opens one issue before a fourth invoke and cannot refill budget on restart`; `old single-use grant cannot invoke again`; `stale read set at queue drain prevents fresh grant`; `changed binding requires matching approval`; `ceiling closes before next invoke`; `required strong pause produces no standard fallback`. For max 2, assert at most 3 starts and exact action/provider/lookup accounting. |
| 5. Crash, cancellation and concurrency acceptance       | Depends on 4; required before enabling outside the fixture. Use real Fabric stores and subprocess crashes, injected clock and deterministic interleavings.                                                                                                                                                                                                                   | Extend `call-rewrite-recovery.test.ts`: `crash between decision and grant keeps one reserved ordinal`; `crash after dispatch intent never reissues its grant`; `crash after host start reconciles without duplicate invocation`; `concurrent same-action failures admit one replacement`; `cancel or revoke before dispatch starts nothing`; `uncertain writes retain locks and never rewrite even after not_committed`; `unrelated chains progress within the shared ceiling`; `replay never invokes a host or rewriter`.                                             |
| 6. Implementation-step adapter and boundary regressions | Depends on 5 and #355; opt-in use in `implement-step.ts`/composition roots only for qualifying invocation protocol failures. Keep real red check verdicts and D5 handling unchanged. Carry rewrite lineage in a versioned evidence attachment to `impl.attempt@1`, preserving old readers; add `impl.attempt@2` only if PR contract tests demonstrate an incompatible shape. | Extend `packages/weave/test/p8.test.ts`: `check protocol repair does not regenerate or reset the step retry allowance`; `red check output is never rewritten into success`; `inner repair exhaustion preserves one check-sourced open issue and the existing escalation bound`; `pause and restart cannot reset issuer or rewrite counters`. Add the benchmark isolation test below and run existing p8/p9, uncertainty, authority and credential regressions.                                                                                                         |

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
route identity. Do not add global gateway/adapter interceptors, change frozen corpus bytes, or silently apply production
repair to a benchmark route. The fixture integration test is not evidence of model quality.

Keep Loom independent of providers and tool protocols. Fabric may depend on AgentSOP and gateway but must not import
Loom scheduling/state. Gateway imports no runtime. The new decision, admission and projection functions are pure:
injected observations, clock ticks/ports and recorded versions determine their output. Filesystem/process/network work
stays at existing host, journal and composition boundaries. No ambient clock, entropy, environment or credentials enter
the policy functions. Enforce `checks/import-direction.mjs`, `no-ambient-clock.mjs`, `no-ambient-entropy.mjs`,
`no-ambient-env.mjs`, `no-swallowed-failures.mjs` and `checks/test/credential-parity.test.mjs`; never add an exception merely
to pass. Repeated review findings become a targeted lint or behavioral regression, with a red fixture proving detection.

## 9. Recommendations, owner forks and assumptions

Architectural/code-health recommendations under D-ENG-021 are concrete: choose the deterministic registered rule first;
keep policy in Loom and error normalization at the host edge; use one durable chain in the observation journal; preserve
single-use grants and generic read-set revalidation; open a blocker on exhaustion; require #355 integration before live
dispatch; defer effectful repair. These are recommendations for plan acceptance, not questions delegated to Benjamin.

Product forks for Benjamin remain open until captain go:

1. Should automatic repair be enabled for explicitly registered operations by default, or require per-goal opt-in?
   Recommend opt-in initially; absence of a decision keeps it disabled.
2. Accept the proposed default one rewrite and hard maximum two, or choose a smaller allowance? The implementation
   contract must pin a finite value before execution; no runtime model chooses it.
3. Should a later product milestone fund model-assisted proposals for ambiguous failures, or keep them operator-visible
   blockers? V1 needs no model site; approving this plan does not authorize that later milestone.

Before implementation, add proposed glossary definitions for **call rewrite**, **rewrite chain**, **rewrite attempt** and
**rewrite evidence**; clarify the new capability-source open issue and the distinction between a representation edit
and implementation regeneration. Do not add a new BoundCall term when action candidate already fits. This task leaves
`GLOSSARY.md` unchanged. No vision acceptance boundary is changed by the proposed bounded path.

Assumptions requiring explicit verification in the children: a host adapter can attest the stopped/rejected phase without
trusting error prose; the selected operation has reviewed semantic equivalence for the one allowed conversion; the
composition root can enforce one journal writer; #355 supplies durable goal/cycle admission and strong-pause semantics.
If any assumption fails, leave repair disabled and preserve the original failure/blocker. Neither a recovered journal nor
a model answer creates missing authority.

Acceptance of this parent requires agreement on taxonomy, record/state contract, child dependencies, the unresolved
product forks and the #355 boundary. Implementation remains blocked on captain go.

## 10. Verification of this planning change

Checked the inventory's paths and symbols against the baseline source, and inspected the cited behavioral tests.
Using the installed Node 22 toolchain and dependencies restored from the offline npm cache, `npm run fmt:check` passes.
`npm run check` also passes within the attempted `npm run verify`. Full verification stops at `test:checks`: fixture
subprocess launches return `spawnSync ... EPERM` in this environment. A separate `npm test` builds successfully and
reports 96 of 103 test files passing, with seven failures. Those failures include restricted subprocess launches and
loopback listeners (`listen EPERM`); a fully green suite is not established here. No check or fixture was weakened.
The only tracked deliverable is this new `PLAN.md`; no push is part of this task.
