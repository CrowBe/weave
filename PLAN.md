# WV-329: workstream → one nestable Thread kind (D-ENG-017)

Planning only. D-ENG-017 (Benjamin, 1 November 2026) locks one nestable
**Thread** kind at every depth, retaining `thread@1`, `thread_id` and `thread.*`.
This plan prepares the atomic workstream → Thread rename into that family;
it changes no source, glossary, tests, schemas or recorded data. Owner questions
1–4 are answered; only Q5–Q7 remain open in section 7.

## 1. Evidence, scope, and data shape inventory

Actual checkout HEAD: `02543c2d5a6f11d496e41af3b795ca8be0629eee`, branch
`wv-329-thread-rename-plan`, inspected on 1 November 2026. Read `VISION.md`,
`GLOSSARY.md`, `AGENTS.md`, current contracts, transition implementations and
their tests, Weft emission/recovery tests and import-direction checks before
revising the sequence below. PLAN.md already contained the uncommitted plan3;
this revision preserves its relevant evidence and acceptance constraints.

Baseline discrepancy: the supplied main history includes #320 as `8ce60c5`
(PR #362) and later merges, but this worktree's actual HEAD is still the
original plan commit `02543c2`. `docs/durable-recursive-threads.md` and #320's
glossary additions are absent from this checkout. The design note and glossary
at `8ce60c5` were inspected with `git show`; they are locally available merged
design evidence, not implemented runtime behavior. No rebase or branch change
is part of this PLAN.md-only task. The earlier plan's `0efd2bc` rebase claim
is not this checkout's observed commit state. Recount below uses actual HEAD;
recount again when the implementation worktree adopts current main.

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
inputs match actual HEAD `02543c2` exactly; `PLAN.md` is outside these roots.
Recount if the implementation baseline changes. The groups in this table partition all
**480 occurrences on 383 lines in 12 files**: lowercase `workstream` 286,
`Workstream` 181, uppercase `WORKSTREAM` 13.

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
| Tests and inline fixtures | `packages/weave/test/workstream.test.ts` | 98 | 82 |
| Tests and inline fixtures | `packages/weave/test/input-route.test.ts` | 47 | 37 |
| Tests and inline fixtures | `packages/weave/test/operating-process.test.ts` | 34 | 29 |
| No matches | `checks/`, `AGENTS.md` | 0 | 0 |

Group totals: record/API 153; input routing 54; operating-process source 9;
documentation/glossary 85; tests/inline fixtures 179. There are no separate
workstream fixture files or matches in other packages in this scan.

### Schema IDs and serialized keys (subsets of the table)

`workstream@1` occurs **5 times in 3 files**:
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

`packages/weave/src/index.ts:246` re-exports all 9 types, the constant,
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
baseline (excluding this new plan).

## 2. Existing Thread terminology and correlation inventory

The broad case-insensitive `thread` scan above finds
**351 occurrences on 299 lines in 47 files**. It includes plurals,
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
| `GLOSSARY.md` | 12 | Current Thread/Workstream distinction is superseded by D-ENG-017; fold into one nestable Thread entry in PR 1. #320 additions are absent at HEAD and must join that same entry when main is adopted. Intake classification retains its existing contract pending Q6. |
| `packages/weave/src/WORKSTREAM-CONTRACT.md` | 8 | #26's quoted thread is already project-level; remaining comparisons explicitly distinguish the causal-chain Thread and Weft id from the workstream. Replace the distinction with D-ENG-017's single nestable kind. |
| `packages/weave/src/sites/index.ts` | 6 | `IntakeState.running_threads[].thread_id`, fixed intake question and `new_thread`/`continue_thread`: legacy task/causal-work vocabulary; no project index integration, so no durable Thread-tree integration yet. |
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

#320 at `8ce60c5` separately adds 9 workstream occurrences on 7 lines in its
design note, and 184 thread occurrences on 132 lines across that note (160/128)
and glossary additions (24/4). These are excluded from the HEAD inventory.
That explains plan3's 489/390/13 and 535/431/48 totals. Align its §3, dependent
normative names and glossary additions in PR 1 when working from main; retain
its proposed/unimplemented status. Remaining explanatory prose goes in PR 4.

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
optional parent, optional children, one identity at any depth. Project-level
conversation and goals over time, and #320's goal-local purpose, completion,
results and dependencies, describe nodes in that same tree. Reconcile the
current flat project index and #320's fixed goal-local scope/uniqueness rules
with that contract; do not encode them as two decoders selected by depth.
Record exact field presence, id scope, parent validation and child references
in the contract using existing capabilities, without inventing a second schema
or an automatic worker/process per child. Distinguish structural parentage from
result dependencies and Weft links. Validate missing parents, cycles and
cross-project references deterministically; a leaf needs no children and a root
needs no parent. Nesting itself grants no authority, budget, context or access.

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
its proposed `THREAD-CONTRACT.md` reference to the same contract PR 2 renames;
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

**Transitional bytes: none expected** for the renamed records. If any exist,
preserve their original bytes and evidence and exercise mixed-version replay
before accepting a cutover. Evidence of an external recorder must identify the
actual storage/reader/writer boundary, consumers and cutover owner before
reconsidering versioned compatibility. Do not silently reinterpret historical
schemas, drop evidence or rewrite the only journal. Any required read mapping
must dispatch exact recorded versions/shapes, fail closed on conflicting keys,
duplicate logical ids or wrong nested versions, and preserve ids, ordering,
revisions, artifact references, held inputs, process state, request evidence,
resume digests and historical replay outputs. Readers precede changed writers
at that boundary. Replay invokes nothing, emits nothing and issues no grants;
queued/held reads carry or mint no grant. RT-00 remains a separate prerequisite
for authorized recovery at actual start (section 6).

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
historical correlation or invent versioned readers merely for golden fixtures;
actual recorder evidence must establish any compatibility boundary. Gateway and
Fabric retain locally declared ports and null ids when no node binding exists.
Weft remains a projection: no trace reader feeds Loom, no imports reverse, and
nothing emitted grants authority or changes scheduling.

## 5. Smallest ordered PR slices and red-before-green evidence

Keep slice order **PR 1 → PR 2 → PR 3 → PR 4** for review. Contract dependencies
are **1 → 2**, **1 → 3**, **1 → 4**, plus **2 → 3** for emission that needs the
renamed node binding and **2/3 → 4** where prose cites final exports/mapping.
Independent inventory review, test-case design and documentation work can
proceed concurrently after PR 1. PR 3's actual durable binding may also depend
on explicitly identified #320 integration; record that dependency rather than
add a parallel id. Q1–Q4 are settled by D-ENG-017. Only work depending on Q5–Q7
waits for those answers. Each implementing slice must finish green before merge;
never merge a partially renamed producer/consumer pair. This planning revision
implements none of these slices.

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

Apply D-ENG-017 in one Thread glossary entry and the existing contract, updating
all related definitions and #320 additions/language constraints in section 3
together. Align #320 §3, its glossary summary, normative identifiers and common
contract path while retaining its proposed/unimplemented status. Specify one
`thread@1` shape and its nesting rules, not competing project/goal decoders.
Record section 4's in-place ownership/schema mapping, leaving current source
names explicit until PR 2. Include Weft's normative node crosswalk immediately;
remaining emission/link alignment belongs to PR 3 and prose to PR 4.

**Red before edits:** a narrow terminology/contract check must fail against the
current Workstream/Thread split, #320's fixed goal-local wording and Weft's
unqualified causal-sequence definition. Assert one Thread kind with optional
parent and children at different depths, one schema/key/transition family,
aligned #320 dependent entries and honest current-versus-target Weft mapping.
Check that opening/nesting confers no authority or execution. This documentation
red grants no permission to generate implementation code before behavioral red.

**Green:** the single-kind terminology, shape and link checks pass together;
current behavior tests still pass unchanged. Run G and full verification. No
`VISION.md` edit: its acceptance boundary stays the same.

### PR 2 — Atomic Loom rename into the existing Thread family

Under PR 1's common contract, rename module/test/contract to `thread.ts`,
`thread.test.ts`, `THREAD-CONTRACT.md`; change public exports (subject to Q5),
internal imports, index/result/request properties, refusal names and callers
together. Replace `workstream@1` with `thread@1` and all affected ownership keys
with `thread_id`, keeping process/route/correction @1 under the locked
pre-persistence policy. Implement the bounded parent/child representation
specified by PR 1 as part of the same kind; do not add a second record family
or pretend full #320 journal integration is already shipped. Update the root
`CONTRACT.md` and site contract links in the same PR. Preserve replay functions
and evidence; replace unpersisted fixture expectations without invented readers.
Keep intake labels/sets under Q6's recommended preservation policy, inference
routing, capability admission, authority and Tapestry component ids intact.

**Red before implementation:** add a public-entry-point consumer check using
`Thread`/`openThread` and the common emitted shape; it must fail to compile or
fail its shape assertion against the old API. Demonstrate red for the four
affected schema surfaces, renamed ownership keys, a root without a parent,
a leaf without children and nested nodes of the same `thread@1` kind. Reject
missing parents, cycles, conflicting ids and cross-project references atomically.
Validate tests with a known-invalid mapping that drops evidence or changes a
resume digest. Any actual transitional bytes trigger section 6's mixed-version
checks at their real boundary; no speculative @2 path is part of this PR.

**Green:** port all 33 existing workstream/process/route behaviors without
weakening constraints; apply section 6 under the in-place policy. Run
`npm run build`, then
`node --test packages/weave/dist/test/thread.test.js packages/weave/dist/test/operating-process.test.js packages/weave/dist/test/input-route.test.js`,
the public consumer compile check, G and full verification. `p5.test.ts` and
`p6.test.ts` retain existing intake shapes/options pending Q6. Use a narrowly
allowlisted legacy-name scan, validated by a failing stale active API import,
so partial renames become a deterministic check.

### PR 3 — Weft owning-node mapping and causal links

Expand PR 1's crosswalk through Weft mapping/link documentation and Loom
emission comments, and implement the owning-node mapping only after its runtime
binding has behavioral red. The destination is locked: each span's `thread_id`
is its durable node in the same Thread tree. Record any #320 integration
prerequisite explicitly. Do not call retained action-id correlation completion
of this slice. Preserve historical JSON, OTel attributes, SQLite tables,
record-id segments and link targets; change no historical evidence. Gateway
and Fabric retain local ports/null ids where no binding exists; Loom imports
no Weft and never reads traces for scheduling.

**Red before edits:** identify the actual stale emission/link statements beyond
PR 1's already-fixed normative crosswalk. Before code mapping, demonstrate red
with distinct root, child and action ids, plus two actions belonging to one
node. Reject a mapping to a parent or parallel project id instead of the node
owning the span. A byte-preservation check must reject mutation of historical
`:thread:` ids or link targets. Documentation alone needs no speculative mapper.

**Green:** mapping assertions and owning-node behavior pass; original historical
golden records remain identical and valid. Join/handoff/supersession/repeated
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
Thread journal already exists. The locked path is deterministic transition and
fixture checks for an in-place pre-persistence rename. Transitional bytes: none
expected. Mixed-version replay and crash/cutover requirements below still apply
if any transitional bytes are present; external-recorder evidence must establish
the real compatibility boundary before adding readers. Full durable integration
must exercise the real journal when it exists. Never decode `thread@1` as two
concepts or allocate identities by project versus goal-local depth.

Known gap/dependency: [#320 §9.1, RT-00](docs/durable-recursive-threads.md#91-gap-found-a-queued-action-keeps-the-grant-it-was-queued-with)
(design path available at `8ce60c5`, absent from this HEAD as noted above)
records that a queued action retains its queue-time grant, which the new host
after restart refuses. The proposed grant-at-start fix is separate work, not a
property established by this rename or by #320's merge. Compatibility reads of
queued or held records never carry or mint a grant. Keep budget/effect holds as
accounting; recovery must check current authority and issue a fresh grant only
at actual start. Any continuation/recovery guarantee relying on that fix is
blocked on RT-00's own demonstrated red/green evidence.

| Case | Required deterministic evidence |
| --- | --- |
| Partial rename across packages | Build and public consumer compile checks reject stale imports or mismatched ownership keys; link/name check rejects stale contract paths. Writers implement the locked in-place replacement into one `thread@1` family; no recorded schema is silently repurposed. Preserve G import directions and local port declarations. |
| One nestable kind at every depth | Root with no parent, leaf with no children and nested nodes share the same schema, identity and transition family. Reject missing parents, cycles, conflicting ids and cross-project parentage without partial transitions. Parentage is distinct from result dependencies and Weft record links; nesting grants nothing and allocates no worker. |
| Mixed old/new records in one journal (only if transitional bytes exist) | Version-dispatched read handles interleaved old/new Thread, process, route and correction records in recorded order. Compare canonical semantic state with an equivalent single-version history; compare each historical replay result with its original version's expected bytes. Include a queued action and held input across versions: replay issues zero grants before start, invokes nothing and never presents a historical grant. After authorized recovery, only actual start may issue a fresh grant (RT-00 dependency). Equal logical ids share one identity, not two aliases; conflicting duplicates, dual keys, wrong nested versions and unknown versions fail closed without applying a prefix of a transition. |
| Crash or write cutover (only at an actual durable boundary) | The locked path needs no migration. If recorder evidence requires compatibility, readers are installed before new writers and original records remain intact. Crash before append, after append/before acknowledgement and between old/new records; restart from every durable prefix. State, evidence, queues, processes and budget/effect reservations are neither lost nor duplicated; grants are never transferred as reservations. Replay has zero effects, gateway calls or emission; recovery emits only newly appended observations and never reopens the same Thread node. Compatibility reads carry/mint no queued or held grant (RT-00); recovery success awaits that prerequisite. No migrator is authorized by this plan; any later conversion needs its own source-retention, atomic-publication and resume-or-rollback evidence. |
| Parallel routing fails or is cancelled | Aborted/unavailable/stale site answers place no input and open no Thread. If a parallel target id is invalid/duplicate or any subsequent step refuses, retain the exact original index: no orphan target, partial input placement or process transition. A model answer alone never grants or dispatches work. |
| Interrupt correction races a pause/stop/completion | An interrupt requests pause at the next boundary, never a stop. Correcting one of two interrupts retains the other's pending pause; an honoured pause stays paused; terminal processes stay terminal; stale corrections refuse. Preserve request evidence and resume digest across record versions. |
| Concurrent independent Threads | Interleave two Threads' transitions and separate active goals; transitioning one preserves the other's record, inputs, process and authority. Only one active goal and live process per Thread; one goal attaches once within a project. No new global lock or serial batch is introduced by compatibility reading. |
| Concurrent artifact updates | Preserve monotonic artifact revisions within a Thread; cross-Thread writes still require canonical effect locks. Ownership/key renames do not expand a grant or bypass stale read-set/resource checks. |
| Old exported-name consumers | Exercise a fixture importing the public old names and one using the new names. Preferred atomic change updates all checked-in callers and documents the source-breaking API change. If the owner requires a temporary deprecated alias, it must be one identity/implementation with a removal boundary and compile/behavior tests; no duplicate state model or unsupported deep-import shim. A recorded-version read mapping, if later justified, does not imply an API alias (Q5). |
| Weft links across crash/concurrent arrival | Old segments and new segments resolve the same ids, including forward targets, dependency joins, repeated cancels and supersession before/after recovery. New spans point at their owning durable node, at any depth; a child span must not inherit its parent's id, and two actions on one node share that node id. Preserve historical action correlation as recorded evidence; apply section 4 to any actual transitional bytes. Slow/throwing/reentrant sinks do not change scheduling, budgets or outcomes. |
| Authority and disclosure | Opening, decoding, correcting or resuming creates no grant/approval/budget. Queued/held compatibility reads never carry or mint a grant; mixed-version replay issues none before start (RT-00). Single-use grants stay consumed after crash and are never re-presented; uncertain effects are reconciled only under current authority. Reject credential-shaped ids, keep raw input/provider errors out of records and keys out of argv/logs. |
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
evidence appears. Preserve and test any transitional bytes if discovered;
none expected. No repeat confirmation is required.

### Q4 — Answered: Weft `thread_id`

D-ENG-017: the durable node in the Thread tree that the span belongs to, not a
parallel workstream id. PR 1 records the current action-id/target-node crosswalk;
PR 3 proves node binding, subject to its explicit runtime prerequisites.

### Q5 — Open: public TypeScript export break policy

May old public TypeScript exports break atomically, or are temporary deprecated
aliases needed for named downstream consumers? Recommend atomic rename in this
private `0.0.0` workspace; aliases require a real consumer and removal boundary.
D-ENG-017 settled wire compatibility, not this source export policy.

### Q6 — Open: `intake.classify` frozen labels

Should the existing labels, shapes and frozen sets be preserved, or should a
separately scoped/versioned mapping and evaluation follow? Recommend preserving
labels/sets for this rename. D-ENG-017 does not authorize rewriting benchmark
evidence or changing classification semantics.

### Q7 — Open: #330 document owner and scope

Who owns #330's alignment, and what exact file/scope and reviewer follow?
Recommend naming the owner and document now; defer only that prose if still
unidentified. No owner is invented here. #320's one-Thread glossary and normative
alignment still belong in PR 1.

## Planning-run validation

Only `PLAN.md` may change; no source, glossary or test edits, dependency install,
network or push. This revision uses D-ENG-017 as supplied decision evidence;
no remote decision/issue lookup is possible or needed.

- Plan4 documentation red observed before editing: missing D-ENG-017 lock,
  dual allocation, unanswered Q1–Q4, stale HEAD and both inventory totals.
  The temporary deterministic planning check is outside the repository;
  it grants no implementation authority. Implementation slices retain their
  own required behavioral red/green evidence.
- Recounted source inputs at actual HEAD `02543c2`: workstream **480 occurrences
  on 383 lines in 12 files**, thread **351 occurrences on 299 lines in 47 files**.
  The inventories above are authoritative; #320's separately inspected changes
  explain plan3's main-based totals. Exact `workstream_id` remains 71 (76 as a
  substring), `workstream@1` remains 5 and the existing workstream/process/route
  suite remains 33 top-level tests. No source inputs changed during this task.
- Planning checks green after editing: exact lock, Q1–Q4 answered/Q5–Q7 open,
  no dual allocation, actual HEAD, both inventories, RT-00 and conditional
  transitional-byte coverage. Whitespace checks pass; only `PLAN.md` is modified.
- Node 22 validation used `/home/box/.local/node22/bin`, version **v22.23.4**.
  Direct checks passed: import direction (325 files), ambient clock (104),
  ambient entropy (51), ambient environment (133) and swallowed failures
  (12 manifests/workflows).
- `npm run verify` was attempted and stopped in `npm run check`:
  benchmark-digests passed; verify-cache tests failed. `node_modules/.bin`
  is absent and a direct `vp` spawn reports `ENOENT`. No dependencies were
  installed; the remaining full-suite stages did not run.
- `npm run test:checks` passed credential-parity and execution-provider test
  files; `checks.test.mjs` failed. Direct diagnostic execution reports
  5 failed / 1 passed fixture checks with missing expected child output;
  a child-process probe also reports `EPERM`. The full deterministic suite
  remains **not green** in this environment. Implementation still requires
  installed locked dependencies and a working runner before merge; no test,
  permission or protected check was weakened.
