# WV-195 — Gauge G7 failure attribution

Planning deliverable only for [#195](https://github.com/CrowBe/weave/issues/195),
part of [Gauge #182](https://github.com/CrowBe/weave/issues/182). This task
changes only this file. Implementation, tests, schemas and glossary edits belong
to the later slices below. No live benchmark or hosted inference is requested
or performed by this planning task.

## Verified baseline and dependencies

The inventory was inspected at `f24b99f0868aadd26f01063f7d3471e9e1021cd0`,
five commits after the original inspection at
`e35767b74a0118bf7e806747e4ae89bdb9053d06`, including `0311340` and `439cea6`.
On 2026-11-01, this checkout's `origin/main` is
`e4dc5e16bf8d1ad25d18c9d7041066a9fa982883`. Both `444c0d0` and its successor
`e4dc5e1` change only `scripts/verify-cached.test.mjs` since `f24b99f`;
the inspected seams and inventory remain valid. The comparison is reproducible
with `git diff --name-only f24b99f e4dc5e1`.
Only `packages/agentfabric/src/store.ts`,
`packages/agentfabric/test/store.test.ts`, `scripts/verify-cached.test.mjs`,
`vite.config.ts` and `package.json` changed from `e35767b` to inspected `f24b99f`.
The Fabric store and its tests changed for writer-lock reclamation; inspected
`FabricStore` remains exported at `store.ts:191`, with its role as a recorded
routing/authority receipt source unchanged. Its invocation/snapshot interfaces
remain available; G7 reads recorded decisions and never invokes store authority.
The other inspected seams did not change: `packages/{gauge,weft}`,
`benchmarks/decision-sites`, `GLOSSARY.md`, `checks/import-direction.mjs` and
`packages/weave/src/{implement-step,journal}.ts`. The inventory's unchanged seams
and the separately reinspected Fabric seam therefore remain applicable.
The branch still has merge-base `e35767b` with `origin/main`; rebase onto
`e4dc5e1` is blocked by read-only git metadata, as recorded in plan9 verification
below. The main ref is current; the branch is not rebased. The original
inspection recorded both prerequisite PRs merged with
base `main`; ancestor checks against the pinned baseline confirm their presence:

| Prerequisite                                               | Evidence on main                                                                                                                                                                       | Contracts and tests inspected                                                                                                                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [G4 #192](https://github.com/CrowBe/weave/issues/192)      | [PR #282](https://github.com/CrowBe/weave/pull/282), merge [3485743994287c507987974507937072b85cb8ea](https://github.com/CrowBe/weave/commit/3485743994287c507987974507937072b85cb8ea) | `packages/gauge/src/types.ts`, `GAUGE-CONTRACT.md`, `validate.ts`, `produce.ts`; `packages/gauge/test/info.test.ts`; `benchmarks/decision-sites/{gauge,weft,recorded.test}.ts`                                               |
| [Weft W5 #187](https://github.com/CrowBe/weave/issues/187) | [PR #266](https://github.com/CrowBe/weave/pull/266), merge [2088695ff172d598f61d641dcf6a255831cd968c](https://github.com/CrowBe/weave/commit/2088695ff172d598f61d641dcf6a255831cd968c) | `packages/{weave,gateway,agentfabric}/src/weft.ts`, each package's own `WeftPort`; `packages/weft/src/{types.ts,WEFT-CONTRACT.md,sink.ts}`; `packages/weave/test/w5-{trace,replay,isolation,authority,records,perf}.test.ts` |

These are fulfilled dependencies, not work to recreate. G4 reports are
`InfoResult` (`gauge.result@2`); they cannot be attributed. W5 is a lossy,
non-authoritative projection, delivered after transitions. Neither implies
that a classifier or a complete causal evidence bundle already exists.

## Existing inventory and boundaries

Read `VISION.md`, `GLOSSARY.md`, `AGENTS.md`, and current source and behavioral
tests before selecting these seams. Existing symbols below are current;
files explicitly marked **new** in later sections are proposals.

| Existing seam                            | Exact owner and intended reuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attribution and evaluation contracts     | `packages/gauge/src/types.ts`: `FailureAttribution`, `AttributionCategory`, `EvidenceRef`, `EvaluationResult`, `Context`, `CaseSet`, `Revision`, `CriteriaSet`, `InfoCriteriaSet`, `InfoResult`, `Produced`. `packages/gauge/src/validate.ts`: public `validate`, private `validateAttribution` and `SIGNALS`. `packages/gauge/src/index.ts` currently exports no attribution producer/classifier.                                                                                                   |
| Attribution rules already enforced       | `packages/gauge/src/GAUGE-CONTRACT.md`, section `gauge.attribution@1`; `packages/gauge/test/{contract,validate,governance,info}.test.ts` and `packages/gauge/fixtures/records.json`. The validator checks shape/binding, not the truth of a cited cause or case membership in external evidence.                                                                                                                                                                                                     |
| Evaluation/report production             | `packages/gauge/src/produce.ts`: `evaluate`, `evaluateInfo`; `stats.ts` supplies deterministic aggregation/interval machinery; `digest.ts`: `recordDigest`. `benchmarks/decision-sites/gauge.ts`: `gaugeContext`, `scoreReport`, `reported`; `weft.ts`: `attemptRecords`; `recorded.test.ts` proves exact report parity, read-only replay and concurrent scoring.                                                                                                                                    |
| Weft evidence                            | `packages/weft/src/types.ts`: `WeftRecord`, `KindFields`, `Evidence`, `Link`, `Candidate`, `Exclusion`; `validate.ts`: `validateRecord`; `serialize.ts`: `serializeRecord`. Public package entry points are `@weave/weft` and `@weave/weft/sqlite`, not relative imports into internals.                                                                                                                                                                                                             |
| Durable Weft intake                      | `packages/weft/src/sqlite.ts`: `TraceStore`, `openTraceStore`, `importRecords`, `importJsonl`, transactional identity/conflict handling. `packages/weft/test/sqlite.test.ts` covers torn lines, cancellation, concurrent connections, rollback, durable reopen and process death. This store accepts Weft/legacy trace records, not Gauge attribution records.                                                                                                                                       |
| Durable benchmark receipts               | `benchmarks/decision-sites/journal.ts`: `Journal`, `acquireLock`, `replayKey`, `ledger`; `engine.ts`: `execute`. `harness.test.ts`, `engine.test.ts` and `recorded.test.ts` cover fsync, locks, receipt binding, cancellation and uncertain spend. Keep these leaf-owned; Gauge must not import this benchmark.                                                                                                                                                                                      |
| Authoritative check and runtime evidence | `packages/weave/src/implement-step.ts`: `CheckEvidence`, `AttemptRecord`, `FileAttemptJournal`, `replayImplementationStep`, `createEqualGrantIssuer`. `packages/weave/src/journal.ts`: `ObservationJournal`, `FileJournal`. `packages/weave/src/types.ts`: `CrystallizationSearch` (`matches`, `compositions`, `informed_by`); `scheduler.ts`: `select`. These are producer inputs translated at composition under pending owner Q7, never Gauge dependencies; host objects are not passed to Gauge. |
| Routing and authority                    | `packages/gateway/src/routing.ts`: `route`, `RoutingDecision`, `RouteExclusion`; `packages/agentsop/src/grants.ts`: `GrantAuthority`, `createGrantAuthority`, `markInvoked`; `packages/agentfabric/src/store.ts`: `FabricStore`. Use recorded policy/authority decisions, never rerun an effect to explain a failure. Receipt translation and its import boundary remain pending Q7.                                                                                                                 |

Gauge depends only on Weft's public contract. Loom remains independent of any
model, provider or tool protocol; Fabric remains bounded and imports no Loom
runtime or scheduling concerns. `checks/import-direction.mjs` enforces those
directions. Keep the runtime and gateway control logic pure: injected ports,
explicit observations and deterministic policy; filesystem, network, clocks,
credentials and inference dispatch stay at existing host/adapter/composition
boundaries. Gauge's classifier must be a pure transformation too.

Per owner decision D-ENG-017 (1 Nov 2026, issue #329), recorded outside the repo
in the bench's decision log by Benjamin and scoped to #329 rather than #195,
G7 consumes the current Weft `thread.transition`/`thread_id` shapes and depends
on no workstream rename or schema removal in any slice.

## Contract before implementation: record and evidence

The requested conceptual category set is exactly `capability | implementation |
routing | orchestration | unattributed`. Map conceptual `capability` to the
existing wire value `capability_gap`; every other value maps identically.
Do not silently rename `AttributionCategory`, accept a second spelling on the
wire, or revise `gauge.attribution@1`. Use the glossary term **capability gap**.

Reuse `FailureAttribution` unchanged:

| Field                   | Contract for G7 production                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `attribution` | `gauge.attribution@1`; deterministic id derived by the rule below, checked by the producer. No ambient time or random id generation in Gauge.                                                                                                                                                                                                                             |
| `result`, `case`        | Known, valid `EvaluationResult` on `tune`; additionally verify case membership and an observed failed case under that result's governed criteria. Aggregate `misses_bar` alone does not identify a failed case. A case failure can exist inside an aggregate `meets_bar` result. Unknown, unfinished or cancelled-without-a-failure cases cannot be invented as failures. |
| `category`              | Existing `AttributionCategory` values with the conceptual mapping above. One supported category per claim; uniqueness per case versus per revision and revision history remain pending owner question 6.                                                                                                                                                                  |
| `basis`, `signal`       | `deterministic` with a category-specific closed signal; `judgment` with null signal means probabilistic inference; `none` with null signal only for `unattributed`.                                                                                                                                                                                                       |
| `confidence`            | Null for deterministic and unattributed; finite [0,1] for judgment. Preserve reported confidence as a provider statistic, distinct from class probability, model quality, calibration and authority. Missing confidence cannot become 1.                                                                                                                                  |
| `evidence`              | Existing `EvidenceRef[]`, unique `(source, ref)`, maximum 64. Cite Weft records/spans and check receipts, including contrary evidence. Require evidence for every attributed claim; retain diagnostic evidence for abstentions where available.                                                                                                                           |

Derive `attribution` as `g7:` followed by all 64 lowercase hexadecimal
characters of the SHA-256 digest of the UTF-8 canonical JSON object
`{domain: "gauge.attribution-id@1", result, case, evidence_bundle_digest,
classifier_revision, rule_revision, prompt_revision, model_revision,
judgment_request_digest}`.
Use `recordDigest` canonicalization (recursively sorted object keys, no
whitespace, array order preserved), stripping only its `sha256:` prefix.
`result` and `case` are the bound ids; `evidence_bundle_digest` is
`recordDigest` of the frozen, normalized deterministic evidence bundle,
including resolved evidence contents. Before any attribution, including the
pure deterministic path with no dispatch, the runner must durably record the
snapshot reference and bundle digest per case, with an immutable retained
bundle or a reference from which its exact contents can be recovered. Commit
that binding before deriving the id or claim. The bundle binding is run-scoped,
keyed by `{run_id, result, case}`, shared by all attempts for that case within
the run; it is separate from the per-attempt journal key below. The composition
root (offline runner) supplies `run_id`, which satisfies Weft `isId`; pure code
never generates it from ambient time or entropy. Before any bundle binding or
attempt, durably record it in the run directory's journal header under the
writer lock. Restart must reuse the recorded `run_id` from that directory;
an invalid or missing header in an existing journal, or a supplied-id mismatch
fails closed before evidence resolution, binding or dispatch. A crash before
header commit cannot leave bindings or attempts; an empty directory may be
initialized under the lock. Never silently allocate a fresh id for a restart.
The run-scoped binding does not
establish a cross-run binding keyed by (result, case[, revision]). A fresh run
may resolve a different bundle, but before accepting an id/claim it must pass
the pending Q6 uniqueness/history check across run directories, using the
owner-selected (result, case) or (result, case, revision) key regardless of bundle
digest. A new digest/id cannot bypass that check. The check and claim commit
must serialize on that chosen key across runs, not rely on a per-run lock;
settle this contract under Q6 before slice-5 implementation. No Q6 option is
selected here. Restart and replay rebuild only
from that recorded bundle, verifying its digest; unavailable or mismatched
contents refuse reconstruction. Never re-resolve a case against a newer Weft
snapshot during replay or silently replace its committed binding. Explicit
new-revision evaluation remains subject to owner Q6's history contract.
Identity uses only pre-judgment inputs:
the judgment receipt is cited evidence only, excluded from this bundle digest
and the identity, including its answer, rationale, latency and provider ids.
`judgment_request_digest` is `recordDigest` of the exact permitted judgment
request, frozen before dispatch; it is explicit null when no judgment is
requested. Revision fields identify the frozen classifier, rules, prompt and
model/configuration declarations. The composition layer supplies revision
digests as injected inputs, computed, for example, from frozen artifact files
in the benchmark leaf; Gauge checks classifier/rule/prompt/model revision
digests with Weft `isDigest` (`/^sha256:[0-9a-f]{64}$/`), never reads its own
source or artifact files. Classifier/rule revisions always require digests;
use explicit null for prompt/model revisions only when no judgment is
requested, regardless of whether an answer is accepted. Non-null revision
digests enter the id object in their `sha256:`-prefixed form; bare hex,
uppercase hex and malformed lengths are refused. Strip the prefix only from
the final object digest when forming `g7:`. The resulting 67-character id uses
only `g7:` and `[0-9a-f]`,
within `isId`'s `[A-Za-z0-9_.:@-]{1,128}` alphabet/length. Do not include the
output category or claim content in the identity: a different claim for the
same inputs must trigger the durability conflict rule. Put this id derivation
rule in `GAUGE-CONTRACT.md` in slice 1a. G7-T07 pins the exact derivation,
canonical-key-order invariance, changed-input identities and `isId` acceptance
red-first in slice 3, before the binder writes ids. G7-T10 covers same-id
conflicts across crash and replay in two distinct cases: a conflicting second
outcome receipt for one attempt is refused at the receipt layer; an injected
conflicting claim write or mutated finalizer output for an already-claimed id
is refused at the claim layer. Each case disables only its own layer for red,
so receipt refusal cannot mask a broken claim check.
Revision-dependent ids do not settle product uniqueness or supersession;
owner question 6 must settle that separate contract and its G7-T10 cases.
It must also decide how authorized retries avoid a transient abstention
permanently conflicting with a later answer: either timeout/cancellation
persists only an uncertain receipt and no attribution, or each authorized
retry freezes a distinct request digest before dispatch (for example, by
including an attempt ordinal). These are pending alternatives, not defaults.
G7-T09/G7-T10 cover timeout-then-retry under the chosen contract, including
crash/replay; the same frozen request still cannot accept conflicting claims.
Under either option, a late receipt from an attempt superseded by an
authorized retry is retained as evidence only and never produces a claim.
Use the separate `attempt_id` journal binding and supersession check-and-set
specified below before retry dispatch; restore that binding on restart and
replay. A valid outcome receipt is a well-formed, attempt-bound, completed-response
receipt, independent of whether its answer is usable at the decision step:
a malformed answer payload, low confidence, invented refs or contradictory
content can be retained inside a valid receipt envelope. A malformed or
misbound receipt envelope is invalid. A committed valid receipt blocks attempt
supersession and retry dispatch, subject to the separately pending Q6 choice
on completed-but-unusable answers. Q6 must decide whether those answers block
retry too or permit a separately authorized retry, including its claim-persistence
and identity rules. In either case, the locked eligibility check prevents two
attempts from claiming a shared id under option (a). Both Q6 retry alternatives
and the completed-but-unusable retry choice remain open.

The record itself is the structured claim; render an explanation from its
category, basis, signal and resolved citations. There is no existing free-text
`claim` field and the exact-key validator forbids adding one. Optional model
rationale stays in a bounded, access-controlled judgment receipt referenced as
evidence, never an extra attribution key or trusted instruction.

Compose an evidence resolver outside Gauge. Gauge receives immutable validated
Weft records and bounded normalized check/search/route/schedule facts, not host
objects. Define and export the pure fact and decision input types in
`packages/gauge/src/types.ts` in slice 1a,
with their `GAUGE-CONTRACT.md` text, before the slice-2 resolver targets them.
Gauge owns this contract; classifier logic remains in slice 3. The resolver
maintains opaque, credential-screened ids that resolve:

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
attribution records. Held-out precision/recall covers the decision step only:
`validate.ts:882–883` rejects results outside `tune`, so these metrics do not
exercise id derivation, case-membership/failed-case checks or final record
validation. G7-T07 must also prove on the tune split that every
tune decision binds to a record passing `validate` with the same
category, signal and evidence. Retain its negative binding controls. This is
one decision implementation with two consumers, not a second record schema
or a bypass of `validate`.

## Deterministic signals first

Inspect all applicable deterministic evidence before asking for inference.
Use causal `parent_id`/`links` and recorded revisions, never arrival order,
wall-clock proximity or a fluent explanation. A downstream failure does not
prove its upstream cause. Conflicting plausible categories have no arbitrary
priority; keep the conflict available for bounded judgment or abstention.

| Category                      | Required positive evidence and existing signals                                                                                                                                                                                                                                                                    | Counterexample that must not trigger it                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability (`capability_gap`) | `no_contract_matched`: a complete, revision-bound search over the relevant authorized catalogue and compositions found no fitting contract for the required operation.                                                                                                                                             | Empty top-k retrieval, a failed semantic guess, unavailable catalogue, revoked implementation or missing grant. `CrystallizationSearch` informed by inference is not deterministic proof of semantic absence.                          |
| Implementation                | A matching contract/selected implementation is established, and bound checks/effects show `contract_tests_failed`, `effect_violation` or `implementation_failed`.                                                                                                                                                  | Transport failure, legitimate permission refusal, failed unrelated tests, cancelled check, or uncertain effect. A generic `capability.invoked.status = failed` alone is insufficient.                                                  |
| Routing                       | `wrong_contract_selected` or `better_route_excluded`: recorded selection was wrong while an independently established fitting alternative was available and policy-eligible at that decision revision. Preserve route table/preferences, availability, terms and policy revisions plus comparative check evidence. | Cheaper is not necessarily better. A route legitimately excluded by privacy, quality, credential screening, budget, context or permissions is not a routing defect. Later success on another input is not an available counterfactual. |
| Orchestration                 | `dependency_failed`, `schedule_conflict`, `budget_exhausted` or `superseded` caused the recorded failed outcome under the declared contract. Bind prerequisite results, scheduler dispositions and terminal observations.                                                                                          | Normal conflict deferral, an action still waiting, lawful budget refusal, requested cancellation or supersession alone does not establish a defect. Classify the evidenced failure mechanism, not blame for enforcing policy.          |

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
agreed threshold is fixed on tune-split evidence before evaluation. Missing,
malformed, low-confidence, unavailable, contradictory or cancelled judgments
abstain at the decision step. Whether transient timeout/cancellation also
persists an `unattributed` claim is pending owner question 6; do not freeze
that persistence or retry contract by inference. Never let judgment override
decisive checks, policy, a failed validation, admission or authority. Record rejected proposals privately as
observations; accepted probabilistic claims use `basis: judgment`.

## Labelled set, demonstrated red and reporting

Build and freeze the acceptance labelled set independently of classifier
implementation and **before any comparative acceptance run**. If owner Q3/Q5
are pending, development-only work can proceed on the separate tune split;
a later acceptance freeze must independently reserve unseen
scenario/source lineages, including adversarial cases. No acceptance quality
claim is available before that freeze and sealed evaluation.
Proposed leaf: **new** `benchmarks/failure-attribution/`. The proposed minimum,
subject to owner confirmation, is four independent scenarios per category
(including `unattributed`) and eight ambiguous/adversarial scenarios: 28 cases
(4 × 5 + 8), with multiple signal variants and negative controls. Ambiguous is
a case annotation, not a sixth category; its
expected output is `unattributed` unless the independent rubric identifies one
supported cause. Include independently reviewed recorded failures or cases
authored by an owner/reviewer other than the classifier implementer; synthetic
cases authored solely by that implementer are insufficient quality evidence.
If that independent evidence is unavailable, report the limitation without
substituting self-authored labels. Whether a characterization-only report
then closes #195 is an open owner decision below; this plan does not waive
the held-out acceptance criterion or decide closure.

Each case carries an opaque id, scenario family, source snapshot/digests,
provenance and license status, evidence permissions, failure criterion,
expected conceptual/wire category, acceptable signal or abstention, and the
independent label rationale. Resolve label disagreements before freezing;
retain uncertainty as an ambiguous case. Strip expected labels/rationales
from classifier inputs. Reserve cancellation, causal-order permutations,
missing spans, policy exclusions and prompt-injection cases in that freeze.

The entire acceptance set is held out from prompt, rule, threshold and model
tuning. Reuse **Tune split** for the separate scenario-disjoint cases used to
develop rules and select thresholds, with governed
`CaseSet`/`Revision` digests. Commit only acceptance-set digests, the manifest
and label-free inputs for the acceptance set. Acceptance labels and rationales
live outside the implementer-readable repo, or encrypted with an evaluator-held
key; committing readable labels is forbidden. Owner question 3 selects the
sealing arrangement and custodian. The slice-1b loader verifies sealed labels
by digest before evaluation, refusing missing or mismatched artifacts without
exposing their contents to the implementer. For this sealed-label input only
the stored-byte digest is pinned in the manifest; the path is supplied at
evaluation time by the evaluator through slice-5 `run.ts`, the only production
injector into the declared reader described below. The path may come from an
explicit runner option. Before slice 5, slice-1b tests and positive controls
inject synthetic temporary sealed artifacts directly into the reader; they
need no production runner or real acceptance labels. For Q3's encrypted option,
pin the stored bytes (ciphertext) and verify decrypted bytes against a separately
recorded plaintext digest before evaluation. Any decryption key comes only
through existing secret injection, never argv, logs or journals; do not persist
it in the manifest or run header. Q3's sealing choice and custodian remain open.
Pure code reads no ambient env/argv.
The loader obtains label bytes only through that reader, retaining Q3's access
controls and sealing alternatives; the path need not be inside the repo.
Each 1b tune case also retains raw
source receipts and a frozen normalized-fact form conforming to the slice-1a
Gauge input types, with separately pinned raw-receipt and normalized-fact digests.
Place pinned corpus data, raw receipts, normalized facts, manifest and
acceptance digests under `benchmarks/failure-attribution/fixtures/**` as JSON
or JSONL, covered by `vite.config.ts`'s `**/fixtures/**/*.json(l)` formatting
exemptions. If any pinned file uses another location or extension, add its
exact path to fmt `ignorePatterns` in the same slice-1b PR. Verify stored-byte
digests before parsing; formatting must never rewrite frozen bytes or require
repinning to make main green. Slice 3's
`packages/gauge/fixtures/attribution-tune.json` already has that exemption.
Corpus authors can prepare these in parallel with 1a, but validate and freeze
the normalized form against 1a before slice 3. G7-T15 compares the Gauge fixture
with those frozen facts independently of slice 2; the later slice-2 resolver
check proves `resolver(raw) == 1b normalized facts`. Fixture parity alone is
not evidence that receipt translation is correct. Independence
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

Held-out precision/recall covers the decision step only, not production
binding or its rejection paths (`validate.ts:882–883`). G7-T07 supplies the
tune decision-to-record agreement check described above.
Preserve current holdout protection: no `FailureAttribution` may name a holdout
case, even in a private store. The isolated evaluator retains bounded raw
decisions/receipts under holdout access controls, scores against sealed labels,
and publishes only a `held_out_report` ref and aggregate measures. Use
`evaluateInfo`/`InfoResult` for descriptive precision/recall reporting, with
declared empty values; info-only results still cannot be attributed, gated or
routed. A later quality gate needs its own governed `CriteriaSet` @1, not a
reinterpretation of G4's reports. Tune-split failures that receive records
bind to ordinary tune `EvaluationResult` @1 with check evidence. Do not relabel
the acceptance set as tune just to serialize per-case attributions.

## Failure, cancellation, durability and concurrency

W5 sink delivery is best effort, not an exactly-once durable journal. A thrown,
slow, rejecting, hanging or re-entrant sink must still leave execution unchanged.
No-port runs stay unchanged too. Missing Weft records cannot become evidence
of no capability or a scheduling defect. Keep runtime recovery on the
observation log and host store; attribution never drives recovery.

Reuse the existing leaf `Journal`/`acquireLock` receipt pattern for G7's offline
evaluation artifacts, subject to the dependency check below; add no new
generic journal primitive. **Assumption to check before slice 5:** direct
reuse of `benchmarks/decision-sites/journal.ts` is acceptable. Reinspect
`checks/import-direction.mjs` and the leaf's contract then: the current check
covers package/consumer direction, not benchmark-leaf to benchmark-leaf
imports, so a passing gate cannot establish permission or API stability here.
Resolve this explicitly before using the import: either move just
`Journal`/`acquireLock` to an owner-approved shared location, or document
deliberate pinned leaf-to-leaf coupling with a test of the required receipt,
lock and replay behavior. Do not adopt decision-sites' private replay keys
as G7's identity contract. Give each output one writer, retain fsync and durable
intent-before-dispatch, receipt-before-report ordering, and build deterministic
attribution/report output from committed receipts. Define a per-attempt journal
key separately from both the attribution id and `judgment_request_digest`:
`{run_id, case, attempt_id}`. Use the composition-root-supplied, `isId`-validated
`run_id` from the locked durable run header defined above, including on restart;
the journal cannot substitute a new run identity. Allocate `attempt_id` as a
durable, monotonically increasing ordinal per run/case under the single-writer lock, before intent;
never reuse it after crash/replay. Bind each key to the frozen case evidence,
classifier/rule/prompt/model and policy revisions and exact request bytes.
Intents and receipts carry that key, the attribution id and request digest;
attempt supersession records carry the same binding and explicitly name both
the replaced `attempt_id` and the authorized successor `attempt_id`. These are
leaf journal fields, not new keys on `FailureAttribution`. Uncertainty
observations also carry the attempt binding and use a separate record kind;
they do not occupy the valid outcome-receipt slot. For intents, outcome
receipts and attempt supersessions, the same key, record kind and content is
idempotent; different bound content fails closed. G7-T10's named case
`receipt-layer conflicting outcome is refused` commits a valid outcome receipt,
then attempts different, otherwise-valid content for the same
`{run_id, case, attempt_id}`; assert a receipt-conflict error at receipt commit
and no second finalizer invocation. Its red
mutation disables only the receipt conflict check, keeping the claim check intact.
Attribution claims separately retain the same-id conflict rule. G7-T10's
`claim-layer conflicting write is refused` uses one committed eligible receipt
and an already-claimed id, then injects a conflicting claim write or mutated
finalizer output without submitting another receipt; use otherwise-valid claim
content and assert a claim-conflict error at claim commit. Its red mutation disables only the claim conflict check, keeping the
receipt check intact. Both cases run across crash/replay, retain the original
content and prove identical-content idempotence. Do not use superseded attempts
or conflicting receipts to reach the claim-layer check.
Under Q6(a), retry attempts share the attribution id and frozen request digest
while their per-attempt journal keys differ. Under Q6(b), each retry also has
a distinct frozen request digest and attribution id, so the attribution id
can identify an attempt too; retain the explicit attempt key on every journal
record under either option. Neither option is selected here. Commit the per-case
run-scoped snapshot/bundle binding above before deterministic attribution as well as before
judgment intent, and reconstruct only from that retained, digest-verified
bundle. A fresh run with the same result/case and classifier/rule revisions
must reach Q6's uniqueness/history check across run directories even if newly
arrived Weft records change its bundle digest and attribution id. The per-run
writer lock alone cannot enforce that check; its cross-run serialization and
history behavior remain gated on Q6. Add these checks at this consumer;
`Journal.append` itself is not a uniqueness validator.
Do not persist a transient-failure claim or dispatch a retry until owner
question 6 settles that contract. G7-T09/G7-T10 must show a timeout followed
by a separately authorized retry can accept its valid answer under the chosen
option without silently replacing a conflicting claim. Preserve uncertain
receipts/reservations across restart; neither option authorizes automatic
redispatch of a call whose outcome may already exist.

Cover crashes before intent, after intent but before dispatch/receipt, after
receipt before derived attribution, and after attribution before aggregate
report publication. Committed receipts and claims survive process death
without duplication or loss; a torn uncommitted tail is reported/repaired
under the established journal policy. Rebuild derived output after restart
without repaying or duplicating a completed call or re-resolving its evidence.
An intent without a valid outcome receipt stays uncertain/reserved for that
`attempt_id`; do not replay it as a fresh call. Timeout/cancellation's uncertain
receipt records status and reservation, not a completed outcome. A separately
authorized retry requires a new attempt key and the supersession gate below,
even when it sends identical frozen request bytes under Q6(a). The earlier
attempt's reservation remains until its own outcome is reconciled. Partial
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

Cancellation before judgment dispatch makes no call. Cancellation
after dispatch retains any acknowledged outcome/cost and uncertain reservation;
late receipt settles that invocation only. Commit supersession as a
check-and-set under the single-writer lock used for receipt commits: reload
the bound attempt state and refuse supersession, successor intent and retry
dispatch if a valid outcome receipt for that attempt is already committed,
even if its derived claim has not yet been written, except for any separately
authorized completed-but-unusable retry path the owner may choose in Q6.
Receipt validity is the envelope/completion definition above, not answer
usability; Q6 must settle the latter's retry eligibility before implementation.
If retry is permitted, durably record the attempt supersession binding before
successor intent/dispatch, retaining the earlier receipt and reservation accounting.
Receipt commitment and claim eligibility use that same serialized state. After supersession,
retain the earlier attempt's late receipt as evidence only; it cannot produce
a claim. G7-T10 injects barriers for a receipt committing before attempt
supersession and for both receipt orders after it, including crash/replay.
For `completed-but-unusable receipt before supersession`, retain both pending
variants: owner chooses refusal, and successor intent/dispatch must be absent;
or owner permits a separately authorized retry, and the locked transition must
retain the receipt, mark the earlier attempt ineligible to claim, and allow only
the authorized successor under Q6's persistence/id rule. Exercise malformed
answer payload, low-confidence, invented-ref and contradictory-answer receipts
with valid envelopes. Also test those unusable receipts arriving after attempt
supersession in both receipt orders. No variant silently releases reservations
or replaces a conflicting claim. Do not treat
cancellation as failed implementation, release an uncertain effect reservation, or reuse a grant.
Replay performs no inference, host invocation, grant issuance or Weft emission;
recovery continues only new authorized work. G7 calls no grant or authority
API; its type-import versus serialized-receipt boundary awaits Q7. Existing
W5-T58/T59 and `p8.test.ts` remain the evidence for grant and check-retry semantics. Same invocation lookup is evidence, not
authority to repeat its effect. Test cancel/result races and dependency
completion/cancellation interleavings using injected scheduling barriers
rather than timing sleeps.

Keep attribution diagnostic and opt-in at composition: it never promotes,
admits, mints grants, releases reservations, changes routes or marks goals
complete. The sole production G7 composition point is the offline runner in slice 5;
nothing attaches attribution to Loom or decision-sites. Enforce the G7 import
boundary with the Q7-independent G7-T14 baseline in slice 1b, before or with
the first executable G7 leaf code; refine it after Q7 in slice 2 and rerun it
for every later leaf change, including slices 3, 4 and 5, and
retain the existing runtime regression anchors below.

## Smallest PR slices; red before green, main green after each

All filenames below marked new are future files, not this task's changes.
Each implementation PR records its meaningful behavioral red before code and
turns that same test green. Contract-only slice 1a uses type-level conformance
and a contract-doc check instead; it claims no classifier behavioral red.
Each PR runs the narrow relevant checks, then `npm run verify` and every
`checks/` gate. Do not merge a deliberately failing test-only PR; save red
evidence during development and merge tests with their passing implementation.
Independent corpus authorship and evidence inventory can proceed in parallel
with slice 1a. Slice 2 needs 1a, the 1b import baseline, frozen tune facts for
resolver parity and Q7, not the acceptance freeze; slice 3 needs 1a and the scenario-disjoint
tune cases from 1b, not slice 2 or the owner-gated acceptance freeze.
Acceptance freeze and sealed evaluation remain gated on Q3/Q5;
if they are unresolved, development-only deterministic work can proceed,
but cannot support an acceptance quality claim or later reuse tune
scenarios as acceptance cases. Do not use freeze as a dependency for unrelated
contract, resolver or development work. Final uniqueness/history and retry
semantics remain separately gated on Q6. Resolver translation and the final
G7-T14 host-receipt refinement are gated on Q7 before slice 2; do not infer a
choice. The shared deny-by-default baseline and its red controls land in 1b
without waiting for Q7; host imports remain forbidden while that question is open.

Extend G7-T14 beyond import scanning with the named subcheck
`G7 leaf data reads use only declared pinned inputs`, landing with 1b.
Route all leaf data reads through one declared reader with an allowlist of
exact pinned repo paths and stored-byte digests in the leaf contract/input
manifest. The sole external-location input is the sealed-label artifact:
only its stored-byte digest is pinned, and the evaluator supplies its path at
evaluation time through slice-5 `run.ts`, the only production injector, which
injects that exact target into the reader for that evaluation. Slice-1b tests
and positive controls inject synthetic temporary sealed artifacts directly into
the reader. A path may come from an explicit runner option; any decryption key
comes only through existing secret injection, never argv, logs or journals.
For Q3's encrypted option, verify the pinned stored bytes (ciphertext) first,
then verify decrypted bytes against a separately recorded plaintext digest
before exposing labels to the evaluator. Neither option is selected here.
This is a declared digest-pinned input, not an
undeclared fs path literal or a loader scan exemption. Pure code never reads
env/argv; the composition root handles external configuration. Apply canonical
target checks and the pinned digest to this injected location too, retaining
evaluator access controls; no arbitrary external path allowance follows.
The manifest itself must pass through the reader: pin the manifest's stored-byte
digest in leaf code, as a constant in the reader module or its test, before
trusting its allowlist or parsing its entries. The manifest cannot supply its
own trust anchor; formatter rewrites cannot update the code-pinned digest.
Verify each read's canonical path and stored-byte content digest before parsing
or exposing bytes; reject aliases,
traversal and symlinks that escape the declared target. Frozen corpus, receipts,
schemas and fixtures use this reader; seal-protected paths retain their access
controls. Mutable journal I/O remains the separate slice-5 receipt interface and
cannot read package data. Statically refuse other fs reads outside those declared
interfaces and undeclared fs path literals or reads into `packages/`, including
computed-path bypasses; no blanket `node:fs` allowance establishes data access.
Add only the exact Gauge fixture in slice 3 and owner-chosen Q7(b) schema paths
in slice 2 to the pinned data allowlist, never host source trees or arbitrary
fixtures. Red controls are an `undeclared host-path read` of
`packages/weave/src/**` (also try another host's fixtures) and a `wrong digest`
for an otherwise allowed path; the first fails statically, the second at the
reader. Add a `formatter-rewritten byte` control: format an unexempted temporary
copy of frozen JSON/JSONL and substitute its changed bytes without updating
the pin; the reader must reject them even when parsed values are identical.
Add `mutated manifest with internally consistent digests`: substitute a changed
manifest and matching replacement artifact digests; the reader must reject the
manifest against the code-pinned stored-byte digest before trusting its allowlist.
Add `label read bypassing
the reader`: plant a direct fs read in the sealed-label loader and require
static rejection. The loader remains in G7-T14's scan. Positive controls read
exact pinned repo bytes and evaluator-injected external label bytes through
the reader with matching digests; missing/mismatched sealed inputs fail without
exposing labels. Q3 still selects sealing and custody. Rerun these checks for G7-T15 and
any Q7(b) schema consumer, so an fs read cannot bypass the import boundary.

| Slice and dependency                                                                                                    | Minimal deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Named red-before-green behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a. Gauge contract, independent of corpus freeze                                                                        | Define pure fact/decision input and decision-output types in `packages/gauge/src/types.ts`, exported through existing `index.ts`. Extend `packages/gauge/src/GAUGE-CONTRACT.md` with those types, producer/evidence semantics and the pre-judgment id derivation rule above, including injected `isDigest` revisions and receipt exclusion, without changing @1; document the slice-1a glossary proposals below in `GLOSSARY.md`. Keep Q6 uniqueness/history and retry alternatives explicitly pending; do not block the independent input/id contract on that decision or corpus sealing. No classifier logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Use compile-time/type-level conformance fixtures that must or must not typecheck against the exported pure input/decision types, plus a contract-doc check of the declared semantics and derivation rule. Show these checks fail before the contract/types and pass afterward; existing green record semantics are regression evidence only. No behavioral red is claimed for this contract-only slice. Keep id derivation implementation and malformed-revision-digest refusal red solely in slice 3 G7-T07.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1b. Independent corpus, provenance and harness, parallel with 1a                                                        | **New** `benchmarks/failure-attribution/{CONTRACT.md,PROVENANCE.md,cases.test.ts,imports.test.ts}` plus scenario-disjoint tune cases and a deterministic label harness; no classifier logic. Put pinned corpus/receipt/fact files, manifest and acceptance digests in `benchmarks/failure-attribution/fixtures/**` as JSON/JSONL, or add exact fmt `ignorePatterns` entries in the same PR as specified above. Each tune case carries raw source receipts plus a frozen normalized-fact form conforming to 1a, with both forms digested; validate/freeze that form after 1a and before slice 3. Corpus authorship and provenance inventory can proceed in parallel with 1a. Land the Q7-independent G7-T14 baseline before or with the first executable leaf code: deny by default, allow only `@weave/gauge`, `@weave/weft`, `@weave/weft/sqlite` and node built-ins; permit within-leaf relative imports and resolve all other relative paths to refuse package-internal or unapproved-location bypasses. `@weave/weave` and `@weave/gateway` start forbidden, including type-only imports and subpaths; `@weave/agentfabric` and `@weave/agentsop` remain outright forbidden. Enable no journal edge before the slice-5 reuse decision. Only the acceptance freeze is gated on owner Q3/Q5. For the acceptance set commit only acceptance-set digests, the manifest and label-free inputs; labels/rationales stay outside the implementer-readable repo or encrypted with an evaluator-held key under Q3. The slice-1b loader uses only the declared reader: composition injects the evaluator-supplied external location at evaluation time, with only its digest pinned in the manifest; Q3 still decides sealing/custody. | **G7-T01 `frozen corpus rejects always-unattributed and wrong-citation controls`**; **G7-T02 `scenario lineage and labels cannot cross into tuning inputs`** in `cases.test.ts`. Run the validated harness red against controls, then green against independent expected controls; report both with zero skips. Reject missing/mismatched sealed-label digests and tune/acceptance overlap without exposing labels. **G7-T14 `G7 leaf imports only allowlisted public Gauge/Weft/built-in specifiers`**, baseline in `imports.test.ts`: demonstrate red with planted forbidden host/Fabric/AgentSOP imports, type-only/subpath imports, relative-path bypasses and an unlisted package; green with public Gauge/Weft, built-in and within-leaf positive controls, scanning the harness and sealed-label loader too. Add the named data-reader subcheck and its undeclared host-path, wrong-digest, formatter-rewritten-byte and label-reader-bypass red controls above before allowing data reads, scanning the sealed-label loader without exemption. Acceptance execution waits for Q3/Q5; development harness checks do not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2. Evidence resolver and Q7 import refinement, after 1a and the 1b baseline/tune facts; gated on Q7                     | **New** leaf `benchmarks/failure-attribution/{evidence.ts,evidence.test.ts}` and extend existing `imports.test.ts`, translating existing receipts to the Gauge-owned input types already exported in slice 1a, after owner Q7 chooses type imports or schema-validated serialized receipts. Do not re-declare unchecked host shapes. G7-T03 also proves `resolver(raw) == 1b normalized facts` from the digested raw source receipts and frozen 1a-conforming tune facts; a resolver that changes or drops a fact is a red control. No temporary benchmark-owned fact type, runtime or Weft schema changes. Preserve the slice-1b G7-T14 baseline; slice 2 only widens or confirms its host-receipt policy after Q7. If Q7(b) is selected, this slice also owns adding the host-owned G7-H01 parity checks and schema artifacts at the locations the owners choose in Q7(b); no package imports from `benchmarks/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **G7-T03 `wrong-case, stale, dangling and conflicting citations cannot support a claim`**; **G7-T04 `missing search or route inventory is inconclusive`**. Red against a pass-through resolver, green with validation and an immutable snapshot. **G7-T14 `G7 leaf imports only allowlisted public Gauge/Weft/built-in specifiers`**: extend the existing baseline only after Q7; the approved journal location can be enabled only after the slice-5 reuse decision. The final host-receipt rule is pending Q7: (a) extend the allowlist for `import type` from public `@weave/weave` and `@weave/gateway` entry points, refining the check to `G7 uses no host value imports or grant/authority symbol references`, including aliases/re-exports via a type-only symbol resolver; or (b) accept serialized JSONL/receipt files only against a schema pinned by host-owned G7-H01 parity tests against the real host types, with schema/test locations still an explicit Q7(b) sub-question, forbidding `@weave/weave`, `@weave/gateway`, `@weave/agentfabric` and `@weave/agentsop`, including type-only imports, subpaths and relative aliases. Under (a), Fabric/AgentSOP receipts still use validated serialized inputs; their packages remain forbidden. No choice is made here. Demonstrate red/green for the chosen boundary: forbidden value/symbol imports and type-import positive controls under (a), or forbidden host imports plus schema drift/malformed receipts and valid receipt controls under (b). Keep the baseline relative-path bypass, unlisted-package and declared-reader controls green; Q7(b) schemas use only the exact owner-selected pinned paths/digests through that reader, with undeclared host-path and wrong-digest red controls. No runtime-effect comparison or extra-effect test double.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3. Pure deterministic attribution and fixture parity, after 1a and tune cases from 1b                                   | **New** `packages/gauge/src/attribute.ts`, exported from existing `index.ts`; **new** `packages/gauge/test/attribution.test.ts` and leaf `benchmarks/failure-attribution/fixture-parity.test.ts`. Reuse existing record types, `validate` and the slice-1a Gauge input and id contract. No resolver dependency: consume frozen normalized tune facts from **new** `packages/gauge/fixtures/attribution-tune.json`. Never import from `benchmarks/` in Gauge tests. This slice adds G7-T15 in the leaf: read `packages/gauge/fixtures/attribution-tune.json` through the G7-T14 declared reader at its exact pinned path/digest as data, never by a relative JSON import or other code import; compare its normalized facts/digest with the corresponding digested 1b normalized-fact form and refuse drift. Preserve pinned fixture bytes with the formatting exemptions above; rerun the formatter-rewritten-byte red control before accepting digest parity. Slice 1b supplies both normalized facts and raw receipts; slice 2 later proves resolver parity from those raw receipts. G7-T15 stays in slice 3 with no slice-2 dependency. Declare this exact read-only data coupling in the leaf contract; it grants no host-module access or scan exemption. Package tests read only their own fixtures. Pin derivation tests red-first before the binder writes ids.                                                                                                                                                                                                                                                                                                                                                         | **G7-T05 `each decisive signal emits its category and citations without judgment`**, including the purity port checks below; **G7-T06 `policy exclusion, routine deferral and conflicting causes abstain`**; **G7-T07 `every tune decision binds and validates with identical category, signal and evidence; unknown case, holdout and info-only bindings are refused`**, including exact id derivation, canonical-key-order invariance, changed-input identities for each pre-judgment field, `isId` acceptance, malformed revision-digest refusal against Weft `isDigest` (`sha256:` plus 64 lowercase hex; reject bare/uppercase hex and wrong lengths), explicit-null eligibility and receipt/output independence. Demonstrate derivation red with constant-id and receipt-dependent mutations before implementing the binder; also reject the placeholder and a binder that changes decision fields. Green must cover derivation and all signals/negative controls on tune cases. **G7-T15 `Gauge fixture digests match the frozen tune facts`** in `fixture-parity.test.ts`: a mutated fixture must fail before accepting the fixture; the exact matching fixture passes. Rerun G7-T14 on this new leaf test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4. Bounded judgment fallback, after 2 and 3; retry contract gated on Q6                                                 | Extend `attribute.ts` with a recorded-judgment input/finalizer; **new** `packages/gauge/test/attribution-judgment.test.ts`; put receipt/dispatch composition and its mocked dispatch tests in the new benchmark leaf. No hosted provider dependency or I/O in Gauge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **G7-T08 `judgment runs only after inconclusive deterministic analysis`**, extending the purity port checks below to the finalizer; **G7-T09 `missing confidence, invented refs, timeout and cancellation abstain`** at the decision step. Include timeout-then-retry with a valid answer under the owner-chosen Q6 persistence/request-identity option: either no attribution is persisted on the transient failure, or the authorized retry freezes a distinct request digest before dispatch. Do not choose the option in implementation. Red against a judgment-always or unchecked-answer double, green with deterministic mocks and exact `basis: judgment` records. Extend G7-T07 to cover every judgment and abstention tune decision as well. Rerun G7-T14 on the added composition code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5. Durable runner and evaluation report, after 4 and the sibling-import assumption check; acceptance run gated on Q3/Q5 | **New** leaf `benchmarks/failure-attribution/{run.ts,report.ts,report.test.ts,durability.test.ts}`. Slice 5 owns `run.ts` as the sole opt-in composition point, explicitly invoked as the offline G7 runner; compose evidence resolution, Gauge decisions/binding, existing journal and Weft intake, and receipt/report output using the explicitly resolved reuse option. Add the slice-5 attempt/receipt glossary proposals below when their Q6 contract is settled. Publish only aggregate held-out reports. The owner-designated evaluator runs the sealed set once against the frozen classifier and records decision-only per-category precision/recall. No live calls unless separately authorized with the data/destination gate below satisfied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **G7-T10 `receipt crash and replay neither duplicate nor lose a claim or repay a call; same-id conflicts are refused`**: split conflict coverage into `receipt-layer conflicting outcome is refused` and `claim-layer conflicting write is refused`, with the layer-specific assertions and isolated red mutations defined in the journal contract above. The first submits different outcome content for the same attempt key and refuses it before finalization; the second injects a conflicting claim write or mutated finalizer output for an already-claimed id using one eligible committed receipt, so it reaches the claim gate. Identical receipt/claim content is idempotent; verify both cases across crash/replay. Pin the separate `attempt_id` journal contract: intents, receipts and supersessions bind the attempt; Q6(a) retries use different journal keys with identical frozen request bytes/digest and shared attribution id, while Q6(b) also changes request digest/id. Same-attempt replay never redispatches; conflicting attempt bindings fail closed. Add `restart reuses recorded run_id and bundle binding`: crash after header and bundle-binding commit, restart the same run directory, reuse its recorded `run_id` and bundle, and retain the same attribution id even after new Weft records arrive. A supplied-id mismatch or invalid/missing header in a nonempty journal fails closed before resolution or dispatch; never treat restart as a fresh run or defer this guarantee to Q6. Red by substituting a fresh run id on restart or re-resolving the bundle. Name the snapshot case `replay after new Weft records arrive`: reproduce the same id or refuse if the recorded bundle is unavailable/mismatched; never emits a second claim for the case. Cover the deterministic path with no judgment intent. Add `fresh run after new Weft records arrive`: same tune result/case and classifier/rule revisions, a different run directory and newly resolved bundle digest/id must still reach the pending Q6 uniqueness/history check across runs before claim commit. Under the owner-selected uniqueness key, prove that concurrent runs cannot bypass the check through different ids or per-run locks; expected history behavior and serialization contract remain pending Q6. Name the race case `superseded late receipt versus authorized retry receipt`: use injected barriers for both receipt orders across crash/replay; the superseded receipt stays evidence only and never claims the shared id. Supersession must be a durable check-and-set under the single-writer lock before retry dispatch. Add `receipt before supersession refuses retry dispatch`: a valid receipt with a usable answer for attempt N commits while the retry waits at a barrier, so attempt supersession and successor intent/dispatch are refused even before claim derivation. Add `completed-but-unusable receipt before supersession`: under pending Q6, either refuse successor intent/dispatch, or allow a separately authorized retry through the locked transition while retaining the receipt and reservation accounting and making the earlier attempt ineligible to claim. Include valid envelopes with malformed, low-confidence, invented-ref and contradictory answers. Test both pending variants under the owner's eventual choice, plus unusable receipts in both orders after attempt supersession, across crash/replay. Include timeout-then-retry across crash/replay under either owner-chosen Q6 option: a valid authorized retry can produce a claim without permanent transient-abstention lockout, silent replacement or automatic redispatch; uncertain receipts/reservations survive. Add the owner-decided uniqueness/history cases from Q6; derivation itself is already pinned by G7-T07 in slice 3. **G7-T11 `cancellation and competing writers preserve receipts without authority calls`**; **G7-T12 `all five categories retain FP/FN and null denominators without leaking holdout cases`**. Red via deterministic crash/write/conflict mutations and wrong-count controls, then green across restart and concurrent reads. Rerun G7-T14 on `run.ts` and the resolved journal location. |
| 6. Consumer regression and documentation, after 5                                                                       | Documentation only in the new G7 leaf; use the runner already owned by slice 5. Nothing attaches G7 to decision-sites or Loom. Keep `benchmarks/decision-sites/**` and existing W5 tests unchanged; document results/limitations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **G7-T13 `existing G4 recorded-report parity anchor and provider-order protections remain green`**: run the existing parity/provider tests unchanged; this is a regression anchor, not new behavioral red. Inspect the decision-sites diff against the implementation base as a PR review step only, never a committed test dependent on git history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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
  not prove new Gauge purity; the entropy scan also excludes Gauge. Until the
  separate scan follow-up lands, G7-T05/T08 must exercise the classifier,
  binder and judgment finalizer with ambient clock/entropy APIs trapped to
  throw (including `Date`, `Date.now`, `performance.now`, timers,
  `Math.random` and crypto entropy APIs), restoring them after each isolated
  test. Keep composition's injected inputs fixed. Demonstrate red with planted
  clock/random reads, then green with no trap invoked on deterministic,
  abstention, judgment and rejection paths. These deterministic port tests and
  source review are required from slice 3; no forbidden-read allowance.
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

Terms proposed to be added in slice 1a: **attribution evidence bundle**
(revision-bound inputs and resolvable citations for one failed case), and
**attribution abstention** (an explicit `unattributed` claim when evidence
does not support one category). Extend the existing **Failure attribution**
entry with the conceptual `capability` → wire `capability_gap` mapping and the
deterministic/judgment distinction; reuse **Holdout**, **Tune split**,
**Demonstrated red**, **Evidence** and **Replay** unchanged. Use **Tune split**
throughout for tune cases; propose no separate near-synonym. Also propose
**judgment request digest**
(`recordDigest` of the exact permitted request frozen before dispatch,
excluding the response; explicit null when no judgment is requested).
There is no existing Confidence entry. Keep the existing wire `confidence`
field name for the provider statistic beside a typed judgment, as permitted
by the glossary's specific language rule; it is not a weight, calibrated
probability, model-quality measure or authority. Do not describe it as
calibrated confidence under the general weight-versus-confidence rule.
Slice 5 also proposes **attempt journal key** (`{run_id, case, attempt_id}`,
separate from claim id/request digest), with **attempt id** (`attempt_id`, the
durably allocated monotonic ordinal within a run/case, never reused after
crash/replay); **attempt supersession** (the locked, durable transition binding
an earlier attempt to a separately authorized successor and ending the earlier
attempt's claim eligibility); **outcome receipt** (a well-formed, attempt-bound
completed-response record, independent of answer usability); and **uncertainty
observation** (a separate attempt-bound record of timeout/cancellation or unknown
outcome and retained reservation, which occupies no outcome-receipt slot).
Attempt supersession is distinct from a Weft `supersedes` causal link, the
`superseded` orchestration signal/transition, and the glossary's CLI
**superseded attempt** reconciliation semantics; it grants no execution authority
and releases no reservation. Add these terms to `GLOSSARY.md` in slice 5 after
Q6 settles the retry contract, without changing those existing meanings.
No glossary edit is made in this planning task; no vision acceptance boundary
change is proposed.

## Follow-ups

- Keep G7-T11 limited to offline cancellation/receipt behavior and G7-T14 to
  the leaf import boundary and declared data-reader checks above. Single-use
  grants must never be reused, including after cancellation, crash or replay; fresh-grant retry
  behavior remains covered by W5-T58/T59 and `p8.test.ts`. Add no grant
  mechanism, runtime attachment or runtime grant/check retry-semantic work to
  G7. The offline judgment retry/id contract remains pending owner Q6.
- Track extending the clock and entropy scans to `packages/gauge/src` as
  separate follow-up work, preferably before or with slice 3. Until then,
  require the named G7-T05/T08 port tests above, beginning with G7-T05 in
  slice 3 and extending to G7-T08 in slice 4. Demonstrate scan red with
  `Date`/`Math.random` mutations; allow deterministic `node:crypto` hashing
  (`createHash`) while continuing to reject entropy APIs. Do not expand the
  G7 implementation slices to implement the scan extension.
- Follow up on trap isolation for G7-T05/T08 without expanding this plan's
  implementation scope: restrict traps to the synchronous pure-function call
  and restore globals in a `finally` block, or use a vm context without the
  forbidden globals. Keep node:test timeouts and unrelated calls outside the
  trap scope. Add a positive control that `createHash` still works while the
  trap is active, and confirm the planted Gauge read triggers the trap.
- Preserve the durability lesson in future journal reuse: committed state
  must survive crash and replay without duplication or loss. G7-T10 covers
  the offline consumer; broader journal repairs remain separate work.
- Preserve the benchmark routing lesson in future adapter work: runtime
  guardrails and option shuffles must not leak into benchmark routes. Keep
  the existing provider-order/no-shuffle anchors and declared Muse Spark
  exception; do not change production defaults or benchmark routes for G7.

## Owner questions

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
3. Who authors and labels the acceptance set, and who runs the sealed
   evaluation? **Options:** name an owner/reviewer label author and a separate
   independent evaluator with sealed-label access; or defer acceptance
   evaluation until those roles are available. **Recommendation:** designate
   both roles before freezing the acceptance set, with neither role held by
   the classifier implementer. No people are assigned by this plan.
   How should labels/rationales be sealed? **Options:** keep them outside the
   implementer-readable repo under evaluator custody; or keep them encrypted
   with an evaluator-held key. In either arrangement, commit only
   acceptance-set digests, the manifest and label-free inputs; the slice-1b
   loader verifies sealed labels by digest before evaluation and rejects
   missing/mismatched artifacts. **Recommendation:** external evaluator-held
   labels, avoiding readable labels or rationales in git; use encryption if
   external storage is impractical. The sealing choice and custodian remain
   pending owner decisions alongside the independent roles.
4. If independent labels are unavailable, does #195 close with a
   characterization-only report? **Options:** keep #195 open until independent
   held-out precision/recall is reported; or explicitly accept characterization
   for closure and track the unmet quality evaluation separately.
   **Recommendation:** keep #195 open; characterization alone does not meet
   the stated held-out acceptance criterion. Closure remains the owner's
   decision, not an implicit fallback.
5. Is the 28-case minimum (4 per category × 5 + 8 ambiguous/adversarial)
   acceptable as a proposal? **Options:** confirm it as the initial
   characterization minimum; or set a different size/coverage requirement
   before freezing. **Recommendation:** confirm 28 as an initial proposal,
   retaining all five categories and ambiguous/adversarial coverage without
   claiming general accuracy from that small set. It is not a fixed
   requirement until the owner decides.
6. What is the uniqueness scope of a `FailureAttribution`: per
   (result, case), or per (result, case, revision), where revision identifies
   the frozen classifier/rule/prompt/model declarations? **Options:** one
   current claim per (result, case), where a newer-revision claim supersedes
   the older claim while retaining its evidence/history; or one claim per
   (result, case, revision), where a newer-revision claim sits beside older
   ones without automatic supersession. **Recommendation:** retain claims
   per revision beside older ones for reproducible comparisons, with no
   implicit current winner. The owner decision is pending: do not implement
   either history policy by inference from the technical id rule. Resolve
   this before finalizing the uniqueness/history contract and its G7-T10
   acceptance cases; slice 1a's independent input/id contract can proceed.
   How should authorized retries interact with that conflict-refusing id?
   **Options:** (a) transient judgment failures (timeout/cancellation) persist
   no attribution, only an uncertain receipt, so a later authorized retry can
   produce the claim; or (b) each authorized retry freezes a distinct request
   digest (for example, including an attempt ordinal) before dispatch, so a
   transient-failure claim cannot occupy the retry's id. **Recommendation:**
   (a), preserving uncertainty as a receipt until a usable judgment exists.
   Under either option, retain receipts/reservations, require separate retry
   authorization, and refuse conflicting claims for the same frozen request;
   an unknown outcome never silently authorizes redispatch. In (a) the same
   attribution id/request digest uses distinct per-attempt journal keys; in
   (b) request digest/attribution id differ too. Both require the locked
   attempt supersession check-and-set above. A valid outcome receipt means a
   well-formed, attempt-bound, completed-response receipt, independent of answer
   usability. A committed usable answer refuses retry even before claim derivation.
   Should a completed-but-unusable answer (malformed payload, low confidence,
   invented refs or contradictions inside a valid envelope) also block retry,
   or permit a separately authorized retry? Both variants remain pending:
   retain the receipt/reservation accounting either way; if retry is allowed,
   decide claim persistence/request identity so an abstention cannot lock out
   that authorized retry or permit conflicting claims. Pin the owner's choice
   in G7-T10's completed-but-unusable interleavings before implementation.
   Include timeout-then-retry with a valid answer in G7-T09/G7-T10, including
   crash and replay. Retry, completed-but-unusable eligibility and
   uniqueness/history decisions all remain pending; this plan selects none.

7. How should the slice-2 resolver translate host receipts while G7-T14
   excludes grant/authority access? **Options:** (a) allow `import type` from
   public `@weave/weave` and `@weave/gateway` entry points, with a scan rejecting
   value imports and specific grant/authority symbols, including aliases and
   re-exports; keep Fabric/AgentSOP inputs serialized and their packages
   forbidden. Option (a) requires a type-only symbol resolver with alias and
   re-export handling, an extra implementation/maintenance cost to weigh
   against (b). Public `@weave/weave` exports grant APIs such as
   `createEqualGrantIssuer`, so a module-level claim of no authority modules
   would be false; G7-T14 instead forbids value imports and grant/authority
   symbol references. Or (b) require serialized JSONL/receipt files only,
   validated against a schema pinned by host-owned parity tests against the
   real types, outside the G7 scan. Where should the schema live, which host
   owners own the parity tests, and what locations should slice 2 add?
   One option is a host-published JSON schema artifact plus digest at
   `packages/<host>/schemas/g7-receipt.schema.json`, read by the leaf as pinned
   data via fs, with **G7-H01 `published receipt schema matches host types`**
   in `packages/<host>/test/g7-receipt-schema-parity.test.ts`. Each participating
   host tests its own artifact against its own types; no package imports the
   benchmark leaf, and the leaf imports no host package. Slice 2 would add
   these artifacts/tests with schema-drift red and valid-receipt positive
   controls under (b). This is a location/ownership option for the owners,
   not a selected design; they must name the participating hosts and final
   locations before slice 2. The leaf consumes pinned schema/fixture digests,
   not unchecked shape copies. Neither a relative JSON import nor an
   undeclared fs read may bypass the boundary: G7-T14's named data-reader
   subcheck statically rejects other fs reads into `packages/` and requires
   these exact owner-selected schema paths/digests through the declared reader.
   Demonstrate red with an undeclared host-path read and a wrong digest, then
   green with the declared schema; this is a checked rule, not review alone.
   **Recommendation:** (b), keeping the offline leaf free of host-package
   imports while making receipt-shape drift fail explicitly. This is a pending
   owner choice, not a selected implementation. State the chosen option in
   slice 2 and G7-T14 before resolver implementation; keep all earlier owner
   questions open.

The contract, evidence inventory, tune corpus and deterministic work
can proceed independently. Acceptance-set freeze and sealed evaluation depend
on question 3 and confirmation of question 5; closure without independent
labels depends on question 4. Uniqueness/history semantics and their G7-T10
cases, plus the transient-judgment retry contract and G7-T09/G7-T10 cases,
depend on question 6. Holdout sealing and the digest-verified slice-1b loader
arrangement depend on question 3. Recommendations are not owner decisions.
Slice 2 and its G7-T14 refinement, including the Q7(b) schema/parity-test
location and ownership sub-question, depend on question 7. The slice-1b
G7-T14 baseline does not.
Naming, id format and holdout protection remain technical contracts; the
sibling-leaf dependency assumption must be resolved before slice 5 as above.

## Verification performed for this plan

The tables below retain check evidence, not commit/staging status. Results
through plan7 are historical. The first table describes the original plan at the
inspected `e35767b` baseline. Later tables describe subsequent review revisions;
for the plan7 revision, only the plan7 table records checks for this update.
The plan8 table is also historical; the plan9 table records the current
follow-up checks. Commit outcomes belong outside this file.

| Check                                                | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Root-plan acceptance check before writing            | Failed as intended: `WV-195 plan acceptance red: root PLAN.md is absent`. This is documentation acceptance evidence only, not G7 classifier red.                                                                                                                                                                                                                                                                   |
| Plan acceptance after writing                        | Passed: all 60 explicitly checked existing file paths resolve, required topics and G7-T01–T14 are present. Reviewed proposed files separately from existing inventory.                                                                                                                                                                                                                                             |
| `npm run verify`                                     | Ran; exit 1 in initial `check`: `scripts/benchmark-digests.test.mjs` passed; `scripts/verify-cached.test.mjs` failed. Direct diagnosis found missing `node_modules/.bin/vp` (`ENOENT`) and the cache-interruption fixture timing out waiting for its child. Later verify stages were not reached.                                                                                                                  |
| Dependency/runtime diagnosis                         | `node v20.19.2`, `npm 11.21.1`; repository requires Node >=22.18.0 and npm >=10. No local `node_modules`; `npm run build` failed exit 127, `tsc: not found`. Package tests, TS execution, web builds and full verification therefore remain unverified. No dependency/lockfile edits or global installs were made for this docs-only task.                                                                         |
| Every top-level `checks/*.mjs`, invoked directly     | `import-direction.mjs` passed (325 files); `no-ambient-clock.mjs` passed (104 runtime files); `no-ambient-entropy.mjs` passed (51 Loom files); `no-ambient-env.mjs` passed (133 package sources); `no-swallowed-failures.mjs` passed (12 package/workflow files); helper `source-scan.mjs` loaded successfully (no standalone assertions).                                                                         |
| `npm run test:checks`                                | Ran; exit 1: Node 20 did not expand the quoted `checks/test/*.test.mjs` glob. Also ran with explicit filenames and each test file directly; this did not produce a full green suite.                                                                                                                                                                                                                               |
| `checks/test/credential-parity.test.mjs`, direct     | Passed 2/2 tests.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `checks/test/execution-provider.test.mjs`, direct    | Passed 30/30 tests. Helpers `checks/fixtures/execution-provider/{contract,doubles}.mjs` also loaded directly, exit 0.                                                                                                                                                                                                                                                                                              |
| `checks/test/checks.test.mjs`, direct                | Failed 6/6 because its child `spawnSync` output was unavailable. A minimal child invocation returned `spawnSync /usr/bin/node EPERM`; this environment blocks that nested execution path. The exact red and green fixture invocations were then run directly: all three red roots exited 1 with the expected findings and all three green roots exited 0. This diagnostic does not turn the failing harness green. |
| `checks/fixtures/execution-provider/red.mjs`, direct | Intentional red: 10 assertion failures, zero skips, exit 1. Existing execution-provider fixture evidence only, not classifier quality evidence.                                                                                                                                                                                                                                                                    |

The `336f4ff` review-revision checks used Node `v22.23.4` at
`/home/box/.local/node22/bin`, with no network or dependency installation:

| Check                                  | Observed result / blocker                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review acceptance and diff checks      | The eight review-topic documentation checks failed before editing and passed afterward; G7-T01–T14 remain present. `git diff --check` passed and only `PLAN.md` changed. This is plan acceptance evidence, not classifier red/green. |
| Every top-level `checks/*.mjs`, direct | All five gates passed with the same source counts listed above; `source-scan.mjs` loaded, exit 0.                                                                                                                                    |
| `npm run verify`                       | Attempted with Node 22; exit 1 in `check`. Benchmark-digest tests passed, verify-cache tests failed. Direct diagnosis again found missing `node_modules/.bin/vp` (`ENOENT`); later verify stages were not reached.                   |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider test files passed; `checks.test.mjs` failed. Direct execution showed unavailable child-process output in five fixture assertions (one passed). The suite remains failing.           |

Plan3 checks used Node `v22.23.4` at `/home/box/.local/node22/bin`, offline
with no dependency installation or source, schema, glossary or test edits:

| Check                                  | Observed result / blocker                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | All eight checks failed before editing and passed afterward; all G7-T01–T14 remain named. This checks the plan, not classifier behavior or quality.                                                                          |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                           |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                               |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed, verify-cache tests failed; later stages were not reached. No local `node_modules`; a direct local `vp` probe returned `ENOENT`. Full verification remains blocked. |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed, `checks.test.mjs` failed. Direct diagnosis reproduced five failures with unavailable child-process output and one pass; no harness was changed.               |

Plan4 checks used Node `v22.23.4` at `/home/box/.local/node22/bin`, offline,
with no dependency installation or source, schema, glossary or test edits:

| Check                                  | Observed result / blocker                                                                                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | Seven change checks failed before editing; the preservation check for `isId`, G7-T01–T14 and the learning notes already passed. All eight checks passed afterward. This checks the plan only, not classifier behavior or quality. Retry and sealing alternatives remain open owner decisions. |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                                                                                            |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                                                                |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed, verify-cache tests failed; later stages were not reached. No local `node_modules`; a direct local `vp` probe returned `ENOENT`. Full verification remains blocked.                                                                  |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed; `checks.test.mjs` failed. Direct execution reproduced five failures with unavailable child-process output and one pass. No harness was changed.                                                                                |

Plan5 checks used Node `v22.23.4` at `/home/box/.local/node22/bin`, offline,
without dependency installation or source, schema, glossary or test edits.
These describe the plan5 working tree based on `29a21f8`; they are
historical evidence, not fresh results for this update.

| Check                                  | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | Eight review-topic checks failed before editing; the preservation check already passed. All nine pass after editing (the temporary checker normalizes wrapped prose). All G7-T01–T14 and the three learning notes remain present. This is plan acceptance only, not classifier behavioral red/green or quality evidence. Q1–Q6 stay open; Q7 adds the unresolved resolver/import choice with options and a recommendation. The trap-isolation note is tracked only as a follow-up. |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                                                                                                                                                                                                                                                     |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed, verify-cache tests failed; later stages were not reached. Direct cache-test diagnosis reports missing `node_modules/.bin/vp` (`ENOENT`); no local `node_modules` exists. Full verification remains blocked.                                                                                                                                                                                                              |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed; `checks.test.mjs` failed. Direct execution produced five failures from empty child-process output and one pass. A minimal Node child probe reports `EPERM` with empty output; a local `vp` probe reports `ENOENT`. No harness or permissions were changed.                                                                                                                                                          |

Plan6 checks used Node `v22.23.4` at `/home/box/.local/node22/bin`, without
dependency installation or source, schema, glossary or test edits:

| Check                                  | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | Nine change checks failed before editing; the question/test preservation check already passed. All ten pass after editing. This is documentation acceptance only, not classifier behavioral red/green or quality evidence. G7-T01–T14 remain; G7-T15 is assigned to slice 3. Q1–Q7 remain open, including Q7(b)'s schema/test location and ownership. D-ENG-017 is explicit.                                                                                                                                                                                        |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Main freshness                         | Historical plan6 check: cached `origin/main` was `e35767b`; `439cea6` was unavailable in that earlier worktree, fetch failed on read-only `FETCH_HEAD` and remote lookup failed DNS. Historical plan8 inspection used `f24b99f`, containing `0311340` and `439cea6`; plan9 supersedes main freshness with `e4dc5e1`. Only the Fabric store/tests, verify-cache tests, `vite.config.ts` and `package.json` changed from `e35767b`; the changed Fabric seam was separately reinspected as described above. See plan9 for this task worktree's current rebase blocker. |
| `npm run fmt:check`                    | Exit 127: `vp: not found`; no local `node_modules`. Formatting and whether the formatter covers `PLAN.md` remain unverified. No formatter configuration was changed.                                                                                                                                                                                                                                                                                                                                                                                                |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed, verify-cache tests failed; later stages were not reached. The local `vp` probe reports `ENOENT`; full verification remains blocked.                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed; `checks.test.mjs` failed. Direct execution showed five failures with unavailable child-process output and one pass. A child-process probe reports `EPERM`; no harness or permissions were changed.                                                                                                                                                                                                                                                                                                   |

Plan7 checks used Node `v22.23.4` at `/home/box/.local/node22/bin`, without
dependency installation or changes outside `PLAN.md`:

| Check                                  | Observed result / blocker                                                                                                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | All nine review-topic checks failed before editing and pass afterward; the Q1–Q7/G7-T01–T15 preservation check passed throughout. This is plan acceptance only, not classifier behavioral red/green. Every owner question remains open.                    |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                                                         |
| `npm run fmt:check`                    | Exit 127: `vp: not found`; no local `node_modules`. Formatter execution and its coverage of `PLAN.md` remain unverified; no formatting configuration was changed.                                                                                          |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                             |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed; verify-cache tests failed. Direct diagnosis reports missing `node_modules/.bin/vp` (`ENOENT`); later verify stages were not reached.                                                             |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed; `checks.test.mjs` failed. Direct diagnosis reproduced five empty-child-output fixture failures and one pass; a child-process probe reports `EPERM`. No harness or permissions were changed. |

Plan8 checks used Node `v22.23.4` and npm `10.9.9` from
`/home/box/.local/node22/bin`. Only `PLAN.md` changes in this worktree.
Historical plan8 evidence, recorded in `f0f0f04`, used an archive of inspected
`f24b99f` plus that revision's plan. The borrowed Vite+ version was `1.2.0`;
it matches the lockfile pin at `f24b99f` and `e4dc5e1`. No dependency installation
or configuration change was required. Archive checks do not establish a branch
rebase or authoritative formatter evidence on the rebased branch. Plan9 below
records checks on this worktree and the remaining rebase requirement.

| Check                                                           | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance                           | Six review-topic checks failed before editing and pass afterward; both preservation checks pass. Q1–Q7 are textually unchanged apart from formatting, G7-T01–T15 remain present, and D-ENG-017 remains scoped to #329 with no G7 rename dependency. This is documentation acceptance only.                                                                                                                                                                                                                                                                                                                                                    |
| Main freshness and rebase                                       | Historical plan8 check at `f24b99f` (not current main); comparison against `e35767b` found exactly the five files listed above. Inspected the changed store and tests; `FabricStore` remains exported at line 191 and retains its receipt-source role. Both prerequisite ancestor checks passed. Before editing, the task branch was clean and its entire branch diff was `PLAN.md` only. Rebase onto `f24b99f`, using the clone's objects read-only, failed creating `rebase-merge`: read-only git metadata. Fetch likewise failed on read-only `FETCH_HEAD`; remote lookup failed DNS. Rebase remains blocked and is required before merge. |
| `npm run fmt:check`                                             | Direct worktree invocation lacks local `vp` (exit 127). In the historical `f24b99f` archive, the initial check identified only `PLAN.md` as unformatted. Formatted only the plan at configured printWidth 120; full `npm run fmt:check` passes on 506 files. Explicit `npm run fmt:check -- PLAN.md` also passes on one file, proving plan coverage. Those checks apply to the plan8 bytes recorded in `f0f0f04`; they do not prove formatting on a rebased branch.                                                                                                                                                                           |
| Every top-level `checks/*.mjs`, direct in the `f24b99f` archive | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run verify`, historical `f24b99f` archive                  | Exit 1: the new leading `fmt:check` passes; benchmark-digest tests pass; verify-cache tests fail. Direct cache diagnosis passes 3/7 tests, with three read-only-cache initialization failures and an interruption-fixture timeout. Later verify stages were not reached. Full green remains unverified; no checks or permissions were weakened.                                                                                                                                                                                                                                                                                               |
| `npm run test:checks`, historical `f24b99f` archive             | Exit 1: credential-parity and execution-provider test files pass; `checks.test.mjs` fails. Direct diagnosis reproduces five empty-child-output assertion failures and one pass. A minimal child-process probe reports `EPERM` and empty output.                                                                                                                                                                                                                                                                                                                                                                                               |
| Scope and whitespace                                            | `git diff --check` passes; only `PLAN.md` changes. No commit outcomes are recorded here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Plan9 checks use Node `v22.23.4` and npm `10.9.9`. The borrowed Vite+ `1.2.0`
matches the lockfile pin at both inspected `f24b99f` and current `e4dc5e1`.
Only `PLAN.md` is edited. Formatter checks below target this worktree's bytes;
an explicit `--config` uses a byte-identical copy of this branch's
`vite.config.ts` with a writable config cache and the matching borrowed tool.
The config is unchanged between this branch, `f24b99f` and `e4dc5e1`.
Moving the config changes the base for relative ignore patterns; the full check
therefore also passes each existing `fmt.ignorePatterns` entry as an explicit
negated repo-relative path glob (directory entries expand to `/**`). No new
exclusions are added. A config-copy-only full check failed on 27 files normally
excluded by the repository config; none of those files was changed.
No dependency installation or repository configuration change is needed.
These checks cannot substitute for `npm run fmt:check -- PLAN.md` and full
`npm run fmt:check` on the rebased branch in a writable dependency environment.

| Check                                                                 | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance                                 | Seven review-topic checks failed before editing; the preservation check passed. After editing, all eight pass: Q1–Q7 remain textually unchanged apart from formatting; G7-T01–T15 and D-ENG-017 remain present. This is documentation acceptance only, not classifier behavioral evidence.                                                                                                                                                                    |
| Main freshness and rebase                                             | Before editing, the branch was clean and its entire branch diff was `PLAN.md` only. `origin/main` is `e4dc5e1`; `git diff --name-only f24b99f e4dc5e1` lists only `scripts/verify-cached.test.mjs`, including `444c0d0` and #378. The prerequisite ancestor checks pass. `git rebase origin/main` failed creating `rebase-merge`: read-only git metadata. Merge-base remains `e35767b`; rebase and authoritative post-rebase formatter checks remain blocked. |
| Formatter invocation                                                  | Plain `npm run fmt:check -- PLAN.md` with the borrowed binary on PATH fails loading local `vite-plus` and creating the config cache because this worktree has no local dependencies. The explicit byte-identical `--config` copy allows formatting checks of the actual worktree files without editing repository configuration.                                                                                                                              |
| `npm run fmt:check -- PLAN.md --config <config-copy>`                 | Passes on the actual worktree `PLAN.md`, one file, proving coverage with Vite+ `1.2.0` and the unchanged configured printWidth 120. This is not a post-rebase check.                                                                                                                                                                                                                                                                                          |
| Full `npm run fmt:check` with the config copy and existing exclusions | Passes on 506 files, including `PLAN.md`, with only the existing ignore patterns mirrored as explicit negated globs as described above. The plain post-rebase command remains required.                                                                                                                                                                                                                                                                       |
| `npm run verify`                                                      | Exit 1 in initial `check`: benchmark-digest tests pass; verify-cache tests fail. This branch before rebase still has the original verify command without the later leading formatter gate. Local dependencies are absent; later verify stages were not reached. No checks or permissions were weakened.                                                                                                                                                       |
| Scope and whitespace                                                  | `git diff --check` passes; only `PLAN.md` changes.                                                                                                                                                                                                                                                                                                                                                                                                            |

Full green must be established in the supported Node/dependency environment
before implementation PRs merge. Do not change scripts, suppress failures or
relax policy to hide these blockers. Current uncertainties are missing causal
inventory in some historical runs, independent label availability, and the
generalization of a small labelled set; G7 must report each rather than claim
unsupported attribution accuracy.
