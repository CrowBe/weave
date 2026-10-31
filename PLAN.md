# WV-329: project-level workstream becomes Thread

Planning only. The owner decided on 26 October that the project-level concept
shipped in #314 is **Thread**. This plan prepares that rename; it changes no
source, glossary, tests, schemas, or recorded data. Recommendations below are
proposals awaiting the owner decisions in section 7, not permission to change
record meanings.

## 1. Evidence, scope, and data shape inventory

Baseline: `85b311e7173bd5938507f671e387a16714a7ad54`, inspected on
1 November 2026. Read `VISION.md`, `GLOSSARY.md`, `AGENTS.md`, current contracts,
transition implementations, their tests, Weft emission/recovery tests, and the
import-direction checks before choosing the sequence below.

`gh issue view 329 -R CrowBe/weave` failed to connect to `api.github.com`.
The supplied issue summary is the issue evidence available here. References to
#26, #28, #314, #320, #330 and PR #362 use that summary and checked-in references;
their latest remote status is unverified. No files in the WV-320 worktree were
read or edited. Its design remains in flight; section 5 defers its update until
after merge.

Reproduce the required inventory, including plurals and identifier substrings:

```sh
rg -n -i 'workstream' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
rg --json -i 'workstream' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
rg -n -i 'thread' packages/ docs/ checks/ GLOSSARY.md AGENTS.md
```

Counts below are regex **occurrences**, not just matching lines; the JSON
`submatches` arrays provide occurrence counts. These are tracked/source inputs
visible to normal `rg`, excluding ignored build/dependency output. Recount on the
implementation baseline after #320 merges. The groups in this table partition
all **480 occurrences on 383 lines in 12 files**: lowercase `workstream` 286,
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
The serialized-key/version decision in section 4 precedes renaming stored
fields. No arbitrary identifier value such as fixture id `ws-a` needs rewriting.

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
chosen wire-version policy. Preserve pause/stop evidence, resume-point digest,
revision and terminal-state rules.

### Documentation and test coverage

Rename `packages/weave/src/WORKSTREAM-CONTRACT.md` to `THREAD-CONTRACT.md` in
the implementation slice, replacing its overridden naming assumption and
updating links from source comments and `packages/weave/src/sites/CONTRACT.md`.
Update glossary Workstream, old Thread, Operating process, Input routing,
Project, and both affected language constraints in the glossary-first slice.
`docs/execution-provider-contract.md` contains both senses of Thread and
references #320's workstream follow-ups; classify them before editing.

The three tests contain **33 top-level behavioral tests**: workstream 8,
operating process 10, input route 15. They pin ordered serialized keys,
schemas, refusal values, opening without authority, one active goal,
independent records, input ordering, artifact revisions, byte-identical
transition replay, process lifecycle, routing atomicity/correction, cancellation,
and provider-free reconstruction. Their existing assertions are acceptance
constraints, not snapshots to regenerate wholesale. Preserve old-format fixtures
when adding new-format coverage.

A repository-wide cross-check found another **4 occurrences on 2 lines** in
root `CONTRACT.md`, outside the requested roots: contract title/link, schema and
execution description. Include its link/terminology update in implementation.
There are no other workstream matches outside the required scan roots at this
baseline (excluding this new plan).

## 2. Old-sense Thread inventory

The broad case-insensitive `thread` scan above finds **351 occurrences on 299
lines in 47 files**. It includes plurals, `running_threads`, `new_thread`,
`thread_identifier`, component names and OS threading; those are classified
below rather than globally substituted. Counts in each row are occurrences.

### Causal-chain definitions, emission, storage and tests

Every entry in this table uses the causal-chain sense, including null envelope
fields that support that sense; none already identifies the project-level
record. Weft's current reference mapping is `thread_id = action_id`.

| File | Count | Use and treatment |
| --- | ---: | --- |
| `packages/weave/src/weft.ts` | 21 | Port envelope, action causal lifecycle, deterministic record ids and join/supersession/cancel links; retain v1 wire meaning. |
| `packages/gateway/src/weft.ts` | 2 | Envelope field and null emission; no project identity. |
| `packages/agentfabric/src/weft.ts` | 2 | Envelope field and null emission; no project identity. |
| `packages/weft/src/types.ts` | 3 | `thread.transition`, outcome subject `thread`, envelope `thread_id`. |
| `packages/weft/src/validate.ts` | 12 | Closed keys/kinds/subject, id rules and cross-record link requirements. |
| `packages/weft/src/WEFT-CONTRACT.md` | 35 | Definition, transitions, cross-chain links, crash/recovery identities, action mapping, SQLite scopes. |
| `packages/weft/src/otel.ts` | 2 | Exports envelope as `weft.thread_id`; keep causal meaning. |
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
acceptance files; its remote issue text was not retrieved. Cross-chain links
are `joins`, `supersedes`, `cancels`, `handoff` (plus general `caused_by` and
`retry_of`), all targeting records within one trace. They are not project
Thread links. Dependencies join dependency chains' `closed` records;
supersession belongs to the earlier chain and names the replacement's `opened`
record; cancellation names the affected chain's `opened` record. A repeated
cancel has a distinct sequence-derived record id. Forward link targets can
arrive later. Preserve all those meanings, even when prose uses the new term.

### Mixed senses and other uses

| File | Count | Classification |
| --- | ---: | --- |
| `GLOSSARY.md` | 12 | Thread heading/definition, Workstream comparisons and language constraint: causal-chain. Intake classification uses task-oriented summaries, not the project record; retain its existing contract pending an explicit mapping. |
| `packages/weave/src/WORKSTREAM-CONTRACT.md` | 8 | #26's quoted thread is already project-level; remaining comparisons explicitly distinguish the causal-chain Thread and Weft id from the workstream. Rewrite the distinction after the owner names it. |
| `packages/weave/src/sites/index.ts` | 6 | `IntakeState.running_threads[].thread_id`, fixed intake question and `new_thread`/`continue_thread`: legacy task/causal-work vocabulary; no project index integration, so not already project-level. |
| `packages/weave/src/sites/CONTRACT.md` | 1 | Same intake summaries. |
| `packages/weave/test/p5.test.ts` | 5 | Intake summary shape and frozen choice vocabulary; no project Thread behavior. |
| `packages/weave/test/p6.test.ts` | 1 | Empty intake `running_threads` fixture. |
| `packages/gateway/test/amos.test.ts` | 8 | Intake choices, prompt and generic choice fixtures; no project Thread behavior. |
| `docs/m7-decision-loop.md` | 5 | Intake question/options/summaries: legacy task vocabulary; storage `run/thread/...` description: causal Weft storage. |
| `docs/execution-provider-contract.md` | 3 | Boundary table lists Threads and workstreams separately: old Thread is causal. Independent Threads and X-T10 programs are execution-work units, not a wired project record; clarify against #28/#320 rather than infer a wire mapping. |
| `checks/fixtures/execution-provider/contract.mjs` | 7 | `thread:a/b/c` labels for separate offered sets/worker progress; execution correlation ids, no `Thread` type or `workstream@1` shape. Keep values unless the fixture contract changes. |
| `docs/research/monty-sandbox.md` | 18 | Explicit vocabulary note binds Thread work to #28's operating process: already the planned project-level sense. Two matches concern OS `threading`/threads and remain OS terms. Preserve historical evidence and qualify lifecycle statements when updating the note. |
| `docs/design-system.md` | 6 | Initial Threads/input-routing/pause scope exclusion: planned project-level work. Five other uses name the conversational component, not a causal-chain or project record. |
| `packages/tapestry/src/vocabulary.ts` | 2 | `conversation.thread@1`: conversational presentation component, neither domain identity. |
| `packages/tapestry/src/session.ts` | 1 | Same versioned component node. |
| `packages/tapestry/src/tree.ts` | 2 | Same component placement/reading. |
| `packages/tapestry/test/tree.test.ts` | 10 | Same component identity/placement; no project Thread model. |
| `packages/tapestry-web/src/host.tsx` | 3 | Component renderer dispatch and `ConversationThread`; presentation only. |
| `packages/tapestry-web/src/paint/conversation.tsx` | 2 | Renderer name/test id; presentation only. |
| `docs/respan-routing-learnings.md` | 6 | External Respan conversation/cache affinity and a proposed thread+digest cache key; neither implemented project identity nor Loom's defined causal-chain id. Do not rewrite external `thread_identifier`. |
| `packages/agentfabric/test/shell-run.test.ts` | 1 | OS/main JS thread blocking comment. |

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

## 3. Owner decision: replacement for the old glossary Thread

| Candidate | Benefit | Limitation |
| --- | --- | --- |
| **Causal chain** (recommended) | Names the existing goal-local actions/observations relation, independent of provider, runtime implementation and tracing format; clearly distinct from project Thread. | Several chains can join into a graph, so define a chain as a causal line of work with explicit links to other chains, not as the whole graph or a strictly linear execution schedule. |
| **Trace thread** | Makes legacy `thread_id` easy to explain in Weft documentation. | Conflates runtime work with its non-authoritative Weft projection and keeps the overloaded word. |
| **Action lineage** | Fits today's Weft `thread_id = action_id` reference mapping. | Too narrow for the broader current glossary definition spanning actions and observations; may imply ancestry rather than joins/cancellation. |

Recommend **Causal chain**, subject to owner approval. Define it in the glossary
before introducing code/prose terminology. Preserve the old within-goal scope,
concurrency, join, supersession and cancellation semantics. The relationship is
Project → Thread → goals over time → causal chains within a goal. A Thread
still has at most one active goal and at most one live operating process; it
outlives both. This renaming creates no new runtime primitive.

## 4. Owner decision: recorded-record compatibility

Current evidence matters: `WORKSTREAM-CONTRACT.md` explicitly says this slice
is not persisted or wired into the runtime observation log/replay. The repository
therefore cannot prove that external consumers have recorded none of its JSON
results. Existing pure transition tests and `transitionRoute` are replay-like
checks, not a durable workstream journal implementation. Do not invent a new
journal or on-disk migrator just to rename this concept.

| Option | Contract and replay consequences |
| --- | --- |
| (a) New `thread@1`, read-side alias for `workstream@1` | New writers use `thread@1` and `thread_id`. A bounded, version-dispatched reader recognizes the complete old shape and maps it to the new semantic view, retaining its original bytes/version for historical replay. Dependent record keys require versions too: if `workstream_id` becomes `thread_id`, use `operating.process@2`, `input.route@2`, `input.route.correction@2`, with explicit old-version mappings. `thread@1` starts a new schema identity; it is a documented successor, not an in-place edit of v1. |
| (b) Keep `workstream@1` readable forever with a documented mapping | Rename the public/prose concept to Thread while retaining the old wire schema and `workstream_id` in all v1 records. No new wire version or historical byte change. Lowest migration risk, but the old vocabulary stays in serialization and needs a permanent glossary/contract crosswalk. Readability also remains an obligation if future formats are added. |
| (c) Explicit offline conversion to only the new format | Copy into a new store with source digests, versioned conversion evidence, atomic publication and rollback; never rewrite the only journal in place. Costs a real migration/recovery contract, risks changing hashes/identities and requires a justified support cutoff. No checked-in persistence need currently justifies it. |

Recommend **(a)**, pending owner approval of the complete version matrix and
actual downstream persistence inventory. Retain old-format readability without a
sunset; the read-side alias is a documented semantic mapping, not permission to
accept either set of keys under the same schema. If there is no reader boundary
yet, specify the mapping now and implement only the minimal pure adapter needed
by an identified consumer, not speculative storage infrastructure. Option (b)
is the fallback if the owner prefers zero wire-format churn now.

For (a), the compatibility contract must say:

- Dispatch by exact schema/version and enforce each version's shape, bounded
  ids and closed vocabularies. Reject conflicting dual ids, mixed-version nested
  records, malformed versions, duplicate logical ids and cross-project aliases;
  never let an alias bypass validation.
- Preserve all ids, order, evidence sequence references, revisions, artifact
  revisions, held inputs, operating state, pending requests and resume digests.
  Resolve old index/result `workstreams`/`workstream` and new `threads`/`thread`
  deliberately; indexes/results are API shapes, not currently versioned journal
  envelopes. Preserve historical refusal strings in historical transitions.
- Historical reconstruction uses historical versions and yields unchanged
  historical bytes/results. A new normalized read view is a separate projection;
  never run an old record through the new writer and call that unchanged replay.
  Document the new-write cutover and dependent versions in the renamed contract.
- Existing Loom journal replay remains unchanged and non-executing. It invokes
  no capability/provider, reconciles no effect, renews no grant and emits no
  Weft record. Recovery remains a separate authority-checked operation. Do not
  use Weft records as the source for rebuilding project state.

Weft compatibility is a separate decision: recommend retaining
`weft.record@1.thread_id`, `thread.transition`, outcome subject `thread`,
`weft.thread_id`, `threads` SQLite storage and `:thread:` record-id segments as
legacy **causal-chain** wire names. Map those to Causal chain in documentation
and future views. Never put the project Thread id in these fields. A future
project correlation field or causal wire rename needs a separately versioned
Weft contract, disclosed bounded identifiers, schema/OTel/SQLite support and
its own replay/recovery evidence; it is not necessary for this rename.

## 5. Smallest ordered PR slices and red-before-green evidence

Dependencies are **1 → 2 → 3 → 4**. Read-only inventory review and independent
test-case design can proceed concurrently; each implementing PR waits for its
contract decisions. Each slice must finish green before merge. Do not merge a
partially renamed producer/consumer pair. This planning commit implements none
of these slices.

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

### PR 1 — Glossary and naming/compatibility contract first

After owner choices, rename the old glossary Thread entry to the selected term,
replace Workstream with project-level Thread, update related definitions and
language constraints, and record the old wire-name crosswalk. Amend the naming
assumption in the existing contract to point to the approved decisions; leave
its current implementation/wire names explicitly identified until PR 2.
This is the glossary update deferred from this planning-only run.

**Red before edits:** run a narrow terminology contract check asserting that
the glossary's Thread is project-level, the chosen causal term has the old
within-goal semantics, and legacy Weft `thread_id` is explicitly causal. It must
fail against today's glossary. Include a check that opening a Thread confers
no authority. This is a documentation/contract check, not permission to generate
implementation code before a behavioral red in PR 2.

**Green:** those assertions and link checks pass, and current record/behavior
tests still pass unchanged. Run G and full verification. No `VISION.md` edit:
the acceptance boundary stays the same.

### PR 2 — Atomic Loom API/module rename and versioned record mapping

Rename the module/test/contract to `thread.ts`, `thread.test.ts`,
`THREAD-CONTRACT.md`; change public exports, internal imports, index/result
properties and callers together. Update operating-process ownership, routing
request/context, refusal names and new serialization only under section 4's
approved version matrix. Update the root `CONTRACT.md` link and site contract
links in the same PR. Preserve legacy record fixtures and replay functions.
Do not change intake labels, inference routing, capability admission, authority
or Tapestry component ids.

**Red before implementation:** add a public-entry-point consumer check using
`Thread`/`openThread` and the approved emitted shape; it fails to compile or
fails its shape assertion on the old API. Separately demonstrate behavioral red
for reading an old record and a new record into the same semantic state while
preserving original historical output; reject contradictory ids and schema/key
mismatches. Exercise all four affected schema families, not only `thread@1`.
Use a known-invalid mapping (drops evidence or changes a resume digest) to
confirm the compatibility tests detect semantic damage.

**Green:** port all 33 existing workstream/process/route behaviors without
weakening their assertions; add mixed-version/historical checks described in
section 6. Run `npm run build`, then
`node --test packages/weave/dist/test/thread.test.js packages/weave/dist/test/operating-process.test.js packages/weave/dist/test/input-route.test.js`,
the public consumer compile check, G and full verification. Test `p5.test.ts`
and `p6.test.ts` remain green with their existing intake shapes and options.
Use a narrowly allowlisted legacy-name scan, with a failing fixture containing
a stale active API import, so recurring partial-rename findings become a
deterministic lint/check rather than another review reminder.

### PR 3 — Weft causal mapping and cross-link terminology

Update causal-chain terminology in the Weft contract, Loom emission comments,
architecture and relevant research prose; retain the section 4 v1 wire mapping.
Do not rename v1 JSON fixture fields, OTel attributes, SQLite tables or durable
record-id segments. Gateway and Fabric keep their locally declared ports and
null causal id semantics. No trace reader feeds back into Loom.

**Red before edits:** a terminology/mapping check fails on the current contract
claim that Weft `thread_id` means the newly project-level Thread. For any code
mapping added, first use a test that distinguishes a project Thread id from an
action's causal id and fails under the conflating mapping. A byte-preservation
test should also reject a mutation that changes `:thread:` ids or link targets.
Retaining the wire format requires no speculative mapper implementation.

**Green:** the crosswalk and mapping assertions pass, the original golden
records remain identical and valid, and dependency join, handoff, supersession,
repeated cancellation and recovery links preserve their targets. Run
`npm run test:weft-contract`; after build run
`node --test 'packages/weave/dist/test/w5-*.test.js'` (Node >=22.18), including
replay, isolation and authority tests; run G and full verification. Keep the
SQLite/OTel intake tests enabled under their supported Node environment.

### PR 4 — #320/#330 and dependent document alignment after merges

Wait for #320 / PR #362 to merge, then inspect its actual merged files and
recompute inventories. Open a follow-up from that baseline updating its design
doc to project Thread, the approved causal term, ownership fields, compatibility
matrix, pause/resume/recovery and Weft mapping. Do not edit or cherry-pick the
in-flight WV-320 worktree. Apply the same crosswalk to #330's document once its
actual scope/file is known; no guessed path or assumed implementation is part
of this plan. Include #26/#28/#314 follow-up references and clarify the mixed
execution-provider/design-system/research wording inventoried above.

**Red before edits:** run a scoped doc/link check on the merged docs, failing
on stale workstream contract paths, project work called causal-chain Thread,
or a project id mapped to Weft's causal `thread_id`. Keep intentional historical
quotes, external names and legacy version mappings explicitly allowlisted.

**Green:** corrected cross-references and examples agree with glossary/actual
exported types and versions, with no change to normative lifecycle behavior.
Run G and full available verification. Any new runtime integration discovered
in #320 needs its own behavioral red and scope review, not silent enlargement
of this documentation slice.

## 6. Failure, cancellation and concurrency acceptance cases

These are requirements for implementation evidence, not claims that a durable
project Thread journal exists today. Pure adapters can use recorded JSON
sequences now; durable integration must exercise the real journal when it exists.

| Case | Required deterministic evidence |
| --- | --- |
| Partial rename across packages | Build and public consumer compile checks reject stale imports or mismatched ownership keys; link/name check rejects stale contract paths. No producer writes a new shape under an old schema. Preserve G import directions and local port declarations. |
| Mixed old/new records in one journal | Version-dispatched read handles interleaved old/new Thread, process, route and correction records in recorded order. Compare canonical semantic state with an equivalent single-version history; compare each historical replay result with its original version's expected bytes. Equal logical ids share one identity, not two aliases; conflicting duplicates, dual keys, wrong nested versions and unknown versions fail closed without applying a prefix of a transition. |
| Crash mid-migration or write cutover | Prefer no migration: readers are installed before new writers and original records remain intact. Crash before append, after append/before acknowledgement and between old/new records; restart from every durable prefix. State/evidence/queue/process/grant reservations are neither lost nor duplicated. Replay has zero effects, gateway calls or emission; recovery emits only newly appended observations and never reopens the same causal chain. If (c) is chosen, require atomic destination publication, source retention and resume-or-rollback evidence before introducing a migrator. |
| Parallel routing fails or is cancelled | Aborted/unavailable/stale site answers place no input and open no Thread. If a parallel target id is invalid/duplicate or any subsequent step refuses, retain the exact original index: no orphan target, partial input placement or process transition. A model answer alone never grants or dispatches work. |
| Interrupt correction races a pause/stop/completion | An interrupt requests pause at the next boundary, never a stop. Correcting one of two interrupts retains the other's pending pause; an honoured pause stays paused; terminal processes stay terminal; stale corrections refuse. Preserve request evidence and resume digest across record versions. |
| Concurrent independent Threads | Interleave two Threads' transitions and separate active goals; transitioning one preserves the other's record, inputs, process and authority. Only one active goal and live process per Thread; one goal attaches once within a project. No new global lock or serial batch is introduced by compatibility reading. |
| Concurrent artifact updates | Preserve monotonic artifact revisions within a Thread; cross-Thread writes still require canonical effect locks. Ownership/key renames do not expand a grant or bypass stale read-set/resource checks. |
| Old exported-name consumers | Exercise a fixture importing the public old names and one using the new names. Preferred atomic change updates all checked-in callers and documents the source-breaking API change. If the owner requires a temporary deprecated alias, it must be one identity/implementation with a removal boundary and compile/behavior tests; no duplicate state model or unsupported deep-import shim. The wire read alias in (a) does not imply an API alias. |
| Weft links across crash/concurrent arrival | Old segments and new segments resolve the same ids, including forward targets, dependency joins, repeated cancels and supersession before/after recovery. Project Thread ids never overwrite action causal ids. Slow/throwing/reentrant sinks do not change scheduling, budgets or outcomes. |
| Authority and disclosure | Opening, decoding, correcting or resuming creates no grant/approval/budget. Single-use grants stay consumed after crash and are never re-presented; uncertain effects are reconciled only under current authority. Reject credential-shaped ids, keep raw input/provider errors out of records and keys out of argv/logs. |
| Benchmark contamination | Keep intake choices/frozen corpus bytes and digests unchanged. Rename checks must not rewrite historical evidence, inject guardrails or shuffles into benchmark routes, or expose held-out cases. A future comparison requires reserved independent adversarial/held-out cases and recorded data provenance/license/destination plus sanitization or explicit authorization before hosted disclosure. |

Runtime and gateway remain provider-independent and pure: no environment,
filesystem, shell or ambient-clock access is introduced. Time and identity
allocation remain injected; persistence and any conversion stay at existing
composition/storage boundaries. Capability generation, admission and authority
to execute remain separate gates. A repeated review finding becomes a narrow
lint or behavioral regression test with known-red and green evidence; do not
relax permissions, validation or protected checks to pass it.

## 7. Open questions for the owner

1. Approve **Causal chain** for the former goal-local Thread, or choose Trace
   thread / Action lineage? Confirm its scope remains the existing definition,
   with today's action-id mapping a reference implementation detail.
2. Approve compatibility option (a), including `thread@1`, dependent
   `operating.process@2` / `input.route@2` / `input.route.correction@2`, explicit
   old-version readers and indefinite old-record readability, or prefer (b)'s
   unchanged v1 wire vocabulary? Who has recorded #314 results outside this repo,
   and which reader/writer owns the actual cutover?
3. Keep Weft v1's causal wire names/ids unchanged with a documented mapping as
   recommended? Is new project-level trace correlation required now? If yes,
   approve a separately versioned Weft scope rather than repurposing `thread_id`.
4. Are old public TypeScript export names allowed to break in this private
   `0.0.0` workspace, or are there downstream consumers requiring time-bounded
   deprecated aliases? Name those consumers and the support/removal boundary.
5. Confirm `intake.classify` stays on its existing task/causal-work contract,
   labels and frozen sets for this rename. If it must address project Threads,
   which separate versioned state/mapping change and evaluation owns that work?
6. After #320 / PR #362 merges, which merged design document and reviewer own
   its terminology update, and what exact #330 document/scope must follow?
   Confirm whether their merged integration changes the persistence assumption
   recorded here before PR 2's implementation starts.

## Planning-run validation

Only `PLAN.md` is intended to be committed, with message
`plan: workstream → Thread rename (#329)`; no push. Inventory counts and file
references are checked against the baseline, and the final diff must contain
no source, glossary or test edits.

- Demonstrated planning-artifact red: a presence assertion failed because
  `PLAN.md` did not exist. This is not implementation behavioral-red evidence;
  the future slices still require their own tests before implementation.
- Planning checks green: recomputed all per-file counts in both inventories
  (12 workstream files, 47 thread files), checked referenced existing file
  paths, required sections and compatibility/scope statements, and confirmed
  `PLAN.md` was the only working-tree change. Whitespace checks pass.
- Direct repository checks green: import direction (325 files), ambient clock
  (104 runtime files), ambient entropy (51 Loom/Weft files), ambient environment
  (133 source files), and swallowed failures (12 manifests/workflows).
- `npm run verify` was attempted and stopped in `npm run check`:
  `scripts/benchmark-digests.test.mjs` passed, but verify-cache tests cannot
  spawn missing `node_modules/.bin/vp` (`ENOENT`). The standalone build also
  failed because `tsc` is absent. No dependencies were installed or lockfiles
  changed for this planning run.
- Environment is Node `v20.19.2`, below the declared `>=22.18.0` requirement.
  `npm run test:checks` cannot resolve its quoted glob under this Node. An
  explicit shell-expanded run passed credential-parity and execution-provider
  test files but failed the checks fixture file. Diagnostic child-process
  execution returned `EPERM` in this restricted environment, although the
  directly invoked checks and sampled red/green fixtures produced the expected
  findings. The full deterministic suite is therefore **not green here**;
  rerun with the supported toolchain, dependencies and child-process execution
  before merging implementation. No check, fixture or permission was weakened.
- Commit attempted with the requested message, but `git add -- PLAN.md`
  could not create
  `/workspace/weave-WV-234/.git/worktrees/weave-WV-329/index.lock`: that worktree
  metadata directory is mounted read-only. The plan remains uncommitted and
  unpushed; no permissions or Git metadata were changed to bypass the mount.
