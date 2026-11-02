# PLAN — strict pre-flight context budget assembler (#353)

Status: **plan only. Nothing is implemented until the captain says go.**
Issue: CrowBe/weave#353 (architecture parent). Branch `wv-353-context-budget-plan`, base `0281c5e`.

The issue text used here is the copy in the task brief. `gh issue view` was not
permitted in this session, so the live issue has not been checked against it.
That is recorded as assumption A1.

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
closed: nothing is reserved, nothing is dispatched, and the refusal is
recorded. Nothing is ever cut silently. Instructions, questions, authority,
goal and audit material are never dropped to make a request fit.

## 2. Inventory at HEAD (`0281c5e`)

### 2.1 The context window is declared, never measured

| Where | What it does today |
|---|---|
| `packages/gateway/src/types.ts:146` `InferenceTerms.max_context_tokens` | A caller-declared number. |
| `packages/gateway/src/gateway.ts:867` `invalidTerms` | Only checks `>= 1`. |
| `packages/gateway/src/routing.ts:220` `excludeReason` | Excludes a unit when `unit.context_limit_tokens < terms.max_context_tokens` (`context_limit_too_small`). It compares two declarations. |
| `packages/gateway/src/routing.ts:66` `worstCaseCost`, `:78` `priceAttempt` | Prices the cold window as `max_context_tokens` input tokens. The cost reservation therefore depends on the declaration being true. |
| `packages/gateway/src/gateway.ts:1011,1017,1036` pacing | Counts worst-case tokens as `max_context_tokens + max_output_tokens`. |
| `packages/gateway/src/types.ts:408` `ProviderUsage.input_tokens` | Reported after the call. Nothing compares it with `max_context_tokens`. |
| `packages/weave/src/runtime.ts:928` (frontier.weigh), `:1258` (goal.frame), `packages/weave/src/gateway-decision.ts:54` | All hard-code `max_context_tokens: 8_000`. Framing can override it through `RuntimeOptions.framingTerms` (`runtime.ts:120`). |

**Finding F1:** no code path compares the bytes or tokens actually sent
(`instructions` + `prompt`, or `state` + `questions`) with
`max_context_tokens`. A request can exceed the window it declared. Routing
then believes the declaration, and the cost reservation under-prices the
request.

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
- The gateway adds nothing itself (`types.ts:172`: "Content the caller has
  already filtered for disclosure").

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
- Replay re-renders the frame view with the recorded profile
  (`RuntimeOptions.frameProfile`, `runtime.ts:111-115`) and the recorded
  catalogue (`replayCatalogueIds`, `:1170`). It never reads today's defaults.
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

## 3. Decisions

Following D-ENG-021 as the brief describes it (the record itself is not in this
repository): architectural and code-health questions get a recommendation
here, and product forks stay open for Benjamin (§9).

**R1. Placement: in Loom, at the view-to-request boundary. The gateway's
default behaviour does not change.**
A new pure module, `packages/weave/src/context-budget.ts`, runs inside the
runtime's single-writer `step`, immediately before `appendInferenceRequested`.
The gateway keeps its contract: it imports nothing and adds no content.
Benchmarks call the gateway directly, so they cannot observe the assembler
(§7). A gateway-side measured check could only be opt-in, and it would
duplicate Loom's work. It is not part of this parent.

**R2. Estimator: an injected, versioned upper bound. Default `utf8_bytes@1`.**
`tokens_upper(part) = UTF-8 byte length of stableStringify(part)`. The
estimator is unit-independent, so assembly happens once, before routing, and
routing is unchanged.

Rejected alternatives:
- A character heuristic (chars/4). It is not an upper bound: it undercounts
  CJK, emoji, base64 and digests, so it could silently overflow. That violates
  the goal.
- A provider tokenizer on the core path. It couples Loom to one provider, and
  the routed unit is not known until after assembly.

Cost of the choice: `utf8_bytes@1` overcounts English roughly three to four
times, which wastes window. A calibrated estimator per routed unit is a later
child (C7) and needs evidence. The ledger always records `estimator`, so replay
uses the recorded version, never today's default. This mirrors `frameProfile`.

The soundness of this bound rests on assumption A2.

**R3. Who owns overflow policy: the context profile owns the order. Fail-closed
is core policy and is not configurable.**
The profile declares each part's class and priority. No configuration can
permit overflow. `budget.policy@1` stays a quota filter in the gateway. Mixing
the two would put content knowledge into a package that must not import Loom.
The link to cost is §6.4.

**R4. Prefix cache: no window discount.**
Cached tokens still occupy the routed unit's window. The ledger counts them in
full. The prefix cache stays a price term (`routing.ts:78-104`). Parts inside
`stablePrefixBytes` (profile, `prefix`, catalogue) are class `required` or are
trimmed only by the profile's own `catalogue_budget`. The ledger never drops
them, so a ledger drop never changes `prefix_digest` or turns a `hit` into a
`reload`.

**R5. Where the ledger is recorded: a sibling `context` field on
`inference.requested`, bumped to payload version 2. Not inside `StateView`.**
Keeping it out of `StateView` leaves the renderers' bytes unchanged, which
keeps benchmark cases, view digests and prefix digests stable. The ledger
refers to slices by `name` and `assembly_id`, so it extends the slice assembly
manifest without editing `ViewSliceManifest`.

This deliberately departs from the issue's "recorded in slice assembly
manifest". The captain should confirm or overrule it. If overruled, the
fallback is optional `tokens` on `ViewSliceManifest`, added only by the
assembler and never by renderers.

**R6. Smallest first: measure and fail closed. No trimming in the first
child.**
Priority-ordered dropping of optional slices (C3) comes after the gate is
green. That keeps the first change free of any trimming logic that could
remove something it should not.

## 4. Data shape (proposed; reuses existing types)

```ts
// packages/weave/src/context-budget.ts  (proposal — not written yet)
export const CONTEXT_LEDGER = 'context.ledger@1' as const;
export type ContextEstimatorId = 'utf8_bytes@1';            // closed set; adding one is a revision

export type PartClass = 'required' | 'optional';
export type PartSource = 'instructions' | 'questions' | 'slice';

export interface ContextPart {                               // input, built by the caller
  readonly name: string;                                     // slice name from the profile, or 'instructions' / 'questions'
  readonly source: PartSource;
  readonly class: PartClass;                                 // instructions, questions, goal, authority, audit: always 'required'
  readonly priority: number;                                 // profile-declared; ties broken by name
  readonly assembly_id?: string;                             // reuses ViewSliceManifest.assembly_id
  readonly body: unknown;                                    // exact value that will be serialized
}

export interface ContextBudget {                             // per inference kind, declared on the context profile
  readonly ceiling_tokens: number;                           // becomes terms.max_context_tokens
  readonly framing_allowance_tokens: number;                 // declared fixed headroom for wire framing (assumption A3)
  readonly estimator: ContextEstimatorId;
}

export interface ContextLedgerPart {                         // content-free: metric + reference only
  readonly name: string;
  readonly source: PartSource;
  readonly class: PartClass;
  readonly priority: number;
  readonly tokens: number;
  readonly included: boolean;                                // always true in C2; C3 may set false for 'optional'
  readonly digest: string;                                   // digest(stableStringify(body)) via existing digest.ts
  readonly assembly_id?: string;
}

export interface ContextLedger {
  readonly schema: typeof CONTEXT_LEDGER;
  readonly estimator: ContextEstimatorId;
  readonly reserved_tokens: number;                          // = ceiling_tokens
  readonly allowance_tokens: number;
  readonly used_tokens: number;                              // allowance + Σ included
  readonly truncated_tokens: number;                         // Σ excluded (0 in C2)
  readonly parts: readonly ContextLedgerPart[];              // priority order
}

export type ContextAssembly =
  | { readonly status: 'fits'; readonly ledger: ContextLedger; readonly included: readonly ContextPart[] }
  | { readonly status: 'overflow'; readonly overflow: ContextOverflow };

export interface ContextOverflow {                           // the over-budget failure record; content-free
  readonly schema: 'context.overflow@1';
  readonly reason: 'required_exceeds_ceiling' | 'invalid_budget' | 'invalid_part';
  readonly estimator: ContextEstimatorId;
  readonly ceiling_tokens: number;
  readonly required_tokens: number;
  readonly over_by_tokens: number;
  readonly parts: readonly ContextLedgerPart[];
}

export function assembleContext(parts: readonly ContextPart[], budget: ContextBudget): ContextAssembly;
```

Reuse and changes:

- `InferenceRequestedPayload` (`types.ts:237`) gains `context: ContextLedger`,
  required at `payload_version: 2`. Version 1 stays readable for replay of
  older logs. That is versioned history, not a compatibility layer.
- `validateInferenceRequested` (`validation.ts:653`) gains three checks at v2:
  - closed ledger shape;
  - `context.reserved_tokens === terms.max_context_tokens`;
  - `context.used_tokens <= context.reserved_tokens`, and no `required` part
    with `included: false`.
  A journaled request that claims to overflow, or that dropped required text,
  is therefore rejected before it becomes durable.
- `FrameProfile` (`views.ts:19`) gains an optional `context?: ContextBudget`
  and an optional per-slice `{class, priority}` map. When absent, `required`
  is the default, the safe direction. The weigh view gets a profile record
  for the first time (C4). The `WEIGH_PROFILE` id stays the same until its
  shape changes.
- C3 adds the omission reason `context_budget` to the open `ViewOmission.reason`
  string, with no type change.
- New `CycleOutcome` blocked reason: `context overflow`. New action failure:
  `context_overflow`.

## 5. Behaviour

1. The caller builds the parts:
   - `instructions` (required, priority 0);
   - `questions` (required, priority 0);
   - one part per view slice, in profile order, using the view's existing
     content keys. Goal, authority, budget, iteration and every audit slice are
     `required`.
2. `assembleContext` validates the budget (positive safe integers, known
   estimator) and the parts (unique names, no `required` part missing). Any
   failure is `invalid_budget` or `invalid_part`, which is fail-closed and
   never repaired.
3. It measures each part. `required_tokens = allowance + Σ required`. If
   `required_tokens > ceiling_tokens`, the result is `overflow /
   required_exceeds_ceiling`.
4. C2: if the total is still over the ceiling, also `overflow`. C3: drop
   `optional` parts lowest-priority-first (ties by name, descending) until the
   total fits. Each dropped part is recorded as `included: false` and added to
   `truncated_tokens`, and the slice is marked `truncated: true` with reason
   `context_budget`. Dropping is per whole part, never a cut mid-value
   (consistent with `log-bound.ts`).
5. On `fits`, the runtime appends `inference.requested@2` with the ledger and
   `terms.max_context_tokens = ceiling_tokens`, then dispatches exactly the
   included parts. The dispatched `prompt` or `state` is built from the
   `included` array, so what was measured is what is sent.
6. On `overflow`:
   - goal.frame: the action is recorded `failed: context_overflow`. This is
     durable through the existing action result path.
   - frontier.weigh: the cycle is `blocked: context overflow`, following the
     `cost budget exhausted` precedent (`runtime.ts:908-913`).
   - In both cases there is no `inference.requested`, no reservation, no
     `inferAbort` controller and no gateway call.
   - A Weft emission carrying `context.overflow@1` is C5. Weft is
     observational and never feeds back.

## 6. Failure, cancellation, concurrency, crash and replay

### 6.1 Failure
Every error path fails closed (§5.2, §5.6). The assembler throws nothing to its
caller: invalid input is a typed `overflow` result, so a bug cannot fall through
to dispatch. That keeps `checks/no-swallowed-failures.mjs` meaningful: no
`catch` that turns into "fits".

### 6.2 Cancellation
Assembly is synchronous and finishes before any `AbortController` is created
(`runtime.ts:1288`). A cancel that arrives before assembly finds nothing to
cancel. A cancel after `fits` follows the existing gateway path unchanged. An
overflow never registers a controller, which test T8 checks.

### 6.3 Concurrency
A context window is per request, unlike spend, so there is **no shared token
pool** and no cross-request reservation. Concurrent goal.frame and
frontier.weigh requests in one cycle each get their own ledger. The assembler
is pure, keeps no module state, and runs inside the runtime's single-writer
`step`.

### 6.4 Link to cost
In C2 the ceiling stays the declared term. Enforcement makes the existing
cold-window reservation (`worstCaseCost`) honest for the first time: input can
no longer exceed it.

Child C6 (recommended) tightens `terms.max_context_tokens` to `used_tokens`.
Doing so:
- shrinks the cost reservation;
- lets routing admit smaller-window units (`context_limit_too_small` becomes
  truthful).

C6 changes routing outcomes, so it gets its own red tests.

### 6.5 Crash and recovery
The ledger is written inside `inference.requested@2`, which is journaled before
dispatch. A crash before the append leaves no request and no reservation, and
the next cycle re-assembles from current state. A crash after the append is
handled by the existing recovery rule: abandoned, with no repeated dispatch.
The journal holds one ledger per request id, so assembly is never duplicated
and never lost.

### 6.6 Replay
Replay re-runs `assembleContext` with three recorded inputs:
- the recorded profile (with its budget);
- the recorded estimator id;
- the recorded state.

It must reproduce the ledger byte for byte. A mismatch, or a v2 request with no
ledger, is a replay failure, never permission to proceed (GLOSSARY "Replay").
An overflow decision is a pure function of recorded inputs, so it replays
identically without its own record.

### 6.7 Grants
The assembler issues, consumes and renews **no grant**. Inference on these paths
carries no execution grant. The implementation step's fresh single-use grant
per check (`implement-step.ts:155`, `EqualGrantIssuer`) is untouched. When C4
wires the implementation step, an overflow happens before any grant is
requested, so no grant is minted and wasted.

### 6.8 No ambient clock, entropy or environment
The assembler takes no time, randomness or environment. `checks/no-ambient-clock`,
`no-ambient-entropy` and `no-ambient-env` cover the new file automatically.

### 6.9 Keys stay out of argv and logs
Ledger and overflow records are content-free: names, counts and digests only,
with disclosure classes `metric` and `reference`. They never contain part
bodies, so credentials cannot leak through them. The gateway's credential
screen is unchanged. Part names come from profile slice names, a closed
vocabulary, never from content.

## 7. Guardrails must not leak into benchmark routes

1. No default gateway change in any child of this parent. Benchmark gateways
   (§2.6) see identical routing, pricing, pacing, `uncertainty` strings and
   outcomes.
2. Renderers stay byte-identical. The ledger lives beside the view (R5), so
   `renderWeighView`, `renderFrameView` and `assembleAuditState` output, and
   therefore `benchmarks/frontier-weigh/build.ts` cases, do not change.
3. The assembler is deterministic and does no ordering by entropy. It never
   touches `shuffle` or permutation order. Reference-mode corpus and plan
   hashes are unchanged.
4. Test T10 (below) pins renderer output digests for fixed fixtures. CI also
   runs `node --test scripts/benchmark-digests.test.mjs`, `npm run test:jev`,
   `npm run test:frontier-weigh` and `npm run test:decision-sites`.
5. If a later child ever needs the gate inside the gateway, it must be an
   explicit opt-in field that is absent from every benchmark's terms, and a
   test must assert that it is absent.

## 8. Red-before-green test plan (C1/C2)

Each test is written first and shown failing at HEAD, or against a placeholder
`assembleContext` that always returns `fits`, before any implementation.

| # | File (new or extended) | Behaviour | Red at HEAD because |
|---|---|---|---|
| T1 | `packages/weave/test/context-budget.test.ts` | Required parts over the ceiling → `overflow / required_exceeds_ceiling` with exact `required_tokens` and `over_by_tokens` | The placeholder returns `fits` |
| T2 | same | No silent drop: with optional parts present and required parts fitting, every `required` part is `included: true` and its digest equals `digest(body)`. In C2, a total over the ceiling is `overflow`, never a trim | Placeholder |
| T3 | same | `utf8_bytes@1`: ASCII, CJK, emoji, a lone surrogate (replacement character), base64 and digest fixtures. The estimate equals UTF-8 bytes of `stableStringify`. Adversarial strings are listed in the test | Placeholder |
| T4 | same | Invalid budget (0, negative, unsafe, unknown estimator) or duplicate part names → fail-closed `invalid_*`; never `fits` | Placeholder |
| T5 | `packages/weave/test/m2.test.ts` (or a new `context-budget-runtime.test.ts`) | goal.frame with `framingTerms.max_context_tokens` smaller than the canonical bytes of instructions plus view: **zero** fixture-adapter calls, no `inference.requested`, `budget.cost.reserved` unchanged, action `failed: context_overflow` | **HEAD dispatches the oversized request (F1)** |
| T6 | same | frontier.weigh over budget: cycle `blocked: context overflow`, no request appended, no gateway call | HEAD dispatches |
| T7 | same | Within budget: `inference.requested@2` carries a ledger with `used_tokens <= reserved_tokens === terms.max_context_tokens`. The dispatched prompt equals the serialization of the included parts | No ledger at HEAD |
| T8 | same | An overflow registers no `inferAbort` entry. Cancelling afterwards is a no-op | — |
| T9 | `packages/weave/test/w5-replay.test.ts` style | Replay reproduces the ledger byte for byte. A tampered recorded ledger, or a v2 request without one, fails replay | No ledger at HEAD |
| T10 | `packages/weave/test/m6-views.test.ts` | Renderer output digests for fixed fixtures are unchanged (benchmark non-leak, §7) | Green at HEAD by design: this is a guard, not a red test |
| T11 | validation unit test | `inference.requested@2` with `used > reserved`, a `required` part excluded, or `reserved !== terms.max_context_tokens` → rejected before it is durable | No v2 at HEAD |

C3 adds:
- T12: optional parts are dropped in exact priority order, ties by name.
- T13: the manifest records `truncated: true` and reason `context_budget`.
- T14: a dropped part never sits inside `stablePrefixBytes`, so
  `prefix_digest` is unchanged.

Green means:
- the narrow file first (`npm run build && node --test packages/weave/dist/test/context-budget.test.js`);
- then `npm run check`, `npm run test:checks`, `npm test`;
- then the benchmark set in §7.4;
- then `npm run verify`.

**Making a repeated finding a check:** the `8_000` literal recurs in three
places (§2.1), and every new inference site is a chance to skip the gate. Two
measures close that class:
- validation requires the v2 ledger (T11);
- child C4 adds `checks/inference-through-assembler.mjs`, which flags
  `.generate(` and `.evaluate(` calls in `packages/weave/src` that are not on
  an allowlist of assembler-wired call sites.

## 9. Open product forks (for Benjamin — not decided here)

- **P1. Default ceilings per inference kind.** Today 8_000 is hard-coded. How
  much window each kind may spend is a cost and quality appetite.
- **P2. What follows an overflow.** Options:
  - fail the action (the plan's default);
  - also raise an operator clarification ("narrow the goal's sources");
  - permit escalation to a larger-window routed unit (more spend).
  Fail-closed is fixed either way. P2 is only about the next step.
- **P3. May audit material ever be summarized to fit?** It would go through
  `compactContext`, disclosed, with crash-safe persistence. The plan's default
  is never: audit slices are `required`.
- **P4. Window-waste tolerance.** Accept roughly 3–4× over-estimation from
  `utf8_bytes@1` until C7 brings calibrated estimators, or fund C7 early. The
  architectural recommendation (R2) stands either way. The spend trade-off is
  a product call.
- **P5. The R5 departure.** The ledger sits beside the view, not inside the
  slice assembly manifest. Recommended for benchmark stability; confirm.

## 10. Child breakdown

| Child | Scope | Depends on |
|---|---|---|
| C1 | Contract: `packages/weave/src/CONTEXT-BUDGET-CONTRACT.md` (inputs, outputs, invariants, failures, no effects) plus tests T1–T4 against a placeholder (demonstrated red) | go |
| C2 | Implement `assembleContext` (measure and fail closed only). `inference.requested@2` plus validation. Wire goal.frame and frontier.weigh. T5–T11 | C1 |
| C3 | Priority fill: drop optional slices by profile priority; omission reason `context_budget`. T12–T14 | C2 |
| C4 | Profile updates per kind: weigh profile record; audit-loop generate; implement-step (including `feedbackPrompt` growth); task validation and criteria gate; input routing. `checks/inference-through-assembler.mjs` | C2; P1 |
| C5 | Metrics: reserved vs used vs truncated through a Weft contract revision (metric and reference fields only); `context.overflow@1` emission | C2 |
| C6 | Tight terms: `max_context_tokens := used_tokens`, linking to cost reservation and routing | C2; separate red tests |
| C7 | Calibrated per-unit estimators, admitted only with evidence; `ContextEstimatorId` revision | C2; P4 |

C3, C4 and C5 are independent once C2 lands and can run in parallel.

## 11. AGENTS.md conformance

- **Runtime independent of model and provider:** the estimator is unit-independent (R2), and the gateway is untouched (R1).
- **Model output as observation:** not affected. The assembler reads no model output.
- **Deterministic policy separate from judgment:** fail-closed is core policy (R3). No judgment site decides fitting.
- **Explicit transitions and evidence:** the ledger is in a durable record (R5). An overflow is a recorded action failure, or a re-derivable blocked cycle (§5.6).
- **Parallelism:** children C3–C5 are independent. Per-request ledgers have no shared pool (§6.3).
- **Fabric untouched:** nothing here touches `packages/agentfabric`.
- **Compose before creating a primitive:** reuses `ViewSliceManifest`, `assembly_id`, `digest`, `stableStringify`, `InferenceRequestedPayload` and `FrameProfile`. The new module is one pure function.
- **Contract first, then red, then green:** C1 is contract and red tests only (§8).
- **Separate gates:** no grant involvement (§6.7).
- **Small core:** about one module and two record revisions. Per-kind behaviour lives in profile records.
- **Permissions and validation not weakened:** validation is tightened (T11).

## 12. New terms for GLOSSARY.md (added in C1/C2, not in this task)

- **Context ledger.** `context.ledger@1`: the pre-flight record of one
  inference request's input parts (instructions, questions and view slices):
  class, priority, estimated tokens, inclusion and digest, against the reserved
  ceiling. It is content-free and recorded in `inference.requested`. It
  measures disclosure. It does not grant it.
- **Context estimator.** A versioned, injected function from a part to an upper
  bound on tokens (`utf8_bytes@1` first). Replay uses the recorded version.
- **Context overflow.** `context.overflow@1`: the fail-closed refusal when the
  required parts exceed the ceiling, or the budget or parts are invalid.
  Nothing is reserved or dispatched. It is never repaired by cutting required
  text.
- **Part class.** `required` or `optional`, declared by the context profile.
  Only optional parts may be dropped, whole, in priority order.

Language note: the ledger covers the whole request input. Keep saying **state
view**, not _context_ or _prompt_, for what a judgment site receives.

## 13. Assumptions and remaining uncertainty

- **A1.** The live #353 body matches the brief. It was not checked (`gh` not
  permitted in this session). D-ENG-021 is not in the repository and was
  applied as the brief describes it.
- **A2.** Every tokenizer behind a routed unit emits at most one token per
  UTF-8 byte of serialized text, plus bounded framing. This holds for
  byte-level BPE and byte-fallback SentencePiece. It cannot be verified in this
  repository. C7's calibration must test it per unit.
- **A3.** Wire-profile framing (role markers, JSON envelopes) fits within a
  declared `framing_allowance_tokens`. The value is to be set in C2 from the
  wire profiles' fixed overhead, and recorded.
- **A4.** It is unknown whether `context_limit_tokens` (`types.ts:383`) counts
  input only or input plus output. Routing currently compares it with input
  only. Recommendation (code health, separate issue): make it explicit and, if
  it is a total, compare against `max_context_tokens + max_output_tokens`. That
  changes routing, so it stays out of this parent and away from benchmark
  routes.
- **A5.** Current fixtures may already exceed the 8_000 byte bound under
  `utf8_bytes@1`. C2 measures every existing goal.frame and frontier.weigh
  fixture first. If any exceed it, that is reported to Benjamin (P1) before
  enforcement lands, not hidden by raising a ceiling.
