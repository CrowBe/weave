# Failure-attribution development contract — WV-195 slice 1b

Refs #195. This leaf assesses supplied answers offline; it contains no classifier,
provider, runner, journal, claim, grant, receipt translator or authority to execute.
Production is tune-only. Holdout freeze and production sealed evaluation remain
closed under D-ENG-040; independent held-out precision/recall remain outstanding
under D-ENG-041. No real holdout artifact is read or created by this slice.

## Exact development envelopes

All envelopes reject extra/missing keys and wrong types before exposing a corpus.
Ids are bounded opaque Weft-shaped ids, never text, URLs or paths. Digests are
exact `sha256:` plus 64 lowercase hex characters, never normalized.

- Descriptor: `{id, split, scenario_family, source_lineage, source_revision,
  source_digest, permissions, observed_failure, receipts, facts, bundle_digest,
  annotation}`. `split` is `tune`; annotation is `characterization` or
  `ambiguous-adversarial`; scenario/source ids are lineage joins; revision and
  source digest identify the documented synthetic source snapshot. Permissions
  are exactly `{content_class: 'non_sensitive', uses: ['offline-development'],
  destinations: []}`. Observed failure is a nonempty criterion description.
  Each receipt/fact reference is exactly `{path, storedByteDigest}` and must agree
  with the manifest pin checked by the reader; bundle_digest is recordDigest(bundle).
- Frozen facts: exactly `{result, case, split, bundle}`, with `split: tune` and
  the six array families from merged Gauge 1a: weft, checks, observations, search,
  route, schedule. Exact fields, enums, revision/case/attempt bindings and required
  ids/digests conform to `packages/gauge/src/types.ts`. No oracle, revisions,
  judgment_request, current judgment receipt or live host object is frozen here.
- Raw receipts: `{schema: 'gauge.raw-receipts@1', case, result, records, checks,
  observations, search, route, schedule}`. Records are `{record, digest}` pairs of
  complete `weft.record@1` records; digest is their canonical content identity.
  The other arrays retain the synthetic serialized source receipts inventoried
  in PROVENANCE.md. Their normalized fields are pinned separately, never resolved
  from today's host state. Raw backing must match every normalized family.
- Tune labels: `{schema: 'gauge.tune-labels@1', review_status:
  'implementer-authored-no-independent-review', labels}`. Each label has exactly
  `{case, offline, judgment, acceptable_citations, rationale, author, reviewer,
  disagreement}`. Offline is exactly `{category, signal}`: an attributed wire
  category/specific deterministic signal or `{category:'unattributed',signal:null}`.
  Judgment is one attributed wire category or null, never unattributed. Citations
  are exact `{source,ref}` pairs tied to that case's recorded revision/attempt.
  Rationale/author are nonempty strings, reviewer is null and disagreement is
  `unreviewed` until a separately reviewed contract change records independent review.
- Sealed labels (synthetic controls only): `{schema:'gauge.sealed-labels@1',
  labels:[{id,category,rationale}]}` with unique bounded ids, closed wire categories
  and nonempty rationale. No plaintext encryption digest/key contract is granted.

The corpus has at least 28 distinct scenarios: four per five categories plus
8 ambiguous/adversarial scenarios. Conflicting plausible causes always use offline
abstention and judgment:null. The additional single-cause judgment scenario has
honest offline abstention and an optional admissible judgment category; every case
has a passing offline control. The prompt-injection scenario remains inert data.
No development case or source lineage can become a future holdout.

## Harness boundary and acceptance

`loadTuneCorpus()` loads all data through readTuneArtifact; validation is atomic.
`validateCorpus` is a pure in-memory control entry, never a filesystem permission.
`projectInput` constructs only `{result,case,split,bundle,revisions,judgment_request}`
by closed selection, with judgment_request:null and prompt/model revisions:null;
classifier/rule digests are injected at runtime. It does not forward descriptors,
labels, rationales, citation or review metadata, including unknown nested fields.
Input and its digest are independent of oracle metadata and candidate revisions
never alter frozen byte pins or recordDigest(bundle).
`assess` checks supplied decision shapes, Gauge validate against ordinary tune @1
context bindings, exact oracle basis/category/signal and complete citation membership;
there is no causal rule, ranking, or cause selection. Deterministic/none answers
use offline; judgment answers use judgment and retain provider confidence only as
a statistic. Missing, malformed, wrong category/signal, rejected and wrong citations
have explicit failure codes/counts, with no skipped case counted as success.
`assertLineageDisjoint` checks ids AND scenario families AND source lineages across
synthetic splits; duplicate/inconsistent declarations refuse. Labels never enter
candidate projections. Positive expected controls prove agreement with the
implementer-authored oracle, not independent review or classifier quality.

Raw Weft identity, trace/record, kind, parent, links, fields and content digest must
match each nonempty fact. Slice 2's reserved snapshot must preserve record_id/digest
or facts and byte pins require a reviewed manifest/anchor re-freeze. Resolver parity
and slice-3 Gauge fixture parity are separate future evidence.

## Custody terms

- **Independent evaluator-held digest**: A digest retained from the signed-off
  freeze outside the mutable manifest/anchor and supplied by the evaluator at run time.
- **Custodian**: The D-ENG-040-designated principal who signs off holdout artifact,
  manifest and anchor changes.
- **Sealed label**: An expected category/rationale retained outside the
  implementer-readable repo or encrypted under evaluator-held custody.

### Manifest, anchors and digests

`fixtures/manifest.json` has exactly the envelope `{entries: Entry[]}` and
contains a closed list of entries represented by `{path, role, storedByteDigest}`
for repo artifacts. The external sealed-label
entry, once authorized at a future freeze, pins only `role` and
`storedByteDigest`; its location comes separately from the evaluator. The manifest
cannot contain or supply its own trusted anchor. `reader.ts` pins its exact
repo-relative path and one manifest stored-byte digest constant.

Each entry has exactly one required scalar `role` from this closed enum:

`holdout-input | holdout-digest | sealed-label | tune | schema | snapshot | parity`.

Reject missing/unknown roles, duplicate JSON `role` keys before ordinary JSON
parsing can collapse them, multiple role assignments on one path and duplicate
canonical paths, even when pins agree. Multiple distinct paths with the same
role are valid. Never infer a role from a filename or directory. Reject
undeclared envelope/entry keys and wrong value types. The 1b production manifest
contains only tune artifacts; reserved roles do not create files or permissions.
In particular it has **no `sealed-label` entry, no real holdout entries and no
snapshot entry**. The exact `snapshot` role is specified now but its artifact,
manifest row and production read permission land in slice 2.

`storedByteDigest(bytes: Uint8Array)` in `stored-byte-digest.ts` returns
`sha256:` plus 64 lowercase SHA-256 hex characters over the **raw stored bytes**.
No decoding, canonical JSON, newline conversion or prefix removal is permitted.
Use it for manifest, artifact and sealed ciphertext byte pins. All anchors,
entry pins and independent digest inputs satisfy Weft `isDigest` and compare
with exact string equality. Bare hex, uppercase hex, wrong length, whitespace
or padding refuse; never normalize. Do not reuse decision-sites journal
`digest`, which returns bare hex. Gauge `recordDigest` remains canonical JSON
(recursively sorted object keys, array order retained) and is used for bundle
identity and the independent holdout-set digest, not file byte pins.

Define the leaf identifier **`holdoutSetDigest`**, domain/schema identifier
**`gauge.holdout-set@1`**, as `recordDigest` of:

```text
{ domain: "gauge.holdout-set@1", inputs, holdoutSetDigests, sealedLabelDigest }
```

`inputs` and `holdoutSetDigests` contain the complete verified entries with
roles `holdout-input` and `holdout-digest`, respectively, represented as
`{path, storedByteDigest}` and sorted by canonical repo-relative path, with
duplicates rejected. `sealedLabelDigest` is the sole sealed-label byte pin.
Tune/schema/parity/snapshot entries are excluded. This is not a Gauge wire
record or a glossary term. Production sealed evaluation requires nonempty
`holdout-input` and `holdout-digest` sets and exactly one sealed-label entry.
Before freeze it refuses; do not synthesize trusted independent digests from
the current manifest to bypass that refusal.

After a signed-off freeze the evaluator retains **both** `sealedLabelDigest`
and `holdoutSetDigest` independently of the mutable manifest/anchor. Before
every sealed evaluation the core verifies the manifest anchor, then requires
exact equality of each independent digest with the corresponding value from
the verified manifest, before exposing holdout inputs, labels or any report.
Every artifact's own stored bytes must also match its pin. Missing required
entries refuse before digest comparisons. No artifact or returned partial
result escapes on failure.

Future slice-5 `run.ts` alone injects production sealed options
`{sealedLabelPath: string, sealedLabelDigest: string, holdoutSetDigest: string}`
through `sealed-labels.ts` and `reader.ts` to the core. None overrides the
manifest anchor. Development synthetic triples go only through the exact
`reader.test.ts` synthetic entry, not a production “test mode”.

Routine reviewed manifest/anchor bumps touch only `tune`, `schema` or `parity`
entries and preserve every holdout entry and both independent digests. At
freeze and on every later holdout-input, holdout-digest or sealed-label change,
including removal, role change and manifest/anchor update, require the named
D-ENG-040 custodian's PR sign-off. The evaluator updates independently retained
digests after that approval; changed labels update both. Sign-off is a review
gate on artifacts/manifest/anchor, not something a deterministic test can
authenticate. Synthetic tests prove equality/preservation mechanics only.

Reserved snapshot path: `benchmarks/failure-attribution/fixtures/weft-snapshot.jsonl`.
Slice 2 will add exactly one sanitized immutable JSONL snapshot of validated
`weft.record@1` records, produced by external composition after any SQLite
intake; no inline text or credentials. It must preserve the 1b raw-receipt
`record_id`/`digest` values or trigger the reviewed facts re-freeze above.
Production G7 later requires that exact
entry. It is tune-only, excluded from `holdoutSetDigest`. Snapshot changes
require a reviewed non-routine manifest/anchor update and preserve holdout pins.
Sealed evaluation refuses any holdout case, bundle or `EvidenceRef` resolving
through this role or declared path before exposing inputs/labels/report. Test
that rule synthetically in 1b; do not add the real artifact or import SQLite.

### Closed per-file import-specifier / globals table (G7-T14)

A table row permits an import but does not require its use. The unused
`label-harness.ts` → `./sealed-labels.ts` permission is retained from plan24;
`cases.test.ts` exercises the loader directly in 1b.
**harness** expands to `node:test` (`test`) and `node:assert/strict`
(`strict as assert`), both named imports, never namespace/default imports.
Relative edges expose named production APIs or named types only. Exact named
bindings in parentheses are the complete permissions; no family wildcard.

| File                    | Exact permitted specifiers and bindings                                                                                                                                                                                                                                                      | Additional free globals                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `reader-core.ts`        | `node:fs` (`openSync`, `fstatSync`, `readSync`, `closeSync`, `lstatSync`, `realpathSync`); `node:path` (`dirname`, `isAbsolute`, `relative`, `resolve`, `sep`); `@weave/weft` (`isDigest`); `@weave/gauge` (`recordDigest`); `./stored-byte-digest.ts`                                       | None                                                     |
| `reader.ts`             | `./reader-core.ts` (named production delegate only)                                                                                                                                                                                                                                          | None                                                     |
| `stored-byte-digest.ts` | `node:crypto` (`createHash`)                                                                                                                                                                                                                                                                 | None                                                     |
| `sealed-labels.ts`      | `./reader.ts`; `@weave/weft` (`isDigest`); type-only `@weave/gauge` (`AttributionCategory`)                                                                                                                                                                                                  | None                                                     |
| `label-harness.ts`      | `./reader.ts`; `./sealed-labels.ts`; `@weave/gauge` (`validate`, `recordDigest`; type-only `AttributionCategory`, `Context`)                                                                                                                                                                 | None                                                     |
| `cases.test.ts`         | harness; `./reader.ts`; `./label-harness.ts`; `./sealed-labels.ts`                                                                                                                                                                                                                           | None                                                     |
| `reader.test.ts`        | harness; `node:fs` (`mkdtempSync`, `mkdirSync`, `writeFileSync`, `readFileSync`, `symlinkSync`, `rmSync`); `node:os` (`tmpdir`); `node:path` (`join`, `resolve`); `./reader-core.ts` (named synthetic-test entry); `./reader.ts`; `./stored-byte-digest.ts`; `@weave/gauge` (`recordDigest`) | None                                                     |
| `imports.test.ts`       | harness; `node:fs` (`readdirSync`, `readFileSync`, `lstatSync`); `node:path` (`dirname`, `join`, `relative`, `resolve`, `sep`); `typescript/unstable/sync` (`API`); `typescript/unstable/ast` (`SyntaxKind`)                                                                                 | None; match the runtime error by `{ name: 'EvalError' }` |

The exact named bindings for the relative edges are:

- `./stored-byte-digest.ts`: `storedByteDigest`.
- `./reader-core.ts`: `productionReader` for `reader.ts`; `createTestReader`
  for the exact `reader.test.ts` only.
- `./reader.ts`: `readTuneArtifact`, `readSealedInputs`; type-only
  `SealedOptions`, `SealedInputs`.
- `./sealed-labels.ts`: `loadSealedLabels`, `validateSealedLabelEnvelope`.
- `./label-harness.ts`: `loadTuneCorpus`, `validateCorpus`, `projectInput`,
  `assess`, `assertLineageDisjoint`, `expectedOfflineControl`,
  `expectedJudgmentControl`, `summarize`, `shapeVerdict`, `tuneContext`;
  type-only `Corpus`, `TuneCase`, `TuneLabel`, `FrozenFacts`, `LeafDecision`.

Every row has exactly this base free-global set: `JSON`, `Object`, `Array`,
`Map`, `Set`, `WeakMap`, `Promise`, `Error`, `TypeError`, `RangeError`, `Number`,
`String`, `Boolean`, `Symbol`, `RegExp`, `Uint8Array`, `TextEncoder`,
`TextDecoder`, `URL`, `undefined`, `NaN`, `Infinity`; plus exactly `Math.abs`,
`Math.ceil`, `Math.floor`, `Math.max`, `Math.min`, `Math.round`, `Math.trunc`.
No row has extra globals. Math may appear only as the object of a noncomputed
access to one listed member; aliasing, destructuring, computed access or
passing Math as a value refuses. `import.meta.url`, `.dirname` and `.filename`
reads alone are permitted meta access.

Forbidden built-in set, checked against the table itself:
`node:vm`, `node:module`, `node:child_process`, `node:worker_threads`,
`node:inspector`, `node:wasi`, `node:repl`, `node:net`, `node:tls`, `node:dgram`,
`node:dns`, `node:http`, `node:https`, `node:http2`. No 1b exception.
`Function`, `eval`, `Reflect`, `Proxy`, `WebAssembly`, `fetch`, `globalThis`,
`process`, `Buffer`, `require`, `module`, `Date`, `performance`, `crypto`, timers,
`queueMicrotask` and unlisted Math members all refuse. In particular no
`process.env`, `.getBuiltinModule`, `.binding`, `.dlopen` or argv grant exists.

## Runtime behaviour

1. **Check the boundary before consuming data.** Enumerate only the new leaf,
   recursively including fixtures/tests, without following symlinked trees.
   Discover `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx` and
   `.d.ts`; only the eight listed `.ts` files pass. Refuse symlinked executable
   entries and traversal directories so a listed file cannot redirect outside
   its declared location. A newly named executable
   is an error until its contract row and red/green controls land together.
   Markdown/JSON/JSONL are data, not an alternate executable route. The scanner
   reads source text, never imports/evaluates it and never opens holdout data.
2. **Parse and bind, fail closed.** Use the pinned TypeScript 7 `API`, program
   source files, `checker.getSymbolAtLocation`, declaration `path` handles and
   `Node.forEachChild`. Fail on parse/bind errors. Accept only static literal
   import declarations, with exact bindings/specifiers including erased
   type-only edges. Reject import/export attributes (`with`/`assert`), dynamic
   `import()`, every `require` reference/import-equals, module re-exports and
   `import.meta.resolve`. Reject namespace/default built-in imports and unlisted
   bindings; check the table itself against the forbidden built-in set so a
   new table row cannot bypass that invariant. Resolve relative literals to
   canonical targets:
   package internals, aliases and outside-leaf locations refuse. No journal
   edge exists in 1b. Host/Fabric/AgentSOP packages and subpaths, even type-only,
   refuse; Weft subpaths, including `@weave/weft/sqlite`, refuse.
3. **Check free globals by lexical origin.** A symbol existing is not proof
   of a local binding: default-library/Node declarations are ambient globals.
   Module-local declarations and imports count as local. Check every
   value-position identifier, including shorthand values and nested executable
   expressions. Ignore erased types, declaration names and noncomputed property
   names. Reject ambient `declare`, merging/augmentation, triple-slash
   references and non-module scripts; they cannot mask a forbidden global.
   Reject dot/literal-computed/optional member access named `constructor`
   without receiver-type inference. Ordinary `row[field]` stays valid.
4. **Enforce the reader boundary structurally.** Only `reader.ts` and the
   exact `reader.test.ts` import the core, with named imports. The production
   reader exports only its production functions, accepts no anchor parameter
   or override and re-exports no core binding; the test exports nothing. No
   file imports tests or `test-children/*`. `label-harness.ts` and
   `sealed-labels.ts` remain non-test consumers even when called by tests.
   Their real bytes come only through `reader.ts`. The scanner has no
   self-exemption and imports no leaf module. No per-call identity resolution,
   taint propagation, computed-path analysis or whole-program type inference
   is added to this boundary check.
5. **Open only declared pinned data.** `reader-core.ts` has the only production
   content-read `node:fs` grant. On every read verify manifest raw bytes against
   the supplied core anchor (the production wrapper always supplies its code
   constant) before trusting/parsing entries. Verify structural roles and
   canonical path identity, reject traversal/aliases/escaping symlinks and
   digest mismatch, then expose only the verified artifact bytes. Use read-only
   opens, descriptor checks and close on all paths; no writes, auto-repair,
   re-pinning or fallback to host source. Read the artifact once for checking
   and return that same verified content, not an unchecked second path read.
   An externally injected sealed path must undergo the same canonical target
   and byte checks; it is not permission to read arbitrary external files.
6. **Load development data separately.** The harness reads the pinned tune
   descriptors, facts, raw receipts and tune labels via production functions.
   Validate corpus bindings, lineage, category mapping and oracle consistency;
   form label-free input projections. Assess supplied answers with deterministic
   shape checks, Gauge `validate` on synthetic ordinary tune @1 bindings where
   useful, and separate citation membership/revision/attempt/oracle checks.
   `validate` alone cannot decide truth. Apply the separate `offline`/`judgment`
   scoring rules above, retaining honest offline abstention for judgment-only
   causes. A replay of expected answers is a positive control of agreement with
   the harness's own labels, not independent review or classifier quality.
   Record review status; never derive the label from the answer being checked.
7. **Keep sealed production evaluation closed.** The loader requires the
   production reader's sealed-input checks, including both independent digest
   equalities. With 1b's manifest it returns a bounded missing-freeze refusal
   before input/label/report disclosure, even if supplied an external path and
   syntactically valid digests. Missing/wrong inputs never fall back to tune
   labels. Only `reader.test.ts` exercises valid synthetic sealed triples; no
   real holdout is necessary for those positive controls. There is no production
   runner or credential loader in 1b.
8. **Run every leaf process with the compilation flag.** Add exactly
   `test:failure-attribution` =
   `npm run build && node --experimental-strip-types --disallow-code-generation-from-strings --test "benchmarks/failure-attribution/*.test.ts"`.
   Chain it into `verify` alongside the existing benchmark scripts. The leading
   build is required because public Gauge/Weft exports point to built JS.
   The computed-key Function control must fail without the flag and pass with
   it, including Node test child propagation on the supported CI toolchain.
   An unsupported flag/toolchain blocks acceptance; no silent static fallback.
   This prevents string compilation, not arbitrary-code sandboxing.
9. **Prove lint scope independently.** Use a leaf `lint.overrides` in
   `vite.config.ts` setting native `eslint/no-eval` and `eslint/no-new-func`
   to error for the entire leaf, tests/scanner included. Record the pinned rule
   listing. Enable core `eslint/no-implied-eval` only if plain `vp lint`
   demonstrates its diagnostic in the scope test; otherwise document its
   omission. Never enable `typescript/no-implied-eval`, type-aware lint or a
   custom lint plugin. If overrides are ineffective, use top-level `lint.rules`
   with the same errors, after checking repo compatibility. Missing required
   rules or an ignored new leaf file blocks the slice. No inline suppression.

## Failure, cancellation and concurrency

| Case                                                                                          | Required outcome                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing/malformed corpus, label, fact binding, role or pin                                    | Explicit bounded refusal; no partial oracle/input, no skipped case counted as pass; no raw payload/error-body disclosure                                                                        |
| Shape-valid wrong category, invented citation, wrong case/revision/attempt or bad confidence  | Harness fails at the intended check; Gauge shape validity is insufficient; no claim written                                                                                                     |
| Missing/incomplete/contradictory evidence                                                     | Offline abstention where warranted; conflicting plausible causes always require `unattributed` and `judgment: null`, with no reviewer exception or ranking                                      |
| Instruction text in receipts or rationale                                                     | Inert untrusted data, never instructions or source code; label/rationale canaries absent from candidate projections                                                                             |
| Host-path read, direct fs import, core-loader bypass or new executable                        | Static and/or reader refusal as specified in tests below; no permission-list expansion to get green                                                                                             |
| Byte-equivalent parsed JSON with different stored bytes                                       | Raw-byte mismatch refuses; formatter output cannot repin its own anchor                                                                                                                         |
| Manifest/artifact replacement during a read (design property)                                 | Open each file once, digest exactly the bytes returned and expose only those verified bytes; no unchecked second read. Test replacement between attempts in test 9, not a timing-dependent race |
| Independent synchronous read attempts                                                         | Identical verified outputs for fixed inputs, no shared mutation, file creation or writes; a failed read cannot poison a later valid read                                                        |
| Descriptor read/parse throws                                                                  | Close opened descriptors, bounded error, no source text/label/key in error; no swallowed success or fallback                                                                                    |
| Cancellation or process death during a development read/check                                 | No production mutation, claim, grant, reservation or durable attempt exists to lose/duplicate; partial results are not success. Restart verifies pins afresh                                    |
| Missing freeze, external labels absent, either independent digest absent/malformed/mismatched | Production sealed refusal before holdout inputs/labels/report; synthetic positive controls stay runnable                                                                                        |
| Later timeout/cancellation or completed-but-unusable judgment                                 | D-ENG-043 remains binding for slices 4/5: receipt retained, no claim for that attempt, separately authorized retry only; 1b creates no retry path                                               |

Read-only code needs no new cancellation API, ambient timer, AbortSignal global
grant, process spawn or lock. Tests isolate temporary synthetic roots and clean
them in `finally`; no mutation of checked-in pins to plant a failure. Keep
immutable corpus bytes readable across restart. Do not introduce a journal to
solve a state problem this slice does not have.
