# WV-329: workstream → one nestable Thread kind (D-ENG-017)

Planning only. D-ENG-017 (Benjamin, 1 November 2026) locks one nestable
**Thread** kind at every Thread depth, retaining `thread@1`, `thread_id` and `thread.*`.
This plan prepares the atomic workstream → Thread rename into that family;
it changes no source, glossary, tests, schemas or recorded data. Owner questions
1–4 are answered; Q5–Q13 remain open in section 7, including Q10-0.

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
#330's exact document/scope remains an open owner question (Q7).

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
`workstream`. Q12(a1) proposes ordered index keys `project_id`, `threads`,
`max_depth` after the rename: `max_depth` is a new serialized index key and a
contract extension owned by PR 2b, pending the owner's answer, not a pure rename.
Q12(a2) instead proposes a field on the root Thread, subject to the common-decoder
check in Q12. Goal, input, and artifact entries retain ids, revisions and
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

| File                                               | Count | Classification                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GLOSSARY.md`                                      |    36 | Current Thread/Workstream distinction is superseded by D-ENG-017; fold it and the present #320 additions into one nestable Thread entry in PR 1. Intake labels and `running_threads[].thread_id` semantics await Q6.                                                                                                        |
| `docs/durable-recursive-threads.md`                |   160 | #320's proposed durable Thread contract; reconcile normative naming, id scope and nesting rules in PR 1, remaining explanatory prose in PR 4.                                                                                                                                                                               |
| `packages/weave/src/WORKSTREAM-CONTRACT.md`        |     8 | #26's quoted thread is already project-level; remaining comparisons explicitly distinguish the causal-chain Thread and Weft id from the workstream. Replace the distinction with D-ENG-017's single nestable kind.                                                                                                          |
| `packages/weave/src/sites/index.ts`                |     6 | `IntakeState.running_threads[].thread_id`, fixed intake question and `new_thread`/`continue_thread`: legacy task/causal-work vocabulary; no durable Thread tree integration yet. Q6 must resolve whether new disclosed ids point at Thread nodes or the field is renamed separately; frozen benchmark bytes stay unchanged. |
| `packages/weave/src/sites/CONTRACT.md`             |     1 | Same intake summaries.                                                                                                                                                                                                                                                                                                      |
| `packages/weave/test/p5.test.ts`                   |     5 | Intake summary shape and frozen choice vocabulary; no project Thread behavior.                                                                                                                                                                                                                                              |
| `packages/weave/test/p6.test.ts`                   |     1 | Empty intake `running_threads` fixture.                                                                                                                                                                                                                                                                                     |
| `packages/gateway/test/amos.test.ts`               |     8 | Intake choices, prompt and generic choice fixtures; no project Thread behavior.                                                                                                                                                                                                                                             |
| `docs/m7-decision-loop.md`                         |     5 | Intake question/options/summaries: legacy task vocabulary; storage `run/thread/...` description: causal Weft storage.                                                                                                                                                                                                       |
| `docs/execution-provider-contract.md`              |     3 | Boundary table lists Threads and workstreams separately: old Thread is causal. Independent Threads and X-T10 programs are execution-work units, not a wired project record; fold their descriptions into one Thread kind while preserving the action/process distinction.                                                   |
| `checks/fixtures/execution-provider/contract.mjs`  |     7 | `thread:a/b/c` labels for separate offered sets/worker progress; execution correlation ids, no `Thread` type or `workstream@1` shape. Keep values unless the fixture contract changes.                                                                                                                                      |
| `docs/research/monty-sandbox.md`                   |    18 | Explicit vocabulary note binds Thread work to #28's operating process: already the planned project-level sense. Two matches concern OS `threading`/threads and remain OS terms. Preserve historical evidence and qualify lifecycle statements when updating the note.                                                       |
| `docs/design-system.md`                            |     6 | Initial Threads/input-routing/pause scope exclusion: planned project-level work. Five other uses name the conversational component, not a durable Thread record.                                                                                                                                                            |
| `packages/tapestry/src/vocabulary.ts`              |     2 | `conversation.thread@1`: conversational presentation component, not the domain identity.                                                                                                                                                                                                                                    |
| `packages/tapestry/src/session.ts`                 |     1 | Same versioned component node.                                                                                                                                                                                                                                                                                              |
| `packages/tapestry/src/tree.ts`                    |     2 | Same component placement/reading.                                                                                                                                                                                                                                                                                           |
| `packages/tapestry/test/tree.test.ts`              |    10 | Same component identity/placement; no project Thread model.                                                                                                                                                                                                                                                                 |
| `packages/tapestry-web/src/host.tsx`               |     3 | Component renderer dispatch and `ConversationThread`; presentation only.                                                                                                                                                                                                                                                    |
| `packages/tapestry-web/src/paint/conversation.tsx` |     2 | Renderer name/test id; presentation only.                                                                                                                                                                                                                                                                                   |
| `docs/respan-routing-learnings.md`                 |     6 | External Respan conversation/cache affinity and a proposed thread+digest cache key; external correlation, not a durable Loom Thread id. Do not rewrite external `thread_identifier`.                                                                                                                                        |
| `packages/agentfabric/test/shell-run.test.ts`      |     1 | OS/main JS thread blocking comment.                                                                                                                                                                                                                                                                                         |

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
The unified field set is **open Q10**, not settled by D-ENG-017: today's
`origin, opened_at, revision, goals, inputs, artifacts, process` and #320 §5.1's
fixed `goal_id, purpose, completion, depends_on, share, deadline, lifecycle,
cancel, resume_point, results, evidence` must have one required/optional matrix
at every Thread depth. PR 1 must record the owner's answer, including how `goals[]`
and `goal_id` reconcile, before PR 2b. Today's `goal.attached` refuses
`goal_attached` if any Thread in the project index already has that goal id;
requiring every child of one goal to attach it would refuse the second child.
Q10 leaves that uniqueness scope versus inherited goal association open, together
with whether #320's per-goal root Thread is a child of the project-level Thread
or a second parent-less root Thread. Neither follows from the name lock.
Q10-0 asks whether PR 2a must also wait
for that full answer or may proceed after narrow owner confirmation that today's
renamed 10-field root Thread remains valid under every Q10 option. The minimal shape
must use the same decoder as children; no interim schema specific to root Threads is authorized.
Until the owner chooses, this sequencing gate remains unresolved.

**One id rule at every Thread depth.** #320 §5.1's `<parent>/<opening seq>/<index>`
and goal-only uniqueness conflict with Weft `isId` (`validate.ts:46`): `/` is
rejected, nesting grows ids beyond 128, and different goals can collide in the
project index and SQLite `threads(run_id, thread_id)` key. **Proposal for Q10
owner sign-off:** replace #320 §5.1's child id scheme with injected opaque ids
matching `^[A-Za-z0-9][A-Za-z0-9_.-]*$`, a subset of the existing Loom `boundedId`
and Weft `isId` languages, retaining their credential-shaped-id refusals. Use a
**Thread-specific id predicate** only for `thread_id`/`parent` and references
to Thread nodes, including `input-route.ts`'s injected `new_thread_id` path opening
a parallel target Thread. Its placement in the Thread tree remains open in Q10.
Leave shared `boundedId` and `correlation` unchanged, including their 128-character
bound and colon acceptance for goal, project, artifact, site/intake and
benchmark-route ids. Do not tighten Weft `isId`. No `:`, `/` or `@` in new Thread node
ids; the same bounded length applies at every Thread depth, independent of ancestry.
Identity allocation is injected and replay uses recorded ids; no ambient entropy
or parent/sequence concatenation. Proposed scope is **project-wide uniqueness**,
including settled Thread nodes across every goal; duplicate allocation refuses
atomically rather than overwriting or merging. SQLite currently keys Threads
and span foreign keys by `(run_id, thread_id)`; it does not enforce project-wide
identity or correlate a Thread node across runs. Q11 asks whether a separately owned
storage/OTel slice must add that correlation or leave storage run-scoped.
Do not infer a storage scope change from the proposed Loom id scope.
These replacements are proposals
for PR 1, not authority to override the merged #320 design without its owner.

**Derived Weft id budget (proposed contract extension).** Propose a node-length cap rather
than a digest-based record-id scheme. Let E be the maximum emitter-id length;
for the current `:thread:` format the safe cap is **N = 93 - E**:
`E + 8 + N + 11 + 16 <= 128` for
`${emitter_id}:thread:${node_id}:cancelled:${seq}`. The 16 digits cover
`Number.MAX_SAFE_INTEGER`; `:opened`, `:closed`, `:joined` and `:superseded`
are shorter. Recommend E = 32 and N = 61 for new node-bound emissions; an
unrestricted 128-character emitter leaves no usable Thread node budget. The proposed
Thread-only grammar is therefore `^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$` under that
budget, not 128-character Thread nodes. The PR recording the relevant Q8/Q9/Q10 answers
records their exact bounds and emission format; recompute N downward
before PR 2b if that format has a longer suffix or discriminator.
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

**Injective record ids.** For `${emitter_id}:thread:${node_id}:<transition>`,
excluding `:` from Thread node ids makes the boundary unambiguous even when an emitter
contains `:thread:`: strip the fixed transition/sequence suffix, then split at
the last `:thread:`. The two components are uniquely recoverable. The old
collision `(a, b:thread:c)` versus `(a:thread:b, c)` is prevented by refusing the
first Thread node id. PR 2b owns that grammar red; PR 3 owns the emitted-id/link-target
collision red across distinct valid emitter/Thread node pairs. Any Q8/Q9 format change
must preserve injectivity and revalidate the budget before PR 2b admits ids.
That argument covers only Thread records against each other. PR 3 must also
prove disjointness from every other Loom-derived family sharing `emitter_id:`:
`action:${action_id}:${state}`, `cycle:${cycle_no}:${trigger}`, `goal:${seq}`,
`judgment:${id}` and `outcome:goal:${seq}`. Fixed kind segments alone are not
proof when emitter ids contain `:`. Exercise cross-family collisions with
distinct emitters and valid action/judgment ids as well as Thread node ids under the
selected Q8/Q9 format; do not tighten shared validators to make them disjoint.

**Canonical nesting (Q10 proposal).** `parent` is the only stored structural
edge; children are derived by selecting Thread nodes whose `parent` names this Thread node,
never stored as a second source of truth. A root Thread omits `parent`; a leaf has no
derived children. `parent` is immutable after open; reparenting is forbidden.
Refuse missing or cross-project parents, self-parentage and cycles without a
partial transition. A root Thread has Thread depth 0; a child Thread has its
parent's Thread depth + 1. Propose an explicit positive safe-integer `max_depth`. A per-call child/group argument
alone cannot enforce one Thread tree limit: different callers can pass different
values, and the limit is absent from replayable state. Q12, alongside Q10,
asks the owner to choose its placement. Recommend injecting and recording it
once at project-index creation under Q12(a1), then deriving every child
admission's limit from that state across goal boundaries. That adds a serialized
index key, explicitly inventoried in section 1 and mapped in section 4.
Q12(a2)'s alternative field on the root Thread must be checked against the one
decoder at every Thread depth rule; no field or decoder may acquire different
meaning by Thread depth. If per-call arguments are kept,
they must be checked against the recorded Thread tree limit; PR 2b must refuse a
second opening that supplies a larger limit. Thread depth 0 for a root Thread is always bounded;
#320 §8's per-goal limits remain independently enforced. Record the answer and
boundary cases in the PR answering Q12; no implicit unbounded child default.
Define **Thread tree**, **root Thread**, **Thread node** and **Thread depth** inside PR 1's single
Thread glossary entry; add `max_depth` / Thread depth limit when its answer is recorded.

Language constraint: use those qualified forms for Thread structure; bare **root** still means **composition root**.
Keep Component tree, Default tree, Tapestry component nodes and context-declaration
depth in their existing glossary senses; do not repurpose them as Thread terms.
Immutable parent and limit placement still need explicit owner answers; they
are not mechanical consequences of the name lock.

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

| Existing unpersisted surface                                          | Locked target                                                                                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workstream@1`, `workstream_id`                                       | `thread@1`, `thread_id`, the one nestable Thread kind                                                                                                                  |
| `workstreams` index, `workstream` result/request, `new_workstream_id` | `threads`, `thread`, `new_thread_id`, referring to Thread nodes in that same Thread tree                                                                               |
| `operating.process@1` ownership                                       | Keep the schema version; rename its ownership key to `thread_id`                                                                                                       |
| `input.route@1`, `input.route.correction@1` ownership                 | Keep both schema versions; rename their ownership keys to `thread_id`                                                                                                  |
| Proposed #320 `thread.*` observations and durable fields              | Retain the existing Thread family; reconcile the common contract before implementation                                                                                 |
| Index ordered keys `project_id`, `workstreams`                        | PR 2a renames to `project_id`, `threads`; Q12(a1) separately proposes `project_id`, `threads`, `max_depth` in PR 2b, a new serialized index key pending owner approval |
| No recorded nesting limit                                             | Q12(a2) alternatively proposes a field on the root Thread; its field semantics must satisfy the common decoder at every Thread depth, pending owner approval           |

This is an atomic pre-persistence contract replacement, including nested process
records, routes, corrections, callers and fixtures. Remove active workstream
schema/vocabulary, not arbitrary opaque identifier values such as `ws-a`.
Never decode `thread@1` as two concepts. Add no speculative Thread @2 versions,
dual-read path, alias state model, journal or migrator. This lock covers the
unpersisted rename surfaces above; Q9 separately asks how new Weft emissions
remain distinguishable from recorded Weft evidence. The TypeScript export break
policy remains Q5, separate from this settled wire decision.

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
changes this stated scope. D-ENG-017 settles the field name and destination,
not the Weft envelope version or discriminator. Q9 asks the owner to choose
between documented discrimination under `weft.record@1` and a new record
version for new node-bound emissions; Q11 separately asks about storage/OTel
scope across runs/traces. PR 1 records the scope supersession and pending
questions explicitly; the PR recording each answer adds its chosen contract.
Preserving historical bytes alone is insufficient.

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
Q8 must resolve new lifecycle emission semantics and Q9 must resolve record
version/discrimination before dependent PR 3 work; Q11 gates any storage scope
change. The PR recording Q9's answer names the red check
**Historical action-correlated and new node-bound records are distinguishable**:
a reader must deterministically distinguish both even if their `thread_id`
strings are identical; do not infer meaning from id spelling or arrival time.
Exercise the selected discriminator/version through emission, validation, OTel
and SQLite intake without rewriting historical records. If a proposed v1
discriminator is not preserved there, it fails this check. PR 1 records the
pending questions without reopening the locked identity family. Gateway and
Fabric retain
locally declared ports and null ids when no Thread node binding exists.
Weft remains a projection: no trace reader feeds Loom, no imports reverse, and
nothing emitted grants authority or changes scheduling.

## 5. Smallest ordered PR slices and red-before-green evidence

Proposed review sequence, pending Q13's issue-scope answer:
**PR 1 → PR 2a → PR 2b → PR 3 → PR 4**. Dependencies are
**1 → 2a → 2b → 3** and **1 → 4**, plus **2a/2b/3 → 4** only where prose cites
final exports, nesting or emission. Independent inventory review, test-case
design and documentation work can proceed concurrently after PR 1. PR 3 may
also need explicitly identified #320 runtime integration; record that dependency
rather than add a parallel id. Every slice uses a branch from current
origin/main with its prerequisite PRs merged or explicitly carried. Q1–Q4 are
settled; only work depending on Q5–Q13 waits for those answers. Q13 asks whether
#329 closes after PR 1 + PR 2a (+ applicable PR 4 prose), moving PR 2b/PR 3 to
#320 or new issues; no split or extra closure requirement is decided here.
PR 2b's Thread node budget depends on Q8/Q9/Q10. Q10-0 below leaves the owner to decide
whether PR 2a waits for all of Q10 or proceeds on a minimal-field guarantee; if allowed,
separate PR 1's minimal contract from its remaining Q10 work as described below.
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
Keep Q8–Q10 proposals and Q11–Q13 choices explicitly pending. Record the common
field matrix/goal association, id allocation/bounds, canonical parent/children,
Thread depth policy (with Q12), latest-index revalidation and no-orphan contracts only
as their owner answers are recorded. Those contract extensions may follow the
minimal PR 1 under Q10-0; do not require all answers just to merge its settled
terminology/crosswalk. Behavioral enforcement stays in PR 2b/PR 3 and #320
integration; documentation assertions cannot establish those behaviors.
Record section 4's in-place ownership/schema mapping, leaving current source
names explicit until PR 2a. Include Weft's normative Thread node crosswalk immediately;
remaining emission/link alignment belongs to PR 3 and prose to PR 4. Record
Q8/Q9 owner answers before dependent Weft work and Q6's answer before changing
live intake id semantics. Quote and supersede Weft's no-widening clause; leave
the historical/new discriminator or version and storage scope explicitly open
until the PR recording each answer. Q10 gates PR 2b's
field/allocation contract; Q10-0 leaves PR 2a's sequencing for the owner to choose.
If the owner permits PR 2a first, split PR 1's minimal rename contract from its
Q10-dependent extension so the rename can proceed in parallel with remaining
Q10 work. No early PR 2a path exists without that narrow confirmation. None of
these questions reopens D-ENG-017.

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
never allowlist whole source/doc directories. Add assertions for each Q8/Q9/Q10 rule
**only in the PR recording that answer**, with the same discipline for new
Q11–Q13 answers. Do not preselect bounded ids, parent storage, finite Thread depth,
single-writer/latest-index rules, no-orphan rules or Q9 discrimination with a
text check. PR 2b/PR 3 tests provide behavioral evidence for approved rules.
This documentation red grants no permission to generate implementation code
before behavioral red.

**Green:** the single-kind terminology, shape and link checks pass together;
current behavior tests still pass unchanged. Run G and full verification. No
`VISION.md` edit: its acceptance boundary stays the same.

### PR 2a — Pure atomic Loom rename into the existing Thread family

Depends on the owner's Q10-0 sequencing answer: either wait for Q10's recorded
common field matrix admitting the minimal shape, or proceed on narrow explicit
confirmation that the renamed 10-field root Thread remains valid under every Q10
option. This plan selects neither path; otherwise revise the split before code.
Under the applicable PR 1 contract,
rename module/test/contract to `thread.ts`,
`thread.test.ts`, `THREAD-CONTRACT.md`; change public exports (subject to Q5),
imports, index/result/request properties, refusal names and callers together.
Replace `workstream@1` with `thread@1` and affected ownership keys with
`thread_id`, keeping process/route/correction @1 under the locked in-place
policy. Update repository-level `CONTRACT.md` and site links. This slice changes names only;
optional `parent`, new nesting validation and id-allocation behavior belong in
PR 2b. Keep shared `boundedId`/`correlation` unchanged. Preserve replay functions
and evidence; update unpersisted expectations without invented readers. Intake
labels/sets and live id meaning await Q6;
inference routing, capability admission, authority and component ids stay intact.

**Red before implementation:** a public-entry-point consumer using
`Thread`/`openThread` and the renamed shape must fail compilation or a shape
assertion against the old API. Pin the four affected schema surfaces and
ownership keys with renamed expectations; do not regenerate snapshots wholesale.
A whole-repository legacy-name scan must fail on a stale active API import and
on a stale repository-level `CONTRACT.md` schema/link. Its explicit allowlist covers only
reviewed historical evidence/quotes, this plan and any Q5-authorized temporary
export alias, never an entire source/doc directory. Inspect tracked/hidden files
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
options pending Q6. A rename regression is reviewed independently of nesting.

### PR 2b — Optional parent and deterministic nesting validation

Issue assignment is open Q13. Depends on green PR 2a, Q8/Q9's final emission
format/budget and Q10/Q12's owner-approved contract. Add its optional immutable
`parent` and derive children from it, with the same schema and id rule at every Thread depth.
Use injected opaque ids, project-wide duplicate refusal, Thread depth limits and
atomic validation against the latest index. No stored child list, reparenting,
second record kind or automatic process allocation. Introduce section 3's
Thread-specific id predicate here; apply N at every root Thread/child Thread admission
and parent reference, never by changing shared `boundedId`/`correlation`.
Cover latest-index revalidation/refusal/retry with pure transition interleavings;
durable serialization and append/settle/cancel wiring remain explicit #320 integration with their own
behavioral red. There is no journal CAS to exercise.

Under Q12(a1) (recommended), explicitly extend index creation with the new
serialized `max_depth` key and update all three test helpers and the live
`input-route.ts` caller; every child/group admission reads that recorded policy.
Under Q12(a2), explicitly update root Thread creation/callers and demonstrate
that its proposed field preserves one decoder and field meaning independent of Thread depth
for root Threads and child Threads. Neither placement is selected here. Under Q12(b),
child/group `max_depth` arguments must be compared to the selected recorded
policy; specify its source before implementation. Calls to `openThread` for root Threads in
the 8 record, 10 process and 15 routing tests and the live parallel target caller
(placement pending Q10) need no per-call limit if the recorded policy supplies it; constructor changes
must still be explicit. Add optional-parent/common-field assertions without
weakening existing behavior. Cover absent/invalid policy, exactly-at-limit and
over-limit child/group opens, replay preserving the limit, and a second caller
or goal being unable to raise it. Root Thread and child Thread decoding uses the same field
matrix. Do not smuggle these contract/call-site changes into PR 2a.

**Red before implementation:** nested openings against PR 2a must fail to retain
and validate `parent`. Reject missing/cross-project parents, self-parentage,
cycles, reparenting, duplicate ids and depth-limit overflow without changing the
original index. Add a separate red: **two child Threads share goal G under
Q10's recorded association rule**. With `parent` already supported, before
implementing the association rule, the second child must fail with
`goal_attached` from the current project-wide `goal.attached` uniqueness check,
or fail to inherit G if Q10 selects inheritance. Failure merely to retain
`parent` is not evidence for this red. Bind the setup and expected association
to Q10's recorded uniqueness/inheritance answer before implementation; this
test must not select that answer. Check duplicate attachments within the chosen
uniqueness scope and attachments outside that scope according to the recorded
answer, without presupposing refusal outside it.
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
Gate root Thread tightening on Q10's recorded answer to whether the tighter
Thread-only predicate applies to root Threads as well as children. If confirmed,
root Thread opens refuse ids longer than N; otherwise follow the owner's
recorded root-id rule and resolve the admission/emission budget contract before
dependent implementation. The live `input-route.ts` parallel target path checks
`new_thread_id` against the approved predicate for Q10's recorded target placement.
In every case, 62–128-character goal, project, artifact and intake/site ids remain accepted by
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
policy and input placement. Run narrow
Thread/route/process tests, Weft id validation from the Loom test boundary, G
and full verification. Do not import Weft into Loom source.
For an actual journal boundary, #320's atomic-child-append and no-orphan cases
in section 6 are required integration evidence before claiming durability.

### PR 3 — Weft owning-node mapping and causal links

Issue assignment is open Q13. Depends on PR 2b, Q8/Q9 owner answers, Q11's
storage-scope answer and any recorded #320 binding prerequisite.
PR 2b has already admitted only Thread nodes within the final N; this slice must not
tighten N after admission. Enforce E = 32 (or the owner-approved budget) in
Loom's emitter construction for node-bound emissions only, leaving shared Weft
`isId` and all historical emitter ids unchanged.
Expand PR 1's crosswalk through Weft mapping/link documentation and Loom
emission comments, and implement the owning-node mapping only after its runtime
binding has behavioral red. The destination is locked: each span's `thread_id`
is its durable Thread node in the same Thread tree. Record any #320 integration
prerequisite explicitly. Do not call retained action-id correlation completion
of this slice. Preserve historical JSON, OTel attributes, SQLite tables,
record-id segments and link targets as historical evidence. Implement new
emission semantics only under Q8/Q9's selected contracts; any cross-run storage/
OTel change requires Q11(a)'s separately contracted prerequisite slice PR 3s.
Under Q11(b), SQLite remains run-scoped and PR 3 claims no cross-run storage
correlation. Neither option is selected here. Preserving old fixtures
must not silently select how new action-chain transitions are represented.
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
emitter succeeds, E+1 refuses before any node-bound emission, and existing
Weft validation still accepts otherwise valid 33–128-character historical,
gateway/Fabric/external emitter ids, including `@` and `:`. No global validator
change or historical rejection may make this red pass.
Named red **Distinct emitter/Thread node pairs have distinct record ids and link targets**:
exercise emitters containing `:thread:` and different valid Thread node ids across
every transition/sequence suffix through emission, validation and SQLite link
resolution. Include cross-family comparisons against all Loom-derived
`action:${action_id}:${state}`, `cycle:${cycle_no}:${trigger}`, `goal:${seq}`,
`judgment:${id}` and `outcome:goal:${seq}` records in the same trace, with
distinct colon-bearing emitters and valid action/judgment ids. Fixed kind
segments alone do not establish disjointness. Reject any collision of unequal
logical records, including a Thread node record colliding with another family, without
changing shared validators. Include the former collision `(a, b:thread:c)` / `(a:thread:b, c)`:
the colon-bearing Thread node refuses; valid pairs round-trip to their unique
components under section 3's delimiter rule. Reject a mapper/grammar mutation
that admits the old ambiguity; any selected Q8/Q9 format must pass this red.
Repeat **Historical action-correlated and new node-bound records are distinguishable**
under Q9's selected version/discriminator, through validation and both intakes.
Named PR 3 red under either Q8 option: **Thread node opened/settled exactly once regardless of action count**.
At the Weft layer, count node-lifecycle `thread.transition` records: one with
`transition=opened` and one with Q8's selected terminal value (`transition=closed`,
or an explicitly contracted replacement); there is no Weft `settled` value today.
A zero-, one- and two-action Thread node must each satisfy those counts. Under Q8(b),
the recorded contract must distinguish per-action evidence from the counted
node-lifecycle records; counting only Loom observations cannot satisfy this red.
#320's Loom `thread.opened` and `thread.settled` observations are counted separately in the journal:
one opening and one terminal observation per Thread node, regardless of action count.
Include recovery after a **crash before and after each open/settle emission**,
including after durable append but before delivery and after delivery but before
acknowledgement. Replay emits zero new lifecycle records. Also keep one
project-level Thread node alive across two goals/runs, changing the active run/emitter
on recovery, with concurrent and out-of-order action arrivals from both runs.
Assert exactly one Weft opened and one selected terminal transition **across the
whole projection**, aggregating pre-crash and recovered segments and both Weft
traces, not separately per trace/run; check the journal counts independently.
The emitter/run that records the Thread node's durable **opening observation** owns
its open projection; the emitter/run recording its terminal observation owns
its settle projection, even if different. Retain those recorded owners and
record identities across recovery; attaching a new run/emitter or starting an
action never reallocates lifecycle ownership or opens the Thread node again.
The PR recording the Q8/Q11 answers must specify how terminal and joined
transitions satisfy their selected contract's `REQUIRED_LINK` and link-target
resolution rules when opening and settlement occur in different Weft traces
(one Loom goal per Weft trace). Today `REQUIRED_LINK` requires `joins` for
`joined` and `supersedes` for `superseded`, not a link for `closed`; any replacement
terminal value needs an explicit link rule. Identify valid targets within each
record's own Weft trace and demonstrate terminal/join validation and intake in
that two-goal case. Do not invent cross-trace links or assume a prior goal's
opening record is a legal target; unresolved link semantics block dependent
emission work. Q11 decides storage/OTel correlation separately.
Count lifecycle records before SQLite row coalescing as well as after intake:
`INSERT OR IGNORE` on `(run_id, thread_id)` cannot prove uniqueness. Validate
that a mutation emitting once per run or re-emitting on journal load fails.
At the actual durable integration boundary, demonstrate no lost lifecycle
state and deduplicated record identities through these crash windows; if that
depends on #320 integration, keep PR 3 blocked on its behavioral evidence.
Replay never delivers missing records or invokes effects; recovery is separate.
Under Q8(a), action-chain events use the action subject and do not enter the
Weft node-lifecycle counts. Under Q8(b), explicitly distinguish any per-action
transition evidence and prove it neither opens nor settles the Thread node again, per
the owner's recorded rationale. A byte-preservation check must reject mutation
of historical `:thread:` ids or link targets. Documentation alone needs no speculative mapper.

**Green:** mapping, derived-id budget/collision, historical/new distinguishability
and single-node-lifecycle assertions across crashes, concurrent arrival and
goals/runs pass under the recorded Q8/Q9 answers; Q11's selected storage-scope
assertions pass in their owning slice;
original historical golden records remain identical and valid. Join/handoff/
supersession/repeated cancel/recovery links retain their recorded targets. Run
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
`thread@1` as two concepts or allocate identities by Thread depth.

Known gap/dependency: [#320 §9.1, RT-00](docs/durable-recursive-threads.md#91-gap-found-a-queued-action-keeps-the-grant-it-was-queued-with)
records that a queued action retains its queue-time grant, which the new host
after restart refuses. The proposed grant-at-start fix is separate work, not a
property established by this rename or by #320's merge. Reads of queued or held
records never carry or mint a grant. Keep budget/effect holds as accounting; recovery must check current authority and issue a fresh grant only
at actual start. Any continuation/recovery guarantee relying on that fix is
blocked on RT-00's own demonstrated red/green evidence.

| Case                                               | Required deterministic evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partial rename across packages                     | For PR 2a and every source/test rename or deletion, remove `packages/*/dist` before build and verify (or use a fresh `npm ci` checkout with no prior output); build scripts stay unchanged. After build and verify, require no `dist/**/workstream*` artifacts before reporting green, using section 5's artifact check independently of the legacy-name scan. Build and public consumer compile checks reject stale imports or mismatched ownership keys; link/name check rejects stale contract paths. Writers implement the locked in-place replacement into one `thread@1` family; no recorded schema is silently repurposed. Preserve G import directions and local port declarations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| One nestable kind at every Thread depth            | Under Q10's approved common field matrix and allocation/nesting proposals, same `thread@1` schema and bounded grammar/project-wide uniqueness at every Thread depth. Thread depth N checks cover envelope ids and every derived Weft record id/link target with maximum-length Thread node/emitter ids and suffix/sequence; reject N+1. **Two goals' children with the same injected id are refused** without mutation. Parent is the only stored edge, immutable after open; children are derived. Refuse missing/cross-project parents, cycles, reparenting and Thread depth overflow. Q12 chooses recorded Thread depth policy and input placement; PR 2b proves a second caller/goal cannot raise the recorded Thread tree limit, and replay preserves it. If child/group arguments are retained, absent/invalid or larger-than-recorded limits refuse. PR 2b explicitly covers root Thread callers and child limit cases. Parentage is distinct from dependencies/Weft links; nesting grants nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Concurrent sibling open                            | No append CAS exists. At #320 journal integration, composition root serializes the shared index commit boundary under exclusive single-writer ownership and reconstructs the latest index from its reloaded committed snapshot before validation/persist. Pure transition checks apply the second proposal to the first commit's resulting index, with no expected-prefix input. Revalidation refuses invalidated assumptions without mutation; valid stale proposals and retries can succeed against that index. Two valid distinct siblings both survive; parent semantic revision is unchanged. Duplicate ids, overcommitted shares and stale parent state refuse atomically. Race opens against cancel/settle in both orders; no lost children or dependency edges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Parent cancelled or settled with open children     | Apply #320 §6.3–§6.4: cascade cancel requests to every open descendant, retain identity/locks/late evidence, refuse settlement leaving an open child without a cancel request. Required open children block completion; optional outstanding children receive cancellation on parent completion. Race child open against parent cancel/settle in both orders; neither order permits an orphan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Crash between parent and child appends             | At real journal integration, crash after parent open/before child-group append and after child-group append/before acknowledgement. Replay yields the parent alone or the complete child group plus dependency changes, never a partial fork or child-list divergence. Parent link is immutable, children are derived, retry uses recorded ids exactly once, and replay has zero effects/grants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Recorder evidence appears                          | Preserve evidence, stop and open a separate issue for compatibility and cutover scope. Add no reader, migrator or dual-read path in this plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Replay and grants (unconditional)                  | Replay invokes nothing, emits nothing and issues zero grants. Queued/held reads carry or mint no grant. Single-use grants remain consumed after a crash and are never re-presented. Recovery checks current authority; only actual start may receive a fresh grant, subject to RT-00. Reservations are accounting, never transferable grants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Parallel routing fails or is cancelled             | Aborted/unavailable/stale site answers place no input and open no Thread. Q10 leaves parallel target placement open: a new root Thread or a child of the source Thread? Apply Q12's depth limit and no-orphan checks to the owner's selected placement. If a parallel target id is invalid/duplicate or any subsequent step refuses, retain the exact original index: no orphan target, partial input placement or process transition. A model answer alone never grants or dispatches work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Interrupt correction races a pause/stop/completion | An interrupt requests pause at the next boundary, never a stop. Correcting one of two interrupts retains the other's pending pause; an honoured pause stays paused; terminal processes stay terminal; stale corrections refuse. Preserve request evidence and resume digest through the rename.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Concurrent independent Threads                     | Interleave two Threads' transitions and separate active goals; transitioning one preserves the other's record, inputs, process and authority. Only one active goal and live process per Thread. PR 2a preserves today's one goal attaches once within a project; PR 2b's uniqueness scope versus inherited association remains open in Q10. Two child Threads of one goal must open without `goal_attached`, while a second unrelated Thread attaching an already-attached goal is still refused, under the owner's recorded association contract. Independent action execution remains concurrent; serialization of the shared index commit boundary reserves no execution slots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Concurrent artifact updates                        | Preserve monotonic artifact revisions within a Thread; cross-Thread writes still require canonical effect locks. Ownership/key renames do not expand a grant or bypass stale read-set/resource checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Old exported-name consumers                        | Exercise a fixture importing the public old names and one using the new names. Preferred atomic change updates all checked-in callers and documents the source-breaking API change. If the owner requires a temporary deprecated alias, it must be one identity/implementation with a removal boundary and compile/behavior tests; no duplicate state model or unsupported deep-import shim. Wire compatibility and the source export policy remain separate decisions (Q5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Weft links across crash/concurrent arrival         | Old segments and new segments resolve the same ids, including forward targets, dependency joins, repeated cancels and supersession before/after recovery. New spans point at their owning durable Thread node, at any Thread depth; a child span must not inherit its parent's id, and two actions on one Thread node share that Thread node id. Preserve historical action correlation as recorded evidence; apply Q8/Q9's recorded contracts to new emissions, distinguish historical action-correlated records from new node-bound records, and validate derived record ids/link targets within 128 and collision freedom across all Loom-derived families. Exercise crash/recovery before/after open and settle emissions, including append/delivery/acknowledgement windows; replay emits zero new lifecycle records. For one Thread node with zero/one/multiple actions spanning two goals/runs and concurrent/out-of-order arrivals, count exactly one node-lifecycle `thread.transition` with `transition=opened` and one with Q8's selected terminal value (`transition=closed` or a contracted replacement) across the whole Weft projection, not per trace. Separately count #320's Loom `thread.opened`/`thread.settled` observations once each in the journal; journal counts alone do not prove Weft uniqueness. The PR recording Q8/Q11 must specify terminal/join `REQUIRED_LINK` compliance and valid targets when open and settle occur in different Weft traces; validate each record within its own Weft trace, without cross-trace links. Keep the opening/terminal observations' recorded emitter/run owners and record ids across restart; count before SQLite coalescing so `INSERT OR IGNORE` cannot hide duplicate lifecycle records. Q11 separately decides cross-run storage/OTel correlation and its own red. Slow/throwing/reentrant sinks do not change scheduling, budgets or outcomes. |
| Authority and disclosure                           | Opening, decoding, correcting or resuming creates no grant/approval/budget. Keep unconditional replay/single-use-grant invariants above; uncertain effects are reconciled only under current authority. Reject credential-shaped ids, keep raw input/provider errors out of records and keys out of argv/logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Benchmark contamination                            | Keep intake choices/frozen corpus bytes and digests unchanged. Rename checks must not rewrite historical evidence, inject guardrails or shuffles into benchmark routes, or expose held-out cases. A future comparison requires reserved independent adversarial/held-out cases and recorded data provenance/license/destination plus sanitization or explicit authorization before hosted disclosure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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

- **(a) Point at Thread nodes** in the one durable Thread tree; define the binding and
  its red before changing live disclosures. **Recommendation: (a)**, consistent
  with D-ENG-017's single meaning of `thread_id`.
- **(b) Rename the legacy action/task correlation field in a separately scoped
  change**, with its own contract/red, rather than retain another live meaning
  of `thread_id` indefinitely.

Owner choice remains open; this plan does not silently select either option.
**Frozen benchmark bytes and digests stay unchanged either way**; any live
mapping is separate from those historical inputs. Option (a) changes the live
input distribution of the benchmarked `intake.classify` decision site; historical
tuning cannot establish validity on node-bound ids. The separately scoped
evaluation plan in Follow-ups is required before claiming its tuned policy or
thresholds valid there. Keep that evaluation out of PR 2a/2b. Dependent live
intake work waits for the answer.

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
#320's Loom `thread.opened`/`thread.settled` journal observations. Weft uses
`thread.transition` with opened/joined/superseded/cancelled/closed values, not
`thread.settled`. Which new-emission contract, including its terminal transition
value (`closed` or an explicitly contracted replacement), should
the PR recording the answer establish for PR 3?

- **(a) Make Weft `thread.transition` a Thread node lifecycle projection**, and move
  per-action chain events to the action subject. **Recommendation: (a)**, which
  gives the one Thread kind one lifecycle and keeps action attempts explicit.
- **(b) Keep per-action transitions under the Thread node id**, with an explicit owner
  rationale and contract explaining why they are action evidence rather than a
  second Thread kind/lifecycle, and how consumers distinguish Thread node events.

This is an open owner decision about new emissions; historical bytes remain
unchanged. PR 3's red under either choice is **Thread node opened/settled exactly once regardless of action count**
(section 5), covering zero, one and multiple actions, crash/recovery at each
open/settle emission boundary, zero replay emissions and one Thread node across two
goals/runs with concurrent arrival. Count Weft node-lifecycle `thread.transition`
records once with `transition=opened` and once with the selected terminal value
(`transition=closed` or a contracted replacement), across the whole projection,
retaining recorded lifecycle owners rather than counting once per trace.
Separately count #320's Loom `thread.opened`/`thread.settled` journal observations;
those counts cannot substitute for Weft record counts. Under (b), how are the
counted node-lifecycle records distinguished from per-action evidence?
The PR recording Q8/Q11 must also answer: how do terminal/join transitions meet
`REQUIRED_LINK` and target-resolution rules when opening and settlement occur
in different Weft traces? Identify same-trace targets or explicitly contract
changed requirements under Q9; do not invent cross-trace links or assume one
goal's opening record can be linked from another. Current `closed` has no required
link, while `joined` requires `joins` and `superseded` requires `supersedes`.
Keep dependent link/emission work blocked until those semantics are recorded.
Q5–Q13 remain open, including Q10-0. Q8 blocks PR 2b's final
node-id budget and dependent lifecycle emission work until answered; it does
not itself block the pure rename. PR 2a's Q10 sequencing remains Q10-0.

### Q9 — Open: Weft record version or discriminator for node-bound emissions

PR 1 must quote and explicitly supersede the no-widening clause in section 4.
With that scope change, should new node-bound emissions:

- **(a) Stay on `weft.record@1` with a documented discriminator**, such as an
  emitter version or a node-lifecycle subject, with exact presence, validation
  and transport/storage rules. **Recommendation: (a)** only if the discriminator
  survives every relevant record kind, OTel export and SQLite intake and gives
  deterministic reader separation; a convention outside the record is insufficient.
- **(b) Use a new Weft record version**, with an explicit contract for new
  emissions and historical v1 evidence, if v1 cannot provide reliable separation.

Owner choice is open; do not choose a discriminator or version implicitly.
This question concerns the Weft envelope, not a second Thread schema or a
reopening of the locked rename. The PR recording Q9's answer names, and PR 3
must demonstrate, the red
**Historical action-correlated and new node-bound records are distinguishable**,
including equal `thread_id` strings. Q9 gates PR 2b's final node-id budget and
dependent emission/reader work; no historical byte rewrite or speculative
migration is authorized.

### Q10 — Open: single `thread@1` field set and #320 contract replacements

**Q10-0 — Open: may PR 2a proceed before the full Q10 answer?**

Should PR 2a wait for the full Q10 field matrix, or may the minimal rename ship
first? Narrow owner question: **is today's renamed 10-field record a valid root Thread
under every Q10 option**, through the same decoder that will accept children?

- **(a) Confirm that minimal root Thread first. Recommendation: (a).** Gate PR 2a only
  on this narrow field guarantee (plus its other prerequisites, including Q5),
  split PR 1's minimal contract accordingly, and let PR 2a proceed in parallel
  with remaining Q10 work. The guarantee constrains the eventual Q10 answer;
  it authorizes no separate schema specific to root Threads or provisional decoder.
- **(b) Wait for the complete Q10 answer.** Keep PR 2a behind the full matrix;
  re-slice with the owner if it requires more than a pure rename.

No answer is recorded here and neither path is selected. PR 2b still waits for
the full Q10 contract and Q8/Q9's final budget under either choice.
Q5–Q13 remain open, including Q10-0; this sub-question does not replace or answer
any of them.

Confirm the proposed common shape and allocation/nesting rules, or choose a
uniform alternative before its contract extension and dependent implementation:

- **(a) Extend the renamed record uniformly at every Thread depth. Recommendation: (a).**
  Keep required `schema, thread_id, project_id, origin, opened_at, revision,
  goals, inputs, artifacts, process` on all Thread nodes. Make `parent` optional and
  children derived. Should `goals[]` be the sole goal association/history at every
  Thread depth, deriving the active goal rather than storing #320's fixed `goal_id`,
  with attachment uniqueness or inherited association as asked below?
  Specify `purpose, completion, depends_on, share, deadline, lifecycle, cancel,
  resume_point, results, evidence` as common optional fields with explicit
  absence/default and validation rules, independent of Thread depth. Absence must not
  fabricate a lifecycle or grant. Confirm that PR 2a's minimal renamed record
  is accepted by this same decoder; PR 2b adds parent validation, and durable
  lifecycle semantics still need separate #320 behavioral evidence.
- **(b) Require a uniform full record at every Thread depth**, giving every Thread node the
  same explicit empty/null values and lifecycle fields at open, with a common
  optional current `goal_id` reconciled with `goals[]` history. The owner must
  specify the authoritative relation and terminal/goal-change semantics, and
  re-slice PR 2a if those obligations exceed a pure rename. No decoder
  split by Thread depth, duplicate goal authority or second schema is allowed.

Under either field-set option, these remain open owner questions:

- **Goal association and attachment uniqueness — Open:** Is project-wide
  `goal_attached` uniqueness kept as it is, scoped to the Thread tree or one
  parent, or do child Threads inherit their goal association from an ancestor
  without attaching it? Today's `transitionWorkstream` `goal.attached` checks
  the whole project index; #320 fixes a `goal_id` on every Thread. Requiring
  every child of goal G to attach G would refuse the second child. The owner
  must specify how the chosen option lets multiple children share one goal,
  define any attachment uniqueness scope, and state which duplicate attachments
  are refused within it and which attachments are allowed outside it;
  section 6's current invariant alone does not resolve this conflict.
- **Per-goal root Thread placement — Open:** Is #320's per-goal root Thread a
  child of the project-level Thread, or a second parent-less root? #320 §5.1
  and Increment B specify a root Thread per goal with parent null, whereas the
  renamed project-level Thread is already parent-less. Does the owner amend
  #320's goal-root placement or allow another root Thread in the project index,
  with Q12's depth policy and the same decoder applying to both?
- **Parallel route target placement — Open:** When `parallel` opens work from
  an existing Thread, is its target a new root Thread (today's flat placement),
  or a child of the source Thread? Which placement should PR 2b
  enforce, or should PR 2a/2b preserve root placement as a no-behaviour-change
  rename and leave child placement to #320 follow-up work? PR 2a preserves
  existing flat behavior; PR 2b's placement and any follow-up boundary remain
  undecided. Record the answer before dependent Q12 depth-limit and no-orphan
  checks; the input's `target` must name the opened Thread under every option.

No goal-association, per-goal root Thread or parallel-placement option is selected.
The common field matrix must incorporate these answers before PR 2b.

Also explicitly confirm or amend section 3's proposals: replace #320 §5.1's
`<parent>/<opening seq>/<index>`/goal-only scheme with injected opaque ids unique
project-wide (including settled Thread nodes); cap Thread node/emitter lengths for derived
Weft record ids (recommended N = 61, E = 32 for the shown format, with final
Q8/Q9 choices fixed before PR 2b); exclude `:` from Thread node ids to keep derived
record ids injective, using a Thread-only predicate with shared validators
unchanged. This also tightens today's root Thread acceptance on the route `new_thread_id` path,
currently handled as `new_workstream_id` by `boundedId`: from 128 characters with `:` allowed
to N characters without `:` (recommended N = 61). Does the owner confirm that
tighter Thread-only predicate for root Threads as well as children?
Keep parent immutable and children derived. Q12 explicitly asks where the
positive finite `max_depth` is recorded and checked: child-only arguments cannot
alone enforce uniform replayable policy. Recommend Q12(a1)'s project-index field,
a new serialized key inventoried in section 1 and mapped in section 4.
Q12(a2)'s field on the root Thread must satisfy the same decoder and field
meaning at every Thread depth; no depth-selected decoder is authorized.
Keeping child/group arguments requires comparison to the recorded limit and
a refusal red for a larger second argument. An alternative allocation may use a bounded
deterministic scheme that passes both validators, preserves project-wide
uniqueness and fits every derived record/link id. The PR recording each answer
must document its chosen scheme and glossary terms. These are open owner-level
choices, not consequences of D-ENG-017. Q10 blocks the common field/allocation
contract and dependent code;
Q10-0 leaves PR 2a's sequencing open. Q1–Q4 stay answered; Q5–Q13 remain open.

### Q11 — Open: Weft storage/OTel correlation across runs and traces

Must Weft v1 storage and OTel correlate one project-wide Thread node across runs/traces?
Q9 decides envelope discrimination, not this storage scope. Under either option,
the PR recording Q8/Q11 must answer how terminal/join transitions meet their
`REQUIRED_LINK` and target-resolution requirements when the Thread node opens
and settles in different Weft traces, as specified in PR 3. Cross-run correlation
cannot authorize cross-trace links or substitute for that contract. Today SQLite
`threads` has primary key `(run_id, thread_id)` and spans have a per-run foreign
key (`packages/weft/src/sqlite.ts:90–95`); insertion uses `INSERT OR IGNORE`
(`sqlite.ts:215`). Equal Thread node ids in two runs currently produce unrelated rows.

- **(a) Require cross-run correlation.** Assign a separately contracted slice
  **PR 3s — Weft cross-run storage/OTel scope**, prerequisite to PR 3's claim of
  cross-run correlation. It owns the storage/query and OTel transport contract,
  compatibility with historical run-scoped data, and a demonstrated red:
  **Same Thread node across two runs resolves to one Thread**. Exercise direct and
  OTel intake with two runs/traces, links within their recorded trace scopes,
  reopen/recovery and distinct Thread nodes that must not merge. Name its implementer
  and reviewer before work; no schema change is silently assigned to PR 2a.
- **(b) Keep SQLite run-scoped for this rename. Recommendation: (b).** Record
  explicitly that cross-run storage/OTel correlation is out of scope and that
  equal ids alone do not yield a unified SQLite Thread. Any later correlation
  requires a separately scoped contract and red. PR 3's lifecycle check still
  counts the aggregate emitted projection across runs; it cannot claim a
  unified storage row from that check or relax D-ENG-017's owning-node binding.

No option is selected. PR 3s exists only if (a) is chosen; Q13 decides whether
it and PR 3 belong to #329 or separately owned follow-up issues. Until this
answer, keep storage-scope claims pending; do not add a schema or widen OTel.

### Q12 — Open: replayable Thread depth limit and caller consistency

Where should Q10's finite `max_depth` policy live? A child-only per-call
argument leaves callers free to choose different limits and records no uniform
Thread tree policy for replay. Trusting the composition root alone cannot enforce
the proposed cross-goal invariant.

- **(a1) Record the limit once in a project-index field. Recommendation: (a1).**
  Inject a positive safe integer at index creation and retain it in replayable
  state. This adds `max_depth`, a new serialized index key, with proposed ordered
  keys `project_id`, `threads`, `max_depth` (section 1 inventory, section 4 mapping).
  It is a PR 2b contract extension beyond PR 2a's index-key rename. Record its
  validation and affected constructor/callers; every child/group admission derives
  the same Thread tree limit across goals.
- **(a2) Record the limit in a field on the root Thread.** Does a field used only
  at Thread depth 0 satisfy the one decoder at every Thread depth rule and
  Q10-0's guarantee that the same decoder accepts children? Explain how its field
  meaning and validation remain independent of Thread depth, without an interim schema
  specific to root Threads or selecting a decoder by Thread depth. Record that
  resolution and the exact field/creation/caller changes before dependent work;
  this plan does not assume the conflict is resolved.
- **(b) Retain explicit child/group `max_depth` arguments**, checked against a
  once-recorded Thread tree limit. PR 2b must demonstrate red when a second caller
  supplies a larger limit, and refuse it without mutation. Specify the source
  of that recorded policy (including the placement decision above) and comparison
  rules; per-call arguments alone are insufficient.

No option is selected; Q10's field/allocation answer remains open and must
incorporate this answer. Under every option, PR 2b owns replay and two-caller/
two-goal consistency tests, index, root Thread and child Thread caller changes,
and the Thread depth limit glossary definition. Q13 separately decides the
issue owning PR 2b.

### Q13 — Open: #329 completion boundary versus nesting/emission follow-up

Does #329 close after the rename and term mapping, or must it include nesting
validation and node-bound Weft emission? Its supplied scope/acceptance asks for
one meaning per term, verify green, import checks and unchanged replay. PR 2b/
PR 3 add parent validation, a Thread-only id predicate, Thread depth policy, tighter
Thread node/emitter caps and lifecycle emission, potentially depending on #320 binding.
D-ENG-017 permits parents without deciding when that behavior must ship.

- **(a) Close #329 after PR 1 + PR 2a (+ applicable PR 4 prose). Recommendation: (a).**
  Move PR 2b/PR 3, and PR 3s if Q11(a), to #320 or named new issues with owners,
  dependencies and their existing red/green obligations. Keep pending runtime
  binding explicit in the rename crosswalk. The rename can close independently
  of nesting and Weft design once Q5 and Q10-0's applicable gates are met.
- **(b) Retain PR 2b/PR 3 in #329**, explicitly accepting the expanded behavior,
  Q8–Q12 decisions, any PR 3s and #320 runtime prerequisites as closure gates.
  Name owners and reslice before implementation if those dependencies expand.

No completion boundary is selected here. Do not move slices or expand runtime
scope until the owner answers. Q5–Q13 remain open, including Q10-0;
Q11–Q13 add decisions without reopening D-ENG-017.

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
