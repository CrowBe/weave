# WV-329: workstream → one nestable Thread kind (D-ENG-017)

Planning only. D-ENG-017 (Benjamin, 1 November 2026) locks one nestable
**Thread** kind at every depth, retaining `thread@1`, `thread_id` and `thread.*`.
This plan prepares the atomic workstream → Thread rename into that family;
it changes no source, glossary, tests, schemas or recorded data. Owner questions
1–4 are answered; only Q5–Q8 remain open in section 7.

## 1. Evidence, scope, and data shape inventory

Planning checkout HEAD: `f7b34887f3ca3a4b1d6d94d21269f75f45cff359` (`f7b3488`),
branch `wv-329-thread-rename-plan`, inspected on 1 November 2026. This is reviewed
plan `48e9192` plus the merge of locally available `origin/main` at `e35767b`.
`48e9192` differs from original plan commit `02543c2` only in `PLAN.md`.
#320 (`8ce60c5`, PR #362), `docs/durable-recursive-threads.md` and its glossary
additions are now present. They describe proposed, unimplemented runtime behavior.
Read `VISION.md`, `GLOSSARY.md`, `AGENTS.md`, current contracts, transitions and
their tests, Weft validation/emission/recovery tests and import-direction checks
before revising this plan. Review evidence is the supplied
`/workspace/wvops/WV-329-review-48e9192.json`; its missing-#320 finding describes
the reviewed base, not this merged checkout.

Every implementation PR must branch from current `origin/main` (at least
`e35767b`, including #320), carrying only its declared prerequisite changes.
PR 1 starts with a recount there and records that exact base SHA. The local
`origin/main` reference is not a claim of remote freshness; this task has no
network. No branch change is part of this PLAN.md-only revision.

No network or push is permitted for this revision. References to #26, #28,
#314 and #330 use supplied issue summaries and checked-in references; their
latest remote text/status is unverified. #330's exact document/scope remains
unknown. No files in the WV-320 worktree need to be read or edited.

Reproduce the required inventory, including plurals and identifier substrings:

```sh
rg -n -i 'workstream' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
rg --json -i 'workstream' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
rg -n -i 'thread' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
```

Counts below are regex **occurrences**, not just matching lines; the JSON
`submatches` arrays provide occurrence counts. These are tracked/source inputs
visible to normal `rg`, excluding ignored build/dependency output. The scanned
inputs were recounted at planning HEAD `f7b3488`; `PLAN.md` is outside these
roots. PR 1 must recount on its current origin/main base. The groups in this
table partition all **489 occurrences on 390 lines in 13 files**: lowercase
`workstream` 291, `Workstream` 183, uppercase `WORKSTREAM` 15.

| Group | File | Occurrences | Matching lines |
| --- | --- | ---: | ---: |
| Record, exported types/functions | `packages/weave/src/workstream.ts` | 139 | 104 |
| Package exports | `packages/weave/src/index.ts` | 14 | 14 |
| `input.route` state and transitions | `packages/weave/src/input-route.ts` | 52 | 38 |
| `input.route` disclosed state | `packages/weave/src/sites/index.ts` | 2 | 2 |
| Operating-process records | `packages/weave/src/operating-process.ts` | 9 | 7 |
| Contract documentation | `packages/weave/src/WORKSTREAM-CONTRACT.md` | 66 | 58 |
| Site documentation | `packages/weave/src/sites/CONTRACT.md` | 4 | 2 |
| Execution-provider documentation | `docs/execution-provider-contract.md` | 4 | 3 |
| Domain definitions and language rules | `GLOSSARY.md` | 11 | 7 |
| #320 design terminology | `docs/durable-recursive-threads.md` | 9 | 7 |
| Tests and inline fixtures | `packages/weave/test/workstream.test.ts` | 98 | 82 |
| Tests and inline fixtures | `packages/weave/test/input-route.test.ts` | 47 | 37 |
| Tests and inline fixtures | `packages/weave/test/operating-process.test.ts` | 34 | 29 |
| No matches | `checks/`, `AGENTS.md` | 0 | 0 |

Group totals: record/API 153; input routing 54; operating-process source 9;
documentation/glossary 94; tests/inline fixtures 179. There are no separate
workstream fixture files or matches in other packages in this scan.

### Schema IDs and serialized keys (subsets of the table)

`workstream@1`: **5 inside the scan roots, 6 repo-wide including `CONTRACT.md:12`**
(excluding this plan). The 5 scan-root occurrences are in 3 files:
`packages/weave/src/workstream.ts` (1),
`packages/weave/src/WORKSTREAM-CONTRACT.md` (3), and
`packages/weave/test/workstream.test.ts` (1).
`WORKSTREAM_SCHEMA` occurs 5 times: source module (4) and public barrel (1).

The record has ordered keys `schema`, `workstream_id`, `project_id`, `origin`,
`opened_at`, `revision`, `goals`, `inputs`, `artifacts`, `process`. The index has
`project_id`, `workstreams`; successful transition results have `ok`, `index`,
`workstream`. Goal, input, and artifact entries retain ids, revisions and
observation sequence references, never authority or content bodies.

The exact identifier `workstream_id` occurs **71 times in 7 files**:
`packages/weave/src/workstream.ts` (17),
`packages/weave/src/operating-process.ts` (7),
`packages/weave/src/input-route.ts` (14),
`packages/weave/src/WORKSTREAM-CONTRACT.md` (5),
`packages/weave/test/workstream.test.ts` (14),
`packages/weave/test/operating-process.test.ts` (5), and
`packages/weave/test/input-route.test.ts` (9).
The separate `new_workstream_id` identifier occurs **5 times** in input-route
source (2) and tests (3). Thus an unbounded substring search for
`workstream_id` gives 76, not 71.

`duplicate_workstream` and `unknown_workstream` together occur **12 times**:
workstream source (5), input-route source (2), workstream tests (2), and the
workstream contract (3). They are closed refusal values; changing them is also
a contract change, not merely a variable rename.

### Export surface

`packages/weave/src/workstream.ts` declares 9 exported types/interfaces:
`Workstream`, `WorkstreamOrigin`, `WorkstreamGoal`, `WorkstreamInput`,
`WorkstreamArtifact`, `WorkstreamIndex`, `WorkstreamEvent`, `WorkstreamRefusal`,
`WorkstreamResult`; one constant `WORKSTREAM_SCHEMA`; and 7 functions
`boundedId`, `validSeq`, `emptyWorkstreamIndex`, `activeGoal`, `openWorkstream`,
`replaceWorkstream`, `transitionWorkstream`.

`packages/weave/src/index.ts:247` re-exports all 9 types, the constant,
`emptyWorkstreamIndex`, `openWorkstream`, `transitionWorkstream`, and
`activeGoal`: **14 public names**, of which 13 contain the old term.
`boundedId`, `validSeq`, and `replaceWorkstream` are module exports only.
The package manifest exports only the package entry point; no supported
`@weave/weave/workstream` subpath exists. The three test files import the
module directly, while input routing imports it internally.

Proposed new names are `Thread*`, `THREAD_SCHEMA`, `emptyThreadIndex`,
`openThread`, `replaceThread`, `transitionThread`, module `thread.ts`, index
`threads`, result/request property `thread`, and refusals
`duplicate_thread`/`unknown_thread`. Keep `boundedId`, `validSeq` and
`activeGoal` unless a separately demonstrated conflict requires a change.
Section 4 locks the in-place serialized-key/schema rename before first
persistence; PR 1 establishes its single-kind contract before implementation.
No arbitrary identifier value such as fixture id `ws-a` needs rewriting.

### Input routing and operating-process dependencies

`packages/weave/src/input-route.ts` exports `RouteRecord`, `RouteCorrection`,
`RouteRequest`, `RouteContext`, `RouteRefusal`, `RouteApplied`, `RouteCorrected`
with workstream references, plus `RouteAsk`, `RouteReason`, `RouteOutcome`,
`ROUTE_OUTCOMES`, `routeRule`, `transitionRoute`, `decideRoute`, `applyRoute`,
`correctRoute`, and `nextQueued`. Its imports, local variables, request
`workstream`, injected `new_workstream_id`, and successful indexes all need
consistent API mapping. Route names themselves do not change.

`RouteRecord` is `input.route@1` and `RouteCorrection` is
`input.route.correction@1`; **both have serialized `workstream_id`**.
`RouteState` in `packages/weave/src/sites/index.ts:70` contains only disclosed
`input` and `active_work: { summary, process }`: no workstream id or grant is
sent to the judgment site. Its two old-term occurrences are comments.
`SITE_POLICY['input.route']` retains `conversation`, `steer`, `interrupt`,
`parallel`, `queue`, confidence/fallback rules, and its provider boundary.

`packages/weave/src/operating-process.ts` exports `OperatingProcess` with
serialized `workstream_id` under `operating.process@1`. `openProcess` accepts
that id; `move` preserves it and the `Change` type excludes it from edits.
Keep process names and states; rename its ownership reference only under the
locked in-place rename policy. Preserve pause/stop evidence, resume-point digest,
revision and terminal-state rules.

### Documentation and test coverage

Rename `packages/weave/src/WORKSTREAM-CONTRACT.md` to `THREAD-CONTRACT.md` in
the implementation slice, replacing its overridden naming assumption and
updating links from source comments and `packages/weave/src/sites/CONTRACT.md`.
Fold glossary Workstream and Thread into one Thread entry in PR 1; align
Operating process, Input routing, Project and the affected language constraints,
together with #320's additions and design terminology listed in section 3.
`docs/execution-provider-contract.md` currently lists Threads and workstreams
separately; align it with the same kind at different depths.

The three tests contain **33 top-level behavioral tests**: workstream 8,
operating process 10, input route 15. They pin ordered serialized keys,
schemas, refusal values, opening without authority, one active goal,
independent records, input ordering, artifact revisions, byte-identical
transition replay, process lifecycle, routing atomicity/correction, cancellation,
and provider-free reconstruction. Their existing assertions are acceptance
constraints, not snapshots to regenerate wholesale. Preserve any actual
transitional bytes if discovered; none are expected for workstream records under D-ENG-017. Do not invent a legacy reader for fixtures.

A repository-wide cross-check found another **4 occurrences on 2 lines** in
root `CONTRACT.md`, outside the requested roots: contract title/link, schema and
execution description. Include its link/terminology update in implementation.
There are no other workstream matches outside the required scan roots at this
baseline (excluding this plan). PR 2a's legacy-name scan covers the whole
repository, including root `CONTRACT.md`, with an explicit allowlist.

## 2. Existing Thread terminology and correlation inventory

The broad case-insensitive `thread` scan above finds
**535 occurrences on 431 lines in 48 files**. It includes plurals,
`running_threads`, `new_thread`,
`thread_identifier`, component names and OS threading; those are classified
below rather than globally substituted. Counts in each row are occurrences.

### Existing causal projection, emission, storage and tests

This table describes current implementation evidence, not a second product
identity to retain. The reference emitter currently maps `thread_id = action_id`
and has no durable Thread binding. D-ENG-017 requires the target mapping to the
Thread tree node owning the span. PR 1 records that crosswalk; PR 3 supplies
behavioral evidence for the emission mapping once durable node binding exists.
Null envelope fields remain permitted for records without a Thread.

| File | Count | Use and treatment |
| --- | ---: | --- |
| `packages/weave/src/weft.ts` | 21 | Port envelope, action causal lifecycle, deterministic record ids and join/supersession/cancel links; preserve historical evidence; align new emission with the owning Thread node in PR 3. |
| `packages/gateway/src/weft.ts` | 2 | Envelope field and null emission; no project identity. |
| `packages/agentfabric/src/weft.ts` | 2 | Envelope field and null emission; no project identity. |
| `packages/weft/src/types.ts` | 3 | `thread.transition`, outcome subject `thread`, envelope `thread_id`. |
| `packages/weft/src/validate.ts` | 12 | Closed keys/kinds/subject, id rules and cross-record link requirements. |
| `packages/weft/src/WEFT-CONTRACT.md` | 35 | Definition, transitions, cross-chain links, crash/recovery identities, action mapping, SQLite scopes. |
| `packages/weft/src/otel.ts` | 2 | Exports envelope as `weft.thread_id`; keep attribute name; align its node mapping in PR 3. |
| `packages/weft/src/sqlite-intake.ts` | 3 | Imports that OTel attribute; null for generic spans. |
| `packages/weft/src/sqlite.ts` | 18 | `threads` table, `thread_id` foreign keys/columns and insertion; legacy rows null. |
| `packages/weft/fixtures/records.json` | 66 | Valid/invalid v1 records, transitions and causal links. |
| `packages/weft/fixtures/otel-all-kinds.json` | 12 | Golden span attributes and transition kind. |
| `packages/weft/fixtures/otel-golden.json` | 4 | Golden causal attributes. |
| `packages/weft/test/validate.test.ts` | 11 | Envelope/kind/transition validation and rejection paths. |
| `packages/weft/test/otel.test.ts` | 5 | Causal attribute export; no project identity. |
| `packages/weft/test/sqlite.test.ts` | 2 | Existing `threads` table and its scope. |
| `packages/weft/test/sqlite-intake.test.ts` | 2 | Known Weft/generic null attributes. |
| `packages/weft/test/otel-all-kinds.test.ts` | 1 | Canonical causal transition. |
| `packages/weft/test/otel-schema.test.ts` | 1 | Null causal envelope field. |
| `packages/weft/test/disclosure.test.ts` | 1 | Null causal envelope field. |
| `packages/weft/test/sink.test.ts` | 1 | Null causal envelope field. |
| `packages/weave/test/w5-trace.test.ts` | 32 | #187 concurrent chains, joins, repeated cancellation, supersession and emitter correlation. |
| `packages/weave/test/w5-fixture.ts` | 1 | Causal envelope type for W5. |
| `packages/weave/test/w5-records.test.ts` | 1 | W5 transition kinds validate. |
| `packages/weave/test/w5-isolation.test.ts` | 1 | Causal reporting does not alter scheduling. |
| `packages/weave/test/w5-replay.test.ts` | 1 | Recovery preserves the parent of newly opened causal work. |
| `packages/gateway/test/weft.test.ts` | 1 | Null causal envelope field. |
| `docs/research/typesafe-harness-lessons.md` | 3 | Explicitly defines a thread as the causal sequence; work dependencies and effect locks are separate. |

#181's tracing scope is represented locally by the Weft contract and W5 #187
acceptance files; its remote issue text was not retrieved. Existing causal links
are `joins`, `supersedes`, `cancels`, `handoff` (plus general `caused_by` and
`retry_of`), all targeting records within one trace. Their record targets are
not parent links in the Thread tree. Dependencies join dependency chains'
`closed` records;
supersession belongs to the earlier chain and names the replacement's `opened`
record; cancellation names the affected chain's `opened` record. A repeated
cancel has a distinct sequence-derived record id. Forward link targets can
arrive later. Preserve all those meanings, even when prose uses the new term.

### Terminology to fold into one kind, and unrelated uses

| File | Count | Classification |
| --- | ---: | --- |
| `GLOSSARY.md` | 36 | Current Thread/Workstream distinction is superseded by D-ENG-017; fold it and the present #320 additions into one nestable Thread entry in PR 1. Intake labels and `running_threads[].thread_id` semantics await Q6. |
| `docs/durable-recursive-threads.md` | 160 | #320's proposed durable Thread contract; reconcile normative naming, id scope and nesting rules in PR 1, remaining explanatory prose in PR 4. |
| `packages/weave/src/WORKSTREAM-CONTRACT.md` | 8 | #26's quoted thread is already project-level; remaining comparisons explicitly distinguish the causal-chain Thread and Weft id from the workstream. Replace the distinction with D-ENG-017's single nestable kind. |
| `packages/weave/src/sites/index.ts` | 6 | `IntakeState.running_threads[].thread_id`, fixed intake question and `new_thread`/`continue_thread`: legacy task/causal-work vocabulary; no durable Thread-tree integration yet. Q6 must resolve whether new disclosed ids point at nodes or the field is renamed separately; frozen benchmark bytes stay unchanged. |
| `packages/weave/src/sites/CONTRACT.md` | 1 | Same intake summaries. |
| `packages/weave/test/p5.test.ts` | 5 | Intake summary shape and frozen choice vocabulary; no project Thread behavior. |
| `packages/weave/test/p6.test.ts` | 1 | Empty intake `running_threads` fixture. |
| `packages/gateway/test/amos.test.ts` | 8 | Intake choices, prompt and generic choice fixtures; no project Thread behavior. |
| `docs/m7-decision-loop.md` | 5 | Intake question/options/summaries: legacy task vocabulary; storage `run/thread/...` description: causal Weft storage. |
| `docs/execution-provider-contract.md` | 3 | Boundary table lists Threads and workstreams separately: old Thread is causal. Independent Threads and X-T10 programs are execution-work units, not a wired project record; fold their descriptions into one Thread kind while preserving the action/process distinction. |
| `checks/fixtures/execution-provider/contract.mjs` | 7 | `thread:a/b/c` labels for separate offered sets/worker progress; execution correlation ids, no `Thread` type or `workstream@1` shape. Keep values unless the fixture contract changes. |
| `docs/research/monty-sandbox.md` | 18 | Explicit vocabulary note binds Thread work to #28's operating process: already the planned project-level sense. Two matches concern OS `threading`/threads and remain OS terms. Preserve historical evidence and qualify lifecycle statements when updating the note. |
| `docs/design-system.md` | 6 | Initial Threads/input-routing/pause scope exclusion: planned project-level work. Five other uses name the conversational component, not a durable Thread record. |
| `packages/tapestry/src/vocabulary.ts` | 2 | `conversation.thread@1`: conversational presentation component, not the domain identity. |
| `packages/tapestry/src/session.ts` | 1 | Same versioned component node. |
| `packages/tapestry/src/tree.ts` | 2 | Same component placement/reading. |
| `packages/tapestry/test/tree.test.ts` | 10 | Same component identity/placement; no project Thread model. |
| `packages/tapestry-web/src/host.tsx` | 3 | Component renderer dispatch and `ConversationThread`; presentation only. |
| `packages/tapestry-web/src/paint/conversation.tsx` | 2 | Renderer name/test id; presentation only. |
| `docs/respan-routing-learnings.md` | 6 | External Respan conversation/cache affinity and a proposed thread+digest cache key; external correlation, not a durable Loom Thread id. Do not rewrite external `thread_identifier`. |
| `packages/agentfabric/test/shell-run.test.ts` | 1 | OS/main JS thread blocking comment. |

Relative to reviewed `48e9192` (480/383/12 workstream and 351/299/47 thread),
the merged #320 adds 9 workstream occurrences on 7 lines in its design note,
and 184 thread occurrences on 132 lines across that note (160/128) and glossary
additions (24/4). These are included in the current inventory above. Align its
§3, dependent normative names and glossary additions in PR 1; retain its
proposed/unimplemented status. Remaining explanatory prose goes in PR 4.

No `thread` matches occur in `AGENTS.md`. Beyond the required roots, inspect
these semantic references in the implementation slices:

- `ARCHITECTURE.md` has 6 matches: five causal/related-work references (host
  exclusion, derived entities, concurrency, crystallization, optimisation),
  plus an unresolved presentation/thread-process-model scope statement. Clarify
  that last statement against the now-defined project Thread lifecycle.
- `VISION.md` has 1 causal-concurrency reference. Its acceptance boundary is
  unchanged, so leave the file unchanged; document the legacy wording in the
  glossary crosswalk. An actual boundary change would need its own decision.
- `CONTRACT.md` has 1 old-sense Thread comparison in the workstream index.
- `examples/preselect.ts` has 1 intake task-classification description;
  `benchmarks/decision-sites/weft.ts` and `weft.test.ts` each have 1 null causal
  field; `benchmarks/decision-sites/tune.test.ts` has 1 legacy intake label.
- `benchmarks/inference/jev/corpus.ts` has 2 synthetic `thread.wait` operation
  references: waiting for outstanding causal work, not the project Thread
  record. Preserve these evaluation case identities as historical vocabulary.
- Frozen intake cases under `benchmarks/decision-sites/sets/intake.classify/`
  (`tune.jsonl`, `holdout.jsonl`, `PROVENANCE.md`), preselect cases under
  `sets/loop.preselect/` (`tune.jsonl`, `holdout.jsonl`), and recorded
  `benchmarks/decision-sites/results/live-20261015/journal.jsonl` are historical
  evaluation inputs/evidence, not a source of new project semantics. Preserve
  their bytes/digests and labels. Other inference benchmark references to
  CPU/server threads, external conversations, and historical results are not
  domain rename targets. No benchmark run or hosted inference is required here.

## 3. Locked contract: one nestable Thread kind (D-ENG-017)

Captain lock, Benjamin, 1 November 2026: “everything is Threads. Threads are a
nested resource that may or may not have a parent, and may or may not have
children.” Owner Q1 and Q2 are answered; do not reopen the identity allocation
or select a replacement name for goal-local work.

Locked answers, verbatim:

1. **One Thread kind** keeps `thread@1`, `thread_id`, and `thread.*`. There is no second product identity.
2. **Nestable**: optional parent, optional children. Project-level and goal-local are the same kind at different depths in one tree — not two concepts needing two schema families.
3. **Drop** the separate `workstream@1` schema / workstream vocabulary; do not invent `project.thread@1` or a "Causal chain" / "Work unit" twin.
4. **Weft `thread_id`** points at the node in that Thread tree the span belongs to (the durable record), not a parallel workstream id.
5. **Compatibility**: rename in place now (private 0.0.0, no external recorder, no recorded workstream records). No @2 dual-read path unless evidence of an external recorder appears.

PR 1 must establish one coherent `thread@1` contract before implementation:
optional parent, optional derived children, one identity at any depth.
Project-level conversation and goals over time, and #320's goal-local purpose,
completion, results and dependencies, describe nodes in that same tree. Reconcile
the flat project index and #320's fixed goal-local scope in that contract; never
select different decoders by depth. Record exact field presence and validation
using existing capabilities, without a second schema or automatic worker/process.

**One id rule at every depth.** #320 §5.1's `<parent>/<opening seq>/<index>`
and goal-only uniqueness conflict with Weft `isId` (`validate.ts:46`): `/` is
rejected, nesting grows ids beyond 128, and different goals can collide in the
project index and SQLite `threads(run_id, thread_id)` key. Replace that proposal
in PR 1 with injected opaque ids matching
`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`, accepted by both Loom `boundedId` and
Weft `isId`, retaining both validators' credential-shaped-id refusals. No `/`
or `@`; 1–128 ASCII characters at every depth, independent of ancestry. Identity
allocation is injected and replay uses recorded ids; no ambient entropy or
parent/sequence concatenation. All nodes, across every goal in a project, share
one uniqueness scope: **project-wide uniqueness**, including settled nodes.
Duplicate allocation refuses atomically rather than overwriting or merging.
Run/project association must preserve this scope at the SQLite boundary.

**Canonical nesting.** `parent` is the only stored structural edge; children
are derived by selecting nodes whose `parent` names this node, never stored as
a second source of truth. A root omits `parent`; a leaf has no derived children.
`parent` is immutable after open; reparenting is forbidden. Refuse missing or
cross-project parents, self-parentage and cycles without a partial transition.
Root depth is 0; child depth is parent depth + 1. Require an explicit positive
safe-integer `max_depth` limit and refuse openings beyond it (or absent/invalid
limits). The same finite limit applies across goal boundaries in the tree;
#320 §8's additional per-goal limits remain independently enforced. PR 1 records
this limit input and its boundary cases; no implicit unbounded default.

**Concurrent opens.** Apply sibling opens against the latest project index.
At a durable boundary, use the existing append position/observation sequence as
a compare-and-swap precondition, not the parent's semantic revision alone.
#320 §5.3 keeps that revision unchanged by child opening. A stale append refuses;
retry revalidates the parent's open/non-cancelled state, id uniqueness, limits,
shares and dependency edges against the latest committed prefix. Distinct,
valid sibling opens both survive; no lost child, duplicate share or edge update.
Opening a child group and its dependency additions/rebindings is one atomic
append as in #320 §5.3; no separate stored child-list write. Pure transition
checks exercise the same interleavings; journal integration remains follow-up.

**No orphans.** Adopt #320 §6.3–§6.4: every open non-root node has an open parent
or a recorded cancel request. Refuse parent settlement leaving an open child
without that request. Parent cancellation cascades requests to all open
descendants; requests remain distinct from terminal outcomes. Required open
children block completion; completing with optional children requests their
cancellation. Failure/supersession preserve the same invariant and evidence;
locks and late results remain until outcomes/reconciliation permit release.
PR 2b covers structural validation; any real settle/cancel/journal integration
must demonstrate these cases under #320's follow-up, not claim them shipped.
Parentage remains distinct from result dependencies and Weft record links.
Nesting grants no authority, budget, context, access or execution.

Fold Workstream and Thread into **one Thread glossary entry**, including #320's
expanded durable proposal. Align **Execution slot**, **Execution claim**
(including **producing claim**), **Result reference** (including **current**
references), and **Unmet dependency** (including the **failure-handling attempt**)
with that same Thread identity. Keep those independent entry names and their
fences. Align Operating process, Input routing, Project and language constraints
in the same PR. Do not leave a goal-local twin behind under another name.

Align #320's §3 and §16 summary, plus normative names in §5/§7/§15/§17:
`thread@1`, `thread_id`, `thread_revision`, `threads[]`, parent/child/root
references, `depends_on` producer ids, result-reference and execution-claim
fields, and `thread.opened`, `thread.revised`, `thread.result_accepted`,
`thread.cancel_requested`, `thread.settled`. These remain one family. Resolve
its proposed `THREAD-CONTRACT.md` reference to the same contract PR 2a renames;
there are no competing contract owners. Keep the distinction between durable
lifecycle, derived eligibility and action execution ownership. Preserve existing
process pause/stop, resume digest, one-active-goal and one-live-process rules
where implemented; opening or nesting a Thread never allocates execution.
Full durable lifecycle/execution-claim integration remains #320 follow-up work
with its own behavioral red; this rename does not claim it exists.

## 4. Locked in-place compatibility and Weft crosswalk (D-ENG-017)

Owner Q3 is answered: rename in place now. The workspace is private `0.0.0`;
the captain records **no external recorder and no recorded workstream records**.
The current contract also says its transitions are not persisted or wired into
the runtime loop. This decision replaces plan3's unconfirmed assumption; do
not ask the owner to confirm it again. Repository inspection cannot independently
prove external absence, so new recorder evidence is the only reason to revisit
that compatibility premise.

| Existing unpersisted surface | Locked target |
| --- | --- |
| `workstream@1`, `workstream_id` | `thread@1`, `thread_id`, the one nestable Thread kind |
| `workstreams` index, `workstream` result/request, `new_workstream_id` | `threads`, `thread`, `new_thread_id`, referring to nodes in that same tree |
| `operating.process@1` ownership | Keep the schema version; rename its ownership key to `thread_id` |
| `input.route@1`, `input.route.correction@1` ownership | Keep both schema versions; rename their ownership keys to `thread_id` |
| Proposed #320 `thread.*` observations and durable fields | Retain the existing Thread family; reconcile the common contract before implementation |

This is an atomic pre-persistence contract replacement, including nested process
records, routes, corrections, callers and fixtures. Remove active workstream
schema/vocabulary, not arbitrary opaque identifier values such as `ws-a`.
Never decode `thread@1` as two concepts. Add no speculative @2 versions,
dual-read path, alias state model, journal or migrator. The TypeScript export
break policy remains Q5, separate from this settled wire decision.

**Transitional bytes: none expected** for the renamed records. If recorder or
recorded-byte evidence appears, preserve it, stop and open a separate issue for
the actual storage/reader/writer boundary and compatibility decision. This plan
authorizes no reader or cutover machinery. Replay and grant invariants in
section 6 apply unconditionally; RT-00 remains a separate recovery prerequisite.

Owner Q4 is answered: Weft `thread_id` identifies the durable Thread node owning
the span, at whichever depth it belongs. A parallel workstream id or a second
product identity is forbidden. `WEFT-CONTRACT.md:33` currently defines a causal
sequence, and the reference emitter currently uses `thread_id = action_id`.
Those are implementation evidence to crosswalk, not the target contract.

PR 1's normative crosswalk must state: “`thread_id` identifies the node in the
Thread tree that the span belongs to (the durable record). The current reference
emitter uses action-id correlation until durable node binding is implemented.”
It must mark that binding as pending implementation, not as another owner choice.
Actions are attempts associated with a node; `action_id` does not become a second
Thread identity. PR 3 must prove that new emission uses the owning node when
that binding exists, including multiple actions on one node and a child node
whose id differs from both its parent's and its actions'. If runtime binding
requires #320 follow-up integration, state that dependency and retain pending
status rather than assert the old mapping satisfies D-ENG-017.

Preserve historical Weft records, `weft.record@1`, `thread.transition`, subject
`thread`, `weft.thread_id`, SQLite `threads`, `:thread:` record ids and link
targets as historical evidence. Existing action-correlated bytes are not
`workstream@1` records and do not establish a second Thread kind. Do not rewrite
historical correlation or invent versioned readers merely for golden fixtures.
Preservation is not a decision about new `thread.transition` emissions: today
opened/joined/superseded/cancelled/closed describe an action chain with ids built
from `action_id` (`packages/weave/src/weft.ts:201–310`). Two actions would emit
two opened/closed pairs under one node id, alongside #320's node lifecycle.
Q8 must resolve the new emission semantics before the dependent PR 3 work;
PR 1 records the answer without reopening the locked identity family. Gateway
and Fabric retain locally declared ports and null ids when no node binding exists.
Weft remains a projection: no trace reader feeds Loom, no imports reverse, and
nothing emitted grants authority or changes scheduling.

## 5. Smallest ordered PR slices and red-before-green evidence

Review sequence: **PR 1 → PR 2a → PR 2b → PR 3 → PR 4**. Dependencies are
**1 → 2a → 2b → 3** and **1 → 4**, plus **2a/2b/3 → 4** only where prose cites
final exports, nesting or emission. Independent inventory review, test-case
design and documentation work can proceed concurrently after PR 1. PR 3 may
also need explicitly identified #320 runtime integration; record that dependency
rather than add a parallel id. Every slice uses a branch from current
origin/main with its prerequisite PRs merged or explicitly carried. Q1–Q4 are
settled; only work depending on Q5–Q8 waits for those answers. Finish every
implementing slice green before merge; never merge a partially renamed
producer/consumer pair. This planning revision implements none of these slices.

Shared gate **G**, required unchanged for every slice:

```sh
node checks/import-direction.mjs
node checks/no-ambient-clock.mjs
node checks/no-ambient-entropy.mjs
node checks/no-ambient-env.mjs
node checks/no-swallowed-failures.mjs
npm run test:checks
npm run check
```

Use the narrow checks first, then the full available `npm run verify` suite,
plus CI's `npm run lint` and `npm run fmt:check` before merge. Use the declared
Node >=22.18 toolchain and installed locked dependencies. A missing dependency,
unsupported Node or unavailable runner is a blocker to report, never a reason
to skip silently, soften an assertion, or alter a check allowance.

Import boundaries pinned by G: gateway and Weft import no in-repository package;
Fabric imports only AgentSOP/gateway and never Loom or its scheduler; Loom source
imports only AgentSOP/Fabric/gateway and **does not import Weft** (Loom tests may
validate with Weft); Gauge imports Weft only; Tapestry imports no runtime or
renderer; web imports Tapestry only; loom-binding imports Loom/Tapestry only.
Consumers use public package entry points and packages never import consumers.
Compose existing transition functions and injected ports; do not create another
runtime or universal protocol for the rename.

### PR 1 — One Thread glossary and nestable naming/compatibility contract

**First step and recorded precondition:** recount both inventories on current
`origin/main` (at least `e35767b`) and record the exact base SHA and counts.
Before PR 1 edits, record `npm ci && npm run verify` green on that origin/main
base using Node >=22.18. A failed or unavailable install/runner blocks this
precondition; earlier planning attempts do not establish base green.

Apply D-ENG-017 in one Thread glossary entry and the existing contract, updating
all related definitions and #320 additions/language constraints in section 3
together. Align #320 §3, its glossary summary, normative identifiers and common
contract path while retaining its proposed/unimplemented status. Specify one
`thread@1` shape, common id grammar/length/project-wide scope, canonical
immutable parent, derived children, depth limit, sibling-open CAS and orphan
invariant from section 3, not competing project/goal decoders.
Record section 4's in-place ownership/schema mapping, leaving current source
names explicit until PR 2a. Include Weft's normative node crosswalk immediately;
remaining emission/link alignment belongs to PR 3 and prose to PR 4. Record
Q8's owner answer before dependent lifecycle work and Q6's answer before changing
live intake id semantics; neither question reopens D-ENG-017.

**Red before edits:** a narrow terminology/contract check must fail against the
current Workstream/Thread split, #320's fixed goal-local wording and Weft's
unqualified causal-sequence definition. Assert one Thread kind with optional
parent and derived children at different depths, one schema/key/transition
family, shared bounded ids unique across goals, immutable canonical parent,
finite depth, sibling-open CAS, no-orphan/cancel rules, aligned #320 dependent
entries and honest current-versus-target Weft mapping. The check rejects #320's
slash-derived, goal-only ids and any stored child-list authority.
Check that opening/nesting confers no authority or execution. This documentation
red grants no permission to generate implementation code before behavioral red.

**Green:** the single-kind terminology, shape and link checks pass together;
current behavior tests still pass unchanged. Run G and full verification. No
`VISION.md` edit: its acceptance boundary stays the same.

### PR 2a — Pure atomic Loom rename into the existing Thread family

Under PR 1's contract, rename module/test/contract to `thread.ts`,
`thread.test.ts`, `THREAD-CONTRACT.md`; change public exports (subject to Q5),
imports, index/result/request properties, refusal names and callers together.
Replace `workstream@1` with `thread@1` and affected ownership keys with
`thread_id`, keeping process/route/correction @1 under the locked in-place
policy. Update root `CONTRACT.md` and site links. This slice changes names only;
optional `parent`, new nesting validation and id-allocation behavior belong in
PR 2b. Preserve replay functions and evidence; update unpersisted expectations
without invented readers. Intake labels/sets and live id meaning await Q6;
inference routing, capability admission, authority and component ids stay intact.

**Red before implementation:** a public-entry-point consumer using
`Thread`/`openThread` and the renamed shape must fail compilation or a shape
assertion against the old API. Pin the four affected schema surfaces and
ownership keys with renamed expectations; do not regenerate snapshots wholesale.
A whole-repository legacy-name scan must fail on a stale active API import and
on a stale root `CONTRACT.md` schema/link. Its explicit allowlist covers only
reviewed historical evidence/quotes, this plan and any Q5-authorized temporary
export alias, never an entire source/doc tree. Inspect tracked/hidden files
where relevant; exclude dependency/build/git internals, not root contracts.
Validate an evidence-loss or resume-digest mutation is still rejected.

**Green:** all **33 ported tests** (8 record, 10 process, 15 routing) retain their
behavioral assertions, changed only for the renamed API/wire names. Run
`npm run build`, then
`node --test packages/weave/dist/test/thread.test.js packages/weave/dist/test/operating-process.test.js packages/weave/dist/test/input-route.test.js`,
the public consumer compile check, whole-repository allowlisted legacy-name
scan, G and full verification. Keep `p5.test.ts`/`p6.test.ts` intake shapes and
options pending Q6. A rename regression is reviewed independently of nesting.

### PR 2b — Optional parent and deterministic nesting validation

Depends on green PR 2a. Add the section 3 contract's optional immutable `parent`
and derive children from it, with the same schema and id rule at every depth.
Use injected opaque ids, project-wide duplicate refusal, depth limits and
atomic validation against the latest index. No stored child list, reparenting,
second record kind or automatic process allocation. Cover the CAS/retry rule
with pure transition interleavings; durable append/settle/cancel wiring remains
explicit #320 integration with its own behavioral red.

**Red before implementation:** nested openings against PR 2a must fail to retain
and validate `parent`. Reject missing/cross-project parents, self-parentage,
cycles, reparenting, duplicate ids and depth-limit overflow without changing the
original index. Named checks: **Depth-N child id passes Weft validation** (at the
configured depth bound, with distinct parent/action ids, unchanged id length,
validated by Weft in tests only) and **Two goals' children with the same derived id are refused**
(a faulty injected allocator reuses an otherwise valid opaque id across goals;
refuse `duplicate_thread`, never overwrite). Also reject literal #320 slash ids
and ids longer than 128, so grammar failure cannot hide the uniqueness test.
Exercise concurrent sibling opens and retry after stale append/parent cancel;
assert parent semantic revision unchanged, both valid siblings retained, no
partial edges/shares, and derived children agree after reconstruction. Validate
an invalid mapper that truncates or concatenates parent ids is rejected.

**Green:** the nesting reds pass under section 3; all 33 ported tests and PR 2a's
consumer/whole-repository scan stay green, with explicit optional-field assertions
where needed. Run narrow Thread/route/process tests, Weft id validation from the
Loom test boundary, G and full verification. Do not import Weft into Loom source.
For an actual journal boundary, #320's atomic-child-append and no-orphan cases
in section 6 are required integration evidence before claiming durability.

### PR 3 — Weft owning-node mapping and causal links

Depends on PR 2b, Q8's owner answer and any recorded #320 binding prerequisite.
Expand PR 1's crosswalk through Weft mapping/link documentation and Loom
emission comments, and implement the owning-node mapping only after its runtime
binding has behavioral red. The destination is locked: each span's `thread_id`
is its durable node in the same Thread tree. Record any #320 integration
prerequisite explicitly. Do not call retained action-id correlation completion
of this slice. Preserve historical JSON, OTel attributes, SQLite tables,
record-id segments and link targets as historical evidence. Implement new
emission semantics only under Q8's selected contract; preserving old fixtures
must not silently select how new action-chain transitions are represented.
Gateway and Fabric retain local ports/null ids where no binding exists; Loom imports
no Weft and never reads traces for scheduling.

**Red before edits:** identify the actual stale emission/link statements beyond
PR 1's already-fixed normative crosswalk. Before code mapping, demonstrate red
with distinct root, child and action ids, plus two actions belonging to one
node. Reject a mapping to a parent or parallel project id instead of the node
owning the span. Repeat **Depth-N child id passes Weft validation** at the
configured depth bound through new emission, OTel and SQLite intake; repeat
**Two goals' children with the same derived id are refused** at the binding/index
boundary before emission/storage, with no overwrite of the first node's rows.
Named PR 3 red under either Q8 option: **Node opened/settled exactly once regardless of action count**.
A zero-, one- and two-action node has one `thread.opened` and one terminal
`thread.settled`; attempts never duplicate that node lifecycle. Under Q8(a),
Weft's node lifecycle projection is likewise emitted once and action-chain events
use the action subject. Under Q8(b), explicitly distinguish any per-action
transition evidence and prove it neither opens nor settles the node again, per
the owner's recorded rationale. A byte-preservation check must reject mutation
of historical `:thread:` ids or link targets. Documentation alone needs no speculative mapper.

**Green:** mapping, depth/id-collision and single-node-lifecycle assertions pass
under the recorded Q8 answer; original historical golden records remain identical
and valid. Join/handoff/supersession/repeated
cancel/recovery links retain their recorded targets. Run
`npm run test:weft-contract`; after build run
`node --test 'packages/weave/dist/test/w5-*.test.js'` (Node >=22.18), including
replay, isolation and authority tests; run G and full verification. Keep SQLite
and OTel intake tests enabled in their supported Node environment. If the durable
binding is blocked, report that dependency and keep this slice incomplete.

### PR 4 — #330 and remaining prose alignment

#320 is merged on main; its glossary/terminology/normative naming alignment is
PR 1 work, not a wait for merge. Update remaining explanatory prose/examples in
its design note, architecture, execution-provider, design-system and research
docs against the single nestable Thread contract and final exports/mapping.
Preserve design status and lifecycle fences. Include #26/#28/#314 references.
Apply that same contract to #330 once its owner, exact file and scope are named
(Q7); do not invent them or assume implementation. Q7 blocks only that alignment.

**Red before edits:** a scoped doc/link check must identify a concrete stale
contract path, scope description or separate-identity claim in the files being
edited. Allowlist historical quotes, external names and recorded mappings.
Do not manufacture red from terminology already fixed in PR 1.

**Green:** prose/examples agree with the one Thread glossary entry, common
contract and exported types/versions, with no unreviewed lifecycle change.
Run G and full available verification. Runtime integration beyond the bounded
rename/nesting change needs its own behavioral red and scope review.

## 6. Failure, cancellation and concurrency acceptance cases

These are implementation-evidence requirements, not claims that a durable
Thread journal already exists. PR 2a proves the in-place rename; PR 2b proves
nesting transitions. Full durable integration must exercise the actual journal
when it exists, with its own behavioral red. Transitional bytes are not expected;
the recorder-evidence rule below adds no compatibility machinery. Never decode
`thread@1` as two concepts or allocate identities by depth.

Known gap/dependency: [#320 §9.1, RT-00](docs/durable-recursive-threads.md#91-gap-found-a-queued-action-keeps-the-grant-it-was-queued-with)
records that a queued action retains its queue-time grant, which the new host
after restart refuses. The proposed grant-at-start fix is separate work, not a
property established by this rename or by #320's merge. Reads of queued or held
records never carry or mint a grant. Keep budget/effect holds as accounting; recovery must check current authority and issue a fresh grant only
at actual start. Any continuation/recovery guarantee relying on that fix is
blocked on RT-00's own demonstrated red/green evidence.

| Case | Required deterministic evidence |
| --- | --- |
| Partial rename across packages | Build and public consumer compile checks reject stale imports or mismatched ownership keys; link/name check rejects stale contract paths. Writers implement the locked in-place replacement into one `thread@1` family; no recorded schema is silently repurposed. Preserve G import directions and local port declarations. |
| One nestable kind at every depth | Same `thread@1` schema, common 1–128-character grammar and project-wide uniqueness; depth-N ids pass both validators. Across two goals, a duplicate injected/derived id refuses without mutation. Parent is the only stored edge, immutable after open; children are derived. Refuse missing/cross-project parents, cycles, reparenting and depth overflow. Parentage is distinct from dependencies/Weft links; nesting grants nothing. |
| Concurrent sibling open | Two distinct children opened from the same prefix: first append wins CAS; second retries against latest index and survives if still valid. Parent semantic revision is unchanged; duplicate ids, overcommitted shares and stale parent state refuse atomically. No lost children or dependency edges. |
| Parent cancelled or settled with open children | Apply #320 §6.3–§6.4: cascade cancel requests to every open descendant, retain identity/locks/late evidence, refuse settlement leaving an open child without a cancel request. Required open children block completion; optional outstanding children receive cancellation on parent completion. Race child open against parent cancel/settle in both orders; neither order permits an orphan. |
| Crash between parent and child appends | At real journal integration, crash after parent open/before child-group append and after child-group append/before acknowledgement. Replay yields the parent alone or the complete child group plus dependency changes, never a partial fork or child-list divergence. Parent link is immutable, children are derived, retry uses recorded ids exactly once, and replay has zero effects/grants. |
| Recorder evidence appears | Preserve evidence, stop and open a separate issue for compatibility and cutover scope. Add no reader, migrator or dual-read path in this plan. |
| Replay and grants (unconditional) | Replay invokes nothing, emits nothing and issues zero grants. Queued/held reads carry or mint no grant. Single-use grants remain consumed after a crash and are never re-presented. Recovery checks current authority; only actual start may receive a fresh grant, subject to RT-00. Reservations are accounting, never transferable grants. |
| Parallel routing fails or is cancelled | Aborted/unavailable/stale site answers place no input and open no Thread. If a parallel target id is invalid/duplicate or any subsequent step refuses, retain the exact original index: no orphan target, partial input placement or process transition. A model answer alone never grants or dispatches work. |
| Interrupt correction races a pause/stop/completion | An interrupt requests pause at the next boundary, never a stop. Correcting one of two interrupts retains the other's pending pause; an honoured pause stays paused; terminal processes stay terminal; stale corrections refuse. Preserve request evidence and resume digest through the rename. |
| Concurrent independent Threads | Interleave two Threads' transitions and separate active goals; transitioning one preserves the other's record, inputs, process and authority. Only one active goal and live process per Thread; one goal attaches once within a project. Independent transitions remain concurrent; append CAS does not reserve execution slots. |
| Concurrent artifact updates | Preserve monotonic artifact revisions within a Thread; cross-Thread writes still require canonical effect locks. Ownership/key renames do not expand a grant or bypass stale read-set/resource checks. |
| Old exported-name consumers | Exercise a fixture importing the public old names and one using the new names. Preferred atomic change updates all checked-in callers and documents the source-breaking API change. If the owner requires a temporary deprecated alias, it must be one identity/implementation with a removal boundary and compile/behavior tests; no duplicate state model or unsupported deep-import shim. Wire compatibility and the source export policy remain separate decisions (Q5). |
| Weft links across crash/concurrent arrival | Old segments and new segments resolve the same ids, including forward targets, dependency joins, repeated cancels and supersession before/after recovery. New spans point at their owning durable node, at any depth; a child span must not inherit its parent's id, and two actions on one node share that node id. Preserve historical action correlation as recorded evidence; apply Q8's recorded contract to new emissions and prove the node opens/settles once regardless of action count. Slow/throwing/reentrant sinks do not change scheduling, budgets or outcomes. |
| Authority and disclosure | Opening, decoding, correcting or resuming creates no grant/approval/budget. Keep unconditional replay/single-use-grant invariants above; uncertain effects are reconciled only under current authority. Reject credential-shaped ids, keep raw input/provider errors out of records and keys out of argv/logs. |
| Benchmark contamination | Keep intake choices/frozen corpus bytes and digests unchanged. Rename checks must not rewrite historical evidence, inject guardrails or shuffles into benchmark routes, or expose held-out cases. A future comparison requires reserved independent adversarial/held-out cases and recorded data provenance/license/destination plus sanitization or explicit authorization before hosted disclosure. |

Runtime and gateway remain provider-independent and pure: no environment,
filesystem, shell or ambient-clock access is introduced. Time and identity
allocation remain injected; persistence and any conversion stay at existing
composition/storage boundaries. Capability generation, admission and authority
to execute remain separate gates. A repeated review finding becomes a narrow
lint or behavioral regression test with known-red and green evidence; do not
relax permissions, validation or protected checks to pass it.

## 7. Answered owner questions and remaining open questions

### Q1 — Answered: Thread identity family

D-ENG-017: one Thread kind keeps `thread@1`, `thread_id` and `thread.*`.
Project-level and goal-local nodes are depths in one tree, not competing owners.
No `project.thread@1` family or dual allocation remains.

### Q2 — Answered: goal-local name and nesting

D-ENG-017: Thread. Optional parent, optional children; no second Work unit,
Causal chain or other product twin. Fold #320 and the renamed workstream into
one glossary entry and contract, as specified in section 3.

### Q3 — Answered: compatibility

D-ENG-017: rename in place now, private `0.0.0`, no external recorder and no
recorded workstream records. No @2 dual-read path unless external-recorder
evidence appears. If recorder or recorded-byte evidence appears, preserve it,
stop and open a separate issue; none is expected. No repeat confirmation is
required for the locked rename.

### Q4 — Answered: Weft `thread_id`

D-ENG-017: the durable node in the Thread tree that the span belongs to, not a
parallel workstream id. PR 1 records the current action-id/target-node crosswalk;
PR 3 proves node binding, subject to its explicit runtime prerequisites.

### Q5 — Open: public TypeScript export break policy

May old public TypeScript exports break atomically, or are temporary deprecated
aliases needed for named downstream consumers? Recommend atomic rename in this
private `0.0.0` workspace; aliases require a real consumer and removal boundary.
D-ENG-017 settled wire compatibility, not this source export policy.

### Q6 — Open: `intake.classify` labels and `running_threads[].thread_id`

Should the existing labels, shapes and frozen sets be preserved, or should a
separately scoped/versioned mapping and evaluation follow? Recommend preserving
labels/sets for this rename. D-ENG-017 does not authorize changing classification
semantics or rewriting benchmark evidence.

For live `IntakeState.running_threads[].thread_id`
(`packages/weave/src/sites/index.ts`), which contract should apply?

- **(a) Point at Thread nodes** in the one durable tree; define the binding and
  its red before changing live disclosures. **Recommendation: (a)**, consistent
  with D-ENG-017's single meaning of `thread_id`.
- **(b) Rename the legacy action/task correlation field in a separately scoped
  change**, with its own contract/red, rather than retain another live meaning
  of `thread_id` indefinitely.

Owner choice remains open; this plan does not silently select either option.
**Frozen benchmark bytes and digests stay unchanged either way**; any live
mapping is separate from those historical inputs. Dependent live intake work
waits for the answer.

### Q7 — Open: #330 document owner and scope

Who owns #330's alignment, and what exact file/scope and reviewer follow?
Recommend naming the owner and document now; defer only that prose if still
unidentified. No owner is invented here. #320's one-Thread glossary and normative
alignment still belong in PR 1.

### Q8 — Open: new Weft `thread.transition` lifecycle semantics

Today `thread.transition` opened/joined/superseded/cancelled/closed describes
one action's chain, with record ids built from `action_id`
(`packages/weave/src/weft.ts:201–310`). With two actions on one Thread node,
merely rebinding `thread_id` would emit two opened/closed pairs alongside
#320's node `thread.opened`/`thread.settled`. Which new-emission contract should
PR 1 establish for PR 3?

- **(a) Make Weft `thread.transition` a node lifecycle projection**, and move
  per-action chain events to the action subject. **Recommendation: (a)**, which
  gives the one Thread kind one lifecycle and keeps action attempts explicit.
- **(b) Keep per-action transitions under the node id**, with an explicit owner
  rationale and contract explaining why they are action evidence rather than a
  second Thread kind/lifecycle, and how consumers distinguish node events.

This is an open owner decision about new emissions; historical bytes remain
unchanged. PR 3's red under either choice is **Node opened/settled exactly once regardless of action count**
(section 5), covering zero, one and multiple actions. Q8 blocks dependent
lifecycle emission work until answered, not the pure rename.

## Planning-run validation

Only `PLAN.md` may change; no source, glossary or test edits, dependency install,
network or push. D-ENG-017 is supplied decision evidence and remains locked.
Review findings come from `/workspace/wvops/WV-329-review-48e9192.json`.

- Plan5 documentation red was observed before editing: a temporary check outside
  the repository failed all 18 requested plan requirements, including current
  baseline, common id rule, nesting/CAS, PR 2a/2b, PR 3 lifecycle red and Q6/Q8.
  Its green result validates plan text only; implementation slices still require
  independently validated behavioral red/green evidence.
- Recounted at planning HEAD `f7b3488`: workstream **489 occurrences on 390 lines
  in 13 files**, thread **535 occurrences on 431 lines in 48 files**. Compared
  with reviewed `48e9192`, the increase is exactly #320's design note/glossary.
  Exact `workstream_id` remains 71 (76 as a substring); `workstream@1` is 5 in
  the scan roots, 6 repo-wide including root `CONTRACT.md:12` (excluding this
  plan). Existing workstream/process/route tests remain 8/10/15, 33 total;
  the 14-name public barrel block starts at `index.ts:247`.
- Plan5 validation passed the 18-requirement temporary plan check, inventory
  reconciliation and `git diff --check`; the diff is confined to `PLAN.md`.
  Q1–Q4 remain answered;
  Q5/Q7 are retained, Q6 extended and Q8 opened without choosing for the owner.
- Prior plan4 Node 22 validation used `/home/box/.local/node22/bin`, v22.23.4.
  Direct import-direction/ambient-clock/entropy/environment/swallowed-failure
  checks passed then; these are historical planning observations, not base green.
  `npm run verify` stopped in `npm run check` (verify-cache tests failed,
  missing `node_modules/.bin`, direct `vp` spawn `ENOENT`). `test:checks` also
  failed `checks.test.mjs`; a child-process probe reported `EPERM`. No permissions
  or protected checks were weakened. This documentation revision does not claim
  the runtime suite is green or install dependencies in the offline worktree.
- Plan5 reran all five direct import-direction/ambient-clock/entropy/environment/
  swallowed-failure checks with Node v22.23.4: all passed (325/104/51/133/12).
  `npm run verify` was also attempted: benchmark-digests passed, but
  `scripts/verify-cached.test.mjs` failed in `npm run check`; later stages did not
  run. `node_modules/.bin` is still absent. No dependencies were installed and
  the full suite remains not green. This is a reported environment blocker,
  not implementation evidence or permission to weaken a gate.
- **PR 1 precondition:** record `npm ci && npm run verify` green on its exact
  current origin/main base before edits, as specified above. Missing dependencies,
  runner failures or unavailable installation are concrete blockers to report,
  never a reason to inherit planning failures as an acceptable baseline.
