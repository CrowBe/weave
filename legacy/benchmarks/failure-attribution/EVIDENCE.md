# WV-195 slice 1b verification evidence

Refs #195. Verified on 2026-11-10, resuming the uncommitted w1 implementation
at base `3e6ce1a5fc66e0315b4fd9f67efedcd5b6e97489`. Node v24.22.1,
TypeScript 7.0.2 (`typescript/unstable/sync`, `typescript/unstable/ast`) and
Vite+ 1.2.0 were already installed. No dependency install, hosted benchmark
inference, holdout freeze, production classifier or push was performed.

## Baseline and seams

Local `origin/main` equals the base. `git fetch origin main` exited 128:
`Could not resolve host: github.com`. Remote freshness is unverified; no
integration beyond that local base is claimed.

The plan's `git diff --name-only e4dc5e1 origin/main -- <seam paths>` showed
Gauge 1a types/contract/tests, Weft W6 types/contract/validator/intake/tests and
fixtures, Loom's Weft emitter, glossary/root scripts/Vite config, and
decision-sites question/tune/report source and recorded artifact paths. Source
contracts, public exports, scanner/check integration, strict benchmark config,
lockfile metadata and receipt owners were reinspected. Existing benchmark
recordings and holdout contents were not opened to reconcile those seams.
Gauge still exports no attribution classifier/producer. The receipt-owner
inventory and exact source byte digests are in [PROVENANCE.md](./PROVENANCE.md).

The production manifest anchor is
`sha256:e448801e5178055f1ec893443cc9a4b5d2edda5b854171a4fabd4f0c4b1b336b`.
All 58 entries are tune artifacts: descriptors, separate labels and 28 pairs
of raw receipts/frozen facts. Independent raw-byte hashing checked all pins;
public Weft `validateRecord` checked all 20 raw records, with exact canonical
record digests and fact identities. Counts by family: weft 20, checks 8,
observations 23, search 5, route 6, schedule 6. Normalized facts have only
`{result,case,split,bundle}` and conform to the six public Gauge 1a fact
families; no host translation correctness is inferred from those checks.

## Demonstrated red and proven green

The w1 behavioral red logs survived and were inspected: a shape-only harness
accepted always-unattributed and wrong-citation answers; deleting known oracle
keys leaked a nested canary; a prefix scanner accepted type-only host and Weft
subpath imports. Those were assertion failures, not loader failures. Further
w1 reds covered nested fact projection, coherent invocation/check-revision
bindings, raw Weft field validation and incomplete oracle citations.

The current implementation was also challenged in disposable roots copied
from this leaf, with built public exports linked through node_modules. Each
red below exited **1** at the stated assertion; restoring the source and
running the same selected check exited **0**. No production fixture was
mutated. Snippets remained inert except the narrowly authored Function control.
The checker itself has no self-exemption. The implementation and all leaf
processes use the compilation flag; the intentional unflagged negative is
launched only by the external check.

Run a selected check with this command (quote the pattern as one argument):

```sh
node --experimental-strip-types --disallow-code-generation-from-strings \
  --test-name-pattern='<pattern>' <isolated-root>/benchmarks/failure-attribution/<test-file>
```

| Control                      | Test file / pattern                                                               | Incorrect behavior and observed assertion                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| t01-shape-only-red           | `benchmarks/failure-attribution/cases.test.ts` / `^1 G7-T01`                      | Return pass immediately after successful Gauge shape validation. Always-abstaining control passes 28 instead of the expected 11; oracle rejection assertion fails. |
| t02-open-row-red             | `benchmarks/failure-attribution/cases.test.ts` / `^2 G7-T02`                      | Spread the open facts row into projectInput before the selected fields. Exact projection key assertion fails; extra oracle metadata escapes.                       |
| t14-import-bypass-red        | `benchmarks/failure-attribution/imports.test.ts` / `^10:`                         | Set scanSources omitImportCheck default to true. accepted negative 0: type-only @weave/weave import.                                                               |
| core-boundary-bypass-red     | `benchmarks/failure-attribution/imports.test.ts` / `^11:`                         | Remove unlisted-import and unlisted-binding diagnostics. accepted negative 0: label-harness importing createTestReader.                                            |
| declared-data-bypass-red     | `benchmarks/failure-attribution/reader.test.ts` / `^4 G7 leaf`                    | Read an undeclared requested path with readOnce instead of refusing it. Missing expected exception for existing synthetic host files.                              |
| runtime-unflagged-red        | `benchmarks/failure-attribution/imports.test.ts` / `^13:`                         | Omit --disallow-code-generation-from-strings; source unchanged. Missing expected exception (EvalError).                                                            |
| production-anchor-bypass-red | `benchmarks/failure-attribution/../../production-check.test.ts` / `^5 production` | Remove the manifest-byte equality check against the code anchor. Missing expected exception for coherent manifest/artifact replacement.                            |

The production-anchor control runs a temporary test outside the executable
leaf against an unchanged copy of reader.ts. Its retained equivalent is group
5 in checks/test/g7-lint.test.mjs. It changes only isolated artifact/manifest
bytes, checks the original production read first, and requires anchor refusal.
The undeclared-data control has existing synthetic host files, so absence is
not its refusal oracle. Symlink controls include a separate temporary root.

Raw SHA-256 fingerprints of the changed implementation/checker and red output
(the full logs and per-source hashes are retained in
`/tmp/wv195-w2-evidence/results.json` in this session):

| Control                      | Source             | Changed source digest                                                     | Red output digest                                                         |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| t01-shape-only-red           | `label-harness.ts` | `sha256:e8a1f9f6e84ff3cefb1de5e881a7862b1b18805b16fc03a7c3def7619105dd7c` | `sha256:cfa4f783545c5e3253554fdf64e144d80d4150d2cbf0c4eca849ed38f227968d` |
| t02-open-row-red             | `label-harness.ts` | `sha256:52b09fb2112be1dcdd59978a61626e4f2ff04617ea38a4c11ad5bf19ab2ec61f` | `sha256:c81e32f50b3b8922acbebfd45403dd48110c6313685115aa4a42c29e5fcdfc68` |
| t14-import-bypass-red        | `imports.test.ts`  | `sha256:f1a2e0566a9a9c6b69c9e75659b24cb9dfea046bdb5e9b7b0de0d59422e40df2` | `sha256:ff120dfdf95eb1ff7f0314fe3887f299224efc099aa80a216e992e9c46274347` |
| core-boundary-bypass-red     | `imports.test.ts`  | `sha256:72aa501e12c82746dab309c173720e4c3a4fdae5b056f8548cd4acda1004cbbe` | `sha256:defaa68f51680311f35aa2d4c6268ea76719a5a0c9c6b9eed31abaf551201938` |
| declared-data-bypass-red     | `reader-core.ts`   | `sha256:caf8eaf7c63c7a160693798da1f9d046ddc7d550b3360c9f772322759eb5d564` | `sha256:21dd53a24ded17b9f77451b3f49e0d39dd55f3d2ed48ea6440d4291f47ffad9a` |
| runtime-unflagged-red        | `imports.test.ts`  | `sha256:924d7bbe3e2d129efdea72090505d3c5d32b0dc2a13b3adfb8db968c51c90557` | `sha256:5450f97a474612fc0f441db1f4208d4e20a3510f23d006c25e5a180bc097c73c` |
| production-anchor-bypass-red | `reader-core.ts`   | `sha256:4d974005b250490cfa2572f38b262b33b4d7d798acf5bd124123f00f0d3d149b` | `sha256:d14f6e95d5c23eba59784170b03df3fda0bdd180322ec824ce52a189f665e648` |

The unflagged runtime row has unchanged source; its changed execution condition
is the missing flag. Group 13 independently proves the same red/green result
through Node test children. Group 14's actual-config isolated lint controls
produce named **error** diagnostics for eslint/no-eval and eslint/no-new-func
on reader-core, tests, scanner and a newly named file. The clean control passes.
Pinned rule listing exposes native no-implied-eval, but enabling it under plain
vp lint yields no diagnostic for the inert setTimeout string control; it is
therefore omitted. No type-aware lint, plugin or suppression is used.

## Numbered acceptance groups

All 23 leaf tests and all four external G7 checks pass with zero skips. The
standalone build-first flagged script passes. The groups are covered as follows;
full repository integration has the explicit blockers below.

| Group       | Passing behavioral coverage                                                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / G7-T01  | 28 offline positives; always-abstaining fails 17 attributed cases and passes 11 abstentions; wrong categories/signals/citations, case/attempt/revision, missing/extra evidence, malformed confidence and corpus/oracle backing refuse. Conflicts abstain; optional judgment and single-cause injection controls pass. |
| 2 / G7-T02  | Closed projection, nested canaries, exact key sets, input independence, runtime revisions and synthetic opposite-split id/family/source-lineage disjointness. No real holdout inventory.                                                                                                                              |
| 3           | Independent known raw SHA-256 vector, anchored read and malformed anchors/entry pins.                                                                                                                                                                                                                                 |
| 4           | Exact pinned production reads; existing undeclared synthetic host inputs, aliases/traversal and escaping symlinks refuse. Snapshot remains undeclared in production.                                                                                                                                                  |
| 5           | Formatter-equivalent changed bytes and coherent artifact/manifest substitution refuse; unchanged production wrapper pin checked in an isolated copy by the external test.                                                                                                                                             |
| 6           | Each independent sealed/set digest is required and compared; structural missing-freeze refusal; synthetic sealed positives and production loader refusal.                                                                                                                                                             |
| 7           | Closed roles, duplicate keys/paths, same-role different paths, routine non-holdout updates, changed/removed/added/relabeled holdout entries and independent pins.                                                                                                                                                     |
| 8           | Synthetic snapshot path/role/case/bundle/ref exclusion; disjoint synthetic evidence passes.                                                                                                                                                                                                                           |
| 9           | Independent reads, mutation isolation, replacement/restore, bounded malformed/missing/truncated failures and temporary-root cleanup. Read-only descriptor opens close in finally and return the exact hashed bytes.                                                                                                   |
| 10 / G7-T14 | Exactly eight executable rows; pinned TS parse/bind diagnostics, erased imports, exact module/binding table, re-exports, all executable names/extensions and symlinks; accepting-negative checker mutation detected.                                                                                                  |
| 11          | Non-test core import, dynamic import, source evaluation, vm, wrapper exports/signatures/anchor override, test imports and direct label fs bypasses refuse.                                                                                                                                                            |
| 12          | Lexical declaration origin, nested/shorthand values, forbidden globals, ambient declarations, Math/meta/constructor restrictions and local-shadow positive controls.                                                                                                                                                  |
| 13          | Computed-key Function control red without the flag, green with it, including Node test-child propagation.                                                                                                                                                                                                             |
| 14          | Effective native lint diagnostics and clean controls using actual repo config on all representative/new leaf names.                                                                                                                                                                                                   |
| 15          | Strict benchmark include, exact build-first flagged script in verify, built-only public exports, pinned fixture format exemptions and unchanged package/check permissions; full verify attempted with blockers below.                                                                                                 |

The root import-direction check initially rejected the inert package-internal
negative string; assembling that same source from a path variable preserves
the G7 negative without masquerading as an executable edge. W5-T43 initially
mistook serialized weft fields for port composition; computed literal data
keys preserve identical data and make the existing check pass. Both failures
were observed before these source-form repairs. No check or opt-in list changed.

## Integrated commands and remaining uncertainty

Passing: npm run test:failure-attribution (three test files, 23 individual
checks), npm run typecheck:benchmarks, npm run test:gauge-contract (nine test
files), node checks/test/g7-lint.test.mjs (four checks), direct flagged runs
of each leaf test file, all seven standalone root source checks, W5 authority
checks, npm run lint (existing warnings; no new leaf warnings), and git diff
--check. Implementation-only npm run fmt:check passes: the two untracked plan
copies were temporarily moved out and restored byte-for-byte, leaving tracked
_plan files in scope. The supplied plan copies themselves have formatting
issues and were not edited or committed.

Full `npm run verify` was executed with
`NODE_OPTIONS=--require=/tmp/wv195-no-benchmark-data.cjs`. This verification-only
preload rejects access to preexisting benchmark data before opening bytes;
it changes no repository code/check. verify passes formatting, then stops in
npm run check at scripts/benchmark-digests.test.mjs, whose existing recorded
benchmark tests read old holdouts and recordings. No full-suite green is
claimed, and later verify stages were not reached through that chain.

Separately, npm run test:checks passes the three other test files including
the new G7 controls, but checks/test/checks.test.mjs fails seven preexisting
assertions because its spawned checks return empty captured output here.
The underlying checks all pass when run directly. Separately running the full
package suite with the data-read guard passes 110 of 117 test files after the
W5 repair. Seven fail: Fabric cli-generate/shell-run, gateway Amos/Vercel,
Loom task-acceptance, and Weft OTEL isolation/SQLite intake. Direct diagnostics
include loopback listen EPERM, spawnSync EPERM, shell child assertions and the
task-acceptance benchmark-data guard. These package/check sources are unchanged;
the failures are retained as verification limits, not silently skipped or
repaired outside scope. Supported CI Node 22 execution is still unverified in
this Node 24 environment. Session logs are under /tmp/wv195-w2-*.log.

The corpus is implementer-authored with no independent review (D-ENG-055 §5).
Its 28/28 expected offline answers establish harness agreement only, not label
accuracy, classifier quality, precision or recall. Source licenses remain
unknown and permitted destinations empty. No holdout/snapshot/sealed-label
entry exists in the production manifest; independent freeze roles/custody and
held-out quality evidence remain outstanding. #195 stays open.
