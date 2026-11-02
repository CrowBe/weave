# PLAN — strict pre-flight context budget assembler (#353)

Status: **plan only. This revision addresses the Codex review of `518dc05`; no implementation is authorized by it.**
Issue: CrowBe/weave#353 (architecture parent). Branch `wv-353-context-budget-plan`, base `0281c5e`.

The issue text used here is the copy in the task brief. This plan revision did
not read the remote issue; that source assumption is recorded as A1.

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

## 2. Inventory at HEAD (`0281c5e`)

### 2.1 The context window is declared, never measured

| Where                                                                                                                   | What it does today                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/gateway/src/types.ts:146` `InferenceTerms.max_context_tokens`                                                 | A caller-declared number.                                                                                                                                        |
| `packages/gateway/src/gateway.ts:867` `invalidTerms`                                                                    | Only checks `>= 1`.                                                                                                                                              |
| `packages/gateway/src/routing.ts:220` `excludeReason`                                                                   | Excludes a unit when `unit.context_limit_tokens < terms.max_context_tokens` (`context_limit_too_small`). It compares two declarations.                           |
| `packages/gateway/src/routing.ts:66` `worstCaseCost`, `:78` `priceAttempt`                                              | Prices the cold window as `max_context_tokens` input tokens. Gateway attempt affordability depends on that input bound; Loom reserves `cost_ceiling` separately. |
| `packages/gateway/src/gateway.ts:1011,1017,1036` pacing                                                                 | Counts worst-case tokens as `max_context_tokens + max_output_tokens`.                                                                                            |
| `packages/gateway/src/types.ts:408` `ProviderUsage.input_tokens`                                                        | Reported after the call. Nothing compares it with `max_context_tokens`.                                                                                          |
| `packages/weave/src/runtime.ts:928` (frontier.weigh), `:1258` (goal.frame), `packages/weave/src/gateway-decision.ts:54` | All hard-code `max_context_tokens: 8_000`. Framing can override it through `RuntimeOptions.framingTerms` (`runtime.ts:120`).                                     |

**Finding F1:** no code path compares the bytes or tokens actually sent
(`instructions` + `prompt`, or `state` + `questions`) with
`max_context_tokens`. A request can exceed the window it declared. Routing
then believes the declaration, and gateway attempt pricing can understate the
input. Loom separately reserves the whole `cost_ceiling`, not `worstCaseCost`.

### 2.2 Slices, profiles and disclosed truncation

- `packages/weave/src/types.ts:200-220` defines `ViewOmission {name, reason}`,
  `ViewSliceManifest {name, revisions, truncated, omitted, assembly_id?}` and
  `StateView {profile, profile_version, state_revision, content, manifest}`.
- `packages/weave/src/views.ts:19` `FrameProfile` has `catalogue_budget`,
  which counts **operations**, not tokens. It also has `slices`, `prefix` and
  `schema_for`. `renderFrameView` (`:101`) truncates the catalogue by
  `catalogue_budget` with omission reason `budget` and `truncated: true`. It
  omits unauthorized sources with reason `authority` and unselected schemas
  with reason `profile`.
- `views.ts:74` `sliceAssemblyId` and `:80` `stampAssemblies` stamp a shared
  assembly. The runtime charges it once per cycle (`runtime.ts:1216`
  `noteViewAssemblies`, `SHARED_ASSEMBLY_MICROS`).
- `views.ts:272` `renderWeighView` has no budget at all. It omits non-scalar
  inputs with reason `profile`.
- `packages/weave/src/audit-view.ts:154` `assembleAuditState` uses fixed byte
  caps: `max_body_bytes` (default 4096), statements 4096, ids and tails 240.
  It records each cut in `omissions` (`*:size_cap`, `*:statement_cap`, …) and
  cuts UTF-8 safely (`boundedUtf8`, `boundedUtf8Tail`). The truncation is
  disclosed, but per field and in bytes. There is no total.
- `packages/weave/src/strategy.ts:33` `stablePrefixBytes` defines the stable
  prefix: profile id and version, `prefix`, and the catalogue.
  `CATALOGUE_SLOT_MICROS` and `profileReservation` (`:72`) are fixture costs per
  catalogue slot, not token counts.
- `packages/weave/src/compaction.ts:13` `compactContext` works on token arrays
  from an injected tokenizer. It compacts at 80% of capacity and rejects an
  oversized summary (`AUDIT-CONTRACT.md:133`). Nothing calls it on the
  inference request path.

### 2.3 Instructions and questions are outside any manifest

- goal.frame: `runtime.ts:1300` has an inline instruction string. The prompt
  is `stableStringify(view.content)`.
- frontier.weigh: `gateway-decision.ts:45` sends `view.content` as `state`, plus
  `frontierWeighQuestions` (`frontier-weigh.ts:37`).
- audit: `audit-loop.ts:368` has inline instructions. The prompt is
  `JSON.stringify(observed.state)`.
- implementation step: `implement-step.ts:908` uses caller instructions and
  prompt. `feedbackPrompt` (`:573`) **appends** failure lines on every retry,
  and nothing measures the result.
- task validation and the criteria gate: `task-acceptance.ts:86,89` instruction
  constants, with per-line questions (`:471`, `:487`).
- The gateway API accepts already filtered content (`types.ts:172`), but
  adapters transform it: `typesafe-ai.ts` translates typed questions into wire
  questions; `openai-compatible.ts` constructs messages, roles and an envelope.
  Measuring only the caller's leaf bodies does not measure this complete input.

**Finding F2:** the issue wants instructions and capability schemas in the same
ledger as the slices. Today, instructions and questions are not slices. They
are not in `ViewSliceManifest` and are not counted anywhere.

### 2.4 Budget and cost gates

- `packages/gateway/src/budget.ts` `budget.policy@1` is a deterministic
  whole-account quota filter (weekly, five-hour and pace). It knows nothing
  about request content and must not learn about it: the gateway imports
  nothing in-repo (`checks/import-direction.mjs`).
- Loom's own budget: `inference.requested` reserves `{judgments, cost}`
  (`state.ts:326`). `validateInferenceRequested` (`validation.ts:653`) rejects
  a reservation over the remaining budget. `inference.recorded`
  (`state.ts:338`) settles it.
- Precedent for refusing before dispatch: `runtime.ts:905-913` blocks the cycle
  with `cost budget exhausted` and makes no call, writing no extra record.
  Replay re-derives the refusal from state.

### 2.5 Durability, recovery, replay

- `runtime.ts:1086` `appendInferenceRequested` journals the view, terms and
  reservation **before** the gateway call (`:1284-1307`).
- Recovery abandons a request that has no `inference.recorded`
  (`runtime.ts:145` `ABANDONED_INFERENCE`).
- Replay re-renders the frame view using a historical profile **supplied by
  the replay caller** (`RuntimeOptions.frameProfile`, `runtime.ts:111-115`) and
  the recorded catalogue (`replayCatalogueIds`, `:1170`). `StateView` contains
  only profile identity/version, not the complete profile. Neither historical
  templates nor future excluded bodies are guaranteed to be recoverable there.
- `validate` (`validation.ts:117`) globally rejects versions other than 1;
  adding a v2 branch only in `validateInferenceRequested` cannot admit v2.
  `Runtime.load` currently folds accepted records without version dispatch.
- `FileJournal.persist` uses `appendFileSync` with no flush or torn-tail
  protocol. It does not establish the stronger durable-append contract in §6.5.
- `log-bound.ts` rejects a mid-value cut ("rejected, not repaired") and bounds
  observation bytes.

### 2.6 Benchmark routes

- Benchmarks build gateways and terms directly and never go through Loom's
  request path:
  - `benchmarks/inference/jev/run.ts:240,483` (`max_context_tokens: 8_000`;
    `TYPESAFE_REQUEST_PARAMS.shuffle: false` at `:47`; reference mode);
  - `benchmarks/decision-sites/competitors.ts:266`;
  - `benchmarks/decision-sites/questions.ts:37` (4000);
  - `benchmarks/frontier-weigh/run.ts:110`;
  - `benchmarks/task-acceptance/live.ts:47`.
- `benchmarks/frontier-weigh/build.ts:233` calls `renderWeighView` directly,
  so any byte change to a renderer changes benchmark cases.
- `scripts/benchmark-digests.test.mjs` pins the checked-in benchmark inputs
  and artifacts. The reference run header pins the corpus hash and plan hash
  (GLOSSARY "Reference run header").

## 3. Decisions (architectural recommendations under D-ENG-021)

D-ENG-021 is applied as supplied in the brief; its record is not in this
repository. These architecture and code-health choices are decided here.
Only the product choices in §9 require Benjamin's answer.

**R1. Pure assembly in Loom; prepared requests cross the decision boundary.**
`packages/weave/src/context-budget.ts` will be a pure transformation of explicit
inputs. In Loom's two runtime-owned inference paths it runs inside the existing
single-writer `step`, before durable append and dispatch. It takes no clock,
randomness, environment, credentials or transport. Provider-specific accounting
belongs beside wire profiles/adapters and is injected by trusted composition;
Loom sees a versioned accounting interface and opaque coverage identity.
`budget.policy@1` retains its whole-account quota role.

For `frontier.weigh`, C2 changes `WeighRequest` and `GatewayDecisionLayer.weigh`
to carry a prepared evaluation request: the one request id, exact `state`,
questions, effective terms and digest that were measured and journaled. The
layer passes those fields unchanged to `gateway.evaluate`; it no longer builds
questions or substitutes its own 8_000, destinations, deadline or cost ceiling.
The existing acceptance function and weight interpretation remain site-owned.
The request's cancellation signal reaches the actual gateway call. Scripted
weighing still receives candidates without requesting inference. This is a
Loom boundary change, not a change to default gateway routing.

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
`routing.ts:220` comparison and every direct benchmark route keep their present
semantics. If establishing this contract requires a separate gateway change,
it must land with red tests before C2 enforcement can claim window safety.
Until then, hold affected routes; do not assert strict safety on assumption A4.

## 4. Data and admission contracts (proposal only)

C1 writes `packages/weave/src/CONTEXT-BUDGET-CONTRACT.md` before implementation.
Use validated JSON values, not `body: unknown` as an accepted contract. The
following are closed, versioned records; version ids name immutable content.

| Record                 | Required evidence and invariants                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site assembly contract | Site and operation/kind; complete profile snapshot; expected parts and content-path mapping; protected classes and priorities; renderer and reconstruction revisions; complete instruction/question template snapshots and their rendering rules; budget policy and limits. No optional map supplied by the caller can override it.                                                                                                                                       |
| Accounting family      | Version and content digest; all member contract/evidence digests; opaque fingerprint of the scoped gateway route/adapter configuration; exact reconstruction and serialization revisions; per-route bounds and proved framing allowances; capacity contract and output allowance. Implementations are injected pure functions whose historical revisions must be retained; provider-specific configuration stays opaque to Loom.                                          |
| `assembly_evidence`    | Decision id and owner scope/attempt; complete site policy/profile (including `catalogue_budget`, `slices`, `prefix`, `schema_for` and budget); estimator/accounting specification and evidence identity; original authorized pre-trim view and manifest; exact template bodies and substitutions; all candidate part bodies including excluded ones; original terms, effective terms and prepared request. Record content digests and original state/catalogue revisions. |
| `context.ledger@1`     | Policy ceiling `ceiling_tokens`; enforced request term `reserved_tokens`; `full_tokens`, `required_tokens`, `used_tokens`, `truncated_tokens`; original/included/required request digests; family and evidence digests; per-route complete-input byte counts, framing allowance and token bound; ordered parts with inclusion, class, priority, body digest, canonical body byte counts and manifest/template linkage.                                                    |
| Prepared request       | Immutable generation `input` or evaluation `state` and `questions`, plus id/site/role/kind and all effective terms. Its content digest is bound to the ledger and evidence. Acceptance callbacks and AbortSignals stay outside serialized evidence and are selected by historical site contract.                                                                                                                                                                          |

`assembly_evidence` uses inline complete snapshots in the same atomic decision
record. Profile ids, estimator ids, hashes or mutable repository paths alone
are insufficient. The historical pure implementation and its evidence bundle
are resolved by immutable revision/digest, verified before replay; unavailable
versions are a replay failure. No new blob-store abstraction is introduced.
If the record cannot fit the existing observation bound, persistence rejects it
before dispatch; never cut evidence, relax the bound or persist only a trimmed
view. Already disclosed profile/audit byte omissions remain recorded inputs.

Ledger part byte counts are diagnostics, **not additive token estimates**.
The accounting family recomputes the complete request for each inclusion set.
Define `B(S)` as the maximum certified complete-input token bound over all
covered routes for inclusion set S, including framing once per route. Contracts
must establish that B is non-decreasing under the allowed whole-part additions;
an estimator lacking that property is not admitted for this policy.

- `full_tokens = B(all candidate parts)`.
- `required_tokens = B(required parts only)`; both reconstructions include the
  required structural envelope and the relevant omission disclosure.
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

| Reason                                                       | Exact fields and accounting                                                                                                                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required_exceeds_ceiling`                                   | Valid ceiling and complete evidence; `total_tokens = B(all)`, `required_tokens = B(required)`, `over_by_tokens = required_tokens - ceiling_tokens > 0`; `total_over_by_tokens = total_tokens - ceiling_tokens`. |
| `total_exceeds_ceiling`                                      | C2 only: required parts fit but full input does not; `required_tokens <= ceiling_tokens < total_tokens`; `over_by_tokens = total_tokens - ceiling_tokens`, equal to `total_over_by_tokens`.                     |
| `invalid_budget` / `invalid_part` / `unsupported_accounting` | Bounded reason code and evidence/witness identity; omit uncomputable numeric fields entirely. Never put NaN, negative excess, infinity or guessed totals in a record. No request can dispatch.                  |

The `status: fits` result contains ledger, evidence and prepared request; the
`status: overflow` result contains the refusal and its evidence. Unsupported
capacity or route coverage is `unsupported_accounting`. A C3 omission set
whose reconstruction cannot be certified also refuses dispatch.

C2 must change admission and historical transitions together:

1. Replace the global v1-only gate in `validate` with an explicit per-type
   version table. Admit `inference.requested@2` and runtime-only
   `context.refused@1`; keep other types' current supported versions and source
   checks. Refusal records have no budget reservation effect.
2. Distinguish trusted historical load/replay from new-write admission; the
   payload cannot select historical mode. Preserve v1 validation/folding for
   old logs; every new assembler-managed request requires v2. Reject a new v1
   request at these sites, including attempts submitted through another ingress.
3. Version-dispatch `load`, replay, state folding and request/profile indexes
   before mutation; prevalidate unsupported record versions before partial
   loading. A stored `accepted` flag is not permission to interpret v2 as v1.
   Old binaries cannot read the new log safely; no rollback to a v1-only loader.
4. For v2, reconstruct from sealed evidence and trusted historical contracts.
   Validate inventory completeness, protected classifications, exact inclusion
   set/order, safe arithmetic, every per-route bound/allowance, aggregate totals,
   part and manifest digests, full and effective view bindings, request digest,
   and all effective terms. Digest equality uses existing `digest(value)` and
   canonical `stableStringify` semantics, not double-serialized strings.
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

Admit only null, booleans, finite JSON numbers, strings, dense arrays and plain
data objects with own string keys and data properties. Reject undefined,
functions, symbols, BigInt, cycles, sparse arrays, accessors, custom prototypes,
non-finite numbers and unsupported object hooks. Normalize JSON `-0` to `0`
explicitly. Require explicit positive safe-integer `max_depth` and `max_nodes`
in the trusted site contract. Stop traversal at either limit and validate the
tree before recursive serialization. Record limits for replay with no ambient
default. C1 tests
configured limits and limit-plus-one. P1 includes any default input resource
ceilings proposed for deployment. Do not invoke getters or `toJSON`. Accepted
input is a detached validated JSON tree, not an arbitrary live JS object; proxies/host objects are outside that input contract.

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

Measure the reconstructed full and required-only requests. If required input
exceeds the ceiling, return `required_exceeds_ceiling`. If required fits and
optional content makes C2 exceed it, return `total_exceeds_ceiling` with the
exact accounting in §4. Equality fits. No trimming is performed in C2.

C3 reconstructs and remeasures after each whole optional-part removal, starting
with the largest numeric priority (lowest importance), ties by name descending.
Record the final inclusion set, `context_budget` omissions, and bound reduction;
include omission-marker bytes in measurement. If omission disclosure increases
the bound or violates the admitted monotonicity property, refuse as unsupported
rather than trusting subtraction. Never drop part of a JSON value, a required
part, or stable-prefix content. The source view/shared manifest remain intact;
only the request-specific effective view gains omissions.

### 5.5 Durable decision before dispatch

For fits, append one `inference.requested@2` containing the ledger, effective
view, complete evidence and terms. Append acceptance/persistence must succeed
before any token/cost state is folded, controller is registered or call starts.
Pass the exact sealed prepared request across `GatewayDecisionLayer` or the
generation boundary; forbid regeneration from mutable candidates or defaults.
Verify the coverage binding at composition and fail on drift before dispatch.

For overflow, append one runtime-only `context.refused@1` containing the refusal,
complete valid assembly evidence or invalid-input witness, and decision id.
This record retains ceiling, estimator, templates and excluded inputs even
though no `inference.requested` exists. It changes no inference reservation and
creates no controller or gateway call. Failure to persist the refusal is an
explicit persistence failure, not a silently recorded blocked outcome.

Proposed P2 follow-up is action `failed: context_overflow` for goal.frame and
cycle `blocked: context overflow` for frontier.weigh; user-visible disposition
remains an owner question. Its durable result references the refusal decision.
Index refusals separately, excluding refusal bookkeeping from new weighing
evidence. A repeated cycle with unchanged authorized inputs/policy reuses the
recorded refusal rather than appending forever. New recovery/escalation is not
a consequence of logging or of a Weft emission.

## 6. Failure, cancellation, concurrency, crash and replay

### 6.1 Failure

Malformed parts, unsafe totals, unsupported accounting/capacity, ledger mismatch
or over-budget input cannot reach dispatch. Append rejection/failure leaves no
new inference reservation, accepted ledger index or controller. A throwing
estimator also fails closed with an explicit accounting failure; do not hide it
as a successful measurement. Existing `no-swallowed-failures` remains enforced.

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
Cancellation cannot erase its ledger or evidence.

### 6.3 Concurrency

A window is per request, with no shared token pool or cross-request token
reservation. The pure assembler keeps no module state. Independent runtimes or
owners may assemble concurrently; one Loom instance preserves its existing
single-writer sequencing and at most one pending frontier weighing. Do not
invent simultaneous goal.frame/frontier.weigh dispatch contrary to that state
machine. Exercise supported overlapping work with distinct scopes/request ids,
different policies and inverse completion/cancellation order. Ledgers, detached
bodies and cost settlement must remain isolated. Durable stores keep their
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
any fold/dispatch. The current `FileJournal` alone is insufficient evidence.
C2 must either establish this guarantee in the journal boundary with fault tests
or refuse managed enforcement on an unsupported journal; never assume a flush.
Keep storage I/O in the journal, outside the pure assembler. A torn uncommitted
suffix is explicitly rejected/recovered by the journal protocol; never repair
a complete invalid record or delete an acknowledged decision. Flush/atomicity
support is a prerequisite for the crash guarantee, including power-loss claims.

Use deterministic decision ids bound to owner scope, logical attempt, captured
input digest and policy revision. Accepted decision ids are unique in the
durable log and its rebuilt index. A duplicate cannot overwrite an outcome,
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
- For refusals, crash before the subsequent action/cycle result reuses the
  recorded decision and finishes only its local disposition; no model call or
  second refusal is introduced. A fresh attempt requires explicit new inputs
  or the separately approved P2 policy.

### 6.6 Byte-for-byte replay

For every v2 decision, resolve and verify the full historical site assembly
policy, complete profile, serializer/validator, accounting algorithm and proof
bundle, budget/allowances, template bodies, substitutions, original terms,
pre-trim view/manifest and every part body from its evidence. Rebuild the exact
prepared request, effective view, ledger or refusal and compare canonical
`stableStringify` bytes and digests. Reproduce ordering and safe arithmetic.
Do not consult current defaults, templates, profiles, routes, model aliases,
source files or trimmed views to fill a historical hole.

Changed defaults/templates must not affect replay. Missing historical code,
proof, excluded bodies or valid snapshot data is an explicit replay failure,
even if the old request fits today's ceiling. Overflow replay uses the durable
refusal evidence; an invalid-input witness replays only its recorded rejection,
never authorizes execution. Historical v1 logs keep historical behavior without
invented ledgers. Replay invokes no gateway, capability, Weft port or recovery
effect. Recovery loads immutable decisions first and follows §6.5; it does not
rerun inference to reconstruct evidence.

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

### 6.9 Keys stay out of argv and logs

Ledger, refusal summaries and Weft fields contain only closed part names/codes,
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

## 8. Red-before-green acceptance plan

Every implementation child starts with its versioned contract and behavioral
checks, demonstrates an assertion failure at its base or against a deliberately
invalid implementation, then implements and proves green. A missing import or
type error alone is not demonstrated behavioral red. Validate tests against
mutations such as always-fit, body-sum-only, omitted evidence, downgrade-to-v1,
rebuild-at-dispatch and dispatch-before-persist. Reserve independent adversarial
and held-out cases before estimator comparisons; implementer cases are not the
sole quality evidence. No test threshold, permission or check is weakened.

| Test | Child and location                    | Required behavioral assertion before implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | C1, `context-budget.test.ts`          | Required input one over ceiling refuses with exact total/required/excess fields; exact equality fits. Placeholder always-fit fails.                                                                                                                                                                                                                                                                                                                                                                                                |
| T2   | C1/C2, same                           | Required fits but optional content makes total one over: `total_exceeds_ceiling`, exact `over_by_tokens = total - ceiling`; C2 never trims. Protected bodies/digests remain complete.                                                                                                                                                                                                                                                                                                                                              |
| T3   | C1/C2, accounting fixtures            | Complete wrapper-heavy request exceeds a budget that a leaf-body sum fits. Capture exact projected TypeSafe/OpenAI bodies; exercise escaping, long property names, many questions/slices, CJK, emoji, surrogate replacement, base64, empty framing, settings and permutations. Refuse an uncovered fallback, tokenizer revision or unproved allowance.                                                                                                                                                                             |
| T4   | C1/C2, pure validation                | Reject missing instructions/questions, protected relabeling, unknown/duplicate parts, wrong inventory, cyclic/BigInt/accessor/undefined/non-finite/deep/sparse bodies, negative/unsafe values and safe operands whose sum overflows. Assert closed invalid variant with absent invalid numbers, zero dispatch and no secret-bearing diagnostics.                                                                                                                                                                                   |
| T5   | C2, `context-budget-runtime.test.ts`  | Oversized goal.frame: zero fixture-adapter calls, no `inference.requested`, unchanged inference cost reservation; exactly one durable refusal with full evidence, referenced by the P2-approved disposition. HEAD currently dispatches.                                                                                                                                                                                                                                                                                            |
| T6   | C2, same                              | Oversized frontier.weigh: zero calls/reservations and one refusal; repeating unchanged cycles adds no refusals and does not spin due to its own bookkeeping.                                                                                                                                                                                                                                                                                                                                                                       |
| T7   | C2, same and `frontier-weigh.test.ts` | Fits: v2 admission succeeds; captured generation/evaluation request id, state/questions/instructions, terms and digest equal the prepared request. Force differing old hard-coded terms to detect rebuild/substitution by GatewayDecisionLayer; test retry/escalation coverage and actual AbortSignal forwarding.                                                                                                                                                                                                                  |
| T8   | C2, cancellation fixtures             | Already-aborted input, queued cancellation, cancellation after append before dispatch, during call and late completion. Assert no premature call, one settlement, correct controller cleanup and no progress by cancelled work. Overflow has no controller.                                                                                                                                                                                                                                                                        |
| T9   | C2, `w5-replay.test.ts` style         | Canonical bytes equal for fit, C3 excluded bodies and refusal replay after changing defaults, templates and profiles. Tampered/missing ledger, historical profile/algorithm/proof, excluded body or template fails; no external calls/emission. Fault immediately before/after durable append, after append before fold/call, after call before result and after result before fold; reload twice yields one decision and one settlement without redispatch. Include torn/ambiguous append and refusal-before-disposition crashes. |
| T10  | Every affected child, §7 fixtures     | Renderer/artifact digests plus actual direct and managed request/route/adapter equivalence, pricing and pacing. These baseline guards are green at base; add a mutation that leaks the guard into a direct route to show they detect it. Never change the pinned expected behavior.                                                                                                                                                                                                                                                |
| T11  | C2, validation/load tests             | Valid v2 admitted; unsupported per-type versions and new-write v1 downgrade rejected; historical v1 still replays. Reject falsified arithmetic/allowance, body/digest/manifest/request mismatch, excluded required slice, omitted instructions and tampered terms before durability. Unknown stored versions refuse before partial fold, even if flagged accepted.                                                                                                                                                                 |
| T12  | C3, pure/runtime tests                | Exact lowest-priority drop order and tie-break; required input remains, effective omission fields are measured and recorded, all new bytes counted, final fit exact. Always-trim-required/leaf-subtraction mutation fails.                                                                                                                                                                                                                                                                                                         |
| T13  | C3, view/replay tests                 | Original and effective views, original manifest and excluded bodies survive crash; only effective view has `context_budget` omissions. Another consumer of a shared slice assembly sees unchanged bytes.                                                                                                                                                                                                                                                                                                                           |
| T14  | C3, cache fixtures                    | Dropping an optional part cannot change stable prefix or hide a hit/reload change; cached tokens count toward window in full.                                                                                                                                                                                                                                                                                                                                                                                                      |
| T15  | C2, persistence fixtures              | Journal refusal, accepted-request append failure, full-record-too-large, torn tail, append-written-then-throws and result append failure all prevent unjournaled dispatch or double reservation. No in-memory accepted index advances before successful append. Known durable request is abandoned once, never resent.                                                                                                                                                                                                             |
| T16  | C2/C4, concurrency fixtures           | Supported overlapping independent requests with distinct ceilings and inverse completion/cancellation order retain isolated ledgers, bodies and budgets. Duplicate ids and second writers refuse; preserve one pending frontier weighing.                                                                                                                                                                                                                                                                                          |
| T17  | C4, per-owner tests in §10            | Each listed site exceeds its bound: zero calls/effects and durable refusal. Fit passes exact prepared payload and terms. Retry growth crosses ceiling only on the later attempt; no subsequent check grant is issued. Crash/cancel/append failure follows that owner's record, not Loom's two-site lifecycle.                                                                                                                                                                                                                      |
| T18  | C5, Weft tests                        | Missing, throwing, stalled, mutating and reentrant sinks leave decisions, schedule and budget identical; after-step emission only, replay emits nothing. Fit/refusal metrics match durable evidence; canary keys/bodies absent from argv and all diagnostic/Weft output.                                                                                                                                                                                                                                                           |
| T19  | C6, accounting/routing tests          | New schema distinguishes policy ceiling from tightened positive term; test exact zero/minimum, equality, safe arithmetic, smaller-route boundary, cached-token overflow, retry cost/output allowance, pricing and injected-time pacing. Loom reserves unchanged cost_ceiling; accept/failure/cancel/unknown usage/recovery settle once. Direct benchmark fixtures remain identical.                                                                                                                                                |
| T20  | C7, admission fixtures                | A calibrated but underbounding or uncovered estimator is refused. An admitted replacement proves full-input/framing and capacity bounds at just-fit/one-over, has independent held-out/adversarial evidence, and replays alongside old versions after defaults change. Missing historical version fails. Efficiency comparison follows soundness, never substitutes for it.                                                                                                                                                        |

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

## 9. Owner questions — genuine product forks only (ask-user)

These are listed for Benjamin; this plan-only revision does not ask for or infer
answers. Safety invariants and architecture above are fixed.

- **P1. Default ceilings and merge/hold policy.** Approve ceilings per inference
  kind (including proposed default input resource limits) and the treatment of
  existing fixtures that would refuse. C2 inventories every
  goal.frame/frontier.weigh fixture: total and required
  certified bounds, ceiling, excess, affected behavior and supported/unsupported
  contracts. C4 extends the inventory per site. Proposed merge criterion:
  enforcement lands only when applicable evidence is sound, all checks pass
  and every changed fixture consequence/default is approved. Otherwise hold
  enforcement (contract-only work may proceed). Present measured excesses and
  consequences before the decision; never silently raise limits or weaken tests.
- **P2. User-visible overflow recovery.** The oversized/unverifiable request
  never dispatches. Proposed follow-up: fail goal.frame and block frontier.weigh
  with a reference to the durable refusal. Owner alternatives are an operator
  clarification or a separately authorized and budgeted larger-window attempt.
  No automatic extra spend or recovery is implied by the fixed refusal rule.
- **P3. Audit fidelity.** May audit material ever be summarized? Until a separate
  summarization/disclosure policy is approved and validated with crash-safe
  evidence, retain all selected audit material as required. `compactContext`
  cannot silently replace that policy.
- **P4. Window-waste tolerance and C7 priority.** After sound accounting is
  established, choose acceptable unused capacity and whether to fund C7 early.
  Supply workload measurements, including route refusals and quality/cost
  consequences. A rough English overestimate is not a workload-wide guarantee,
  and accepting waste never authorizes an unsound estimator.

P5 is removed: R5 decides storage placement under D-ENG-021.

## 10. Child breakdown and ownership outside the runtime

| Child | Scope and first red evidence                                                                                                                                                                                                                                                                              | Depends on                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| C1    | Contract, complete data shapes/rejection variants and GLOSSARY additions; validate behavioral corpus T1–T4 against invalid placeholders. No implementation before observed red.                                                                                                                           | Implementation authorization                                                   |
| C2    | Certified accounting/capacity binding; historical snapshots and atomic journal prerequisites; type-specific v2 admission/load/replay; prepared handoff for goal.frame/frontier.weigh; T5–T11, T15–T16 and §7 guards. Inventory fixtures before enforcement. Hold uncovered routes, never assume evidence. | C1; P1/P2 for enforcement/disposition; sound accounting and journal guarantees |
| C3    | Optional priority removal on detached effective views; T12–T14 plus expanded T9, T10 and failure boundaries.                                                                                                                                                                                              | C2                                                                             |
| C4    | Per-site managed profiles, preparation and durable owner integration below; T17 and site-specific T8/T9/T15/T16; assembler-coverage check with red fixtures.                                                                                                                                              | C2; P1/P2 per site                                                             |
| C5    | Revised Weft contract for policy ceiling, request term, full/used/reduced bounds and refusal metrics/references; T18.                                                                                                                                                                                     | C2                                                                             |
| C6    | `context.ledger@2` and tightened token term only, leaving money reservations explicit; T19 plus T9–T11 and §7 guards.                                                                                                                                                                                     | C2                                                                             |
| C7    | More efficient certified accounting, possibly per-route, admitted with a proof rather than calibration alone; historical-version retention and T20.                                                                                                                                                       | C2; P4 prioritization                                                          |

C3–C5 can proceed independently after C2; C6/C7 can also be developed against
fixed C2 contracts with their schema dependencies declared. If C2 is split into
smaller PRs, each first establishes its contract and demonstrates behavioral
red for its own admission, accounting or persistence boundary before code.

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

Every row starts with red assertions for fit, excess, unavailable historical
evidence, append failure/ambiguity, crash before/after intent, cancellation and
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
  it reserves no inference budget and authorizes no recovery call.
- **Part class.** `required` or `optional`, derived from the trusted site/profile
  contract; only optional whole parts can be dropped by its deterministic policy.

Keep the existing terms **state view**, **context profile**, **slice assembly**,
**replay**, **recovery**, **prefix cache** and **disclosure class** with their
current meanings. Token ceilings and monetary reservations are distinct.

## 13. Assumptions, prerequisites and remaining uncertainty

- **A1 (unverified source).** The live #353 text is assumed to match the supplied
  brief; no remote issue read is claimed. D-ENG-021 is applied as instructed.
- **A2/A3 (removed unsafe assumptions).** No universal byte/token or fixed framing
  bound is assumed. C1/C2 must provide exact reconstruction, immutable coverage,
  sound bound evidence and adversarial boundary checks. An unproved route is
  unsupported; C7 calibration cannot repair a missing proof by itself.
- **A4 (blocking prerequisite).** Current `context_limit_tokens` lacks documented
  input-versus-total semantics. R7 decides the managed normalization contract.
  Concrete per-route capacity evidence is still required before a strict window
  safety claim; separate prerequisite work must preserve benchmark semantics.
- **A5 (measurement outstanding).** No fixture excess measurements have been run
  for this plan-only task. C2 inventories fixtures under the certified contracts,
  reports excesses/unsupported routes and applies P1's explicit merge/hold gate.
  Existing 8_000 defaults confer no evidence that any fixture fits.
- **A6 (durability prerequisite).** Existing `FileJournal` does not demonstrate
  atomic, flushed decision appends. C2 must establish/require that contract and
  fault-test it before claiming crash-safe byte-for-byte ledger replay. Missing
  journal guarantees or historical evidence block enforcement, not validation.
