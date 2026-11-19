---
name: verify-gauge
description: Build and drive Weave Gauge (`packages/gauge`, `@weave/gauge`, the evaluation package that turns Weft traces and recorded evidence into evaluation results, comparisons and failure attributions) through its public library API — validate, evaluate, evaluateInfo, compare, track — against `packages/gauge/fixtures/records.json`, plus the offline failure-attribution harness (`benchmarks/failure-attribution`, tune-only corpus), with a scripted Node helper that records per-check evidence. Use this to prove a change to packages/gauge, GAUGE-CONTRACT.md, Gauge's fixtures or the failure-attribution leaf actually behaves, alongside the monorepo verify gate. Gauge has no CLI and no UI, calls no model, and never promotes or admits; do not use this for Weft (use verify-weft), Tapestry (use verify-tapestry), or the sealed holdout evaluation, which is closed.
---

# Verify Weave Gauge (`@weave/gauge`)

Gauge is the evaluation package (`GLOSSARY.md` → Gauge). It turns Weft traces and other recorded evidence into evaluation results, comparisons and failure attributions. **It produces evidence; it does not promote, admit, roll back or route.** Every verdict is derived: `validate` recomputes it and rejects a record whose verdict does not match. The contract is `packages/gauge/src/GAUGE-CONTRACT.md`. **Gauge imports `@weave/weft` and nothing else in-repo** (`checks/import-direction.mjs`).

The surface a user (a composition root, Loom's Experiment, a benchmark, an evaluator) touches is the **public library API**, `@weave/gauge` → `packages/gauge/dist/src/index.js`:

| Export                                                        | What it does                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `validate(value, context)`                                    | `{ok:true}` or `{ok:false, reason}`; the first applicable reason from the contract's ordered list |
| `evaluate(run, context)`                                      | samples → `gauge.result@1`, with intervals, constraint statuses and a recomputed verdict          |
| `evaluateInfo(run, context)`                                  | samples → `gauge.result@2` for an info-only `gauge.criteria@2` set; verdict is always `info_only` |
| `compare(request, context)`                                   | two recorded results → `gauge.comparison@1` with a delta and interval per measure                 |
| `track(results, context)`                                     | ordered results → steps with verdict and `regression` (evidence, not a record)                    |
| `costed`, `constraintStatus`, `resultVerdict`, `recordDigest` | cost gate, building blocks, canonical digest                                                      |

The second surface is the **offline failure-attribution harness** (WV-195 slice 1b, `benchmarks/failure-attribution/`, contract `CONTRACT.md`): `label-harness.ts` (`loadTuneCorpus`, `assess`, `projectInput`, `summarize`, controls) and `reader.ts` (manifest-pinned reads) over the **tune-only** corpus in `fixtures/`. It has no classifier, provider or runner. **Production/holdout sealed evaluation is closed** (D-ENG-040/041): the manifest has no sealed-label or holdout entry, and this skill only proves that `readSealedInputs` refuses (`missing freeze`). Never claim a holdout or sealed result from this skill.

There is no bin, no server, no UI and no model call. "Launch" means build the package once; each drive is a short-lived Node process that imports `@weave/gauge` the way a consumer does, uses the committed fixtures, writes produced records into a per-run scratch dir, re-reads them from disk and re-validates them (the second view), and proves the fixtures were not mutated. Everything is offline.

Everything goes through one dependency-free helper (Node built-ins, `@weave/gauge`, and the harness's own exported `.ts` modules):

```bash
H=.claude/skills/verify-gauge/bin/gauge-verify.mjs   # run from the repo root; it resolves paths from its own location
```

Requirements: Node >= 26 (type stripping for the harness `.ts`), `npm ci` already done so `node_modules/@weave/gauge` links to `packages/gauge`.

## Monorepo baseline (required before calling a change "done")

This skill proves Gauge behaviour. It does not replace the monorepo gate. "Done" needs real proof: the behaviour exercised for real, not green tests alone. Before calling a change done or approving its PR, do all of this (it is the verify-weave workflow at `/home/box/agent-data/workflows/verify-weave/SKILL.md`):

1. Check out the exact head SHA under review in a **clean clone**. Use **Node 26** (`node -v` must print `v26.x`; switch with nvm/fnm if needed). The repo's engines are `>=26`, so a newer Node runs, but record the Node 26 requirement and the version you actually used. Run `npm ci`.
2. Run **`npm run verify` from the repo root FIRST**, before any package-specific proof, and record the result per package. Gauge's parts of it are `npm run check` (includes `checks/import-direction.mjs` and `checks/gauge-attribution-contract.mjs`), `npm test` (includes `packages/gauge/dist/test/*.test.js`), `npm run typecheck:benchmarks` and `npm run test:failure-attribution`.
3. Run **every script under `checks/`**. List the directory first; don't assume names. Each must exit 0. `$H checks` does this and records each result (see Drive). The checks that cover Gauge directly are:
   - `checks/import-direction.mjs`: gauge imports `@weave/weft` only; nothing else in-repo.
   - `checks/gauge-attribution-contract.mjs`: the attribution input/decision type exports in `packages/gauge/src/types.ts`, the contract text and `GLOSSARY.md` stay aligned.
   - `checks/test/g7-lint.test.mjs` (run by `npm run test:checks` and `$H checks`): the failure-attribution leaf's production reader anchor refuses a coherent manifest replacement, native lint covers every leaf file, the flagged script is wired into `verify`, and the string-compilation prohibition reaches test children.
   - `checks/no-ambient-env.mjs` (every `packages/<name>/src`) and `checks/no-swallowed-failures.mjs` (every package's scripts) also scan Gauge. `checks/source-scan.mjs` is a shared module, a no-op when run. `checks/extract-before-site.mjs`, `checks/no-ambient-clock.mjs` and `checks/no-ambient-entropy.mjs` do not target Gauge but must still pass.
4. Package-specific runtime evidence: this skill's Launch → Doctor → Drive (every feature the change touches, from `features/`) → Evidence → Cleanup, plus `$H test`.
5. Confirm CI on the PR is green for the **same SHA**. A new commit voids this verification.
6. Report: SHA, Node version, `npm run verify` result, each `checks/` script result, and the runtime-proof evidence (paths under `.local/verify-gauge/<RUN>/`). Any gap is a failure and goes back as a gap, not a pass.

To choose which package skills a change needs, follow `.claude/skills/verify-weave-index/SKILL.md`.

## Launch

```bash
$H launch                      # or: $H launch --run my-run-id
export GAUGE_VERIFY_RUN=<RUN printed on the first line>
```

Launch prints `RUN=<id>` first, then builds with `npx tsc -b packages/gauge/tsconfig.json` (Gauge references only `../weft`, so this touches `packages/weft/dist` and `packages/gauge/dist` only; the log goes to `build.log` in the evidence dir), creates an **empty** scratch dir `$TMPDIR/gauge-verify/<RUN>/` and the evidence dir `.local/verify-gauge/<RUN>/`, writes `state.json` (scratch) and `run.json` (evidence) with the HEAD SHA, dirty flag and Node version, and ends with:

```
READY: packages/gauge built; run doctor next.
```

Ready means the built package is importable; Doctor proves it. Launch refuses an existing run id rather than reuse someone else's state. There is no database, no migration and no seed step: the fixtures are the seed data, read as committed. Teardown is `$H cleanup`; there is no long-lived process.

## Doctor

```bash
$H doctor        # read-only; exit 0 = worth driving, exit 1 = something is off
```

Prints JSON `{ run, ok, checks: [{ name, ok, detail }] }` and saves a copy as `doctor-<ms>.json` in the evidence dir. It checks: run state and evidence dir exist; Node satisfies `>=26` (and says whether it is v26.x, which the baseline requires you to record); HEAD still equals the SHA at launch; `dist/src/index.js` exists; `packages/gauge` and `packages/weft` `dist` are not older than their `src`/`test` (stale build); `@weave/gauge` resolves into **this** checkout's `packages/gauge`; `validate`, `evaluate`, `evaluateInfo`, `compare`, `track`, `costed`, `recordDigest` are functions; `records.json` parses with its four context maps (it prints the valid/invalid/results counts: 30/90/13 at the time of writing); the failure-attribution manifest has only `tune` roles. Run it first, and again whenever anything looks off. A stale-dist failure means someone edited after launch: start a new `launch`.

## Drive

```bash
$H drive <feature>    # record-contract | evaluate | compare-track | info-only | failure-attribution
$H test               # npm run test:gauge-contract AND npm run test:failure-attribution, transcripts into evidence
$H checks             # every checks/*.mjs plus node --test checks/test/*.test.mjs
```

Each `drive` prints one `PASS`/`FAIL <check>` line per check, then `PASS|FAIL <feature>: n/m checks; evidence .local/verify-gauge/<RUN>/<feature>/`, and exits 0 only if every check passed. Recipes, what each check means, and gotchas are in [`features/README.md`](features/README.md). Drive every feature the change touches; a change to `validate.ts` or `types.ts` reaches all of them, a change to `stats.ts` or `produce.ts` reaches `evaluate`, `compare-track` and `info-only`, and a change under `benchmarks/failure-attribution/` reaches `failure-attribution`.

`failure-attribution` re-executes itself under `--experimental-strip-types --disallow-code-generation-from-strings`, the flags `npm run test:failure-attribution` uses; `result.json` records `execArgv` so you can see it.

`$H test` runs both package scripts in sequence (each runs the **whole-repo** `npm run build` first, unlike launch) and writes `test-gauge-contract.log`, `test-failure-attribution.log` and `package-test.json` (exit code, summary lines, failing test names). `$H checks` lists `checks/` and runs each script plus the `checks/test` suite (step 3 of the baseline), one log per script; `checks/test/g7-lint.test.mjs` also runs `npm run build`.

## Evidence

Evidence lives in **`.local/verify-gauge/<RUN>/`** at the repo root. `.local/` is git-ignored, and cleanup never deletes it.

```
run.json                                SHA, dirty flag, Node, launch time
build.log                               launch build transcript and exit code
doctor-<ms>.json                        each doctor verdict
<feature>/result.json                   per-check { name, ok, expected, actual }, SHA, Node, execArgv, time
record-contract/verdicts.json           every records.json case: expected vs actual reason
record-contract/context-verdicts.json   context entries that do not self-validate (only decision-sites.edited@1, by design)
evaluate/result.record.json, empty.record.json        produced gauge.result@1 records as re-read from disk
compare-track/comparison.record.json, track.*.json     produced comparison and track steps
info-only/criteria.json, info-result.record.json      the governed criteria@2 set + revision, the gauge.result@2
failure-attribution/offline-controls.json, judgment-controls.json, always-unattributed.json, projected-input.c05.json
test-gauge-contract.log, test-failure-attribution.log, package-test.json
checks/<script>.log, checks/checks-test.log, checks/summary.json
cleanup.json                            what cleanup removed and the evidence file list it left
```

Proof standards for this package:

- Exercise the public entry point `@weave/gauge` (and the harness's exported functions), never `src/` internals or test-only helpers (`createTestReader` is test-only by contract).
- Capture the action and the resulting state: each check records expected and actual. Expected values come from the contract, hand arithmetic on the samples (108/120 = 0.9) or the verdicts the package's own tests pin, never from re-running the producer under test.
- Second view: every produced record is written to scratch, re-read from disk and re-validated; manifest pins are re-hashed independently with `sha256` over the stored bytes; fixtures are digested before and after to prove Gauge wrote nothing (it is pure).
- Prove fail-closed paths, not just happy ones: invalid fixtures rejected with their documented reason, a tampered verdict rejected (`verdict`), info-only results refused by every judging producer (`info_only`), the always-unattributed control failing 17 cases, the sealed reader refusing.
- No mocks: Gauge has no external boundary. No model, provider, network or credential is involved anywhere; if a change would need one, that is out of this skill's scope and must be stated, not faked.
- Never edit product code, tests or fixtures to make a drive pass. A failure is a finding; record it.

## Cleanup

```bash
$H cleanup
ls .local/verify-gauge/$GAUGE_VERIFY_RUN     # evidence must still be there
```

Cleanup deletes only `$TMPDIR/gauge-verify/<RUN>/` (state and scratch records) and refuses any other path. There are no processes to kill. It writes `cleanup.json` with what it removed and every evidence file it left, and exits non-zero if the scratch dir survived or the evidence dir is missing. Run it after every attempt, including failed ones.

## Isolation

Runs are isolated by run id: separate scratch and evidence dirs, in-process work only, no ports. Two runs can go side by side. The shared state is the checkout's `packages/{weft,gauge}/dist` (launch rebuilds them; `$H test` and `$H checks` rebuild every package's `dist`). Do not launch while another agent is mid-edit or mid-build in the same checkout; Doctor's stale-dist and HEAD checks catch an edit after launch.

## Helpers

- `bin/gauge-verify.mjs`: the only helper (executable; `node` shebang). Commands: `launch [--run ID]`, `doctor`, `drive <feature>`, `test`, `checks`, `cleanup`. The run comes from `--run ID` or `GAUGE_VERIFY_RUN`. Exit codes: 0 pass, 1 a check failed, 2 usage or missing-run error. It is verification scaffolding, not product code; adding a feature means one entry in its `drives` table and one file under `features/`.
- The root `npm run fmt:check` (first step of `npm run verify`) also formats `.claude/skills/`. After editing this skill, run `npx vp fmt .claude/skills/verify-gauge`.

## Upkeep

Keep `features/` honest as Gauge changes with `/pstack:maintain-verification-skill`. When the contract gains a schema, producer, rejection reason or fixture, add or extend a feature file and its drive in the same change. Not yet mapped: `costed` / `gauge.cost@1`, `gauge.preference@1`, governed revision chains (`gauge.revision@1` supersession and `approval_reused`); they are covered only by `record-contract`'s fixture sweep and the package tests.
