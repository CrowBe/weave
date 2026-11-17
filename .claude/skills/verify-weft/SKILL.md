---
name: verify-weft
description: Build and drive Weave Weft (`packages/weft`, `@weave/weft`, the tracing package that validates and stores `weft.record@1` traces and reads `weave.trace@1`) through its public library API and its own fixtures — validateRecord, createWeftSink, importTraceLines into SQLite, OTLP/JSON export and intake over a loopback listener — with a scripted Node helper that records per-check evidence. Use this to prove a change to packages/weft, WEFT-CONTRACT.md, or Weft's fixtures actually behaves, alongside the monorepo verify gate. Weft has no CLI and no UI; do not use this for Tapestry (use verify-tapestry) or for Loom, gateway or Fabric emission behaviour.
---

# Verify Weave Weft (`@weave/weft`)

Weft is the tracing package (`GLOSSARY.md` → Weft). It defines the `weft.record@1` contract and its fail-closed validator, a redacting sink for an emission port, the older `weave.trace@1` envelope and importer port, an optional SQLite inspection store, and optional OTLP/JSON export and intake. The contract is `packages/weft/src/WEFT-CONTRACT.md`. **Weft imports nothing in-repo** (`checks/import-direction.mjs` enforces this), and a Weft trace is a non-authoritative projection: no proof here may treat a stored record as authority for anything.

The surface a user (a composition root, another package, an operator inspecting a trace) touches is the **public library API**, exported as:

| Specifier            | File                        | Entry points                                                                                                                                                        |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@weave/weft`        | `dist/src/index.js`         | `validateRecord`, `serializeRecord`, `createWeftSink`, `validateTrace`, `serializeTrace`, `importTraceLines`, `is*` value guards, `KIND_FIELDS`, `FIELD_DISCLOSURE` |
| `@weave/weft/sqlite` | `dist/src/sqlite.js`        | `openTraceStore`                                                                                                                                                    |
| `@weave/weft/intake` | `dist/src/sqlite-intake.js` | `mapOtlp`, `intakeOtlp`, `createOtlpListener`                                                                                                                       |
| `@weave/weft/otel`   | `dist/src/otel.js`          | `exportOtlp`, `createOtlpExporter`                                                                                                                                  |

There is no bin, no server you keep running, and no UI. "Launch" means build the package once; each drive is a short-lived Node process that imports the built package the way a consumer does, uses the package's fixtures in `packages/weft/fixtures/` (`records.json`, `weave-trace-v1.jsonl`, `otel-all-kinds.json`, `otel-golden.json`), writes into a per-run scratch dir, and re-reads what it wrote from a second view (the file on disk, the SQLite file opened read-only outside Weft, the HTTP status line). Everything is offline: no provider, no credential, no network beyond a loopback port the drive opens and closes itself.

Everything goes through one dependency-free helper (Node built-ins plus `@weave/weft`):

```bash
H=.claude/skills/verify-weft/bin/weft-verify.mjs   # run from the repo root; it resolves paths from its own location
```

Requirements: Node >= 26 with `node:sqlite` (the helper's doctor checks it), `npm ci` already done so `node_modules/@weave/weft` links to `packages/weft`.

## Monorepo baseline (required before calling a change "done")

This skill proves Weft behaviour. It does not replace the monorepo gate. "Done" needs real proof: the behaviour exercised for real, not green tests alone. Before calling a change done or approving its PR, do all of this (it is the verify-weave workflow at `/home/box/agent-data/workflows/verify-weave/SKILL.md`):

1. Check out the exact head SHA under review in a **clean clone**. Use **Node 26** (`node -v` must print `v26.x`; switch with nvm/fnm if needed). The repo's engines are `>=26`, so a newer Node runs, but record the Node 26 requirement and the version you actually used. Run `npm ci`.
2. Run **`npm run verify` from the repo root FIRST**, before any package-specific proof, and record the result per package. (Weft's part of it is `npm test`, which includes `packages/weft/dist/test/*.test.js`.)
3. Run **every script under `checks/`**. List the directory first; don't assume names. Each must exit 0. `$H checks` does this and records each result (see Drive). The checks that cover Weft directly are:
   - `checks/import-direction.mjs`: Weft imports nothing in-repo; gauge may import only weft; weave tests may import weft, weave source never.
   - `checks/no-ambient-clock.mjs` and `checks/no-ambient-entropy.mjs`: both scan `packages/weft/src`.
   - `checks/no-ambient-env.mjs`: scans every `packages/<name>/src`, including Weft.
   - `checks/no-swallowed-failures.mjs`: scans every package's `package.json` scripts.
   - `checks/test/credential-parity.test.mjs` (run by `npm run test:checks`): Weft's `src/credential.ts` marker regex must equal the gateway's `src/privacy.ts`.
   - `checks/source-scan.mjs` is a shared module the scanners import, not a check; running it is a no-op that exits 0. `checks/gauge-attribution-contract.mjs` and `checks/extract-before-site.mjs` do not scan Weft but must still pass.
4. Package-specific runtime evidence: this skill's Launch → Doctor → Drive (every feature the change touches, from `features/`) → Evidence → Cleanup.
5. Confirm CI on the PR is green for the **same SHA**. A new commit voids this verification.
6. Report: SHA, Node version, `npm run verify` result, each `checks/` script result, and the runtime-proof evidence (paths under `.local/verify-weft/<RUN>/`). Any gap is a failure and goes back as a gap, not a pass.

To choose which package skills a change needs, follow `.claude/skills/verify-weave-index/SKILL.md`.

## Launch

```bash
$H launch                      # or: $H launch --run my-run-id
export WEFT_VERIFY_RUN=<RUN printed on the first line>
```

Launch prints `RUN=<id>` first, then builds Weft alone with `npx tsc -b packages/weft/tsconfig.json` (Weft has no tsconfig references, so this touches only `packages/weft/dist`; the log goes to `build.log` in the evidence dir), creates an **empty** scratch dir `$TMPDIR/weft-verify/<RUN>/` and the evidence dir `.local/verify-weft/<RUN>/`, writes `state.json` (scratch) and `run.json` (evidence) with the HEAD SHA, dirty flag and Node version, and ends with:

```
READY: packages/weft built; run doctor next.
```

Ready means the built package is importable; Doctor proves it. Launch refuses an existing run id (scratch or evidence dir already present) rather than reuse someone else's state. Every SQLite database and JSONL output a drive creates starts absent in that scratch dir, so each drive starts from an empty data dir; there are no migrations beyond the schema `openTraceStore` creates on first open.

Teardown is `$H cleanup` (see Cleanup). There is no long-lived process: the only listener (`otlp-intake`) is opened and closed inside its drive.

## Doctor

```bash
$H doctor        # read-only; exit 0 = worth driving, exit 1 = something is off
```

Prints JSON `{ run, ok, checks: [{ name, ok, detail }] }` and saves a copy as `doctor-<ms>.json` in the evidence dir. It checks: run state and evidence dir exist; Node satisfies `>=26` (and says whether it is v26.x, which the monorepo baseline requires you to record); HEAD still equals the SHA at launch (an edit plus commit since launch fails this); all four `dist/src` entry files exist; `dist` is not older than `src`/`test` (stale build); `@weave/weft` resolves into **this** checkout's `packages/weft`; every public and subpath export named above is a function; the four fixtures parse (it prints the `records.json` valid/invalid counts and the trace line count); `node:sqlite` loads. Run it first, and again whenever anything looks off. If `dist not older than src/test` fails, someone edited Weft after launch: re-run a new `launch`.

## Drive

```bash
$H drive <feature>    # record-contract | sink | trace-import | otel-roundtrip | otlp-intake
$H test               # npm run test:weft-contract, transcript into the evidence dir
$H checks             # every checks/*.mjs plus node --test checks/test/*.test.mjs
```

Each `drive` prints one `PASS`/`FAIL <check>` line per check, then a summary line `PASS|FAIL <feature>: n/m checks; evidence .local/verify-weft/<RUN>/<feature>/`, and exits 0 only if every check passed. Feature recipes, what each check means, and gotchas are in [`features/README.md`](features/README.md). Drive every feature the change touches; a change to `validate.ts` or `types.ts` reaches all of them.

`$H test` runs the package's own script, `npm run test:weft-contract` (= `npm run build && node --test "packages/weft/dist/test/*.test.js"`). Note this runs the **whole-repo** `npm run build` (`tsc -b`), unlike launch. It writes `package-test.json` with the Node version, exit code, summary lines and the names of any failing tests.

**Run `$H test` on Node 26, as CI does** (`.github/workflows/verify.yml` pins `node-version: 26`). `test/otel-isolation.test.ts` runs a nested `node --test` and asserts its TAP line `/# fail 0/`; it passes `--test-reporter=tap` so the line is the same on Node 22 and on Node >= 23 (whose default for piped output is the spec reporter). If that test fails on reporter format again, report it as a failure, not a pass. `$H checks` lists `checks/` and runs each script (step 3 of the baseline) and the `checks/test` suite, one log per script.

## Evidence

Evidence lives in **`.local/verify-weft/<RUN>/`** at the repo root. `.local/` is git-ignored, and cleanup never deletes it.

```
run.json                       SHA, dirty flag, Node, launch time
build.log                      launch build transcript and exit code
doctor-<ms>.json               each doctor verdict
<feature>/result.json          per-check { name, ok, expected, actual }, SHA, Node, time, fixture/output digests
record-contract/verdicts.json  every records.json case: expected vs actual verdict
sink/sink.jsonl                the bytes the sink wrote
trace-import/trace.db, sqlite-view.json      the SQLite file and a read-only row-count view of it
otel-roundtrip/*.records.jsonl, *.export.json    mapped records and re-exported OTLP per fixture
otlp-intake/intake.db, sqlite-view.json, http-transcript.json
package-test.log, package-test.json          npm run test:weft-contract transcript, exit, tests/pass/fail tail
checks/<script>.log, checks/checks-test.log, checks/summary.json
cleanup.json                   what cleanup removed and the evidence file list it left
```

Proof standards for this package:

- Exercise the public entry points by their package specifiers (`@weave/weft`, `/sqlite`, `/intake`, `/otel`), never `src/` internals or test-only helpers (`test/fixtures/otlp-validator.ts` is test-only).
- Capture the action and the resulting state: each check records expected and actual. A `{ ok: true }` alone is not proof; each feature also re-reads the side effect through a second view (the JSONL file on disk re-validated; the SQLite file opened read-only with `node:sqlite` and row-counted; the HTTP status per request plus the database afterwards; a TCP connect refused after the listener closes).
- Prove the fail-closed paths, not only the happy path: invalid fixtures rejected with their documented reason, credential canaries never written, rejected batches leaving the database unchanged.
- No mocks are needed: the only "external system" is a loopback HTTP client the drive itself opens, and Weft's own boundary (`createServer` injected by the caller) is the production seam.
- Never edit product code, tests or fixtures to make a drive pass. A failure is a finding; record it in the report.

## Cleanup

```bash
$H cleanup
ls .local/verify-weft/$WEFT_VERIFY_RUN     # evidence must still be there
```

Cleanup deletes only `$TMPDIR/weft-verify/<RUN>/` (state, scratch databases, sink output) and refuses any other path. There are no processes to kill: the only listener lives inside the `otlp-intake` drive, which closes it and proves the port refuses connections before exiting. Cleanup writes `cleanup.json` into the evidence dir with what it removed and every evidence file it left, and exits non-zero if the scratch dir survived or the evidence dir is missing. Run it after every attempt, including failed ones.

## Isolation

Runs are isolated by run id: separate scratch and evidence dirs, `:0` ephemeral loopback ports, and in-process work only. Two runs can go side by side. The shared state is the checkout's `packages/weft/dist` (launch rebuilds it; `$H test` rebuilds all packages' `dist`). Do not launch while another agent is mid-edit or mid-build in the same checkout; Doctor's stale-dist and HEAD checks catch an edit after launch.

## Helpers

- `bin/weft-verify.mjs`: the only helper (executable; `node` shebang). Commands: `launch [--run ID]`, `doctor`, `drive <feature>`, `test`, `checks`, `cleanup`. The run comes from `--run ID` or `WEFT_VERIFY_RUN`. Exit codes: 0 pass, 1 a check failed, 2 usage or missing-run error. It is verification scaffolding, not product code; adding a feature means adding one entry to its `drives` table and one file under `features/`.
- The root `npm run fmt:check` (the first step of `npm run verify`) also formats `.claude/skills/`. After editing this skill, run `npx vp fmt .claude/skills/verify-weft`.

## Upkeep

Keep `features/` honest as Weft changes with `/pstack:maintain-verification-skill`. When the contract gains a kind, export or fixture, add or extend a feature file and its drive in the same change.
