# WV-329: workstream → one nestable Thread kind (D-ENG-017)

Planning only. D-ENG-017 (Benjamin, 1 November 2026) locks one nestable
**Thread** kind at every Thread depth, retaining `thread@1`, `thread_id` and `thread.*`.
This plan prepares the atomic workstream → Thread rename into that family;
it changes no source, glossary, tests, schemas or recorded data. Owner questions
Q1–Q13, including Q10-0, are answered in section 7: Q1–Q4 by D-ENG-017, Q6 by
D-ENG-019, Q8 by D-ENG-018, Q9 by D-ENG-020, and Q5, Q7, Q10-0, Q10's mechanical
schema answers, Q11–Q13 by the deciding Claude Opus session under D-ENG-021
(1 November 2026). **Q14, the child-Thread goal-association and goal-ending
contract, is open for Benjamin** (section 7). It is observable lifecycle policy, so
D-ENG-021 does not decide it. Q14 gates only PR 2b's goal-association part; PR 1's
naming/crosswalk contract, PR 2a's pure rename and rename-only PR 4 prose run
without it.

## 1. Evidence, scope, and data shape inventory

The source inventory below is reproducible at
`f7b34887f3ca3a4b1d6d94d21269f75f45cff359` (`f7b3488`).
#320 (`8ce60c5`, PR #362), `docs/durable-recursive-threads.md` and its glossary
additions are now present. They describe proposed, unimplemented runtime behavior.
Read `VISION.md`, `GLOSSARY.md`, `AGENTS.md`, current contracts, transitions and
their tests, Weft validation/emission/recovery tests and import-direction checks
before revising this plan. Review-round history belongs in the PR description
or an issue comment; see Follow-ups.

Every implementation PR must branch from current `origin/main`, carrying only
its declared prerequisite changes. PR 1 starts with a recount there and
records that exact base SHA.
#330's owner, document and scope are unidentified in the repository (Q7);
PR 4 holds only that prose.

Reproduce the required inventory, including plurals and identifier substrings:

```sh
rg -n -i 'workstream' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
rg --json -i 'workstream' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
rg -n -i 'thread' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
```

Counts below are regex **occurrences**, not just matching lines; the JSON
`submatches` arrays provide occurrence counts. These are tracked/source inputs
visible to normal `rg`, excluding ignored build/dependency output. The scanned
inputs were recounted at planning HEAD `f7b3488`; `PLAN.md` is excluded from
that scan. PR 1 must recount on its current origin/main base. The groups in this
table partition all **489 occurrences on 390 lines in 13 files**: lowercase
`workstream` 291, `Workstream` 183, uppercase `WORKSTREAM` 15.

| Group                                 | File                                            | Occurrences | Matching lines |
| ------------------------------------- | ----------------------------------------------- | ----------: | -------------: |
| Record, exported types/functions      | `packages/weave/src/workstream.ts`              |         139 |            104 |
| Package exports                       | `packages/weave/src/index.ts`                   |          14 |             14 |
| `input.route` state and transitions   | `packages/weave/src/input-route.ts`             |          52 |             38 |
| `input.route` disclosed state         | `packages/weave/src/sites/index.ts`             |           2 |              2 |
| Operating-process records             | `packages/weave/src/operating-process.ts`       |           9 |              7 |
| Contract documentation                | `packages/weave/src/WORKSTREAM-CONTRACT.md`     |          66 |             58 |
| Site documentation                    | `packages/weave/src/sites/CONTRACT.md`          |           4 |              2 |
| Execution-provider documentation      | `docs/execution-provider-contract.md`           |           4 |              3 |
| Domain definitions and language rules | `GLOSSARY.md`                                   |          11 |              7 |
| #320 design terminology               | `docs/durable-recursive-threads.md`             |           9 |              7 |
| Tests and inline fixtures             | `packages/weave/test/workstream.test.ts`        |          98 |             82 |
| Tests and inline fixtures             | `packages/weave/test/input-route.test.ts`       |          47 |             37 |
| Tests and inline fixtures             | `packages/weave/test/operating-process.test.ts` |          34 |             29 |
| No matches                            | `checks/`, `AGENTS.md`                          |           0 |              0 |

Group totals: record/API 153; input routing 54; operating-process source 9;
documentation/glossary 94; tests/inline fixtures 179. There are no separate
workstream fixture files or matches in other packages in this scan.

### Schema IDs and serialized keys (subsets of the table)

`workstream@1`: **5 inside the scan inputs, 6 repo-wide including `CONTRACT.md:12`**
(excluding this plan). The 5 scan-input occurrences are in 3 files:
`packages/weave/src/workstream.ts` (1),
`packages/weave/src/WORKSTREAM-CONTRACT.md` (3), and
`packages/weave/test/workstream.test.ts` (1).
`WORKSTREAM_SCHEMA` occurs 5 times: source module (4) and public barrel (1).

The record has ordered keys `schema`, `workstream_id`, `project_id`, `origin`,
`opened_at`, `revision`, `goals`, `inputs`, `artifacts`, `process`. The index has
`project_id`, `workstreams`; successful transition results have `ok`, `index`,
`workstream`. Q12 is answered (a1): ordered index keys become `project_id`,
`threads`, `max_depth`. PR 2a renames only `workstreams` → `threads`;
`max_depth` is a new serialized index key and a contract extension owned by
PR 2b, not a pure rename. Goal, input, and artifact entries retain ids, revisions and
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

`packages/weave/src/index.ts` re-exports all 9 types, the constant,
`emptyWorkstreamIndex`, `openWorkstream`, `transitionWorkstream`, and
`activeGoal`: **14 public names**, of which 13 contain the old term;
names at `index.ts:247–260` (block opens at 246).
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
separately; align it with the same kind at different Thread depths.

The three tests contain **33 top-level behavioral tests**: workstream 8,
operating process 10, input route 15. They pin ordered serialized keys,
schemas, refusal values, opening without authority, one active goal,
independent records, input ordering, artifact revisions, byte-identical
transition replay, process lifecycle, routing atomicity/correction, cancellation,
and provider-free reconstruction. Their existing assertions are acceptance
constraints, not snapshots to regenerate wholesale. Preserve any actual
transitional bytes if discovered; none are expected for workstream records under D-ENG-017. Do not invent a legacy reader for fixtures.

A repository-wide cross-check found another **4 occurrences on 2 lines** in
repository-level `CONTRACT.md`, outside the requested scan inputs: contract title/link, schema and
execution description. Include its link/terminology update in implementation.
There are no other workstream matches outside the required scan inputs at this
baseline (excluding this plan). PR 2a's legacy-name scan covers the whole
repository, including repository-level `CONTRACT.md`, with an explicit allowlist.

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
Thread node owning the span. PR 1 records that crosswalk; PR 3 supplies
behavioral evidence for the emission mapping once durable Thread node binding exists.
Null envelope fields remain permitted for records without a Thread.

| File                                         | Count | Use and treatment                                                                                                                                                                          |
| -------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/weave/src/weft.ts`                 |    21 | Port envelope, action causal lifecycle, deterministic record ids and join/supersession/cancel links; preserve historical evidence; align new emission with the owning Thread node in PR 3. |
| `packages/gateway/src/weft.ts`               |     2 | Envelope field and null emission; no project identity.                                                                                                                                     |
| `packages/agentfabric/src/weft.ts`           |     2 | Envelope field and null emission; no project identity.                                                                                                                                     |
| `packages/weft/src/types.ts`                 |     3 | `thread.transition`, outcome subject `thread`, envelope `thread_id`.                                                                                                                       |
| `packages/weft/src/validate.ts`              |    12 | Closed keys/kinds/subject, id rules and cross-record link requirements.                                                                                                                    |
| `packages/weft/src/WEFT-CONTRACT.md`         |    35 | Definition, transitions, cross-chain links, crash/recovery identities, action mapping, SQLite scopes.                                                                                      |
| `packages/weft/src/otel.ts`                  |     2 | Exports envelope as `weft.thread_id`; keep attribute name; align its Thread node mapping in PR 3.                                                                                          |
| `packages/weft/src/sqlite-intake.ts`         |     3 | Imports that OTel attribute; null for generic spans.                                                                                                                                       |
| `packages/weft/src/sqlite.ts`                |    18 | `threads` table, `thread_id` foreign keys/columns and insertion; legacy rows null.                                                                                                         |
| `packages/weft/fixtures/records.json`        |    66 | Valid/invalid v1 records, transitions and causal links.                                                                                                                                    |
| `packages/weft/fixtures/otel-all-kinds.json` |    12 | Golden span attributes and transition kind.                                                                                                                                                |
| `packages/weft/fixtures/otel-golden.json`    |     4 | Golden causal attributes.                                                                                                                                                                  |
| `packages/weft/test/validate.test.ts`        |    11 | Envelope/kind/transition validation and rejection paths.                                                                                                                                   |
| `packages/weft/test/otel.test.ts`            |     5 | Causal attribute export; no project identity.                                                                                                                                              |
| `packages/weft/test/sqlite.test.ts`          |     2 | Existing `threads` table and its scope.                                                                                                                                                    |
| `packages/weft/test/sqlite-intake.test.ts`   |     2 | Known Weft/generic null attributes.                                                                                                                                                        |
| `packages/weft/test/otel-all-kinds.test.ts`  |     1 | Canonical causal transition.                                                                                                                                                               |
| `packages/weft/test/otel-schema.test.ts`     |     1 | Null causal envelope field.                                                                                                                                                                |
| `packages/weft/test/disclosure.test.ts`      |     1 | Null causal envelope field.                                                                                                                                                                |
| `packages/weft/test/sink.test.ts`            |     1 | Null causal envelope field.                                                                                                                                                                |
| `packages/weave/test/w5-trace.test.ts`       |    32 | #187 concurrent chains, joins, repeated cancellation, supersession and emitter correlation.                                                                                                |
| `packages/weave/test/w5-fixture.ts`          |     1 | Causal envelope type for W5.                                                                                                                                                               |
| `packages/weave/test/w5-records.test.ts`     |     1 | W5 transition kinds validate.                                                                                                                                                              |
| `packages/weave/test/w5-isolation.test.ts`   |     1 | Causal reporting does not alter scheduling.                                                                                                                                                |
| `packages/weave/test/w5-replay.test.ts`      |     1 | Recovery preserves the parent of newly opened causal work.                                                                                                                                 |
| `packages/gateway/test/weft.test.ts`         |     1 | Null causal envelope field.                                                                                                                                                                |
| `docs/research/typesafe-harness-lessons.md`  |     3 | Explicitly defines a thread as the causal sequence; work dependencies and effect locks are separate.                                                                                       |

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

| File                                               | Count | Classification                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GLOSSARY.md`                                      |    36 | Current Thread/Workstream distinction is superseded by D-ENG-017; fold it and the present #320 additions into one nestable Thread entry in PR 1. Q6: labels kept; `running_threads[].thread_id` → Thread nodes.                                                                                    |
| `docs/durable-recursive-threads.md`                |   160 | #320's proposed durable Thread contract; reconcile normative naming, id scope and nesting rules in PR 1, remaining explanatory prose in PR 4.                                                                                                                                                      |
| `packages/weave/src/WORKSTREAM-CONTRACT.md`        |     8 | #26's quoted thread is already project-level; remaining comparisons explicitly distinguish the causal-chain Thread and Weft id from the workstream. Replace the distinction with D-ENG-017's single nestable kind.                                                                                 |
| `packages/weave/src/sites/index.ts`                |     6 | `IntakeState.running_threads[].thread_id`, fixed intake question and `new_thread`/`continue_thread`: legacy task/causal-work vocabulary; no durable Thread tree integration yet. Q6 (D-ENG-019): new disclosed ids point at Thread nodes; labels preserved; frozen benchmark bytes stay unchanged. |
| `packages/weave/src/sites/CONTRACT.md`             |     1 | Same intake summaries.                                                                                                                                                                                                                                                                             |
| `packages/weave/test/p5.test.ts`                   |     5 | Intake summary shape and frozen choice vocabulary; no project Thread behavior.                                                                                                                                                                                                                     |
| `packages/weave/test/p6.test.ts`                   |     1 | Empty intake `running_threads` fixture.                                                                                                                                                                                                                                                            |
| `packages/gateway/test/amos.test.ts`               |     8 | Intake choices, prompt and generic choice fixtures; no project Thread behavior.                                                                                                                                                                                                                    |
| `docs/m7-decision-loop.md`                         |     5 | Intake question/options/summaries: legacy task vocabulary; storage `run/thread/...` description: causal Weft storage.                                                                                                                                                                              |
| `docs/execution-provider-contract.md`              |     3 | Boundary table lists Threads and workstreams separately: old Thread is causal. Independent Threads and X-T10 programs are execution-work units, not a wired project record; fold their descriptions into one Thread kind while preserving the action/process distinction.                          |
| `checks/fixtures/execution-provider/contract.mjs`  |     7 | `thread:a/b/c` labels for separate offered sets/worker progress; execution correlation ids, no `Thread` type or `workstream@1` shape. Keep values unless the fixture contract changes.                                                                                                             |
| `docs/research/monty-sandbox.md`                   |    18 | Explicit vocabulary note binds Thread work to #28's operating process: already the planned project-level sense. Two matches concern OS `threading`/threads and remain OS terms. Preserve historical evidence and qualify lifecycle statements when updating the note.                              |
| `docs/design-system.md`                            |     6 | Initial Threads/input-routing/pause scope exclusion: planned project-level work. Five other uses name the conversational component, not a durable Thread record.                                                                                                                                   |
| `packages/tapestry/src/vocabulary.ts`              |     2 | `conversation.thread@1`: conversational presentation component, not the domain identity.                                                                                                                                                                                                           |
| `packages/tapestry/src/session.ts`                 |     1 | Same versioned component node.                                                                                                                                                                                                                                                                     |
| `packages/tapestry/src/tree.ts`                    |     2 | Same component placement/reading.                                                                                                                                                                                                                                                                  |
| `packages/tapestry/test/tree.test.ts`              |    10 | Same component identity/placement; no project Thread model.                                                                                                                                                                                                                                        |
| `packages/tapestry-web/src/host.tsx`               |     3 | Component renderer dispatch and `ConversationThread`; presentation only.                                                                                                                                                                                                                           |
| `packages/tapestry-web/src/paint/conversation.tsx` |     2 | Renderer name/test id; presentation only.                                                                                                                                                                                                                                                          |
| `docs/respan-routing-learnings.md`                 |     6 | External Respan conversation/cache affinity and a proposed thread+digest cache key; external correlation, not a durable Loom Thread id. Do not rewrite external `thread_identifier`.                                                                                                               |
| `packages/agentfabric/test/shell-run.test.ts`      |     1 | OS/main JS thread blocking comment.                                                                                                                                                                                                                                                                |

The merged #320 design note and glossary additions are included in the current
inventory above. Align its §3, dependent normative names and glossary additions
in PR 1; retain its
proposed/unimplemented status. Remaining explanatory prose goes in PR 4.

No `thread` matches occur in `AGENTS.md`. Beyond the required scan inputs, inspect
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

Locked answers (using qualified Thread terms):

1. **One Thread kind** keeps `thread@1`, `thread_id`, and `thread.*`. There is no second product identity.
2. **Nestable**: optional parent, optional children. Project-level and goal-local are the same kind at different Thread depths in one Thread tree — not two concepts needing two schema families.
3. **Drop** the separate `workstream@1` schema / workstream vocabulary; do not invent `project.thread@1` or a "Causal chain" / "Work unit" twin.
4. **Weft `thread_id`** points at the Thread node in that Thread tree the span belongs to (the durable record), not a parallel workstream id.
5. **Compatibility**: rename in place now (private 0.0.0, no external recorder, no recorded workstream records). No @2 dual-read path unless evidence of an external recorder appears.

PR 1 must establish one coherent `thread@1` contract before implementation:
optional parent, optional derived children, one identity at any Thread depth.
Project-level conversation and goals over time, and #320's goal-local purpose,
completion, results and dependencies, describe Thread nodes in that same Thread tree. Reconcile
the flat project index and #320's fixed goal-local scope in that contract; never
select different decoders by Thread depth. Record exact field presence and validation
using existing capabilities, without a second schema or automatic worker/process.
The unified field set is **answered in Q10 (a)**: today's ten fields
`schema, thread_id, project_id, origin, opened_at, revision, goals, inputs,
artifacts, process` are required at every Thread depth; `parent` is optional;
#320 §5.1's `purpose, completion, depends_on, share, deadline, lifecycle,
cancel, resume_point, results, evidence` are common optional fields; #320's
stored `goal_id` field is dropped, so the field set has no second goal field.
#320's per-goal root Thread becomes the goal's first child of the project-level
Thread, not a second parent-less root. Q10-0 is answered (a): today's renamed
10-field record is a valid root Thread under that matrix, through the same
decoder that accepts children, so PR 2a need not wait for the Q10 contract
extension. No interim schema specific to root Threads is authorized.

**Child-Thread goal association is open (Q14, Benjamin).** Today's
`goal.attached` refuses `goal_attached` if any Thread in the project index
already has that goal id, and a root Thread's goal is its own active `goals[]`
entry. Every Q14 option keeps that root-Thread behavior, so the renamed record
and PR 2a are unaffected. Q14 decides how a child Thread relates to its
ancestors' goals, and whether ending a goal blocks on, cascades to or ignores
open child Threads. Until it is answered, no plan text, glossary entry or test
may assert a child goal-association rule; PR 2b's other nesting checks may
proceed. Only the association reconstruction requirement below is architectural
(D-ENG-021); it binds whichever option Q14 selects and selects none of them.

**One id rule at every Thread depth.** #320 §5.1's `<parent>/<opening seq>/<index>`
and goal-only uniqueness conflict with Weft `isId` (`validate.ts:46`): `/` is
rejected, nesting grows ids beyond 128, and different goals can collide in the
project index and SQLite `threads(run_id, thread_id)` key. **Confirmed by Q10:**
replace #320 §5.1's child id scheme with injected opaque ids
matching `^[A-Za-z0-9][A-Za-z0-9_.-]*$`, a subset of the existing Loom `boundedId`
and Weft `isId` languages, retaining their credential-shaped-id refusals. Use a
**Thread-specific id predicate** only for `thread_id`/`parent` and references
to Thread nodes, including `input-route.ts`'s injected `new_thread_id` path opening
a parallel target Thread, which Q10 places as a new root Thread.
Leave shared `boundedId` and `correlation` unchanged, including their 128-character
bound and colon acceptance for goal, project, artifact, site/intake and
benchmark-route ids. Do not tighten Weft `isId`. No `:`, `/` or `@` in new Thread node
ids; the same bounded length applies at every Thread depth, independent of ancestry.
Identity allocation is injected and replay uses recorded ids; no ambient entropy
or parent/sequence concatenation. Confirmed scope is **project-wide uniqueness**,
including settled Thread nodes across every goal; duplicate allocation refuses
atomically rather than overwriting or merging. SQLite currently keys Threads
and span foreign keys by `(run_id, thread_id)`; it does not enforce project-wide
identity or correlate a Thread node across runs. Q11 is answered (b): storage
and OTel stay run-scoped. Do not infer a storage scope change from the Loom id scope.
PR 1 records these replacements as amendments to the merged #320 design, citing
D-ENG-021; they change only #320's naming, id and placement rules, not its
proposed/unimplemented status.

**Derived Weft id budget (confirmed contract extension).** Use a node-length cap rather
than a digest-based record-id scheme. Let E be the maximum emitter-id length;
for the current `:thread:` format the safe cap is **N = 93 - E**:
`E + 8 + N + 11 + 16 <= 128` for
`${emitter_id}:thread:${node_id}:cancelled:${seq}`. The 16 digits cover
`Number.MAX_SAFE_INTEGER`; `:opened`, `:closed`, `:joined` and `:superseded`
are shorter. Q10 confirms E = 32 and N = 61 for new node-bound emissions; an
unrestricted 128-character emitter leaves no usable Thread node budget. The
Thread-only grammar is therefore `^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$` under that
budget, not 128-character Thread nodes. The new-record identity contract below
narrows the node-bound emitter grammar to colon-free ids of at most E characters
and moves action-chain events to a `chain` family, but keeps the Thread family's
`${emitter_id}:thread:${node_id}:<transition>[:${seq}]` layout and its longest
suffix. Q9(b)'s version lives in `schema`, not in the record id, so N = 61
stands. PR 1 records the exact bounds and emission format before PR 2b admits
ids; if review changes the Thread-family layout to a longer suffix, recompute N
downward first.
**PR 2b first enforces N** at Thread node admission, including root Threads and parent ids;
it depends on Q8/Q9 as well as Q10, and owns the N+1/128-character-node reds.
PR 3 owns enforcement of E in **Loom's emitter construction for node-bound
emissions only**, before accepting that emitter configuration or emitting.
Weft `isId`, gateway/Fabric/external emitters and historical emitter ids remain
unchanged. Reject over-budget Thread node/emitter ids without truncation.
Historical record ids remain unchanged. The Thread depth N check must validate the
envelope `thread_id`, **every derived Weft record id and link target**, with
maximum-length Thread node and emitter ids and the longest suffix/sequence. Include
the N+1 boundary and the formerly valid 128-character Thread node that breaks emission.

**New-record identity contract (decided D-ENG-021; PR 1 records it before the
format and budget are locked).** Colon-free Thread node ids alone do not make
`weft.record@2` ids collision-free. Weft `isId` admits `:` in emitter ids, and
judgment refs may contain `:`. Concrete counterexample under the earlier format:
Thread emitter `a:judgment`, node `n`, transition `opened` yields
`a:judgment:thread:n:opened`, and judgment emitter `a` with request id
`thread:n:opened` yields the same id. Both emitters fit E = 32 and the node fits
N = 61. A different `schema` does not separate them: SQLite keys spans by
`(run_id, id)` and OTel span ids hash `[…, trace_id, record_id]`. The second
collision: Q8 moves action-chain events to the action subject, and if they keep
`thread:${action_id}:…` ids, action `x` and Thread node `x` produce the same
`:thread:x:opened` id. The contract is:

1. **Colon-free node-bound emitters.** A Loom emitter that emits any
   `weft.record@2` record has id `^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$`
   (at most E = 32, no `:`, `/` or `@`). All of its records in that trace use
   that id, whatever their family. Enforce this at Loom's emitter construction for
   node-bound emission only, before any record is built. Weft `isId`, `boundedId`,
   `correlation`, gateway/Fabric/external emitters and historical emitter ids stay
   unchanged.
2. **Fixed family tag after the first `:`.** Every record id from a node-bound
   Loom emitter, `@2` or null-id `@1`, is
   `<emitter>:<family>:<rest>` with family one of `thread`, `chain`, `action`,
   `cycle`, `goal`, `judgment` and `outcome`. The emitter ends at the first `:`, and
   the family tag is the next segment. The families are pairwise disjoint because
   their tags differ.
3. **Per-family recovery.** `thread:<node>:<transition>`: the node is colon-free.
   `chain:<action_id>:<edge>[:<seq>]` and `action:<action_id>:<state>`: strip
   the fixed edge or state word (plus a trailing all-digit sequence for
   `cancelled`); the remainder is the action id, colons included. `cycle` and
   `goal` carry only integers and fixed words, `outcome:goal:<seq>` is fixed, and
   `judgment:<ref>` is the whole remainder. Equal ids therefore imply equal
   emitter, family and components.
4. **Action-chain events get their own family.** `@2` chain edges are
   `<emitter>:chain:<action_id>:<edge>` (`cancelled` adds `:<seq>`). Thread node
   lifecycle keeps `<emitter>:thread:<node>:opened|closed`. A node and an action
   with equal id strings can no longer collide. The `chain` layout is one
   character shorter than the historical `:thread:<action_id>:` layout, so no
   action id that fits today overflows.
5. **Other emitters in the same trace.** Weft requires `record_id` to be unique
   within a trace across emitters. Gateway, Fabric and external emitter ids may
   contain `:`, for example gateway `a:thread` with its
   `<emitter>:<request>:route:<n>` ids, so the format cannot prove disjointness
   from them. The composition root assigns every port's emitter id. It must
   refuse a trace in which another emitter id equals a node-bound Loom emitter
   id or begins with `<that emitter>:`. That is a composition check at port
   construction, not a validator change. Receivers keep refusing an identity
   reused with unequal content (see the delivery contract in PR 3).
6. **Historical ids are untouched.** `weft.record@1` keeps
   `<emitter>:thread:<action_id>:…` chain ids, colon-bearing emitters and link
   targets byte for byte. The Thread-family layout and longest suffix are
   unchanged, so N = 93 − E = 61 stands; the `chain` family is shorter.

The old collision `(a, b:thread:c)` versus `(a:thread:b, c)` is prevented twice:
the colon-bearing node is refused, and so is the colon-bearing emitter. PR 2b
owns the node-grammar red. PR 3 owns the emitter-grammar, composition and
emitted-id/link-target collision reds, including the counterexample above.
Any later format change must preserve rules 1–6 and revalidate N before PR 2b
admits ids. Do not tighten shared validators to make families disjoint.

**Canonical nesting (confirmed by Q10).** `parent` is the only stored structural
edge; children are derived by selecting Thread nodes whose `parent` names this Thread node,
never stored as a second source of truth. A root Thread omits `parent`; a leaf has no
derived children. `parent` is immutable after open; reparenting is forbidden.
Refuse missing or cross-project parents, self-parentage and cycles without a
partial transition. A root Thread has Thread depth 0; a child Thread has its
parent's Thread depth + 1. An explicit positive safe-integer `max_depth` bounds
Thread depth. A per-call child/group argument alone cannot enforce one limit:
different callers can pass different values, and the limit is absent from
replayable state. Q12 is answered (a1): inject and record it once at
project-index creation, then derive every child admission's limit from that
state across goal boundaries and across every root Thread in the index. That
adds a serialized index key, inventoried in section 1 and mapped in section 4.
No per-call limit argument exists, so no caller can raise it. Thread depth 0 for
a root Thread is always within the limit; #320 §8's per-goal limits remain
independently enforced. PR 1 records the answer; PR 2b records its boundary
cases. There is no implicit unbounded or default limit.
Define **Thread tree**, **root Thread**, **Thread node** and **Thread depth** inside PR 1's single
Thread glossary entry, plus the **Thread depth limit** (`max_depth`, Q12). A
child-Thread goal-association term (for example **inherited goal association**)
is added only with Q14's answer, in PR 1b or the nesting issue's contract PR. A
project index may hold several Thread trees: each `parallel` target opens
another root Thread (Q10).

**Association reconstruction requirement (decided D-ENG-021; independent of the
Q14 option).** Whatever association semantics Q14 selects, reconstructing the
project index from the committed journal must reproduce them exactly, in two
separate senses. _Prefix reconstruction:_ for each committed prefix,
reconstruction from that prefix yields the association the chosen semantics
assign to each child Thread at that same prefix. _Historical query:_ against any
later committed journal, the association as of an earlier prefix is that
original prefix's association, derived from entries up to that prefix only,
never from later entries or the final index; reconstructing that prefix of the
append-only journal suffices, so no new query API is added. Neither sense makes
a later prefix's current association equal an earlier one: subsequent
authorized transitions may change current association exactly as the Q14
answer permits (for example, (c)'s own attach/end transitions). Reconstruction
never reinterprets a committed association; a later transition changes current
association only through its own committed effect. Today's `openWorkstream`, `goal.attached` and `goal.ended`
check evidence only as a nonnegative safe integer (`validSeq`,
`packages/weave/src/workstream.ts:109`), so backdated evidence is accepted, and
pure index values carry no transition order. Any option that relates a child to
ancestor history therefore cannot meet this requirement through interval
containment over caller-supplied evidence alone. Example: a parent attaches G at
evidence 10 and a child opens at 12. Then G is ended with evidence 11, or a
grandparent attaches H with evidence 5 after G ends. Containment over the final
index would now place the existing child outside G or inside H, although neither
transition said so. The Q14 answer records how its option meets this
requirement. Which ancestor supplies a goal, whether an association can change
after opening, and any evidence-order refusal are consequences of that answer,
listed per option under Q14 (section 7); D-ENG-021 locks none of them. A root
Thread's association is its own `goals[]`, which reconstruction reads directly,
so the requirement adds nothing for root-only indexes: they, including all 33
ported tests and the `parallel` root target, keep today's evidence behavior.

Language constraint: use those qualified forms for Thread structure; bare **root** still means **composition root**.
Keep Component tree, Default tree, Tapestry component nodes and context-declaration
depth in their existing glossary senses; do not repurpose them as Thread terms.
Immutable parent and limit placement are owner answers (Q10, Q12), not
mechanical consequences of the name lock.

**Concurrent opens.** Apply sibling opens against the latest project index.
**No append CAS exists today:** `ObservationJournal` has only `persist` and
`snapshot` (`packages/weave/src/journal.ts:13–16`), and `AUDIT-CONTRACT.md:179`
explicitly states there is no lock or compare-and-swap in `AuditJournal`.
**Recommend single-writer composition-root serialization**, following that
contract: acquire exclusive ownership, reload the latest committed prefix,
validate and persist before releasing it. Do not add a conditional-append
primitive in this rename. #320 integration must demonstrate this composition at
the real journal boundary; the journal interface alone supplies no exclusion.
No expected/current prefix parameter or new prefix token is added to pure
transitions. The composition root obtains the current index by reconstructing
the reloaded committed journal snapshot under exclusive ownership and calls the
existing index/request transitions on it. Pure tests supply the index produced
by the first serialized commit to the second proposal; the parent's semantic
revision alone supplies no freshness evidence (#320 §5.3 leaves it unchanged by
child opening). Revalidation checks the parent's open/non-cancelled state, id
uniqueness, limits, shares and dependency edges against that latest index.
A proposal whose assumptions are now invalid refuses without mutation; a still
valid stale proposal can succeed, and a retry revalidates again. Distinct valid
siblings survive;
no lost child, duplicate share or edge update. Serialize only the shared index
commit boundary, leaving independent action execution concurrent.
Opening a child group and its dependency additions/rebindings is one atomic
append as in #320 §5.3; no separate stored child-list write. Pure transition
checks exercise these interleavings; journal integration remains follow-up. If
multiple writers are later required, conditional append needs separate #320
integration work with its own contract and demonstrated behavioral red.

**No orphans.** Adopt #320 §6.3–§6.4: every open Thread node with a parent has that parent open
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
`thread@1`, `thread_id`, `thread_revision`, `threads[]`, references to parent
Threads, child Threads and root Threads, `depends_on` producer ids, result-reference and execution-claim
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
the runtime loop. Do not ask the owner to confirm it again.
Repository inspection cannot independently
prove external absence, so new recorder evidence is the only reason to revisit
that compatibility premise.

| Existing unpersisted surface                                          | Locked target                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `workstream@1`, `workstream_id`                                       | `thread@1`, `thread_id`, the one nestable Thread kind                                                                                       |
| `workstreams` index, `workstream` result/request, `new_workstream_id` | `threads`, `thread`, `new_thread_id`, referring to Thread nodes in that same Thread tree                                                    |
| `operating.process@1` ownership                                       | Keep the schema version; rename its ownership key to `thread_id`                                                                            |
| `input.route@1`, `input.route.correction@1` ownership                 | Keep both schema versions; rename their ownership keys to `thread_id`                                                                       |
| Proposed #320 `thread.*` observations and durable fields              | Retain the existing Thread family; reconcile the common contract before implementation                                                      |
| Index ordered keys `project_id`, `workstreams`                        | PR 2a renames to `project_id`, `threads`; Q12(a1) then extends to `project_id`, `threads`, `max_depth` in PR 2b, a new serialized index key |
| No recorded nesting limit                                             | Q12(a1): one injected positive safe-integer `max_depth` on the project index; no root Thread field and no per-call limit argument           |

This is an atomic pre-persistence contract replacement, including nested process
records, routes, corrections, callers and fixtures. Remove active workstream
schema/vocabulary, not arbitrary opaque identifier values such as `ws-a`.
Never decode `thread@1` as two concepts. Add no speculative Thread @2 versions,
dual-read path, alias state model, journal or migrator. This lock covers the
unpersisted rename surfaces above; Q9 (D-ENG-020) separately makes new Weft
emissions distinguishable from recorded Weft evidence by a new record version.
The TypeScript export break policy is Q5 (answered: atomic, no aliases),
separate from this settled wire decision.

**Transitional bytes: none expected** for the renamed records. If recorder or
recorded-byte evidence appears, preserve it, stop and open a separate issue for
the actual storage/reader/writer boundary and compatibility decision. This plan
authorizes no reader or cutover machinery. Replay and grant invariants in
section 6 apply unconditionally; RT-00 remains a separate recovery prerequisite.

Owner Q4 is answered: Weft `thread_id` identifies the durable Thread node owning
the span, at whichever Thread depth it belongs. A parallel workstream id or a second
product identity is forbidden. `WEFT-CONTRACT.md:33` currently defines a causal
sequence, and the reference emitter currently uses `thread_id = action_id`.
Those are implementation evidence to crosswalk, not the target contract.
PR 1 must quote and explicitly supersede the entire no-widening clause at
`packages/weft/src/WEFT-CONTRACT.md:33–36`:

> Correlation across goals or runtimes is outside v1. If it becomes necessary it
> gets its own term and its own field; `thread_id` is not widened to cover it.

A project-level Thread may span goals over time, so the locked Thread node binding
changes this stated scope. D-ENG-017 settles the field name and destination;
D-ENG-020 (Q9 = b) settles the envelope: node-bound records move to a **new Weft
record version** (`weft.record@2`), and `weft.record@1` keeps the superseded
action-correlated meaning for historical evidence. PR 1 supersedes
`WEFT-CONTRACT.md:33–36` with that version split and records that the new
`thread_id` may span goals within one project. Q11 (b) keeps storage/OTel
correlation run-scoped: spanning goals is a meaning of the id, not a cross-run
storage join. Preserving historical bytes alone is insufficient.

PR 1's normative crosswalk must state: “`thread_id` identifies the Thread node in the
Thread tree that the span belongs to (the durable record). The current reference
emitter uses action-id correlation until durable Thread node binding is implemented.”
It must mark that binding as pending implementation, not as another owner choice.
Actions are attempts associated with a Thread node; `action_id` does not become a second
Thread identity. PR 3 must prove that new emission uses the owning Thread node when
that binding exists, including multiple actions on one Thread node and a child Thread node
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
two opened/closed pairs under one Thread node id, alongside #320's Thread node lifecycle.
Q8 (D-ENG-018, a) resolves this: new `thread.transition` is the Thread node
lifecycle, each node opened and settled exactly once, and per-action chain
events move onto the action subject. Q11 (b) makes no storage scope change.
PR 1 names the red check
**Historical action-correlated and new node-bound records are distinguishable**:
a reader must deterministically distinguish both even if their `thread_id`
strings are identical; do not infer meaning from id spelling or arrival time.
PR 3 exercises the `weft.record@2` version through emission, validation, OTel
and SQLite intake without rewriting historical records; if the version is not
preserved on any of those paths, it fails this check. Gateway and Fabric keep
emitting `weft.record@1` with
locally declared ports and null ids when no Thread node binding exists.
Weft remains a projection: no trace reader feeds Loom, no imports reverse, and
nothing emitted grants authority or changes scheduling.

## 5. Smallest ordered PR slices and red-before-green evidence

Review sequence: **PR 1 → PR 2a → PR 2b → PR 3 → PR 4**. Under Q13 (a), #329
owns PR 1, PR 2a and the rename-only part of PR 4; PR 2b and PR 3 move to new
issues linked from #320 and keep the obligations written here. Dependencies are
**1 → 2a → 2b → 3** and **1 → 4**, plus **2a/2b/3 → 4** only where prose cites
final exports, nesting or emission. Independent inventory review, test-case
design and documentation work can proceed concurrently after PR 1. PR 3 may
also need explicitly identified #320 runtime integration; record that dependency
rather than add a parallel id. Every slice uses a branch from current
origin/main with its prerequisite PRs merged or explicitly carried. Q1–Q13 and
Q10-0 are answered (section 7). Only PR 2b's child goal-association part waits
on the open owner question Q14. PR 1, PR 2a, rename-only PR 4 and PR 2b's
parent/id/depth checks do not. PR 2b's Thread node budget is fixed by Q8/Q9/Q10
and the new-record identity contract (N = 61, colon-free E = 32). Under Q10-0 (a), PR 2a
depends only on PR 1's settled terminology/crosswalk and the minimal-root
guarantee; PR 1 may carry the full Q10/Q12 contract extension or split it into
a follow-up PR 1b, which must merge before PR 2b.
Finish every implementing slice green before merge; never merge a partially renamed
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
plus CI's `npm run lint` and `npm run fmt:check` before merge.
For PR 2a and every slice that renames or deletes source or test files, remove
`packages/*/dist` (`rm -rf packages/*/dist`) before build and before verify,
or use a fresh checkout with `npm ci` and no prior build output. `npm run build`
is `tsc -b`, which leaves deleted/renamed outputs behind, and `npm test` runs
`packages/*/dist/test/**/*.test.js`; ignored old modules/tests can otherwise
make a partial rename look green. A dependency reinstall in a previously built
checkout is not a substitute for removing that output. After build and after
verify, require that no `dist/**/workstream*` artifacts remain before reporting
green, independently of the legacy-name scan that excludes build output:

```sh
legacy_workstream_artifacts=$(find packages -path '*/dist/*' -name 'workstream*' -print) && test -z "$legacy_workstream_artifacts"
```

For rename slices, green evidence comes from uncached `npm run verify` after
removing `dist`, not from a `verify:cached` replay.

Keep the build scripts unchanged in this rename. Use the declared
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
`origin/main` and record the exact base SHA and counts. Classify any AgentFabric
`node:worker_threads` matches as OS threading, not domain rename targets.
Before PR 1 edits, record `npm ci && npm run verify` green on that origin/main
base using Node >=22.18. A failed or unavailable install/runner blocks this
precondition; earlier planning attempts do not establish base green. If verify
is red on base in a clean, supported environment after `npm ci`, follow the
separate base-failure issue/owner step in Follow-ups; never accept a red baseline.

Apply D-ENG-017 in one Thread glossary entry and the existing contract, updating
all related definitions and #320 additions/language constraints in section 3
together. Define **Thread tree**, **root Thread**, **Thread node** and **Thread depth** inside that
entry. Align #320 §3, its glossary summary, normative identifiers and common
contract path while retaining its proposed/unimplemented status.
Record every section 7 answer with its decision id: Q5 export policy, Q6 intake
meaning, Q8 node lifecycle, Q9 record version, Q10 field matrix/placements/id
rule, Q11 run-scoped storage, Q12 `max_depth` on the index, and Q13's issue
boundary, plus latest-index revalidation and no-orphan contracts. Record Q14 as
open, without asserting any child goal-association rule, and record section 3's
association reconstruction requirement, which selects no Q14 option. Under
Q10-0 (a) the Q10/Q12 contract extension may land in a follow-up PR 1b; PR 2a
needs only the settled terminology/crosswalk and the minimal-root guarantee.
Q14's answer is recorded in PR 1b, or in the nesting issue's contract PR if
#329 closes first; either way it is recorded before PR 2b's goal-association
red. Behavioral enforcement stays in PR 2b/PR 3 and #320 integration;
documentation assertions cannot establish those behaviors.

**Exact `weft.record@2` mapping (PR 1 prerequisite for PR 3).** PR 1 records
this mapping in the Weft contract. A record family not listed here is not
emitted under `@2` until it is added with its own red.

- **Thread node lifecycle:** kind `thread.transition`, subject `thread`, id
  `<emitter>:thread:<node>:opened|closed`. Under `@2` the only transitions are
  `opened` and `closed`; `joined`, `superseded` and `cancelled` are refused on
  `@2` `thread.transition`. Neither transition requires a link. #320's settle
  outcome is a field on `closed`.
- **Action state:** kind `action.transition` with `state` (today's closed state
  set), id `<emitter>:action:<action_id>:<state>`, carrying the owning node's
  `thread_id`. State records are always emitted and never omitted for a link
  reason.
- **Action chain edges:** kind `action.transition` with an `edge` field
  (`opened`, `joined`, `superseded`, `cancelled`, `closed`) and no `state`. A
  `@2` `action.transition` carries exactly one of `state` and `edge`. Id
  `<emitter>:chain:<action_id>:<edge>`, with `:<seq>` added for `cancelled`.
  Links and targets: `joined` requires `joins` → each dependency's
  `chain:<dep>:closed`; `superseded` (on the earlier action) requires
  `supersedes` → the replacement's `chain:<id>:opened`; `cancelled` carries
  `cancels` → `chain:<id>:opened`; `closed` carries `caused_by` → the terminal
  state record. Today `REQUIRED_LINK` applies only to `thread.transition`
  (`packages/weft/src/validate.ts:282,341–344`). Under `@2` it must also apply
  to `action.transition` edges `joined` → `joins` and `superseded` →
  `supersedes`, and it does not follow the events automatically.
- **Cross-trace omission:** only a chain-edge record whose required target lies
  in another Weft trace is not emitted; the Loom journal remains its evidence.
  Action state records and node lifecycle records are never omitted for this
  reason. Today an action belongs to one Loom goal and so to one trace, which
  makes such an edge unreachable from the reference emitter, but the rule stays
  explicit.
- **Not node-bound:** Loom's `cycle`, `goal`, `judgment` and `outcome` records
  carry null `thread_id` and stay `weft.record@1` with unchanged layouts, as
  Gateway/Fabric null-id records do (Q9). Because one emitter id covers all of
  a Loom emitter's records in a trace, they still use the colon-free node-bound
  emitter id (section 3, rule 1).

PR 1 also records section 3's new-record identity contract and PR 3's delivery
contract (logical records versus delivery attempts) as the target for PR 3.
Record section 4's in-place ownership/schema mapping, leaving current source
names explicit until PR 2a. Include Weft's normative Thread node crosswalk immediately;
remaining emission/link alignment belongs to PR 3 and prose to PR 4. Quote and
supersede Weft's no-widening clause with D-ENG-020's version split
(`weft.record@1` historical action-correlated, `weft.record@2` node-bound) and
Q11's run-scoped storage statement. None of these answers reopens D-ENG-017.

**Red before edits:** add `checks/thread-contract.mjs` with a
`checks/test/thread-contract.test.mjs` red/green fixture case, so
`npm run test:checks` (part of G) runs it; wire the check itself into
`npm run check`. **Limit this initial check to settled D-ENG-017 facts**:
one Thread glossary entry for the nestable kind and its `thread@1`/`thread_id`/
`thread.*` family, with **Thread tree**, **root Thread**, **Thread node** and
**Thread depth** qualified and bare **root** reserved for **composition root**;
no active workstream vocabulary outside an explicit reviewed
historical/pending-rename allowlist; section 4's exact current-versus-target
`thread_id` crosswalk wording; and the quoted, explicitly superseded no-widening
clause. It must fail against today's split glossary and causal-only crosswalk.
Keep current source names allowlisted until PR 2a atomically removes them;
never allowlist whole source/doc directories. Text assertions may pin that each
answer is recorded (for example the `weft.record@1`/`@2` split and the
`max_depth` glossary term), but must not stand in for behavior: bounded ids,
parent storage, finite Thread depth, child goal association (once Q14 is
answered), single-writer/latest-index
rules, no-orphan rules and version discrimination are proven only by PR 2b/PR 3
behavioral tests.
This documentation red grants no permission to generate implementation code
before behavioral red.

**Green:** the single-kind terminology, shape and link checks pass together;
current behavior tests still pass unchanged. Run G and full verification. No
`VISION.md` edit: its acceptance boundary stays the same.

### PR 2a — Pure atomic Loom rename into the existing Thread family

Q10-0 (a): depends on PR 1's settled terminology/crosswalk and its recorded
guarantee that the renamed 10-field record is a valid root Thread under Q10 (a);
it does not wait for PR 1b. Under that PR 1 contract,
rename module/test/contract to `thread.ts`,
`thread.test.ts`, `THREAD-CONTRACT.md`; change public exports atomically with no
deprecated aliases (Q5), imports, index/result/request properties, refusal names
and callers together. The source-breaking export change is documented in the
PR description and `THREAD-CONTRACT.md`.
Replace `workstream@1` with `thread@1` and affected ownership keys with
`thread_id`, keeping process/route/correction @1 under the locked in-place
policy. Update repository-level `CONTRACT.md` and site links. This slice changes names only;
optional `parent`, new nesting validation and id-allocation behavior belong in
PR 2b. Keep shared `boundedId`/`correlation` unchanged. Preserve replay functions
and evidence; update unpersisted expectations without invented readers. Intake
labels/sets stay unchanged (Q6); changing live `running_threads[].thread_id`
disclosure to Thread node ids needs Thread node binding and its own red, so it is
not part of this pure rename. The `parallel` target stays a new root Thread (Q10);
`new_thread_id` keeps `boundedId` validation until PR 2b tightens it.
Inference routing, capability admission, authority and component ids stay intact.

**Red before implementation:** a public-entry-point consumer using
`Thread`/`openThread` and the renamed shape must fail compilation or a shape
assertion against the old API. Pin the four affected schema surfaces and
ownership keys with renamed expectations; do not regenerate snapshots wholesale.
A whole-repository legacy-name scan must fail on a stale active API import and
on a stale repository-level `CONTRACT.md` schema/link. Its explicit allowlist covers only
reviewed historical evidence/quotes and this plan, never an entire source/doc
directory; Q5 authorizes no export alias entry. Inspect tracked/hidden files
where relevant; exclude dependency/build/git internals, not repository-level contracts.
Validate an evidence-loss or resume-digest mutation is still rejected.

**Green:** all **33 ported tests** (8 record, 10 process, 15 routing) retain their
behavioral assertions, changed only for the renamed API/wire names. Remove
`packages/*/dist` first (or use the fresh `npm ci` checkout described above),
then run `npm run build` and the no-`dist/**/workstream*` artifact check, then
`node --test packages/weave/dist/test/thread.test.js packages/weave/dist/test/operating-process.test.js packages/weave/dist/test/input-route.test.js`,
the public consumer compile check, whole-repository allowlisted legacy-name
scan, G and full verification from clean `packages/*/dist`, followed by the same
artifact check before reporting green. Keep the build scripts unchanged.
Keep `p5.test.ts`/`p6.test.ts` intake shapes and
options unchanged (Q6). A rename regression is reviewed independently of nesting.

### PR 2b — Optional parent and deterministic nesting validation

Q13 (a): tracked by a new nesting issue linked from #320, not #329. Depends on
green PR 2a, PR 1 (or PR 1b) recording the Q10/Q12 contract, and the fixed
N = 61 / colon-free E = 32 budget. Its goal-association part also depends on
Q14's recorded answer. Add its optional immutable
`parent` and derive children from it, with the same schema and id rule at every Thread depth.
Use injected opaque ids, project-wide duplicate refusal, Thread depth limits and
atomic validation against the latest index. No stored child list, reparenting,
second record kind or automatic process allocation. Introduce section 3's
Thread-specific id predicate here and apply N at every Thread depth: child and
root Thread admission (including the `parallel` target's `new_thread_id`) and
parent references. Never change shared `boundedId`/`correlation`.
**Goal association waits on Q14.** The parent/id/depth part of PR 2b may land
before Q14 is answered, but only if a child Thread's goal behavior stays exactly
today's own-`goals[]` behavior. The PR must document that child-Thread goal
association is pending Q14 and must claim no inheritance, attachment refusal or
goal-ending rule for descendants. Once Q14 is answered and recorded (PR 1b or
the nesting issue's contract PR), PR 2b, or a follow-up PR 2c in the same issue,
implements the chosen option, including the consequences listed for it under
Q14, and demonstrates section 3's association reconstruction requirement for it.
Cover latest-index revalidation/refusal/retry with pure transition interleavings;
durable serialization and append/settle/cancel wiring remain explicit #320 integration with their own
behavioral red. There is no journal CAS to exercise.

Under Q12(a1), explicitly extend `emptyThreadIndex(project_id, max_depth)` with
the new serialized `max_depth` key and update all three test helpers
(`thread.test.ts`, `operating-process.test.ts`, `input-route.test.ts`) and any
other index constructors; every child/group admission, including the live
`input-route.ts` `openThread` caller, reads that recorded policy. There is no
per-call limit argument. Calls to `openThread` for root Threads in
the 8 record, 10 process and 15 routing tests and the live parallel target caller
(a new root Thread) need no per-call limit; constructor changes
must still be explicit. Add optional-parent/common-field assertions without
weakening existing behavior. Cover absent/invalid policy, exactly-at-limit and
over-limit child/group opens, replay preserving the limit, and a second caller
or goal being unable to raise it. Root Thread and child Thread decoding uses the same field
matrix. Do not smuggle these contract/call-site changes into PR 2a.

**Red before implementation:** nested openings against PR 2a must fail to retain
and validate `parent`. Reject missing/cross-project parents, self-parentage,
cycles, reparenting, duplicate ids and depth-limit overflow without changing the
original index. Before Q14 is answered, pin only the unchanged behavior: a
child Thread's `activeGoal` reads its own `goals[]`, and a second
`goal.attached` of G anywhere in the project index still refuses
`goal_attached`.

**After Q14, goal-association reds (separate from parent retention).** With
`parent` already supported and before implementing the chosen option, write the
red for that option's shared-goal case: two child Threads under a Thread whose
active goal is G each relate to G as Q14 specifies, and today's code does not
(`activeGoal` reads only the child's own empty `goals[]`). Failure merely to
retain `parent` is not evidence for this red. Add the option's attachment and
goal-ending reds, and any reds Q14 lists as consequences of that option. For
every option, add **Reconstruction reproduces the chosen goal association**
(section 3): after each committed transition in a nested scenario that
includes section 3's backdated-evidence example and a grandchild, capture the
association the option assigns, and assert that reconstruction from that prefix
equals it. Separately, after the final transition, reconstruct each earlier
prefix of the final journal and assert it equals the association captured at
that prefix, while the final index's current association equals the option's
assignment after the last transition. If the option permits a later authorized
transition to change a child's association, the scenario includes one, so a
mutation that answers historical queries from the final index, or one that
freezes current association at its first value, fails. Root-only evidence
behavior is unchanged in all 33 ported tests.
Named checks: **Thread depth N child id passes Weft validation** (at the
configured Thread depth bound, with distinct parent/action ids, maximum-length Thread node
and emitter ids, every derived record id/link target including the longest
suffix and maximum safe sequence, and the N+1 refusal; validated by Weft in
tests only) and **Two goals' children with the same injected id are refused**
(a faulty injected allocator reuses an otherwise valid opaque id across goals;
refuse `duplicate_thread`, never overwrite). Also reject literal #320 slash ids
and ids longer than the contracted Thread node budget, including a 128-character
Thread node whose derived record id would overflow, so grammar failure cannot hide the
uniqueness test. Reject colon-bearing Thread nodes, including `b:thread:c`, before
deriving ids. Named red/guard **Shared id validators stay unchanged**:
Q10 confirms the Thread-only predicate for root Threads as well as children, so
root Thread opens refuse ids longer than N or containing `:`, `/` or `@`. The
live `input-route.ts` parallel target path checks `new_thread_id` against that
predicate before opening the new root Thread, and a refusal leaves the original
index unchanged. In every case, 62–128-character goal, project, artifact and intake/site ids remain accepted by
their existing validators (also test N+1–128 if N changes). Pin shared colon
acceptance and credential refusals, decision-site validation and frozen
benchmark bytes/digests, including benchmark-route ids. Demonstrate the guard
rejects a mutation tightening `boundedId`/`correlation` globally; green requires
the Thread-only predicate plus that unchanged guard.
Exercise concurrent sibling opens and retry after latest-index
revalidation refusal/parent cancel; assert parent semantic revision unchanged,
both valid siblings retained, no partial edges/shares, and derived children
agree after reconstruction. Validate
an invalid mapper that truncates or concatenates parent ids is rejected.

**Green:** the nesting reds pass under section 3; all 33 ported tests and PR 2a's
consumer/whole-repository scan stay green, with the root Thread/child Thread call-site and
field assertions listed above. Root Thread and child Thread callers follow Q10/Q12's recorded
policy; `parallel` targets remain root Threads. Run narrow
Thread/route/process tests, Weft id validation from the Loom test boundary, G
and full verification. Do not import Weft into Loom source.
For an actual journal boundary, #320's atomic-child-append and no-orphan cases
in section 6 are required integration evidence before claiming durability.

### PR 3 — Weft owning-node mapping and causal links

Q13 (a): tracked by a new node-bound Weft emission issue linked from #320, not
#329. Depends on PR 2b and the recorded #320 Thread node binding prerequisite;
Q8 (a), Q9 (b) and Q11 (b) are fixed. Apply Q10's root-id rule (N = 61 at every
Thread depth); this slice must not tighten N after admission. Enforce section 3's
colon-free E = 32 emitter grammar in Loom's emitter construction for node-bound
emissions only, plus the composition root's emitter-prefix refusal. Leave shared
Weft `isId` and all historical emitter ids unchanged. Implement exactly PR 1's
`weft.record@2` mapping; it is a prerequisite, not something PR 3 designs.
Expand PR 1's crosswalk through Weft mapping/link documentation and Loom
emission comments, and implement the owning-node mapping only after its runtime
binding has behavioral red. The destination is locked: each span's `thread_id`
is its durable Thread node in the same Thread tree. Record any #320 integration
prerequisite explicitly. Do not call retained action-id correlation completion
of this slice. Preserve historical JSON, OTel attributes, SQLite tables,
record-id segments and link targets as historical evidence. Implement new
emission under `weft.record@2` (Q9): node-lifecycle `thread.transition` records
on subject `thread` (Q8), action state records, and `chain`-family action edge
records, both as `action.transition` with the owning node's `thread_id`. Extend
`REQUIRED_LINK` to `@2` action edges, and extend Weft validation, OTel export and both
SQLite intakes to accept and preserve `@2` (OTel intake currently accepts only
`weft.record@1`, `packages/weft/src/sqlite-intake.ts:64,93`) while `@1` keeps
validating unchanged. Under Q11 (b), SQLite remains run-scoped, there is no
PR 3s, and PR 3 claims no cross-run storage correlation.
Gateway and Fabric retain local ports/null ids where no binding exists; Loom imports
no Weft and never reads traces for scheduling.

**Red before edits:** identify the actual stale emission/link statements beyond
PR 1's already-fixed normative crosswalk. Before code mapping, demonstrate red
with distinct root Thread, child Thread and action ids, plus two actions belonging to one
Thread node. Reject a mapping to a parent or parallel project id instead of the Thread node
owning the span. Repeat **Thread depth N child id passes Weft validation** at the
configured Thread depth bound through new emission, OTel and SQLite intake, checking
maximum-length Thread node/emitter ids and every derived record id/link target against
128, including the longest suffix and sequence; repeat
**Two goals' children with the same injected id are refused** at the binding/index
boundary before emission/storage, with no overwrite of the first Thread node's rows.
Named red **Emitter cap for Thread node emissions is enforced at construction**: the E-length
colon-free emitter succeeds. E+1 characters, or any `:`, `/` or `@` (for
example `a:judgment` or `a:thread`), refuses before any node-bound record is
built. Existing Weft validation still accepts otherwise valid 33–128-character
historical, gateway/Fabric/external emitter ids, including `@` and `:`. No
global validator change or historical rejection may make this red pass.
Named red **Distinct emitter/Thread node pairs have distinct record ids and link targets**:
use distinct colon-free emitters, valid Thread node ids, action ids and
judgment refs that contain `:` and family words (`thread:n:opened`,
`x:cancelled`, `x:cancelled:5`), and a Thread node and an action sharing one id
string. Cover every family (`thread`, `chain`, `action`, `cycle`, `goal`,
`judgment`, `outcome`) and every edge/state/sequence suffix through emission,
validation and SQLite link resolution in one trace. Each id must round-trip to
its unique emitter, family and components under section 3's rules 2–3. Include
the recorded counterexample: `(a:judgment, node n, opened)` versus `(a,
judgment thread:n:opened)` must be impossible because `a:judgment` refuses at
construction. Include the former collision `(a, b:thread:c)` / `(a:thread:b, c)`:
both the colon-bearing node and the colon-bearing emitter refuse. Add the
composition red: a trace with Loom emitter `a` and a gateway emitter `a:thread`
(or exactly `a`) refuses at port construction, while unrelated colon-bearing
gateway/Fabric emitters stay accepted. Reject a mapper/grammar mutation that
readmits colon-bearing node-bound emitters, or that puts chain edges back in
the `thread` family, without changing shared validators.
Named red **`@2` action-chain events keep their required links**:
`@2` `action.transition` with `edge=joined` and no `joins`, or `edge=superseded`
and no `supersedes`, rejects. So does a `@2` `action.transition` carrying both
or neither of `state` and `edge`, and a `@2` `thread.transition` with
`joined`, `superseded` or `cancelled`. Every `@1` fixture keeps validating
unchanged.
Repeat **Historical action-correlated and new node-bound records are distinguishable**
under `weft.record@1` versus `weft.record@2`, through validation and both intakes.
Named PR 3 red: **Thread node opened/settled exactly once regardless of action count**.
At the Weft layer, count node-lifecycle `thread.transition` records: one with
`transition=opened` and one with terminal `transition=closed` (Q8; the #320
settle outcome is a `@2` field on that record, not a new transition value).
A zero-, one- and two-action Thread node must each satisfy those counts.
Counting only Loom observations cannot satisfy this red.
#320's Loom `thread.opened` and `thread.settled` observations are counted separately in the journal:
one opening and one terminal observation per Thread node, regardless of action count.
**Delivery contract: logical records versus delivery attempts.** A logical
projection record is one `(trace_id, record_id)` with its content, derived
deterministically from the committed journal. A delivery attempt is one
`WeftPort.emit` call. "Exactly once" in this slice counts distinct logical
records; it never counts attempts. Today `emit` is one-way: `deliver` swallows
throws and never awaits (`packages/weave/src/weft.ts:395–407`). Pending
records live only in memory, there is no durable delivery acknowledgement and
no transaction spans the Loom journal and the sink. `recover()` emits nothing
(`WEFT-CONTRACT.md`, recovery), so a record built but not delivered before a
crash is lost, and recovery cannot tell a delivered record from an undelivered
one. Retained record identities permit deduplication; they cannot guarantee
one attempt. PR 3 therefore depends on an identified delivery prerequisite,
contracted in its node-bound Weft issue and outside Loom:

1. **Durable pending delivery.** The composition root, not Loom, keeps a
   durable cursor: the highest journal position P such that, for every position
   up to and including P, the complete set of logical records derived from it
   has been acknowledged by the receiver. A position deriving no records is
   complete. Delivery may be concurrent or out of order, and one position may
   derive several records. An acknowledgement above a gap, or of only some of
   one position's records, is tracked durably per `(trace_id, record_id)` but never
   advances the cursor past the first incomplete position. Acknowledgement
   comes only from an acknowledging receiver result, such as the trace store's
   typed `upsert`/`upsertBatch` result; a fire-and-forget `emit` never
   advances the cursor or records an acknowledgement. After `recover()` and
   outside replay, a separate redelivery step redelivers every record above the
   cursor not durably tracked as acknowledged, using the envelopes from item 2.
   A redelivered record that was in fact acknowledged before a crash is a
   receiver no-op under item 3. It invokes only the sink: no gateway, host,
   effect, grant or scheduling change. Loom still reads no trace.
2. **Reconstructible envelopes.** Redelivery must send the complete original
   envelope byte for byte: trace id, emitter, record id, `sequence`,
   `parent_id`, links, evidence and every field. Retained lifecycle owners and
   record identities alone do not establish this. Today's emitter assigns
   `sequence` from mutable emission history
   (`packages/weave/src/weft.ts:117`) and `parent_id` from its current cycle
   record, so re-deriving only the records above the cursor with the active
   emitter would change them. The node-bound Weft issue's contract picks one of
   two mechanisms and states it: (i) the composition root durably stores the
   complete set of projection envelopes derived from a journal position in the
   same atomic commit as that position's journal append, and redelivers the
   stored envelopes. No committed position may lack any of its envelopes, so a
   crash after the append but before, or between, envelope writes cannot occur.
   Persisting envelopes after the append, even before the first delivery
   attempt, does not meet (i). If the journal and envelope store cannot commit
   atomically, (i) is unavailable and the contract uses (ii). Loom still neither
   reads nor writes envelopes; or (ii) a versioned deterministic
   projection re-derives each envelope from the committed journal prefix it
   needs (from position 0 if emitter state depends on it). Every input,
   including the original trace, emitter and sequence state, comes from that
   prefix and never from the recovering run's active emitter. Under (ii) the
   projection version is durably recorded with the cursor, and records above
   the cursor are re-derived under that recorded version, never a newer one.
3. **Receiver idempotency.** Receivers treat a repeated `(trace_id, record_id)`
   with byte-identical content as a no-op, and refuse unequal content under an
   existing identity as `conflict`, never ignoring it. The SQLite trace store's
   span upsert already refuses unequal `record_json` as `conflict`
   (`packages/weft/src/sqlite.ts:221`); its `INSERT OR IGNORE` covers only the
   `runs`/`threads` scope rows. Every other receiver PR 3 relies on must show
   the same property.
4. Until items 1–3 exist at the actual boundary, PR 3 may claim no duplicate
   logical record and no unequal identity reuse. It must not claim that no
   lifecycle record is lost, and it stays blocked on that evidence.

Include recovery after a **crash before and after each open/settle emission**,
with both windows. **Lost delivery:** crash after durable append but before
delivery; after recovery and redelivery the receiver holds exactly one logical
`opened` (or `closed`) record. **Repeated delivery:** crash after delivery but
before acknowledgement; redelivery repeats the attempt, and the receiver still
holds one logical record with byte-identical content. Count attempts and
distinct identities separately: two attempts for one identity pass, while two
identities for one lifecycle transition, or unequal content under one
identity, fail. Replay itself emits zero records. **Acknowledgement beyond a
gap:** a later journal position's records are acknowledged before an earlier
position's records are delivered, then the process crashes. The cursor stays
below the earlier position, and after recovery the earlier records are
delivered and the receiver holds each logical record once. **Partial
acknowledgement within one position:** a position deriving several records has
only some acknowledged before a crash. The cursor does not pass that position,
and redelivery completes the rest without a second identity. A mutation that
advances the cursor to the highest acknowledged position must fail both.
**Redelivery after a changed emitter:** deliver part of a committed prefix,
crash, and recover with a different active run/emitter and a different
in-memory sequence state. Every complete redelivered envelope (trace, emitter,
record id, `sequence`, `parent_id`, links, evidence and fields) is
byte-identical to its original attempt captured before the crash; a record
never attempted equals the envelope a crash-free run over the same committed
journal produces. A mutation that re-derives envelopes with the active emitter
must fail. **Crash between journal append and envelope persistence:** inject a
crash immediately after a position's journal append and before any of its
envelopes is persisted, and another between two envelopes derived from one
position. After recovery and redelivery the receiver holds every logical record
the committed journal derives, each once, with the original identity and
content: byte-identical to any attempt captured before the crash, otherwise
equal to a crash-free run over the same committed journal. Under (i) the
injected crash must leave either the position and all its envelopes committed
or neither; under (ii) both windows reduce to the lost-delivery case. A
mutation that redelivers only persisted envelopes, or persists envelopes after
a non-atomic append, must fail. Also keep one
project-level Thread node alive across two goals/runs, changing the active run/emitter
on recovery, with concurrent and out-of-order action arrivals from both runs.
Assert exactly one Weft opened and one `closed` transition **across the
whole projection**, aggregating pre-crash and recovered segments and both Weft
traces, not separately per trace/run; check the journal counts independently.
The emitter/run that records the Thread node's durable **opening observation** owns
its open projection; the emitter/run recording its terminal observation owns
its settle projection, even if different. Retain those recorded owners and
record identities across recovery; attaching a new run/emitter or starting an
action never reallocates lifecycle ownership or opens the Thread node again.
Cross-trace link rule (answered with Q8/Q11, section 7, under PR 1's `@2`
mapping): node lifecycle `opened` and `closed` require no link, so a
project-level Thread node opening in one goal's Weft trace and settling in
another needs no cross-trace target. `joined` and `superseded` exist under `@2`
only as `chain`-family action edges, with their `REQUIRED_LINK` rules. Only such
an edge whose target lies in another Weft trace (one Loom goal per Weft trace) is
not emitted; the Loom journal remains its evidence. Every action state record
and node lifecycle record is still emitted. Demonstrate in the two-goal case
that both goals' action state records are present and valid, that node
`closed` validates without a link, and that a constructed cross-trace dependency
omits only its `joined` edge. Never emit a cross-trace link or treat a prior
goal's record as a legal target.
Count distinct logical lifecycle identities across all delivery attempts,
before SQLite row coalescing as well as after intake: `INSERT OR IGNORE` on
`(run_id, thread_id)` cannot prove uniqueness. Validate that a mutation emitting
once per run, deriving a second identity on journal load, or redelivering with
unequal content fails. A repeated attempt with identical content passes. At the
actual durable integration boundary, demonstrate both crash windows above; if
that depends on #320 integration or the delivery prerequisite, keep PR 3 blocked
on its behavioral evidence. Replay never delivers records or invokes effects;
redelivery is a separate recovery step.
Under Q8 (a), action state and chain-edge records carry the owning node's
`thread_id` and do not enter the Weft node-lifecycle counts. A byte-preservation
check must reject mutation of historical `:thread:` ids or link targets.
Documentation alone needs no speculative mapper.

**Green:** mapping, derived-id budget/collision, emitter grammar/composition,
`@2` action-edge link, historical/new distinguishability and single-node-lifecycle
assertions pass under Q8 (a), Q9 (b) and PR 1's `@2` mapping. That covers
crashes in both delivery windows, acknowledgement beyond a gap, partial
acknowledgement within one position, byte-identical redelivery after a changed
emitter, concurrent arrival and goals/runs.
Run-scoped SQLite assertions (Q11 b) still pass, and original historical golden
records remain identical and valid. Historical `@1` join/handoff/supersession/
repeated cancel/recovery links keep their recorded targets; `@2` edges target
`chain`-family records. Run
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
Q13 (a): #329 owns the prose here that cites only PR 1/PR 2a's terminology,
exports and crosswalk; prose citing PR 2b nesting or PR 3 emission moves with
those slices. Q7: #330's owner, file and scope are unidentified in the
repository, so PR 4 holds only that prose until #330 names them; do not invent
them or assume implementation. Q7 blocks nothing else and does not gate #329.

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
`thread@1` as two concepts or allocate identities by Thread depth.

Known gap/dependency: [#320 §9.1, RT-00](docs/durable-recursive-threads.md#91-gap-found-a-queued-action-keeps-the-grant-it-was-queued-with)
records that a queued action retains its queue-time grant, which the new host
after restart refuses. The proposed grant-at-start fix is separate work, not a
property established by this rename or by #320's merge. Reads of queued or held
records never carry or mint a grant. Keep budget/effect holds as accounting; recovery must check current authority and issue a fresh grant only
at actual start. Any continuation/recovery guarantee relying on that fix is
blocked on RT-00's own demonstrated red/green evidence.

Each case below names its required deterministic evidence.

### Partial rename across packages

For PR 2a and every source/test rename or deletion, remove `packages/*/dist`
before build and verify (or use a fresh `npm ci` checkout with no prior output);
build scripts stay unchanged. After build and verify, require no
`dist/**/workstream*` artifacts before reporting green, using section 5's
artifact check independently of the legacy-name scan. Build and public consumer
compile checks reject stale imports or mismatched ownership keys; the link/name
check rejects stale contract paths. Writers implement the locked in-place
replacement into one `thread@1` family; no recorded schema is silently
repurposed. Preserve G import directions and local port declarations.

### One nestable kind at every Thread depth

Under Q10 (a)'s common field matrix and confirmed allocation/nesting rules, use
the same `thread@1` schema and bounded grammar/project-wide uniqueness at every
Thread depth. Thread depth N checks cover envelope ids and every derived Weft
record id/link target with maximum-length Thread node/emitter ids and
suffix/sequence; reject N+1. **Two goals' children with the same injected id are
refused** without mutation. Parent is the only stored edge, immutable after
open; children are derived. Refuse missing/cross-project parents, cycles,
reparenting and Thread depth overflow. Q12 (a1) records `max_depth` once on the
project index; PR 2b proves a second caller/goal cannot raise it (no per-call
argument exists), absent/invalid policy refuses, and replay preserves it. PR 2b
explicitly covers root Thread callers and child limit cases. Parentage is
distinct from dependencies/Weft links; nesting grants nothing.

### Concurrent sibling open

No append CAS exists. At #320 journal integration, the composition root
serializes the shared index commit boundary under exclusive single-writer
ownership and reconstructs the latest index from its reloaded committed snapshot
before validation/persist. Pure transition checks apply the second proposal to
the first commit's resulting index, with no expected-prefix input. Revalidation
refuses invalidated assumptions without mutation; valid stale proposals and
retries can succeed against that index. Two valid distinct siblings both
survive; parent semantic revision is unchanged. Duplicate ids, overcommitted
shares and stale parent state refuse atomically. Race opens against
cancel/settle in both orders; no lost children or dependency edges.

### Parent cancelled or settled with open children

Apply #320 §6.3–§6.4: cascade cancel requests to every open descendant, retain
identity/locks/late evidence, and refuse settlement leaving an open child
without a cancel request. Required open children block completion; optional
outstanding children receive cancellation on parent completion. Race child open
against parent cancel/settle in both orders; neither order permits an orphan.

### Crash between parent and child appends

At real journal integration, crash after parent open/before child-group append
and after child-group append/before acknowledgement. Replay yields the parent
alone or the complete child group plus dependency changes, never a partial fork
or child-list divergence. The parent link is immutable, children are derived,
retry uses recorded ids exactly once, and replay has zero effects/grants.

### Recorder evidence appears

Preserve evidence, stop and open a separate issue for compatibility and cutover
scope. Add no reader, migrator or dual-read path in this plan.

### Replay and grants (unconditional)

Replay invokes nothing, emits nothing and issues zero grants. Queued/held reads
carry or mint no grant. Single-use grants remain consumed after a crash and are
never re-presented. Recovery checks current authority; only actual start may
receive a fresh grant, subject to RT-00. Reservations are accounting, never
transferable grants.

### Parallel routing fails or is cancelled

Aborted/unavailable/stale site answers place no input and open no Thread. Q10
places the parallel target as a new root Thread (Thread depth 0, so within any
`max_depth`); its id must pass the Thread-only predicate from PR 2b. If a
parallel target id is invalid/duplicate or any subsequent step refuses, retain
the exact original index: no orphan target, partial input placement or process
transition. A model answer alone never grants or dispatches work.

### Interrupt correction races a pause/stop/completion

An interrupt requests pause at the next boundary, never a stop. Correcting one
of two interrupts retains the other's pending pause; an honoured pause stays
paused; terminal processes stay terminal; stale corrections refuse. Preserve
request evidence and resume digest through the rename.

### Concurrent independent Threads

Interleave two Threads' transitions and separate active goals; transitioning one
preserves the other's record, inputs, process and authority. Only one active
goal and live process per Thread. PR 2a and PR 2b both preserve that one goal
attaches once within a project, and a second attachment of G anywhere in the
project refuses `goal_attached`. How several child Threads relate to goal G is
Q14's open answer; until it is recorded, child Threads keep today's
own-`goals[]` behavior and no shared-goal assertion is made. Under every Q14
option, section 3's association reconstruction requirement applies; any rule on
whether later ancestor history can change an existing child's goal comes from
the chosen option's consequences.
Independent action execution remains concurrent; serialization of the shared
index commit boundary reserves no execution slots.

### Concurrent artifact updates

Preserve monotonic artifact revisions within a Thread; cross-Thread writes still
require canonical effect locks. Ownership/key renames do not expand a grant or
bypass stale read-set/resource checks.

### Old exported-name consumers

Exercise a fixture importing the public old names and one using the new names.
Q5: the atomic change updates all checked-in callers and documents the
source-breaking API change, and the old-name fixture must fail to compile. There
is no deprecated alias, duplicate state model or deep-import shim. Wire
compatibility and the source export policy remain separate decisions.

### Weft links across crash/concurrent arrival

- **Historical links:** old and new segments resolve the same ids, including
  forward targets, dependency joins, repeated cancels and supersession
  before/after recovery. Preserve historical action correlation as recorded
  evidence.
- **Owning node:** new spans point at their owning durable Thread node, at any
  Thread depth. A child span must not inherit its parent's id, and two actions
  on one Thread node share that Thread node id.
- **Versions and ids:** apply Q8 (a)/Q9 (b) and PR 1's exact `@2` mapping to new
  emissions. Distinguish historical `weft.record@1` action-correlated records
  from new `weft.record@2` node-bound records. Validate derived record ids/link
  targets within 128 and collision freedom across all Loom-derived families,
  under section 3's new-record identity contract (colon-free node-bound
  emitters, fixed family tags, `chain` family for action edges, composition
  emitter-prefix refusal).
- **Delivery:** exercise crash/recovery before/after open and settle emissions
  in both delivery windows: lost delivery (append, no delivery) and repeated
  delivery (delivery, no acknowledgement). Count distinct logical records, not
  delivery attempts. The cursor covers only a contiguous fully acknowledged
  prefix, and redelivered envelopes are byte-identical to the originals even
  after the active emitter changes. Replay emits zero records; redelivery is a
  separate recovery step that invokes only the sink. Without the durable
  pending-delivery prerequisite, no "no lost record" claim is made.
- **Lifecycle counts:** for one Thread node with zero/one/multiple actions
  spanning two goals/runs and concurrent/out-of-order arrivals, count exactly
  one node-lifecycle `thread.transition` with `transition=opened` and one with
  `transition=closed` across the whole Weft projection, not per trace.
  Separately count #320's Loom `thread.opened`/`thread.settled` observations
  once each in the journal; journal counts alone do not prove Weft uniqueness.
- **Cross-trace:** when open and settle occur in different Weft traces, node
  lifecycle records need no link. Only a `chain` edge whose required target lies
  in another trace is omitted; action state records are always emitted. `@2`
  `joined`/`superseded` edges without their required links reject. Validate
  each record within its own Weft trace, without cross-trace links.
- **Ownership and storage:** keep the opening/terminal observations' recorded
  emitter/run owners and record ids across restart. Count before SQLite
  coalescing so `INSERT OR IGNORE` cannot hide duplicate lifecycle identities.
  Q11 (b) keeps storage/OTel run-scoped; no cross-run correlation is claimed.
- **Sinks:** slow/throwing/reentrant sinks do not change scheduling, budgets or
  outcomes.

### Authority and disclosure

Opening, decoding, correcting or resuming creates no grant/approval/budget. Keep
the unconditional replay/single-use-grant invariants above; uncertain effects
are reconciled only under current authority. Reject credential-shaped ids, keep
raw input/provider errors out of records and keys out of argv/logs.

### Benchmark contamination

Keep intake choices/frozen corpus bytes and digests unchanged. Rename checks
must not rewrite historical evidence, inject guardrails or shuffles into
benchmark routes, or expose held-out cases. A future comparison requires
reserved independent adversarial/held-out cases and recorded data
provenance/license/destination plus sanitization or explicit authorization
before hosted disclosure.

Runtime and gateway remain provider-independent and pure: no environment,
filesystem, shell or ambient-clock access is introduced. Time and identity
allocation remain injected; persistence and any conversion stay at existing
composition/storage boundaries. Capability generation, admission and authority
to execute remain separate gates. A repeated review finding becomes a narrow
lint or behavioral regression test with known-red and green evidence; do not
relax permissions, validation or protected checks to pass it.

## 7. Owner questions (Q1–Q13 answered, Q14 open)

### Q1 — Answered: Thread identity family

D-ENG-017: one Thread kind keeps `thread@1`, `thread_id` and `thread.*`.
Project-level and goal-local Thread nodes occupy different Thread depths in one Thread tree, not competing owners.
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

D-ENG-017: the durable Thread node in the Thread tree that the span belongs to, not a
parallel workstream id. PR 1 records the current action-id/target-node crosswalk;
PR 3 proves Thread node binding, subject to its explicit runtime prerequisites.

### Q5 — Answered (D-ENG-021): public TypeScript export break policy

**Atomic rename, no deprecated aliases.** The workspace is private `0.0.0`, the
manifest exports only the package entry point, and every in-repository consumer
is updated in the same PR. No downstream consumer is named, so an alias would be
a speculative compatibility layer, which AGENTS.md forbids. PR 2a documents the
source-breaking change, its legacy-name scan allowlists no alias, and an
old-name consumer fixture must fail to compile. If a real downstream consumer
appears before PR 2a merges, that is new evidence for a separate decision; this
plan authorizes no aliasing path.

### Q6 — Answered (D-ENG-019): `intake.classify` labels and `running_threads[].thread_id`

**Labels/sets preserved; (a) ids point at Thread nodes.** The existing
`intake.classify` labels, shapes and frozen sets stay unchanged for this rename.
Live `IntakeState.running_threads[].thread_id` (`packages/weave/src/sites/index.ts`)
points at Thread nodes in this change, giving `thread_id` one meaning. Frozen
benchmark bytes and digests stay unchanged. The live disclosure switch needs
Thread node binding and its own red, so it ships with that binding, not PR 2a.
Node-bound ids change the live input distribution of the benchmarked site; the
separately scoped evaluation in Follow-ups is required before claiming its tuned
policy or thresholds valid there. That evaluation stays out of PR 2a/2b.

### Q7 — Answered (D-ENG-021): #330 document owner and scope

**Unidentified, PR 4 holds that prose only.** No #330 owner role, file path or
scope is named anywhere in the repository (`rg '#330'` finds no reference
outside this plan), and the issue text was not retrieved. No owner is invented.
PR 4 aligns #330's document only once #330 names its owner, file and reviewer.
Until then that prose alone waits; it does not gate PR 1, PR 2a or #329's
closure. #320's one-Thread glossary and normative alignment stay in PR 1.

### Q8 — Answered (D-ENG-018): new Weft `thread.transition` lifecycle semantics

**(a) Weft `thread.transition` is the Thread node lifecycle.** Each Thread node
emits exactly one `transition=opened` and one terminal `transition=closed`.
There is no Weft `settled` value; #320's settle outcome is a `weft.record@2`
field on the `closed` record. Per-action chain events move to the action subject
as `@2` `action.transition` records carrying the owning node's `thread_id`.
Action state records keep `state`; chain edges carry `edge` in the separate
`chain` id family, with `joins`/`supersedes`/`cancels` retargeted to `chain`
records. `REQUIRED_LINK` extends to `@2` action edges. PR 1 records that exact
mapping as a PR 3 prerequisite (section 5, PR 1; D-ENG-021 decides its encoding).
PR 3's red is **Thread node opened/settled exactly once regardless of action
count** (section 5).

Folded sub-question — cross-trace link rules (with Q11): node lifecycle `opened`
and `closed` require no link, so a Thread node that opens in one goal's Weft
trace and settles in another needs no cross-trace target. `joined`/`superseded`
exist under `@2` only as action chain edges with their `REQUIRED_LINK` rules.
Only such an edge whose target lies in another Weft trace is omitted, and the
Loom journal alone records it. Action state and node lifecycle records are
never omitted. No cross-trace link is ever emitted. This composes existing kinds
and link rules rather than adding a primitive.

### Q9 — Answered (D-ENG-020): Weft record version for node-bound emissions

**(b) New Weft record version, `weft.record@2`.** PR 1 quotes and supersedes
`WEFT-CONTRACT.md:33–36`: `@1` keeps the action-correlated meaning as historical
evidence; `@2` carries the node-bound `thread_id`, which may span goals within
one project. Gateway/Fabric records with null `thread_id` stay on `@1`. The
version lives in `schema`, already exported as `weft.schema` and stored in
SQLite's `schema` column, so readers need no inference from id spelling or
arrival time. OTel intake currently accepts only `@1`
(`packages/weft/src/sqlite-intake.ts:64,93`) and must accept `@2` in PR 3. The
version does not separate record ids: SQLite keys and OTel span ids ignore
`schema`. Collision freedom therefore comes from section 3's new-record identity
contract. That contract keeps the Thread-family layout, so N = 61 stands. PR 1 names, and PR 3
demonstrates, **Historical action-correlated and new node-bound records are
distinguishable**, including equal `thread_id` strings.

### Q10 — Answered (D-ENG-021): single `thread@1` field set, ids and placement (mechanical schema answers)

Q10 answers only the mechanical schema questions: field set, ids and placement.
The behavioral goal-association and goal-ending contract that an earlier
revision recorded here is now the open owner question Q14.

**Q10-0 — Answered: (a) PR 2a proceeds on the minimal renamed root Thread.**
Under field set (a) below, today's ten fields are exactly the required set and
every other field is optional. The renamed record is therefore a valid root
Thread, by construction, through the same decoder that accepts children.
Waiting for the full extension would hold a pure rename behind unrelated nesting
work. PR 1 records this guarantee; the Q10/Q12 extension may land in PR 1 or a
follow-up PR 1b, which must merge before PR 2b. No root-specific schema or
provisional decoder is authorized.

**Field set — Answered: (a) extend the renamed record uniformly.** Required at
every Thread depth: `schema, thread_id, project_id, origin, opened_at, revision,
goals, inputs, artifacts, process`. Optional at every Thread depth: `parent` and
#320's `purpose, completion, depends_on, share, deadline, lifecycle, cancel,
resume_point, results, evidence`, each with an explicit absence rule; absence
never fabricates a lifecycle, budget or grant. `goals[]` remains a Thread's own
goal history. #320's stored `goal_id` field is dropped, so the field set has no
second goal field; how a child Thread relates to its ancestors' goals is Q14.
The Q14 option that stores association explicitly does so through `goals[]`,
not through a new field. Option (b) is rejected: it
would force lifecycle fields onto every project-level Thread at open and push
PR 2a beyond a pure rename. Durable lifecycle semantics still need #320
behavioral evidence.

**Goal association and goal ending — moved to Q14 (open, Benjamin).** This
covers inherited ownership, fixed lifetime association, refusal of a second
attachment and when descendants block goal ending. These rules are observable
lifecycle policy that D-ENG-017–020 do not determine, so D-ENG-021 does not
decide them. Q10 fixes only that the field set has no second goal field and
that a root Thread's goal is its own active `goals[]` entry, as today.

**Per-goal root Thread placement — Answered: child of the project-level Thread.**
D-ENG-017 puts project-level and goal-local Threads "at different Thread depths
in one Thread tree"; a second parent-less per-goal root would split them into
separate trees. PR 1 amends #320 §5.1/Increment B: the goal's first Thread is a
child (Thread depth 1) of the project-level Thread on which G is active. Its
relation to G follows Q14. This is structural placement, not goal policy.
#320's "root thread" wording is replaced, so bare **root** still
means composition root and **root Thread** means parent-less. #320 §8's per-goal
depth limit counts from that goal's first Thread, alongside Q12's tree limit.

**Parallel route target placement — Answered: new root Thread.** `parallel`
means independent work. As a child of the source it would inherit the source's
cancel cascade and block its settlement, a behavior change that routing should
not imply. PR 2a and PR 2b keep today's flat placement: the target is a new root
Thread, so a project index may hold several Thread trees. The input's `target`
names that opened Thread, and Q12's limit is met trivially (Thread depth 0). Any
child placement for routed work needs its own #320 follow-up contract and red.

**Ids, budget and root tightening — Confirmed as proposed.** Replace #320 §5.1's
`<parent>/<opening seq>/<index>` goal-local scheme with injected opaque ids that
are unique project-wide, including settled Thread nodes; duplicates refuse
`duplicate_thread` atomically. Use the Thread-only predicate
`^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$` (N = 61, no `:`, `/` or `@`) with the
colon-free emitter grammar `^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$` (E = 32) for
node-bound Loom emitters (section 3, new-record identity contract); shared
`boundedId`, `correlation` and Weft `isId` stay unchanged. The tighter predicate applies to root Threads too,
including `new_thread_id` on the route path (today `new_workstream_id` under
`boundedId`: 128 characters, `:` allowed). Tightening is safe now because no
Thread records are persisted. It keeps one id rule at every Thread depth and
every derived record id injective. PR 2a keeps `boundedId` (pure rename); PR 2b
enforces the predicate at every Thread depth. `parent` is immutable and children
are derived.

### Q11 — Answered (D-ENG-021): Weft storage/OTel correlation across runs and traces

**(b) Keep SQLite and OTel run-scoped.** Cross-run storage correlation is out of
scope for this rename. Equal Thread node ids in two runs remain separate
`(run_id, thread_id)` rows (`packages/weft/src/sqlite.ts:90–95`; `INSERT OR
IGNORE` at `sqlite.ts:215`), and nothing claims a unified SQLite Thread. Weft is
a projection that replay never reads, so the Loom journal remains the only
cross-run authority; widening storage now would be a schema change with no
consumer. PR 3s does not exist. PR 3's lifecycle check still counts the
aggregate emitted projection across runs and traces. Any later cross-run
correlation needs its own contract and red, such as **Same Thread node across
two runs resolves to one Thread**.

### Q12 — Answered (D-ENG-021): replayable Thread depth limit and caller consistency

**(a1) `max_depth` is a project-index field.** Inject a positive safe integer at
`emptyThreadIndex(project_id, max_depth)`; ordered index keys become
`project_id`, `threads`, `max_depth`. One value then governs every Thread tree in
the index, including `parallel` roots, across goals, and replay preserves it.
(a2) is rejected: a root-only field has meaning only at Thread depth 0, which
conflicts with the one-decoder rule, and each root Thread could carry a
different limit. (b) is rejected: per-call arguments cannot enforce one
replayable policy. There is no per-call argument and no implicit default. PR 2b
owns the index constructor, the three test helpers, the live `openThread`
caller, the absent/invalid/at-limit/over-limit/replay/two-caller reds and the
**Thread depth limit** glossary definition. #320 §8's per-goal limits stay
separate.

### Q13 — Answered (D-ENG-021): #329 completion boundary versus nesting/emission follow-up

**(a) #329 closes after PR 1 + PR 2a + rename-only PR 4 prose.** #329's
acceptance is one meaning per term, verify green, import checks and unchanged
replay, which the pure rename meets. Nesting and node-bound emission depend on
#320 runtime binding; keeping them in #329 would hold the rename open on
unrelated integration. PR 2b moves to a new nesting issue and PR 3 to a new
node-bound Weft emission issue. Both are linked from #320, carry this plan's
red/green obligations unchanged, and name implementers/reviewers when opened.
The Q10/Q12 contract extension (PR 1 or PR 1b) and the Q8/Q9 crosswalk are
recorded under #329, so the follow-ups start from a locked contract. #330 prose
(Q7) does not gate closure. Pending Thread node binding stays explicit in the
crosswalk. Q14 does not gate closure either: if it is unanswered when #329
closes, its contract text moves with PR 2b's nesting issue.

### Q14 — Open (Benjamin): child-Thread goal association and goal ending

**Question.** When a Thread has child Threads, how do the children relate to the
goal active on an ancestor, and what happens when that goal ends while children
are still open? Today's `goal.attached` refuses `goal_attached` if any Thread in
the project already has that goal, so a goal attaches to exactly one Thread.
#320 assumes many goal-local Threads per goal and says "a thread never leaves its
goal". D-ENG-017–020 settle naming, ids and nesting, not this behavior. It is
observable lifecycle policy, so under D-ENG-021 it is Benjamin's call.

**Common to every option.** Root Threads behave as today: a root Thread's goal is
its own active `goals[]` entry. PR 1, PR 2a and rename-only PR 4 are unaffected,
and so are PR 2b's parent/id/depth checks. `parallel` targets stay root Threads
with their own goals. Explicit parent cancellation still cascades cancel
requests to open descendants (#320 §6.3–§6.4) under every option.

- **(a) Inherited, fixed at opening; ending is blocked by open children.** A
  child takes the nearest ancestor's active goal when it opens and keeps it for
  life. The association is derived, never stored (consequences below). A goal
  still attaches to one Thread. Attaching another
  goal to a Thread whose inherited goal is active refuses `goal_active`.
  `goal.ended` refuses while an open descendant inheriting that goal has no
  settlement or cancel request. _For users:_ every child reports the goal it
  works for. A goal cannot be marked ended while its child work is still open:
  the user (or caller) settles or cancels that work first, and nothing is
  cancelled implicitly.
- **(b) Inherited, fixed at opening; ending cascades.** Inheritance, its
  consequences and the attachment refusal are the same as (a). Instead of
  refusing, `goal.ended` succeeds and records a cancel request for every open
  inheriting descendant, with evidence retained, as a parent cancel does.
  _For users:_ ending a goal also stops its outstanding child work in one step,
  and a goal end is never stuck. In exchange, ending a goal can cancel work the
  user expected to finish, so a mistaken end costs more.
- **(c) Explicit shared attachment; no inheritance.** Each child that works for
  G attaches G itself through its own `goals[]`. The project-wide
  `goal_attached` refusal is relaxed to "once per Thread", which changes a
  behavior today's tests pin. Ending G on one Thread does not affect others; G
  counts as ended only when every Thread carrying it has ended it. Association
  is stored in each Thread's own `goals[]` (consequences below).
  _For users:_ each Thread's record shows its goal directly, with no lookup
  through ancestors. A child could carry a different goal from its parent, or
  none. Ending a goal becomes several separate actions, and "is G finished?" has
  to be answered across Threads.

**Conditional consequences of each option.** These follow from Benjamin's
answer and take effect only with it; D-ENG-021 locks none of them. Each is how
its option meets section 3's association reconstruction requirement, which is
the only locked part.

- **If (a) or (b):**
  1. _Selection at the committed opening prefix._ A child's goal is the active
     goal of the nearest ancestor (parent, grandparent, …) with an own active
     goal in the index committed immediately before its open transition. The
     lookup does not stop at Thread depth 1.
  2. _Lifetime immutability._ That association is fixed at opening; later
     ancestor history never changes it.
  3. _Evidence-order refusals._ PR 2b/2c adds two ancestry-scoped refusals
     (`invalid_evidence`, no mutation). (i) A child open whose evidence is below
     the highest `attached_at`/`ended_at` recorded on any ancestor refuses. (ii)
     An ancestor `goal.attached`/`goal.ended` whose evidence is at or below any
     existing descendant's `opened_at` refuses. With half-open goal intervals
     `[attached_at, ended_at)`, interval containment over the final index then
     equals the committed-prefix answer: an equal-seq attach-then-open
     inherits, an equal-seq end-then-open does not, and the reverse orders
     refuse. Backdated evidence is refused, never reinterpreted. Both refusals
     need an ancestor or a descendant, so root-only indexes are unaffected.
  4. _Red_ **Later parent history cannot change an existing child's goal
     association**. Open a child at evidence 12 under a parent with G attached
     at 10. Each of these then refuses `invalid_evidence` without mutation, with
     the evidence check running before the option's goal-ending rule: ending G
     at 11, attaching a goal on a grandparent at 5, and opening a second child
     at 9, which is below G's `attached_at`. Reconstruction of the final index
     and of every committed prefix gives the same association as the opening
     prefix, including a grandchild resolving through two ancestors. The
     equal-seq cases in item 3 behave as stated.
- **If (c):** association is each Thread's own `goals[]`, changed only by that
  Thread's own attach/end transitions, so reconstruction reads it directly as
  for root Threads. No ancestor selection, ancestry-scoped evidence-order
  refusal or "a stored association is immutable after open" rule is added.
  Whether a Thread's own attachment may change after opening is part of (c)'s
  answer, not of D-ENG-021.

**Recommendation: (a).** It matches #320's "a thread never leaves its goal" and
keeps today's one-attachment rule. It never cancels work implicitly, because
cancellation stays an explicit request that already cascades. It is the easiest
to relax later: moving to (b) only turns a refusal into a cascade, while going
from (c) back to inheritance would rewrite stored associations. Choose (b) if a
goal end should act as a stop signal for its child work.

**What the answer changes in this plan.** PR 1b, or the nesting issue's contract
PR, records the chosen option and its glossary term. PR 2b, or a PR 2c in the
same issue, adds that option's shared-goal, attachment and goal-ending reds, its
conditional consequences above and **Reconstruction reproduces the chosen goal
association** (section 5). Section 6's "Concurrent independent Threads"
case gains the option's shared-goal assertion. Nothing in PR 1, PR 2a or #329's
closure waits for this answer.

## Follow-ups

- **Review-round history:** keep external review paths, temporary plan-check
  results, local toolchain paths and repeated planning verify logs in the PR
  description or an issue comment, outside this normative plan. They establish
  no implementation red/green or clean-base result. Retain only PR 1's base-green
  precondition in section 5; do not expand rename scope to repair planning runners.
- **Live intake evaluation after Q6(a):** node-bound ids change the live input
  distribution. Before calling the site's accepted tuned policy/thresholds
  valid for that distribution, require a separately scoped evaluation plan with
  reserved independent adversarial/held-out cases and recorded provenance.
  Preserve frozen corpus bytes/digests; guardrails and shuffles must not leak
  into benchmark routes. Record licenses, exact destination and sanitization
  or explicit authorization before any future hosted disclosure. No benchmark
  or evaluation expansion belongs in PR 2a/2b.
- **Base verification failure:** if `npm ci && npm run verify` is red on the
  exact origin/main base in a clean, supported environment (Node >=22.18 with
  locked dependencies installed), open or link a separate issue with the base
  SHA, failing command/output and an owner, and obtain that owner's call before
  PR 1 starts. First distinguish runner/dependency faults from a real main red;
  neither is an accepted baseline. Record the actual owner and linked issue;
  do not invent either.
- **#320 durable integration and RT-00:** retain their separately scoped
  behavioral red/green requirements. Prove single-writer exclusion, atomic child
  groups and dependency changes, crash/replay with no duplicated or lost state,
  deduplicated recorded ids and zero replay effects/grants at the actual journal
  boundary. A future multi-writer requirement needs a separately contracted
  conditional-append capability and its own red; none exists today. Preserve
  the no-orphan and grant-at-start prerequisites. Single-use grants stay consumed
  across crashes and are never reused. This rename does not ship that integration.
