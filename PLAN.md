# WV-355: hard cost / loop kill-switch

Planning only. Implementation is blocked on captain go. This task adds only this
file on `wv-355-kill-switch-plan`; it changes no source, tests, schemas or glossary.
Issue brief: <https://github.com/CrowBe/weave/issues/355>. No network was used, so
the supplied brief is the authority for scope; issue comments were not fetched.

Inventory baseline: HEAD `444c0d0d3c8c2827dc85348f87e4ed1a814cc914`.
Paths and symbols below describe that commit. Proposed fields, records and test
names are explicitly proposals, not claims about existing APIs.

## Contract before implementation

Loom must refuse a dispatch whose conservative projection would exceed any
applicable goal or cycle ceiling, and latch a durable halt before returning a
paused outcome. It must check before the next invoke, including retries and
fallbacks inside one gateway request. Halting stops new work immediately at the
admission boundary; it requests cancellation of work already admitted and still
accounts for its eventual or uncertain spend. It cannot undo an external effect
or an invoice already incurred.

Policy is deterministic. Model answers remain observations and cannot change a
ceiling, clear a halt, mint authority or lower required quality. Audit and work
requiring `strong` pause rather than weaken. D4/D7, disclosure, admission and
execution grants remain independent gates. A cheaper route is optional and may
be considered only before a hard halt, within unchanged authorized terms.

The acceptance boundary is zero overshoot of **reserved projected resources**
under the declared upper bounds. Actual external charges can exceed a provider's
declared bound; that limitation must remain explicit, with conservative retained
liability and no further dispatch. This is not a promise of exactly-once provider
billing or instantaneous termination of an uncooperative process.

## Inventory at HEAD

| Existing control                         | Exact files and symbols                                                                                                                                                                                                                                                                                                                                                                                                                               | Behavior and limits relevant to this work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal budgets                             | [types.ts](packages/weave/src/types.ts): `Goal.budget`, `BudgetLine`, `Budget`, `State.budget`, `Reservation`; [state.ts](packages/weave/src/state.ts): `initialState`, `applyAccepted`                                                                                                                                                                                                                                                               | Goal actions/judgments, optional cost and recovery; budget lines contain `limit`, `reserved`, `spent`. Opening a goal initializes omitted cost/recovery to zero. `Reservation` covers actions/judgments, not provider attempts, tokens or depth.                                                                                                                                                                                                                                                                                                        |
| Frontier resource selection              | [scheduler.ts](packages/weave/src/scheduler.ts): `select`, `rejectReason`                                                                                                                                                                                                                                                                                                                                                                             | Deducts action/judgment reservations while selecting independent candidates; retains effect locks for unreconciled uncertainty. It does not reserve provider cost or enforce a token/depth ceiling.                                                                                                                                                                                                                                                                                                                                                     |
| Runtime accounting                       | [runtime.ts](packages/weave/src/runtime.ts): `Runtime.runCycleOnce`, `weighAndSelect`, `frameGoal`, `appendInferenceRequested`, `onGatewayWeighStep`, `dispatch`, `drainQueue`, `invokeHost`, `abandonUnrecordedInferences`, `replay`, `recover`; [types.ts](packages/weave/src/types.ts): `InferenceRequestedPayload`, `InferenceRecordedPayload`, `InferenceAttemptRecord`, `CycleRecord`; [state.ts](packages/weave/src/state.ts): `applyAccepted` | `inference.requested@1` reserves request cost; `inference.recorded@1` releases it and adds spend. Recovery charges the entire reservation for an abandoned inference. The recorded runtime attempt projection lacks gateway token usage. Cycle records are trace data in memory; they are not a durable cycle resource ledger. `CycleRecord.cost_micros` is slice-assembly cost, not total provider spend.                                                                                                                                              |
| Per-request gateway ceilings             | [types.ts](packages/gateway/src/types.ts): `InferenceTerms`, `ProviderUsage`, `AttemptRecord`, `GenerationOutcome`, `EvaluationOutcome`, `Micros`; [routing.ts](packages/gateway/src/routing.ts): `route`, `worstCaseCost`, `priceAttempt`; [gateway.ts](packages/gateway/src/gateway.ts): `createInferenceGateway`, `runBoundedLoop`, `meteredCost`                                                                                                  | Context/output bounds and prices project a worst case; each attempt checks request spend plus the next worst case against `cost_ceiling`. Retries have request and per-route attempt caps. Unknown cost is charged at the worst case. These are request-local totals, not a shared goal/cycle ceiling. `Micros` means one millionth of a currency unit; the type does not establish USD.                                                                                                                                                                |
| Budget gate                              | [budget.ts](packages/gateway/src/budget.ts): `BUDGET_POLICY`, `budgetRoute`, private `gate`; [gateway.ts](packages/gateway/src/gateway.ts): `runBoundedLoop`, `readQuota`                                                                                                                                                                                                                                                                             | `budget.policy@1` runs after hard routing constraints and before every attempt, including after waits. Weekly remaining <=20% vetoes all units on that account; five-hour remaining <=10% excludes pressured units. Strong and quota-tracked standard fail closed on missing/stale/ambiguous required quota. Snapshot age is bounded at 60,000 ms. Ahead pace currently permits non-audit strong-to-standard downgrade.                                                                                                                                 |
| Paced limits                             | [types.ts](packages/gateway/src/types.ts): `RateLimit`; [gateway.ts](packages/gateway/src/gateway.ts): `PaceState`, `paceDelay`, `reservePace`, `joinPaceQueue`, `leavePaceQueue`; [config.ts](packages/gateway/src/config.ts): `validRateLimit`                                                                                                                                                                                                      | Per gateway instance, FIFO waiters and worst-case token reservations pace starts, then use reported usage. Pacing intentionally sends immediately if no timer, the wait misses the deadline, or one request cannot fit. It is not a hard budget gate and must not be repurposed as one.                                                                                                                                                                                                                                                                 |
| Quota observations and pause persistence | [types.ts](packages/gateway/src/types.ts): `QuotaSnapshot`, `QuotaPort`, `BudgetReason`, `LoopPausedRecord`; [gateway.ts](packages/gateway/src/gateway.ts): `GatewayConfig.persist_pause`, `runBoundedLoop`; [quota-local.ts](examples/quota-local.ts): `normalizeQuotaSnapshot`, `createQuotaPort`, `localBudgetGate`                                                                                                                                | Snapshot data describes whole-account percentages, resets and pace, not goal tokens or currency spend. The composition helper normalizes `weekly` to `seven_day`, preserves reused-reading time, caches for 60 s and coalesces reads. `loop.paused` carries `policy:'budget.policy@1'`, request/site, reason, `until`. A configured failed pause write rejects and prevents further dispatch. The example JSONL pause sink is not an fsynced goal ledger; `until` only permits a recheck.                                                               |
| Implementation loop                      | [implement-step.ts](packages/weave/src/implement-step.ts): `runImplementationStep`, `ImplementBudgetRequest`, `ImplementBudgetDecision`, `ImplementPorts.budget`, `EqualGrantIssuer`, `createEqualGrantIssuer`, `AttemptJournal`, `FileAttemptJournal`, `replayImplementationStep`                                                                                                                                                                    | Budget hook before generation; `impl.attempt@1`, `impl.stop@1`, `open_issue@1`; default two retries, bounded retries, one escalation, D2 ceiling, fresh equal-scope check grants. Generation, checks and D5 need coverage, not just the generation hook. The file attempt journal fsyncs append, repairs torn tails, indexes IDs and detects a second writer best effort; its contract still requires one writer.                                                                                                                                       |
| Audit loop                               | [audit-loop.ts](packages/weave/src/audit-loop.ts): `runAuditLoop`, `AuditPorts.budget`, `AuditJournal`, `MemoryAuditJournal`, `AuditCheckpoint`, `AuditRound`, `replayAuditLoop`; [AUDIT-CONTRACT.md](packages/weave/src/AUDIT-CONTRACT.md)                                                                                                                                                                                                           | Round-start/live budget checks, iteration/no-progress/repeated-issue stops; `audit.round@1` supports `budget`, `iteration_cap`, `cancelled`, `audit_unconfirmed`, etc. Strong generation has durable-dispatch-intent semantics through the journal port. Recovery without a report pauses instead of silently spending again. Only an in-memory audit journal is supplied here; production checkpoint durability and exclusive execution ownership are caller requirements. `resume:true` is a control input, not a single-use authorization mechanism. |
| Durable state and grants                 | [journal.ts](packages/weave/src/journal.ts): `ObservationJournal`, `FileJournal`, `MemoryJournal`, `PersistError`; [grants.ts](packages/agentsop/src/grants.ts): `GrantAuthority`, `createGrantAuthority`, `markInvoked`; [host.ts](packages/agentfabric/src/host.ts): `AgentFabricHost.prepare`, `lookup`, `reconcileCliGeneration`; [store.ts](packages/agentfabric/src/store.ts): `FabricStore`                                                    | Observation log is distinct from Fabric's host store. `FileJournal` synchronously appends JSONL but does not fsync or repair a torn tail; do not claim it already meets the stronger durability contract below. Grant issuance/consumption uses in-process object identity; JSON copies are not issued grants. Host invocation identity and stored outcomes prevent blindly repeating effects. Fabric's store lock is not a Loom budget lock.                                                                                                           |
| Operating-process pause                  | [operating-process.ts](packages/weave/src/operating-process.ts): `ResumePoint`, `transitionProcess`; [workstream.ts](packages/weave/src/workstream.ts): `transitionWorkstream`                                                                                                                                                                                                                                                                        | Paused/resumed are explicit process transitions; a resume point binds a digest and grants nothing. This is reusable pause vocabulary, not an existing budget resume grant or a durable shared cost counter.                                                                                                                                                                                                                                                                                                                                             |
| Protected judgments                      | [boolean.ts](packages/weave/src/sites/boolean.ts): `BOOLEAN_SITE_POLICY`, `INPUT_RULES`, `OUTPUT_RULE`, `transitionBooleanSite`; [sites/CONTRACT.md](packages/weave/src/sites/CONTRACT.md)                                                                                                                                                                                                                                                            | D4 `guard.input` and D7 `guard.output` have deterministic confidence/violation handling and approval requests. No cost fallback may replace their required result with a pass, remove a rule or bypass approval.                                                                                                                                                                                                                                                                                                                                        |
| Benchmark route isolation                | [providers.ts](benchmarks/decision-sites/providers.ts): `buildProviders`; [competitors.ts](benchmarks/decision-sites/competitors.ts): `museSparkCompetitor`; [run.ts](benchmarks/inference/jev/run.ts): `jevRouteTable`, `createJevGateway`, `validateReferenceOptions`, `probeTerms`; [typesafe-ai.ts](packages/gateway/src/adapters/typesafe-ai.ts): `typesafeWireProfile`                                                                          | Decision-site providers use direct routes with `shuffle:false`; Muse Spark competitor is an explicit gateway-routed exception. Jev reference mode pins one TypeSafe route per kind, disables option shuffling and allows no fallback. Budget work must not install production wrappers into these benchmark paths.                                                                                                                                                                                                                                      |

Existing behavioral evidence was inspected, including:

- [budget.test.ts](packages/gateway/test/budget.test.ts): `checks quota again
  before a retry and persists pause before returning`, `a budget pause after a
  failed attempt is blocked yet carries that attempt and its spend (#73)`,
  `audit pauses on ahead pace instead of using an available standard route`,
  and `a failed pause write rejects the call instead of returning an outcome,
  and dispatches nothing (#74)`.
- [pacing.test.ts](packages/gateway/test/pacing.test.ts): `a paced token budget
  reserves the worst case, then counts reported usage`, and `pacing never
  suppresses an attempt: without a timer, past the deadline, or beyond the
  budget it sends at once`.
- [p8.test.ts](packages/weave/test/p8.test.ts): `a budget pause at escalation
  pauses the step and resumes into the escalation (#128)`, fresh-grant retry
  tests, fsync/torn-tail/second-writer tests, and uncertain-generation
  reconciliation tests.
- [p9.test.ts](packages/weave/test/p9.test.ts): `crash after a paid generation
  but before its report checkpoint does not pay again without explicit resume
  (#165)`, `state budget pause re-observes on resume and proceeds once the
  ceiling is raised`, and `ahead pace through the real gateway pauses the
  audit instead of a standard-tier downgrade`.
- [vercel-charge-replay.test.ts](packages/weave/test/vercel-charge-replay.test.ts):
  parameterized `preserves promotional ... once on crash/recovery/replay ...`;
  verifies billed failures, cancellation/deadline cost, duplicate arrival
  rejection and replay accounting. It does not cover every dispatch crash gap.

No shared durable goal/cycle provider-token, invoke-count or loop-depth ledger,
single-use budget resume authorization, or shadow-traffic budget mechanism was
found in the inspected runtime/gateway/composition paths. `index.ts` is a raw AI
SDK smoke test, not the production Loom composition root. Do not describe it as
already wiring these controls.

## Proposed data and policy

Use existing `Goal.budget`, `BudgetLine`, `InferenceTerms`, `ProviderUsage` and
attempt evidence rather than a second billing system. The following is the
contract to settle in child C1 before generating implementation code.

| Proposed state/configuration    | Shape and ownership recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Goal policy                     | Extend the goal's admitted budget declaration with finite ceilings for input tokens, output tokens, total tokens, invoke count and loop depth, plus cycle sublimits. Keep `budget.cost` in micros and bind one declared currency to its pricing evidence. The trusted composition root resolves operator/project defaults and records effective values, policy revision and setter provenance at goal admission. A model proposal cannot set them. Route documents remain unit/decision configuration; `parseRouteConfig` currently accepts only `units` and `decision`.                                                                         |
| Projection counters             | At both goal and durable cycle identity, retain `spent` and `reserved` input/output/total tokens, provider cost in micros and invoke count. `projected = spent + reserved + next_reservation`; track whether each amount is measured or an upper bound, including the source of pricing/token bounds. Unknown is never zero. Use nonnegative safe-integer counters and conservative upward rounding for fractional micros. Reject NaN, Infinity, negatives and overflow.                                                                                                                                                                         |
| Loop depth                      | Proposed meaning: cumulative admitted continuation edges within a goal, with a per-cycle counter of local loop-back edges; not JavaScript stack depth or thread parentage. Cycle entry after the first, implementation retry/escalation, audit Observe loop-back, gateway retry/fallback and autonomous tool continuation each consume a documented edge once at their owning boundary. Record edge identity/parent evidence; avoid counting one edge at both caller and callee. Straight-line invokes consume invoke count even without an edge. Counters do not decrease on crash, cancel or resume. Benjamin must approve this meaning in C1. |
| Cycle identity                  | Persist a cycle-open observation before any weighing or dispatch; bind `goal_id`, monotone `cycle_no` and policy revision. Local implementation/audit loop activity cites the owning cycle; gateway retries stay in that cycle. Recovery continues an unfinished cycle and does not reset its sublimits. Only a newly admitted runtime cycle gets fresh cycle counters; goal counters remain cumulative. Do not infer durable usage solely from the in-memory cycle trace.                                                                                                                                                                       |
| Invoke identity                 | Count actual provider attempts and capability-host invocations, with separate subtotals; the total counts each boundary once. A gateway envelope is not an extra provider attempt; a logical runtime action implemented internally is not a host call. Every retry, fallback, failed, refused or cancelled started invoke counts. A pre-dispatch denial does not. A reservation with no proven dispatch after a crash remains consumed conservatively. Child/nested calls require suballocations from the caller's envelope; no unmetered tool escape hatch.                                                                                     |
| Reservation/settlement evidence | Bind goal/cycle, action or request, routed unit where applicable, monotone attempt identity, policy revision, projected amounts and lifecycle (`reserved`, `started`, `settled` or unresolved liability). Use journal sequence/revision for atomic compare-and-append under a single owner. Settlement replaces that reservation once, it never adds both the reservation and measured spend. Keep unresolved amounts reserved or charged at their bound across restarts.                                                                                                                                                                        |
| Halt record                     | Prefer existing observation envelope with `payload_version:1` for a new closed halt payload: goal/cycle, policy revision, triggering boundary/attempt, dimension/scope, spent/reserved/next projection, ceiling, disposition (`paused` or terminal stop), reason, evidence sequence and `until:null` for local resource ceilings. Proposed reasons: `goal_cost_ceiling`, `cycle_cost_ceiling`, `token_ceiling`, `invoke_ceiling`, `loop_depth_ceiling`, `accounting_uncertain`, `accounting_unavailable`. A fixed reason order plus all violated dimensions makes simultaneous violations reproducible. No prompts, raw errors or credentials.   |

For defaults, recommend fail-closed admission of **new protected goals** until a
finite cost and token envelope is explicitly resolved; omitted existing cost
continues to mean zero, never unlimited. Proposed starter count defaults for
Benjamin to approve: 256 goal invokes, 16 cycle invokes, 64 goal continuation
edges and 8 cycle-local edges. Cycle cost/token defaults inherit the remaining
goal allowance unless explicitly tighter. Zero permits no corresponding work.
These numbers are recommendations, not existing constants or measured safe
values. Project/operator policy may tighten them; raising a goal ceiling requires
the entitled principal and a durable policy amendment. Retries/resumes do not
replenish spent resources. Do not enable a partially configured switch silently.

Reuse `BudgetLine` arithmetic and existing request reservations where possible.
Extend runtime `InferenceAttemptRecord` with token evidence only through an
explicit optional-field/validation contract preserving old replay. Reuse
`inference.requested@1` / `inference.recorded@1` for outer request accounting and
`impl.attempt@1`, `impl.stop@1`, `audit.round@1` for their existing meanings.
New per-attempt reservations transfer portions of the outer envelope rather
than charging it again. Include slice assembly once in the existing goal cost
total; retain a provider-cost subtotal for this feature.

Do not append new local-ceiling reasons under `budget.policy@1`: its policy
literal and `BudgetReason` union currently mean quota policy. Keep its existing
pause records readable unchanged. Recommend a separately versioned local limit
policy and durable halt payload, with `loop.paused` presentation reusing the
existing shape only through an explicitly extended policy/reason union after
contract review. Old readers must reject unsupported new variants, not interpret
them as quota resets. New protected records require complete evidence; historical
logs remain replayable under historical versions without fabricated zero usage.

## Minimal enforcement points

1. At `Runtime.runCycleOnce`, admit/persist the cycle and its continuation edge
   before weighing, framing or any other paid work. Latch checking prevents the
   `reuseFollowUp` loop from spinning after exhaustion. This is an early guard,
   not the sole enforcement point.
2. At `Runtime.dispatch` and queued-start `drainQueue` / `invokeHost`, recheck the
   current halt/policy and reserve the next host invocation before execution.
   A selection made against an older state is not permission to spend. Preserve
   independent execution; serialize only admission and settlement mutations.
3. In gateway `runBoundedLoop`, after quota/routing/pacing waits and immediately
   before `attemptBeforeDeadline`, acquire a bounded allocation through an
   injected, provider-independent accounting port. Recheck cancellation and
   deadline after asynchronous acquisition. Persist before calling the adapter;
   settle even failed/unaccepted attempts before any retry/fallback. A wrapper
   only around `generate`/`evaluate` misses the Nth internal attempt.

The runtime-facing adapter owns goal/cycle bookkeeping. Gateway receives opaque
allocation identity, amounts and allow/refuse results; it must not import Loom
state, scheduling or Fabric. The reducer/routing computations remain pure; disk,
locking, clocks, transport and credential access stay behind explicit ports.
Do not put Loom budget policy in Fabric. Host-owned nested execution may enforce
generic finite suballocations without learning what a Loom goal or cycle is.

Wire `runImplementationStep` generation, check invokes and D5 through these boundaries,
and `runAuditLoop` generation, D6/D8 and observation-owned fixes through the same
account. Their existing budget callbacks provide early pause checks, not a
second independent counter. Read-only bookkeeping, terminal settlement and
authorized reconciliation must remain possible after halt; they cannot launch
ordinary goal work or spend an unreserved reconciliation allowance.

For a ceiling L, equality may consume the last permitted unit; a proposed
projection > L is denied. Once spent reaches L, latch a halt for that dimension
before any further consuming invoke. A denied reservation changes neither spent
nor invoke count. With `max_invokes = N-1`, the Nth invoke never enters the host
or provider. Once latched, reducing a projection or finding a cheaper unit does
not automatically clear the halt.

## Fallback matrix

Kinds alone confer no downgrade permission. Site purpose, required tier, quality,
evidence, D2 ceiling, destinations, content class and explicit policy all apply.
All candidates still pass existing routing, quota and cost checks.

| Request class                                                                | Allowed cheaper option before a hard halt                                                                                                       | Must pause/stop when unavailable                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-audit `classify`, `extract`, `transform` on flash/standard               | A cheaper evidenced unit of the same operation/kind and adequate quality; standard-to-flash only with explicit per-site policy and evidence     | Missing permission/evidence, required strong tier, protected content, or no fitting allocation                                                                                            |
| Non-audit `draft-contract`, `judge` generation                               | Default same-tier alternatives only; cross-tier downgrade disabled pending purpose-specific evidence/approval                                   | Required strong, audit/admission-critical purpose, or insufficient quality                                                                                                                |
| `choice`, `score`, `boolean` evaluation at ordinary decision sites           | Same configured provider and answer shape, same acceptance thresholds; optional alternate unit only where that site's policy already permits it | No synthetic pass or lowered confidence. Exclusive provider selection remains exclusive; failure preserves the site's deterministic fallback only where no dispatch authority is inferred |
| D4 `guard.input`, D7 `guard.output`, admission/authority-sensitive judgments | No budget-driven tier/quality/provider relaxation; a same-contract route still needs explicit existing routing permission                       | Pause/needs-human under existing rules; never delete a guard, skip approval or execute through outage                                                                                     |
| `audit.generate` and every request requiring `strong`                        | Another eligible strong unit under unchanged terms                                                                                              | Pause rather than strong-to-standard/flash; do not convert required strong into a soft preference                                                                                         |
| Capability/tool invocation                                                   | An already admitted composition/implementation only under its existing contract, effects, permissions and resource allocation                   | No new primitive, unchecked implementation or widened grant to reduce cost                                                                                                                |
| Benchmark/reference requests                                                 | No new automatic fallback or shuffle                                                                                                            | Report incomplete/refused under the benchmark's own policy; preserve pinned routes                                                                                                        |

HEAD's non-audit ahead-pace downgrade is a real conflict to resolve, not an
inventory claim to erase. Recommendation: tighten that branch in `budgetRoute`
so strong requests pause, updating its existing downgrade tests and the Budget
gate glossary entry in the later implementation PR. This planning task does not
change either. Ordinary standard-to-flash opt-in must not reuse that strong
exception or reinterpret D2 as permission to weaken a stronger requirement.

## Failure, cancellation, concurrency and recovery

| Case                                                                 | Required behavior and deterministic evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent invokes race the last allowance                           | One owner atomically checks both goal and cycle, appends reservation, then releases the admission critical section. With L units and R already reserved/spent, winners reserve at most L-R; losers halt without dispatch. This gives zero projected overshoot even across different gateway instances sharing the goal. A second process without proven exclusive ownership refuses before calling providers. Best-effort file-size checks alone do not suffice.                                                                               |
| Work already in flight when another call trips the switch            | No new admissions after the halt linearization point. At most K previously reserved invokes remain, where K is the number of live allocations (bounded by the invoke ceiling and configured concurrency). If actual spend A_i respects reservation R_i, actual overshoot is zero; otherwise excess is bounded only by sum(max(0, A_i-R_i)) for those K calls. Without enforceable provider bounds there is no finite invoice guarantee; retain/report the excess and pause.                                                                    |
| Crash before reservation / after reservation before start            | Before durable reservation, no external call. After reservation, keep its complete liability on recovery; do not assume the call never started. Reconcile if supported, otherwise retain the bound and require explicit continuation authority. A conservative false halt is preferable to lost spend.                                                                                                                                                                                                                                         |
| Crash after spend before settlement or counter journaling            | Durable reservation survives and covers the lost result. Recover it as unresolved, retaining bound tokens/cost/invoke/depth. Never resend merely because the request ID repeats. Reconciliation can replace the bound with measured evidence once; absent provider evidence, keep the bound.                                                                                                                                                                                                                                                   |
| Crash after settlement / duplicate result                            | Settlement identity is unique per allocation/attempt. Reopen and fold durable records once; duplicate arrivals cannot charge twice or release a different reservation. Replay is non-executing and never calls adapters, clocks, reconciliation or grant issuers. Recovery is separately authorized, finite reconciliation.                                                                                                                                                                                                                    |
| Persistence fails, disk fills, torn tail or owner lost               | No dispatch unless a complete reservation is durable. A failed settlement retains the reservation and blocks new work; reopen/reconcile before continuation. A failed halt write still blocks in process and rejects explicitly, never reports a successfully persisted pause. Durable pre-call evidence must reconstruct the refusal/uncertainty after restart. Corrupt interior records fail closed; only a provably incomplete final record is repairable.                                                                                  |
| Cancellation before admission or during pacing/quota/allocation wait | No invocation. Release only a proven unstarted allocation through durable evidence; cancel waiters. Recheck after every await. A started invocation count is never refunded.                                                                                                                                                                                                                                                                                                                                                                   |
| Cancellation mid-invoke / late usage                                 | Request abort/process termination through existing ports; no next attempt. Retain the full reservation until a terminal/uncertain settlement. Reuse adapter `settle_on_abort` / `await_on_abort` contracts and injected Timer; late results may settle the same liability once but cannot restart work. Cancellation does not imply zero cost or undo effects. Preserve host effect holds until reconciliation.                                                                                                                                |
| Resume after a halt, including two racing resumes                    | Verify entitled principal, halt ID, goal/cycle, policy revision and amendment. Atomically append consumption of a unique resume authorization together with the transition out of that halt; then issue fresh execution grants as needed. Consumption survives crash before dispatch, expiry and replay. A consumed authorization can be inspected but never used again; another interruption needs a fresh one. A grant copied from a journal is not reissued. Resume rechecks quota, D4/D7, permissions, uncertainty and remaining counters. |

Use one durable stream for the authoritative reservation, halt and resume state
so a multi-file partial commit cannot create spend authority. Existing attempt,
audit and host journals may cite that stream; their projections do not decide
resource availability. Before enabling protected mode, strengthen the chosen
observation-journal implementation to append-and-sync before return, sync file
creation, recover torn tails, enforce exclusive ownership and preserve
deduplication/revision checks. `FileAttemptJournal` offers a local durability
precedent; reuse it by composition where suitable, without pretending its
single-writer detection is a cross-process lock. Do not import Fabric storage
into Loom or build a general distributed ledger for this issue.

Single-use resume authorization is proposed authority state, distinct from the
current `resume:true` flag, a `ResumePoint`, and a capability execution grant.
Persist consumption even if a subsequent provider call fails. Retrying the same
resume request may return its recorded receipt, but may not start a second
continuation. Terminal stops cannot resume; new goal authority must be explicit.

## Benchmark isolation and shadow traffic

Install production accounting and guardrail composition explicitly. Do not add
ambient wrappers, adapter-global middleware or option shuffles. Preserve
`buildProviders` direct benchmark calls, the explicit Muse Spark competitor
configuration, Jev reference pins and `shuffle:false`. A benchmark's explicit
budget may refuse a dispatch, but must record incompleteness rather than switch
models, change questions/order, inject D4/D7 prompts or relabel results. Normal
production privacy checks continue to apply on production routes.

No shadow dispatcher was found at HEAD. If introduced, every paid shadow attempt,
retry and failed/cancelled result needs its own durable allocation, marked as
shadow and linked to the triggering goal/cycle. Count it once in that goal's
total provider cost/tokens/invokes and in an explicit tighter experiment
suballocation; subtotals are views, not duplicate charges. Admit foreground
reservations first, refuse shadow work when allowance is unavailable, and never
let shadow output affect authority or completion. Out-of-goal experiments need
their own explicit budget and attribution; they cannot hide goal-triggered cost.

Before comparative runs, reserve adversarial/held-out cases independent of the
implementer. Do not use implementer-authored examples as sole quality evidence.
No benchmark run or hosted inference is needed for this plan. Any future hosted
run must first record data provenance/license, exact destination and sanitization
or explicit authorization under AGENTS.md. Keys enter through injected secret
ports/environment allowlists; never argv, logs, halt records or benchmark output.

## Owner questions and recommendations

### Product forks for Benjamin

| Decision                                       | Recommendation for captain go                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| USD ceilings, tokens, invokes, or all?         | Enforce independent cost, token and invoke ceilings. Use existing micros with an explicit USD declaration only if all route prices are normalized to USD; subscription quota percentages remain a separate gate. Do not infer currency from the `Micros` name.                       |
| Who sets finite defaults and may raise them?   | Benjamin approves starter defaults; the entitled operator/project policy resolves them and records effective values at goal admission. Models may propose tighter work, not authorize larger budgets. Confirm count defaults above and require explicit cost/token values initially. |
| What does loop depth mean?                     | Approve cumulative continuation edges as specified above; expose goal and cycle counters with owner-boundary evidence. Keep thread ancestry and JS recursion separate; invoke count also catches a flat runaway tool loop.                                                           |
| Pause or terminal stop?                        | Default local resource exhaustion to durable pause with `until:null`. Explicit goal cancellation or an authorized non-resumable policy yields terminal stop with reason. Do not auto-resume cost/depth exhaustion at a clock tick.                                                   |
| Who can resume and what does it replenish?     | Only an entitled principal through trusted ingress, bound to a halt and an explicit amendment when needed; one durable single-use authorization. Preserve all cumulative spend/depth/count. A new cycle cannot launder a goal ceiling.                                               |
| How aggressive may fallback be?                | Strong/audit and guards pause; ordinary standard work may opt into evidenced flash fallback per site. Default cross-tier fallback off. Accept the tightening of HEAD's ahead-pace strong downgrade explicitly.                                                                       |
| Does shadow work spend the user's goal budget? | Yes, plus a tighter experiment suballocation; default shadow disabled. Surface both totals and the unresolved-liability portion.                                                                                                                                                     |

### Architectural and code-health questions

| Question                                          | Recommendation                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a top-level wrapper solve this?               | No: add one injected per-attempt allocation gate in `runBoundedLoop` and reuse runtime dispatch/cycle boundaries. Avoid duplicating route selection or adding a generic middleware framework.                                                                             |
| Where is authoritative state and locking?         | Loom observation stream with one proven owner per goal stream; strengthen its file backend before enabling the feature. Gateway and Fabric keep their own bounded contracts. Refuse unsupported multi-writer hosting rather than implement distributed transactions here. |
| What happens to the existing request reservation? | Treat it as an envelope and transfer suballocations; settle the goal once. Existing outer `inference.recorded` evidence remains readable and must not double-charge new per-attempt settlements.                                                                          |
| Do record versions need changing?                 | Keep existing record versions for compatible optional evidence only. New local policy/halt/resume lifecycle gets explicit closed versioning; do not silently expand `budget.policy@1` semantics. Contract tests determine which readers need a new version.               |
| Can recovery prove the exact bill after a crash?  | Not generally. Preserve conservative liability; only authorized reconciliation evidence may reduce it. Never treat request identity as provider idempotency or infer zero tokens from missing usage.                                                                      |
| How are hidden nested tools covered?              | Require finite suballocation at the host/composition boundary or an enforceable aggregate envelope. Refuse protected execution with unbounded hidden child calls; Fabric must not import Loom scheduling to implement this.                                               |
| What if a legacy journal has missing counters?    | Replay under its historical contract. Continuing it under protected mode needs an explicit policy/evidence migration or pauses as accounting uncertain; never synthesize zero usage.                                                                                      |
| What should repeated findings become?             | Add deterministic regression checks for every repeated review finding: missing pre-invoke reservation, reused resume authority, lost failure spend, ambient time, benchmark wrapper/shuffle leakage. Prefer existing scanner/test patterns before a new lint framework.   |

Future GLOSSARY.md work, not edits in this task: define **projection counter**,
**resource ceiling**, **loop depth** (after Benjamin's decision), **spend
reservation**, **halt record**, **resume authorization** and **shadow traffic**.
Update **Budget gate** for the strong-pause policy and clarify **Loop pause
record** for separately versioned local ceilings. Preserve existing meanings of
Goal, Cycle, Replay, Recovery, Grant, Resume point and Weft trace. Update VISION.md
only if captain-approved decisions change its acceptance boundary; this design
implements its existing deterministic spending boundary.

## Child issues / PR slices and done-means

No child issues are created remotely by this offline planning task. Labels C1-C6
are proposed work packages, not GitHub issue numbers. Every implementation PR
first validates its behavioral test, records observed red against HEAD/prior
slice or a relevant mutation, then writes code and proves deterministic green.
Do not merge a red intermediate commit. Generated tests/code remain untrusted
until independently reviewed and validated. Each PR runs narrow checks while
iterating, then the full available suite before merge; no check is weakened.

| Child / dependencies                                               | Smallest coherent PR and named red-before-green tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Done means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1: contract and historical compatibility; captain go first        | Freeze budget/depth/currency semantics, allocation/halt/resume records and owner interfaces. Add contract fixture tests named `rejects nonfinite and missing protected ceilings`, `historical quota pauses and inference records replay unchanged`, `one attempt cannot charge its outer envelope twice`. Demonstrate red with invalid fixtures/mutations before accepting schema/validator implementation.                                                                                                                                                                    | Product forks answered, new terms admitted in GLOSSARY.md, closed versions decided, failure/permission/effect invariants explicit. No live dispatch path changes; existing suite green.                                                                                                                                                                                                                                                                                                               |
| C2: durable accounting and resume consumption; depends C1          | Implement the narrow journal/reservation fold and exclusive-owner wiring before enforcement is enabled. Tests: `reservation survives process death before and after dispatch`, `torn final append cannot erase admitted liability`, `settlement replay neither doubles nor loses spend`, `second goal-stream owner cannot admit spend`, `resume authorization consumed before crash cannot be used again`, `two concurrent resumes dispatch once`. Use child-process kill/reopen evidence, not only memory journals.                                                           | Sync/creation/tail/failure behavior verified; one authoritative stream; duplicate/overflow/corrupt records fail closed. Legacy replay stays green. No production enablement before durability works.                                                                                                                                                                                                                                                                                                  |
| C3: gateway attempt admission; depends C2                          | Inject allocation/settlement port at the final pre-attempt checkpoint, leaving unconfigured standalone gateway behavior unchanged. Tests: `Nth provider retry is denied before adapter entry`, `parallel gateway requests reserve the last cost and token allowance once`, `pacing wake rechecks halt before dispatch`, `failed and unaccepted attempts settle before fallback`, `cancelled and late-settled usage retains one liability`, `pause persistence failure cannot dispatch again`.                                                                                  | Generate/evaluate retries/fallbacks share one allowance, conservative bounds verified, no dependency on Loom/Fabric, unknown accounting refuses protected calls. Existing quota and paced-limit semantics pass unchanged except the separately reviewed strong restriction.                                                                                                                                                                                                                           |
| C4: Loom cycle/host integration and halt/resume; depends C2 and C3 | Wire cycle entry, selected/queued host starts, implementation checks/D5 and audit D6/D8 to the account. Tests: `runaway tool loop halts before Nth invoke`, `queued selection cannot bypass a later halt`, `cycle recovery retains depth and reservations`, `raising a ceiling still requires fresh resume authority`, `cancelled host work retains effects and spend until reconciliation`.                                                                                                                                                                                   | Stress test uses a deterministic endlessly successful synthetic tool loop, sets N=100 and max invokes=99, supplies otherwise ample budgets, and asserts exactly 99 started calls, zero entry into call 100, one latched halt, durable reason and no growth after more observations. Repeat for flat tool loops, retry loops and concurrent frontier starts; replay performs zero calls. Goal and cycle cost/token/depth/count ceilings independently trip at boundaries, including zero and equality. |
| C5: fallback and benchmark isolation; depends C3 and C4            | Tighten strong ahead-pace handling, map local halts to existing implementation/audit pauses, optionally enable only approved ordinary-site fallback. Tests: `required strong and audit never downgrade under cost pressure`, `cheaper unit cannot bypass D4 D7 quality or destination`, `direct benchmark routes and reference pins receive no production wrappers or shuffles`, `shadow failure spend counts once against both suballocation and goal`. Update HEAD tests that intentionally expected non-audit strong downgrade with captain-approved behavioral assertions. | Fallback matrix executable, exclusive decision provider policy preserved, opt-in only, no benchmark semantic drift. A shadow-accounting fixture suffices; do not build a shadow dispatcher for this issue. Promote repeated review findings to regression tests/checks.                                                                                                                                                                                                                               |
| C6: activation and end-to-end acceptance; depends C4 and C5        | Wire the actual trusted application composition, resolved defaults and operator halt/resume evidence. Tests: `protected goal cannot start without durable accounting`, `crash after paid response before counter append preserves the ceiling`, `repeated recovery and replay never reuse a resume or invocation grant`, `multi-instance race has zero projected overshoot`, `halted goal accepts settlement but no new work`.                                                                                                                                                 | Full suite green with fake clocks/providers and process-crash storage tests, all paths accounted or explicitly refused, counters/reasons inspectable without secrets, no hosted benchmark needed. Document actual-price-bound limitations and supported single-owner hosting. Rollback disables new protected admissions; it never erases liabilities, reuses grants or silently continues halted goals.                                                                                              |

C2's durability tests and C5's benchmark-isolation fixtures can be developed
independently once C1 is frozen; their merge prerequisites remain explicit.
Keep branches green in dependency order. Captain go authorizes implementation;
this plan and a successful check run do not.

## Validation and assumptions for this planning task

- Read AGENTS.md, VISION.md, GLOSSARY.md, current controls and behavioral tests
  before recommending changes. Repository-local inspection only; no `gh` call,
  provider requests, dependency download, push or external issue writes.
- The supplied issue brief cannot establish actual provider billing guarantees,
  an entitled resume principal, preferred currency, production journal backend
  or approved numerical defaults. Those remain the explicit decisions above.
- `npm run fmt:check`: attempted; exit 127, `vp: not found`. This worktree
  has no installed node_modules. `npm run verify`: attempted; exit 127 at
  that same first formatting gate, so the full suite did not run. No dependency
  installation or network fallback was attempted.
- PLAN.md was formatted and checked offline with the existing
  `/workspace/weave-WV-377/node_modules/.bin/oxfmt`, version 0.73.0, matching
  this worktree's package-lock.json. A temporary config outside the repository
  supplied `singleQuote:true` and `printWidth:120` from vite.config.ts. This
  validates this document's formatting, not the unavailable workspace-wide
  `vp fmt --check` gate.
- Additional available checks: the five source scanners (import direction,
  ambient clock, ambient entropy, ambient environment and swallowed failures)
  passed when invoked directly. Local citation paths and inventory symbols were
  checked against the cited HEAD files; none were missing. `git diff --check`
  passed.
- Broader supplemental attempts also exposed environment limits:
  `npm run check` failed in verify-cached.test.mjs (the benchmark-digests test
  passed); the cache tests require the missing worktree-local `vp` executable.
  `npm run test:checks` failed to expand its quoted file glob under the installed
  Node v20.19.2; package.json requires Node >=22.18.0. A shell-expanded rerun
  passed credential-parity.test.mjs and execution-provider.test.mjs but failed
  checks.test.mjs, whose fixture subprocess assertions received empty output.
  That fixture failure was not diagnosed further in this planning-only task;
  direct repository scanner passes do not establish fixture-suite green.
  These failures were not bypassed or fixed; a supported, installed toolchain
  is still needed for full verification.
- Commit blocked by read-only Git metadata: `git add -- PLAN.md` failed with
  `Unable to create '/workspace/weave-p7/.git/worktrees/weave-WV-355/index.lock': Read-only file system`.
  PLAN.md remains untracked/uncommitted on `wv-355-kill-switch-plan`; the requested
  commit message is `plan: hard cost/loop kill-switch (#355)`. No push occurred.
  No implementation tests were added or claimed green for the proposed feature.
