# PLAN — strict pre-flight context budget assembler (#353)

Status: **plan only. This revision addresses the Claude Opus review of `25e1d0f` (plan11 dispositions in §20; plan10 in §19); no implementation is authorized by it.**
Issue: CrowBe/weave#353 (architecture parent). Branch `wv-353-context-budget-plan`, base `0281c5e`.
Review target `25e1d0f`; source, tests and benchmarks there are identical to base `0281c5e`
(`git diff --stat 0281c5e 25e1d0f` lists only `PLAN.md`).

The issue text used here is the copy in the task brief. This plan revision did
not read the remote issue; that source assumption is recorded as A1. Review
verdicts are operator files outside the repository; that assumption is A7.

## 1. Goal, in Weave terms

Before Loom appends an `inference.requested` and calls the inference gateway, it
measures everything the request will disclose to a routed unit:

- the request's instructions and questions (what the issue calls the system
  prompt);
- capability schemas (the catalogue slices);
- retrieved documents (source and artifact bodies);
- the state view's other slices.

Loom holds that total against the request's declared input ceiling
(`terms.max_context_tokens`). It records the measurement as a **context ledger**
beside the view. If the parts that may not be dropped do not fit, Loom fails
closed: no inference budget is reserved, nothing is dispatched, and the refusal
is recorded. Nothing is ever cut silently. Instructions, questions, authority,
goal and audit material are never dropped to make a request fit.
If the complete evidence cannot fit the observation bound, record the distinct
durable persistence failure in §5.5; never claim a complete refusal was stored.

## 2. Inventory at HEAD (`25e1d0f`; code identical to base `0281c5e`)

Symbols are the primary references; line numbers are secondary navigation hints,
rechecked against this HEAD. A bare `symbol (file:N)` pin is the definition;
use-site pins are labelled ("term at", "comparison at", "call at").
Children must resolve the symbols at their own base.

### 2.1 The context window is declared, never measured

| Where                                                                                                                                                                                                     | What it does today                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InferenceTerms.max_context_tokens` (`packages/gateway/src/types.ts:146`)                                                                                                                                 | A caller-declared number.                                                                                                                                        |
| `invalidTerms` (`packages/gateway/src/gateway.ts:856`; context check at `:867`)                                                                                                                           | Only checks `>= 1` for the context term.                                                                                                                         |
| `excludeReason` (`packages/gateway/src/routing.ts:186`; comparison at `:220`)                                                                                                                             | Excludes a unit when `unit.context_limit_tokens < terms.max_context_tokens` (`context_limit_too_small`). It compares two declarations.                           |
| `worstCaseCost`, `priceAttempt` (`packages/gateway/src/routing.ts:66,78`)                                                                                                                                 | Prices the cold window as `max_context_tokens` input tokens. Gateway attempt affordability depends on that input bound; Loom reserves `cost_ceiling` separately. |
| `paceDelay`, `joinPaceQueue`, `reservePace` (`packages/gateway/src/gateway.ts:996,1016,1034`; token sums at `:1011,1017,1036`)                                                                            | Counts worst-case tokens as `max_context_tokens + max_output_tokens`.                                                                                            |
| `ProviderUsage.input_tokens` (`packages/gateway/src/types.ts:409`)                                                                                                                                        | Reported after the call. Nothing compares it with `max_context_tokens`.                                                                                          |
| `Runtime.weighAndSelect`, `Runtime.frameGoal` (`packages/weave/src/runtime.ts:851,1228`; terms at `:928,1258`), `GatewayDecisionLayer.weigh` (`packages/weave/src/gateway-decision.ts:29`; term at `:54`) | All hard-code `max_context_tokens: 8_000`. Framing can override it through `RuntimeOptions.framingTerms` (`runtime.ts:120`).                                     |

**Finding F1:** no code path compares the bytes or tokens actually sent
(`instructions` + `prompt`, or `state` + `questions`) with
`max_context_tokens`. A request can exceed the window it declared. Routing
then believes the declaration, and gateway attempt pricing can understate the
input. Loom separately reserves the whole `cost_ceiling`, not `worstCaseCost`.

### 2.2 Slices, profiles and disclosed truncation

- `ViewOmission`, `ViewSliceManifest` and `StateView`
  (`packages/weave/src/types.ts:200,205,214`) define `ViewOmission {name, reason}`,
  `ViewSliceManifest {name, revisions, truncated, omitted, assembly_id?}` and
  `StateView {profile, profile_version, state_revision, content, manifest}`.
- `FrameProfile` (`packages/weave/src/views.ts:19`) has `catalogue_budget`,
  which counts **operations**, not tokens. It also has `slices`, `prefix` and
  `schema_for`. `renderFrameView` (`:101`) truncates the catalogue by
  `catalogue_budget` with omission reason `budget` and `truncated: true`. It
  omits unauthorized sources with reason `authority` and unselected schemas
  with reason `profile`.
- `sliceAssemblyId` and `stampAssemblies` (`views.ts:74,80`) stamp a shared
  assembly. `Runtime.noteViewAssemblies` (`runtime.ts:1216`) charges it once
  per cycle using `SHARED_ASSEMBLY_MICROS`.
- `renderWeighView` (`views.ts:272`) has no budget at all. It omits non-scalar
  inputs with reason `profile`.
- `assembleAuditState` (`packages/weave/src/audit-view.ts:154`) uses fixed byte
  caps: `max_body_bytes` (default 4096), statements 4096, ids and tails 240.
  It records each cut in `omissions` (`*:size_cap`, `*:statement_cap`, …) and
  cuts UTF-8 safely (`boundedUtf8`, `boundedUtf8Tail`). The truncation is
  disclosed, but per field and in bytes. There is no total.
- `stablePrefixBytes` (`packages/weave/src/strategy.ts:33`) defines the stable
  prefix: profile id and version, `prefix`, and the catalogue.
  `CATALOGUE_SLOT_MICROS` (`strategy.ts:12`) and `profileReservation`
  (`strategy.ts:72`) are fixture costs per catalogue slot, not token counts.
- `compactContext` (`packages/weave/src/compaction.ts:13`) works on token arrays
  from an injected tokenizer. It compacts at 80% of capacity and rejects an
  oversized summary ("Context compaction port", `AUDIT-CONTRACT.md:133`). Nothing calls it on the
  inference request path.

### 2.3 Instructions and questions are outside any manifest

- goal.frame: `Runtime.frameGoal` (instruction string at `runtime.ts:1300-1302`) has an inline instruction string. The prompt
  is `stableStringify(view.content)`.
- frontier.weigh: `GatewayDecisionLayer.weigh` (`gateway-decision.ts:29`; `evaluate` call at `:40`) sends `view.content` as `state`, plus
  `frontierWeighQuestions` (`frontier-weigh.ts:37`).
- audit: `runAuditLoop` (`audit-loop.ts:233`; instructions at `:368`) has inline instructions. The prompt is
  `JSON.stringify(observed.state)`.
- implementation step: `runImplementationStep` (`implement-step.ts:782`; generate input at `:908`) uses caller instructions and
  prompt. `feedbackPrompt` (`:573`) **appends** failure lines on every retry,
  and nothing measures the result.
- task validation and the criteria gate: `CRITERIA_INSTRUCTIONS` and
  `VALIDATION_INSTRUCTIONS` (`task-acceptance.ts:86,89`), with per-line questions
  in `criteriaQuestions` and `validationQuestions` (`task-acceptance.ts:466,481`).
- `GenerationInput`'s disclosure contract (`packages/gateway/src/types.ts:173`)
  accepts already filtered content, but adapters transform it: `toWireQuestion`
  (`packages/gateway/src/adapters/typesafe-ai.ts:105`) translates typed questions into wire questions;
  `openAiCompatibleAdapter` and `messagesFor` (`packages/gateway/src/adapters/openai-compatible.ts:53,116`)
  construct messages, roles and an envelope.
  Measuring only the caller's leaf bodies does not measure this complete input.

**Finding F2:** the issue wants instructions and capability schemas in the same
ledger as the slices. Today, instructions and questions are not slices. They
are not in `ViewSliceManifest` and are not counted anywhere.

### 2.4 Budget and cost gates

- `packages/gateway/src/budget.ts` `budget.policy@1` is a deterministic
  whole-account quota filter (weekly, five-hour and pace). It knows nothing
  about request content and must not learn about it: the gateway imports
  nothing in-repo (`checks/import-direction.mjs`).
- Loom's own budget: `applyAccepted`'s `inference.requested` branch reserves `{judgments, cost}`
  (`state.ts:326`). `validateInferenceRequested` (`validation.ts:653`) rejects
  a reservation over the remaining budget. `inference.recorded`
  (`state.ts:338`) settles it.
- Precedent for refusing before dispatch: `Runtime.weighAndSelect` (`runtime.ts:905-913`) blocks the cycle
  with `cost budget exhausted` and makes no call, writing no extra record.
  Replay re-derives the refusal from state.

### 2.5 Durability, recovery, replay

- `Runtime.appendInferenceRequested` (`runtime.ts:1086`) journals the view, terms
  and reservation **before** `Runtime.frameGoal` calls the gateway (`runtime.ts:1284-1307`).
- Recovery abandons a request that has no `inference.recorded`
  (`ABANDONED_INFERENCE`, `runtime.ts:145`).
- Replay re-renders the frame view using a historical profile **supplied by
  the replay caller** (`RuntimeOptions.frameProfile`, `runtime.ts:115`) and
  the recorded catalogue (`Runtime.replayCatalogueIds`, `runtime.ts:1170`). `StateView` contains
  only profile identity/version, not the complete profile. Neither historical
  templates nor future excluded bodies are guaranteed to be recoverable there.
- `validate` (`validation.ts:113`; version gate at `:117`) globally rejects versions other than 1;
  adding a v2 branch only in `validateInferenceRequested` cannot admit v2.
  `Runtime.load` currently folds accepted records without version dispatch.
- `FileJournal` (`packages/weave/src/journal.ts:43`): `persist` uses
  `appendFileSync` with no fsync, and `snapshot` (`:67`) runs `JSON.parse` on
  every line, so a torn final line makes load throw instead of recovering.
  It does not meet the durable-append contract in §6.5.
- `FileAttemptJournal` (`packages/weave/src/implement-step.ts:1154`;
  `packages/weave/src/sites/CONTRACT.md:298-306`) already implements that
  contract for `impl.attempt`: fsync per append and directory sync on create,
  torn-final-line repair on first read, an incomplete-append latch (#249) and
  best-effort other-writer detection (#131). §6.5 reuses it.
- `payloadBytes` and `hasMidValue` (`log-bound.ts:7,11`) measure canonical
  payload bytes and reject a mid-value cut, including any lone surrogate
  ("rejected, not repaired"). `hasMidValue` walks values only, not object keys.
  `payloadBytes` and `digest` (`digest.ts:5`) both consume
  `stableStringify` (`stable-json.ts:5`), which is `JSON.stringify` over
  sorted keys. Since ES2019 (Node `>=22.18.0`, `package.json:64`) that escapes a
  lone surrogate as the ASCII `\ud800`. So `"\uD800"` canonicalizes to 8 bytes
  and a U+FFFD string to 5, with distinct digests. Only a raw UTF-8 encoding of
  the string itself (`Buffer.from(s, 'utf8')`) maps a lone surrogate to U+FFFD.
- `Runtime.appendStep` (`runtime.ts:605`; size check at `:610-621`) has four
  rejection paths, in this order: oversize against
  `RuntimeOptions.logBound.max_observation_bytes` (in-memory diagnostic only,
  neither thrown nor persisted, though its `observation_id` is still recorded
  as seen at `:620`); then a duplicate `observation_id`; a mid-value
  payload; and `validate` failure. The last three return a `rejected` validation
  and are not journaled (`persist` runs only for accepted records, `:636-637`).
  A `PersistError` is rejected only for `action.started`, `action.result` and
  `recovery.attempted`; every other journal failure throws. None of these is a
  durable refusal; §5.5 assigns each an outcome for managed preparation.

### 2.6 Benchmark routes

- Benchmarks build gateways and terms directly and never go through Loom's
  request path:
  - `createJevGateway` and `createKevGateway` (`benchmarks/inference/jev/run.ts:235,462`)
    build gateways; `probeTerms` (`:260`) and `kevTerms` (`:498`) declare `max_context_tokens: 8_000`
    (terms at `run.ts:270,283,502`). `TYPESAFE_REQUEST_PARAMS.shuffle` is false (`run.ts:47`;
    reference mode);
  - `museSparkCompetitor` (`benchmarks/decision-sites/competitors.ts:214`;
    gateway built at `:266`, term at `:297`) declares an 8000 term;
  - `buildRequest` (`benchmarks/decision-sites/questions.ts:19`; term at `:37`) declares 4000;
  - `configureJev` (`benchmarks/frontier-weigh/run.ts:81`; gateway built at
    `:110`) passes a gateway through `siteWeigher`
    (`benchmarks/frontier-weigh/weighers.ts:71`), which constructs
    `new GatewayDecisionLayer(gateway, destinations)` (`:78`) and calls
    `layer.weigh(weighRequest(built))` (`:84`) with an unprepared
    `WeighRequest` (`weighRequest`, `:38`). The README rows
    `constant-dispatch`, `constant-defer` and `jev`
    (`benchmarks/frontier-weigh/README.md:25-27`) all run through this route,
    so the shared `GatewayDecisionLayer.weigh` is itself a benchmark route.
    The harness reads the wall clock (`() => Date.now()` at `run.ts:113,115`)
    and races a `setTimeout` (`:122-140`);
  - `main` (`benchmarks/task-acceptance/live.ts:38`; gateway built at `:47`,
    term at `:59`) declares an 8_000 term.
- `buildCase` (`benchmarks/frontier-weigh/build.ts:222`; call at `:233`) calls `renderWeighView` directly,
  so any byte change to a renderer changes benchmark cases.
- `checks/no-ambient-clock.mjs` scans `packages/*/src` only (`:17-22`), so it
  covers the new `context-budget.ts` but not `benchmarks/`.
- `scripts/benchmark-digests.test.mjs` pins the checked-in benchmark inputs
  and artifacts. The reference run header pins the corpus hash and plan hash
  (GLOSSARY "Reference run header").

### 2.7 HEAD call-path trace — live stop disposition and crash recovery

Traced before the plan11 design edits, at `25e1d0f`. HEAD has no context-stop
records or clarification mechanism; those writes below are proposed C2d/C2d-Q
insertions into the actual call paths, not existing HEAD behaviour. All pins
in this table are in `packages/weave/src/runtime.ts`.

| Path                                | HEAD calls and sequence/effect boundary                                                                                                                                                                                                                                                                                                                                             | Constraint on the proposed fix                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live refusal/marker insertion       | `runCycleOnce` dispatches each selected candidate synchronously (`runtime.ts:757-764`); `dispatch` appends its start then calls `environment.execute` (`:1376-1396`). `liveEnvironment.execute` calls `frameGoal` and, for a returned outcome, `recordResult`, before returning to the remaining selection (`:2544-2550`).                                                          | The proposed stop, optional overflow clarification request and stopped result belong inside that dispatch, before later selected starts. Returning null uniformly during replay would leave framing running for the rest of the cycle and change this order.                                                                                                                   |
| Live result and queue               | `recordResult` wraps `recordResultStep` (`runtime.ts:1427,1441`); runtime append discards its Observation (`:1484`) and drains unconditionally (`:1486`). `appendStep` can return result PersistError as rejected (`:647-654`) without folding. `drainQueue` filters/sorts pending work (`:1781-1783`), checks slots/authority, appends starts and executes (`:1785-1837`).         | Checking at the execute caller is too late. Stop results need validation inside the result step before any drain, with a non-draining variant for recovery. Failure must unwind the current dispatch/selection, not merely set a flag for the next cycle.                                                                                                                      |
| Crash load and reconcile            | `recover` loads then reconciles (`runtime.ts:2818-2822`); `reconcileStep` first abandons unrecorded inferences (`:1845-1846`), then constructs/iterates unfinished (`:1847-1850`). Exhaustion writes `recovery.exhausted` and returns (`:1854-1856`) before its final drain (`:1897`). Generic work records an attempt and may lookup (`:1859-1876`).                               | Insert the local stop pre-pass after abandonment and before constructing unfinished, complete only missing request/result writes, and never drain from that pre-pass. A zero-allowance generic action must still reach the existing early return without starting queued work.                                                                                                 |
| Reconcile's existing nested effects | Abandonment submits gateway ingress (`runtime.ts:1911-1923`, ingress wired at `:304`) which can cycle/drain through `admitStep` (`:583-593`). Generic lookup outcomes call `recordResult` (`:1879-1894`) or `recordReconciledStep` (`:1493`, drain at `:1506`), which can also drain.                                                                                               | HEAD does **not** have only one possible drain during all of reconcile. Preserve those existing generic/ingress paths; the new pre-pass adds none. The zero-allowance no-start fixture has no unrecorded inference, so abandonment cannot itself start work before that assertion. Test the intervening-abandonment path separately.                                           |
| Replay execute versus feed          | `replayEnvironment.execute` calls framing (`runtime.ts:2625-2627`), finds a result by action (`:2628-2631`) and immediately reproduces runtime-source results (`:2640-2646`). `replay` skips runtime/judgment sources except review results (`:173`, `:2780-2784`). Trusted feed goes to `admitStep` (`:450-451`, `:583-593`); a fed runtime record does not trigger a cycle/drain. | Live synchronous stop dispositions need inline reproduction; recovery-delayed dispositions need feed at recorded seq. Selection, request/result consumption and queue continuation must be pinned together, with exactly one consumer per record. `reviewGoal` returns null even in live (`:1203-1214`), so its result-feed precedent cannot justify a uniform framing policy. |
| Replay queue and equality           | `drainQueue` is disabled in replay (`runtime.ts:1778-1779`). `checkPrefix` compares complete canonical observations, including seq (`:2833-2845`); replay also checks log length and unfinished actions (`:2789-2797`).                                                                                                                                                             | Merely calling the same drain cannot reconstruct queued starts. C2d must explicitly reconstruct the recorded queue continuation at the live stop boundary through replay's non-executing environment, retaining strict seq/equality checks and zero host/gateway/journal calls. Recovery-fed runtime dispositions do not acquire a drain.                                      |

## 3. Decisions (architectural recommendations under D-ENG-021)

D-ENG-021 is applied as supplied in the brief; its record is not in this
repository. These architecture and code-health choices are decided here.
The product decisions in §9 are closed under D-ENG-025/026/027; their
measurement and approval gates remain prerequisites, not reopened questions.

**R1. Pure assembly in Loom; prepared requests cross the decision boundary.**
`packages/weave/src/context-budget.ts` will be a pure transformation of explicit
inputs. In Loom's two runtime-owned inference paths it runs inside the existing
single-writer `step`, before durable append and dispatch. It takes no clock,
randomness, environment, credentials or transport. Provider-specific accounting
belongs beside wire profiles/adapters and is injected by trusted composition;
Loom sees a versioned accounting interface and opaque coverage identity.
`budget.policy@1` retains its whole-account quota role.

For `frontier.weigh`, `GatewayDecisionLayer.weigh(request: WeighRequest)` and
`WeighRequest` stay byte-identical: that method is the frontier-weigh benchmark
route (§2.6, `siteWeigher`) as well as direct composition. It keeps building
`request_id` `weigh:${state_revision}:…`, the `frontierWeighQuestions`
questions and its own 8_000 / destinations / deadline / cost-ceiling terms.
C2d adds a separate method, `GatewayDecisionLayer.weighPrepared(prepared,
signal)`, plus an optional `weighPrepared?` on the `DecisionLayer` interface
(`packages/weave/src/types.ts:729`). Only Loom's managed async path calls it,
from `Runtime.startGatewayWeigh` (`runtime.ts:1097`), which today calls
`decisionLayer.weigh(request)` and never forwards its `AbortController`.
`weighPrepared` passes the sealed request id, exact `state`, questions,
effective terms and digest unchanged to `gateway.evaluate`, with `signal`
forwarded to the call. It shares the site-owned `frontierWeights` acceptance and
`toAttempts` interpretation with `weigh`, and adds no other behaviour.
A method on the same class is chosen over a second class because acceptance and
attempt mapping stay in one place, and `siteWeigher` never calls the new method.
A managed runtime whose async decision layer lacks `weighPrepared` is an
unsupported configuration; the runtime does not fall back to `weigh`.
Scripted weighing still receives candidates without requesting inference. This
is a Loom boundary change, not a change to default gateway routing or to any
benchmark route. §7 guard 6 and T10 pin the benchmark payload.

**R2. Exact reconstruction first; no unconditional `utf8_bytes@1` default.**
The previous byte-sum proposal and assumptions A2/A3 did not establish a token
upper bound. Replace them with the accounting contract in §5.3. It measures
complete reconstructed inputs, including keys, delimiters, enclosing objects,
escaping, translated questions, messages and protocol framing. A byte count of
individual bodies remains diagnostic only. No English chars/token ratio or
empirical calibration establishes soundness.

Trusted composition injects an admitted, immutable accounting contract family
covering every route that its scoped gateway can select, retry or escalate to.
Each member binds transformation, tokenizer/model revision, settings, framing,
capacity semantics and evidence digests. Provider details stay outside Loom.
The family returns the maximum certified bound across those routes, so assembly
still precedes routing. Unknown routes, transformations, mutable aliases or
missing evidence refuse dispatch; there is no generic tokenizer fallback.
`utf8_bytes@1` can be a candidate only for a route with a demonstrated theorem
that its complete model input plus proved overhead is bounded that way.

Use the existing gateway factory with an explicit immutable route snapshot for
managed calls; composition binds its fingerprint to the accounting family.
It must not reuse an unrelated gateway instance. Coverage includes routes that
are temporarily unavailable or currently too small: availability changes and
C6 must not expose an unaccounted fallback. Adding/changing a route or adapter
requires a new binding before dispatch. Reject an unsupported configuration,
rather than silently removing a route to make accounting pass. No default
gateway field or benchmark route is changed to enforce this binding.

**R3. Requiredness is trusted site/profile policy, never caller metadata.**
A versioned site assembly contract derives the expected inventory from the
complete context profile and pre-trim view. It defines exact content paths,
mandatory instruction/question templates, permissible dynamic question ids,
required slices and optional priorities. Protected instruction, question, goal,
authority, budget, iteration and audit material cannot be relabeled or omitted.
Unknown/unmapped content is rejected. An optional classification cannot be
introduced by a model or request caller. Disclosure filtering happens first;
the assembler cannot fetch unauthorized material or reverse an omission.

**R4. Preserve stable prefixes and renderer bytes.**
Cached input occupies window in full. Cache hits affect pricing only. Profile
id/version, prefix and catalogue material used by `stablePrefixBytes` are
protected from assembler drops. Existing profile catalogue limits remain
explicit prior omissions, not new budget permissions. Renderers stay unchanged;
C3 creates a separate effective dispatched view with additional omission
entries, while preserving the original view and slice assembly references.

**R5. Sibling ledger is the storage decision (auto-fix, not P5).**
Record `context` beside `view` in `inference.requested@2`, with a sibling
`assembly_evidence` snapshot (§4). Do not add token fields to `StateView` or
`ViewSliceManifest`. Each slice part binds its original manifest index, name,
source revisions, optional `assembly_id`, content path and body digest. The
ledger also binds the complete original manifest, original view and effective
dispatched view digests. Absent `assembly_id` is valid and uses that explicit
manifest linkage. Thus the ledger records budget decisions about a slice
assembly without changing renderer bytes or rewriting a shared assembly used
by another consumer. Instructions/questions bind templates, not fake slices.
No owner confirmation or fallback storage layout is required.

**R6. First enforce without trimming; reserve product decisions explicitly.**
C2 measures the full request and refuses any excess. C3 adds whole optional-part
drops only. The invariant that oversized or unverifiable input cannot dispatch
is fixed. Default ceilings and overflow follow-up remain P1/P2; no child may
silently raise a ceiling, add escalation or summarize required audit material.

**R7. Capacity semantics are a prerequisite for window safety.**
Recommend an explicit input-capacity contract for managed routes. At composition,
normalize a certified total window to input capacity by subtracting that route's
maximum output allowance; a certified input-only limit is used directly.
Record both source semantics and normalization in the immutable coverage
snapshot, checking safe arithmetic. Unknown semantics fail admission. The
managed gateway receives only this explicitly scoped snapshot; the default
`excludeReason` comparison (`routing.ts:220`) and every direct benchmark route keep their present
semantics. Child C2a (§10) owns this contract, including any gateway change it
needs. C2a lands with its own red tests and §7 benchmark guards before C2d
enforcement can claim window safety. Until then, hold affected routes; do not
assert strict safety on assumption A4.

**R8. Bound durable failure separately from complete assembly evidence.**
Under D-ENG-021, keep full fit/refusal evidence inline and atomic; do not add
blob storage, split snapshots or raise the log bound. Measure storage fit
separately from token fit. When either complete decision is too large, use one
bounded, runtime-only `context.persistence_failed@1` record in the same journal
with no reservation effect (§5.5). This is evidence of a storage failure, never
a substitute for a ledger or a replayable numeric refusal. Existing action-result
disposition composes with it for goal.frame; frontier.weigh needs the same
durable stop record because its blocked cycle alone is not journaled. Only the
operator-facing outcome/recovery follows closed P2 (D-ENG-026). Compose journal fault tests
with the existing M1 crash-worker pattern (§6.5); do not create another harness.

## 4. Data and admission contracts (proposal only)

C1 writes `packages/weave/src/CONTEXT-BUDGET-CONTRACT.md` before implementation.
It fixes goal.frame decision uniqueness and typed, versioned terminal action outcomes (§5.5);
C2d-Q must supply the separate clarification record contract before enforcement.
Use validated JSON values, not `body: unknown` as an accepted contract. The
following are closed, versioned records; version ids name immutable content.

| Record                         | Required evidence and invariants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Site assembly contract         | Site and operation/kind; complete profile snapshot; expected parts and content-path mapping; protected classes and priorities; renderer and reconstruction revisions; complete instruction/question template snapshots and their rendering rules; budget policy and limits; explicit `volatile_fields` list of canonical input paths and its `volatile_fields_digest = digest(volatile_fields)`, including an empty list when none. No optional map supplied by the caller can override it.                                                                                                                                                                                                |
| Accounting family              | Version and content digest; all member contract/evidence digests; opaque fingerprint of the scoped gateway route/adapter configuration; exact reconstruction and serialization revisions; per-route bounds and proved framing allowances; capacity contract and output allowance. Implementations are injected pure functions whose historical revisions must be retained; provider-specific configuration stays opaque to Loom.                                                                                                                                                                                                                                                           |
| `assembly_evidence`            | Decision id and owner scope/attempt; complete site policy/profile (including `catalogue_budget`, `slices`, `prefix`, `schema_for` and budget); estimator/accounting specification and evidence identity; original authorized pre-trim view and manifest; exact template bodies and substitutions; all candidate part bodies including excluded ones; original terms, effective terms and prepared request. Record `fit_input_digest`, `policy_digest`, `storage_policy_digest`, the complete storage-policy snapshot (including the configured observation byte bound), and original state/catalogue revisions. The site snapshot includes `volatile_fields` and `volatile_fields_digest`. |
| `context.ledger@1`             | `fit_input_digest`, `policy_digest`, `storage_policy_digest`; policy ceiling `ceiling_tokens`; enforced request term `reserved_tokens`; `full_tokens`, `required_tokens`, `used_tokens`, `truncated_tokens`; original/included/required request digests; family and evidence digests; per-route complete-input byte counts, framing allowance and token bound; ordered parts with inclusion, class, priority, body digest, canonical body byte counts and manifest/template linkage.                                                                                                                                                                                                       |
| Prepared request               | Immutable generation `input` or evaluation `state` and `questions`, plus id/site/role/kind and all effective terms. Its content digest is bound to the ledger and evidence. Acceptance callbacks and AbortSignals stay outside serialized evidence and are selected by historical site contract.                                                                                                                                                                                                                                                                                                                                                                                           |
| `context.refused@1`            | Decision id, owner scope/logical attempt and `candidate_set` (null for goal.frame); `fit_input_digest`, `policy_digest`, `storage_policy_digest`; typed overflow result and complete `assembly_evidence` or the §5.2 JSON-safe rejection witness. No reservation or dispatch effect.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `context.persistence_failed@1` | Fixed-size decision/owner/attempt, candidate-set identity (null for goal.frame), `fit_input_digest`, `policy_digest` and `storage_policy_digest` (§5.5); closed site, attempted record type and `evidence_record_too_large` code; measured complete payload bytes, configured byte bound and attempted decision digest. No bodies, exception text, unbounded identifiers, token claims or reservation. It records only inability to persist the complete decision because of known size; other `appendStep` rejections are explicit errors (§5.5), not markers.                                                                                                                            |

**Stopped framing result contract (C1/C2c, D-ENG-021):** introduce
`action.result@2` with required top-level `context_decision_id: string`, the
exact immutable decision id of the accepted stop. Retain `action_id` and the
existing outcome envelope; the closed v2 payload is exactly
`{ action_id, outcome, context_decision_id }`, with no host-result/cache metadata.
This version is restricted to runtime-source `goal.frame` results with outcome
`failed`. Its closed failure code is
`context_overflow` for `context.refused@1`, or `context_persistence_failure`
for `context.persistence_failed@1`. No decision id is embedded in free text.
HEAD's `ActionResultPayload` and `ActionOutcome`
(`packages/weave/src/types.ts:133,128`; failed arm at `:130`) provide no such
field; `applyAccepted` (result branch at `packages/weave/src/state.ts:385`;
failure assignment at `:393-395`) currently folds only the failure text.
C2c adds a separate v2 payload shape and preserves the typed reference in the
folded action record and accepted-record index. Admission, load and replay
verify that the referenced accepted stop is the unique stop for the same owner
scope and started action id, precedes the result, and matches its failure code.
Reject missing/unknown/cross-owner/cross-action references, a fit decision in
place of a stop, a wrong failure code, free-text substitutes and duplicate
terminal results before folding. Existing source, running-action and budget
checks remain. Other results retain `action.result@1`; historical v1 logs keep
their historical semantics, but new stop-backed framing results require v2 and
cannot downgrade to v1. C2d carries the typed reference through the dedicated
stopped-result step (§5.5), composing with `recordResultStep`
(`packages/weave/src/runtime.ts:1441`) without its unconditional drain. Live
execute checks acceptance inside that step and then drains; the reconcile
pre-pass uses its non-draining variant. Replay's policy is per write site:
live-execute request/result records are reproduced inline when next in seq,
including the recorded queue continuation; reconcile-pre-pass records delayed
beyond that point are fed at recorded seq with no drain (§6.6). Preserve the
exact v2 payload/reference with exactly one consumer per record. C1 bounds the id
encoding and proves the maximum encoded stopped result fits the managed log bound at composition (§5.5).

`policy_digest` is `digest` of the complete immutable site assembly contract,
including its volatile-field list and identity. `storage_policy_digest` is
`digest` of the storage-policy snapshot, including the configured observation
byte bound. `fit_input_digest` uses §5.5's contract-defined projection. Persist
these fields on fit, refusal and failure-marker decisions; admission verifies
them before indexing. Complete fit/refusal evidence retains the snapshots so
load/replay can recompute all three digests from durable bytes and verify the
stop key. A witness-only refusal or bounded marker retains only the recorded
rejection/failure evidence; historical contracts are resolved and verified by
policy digest, never supplied by current defaults (§6.6).

`assembly_evidence` uses inline complete snapshots in the same atomic decision
record. Profile ids, estimator ids, hashes or mutable repository paths alone
are insufficient. The historical pure implementation and its evidence bundle
are resolved by immutable revision/digest, verified before replay; unavailable
versions are a replay failure. No new blob-store abstraction is introduced.
Before append, measure ledger and evidence bytes separately and the canonical
bytes of the entire decision payload using the existing `payloadBytes` encoding;
only the last determines fit against `logBound.max_observation_bytes`. Include
duplicated snapshots, terms, manifests and all other payload fields. Equality
fits; one byte over follows §5.5. Never cut evidence, relax the bound or persist
only a trimmed view. Already disclosed profile/audit byte omissions remain
recorded inputs. Journal envelope/physical framing bytes are reported separately
if relevant to the journal contract; they do not redefine the observation bound.

Ledger part byte counts are diagnostics, **not additive token estimates**.
The accounting family recomputes the complete request for each inclusion set.
Define `B(S)` as the maximum certified complete-input token bound over all
covered routes for inclusion set S, including framing once per route. Contracts
must establish that B is non-decreasing under the allowed whole-part additions;
an estimator lacking that property is not admitted for this policy.

- `full_tokens = B(all candidate parts)`; it has no omission markers.
- C2: `required_tokens = B(required parts only)`, computed without omission
  markers (the required structural envelope only). It is diagnostic: C2 decides
  fit on `full_tokens <= ceiling_tokens` alone, so a complete input that fits is
  never refused because of the required-only figure.
- C3: `required_tokens = B(required ∪ markers(optional))`, the required parts
  plus the omission disclosure that would replace every optional part. Admission
  must prove both `B(required ∪ markers(optional)) <= B(all)` and, for every
  inclusion set S with dropped optional parts S′,
  `B(S ∪ markers(S′))` non-decreasing as whole optional parts are added back
  (a marker swapped for its body). Without that proof, C3 returns
  `unsupported_accounting` and does not trim.
- `used_tokens = B(included parts)`; this includes every dispatched key and
  omission entry. `truncated_tokens = full_tokens - used_tokens` is a reduction
  in the bound, not a claim about tokens belonging to removed bodies.
- All numeric inputs, byte counts, bounds, allowances, differences and totals
  use checked non-negative safe-integer arithmetic. Ceilings and enforced
  request terms are positive. An empty model input still has any framing cost.
- C2/C3: `reserved_tokens = ceiling_tokens = terms.max_context_tokens` and
  `used_tokens <= reserved_tokens`. C6 changes only the equality described in
  §6.4, under a new ledger schema; it cannot reinterpret historical ledgers.

Represent refusals as a discriminated `context.overflow@1` result:

| Reason                                                       | Exact fields and accounting                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `required_exceeds_ceiling`                                   | Only when `total_tokens > ceiling_tokens` and `required_tokens > ceiling_tokens` (§5.4). `total_tokens = B(all)`, `required_tokens` as defined above for C2/C3, `over_by_tokens = required_tokens - ceiling_tokens > 0`; `total_over_by_tokens = total_tokens - ceiling_tokens > 0`. |
| `total_exceeds_ceiling`                                      | Required parts fit but full input does not: `required_tokens <= ceiling_tokens < total_tokens`; `over_by_tokens = total_tokens - ceiling_tokens`, equal to `total_over_by_tokens`. In C3 it is reachable only when admission refuses trimming.                                       |
| `invalid_budget` / `invalid_part` / `unsupported_accounting` | Bounded reason code and evidence/witness identity; omit uncomputable numeric fields entirely. Never put NaN, negative excess, infinity or guessed totals in a record. No request can dispatch.                                                                                       |

The `status: fits` result contains ledger, evidence and prepared request; the
`status: overflow` result contains the refusal and its evidence. Unsupported
capacity or route coverage is `unsupported_accounting`. A C3 omission set
whose reconstruction cannot be certified also refuses dispatch.

C2 must change admission and historical transitions together:

1. Replace the global v1-only gate in `validate` with an explicit per-type
   version table. Admit `inference.requested@2` and runtime-only
   `context.refused@1`, `context.persistence_failed@1` and the restricted
   runtime-only `action.result@2` stop result above; keep other types' current
   supported versions and source checks. Neither refusal nor persistence
   failure records have a budget reservation effect.
2. Distinguish trusted historical load/replay from new-write admission; the
   payload cannot select historical mode. Preserve v1 validation/folding for
   old logs; every new assembler-managed request requires v2. Reject a new v1
   request at these sites, including attempts submitted through another ingress.
   Likewise reject new v1 stop-backed framing results; preserve v1 results only
   for historical logs and unchanged result paths.
3. Version-dispatch `load`, replay, state folding and request/profile indexes
   before mutation; prevalidate unsupported record versions before partial
   loading. A stored `accepted` flag is not permission to interpret v2 as v1.
   Old binaries cannot read the new log safely; no rollback to a v1-only loader.
   Enforce goal.frame's unique `(owner scope, started.action_id)` decision
   across fit, refusal and marker types before indexing/folding; digests are
   verified bindings, not uniqueness components. A second decision or binding
   mismatch is an integrity error, including on load/replay (§5.5).
4. For v2, reconstruct from sealed evidence and trusted historical contracts.
   Validate inventory completeness, protected classifications, exact inclusion
   set/order, safe arithmetic, every per-route bound/allowance, aggregate totals,
   part and manifest digests, full and effective view bindings, request digest,
   `fit_input_digest`, `policy_digest`, `storage_policy_digest`, the named
   volatile-field list and its identity, and all effective terms. Digest equality
   uses existing `digest(value)` and canonical `stableStringify` semantics, not double-serialized strings.
5. Recompute totals rather than trusting `used <= reserved`. Reject omitted
   instructions/questions, fabricated requiredness, extra/unmapped bodies,
   inconsistent totals, changed templates or terms and body/digest mismatches
   before append. Reuse existing reservation/authority checks without weakening
   them. V2 never authorizes any new disclosure, destination or execution grant.
   A separate versioned site assembly contract supplies budget policy; do not
   mutate historical `FrameProfile`/`WEIGH_PROFILE` identities or renderer output
   merely to attach it.

## 5. Behaviour

### 5.1 Capture and inventory

Select the trusted versioned site/profile contract, filter disclosure with
existing authority rules, then capture an immutable authorized pre-trim view.
Derive the expected inventory from that contract and view, including mandatory
instructions and all expected questions. Distinguish an authorized prior profile
omission from a caller hiding a selected slice: the manifest and contract must
justify the former. Reject missing, duplicate, unknown, misclassified or
unmapped parts, even if their reported total fits. No caller-supplied `class`
field is authoritative. Goal, authority, audit and stable-prefix content remain
required.

### 5.2 Valid JSON and arithmetic boundary

Admit only null, booleans, finite JSON numbers, well-formed strings, dense
arrays and plain data objects with own string keys and data properties. Reject
undefined, functions, symbols, BigInt, cycles, sparse arrays, accessors, custom
prototypes, non-finite numbers and unsupported object hooks. Normalize JSON `-0`
to `0` explicitly.

Reject a lone surrogate in any string value or object key at capture as
`invalid_part` with closed code `lone_surrogate`. Use the same predicate as
`hasMidValue` (`log-bound.ts:11`), extended to keys, so the H1 rule
("rejected, not repaired") holds before append, not after. The witness carries
only the closed part name and a structural path of array indexes and object-key
ordinals (position in canonical sorted key order), never key text or the value,
so the witness itself passes `hasMidValue` and appends. Rationale:
`Runtime.appendStep` rejects any mid-value payload as `mid_value` without
journaling it, so a decision record carrying such a body would have no durable
stop. Refusing at capture with a text-free witness gives it one. The rationale
is not a digest collision: canonical bytes and `digest` escape a lone surrogate
(§2.5), so `"\uD800"` and `"�"` bodies already differ there. The collision
exists only under a raw UTF-8 encoding of string bodies, so C1 forbids that
encoding for body and part digests: they use `digest(value)` only.
Well-formed surrogate pairs (emoji, supplementary CJK) stay valid.

Input resource limit values are decided here under D-ENG-021, not by the owner.
They are denial-of-service guards on the validator, not product ceilings. Their
user-visible consequence, a durable `invalid_part` refusal with no dispatch for
a larger future view, is reported in P1's inventory and covered by its merge
criterion (§9). They stay fixture-derived because HEAD offers no structural
bound to derive them from: `renderWeighView` has no budget (§2.2), so its
candidate and in-flight lists are unbounded. C1
derives each site's `max_depth` and `max_nodes` from the largest current
fixture view for that site (goal.frame frame views, `renderWeighView` cases in
`benchmarks/frontier-weigh`, audit states), measured at C1's base. It sets each
limit to twice the measured value, rounded up to a power of two, with floors of
`max_depth = 32` and `max_nodes = 4096`. It records the measurement, the
fixture it came from and the chosen limits in the site assembly contract and
`CONTEXT-BUDGET-CONTRACT.md`. The limits are explicit positive safe integers in
the trusted site contract, recorded for replay with no ambient default; changing
them is a new contract version. Stop traversal at either limit and validate the
tree before recursive serialization. C1 tests each limit exactly at the limit
(accepted) and one over (`invalid_part`, `depth_limit`/`node_limit`). Do not
invoke getters or `toJSON`. Accepted input is a detached validated JSON tree,
not an arbitrary live JS object; proxies/host objects are outside that input
contract.

Check each addition and multiplication, not merely each operand. Validation
failures return `invalid_part`/`invalid_budget` with closed codes and no unsafe
numeric fields. Normalize validation order by the historical contract, with fixed
structural positions for rejection witnesses. Use a narrow catch around
validation/serialization to turn serialization failure into `invalid_part`;
never catch persistence, programmer or transport failures and convert them into `fits`. A typed invalid-input result
is not a promise that arbitrary executable JavaScript objects cannot throw.
Persist a JSON-safe rejection witness (closed violation code and structural
position, with no offending value) for non-JSON inputs; replay validates that
witness under the historical validator and reproduces the same refusal. Do not
pretend an invalid cyclic object can be snapshotted as JSON.

### 5.3 Exact reconstruction and certified accounting

Build one neutral prepared request from the validated inclusion set using the
historical site serializer. For generation, the exact instructions string and
serialized view become `input`; for evaluation, the exact state object and
questions are preserved. Do not sum `stableStringify(part.body)` lengths.

Each injected accounting member reconstructs the complete adapter request from
that neutral request and its immutable route configuration. Count all serialized
structure: property names, separators, braces, string escaping, question ids,
role/message envelopes, model/settings and other content-bearing fields. Record
wire-body bytes and digest separately from canonical neutral-request bytes.
The member specifies precisely which bytes/structures the tokenizer consumes
and how non-text input and implicit protocol tokens are bounded. HTTP headers
and credentials are outside model input and are never copied into evidence.
A provider's undocumented hidden framing cannot be covered by guessed headroom.

The transformation must equal the actual adapter payload on every managed
attempt. Prefer extracting/reusing existing pure wire builders; any shared
refactor must pass §7 equivalence guards. TypeSafe question translation and
OpenAI-compatible empty-system/message behavior get separate fixtures. Adapter
permutations require a proven bound over every permitted order, or a sealed
explicit order honored by both projection and dispatch. Never introduce ambient
entropy or silently change benchmark shuffle settings. Retries with changed
settings, prompt growth or another route need covered projections; changed
content is a new prepared request and decision.

Admission needs a documented mathematical/structural upper-bound argument for
the pinned tokenizer and framing, or an exact supported accounting algorithm
with verified semantics, plus adversarial boundary tests. Include empty strings,
JSON escaping, long keys, many tiny slices/questions, deep nesting, CJK, emoji,
lone surrogates, base64/digests and limits exactly at and one over the ceiling.
Independent held-out/adversarial cases must supplement implementer-authored
fixtures. Calibration and provider usage samples can falsify a contract, not
prove a universal bound. If provider/tokenizer semantics remain opaque, that
route stays unsupported; no strict token or window-safety claim is made for it.

### 5.4 Fit and overflow

Measure the reconstructed full request first. If `full_tokens <= ceiling_tokens`,
it fits (equality fits) and `required_tokens` is recorded only as a diagnostic.
Only when the full request exceeds the ceiling, classify the refusal: if
`required_tokens` exceeds the ceiling, return `required_exceeds_ceiling`;
otherwise return `total_exceeds_ceiling`, with the exact accounting in §4. Both
excess fields are therefore positive and never negative. No trimming is
performed in C2.

C3 reconstructs and remeasures after each whole optional-part removal, starting
with the largest numeric priority (lowest importance), ties by name descending.
Record the final inclusion set, `context_budget` omissions, and bound reduction;
include omission-marker bytes in measurement. Trimming starts only if the full
request exceeds the ceiling and `B(required ∪ markers(optional))` fits. If an
omission marker is larger than the body it replaces, or the admitted
`B(required ∪ markers) <= B(all)` and marker-swap monotonicity properties (§4)
are not proved, refuse as `unsupported_accounting` rather than trusting
subtraction. Never drop part of a JSON value, a required
part, or stable-prefix content. The source view/shared manifest remain intact;
only the request-specific effective view gains omissions.

### 5.5 Durable decision before dispatch

For fits, append one `inference.requested@2` containing the ledger, effective
view, complete evidence and terms. Append acceptance/persistence must succeed
before any token/cost state is folded, controller is registered or call starts.
Pass the exact sealed prepared request through `GatewayDecisionLayer.weighPrepared`
(R1) or the generation boundary; forbid regeneration from mutable candidates or defaults.
Verify the coverage binding at composition and fail on drift before dispatch.

For overflow, append one runtime-only `context.refused@1` containing the refusal,
complete valid assembly evidence or invalid-input witness, and decision id.
This record retains ceiling, estimator, templates and excluded inputs even
though no `inference.requested` exists. It changes no inference reservation and
creates no controller or gateway call. Failure to persist the refusal is an
explicit persistence failure, not a silently recorded blocked outcome.

If the full `inference.requested@2` or `context.refused@1` payload is known to
exceed the configured byte bound, do not submit it to the diagnostic-only
oversize path. Append `context.persistence_failed@1` instead, under the same
atomic durability contract. The marker binds the logical decision and owner
with fixed-size digests and records attempted type, byte count and bound; no
full decision or ledger is claimed committed. Validate closed fields, checked
sizes and deterministic identity. Rebuild a separate failure index on load;
for frontier.weigh, an unchanged fit-input digest and policy reuse that durable
stop without reassembly, new records, reservation, controller or dispatch. Do not count its bookkeeping as fresh
weighing evidence. Recovery finishes only the local P2-approved disposition.
Bind the configured byte bound into the storage-policy identity so an authorized
configuration change creates a fresh frontier.weigh decision rather than reusing
a stale stop. For goal.frame, any fresh decision requires a new action id;
configuration/input changes never create a second decision for an existing action.

Managed composition must prove the maximum encoded failure marker, maximum
encoded clarification request and maximum encoded stopped `action.result@2`
each fit its configured log bound before enabling preparation. Use the closed
contracts' maximum field lengths and checked canonical payload sizes, including
all fields; merely bounding a record without proving fit is insufficient.
T15 refuses an insufficient bound at composition, before any framing action or
overflow, so deterministic oversize cannot strand a running action on reload.
A smaller bound makes the managed configuration unsupported;
it is never silently increased. If even the marker's append fails or is
ambiguous, stop the owner, expose a content-free persistence error and reload
the journal before any continuation. Do not claim a durable failure when no
append was acknowledged, or fall back to a diagnostic as persistence. General
journal faults remain explicit failures; the marker is for known size rejection,
not a speculative second write after an ambiguous append.

Every `Runtime.appendStep` outcome (§2.5) has one defined result. The first
table covers managed decisions: `inference.requested@2`, `context.refused@1`
and `context.persistence_failed@1`. The second covers their stop-disposition
writes. Each case is checked on the returned validation, never assumed:

| `appendStep` outcome                    | Managed result                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oversize (`budget` diagnostic)          | Pre-measurement routes known oversize to the marker above, so this path is unreachable. If it is reached anyway, that is an explicit content-free persistence error: stop the owner, no dispatch, nothing claimed durable.                                                                                                                                                                                          |
| `mid_value`                             | Unreachable for captured bodies because §5.2 refuses lone surrogates as `invalid_part`/`lone_surrogate`, and witnesses carry no text. If it is reached (for example a template defect), that is an explicit contract error: stop the owner, no dispatch, nothing claimed durable.                                                                                                                                   |
| `duplicate` id                          | Decision ids are deterministic (§6.5), so the id was seen before. Look up the stored accepted record with that id. If its canonical bytes are equal, reuse it with no new append or dispatch, following §6.5 recovery for that record. If they differ, or no accepted record exists (an earlier in-memory oversize diagnostic took the id, `runtime.ts:620`), raise an explicit integrity error and stop the owner. |
| Validation `rejected` / `unknown_type`  | The assembler produced a record that admission refuses, which is a contract defect. Raise an explicit content-free error: no reservation, controller or dispatch, nothing claimed durable. Never retry as v1 or with relaxed fields.                                                                                                                                                                                |
| Journal throw (`PersistError` or other) | Propagates as an explicit failure (`appendStep` rethrows for these types). If the append outcome is ambiguous, follow §6.5: stop the owner and reload before continuing.                                                                                                                                                                                                                                            |
| `accepted`                              | The only outcome after which state folds, a controller registers or a call starts.                                                                                                                                                                                                                                                                                                                                  |

Only known decision-size rejection has a durable marker. Other decision
errors acknowledge no new complete or bounded record; claiming one durable
would be false. Preserve any previously acknowledged records.

The following matrix covers **stop-disposition writes**: runtime-source
stopped `action.result@2` and the separate runtime-only C2d-Q clarification
request. It applies to live execute, reconcile pre-pass and replay. Every
non-accepted outcome stops the owner before any continuation: no new framing
candidate, generic reconciliation, grant, reservation or dispatch. Nothing
from the failed write is claimed durable; an already accepted stop/request is
retained. Reload is required before live continuation and completes only
missing records by identity. Replay returns an explicit failure, writes
nothing and never performs recovery; any subsequent live repair requires reload.

| Stop-disposition append/feed outcome                                            | Required result                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oversize (`budget` diagnostic)                                                  | Composition size-fit proofs make this unreachable. If reached, stop the owner with a content-free contract error and reload; never turn it into another marker or infer durability from the diagnostic.                                                                                          |
| `mid_value`                                                                     | Stop the owner with a content-free contract error and reload. No relaxed validation or replacement payload.                                                                                                                                                                                      |
| `duplicate` id, including `result:${action_id}` or the clarification request id | Stop the owner and reload even if bytes appear equal in memory. Reload verifies the accepted canonical record and completes only missing writes; a differing record or diagnostic-only id is an integrity error. Do not apply the decision table's same-process duplicate reuse to these writes. |
| Validation `rejected` / `unknown_type`                                          | Stop the owner and reload with an explicit content-free contract error; no v1 fallback or assumption that framing finished.                                                                                                                                                                      |
| `PersistError` returned as `rejected` (PersistError-as-rejected)                | Stop the owner and reload. This is HEAD's action.result journal-failure path, not a thrown exception. No result is claimed durable until reload confirms it.                                                                                                                                     |
| Journal throw (`PersistError` or other), including written-then-throws          | Stop the owner and reload regardless of apparent commit status. Do not retry in process; the journal decides whether the complete record survived.                                                                                                                                               |
| `accepted`                                                                      | Live/recovery folds only after durable acknowledgment, then advances to the next missing disposition write. Replay consumes the recorded canonical payload once in memory, inline or fed according to write site and seq (§6.6), with no journal append or claim of new durability.              |

**Dedicated stopped-result step (C2d).** HEAD's `recordResult` and
`recordResultStep` (`packages/weave/src/runtime.ts:1427,1441`) return void;
`:1484` discards append's Observation, `:1486` drains unconditionally, and live
goal.frame ignores the call's result (`:2547`). `appendStep` converts result
PersistError to rejected validation (`:647-654`). Returning an Observation and
checking at that live caller cannot enforce the boundary: the drain has
already happened (§2.7).

Compose a narrow v2 stopped-result variant with the existing result machinery.
It builds the closed §4 payload, appends, inspects the returned Observation's
validation **inside the step**, and folds/continues only on accepted durable
acknowledgment. The live-execute variant calls `drainQueue` only after that
check. The reconcile variant returns the accepted Observation without draining;
the pre-pass never drains. Every non-accepted outcome or throw stops this owner
and unwinds the active dispatch/selection or reconcile step before later
selected candidates, any outer `admitStep` drain, or generic reconciliation can
run. A flag checked only next cycle is insufficient. Previously acknowledged
stop/request bytes survive; only reload can complete missing writes. Keep
ordinary v1 result callers' behaviour unchanged. C2d-Q checks its request append
before the stopped-result step and has the same failure/unwind rule.

Replay uses the same closed v2 payload/admission check in memory with journaling
disabled, plus the explicit inline-or-feed and recorded queue rules in §6.6;
HEAD's replay-disabled `drainQueue` is not sufficient. T4/T11/T15 drive both
append tables. With queued work and spare capacity, inject a live
PersistError-as-rejected result after accepted stop/request: zero subsequent
`action.started`, host invoke, new framing candidate or continuation. The
mutation **check validation after recordResult returns** must fail, as must
ignoring the returned validation or failing to unwind the remaining selection.

Closed P2 (D-ENG-026) prefers operator clarification for overflow before
failing the goal or retaining a blocked frontier. The framing action always ends
with exactly one `action.result@2`, outcome `failed`, failure `context_overflow`,
with `context_decision_id` naming the refusal. For a persistence marker it likewise
ends with exactly one `action.result@2`, outcome `failed`, failure
`context_persistence_failure`, with `context_decision_id` naming the marker.
An action failure does not itself settle the goal while its separate clarification request is pending.
C1's contract fixes this action/goal distinction. Named sub-item **C2d-Q** owns
the closed, versioned runtime-only goal-level clarification request shape and its
admission/load/replay integration before enforcement; HEAD has no such mechanism
(`packages/weave/src` has no `clarif` match). The request references the same
owner, framing action and refusal decision, is durably written at most once per
decision before its action result, and is preferred before the goal fail/block
fallback. Pending clarification never leaves the framing action running and
authorizes no call, grant or spend. C2d-Q must prove the maximum encoded
clarification request fits at composition as above and fault-test that record;
rejected/ambiguous writes stop the owner and require reload, never generic
reconciliation. Reload completes missing request/result writes by recorded
identity, including after the request is durable but the result is not.
For evidence oversize (including an oversized refusal), the local failure/block
uses `context_persistence_failure`, referencing the durable failure marker
rather than a nonexistent refusal. Storage failure requires a separately
authorized configuration/input change. Neither path authorizes summarization,
evidence loss or automatic recovery.

Re-framing needs candidate formation work, not just a new action id.
`failedCandidateIds`, `formCandidates` and `frameCandidate`
(`packages/weave/src/candidates.ts:70,78,302`) currently exclude every failed
candidate with a failure string (`push` filter at `:100-104`), while framing
inputs are only `{ goal_id }` (`:305`). C2d-Q preserves that exclusion and adds
an explicit accepted, authorized clarification response record id as
`clarification_response_id` in the new framing inputs; `candidateId`
(`packages/weave/src/digest.ts:10`) then derives a different candidate id.
The response binds the pending request, refusal, owner/goal and authorized
input/configuration revision. Only the first valid response resolves a pending
request; duplicate, stale, unauthorized or cross-owner responses cannot enable
formation. Without one, the failed candidate stays excluded across cycles and
reloads. A storage failure similarly needs a separately authorized durable
configuration/input-change observation bound to its marker; a raw revision
change is never an implicit retry authorization. C2d-Q adds its observation id
as `context_change_id` in fresh framing inputs for the marker path; the two
response/change identity fields are mutually exclusive.

The first accepted queue/start for that response/change identity binds it to
one new action id, reconstructed from recorded action inputs on load; a later
start of the same queued action preserves the binding. No separate consumed
flag write creates a crash gap. Candidate formation must exclude a response
already bound to any pending/running/terminal action, including uncertain or
cancelled work; a later failed attempt needs a new authorized response/change,
never reuse of the old one. Before queue/start, revalidate the response,
current authority, budgets, read set and existing in-flight framing guard
(`candidates.ts:110-113`). This creates at most one fresh candidate/action per
response, no automatic cycle loop, no reopening of the old action and no
renewal or reuse of its single-use grant. A fresh action gets its own decision
and ordinary dispatch checks. Cancellation/goal closure prevents new work;
replay reconstructs response/formation/bindings without executing or writing.

Frontier weighing status comes only from `this.current.inferences`
(`Runtime.frontierWeighStatus`, `runtime.ts:1040`), which `inference.requested`
builds. A `context.refused@1` or `context.persistence_failed@1` creates no
inference record, so without wiring every later cycle would return `needed` and
reassemble. C2d therefore:

- Rebuilds site-specific stop indexes on load and on accepted append. For
  frontier.weigh the key remains
  `(candidate_set, fit_input_digest, policy_digest, storage_policy_digest)`
  within its owner scope. For goal.frame, the unique stop and decision key is
  `(owner scope, started.action_id)`: at most one accepted decision, whether fit,
  refusal or marker, and at most one stop for that framing action. Its
  `fit_input_digest`, `policy_digest` and `storage_policy_digest` are verified
  bindings, never additional uniqueness components. A same-action binding
  mismatch or second decision is an integrity error that stops the owner,
  never permission to select another stop or create a fresh decision.
  Its `candidate_set: null` (`Runtime.frameGoal`, `runtime.ts:1273`) is never
  a shared stop namespace: different framing actions cannot reuse one another's
  stops. Each key component and binding is a durable field in §4, not inferred from the
  decision id. The storage-policy digest includes the configured byte bound
  (above).
- Defines the **fit-input digest** as `digest(value)` over the captured
  authorized inputs minus exactly the paths in the snapshotted site contract
  `volatile_fields` list, verified by `volatile_fields_digest`. A
  per-cycle key without that exclusion would never match, which brings back the
  livelock. For frontier.weigh at HEAD the volatile fields are `request_id`
  (`inf:c${cycle_no}:weigh`), `StateView.state_revision`, `terms.deadline`
  (`clock.tick + 100`) and `terms.cost_ceiling` (remaining-cost minimum), all
  set in `Runtime.weighAndSelect` (`runtime.ts:851`). For goal.frame the
  list is empty: no tick-tolerant recapture/reuse is supported for an existing
  framing action. Bind its original terms, view and manifest in full, including
  `manifest.slices[].assembly_id`. `stampAssemblies` and `sliceAssemblyId`
  (`views.ts:80,74`) derive that id from `state_revision`, both on direct render
  (call at `runtime.ts:1236`; shareAssemblies option at `:1240`) and via
  `prepareSharedViews` (`runtime.ts:805`; prepared view stored at `:810`). A tick can therefore change that binding as
  well as deadline, cost ceiling and state revision. Its `request_id = inf:${started.action_id}`
  and optional `prefix_digest = digest(stablePrefixBytes(profile, view))`
  (`runtime.ts:1245,1254`) are derived identities, not volatile fields.
  Admission requires the volatile set to be disjoint from every field the
  accounting family consumes.
  Otherwise the contract is `unsupported_accounting`. A change in any other
  frontier.weigh input can trigger reassembly: view content or manifest, the
  remaining terms, site contract or policy, and storage policy. A volatile-only
  frontier change cannot. Goal.frame requires a new action for any new attempt.
  `renderWeighView` output is always canonical JSON, so the digest is always
  computable there. A C4 witness-only refusal over non-JSON input needs fresh
  explicit owner input instead (§10).
- In live `Runtime.frameGoal`, consults the action-keyed decision index before
  accounting or append as a fail-closed guard. HEAD's only live call is
  `liveEnvironment.execute` (call at `runtime.ts:2545`); there is no live
  frameGoal re-entry for an existing action id. Restarted running actions go to
  `reconcileStep`, not back to framing. Direct guard tests with the exact
  recorded bindings reuse only the stored decision/bytes without append or
  dispatch; direct tests after a tick or any binding change raise an integrity
  error. Recovery resolves the original decision without recapturing current
  inputs. The §5.5 duplicate/integrity-error guard still applies to actual
  duplicate appends, independently of this guard.
- In `Runtime.reconcileStep` (`runtime.ts:1845`), handles a running goal.frame
  action with an accepted `context.refused@1` or
  `context.persistence_failed@1` for its owner scope and `action_id` in a
  pre-pass over **every** such running action, after
  `abandonUnrecordedInferences` (call at `:1846`) and before constructing
  `unfinished` (`:1847`) or entering its loop (`:1850`). Finish and fold these
  local dispositions, then construct `unfinished` excluding resolved actions;
  do not place the branch inside that loop. The allowance check (`:1854`)
  calls `recordRecoveryExhausted` (`:1509`) and returns from the whole step
  (`:1855-1856`), so any generic action iterated first could otherwise strand
  a framing stop. Only remaining generic work reaches `recovery.attempted`
  (`:1863`) and `grantForLookup`/`host.lookup` (`:1875-1876`). Resolve the recorded
  decision by logical attempt, not a recaptured current view; finish only its
  local P2 disposition, binding `context_decision_id` to that decision. Apply the action outcome
  and separate, deduplicated C2d-Q clarification contract above. Append exactly
  one failed `action.result@2` with the verified `context_decision_id` through
  the checked, non-draining stopped-result step above, no
  `recovery.attempted`, no recovery spend, no lookup grant and no host/gateway
  call for these framing actions, even with zero recovery allowance. An already
  accepted result is inert on later reload. The pre-pass never calls ordinary
  `recordResult`, `drainQueue` or `environment.execute`. Queue draining added by
  this feature stays at the existing end of reconcile (`:1897`), after remaining
  generic work, and is not reached on its exhaustion early return (`:1856`).
  Existing generic result/ingress nested drains remain as traced in §2.7; do not
  mistake the final explicit drain for HEAD's only possible drain.
  With no open inference to abandon, a pending queued action, an exhausted
  generic action ordered first and a stopped framing action second, the pre-pass
  finishes the framing disposition and then exhaustion returns: zero new
  action.started and zero host invoke. A mutation that drains inside the pre-pass
  must fail T9-R0. A rejected or ambiguous result append stops this owner and
  reloads before continuation; it never falls through to generic
  reconciliation. `abandonUnrecordedInferences` (`:1906`) cannot supply this
  branch: these stops have no `inference.requested` to abandon.
- Adds a `{ kind: 'refused', decision_id }` arm to `frontierWeighStatus`,
  covering both record types. After the global `in_flight` check, resolve the
  latest durable decision for this candidate set by observation seq **before
  the `finished`/`deferred` inference-outcome branches and all `needed` returns**
  (`runtime.ts:1050-1066`). Compare accepted stop observations with accepted
  `inference.requested@2` observations; accepted here means journal admission,
  irrespective of the later model outcome. A newer accepted v2 request
  supersedes the stop and follows the existing inference-outcome rules. A
  newer stop wins over every older recorded outcome, including an unaccepted
  weighing that would otherwise return `finished` or weights that would return
  `deferred`. Legacy v1 status rules remain when neither a stop nor v2 decision
  exists. When the latest is a stop, it recomputes the current fit-input digest
  with the pure capture step
  only (`renderWeighView` plus the site contract). That step reserves, charges
  and appends nothing, and accounting still runs only after both budgets pass
  (below). If the full key matches, the result is `refused`. On any mismatch it
  returns `needed` directly, without consulting older inference outcomes. The next durable decision for that candidate set
  then supersedes the stop: an accepted `inference.requested@2`, or a new
  refusal or marker under the new key. Supersession is derived from log order
  on rebuild. It writes no extra record, so a crash between decisions cannot
  half-supersede a stop.
- Makes `Runtime.weighAndSelect` map `refused` to cycle
  `blocked: context overflow` or `context_persistence_failure` (P2), with the
  decision id. That path makes no call and appends nothing.
- Excludes refusal and marker observations from weighing evidence.
  `Runtime.evidenceSince` (`runtime.ts:1074`) reads `evidenceHigh`, which
  `Runtime.indexAccepted` (`:1960`) advances for every accepted record whose
  type is not in `WEIGH_CONTROL_RECORDS` (`runtime.ts:161`). C2d adds
  `context.refused` and `context.persistence_failed` to that list, so neither
  counts as new evidence for the `stale judgment` / `deferred` rules
  (`:1058-1064`).
- Keeps today's order in `Runtime.weighAndSelect`: status
  (`frontierWeighStatus`, `:879`), then the judgments budget (`:897-903`), then
  the cost budget (`:905-913`), then assembly. A refusal therefore charges
  neither budget. Assembly runs only after both budgets pass, and exhausted
  budgets keep their existing unjournaled block when no matching stop applies.
  They prevent new assembly/refusal; a matching stop still returns `refused`
  before budget checks, even when a budget is exhausted.

For frontier.weigh, a repeated cycle with an unchanged fit-input digest and
policy reuses the recorded stop rather than appending forever. A cycle whose fit-input digest
changed, once both budgets pass, reassembles and records one new decision that
becomes the latest for its candidate set. New recovery or escalation is not
a consequence of logging or of a Weft emission.

## 6. Failure, cancellation, concurrency, crash and replay

### 6.1 Failure

Malformed parts, unsafe totals, unsupported accounting/capacity, ledger mismatch
or over-budget input cannot reach dispatch. Append rejection/failure leaves no
new inference reservation, accepted ledger index or controller. A throwing
estimator also fails closed with an explicit accounting failure; do not hide it
as a successful measurement. Every non-accepted `appendStep` outcome follows the
§5.5 table: a durable marker only for known size rejection, otherwise an
explicit error with nothing claimed durable. Existing `no-swallowed-failures` remains enforced.

### 6.2 Cancellation

Synchronous assembly cannot be interrupted midway by an asynchronous callback
in the runtime's `step`. Test supported boundaries: an already cancelled owner
or signal before capture produces no dispatch; a cancel queued while a step is
running is processed at the next boundary; after durable append but before call,
recheck an already observable signal/owner flag and settle without dispatch if
cancelled. Do not invent an asynchronous yield inside the step: queued ingress
cannot be processed there. After call, pass the signal through and follow existing gateway cancellation and
settlement rules. A late result cannot advance cancelled work or settle twice.
A refused request has no `inferAbort` entry and no reservation to release.
A persistence-failure marker also has neither. Cancellation before/after its
append cannot dispatch or erase its durable stop. Cancellation cannot erase
any acknowledged ledger or evidence.

### 6.3 Concurrency

A window is per request, with no shared token pool or cross-request token
reservation. The pure assembler keeps no module state. Independent runtimes or
owners may assemble concurrently; one Loom instance preserves its existing
single-writer sequencing and at most one pending frontier weighing. Do not
invent simultaneous goal.frame/frontier.weigh dispatch contrary to that state
machine. Exercise supported overlapping work with distinct scopes/request ids,
different policies and inverse completion/cancellation order. Ledgers, detached
bodies, failure indexes and cost settlement must remain isolated. Durable stores keep their
existing single-writer ownership; a second writer is rejected, not a source of
concurrent mutation inside a request.

### 6.4 Token terms, gateway pricing and Loom reservations

C2/C3 keep policy ceiling and enforced request term equal. Certification makes
the gateway's declared input bound defensible; it does not turn the bound into
actual usage. `worstCaseCost` is per-attempt input/output pricing; pacing counts
input term plus output allowance. Loom currently reserves `cost_ceiling` in
`inference.requested`, then settles reported spend (or the full reservation on
abandonment). Do not claim C2 shrinks that reservation.

C6 uses `context.ledger@2`: `ceiling_tokens` stays the approved policy ceiling,
`reserved_tokens = terms.max_context_tokens = max(1, used_tokens)`, and
`used_tokens <= reserved_tokens <= ceiling_tokens`. All other v1 evidence and
recomputation rules persist; no validator may still require equality with the
policy ceiling at v2. Reconstruct and remeasure with the final tightened terms;
only admit contracts that prove the bound remains valid under that substitution
(or compute and validate a stable term/bound before append). Do not change a term
after its request digest has been sealed. C6 can change route eligibility,
worst-case attempt prices, prefix-cache pricing and pacing on managed calls. It leaves Loom's money
reservation equal to the explicit `cost_ceiling`; accepted, failed, cancelled,
usage-unknown and abandoned settlements must still release/charge once. Any
later reduction in the monetary reservation requires a separate contract and
red tests covering all attempts, outputs and uncertain spend, not this C6.

### 6.5 Atomic durability and crash boundaries

Require an atomic complete-record append contract from the injected journal:
acknowledgment means the whole decision and inline evidence are durable before
any fold/dispatch. Never assume a flush.

Do not design a new protocol. The reference implementation already exists:
`FileAttemptJournal` (`implement-step.ts:1154`; `sites/CONTRACT.md:298-306`).
It writes every byte and fsyncs before returning, and fsyncs the directory when
it creates a file. It repairs a torn final line on first read (it truncates an
unparseable tail and terminates a complete record that lacks its newline). It
latches an incomplete append so the instance refuses further calls (#249), and
it fails closed when another writer changed the file (#131). Under D-ENG-021,
C2b extracts that append/read/repair/latch/writer-check protocol into one
internal module that both `FileAttemptJournal` and `FileJournal`
(`journal.ts:43`) use, behind the unchanged `ObservationJournal` interface.
`FileJournal` keeps its `failStarts`/`failResults` fault hooks.
`FileAttemptJournal` behaviour does not change. Its existing torn-tail and
incomplete-append tests are the regression guard for the extraction:
`a torn final line is repaired so later attempts stay loadable and resume does not repeat one`
and `a part-written file journal append is reported as incomplete, not as another writer (#249)`
(`test` declarations at `packages/weave/test/p8.test.ts:1096,1903`; navigation
hints only). Its silent skip of a duplicate entry id
stays specific to `AttemptJournal`; the runtime's own `duplicate` validation
handles duplicate observation ids (§5.5). Any other injected journal must state
the same contract or managed enforcement refuses it as unsupported.

HEAD red for T9/T15 (observed before C2b code): `FileJournal.persist` uses
`appendFileSync` with no fsync, and `FileJournal.snapshot` (`journal.ts:67-72`)
runs `JSON.parse` on every line. A journal with a torn final line therefore
throws on load instead of recovering. T15 asserts recovery from a torn final
line and an fsync before acknowledgment (through an injected fs fault gate), and
both fail at HEAD.
Extend the existing `m1-crash-worker.ts` child-process pattern and the
`M1-T13 crash at commit/result boundary does not duplicate publication` test
(`packages/weave/test/m1-crash-worker.ts`, `packages/weave/test/m1.test.ts:360`).
Add injected fault gates for decision/refusal/failure-marker append and result
boundaries, partial writes/torn tails and written-then-throws ambiguity; restore
the real file journal in the parent and reload twice. Assert canonical ledger
and evidence bytes, one disposition and exact reservation/settlement counts,
with zero redispatch. Retain M1's publication/grant assertions. Process-exit
tests alone do not prove power-loss durability; pair them with deterministic
write/flush fault checks against the specified journal protocol.
Keep storage I/O in the journal, outside the pure assembler. A torn uncommitted
suffix is explicitly rejected/recovered by the journal protocol; never repair
a complete invalid record or delete an acknowledged decision. Flush/atomicity
support is a prerequisite for the crash guarantee, including power-loss claims.

Use site-specific deterministic decision ids. Goal.frame ids bind only owner
scope and `started.action_id`; uniqueness excludes the three digests, which
remain verified bindings. Frontier.weigh ids bind owner scope, logical attempt,
`fit_input_digest`, `policy_digest` and `storage_policy_digest`. The previously
named "captured input digest" is exactly `fit_input_digest` (§5.5), not the
full prepared-request digest, which separately binds every dispatched field.
For goal.frame the logical attempt is `started.action_id`
(`Runtime.frameGoal`, `runtime.ts:1228`; request id at `:1245`); recovery keeps
that identity and a fresh framing attempt requires a new action id.
For frontier.weigh the logical attempt is the cycle's `request_id`
(`Runtime.weighAndSelect`, `runtime.ts:916`). It intentionally varies per
cycle; stop-key reuse (§5.5) prevents volatile-only changes from generating new
records. Inputs A, then B, then A again in fresh attempts therefore yield three
distinct ids, including after reload. For goal.frame, recovery retains the
accepted id and original canonical bytes without recapture. There is no live
same-action framing re-entry; the direct guard tests reuse exact bindings and
reject any change, including tick-derived values and shared assembly ids
(§5.5). A changed digest for that action cannot create a new id or decision.
Distinct action ids with otherwise identical fit inputs yield distinct stop
keys and decision ids. Same-attempt
retries retain the id and must match canonical decision bytes. Accepted decision ids occur once in the
durable log and its rebuilt index. The §5.5 duplicate row still protects
same-attempt retries and the diagnostic-id/no-accepted-record case at
`Runtime.appendStep` (`runtime.ts:620`); per-cycle ids do not remove that guard. A duplicate cannot overwrite an outcome,
reserve twice or become a second call. If append outcome is ambiguous, stop
this owner and reload the durable journal before continuation; do not retry
append and dispatch in the same process on an assumption of failure.

- Immediately before complete append: no committed ledger/reservation exists
  and no call has occurred. Reassembly after recovery is new work using explicit
  current inputs; it must not masquerade as replay of an uncommitted decision.
- Immediately after durable append, before fold or call: load restores exactly
  one ledger and reservation (or one refusal with none). Do not redispatch the
  recorded request, even though no live call is known.
- After dispatch, before result: preserve evidence; existing abandonment charges
  the full Loom cost reservation once and records completion without resending.
- After result append, before settlement/index update: fold/recovery reproduces
  exactly one settlement. Failed result append or a late duplicate result cannot
  lose the ledger, double-charge or free another request's reservation.
- For refusals or persistence-failure markers, crash before the subsequent
  action/cycle result reuses the recorded decision and finishes only its local
  disposition; no model call or second refusal/failure marker is introduced.
  For goal.frame, C2d's `reconcileStep` pre-pass (§5.5) restores the P2 disposition
  with `context_decision_id` naming the recorded stop, before constructing the
  generic unfinished loop and even with no recovery allowance: one durable
  `action.result@2`, zero `recovery.attempted`,
  unchanged recovery spend, no lookup grant or host call. Crash between the
  stop and result writes, after the result write before fold, and a failed or
  ambiguous result write all use the same recorded decision on reload; an
  accepted result cannot be duplicated. Overflow also writes at most one
  separate C2d-Q clarification request; crash between stop/request/result
  writes completes only missing records, never leaves the framing action open
  for a response. A generic unfinished action ordered first cannot pre-empt
  this pre-pass; its existing recovery-exhaustion behavior runs afterwards.
  For frontier.weigh, the reloaded stop
  index matches the re-run cycle's fit-input digest (§5.5). A fresh attempt
  requires explicit new inputs or the separately approved P2 policy. For
  frontier.weigh, a changed fit-input digest is such an input. For goal.frame,
  clarification/failure follows closed P2; a fresh framing attempt requires
  the authorized response/change identity in candidate inputs (§5.5, C2d-Q),
  a fresh candidate/action id and a fresh decision. Crash before its queue/start
  leaves the response available; crash after the binding cannot reuse it.

### 6.6 Byte-for-byte replay

For every v2 decision, resolve and verify the full historical site assembly
policy, complete profile, serializer/validator, accounting algorithm and proof
bundle, budget/allowances, template bodies, substitutions, original terms,
pre-trim view/manifest and every part body from its evidence. Verify the
recorded `volatile_fields` list and `volatile_fields_digest`, recompute
`fit_input_digest`, `policy_digest` and `storage_policy_digest`, and rebuild
the stop key and decision id from the recorded owner/logical attempt. No
current volatile-field defaults may influence replay. Rebuild the exact
prepared request, effective view, ledger or refusal and compare canonical
`stableStringify` bytes and digests. Reproduce ordering and safe arithmetic.
Do not consult current defaults, templates, profiles, routes, model aliases,
source files or trimmed views to fill a historical hole.

C2c extends the constructor's `replayRequests`/`replayFrameRequests` indexes
(`Runtime` constructor, `runtime.ts:282-288`), or their version-dispatched
replacements, to include accepted `context.refused@1` and
`context.persistence_failed@1`, indexed by decision id and owner/logical
attempt as well as site. `recordedFrameProfile` and `nextReplayRequest`
(`runtime.ts:2178,2199`) must dispatch on the recorded type: a refusal resolves
its historical evidence/contract, while a marker resolves only its recorded
failure and policy identity, never a nonexistent `.view`. C2d makes
`Runtime.frameGoal`'s replay branch select and compare that recorded stop by
`started.action_id`, rather than assemble and append a fresh refusal/marker.
Consume the recorded observation once in sequence into the in-memory replay
trace; write no journal record, reserve nothing and call no gateway. The
`replayEnvironment.execute` goal.frame branch (`runtime.ts:2625-2627`) must
then distinguish synchronous live disposition from later recovery disposition.
HEAD's `nextSeq` (`runtime.ts:597`) is the cursor boundary.
HEAD's `accepted.find` (`:2628-2631`) finds a result by action id, but the runtime
branch immediately calls `recordResult` (`:2645`); neither lookup alone nor a
uniform return-null policy preserves both paths. `reviewGoal` returns null in
live too (`:1203-1214`), unlike synchronous framing failure.

**Inline-or-feed disposition cursor (C2c/C2d/C2d-Q).** After consuming and
verifying the recorded stop, resolve its unique request (overflow) and v2 result
by owner/action/decision, preserving their complete canonical envelopes. For
each required record in request-before-result order, reproduce the contiguous
prefix whose recorded `seq === this.nextSeq()`. Use the same checked request
and v2 stopped-result step as live, in memory with no journal; compare canonical
bytes, version and validation before advancing. A reproduced inline result
returns its outcome to dispatch and reproduces its recorded queue continuation
below before the next selected candidate. If the next disposition is not at
nextSeq, return null and leave that record (and later missing dispositions) for
trusted feed at their own seqs. A request may be inline while its result is
recovery-delayed after a crash between those writes; decide per record, not
once for the whole action. An adjacent recovery-written record may be
observationally identical to an inline record; adjacency permits in-memory
reproduction only, never a new live effect or an unrecorded queue start.

C1's feed-or-regenerate contract is keyed by **(record type, write site)**,
including the continuation caused by that write:

| Record / write site                                                                  | Replay policy and continuation                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C2d-Q overflow request / live execute                                                | Reproduce inline when next in seq, before the result and later selected starts. A crash-delayed suffix uses the feed branch. No drain from the request itself.                                                                                                                                                  |
| Stopped `action.result@2` / live execute                                             | Reproduce inline through the checked v2 result step when next in seq; return outcome and reconstruct recorded queued starts before later selected candidates. Never call ordinary v1 `recordResult` or use a blanket feed policy.                                                                               |
| C2d-Q request or stopped result / reconcile pre-pass                                 | When delayed past execute, return null there and feed at recorded seq. Feeding either runtime record admits/folds only, with no cycle or queue drain. Complete only the missing suffix, including request-durable/result-missing crashes; never invoke reconcile during replay.                                 |
| `action.started` of already queued work / live result drain or recovery continuation | Reconstruct at the original recorded position using the pending queue identity and historical payload, through the non-executing replay environment below; never a host invocation or a freshly issued grant.                                                                                                   |
| `recovery.exhausted` / generic early return after the new stop pre-pass              | In logs containing the new stopped-framing disposition, consume at recorded seq only after verifying remaining generic unfinished work and its recorded exhausted allowance. No drain, recovery attempt, lookup or repair. C2d owns this scoped ordering case; do not silently skip this runtime-source record. |

C2d extends `replay()` (`packages/weave/src/runtime.ts:2754`) with
`feedStopResult` beside `feedReviewResult` (`:2780-2781`), and C2d-Q adds its
request predicate. C2d also adds scoped feed-loop predicates for a pending
queue start not already reconstructed inline and for the exhausted-recovery
record in the table above. They use the same seq/consumption checks; no general
runtime-source bypass is introduced. Each disposition or queued start has
exactly one cursor state: pending,
reproduced inline, or fed. At its feed-loop entry, skip it only if already
reproduced inline with identical bytes/seq; otherwise consume it only at nextSeq
through trusted replay admission, preserving its recorded v2 payload and
reference. Double consumption, no consumption, unknown/mismatched reference,
wrong order or validation failure is replay failure. No live ingress gains
runtime-source authority. Keep `checkPrefix` (`:2833-2845`), final log-length
and unfinished-action checks (`:2789-2797`) intact.

**Recorded queue continuation.** HEAD `drainQueue` returns immediately in
replay (`runtime.ts:1778-1779`), so calling it after an inline result cannot
satisfy T9-L2. C2d composes its pending filtering/order, slot and historical
authority checks (`:1781-1802`) with replay's non-executing environment. Consume
only a next-seq recorded queue start matching an already accepted pending
`action.queued`, including its action/candidate id, inputs, read set,
reservation, recorded grant and invocation identity; cancelled work cannot
start. Reconstruct the same canonical start (`:1813-1832`) and call only
`replayEnvironment.execute` for its recorded outcome/decision, never
`liveEnvironment`, `invokeHost`, `grantForLookup` or `reconcile`. Inline result
continuations run before dispatch returns to later selected candidates.
Recovery-delayed results fed from the pre-pass do not initiate this drain;
any later recorded queued start is consumed separately at its recorded position
under the queue entry above. Do not start another pending action just because
it could run, or feed arbitrary runtime starts: no matching recorded start,
no reconstruction; missing expected records or leftover pending work fail.
No grant is issued, renewed or consumed and no journal/Weft/gateway/host effect
occurs. T9 pins complete observation order and cycle/state equality, not only
the final framing failure.

The stop precedes its referencing result, exactly one of each per framing
action; adjacency is not required. `reconcileStep` calls abandonment first
(`runtime.ts:1846`); its gateway-source `inference.recorded` (`:1911-1923`)
can lie between stop and disposition, and ingress can itself cycle (§2.7).
T9-R1 derives this through the real FW-T08 recovery fixture, with no queued work
that abandonment could start; replay feeds the abandonment and reproduces its
ordinary cycle before feeding the delayed request/result, without recovery or
new calls. T9-L1/L2 instead exercise synchronous live overflow/marker and queue
continuation. Mutations that feed uniformly and regenerate uniformly must each
fail a different row. Preserve the separate authorized response in sequence and
rebuild its response-to-action binding from queue/start inputs without reusing
a response or grant. Replay never repairs missing records by append.

Changed defaults/templates must not affect replay. Missing historical code,
proof, excluded bodies or valid snapshot data is an explicit replay failure,
even if the old request fits today's ceiling. Overflow replay uses the durable
refusal evidence; an invalid-input witness replays only its recorded rejection,
never authorizes execution. Historical v1 logs keep historical behavior without
invented ledgers. Replay invokes no gateway, capability, Weft port or recovery
effect. Recovery loads immutable decisions first and follows §6.5; it does not
rerun inference to reconstruct evidence. A `context.persistence_failed@1` marker
replays only its canonical failure bytes and durable stop/disposition. Missing
full evidence is explicit: it cannot recreate a ledger, certify token totals or
stand in for a complete `context.refused@1` record. Preserve every acknowledged
fit/refusal ledger and its evidence byte-for-byte, without duplicate or lost
state, across crashes and repeated recovery.

### 6.7 Grants and effects

Assembly issues, consumes and renews no grant and cannot grant disclosure.
C4 places generation preflight before implementation checks request any fresh
single-use grant. Overflow, append failure and cancellation mint no check grant.
Existing per-check grants remain fresh and equal in scope; reconciliation of
an already-issued invocation follows its owner's existing contract. Fabric does
not import Loom, scheduling or these per-site policies.

### 6.8 No ambient clock, entropy or environment

All policy, ordering and version resolution are explicit inputs. The new module
remains covered by `checks/no-ambient-clock`, `no-ambient-entropy`,
`no-ambient-env` and import-direction checks. Historical times come only from
recorded observations; tests inject clocks and timers where existing APIs need
them. Adapter order bounds never call ambient randomness during assembly.
The ambient checks scan `packages/*/src` only (`checks/no-ambient-clock.mjs:17-22`),
so they do not cover `benchmarks/`. The frontier-weigh harness reads
`Date.now()` and a `setTimeout` (`benchmarks/frontier-weigh/run.ts:113-140`).
§7 guard 6 therefore injects the clock, `measure` and any timer itself
rather than relying on the check.

### 6.9 Keys stay out of argv and logs

Ledger, refusal/failure summaries and Weft fields contain only closed part names/codes,
counts and digests (`metric`/`reference`); no raw body, dynamic question text or
exception message. Closed template identifiers replace content-derived names.
Replay snapshots **do contain authorized content** and stay in the protected
evidence journal, never argv, CLI output or diagnostic/Weft logs. Credential
values are neither accounting configuration nor replay inputs; reject them at
the capture/persistence boundary with the existing credential screen and a
content-free witness. Such a witness records a rejection only and cannot
substitute for a valid fit or numeric-overflow evidence snapshot. A missing or
rejected evidence snapshot cannot be worked around by logging its body. Shared gateway credential/privacy checks remain
intact. Test with canary keys in bodies, templates and errors and inspect argv
and logs, not just the ledger type.

## 7. Guardrails must not leak into benchmark routes

Unchanged behavior is an acceptance requirement, not established merely because
the current diff edits only this plan. Every child touching a shared path must
prove all of these guards with fixture transports, without hosted model calls:

1. Direct benchmark gateway requests in §2.6 bypass managed preparation exactly
   as today. Pin the complete request, effective terms, selected/excluded routes,
   prices, spent/unknown-usage accounting, pacing order with injected time,
   deadlines, retries, prefix-cache behavior, uncertainty strings and outcomes.
2. Capture real adapter HTTP bodies for generation and evaluation fixtures,
   including OpenAI messages and TypeSafe translated questions. Pin payload
   bytes and shuffle/reference settings. Compare before/after on affected shared
   callers, including direct `judgeCriteria`/`judgeValidation` benchmark use.
   An optional managed wrapper must be absent from direct benchmark composition.
3. Keep `renderWeighView`, `renderFrameView`, `assembleAuditState` fixture output
   digests and `stablePrefixBytes` unchanged. C3 operates on detached effective
   views only. Preserve corpus/artifact/plan digests and permutation order.
4. Retain `node --test scripts/benchmark-digests.test.mjs`, `npm run test:jev`,
   `npm run test:frontier-weigh` and `npm run test:decision-sites`. Stored-file
   digest checks supplement, not replace, the live fixture request guards.
5. No default gateway guardrail or route-document rewrite in this parent. If a
   prerequisite shared API change is needed, keep legacy direct behavior and
   test both paths. Do not refresh benchmark goldens/digests to hide a regression.
6. Frontier-weigh benchmark route (R1). Before any C2d change, add a fixture
   test that drives `siteWeigher` (`benchmarks/frontier-weigh/weighers.ts:71`)
   for `constant-dispatch`, `constant-defer` and a `jev`-shaped fixture unit and
   pins the complete `gateway.evaluate` payload: `request_id`, `site`, `role`,
   `kind`, `state`, `questions` and every `terms` field. It is green at base and
   must stay identical after C2d. Mutation: route `siteWeigher` through
   `weighPrepared` (or let `weigh` read a prepared field); the guard must fail.
   The guard composes `siteWeigher` with a fixture gateway whose `clock` and
   `measure` are injected. `configureJev` reads `Date.now()` and races
   `setTimeout` (`run.ts:113-140`), and `checks/no-ambient-clock.mjs` does not
   scan `benchmarks/`. So a child that touches that wrapper first makes its
   clock and timer injectable and pins them in this guard, rather than relying
   on the check.

## 8. Red-before-green acceptance plan

Every implementation child starts with its versioned contract and behavioral
checks, demonstrates an assertion failure at its base or against a deliberately
invalid implementation, then implements and proves green. A missing import or
type error alone is not demonstrated behavioral red. Validate tests against
mutations such as always-fit, body-sum-only, omitted evidence, downgrade-to-v1,
rebuild-at-dispatch and dispatch-before-persist. Reserve independent adversarial
and held-out cases before estimator comparisons; implementer cases are not the
sole quality evidence. No test threshold, permission or check is weakened.

| Test | Child and location                                                  | Required behavioral assertion before implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | C1, `context-budget.test.ts`                                        | Required input one over ceiling refuses with exact total/required/excess fields; exact equality fits. Placeholder always-fit fails. A request whose full input fits but whose markers-inclusive required figure would exceed the ceiling fits in C2 (fit is decided on `full_tokens` alone), and no record carries a negative or zero excess. A required-first ordering mutation fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T2   | C1/C2d, same                                                        | Required fits but optional content makes total one over: `total_exceeds_ceiling`, exact `over_by_tokens = total - ceiling`; C2 never trims. Protected bodies/digests remain complete. C3 variant: an accounting whose omission markers exceed the optional bodies they replace returns `unsupported_accounting` and trims nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T3   | C1/C2a, accounting fixtures                                         | Complete wrapper-heavy request exceeds a budget that a leaf-body sum fits. Capture exact projected TypeSafe/OpenAI bodies; exercise escaping, long property names, many questions/slices, CJK, emoji (well-formed surrogate pairs), base64, empty framing, settings and permutations. Refuse an uncovered fallback, tokenizer revision or unproved allowance. A lone surrogate (`"\uD800"`) is refused at capture (`lone_surrogate`). Over the actual canonical functions, `payloadBytes` gives 8 versus 5 bytes for `"\uD800"` versus `"\uFFFD"`, and `digest` differs. A mutation hashing raw UTF-8 string bodies (`Buffer.from(body, 'utf8')`) collides and fails the test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T4   | C1/C2d, pure validation                                             | Reject missing instructions/questions, protected relabeling, unknown/duplicate parts, wrong inventory, cyclic/BigInt/accessor/undefined/non-finite/sparse bodies, depth/node limits at and one over, lone surrogates in values and keys (`lone_surrogate`, witness with structural path only, and the witness `context.refused@1` passes `hasMidValue` and appends as accepted), negative/unsafe values and safe operands whose sum overflows. Assert closed invalid variant with absent invalid numbers, zero dispatch and no secret-bearing diagnostics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T5   | C2d, `context-budget-runtime.test.ts`                               | Oversized goal.frame: zero fixture-adapter calls, no `inference.requested`, unchanged inference cost reservation; exactly one durable refusal with full evidence, referenced by the P2-approved disposition. HEAD currently dispatches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T6   | C2d, same                                                           | Oversized frontier.weigh: zero calls/reservations and one refusal; repeating unchanged cycles adds no refusals and does not spin due to its own bookkeeping. On the next cycle `frontierWeighStatus` returns `{ kind: 'refused', decision_id }` (also after reload). Judgments and cost budgets are unchanged, and the refusal does not advance `evidenceHigh` (a mutation that drops it from `WEIGH_CONTROL_RECORDS` fails). With an exhausted judgments or cost budget and no reusable stop, the existing budget block prevents new assembly/refusal. A matching recorded stop still returns `refused` before budget checks, with no new record or charge. A persistence-failure marker behaves the same. An older recorded-unaccepted weighing followed by a newer stop returns `refused` before `finished`, also after reload; an older deferred weighing followed by a stop does likewise before `deferred`. A newer accepted v2 request supersedes the stop irrespective of its later model outcome. Mutating the lookup below either outcome branch fails. Volatile-only changes (clock ticks moving `state_revision`/`deadline`, a lower `cost_ceiling`) keep `refused`. An authorized input change after a refusal returns `needed` and reassembles once. A fit gives one accepted `inference.requested@2` that supersedes the stop; still over gives exactly one new refusal under the new key. Inputs A, B, A give three distinct decisions and no `duplicate` integrity error, also after reload. Mutations that drop the fit-input digest from the key, or that use the raw per-cycle digest, fail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T7   | C2d, same and `frontier-weigh.test.ts`                              | Fits: v2 admission succeeds; captured generation/evaluation request id, state/questions/instructions, terms and digest equal the prepared request. Force differing old hard-coded terms to detect rebuild/substitution by `weighPrepared`; test retry/escalation coverage and actual AbortSignal forwarding from `startGatewayWeigh`. `GatewayDecisionLayer.weigh(WeighRequest)` output is unchanged (§7 guard 6). A managed runtime whose layer lacks `weighPrepared` refuses, with no fallback to `weigh`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T8   | C2d, cancellation fixtures                                          | Already-aborted input, queued cancellation, cancellation after append before dispatch, during call and late completion. Assert no premature call, one settlement, correct controller cleanup and no progress by cancelled work. Overflow has no controller. Cancellation queued around refusal/marker or local disposition append preserves the decision reference, completes at most one local result and never enters host reconciliation or issues a lookup grant. C2d-Q cancellation before a response or after its acceptance but before queue/start forms no new action; cancellation after binding never makes the response reusable. The stopped result retains its typed reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T9   | C2b/C2c/C2d, `w5-replay.test.ts` and M1 crash-worker pattern (§6.5) | Canonical bytes equal for fit, C3 excluded bodies and refusal replay after changing defaults, templates and profiles. Tampered/missing ledger, historical profile/algorithm/proof, excluded body or template fails; no external calls/emission. Fault immediately before/after durable append, after append before fold/call, after call before result and after result before fold; reload twice yields one decision and one settlement without redispatch. Include torn/ambiguous append and refusal/failure-marker-before-disposition crashes. Recompute stop keys and decision ids from durable fields/snapshots alone after reload; missing/tampered fit-input, policy, storage-policy or volatile-list bindings fail replay. Both sites retain their recorded logical attempt; fresh goal.frame action ids yield distinct A/B/A decisions with no repeated call or reservation. Goal.frame crash-worker rows: crash after a refusal append and after a marker append, before action.result; reload twice. Assert exactly one action.result with outcome failed and failure context_overflow (refusal) or context_persistence_failure (marker), per D-ENG-026/P2, referencing the recorded decision id, zero recovery.attempted, unchanged recovery allowance/spend and zero grant issuance, host lookup or gateway call, including zero allowance. Also crash after result append before fold and inject rejected/ambiguous result writes: no lost stop or duplicate result, no generic reconciliation. With zero recovery allowance and two unfinished actions, place a generic running action first in Object.values iteration order and the stop-bearing framing action second; test both refusal and marker. The pre-pass still writes exactly one framing result referencing its decision, with no framing recovery spend/attempt/grant/lookup; only the generic action retains existing recovery.exhausted behavior. Add a pending queued action and no open inference to abandon: zero new action.started and zero host invoke before the exhaustion return. Moving the branch inside the unfinished loop, draining inside the pre-pass or falling through to generic reconcile must fail. Overflow writes at most one separate C2d-Q clarification request across double reload; crash between stop/request/result writes (and after result before fold), including rejected/ambiguous request writes, loses or duplicates none. Drive the goal.frame decision guard directly with exact recorded bindings: same decision id and stored bytes, no append/call, also after reload. Drive it after a tick or a lower cost ceiling, with shareAssemblies both off and on: binding mismatch is an integrity error, never a second decision. These are guard tests, not a live re-entry path; two distinct action ids with identical fit inputs have separate stops/ids, including independent owner scopes. Replay a goal.frame refusal and marker through Runtime replay mode with changed defaults: identical trace/disposition, zero journal appends, duplicate decisions, reservations or gateway/host calls. Replay a crash-recovered log whose real abandonUnrecordedInferences gateway-source inference.recorded abandonment for an in-flight frontier.weigh at crash lies between stop and result; derive it through reconcile, not an arbitrary inserted observation. Compose the existing FW-T08 recovery fixture (frontier-weigh.test.ts:493) with the stopped-framing crash fixture, preserving supported single-writer scheduling and request admission. Assert identical ordered trace including abandonment settlement, exactly one stop and result per action, no append/call and no duplicate/lost state. Feed recovery-delayed stopped action.result@2 and clarification records at their recorded seq, without draining. A regenerate-uniformly mutation for either record must fail this case. T9-L1/L2/R0/R1 below also pin live inline reproduction, replay queue reconstruction and exhausted reconcile with pending work; feed-uniformly and pre-pass-drain mutations must fail. A result preceding its stop fails; adjacency is unnecessary. Removing stop types from replay indexes, requiring adjacency or making frameGoal append instead of match must fail. For stop-backed results, preserve action.result@2/context_decision_id bytes through live/recovery/replay, including unrelated intervening observations. C2d-Q response path: crash after response append before fold, before queue/start, after queue/start before dispatch, and after the new decision/result before fold; double reload reconstructs at most one new action and decision, with no reused response, grant or duplicate/lost state. A never-started response remains available for authorized continuation; a bound response never starts a second action. Replay consumes records without executing recovery or appending. |
| T10  | Every affected child, §7 fixtures                                   | Renderer/artifact digests plus actual direct and managed request/route/adapter equivalence, pricing and pacing. §7 guard 6 pins the frontier-weigh `siteWeigher` `gateway.evaluate` payload (`request_id`, state, questions, terms) with injected clock/measure; a mutation routing `siteWeigher` through the managed path must fail it. These baseline guards are green at base; add a mutation that leaks the guard into a direct route to show they detect it. Never change the pinned expected behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T11  | C2c, validation/load tests                                          | Valid v2 admitted; unsupported per-type versions and new-write v1 downgrade rejected; historical v1 still replays. Reject falsified arithmetic/allowance, body/digest/manifest/request mismatch, missing/tampered `fit_input_digest`, `policy_digest`, `storage_policy_digest`, `volatile_fields` or `volatile_fields_digest`, excluded required slice, omitted instructions and tampered terms before durability. Unknown stored versions refuse before partial fold, even if flagged accepted. Every non-accepted `appendStep` outcome in §5.5 (oversize diagnostic, `mid_value`, `duplicate` with equal and with different bytes, validation rejection, journal throw) produces its specified result, with no fold, controller or dispatch. For goal.frame fits, refusals and markers, enforce one decision per (owner scope, started.action_id). Direct guard tests with exact bindings reuse only recorded id/bytes without append/call, including after load; after a tick, changed deadline/cost_ceiling/state_revision or manifest assembly_id fails integrity without creating another decision. Reject a second same-action decision even with a different fit_input_digest, policy_digest or storage_policy_digest; distinct action ids with identical fit inputs and distinct owner scopes cannot collide. Mutations using candidate_set:null as the shared key, omitting action/owner identity, adding a digest to uniqueness, permitting same-action recapture or ignoring an assembly_id mismatch with shareAssemblies enabled fail. The recorded goal.frame volatile list is empty; a tampered nonempty list fails historical contract verification. Rejected or tampered stop observations never enter recovery/replay indexes; missing, duplicate or mismatched replay decisions/results fail without journal writes or dispatch. For action.result@2 reject a missing/unknown/cross-owner/cross-action context_decision_id, a fit reference, wrong failure code for the stop type, code with no stop, stop-backed free-text failure, host/gateway source, result-before-stop, duplicate result and new-write v1 downgrade. Historical action.result@1 remains readable; v2 load/fold retains the typed reference. A mutation stripping the reference or replaying it as v1 fails. Drive both §5.5 tables across live execute, reconcile pre-pass and replay, including stopped action.result@2 and the runtime-only clarification request: PersistError-as-rejected, duplicate result:${action_id}/request id (equal, different and diagnostic-only), other validation rejection and journal throw all stop the owner; claim no new durability, preserve accepted records and require reload before live continuation. A refusal accepted then PersistError on the live stopped-result write stops the owner before drainQueue, forms no new framing candidate and yields exactly one result after reload, then remains inert on a second reload. Add queued work with spare capacity and a second selected candidate: zero subsequent action.started or host invoke after the fault. Ignoring validation, checking only after ordinary recordResult returns, or continuing the selection must fail. Replay rejection returns failure without repair or writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T12  | C3, pure/runtime tests                                              | Exact lowest-priority drop order and tie-break; required input remains, effective omission fields are measured and recorded, all new bytes counted, final fit exact. Always-trim-required/leaf-subtraction mutation fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T13  | C3, view/replay tests                                               | Original and effective views, original manifest and excluded bodies survive crash; only effective view has `context_budget` omissions. Another consumer of a shared slice assembly sees unchanged bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| T14  | C3, cache fixtures                                                  | Dropping an optional part cannot change stable prefix or hide a hit/reload change; cached tokens count toward window in full.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T15  | C1/C2b/C2d, persistence fixtures extending M1 (§6.5)                | Fit and refusal records exactly at/one byte over the log bound; durable oversize disposition as specified below. Journal refusal, request/result append failure, torn tail and written-then-throws never permit unjournaled dispatch or double reservation. No accepted index advances before durable append. Known durable request is abandoned once, never resent. HEAD red: a torn final line makes `FileJournal.snapshot` throw, and no fsync precedes acknowledgment; the shared `FileAttemptJournal` protocol (§6.5) turns both green. Composition refuses a log bound smaller than the maximum encoded clarification request or stopped action.result@2 before enabling preparation, even if the marker fits; equality is supported. Do not wait for first overflow to discover deterministic clarification/result oversize. C2d-Q derives the clarification maximum encoded size and owns its exact-equality and one-over composition rows once its closed schema exists; C1 owns the generic size-fit rule and closed marker/stopped-result bounds. Inject PersistError on the live stopped-result write after an accepted refusal (and accepted clarification request): owner stopped and current selection unwound, no new framing candidate, zero subsequent action.started or host invoke with pending queued work and spare capacity, unchanged durable stop/request, exactly one result after reload and none added on second reload. A check-validation-after-recordResult-returns mutation must fail. Also fault the clarification write and each request/result boundary with rejection and written-then-throws; reload completes only missing writes. Cancellation and concurrent-owner variants retain T8/T16 isolation and never reuse a single-use grant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T16  | C2b/C2d/C4, concurrency fixtures                                    | Supported overlapping independent requests with distinct ceilings and inverse completion/cancellation order retain isolated ledgers, bodies, failure indexes and budgets. Goal.frame stop keys remain isolated across owner scopes and distinct action ids even when fit inputs match; inverse cancellation/completion cannot finish another action's disposition. Duplicate ids and second writers refuse; preserve one pending frontier weighing. C2d-Q responses cannot cross owner/request boundaries; duplicate responses and repeated formation before/after reload bind at most one fresh action, including inverse cancellation order and queue-to-start continuation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T17  | C4, per-owner tests in §10                                          | Each listed site exceeds its bound: zero calls/effects and durable refusal. Fit passes exact prepared payload and terms. Retry growth crosses ceiling only on the later attempt; no subsequent check grant is issued. Crash/cancel/append failure follows that owner's record, not Loom's two-site lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T18  | C5, Weft tests                                                      | Missing, throwing, stalled, mutating and reentrant sinks leave decisions, schedule and budget identical; after-step emission only, replay emits nothing. Fit/refusal metrics match durable evidence; failure markers emit no invented token totals; canary keys/bodies absent from argv and all diagnostic/Weft output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T19  | C6, accounting/routing tests                                        | New schema distinguishes policy ceiling from tightened positive term; test exact zero/minimum, equality, safe arithmetic, smaller-route boundary, cached-token overflow, retry cost/output allowance, pricing and injected-time pacing. Loom reserves unchanged cost_ceiling; accept/failure/cancel/unknown usage/recovery settle once. Direct benchmark fixtures remain identical.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T20  | C7, admission fixtures                                              | A calibrated but underbounding or uncovered estimator is refused. An admitted replacement proves full-input/framing and capacity bounds at just-fit/one-over, has independent held-out/adversarial evidence, and replays alongside old versions after defaults change. Missing historical version fails. Efficiency comparison follows soundness, never substitutes for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

T9's required ordering rows (C2d/C2d-Q; deterministic fixtures, no hosted calls):
finish other live actions before asserting full replay success. Incomplete crash
prefixes retain HEAD's missing-result/unfinished-action failure; compare the
ordered reproduced prefix as well as that failure, never relax it to pass.

| Row   | Fixture and required assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Mutation that must fail                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T9-L1 | Live, non-crash overflow **and** marker, each with at least two candidates selected in the same cycle, slots >= 2 and framing first. Enable goal.review so formation offers goal.frame plus report.review (packages/weave/src/candidates.ts:108-130), with deterministic weights selecting both. Pin stop, overflow request if any, v2 result, then the later selected start; assert framing is terminal before that dispatch. Replay has identical ordered observations, cycles and state, one disposition, and zero journal/host/gateway/Weft calls.                                                                                                                       | Return null and feed all stop-backed dispositions uniformly; omit inline-request generation; duplicate inline records through feed.                                          |
| T9-L2 | Live overflow with an already pending queued action that the accepted result's live drain actually starts. Establish the queue through supported slot-limited scheduling, not concurrent mutation of runtime state. Assert the new start/invocation follows the accepted result and precedes any later selected dispatch. Replay reconstructs exactly that pending action's start/outcome without invoking it or minting/consuming a grant. Include marker and cancelled/revoked queued-action variants: cancelled or unauthorized work never starts.                                                                                                                        | Leave HEAD's replay drain no-op as the only mechanism; feed the live result without its queue continuation; start all eligible pending work instead of only recorded starts. |
| T9-R0 | Crash after refusal or marker, plus a generic running action first, stopped framing second, and a pending queued action; zero remaining recovery allowance and no unrecorded inference. Recovery writes missing request/result in the non-draining pre-pass, then generic recovery.exhausted. Assert zero new action.started and zero host invoke, no framing recovery attempt/spend/grant/lookup, one result after double reload. Replay consumes exhaustion at seq and reproduces the same no-start prefix without reconcile, then reports the existing unfinished-action failure while generic/pending work remains; do not claim replay success for this incomplete log. | Use ordinary recordResult or drain inside the pre-pass; move the pre-pass into the unfinished loop; skip the runtime recovery.exhausted record during replay.                |
| T9-R1 | Real intervening frontier.weigh abandonment from the FW-T08 recovery fixture (packages/weave/test/frontier-weigh.test.ts:493), composed with the framing stop crash fixture. No pending queue in this row. Derive the order through recover/reconcile: stop, gateway abandonment and its actual cycle records, missing overflow request/result. Feed only delayed dispositions at seq, with no drain. Also crash after request acknowledgment before result, preserving the inline request and feeding only its delayed result; double reload/replay loses or duplicates nothing.                                                                                            | Regenerate all dispositions at execute, assume stop/result adjacency, reproduce the already durable request twice, or drain on a fed pre-pass result.                        |

Keep fixture setup within the existing single-writer scheduling contract;
FW-T08 alone does not prove that the composite state is reachable. Each child
must establish that reachability before claiming red/green, including valid
request admission and one pending frontier weighing. Extend T9-R1 with an
adjacent recovery suffix (no intervening arrival) and with non-exhausted
recovery that eventually starts queued work: reconstruct only its recorded
starts at their original positions, never a pre-pass-triggered drain. Missing
or duplicate queue starts/results must fail, not be silently omitted. T8/T16
repeat the relevant cancellation, response/grant non-reuse and distinct-owner
cases. T11/T15 fault each durable stop/request/result boundary, including
PersistError-as-rejected and written-then-throws, with queued work present;
replay neither repairs nor duplicates an ambiguous write.

T15 measures ledger, evidence and complete canonical payload bytes separately
against the configured log bound for both `inference.requested@2` and
`context.refused@1`, including token-fit/evidence-oversize input. Equality fits;
one byte over yields exactly one durable `context.persistence_failed@1`, zero
request/refusal acceptance, reservation, controller, gateway call or new grant,
and the P2-approved disposition references that marker. Reload twice and repeat
unchanged cycles: identical marker bytes, no duplicate/lost state or dispatch.
Reject configuration too small for the maximum marker, clarification request
or stopped result at composition, testing each independently and at equality;
marker append failure
or ambiguity remains explicit, never reported durable. Extend the M1 worker
fault gates (§6.5) for these cases, including cancellation before/after marker
append; keep the existing H1 log-bound rejection assertions intact.

For each child: run the narrow affected test first, then `npm run fmt:check`,
`npm run check`, `npm run test:checks`, `npm test`, the §7 benchmark test set,
and `npm run verify` (the full available suite). Pure tests can run via
`npm run build && node --test packages/weave/dist/test/context-budget.test.js`.
Report exact commands, observed red/green and blockers; these are future child
acceptance requirements, not tests already run for this plan-only revision.

C4 adds `checks/inference-through-assembler.mjs` with red/green fixtures: flag
unprepared managed `.generate(`/`.evaluate(` calls, injected-port aliases and
shared site entry points, not just the two literal gateway methods. Allowlist
only explicit direct benchmark/legacy composition boundaries with owner and
reason. Runtime tests must still demonstrate managed coverage; static searching
alone cannot prove a port is wired correctly. V2 validation closes the runtime
new-write bypass independently of this check.

## 9. Closed product decisions and enforcement gates

P1–P3 are closed as recorded in `/workspace/decisions/weave.md`
(D-ENG-025/026/027), read for this revision. No new owner fork is raised.
Fixture/default approval under P1 remains required after measurement; the
merge criterion itself is already decided. Architecture stays under D-ENG-021.

- **P1 — closed (D-ENG-025). Default ceilings and merge/hold policy.**
  The merge criterion below is approved. Token ceilings per inference kind and
  changed fixture consequences still need approval after measurement.
  Validator input resource limit values (`max_depth`/`max_nodes`) are decided
  under D-ENG-021 (§5.2), not here; their consequence is shown here. The inventory reports
  each site's derived limits, the fixture they came from, each fixture's
  measured depth/nodes and the behavior beyond them (durable `invalid_part`
  `depth_limit`/`node_limit` refusal, no dispatch). C2d inventories every
  goal.frame/frontier.weigh fixture: total and required certified token bounds,
  ceiling, token excess, supported/unsupported contracts; ledger bytes, complete
  inline evidence bytes and complete decision payload bytes (measured separately,
  not inferred from tokens), any exact or recorded reference token count used for
  C7's trigger (below), configured `logBound.max_observation_bytes`, byte
  excess and storage fit. Measure both fit and refusal record shapes, including
  full excluded bodies, original/effective views, templates and profile. An
  unsupported token estimate does not excuse omitting storage measurements;
  unconstructible shapes are explicitly unavailable, never assumed to fit.
  Record the failure marker's maximum bytes/fit, affected behavior and the closed
  P2 clarification/fallback disposition per fixture. Report an absent log bound explicitly and also
  exercise the proposed bounded managed configuration. C4 extends this inventory
  per site/owner journal. Approved merge criterion:
  enforcement lands only when applicable evidence is sound, all checks pass
  (including marker fit and journal guarantees), and every changed fixture
  consequence/default is approved, including the beyond-limit refusal
  behavior for the reported `max_depth`/`max_nodes`. Otherwise hold
  enforcement (contract-only work may proceed). Present measured excesses and
  consequences before the decision; never silently raise limits or weaken tests.
- **P2 — closed (D-ENG-026). User-visible overflow recovery.** Prefer an
  operator clarification path for overflow before fail/block. The request never
  dispatches while oversized/unverifiable, and its local stop references the
  durable refusal. Clarification may lead to a separately authorized and
  budgeted larger-window attempt; it grants no automatic spend. Storage failure
  references R8's marker and requires a separately authorized configuration/input
  change; larger model capacity does not fix evidence oversize. Never cut
  evidence. Marker schema, storage placement and bounded admission are decided
  engineering scope, not owner forks.
- **P3 — closed (D-ENG-027). Audit fidelity.** Retain all selected audit
  material as required. Summarization remains prohibited until a separate
  summarization/disclosure policy is approved and validated with crash-safe
  evidence. `compactContext` cannot silently replace that policy.

**P4 (window-waste tolerance) is no longer an owner question.** It is
reclassified as engineering under D-ENG-021 and is not folded into P1. Its
only consequence was C7 scheduling, which is an engineering decision. The user-visible part, which fixtures refuse under the
approved ceilings, is already in P1's fixture-consequence approval. The trigger
is:

- C2d's A5 inventory records, per fixture and route, the certified bound
  `B(all)` and, where one exists without a hosted call, a reference count: an
  exact count from a pinned tokenizer, or `ProviderUsage.input_tokens` from an
  already recorded fixture run. Fixtures without one are reported as such.
- C7 is scheduled ahead of C5/C6 if either (a) any fixture is refused under the
  P1-approved ceiling while its reference count fits that ceiling (a
  conservative-bound false refusal), or (b) for any site, the median of
  `B(all) / reference count` exceeds 1.25. Otherwise C7 is deferred and the
  trigger is re-evaluated whenever the inventory is re-measured (a new route,
  a C4 site or a changed ceiling).
- Engineering may change the 1.25 threshold only with a recorded rationale in
  the inventory report. This scheduling never blocks the soundness or
  durability prerequisites, relaxes a check, admits a calibrated-only
  estimator, or becomes another owner question.

P5 is removed: R5 decides storage placement under D-ENG-021.

## 10. Child breakdown and ownership outside the runtime

| Child | Scope and first red evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Depends on                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| C1    | Contract, complete data shapes/rejection variants, bounded persistence-failure marker and GLOSSARY additions; FU3 declaration/test pin check over PLAN.md including review dispositions; validate behavioral corpus T1–T4 and T15's marker contract against invalid placeholders. No implementation before observed red. Specify action.result@2/context_decision_id. C1 fixes the generic composition-time size-fit rule and closed maximum encoded bounds for the marker and stopped result (§4/§5.5); C2d-Q supplies the clarification bound after its schema exists. Include FU5 replay feed-policy contracts.                                                                                                                                                                                                                                                                                                                                                                                                  | Implementation authorization                     |
| C2a   | Gateway input-capacity contract (R7, A4): explicit input-versus-total semantics and normalization for managed route snapshots, immutable coverage snapshot, accounting-family binding to the scoped gateway fingerprint. First red is against C2a's own contract (§8), since HEAD has no managed admission to fail. A placeholder admission check using today's declared-window rule (`excludeReason`, `routing.ts:220`) admits a route whose certified total window minus `ModelSettings.max_output_tokens` (`types.ts:305`) is below the request term, and the C2a test fails on it. That HEAD rule motivates the test and stays unchanged for direct routes. Lands with §7 guards 1, 2 and 5 green before and after; the default `excludeReason` comparison and every direct benchmark route are unchanged.                                                                                                                                                                                                      | C1                                               |
| C2b   | Journal durability (A6, §6.5): extract `FileAttemptJournal`'s protocol and use it in `FileJournal` behind `ObservationJournal`; extend M1 crash-worker fault gates for append/torn-tail/written-then-throws. First red: torn final line makes `FileJournal.snapshot` throw, and no fsync precedes acknowledgment. T9 (journal faults), T15 (journal rows) and T16 (second writer); p8 `FileAttemptJournal` tests stay green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | C1                                               |
| C2c   | Per-type version table and v2 admission/load (§4 steps 1–5): `validate` version table, `inference.requested@2`, `context.refused@1`, `context.persistence_failed@1`, `action.result@2`/`context_decision_id`; historical-versus-new-write split including stop-result downgrade rejection; version-dispatched load/replay/fold; site-specific failure/stop indexes and replay decision indexes by id/owner/logical attempt for refusal/marker records (§6.6), including historical profile/type dispatch. First red: a well-formed v2 record is rejected by the v1-only gate at `validation.ts:117`. T11 and T9 (replay/tamper rows).                                                                                                                                                                                                                                                                                                                                                                               | C1                                               |
| C2d   | Enforcement and prepared handoff for goal.frame/frontier.weigh: certified accounting through C2a's family, fit/overflow (§5.4), both §5.5 append-outcome tables and the dedicated accepted-only stopped-result step (live drain / non-draining recovery), `weighPrepared` (R1), the `frontierWeighStatus` refusal arm, signal forwarding, R8 marker disposition, goal.frame unique owner/action decision and verified bindings, fail-closed re-entry guard, reconcileStep pre-pass before constructing unfinished without recovery.attempted/grant/lookup (§5.5), C2d-Q clarification contract below, frameGoal replay matching plus write-site/seq-aware inline-or-feed disposition and recorded queue continuation (§6.6/FU5), P1 fixture inventory before enforcement. First red: T5 (HEAD dispatches an oversized goal.frame). T5–T8, T9 (goal.frame crash/replay/identity rows), T11 (identity/volatile mutations), T15 (fit/oversize rows), T16, §7 guard 6. Hold uncovered routes and never assume evidence. | C2a, C2b, C2c; P1/P2 for enforcement/disposition |
| C3    | Optional priority removal on detached effective views; T12–T14 plus expanded T9, T10 and failure boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | C2d                                              |
| C4    | Per-site managed profiles, preparation and durable owner integration below; T17 and site-specific T8/T9/T15/T16; assembler-coverage check with red fixtures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | C2d; P1/P2 per site                              |
| C5    | Revised Weft contract for policy ceiling, request term, full/used/reduced bounds and refusal metrics/references; T18.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | C2d                                              |
| C6    | `context.ledger@2` and tightened token term only, leaving money reservations explicit; T19 plus T9–T11 and §7 guards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | C2d                                              |
| C7    | More efficient certified accounting, possibly per-route, admitted with a proof rather than calibration alone; historical-version retention and T20. Scheduled by the engineering trigger in §9 from A5 measurements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | C2d; §9 trigger sets priority                    |

**C2d-Q (required sub-item of C2d, not a new product fork):** specify the
closed versioned goal-level overflow clarification request and authorized
response, provenance/admission, durable identity by owner/action/refusal and
pending/resolved state. C1 owns the generic size-fit rule and the closed marker
and stopped-result bounds. C2d-Q derives the clarification maximum encoded size
from its own closed schema and maximum field encodings, proves fit before
enabling preparation (§5.5), and owns T15's exact-equality and one-over rows;
an insufficient bound is unsupported at composition. Integrate load/replay
indexes, both §5.5 append-outcome tables, at-most-once request writes before the
terminal `action.result@2` (§4), and write-site/seq-aware replay for the runtime-only
request: live inline prefix, recovery-delayed feed, exactly one consumer and no
request-triggered drain (§6.6/FU5).

Own re-framing changes to `formCandidates`, `failedCandidateIds` and
`frameCandidate` (`packages/weave/src/candidates.ts:78,70,302`): preserve failed
candidate exclusion, add the accepted authorized `clarification_response_id`
to fresh framing inputs, and bind it to at most one new action through the
first accepted queue/start, reconstructed on load (§5.5). C2d-Q also owns
start/queue admission and dispatch revalidation: extend `validateStarted`
(`packages/weave/src/validation.ts:367`) and the `Runtime.stillAuthorized`
path (`packages/weave/src/runtime.ts:1399`) to enforce the response binding
and current authority; do not trust the copied candidate eligibility alone.
The marker path uses
a separately authorized durable configuration/input-change observation id in
`context_change_id` instead (mutually exclusive with `clarification_response_id`).
Neither raw state changes nor an already-bound response can re-form the old
candidate or renew a grant. Resolve/validate response provenance and authorized
input revisions before dispatch; ordinary budget/authority checks still apply.
First behavioral red: after a refusal no frame candidate forms (pin the current
exclusion); an authorized response must then produce exactly one fresh
candidate/action and decision, which HEAD's fixed `{ goal_id }` identity cannot
do. Repeated cycles, duplicate/stale/unauthorized responses, reload and replay
must neither loop nor lose eligible work. T8/T9/T11/T15/T16 cover cancellation,
concurrent owners, every stop/request/result/response/queue/start crash boundary
and rejected/ambiguous writes with double reload. This contract and its
behavioral red are prerequisites to C2d implementation/enforcement; the exact
clarification record schema is deferred to this sub-item, not assumed at HEAD.

C2 is split into ordered children C2a–C2d. Each starts from its own contract
and its own behavioral red before code. C2a, C2b and C2c depend only on C1 and
can proceed in parallel. C2d depends on all three. Elsewhere in this plan, "C2"
without a suffix means the C2a–C2d set, and a dependency on C2 means on C2d.
C3–C5 can proceed independently after C2d. C6/C7 can also be developed against
fixed C2c/C2d contracts with their schema dependencies declared.

C4 sites do not share Loom's single-writer step, two-site payload union or
`inference.requested` reservation lifecycle. Do not widen that union merely to
pretend they do. Integrate an explicitly managed preparation port at each owner;
keep existing exported direct helpers available to benchmark composition and
prove equivalence. Use the same pure assembler and evidence contract with the
following concrete persistence ownership:

| Managed site/owner                                        | Durable integration and recovery contract                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit.generate` / audit loop                             | Version `AuditCheckpoint` to hold the decision/evidence with its existing pre-dispatch intent, before `ports.generate`. Preserve `audit_unconfirmed`: intent without report never auto-resends. Refusal has no dispatch marker and persists independently of later round disposition. T17 covers overflow with required audit material and failure of the checkpoint append.                                                                                   |
| `impl.generate` / implementation step                     | Version `AttemptJournal` with a pre-generation decision/intent entry per execution/attempt, before generate and any fresh check grants. Include exact `feedbackPrompt` result, not just its base. Restore outstanding intent as uncertain/unconfirmed and use existing reconciliation; never blindly regenerate. T17 forces first attempt fit, retry feedback overflow, escalation settings coverage and crash before result.                                  |
| `task.criteria` and `task.validate` / managed task caller | Add a required injected durable decision append/load port at the managed composition boundary; the pure/direct helpers currently own no journal. Persist full prepared boolean questions, state and evidence before evaluate. Retain the existing no-call paths for lexical rejection, code predicates and no shown facts. Outstanding intent cannot be auto-reasked on load; results and refusals link the decision id. Benchmarks retain the direct helpers. |
| `input.route` / managed workstream caller                 | Persist preparation/intent via an explicit caller journal port before the shared `evaluateSite` call, and link the route record to it. Operator direction/no-active-work rules still make zero calls; unknown outcome follows existing uncertainty handling. No automatic reclassification from an outstanding intent; new invocation needs fresh authorized input.                                                                                            |

Apply R8's separate byte measurements and bounded durable failure semantics in
each owner's versioned journal/checkpoint, with the same recovery guarantees.
Do not import Loom's runtime-only observation types or widen its two-site union
to store C4 failures.

Every row starts with red assertions for fit, excess, unavailable historical
evidence, full-record/refusal evidence oversize and its bounded durable failure
disposition, append failure/ambiguity, crash before/after intent, cancellation and
distinct concurrent owners. For task criteria and validation test both sites
separately; for input routing test rule bypass as well as the inference path.
Any other `.generate`/`.evaluate` or aliased shared site discovered by the C4
inventory gets an explicit managed owner contract or a documented direct-only
boundary, never an unexplained allowlist entry. C4 does not route Fabric through
Loom or adopt its scheduling. These records introduce no new authority to act.

## 11. AGENTS.md conformance

- **Provider independence and purity:** injected opaque accounting contracts,
  pure preparation, transport/storage at existing ports, no ambient inputs.
- **Deterministic policy:** model outputs remain observations; trusted contracts
  determine inventory, classification, bounds and permission to dispatch.
- **Explicit transitions/evidence:** atomic fit/refusal records, complete sealed
  inputs and historical version dispatch; recovery and replay are distinct.
- **Parallel work:** independent child dependencies and isolated request ledgers;
  retain actual single-writer ownership and frontier constraints.
- **Small core/composition:** reuse views, manifests, assembly ids, canonical JSON,
  digests, gateway factory and owner journals. Site rules remain versioned policy;
  provider projections remain outside Loom. Fabric stays bounded and independent.
- **Contract, red, green:** every child has behavioral rejection evidence before
  implementation and full deterministic checks afterward. No weakened held-out,
  permissions, bounds or validators; generation/admission/execution stay separate.
- **Plan-only scope:** this task changes no code, tests, glossary, vision or
  benchmark artifact; planned GLOSSARY changes are listed next.

## 12. New or refined terms for GLOSSARY.md (future C1/C2)

- **Context ledger.** Versioned pre-flight record binding a complete prepared
  request to its policy ceiling, enforced token term, complete-input bounds,
  inclusions, digests and slice/template evidence. Sibling of the state view;
  content-free metrics/references do not grant disclosure.
- **Context estimator.** Injected versioned complete-input accounting algorithm,
  admitted with transformation/tokenizer/framing evidence. A byte heuristic or
  calibration alone is not a certified token upper bound.
- **Accounting contract / accounting family.** Immutable evidence-backed request
  reconstruction and bound for a covered route, and the complete set bound to a
  scoped gateway configuration. Loom treats provider details as opaque.
- **Site assembly contract.** Trusted versioned expected inventory, requiredness,
  content-path mapping, templates, reconstruction and budget for one site/profile.
- **Prepared request.** Sealed provider-neutral request whose exact content and
  terms are measured, durably recorded and passed unchanged to dispatch.
- **Assembly evidence.** Protected historical snapshots and immutable procedure
  references sufficient to reconstruct a fit/refusal, including pre-trim inputs
  and excluded bodies. This contains content; the ledger and Weft summaries do not.
- **Effective dispatched view.** Request-specific authorized view after any
  disclosed optional-part drops, linked to the unchanged original slice assembly.
- **Context overflow.** Typed fail-closed refusal for required or total excess,
  invalid input or unsupported accounting, durably recorded as `context.refused`;
  it reserves no inference budget and authorizes no recovery call. Evidence
  oversize follows the distinct persistence-failure contract below.
- **Context persistence failure.** A complete fit/refusal decision cannot be
  durably stored. For known evidence-size rejection, the bounded
  `context.persistence_failed@1` marker records only that failure and stops the
  owner without reservation or dispatch. It is not a ledger or full refusal
  evidence; replay reconstructs only its recorded failure/disposition. A failed
  or ambiguous marker append is an explicit error, never claimed durable.
- **Part class.** `required` or `optional`, derived from the trusted site/profile
  contract; only optional whole parts can be dropped by its deterministic policy.

Keep the existing terms **state view**, **context profile**, **slice assembly**,
**replay**, **recovery**, **prefix cache** and **disclosure class** with their
current meanings. Token ceilings and monetary reservations are distinct.

## 13. Assumptions, prerequisites, follow-ups and remaining uncertainty

- **A1 (unverified source).** The live #353 text is assumed to match the supplied
  brief; no remote issue read is claimed. D-ENG-021 is applied as instructed.
- **A2/A3 (removed unsafe assumptions).** No universal byte/token or fixed framing
  bound is assumed. C1/C2 must provide exact reconstruction, immutable coverage,
  sound bound evidence and adversarial boundary checks. An unproved route is
  unsupported; C7 calibration cannot repair a missing proof by itself.
- **A4 (blocking prerequisite, child C2a).** Current `context_limit_tokens` lacks documented
  input-versus-total semantics. R7 decides the managed normalization contract.
  Concrete per-route capacity evidence is still required before a strict window
  safety claim. C2a owns that work and must preserve benchmark semantics under §7.
- **A5 (measurement outstanding).** No fixture excess measurements have been run
  for this plan-only task. C2 inventories fixtures under the certified contracts,
  reports token excesses/unsupported routes and ledger/evidence/complete-payload
  bytes against each configured log bound, including refusal shapes and marker
  fit plus clarification-request and stopped-result maximum encoded sizes, and
  applies P1's explicit merge/hold gate. C7 priority follows the
  engineering trigger in §9 from those measurements, not an owner choice.
  Existing 8_000 defaults confer no evidence that any fixture fits.
- **A6 (durability prerequisite, child C2b).** Existing `FileJournal` does not
  fsync, and it fails to load on a torn final line (`journal.ts:57-72`).
  `FileAttemptJournal` already meets the required contract. C2b reuses that
  protocol (§6.5) and fault-tests it before anyone claims crash-safe
  byte-for-byte ledger replay. Missing journal guarantees or historical evidence
  block enforcement, not validation.
  Extend the M1 crash-worker/real-file reload pattern named in §6.5 for torn-tail,
  ambiguous append and refusal/failure-marker crashes. R8 also requires a proven
  bounded durable marker; unavailable storage guarantees cannot be replaced by
  `appendStep`'s diagnostic-only oversize rejection.

- **A7 (offline review provenance).** Earlier revisions record the §14 raw
  verdict path `/workspace/wvops/WV-353-review-4306bf0.raw.txt` as initially
  unavailable (H5), then present with malformed embedded JSON at the first
  C2a note and wording matching G1–G6. Those source-availability reports and
  the earlier empty-verdict-file report remain historical, not independently
  authenticated in plan11. §15–§17 likewise retain their historical review
  provenance and closed code corrections; source/tests are unchanged at
  `25e1d0f` from those review targets/base (`git diff --stat 0281c5e 25e1d0f`
  lists only PLAN.md). §18 remains plan9's historical disposition. The current
  operator-supplied Claude Opus review was read directly from
  `/workspace/wvops/WV-353-p6-review-25e1d0f.json`: one error, two warnings
  (auto-fix) and three no-change notes, reported risk medium, empty `ask_user`.
  §19 remains plan10's historical disposition; §20 records this review's HEAD
  verification and disposition.
  FU3 remains C1 work and FU5 below is widened to write sites/continuations. This
  untracked review artifact and §9's decision ledger are external operator
  sources, not repository evidence. No remote issue/model call or network
  verification is claimed.

Tracked follow-ups (from the earlier reviews, extended by `25e1d0f`; none blocks C1):

- **FU1 (benchmark ambient clock).** `checks/no-ambient-clock.mjs` does not scan
  `benchmarks/`, and the frontier-weigh harness legitimately reads the wall
  clock for latency and timeouts. Recommendation: do not widen the check in
  this parent. §7 guard 6 injects the clock and timer for the guarded route.
  Any child that edits `configureJev` first makes its clock and timer
  injectable.
- **FU2 (repeated finding becomes a check: benchmark-route leak).** §7
  already forbade guardrail leakage, yet R1 as written at `ac6fc69` still
  leaked the managed path into the shared frontier-weigh route. §7 guard 6 and its `siteWeigher` mutation make it a
  test rather than prose. C4's `checks/inference-through-assembler.mjs` (§8)
  also allowlists `siteWeigher` by name as a direct benchmark boundary that may
  call only `weigh`.
- **FU3 (repeated finding becomes a check: pin drift).** Line-pin drift has been
  raised in the reviews of `08e157a`, `ac6fc69` and `4306bf0` (the last pinned
  `CATALOGUE_SLOT_MICROS` to `profileReservation`'s line). C1's
  `CONTEXT-BUDGET-CONTRACT.md` cites symbols only, with no line numbers. Its C1
  test resolves every cited `path` and exported symbol at the child's base and
  fails on a missing one. The same test also parses this plan's bare
  definition pins (`` `symbol` (`file:N`) ``), including grouped symbols/pins
  and review-disposition citations throughout PLAN.md, not just contract/code
  references or §2. It asserts that line N declares that symbol, not merely
  that the symbol exists somewhere; comment and JSDoc lines never count as
  declarations. Labelled `call at` pins must identify the start of the named
  call expression, not an argument line; other labelled use-site pins are
  checked for file existence only. This plan keeps line numbers as
  navigation hints only (§2). This revision rechecked §2 definition pins
  against `25e1d0f`; code is unchanged from `4306bf0` and its
  `CATALOGUE_SLOT_MICROS` correction stays intact. The repeated test-location
  findings (§16 O4, §17 W1) extend C1's pin check to test
  citations: resolve the exact test title to a `test`/`it` declaration, and
  reject a comment/JSDoc or body-statement citation posing as that declaration.
  Negative fixtures use p8.test.ts:1902 (comment), :1904 (body statement) and
  runtime.ts:2177 (JSDoc); positive pins are :1903 and :2178 respectively.
  Add negative fixtures runtime.ts:160 (JSDoc) and :162 (array element, not
  the WEIGH_CONTROL_RECORDS declaration), plus :1240 (argument line, not the
  direct renderFrameView call); positive pins are :161 and :1236 respectively.
  The plan9 review's proposed :160 declaration/:161 element correction is
  itself off by one at HEAD; source declarations take precedence over the
  review. Also reject candidates.ts:303 (body statement) as a declaration of
  frameCandidate, whose positive pin is :302.
  This is a required C1 follow-up, not an implemented lint in this plan-only task.
- **FU4 (repeated finding becomes a check: unjournaled append rejection).**
  Earlier oversize and `mid_value` findings now include ignored result
  validation (§19 W1, refined by §20 W1/W2). T11 is table-driven from both §5.5 append-outcome
  tables, covering decisions, stopped `action.result@2` and the runtime-only
  clarification request in live execute, reconcile pre-pass and replay.
  Any child adding an `appendStep` rejection reason or managed record type
  must add its matrix row and T11 behavioral case in the same change,
  including PersistError-as-rejected, duplicate ids and journal ambiguity.
  Mutations discarding stop-result/request validation or checking only after
  ordinary recordResult has already drained must fail T11/T15 with queued
  work present and zero subsequent starts/invokes after a failed write.
- **FU5 (repeated finding becomes a check: replay write-site/continuation policy).**
  §16 O3/§17 N1, §19 E1 and §20 E1/W2 require an explicit feed-or-regenerate
  policy per **(record type, write site)**, covering synchronous live writes
  inside dispatch as well as recovery writes, not just records recovery can
  append after a crash. Each entry names its owner, validation, ordering and
  cycle/drain continuation. C1 fixes the contract and coverage requirement;
  C2c/C2d/C2d-Q implement and test §6.6's table. Live request/results reproduce
  the next-seq contiguous prefix inline and its recorded queue continuation;
  recovery-delayed records feed at seq with no drain. Exactly one cursor
  consumes each record; a partial inline prefix cannot cause double feed.
  Include queued-start reconstruction and the generic exhaustion record in
  affected recovery traces. T9-L1/L2/R0/R1 must reject uniform-feed,
  uniform-regenerate, replay-drain-no-op and pre-pass-drain mutations.
  A missing (type, write site) entry or a changed feed/continuation policy
  without an ordering test fails the child's contract/coverage check. No
  runtime-source record gains a blanket feed bypass. This is required child
  test/lint work, not a check implemented in this PLAN.md-only revision.

## 14. Review disposition — GLM review of `4306bf0`

Historical source (unavailable in the earlier workspace; now read, A7):
`/workspace/wvops/WV-353-review-4306bf0.raw.txt`. The prior revision reports that
the JSON verdict file was empty and the raw verdict malformed: the first C2a note has no
`suggested_fix` or closing brace, and the second C2a note restates it. The
review reports 3 warnings and 3 notes, all auto-fix. Each was checked against
code at `4306bf0` (identical to `0281c5e`) before that revision; this revision
rechecked the code claims at `1e9f625`. References below to the reviewing
revision describe that historical workspace. Nothing below reopens a closed
decision or an earlier fix.

| #   | Severity | Finding                                                                                                                | Verification at `4306bf0`                                                                                                                                                                                                                                                                                                                                                                                                                 | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | warning  | Stop index `(candidate_set, policy, storage-policy)` makes changed-input supersession unreachable; no test covers it.  | Confirmed. `frontierWeighStatus` (`runtime.ts:1040`) selects only by `candidate_set`. `Runtime.weighAndSelect` (`:851`) builds a per-cycle `request_id`, `deadline` and `cost_ceiling`, and the view's `state_revision` changes with every record. So a raw input digest would never match (livelock), and omitting one would never release the stop.                                                                                     | Fixed. §5.5 keys the stop on a fit-input digest that excludes contract-named volatile fields, which must be disjoint from accounted fields. The `refused` arm takes the latest durable decision by seq and recomputes the digest through the pure capture step only. A mismatch returns `needed`, and supersession follows log order with no extra record. §6.5 makes the frontier.weigh logical attempt the cycle's `request_id` (A→B→A gives no duplicate collision) and states the crash/reload rule. T6 adds changed-input, volatile-only, A→B→A and reload cases plus key mutations. |
| G2  | warning  | §5.2/§2.5 claim `payloadBytes` encodes a lone surrogate as U+FFFD, so `"\uD800"` and `"�"` share bytes and digest.     | Confirmed from code: `payloadBytes` (`log-bound.ts:7`) and `digest` (`digest.ts:5`) both use `stableStringify` (`stable-json.ts:5`) = `JSON.stringify`. Under ES2019 well-formed stringify (engines `node >=22.18.0`, `package.json:64`) that emits `\ud800` (8 bytes) versus raw U+FFFD (5 bytes). The reviewer reports running it. This revision could not execute Node (sandbox approval), so T3 now carries the executable assertion. | Fixed. §2.5 states the real encoding. §5.2 keeps capture-time `lone_surrogate` refusal for the durable-stop reason only, and forbids raw-UTF-8 body digests (the one path where the collision exists). T3 asserts 8 versus 5 bytes and distinct digests, with a raw-UTF-8 mutation. The §5.5 `mid_value` row was already sound and is unchanged.                                                                                                                                                                                                                                          |
| G3  | warning  | Fixture-derived `max_depth`/`max_nodes` refuse larger future views, a user-visible consequence outside P1's inventory. | Confirmed: P1 explicitly excluded the limits, and the refusal is a durable, user-visible `invalid_part` stop. The optional structural derivation is unavailable: `renderWeighView` (`views.ts:272`) has no budget, so candidate and in-flight lists are unbounded.                                                                                                                                                                        | Fixed. The values stay decided under D-ENG-021 (§5.2, with the reason fixture-derived is kept). P1's inventory reports derived limits, source fixture, measured depth/nodes and beyond-limit behavior, and the merge criterion requires that consequence approved. P1 is still the only gate; no new owner question.                                                                                                                                                                                                                                                                      |
| G4  | note     | `CATALOGUE_SLOT_MICROS` pinned to `strategy.ts:72`.                                                                    | Confirmed: defined at `strategy.ts:12`, with `profileReservation` at `:72`. Every other §2 bare definition pin resolves at `4306bf0`.                                                                                                                                                                                                                                                                                                     | Fixed in §2.2. Third repeat of pin drift, so FU3 makes C1's resolution test check that each bare definition pin's line declares its symbol.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| G5  | note     | C2a first red ("admitted at HEAD") cannot be demonstrated: no managed admission exists at HEAD.                        | Confirmed. HEAD has only `excludeReason` (`routing.ts:220`), which admits on declared `context_limit_tokens` and must stay unchanged for direct routes. So it cannot be the red that C2a turns green.                                                                                                                                                                                                                                     | Fixed in §10 C2a. The red is against C2a's own contract (§8): a placeholder using the declared-window rule admits a route whose certified total minus `ModelSettings.max_output_tokens` (`types.ts:305`) is below the term, and the C2a test fails on it.                                                                                                                                                                                                                                                                                                                                 |
| G6  | note     | Duplicate of G5 (malformed raw verdict).                                                                               | Same evidence as G5.                                                                                                                                                                                                                                                                                                                                                                                                                      | Merged into G5; no separate change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 15. Review disposition — GLM review of `1e9f625`

Source read: `/workspace/wvops/WV-353-review-1e9f625.json` (A7). It contains one
warning and four notes, all `auto-fix`; none is marked `follow-up`. All five
findings are confirmed below against the plan and code at `1e9f625`.
Historical §14 dispositions and FU1–FU4 remain intact. P1–P3 stay closed under
D-ENG-025/026/027; §9 and the disposition references now say so explicitly.
Only `PLAN.md` changes; these are contracts and future checks, not implementation.

| #   | Severity | Finding and verification at `1e9f625`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | warning  | Confirmed: §4 omits explicit durable stop-key digests from ledger/refusal contracts and omits the volatile-field list from the site snapshot. §6.5's captured-input identity is ambiguous. HEAD `digest` (`packages/weave/src/digest.ts:5`) and `stableStringify` (`packages/weave/src/stable-json.ts:5`) provide canonical identity; current `Runtime.load`/`indexAccepted` (`packages/weave/src/runtime.ts:1932,1960`) have no context stop index.                                                                                                                                                                                                                      | Fixed in §4, §5.5 and §6.6: explicit fit-input, policy and storage-policy fields on all decisions; versioned volatile list/identity in the snapshotted site contract; storage-policy snapshot on complete evidence; validation/replay recompute keys from durable inputs. §6.5 equates captured input with fit-input digest. T9/T11 reject missing/tampered bindings and guard crash/reload reconstruction. Bounded markers still replay only their failure evidence. |
| H2  | note     | Confirmed: `Runtime.frontierWeighStatus` (`packages/weave/src/runtime.ts:1040`) checks `in_flight`, then returns `finished` at `:1056` or `deferred` at `:1064` before its final `needed`. The former §5.5 slot could let an older recorded-unaccepted weighing shadow a newer stop.                                                                                                                                                                                                                                                                                                                                                                                      | Fixed in §5.5: after `in_flight`, resolve latest accepted stop/v2 request by observation seq before every inference-outcome branch. A newer stop wins over older `finished`/`deferred`; a newer admitted v2 request supersedes it regardless of model outcome. T6 covers both interleavings and reload, with a branch-order mutation. No supersession write or crash gap is added.                                                                                    |
| H3  | note     | Confirmed: `Runtime.weighAndSelect` (`packages/weave/src/runtime.ts:851`) checks status at `:879`, judgments at `:897` and cost at `:905`. T6's claim that budget exhaustion always wins contradicted the proposed reusable-stop branch.                                                                                                                                                                                                                                                                                                                                                                                                                                  | Fixed in §5.5/T6: budget blocks prevent new assembly/refusal when no matching stop applies; a reusable stop still returns `refused` with exhausted budgets. Both stop types reserve nothing and append nothing on reuse.                                                                                                                                                                                                                                              |
| H4  | note     | Confirmed: §6.5 names only frontier.weigh's logical attempt. HEAD `Runtime.frameGoal` (`packages/weave/src/runtime.ts:1228`) has `started.action_id` and derives `request_id = inf:${started.action_id}` at `:1245`; `Runtime.weighAndSelect` derives per-cycle ids at `:916`. `Runtime.appendStep` (`:620,626`) can see an id without an accepted durable record.                                                                                                                                                                                                                                                                                                        | Fixed in §6.5: goal.frame uses the framing action id, frontier.weigh uses the cycle request id, and recovery retains the recorded attempt. Fresh attempts distinguish A/B/A; same-attempt duplicates must match bytes. §5.5's duplicate/integrity-error guard remains, including the diagnostic-only case. T9 adds both-site identity/reload checks.                                                                                                                  |
| H5  | note     | Confirmed in that historical workspace: the §14 raw path was absent, so its file-shape/source claims could not be re-read (current availability update in A7). G1/G2/G4/G5 code claims hold at HEAD: `Runtime.frontierWeighStatus`/`weighAndSelect` (`packages/weave/src/runtime.ts:1040,851`), `payloadBytes`/`hasMidValue` (`packages/weave/src/log-bound.ts:7,11`), `CATALOGUE_SLOT_MICROS`/`profileReservation` (`packages/weave/src/strategy.ts:12,72`) and `excludeReason` (comparison at `packages/gateway/src/routing.ts:220`). G3's unbounded candidate/in-flight inventory is still in `renderWeighView` (`packages/weave/src/views.ts:272`); G6 duplicates G5. | Fixed with A7 and the qualified §14 source line. Current review-target/inventory provenance points to `1e9f625`; historical review names remain historical. Earlier corrections and FU1–FU4 remain. Repeated durability/status findings become concrete T6/T9/T11 assertions and mutations, alongside existing FU3/FU4 checks.                                                                                                                                        |

## 16. Review disposition — Claude Opus review of `859668c`

Historical source recorded by plan7: `/workspace/wvops/WV-353-review-859668c.json` (A7). Reported risk:
medium; two warnings and two notes, all `auto-fix`. Each finding's evidence was
checked against repository HEAD `859668c`; no finding is marked follow-up.
Code evidence is unchanged at `ac0dc38`; the pin corrections and engineering
refinements below incorporate §17 without reopening the earlier closed fixes.
These are concrete engineering fixes under D-ENG-021. D-ENG-025/026/027
(P1–P3), §14 G1–G6, §15 H1–H5, plan6 corrections and FU1–FU4 remain intact.
Behavioral tests below are requirements for implementation children, not claims
that this plan-only revision added or ran them.

| ID  | Severity / action  | HEAD evidence and assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Disposition in this plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | warning / auto-fix | Confirmed: `Runtime.reconcileStep` (`packages/weave/src/runtime.ts:1845`) checks allowance at `:1854`, appends `recovery.attempted` at `:1863`, then calls `grantForLookup`/`host.lookup` at `:1875-1876` for unfinished actions. `abandonUnrecordedInferences` (`:1906`) only sees requested inferences; a refusal has none. Qualification: actual grant issuance is conditional on `grantForLookup`/`lookupAuthorized` (`:1523,1541`), not guaranteed for runtime-only goal.frame. That does not remove the missing local-disposition branch. | Fixed in §5.5/§6.5 and C2d, refined by §17 W2/W4: resolve every accepted stop by owner/action in a pre-pass before constructing unfinished, append only its P2 result referencing the decision, with no recovery.attempted, spend, lookup grant or host call. T9 crash-worker rows cover refusal and marker before result, zero allowance, result-write faults, after-result-before-fold and double reload; generic-path mutation fails. T8/T16 retain cancellation and owner isolation. |
| O2  | warning / auto-fix | Confirmed: `Runtime.frameGoal` (`packages/weave/src/runtime.ts:1228`) uses `candidate_set: null` at `:1273`, remaining-cost ceiling at `:1253` and tick-based deadline at `:1259`. `renderFrameView` (`packages/weave/src/views.ts:101`) stamps `state_revision`; `request_id` and optional `prefix_digest` derive at `runtime.ts:1245,1254`. A shared null stop key can collide, while an unprojected tick can change same-action identity.                                                                                                    | Fixed (plan7); tick-tolerant projection superseded by §17 W3 (unique owner/action key, verified bindings, empty goal.frame volatile list); isolation and stored-byte integrity unchanged.                                                                                                                                                                                                                                                                                                |
| O3  | note / auto-fix    | Confirmed: the `Runtime` constructor indexes only inference.requested into `replayRequests`/`replayFrameRequests` (`packages/weave/src/runtime.ts:282-288`); `recordedFrameProfile`/`nextReplayRequest` (`:2178,2199`) assume requests. `frameGoal` (`:1228`; replay check at `:1281`) records a request before its replay branch. `replayEnvironment.execute` (`:2625-2627`) reruns framing before matching action.result.                                                                                                                     | Fixed in §6.6 and C2c/C2d: index accepted refusal/marker decisions by id and owner/logical attempt, dispatch historical profile/evidence by type, and make frameGoal match/compare recorded stops and their result reference without fresh persistence. T9 drives both stop types through Runtime replay with zero journal appends/calls and identical trace; missing/duplicate/mismatch/index-omission mutations fail.                                                                  |
| O4  | note / auto-fix    | Confirmed: `packages/weave/test/p8.test.ts:1902` begins a comment; `test('a part-written file journal append is reported as incomplete, not as another writer (#249)', ...)` is declared at `:1903`; `:1904` is its first body statement. The torn-tail `test` is at `:1096`.                                                                                                                                                                                                                                                                   | Fixed in §6.5: cite both exact test titles and their declaration lines as navigation hints. FU3 requires test citations to resolve to declarations, so a repeated comment-line pin becomes a failing C1 check.                                                                                                                                                                                                                                                                           |

## 17. Review disposition — Claude Opus review of `ac0dc38`

Source read: `/workspace/wvops/WV-353-review-ac0dc38.json` (A7). Reported risk:
medium; four warnings and two notes, all `auto-fix`, with empty `ask_user`.
Each finding's evidence was checked against HEAD `ac0dc38`; the original N1
assessment overstated what result lookup proves and is corrected below by
§19 E1 and refined by §20 E1. The separate FU3 escalation is tracked as a follow-up below; no lint
or implementation is added in this PLAN.md-only revision. These are concrete
engineering recommendations under D-ENG-021. Locked D-ENG-025/026/027 (P1–P3),
§14 G1–G6, §15 H1–H5, plan6 and the earlier plan7 fixes remain closed. Source,
tests, schemas, GLOSSARY and parked harness parents remain untouched.
The behavioral checks below are requirements for future children, not executed
implementation tests in this revision.

| ID             | Severity / action       | HEAD evidence and assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Disposition in this plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1             | warning / auto-fix      | Confirmed: the exact #249 `test` declaration is `packages/weave/test/p8.test.ts:1903`; :1902 is a comment and :1904 a body statement. The torn-tail test is declared at :1096. `recordedFrameProfile` is declared at `packages/weave/src/runtime.ts:2178`, while :2177 is JSDoc; `nextReplayRequest` is declared at :2199.                                                                                                                                                   | Corrected §6.5, §6.6 and §16 pins/evidence. FU3 now explicitly covers every PLAN.md definition/test citation, including grouped pins and review-disposition tables, and rejects comment/JSDoc/body-statement lines as declarations. The check remains C1 work; the review's separate FU3 follow-up is recorded below.                                                                                                                                                                                                                                                                                                                                                                                      |
| W2             | warning / auto-fix      | Confirmed: `Runtime.reconcileStep` (`packages/weave/src/runtime.ts:1845`) calls `abandonUnrecordedInferences` at :1846, constructs unfinished at :1847 and loops at :1850. Allowance exhaustion at :1854 calls `recordRecoveryExhausted` (declaration :1509) and returns from the whole step at :1856.                                                                                                                                                                       | §5.5/§6.5 and C2d require a pre-pass after abandonment and before constructing unfinished, resolving every running framing action with an accepted owner/action stop and excluding resolved actions from generic recovery. T9 adds both stop types with zero allowance, two unfinished actions and the generic one first: exactly one framing result, no framing recovery spend/attempt/grant/lookup, existing exhaustion behavior only for remaining generic work. Moving the branch inside the loop must fail. Result-write faults and double reload retain one decision/result.                                                                                                                         |
| W3             | warning / auto-fix      | Confirmed: live `frameGoal` is called only from `liveEnvironment.execute` (call at `packages/weave/src/runtime.ts:2545`); its other call is replay at :2626. Restart uses `reconcileStep` (:1845). `stampAssemblies`/`sliceAssemblyId` (`packages/weave/src/views.ts:80,74`) derive manifest assembly ids from state revision, used in direct render (call at runtime.ts:1236; shareAssemblies option at :1240) and `prepareSharedViews` (declaration :805; stored at :810). | §4/§5.5/§6.5 enforce one decision per (owner scope, started.action_id). Digests remain verified bindings; a mismatch or second decision is an integrity error that stops the owner. No live same-action re-entry is proposed. Goal.frame uses an empty volatile list and binds the complete manifest, so the optional tick-tolerant wildcard alternative is unnecessary. T9/T11 exercise the guard directly with exact bindings and after tick/term/assembly changes, shareAssemblies off/on, reload, duplicate decisions and distinct owners/actions. Frontier.weigh's existing volatile projection and A/B/A supersession remain intact.                                                                 |
| W4             | warning / auto-fix      | Confirmed: `packages/weave/src` contains no `clarif` match. Live framing outcomes pass through `recordResult` (call at `packages/weave/src/runtime.ts:2547`), while the proposed stop branch needs an explicit action/goal mapping.                                                                                                                                                                                                                                          | §5.5 and C1 fix the framing outcome: exactly one action.result, failed/context_overflow for refusal or failed/context_persistence_failure for marker, referencing its decision. Clarification is a separate durable goal-level request referencing that refusal, written at most once before the result; it grants no call or spend and does not leave framing running. Named C2d-Q owns its bounded versioned shape/admission/replay contract before enforcement. T9 asserts at-most-once clarification across reloads and stop/request/result crash and append-failure boundaries; T8/T16 retain cancellation/concurrent-owner coverage. Closed P2 stays preferred clarification before goal fail/block. |
| N1             | note / auto-fix         | Corrected by §19 E1: accepted.find locates action.result by action_id (packages/weave/src/runtime.ts:2628-2631), but runtime results are immediately regenerated at :2645. Matching by action id does not control reproduction order. replay() skips runtime arrivals except report.review (:2780-2784), while checkPrefix (:2833-2845) requires equality seq by seq; a recovery abandonment between stop and result therefore diverges under HEAD semantics.                | §6.6/C2d preserve §19 E1's delayed recovery branch (return null and feed at seq), refined by §20 E1 to reproduce live next-seq dispositions inline. C2d-Q follows the same per-record rule. T9-L1/L2/R0/R1 pin both branches and their queue continuations, including real abandonment, without writes/calls; uniform-feed, uniform-regenerate and adjacency mutations fail. The stop still precedes exactly one referencing result; missing/mismatched/preceding results fail.                                                                                                                                                                                                                            |
| N2             | note / auto-fix         | Confirmed: `lookupAuthorized` is declared at `packages/weave/src/runtime.ts:1541`; :1543 is a describe use. The frameGoal replay check is at :1281; :1279 is its earlier rejected-validation return.                                                                                                                                                                                                                                                                         | Corrected §16 O1 to :1523,1541 and O3's labelled replay-check pin to :1281; FU3 retains declaration-versus-use-site validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| FU3 escalation | follow-up / record only | The review's separate follow_ups entry reports repeated declaration-pin errors; W1 confirms the current instances directly against HEAD.                                                                                                                                                                                                                                                                                                                                     | Tracked in §13 as required C1 pin-check coverage over PLAN.md and review dispositions, with positive declaration fixtures and negative comment/JSDoc/body fixtures. No check is implemented in this plan-only task; this follow-up does not reopen an owner question or weaken prior checks.                                                                                                                                                                                                                                                                                                                                                                                                               |

## 18. Review disposition — Claude Opus review of `f375b06` (plan9)

Source read: `/workspace/wvops/WV-353-p6-review-f375b06.json` (A7). Reported
risk medium: two warnings and three notes, no errors, all `auto-fix`, empty
`ask_user`. Each finding's evidence was verified against HEAD `f375b06` before
editing. R1–R3/R5 and the R4 direct-call drift are confirmed; R4's proposed
WEIGH_CONTROL_RECORDS correction is contradicted by HEAD and corrected below.
These are engineering recommendations under D-ENG-021. Locked D-ENG-025/026/027 (P1–P3), §14 G1–G6, §15 H1–H5,
plan6, plan7 and §17's earlier fixes stay closed. Only PLAN.md changes; the
behavioral checks and FU3 lint below remain requirements for implementation
children, not implemented tests in this revision.

| ID  | Severity / action  | HEAD evidence and assessment                                                                                                                                                                                                                                                                                                                                                                | Disposition in this plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | warning / auto-fix | Confirmed: `ActionResultPayload` and `ActionOutcome` (`packages/weave/src/types.ts:133,128`; failed arm at :130) have no stop reference. `applyAccepted` (failure assignment at `packages/weave/src/state.ts:393-395`) retains only free text; `recordResult` (`packages/weave/src/runtime.ts:1427`) has no reference/version handoff.                                                      | §4 recommends the explicit field/version requested in the brief: runtime-only stopped `action.result@2` with required `context_decision_id` and closed failure codes. C1 fixes its closed shape/size proof; C2c owns admission, historical-v1/new-v2 rules and folding; C2d carries it through live execution, local recovery and replay (§5.5/§6.5/§6.6). T9/T11 reject missing/wrong-owner/wrong-action/fit references, wrong code, free-text substitutes, no stop, preceding/duplicate results and downgrade; crash/reload retains exact version/reference without duplicate or lost state. The review's derived-reference alternative is not selected: the explicit v2 carrier makes the required reference directly verifiable. |
| R2  | warning / auto-fix | Confirmed: `failedCandidateIds`, `formCandidates` and `frameCandidate` (`packages/weave/src/candidates.ts:70,78,302`) filter failed candidates (`push` at :100-104); `{ goal_id }` inputs at :305 never change per goal. The review's :303 definition pin is a body statement; the declaration is :302. `candidateId` (`packages/weave/src/digest.ts:10`) hashes operation/revision/inputs. | §5.5/§10 assign C2d-Q the response-bound input/formation contract. The accepted authorized response id changes the candidate id; first accepted queue/start binds it to one new action. Without a response the failed candidate remains excluded. Reload rebuilds bindings; a bound response cannot be reused, including after cancellation or uncertainty. Marker recovery requires a separately authorized durable input/configuration change. T8/T9/T11/T16 require one fresh candidate/action/decision, no automatic loop or grant reuse, crash coverage around response and queue/start, and non-executing replay.                                                                                                              |
| R3  | note / auto-fix    | Confirmed: §5.5 previously proved marker fit at composition but C2d-Q merely bounded its request. `formCandidates` (in-flight check at `packages/weave/src/candidates.ts:110-113`) blocks framing while a stranded action runs; `Runtime.appendStep` (size check at `packages/weave/src/runtime.ts:610-621`) cannot durably accept an oversized payload.                                    | §5.5/C2d-Q now prove the maximum encoded clarification request fits the configured bound before enabling preparation; the new stopped-result shape has the same safeguard. T15 refuses insufficient bounds at composition, independently of marker fit, and covers equality. Journal rejections/ambiguity still stop and reload the owner, with only missing writes completed; size proof prevents deterministic oversize retry loops.                                                                                                                                                                                                                                                                                               |
| R4  | note / auto-fix    | Partly confirmed: `WEIGH_CONTROL_RECORDS` is declared at `packages/weave/src/runtime.ts:161`; :160 is JSDoc and :162 its first array element. The review's proposed :160/:161 correction is contradicted by HEAD. Direct `renderFrameView` call starts at :1236; :1240 is its shareAssemblies argument.                                                                                     | Kept the correct :161 declaration pin, made its file explicit in §5.5, and corrected the direct-call pins in §5.5/§17 W3. FU3 requires declaration and call-start checks, with negative JSDoc/element/argument fixtures (:160/:162/:1240) and positive declaration/call fixtures (:161/:1236). Repeated drift remains required C1 lint work, including review tables; this plan-only revision adds no check implementation.                                                                                                                                                                                                                                                                                                          |
| R5  | note / auto-fix    | Confirmed in HEAD PLAN.md §16 O2: its disposition repeats supersession of the tick projection and preservation of action isolation/stored bytes.                                                                                                                                                                                                                                            | Collapsed to one sentence, retaining the §17 W3 supersession, unique owner/action key, verified bindings, empty volatile list and unchanged isolation/stored-byte integrity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The review's separate record-only FU3 follow-up is retained in §13/C1. No new
owner fork is opened; no parked harness parent or benchmark route changes.

Plan9 verification: the temporary five-finding document check failed for all
five requirements before editing and passes afterwards; repository checks also
confirm the new declaration/call pins and unchanged §7/§9/§15 text. With Node 22
at `/home/box/.local/node22/bin`, `npm run fmt:check` and `npm run check` pass.
`npm run verify` stops at `npm run test:checks`: the unchanged
`checks/test/checks.test.mjs` cannot capture its check subprocesses because
`spawnSync /home/box/.local/node22/bin/node` returns `EPERM` in this environment
(reproduced directly). Later full-suite stages were not reached; no source,
fixture or check was changed to bypass the blocker.

## 19. Review disposition — Claude Opus review of `838aa20` (plan10)

Historical disposition: §20 E1/W1/W2 refine the uniform feed policy and result-step
mechanics below; the corrected active contract is in §4/§5.5/§6.6. The original
ordering, validation and identity fixes remain required.

Source read: `/workspace/wvops/WV-353-p6-review-838aa20.json` (A7). Reported
risk medium: one error, one warning and three notes; E1/W1/N1 are auto-fix,
N2/N3 no-change, with empty `ask_user`. Each evidence claim was checked against
HEAD `838aa20`, including replay, reconcile, append and existing tests rather
than relying on this plan's earlier assessments. These are concrete engineering
recommendations under D-ENG-021, with no new owner fork. D-ENG-025/026/027 stay
closed; §7 benchmark guards, §9, §14–§16 (including H1–H5, plan6/plan7) remain
unchanged. Only PLAN.md changes. The behavioral checks and FU3–FU5 below are
implementation-child requirements, not implemented runtime checks in plan10.

| ID  | Severity / action  | HEAD evidence and assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | error / auto-fix   | Confirmed: replay (packages/weave/src/runtime.ts:2754) skips CYCLE_APPENDED runtime/judgment sources (:173, :2782-2784) except feedReviewResult (:2780-2781). replayEnvironment.execute finds by action id (:2628-2631) then immediately re-records runtime results (:2645). checkPrefix (:2833-2845) compares stableStringify seq by seq. reconcileStep (:1845) first calls abandonment (:1846), whose gateway-source inference.recorded (:1911-1923) can precede its local stop result; replay never calls reconcile. Lookup alone cannot preserve that order.                        | §6.6/C2d require return null for stop-backed framing after matching, feedStopResult at recorded seq, and no execute-time recordResult. C2d-Q's runtime-only request is also fed at its seq. T9 uses a real frontier.weigh abandonment from recovery, with mutations regenerating either disposition at execute time. Corrected §17 N1; FU5 requires a feed/regenerate policy and an ordering test for every new recovery-written runtime record. Stop/result identity, canonical equality and no replay effects remain mandatory.                                                                  |
| W1  | warning / auto-fix | Confirmed: §5.5/FU4 omitted disposition records. appendStep returns a rejected validation for action.result PersistError (packages/weave/src/runtime.ts:647-654); recordResultStep (:1441) discards append's Observation at :1484, recordResult (:1427) returns void, and live goal.frame ignores it (:2547). formCandidates (packages/weave/src/candidates.ts:78; guard at :110-113) suppresses framing while a stranded action remains running. Existing M1-T18 (packages/weave/test/m1.test.ts:478) covers generic publication recovery, not this planned live stop-result contract. | Added the stop-disposition matrix for action.result@2 and clarification writes in live execute, reconcile pre-pass and replay. C2d must check result validation before drainQueue/continuation. Rejection, duplicate id, PersistError-as-rejected or throw stops the owner; preserve acknowledged records, claim no new durability and reload before live continuation. T11/T15 inject live result PersistError after accepted refusal/request, require no new framing candidate and exactly one result after double reload. FU4 now covers both tables and future record types/rejection reasons. |
| N1  | note / auto-fix    | Confirmed: C1 previously claimed a clarification maximum before C2d-Q supplies its schema (§4/§10); a closed encoded bound needs that schema.                                                                                                                                                                                                                                                                                                                                                                                                                                           | C1 owns the generic composition-time size-fit rule and closed marker/stopped-result bounds; C2d-Q derives its clarification bound from its schema and owns T15 equality/one-over rows. No behavior or enforcement gate changes.                                                                                                                                                                                                                                                                                                                                                                    |
| N2  | note / no-change   | Rechecked §16 O1–O4 against reconcileStep, grantForLookup/lookupAuthorized (packages/weave/src/runtime.ts:1845,1523,1541), replay indexes/profile helpers (:282-288,2178,2199), and p8 test declarations (packages/weave/test/p8.test.ts:1096,1903). R4 pins remain correct: WEIGH_CONTROL_RECORDS declaration runtime.ts:161, renderFrameView call start :1236.                                                                                                                                                                                                                        | No plan change for this note: §18 is plan9's disposition section; §16 remains plan7's. E1 above supplies the replay-mechanism correction without reopening O1–O4.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| N3  | note / no-change   | Confirmed as review provenance: the review explicitly did not rerun plan9's §18 verification commands; those historical outcomes do not establish current verification.                                                                                                                                                                                                                                                                                                                                                                                                                 | No plan change for the historical report: plan10 reruns formatting and available checks below and reports its own observed outcomes; no validation is weakened.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The separate `FU-replay-runtime-results` follow-up is recorded as FU5 in §13;
it does not block C1. No parked harness parent, hosted inference, benchmark
route, shuffle setting or single-use grant contract changes.

Plan10 verification (Node 22 at `/home/box/.local/node22/bin`): the temporary
review-requirement document check failed for all ten missing requirements
before editing and passes afterwards. It also confirms §7/§9/§14/§15/§16 are
byte-for-byte unchanged; `git diff --check` passes and only PLAN.md changed.
`npm run verify` passes `npm run fmt:check` and `npm run check`, then stops at
`npm run test:checks` in the unchanged `checks/test/checks.test.mjs`. Running
that file directly shows five fixture-output assertion failures; a direct
`spawnSync(process.execPath, ...)` reproduction for its no-ambient-env fixture
returns `EPERM` (`spawnSync /home/box/.local/node22/bin/node`) and empty captured
stdout/stderr. Later full-suite stages were not reached. No check, permission,
fixture, source or benchmark was changed to bypass this environment blocker;
the new runtime behaviors remain future child acceptance requirements.

## 20. Review disposition — Claude Opus review of `25e1d0f` (plan11)

Source read: `/workspace/wvops/WV-353-p6-review-25e1d0f.json` (A7). Reported
risk medium: one error, two warnings and three notes; E1/W1/W2 auto-fix,
N1–N3 no-change, empty `ask_user`. §2.7 records the actual HEAD call paths,
traced and written before the design edits. The recommendations below are
engineering under D-ENG-021, with no owner product fork. D-ENG-025/026/027
remain closed; §7, §9 and §14–§16 (including H1–H5, plan6 and plan7) stay
byte-for-byte unchanged. No parked parent, benchmark route, shuffle setting,
permission or single-use grant contract changes. Only PLAN.md is edited;
runtime/schema/test changes and FU3–FU5 checks remain future child work.

| ID        | Severity / action       | Verified evidence and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | error / auto-fix        | Confirmed: live result is synchronous inside selection/dispatch (`packages/weave/src/runtime.ts:757-764,1396,2544-2549`); runtime feed does not cycle/drain (`:583-593`), and prefix equality is strict (`:2833-2845`). §4/§6.6/C2d/C2d-Q now use the per-record next-seq inline prefix for live disposition and feed-at-seq for recovery-delayed records, with exactly one consumer. Additional HEAD qualification: drainQueue is disabled in replay (`:1778-1779`), so §6.6 explicitly reconstructs recorded queued starts through the non-executing replay environment. T9-L1/L2/R1 reject both uniform policies and the queue no-op; no journal, host, gateway, grant or Weft effect is permitted.                                |
| W1        | warning / auto-fix      | Confirmed: recordResultStep discards append at `packages/weave/src/runtime.ts:1484` then drains at `:1486`, including after result PersistError-as-rejected (`:647-654`). §5.5/C2d select a dedicated v2 result step with validation inside it before any live drain; any non-accepted write stops/unwinds the owner before later selection, outer drains or generic recovery. T11/T15 add pending queued work with spare capacity and zero subsequent starts/invokes; the check-validation-after-recordResult-returns mutation fails.                                                                                                                                                                                                |
| W2        | warning / auto-fix      | Confirmed for the new pre-pass: ordinary recordResult would drain before generic exhaustion's return (`packages/weave/src/runtime.ts:1854-1856`). §5.5/§6.5/C2d require the non-draining result variant; T9-R0 adds a pending action, zero allowance and no open inference, requiring zero starts/invokes and exactly one framing disposition across double reload. Qualification: HEAD can already drain through abandonment ingress (`:304,583-593,1911-1923`) and generic result/reconciled calls (`:1486,1506,1879-1894`); §2.7 preserves those paths rather than claiming :1897 is its only drain. Recovery-delayed replay feeds do not drain; exhaustion and any later recorded queue continuation have explicit §6.6 policies. |
| N1        | note / no-change        | No change needed: §19 is plan10's disposition, §16 is plan7's; O1–O4 and their HEAD pins were rechecked and remain intact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| N2        | note / no-change        | No change needed to plan10's evidence pins: checked against HEAD's replay/append/frame/candidate symbols and M1-T18 (`packages/weave/test/m1.test.ts:478`); §20 refines the mechanism, not those source facts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| N3        | note / no-change        | No change needed to §19's historical verification report: this review reran no suite; plan11 reports only its own observed checks below, and implementation children still owe npm run verify where subprocesses work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| FU5-scope | follow-up / record only | §13 FU5 and §6.6 now require policy per (record type, write site), covering synchronous live dispatch and queue continuation as well as recovery. C1 owns contract/coverage, C2c/C2d/C2d-Q own the ordering tests; missing policy or continuation coverage fails the child check.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Plan11 verification (Node 22 at `/home/box/.local/node22/bin`): the temporary
review-requirement document check first failed on six missing requirements and
then passed all eight checks, including preservation of §7/§9/§14–§16 and the
PLAN.md-only scope. HEAD source/test declarations and the call-path pins were
rechecked directly; `git diff --check` passes. No runtime behavioral red/green
or implemented lint is claimed by these document checks.

`npm run verify` passes `npm run fmt:check` (506 files) and `npm run check`
(benchmark digests/cache checks and all five source-policy checks), then stops
at `npm run test:checks`: unchanged `checks/test/checks.test.mjs` fails, while
the other two check-test files pass. Direct execution of that file gives five
fixture-output assertion failures; reproducing its no-ambient-env child call
with `spawnSync(process.execPath, ...)` returns status 1, error `EPERM`
(`spawnSync /home/box/.local/node22/bin/node`) and empty stdout/stderr. Later
full-suite stages were not reached. No test, fixture, permission or validation
was changed to bypass this environment blocker. Implementation children must
run the full suite where subprocesses work before claiming behavioral green.
