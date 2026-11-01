# WV-195 — Gauge G7 failure attribution

Planning deliverable only for [#195](https://github.com/CrowBe/weave/issues/195),
part of [Gauge #182](https://github.com/CrowBe/weave/issues/182). This commit
adds only this file. Implementation, tests, schemas and glossary edits belong
to the later slices below. No live benchmark or hosted inference is requested
or performed by this planning task.

## Verified baseline and dependencies

Inspected on 2026-11-01 at
`e35767b74a0118bf7e806747e4ae89bdb9053d06`, also the GitHub `main` head and
local `origin/main` observed for this task. The local `main` ref is older
(`74683ef7896512701dd3e4c8fd75d16959877ef1`); both prerequisites are ancestors
of that ref too. GitHub reports both PRs merged with base `main`, and local
`git merge-base --is-ancestor` checks confirm their presence:

| Prerequisite | Evidence on main | Contracts and tests inspected |
| --- | --- | --- |
| [G4 #192](https://github.com/CrowBe/weave/issues/192) | [PR #282](https://github.com/CrowBe/weave/pull/282), merge [3485743994287c507987974507937072b85cb8ea](https://github.com/CrowBe/weave/commit/3485743994287c507987974507937072b85cb8ea) | `packages/gauge/src/types.ts`, `GAUGE-CONTRACT.md`, `validate.ts`, `produce.ts`; `packages/gauge/test/info.test.ts`; `benchmarks/decision-sites/{gauge,weft,recorded.test}.ts` |
| [Weft W5 #187](https://github.com/CrowBe/weave/issues/187) | [PR #266](https://github.com/CrowBe/weave/pull/266), merge [2088695ff172d598f61d641dcf6a255831cd968c](https://github.com/CrowBe/weave/commit/2088695ff172d598f61d641dcf6a255831cd968c) | `packages/{weave,gateway,agentfabric}/src/weft.ts`, each package's own `WeftPort`; `packages/weft/src/{types.ts,WEFT-CONTRACT.md,sink.ts}`; `packages/weave/test/w5-{trace,replay,isolation,authority,records,perf}.test.ts` |

These are fulfilled dependencies, not work to recreate. G4 reports are
`InfoResult` (`gauge.result@2`); they cannot be attributed. W5 is a lossy,
non-authoritative projection, delivered after transitions. Neither implies
that a classifier or a complete causal evidence bundle already exists.

## Existing inventory and boundaries

Read `VISION.md`, `GLOSSARY.md`, `AGENTS.md`, and current source and behavioral
tests before selecting these seams. Existing symbols below are current;
files explicitly marked **new** in later sections are proposals.

| Existing seam | Exact owner and intended reuse |
| --- | --- |
| Attribution and evaluation contracts | `packages/gauge/src/types.ts`: `FailureAttribution`, `AttributionCategory`, `EvidenceRef`, `EvaluationResult`, `Context`, `CaseSet`, `Revision`, `CriteriaSet`, `InfoCriteriaSet`, `InfoResult`, `Produced`. `packages/gauge/src/validate.ts`: public `validate`, private `validateAttribution` and `SIGNALS`. `packages/gauge/src/index.ts` currently exports no attribution producer/classifier. |
| Attribution rules already enforced | `packages/gauge/src/GAUGE-CONTRACT.md`, section `gauge.attribution@1`; `packages/gauge/test/{contract,validate,governance,info}.test.ts` and `packages/gauge/fixtures/records.json`. The validator checks shape/binding, not the truth of a cited cause or case membership in external evidence. |
| Evaluation/report production | `packages/gauge/src/produce.ts`: `evaluate`, `evaluateInfo`; `stats.ts` supplies deterministic aggregation/interval machinery; `digest.ts`: `recordDigest`. `benchmarks/decision-sites/gauge.ts`: `gaugeContext`, `scoreReport`, `reported`; `weft.ts`: `attemptRecords`; `recorded.test.ts` proves exact report parity, read-only replay and concurrent scoring. |
| Weft evidence | `packages/weft/src/types.ts`: `WeftRecord`, `KindFields`, `Evidence`, `Link`, `Candidate`, `Exclusion`; `validate.ts`: `validateRecord`; `serialize.ts`: `serializeRecord`. Public package entry points are `@weave/weft` and `@weave/weft/sqlite`, not relative imports into internals. |
| Durable Weft intake | `packages/weft/src/sqlite.ts`: `TraceStore`, `openTraceStore`, `importRecords`, `importJsonl`, transactional identity/conflict handling. `packages/weft/test/sqlite.test.ts` covers torn lines, cancellation, concurrent connections, rollback, durable reopen and process death. This store accepts Weft/legacy trace records, not Gauge attribution records. |
| Durable benchmark receipts | `benchmarks/decision-sites/journal.ts`: `Journal`, `acquireLock`, `replayKey`, `ledger`; `engine.ts`: `execute`. `harness.test.ts`, `engine.test.ts` and `recorded.test.ts` cover fsync, locks, receipt binding, cancellation and uncertain spend. Keep these leaf-owned; Gauge must not import this benchmark. |
| Authoritative check and runtime evidence | `packages/weave/src/implement-step.ts`: `CheckEvidence`, `AttemptRecord`, `FileAttemptJournal`, `replayImplementationStep`, `createEqualGrantIssuer`. `packages/weave/src/journal.ts`: `ObservationJournal`, `FileJournal`. `packages/weave/src/types.ts`: `CrystallizationSearch` (`matches`, `compositions`, `informed_by`); `scheduler.ts`: `select`. These are producer inputs translated at composition, never Gauge dependencies. |
| Routing and authority | `packages/gateway/src/routing.ts`: `route`, `RoutingDecision`, `RouteExclusion`; `packages/agentsop/src/grants.ts`: `GrantAuthority`, `createGrantAuthority`, `markInvoked`; `packages/agentfabric/src/store.ts`: `FabricStore`. Use recorded policy/authority decisions, never rerun an effect to explain a failure. |

Gauge depends only on Weft's public contract. Loom remains independent of any
model, provider or tool protocol; Fabric remains bounded and imports no Loom
runtime or scheduling concerns. `checks/import-direction.mjs` enforces those
directions. Keep the runtime and gateway control logic pure: injected ports,
explicit observations and deterministic policy; filesystem, network, clocks,
credentials and inference dispatch stay at existing host/adapter/composition
boundaries. Gauge's classifier must be a pure transformation too.

## Contract before implementation: record and evidence

The requested conceptual category set is exactly `capability | implementation |
routing | orchestration | unattributed`. Map conceptual `capability` to the
existing wire value `capability_gap`; every other value maps identically.
Do not silently rename `AttributionCategory`, accept a second spelling on the
wire, or revise `gauge.attribution@1`. Use the glossary term **capability gap**.

Reuse `FailureAttribution` unchanged:

| Field | Contract for G7 production |
| --- | --- |
| `schema`, `attribution` | `gauge.attribution@1`; stable caller-supplied id bound to result, case, evidence digest and classifier revision. No ambient time or random id generation in Gauge. |
| `result`, `case` | Known, valid `EvaluationResult` on `tune`; additionally verify case membership and an observed failed case under that result's governed criteria. Aggregate `misses_bar` alone does not identify a failed case. A case failure can exist inside an aggregate `meets_bar` result. Unknown, unfinished or cancelled-without-a-failure cases cannot be invented as failures. |
| `category` | Existing `AttributionCategory` values with the conceptual mapping above. One claim per failed case for the initial version. |
| `basis`, `signal` | `deterministic` with a category-specific closed signal; `judgment` with null signal means probabilistic inference; `none` with null signal only for `unattributed`. |
| `confidence` | Null for deterministic and unattributed; finite [0,1] for judgment. Preserve reported confidence as a provider statistic, distinct from class probability, model quality, calibration and authority. Missing confidence cannot become 1. |
| `evidence` | Existing `EvidenceRef[]`, unique `(source, ref)`, maximum 64. Cite Weft records/spans and check receipts, including contrary evidence. Require evidence for every attributed claim; retain diagnostic evidence for abstentions where available. |

The record itself is the structured claim; render an explanation from its
category, basis, signal and resolved citations. There is no existing free-text
`claim` field and the exact-key validator forbids adding one. Optional model
rationale stays in a bounded, access-controlled judgment receipt referenced as
evidence, never an extra attribution key or trusted instruction.

Compose an evidence resolver outside Gauge. Gauge receives immutable validated
Weft records and bounded normalized check/search/route/schedule facts, not host
objects. The resolver maintains opaque, credential-screened ids that resolve:

- `EvidenceRef {source: weft_trace, ref}` to an exact `(trace_id, record_id)`
  and content digest in an immutable Weft snapshot, not merely an entire run;
- `source: check` to a receipt bound to case, contract/implementation revision,
  invocation id, check revision and producing attempt (including recorded exit
  and `passed` from `CheckEvidence` where applicable);
- `source: observation` to a recorded search, policy, judgment or scheduling
  observation, with source revision and digest. A model-authored assertion of
  an effect violation is not a deterministic check receipt.

Refs must fit Gauge/Weft id rules; do not concatenate unbounded paths, URLs or
raw text into ids. Reject dangling refs, wrong trace/case/attempt, stale
revisions, conflicting identities, malformed confidence and invalid evidence.
Preserve omissions explicitly. Unavailable or incomplete evidence yields
`unattributed`, while malformed envelopes/bindings are typed producer errors.
Neither is a successful attribution. `validate` remains the final record gate;
the producer's evidence checks supplement it, never weaken it.

Have the pure decision step return the selected category, basis, signal,
confidence and evidence before result binding. The tune-only producer binds
that decision into `FailureAttribution` and validates it. The isolated holdout
evaluator can score the same decision step without creating forbidden holdout
attribution records. This is one decision implementation with two consumers,
not a second record schema or a bypass of `validate`.

## Deterministic signals first

Inspect all applicable deterministic evidence before asking for inference.
Use causal `parent_id`/`links` and recorded revisions, never arrival order,
wall-clock proximity or a fluent explanation. A downstream failure does not
prove its upstream cause. Conflicting plausible categories have no arbitrary
priority; keep the conflict available for bounded judgment or abstention.

| Category | Required positive evidence and existing signals | Counterexample that must not trigger it |
| --- | --- | --- |
| Capability (`capability_gap`) | `no_contract_matched`: a complete, revision-bound search over the relevant authorized catalogue and compositions found no fitting contract for the required operation. | Empty top-k retrieval, a failed semantic guess, unavailable catalogue, revoked implementation or missing grant. `CrystallizationSearch` informed by inference is not deterministic proof of semantic absence. |
| Implementation | A matching contract/selected implementation is established, and bound checks/effects show `contract_tests_failed`, `effect_violation` or `implementation_failed`. | Transport failure, legitimate permission refusal, failed unrelated tests, cancelled check, or uncertain effect. A generic `capability.invoked.status = failed` alone is insufficient. |
| Routing | `wrong_contract_selected` or `better_route_excluded`: recorded selection was wrong while an independently established fitting alternative was available and policy-eligible at that decision revision. Preserve route table/preferences, availability, terms and policy revisions plus comparative check evidence. | Cheaper is not necessarily better. A route legitimately excluded by privacy, quality, credential screening, budget, context or permissions is not a routing defect. Later success on another input is not an available counterfactual. |
| Orchestration | `dependency_failed`, `schedule_conflict`, `budget_exhausted` or `superseded` caused the recorded failed outcome under the declared contract. Bind prerequisite results, scheduler dispositions and terminal observations. | Normal conflict deferral, an action still waiting, lawful budget refusal, requested cancellation or supersession alone does not establish a defect. Classify the evidenced failure mechanism, not blame for enforcing policy. |

Reuse Weft `capability.invoked`, `capability.lifecycle`, `route.selected`,
`inference.attempt`, `cycle.weighed`, `action.transition`, `thread.transition`,
`outcome`, `error`, and links such as `retry_of`, `joins`, `cancels` and
`supersedes`. `route.selected.excluded` is bounded, not an exhaustive eligible
alternative inventory; Weft has no search-completeness kind or detailed check
result kind. Supply those facts as cited check/observation evidence at the
consumer. Do not invent new Weft kinds merely to avoid reading existing
receipts. Generic OTLP spans with missing causal facts cannot earn a category
by inference from their timestamps.

Only inconclusive deterministic analysis may request a probabilistic judgment.
The composition root invokes an injected bounded judgment function and feeds
its recorded answer into a pure Gauge finalizer; Gauge imports no
gateway/provider and dispatches nothing itself. The composition root supplies the routed unit,
request/response receipt, allowed destinations, budget, cancellation and any
retry policy. Send only the permitted evidence view and category definitions,
never labels. Validate the returned category, citations and confidence; an
agreed threshold is fixed on development evidence before evaluation. Missing,
malformed, low-confidence, unavailable, contradictory or cancelled judgments
abstain. Never let judgment override decisive checks, policy, a failed
validation, admission or authority. Record rejected proposals privately as
observations; accepted probabilistic claims use `basis: judgment`.

## Labelled set, demonstrated red and reporting

Build and freeze the acceptance labelled set **before writing the classifier**.
Proposed leaf: **new** `benchmarks/failure-attribution/`. Start with four
independent scenarios per category (including `unattributed`) and eight
ambiguous/adversarial scenarios: 28 minimum, with multiple signal variants and
negative controls. Ambiguous is a case annotation, not a sixth category; its
expected output is `unattributed` unless the independent rubric identifies one
supported cause. Include independently reviewed recorded failures or cases
authored by an owner/reviewer other than the classifier implementer; synthetic
cases authored solely by that implementer are insufficient quality evidence.
If that independent evidence is unavailable, report the limitation and defer
the quality conclusion, rather than substituting self-authored labels.

Each case carries an opaque id, scenario family, source snapshot/digests,
provenance and license status, evidence permissions, failure criterion,
expected conceptual/wire category, acceptable signal or abstention, and the
independent label rationale. Resolve label disagreements before freezing;
retain uncertainty as an ambiguous case. Strip expected labels/rationales
from classifier inputs. Reserve cancellation, causal-order permutations,
missing spans, policy exclusions and prompt-injection cases in that freeze.

The entire acceptance set is held out from prompt, rule, threshold and model
tuning. Use a separate scenario-disjoint development set, with governed
`CaseSet`/`Revision` digests and an access-controlled label file. Independence
is by scenario/source lineage, not a random row split of similar examples.
Add a loader check preventing tune/acceptance overlap. The classifier developer
does not read acceptance labels or per-case evaluation diagnostics. An
independent evaluator runs the frozen oracle. Changes prompted by aggregate
acceptance results require a fresh independently frozen holdout for the next
quality claim; never tune repeatedly against the same holdout.

Before classifier generation, run the frozen harness against an always
`unattributed` placeholder and deliberately wrong category/citation/confidence
controls. Save nonzero exits and the intended assertion failures, corpus and
harness revisions/digests and reviewer validation. Loader failures, missing
exports or skipped tests are not demonstrated red. The evaluator can retain
this private transcript while publishing only the red outcome and aggregate
baseline; it need not expose labels to the implementer. Validate positive
controls so a test that always fails cannot pass admission. The slices below
repeat red for their particular behavior, before implementation.

Report a five-by-five confusion matrix and, for **every** category including
`unattributed`, TP, FP, FN, support, predicted count, precision
`TP / (TP + FP)` and recall `TP / (TP + FN)`. A zero denominator is null with
its count, never 0 or 1. Also report macro precision/recall over defined
categories (with number defined), total coverage/abstention, ambiguous-case
abstention rate, errors by deterministic/judgment path, and rejected/incomplete
cases. Wrong predictions against an attributed label remain false negatives
when the classifier abstains; exclude nothing silently. Supply sample counts
for each rate; describe the small set as characterization, not proof of
general accuracy or calibrated confidence. `InfoResult` has no intervals and
Gauge's statistics module is internal: do not invent intervals in @2 records
or import that module from the benchmark. Record classifier/rule/prompt/model
and corpus revisions, evaluation mode, seeds and evidence digests.

Preserve current holdout protection: no `FailureAttribution` may name a holdout
case, even in a private store. The isolated evaluator retains bounded raw
decisions/receipts under holdout access controls, scores against sealed labels,
and publishes only a `held_out_report` ref and aggregate measures. Use
`evaluateInfo`/`InfoResult` for descriptive precision/recall reporting, with
declared empty values; info-only results still cannot be attributed, gated or
routed. A later quality gate needs its own governed `CriteriaSet` @1, not a
reinterpretation of G4's reports. Development failures that receive records
bind to ordinary tune `EvaluationResult` @1 with check evidence. Do not relabel
the acceptance set as tune just to serialize per-case attributions.

## Failure, cancellation, durability and concurrency

W5 sink delivery is best effort, not an exactly-once durable journal. A thrown,
slow, rejecting, hanging or re-entrant sink must still leave execution unchanged.
No-port runs stay unchanged too. Missing Weft records cannot become evidence
of no capability or a scheduling defect. Keep runtime recovery on the
observation log and host store; attribution never drives recovery.

Use the existing leaf `Journal`/`acquireLock` receipt pattern for G7's offline
evaluation artifacts (importing from a sibling leaf is allowed; no new generic
journal primitive). Give each output one writer, retain fsync and durable
intent-before-dispatch, receipt-before-report ordering, and build deterministic
attribution/report output from committed receipts. Bind replay keys to case
evidence, classifier/prompt/model and policy revisions as well as request
bytes. Same key and same content is idempotent; same identity with different
content fails closed rather than silently replacing a claim. Add that check
at this consumer; `Journal.append` itself is not a uniqueness validator.

Cover crashes before intent, after intent but before dispatch/receipt, after
receipt before derived attribution, and after attribution before aggregate
report publication. Committed receipts and claims survive process death
without duplication or loss; a torn uncommitted tail is reported/repaired
under the established journal policy. Rebuild derived output after restart
without repaying or duplicating a completed call. An intent without receipt
stays uncertain/reserved; do not silently repeat a possibly paid call. Partial
write/ENOSPC, malformed interior records and failed fsync stop production with
an explicit incomplete result. Do not call the simpler Loom `FileJournal` a
fully fsynced/torn-tail-safe journal: its current implementation only appends
JSONL and parses lines. Preserve it; G7 does not promise to repair it.

For stored Weft evidence use `openTraceStore` through its public subpath;
reuse transactional rollback, conflict refusal and durable reopening. Do not
put Gauge records into `TraceStore`. Read a fixed evidence snapshot while
producers append elsewhere. Resolve causal links that arrive out of order
before deciding; unresolved cross-emitter links mean incomplete evidence.
Two independent cases may classify concurrently without shared mutable state;
two writers to the same run must refuse/serialize through the existing lock.
Concurrent report readers produce identical results without writes or calls.
Do not reorder the existing benchmark engine, whose sequential dispatch and
cost reservations are part of its current contract.

Cancellation before dispatch makes no call and consumes no grant. Cancellation
after dispatch retains any acknowledged outcome/cost and uncertain reservation;
late receipt settles that invocation only. Do not treat cancellation as failed
implementation, release an uncertain effect reservation, or reuse a grant.
Replay performs no inference, host invocation, grant issuance or Weft emission;
recovery continues only new authorized work. Every actual check retry needs a
fresh equal-scope single-use grant; `markInvoked` and `createEqualGrantIssuer`
remain unchanged. Same invocation lookup is evidence, not authority to repeat
its effect. Test cancel/result races and dependency completion/cancellation
interleavings using injected scheduling barriers rather than timing sleeps.

Keep attribution diagnostic and opt-in at composition: it never promotes,
admits, mints grants, releases reservations, changes routes or marks goals
complete. Compare observations, calls, budgets and outcomes with attribution
absent, present, throwing and cancelled to prove that separation.

## Smallest PR slices; red before green, main green after each

All filenames below marked new are future files, not this task's changes.
Each PR records its meaningful behavioral red before code, turns that same
test green, runs the narrow relevant checks, then `npm run verify` and every
`checks/` gate. Do not merge a deliberately failing test-only PR; save red
evidence during development and merge tests with their passing implementation.
Independent corpus authorship and evidence inventory can proceed in parallel;
classifier construction waits for the contract and frozen corpus.

| Slice and dependency | Minimal deliverable | Named red-before-green behavior |
| --- | --- | --- |
| 1. Contract and independent corpus, first | Extend `packages/gauge/src/GAUGE-CONTRACT.md` with producer/evidence semantics without changing @1; document new terms below in `GLOSSARY.md`. **New** `benchmarks/failure-attribution/{CONTRACT.md,PROVENANCE.md,cases.test.ts}` plus development cases, sealed evaluation artifacts and their digests. Add the deterministic label harness, not a classifier. | **G7-T01 `frozen corpus rejects always-unattributed and wrong-citation controls`**; **G7-T02 `scenario lineage and labels cannot cross into tuning inputs`** in `cases.test.ts`. Run the validated harness red against controls, then green against independent expected controls; report both with zero skips. |
| 2. Evidence resolver, after 1 | **New** leaf `benchmarks/failure-attribution/{evidence.ts,evidence.test.ts}` translating existing receipts to bounded portable facts. No runtime or Weft schema changes. | **G7-T03 `wrong-case, stale, dangling and conflicting citations cannot support a claim`**; **G7-T04 `missing search or route inventory is inconclusive`**. Red against a pass-through resolver, green with validation and an immutable snapshot. |
| 3. Pure deterministic attribution, after 2 | **New** `packages/gauge/src/attribute.ts`, exported from existing `index.ts`; **new** `packages/gauge/test/attribution.test.ts`. Reuse existing record types and `validate`; input contract uses only Weft/public portable facts. | **G7-T05 `each decisive signal emits its category and citations without judgment`**; **G7-T06 `policy exclusion, routine deferral and conflicting causes abstain`**; **G7-T07 `unknown case, holdout and info-only result bindings are refused`**. Red against the placeholder, green for all signals and their negative controls. |
| 4. Bounded judgment fallback, after 3 | Extend `attribute.ts` with a recorded-judgment input/finalizer; **new** `packages/gauge/test/attribution-judgment.test.ts`; put receipt/dispatch composition and its mocked dispatch tests in the new benchmark leaf. No hosted provider dependency or I/O in Gauge. | **G7-T08 `judgment runs only after inconclusive deterministic analysis`**; **G7-T09 `missing confidence, invented refs, timeout and cancellation abstain`**. Red against a judgment-always or unchecked-answer double, green with deterministic mocks and exact `basis: judgment` records. |
| 5. Durable runner and evaluation report, after 4 | **New** leaf `benchmarks/failure-attribution/{run.ts,report.ts,report.test.ts,durability.test.ts}`. Compose existing journal and Weft intake; publish only aggregate held-out reports. Run the sealed set once against the frozen classifier and record per-category precision/recall. No live calls unless separately authorized with the data/destination gate below satisfied. | **G7-T10 `receipt crash and replay neither duplicate nor lose a claim or repay a call`**; **G7-T11 `cancel and competing writers preserve reservations and single-use authority`**; **G7-T12 `all five categories retain FP/FN and null denominators without leaking holdout cases`**. Red via deterministic crash/write/conflict mutations and wrong-count controls, then green across restart and concurrent reads. |
| 6. Consumer regression and documentation, after 5 | Wire only the opt-in evaluation consumer. Extend existing `benchmarks/decision-sites/{recorded.test.ts,test/providers.test.ts}` and relevant W5 tests if composition is exercised; document results/limitations in the new leaf's report. Leave production routing unchanged. | **G7-T13 `attribution changes neither G4 report parity nor benchmark request bodies`**; **G7-T14 `sink failure, replay and concurrent cases change no runtime effect or grant`**. Red with deliberate guardrail/shuffle/duplicate-dispatch mutations, green on the original routing and authority boundaries. |

Keep these existing regression anchors green: G4
`Gauge reproduces every number of every row of the recorded report exactly`,
W5-T20–T24 replay/recovery and W5-T58/T59 re-entrant grant protection;
`packages/weave/test/p8.test.ts` fresh-grant, partial-write, competing-writer
and unfinished-replay tests; `packages/weft/test/sqlite.test.ts` rollback and
process-death tests. No mutation used to demonstrate red is committed.

## Guardrails, disclosure and checks

- Never weaken a check, permission, validator, protected criterion, isolation
  boundary or held-out test to get green. Generated tests and code remain
  untrusted until independent controls and deterministic checks validate them.
  Generation, admission and authority to execute remain separate gates.
- No ambient clock, entropy or environment reads in new pure code. Inject
  time, timers, ids and seeds through composition when needed. Weft causal
  links determine order across emitters. Gauge currently is not listed in
  `checks/no-ambient-clock.mjs`'s `SCANNED` array, so a passing scan alone does
  not prove new Gauge purity; review and deterministic port tests must cover
  it, without adding an allowance for a forbidden read.
- Keys never enter argv, logs, journal payloads, reports, Weft records or
  model evidence. Credential loading belongs at composition; adapters use
  headers or existing permitted secret injection. Run credential canaries
  through accepted, rejected, thrown-error and cancellation paths. Retain
  Weft's serializer/redactor and credential parity checks.
- Benchmark routes must not inherit runtime guardrails, option shuffles,
  tier downgrades or fallback during attribution. Current
  `benchmarks/decision-sites/providers.ts` uses
  `typesafeWireProfile({shuffle: false})`; `competitors.ts` has an explicitly
  gateway-routed Muse Spark exception. Preserve that declared exception,
  request/choice order and existing price/privacy protections. Relevant
  anchors are `test/providers.test.ts`'s model/order test and
  `test/nous.test.ts`'s no-shuffle/no-guardrail test. The TypeSafe and local Kev
  production defaults may shuffle (`packages/gateway/src/adapters/{typesafe-ai,kev-local}.ts`);
  new benchmark composition must explicitly disable that behavior, not alter
  production defaults. G7 analysis never changes an original benchmark call.
- Before any later hosted use of benchmark-derived text, record per-source
  provenance/license status, permitted content classes and the **exact**
  configured destination/endpoint, then sanitize the untrusted payload or
  obtain explicit authorization. Unknown license or destination is a blocker
  to that dispatch, not to offline evidence analysis. Do not infer permission
  from an available key or classify private repository evidence as public.
  Default research execution uses local deterministic fixtures/recorded
  evidence; a future provider/model is not chosen by this plan.

Terms proposed for the later glossary slice: **attribution evidence bundle**
(revision-bound inputs and resolvable citations for one failed case), and
**attribution abstention** (an explicit `unattributed` claim when evidence
does not support one category). Extend the existing **Failure attribution**
entry with the conceptual `capability` → wire `capability_gap` mapping and the
deterministic/judgment distinction; reuse **Confidence**, **Holdout**,
**Tune split**, **Demonstrated red**, **Evidence** and **Replay** unchanged.
No glossary edit is made in this planning commit; no vision acceptance boundary
change is proposed.

## Owner questions: product forks only

1. Should the product eventually retain multiple causal claims per failure,
   or demand one primary cause? **Recommendation:** one supported category
   initially, with conflicting explanations retained in evidence and an
   explicit abstention. Multiple ranked causes need a separate product and
   evaluation contract; do not impose an arbitrary causal precedence now.
2. Should inconclusive cases trigger paid/hosted judgment automatically, or
   only when an operator enables a bounded research run? **Recommendation:**
   opt-in bounded judgment, deterministic-only/offline by default. Budget,
   disclosure and destination authorization must be explicit; lack of
   inference leaves an honest `unattributed` result. This affects cost and
   data exposure, not whether deterministic checks are obeyed.

These questions do not block the contract, corpus, resolver or deterministic
slices under the recommendations. Naming, id format, dependency direction and
holdout protection are existing technical contracts, not owner approval forks.

## Verification performed for this plan

Commands ran on the clean starting branch `wv-195-failure-attribution-plan`.
The intended commit contains only `PLAN.md`, with message
`plan: Gauge G7 failure attribution (#195)`; no push. The file is complete,
but staging/committing is blocked by the read-only Git metadata mount below.

| Check | Observed result / blocker |
| --- | --- |
| Root-plan acceptance check before writing | Failed as intended: `WV-195 plan acceptance red: root PLAN.md is absent`. This is documentation acceptance evidence only, not G7 classifier red. |
| Plan acceptance after writing | Passed: all 60 explicitly checked existing file paths resolve, required topics and G7-T01–T14 are present. Reviewed proposed files separately from existing inventory. |
| `npm run verify` | Ran; exit 1 in initial `check`: `scripts/benchmark-digests.test.mjs` passed; `scripts/verify-cached.test.mjs` failed. Direct diagnosis found missing `node_modules/.bin/vp` (`ENOENT`) and the cache-interruption fixture timing out waiting for its child. Later verify stages were not reached. |
| Dependency/runtime diagnosis | `node v20.19.2`, `npm 11.21.1`; repository requires Node >=22.18.0 and npm >=10. No local `node_modules`; `npm run build` failed exit 127, `tsc: not found`. Package tests, TS execution, web builds and full verification therefore remain unverified. No dependency/lockfile edits or global installs were made for this docs-only task. |
| Every top-level `checks/*.mjs`, invoked directly | `import-direction.mjs` passed (325 files); `no-ambient-clock.mjs` passed (104 runtime files); `no-ambient-entropy.mjs` passed (51 Loom files); `no-ambient-env.mjs` passed (133 package sources); `no-swallowed-failures.mjs` passed (12 package/workflow files); helper `source-scan.mjs` loaded successfully (no standalone assertions). |
| `npm run test:checks` | Ran; exit 1: Node 20 did not expand the quoted `checks/test/*.test.mjs` glob. Also ran with explicit filenames and each test file directly; this did not produce a full green suite. |
| `checks/test/credential-parity.test.mjs`, direct | Passed 2/2 tests. |
| `checks/test/execution-provider.test.mjs`, direct | Passed 30/30 tests. Helpers `checks/fixtures/execution-provider/{contract,doubles}.mjs` also loaded directly, exit 0. |
| `checks/test/checks.test.mjs`, direct | Failed 6/6 because its child `spawnSync` output was unavailable. A minimal child invocation returned `spawnSync /usr/bin/node EPERM`; this environment blocks that nested execution path. The exact red and green fixture invocations were then run directly: all three red roots exited 1 with the expected findings and all three green roots exited 0. This diagnostic does not turn the failing harness green. |
| `checks/fixtures/execution-provider/red.mjs`, direct | Intentional red: 10 assertion failures, zero skips, exit 1. Existing execution-provider fixture evidence only, not classifier quality evidence. |
| Commit attempt | `git add -- PLAN.md` failed exit 128: unable to create `/workspace/weave-WV-234/.git/worktrees/weave-WV-195/index.lock`, `Read-only file system`. The worktree's `.git` points there. No commit was created and nothing was pushed; completing the requested commit requires writable Git metadata. No alternate repository or metadata rewrite was substituted. |

Full green must be established in the supported Node/dependency environment
before implementation PRs merge. Do not change scripts, suppress failures or
relax policy to hide these blockers. Current uncertainties are missing causal
inventory in some historical runs, independent label availability, and the
generalization of a small labelled set; G7 must report each rather than claim
unsupported attribution accuracy.
