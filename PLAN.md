# WV-195 — Gauge G7 failure attribution

Planning deliverable only for [#195](https://github.com/CrowBe/weave/issues/195),
part of [Gauge #182](https://github.com/CrowBe/weave/issues/182). This task
changes only this file. Implementation, tests, schemas and glossary edits belong
to the later slices below. No live benchmark or hosted inference is requested
or performed by this planning task.

## Verified baseline and dependencies

Review provenance (external input; the review reports are not in this
repository and cannot be verified from it): plan19 addresses all four
`auto-fix` findings of the GLM review of `4b7d46f` (one warning, three notes):
(1) the session-local `0281c5e` fetch-state note, now replaced by
SHA-reproducible freshness facts and a seam-path freshness gate; (2) the
undefined `g7.claim` row, now a closed row shape with explicit run/attempt
exclusion and cross-run idempotence cases; (3) abstention participation in the
claims journal, now one ledger for every committed record with an
abstention-then-attribution case; (4) Q7's boundary mechanism, now a D-ENG-021
recommendation selected for implementation, leaving only host enumeration and
path confirmation to the owners. Its disposition table follows the owner
questions. Plan18 addressed all nine
`auto-fix` findings of the Claude review of `ba58a2d`: (1) the path-unbound
journal filesystem capability, now confined to the `run-journal.ts` wrapper and
the structural filesystem paragraph; (2) decision-sites' cost/reservation index
over G7 rows, now a closed `g7.*` record namespace; (3) the holdout-set
synonym, now **Holdout** naming; (4) cross-run claim serialization, now a shared
claims journal under the existing lock; (5) the missing build step in
`test:failure-attribution`; (6) exact lint rule ids and scope; (7) the
`EvalError` assertion form in `imports.test.ts`; (8) the contradictory `0281c5e`
baseline notes; (9) this provenance note. Plan16/plan17 addressed the six
findings of the review of `64da02e`: the free-global gate, structural fs
permissions, explicit lint evidence, the single AST pass, the per-file
table/forbidden built-ins/extension and import-attribute rules, and the
refreshed baseline. Engineering choices below are concrete recommendations
under D-ENG-021; Q1–Q6's existing product/custody/authority decisions remain
open, and Q7 now asks only which hosts participate and whether their owners
accept the proposed paths.

Plan19 rechecked the reviewed seams against review target HEAD `4b7d46f`:
`git diff --name-only ba58a2d 4b7d46f` lists only `PLAN.md`, and plan18
recorded the same seams at `ba58a2d` (only `PLAN.md` changed since `64da02e`,
itself only `PLAN.md` since `3384b57`):
Weft's public `isDigest` (`packages/weft/src/index.ts`), Gauge's
public `recordDigest` (`packages/gauge/src/index.ts`), the decision-sites journal
and its static/dynamic test imports, `checks/import-direction.mjs`,
`vite.config.ts`, `package.json` and `.github/workflows/verify.yml`.
The G7 leaf and its tests below remain proposed. At this HEAD, `lint` is
`vp lint`; its `lint.ignorePatterns` (`vite.config.ts:7`) do not exclude the
proposed TypeScript leaf, and the config has no `lint.rules` or `jsPlugins` key,
so no evaluator rule is configured yet. `lint` is **not** part of `verify`
(`package.json` `verify` starts with `fmt:check` and never runs `lint`); CI runs
`npm run verify`, then `npm run lint`, then `npm run fmt:check` as separate steps
(`.github/workflows/verify.yml:18-20`, `node-version: 22`). The ambient checks are
package-scoped: `checks/no-ambient-env.mjs` walks only `packages/<name>/src`
(lines 57-61), and the `SCANNED` arrays of `no-ambient-clock.mjs` and
`no-ambient-entropy.mjs` list only package `src` directories. None covers
`benchmarks/`, so the leaf's env, clock and entropy purity is enforced by its own
free-global allowlist below, not by those checks; this plan does not extend them
to the leaf. `package.json` requires Node `>=22.18.0`; local Node `v22.23.4`
confirms that both `process.getBuiltinModule` and `process.binding` are functions,
which is why `process` is a member-restricted global below. The lockfile pins
TypeScript `7.0.2`: its root entry is version-only, so the scanner must use the
exported `typescript/unstable/sync` and `typescript/unstable/ast` APIs, not assume
classic `createSourceFile`/`createProgram` exports. A matching borrowed installation
provides `API`, `program.getSourceFile`, `checker.getSymbolAtLocation`, declaration
`path` handles and `Node.forEachChild`; the temporary scope probe described below
checks ambient versus local bindings without executing the inspected source.
`fmt:check` is `vp fmt --check` and does not exclude `PLAN.md`. Local
`node_modules` is absent; the proposed rules and their effective leaf scope must
still be established by the slice-1b lint-scope test.

**Freshness (plan19).** This plan records only freshness facts reproducible
from the reviewed commit itself: `git merge-base --is-ancestor e4dc5e1 4b7d46f`
succeeds and `git diff --name-only e4dc5e1 4b7d46f` lists only `PLAN.md`. Where
`main`/`origin/main` point, and whether a newer-main object is present, are
properties of each clone's fetch state, not of `4b7d46f`. Earlier rounds
recorded them and contradicted one another (plan11 saw `0281c5e` locally; the
plan16–plan18 sessions did not; the review of `4b7d46f` saw it as both `main` and
`origin/main`). This plan therefore no longer asserts ref positions or object
absence, and the plan18 "absent object / plan11-historical" framing is retired.
Newer main `0281c5ed13ee0b3fbedd50399f9ed19837a58c17` (#380) has two
consistent external observations: the plan11 session and the review of `4b7d46f`
each found it to be one successor of `e4dc5e1` whose
`git diff --name-only e4dc5e1 0281c5e` is exactly `scripts/verify-cached.test.mjs`.
The plan19 session could not resolve the object and was not permitted to fetch,
so it neither confirms nor contradicts them. **Rebase/merge implication:** that
path is outside every inspected seam, and this branch differs from `e4dc5e1` only
in `PLAN.md`. This planning branch therefore needs no rebase or merge for
`0281c5e`: as observed, the two diffs from `e4dc5e1` share no path, so the
branch merges into `0281c5e` without conflict. Because the freshness finding has
recurred across review rounds, it is now a mechanical gate rather than prose.
As the first step of every implementation-slice PR, merge current `origin/main`
and run
`git diff --name-only e4dc5e1 origin/main -- packages/gauge packages/weft benchmarks/decision-sites GLOSSARY.md checks/import-direction.mjs packages/weave/src/implement-step.ts packages/weave/src/journal.ts packages/weave/src/weft.ts packages/gateway/src/weft.ts packages/agentfabric/src/weft.ts packages/agentfabric/src/store.ts vite.config.ts package.json .github/workflows/verify.yml`.
Record the output in the PR. Empty output keeps the inventory below applicable.
Any listed path requires reinspecting that seam, and updating this plan where the
seam changed, before the slice relies on it. A clone that cannot fetch reports
that blocker instead of asserting a ref position.

The inventory was inspected at `f24b99f0868aadd26f01063f7d3471e9e1021cd0`,
five commits after the original inspection at
`e35767b74a0118bf7e806747e4ae89bdb9053d06`, including `0311340` and `439cea6`.
The incorporated main baseline is
`e4dc5e16bf8d1ad25d18c9d7041066a9fa982883`. Both `444c0d0` and its successor
`e4dc5e1` change only `scripts/verify-cached.test.mjs` since `f24b99f`.
Newer main `0281c5e` is covered by the freshness paragraph above; compare with
`git diff --name-only f24b99f e4dc5e1` here.
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
The branch incorporates `e4dc5e1` through merge `eba7634`; `e4dc5e1` is a
verified ancestor of `4b7d46f`. The freshness requirement for that baseline
is met by merging rather than rebasing; the earlier rebase failures below are
historical. At `eba7634`, `package.json`'s `verify` starts with `npm run fmt:check`.
Plain `npm run fmt:check` and `npm run verify` still need to run on the merged
branch in a dependency environment. No merge of newer main is included in this
PLAN.md-only change; see the freshness paragraph above for `0281c5e` and the
per-slice seam-path gate.
The original inspection recorded both prerequisite PRs merged with base `main`;
ancestor checks against the pinned baseline confirm their presence:

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

| Existing seam                            | Exact owner and intended reuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attribution and evaluation contracts     | `packages/gauge/src/types.ts`: `FailureAttribution`, `AttributionCategory`, `EvidenceRef`, `EvaluationResult`, `Context`, `CaseSet`, `Revision`, `CriteriaSet`, `InfoCriteriaSet`, `InfoResult`, `Produced`. `packages/gauge/src/validate.ts`: public `validate`, private `validateAttribution` and `SIGNALS`. `packages/gauge/src/index.ts` currently exports no attribution producer/classifier.                                                                                                                                    |
| Attribution rules already enforced       | `packages/gauge/src/GAUGE-CONTRACT.md`, section `gauge.attribution@1`; `packages/gauge/test/{contract,validate,governance,info}.test.ts` and `packages/gauge/fixtures/records.json`. The validator checks shape/binding, not the truth of a cited cause or case membership in external evidence.                                                                                                                                                                                                                                      |
| Evaluation/report production             | `packages/gauge/src/produce.ts`: `evaluate`, `evaluateInfo`; `stats.ts` supplies deterministic aggregation/interval machinery; `digest.ts`: `recordDigest`. `benchmarks/decision-sites/gauge.ts`: `gaugeContext`, `scoreReport`, `reported`; `weft.ts`: `attemptRecords`; `recorded.test.ts` proves exact report parity, read-only replay and concurrent scoring.                                                                                                                                                                     |
| Weft evidence                            | `packages/weft/src/types.ts`: `WeftRecord`, `KindFields`, `Evidence`, `Link`, `Candidate`, `Exclusion`; `validate.ts`: `validateRecord`; `serialize.ts`: `serializeRecord`. Public package entry points are `@weave/weft` and `@weave/weft/sqlite`, not relative imports into internals.                                                                                                                                                                                                                                              |
| Durable Weft intake                      | `packages/weft/src/sqlite.ts`: `TraceStore`, `openTraceStore`, `importRecords`, `importJsonl`, transactional identity/conflict handling. `packages/weft/test/sqlite.test.ts` covers torn lines, cancellation, concurrent connections, rollback, durable reopen and process death. This store accepts Weft/legacy trace records, not Gauge attribution records.                                                                                                                                                                        |
| Durable benchmark receipts               | `benchmarks/decision-sites/journal.ts`: `Journal`, `acquireLock`, `replayKey`, `ledger`; `engine.ts`: `execute`. `harness.test.ts`, `engine.test.ts` and `recorded.test.ts` cover fsync, locks, receipt binding, cancellation and uncertain spend. Keep these leaf-owned; Gauge must not import this benchmark.                                                                                                                                                                                                                       |
| Authoritative check and runtime evidence | `packages/weave/src/implement-step.ts`: `CheckEvidence`, `AttemptRecord`, `FileAttemptJournal`, `replayImplementationStep`, `createEqualGrantIssuer`. `packages/weave/src/journal.ts`: `ObservationJournal`, `FileJournal`. `packages/weave/src/types.ts`: `CrystallizationSearch` (`matches`, `compositions`, `informed_by`); `scheduler.ts`: `select`. These are producer inputs translated at composition from serialized receipts under the selected Q7 boundary, never Gauge dependencies; host objects are not passed to Gauge. |
| Routing and authority                    | `packages/gateway/src/routing.ts`: `route`, `RoutingDecision`, `RouteExclusion`; `packages/agentsop/src/grants.ts`: `GrantAuthority`, `createGrantAuthority`, `markInvoked`; `packages/agentfabric/src/store.ts`: `FabricStore`. Use recorded policy/authority decisions, never rerun an effect to explain a failure. Receipt translation uses the selected Q7 serialized-receipt boundary; only the participating hosts and paths await Q7.                                                                                          |

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
never generates it from ambient time or entropy. `run_id` is required on
initialization and restart. Acquire the writer lock first: construct/open a
writable `Journal` only after `acquireLock` succeeds, because its constructor
can truncate a torn tail or append a missing newline. Restart after process death
requires the existing explicit operator inspection and lock removal before a
fresh `acquireLock` succeeds; a dead owner's lock causes stale-lock refusal
(or stale-unknown when ownership cannot be established). Preserve no-steal:
no automatic stale-lock reclamation, and do not change `Journal`/`acquireLock`
lock, truncation or newline semantics; a move under the reuse decision must keep
that behavior, with existing decision-sites lock/replay test bodies and assertions unchanged
except for import-specifier updates required by the move, and green; leave no re-export shim.
Static and dynamic `import()` specifiers count as import-specifier updates, including
those in tests. The owner must record a whole-file move or a split before reuse;
a split must keep decision-sites' cost/ledger exports and semantics unchanged,
as detailed in the reuse assumption below. This plan selects neither scope.
If the owner's reuse decision keeps `journal.ts` in place, decision-sites remains unchanged.
Before any bundle binding or attempt, durably append the G7 leaf's closed header
record `{type: 'g7.run_header', schema: 'g7.run_header@1', run_id}` under that
lock. All three fields are required, no extra fields are accepted, and `run_id`
must satisfy Weft `isId`. The header must be row 0 and unique: reject a second
header, even an identical one. This is a leaf validation contract layered over
the generic JSONL `Journal`, which has no built-in header concept. Restart
must reuse the recorded `run_id` from that directory; an omitted or mismatched
supplied id fails closed before evidence resolution, binding or dispatch.
An invalid header or a missing header with committed journal rows also fails
closed. Under the existing journal policy, only an unparseable final line is
truncated; a complete, parseable final line without a trailing newline is
committed, and a writable load appends the newline under the lock. Thus a
complete valid header without newline retains its recorded id. An unparseable
first header truncated to an empty journal counts as **no committed header**.
As with an empty journal or directory, it may be initialized under the lock
with the required supplied id, even if different from the uncommitted one:
no binding, attempt or claim could have been committed before the header.
Never silently allocate a fresh id for a restart with a committed header.
The run-scoped binding does not
establish a cross-run binding keyed by (result, case[, revision]). A fresh run
may resolve a different bundle, but before accepting an id/claim it must pass
the Q6 uniqueness/history check across run directories, using the
owner-selected (result, case) or (result, case, revision) key regardless of bundle
digest. A new digest/id cannot bypass that check. **Recommendation (engineering,
D-ENG-021):** serialize every claim commit through one shared claims journal,
`<eval-root>/claims/claims.jsonl`, guarded by `acquireLock(<eval-root>/claims)`
with the existing no-steal semantics, as specified under durability below. Q6
selects only the key and the history/supersession policy; the serialization
mechanism, the closed `g7.claim` row shape and abstention participation are
fixed here and frozen in the leaf `CONTRACT.md` in slice 5 before the claims
journal first executes. Every committed `FailureAttribution`, including a
deterministic `unattributed` record with basis `none`, is a `g7.claim` row and
passes the same locked Q6 check. There is no separate abstention ledger, and an
abstention has neither an exemption from nor a priority over the owner's key and
history policy. A transient timeout/cancellation abstention still persists no
claim until Q6 settles its retry contract. Restart and replay rebuild only
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

Build and freeze the labelled holdout independently of classifier
implementation and **before any comparative holdout run**. If owner Q3/Q5
are pending, development-only work can proceed on the separate tune split;
a later holdout freeze must independently reserve unseen
scenario/source lineages, including adversarial cases. No holdout quality
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

The entire holdout is excluded from prompt, rule, threshold and model
tuning. Reuse **Tune split** for the separate scenario-disjoint cases used to
develop rules and select thresholds, with governed
`CaseSet`/`Revision` digests. Commit only holdout-set digests, the manifest
and label-free inputs for the holdout. Holdout labels and rationales
live outside the implementer-readable repo, or encrypted with an evaluator-held
key; committing readable labels is forbidden. Owner question 3 selects the
sealing arrangement and custodian. The slice-1b loader verifies sealed labels
by digest before evaluation, refusing missing or mismatched artifacts without
exposing their contents to the implementer. Every manifest stored-byte digest,
including the sealed-label entry, and the code-pinned manifest anchor must satisfy
Weft `isDigest`: `sha256:<64 lowercase hex>`. Use exact string equality with
no normalization, prefix stripping, case folding or padding; the attribution-id
rule's prefix stripping does not apply to these digests. Define one leaf helper
`storedByteDigest(bytes: Uint8Array)` in **new** `stored-byte-digest.ts`: return
`sha256:` plus the 64 lowercase hex characters of SHA-256 over the raw stored
bytes, with no decoding, JSON canonicalization or newline conversion. Use it for
manifest/artifact stored-byte digests and the code-pinned manifest anchor.
The existing `benchmarks/decision-sites/journal.ts` `digest` returns bare hex;
it must not produce manifest, anchor or independent digests, even if reused or
moved. Gauge's public `recordDigest` remains the canonical-JSON helper for the
independent holdout-set digest, not raw stored bytes. Add `bare-hex manifest entry refuses`
in `reader.test.ts`: use an otherwise valid synthetic manifest/anchor/artifact
triple whose entry contains bare hex, so digest-format validation is the refusal
reason. A correctly prefixed matching-entry positive control must pass.
For the sealed-label artifact only its stored-byte digest is pinned in the
manifest; the evaluator supplies its path at evaluation time through slice-5
`run.ts`, the only production injector into the declared reader described below.
Production sealed evaluation requires `run.ts` inputs
`{sealedLabelPath: string, sealedLabelDigest: string, holdoutSetDigest: string}`:
the evaluator's path and independently held digests from the signed-off freeze.
Both independent digests must satisfy `isDigest`. The path and digests may come
from explicit runner options; any decryption key comes separately through
existing secret injection. Before slice 5, slice-1b tests and positive controls
exercise the core verifier with synthetic manifest/anchor/artifact triples,
including temporary sealed artifacts, only in the exact test file enumerated
below; they need no production runner or real holdout labels. The 1b production
manifest has no sealed-label entry until the Q3/Q5 holdout freeze; production
sealed evaluation refuses while it is absent.

At freeze, adding the sealed-label and holdout-set entries and updating the
code-pinned anchor requires the Q3 custodian's sign-off, once designated. The same
sign-off is required for any later addition, removal or alteration of holdout-set
label-free inputs, holdout-set digests or sealed labels, including their manifest
entries and anchor updates. Custodian sign-off is a PR review-process gate on the
artifacts, manifest and code-pinned anchor, not test behavior.
The evaluator independently retains `sealedLabelDigest` and `holdoutSetDigest`
from that signed-off freeze. Each manifest entry has exactly one required scalar
`role` from the closed enum
`holdout-input | holdout-digest | sealed-label | tune | schema | parity`.
Before artifact/independent-digest comparisons, reject missing or unknown roles,
duplicate `role` keys in the stored JSON, multiple role assignments for one path,
and duplicate canonical paths, even if their digests agree. Multiple distinct
paths may share a role (for example, multiple holdout inputs); duplicate roles
on one entry/path are invalid. The manifest anchor must be verified before any
entry is trusted. Production sealed evaluation additionally requires nonempty
`holdout-input` and `holdout-digest` sets and exactly one `sealed-label`
entry; before freeze that last entry is absent and sealed evaluation refuses.
Classify every entry by role, never filename, directory, or an implicit default.
Define `holdoutSetDigest` as `recordDigest` of the
canonical object `{domain: "gauge.holdout-set@1", inputs, holdoutSetDigests,
sealedLabelDigest}`. `inputs` and `holdoutSetDigests` are the complete lists of
manifest entries with roles `holdout-input` and `holdout-digest`
respectively, each represented as `{path, storedByteDigest}`, sorted by
canonical repo-relative path with duplicates rejected. Thus the independent digest
covers all holdout inputs, holdout-set digests and the sealed-label digest;
the evaluator-held value stays outside the covered files and the mutable
manifest/anchor update. It cannot be reconstructed as trusted input from the
current manifest at run time. Sealed evaluation consumes exactly those holdout
inputs through the reader; tune inputs cannot substitute for them.
Record the role enum, cardinality/duplicate-key rules, role-based construction and
`domain: "gauge.holdout-set@1"` (a new schema identifier) in the leaf `CONTRACT.md`
in slice 1b; this does not add a Gauge wire record or change `gauge.attribution@1`.

Before every production sealed evaluation, `run.ts` passes both independently held
digests through `sealed-labels.ts` and `reader.ts` to `reader-core.ts`. After verifying
the manifest against the code-pinned anchor, the core requires exact string equality
between `sealedLabelDigest` and the sealed-label stored-byte digest, and between
`holdoutSetDigest` and the canonical holdout-set digest computed from the
verified manifest. Check both before exposing holdout inputs or labels or producing
an evaluation report; each artifact read must also match its manifest stored-byte digest.
An absent entry or an omitted, malformed or mismatched independent digest refuses.
Neither independent digest replaces or overrides the code-pinned manifest anchor.
Routine anchor bumps may touch only entries whose roles are `tune`, `schema` or `parity`, preserving
all holdout-set entries and both independent digests. Any custodian-approved
holdout-set or sealed-label change must also update the evaluator-held
`holdoutSetDigest`, and a sealed-label change must update `sealedLabelDigest` too.
Q3/Q5 remain open. For Q3's encrypted option, pin and verify the stored bytes
(ciphertext), then verify decrypted bytes against a separately recorded plaintext
digest before evaluation. The plaintext digest source and its input contract remain
deferred to Q3; the current input shape adds no plaintext-digest field and encrypted
production evaluation cannot proceed until Q3 defines that source and its protection
under the same custodian sign-off. Any decryption key comes only through existing
secret injection, never argv, logs or journals; do not persist it in the manifest
or run header. Q3's sealing choice and custodian remain open.
Pure code reads no ambient env/argv.
The loader obtains label bytes only through that reader, retaining Q3's access
controls and sealing alternatives; the path need not be inside the repo.
Each 1b tune case also retains raw
source receipts and a frozen normalized-fact form conforming to the slice-1a
Gauge input types, with separately pinned raw-receipt and normalized-fact digests.
Place pinned corpus data, raw receipts, normalized facts, manifest and
holdout digests under `benchmarks/failure-attribution/fixtures/**` as JSON
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
Add a loader check preventing tune/holdout overlap. The classifier developer
does not read holdout labels or per-case evaluation diagnostics. An
independent evaluator runs the frozen oracle. Changes prompted by aggregate
holdout results require a fresh independently frozen holdout for the next
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
the holdout as tune just to serialize per-case attributions.

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
Resolve this explicitly before using the import: either approve a shared-location
move with its scope recorded as a whole-file move or a split of only
`Journal`/`acquireLock`, or document deliberate pinned leaf-to-leaf coupling
with a test of the required receipt, lock and replay behavior. Inspected at
`492a258`, `journal.ts` imports only node built-ins but also exports decision-sites'
`ledger`, `projectedCost`, `digest` and `replayKey`. A whole-file move carries those
exports; a split must keep decision-sites' cost/ledger exports and semantics unchanged,
including replay keys and reservation accounting. The owner must record the scope;
this plan does not choose it. **Recommendation:** deliberate pinned leaf-to-leaf
reuse of the existing `Journal`/`acquireLock`, with the receipt/lock/replay tests
specified here. This is the smallest change and avoids moving the unrelated
cost/ledger exports; record that coupling in the leaf contract before slice 5.
If a shared move is chosen instead, record whole-file versus split scope first.

Under either option the journal module is a second filesystem capability:
`new Journal(path, true).read()` parses any JSONL or single-line JSON file, and
`acquireLock(dir)` runs `mkdirSync(dir, {recursive: true})` and creates a lock
file anywhere (`journal.ts:37-41,59-95,276-282`). An unchanged `journal.ts`
cannot bind its own paths, so confine it behind one **new** leaf wrapper,
`run-journal.ts`. Its row is the only leaf row that may name the resolved
journal specifier, with named bindings `Journal` and `acquireLock` plus the pure
row function `ledger`, which opens no file and serves only the G7-T10 cost
assertion below. Its
exported API takes an opaque eval-root handle and never a file path:
`openEvalRoot(dir)` is the single path-taking entry; it requires an absolute
path, canonicalizes the existing parent and refuses a symlinked root or any
target inside the repository's `benchmarks/` or `packages/` trees. Run
directories are `<eval-root>/runs/<run-name>/` with `run-name` one segment
matching `[A-Za-z0-9_-]{1,64}`. Record files are fixed: `journal.jsonl` in a
run directory and `claims.jsonl` in `<eval-root>/claims/`; the lock is the
existing `lock` beside each. The wrapper exposes no read-only open of any other
path and no raw `Journal` or lock function. Only `run.ts`, the three
`test-children/*.ts` files and `durability.test.ts` may import `run-journal.ts`;
the test already holds explicit fs grants, so the import adds no capability.

Every G7 journal row uses a closed `g7.*` type namespace recorded in the leaf
`CONTRACT.md`. Run journals hold `g7.run_header`, `g7.bundle_binding`,
`g7.intent`, `g7.outcome_receipt`, `g7.uncertainty` and
`g7.attempt_supersession`; the shared claims journal holds only `g7.claim`.
`run-journal.ts` rejects any other type, including unprefixed `intent`, `call`
and `budget_stop`, when a journal loads and before each append, so no G7 row
enters decision-sites' `JournalIndex` cost/reservation accounting
(`journal.ts:217-259`: `reservations`, `spent`, `competitor`, `byId` keyed on
`call_id`, `budget_stop`). G7 never calls `recordsFor`, `hasCall`,
`competitorCalls` or `replayKey`; with no `call_id` or replay fields, every G7
row falls into one inert `replayKey` group. The wrapper also exports a
read-only `costIndexState()` returning `ledger(rows)` with the opened journal's
`spent()` and `budgetState().stopped`, for G7-T10 only. G7-T10's
`G7 rows bypass decision-sites cost accounting` asserts, for a run directory
and the claims journal after every crash/replay case, that all `ledger` totals
and `spent()` are zero and `stopped` is false. Its red control plants a G7
intent row typed `intent` with a `call_id` and `projected_usd`; the wrapper
must reject it on load. With only the wrapper's type check disabled as the
uncommitted red mutation, the same row must turn the zero-cost assertion red.

Required importer updates cover non-test and test
importers, including dynamic `import()` in `harness.test.ts` and `engine.test.ts`,
with test bodies and assertions otherwise unchanged. Do not adopt decision-sites' private replay keys
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
content and assert a claim-conflict error at claim commit. Its red mutation
disables only the claim conflict check, keeping the receipt check intact.
Both cases run across crash/replay, retain the original content and prove
identical-content idempotence. Do not use superseded attempts
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
writer lock alone cannot enforce that check, so claims live in one shared claims
journal, not in run journals. To commit a claim, a run that holds its own run
lock calls `acquireLock(<eval-root>/claims)`, constructs a writable claims
`Journal` only after that succeeds (a new lock tenure reloads disk, so the check
sees every earlier commit), checks the owner-selected Q6 key over all committed
`g7.claim` rows, appends one `g7.claim` row (or accepts an identical row as
idempotent), then releases. Lock order is always run lock, then claims lock, so
runs cannot deadlock.

**`g7.claim` row (engineering, D-ENG-021).** The row is closed; every field is
required and no extra field is accepted:
`{type: 'g7.claim', schema: 'g7.claim@1', id_inputs, attribution}`.
`id_inputs` is exactly the id preimage above without `domain`:
`{result, case, evidence_bundle_digest, classifier_revision, rule_revision,
prompt_revision, model_revision, judgment_request_digest}`. `attribution` is the
validated `FailureAttribution` record. On load and before append the locked
check recomputes `attribution.attribution` from `id_inputs` and requires
`id_inputs.result`/`case` to equal the record's. A mismatch fails closed. Either
pending Q6 key, (result, case) or (result, case, revision) over the four
revision digests, is therefore evaluable from the claims journal alone. The row
carries no `run_id`, `attempt_id`, run-directory name, ordinal, timestamp or
other run-local field. It is a pure function of the committed bundle binding,
the injected revisions, the frozen request and, for judgment, the committed
outcome receipt. Run/attempt provenance stays in the run journal:
`g7.bundle_binding` carries `run_id` and the case, and `g7.outcome_receipt` carries
`{run_id, case, attempt_id}` and the attribution id. A judgment claim's
`evidence` cites that attempt's receipt. Compare rows by `recordDigest` of the
parsed row, not raw line bytes, because `Journal.append` writes
`JSON.stringify` insertion order (`journal.ts:96-99`). The same attribution id
with an equal row digest is idempotent: append nothing and cite the committed
row, whose content is never rewritten. The same id with a different digest is the
claim-layer conflict refusal. A different id under the same Q6 key follows the
owner's Q6 history policy. Consequences:

- A deterministic or `none` claim with a given id has the same bundle and so
  the same evidence. Two runs, or a replay after crash, that reach that id
  produce rows with equal digests and are idempotent. Only the first commit
  appends.
- A judgment claim cites a per-attempt receipt, so two runs that each dispatched
  the same frozen request would build different rows under one id. The
  attribution id uses only pre-judgment inputs, so before writing a judgment
  intent the run (holding its run lock) acquires the claims lock, checks
  whether that id is committed, then releases. If the id is committed, the run
  writes no intent, dispatches nothing and cites the committed row. A
  `Run directory locked` refusal at this probe also writes no intent. The probe
  releases before dispatch so a slow call never blocks other runs' commits. Two
  runs that both pass the probe race to commit. The second gets the claim-layer
  conflict refusal and ends with an explicit incomplete result. Its receipt and
  reservation are retained as evidence; nothing is released or replaced. A
  crash between probe and intent leaves nothing, and replay probes again.
- Within one run, Q6(a) retries share the id, and the attempt supersession
  check-and-set already allows only one eligible attempt to claim. Under Q6(b),
  each run's attempt ordinal enters the request digest, so equal ordinals in
  two runs still share an id and the probe applies unchanged.

G7-T10 adds three named claims-row cases. Each runs across crash/replay and
asserts the claims journal's row count and digests:
`cross-run identical claim is idempotent` uses two run directories under one
eval root with byte-identical bundles and revisions on the deterministic path.
The second run commits nothing, cites the first row and leaves exactly one row,
including after a SIGKILL of the second run before it reports. Its uncommitted
red mutation widens the closed shape to carry the committing `run_id`, so the
second commit is refused as a conflict.
`already-claimed judgment id dispatches nothing` has run A commit a judgment claim.
Run B, with the same frozen request, records zero calls on the injected judgment
fake, writes no `g7.intent` and cites A's row. Its red mutation disables only the
probe, which yields one call and a claim-layer conflict.
`concurrent same-id judgment commits refuse the second` uses an injected barrier
after both probes. The first row is retained, the second commit is refused, and
the second receipt and reservation remain. Abstention participation adds
`abstention then attribution follows the Q6 key`. It commits a deterministic
`unattributed` claim for (result, case) at revisions R from bundle B1. A fresh
run then attributes at R from B2, where newly arrived Weft records change the
bundle, and another run attributes at newer revisions R'. The case pins both
pending variants, plus the symmetric attribution-then-abstention order. Under
(result, case), the R' claim supersedes the abstention, which is retained as
history. Under (result, case, revision), the R' claim sits beside it. The
same-revision R/B2 outcome is whatever Q6 decides for any same-key,
different-bundle claim, applied identically whether the predecessor is an
abstention or an attribution. Both variants assert that the abstention row stays
in the claims journal as history. The red mutation keeps `unattributed` records
out of the claims journal, so that assertion fails under either key.
G7-T12 counts each evaluated (result, case) exactly once from that evaluation's
decision outputs. Claims-journal history never adds, removes or replaces a
count, whether the rows are superseded, beside each other, or abstentions
followed by attributions. Holdout cases never produce rows. G7-T12's control
`claims history does not change report counts` pre-populates the claims journal
with an abstention and a later attribution for one tune case. It asserts
unchanged confusion-matrix, coverage and abstention counts. Its red mutation
derives counts from the claims journal. `acquireLock` never waits: a run refused with
`Run directory locked` on the claims lock commits nothing, stops with an explicit
incomplete result and keeps its committed receipt; a later restart rederives the
claim from that receipt and repeats the locked check. A crash after the claim
append but before release leaves a durable claim and a stale claims lock that
blocks every run's claim commits until explicit operator inspection and removal;
no automatic reclamation. A crash between receipt commit and claim commit leaves
no claim; replay rederives identical content from the committed receipt. Q6
still selects the key and the history/supersession policy applied inside this
locked check. Add these checks at this consumer; `Journal.append` itself is not
a uniqueness validator.
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
API and reads host receipts only as serialized files validated against
host-published schemas (the selected Q7 boundary). Existing
W5-T58/T59 and `p8.test.ts` remain the evidence for grant and check-retry semantics.
Same invocation lookup is evidence, not authority to repeat its effect.
Test cancel/result races and dependency completion/cancellation interleavings
using injected scheduling barriers
rather than timing sleeps.

Keep attribution diagnostic and opt-in at composition: it never promotes,
admits, mints grants, releases reservations, changes routes or marks goals
complete. The sole production G7 composition point is the offline runner in slice 5;
nothing attaches attribution to Loom or decision-sites. Enforce the G7 import
boundary with the host-independent G7-T14 baseline in slice 1b, before or with
the first executable G7 leaf code, together with its free-global pass, runtime
flag, native lint rules and scope test; refine it with the serialized-receipt
schema reads in slice 2 and rerun it
for every later leaf change, including slices 3, 4 and 5, and
retain the existing runtime regression anchors below.

## Smallest PR slices; red before green, main green after each

All filenames below marked new are future files, not this task's changes.
Each implementation PR records its meaningful behavioral red before code and
turns that same test green. Contract-only slice 1a uses type-level conformance
and a contract-doc check instead; it claims no classifier behavioral red.
Each PR first runs the seam-path freshness gate from the baseline and records
its output. It then runs the narrow relevant checks, then `npm run verify`, `npm run lint`
and every `checks/` gate; `lint` is a separate CI step outside `verify`, so a PR
reports its `npm run lint` result explicitly. Do not merge a deliberately failing test-only PR; save red
evidence during development and merge tests with their passing implementation.
Independent corpus authorship and evidence inventory can proceed in parallel
with slice 1a. Slice 2 needs 1a, the 1b import baseline, frozen tune facts for
resolver parity and Q7's host enumeration, not the holdout freeze; slice 3 needs 1a and the scenario-disjoint
tune cases from 1b, not slice 2 or the owner-gated holdout freeze.
Holdout freeze and sealed evaluation remain gated on Q3/Q5;
if they are unresolved, development-only deterministic work can proceed,
but cannot support an holdout quality claim or later reuse tune
scenarios as holdout cases. Do not use freeze as a dependency for unrelated
contract, resolver or development work. Final uniqueness/history and retry
semantics remain separately gated on Q6. The boundary mechanism is selected:
serialized receipts against host-published schemas (Q7 option (b)). Slice 2's
schema artifacts, G7-H01 parity tests and schema-read refinement of G7-T14 wait
only for Q7's host enumeration and path confirmation; do not infer the host set.
The shared deny-by-default baseline and its red controls land in 1b without
waiting for Q7. Host-package imports, including type-only imports, stay
forbidden under the selected boundary.

Extend G7-T14 beyond import scanning with the named subcheck
`G7 leaf data reads use only declared pinned inputs`, landing with 1b.
Route all leaf data reads through one declared reader with an allowlist of
exact pinned repo paths and stored-byte digests in the leaf contract/input
manifest. The sole external-location input is the sealed-label artifact:
only its stored-byte digest is pinned, and the evaluator supplies its path at
evaluation time through slice-5 `run.ts`, the only production injector. It requires
`{sealedLabelPath: string, sealedLabelDigest: string, holdoutSetDigest: string}`
and passes the path and both digests through the
sealed-label loader and production entry to the core verifier for that evaluation.
G7-T14's allowed injections for sealed evaluation are the evaluator-supplied path,
independently supplied sealed-label and holdout-set digests and, under Q3's encrypted option, a key
through existing secret injection; a caller-supplied manifest anchor is forbidden.
Slice-1b tests and positive controls use the core verifier with synthetic
manifest/anchor/artifact triples only in the exact test file enumerated below.
The path and digests may come from explicit runner options; any decryption key comes
only through existing secret injection, never argv, logs or journals.
For Q3's encrypted option, verify the pinned stored bytes (ciphertext) first,
then verify decrypted bytes against a separately recorded plaintext digest
before exposing labels to the evaluator. Its source and protected input contract
remain deferred to Q3 as above; do not add a plaintext-digest input now or enable
encrypted production evaluation before that decision. Neither option is selected here.
This is a declared digest-pinned input, not an
undeclared fs path literal or a loader scan exemption. Pure code never reads
env/argv; the composition root handles external configuration. Apply canonical
target checks and the pinned digest to this injected location too, retaining
evaluator access controls; no arbitrary external path allowance follows.
Define the reader as two layers in separate modules within
`benchmarks/failure-attribution/`. The core verifier in `reader-core.ts` takes
an explicit anchor and checks the manifest's stored-byte digest against it on
every read before trusting the allowlist or parsing entries. The anchor and every
manifest stored-byte digest use the `isDigest` form specified above. For production
sealed evaluation, it also requires `sealedLabelDigest` and `holdoutSetDigest`
satisfying `isDigest` and checks both by exact string equality with no normalization,
as specified above, before exposing holdout inputs or labels.
The exact enumerated test-file allowlist for core access is only
`benchmarks/failure-attribution/reader.test.ts`;
no suffix glob grants core access or test-only APIs. That file exercises
the core with synthetic manifest/anchor/artifact triples, including matching
positive controls; it must not read real holdout inputs or labels.
The production entry in `reader.ts` binds the manifest's stored-byte digest
constant and delegates to the core verifier; it accepts no anchor argument or
override and never exports a core reference. Only this production entry may
be called by `run.ts` or other non-test leaf consumers. The deterministic label
harness `label-harness.ts` and sealed-label loader `sealed-labels.ts` are
explicitly non-test, even when invoked by a test; both use only the production
entry for real inputs. Add the G7-T14 static subcheck
`non-test leaf code cannot call the core verifier`. Replace the repeated
core-bypass denylist with three mechanical gates; new spellings must be covered
by these gates, not by adding bypass names. Ambient globals are treated as
imports: a global reaches modules, code generation or the network without any
import specifier, so it gets the same closed per-file list.

1. In `imports.test.ts`, enforce a **per-leaf-file closed import-specifier allowlist**.
   Enumerate every file under `benchmarks/failure-attribution/`, including
   `fixtures/**`, tests and child fixtures, with any executable extension
   (`.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`, including `.d.ts`).
   Only `.ts` files listed in the leaf `CONTRACT.md` table below are permitted;
   any other or unlisted executable file fails. Each entry lists its exact permitted
   relative and public-package/`node:` specifiers. Built-ins must use the `node:`
   prefix and named imports only, limited to the bindings the entry lists; a
   namespace or default import of a built-in, or an unlisted binding, fails. No
   wildcard permits all built-ins or all within-leaf imports. Parse with the
   existing TypeScript dev dependency through the exported API subpaths named
   below; fail on parse/bind errors. Accept only static string-literal import
   declarations (including type-only imports). Reject every import or export
   declaration carrying import attributes (`with { type: 'json' }` or `assert`),
   so pinned data cannot enter as a static JSON import around the digest-pinned
   reader. Reject every dynamic `import()`, `require` reference/import-equals and
   `import.meta.resolve`, regardless of target. A leaf-wide **forbidden built-in
   set** — `node:vm`, `node:module`, `node:child_process`, `node:worker_threads`,
   `node:inspector`, `node:wasi`, `node:repl` and the network modules `node:net`,
   `node:tls`, `node:dgram`, `node:dns`, `node:http`, `node:https`, `node:http2` —
   may appear in no entry; the sole exception is `node:child_process` for the exact
   slice-5 process allowance below. The scanner checks the table against this set,
   so a later PR cannot widen a file's list into it; changing the set is a reviewed
   leaf-contract change, and a network module also needs the data/destination
   gate below. Resolve relative literals to canonical targets to check
   edges; before slice 5 all such targets must be in the leaf. Enable only the
   exact approved journal edge after the reuse decision, and only on the
   `run-journal.ts` row. Reject unlisted aliases
   and module re-exports. Only `reader.ts`
   and the exact `reader.test.ts` may import `reader-core.ts`; only named imports
   are allowed on those edges. `reader.ts` exports only its production functions,
   with no anchor parameter or exported core binding; `reader.test.ts` exports
   nothing. No leaf file may import a
   `*.test.ts` file or `test-children/*`. Other consumers reach the verifier
   through `reader.ts`. The scanner checks these module/export/signature shapes,
   not the identity or type of every call or computed member expression.
2. In the same `imports.test.ts` AST pass, enforce a **per-leaf-file closed
   free-global allowlist**. Resolve every value-position identifier that has no
   local binding or import, using the TypeScript binder's scope resolution only
   (no call or type inference), against the file's entry. With pinned TypeScript
   7, use `API`/`checker.getSymbolAtLocation`, `Node.forEachChild` and declaration
   `path` handles: a declaration in that module's lexical scope or an import is
   local; a default-library/Node ambient declaration or unresolved name is a
   global to check. Do not mistake "has a symbol" for "has a local binding".
   Reject ambient `declare` declarations, declaration merging/global or module
   augmentation, triple-slash references and non-module scripts in leaf code;
   a fake local ambient declaration cannot hide a global. Ignore erased type
   references, declaration names and noncomputed property names; check shorthand
   property values and references inside executable expressions. Only
   `import.meta.url`, `import.meta.dirname` and `import.meta.filename` reads are
   permitted; `import.meta.env` and other meta access fail. Include local-shadow,
   nested-scope, shorthand-reference and ambient-declaration red/green controls. The base set is `JSON`, `Object`, `Array`, `Map`,
   `Set`, `WeakMap`, `Promise`, `Error`, `TypeError`, `RangeError`, `Number`,
   `String`, `Boolean`, `Symbol`, `RegExp`, `Uint8Array`, `TextEncoder`,
   `TextDecoder`, `URL`, `undefined`, `NaN`, `Infinity`, plus exactly `Math.abs`,
   `Math.ceil`, `Math.floor`, `Math.max`, `Math.min`, `Math.round` and `Math.trunc`.
   Those are the entire initial Math member list, with no "all except random"
   permission. Every other global — including `Function`,
   `eval`, `Reflect`, `Proxy`, `WebAssembly`, `fetch`, `globalThis`, `process`,
   `Buffer`, `require`, `module`, `Date`, `performance`, `crypto`, timers and
   `queueMicrotask` — fails unless the file's entry grants it. Member-restricted
   globals (`process`, `Math`) may appear only as the object of a non-computed
   member access naming a listed member; aliasing (`const p = process`),
   computed access, destructuring or passing the global as a value fails. No
   entry may grant `process.getBuiltinModule`, `process.binding`,
   `process.dlopen` or `process.env`; `process.argv` is granted only to the
   composition roots `run.ts` and the spawned `test-children/*.ts`. A Q3
   encrypted-option key through existing secret injection would be a later,
   reviewed `run.ts` input contract after Q3 selects that option; it cannot
   silently widen this table or make pure code read secrets. Because `Date`,
   `performance`, `crypto`, `Math.random` and `process.env` are unlisted, this
   rule is the leaf's env, clock and entropy purity check; the package-scoped
   `checks/no-ambient-*` scans are not extended to `benchmarks/`. The same pass
   rejects every member access named `constructor` (dot or literal computed,
   optional access included), irrespective of the receiver's type. Ordinary
   `map[key]`/`row[field]` remains allowed. This replaces the earlier
   computed-`globalThis` rule (`globalThis` is simply unlisted) and the proposed
   local Oxlint JS plugin: no `checks/g7-lint-plugin.mjs` or `lint.jsPlugins` is
   added, so the scanner's file enumeration is the single scope source for these
   rules.
3. Run every leaf process with Node's built-in
   `--disallow-code-generation-from-strings` flag, so string-to-code generation
   throws `EvalError` however `Function` is reached — including a non-literal key
   such as `fn[k]` with `k` computed to `'constructor'`, which no static rule can
   see without receiver types. Slice 1b adds a `test:failure-attribution` script,
   `npm run build && node --experimental-strip-types --disallow-code-generation-from-strings --test "benchmarks/failure-attribution/*.test.ts"`,
   chained into `verify` like `test:decision-sites`. The leading build matches
   `test:decision-sites`: `@weave/gauge` and `@weave/weft` export only built
   `./dist/src/*.js` (`packages/gauge/package.json` and
   `packages/weft/package.json` `exports`), so running the script alone in a
   clean checkout must build first. `run.ts` is invoked with the same Node
   flags, and the slice-5 child flag list below requires the flag.
   `imports.test.ts` carries the runtime control
   `computed-key Function construction throws EvalError`, which turns red when
   the suite runs without the flag. It asserts the error by name, for example
   `assert.throws(fn, { name: 'EvalError' })`, never by referencing the
   `EvalError` global, so the file's base global set stays closed. The temporary Node `v22.23.4` probe below
   demonstrated that flag together with type stripping and `node --test` child
   propagation: the identical computed-key control fails without the flag and
   passes with it. Repeat that check in slice 1b on the supported CI toolchain;
   incompatibility blocks the slice instead of silently dropping the flag or
   substituting an unverified static fallback. This is defence against string
   compilation, not a general sandbox or permission to execute supplied code.

Keep native Oxlint `eslint/no-eval` and `eslint/no-new-func` at error severity
for the entire leaf, including tests, `imports.test.ts` and child fixtures, as
defence in depth only. The lockfile pins oxlint `1.88.0` and
`@oxlint-tsgolint` `7.0.2004` under Vite+ `1.2.0`. This worktree has no
`node_modules`; a sibling local install with exactly those versions has an
oxlint `configuration_schema.json` listing the core-plugin keys `no-eval`,
`no-new-func` and `no-implied-eval`, and separately `typescript/no-implied-eval`,
which the bundled `oxlint-tsgolint` README places among the type-aware
`typescript/*` rules enabled only by `--type-aware`. Running the linter was not
possible in this session, so whether core `eslint/no-implied-eval` reports
without type-aware mode is unverified. **Recommendation:** never enable
type-aware linting for G7. Configure `eslint/no-implied-eval` too only if the
slice-1b lint-scope test shows its diagnostic under plain `vp lint`;
otherwise drop it explicitly in the PR, because gate 2 already rejects the
unlisted timer globals and gate 3 makes string compilation throw at run time.
Never configure `typescript/no-implied-eval`. The slice-1b PR records the
rule listing from the pinned toolchain and which implied-eval outcome applied;
a missing `eslint/no-eval` or `eslint/no-new-func` blocks the slice rather
than being silently omitted. Scope the rules to the leaf with a
`lint.overrides` entry for `benchmarks/failure-attribution/**` in
`vite.config.ts`, which has no `rules` or `overrides` key at HEAD; Vite+
`1.2.0` types `lint` as `OxlintConfig`, whose schema includes `overrides`.
If the lint-scope test shows `overrides` is not honored, use top-level
`lint.rules` repo-wide instead: a search at `ba58a2d` finds no JS/TS `eval(` or
`new Function(` use (only PyTorch `.eval()` calls in `benchmarks/**/*.py`,
which `lint.ignorePatterns` excludes), so repo-wide rules add no current
violation. Record which form landed. Add **new** `checks/test/g7-lint.test.mjs`,
limited to the configured rules, to prove the leaf
is in the effective lint scope: exercise `vp lint` with the actual repo
configuration in an isolated fixture retaining the leaf paths, require the
expected diagnostic for each rule and a clean positive control, and fail on
ignored files or disabled rules. Include a newly named leaf file so an
exact-file scope cannot silently omit additions. `npm run test:checks` already
discovers this test. Record the slice-1b `vp lint` red output on the planted
snippets and the green `npm run lint` output in the PR evidence. Add no lint
exemption or inline suppression for the scanner or tests. Red snippets are inert
text passed to the parser/linter, never executed; only the gate-3 runtime control
executes.

**Filesystem access is structural, not call-site analysis.** Among production
files, only `reader-core.ts` may list `node:fs` for content reads, and slice-5
`run-journal.ts` only metadata-only `lstatSync`/`realpathSync` for eval-root
checks. `reader-core.ts` has read-only bindings, and it
permits only the code-pinned manifest path (checked against the code-pinned
anchor before trusting its contents), artifact paths in that verified manifest,
and the injected sealed-label path with its independently checked digest.
The resolved journal module is the second, bounded filesystem capability: after
the slice-5 reuse decision only `run-journal.ts` may name its specifier, and
that wrapper binds every journal and lock path to an eval-root handle with fixed
run-directory, record and lock names, as specified under durability above.
The journal module itself lies outside the leaf, keeps its own `node:fs` imports
and is not a leaf table row. Test-side `node:fs` entries are closed and named:
`imports.test.ts` (enumeration and text reads for the scanner), `reader.test.ts`
(temporary synthetic triples, symlink/traversal fixtures and the
formatter-rewritten copy), slice-5 `durability.test.ts` (fresh run directories,
unchanged-byte assertions and `/proc` probe reads) and
`test-children/torn-header.ts` (write-only fault plant). Every other leaf file,
including `label-harness.ts`, `sealed-labels.ts`, `stored-byte-digest.ts`,
`cases.test.ts`, `fixture-parity.test.ts`, `evidence.ts`, `run.ts`, `report.ts`
and `report.test.ts`, lists neither `node:fs` nor `node:fs/promises`, and gate 2
closes `process.binding` and `process.getBuiltinModule`. `run.ts` writes the
rendered aggregate report to `process.stdout`; durable receipts and claims go
through `run-journal.ts`. No computed-target or alias analysis of fs calls is
performed: which files reach the filesystem is fixed by the `node:fs` rows and
the single journal-edge row.

Initial per-file table for the slice-1b `CONTRACT.md` follows. A cell lists
permitted specifiers, with exact named built-in/public-package bindings in
parentheses; relative modules expose only the contract's production API or named
types, never core/test re-exports. Every row has exactly the base globals above
and no additions. Here **harness** expands to `node:test` (`test`) and
`node:assert/strict` (`strict as assert`); this is a named export, not a built-in
namespace/default exception. No other specifier, binding or ambient global is
implicitly permitted. Later slices add exact rows and red/green controls in the
same PR as each file; no prose category is an executable permission.

| File                    | Exact import specifiers (and built-in/public bindings)                                                                                                                                                                                                                                       | Additional globals                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `reader-core.ts`        | `node:fs` (`openSync`, `fstatSync`, `readSync`, `closeSync`, `lstatSync`, `realpathSync`); `node:path` (`dirname`, `isAbsolute`, `relative`, `resolve`, `sep`); `@weave/weft` (`isDigest`); `@weave/gauge` (`recordDigest`); `./stored-byte-digest.ts`                                       | None                                                                               |
| `reader.ts`             | `./reader-core.ts` (named production delegate only)                                                                                                                                                                                                                                          | None                                                                               |
| `stored-byte-digest.ts` | `node:crypto` (`createHash`)                                                                                                                                                                                                                                                                 | None                                                                               |
| `sealed-labels.ts`      | `./reader.ts`; `@weave/weft` (`isDigest`); type-only `@weave/gauge` (`AttributionCategory`)                                                                                                                                                                                                  | None                                                                               |
| `label-harness.ts`      | `./reader.ts`; `./sealed-labels.ts`; `@weave/gauge` (`validate`, `recordDigest`; type-only `AttributionCategory`, `Context`)                                                                                                                                                                 | None                                                                               |
| `cases.test.ts`         | harness; `./reader.ts`; `./label-harness.ts`; `./sealed-labels.ts`                                                                                                                                                                                                                           | None                                                                               |
| `reader.test.ts`        | harness; `node:fs` (`mkdtempSync`, `mkdirSync`, `writeFileSync`, `readFileSync`, `symlinkSync`, `rmSync`); `node:os` (`tmpdir`); `node:path` (`join`, `resolve`); `./reader-core.ts` (named synthetic-test entry); `./reader.ts`; `./stored-byte-digest.ts`; `@weave/gauge` (`recordDigest`) | None                                                                               |
| `imports.test.ts`       | harness; `node:fs` (`readdirSync`, `readFileSync`, `lstatSync`); `node:path` (`dirname`, `join`, `relative`, `resolve`, `sep`); `typescript/unstable/sync` (`API`); `typescript/unstable/ast` (`SyntaxKind`)                                                                                 | None; the gate-3 control matches `{ name: 'EvalError' }` without naming the global |

This specifies the eight executable 1b files; `CONTRACT.md`, `PROVENANCE.md` and
JSON/JSONL fixtures are data/docs, never executable entries. The TypeScript API
parses source without evaluating it; its fixed compiler helper belongs to the
existing pinned development dependency, not a leaf-granted spawn/loader API.
Before accepting this scanner, slice 1b must prove all its rules with the actual
pinned API, including free names with ambient declarations and local shadows.
The temporary probe below establishes API availability only, not a completed
scanner. No parser dependency or compiler-API compatibility layer is proposed.

For slice 5, freeze exact specifier/binding rows for the new files before they
execute. The maximum extra global grants are `run.ts`: `process.argv`,
`process.stdout`, `process.exitCode`; `durability.test.ts`: `process.execPath`,
`process.kill`; and exactly `test-children/restart.ts`,
`test-children/torn-header.ts`, `test-children/competing-writer.ts`:
`process.argv`, `process.pid`, `process.stdout`, `process.exitCode`. Other
`test-children/*.ts` files are unlisted and fail. Restrict `process.stdout` to
report/readiness output and `process.exitCode` to final status assignment; never
pass or alias `process` itself. `durability.test.ts` alone adds
`node:child_process` (`spawn`, `fork`), plus its explicit fixture/lock-probe fs
bindings; `test-children/torn-header.ts` alone adds write-only `node:fs`
(`openSync`, `writeSync`, `fsyncSync`, `closeSync`). Add only those exact imports
needed for temporary setup/cleanup, unchanged-byte assertions and the existing
`/proc` identity protocol to the test's row. `report.ts`, `report.test.ts`,
`evidence.ts`, `cases.test.ts` and `fixture-parity.test.ts` get no fs or process
grant. The resolved journal edge is named only after the reuse decision and
only in the `run-journal.ts` row (`Journal`, `acquireLock`, `ledger`), whose
other entries are `node:path` (`isAbsolute`, `relative`, `resolve`, `sep`) and
metadata-only `node:fs` (`lstatSync`, `realpathSync`) for eval-root checks, and
nothing else; `run.ts`, the three named children and
`durability.test.ts` list `./run-journal.ts`. Retain the journal's bounded
receipt/lock I/O and existing entropy for lock nonces as an explicit
composition exception, never as a pure-leaf permission. It exposes no arbitrary
input-reader API to the leaf: the wrapper binds all paths to the eval-root
handle and fixed names, rejecting repository source and pinned-data roots before
opening. Add red controls `journal edge imported outside run-journal.ts` (the
journal specifier planted in `run.ts`) and
`Journal read-only open of a pinned fixture via the journal edge` (planted in
`evidence.ts`), both rejected by the per-file allowlist, plus
`run-journal.ts path parameter` rejecting an exported function other than
`openEvalRoot` whose signature accepts a string path; a `run.ts` call through
`run-journal.ts` is the positive control.

Keep four representative core-bypass red controls: `static core import from an
unlisted file`, `dynamic import`, `source-evaluation bypass` using `new Function`,
and `planted vm import` rejected because its specifier is absent from that file's
allowlist and in the forbidden set. Add the ambient-global red controls
`process.getBuiltinModule('node:vm')`, `Reflect.construct(Function, …)`,
`fetch(...)` and `process.env read in label-harness.ts`, each rejected because the
global or member is unlisted, plus `static JSON import` with import attributes and
`.mjs file under the leaf`; a file using only `JSON` and `Map` is the global
positive control. Matching production reads and synthetic triples in the exact
`reader.test.ts` are positive controls. Assert the production reader and `run.ts`
accept no anchor override. All entries exclude the forbidden built-in set (except
the slice-5 process allowance) and source-evaluation globals; the module, global
and runtime gates enforce this without a bypass catalogue.

The only process-module allowance is the exact `durability.test.ts` in slice 5,
limited to `node:child_process`; `node:worker_threads` stays forbidden, so no
Worker site can exist. In `imports.test.ts`, check its spawn/fork sites against a
**closed string-literal target list** (relative to the leaf root, with a fixed child cwd):
`./run.ts`, `./test-children/restart.ts`, `./test-children/torn-header.ts`, and
`./test-children/competing-writer.ts`. Declare those exact fixture files in slice 5
and put each under the same module, global, runtime-flag and lint rules. They cannot import
`reader-core.ts` directly; a runner child legitimately reaches it through
`reader.ts`. Require direct named process-API calls with literal targets; for
spawn, require `process.execPath` as the executable and the literal script in a
literal argv array. For fork require a literal script argument. Permit only the
fixed Node runtime flags `--experimental-strip-types` and the required
`--disallow-code-generation-from-strings` before the script, with an explicit
`execArgv` of exactly those flags for fork; no inherited
loader options, `NODE_OPTIONS`, shell commands or evaluator options. Reject all
other Node flags (including `--import`, `--loader` and `--eval`), nonliteral or
unlisted targets, and aliased/indirect process calls; ordinary test data arguments
may follow the script. Enforce the same restriction in any future file granted
process APIs before widening its allowlist. Add `spawn reader-core.ts directly`
as a red control and `spawn run.ts` as a positive control. Thus the crash-test
allowance admits a bounded runner child, not an unchecked alternate loader.

`imports.test.ts` reads leaf `.ts` sources, including itself and
`reader-core.ts`, as text for static analysis, with the closed entry in the table
above. It imports no leaf modules or modules for source evaluation, module
loading or process execution; the same module, global, runtime-flag and lint
rules apply to it. There is no self-applied taint, text-flow or fs call-site
analysis. The earlier `copied scanner` and computed-path rules are dropped:
reading source text grants nothing once no leaf file can evaluate or load it
(gates 1-3), and which files can touch the filesystem at all is fixed by the
`node:fs` entries above. Their replacement red controls are
`node:fs import in sealed-labels.ts` and `node:fs/promises import in report.ts`
(inert text scanned as if at those paths), both rejected by the allowlist; the
scanner's own listed entry is the positive control. Rerun the module, global,
runtime-flag, lint-scope, child-target and data-read checks for every new or
changed leaf file.
The 1b manifest has no sealed-label entry until the Q3/Q5 holdout freeze;
missing entries fail closed for production sealed evaluation. At freeze and for
any later change to holdout inputs, holdout-set digests or sealed labels,
require the Q3 custodian's sign-off as specified above. Enforce it through PR
review of the artifacts, manifest and code-pinned anchor, not a deterministic
test. Before every production sealed evaluation, require both independent digest
inputs and the core-verifier equality checks above. Routine anchor bumps may touch
only entries with roles `tune`, `schema` or `parity`, preserving all holdout entries and both
digests. No custody role or sealing option is selected here; manifest data roles
are fixed above.
The manifest cannot supply its own trust anchor; formatter rewrites cannot
update the code-pinned digest.
Verify each read's canonical path and stored-byte content digest before parsing
or exposing bytes; reject aliases,
traversal and symlinks that escape the declared target. Frozen corpus, receipts,
schemas and fixtures use this reader; seal-protected paths retain their access
controls. Mutable journal I/O remains the separate slice-5 receipt interface and
cannot read package data. Other fs access is refused structurally by the
closed `node:fs` entries above, not by inspecting path literals or computed
targets; no blanket `node:fs` allowance establishes data access.
Add only the exact Gauge fixture in slice 3 and the Q7-confirmed host schema
paths in slice 2 to the pinned data allowlist, never host source trees or arbitrary
fixtures. Red controls are an `undeclared host-path read` of
`packages/weave/src/**` (also try another host's fixtures) and a `wrong digest`
for an otherwise allowed path. The host-path read fails statically when planted
in a file without a `node:fs` entry, and at the reader when requested through
`reader.ts` because the path is not in the manifest; the wrong digest fails at
the reader. Add a `formatter-rewritten byte` control: format an unexempted temporary
copy of frozen JSON/JSONL and substitute its changed bytes without updating
the pin; the reader must reject them even when parsed values are identical.
Add `mutated manifest with internally consistent digests`: substitute a changed
manifest and matching replacement artifact digests; the reader must reject the
manifest against the unchanged anchor before trusting its allowlist. Exercise
this mutation in the core verifier with a fixed synthetic anchor, then against
the production entry's code-pinned anchor; changing the synthetic anchor is
allowed only to establish a separate valid test triple, never as a production
override. In slice 5, also prove the `run.ts` evaluation path rejects this
control before exposing labels or producing an evaluation report.
Add `routine anchor bump preserves sealed-label and holdout-set digests`: a
schema, parity-data or tune addition with its reviewed manifest anchor update
passes only with all holdout entries and both independent digests unchanged.
A re-pinned, removed or added holdout or sealed-label entry must refuse against
the independently held digests even when the manifest and anchor change together.
A removed required entry refuses before digest comparison. Add
`holdout input changed with manifest and anchor`: mutate a label-free holdout
input and its manifest digest and re-pin the manifest anchor while retaining the
evaluator-held digests; the holdout-set equality check must refuse before
holdout inputs or labels are exposed or an evaluation report is produced.
Also mutate an holdout-set digest entry with a matching manifest/anchor update.
Add `holdout entry relabeled tune`: change an `holdout-input` or
`holdout-digest` entry's role to `tune` with a matching manifest/anchor update,
leaving at least one other entry of each required role and retaining both
independent digests. It must reach and fail the `holdoutSetDigest` equality
check, before bytes or reports are exposed. Missing/unknown/duplicate role
assignments and duplicate canonical paths have separate structural refusal
controls; valid multiple entries of the same role pass.
Use synthetic controls in `reader.test.ts`; these test only the mechanical checks,
while custodian sign-off remains the review-process gate above. Add
`omitted independent digest`, `malformed independent digest` (bare hex, uppercase hex,
wrong length) and `mismatched independent digest` red controls for each independent
digest at the core and, in slice 5, through `run.ts`; all refuse without normalization
before holdout inputs, labels or a report are exposed. After freeze, the evaluator
supplies both independently held digests on the real evaluation path.
Add `label read bypassing
the reader`: plant a direct fs read in the sealed-label loader and require
static rejection of its unlisted `node:fs` import. The loader remains in G7-T14's scan. Positive controls read
exact pinned repo bytes through the production entry and synthetic external
label bytes through the core verifier with a matching synthetic manifest and
anchor; after freeze, the evaluator also checks real sealed inputs through the
production entry. Missing/mismatched sealed inputs fail without exposing labels.
Q3 still selects sealing and custody. Rerun these checks for G7-T15 and the
slice-2 host-schema consumer, so an fs read cannot bypass the import boundary.

| Slice and dependency                                                                                                 | Minimal deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Named red-before-green behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1a. Gauge contract, independent of corpus freeze                                                                     | Define pure fact/decision input and decision-output types in `packages/gauge/src/types.ts`, exported through existing `index.ts`. Extend `packages/gauge/src/GAUGE-CONTRACT.md` with those types, producer/evidence semantics and the pre-judgment id derivation rule above, including injected `isDigest` revisions and receipt exclusion, without changing @1; document the slice-1a glossary proposals below in `GLOSSARY.md`. Keep Q6 uniqueness/history and retry alternatives explicitly pending; do not block the independent input/id contract on that decision or corpus sealing. No classifier logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Use compile-time/type-level conformance fixtures that must or must not typecheck against the exported pure input/decision types, plus a contract-doc check of the declared semantics and derivation rule. Show these checks fail before the contract/types and pass afterward; existing green record semantics are regression evidence only. No behavioral red is claimed for this contract-only slice. Keep id derivation implementation and malformed-revision-digest refusal red solely in slice 3 G7-T07.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1b. Independent corpus, provenance and harness, parallel with 1a                                                     | **New** `benchmarks/failure-attribution/{CONTRACT.md,PROVENANCE.md,cases.test.ts,imports.test.ts,reader-core.ts,reader.ts,reader.test.ts,label-harness.ts,sealed-labels.ts,stored-byte-digest.ts}` plus scenario-disjoint tune cases and a deterministic label harness; no classifier logic. The label harness and sealed-label loader are explicitly non-test and use only `reader.ts`; only the exact `reader.test.ts` path enumerated above may exercise the core with synthetic triples. Put pinned corpus/receipt/fact files, manifest and holdout digests in `benchmarks/failure-attribution/fixtures/**` as JSON/JSONL, or add exact fmt `ignorePatterns` entries in the same PR as specified above. Each tune case carries raw source receipts plus a frozen normalized-fact form conforming to 1a, with both forms digested; validate/freeze that form after 1a and before slice 3. Corpus authorship and provenance inventory can proceed in parallel with 1a. Land the Q7-independent G7-T14 baseline before or with the first executable leaf code: use the per-leaf-file closed import-specifier allowlist above, with exact public Gauge/Weft, built-in and relative entries for each file, never a blanket module-family allowance; land the per-file specifier and free-global table, forbidden built-in set, `test:failure-attribution` script with `--disallow-code-generation-from-strings`, native lint rules and lint-scope test in the same PR. Record the closed manifest role enum, `gauge.holdout-set@1` schema identifier and raw-byte helper contract in the leaf `CONTRACT.md`; add the slice-1b glossary terms below. Resolve relative literals to refuse package-internal or unapproved-location bypasses. `@weave/weave` and `@weave/gateway` start forbidden, including type-only imports and subpaths; `@weave/agentfabric` and `@weave/agentsop` remain outright forbidden. Enable no journal edge before the slice-5 reuse decision. Only the holdout freeze is gated on owner Q3/Q5. For the holdout commit only holdout-set digests, the manifest and label-free inputs; labels/rationales stay outside the implementer-readable repo or encrypted with an evaluator-held key under Q3. The slice-1b loader uses only the production reader entry; only the enumerated `reader.test.ts` exercises the separate core verifier with synthetic manifest/anchor/artifact triples. The 1b manifest has no sealed-label entry until the Q3/Q5 holdout freeze; production evaluation refuses until then. At freeze, pin the holdout entries and sealed-label digest and update the code anchor with the Q3 custodian's sign-off; require the same sign-off for later holdout-input, holdout-set-digest or sealed-label changes. Custodian sign-off is a PR review-process gate on the artifacts, manifest and code-pinned anchor. The evaluator independently retains both signed-off digests; before every production sealed evaluation the core verifier performs both exact equality checks specified above, with no normalization. Slice-5 `run.ts` requires `{sealedLabelPath: string, sealedLabelDigest: string, holdoutSetDigest: string}` and passes the path and both digests through the loader and production reader; omission, malformed digest or mismatch refuses before holdout inputs, labels or a report are exposed. G7-T14's allowed injections include that path, both independent digests and any secret-injected decryption key, never a manifest anchor; routine anchor bumps touch only entries with roles `tune`, `schema` or `parity`, preserving all holdout entries and both digests. Q3 still decides sealing/custody. | **G7-T01 `frozen corpus rejects always-unattributed and wrong-citation controls`**; **G7-T02 `scenario lineage and labels cannot cross into tuning inputs`** in `cases.test.ts`. Run the validated harness red against controls, then green against independent expected controls; report both with zero skips. Reject missing/mismatched sealed-label digests and tune/holdout overlap without exposing labels. **G7-T14 `G7 leaf imports only allowlisted public Gauge/Weft/built-in specifiers`**, baseline in `imports.test.ts`: demonstrate red with planted forbidden host/Fabric/AgentSOP imports, type-only/subpath imports, relative-path bypasses and an unlisted package; green with public Gauge/Weft, built-in and within-leaf positive controls, scanning the harness and sealed-label loader too. Add the named data-reader and core-verifier access subchecks and their undeclared host-path, wrong-digest, formatter-rewritten-byte, internally consistent mutated-manifest, label-reader-bypass and anchor-injection red controls above before allowing data reads, scanning the sealed-label loader without exemption. Matching synthetic triples pass the core verifier only from the exact enumerated test file; use the four representative core-bypass controls, ambient-global and import-attribute controls, the runtime `computed-key Function construction throws EvalError` control and effective lint-scope test above, with no per-call identity resolution; record `vp lint` red output on the planted snippets and green `npm run lint` output. The production entry binds only its code constant. Include the routine-anchor-bump holdout/sealed-label preservation, changed-anchor re-pinning, holdout-input/manifest/anchor mutation, omitted/malformed/mismatched independent digest, holdout-role relabeling, bare-hex manifest entry and `node:fs import in sealed-labels.ts` / `node:fs/promises import in report.ts` controls above. Only files with a listed `node:fs` entry, plus slice-5 `run-journal.ts` through the single bounded journal edge, can touch the filesystem; `imports.test.ts` reads leaf sources as text for its scanner, which grants no evaluator or loader access. Holdout execution waits for Q3/Q5; development harness checks do not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2. Evidence resolver and host-schema refinement, after 1a and the 1b baseline/tune facts; gated on Q7's host list    | **New** leaf `benchmarks/failure-attribution/{evidence.ts,evidence.test.ts}` and extend existing `imports.test.ts`, translating existing receipts to the Gauge-owned input types already exported in slice 1a, from schema-validated serialized receipts (selected Q7 option (b)) once Q7 names the participating hosts. Do not re-declare unchecked host shapes. G7-T03 also proves `resolver(raw) == 1b normalized facts` from the digested raw source receipts and frozen 1a-conforming tune facts; a resolver that changes or drops a fact is a red control. No temporary benchmark-owned fact type, runtime or Weft schema changes. Preserve the slice-1b G7-T14 baseline; slice 2 adds only the declared host-schema reads. This slice also owns adding the host-owned G7-H01 parity checks and schema artifacts for each Q7-named host at `packages/<host>/schemas/g7-receipt.schema.json` and `packages/<host>/test/g7-receipt-schema-parity.test.ts` unless its owner substitutes paths in Q7; no package imports from `benchmarks/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **G7-T03 `wrong-case, stale, dangling and conflicting citations cannot support a claim`**; **G7-T04 `missing search or route inventory is inconclusive`**. Red against a pass-through resolver, green with validation and an immutable snapshot. **G7-T14 `G7 leaf imports only allowlisted public Gauge/Weft/built-in specifiers`**: extend the existing baseline only with the declared host-schema reads; the approved journal location can be enabled only after the slice-5 reuse decision. The host-receipt rule is the selected Q7 option (b): accept serialized JSONL/receipt files only against a schema pinned by host-owned G7-H01 parity tests against the real host types, forbidding `@weave/weave`, `@weave/gateway`, `@weave/agentfabric` and `@weave/agentsop`, including type-only imports, subpaths and relative aliases. Option (a)'s type-import allowlist is not implemented. Demonstrate red with forbidden host imports, including a planted `import type` from `@weave/weave`, plus schema-drift and malformed receipts; green with valid receipt controls. Keep the baseline relative-path bypass, unlisted-package and declared-reader controls green; host schemas use only the exact Q7-confirmed pinned paths/digests through that reader, with undeclared host-path and wrong-digest red controls. No runtime-effect comparison or extra-effect test double.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3. Pure deterministic attribution and fixture parity, after 1a and tune cases from 1b                                | **New** `packages/gauge/src/attribute.ts`, exported from existing `index.ts`; **new** `packages/gauge/test/attribution.test.ts` and leaf `benchmarks/failure-attribution/fixture-parity.test.ts`. Reuse existing record types, `validate` and the slice-1a Gauge input and id contract. No resolver dependency: consume frozen normalized tune facts from **new** `packages/gauge/fixtures/attribution-tune.json`. Never import from `benchmarks/` in Gauge tests. This slice adds G7-T15 in the leaf: read `packages/gauge/fixtures/attribution-tune.json` through the G7-T14 declared reader at its exact pinned path/digest as data, never by a relative JSON import or other code import; compare its normalized facts/digest with the corresponding digested 1b normalized-fact form and refuse drift. Preserve pinned fixture bytes with the formatting exemptions above; rerun the formatter-rewritten-byte red control before accepting digest parity. Slice 1b supplies both normalized facts and raw receipts; slice 2 later proves resolver parity from those raw receipts. G7-T15 stays in slice 3 with no slice-2 dependency. Declare this exact read-only data coupling in the leaf contract; it grants no host-module access or scan exemption. Package tests read only their own fixtures. Pin derivation tests red-first before the binder writes ids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **G7-T05 `each decisive signal emits its category and citations without judgment`**, including the purity port checks below; **G7-T06 `policy exclusion, routine deferral and conflicting causes abstain`**; **G7-T07 `every tune decision binds and validates with identical category, signal and evidence; unknown case, holdout and info-only bindings are refused`**, including exact id derivation, canonical-key-order invariance, changed-input identities for each pre-judgment field, `isId` acceptance, malformed revision-digest refusal against Weft `isDigest` (`sha256:` plus 64 lowercase hex; reject bare/uppercase hex and wrong lengths), explicit-null eligibility and receipt/output independence. Demonstrate derivation red with constant-id and receipt-dependent mutations before implementing the binder; also reject the placeholder and a binder that changes decision fields. Green must cover derivation and all signals/negative controls on tune cases. **G7-T15 `Gauge fixture digests match the frozen tune facts`** in `fixture-parity.test.ts`: a mutated fixture must fail before accepting the fixture; the exact matching fixture passes. Rerun G7-T14 on this new leaf test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4. Bounded judgment fallback, after 2 and 3; retry contract gated on Q6                                              | Extend `attribute.ts` with a recorded-judgment input/finalizer; **new** `packages/gauge/test/attribution-judgment.test.ts`; put receipt/dispatch composition and its mocked dispatch tests in the new benchmark leaf. No hosted provider dependency or I/O in Gauge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **G7-T08 `judgment runs only after inconclusive deterministic analysis`**, extending the purity port checks below to the finalizer; **G7-T09 `missing confidence, invented refs, timeout and cancellation abstain`** at the decision step. Include timeout-then-retry with a valid answer under the owner-chosen Q6 persistence/request-identity option: either no attribution is persisted on the transient failure, or the authorized retry freezes a distinct request digest before dispatch. Do not choose the option in implementation. Red against a judgment-always or unchecked-answer double, green with deterministic mocks and exact `basis: judgment` records. Extend G7-T07 to cover every judgment and abstention tune decision as well. Rerun G7-T14 on the added composition code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 5. Durable runner and evaluation report, after 4 and the sibling-import assumption check; holdout run gated on Q3/Q5 | **New** leaf `benchmarks/failure-attribution/{run.ts,run-journal.ts,report.ts,report.test.ts,durability.test.ts}` and the three named `test-children/*.ts` fixtures in the closed target list above; enforce that list with direct-core-spawn red and runner-spawn positive controls before crash-test execution. Slice 5 owns `run.ts` as the sole opt-in composition point, explicitly invoked as the offline G7 runner; sealed evaluation requires the evaluator-supplied path and independent digest inputs defined in 1b, plus any decryption key through existing secret injection; both independent digests use the exact core checks above. Compose evidence resolution, Gauge decisions/binding, existing journal and Weft intake, and receipt/report output using the explicitly resolved reuse option. Add the slice-5 attempt/receipt glossary proposals below when their Q6 contract is settled. Publish only aggregate held-out reports. The owner-designated evaluator runs the sealed set once against the frozen classifier and records decision-only per-category precision/recall. No live calls unless separately authorized with the data/destination gate below satisfied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **G7-T10 `receipt crash and replay neither duplicate nor lose a claim or repay a call; same-id conflicts are refused`**: split conflict coverage into `receipt-layer conflicting outcome is refused` and `claim-layer conflicting write is refused`, with the layer-specific assertions and isolated red mutations defined in the journal contract above. The first submits different outcome content for the same attempt key and refuses it before finalization; the second injects a conflicting claim write or mutated finalizer output for an already-claimed id using one eligible committed receipt, so it reaches the claim gate. Identical receipt/claim content is idempotent; verify both cases across crash/replay. Add the closed `g7.claim` row cases `cross-run identical claim is idempotent`, `already-claimed judgment id dispatches nothing`, `concurrent same-id judgment commits refuse the second` and `abstention then attribution follows the Q6 key`, with the assertions and red mutations defined in the journal contract. Pin the separate `attempt_id` journal contract: intents, receipts and supersessions bind the attempt; Q6(a) retries use different journal keys with identical frozen request bytes/digest and shared attribution id, while Q6(b) also changes request digest/id. Same-attempt replay never redispatches; conflicting attempt bindings fail closed. Add `restart reuses recorded run_id and bundle binding`: use a child process actually killed with SIGKILL after header and bundle-binding commit; wait for the child's exit/close (reaped) before probing the lock. Use the shared test-side lock probe protocol below to select the expected exact message independently: `Run directory has stale lock; inspect before removing` for matching host identity and a confirmed dead PID, or `Run directory has stale-unknown lock; inspect before removing` for unavailable or different host identity. Never choose by accepting either message. Keep a separate live-holder `locked` control asserting exactly `Run directory locked`: hold an in-process lock so this control works even without host identity, and also probe a live same-host child where identity is available. Never accept refusal of any kind as a pass. Model explicit operator inspection and lock removal, then restart the same run directory only after a fresh `acquireLock` succeeds, reuse its recorded `run_id` and bundle, and retain the same attribution id even after new Weft records arrive. The supplied `run_id` is required on restart; omission or mismatch, an invalid header, or a missing header with committed journal rows fails closed before resolution or dispatch. Add crash point `torn header` with two deterministic child-process SIGKILL variants: an unparseable first header and `complete header without newline is committed`. In each, the child acquires the real lock, plants the exact torn bytes (an unparseable header prefix, or the complete valid header with no `\n`) through a test-only fault hook or a direct fs write, fsyncs them, signals readiness, and is then SIGKILLed by the parent. Do not rely on SIGKILL interrupting `Journal.append` to generate either byte sequence. Wait for the child's exit/close (reaped) before the lock probe; select and assert the exact `stale` or `stale-unknown` message through the independent host-identity and PID-liveness protocol below, as in the restart case. The parent asserts the bytes are unchanged before any lock removal and after the refused probe. Both leave the dead child's lock in place until explicit operator inspection/removal, then acquire a fresh lock before constructing a writable Journal. Only an unparseable final line is truncated; an unparseable first header with no committed rows repairs to empty, allowing a different required supplied id because no binding, attempt or claim committed. A complete valid header without newline is committed: writable load appends its newline, restart must reuse its id, and a different supplied id fails closed. Reject invalid/extra-field headers, headers outside row 0 and a second header. Prove no writable Journal construction, newline append or tail truncation occurs before `acquireLock` succeeds, including stale-lock refusal and a competing writer denied the lock; calling release in-process does not prove process-death recovery. Never treat a committed header as a fresh run or defer this guarantee to Q6. Red by substituting a fresh run id after header commit, accepting an omitted restart id, repairing outside the lock, or re-resolving the bundle. Name the snapshot case `replay after new Weft records arrive`: reproduce the same id or refuse if the recorded bundle is unavailable/mismatched; never emits a second claim for the case. Cover the deterministic path with no judgment intent. Add `fresh run after new Weft records arrive`: same tune result/case and classifier/rule revisions, a different run directory and newly resolved bundle digest/id must still reach the Q6 uniqueness/history check in the shared claims journal before claim commit. Add `concurrent fresh runs commit one claim per key`: two run processes with different run directories, bundle digests and ids both reach claim commit for the same owner-selected key; an injected barrier holds the first inside the claims lock after its reload and before its append. Exactly one `g7.claim` row for that key commits. The second is refused with `Run directory locked` and stops incomplete with its receipt retained, and on restart after release it reloads, finds the committed claim and is refused by the uniqueness check (or applies the owner's Q6 history policy); a variant where the second arrives after release takes the same check directly. Red by replacing the shared claims lock with the per-run lock. The serialization mechanism is fixed; only the key and history behavior remain pending Q6. Name the race case `superseded late receipt versus authorized retry receipt`: use injected barriers for both receipt orders across crash/replay; the superseded receipt stays evidence only and never claims the shared id. Supersession must be a durable check-and-set under the single-writer lock before retry dispatch. Add `receipt before supersession refuses retry dispatch`: a valid receipt with a usable answer for attempt N commits while the retry waits at a barrier, so attempt supersession and successor intent/dispatch are refused even before claim derivation. Add `completed-but-unusable receipt before supersession`: under pending Q6, either refuse successor intent/dispatch, or allow a separately authorized retry through the locked transition while retaining the receipt and reservation accounting and making the earlier attempt ineligible to claim. Include valid envelopes with malformed, low-confidence, invented-ref and contradictory answers. Test both pending variants under the owner's eventual choice, plus unusable receipts in both orders after attempt supersession, across crash/replay. Include timeout-then-retry across crash/replay under either owner-chosen Q6 option: a valid authorized retry can produce a claim without permanent transient-abstention lockout, silent replacement or automatic redispatch; uncertain receipts/reservations survive. Add the owner-decided uniqueness/history cases from Q6; derivation itself is already pinned by G7-T07 in slice 3. **G7-T11 `cancellation and competing writers preserve receipts without authority calls`**: repeat the killed-child sequence with a competing writer: await exit/close (reaped) before probing, independently select and assert the exact `stale` or `stale-unknown` message using the shared host-identity and PID-liveness protocol below, verify unchanged journal bytes before explicit operator inspection/removal, then acquire a fresh lock. Retain the separate live-holder `locked` control and its exact message assertions from G7-T10; never accept an arbitrary refusal. No writable Journal construction or truncation before acquisition. Preserve no automatic reclamation and the `Journal`/`acquireLock` lock, truncation and newline semantics, including under a reuse move, with existing decision-sites lock/replay test bodies and assertions unchanged except for import-specifier updates required by the move, and green; leave no re-export shim. If `journal.ts` stays in place under the owner's reuse decision, decision-sites remains unchanged. **G7-T12 `all five categories retain FP/FN and null denominators without leaking holdout cases`**, including `claims history does not change report counts`. Red via deterministic crash/write/conflict mutations and wrong-count controls, then green across restart and concurrent reads. Also add `G7 rows bypass decision-sites cost accounting` with its planted unprefixed-`intent` red control, as specified in the journal contract. Rerun G7-T14 on `run.ts`, `run-journal.ts` and the resolved journal location, including the `journal edge imported outside run-journal.ts`, pinned-fixture journal-open and path-parameter controls. |
| 6. Consumer regression and documentation, after 5                                                                    | Documentation only in the new G7 leaf; use the runner already owned by slice 5. Nothing attaches G7 to decision-sites or Loom. Keep `benchmarks/decision-sites/**` unchanged except for an owner-approved journal reuse move, with whole-file or Journal/acquireLock-only split scope recorded as above, and its required static and dynamic `import()` specifier updates; preserve existing decision-sites test bodies and assertions unchanged except for import-specifier updates required by the move, with no re-export shim, and keep them green. If `journal.ts` stays in place under the owner's reuse decision, decision-sites remains unchanged. Keep all W5 tests unchanged and green, and document results/limitations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **G7-T13 `existing G4 recorded-report parity anchor and provider-order protections remain green`**: run the existing parity/provider tests with bodies and assertions unchanged except for import-specifier updates required by an owner-approved journal move; this is a regression anchor, not new behavioral red. Inspect the decision-sites diff against the implementation base as a PR review step only, never a committed test dependent on git history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

For G7-T10's restart and torn-header cases and G7-T11's competing-writer case,
use a shared test-side probe, independent of the unexported `lockHost`: read
`/proc/sys/kernel/random/boot_id` and `readlink('/proc/self/ns/pid')` and compare
their combined identity with the lock's recorded host. Matching available identity
selects `stale` only after the child is reaped and a test-side `process.kill(pid, 0)`
confirms `ESRCH`; unavailable or different identity selects `stale-unknown`.
If the PID is live again (PID reuse), or liveness cannot be established, allow
at most 3 attempts total (the initial setup plus at most 2 retries), recording the
reason for each abandoned attempt. Each attempt, including both torn-header variants,
uses a fresh run directory and fresh child; retain abandoned lock/journal bytes for
inspection, with no automatic reclamation. If the refusal probe returns `locked`
after the precheck, re-probe liveness: only confirmed PID reuse permits another
attempt within that bound; otherwise fail the exact-message assertion. Never accept
`Run directory locked` as stale-lock success. If all attempts are exhausted by PID
reuse or unknown liveness, fail the test with an explicit non-pass that blocks the
slice-5 gate, even if every retry encountered confirmed PID reuse. Never count a
skipped run as green evidence. G7-T10 restart, each G7-T10 torn-header variant and
G7-T11 must each complete their process-death assertions to satisfy that gate.
Retain the separate exact live-holder `locked` controls and verify unchanged bytes
before explicit operator removal. Add deterministic probe controls for exhausted
PID reuse and unknown-liveness retries, proving the bound, fresh directories/children
and blocking non-pass without requiring real PID reuse.

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
The G7 sealed cases are the existing **Holdout** (a "sealed holdout" in prose),
not a new term. Slice 1b adds only these terms to `GLOSSARY.md`: **independent
evaluator-held digest** (a digest retained from the signed-off freeze outside
the mutable manifest/anchor and supplied by the evaluator at run time);
**custodian** (the Q3-designated principal who signs off holdout
artifact/manifest/anchor changes); and **sealed label** (an expected
category/rationale retained outside the implementer-readable repo or encrypted
under evaluator-held custody). `holdoutSetDigest` (the canonical
`gauge.holdout-set@1` digest binding all `holdout-input` and `holdout-digest`
entries plus the sealed-label stored-byte digest) is a leaf contract
identifier, defined in the leaf `CONTRACT.md`, not a glossary term. The
manifest's data `role` is not an inference role or an assignment of a person.
Record these definitions in the leaf `CONTRACT.md` too; they do not choose Q3's
custodian or sealing arrangement.
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
  and restore globals in a `finally` block; keep this in the Gauge package
  tests, outside the leaf module graph. Keep node:test timeouts and unrelated
  calls outside the
  trap scope. Add a positive control that `createHash` still works while the
  trap is active, and confirm the planted Gauge read triggers the trap.
- Track separately, outside G7, whether `npm run lint` should join `verify`;
  CI already runs it as its own step (`.github/workflows/verify.yml:19`). Until
  then every G7 PR reports `npm run lint` explicitly, as required above. Do not
  change `verify` in a G7 slice for this beyond adding `test:failure-attribution`.
- Preserve the repeated-finding lesson: the core-bypass finding recurred across
  review rounds until it became mechanical. G7-T14 now closes the class with
  closed per-file tables of specifiers, built-in bindings and globals, a
  forbidden built-in set and the code-generation runtime flag. A future bypass
  report is fixed structurally in the AST gate/table, with a red control for
  the class, never by naming another call site. Toolchain incompatibility is a
  blocking check failure, not an allowance to weaken the boundary.
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
3. Who authors and labels the holdout, and who runs the sealed
   evaluation? **Options:** name an owner/reviewer label author and a separate
   independent evaluator with sealed-label access; or defer holdout
   evaluation until those roles are available. **Recommendation:** designate
   both roles before freezing the holdout, with neither role held by
   the classifier implementer. No people are assigned by this plan.
   How should labels/rationales be sealed? **Options:** keep them outside the
   implementer-readable repo under evaluator custody; or keep them encrypted
   with an evaluator-held key. In either arrangement, commit only
   holdout-set digests, the manifest and label-free inputs; the slice-1b
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
   cases; slice 1a's independent input/id contract can proceed. Cross-run
   serialization is not part of this question: claims commit through the
   shared claims journal and lock recommended above under either key. The
   closed `g7.claim` row and abstention participation are not part of it
   either. Committed deterministic `unattributed` records are claims under the
   same key and policy, with no exemption. The owner's answer must therefore
   also state the outcome for a same-key, same-revision claim from a different
   bundle (for example, after new Weft records arrive). That outcome applies
   identically whether the predecessor is an abstention or an attribution.
   Under (result, case, revision) a plain reading refuses it, so an abstention
   on incomplete evidence would hold that revision until a new revision. G7-T10's
   `abstention then attribution follows the Q6 key` pins the answer.
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
   or permit a separately authorized retry? **Recommendation:** permit a separately
   authorized retry for these unusable
   answers, retaining the receipt as evidence, persisting no claim for that
   attempt, and using the locked supersession transition before successor intent.
   This keeps the two receipt orders consistent without claiming that a bad
   answer is missing. Both variants remain pending owner decisions:
   retain the receipt/reservation accounting either way; if retry is allowed,
   decide claim persistence/request identity so an abstention cannot lock out
   that authorized retry or permit conflicting claims. Pin the owner's choice
   in G7-T10's completed-but-unusable interleavings before implementation.
   Include timeout-then-retry with a valid answer in G7-T09/G7-T10, including
   crash and replay. Retry, completed-but-unusable eligibility and
   uniqueness/history decisions all remain pending; this plan selects none.

7. Which hosts participate in the slice-2 receipt schemas, and do their
   owners accept the proposed schema/parity-test paths? **Selected for
   implementation (engineering, D-ENG-021, plan19):** the boundary mechanism
   is option (b) below: serialized receipts validated against host-published
   schema artifacts, with host-owned G7-H01 parity tests. Option (a) is not
   implemented. The choice is an import-boundary mechanism, not a product
   fork. Option (b) keeps the offline leaf free of every host-package import
   with no symbol-level allowlist to maintain, and makes receipt-shape drift
   fail in the producing host's own test. The remaining owner input is
   narrower. Name the participating hosts: only hosts whose receipts the
   slice-1b evidence inventory selects. Each host owner confirms the proposed
   `packages/<host>/schemas/g7-receipt.schema.json` and
   `packages/<host>/test/g7-receipt-schema-parity.test.ts` paths or substitutes
   exact paths. The slice-1b G7-T14 baseline is unchanged and does not wait
   for this answer. The original options are kept for the record:
   (a) allow `import type` from
   public `@weave/weave` and `@weave/gateway` entry points, with a scan rejecting
   value imports and specific grant/authority symbols, including aliases and
   re-exports; keep Fabric/AgentSOP inputs serialized and their packages
   forbidden. Option (a) requires a closed list of named receipt types and
   syntactic rejection of host namespace imports/re-exports; it cannot rely on
   whole-program call/type resolution. Public `@weave/weave` exports grant APIs
   such as
   `createEqualGrantIssuer`, so a module-level claim of no authority modules
   would be false; G7-T14 instead forbids value imports and grant/authority
   symbol references. Or (b) require serialized JSONL/receipt files only,
   validated against a schema pinned by host-owned parity tests against the
   real types, outside the G7 scan. The selected arrangement is a
   host-published JSON schema artifact plus digest at
   `packages/<host>/schemas/g7-receipt.schema.json`, read by the leaf as pinned
   data via fs, with **G7-H01 `published receipt schema matches host types`**
   in `packages/<host>/test/g7-receipt-schema-parity.test.ts`. Each participating
   host tests its own artifact against its own types; no package imports the
   benchmark leaf, and the leaf imports no host package. Slice 2 adds
   these artifacts/tests with schema-drift red and valid-receipt positive
   controls. The owners name the participating hosts and confirm or
   substitute final locations before slice 2. The leaf consumes pinned schema/fixture digests,
   not unchecked shape copies. Neither a relative JSON import nor an
   undeclared fs read may bypass the boundary: G7-T14 rejects import attributes,
   admits `node:fs` only in the closed entries above (so other files cannot read
   `packages/`), and requires
   these exact owner-confirmed schema paths/digests through the declared reader.
   Demonstrate red with an undeclared host-path read and a wrong digest, then
   green with the declared schema; this is a checked rule, not review alone.
   Slice 2 and G7-T14 state option (b) as the implemented boundary. Only the
   host list and path confirmation remain open, and Q1–Q6 remain open.

The contract, evidence inventory, tune corpus and deterministic work
can proceed independently. Holdout freeze and sealed evaluation depend
on question 3 and confirmation of question 5; closure without independent
labels depends on question 4. The uniqueness key, history policy and their
G7-T10 cases, plus the transient-judgment retry contract and G7-T09/G7-T10
cases, depend on question 6; the shared claims-journal serialization does not.
Holdout sealing and the digest-verified slice-1b loader
arrangement depend on question 3. Recommendations are not owner decisions.
Slice 2's schema artifacts, G7-H01 parity tests and G7-T14 schema-read
refinement depend only on question 7's host enumeration and path
confirmation. The boundary mechanism is selected, and the slice-1b G7-T14
baseline does not depend on question 7.
Naming, id format and holdout protection remain technical contracts; the
sibling-leaf dependency assumption must be resolved before slice 5 as above.

### Review disposition: GLM review of `4b7d46f`

| #   | Severity / location                                             | Verification at `4b7d46f`                                                                                                                                                                                                                                                                                                                                                                                                 | Disposition                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Warning; baseline `0281c5e` note and plan18 verification bullet | Confirmed that the note was not reproducible from the reviewed SHA. In this session's clone `git cat-file -t 0281c5e` still fails and fetch was not permitted, so the reviewer's ref view cannot be re-observed here either. That is the defect: both views are fetch-state facts, not facts of `4b7d46f`. `git merge-base --is-ancestor e4dc5e1 4b7d46f` passes and `git diff --name-only e4dc5e1 4b7d46f` is `PLAN.md`. | Fixed. The baseline records only SHA-reproducible facts, cites `0281c5e`'s two consistent external observations, states the no-rebase/no-merge implication and retires the plan11-historical framing. The finding recurred, so a seam-path freshness gate now runs first in every implementation-slice PR. The plan18 bullet is annotated rather than silently rewritten. |
| 2   | Note; claims-journal paragraph and contract                     | Confirmed. The plan named `g7.claim` and "identical row" idempotence without fields. `Journal.append` serializes with `JSON.stringify` insertion order (`journal.ts:96-99`), and `recordDigest` (`packages/gauge/src/digest.ts:8`) is key-order canonical.                                                                                                                                                                | Fixed. A closed `{type, schema, id_inputs, attribution}` row is frozen in leaf `CONTRACT.md` in slice 5. It has no run/attempt fields and is compared by `recordDigest`. A pre-dispatch claimed-id probe prevents duplicate judgment calls. Three G7-T10 cases cover cross-run idempotence, the probe and the commit race.                                                |
| 3   | Note; contract and abstention/Q6 paragraphs                     | Confirmed. The plan said only that transient abstentions await Q6. It did not say whether deterministic `unattributed`/`none` records enter the claims journal, and G7-T12 did not bound ledger history.                                                                                                                                                                                                                  | Fixed. Every committed record, abstentions included, is a `g7.claim` row under the same Q6 check with no exemption. Q6 now names the same-revision, different-bundle consequence. G7-T10 adds `abstention then attribution follows the Q6 key` for both key alternatives, and G7-T12 adds `claims history does not change report counts`.                                 |
| 4   | Note; owner question Q7                                         | Confirmed. Q7 (a)/(b) is an import-boundary mechanism. The plan already recommended (b) with named paths and red/green controls.                                                                                                                                                                                                                                                                                          | Fixed. Option (b) is selected under D-ENG-021. Q7 now asks only for the participating hosts and path confirmation. Slice 2, G7-T14, the inventory, durability and dependency summary are updated, and the slice-1b baseline is unchanged.                                                                                                                                 |

## Verification performed for this plan

The tables below retain check evidence, not commit/staging status. Results
through plan7 are historical. The first table describes the original plan at the
inspected `e35767b` baseline. Later tables describe subsequent review revisions;
for the plan7 revision, only the plan7 table records checks for this update.
The plan8 through plan11, plan15, plan16/plan17 and plan18 results below are
also historical; the plan19 evidence at the end records this revision's checks.
Commit outcomes belong outside this file.

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

The `336f4ff` review-revision checks used a local Node `v22.23.4` toolchain, with no network or dependency installation:

| Check                                  | Observed result / blocker                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review acceptance and diff checks      | The eight review-topic documentation checks failed before editing and passed afterward; G7-T01–T14 remain present. `git diff --check` passed and only `PLAN.md` changed. This is plan acceptance evidence, not classifier red/green. |
| Every top-level `checks/*.mjs`, direct | All five gates passed with the same source counts listed above; `source-scan.mjs` loaded, exit 0.                                                                                                                                    |
| `npm run verify`                       | Attempted with Node 22; exit 1 in `check`. Benchmark-digest tests passed, verify-cache tests failed. Direct diagnosis again found missing `node_modules/.bin/vp` (`ENOENT`); later verify stages were not reached.                   |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider test files passed; `checks.test.mjs` failed. Direct execution showed unavailable child-process output in five fixture assertions (one passed). The suite remains failing.           |

Plan3 checks used a local Node `v22.23.4` toolchain, offline
with no dependency installation or source, schema, glossary or test edits:

| Check                                  | Observed result / blocker                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | All eight checks failed before editing and passed afterward; all G7-T01–T14 remain named. This checks the plan, not classifier behavior or quality.                                                                          |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                           |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                               |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed, verify-cache tests failed; later stages were not reached. No local `node_modules`; a direct local `vp` probe returned `ENOENT`. Full verification remains blocked. |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed, `checks.test.mjs` failed. Direct diagnosis reproduced five failures with unavailable child-process output and one pass; no harness was changed.               |

Plan4 checks used a local Node `v22.23.4` toolchain, offline,
with no dependency installation or source, schema, glossary or test edits:

| Check                                  | Observed result / blocker                                                                                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | Seven change checks failed before editing; the preservation check for `isId`, G7-T01–T14 and the learning notes already passed. All eight checks passed afterward. This checks the plan only, not classifier behavior or quality. Retry and sealing alternatives remain open owner decisions. |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                                                                                            |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                                                                |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed, verify-cache tests failed; later stages were not reached. No local `node_modules`; a direct local `vp` probe returned `ENOENT`. Full verification remains blocked.                                                                  |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed; `checks.test.mjs` failed. Direct execution reproduced five failures with unavailable child-process output and one pass. No harness was changed.                                                                                |

Plan5 checks used a local Node `v22.23.4` toolchain, offline,
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

Plan6 checks used a local Node `v22.23.4` toolchain, without
dependency installation or source, schema, glossary or test edits:

| Check                                  | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | Nine change checks failed before editing; the question/test preservation check already passed. All ten pass after editing. This is documentation acceptance only, not classifier behavioral red/green or quality evidence. G7-T01–T14 remain; G7-T15 is assigned to slice 3. Q1–Q7 remain open, including Q7(b)'s schema/test location and ownership. D-ENG-017 is explicit.                                                                                                                                                                                                             |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Main freshness                         | Historical plan6 check: cached `origin/main` was `e35767b`; `439cea6` was unavailable in that earlier worktree, fetch failed on read-only `FETCH_HEAD` and remote lookup failed DNS. Historical plan8 inspection used `f24b99f`, containing `0311340` and `439cea6`; plan9 supersedes main freshness with `e4dc5e1`. Only the Fabric store/tests, verify-cache tests, `vite.config.ts` and `package.json` changed from `e35767b`; the changed Fabric seam was separately reinspected as described above. The plan9 rebase failure is historical; merge `eba7634` incorporates `e4dc5e1`. |
| `npm run fmt:check`                    | Exit 127: `vp: not found`; no local `node_modules`. Formatting and whether the formatter covers `PLAN.md` remain unverified. No formatter configuration was changed.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed, verify-cache tests failed; later stages were not reached. The local `vp` probe reports `ENOENT`; full verification remains blocked.                                                                                                                                                                                                                                                                                                                                                                                            |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed; `checks.test.mjs` failed. Direct execution showed five failures with unavailable child-process output and one pass. A child-process probe reports `EPERM`; no harness or permissions were changed.                                                                                                                                                                                                                                                                                                                        |

Plan7 checks used a local Node `v22.23.4` toolchain, without
dependency installation or changes outside `PLAN.md`:

| Check                                  | Observed result / blocker                                                                                                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance  | All nine review-topic checks failed before editing and pass afterward; the Q1–Q7/G7-T01–T15 preservation check passed throughout. This is plan acceptance only, not classifier behavioral red/green. Every owner question remains open.                    |
| Scope and whitespace                   | `git diff --check` passed; only `PLAN.md` changed.                                                                                                                                                                                                         |
| `npm run fmt:check`                    | Exit 127: `vp: not found`; no local `node_modules`. Formatter execution and its coverage of `PLAN.md` remain unverified; no formatting configuration was changed.                                                                                          |
| Every top-level `checks/*.mjs`, direct | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                             |
| `npm run verify`                       | Exit 1 in initial `check`: benchmark-digest tests passed; verify-cache tests failed. Direct diagnosis reports missing `node_modules/.bin/vp` (`ENOENT`); later verify stages were not reached.                                                             |
| `npm run test:checks`                  | Exit 1: credential-parity and execution-provider files passed; `checks.test.mjs` failed. Direct diagnosis reproduced five empty-child-output fixture failures and one pass; a child-process probe reports `EPERM`. No harness or permissions were changed. |

Plan8 checks used a local Node `v22.23.4` toolchain and npm `10.9.9`. Only `PLAN.md` changes in this worktree.
Historical plan8 evidence, recorded in `f0f0f04`, used an archive of inspected
`f24b99f` plus that revision's plan. The borrowed Vite+ version was `1.2.0`;
it matches the lockfile pin at `f24b99f` and `e4dc5e1`. No dependency installation
or configuration change was required. Archive checks do not establish
authoritative formatter evidence on the merged branch. Plan9 below records
historical checks before merge `eba7634`; that merge satisfies freshness
against `e4dc5e1`.

| Check                                                           | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review-topic documentation acceptance                           | Six review-topic checks failed before editing and pass afterward; both preservation checks pass. Q1–Q7 are textually unchanged apart from formatting, G7-T01–T15 remain present, and D-ENG-017 remains scoped to #329 with no G7 rename dependency. This is documentation acceptance only.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Main freshness and rebase                                       | Historical plan8 check at `f24b99f` (not current main); comparison against `e35767b` found exactly the five files listed above. Inspected the changed store and tests; `FabricStore` remains exported at line 191 and retains its receipt-source role. Both prerequisite ancestor checks passed. Before editing, the task branch was clean and its entire branch diff was `PLAN.md` only. Rebase onto `f24b99f`, using the clone's objects read-only, failed creating `rebase-merge`: read-only git metadata. Fetch likewise failed on read-only `FETCH_HEAD`; remote lookup failed DNS. That rebase failure is historical: merge `eba7634` incorporates `e4dc5e1` and meets freshness against that baseline by merging. |
| `npm run fmt:check`                                             | Direct worktree invocation lacks local `vp` (exit 127). In the historical `f24b99f` archive, the initial check identified only `PLAN.md` as unformatted. Formatted only the plan at configured printWidth 120; full `npm run fmt:check` passes on 506 files. Explicit `npm run fmt:check -- PLAN.md` also passes on one file, proving plan coverage. Those checks apply to the plan8 bytes recorded in `f0f0f04`; they do not prove formatting on a rebased branch.                                                                                                                                                                                                                                                      |
| Every top-level `checks/*.mjs`, direct in the `f24b99f` archive | All five gates passed: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loaded, exit 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm run verify`, historical `f24b99f` archive                  | Exit 1: the new leading `fmt:check` passes; benchmark-digest tests pass; verify-cache tests fail. Direct cache diagnosis passes 3/7 tests, with three read-only-cache initialization failures and an interruption-fixture timeout. Later verify stages were not reached. Full green remains unverified; no checks or permissions were weakened.                                                                                                                                                                                                                                                                                                                                                                          |
| `npm run test:checks`, historical `f24b99f` archive             | Exit 1: credential-parity and execution-provider test files pass; `checks.test.mjs` fails. Direct diagnosis reproduces five empty-child-output assertion failures and one pass. A minimal child-process probe reports `EPERM` and empty output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Scope and whitespace                                            | `git diff --check` passes; only `PLAN.md` changes. No commit outcomes are recorded here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Historical plan9 checks, recorded in `dc87fd0` before merge `eba7634`, used
Node `v22.23.4` and npm `10.9.9`. The borrowed Vite+ `1.2.0`
matches the lockfile pin at both inspected `f24b99f` and `e4dc5e1`.
Only `PLAN.md` was edited. Formatter checks below targeted the plan9 worktree bytes;
an explicit `--config` used a byte-identical copy of the pre-merge branch's
`vite.config.ts` with a writable config cache and the matching borrowed tool.
Its formatter settings match `f24b99f` and `e4dc5e1`.
Moving the config changes the base for relative ignore patterns; the full check
therefore also passes each existing `fmt.ignorePatterns` entry as an explicit
negated repo-relative path glob (directory entries expand to `/**`). No new
exclusions are added. A config-copy-only full check failed on 27 files normally
excluded by the repository config; none of those files was changed.
No dependency installation or repository configuration change was needed for
those checks. They do not establish formatting or full verification on merge
`eba7634`: plain `npm run fmt:check -- PLAN.md`, full `npm run fmt:check` and
`npm run verify` still need to run on the merged branch in a dependency environment.

| Check                                                                 | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance                                 | Seven review-topic checks failed before editing; the preservation check passed. After editing, all eight pass: Q1–Q7 remain textually unchanged apart from formatting; G7-T01–T15 and D-ENG-017 remain present. This is documentation acceptance only, not classifier behavioral evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Main freshness and rebase                                             | Before editing, the branch was clean and its entire branch diff was `PLAN.md` only. `origin/main` is `e4dc5e1`; `git diff --name-only f24b99f e4dc5e1` lists only `scripts/verify-cached.test.mjs`, including `444c0d0` and #378. The prerequisite ancestor checks pass. `git rebase origin/main` failed creating `rebase-merge`: read-only git metadata. Those failures are historical. Merge `eba7634` incorporates `e4dc5e1`, making it the verified merge-base and meeting freshness against that baseline by merging. The later-main availability limitation was historical: `0281c5e` and its test-only diff were verified locally in the plan11 session; see the baseline above. Plain formatter and verify checks remain to be run on the merged branch in a dependency environment. |
| Formatter invocation                                                  | Plain `npm run fmt:check -- PLAN.md` with the borrowed binary on PATH fails loading local `vite-plus` and creating the config cache because this worktree has no local dependencies. The explicit byte-identical `--config` copy allows formatting checks of the actual worktree files without editing repository configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `npm run fmt:check -- PLAN.md --config <config-copy>`                 | Passes on the actual worktree `PLAN.md`, one file, proving coverage with Vite+ `1.2.0` and the unchanged configured printWidth 120. This historical check does not establish formatting on merge `eba7634`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Full `npm run fmt:check` with the config copy and existing exclusions | Passes on 506 files, including `PLAN.md`, with only the existing ignore patterns mirrored as explicit negated globs as described above. The plain command still needs to run on the merged branch in a dependency environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm run verify`                                                      | Exit 1 in initial `check`: benchmark-digest tests pass; verify-cache tests fail. This is historical plan9 evidence before merge `eba7634`. At `eba7634`, `verify` includes the leading `npm run fmt:check` gate; plain `npm run verify` still needs to run on the merged branch in a dependency environment. Local dependencies are absent; later verify stages were not reached. No checks or permissions were weakened.                                                                                                                                                                                                                                                                                                                                                                    |
| Scope and whitespace                                                  | `git diff --check` passes; only `PLAN.md` changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Plan10 checks use a local Node `v22.23.4` toolchain, npm `10.9.9` and matching
borrowed Vite+ `1.2.0` on the worktree based on merge `eba7634`. Only `PLAN.md`
changes. Formatter checks use a byte-identical copy of that merge's
`vite.config.ts` with a writable config cache; the full check mirrors only its
existing ignore patterns as explicit negated repo-relative globs, as in plan9.
These checks cover the edited worktree bytes without changing repository
configuration or installing dependencies; they do not replace the plain commands.

| Check                                                      | Observed result / blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review-topic documentation acceptance                      | Eight change checks failed before editing; the preservation check passed. All nine pass afterward. Q1–Q7 are textually unchanged and remain open; G7-T01–T15 remain present. This is documentation acceptance only, not classifier behavioral evidence.                                                                                                                                                                                                                                                |
| Main freshness                                             | Merge `eba7634` has parent `e4dc5e1`, which is the verified merge-base with cached `origin/main`. Freshness against that baseline is met by merging. The earlier availability/DNS limitation is historical. Verified locally for plan11: `0281c5e` is one successor commit touching only `scripts/verify-cached.test.mjs`, with no inspected seam changed. The branch stays one test-only commit behind because this task changes only `PLAN.md`; no merge is needed to validate these plan contracts. |
| `npm run fmt:check -- PLAN.md` and `npm run verify`, plain | Both exit 127 at `vp: not found` because local dependencies are absent. `verify` reaches its leading `fmt:check`; later stages do not run. Plain full formatter and verify commands remain to be completed in a dependency environment.                                                                                                                                                                                                                                                                |
| `npm run fmt:check` with config copy                       | Explicit `PLAN.md` check passes on one file; the full check with the existing exclusions passes on 506 files, including `PLAN.md`. Vite+ `1.2.0` matches the lockfile; no new exclusions or formatter configuration changes.                                                                                                                                                                                                                                                                           |
| Every top-level `checks/*.mjs`, direct                     | All five gates pass: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loads, exit 0.                                                                                                                                                                                                                                                                                                                                            |
| Scope and whitespace                                       | `git diff --check` passes; only `PLAN.md` changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Plan11 checks use Node `v22.23.4` and the matching borrowed Vite+ `1.2.0`,
with no dependency installation or edits outside `PLAN.md`. Formatter fallback
uses a byte-identical copy of `5d6c817`'s `vite.config.ts` with a writable cache;
this changes no repository configuration or exclusion. These are documentation
checks, not classifier behavioral evidence.

| Check                                                                                  | Observed result / blocker                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-topic documentation acceptance                                                  | Four finding checks fail before editing and pass afterward; the two preservation checks pass throughout. Q1–Q7 remain textually unchanged apart from formatting and open; G7-T01–T15 remain present.                                                    |
| Main freshness                                                                         | Verified local commit `0281c5e` is exactly one successor of `e4dc5e1`; the diff touches only `scripts/verify-cached.test.mjs`, with no inspected seam changed. The branch intentionally remains one test-only commit behind for this PLAN.md-only task. |
| Plain `npm run fmt:check` and `npm run verify`                                         | Both exit 127 at `vp: not found`; local dependencies are absent. Verify stops at its leading formatter, so the full suite remains unverified.                                                                                                           |
| `npm run fmt:check -- PLAN.md --config <config-copy>` with matching borrowed formatter | Initial check detects formatting changes; after formatting, passes on the actual `PLAN.md` bytes, one file, proving coverage.                                                                                                                           |
| Every top-level `checks/*.mjs`, direct                                                 | All five gates pass: import direction (325 files), clock (104), entropy (51), environment (133), failure propagation (12); `source-scan.mjs` loads, exit 0.                                                                                             |
| Scope and whitespace                                                                   | `git diff --check` passes; only `PLAN.md` changes.                                                                                                                                                                                                      |

Plan15 checks use Node `v22.23.4` and matching borrowed Vite+ `1.2.0` with no
dependency installation or repository configuration changes. Only `PLAN.md`
changes. These are documentation checks, not classifier behavioral evidence.

- Review-topic documentation checks: seven change checks fail before editing
  and all eight checks pass afterward, including preservation of G7-T01–T15
  and D-ENG-017. The full review JSON was read; the six findings are addressed
  by the mechanical gates, child targets, scanner boundary, manifest roles,
  raw-byte digest helper and deferred glossary additions above.
- Formatter: plain `npm run fmt:check -- PLAN.md` exits 127 (`vp` absent locally).
  With the matching borrowed binary and a byte-identical config copy in a
  writable temporary directory, the explicit `PLAN.md` check passes on one
  file. Full `npm run fmt:check` using that copy and only the config's 22
  existing exclusions passes on 506 files, including `PLAN.md`. No exclusions
  or formatter settings are added or changed.
- `npm run verify` exits 127 at its leading formatter because local dependencies
  are absent; subsequent suite stages do not run. All five top-level
  architectural gates pass directly: import direction (325 files), clock
  (104), entropy (51), environment (133) and failure propagation (12).
  The shared `source-scan.mjs` helper also loads successfully.
- `git diff --check` passes; the diff contains only `PLAN.md`. HEAD seam checks
  are recorded above; newer-main freshness remains unverified in this session.

Plan16/plan17 checks against review target `64da02e` use Node `v22.23.4`
from `/home/box/.local/node22/bin`, matching borrowed Vite+ `1.2.0` and
TypeScript `7.0.2`. No dependency installation, source/test/schema/glossary or
repository configuration edits were made. Only `PLAN.md` changes. These are
planning/documentation and toolchain checks, not G7 classifier behavior or
sealed-evaluation evidence.

- Review-topic documentation checks: all six finding checks fail on the
  committed `64da02e` plan. Four still fail on the inherited partial edits;
  all six pass on the completed plan, together with two preservation checks
  for Q1–Q7 and the existing G7-T01–T15/import/dynamic-loading/closed-child
  controls and D-ENG-017. The owner-question text changes only to substitute
  structural fs/import-attribute enforcement for the reviewed call-site rule.
  Findings map to the free-global gate, structural fs permissions, explicit
  lint evidence, the single AST pass, the per-file table/forbidden built-ins/
  extension and attribute rules, and the refreshed baseline respectively.
- The temporary Node type-stripping/test-runner probe uses the same computed
  property lookup of a function constructor in both runs. It fails its expected
  `EvalError` assertion without `--disallow-code-generation-from-strings` and
  passes with the flag (one test, zero skips). This verifies propagation to
  Node's per-file test subprocess, not a production sandbox.
- The temporary TypeScript API probe parses an isolated module and compares
  declaration paths for ambient `JSON` and a locally shadowed `JSON`
  parameter/reference. The former resolves to default-library declarations;
  both local occurrences resolve to the temporary source. The probe passes
  with and without the code-generation flag. It does not execute that module
  or establish the future scanner's completeness; slice 1b must prove its
  controls, including shorthand values and ambient declaration rejection.
- Plain `npm run fmt:check`, `npm run verify` and `npm run lint` exit 127
  (`vp: not found`). Borrowing only the binary also fails to resolve local
  `vite-plus` and its config cache. With a byte-identical HEAD `vite.config.ts`
  copy in a writable temporary directory and matching borrowed Vite+, the
  explicit `npm run fmt:check -- PLAN.md --config <config-copy>` passes on
  the actual plan bytes. Full `npm run fmt:check` with that copy and only the
  config's 22 existing exclusions mirrored as negated repo-relative globs
  passes on 506 files, including `PLAN.md`. No exclusions/settings are added.
- All five top-level architectural gates pass directly: import direction
  (325 files), clock (104), entropy (51), environment (133) and failure
  propagation (12). `source-scan.mjs` loads successfully. The existing
  `scripts/benchmark-digests.test.mjs` passes under Node 22.
- `npm run test:checks` fails: credential-parity and execution-provider test
  files pass; `checks.test.mjs` fails. Direct execution of that file yields
  one pass and five failures with missing child output. A minimal nested
  `spawnSync` probe reports `error.code: EPERM` and empty stdout/stderr, even
  though its status field is zero. This is a harness/environment blocker,
  not a green test result. Full `verify` stops at its leading formatter;
  later suite stages remain unverified.
- `git diff --check` passes and only `PLAN.md` is modified. Historical
  newer-main claims above remain historical; `0281c5e` is unavailable locally.
  Commit outcomes are reported outside this file.

Plan18 checks against review target `ba58a2d` use Node `v22.23.4` from
`/home/box/.local/node22/bin`. No dependency installation or
source/test/schema/glossary/configuration edits were made; only `PLAN.md`
changes. These are planning checks, not G7 classifier or sealed-evaluation
evidence.

- Repository facts behind the nine findings were rechecked at `ba58a2d`:
  `Journal` construction, load repair and `acquireLock`'s recursive `mkdirSync`
  (`benchmarks/decision-sites/journal.ts:37-41,59-95,276-282`); the
  `JournalIndex` cost/reservation handling of `intent`, `call` and
  `budget_stop` rows (`journal.ts:217-259`); `test:decision-sites`' leading
  `npm run build`; the `dist`-only `exports` of `@weave/gauge` and
  `@weave/weft`; the GLOSSARY **Holdout**, **Tune split** and Acceptance*
  entries; and no JS/TS `eval(`/`new Function(` use. `git cat-file -t 0281c5e`
  fails in this worktree (local `main` `74683ef`, `origin/main` `e4dc5e1`), so
  the baseline now marks all `0281c5e` observations as plan11-historical rather
  than asserting presence as the review suggested. (Plan19 retires that
  framing: ref positions are clone fetch state, not facts of the reviewed SHA;
  see the baseline freshness paragraph.)
- Lint ids: a sibling local install with the lockfile's Vite+ `1.2.0`, oxlint
  `1.88.0` and `oxlint-tsgolint` `7.0.2004` was read, not executed. Its config
  schema lists `no-eval`, `no-new-func`, `no-implied-eval` and the type-aware
  `typescript/no-implied-eval`, and Vite+ types `lint` as `OxlintConfig`.
  Running `oxlint --rules` was not permitted in this session.
- Formatter: plain `npm run fmt:check` exits 127 (`vp: not found`); with the
  sibling `vp` on `PATH` it fails to resolve `vite-plus` from this worktree's
  `vite.config.ts`, and this session could not create a config copy or link
  dependencies. Only the two edited tables needed realignment; they were
  realigned by a script that reproduces Prettier's aligned-table output and
  leaves every table in the committed `ba58a2d` plan, which plan17 recorded
  as formatter-clean, byte-identical. Other edits are prose under the preserve wrap mode. The plain
  `npm run fmt:check` remains to be run in a dependency environment.
- `git diff --check` passes and only `PLAN.md` is modified.

Plan19 checks against review target `4b7d46f` use Node `v22.23.4`. No
dependency installation or source/test/schema/glossary/configuration edits
were made; only `PLAN.md` changes. These are planning checks, not G7
classifier or sealed-evaluation evidence.

- All four findings of the GLM review JSON were read and verified against HEAD
  as recorded in the disposition table. `git diff --name-only ba58a2d 4b7d46f`
  lists only `PLAN.md`. `git merge-base --is-ancestor e4dc5e1 4b7d46f` passes.
  `git diff --name-only e4dc5e1 4b7d46f` lists only `PLAN.md`.
  `git cat-file -t 0281c5e` fails in this clone, and `git fetch origin main` was
  not permitted. The plan now asserts neither outcome as repository fact.
  Every seam-path gate path exists. A dry run of the gate's pathspec against
  `4b7d46f` (`git diff --name-only e4dc5e1 HEAD -- <gate paths>`) prints nothing.
  `Journal.append`'s `JSON.stringify` (`journal.ts:96-99`) and `recordDigest`'s
  sorted-key canonicalization (`packages/gauge/src/digest.ts:8-25`) back the
  `g7.claim` comparison rule.
- Formatter: plain `npm run fmt:check` exits 127 (`vp: not found`; no local
  `node_modules`), and invoking the Node 22 npm directly was not permitted in
  this session. The edited tables were realigned by a Prettier-style table
  script, which was first confirmed to leave every table of the committed
  `4b7d46f` plan byte-identical. Other edits are prose under the preserve wrap
  mode. Plain `npm run fmt:check` remains to be run in a dependency environment.
- `git diff --check` passes and only `PLAN.md` is modified.

Full green must be established in the supported Node/dependency environment
before implementation PRs merge. Do not change scripts, suppress failures or
relax policy to hide these blockers. Current uncertainties are missing causal
inventory in some historical runs, independent label availability, and the
generalization of a small labelled set; G7 must report each rather than claim
unsupported attribution accuracy.
